import { Prisma } from '@prisma/client';
import {
  type CanonicalDocument,
  type ErpContext,
  type MasterCodeRefKind,
  type Problem,
  resolvedMasterCode,
  resolvedMasterCodeName,
} from '../../modules/erp/erp-adapter';

/**
 * Payload builder ของ KRS (ST8-T07; docs/01 A.3, §7.4) — canonical invoice (docs/01 §7.1–7.2) → body ของ
 * `POST /invoice` / `PUT /invoice/{transactionNo}` ตาม contract `packages/contracts/krs/invoice-request.schema.json`
 *
 * ฟังก์ชันบริสุทธิ์: ไม่มี I/O ไม่อ่านฐานข้อมูล ไม่เรียก KRS — การส่ง (`pushInvoice`) = ST8-T08, error = ST8-T09, GET = ST8-T10 (`krs-fetch.ts`)
 *
 * - **whitelist**: สร้าง object ใหม่ทีละฟิลด์จาก `KRS_INVOICE_HEADER_FIELDS` / `KRS_INVOICE_LINE_FIELDS` เท่านั้น (KRS: ส่งเกิน = 400)
 *   ไม่ serialize canonical ทั้งก้อน · ก่อนคืนผลตรวจซ้ำว่าไม่มี key นอกรายการ (`assertKrsWhitelist`) · test เทียบรายการกับ schema ของ contract
 * - วันที่ `YYYY-MM-DD` และต้องเป็นวันที่มีจริง (schema ของ contract ตรวจแค่รูป — KRS ของจริงอาจตอบ 400)
 * - `lineId` = `lineNo` ของ canonical (int) · 1 รายการ canonical = 1 รายการ KRS (ไม่รวม/ไม่แตกรายการ)
 * - ตัวเลข (`mainQuantity`, `unitPrice`): contract เป็น JSON number → แปลงจากสตริงทศนิยมของ canonical **เฉพาะเมื่อแปลงกลับได้ค่าเดิมทุกหลัก**
 *   (ไม่ปัด ไม่ใช้ float คำนวณ) — แปลงแล้วเพี้ยน = ไม่ส่ง (`number_not_exact`)
 * - ไม่ส่งส่วนลด/ยอดเงิน/VAT (A.3: KRS คำนวณเอง) — `expectedAmount` ของแต่ละใบ = ผลรวม `amount` ของ canonical เก็บไว้เทียบ (ST8-T11 reconcile ระดับ TOTAL — ST8-T10 ไม่เทียบยอด: GET ของ KRS จะคืนยอดไหม/ปัดอย่างไร [OPEN — KRS])
 * - `accountCode`: ส่งเฉพาะค่าที่หาเจอในผัง ACCOUNT ที่นำเข้าแล้ว — ยังไม่มีผัง = ไม่ส่ง key (A.3: ให้ KRS กำหนด default)
 * - รหัส master: ใช้ค่าที่ core ตรวจกับผังรหัสแล้ว (`ctx.masterCodes` — ST8-T06 `krsMasterCodeRefs`) · ค่าที่ไม่ได้ผ่านการตรวจ = ไม่ส่ง
 *   คืนรายการรหัสที่ขาดใน `missingMasterCodes`
 * - เกินเพดานขนาด → แบ่งเป็นหลายใบตามลำดับรายการ (จุดตัดคงที่: เติมทีละรายการจนเต็ม) หัวเอกสารซ้ำทุกใบ
 * - **ไม่แยกใบตาม `vat_type`** — เป็นงานของ ST8-T08 (แบ่งรายการก่อนแล้วเรียก builder ต่อกลุ่มด้วย `tmsVoucherNo` ของกลุ่ม)
 *
 * **[OPEN — KRS]** ทุกจุดที่ contract ไม่กำหนด เป็นค่าตั้งใน `KRS_PAYLOAD_DEFAULTS` (เปลี่ยนได้ต่อการเรียก) — รายการเต็ม: spec/12 §3 แถว ST8-T07
 * และ `packages/mock-krs/README.md` · คำถามยังไม่ได้ส่ง KRS (plan/08)
 */

