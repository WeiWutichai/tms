import { Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import type { Tx } from '../../db/db.service';
import { webBaseUrl } from '../../auth/password-reset.controller';
import { encodeLinkToken, MagicLinkService } from '../links/magic-link.service';
import { linkUrl } from '../messaging/link-kinds';

export const OFFER_LINK_PURPOSE = 'trip_offer' as const;
export const OFFER_LINK_ENTITY = 'subcon_offer' as const;
/** action ของลิงก์ข้อเสนองาน (magic link ST1-T06) — ดู / ตอบรับหรือปฏิเสธ */
export const OFFER_LINK_ACTIONS = { view: 'offer.view', respond: 'offer.respond' } as const;
/** อายุข้อเสนอ/ลิงก์ (docs/04 D3 "ลิงก์อายุ 48 ชม.", docs/01 §4.2) */
export const OFFER_TTL_MS = 48 * 3600_000;
/** เวลาหมดอายุของข้อเสนอ — ไม่มี `expires_at` (ข้อมูลก่อน ST3-T23) = เวลาเสนอ + 48 ชม. (ใช้ร่วม: หน้าลิงก์ + หน้า `/sub`) */
export const offerDeadline = (o: { expiresAt: Date | null; offeredAt: Date }): Date =>
  o.expiresAt ?? new Date(o.offeredAt.getTime() + OFFER_TTL_MS);

/**
 * ลิงก์งานของรถร่วมหลังรับงาน (ST4-T08 M10 ส่วนสถานะ — POD ST4-T09; docs/01 §5.5 `/public/pod/{token}`)
 * ออกตอนการจ้างเป็น ACCEPTED · entity = การจ้าง (`subcon_offer`) จึงจำกัดเฉพาะเที่ยว + รถร่วมรายนั้น
 * · เพิกถอนพร้อมลิงก์ข้อเสนอ (ยกเลิกเที่ยว / เปลี่ยนรถร่วม ST3-T25 / จ้างใหม่) · ใช้ได้จนเที่ยวจบ + 7 วัน (ตรวจที่ service)
 */
export const POD_LINK_PURPOSE = 'pod' as const;
/** view = ดูงาน/ค้น DO · event = กดถึง/ออก (ST4-T08) · capture = ส่ง POD (ST4-T09) */
export const POD_LINK_ACTIONS = {
  view: 'pod.view',
  event: 'pod.event',
  capture: 'pod.capture',
} as const;
/** เพดานอายุ token (วัน) — อายุจริง "จนเที่ยวจบ + 7 วัน" ตรวจที่ `PodLinkService` (เที่ยวที่ยังไม่จบไม่รู้วันจบล่วงหน้า) */
export const POD_LINK_MAX_DAYS = 45;
/** หลังเที่ยวจบ (COMPLETED ขึ้นไป) ลิงก์ใช้ได้อีกกี่วัน (docs/01 §5.5 "จนปิด trip + 7 วัน") */
export const POD_LINK_AFTER_CLOSE_DAYS = 7;
const LINK_PURPOSES_OF_OFFER = [OFFER_LINK_PURPOSE, POD_LINK_PURPOSE];

/** เหตุที่เพิกถอนลิงก์ข้อเสนองาน/ลิงก์งาน (docs/04 A1 "เพิกถอนได้") */
export type OfferLinkRevokeCause =
  'REISSUED' | 'POD_REISSUED' | 'TRIP_CANCELLED' | 'CARRIER_CHANGED' | 'REHIRED' | 'OFFER_EXPIRED';
export const OFFER_REVOKE_REASON: Record<OfferLinkRevokeCause, string> = {
  REISSUED: 'ออกลิงก์ข้อเสนองานใหม่ — ลิงก์เดิมใช้ไม่ได้แล้ว',
  POD_REISSUED: 'ออกลิงก์งานรถร่วมใหม่ — ลิงก์เดิมใช้ไม่ได้แล้ว',
  TRIP_CANCELLED: 'ยกเลิกเที่ยว — ลิงก์ข้อเสนองานใช้ไม่ได้แล้ว',
  CARRIER_CHANGED: 'เปลี่ยนรถร่วม — ลิงก์ข้อเสนองานของรายเดิมใช้ไม่ได้แล้ว',
  REHIRED: 'จ้างรถร่วมใหม่ — ลิงก์ข้อเสนอที่ปิดแล้วใช้ไม่ได้',
  OFFER_EXPIRED: 'ข้อเสนองานหมดเวลาตอบรับ — ลิงก์ใช้ไม่ได้แล้ว',
};
/** เหตุผลเพิกถอนของลิงก์งาน (`pod` — ST4-T08 QA L3) แยกข้อความจากลิงก์ข้อเสนอ */
export const POD_REVOKE_REASON: Record<OfferLinkRevokeCause, string> = {
  REISSUED: 'ออกลิงก์ข้อเสนองานใหม่ — ลิงก์งานเดิมใช้ไม่ได้แล้ว',
  POD_REISSUED: 'ออกลิงก์งานรถร่วมใหม่ — ลิงก์งานเดิมใช้ไม่ได้แล้ว',
  TRIP_CANCELLED: 'ยกเลิกเที่ยว — ลิงก์งานรถร่วมใช้ไม่ได้แล้ว',
  CARRIER_CHANGED: 'เปลี่ยนรถร่วม — ลิงก์งานของรายเดิมใช้ไม่ได้แล้ว',
  REHIRED: 'จ้างรถร่วมใหม่ — ลิงก์งานของการจ้างที่ปิดแล้วใช้ไม่ได้',
  OFFER_EXPIRED: 'ข้อเสนองานหมดเวลาตอบรับ — ลิงก์งานใช้ไม่ได้แล้ว',
};

const CLOSED_TRIP = new Set(['COMPLETED', 'COSTED', 'SETTLED']);
/**
 * ลิงก์งานยังใช้ได้ตามเที่ยว (docs/01 §5.5): การจ้าง ACCEPTED + เที่ยวยังเป็นของรถร่วมรายนี้ + ไม่ยกเลิก
 * + จบแล้วไม่เกิน 7 วัน — ใช้ทั้งหน้าลิงก์งาน (404) และ `podUrl` ของหน้าข้อเสนอ (QA L4)
 */
export function podLinkUsable(
  offer: { status: string; carrierId: string },
  trip: { status: string; carrierId: string | null; completedAt: Date | null },
  now: Date,
): boolean {
  if (offer.status !== 'ACCEPTED') return false;
  if (trip.carrierId !== offer.carrierId || trip.status === 'CANCELLED') return false;
  if (CLOSED_TRIP.has(trip.status)) {
    const end = (trip.completedAt ?? now).getTime();
    if (end + POD_LINK_AFTER_CLOSE_DAYS * 86_400_000 <= now.getTime()) return false;
  }
  return true;
}

export interface OfferLinkRow {
  id: string;
  purpose: string;
  entityId: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * ลิงก์ข้อเสนองานของรถร่วม (ST3-T23; docs/04 D3 + M10, docs/01 §5.5 `/public/offers/{token}`)
 * - 1 ลิงก์ต่อการจ้าง (`subcon_offer`) ที่ใช้ได้ ณ เวลาหนึ่ง — ออกตอนจ้าง (`/offer`) · ออกใหม่ = เพิกถอนของเดิม (อายุเท่าเดิม)
 * - token สร้างใหม่ได้จาก id + วันหมดอายุ (HMAC — `linkUrl`) จึงไม่เก็บ token ในฐาน · scope `prices.buy:read` (เห็นค่าจ้างของตัวเอง)
 * - ลิงก์อายุเท่าข้อเสนอ (48 ชม.) · ตอบแล้วยังเปิดดูสถานะได้จนหมดอายุ · ยกเลิกเที่ยว/เปลี่ยนรถร่วม (ST3-T25) → เพิกถอน
 */
@Injectable()
export class OfferLinks {
  constructor(
    private readonly links: MagicLinkService,
    private readonly audit: AuditService,
  ) {}

  /** ออกลิงก์ของการจ้าง (อายุถึง `expiresAt` ของข้อเสนอ) — ข้อเสนอหมดเวลาแล้ว → 409 `offer_closed` */
  async issue(
    tx: Tx,
    offer: { id: string; tenantId: string; expiresAt: Date | null },
    createdBy: string | null,
  ) {
    const until = offer.expiresAt ?? new Date(Date.now() + OFFER_TTL_MS);
    const ttl = (until.getTime() - Date.now()) / 1000;
    if (ttl < 1) throw new ProblemException('offer_closed', 'ข้อเสนอนี้หมดเวลาตอบรับแล้ว');
    const l = await this.links.issue(tx, offer.tenantId, {
      purpose: OFFER_LINK_PURPOSE,
      entityType: OFFER_LINK_ENTITY,
      entityId: offer.id,
      actions: [OFFER_LINK_ACTIONS.view, OFFER_LINK_ACTIONS.respond],
      scopes: ['prices.buy:read'],
      ttlSeconds: ttl,
      ...(createdBy ? { createdBy } : {}),
    });
    return { id: l.id, expiresAt: l.expiresAt, url: linkUrl('trip_offer', l) };
  }

  /**
   * ออกลิงก์งานหลังรับงาน (ST4-T08) — ดู/ค้น DO/กดถึง-ออก (+ ส่ง POD ST4-T09) · scope ราคาซื้อของตัวเอง (แท็บ "งาน")
   * อายุ token = เพดาน `POD_LINK_MAX_DAYS` วัน (เที่ยวจบ + 7 วัน ตรวจที่ service)
   */
  async issuePod(tx: Tx, offer: { id: string; tenantId: string }, createdBy: string | null) {
    const l = await this.links.issue(tx, offer.tenantId, {
      purpose: POD_LINK_PURPOSE,
      entityType: OFFER_LINK_ENTITY,
      entityId: offer.id,
      actions: [POD_LINK_ACTIONS.view, POD_LINK_ACTIONS.event, POD_LINK_ACTIONS.capture],
      scopes: ['prices.buy:read'],
      ttlSeconds: POD_LINK_MAX_DAYS * 86_400,
      ...(createdBy ? { createdBy } : {}),
    });
    return { id: l.id, expiresAt: l.expiresAt, url: this.podUrl(l) };
  }

  /** URL หน้าลิงก์งานของรถร่วม (`/link/pod/{token}`) */
  podUrl(link: { id: string; expiresAt: Date }): string {
    const token = encodeLinkToken(link.id, Math.floor(link.expiresAt.getTime() / 1000));
    return `${webBaseUrl()}/link/pod/${token}`;
  }

  /** ลิงก์ที่ยังใช้ได้ของการจ้าง (ใหม่สุดก่อน) — ค่าเริ่ม = ลิงก์ข้อเสนองาน · ST4-T08 ลิงก์งาน = `[POD_LINK_PURPOSE]` */
  async active(
    tx: Tx,
    offerIds: string[],
    purposes: string[] = [OFFER_LINK_PURPOSE],
  ): Promise<OfferLinkRow[]> {
    if (!offerIds.length) return [];
    return tx.magicLink.findMany({
      where: {
        purpose: { in: purposes },
        entityType: OFFER_LINK_ENTITY,
        entityId: { in: offerIds },
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, purpose: true, entityId: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  url(link: { id: string; expiresAt: Date }): string {
    return linkUrl('trip_offer', link);
  }

  /** เพิกถอนลิงก์ที่ใช้ได้ทั้งหมด (ข้อเสนอ + ลิงก์งาน ST4-T08) ของการจ้างในเที่ยว (คืนจำนวน — ไม่มี = 0 ไม่ลง audit) */
  async revokeForTrip(tx: Tx, tripId: string, cause: OfferLinkRevokeCause): Promise<number> {
    const offers = await tx.subconOffer.findMany({ where: { tripId }, select: { id: true } });
    return this.revoke(
      tx,
      offers.map((o) => o.id),
      cause,
      tripId,
    );
  }

  async revoke(
    tx: Tx,
    offerIds: string[],
    cause: OfferLinkRevokeCause,
    tripId: string,
    purposes: string[] = LINK_PURPOSES_OF_OFFER,
  ): Promise<number> {
    const ls = await this.active(tx, offerIds, purposes);
    if (!ls.length) return 0;
    const reason = OFFER_REVOKE_REASON[cause];
    const actor = requestContext.get()?.actorId ?? undefined;
    const done: string[] = [];
    for (const l of ls) {
      const why = l.purpose === POD_LINK_PURPOSE ? POD_REVOKE_REASON[cause] : reason;
      if (await this.links.revoke(tx, l.id, why, actor)) done.push(l.id);
    }
    if (done.length)
      await this.audit.record({
        action: 'subcon_offer.links_revoked',
        entityType: 'trip',
        entityId: tripId,
        after: { cause, linkIds: done.map((id) => encodeId('magicLink', id)) },
        reason,
      });
    return done.length;
  }
}
