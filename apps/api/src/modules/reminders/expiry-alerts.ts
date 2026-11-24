import { VEHICLE_DOC_TYPES } from '@tms/domain';

/**
 * ค่าตั้ง "แจ้งเตือนเอกสารรถ" ต่อบริษัท (ST2-T18 / คำถามค้าง #40 — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ `docalert`)
 * เก็บใน registry ค่าตั้งเดิม (`reminders.expiryAlerts` — ไม่เพิ่มตาราง) ต่อประเภทเอกสาร + ใบขับขี่:
 * ระดับที่เตือน (60/30/7 วัน — ชุดเดียวกับ REMINDER_THRESHOLDS) และช่องทาง (ในระบบ / อีเมล)
 * - ไม่เลือกระดับเลย = ไม่เตือนประเภทนั้น (รวม "หมดอายุแล้ว") · เลือกระดับแต่ปิดทุกช่องทาง = ไม่เตือน
 * - ผู้รับยังเป็น "ผู้มีสิทธิ์แก้ข้อมูลรถ" (master:write) — ต้นแบบมีคอลัมน์ผู้รับผิดชอบรายคน แต่ docs/04 A3 ไม่มี role
 *   เฉพาะ → [DECISION — lead 24 พ.ย. 2569 เพื่อ UAT, ย้อนได้] แสดงอ่านอย่างเดียว · LINE ของพนักงานยังไม่มีช่องทาง → ไม่มีคอลัมน์
 * - ไม่ "แจ้งซ้ำทุกวันเมื่อเหลือ 7 วัน" ตามโน้ตต้นแบบ — ยึด spec/06 FLT-040 (แต่ละระดับครั้งเดียว)
 */
export const EXPIRY_ALERT_TYPES = [...VEHICLE_DOC_TYPES, 'DRIVER_LICENCE'] as const;
export type ExpiryAlertType = (typeof EXPIRY_ALERT_TYPES)[number];
export const EXPIRY_ALERT_LEVELS = [60, 30, 7] as const;

export interface ExpiryAlertRow {
  levels: number[];
  inApp: boolean;
  email: boolean;
}
export type ExpiryAlerts = Record<ExpiryAlertType, ExpiryAlertRow>;

const FULL: ExpiryAlertRow = { levels: [60, 30, 7], inApp: true, email: true };
export const DEFAULT_EXPIRY_ALERTS: ExpiryAlerts = Object.fromEntries(
  EXPIRY_ALERT_TYPES.map((k) => [k, { ...FULL, levels: [...FULL.levels] }]),
) as ExpiryAlerts;

/** ตรวจรูปค่า — ประเภทครบทุกตัว ไม่มี key เกิน · ระดับเป็นสมาชิก 60/30/7 ไม่ซ้ำ · ช่องทางเป็น boolean */
export function expiryAlertsError(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!(EXPIRY_ALERT_TYPES as readonly string[]).includes(k)) return `${k}: unknown type`;
  for (const k of EXPIRY_ALERT_TYPES) {
    const r = o[k] as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') return `${k}: required`;
    if (
      !Array.isArray(r.levels) ||
      r.levels.some((x) => !(EXPIRY_ALERT_LEVELS as readonly unknown[]).includes(x)) ||
      new Set(r.levels).size !== r.levels.length
    )
      return `${k}.levels: must be a subset of 60, 30, 7`;
    if (typeof r.inApp !== 'boolean') return `${k}.inApp: must be boolean`;
    if (typeof r.email !== 'boolean') return `${k}.email: must be boolean`;
    const extra = Object.keys(r).find((x) => !['levels', 'inApp', 'email'].includes(x));
    if (extra) return `${k}.${extra}: unknown field`;
  }
  return null;
}

/** รูปมาตรฐาน (เรียงระดับมากไปน้อย) */
export function normalizeExpiryAlerts(v: ExpiryAlerts): ExpiryAlerts {
  return Object.fromEntries(
    EXPIRY_ALERT_TYPES.map((k) => [
      k,
      { levels: [...v[k].levels].sort((a, b) => b - a), inApp: v[k].inApp, email: v[k].email },
    ]),
  ) as ExpiryAlerts;
}

/** แถวของประเภท (ค่าเสีย/ไม่มี = ค่าเริ่มต้น) */
export function alertRow(cfg: unknown, type: string): ExpiryAlertRow {
  const r = (cfg as Partial<Record<string, ExpiryAlertRow>> | null)?.[type];
  return r && Array.isArray(r.levels) ? r : FULL;
}

/** ช่องทางของแถว (ว่าง = ไม่ส่ง) */
export function alertChannels(r: ExpiryAlertRow): ('in_app' | 'email')[] {
  return [...(r.inApp ? (['in_app'] as const) : []), ...(r.email ? (['email'] as const) : [])];
}
