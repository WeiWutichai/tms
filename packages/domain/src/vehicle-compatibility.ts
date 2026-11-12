/**
 * Vehicle-type compatibility (ST2-T16) — docs/04 B "matrix ประเภทรถ × ประเภทงาน/สินค้า/จุดส่ง
 * (เช่น ห้องเย็นเท่านั้น, ห้าม 10 ล้อเข้าซอย) — เตือน + override พร้อมเหตุผล"
 *
 * ฟังก์ชันล้วน ไม่มี I/O: รับประเภทรถที่จะใช้ + สินค้า + จุดรับ/ส่ง + ความต้องการของงาน → คืนรายการคำเตือน
 * - **คำเตือนเท่านั้น ไม่บล็อก** (docs/04 C "ตรวจ constraint ตอนจัด … เตือน + override พร้อมเหตุผล ไม่บล็อก");
 *   การ override + เหตุผล + audit ทำใน ST3-T14
 * - รหัสคำเตือนใช้ชุดหลักของ spec/03 §6 (`TEMP_MISMATCH`, `HAZMAT_NOT_ALLOWED`, `LOCATION_VEHICLE_LIMIT`)
 *   + 3 รหัสของงาน (ความสามารถที่งานต้องการ, ประเภทรถที่ SO ขอ — MD-093)
 * - ผลเรียงแน่นอน: งาน → สินค้า (ตามลำดับที่ส่ง) → จุด (ตามลำดับที่ส่ง); สินค้า/จุดที่ id ซ้ำนับครั้งเดียว
 */

/** ชั้นรถ เรียงเล็ก → ใหญ่ — ชุดเดียวกับ `vehicle_type.vehicle_class` และ `customer_site.max_vehicle_class` */
export const VEHICLE_CLASSES = ['4W', '6W', '10W', 'TRAILER', 'SEMI_TRAILER'] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

/** `sizeRank` ของ spec/02 §4 (4 ล้อ=1, 6 ล้อ=3, 10 ล้อ=5, พ่วง/เทรลเลอร์=8) — ใช้เทียบข้อจำกัดสถานที่ (MD-054) และ MD-093 */
export const VEHICLE_CLASS_RANK: Record<VehicleClass, number> = {
  '4W': 1,
  '6W': 3,
  '10W': 5,
  TRAILER: 8,
  SEMI_TRAILER: 8,
};

/** capability tags ของประเภทรถ (docs/04 B รถ) — รายการคงที่ของระบบ */
export const VEHICLE_CAPABILITIES = ['REFRIGERATED', 'CRANE', 'CONTAINER', 'HAZMAT'] as const;
export type VehicleCapability = (typeof VEHICLE_CAPABILITIES)[number];

export const COMPATIBILITY_CODES = [
  'CAPABILITY_MISSING',
  'VEHICLE_SMALLER_THAN_REQUESTED',
  'VEHICLE_LARGER_THAN_REQUESTED',
  'TEMP_MISMATCH',
  'HAZMAT_NOT_ALLOWED',
  'LOCATION_VEHICLE_LIMIT',
] as const;
export type CompatibilityCode = (typeof COMPATIBILITY_CODES)[number];

/** `warning` = ต้องระบุเหตุผลถ้าจะใช้ต่อ (ST3-T14) · `info` = ป้ายแจ้งเฉย ๆ (MD-093 "ใช้รถใหญ่กว่า") */
export type CompatibilitySeverity = 'warning' | 'info';

/** อุณหภูมิ: ตัวเลขหรือสตริงทศนิยม (Prisma Decimal → string) ทศนิยมไม่เกิน 1 ตำแหน่ง (numeric(4,1)) */
export type TempValue = number | string | null | undefined;

export interface CompatVehicleType {
  id?: string;
  code?: string;
  vehicleClass: VehicleClass | string;
  capabilityTags: readonly string[];
  tempMinC?: TempValue;
  tempMaxC?: TempValue;
}

