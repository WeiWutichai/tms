import { Injectable } from '@nestjs/common';
import { Prisma, type DoStatus as DbDoStatus, type TripStop } from '@prisma/client';
import {
  deliveryOrderStopEvent,
  effectiveStopSequence,
  isDeliveringClose,
  isOutcomeMismatch,
  isTerminalStopState,
  hasUnresolvedStopFlags,
  isTripExecutable,
  planAutoReschedule,
  rescheduleExhaustedNoteTh,
  projectStops,
  tripExecutionEvents,
  type DoStatus,
  type StopProjection,
  type StopSeqResolution,
  type StopOutcome,
  type StopRowStatus,
  type TripStatus,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import type { Tx } from '../../db/db.service';
import { DeliveryOrderService } from '../delivery-orders/delivery-order.service';
import { OrderStateService } from '../orders/order-state.service';
import { PodService } from '../pod/pod.service';
import { TripService } from '../trips/trip.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { readSettings } from '../settings/settings.service';
import { bangkokToday } from '../vehicle-documents/expiry';
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
  rescheduleCount: number;
}

/** ธง + การตัดสินของ event ในลำดับ (ตรวจผลนิ่ง — hasUnresolvedStopFlags) */
type SeqFlags = { flags: string[]; resolutions: StopSeqResolution[] };

/** ค่าตั้งจำนวนครั้งนัดส่งใหม่อัตโนมัติ (registry) */
export const MAX_AUTO_RESCHEDULES_KEY = 'dispatch.maxAutoReschedules' as const;

/** snapshot เหตุผลใน payload ของ stop_event (ReasonSnapshot — reason-codes/snapshot.ts) */
interface PayloadReason {
  code?: string;
  label?: string;
  flags?: { autoReschedule?: boolean };
}

