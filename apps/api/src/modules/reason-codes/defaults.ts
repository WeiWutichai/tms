import { Prisma, type PrismaClient, type ReasonCode } from '@prisma/client';
import { iEquals } from '../../common/ilike';
import {
  AUTO_RESCHEDULE_CATEGORIES,
  TRACKING_CATEGORIES,
  type ReasonCategoryApi,
} from './reason-code.dto';
import { OTHER_CODE, OTHER_SORT_ORDER, auditView, toReasonCodeDto } from './reason-codes.service';

type Db = PrismaClient | Prisma.TransactionClient;

interface DefaultReason {
  category: ReasonCategoryApi;
  code: string;
  labelTh: string;
  /** รหัสที่ state machine/งานอัตโนมัติใช้ หรือ "อื่น ๆ" — ลบ/ปิดใช้/เปลี่ยนรหัสไม่ได้ */
  system?: boolean;
  photo?: boolean;
  note?: boolean;
  reschedule?: boolean;
  tracking?: boolean;
}

/** "อื่น ๆ" ของหมวด — แสดงบน tracking ในหมวดหน้างานทุกหมวด (สม่ำเสมอ — review ST2-T12) */
const other = (category: ReasonCategoryApi): DefaultReason => ({
  category,
  code: OTHER_CODE,
  labelTh: 'อื่น ๆ',
  system: true,
  note: true,
  tracking: TRACKING_CATEGORIES.includes(category),
});

/**
 * ชุดเหตุผลภาษาไทยเริ่มต้นของ tenant ใหม่ (ST2-T12; docs/04 A5 "reason master — ใช้ได้ทันทีไม่ต้องตั้ง", B Reason master)
 * ครบทุกหมวดของ docs/04 B (ค้างวางแผน/ส่งไม่สำเร็จ/ปฏิเสธรับ/ไม่เซ็นเอกสาร/ล่าช้า/dispute) + ยกเลิก (ต้นแบบ) + ยกเว้นกฎ (docs/01 §3.2)
 * - ใบค้าง (ORDER_HOLD): 12 รหัสของ docs/04 C เป็นรหัสระบบ (plan/11 ข้อ 4 — ROUTE_PENDING → LOCATION_UNMAPPED/RATE_MISSING,
 *   NO_VEHICLE → UNALLOCATED_NO_VEHICLE) — ระบบ/connector ตั้งเอง ST3-T07 ใช้ทำ badge + action เคลียร์
 * - ส่งไม่สำเร็จ/ตีกลับ/ยกเลิก: ข้อความและธงตามต้นแบบ TMS v4 (reasons) + spec/02 §9 ตัวอย่าง (ที่อยู่ผิด สินค้าเสียหาย ผู้รับปฏิเสธ)
 * - ไม่เซ็นเอกสาร/ล่าช้า/ข้อโต้แย้ง/ยกเว้นกฎ: [PROPOSED] ต้นแบบไม่มี — spec/02 §9 (override) + docs/04 E2 (เหตุล่าช้า รอคิว ฯลฯ)
 * - ทุกหมวดมี "อื่น ๆ" บังคับโน้ต (MD-221)
 * แก้/ปิด/ลบได้ต่อ tenant (ยกเว้นรหัสระบบ) — ลำดับ = ลำดับในรายการนี้
 */
