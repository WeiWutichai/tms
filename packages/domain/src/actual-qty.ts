/**
 * ยอดส่งจริง + เหตุผลปฏิเสธรับ ต่อรายการ (ST4-T10; docs/04 E2 "Actual quantity + reject reason ต่อรายการ",
 * docs/01 §3.3 `delivery_order_line.qty_actual/reject_qty/reject_reason_code_id`, §5.3 POD `lines`)
 *
 * - ฟังก์ชันล้วน — จำนวนเป็นทศนิยม ≤ 3 ตำแหน่ง (numeric(14,3)) คิดเป็น bigint หน่วย 1/1000 (ไม่มี float)
 * - ส่งจริงต้อง 0 ≤ actual ≤ แผน (เกินแผน = ผิด — ของเกินไม่อยู่ใน DO) · ปฏิเสธ = แผน − ส่งจริง (คำนวณเอง)
 * - ส่งจริงน้อยกว่าแผน **ต้องมีเหตุผล** (reason master หมวด REJECTED_BY_RECEIVER) — ไม่มี = `reason_required`
 * - ส่งครบแผนแต่ส่งเหตุผลมา = `reason_not_applicable` (กันข้อมูลกำกวม)
 * - บรรทัดที่ไม่ส่งมา = คงค่าเดิม (ฉบับก่อน) หรือ "ตามแผน" ถ้ายังไม่เคยบันทึก
 *
 * วางบิลตามยอดส่งจริง (ตั้งต่อลูกค้า): `billableQtyBySoLine` รวมจำนวนที่คิดเงินต่อบรรทัด SO จาก DO ที่ไม่ยกเลิก
 * — ACTUAL ใช้ส่งจริง (ยังไม่บันทึก = แผน) · PLANNED ใช้แผนเสมอ · การคิดเงินใช้ pricing engine เดิม (`priceShipment`)
 */

export const ACTUAL_QTY_NOTE_MAX = 500;
/** สูตรราคาที่ยอดเงินขึ้นกับจำนวนสินค้า — สูตรอื่น (เหมาเที่ยว/ตามระยะทาง) ยอดส่งจริงไม่เปลี่ยนเงิน */
export const QTY_BASED_PRICING_MODELS = ['PER_TON', 'PER_CBM', 'PER_UNIT'] as const;
export type BillingBasis = 'PLANNED' | 'ACTUAL';

const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const SCALE = 1000n;

/** "12.5" → 12500n (หน่วย 1/1000) · รูปผิด = null */
export function milliQty(v: string | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!QTY.test(s)) return null;
  const [w, f = ''] = s.split('.') as [string, string?];
  return BigInt(w) * SCALE + BigInt((f + '000').slice(0, 3));
}

/** 12500n → "12.5" (ตัดศูนย์ท้าย) */
export function qtyText(m: bigint): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const whole = a / SCALE;
  const frac = (a % SCALE).toString().padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export interface PlannedDoLine {
  lineNo: number;
  qtyPlanned: string;
}

export interface ActualLineInput {
  lineNo: number;
  qtyActual: string;
  /** ส่งมาได้ (docs/01 §5.3) — ต้องเท่ากับ แผน − ส่งจริง */
  rejectQty?: string | null;
  rejectReasonCodeId?: string | null;
  note?: string | null;
}

/** ค่าที่บันทึกของบรรทัดหนึ่ง (หลังตรวจ) */
export interface ActualLineValue {
  lineNo: number;
  qtyPlanned: string;
  qtyActual: string;
  rejectQty: string;
  rejectReasonCodeId: string | null;
  note: string | null;
}

export type ActualLineErrorCode =
  | 'unknown_line'
  | 'duplicate'
  | 'invalid'
  | 'exceeds_planned'
  | 'reason_required'
  | 'reason_not_applicable'
  | 'reject_qty_mismatch'
  | 'too_long';

export interface ActualLineError {
  /** ตำแหน่งใน input (`lines.{index}.{field}`) */
  index: number;
  field: 'lineNo' | 'qtyActual' | 'rejectQty' | 'rejectReasonCodeId' | 'note';
  code: ActualLineErrorCode;
}

/**
 * ตรวจยอดส่งจริงที่ส่งมา แล้วรวมกับค่าเดิม (`previous` — บรรทัดที่ไม่ส่ง = คงเดิม)
 * คืน `lines` เรียงตาม lineNo เฉพาะบรรทัดที่เคย/เพิ่งบันทึก · มี error = ห้ามบันทึก
 */
