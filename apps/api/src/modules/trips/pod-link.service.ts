import { Injectable } from '@nestjs/common';
import type { DeliveryOrderPod, StopEvent } from '@prisma/client';
import { isStopCloseType, type PodMissing } from '@tms/domain';
import { Clock } from '../../common/clock';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { signDocumentUrl, UPLOAD_TTL_S } from '../documents/signed-url';
import { lockKey } from '../master/master-kit';
import { PodChecklistService } from '../pod/pod-checklist.service';
import type { DeliveryOrderPodDto, SubmitPodDto } from '../pod/pod.dto';
import { PodService } from '../pod/pod.service';
import { StopEventsService } from '../stops/stop-events.service';
import { DeliveryOrderService } from '../delivery-orders/delivery-order.service';
import { arabicDigits } from '../vehicles/vehicles.service';
import { linkWriteBucket } from '../../http/link-rate-limit';
import { RateLimitService } from '../../http/rate-limit/rate-limit.service';
import { podLinkUsable } from './offer-links';
import {
  POD_LINK_FILE_MIME,
  POD_LINK_IMAGE_MIME,
  POD_LINK_PHOTOS_MAX,
  type PodDoDto,
  type PodLinkCaptureDto,
  type PodLinkCaptureResultDto,
  type PodLinkDoPodDto,
  type PodLinkEventDto,
  type PodLinkEventResultDto,
  type PodLinkFileDto,
  type PodLinkFileReserveDto,
  type PodLinkViewDto,
  type PodStopDto,
} from './pod-link.dto';
import { SubconOfferService } from './subcon-offer.service';

