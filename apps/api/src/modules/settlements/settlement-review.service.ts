import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { linkWriteBucket } from '../../http/link-rate-limit';
import { RateLimitService } from '../../http/rate-limit/rate-limit.service';
import { signDocumentUrl, UPLOAD_TTL_S } from '../documents/signed-url';
import { MagicLinkService } from '../links/magic-link.service';
import { NotificationEvents } from '../notifications/notification-events';
import { linkUrl } from '../messaging/link-kinds';
import { lockKey } from '../master/master-kit';
import { bangkokToday } from '../vehicle-documents/expiry';
import type {
  ReviewLinkFileDto,
  ReviewLinkFileReserveDto,
  ReviewLinkLineDto,
  ReviewLinkRespondDto,
  ReviewLinkRespondResultDto,
  ReviewLinkViewDto,
  SettlementReviewLinkDto,
} from './settlement-review.dto';
import { REVIEW_LINK_TTL_DAYS } from './settlement-review.dto';
import { disputedCount, UNDER_REVIEW } from './settlement-dispute';

export const REVIEW_LINK_PURPOSE = 'settlement_review' as const;
export const REVIEW_LINK_ENTITY = 'carrier_settlement' as const;
/** view = ดูใบ · respond = ยอมรับ/โต้แย้ง + แนบรูป */
export const REVIEW_LINK_ACTIONS = {
  view: 'settlement.view',
  respond: 'settlement.respond',
} as const;
/** ไฟล์รูปประกอบการโต้แย้ง — entity = บรรทัดใบสำคัญจ่าย */
export const REVIEW_PHOTO_KIND = 'DISPUTE_PHOTO';
export const REVIEW_PHOTO_ENTITY = 'settlement_line';
/** เพดานไฟล์ต่อบรรทัด/ต่อชั่วโมงของลิงก์ (แบบลิงก์งาน ST4-T09) */
export const REVIEW_FILES_PER_LINE = 20;
export const REVIEW_FILES_PER_HOUR = 60;
export const REVIEW_REVOKE_REASON = {
  REISSUED: 'ออกลิงก์ให้รถร่วมตรวจใหม่ — ลิงก์เดิมใช้ไม่ได้แล้ว',
  /** ออกลิงก์ดูอย่างเดียวใหม่ (ใบ APPROVED/PAID — D-59 · review L2) */
  REISSUED_VIEW: 'ออกลิงก์ดูสถานะการจ่ายใหม่ — ลิงก์เดิมใช้ไม่ได้แล้ว',
  RECALLED: 'เรียกใบสำคัญจ่ายกลับมาแก้ — ลิงก์ให้รถร่วมตรวจใช้ไม่ได้แล้ว',
} as const;

/** สถานะที่หน้าลิงก์เปิดดูได้ (อนุมัติแล้ว/จ่ายแล้ว — ST6-T09 = ดูอย่างเดียวจนลิงก์หมดอายุ · DISPUTED = ยังตอบได้ — ST6-T06) */
const VIEWABLE = new Set(['SENT_TO_CARRIER', 'DISPUTED', 'APPROVED', 'PAID']);
const RESPONDABLE = new Set<string>(UNDER_REVIEW);

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

type ReviewRow = {
  id: string;
  lineId: string;
  round: number;
  response: string;
  reason: string | null;
  photoIds: string[];
  claimedAmount: Prisma.Decimal | null;
  createdAt: Date;
};

/** ลำดับคำตอบ (เวลา แล้ว id — เวลาเท่ากันก็ได้ผลแน่นอน ตรงกับ trigger 0127 `ORDER BY created_at, id`) */
export const REVIEW_ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/** คำตอบล่าสุดต่อบรรทัดของรอบ `round` — (createdAt, id) มากสุดชนะ ไม่ขึ้นกับลำดับที่ส่งเข้ามา */
export function latestReviews<T extends Pick<ReviewRow, 'id' | 'lineId' | 'round' | 'createdAt'>>(
  rows: T[],
  round: number,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    if (r.round !== round) continue;
    const cur = out.get(r.lineId);
    const later =
      !cur ||
      r.createdAt.getTime() > cur.createdAt.getTime() ||
      (r.createdAt.getTime() === cur.createdAt.getTime() && r.id > cur.id);
    if (later) out.set(r.lineId, r);
  }
  return out;
}

