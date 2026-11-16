/**
 * กฎตอนจัดรถ (ST3-T14; docs/04 D2 "ตรวจ constraint ตอนจัด"; spec/03 §6) — ฟังก์ชันล้วน ไม่มี I/O
 *
 * **D-07 (PO 16 พ.ย. 2569 — "ผสม")**
 * - กฎเกี่ยวกับ**เอกสาร** = **บล็อก**: เอกสารรถบังคับหมด/ไม่มี/ยังไม่เริ่ม (`DOC_*` — ทั้งรถบริษัทและรถร่วม, ST2-T20
 *   `checkAssignability`) + ใบขับขี่ไม่มี/หมด/ชั้นไม่ถึง (`DRIVER_LICENCE_*`) → ทำรายการไม่ได้ เว้นแต่ผู้มีสิทธิ์
 *   `trips:override` (ผู้จัดการ/ผู้ดูแล) ยกเว้นพร้อมเหตุผล ≥ 10 ตัวอักษร + audit
 * - ที่เหลือ = **คำเตือน**: น้ำหนัก/ปริมาตรเกิน, ความเข้ากันได้ของประเภทรถ/จุดส่งไม่รับรถ, ชั่วโมงขับ, ซ้อนเวลา ฯลฯ
 *   → บันทึกได้ แต่ผู้วางแผนต้อง "ยืนยันพร้อมเหตุผล" (≥ 10 ตัวอักษร + audit) ก่อนปล่อยรถ
 *
 * กฎใหม่ของ ST3-T14 ที่ไม่มีใน ST2-T16/T20: น้ำหนัก/ปริมาตร (`checkLoad`), ชั่วโมงขับ (`checkDrivingHours`)
 */

/** รหัสกฎที่เป็นบล็อกตาม D-07 (กฎเอกสาร) — ที่เหลือเป็นคำเตือน */
export const BLOCKING_RULE_PREFIXES = ['DOC_', 'DRIVER_LICENCE_'] as const;

export const isBlockingRule = (code: string): boolean =>
  BLOCKING_RULE_PREFIXES.some((p) => code.startsWith(p));

/** เหตุผลขั้นต่ำของการยกเว้น/ยืนยันกฎ (CLAUDE.md — ทุก override ต้องมีเหตุผล) */
export const RULE_REASON_MIN_LENGTH = 10;

/** scope ที่ยกเว้น "บล็อก" ได้ (D-07: ผู้จัดการ/ผู้ดูแล) · คำเตือนยืนยันได้ด้วย `trips:assign` */
export const RULE_OVERRIDE_SCOPE = 'trips:override';

// ------------------------------------------------------------------------------------------------
// น้ำหนัก / ปริมาตร

export interface LoadInput {
  /** น้ำหนักรวมของ DO ในเที่ยว (กก. — สตริงทศนิยมจาก Decimal หรือ number) */
  weightKg: string | number | null;
  cbm: string | number | null;
  /** ความจุ (MD-091: รถ ถ้ามี มิฉะนั้นประเภทรถ; มีหาง = ของหาง) — null = ไม่ทราบ ไม่ตรวจ */
  capacityKg: string | number | null;
  capacityCbm: string | number | null;
}

export interface LoadIssue {
  code: 'OVERWEIGHT' | 'OVER_VOLUME';
  severity: 'warning';
  messageKey: 'rule.overweight' | 'rule.overVolume';
  params: { load: string; capacity: string; over: string };
}

/** แปลงเป็นหน่วย 1/1000 (จำนวนเต็ม) — ไม่เทียบ float */
function milli(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}
const fmt = (m: number) => String(m / 1000);

/**
 * น้ำหนัก/ปริมาตรรวมของเที่ยวเกินความจุ → คำเตือน (docs/04 D2; spec/03 `OVERWEIGHT` เป็นบล็อก แต่ D-07 = เตือน)
 * เฟส 0 ใช้ **ผลรวมทั้งเที่ยว** (ค่าสูงสุดระหว่างทางตาม PLN-005/087 ต้องรู้ลำดับรับ-ส่งของแต่ละ DO — ผลรวมไม่ต่ำกว่าค่าจริง)
 */
