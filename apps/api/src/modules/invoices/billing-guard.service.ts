import { Injectable } from '@nestjs/common';
import { Prisma, type InvoiceLine, type VatType } from '@prisma/client';
import { BILLABLE_DO_STATUSES, isBillable, type InvoiceStatus } from '@tms/domain';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { DeliveryOrderService, type BillingDoRow } from '../delivery-orders/delivery-order.service';

/**
 * บรรทัดค่าขนส่งของ DO ที่จะเพิ่มลงร่าง (เนื้อหาบรรทัด/ราคา/ภาษีมาจากผู้เรียก — ST5-T07 สร้างจากบรรทัดรายได้)
 * บรรทัดค่าใช้จ่ายหน้างาน (`do_surcharge_id`) / บรรทัดรวม (Group/Merge) = ST5-T07 [OPEN spec/12 §3] — ไม่ผ่าน attach
 */
export interface DoInvoiceLineInput {
  deliveryOrderId: string;
  serviceItemId: string;
  description: string;
  quantity: Prisma.Decimal | string;
  unitLabel: string;
  unitPrice: Prisma.Decimal | string;
  amount: Prisma.Decimal | string;
  vatType: VatType;
  vatAmount?: Prisma.Decimal | string;
  whtRate: Prisma.Decimal | string;
  accountCode?: string | null;
  isUserAdded?: boolean;
}

/**
 * ST5-T07 บรรทัดจากบรรทัดรายได้ของ DO — DO หนึ่งใบมีได้หลายบรรทัด (ค่าขนส่ง + บริการประกอบ + ค่าใช้จ่ายหน้างาน)
 * บรรทัดแรกของแต่ละ DO = บรรทัดหลัก (`do_anchor`) ที่ unique partial ต่อ DO นับ
 */
export interface RevenueInvoiceLineInput extends DoInvoiceLineInput {
  revenueLineId: string;
  doSurchargeId?: string | null;
}

/** ตรวจ/สร้างบรรทัดของ DO ที่ล็อกแล้ว (ใน transaction เดียวกัน หลังตรวจลูกค้า/สถานะวางบิล) */
export interface AttachHooks {
  /** ตรวจความพร้อมวางบิลซ้ำ (ST5-T07 — ห้ามเชื่อ `released_at` อย่างเดียว) — โยน ProblemException เมื่อไม่พร้อม */
  verify(tx: Tx, rows: BillingDoRow[]): Promise<void>;
  build(tx: Tx, rows: BillingDoRow[]): Promise<RevenueInvoiceLineInput[]>;
}

/** ชื่อ unique partial index ของ migration 0123 (0135 นับเฉพาะบรรทัดหลักของ DO) */
const ACTIVE_DO_INDEX = 'invoice_line_active_delivery_order_key';
/** ST5-T07 (migration 0135) กันซ้ำต่อบรรทัดรายได้ / ค่าใช้จ่ายหน้างาน */
const ACTIVE_LINE_INDEXES = [
  'invoice_line_active_revenue_line_key',
  'invoice_line_active_do_surcharge_key',
];

