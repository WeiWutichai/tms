import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { canonicalJson } from '../integration/outbox.service';
import type { CanonicalDocument } from './erp-adapter';

/**
 * ST8-T11 เทียบเอกสาร 2 ฝั่ง (docs/01 §6.5 "เทียบจาก canonical payload ทั้งสองฝั่ง") — ฟังก์ชันบริสุทธิ์ **ไม่ผูก ERP ใด**
 *
 * - `expected` = ส่วนของ canonical ที่ ERP เก็บได้ (`ErpAdapter.comparableDocument` ของเอกสารฉบับที่ออก — adapter ไม่ประกาศ = canonical
 *   ทั้งก้อน) · `remote` = ผลของ `fetchDocument` (adapter แปลง response ของ ERP กลับเป็น canonical)
 * - ระดับ (ตาราง docs/01 §6.5):
 *   · `HEADER` (FIELD) — ทุกช่องของหัวเอกสาร (ref ของเรา, รหัสลูกค้า, วันที่, due date …) ยกเว้นช่องเมตา (`sync`, `externalId`,
 *     `externalDocNo`) · หัวของใบอื่นที่ ERP แยกเก็บ (`partHeaderDiffs`) = ต่างที่หัว
 *   · `LINE_COUNT` (MONEY) — จำนวนรายการไม่เท่า **หรือ** มีรายการของเราที่ ERP ไม่มี (`missingLines` — ระบุว่ารายการไหนหาย)
 *   · `TOTAL` (MONEY) — ยอดรวม + ยอด VAT (tolerance 0.01) **เฉพาะเมื่อ ERP คืนยอดเงินมา** · ไม่คืน = ข้ามพร้อมเหตุผล
 *     (`totalSkipped: remote_has_no_amounts`) ไม่คำนวณยอดแทน ERP
 *   · `LINE_FIELD` (FIELD) — จับคู่รายการด้วย **เลข DO ของเรา** (ไม่ใช่ลำดับ) — DO เดียวหลายรายการ = จับด้วย `lineNo` ก่อน แล้วตามลำดับ ·
 *     รายการไม่มี DO = จับด้วย `lineNo` · ทุกช่องของรายการ (ปริมาณ ราคา วันที่ รถ ต้นทาง/ปลายทาง …) รวม "ค่าว่าง"
 *   · `EXTRA_LINE` (MONEY) — รายการที่ ERP มีแต่เราไม่มี
 * - ค่าว่าง: `null` / ไม่มีช่อง / `''` = ว่างเท่ากัน · ตัวเลข (สตริงทศนิยม) เทียบค่าทางตัวเลข (`1` = `1.00`) ไม่ใช้ float
 * - `diffHash` = sha256 ของส่วนต่างทั้งหมด (ก่อนตัด/ปิดชื่อ) — ส่วนต่างเดิม = hash เดิม → รอบถัดไปไม่แจ้งซ้ำ (docs/01 §6.5)
 * - ชื่อคนขับ (`trip.driverName`) ที่ไม่ว่างเก็บเป็น `***` (PDPA — รู้ได้ว่าต่าง/ว่าง แต่ไม่เก็บชื่อซ้ำในผลเทียบ)
 */

export const RECONCILE_CHECK_DOCUMENT = 'DOCUMENT';
export const RECONCILE_LEVELS = [
  'HEADER',
  'LINE_COUNT',
  'TOTAL',
  'LINE_FIELD',
  'EXTRA_LINE',
] as const;
export type ReconcileLevel = (typeof RECONCILE_LEVELS)[number];
/** severity ต่อระดับ (docs/01 §6.5) */
export const LEVEL_SEVERITY: Readonly<Record<ReconcileLevel, 'MONEY' | 'FIELD'>> = {
  HEADER: 'FIELD',
  LINE_COUNT: 'MONEY',
  TOTAL: 'MONEY',
  LINE_FIELD: 'FIELD',
  EXTRA_LINE: 'MONEY',
};
/** เหตุที่ข้ามการเทียบยอด */
export const TOTAL_SKIP_NO_AMOUNTS = 'remote_has_no_amounts';
/** เพดานรายการต่างที่เก็บต่อกลุ่ม (hash นับทั้งหมด) — ใบ 446 รายการ × ทุกช่องว่าง ไม่ให้แถวใหญ่เกิน */
export const MAX_DIFF_ITEMS = 1000;
/** ช่องเงิน (ชื่อท้าย path) — DTO แสดงผ่านช่อง `sell*` (สิทธิ์ราคาขาย) */
export const MONEY_FIELDS: ReadonlySet<string> = new Set([
  'unitPrice',
  'amount',
  'discount',
  'vatAmount',
  'total',
  'subtotalVatable',
  'subtotalExempt',
  'subtotalZeroRated',
  'whtExpected',
]);
const TOLERANCE = new Prisma.Decimal('0.01');
const HEADER_META = new Set([
  'sync',
  'externalId',
  'externalDocNo',
  'partHeaderDiffs',
  'lines',
  'totals',
]);
const LINE_META = new Set(['lineNo']);
/** ข้อมูลส่วนบุคคลที่ adapter ขอได้ (`CanonicalPersonalField`) — เก็บเป็น `***` ในผลเทียบ */
const PERSON_FIELDS = new Set(['trip.driverName', 'carrier.taxId']);

