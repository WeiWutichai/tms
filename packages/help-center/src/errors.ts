/**
 * Catalog error ของ help center (P1-ST6-T01) — สร้างจากแหล่งเดียวกับระบบเสมอ ห้ามคัดลอกด้วยมือ:
 * - error ของ API: ทุก `code` ใน `x-problem-codes` ของ openapi.json (= `PROBLEMS` ใน apps/api/src/common/problem.ts)
 *   รวมทุก `code` ที่อยู่ในตัวอย่าง problem+json ของ operation → ข้อความบนหน้าจอจาก th.ts `problem.<code>` (ไม่มี = title จาก API)
 * - error ของการเชื่อมระบบบัญชี: `CONNECTOR_CLASS_GUIDE` + `CONNECTOR_CODE_GUIDE` (@tms/domain — ชุดที่คิวการส่งเอกสารแสดง)
 */
import { CONNECTOR_CLASS_GUIDE, CONNECTOR_CODE_GUIDE } from '@tms/domain';
import type { Article } from './inputs';

type Json = Record<string, any>;

/** เรียงแบบเทียบ code unit (ไม่ขึ้นกับ locale/ICU ของเครื่อง — ผลลัพธ์ deterministic ทุกเครื่อง) */
export const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ProblemEntry {
  code: string;
  status: number;
  /** title ใน catalog ของ API */
  title: string;
  /** ข้อความที่หน้าจอแสดง (th.ts) — เท่ากับ title เมื่อไม่มีข้อความเฉพาะ */
  message: string;
}

/** ทุก code ของ problem+json ใน openapi.json (x-problem-codes ∪ code ในตัวอย่างของ operation) */
export function problemCodes(doc: Json, messages: Record<string, string>): ProblemEntry[] {
  const out = new Map<string, ProblemEntry>();
  for (const [code, p] of Object.entries<Json>(doc['x-problem-codes'] ?? {}))
    out.set(code, { code, status: p.status, title: p.title, message: messages[code] ?? p.title });
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const pj = (o as Json)['application/problem+json'];
    if (pj?.examples)
      for (const ex of Object.values<Json>(pj.examples)) {
        const v = ex?.value;
        if (v?.code && !out.has(v.code))
          out.set(v.code, {
            code: v.code,
            status: v.status,
            title: v.title,
            message: messages[v.code] ?? v.title,
          });
      }
    Object.values(o).forEach(walk);
  };
  walk(doc.paths);
  walk(doc.components);
  return [...out.values()].sort((a, b) => a.status - b.status || byteOrder(a.code, b.code));
}

/**
 * คำแนะนำทั่วไปต่อกลุ่ม HTTP status — เป็นวิธีใช้หน้าจอทั่วไปเท่านั้น (ไม่ใช่กฎธุรกิจ/ภาษี)
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] ข้อความรายรหัสใช้ข้อความเดียวกับหน้าจอ (th.ts / PROBLEMS) ไม่เขียนคำอธิบายรายรหัสเพิ่มเอง
 */
