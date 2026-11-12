import { safeName } from '../../common/safe-text';
import { docDate } from '../../pdf/thai-date';

/**
 * ข้อความแจ้งเตือน (ST1-T23) — ไทย/อังกฤษ (D-11: จีนไม่บังคับ → ใช้อังกฤษ)
 * เหตุการณ์ใหม่เพิ่มที่นี่ที่เดียว แล้วโมดูลเจ้าของเรียก `NotificationService.notify()`
 * (ใบค้างใหม่, งานรถร่วมหมดเวลา, เอกสารใกล้หมด ฯลฯ เพิ่มใน stage ของงานนั้น — docs/04 I)
 */
export type NotificationLocale = 'th' | 'en';

export interface NotificationVars {
  /** งานเบื้องหลังเสร็จ (docs/04 I "งานใหญ่ background + แจ้งเมื่อเสร็จ") — label = ชื่องานภาษาไทยจากผู้สร้างงาน */
  'job.succeeded': { label: string };
  'job.failed': { label: string };
  /** ฟีเจอร์ถูกปิด (แพ็กเกจ) หลังสั่งงาน → งานไม่ได้ทำ */
  'job.skipped': { label: string };
  /** ST1-T19 งานนำเข้าไฟล์ใหญ่ (job) — label = ชนิดข้อมูล (ชื่อไฟล์) */
  'import.validated': ImportVars;
  'import.file_failed': ImportVars;
  'import.completed': ImportVars;
  'import.not_imported': ImportVars;
  'import.failed': ImportVars;
  /**
   * ST2-T18 สรุปเตือนวันหมดอายุรายวัน — 1 ฉบับต่อผู้รับต่อวัน (docs/04 I "สรุปรายวัน 08:00")
   * items = รายการที่ถึงระดับเตือนวันนี้ (สูงสุด DIGEST_MAX_ITEMS) · more = ที่เหลือที่ไม่แสดง
   */
  'expiry.digest': { total: number; more: number; items: ExpiryDigestItem[] };
}
export type ExpiryLevel = 'D60' | 'D30' | 'D7' | 'EXPIRED';
export interface ExpiryDigestItem {
  kind: 'VEHICLE_DOCUMENT' | 'DRIVER_LICENCE' | 'RATE_CARD';
  level: ExpiryLevel;
  /** YYYY-MM-DD */
  expiresOn: string;
  /** วันหมด − วันนี้ (ติดลบ = หมดไปแล้ว) */
  days: number;
  /** ทะเบียนรถ / ชื่อคนขับ (รหัส) / รหัส rate (ลูกค้าหรือผู้รับเหมา · ต้นทาง → ปลายทาง) */
  label: string;
  docType?: string;
  title?: string | null;
  side?: 'SELL' | 'BUY';
}
interface ImportVars {
  label: string;
  ok: number;
  bad: number;
  imported: number;
  reason: string;
}
const n = (x: number) => x.toLocaleString('en-US');

