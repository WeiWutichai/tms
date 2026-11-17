import type { TransitionTable } from './state-machine';

/**
 * Trip (ST3-T11) — state machine (docs/01 §4.2 + plan/00a §2.4.2 "DISPATCHED → CANCELLED" + D-24 "คนขับรับงาน" เป็นธง ไม่ใช่สถานะ)
 * และการจัดจุดแวะจาก DO (docs/04 D1 TripStop) — ฟังก์ชันล้วน ใช้ได้ทั้ง API และเว็บ
 */

// ---------- สถานะ + transition ----------

export const TRIP_STATUSES = [
  'PLANNING',
  'OFFERED',
  'ASSIGNED',
  'DISPATCHED',
  'IN_PROGRESS',
  'COMPLETED',
  'COSTED',
  'SETTLED',
  'CANCELLED',
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const TRIP_EVENTS = [
  'offer',
  'accept',
  'reject',
  'expire',
  'withdraw',
  'cancel_hire',
  'assign',
  'reassign',
  'dispatch',
  'start',
  'complete',
  'cost',
  'settle',
  'cancel',
] as const;
export type TripEvent = (typeof TRIP_EVENTS)[number];

/**
 * ตาราง transition ตาม docs/01 §4.2 (mermaid) + plan/00a §2.4.2:
 * - `offer` = เสนองานรถร่วม (ลิงก์ = ST3-T23) · `accept` = รถร่วมรับ + ทะเบียน/คนขับ (ผู้จัดรถบันทึกแทนได้ผ่าน /assign)
 * - `reject` / `expire` = ปฏิเสธ/ลิงก์หมดอายุ → กลับ PLANNING (ST3-T23/T24 — SO ON_HOLD CARRIER_REJECTED)
 * - `withdraw` = ผู้จัดรถถอนข้อเสนอที่ครบเวลาตอบเพื่อ "ส่งรายถัดไป" → PLANNING แล้วเสนอรายใหม่ทันที (ST3-T24 review L3 —
 *   [DECISION spec/12 §3] ขยายจาก docs/01 §4.2 ซึ่งไม่มีเส้นนี้; ไม่ตั้งใบค้าง) · ST3-T25 เปลี่ยนผู้รับเหมาระหว่างรอตอบใช้เส้นเดียวกัน
 * - `cancel_hire` = เปลี่ยนผู้รับเหมาหลังรถร่วมรับงาน (ST3-T25; docs/04 D3 "ยกเลิกการจ้างเดิมแล้วจ้างใหม่") ASSIGNED → PLANNING
 *   แล้วเสนอรายใหม่ในคำขอเดียว — [DECISION spec/12 §3] ขยายจาก docs/01 §4.2 · หลังปล่อยรถ (DISPATCHED) ไม่มีเส้นนี้ (§4.2 ท้าย)
 * - `assign` = รถบริษัท/รถร่วมกำหนดรถ+คนขับ (snapshot) · `reassign` = เปลี่ยนรถ/คนขับก่อนปล่อยรถ (snapshot ใหม่)
 * - `dispatch` = ปล่อยรถ → ทุก DO ในเที่ยว DISPATCHED · หลังจากนี้ห้ามแก้ snapshot (§4.2 ท้าย)
 * - `start` = stop แรก ARRIVED/DEPART (ST4) · `complete` = ทุก stop COMPLETED/FAILED/SKIPPED
 * - `cost` / `settle` = ST6
 * - `cancel` ได้จาก PLANNING / OFFERED / ASSIGNED / DISPATCHED (00a รับ DISPATCHED → CANCELLED จาก spec PLN-012;
 *   OFFERED → CANCELLED เพิ่ม — [OPEN] spec/12 §3) · เหตุผล ≥ 10 ตัวอักษร
 */
export const TRIP_TRANSITIONS: TransitionTable<TripStatus, TripEvent> = {
  PLANNING: { offer: 'OFFERED', assign: 'ASSIGNED', cancel: 'CANCELLED' },
  OFFERED: {
    accept: 'ASSIGNED',
    reject: 'PLANNING',
    expire: 'PLANNING',
    withdraw: 'PLANNING',
    cancel: 'CANCELLED',
  },
  ASSIGNED: {
    reassign: 'ASSIGNED',
    cancel_hire: 'PLANNING',
    dispatch: 'DISPATCHED',
    cancel: 'CANCELLED',
  },
  DISPATCHED: { start: 'IN_PROGRESS', cancel: 'CANCELLED' },
  IN_PROGRESS: { complete: 'COMPLETED' },
  COMPLETED: { cost: 'COSTED' },
  COSTED: { settle: 'SETTLED' },
  // SETTLED / CANCELLED = สถานะสิ้นสุด (COSTED = สิ้นสุดของรถบริษัท)
};

/** ยังเพิ่ม/ถอด DO ได้ (ก่อนปล่อยรถ และไม่อยู่ระหว่างรอรถร่วมตอบ) */
export function isTripEditable(status: TripStatus): boolean {
  return status === 'PLANNING' || status === 'ASSIGNED';
}

/** เที่ยวที่ยังไม่จบ (นับซ้อนเวลารถ/คนขับ) */
export const TRIP_OPEN_STATUSES = [
  'PLANNING',
  'OFFERED',
  'ASSIGNED',
  'DISPATCHED',
  'IN_PROGRESS',
] as const satisfies readonly TripStatus[];

/**
 * ส่งแผนแล้ว (ST3-T18 "Send all" — docs/04 D2): ปล่อยรถแล้วหรือเลยไปแล้ว — นับว่า "ส่งงาน" ของวันนั้นแล้ว
 * (COSTED/SETTLED = ปิดบัญชีของเที่ยวที่วิ่งจบ)
 */
export const TRIP_SENT_STATUSES = [
  'DISPATCHED',
  'IN_PROGRESS',
  'COMPLETED',
  'COSTED',
  'SETTLED',
] as const satisfies readonly TripStatus[];

/** ยังส่งแผนได้ (Send all ทำกับเที่ยวสถานะเหล่านี้ — OFFERED ไม่ผ่านพร้อมเหตุผล "รอรถร่วมตอบ") */
export const TRIP_UNSENT_STATUSES = [
  'PLANNING',
  'OFFERED',
  'ASSIGNED',
] as const satisfies readonly TripStatus[];

/**
 * สถานะการส่งของวัน (ST3-T18 "ปฏิทินขึ้นเขียวเมื่อส่งครบ"): นับเฉพาะเที่ยวที่ไม่ยกเลิกซึ่งวันเที่ยว = วันนั้น ·
 * ส่งครบ = มีเที่ยว ≥ 1 และทุกเที่ยวส่งแล้ว (วันที่ไม่มีเที่ยว = ไม่เขียว) · SO ที่ยังไม่ได้จัดไม่นับ (อยู่ใน "SO รอจัด")
 */
export function daySendState(statuses: readonly TripStatus[]): {
  trips: number;
  sent: number;
  complete: boolean;
} {
  const live = statuses.filter((s) => s !== 'CANCELLED');
  const sent = live.filter((s) => (TRIP_SENT_STATUSES as readonly string[]).includes(s)).length;
  return { trips: live.length, sent, complete: live.length > 0 && sent === live.length };
}

export const TRIP_STATUS_LABEL_TH: Record<TripStatus, string> = {
  PLANNING: 'กำลังวางแผน',
  OFFERED: 'รอรถร่วมตอบ',
  ASSIGNED: 'จัดรถแล้ว',
  DISPATCHED: 'ปล่อยรถแล้ว',
  IN_PROGRESS: 'กำลังวิ่ง',
  COMPLETED: 'จบเที่ยว',
  COSTED: 'ปิดต้นทุนแล้ว',
  SETTLED: 'จ่ายรถร่วมแล้ว',
  CANCELLED: 'ยกเลิก',
};

/** สถานะจุดแวะที่จบแล้ว (complete เที่ยวได้เมื่อทุกจุดเป็นสถานะเหล่านี้ — docs/01 §4.2) */
export const STOP_TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'SKIPPED'] as const;

