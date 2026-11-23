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
import { RevenueLinesService } from '../revenue-lines/revenue-lines.service';
import { DbService, type Tx } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import {
  DeliveryOrderService,
  ON_ACTIVE_TRIP_WHERE,
} from '../delivery-orders/delivery-order.service';
import { OrderIntakeService, SUPERSEDE_NOTE, decisionNote } from './order-intake.service';
import { loadOrderEventObject, previousOf } from './order-dto';
import { lockKey } from '../master/master-kit';
import { NotificationEvents } from '../notifications/notification-events';
import { requestContext } from '../../common/request-context';

/** previousAttributes = ค่าเดิมเทียบ data.object (รูป REST) ก่อนเปลี่ยน — ST7-T06 */
const prevFrom = (before: Record<string, unknown>) => (snap: Record<string, unknown>) =>
  previousOf(before, snap);

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
 * - ST4-T03 ความคืบหน้าการส่ง (domain `orderDeliveryEvent`): ส่งครบทุกบรรทัด → DELIVERED · ส่งบางส่วน (แม้ DO อื่นยังวิ่ง — D68-35) →
 *   PARTIALLY_DELIVERED · DO ที่เหลือออกรถหลังการส่งถึง → IN_TRANSIT (`resume`) · DO ส่งไม่สำเร็จทั้งหมด → คง IN_TRANSIT (ส่งใหม่/คืนคลัง ST4-T11)
 */
