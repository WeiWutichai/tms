import type { Schemas } from '@tms/contracts';

export type Board = Schemas['PlanningBoardDto'];
export type BoardTrip = Schemas['BoardTripDto'];
export type BoardVehicle = Schemas['BoardVehicleDto'];
export type PoolOrder = Schemas['BoardPoolOrderDto'];

/**
 * แกนเวลามุมมองวันนี้ตามต้นแบบ (vPlan: 14 ช่อง 06:00–20:00) = ค่าเริ่มต้นของ spec/03 §5
 * ช่วงปรับได้ต่อ tenant = [PROPOSED] และ 06:00–20:00 พอไหม = คำถามเปิด Q-D10 / OPEN-ORD-6 (ยังไม่ตัดสิน)
 */
export const DAY_START = 6;
export const DAY_HOURS = 14;
export const DAY_END = DAY_START + DAY_HOURS;
/** ลากแนวนอน snap 15 นาที (spec/03 PLN-040) */
export const SNAP_H = 0.25;
/** ความยาวเที่ยวเริ่มต้นเมื่อวางงานใหม่ (ต้นแบบ assign(): อย่างน้อย 3 ชม.) — คำนวณจากระยะทาง/stop = ST3-T16 */
export const DEFAULT_DURATION_H = 3;
/** วางในมุมมอง 7 วัน (ไม่มีชั่วโมง): ต่อท้ายเที่ยวสุดท้ายของวันนั้น หรือ 08:00 (ต้นแบบ assign()) */
export const DEFAULT_START_H = 8;
/** ความสูงการ์ดเที่ยว/ระยะ lane ในมุมมองวันนี้ (ต้นแบบ track: top = 8 + lane × 108, h 100) */
export const LANE_H = 108;

const HOUR = 3_600_000;

/** เวลา ISO → ชั่วโมงทศนิยมนับจากเที่ยงคืน (เวลาไทย) ของวัน `day` (YYYY-MM-DD) */
export function hourOf(iso: string, day: string): number {
  return (Date.parse(iso) - Date.parse(`${day}T00:00:00+07:00`)) / HOUR;
}

/** ชั่วโมงทศนิยมของวัน `day` → ISO (+07:00) */
export function isoAt(day: string, hour: number): string {
  const d = new Date(Date.parse(`${day}T00:00:00+07:00`) + Math.round(hour * 60) * 60_000);
  const bkk = new Date(d.getTime() + 7 * HOUR).toISOString();
  return `${bkk.slice(0, 19)}+07:00`;
}

/** วัน (เวลาไทย) ของเวลา ISO */
export const bangkokDay = (iso: string) =>
  new Date(Date.parse(iso) + 7 * HOUR).toISOString().slice(0, 10);

export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export const snap = (h: number) => Math.round(h / SNAP_H) * SNAP_H;