export const DEFAULT_REASONS: readonly DefaultReason[] = [
  // ค้างวางแผน — docs/04 C (12 รหัส, ระบบ)
  {
    category: 'ORDER_HOLD',
    code: 'CUSTOMER_UNMAPPED',
    labelTh: 'ยังไม่ได้จับคู่ลูกค้า',
    system: true,
  },
  {
    category: 'ORDER_HOLD',
    code: 'LOCATION_UNMAPPED',
    labelTh: 'ยังไม่ได้จับคู่สถานที่รับ/ส่ง',
    system: true,
  },
  {
    category: 'ORDER_HOLD',
    code: 'GEOCODING_ERROR',
    labelTh: 'หาพิกัดสถานที่ไม่ได้',
    system: true,
  },
  {
    category: 'ORDER_HOLD',
    code: 'RATE_MISSING',
    labelTh: 'ยังไม่มีราคาขาย (rate card)',
    system: true,
  },
  { category: 'ORDER_HOLD', code: 'UNALLOCATED_NO_VEHICLE', labelTh: 'ไม่มีรถว่าง', system: true },
  { category: 'ORDER_HOLD', code: 'CAPACITY_EXCEEDED', labelTh: 'เกินความจุรถ', system: true },
  {
    category: 'ORDER_HOLD',
    code: 'VEHICLE_TYPE_INCOMPATIBLE',
    labelTh: 'ประเภทรถไม่ตรงกับงาน',
    system: true,
  },
  { category: 'ORDER_HOLD', code: 'CARRIER_REJECTED', labelTh: 'รถร่วมปฏิเสธงาน', system: true },
  {
    category: 'ORDER_HOLD',
    code: 'DELIVERY_WINDOW_EXHAUSTED',
    labelTh: 'หลุดช่วงเวลาส่ง',
    system: true,
  },
  {
    category: 'ORDER_HOLD',
    code: 'RESCHEDULES_EXHAUSTED',
    labelTh: 'นัดส่งใหม่ครบจำนวนครั้งแล้ว',
    system: true,
  },
  {
    category: 'ORDER_HOLD',
    code: 'SOURCE_CHANGED_AFTER_PLAN',
    labelTh: 'ต้นทางแก้ข้อมูลหลังวางแผน',
    system: true,
  },
  {
    category: 'ORDER_HOLD',
    code: 'SOURCE_ERROR',
    labelTh: 'ข้อมูลจากต้นทางไม่ครบหรือผิดรูปแบบ',
    system: true,
  },
  other('ORDER_HOLD'),
  // ส่งไม่สำเร็จ — ต้นแบบ (ลูกค้าปิดทำการ/ไม่พบผู้รับ/รถเสียระหว่างทาง) + spec/02 §9
  {
    category: 'DELIVERY_FAILED',
    code: 'SHOP_CLOSED',
    labelTh: 'ลูกค้าปิดทำการ',
    note: true,
    reschedule: true,
    tracking: true,
  },
  {
    category: 'DELIVERY_FAILED',
    code: 'NO_RECEIVER',
    labelTh: 'ไม่พบผู้รับ',
    photo: true,
    note: true,
    reschedule: true,
    tracking: true,
  },
  {
    category: 'DELIVERY_FAILED',
    code: 'VEHICLE_BREAKDOWN',
    labelTh: 'รถเสียระหว่างทาง',
    note: true,
    reschedule: true,
    tracking: true,
  },
  {
    category: 'DELIVERY_FAILED',
    code: 'WRONG_ADDRESS',
    labelTh: 'ที่อยู่ผิด',
    photo: true,
    note: true,
    tracking: true,
  },
  {
    category: 'DELIVERY_FAILED',
    code: 'RECEIVER_REFUSED',
    labelTh: 'ผู้รับปฏิเสธรับสินค้า',
    photo: true,
    note: true,
    tracking: true,
  },
  other('DELIVERY_FAILED'),
  // ตีกลับ (ปฏิเสธรับ) — ต้นแบบ
  {
    category: 'REJECTED_BY_RECEIVER',
    code: 'DAMAGED',
    labelTh: 'สินค้าเสียหายระหว่างขนส่ง',
    photo: true,
    tracking: true,
  },
  {
    category: 'REJECTED_BY_RECEIVER',
    code: 'PARTIAL_REFUSED',
    labelTh: 'ลูกค้าปฏิเสธรับบางรายการ',
    photo: true,
    note: true,
    tracking: true,
  },
  {
    category: 'REJECTED_BY_RECEIVER',
    code: 'WRONG_ITEM',
    labelTh: 'สินค้าไม่ตรงใบสั่ง',
    photo: true,
    note: true,
    tracking: true,
  },
  {
    category: 'REJECTED_BY_RECEIVER',
    code: 'SHORT_QTY',
    labelTh: 'จำนวนไม่ครบ',
    photo: true,
    tracking: true,
  },
  other('REJECTED_BY_RECEIVER'),
  // ไม่เซ็นเอกสาร
  { category: 'POD_MISSING', code: 'NO_SIGNER', labelTh: 'ไม่มีผู้มีอำนาจเซ็นรับ', photo: true },
  {
    category: 'POD_MISSING',
    code: 'REFUSED_TO_SIGN',
    labelTh: 'ผู้รับไม่ยอมเซ็นเอกสาร',
    photo: true,
    note: true,
  },
  { category: 'POD_MISSING', code: 'NO_STAMP', labelTh: 'ไม่มีตราประทับบริษัท', photo: true },
  { category: 'POD_MISSING', code: 'DOC_DAMAGED', labelTh: 'เอกสารสูญหายหรือชำรุด', note: true },
  other('POD_MISSING'),
  // ล่าช้า
  { category: 'DELAY', code: 'TRAFFIC', labelTh: 'การจราจรติดขัด', tracking: true },
  { category: 'DELAY', code: 'LOADING_QUEUE', labelTh: 'รอคิวขึ้น/ลงสินค้านาน', tracking: true },
  { category: 'DELAY', code: 'BREAKDOWN', labelTh: 'รถเสีย', note: true, tracking: true },
  { category: 'DELAY', code: 'WEATHER', labelTh: 'สภาพอากาศหรือภัยธรรมชาติ', tracking: true },
  {
    category: 'DELAY',
    code: 'CUSTOMER_REQUEST',
    labelTh: 'ลูกค้าขอเลื่อนเวลา',
    note: true,
    tracking: true,
  },
  other('DELAY'),
  // ข้อโต้แย้ง (dispute ค่าขนส่ง/settlement รถร่วม)
  {
    category: 'SETTLEMENT_DISPUTE',
    code: 'PRICE_MISMATCH',
    labelTh: 'ราคาไม่ตรงที่ตกลง',
    note: true,
  },
  {
    category: 'SETTLEMENT_DISPUTE',
    code: 'TRIP_MISSING',
    labelTh: 'จำนวนเที่ยวไม่ครบ',
    note: true,
  },
  {
    category: 'SETTLEMENT_DISPUTE',
    code: 'SURCHARGE_WRONG',
    labelTh: 'ค่าใช้จ่ายเพิ่มไม่ถูกต้อง',
    note: true,
  },
  {
    category: 'SETTLEMENT_DISPUTE',
    code: 'DEDUCTION_WRONG',
    labelTh: 'รายการหักไม่ถูกต้อง',
    note: true,
  },
  other('SETTLEMENT_DISPUTE'),
  // ยกเลิก — ต้นแบบ (ลูกค้ายกเลิกคำสั่ง) + spec/02 §9 so_cancel
  { category: 'CANCEL', code: 'CUSTOMER_CANCELLED', labelTh: 'ลูกค้ายกเลิกคำสั่ง', note: true },
  { category: 'CANCEL', code: 'DUPLICATE', labelTh: 'สร้างซ้ำ' },
  { category: 'CANCEL', code: 'POSTPONED', labelTh: 'เลื่อนไม่มีกำหนด' },
  { category: 'CANCEL', code: 'PRICE_NOT_AGREED', labelTh: 'ราคาไม่ตกลง' },
  other('CANCEL'),
  // ยกเว้นกฎ — spec/02 §9 dispatch_override
  { category: 'OVERRIDE', code: 'CUSTOMER_EMERGENCY', labelTh: 'ฉุกเฉินของลูกค้า', note: true },
  {
    category: 'OVERRIDE',
    code: 'DOC_RENEWED_PENDING_SCAN',
    labelTh: 'ต่ออายุเอกสารแล้ว รอสแกน',
    note: true,
  },
  other('OVERRIDE'),
];

