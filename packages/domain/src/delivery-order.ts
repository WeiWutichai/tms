import type { TransitionTable } from './state-machine';

/**
 * Delivery Order (ST3-T09) — state machine (docs/01 §4.3 + D-23 "รับของแล้ว") และกฎแยก/รวม/จัดสรรปริมาณจาก SO
 * (docs/04 C แยก/รวม order, spec/03 §3 ORD-080/084/086) — ฟังก์ชันล้วน ใช้ได้ทั้ง API และเว็บ
 *
 * ปริมาณ/น้ำหนัก/ปริมาตรเป็นสตริงทศนิยม ≤ 3 ตำแหน่ง (numeric(14,3)) คิดเป็นจำนวนเต็มหน่วยพัน (bigint) — ไม่มี float
 */

// ---------- สถานะ + transition ----------

export const DO_STATUSES = [
  'DRAFT',
  'PLANNED',
  'DISPATCHED',
  'PICKED_UP',
  'DELIVERED',
  'FAILED',
  'RETURNED',
  'POD_PENDING',
  'UNBILLED',
  'BILLED',
  'CANCELLED',
] as const;
export type DoStatus = (typeof DO_STATUSES)[number];

export const DO_EVENTS = [
  'plan',
  'unplan',
  'dispatch',
  'pick_up',
  'deliver',
  'fail',
  'redeliver',
  'return',
  'pod_wait',
  'pod_accept',
  'bill',
  'unbill',
  'cancel',
  'split',
  'merge',
] as const;
export type DoEvent = (typeof DO_EVENTS)[number];

/**
 * ตาราง transition ตาม docs/01 §4.3 (mermaid) + D-23 (plan/00a RA-5):
 * - `plan` = อยู่ใน trip ที่ ASSIGNED (ST3-T11) · `unplan` = ถอดออกจาก trip · `dispatch` = trip DISPATCHED
 * - `pick_up` = รับของแล้ว (D-23 เพิ่ม — จุดที่ยกเลิก SO ไม่ได้อีก ORD-034); ส่งโดยไม่ยืนยันรับของ (DISPATCHED → DELIVERED) ยังได้ตาม docs
 * - `deliver` = stop COMPLETED outcome DELIVERED/PARTIAL (ส่งบางส่วน = DELIVERED + qty_actual — ไม่มีสถานะแยก)
 * - `redeliver` = ส่งใหม่: **DO เดิม CANCELLED** แล้วสร้าง DO ใหม่ (DRAFT) อ้าง `redelivery_of` (D-23 — ไม่วน DO เดิม)
 * - `pod_wait` / `pod_accept` = POD ไม่ครบ / ผ่านเกณฑ์ลูกค้า → รอวางบิล (UNBILLED) · `bill` / `unbill` = อยู่ใน/หลุดจาก invoice ISSUED
 * - ยกเลิกได้จาก DRAFT เท่านั้น: `cancel` (คน/ระบบ + เหตุผล), `split` (ใบแม่ที่ถูกแยก), `merge` (ใบที่ถูกรวมเข้าใบอื่น)
 */
export const DO_TRANSITIONS: TransitionTable<DoStatus, DoEvent> = {
  DRAFT: { plan: 'PLANNED', cancel: 'CANCELLED', split: 'CANCELLED', merge: 'CANCELLED' },
  PLANNED: { unplan: 'DRAFT', dispatch: 'DISPATCHED' },
  DISPATCHED: { pick_up: 'PICKED_UP', deliver: 'DELIVERED', fail: 'FAILED' },
  PICKED_UP: { deliver: 'DELIVERED', fail: 'FAILED' },
  FAILED: { redeliver: 'CANCELLED', return: 'RETURNED' },
  DELIVERED: { pod_wait: 'POD_PENDING', pod_accept: 'UNBILLED' },
  POD_PENDING: { pod_accept: 'UNBILLED' },
  UNBILLED: { bill: 'BILLED' },
  BILLED: { unbill: 'UNBILLED' },
  // RETURNED / CANCELLED = สถานะสิ้นสุด
};