// ---------- จัดจุดแวะจาก DO ----------

export interface StopWindow {
  /** ISO 8601 หรือ null */
  start: string | null;
  end: string | null;
}

export interface TripDoInput {
  id: string;
  originSiteId: string;
  destSiteId: string;
  pickupWindow: StopWindow;
  dropWindow: StopWindow;
}

export interface ExistingStop {
  id: string;
  type: 'PICKUP' | 'DELIVERY' | 'RETURN';
  siteId: string;
  sequence: number;
}

export interface PlannedStop {
  /** id จุดเดิม (null = จุดใหม่) */
  id: string | null;
  sequence: number;
  type: 'PICKUP' | 'DELIVERY' | 'RETURN';
  siteId: string;
  window: StopWindow;
  /** DO ที่รับที่จุดนี้ (PICKUP) / ส่งที่จุดนี้ (DELIVERY) */
  doIds: string[];
}

export interface StopPlan {
  stops: PlannedStop[];
  /** id จุดเดิมที่ไม่มี DO ใช้แล้ว (ตั้ง removed_at) */
  removed: string[];
  /** DO → ดัชนีใน stops ของจุดรับ/จุดส่ง */
  pickupOf: Record<string, number>;
  dropOf: Record<string, number>;
  /** จุดที่ช่วงเวลาของ DO ไม่มีส่วนทับกัน (ส่วนที่ทุกใบรับได้ว่าง) — คำเตือน */
  windowConflicts: number[];
}

