import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Trip, TripStop, TripStatus as DbTripStatus } from '@prisma/client';
import {
  STOP_TERMINAL_STATUSES,
  TRIP_OPEN_STATUSES,
  TRIP_TRANSITIONS,
  isTripEditable,
  planStops,
  type TripDoInput,
  type TripEvent,
  type TripStatus,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { keysetArgs, type ListQuery } from '../../common/pagination';
import { DbService, type Tx } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { AssignabilityService } from '../assignability/assignability.service';
import { CompatibilityService } from '../compatibility/compatibility.service';
import {
  DeliveryOrderService,
  type DeliveryOrderRecord,
} from '../delivery-orders/delivery-order.service';
import { cleanLine } from '../master/master-kit';
import { OrderStateService } from '../orders/order-state.service';
import { issueNumber } from '../sequences/sequences.service';

export const TRIP_INCLUDE = {
  stops: { where: { removedAt: null }, orderBy: { sequence: 'asc' } },
  deliveryOrders: {
    where: { status: { not: 'CANCELLED' } },
    orderBy: [{ doNo: 'asc' }],
    select: {
      id: true,
      doNo: true,
      status: true,
      salesOrderId: true,
      customerId: true,
      pickupTripStopId: true,
      tripStopId: true,
    },
  },
} as const satisfies Prisma.TripInclude;

export type TripRecord = Prisma.TripGetPayload<{ include: typeof TRIP_INCLUDE }>;

export interface TripWarning {
  code: string;
  severity: 'warning' | 'block';
  source: 'compatibility' | 'assignability' | 'schedule' | 'stops' | 'assignment';
  messageKey: string;
  message: string;
  params: Record<string, unknown>;
}

export interface TripFilter extends ListQuery {
  statuses?: TripStatus[];
  dateFrom?: string;
  dateTo?: string;
  vehicleId?: string;
  driverId?: string;
  carrierId?: string;
}

export interface CreateTripInput {
  tripDate: string;
  deliveryOrderIds: string[];
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
}

export interface AssignInput {
  vehicleId: string;
  driverId?: string | null;
  reliefDriverId?: string | null;
  trailerId?: string | null;
}

const ENTITY = 'trip';
const EVENT_TYPE: Partial<Record<TripEvent, string>> = {
  offer: 'trip.offered',
  accept: 'trip.assigned',
  assign: 'trip.assigned',
  reassign: 'trip.assigned',
  dispatch: 'trip.dispatched',
  complete: 'trip.completed',
  cancel: 'trip.cancelled',
};
const OFFER_TTL_MS = 48 * 3600_000; // docs/01 §3.3 ลิงก์รับงาน 48 ชม. (ลิงก์/หมดอายุ = ST3-T23/T24)

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/**
 * เที่ยวรถ (ST3-T11; docs/01 §3.3 trip/trip_stop, §4.2 state machine, §5.2 #3; docs/04 D1)
 *
 * - **ลำดับล็อก SO → DO → trip** ทุกงาน (สัญญากับ T09): `DeliveryOrderService.lockForTrip` ล็อก SO แล้ว DO → ล็อก trip
 *   → ตรวจว่าชุด DO ของเที่ยวไม่เปลี่ยนระหว่างนั้น (เปลี่ยน → 409 `concurrent_update`)
 * - เขียน delivery_order ผ่าน `DeliveryOrderService` เท่านั้น · สถานะ SO ผ่าน `OrderStateService` เท่านั้น
 * - รถ/คนขับ/คนขับสำรอง/หาง/รถร่วม = **snapshot ต่อเที่ยว** เขียนตอน assign/offer (และรถที่วางไว้ตอนสร้าง) — ไม่อ่าน master ภายหลัง
 *   (คนขับประจำ/ชื่อ/ทะเบียนเปลี่ยนแล้วเที่ยวเดิมไม่เปลี่ยน) · หลังปล่อยรถแก้ไม่ได้ (ตาราง transition)
 * - จุดแวะจัดจาก DO (`planStops`) ทุกครั้งที่เพิ่ม/ถอด DO ก่อนปล่อยรถ — จุดที่ไม่มี DO ใช้ตั้ง removed_at (ไม่ลบจริง)
 * - คำเตือน (เข้ากันได้/เอกสารรถ/ซ้อนเวลา/ช่วงเวลาจุด) **ไม่บล็อก** — เก็บใน `rule_warnings` และคืนใน `warnings`
 *   (บังคับ + override พร้อมเหตุผล = ST3-T14)
 * - ยกเลิก: เหตุผล ≥ 10 + audit · DO ที่ยังไม่รับของกลับ DRAFT นอกเที่ยว (ล้าง trip_id) · SO ตาม DO
 */
@Injectable()
export class TripService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
    private readonly dos: DeliveryOrderService,
    private readonly orderState: OrderStateService,
    private readonly compatibility: CompatibilityService,
    private readonly assignability: AssignabilityService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // อ่าน

  async list(q: TripFilter, tx: Tx = this.db.tx) {
    const k = keysetArgs(q);
    const where: Prisma.TripWhereInput = {
      AND: [
        k.where as Prisma.TripWhereInput,
        q.statuses?.length ? { status: { in: q.statuses as DbTripStatus[] } } : {},
        q.dateFrom ? { tripDate: { gte: new Date(`${q.dateFrom}T00:00:00Z`) } } : {},
        q.dateTo ? { tripDate: { lte: new Date(`${q.dateTo}T00:00:00Z`) } } : {},
        q.vehicleId ? { vehicleId: q.vehicleId } : {},
        q.driverId ? { OR: [{ driverId: q.driverId }, { reliefDriverId: q.driverId }] } : {},
        q.carrierId ? { carrierId: q.carrierId } : {},
      ],
    };
    const rows = await tx.trip.findMany({
      where,
      include: TRIP_INCLUDE,
      orderBy: [...k.orderBy],
      take: k.take,
    });
    return { rows, k };
  }

  async get(id: string, tx: Tx = this.db.tx): Promise<TripRecord> {
    const t = await tx.trip.findUnique({ where: { id }, include: TRIP_INCLUDE });
    if (!t) throw new ProblemException('not_found');
    return t;
  }

  // ---------------------------------------------------------------------------------------------
  // สร้าง / เพิ่ม-ถอด DO

  /**
   * สร้างเที่ยว PLANNING จาก DO (≥ 1) — จุดแวะจาก DO · **ไม่รับรถ** (รถ/คนขับ/รถร่วมเข้าทาง /assign หรือ /offer เท่านั้น —
   * ล็อกรถ + snapshot ชุดเดียว; review ST3-T11)
   */
  async create(input: CreateTripInput, tx: Tx = this.db.tx): Promise<TripRecord> {
    const tenantId = this.tenantId();
    const window = this.window(input.plannedStartAt, input.plannedEndAt);
    const dos = await this.dos.lockForTrip(tx, input.deliveryOrderIds);
    const trip = await tx.trip.create({
      data: {
        tenantId,
        tripNo: await issueNumber(tx, tenantId, { docType: 'TRIP' }),
        tripDate: new Date(`${input.tripDate}T00:00:00Z`),
        plannedStartAt: window.start,
        plannedEndAt: window.end,
        status: 'PLANNING',
      },
    });
    await this.history(tx, trip.id, 'NONE', 'PLANNING', 'create');
    const stops = await this.replanStops(tx, trip, dos, { attach: dos, plan: false });
    await this.orderState.syncFromDeliveryOrders(
      tx,
      dos.map((d) => d.salesOrderId),
    );
    const final = await this.refreshWarnings(tx, trip.id, stops.windowConflicts);
    await this.emit(tx, 'trip.created', final, {});
    await this.audit.record({
      action: `${ENTITY}.created`,
      entityType: ENTITY,
      entityId: trip.id,
      after: view(final),
    });
    return final;
  }

  /** เพิ่ม DO เข้าเที่ยว (PLANNING/ASSIGNED) — เที่ยว ASSIGNED → DO เป็น PLANNED ทันที */
  async attach(
    id: string,
    doIds: string[],
    tx: Tx = this.db.tx,
    expectedVersion?: number,
  ): Promise<TripRecord> {
    const { trip, dos } = await this.lock(tx, id, expectedVersion, doIds);
    this.assertEditable(trip);
    const adding = dos.filter((d) => doIds.includes(d.id));
    const dup = adding.filter((d) => d.tripId === trip.id);
    if (dup.length)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'deliveryOrderIds', code: 'already_on_trip', message: 'already on this trip' },
      ]);
    const current = dos.filter((d) => d.tripId === trip.id);
    const stops = await this.replanStops(tx, trip, [...current, ...adding], {
      attach: adding,
      plan: trip.status === 'ASSIGNED',
    });
    await this.bump(tx, trip);
    await this.orderState.syncFromDeliveryOrders(
      tx,
      adding.map((d) => d.salesOrderId),
    );
    const final = await this.refreshWarnings(tx, trip.id, stops.windowConflicts);
    await this.emit(tx, 'trip.updated', final, {
      deliveryOrderIds: trip.deliveryOrders.map((d) => d.id),
    });
    await this.audit.record({
      action: `${ENTITY}.orders_attached`,
      entityType: ENTITY,
      entityId: trip.id,
      after: { deliveryOrders: adding.map((d) => d.doNo) },
    });
    return final;
  }

  /** ถอด DO ออกจากเที่ยว (PLANNING/ASSIGNED) — DO กลับ DRAFT นอกเที่ยว · SO ตาม DO */
  async detach(
    id: string,
    doIds: string[],
    note: string | null,
    tx: Tx = this.db.tx,
    expectedVersion?: number,
  ): Promise<TripRecord> {
    const { trip, dos } = await this.lock(tx, id, expectedVersion, doIds);
    this.assertEditable(trip);
    const removing = dos.filter((d) => doIds.includes(d.id));
    const notHere = doIds.flatMap((x, i) =>
      removing.find((d) => d.id === x && d.tripId === trip.id)
        ? []
        : [{ field: `deliveryOrderIds[${i}]`, code: 'not_on_trip', message: 'not on this trip' }],
    );
    if (notHere.length) throw new ProblemException('validation_failed', undefined, notHere);
    const text = note ? cleanLine(note).trim() || null : null;
    for (const d of removing) await this.dos.releaseFromTrip(tx, d, text ?? 'ถอดออกจากเที่ยว');
    const remaining = dos.filter((d) => d.tripId === trip.id && !doIds.includes(d.id));
    const fresh = await this.reload(tx, remaining);
    const stops = await this.replanStops(tx, trip, fresh, { attach: [], plan: false });
    await this.bump(tx, trip);
    await this.orderState.syncFromDeliveryOrders(
      tx,
      removing.map((d) => d.salesOrderId),
    );
    const final = await this.refreshWarnings(tx, trip.id, stops.windowConflicts);
    await this.emit(tx, 'trip.updated', final, {
      deliveryOrderIds: trip.deliveryOrders.map((d) => d.id),
    });
    await this.audit.record({
      action: `${ENTITY}.orders_detached`,
      entityType: ENTITY,
      entityId: trip.id,
      before: { deliveryOrders: removing.map((d) => d.doNo) },
      reason: text ?? undefined,
    });
    return final;
  }

  // ---------------------------------------------------------------------------------------------
  // action ตาม state machine

  /**
   * จัดรถ (PLANNING → ASSIGNED / ASSIGNED → ASSIGNED เปลี่ยนรถ / OFFERED → ASSIGNED รถร่วมรับ — ผู้จัดรถบันทึกแทน):
   * snapshot รถ ประเภทรถ (id + ชื่อ — สัญญา ST2-T14) หาง คนขับ คนขับสำรอง รถร่วม · DO DRAFT → PLANNED
   * คนขับไม่ส่ง = คนขับประจำของรถ (มีคนเดียว) — ใช้ค่า **ณ ตอนนี้** แล้วเก็บเป็น snapshot
   */
  async assign(
    id: string,
    input: AssignInput,
    tx: Tx = this.db.tx,
    expectedVersion?: number,
  ): Promise<TripRecord> {
    const { trip, dos } = await this.lock(tx, id, expectedVersion);
    const event: TripEvent =
      trip.status === 'OFFERED' ? 'accept' : trip.status === 'ASSIGNED' ? 'reassign' : 'assign';
    this.assertCan(trip, event);
    if (!dos.length) throw new ProblemException('trip_empty');
    const snap = await this.assignmentSnapshot(tx, trip, input);
    // รถร่วมเข้าทาง /offer ก่อนเสมอ (docs/01 §4.2 PLANNING → OFFERED → ASSIGNED) · เปลี่ยนรถร่วม = ยกเลิกการจ้างเดิม (ST3-T25)
    if (event === 'assign' && snap.carrierId !== null)
      throw new ProblemException('offer_required', undefined, undefined, {
        carrierId: snap.carrierId,
      });
    if (event === 'reassign' && snap.carrierId !== trip.carrierId)
      throw new ProblemException('carrier_change_requires_cancel', undefined, undefined, {
        from: trip.carrierId,
        to: snap.carrierId,
      });
    await this.lockVehicle(tx, input.vehicleId);
    const before = view(await this.get(trip.id, tx));
    await this.transition(tx, trip, event, {
      ...snap,
      assignedAt: new Date(),
      // ช่องข้อเสนอรถร่วม: accept → ACCEPTED · รถบริษัท (assign จาก PLANNING) → ล้างค้างจากข้อเสนอที่ถูกปฏิเสธ/หมดอายุ
      // reassign รถร่วมรายเดิม → คงสถานะข้อเสนอเดิม (ACCEPTED)
      ...(event === 'accept' ? { assignmentStatus: 'ACCEPTED' } : {}),
      ...(event === 'assign' ? CLEAR_OFFER : {}),
    });
    for (const d of dos) await this.dos.planForTrip(tx, d);
    await this.orderState.syncFromDeliveryOrders(
      tx,
      dos.map((d) => d.salesOrderId),
    );
    const final = await this.refreshWarnings(tx, trip.id);
    await this.audit.record({
      action: `${ENTITY}.assigned`,
      entityType: ENTITY,
      entityId: trip.id,
      before,
      after: view(final),
    });
    return final;
  }

  /** เสนองานรถร่วม (PLANNING → OFFERED): รถร่วม + ผู้เสนอ + เวลา (ลิงก์/token = ST3-T23) */
  async offer(
    id: string,
    carrierId: string,
    tx: Tx = this.db.tx,
    expectedVersion?: number,
  ): Promise<TripRecord> {
    const { trip } = await this.lock(tx, id, expectedVersion);
    this.assertCan(trip, 'offer');
    const on = await tx.deliveryOrder.count({
      where: { tripId: trip.id, status: { not: 'CANCELLED' } },
    });
    if (!on) throw new ProblemException('trip_empty');
    const carrier = await tx.carrier.findFirst({ where: { id: carrierId, deletedAt: null } });
    if (!carrier) throw field422('carrierId', 'invalid_reference', 'carrier not found');
    if (carrier.status !== 'ACTIVE')
      throw field422('carrierId', 'carrier_inactive', 'carrier is suspended');
    const now = new Date();
    // PLANNING ไม่มีรถ/คนขับเสมอ (create ไม่รับรถ, assign ไป ASSIGNED) — ล้างไว้กันค่าค้าง (รถร่วมใส่ทะเบียนเองตอนรับงาน)
    await this.transition(tx, trip, 'offer', {
      carrierId,
      carrierNameSnapshot: carrier.legalName,
      assignmentStatus: 'OFFERED',
      offeredAt: now,
      offeredBy: requestContext.require().actorId ?? null,
      assignmentExpiresAt: new Date(now.getTime() + OFFER_TTL_MS),
      ...CLEAR_VEHICLE,
    });
    const final = await this.refreshWarnings(tx, trip.id);
    await this.audit.record({
      action: `${ENTITY}.offered`,
      entityType: ENTITY,
      entityId: trip.id,
      after: { carrier: carrier.code, carrierName: carrier.legalName },
    });
    return final;
  }

  /** ปล่อยรถ (ASSIGNED → DISPATCHED): ต้องมี DO ≥ 1 · ทุก DO → DISPATCHED · SO → IN_TRANSIT */
  async dispatch(id: string, tx: Tx = this.db.tx, expectedVersion?: number): Promise<TripRecord> {
    const { trip, dos } = await this.lock(tx, id, expectedVersion);
    this.assertCan(trip, 'dispatch');
    if (!dos.length) throw new ProblemException('trip_empty');
    await this.transition(tx, trip, 'dispatch', { dispatchedAt: new Date() });
    for (const d of await this.reload(tx, dos)) {
      await this.dos.planForTrip(tx, d);
      await this.dos.dispatchForTrip(tx, (await this.reload(tx, [d]))[0]!);
    }
    await this.orderState.syncFromDeliveryOrders(
      tx,
      dos.map((d) => d.salesOrderId),
    );
    const final = await this.get(trip.id, tx);
    await this.audit.record({
      action: `${ENTITY}.dispatched`,
      entityType: ENTITY,
      entityId: trip.id,
      after: view(final),
    });
    return final;
  }

  /** ปิดเที่ยว (IN_PROGRESS → COMPLETED): ทุกจุด COMPLETED/FAILED/SKIPPED (docs/01 §4.2) — สถานะ DO มาจาก stop event (ST4) */
  async complete(id: string, tx: Tx = this.db.tx, expectedVersion?: number): Promise<TripRecord> {
    const { trip } = await this.lock(tx, id, expectedVersion);
    this.assertCan(trip, 'complete');
    const open = trip.stops.filter(
      (s) => !(STOP_TERMINAL_STATUSES as readonly string[]).includes(s.status),
    );
    if (open.length)
      throw new ProblemException('trip_stops_open', undefined, undefined, {
        stops: open.map((s) => s.sequence),
      });
    await this.transition(tx, trip, 'complete', { completedAt: new Date() });
    const final = await this.get(trip.id, tx);
    await this.audit.record({
      action: `${ENTITY}.completed`,
      entityType: ENTITY,
      entityId: trip.id,
      after: view(final),
    });
    return final;
  }

  /**
   * ยกเลิกเที่ยว (PLANNING/OFFERED/ASSIGNED/DISPATCHED): เหตุผล ≥ 10 ตัวอักษร + reason code หมวด CANCEL (ไม่บังคับ) + audit
   * DO ที่ยังไม่รับของ (DRAFT/PLANNED/DISPATCHED) → DRAFT นอกเที่ยว (ล้าง trip_id/จุด) · รับของแล้ว → 409 `trip_has_loaded_orders`
   * SO ตาม DO (PLANNED/IN_TRANSIT → RECEIVED + ประเมินใบค้างใหม่) · ค่าชดเชยรถร่วม (PLN-012) = ST3-T25/ST6
   */
  async cancel(
    id: string,
    input: { reason: string; reasonCodeId?: string | null },
    tx: Tx = this.db.tx,
    expectedVersion?: number,
    /** ผู้เรียกมีสิทธิ์ `trips:dispatch` (ยกเลิกเที่ยวที่ปล่อยรถแล้ว — A3 Planner ไม่มี) — ตรวจหลังล็อก (กันชนกับการปล่อยรถพร้อมกัน) */
    opts: { canCancelDispatched: boolean } = { canCancelDispatched: true },
  ): Promise<TripRecord> {
    const reason = cleanLine(String(input.reason ?? '')).trim();
    if ([...reason].length < 10)
      throw field422('reason', 'too_short', 'reason must be at least 10 characters');
    if (input.reasonCodeId) {
      const rc = await tx.reasonCode.count({
        where: { id: input.reasonCodeId, category: 'CANCEL', status: 'ACTIVE', deletedAt: null },
      });
      if (!rc) throw field422('reasonCodeId', 'invalid_reference', 'reason code not found');
    }
    const { trip, dos } = await this.lock(tx, id, expectedVersion);
    this.assertCan(trip, 'cancel');
    if (trip.status === 'DISPATCHED' && !opts.canCancelDispatched)
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'trips',
        action: 'dispatch',
        required: ['trips:dispatch'],
      });
    const before = view(trip);
    for (const d of dos)
      await this.dos.releaseFromTrip(tx, d, `ยกเลิกเที่ยว ${trip.tripNo}: ${reason}`);
    await this.transition(
      tx,
      trip,
      'cancel',
      {
        cancelledAt: new Date(),
        cancelReason: reason,
        cancelReasonCodeId: input.reasonCodeId ?? null,
        ...(trip.assignmentStatus === 'OFFERED' ? { assignmentStatus: null } : {}),
      },
      { reasonCodeId: input.reasonCodeId ?? null, note: reason },
    );
    await this.orderState.syncFromDeliveryOrders(
      tx,
      dos.map((d) => d.salesOrderId),
    );
    const final = await this.get(trip.id, tx);
    await this.audit.record({
      action: `${ENTITY}.cancelled`,
      entityType: ENTITY,
      entityId: trip.id,
      before,
      after: { status: final.status, releasedOrders: dos.map((d) => d.doNo) },
      reason,
    });
    return final;
  }

  // ---------------------------------------------------------------------------------------------

  private tenantId(): string {
    const t = requestContext.require().tenantId;
    if (!t) throw new Error('trips: tenant missing in request context');
    return t;
  }

  private window(start?: string | null, end?: string | null) {
    const s = start ? new Date(start) : null;
    const e = end ? new Date(end) : null;
    if (s && e && e < s)
      throw field422(
        'plannedEndAt',
        'before_start',
        'plannedEndAt must not be before plannedStartAt',
      );
    return { start: s, end: e };
  }

  /**
   * ล็อกตามลำดับ SO → DO → trip แล้วอ่านใหม่ · ชุด DO ของเที่ยวเปลี่ยนระหว่างล็อก → 409 `concurrent_update`
   * `extra` = DO อื่นที่จะเพิ่ม/ถอด (ล็อกพร้อมกัน)
   */
  private async lock(
    tx: Tx,
    id: string,
    expectedVersion?: number,
    extra: string[] = [],
  ): Promise<{ trip: TripRecord; dos: DeliveryOrderRecord[] }> {
    const head = await tx.trip.findUnique({ where: { id }, select: { id: true } });
    if (!head) throw new ProblemException('not_found');
    const on = await tx.deliveryOrder.findMany({
      where: { tripId: id, status: { not: 'CANCELLED' } },
      select: { id: true },
    });
    const locked = await this.dos.lockForTrip(tx, [...extra, ...on.map((d) => d.id)]);
    await tx.$queryRaw`SELECT id FROM trip WHERE id = ${id}::uuid FOR UPDATE`;
    const trip = await this.get(id, tx);
    if (expectedVersion !== undefined && trip.version !== expectedVersion)
      throw new ProblemException('precondition_failed');
    const lockedIds = new Set(locked.map((d) => d.id));
    if (trip.deliveryOrders.some((d) => !lockedIds.has(d.id)))
      throw new ProblemException('concurrent_update');
    const mine = locked.filter((d) => d.tripId === id);
    return {
      trip,
      dos: extra.length ? locked : mine,
    };
  }

  /**
   * ล็อกรถ (advisory namespace 12 = ST3-T11 รถของเที่ยว; uuid ไม่ซ้ำข้าม tenant) — สองคนจัดรถคันเดียวกันพร้อมกัน
   * เห็นเที่ยวของกันและกันตอนตรวจซ้อนเวลา (คำเตือน — ไม่บล็อก)
   */
  private async lockVehicle(tx: Tx, vehicleId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(12, hashtext(${vehicleId}))`;
  }

  private assertEditable(trip: TripRecord) {
    if (!isTripEditable(trip.status as TripStatus))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        from: trip.status,
      });
  }

  private assertCan(trip: TripRecord, event: TripEvent) {
    if (!TRIP_TRANSITIONS[trip.status as TripStatus]?.[event])
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        from: trip.status,
        event,
      });
  }

  private async reload(tx: Tx, dos: DeliveryOrderRecord[]): Promise<DeliveryOrderRecord[]> {
    const out: DeliveryOrderRecord[] = [];
    for (const d of dos) out.push(await this.dos.get(d.id, tx));
    return out;
  }

  private async bump(tx: Tx, trip: TripRecord) {
    const r = await tx.trip.updateMany({
      where: { id: trip.id, version: trip.version },
      data: { version: { increment: 1 } },
    });
    if (r.count === 0) throw new ProblemException('concurrent_update');
  }

  private async transition(
    tx: Tx,
    trip: TripRecord,
    event: TripEvent,
    data: Prisma.TripUncheckedUpdateManyInput,
    extra: { reasonCodeId?: string | null; note?: string | null } = {},
  ) {
    await this.state.transition<TripStatus, TripEvent>(tx, {
      docType: ENTITY,
      docId: trip.id,
      table: TRIP_TRANSITIONS,
      from: trip.status as TripStatus,
      event,
      reasonCodeId: extra.reasonCodeId ?? null,
      note: extra.note ?? null,
      eventType: EVENT_TYPE[event] ?? 'trip.updated',
      apply: async (to) => {
        const r = await tx.trip.updateMany({
          where: { id: trip.id, status: trip.status, version: trip.version },
          data: { ...data, status: to as DbTripStatus, version: { increment: 1 } },
        });
        if (r.count === 0) throw new ProblemException('concurrent_update');
        return eventView(await this.get(trip.id, tx));
      },
    });
  }

  /**
   * จัดจุดใหม่ตาม DO ทั้งหมดของเที่ยว (`all`) — คงจุดเดิมที่ยังใช้, จุดใหม่ต่อเข้า, จุดที่ไม่ใช้ตั้ง removed_at
   * แล้วผูก DO กับจุดรับ/ส่ง (`attach` = DO ใหม่ → ลงเที่ยว; ที่เหลือ = ปรับจุด)
   */
  private async replanStops(
    tx: Tx,
    trip: Trip,
    all: DeliveryOrderRecord[],
    o: { attach: DeliveryOrderRecord[]; plan: boolean },
  ) {
    const existing = await tx.tripStop.findMany({
      where: { tripId: trip.id, removedAt: null },
      orderBy: { sequence: 'asc' },
    });
    const plan = planStops(
      existing.map((s) => ({ id: s.id, type: s.type, siteId: s.siteId, sequence: s.sequence })),
      await this.doInputs(tx, all),
    );
    if (plan.removed.length)
      await tx.tripStop.updateMany({
        where: { id: { in: plan.removed } },
        data: { removedAt: new Date() },
      });
    // ลำดับใหม่: ย้ายจุดเดิมออกไปช่วงชั่วคราวก่อน (partial unique ต่อ sequence) แล้วตั้งค่าจริง
    if (existing.length)
      await tx.tripStop.updateMany({
        where: { tripId: trip.id, removedAt: null },
        data: { sequence: { increment: 100000 } },
      });
    const ids: string[] = [];
    for (const s of plan.stops) {
      const w = {
        windowStart: s.window.start ? new Date(s.window.start) : null,
        windowEnd: s.window.end ? new Date(s.window.end) : null,
      };
      if (s.id) {
        const prev = existing.find((e) => e.id === s.id)!;
        await tx.tripStop.update({
          where: { id: s.id },
          data: {
            sequence: s.sequence,
            ...w,
            // เวลาตามแผนเดิมยังอยู่ในช่วงใหม่ → คง (ผู้จัดรถอาจตั้งเอง) · หลุดช่วง/ว่าง → ต้นช่วง
            plannedArrival:
              prev.plannedArrival &&
              (!w.windowStart || prev.plannedArrival >= w.windowStart) &&
              (!w.windowEnd || prev.plannedArrival <= w.windowEnd)
                ? prev.plannedArrival
                : w.windowStart,
          },
        });
        ids.push(s.id);
      } else {
        const row = await tx.tripStop.create({
          data: {
            tenantId: trip.tenantId,
            tripId: trip.id,
            sequence: s.sequence,
            type: s.type,
            siteId: s.siteId,
            ...w,
            plannedArrival: w.windowStart,
          },
        });
        ids.push(row.id);
      }
    }
    const adding = new Set(o.attach.map((d) => d.id));
    for (const d of all) {
      const pickup = ids[plan.pickupOf[d.id]!]!;
      const drop = ids[plan.dropOf[d.id]!]!;
      if (adding.has(d.id))
        await this.dos.attachToTrip(tx, d, {
          tripId: trip.id,
          pickupStopId: pickup,
          dropStopId: drop,
          plan: o.plan,
        });
      else await this.dos.setTripStops(tx, d, pickup, drop);
    }
    return plan;
  }

  /** DO → จุดรับ/ส่ง + ช่วงเวลาของจุดนั้นใน SO */
  private async doInputs(tx: Tx, dos: DeliveryOrderRecord[]): Promise<TripDoInput[]> {
    const soStops = await tx.salesOrderStop.findMany({
      where: { salesOrderId: { in: [...new Set(dos.map((d) => d.salesOrderId))] } },
      select: { salesOrderId: true, sequence: true, windowStart: true, windowEnd: true },
    });
    const win = (so: string, seq: number) => {
      const s = soStops.find((x) => x.salesOrderId === so && x.sequence === seq);
      return {
        start: s?.windowStart?.toISOString() ?? null,
        end: s?.windowEnd?.toISOString() ?? null,
      };
    };
    return [...dos]
      .sort((a, b) => (a.doNo ?? '').localeCompare(b.doNo ?? ''))
      .map((d) => ({
        id: d.id,
        originSiteId: d.originSiteId,
        destSiteId: d.destSiteId,
        pickupWindow: win(d.salesOrderId, d.originStopSeq),
        dropWindow: win(d.salesOrderId, d.destStopSeq),
      }));
  }

  /** snapshot รถ + ประเภทรถ (id + ชื่อ) — รถไม่พบ/ลบ/ปลดระวาง/เป็นหาง → 422 */
  private async vehicleSnapshot(tx: Tx, vehicleId: string, field = 'vehicleId') {
    const v = await tx.vehicle.findFirst({
      where: { id: vehicleId, deletedAt: null },
      include: { vehicleType: { select: { nameTh: true } } },
    });
    if (!v) throw field422(field, 'invalid_reference', 'vehicle not found');
    if (v.status === 'RETIRED') throw field422(field, 'vehicle_retired', 'vehicle is retired');
    if (v.unitRole === 'TRAILER')
      throw field422(field, 'is_trailer', 'a trailer cannot be the main vehicle');
    return {
      vehicleId: v.id,
      vehiclePlateSnapshot: v.plate,
      vehicleTypeId: v.vehicleTypeId,
      vehicleTypeSnapshot: v.vehicleType.nameTh,
    };
  }

  private async driverRow(tx: Tx, id: string, field: string) {
    const d = await tx.driver.findFirst({ where: { id, deletedAt: null } });
    if (!d) throw field422(field, 'invalid_reference', 'driver not found');
    if (d.status === 'INACTIVE') throw field422(field, 'driver_inactive', 'driver is inactive');
    return d;
  }

  /**
   * snapshot ทั้งชุดของการจัดรถ (รถ ประเภท หาง คนขับ คนขับสำรอง รถร่วม)
   * ตรวจเฉพาะการอ้างอิงที่ใช้ได้ (มีอยู่ ไม่ปลดระวาง/ปิดใช้ หางเป็นหางจริง) — คนขับเป็นของรถร่วมรายใด / ใบขับขี่ตรงประเภทรถ /
   * น้ำหนัก = กฎตอนจัดของ ST3-T14 (เตือน + override) ไม่ใช่ที่นี่
   */
  private async assignmentSnapshot(tx: Tx, trip: TripRecord, input: AssignInput) {
    const vehicle = await this.vehicleSnapshot(tx, input.vehicleId);
    const v = (await tx.vehicle.findUnique({
      where: { id: input.vehicleId },
      include: { carrier: true },
    }))!;
    let carrier: { carrierId: string | null; carrierNameSnapshot: string | null } = {
      carrierId: null,
      carrierNameSnapshot: null,
    };
    if (v.ownership === 'SUBCONTRACT') {
      if (!v.carrier || v.carrier.deletedAt)
        throw field422('vehicleId', 'invalid_reference', 'carrier of vehicle not found');
      if (v.carrier.status !== 'ACTIVE')
        throw field422('vehicleId', 'carrier_inactive', 'carrier of vehicle is suspended');
      carrier = { carrierId: v.carrier.id, carrierNameSnapshot: v.carrier.legalName };
    }
    if (trip.status === 'OFFERED' && carrier.carrierId !== trip.carrierId)
      throw field422('vehicleId', 'carrier_mismatch', 'vehicle must belong to the offered carrier');
    // คนขับ: ส่งมา หรือคนขับประจำของรถ ณ ตอนนี้ (มีคนเดียว)
    let driverId = input.driverId ?? null;
    if (driverId === null && input.driverId === undefined) {
      const defaults = await tx.driver.findMany({
        where: { defaultVehicleId: v.id, status: 'ACTIVE', deletedAt: null },
        select: { id: true },
        take: 2,
      });
      if (defaults.length === 1) driverId = defaults[0]!.id;
    }
    if (driverId === null && v.ownership === 'OWN')
      throw field422('driverId', 'required', 'company vehicles need a driver');
    const driver = driverId ? await this.driverRow(tx, driverId, 'driverId') : null;
    const relief = input.reliefDriverId
      ? await this.driverRow(tx, input.reliefDriverId, 'reliefDriverId')
      : null;
    if (relief && driver && relief.id === driver.id)
      throw field422('reliefDriverId', 'same_as_driver', 'relief driver must differ from driver');
    let trailer: { trailerId: string | null; trailerPlateSnapshot: string | null } = {
      trailerId: null,
      trailerPlateSnapshot: null,
    };
    if (input.trailerId) {
      const t = await tx.vehicle.findFirst({ where: { id: input.trailerId, deletedAt: null } });
      if (!t) throw field422('trailerId', 'invalid_reference', 'trailer not found');
      if (t.unitRole !== 'TRAILER' || t.id === v.id)
        throw field422('trailerId', 'not_trailer', 'must be a trailer unit');
      if (t.status === 'RETIRED')
        throw field422('trailerId', 'vehicle_retired', 'trailer is retired');
      trailer = { trailerId: t.id, trailerPlateSnapshot: t.plate };
    }
    return {
      ...vehicle,
      ...trailer,
      ...carrier,
      driverId: driver?.id ?? null,
      driverNameSnapshot: driver?.name ?? null,
      driverPhoneSnapshot: driver?.phone ?? null,
      reliefDriverId: relief?.id ?? null,
      reliefDriverNameSnapshot: relief?.name ?? null,
      reliefDriverPhoneSnapshot: relief?.phone ?? null,
    };
  }

  /**
   * ตรวจคำเตือนทั้งหมดใหม่แล้วเก็บใน rule_warnings (ไม่บล็อก — ST3-T14 บังคับ/override):
   * ความเข้ากันได้ (ST2-T16) ต่อ SO · เอกสารรถ/ใบขับขี่ (ST2-T20) ตามช่วงวิ่ง · รถ/คนขับซ้อนเวลา · สถานะรถ/คนขับ · ช่วงเวลาจุด
   * - เป็น **ภาพ ณ การกระทำล่าสุดบนเที่ยวนี้** — เที่ยวอื่นที่มาซ้อนทีหลัง/เอกสารที่หมดทีหลังไม่ย้อนมาอัปเดต
   *   (กระดาน ST3-T12 ต้องคำนวณซ้อนเวลา ณ ตอนอ่านเอง) · เนื้อหาเปลี่ยน → version +1 (ETag)
   * - `rule_warnings` เก็บ **เฉพาะผลตรวจ** — เหตุผล override ของ ST3-T14 ต้องแยกคอลัมน์ (เช่น `rule_overrides`) ไม่ปนกัน
   *   เพราะคำนวณใหม่ทุกครั้งจะทับ
   */
  private async refreshWarnings(
    tx: Tx,
    id: string,
    windowConflicts?: number[],
  ): Promise<TripRecord> {
    const trip = await this.get(id, tx);
    const out: TripWarning[] = [];
    // ช่วงเวลาของ DO ที่จุดเดียวกันไม่ทับกัน
    const conflicts =
      windowConflicts ??
      ((trip.ruleWarnings as unknown as TripWarning[]) ?? [])
        .filter((w) => w.code === 'stop_window_conflict')
        .map((w) => Number(w.params.sequence) - 1);
    for (const i of conflicts) {
      const s = trip.stops[i];
      if (s)
        out.push({
          code: 'stop_window_conflict',
          severity: 'warning',
          source: 'stops',
          messageKey: 'trip.stopWindowConflict',
          message: `จุดที่ ${s.sequence}: ช่วงเวลาที่ลูกค้าขอของใบส่งของในจุดนี้ไม่ทับกัน`,
          params: { sequence: s.sequence },
        });
    }
    if (trip.vehicleId) {
      const v = await tx.vehicle.findUnique({ where: { id: trip.vehicleId } });
      if (v && v.status !== 'READY')
        out.push({
          code: 'vehicle_not_ready',
          severity: 'warning',
          source: 'assignment',
          messageKey: 'trip.vehicleNotReady',
          message: `รถ ${trip.vehiclePlateSnapshot} อยู่ในสถานะ${v.status === 'MAINTENANCE' ? 'ซ่อม' : 'จอด'}`,
          params: { status: v.status },
        });
      out.push(...(await this.compatWarnings(tx, trip)));
      const from = trip.plannedStartAt ?? trip.tripDate;
      const to = trip.plannedEndAt ?? trip.plannedStartAt ?? trip.tripDate;
      const a = await this.assignability.isAssignable(
        { vehicleId: trip.vehicleId, driverId: trip.driverId, window: { from, to } },
        tx,
      );
      for (const i of [...a.blocks, ...a.warnings])
        out.push({
          code: i.code,
          severity: i.severity,
          source: 'assignability',
          messageKey: i.messageKey,
          message: i.message,
          params: {
            ...i.params,
            ...(i.docType ? { docType: i.docType } : {}),
            ...(i.expiredOn ? { expiredOn: i.expiredOn } : {}),
          },
        });
      out.push(...(await this.overlapWarnings(tx, trip, 'vehicle')));
    }
    if (trip.driverId) {
      const d = await tx.driver.findUnique({ where: { id: trip.driverId } });
      if (d?.status === 'ON_LEAVE')
        out.push({
          code: 'driver_on_leave',
          severity: 'warning',
          source: 'assignment',
          messageKey: 'trip.driverOnLeave',
          message: `คนขับ ${trip.driverNameSnapshot} ลาอยู่`,
          params: {},
        });
      out.push(...(await this.overlapWarnings(tx, trip, 'driver')));
    }
    const json = JSON.parse(JSON.stringify(out)) as Prisma.InputJsonValue;
    if (JSON.stringify(trip.ruleWarnings) !== JSON.stringify(json))
      await tx.trip.update({
        where: { id },
        data: { ruleWarnings: json, version: { increment: 1 } },
      });
    return this.get(id, tx);
  }

  private async compatWarnings(tx: Tx, trip: TripRecord): Promise<TripWarning[]> {
    const dos = await tx.deliveryOrder.findMany({
      where: { tripId: trip.id, status: { not: 'CANCELLED' } },
      select: {
        salesOrderId: true,
        originSiteId: true,
        destSiteId: true,
        salesOrder: { select: { vehicleTypeId: true } },
        lines: { select: { salesOrderLine: { select: { productId: true } } } },
      },
    });
    const bySo = new Map<string, typeof dos>();
    for (const d of dos) bySo.set(d.salesOrderId, [...(bySo.get(d.salesOrderId) ?? []), d]);
    const seen = new Set<string>();
    const out: TripWarning[] = [];
    for (const group of bySo.values()) {
      const r = await this.compatibility.check(
        {
          vehicleId: trip.vehicleId!,
          productIds: group.flatMap((d) =>
            d.lines.flatMap((l) =>
              l.salesOrderLine?.productId ? [l.salesOrderLine.productId] : [],
            ),
          ),
          siteIds: group.flatMap((d) => [d.originSiteId, d.destSiteId]),
          job: { requestedVehicleTypeId: group[0]!.salesOrder.vehicleTypeId },
        },
        tx,
      );
      for (const w of r.warnings) {
        const k = `${w.code}|${JSON.stringify(w.params)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          code: w.code,
          severity: 'warning',
          source: 'compatibility',
          messageKey: w.messageKey,
          message: w.message,
          params: w.params,
        });
      }
    }
    return out;
  }

  /** รถ/คนขับคนเดียวกันมีเที่ยวอื่นที่ยังไม่จบในวันเดียวกัน (ช่วงวิ่งทับกันเมื่อมีทั้งสองฝั่ง) — เตือน ไม่บล็อก (docs/04 D2) */
  private async overlapWarnings(
    tx: Tx,
    trip: TripRecord,
    kind: 'vehicle' | 'driver',
  ): Promise<TripWarning[]> {
    const who =
      kind === 'vehicle'
        ? { vehicleId: trip.vehicleId! }
        : { OR: [{ driverId: trip.driverId! }, { reliefDriverId: trip.driverId! }] };
    const others = await tx.trip.findMany({
      where: {
        id: { not: trip.id },
        status: { in: [...TRIP_OPEN_STATUSES] },
        AND: [
          who,
          {
            OR: [
              { tripDate: trip.tripDate },
              ...(trip.plannedStartAt && trip.plannedEndAt
                ? [
                    {
                      plannedStartAt: { lt: trip.plannedEndAt },
                      plannedEndAt: { gt: trip.plannedStartAt },
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      select: { tripNo: true, tripDate: true, plannedStartAt: true, plannedEndAt: true },
      orderBy: { tripNo: 'asc' },
    });
    // ทั้งสองเที่ยวมีช่วงวิ่ง → เทียบช่วงเวลา (ข้ามวันได้) · ไม่มี → วันเดียวกัน = ซ้อน
    const overlaps = others.filter((o) => {
      if (!trip.plannedStartAt || !trip.plannedEndAt || !o.plannedStartAt || !o.plannedEndAt)
        return o.tripDate.getTime() === trip.tripDate.getTime();
      return o.plannedStartAt < trip.plannedEndAt && trip.plannedStartAt < o.plannedEndAt;
    });
    if (!overlaps.length) return [];
    const nos = overlaps.map((o) => o.tripNo!).join(', ');
    return [
      {
        code: `${kind}_overlap`,
        severity: 'warning',
        source: 'schedule',
        messageKey: kind === 'vehicle' ? 'trip.vehicleOverlap' : 'trip.driverOverlap',
        message:
          kind === 'vehicle'
            ? `รถ ${trip.vehiclePlateSnapshot} มีเที่ยวอื่นในช่วงเวลาเดียวกัน: ${nos}`
            : `คนขับ ${trip.driverNameSnapshot} มีเที่ยวอื่นในช่วงเวลาเดียวกัน: ${nos}`,
        params: { trips: overlaps.map((o) => o.tripNo) },
      },
    ];
  }

  private async history(
    tx: Tx,
    docId: string,
    fromStatus: string,
    toStatus: string,
    event: string,
  ) {
    const ctx = requestContext.require();
    await tx.docStatusHistory.create({
      data: {
        tenantId: ctx.tenantId!,
        docType: ENTITY,
        docId,
        fromStatus,
        toStatus,
        event,
        actorId: ctx.actorId ?? null,
      },
    });
  }

  private async emit(tx: Tx, type: string, t: TripRecord, previous: Record<string, unknown>) {
    const ctx = requestContext.require();
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type,
        entityType: ENTITY,
        localId: t.id,
        snapshot: JSON.parse(JSON.stringify(eventView(t))) as Prisma.InputJsonValue,
        previousAttributes: previous as Prisma.InputJsonValue,
        requestId: ctx.requestId ?? null,
        actorId: ctx.actorId ?? null,
      },
    });
  }
}

const CLEAR_OFFER = {
  carrierId: null,
  carrierNameSnapshot: null,
  assignmentStatus: null,
  assignmentExpiresAt: null,
  offeredAt: null,
  offeredBy: null,
} as const;

const CLEAR_VEHICLE = {
  driverId: null,
  driverNameSnapshot: null,
  driverPhoneSnapshot: null,
  reliefDriverId: null,
  reliefDriverNameSnapshot: null,
  reliefDriverPhoneSnapshot: null,
  vehicleId: null,
  vehiclePlateSnapshot: null,
  vehicleTypeId: null,
  vehicleTypeSnapshot: null,
  trailerId: null,
  trailerPlateSnapshot: null,
} as const;

function view(t: TripRecord) {
  return {
    tripNo: t.tripNo,
    status: t.status,
    vehiclePlate: t.vehiclePlateSnapshot,
    vehicleType: t.vehicleTypeSnapshot,
    trailerPlate: t.trailerPlateSnapshot,
    driver: t.driverNameSnapshot,
    reliefDriver: t.reliefDriverNameSnapshot,
    carrier: t.carrierNameSnapshot,
    deliveryOrders: t.deliveryOrders.map((d) => d.doNo),
  };
}

/** payload ของ domain event เที่ยว (ไม่มีราคา/เบอร์โทร) */
function eventView(t: TripRecord) {
  return {
    id: t.id,
    tripNo: t.tripNo,
    tripDate: t.tripDate.toISOString().slice(0, 10),
    status: t.status,
    vehicleId: t.vehicleId,
    vehiclePlate: t.vehiclePlateSnapshot,
    vehicleTypeId: t.vehicleTypeId,
    driverId: t.driverId,
    carrierId: t.carrierId,
    assignmentStatus: t.assignmentStatus,
    stops: t.stops.map((s: TripStop) => ({
      id: s.id,
      sequence: s.sequence,
      type: s.type,
      siteId: s.siteId,
    })),
    deliveryOrderIds: t.deliveryOrders.map((d) => d.id),
  };
}
