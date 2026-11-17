import type { TimelineEvent } from './useTripTimeline';
import type { TripDetail } from './useTrips';

/**
 * ตรรกะ stepper ของแท็บไทม์ไลน์ (ST4-T04) — ฟังก์ชันล้วน (test ได้)
 * ความหมาย DEPART ตาม docs/01 §3.9 (spec/12 §3 DECISION ST4-T02): "ออกจากจุด" ของจุด N = DEPART ของจุด N+1
 */
export type TripStop = TripDetail['stops'][number];

/** เที่ยวที่บันทึก event ได้ (API: อื่น 409 trip_not_in_progress) */
export const RECORDABLE = new Set(['DISPATCHED', 'IN_PROGRESS']);

export const isOpen = (s: Pick<TripStop, 'status'>) =>
  s.status === 'PENDING' || s.status === 'ARRIVED';

/** event ที่ตรรกะ stepper ใช้ (จาก GET /v1/trips/{id}/events) */
export type StepEvent = Pick<
  TimelineEvent,
  'stopId' | 'type' | 'seqStatus' | 'counted' | 'occurredAt' | 'flags' | 'resolution'
>;

const ms = (iso: string) => Date.parse(iso);
const earliest = (xs: string[]) =>
  xs.length ? xs.reduce((a, b) => (ms(b) < ms(a) ? b : a)) : null;

/** เวลาที่มีผลของจุดจาก event ที่นับ: ออกเดินทางมา (DEPART แรก) / ถึง (ARRIVE แรก) / ปิดงาน (COMPLETE|FAIL แรกที่นับ) */
export function stopTimes(stopId: string, events: readonly StepEvent[]) {
  const c = events.filter((e) => e.stopId === stopId && e.counted);
  const of = (...types: string[]) =>
    earliest(c.filter((e) => types.includes(e.type)).map((e) => e.occurredAt));
  return { enRoute: of('DEPART'), arrived: of('ARRIVE'), closed: of('COMPLETE', 'FAIL') };
}

/** มีการปิดงาน (COMPLETE/FAIL) ที่ยังไม่นับ + มีธงรอผู้จัดรถตัดสิน → อย่าให้บันทึกปิดซ้ำ (QA ST4-T04 M2) */
export const hasPendingClose = (stopId: string, events: readonly StepEvent[]) =>
  events.some(
    (e) =>
      e.stopId === stopId &&
      (e.type === 'COMPLETE' || e.type === 'FAIL') &&
      !e.counted &&
      e.flags.length > 0 &&
      !e.resolution,
  );

export type FloorWhat = 'depart' | 'arrive' | 'close';
export interface Floor {
  at: string;
  what: FloorWhat;
}
const latest = (xs: (Floor | null)[]): Floor | null =>
  xs.reduce<Floor | null>((a, b) => (!b ? a : !a || ms(b.at) > ms(a.at) ? b : a), null);
const fl = (at: string | null, what: FloorWhat): Floor | null => (at ? { at, what } : null);

/**
 * เวลาต่ำสุดที่บันทึกได้ (review/QA ST4-T04 M1 — กันสร้าง event ขัดลำดับเอง):
 * ถึงจุด ≥ ออกเดินทางมา · ปิดงาน/ไม่สำเร็จ ≥ ถึงจุด และ ≥ ออกเดินทางมา · ออกจากจุด (DEPART จุดถัดไป) ≥ ปิดงานของจุดเดิม
 * `kind` ของ "ออกจากจุด" ส่ง `stopId` = จุดที่กำลังออก
 */
export function timeFloor(
  kind: 'arrive' | 'close' | 'depart',
  stopId: string,
  events: readonly StepEvent[],
): Floor | null {
  const t = stopTimes(stopId, events);
  if (kind === 'arrive') return fl(t.enRoute, 'depart');
  if (kind === 'close') return latest([fl(t.arrived, 'arrive'), fl(t.enRoute, 'depart')]);
  return latest([fl(t.closed, 'close'), fl(t.arrived, 'arrive')]);
}

/** เวลาที่กรอกอยู่ก่อนเวลาต่ำสุด */
export const beforeFloor = (iso: string | null, floor: Floor | null) =>
  !!iso && !!floor && ms(iso) < ms(floor.at);

export interface StepActions {
  arrive: boolean;
  /** ปิดงาน — จุดที่ยังไม่ถึง: dialog ถามเวลาถึงด้วย แล้วส่ง ARRIVE ก่อน COMPLETE (กันธงขัดลำดับ) */
  complete: boolean;
  /** ส่งไม่สำเร็จ (ยังไม่ถึงจุด — FAIL) · ถึงแล้วเลือกผลไม่สำเร็จในปิดงาน */
  fail: boolean;
  /** ออกจากจุด = DEPART ของจุดถัดไป (จุดสุดท้ายไม่มี) */
  depart: TripStop | null;
  /** มีปิดงานรอผู้จัดรถตัดสิน — ซ่อนปิดงาน/ไม่สำเร็จ แสดงลิงก์ศูนย์ข้อยกเว้นแทน */
  pendingClose: boolean;
}

const NONE: StepActions = {
  arrive: false,
  complete: false,
  fail: false,
  depart: null,
  pendingClose: false,
};

