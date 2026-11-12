import { Prisma, type PrismaClient, type ServiceItem } from '@prisma/client';
import type { ServiceItemVatType, ServiceItemWhtRate } from '@tms/domain';
import { CALC_UNIT_LABEL, type CalcUnit, type ServiceItemSide } from './service-item.dto';
import { RESERVED_SYSTEM_KEYS, auditView, toServiceItemDto } from './service-items.service';

type Db = PrismaClient | Prisma.TransactionClient;

interface DefaultServiceItem {
  systemKey: string;
  code: string;
  nameTh: string;
  calcUnit: CalcUnit;
  defaultPrice: string | null;
  condition?: string;
  vatType: ServiceItemVatType;
  whtRate: ServiceItemWhtRate;
  side: ServiceItemSide;
  isSurcharge: boolean;
}

/**
 * ชุดค่าบริการเสริมเริ่มต้นของ tenant ใหม่ (ST2-T11; docs/04 A5 "accessorial, VAT/WHT default — ใช้ได้ทันที")
 * รายการ/หน่วยคิด/ราคาตั้งต้น ตาม spec/02 §6 "ชุดเริ่มต้น" [PROPOSED — แก้ได้ต่อ tenant]
 *
 * ธงภาษี:
 * - FREIGHT ค่าขนส่ง = ยกเว้น VAT (ม.81(1)(ณ)) + หัก 1% (ท.ป.4/2528 ข้อ 12/4) [FACT research §1.8, §3.1]
 * - LOAD/UNLOAD ค่าขึ้น/ลงสินค้า = บริการประกอบ VAT 7% + หัก 3% (ข้อ 12/1) [FACT research §0 ข้อ 1 (ยกขน), กค 0811/11620]
 * - EXTRA_STOP/FSC/WAIT/OVERNIGHT/TOLL = **[OPEN — รอนักบัญชีข้อ 2 (docs/01 §8.2) / ACC-3 (plan/06)]**
 *   ใช้ "สิ่งที่เราจะทำถ้ายังไม่ได้คำตอบ" ของ ACC-3: ถือเป็นค่าขนส่ง (ยกเว้น VAT, หัก 1%) และให้แต่ละบริษัทแก้เองได้
 *   (ต้นแบบตั้งค่ารอ/ค่าค้างคืนเป็น VAT 7% และค่าทางด่วนไม่หัก — ข้อมูลตัวอย่าง ไม่ใช้; spec/12 §3)
 * - DISCOUNT ของ spec ไม่ใส่ (ภาษีตามบรรทัดที่ลด — ST5) · ค่ายกเลิกงาน (ACC-3) ไม่อยู่ในชุด spec ไม่ใส่
 * ฝั่ง = ทั้งสองฝั่งทุกรายการ (spec ไม่กำหนดต่อรายการ; ค่ารอจ่ายรถร่วมด้วย — spec/02 §6 appliesTo)
 */
export const DEFAULT_SERVICE_ITEMS: readonly DefaultServiceItem[] = [
  {
    systemKey: 'FREIGHT',
    code: 'FREIGHT',
    nameTh: 'ค่าขนส่ง',
    calcUnit: 'PER_TRIP',
    defaultPrice: null, // ราคาจาก rate card
    vatType: 'EXEMPT_TRANSPORT',
    whtRate: '1.00',
    side: 'BOTH',
    isSurcharge: false,
  },
  {
    systemKey: 'EXTRA_STOP',
    code: 'EXTRA_STOP',
    nameTh: 'ค่าจุดส่งเพิ่ม',
    calcUnit: 'PER_STOP',
    defaultPrice: '300.00',
    vatType: 'EXEMPT_TRANSPORT',
    whtRate: '1.00',
    side: 'BOTH',
    isSurcharge: true,
  },
  {
    systemKey: 'FSC',
    code: 'FSC',
    nameTh: 'ค่าน้ำมันเพิ่ม (fuel surcharge)',
    calcUnit: 'PERCENT_OF_FREIGHT',
    defaultPrice: null, // spec: "ตาราง FSC" — บริษัทตั้ง % และราคาน้ำมันอ้างอิงเอง
    vatType: 'EXEMPT_TRANSPORT',
    whtRate: '1.00',
    side: 'BOTH',
    isSurcharge: true,
  },
  {
    systemKey: 'WAIT',
    code: 'WAIT',
    nameTh: 'ค่ารอ',
    calcUnit: 'PER_HOUR',
    defaultPrice: '200.00',
    condition: 'ฟรี 2 ชม. แรก',
    vatType: 'EXEMPT_TRANSPORT',
    whtRate: '1.00',
    side: 'BOTH',
    isSurcharge: true,
  },
  {
    systemKey: 'LOAD',
    code: 'LOAD',
    nameTh: 'ค่าขึ้นสินค้า',
    calcUnit: 'PER_TRIP',
    defaultPrice: '500.00',
    vatType: 'VAT_7',
    whtRate: '3.00',
    side: 'BOTH',
    isSurcharge: true,
  },
  {
    systemKey: 'UNLOAD',
    code: 'UNLOAD',
    nameTh: 'ค่าลงสินค้า',
    calcUnit: 'PER_TRIP',
    defaultPrice: '500.00',
    vatType: 'VAT_7',
    whtRate: '3.00',
    side: 'BOTH',
    isSurcharge: true,
  },
  {
    systemKey: 'OVERNIGHT',
    code: 'OVERNIGHT',
    nameTh: 'ค่าค้างคืน',
    calcUnit: 'PER_NIGHT',
    defaultPrice: '1000.00',
    vatType: 'EXEMPT_TRANSPORT',
    whtRate: '1.00',
    side: 'BOTH',
    isSurcharge: true,
  },
  {
    systemKey: 'TOLL',
    code: 'TOLL',
    nameTh: 'ค่าผ่านทาง (ตามจริง)',
    calcUnit: 'ACTUAL',
    defaultPrice: null,
    condition: 'เรียกเก็บตามใบเสร็จ',
    vatType: 'EXEMPT_TRANSPORT',
    whtRate: '1.00',
    side: 'BOTH',
    isSurcharge: true,
  },
];