/** ฟิลด์หัวเอกสารที่ contract รับ (docs/01 A.3 — บังคับทุกฟิลด์) */
export const KRS_INVOICE_HEADER_FIELDS = Object.freeze([
  'tmsVoucherNo',
  'voucherDate',
  'dueDate',
  'paymentInDay',
  'custOrSuppCode',
  'custOrSuppName',
  'address',
  'deliveryAddress',
  'salePerson',
  'saleName',
  'entryBy',
  'lines',
] as const);

/** ฟิลด์รายการที่ contract รับ (docs/01 A.3) */
export const KRS_INVOICE_LINE_FIELDS = Object.freeze([
  'lineId',
  'mainQuantity',
  'mainUnits',
  'unitPrice',
  'flowNo',
  'flowDate',
  'carId',
  'carPerson',
  'frWay',
  'toWay',
  'itemCode',
  'description',
  'accountCode',
] as const);

export interface KrsInvoiceLine {
  lineId: number;
  mainQuantity: number;
  mainUnits: string;
  unitPrice: number;
  flowNo: string;
  flowDate: string;
  carId: string;
  carPerson: string;
  frWay: string;
  toWay: string;
  itemCode?: string;
  description?: string;
  accountCode?: string;
}

export interface KrsInvoiceRequest {
  tmsVoucherNo: string;
  voucherDate: string;
  dueDate: string;
  paymentInDay: number;
  custOrSuppCode: string;
  custOrSuppName: string;
  address: string;
  deliveryAddress: string;
  salePerson: string;
  saleName: string;
  entryBy: string;
  lines: KrsInvoiceLine[];
}

/**
 * ค่าตั้งของ builder — **ทุกค่าเป็น [OPEN — KRS]** (contract ไม่กำหนด; เลือกทางระมัดระวังไว้ก่อน เปลี่ยนเมื่อ KRS ตอบ)
 */
export interface KrsPayloadOptions {
  /**
   * เพดานขนาด body (ไบต์ของ JSON แบบ UTF-8) — A.1 "สูงสุด 50 MB" ไม่บอกว่า MB = 10^6 หรือ 2^20 และวัดที่ไหน
   * → ใช้ค่าที่เล็กกว่า (50 × 10^6)
   */
  maxBytes: number;
  /** `entryBy` — A.3 "ค่าคงที่ `TMS` หรือ `issued_by`" · ยังไม่รู้ว่าต้องเป็น user ใน ERP ไหม (A.6) */
  entryBy: string;
  /** `deliveryAddress` — A.3 "ที่อยู่หลักของลูกค้า": canonical มีที่อยู่วางบิลอย่างเดียว → ใช้ที่อยู่วางบิล · `empty` = ส่งสตริงว่าง */
  deliveryAddress: 'billingAddress' | 'empty';
  /**
   * รายการที่ไม่ผูก DO (เช่น รายการที่ผู้ใช้เพิ่มเอง) — contract บังคับ `flowNo`/`flowDate`/`carId`/`carPerson`/`frWay`/`toWay` ทุกรายการ
   * `reject` = ไม่สร้าง payload (ไม่แต่งค่า) · `placeholder` = ใส่ `placeholderText` ในช่องข้อความ และ `flowDate` = `voucherDate`
   */
  lineWithoutDo: 'reject' | 'placeholder';
  placeholderText: string;
  /**
   * รายการที่มีส่วนลด — KRS คิดยอด = `mainQuantity` × `unitPrice` และไม่มีฟิลด์ส่วนลด
   * `reject` = ไม่สร้าง payload · `net-unit-price` = ส่งราคาต่อหน่วยหลังส่วนลด (`amount` ÷ `quantity`) เฉพาะเมื่อหารลงตัว
   * ไม่เกิน `netUnitPriceMaxScale` ตำแหน่ง (ไม่ลงตัว = ไม่สร้าง)
   */
  discount: 'reject' | 'net-unit-price';
  netUnitPriceMaxScale: number;
  /** `carPerson` เมื่อเที่ยวไม่มีชื่อคนขับ (เช่น รถร่วม): `none` = ไม่สร้าง payload · `carrierName` = ใช้ชื่อรถร่วม */
  carPersonFallback: 'none' | 'carrierName';
  /** `carId` เมื่อเที่ยวไม่มีทะเบียนรถ (เช่น รถร่วมที่ยังไม่ระบุรถ): `none` = ไม่สร้าง payload · `placeholder` = ใส่ `placeholderText` */
  carIdFallback: 'none' | 'placeholder';
  /** `lineId` เมื่อแบ่งหลายใบ: `canonical` = เลขบรรทัดเดิมของ TMS (จับคู่ตอน reconcile ได้) · `renumber` = เริ่ม 1 ใหม่ทุกใบ */
  splitLineId: 'canonical' | 'renumber';
  /**
   * `tmsVoucherNo` ของใบที่ 2 เป็นต้นไปเมื่อแบ่งใบ (KRS ตอบ 409 ถ้าเลขซ้ำ) — ใบแรกใช้เลขเดิมเสมอ
   * ผูกกับลำดับใบเท่านั้น (ไม่ผูกจำนวนใบ) → รายการเพิ่มภายหลังเลขของใบเดิมไม่เปลี่ยน
   */
  splitVoucherNo: (tmsVoucherNo: string, part: number) => string;
  /** เลขที่ส่งเป็น `tmsVoucherNo` (ไม่ระบุ = เลขใบแจ้งหนี้) — ST8-T08 ใช้เมื่อแยกใบตาม `vat_type` */
  tmsVoucherNo?: string;
}