export const reasonSystemKey = (d: { category: string; code: string }) => `${d.category}:${d.code}`;
const defaultKey = (d: { category: string; code: string }) => `reason_code:${reasonSystemKey(d)}`;
/** เหตุผลใน audit ของแถวที่ระบบสร้าง (ผู้ทำ = ระบบ: actor_id ว่าง) */
const BOOTSTRAP_REASON = 'ค่าเริ่มต้นของระบบ (สร้างบริษัท/อัปเดตค่าเริ่มต้น)';
const ADOPT_REASON =
  'รหัสของระบบ — ใช้แถวเดิมของบริษัท (หมวด + รหัสหรือข้อความเดียวกัน) เป็นรหัสของระบบ';
const sortOf = (d: DefaultReason, i: number) =>
  d.system && d.code === OTHER_CODE ? OTHER_SORT_ORDER : (i + 1) * 10;

/** ธงที่หมวดไม่อนุญาต → false (แถวเดิมของ tenant ที่ถูกรับเป็นของระบบ — กันชน CHECK/กฎ API) */
function allowedFlags(
  category: ReasonCategoryApi,
  r: Pick<ReasonCode, 'autoReschedule' | 'showOnTracking'>,
) {
  return {
    autoReschedule: r.autoReschedule && AUTO_RESCHEDULE_CATEGORIES.includes(category),
    showOnTracking: r.showOnTracking && TRACKING_CATEGORIES.includes(category),
  };
}