/** สถานะที่ยังแก้ปริมาณ/แยก/รวม/ยกเลิกได้ (ก่อนพ้น DRAFT — ORD-083/086) */
export function isDoEditable(status: DoStatus): boolean {
  return status === 'DRAFT';
}

/** DO ที่ยังนับปริมาณจัดสรรของ SO (ไม่ใช่ใบยกเลิก) */
export function isDoActive(status: DoStatus): boolean {
  return status !== 'CANCELLED';
}

/** ป้ายไทยของสถานะ DO (spec/03 §3.6 ปรับตาม docs/01 §4.3) */
export const DO_STATUS_LABEL_TH: Record<DoStatus, string> = {
  DRAFT: 'รอจัดรถ',
  PLANNED: 'อยู่ในเที่ยว',
  DISPATCHED: 'ปล่อยรถแล้ว',
  PICKED_UP: 'รับของแล้ว',
  DELIVERED: 'ส่งสำเร็จ',
  FAILED: 'ส่งไม่สำเร็จ',
  RETURNED: 'ตีกลับ',
  POD_PENDING: 'รอ POD',
  UNBILLED: 'รอวางบิล',
  BILLED: 'วางบิลแล้ว',
  CANCELLED: 'ยกเลิก',
};

// ---------- ปริมาณทศนิยม 3 ตำแหน่ง ----------

const SCALE = 1000n;
const QTY_RE = /^\d{1,11}(\.\d{1,3})?$/;

export interface DoIssue {
  field: string;
  code: string;
  message: string;
}

/** กฎแยก/รวม/จัดสรรไม่ผ่าน — API แปลงเป็น 422 validation_failed (รวมทุกช่อง) */
export class DoRuleError extends Error {
  readonly code = 'validation_failed' as const;
  constructor(readonly issues: DoIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.code}`).join(', '));
  }
}

/** "12.5" → 12500n · รูปแบบผิด/ติดลบ/เกิน 3 ตำแหน่ง → null */
export function parseMilli(v: string): bigint | null {
  if (typeof v !== 'string' || !QTY_RE.test(v)) return null;
  const [i, f = ''] = v.split('.');
  return BigInt(i!) * SCALE + BigInt(f.padEnd(3, '0'));
}

/** 12500n → "12.5" (รูปมาตรฐาน ไม่มีศูนย์ท้าย) */
export function formatMilli(m: bigint): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const i = a / SCALE;
  const f = (a % SCALE).toString().padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${i}${f ? `.${f}` : ''}`;
}

/** ค่าจาก DB (Decimal.toString() / null) → milli · null = ไม่มีค่า */
function milliOrNull(v: string | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  const m = parseMilli(v);
  if (m === null) throw new Error(`invalid stored decimal ${v}`);
  return m;
}

/** a × num / den ปัดครึ่งขึ้น (ทุกตัว ≥ 0, den > 0) */
function mulDiv(a: bigint, num: bigint, den: bigint): bigint {
  return (a * num * 2n + den) / (2n * den);
}

// ---------- บรรทัด ----------

/** บรรทัด SO ที่ DO อ้าง (ค่าที่เก็บ — ทศนิยมเป็นสตริง) */
export interface SoLineInfo {
  id: string;
  lineNo: number;
  description: string;
  qtyOrdered: string;
  unit: string;
  /** น้ำหนัก/ปริมาตรรวมของบรรทัด (ไม่ใช่ต่อหน่วย) */
  weightKg: string | null;
  cbm: string | null;
}

/** บรรทัด DO (ผลของการจัดสรร/แยก/รวม — ค่าที่จะเขียนลง delivery_order_line) */
export interface DoLinePlan {
  salesOrderLineId: string;
  soLineNo: number;
  description: string;
  qty: string;
  unit: string;
  weightKg: string | null;
  cbm: string | null;
}

/** คำขอปริมาณต่อบรรทัด SO (จากผู้ใช้/ผู้เรียก) — `unit` ถ้าระบุต้องตรงหน่วยของบรรทัด */
export interface DoLineRequest {
  salesOrderLineId: string;
  qty: string;
  unit?: string | null;
}

/** ปริมาณที่ DO ใบอื่น (ที่ยังไม่ยกเลิก) จัดสรรไปแล้วต่อบรรทัด SO */
export interface DoAllocated {
  salesOrderLineId: string;
  qty: string;
  weightKg: string | null;
  cbm: string | null;
}

