import { allocateSatang, allocateSatangRemainderTo, sumSatang, type Satang } from './money';

/** บรรทัดต้นทุนเที่ยวที่นับแล้ว (CONFIRMED) — ยอดเป็นสตางค์ (บรรทัดกลับรายการติดลบ) */
export interface CostAllocationLine {
  id: string;
  amount: Satang;
  /** บรรทัดนี้กลับรายการของบรรทัดใด (null = ไม่ใช่บรรทัดกลับรายการ) */
  reversalOfId: string | null;
}

export interface TripCostAllocation {
  /** ยอดต่อ DO (ตามลำดับ weights) — ผลรวม = ต้นทุนสุทธิ */
  targets: Satang[];
  /** ส่วนแบ่งต่อบรรทัด (ตามลำดับ weights) — ผลรวมต่อบรรทัด = ยอดบรรทัด */
  perLine: Map<string, Satang[]>;
}

/**
 * ปันต้นทุนเที่ยวลง DO (ST6-T01c — PO ตัดสิน 19 พ.ย. 2569) แบบตรงตัวอักษร:
 * 1) ปัน **ต้นทุนสุทธิของเที่ยว** ครั้งเดียวตามสัดส่วนน้ำหนัก (รายได้ DO) เศษสตางค์ทั้งหมด → `weights[remainderIndex]`
 *    (ผู้เรียกเรียง DO ให้ตัวรับเศษ = รายได้สูงสุด / เลข DO น้อยสุด)
 * 2) กระจายยอดต่อ DO ลงบรรทัด ให้ผลรวมต่อ DO = ยอดเป้าหมายพอดี และผลรวมต่อบรรทัด = ยอดบรรทัดพอดี:
 *    - คู่บรรทัดเดิม + บรรทัดกลับรายการ: ปันบรรทัดเดิมตามน้ำหนัก บรรทัดกลับรายการ = กลับเครื่องหมาย → สุทธิ 0 ต่อ DO
 *    - บรรทัดติดลบที่ไม่มีคู่: ปันตามน้ำหนัก (เพิ่มยอดที่บรรทัดบวกต้องเติม)
 *    - บรรทัดบวกตามลำดับ: ปันตามสัดส่วน "ยอดที่ยังต้องเติม" ของแต่ละ DO (largest remainder → ไม่เกินที่เหลือ ไม่ติดลบ)
 *      บรรทัดบวกสุดท้าย = ยอดที่เหลือทั้งหมด (ปิดยอดพอดี)
 * ไม่ใช้ float · ต้นทุนสุทธิติดลบ / ผลไม่ลงตัว → RangeError
 */
export function allocateTripCostLines(
  lines: readonly CostAllocationLine[],
  weights: readonly bigint[],
  remainderIndex = 0,
): TripCostAllocation {
  const n = weights.length;
  const net = sumSatang(lines.map((l) => l.amount));
  if (net < 0n) throw new RangeError('allocateTripCostLines: net cost must be >= 0');
  const targets = allocateSatangRemainderTo(net, weights, remainderIndex);
  const perLine = new Map<string, Satang[]>();
  const byId = new Map(lines.map((l) => [l.id, l]));
  const paired = new Set<string>();
  for (const r of lines) {
    const o = r.reversalOfId ? byId.get(r.reversalOfId) : undefined;
    if (!o || paired.has(o.id) || paired.has(r.id) || o.amount !== -r.amount) continue;
    const parts = allocateSatangRemainderTo(o.amount, weights, remainderIndex);
    perLine.set(o.id, parts);
    perLine.set(
      r.id,
      parts.map((v) => -v),
    );
    paired.add(o.id).add(r.id);
  }
  const live = lines.filter((l) => !paired.has(l.id));
  const remaining = [...targets];
  for (const l of live.filter((x) => x.amount < 0n)) {
    const parts = allocateSatangRemainderTo(l.amount, weights, remainderIndex);
    perLine.set(l.id, parts);
    parts.forEach((v, i) => (remaining[i]! -= v));
  }
  const positive = live.filter((x) => x.amount >= 0n);
  positive.forEach((l, idx) => {
    const parts =
      idx === positive.length - 1 ? [...remaining] : allocateSatang(l.amount, remaining);
    perLine.set(l.id, parts);
    parts.forEach((v, i) => (remaining[i]! -= v));
  });
  // ตรวจลงตัว: ทุกบรรทัด = ยอดบรรทัด · ทุก DO = เป้าหมาย (ไม่ติดลบ)
  const sums = Array.from({ length: n }, () => 0n);
  for (const l of lines) {
    const parts = perLine.get(l.id)!;
    if (sumSatang(parts) !== l.amount)
      throw new RangeError('allocateTripCostLines: line does not balance');
    parts.forEach((v, i) => (sums[i]! += v));
  }
  if (sums.some((v, i) => v !== targets[i] || v < 0n))
    throw new RangeError('allocateTripCostLines: delivery order totals do not balance');
  return { targets, perLine };
}
