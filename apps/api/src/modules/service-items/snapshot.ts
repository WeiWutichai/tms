import type { ServiceItem } from '@prisma/client';
import type { ServiceItemVatType, ServiceItemWhtRate } from '@tms/domain';
import type { CalcUnit, ServiceItemSide } from './service-item.dto';

/**
 * ค่าของรายการ catalog ที่ "คัดลอก" ลงบรรทัดเอกสาร ณ เวลาสร้างบรรทัด (ST2-T11; docs/01 §3.2 "ค่าทุกตัวถูก snapshot
 * ลงรายการเอกสารตอนสร้าง แก้ master แล้วเอกสารเก่าไม่เปลี่ยน", docs/04 B Accessorial, spec/02 MD-157)
 *
 * วิธีใช้ (ST3 บรรทัดราคา SO/DO, ST4-T13 `do_surcharge`, ST5 `invoice_line`, ST6 `trip_cost`/settlement):
 *   const snap = await serviceItems.snapshotFor(id, 'SELL'); // ตรวจ active + ฝั่ง แล้วคืนค่าด้านล่าง
 *   tx.doSurcharge.create({ data: { serviceItemId: snap.sourceItemId, vatType: snap.vatType,
 *     whtRate: snap.whtRate, unitPrice: snap.unitPrice ?? actual, ... } })
 * - เก็บค่าที่ได้ลงคอลัมน์ของบรรทัดเอง (หรือ jsonb snapshot) — ห้าม join กลับไปอ่าน service_item ตอนคำนวณ/พิมพ์เอกสาร
 * - `sourceItemId` + `sourceVersion` ใช้ตามรอยว่าคัดลอกจากรายการรุ่นไหน (ไม่ใช่ FK สำหรับอ่านค่า)
 * - เงิน/อัตราเป็นสตริงทศนิยม numeric(14,2)/(5,2) — ห้ามแปลงเป็น float; ใช้ satangFromDecimal ของ @tms/domain
 * - ผู้ใช้แก้ธงภาษีในบรรทัดภายหลังได้เฉพาะ accounting พร้อมเหตุผล (MD-150) — เป็นงานของโมดูลเอกสาร ไม่ใช่ catalog
 */
export interface ServiceItemSnapshot {
  /** uuid ของ service_item (ค่าเดียวกับคอลัมน์ `service_item_id` ของบรรทัด) */
  sourceItemId: string;
  /** version ของ service_item ตอนคัดลอก */
  sourceVersion: number;
  code: string;
  name: string;
  nameEn: string | null;
  /** หน่วยคิด */
  unit: CalcUnit;
  /** ข้อความหน่วยบนเอกสาร (เที่ยว ชั่วโมง …) */
  unitLabel: string;
  /** ราคาตั้งต้น (บาท ก่อน VAT หรือ % เมื่อ unit = PERCENT_OF_FREIGHT) — null = ไม่มีราคาตั้งต้น/ตามจริง */
  unitPrice: string | null;
  fuelRefPrice: string | null;
  vatType: ServiceItemVatType;
  /** หัก ณ ที่จ่าย (%) เช่น "1.00" — ส่งเข้า computeDocumentTax ต้องหาร 100 */
  whtRate: ServiceItemWhtRate;
  isSurcharge: boolean;
  defaultAccountCode: string | null;
}

/** ฟังก์ชันบริสุทธิ์: แถว service_item → snapshot (ไม่แตะฐานข้อมูล; ผลลัพธ์ freeze กันแก้ทับโดยไม่ตั้งใจ) */
export function snapshotServiceItem(item: ServiceItem): Readonly<ServiceItemSnapshot> {
  return Object.freeze({
    sourceItemId: item.id,
    sourceVersion: item.version,
    code: item.code,
    name: item.nameTh,
    nameEn: item.nameEn,
    unit: item.calcUnit as CalcUnit,
    unitLabel: item.unitLabel,
    unitPrice: item.defaultPrice === null ? null : item.defaultPrice.toFixed(2),
    fuelRefPrice: item.fuelRefPrice === null ? null : item.fuelRefPrice.toFixed(2),
    vatType: item.vatType as ServiceItemVatType,
    whtRate: item.whtRate.toFixed(2) as ServiceItemWhtRate,
    isSurcharge: item.isSurcharge,
    defaultAccountCode: item.defaultAccountCode,
  });
}

/** เอกสารฝั่งขาย (ลูกค้า) ใช้รายการ SELL/BOTH · ฝั่งซื้อ (รถร่วม) ใช้ BUY/BOTH */
export function sideAllows(itemSide: ServiceItemSide, docSide: 'SELL' | 'BUY'): boolean {
  return itemSide === 'BOTH' || itemSide === docSide;
}
