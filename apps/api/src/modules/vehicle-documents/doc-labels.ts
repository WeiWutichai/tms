import type { VehicleDocTypeKey } from './vehicle-document.dto';

/** ชื่อประเภทภาษาไทย (หมายเหตุใน vehicle_cost — ต้นแบบ; ข้อความเหตุบล็อก ST2-T20) */
export const DOC_TYPE_TH: Record<VehicleDocTypeKey, string> = {
  INSURANCE: 'ประกันภัย',
  COMPULSORY_ACT: 'พ.ร.บ.',
  ANNUAL_TAX: 'ภาษี',
  INSPECTION: 'ตรวจสภาพ ตรอ.',
  TRANSPORT_LICENSE: 'ใบอนุญาตขนส่ง',
  GPS_DLT_CERT: 'GPS DLT',
  OTHER: 'เอกสารอื่น',
};
