import { Injectable } from '@nestjs/common';
import type { Prisma, StopEvent } from '@prisma/client';
import {
  isTripExecutable,
  stopEventReasonRule,
  stopOutcomeError,
  type StopEventSource,
  type StopEventType,
  type StopOutcome,
  type TripStatus,
} from '@tms/domain';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
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

/**
 * บันทึก event หน้างานต่อจุดแวะ (ST4-T01; docs/04 E1 Stop event, docs/01 §3.9) — append-only, เวลาสองชุด
 * ตรวจขั้นต่ำ: จุดยังใช้อยู่ · เที่ยว DISPATCHED/IN_PROGRESS · คู่ชนิด/ผล · พิกัดคู่ · เหตุผลตามชนิด/ผล
 * ยังไม่ทำ: คืนผลเดิมเมื่อส่งซ้ำ + เรียงตาม occurredAt + ธงขัดแย้ง (ST4-T02), ไล่สถานะ trip_stop → trip → DO → SO
 * + domain_event `stop.*` (ST4-T03 — สร้างตอน apply ไม่ใช่ตอนรับ: docs/01 §3.9), รูป/ลายเซ็น POD (ST4-T05–T09)
 */
@Injectable()
export class StopEventsService {
  constructor(
    private readonly db: DbService,
    private readonly reasonCodes: ReasonCodesService,
  ) {}

  async record(
    stopId: string,
    type: StopEventType,
    input: StopEventInput,
    tx: Tx = this.db.tx,
  ): Promise<StopEvent> {
    const ctx = requestContext.require();
    const tenantId = ctx.tenantId!;
    const stop = await tx.tripStop.findFirst({
      where: { id: stopId, removedAt: null },
      select: { id: true, tripId: true },
    });
    if (!stop) throw new ProblemException('not_found');

    // ล็อกเที่ยว: event ของเที่ยวเดียวกันเข้าแถวทีละรายการ (ST4-T03 ไล่สถานะเที่ยวต่อจากนี้) + กันชนกับยกเลิกเที่ยว
    const [trip] = await tx.$queryRaw<{ status: TripStatus }[]>`
      SELECT status::text AS status FROM trip WHERE id = ${stop.tripId}::uuid FOR UPDATE`;
    if (!trip) throw new ProblemException('not_found');

    // ส่งซ้ำ (หลังล็อก — คำขอพร้อมกันของเที่ยวเดียวกันเห็นแถวที่ commit แล้ว)
    const dup = await tx.stopEvent.findUnique({
      where: { tenantId_clientEventId: { tenantId, clientEventId: input.clientEventId } },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('stop_event_duplicate', undefined, undefined, {
        eventId: encodeId('event', dup.id),
      });

    if (!isTripExecutable(trip.status))
      throw new ProblemException('trip_not_in_progress', undefined, undefined, {
        tripStatus: trip.status,
      });

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

    return tx.stopEvent.create({
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
        occurredAt: new Date(input.occurredAt),
        payload: payload as Prisma.InputJsonValue,
      },
    });
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
