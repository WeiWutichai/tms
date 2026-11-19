import { Injectable } from '@nestjs/common';
import { Prisma, type StopEvent, type StopEventResolution } from '@prisma/client';
import {
  effectiveStopSequence,
  isClockSkewed,
  stopEventAdmission,
  stopEventFlagsOf,
  stopEventReasonRule,
  stopOutcomeError,
  type StopEventDecision,
  type StopEventFlag,
  type StopEventLateReason,
  type StopEventSource,
  type StopEventType,
  type StopOutcome,
  type StopSeqEvent,
  type StopSeqResolution,
  type TripStatus,
} from '@tms/domain';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { likeEscape } from '../../common/ilike';
import { assertDeliveryUnlocked } from '../invoices/billing-lock';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { actorNames } from './actor-names';
import { AuditService } from '../../audit/audit.service';
import { ReasonCodesService } from '../reason-codes/reason-codes.service';
import type { ReasonSnapshot } from '../reason-codes/snapshot';
import { toSeqEvent } from './stop-event-seq';
import { StopProjectionService } from './stop-projection.service';

export { toSeqEvent, type StopEventWithResolution } from './stop-event-seq';

export interface StopEventInput {
  clientEventId: string;
  /** ISO 8601 พร้อม offset (ตรวจที่ DTO) */
  occurredAt: string;
  outcome?: StopOutcome | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  reasonCodeId?: string | null;
  note?: string | null;
}

/** payload ของแถว (docs/01 §3.9 "snapshot ข้อความลง payload") — ช่องเฉพาะชนิดของ POD = ST4-T07/T09 */
export interface StopEventPayload {
  note?: string;
  reason?: ReasonSnapshot;
}

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/**
 * แหล่งของ event จากชนิดผู้เรียก (docs/01 §3.9 `source`) — ไม่รับจาก body กันปลอม:
 * magic link → LINK (ST4-T08) · ผู้ใช้ภายใน (user / เข้าใช้งานแทน / dev) → WEB · อื่น (API key ภายหลัง) → API
 */
export function stopEventSourceOf(principalType: string | undefined): StopEventSource {
  if (principalType === 'link') return 'LINK';
  if (principalType === 'user' || principalType === 'imp' || principalType === 'dev') return 'WEB';
  return 'API';
}

/** ธงของแถว (ลำดับความสำคัญตาม domain) */
export const flagsOf = (e: StopEvent): StopEventFlag[] =>
  stopEventFlagsOf({
    lateReason: e.lateReason,
    sequenceConflict: e.sequenceConflict,
    clockSkew: e.clockSkew,
    pickupPending: e.pickupPending,
    outcomeMismatch: e.outcomeMismatch,
  });

interface FlagCursor {
  /** received_at แบบข้อความจากฐาน (ละเอียดระดับ µs) */
  r: string;
  i: string;
}

/**
 * บันทึก event หน้างานต่อจุดแวะ (ST4-T01/T02; docs/04 E1 Stop event + Idempotent server, docs/01 §3.9) — append-only, เวลาสองชุด
 * T02: ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) = คืนแถวเดิม · เรียงตาม occurredAt แล้วตรวจ state machine ทุกครั้ง
 * (คอลัมน์ `sequence_conflict`) · เวลาเครื่องเพี้ยน → `clock_skew` · มาหลังจุดถูกถอด/เที่ยวยกเลิก/จบ → `late_reason`
 * (รับเก็บ ไม่ทิ้งหลักฐาน — spec/04 DRV-072/075) · dispatcher ตัดสินด้วยแถวใหม่ใน `stop_event_resolution` + เหตุผล + audit
 * T03: ทุก event/การตัดสินใหม่ → ไล่สถานะ trip_stop → trip → DO → SO (`StopProjectionService`) ใน transaction เดียวกัน
 */
@Injectable()
export class StopEventsService {
  constructor(
    private readonly db: DbService,
    private readonly reasonCodes: ReasonCodesService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly projection: StopProjectionService,
  ) {}