export interface FieldDiff {
  field: string;
  local: string | null;
  remote: string | null;
}
export interface LineRef {
  lineNo: number | null;
  deliveryOrderNumber: string | null;
}
export interface LineFieldDiff extends LineRef, FieldDiff {}

export interface DocumentDiff {
  check: typeof RECONCILE_CHECK_DOCUMENT;
  code: 'content_mismatch';
  levels: ReconcileLevel[];
  header: FieldDiff[];
  lineCount: { local: number; remote: number };
  missingLines: LineRef[];
  extraLines: LineRef[];
  lineFields: LineFieldDiff[];
  total: FieldDiff[];
  /** null = เทียบยอดแล้ว */
  totalSkipped: string | null;
  /** จำนวนที่ถูกตัดเกินเพดาน (ไม่มี = ไม่ตัด) */
  truncated?: Partial<Record<'header' | 'missingLines' | 'extraLines' | 'lineFields', number>>;
}

export interface CompareResult {
  matched: boolean;
  severity: 'MONEY' | 'FIELD' | null;
  levels: ReconcileLevel[];
  /** ส่วนต่างที่เก็บ (ตัดตามเพดาน + ปิดชื่อคนขับแล้ว) */
  diff: DocumentDiff;
  /** sha256 ของส่วนต่างเต็ม (ไม่มีส่วนต่าง = hash ของ "ตรง") */
  diffHash: string;
  /** เหตุที่ข้ามการเทียบยอด (ใช้ทั้งตอนตรงและไม่ตรง) */
  totalSkipped: string | null;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};

/** ค่าใบไม้ → สตริงที่เทียบได้ (ว่าง = null) */
function leaf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return canonicalJson(v);
}