export function checkActualLines(
  planned: readonly PlannedDoLine[],
  input: readonly ActualLineInput[],
  previous: readonly ActualLineValue[] = [],
): { lines: ActualLineValue[]; errors: ActualLineError[] } {
  const plan = new Map(planned.map((l) => [l.lineNo, l]));
  const out = new Map<number, ActualLineValue>();
  for (const p of previous) if (plan.has(p.lineNo)) out.set(p.lineNo, p);
  const errors: ActualLineError[] = [];
  const seen = new Set<number>();
  input.forEach((x, index) => {
    const err = (field: ActualLineError['field'], code: ActualLineErrorCode) =>
      errors.push({ index, field, code });
    const p = plan.get(x.lineNo);
    if (!p) return err('lineNo', 'unknown_line');
    if (seen.has(x.lineNo)) return err('lineNo', 'duplicate');
    seen.add(x.lineNo);
    const planQ = milliQty(p.qtyPlanned);
    const act = milliQty(x.qtyActual);
    if (planQ === null || act === null) return err('qtyActual', 'invalid');
    if (act > planQ) return err('qtyActual', 'exceeds_planned');
    const reject = planQ - act;
    if (x.rejectQty !== undefined && x.rejectQty !== null) {
      const r = milliQty(x.rejectQty);
      if (r === null) return err('rejectQty', 'invalid');
      if (r !== reject) return err('rejectQty', 'reject_qty_mismatch');
    }
    const reason = x.rejectReasonCodeId?.trim() || null;
    const note = x.note?.trim() || null;
    if (note && note.length > ACTUAL_QTY_NOTE_MAX) return err('note', 'too_long');
    if (reject > 0n && !reason) return err('rejectReasonCodeId', 'reason_required');
    if (reject === 0n && reason) return err('rejectReasonCodeId', 'reason_not_applicable');
    out.set(x.lineNo, {
      lineNo: x.lineNo,
      qtyPlanned: qtyText(planQ),
      qtyActual: qtyText(act),
      rejectQty: qtyText(reject),
      rejectReasonCodeId: reason,
      note: reject > 0n ? note : null,
    });
  });
  return { lines: [...out.values()].sort((a, b) => a.lineNo - b.lineNo), errors };
}

/** มีบรรทัดที่ส่งจริงน้อยกว่าแผน */
export const hasShortfall = (lines: readonly { rejectQty: string }[]) =>
  lines.some((l) => (milliQty(l.rejectQty) ?? 0n) > 0n);

export interface BillableDoLine {
  /** บรรทัด SO ที่ DO line อ้าง (null = บรรทัด SO ถูกลบ — ไม่นับ) */
  salesOrderLineId: string | null;
  qtyPlanned: string;
  /** null = ยังไม่บันทึกยอดส่งจริง (ถือว่าตามแผน) */
  qtyActual: string | null;
}

/**
 * จำนวนที่คิดเงินต่อบรรทัด SO = ผลรวมของบรรทัด DO (ที่ไม่ยกเลิก — ผู้เรียกกรองแล้ว)
 * ACTUAL: ส่งจริง (ยังไม่บันทึก = แผน) · PLANNED: แผน
 */
export function billableQtyBySoLine(
  lines: readonly BillableDoLine[],
  basis: BillingBasis,
): Map<string, string> {
  const sum = new Map<string, bigint>();
  for (const l of lines) {
    if (!l.salesOrderLineId) continue;
    const q =
      basis === 'ACTUAL' && l.qtyActual !== null ? milliQty(l.qtyActual) : milliQty(l.qtyPlanned);
    if (q === null) throw new RangeError(`invalid quantity on delivery order line`);
    sum.set(l.salesOrderLineId, (sum.get(l.salesOrderLineId) ?? 0n) + q);
  }
  return new Map([...sum].map(([k, v]) => [k, qtyText(v)]));
}

/** ยอดส่งจริงทำให้ยอดเงินของบรรทัดค่าขนส่งเปลี่ยนได้ (สูตรตามจำนวน) */
export const isQtyBasedPricing = (model: string | null | undefined) =>
  !!model && (QTY_BASED_PRICING_MODELS as readonly string[]).includes(model);
