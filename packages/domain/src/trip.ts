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
 * - `assign` = รถบริษัท/รถร่วมกำหนดรถ+คนขับ (snapshot) · `reassign` = เปลี่ยนรถ/คนขับก่อนปล่อยรถ (snapshot ใหม่)
 * - `dispatch` = ปล่อยรถ → ทุก DO ในเที่ยว DISPATCHED · หลังจากนี้ห้ามแก้ snapshot (§4.2 ท้าย)
 * - `start` = stop แรก ARRIVED/DEPART (ST4) · `complete` = ทุก stop COMPLETED/FAILED/SKIPPED
 * - `cost` / `settle` = ST6
 * - `cancel` ได้จาก PLANNING / OFFERED / ASSIGNED / DISPATCHED (00a รับ DISPATCHED → CANCELLED จาก spec PLN-012;
 *   OFFERED → CANCELLED เพิ่ม — [OPEN] spec/12 §3) · เหตุผล ≥ 10 ตัวอักษร
 */
export const TRIP_TRANSITIONS: TransitionTable<TripStatus, TripEvent> = {
  PLANNING: { offer: 'OFFERED', assign: 'ASSIGNED', cancel: 'CANCELLED' },
  OFFERED: { accept: 'ASSIGNED', reject: 'PLANNING', expire: 'PLANNING', cancel: 'CANCELLED' },
  ASSIGNED: { reassign: 'ASSIGNED', dispatch: 'DISPATCHED', cancel: 'CANCELLED' },
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
  for (const d of dos) {
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
