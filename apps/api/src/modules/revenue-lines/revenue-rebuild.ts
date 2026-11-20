import {
  Prisma,
  type OrderChargeKind,
  type PrismaClient,
  type RevenueLine,
  type VatType,
} from '@prisma/client';
import {
  allocateSatang,
  decimalFromSatang,
  isQtyBasedPricing,
  milliQty,
  satangFromDecimal,
  sumSatang,
} from '@tms/domain';
import type { Tx } from '../../db/db.service';
import { repriceFreightTx } from '../pricing/pricing.service';
import type { ServiceItemSnapshot } from '../service-items/snapshot';

/** advisory lock namespace ของ rebuild ต่อใบสั่ง (กันเลขบรรทัดชนเมื่อหลายงานคิดบรรทัดของใบสั่งเดียวกันพร้อมกัน) */
export const REVENUE_LOCK_NS = 51;

/** สถานะ DO ที่ส่งถึงแล้ว (ยอดส่งจริงรู้แล้ว — ใช้กับ DO ที่ไม่มีบรรทัดสินค้า) */
const DELIVERED = new Set(['DELIVERED', 'POD_PENDING', 'UNBILLED', 'BILLED']);

/** เหตุผลของบรรทัดระบบที่ระบบยกเลิกเอง (≥ 10 ตัวอักษร — CHECK revenue_line_void_check) */
export const REVENUE_VOID_REASON = {
  doCancelled: 'ใบส่งของถูกยกเลิก — บรรทัดรายได้ของใบนี้ยกเลิกตาม',
  movedToDo: 'แบ่งรายได้ลงใบส่งของตามปริมาณ (PO ตัดสิน 19 พ.ย. 2569)',
  notBilled: 'ใบส่งซ้ำของที่ลูกค้าปฏิเสธรับ — ลูกค้าวางบิลตามใบสั่ง คิดเงินที่ใบเดิมแล้ว',
} as const;

/** เนื้อหาของบรรทัดระบบ (ใช้เทียบว่าแหล่งเปลี่ยนหรือไม่) */
interface Desired {
  sourceType: 'SO_CHARGE' | 'DO_SURCHARGE';
  sourceId: string;
  deliveryOrderId: string | null;
  kind: OrderChargeKind;
  serviceItemId: string;
  serviceItemVersion: number | null;
  serviceItemSnapshot: Prisma.JsonValue | null;
  description: string;
  qty: string;
  unitPrice: string;
  amount: string;
  vatType: VatType;
  whtRate: string;
  provisional: boolean;
}

const CONTENT_KEYS = [
  'deliveryOrderId',
  'kind',
  'serviceItemId',
  'serviceItemVersion',
  'description',
  'qty',
  'unitPrice',
  'amount',
  'vatType',
  'whtRate',
  'provisional',
] as const;

function contentOf(l: RevenueLine | Desired): Record<(typeof CONTENT_KEYS)[number], unknown> {
  const dec = (v: unknown, dp: number) =>
    v instanceof Prisma.Decimal ? v.toFixed(dp) : new Prisma.Decimal(String(v)).toFixed(dp);
  return {
    deliveryOrderId: l.deliveryOrderId,
    kind: l.kind,
    serviceItemId: l.serviceItemId,
    serviceItemVersion: l.serviceItemVersion,
    description: l.description,
    qty: dec(l.qty, 4),
    unitPrice: dec(l.unitPrice, 2),
    amount: dec(l.amount, 2),
    vatType: l.vatType,
    whtRate: dec(l.whtRate, 2),
    provisional: l.provisional,
  };
}
const sameContent = (a: RevenueLine, b: Desired) =>
  JSON.stringify(contentOf(a)) === JSON.stringify(contentOf(b));
const key = (t: string, id: string | null, doId: string | null) => `${t}:${id}:${doId ?? '-'}`;

type DoRow = {
  id: string;
  status: string;
  rejectedFromId: string | null;
  lines: {
    salesOrderLineId: string | null;
    qtyPlanned: Prisma.Decimal;
    qtyActual: Prisma.Decimal | null;
  }[];
};
type ChargeRow = Awaited<ReturnType<Tx['salesOrderCharge']['findMany']>>[number];

