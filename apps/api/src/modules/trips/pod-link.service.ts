import { Injectable } from '@nestjs/common';
import type { StopEvent } from '@prisma/client';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { StopEventsService } from '../stops/stop-events.service';
import { arabicDigits } from '../vehicles/vehicles.service';
import { assertLinkWriteRate } from '../../http/link-rate-limit';
import { podLinkUsable } from './offer-links';
import type {
  PodDoDto,
  PodLinkEventDto,
  PodLinkEventResultDto,
  PodLinkViewDto,
  PodStopDto,
} from './pod-link.dto';
import { SubconOfferService } from './subcon-offer.service';

const RECORDABLE = new Set(['DISPATCHED', 'IN_PROGRESS']);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** เลข DO ที่รถร่วมพิมพ์ → รูปเดียวกับ `do_no` (ตัวใหญ่, ไม่มีช่องว่าง, เลขอารบิก) */
export function normalizeDoNo(input: string): string {
  return arabicDigits(input).replace(/\s+/g, '').toUpperCase();
}

const field422 = (field: string, code: string, message: string, detail?: string) =>
  new ProblemException('validation_failed', detail, [{ field, code, message }]);

/**
 * ลิงก์งานของรถร่วม — ส่วนสถานะ (ST4-T08; docs/04 E2 "ePOD ผ่านลิงก์", E2.1 M10, E2.2 ข้อยกเว้น M10, docs/01 §5.5)
 * - ลิงก์ (magic link `pod`) ชี้การจ้างที่ ACCEPTED → เห็นเฉพาะเที่ยวนั้น · ค้น DO ได้เฉพาะ DO ในเที่ยว (spec/04 §5 ข้อ 9)
 * - กดถึง/ออก = `StopEventsService.record` ชุดเดียวกับเว็บ (event model เดียวกัน, `source = LINK`, ผู้บันทึก `link:{id}`)
 *   ส่ง `clientEventId` ทุกครั้ง — ส่งซ้ำ = 200 + event เดิม · ไม่มี outbox (ต้องออนไลน์)
 * - ใช้ได้เมื่อ: การจ้างยัง ACCEPTED + เที่ยวยังเป็นของรถร่วมรายนี้ + ไม่ยกเลิก + เที่ยวจบไม่เกิน 7 วัน — ไม่ผ่าน = 404 (ไม่บอกใบ้)
 */
@Injectable()
export class PodLinkService {
  constructor(
    private readonly db: DbService,
    private readonly offers: SubconOfferService,
    private readonly events: StopEventsService,
    private readonly clock: Clock,
  ) {}

  /** การจ้าง + เที่ยวของลิงก์ — ใช้ไม่ได้แล้ว → 404 */
  private async context(offerId: string) {
    const tx = this.db.tx;
    const offer = await tx.subconOffer.findFirst({
      where: { id: offerId },
      select: { id: true, status: true, tripId: true, carrierId: true },
    });
    if (!offer) throw new ProblemException('not_found');
    const trip = await tx.trip.findFirst({
      where: { id: offer.tripId },
      select: { id: true, status: true, carrierId: true, completedAt: true },
    });
    if (!trip || !podLinkUsable(offer, trip, this.clock.now()))
      throw new ProblemException('not_found');
    return { offer, trip };
  }

