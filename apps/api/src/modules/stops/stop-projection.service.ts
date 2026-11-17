import { Injectable } from '@nestjs/common';
import { Prisma, type TripStop } from '@prisma/client';
import {
  deliveryOrderStopEvent,
  effectiveStopSequence,
  isTerminalStopState,
  isTripExecutable,
  projectStops,
  tripExecutionEvents,
  type DoStatus,
  type StopProjection,
  type StopRowStatus,
  type TripStatus,
} from '@tms/domain';
import { Clock } from '../../common/clock';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import type { Tx } from '../../db/db.service';
import { DeliveryOrderService } from '../delivery-orders/delivery-order.service';
import { OrderStateService } from '../orders/order-state.service';
import { TripService } from '../trips/trip.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { toSeqEvent } from './stop-event-seq';

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

/**
 * ไล่สถานะจาก stop event (ST4-T03; docs/04 D1, docs/01 §3.9 / §4.1–4.3) — คำนวณใหม่ทั้งเที่ยวจาก `effectiveStopSequence`
 * (เฉพาะ event ที่นับ: ปกติ + ที่ผู้จัดรถ "ใช้") ทุกครั้งที่มี event หรือการตัดสินใหม่ ภายใต้ล็อก SO → DO → trip:
 * 1. `trip_stop` (status / outcome / arrived_at / departed_at / last_event_id / fail_reason_code_id) + `stop_event.applied_at`
 * 2. DO: จุดรับปิด → PICKED_UP · จุดส่งปิด → DELIVERED / FAILED (`delivery_order.status_changed`)
 * 3. เที่ยว: ถึงจุดแรก → IN_PROGRESS (`trip.started`) · ทุกจุดจบ → COMPLETED (`trip.completed`) + เลขไมล์รถ (แหล่ง TRIP)
 * 4. SO ตาม DO (IN_TRANSIT → PARTIALLY_DELIVERED / DELIVERED)
 * domain_event `stop.arrived/departed/completed/failed` ออกเฉพาะเมื่อ projection เปลี่ยน → คำนวณซ้ำไม่ออกซ้ำ (idempotent)
 * เที่ยวที่จบ/ยกเลิกแล้ว = ไม่ไล่ (event ที่มาทีหลังแม้ผู้จัดรถ "ใช้" เป็นประวัติเท่านั้น — spec/04 DRV-072)
 */
@Injectable()
export class StopProjectionService {
  constructor(
    private readonly dos: DeliveryOrderService,
    private readonly orderState: OrderStateService,
    private readonly trips: TripService,
    private readonly vehicles: VehiclesService,
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
    const byStop = new Map<string, typeof rows>();
    for (const r of rows) byStop.set(r.tripStopId, [...(byStop.get(r.tripStopId) ?? []), r]);
    const reasonOf = new Map(rows.map((r) => [r.id, r.reasonCodeId]));

    const counted = new Set<string>();
    const closedAt: Date[] = [];
    const projections = projectStops(
      stops.map((s) => {
        const seq = effectiveStopSequence((byStop.get(s.id) ?? []).map(toSeqEvent));
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

    // 1. trip_stop + stop.* + applied_at
    const stopById = new Map(stops.map((s) => [s.id, s]));
    for (const p of projections) await this.writeStop(tx, stopById.get(p.id)!, p);
    await this.markApplied(
      tx,
      rows.map((r) => ({ id: r.id, appliedAt: r.appliedAt, counted: counted.has(r.id) })),
    );

    // 2. DO
    const statusOf = new Map(projections.map((p) => [p.id, p]));
    const moved = new Set<string>();
    const dos = await tx.deliveryOrder.findMany({
      where: { tripId, status: { not: 'CANCELLED' } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const { id } of dos) {
      for (let i = 0; i < 3; i++) {
        const d = await this.dos.get(id, tx);
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
      }
    }

    // 3. เที่ยว (+ เลขไมล์เมื่อจบ)
    const events = tripExecutionEvents(
      trip.status as TripStatus,
      projections.map((p) => p.status),
    );
    for (const ev of events) {
      const at =
        ev === 'complete' && closedAt.length
          ? new Date(Math.max(...closedAt.map((d) => d.getTime())))
          : this.clock.now();
      await this.trips.applyExecution(tx, tripId, ev, at);
      if (ev === 'complete' && trip.vehicleId) {
        const km = trip.actualDistanceKm ?? trip.plannedDistanceKm;
        await this.vehicles.recordTripReading(
          trip.vehicleId,
          tripId,
          km === null ? null : Number(km),
          at,
        );
      }
    }

    // 4. SO
    if (moved.size) await this.orderState.syncFromDeliveryOrders(tx, [...moved]);
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

  /** `applied_at` = เวลาที่ event ถูกนับใน projection (ตั้งครั้งแรกแล้วคงไว้) · ไม่นับแล้ว (ผู้จัดรถไม่ใช้/การตัดสินหมดผล) → null */
  private async markApplied(
    tx: Tx,
    rows: { id: string; appliedAt: Date | null; counted: boolean }[],
  ): Promise<void> {
    const set = rows.filter((r) => r.counted && !r.appliedAt).map((r) => r.id);
    const clear = rows.filter((r) => !r.counted && r.appliedAt).map((r) => r.id);
    if (set.length)
      await tx.stopEvent.updateMany({
        where: { id: { in: set } },
        data: { appliedAt: this.clock.now() },
      });
    if (clear.length)
      await tx.stopEvent.updateMany({ where: { id: { in: clear } }, data: { appliedAt: null } });
  }
}