const iso = (v: string | null) => (v === null ? null : new Date(v).getTime());

/** ส่วนที่ทุกช่วงรับได้ (เริ่มช้าสุด – จบเร็วสุด) · ว่าง → null + conflict */
export function intersectWindows(ws: StopWindow[]): { window: StopWindow; conflict: boolean } {
  let start: string | null = null;
  let end: string | null = null;
  for (const w of ws) {
    if (w.start !== null && (start === null || iso(w.start)! > iso(start)!)) start = w.start;
    if (w.end !== null && (end === null || iso(w.end)! < iso(end)!)) end = w.end;
  }
  if (start !== null && end !== null && iso(end)! < iso(start)!)
    return { window: { start, end: start }, conflict: true };
  return { window: { start, end }, conflict: false };
}

/**
 * จัดจุดแวะของเที่ยวจาก DO ที่อยู่ในเที่ยว (เรียกทุกครั้งที่เพิ่ม/ถอด DO ก่อนปล่อยรถ):
 * - คงจุดเดิมที่ยังมี DO ใช้ไว้ตามลำดับเดิม (ผู้จัดรถอาจเรียงเอง — ST3-T16) · จุดที่ไม่มี DO ใช้ → `removed`
 * - จุดรับของ DO = จุด PICKUP เดิมที่สถานที่เดียวกัน (จุดแรก) ไม่มี → จุดใหม่ต่อท้าย "ช่วงรับของต้นเที่ยว"
 *   (ก่อนจุดส่งแรกเสมอ — รับก่อนส่ง)
 * - จุดส่งของ DO = จุด DELIVERY เดิมที่สถานที่เดียวกันและอยู่ **หลัง** จุดรับของ DO นั้น ไม่มี → จุดใหม่ต่อท้ายเที่ยว
 *   (DO ใหม่เรียงตามต้นช่วงเวลาส่งที่ลูกค้าขอ — ไม่มีช่วงไว้ท้าย — แล้วตามลำดับที่ส่งเข้ามา; จุดเดิมคงตำแหน่ง —
 *   ลำดับที่ผู้จัดรถเรียงเอง (ST3-T16) มาก่อนเสมอ)
 * - หลาย DO ที่จุดเดียวกัน (เช่น หลาย SO ของลูกค้าเดียว) ใช้จุดเดียว — ช่วงเวลา = ส่วนที่ทุกใบรับได้
 * - ลำดับ 1..n ต่อเนื่อง
 */
