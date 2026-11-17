import { Injectable } from '@nestjs/common';
import { Prisma, type DoStatus as DbDoStatus, type TripStop } from '@prisma/client';
import {
  deliveryOrderStopEvent,
  effectiveStopSequence,
  isDeliveringClose,
  isOutcomeMismatch,
  isTerminalStopState,
  isTripExecutable,
  projectStops,
  tripExecutionEvents,
  type DoStatus,
  type StopProjection,
  type StopOutcome,
  type StopRowStatus,
  type TripStatus,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import type { Tx } from '../../db/db.service';
import { DeliveryOrderService } from '../delivery-orders/delivery-order.service';
import { OrderStateService } from '../orders/order-state.service';
import { TripService } from '../trips/trip.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { toSeqEvent, type StopEventWithResolution } from './stop-event-seq';

/** ช่อง projection ของ trip_stop ที่ติดตาม (เทียบก่อนเขียน — ไม่เปลี่ยน = ไม่เขียน ไม่ออก event) */
const FIELDS = [
  'status',
  'outcome',
  'arrivedAt',
  'departedAt',
  'lastEventId',
  'failReasonCodeId',
] as const;

const same = (a: unknown, b: unknown) =>
  a instanceof Date || b instanceof Date
    ? (a as Date | null)?.getTime() === (b as Date | null)?.getTime()
    : a === b;

/** DO ของเที่ยว (select เบา — โหลดเต็มเฉพาะใบที่เปลี่ยน: review M2) */
interface TripDo {
  id: string;
  status: DbDoStatus;
  version: number;
  salesOrderId: string;
  tripStopId: string | null;
  pickupTripStopId: string | null;
}

/**
 * ไล่สถานะจาก stop event (ST4-T03; docs/04 D1, docs/01 §3.9 / §4.1–4.3) — คำนวณใหม่ทั้งเที่ยวจาก `effectiveStopSequence`
 * (เฉพาะ event ที่นับ: ปกติ + ที่ผู้จัดรถ "ใช้") ทุกครั้งที่มี event หรือการตัดสินใหม่ ภายใต้ล็อก SO → DO → trip:
 * 1. จุดรับก่อน → ธง `PICKUP_NOT_DONE` ของการปิดงานส่งที่จุดส่งซึ่งจุดรับของ DO ยังไม่ปิดสำเร็จ (ไม่นับจนรับของเสร็จ/ "ใช้")
 * 2. `trip_stop` (status / outcome / arrived_at / departed_at / last_event_id / fail_reason_code_id) + domain_event `stop.*`
 * 3. DO: จุดรับปิด → PICKED_UP · จุดส่งปิด → DELIVERED / FAILED (`delivery_order.status_changed`) — ไม่ถอยหลัง
 *    ผลจุดขัดกับ DO ที่ไล่แล้ว → ธงแจ้ง `OUTCOME_MISMATCH` (+ audit ครั้งแรกที่ขึ้น)
 * 4. เที่ยว: ถึง/ปิดจุดแรก → IN_PROGRESS (`trip.started` เวลา = ถึงจุดแรก) · ทุกจุดจบ → COMPLETED + เลขไมล์ประมาณ (แหล่ง TRIP)
 * 5. SO ตาม DO · 6. ช่อง projection ของ stop_event (ธง / การตัดสินที่มีผล / applied_at)
 * คำนวณซ้ำได้ผลเดิม ไม่ออก event ซ้ำ · เที่ยวที่จบ/ยกเลิกแล้ว = ไม่ไล่ (spec/04 DRV-072)
 */
@Injectable()
export class StopProjectionService {
  constructor(
    private readonly dos: DeliveryOrderService,
    private readonly orderState: OrderStateService,
    private readonly trips: TripService,
    private readonly vehicles: VehiclesService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * ล็อกลำดับเดียวกับงานเที่ยว (SO → DO → trip — `TripService.lock`) กัน deadlock กับยกเลิกเที่ยว/ปล่อยรถ
   * ชุด DO ของเที่ยวเปลี่ยนระหว่างล็อก → ลองใหม่ 1 ครั้ง แล้ว 409 `concurrent_update`
   */
  async lockTrip(tx: Tx, tripId: string): Promise<{ status: TripStatus; dispatched: boolean }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ids = await this.tripDoIds(tx, tripId);
      await this.dos.lockForTrip(tx, ids);
      const [trip] = await tx.$queryRaw<{ status: TripStatus; dispatched: boolean }[]>`
        SELECT status::text AS status, dispatched_at IS NOT NULL AS dispatched
          FROM trip WHERE id = ${tripId}::uuid FOR UPDATE`;
      if (!trip) throw new ProblemException('not_found');
      const again = await this.tripDoIds(tx, tripId);
      if (again.length === ids.length && again.every((id, i) => id === ids[i])) return trip;
    }
    throw new ProblemException('concurrent_update');
  }

  private async tripDoIds(tx: Tx, tripId: string): Promise<string[]> {
    const rows = await tx.deliveryOrder.findMany({
      where: { tripId, status: { not: 'CANCELLED' } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  private loadDos(tx: Tx, tripId: string): Promise<TripDo[]> {
    return tx.deliveryOrder.findMany({
      where: { tripId, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        status: true,
        version: true,
        salesOrderId: true,
        tripStopId: true,
        pickupTripStopId: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  /** คำนวณและเขียน projection ทั้งเที่ยว — ผู้เรียกต้องถือ `lockTrip` แล้ว */
  async project(tx: Tx, tripId: string): Promise<void> {
    const trip = await tx.trip.findUniqueOrThrow({
      where: { id: tripId },
      select: {
        id: true,
        status: true,
        vehicleId: true,
        plannedDistanceKm: true,
        actualDistanceKm: true,
      },
    });
    if (!isTripExecutable(trip.status as TripStatus)) return;

    const stops = await tx.tripStop.findMany({
      where: { tripId, removedAt: null },
      orderBy: { sequence: 'asc' },
    });
    const rows = await tx.stopEvent.findMany({
      where: { tripId, tripStopId: { in: stops.map((s) => s.id) } },
      include: { resolutions: { orderBy: { createdAt: 'asc' } } },
    });
    const byStop = new Map<string, StopEventWithResolution[]>();
    for (const r of rows) byStop.set(r.tripStopId, [...(byStop.get(r.tripStopId) ?? []), r]);
    const reasonOf = new Map(rows.map((r) => [r.id, r.reasonCodeId]));
    let dos = await this.loadDos(tx, tripId);

    // 1. จุดรับก่อน แล้วจุดส่ง (ธงจุดรับยังไม่ปิดขึ้นกับผลของจุดรับ)
    const pickupDone = new Map<string, boolean>();
    const pending = new Map<string, boolean>(); // event id → pickup_pending
    const seqOf = (events: StopEventWithResolution[]) =>
      effectiveStopSequence(events.map(toSeqEvent));
    const seqs = new Map<string, ReturnType<typeof seqOf>>();
    const ordered = [...stops].sort((a, b) =>
      a.type === b.type ? a.sequence - b.sequence : a.type === 'PICKUP' ? -1 : 1,
    );
    for (const s of ordered) {
      const owed = dos.filter(
        (d) => d.tripStopId === s.id && d.pickupTripStopId && d.pickupTripStopId !== s.id,
      );
      const waiting = owed.some((d) => !pickupDone.get(d.pickupTripStopId!));
      const evs = (byStop.get(s.id) ?? []).map((e) => {
        const p = waiting && isDeliveringClose(e.type, e.outcome as StopOutcome | null);
        pending.set(e.id, p);
        return { ...e, pickupPending: p };
      });
      const seq = seqOf(evs);
      seqs.set(s.id, seq);
      pickupDone.set(s.id, seq.state === 'COMPLETED');
    }

    const counted = new Set<string>();
    const closedAt: Date[] = [];
    const projections = projectStops(
      stops.map((s) => {
        const seq = seqs.get(s.id)!;
        for (const e of seq.events) if (e.counted) counted.add(e.id);
        const terminal = isTerminalStopState(seq.state);
        if (terminal && seq.closedAt) closedAt.push(seq.closedAt);
        return {
          id: s.id,
          sequence: s.sequence,
          currentStatus: s.status as StopRowStatus,
          state: seq.state,
          outcome: seq.outcome,
          enRouteAt: seq.enRouteAt,
          arrivedAt: seq.arrivedAt,
          closedAt: seq.closedAt,
          lastEventId: seq.lastEventId,
          closeReasonCodeId:
            terminal && seq.lastEventId ? (reasonOf.get(seq.lastEventId) ?? null) : null,
        };
      }),
    );

    // 2. trip_stop + stop.*
    const stopById = new Map(stops.map((s) => [s.id, s]));
    for (const p of projections) await this.writeStop(tx, stopById.get(p.id)!, p);

    // 3. DO (โหลดเต็มเฉพาะใบที่เปลี่ยน — move ใช้ id/status/version)
    const statusOf = new Map(projections.map((p) => [p.id, p]));
    const moved = new Set<string>();
    for (const d0 of dos) {
      let d: TripDo = d0;
      for (let i = 0; i < 3; i++) {
        const pickup = d.pickupTripStopId ? statusOf.get(d.pickupTripStopId) : undefined;
        const drop = d.tripStopId ? statusOf.get(d.tripStopId) : undefined;
        const ev = deliveryOrderStopEvent(
          d.status as DoStatus,
          pickup?.status ?? null,
          drop?.status ?? null,
        );
        if (!ev) break;
        const failed = ev === 'fail' ? (drop?.status === 'FAILED' ? drop : pickup) : undefined;
        await this.dos.applyStopResult(tx, d, ev, failed?.failReasonCodeId ?? null, null);
        moved.add(d.salesOrderId);
        const r = await tx.deliveryOrder.findUniqueOrThrow({
          where: { id: d.id },
          select: { status: true, version: true },
        });
        d = { ...d, ...r };
      }
    }
    if (moved.size) dos = await this.loadDos(tx, tripId);

    // ผลจุดขัดกับ DO ที่ไล่แล้ว → ธงแจ้งที่ event ปิดงานที่มีผลของจุด
    const mismatch = new Set<string>();
    for (const p of projections) {
      if (!p.lastEventId || (p.status !== 'COMPLETED' && p.status !== 'FAILED')) continue;
      const hit = dos.filter(
        (d) => d.tripStopId === p.id && isOutcomeMismatch(p.status, d.status as DoStatus),
      );
      if (hit.length) mismatch.add(p.lastEventId);
    }

    // 4. เที่ยว (+ เลขไมล์เมื่อจบ)
    const arrivals = projections.map((p) => p.arrivedAt).filter((x): x is Date => !!x);
    const first = arrivals.length ? arrivals : closedAt;
    for (const ev of tripExecutionEvents(
      trip.status as TripStatus,
      projections.map((p) => p.status),
    )) {
      const pick = ev === 'start' ? first : closedAt;
      const times = pick.map((x) => x.getTime());
      const at = times.length
        ? new Date(ev === 'start' ? Math.min(...times) : Math.max(...times))
        : this.clock.now();
      await this.trips.applyExecution(tx, tripId, ev, at);
      if (ev === 'complete' && trip.vehicleId) {
        const km = trip.actualDistanceKm ?? trip.plannedDistanceKm;
        await this.vehicles.applyTripEstimate(
          trip.vehicleId,
          tripId,
          km === null ? null : Number(km),
          at,
        );
      }
    }

    // 5. SO
    if (moved.size) await this.orderState.syncFromDeliveryOrders(tx, [...moved]);

    // 6. ช่อง projection ของ stop_event (ธงล่าสุด → การตัดสินที่มีผลคำนวณใหม่)
    await this.writeEventColumns(tx, stops, byStop, pending, mismatch, counted);
  }

  private async writeEventColumns(
    tx: Tx,
    stops: TripStop[],
    byStop: Map<string, StopEventWithResolution[]>,
    pending: Map<string, boolean>,
    mismatch: Set<string>,
    counted: Set<string>,
  ): Promise<void> {
    const now = this.clock.now();
    for (const s of stops) {
      const evs = (byStop.get(s.id) ?? []).map((e) => ({
        ...e,
        pickupPending: pending.get(e.id) ?? false,
        outcomeMismatch: mismatch.has(e.id),
      }));
      const seq = effectiveStopSequence(evs.map(toSeqEvent));
      for (const e of seq.events) {
        const data: Prisma.StopEventUpdateInput = {};
        const resolutionId = e.resolution?.id ?? null;
        if (e.conflict !== e.sequenceConflict) data.sequenceConflict = e.conflict;
        if (resolutionId !== e.resolutionId)
          data.resolution = resolutionId ? { connect: { id: resolutionId } } : { disconnect: true };
        const before = byStop.get(s.id)!.find((x) => x.id === e.id)!;
        if (before.pickupPending !== e.pickupPending) data.pickupPending = !!e.pickupPending;
        if (before.outcomeMismatch !== e.outcomeMismatch)
          data.outcomeMismatch = !!e.outcomeMismatch;
        const isCounted = counted.has(e.id);
        if (isCounted && !e.appliedAt) data.appliedAt = now;
        if (!isCounted && e.appliedAt) data.appliedAt = null;
        if (!Object.keys(data).length) continue;
        await tx.stopEvent.update({ where: { id: e.id }, data });
        if (!before.outcomeMismatch && e.outcomeMismatch)
          await this.audit.record({
            action: 'stop_event.outcome_mismatch',
            entityType: 'stop_event',
            entityId: e.id,
            before: { stopStatus: s.status },
            after: { flag: 'OUTCOME_MISMATCH', outcome: e.outcome },
          });
      }
    }
  }

  /** เขียน trip_stop เมื่อค่าเปลี่ยน + domain_event `stop.*` ตาม milestone ที่เพิ่งเกิด */
  private async writeStop(tx: Tx, row: TripStop, p: StopProjection): Promise<void> {
    const changed = FIELDS.filter((f) => !same(row[f], p[f]));
    if (!changed.length) return;
    await tx.tripStop.update({
      where: { id: row.id },
      data: {
        status: p.status,
        outcome: p.outcome,
        arrivedAt: p.arrivedAt,
        departedAt: p.departedAt,
        lastEventId: p.lastEventId,
        failReasonCodeId: p.failReasonCodeId,
      },
    });
    const previous = Object.fromEntries(changed.map((f) => [f, row[f]]));
    const types: string[] = [];
    if (!row.arrivedAt && p.arrivedAt) types.push('stop.arrived');
    if (row.status !== p.status && p.status === 'COMPLETED') types.push('stop.completed');
    if (row.status !== p.status && p.status === 'FAILED') types.push('stop.failed');
    if (!row.departedAt && p.departedAt) types.push('stop.departed');
    const ctx = requestContext.require();
    for (const type of types)
      await tx.domainEvent.create({
        data: {
          tenantId: ctx.tenantId!,
          type,
          entityType: 'trip_stop',
          localId: row.id,
          snapshot: JSON.parse(
            JSON.stringify({
              tripId: row.tripId,
              sequence: row.sequence,
              type: row.type,
              siteId: row.siteId,
              ...p,
            }),
          ) as Prisma.InputJsonValue,
          previousAttributes: JSON.parse(JSON.stringify(previous)) as Prisma.InputJsonValue,
          requestId: ctx.requestId ?? null,
          actorId: ctx.actorId ?? null,
        },
      });
  }
}