/** "08:00" จากชั่วโมงทศนิยม */
export function hhmm(h: number): string {
  const m = Math.round(h * 60);
  const hh = Math.floor(m / 60);
  return `${String(((hh % 24) + 24) % 24).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
}

/** ช่วงที่ใช้วาดเที่ยวในวัน `day` — ไม่มีช่วงวิ่งตามแผน = 08:00 + 3 ชม. (`estimated`) */
export function span(t: BoardTrip, day: string): { s: number; e: number; estimated: boolean } {
  if (t.plannedStartAt && t.plannedEndAt)
    return { s: hourOf(t.plannedStartAt, day), e: hourOf(t.plannedEndAt, day), estimated: false };
  if (t.plannedStartAt) {
    const s = hourOf(t.plannedStartAt, day);
    return { s, e: s + DEFAULT_DURATION_H, estimated: true };
  }
  const base = dayDiff(day, t.tripDate) * 24;
  return {
    s: base + DEFAULT_START_H,
    e: base + DEFAULT_START_H + DEFAULT_DURATION_H,
    estimated: true,
  };
}

/** เที่ยวนี้อยู่ในวัน `day` ไหม (ช่วงวิ่งทับวัน — เที่ยวข้ามคืนแสดงทั้งสองวัน spec/03 §4 ข้อ 8; ไม่มีช่วง = วันเที่ยว) */
export function onDay(t: BoardTrip, day: string): boolean {
  if (!t.plannedStartAt || !t.plannedEndAt) return t.tripDate === day;
  const { s, e } = span(t, day);
  return s < 24 && e > 0;
}

/**
 * จัด lane ต่อแถวรถ (ต้นแบบ laneOf): เรียงตามเวลาเริ่ม ใส่ lane แรกที่ว่าง — เวลาซ้อน = lane ใหม่ (แถวสูงขึ้น)
 */
export function lanes<T extends { id: string; s: number; e: number }>(
  items: T[],
): { lane: Record<string, number>; count: number } {
  const ends: number[] = [];
  const lane: Record<string, number> = {};
  for (const b of [...items].sort((a, b) => a.s - b.s || a.e - b.e)) {
    let i = ends.findIndex((e) => e <= b.s);
    if (i < 0) {
      i = ends.length;
      ends.push(b.e);
    } else ends[i] = b.e;
    lane[b.id] = i;
  }
  return { lane, count: Math.max(1, ends.length) };
}

/**
 * ตำแหน่งบนแกน 06:00–20:00 (สัดส่วน 0–1) — เที่ยวที่ล้นแกนตัดที่ขอบ; ทั้งเที่ยวอยู่นอกแกน = แถบ 1 ชม. ที่ขอบ
 * (`clipped` บอกว่ามีส่วนนอกแกน — การ์ดยังแสดงเวลาจริง)
 */
export function axisBox(
  s: number,
  e: number,
): { left: number; width: number; clipped: boolean; clipS: boolean; clipE: boolean } {
  let a = Math.max(s, DAY_START);
  let b = Math.min(e, DAY_END);
  if (b <= DAY_START) [a, b] = [DAY_START, DAY_START + 1];
  else if (a >= DAY_END) [a, b] = [DAY_END - 1, DAY_END];
  // ขอบที่ไม่อยู่ในแกนจริง (ล้น หรือทั้งเที่ยวอยู่นอกแกน) = ไม่มีที่จับปรับขนาด
  const clipS = s < DAY_START || s >= DAY_END;
  const clipE = e > DAY_END || e <= DAY_START;
  return {
    left: (a - DAY_START) / DAY_HOURS,
    width: (b - a) / DAY_HOURS,
    clipped: clipS || clipE,
    clipS,
    clipE,
  };
}

/** ชั่วโมงในแกน 06:00–20:00 (ลาก/ปรับขนาดไม่ออกนอกแกนของวันที่แสดง — review ST3-T12) */
export const clampAxis = (h: number) => Math.max(DAY_START, Math.min(DAY_END, h));

/** ตำแหน่ง x บนแถบเวลา (0–1) → ชั่วโมง */
export const hourAt = (fraction: number) => DAY_START + fraction * DAY_HOURS;

/** วางงานใหม่ในมุมมองวันนี้: เริ่มที่ชั่วโมงที่ปล่อย (snap) จำกัดให้อยู่ในแกน 06:00–20:00 (ต้นแบบ assign()) */
export function dropWindow(hour: number, duration = DEFAULT_DURATION_H): { s: number; e: number } {
  const s = Math.max(DAY_START, Math.min(snap(hour), DAY_END - duration));
  return { s, e: s + duration };
}

/** วางงานใหม่ในมุมมอง 7 วัน: ต่อท้ายเที่ยวสุดท้ายของรถในวันนั้น หรือ 08:00 (ต้นแบบ assign()) */
export function weekDropWindow(trips: BoardTrip[], day: string): { s: number; e: number } {
  const ends = trips.filter((t) => onDay(t, day)).map((t) => span(t, day).e);
  return dropWindow(ends.length ? Math.max(...ends) : DEFAULT_START_H);
}

/** ช่วงใหม่ของเที่ยวที่ถูกลาก → body ของ /schedule (วันเที่ยว = วันเริ่ม — spec/03 §4 ข้อ 8; ปรับขนาดส่ง `tripDate` เดิม) */
export function scheduleBody(day: string, s: number, e: number, tripDate?: string) {
  const start = isoAt(day, s);
  return {
    tripDate: tripDate ?? bangkokDay(start),
    plannedStartAt: start,
    plannedEndAt: isoAt(day, e),
  };
}

/** วันที่รถติดกฎห้ามจ่ายงาน → เหตุผล (ว่าง = ไม่ติด) */
export const blocksOn = (v: BoardVehicle, day: string) =>
  v.blocks.find((b) => b.date === day)?.issues ?? [];

/** ลากเที่ยวในมุมมองวันนี้: เวลาเริ่มใหม่ = ตำแหน่งที่ปล่อย − จุดที่จับ (snap) คงความยาวเดิม */
export function movedWindow(
  t: BoardTrip,
  day: string,
  dropHour: number,
  grabOffset: number,
): { s: number; e: number } {
  const { s, e } = span(t, day);
  const dur = e - s;
  // เริ่ม/จบอยู่ในแกนของวันที่แสดง (เที่ยวยาวกว่าแกน = เริ่ม 06:00)
  const ns = Math.max(DAY_START, Math.min(snap(dropHour - grabOffset), DAY_END - dur));
  return { s: ns, e: ns + dur };
}

/**
 * ปรับขนาด (ลากขอบ): snap 15 นาที, ยาวอย่างน้อย 15 นาที, ขอบที่ลากอยู่ในแกน 06:00–20:00 ของวันที่แสดง
 * (ขอบที่ล้นแกนไม่มีที่จับ — กันตัดเที่ยวข้ามคืน/นอกช่วงโดยไม่ตั้งใจ)
 */
export function resizedWindow(
  s: number,
  e: number,
  edge: 's' | 'e',
  hour: number,
): { s: number; e: number } {
  const h = snap(clampAxis(hour));
  return edge === 's' ? { s: Math.min(h, e - SNAP_H), e } : { s, e: Math.max(h, s + SNAP_H) };
}

/** น้ำหนัก (สตริงทศนิยมจาก API) → ตัวเลขสำหรับแถบความจุ (แสดงผลเท่านั้น — ไม่ใช่เงิน) */
export const kg = (v: string | null | undefined) => (v ? Number(v) : 0);
export const fmtNum = (n: number) => Math.round(n).toLocaleString('en-US');

/** ภาระรถ = น้ำหนักสูงสุดของเที่ยวในวันที่แสดง (ต้นแบบ vPlan load; spec/03 PLN-043) */
export function rowLoad(trips: BoardTrip[]): number {
  return trips.reduce((a, t) => Math.max(a, kg(t.weightKg)), 0);
}

/**
 * สีแถบซ้ายของการ์ดเที่ยวตามสถานะ (spec/03 §5 legend — สถานะยึด spec ไม่ใช่ป้ายของต้นแบบ) ·
 * ซ้อนเวลา = แดง (docs/04 D2 "trip ซ้อนเวลาบนรถเดียวแสดงสีแดง ยังบันทึกได้")
 */
export const STATUS_COLOR: Record<string, string> = {
  PLANNING: '#3B424C',
  OFFERED: '#8F5500',
  ASSIGNED: '#8F5500',
  DISPATCHED: '#2257C4',
  IN_PROGRESS: '#1B479F',
  COMPLETED: '#17733F',
  COSTED: '#17733F',
  SETTLED: '#17733F',
};
export const CLASH = '#B3322A';

/** ST3-T14 legend ต้นแบบ: "ติดเงื่อนไข · รออนุมัติ" (ส้ม) · "อนุมัติยกเว้นแล้ว" (เทา) · "ต้องย้ายรถ" (แดง) */
export const RULE_PENDING = '#8F5500';
export const RULE_OVERRIDDEN = '#59606B';

/**
 * สถานะกฎตอนจัดของเที่ยว (ผลตรวจล่าสุดจาก API): `block` = ติดกฎเอกสารที่ยังไม่ยกเว้น (ต้องย้ายรถ) ·
 * `pending` = มีคำเตือนรอยืนยัน · `overridden` = ยกเว้น/ยืนยันแล้วทั้งหมด · null = ไม่ติดอะไร
 */
export function ruleState(t: BoardTrip): 'block' | 'pending' | 'overridden' | null {
  const p = t.pendingRules ?? [];
  if (p.some((r) => r.severity === 'block')) return 'block';
  if (p.length) return 'pending';
  return (t.confirmedRules ?? 0) > 0 ? 'overridden' : null;
}

/** กฎที่แสดงบนการ์ด — ข้อแรกที่ไม่ใช่ซ้อนเวลา (ซ้อนเวลามีป้าย "เวลาชนกัน" ของตัวเอง) */
export const firstRule = (t: BoardTrip) => {
  const p = t.pendingRules ?? [];
  return p.find((r) => !r.code.endsWith('_overlap')) ?? p[0];
};

export function tripColor(t: BoardTrip): string {
  const r = ruleState(t);
  if (r === 'block' || t.overlapsWith.length) return CLASH;
  if (r === 'pending') return RULE_PENDING;
  if (r === 'overridden') return RULE_OVERRIDDEN;
  return STATUS_COLOR[t.status] ?? '#3B424C';
}

/** เที่ยวที่ยังย้าย/ปรับเวลาบนกระดานได้ (ก่อนปล่อยรถ — `isTripEditable` ของ domain) */
export const movable = (t: BoardTrip) => t.status === 'PLANNING' || t.status === 'ASSIGNED';

/**
 * ย้ายเที่ยวลงแถวรถ `vehicleId` ได้ไหมบนกระดาน: ปล่อยรถแล้ว = `locked` · ก่อนปล่อยรถย้ายได้ทั้งเวลาและรถ
 * (ST3-T17: เที่ยว ASSIGNED ไปรถอื่น = `/schedule` จัดรถใหม่ในคำขอเดียว — คนขับประจำของรถใหม่)
 */
export function tripMoveBlock(t: BoardTrip, _vehicleId: string): 'locked' | null {
  return movable(t) ? null : 'locked';
}

/** ชื่อสั้นของลูกค้า (ต้นแบบ custShort — ตัดคำนำหน้านิติบุคคล; รายการคำนำหน้าจาก i18n คั่นด้วย |) */
export function custShort(n: string | null | undefined, prefixes: string): string {
  const name = String(n ?? '');
  for (const p of prefixes.split('|'))
    if (p && name.startsWith(p)) return name.slice(p.length).trim();
  return name;
}

/** ที่ตั้งสำหรับแสดงเส้นทาง: จังหวัด หรือชื่อจุด */
export const placeText = (p: { name: string; province: string | null } | null | undefined) =>
  p ? (p.province ?? p.name) : '—';

/** ตัวกรอง "SO รอจัด" (ต้นแบบ planF: วัน / ประเภทรถ / ลูกค้า) */
export interface PoolFilter {
  d: 'all' | 'today' | 'tomorrow';
  vt: string;
  c: string;
}
export const POOL_FILTER: PoolFilter = { d: 'all', vt: '', c: '' };

/** กรอง + เรียง "SO รอจัด": กำหนดส่ง → น้ำหนักมากก่อน (spec/03 §5) */
export function poolView(pool: PoolOrder[], f: PoolFilter, today: string): PoolOrder[] {
  const tomorrow = addDays(today, 1);
  return pool
    .filter(
      (o) =>
        (f.d === 'all' ||
          (f.d === 'today' ? o.requestedDate <= today : o.requestedDate === tomorrow)) &&
        (!f.vt || o.vehicleTypeId === f.vt) &&
        (!f.c || o.customerId === f.c),
    )
    .sort(
      (a, b) =>
        a.requestedDate.localeCompare(b.requestedDate) ||
        kg(b.weightKg) - kg(a.weightKg) ||
        a.orderNo.localeCompare(b.orderNo),
    );
}

/** ตัวเลือกของตัวกรองจากงานที่มี (ไม่ซ้ำ เรียงชื่อ) */
export function poolOptions(pool: PoolOrder[]) {
  const vt = new Map<string, string>();
  const c = new Map<string, string>();
  for (const o of pool) {
    if (o.vehicleTypeId) vt.set(o.vehicleTypeId, o.vehicleTypeName ?? o.vehicleTypeId);
    if (o.customerId) c.set(o.customerId, o.customerName ?? o.customerId);
  }
  const sorted = (m: Map<string, string>) =>
    [...m].map(([v, l]) => ({ v, l })).sort((a, b) => a.l.localeCompare(b.l, 'th'));
  return { vt: sorted(vt), c: sorted(c) };
}

/** สรุปของกระดาน (ต้นแบบ vPlanStats + แถบล่าง): รถว่างวันนี้ / ใช้งาน / น้ำหนัก / ระยะทาง / ปัญหารอแก้ */
export function boardStats(b: Board, days: string[]) {
  const vis = b.trips.filter((t) => t.vehicleId && days.some((d) => onDay(t, d)));
  const used = new Set(
    b.trips.filter((t) => t.vehicleId && onDay(t, b.today)).map((t) => t.vehicleId),
  );
  const total = b.vehicles.length;
  const free = b.vehicles.filter((v) => !used.has(v.id)).length;
  return {
    pend: b.pool.length,
    total,
    free,
    used: total - free,
    w: vis.reduce((a, t) => a + kg(t.weightKg), 0),
    km: vis.reduce((a, t) => a + kg(t.plannedDistanceKm), 0),
    /** มีเที่ยวที่ไม่ทราบระยะบางช่วง (ST3-T16) → ระยะรวมเป็นค่าต่ำสุด แสดง "≥" */
    kmIncomplete: vis.some((t) => (t.missingLegs ?? 0) > 0),
    iss: vis.filter((t) => t.overlapsWith.length > 0 || t.warningCount > 0).length,
    count: vis.length,
  };
}

export type BoardPrefs = Schemas['BoardPreferencesDto'];
export type BoardView = 'FLEET' | 'VEHICLE' | 'DRIVER' | 'CARRIER';
export type CardField = 'ORDER_NO' | 'CUSTOMER' | 'TIME' | 'ROUTE' | 'WEIGHT';
export const CARD_FIELDS: CardField[] = ['ORDER_NO', 'CUSTOMER', 'TIME', 'ROUTE', 'WEIGHT'];
/** ค่าเริ่มต้นเมื่อยังโหลดค่าของผู้ใช้ไม่เสร็จ/ไม่มี = "รถบริษัท + รถร่วม" + ทุก field (docs/04 D2) */
export const DEFAULT_PREFS: { view: BoardView; cardFields: CardField[] } = {
  view: 'FLEET',
  cardFields: CARD_FIELDS,
};

const th = (a: string, b: string) => a.localeCompare(b, 'th');
const byPlate = (a: BoardVehicle, b: BoardVehicle) =>
  th(a.plate, b.plate) || th(a.plateProvince, b.plateProvince);

/**
 * มุมมองกระดาน (ST3-T13; docs/04 D2 "View") — ข้อมูลชุดเดียวกัน จัดกลุ่ม/เรียงแถวรถใหม่ (ไม่กรองแถวทิ้ง):
 * FLEET = "รถบริษัท + รถร่วม" ตามลำดับ server (PLN-049: รถบริษัท ประเภท/ทะเบียน → รถร่วม) ·
 * VEHICLE = ตามทะเบียน · DRIVER = ตามชื่อคนขับประจำ (ยังไม่กำหนดไว้ท้าย) · CARRIER = รถบริษัท (ownership OWN) ก่อน
 * แล้วรถร่วมตามชื่อรถร่วม (ไม่มีชื่อไว้ท้าย) · [DECISION — ย้อนได้ PO 16 พ.ย.] · หัวกลุ่ม = รอต้นแบบ (spec/12 §3)
 */
export function orderVehicles(vs: BoardVehicle[], view: BoardView): BoardVehicle[] {
  if (view === 'FLEET') return vs;
  const out = [...vs];
  if (view === 'VEHICLE') return out.sort(byPlate);
  if (view === 'DRIVER')
    return out.sort(
      (a, b) =>
        (a.driver ? 0 : 1) - (b.driver ? 0 : 1) ||
        th(a.driver?.name ?? '', b.driver?.name ?? '') ||
        byPlate(a, b),
    );
  // รถบริษัท/รถร่วมตัดสินด้วย ownership (review ST3-T13) — รถร่วมที่ไม่มีชื่อรถร่วมอยู่ท้ายกลุ่มรถร่วม
  const grp = (v: BoardVehicle) => (v.ownership === 'OWN' ? 0 : v.carrierName ? 1 : 2);
  return out.sort(
    (a, b) =>
      grp(a) - grp(b) ||
      (grp(a) === 1 ? th(a.carrierName ?? '', b.carrierName ?? '') : 0) ||
      byPlate(a, b),
  );
}

/** ข้อความบนการ์ดตาม field ที่ผู้ใช้เลือก — ส่วนที่ไม่เลือก/ว่างถูกตัด แล้วต่อด้วย " · " */
export function cardLine(
  fields: readonly string[],
  parts: [CardField, string | null | undefined][],
): string {
  return parts
    .filter(([f, s]) => fields.includes(f) && s)
    .map(([, s]) => s)
    .join(' · ');
}

/** field ที่การ์ดมุมมอง 7 วันแสดงได้ (ต้นแบบ: เลข SO / ลูกค้า / น้ำหนัก) */
const WEEK_FIELDS: CardField[] = ['ORDER_NO', 'CUSTOMER', 'WEIGHT'];
/** field ของการ์ด 7 วันจากที่ผู้ใช้เลือก — ไม่มีข้อใดใช้ได้ (เลือกแค่ช่วงเวลา/เส้นทาง) → เลข SO (การ์ดไม่ว่าง — QA ST3-T13) */
export function weekFields(fields: readonly string[]): CardField[] {
  const f = WEEK_FIELDS.filter((x) => fields.includes(x));
  return f.length ? f : ['ORDER_NO'];
}

// ------------------------------------------------------------------------------------------------
// ST3-T15 Filter รถที่รับได้สองทาง (GET /v1/planning/eligibility)

export type Eligibility = Schemas['PlanningEligibilityDto'];
export type EligItem = Schemas['EligibilityItemDto'];
export type EligLevel = 'OK' | 'WARNING' | 'BLOCK';

/** กฎที่มีผลในวัน `day` (date null = ทุกวันในช่วง) — `info` ไม่นับ (ป้ายแจ้งเฉย ๆ) */
export const issuesOn = (it: Pick<EligItem, 'issues'>, day: string | null, withInfo = false) =>
  it.issues.filter(
    (i) =>
      (withInfo || i.severity !== 'info') && (i.date === null || day === null || i.date === day),
  );

/** ระดับในวัน `day`: บล็อก > คำเตือน > ผ่าน (null = ทั้งช่วง) */
export function levelOn(it: EligItem, day: string | null): EligLevel {
  const xs = issuesOn(it, day);
  if (xs.some((i) => i.severity === 'block')) return 'BLOCK';
  return xs.length ? 'WARNING' : 'OK';
}

/**
 * ขอบเน้น (ต้นแบบ vPlan "ขอบเขียว = วางได้ · ขอบแดง = วางไม่ได้"; spec/03 PLN-041 เตือน = ขอบส้ม วางได้)
 * ผ่าน = เขียว `#17733F` · คำเตือน = ส้ม `#8F5500` (สี "ติดเงื่อนไข" ของ legend) · บล็อก = แดง `#B3322A`
 */
export const LEVEL_COLOR: Record<EligLevel, string> = {
  OK: '#17733F',
  WARNING: '#8F5500',
  BLOCK: '#B3322A',
};
/** รถ/งานที่รับไม่ได้ = จาง (docs/04 D2 "ที่เหลือจาง" — ความทึบเดียวกับรายการที่เลือกไม่ได้ในต้นแบบ) */
export const DIM = 0.6;

/** วันที่ใช้ประเมินการ์ด SO เมื่อเลือกรถ: มุมมองวันเดียว = วันนั้น · 7 วัน = กำหนดส่ง (ถ้าอยู่ในช่วง) มิฉะนั้นวันแรก */
export function orderDay(o: Pick<PoolOrder, 'requestedDate'>, days: string[]): string {
  if (days.length === 1) return days[0]!;
  return days.includes(o.requestedDate) ? o.requestedDate : days[0]!;
}

/**
 * "ย้ายไปรถอื่น" (ต้นแบบ moveBlock; spec/03 PLN-093): รถที่ผ่านกฎทั้งหมดของเที่ยว (ไม่ใช่คันเดิม) เรียง
 * ประเภทเดียวกัน → ความจุพอดี (น้อยสุดที่รับน้ำหนักได้) → ทะเบียน · null = ไม่มีรถที่รับได้
 */
export function moveTarget(
  t: BoardTrip,
  items: EligItem[],
  vehicles: BoardVehicle[],
): BoardVehicle | null {
  const ok = new Set(items.filter((i) => levelOn(i, null) === 'OK').map((i) => i.vehicleId));
  const cur = vehicles.find((v) => v.id === t.vehicleId);
  const w = kg(t.weightKg);
  const cap = (v: BoardVehicle) => (v.capacityKg === null ? Infinity : kg(v.capacityKg));
  const c = vehicles
    .filter((v) => v.id !== t.vehicleId && ok.has(v.id) && cap(v) >= w)
    .sort(
      (a, b) =>
        (a.vehicleTypeId === cur?.vehicleTypeId ? 0 : 1) -
          (b.vehicleTypeId === cur?.vehicleTypeId ? 0 : 1) ||
        cap(a) - cap(b) ||
        a.plate.localeCompare(b.plate, 'th'),
    );
  return c[0] ?? null;
}

/**
 * เหตุหลักที่ "ย้ายไปรถอื่น" หาไม่ได้ (QA L2): นับข้อแรกของแต่ละคัน (ไม่นับคันเดิม) — รถผ่านกฎแต่ความจุไม่พอ = น้ำหนัก
 * คืน null = เหตุคือน้ำหนัก (ใช้ข้อความต้นแบบ) · มิฉะนั้นข้อความกฎที่พบมากสุด
 */
export function moveNoneReason(
  t: BoardTrip,
  items: EligItem[],
  vehicles: BoardVehicle[],
): string | null {
  const w = kg(t.weightKg);
  const count = new Map<string, { n: number; message: string }>();
  for (const it of items) {
    if (it.vehicleId === t.vehicleId) continue;
    const v = vehicles.find((x) => x.id === it.vehicleId);
    if (!v) continue;
    const first = issuesOn(it, null)[0];
    const fits = v.capacityKg === null || kg(v.capacityKg) >= w;
    const code = first ? first.code : fits ? null : 'OVERWEIGHT';
    if (!code) continue;
    const c = count.get(code) ?? { n: 0, message: first?.message ?? '' };
    count.set(code, { ...c, n: c.n + 1 });
  }
  const top = [...count.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  return !top || top[0] === 'OVERWEIGHT' ? null : top[1].message;
}