export function planStops(
  existing: readonly ExistingStop[],
  dos: readonly TripDoInput[],
): StopPlan {
  type Slot = {
    id: string | null;
    type: PlannedStop['type'];
    siteId: string;
    pickups: TripDoInput[];
    drops: TripDoInput[];
  };
  const slots: Slot[] = [...existing]
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => ({ id: s.id, type: s.type, siteId: s.siteId, pickups: [], drops: [] }));
  const pickupSlot = new Map<string, Slot>();
  const dropSlot = new Map<string, Slot>();
  const byDropWindow = [...dos].sort(
    (a, b) =>
      (iso(a.dropWindow.start) ?? Number.POSITIVE_INFINITY) -
      (iso(b.dropWindow.start) ?? Number.POSITIVE_INFINITY),
  );
  for (const d of byDropWindow) {
    let p = slots.find((s) => s.type === 'PICKUP' && s.siteId === d.originSiteId);
    if (!p) {
      p = { id: null, type: 'PICKUP', siteId: d.originSiteId, pickups: [], drops: [] };
      let at = 0;
      while (at < slots.length && slots[at]!.type === 'PICKUP') at++;
      slots.splice(at, 0, p);
    }
    p.pickups.push(d);
    pickupSlot.set(d.id, p);
    const pIdx = slots.indexOf(p);
    let q = slots.find((s, i) => i > pIdx && s.type === 'DELIVERY' && s.siteId === d.destSiteId);
    if (!q) {
      q = { id: null, type: 'DELIVERY', siteId: d.destSiteId, pickups: [], drops: [] };
      slots.push(q);
    }
    q.drops.push(d);
    dropSlot.set(d.id, q);
  }
  const used = slots.filter((s) => s.pickups.length || s.drops.length);
  const removed = slots
    .filter((s) => !s.pickups.length && !s.drops.length && s.id)
    .map((s) => s.id!);
  const windowConflicts: number[] = [];
  const stops: PlannedStop[] = used.map((s, i) => {
    const { window, conflict } = intersectWindows(
      s.type === 'PICKUP' ? s.pickups.map((d) => d.pickupWindow) : s.drops.map((d) => d.dropWindow),
    );
    if (conflict) windowConflicts.push(i);
    return {
      id: s.id,
      sequence: i + 1,
      type: s.type,
      siteId: s.siteId,
      window,
      doIds: (s.type === 'PICKUP' ? s.pickups : s.drops).map((d) => d.id),
    };
  });
  const pickupOf: Record<string, number> = {};
  const dropOf: Record<string, number> = {};
  for (const d of dos) {
    pickupOf[d.id] = used.indexOf(pickupSlot.get(d.id)!);
    dropOf[d.id] = used.indexOf(dropSlot.get(d.id)!);
  }
  return { stops, removed, pickupOf, dropOf, windowConflicts };
}

/**
 * ลำดับจุดที่เวลาตามแผนถอยหลัง (จุดถัดไปมีเวลาก่อนจุดก่อนหน้า) → ลำดับของจุดที่ผิด (คำเตือน `stop_sequence_window_order`)
 * จุดที่ไม่มีเวลาตามแผนข้าม
 */
export function backwardStops(
  stops: readonly { sequence: number; plannedArrival: string | null }[],
): number[] {
  const out: number[] = [];
  let last: number | null = null;
  for (const s of [...stops].sort((a, b) => a.sequence - b.sequence)) {
    const t = iso(s.plannedArrival);
    if (t === null) continue;
    if (last !== null && t < last) out.push(s.sequence);
    else last = t;
  }
  return out;
}