/**
 * สร้าง/ปรับบรรทัดระบบของใบสั่งให้ตรงกับแหล่ง — idempotent (แหล่งไม่เปลี่ยน = ไม่เขียน) · คืน true เมื่อมีการเปลี่ยนแปลง
 * (ST5-T01; **ST5-T01b ต่อ DO — PO ตัดสิน 19 พ.ย. 2569**: docs/01 §3.3 `revenue_amount` = snapshot × ปริมาณจริงของ DO, วางบิลต่อ DO)
 *
 * - DO ที่คิดเงิน = DO ไม่ยกเลิก (ลูกค้าวางบิลตามใบสั่ง: ไม่นับใบส่งซ้ำของที่ปฏิเสธรับ `rejected_from` — คิดที่ใบเดิมตามแผนแล้ว)
 * - ใบสั่งยังไม่มี DO ที่คิดเงิน → บรรทัด SO_CHARGE ระดับใบสั่ง (ตัวเลขเดียวกับ `sales_order_charge`) `provisional`
 * - มี DO → บรรทัด SO_CHARGE **ต่อ DO** (แหล่ง = บรรทัดราคา + DO):
 *   · ค่าขนส่งตาม rate card สูตรตามจำนวน (ตัน/ลบ.ม./หน่วยนับ): engine เดิม (`repriceFreightTx` — rate card ฉบับเดิม + ราคาต่อหน่วย snapshot)
 *     × ปริมาณของ DO (ลูกค้าวางบิลตามยอดส่งจริง: ยอดส่งจริง — ยังไม่บันทึก = แผน + `provisional`, คืนคลังทั้งใบ = 0 ·
 *     วางบิลตามใบสั่ง: ปริมาณตามแผนของ DO) ปัดครึ่งขึ้นเป็นสตางค์ต่อ DO (MD-114)
 *     ขั้นต่ำของ rate **[OPEN — PO]** ชั่วคราว: เทียบที่ระดับใบสั่ง (รวมทุก DO) ส่วนที่ขาดแบ่งลง DO ตามสัดส่วนยอด (largest remainder)
 *   · บรรทัดอื่น (เหมาเที่ยว/ตามระยะทาง/ราคาที่กำหนดเอง/ค่าจุดเพิ่ม/ค่าบริการเสริมของใบสั่ง) = ยอดเหมาไม่ขึ้นกับยอดส่งจริง
 *     **[OPEN — PO]** ชั่วคราว: แบ่งเท่ากันทุก DO ที่คิดเงิน (largest remainder ตามลำดับสร้าง) — DO เดียว = คัดลอกบรรทัด
 * - DO_SURCHARGE = ค่าใช้จ่ายหน้างาน CONFIRMED ของ DO ที่ไม่ยกเลิก · DO ถูกยกเลิก → บรรทัดระบบของ DO นั้น VOIDED (+ เหตุผล)
 * - บรรทัดที่ล็อก (ออกเลขแล้ว) ไม่ถูกแตะ · DO ที่มีบรรทัด SO_CHARGE ล็อก = ไม่คิดราคาของ DO นั้นใหม่ และยอดที่ออกใบแล้ว
 *   หักออกก่อนแบ่งยอดเหมา/ส่วนที่ขาดถึงขั้นต่ำให้ DO ที่เหลือ (ไม่คิดซ้ำ ไม่ติดลบ) ·
 *   บรรทัด SO_CHARGE ระดับใบสั่งที่ล็อก (ข้อมูลก่อน T01b) = ไม่คิดราคาของใบสั่งใหม่เลย
 * - แหล่งหาย (ราคาใบสั่งคิดใหม่ได้บรรทัดใหม่) → ลบแถวระบบที่ยังไม่ล็อก · ระดับใบสั่ง → DO / DO ไม่คิดเงินแล้ว → VOIDED
 * - ไม่คำนวณภาษี — vat_type/wht_rate คัดลอกจากแหล่ง
 */