export function checkLoad(input: LoadInput): LoadIssue[] {
  const out: LoadIssue[] = [];
  const pairs = [
    ['OVERWEIGHT', 'rule.overweight', input.weightKg, input.capacityKg],
    ['OVER_VOLUME', 'rule.overVolume', input.cbm, input.capacityCbm],
  ] as const;
  for (const [code, messageKey, load, cap] of pairs) {
    const l = milli(load);
    const c = milli(cap);
    if (l === null || c === null || c <= 0 || l <= c) continue;
    out.push({
      code,
      severity: 'warning',
      messageKey,
      params: { load: fmt(l), capacity: fmt(c), over: fmt(l - c) },
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// ชั่วโมงขับ

/**
 * ชั่วโมงขับต่อวันสูงสุด (spec/06 FLT-240 "ชั่วโมงขับต่อวันเกิน 8 ชม." — ค่าอ้างอิงรอบ 6 ยังไม่ตรวจตัวบท [OPEN] FLT-Q5)
 * เฟส 0 ไม่มีบันทึกเวลาขับจริง (GPS/แอปคนขับ = เฟสถัดไป) → ประเมินจาก**ช่วงวิ่งตามแผน**ของเที่ยวที่ยังไม่จบในวันเดียวกัน
 */
export const DRIVING_HOURS_PER_DAY = 8;

export interface DrivingSpan {
  /** วันเที่ยว (YYYY-MM-DD) */
  tripDate: string;
  start: string | null;
  end: string | null;
}

export interface DrivingHoursIssue {
  code: 'DRIVING_HOURS_EXCEEDED';
  severity: 'warning';
  messageKey: 'rule.drivingHours';
  params: { hours: string; limit: number; date: string };
}

/**
 * รวมชั่วโมงตามแผนของคนขับในวันเที่ยว `date` (เที่ยวนี้ + เที่ยวอื่นที่ยังไม่จบ) — เกิน `limit` → คำเตือน
 * เที่ยวที่ไม่มีช่วงวิ่งไม่นับ (ไม่ทราบระยะเวลา) · ทศนิยม 1 ตำแหน่ง
 */
export function checkDrivingHours(
  date: string,
  spans: readonly DrivingSpan[],
  limit: number = DRIVING_HOURS_PER_DAY,
): DrivingHoursIssue[] {
  let ms = 0;
  for (const s of spans) {
    if (s.tripDate !== date || !s.start || !s.end) continue;
    const d = Date.parse(s.end) - Date.parse(s.start);
    if (Number.isFinite(d) && d > 0) ms += d;
  }
  const hours = Math.round(ms / 360_000) / 10;
  if (hours <= limit) return [];
  return [
    {
      code: 'DRIVING_HOURS_EXCEEDED',
      severity: 'warning',
      messageKey: 'rule.drivingHours',
      params: { hours: hours.toFixed(1), limit, date },
    },
  ];
}

// ------------------------------------------------------------------------------------------------
// การยกเว้น / ยืนยัน

export interface RuleResult {
  code: string;
  severity: 'block' | 'warning' | 'info';
  params: Record<string, unknown>;
}

/** การยกเว้น/ยืนยันที่บันทึกไว้บนเที่ยว (`trip.rule_overrides`) */
export interface RuleOverride {
  key: string;
  code: string;
  severity: 'block' | 'warning';
  /** OVERRIDE = ยกเว้นบล็อก (trips:override) · ACKNOWLEDGE = ยืนยันคำเตือน */
  kind: 'OVERRIDE' | 'ACKNOWLEDGE';
  reason: string;
  actorId: string | null;
  at: string;
  message: string;
  params: Record<string, unknown>;
}

/** ส่วนของ params ที่ระบุ "ตัว" ของกฎ (ไม่ใช่ค่า) — เอกสารประเภทไหน / คนขับคนไหน / จุดไหน */
const IDENTITY_PARAMS = [
  'docType',
  'title',
  'driverRole',
  'sequence',
  'capability',
  'maxVehicleClass',
] as const;

/**
 * กุญแจของกฎหนึ่งข้อบนเที่ยว — การยกเว้นผูกกับ **รถ + คนขับ** ณ ตอนนั้น (PLN-090 "ข้อมูลกฎเปลี่ยนหลัง override → override
 * เดิมหมดผล"): เปลี่ยนรถ/คนขับ → กุญแจใหม่ ต้องยกเว้น/ยืนยันใหม่ · ค่าที่เปลี่ยนในกฎเดิม (เช่น น้ำหนักเพิ่ม) ไม่ทำให้หมดผล
 */
export function ruleKey(
  r: Pick<RuleResult, 'code' | 'params'>,
  ctx: { vehicleId: string | null; driverId: string | null; reliefDriverId?: string | null },
): string {
  const id = IDENTITY_PARAMS.flatMap((p) =>
    r.params[p] === undefined || r.params[p] === null ? [] : [`${p}=${String(r.params[p])}`],
  );
  return [
    r.code,
    `v=${ctx.vehicleId ?? '-'}`,
    `d=${ctx.driverId ?? '-'}`,
    `r=${ctx.reliefDriverId ?? '-'}`,
    ...id,
  ].join('|');
}

export interface PendingRules<T extends RuleResult> {
  /** บล็อกที่ยังไม่ถูกยกเว้น */
  blocks: T[];
  /** คำเตือนที่ยังไม่ถูกยืนยัน (ไม่นับ `info`) */
  warnings: T[];
  /** กฎที่ยกเว้น/ยืนยันแล้ว (ยังตรงกับผลตรวจล่าสุด) */
  covered: T[];
}

/** แยกผลตรวจล่าสุดเป็น ค้างยกเว้น / ค้างยืนยัน / ยกเว้นแล้ว */
export function pendingRules<T extends RuleResult>(
  results: readonly T[],
  overrides: readonly Pick<RuleOverride, 'key'>[],
  ctx: { vehicleId: string | null; driverId: string | null; reliefDriverId?: string | null },
): PendingRules<T> {
  const done = new Set(overrides.map((o) => o.key));
  const out: PendingRules<T> = { blocks: [], warnings: [], covered: [] };
  for (const r of results) {
    if (r.severity === 'info') continue;
    if (done.has(ruleKey(r, ctx))) out.covered.push(r);
    else if (r.severity === 'block') out.blocks.push(r);
    else out.warnings.push(r);
  }
  return out;
}
