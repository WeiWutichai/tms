import type { Problem } from './erp-adapter';

/**
 * ST7-T15 ตรวจรูปของ canonical payload ก่อนถึง adapter (docs/01 §7.4 "กัน VALIDATION ตั้งแต่ฝั่งเรา") — ไม่ผูก ERP ใด
 * ตรวจเฉพาะ "รูป" (ช่องที่ทุก ERP ต้องใช้): เลขเอกสาร TMS (ส่งไปช่อง ref ของ ERP — docs/04 G3 เลขเอกสารสองฝั่ง), วันที่ `YYYY-MM-DD`,
 * เงินเป็นสตริงทศนิยม 2 ตำแหน่ง (ห้าม float), มีบรรทัด, เลขบรรทัดไม่ซ้ำ · **ไม่คำนวณ/ไม่เทียบยอดเงินหรือภาษี** (กฎเงินอยู่ที่ตัวสร้างเอกสาร)
 * เพดานขนาด/รหัสที่ ERP ยอมรับ = adapter (`masterCodeRefs`, payload builder ของ adapter)
 */
export type CanonicalFieldProblem = NonNullable<Problem['fields']>[number];

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** numeric(14,2) เป็นสตริง */
const MONEY_RE = /^-?\d{1,12}\.\d{2}$/;
const MAX_NUMBER = 60;
const MAX_PROBLEMS = 20;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

const INVOICE_TOTALS = [
  'subtotalVatable',
  'subtotalExempt',
  'subtotalZeroRated',
  'vatAmount',
  'total',
  'whtExpected',
] as const;
const SETTLEMENT_TOTALS = ['gross', 'deduction', 'net', 'wht', 'netAfterWht'] as const;

/** ปัญหาของ payload (ว่าง = ผ่าน) — เอกสารที่ไม่มี `kind` ที่รู้จัก ตรวจแค่ id + เลขเอกสาร */
export function canonicalProblems(doc: unknown): CanonicalFieldProblem[] {
  const out: CanonicalFieldProblem[] = [];
  const bad = (field: string, code: string, message: string) => {
    if (out.length < MAX_PROBLEMS) out.push({ field, code, message });
  };
  if (!isRec(doc)) {
    bad('document', 'required', 'ไม่มีเอกสารในคำสั่ง');
    return out;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (!str(doc.id)) bad('id', 'required', 'ไม่มี id ของเอกสาร');
  const number = str(doc.number);
  if (!number) bad('number', 'required', 'ไม่มีเลขเอกสาร TMS (ใช้เป็นเลขอ้างอิงฝั่งระบบบัญชี)');
  else if (number.length > MAX_NUMBER)
    bad('number', 'too_long', `เลขเอกสาร TMS ยาวเกิน ${MAX_NUMBER} ตัว`);

  const date = (field: string, v: unknown, required: boolean) => {
    if (v === null || v === undefined || v === '') {
      if (required) bad(field, 'required', 'ไม่มีวันที่');
    } else if (typeof v !== 'string' || !DATE_RE.test(v))
      bad(field, 'invalid_format', 'วันที่ต้องเป็น YYYY-MM-DD');
  };
  const money = (field: string, v: unknown, required = true) => {
    if (v === null || v === undefined) {
      if (required) bad(field, 'required', 'ไม่มียอดเงิน');
    } else if (typeof v !== 'string' || !MONEY_RE.test(v))
      bad(field, 'invalid_format', 'ยอดเงินต้องเป็นสตริงทศนิยม 2 ตำแหน่ง');
  };
  const lines = (moneyFields: readonly string[], optional: readonly string[] = []) => {
    if (!Array.isArray(doc.lines) || doc.lines.length === 0) {
      bad('lines', 'required', 'เอกสารไม่มีบรรทัด');
      return;
    }
    const seen = new Set<number>();
    doc.lines.forEach((l: unknown, i: number) => {
      if (!isRec(l)) return bad(`lines[${i}]`, 'invalid_format', 'บรรทัดผิดรูป');
      const no = l.lineNo;
      if (typeof no !== 'number' || !Number.isInteger(no) || no < 1)
        bad(`lines[${i}].lineNo`, 'invalid_format', 'เลขบรรทัดต้องเป็นจำนวนเต็มบวก');
      else if (seen.has(no)) bad(`lines[${i}].lineNo`, 'duplicate', 'เลขบรรทัดซ้ำ');
      else seen.add(no);
      for (const f of moneyFields) money(`lines[${i}].${f}`, l[f]);
      for (const f of optional) money(`lines[${i}].${f}`, l[f], false);
    });
  };
  const totals = (fields: readonly string[]) => {
    const t = isRec(doc.totals) ? doc.totals : null;
    if (!t) return bad('totals', 'required', 'ไม่มียอดรวม');
    for (const f of fields) money(`totals.${f}`, t[f]);
  };

  if (doc.kind === 'invoice') {
    date('issueDate', doc.issueDate, true);
    date('dueDate', doc.dueDate, false);
    totals(INVOICE_TOTALS);
    lines(['amount', 'vatAmount', 'discount']);
  } else if (doc.kind === 'settlement') {
    date('paidDate', doc.paidDate, true);
    const period = isRec(doc.period) ? doc.period : {};
    date('period.from', period.from, true);
    date('period.to', period.to, true);
    totals(SETTLEMENT_TOTALS);
    lines(['amount'], ['whtAmount']);
  }
  return out;
}
