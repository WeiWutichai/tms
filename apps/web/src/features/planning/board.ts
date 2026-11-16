import type { Schemas } from '@tms/contracts';

export type Board = Schemas['PlanningBoardDto'];
export type BoardTrip = Schemas['BoardTripDto'];
export type BoardVehicle = Schemas['BoardVehicleDto'];
export type PoolOrder = Schemas['BoardPoolOrderDto'];

/** แกนเวลามุมมองวันนี้ตามต้นแบบ (vPlan: 14 ช่อง 06:00–20:00) — spec/03 §5 ช่วงปรับได้ = [PROPOSED] */
export const DAY_START = 6;
export const DAY_HOURS = 14;
/** ลากแนวนอน snap 15 นาที (spec/03 PLN-040) */
export const SNAP_H = 0.25;
/** ความยาวเที่ยวเริ่มต้นเมื่อวางงานใหม่ (ต้นแบบ assign(): อย่างน้อย 3 ชม.) — คำนวณจากระยะทาง = ST3-T16 */
export const DEFAULT_DURATION_H = 3;
/** วางในมุมมอง 7 วัน (ไม่มีชั่วโมง): ต่อท้ายเที่ยวสุดท้ายของวันนั้น หรือ 08:00 (ต้นแบบ assign()) */
export const DEFAULT_START_H = 8;

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
  const base = (Date.parse(`${t.tripDate}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / HOUR;
  return { s: base + DEFAULT_START_H, e: base + DEFAULT_START_H + DEFAULT_DURATION_H, estimated: true };
}

/** เที่ยวนี้อยู่ในวัน `day` ไหม (ช่วงวิ่งทับวัน — เที่ยวข้ามคืนแสดงทั้งสองวัน; ไม่มีช่วง = วันเที่ยว) */
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

/** วางงานใหม่ในมุมมองวันนี้: เริ่มที่ชั่วโมงที่ปล่อย (snap) จำกัดให้อยู่ในแกน 06:00–20:00 (ต้นแบบ assign()) */
export function dropWindow(hour: number, duration = DEFAULT_DURATION_H): { s: number; e: number } {
  const s = Math.max(DAY_START, Math.min(snap(hour), DAY_START + DAY_HOURS - duration));
  return { s, e: s + duration };
}

/** วางงานใหม่ในมุมมอง 7 วัน: ต่อท้ายเที่ยวสุดท้ายของรถในวันนั้น หรือ 08:00 */
export function weekDropWindow(trips: BoardTrip[], day: string): { s: number; e: number } {
  const ends = trips.filter((t) => onDay(t, day)).map((t) => span(t, day).e);
  return dropWindow(ends.length ? Math.max(...ends) : DEFAULT_START_H);
}

/** น้ำหนัก (สตริงทศนิยมจาก API) → ตัวเลขสำหรับแถบความจุ (แสดงผลเท่านั้น — ไม่ใช่เงิน) */
export const kg = (v: string | null | undefined) => (v ? Number(v) : 0);
export const fmtKg = (n: number) => Math.round(n).toLocaleString('en-US');

/** สีแถบซ้ายของการ์ดเที่ยวตามสถานะ (spec/03 §5 legend) — ซ้อนเวลา = แดง (docs/04 D2) */
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

export function tripColor(t: BoardTrip): string {
  return t.overlapsWith.length ? CLASH : (STATUS_COLOR[t.status] ?? '#3B424C');
}

/** เที่ยวที่ยังย้าย/ปรับเวลาบนกระดานได้ (ก่อนปล่อยรถ — TripService.isTripEditable) */
export const movable = (t: BoardTrip) => t.status === 'PLANNING' || t.status === 'ASSIGNED';

/** ชื่อสั้นของลูกค้า (ต้นแบบ custShort — ตัดคำนำหน้านิติบุคคล) */
export function custShort(n: string | null | undefined): string {
  return String(n ?? '').replace(/^(\u0e1a\u0e08\u0e01|\u0e1a\u0e21\u0e08|\u0e2b\u0e08\u0e01)\.\s*/, '');
}

/** ที่ตั้งสำหรับแสดงเส้นทาง: จังหวัด หรือชื่อจุด */
export const placeText = (p: { name: string; province: string | null } | null | undefined) =>
  p ? (p.province ?? p.name) : '—';
