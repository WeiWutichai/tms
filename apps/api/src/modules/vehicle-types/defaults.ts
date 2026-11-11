import { Prisma, type PrismaClient } from '@prisma/client';
import type { LicenceClass, VehicleCapability, VehicleClass } from './vehicle-type.dto';

type Db = PrismaClient | Prisma.TransactionClient;

interface DefaultVehicleType {
  systemKey: string;
  code: string;
  nameTh: string;
  vehicleClass: VehicleClass;
  capacityKg: number;
  minLicenceClass: LicenceClass;
  capabilityTags?: VehicleCapability[];
  tempMinC?: number;
  tempMaxC?: number;
}

/**
 * ชุดประเภทรถเริ่มต้นของ tenant ใหม่ (ST2-T04; docs/04 A5 "ค่าเริ่มต้นภาษาไทยพร้อมใช้")
 * ตาม spec/02 §4 [PROPOSED — ตัวเลขเป็นค่าตั้งต้นแก้ได้] · ใบขับขี่ขั้นต่ำรอยืนยัน OPEN-MD-4 / FLT-Q6
 * ปริมาตรไม่ใส่ (spec ไม่กำหนด — ไม่แต่งเอง) · ห้องเย็น 0…+8 °C ตามชื่อใน spec
 */
export const DEFAULT_VEHICLE_TYPES: readonly DefaultVehicleType[] = [
  {
    systemKey: 'th.4w',
    code: '4W',
    nameTh: '4 ล้อ กระบะตู้ทึบ',
    vehicleClass: '4W',
    capacityKg: 1500,
    minLicenceClass: 'PERSONAL',
  },
  {
    systemKey: 'th.6w',
    code: '6W',
    nameTh: '6 ล้อ',
    vehicleClass: '6W',
    capacityKg: 6000,
    minLicenceClass: 'T2',
  },
  {
    systemKey: 'th.10w',
    code: '10W',
    nameTh: '10 ล้อ',
    vehicleClass: '10W',
    capacityKg: 15000,
    minLicenceClass: 'T2',
  },
  {
    systemKey: 'th.trl',
    code: 'TRL',
    nameTh: 'พ่วง (10 ล้อ + หางพ่วง)',
    vehicleClass: 'TRAILER',
    capacityKg: 30000,
    minLicenceClass: 'T3',
  },
  {
    systemKey: 'th.trc',
    code: 'TRC',
    nameTh: 'หัวลาก + หางเทรลเลอร์',
    vehicleClass: 'SEMI_TRAILER',
    capacityKg: 30000,
    minLicenceClass: 'T3',
  },
  {
    systemKey: 'th.ref6',
    code: 'REF6',
    nameTh: '6 ล้อ ห้องเย็น',
    vehicleClass: '6W',
    capacityKg: 5000,
    minLicenceClass: 'T2',
    capabilityTags: ['REFRIGERATED'],
    tempMinC: 0,
    tempMaxC: 8,
  },
];

/**
 * ใส่ประเภทรถเริ่มต้นให้ tenant — รันซ้ำได้ (bootstrap ขั้น `vehicle-types`, เรียกทั้งตอนสร้าง tenant และหลัง migrate):
 * - แถวที่เคยใส่แล้ว (จำด้วย `system_key`) ไม่ถูกสร้างซ้ำ แม้ผู้ใช้แก้รหัส/ชื่อ ปิดใช้ หรือลบ (soft delete) ไปแล้ว
 * - ไม่ทับค่าที่ tenant แก้แล้ว
 * - รหัสหรือชื่อชนกับประเภทที่ tenant สร้างเอง → ข้ามแถวนั้น (ON CONFLICT DO NOTHING)
 */
export async function ensureDefaultVehicleTypes(db: Db, tenantId: string): Promise<void> {
  await db.vehicleType.createMany({
    data: DEFAULT_VEHICLE_TYPES.map((d) => ({
      tenantId,
      systemKey: d.systemKey,
      code: d.code,
      nameTh: d.nameTh,
      vehicleClass: d.vehicleClass,
      capacityKg: d.capacityKg,
      minLicenceClass: d.minLicenceClass,
      capabilityTags: d.capabilityTags ?? [],
      tempMinC: d.tempMinC ?? null,
      tempMaxC: d.tempMaxC ?? null,
    })),
    skipDuplicates: true,
  });
}