  /**
   * ล็อกเที่ยว (SO → DO → trip): event/การตัดสินของเที่ยวเดียวกันเข้าแถวทีละรายการ + กันชนกับยกเลิกเที่ยว/ปล่อยรถ
   * แล้วไล่สถานะ (ST4-T03) ภายใต้ล็อกเดียวกัน
   */
  private async lockTrip(
    tx: Tx,
    tripId: string,
  ): Promise<{ status: TripStatus; dispatched: boolean }> {
    return this.projection.lockTrip(tx, tripId);
  }

  /**
   * @returns `replayed` = ส่งซ้ำ (clientEventId เดิม จุด + ชนิดเดิม) → คืนแถวเดิม ไม่ตรวจ/ไม่สร้างใหม่ (docs/01 §3.9, spec/04 DRV-061)
   */
  async record(
    stopId: string,
    type: StopEventType,
    input: StopEventInput,
    tx: Tx = this.db.tx,
  ): Promise<{ event: StopEvent; replayed: boolean }> {
    const ctx = requestContext.require();
    const tenantId = ctx.tenantId!;
    const stop = await tx.tripStop.findFirst({
      where: { id: stopId },
      select: { id: true, tripId: true, removedAt: true },
    });
    if (!stop) throw new ProblemException('not_found');
    const { status: tripStatus, dispatched } = await this.lockTrip(tx, stop.tripId);

    // ส่งซ้ำ (หลังล็อก — คำขอพร้อมกันของเที่ยวเดียวกันเห็นแถวที่ commit แล้ว)
    const replay = await this.replayOf(tx, tenantId, input.clientEventId, stop.id, type);
    if (replay) return { event: replay, replayed: true };

    // ST4-T12: จุดที่ DO ทุกใบถูกนัดส่งใหม่ไปแล้ว (ข้าม) — ไม่มีของให้ส่ง/รับที่จุดนี้
    const now = await tx.tripStop.findUniqueOrThrow({
      where: { id: stop.id },
      select: { status: true },
    });
    if (now.status === 'SKIPPED' && stop.removedAt === null)
      throw new ProblemException('stop_skipped');

    // ST5-T06 (docs/04 F4 RELEASED "แก้ stop/qty ไม่ได้"): จุดของ DO ที่ส่งบัญชีแล้ว/อยู่ในใบแจ้งหนี้ → 409 (ส่งซ้ำด้วย clientEventId เดิมยังได้แถวเดิม)
    await this.assertStopUnlocked(tx, stop.id);

    const admission = stopEventAdmission(tripStatus, stop.removedAt !== null, dispatched);
    if (admission.kind === 'reject')
      throw new ProblemException('trip_not_in_progress', undefined, undefined, { tripStatus });

    const outcome = input.outcome ?? null;
    const outcomeErr = stopOutcomeError(type, outcome);
    if (outcomeErr) throw field422('outcome', outcomeErr, `outcome ${outcomeErr} for ${type}`);

    const hasLat = input.lat !== undefined && input.lat !== null;
    const hasLng = input.lng !== undefined && input.lng !== null;
    if (hasLat !== hasLng)
      throw field422(hasLat ? 'lng' : 'lat', 'required', 'lat and lng must be sent together');

    const note = input.note ?? null;
    const reason = await this.reason(type, outcome, input.reasonCodeId ?? null, note);
    const payload: StopEventPayload = {};
    if (note) payload.note = note;
    if (reason) payload.reason = reason;

    const receivedAt = this.clock.now();
    const occurredAt = new Date(input.occurredAt);
    // ON CONFLICT DO NOTHING (skipDuplicates): คำขอพร้อมกันด้วย clientEventId เดียวกันคนละเที่ยว (ล็อกเที่ยวไม่ครอบ)
    // → รอแถวของอีกคำขอ commit แล้วไม่แทรก (transaction ไม่พังจาก unique violation) → อ่านแถวเดิม
    const [created] = await tx.stopEvent.createManyAndReturn({
      skipDuplicates: true,
      data: {
        tenantId,
        tripStopId: stop.id,
        tripId: stop.tripId,
        type,
        outcome,
        reasonCodeId: reason?.sourceId ?? null,
        clientEventId: input.clientEventId,
        source: stopEventSourceOf(ctx.principalType),
        actor: ctx.actorId ?? null,
        lat: hasLat ? input.lat : null,
        lng: hasLng ? input.lng : null,
        accuracyM: input.accuracyM ?? null,
        occurredAt,
        receivedAt,
        clockSkew: isClockSkewed(occurredAt, receivedAt),
        lateReason: admission.kind === 'late' ? admission.reason : null,
        payload: payload as Prisma.InputJsonValue,
      },
    });
    if (!created) {
      const again = await this.replayOf(tx, tenantId, input.clientEventId, stop.id, type);
      if (again) return { event: again, replayed: true };
      throw new ProblemException('concurrent_update'); // ชนกับ id อื่น (ไม่ควรเกิด) — ลองใหม่ได้
    }
    await this.resequence(tx, stop.id);
    await this.projection.project(tx, stop.tripId);
    return {
      event: await tx.stopEvent.findFirstOrThrow({ where: { id: created.id } }),
      replayed: false,
    };
  }