export async function rebuildRevenueLines(
  tx: Tx,
  salesOrderId: string,
  actor: string,
  log: (msg: string) => void = () => undefined,
): Promise<boolean> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REVENUE_LOCK_NS}::int, hashtext(${salesOrderId}))`;
  // ST5-T07 review M1: ล็อก DO ของใบสั่งแบบ FOR SHARE (เรียง id — ลำดับเดียวกับ InvoiceBillingGuard ที่ล็อก FOR UPDATE)
  // ดึงเข้าร่างพร้อมกัน → รายหนึ่งรออีกรายจบก่อน: rebuild เห็น billing_status ล่าสุด (แช่แข็ง DO ในร่าง) /
  // การดึงเข้าร่างเห็นบรรทัดรายได้หลัง rebuild — ไม่มีบรรทัดใบที่ยอดไม่ตรง/อ้างบรรทัดที่ถูกลบ
  await tx.$queryRaw`SELECT id FROM delivery_order WHERE sales_order_id = ${salesOrderId}::uuid ORDER BY id FOR SHARE`;
  const so = await tx.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      id: true,
      tenantId: true,
      status: true,
      customer: { select: { billByActualQty: true } },
      lines: { select: { id: true, unitId: true, productId: true } },
    },
  });
  // ใบสั่งที่ยกเลิก: บรรทัดถูก VOIDED ตอนยกเลิก (voidForCancelledOrder) — ไม่สร้าง/ปรับบรรทัดอีก
  if (!so || so.status === 'CANCELLED') return false;
  const basis = so.customer?.billByActualQty ? 'ACTUAL' : 'PLANNED';
  const [all, charges, dos, surcharges] = await Promise.all([
    tx.revenueLine.findMany({ where: { salesOrderId }, orderBy: { lineNo: 'asc' } }),
    tx.salesOrderCharge.findMany({ where: { salesOrderId }, orderBy: { lineNo: 'asc' } }),
    tx.deliveryOrder.findMany({
      where: { salesOrderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        status: true,
        billingStatus: true,
        rejectedFromId: true,
        lines: { select: { salesOrderLineId: true, qtyPlanned: true, qtyActual: true } },
      },
    }),
    tx.doSurcharge.findMany({
      where: {
        status: 'CONFIRMED',
        deliveryOrder: { salesOrderId, status: { not: 'CANCELLED' } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const billable = (d: DoRow) =>
    d.status !== 'CANCELLED' && !(basis === 'PLANNED' && d.rejectedFromId !== null);
  const counted = dos.filter(billable);
  const doById = new Map(dos.map((d) => [d.id, d]));
  /**
   * ยอดยังไม่ยืนยัน: วางบิลตามยอดส่งจริง และ DO ยังไม่บันทึกยอดส่งจริง (หลักฐานส่งบันทึกแล้ว = บรรทัดที่ไม่ส่งยอด = ตามแผน
   * — กติกาเดียวกับ ST4-T10) · คืนคลังทั้งใบ = รู้แล้ว (0) · DO ไม่มีบรรทัดสินค้า = รู้เมื่อส่งถึง
   */
  const provisionalOf = (d: DoRow) => {
    if (basis === 'PLANNED' || d.status === 'RETURNED') return false;
    if (d.lines.length) return d.lines.every((l) => l.qtyActual === null);
    return !DELIVERED.has(d.status);
  };

  // บรรทัดที่ยกเลิก (VOIDED) เป็นประวัติ — ไม่นับในการเทียบแหล่ง แต่นับเลขบรรทัด
  const existing = all.filter((l) => l.status === 'ACTIVE');
  // ST5-T07 "order ใน draft ล็อกราคา" (docs/04 F3/F4 IN_DRAFT "แก้ราคาใน order ไม่ได้ (แก้ที่ draft)"): DO ที่อยู่ในใบแจ้งหนี้ที่ active
  // (IN_DRAFT / INVOICED) = แช่แข็งแบบเดียวกับบรรทัดที่ล็อก — ยอดของ DO นั้นไม่ถูกคิดใหม่ และหักออกก่อนแบ่งให้ DO ที่เหลือ
  const inInvoice = new Set(
    dos
      .filter((d) => d.billingStatus === 'IN_DRAFT' || d.billingStatus === 'INVOICED')
      .map((d) => d.id),
  );
  const isFrozen = (l: RevenueLine) =>
    !!l.lockedAt || (l.deliveryOrderId !== null && inInvoice.has(l.deliveryOrderId));
  const lockedCharges = existing.filter((l) => l.sourceType === 'SO_CHARGE' && isFrozen(l));
  // หลัง finalize ไม่ rebuild ราคา (docs/04 F3): ระดับใบสั่ง (ข้อมูลก่อน T01b) = ทั้งใบ · ต่อ DO = เฉพาะ DO นั้น
  const orderFrozen = lockedCharges.some((l) => l.deliveryOrderId === null && l.lockedAt);
  const frozenDos = new Set(
    lockedCharges.flatMap((l) => (l.deliveryOrderId ? [l.deliveryOrderId] : [])),
  );

  const desired: Desired[] = [];
  const base = (c: ChargeRow) => ({
    sourceType: 'SO_CHARGE' as const,
    sourceId: c.id,
    kind: c.kind,
    serviceItemId: c.serviceItemId,
    serviceItemVersion: c.serviceItemVersion,
    serviceItemSnapshot: c.serviceItemSnapshot,
    description: c.description,
    vatType: c.vatType,
    whtRate: c.whtRate.toFixed(2),
  });
  if (!orderFrozen) {
    if (counted.length === 0) {
      for (const c of charges)
        desired.push({
          ...base(c),
          deliveryOrderId: null,
          qty: c.qty.toFixed(4),
          unitPrice: c.unitPrice.toFixed(2),
          amount: c.amount.toFixed(2),
          provisional: true,
        });
    } else {
      // DO ที่ยังคิดใหม่ได้ (ไม่มีบรรทัด SO_CHARGE ล็อก) — ยอดของ DO ที่ล็อกแล้วหักออกก่อนแบ่ง (review H1: ไม่คิดซ้ำ/ไม่ขาด)
      const open = counted.filter((d) => !frozenDos.has(d.id));
      const chargeIds = new Set(charges.map((c) => c.id));
      /** ยอดที่ออกใบไปแล้วของบรรทัดราคานี้ (แหล่งเดียวกัน หรือแหล่งเดิมที่ถูกคิดราคาใหม่ — รายการบริการ/ชนิดเดียวกัน) */
      const lockedOf = (c: ChargeRow) =>
        sumSatang(
          lockedCharges
            .filter(
              (l) =>
                l.sourceId === c.id ||
                (!chargeIds.has(l.sourceId ?? '') &&
                  l.kind === c.kind &&
                  l.serviceItemId === c.serviceItemId),
            )
            .map((l) => satangFromDecimal(l.amount.toFixed(2))),
        );
      for (const c of charges) {
        if (!open.length) break;
        const locked = lockedOf(c);
        const q = await qtyBasedPerDo(tx, c, open, so.lines, basis, locked, log);
        // คิดต่อ DO ไม่ได้ (ข้อมูลหลักผิด) → ยอดเหมาชั่วคราว + provisional (ห้ามถือเป็นยอดสุดท้าย — review M1)
        const failed = q === 'FAILED';
        const perDo = q && q !== 'FAILED' ? q : lumpPerDo(c, open, locked);
        for (const [i, d] of open.entries())
          desired.push({
            ...base(c),
            deliveryOrderId: d.id,
            ...perDo[i]!,
            provisional: failed || provisionalOf(d),
          });
      }
    }
  }
  for (const s of surcharges)
    desired.push({
      sourceType: 'DO_SURCHARGE',
      sourceId: s.id,
      deliveryOrderId: s.deliveryOrderId,
      kind: 'ACCESSORIAL',
      serviceItemId: s.serviceItemId,
      serviceItemVersion: s.serviceItemVersion,
      serviceItemSnapshot: s.serviceItemSnapshot,
      description: s.description,
      qty: s.qty.toFixed(4),
      unitPrice: s.unitPrice.toFixed(2),
      amount: s.amount.toFixed(2),
      vatType: s.vatType,
      whtRate: s.whtRate.toFixed(2),
      provisional: false,
    });

  const want = new Map(desired.map((d) => [key(d.sourceType, d.sourceId, d.deliveryOrderId), d]));
  let changed = false;
  // บรรทัดระบบที่ไม่ตรงแหล่งแล้ว (ยังไม่ล็อก) — DO ไม่คิดเงินแล้ว / ระดับใบสั่งย้ายลง DO → VOIDED · แหล่งหาย → ลบ
  const stale = existing.filter(
    (l) =>
      !l.isUserAdded &&
      !isFrozen(l) &&
      !want.has(key(l.sourceType, l.sourceId, l.deliveryOrderId)) &&
      !(l.sourceType === 'SO_CHARGE' && (orderFrozen || frozenDos.has(l.deliveryOrderId ?? ''))),
  );
  const voidReason = (l: RevenueLine): string | null => {
    if (l.deliveryOrderId) {
      const d = doById.get(l.deliveryOrderId);
      if (!d || d.status === 'CANCELLED') return REVENUE_VOID_REASON.doCancelled;
      if (!billable(d)) return REVENUE_VOID_REASON.notBilled;
      return null;
    }
    return l.sourceType === 'SO_CHARGE' && counted.length > 0
      ? REVENUE_VOID_REASON.movedToDo
      : null;
  };
  const toDelete: string[] = [];
  for (const l of stale) {
    const reason = voidReason(l);
    if (!reason) {
      toDelete.push(l.id);
      continue;
    }
    await tx.revenueLine.update({
      where: { id: l.id },
      data: {
        status: 'VOIDED',
        voidedAt: new Date(),
        voidedBy: actor,
        voidReason: reason,
        version: { increment: 1 },
      },
    });
  }
  if (toDelete.length) await tx.revenueLine.deleteMany({ where: { id: { in: toDelete } } });
  if (stale.length) changed = true;

  const staleIds = new Set(stale.map((l) => l.id));
  const have = new Map(
    existing
      .filter((l) => !staleIds.has(l.id) && !l.isUserAdded)
      .map((l) => [key(l.sourceType, l.sourceId, l.deliveryOrderId), l]),
  );
  let next = all.reduce((m, l) => Math.max(m, l.lineNo), 0);
  for (const d of desired) {
    const cur = have.get(key(d.sourceType, d.sourceId, d.deliveryOrderId));
    const data = {
      deliveryOrderId: d.deliveryOrderId,
      kind: d.kind,
      serviceItemId: d.serviceItemId,
      serviceItemVersion: d.serviceItemVersion,
      serviceItemSnapshot: (d.serviceItemSnapshot ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      description: d.description,
      qty: d.qty,
      unitPrice: d.unitPrice,
      amount: d.amount,
      vatType: d.vatType,
      whtRate: d.whtRate,
      provisional: d.provisional,
    };
    if (cur) {
      if (isFrozen(cur) || sameContent(cur, d)) continue;
      // แหล่ง/ปริมาณเปลี่ยน (ยอดส่งจริง, แยก/รวม DO, ราคาที่กำหนดเองเปลี่ยน) → ปรับบรรทัดเดิม
      await tx.revenueLine.update({
        where: { id: cur.id },
        data: { ...data, version: { increment: 1 } },
      });
      changed = true;
      continue;
    }
    await tx.revenueLine.create({
      data: {
        ...data,
        tenantId: so.tenantId,
        salesOrderId,
        lineNo: ++next,
        sourceType: d.sourceType,
        sourceId: d.sourceId,
        isUserAdded: false,
      },
    });
    changed = true;
  }
  return changed;
}

type PerDo = { qty: string; unitPrice: string; amount: string };

/**
 * ยอดเหมา (ไม่ขึ้นกับปริมาณสินค้า) แบ่งเท่ากันทุก DO ที่ยังคิดใหม่ได้ **[OPEN — PO]** — ยอดที่แบ่ง = ยอดของใบสั่ง − ยอดที่ออกใบแล้ว
 * (`locked`; ไม่ต่ำกว่า 0) · DO เดียวและยังไม่มีส่วนที่ออกใบ = คัดลอกจำนวน/ราคาเดิม · อื่น ๆ = จำนวน 1 × ส่วนแบ่ง
 */
function lumpPerDo(c: ChargeRow, open: readonly DoRow[], locked: bigint): PerDo[] {
  if (open.length === 1 && locked === 0n)
    return [
      { qty: c.qty.toFixed(4), unitPrice: c.unitPrice.toFixed(2), amount: c.amount.toFixed(2) },
    ];
  const rest = satangFromDecimal(c.amount.toFixed(2)) - locked;
  return allocateSatang(
    rest > 0n ? rest : 0n,
    open.map(() => 1n),
  ).map((s) => ({ qty: '1', unitPrice: decimalFromSatang(s), amount: decimalFromSatang(s) }));
}

/**
 * ค่าขนส่งสูตรตามจำนวน ต่อ DO (ที่ยังคิดใหม่ได้): ราคา snapshot × ปริมาณของ DO ผ่าน engine เดิม (ปัดต่อ DO) +
 * ส่วนที่ขาดถึงขั้นต่ำของใบสั่ง (หักยอดที่ออกใบแล้ว `locked`) · null = ไม่ใช่สูตรตามจำนวน · 'FAILED' = คิดไม่ได้
 */
async function qtyBasedPerDo(
  tx: Tx,
  c: ChargeRow,
  counted: readonly DoRow[],
  soLines: readonly { id: string; unitId: string | null; productId: string | null }[],
  basis: 'ACTUAL' | 'PLANNED',
  locked: bigint,
  log: (msg: string) => void,
): Promise<PerDo[] | 'FAILED' | null> {
  if (c.kind !== 'FREIGHT' || c.origin !== 'RATE_CARD' || !c.rateCardId) return null;
  const rc = await tx.rateCard.findUnique({
    where: { id: c.rateCardId },
    select: { pricingModel: true, minCharge: true },
  });
  if (!rc || !isQtyBasedPricing(rc.pricingModel)) return null;
  const soLine = new Map(soLines.map((l) => [l.id, l]));
  const rows: { qty: string; calc: bigint; hasQty: boolean }[] = [];
  for (const d of counted) {
    const quantities = d.lines.flatMap((l) => {
      const s = l.salesOrderLineId ? soLine.get(l.salesOrderLineId) : undefined;
      if (!s?.unitId) return [];
      const q =
        basis === 'PLANNED'
          ? l.qtyPlanned
          : d.status === 'RETURNED'
            ? new Prisma.Decimal(0)
            : (l.qtyActual ?? l.qtyPlanned);
      return [{ qty: q.toFixed(), unitId: s.unitId, productId: s.productId }];
    });
    if (!quantities.some((q) => (milliQty(q.qty) ?? 0n) > 0n)) {
      rows.push({ qty: '0', calc: 0n, hasQty: false });
      continue;
    }
    let r: Awaited<ReturnType<typeof repriceFreightTx>>;
    try {
      r = await repriceFreightTx(tx, {
        rateCardId: c.rateCardId,
        unitPrice: c.unitPrice.toFixed(2),
        serviceItem: c.serviceItemSnapshot as unknown as ServiceItemSnapshot,
        quantities,
      });
    } catch (e) {
      log(`charge ${c.id}: per-DO reprice failed — ${(e as Error).message}`);
      return 'FAILED';
    }
    const line = r.lines.find((x) => x.kind === 'FREIGHT');
    if (r.pricingStatus !== 'AVAILABLE' || !line) {
      log(
        `charge ${c.id}: per-DO reprice ${r.pricingStatus} ${r.reasons.map((x) => x.code).join(',')}`,
      );
      return 'FAILED';
    }
    rows.push({ qty: line.qty, calc: satangFromDecimal(line.calculatedAmount), hasQty: true });
  }
  // ขั้นต่ำ (ระดับใบสั่ง — [OPEN — PO]): ยอดที่ออกใบแล้ว + รวม DO ที่คิดใหม่ได้ ต่ำกว่าขั้นต่ำ → ส่วนที่ขาดแบ่งลง DO
  // ที่คิดใหม่ได้และมีปริมาณ ตามสัดส่วนยอด · ส่งได้ 0 ทุกใบ (คืนคลังทั้งหมด) = ไม่คิดขั้นต่ำ (กติกาเดิมของ ST4-T11)
  const min = rc.minCharge ? satangFromDecimal(rc.minCharge.toFixed(2)) : null;
  const total = locked + sumSatang(rows.map((x) => x.calc));
  const topUp = new Array<bigint>(rows.length).fill(0n);
  if (min !== null && rows.some((x) => x.hasQty) && total < min) {
    const idx = rows.flatMap((x, i) => (x.hasQty ? [i] : []));
    const parts = allocateSatang(
      min - total,
      idx.map((i) => rows[i]!.calc),
    );
    idx.forEach((i, k) => (topUp[i] = parts[k]!));
  }
  return rows.map((x, i) => ({
    qty: x.qty,
    unitPrice: c.unitPrice.toFixed(2),
    amount: decimalFromSatang(x.calc + topUp[i]!),
  }));
}

/**
 * ยอดรายได้ต่อ DO (ST5-T01b — docs/01 §3.3 `revenue_amount`; งานปันต้นทุนตามสัดส่วนรายได้อ่านค่านี้) =
 * ผลรวมบรรทัดรายได้ที่ยังใช้ (ACTIVE) ที่ผูก DO (ราคาของใบสั่งที่แบ่งลง + ค่าใช้จ่ายหน้างาน + บรรทัดที่คนเพิ่มผูก DO)
 * `provisional` = มีบรรทัดที่ยอดยังไม่ยืนยัน · DO ที่ไม่มีบรรทัด = ไม่อยู่ใน map
 */
export async function revenueTotalsByDeliveryOrder(
  tx: Tx,
  deliveryOrderIds: readonly string[],
): Promise<Map<string, { amount: string; provisional: boolean; lines: number }>> {
  const out = new Map<string, { amount: string; provisional: boolean; lines: number }>();
  if (!deliveryOrderIds.length) return out;
  const rows = await tx.revenueLine.groupBy({
    by: ['deliveryOrderId', 'provisional'],
    where: { deliveryOrderId: { in: [...deliveryOrderIds] }, status: 'ACTIVE' },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const acc = new Map<string, { amount: bigint; provisional: boolean; lines: number }>();
  for (const r of rows) {
    const k = r.deliveryOrderId!;
    const cur = acc.get(k) ?? { amount: 0n, provisional: false, lines: 0 };
    cur.amount += satangFromDecimal((r._sum.amount ?? new Prisma.Decimal(0)).toFixed(2));
    cur.provisional ||= r.provisional;
    cur.lines += r._count._all;
    acc.set(k, cur);
  }
  for (const [k, v] of acc)
    out.set(k, { amount: decimalFromSatang(v.amount), provisional: v.provisional, lines: v.lines });
  return out;
}

/**
 * Backfill หลัง migrate (ST5-T01b — ข้อมูลก่อน migration 0117; เรียกจาก `bootstrapAllTenants` หลังขั้น bootstrap ของ tenant):
 * ใบสั่งที่มีบรรทัด SO_CHARGE ระดับใบสั่ง (ยังใช้ ไม่ล็อก) แต่มี DO ที่ไม่ยกเลิกแล้ว หรือมีบรรทัดระบบผูก DO ที่ยกเลิกแล้ว
 * → คิดบรรทัดใหม่ต่อ DO (ระดับใบสั่ง VOIDED + เหตุผล) · บรรทัดที่คนเพิ่ม/ที่ล็อกไม่แตะ
 * **ทีละใบสั่ง transaction สั้น** (review M2) — ใบที่ทำแล้ว commit ทันที, รันซ้ำทำต่อเฉพาะที่ค้าง (resumable),
 * ใบที่ล้มบันทึกไว้ใน `failed` ไม่ทำให้ใบอื่น/การ migrate หยุด · `db` = client platform (BYPASSRLS)
 */
export async function backfillRevenueLinesPerDo(
  db: PrismaClient,
  tenantId: string,
  timeoutMs = 30_000,
): Promise<{ done: number; failed: { salesOrderId: string; error: string }[] }> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT l.sales_order_id::text AS id
      FROM revenue_line l
      JOIN sales_order s ON s.id = l.sales_order_id AND s.status <> 'CANCELLED'
     WHERE l.tenant_id = ${tenantId}::uuid AND l.status = 'ACTIVE' AND l.locked_at IS NULL AND NOT l.is_user_added
       AND (
         (l.source_type = 'SO_CHARGE' AND l.delivery_order_id IS NULL AND EXISTS (
            SELECT 1 FROM delivery_order d WHERE d.sales_order_id = l.sales_order_id AND d.status <> 'CANCELLED'))
         OR EXISTS (SELECT 1 FROM delivery_order d WHERE d.id = l.delivery_order_id AND d.status = 'CANCELLED'))
     ORDER BY 1`;
  const failed: { salesOrderId: string; error: string }[] = [];
  let done = 0;
  for (const r of rows) {
    try {
      await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await rebuildRevenueLines(tx as unknown as Tx, r.id, 'system:backfill');
        },
        { timeout: timeoutMs },
      );
      done += 1;
    } catch (e) {
      failed.push({ salesOrderId: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { done, failed };
}