/**
 * รถร่วมตรวจใบสำคัญจ่ายผ่านลิงก์ (ST6-T05; docs/04 F6 "รถร่วมตรวจผ่านลิงก์", docs/01 §4.5, spec/05 §11.3 หน้ารถร่วม)
 * - ฝั่งบริษัท: ส่งให้ตรวจ (DRAFT → SENT_TO_CARRIER + ออกลิงก์ 7 วัน) · ออกลิงก์ใหม่ · เรียกกลับมาแก้ (SENT_TO_CARRIER → DRAFT)
 * - ฝั่งรถร่วม (magic link `settlement_review` → entity = ใบ): เห็นเฉพาะบรรทัดของใบนี้ (= เที่ยวและราคาซื้อของตัวเอง ไม่มีราคาขาย)
 *   กด ยอมรับ / โต้แย้ง ต่อบรรทัด (เหตุผล/รูป) — คำตอบเพิ่มอย่างเดียว คำตอบล่าสุดของรอบ = สถานะ · โต้แย้ง = ติดธง (อนุมัติไม่ได้)
 * - ผู้ตอบ = actor สังเคราะห์ `link:<id>` — ไม่สร้าง/แก้บรรทัด จึงไม่เป็นผู้เตรียมใบ และอนุมัติไม่ได้ (service + DB 0127)
 */
