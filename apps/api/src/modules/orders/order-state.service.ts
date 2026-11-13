import { Injectable } from '@nestjs/common';
import { Prisma, type SoStatus as DbSoStatus } from '@prisma/client';
import {
  SO_TRANSITIONS,
  canCancelOrder,
  transition,
  type SoEvent,
  type SoStatus,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { ProblemException } from '../../common/problem';
import { DbService, type Tx } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import {
  DeliveryOrderService,
  ON_ACTIVE_TRIP_WHERE,
} from '../delivery-orders/delivery-order.service';
import { OrderIntakeService, SUPERSEDE_NOTE, decisionNote } from './order-intake.service';
import { orderEventView } from './order-view';

export interface CancelOrderInput {
  /** เหตุผล ≥ 10 ตัวอักษร (ORD-034 / MD-222) */
  reason: string;
  /** reason code หมวด CANCEL (ไม่บังคับ — ST2-T12) */
  reasonCodeId?: string | null;
  /** If-Match */
  expectedVersion?: number;
}

const ENTITY = 'sales_order';
/** DO ที่ออกรถแล้วแต่ยังไม่จบการส่ง */
const MOVING = new Set(['DISPATCHED', 'PICKED_UP']);

/**
 * สถานะ SO ตาม DO (ST3-T11; docs/01 §4.1) — **ทางเดียว** นอกทางเข้า (OrderIntakeService) ที่เปลี่ยนสถานะ sales_order
 * (test `order-intake` call path อนุญาตไฟล์นี้) · ผู้เรียกต้องถือล็อก SO แล้ว (ลำดับ SO → DO → trip)
 *
 * - RECEIVED/ON_HOLD + มี DO อยู่ในเที่ยวที่ยังใช้ → `plan` → PLANNED (เคลียร์เหตุค้าง — §4.1 "ON_HOLD → PLANNED คนจัดรถให้โดยตรง")
 * - PLANNED + มี DO ออกรถแล้ว → `dispatch` → IN_TRANSIT ("trip ของ DO แรก DISPATCHED")
 * - PLANNED + ไม่มี DO ในเที่ยวแล้ว (ถอด/ยกเลิกเที่ยว) → `unplan` → RECEIVED แล้วประเมินใบค้างใหม่ (`reevaluate` — เช่น RATE_MISSING กลับมา)
 * - IN_TRANSIT + ไม่มี DO ที่ออกรถแล้ว (ยกเลิกเที่ยวที่ปล่อยแล้วก่อนรับของ) → `recall` → PLANNED (→ `unplan` ถ้าไม่มี DO ในเที่ยว)
 * - ส่งแล้ว/ส่งบางส่วน (ST4) — ยังไม่แตะ
 */
@Injectable()
export class OrderStateService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly intake: OrderIntakeService,
    private readonly deliveryOrders: DeliveryOrderService,
    private readonly audit: AuditService,
  ) {}

  /**
   * ยกเลิก SO (ST3-T10; docs/04 C "ยกเลิก / คืนสถานะ พร้อม reason; order ที่มี trip แล้วต้องถอดจาก trip ก่อน",
   * docs/01 §4.1 DRAFT/RECEIVED/ON_HOLD/PLANNED → CANCELLED, ORD-034/036)
   * - เหตุผล ≥ 10 ตัวอักษร + reason code หมวด CANCEL (ไม่บังคับ) → ประวัติสถานะ + `order.cancelled` + audit
   * - DO ในเที่ยว → 409 `order_on_trip` (ไม่ถอดให้เอง — ถอดที่เที่ยว ST3-T11 ก่อน) · DO DRAFT ทั้งหมด → CANCELLED ตามไป
   * - ชุดการเปลี่ยนแปลงจากต้นทางที่รอตัดสิน → ปิด (SUPERSEDED) · สถานะสิ้นสุด (ไม่มีทางกลับ — docs/01 §4.1)
   */
  async cancel(id: string, input: CancelOrderInput, tx: Tx = this.db.tx) {
    const note = decisionNote(input.reason);
    const reasonCodeId = input.reasonCodeId ?? null;
    if (reasonCodeId) {
      const rc = await tx.reasonCode.count({
        where: { id: reasonCodeId, category: 'CANCEL', status: 'ACTIVE', deletedAt: null },
      });
      if (!rc)
        throw new ProblemException('validation_failed', undefined, [
          { field: 'reasonCodeId', code: 'invalid_reference', message: 'reason code not found' },
        ]);
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM sales_order WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw new ProblemException('not_found');
    const so = await tx.salesOrder.findUniqueOrThrow({
      where: { id },
      include: { stops: true, holdReasonCode: { select: { code: true } } },
    });
    if (input.expectedVersion !== undefined && so.version !== input.expectedVersion)
      throw new ProblemException('precondition_failed');
    const from = so.status as SoStatus;
    if (!canCancelOrder(from))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        from,
        event: 'cancel',
      });
    // ลำดับล็อก SO → DO (ตรงกับ upsertOrder/TripService)
    const cancelledDos = await this.deliveryOrders.cancelForOrder(tx, id, { note, reasonCodeId });
    const hadSourceChange = await this.intake.closePending(tx, id, SUPERSEDE_NOTE.cancelled, false);
    await this.state.transition<SoStatus, SoEvent>(tx, {
      docType: ENTITY,
      docId: id,
      table: SO_TRANSITIONS,
      from,
      event: 'cancel',
      reasonCodeId,
      note,
      eventType: 'order.cancelled',
      apply: async (next) => {
        const r = await tx.salesOrder.updateMany({
          where: { id, status: from as DbSoStatus },
          data: {
            status: next as DbSoStatus,
            holdReasonCodeId: null,
            holdNote: null,
            sourceChangedAfterPlan: false,
            sourceDiff: Prisma.DbNull,
            version: { increment: 1 },
          },
        });
        if (r.count === 0) throw new ProblemException('concurrent_update');
        return orderEventView(await tx.salesOrder.findUniqueOrThrow({ where: { id } }));
      },
    });
    await this.audit.record({
      action: `${ENTITY}.cancelled`,
      entityType: ENTITY,
      entityId: id,
      before: { status: from, holdReason: so.holdReasonCode?.code ?? null },
      after: {
        status: 'CANCELLED',
        reasonCodeId,
        deliveryOrdersCancelled: cancelledDos,
        ...(hadSourceChange ? { sourceChangeClosed: true } : {}),
      },
      reason: note,
    });
    return { id, cancelledDeliveryOrders: cancelledDos };
  }

  async syncFromDeliveryOrders(tx: Tx, salesOrderIds: string[]): Promise<void> {
    for (const id of [...new Set(salesOrderIds)].sort()) await this.syncOne(tx, id);
  }

  private async syncOne(tx: Tx, id: string): Promise<void> {
    const so = await tx.salesOrder.findUnique({ where: { id }, select: { status: true } });
    if (!so) return;
    const onTrip =
      (await tx.deliveryOrder.count({ where: { salesOrderId: id, ...ON_ACTIVE_TRIP_WHERE } })) > 0;
    const moving =
      (await tx.deliveryOrder.count({
        where: { salesOrderId: id, status: { in: [...MOVING] as never[] } },
      })) > 0;
    let status = so.status as SoStatus;
    const events: SoEvent[] = [];
    const step = (e: SoEvent) => {
      events.push(e);
      status = transition(ENTITY, SO_TRANSITIONS, status, e);
    };
    if ((status === 'RECEIVED' || status === 'ON_HOLD') && onTrip) step('plan');
    if (status === 'IN_TRANSIT' && !moving) step('recall');
    if (status === 'PLANNED' && moving) step('dispatch');
    else if (status === 'PLANNED' && !onTrip) step('unplan');
    let from = so.status as SoStatus;
    for (const event of events) {
      await this.state.transition<SoStatus, SoEvent>(tx, {
        docType: ENTITY,
        docId: id,
        table: SO_TRANSITIONS,
        from,
        event,
        eventType: 'order.updated',
        apply: async (next) => {
          const r = await tx.salesOrder.updateMany({
            where: { id, status: from as DbSoStatus },
            data: {
              status: next as DbSoStatus,
              ...(event === 'plan' ? { holdReasonCodeId: null, holdNote: null } : {}),
              version: { increment: 1 },
            },
          });
          if (r.count === 0) throw new ProblemException('concurrent_update');
          const after = await tx.salesOrder.findUniqueOrThrow({
            where: { id },
            select: { id: true, soNo: true, status: true, customerId: true },
          });
          return { ...after };
        },
      });
      from = transition(ENTITY, SO_TRANSITIONS, from, event);
    }
    // กลับเข้ากองงานค้างจัด → ประเมินราคา/ใบค้างใหม่ด้วยกฎทางเข้าชุดเดียว (ไม่แต่งกฎเอง)
    if (events.at(-1) === 'unplan') await this.intake.reevaluate(id, tx);
  }
}
