/**
 * ราคาแพ็กเกจของแพลตฟอร์ม (P1-ST1-T01; spec/01 §6 `PlanVersion`, docs/02 §2) — ตรวจความถูกต้องของข้อมูลราคาก่อนบันทึก
 * เงินเป็นสตริงทศนิยม ≤ 2 ตำแหน่ง (numeric(14,2)) · เปอร์เซ็นต์ 0–100 ≤ 2 ตำแหน่ง · ไม่ใช้ float
 * ไม่ใช่กฎภาษี — TMS ไม่ออกเอกสารภาษีค่าบริการของตัวเอง (plan/13 R-03)
 */
import { satangFromDecimal } from './money';

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