/**
 * กันวางบิลซ้ำ (ST5-T05; docs/04 F3 "Flag กันวางบิลซ้ำ", docs/01 §3.4 `invoice_line.delivery_order_id` unique partial, spec/05 BIL-022)
 * — ทางเดียวที่เพิ่ม/ถอด DO ในใบแจ้งหนี้และเปลี่ยน `delivery_order.billing_status` [DECISION spec/12 §3]
 *
 * สองชั้น:
 * 1. ล็อกใบ (FOR UPDATE) → ล็อก DO ทุกใบ (เรียง id) → ตรวจ `billingStatus` ∈ UNBILLED/CREDITED — คำขอพร้อมกันที่ดึง DO เดียวกัน
 *    รายที่สองรอล็อกแล้วเห็น IN_DRAFT → 409 `do_already_drafted`
 * 2. unique partial index `(tenant_id, delivery_order_id) WHERE active` — ทางเขียนใดที่ข้ามชั้น 1 ก็ชน → 409 เดียวกัน
 *
 * ใบเปลี่ยนสถานะ (ยกเลิกร่าง ST5-T07 · ออกเลข ST5-T09 · ลดหนี้เต็มใบ/VOIDED) → ผู้เปลี่ยนเรียก `syncFromInvoice` ใน transaction เดียวกัน
 * (trigger ฐานข้อมูลปิด `active` ของบรรทัดเมื่อใบเป็น CANCELLED/VOIDED เอง)
 * ความพร้อมวางบิลเต็มรูป (POD/ราคา/ระงับ — ST5-T04) ผู้เรียกตรวจก่อน (ST5-T07) — ที่นี่ตรวจเฉพาะ "ส่งถึงแล้ว" + ไม่ซ้ำ + ลูกค้าเดียวกัน
 */
@Injectable()
export class InvoiceBillingGuard {
  constructor(
    private readonly db: DbService,
    private readonly dos: DeliveryOrderService,
    private readonly clock: Clock,
  ) {}

  /** ดึง DO เข้าร่าง: เพิ่มบรรทัด (active) + DO → IN_DRAFT · ใบต้องเป็น DRAFT · DO ต้องเป็นของลูกค้าเดียวกับใบ */
  async attach(
    invoiceId: string,
    lines: DoInvoiceLineInput[],
    tx: Tx = this.db.tx,
  ): Promise<InvoiceLine[]> {
    const ids = lines.map((l) => l.deliveryOrderId);
    const dup = ids.flatMap((x, i) =>
      ids.indexOf(x) !== i
        ? [{ field: `lines[${i}].deliveryOrderId`, code: 'duplicate', message: 'listed twice' }]
        : [],
    );
    if (!lines.length)
      dup.push({ field: 'lines', code: 'empty', message: 'at least one line is required' });
    if (dup.length) throw new ProblemException('validation_failed', undefined, dup);

    const inv = await this.lockDraft(tx, invoiceId);
    const rows = await this.dos.lockForBilling(tx, [...new Set(ids)]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const errors = ids.flatMap((id, i) => {
      const d = byId.get(id);
      if (!d)
        return [{ field: `lines[${i}].deliveryOrderId`, code: 'not_found', message: 'not found' }];
      if (d.customerId !== inv.customerId)
        return [
          {
            field: `lines[${i}].deliveryOrderId`,
            code: 'customer_mismatch',
            message: 'delivery order belongs to another customer',
          },
        ];
      return [];
    });
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);

    // เรียงตาม id (ลำดับเดียวกับล็อก) — ผลซ้ำกันพร้อมกันได้ 409 เดียวกันทุกครั้ง
    for (const d of rows) {
      if (!isBillable(d.billingStatus)) throw this.already(d);
      if (!BILLABLE_DO_STATUSES.includes(d.status))
        throw new ProblemException('not_ready_to_bill', undefined, undefined, {
          reasons: ['NOT_DELIVERED'],
          doStatus: d.status,
        });
    }

    const top = await tx.invoiceLine.aggregate({
      where: { invoiceId },
      _max: { lineNo: true },
    });
    let lineNo = top._max.lineNo ?? 0;
    const tenantId = requestContext.require().tenantId!;
    const data = lines.map((l) => ({
      tenantId,
      invoiceId,
      lineNo: ++lineNo,
      deliveryOrderId: l.deliveryOrderId,
      serviceItemId: l.serviceItemId,
      description: l.description,
      quantity: l.quantity,
      unitLabel: l.unitLabel,
      unitPrice: l.unitPrice,
      amount: l.amount,
      vatType: l.vatType,
      vatAmount: l.vatAmount ?? '0',
      whtRate: l.whtRate,
      accountCode: l.accountCode ?? null,
      isUserAdded: l.isUserAdded ?? false,
    }));
    try {
      await tx.invoiceLine.createMany({ data });
    } catch (e) {
      if (isActiveDoViolation(e)) throw new ProblemException('do_already_drafted');
      throw e;
    }
    await this.dos.moveBilling(tx, rows, 'draft', `invoice:${invoiceId}`, this.clock.now());
    return tx.invoiceLine.findMany({
      where: { invoiceId, deliveryOrderId: { in: ids }, active: true },
      orderBy: { lineNo: 'asc' },
    });
  }

