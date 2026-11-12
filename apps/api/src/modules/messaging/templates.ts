import { safeName } from '../../common/safe-text';
import { docDate } from '../../common/thai-date';
import type { MessageChannel } from './providers';

/**
 * template ข้อความส่งลิงก์ (ST3-T21) — ไทย/อังกฤษ (D-11) · render ตอน enqueue (แก้ template ภายหลังไม่กระทบข้อความที่รอส่ง)
 * ชื่อที่ tenant กรอกเองผ่าน `safeName` (ตัด URL/โดเมน — กันใช้ข้อความเราเป็นฟิชชิง) · URL มาจากระบบเท่านั้น
 * SMS สั้นกว่า LINE (ภาษาไทยใน SMS = UCS-2 70 ตัวอักษร/ชิ้น)
 */
export const MESSAGE_TEMPLATES = ['carrier_docs_link', 'job_offer_link'] as const;
export type MessageTemplate = (typeof MESSAGE_TEMPLATES)[number];

export interface MessageVars {
  /** ชื่อผู้ส่ง (ชื่อบริษัทใน tenant) */
  sender: string;
  /** ชื่อผู้รับ (ผู้รับเหมา) — ไม่มี = ไม่ขึ้นต้นด้วยชื่อ */
  recipientName?: string | null;
  /** เลขอ้างอิง (เช่น เลขงาน) — ST3-T23 */
  ref?: string | null;
  url: string;
  expiresAt: Date;
  yearStyle: 'BE' | 'CE';
}

type Render = (
  v: Required<Pick<MessageVars, 'sender' | 'url'>> & { name: string; ref: string; until: string },
) => string;

const T: Record<MessageTemplate, Record<'th' | 'en', Record<MessageChannel, Render>>> = {
  carrier_docs_link: {
    th: {
      LINE: (v) =>
        `${v.name ? `เรียน ${v.name}\n` : ''}${v.sender} ขอให้ส่งเอกสารรถและใบขับขี่ (ประกันภัย พ.ร.บ. ใบขับขี่) ผ่านลิงก์นี้ ไม่ต้องสมัครหรือ login\n${v.url}\nลิงก์ใช้ได้ถึง ${v.until}`,
      SMS: (v) => `${v.sender}: ส่งเอกสารรถ/ใบขับขี่ ${v.url} (ถึง ${v.until})`,
    },
    en: {
      LINE: (v) =>
        `${v.name ? `Dear ${v.name}\n` : ''}${v.sender} asks you to upload vehicle documents and driving licences (insurance, compulsory act, licence) via this link — no login needed\n${v.url}\nValid until ${v.until}`,
      SMS: (v) => `${v.sender}: upload vehicle docs ${v.url} (until ${v.until})`,
    },
  },
  job_offer_link: {
    th: {
      LINE: (v) =>
        `${v.name ? `เรียน ${v.name}\n` : ''}${v.sender} ส่งข้อเสนองาน${v.ref ? ` ${v.ref}` : ''} กดรับหรือปฏิเสธได้ที่ลิงก์นี้ ไม่ต้อง login\n${v.url}\nตอบได้ถึง ${v.until}`,
      SMS: (v) => `${v.sender}: ข้อเสนองาน${v.ref ? ` ${v.ref}` : ''} ${v.url} (ถึง ${v.until})`,
    },
    en: {
      LINE: (v) =>
        `${v.name ? `Dear ${v.name}\n` : ''}${v.sender} sent you a job offer${v.ref ? ` ${v.ref}` : ''}. Accept or decline via this link — no login needed\n${v.url}\nReply by ${v.until}`,
      SMS: (v) => `${v.sender}: job offer${v.ref ? ` ${v.ref}` : ''} ${v.url} (until ${v.until})`,
    },
  },
};

const EN_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** วันเวลาไทย: "20 พฤศจิกายน 2569 10:14 น." */
function until(d: Date, locale: 'th' | 'en', ys: 'BE' | 'CE'): string {
  const bkk = new Date(d.getTime() + 7 * 3600_000);
  const hm = `${String(bkk.getUTCHours()).padStart(2, '0')}:${String(bkk.getUTCMinutes()).padStart(2, '0')}`;
  if (locale === 'en')
    return `${bkk.getUTCDate()} ${EN_MONTHS[bkk.getUTCMonth()]} ${bkk.getUTCFullYear()} ${hm}`;
  return `${docDate(d, ys)} ${hm} น.`;
}

export function renderMessage(
  template: MessageTemplate,
  channel: MessageChannel,
  locale: string,
  v: MessageVars,
): string {
  const lang = locale === 'en' ? 'en' : 'th';
  return T[template][lang][channel]({
    sender: safeName(v.sender, 80) || 'TMS',
    name: v.recipientName ? safeName(v.recipientName, 80) : '',
    ref: v.ref ? safeName(v.ref, 40) : '',
    url: v.url,
    until: until(v.expiresAt, lang, v.yearStyle),
  });
}