export const KRS_MAX_PAYLOAD_BYTES = 50_000_000;
export const KRS_ENTRY_BY_DEFAULT = 'TMS';
export const KRS_SPLIT_VOUCHER_SUFFIX = '-P';

export const KRS_PAYLOAD_DEFAULTS: Readonly<KrsPayloadOptions> = Object.freeze({
  maxBytes: KRS_MAX_PAYLOAD_BYTES,
  entryBy: KRS_ENTRY_BY_DEFAULT,
  deliveryAddress: 'billingAddress',
  lineWithoutDo: 'reject',
  placeholderText: '-',
  discount: 'reject',
  netUnitPriceMaxScale: 4,
  carPersonFallback: 'none',
  carIdFallback: 'none',
  splitLineId: 'canonical',
  splitVoucherNo: (no: string, part: number) => `${no}${KRS_SPLIT_VOUCHER_SUFFIX}${part}`,
});

/** payload 1 ใบที่จะส่งเข้า KRS */
export interface KrsInvoiceDocument {
  /** ลำดับใบ (เริ่ม 1) / จำนวนใบทั้งหมด — ไม่แบ่ง = 1/1 */
  part: number;
  parts: number;
  tmsVoucherNo: string;
  body: KrsInvoiceRequest;
  /** ขนาด `JSON.stringify(body)` เป็นไบต์ (UTF-8) */
  bytes: number;
  /** `lineNo` ของ canonical ที่อยู่ในใบนี้ (ตามลำดับ) */
  lineNos: number[];
  /** ผลรวม `amount` ของ canonical ในใบนี้ (สตริงทศนิยม 2 ตำแหน่ง) — ไม่ส่งให้ KRS เก็บไว้เทียบกับยอดที่ KRS คำนวณ */
  expectedAmount: string;
  /**
   * `amount` ของ canonical ต่อรายการ (ลำดับเดียวกับ `body.lines`) — ST8-T11 เทียบกับยอดต่อรายการที่ KRS คำนวณ (ST8-T10 ไม่เทียบยอด)
   * จับคู่ด้วย `lineId` + `flowNo` (`flowNo` ซ้ำในใบได้ — หลายรายการต่อ DO) · KRS ปัดยอดอย่างไรยังไม่รู้ [OPEN — KRS]
   */
  expectedLines: { lineId: number; flowNo: string; amount: string }[];
}

/** รหัสที่ยังไม่ผ่านการตรวจกับผังรหัส / ไม่มีค่า */
export interface KrsMissingMasterCode {
  kind: MasterCodeRefKind;
  /** ค่าในเอกสาร (null = ไม่มีค่า) */
  value: string | null;
  /** ช่องของ KRS ที่ใช้ค่านี้ (สูงสุด 5) */
  fields: string[];
}

export const KRS_PAYLOAD_INVALID = 'krs_payload_invalid';

export type KrsPayloadResult =
  | { ok: true; documents: KrsInvoiceDocument[] }
  | { ok: false; problem: Problem; missingMasterCodes: KrsMissingMasterCode[] };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const MAX_PROBLEM_FIELDS = 50;