  /**
   * ST5-T07 ดึง DO เข้าร่างจากบรรทัดรายได้: ล็อกใบ → ล็อก DO (เรียง id) → ลูกค้าเดียวกัน → ยังไม่อยู่ในใบที่ active (409 `do_already_drafted`)
   * → ส่งถึงแล้ว → `hooks.verify` (ความพร้อมเต็มรูปของคิว ST5-T04) → `hooks.build` → เพิ่มบรรทัด (บรรทัดแรกของ DO = บรรทัดหลัก) → DO → IN_DRAFT
   */
  async attachDos(
    invoiceId: string,
    deliveryOrderIds: string[],
    hooks: AttachHooks,
    tx: Tx = this.db.tx,
  ): Promise<InvoiceLine[]> {
    const ids = deliveryOrderIds;
    const errors = ids.flatMap((x, i) =>
      ids.indexOf(x) !== i
        ? [{ field: `deliveryOrderIds[${i}]`, code: 'duplicate', message: 'listed twice' }]
        : [],
    );
    if (!ids.length)
      errors.push({
        field: 'deliveryOrderIds',
        code: 'empty',
        message: 'at least one delivery order is required',
      });
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);

    const inv = await this.lockDraft(tx, invoiceId);
    const rows = await this.dos.lockForBilling(tx, ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const bad = ids.flatMap((id, i) => {
      const d = byId.get(id);
      if (!d) return [{ field: `deliveryOrderIds[${i}]`, code: 'not_found', message: 'not found' }];
      if (d.customerId !== inv.customerId)
        return [
          {
            field: `deliveryOrderIds[${i}]`,
            code: 'customer_mismatch',
            message: 'delivery order belongs to another customer',
          },
        ];
      return [];
    });
    if (bad.length) throw new ProblemException('validation_failed', undefined, bad);
    for (const d of rows) if (!isBillable(d.billingStatus)) throw this.already(d);
    for (const d of rows)
      if (!BILLABLE_DO_STATUSES.includes(d.status))
        throw new ProblemException('not_ready_to_bill', undefined, undefined, {
          reasons: ['NOT_DELIVERED'],
          doStatus: d.status,
          deliveryOrderId: encodeId('deliveryOrder', d.id),
          doNo: d.doNo,
        });
    await hooks.verify(tx, rows);
    const built = await hooks.build(tx, rows);

    const top = await tx.invoiceLine.aggregate({ where: { invoiceId }, _max: { lineNo: true } });
    let lineNo = top._max.lineNo ?? 0;
    const tenantId = requestContext.require().tenantId!;
    const anchored = new Set<string>();
    // เรียงตามลำดับ DO ที่ส่งมา แล้วตามลำดับบรรทัดรายได้ที่ build คืน
    const order = new Map(ids.map((id, i) => [id, i]));
    const sorted = built
      .map((l, i) => ({ l, i }))
      .sort(
        (a, b) =>
          (order.get(a.l.deliveryOrderId) ?? 0) - (order.get(b.l.deliveryOrderId) ?? 0) ||
          a.i - b.i,
      )
      .map((x) => x.l);
    const data = sorted.map((l) => {
      const anchor = !anchored.has(l.deliveryOrderId);
      anchored.add(l.deliveryOrderId);
      return {
        tenantId,
        invoiceId,
        lineNo: ++lineNo,
        deliveryOrderId: l.deliveryOrderId,
        doSurchargeId: l.doSurchargeId ?? null,
        revenueLineId: l.revenueLineId,
        doAnchor: anchor,
        serviceItemId: l.serviceItemId,
        description: l.description,
        quantity: l.quantity,
        unitLabel: l.unitLabel,
        unitPrice: l.unitPrice,
        amount: l.amount,
        vatType: l.vatType,
        vatAmount: l.vatAmount ?? '0',
        whtRate: l.whtRate,
        accountCode: l.accountCode ?? null,
        isUserAdded: false,
      };
    });
    const missing = rows.filter((r) => !anchored.has(r.id));
    if (missing.length)
      throw new ProblemException('not_ready_to_bill', undefined, undefined, {
        reasons: ['NO_REVENUE'],
        deliveryOrderId: encodeId('deliveryOrder', missing[0]!.id),
        doNo: missing[0]!.doNo,
      });
    try {
      await tx.invoiceLine.createMany({ data });
    } catch (e) {
      if (isActiveDoViolation(e)) throw new ProblemException('do_already_drafted');
      throw e;
    }
    await this.dos.moveBilling(tx, rows, 'draft', `invoice:${invoiceId}`, this.clock.now());
    return tx.invoiceLine.findMany({
      where: { invoiceId, deliveryOrderId: { in: ids }, active: true },
      orderBy: { lineNo: 'asc' },
    });
  }

