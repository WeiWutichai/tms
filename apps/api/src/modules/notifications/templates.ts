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
  /** ST2-T18 เตือนวันหมดอายุ — level D60/D30/D7 = ใกล้หมด, EXPIRED = หมดแล้ว · expiresOn = YYYY-MM-DD */
  'expiry.vehicle_document': ExpiryVars & { plate: string; docType: string; title: string | null };
  'expiry.driver_licence': ExpiryVars & { name: string; code: string };
  'expiry.rate_card': ExpiryVars & {
    code: string;
    revision: number;
    side: 'SELL' | 'BUY';
    party: string;
    route: string;
  };
}
interface ExpiryVars {
  level: 'D60' | 'D30' | 'D7' | 'EXPIRED';
  expiresOn: string;
  /** วันหมด − วันนี้ (ติดลบ = หมดไปแล้ว) */
  days: number;
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
const docName = (v: { docType: string; title: string | null }, lang: NotificationLocale) =>
  v.docType === 'OTHER' && v.title ? v.title : (VEHICLE_DOC_NAME[v.docType]?.[lang] ?? v.docType);
const thDay = (d: string) => docDate(new Date(`${d}T00:00:00+07:00`), 'BE');
/** "จะหมดอายุ 30 พฤศจิกายน 2569 (อีก 30 วัน)" / "หมดอายุวันนี้ (…)" / "หมดอายุแล้วเมื่อ …" */
const thWhen = (v: ExpiryVars) =>
  v.days < 0
    ? `หมดอายุแล้วเมื่อ ${thDay(v.expiresOn)}`
    : v.days === 0
      ? `หมดอายุวันนี้ (${thDay(v.expiresOn)})`
      : `จะหมดอายุ ${thDay(v.expiresOn)} (อีก ${n(v.days)} วัน)`;
const enWhen = (v: ExpiryVars) =>
  v.days < 0
    ? `expired on ${v.expiresOn}`
    : v.days === 0
      ? `expires today (${v.expiresOn})`
      : `expires on ${v.expiresOn} (in ${n(v.days)} days)`;
export type NotificationTemplate = keyof NotificationVars;

export interface RenderedNotification {
  title: string;
  body: string;
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
  'expiry.vehicle_document': {
    th: (v) => ({
      title: v.level === 'EXPIRED' ? 'เอกสารรถหมดอายุแล้ว' : 'เอกสารรถใกล้หมดอายุ',
      body: `${docName(v, 'th')} ของรถ ${v.plate} ${thWhen(v)} — บันทึกฉบับต่ออายุในหน้าเอกสารรถ`,
    }),
    en: (v) => ({
      title: v.level === 'EXPIRED' ? 'Vehicle document expired' : 'Vehicle document expiring',
      body: `${docName(v, 'en')} of vehicle ${v.plate} ${enWhen(v)}. Record the renewal on the vehicle documents page.`,
    }),
  },
  'expiry.driver_licence': {
    th: (v) => ({
      title: v.level === 'EXPIRED' ? 'ใบขับขี่หมดอายุแล้ว' : 'ใบขับขี่ใกล้หมดอายุ',
      body: `ใบขับขี่ของ ${v.name} (${v.code}) ${thWhen(v)} — อัปเดตวันหมดอายุใบใหม่ในข้อมูลคนขับ`,
    }),
    en: (v) => ({
      title: v.level === 'EXPIRED' ? 'Driving licence expired' : 'Driving licence expiring',
      body: `Driving licence of ${v.name} (${v.code}) ${enWhen(v)}. Update the new expiry date on the driver record.`,
    }),
  },
  'expiry.rate_card': {
    th: (v) => ({
      title: v.level === 'EXPIRED' ? 'Rate card หมดอายุแล้ว' : 'Rate card ใกล้หมดอายุ',
      body: `${v.code}${v.revision > 1 ? ` ฉบับที่ ${v.revision}` : ''} ${v.side === 'BUY' ? 'ขาซื้อ' : 'ขาขาย'} (${v.party} · ${v.route}) ${thWhen(v)} — ออกฉบับแก้ไขหรือเพิ่ม rate ช่วงใหม่`,
    }),
    en: (v) => ({
      title: v.level === 'EXPIRED' ? 'Rate card expired' : 'Rate card expiring',
      body: `${v.code}${v.revision > 1 ? ` rev. ${v.revision}` : ''} ${v.side === 'BUY' ? 'buy' : 'sell'} rate (${v.party} · ${v.route}) ${enWhen(v)}. Issue a revision or add a new rate period.`,
    }),
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
