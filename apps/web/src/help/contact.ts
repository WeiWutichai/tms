/**
 * ติดต่อทีมงาน (P1-ST6-T03 · docs/04 I "ติดต่อ support ในระบบ" · R-15 เฟส 1 = อีเมล + LINE OA)
 *
 * แนบเฉพาะ **รหัสบริษัท** (id ของ tenant — ใช้ติดป้าย/นับ ticket ต่อ tenant ตามเกณฑ์ (ค)) และ **หน้าที่เปิดอยู่**
 * (ชื่อหน้า + path ไม่รวม query/hash ซึ่งอาจมีคำค้นหรือ token) — ไม่แนบชื่อ อีเมล เบอร์ หรือข้อมูลอื่นของผู้ใช้
 * (อีเมลผู้ส่งมาจากโปรแกรมอีเมลของผู้ใช้เอง) [DECISION — lead 27 พ.ย. 2569, ย้อนได้]
 *
 * หัวเรื่องอีเมลขึ้นต้นด้วย `SUPPORT_TAG` เสมอ — ขั้นตอนนับ ticket รายเดือน (`docs/ops/support-ticket-count.md`) กรองด้วยป้ายนี้
 */
import type { HelpConfig } from './config';

/** ป้ายหัวเรื่อง — ห้ามเปลี่ยนโดยไม่แก้ runbook นับ ticket */
export const SUPPORT_TAG = '[TMS-SUPPORT]';

export interface ContactContext {
  tenantId: string;
  /** ชื่อหน้าที่เปิดอยู่ (ไทย) */
  pageTitle: string;
  /** location.pathname */
  path: string;
}

export interface ContactText {
  subject: string;
  body: string;
}

/** path ไม่รวม query/hash (กันคำค้น/token หลุดไปกับข้อความ) */
export const cleanPath = (p: string) => p.split(/[?#]/)[0] || '/';

export function mailtoUrl(cfg: HelpConfig, text: ContactText): string | null {
  if (!cfg.supportEmail) return null;
  return `mailto:${cfg.supportEmail}?subject=${encodeURIComponent(text.subject)}&body=${encodeURIComponent(text.body)}`;
}

/** LINE URL scheme "ส่งข้อความถึงบัญชีทางการ" — เปิดแชทกับ OA พร้อมข้อความร่าง (ผู้ใช้กดส่งเอง) */
export function lineUrl(cfg: HelpConfig, text: ContactText): string | null {
  if (!cfg.supportLineOa) return null;
  return `https://line.me/R/oaMessage/${encodeURIComponent(cfg.supportLineOa)}/?${encodeURIComponent(`${text.subject}\n${text.body}`)}`;
}
