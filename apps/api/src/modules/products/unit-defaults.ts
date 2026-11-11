import { Prisma, type PrismaClient, type Unit } from '@prisma/client';
import type { UnitKind } from './unit.dto';
import { toUnitDto, unitAuditView } from './units.service';

type Db = PrismaClient | Prisma.TransactionClient;

interface DefaultUnit {
  systemKey: string;
  code: string;
  nameTh: string;
  kind: UnitKind;
  toKg?: number;
  toCbm?: number;
}

/**
 * ชุดหน่วยเริ่มต้นของ tenant ใหม่ (ST2-T10; spec/02 §3 "ชุดเริ่มต้นสร้างให้ทุก tenant ใหม่
 * (ถุง พาเลท ชิ้น กล่อง ตู้ ตัน กก. ลบ.ม. ลิตร) ลบไม่ได้ ปิดใช้ได้") — รหัสตามตัวอย่าง spec (BAG PLT PCS BOX CTN TON KG CBM L)
 * ตัวแปลง: ตัน = 1,000 กก. (spec), กก. = 1, ลบ.ม. = 1, ลิตร = 0.001 ลบ.ม. (นิยามหน่วย SI)
 * ต้นแบบมีหน่วย "ถัง" ด้วย — ไม่อยู่ในชุดของ spec จึงไม่ใส่ (tenant เพิ่มเองได้) [OPEN spec/12 §3]
 */
export const DEFAULT_UNITS: readonly DefaultUnit[] = [
  { systemKey: 'th.bag', code: 'BAG', nameTh: 'ถุง', kind: 'COUNT' },
  { systemKey: 'th.plt', code: 'PLT', nameTh: 'พาเลท', kind: 'COUNT' },
  { systemKey: 'th.pcs', code: 'PCS', nameTh: 'ชิ้น', kind: 'COUNT' },
  { systemKey: 'th.box', code: 'BOX', nameTh: 'กล่อง', kind: 'COUNT' },
  { systemKey: 'th.ctn', code: 'CTN', nameTh: 'ตู้', kind: 'COUNT' },
  { systemKey: 'th.ton', code: 'TON', nameTh: 'ตัน', kind: 'WEIGHT', toKg: 1000 },
  { systemKey: 'th.kg', code: 'KG', nameTh: 'กก.', kind: 'WEIGHT', toKg: 1 },
  { systemKey: 'th.cbm', code: 'CBM', nameTh: 'ลบ.ม.', kind: 'VOLUME', toCbm: 1 },
  { systemKey: 'th.l', code: 'L', nameTh: 'ลิตร', kind: 'VOLUME', toCbm: 0.001 },
];

const defaultKey = (systemKey: string) => `unit:${systemKey}`;
const BOOTSTRAP_REASON = 'ค่าเริ่มต้นของระบบ (สร้างบริษัท/อัปเดตค่าเริ่มต้น)';

/**
 * ใส่หน่วยเริ่มต้นให้ tenant — รันซ้ำได้ (bootstrap ขั้น `units`) แบบเดียวกับประเภทรถ (ST2-T04):
 * จำใน `tenant_default` (INSERTED / SKIPPED) → ไม่ทำซ้ำ, ไม่ทับที่ผู้ใช้แก้, ชนรหัส/ชื่อที่ tenant มี = ข้าม
 * แถวที่สร้างลง audit (ผู้ทำ = ระบบ) + domain_event `unit.created`
 */
export async function ensureDefaultUnits(db: Db, tenantId: string): Promise<void> {
  const done = new Set(
    (
      await db.tenantDefault.findMany({
        where: { tenantId, key: { startsWith: 'unit:' } },
        select: { key: true },
      })
    ).map((r) => r.key),
  );
  for (const d of DEFAULT_UNITS) {
    const key = defaultKey(d.systemKey);
    if (done.has(key)) continue;
    // ชื่อชนแบบไม่สนตัวพิมพ์มี partial unique index — createMany skipDuplicates ข้ามให้
    const [created]: (Unit | undefined)[] = await db.unit.createManyAndReturn({
      data: [
        {
          tenantId,
          systemKey: d.systemKey,
          code: d.code,
          nameTh: d.nameTh,
          kind: d.kind,
          toKg: d.toKg ?? null,
          toCbm: d.toCbm ?? null,
        },
      ],
      skipDuplicates: true,
    });
    await db.tenantDefault.create({
      data: {
        tenantId,
        key,
        outcome: created ? 'INSERTED' : 'SKIPPED',
        detail: created ? null : 'code_or_name_taken',
      },
    });
    if (!created) continue;
    await db.auditLog.create({
      data: {
        tenantId,
        actorId: null,
        action: 'unit.created',
        entityType: 'unit',
        entityId: created.id,
        after: unitAuditView(created) as Prisma.InputJsonValue,
        reason: BOOTSTRAP_REASON,
      },
    });
    await db.domainEvent.create({
      data: {
        tenantId,
        type: 'unit.created',
        entityType: 'unit',
        localId: created.id,
        snapshot: JSON.parse(JSON.stringify(toUnitDto(created))) as Prisma.InputJsonValue,
        previousAttributes: {},
      },
    });
  }
}