  /** แถวเดิมของ clientEventId: จุด + ชนิดเดียวกัน = คืนแถวเดิม · คนละจุด/ชนิด = 409 stop_event_duplicate */
  private async replayOf(
    tx: Tx,
    tenantId: string,
    clientEventId: string,
    stopId: string,
    type: StopEventType,
  ): Promise<StopEvent | null> {
    const dup = await tx.stopEvent.findUnique({
      where: { tenantId_clientEventId: { tenantId, clientEventId } },
    });
    if (!dup) return null;
    if (dup.tripStopId === stopId && dup.type === type) return dup;
    throw new ProblemException('stop_event_duplicate', undefined, undefined, {
      eventId: encodeId('event', dup.id),
    });
  }

  /** จุดของ tenant นี้ (รวมที่ถอดออกแล้ว) */
  async stopExists(stopId: string): Promise<boolean> {
    return !!(await this.db.tx.tripStop.findFirst({ where: { id: stopId }, select: { id: true } }));
  }

  /** ST7-T11 จุดแวะเดียวสำหรับ `GET /v1/stops/{id}` (รวมจุดที่ถอดแล้ว) — ไม่พบ/tenant อื่น (RLS) = null */
  stopView(stopId: string, tx: Tx = this.db.tx) {
    return tx.tripStop.findFirst({
      where: { id: stopId },
      include: {
        trip: { select: { tripNo: true, status: true } },
        site: { select: { name: true } },
        deliveryOrders: { select: { id: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
        pickupOrders: { select: { id: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
      },
    });
  }

  /** เที่ยวของ tenant นี้ */
  async tripExists(tripId: string): Promise<boolean> {
    return !!(await this.db.tx.trip.findFirst({ where: { id: tripId }, select: { id: true } }));
  }

  /** event ทั้งหมดของจุด + การตัดสิน → ลำดับที่มีผล (domain) */
  async sequence(stopId: string, tx: Tx = this.db.tx) {
    const rows = await tx.stopEvent.findMany({
      where: { tripStopId: stopId },
      include: { resolutions: { orderBy: { createdAt: 'asc' } } },
    });
    return effectiveStopSequence(rows.map(toSeqEvent));
  }

  /**
   * คำนวณลำดับใหม่แล้วเขียน `sequence_conflict` เฉพาะแถวที่ค่าเปลี่ยน (event มาช้าอาจทำให้ event อื่นหายขัด/ขัดขึ้นมา)
   * ต้องถือล็อกเที่ยวอยู่ (ทุกจุดของเที่ยวเดียวกันเข้าแถวทีละรายการ)
   */
  private async resequence(tx: Tx, stopId: string) {
    const seq = await this.sequence(stopId, tx);
    for (const e of seq.events) {
      const resolutionId = e.resolution?.id ?? null;
      if (e.conflict !== e.sequenceConflict || resolutionId !== e.resolutionId)
        await tx.stopEvent.update({
          where: { id: e.id },
          data: { sequenceConflict: e.conflict, resolutionId },
        });
    }
    return seq;
  }

  /**
   * ผู้จัดรถตัดสินธงของ event (docs/04 E1 "flag ให้ dispatcher ตัดสิน") — แถวใหม่ใน `stop_event_resolution`
   * (ไม่แก้ธงของ event) + เหตุผล + audit · 1 event ตัดสินได้ครั้งเดียว · คำนวณลำดับของจุดใหม่ทันที
   */
  async resolve(
    eventId: string,
    decision: StopEventDecision,
    reason: string,
    tx: Tx = this.db.tx,
  ): Promise<StopEvent> {
    const ctx = requestContext.require();
    const found = await tx.stopEvent.findFirst({
      where: { id: eventId },
      select: { tripId: true },
    });
    if (!found) throw new ProblemException('not_found');
    await this.lockTrip(tx, found.tripId);
    const e = await tx.stopEvent.findFirstOrThrow({ where: { id: eventId } });
    // การตัดสินที่มีผลอยู่ (ธงยังตรง) → ตัดสินซ้ำไม่ได้ · ธงเปลี่ยนแล้ว (resolution_id ว่าง) → ตัดสินใหม่ได้ = แถวใหม่
    if (e.resolutionId) throw new ProblemException('stop_event_already_resolved');
    const flags = flagsOf(e);
    if (!flags.length) throw new ProblemException('stop_event_not_flagged');
    // ธงแจ้งเท่านั้น (ผลจุดขัด DO) = รับทราบได้อย่างเดียว — "ไม่ใช้" ไม่มีผลกับการนับ (แก้ DO ด้วยงานส่งใหม่/คืนคลัง ST4-T11)
    if (decision === 'IGNORE' && flags.every((f) => f === 'OUTCOME_MISMATCH'))
      throw field422(
        'decision',
        'acknowledge_only',
        'OUTCOME_MISMATCH can only be acknowledged (ACCEPT)',
      );

    // ST4-T11 (QA M3): ธงที่กระทบการนับยังไม่ตัดสิน → การตัดสินนี้ = ของธงเหล่านั้นเท่านั้น (ธงแจ้ง OUTCOME_MISMATCH
    // ที่ขึ้นพร้อมกัน/ขึ้นใหม่หลังผลพลิก ยังเปิดอยู่ให้รับทราบแยก) · ตัดสินแล้ว → นี่คือการรับทราบธงแจ้ง (ACCEPT เท่านั้น)
    const core = flags.filter((f) => f !== 'OUTCOME_MISMATCH');
    const key = (fs: readonly string[]) => [...fs].sort().join();
    const coreDone =
      core.length > 0 &&
      (await tx.stopEventResolution.findMany({ where: { stopEventId: e.id } })).some(
        (r) => key(r.flags.filter((f) => f !== 'OUTCOME_MISMATCH')) === key(core),
      );
    const stored = !core.length || coreDone ? flags.filter((f) => f === 'OUTCOME_MISMATCH') : core;
    if (coreDone && decision === 'IGNORE')
      throw field422(
        'decision',
        'acknowledge_only',
        'OUTCOME_MISMATCH can only be acknowledged (ACCEPT)',
      );
    // ST5-T06: การตัดสินที่เปลี่ยนการนับ (ธงอื่นนอกจากธงแจ้ง) = แก้ผลของจุด → ล็อกเมื่อ DO ส่งบัญชีแล้ว/อยู่ในใบ (รับทราบธงแจ้งยังได้)
    if (stored.some((f) => f !== 'OUTCOME_MISMATCH'))
      await this.assertStopUnlocked(tx, e.tripStopId);
    await tx.stopEventResolution.create({
      data: {
        tenantId: ctx.tenantId!,
        stopEventId: e.id,
        tripId: e.tripId,
        decision,
        reason,
        flags: stored,
        resolvedBy: ctx.actorId ?? null,
      },
    });
    await this.audit.record({
      action: 'stop_event.resolve',
      entityType: 'stop_event',
      entityId: e.id,
      before: { flags, sequenceConflict: e.sequenceConflict },
      after: { decision },
      reason,
    });
    await this.resequence(tx, e.tripStopId);
    await this.projection.project(tx, e.tripId);
    return tx.stopEvent.findFirstOrThrow({ where: { id: e.id } });
  }

  /**
   * ST5-T06 (docs/04 F4 RELEASED "แก้ stop/qty ไม่ได้"): จุด (รับหรือส่ง) ของ DO ที่ส่งบัญชีแล้ว/อยู่ในใบแจ้งหนี้ → 409
   * `invalid_state_transition` (`do_released` / `do_in_invoice`) — ส่งซ้ำด้วย clientEventId เดิมตรวจก่อน (ได้แถวเดิม)
   */
  private async assertStopUnlocked(tx: Tx, stopId: string): Promise<void> {
    const billed = await tx.deliveryOrder.findFirst({
      where: {
        status: { not: 'CANCELLED' },
        OR: [{ tripStopId: stopId }, { pickupTripStopId: stopId }],
        AND: [
          {
            OR: [
              { releasedAt: { not: null } },
              { billingStatus: { in: ['IN_DRAFT', 'INVOICED'] } },
            ],
          },
        ],
      },
      select: { doNo: true, status: true, billingStatus: true, releasedAt: true },
      orderBy: { id: 'asc' },
    });
    if (billed) assertDeliveryUnlocked(billed);
  }

  /** เริ่มวันนี้ตามเวลาไทย */
  private startOfToday(): Date {
    const bkk = new Date(this.clock.now().getTime() + 7 * 3600_000);
    return new Date(
      Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()) - 7 * 3600_000,
    );
  }

  /**
   * รายการธง (หน้า ศูนย์ข้อยกเว้น): open = มีธงและไม่มีการตัดสินที่มีผล (รวมที่การตัดสินหมดผลเพราะธงเปลี่ยน)
   * · resolved = มีการตัดสินที่มีผล (`resolution_id`) · ล่าสุดก่อน (received_at แบบ µs + id)
   * ค้นด้วยเลขเที่ยว / ทะเบียน / ชื่อจุด / เลข DO / ชื่อลูกค้า · `resolvedToday` = ตัดสินวันนี้ (การ์ด "ปิดแล้ววันนี้")
   */
  async listFlags(q: {
    status?: 'open' | 'resolved' | 'all';
    flag?: StopEventFlag;
    q?: string;
    resolvedToday?: boolean;
    limit?: number;
    cursor?: string;
  }) {
    const limit = q.limit ?? 25;
    const flagged = Prisma.sql`(e.sequence_conflict OR e.clock_skew OR e.late_reason IS NOT NULL
      OR e.pickup_pending OR e.outcome_mismatch)`;
    const conds: Prisma.Sql[] = [
      q.status === 'open'
        ? Prisma.sql`${flagged} AND e.resolution_id IS NULL`
        : q.status === 'resolved'
          ? Prisma.sql`e.resolution_id IS NOT NULL`
          : Prisma.sql`(${flagged} OR e.resolution_id IS NOT NULL)`,
    ];
    if (q.resolvedToday)
      conds.push(Prisma.sql`EXISTS (SELECT 1 FROM stop_event_resolution r
        WHERE r.id = e.resolution_id AND r.created_at >= ${this.startOfToday()})`);
    if (q.flag === 'LATE') conds.push(Prisma.sql`e.late_reason IS NOT NULL`);
    if (q.flag === 'SEQUENCE_CONFLICT') conds.push(Prisma.sql`e.sequence_conflict`);
    if (q.flag === 'CLOCK_SKEW') conds.push(Prisma.sql`e.clock_skew`);
    if (q.flag === 'PICKUP_NOT_DONE') conds.push(Prisma.sql`e.pickup_pending`);
    if (q.flag === 'OUTCOME_MISMATCH') conds.push(Prisma.sql`e.outcome_mismatch`);
    const text = q.q?.trim();
    if (text) {
      const like = `%${likeEscape(text)}%`;
      conds.push(Prisma.sql`(
        EXISTS (SELECT 1 FROM trip t WHERE t.id = e.trip_id
                 AND (t.trip_no ILIKE ${like} OR t.vehicle_plate_snapshot ILIKE ${like}))
        OR EXISTS (SELECT 1 FROM trip_stop s JOIN customer_site cs ON cs.id = s.site_id
                    LEFT JOIN customer c ON c.id = cs.customer_id
                   WHERE s.id = e.trip_stop_id AND (cs.name ILIKE ${like} OR c.legal_name ILIKE ${like}))
        OR EXISTS (SELECT 1 FROM delivery_order d JOIN customer c ON c.id = d.customer_id
                   WHERE (d.trip_stop_id = e.trip_stop_id OR d.pickup_trip_stop_id = e.trip_stop_id)
                     AND (d.do_no ILIKE ${like} OR c.legal_name ILIKE ${like})))`);
    }
    if (q.cursor) {
      const c = decodeFlagCursor(q.cursor);
      conds.push(Prisma.sql`(e.received_at, e.id) < (${c.r}::timestamptz, ${c.i}::uuid)`);
    }
    const page = await this.db.tx.$queryRaw<{ id: string; r: string }[]>`
      SELECT e.id::text AS id, e.received_at::text AS r FROM stop_event e
       WHERE ${Prisma.join(conds, ' AND ')}
       ORDER BY e.received_at DESC, e.id DESC
       LIMIT ${limit + 1}`;
    const hasMore = page.length > limit;
    const slice = hasMore ? page.slice(0, limit) : page;
    const found = await this.db.tx.stopEvent.findMany({
      where: { id: { in: slice.map((x) => x.id) } },
      include: FLAG_INCLUDE,
    });
    const byId = new Map(found.map((r) => [r.id, r]));
    const rows = slice.map((x) => byId.get(x.id)!).filter(Boolean);
    // สถานะก่อน event (ธงขัดลำดับ) — คำนวณลำดับของจุดที่อยู่ในหน้านี้
    const states = new Map<string, string | null>();
    for (const stopId of new Set(rows.filter((r) => r.sequenceConflict).map((r) => r.tripStopId)))
      for (const e of (await this.sequence(stopId)).events) states.set(e.id, e.stateBefore);
    const last = slice[slice.length - 1];
    return {
      rows: rows.map((r) => ({ ...r, stateBefore: states.get(r.id) ?? null })),
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ r: last.r, i: last.id })).toString('base64url')
          : null,
      hasMore,
    };
  }