/** ไฟล์ POD ที่ลิงก์จองได้ต่อ DO (รูป 5 + ลายเซ็น + ไฟล์ + เผื่อถ่ายใหม่) และต่อชั่วโมงต่อลิงก์ — กันใช้เป็นที่เก็บไฟล์ */
export const LINK_POD_FILES_PER_DO = 20;
export const LINK_POD_FILES_PER_HOUR = 60;
/** stored_document ของหลักฐานส่ง: entity = DO (กฎเดียวกับ PodService — ไฟล์ผูกกับ DO นี้ตั้งแต่จอง) */
const POD_ENTITY = 'delivery_order';
/** DO ที่ส่ง POD อย่างเดียว (จุดส่งปิดแล้ว) ผ่านลิงก์ได้ — ส่งไม่สำเร็จ/คืนคลัง = ผู้จัดรถ */
const SUBMITTABLE = new Set(['DELIVERED', 'POD_PENDING', 'UNBILLED']);
const FIELD_OF_MISSING: Record<string, string> = {
  PHOTO: 'photoDocumentIds',
  SIGNATURE: 'signatureDocumentId',
  NOTE: 'note',
  BARCODE: 'barcodes',
  PIN: 'pin',
  RATING: 'rating',
};

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
    private readonly pods: PodService,
    private readonly checklist: PodChecklistService,
    private readonly limiter: RateLimitService,
    private readonly dos: DeliveryOrderService,
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

  async view(offerId: string, linkId: string, doNo?: string): Promise<PodLinkViewDto> {
    const tx = this.db.tx;
    const { trip } = await this.context(offerId);
    const job = await this.offers.view(offerId, false);
    const all = await tx.deliveryOrder.findMany({
      where: { tripId: trip.id, doNo: { not: null } },
      select: {
        id: true,
        doNo: true,
        doDate: true,
        pickupTripStopId: true,
        tripStopId: true,
        status: true,
        podStatus: true,
        customerId: true,
        customer: { select: { legalName: true } },
      },
      orderBy: { doNo: 'asc' },
    });
    // review M1 (Q-LINK): ใบที่ยกเลิกเพราะนัดส่งใหม่อัตโนมัติ (redeliver) = ส่งไม่สำเร็จของเที่ยวนี้ — ยังค้น/เห็นผล "แจ้งไม่สำเร็จแล้ว" ได้
    // (กฎเดียวกับ PodService.effectiveStatus) · ยกเลิกทางอื่น = ไม่แสดง
    const dos = [];
    for (const d of all)
      if (d.status !== 'CANCELLED' || (await this.dos.isRedeliverCancelled(tx, d.id, d.status)))
        dos.push(d);
    // หลักฐานฉบับล่าสุดต่อ DO (ST4-T09) — "ส่งแล้ว" ของลิงก์นี้ + DO ที่มี POD แล้วส่งซ้ำไม่ได้
    const latestPod = new Map<
      string,
      { createdBy: string | null; photos: number; outcome: string }
    >();
    if (dos.length)
      for (const p of await tx.deliveryOrderPod.findMany({
        where: { deliveryOrderId: { in: dos.map((d) => d.id) } },
        orderBy: { version: 'desc' },
        select: { deliveryOrderId: true, createdBy: true, photoDocumentIds: true, outcome: true },
      }))
        if (!latestPod.has(p.deliveryOrderId))
          latestPod.set(p.deliveryOrderId, {
            createdBy: p.createdBy,
            photos: p.photoDocumentIds.length,
            outcome: p.outcome,
          });
    const recordable = RECORDABLE.has(trip.status);
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
        countIgnored(s.id, await seqOf(s.id), ['ARRIVE', 'LOADED', 'COMPLETE', 'FAIL']);
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
      const delivery = await stopDto(hit.tripStopId, 'DELIVERY');
      const sent = latestPod.has(hit.id);
      const cl = await this.checklist.forCustomer(hit.customerId, 'SUCCESS');
      // ST4-T10 บรรทัดสินค้า + เหตุผลปฏิเสธรับ (ไม่มีราคา)
      const [doLines, reasons, failReasons] = await Promise.all([
        tx.deliveryOrderLine.findMany({
          where: { deliveryOrderId: hit.id },
          orderBy: { lineNo: 'asc' },
          select: {
            id: true,
            lineNo: true,
            description: true,
            unit: true,
            qtyPlanned: true,
            salesOrderLine: { select: { unitRef: { select: { nameTh: true } } } },
          },
        }),
        tx.reasonCode.findMany({
          where: { category: 'REJECTED_BY_RECEIVER', status: 'ACTIVE', deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
          select: { id: true, labelTh: true, requiresNote: true, requiresPhoto: true },
        }),
        // D-81 · D68-39 เหตุผลแจ้งไม่สำเร็จ/บางส่วนผ่านลิงก์ (หมวดเดียวกับที่ StopEventsService รับ)
        // Q-LINK (PO 24 พ.ย. 2569): เหตุผลที่บังคับรูปแสดงด้วย — แจ้งไม่สำเร็จแนบรูปได้ (`failurePhotos`);
        // รับบางส่วนที่จุดรับยังแนบรูปไม่ได้ → หน้าลิงก์ซ่อนเหตุผลบังคับรูปเฉพาะกรณีนั้น
        tx.reasonCode.findMany({
          where: {
            category: { in: ['DELIVERY_FAILED', 'REJECTED_BY_RECEIVER'] },
            status: 'ACTIVE',
            deletedAt: null,
          },
          orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
          select: {
            id: true,
            category: true,
            labelTh: true,
            requiresNote: true,
            requiresPhoto: true,
          },
        }),
      ]);
      const pod: PodLinkDoPodDto = {
        mode: sent
          ? null
          : recordable && delivery?.status === 'ARRIVED'
            ? 'CLOSE'
            : SUBMITTABLE.has(hit.status)
              ? 'SUBMIT'
              : null,
        sent,
        podStatus: hit.podStatus,
        photosMax: POD_LINK_PHOTOS_MAX,
        fields: cl.fields
          .filter((f) => f.level !== 'DISABLED')
          .map((f) => ({
            key: f.key,
            type: f.type,
            level: f.level,
            ...(f.label !== undefined ? { label: f.label } : {}),
            ...(f.minCount !== undefined ? { minCount: f.minCount } : {}),
            ...(f.options !== undefined ? { options: f.options } : {}),
            ...(f.length !== undefined ? { length: f.length } : {}),
            ...(f.max !== undefined ? { max: f.max } : {}),
          })),
        lines: doLines.map((l) => ({
          doLineId: encodeId('deliveryOrderLine', l.id),
          lineNo: l.lineNo,
          description: l.description,
          unit: l.salesOrderLine?.unitRef?.nameTh ?? l.unit,
          qtyPlanned: l.qtyPlanned.toFixed(3).replace(/\.?0+$/, '') || '0',
        })),
        rejectReasons: reasons.map((r) => ({
          id: encodeId('reasonCode', r.id),
          label: r.labelTh,
          requiresNote: r.requiresNote,
          requiresPhoto: r.requiresPhoto,
        })),
      };
      match = {
        doNo: hit.doNo!,
        doDate: hit.doDate.toISOString().slice(0, 10),
        customerName: hit.customer.legalName,
        pickup: await stopDto(hit.pickupTripStopId, 'PICKUP'),
        delivery,
        retries,
        pod,
        failReasons: failReasons.map((r) => ({
          id: encodeId('reasonCode', r.id),
          category: r.category,
          label: r.labelTh,
          requiresNote: r.requiresNote,
          requiresPhoto: r.requiresPhoto,
        })),
      };
    }
    const me = `link:${linkId}`;
    return {
      job,
      tripStatus: trip.status,
      recordable,
      doHint: dos[0]?.doNo ?? null,
      query,
      match,
      sent: dos.flatMap((d) => {
        const p = latestPod.get(d.id);
        // Q-LINK: รูปแจ้งไม่สำเร็จ (ชุด FAILURE) ไม่ใช่ "ส่ง POD แล้ว"
        return p && p.createdBy === me && p.outcome === 'SUCCESS'
          ? [{ doNo: d.doNo!, photoCount: p.photos }]
          : [];
      }),
      serverTime: this.clock.now().toISOString(),
    };
  }

  /**
   * กดถึง/ออก/ปิดงาน — จุดต้องอยู่ในเที่ยวของลิงก์ (ไม่ใช่ = 404 กันเดา id ข้ามเที่ยว/บริษัท)
   * ST4-T09 ปิดงานจุดส่ง = COMPLETE + `pod` (หลักฐานของ DO ที่จุดนี้) ในคำขอ/transaction เดียว:
   * ต้องกดถึงจุดส่งแล้ว (409 `stop_not_arrived`; ปิดแล้ว/แข่งกัน `stop_already_closed`; จุดก่อนหน้ายังไม่ปิด/ขัดลำดับ `stop_not_ready`) · POD ต้องครบ checklist (422 `pod_incomplete` — ไม่ปิดงาน) ·
   * DO อื่นที่จุดเดียวกันเป็น DELIVERED → POD_PENDING/UNBILLED ตาม checklist ของตัวเอง (เหมือนปิดงานในเว็บ) แล้วส่ง POD ภายหลังได้
   * · ส่งซ้ำ clientEventId เดิม = 200 + ผลเดิม (ไม่บันทึก POD ซ้ำ)
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
    await this.limiter.assert([linkWriteBucket(linkId)]);
    const stop = await tx.tripStop.findFirst({
      where: { id: stopId, tripId: trip.id, removedAt: null },
      select: { id: true, type: true, status: true },
    });
    if (!stop) throw new ProblemException('not_found');
    // ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) → คืนผลเดิมแม้เที่ยวจบไปแล้ว (เช่น ปิดจุดสุดท้ายแล้วเน็ตหลุด — ST4-T09)
    const prior = await tx.stopEvent.findFirst({
      where: { clientEventId: body.clientEventId },
      select: { tripStopId: true, type: true },
    });
    const isReplay = prior?.tripStopId === stop.id && prior.type === body.type;
    // review M / QA L1: ลิงก์ไม่มี outbox — ไม่รับ event หลังเที่ยวจบ/ก่อนปล่อยรถ (ตรงกับ `recordable` ของหน้า)
    if (!isReplay && !RECORDABLE.has(trip.status))
      throw new ProblemException('trip_not_in_progress', undefined, undefined, {
        tripStatus: trip.status,
      });
    const close = isStopCloseType(body.type);
    const outcome = body.outcome ?? null;
    // จุดคืนสินค้า (RETURN) ปิดงานผ่านลิงก์ไม่ได้ (ผู้จัดรถทำในเว็บ)
    if (close && stop.type === 'RETURN')
      throw field422('type', 'not_applicable', 'return stops cannot be closed via this link');
    // D-81 · D68-39 (docs/01 §3.9): ขึ้นของเสร็จ = จุดรับเท่านั้น · ปิดจุดรับครบใช้ LOADED (ไม่ใช่ COMPLETE DELIVERED)
    if (body.type === 'LOADED' && stop.type !== 'PICKUP')
      throw field422('type', 'not_applicable', 'LOADED is only for pickup stops');
    if (body.type === 'COMPLETE' && !outcome)
      throw field422('outcome', 'required', 'outcome is required for COMPLETE');
    if (body.type === 'COMPLETE' && stop.type === 'PICKUP' && outcome === 'DELIVERED')
      throw field422('outcome', 'not_applicable', 'close a pickup stop with LOADED');
    if (!(body.type === 'COMPLETE' || body.type === 'FAIL') && outcome)
      throw field422('outcome', 'not_applicable', `outcome not applicable for ${body.type}`);
    // เหตุผล/หมายเหตุ: เฉพาะแจ้งไม่สำเร็จหรือบางส่วน — บางส่วนผ่านลิงก์บังคับเหตุผล (D68-39 "พร้อมเหตุผล")
    const short = body.type === 'FAIL' || (body.type === 'COMPLETE' && outcome !== 'DELIVERED');
    if (!short && (body.reasonCodeId || body.note))
      throw field422(
        body.reasonCodeId ? 'reasonCodeId' : 'note',
        'not_applicable',
        `reason/note not accepted for ${body.type}${outcome ? ` ${outcome}` : ''} via this link`,
      );
    if (short && !body.reasonCodeId)
      throw field422('reasonCodeId', 'required', 'reason is required');
    // Q-LINK รูปประกอบ: ผลไม่สำเร็จ (DO เป็นส่งไม่สำเร็จ) → หลักฐานชุด "ไม่สำเร็จ" ของ DO ·
    // รับบางส่วนที่จุดรับ (DO ยังวิ่งต่อ — ไม่มีชุดหลักฐานให้ใส่) → แนบกับ event (`payload.photoDocumentIds`, เห็นในไทม์ไลน์)
    const failOutcome =
      body.type === 'FAIL' ||
      (body.type === 'COMPLETE' && (outcome === 'FAILED' || outcome === 'UNDELIVERED_RETAIN'));
    const pickupPartial =
      body.type === 'COMPLETE' && outcome === 'PARTIAL' && stop.type === 'PICKUP';
    const failPhotos = body.failurePhotos;
    if (failPhotos && !failOutcome && !pickupPartial)
      throw field422(
        'failurePhotos',
        'not_applicable',
        'failurePhotos is accepted only with FAIL, COMPLETE FAILED/UNDELIVERED_RETAIN, or COMPLETE PARTIAL at a pickup stop',
      );
    const closeDrop =
      body.type === 'COMPLETE' &&
      stop.type === 'DELIVERY' &&
      (outcome === 'DELIVERED' || outcome === 'PARTIAL');
    // review M1: เหตุผลที่ "ต้องมีรูป" — ผ่านลิงก์ใช้ได้เฉพาะส่งบางส่วนพร้อม POD ที่มีรูป (แจ้งไม่สำเร็จแนบรูปไม่ได้)
    // id ผิด/บริษัทอื่น/หมวดไม่ตรง → ให้ StopEventsService ตอบ 422 ตามเดิม (`reason_not_found` ฯลฯ)
    if (short && body.reasonCodeId) {
      const rid = tryDecodeId('reasonCode', body.reasonCodeId);
      const rc = rid
        ? await tx.reasonCode.findFirst({ where: { id: rid }, select: { requiresPhoto: true } })
        : null;
      if (
        rc?.requiresPhoto &&
        !(closeDrop && body.pod?.photoDocumentIds?.length) &&
        !failPhotos?.photoDocumentIds.length
      )
        throw field422(
          'reasonCodeId',
          'photo_required',
          'this reason requires a photo — attach failurePhotos (or pod photos for a partial delivery)',
        );
    }
    if (closeDrop && !body.pod)
      throw field422(
        'pod',
        'pod_required',
        'proof of delivery (pod) is required to close a delivery stop',
        'จุดส่งปิดงานด้วยการส่ง POD',
      );
    if (!closeDrop && body.pod)
      throw field422(
        'pod',
        'not_applicable',
        'pod is accepted only with COMPLETE (DELIVERED/PARTIAL) of a delivery stop',
      );
    // ปิดงานผ่านลิงก์ไม่สร้าง event ขัดลำดับ (ลิงก์ไม่มีหน้าตัดสินธง): ปิดแล้ว → 409 · ปิดด้วยผล (LOADED/COMPLETE) ต้องถึงจุดก่อน
    if (close && !isReplay && !closeDrop) {
      if (stop.status === 'COMPLETED' || stop.status === 'FAILED' || stop.status === 'SKIPPED')
        throw new ProblemException('stop_already_closed');
      if (body.type !== 'FAIL' && stop.status !== 'ARRIVED')
        throw new ProblemException('stop_not_arrived');
    }
    // ST4-T09 ปิดงานจุดส่ง: DO ต้องส่งที่จุดนี้ · ตรวจก่อนสร้าง event (ส่งซ้ำ clientEventId เดิมข้ามไปคืนผลเดิม)
    let dropDo: LinkDo | null = null;
    if (closeDrop) {
      dropDo = await tx.deliveryOrder.findFirst({
        where: {
          tripId: trip.id,
          tripStopId: stop.id,
          doNo: normalizeDoNo(body.pod!.doNo),
          status: { not: 'CANCELLED' },
        },
        select: LINK_DO,
      });
      if (!dropDo)
        throw field422('pod.doNo', 'not_found', 'delivery order is not delivered at this stop');
      if (!isReplay) {
        if (stop.status === 'PENDING') throw new ProblemException('stop_not_arrived');
        // ปิด/ข้ามไปแล้ว (เช่น ผู้จัดรถปิดแทน) → ส่ง POD อย่างเดียวที่ POST …/pod
        if (stop.status !== 'ARRIVED') throw new ProblemException('stop_already_closed');
        if (await tx.deliveryOrderPod.count({ where: { deliveryOrderId: dropDo.id } }))
          throw new ProblemException('pod_exists');
        await this.assertLinkFiles(linkId, dropDo.id, body.pod!, 'pod.');
      }
    }
    // Q-LINK: DO ของรูปต้องรับ/ส่งที่จุดนี้ · ยังไม่มีหลักฐาน · ไฟล์จองผ่านลิงก์นี้สำหรับ DO นี้
    let failDo: LinkDo | null = null;
    if (failPhotos) {
      failDo = await tx.deliveryOrder.findFirst({
        where: {
          tripId: trip.id,
          doNo: normalizeDoNo(failPhotos.doNo),
          OR: [{ tripStopId: stop.id }, { pickupTripStopId: stop.id }],
          // ส่งซ้ำ: ใบเดิมอาจถูกยกเลิกด้วยนัดส่งใหม่อัตโนมัติแล้ว (ST4-T12)
          ...(isReplay ? {} : { status: { not: 'CANCELLED' } }),
        },
        select: LINK_DO,
      });
      if (!failDo)
        throw field422('failurePhotos.doNo', 'not_found', 'delivery order is not at this stop');
      if (!isReplay) {
        if (
          !pickupPartial &&
          (await tx.deliveryOrderPod.count({ where: { deliveryOrderId: failDo.id } }))
        )
          throw new ProblemException('pod_exists');
        await this.assertLinkFiles(
          linkId,
          failDo.id,
          { doNo: failPhotos.doNo, photoDocumentIds: failPhotos.photoDocumentIds },
          'failurePhotos.',
        );
      }
    }
    let out: { event: StopEvent; replayed: boolean };
    try {
      out = await this.events.record(
        stop.id,
        body.type,
        {
          clientEventId: body.clientEventId,
          occurredAt: body.occurredAt,
          outcome,
          reasonCodeId: body.reasonCodeId ?? null,
          note: body.note ?? null,
          ...(failPhotos && pickupPartial
            ? {
                photoDocumentIds: failPhotos.photoDocumentIds.map((x) =>
                  tryDecodeId('document', x)!,
                ),
              }
            : {}),
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
    let pod: PodLinkCaptureResultDto | undefined;
    if (dropDo) {
      if (out.replayed) {
        const v = await this.pods.view(dropDo.id, tx);
        pod = v.current ? captureResult(dropDo.doNo!, v, true) : undefined;
      } else {
        // ปิดงานไม่มีผล → DO ยังไม่ส่ง บันทึก POD ไม่ได้ — ยกเลิกทั้งคำขอ (rollback event ด้วย):
        // จุดถูกปิดโดยคำขออื่นที่มาก่อน (แข่งกัน) = `stop_already_closed` · อื่น ๆ (จุดรับยังไม่ปิด/ขัดลำดับ) = `stop_not_ready`
        const now = await tx.deliveryOrder.findFirst({
          where: { id: dropDo.id },
          select: { status: true },
        });
        if ((me && !me.counted) || !now || !SUBMITTABLE.has(now.status)) {
          const closedByOther = seq.events.some(
            (e) => e.id !== out.event.id && isStopCloseType(e.type) && e.counted,
          );
          throw new ProblemException(closedByOther ? 'stop_already_closed' : 'stop_not_ready');
        }
        // ST4-T10 QA L3: ข้อผิดพลาดรายช่องของ POD ในคำขอปิดงานอ้างตามรูป body (`pod.…`) เหมือนที่ DTO ตรวจ
        pod = await this.submitPod(dropDo, body.pod!).catch((e: unknown) => {
          if (e instanceof ProblemException && e.errors?.length)
            throw new ProblemException(
              e.code,
              e.detail,
              e.errors.map((x) => ({
                ...x,
                field: x.field.startsWith('pod') ? x.field : `pod.${x.field}`,
              })),
              e.extra,
            );
          throw e;
        });
      }
    }
    if (failDo && !pickupPartial) {
      if (out.replayed) {
        const v = await this.pods.view(failDo.id, tx);
        pod = v.current ? captureResult(failDo.doNo!, v, true) : undefined;
      } else {
        // event ไม่ถูกนับ (ธง/ขัดลำดับ) → DO ยังไม่เป็นส่งไม่สำเร็จ บันทึกชุด "ไม่สำเร็จ" ไม่ได้ — ยกเลิกทั้งคำขอ
        if (me && !me.counted) throw new ProblemException('stop_not_ready');
        pod = await this.submitFailurePhotos(failDo, failPhotos!.photoDocumentIds, body.note);
      }
    }
    return {
      result: {
        ...toResult(out.event, out.replayed),
        seqStatus: me?.seqStatus ?? 'APPLIED',
        counted: me?.counted ?? true,
        ...(pod ? { pod } : {}),
      },
      replayed: out.replayed,
    };
  }

  /**
   * ST4-T09 ส่ง POD อย่างเดียว — จุดส่งปิดแล้ว (DO DELIVERED/POD_PENDING/UNBILLED) และ DO ยังไม่มีหลักฐาน
   * ส่งซ้ำชุดไฟล์เดิมจากลิงก์เดิม = 200 ผลเดิม · DO มีหลักฐานอื่นแล้ว = 409 `pod_exists` · จุดส่งยังไม่ปิด = 409 `pod_not_allowed`
   */
  async capture(
    offerId: string,
    linkId: string,
    body: PodLinkCaptureDto,
  ): Promise<{ result: PodLinkCaptureResultDto; replayed: boolean }> {
    const tx = this.db.tx;
    const { trip } = await this.context(offerId);
    await this.limiter.assert([linkWriteBucket(linkId)]);
    const d = await this.doOf(trip.id, body.doNo);
    const latest = await tx.deliveryOrderPod.findFirst({
      where: { deliveryOrderId: d.id },
      orderBy: { version: 'desc' },
    });
    if (latest) {
      if (latest.createdBy === `link:${linkId}` && sameFiles(latest, body))
        return {
          result: captureResult(d.doNo!, await this.pods.view(d.id, tx), true),
          replayed: true,
        };
      throw new ProblemException('pod_exists');
    }
    if (!SUBMITTABLE.has(d.status))
      throw new ProblemException('pod_not_allowed', undefined, undefined, { doStatus: d.status });
    await this.assertLinkFiles(linkId, d.id, body);
    return { result: await this.submitPod(d, body), replayed: false };
  }

  /**
   * ST4-T09 จองไฟล์ POD ของ DO ในเที่ยว → URL อัปโหลดที่มีลายเซ็น (PUT /v1/documents/{id}/content ตรวจขนาด + MIME จริง)
   * ไฟล์ผูกกับ DO + ลิงก์ตั้งแต่จอง (`entity = delivery_order`, `created_by = link:{id}`) → ใช้ได้เฉพาะ POD ของ DO นี้ผ่านลิงก์นี้
   */
  async reserveFile(
    offerId: string,
    linkId: string,
    body: PodLinkFileReserveDto,
    origin: string,
  ): Promise<PodLinkFileDto> {
    const tx = this.db.tx;
    const { trip } = await this.context(offerId);
    await this.limiter.assert([linkWriteBucket(linkId)]);
    const d = await this.doOf(trip.id, body.doNo);
    const mimes: readonly string[] =
      body.kind === 'POD_FILE' ? POD_LINK_FILE_MIME : POD_LINK_IMAGE_MIME;
    if (!mimes.includes(body.mime))
      throw field422('mime', 'mime_not_allowed', `mime is not allowed for ${body.kind}`);
    if (await tx.deliveryOrderPod.count({ where: { deliveryOrderId: d.id } }))
      throw new ProblemException('pod_exists');
    const actor = `link:${linkId}`;
    // ลิงก์เดียวกันจองทีละคำขอ (นับเพดานถูก)
    await lockKey(tx, `pod_link.files:${linkId}`);
    const perDo = await tx.storedDocument.count({
      where: { createdBy: actor, entityType: POD_ENTITY, entityId: d.id },
    });
    if (perDo >= LINK_POD_FILES_PER_DO)
      throw new ProblemException('rate_limited', 'file limit for this delivery order reached');
    const hour = await tx.storedDocument.count({
      where: {
        createdBy: actor,
        createdAt: { gt: new Date(this.clock.now().getTime() - 3600_000) },
      },
    });
    if (hour >= LINK_POD_FILES_PER_HOUR) {
      // retryAfter = เมื่อไฟล์เก่าสุดในชั่วโมงหลุดหน้าต่าง (วินาที)
      const oldest = await tx.storedDocument.findFirst({
        where: {
          createdBy: actor,
          createdAt: { gt: new Date(this.clock.now().getTime() - 3600_000) },
        },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      const retryAfter = Math.max(
        1,
        Math.ceil(
          ((oldest?.createdAt.getTime() ?? 0) + 3600_000 - this.clock.now().getTime()) / 1000,
        ),
      );
      throw new ProblemException(
        'rate_limited',
        'too many files for this link — try again later',
        undefined,
        { retryAfter },
      );
    }
    const doc = await tx.storedDocument.create({
      data: {
        tenantId: requestContext.require().tenantId!,
        status: 'PENDING',
        kind: body.kind,
        mimeType: body.mime,
        sizeBytes: body.bytes,
        filename: body.filename ?? null,
        entityType: POD_ENTITY,
        entityId: d.id,
        createdBy: actor,
      },
    });
    const sig = signDocumentUrl('upload', doc.tenantId, doc.id, UPLOAD_TTL_S);
    const id = encodeId('document', doc.id);
    return {
      id,
      uploadUrl: `${origin.replace(/\/+$/, '')}/v1/documents/${id}/content?${sig.query}`,
      urlExpiresAt: sig.expiresAt.toISOString(),
    };
  }

  /** DO ของเที่ยวด้วยเลข (ปรับรูปแล้ว) — ไม่ใช่ของเที่ยวนี้/ยกเลิก → 404 (ไม่บอกใบ้) */
  private async doOf(tripId: string, doNo: string): Promise<LinkDo> {
    const d = await this.db.tx.deliveryOrder.findFirst({
      where: { tripId, doNo: normalizeDoNo(doNo), status: { not: 'CANCELLED' } },
      select: LINK_DO,
    });
    if (!d) throw new ProblemException('not_found');
    return d;
  }

  /**
   * ไฟล์ใน POD ต้องจองผ่านลิงก์นี้สำหรับ DO นี้ — ไฟล์อื่น (เว็บ/ลิงก์อื่น/DO อื่น/บริษัทอื่น) = `not_found`
   * (ไม่บอกว่ามีอยู่) · ชนิด/สถานะอัปโหลด/ซ้ำ ตรวจต่อที่ PodService
   */
  private async assertLinkFiles(linkId: string, doId: string, pod: PodLinkCaptureDto, prefix = '') {
    const groups: [string, string[]][] = [
      ['photoDocumentIds', pod.photoDocumentIds ?? []],
      ['fileDocumentIds', pod.fileDocumentIds ?? []],
      ['signatureDocumentId', pod.signatureDocumentId ? [pod.signatureDocumentId] : []],
    ];
    const ids = groups.flatMap(([, v]) => v.map((x) => tryDecodeId('document', x)));
    const real = ids.filter((x): x is string => !!x);
    const own = new Set(
      real.length
        ? (
            await this.db.tx.storedDocument.findMany({
              where: {
                id: { in: real },
                createdBy: `link:${linkId}`,
                entityType: POD_ENTITY,
                entityId: doId,
              },
              select: { id: true },
            })
          ).map((r) => r.id)
        : [],
    );
    const errors: FieldError[] = [];
    for (const [field, v] of groups)
      v.forEach((x, i) => {
        const id = tryDecodeId('document', x);
        if (!id || !own.has(id))
          errors.push({
            field: prefix + (field === 'signatureDocumentId' ? field : `${field}.${i}`),
            code: 'not_found',
            message: 'document not found',
          });
      });
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
  }

  /** บันทึกผ่าน PodService (source LINK, ฉบับแรกเท่านั้น) แล้วบังคับครบ checklist — ไม่ครบ = 422 (ยกเลิกทั้งคำขอ) */
  private async submitPod(d: LinkDo, pod: PodLinkCaptureDto): Promise<PodLinkCaptureResultDto> {
    const input: SubmitPodDto = {
      photoDocumentIds: pod.photoDocumentIds ?? [],
      fileDocumentIds: pod.fileDocumentIds ?? [],
      signatureDocumentId: pod.signatureDocumentId ?? null,
      note: pod.note ?? null,
      checks: pod.checks ?? {},
      choices: pod.choices ?? {},
      barcodes: pod.barcodes ?? [],
      pin: pod.pin ?? null,
      rating: pod.rating ?? null,
      ...(pod.lines?.length ? { lines: pod.lines } : {}),
    };
    let v: DeliveryOrderPodDto;
    try {
      v = await this.pods.submit(d.id, input, { source: 'LINK', expectedVersion: 0 });
    } catch (e) {
      // มีฉบับอื่นเข้ามาก่อน (คำขอพร้อมกัน/ผู้จัดรถบันทึก) — ลิงก์แก้หลักฐานไม่ได้
      if (e instanceof ProblemException && e.code === 'precondition_failed')
        throw new ProblemException('pod_exists');
      throw e;
    }
    if (v.missing.length)
      throw new ProblemException(
        'pod_incomplete',
        undefined,
        v.missing.map((m) => ({
          field:
            FIELD_OF_MISSING[m.type] ?? `${m.type === 'BOOLEAN' ? 'checks' : 'choices'}.${m.key}`,
          code: m.code,
          message: `${m.type} is ${m.code}`,
        })),
        { missing: v.missing as PodMissing[] },
      );
    return captureResult(d.doNo!, v, false);
  }

  /**
   * Q-LINK รูปประกอบการแจ้งไม่สำเร็จ → หลักฐานชุด "ไม่สำเร็จ" ของ DO (PodService เลือกชุดตามสถานะ DO — FAILED/ยกเลิกด้วยนัดส่งใหม่)
   * ไม่บังคับครบ checklist ชุดไม่สำเร็จ (ลิงก์ไม่มีช่องอื่น — ผู้จัดรถเติมในเว็บได้) · DO ยังไม่เป็นส่งไม่สำเร็จ → 409 `stop_not_ready`
   */
  private async submitFailurePhotos(
    d: LinkDo,
    photoDocumentIds: string[],
    note: string | null | undefined,
  ): Promise<PodLinkCaptureResultDto> {
    const input: SubmitPodDto = {
      photoDocumentIds,
      fileDocumentIds: [],
      signatureDocumentId: null,
      note: note?.trim() ? note.trim() : null,
      checks: {},
      choices: {},
      barcodes: [],
      pin: null,
      rating: null,
    };
    try {
      return captureResult(
        d.doNo!,
        await this.pods.submit(d.id, input, { source: 'LINK', expectedVersion: 0 }),
        false,
      );
    } catch (e) {
      if (e instanceof ProblemException && e.code === 'precondition_failed')
        throw new ProblemException('pod_exists');
      if (e instanceof ProblemException && e.code === 'pod_not_allowed')
        throw new ProblemException('stop_not_ready');
      if (e instanceof ProblemException && e.errors?.length)
        throw new ProblemException(
          e.code,
          e.detail,
          e.errors.map((x) => ({ ...x, field: `failurePhotos.${x.field}` })),
          e.extra,
        );
      throw e;
    }
  }
}

const LINK_DO = {
  id: true,
  doNo: true,
  status: true,
  tripStopId: true,
} as const;
type LinkDo = { id: string; doNo: string | null; status: string; tripStopId: string | null };

/** ชุดไฟล์เดียวกัน (ส่งซ้ำ) — ลำดับรูปไม่สำคัญ */
function sameFiles(r: DeliveryOrderPod, b: PodLinkCaptureDto): boolean {
  const dec = (xs: string[] | undefined) =>
    (xs ?? [])
      .map((x) => tryDecodeId('document', x) ?? x)
      .sort()
      .join(',');
  return (
    dec(b.photoDocumentIds) === [...r.photoDocumentIds].sort().join(',') &&
    dec(b.fileDocumentIds) === [...r.fileDocumentIds].sort().join(',') &&
    (b.signatureDocumentId ? tryDecodeId('document', b.signatureDocumentId) : null) ===
      r.signatureDocumentId
  );
}

/** ผลที่ส่งกลับให้ลิงก์ — ไม่มี PIN/ลิงก์ไฟล์/ชื่อผู้บันทึก */
function captureResult(
  doNo: string,
  v: DeliveryOrderPodDto,
  replayed: boolean,
): PodLinkCaptureResultDto {
  const c = v.current;
  return {
    doNo,
    doStatus: v.doStatus,
    podStatus: v.podStatus,
    photoCount: c?.photos.length ?? 0,
    fileCount: c?.files.length ?? 0,
    hasSignature: !!c?.signature,
    recordedAt: c?.recordedAt ?? new Date().toISOString(),
    replayed,
  };
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