/** ชื่อประเภทเอกสารรถ (ไทยตรงกับต้นแบบ/T17) */
const VEHICLE_DOC_NAME: Record<string, { th: string; en: string }> = {
  INSURANCE: { th: 'ประกันภัย', en: 'Insurance' },
  COMPULSORY_ACT: { th: 'พ.ร.บ.', en: 'Compulsory insurance (CMI)' },
  ANNUAL_TAX: { th: 'ภาษี', en: 'Annual road tax' },
  INSPECTION: { th: 'ตรวจสภาพ ตรอ.', en: 'Vehicle inspection' },
  TRANSPORT_LICENSE: { th: 'ใบอนุญาตขนส่ง', en: 'Transport licence' },
  GPS_DLT_CERT: { th: 'GPS DLT', en: 'GPS DLT certificate' },
  OTHER: { th: 'เอกสารอื่น', en: 'Other document' },
};
const thDay = (d: string) => docDate(new Date(`${d}T00:00:00+07:00`), 'BE');
/** ลำดับกลุ่มในสรุป: หมดแล้วก่อน แล้วใกล้สุด */
const LEVEL_ORDER: ExpiryLevel[] = ['EXPIRED', 'D7', 'D30', 'D60'];
const LEVEL_HEAD: Record<ExpiryLevel, Record<NotificationLocale, string>> = {
  EXPIRED: { th: 'หมดอายุแล้ว', en: 'Expired' },
  D7: { th: 'เหลือไม่เกิน 7 วัน', en: 'Within 7 days' },
  D30: { th: 'เหลือไม่เกิน 30 วัน', en: 'Within 30 days' },
  D60: { th: 'เหลือไม่เกิน 60 วัน', en: 'Within 60 days' },
};
const KIND_NAME: Record<ExpiryDigestItem['kind'], Record<NotificationLocale, string>> = {
  VEHICLE_DOCUMENT: { th: 'เอกสารรถ', en: 'vehicle documents' },
  DRIVER_LICENCE: { th: 'ใบขับขี่', en: 'driving licences' },
  RATE_CARD: { th: 'rate card', en: 'rate cards' },
};
function itemLine(i: ExpiryDigestItem, lang: NotificationLocale): string {
  const label = safeName(i.label, 160);
  const what =
    i.kind === 'VEHICLE_DOCUMENT'
      ? lang === 'th'
        ? `${i.docType === 'OTHER' && i.title ? safeName(i.title, 80) : (VEHICLE_DOC_NAME[i.docType ?? '']?.th ?? i.docType)} ของรถ ${label}`
        : `${i.docType === 'OTHER' && i.title ? safeName(i.title, 80) : (VEHICLE_DOC_NAME[i.docType ?? '']?.en ?? i.docType)} — vehicle ${label}`
      : i.kind === 'DRIVER_LICENCE'
        ? lang === 'th'
          ? `ใบขับขี่ ${label}`
          : `Driving licence — ${label}`
        : lang === 'th'
          ? `Rate card ${i.side === 'BUY' ? 'ขาซื้อ' : 'ขาขาย'} ${label}`
          : `${i.side === 'BUY' ? 'Buy' : 'Sell'} rate card ${label}`;
  const when =
    lang === 'th'
      ? i.days < 0
        ? `หมดเมื่อ ${thDay(i.expiresOn)}`
        : i.days === 0
          ? `หมดวันนี้ ${thDay(i.expiresOn)}`
          : `หมด ${thDay(i.expiresOn)} (อีก ${n(i.days)} วัน)`
      : i.days < 0
        ? `expired ${i.expiresOn}`
        : i.days === 0
          ? `expires today ${i.expiresOn}`
          : `expires ${i.expiresOn} (in ${n(i.days)} days)`;
  return `• ${what} — ${when}`;
}
/** สรุปสั้น (กระดิ่ง) + รายการเต็มเป็นกลุ่มตามระดับ (อีเมล) */
function renderDigest(v: NotificationVars['expiry.digest'], lang: NotificationLocale) {
  const kinds = [...new Set(v.items.map((i) => i.kind))].map((k) => KIND_NAME[k][lang]);
  const counts = LEVEL_ORDER.map((l) => [l, v.items.filter((i) => i.level === l).length] as const)
    .filter(([, c]) => c > 0)
    .map(([l, c]) => `${LEVEL_HEAD[l][lang]} ${n(c)}`);
  const lines: string[] = [];
  for (const l of LEVEL_ORDER) {
    const g = v.items.filter((i) => i.level === l);
    if (!g.length) continue;
    lines.push(`${LEVEL_HEAD[l][lang]}:`, ...g.map((i) => itemLine(i, lang)));
  }
  if (v.more > 0)
    lines.push(lang === 'th' ? `และอีก ${n(v.more)} รายการ` : `and ${n(v.more)} more`);
  return lang === 'th'
    ? {
        title: `${kinds.join(' / ')} ใกล้หมดอายุ ${n(v.total)} รายการ`,
        body: `${counts.join(' · ')}${v.more > 0 ? ` (แสดง ${n(v.items.length)} จาก ${n(v.total)})` : ''} — เปิดดูรายการและต่ออายุในระบบ`,
        detail: lines.join('\n'),
      }
    : {
        title: `${n(v.total)} expiring ${kinds.join(' / ')}`,
        body: `${counts.join(' · ')} — open TMS to review and renew.`,
        detail: lines.join('\n'),
      };
}
export type NotificationTemplate = keyof NotificationVars;

export interface RenderedNotification {
  title: string;
  /** ข้อความสั้น (กระดิ่ง + ย่อหน้าแรกของอีเมล) */
  body: string;
  /** รายละเอียดเพิ่มเฉพาะอีเมล (หลายบรรทัด) — เช่น รายการในสรุปเตือนวันหมดอายุ */
  detail?: string;
}

