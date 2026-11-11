import { safeName } from '../../common/safe-text';

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
}
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
