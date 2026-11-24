import type { MessageKey } from '../../i18n/th';

/** สถานะแถวหน้า "จ่ายงานรถร่วม" (API `GET /v1/subcon-offers`) → แท็บ/ป้ายของต้นแบบ TMS v4 `specSub` */
export const SUB_STATUSES = ['OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;
export type SubStatus = (typeof SUB_STATUSES)[number];

/** แท็บต้นแบบ: ทั้งหมด · รอตอบ · รับงาน · ปฏิเสธ · หมดเวลา — การ์ด "ปฏิเสธ / หมดเวลา" = ตัวกรอง `bad` */
export const SUB_TABS = ['all', ...SUB_STATUSES] as const;
export type SubTab = (typeof SUB_TABS)[number];
export type SubFilter = SubTab | 'bad';

export const subStatusKey = (s: string): MessageKey =>
  (SUB_STATUSES as readonly string[]).includes(s)
    ? (`subl.st.${s}` as MessageKey)
    : ('subl.st.OFFERED' as MessageKey);

/** ตัวกรองสถานะที่ส่ง API (แท็บ/การ์ด ∩ ตัวกรองคอลัมน์ "สถานะ") — ไม่มีทางตรง = null (ไม่ต้องเรียก) */
export function subQueryStatus(f: SubFilter, col: string): string | null | undefined {
  const base: readonly string[] | undefined =
    f === 'all' ? undefined : f === 'bad' ? ['REJECTED', 'EXPIRED'] : [f];
  if (!col) return base ? base.join(',') : undefined;
  if (base && !base.includes(col)) return null;
  return col;
}

/** "เหลือ N ชม." ของต้นแบบ (ปัดลง) — < 1 ชม. = นาที · หมดแล้ว = null */
export function hoursLeft(
  expiresAt: string | null,
  now = Date.now(),
): { unit: 'h' | 'm'; n: number } | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return null;
  if (ms >= 3600_000) return { unit: 'h', n: Math.floor(ms / 3600_000) };
  return { unit: 'm', n: Math.max(1, Math.ceil(ms / 60_000)) };
}

/** เลข DO ในคอลัมน์ "เลข SO / DO" — ใบแรก (+n ใบ) · ไม่มี DO = เลขเที่ยว */
export function docLabel(r: { deliveryOrderNos: string[]; tripNo: string | null }): {
  no: string;
  more: number;
} {
  const [first, ...rest] = r.deliveryOrderNos;
  return { no: first ?? r.tripNo ?? '—', more: rest.length };
}