type Renderer<K extends NotificationTemplate> = (v: NotificationVars[K]) => RenderedNotification;

const TEMPLATES: {
  [K in NotificationTemplate]: Record<NotificationLocale, Renderer<K>>;
} = {
  'job.succeeded': {
    th: ({ label }) => ({ title: 'งานเสร็จแล้ว', body: `${label} เสร็จเรียบร้อย` }),
    en: ({ label }) => ({ title: 'Job finished', body: `${label} has finished.` }),
  },
  'job.failed': {
    th: ({ label }) => ({
      title: 'งานไม่สำเร็จ',
      body: `${label} ไม่สำเร็จ ลองใหม่ครบจำนวนครั้งแล้ว`,
    }),
    en: ({ label }) => ({
      title: 'Job failed',
      body: `${label} failed after all retries.`,
    }),
  },
  'job.skipped': {
    th: ({ label }) => ({
      title: 'งานไม่ได้ทำ',
      body: `${label} ไม่ได้ทำ เพราะแพ็กเกจปัจจุบันไม่รวมฟีเจอร์นี้`,
    }),
    en: ({ label }) => ({
      title: 'Job not run',
      body: `${label} was not run because the current plan does not include this feature.`,
    }),
  },
  'import.validated': {
    th: (v) => ({
      title: 'ตรวจไฟล์นำเข้าเสร็จแล้ว',
      body: `${v.label}: ผ่าน ${n(v.ok)} แถว ผิด ${n(v.bad)} แถว — เปิดเพื่อยืนยันนำเข้า`,
    }),
    en: (v) => ({
      title: 'Import file checked',
      body: `${v.label}: ${n(v.ok)} valid, ${n(v.bad)} invalid rows — open to confirm the import.`,
    }),
  },
  'import.file_failed': {
    th: (v) => ({ title: 'ไฟล์นำเข้าใช้ไม่ได้', body: `${v.label}: ${v.reason}` }),
    en: (v) => ({ title: 'Import file rejected', body: `${v.label}: ${v.reason}` }),
  },
  'import.completed': {
    th: (v) => ({
      title: 'นำเข้าเสร็จแล้ว',
      body: `${v.label}: นำเข้า ${n(v.imported)} แถว${v.bad ? ` ข้ามแถวที่ผิด ${n(v.bad)} แถว` : ''}`,
    }),
    en: (v) => ({
      title: 'Import finished',
      body: `${v.label}: ${n(v.imported)} rows imported${v.bad ? `, ${n(v.bad)} invalid rows skipped` : ''}.`,
    }),
  },
  'import.not_imported': {
    th: (v) => ({
      title: 'ยังไม่ได้นำเข้า',
      body: `${v.label}: ตรวจซ้ำพบแถวที่ผิด ${n(v.bad)} แถว ไม่มีข้อมูลถูกนำเข้า — แก้ไฟล์หรือเลือกนำเข้าเฉพาะแถวที่ผ่าน`,
    }),
    en: (v) => ({
      title: 'Nothing imported',
      body: `${v.label}: re-check found ${n(v.bad)} invalid rows, nothing was imported.`,
    }),
  },
  'import.failed': {
    th: (v) => ({
      title: 'นำเข้าไม่สำเร็จ',
      body: `${v.label}: ระบบขัดข้อง ไม่มีข้อมูลถูกนำเข้า — ลองอัปโหลดใหม่`,
    }),
    en: (v) => ({
      title: 'Import failed',
      body: `${v.label}: system error, nothing was imported.`,
    }),
  },
  'expiry.digest': {
    th: (v) => renderDigest(v, 'th'),
    en: (v) => renderDigest(v, 'en'),
  },
};

export function isNotificationTemplate(t: string): t is NotificationTemplate {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, t);
}

export function renderNotification<K extends NotificationTemplate>(
  template: K,
  locale: string,
  vars: NotificationVars[K],
): RenderedNotification {
  const lang: NotificationLocale = locale === 'th' ? 'th' : 'en';
  // ค่าจากผู้ใช้ (เช่น ชื่อไฟล์ใน label) ลงในอีเมลด้วย — ตัด URL/โดเมนและจำกัดความยาว (เหมือนคำเชิญ T07)
  const clean = Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [k, typeof v === 'string' ? safeName(v, 200) : v]),
  ) as NotificationVars[K];
  return (TEMPLATES[template][lang] as Renderer<K>)(clean);
}