const MAX_FIELDS_PER_CODE = 5;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** ข้อความบรรทัดเดียว (A.3 "join เป็นบรรทัดเดียว") */
const oneLine = (v: unknown): string | null =>
  str(v)
    ?.replace(/\s*[\r\n]+\s*/g, ' ')
    .trim() ?? null;

/** `YYYY-MM-DD` ที่เป็นวันที่มีจริง */
export function isKrsDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** ตัดศูนย์ที่ไม่มีความหมายของสตริงทศนิยม (`"0350.0000"` → `"350"`, `"-0.50"` → `"-0.5"`, `"-0.00"` → `"0"`) */
function normalizeDecimal(s: string): string {
  const neg = s.startsWith('-');
  const [i = '0', f = ''] = (neg ? s.slice(1) : s).split('.');
  const int = i.replace(/^0+(?=\d)/, '');
  const frac = f.replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  return neg && out !== '0' ? `-${out}` : out;
}

/**
 * สตริงทศนิยม → JSON number **เฉพาะเมื่อไม่เพี้ยน**: `String(Number(s))` ต้องเท่ากับค่าเดิมทุกหลัก (หลังตัดศูนย์)
 * เกินความละเอียดของ double / ผิดรูป = null (ไม่ปัด)
 */
export function krsNumber(v: unknown): number | null {
  if (typeof v !== 'string' || !DECIMAL_RE.test(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (String(n) !== normalizeDecimal(v)) return null;
  return n === 0 ? 0 : n; // ไม่คืน -0
}

/** key นอก whitelist ของ body (ว่าง = ผ่าน) — ใช้ตรวจซ้ำก่อนคืนผล และใน test */
export function krsNonWhitelistedKeys(body: unknown): string[] {
  const out: string[] = [];
  const head = new Set<string>(KRS_INVOICE_HEADER_FIELDS);
  const line = new Set<string>(KRS_INVOICE_LINE_FIELDS);
  const b = rec(body);
  for (const k of Object.keys(b)) if (!head.has(k)) out.push(k);
  if (Array.isArray(b.lines))
    b.lines.forEach((l, i) => {
      for (const k of Object.keys(rec(l))) if (!line.has(k)) out.push(`lines[${i}].${k}`);
    });
  return out;
}

const bytesOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * canonical invoice → payload ของ KRS (1 ใบ หรือหลายใบเมื่อเกินเพดานขนาด)
 * `ctx.config.salePerson` = รหัสพนักงานขายของ connector · `ctx.masterCodes` = ค่าที่ core ตรวจกับผังรหัสแล้ว (ST8-T06)
 */
export function buildKrsInvoicePayload(
  ctx: Pick<ErpContext, 'config' | 'masterCodes'>,
  doc: CanonicalDocument,
  options: Partial<KrsPayloadOptions> = {},
): KrsPayloadResult {
  const opt: KrsPayloadOptions = { ...KRS_PAYLOAD_DEFAULTS, ...options };
  const fields: NonNullable<Problem['fields']> = [];
  const missing = new Map<string, KrsMissingMasterCode>();
  const bad = (field: string, code: string, message: string) => {
    if (fields.length < MAX_PROBLEM_FIELDS) fields.push({ field, code, message });
  };
  /** รหัสที่ core ตรวจแล้ว — ไม่มีค่า/ไม่ได้ผ่านการตรวจ = บันทึกว่าขาด (required) */
  const code = (
    kind: MasterCodeRefKind,
    value: string | null,
    field: string,
    required: boolean,
  ): string | null => {
    if (!value && !required) return null;
    const hit = value ? resolvedMasterCode(ctx, kind, value) : null;
    if (hit) return hit;
    const key = `${kind}|${value?.toLowerCase() ?? ''}`;
    const m = missing.get(key) ?? { kind, value, fields: [] };
    if (m.fields.length < MAX_FIELDS_PER_CODE) m.fields.push(field);
    missing.set(key, m);
    return null;
  };
  const text = (field: string, v: string | null, label: string): string => {
    if (!v) bad(field, 'required', `ไม่มี${label}`);
    return v ?? '';
  };
  const date = (field: string, v: unknown, label: string): string => {
    if (v === null || v === undefined || v === '') bad(field, 'required', `ไม่มี${label}`);
    else if (!isKrsDate(v)) bad(field, 'invalid_format', `${label}ต้องเป็น YYYY-MM-DD ที่มีจริง`);
    return typeof v === 'string' ? v : '';
  };
  const number = (field: string, v: unknown, label: string): number => {
    const n = krsNumber(v);
    if (n === null)
      bad(
        field,
        typeof v === 'string' && DECIMAL_RE.test(v) ? 'number_not_exact' : 'invalid_format',
        `${label}แปลงเป็นตัวเลขของ KRS แบบไม่เพี้ยนไม่ได้`,
      );
    return n ?? 0;
  };

  // ---------- หัวเอกสาร ----------
  const customer = rec(doc.customer);
  const tmsVoucherNo = text('tmsVoucherNo', str(opt.tmsVoucherNo) ?? str(doc.number), 'เลขเอกสาร');
  const voucherDate = date('voucherDate', doc.issueDate, 'วันที่เอกสาร');
  const dueDate = date('dueDate', doc.dueDate, 'วันครบกำหนด');
  const term = customer.paymentTermDays;
  if (typeof term !== 'number' || !Number.isInteger(term) || term < 0)
    bad('paymentInDay', 'invalid_format', 'เครดิตเทอมต้องเป็นจำนวนวัน (จำนวนเต็มไม่ติดลบ)');
  const custOrSuppCode = code('CUSTOMER', str(customer.externalId), 'custOrSuppCode', true);
  const custOrSuppName = text('custOrSuppName', oneLine(customer.legalName), 'ชื่อลูกค้า');
  const address = oneLine(customer.billingAddress) ?? '';
  const salePersonRaw = str(doc.salePerson) ?? str(ctx.config.salePerson);
  const salePerson = code('SALESPERSON', salePersonRaw, 'salePerson', true);
  const header: Omit<KrsInvoiceRequest, 'lines'> = {
    tmsVoucherNo,
    voucherDate,
    dueDate,
    paymentInDay: typeof term === 'number' ? term : 0,
    custOrSuppCode: custOrSuppCode ?? '',
    custOrSuppName,
    address,
    deliveryAddress: opt.deliveryAddress === 'billingAddress' ? address : '',
    salePerson: salePerson ?? '',
    saleName: resolvedMasterCodeName(ctx, 'SALESPERSON', salePersonRaw) ?? '',
    entryBy: text('entryBy', str(opt.entryBy), 'ผู้บันทึก (entryBy)'),
  };

  // ---------- รายการ ----------
  const rawLines: unknown[] = Array.isArray(doc.lines) ? doc.lines : [];
  if (!rawLines.length) bad('lines', 'required', 'เอกสารไม่มีรายการ');
  const built: { line: KrsInvoiceLine; lineNo: number; amount: string }[] = [];
  const seen = new Set<number>();
  rawLines.forEach((raw, i) => {
    const l = rec(raw);
    const at = `lines[${i}]`;
    const lineNo = l.lineNo;
    if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo < 1)
      bad(`${at}.lineId`, 'invalid_format', 'เลขบรรทัดต้องเป็นจำนวนเต็มบวก');
    else if (seen.has(lineNo)) bad(`${at}.lineId`, 'duplicate', 'เลขบรรทัดซ้ำ');
    else seen.add(lineNo);

    const mainQuantity = number(`${at}.mainQuantity`, l.quantity, 'จำนวน');
    let unitPrice = number(`${at}.unitPrice`, l.unitPrice, 'ราคาต่อหน่วย');
    const amount = typeof l.amount === 'string' && DECIMAL_RE.test(l.amount) ? l.amount : null;
    if (!amount) bad(`${at}.amount`, 'invalid_format', 'ยอดของรายการผิดรูป');
    const discount = typeof l.discount === 'string' ? krsNumber(l.discount) : 0;
    if (discount === null) bad(`${at}.discount`, 'invalid_format', 'ส่วนลดผิดรูป');
    else if (discount !== 0) {
      const net = opt.discount === 'net-unit-price' && amount ? netUnitPrice(amount, l, opt) : null;
      if (net === null)
        bad(
          `${at}.discount`,
          'krs_discount_unsupported',
          'KRS ไม่มีช่องส่วนลดต่อรายการ (KRS คิดยอด = จำนวน × ราคาต่อหน่วย)',
        );
      else unitPrice = net;
    }
    const mainUnits = code('UNIT', str(l.unitLabel), `${at}.mainUnits`, true);

    const d = rec(l.deliveryOrder);
    const trip = rec(l.trip);
    const route = rec(l.route);
    const hasDo = !!str(d.number);
    let flow: Pick<
      KrsInvoiceLine,
      'flowNo' | 'flowDate' | 'carId' | 'carPerson' | 'frWay' | 'toWay'
    >;
    if (!hasDo && opt.lineWithoutDo === 'placeholder') {
      const p = text(`${at}.flowNo`, str(opt.placeholderText), 'ค่าแทนของรายการที่ไม่ผูก DO');
      flow = { flowNo: p, flowDate: voucherDate, carId: p, carPerson: p, frWay: p, toWay: p };
    } else if (!hasDo) {
      bad(
        `${at}.flowNo`,
        'krs_line_without_do',
        'รายการไม่ผูก DO — KRS บังคับเลข DO/วันที่/รถ/คนขับ/เส้นทางทุกรายการ',
      );
      flow = { flowNo: '', flowDate: '', carId: '', carPerson: '', frWay: '', toWay: '' };
    } else {
      const driver =
        oneLine(trip.driverName) ??
        (opt.carPersonFallback === 'carrierName' ? oneLine(trip.carrierName) : null);
      flow = {
        flowNo: str(d.number)!,
        flowDate: date(`${at}.flowDate`, d.date, 'วันที่ DO'),
        carId: text(
          `${at}.carId`,
          oneLine(trip.vehiclePlate) ??
            (opt.carIdFallback === 'placeholder' ? str(opt.placeholderText) : null),
          'ทะเบียนรถของเที่ยว',
        ),
        carPerson: text(`${at}.carPerson`, driver, 'ชื่อคนขับของเที่ยว'),
        frWay: text(`${at}.frWay`, oneLine(route.originName), 'ชื่อต้นทาง'),
        toWay: text(`${at}.toWay`, oneLine(route.destinationName), 'ชื่อปลายทาง'),
      };
    }
    const itemCode = code('ITEM', str(rec(l.serviceItem).externalId), `${at}.itemCode`, false);
    // accountCode: ส่งเฉพาะค่าที่ตรวจกับผัง ACCOUNT ที่นำเข้าแล้ว — ยังไม่มีผัง (ค่าดิบ) = ไม่ส่ง ให้ KRS ใช้ค่าตั้งต้น (A.3)
    const accRaw = str(l.accountCode);
    const accHit = accRaw ? ctx.masterCodes?.ACCOUNT?.get(accRaw.toLowerCase()) : undefined;
    const accountCode =
      accRaw && accHit && !accHit.fromCatalogue
        ? null
        : code('ACCOUNT', accRaw, `${at}.accountCode`, false);
    const description = oneLine(l.description);
    built.push({
      lineNo: typeof lineNo === 'number' ? lineNo : 0,
      amount: amount ?? '0',
      line: {
        lineId: typeof lineNo === 'number' ? lineNo : 0,
        mainQuantity,
        mainUnits: mainUnits ?? '',
        unitPrice,
        ...flow,
        ...(itemCode ? { itemCode } : {}),
        ...(description ? { description } : {}),
        ...(accountCode ? { accountCode } : {}),
      },
    });
  });

  const fail = (): KrsPayloadResult => {
    const list = [...missing.values()];
    for (const m of list)
      bad(
        m.fields[0] ?? '',
        'master_code_unresolved',
        m.value
          ? `ค่า "${m.value}" (${m.kind}) ยังไม่ผ่านการตรวจกับผังรหัสของ KRS`
          : `ไม่มีค่า ${m.kind}`,
      );
    return {
      ok: false,
      problem: {
        code: KRS_PAYLOAD_INVALID,
        message: 'สร้าง payload ของ KRS ไม่ได้ — ข้อมูลไม่ครบตามสัญญา',
        fields,
      },
      missingMasterCodes: list,
    };
  };
  if (fields.length || missing.size) return fail();

  // ---------- แบ่งใบตามเพดานขนาด (เติมทีละรายการตามลำดับ → จุดตัดคงที่) ----------
  const voucherNoOf = (part: number) =>
    part === 1 ? tmsVoucherNo : opt.splitVoucherNo(tmsVoucherNo, part);
  // ขนาดหัวเอกสารของแต่ละใบต่างกันที่ `tmsVoucherNo` → คิดต่อใบ · ขนาดรวม = หัว (lines ว่าง) + รายการ + จุลภาคคั่น
  const headBytes = (part: number) =>
    bytesOf({ ...header, tmsVoucherNo: voucherNoOf(part), lines: [] });
  const renumber = opt.splitLineId === 'renumber';
  const groups: (typeof built)[] = [];
  let current: typeof built = [];
  let size = headBytes(1);
  for (const [i, b] of built.entries()) {
    // renumber: lineId ของใบที่แบ่งอาจยาวกว่าเลขเดิม → คิดจากตัวที่ยาวกว่า (ขนาดจริงไม่เกินที่คิดไว้)
    const lineBytes = (pos: number) =>
      renumber
        ? Math.max(bytesOf(b.line), bytesOf({ ...b.line, lineId: pos + 1 }))
        : bytesOf(b.line);
    if (current.length && size + 1 + lineBytes(current.length) > opt.maxBytes) {
      groups.push(current);
      current = [];
      size = headBytes(groups.length + 1);
    }
    const lb = lineBytes(current.length);
    if (!current.length && size + lb > opt.maxBytes) {
      bad(
        `lines[${i}]`,
        'krs_payload_too_large',
        `รายการเดียวใหญ่เกินเพดานขนาดของ KRS (${opt.maxBytes} ไบต์)`,
      );
      return fail();
    }
    size += lb + (current.length ? 1 : 0);
    current.push(b);
  }
  groups.push(current);

  const documents: KrsInvoiceDocument[] = groups.map((g, gi) => {
    const part = gi + 1;
    const lines = g.map((b, i) =>
      renumber && groups.length > 1 ? { ...b.line, lineId: i + 1 } : b.line,
    );
    const body: KrsInvoiceRequest = { ...header, tmsVoucherNo: voucherNoOf(part), lines };
    return {
      part,
      parts: groups.length,
      tmsVoucherNo: body.tmsVoucherNo,
      body,
      bytes: bytesOf(body),
      lineNos: g.map((b) => b.lineNo),
      expectedLines: g.map((b, i) => ({
        lineId: lines[i]!.lineId,
        flowNo: lines[i]!.flowNo,
        amount: new Prisma.Decimal(b.amount).toFixed(2),
      })),
      expectedAmount: g.reduce((sum, b) => sum.plus(b.amount), new Prisma.Decimal(0)).toFixed(2),
    };
  });

  // ตรวจซ้ำ: ไม่มี key นอก whitelist / เลขใบไม่ซ้ำกัน (แก้ builder ผิดแล้วต้องไม่หลุดถึง KRS)
  const extra = documents.flatMap((d) => krsNonWhitelistedKeys(d.body));
  if (extra.length) {
    for (const k of extra.slice(0, 10)) bad(k, 'krs_field_not_whitelisted', 'ฟิลด์นอกสัญญาของ KRS');
    return fail();
  }
  if (new Set(documents.map((d) => d.tmsVoucherNo)).size !== documents.length) {
    bad('tmsVoucherNo', 'duplicate', 'เลขเอกสารของใบที่แบ่งซ้ำกัน');
    return fail();
  }
  return { ok: true, documents };
}

/** ราคาต่อหน่วยหลังส่วนลด = `amount` ÷ `quantity` เฉพาะเมื่อหารลงตัวและแปลงเป็นตัวเลขได้ไม่เพี้ยน (ไม่งั้น null) */
function netUnitPrice(amount: string, line: Rec, opt: KrsPayloadOptions): number | null {
  if (typeof line.quantity !== 'string' || !DECIMAL_RE.test(line.quantity)) return null;
  const q = new Prisma.Decimal(line.quantity);
  if (q.isZero()) return null;
  const a = new Prisma.Decimal(amount);
  const net = a.div(q);
  if (!net.mul(q).eq(a) || net.decimalPlaces() > opt.netUnitPriceMaxScale) return null;
  return krsNumber(net.toFixed());
}
