import { webBaseUrl } from '../../auth/password-reset.controller';
import { encodeLinkToken } from '../links/magic-link.service';
import type { MessageTemplate } from './templates';

/**
 * ชนิดลิงก์ที่ส่งทาง LINE/SMS ได้ — path หน้าเว็บ + template + สิทธิ์ส่ง/ดูบันทึก (docs/04 A3)
 * `enabled: false` = ยังส่งไม่ได้ · trip_offer (ST3-T23): ลิงก์ชี้การจ้าง (`subcon_offer`) — ผู้รับ = รถร่วมของการจ้างนั้น
 * และส่งได้เฉพาะข้อเสนอที่ยังรอตอบ (ตรวจใน MessagingService — review ST3-T21)
 */
export const LINK_KINDS = {
  carrier_docs: {
    path: 'carrier-docs',
    template: 'carrier_docs_link',
    sendScope: 'master:write',
    readScope: 'master:read',
    entityType: 'carrier',
    enabled: true,
  },
  trip_offer: {
    path: 'offer',
    template: 'job_offer_link',
    sendScope: 'trips:assign',
    readScope: 'trips:read',
    entityType: 'subcon_offer',
    enabled: true,
  },
  // ST6-T05 ลิงก์ให้รถร่วมตรวจใบสำคัญจ่าย — ผู้รับ = รถร่วมของใบ · ลิงก์ตรวจส่งได้เฉพาะใบที่รอรถร่วมตรวจ (SENT_TO_CARRIER/DISPUTED)
  // D-62: ลิงก์ดูอย่างเดียว (ใบ APPROVED/PAID — D-59) ใช้ `viewTemplate` (ดูสถานะการจ่าย/ดาวน์โหลดใบจ่ายเงิน)
  settlement_review: {
    path: 'settlement',
    template: 'settlement_review_link',
    viewTemplate: 'settlement_payment_status_link',
    sendScope: 'settlements:create',
    readScope: 'settlements:read',
    entityType: 'carrier_settlement',
    enabled: true,
  },
} as const satisfies Record<
  string,
  {
    path: string;
    template: MessageTemplate;
    /** template ของลิงก์ดูอย่างเดียว (ไม่มี = ชนิดนี้ไม่มีลิงก์ดูอย่างเดียว) */
    viewTemplate?: MessageTemplate;
    sendScope: string;
    readScope: string;
    entityType: string;
    enabled: boolean;
  }
>;
export type LinkKind = keyof typeof LINK_KINDS;

/** template ทั้งหมดของชนิดลิงก์ (ลิงก์ปกติ + ลิงก์ดูอย่างเดียว) — ใช้กรองบันทึกการส่งตามสิทธิ์ดู */
export function kindTemplates(kind: LinkKind): MessageTemplate[] {
  const k: { template: MessageTemplate; viewTemplate?: MessageTemplate } = LINK_KINDS[kind];
  return k.viewTemplate ? [k.template, k.viewTemplate] : [k.template];
}

export const isLinkKind = (p: string): p is LinkKind => p in LINK_KINDS;

/** URL ลิงก์จากแถว magic_link (สร้างใหม่ได้จาก id + วันหมดอายุ — ไม่ต้องเก็บ token ไว้ใน outbox) */
export function linkUrl(kind: LinkKind, link: { id: string; expiresAt: Date }): string {
  const token = encodeLinkToken(link.id, Math.floor(link.expiresAt.getTime() / 1000));
  return `${webBaseUrl()}/link/${LINK_KINDS[kind].path}/${token}`;
}