export interface CompatProduct {
  id?: string;
  code?: string;
  tempControlled: boolean;
  tempMinC?: TempValue;
  tempMaxC?: TempValue;
  hazardous: boolean;
}

export interface CompatSite {
  id?: string;
  code?: string;
  /** null = ไม่จำกัด */
  maxVehicleClass: VehicleClass | string | null;
}

/** ความต้องการของงาน (SO) — ST3 ส่งมา; ไม่มีตารางประเภทงานแยก (plan/00b: ใช้กฎกระจายแบบ spec) */
export interface CompatJob {
  /** ประเภทรถที่ SO ขอ (MD-093 — ค่า "ต้องการ") */
  requestedVehicleClass?: VehicleClass | string | null;
  /** ความสามารถที่งานต้องการ เช่น CRANE (ติดเครน), CONTAINER (ลากตู้) */
  requiredCapabilities?: readonly (VehicleCapability | string)[];
}

export interface CompatibilityInput {
  vehicleType: CompatVehicleType;
  products?: readonly CompatProduct[];
  sites?: readonly CompatSite[];
  job?: CompatJob | null;
}

export type CompatibilitySourceKind = 'job' | 'product' | 'site';

export interface CompatibilityWarning {
  code: CompatibilityCode;
  severity: CompatibilitySeverity;
  /** key ข้อความ (`compat.*`) — ข้อความไทยอยู่ที่ผู้แสดงผล */
  messageKey: string;
  params: Record<string, string | number | null>;
  source: { kind: CompatibilitySourceKind; id?: string; code?: string };
}

/** แปลงอุณหภูมิเป็นหน่วย 0.1 °C (จำนวนเต็ม) — กันเทียบ float; ค่าว่าง/อ่านไม่ได้ = null */
function tenths(v: TempValue): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10);
}

function rank(cls: string | null | undefined): number | null {
  if (!cls) return null;
  return (VEHICLE_CLASS_RANK as Record<string, number>)[cls] ?? null;
}

function src(
  kind: CompatibilitySourceKind,
  x?: { id?: string; code?: string },
): CompatibilityWarning['source'] {
  const s: CompatibilityWarning['source'] = { kind };
  if (x?.id !== undefined) s.id = x.id;
  if (x?.code !== undefined) s.code = x.code;
  return s;
}

function uniqueById<T extends { id?: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (it.id !== undefined) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
    }
    out.push(it);
  }
  return out;
}

/**
 * ตรวจความเข้ากันได้ของประเภทรถกับงาน/สินค้า/จุด → รายการคำเตือน (ว่าง = เข้ากันได้)
 *
 * กฎ:
 * - งานต้องการความสามารถ X แต่ประเภทรถไม่มีป้าย X → `CAPABILITY_MISSING`
 * - ประเภทรถเล็กกว่าที่ SO ขอ (sizeRank) → `VEHICLE_SMALLER_THAN_REQUESTED`; ใหญ่กว่า → `VEHICLE_LARGER_THAN_REQUESTED` (info, MD-093)
 * - สินค้าควบคุมอุณหภูมิ แต่รถไม่มีป้าย REFRIGERATED → `TEMP_MISMATCH` (compat.tempNotRefrigerated)
 *   หรือช่วงอุณหภูมิรถไม่ครอบคลุม (min รถ ≤ min สินค้า และ max รถ ≥ max สินค้า — MD-072) → `TEMP_MISMATCH` (compat.tempRangeNotCovered)
 * - สินค้าอันตราย แต่รถไม่มีป้าย HAZMAT → `HAZMAT_NOT_ALLOWED` (MD-071)
 * - จุดจำกัดรถเข้าได้สูงสุด และ sizeRank ของรถ > ของจุด → `LOCATION_VEHICLE_LIMIT` (MD-054)
 */