  /**
   * ถอด DO ออกจากร่าง: บรรทัดของ DO นั้น active → false (ไม่ลบแถว) + DO IN_DRAFT → UNBILLED · ไม่อยู่ในร่างนี้ → 422
   * ST5-T07: `reason` (ถ้ามี) บันทึกที่บรรทัด (`removed_*`)
   */
  async detach(
    invoiceId: string,
    deliveryOrderIds: string[],
    tx: Tx = this.db.tx,
    reason: string | null = null,
  ): Promise<void> {
    await this.lockDraft(tx, invoiceId);
    const rows = await this.dos.lockForBilling(tx, [...new Set(deliveryOrderIds)]);
    const on = await tx.invoiceLine.findMany({
      where: { invoiceId, active: true, deliveryOrderId: { in: rows.map((r) => r.id) } },
      select: { deliveryOrderId: true },
    });
    const inDraft = new Set(on.map((l) => l.deliveryOrderId));
    const errors = deliveryOrderIds.flatMap((id, i) =>
      inDraft.has(id)
        ? []
        : [
            {
              field: `deliveryOrderIds[${i}]`,
              code: 'not_on_invoice',
              message: 'not on this draft',
            },
          ],
    );
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
    await tx.invoiceLine.updateMany({
      where: { invoiceId, active: true, deliveryOrderId: { in: [...inDraft] as string[] } },
      data: {
        active: false,
        ...(reason
          ? {
              removedAt: this.clock.now(),
              removedBy: requestContext.require().actorId ?? 'system',
              removeReason: reason,
            }
          : {}),
      },
    });
    await this.dos.moveBilling(tx, rows, 'undraft', `invoice:${invoiceId}`);
  }