const defaultKey = (systemKey: string) => `service_item:${systemKey}`;
/** เหตุผลใน audit ของแถวที่ระบบสร้าง (ผู้ทำ = ระบบ: actor_id ว่าง) */
const BOOTSTRAP_REASON = 'ค่าเริ่มต้นของระบบ (สร้างบริษัท/อัปเดตค่าเริ่มต้น)';
const ADOPT_REASON = 'รหัสสงวนของระบบ — ใช้แถวเดิมของบริษัทที่มีรหัสเดียวกันเป็นรายการของระบบ';

/**
 * ใส่ค่าบริการเสริมเริ่มต้นให้ tenant — รันซ้ำได้ (bootstrap ขั้น `service-items`, ตอนสร้าง tenant และหลัง migrate)
 * - ทุกรายการที่จัดการแล้วบันทึกใน `tenant_default` (INSERTED / SKIPPED) → ไม่ทำซ้ำอีก (แก้/ลบแล้วไม่สร้างใหม่)
 * - รายการสงวนที่ tenant มีรหัสเดียวกัน (ตรงตัว, ยังไม่ลบ) → ตั้ง system_key ให้แถวนั้น (INSERTED, detail adopted_existing + audit)
 * - ชนรหัส/ชื่ออื่น ๆ ที่ tenant มีอยู่ → ข้าม (SKIPPED) · ไม่ทับค่าที่ tenant แก้แล้ว
 * - แถวที่สร้างลง audit (ผู้ทำ = ระบบ) + domain_event `service_item.created`
 */
export async function ensureDefaultServiceItems(db: Db, tenantId: string): Promise<void> {
  const done = new Set(
    (
      await db.tenantDefault.findMany({
        where: { tenantId, key: { startsWith: 'service_item:' } },
        select: { key: true },
      })
    ).map((r) => r.key),
  );
  for (const d of DEFAULT_SERVICE_ITEMS) {
    const key = defaultKey(d.systemKey);
    if (done.has(key)) continue;
    // รายการสงวน (FREIGHT/EXTRA_STOP/FSC) ที่ tenant มีรหัสเดียวกันอยู่แล้ว (เช่น tenant เก่าสร้างเอง) → "รับเป็นแถวระบบ"
    // (ตั้ง system_key ให้แถวเดิม ไม่แตะค่าอื่น) แทนการข้ามเงียบ ๆ ซึ่งจะทำให้ไม่มีรายการสงวนเลย
    if ((RESERVED_SYSTEM_KEYS as readonly string[]).includes(d.systemKey)) {
      const own = await db.serviceItem.findFirst({
        where: { tenantId, code: d.code, systemKey: null, deletedAt: null },
      });
      if (own) {
        const adopted = await db.serviceItem.update({
          where: { id: own.id },
          data: { systemKey: d.systemKey, version: { increment: 1 } },
        });
        await db.tenantDefault.create({
          data: { tenantId, key, outcome: 'INSERTED', detail: 'adopted_existing' },
        });
        await db.auditLog.create({
          data: {
            tenantId,
            actorId: null,
            action: 'service_item.adopted',
            entityType: 'service_item',
            entityId: own.id,
            before: auditView(own) as Prisma.InputJsonValue,
            after: auditView(adopted) as Prisma.InputJsonValue,
            reason: ADOPT_REASON,
          },
        });
        continue;
      }
    }
    const [created]: (ServiceItem | undefined)[] = await db.serviceItem.createManyAndReturn({
      data: [
        {
          tenantId,
          systemKey: d.systemKey,
          code: d.code,
          nameTh: d.nameTh,
          calcUnit: d.calcUnit,
          unitLabel: CALC_UNIT_LABEL[d.calcUnit],
          defaultPrice: d.defaultPrice,
          conditionText: d.condition ?? null,
          vatType: d.vatType,
          whtRate: d.whtRate,
          side: d.side,
          isSurcharge: d.isSurcharge,
        },
      ],
      skipDuplicates: true, // ชนรหัส/ชื่อที่ tenant สร้างเอง → ไม่สร้าง (บันทึก SKIPPED)
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
        action: 'service_item.created',
        entityType: 'service_item',
        entityId: created.id,
        after: auditView(created) as Prisma.InputJsonValue,
        reason: BOOTSTRAP_REASON,
      },
    });
    await db.domainEvent.create({
      data: {
        tenantId,
        type: 'service_item.created',
        entityType: 'service_item',
        localId: created.id,
        snapshot: JSON.parse(JSON.stringify(toServiceItemDto(created))) as Prisma.InputJsonValue,
        previousAttributes: {},
      },
    });
  }
}
