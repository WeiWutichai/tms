import type { ReasonCode } from '@prisma/client';
import type { ReasonCategoryApi } from './reason-code.dto';

/**
 * ค่าของเหตุผลที่ "คัดลอก" ลงงาน ณ เวลาที่เลือก (ST2-T12; docs/04 B Reason master "snapshot ข้อความลงงาน
 * (แก้ master ไม่ย้อนแก้งานเก่า)", spec/02 MD-220, docs/01 §3.9 stop_event "snapshot ข้อความลง payload")
 *
 * วิธีใช้ (ST3 ใบค้าง/ยกเลิก/override, ST4 ส่งไม่สำเร็จ/ตีกลับ/ล่าช้า/ไม่เซ็นเอกสาร, ST6 ข้อโต้แย้ง):
 *   const snap = await reasonCodes.snapshotFor(id, 'DELIVERY_FAILED'); // ตรวจ active + หมวด แล้วคืนค่าด้านล่าง
 *   if (snap.flags.requiresPhoto && !photos.length) → 422 · if (snap.flags.requiresNote && !note) → 422
 *   tx.stopEvent.create({ data: { reasonCodeId: snap.sourceId, payload: { reason: snap, note }, ... } })
 * - เก็บ snapshot ทั้งก้อน (jsonb) หรืออย่างน้อย code + label ลงแถวของงาน — ห้าม join กลับไปอ่าน reason_code ตอนแสดงผล/รายงาน
 * - FK `*_reason_code_id` ใช้กรอง/รายงานเท่านั้น; `sourceVersion` บอกว่าคัดลอกจากรุ่นไหน
 * - การยกเลิก/override: ข้อความเหตุผล + หมายเหตุรวม ≥ 10 ตัวอักษร (MD-222) เป็นหน้าที่ของโมดูลที่เรียก
 */
export interface ReasonSnapshot {
  /** uuid ของ reason_code (ค่าเดียวกับคอลัมน์ `*_reason_code_id`) */
  sourceId: string;
  /** version ของ reason_code ตอนคัดลอก */
  sourceVersion: number;
  category: ReasonCategoryApi;
  code: string;
  label: string;
  labelEn: string | null;
  flags: {
    requiresPhoto: boolean;
    requiresNote: boolean;
    autoReschedule: boolean;
    showOnTracking: boolean;
  };
}

/** ฟังก์ชันบริสุทธิ์: แถว reason_code → snapshot (ไม่แตะฐานข้อมูล; ผลลัพธ์ freeze ทั้งก้อน) */
export function snapshotReason(row: ReasonCode): Readonly<ReasonSnapshot> {
  return Object.freeze({
    sourceId: row.id,
    sourceVersion: row.version,
    category: row.category as ReasonCategoryApi,
    code: row.code,
    label: row.labelTh,
    labelEn: row.labelEn,
    flags: Object.freeze({
      requiresPhoto: row.requiresPhoto,
      requiresNote: row.requiresNote,
      autoReschedule: row.autoReschedule,
      showOnTracking: row.showOnTracking,
    }),
  });
}
