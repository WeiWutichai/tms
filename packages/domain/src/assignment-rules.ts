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
  /** วันเที่ยว (YYYY-MM-DD) — ไม่ใช้ตัดวัน (ใช้ช่วงวิ่งจริงตามแผน) */
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

/** วันไทย (YYYY-MM-DD) ของเวลา ISO */
export const bangkokDay = (iso: string): string =>
  new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);

/** วันไทยที่ช่วงวิ่งคาบเกี่ยว (เที่ยวข้ามเที่ยงคืน = 2 วัน) — ไม่มีช่วงวิ่ง = วันเที่ยว */
export function drivingDays(span: DrivingSpan): string[] {
  if (!span.start || !span.end) return [span.tripDate];
  const out: string[] = [];
  const endMs = Date.parse(span.end) - 1;
  let d = bangkokDay(span.start);
  const last = bangkokDay(new Date(endMs).toISOString());
  while (d <= last && out.length < 7) {
    out.push(d);
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return out;
}

/**
 * รวมชั่วโมงตามแผนของคนขับใน**วันไทย** `date` (เที่ยวนี้ + เที่ยวอื่นที่ยังไม่จบ) — เกิน `limit` → คำเตือน
 * ตัดช่วงวิ่งตามขอบวัน (เที่ยวข้ามเที่ยงคืนนับแต่ละวันเฉพาะส่วนของวันนั้น; เที่ยวเมื่อวานที่ล้นมาวันนี้นับด้วย — review L6)
 * เที่ยวที่ไม่มีช่วงวิ่งไม่นับ · ทศนิยม 1 ตำแหน่ง
 */
export function checkDrivingHours(
  date: string,
  spans: readonly DrivingSpan[],
  limit: number = DRIVING_HOURS_PER_DAY,
): DrivingHoursIssue[] {
  const dayStart = Date.parse(`${date}T00:00:00+07:00`);
  const dayEnd = dayStart + 86_400_000;
  let ms = 0;
  for (const s of spans) {
    if (!s.start || !s.end) continue;
    const a = Math.max(Date.parse(s.start), dayStart);
    const b = Math.min(Date.parse(s.end), dayEnd);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) ms += b - a;
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

/** การยกเว้น/ยืนยันที่บันทึกไว้บนเที่ยว (`trip.rule_overrides` — append-only; หมดผลด้วย `supersededAt`) */
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
  /** ค่าของกฎ ณ ตอนยกเว้น (ใช้เทียบ "แย่ลง") */
  params: Record<string, unknown>;
  /** หมดผลเมื่อ — ข้อเท็จจริงเปลี่ยน (`CHANGED`: รถ/คนขับ/ชุดเที่ยวที่ซ้อนเปลี่ยน หรือกฎหายไป) / แย่ลง (`WORSENED`) */
  supersededAt?: string | null;
  supersededReason?: 'CHANGED' | 'WORSENED' | null;
}

export interface RuleCtx {
  vehicleId: string | null;
  driverId: string | null;
  reliefDriverId?: string | null;
}

/** ส่วนของ params ที่ระบุ "ตัว" ของกฎ (ไม่ใช่ค่า) */
const IDENTITY_PARAMS = [
  'docType',
  'title',
  'driverRole',
  'sequence',
  'capability',
  'maxVehicleClass',
  'requestedClass',
  'status',
  'date',
  'trips',
  // ST3-T19 (review M1): วันลาที่ทับเที่ยว — เพิ่ม/เปลี่ยนวันลา = กุญแจใหม่ → การยืนยันเดิมหมดผล
  'dates',
] as const;

/** กฎที่ "แย่ลง" แล้วการยืนยันเดิมหมดผล: รหัส → param ตัวเลขที่เทียบ (มากขึ้น = แย่ลง) */
const WORSEN_PARAM: Record<string, string> = {
  OVERWEIGHT: 'load',
  OVER_VOLUME: 'load',
  DRIVING_HOURS_EXCEEDED: 'hours',
};

/** กฎที่ผูกกับคนขับ (ไม่ใช่รถ) */
export const isDriverRule = (code: string): boolean =>
  code.startsWith('DRIVER_LICENCE_') ||
  code === 'DRIVING_HOURS_EXCEEDED' ||
  code.startsWith('driver_') ||
  code.startsWith('relief_driver_');

/**
 * กุญแจของกฎหนึ่งข้อบนเที่ยว (ST3-T14 — review M3/QA M1, PO อนุมัติ 17 พ.ย. 2569):
 * - `DOC_*` และกฎรถ (น้ำหนัก/ความเข้ากันได้/สถานะรถ/ซ้อนเวลารถ) ผูกกับ **รถ** เท่านั้น
 * - `DRIVER_*`/ชั่วโมงขับ/ซ้อนเวลาคนขับ/ลา ผูกกับ **คนขับคนนั้น** (หลักหรือสำรองตาม `driverRole`) เท่านั้น
 * - ซ้อนเวลา: รวมชุดเที่ยวที่ซ้อน (`trips`) — ชุดเปลี่ยน = กุญแจใหม่ · ชั่วโมงขับ: รวมวัน (`date`)
 */
export function ruleKey(r: Pick<RuleResult, 'code' | 'params'>, ctx: RuleCtx): string {
  const role = r.params.driverRole === 'relief' ? 'relief' : 'driver';
  const subject = r.code.startsWith('stop_')
    ? 'trip'
    : isDriverRule(r.code)
      ? `d=${(role === 'relief' ? ctx.reliefDriverId : ctx.driverId) ?? '-'}`
      : `v=${ctx.vehicleId ?? '-'}`;
  const id = IDENTITY_PARAMS.flatMap((p) => {
    const v = r.params[p];
    if (v === undefined || v === null) return [];
    return [`${p}=${Array.isArray(v) ? [...v].map(String).sort().join(',') : String(v)}`];
  });
  return [r.code, subject, ...id].join('|');
}

const num = (v: unknown) => (v === undefined || v === null ? NaN : Number(v));
const worsened = (r: RuleResult, o: Pick<RuleOverride, 'params'>) => {
  const p = WORSEN_PARAM[r.code];
  return p !== undefined && num(r.params[p]) > num(o.params?.[p]);
};

/**
 * ตรวจการยกเว้นที่ยังมีผลกับผลตรวจล่าสุด → ทำเครื่องหมายหมดผล (`supersededAt`) ข้อที่กฎหายไป/เปลี่ยนตัว (CHANGED)
 * หรือค่าแย่ลง (WORSENED) — หมดผลแล้วไม่กลับมาอีก (สลับรถไปแล้วกลับมา = ต้องยกเว้นใหม่)
 */
export function reconcileOverrides(
  results: readonly RuleResult[],
  overrides: readonly RuleOverride[],
  ctx: RuleCtx,
  now: string,
): { overrides: RuleOverride[]; changed: boolean } {
  const byKey = new Map(results.map((r) => [ruleKey(r, ctx), r]));
  let changed = false;
  const out = overrides.map((o) => {
    if (o.supersededAt) return o;
    const r = byKey.get(o.key);
    const why = !r ? 'CHANGED' : worsened(r, o) ? 'WORSENED' : null;
    if (!why) return o;
    changed = true;
    return { ...o, supersededAt: now, supersededReason: why } as RuleOverride;
  });
  return { overrides: out, changed };
}

export interface PendingRules<T extends RuleResult> {
  /** บล็อกที่ยังไม่ถูกยกเว้น */
  blocks: T[];
  /** คำเตือนที่ยังไม่ถูกยืนยัน (ไม่นับ `info`) */
  warnings: T[];
  /** กฎที่ยกเว้น/ยืนยันแล้ว (ยังมีผล) */
  covered: T[];
}

/** แยกผลตรวจล่าสุดเป็น ค้างยกเว้น / ค้างยืนยัน / ยกเว้นแล้ว — นับเฉพาะการยกเว้นที่ยังไม่หมดผลและค่าไม่แย่ลง */
export function pendingRules<T extends RuleResult>(
  results: readonly T[],
  overrides: readonly Pick<RuleOverride, 'key' | 'params' | 'supersededAt'>[],
  ctx: RuleCtx,
): PendingRules<T> {
  const active = new Map(overrides.filter((o) => !o.supersededAt).map((o) => [o.key, o]));
  const out: PendingRules<T> = { blocks: [], warnings: [], covered: [] };
  for (const r of results) {
    if (r.severity === 'info') continue;
    const o = active.get(ruleKey(r, ctx));
    if (o && !worsened(r, o)) out.covered.push(r);
    else if (r.severity === 'block') out.blocks.push(r);
    else out.warnings.push(r);
  }
  return out;
}