export function checkVehicleCompatibility(input: CompatibilityInput): CompatibilityWarning[] {
  const vt = input.vehicleType;
  const tags = new Set(vt.capabilityTags);
  const vRank = rank(vt.vehicleClass);
  const out: CompatibilityWarning[] = [];

  // 1) งาน
  const job = input.job;
  if (job) {
    const req = [...new Set(job.requiredCapabilities ?? [])].sort(
      (a, b) =>
        (VEHICLE_CAPABILITIES as readonly string[]).indexOf(a) -
          (VEHICLE_CAPABILITIES as readonly string[]).indexOf(b) || (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const cap of req) {
      if (!tags.has(cap)) {
        out.push({
          code: 'CAPABILITY_MISSING',
          severity: 'warning',
          messageKey: 'compat.capabilityMissing',
          params: { capability: cap },
          source: src('job'),
        });
      }
    }
    const reqRank = rank(job.requestedVehicleClass);
    if (reqRank !== null && vRank !== null && vRank !== reqRank) {
      const smaller = vRank < reqRank;
      out.push({
        code: smaller ? 'VEHICLE_SMALLER_THAN_REQUESTED' : 'VEHICLE_LARGER_THAN_REQUESTED',
        severity: smaller ? 'warning' : 'info',
        messageKey: smaller ? 'compat.smallerThanRequested' : 'compat.largerThanRequested',
        params: {
          requestedClass: job.requestedVehicleClass ?? null,
          vehicleClass: vt.vehicleClass,
        },
        source: src('job'),
      });
    }
  }

  // 2) สินค้า
  const vMin = tenths(vt.tempMinC);
  const vMax = tenths(vt.tempMaxC);
  for (const p of uniqueById(input.products ?? [])) {
    if (p.tempControlled) {
      if (!tags.has('REFRIGERATED')) {
        out.push({
          code: 'TEMP_MISMATCH',
          severity: 'warning',
          messageKey: 'compat.tempNotRefrigerated',
          params: { productTempMinC: num(p.tempMinC), productTempMaxC: num(p.tempMaxC) },
          source: src('product', p),
        });
      } else {
        const pMin = tenths(p.tempMinC);
        const pMax = tenths(p.tempMaxC);
        // ช่วงของรถหรือสินค้าไม่ครบ = ยืนยันไม่ได้ว่าครอบคลุม → เตือน
        const covered =
          vMin !== null && vMax !== null && pMin !== null && pMax !== null
            ? vMin <= pMin && vMax >= pMax
            : false;
        if (!covered) {
          out.push({
            code: 'TEMP_MISMATCH',
            severity: 'warning',
            messageKey: 'compat.tempRangeNotCovered',
            params: {
              productTempMinC: num(p.tempMinC),
              productTempMaxC: num(p.tempMaxC),
              vehicleTempMinC: num(vt.tempMinC),
              vehicleTempMaxC: num(vt.tempMaxC),
            },
            source: src('product', p),
          });
        }
      }
    }
    if (p.hazardous && !tags.has('HAZMAT')) {
      out.push({
        code: 'HAZMAT_NOT_ALLOWED',
        severity: 'warning',
        messageKey: 'compat.hazmatNotAllowed',
        params: {},
        source: src('product', p),
      });
    }
  }

  // 3) จุดรับ/ส่ง
  for (const s of uniqueById(input.sites ?? [])) {
    const sRank = rank(s.maxVehicleClass);
    if (sRank !== null && vRank !== null && vRank > sRank) {
      out.push({
        code: 'LOCATION_VEHICLE_LIMIT',
        severity: 'warning',
        messageKey: 'compat.locationVehicleLimit',
        params: { maxVehicleClass: s.maxVehicleClass ?? null, vehicleClass: vt.vehicleClass },
        source: src('site', s),
      });
    }
  }

  return out;
}

function num(v: TempValue): number | null {
  const t = tenths(v);
  return t === null ? null : t / 10;
}

/** มีคำเตือนที่ต้องระบุเหตุผลก่อนใช้ต่อหรือไม่ (ไม่นับ `info`) */
export function hasCompatibilityWarnings(warnings: readonly CompatibilityWarning[]): boolean {
  return warnings.some((w) => w.severity === 'warning');
}
