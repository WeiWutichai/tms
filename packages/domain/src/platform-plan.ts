/**
 * ราคาแพ็กเกจของแพลตฟอร์ม (P1-ST1-T01; spec/01 §6 `PlanVersion`, docs/02 §2) — ตรวจความถูกต้องของข้อมูลราคาก่อนบันทึก
 * เงินเป็นสตริงทศนิยม ≤ 2 ตำแหน่ง (numeric(14,2)) · เปอร์เซ็นต์ 0–100 ≤ 2 ตำแหน่ง · ไม่ใช้ float
 * ไม่ใช่กฎภาษี — TMS ไม่ออกเอกสารภาษีค่าบริการของตัวเอง (plan/13 R-03)
 */
import { decimalFromSatang, mulRateHalfUp, satangFromDecimal } from './money';

export const ENTITLEMENT_MODES = ['included', 'addon', 'not_available'] as const;
export type EntitlementMode = (typeof ENTITLEMENT_MODES)[number];

export interface VolumeTier {
  /** คันที่เริ่มได้ส่วนลด (รวมคันนี้) */
  fromVehicle: number;
  /** ส่วนลด % เช่น "10.00" */
  discountPct: string;
}

export interface PlanPricingInput {
  /** บาท/รถ active/เดือน ก่อน VAT · null = ตกลงราคา */
  pricePerVehicleMonthly: string | null;
  minimumMonthly: string | null;
  annualDiscountPct: string;
  volumeTiers: VolumeTier[];
  vehicleMin: number;
  vehicleMax: number | null;
  trialDays: number;
}

export interface PlanPricingError {
  field: string;
  code: string;
}

/** เพดาน numeric(14,2) */
const MONEY_MAX = 999_999_999_999_99n;
const PCT_RE = /^\d{1,3}(\.\d{1,2})?$/;

function moneyError(v: string | null): string | null {
  if (v === null) return null;
  let s: bigint;
  try {
    s = satangFromDecimal(v);
  } catch {
    return 'money_format';
  }
  return s < 0n || s > MONEY_MAX ? 'money_range' : null;
}

function pctError(v: string): string | null {
  if (!PCT_RE.test(v)) return 'pct_format';
  return satangFromDecimal(v) > 100_00n ? 'pct_range' : null;
}

const isInt = (n: unknown, min: number, max: number) =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

/** ข้อผิดพลาดทั้งหมดของข้อมูลราคาเวอร์ชันหนึ่ง (ว่าง = ถูกต้อง) */
export function planPricingErrors(p: PlanPricingInput): PlanPricingError[] {
  const out: PlanPricingError[] = [];
  const money = (field: 'pricePerVehicleMonthly' | 'minimumMonthly') => {
    const e = moneyError(p[field]);
    if (e) out.push({ field, code: e });
  };
  money('pricePerVehicleMonthly');
  money('minimumMonthly');
  const d = pctError(p.annualDiscountPct);
  if (d) out.push({ field: 'annualDiscountPct', code: d });
  if (!isInt(p.vehicleMin, 1, 1_000_000)) out.push({ field: 'vehicleMin', code: 'vehicle_range' });
  else if (p.vehicleMax !== null && !isInt(p.vehicleMax, p.vehicleMin, 1_000_000))
    out.push({ field: 'vehicleMax', code: 'vehicle_range' });
  if (!isInt(p.trialDays, 0, 365)) out.push({ field: 'trialDays', code: 'trial_days_range' });
  let prev = 0;
  p.volumeTiers.forEach((t, i) => {
    if (!isInt(t.fromVehicle, 2, 1_000_000) || t.fromVehicle <= prev)
      out.push({ field: `volumeTiers[${i}].fromVehicle`, code: 'tiers_order' });
    else prev = t.fromVehicle;
    const e = typeof t.discountPct === 'string' ? pctError(t.discountPct) : 'pct_format';
    if (e) out.push({ field: `volumeTiers[${i}].discountPct`, code: e });
  });
  return out;
}

