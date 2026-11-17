import { Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import type { Tx } from '../../db/db.service';
import { MagicLinkService } from '../links/magic-link.service';
import { linkUrl } from '../messaging/link-kinds';

export const OFFER_LINK_PURPOSE = 'trip_offer' as const;
export const OFFER_LINK_ENTITY = 'subcon_offer' as const;
/** action ของลิงก์ข้อเสนองาน (magic link ST1-T06) — ดู / ตอบรับหรือปฏิเสธ */
export const OFFER_LINK_ACTIONS = { view: 'offer.view', respond: 'offer.respond' } as const;
/** อายุข้อเสนอ/ลิงก์ (docs/04 D3 "ลิงก์อายุ 48 ชม.", docs/01 §4.2) */
export const OFFER_TTL_MS = 48 * 3600_000;

/** เหตุที่เพิกถอนลิงก์ข้อเสนองาน (docs/04 A1 "เพิกถอนได้") */
export type OfferLinkRevokeCause = 'REISSUED' | 'TRIP_CANCELLED' | 'CARRIER_CHANGED';
export const OFFER_REVOKE_REASON: Record<OfferLinkRevokeCause, string> = {
  REISSUED: 'ออกลิงก์ข้อเสนองานใหม่ — ลิงก์เดิมใช้ไม่ได้แล้ว',
  TRIP_CANCELLED: 'ยกเลิกเที่ยว — ลิงก์ข้อเสนองานใช้ไม่ได้แล้ว',
  CARRIER_CHANGED: 'เปลี่ยนรถร่วม — ลิงก์ข้อเสนองานของรายเดิมใช้ไม่ได้แล้ว',
};

export interface OfferLinkRow {
  id: string;
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

  /** ลิงก์ที่ยังใช้ได้ของการจ้าง (ใหม่สุดก่อน) */
  async active(tx: Tx, offerIds: string[]): Promise<OfferLinkRow[]> {
    if (!offerIds.length) return [];
    return tx.magicLink.findMany({
      where: {
        purpose: OFFER_LINK_PURPOSE,
        entityType: OFFER_LINK_ENTITY,
        entityId: { in: offerIds },
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, entityId: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  url(link: { id: string; expiresAt: Date }): string {
    return linkUrl('trip_offer', link);
  }

  /** เพิกถอนลิงก์ที่ใช้ได้ทั้งหมดของการจ้างในเที่ยว (คืนจำนวน — ไม่มี = 0 ไม่ลง audit) */
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
  ): Promise<number> {
    const ls = await this.active(tx, offerIds);
    if (!ls.length) return 0;
    const reason = OFFER_REVOKE_REASON[cause];
    const actor = requestContext.get()?.actorId ?? undefined;
    const done: string[] = [];
    for (const l of ls) if (await this.links.revoke(tx, l.id, reason, actor)) done.push(l.id);
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