  /**
   * ปรับ `billing_status` ของ DO ในใบให้ตรงสถานะใบ (idempotent) — ผู้เปลี่ยนสถานะใบเรียกใน transaction เดียวกัน:
   * - ใบออกแล้ว (ISSUED/PARTIALLY_PAID/PAID/ADJUSTED): DO ของบรรทัด active ที่ยัง IN_DRAFT → INVOICED
   * - CANCELLED (ยกเลิกร่าง): DO ที่ยัง IN_DRAFT และไม่อยู่ในบรรทัด active ใดแล้ว → UNBILLED
   * - VOIDED (ลดหนี้เต็มใบ): DO ที่ INVOICED และไม่อยู่ในบรรทัด active ใดแล้ว → CREDITED (วางบิลใหม่ได้)
   * - DRAFT: ไม่ทำอะไร
   */
  async syncFromInvoice(invoiceId: string, tx: Tx = this.db.tx): Promise<number> {
    const inv = await this.lockInvoice(tx, invoiceId);
    const lines = await tx.invoiceLine.findMany({
      where: { invoiceId, deliveryOrderId: { not: null } },
      select: { deliveryOrderId: true, active: true },
    });
    const ids = [...new Set(lines.map((l) => l.deliveryOrderId!))];
    if (!ids.length || inv.status === 'DRAFT') return 0;
    const rows = await this.dos.lockForBilling(tx, ids);
    const elsewhere = new Set(
      (
        await tx.invoiceLine.findMany({
          where: { deliveryOrderId: { in: ids }, active: true },
          select: { deliveryOrderId: true },
        })
      ).map((l) => l.deliveryOrderId),
    );
    const activeHere = new Set(lines.filter((l) => l.active).map((l) => l.deliveryOrderId));
    const note = `invoice:${invoiceId}`;
    const status = inv.status as InvoiceStatus;
    let pick: BillingDoRow[];
    let event: 'invoice' | 'undraft' | 'credit';
    if (status === 'CANCELLED') {
      pick = rows.filter((r) => r.billingStatus === 'IN_DRAFT' && !elsewhere.has(r.id));
      event = 'undraft';
    } else if (status === 'VOIDED') {
      pick = rows.filter((r) => r.billingStatus === 'INVOICED' && !elsewhere.has(r.id));
      event = 'credit';
    } else {
      pick = rows.filter((r) => r.billingStatus === 'IN_DRAFT' && activeHere.has(r.id));
      event = 'invoice';
    }
    await this.dos.moveBilling(tx, pick, event, note, this.clock.now());
    return pick.length;
  }

  private async lockInvoice(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<{ id: string; status: string; customer_id: string }[]>`
      SELECT id, status::text AS status, customer_id FROM invoice WHERE id = ${id}::uuid FOR UPDATE`;
    const r = rows[0];
    if (!r) throw new ProblemException('not_found');
    return { id: r.id, status: r.status, customerId: r.customer_id };
  }

  private async lockDraft(tx: Tx, id: string) {
    const inv = await this.lockInvoice(tx, id);
    if (inv.status !== 'DRAFT')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: inv.status,
      });
    return inv;
  }

  /** 409 — ไม่บอกเลขใบ (ID prefix `inv_` ของ docs/01 §5.1 ชน `invitation` — ST5-T07 ตัดสิน prefix ของใบแจ้งหนี้ — spec/12 §3) */
  private already(d: BillingDoRow): ProblemException {
    return new ProblemException('do_already_drafted', undefined, undefined, {
      deliveryOrderId: encodeId('deliveryOrder', d.id),
      doNo: d.doNo,
      billingStatus: d.billingStatus,
    });
  }
}

/**
 * unique violation ของ index กันวางบิลซ้ำ — Prisma ไม่รู้จัก partial index (P2002 `target` = null) จึงถือว่า P2002 ของ
 * invoice_line ที่ไม่ใช่ line_no = index นี้ (unique อื่นของตารางมีแค่ (tenant, invoice, line_no) ที่คิดใต้ล็อกใบ) · raw SQL ดูชื่อ index
 */
export function isActiveDoViolation(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const t = e.meta?.target;
    const s = Array.isArray(t) ? t.join(',') : String(t ?? '');
    if ([ACTIVE_DO_INDEX, ...ACTIVE_LINE_INDEXES].some((x) => s.includes(x))) return true;
    if (s.includes('delivery_order_id') || s.includes('revenue_line_id')) return true;
    return e.meta?.modelName === 'InvoiceLine' && !s.includes('line_no');
  }
  return (
    e instanceof Error &&
    [ACTIVE_DO_INDEX, ...ACTIVE_LINE_INDEXES].some((x) => e.message.includes(x))
  );
}