/** เที่ยวสำหรับตรวจซ้อนเวลาบนรถ (กระดานวางแผน ST3-T12) — วันที่ YYYY-MM-DD, เวลา ISO */
export interface OverlapTrip {
  id: string;
  vehicleId: string | null;
  status: TripStatus;
  tripDate: string;
  start: string | null;
  end: string | null;
}

/**
 * เที่ยวที่ซ้อนเวลากันบนรถคันเดียวกัน → map id → id ของเที่ยวที่ซ้อน (กติกาเดียวกับคำเตือน `vehicle_overlap` ของ ST3-T11):
 * นับเฉพาะเที่ยวที่ยังไม่จบ (`TRIP_OPEN_STATUSES`) · มีช่วงวิ่งทั้งสองฝั่ง → ช่วงทับกัน (ขอบชนกันพอดีไม่นับ) ·
 * ฝั่งใดไม่มีช่วงวิ่ง → วันเดียวกัน = ซ้อน · เตือน ไม่บล็อก (docs/04 D2)
 */
export function vehicleOverlaps(trips: OverlapTrip[]): Map<string, string[]> {
  const open = trips.filter(
    (t) => t.vehicleId && (TRIP_OPEN_STATUSES as readonly string[]).includes(t.status),
  );
  const out = new Map<string, string[]>();
  const add = (a: string, b: string) => out.set(a, [...(out.get(a) ?? []), b]);
  for (let i = 0; i < open.length; i++)
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i]!;
      const b = open[j]!;
      if (a.vehicleId !== b.vehicleId) continue;
      const hit =
        a.start && a.end && b.start && b.end
          ? Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)
          : a.tripDate === b.tripDate;
      if (hit) {
        add(a.id, b.id);
        add(b.id, a.id);
      }
    }
  return out;
}

// ---------- Multi-drop: เรียงจุดเอง + ระยะ/เวลารวม (ST3-T16; docs/04 D2, spec/03 PLN-003/004) ----------

/** DO ในเที่ยว → จุดรับ/จุดส่ง (id ของ trip_stop) */
export interface StopOrderDo {
  id: string;
  pickupStopId: string | null;
  dropStopId: string | null;
}

export interface StopOrderViolation {
  deliveryOrderId: string;
  pickupStopId: string;
  dropStopId: string;
  /** ลำดับใหม่ (1..n) ของจุดรับ/จุดส่ง */
  pickupSequence: number;
  dropSequence: number;
}

/**
 * ตรวจลำดับจุดที่ผู้จัดรถเรียงเอง: จุดรับของ DO ต้องมาก่อนจุดส่งของ DO เดียวกัน (spec/03 PLN-003 — บล็อก)
 * `order` = id ของจุดตามลำดับใหม่ · คืนรายการ DO ที่ "ส่งก่อนรับ" (ว่าง = ผ่าน)
 */
export function stopOrderViolations(
  order: readonly string[],
  dos: readonly StopOrderDo[],
): StopOrderViolation[] {
  const pos = new Map(order.map((id, i) => [id, i + 1] as const));
  const out: StopOrderViolation[] = [];
  for (const d of dos) {
    if (!d.pickupStopId || !d.dropStopId) continue;
    const p = pos.get(d.pickupStopId);
    const q = pos.get(d.dropStopId);
    if (p === undefined || q === undefined) continue;
    if (q <= p)
      out.push({
        deliveryOrderId: d.id,
        pickupStopId: d.pickupStopId,
        dropStopId: d.dropStopId,
        pickupSequence: p,
        dropSequence: q,
      });
  }
  return out;
}

