import { safeName } from '../../common/safe-text';
import { docDate } from '../../common/thai-date';
import type { MessageChannel } from './providers';

/**
 * template ข้อความส่งลิงก์ (ST3-T21) — ไทย/อังกฤษ (D-11) · worker render ตอนส่ง (outbox ไม่เก็บลิงก์/token)
 * ชื่อที่ tenant กรอกเองผ่าน `messageName` (ตัด URL/โดเมน/คำที่มีจุด + ตัวเลขยาว ≥ 6 หลัก — กันใช้ข้อความเราเป็นฟิชชิง/สแปม)
 * SMS = ข้อความคงที่สั้น + ลิงก์ ไม่มีชื่อที่ tenant กรอกเลย (ส่งจากบัญชี SMS ของระบบ — review ST3-T21 M1)
 * LINE = ส่งจาก OA ของบริษัทเอง → มีชื่อบริษัท/ผู้รับ (ผ่าน sanitiser) · URL มาจากระบบเท่านั้น
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
      SMS: (v) => `TMS: ส่งเอกสารรถ/ใบขับขี่ตามที่บริษัทขนส่งขอ ${v.url} (ถึง ${v.until})`,
    },
    en: {
      LINE: (v) =>
        `${v.name ? `Dear ${v.name}\n` : ''}${v.sender} asks you to upload vehicle documents and driving licences (insurance, compulsory act, licence) via this link — no login needed\n${v.url}\nValid until ${v.until}`,
      SMS: (v) => `TMS: upload vehicle docs requested by your carrier ${v.url} (until ${v.until})`,
    },
  },
  job_offer_link: {
    th: {
      LINE: (v) =>
        `${v.name ? `เรียน ${v.name}\n` : ''}${v.sender} ส่งข้อเสนองาน${v.ref ? ` ${v.ref}` : ''} กดรับหรือปฏิเสธได้ที่ลิงก์นี้ ไม่ต้อง login\n${v.url}\nตอบได้ถึง ${v.until}`,
      SMS: (v) => `TMS: ข้อเสนองานขนส่ง ${v.url} (ถึง ${v.until})`,
    },
    en: {
      LINE: (v) =>
        `${v.name ? `Dear ${v.name}\n` : ''}${v.sender} sent you a job offer${v.ref ? ` ${v.ref}` : ''}. Accept or decline via this link — no login needed\n${v.url}\nReply by ${v.until}`,
      SMS: (v) => `TMS: transport job offer ${v.url} (until ${v.until})`,
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

/** คำต่อท้ายชื่อบริษัทที่มีจุดแต่ไม่ใช่โดเมน — กันไว้ก่อนตัดคำที่มีจุด แล้วคืนค่าทีหลัง */
const COMPANY_SUFFIX =
  /\b(?:Co\s*\.\s*,?\s*Ltd\s*\.?|Co\s*\.|Ltd\s*\.|Inc\s*\.|Corp\s*\.|Pte\s*\.|Plc\s*\.|P\s*\.\s*C\s*\.\s*L\s*\.?)/gi;
const THAI_DIGITS = /[๐-๙]/g;

/**
 * ชื่อที่ tenant/ผู้รับเหมากรอกเองก่อนใส่ข้อความ (ST3-T21 review + QA):
 * 1. NFKC (ตัวอักษรเต็มความกว้าง/ตัวแปลก → ตัวปกติ) + เลขไทย ๐-๙ → 0-9
 * 2. จุดที่เลี่ยงการตรวจ (`[.]` `(.)` `{.}` `。` `｡` `dot` และช่องว่างก่อน `.tld`) → `.`
 * 3. ตัดทุกคำที่มีจุดตามด้วยตัวอักษร ≥ 2 (โดเมนอะไรก็ได้) · `@handle` · ตัวเลข ≥ 6 หลักแม้คั่นด้วย . - ช่องว่าง
 * 4. `safeName` (URL/โดเมนที่รู้จัก) — คำต่อท้ายบริษัท (Co., Ltd. / Inc. / บมจ. ฯลฯ) ไม่ถูกตัด
 */
export function messageName(input: string, max = 80): string {
  const kept: string[] = [];
  const s = input
    .normalize('NFKC')
    .replace(THAI_DIGITS, (d) => String(d.charCodeAt(0) - 0x0e50))
    .replace(COMPANY_SUFFIX, (m) => `\u0001${kept.push(m) - 1}\u0001`)
    .replace(/\s*(?:\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}|[。｡]|\s(?:dot)\s)\s*/gi, '.')
    .replace(/\s+\.(?=[a-z]{2,}\b)/gi, '.')
    .replace(/\S*\.[a-z]{2,}\S*/gi, '')
    .replace(/@[\w.-]+/g, '')
    .replace(/\d(?:[\s.-]*\d){5,}/g, '');
  return safeName(s, max)
    .replace(/\u0001(\d+)\u0001/g, (_, i: string) => kept[Number(i)] ?? '')
    .trim();
}

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
    sender: messageName(v.sender) || 'TMS',
    name: v.recipientName ? messageName(v.recipientName) : '',
    ref: v.ref ? messageName(v.ref, 40) : '',
    url: v.url,
    until: until(v.expiresAt, lang, v.yearStyle),
  });
}
