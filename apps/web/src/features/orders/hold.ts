import type { Tone } from '@tms/ui';
import type { MessageKey } from '../../i18n/th';

/**
 * เหตุค้างครบชุด 12 รหัส (docs/04 C "หน้าใบค้าง + reason code ครบชุด"; plan/11 ข้อ 4) — ลำดับ = ลำดับใน docs/04 C
 * ค่าเดียวกับ `ORDER_HOLD_CODES` ใน @tms/domain (web ไม่ได้พึ่ง domain — `hold.test.ts` ตรวจให้ตรงกับ enum ใน OpenAPI)
 */
export const HOLD_CODES = [
  'CUSTOMER_UNMAPPED',
  'LOCATION_UNMAPPED',
  'GEOCODING_ERROR',
  'RATE_MISSING',
  'UNALLOCATED_NO_VEHICLE',
  'CAPACITY_EXCEEDED',
  'VEHICLE_TYPE_INCOMPATIBLE',
  'CARRIER_REJECTED',
  'DELIVERY_WINDOW_EXHAUSTED',
  'RESCHEDULES_EXHAUSTED',
  'SOURCE_CHANGED_AFTER_PLAN',
  'SOURCE_ERROR',
  'ALL_RETURNED', // ST4-T11
] as const;
export type HoldCode = (typeof HOLD_CODES)[number];

/**
 * วิธีเคลียร์ต่อรหัส (docs/01 §4.1 คอลัมน์ "action เคลียร์"):
 * - `customer` จับคู่ลูกค้า (POST map-customer) · `site` เลือกสถานที่ของจุด (POST stops/{seq}/map-site)
 * - `pin` ปักพิกัดสถานที่ในข้อมูลหลัก แล้วตรวจอีกครั้ง · `rate` เพิ่ม/อนุมัติ rate card แล้วตรวจอีกครั้ง
 * - `source` แก้ใบ + ยืนยันข้อมูลต้นทาง (POST resolve-source-error) · `review` ตรวจการแก้จากต้นทางใน drawer (ST3-T10)
 * - `view` เปิดใบ — เหตุจากการจัดรถ/เวลาส่ง เคลียร์ที่กระดานวางแผน/เที่ยวรถ (ST3-T11/T12/T23 — ยังไม่มีในเฟสนี้)
 */
export type HoldAction = 'customer' | 'site' | 'pin' | 'rate' | 'source' | 'review' | 'view';

export const HOLD_META: Record<HoldCode, { tone: Tone; icon: string; action: HoldAction }> = {
  // ป้าย/ไอคอนตามต้นแบบ (BM: รอกำหนดเส้นทาง = clock, ยังไม่จับคู่ลูกค้า = user-x) — ที่เหลือคิดเอง
  // [DECISION — ย้อนได้ spec/12 §3, PO 16 พ.ย. 2569] · ใช้ทั้งตารางใบค้างและป้ายหัว drawer SO (ชุดเดียว)
  CUSTOMER_UNMAPPED: { tone: 'warn', icon: 'user-x', action: 'customer' },
  LOCATION_UNMAPPED: { tone: 'warn', icon: 'clock', action: 'site' },
  GEOCODING_ERROR: { tone: 'warn', icon: 'map-pin-off', action: 'pin' },
  RATE_MISSING: { tone: 'warn', icon: 'tags', action: 'rate' },
  UNALLOCATED_NO_VEHICLE: { tone: 'warn', icon: 'truck', action: 'view' },
  CAPACITY_EXCEEDED: { tone: 'warn', icon: 'weight', action: 'view' },
  VEHICLE_TYPE_INCOMPATIBLE: { tone: 'warn', icon: 'shuffle', action: 'view' },
  CARRIER_REJECTED: { tone: 'err', icon: 'x', action: 'view' },
  DELIVERY_WINDOW_EXHAUSTED: { tone: 'err', icon: 'timer-off', action: 'view' },
  RESCHEDULES_EXHAUSTED: { tone: 'err', icon: 'calendar-x', action: 'view' },
  SOURCE_CHANGED_AFTER_PLAN: { tone: 'warn', icon: 'pencil', action: 'review' },
  SOURCE_ERROR: { tone: 'err', icon: 'circle-alert', action: 'source' },
  // ST4-T11 ทุกใบคืนคลัง — ยกเลิกใบสั่ง (+ เหตุผล) หรือสร้าง/จัดรถใหม่ (ต้นแบบไม่มี — spec/12 §3)
  ALL_RETURNED: { tone: 'err', icon: 'undo-2', action: 'view' },
};

export const isHoldCode = (c: string | null | undefined): c is HoldCode =>
  !!c && (HOLD_CODES as readonly string[]).includes(c);

export const holdMeta = (code: string) =>
  isHoldCode(code)
    ? HOLD_META[code]
    : { tone: 'warn' as Tone, icon: 'circle', action: 'view' as const };

/** ข้อความปุ่มเคลียร์ในตารางใบค้าง */
export const actionLabel = (a: HoldAction): MessageKey => `hold.act.${a}` as MessageKey;

/** เหตุที่ "ตรวจอีกครั้ง" (POST reevaluate) ช่วยได้ — เหตุของทางเข้าที่ข้อมูลหลักเป็นต้นเหตุ */
export const RECHECKABLE: readonly string[] = [
  'CUSTOMER_UNMAPPED',
  'LOCATION_UNMAPPED',
  'GEOCODING_ERROR',
  'RATE_MISSING',
];