  async view(offerId: string, doNo?: string): Promise<PodLinkViewDto> {
    const tx = this.db.tx;
    const { trip } = await this.context(offerId);
    const job = await this.offers.view(offerId, false);
    const dos = await tx.deliveryOrder.findMany({
      where: { tripId: trip.id, status: { not: 'CANCELLED' }, doNo: { not: null } },
      select: {
        id: true,
        doNo: true,
        doDate: true,
        pickupTripStopId: true,
        tripStopId: true,
        customer: { select: { legalName: true } },
      },
      orderBy: { doNo: 'asc' },
    });
    const query = doNo?.trim() ? normalizeDoNo(doNo) : null;
    const hit = query ? dos.find((d) => d.doNo === query) : undefined;
    let match: PodDoDto | null = null;
    if (hit) {
      const stops = await tx.tripStop.findMany({
        where: { tripId: trip.id, removedAt: null },
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          sequence: true,
          status: true,
          outcome: true,
          arrivedAt: true,
          site: { select: { name: true } },
        },
      });
      const seqOf = async (id: string) => this.events.sequence(id, tx);
      const retries: { stopId: string; type: string; n: number }[] = [];
      /** ครั้งที่ผู้จัดรถ "ไม่ใช้" event ชนิดนี้ของจุดนี้ → ลิงก์สร้าง clientEventId ใหม่ได้ (review/QA M2) */
      const countIgnored = (
        stopId: string,
        seq: Awaited<ReturnType<typeof seqOf>>,
        types: string[],
      ) => {
        for (const ty of types) {
          const n = seq.events.filter((e) => e.type === ty && e.seqStatus === 'IGNORED').length;
          if (n) retries.push({ stopId: encodeId('tripStop', stopId), type: ty, n });
        }
      };
      const stopDto = async (id: string | null, role: 'PICKUP' | 'DELIVERY') => {
        const i = stops.findIndex((s) => s.id === id);
        if (i < 0) return null;
        const s = stops[i]!;
        const next = stops[i + 1];
        countIgnored(s.id, await seqOf(s.id), ['ARRIVE', 'COMPLETE']);
        // ออกจากจุด = DEPART ที่นับของจุดถัดไป (docs/01 §3.9 — ไม่ใช้ departed_at ที่ถอยเป็นเวลาปิดงาน)
        const ns = next ? await seqOf(next.id) : null;
        if (next && ns) countIgnored(next.id, ns, ['DEPART']);
        const dto: PodStopDto = {
          id: encodeId('tripStop', s.id),
          role,
          sequence: s.sequence,
          siteName: s.site.name,
          status: s.status,
          outcome: s.outcome,
          arrivedAt: iso(s.arrivedAt),
          leftAt: iso(ns?.enRouteAt ?? null),
          nextStopId: next ? encodeId('tripStop', next.id) : null,
          // QA M1: กด "ออก" ได้เฉพาะเมื่อจุดถัดไปยังไม่มี DEPART/ARRIVE/ปิดที่มีผล (ไม่สร้าง event ขัดลำดับ)
          nextOpen: ns?.state === 'PENDING',
        };
        return dto;
      };
      match = {
        doNo: hit.doNo!,
        doDate: hit.doDate.toISOString().slice(0, 10),
        customerName: hit.customer.legalName,
        pickup: await stopDto(hit.pickupTripStopId, 'PICKUP'),
        delivery: await stopDto(hit.tripStopId, 'DELIVERY'),
        retries,
      };
    }
    return {
      job,
      tripStatus: trip.status,
      recordable: RECORDABLE.has(trip.status),
      doHint: dos[0]?.doNo ?? null,
      query,
      match,
      serverTime: this.clock.now().toISOString(),
    };
  }

  /**
   * กดถึง/ออก/ปิดงานจุดรับ — จุดต้องอยู่ในเที่ยวของลิงก์ (ไม่ใช่ = 404 กันเดา id ข้ามเที่ยว/บริษัท)
   * จุดส่งปิดงานผ่านลิงก์ไม่ได้ใน T08 (ต้องมี POD — ST4-T09) → 422
   */
  async record(
    offerId: string,
    linkId: string,
    stopId: string,
    body: PodLinkEventDto,
  ): Promise<{ result: PodLinkEventResultDto; replayed: boolean }> {
    const tx = this.db.tx;
    const { trip } = await this.context(offerId);
    // review L / NFR-1106: 30 คำขอเขียน/นาที ต่อลิงก์ (ซ้อนกับต่อ IP)
    assertLinkWriteRate(linkId);
    const stop = await tx.tripStop.findFirst({
      where: { id: stopId, tripId: trip.id, removedAt: null },
      select: { id: true, type: true },
    });
    if (!stop) throw new ProblemException('not_found');
    // review M / QA L1: ลิงก์ไม่มี outbox — ไม่รับ event หลังเที่ยวจบ/ก่อนปล่อยรถ (ตรงกับ `recordable` ของหน้า)
    if (!RECORDABLE.has(trip.status))
      throw new ProblemException('trip_not_in_progress', undefined, undefined, {
        tripStatus: trip.status,
      });
    if (body.type === 'COMPLETE' && stop.type !== 'PICKUP')
      throw field422(
        'type',
        'pod_required',
        'delivery stops are closed with POD (not via this action)',
        'จุดส่งปิดงานด้วยการส่ง POD',
      );
    if (body.type === 'COMPLETE' && body.outcome !== 'DELIVERED')
      throw field422('outcome', 'required', 'outcome DELIVERED is required for COMPLETE');
    if (body.type !== 'COMPLETE' && body.outcome)
      throw field422('outcome', 'not_applicable', `outcome not applicable for ${body.type}`);
    let out: { event: StopEvent; replayed: boolean };
    try {
      out = await this.events.record(
        stop.id,
        body.type,
        {
          clientEventId: body.clientEventId,
          occurredAt: body.occurredAt,
          outcome: body.type === 'COMPLETE' ? 'DELIVERED' : null,
          lat: body.lat ?? null,
          lng: body.lng ?? null,
          accuracyM: body.accuracyM ?? null,
        },
        tx,
      );
    } catch (e) {
      // clientEventId ชนกับ event อื่น → 409 โดยไม่ส่ง id ของ event นั้น (อาจเป็นของเที่ยวอื่น)
      if (e instanceof ProblemException && e.code === 'stop_event_duplicate')
        throw new ProblemException('stop_event_duplicate');
      throw e;
    }
    // ผลในลำดับของจุด (QA M2): ไม่นับ (ธง/ขัดลำดับ/เวลาเพี้ยน) → หน้าลิงก์แจ้ง "รอฝ่ายจัดรถตรวจสอบ"
    const seq = await this.events.sequence(stop.id, tx);
    const me = seq.events.find((e) => e.id === out.event.id);
    return {
      result: {
        ...toResult(out.event, out.replayed),
        seqStatus: me?.seqStatus ?? 'APPLIED',
        counted: me?.counted ?? true,
      },
      replayed: out.replayed,
    };
  }
}

function toResult(
  e: StopEvent,
  replayed: boolean,
): Omit<PodLinkEventResultDto, 'seqStatus' | 'counted'> {
  return {
    id: encodeId('event', e.id),
    stopId: encodeId('tripStop', e.tripStopId),
    type: e.type,
    outcome: e.outcome,
    clientEventId: e.clientEventId,
    occurredAt: e.occurredAt.toISOString(),
    receivedAt: e.receivedAt.toISOString(),
    source: e.source,
    replayed,
  };
}