/**
 * ไล่สถานะจาก stop event (ST4-T03; docs/04 D1, docs/01 §3.9 / §4.1–4.3) — คำนวณใหม่ทั้งเที่ยวจาก `effectiveStopSequence`
 * (เฉพาะ event ที่นับ: ปกติ + ที่ผู้จัดรถ "ใช้") ทุกครั้งที่มี event หรือการตัดสินใหม่ ภายใต้ล็อก SO → DO → trip:
 * 1. จุดรับก่อน → ธง `PICKUP_NOT_DONE` ของการปิดงานส่งที่จุดส่งซึ่งจุดรับของ DO ยังไม่ปิดสำเร็จ (ไม่นับจนรับของเสร็จ/ "ใช้")
 * 2. `trip_stop` (status / outcome / arrived_at / departed_at / last_event_id / fail_reason_code_id) + domain_event `stop.*`
 * 3. DO: จุดรับปิด → PICKED_UP · จุดส่งปิด → DELIVERED / FAILED (`delivery_order.status_changed`) — ไม่ถอยหลัง
 *    DELIVERED → UNBILLED / POD_PENDING ทันทีตามหลักฐานส่งที่มีเทียบ checklist ของลูกค้า (ST4-T07 `PodService.settleDelivered`)
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
    private readonly pods: PodService,
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

  /** DO ของเที่ยวที่ต้องล็อก: ใบที่ใช้อยู่ + ใบที่ยกเลิกด้วย redeliver (อาจถูกคืน — ST4-T12 review H1b) */
  private async tripDoIds(tx: Tx, tripId: string): Promise<string[]> {
    const rows = await tx.deliveryOrder.findMany({
      where: {
        tripId,
        OR: [{ status: { not: 'CANCELLED' } }, { status: 'CANCELLED', redeliveries: { some: {} } }],
      },
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
        rescheduleCount: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  /** คำนวณและเขียน projection ทั้งเที่ยว — ผู้เรียกต้องถือ `lockTrip` แล้ว */
  async project(tx: Tx, tripId: string, pass = 0): Promise<void> {
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
    // ST4-T12 ใบที่ยกเลิกด้วย redeliver (ส่งใหม่แล้ว) — คืนได้เมื่อผลไม่สำเร็จถูกพลิก · จุดที่เหลือแต่ใบเหล่านี้ = ข้าม
    const redelivered = await this.redeliveredDos(tx, tripId);
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
          // ST4-T12 (review L): จุดที่ไม่มี DO ที่ใช้อยู่แล้ว (ทุกใบส่งใหม่) และยังไม่มี event = ข้าม (ปิดงานไม่ได้)
          // ใบถูกคืน → กลับมารอดำเนินการ · SKIPPED มาจากที่นี่ที่เดียว
          currentStatus: (stopWithoutActiveDo(s.id, dos, redelivered)
            ? 'SKIPPED'
            : s.status === 'SKIPPED'
              ? 'PENDING'
              : s.status) as StopRowStatus,
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
    let stopsChanged = false;
    for (const p of projections)
      if (await this.writeStop(tx, stopById.get(p.id)!, p)) stopsChanged = true;
    // ST4-T04: จุดเปลี่ยน = ตัวแทนของเที่ยว (TripDto stops[]) เปลี่ยน → version +1 ให้ ETag เปลี่ยน
    // (ไม่งั้น GET แบบมีเงื่อนไข/cache ของเบราว์เซอร์ได้ 304 + จุดเก่า) · ถือล็อกเที่ยวอยู่แล้ว
    if (stopsChanged)
      await tx.trip.update({ where: { id: tripId }, data: { version: { increment: 1 } } });

    // 3. DO (โหลดเต็มเฉพาะใบที่เปลี่ยน — move ใช้ id/status/version)
    const statusOf = new Map(projections.map((p) => [p.id, p]));
    const moved = new Set<string>();
    // 3a. ST4-T12 (review H1b): ผลไม่สำเร็จที่ทำให้ส่งใหม่ถูกพลิก → คืนใบเดิม (DO ส่งใหม่ยังไม่จัดรถ) หรือขึ้นธงให้ผู้จัดรถ
    const conflictStops = new Set<string>();
    let restored = false;
    for (const c of redelivered) {
      const drop = c.tripStopId ? statusOf.get(c.tripStopId) : undefined;
      const pickup = c.pickupTripStopId ? statusOf.get(c.pickupTripStopId) : undefined;
      if (drop?.status === 'FAILED' || pickup?.status === 'FAILED') continue;
      // review L: จุดส่งเดิมถูกถอดออกจากเที่ยว → ไม่คืนเอง (ขึ้นธงที่จุดรับถ้ามี)
      if (!drop) {
        if (c.pickupTripStopId && pickup) conflictStops.add(c.pickupTripStopId);
        continue;
      }
      const note = 'ผลส่งไม่สำเร็จถูกเปลี่ยน — ยกเลิกใบนัดส่งใหม่และคืนใบเดิมเข้าเที่ยว (ST4-T12)';
      if (await this.dos.restoreRedelivered(tx, c.id, note)) {
        moved.add(c.salesOrderId);
        restored = true;
      } else if (c.tripStopId) conflictStops.add(c.tripStopId);
    }
    if (restored) dos = await this.loadDos(tx, tripId);
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
      // ST4-T07: ส่งถึงแล้ว → เทียบหลักฐานกับ checklist ของลูกค้า → UNBILLED / POD_PENDING (docs/01 §4.3)
      if (d.status === 'DELIVERED') {
        await this.pods.settleDelivered(tx, d.id);
        moved.add(d.salesOrderId);
      }
    }
    if (moved.size) dos = await this.loadDos(tx, tripId);

    // 3b. ST4-T12 นัดส่งใหม่อัตโนมัติ: DO ส่งไม่สำเร็จด้วยเหตุผลที่ติ๊ก auto-reschedule → DO ใหม่วันถัดไป (นอกเที่ยวนี้)
    const exhausted = await this.autoReschedule(
      tx,
      tripId,
      dos,
      statusOf,
      rows,
      // resolutions ผ่าน toSeqEvent แล้ว (มี `at`) — ชนิดของ Prisma ซ้อนอยู่จึงแปลงชนิดที่นี่
      seqs as unknown as Map<string, { events: SeqFlags[] }>,
    );
    if (exhausted) {
      for (const so of exhausted.moved) moved.add(so);
      if (exhausted.moved.length) dos = await this.loadDos(tx, tripId);
    }

    // ผลจุดขัดกับ DO ที่ไล่แล้ว → ธงแจ้งที่ event ปิดงานที่มีผลของจุด
    const mismatch = new Set<string>();
    for (const p of projections) {
      if (!p.lastEventId || (p.status !== 'COMPLETED' && p.status !== 'FAILED')) continue;
      const hit = dos.filter(
        (d) => d.tripStopId === p.id && isOutcomeMismatch(p.status, d.status as DoStatus),
      );
      if (hit.length) mismatch.add(p.lastEventId);
    }
    // DO ส่งใหม่ถูกจัดรถแล้ว แต่ผลของจุดเปลี่ยนเป็นไม่ใช่ไม่สำเร็จ → ธงแจ้งที่ event ปิดงานล่าสุดของจุด (ไม่เงียบ)
    for (const stopId of conflictStops) {
      const close = (byStop.get(stopId) ?? [])
        .filter((e) => e.type === 'COMPLETE' || e.type === 'FAIL')
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0];
      if (close) mismatch.add(close.id);
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

    // 5. SO (+ ค้าง RESCHEDULES_EXHAUSTED หลัง DO ส่งใหม่ลงกล่องรอจัด)
    if (moved.size)
      await this.orderState.syncFromDeliveryOrders(
        tx,
        [...moved],
        new Map(
          (exhausted?.moved ?? []).map((so) => [
            so,
            'นัดส่งใหม่อัตโนมัติ — ใบส่งของใหม่กลับรอจัดรถ (ST4-T12)',
          ]),
        ),
      );
    for (const [so, note] of exhausted?.hold ?? [])
      await this.orderState.holdReschedulesExhausted(tx, [so], note);

    // 6. ช่อง projection ของ stop_event (ธงล่าสุด → การตัดสินที่มีผลคำนวณใหม่)
    await this.writeEventColumns(tx, stops, byStop, pending, mismatch, counted);

    // ส่งใหม่/คืนใบในรอบนี้ → คำนวณอีกรอบ (จุดที่ไม่เหลือ DO = ข้าม, เที่ยวจบ, ใบที่คืนไล่ตามจุด) — ผลเดิมไม่ออก event ซ้ำ
    if (pass === 0 && (restored || (exhausted?.moved.length ?? 0) > 0))
      await this.project(tx, tripId, 1);
  }

  /** ใบของเที่ยวที่ยกเลิกด้วย redeliver (ยังไม่ถูกคืน) */
  private async redeliveredDos(tx: Tx, tripId: string): Promise<TripDo[]> {
    const rows = await tx.deliveryOrder.findMany({
      where: { tripId, status: 'CANCELLED', redeliveries: { some: {} } },
      select: {
        id: true,
        status: true,
        version: true,
        salesOrderId: true,
        tripStopId: true,
        pickupTripStopId: true,
        rescheduleCount: true,
      },
      orderBy: { id: 'asc' },
    });
    const out: TripDo[] = [];
    for (const r of rows) if (await this.dos.isRedeliverCancelled(tx, r.id, r.status)) out.push(r);
    return out;
  }

  /**
   * ST4-T12 (docs/04 E2 Undelivered-retain + auto-reschedule; docs/01 §4.3 `FAILED → redeliver`; spec/04 DRV-171):
   * DO ที่ FAILED และจุดที่ทำให้ไม่สำเร็จ (จุดส่ง หรือจุดรับเมื่อรับของไม่ได้) ปิดด้วย event ที่ **snapshot เหตุผล** ติ๊ก autoReschedule
   * → `DeliveryOrderService.redeliver` (DO เดิม CANCELLED + DO ใหม่ DRAFT วันถัดไปเวลาไทย นอกเที่ยว — ไม่จัดรถให้เอง)
   * + domain_event `delivery_order.rescheduled` · ครั้งที่เกินค่าตั้ง `dispatch.maxAutoReschedules` → DO ใหม่ยังสร้าง + SO ค้าง
   * idempotent: DO เดิมเป็น CANCELLED แล้ว คำนวณซ้ำ/event ซ้ำ ไม่สร้างอีก · ทำจากสถานะ (ไม่ใช่จังหวะ) — event ที่ผู้จัดรถ "ใช้" ภายหลังก็นับ
   */
  private async autoReschedule(
    tx: Tx,
    tripId: string,
    dos: TripDo[],
    statusOf: Map<string, StopProjection>,
    rows: StopEventWithResolution[],
    seqs: Map<string, { events: SeqFlags[] }>,
  ): Promise<{ moved: string[]; hold: Map<string, string> } | null> {
    const failed = dos.filter((d) => d.status === 'FAILED');
    if (!failed.length) return null;
    const events = new Map(rows.map((r) => [r.id, r]));
    const ctx = requestContext.require();
    const today = bangkokToday(this.clock.now());
    let max: number | null = null;
    const moved: string[] = [];
    const hold = new Map<string, string>();
    for (const d of failed) {
      const drop = d.tripStopId ? statusOf.get(d.tripStopId) : undefined;
      const pickup = d.pickupTripStopId ? statusOf.get(d.pickupTripStopId) : undefined;
      const stop = drop?.status === 'FAILED' ? drop : pickup?.status === 'FAILED' ? pickup : null;
      const ev = stop?.lastEventId ? events.get(stop.lastEventId) : undefined;
      if (!stop || !ev) continue;
      // review H1: ผลยังไม่นิ่ง (ธงค้าง/ปิดแข่งกันรอตัดสิน) → ยังไม่นัด — ตัดสินแล้วคำนวณใหม่จะนัดตอนนั้น
      if (hasUnresolvedStopFlags(seqs.get(stop.id)?.events ?? [])) continue;
      const reason = (ev.payload as { reason?: PayloadReason } | null)?.reason ?? null;
      if (reason?.flags?.autoReschedule !== true) continue;
      max ??= Number(
        (await readSettings(tx, ctx.tenantId!, [MAX_AUTO_RESCHEDULES_KEY]))[
          MAX_AUTO_RESCHEDULES_KEY
        ],
      );
      const plan = planAutoReschedule({
        autoReschedule: true,
        previousCount: d.rescheduleCount,
        max,
        failedAt: ev.occurredAt.toISOString(),
        today,
      })!;
      const label = reason.label ?? reason.code ?? '';
      const note = plan.exhausted
        ? rescheduleExhaustedNoteTh(max, label)
        : `นัดส่งใหม่อัตโนมัติ ครั้งที่ ${plan.attempt} (${plan.doDate}) — ${label}`;
      const nd = await this.dos.redeliver(tx, d.id, {
        doDate: plan.doDate,
        rescheduleCount: plan.attempt,
        exhausted: plan.exhausted,
        reasonCodeId: ev.reasonCodeId,
        note,
        mode: 'auto',
      });
      await tx.domainEvent.create({
        data: {
          tenantId: ctx.tenantId!,
          type: 'delivery_order.rescheduled',
          entityType: 'delivery_order',
          localId: nd.id,
          snapshot: {
            id: nd.id,
            doNo: nd.doNo,
            doDate: plan.doDate,
            salesOrderId: nd.salesOrderId,
            redeliveryOfId: d.id,
            tripId,
            tripStopId: stop.id,
            stopEventId: ev.id,
            outcome: ev.outcome,
            reasonCode: reason.code ?? null,
            attempt: plan.attempt,
            max,
            exhausted: plan.exhausted,
          },
          previousAttributes: {},
          requestId: ctx.requestId ?? null,
          actorId: ctx.actorId ?? null,
        },
      });
      moved.push(d.salesOrderId);
      if (plan.exhausted) hold.set(d.salesOrderId, `${note} (${nd.doNo})`);
    }
    return { moved, hold };
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
  private async writeStop(tx: Tx, row: TripStop, p: StopProjection): Promise<boolean> {
    const changed = FIELDS.filter((f) => !same(row[f], p[f]));
    if (!changed.length) return false;
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
    const previous = stopEventFields(Object.fromEntries(changed.map((f) => [f, row[f]])));
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
              id: encodeId('tripStop', row.id),
              tripId: encodeId('trip', row.tripId),
              sequence: row.sequence,
              type: row.type,
              siteId: row.siteId ? encodeId('site', row.siteId) : null,
              ...stopEventFields(p),
            }),
          ) as Prisma.InputJsonValue,
          previousAttributes: JSON.parse(JSON.stringify(previous)) as Prisma.InputJsonValue,
          requestId: ctx.requestId ?? null,
          actorId: ctx.actorId ?? null,
        },
      });
    return true;
  }
}