/** featureKey พื้นฐานที่ไม่ได้ตั้งเป็น included (PLT-061 → 422 basic_feature_locked) */
export function basicFeatureViolations(
  cells: readonly { featureKey: string; mode: EntitlementMode }[],
  basicKeys: ReadonlySet<string>,
): string[] {
  return cells
    .filter((c) => basicKeys.has(c.featureKey) && c.mode !== 'included')
    .map((c) => c.featureKey);
}

// ───────────────────────── ประมาณการค่าบริการ (P1-ST2-T02 → ใช้ต่อใน P1-ST3-T01) ─────────────────────────

export type BillingCycle = 'monthly' | 'annual';

/** ช่องราคาของ PlanVersion ที่ใช้คำนวณ (ตรงกับคอลัมน์ plan_version — เงินเป็นสตริงทศนิยม) */
export type PlanChargeInput = Pick<
  PlanPricingInput,
  'pricePerVehicleMonthly' | 'minimumMonthly' | 'annualDiscountPct' | 'volumeTiers'
>;

export interface PlanChargeEstimate {
  vehicles: number;
  cycle: BillingCycle;
  /** ราคาต่อรถก่อนส่วนลดใด ๆ */
  pricePerVehicle: string;
  /** รถ × ราคาต่อรถ (ก่อนส่วนลดตามจำนวนรถ) */
  baseMonthly: string;
  /** ส่วนลดตามจำนวนรถ (volume tiers) */
  volumeDiscountMonthly: string;
  /** ยอดตามรถหลังส่วนลดตามจำนวนรถ */
  usageMonthly: string;
  minimumMonthly: string | null;
  /** ยอดตามรถต่ำกว่าขั้นต่ำ → คิดขั้นต่ำ */
  minimumApplied: boolean;
  /** max(ยอดตามรถ, ขั้นต่ำ) */
  chargeableMonthly: string;
  annualDiscountPct: string;
  /** ส่วนลดรายปีต่อเดือน (รายเดือน = 0) */
  annualDiscountMonthly: string;
  /** ยอดต่อเดือนก่อน VAT */
  monthly: string;
  /** ยอดต่อปีก่อน VAT = ต่อเดือน × 12 */
  yearly: string;
}

/** "15.00" (%) → "0.1500" (อัตราสำหรับ mulRateHalfUp) */
function pctRate(pct: string): string {
  const hundredths = satangFromDecimal(pct); // 15.00% → 1500n
  return `${hundredths / 10000n}.${(hundredths % 10000n).toString().padStart(4, '0')}`;
}

/**
 * ประมาณการค่าบริการต่อเดือน/ต่อปี **ก่อน VAT** ของแพ็กเกจหนึ่งเวอร์ชัน (docs/02 §2; plan/13 P1-ST3-T01 สูตร
 * "max(รถ active × ราคาตาม tier/volume, ขั้นต่ำ) − ส่วนลด") — ตัวคำนวณหน้าราคาสาธารณะ (P1-ST2-T02) และประมาณการบิล
 * (P1-ST3-T01) ใช้ฟังก์ชันนี้ตัวเดียว · ไม่คำนวณภาษี (TMS ไม่ออกเอกสารภาษีค่าบริการ — plan/13 R-03)
 *
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (docs ไม่ได้ระบุ):
 * - ส่วนลดตามจำนวนรถเป็นแบบขั้นบันได: รถคันที่ ≥ fromVehicle ของ tier ได้ส่วนลดของ tier นั้น (คันก่อนหน้าไม่ได้) — ปัดสตางค์ half-up ต่อขั้น
 * - ขั้นต่ำเทียบกับยอดหลังส่วนลดตามจำนวนรถ · ส่วนลดรายปีคิดจากยอดหลังขั้นต่ำ (ปัด half-up) · ต่อปี = ต่อเดือน × 12
 * ตกลงราคา (pricePerVehicleMonthly = null) → null
 */