  /** ตัวเลขบนการ์ด: ใหม่ (ยังไม่มีการตัดสินที่มีผล) · ตัดสินแล้ว · ตัดสินแล้ววันนี้ (วันตามเวลาไทย) */
  async flagSummary() {
    const flagged: Prisma.StopEventWhereInput = {
      OR: [
        { sequenceConflict: true },
        { clockSkew: true },
        { lateReason: { not: null } },
        { pickupPending: true },
        { outcomeMismatch: true },
      ],
    };
    const [open, resolved, resolvedToday] = await Promise.all([
      this.db.tx.stopEvent.count({ where: { AND: [flagged, { resolutionId: null }] } }),
      this.db.tx.stopEvent.count({ where: { resolutionId: { not: null } } }),
      this.db.tx.stopEvent.count({
        where: { resolution: { createdAt: { gte: this.startOfToday() } } },
      }),
    ]);
    return { open, resolved, resolvedToday };
  }

  /**
   * ไทม์ไลน์ของเที่ยว (ST4-T04): ทุก event ของทุกจุด (รวมจุดที่ถอดแล้ว) ตามลำดับจุด → ลำดับที่มีผลของจุด
   * พร้อมผลของแต่ละตัว (`seqStatus`/`counted`) และการตัดสินที่มีผล — ผู้เรียกตรวจว่าเที่ยวอยู่ในบริษัทแล้ว
   */
  async tripTimeline(tripId: string, tx: Tx = this.db.tx) {
    const rows = await tx.stopEvent.findMany({
      where: { tripId },
      include: {
        resolutions: { orderBy: { createdAt: 'asc' } },
        tripStop: { select: { sequence: true, removedAt: true } },
      },
    });
    const byStop = new Map<string, typeof rows>();
    for (const r of rows) byStop.set(r.tripStopId, [...(byStop.get(r.tripStopId) ?? []), r]);
    const stops = [...byStop.values()].sort(
      (a, b) =>
        Number(a[0]!.tripStop.removedAt !== null) - Number(b[0]!.tripStop.removedAt !== null) ||
        a[0]!.tripStop.sequence - b[0]!.tripStop.sequence,
    );
    return stops.flatMap((evs) => effectiveStopSequence(evs.map(toSeqEvent)).events);
  }

