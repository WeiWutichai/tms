import { webBaseUrl } from '../../auth/password-reset.controller';
import { encodeLinkToken } from '../links/magic-link.service';
import type { MessageTemplate } from './templates';

/**
 * ชนิดลิงก์ที่ส่งทาง LINE/SMS ได้ — path หน้าเว็บ + template + สิทธิ์ส่ง/ดูบันทึก (docs/04 A3)
 * `enabled: false` = ยังส่งไม่ได้ (trip_offer: ST3-T23 ต้องตรวจว่าเที่ยวถูกเสนอให้ผู้รับเหมารายนั้นก่อน — review ST3-T21)
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
    entityType: 'trip',
    enabled: false,
  },
} as const satisfies Record<
  string,
  {
    path: string;
    template: MessageTemplate;
    sendScope: string;
    readScope: string;
    entityType: string;
    enabled: boolean;
  }
>;
export type LinkKind = keyof typeof LINK_KINDS;

export const isLinkKind = (p: string): p is LinkKind => p in LINK_KINDS;

/** URL ลิงก์จากแถว magic_link (สร้างใหม่ได้จาก id + วันหมดอายุ — ไม่ต้องเก็บ token ไว้ใน outbox) */
export function linkUrl(kind: LinkKind, link: { id: string; expiresAt: Date }): string {
  const token = encodeLinkToken(link.id, Math.floor(link.expiresAt.getTime() / 1000));
  return `${webBaseUrl()}/link/${LINK_KINDS[kind].path}/${token}`;
}
