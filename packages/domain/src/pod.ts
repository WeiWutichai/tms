import type { DoEvent, DoStatus } from './delivery-order';
import type { PodOutcome } from './pod-checklist';

/**
 * หลักฐานส่ง (ePOD) ต่อ DO (ST4-T07; docs/04 E2 "ePOD ผ่านเว็บ", docs/01 §3.3 `pod_status`, §4.3, §5.3 payload POD)
 *
 * - บันทึกเป็นฉบับ (version 1, 2, …) ต่อ DO — แก้ = ฉบับใหม่ + เหตุผล (spec/04 DRV-164 "เก็บเวอร์ชันเดิม + เหตุผล") ไม่มีลบ
 * - `pod_status`: NONE = ยังไม่มีหลักฐาน · PARTIAL = มีแต่ยังไม่ครบ checklist ของลูกค้า · COMPLETE = ครบ
 * - DO: DELIVERED → UNBILLED (ครบตามเกณฑ์ลูกค้า) / POD_PENDING (ไม่ครบ) · POD_PENDING → UNBILLED (บันทึกจนครบ)
 * - ใช้ร่วมกันทุกช่องทาง: เว็บ (T07), ลิงก์รถร่วม (T09), แอปคนขับ (P1) — `source`
 */

export const POD_STATUSES = ['NONE', 'PARTIAL', 'COMPLETE'] as const;
export type PodStatus = (typeof POD_STATUSES)[number];

/** ช่องทางที่บันทึก (เหมือน stop_event.source) */
export const POD_SOURCES = ['WEB', 'LINK', 'APP', 'API'] as const;
export type PodSource = (typeof POD_SOURCES)[number];

/** ความสัมพันธ์ของผู้รับ (spec/04 §13 "ผู้รับเอง/รปภ./พนักงาน") + อื่น ๆ */
export const POD_RELATIONS = ['SELF', 'SECURITY', 'STAFF', 'OTHER'] as const;
export type PodRelation = (typeof POD_RELATIONS)[number];

/** เพดานต่อฉบับ (เว็บ) — ลิงก์รถร่วมจำกัดรูป ≤ 5 เอง (ST4-T09) */
export const POD_PHOTOS_MAX = 20;
export const POD_FILES_MAX = 10;
export const POD_BARCODES_MAX = 50;
export const POD_RECEIVER_MAX = 100;
export const POD_CUSTOMER_REF_MAX = 50;
export const POD_NOTE_MAX = 500;
/** เหตุผลเมื่อแก้หลักฐานที่บันทึกแล้ว (ฉบับที่ 2 ขึ้นไป) */
export const POD_REASON_MIN = 10;

/** DO ที่บันทึก/แก้หลักฐานได้: ส่งแล้ว (รอ POD / รอวางบิล) หรือส่งไม่สำเร็จ (หลักฐานชุดไม่สำเร็จ) — วางบิลแล้วแก้ไม่ได้ */
export const POD_EDITABLE_DO_STATUSES = [
  'DELIVERED',
  'POD_PENDING',
  'UNBILLED',
  'FAILED',
  // ST4-T11 [DECISION spec/12 §3]: RETURNED = สถานะสิ้นสุด → หลักฐานอ่านอย่างเดียว
] as const satisfies readonly DoStatus[];

export function isPodEditable(status: DoStatus): boolean {
  return (POD_EDITABLE_DO_STATUSES as readonly string[]).includes(status);
}

/** ชุด checklist ที่ใช้ตรวจ ตามสถานะ DO: ส่งไม่สำเร็จ/คืนคลัง = ชุด "ไม่สำเร็จ" · อื่น ๆ = ชุด "สำเร็จ" */
export function podSetForDo(status: DoStatus): PodOutcome {
  return status === 'FAILED' || status === 'RETURNED' ? 'FAILURE' : 'SUCCESS';
}

/** NONE = ไม่มีฉบับใดเลย · มีแล้ว: ครบ = COMPLETE ไม่ครบ = PARTIAL */
export function podStatusOf(hasRecord: boolean, complete: boolean): PodStatus {
  if (!hasRecord) return 'NONE';
  return complete ? 'COMPLETE' : 'PARTIAL';
}

/**
 * transition ของ DO หลังคำนวณ POD (docs/01 §4.3):
 * DELIVERED → `pod_accept` (ผ่านเกณฑ์ลูกค้า — รวมกรณีลูกค้าไม่บังคับอะไรเลย) / `pod_wait` (ไม่ครบ) ·
 * POD_PENDING → `pod_accept` เมื่อครบ · สถานะอื่นไม่เปลี่ยน (UNBILLED ที่หลักฐานถูกแก้จนไม่ครบ **ไม่ถอยกลับ** — ไม่มีใน §4.3)
 */
export function podDoEvent(
  status: DoStatus,
  meetsChecklist: boolean,
): Extract<DoEvent, 'pod_wait' | 'pod_accept'> | null {
  if (status === 'DELIVERED') return meetsChecklist ? 'pod_accept' : 'pod_wait';
  if (status === 'POD_PENDING' && meetsChecklist) return 'pod_accept';
  return null;
}

/**
 * รหัสที่สแกนได้: ชื่อใน docs/01 §5.3 = `barcodes[]` · ชื่อใน spec/04 §13 / ST4-T06 = `scanCodes[]` → รับได้ทั้งสองชื่อ
 * ส่งทั้งคู่ต้องเหมือนกัน (ไม่งั้น `conflict`) · ตัดช่องว่าง ตัดค่าว่าง ตัดซ้ำ (คงลำดับ)
 */
export function normalizeBarcodes(
  barcodes: readonly string[] | null | undefined,
  scanCodes: readonly string[] | null | undefined,
): { value: string[]; conflict: boolean } {
  const clean = (l: readonly string[] | null | undefined) => {
    const out: string[] = [];
    for (const c of l ?? []) {
      const v = typeof c === 'string' ? c.trim() : '';
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  };
  const a = clean(barcodes);
  const b = clean(scanCodes);
  if (barcodes != null && scanCodes != null && a.join('\u0000') !== b.join('\u0000'))
    return { value: a, conflict: true };
  return { value: barcodes != null ? a : b, conflict: false };
}

/** แสดง PIN แบบปิดบัง (ห้ามแสดง/ log ค่าจริง) */
export function maskPin(pin: string | null | undefined): string | null {
  if (!pin) return null;
  return '•'.repeat(pin.length);
}
