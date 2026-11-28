import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Trip, TripStop, TripStatus as DbTripStatus } from '@prisma/client';
import {
  STOP_TERMINAL_STATUSES,
  InvalidTransitionError,
  backwardStops,
  stopOrderViolations,
  TRIP_OPEN_STATUSES,
  TRIP_UNSENT_STATUSES,
  TRIP_SENT_STATUSES,
  daySendState,
  TRIP_TRANSITIONS,
  isTripEditable,
  checkDrivingHours,
  checkLoad,
  drivingDays,
  leaveDaysIn,
  pendingRules,
  reconcileOverrides,
  planStops,
  ruleKey,
  RULE_OVERRIDE_SCOPE,
  RULE_REASON_MIN_LENGTH,
  type RuleOverride,
  type TripDoInput,
  type TripEvent,
  type TripStatus,
  shiftWindowToDay,
  OPS_TRIP_AWAITING_CARRIER,
  OPS_TRIP_RUNNING,
  TRIP_NOT_CANCELLED,
  TRIP_TAB_DONE,
  TRIP_TAB_IN_TRANSIT,
  TRIP_TAB_PLANNING,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { likeEscape } from '../../common/ilike';
import { redactPrices } from '../../common/price-fields';
import { toTripDto } from './trip-dto';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { keysetArgs, type ListQuery } from '../../common/pagination';
import { TripSheetLinks } from '../trip-sheets/sheet-links';
import { DbService, type Tx } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { AssignabilityService } from '../assignability/assignability.service';
import { CompatibilityService } from '../compatibility/compatibility.service';
import {
  DeliveryOrderService,
  type DeliveryOrderRecord,
} from '../delivery-orders/delivery-order.service';
import { cleanLine } from '../master/master-kit';
import { bangkokToday } from '../vehicle-documents/expiry';
import { OrderStateService } from '../orders/order-state.service';
import { issueNumber } from '../sequences/sequences.service';
import { reverseCarrierFees } from './carrier-fees';
import {
  allocateTripCost,
  costAllocations,
  costLines,
  costReadiness,
  tripCostingEnabled,
} from './trip-costs';
import { Clock } from '../../common/clock';
import { EntitlementService } from '../entitlements/entitlement.service';
import { bangkokPeriod } from '../usage/active-vehicles';
import { vehicleQuotaMessageTh } from './rule-messages';
import { OfferLinks, OFFER_TTL_MS } from './offer-links';
import { refreshTripLegs } from './trip-legs';
import {
  driverOnLeaveMessageTh,
  loadMessageTh,
  vehicleNotReadyMessageTh,
  vehicleOverlapMessageTh,
} from './rule-messages';

export const TRIP_INCLUDE = {
  stops: {
    where: { removedAt: null },
    orderBy: { sequence: 'asc' },
    include: { site: { select: { name: true } } },
  },
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
      weightKg: true,
    },
  },
  // ST3-T22 การจ้างรถร่วมที่ใช้งานอยู่ (รอตอบ/รับแล้ว — มีได้ครั้งละ 1: unique partial index)
  subconOffers: {
    where: { status: { in: ['OFFERED', 'ACCEPTED'] } },
    orderBy: { offeredAt: 'desc' },
    take: 1,
  },
} as const satisfies Prisma.TripInclude;

export type TripRecord = Prisma.TripGetPayload<{ include: typeof TRIP_INCLUDE }>;

const REDELIVERY_SELECT = {
  id: true,
  doNo: true,
  doDate: true,
  status: true,
  rescheduleCount: true,
  rescheduleExhausted: true,
  redeliveryManual: true,
} as const satisfies Prisma.DeliveryOrderSelect;

export interface TripRescheduled {
  id: string;
  doNo: string | null;
  tripStopId: string | null;
  pickupTripStopId: string | null;
  pickupTripStop: { status: string } | null;
  redeliveries: {
    id: string;
    doNo: string | null;
    doDate: Date;
    status: string;
    rescheduleCount: number;
    rescheduleExhausted: boolean;
    /** ST4-T11 ส่งซ้ำมือ */
    redeliveryManual: boolean;
  }[];
}

export interface TripWarning {
  code: string;
  /** block = กฎเอกสาร (D-07) ต้องยกเว้นโดย `trips:override` · warning = ต้องยืนยันพร้อมเหตุผลก่อนปล่อยรถ · info = แจ้งเฉย ๆ */
  severity: 'warning' | 'block' | 'info';
  source: 'compatibility' | 'assignability' | 'schedule' | 'stops' | 'assignment' | 'load';
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
  /** หน้า `/trips` — ค้นแบบมีคำนี้ (ไม่สนตัวพิมพ์) */
  tripNo?: string;
  vehiclePlate?: string;
  driverName?: string;
  ownership?: 'OWN' | 'SUBCON';
  /** ค้นชื่อสถานที่ของจุดแวะ */
  route?: string;
}

const has = (v: string) => ({ contains: likeEscape(v.trim()), mode: 'insensitive' as const });

/**
 * ตัวกรองของรายการเที่ยว — ใช้ร่วมกับตัวนับ (`summary`) เพื่อให้ตัวเลขบน dashboard = จำนวนแถวของรายการ (ST9-T01)
 */
export function tripWhere(q: Omit<TripFilter, keyof ListQuery>): Prisma.TripWhereInput {
  return {
    AND: [
      q.statuses?.length ? { status: { in: q.statuses as DbTripStatus[] } } : {},
      q.dateFrom ? { tripDate: { gte: new Date(`${q.dateFrom}T00:00:00Z`) } } : {},
      q.dateTo ? { tripDate: { lte: new Date(`${q.dateTo}T00:00:00Z`) } } : {},
      q.vehicleId ? { vehicleId: q.vehicleId } : {},
      q.driverId ? { OR: [{ driverId: q.driverId }, { reliefDriverId: q.driverId }] } : {},
      q.carrierId ? { carrierId: q.carrierId } : {},
      q.tripNo?.trim() ? { tripNo: has(q.tripNo) } : {},
      q.vehiclePlate?.trim()
        ? {
            OR: [
              { vehiclePlateSnapshot: has(q.vehiclePlate) },
              { vehicle: { is: { plate: has(q.vehiclePlate) } } },
              { trailerPlateSnapshot: has(q.vehiclePlate) },
              { vehicleTypeSnapshot: has(q.vehiclePlate) },
            ],
          }
        : {},
      q.driverName?.trim()
        ? {
            OR: [
              { driverNameSnapshot: has(q.driverName) },
              { reliefDriverNameSnapshot: has(q.driverName) },
              { carrierNameSnapshot: has(q.driverName) },
            ],
          }
        : {},
      q.ownership === 'OWN' ? { carrierId: null } : {},
      q.ownership === 'SUBCON' ? { carrierId: { not: null } } : {},
      q.route?.trim() ? { stops: { some: { site: { is: { name: has(q.route) } } } } } : {},
    ],
  };
}

/**
 * ST3-T14 (D-07 + PO 17 พ.ย. 2569): ยกเว้นบล็อก/ยืนยันคำเตือน **เฉพาะกฎที่ผู้ใช้เห็น** — `ruleKeys` = กุญแจของกฎที่ค้าง
 * (`warnings[].key` / extension `blocks[].key` ของ 409) + เหตุผล ≥ 10 ตัว · `canOverride` = ผู้เรียกมี `trips:override`
 */
export interface RuleConfirmInput {
  ruleKeys?: string[];
  reason?: string | null;
  canOverride?: boolean;
}

export interface CreateTripInput {
  rules?: RuleConfirmInput;
  tripDate: string;
  deliveryOrderIds: string[];
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  /** รถที่วางแผนไว้ (กระดาน ST3-T12) — ยังไม่ใช่การจัดรถ */
  vehicleId?: string | null;
}

/** ย้าย/ปรับเวลาเที่ยวบนกระดาน (ST3-T12) — `undefined` = คงค่าเดิม */
export interface ScheduleInput {
  rules?: RuleConfirmInput;
  tripDate?: string;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  vehicleId?: string | null;
}

/** ผลต่อรายการของ bulk (ST3-T17) — `UNCHANGED` = จัดรถแล้วอยู่ก่อน ไม่ได้ทำอะไร (review L3) */
export interface BulkOutcome {
  trip: TripRecord | null;
  outcome: 'ASSIGNED' | 'DISPATCHED' | 'UNCHANGED' | 'FAILED';
  error: unknown;
}

export interface AssignInput {
  rules?: RuleConfirmInput;
  vehicleId: string;
  driverId?: string | null;
  reliefDriverId?: string | null;
  trailerId?: string | null;
}

/**
 * ส่วนจ้างรถร่วมของ `/offer` (ST3-T22) — เรียกหลังล็อกเที่ยว + ตรวจรถร่วมแล้ว ก่อนเปลี่ยนสถานะ:
 * เขียน `subcon_offer` + `trip_cost` เอง แล้วคืนช่องของเที่ยวที่ต้องเขียนพร้อม transition + ข้อมูลลง audit
 */
export type OfferHireHook = (
  tx: Tx,
  trip: TripRecord,
  carrier: { id: string; code: string; legalName: string },
  /** เวลาเสนอ (ใช้ตั้งเวลาหมดอายุของข้อเสนอ/ลิงก์ให้ตรงกับเที่ยว — ST3-T23) */
  at: Date,
) => Promise<{
  trip: Prisma.TripUncheckedUpdateManyInput;
  audit: Record<string, unknown>;
  reason?: string;
}>;