export const STATUS_ADVICE: Record<number, { label: string; advice: string }> = {
  400: {
    label: 'คำขอไม่ถูกต้อง',
    advice:
      'ลิงก์หรือข้อมูลที่ส่งไม่ถูกต้อง — ตรวจลิงก์ (เช่น ลิงก์คำเชิญหรือลิงก์ตั้งรหัสผ่านที่หมดอายุ) แล้วลองใหม่',
  },
  401: {
    label: 'ต้องยืนยันตัวตน',
    advice: 'เข้าสู่ระบบใหม่ หรือกรอกรหัสยืนยันตัวตน 2 ชั้นตามที่หน้าจอบอก',
  },
  403: {
    label: 'ไม่มีสิทธิ์',
    advice:
      'บัญชีของคุณยังไม่มีสิทธิ์ทำรายการนี้ หรือรายการนี้ต้องให้ผู้อื่นทำ (เช่น ผู้อนุมัติคนละคนกับผู้สร้าง) — ติดต่อผู้ดูแลบริษัทของคุณ',
  },
  404: { label: 'ไม่พบข้อมูล', advice: 'ข้อมูลอาจถูกยกเลิกหรือไม่ได้อยู่ในบริษัทที่คุณเข้าใช้งาน' },
  405: { label: 'ไม่รองรับ', advice: 'ระบบไม่รองรับการทำรายการนี้' },
  409: {
    label: 'ทำไม่ได้ในสถานะปัจจุบัน / ข้อมูลขัดกัน',
    advice:
      'สถานะของรายการไม่ตรงกับที่ต้องใช้ หรือมีข้อมูลซ้ำ — โหลดหน้าใหม่ ตรวจสถานะของรายการ แล้วทำตามข้อความบนหน้าจอ',
  },
  412: {
    label: 'ข้อมูลถูกแก้โดยผู้อื่น',
    advice: 'มีคนแก้รายการเดียวกันก่อนคุณ — โหลดหน้าใหม่แล้วแก้อีกครั้ง',
  },
  413: { label: 'ไฟล์ใหญ่เกิน', advice: 'ลดขนาดไฟล์หรือแบ่งไฟล์แล้วอัปโหลดใหม่' },
  422: {
    label: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง',
    advice: 'แก้ช่องที่หน้าจอแสดงว่าผิด แล้วบันทึกอีกครั้ง',
  },
  429: { label: 'ทำรายการถี่เกินไป', advice: 'รอสักครู่แล้วลองใหม่' },
  500: {
    label: 'ระบบขัดข้อง',
    advice: 'ลองใหม่อีกครั้ง ถ้ายังไม่ได้ ติดต่อฝ่ายช่วยเหลือพร้อมรหัส error และเวลาที่เกิด',
  },
  503: {
    label: 'ระบบไม่พร้อมชั่วคราว',
    advice: 'รอสักครู่แล้วลองใหม่ ถ้ายังไม่ได้ ติดต่อฝ่ายช่วยเหลือพร้อมรหัส error',
  },
};

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function errorsArticle(entries: ProblemEntry[]): Article {
  const statuses = [...new Set(entries.map((e) => e.status))];
  const sections = statuses.map((st) => {
    const a = STATUS_ADVICE[st] ?? { label: `HTTP ${st}`, advice: 'ทำตามข้อความบนหน้าจอ' };
    const rows = entries
      .filter((e) => e.status === st)
      .map((e) => `| \`${e.code}\` {#${e.code}} | ${cell(e.message)} |`);
    return [
      `## ${st} — ${a.label} {#http-${st}}`,
      `**ทำอย่างไร:** ${a.advice}`,
      ['| รหัส | ข้อความบนหน้าจอ |', '|---|---|', ...rows].join('\n'),
    ].join('\n\n');
  });
  const md = [
    '# รหัส error ของระบบ',
    `เมื่อทำรายการไม่สำเร็จ หน้าจอจะแสดงข้อความด้านล่าง ระบบมีทั้งหมด ${entries.length} รหัส จัดกลุ่มตามประเภท — ค้นด้วยข้อความที่เห็นบนหน้าจอได้จากช่องค้นหาด้านบน`,
    '> รายการนี้สร้างจากโค้ดของระบบโดยอัตโนมัติ ทุกครั้งที่ระบบเพิ่มรหัสใหม่ หน้านี้จะอัปเดตตาม · นักพัฒนาที่เชื่อมผ่าน Open API ดูรายละเอียดทางเทคนิคได้ในเอกสาร API หัวข้อ "รหัส error"',
    '**กลุ่ม:** ' +
      statuses
        .map((st) => `[${st} ${STATUS_ADVICE[st]?.label ?? ''}](#http-${st})`.replace(' ]', ']'))
        .join(' · '),
    ...sections,
  ].join('\n\n');
  return {
    slug: 'errors',
    title: 'รหัส error ของระบบ',
    group: 'อ้างอิง',
    summary: `${entries.length} รหัส error ที่หน้าจออาจแสดง พร้อมวิธีแก้ตามกลุ่ม`,
    status: 'live',
    md: md + '\n',
  };
}

export interface ConnectorEntry {
  key: string;
  kind: 'class' | 'code';
  title: string;
  action: string;
}

export function connectorEntries(): ConnectorEntry[] {
  return [
    ...Object.entries(CONNECTOR_CLASS_GUIDE).map(([key, g]) => ({
      key,
      kind: 'class' as const,
      ...g,
    })),
    ...Object.entries(CONNECTOR_CODE_GUIDE)
      .sort(([a], [b]) => byteOrder(a, b))
      .map(([key, g]) => ({ key, kind: 'code' as const, ...g })),
  ];
}

export function connectorErrorsArticle(entries: ConnectorEntry[]): Article {
  const sec = (e: ConnectorEntry) =>
    [`### ${e.title} {#${e.key}}`, `รหัส \`${e.key}\``, '', `**วิธีแก้:** ${e.action}`].join('\n');
  const md = [
    '# error การเชื่อมระบบบัญชี',
    'เมื่อเชื่อมระบบบัญชีไว้ (ตั้งค่า → การเชื่อมต่อ) แล้วส่งเอกสารไม่สำเร็จ รายการจะอยู่ในคิวการส่งเอกสาร แท็บ "ล้มเหลว" พร้อมปุ่ม "วิธีแก้" — ข้อความในหน้านี้เป็นชุดเดียวกับที่ปุ่มนั้นแสดง',
    '> การเชื่อมระบบบัญชีเป็นทางเลือก งานขนส่ง วางบิล รับชำระ และจ่ายรถร่วม ทำจบใน TMS ได้โดยไม่ต้องเชื่อม · ระบบเลือกคำแนะนำจาก "รหัสเฉพาะ" ก่อน ถ้าไม่มีจึงใช้ "กลุ่มของ error"',
    '## กลุ่มของ error',
    ...entries.filter((e) => e.kind === 'class').map(sec),
    '## รหัสเฉพาะ',
    ...entries.filter((e) => e.kind === 'code').map(sec),
  ].join('\n\n');
  return {
    slug: 'connector-errors',
    title: 'error การเชื่อมระบบบัญชี',
    group: 'อ้างอิง',
    summary: `${entries.length} กรณีที่ส่งเอกสารเข้าระบบบัญชีไม่สำเร็จ พร้อมวิธีแก้`,
    status: 'live',
    md: md + '\n',
  };
}