export function stepActions(
  stops: readonly TripStop[],
  events: readonly StepEvent[],
  i: number,
): StepActions {
  const s = stops[i];
  if (!s) return NONE;
  const pendingClose = hasPendingClose(s.id, events);
  if (s.status === 'PENDING')
    return { ...NONE, arrive: true, complete: !pendingClose, fail: !pendingClose, pendingClose };
  if (s.status === 'ARRIVED') return { ...NONE, complete: !pendingClose, pendingClose };
  const next = stops[i + 1];
  if ((s.status === 'COMPLETED' || s.status === 'FAILED') && next && next.status === 'PENDING') {
    const left = events.some(
      (e) => e.stopId === next.id && e.type === 'DEPART' && e.seqStatus !== 'IGNORED',
    );
    return { ...NONE, depart: left ? null : next };
  }
  return NONE;
}

/** จุดที่ "ส่งไม่สำเร็จจุดที่เหลือ" ปิดได้: ยังไม่จบ และไม่มีปิดงานรอตัดสิน */
export const restStops = (stops: readonly TripStop[], events: readonly StepEvent[]) =>
  stops.filter((s) => isOpen(s) && !hasPendingClose(s.id, events));

/** ออกจากจุดจริง = DEPART ที่นับของจุดถัดไป (ไม่ใช้ค่า departedAt ที่ถอยไปเป็นเวลาปิดงาน — review L4) */
export function realDeparture(
  stops: readonly TripStop[],
  events: readonly StepEvent[],
  i: number,
): string | null {
  const next = stops[i + 1];
  return next ? stopTimes(next.id, events).enRoute : null;
}

/** ป้าย/ไอคอนของขั้น — ต้นแบบ vPanel steps: สำเร็จ = เครื่องหมายถูก · ล้มเหลว = circle-alert · รอดำเนินการ = clock */
export const STEP_LOOK: Record<
  string,
  { tone: 'ok' | 'warn' | 'err' | 'info' | 'off'; icon: string; ic: string; done: boolean }
> = {
  PENDING: { tone: 'info', icon: 'clock', ic: '#8F5500', done: false },
  ARRIVED: { tone: 'ok', icon: 'circle-dashed', ic: '#59606B', done: false },
  COMPLETED: { tone: 'ok', icon: 'circle-check', ic: '#2257C4', done: true },
  FAILED: { tone: 'err', icon: 'circle-alert', ic: '#B3322A', done: false },
  SKIPPED: { tone: 'off', icon: 'circle-dashed', ic: '#59606B', done: false },
  /** ส่ง/รับบางส่วน (ต้นแบบไม่มี — โทนเตือน) */
  PARTIAL: { tone: 'warn', icon: 'circle-minus', ic: '#8F5500', done: false },
};

/** กุญแจหน้าตาของขั้น: ปิดงานแบบบางส่วนแยกจากสำเร็จ */
export const stepKey = (s: Pick<TripStop, 'status' | 'outcome'>) =>
  s.status === 'COMPLETED' && s.outcome === 'PARTIAL' ? 'PARTIAL' : s.status;

/** สีป้ายตามโทน (ต้นแบบ badge()) */
export const TONE_COLORS = {
  ok: { c: '#17733F', bg: '#E6F4EC' },
  warn: { c: '#8F5500', bg: '#FCF0DC' },
  err: { c: '#B3322A', bg: '#FBE9E7' },
  info: { c: '#2257C4', bg: '#E9F0FA' },
  off: { c: '#3B424C', bg: '#ECEDEA' },
} as const;

/**
 * ตรวจเวลาที่กรอก (ISO ตามลำดับที่จะส่ง): ห้ามเกินตอนนี้ (เผื่อ 1 นาที) · ต้องไม่ถอยหลัง (ถึงจุด ≤ ปิดงาน)
 * ย้อนหลังได้ไม่จำกัด (เกิน 24 ชม. = API ขึ้นธง CLOCK_SKEW ให้ผู้จัดรถตรวจ)
 */
export function timeError(
  isos: readonly (string | null)[],
  now: Date,
): 'time' | 'future' | 'order' | null {
  if (isos.some((x) => !x)) return 'time';
  const ms = isos.map((x) => Date.parse(x!));
  if (ms.some((x) => Number.isNaN(x))) return 'time';
  if (ms.some((x) => x > now.getTime() + 60_000)) return 'future';
  for (let i = 1; i < ms.length; i++) if (ms[i]! < ms[i - 1]!) return 'order';
  return null;
}

/** หมวดเหตุผลตามชนิด/ผล (ตรงกับ domain `stopEventReasonRule`) — null = ไม่มีช่องเหตุผล */
export function reasonRule(
  kind: 'complete' | 'fail',
  outcome: 'DELIVERED' | 'PARTIAL' | 'FAILED' | 'UNDELIVERED_RETAIN' | null,
): { required: boolean; categories: string[] } | null {
  const FAIL = ['DELIVERY_FAILED', 'REJECTED_BY_RECEIVER'];
  if (kind === 'fail') return { required: true, categories: FAIL };
  if (outcome === 'DELIVERED') return null;
  if (outcome === 'PARTIAL') return { required: false, categories: FAIL };
  if (outcome === 'UNDELIVERED_RETAIN') return { required: true, categories: ['DELIVERY_FAILED'] };
  return { required: true, categories: FAIL };
}