/**
 * รหัสระบบต้องมีเสมอ (state machine/งานอัตโนมัติใช้) — หาแถวเดิมของ tenant ที่รับเป็นของระบบได้ (review ST2-T12):
 * 1) หมวด + รหัสเดียวกัน (รวมที่ลบแล้ว — unique ของรหัสนับแถวที่ลบ) → คืนชีพ (ล้าง deleted_at) + ใช้งาน
 * 2) หมวด + ข้อความเดียวกัน (ไม่สนตัวพิมพ์, ยังไม่ลบ) รหัสอื่น → เปลี่ยนรหัสเป็นรหัสระบบ
 * ข้อความชนกับแถวอื่นตอนคืนชีพ → ต่อท้ายข้อความด้วยรหัส
 */
async function adoptForSystem(
  db: Db,
  tenantId: string,
  d: DefaultReason,
  sortOrder: number,
): Promise<{ before: ReasonCode; after: ReasonCode; how: string } | null> {
  const sameCode = await db.reasonCode.findFirst({
    where: { tenantId, category: d.category, code: d.code, systemKey: null },
  });
  const sameLabel = sameCode
    ? null
    : await db.reasonCode.findFirst({
        where: {
          tenantId,
          category: d.category,
          systemKey: null,
          deletedAt: null,
          labelTh: iEquals(d.labelTh),
        },
      });
  const own = sameCode ?? sameLabel;
  if (!own) return null;
  let labelTh = own.labelTh;
  if (own.deletedAt) {
    const clash = await db.reasonCode.findFirst({
      where: {
        tenantId,
        category: d.category,
        deletedAt: null,
        id: { not: own.id },
        labelTh: iEquals(own.labelTh),
      },
      select: { id: true },
    });
    if (clash) labelTh = `${own.labelTh} (${d.code})`;
  }
  const after = await db.reasonCode.update({
    where: { id: own.id },
    data: {
      code: d.code,
      labelTh,
      systemKey: reasonSystemKey(d),
      isSystem: true,
      status: 'ACTIVE',
      deletedAt: null,
      ...(own.deletedAt ? { externalId: null } : {}),
      ...allowedFlags(d.category, own),
      ...(d.code === OTHER_CODE ? { requiresNote: true, sortOrder } : {}),
      version: { increment: 1 },
    },
  });
  return {
    before: own,
    after,
    how: sameCode
      ? own.deletedAt
        ? 'adopted_deleted_same_code'
        : 'adopted_existing'
      : 'adopted_same_label',
  };
}

