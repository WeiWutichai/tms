import { Injectable } from '@nestjs/common';
import type { Prisma, StopEvent, StopEventResolution } from '@prisma/client';
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
  type StopSeqResult,
  type TripStatus,
} from '@tms/domain';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { likeEscape } from '../../common/ilike';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { AuditService } from '../../audit/audit.service';
import { ReasonCodesService } from '../reason-codes/reason-codes.service';
import type { ReasonSnapshot } from '../reason-codes/snapshot';

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

export type StopEventWithResolution = StopEvent & { resolutions: StopEventResolution[] };

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

/** แถว → อินพุตของ domain `effectiveStopSequence` */
export function toSeqEvent<E extends StopEventWithResolution>(e: E): E & StopSeqEvent {
  return {
    ...e,
    type: e.type,
    outcome: e.outcome as StopOutcome | null,
    lateReason: e.lateReason as StopEventLateReason | null,
    decision: (e.resolutions[0]?.decision ?? null) as StopEventDecision | null,
  };
}

/** ธงของแถว (ลำดับความสำคัญตาม domain) */
export const flagsOf = (e: StopEvent): StopEventFlag[] =>
  stopEventFlagsOf({
    lateReason: e.lateReason,
    sequenceConflict: e.sequenceConflict,
    clockSkew: e.clockSkew,
  });

interface FlagCursor {
  r: string;
  i: string;
}

/**
 * บันทึก event หน้างานต่อจุดแวะ (ST4-T01/T02; docs/04 E1 Stop event + Idempotent server, docs/01 §3.9) — append-only, เวลาสองชุด
 * T02: ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) = คืนแถวเดิม · เรียงตาม occurredAt แล้วตรวจ state machine ทุกครั้ง
 * (คอลัมน์ `sequence_conflict`) · เวลาเครื่องเพี้ยน → `clock_skew` · มาหลังจุดถูกถอด/เที่ยวยกเลิก/จบ → `late_reason`
 * (รับเก็บ ไม่ทิ้งหลักฐาน — spec/04 DRV-072/075) · dispatcher ตัดสินด้วยแถวใหม่ใน `stop_event_resolution` + เหตุผล + audit
 * ยังไม่ทำ: ไล่สถานะ trip_stop → trip → DO → SO + domain_event `stop.*` (ST4-T03 — ใช้ `sequence()` ของจุด)
 */