interface Remaining {
  qty: bigint;
  weight: bigint | null;
  cbm: bigint | null;
}

/** คงเหลือที่ยังจัดสรรได้ต่อบรรทัด SO (สั่ง − จัดสรรแล้ว) · จัดสรรเกินอยู่แล้ว (ข้อมูลเสีย) → ติดลบ */
export function remainingBySoLine(
  lines: readonly SoLineInfo[],
  allocated: readonly DoAllocated[],
): Map<string, Remaining> {
  const out = new Map<string, Remaining>();
  for (const l of lines)
    out.set(l.id, {
      qty: milliOrNull(l.qtyOrdered)!,
      weight: milliOrNull(l.weightKg),
      cbm: milliOrNull(l.cbm),
    });
  for (const a of allocated) {
    const r = out.get(a.salesOrderLineId);
    if (!r) continue;
    r.qty -= milliOrNull(a.qty)!;
    if (r.weight !== null) r.weight -= milliOrNull(a.weightKg) ?? 0n;
    if (r.cbm !== null) r.cbm -= milliOrNull(a.cbm) ?? 0n;
  }
  return out;
}

/** ส่วนของน้ำหนัก/ปริมาตรตามปริมาณ — ถ้าเอาคงเหลือหมด ได้น้ำหนักคงเหลือทั้งหมด (เศษปัดไปใบสุดท้าย รวมเท่าเดิม) */
function share(total: bigint | null, qty: bigint, ofQty: bigint): bigint | null {
  if (total === null) return null;
  if (qty === ofQty) return total < 0n ? 0n : total;
  const v = mulDiv(total < 0n ? 0n : total, qty, ofQty);
  return v;
}

function checkRequests(
  reqs: readonly DoLineRequest[],
  base: string,
  known: (id: string) => { unit: string } | undefined,
  issues: DoIssue[],
): Map<string, bigint> {
  const seen = new Map<string, bigint>();
  reqs.forEach((r, i) => {
    const f = `${base}[${i}]`;
    const line = known(r.salesOrderLineId);
    if (!line) {
      issues.push({
        field: `${f}.salesOrderLineId`,
        code: 'unknown_line',
        message: 'line not in source',
      });
      return;
    }
    if (seen.has(r.salesOrderLineId)) {
      issues.push({
        field: `${f}.salesOrderLineId`,
        code: 'duplicate_line',
        message: 'line listed twice',
      });
      return;
    }
    if (r.unit !== undefined && r.unit !== null && r.unit !== line.unit) {
      issues.push({
        field: `${f}.unit`,
        code: 'unit_mismatch',
        message: `unit must be ${line.unit}`,
      });
      return;
    }
    const q = parseMilli(r.qty);
    if (q === null || q <= 0n) {
      issues.push({
        field: `${f}.qty`,
        code: 'invalid_qty',
        message: 'qty must be a decimal string > 0 with at most 3 places',
      });
      return;
    }
    seen.set(r.salesOrderLineId, q);
  });
  return seen;
}

/**
 * จัดสรรปริมาณจาก SO ลง DO ใบใหม่ (สร้างจาก SO — ORD-081): ไม่ระบุ = คงเหลือทั้งหมดทุกบรรทัด (ค่าเริ่มต้น 1 DO = ทั้ง SO)
 * ระบุ = ตามที่ขอ โดย **ห้ามเกินคงเหลือ** (`over_allocated`) · หน่วยต้องตรงบรรทัด SO
 */