/**
 * ค่าประมาณเมื่อไม่มีเส้นทางใน route master (ยังไม่มีผู้ให้บริการแผนที่ — ADR ST0-T01 / Q-D3):
 * ระยะเส้นตรงระหว่างพิกัด × ตัวคูณถนน · เวลา = ระยะ ÷ ความเร็วเฉลี่ย (spec/03 PLN-004 ค่าตั้งต้น 50 กม./ชม. [PROPOSED])
 * [DECISION — ย้อนได้] spec/12 §3 "Multi-drop ระยะ/เวลารวม (ST3-T16)"
 */
export const TRIP_ROAD_FACTOR = 1.3;
export const TRIP_AVG_SPEED_KMH = 50;

/** ที่มาของระยะ/เวลาช่วงวิ่ง: เส้นทางใน route master · ค่าประมาณจากพิกัด · จุดเดียวกัน (0) */
export type LegSource = 'ROUTE' | 'ESTIMATE' | 'SAME_SITE';

export interface LegPoint {
  lat: number;
  lng: number;
}

export interface LegInput {
  fromSiteId: string;
  toSiteId: string;
  /** เส้นทางที่ใช้งานใน route master (ทิศทางมีผล A→B) — null = ไม่มี */
  route: { distanceKm: number; standardMinutes: number | null } | null;
  from: LegPoint | null;
  to: LegPoint | null;
}

export interface Leg {
  km: number | null;
  minutes: number | null;
  source: LegSource | null;
}

function straightKm(a: LegPoint, b: LegPoint): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const minutesFor = (km: number) => Math.round((km / TRIP_AVG_SPEED_KMH) * 60);

/**
 * ระยะ/เวลาของช่วงวิ่งระหว่างสองจุดติดกัน: จุดเดียวกัน = 0 · route master ก่อน (เวลามาตรฐานว่าง → ระยะ ÷ ความเร็วเฉลี่ย)
 * · ไม่มีเส้นทางแต่มีพิกัดทั้งสองฝั่ง → ค่าประมาณ · ไม่มีทั้งสอง → ไม่ทราบ (null)
 */
export function estimateLeg(i: LegInput): Leg {
  if (i.fromSiteId === i.toSiteId) return { km: 0, minutes: 0, source: 'SAME_SITE' };
  if (i.route)
    return {
      km: round1(i.route.distanceKm),
      minutes: i.route.standardMinutes ?? minutesFor(i.route.distanceKm),
      source: 'ROUTE',
    };
  if (i.from && i.to) {
    const km = round1(straightKm(i.from, i.to) * TRIP_ROAD_FACTOR);
    return { km, minutes: minutesFor(km), source: 'ESTIMATE' };
  }
  return { km: null, minutes: null, source: null };
}

export interface RouteTotals {
  /** ผลรวมของช่วงที่ทราบ (กม. ทศนิยม 1) — ไม่มีช่วงวิ่งเลย (จุดเดียว) = 0 · ไม่ทราบทุกช่วง = null */
  distanceKm: number | null;
  minutes: number | null;
  /** จำนวนช่วงที่ไม่ทราบระยะ (ยอดรวมยังไม่ครบ) */
  missingLegs: number;
  /** มีช่วงที่เป็นค่าประมาณจากพิกัด */
  estimated: boolean;
}

/** รวมระยะ/เวลาของทุกช่วงวิ่ง (ช่วงที่ไม่ทราบไม่นับ แต่บอกจำนวนใน `missingLegs`) */
export function routeTotals(legs: readonly Leg[]): RouteTotals {
  const known = legs.filter((l) => l.km !== null);
  const missingLegs = legs.length - known.length;
  if (legs.length > 0 && known.length === 0)
    return { distanceKm: null, minutes: null, missingLegs, estimated: false };
  return {
    distanceKm: round1(known.reduce((a, l) => a + l.km!, 0)),
    minutes: known.reduce((a, l) => a + (l.minutes ?? 0), 0),
    missingLegs,
    estimated: known.some((l) => l.source === 'ESTIMATE'),
  };
}