@Injectable()
export class OrderStateService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly intake: OrderIntakeService,
    private readonly deliveryOrders: DeliveryOrderService,
    private readonly audit: AuditService,
    private readonly revenueLines: RevenueLinesService,
    private readonly events: NotificationEvents,
  ) {}

  /**
   * ST8-T05 ต้นทาง (ERP connector) แจ้งว่ายกเลิกใบสั่ง (docs/01 A.4 "SO ที่ถูกยกเลิกใน KRS → ยกเลิกถ้ายังไม่มี DO; มี DO แล้ว → แจ้งเตือนแทน";
   * docs/04 C ยกเลิก / คืนสถานะ) — ไม่ผูก ERP ใด · ผู้เรียก (ConnectorIntakeService) ถือ transaction + ผู้กระทำ `connector:{key}`
   * - ยังไม่มีใบใน TMS → `skipped` (ไม่สร้างงานที่ต้นทางยกเลิกแล้ว — ต้นทางกลับมาส่งใบปกติ = สร้างตามปกติ)
   * - ใบเป็นของช่องทางอื่น (externalId ชน) → `conflict` · ยกเลิกแล้ว → `unchanged`
   * - **ยังไม่มี DO** (ไม่มี DO ที่เข้าเที่ยว/พ้น DRAFT — DO DRAFT ที่ระบบสร้างรอจัดถูกยกเลิกตาม) และสถานะยกเลิกได้
   *   → `cancel` ทางเดียวกับคน (เหตุผลระบบ + ประวัติ + audit) + ตั้ง
   *   `source_cancelled_at` → `cancelled`
   * - **มี DO แล้ว** หรือพ้นช่วงยกเลิก (ออกรถ/ส่งแล้ว) → ไม่ยกเลิก · ตั้ง `source_cancelled_at` + audit `sales_order.source_cancel_alert`
   *   + แจ้งเตือนผู้ดูแลใบสั่ง/ผู้จัดรถ **ครั้งเดียว** (ดึงซ้ำ = `unchanged`) → `cancel_alert`
   */
  async cancelFromSource(
    tx: Tx,
    input: { externalId: string; connector: string },
  ): Promise<{
    outcome: 'cancelled' | 'cancel_alert' | 'unchanged' | 'skipped' | 'conflict';
    orderId?: string;
    soNo?: string | null;
    status?: string;
  }> {
    const ctx = requestContext.require();
    const source = `ERP:${input.connector}`;
    await lockKey(tx, `${ENTITY}.ext:${input.externalId}`);
    const hit = await tx.salesOrder.findUnique({
      where: { tenantId_externalId: { tenantId: ctx.tenantId!, externalId: input.externalId } },
      select: { id: true },
    });
    if (!hit) return { outcome: 'skipped' };
    await tx.$queryRaw`SELECT id FROM sales_order WHERE id = ${hit.id}::uuid FOR UPDATE`;
    const so = await tx.salesOrder.findUniqueOrThrow({
      where: { id: hit.id },
      select: {
        id: true,
        soNo: true,
        status: true,
        source: true,
        sourceConnector: true,
        sourceCancelledAt: true,
      },
    });
    const out = (
      outcome: 'cancelled' | 'cancel_alert' | 'unchanged' | 'conflict',
      status: string,
    ) => ({
      outcome,
      orderId: so.id,
      soNo: so.soNo,
      status,
    });
    if (so.source !== 'CONNECTOR' || so.sourceConnector !== input.connector)
      return out('conflict', so.status);
    if (so.status === 'CANCELLED') return out('unchanged', so.status);
    // "มี DO แล้ว" = DO ที่ระบบสร้างรอจัด (DRAFT นอกเที่ยว) ไม่นับ — ใบที่เข้าเที่ยว/พ้น DRAFT แล้ว (กติกาเดียวกับ cancelForOrder)
    const dos =
      (await tx.deliveryOrder.count({
        where: { salesOrderId: so.id, status: { notIn: ['DRAFT', 'CANCELLED', 'RETURNED'] } },
      })) + ((await this.deliveryOrders.hasDoOnTrip(tx, so.id)) ? 1 : 0);
    if (!dos && canCancelOrder(so.status as SoStatus)) {
      await tx.salesOrder.update({
        where: { id: so.id },
        data: { sourceCancelledAt: new Date() },
      });
      await this.cancel(
        so.id,
        { reason: `ต้นทาง ${source} ยกเลิกใบสั่งนี้แล้ว — ยกเลิกอัตโนมัติ` },
        tx,
      );
      return out('cancelled', 'CANCELLED');
    }
    if (so.sourceCancelledAt) return out('unchanged', so.status);
    await tx.salesOrder.update({
      where: { id: so.id },
      data: { sourceCancelledAt: new Date(), version: { increment: 1 } },
    });
    await this.audit.record({
      action: `${ENTITY}.source_cancel_alert`,
      entityType: ENTITY,
      entityId: so.id,
      before: { status: so.status },
      after: { status: so.status, source },
      reason: `ต้นทาง ${source} ยกเลิกใบสั่งนี้ แต่มีใบส่งของ (DO) แล้ว — ไม่ยกเลิกอัตโนมัติ`,
    });
    await this.events.orderSourceCancelled(tx, {
      tenantId: ctx.tenantId!,
      orderId: so.id,
      source,
    });
    return out('cancel_alert', so.status);
  }

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
      previousAttributes: prevFrom(await loadOrderEventObject(tx, id)),
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
        return loadOrderEventObject(tx, id);
      },
    });
    // บรรทัดรายได้ที่ยังไม่ออกใบ → VOIDED (ST5-T01 — ไม่ลบ)
    const revenueLinesVoided = await this.revenueLines.voidForCancelledOrder(id, note, tx);
    await this.audit.record({
      action: `${ENTITY}.cancelled`,
      entityType: ENTITY,
      entityId: id,
      before: { status: from, holdReason: so.holdReasonCode?.code ?? null },
      after: {
        status: 'CANCELLED',
        reasonCodeId,
        deliveryOrdersCancelled: cancelledDos,
        ...(revenueLinesVoided ? { revenueLinesVoided } : {}),
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
    code: 'CARRIER_REJECTED' | 'RESCHEDULES_EXHAUSTED' | 'ALL_RETURNED',
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
        // ST7-T06: พักใบ = `order.held` (docs/01 §5.3) — เดิมยิง order.updated
        eventType: 'order.held',
        previousAttributes: prevFrom(await loadOrderEventObject(tx, id)),
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
          return loadOrderEventObject(tx, id);
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

  /**
   * D-81 · D68-35 "DO ที่เหลือออกรถ" (docs/01 §4.1 PARTIALLY_DELIVERED → IN_TRANSIT): DO ที่วิ่งอยู่ออกรถ (dispatch/restore)
   * หลังการส่งถึง (deliver) ครั้งล่าสุดของ DO ใน SO — อ่านจาก doc_status_history (เวลาเท่ากัน = ไม่นับว่าออกหลัง)
   *
   * ข้อจำกัด (ยอมรับได้ก่อน pilot — D-76): ลำดับใช้ `doc_status_history.at` = เวลาเริ่ม transaction (`now()`) ไม่ใช่เวลาเกิดเหตุ —
   * event ที่เกิดพร้อมกัน/ซิงก์มาทีหลัง (offline) อาจทำให้ SO คง PARTIALLY_DELIVERED ทั้งที่ DO ที่เหลือออกรถหลังการส่งถึงจริง ·
   * DO ที่ส่งถึงแล้วแต่ไม่มีประวัติ `deliver` (ข้อมูลเก่า/ทางอื่น) ไม่มีเวลาส่งถึงให้เทียบ → DO ที่วิ่งอยู่นับเป็น "ออกหลัง" (resume)
   */
  private async movedAfterDelivery(
    tx: Tx,
    dos: { id: string; status: string }[],
  ): Promise<boolean> {
    const ids = (set: readonly string[]) =>
      dos.filter((d) => set.includes(d.status)).map((d) => d.id);
    const last = async (docIds: string[], events: string[]) =>
      (
        await tx.docStatusHistory.aggregate({
          where: { docType: 'delivery_order', docId: { in: docIds }, event: { in: events } },
          _max: { at: true },
        })
      )._max.at;
    const delivered = await last(ids(DO_DELIVERED_STATUSES), ['deliver']);
    const moved = await last(ids(DO_MOVING_STATUSES), ['dispatch', 'restore']);
    if (!moved) return false;
    return !delivered || moved > delivered;
  }

  private async syncOne(tx: Tx, id: string, note: string | null = null): Promise<void> {
    const so = await tx.salesOrder.findUnique({
      where: { id },
      select: { status: true, holdReasonCode: { select: { code: true } } },
    });
    if (!so) return;
    // ST4-T11: ใบส่งซ้ำของที่ถูกปฏิเสธรับ (rejected_from) ไม่นับในความคืบหน้าของ SO — SO ที่ส่งครบแล้วคงสถานะ (ไม่ถอยหลัง)
    const onTrip =
      (await tx.deliveryOrder.count({
        where: { salesOrderId: id, rejectedFromId: null, ...ON_ACTIVE_TRIP_WHERE },
      })) > 0;
    const dos = await tx.deliveryOrder.findMany({
      where: { salesOrderId: id, status: { not: 'CANCELLED' }, rejectedFromId: null },
      select: { id: true, status: true },
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
    // ST4-T11 [DECISION spec/12 §3]: ทุกใบคืนคลัง (RETURNED) → ถอยกลับรอจัด แล้วค้าง ALL_RETURNED (ท้ายฟังก์ชัน)
    const allReturned = dos.length > 0 && dos.every((d) => d.status === 'RETURNED');
    if ((status === 'RECEIVED' || status === 'ON_HOLD') && onTrip && !rejectedPending) step('plan');
    // ST5-T06 [DECISION spec/12 §3]: ผู้จัดรถย้อนผลส่งถึงของ DO (FAILED) ในใบสั่งที่ส่งครบแล้ว → กำลังขนส่ง แล้วไล่ต่อด้วยกฎเดิม
    // (เหมือนส่งไม่สำเร็จตั้งแต่แรก: ใบอื่นส่งแล้ว → ส่งบางส่วน · คืนคลังทั้งหมด → recall + ค้าง ALL_RETURNED)
    if (status === 'DELIVERED' && has(['FAILED'])) step('reopen');
    if (status === 'IN_TRANSIT' && !moving && (!finished || allReturned)) step('recall');
    // ST4-T12: ใบที่คืนจาก redeliver (ส่งไม่สำเร็จถูกพลิก) อาจส่งถึงแล้วขณะ SO ยัง PLANNED → ผ่าน IN_TRANSIT แล้วไล่การส่ง
    if (status === 'PLANNED' && (moving || (onTrip && finished))) step('dispatch');
    // ทุกใบคืนคลัง: ค้างจาก PLANNED เลย (ไม่ถอยไปรับงานใหม่ — ประเมินราคา/ใบค้างทางเข้าเมื่อจัดรถใหม่)
    else if (status === 'PLANNED' && !onTrip && !allReturned) step('unplan');
    if (status === 'IN_TRANSIT' || status === 'PARTIALLY_DELIVERED') {
      // ST4-T11 (review High): ใบคืนคลัง (RETURNED) นับว่าจบ — มีใบส่งถึงอย่างน้อย 1 ใบ → SO ส่งครบ (คืนคลังนับจัดสรรแล้ว)
      const allDelivered =
        anyDelivered &&
        dos.every(
          (d) =>
            (DO_DELIVERED_STATUSES as readonly string[]).includes(d.status) ||
            d.status === 'RETURNED',
        ) &&
        (await this.deliveryOrders.allocation(id, tx, true)).every((l) => Number(l.remaining) <= 0);
      const movedAfterDelivery =
        moving && anyDelivered ? await this.movedAfterDelivery(tx, dos) : moving;
      const ev = orderDeliveryEvent(status, {
        anyDelivered,
        allDelivered,
        moving,
        movedAfterDelivery,
      });
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
        note: event === 'recall' || event === 'unplan' ? note : null,
        // ST7-T06: จัดรถใบที่ค้างอยู่ = เหตุค้างถูกล้าง → `order.released` (docs/01 §5.3) · อื่น ๆ = order.updated
        eventType: from === 'ON_HOLD' ? 'order.released' : 'order.updated',
        previousAttributes: prevFrom(await loadOrderEventObject(tx, id)),
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
          // ST7-T06: payload สาธารณะชุดเดียวกับ order.* อื่น (เดิม uuid ดิบ 4 ช่อง)
          return loadOrderEventObject(tx, id);
        },
      });
      from = transition(ENTITY, SO_TRANSITIONS, from, event);
    }
    // กลับเข้ากองงานค้างจัด → ประเมินราคา/ใบค้างใหม่ด้วยกฎทางเข้าชุดเดียว (ไม่แต่งกฎเอง)
    if (events.at(-1) === 'unplan') await this.intake.reevaluate(id, tx);
    // ST4-T11 [DECISION spec/12 §3]: ทุกใบคืนคลัง → ใบค้าง ALL_RETURNED (ผู้จัดรถยกเลิกใบสั่ง + เหตุผล หรือสร้าง/จัดรถใหม่)
    // ค้างด้วยเหตุทางเข้าอยู่แล้ว (เช่น RATE_MISSING) = คงเหตุเดิม · [OPEN — PO] สถานะสุดท้ายของ SO ที่คืนทั้งหมด
    if (allReturned)
      await this.holdSystem(
        tx,
        [id],
        'ALL_RETURNED',
        note ?? 'ใบส่งของทุกใบคืนคลัง — ยกเลิกใบสั่งหรือสร้าง/จัดรถใหม่ (ST4-T11)',
      );
  }
}
