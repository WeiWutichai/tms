import { Prisma, type PrismaClient, type VehicleType } from '@prisma/client';
import type { LicenceClass, VehicleCapability, VehicleClass } from './vehicle-type.dto';
import { auditView, toVehicleTypeDto } from './vehicle-types.service';

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

const defaultKey = (systemKey: string) => `vehicle_type:${systemKey}`;
/** เหตุผลใน audit ของแถวที่ระบบสร้าง (ผู้ทำ = ระบบ: actor_id ว่าง) */
const BOOTSTRAP_REASON = 'ค่าเริ่มต้นของระบบ (สร้างบริษัท/อัปเดตค่าเริ่มต้น)';

/**
 * ใส่ประเภทรถเริ่มต้นให้ tenant — รันซ้ำได้ (bootstrap ขั้น `vehicle-types`, เรียกทั้งตอนสร้าง tenant และหลัง migrate)
 * - ทุกรายการที่จัดการแล้วบันทึกใน `tenant_default` (INSERTED / SKIPPED) → ไม่ทำซ้ำอีกเลย:
 *   ผู้ใช้แก้รหัส/ชื่อ ปิดใช้ หรือลบไปแล้ว = ไม่สร้างใหม่ · เคยข้ามเพราะชนรหัส/ชื่อที่ tenant มีอยู่ = ไม่ใส่ภายหลังแม้ต่อมาไม่ชน
 * - ไม่ทับค่าที่ tenant แก้แล้ว
 * - แถวที่สร้างลง audit (ผู้ทำ = ระบบ) + domain_event `vehicle_type.created` เหมือนสร้างผ่าน API
 */
export async function ensureDefaultVehicleTypes(db: Db, tenantId: string): Promise<void> {
  const done = new Set(
    (
      await db.tenantDefault.findMany({
        where: { tenantId, key: { startsWith: 'vehicle_type:' } },
        select: { key: true },
      })
    ).map((r) => r.key),
  );
  for (const d of DEFAULT_VEHICLE_TYPES) {
    const key = defaultKey(d.systemKey);
    if (done.has(key)) continue;
    // แถวจากรุ่นก่อนมี tenant_default (system_key มีแล้ว) → แค่บันทึกว่าใส่แล้ว
    const legacy = await db.vehicleType.findFirst({
      where: { tenantId, systemKey: d.systemKey },
      select: { id: true },
    });
    let created: VehicleType | undefined;
    if (!legacy)
      [created] = await db.vehicleType.createManyAndReturn({
        data: [
          {
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
          },
        ],
        skipDuplicates: true, // ชนรหัส/ชื่อที่ tenant สร้างเอง → ไม่สร้าง (บันทึก SKIPPED)
      });
    await db.tenantDefault.create({
      data: {
        tenantId,
        key,
        outcome: legacy || created ? 'INSERTED' : 'SKIPPED',
        detail: legacy || created ? null : 'code_or_name_taken',
      },
    });
    if (!created) continue;
    const dto = toVehicleTypeDto(created);
    await db.auditLog.create({
      data: {
        tenantId,
        actorId: null,
        action: 'vehicle_type.created',
        entityType: 'vehicle_type',
        entityId: created.id,
        after: auditView(created) as Prisma.InputJsonValue,
        reason: BOOTSTRAP_REASON,
      },
    });
    await db.domainEvent.create({
      data: {
        tenantId,
        type: 'vehicle_type.created',
        entityType: 'vehicle_type',
        localId: created.id,
        snapshot: JSON.parse(JSON.stringify(dto)) as Prisma.InputJsonValue,
        previousAttributes: {},
      },
    });
  }
}