export function planAllocation(
  soLines: readonly SoLineInfo[],
  allocated: readonly DoAllocated[],
  request?: readonly DoLineRequest[] | null,
): DoLinePlan[] {
  const rem = remainingBySoLine(soLines, allocated);
  const byId = new Map(soLines.map((l) => [l.id, l]));
  const issues: DoIssue[] = [];
  let want: Map<string, bigint>;
  if (request === undefined || request === null) {
    want = new Map();
    for (const l of soLines) {
      const r = rem.get(l.id)!;
      if (r.qty > 0n) want.set(l.id, r.qty);
    }
  } else {
    if (request.length === 0)
      issues.push({ field: 'lines', code: 'empty', message: 'at least one line is required' });
    want = checkRequests(request, 'lines', (id) => byId.get(id), issues);
    request.forEach((r, i) => {
      const q = want.get(r.salesOrderLineId);
      const left = rem.get(r.salesOrderLineId);
      const first = request.findIndex((x) => x.salesOrderLineId === r.salesOrderLineId) === i;
      if (first && q !== undefined && left && q > left.qty)
        issues.push({
          field: `lines[${i}].qty`,
          code: 'over_allocated',
          message: `only ${formatMilli(left.qty < 0n ? 0n : left.qty)} left to allocate`,
        });
    });
  }
  if (issues.length) throw new DoRuleError(issues);
  const out: DoLinePlan[] = [];
  for (const l of soLines) {
    const q = want.get(l.id);
    if (q === undefined) continue;
    const r = rem.get(l.id)!;
    const w = share(r.weight, q, r.qty);
    const c = share(r.cbm, q, r.qty);
    out.push({
      salesOrderLineId: l.id,
      soLineNo: l.lineNo,
      description: l.description,
      qty: formatMilli(q),
      unit: l.unit,
      weightKg: w === null ? null : formatMilli(w),
      cbm: c === null ? null : formatMilli(c),
    });
  }
  return out;
}

/**
 * แยก DO (ORD-084): ใบเดิม → หลายส่วน (≥ 2) · **ปริมาณรวมต่อบรรทัดต้องเท่าใบเดิมพอดี** (`qty_not_conserved`)
 * ทุกส่วนต้องมีอย่างน้อย 1 บรรทัด · บรรทัดต้องเป็นของใบเดิม · หน่วยตรงใบเดิม
 * น้ำหนัก/ปริมาตรแบ่งตามสัดส่วนปริมาณ เศษปัดไปส่วนสุดท้ายที่มีบรรทัดนั้น (รวมเท่าใบเดิม — spec/03 §3.8)
 */
export function planSplit(
  source: readonly DoLinePlan[],
  parts: readonly (readonly DoLineRequest[])[],
): DoLinePlan[][] {
  const issues: DoIssue[] = [];
  if (!Array.isArray(parts) || parts.length < 2)
    throw new DoRuleError([
      { field: 'parts', code: 'too_few_parts', message: 'split needs at least 2 parts' },
    ]);
  const src = new Map(source.map((l) => [l.salesOrderLineId, l]));
  const asked = parts.map((p, i) => {
    if (!Array.isArray(p) || p.length === 0) {
      issues.push({
        field: `parts[${i}]`,
        code: 'empty',
        message: 'each part needs at least one line',
      });
      return new Map<string, bigint>();
    }
    return checkRequests(p, `parts[${i}]`, (id) => src.get(id), issues);
  });
  for (const l of source) {
    const sum = asked.reduce((s, m) => s + (m.get(l.salesOrderLineId) ?? 0n), 0n);
    if (sum !== parseMilli(l.qty))
      issues.push({
        field: `lines.${l.soLineNo}`,
        code: 'qty_not_conserved',
        message: `parts must add up to ${l.qty} ${l.unit} (got ${formatMilli(sum)})`,
      });
  }
  if (issues.length) throw new DoRuleError(issues);

  const out: DoLinePlan[][] = parts.map(() => []);
  for (const l of source) {
    const total = parseMilli(l.qty)!;
    let leftQty = total;
    let leftW = milliOrNull(l.weightKg);
    let leftC = milliOrNull(l.cbm);
    asked.forEach((m, i) => {
      const q = m.get(l.salesOrderLineId);
      if (q === undefined) return;
      const w = share(leftW, q, leftQty);
      const c = share(leftC, q, leftQty);
      leftQty -= q;
      if (leftW !== null && w !== null) leftW -= w;
      if (leftC !== null && c !== null) leftC -= c;
      out[i]!.push({
        ...l,
        qty: formatMilli(q),
        weightKg: w === null ? null : formatMilli(w),
        cbm: c === null ? null : formatMilli(c),
      });
    });
  }
  // เรียงบรรทัดในแต่ละส่วนตามลำดับบรรทัด SO
  for (const p of out) p.sort((a, b) => a.soLineNo - b.soLineNo);
  return out;
}