export function estimatePlanCharge(
  p: PlanChargeInput,
  vehicles: number,
  cycle: BillingCycle,
): PlanChargeEstimate | null {
  if (p.pricePerVehicleMonthly === null) return null;
  if (!Number.isInteger(vehicles) || vehicles < 0) throw new RangeError('vehicles');
  const price = satangFromDecimal(p.pricePerVehicleMonthly);
  const n = BigInt(vehicles);
  const base = price * n;
  const tiers = [...p.volumeTiers].sort((a, b) => a.fromVehicle - b.fromVehicle);
  let volumeDiscount = 0n;
  tiers.forEach((t, i) => {
    const from = t.fromVehicle;
    if (vehicles < from) return;
    const until = Math.min(vehicles, (tiers[i + 1]?.fromVehicle ?? Infinity) - 1);
    const count = BigInt(until - from + 1);
    volumeDiscount += mulRateHalfUp(price * count, pctRate(t.discountPct));
  });
  const usage = base - volumeDiscount;
  const minimum = p.minimumMonthly === null ? null : satangFromDecimal(p.minimumMonthly);
  const minimumApplied = minimum !== null && usage < minimum;
  const chargeable = minimumApplied ? minimum : usage;
  const annualDiscount =
    cycle === 'annual' ? mulRateHalfUp(chargeable, pctRate(p.annualDiscountPct)) : 0n;
  const monthly = chargeable - annualDiscount;
  return {
    vehicles,
    cycle,
    pricePerVehicle: decimalFromSatang(price),
    baseMonthly: decimalFromSatang(base),
    volumeDiscountMonthly: decimalFromSatang(volumeDiscount),
    usageMonthly: decimalFromSatang(usage),
    minimumMonthly: minimum === null ? null : decimalFromSatang(minimum),
    minimumApplied,
    chargeableMonthly: decimalFromSatang(chargeable),
    annualDiscountPct: p.annualDiscountPct,
    annualDiscountMonthly: decimalFromSatang(annualDiscount),
    monthly: decimalFromSatang(monthly),
    yearly: decimalFromSatang(monthly * 12n),
  };
}

/** ราคาต่อรถต่อเดือนหลังส่วนลดรายปี (การ์ดหน้าราคา) — ตกลงราคา = null */
export function perVehicleMonthly(p: PlanChargeInput, cycle: BillingCycle): string | null {
  if (p.pricePerVehicleMonthly === null) return null;
  const price = satangFromDecimal(p.pricePerVehicleMonthly);
  return decimalFromSatang(
    cycle === 'annual' ? price - mulRateHalfUp(price, pctRate(p.annualDiscountPct)) : price,
  );
}

/** แพ็กเกจที่ช่วงจำนวนรถ (vehicleMin–vehicleMax) ครอบ n คัน — ไม่มี = undefined (docs/02 §2 tier ตามขนาด fleet) */
export function planForVehicles<T extends { vehicleMin: number; vehicleMax: number | null }>(
  plans: readonly T[],
  vehicles: number,
): T | undefined {
  return plans.find(
    (p) => vehicles >= p.vehicleMin && (p.vehicleMax === null || vehicles <= p.vehicleMax),
  );
}

/** เซลล์ในตารางเปรียบเทียบ (spec/01 §2 ข้อ 3: ✓ / "ซื้อเพิ่ม" / ตัวเลขโควตา / —) */
export type EntitlementCell =
  | { kind: 'yes' }
  | { kind: 'addon' }
  | { kind: 'no' }
  | { kind: 'limit'; limit: number }
  | { kind: 'unlimited' };

/**
 * เซลล์ของฟีเจอร์ 1 ตัวในเวอร์ชันหนึ่ง — ไม่มีแถว = ไม่มีในแพ็กเกจ · addon = ซื้อเพิ่ม
 * included + ฟีเจอร์ boolean = ✓ · included + limit/metered = ตัวเลข (null = ไม่จำกัด)
 */
export function entitlementCell(
  featureType: string,
  e: { mode: EntitlementMode; limit: number | null } | undefined,
): EntitlementCell {
  if (!e || e.mode === 'not_available') return { kind: 'no' };
  if (e.mode === 'addon') return { kind: 'addon' };
  if (featureType === 'boolean') return { kind: 'yes' };
  return e.limit === null ? { kind: 'unlimited' } : { kind: 'limit', limit: e.limit };
}