  /**
   * ชื่อผู้ใช้ภายในจาก id (ผู้บันทึก/ผู้ตัดสิน) — id ที่ไม่ใช่ uuid (dev token / ระบบ) = ไม่มีชื่อ
   * · ST4-T08 `link:{id}` = ชื่อรถร่วมของลิงก์
   */
  async userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    return actorNames(this.db.tx, ids);
  }

  /** ธงของ event เดียว (รูปเดียวกับรายการ) */
  async flagById(eventId: string) {
    const r = await this.db.tx.stopEvent.findFirstOrThrow({
      where: { id: eventId },
      include: FLAG_INCLUDE,
    });
    const stateBefore = r.sequenceConflict
      ? ((await this.sequence(r.tripStopId)).events.find((e) => e.id === r.id)?.stateBefore ?? null)
      : null;
    return { ...r, stateBefore };
  }

  /** เหตุผลตามชนิด/ผล (domain `stopEventReasonRule`) → snapshot ลง payload · เหตุผลที่ตั้ง "ต้องมีหมายเหตุ" บังคับ note */
  private async reason(
    type: StopEventType,
    outcome: StopOutcome | null,
    reasonCodeId: string | null,
    note: string | null,
  ): Promise<Readonly<ReasonSnapshot> | null> {
    const rule = stopEventReasonRule(type, outcome);
    if (!reasonCodeId) {
      if (rule.required)
        throw field422(
          'reasonCodeId',
          'required',
          `reason is required for ${type} ${outcome ?? ''}`,
        );
      return null;
    }
    if (!rule.categories.length)
      throw field422('reasonCodeId', 'not_applicable', `no reason for ${type} ${outcome ?? ''}`);
    const snap = await this.reasonCodes.snapshotFor(reasonCodeId, rule.categories);
    if (snap.flags.requiresNote && !note)
      throw field422('note', 'required', `reason ${snap.code} requires a note`);
    // ธง "ต้องมีรูป" ตรวจตอนปิดงานพร้อม POD (ST4-T05/T06 — ชุดตรวจ "ไม่สำเร็จ") — T01 ยังไม่รับรูป
    return snap;
  }
}

export const FLAG_INCLUDE = {
  resolution: true,
  trip: { select: { tripNo: true, status: true, vehiclePlateSnapshot: true } },
  tripStop: {
    select: {
      sequence: true,
      type: true,
      site: { select: { name: true, customer: { select: { legalName: true } } } },
      deliveryOrders: {
        select: { doNo: true, customer: { select: { legalName: true } } },
        orderBy: { doNo: 'asc' },
      },
      pickupOrders: {
        select: { doNo: true, customer: { select: { legalName: true } } },
        orderBy: { doNo: 'asc' },
      },
    },
  },
} satisfies Prisma.StopEventInclude;

function decodeFlagCursor(cursor: string): FlagCursor {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as FlagCursor;
    if (
      typeof v.r !== 'string' ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/.test(v.r) ||
      typeof v.i !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(v.i)
    )
      throw new Error();
    return v;
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}