/**
 * ช่อง projection ใน payload ของ `stop.*` (= `data.object` ของ webhook — ST7-T06): id แบบ prefix (docs/01 §5.1)
 * เฉพาะช่องที่มีใน input (previousAttributes ส่งเฉพาะช่องที่เปลี่ยน) · ไม่ส่ง id ภายในของ projection
 */
function stopEventFields(
  p: Partial<Record<(typeof FIELDS)[number], unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (!(f in p)) continue;
    const v = p[f];
    out[f] =
      f === 'lastEventId' && typeof v === 'string'
        ? encodeId('event', v)
        : f === 'failReasonCodeId' && typeof v === 'string'
          ? encodeId('reasonCode', v)
          : v;
  }
  return out;
}

/** จุดที่ DO ทุกใบถูกส่งใหม่ (ไม่มีใบที่ใช้อยู่ — ST4-T12) */
function stopWithoutActiveDo(
  stopId: string,
  active: { tripStopId: string | null; pickupTripStopId: string | null }[],
  redelivered: { tripStopId: string | null; pickupTripStopId: string | null }[],
): boolean {
  const on = (d: { tripStopId: string | null; pickupTripStopId: string | null }) =>
    d.tripStopId === stopId || d.pickupTripStopId === stopId;
  return redelivered.some(on) && !active.some(on);
}