@Injectable()
export class StopEventsService {
  constructor(
    private readonly db: DbService,
    private readonly reasonCodes: ReasonCodesService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** ล็อกเที่ยว: event/การตัดสินของเที่ยวเดียวกันเข้าแถวทีละรายการ (ST4-T03 ไล่สถานะเที่ยวต่อจากนี้) + กันชนกับยกเลิกเที่ยว */
  private async lockTrip(tx: Tx, tripId: string): Promise<TripStatus> {
    const [trip] = await tx.$queryRaw<{ status: TripStatus }[]>`
      SELECT status::text AS status FROM trip WHERE id = ${tripId}::uuid FOR UPDATE`;
    if (!trip) throw new ProblemException('not_found');
    return trip.status;
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
    const tripStatus = await this.lockTrip(tx, stop.tripId);

    // ส่งซ้ำ (หลังล็อก — คำขอพร้อมกันของเที่ยวเดียวกันเห็นแถวที่ commit แล้ว)
    const replay = await this.replayOf(tx, tenantId, input.clientEventId, stop.id, type);
    if (replay) return { event: replay, replayed: true };

    const admission = stopEventAdmission(tripStatus, stop.removedAt !== null);
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
    const seq = await this.resequence(tx, stop.id);
    const mine = seq.events.find((e) => e.id === created.id)!;
    return { event: { ...created, sequenceConflict: mine.conflict }, replayed: false };
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

  /** event ทั้งหมดของจุด + การตัดสิน → ลำดับที่มีผล (domain) */
  async sequence(
    stopId: string,
    tx: Tx = this.db.tx,
  ): Promise<StopSeqResult<StopEventWithResolution & StopSeqEvent>> {
    const rows = await tx.stopEvent.findMany({
      where: { tripStopId: stopId },
      include: { resolutions: true },
    });
    return effectiveStopSequence(rows.map(toSeqEvent));
  }

  /**
   * คำนวณลำดับใหม่แล้วเขียน `sequence_conflict` เฉพาะแถวที่ค่าเปลี่ยน (event มาช้าอาจทำให้ event อื่นหายขัด/ขัดขึ้นมา)
   * ต้องถือล็อกเที่ยวอยู่ (ทุกจุดของเที่ยวเดียวกันเข้าแถวทีละรายการ)
   */
  private async resequence(tx: Tx, stopId: string) {
    const seq = await this.sequence(stopId, tx);
    const on = seq.events.filter((e) => e.conflict && !e.sequenceConflict).map((e) => e.id);
    const off = seq.events.filter((e) => !e.conflict && e.sequenceConflict).map((e) => e.id);
    if (on.length)
      await tx.stopEvent.updateMany({
        where: { id: { in: on } },
        data: { sequenceConflict: true },
      });
    if (off.length)
      await tx.stopEvent.updateMany({
        where: { id: { in: off } },
        data: { sequenceConflict: false },
      });
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
  ): Promise<StopEventWithResolution> {
    const ctx = requestContext.require();
    const found = await tx.stopEvent.findFirst({
      where: { id: eventId },
      select: { tripId: true },
    });
    if (!found) throw new ProblemException('not_found');
    await this.lockTrip(tx, found.tripId);
    const e = await tx.stopEvent.findFirstOrThrow({
      where: { id: eventId },
      include: { resolutions: true },
    });
    if (e.resolutions.length) throw new ProblemException('stop_event_already_resolved');
    const flags = flagsOf(e);
    if (!flags.length) throw new ProblemException('stop_event_not_flagged');

    await tx.stopEventResolution.create({
      data: {
        tenantId: ctx.tenantId!,
        stopEventId: e.id,
        tripId: e.tripId,
        decision,
        reason,
        flags,
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
    return tx.stopEvent.findFirstOrThrow({ where: { id: e.id }, include: { resolutions: true } });
  }

  /** เงื่อนไข "มีธง" ของ event (ตรงกับ partial index `stop_event_flagged_idx`) */
  private static readonly FLAGGED: Prisma.StopEventWhereInput = {
    OR: [{ sequenceConflict: true }, { clockSkew: true }, { lateReason: { not: null } }],
  };

  /**
   * รายการธง (หน้า ศูนย์ข้อยกเว้น): open = มีธงและยังไม่ตัดสิน · resolved = ตัดสินแล้ว (แม้ธงหายภายหลัง) · ล่าสุดก่อน
   * ธงที่หายเองก่อนตัดสิน (event ที่ขาดมาถึงแล้ว) ไม่อยู่ในรายการ
   */
  async listFlags(q: {
    status?: 'open' | 'resolved' | 'all';
    flag?: StopEventFlag;
    q?: string;
    limit?: number;
    cursor?: string;
  }) {
    const limit = q.limit ?? 25;
    const open: Prisma.StopEventWhereInput = {
      AND: [StopEventsService.FLAGGED, { resolutions: { none: {} } }],
    };
    const resolved: Prisma.StopEventWhereInput = { resolutions: { some: {} } };
    const and: Prisma.StopEventWhereInput[] = [
      q.status === 'open' ? open : q.status === 'resolved' ? resolved : { OR: [open, resolved] },
    ];
    if (q.flag === 'LATE') and.push({ lateReason: { not: null } });
    if (q.flag === 'SEQUENCE_CONFLICT') and.push({ sequenceConflict: true });
    if (q.flag === 'CLOCK_SKEW') and.push({ clockSkew: true });
    const text = q.q?.trim();
    if (text) {
      const like = { contains: likeEscape(text), mode: 'insensitive' as const };
      and.push({
        OR: [
          { trip: { tripNo: like } },
          { trip: { vehiclePlateSnapshot: like } },
          { tripStop: { site: { name: like } } },
        ],
      });
    }
    if (q.cursor) {
      const c = decodeFlagCursor(q.cursor);
      const r = new Date(c.r);
      and.push({ OR: [{ receivedAt: { lt: r } }, { receivedAt: r, id: { lt: c.i } }] });
    }
    const rows = await this.db.tx.stopEvent.findMany({
      where: { AND: and },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: FLAG_INCLUDE,
    });
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1];
    // สถานะก่อน event (ธงขัดลำดับ) — คำนวณลำดับของจุดที่อยู่ในหน้านี้
    const states = new Map<string, string | null>();
    for (const stopId of new Set(
      slice.filter((r) => r.sequenceConflict).map((r) => r.tripStopId),
    )) {
      for (const e of (await this.sequence(stopId)).events) states.set(e.id, e.stateBefore);
    }
    return {
      rows: slice.map((r) => ({ ...r, stateBefore: states.get(r.id) ?? null })),
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ r: last.receivedAt.toISOString(), i: last.id })).toString(
              'base64url',
            )
          : null,
      hasMore,
    };
  }

  /** ชื่อผู้ใช้ภายในจาก id (ผู้บันทึก/ผู้ตัดสิน) — id ที่ไม่ใช่ uuid (dev token / ระบบ) = ไม่มีชื่อ */
  async userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const uuids = [...new Set(ids.filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)))];
    if (!uuids.length) return new Map();
    const users = await this.db.tx.appUser.findMany({
      where: { id: { in: uuids } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
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

  /** ตัวเลขบนการ์ด: ใหม่ (ยังไม่ตัดสิน) · ตัดสินแล้ว · ตัดสินแล้ววันนี้ (วันตามเวลาไทย) */
  async flagSummary() {
    const now = this.clock.now();
    const bkk = new Date(now.getTime() + 7 * 3600_000);
    const startOfDay = new Date(
      Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()) - 7 * 3600_000,
    );
    const [open, resolved, resolvedToday] = await Promise.all([
      this.db.tx.stopEvent.count({
        where: { AND: [StopEventsService.FLAGGED, { resolutions: { none: {} } }] },
      }),
      this.db.tx.stopEventResolution.count(),
      this.db.tx.stopEventResolution.count({ where: { createdAt: { gte: startOfDay } } }),
    ]);
    return { open, resolved, resolvedToday };
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
  resolutions: true,
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
      Number.isNaN(Date.parse(v.r)) ||
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