/**
 * รวม DO (ORD-086): บวกปริมาณ/น้ำหนัก/ปริมาตรต่อบรรทัด SO · หน่วยของบรรทัด SO เดียวกันต้องตรงกัน (`unit_mismatch`)
 * (ผู้เรียกตรวจเงื่อนไขระดับใบ: SO เดียวกัน จุดส่งเดียวกัน ยังไม่เข้าเที่ยว — `checkMergeable`)
 */
export function planMerge(dos: readonly (readonly DoLinePlan[])[]): DoLinePlan[] {
  const acc = new Map<
    string,
    { line: DoLinePlan; q: bigint; w: bigint | null; c: bigint | null }
  >();
  const issues: DoIssue[] = [];
  dos.forEach((lines, i) =>
    lines.forEach((l) => {
      const a = acc.get(l.salesOrderLineId);
      if (!a) {
        acc.set(l.salesOrderLineId, {
          line: l,
          q: parseMilli(l.qty)!,
          w: milliOrNull(l.weightKg),
          c: milliOrNull(l.cbm),
        });
        return;
      }
      if (a.line.unit !== l.unit) {
        issues.push({
          field: `deliveryOrders[${i}].lines.${l.soLineNo}`,
          code: 'unit_mismatch',
          message: `unit ${l.unit} ≠ ${a.line.unit}`,
        });
        return;
      }
      a.q += parseMilli(l.qty)!;
      const w = milliOrNull(l.weightKg);
      const c = milliOrNull(l.cbm);
      a.w = a.w === null && w === null ? null : (a.w ?? 0n) + (w ?? 0n);
      a.c = a.c === null && c === null ? null : (a.c ?? 0n) + (c ?? 0n);
    }),
  );
  if (issues.length) throw new DoRuleError(issues);
  return [...acc.values()]
    .map(({ line, q, w, c }) => ({
      ...line,
      qty: formatMilli(q),
      weightKg: w === null ? null : formatMilli(w),
      cbm: c === null ? null : formatMilli(c),
    }))
    .sort((a, b) => a.soLineNo - b.soLineNo);
}

export interface MergeCandidate {
  id: string;
  salesOrderId: string;
  destStopSeq: number;
  status: DoStatus;
  onTrip: boolean;
}

/** เงื่อนไขรวม DO (ORD-086): ≥ 2 ใบไม่ซ้ำ, SO เดียวกัน, จุดส่งเดียวกัน, ยังเป็น DRAFT และยังไม่เข้าเที่ยว */
export function checkMergeable(dos: readonly MergeCandidate[]): void {
  const issues: DoIssue[] = [];
  if (dos.length < 2 || new Set(dos.map((d) => d.id)).size !== dos.length)
    issues.push({
      field: 'deliveryOrderIds',
      code: 'too_few',
      message: 'merge needs at least 2 distinct delivery orders',
    });
  const first = dos[0];
  dos.forEach((d, i) => {
    if (first && d.salesOrderId !== first.salesOrderId)
      issues.push({
        field: `deliveryOrderIds[${i}]`,
        code: 'different_order',
        message: 'all delivery orders must belong to the same sales order',
      });
    else if (first && d.destStopSeq !== first.destStopSeq)
      issues.push({
        field: `deliveryOrderIds[${i}]`,
        code: 'different_drop',
        message: 'all delivery orders must deliver to the same stop',
      });
  });
  if (issues.length) throw new DoRuleError(issues);
}

/** น้ำหนัก/ปริมาตรรวมของ DO = Σ บรรทัด (null เมื่อไม่มีบรรทัดใดมีค่า) */
export function doTotals(lines: readonly DoLinePlan[]): {
  weightKg: string | null;
  cbm: string | null;
} {
  const sum = (pick: (l: DoLinePlan) => string | null) => {
    const vs = lines.map(pick).filter((v): v is string => v !== null);
    return vs.length ? formatMilli(vs.reduce((s, v) => s + parseMilli(v)!, 0n)) : null;
  };
  return { weightKg: sum((l) => l.weightKg), cbm: sum((l) => l.cbm) };
}
