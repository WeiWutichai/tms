import { Injectable } from '@nestjs/common';
import { Prisma, type SoStatus as DbSoStatus } from '@prisma/client';
import {
  DO_DELIVERED_STATUSES,
  DO_MOVING_STATUSES,
  DO_UNDELIVERED_STATUSES,
  SO_TRANSITIONS,
  canCancelOrder,
  orderDeliveryEvent,
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

/**
 * สถานะ SO ตาม DO (ST3-T11; docs/01 §4.1) — **ทางเดียว** นอกทางเข้า (OrderIntakeService) ที่เปลี่ยนสถานะ sales_order
 * (test `order-intake` call path อนุญาตไฟล์นี้) · ผู้เรียกต้องถือล็อก SO แล้ว (ลำดับ SO → DO → trip)
 *
 * - RECEIVED/ON_HOLD + มี DO อยู่ในเที่ยวที่ยังใช้ → `plan` → PLANNED (เคลียร์เหตุค้าง — §4.1 "ON_HOLD → PLANNED คนจัดรถให้โดยตรง")
 * - PLANNED + มี DO ออกรถแล้ว → `dispatch` → IN_TRANSIT ("trip ของ DO แรก DISPATCHED")
 * - PLANNED + ไม่มี DO ในเที่ยวแล้ว (ถอด/ยกเลิกเที่ยว) → `unplan` → RECEIVED แล้วประเมินใบค้างใหม่ (`reevaluate` — เช่น RATE_MISSING กลับมา)
 * - IN_TRANSIT + ไม่มี DO ที่ออกรถแล้ว และไม่มี DO ที่ส่งถึง/ส่งไม่สำเร็จ (ยกเลิกเที่ยวที่ปล่อยแล้วก่อนรับของ) → `recall` → PLANNED
 *   (→ `unplan` ถ้าไม่มี DO ในเที่ยว)
 * - ST4-T03 ความคืบหน้าการส่ง (domain `orderDeliveryEvent`): ส่งครบทุกบรรทัด → DELIVERED · ส่งบางส่วนและไม่มี DO วิ่ง →
 *   PARTIALLY_DELIVERED · DO ที่เหลือออกรถ → IN_TRANSIT (`resume`) · DO ส่งไม่สำเร็จทั้งหมด → คง IN_TRANSIT (ส่งใหม่/คืนคลัง ST4-T11)
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

  /**
   * รถร่วมปฏิเสธข้อเสนองาน (ST3-T23; docs/01 §4.1 "PLANNED → ON_HOLD : รถร่วมปฏิเสธ" + reason code `CARRIER_REJECTED`)
   * SO ที่ PLANNED/RECEIVED → `hold` ด้วยรหัสระบบ CARRIER_REJECTED (+ หมายเหตุเหตุผล) · ค้างด้วยเหตุอื่นอยู่แล้ว/ออกรถแล้ว = ไม่แตะ
   * เคลียร์: จัดรถ/เสนองานใหม่ที่เที่ยวเดิม (`syncFromDeliveryOrders` → `plan` ล้างเหตุค้าง — ST3-T07 "เคลียร์ได้เมื่อจัดรถใหม่")
   * ผู้เรียกถือล็อก SO แล้ว (ลำดับ SO → DO → trip)
   */
  async holdCarrierRejected(tx: Tx, salesOrderIds: string[], note: string): Promise<string[]> {
    return this.holdSystem(tx, salesOrderIds, 'CARRIER_REJECTED', note);
  }

  /**
   * นัดส่งใหม่อัตโนมัติเกินจำนวนครั้ง (ST4-T12; docs/04 E2 "นับครั้ง → RESCHEDULES_EXHAUSTED") — SO ที่ PLANNED/RECEIVED
   * (หลัง DO ส่งใหม่ลงกล่องรอจัด) → ค้าง `RESCHEDULES_EXHAUSTED` · ค้างด้วยเหตุอื่นอยู่แล้ว/ยังมี DO วิ่งอยู่ = ไม่แตะ
   * เคลียร์เมื่อจัดรถใหม่ที่กระดาน (`plan` ล้างเหตุค้าง — ST3-T07) · ผู้เรียกถือล็อก SO แล้ว
   */
  async holdReschedulesExhausted(tx: Tx, salesOrderIds: string[], note: string): Promise<string[]> {
    return this.holdSystem(tx, salesOrderIds, 'RESCHEDULES_EXHAUSTED', note);
  }

  private async holdSystem(
    tx: Tx,
    salesOrderIds: string[],
    code: 'CARRIER_REJECTED' | 'RESCHEDULES_EXHAUSTED',
    note: string,
  ): Promise<string[]> {
    const ids = [...new Set(salesOrderIds)].sort();
    if (!ids.length) return [];
    const rc = await tx.reasonCode.findFirst({
      where: { category: 'ORDER_HOLD', code, deletedAt: null },
      select: { id: true },
    });
    // รหัสระบบ (is_system) bootstrap สร้างให้ทุก tenant — ไม่พบ = ข้อมูลตั้งต้นของ tenant เสีย
    if (!rc) throw new Error(`ORDER_HOLD reason code ${code} missing — run tenants:bootstrap`);
    const held: string[] = [];
    for (const id of ids) {
      const so = await tx.salesOrder.findUnique({
        where: { id },
        select: { status: true, holdReasonCode: { select: { code: true } } },
      });
      // ST4-T12 (review M1): ค้างด้วยเหตุอื่นอยู่แล้ว (RATE_MISSING / ไม่พร้อม ฯลฯ) → คงเหตุหลักเดิม
      // RESCHEDULES_EXHAUSTED เป็นเหตุรอง (holdCodes จาก DO `reschedule_exhausted`) + audit ให้เห็น
      if (so?.status === 'ON_HOLD' && code === 'RESCHEDULES_EXHAUSTED') {
        await this.audit.record({
          action: `${ENTITY}.hold_code_added`,
          entityType: ENTITY,
          entityId: id,
          before: { holdReason: so.holdReasonCode?.code ?? null },
          after: { holdReason: so.holdReasonCode?.code ?? null, added: code },
          reason: note,
        });
        held.push(id);
        continue;
      }
      if (!so || (so.status !== 'PLANNED' && so.status !== 'RECEIVED')) continue;
      const from = so.status as SoStatus;
      await this.state.transition<SoStatus, SoEvent>(tx, {
        docType: ENTITY,
        docId: id,
        table: SO_TRANSITIONS,
        from,
        event: 'hold',
        reasonCodeId: rc.id,
        note,
        eventType: 'order.updated',
        apply: async (next) => {
          const r = await tx.salesOrder.updateMany({
            where: { id, status: from as DbSoStatus },
            data: {
              status: next as DbSoStatus,
              holdReasonCodeId: rc.id,
              holdNote: note,
              version: { increment: 1 },
            },
          });
          if (r.count === 0) throw new ProblemException('concurrent_update');
          return orderEventView(await tx.salesOrder.findUniqueOrThrow({ where: { id } }));
        },
      });
      held.push(id);
    }
    return held;
  }

  /** `notes` = หมายเหตุในประวัติสถานะต่อ SO (ST4-T12: ถอยกลับรอจัดเพราะนัดส่งใหม่ — ไม่ใช่การถอนรถธรรมดา) */
  async syncFromDeliveryOrders(
    tx: Tx,
    salesOrderIds: string[],
    notes: ReadonlyMap<string, string> = new Map(),
  ): Promise<void> {
    for (const id of [...new Set(salesOrderIds)].sort())
      await this.syncOne(tx, id, notes.get(id) ?? null);
  }

  private async syncOne(tx: Tx, id: string, note: string | null = null): Promise<void> {
    const so = await tx.salesOrder.findUnique({
      where: { id },
      select: { status: true, holdReasonCode: { select: { code: true } } },
    });
    if (!so) return;
    const onTrip =
      (await tx.deliveryOrder.count({ where: { salesOrderId: id, ...ON_ACTIVE_TRIP_WHERE } })) > 0;
    const dos = await tx.deliveryOrder.findMany({
      where: { salesOrderId: id, status: { not: 'CANCELLED' } },
      select: { status: true },
    });
    const has = (set: readonly string[]) => dos.some((d) => set.includes(d.status));
    const moving = has(DO_MOVING_STATUSES);
    const anyDelivered = has(DO_DELIVERED_STATUSES);
    const finished = anyDelivered || has(DO_UNDELIVERED_STATUSES);
    let status = so.status as SoStatus;
    const events: SoEvent[] = [];
    const step = (e: SoEvent) => {
      events.push(e);
      status = transition(ENTITY, SO_TRANSITIONS, status, e);
    };
    // ST3-T23 (review M1): ค้าง CARRIER_REJECTED คงอยู่ตราบที่ DO ของ SO ยังอยู่ในเที่ยวที่รถร่วมปฏิเสธและยังไม่จ้าง/จัดรถใหม่
    // (PLANNING + assignment_status REJECTED) — การกระทำกับเที่ยวอื่นของ SO เดียวกันไม่ล้างเหตุค้าง
    // เคลียร์เมื่อเที่ยวนั้นถูกเสนองานใหม่/จัดรถ (assignment_status เปลี่ยน) หรือ DO ถูกจัดลงเที่ยวอื่นหลังถอด/ยกเลิกเที่ยว (ST3-T07)
    const rejectedPending =
      status === 'ON_HOLD' &&
      so.holdReasonCode?.code === 'CARRIER_REJECTED' &&
      (await tx.deliveryOrder.count({
        where: {
          salesOrderId: id,
          status: { not: 'CANCELLED' },
          trip: { is: { status: 'PLANNING', assignmentStatus: 'REJECTED' } },
        },
      })) > 0;
    if ((status === 'RECEIVED' || status === 'ON_HOLD') && onTrip && !rejectedPending) step('plan');
    if (status === 'IN_TRANSIT' && !moving && !finished) step('recall');
    // ST4-T12: ใบที่คืนจาก redeliver (ส่งไม่สำเร็จถูกพลิก) อาจส่งถึงแล้วขณะ SO ยัง PLANNED → ผ่าน IN_TRANSIT แล้วไล่การส่ง
    if (status === 'PLANNED' && (moving || (onTrip && finished))) step('dispatch');
    else if (status === 'PLANNED' && !onTrip) step('unplan');
    // ST4-T11: SO ส่งครบแล้วมี DO ส่งซ้ำของที่ถูกปฏิเสธรับ (ยังไม่ส่ง) → reopen → ส่งบางส่วน แล้วไล่ต่อ (ออกรถ → resume)
    const pending = moving || has(['DRAFT', 'PLANNED']);
    if (status === 'DELIVERED') {
      const ev = orderDeliveryEvent(status, {
        anyDelivered,
        allDelivered: !pending,
        moving,
        pending,
      });
      if (ev) step(ev);
    }
    if (status === 'IN_TRANSIT' || status === 'PARTIALLY_DELIVERED') {
      const allDelivered =
        anyDelivered &&
        dos.every((d) => (DO_DELIVERED_STATUSES as readonly string[]).includes(d.status)) &&
        (await this.deliveryOrders.allocation(id, tx)).every((l) => Number(l.remaining) <= 0);
      const ev = orderDeliveryEvent(status, { anyDelivered, allDelivered, moving, pending });
      if (ev) step(ev);
    }
    let from = so.status as SoStatus;
    for (const event of events) {
      await this.state.transition<SoStatus, SoEvent>(tx, {
        docType: ENTITY,
        docId: id,
        table: SO_TRANSITIONS,
        from,
        event,
        note: event === 'recall' || event === 'unplan' || event === 'reopen' ? note : null,
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