const ENTITY = 'trip';
/** Send all ทั้งวันสูงสุดต่อคำขอ (≥ รถ 200 คัน × 1–2 เที่ยว — PLN-051) */
export const SEND_ALL_MAX = 400;
const EVENT_TYPE: Partial<Record<TripEvent, string>> = {
  offer: 'trip.offered',
  accept: 'trip.assigned',
  reject: 'trip.offer_rejected',
  expire: 'trip.offer_expired',
  withdraw: 'trip.offer_withdrawn',
  cancel_hire: 'trip.hire_cancelled',
  assign: 'trip.assigned',
  reassign: 'trip.assigned',
  dispatch: 'trip.dispatched',
  start: 'trip.started',
  complete: 'trip.completed',
  cost: 'trip.costed',
  settle: 'trip.settled',
  cancel: 'trip.cancelled',
};

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
 * - กฎตอนจัด (ST3-T14 — D-07 PO 16 พ.ย. 2569): ผลตรวจเก็บใน `rule_warnings` (คืนใน `warnings`) ·
 *   **บล็อก** (กฎเอกสาร/ใบขับขี่) → create(+รถ)/schedule/assign/dispatch ตอบ 409 `assignment_blocked` เว้นแต่ส่งกุญแจ
 *   ของบล็อกนั้นใน `ruleKeys` + เหตุผล โดยผู้มี `trips:override` · **คำเตือน** → บันทึกได้ (ค้าง "รอยืนยัน") แต่ต้องยืนยัน
 *   พร้อมเหตุผลก่อนปล่อยรถ (`ruleKeys` ในคำขอ หรือ `/confirm-rules`; dispatch ที่ยังค้าง → 409 `assignment_warnings`)
 *   การยกเว้นหมดผลเมื่อข้อเท็จจริงเปลี่ยน/แย่ลง (`reconcileOverrides` ทุกครั้งที่ตรวจใหม่)
 *   การยกเว้น/ยืนยันเก็บใน `rule_overrides` (append-only) + audit `trip.rules_overridden`
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
    private readonly sheetLinks: TripSheetLinks,
    private readonly offerLinks: OfferLinks,
    /** ST3-T24 (review L1): เวลาข้อเสนองานรถร่วม (เสนอ/หมดเวลา/ตอบ) อ่านจาก Clock ทั้งหมด — test เลื่อนเวลาได้ */
    private readonly clock: Clock,
    /** P1-ST1-T08 เพดานรถ active (soft limit — PLT-080) */
    private readonly entitlements: EntitlementService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // อ่าน

  /**
   * ST9-T01 ตัวนับของ dashboard ปฏิบัติการ — นับด้วยตัวกรองชุดเดียวกับ `GET /trips?status=` (`tripWhere`)
   * ตัวเลขจึงเท่ากับจำนวนแถวของรายการเมื่อคลิกเข้าไปดูเสมอ (RPT-001/RPT-005) · RLS จำกัด tenant
   */
  async summary(tx: Tx = this.db.tx) {
    const n = (f: Omit<TripFilter, keyof ListQuery>) => tx.trip.count({ where: tripWhere(f) });
    const [running, offered, planning, inTransit, done, subcon, total] = await Promise.all([
      n({ statuses: [...OPS_TRIP_RUNNING] }),
      n({ statuses: [...OPS_TRIP_AWAITING_CARRIER] }),
      // ชุดสถานะเดียวกับ `@tms/domain` ops-lists (ตัวกรอง `status` ของรายการ)
      n({ statuses: [...TRIP_TAB_PLANNING] }),
      n({ statuses: [...TRIP_TAB_IN_TRANSIT] }),
      n({ statuses: [...TRIP_TAB_DONE] }),
      n({ statuses: [...TRIP_NOT_CANCELLED], ownership: 'SUBCON' }),
      tx.trip.count(),
    ]);
    return { running, offered, planning, inTransit, done, subcon, total };
  }

  /**
   * ยอดเงินต่อเที่ยวของรายการ (`sellAmount` / `buyTotal`) — aggregate ต่อหน้า
   * รายได้ = Σ บรรทัดรายได้ ACTIVE ของ DO ในเที่ยว (ไม่นับ DO ยกเลิก) · ค่าเที่ยว = Σ trip_cost CONFIRMED (รวมกลับรายการ = buyTotal)
   * ตัดตามสิทธิ์ราคาที่ serializer (`sellAmount` / `buyTotal` เป็น PriceField)
   */
  async listAmounts(
    tripIds: string[],
    tx: Tx = this.db.tx,
  ): Promise<Map<string, { sellAmount: string; buyTotal: string }>> {
    const out = new Map<string, { sellAmount: string; buyTotal: string }>();
    if (!tripIds.length) return out;
    const [dos, costs] = await Promise.all([
      tx.deliveryOrder.findMany({
        where: { tripId: { in: tripIds }, status: { not: 'CANCELLED' } },
        select: { id: true, tripId: true },
      }),
      tx.tripCost.groupBy({
        by: ['tripId'],
        where: { tripId: { in: tripIds }, status: 'CONFIRMED' },
        _sum: { amount: true },
      }),
    ]);
    const rev = dos.length
      ? await tx.revenueLine.groupBy({
          by: ['deliveryOrderId'],
          where: { deliveryOrderId: { in: dos.map((d) => d.id) }, status: 'ACTIVE' },
          _sum: { amount: true },
        })
      : [];
    const zero = new Prisma.Decimal(0);
    const revByDo = new Map(rev.map((r) => [r.deliveryOrderId!, r._sum.amount ?? zero]));
    const sell = new Map<string, Prisma.Decimal>();
    for (const d of dos)
      sell.set(d.tripId!, (sell.get(d.tripId!) ?? zero).add(revByDo.get(d.id) ?? zero));
    const buy = new Map(costs.map((c) => [c.tripId, c._sum.amount ?? zero]));
    for (const id of tripIds)
      out.set(id, {
        sellAmount: (sell.get(id) ?? zero).toFixed(2),
        buyTotal: (buy.get(id) ?? zero).toFixed(2),
      });
    return out;
  }

  async list(q: TripFilter, tx: Tx = this.db.tx) {
    const k = keysetArgs(q);
    const where: Prisma.TripWhereInput = { AND: [k.where as Prisma.TripWhereInput, tripWhere(q)] };
    const rows = await tx.trip.findMany({
      where,
      include: TRIP_INCLUDE,
      orderBy: [...k.orderBy],
      take: k.take,
    });
    return { rows, k };
  }

  /**
   * ST4-T12 DO ของเที่ยวที่ส่งไม่สำเร็จแล้วนัดส่งใหม่ (ใบเดิม CANCELLED event redeliver) + ใบใหม่ — อ่านเฉพาะ GET เที่ยว
   * (ไม่อยู่ใน TRIP_INCLUDE — review L) · ไม่นับใบใหม่ที่ถูกแยกต่อ (นับลูกแทน)
   */
  rescheduled(tripId: string, tx: Tx = this.db.tx): Promise<TripRescheduled[]> {
    return tx.deliveryOrder.findMany({
      where: { tripId, status: 'CANCELLED', redeliveries: { some: {} } },
      orderBy: [{ doNo: 'asc' }],
      select: {
        id: true,
        doNo: true,
        tripStopId: true,
        pickupTripStopId: true,
        pickupTripStop: { select: { status: true } },
        redeliveries: {
          where: { NOT: { status: 'CANCELLED', splitChildren: { some: {} } } },
          orderBy: [{ createdAt: 'asc' }, { doNo: 'asc' }],
          select: REDELIVERY_SELECT,
        },
      },
    });
  }

  /**
   * ST4-T11 DO ของเที่ยวที่ส่งแล้ว (ใบเดิมคงอยู่) ซึ่งของที่ลูกค้าปฏิเสธรับถูกส่งซ้ำเป็น DO ใหม่ — แสดงในไทม์ไลน์ใต้จุดส่ง
   * ("ส่งซ้ำ: เดิม → ใหม่") · ไม่นับใบที่ถูกแยกต่อ (นับลูกแทน)
   */
  async rejectedRedelivered(tripId: string, tx: Tx = this.db.tx): Promise<TripRescheduled[]> {
    const rows = await tx.deliveryOrder.findMany({
      where: { tripId, status: { not: 'CANCELLED' }, rejectedRedeliveries: { some: {} } },
      orderBy: [{ doNo: 'asc' }],
      select: {
        id: true,
        doNo: true,
        tripStopId: true,
        rejectedRedeliveries: {
          where: { NOT: { status: 'CANCELLED', splitChildren: { some: {} } } },
          orderBy: [{ createdAt: 'asc' }, { doNo: 'asc' }],
          select: REDELIVERY_SELECT,
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      doNo: r.doNo,
      tripStopId: r.tripStopId,
      pickupTripStopId: null,
      pickupTripStop: null,
      redeliveries: r.rejectedRedeliveries,
    }));
  }

  /**
   * `data.object` ของ webhook `trip.*` (ST7-T06 — QA): รูปเดียวกับ `GET /v1/trips/{id}` (toTripDto ตัวเดียวกัน)
   * ตัดราคาซื้อทุก field (`redactPrices` ไม่มีสิทธิ์ราคา — webhook ระดับ tenant)
   */
  async eventObject(id: string, tx: Tx = this.db.tx): Promise<Record<string, unknown>> {
    const t = await this.get(id, tx);
    return JSON.parse(
      JSON.stringify(
        redactPrices(
          toTripDto(t, await this.rescheduled(id, tx), await this.rejectedRedelivered(id, tx)),
          [],
        ),
      ),
    ) as Record<string, unknown>;
  }

  async get(id: string, tx: Tx = this.db.tx): Promise<TripRecord> {
    const t = await tx.trip.findUnique({ where: { id }, include: TRIP_INCLUDE });
    if (!t) throw new ProblemException('not_found');
    return t;
  }

  // ---------------------------------------------------------------------------------------------
  // สร้าง / เพิ่ม-ถอด DO

  /**
   * สร้างเที่ยว PLANNING จาก DO (≥ 1) — จุดแวะจาก DO
   * `vehicleId` (ST3-T12 กระดาน: ลาก SO ลงแถวรถ) = **รถที่วางแผนไว้** — snapshot เฉพาะรถ/ประเภทรถ (ทางเดียวกับ /assign:
   * `vehicleSnapshot` + ล็อกรถ) สถานะยังเป็น PLANNING · ไม่มีคนขับ/หาง/รถร่วม/DO ยังเป็น DRAFT — ผูกรถ+คนขับจริงที่ /assign
   * (→ ASSIGNED, ปุ่ม Assign = ST3-T17) · รถร่วมยังต้องผ่าน /offer (ล้างรถที่วางไว้) — [OPEN] spec/12 §3
   */
  async create(input: CreateTripInput, tx: Tx = this.db.tx): Promise<TripRecord> {
    const tenantId = this.tenantId();
    const reason = this.ruleReason(input.rules);
    const window = this.window(input.tripDate, input.plannedStartAt, input.plannedEndAt);
    const dos = await this.dos.lockForTrip(tx, input.deliveryOrderIds);
    let vehicle = {};
    if (input.vehicleId) {
      vehicle = await this.plannedVehicle(tx, input.vehicleId);
      await this.lockVehicle(tx, input.vehicleId);
    }
    const trip = await tx.trip.create({
      data: {
        tenantId,
        tripNo: await issueNumber(tx, tenantId, { docType: 'TRIP' }),
        tripDate: new Date(`${input.tripDate}T00:00:00Z`),
        plannedStartAt: window.start,
        plannedEndAt: window.end,
        status: 'PLANNING',
        ...vehicle,
      },
    });
    await this.history(tx, trip.id, 'NONE', 'PLANNING', 'create');
    const stops = await this.replanStops(tx, trip, dos, { attach: dos, plan: false });
    await this.orderState.syncFromDeliveryOrders(
      tx,
      dos.map((d) => d.salesOrderId),
    );
    let final = await this.refreshWarnings(tx, trip.id, stops.windowConflicts);
    if (input.vehicleId) final = await this.enforceRules(tx, final, input.rules, reason, 'entry');
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

  /**
   * เรียงจุดแวะเอง (ST3-T16 Multi-drop; docs/04 D2, spec/03 PLN-003) — PLANNING/ASSIGNED เท่านั้น
   * - `stopIds` = id ของจุดที่ยังใช้ **ครบทุกจุด** ตามลำดับใหม่ (ขาด/เกิน/ซ้ำ → 422 `stop_set_mismatch`)
   * - จุดส่งของ DO อยู่ก่อน (หรือที่เดียวกับ) จุดรับของ DO เดียวกัน → 422 `stop_order_invalid` + `violations[]` (บล็อก)
   * - ลำดับเท่าเดิม = ไม่เปลี่ยน version · เปลี่ยน → คำนวณระยะ/เวลาช่วงวิ่งใหม่ + ตรวจกฎใหม่ (ST3-T14 —
   *   คำเตือนลำดับเวลา `stop_sequence_window_order` ฯลฯ; การยืนยันที่ข้อเท็จจริงเปลี่ยนหมดผล) + audit `trip.stops_reordered`
   */
  async reorderStops(
    id: string,
    stopIds: string[],
    tx: Tx = this.db.tx,
    expectedVersion?: number,
  ): Promise<TripRecord> {
    const { trip } = await this.lock(tx, id, expectedVersion);
    this.assertEditable(trip);
    const current = trip.stops.map((st) => st.id);
    const known = new Set(current);
    if (
      stopIds.length !== current.length ||
      new Set(stopIds).size !== stopIds.length ||
      stopIds.some((x) => !known.has(x))
    )
      throw field422(
        'stopIds',
        'stop_set_mismatch',
        'must list every active stop of this trip exactly once',
      );
    if (stopIds.every((x, i) => x === current[i])) return trip;
    const violations = stopOrderViolations(
      stopIds,
      trip.deliveryOrders.map((d) => ({
        id: d.id,
        pickupStopId: d.pickupTripStopId,
        dropStopId: d.tripStopId,
      })),
    );
    if (violations.length) {
      const doNo = (x: string) => trip.deliveryOrders.find((d) => d.id === x)?.doNo ?? x;
      const first = violations[0]!;
      throw new ProblemException(
        'stop_order_invalid',
        `ใบส่งของ ${doNo(first.deliveryOrderId)}: จุดส่ง (ลำดับ ${first.dropSequence}) อยู่ก่อนจุดรับ (ลำดับ ${first.pickupSequence}) — ต้องรับของก่อนส่ง`,
        violations.map((v) => ({
          field: 'stopIds',
          code: 'delivery_before_pickup',
          message: `${doNo(v.deliveryOrderId)}: drop stop ${v.dropSequence} is not after pickup stop ${v.pickupSequence}`,
        })),
        {
          violations: violations.map((v) => ({
            deliveryOrderId: encodeId('deliveryOrder', v.deliveryOrderId),
            doNo: doNo(v.deliveryOrderId),
            pickupStopId: encodeId('tripStop', v.pickupStopId),
            dropStopId: encodeId('tripStop', v.dropStopId),
            pickupSequence: v.pickupSequence,
            dropSequence: v.dropSequence,
          })),
        },
      );
    }
    // คำเตือนช่วงเวลาของจุด (ผูกกับตำแหน่ง) → ย้ายตามจุดไปตำแหน่งใหม่
    const conflicts = ((trip.ruleWarnings as unknown as TripWarning[]) ?? [])
      .filter((w) => w.code === 'stop_window_conflict')
      .map((w) => current[Number(w.params.sequence) - 1])
      .filter((x): x is string => !!x)
      .map((x) => stopIds.indexOf(x));
    const before = stopsView(trip);
    await tx.tripStop.updateMany({
      where: { tripId: trip.id, removedAt: null },
      data: { sequence: { increment: 100000 } },
    });
    for (const [i, sid] of stopIds.entries())
      await tx.tripStop.update({ where: { id: sid }, data: { sequence: i + 1 } });
    await this.refreshLegs(tx, trip.id);
    await this.bump(tx, trip);
    const final = await this.refreshWarnings(tx, trip.id, conflicts, false);
    await this.emit(tx, 'trip.updated', final, { stops: before });
    await this.audit.record({
      action: `${ENTITY}.stops_reordered`,
      entityType: ENTITY,
      entityId: trip.id,
      before: { stops: before },
      after: { stops: stopsView(final) },
    });
    return final;
  }

  /**
   * ย้าย/ปรับขนาดเที่ยวบนกระดาน (ST3-T12; spec/03 PLN-040): วันเที่ยว + ช่วงวิ่งตามแผน + รถที่วางไว้
   * - PLANNING: เปลี่ยน/ถอดรถที่วางไว้ได้ (snapshot รถ + ล็อกรถ)
   * - ASSIGNED (ST3-T17 — แทนการบล็อกของ T12): เปลี่ยนรถ = **จัดรถใหม่ในคำขอเดียวกัน** (reassign ตาม docs/01 §4.2 —
   *   snapshot รถใหม่ + คนขับประจำของรถใหม่ ณ ตอนนี้ (มีคนเดียว; รถบริษัทไม่มีคนขับประจำ → 422 `driverId`) ·
   *   คนขับสำรองคงเดิม (ถ้าไม่ใช่คนเดียวกับคนขับใหม่) · หางล้าง (ผูกกับหัวลากเดิม) · ตรวจกฎตอนจัดของรถ/คนขับใหม่ทั้งชุด)
   *   ถอดรถของเที่ยว ASSIGNED (vehicleId null) → 409 `invalid_state_transition` (event `unassign` — docs/01 §4.2 ไม่มี)
   * - ซ้อนเวลา = คำเตือน `vehicle_overlap` ใน `warnings` (ไม่บล็อก — docs/04 D2) · ค่าเท่าเดิม = ไม่เปลี่ยน version
   */
  async schedule(
    id: string,
    input: ScheduleInput,
    tx: Tx = this.db.tx,
    expectedVersion?: number,
  ): Promise<TripRecord> {
    const reason = this.ruleReason(input.rules);
    const { trip, dos } = await this.lock(tx, id, expectedVersion);
    this.assertEditable(trip);
    const tripDate = input.tripDate ?? trip.tripDate.toISOString().slice(0, 10);
    const keep = (v: string | null | undefined, cur: Date | null) =>
      v === undefined ? (cur?.toISOString() ?? null) : v;
    const window = this.window(
      tripDate,
      keep(input.plannedStartAt, trip.plannedStartAt),
      keep(input.plannedEndAt, trip.plannedEndAt),
    );
    const vehicleChange = input.vehicleId !== undefined && input.vehicleId !== trip.vehicleId;
    const reassign = vehicleChange && trip.status === 'ASSIGNED';
    if (reassign && !input.vehicleId)
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        from: trip.status,
        event: 'unassign',
      });
    if (vehicleChange && !reassign && trip.status !== 'PLANNING')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        from: trip.status,
        event: 'schedule_vehicle',
      });
    let vehicle: Prisma.TripUncheckedUpdateManyInput = {};
    if (vehicleChange && !reassign && input.vehicleId) {
      vehicle = await this.plannedVehicle(tx, input.vehicleId);
      await this.lockVehicle(tx, input.vehicleId);
    } else if (vehicleChange && !reassign)
      vehicle = {
        vehicleId: null,
        vehiclePlateSnapshot: null,
        vehicleTypeId: null,
        vehicleTypeSnapshot: null,
      };
    const same = (a: Date | null, b: Date | null) =>
      (a?.getTime() ?? null) === (b?.getTime() ?? null);
    const dateChange = tripDate !== trip.tripDate.toISOString().slice(0, 10);
    const timeChange =
      dateChange ||
      !same(window.start, trip.plannedStartAt) ||
      !same(window.end, trip.plannedEndAt);
    if (!vehicleChange && !timeChange) return trip;
    const before = schedView(trip);
    if (timeChange || !reassign) {
      const r = await tx.trip.updateMany({
        where: { id: trip.id, version: trip.version },
        data: {
          tripDate: new Date(`${tripDate}T00:00:00Z`),
          plannedStartAt: window.start,
          plannedEndAt: window.end,
          ...vehicle,
          version: { increment: 1 },
        },
      });
      if (r.count === 0) throw new ProblemException('concurrent_update');
    }
    let final: TripRecord;
    if (reassign) {
      // ช่วงเวลาใหม่มีผลก่อน → ตรวจกฎ (ซ้อนเวลา/เอกสารตามช่วงวิ่ง) ของรถใหม่ด้วยช่วงใหม่
      const cur = await this.get(trip.id, tx);
      const crew = await this.crewFor(tx, cur, input.vehicleId!);
      final = await this.assignLocked(
        tx,
        cur,
        dos,
        {
          vehicleId: input.vehicleId!,
          driverId: crew.driverId,
          reliefDriverId: crew.reliefDriverId,
          trailerId: null,
          rules: input.rules,
        },
        reason,
        'entry',
      );
    } else {
      final = await this.refreshWarnings(tx, trip.id);
      if (final.vehicleId) final = await this.enforceRules(tx, final, input.rules, reason, 'entry');
    }
    final = await this.oneBump(tx, final, trip.version);
    await this.emit(tx, 'trip.updated', final, before);
    await this.audit.record({
      action: `${ENTITY}.rescheduled`,
      entityType: ENTITY,
      entityId: trip.id,
      before,
      after: schedView(final),
    });
    return final;
  }

  /**
   * คนขับของเที่ยว ASSIGNED ที่ย้ายไปรถอื่น (ST3-T17 review M1): **คงคนขับ/คนขับสำรองเดิม** ถ้ายังผ่านกฎใบขับขี่ของรถใหม่
   * (บล็อก `DRIVER_*` ของ ST2-T20/ST3-T14 — ลา/ซ้อนเวลา/ชั่วโมงขับไม่ขึ้นกับรถ จึงคงไว้และตรวจตามปกติ) ·
   * ไม่ผ่าน → คนขับประจำของรถใหม่ (ACTIVE คนเดียว) · ไม่มีทั้งคู่ → 422 `driverId` พร้อมข้อความไทย
   */
  private async crewFor(tx: Tx, trip: TripRecord, vehicleId: string) {
    const { hazmat } = await this.compatWarnings(tx, trip);
    const points = [trip.tripDate, trip.plannedStartAt, trip.plannedEndAt].filter(
      (d): d is Date => d !== null,
    );
    const window = {
      from: new Date(Math.min(...points.map((d) => d.getTime()))),
      to: new Date(Math.max(...points.map((d) => d.getTime()))),
    };
    const fits = async (driverId: string | null) => {
      if (!driverId) return false;
      const d = await tx.driver.findFirst({
        where: { id: driverId, deletedAt: null, status: { not: 'INACTIVE' } },
        select: { id: true },
      });
      if (!d) return false;
      const a = await this.assignability.isAssignable({ vehicleId, driverId, window, hazmat }, tx);
      return !a.blocks.some((b) => b.code.startsWith('DRIVER_'));
    };
    const keep = await fits(trip.driverId);
    const driverId = keep ? trip.driverId! : await this.defaultDriverOf(tx, vehicleId);
    if (!driverId)
      throw new ProblemException(
        'validation_failed',
        trip.driverNameSnapshot
          ? `คนขับ ${trip.driverNameSnapshot} ใช้กับรถคันนี้ไม่ได้ (ใบขับขี่) และรถไม่มีคนขับประจำ — เปิดเที่ยวเพื่อเลือกคนขับ`
          : 'รถคันนี้ไม่มีคนขับประจำ — เปิดเที่ยวเพื่อเลือกคนขับ',
        [{ field: 'driverId', code: 'required', message: 'no eligible driver for this vehicle' }],
      );
    const relief =
      trip.reliefDriverId && trip.reliefDriverId !== driverId && (await fits(trip.reliefDriverId))
        ? trip.reliefDriverId
        : null;
    return { driverId, reliefDriverId: relief, kept: keep };
  }

  /**
   * 1 คำขอ = version +1 (QA ST3-T17 L): ขั้นย่อยในคำขอเดียว (เวลา/จัดรถ/ตรวจกฎ/ยกเว้น/ปล่อย) ขยับ version หลายครั้ง —
   * แถวเที่ยวถูกล็อก FOR UPDATE ทั้งคำขอ จึงตั้งเป็น `from + 1` ได้ปลอดภัย
   */
  private async oneBump(tx: Tx, t: TripRecord, from: number): Promise<TripRecord> {
    if (t.version <= from + 1) return t;
    await tx.trip.updateMany({ where: { id: t.id }, data: { version: from + 1 } });
    return this.get(t.id, tx);
  }

  /** คนขับประจำของรถ ณ ตอนนี้ (ACTIVE คนเดียว — กติกาเดียวกับ /assign ที่ไม่ส่ง driverId) */
  private async defaultDriverOf(tx: Tx, vehicleId: string): Promise<string | null> {
    const ds = await tx.driver.findMany({
      where: { defaultVehicleId: vehicleId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
      take: 2,
    });
    return ds.length === 1 ? ds[0]!.id : null;
  }

  // ---------------------------------------------------------------------------------------------
  // action ตาม state machine

  /**
   * จัดรถ (PLANNING → ASSIGNED / ASSIGNED → ASSIGNED เปลี่ยนรถ/คนขับ / OFFERED → ASSIGNED รถร่วมรับ — ผู้จัดรถบันทึกแทน):
   * snapshot รถ ประเภทรถ (id + ชื่อ — สัญญา ST2-T14) หาง คนขับ คนขับสำรอง รถร่วม · DO DRAFT → PLANNED
   * คนขับไม่ส่ง = คนขับประจำของรถ (มีคนเดียว) — ใช้ค่า **ณ ตอนนี้** แล้วเก็บเป็น snapshot
   * ST3-T17 (docs/04 D2 "Assign vs Dispatch แยกปุ่ม", spec/03 PLN-048): `opts.dispatch` = "จัดรถและปล่อยเที่ยว" ในคำขอเดียว
   * (atomic — ไม่ผ่าน = ไม่จัดรถด้วย) · ตรวจกฎแบบตอนปล่อยรถ (คำเตือนที่ยังไม่ยืนยัน → 409 `assignment_warnings`)
   */
  async assign(
    id: string,
    input: AssignInput,
    tx: Tx = this.db.tx,
    expectedVersion?: number,
    /**
     * `viaOffer` (ST3-T23 ลิงก์ข้อเสนองาน): รับงานของการจ้างนี้เท่านั้น — เที่ยวไม่รอตอบแล้ว/การจ้างที่รอตอบไม่ใช่รายนี้
     * (ตอบไปแล้ว ถูกถอน จ้างใหม่) → 409 `offer_closed` (ตรวจหลังล็อก — สองเครื่องกดพร้อมกัน การกระทำแรกชนะ)
     */
    opts: { dispatch?: boolean; viaOffer?: string } = {},
  ): Promise<TripRecord> {
    const reason = this.ruleReason(input.rules);
    const { trip, dos } = await this.lock(tx, id, expectedVersion);
    if (opts.viaOffer) {
      const o = trip.subconOffers[0];
      // ตรวจหลังล็อก: ข้อเสนอยังรอตอบ + ยังไม่หมดเวลา (server time — review L7)
      if (
        trip.status !== 'OFFERED' ||
        o?.id !== opts.viaOffer ||
        o.status !== 'OFFERED' ||
        (o.expiresAt && o.expiresAt.getTime() <= this.clock.now().getTime())
      )
        throw new ProblemException('offer_closed');
    }
    const assigned = await this.assignLocked(
      tx,
      trip,
      dos,
      input,
      reason,
      opts.dispatch ? 'dispatch' : 'entry',
      opts.viaOffer ? 'LINK' : 'USER',
    );
    const done = opts.dispatch
      ? await this.dispatchLocked(tx, assigned, dos, undefined, null)
      : assigned;
    return this.oneBump(tx, done, trip.version);
  }

  /** ส่วนจัดรถของ `assign` / `schedule` (เปลี่ยนรถของเที่ยว ASSIGNED) — ผู้เรียกล็อกเที่ยว + DO แล้ว */
  private async assignLocked(
    tx: Tx,
    trip: TripRecord,
    dos: DeliveryOrderRecord[],
    input: AssignInput,
    reason: string | null,
    gate: 'entry' | 'dispatch',
    /** ช่องทางที่รถร่วมรับงาน (ST3-T23): LINK = ผ่านลิงก์ · USER = ผู้จัดรถบันทึกแทน */
    via: 'LINK' | 'USER' = 'USER',
  ): Promise<TripRecord> {
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
    // ST3-T22/T23: รถร่วมรับงาน (ผ่านลิงก์ หรือผู้จัดรถบันทึกแทน) → การจ้างที่รอตอบเป็น ACCEPTED + ทะเบียน/คนขับที่รับ
    if (event === 'accept') {
      const cur = await this.get(trip.id, tx);
      const offer = trip.subconOffers[0];
      await tx.subconOffer.updateMany({
        where: { tripId: trip.id, status: 'OFFERED' },
        data: {
          status: 'ACCEPTED',
          respondedAt: this.clock.now(),
          respondedVia: via,
          acceptedPlate: cur.vehiclePlateSnapshot,
          acceptedVehicleId: cur.vehicleId,
          acceptedDriverName: cur.driverNameSnapshot,
          acceptedDriverPhone: cur.driverPhoneSnapshot,
          acceptedDriverId: cur.driverId,
        },
      });
      // ST4-T08: ลิงก์งานของรถร่วม (กดถึง/ออก + POD ST4-T09) — ออกครั้งเดียวตอนรับงาน (ผ่านลิงก์หรือผู้จัดรถบันทึกแทน)
      if (offer)
        await this.offerLinks.issuePod(
          tx,
          { id: offer.id, tenantId: trip.tenantId },
          requestContext.require().actorId ?? null,
        );
      if (offer)
        await this.emitOffer(tx, 'subcon_offer.accepted', {
          id: offer.id,
          tripId: trip.id,
          carrierId: offer.carrierId,
          status: 'ACCEPTED',
          respondedVia: via,
          vehicleId: cur.vehicleId,
          vehiclePlate: cur.vehiclePlateSnapshot,
          driverId: cur.driverId,
        });
    }
    for (const d of await this.reload(tx, dos)) await this.dos.planForTrip(tx, d);
    await this.orderState.syncFromDeliveryOrders(
      tx,
      dos.map((d) => d.salesOrderId),
    );
    let final = await this.refreshWarnings(tx, trip.id);
    final = await this.enforceRules(tx, final, input.rules, reason, gate);
    // เปลี่ยนคนขับ → ลิงก์ใบคุมรถที่ส่งให้คนขับเดิมหมดผล (ST3-T20 review/QA — PDPA)
    if (trip.driverId && final.driverId !== trip.driverId)
      await this.sheetLinks.revokeForTrip(tx, trip.id, 'DRIVER_CHANGED');
    await this.audit.record({
      action: `${ENTITY}.${event === 'reassign' ? 'reassigned' : 'assigned'}`,
      entityType: ENTITY,
      entityId: trip.id,
      before,
      after: view(final),
    });
    return final;
  }

  /**
   * จัดรถ / จัดรถและปล่อยเที่ยว หลายเที่ยว (ST3-T17 bulk — spec/03 PLN-047/048) · **แต่ละรายการแยกกัน** (SAVEPOINT ต่อรายการ:
   * รายการที่ไม่ผ่านย้อนเฉพาะของตัวเอง — ไม่ใช่ all-or-nothing) · error ที่ไม่ใช่ problem (ฐานข้อมูลล่ม ฯลฯ) → ทั้งคำขอล้ม
   * - PLANNING: จัดรถด้วยรถที่วางไว้ + คนขับประจำรถ (`/assign` ไม่ส่ง driverId) — ไม่มีรถ → 422 `vehicleId` required
   * - ASSIGNED: `dispatch` = ปล่อยรถ (`/dispatch`) · ไม่ dispatch = จัดแล้ว ไม่ทำอะไร (`UNCHANGED`, ไม่เปลี่ยน version)
   * - สถานะอื่น → 409 `invalid_state_transition`
   */
  async bulkAssign(
    items: { tripId: string | null; version?: number; ruleKeys?: string[] }[],
    o: {
      dispatch: boolean;
      reason?: string | null;
      canOverride: boolean;
      /** Send all (ST3-T18): เที่ยวที่ส่งแล้ว (DISPATCHED หรือเลยไป) = `UNCHANGED` ไม่ใช่ 409 — ตรวจก่อน version */
      sentUnchanged?: boolean;
    },
    tx: Tx = this.db.tx,
  ): Promise<BulkOutcome[]> {
    const out: BulkOutcome[] = new Array(items.length);
    // ทำตามลำดับ id เที่ยว (กัน deadlock เมื่อสองคำขอส่งชุดเดียวกันสลับลำดับ — review M2) แล้วคืนผลตามลำดับคำขอ
    const order = items
      .map((it, i) => ({ it, i }))
      .sort((x, y) => (x.it.tripId ?? '').localeCompare(y.it.tripId ?? ''));
    for (const { it, i } of order) {
      await tx.$executeRawUnsafe('SAVEPOINT tms_trip_bulk');
      try {
        if (!it.tripId) throw new ProblemException('not_found');
        const rules: RuleConfirmInput = {
          ruleKeys: it.ruleKeys ?? [],
          reason: o.reason ?? null,
          canOverride: o.canOverride,
        };
        const cur = await this.get(it.tripId, tx);
        let r: BulkOutcome;
        if (o.sentUnchanged && (TRIP_SENT_STATUSES as readonly string[]).includes(cur.status))
          r = { trip: cur, outcome: 'UNCHANGED', error: null };
        else if (cur.status === 'ASSIGNED' && o.dispatch)
          r = {
            trip: await this.dispatch(cur.id, tx, it.version, rules),
            outcome: 'DISPATCHED',
            error: null,
          };
        else if (cur.status === 'ASSIGNED') {
          if (it.version !== undefined && it.version !== cur.version)
            throw new ProblemException('precondition_failed');
          r = { trip: cur, outcome: 'UNCHANGED', error: null };
        } else if (cur.status === 'PLANNING') {
          if (!cur.vehicleId)
            throw field422('vehicleId', 'required', 'trip has no planned vehicle');
          const t = await this.assign(cur.id, { vehicleId: cur.vehicleId, rules }, tx, it.version, {
            dispatch: o.dispatch,
          });
          r = { trip: t, outcome: o.dispatch ? 'DISPATCHED' : 'ASSIGNED', error: null };
        } else
          throw new ProblemException(
            'invalid_state_transition',
            // รอรถร่วมตอบ (review ST3-T18 M1): บอกเหตุเฉพาะเป็นไทย — ส่ง/จัดรถได้หลังรถร่วมรับงาน (`from` = สถานะเดิม)
            cur.status === 'OFFERED' ? 'รอรถร่วมตอบรับ — ส่งได้หลังรถร่วมรับงาน' : undefined,
            undefined,
            {
              from: cur.status,
              event: o.dispatch ? 'dispatch' : 'assign',
            },
          );
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_trip_bulk');
        out[i] = r;
      } catch (e) {
        if (!(e instanceof ProblemException) && !(e instanceof InvalidTransitionError)) throw e;
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tms_trip_bulk');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_trip_bulk');
        out[i] = { trip: null, outcome: 'FAILED', error: e };
      }
    }
    return out;
  }

  /**
   * ส่งแผนทั้งวัน (ST3-T18 "Send all" — docs/04 D2, spec/03 §9 PLN-170): ปล่อยทุกเที่ยวของวันที่ยังไม่ส่งในคำขอเดียว
   * งานต่อเที่ยวใช้ `bulkAssign` + dispatch (แยกรายการ — ติดกฎ/ไม่มีรถ/รอรถร่วมตอบ = ไม่ผ่านพร้อมเหตุผล ไม่ข้ามเงียบ)
   * - `items` ไม่ส่ง = ทุกเที่ยว PLANNING/OFFERED/ASSIGNED ที่ `tripDate` = วันนั้น (ณ ตอนทำ)
   * - `items` ส่ง = เฉพาะที่ติ๊ก (+ version ที่เห็น) — เที่ยวของวันอื่น → 422 `items[i].tripId` `not_on_date`
   * - audit `trip.sent_all` 1 แถวต่อคำขอ (วัน, ขอบเขต, ผลต่อเที่ยว) — event ต่อเที่ยว = `trip.dispatched` เดิม (docs/01 §6)
   */
  async sendAll(
    date: string,
    items: { tripId: string | null; version?: number; ruleKeys?: string[] }[] | undefined,
    o: { reason?: string | null; canOverride: boolean; dryRun?: boolean },
    tx: Tx = this.db.tx,
  ): Promise<{
    items: { tripId: string | null; tripNo: string | null }[];
    outcomes: BulkOutcome[];
    day: { trips: number; sent: number; complete: boolean };
  }> {
    const day = new Date(`${date}T00:00:00Z`);
    let list: { tripId: string | null; version?: number; ruleKeys?: string[] }[];
    const numbers = new Map<string, string | null>();
    if (items === undefined) {
      const rows = await tx.trip.findMany({
        where: { tripDate: day, status: { in: [...TRIP_UNSENT_STATUSES] } },
        select: { id: true, tripNo: true },
        orderBy: { tripNo: 'asc' },
      });
      if (rows.length > SEND_ALL_MAX)
        throw field422('date', 'too_many', `more than ${SEND_ALL_MAX} trips — send selected trips`);
      for (const r of rows) numbers.set(r.id, r.tripNo);
      list = rows.map((r) => ({ tripId: r.id }));
    } else {
      const ids = items.flatMap((i) => (i.tripId ? [i.tripId] : []));
      const rows = await tx.trip.findMany({
        where: { id: { in: ids } },
        select: { id: true, tripNo: true, tripDate: true },
      });
      const off = new Map(rows.map((r) => [r.id, r]));
      const bad = items.flatMap((it, i) => {
        const r = it.tripId ? off.get(it.tripId) : undefined;
        return r && r.tripDate.getTime() !== day.getTime()
          ? [
              {
                field: `items[${i}].tripId`,
                code: 'not_on_date',
                message: `trip is not on ${date}`,
              },
            ]
          : [];
      });
      if (bad.length) throw new ProblemException('validation_failed', undefined, bad);
      for (const r of rows) numbers.set(r.id, r.tripNo);
      list = items;
    }
    // ตรวจล่วงหน้า (dryRun — QA ST3-T18 L2): ทำจริงทุกขั้น (กฎ T14 ชุดเดียวกับตอนส่ง) แล้วย้อนทั้งหมด ไม่มี audit/event
    if (o.dryRun) await tx.$executeRawUnsafe('SAVEPOINT tms_send_all_dry');
    const outcomes = await this.bulkAssign(
      list,
      {
        dispatch: true,
        reason: o.reason ?? null,
        canOverride: o.canOverride,
        sentUnchanged: true,
      },
      tx,
    );
    if (o.dryRun) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tms_send_all_dry');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_send_all_dry');
    }
    const after = await tx.trip.findMany({ where: { tripDate: day }, select: { status: true } });
    const state = daySendState(after.map((r) => r.status as TripStatus));
    const no = (id: string | null) => (id ? (numbers.get(id) ?? null) : null);
    const code = (e: unknown) =>
      e instanceof InvalidTransitionError
        ? 'invalid_state_transition'
        : ((e as ProblemException | null)?.code ?? null);
    if (!o.dryRun)
      await this.audit.record({
        action: `${ENTITY}.sent_all`,
        entityType: ENTITY,
        ...(o.reason ? { reason: o.reason } : {}),
        after: {
          date,
          scope: items === undefined ? 'ALL' : 'SELECTED',
          requested: list.length,
          dispatched: outcomes.flatMap((r, i) =>
            r.outcome === 'DISPATCHED' ? [no(list[i]!.tripId)] : [],
          ),
          alreadySent: outcomes.flatMap((r, i) =>
            r.outcome === 'UNCHANGED' ? [no(list[i]!.tripId)] : [],
          ),
          failed: outcomes.flatMap((r, i) =>
            r.outcome === 'FAILED' ? [{ tripNo: no(list[i]!.tripId), code: code(r.error) }] : [],
          ),
          dayTrips: state.trips,
          daySent: state.sent,
          dayComplete: state.complete,
        },
      });
    return {
      items: list.map((i) => ({ tripId: i.tripId, tripNo: no(i.tripId) })),
      outcomes,
      day: state,
    };
  }

  /**
   * เสนองาน/จ้างรถร่วม (PLANNING → OFFERED): รถร่วม + ผู้เสนอ + เวลา (ลิงก์/token = ST3-T23)
   * ST3-T22: `hire` = ส่วนจ้าง (ราคาซื้อ + `trip_cost` CARRIER_FEE + `subcon_offer` + เหตุผลการเลือก) ทำในล็อกเดียวกัน
   * — เรียกผ่าน `SubconHireService.hire` เท่านั้น (`/offer` ไม่มีทางสร้างข้อเสนอที่ไม่มีราคาซื้อ)
   */
  async offer(
    id: string,
    carrierId: string,
    tx: Tx = this.db.tx,
    expectedVersion?: number,
    hire?: OfferHireHook,
  ): Promise<TripRecord> {
    const { trip, dos } = await this.lock(tx, id, expectedVersion);
    this.assertCan(trip, 'offer');
    const on = await tx.deliveryOrder.count({
      where: { tripId: trip.id, status: { not: 'CANCELLED' } },
    });
    if (!on) throw new ProblemException('trip_empty');
    const carrier = await tx.carrier.findFirst({ where: { id: carrierId, deletedAt: null } });
    if (!carrier) throw field422('carrierId', 'invalid_reference', 'carrier not found');
    if (carrier.status !== 'ACTIVE')
      throw field422('carrierId', 'carrier_inactive', 'carrier is suspended');
    const now = this.clock.now();
    const extra = hire ? await hire(tx, trip, carrier, now) : null;
    // PLANNING ไม่มีคนขับ (assign ไป ASSIGNED) แต่อาจมีรถที่วางไว้บนกระดาน (ST3-T12) — ล้างไว้ (รถร่วมใส่ทะเบียนเองตอนรับงาน)
    await this.transition(tx, trip, 'offer', {
      carrierId,
      carrierNameSnapshot: carrier.legalName,
      assignmentStatus: 'OFFERED',
      offeredAt: now,
      offeredBy: requestContext.require().actorId ?? null,
      assignmentExpiresAt: new Date(now.getTime() + OFFER_TTL_MS),
      ...CLEAR_VEHICLE,
      ...(extra?.trip ?? {}),
    });
    // เสนองานใหม่หลังรถร่วมปฏิเสธ (ST3-T23) → SO ที่ค้าง CARRIER_REJECTED กลับเป็นวางแผนแล้ว (cascade รายถัดไป — docs/01 §4.1)
    await this.orderState.syncFromDeliveryOrders(
      tx,
      dos.map((d) => d.salesOrderId),
    );
    const final = await this.refreshWarnings(tx, trip.id);
    await this.audit.record({
      action: `${ENTITY}.offered`,
      entityType: ENTITY,
      entityId: trip.id,
      after: { carrier: carrier.code, carrierName: carrier.legalName, ...(extra?.audit ?? {}) },
      ...(extra?.reason ? { reason: extra.reason } : {}),
    });
    return final;
  }

  /**
   * รถร่วมปฏิเสธข้อเสนองาน (ST3-T23; docs/01 §4.2 "OFFERED → PLANNING : ปฏิเสธ → SO กลับ ON_HOLD(CARRIER_REJECTED)",
   * docs/04 D3 "ปฏิเสธ + เหตุผล", spec/03 PLN-151):
   * - ล็อก SO → DO → trip แล้วตรวจว่าการจ้างที่รอตอบยังเป็น `offerId` (ไม่ใช่ → 409 `offer_closed` — การกระทำแรกชนะ)
   * - เที่ยว → PLANNING (ล้างรถร่วม/หมดเวลา, `assignment_status` = REJECTED เป็นร่องรอย) · DO คงอยู่ในเที่ยว (จ้างรายถัดไปได้ทันที)
   * - การจ้าง → REJECTED + เหตุผล · ค่าจ้างที่ยังไม่จ่ายกลับรายการ (`reverseCarrierFees`) · SO → ON_HOLD `CARRIER_REJECTED`
   * - audit `trip.offer_rejected` + event `trip.offer_rejected` / `subcon_offer.rejected`
   */
  async rejectOffer(
    id: string,
    offerId: string,
    input: { reasonCode: string; reasonLabel: string; note?: string | null; via: 'LINK' | 'USER' },
    tx: Tx = this.db.tx,
  ): Promise<TripRecord> {
    const { trip, dos } = await this.lock(tx, id);
    const o = trip.subconOffers[0];
    if (
      trip.status !== 'OFFERED' ||
      o?.id !== offerId ||
      o.status !== 'OFFERED' ||
      (o.expiresAt && o.expiresAt.getTime() <= Date.now())
    )
      throw new ProblemException('offer_closed');
    this.assertCan(trip, 'reject');
    const note = input.note ? cleanLine(input.note).trim() : '';
    const why = `รถร่วมปฏิเสธ: ${input.reasonLabel}${note ? ` — ${note}` : ''}`;
    const now = this.clock.now();
    await this.transition(
      tx,
      trip,
      'reject',
      { ...CLEAR_OFFER, assignmentStatus: 'REJECTED', buyRateSnapshot: Prisma.DbNull },
      { note: why },
    );
    await tx.subconOffer.update({
      where: { id: offerId },
      data: {
        status: 'REJECTED',
        closedAt: now,
        closedReason: why,
        respondedAt: now,
        respondedVia: input.via,
        rejectReasonCode: input.reasonCode,
        rejectNote: note || null,
      },
    });
    const actor = requestContext.require().actorId ?? null;
    const reversed = await reverseCarrierFees(
      tx,
      trip.id,
      actor,
      'กลับรายการค่าจ้างรถร่วม (รถร่วมปฏิเสธงาน)',
    );
    const held = await this.orderState.holdCarrierRejected(
      tx,
      dos.map((d) => d.salesOrderId),
      why,
    );
    const final = await this.refreshWarnings(tx, trip.id);
    await this.audit.record({
      action: `${ENTITY}.offer_rejected`,
      entityType: ENTITY,
      entityId: trip.id,
      before: { status: trip.status, carrier: trip.carrierNameSnapshot },
      after: {
        status: final.status,
        offerId: encodeId('subconOffer', offerId),
        rejectReason: input.reasonCode,
        via: input.via,
        heldOrders: held.length,
        ...(reversed ? { reversedCarrierFees: reversed } : {}),
      },
      reason: why,
    });
    await this.emitOffer(tx, 'subcon_offer.rejected', {
      id: offerId,
      tripId: trip.id,
      carrierId: o.carrierId,
      status: 'REJECTED',
      respondedVia: input.via,
      rejectReason: input.reasonCode,
    });
    return final;
  }

  /**
   * ข้อเสนองานรถร่วมหมดเวลา (ST3-T24; docs/01 §4.2 "OFFERED → PLANNING : ปฏิเสธ/หมดอายุ → SO กลับ ON_HOLD(CARRIER_REJECTED)",
   * docs/01 §4.1 `CARRIER_REJECTED` "รถร่วมกดปฏิเสธหรือลิงก์หมดอายุ", spec/03 PLN-154) — เรียกจาก job (ไม่มีผู้ใช้)
   * - ล็อก SO → DO → trip แล้วตรวจซ้ำ: การจ้างที่รอตอบยังเป็น `offerId` และถึง `expiresAt` แล้ว ณ `now` — ไม่ใช่ (รับ/ปฏิเสธ/
   *   ถอน/จ้างใหม่ไปก่อน) → คืน null ไม่ทำอะไร (การกระทำแรกชนะ — job รันซ้ำ/สอง worker ได้ผลเดียว)
   * - เที่ยว → PLANNING (`assignment_status` EXPIRED เป็นร่องรอย) · การจ้าง → EXPIRED · ลิงก์เพิกถอน · ค่าจ้างที่ยังไม่จ่ายกลับรายการ
   *   · SO → ON_HOLD `CARRIER_REJECTED` (ชุดเดียวกับปฏิเสธ) · audit `trip.offer_expired` + event `subcon_offer.expired`
   */
  async expireOffer(
    id: string,
    offerId: string,
    now: Date,
    tx: Tx = this.db.tx,
  ): Promise<{ trip: TripRecord; carrierId: string; heldOrders: number } | null> {
    const { trip, dos } = await this.lock(tx, id);
    const o = trip.subconOffers[0];
    if (
      trip.status !== 'OFFERED' ||
      o?.id !== offerId ||
      o.status !== 'OFFERED' ||
      !o.expiresAt ||
      o.expiresAt.getTime() > now.getTime()
    )
      return null;
    this.assertCan(trip, 'expire');
    const why = `รถร่วมไม่ตอบรับภายในเวลา: ${o.carrierNameSnapshot} (ลิงก์หมดอายุ)`;
    await this.transition(
      tx,
      trip,
      'expire',
      { ...CLEAR_OFFER, assignmentStatus: 'EXPIRED', buyRateSnapshot: Prisma.DbNull },
      { note: why },
    );
    await tx.subconOffer.update({
      where: { id: offerId },
      data: { status: 'EXPIRED', closedAt: now, closedReason: why },
    });
    await this.offerLinks.revoke(tx, [offerId], 'OFFER_EXPIRED', trip.id);
    const reversed = await reverseCarrierFees(
      tx,
      trip.id,
      requestContext.require().actorId ?? null,
      'กลับรายการค่าจ้างรถร่วม (ข้อเสนอหมดเวลา)',
    );
    const held = await this.orderState.holdCarrierRejected(
      tx,
      dos.map((d) => d.salesOrderId),
      why,
    );
    const final = await this.refreshWarnings(tx, trip.id);
    await this.audit.record({
      action: `${ENTITY}.offer_expired`,
      entityType: ENTITY,
      entityId: trip.id,
      before: { status: trip.status, carrier: trip.carrierNameSnapshot },
      after: {
        status: final.status,
        offerId: encodeId('subconOffer', offerId),
        expiresAt: o.expiresAt.toISOString(),
        heldOrders: held.length,
        ...(reversed ? { reversedCarrierFees: reversed } : {}),
      },
      reason: why,
    });
    await this.emitOffer(tx, 'subcon_offer.expired', {
      id: offerId,
      tripId: trip.id,
      carrierId: o.carrierId,
      status: 'EXPIRED',
    });
    return { trip: final, carrierId: o.carrierId, heldOrders: held.length };
  }

  /**
   * "ส่งรายถัดไป" ระหว่างรอตอบ (ST3-T24; docs/04 D3 "ไม่ตอบใน N ชม. → แจ้งเตือน + ปุ่มส่งรายถัดไป"): ปิดการจ้างที่ครบเวลาตอบ
   * (`response_due_at` ≤ now) แต่ลิงก์ยังไม่หมดอายุ → การจ้าง WITHDRAWN (เหตุผล "ไม่ตอบรับใน N ชม. — ส่งรายถัดไป") ·
   * เที่ยว → PLANNING (transition `withdraw` + event `trip.offer_withdrawn`) · ไม่ตั้งใบค้าง — ผู้เรียก (`SubconHireService.hire`) จ้างรายใหม่ต่อในล็อกเดียวกัน
   * (ไม่ผ่าน = rollback ทั้งคู่) · ลิงก์/ค่าจ้างของรายเดิม: `hire` เพิกถอน/กลับรายการให้ (ชุดเดียวกับจ้างใหม่หลังปฏิเสธ)
   * ยังไม่ครบเวลา → 409 `offer_not_timed_out` · ตอบไปแล้ว/ไม่ได้รอตอบ → 409 `offer_closed`
   */
  async withdrawTimedOutOffer(
    id: string,
    now: Date,
    tx: Tx = this.db.tx,
    expectedVersion?: number,
    /** หมายเหตุของผู้จัดรถ (ไม่บังคับ — review L4) ต่อท้ายเหตุผลระบบ */
    note?: string | null,
  ): Promise<{ offerId: string; carrierId: string }> {
    const { trip } = await this.lock(tx, id, expectedVersion);
    const o = trip.subconOffers[0];
    if (trip.status !== 'OFFERED' || !o || o.status !== 'OFFERED')
      throw new ProblemException('offer_closed');
    if (!o.responseDueAt || o.responseDueAt.getTime() > now.getTime())
      throw new ProblemException('offer_not_timed_out', undefined, undefined, {
        responseDueAt: o.responseDueAt?.toISOString() ?? null,
      });
    this.assertCan(trip, 'withdraw');
    const hours = Math.round((o.responseDueAt.getTime() - o.offeredAt.getTime()) / 3600_000);
    const extra = note ? cleanLine(note).trim() : '';
    const why = `${o.carrierNameSnapshot} ไม่ตอบรับใน ${hours} ชม. — ส่งรายถัดไป${extra ? ` · ${extra}` : ''}`;
    await this.transition(
      tx,
      trip,
      'withdraw',
      { ...CLEAR_OFFER, assignmentStatus: null, buyRateSnapshot: Prisma.DbNull },
      { note: why },
    );
    await tx.subconOffer.update({
      where: { id: o.id },
      data: { status: 'WITHDRAWN', closedAt: now, closedReason: why },
    });
    await this.audit.record({
      action: 'subcon_offer.withdrawn',
      entityType: ENTITY,
      entityId: trip.id,
      before: { status: trip.status, carrier: trip.carrierNameSnapshot },
      after: { offerId: encodeId('subconOffer', o.id), cause: 'NO_RESPONSE_SEND_NEXT' },
      reason: why,
    });
    await this.emitOffer(tx, 'subcon_offer.withdrawn', {
      id: o.id,
      tripId: trip.id,
      carrierId: o.carrierId,
      status: 'WITHDRAWN',
    });
    return { offerId: o.id, carrierId: o.carrierId };
  }

  /**
   * เปลี่ยนผู้รับเหมา (ST3-T25; docs/04 D3 "เปลี่ยน carrier — ยกเลิกการจ้างเดิมแล้วจ้างใหม่ (ประวัติคงอยู่)", plan/11 #13
   * "ยกเลิกการจ้างบน trip เดิม"): ปิดการจ้างที่ใช้งานอยู่ — ผู้เรียก (`SubconHireService.hire` `changeReason`) จ้างรายใหม่ต่อ
   * ในล็อก/transaction เดียวกัน (ไม่ผ่าน = rollback ทั้งคู่ — ไม่มีสถานะ "ยกเลิกแล้วแต่ยังไม่จ้าง")
   * - รอตอบ (OFFERED): `withdraw` → PLANNING ได้ทุกเวลา (ไม่ต้องรอครบ N ชม. ต่างจาก ST3-T24) · การจ้าง → WITHDRAWN
   * - รับงานแล้ว (ASSIGNED ที่มีการจ้าง ACCEPTED): `cancel_hire` → PLANNING · ล้างรถ/คนขับ/หางของรายเดิม (คงประเภทรถ) ·
   *   DO PLANNED → DRAFT คงในเที่ยว · ลิงก์ใบคุมรถของคนขับเดิมหมดผล · การจ้าง → WITHDRAWN (คงทะเบียน/คนขับที่รับไว้เป็นประวัติ)
   * - ปล่อยรถแล้ว/ไม่มีการจ้าง → 409 `carrier_change_not_allowed` (docs/01 §4.2 หลัง DISPATCHED ห้ามแก้ snapshot)
   * - ทั้งสองกรณี: เหตุผล (≥ 10 ตัว — ผู้เรียกตรวจ) ลง `closed_reason` + audit `subcon_offer.cancelled` · ลิงก์ข้อเสนอเพิกถอน
   *   (`CARRIER_CHANGED`) · ค่าจ้างที่ยังไม่จ่ายกลับรายการครั้งเดียว (`reverseCarrierFees` — unique `reversal_of_id`) ·
   *   บรรทัดที่จ่ายแล้วไม่แตะ แต่นับไว้ใน audit (`paidCarrierFees`) · ไม่ตั้งใบค้าง (จ้างรายใหม่ทันที)
   */
  async releaseHireForChange(
    id: string,
    reason: string,
    now: Date,
    tx: Tx = this.db.tx,
    expectedVersion?: number,
  ): Promise<{ offerId: string; carrierId: string; carrierName: string; from: TripStatus }> {
    const { trip, dos } = await this.lock(tx, id, expectedVersion);
    const o = trip.subconOffers[0];
    const accepted = trip.status === 'ASSIGNED' && o?.status === 'ACCEPTED';
    const offered = trip.status === 'OFFERED' && o?.status === 'OFFERED';
    if (!o || (!accepted && !offered))
      throw new ProblemException('carrier_change_not_allowed', undefined, undefined, {
        from: trip.status,
      });
    const event: TripEvent = accepted ? 'cancel_hire' : 'withdraw';
    this.assertCan(trip, event);
    const why = `เปลี่ยนผู้รับเหมา (${o.carrierNameSnapshot}): ${reason}`;
    const before = view(trip);
    await this.transition(
      tx,
      trip,
      event,
      {
        ...CLEAR_OFFER,
        buyRateSnapshot: Prisma.DbNull,
        ...(accepted ? { ...CLEAR_CREW, assignedAt: null } : {}),
      },
      // ไม่เพิ่ม version ที่ขั้นนี้ — การจ้างรายใหม่ในคำขอเดียวกันเพิ่มให้ 1 ครั้ง (review L3: 1 คำขอ = 1 version)
      { note: why, bump: false },
    );
    if (accepted) {
      for (const d of await this.reload(tx, dos)) await this.dos.unplanForTrip(tx, d, why);
      // ลิงก์ใบคุมรถของเที่ยวนี้หมดผลเสมอ (review L1 — ไม่ขึ้นกับว่ามีคนขับใน snapshot)
      await this.sheetLinks.revokeForTrip(tx, trip.id, 'DRIVER_CHANGED');
    }
    await tx.subconOffer.update({
      where: { id: o.id },
      data: {
        status: 'WITHDRAWN',
        closedAt: now,
        closedReason: why,
        closedCause: 'CARRIER_CHANGED',
      },
    });
    await this.offerLinks.revoke(tx, [o.id], 'CARRIER_CHANGED', trip.id);
    const actor = requestContext.require().actorId ?? null;
    const reversed = await reverseCarrierFees(
      tx,
      trip.id,
      actor,
      'กลับรายการค่าจ้างรถร่วม (เปลี่ยนผู้รับเหมา)',
    );
    // ค่าจ้างที่จ่ายแล้ว (อยู่ใน settlement — ST6) ไม่กลับรายการอัตโนมัติ: ธงไว้ให้ฝ่ายบัญชีตาม (ใบลดหนี้/หักคืน)
    const paid = await tx.tripCost.count({
      where: {
        subconOfferId: o.id,
        costType: 'CARRIER_FEE',
        amount: { gt: 0 },
        settlementLineId: { not: null },
      },
    });
    await this.audit.record({
      action: 'subcon_offer.cancelled',
      entityType: ENTITY,
      entityId: trip.id,
      before,
      after: {
        offerId: encodeId('subconOffer', o.id),
        cause: 'CARRIER_CHANGED',
        offerStatus: o.status,
        ...(accepted
          ? { acceptedPlate: o.acceptedPlate, acceptedDriver: o.acceptedDriverName }
          : {}),
        ...(reversed ? { reversedCarrierFees: reversed } : {}),
        ...(paid ? { paidCarrierFees: paid } : {}),
      },
      reason: why,
    });
    await this.emitOffer(tx, accepted ? 'subcon_offer.cancelled' : 'subcon_offer.withdrawn', {
      id: o.id,
      tripId: trip.id,
      carrierId: o.carrierId,
      status: 'WITHDRAWN',
      cause: 'CARRIER_CHANGED',
    });
    return {
      offerId: o.id,
      carrierId: o.carrierId,
      carrierName: o.carrierNameSnapshot,
      from: trip.status as TripStatus,
    };
  }

  /**
   * ปล่อยรถ (ASSIGNED → DISPATCHED): ต้องมี DO ≥ 1 · ทุก DO → DISPATCHED · SO → IN_TRANSIT
   * ST3-T14 (PLN-088 "ประเมินตอนส่งแผน"): ตรวจกฎใหม่ก่อนปล่อย — บล็อกที่ยังไม่ยกเว้น → 409 `assignment_blocked`,
   * คำเตือนที่ยังไม่ยืนยัน → 409 `assignment_warnings` (ยืนยัน/ยกเว้นในคำขอนี้ได้ด้วย `rules`)
   * แจ้งคนขับ: ยังไม่มีช่องทางถึงคนขับในเฟสนี้ (แอป/ลิงก์คนขับ = ST4, push = P1) — event `trip.dispatched` เป็นจุดต่อ (spec/12 §3)
   */
  async dispatch(
    id: string,
    tx: Tx = this.db.tx,
    expectedVersion?: number,
    rules?: RuleConfirmInput,
  ): Promise<TripRecord> {
    const reason = this.ruleReason(rules);
    const { trip, dos } = await this.lock(tx, id, expectedVersion);
    return this.oneBump(tx, await this.dispatchLocked(tx, trip, dos, rules, reason), trip.version);
  }

  private async dispatchLocked(
    tx: Tx,
    locked: TripRecord,
    dos: DeliveryOrderRecord[],
    rules: RuleConfirmInput | undefined,
    reason: string | null,
  ): Promise<TripRecord> {
    this.assertCan(locked, 'dispatch');
    if (!dos.length) throw new ProblemException('trip_empty');
    const checked = await this.refreshWarnings(tx, locked.id);
    const trip = await this.enforceRules(tx, checked, rules, reason, 'dispatch');
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

  /** บรรทัดต้นทุน + ความพร้อมปิดต้นทุนของเที่ยว (ST6-T01 `GET /trips/{id}/costs`) */
  async costs(id: string, tx: Tx = this.db.tx) {
    const trip = await this.get(id, tx);
    const data = await costLines(tx, trip.id);
    const ready = await costReadiness(tx, trip);
    const allocations = await costAllocations(tx, trip);
    return { trip, data, ready, allocations };
  }

  /**
   * ปิดต้นทุนเที่ยว (ST6-T01; docs/01 §4.2 COMPLETED → COSTED "ต้นทุนเที่ยวครบ + ปันลง DO") — `trips:close` + If-Match
   * ต้นทุนครบ = `costReadiness` (ไม่มีค่าใช้จ่ายหน้างานรอยืนยัน · เที่ยวรถร่วมมีค่าจ้างของการจ้างที่รับแล้ว · หลาย DO = รายได้ยืนยันแล้ว
   * และรวม > 0) ไม่ครบ → 409 `trip_costs_incomplete` + `blockers` · ปันต้นทุนลง DO ตามสัดส่วนรายได้ (ST6-T01c — `allocateTripCost`)
   * ใน transaction เดียวกัน (ล็อก DO → เที่ยว → บรรทัดต้นทุน) · หลังปิด: บันทึก/ยืนยันค่าใช้จ่ายหน้างานไม่ได้ (ST4-T13) ·
   * audit `trip.costed` (ไม่ใส่ยอดเงินใน audit — สิทธิ์ราคาซื้อ)
   */
  async cost(id: string, tx: Tx = this.db.tx, expectedVersion?: number): Promise<TripRecord> {
    // kill switch ระดับระบบ (ค่าเริ่มต้นเปิด — ST6-T01c)
    if (!tripCostingEnabled()) throw new ProblemException('trip_costing_unavailable');
    const { trip } = await this.lock(tx, id, expectedVersion);
    this.assertCan(trip, 'cost');
    // ล็อก SO ของ DO ในเที่ยวแล้ว (lockForTrip: SO → DO → trip) — rebuild รายได้ (ยืนยันค่าใช้จ่ายหน้างานฝั่งขาย ฯลฯ) ล็อก SO
    // ก่อนเช่นกัน → รายได้ที่ใช้ปันไม่เปลี่ยนกลางคัน
    // ล็อกบรรทัดต้นทุนของเที่ยว — กันยืนยัน/บันทึกค่าใช้จ่ายหน้างานพร้อมกัน (field-charges ล็อกเที่ยวแบบ FOR SHARE ก่อนเขียน)
    await tx.$queryRaw`SELECT id FROM trip_cost WHERE trip_id = ${trip.id}::uuid FOR UPDATE`;
    const ready = await costReadiness(tx, trip);
    if (ready.blockers.length)
      throw new ProblemException('trip_costs_incomplete', undefined, undefined, {
        blockers: ready.blockers,
        pendingCount: ready.pendingCount,
      });
    const perDo = await allocateTripCost(tx, trip.id, ready.targets);
    const actor = requestContext.require().actorId ?? null;
    await this.transition(tx, trip, 'cost', {
      costedAt: new Date(),
      costedBy: actor,
      // วิธีปัน (PO ตัดสิน 19 พ.ย. 2569) — แทน BY_WEIGHT/… ของ docs/01 (plan/00a)
      costAllocationMethod: 'BY_REVENUE',
    });
    const final = await this.get(trip.id, tx);
    const lines = await tx.tripCost.count({ where: { tripId: trip.id, status: 'CONFIRMED' } });
    await this.audit.record({
      action: `${ENTITY}.costed`,
      entityType: ENTITY,
      entityId: trip.id,
      before: { status: trip.status },
      after: {
        status: final.status,
        costLines: lines,
        // DO ที่รับส่วนแบ่ง (ไม่มียอดเงิน — สิทธิ์ราคาซื้อ)
        allocatedTo: [...perDo.keys()].map((d) => encodeId('deliveryOrder', d)),
      },
    });
    return final;
  }

  /**
   * เที่ยวรถร่วมจ่ายครบ (ST6-T09; docs/01 §4.2 COSTED → SETTLED "(รถร่วม) cost line ถูกจ่ายใน settlement") — ระบบทำตอนบันทึกจ่ายใบสำคัญจ่าย
   * (`SettlementsService.markPaid` ล็อกเที่ยวแล้วและตรวจว่าทุกบรรทัดต้นทุนของเที่ยวจ่ายแล้ว) · ไม่ตรวจ If-Match แต่เพิ่ม version ·
   * ประวัติสถานะ + event ภายใน `trip.settled` · SETTLED = สิ้นสุด (ไม่กลับเข้าคิวจ่าย)
   */
  async settle(tx: Tx, tripId: string): Promise<void> {
    const trip = await this.get(tripId, tx);
    this.assertCan(trip, 'settle');
    await this.transition(tx, trip, 'settle', {});
  }

  /**
   * ไล่สถานะเที่ยวจากจุดแวะ (ST4-T03 — `StopProjectionService` ถือล็อก SO → DO → trip แล้ว): `start` DISPATCHED → IN_PROGRESS
   * (`trip.started` — plan/00a เพิ่มจาก spec/07; payload `startedAt` = เวลาถึงจุดแรก) · `complete` IN_PROGRESS → COMPLETED
   * (`trip.completed`; `completedAt` = เวลาปิดจุดสุดท้าย)
   * ไม่ตรวจ If-Match (ระบบทำตาม event) แต่เพิ่ม version
   */
  async applyExecution(
    tx: Tx,
    tripId: string,
    event: Extract<TripEvent, 'start' | 'complete'>,
    at: Date,
  ): Promise<TripRecord> {
    const trip = await this.get(tripId, tx);
    await this.transition(tx, trip, event, event === 'complete' ? { completedAt: at } : {}, {
      snapshot:
        event === 'start' ? { startedAt: at.toISOString() } : { completedAt: at.toISOString() },
    });
    return this.get(tripId, tx);
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
    // ST3-T22: การจ้างรถร่วมที่ยังใช้งาน → ถอน (ประวัติคงอยู่) · บรรทัดค่าจ้างไม่ลบ — เที่ยวที่ยกเลิกไม่เข้าคิวจ่าย (ST6)
    await tx.subconOffer.updateMany({
      where: { tripId: trip.id, status: { in: ['OFFERED', 'ACCEPTED'] } },
      data: { status: 'WITHDRAWN', closedAt: new Date(), closedReason: `ยกเลิกเที่ยว: ${reason}` },
    });
    // ค่าจ้างรถร่วมที่ยังไม่จ่ายของเที่ยวที่ยกเลิก → กลับรายการ (review ST3-T22 M3 — ค่าชดเชยการยกเลิก = ST6/PLN-155)
    const reversedFees = await reverseCarrierFees(
      tx,
      trip.id,
      requestContext.require().actorId ?? null,
      `กลับรายการค่าจ้างรถร่วม (ยกเลิกเที่ยว)`,
    );
    // ลิงก์ใบคุมรถที่ส่งให้คนขับหมดผล (ST3-T20 review/QA) · ลิงก์ข้อเสนองานของรถร่วม (ST3-T23)
    await this.sheetLinks.revokeForTrip(tx, trip.id, 'TRIP_CANCELLED');
    await this.offerLinks.revokeForTrip(tx, trip.id, 'TRIP_CANCELLED');
    const final = await this.get(trip.id, tx);
    await this.audit.record({
      action: `${ENTITY}.cancelled`,
      entityType: ENTITY,
      entityId: trip.id,
      before,
      after: {
        status: final.status,
        releasedOrders: dos.map((d) => d.doNo),
        ...(reversedFees ? { reversedCarrierFees: reversedFees } : {}),
      },
      reason,
    });
    return final;
  }

  /**
   * ยืนยันคำเตือน / ยกเว้นบล็อกของเที่ยวภายหลัง (ST3-T14 — กระดาน "… · ขออนุมัติ" / "ต้องย้ายรถ" → dialog)
   * ตรวจกฎใหม่ก่อน (ผลล่าสุด) แล้วยกเว้น/ยืนยัน **เฉพาะ `ruleKeys`** (กุญแจที่ไม่ค้างแล้ว → 422) · บล็อกต้องมี `trips:override`
   * บล็อกอื่นที่ค้างไม่ขวาง (เที่ยวมีอยู่แล้ว) · เที่ยวที่ปล่อยแล้ว/จบ/ยกเลิก → 409 `invalid_state_transition`
   */
  async confirmRules(
    id: string,
    rules: RuleConfirmInput,
    tx: Tx = this.db.tx,
    expectedVersion?: number,
  ): Promise<TripRecord> {
    const reason = this.ruleReason(rules);
    const { trip } = await this.lock(tx, id, expectedVersion);
    this.assertEditable(trip);
    const checked = await this.refreshWarnings(tx, trip.id);
    return this.enforceRules(tx, checked, rules, reason, 'confirm');
  }

  // ---------------------------------------------------------------------------------------------

  /** เหตุผลของการยืนยัน/ยกเว้น — ส่งธงใดธงหนึ่งแล้วต้องมีเหตุผล ≥ 10 ตัวอักษร (ตรวจก่อนทำงาน) */
  private ruleReason(rules?: RuleConfirmInput): string | null {
    if (!rules?.ruleKeys?.length) return null;
    const reason = cleanLine(String(rules.reason ?? '')).trim();
    if ([...reason].length < RULE_REASON_MIN_LENGTH)
      throw field422(
        'overrideReason',
        reason ? 'too_short' : 'required',
        `reason must be at least ${RULE_REASON_MIN_LENGTH} characters`,
      );
    return reason;
  }

  /**
   * บังคับกฎตอนจัด (D-07) กับผลตรวจล่าสุดของเที่ยว — **ตัวเดียวกันทุกทางเข้า** (create+รถ / schedule / assign / dispatch / confirm)
   * - `ruleKeys` ต้องเป็นกุญแจของกฎที่ค้างอยู่ (มิฉะนั้น 422 `not_pending`) — ยกเว้น/ยืนยันเฉพาะกฎเหล่านั้น
   * - บล็อกที่ค้างและไม่อยู่ใน `ruleKeys` → 409 `assignment_blocked` (+ `blocks[].key`, `warnings`) ยกเว้น `/confirm-rules`
   * - บล็อกใน `ruleKeys` แต่ไม่มี `trips:override` → 403 `permission_denied`
   * - คำเตือนที่ยังไม่ยืนยัน: `dispatch` → 409 `assignment_warnings` · ทางเข้าอื่นบันทึกได้ (ค้างให้ยืนยันภายหลัง)
   * - ยกเว้น/ยืนยัน → ต่อท้าย `rule_overrides` (กุญแจผูกรถ + คนขับ — `ruleKey`) + audit `trip.rules_overridden` พร้อมเหตุผล
   * ทั้งหมดอยู่ใน transaction ของคำขอ — ตอบ error แล้วการเปลี่ยนแปลงของคำขอนั้นย้อนกลับทั้งหมด
   */
  private async enforceRules(
    tx: Tx,
    trip: TripRecord,
    rules: RuleConfirmInput | undefined,
    reason: string | null,
    gate: 'entry' | 'dispatch' | 'confirm',
  ): Promise<TripRecord> {
    const ctx = {
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
      reliefDriverId: trip.reliefDriverId,
    };
    const results = (trip.ruleWarnings as unknown as TripWarning[]) ?? [];
    const done = (trip.ruleOverrides as unknown as RuleOverride[]) ?? [];
    const p = pendingRules(results, done, ctx);
    const keyOf = (w: TripWarning) => ruleKey(w, ctx);
    const brief = (w: TripWarning) => ({
      key: keyOf(w),
      code: w.code,
      severity: w.severity,
      source: w.source,
      messageKey: w.messageKey,
      message: w.message,
      params: w.params,
    });
    const wanted = rules?.ruleKeys ?? [];
    const pending = new Set([...p.blocks, ...p.warnings].map(keyOf));
    // กุญแจที่ไม่ค้าง (ไม่ใช่สิ่งที่ผู้ใช้เห็นตอนนี้) → 422 รายช่อง
    const stale = wanted.flatMap((k, i) =>
      pending.has(k)
        ? []
        : [{ field: `ruleKeys[${i}]`, code: 'not_pending', message: 'rule is not pending' }],
    );
    if (stale.length) throw new ProblemException('validation_failed', undefined, stale);
    const chosen = new Set(wanted);
    const blocksLeft = p.blocks.filter((b) => !chosen.has(keyOf(b)));
    if (blocksLeft.length && gate !== 'confirm')
      throw new ProblemException('assignment_blocked', undefined, undefined, {
        blocks: blocksLeft.map(brief),
        warnings: p.warnings.map(brief),
        overrideScope: RULE_OVERRIDE_SCOPE,
      });
    const overriding = p.blocks.filter((b) => chosen.has(keyOf(b)));
    if (overriding.length && !rules?.canOverride)
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'trips',
        action: 'override',
        required: [RULE_OVERRIDE_SCOPE],
      });
    const warnLeft = p.warnings.filter((w) => !chosen.has(keyOf(w)));
    if (gate === 'dispatch' && warnLeft.length)
      throw new ProblemException('assignment_warnings', undefined, undefined, {
        warnings: warnLeft.map(brief),
      });
    const add = [...p.blocks, ...p.warnings].filter((w) => chosen.has(keyOf(w)));
    if (!add.length || reason === null) return trip;
    const ctxReq = requestContext.require();
    const at = new Date().toISOString();
    const entries: RuleOverride[] = add.map((w) => ({
      key: ruleKey(w, ctx),
      code: w.code,
      severity: w.severity === 'block' ? 'block' : 'warning',
      kind: w.severity === 'block' ? 'OVERRIDE' : 'ACKNOWLEDGE',
      reason,
      actorId: ctxReq.actorId ?? null,
      at,
      message: w.message,
      params: w.params,
    }));
    const r = await tx.trip.updateMany({
      where: { id: trip.id, version: trip.version },
      data: {
        ruleOverrides: JSON.parse(JSON.stringify([...done, ...entries])) as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    if (r.count === 0) throw new ProblemException('concurrent_update');
    await this.audit.record({
      action: `${ENTITY}.rules_overridden`,
      entityType: ENTITY,
      entityId: trip.id,
      after: {
        tripNo: trip.tripNo,
        vehiclePlate: trip.vehiclePlateSnapshot,
        driver: trip.driverNameSnapshot,
        rules: entries.map((e) => ({ code: e.code, kind: e.kind, message: e.message })),
      },
      reason,
    });
    const final = await this.get(trip.id, tx);
    // PLN-090: `trip.rule_overridden` + การเปลี่ยนแปลงของเที่ยว (review L7)
    const ruled = entries.map((e) => ({ key: e.key, code: e.code, kind: e.kind, reason }));
    await this.emit(tx, 'trip.rule_overridden', final, { rules: ruled });
    await this.emit(tx, 'trip.updated', final, { ruleOverrides: ruled });
    return final;
  }

  private tenantId(): string {
    const t = requestContext.require().tenantId;
    if (!t) throw new Error('trips: tenant missing in request context');
    return t;
  }

  /**
   * ช่วงวิ่งตามแผน: เริ่ม/จบต้องอยู่ในวันเที่ยว ± 1 วัน (เวลาไทย — เที่ยวข้ามคืน) และจบหลังเริ่ม (QA ST3-T11)
   * — กันช่วงที่ไม่เกี่ยวกับวันเที่ยว (เช่น จบก่อนวันเที่ยว) ซึ่งทำให้ช่วงตรวจเอกสาร (assignability) กลับด้าน
   */
  private window(tripDate: string, start?: string | null, end?: string | null) {
    const s = start ? new Date(start) : null;
    const e = end ? new Date(end) : null;
    const day = Date.parse(`${tripDate}T00:00:00Z`);
    const errors: { field: string; code: string; message: string }[] = [];
    for (const [field, v] of [
      ['plannedStartAt', s],
      ['plannedEndAt', e],
    ] as const) {
      if (!v) continue;
      const thai = Date.parse(`${bangkokToday(v)}T00:00:00Z`);
      if (Math.abs(thai - day) > 86_400_000)
        errors.push({
          field,
          code: 'outside_trip_date',
          message: 'must be on tripDate (Asia/Bangkok) or within 1 day of it',
        });
    }
    if (s && e && e <= s)
      errors.push({
        field: 'plannedEndAt',
        code: 'before_start',
        message: 'plannedEndAt must be after plannedStartAt',
      });
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
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
    extra: {
      reasonCodeId?: string | null;
      note?: string | null;
      bump?: boolean;
      /** ช่องเพิ่มใน payload ของ domain_event (ST4-T03 startedAt/completedAt) */
      snapshot?: Record<string, unknown>;
    } = {},
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
          data: {
            ...data,
            status: to as DbTripStatus,
            ...(extra.bump === false ? {} : { version: { increment: 1 } }),
          },
        });
        if (r.count === 0) throw new ProblemException('concurrent_update');
        return { ...(await this.eventObject(trip.id, tx)), ...(extra.snapshot ?? {}) };
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
    await this.refreshLegs(tx, trip.id);
    return plan;
  }

  /** ระยะ/เวลาช่วงวิ่งของทุกจุด + ยอดรวม (ST3-T16 — `refreshTripLegs`) */
  private async refreshLegs(tx: Tx, tripId: string) {
    await refreshTripLegs(tx, tripId);
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
      .map((d) => {
        // ST4-T12 DO ส่งใหม่ (redelivery_of) — ช่วงเวลาของ SO เป็นของวันเดิม → เลื่อนให้ตรงวันส่งของ DO (คงเวลาในวัน)
        const day = d.redeliveryOfId ? d.doDate.toISOString().slice(0, 10) : null;
        const at = (w: { start: string | null; end: string | null }) =>
          day ? shiftWindowToDay(w, day) : w;
        return {
          id: d.id,
          originSiteId: d.originSiteId,
          destSiteId: d.destSiteId,
          pickupWindow: at(win(d.salesOrderId, d.originStopSeq)),
          dropWindow: at(win(d.salesOrderId, d.destStopSeq)),
        };
      });
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

  /**
   * รถที่วางไว้บนกระดาน (create/schedule — ST3-T12): ตรวจการอ้างอิงชุดเดียวกับ /assign (รถ + รถร่วมของรถต้องมีอยู่และใช้งาน)
   * กฎห้ามจ่ายงาน (ST2-T20 `isAssignable`) เก็บใน `warnings` เหมือน /assign — บังคับ + override = ST3-T14
   */
  private async plannedVehicle(tx: Tx, vehicleId: string) {
    const snap = await this.vehicleSnapshot(tx, vehicleId);
    const v = (await tx.vehicle.findUnique({
      where: { id: vehicleId },
      include: { carrier: true },
    }))!;
    if (v.ownership === 'SUBCONTRACT') {
      if (!v.carrier || v.carrier.deletedAt)
        throw field422('vehicleId', 'invalid_reference', 'carrier of vehicle not found');
      if (v.carrier.status !== 'ACTIVE')
        throw field422('vehicleId', 'carrier_inactive', 'carrier of vehicle is suspended');
    }
    return snap;
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
    /** false = ผู้เรียกขยับ version ในคำขอนี้แล้ว (เช่น reorder — QA ST3-T16: 1 คำขอ = +1) */
    bump = true,
    /** P1-ST1-T08 false = ไม่ตรวจโควตาใหม่ (ตรวจคำเตือนทีละมาก เช่น วันลาคนขับ) — คงผลโควตาเดิมของเที่ยวไว้ */
    o: { quota?: boolean } = {},
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
          message: vehicleNotReadyMessageTh(trip.vehiclePlateSnapshot, v.status),
          params: { status: v.status },
        });
      const compat = await this.compatWarnings(tx, trip);
      out.push(...compat.warnings);
      out.push(...(await this.loadWarnings(tx, trip)));
      // ช่วงตรวจเอกสาร = ครอบวันเที่ยวและช่วงวิ่งทั้งหมด (min/max — ไม่มีวันกลับด้าน)
      const points = [trip.tripDate, trip.plannedStartAt, trip.plannedEndAt].filter(
        (d): d is Date => d !== null,
      );
      const from = new Date(Math.min(...points.map((d) => d.getTime())));
      const to = new Date(Math.max(...points.map((d) => d.getTime())));
      const a = await this.assignability.isAssignable(
        {
          vehicleId: trip.vehicleId,
          driverId: trip.driverId,
          window: { from, to },
          hazmat: compat.hazmat,
        },
        tx,
      );
      // ใบขับขี่คนขับสำรอง (เฉพาะประเด็นใบขับขี่ — เอกสารรถตรวจแล้วข้างบน)
      const ra = trip.reliefDriverId
        ? await this.assignability.isAssignable(
            {
              vehicleId: trip.vehicleId,
              driverId: trip.reliefDriverId,
              window: { from, to },
              hazmat: compat.hazmat,
            },
            tx,
          )
        : null;
      const relief = ra
        ? [...ra.blocks, ...ra.warnings].filter((i) => i.code.startsWith('DRIVER_LICENCE_'))
        : [];
      for (const i of relief)
        out.push({
          code: i.code,
          severity: i.severity,
          source: 'assignability',
          messageKey: i.messageKey,
          message: `คนขับสำรอง: ${i.message}`,
          params: {
            ...i.params,
            driverRole: 'relief',
            ...(i.expiredOn ? { expiredOn: i.expiredOn } : {}),
          },
        });
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
    out.push(
      ...(o.quota === false
        ? ((trip.ruleWarnings as unknown as TripWarning[]) ?? []).filter(
            (w) => w.code === 'vehicle_quota_exceeded',
          )
        : await this.quotaWarnings(tx, trip)),
    );
    // คนขับหลัก + คนขับสำรอง: ลา / ซ้อนเวลา (เทียบกับทั้งคนขับหลักและสำรองของเที่ยวอื่น)
    for (const [role, driverId, name] of [
      ['driver', trip.driverId, trip.driverNameSnapshot],
      ['relief', trip.reliefDriverId, trip.reliefDriverNameSnapshot],
    ] as const) {
      if (!driverId) continue;
      const d = await tx.driver.findUnique({ where: { id: driverId } });
      // สถานะ "ลาพัก" หรือวันลาในตารางรถ/คนขับรายวันที่ทับวันของเที่ยว (ST3-T19 — วันไทยของเที่ยว + ช่วงวิ่งข้ามคืน)
      const leaveDays = await this.leaveDays(tx, trip, driverId);
      if (d?.status === 'ON_LEAVE' || leaveDays.length)
        out.push({
          code: role === 'driver' ? 'driver_on_leave' : 'relief_driver_on_leave',
          severity: 'warning',
          source: 'assignment',
          messageKey: role === 'driver' ? 'trip.driverOnLeave' : 'trip.reliefDriverOnLeave',
          message: driverOnLeaveMessageTh(role, name, d?.status === 'ON_LEAVE' ? [] : leaveDays),
          // ตัวตนของคำเตือน (review M1): สถานะลาพัก = `status` · วันลา = ชุดวัน `dates` — เปลี่ยน/เพิ่มวัน = ต้องยืนยันใหม่
          params: {
            driverRole: role,
            ...(d?.status === 'ON_LEAVE' ? { status: 'ON_LEAVE' } : {}),
            ...(leaveDays.length ? { dates: leaveDays } : {}),
          },
        });
      out.push(...(await this.overlapWarnings(tx, trip, { driverId, name: name ?? '', role })));
      out.push(
        ...(await this.drivingHoursWarnings(tx, trip, { driverId, name: name ?? '', role })),
      );
    }
    // เวลาตามแผนของจุดถอยหลัง (เรียงเองภายหลัง — ST3-T16 — ลำดับของผู้จัดรถมาก่อน)
    for (const seq of backwardStops(
      trip.stops.map((st) => ({
        sequence: st.sequence,
        plannedArrival: st.plannedArrival?.toISOString() ?? null,
      })),
    ))
      out.push({
        code: 'stop_sequence_window_order',
        severity: 'warning',
        source: 'stops',
        messageKey: 'trip.stopSequenceWindowOrder',
        message: `จุดที่ ${seq}: เวลาตามแผนก่อนจุดก่อนหน้า — ตรวจลำดับจุด`,
        params: { sequence: seq },
      });
    const json = JSON.parse(JSON.stringify(out)) as Prisma.InputJsonValue;
    // การยกเว้นที่ข้อเท็จจริงเปลี่ยน/แย่ลง → หมดผล (ไม่กลับมามีผลอีก — PO 17 พ.ย. 2569)
    const rec = reconcileOverrides(
      out,
      (trip.ruleOverrides as unknown as RuleOverride[]) ?? [],
      { vehicleId: trip.vehicleId, driverId: trip.driverId, reliefDriverId: trip.reliefDriverId },
      new Date().toISOString(),
    );
    // เทียบแบบเรียง key (jsonb เรียง key ใหม่ — เทียบตรง ๆ จะต่างทุกครั้งแล้ว version ขยับโดยไม่มีอะไรเปลี่ยน)
    if (canonJson(trip.ruleWarnings) !== canonJson(json) || rec.changed)
      await tx.trip.update({
        where: { id },
        data: {
          ruleWarnings: json,
          ...(rec.changed
            ? {
                ruleOverrides: JSON.parse(JSON.stringify(rec.overrides)) as Prisma.InputJsonValue,
              }
            : {}),
          ...(bump ? { version: { increment: 1 } } : {}),
        },
      });
    return this.get(id, tx);
  }

  /**
   * P1-ST1-T08 โควตารถ active = soft limit (spec/01 PLT-080 [OPEN O-PLT-4] · D68-14 "คำเตือน ไม่ปฏิเสธ"):
   * ทะเบียนของเที่ยวยังไม่ถูกนับเดือนนี้ (เวลาไทย) และนับเพิ่มแล้วจะเกินเพดาน → คำเตือน `vehicle_quota_exceeded`
   * (ยืนยันแล้วปล่อยรถต่อได้ — ไม่หยุดงานขนส่ง) · ทะเบียนที่นับแล้ว (รวมที่ทีมการเงินตัดออก) ไม่เตือน · sandbox / ไม่จำกัด = ไม่เตือน
   * กุญแจกฎผูกรถ (ไม่มี identity param) → จำนวนที่เปลี่ยนไม่ทำให้ต้องยืนยันใหม่
   */
  private async quotaWarnings(tx: Tx, trip: TripRecord): Promise<TripWarning[]> {
    if (!trip.vehicleId && !trip.carrierId) return [];
    // เตือนเฉพาะก่อนปล่อยรถ — ปล่อยแล้ว = ถูกนับไปแล้ว (หรือยืนยันไปแล้ว)
    if (!['PLANNING', 'OFFERED', 'ASSIGNED'].includes(trip.status)) return [];
    const tenantId = requestContext.require().tenantId!;
    const { limit } = await this.entitlements.vehicleLimit(tenantId);
    if (limit === null) return [];
    const period = bangkokPeriod(this.clock.now());
    const [r] = await tx.$queryRaw<{ counted: boolean; active: number }[]>`
      SELECT EXISTS (SELECT 1 FROM active_vehicle_usage a
                      WHERE a.tenant_id = ${tenantId}::uuid AND a.period = ${period}
                        AND a.plate_normalized = tms_trip_usage_key(${trip.vehiclePlateSnapshot}, ${trip.carrierId}::uuid,
                              ${trip.driverId}::uuid, ${trip.driverNameSnapshot}, ${trip.id}::uuid)) AS counted,
             (SELECT count(*)::int FROM active_vehicle_usage a
               WHERE a.tenant_id = ${tenantId}::uuid AND a.period = ${period} AND a.excluded_at IS NULL) AS active`;
    if (!r || r.counted || r.active + 1 <= limit) return [];
    return [
      {
        code: 'vehicle_quota_exceeded',
        severity: 'warning',
        source: 'assignment',
        messageKey: 'trip.vehicleQuotaExceeded',
        message: vehicleQuotaMessageTh(trip.vehiclePlateSnapshot, r.active, limit),
        params: { limit, active: r.active, period },
      },
    ];
  }

  private async compatWarnings(
    tx: Tx,
    trip: TripRecord,
  ): Promise<{ warnings: TripWarning[]; hazmat: boolean }> {
    const dos = await tx.deliveryOrder.findMany({
      where: { tripId: trip.id, status: { not: 'CANCELLED' } },
      select: {
        salesOrderId: true,
        originSiteId: true,
        destSiteId: true,
        salesOrder: { select: { vehicleTypeId: true } },
        lines: { select: { salesOrderLine: { select: { productId: true, isDangerous: true } } } },
      },
    });
    const bySo = new Map<string, typeof dos>();
    for (const d of dos) bySo.set(d.salesOrderId, [...(bySo.get(d.salesOrderId) ?? []), d]);
    const seen = new Set<string>();
    const out: TripWarning[] = [];
    const productIds = [
      ...new Set(
        dos.flatMap((d) =>
          d.lines.flatMap((l) => (l.salesOrderLine?.productId ? [l.salesOrderLine.productId] : [])),
        ),
      ),
    ];
    // สินค้าอันตราย (PLN-084): สินค้าใน master `hazardous` หรือบรรทัด SO `is_dangerous` (ต้นทาง/connector) — QA M2
    const hazmat =
      dos.some((d) => d.lines.some((l) => l.salesOrderLine?.isDangerous)) ||
      (productIds.length
        ? (await tx.product.count({ where: { id: { in: productIds }, hazardous: true } })) > 0
        : false);
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
          severity: w.severity === 'info' ? 'info' : 'warning',
          source: 'compatibility',
          messageKey: w.messageKey,
          message: w.message,
          params: w.params,
        });
      }
    }
    return { warnings: out, hazmat };
  }

  /**
   * น้ำหนัก/ปริมาตรรวมของ DO ในเที่ยวเกินความจุ (ST3-T14 — คำเตือน D-07) · ความจุ MD-091: รถ ถ้ามี มิฉะนั้นประเภทรถ;
   * มีหาง = ความจุของหาง (หรือประเภทของหาง)
   */
  private async loadWarnings(tx: Tx, trip: TripRecord): Promise<TripWarning[]> {
    const unit = trip.trailerId ?? trip.vehicleId!;
    const v = await tx.vehicle.findUnique({
      where: { id: unit },
      select: {
        capacityKg: true,
        capacityCbm: true,
        vehicleType: { select: { capacityKg: true, capacityCbm: true } },
      },
    });
    if (!v) return [];
    const sum = await tx.deliveryOrder.aggregate({
      where: { tripId: trip.id, status: { not: 'CANCELLED' } },
      _sum: { weightKg: true, cbm: true },
    });
    const str = (d: Prisma.Decimal | null | undefined) => (d ? d.toString() : null);
    return checkLoad({
      weightKg: str(sum._sum.weightKg),
      cbm: str(sum._sum.cbm),
      capacityKg: str(v.capacityKg ?? v.vehicleType.capacityKg),
      capacityCbm: str(v.capacityCbm ?? v.vehicleType.capacityCbm),
    }).map((i) => ({
      code: i.code,
      severity: 'warning',
      source: 'load',
      messageKey: i.messageKey,
      message: loadMessageTh(i),
      params: i.params,
    }));
  }

  /** วันลา (ตารางรถ/คนขับรายวัน — ST3-T19) ของคนขับที่ทับวันของเที่ยว: วันเที่ยว + วันไทยของช่วงวิ่ง (ข้ามคืน) */
  private async leaveDays(tx: Tx, trip: TripRecord, driverId: string): Promise<string[]> {
    const days = [
      ...new Set([
        trip.tripDate.toISOString().slice(0, 10),
        ...drivingDays({
          tripDate: trip.tripDate.toISOString().slice(0, 10),
          start: trip.plannedStartAt?.toISOString() ?? null,
          end: trip.plannedEndAt?.toISOString() ?? null,
        }),
      ]),
    ].sort();
    const spans = await tx.scheduleEntry.findMany({
      where: {
        driverId,
        kind: 'LEAVE',
        cancelledAt: null,
        startsOn: { lte: new Date(`${days[days.length - 1]}T00:00:00Z`) },
        endsOn: { gte: new Date(`${days[0]}T00:00:00Z`) },
      },
      select: { startsOn: true, endsOn: true },
    });
    return leaveDaysIn(
      spans.map((x) => ({
        startsOn: x.startsOn.toISOString().slice(0, 10),
        endsOn: x.endsOn.toISOString().slice(0, 10),
      })),
      days,
    );
  }

  /**
   * ใส่/ยกเลิกวันลาคนขับ (ST3-T19) → ตรวจกฎเที่ยวที่ยังไม่จบของคนขับคนนั้น (หลัก/สำรอง) ในช่วงนั้นใหม่
   * (spec/03 PLN-088 "ประเมินใหม่เมื่อข้อมูลต้นทางเปลี่ยน") — คำเตือนเปลี่ยน = version +1 + `trip.updated` · คืนเลขเที่ยวที่เปลี่ยน
   */
  async refreshForDriverLeave(
    driverId: string,
    from: string,
    to: string,
    tx: Tx = this.db.tx,
  ): Promise<string[]> {
    const DAY = 86_400_000;
    const rows = await tx.trip.findMany({
      where: {
        status: { in: [...TRIP_OPEN_STATUSES] },
        OR: [{ driverId }, { reliefDriverId: driverId }],
        // เที่ยวยาว/ข้ามคืนที่เริ่มก่อนช่วงล้นเข้ามาได้ถึง 7 วัน (ช่วงเดียวกับ `drivingDays` — review L1)
        tripDate: {
          gte: new Date(Date.parse(`${from}T00:00:00Z`) - 7 * DAY),
          lte: new Date(`${to}T00:00:00Z`),
        },
      },
      select: { id: true, tripNo: true, version: true },
      // ล็อกตามลำดับ id ชุดเดียวกับ bulk/send-all (กัน deadlock — review M2)
      orderBy: { id: 'asc' },
    });
    const changed: string[] = [];
    for (const r of rows) {
      await tx.$queryRaw`SELECT id FROM trip WHERE id = ${r.id}::uuid FOR UPDATE`;
      const before = await tx.trip.findUniqueOrThrow({
        where: { id: r.id },
        select: { version: true, ruleWarnings: true },
      });
      const after = await this.refreshWarnings(tx, r.id, undefined, true, { quota: false });
      // คำเตือนเปลี่ยน → `trip.updated` (outbox — review L2)
      if (after.version !== before.version) {
        await this.emit(tx, 'trip.updated', after, { ruleWarnings: before.ruleWarnings });
        changed.push(after.tripNo ?? after.id);
      }
    }
    return changed;
  }

  /**
   * ชั่วโมงขับตามแผนของคนขับในวันเที่ยว (ST3-T14 — คำเตือน; เฟส 0 ไม่มีบันทึกเวลาขับจริง → ใช้ช่วงวิ่งตามแผนของเที่ยวที่ยังไม่จบ
   * ที่คนนี้เป็นคนขับหลัก/สำรอง ในวันเดียวกัน · เพดาน `DRIVING_HOURS_PER_DAY` [OPEN] FLT-Q5)
   */
  private async drivingHoursWarnings(
    tx: Tx,
    trip: TripRecord,
    who: { driverId: string; name: string; role: 'driver' | 'relief' },
  ): Promise<TripWarning[]> {
    const span = (t: {
      tripDate: Date;
      plannedStartAt: Date | null;
      plannedEndAt: Date | null;
    }) => ({
      tripDate: t.tripDate.toISOString().slice(0, 10),
      start: t.plannedStartAt?.toISOString() ?? null,
      end: t.plannedEndAt?.toISOString() ?? null,
    });
    // วันไทยที่เที่ยวนี้วิ่ง (ข้ามเที่ยงคืน = 2 วัน) · เที่ยวอื่นวันก่อน/หลังที่อาจล้นเข้ามา (review L6)
    const days = drivingDays(span(trip));
    const day0 = Date.parse(`${days[0]}T00:00:00Z`);
    const others = await tx.trip.findMany({
      where: {
        id: { not: trip.id },
        status: { in: [...TRIP_OPEN_STATUSES] },
        tripDate: {
          gte: new Date(day0 - 86_400_000),
          lte: new Date(Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 86_400_000),
        },
        OR: [{ driverId: who.driverId }, { reliefDriverId: who.driverId }],
      },
      select: { tripDate: true, plannedStartAt: true, plannedEndAt: true },
    });
    const spans = [span(trip), ...others.map(span)];
    return days.flatMap((date) =>
      checkDrivingHours(date, spans).map((i): TripWarning => ({
        code: i.code,
        severity: 'warning',
        source: 'schedule',
        messageKey: i.messageKey,
        message: `${who.role === 'driver' ? 'คนขับ' : 'คนขับสำรอง'} ${who.name} มีเวลาขับตามแผน ${i.params.hours} ชม. ในวันที่ ${i.params.date} (เกิน ${i.params.limit} ชม.)`,
        params: { ...i.params, driverRole: who.role },
      })),
    );
  }

  /** รถ/คนขับคนเดียวกันมีเที่ยวอื่นที่ยังไม่จบในวันเดียวกัน (ช่วงวิ่งทับกันเมื่อมีทั้งสองฝั่ง) — เตือน ไม่บล็อก (docs/04 D2) */
  private async overlapWarnings(
    tx: Tx,
    trip: TripRecord,
    kind: 'vehicle' | { driverId: string; name: string; role: 'driver' | 'relief' },
  ): Promise<TripWarning[]> {
    const who =
      kind === 'vehicle'
        ? { vehicleId: trip.vehicleId! }
        : { OR: [{ driverId: kind.driverId }, { reliefDriverId: kind.driverId }] };
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
    if (kind === 'vehicle')
      return [
        {
          code: 'vehicle_overlap',
          severity: 'warning',
          source: 'schedule',
          messageKey: 'trip.vehicleOverlap',
          message: vehicleOverlapMessageTh(
            trip.vehiclePlateSnapshot,
            overlaps.map((o) => o.tripNo!),
          ),
          params: { trips: overlaps.map((o) => o.tripNo) },
        },
      ];
    return [
      {
        code: kind.role === 'driver' ? 'driver_overlap' : 'relief_driver_overlap',
        severity: 'warning',
        source: 'schedule',
        messageKey: kind.role === 'driver' ? 'trip.driverOverlap' : 'trip.reliefDriverOverlap',
        message: `${kind.role === 'driver' ? 'คนขับ' : 'คนขับสำรอง'} ${kind.name} มีเที่ยวอื่นในช่วงเวลาเดียวกัน: ${nos}`,
        params: { trips: overlaps.map((o) => o.tripNo), driverRole: kind.role },
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

  /** event ของการจ้างรถร่วม (ST3-T23 — spec/03 §8 ข้อ 7 `subcon_offer.*`; ไม่มีราคา) */
  private async emitOffer(
    tx: Tx,
    type: string,
    snapshot: Record<string, unknown> & { id: string },
  ) {
    const ctx = requestContext.require();
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type,
        entityType: 'subcon_offer',
        localId: snapshot.id,
        snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
        requestId: ctx.requestId ?? null,
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

/** JSON ที่เรียง key ของทุก object (เทียบเนื้อหา jsonb) */
function canonJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );
}

const CLEAR_OFFER = {
  carrierId: null,
  carrierNameSnapshot: null,
  assignmentStatus: null,
  assignmentExpiresAt: null,
  offeredAt: null,
  offeredBy: null,
} as const;

/** รถ/คนขับ/หางของรายเดิม (ST3-T25 ยกเลิกการจ้างที่รับแล้ว — คงประเภทรถไว้ใช้คิดราคาจ้างรายใหม่) */
const CLEAR_CREW = {
  driverId: null,
  driverNameSnapshot: null,
  driverPhoneSnapshot: null,
  reliefDriverId: null,
  reliefDriverNameSnapshot: null,
  reliefDriverPhoneSnapshot: null,
  vehicleId: null,
  vehiclePlateSnapshot: null,
  trailerId: null,
  trailerPlateSnapshot: null,
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

/** ลำดับจุด (audit/event ของ reorder — ST3-T16) */
function stopsView(t: TripRecord) {
  return t.stops.map((st) => ({
    id: st.id,
    sequence: st.sequence,
    type: st.type,
    site: st.site.name,
  }));
}

/** ค่าที่กระดานเปลี่ยน (audit/event ของ schedule) */
function schedView(t: TripRecord) {
  return {
    tripDate: t.tripDate.toISOString().slice(0, 10),
    plannedStartAt: t.plannedStartAt?.toISOString() ?? null,
    plannedEndAt: t.plannedEndAt?.toISOString() ?? null,
    vehicleId: t.vehicleId,
    vehiclePlate: t.vehiclePlateSnapshot,
  };
}

/**
 * payload ของ domain event เที่ยว = `data.object` ของ webhook `trip.*` (ไม่มีราคา/เบอร์โทร)
 * ST7-T06: id แบบ prefix (docs/01 §5.1) ตาม schema ใน EVENT_REGISTRY — เดิมเป็น uuid ดิบ
 */
function eventView(t: TripRecord) {
  const enc = (kind: Parameters<typeof encodeId>[0], v: string | null) =>
    v ? encodeId(kind, v) : null;
  return {
    id: encodeId('trip', t.id),
    tripNo: t.tripNo,
    tripDate: t.tripDate.toISOString().slice(0, 10),
    status: t.status,
    vehicleId: enc('vehicle', t.vehicleId),
    vehiclePlate: t.vehiclePlateSnapshot,
    vehicleTypeId: enc('vehicleType', t.vehicleTypeId),
    driverId: enc('driver', t.driverId),
    carrierId: enc('carrier', t.carrierId),
    assignmentStatus: t.assignmentStatus,
    stops: t.stops.map((s: TripStop) => ({
      id: encodeId('tripStop', s.id),
      sequence: s.sequence,
      type: s.type,
      siteId: enc('site', s.siteId),
    })),
    deliveryOrderIds: t.deliveryOrders.map((d) => encodeId('deliveryOrder', d.id)),
  };
}
