/**
 * หน้าในแอป → บทความใน help center (P1-ST6-T02 · docs/04 I "ลิงก์คู่มือจากทุกหน้า")
 * key = key ของหน้า (META / `NavItem.page` ใน nav.ts) · test `help.test.tsx` ล้มเมื่อหน้าใดใน NAV (รวมหน้าย่อย) ไม่มีแถวที่นี่
 * หรือบทความ/หัวข้อที่ชี้ไม่มีอยู่ใน `packages/help-center/site`
 *
 * หน้าที่ยังไม่มีบทความเฉพาะชี้ไปบทความที่ใกล้ที่สุด (ข้อมูลหลัก/รถ → นำเข้าข้อมูล) หรือหน้าแรกของ help center (`index`)
 * — รายการบทความที่ควรเขียนเพิ่มอยู่ใน PROGRESS (บันทึก P1-ST6-T02)
 */
import { helpConfig } from './config';

export interface HelpTarget {
  /** ชื่อไฟล์บทความ (`<slug>.html`) — `index` = หน้าแรกของ help center */
  slug: string;
  /** id ของหัวข้อในบทความ (ไม่มี `#`) — ใช้ id ภาษาอังกฤษที่ตั้งด้วย `{#id}` ท้ายหัวข้อในบทความ (ไม่ผูกกับถ้อยคำหัวข้อ) */
  anchor?: string;
}

export const HELP_ROUTES: Record<string, HelpTarget> = {
  dash: { slug: 'company-setup', anchor: 'getting-started' },
  // ปฏิบัติการ
  plan: { slug: 'dispatch', anchor: 'board' },
  trips: { slug: 'dispatch', anchor: 'trips' },
  exc: { slug: 'dispatch', anchor: 'warnings' },
  so: { slug: 'orders' },
  hold: { slug: 'orders', anchor: 'hold' },
  do: { slug: 'pod' },
  sub: { slug: 'subcontractor-link' },
  // บัญชี
  bill: { slug: 'billing' },
  pay: { slug: 'payments' },
  settle: { slug: 'carrier-settlement' },
  erp: { slug: 'connector-errors' },
  // รถ
  fveh: { slug: 'import-data' },
  fprof: { slug: 'import-data' },
  fdoc: { slug: 'import-data' },
  veh: { slug: 'import-data' },
  // รายงาน — ยังไม่มีบทความ
  report: { slug: 'index' },
  // ข้อมูลหลัก
  cust: { slug: 'import-data' },
  loc: { slug: 'import-data' },
  route: { slug: 'import-data' },
  prod: { slug: 'import-data' },
  vtype: { slug: 'import-data' },
  accsr: { slug: 'import-data' },
  rate: { slug: 'import-data' },
  // ตั้งค่า
  settings: { slug: 'company-setup' },
  api: { slug: 'errors' },
  ds: { slug: 'index' },
};

const join = (base: string, t: HelpTarget) =>
  `${base}${t.slug === 'index' ? '' : `${t.slug}.html`}${t.anchor ? `#${encodeURIComponent(t.anchor)}` : ''}`;

/** ลิงก์ "คู่มือหน้านี้" — หน้าที่ไม่อยู่ในเมนู (โปรไฟล์, ไฟล์ส่งออก) = หน้าแรกของ help center */
export function helpUrlFor(page: string | undefined, base = helpConfig.helpCenterUrl): string {
  return join(base, (page && HELP_ROUTES[page]) || { slug: 'index' });
}

/** หัวข้อของรหัส error (problem+json `code`) ใน catalog ของ help center */
export const problemHelpUrl = (code: string, base = helpConfig.helpCenterUrl) =>
  join(base, { slug: 'errors', anchor: code });

/** คู่มือของ error การเชื่อมระบบบัญชี (key = code เฉพาะ หรือ ErrorClass — `QueueGuideDto.key`) */
export const connectorGuideUrl = (key: string, base = helpConfig.helpCenterUrl) =>
  join(base, { slug: 'connector-errors', anchor: key });