@Injectable()
export class SettlementReviewService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly links: MagicLinkService,
    private readonly limiter: RateLimitService,
    private readonly events: NotificationEvents,
  ) {}

  // ---------- ฝั่งบริษัท ----------

  /**
   * ออกลิงก์ใหม่ของใบ (เพิกถอนลิงก์เดิมที่ยังใช้ได้) — เรียกใน transaction ของผู้เรียก
   * `viewOnly` = ลิงก์ดูอย่างเดียว (action `settlement.view` เท่านั้น — ใบ APPROVED/PAID, D-59): ตอบ/จองรูปผ่านลิงก์นี้ = 404
   */
  async issueLink(
    tx: Tx,
    settlementId: string,
    opts: { viewOnly?: boolean } = {},
  ): Promise<SettlementReviewLinkDto> {
    const ctx = requestContext.require();
    await this.revokeActive(
      tx,
      settlementId,
      opts.viewOnly ? REVIEW_REVOKE_REASON.REISSUED_VIEW : REVIEW_REVOKE_REASON.REISSUED,
    );
    const l = await this.links.issue(tx, ctx.tenantId!, {
      purpose: REVIEW_LINK_PURPOSE,
      entityType: REVIEW_LINK_ENTITY,
      entityId: settlementId,
      actions: opts.viewOnly
        ? [REVIEW_LINK_ACTIONS.view]
        : [REVIEW_LINK_ACTIONS.view, REVIEW_LINK_ACTIONS.respond],
      scopes: ['prices.buy:read'],
      ttlSeconds: REVIEW_LINK_TTL_DAYS * 86_400,
      ...(ctx.actorId ? { createdBy: ctx.actorId } : {}),
    });
    return {
      id: encodeId('magicLink', l.id),
      url: linkUrl('settlement_review', l),
      expiresAt: l.expiresAt.toISOString(),
    };
  }

  /** เพิกถอนลิงก์ตรวจที่ยังใช้ได้ของใบ (เรียกกลับ / ออกใหม่) */
  async revokeActive(tx: Tx, settlementId: string, reason: string): Promise<number> {
    const rows = await tx.magicLink.findMany({
      where: {
        purpose: REVIEW_LINK_PURPOSE,
        entityType: REVIEW_LINK_ENTITY,
        entityId: settlementId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    for (const r of rows) await this.links.revoke(tx, r.id, reason, requestContext.get()?.actorId);
    return rows.length;
  }

  /** ลิงก์ที่ยังใช้ได้ล่าสุดของใบ (ไม่มี token — ใช้แสดงวันหมดอายุ) */
  async activeLink(tx: Tx, settlementId: string) {
    return tx.magicLink.findFirst({
      where: {
        purpose: REVIEW_LINK_PURPOSE,
        entityType: REVIEW_LINK_ENTITY,
        entityId: settlementId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * สถานะหัวใบตามรายการโต้แย้งค้าง (ST6-T06; docs/01 §4.5): ใบที่รอตรวจ + โต้แย้งค้าง > 0 → DISPUTED · DISPUTED + เคลียร์ครบ → SENT_TO_CARRIER
   * เปลี่ยนสถานะ = version +1 + audit `settlement.disputed` / `settlement.dispute_cleared` · ร่าง/อนุมัติแล้วไม่แตะ · เรียกหลังล็อกใบ
   */
  async syncDisputeStatus(tx: Tx, settlementId: string): Promise<void> {
    const s = await tx.carrierSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    if (!RESPONDABLE.has(s.status)) return;
    const n = await disputedCount(tx, s.id, s.reviewRound);
    const next = n > 0 ? 'DISPUTED' : 'SENT_TO_CARRIER';
    if (next === s.status) return;
    await tx.carrierSettlement.update({
      where: { id: s.id },
      data: { status: next, version: { increment: 1 } },
    });
    await this.audit.record({
      action: next === 'DISPUTED' ? 'settlement.disputed' : 'settlement.dispute_cleared',
      entityType: REVIEW_LINK_ENTITY,
      entityId: s.id,
      before: { status: s.status },
      after: { status: next, round: s.reviewRound, disputedCount: n },
    });
    if (next === 'DISPUTED') {
      const snap = s.carrierSnapshot as { legalName?: string };
      await this.events.settlementDisputed(tx, {
        tenantId: s.tenantId,
        settlementId: s.id,
        carrier: snap.legalName ?? '',
        ref: `${ymdTh(s.periodFrom)}–${ymdTh(s.periodTo)}`,
        count: n,
      });
    }
  }

  // ---------- ฝั่งรถร่วม ----------

  /** ใบของลิงก์ — ร่าง/ยกเลิกแล้ว (เรียกกลับ = ลิงก์ถูกเพิกถอนอยู่แล้ว) → 404 ไม่บอกใบ้ */
  private async context(settlementId: string) {
    const s = await this.db.tx.carrierSettlement.findFirst({ where: { id: settlementId } });
    if (!s || !VIEWABLE.has(s.status)) throw new ProblemException('not_found');
    return s;
  }

  async view(settlementId: string, linkId: string): Promise<ReviewLinkViewDto> {
    const tx = this.db.tx;
    const s = await this.context(settlementId);
    const link = await tx.magicLink.findUniqueOrThrow({ where: { id: linkId } });
    const [tenant, { lines, carrierOpen }] = await Promise.all([
      tx.tenant.findFirst({ select: { name: true } }),
      this.lines(tx, s.id, s.reviewRound),
    ]);
    const snap = s.carrierSnapshot as { legalName?: string };
    return {
      company: tenant?.name ?? '',
      carrierName: snap.legalName ?? '',
      status: carrierStatus(s.status, carrierOpen),
      settlementNo: s.settlementNo,
      periodFrom: s.periodFrom.toISOString().slice(0, 10),
      periodTo: s.periodTo.toISOString().slice(0, 10),
      carrierInvoiceNo: s.carrierInvoiceNo,
      tripCount: new Set(lines.filter((l) => l.lineType !== 'DEDUCTION').map((l) => l.tripNo)).size,
      grossAmount: s.grossAmount.toFixed(2),
      deductionAmount: s.deductionAmount.toFixed(2),
      netAmount: s.netPayable.toFixed(2),
      canRespond: RESPONDABLE.has(s.status),
      expiresAt: link.expiresAt.toISOString(),
      lines: RESPONDABLE.has(s.status) ? lines : lines.map((l) => ({ ...l, canRespond: false })),
    };
  }

  /** จองรูปประกอบของบรรทัด → PUT เนื้อไฟล์ที่ `uploadUrl` */
  async reserveFile(
    settlementId: string,
    linkId: string,
    body: ReviewLinkFileReserveDto,
    origin: string,
  ): Promise<ReviewLinkFileDto> {
    const tx = this.db.tx;
    const s = await this.context(settlementId);
    await this.limiter.assert([linkWriteBucket(linkId)]);
    if (!RESPONDABLE.has(s.status)) throw closed(s.status);
    const lineId = await this.lineOf(s.id, body.lineId);
    await this.assertNotResolved(lineId, s.reviewRound);
    const actor = `link:${linkId}`;
    await lockKey(tx, `settlement_review.files:${linkId}`);
    const perLine = await tx.storedDocument.count({
      where: { createdBy: actor, entityType: REVIEW_PHOTO_ENTITY, entityId: lineId },
    });
    if (perLine >= REVIEW_FILES_PER_LINE)
      throw new ProblemException('rate_limited', 'file limit for this line reached');
    const since = new Date(Date.now() - 3600_000);
    const hour = await tx.storedDocument.count({
      where: { createdBy: actor, createdAt: { gt: since } },
    });
    if (hour >= REVIEW_FILES_PER_HOUR)
      throw new ProblemException(
        'rate_limited',
        'too many files for this link — try again later',
        undefined,
        { retryAfter: 600 },
      );
    const doc = await tx.storedDocument.create({
      data: {
        tenantId: requestContext.require().tenantId!,
        status: 'PENDING',
        kind: REVIEW_PHOTO_KIND,
        mimeType: body.mime,
        sizeBytes: body.bytes,
        filename: body.filename ?? null,
        entityType: REVIEW_PHOTO_ENTITY,
        entityId: lineId,
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

  /**
   * ยอมรับ / โต้แย้ง บรรทัด (คำตอบใหม่แทนคำตอบเดิมของรอบนี้ — เก็บทุกคำตอบไว้เป็นประวัติ)
   * โต้แย้งต้องมีเหตุผลหรือรูป · รูปต้องจองผ่านลิงก์นี้สำหรับบรรทัดนี้และอัปโหลดแล้ว · ใบไม่อยู่ในสถานะรอตรวจ → 409
   */
  async respond(
    settlementId: string,
    linkId: string,
    lineRef: string,
    body: ReviewLinkRespondDto,
  ): Promise<ReviewLinkRespondResultDto> {
    const tx = this.db.tx;
    await this.context(settlementId);
    await this.limiter.assert([linkWriteBucket(linkId)]);
    // ล็อกใบ — คำตอบกับการเรียกกลับ/อนุมัติพร้อมกันได้ลำดับเดียว
    await tx.$queryRaw`SELECT id FROM carrier_settlement WHERE id = ${settlementId}::uuid FOR UPDATE`;
    const s = await tx.carrierSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    if (!RESPONDABLE.has(s.status)) throw closed(s.status);
    // ลิงก์ถูกเพิกถอน/หมดอายุระหว่างรอล็อก (เรียกกลับ/ออกลิงก์ใหม่พร้อมกัน) → 404 (review L2)
    await this.assertLinkLive(linkId, s.id);
    const lineId = await this.lineOf(s.id, lineRef);
    // บริษัทยืนยันยอดเดิมของบรรทัดนี้แล้วในรอบนี้ → ตอบซ้ำไม่ได้ (ST6-T06 — trigger 0130 ตรวจซ้ำ)
    await this.assertNotResolved(lineId, s.reviewRound);
    const reason = body.reason?.trim() || null;
    const photos = body.photoDocumentIds ?? [];
    if (body.response === 'ACCEPTED' && photos.length)
      throw field422('photoDocumentIds', 'not_allowed', 'photos are only for disputes');
    const claimed = body.claimedAmount ?? null;
    if (body.response === 'ACCEPTED' && claimed !== null)
      throw field422('claimedAmount', 'not_allowed', 'the claimed amount is only for disputes');
    if (body.response === 'DISPUTED' && !reason && !photos.length)
      throw field422('reason', 'required', 'give a reason or a photo for the dispute');
    const photoIds = await this.ownPhotos(linkId, lineId, photos);
    const row = await tx.settlementLineReview.create({
      data: {
        tenantId: s.tenantId,
        settlementId: s.id,
        lineId,
        round: s.reviewRound,
        response: body.response,
        reason,
        photoIds,
        claimedAmount: claimed,
        linkId,
        createdBy: `link:${linkId}`,
      },
    });
    await this.audit.record({
      action:
        body.response === 'DISPUTED' ? 'settlement.line_disputed' : 'settlement.line_accepted',
      entityType: REVIEW_LINK_ENTITY,
      entityId: s.id,
      ...(reason ? { reason } : {}),
      after: {
        lineId: encodeId('settlementLine', lineId),
        round: s.reviewRound,
        response: body.response,
        photoIds: photoIds.map((p) => encodeId('document', p)),
        ...(claimed !== null ? { buyClaimedAmount: claimed } : {}),
        reviewId: row.id,
      },
    });
    // โต้แย้ง/เปลี่ยนใจ → สถานะหัวใบ SENT_TO_CARRIER ↔ DISPUTED (ST6-T06)
    await this.syncDisputeStatus(tx, s.id);
    const view = await this.lines(tx, s.id, s.reviewRound);
    const line = view.lines.find((l) => l.id === encodeId('settlementLine', lineId))!;
    const { status } = await tx.carrierSettlement.findUniqueOrThrow({
      where: { id: s.id },
      select: { status: true },
    });
    return { line, status: carrierStatus(status, view.carrierOpen) };
  }

  // ---------- ภายใน ----------

  /** บรรทัดที่บริษัทเคลียร์ (ยืนยันยอดเดิม) แล้วในรอบนี้ → 409 `settlement_line_resolved` */
  /**
   * บริษัทเคลียร์ข้อโต้แย้งของรถร่วมบรรทัดนี้แล้วในรอบนี้ → 409 `settlement_line_resolved`
   * (นิยามเดียวกับ trigger 0130 `tms_settlement_line_carrier_resolved` — เคลียร์แค่ธงภายในไม่บล็อก: review M1)
   */
  private async assertNotResolved(lineId: string, round: number): Promise<void> {
    const [r] = await this.db.tx.$queryRaw<{ ok: boolean }[]>`
      SELECT tms_settlement_line_carrier_resolved(${lineId}::uuid, ${round}::int) AS ok`;
    if (r?.ok) throw new ProblemException('settlement_line_resolved');
  }

  /** ลิงก์ยังใช้ได้และชี้ใบนี้ (อ่านหลังล็อกใบ) */
  private async assertLinkLive(linkId: string, settlementId: string): Promise<void> {
    const ok = await this.db.tx.magicLink.findFirst({
      where: {
        id: linkId,
        purpose: REVIEW_LINK_PURPOSE,
        entityId: settlementId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!ok) throw new ProblemException('not_found');
  }

  /** บรรทัดที่ยังใช้ของใบ (id ภายนอก) — ไม่ใช่ของใบนี้/นำออกแล้ว → 404 */
  private async lineOf(settlementId: string, ref: string): Promise<string> {
    const id = tryDecodeId('settlementLine', ref);
    const l = id
      ? await this.db.tx.settlementLine.findFirst({
          where: { id, settlementId, voidedAt: null },
          select: { id: true },
        })
      : null;
    if (!l) throw new ProblemException('not_found');
    return l.id;
  }

  /** รูปต้องจองผ่านลิงก์นี้สำหรับบรรทัดนี้ + อัปโหลดเสร็จ (READY) — ไม่ใช่ = 422 (ไม่บอกว่ามีอยู่) */
  private async ownPhotos(linkId: string, lineId: string, refs: string[]): Promise<string[]> {
    if (!refs.length) return [];
    const ids = refs.map((r) => tryDecodeId('document', r));
    const real = ids.filter((x): x is string => !!x);
    const own = new Set(
      real.length
        ? (
            await this.db.tx.storedDocument.findMany({
              where: {
                id: { in: real },
                createdBy: `link:${linkId}`,
                entityType: REVIEW_PHOTO_ENTITY,
                entityId: lineId,
                status: 'READY',
              },
              select: { id: true },
            })
          ).map((r) => r.id)
        : [],
    );
    const errors: FieldError[] = [];
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (!id || !own.has(id) || seen.has(id))
        errors.push({
          field: `photoDocumentIds.${i}`,
          code: id && seen.has(id) ? 'duplicate' : 'not_found',
          message: id && seen.has(id) ? 'photo listed twice' : 'document not found',
        });
      if (id) seen.add(id);
    });
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
    return real;
  }

  /** บรรทัดที่ยังใช้ + เที่ยว (เลข/วันจบ/จุดแรก-สุดท้าย) + คำตอบล่าสุดของรอบ */
  private async lines(
    tx: Tx,
    settlementId: string,
    round: number,
  ): Promise<{ lines: ReviewLinkLineDto[]; carrierOpen: number }> {
    const rows = await tx.settlementLine.findMany({
      where: { settlementId, voidedAt: null },
      orderBy: { lineNo: 'asc' },
      include: {
        trip: {
          select: {
            tripNo: true,
            completedAt: true,
            tripDate: true,
            stops: {
              where: { removedAt: null },
              orderBy: { sequence: 'asc' },
              select: { site: { select: { name: true } } },
            },
          },
        },
      },
    });
    const reviews = await tx.settlementLineReview.findMany({
      where: { settlementId, round },
      orderBy: REVIEW_ORDER,
      select: {
        id: true,
        lineId: true,
        round: true,
        response: true,
        reason: true,
        photoIds: true,
        claimedAmount: true,
        createdAt: true,
      },
    });
    const latest = latestReviews(reviews, round);
    // การเคลียร์ล่าสุดของบริษัท (ยืนยันยอดเดิม) — แสดงให้รถร่วมเฉพาะเมื่อเคลียร์ข้อโต้แย้งของรถร่วมเอง (review M1):
    // การติด dispute ภายใน และการเคลียร์ธงภายใน ไม่แสดง (ข้อความภายใน) และไม่ปิดสิทธิ์ตอบ
    const resolutions = await tx.settlementLineDispute.findMany({
      where: { settlementId, round, action: 'RESOLVED' },
      orderBy: REVIEW_ORDER,
      select: { id: true, lineId: true, reason: true, createdAt: true },
    });
    const lastResolved = new Map(resolutions.map((r) => [r.lineId, r]));
    const carrierResolved = new Set(
      round > 0
        ? (
            await tx.$queryRaw<{ id: string }[]>`
              SELECT l.id::text AS id FROM settlement_line l
               WHERE l.settlement_id = ${settlementId}::uuid AND l.voided_at IS NULL
                 AND tms_settlement_line_carrier_resolved(l.id, ${round}::int)`
          ).map((r) => r.id)
        : [],
    );
    // ข้อโต้แย้งของรถร่วมที่ยังค้าง (คำตอบล่าสุดเป็นโต้แย้ง และไม่มีการเคลียร์หลังจากนั้น) — ใช้กำหนดป้ายหัวใบบนลิงก์ (review M2)
    let carrierOpen = 0;
    for (const l of rows) {
      const r = latest.get(l.id);
      const res = lastResolved.get(l.id);
      if (r?.response === 'DISPUTED' && !(res && isAfter(res, r))) carrierOpen++;
    }
    return {
      lines: rows.map((l) =>
        lineView(
          l,
          latest.get(l.id) ?? null,
          carrierResolved.has(l.id) ? (lastResolved.get(l.id) ?? null) : null,
        ),
      ),
      carrierOpen,
    };
  }
}

type LineRow = Prisma.SettlementLineGetPayload<{
  include: {
    trip: {
      select: {
        tripNo: true;
        completedAt: true;
        tripDate: true;
        stops: { select: { site: { select: { name: true } } } };
      };
    };
  };
}>;

function lineView(
  l: LineRow,
  r: ReviewRow | null,
  res: { reason: string; createdAt: Date } | null,
): ReviewLinkLineDto {
  const stops = l.trip?.stops ?? [];
  const first = stops[0];
  const last = stops[stops.length - 1];
  return {
    id: encodeId('settlementLine', l.id),
    lineNo: l.lineNo,
    lineType: l.lineType,
    tripNo: l.trip?.tripNo ?? null,
    tripDate: l.trip
      ? l.trip.completedAt
        ? bangkokToday(l.trip.completedAt)
        : l.trip.tripDate.toISOString().slice(0, 10)
      : null,
    origin: first?.site.name ?? null,
    destination: last && last !== first ? last.site.name : null,
    description: l.description,
    deductionType: l.deductionType,
    reference: l.reference,
    amount: l.amount.toFixed(2),
    review: r
      ? {
          response: r.response as 'ACCEPTED' | 'DISPUTED',
          reason: r.reason,
          photoCount: r.photoIds.length,
          claimedAmount: r.claimedAmount?.toFixed(2) ?? null,
          respondedAt: r.createdAt.toISOString(),
        }
      : null,
    resolution: res ? { reason: res.reason, resolvedAt: res.createdAt.toISOString() } : null,
    canRespond: !res,
  };
}

/** (createdAt, id) ของ a มาหลัง b — ลำดับเดียวกับ DB */
function isAfter(a: { id: string; createdAt: Date }, b: { id: string; createdAt: Date }): boolean {
  const x = a.createdAt.getTime();
  const y = b.createdAt.getTime();
  return x > y || (x === y && a.id > b.id);
}

/**
 * สถานะที่รถร่วมเห็น — DISPUTED เฉพาะเมื่อมีข้อโต้แย้งของรถร่วมเองค้าง (review M2) · ใบ DISPUTED จากธงภายในของบัญชีอย่างเดียว
 * แสดงเป็น SENT_TO_CARRIER (ไม่เปิดเผยการตรวจภายใน)
 */
function carrierStatus(status: string, carrierOpen: number): string {
  return status === 'DISPUTED' && carrierOpen === 0 ? 'SENT_TO_CARRIER' : status;
}

/** งวด (วันที่ไทย พ.ศ. — ข้อความแจ้งเตือน) */
function ymdTh(d: Date): string {
  const [y, m, dd] = d.toISOString().slice(0, 10).split('-');
  return `${Number(dd)}/${Number(m)}/${Number(y) + 543}`;
}

function closed(status: string) {
  return new ProblemException(
    'invalid_state_transition',
    'the settlement is not awaiting your review',
    undefined,
    {
      status,
    },
  );
}