/** object → path → ค่า (array = ค่าเดียวทั้งก้อน) */
function flatten(o: Rec, skip: ReadonlySet<string>, prefix = '', out = new Map<string, unknown>()) {
  for (const [k, v] of Object.entries(o)) {
    if (!prefix && skip.has(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Rec, skip, path, out);
    else out.set(path, v);
  }
  return out;
}

const DEC_RE = /^-?\d+(\.\d+)?$/;
function sameValue(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (DEC_RE.test(a) && DEC_RE.test(b)) return new Prisma.Decimal(a).eq(b);
  return false;
}

function fieldDiffs(
  local: Rec,
  remote: Rec,
  skip: ReadonlySet<string>,
  onlyLocal = false,
): FieldDiff[] {
  const l = flatten(local, skip);
  const r = flatten(remote, skip);
  const out: FieldDiff[] = [];
  for (const path of [...new Set([...l.keys(), ...r.keys()])].sort()) {
    // canonical รุ่นเก่า: ช่องที่ฉบับที่ส่งไม่มีเลย (ไม่ใช่ค่าว่าง) ไม่เทียบ
    if (onlyLocal && !l.has(path)) continue;
    const a = leaf(l.get(path));
    const b = leaf(r.get(path));
    if (!sameValue(a, b)) out.push({ field: path, local: a, remote: b });
  }
  return out;
}

const linesOf = (d: CanonicalDocument): Rec[] =>
  (Array.isArray(d.lines) ? d.lines : []).map((x) => rec(x));
const lineNoOf = (l: Rec): number | null =>
  Number.isInteger(l.lineNo) ? (l.lineNo as number) : null;
const doNoOf = (l: Rec): string | null => {
  const n = rec(l.deliveryOrder).number;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
};
const lineRef = (l: Rec): LineRef => ({ lineNo: lineNoOf(l), deliveryOrderNumber: doNoOf(l) });
/** key จับคู่: เลข DO · ไม่มี DO = เลขรายการ */
const keyOf = (l: Rec): string => {
  const d = doNoOf(l);
  if (d) return `do:${d}`;
  const n = lineNoOf(l);
  return n === null ? 'none' : `line:${n}`;
};

const isMoney = (v: unknown): v is string | number =>
  (typeof v === 'string' && DEC_RE.test(v)) || (typeof v === 'number' && Number.isFinite(v));

function mask(d: FieldDiff): FieldDiff {
  const last = d.field.split('.').slice(-2).join('.');
  if (!PERSON_FIELDS.has(last)) return d;
  return { ...d, local: d.local === null ? null : '***', remote: d.remote === null ? null : '***' };
}

function cap<T>(
  xs: T[],
  key: keyof NonNullable<DocumentDiff['truncated']>,
  t: DocumentDiff['truncated'],
): T[] {
  if (xs.length <= MAX_DIFF_ITEMS) return xs;
  t![key] = xs.length - MAX_DIFF_ITEMS;
  return xs.slice(0, MAX_DIFF_ITEMS);
}

export function compareDocuments(
  expected: CanonicalDocument,
  remote: CanonicalDocument,
  opts: { onlyLocalPaths?: boolean } = {},
): CompareResult {
  const only = opts.onlyLocalPaths === true;
  // ---------- HEADER ----------
  const header = fieldDiffs(expected as Rec, remote as Rec, HEADER_META, only);
  // หัวของใบอื่นที่ ERP แยกเก็บ (เช่น ใบที่แยกตาม vat_type) ต่างจากใบหลัก
  const parts = Array.isArray(remote.partHeaderDiffs) ? remote.partHeaderDiffs : [];
  for (const p of parts) {
    const r = rec(p);
    const ref = typeof r.ref === 'string' ? r.ref : '?';
    for (const [k, v] of Object.entries(r))
      if (k !== 'ref') header.push({ field: `parts[${ref}].${k}`, local: null, remote: leaf(v) });
  }

  // ---------- รายการ: จับคู่ด้วยเลข DO ----------
  const exp = linesOf(expected);
  const got = linesOf(remote);
  const pool = new Map<string, Rec[]>();
  for (const g of got) {
    const k = keyOf(g);
    pool.set(k, [...(pool.get(k) ?? []), g]);
  }
  const missingLines: LineRef[] = [];
  const lineFields: LineFieldDiff[] = [];
  for (const e of exp) {
    const cands = pool.get(keyOf(e)) ?? [];
    const n = lineNoOf(e);
    let i = n === null ? -1 : cands.findIndex((c) => lineNoOf(c) === n);
    if (i < 0) i = cands.length ? 0 : -1;
    if (i < 0) {
      missingLines.push(lineRef(e));
      continue;
    }
    const [g] = cands.splice(i, 1);
    for (const d of fieldDiffs(e, g!, LINE_META, only)) lineFields.push({ ...lineRef(e), ...d });
  }
  const extraLines: LineRef[] = [...pool.values()].flat().map(lineRef);

  // ---------- TOTAL ----------
  const total: FieldDiff[] = [];
  const lt = rec(expected.totals);
  const rt = rec(remote.totals);
  const remoteHasAmounts = isMoney(rt.total);
  let totalSkipped: string | null = null;
  if (!remoteHasAmounts || !isMoney(lt.total)) totalSkipped = TOTAL_SKIP_NO_AMOUNTS;
  else
    for (const f of ['total', 'vatAmount'] as const) {
      if (!isMoney(lt[f]) && !isMoney(rt[f])) continue;
      const a = isMoney(lt[f]) ? new Prisma.Decimal(lt[f]) : null;
      const b = isMoney(rt[f]) ? new Prisma.Decimal(rt[f]) : null;
      if (!a || !b || a.sub(b).abs().gt(TOLERANCE))
        total.push({
          field: `totals.${f}`,
          local: a?.toFixed(2) ?? null,
          remote: b?.toFixed(2) ?? null,
        });
    }

  const levels: ReconcileLevel[] = [];
  if (header.length) levels.push('HEADER');
  if (exp.length !== got.length || missingLines.length) levels.push('LINE_COUNT');
  if (total.length) levels.push('TOTAL');
  if (lineFields.length) levels.push('LINE_FIELD');
  if (extraLines.length) levels.push('EXTRA_LINE');
  const matched = levels.length === 0;
  const severity = matched
    ? null
    : levels.some((l) => LEVEL_SEVERITY[l] === 'MONEY')
      ? 'MONEY'
      : 'FIELD';
  const full = {
    levels,
    header,
    lineCount: { local: exp.length, remote: got.length },
    missingLines,
    extraLines,
    lineFields,
    total,
  };
  const diffHash = createHash('sha256')
    .update(canonicalJson({ check: RECONCILE_CHECK_DOCUMENT, ...(matched ? { matched } : full) }))
    .digest('hex');
  const truncated: NonNullable<DocumentDiff['truncated']> = {};
  const diff: DocumentDiff = {
    check: RECONCILE_CHECK_DOCUMENT,
    code: 'content_mismatch',
    levels,
    header: cap(header.map(mask), 'header', truncated),
    lineCount: full.lineCount,
    missingLines: cap(missingLines, 'missingLines', truncated),
    extraLines: cap(extraLines, 'extraLines', truncated),
    lineFields: cap(
      lineFields.map((d) => ({ ...d, ...mask(d) })),
      'lineFields',
      truncated,
    ),
    total,
    totalSkipped,
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
  return { matched, severity, levels, diff, diffHash, totalSkipped };
}