/**
 * ใส่เหตุผลเริ่มต้นให้ tenant — รันซ้ำได้ (bootstrap ขั้น `reason-codes`, ตอนสร้าง tenant และหลัง migrate)
 * - ทุกรายการที่จัดการแล้วบันทึกใน `tenant_default` (INSERTED / SKIPPED) → ไม่ทำซ้ำอีก (แก้/ลบแล้วไม่สร้างใหม่)
 * - รหัสระบบ: รับแถวเดิมของ tenant ก่อน (adoptForSystem) ไม่งั้นสร้างใหม่ — **ไม่มีทาง SKIPPED**: สร้างไม่ได้ = throw
 *   (bootstrap ล้มดัง ๆ แทนการขาดรหัสที่งานอัตโนมัติต้องใช้)
 * - รายการทั่วไปที่ชนรหัส/ข้อความที่ tenant มีอยู่ → ข้าม (SKIPPED) · ไม่ทับค่าที่ tenant แก้แล้ว
 * - แถวที่สร้างลง audit (ผู้ทำ = ระบบ) + domain_event `reason_code.created`
 */
export async function ensureDefaultReasonCodes(db: Db, tenantId: string): Promise<void> {
  const done = new Set(
    (
      await db.tenantDefault.findMany({
        where: { tenantId, key: { startsWith: 'reason_code:' } },
        select: { key: true },
      })
    ).map((r) => r.key),
  );
  for (const [i, d] of DEFAULT_REASONS.entries()) {
    const key = defaultKey(d);
    if (done.has(key)) continue;
    const systemKey = reasonSystemKey(d);
    const sortOrder = sortOf(d, i);
    if (d.system) {
      const adopted = await adoptForSystem(db, tenantId, d, sortOrder);
      if (adopted) {
        await db.tenantDefault.create({
          data: { tenantId, key, outcome: 'INSERTED', detail: adopted.how },
        });
        await db.auditLog.create({
          data: {
            tenantId,
            actorId: null,
            action: 'reason_code.adopted',
            entityType: 'reason_code',
            entityId: adopted.after.id,
            before: auditView(adopted.before) as Prisma.InputJsonValue,
            after: auditView(adopted.after) as Prisma.InputJsonValue,
            reason: ADOPT_REASON,
          },
        });
        continue;
      }
    }
    const [created]: (ReasonCode | undefined)[] = await db.reasonCode.createManyAndReturn({
      data: [
        {
          tenantId,
          category: d.category,
          code: d.code,
          labelTh: d.labelTh,
          requiresPhoto: d.photo ?? false,
          requiresNote: d.note ?? false,
          autoReschedule: d.reschedule ?? false,
          showOnTracking: d.tracking ?? false,
          isSystem: d.system ?? false,
          systemKey,
          sortOrder,
        },
      ],
      skipDuplicates: true, // รายการทั่วไปที่ชนรหัส/ข้อความที่ tenant สร้างเอง → ไม่สร้าง (บันทึก SKIPPED)
    });
    if (!created && d.system)
      throw new Error(
        `reason-codes bootstrap: system reason ${systemKey} could not be created or adopted for tenant ${tenantId}`,
      );
    await db.tenantDefault.create({
      data: {
        tenantId,
        key,
        outcome: created ? 'INSERTED' : 'SKIPPED',
        detail: created ? null : 'code_or_label_taken',
      },
    });
    if (!created) continue;
    await db.auditLog.create({
      data: {
        tenantId,
        actorId: null,
        action: 'reason_code.created',
        entityType: 'reason_code',
        entityId: created.id,
        after: auditView(created) as Prisma.InputJsonValue,
        reason: BOOTSTRAP_REASON,
      },
    });
    await db.domainEvent.create({
      data: {
        tenantId,
        type: 'reason_code.created',
        entityType: 'reason_code',
        localId: created.id,
        snapshot: JSON.parse(JSON.stringify(toReasonCodeDto(created))) as Prisma.InputJsonValue,
        previousAttributes: {},
      },
    });
  }
}
