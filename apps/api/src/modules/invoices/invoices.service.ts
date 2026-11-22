import { Injectable } from '@nestjs/common';
import { Prisma, type VatType } from '@prisma/client';
import {
  AGING_BUCKET_RANGE,
  ISSUED_INVOICE_STATUSES,
  billingMonthRanges,
  canMergeInvoiceLines,
  computeDocumentTax,
  decimalFromSatang,
  invoiceOverdue,
  invoicePrintLines,
  satangFromDecimal,
  taxOptionsFromSettings,
  toCalcVatType,
  toCalcWhtRate,
  type AgingBucket,
  type InvoiceLineMode,
  type InvoiceSentChannel,
  type InvoiceStatus,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { EXT_PREFIX, EXTERNAL_ID_RE } from '../../common/external-id';
import { encodeId, tryDecodeId } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { addDays, bangkokToday } from '../vehicle-documents/expiry';
import type { BillingDoRow } from '../delivery-orders/delivery-order.service';
import { LINE_UNIT_EXPR, LINE_UNIT_JOINS } from './line-units';
import { REVENUE_LOCK_NS } from '../revenue-lines/revenue-rebuild';
import { RevenueLinesService } from '../revenue-lines/revenue-lines.service';
import { readSettings } from '../settings/settings.service';
import { InvoiceBillingGuard, type RevenueInvoiceLineInput } from './billing-guard.service';
import { MAX_DOS_PER_INVOICE } from './billing-limits';
import { BillingReleaseService } from './billing-release.service';
import type { NotReadyReason } from './billing-queue.service';
import type {
  AddInvoiceLineDto,
  CreateInvoiceDto,
  InvoiceDto,
  InvoiceLineDto,
  InvoiceListQuery,
  InvoicePageDto,
  InvoiceSummaryCountsDto,
  InvoiceSummaryDto,
  MoveInvoiceDeliveryOrdersDto,
  UpdateInvoiceDto,
  UpdateInvoiceLineDto,
} from './invoice.dto';

const ENTITY = 'invoice';
const NONE = '00000000-0000-0000-0000-000000000000';
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const isRealDay = (s: string) => !Number.isNaN(day(s).getTime()) && ymd(day(s)) === s;
const money = (d: Prisma.Decimal | string) => new Prisma.Decimal(d).toFixed(2);

/** ใบที่ออกแล้วและนับยอดค้าง (หน้า "รับชำระ" — ไม่รวมร่าง/ยกเลิก) */
const RECEIVABLE_STATUSES: readonly string[] = ISSUED_INVOICE_STATUSES;

const LOAD = {
  customer: { select: { id: true, code: true, legalName: true, taxId: true, branchCode: true } },
  lines: {
    orderBy: { lineNo: 'asc' },
    include: {
      deliveryOrder: {
        select: {
          id: true,
          doNo: true,
          doDate: true,
          originSite: { select: { name: true } },
          destSite: { select: { name: true } },
        },
      },
      revenueLine: { select: { kind: true } },
    },
  },
  pdfDocument: { select: { id: true, filename: true, sha256: true, sizeBytes: true } },
  // ST5-T11 ใบวางบิลที่ใบนี้อยู่ (ผูก active ได้ใบเดียว — docs/01 §3.4 `invoice.billing_note_id`)
  billingNoteLinks: { where: { active: true }, select: { billingNoteId: true }, take: 1 },
  // ST5-T10 ยกเลิกแล้วออกใหม่: ใบเดิมที่ใบนี้ออกแทน / ใบที่ออกแทนใบนี้ (ล่าสุดที่ยังไม่ยกเลิก ก่อน)
  replaces: { select: { id: true, invoiceNo: true, issueDate: true } },
  replacedBy: {
    select: { id: true, invoiceNo: true, status: true },
    orderBy: { createdAt: 'desc' },
  },
} as const satisfies Prisma.InvoiceInclude;
type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof LOAD }>;
type LineRow = InvoiceRow['lines'][number];

interface ServiceItemSnapshot {
  unitLabel?: string;
}

function invalid(errors: FieldError[]): ProblemException {
  return new ProblemException('validation_failed', undefined, errors);
}

/**
 * ร่างใบแจ้งหนี้ (ST5-T07; **D-54 บัญชีเบา — ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี**; docs/04 F3 "Draft (แก้ได้)", F2 ใบแจ้งหนี้ 1 ใบ : หลาย DO
 * ของลูกค้าเดียว; spec/05 §3; docs/01 §3.4/§4.4)
 *
 * - สร้างจาก DO หลายใบของลูกค้าเดียว: ทุก DO ต้อง **ส่งบัญชีแล้ว (RELEASED)** และผ่านเงื่อนไขคิวพร้อมวางบิล **ตรวจซ้ำตอนดึง** (ราคา/
 *   บรรทัดรายได้ยืนยันแล้ว/ไม่ระงับ/เวลาจุดส่ง/หลักฐานตาม checklist ปัจจุบัน — ห้ามเชื่อ `released_at` อย่างเดียว) → 409 `not_ready_to_bill`
 * - 1 บรรทัด = 1 บรรทัดรายได้ของ DO (ค่าขนส่ง/บริการประกอบ/ค่าใช้จ่ายหน้างาน) · กันวางบิลซ้ำต่อ DO + ต่อบรรทัดรายได้ (ST5-T05 + migration 0135)
 * - แก้ได้ในร่าง: เพิ่ม/ถอด DO · ย้าย DO ไปร่างอื่น · เพิ่มบรรทัดเอง · ส่วนลด · รวม/แยกบรรทัด (รูปบนเอกสาร Group / Merge / Single)
 * - ราคาของ DO ในร่างล็อกที่ order (บรรทัดรายได้แก้ไม่ได้ — 409 `do_in_invoice`; คิดราคาใบสั่งใหม่ไม่แตะ DO ในร่าง) — แก้ที่ร่าง (ส่วนลด)
 * - ยอด VAT/WHT = **ประมาณการ** จาก `computeDocumentTax` (ST5-T02) — ไม่ใช่เอกสารภาษี
 * - ร่าง **ไม่มีเลข** (CHECK `invoice_draft_no_number`) **ไม่เข้า outbox/webhook** (ส่งระบบบัญชีหลังออกเลข — ST5-T09/ST8-T16) · ทุกการแก้ลง audit
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly guard: InvoiceBillingGuard,
    private readonly release: BillingReleaseService,
    private readonly clock: Clock,
    private readonly revenue: RevenueLinesService,
  ) {}

  // ---------- อ่าน ----------

  async list(q: InvoiceListQuery): Promise<InvoicePageDto> {
    const tx = this.db.tx;
    const k = keysetArgs(q);
    const and: Prisma.InvoiceWhereInput[] = [k.where as Prisma.InvoiceWhereInput];
    if (q.status) and.push({ status: q.status });
    if (q.receivable === 'all')
      and.push({ status: { in: RECEIVABLE_STATUSES as InvoiceStatus[] } });
    if (q.receivable === 'open') and.push({ status: { in: ['ISSUED', 'PARTIALLY_PAID'] } });
    // ST5-T18 เกินกำหนด = ธงที่เก็บ หรือเข้าเงื่อนไขแล้วแต่ job ยังไม่รัน (worker ล่ม / ช่วง 00:00–00:05) — review M1
    const od = overdueWhere(tx, bangkokToday(this.clock.now()));
    if (q.receivable === 'overdue' || q.overdue === 'true') and.push(od);
    if (q.overdue === 'false') and.push({ NOT: od });
    if (q.aging) and.push(agingWhere(tx, q.aging, bangkokToday(this.clock.now())));
    if (q.customerId !== undefined)
      and.push({ customerId: (await this.customerRef(tx, q.customerId)) ?? NONE });
    const today = bangkokToday(this.clock.now());
    const rows = await tx.invoice.findMany({
      where: { AND: and },
      orderBy: k.orderBy as unknown as Prisma.InvoiceOrderByWithRelationInput[],
      take: k.take,
      include: { customer: LOAD.customer },
    });
    const counts = await this.doCounts(
      tx,
      rows.map((r) => r.id),
    );
    const page = toPage(
      rows,
      k,
      (r): InvoiceSummaryDto => summary(r, counts.get(r.id) ?? 0, today),
      q.fields,
    );
    return page as InvoicePageDto;
  }

  async get(id: string, tx: Tx = this.db.tx): Promise<InvoiceDto> {
    const r = await tx.invoice.findUnique({ where: { id }, include: LOAD });
    if (!r) throw new ProblemException('not_found');
    return toDto(r, bangkokToday(this.clock.now()));
  }

  // ---------- เขียน ----------

  /** `o.createdBy` = ผู้สร้างที่เป็นระบบ (`system:invoice-run` — ST5-T12: ไม่นับเป็นผู้เตรียมในกฎแบ่งหน้าที่ของ finalize) */
  async create(body: CreateInvoiceDto, o: { createdBy?: string } = {}): Promise<InvoiceDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const customerId = await this.customerRef(tx, body.customerId);
    const customer = customerId
      ? await tx.customer.findFirst({ where: { id: customerId, deletedAt: null } })
      : null;
    if (!customer)
      throw invalid([
        { field: 'customerId', code: 'invalid_reference', message: 'customer not found' },
      ]);
    this.checkPeriod(body.periodFrom, body.periodTo);
    const issuer = await this.issuer(tx, customer.defaultBillingCompanyId);
    const doIds = this.decodeDos(body.deliveryOrderIds);
    // review M2: ส่งบัญชี + สร้างร่างในคำขอเดียว (atomic) — ส่งบัญชีไม่ผ่าน = ไม่มีอะไรเปลี่ยน (ตรวจเงื่อนไขชุดเดียวกับส่งบัญชีปกติ + ตรวจซ้ำตอนดึง)
    if (body.releaseDeliveryOrders) {
      const pending = await tx.deliveryOrder.findMany({
        where: { id: { in: doIds }, customerId: customer.id, releasedAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      for (const d of pending) await this.release.release(d.id, { note: null }, tx);
    }
    const inv = await tx.invoice.create({
      data: {
        tenantId: ctx.tenantId!,
        customerId: customer.id,
        issuingCompanyId: issuer.companyId,
        issuingBranchId: issuer.branchId,
        creditTermDays: customer.paymentTermDays,
        customerPoNo: body.customerPoNo || null,
        note: body.note || null,
        lineMode: body.lineMode ?? 'SINGLE',
        createdBy: o.createdBy ?? ctx.actorId ?? null,
      },
    });
    await this.pull(tx, inv.id, doIds);
    // งวดเริ่มต้น = ช่วงวันที่ของ DO ที่ดึง (ส่งมาเอง = ตามที่ส่ง)
    const span = await tx.deliveryOrder.aggregate({
      where: { id: { in: doIds } },
      _min: { doDate: true },
      _max: { doDate: true },
    });
    const from = body.periodFrom ?? (span._min.doDate ? ymd(span._min.doDate) : null);
    const to = body.periodTo ?? (span._max.doDate ? ymd(span._max.doDate) : null);
    if (from && to && from > to)
      throw invalid([
        { field: 'periodTo', code: 'before_period_from', message: 'periodTo must be ≥ periodFrom' },
      ]);
    await tx.invoice.update({
      where: { id: inv.id },
      data: { periodFrom: from ? day(from) : null, periodTo: to ? day(to) : null },
    });
    await this.recompute(tx, inv.id, false);
    const out = await this.get(inv.id);
    await this.audit.record({
      action: 'invoice.draft_created',
      entityType: ENTITY,
      entityId: inv.id,
      after: {
        customerId: out.customer.id,
        deliveryOrders: out.deliveryOrders.map((d) => d.doNo ?? d.id),
        lineCount: out.lines.length,
        periodFrom: out.periodFrom,
        periodTo: out.periodTo,
        lineMode: out.lineMode,
        total: out.sellTotal,
      },
    });
    return out;
  }

  async update(id: string, body: UpdateInvoiceDto, expected?: number): Promise<InvoiceDto> {
    const tx = this.db.tx;
    const inv = await this.lock(tx, id, expected);
    this.checkPeriod(body.periodFrom, body.periodTo);
    const from = body.periodFrom ?? (inv.periodFrom ? ymd(inv.periodFrom) : null);
    const to = body.periodTo ?? (inv.periodTo ? ymd(inv.periodTo) : null);
    if (from && to && from > to)
      throw invalid([
        { field: 'periodTo', code: 'before_period_from', message: 'periodTo must be ≥ periodFrom' },
      ]);
    const data: Prisma.InvoiceUpdateInput = {
      periodFrom: from ? day(from) : null,
      periodTo: to ? day(to) : null,
      updatedBy: requestContext.require().actorId ?? null,
      version: { increment: 1 },
    };
    if (body.lineMode !== undefined) data.lineMode = body.lineMode;
    if (body.creditTermDays !== undefined) data.creditTermDays = body.creditTermDays;
    if (body.customerPoNo !== undefined) data.customerPoNo = body.customerPoNo || null;
    if (body.note !== undefined) data.note = body.note || null;
    const after = await tx.invoice.update({ where: { id }, data });
    await this.audit.changed('invoice.draft_updated', ENTITY, id, headerOf(inv), headerOf(after));
    return this.get(id);
  }

  async addDeliveryOrders(id: string, ids: string[], expected?: number): Promise<InvoiceDto> {
    const tx = this.db.tx;
    await this.lock(tx, id, expected);
    const doIds = this.decodeDos(ids);
    await this.pull(tx, id, doIds);
    await this.recompute(tx, id, true);
    const out = await this.get(id);
    await this.audit.record({
      action: 'invoice.delivery_orders_added',
      entityType: ENTITY,
      entityId: id,
      after: { deliveryOrders: await this.doNos(tx, doIds), total: out.sellTotal },
    });
    return out;
  }

  async removeDeliveryOrders(
    id: string,
    ids: string[],
    reason: string,
    expected?: number,
  ): Promise<InvoiceDto> {
    const tx = this.db.tx;
    await this.lock(tx, id, expected);
    const doIds = this.decodeDos(ids);
    const orders = await this.lockOrders(tx, doIds);
    await this.guard.detach(id, doIds, tx, reason);
    await this.rebuildOrders(tx, orders);
    await this.recompute(tx, id, true);
    const out = await this.get(id);
    await this.audit.record({
      action: 'invoice.delivery_orders_removed',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { deliveryOrders: await this.doNos(tx, doIds) },
      after: { total: out.sellTotal },
    });
    return out;
  }

  /** ย้าย DO ไปร่างอื่นของลูกค้า/สาขาผู้ออกเดียวกัน — ถอดจากใบนี้แล้วดึงเข้าใบปลายทาง (ตรวจความพร้อมซ้ำ) ใน transaction เดียว */
  async moveDeliveryOrders(
    id: string,
    body: MoveInvoiceDeliveryOrdersDto,
    expected?: number,
  ): Promise<{ source: InvoiceDto; target: InvoiceDto }> {
    const tx = this.db.tx;
    const targetId = tryDecodeId('invoice', body.targetInvoiceId);
    if (!targetId || targetId === id)
      throw invalid([
        {
          field: 'targetInvoiceId',
          code: targetId ? 'same_invoice' : 'invalid_reference',
          message: targetId ? 'target must be another draft' : 'invoice not found',
        },
      ]);
    if (!(await tx.invoice.findUnique({ where: { id }, select: { id: true } })))
      throw new ProblemException('not_found');
    // ล็อกสองใบตามลำดับ id (กัน deadlock กับการย้ายสวนทาง)
    const [first, second] = [id, targetId].sort();
    const locked = new Map<string, Awaited<ReturnType<InvoicesService['lock']>>>();
    for (const x of [first!, second!]) {
      const exists = await tx.invoice.findUnique({ where: { id: x }, select: { id: true } });
      if (!exists && x === targetId)
        throw invalid([
          { field: 'targetInvoiceId', code: 'invalid_reference', message: 'invoice not found' },
        ]);
      locked.set(x, await this.lock(tx, x, x === id ? expected : undefined));
    }
    const src = locked.get(id)!;
    const dst = locked.get(targetId)!;
    if (src.customerId !== dst.customerId || src.issuingBranchId !== dst.issuingBranchId)
      throw invalid([
        {
          field: 'targetInvoiceId',
          code: 'customer_mismatch',
          message: 'target draft must be of the same customer and issuing branch',
        },
      ]);
    const doIds = this.decodeDos(body.deliveryOrderIds);
    const nos = await this.doNos(tx, doIds);
    await this.guard.detach(id, doIds, tx, `moved:${encodeId('invoice', targetId)}`);
    await this.pull(tx, targetId, doIds);
    await this.recompute(tx, id, true);
    await this.recompute(tx, targetId, true);
    const source = await this.get(id);
    const target = await this.get(targetId);
    await this.audit.record({
      action: 'invoice.delivery_orders_moved',
      entityType: ENTITY,
      entityId: id,
      before: { deliveryOrders: nos },
      after: { targetInvoiceId: target.id, total: source.sellTotal },
    });
    await this.audit.record({
      action: 'invoice.delivery_orders_moved_in',
      entityType: ENTITY,
      entityId: targetId,
      after: { sourceInvoiceId: source.id, deliveryOrders: nos, total: target.sellTotal },
    });
    return { source, target };
  }

  /** บรรทัดเพิ่มเอง (ไม่ผูก DO) — ภาษีตามรายการบริการ · เหตุผลบังคับ + audit (override) */
  async addLine(id: string, body: AddInvoiceLineDto, expected?: number): Promise<InvoiceDto> {
    const tx = this.db.tx;
    await this.lock(tx, id, expected);
    const sid = tryDecodeId('serviceItem', body.serviceItemId);
    const si = sid
      ? await tx.serviceItem.findFirst({ where: { id: sid, deletedAt: null, status: 'ACTIVE' } })
      : null;
    if (!si)
      throw invalid([
        { field: 'serviceItemId', code: 'invalid_reference', message: 'service item not found' },
      ]);
    const amount = new Prisma.Decimal(body.quantity)
      .mul(body.sellUnitPrice)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    if (amount.gt('999999999999.99'))
      throw invalid([{ field: 'sellUnitPrice', code: 'too_large', message: 'amount too large' }]);
    const top = await tx.invoiceLine.aggregate({
      where: { invoiceId: id },
      _max: { lineNo: true },
    });
    const line = await tx.invoiceLine.create({
      data: {
        tenantId: requestContext.require().tenantId!,
        invoiceId: id,
        lineNo: (top._max.lineNo ?? 0) + 1,
        serviceItemId: si.id,
        description: body.description ?? si.nameTh,
        quantity: body.quantity,
        unitLabel: si.unitLabel,
        unitPrice: body.sellUnitPrice,
        amount,
        vatType: si.vatType,
        whtRate: si.whtRate,
        accountCode: si.defaultAccountCode,
        isUserAdded: true,
        doAnchor: false,
      },
    });
    await this.recompute(tx, id, true);
    const out = await this.get(id);
    await this.audit.record({
      action: 'invoice.line_added',
      entityType: ENTITY,
      entityId: id,
      reason: body.reason,
      after: {
        line: {
          id: encodeId('invoiceLine', line.id),
          lineNo: line.lineNo,
          serviceItemId: body.serviceItemId,
          description: line.description,
          quantity: body.quantity,
          unitPrice: money(line.unitPrice),
          amount: money(line.amount),
          vatType: line.vatType,
          whtRate: money(line.whtRate),
        },
        total: out.sellTotal,
      },
    });
    return out;
  }

  /** แก้คำอธิบาย / ส่วนลดของบรรทัด (ส่วนลด = แก้ราคาที่ร่าง — เหตุผลบังคับ + audit) */
  async updateLine(
    id: string,
    lineId: string,
    body: UpdateInvoiceLineDto,
    expected?: number,
  ): Promise<InvoiceDto> {
    const tx = this.db.tx;
    await this.lock(tx, id, expected);
    const line = await this.activeLine(tx, id, lineId);
    if (body.description === undefined && body.sellDiscount === undefined)
      throw invalid([{ field: 'description', code: 'required', message: 'nothing to change' }]);
    const data: Prisma.InvoiceLineUpdateInput = {};
    if (body.description !== undefined) data.description = body.description;
    let discountChanged = false;
    if (body.sellDiscount !== undefined) {
      const gross = line.amount.add(line.discount);
      const disc = new Prisma.Decimal(body.sellDiscount);
      if (disc.gt(gross))
        throw invalid([
          {
            field: 'sellDiscount',
            code: 'exceeds_amount',
            message: `discount must be ≤ line amount before discount (${money(gross)})`,
          },
        ]);
      discountChanged = !disc.eq(line.discount);
      if (discountChanged && !body.reason)
        throw invalid([
          { field: 'reason', code: 'required', message: 'reason is required to change discount' },
        ]);
      data.discount = disc;
      data.amount = gross.sub(disc);
    }
    await tx.invoiceLine.update({ where: { id: line.id }, data });
    await this.recompute(tx, id, true);
    const out = await this.get(id);
    const after = out.lines.find((l) => l.id === encodeId('invoiceLine', line.id))!;
    await this.audit.changed(
      'invoice.line_updated',
      ENTITY,
      id,
      {
        lineNo: line.lineNo,
        description: line.description,
        discount: money(line.discount),
        amount: money(line.amount),
      },
      {
        lineNo: line.lineNo,
        description: after.description,
        discount: after.sellDiscount,
        amount: after.sellAmount,
      },
      body.reason,
    );
    return out;
  }

  /** ถอดบรรทัดที่เพิ่มเอง — บรรทัดของ DO ถอดทั้ง DO (`remove-delivery-orders`) */
  async removeLine(
    id: string,
    lineId: string,
    reason: string,
    expected?: number,
  ): Promise<InvoiceDto> {
    const tx = this.db.tx;
    await this.lock(tx, id, expected);
    const line = await this.activeLine(tx, id, lineId);
    if (line.deliveryOrderId)
      throw invalid([
        {
          field: 'lineId',
          code: 'delivery_order_line',
          message: 'lines of a delivery order are removed with the delivery order',
        },
      ]);
    await tx.invoiceLine.update({
      where: { id: line.id },
      data: {
        active: false,
        removedAt: this.clock.now(),
        removedBy: requestContext.require().actorId ?? 'system',
        removeReason: reason,
      },
    });
    await this.recompute(tx, id, true);
    const out = await this.get(id);
    await this.audit.record({
      action: 'invoice.line_removed',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: {
        line: {
          id: encodeId('invoiceLine', line.id),
          lineNo: line.lineNo,
          description: line.description,
          amount: money(line.amount),
        },
      },
      after: { total: out.sellTotal },
    });
    return out;
  }

  /** รวมบรรทัด (Merge) — ประเภท VAT + อัตราหักเดียวกันเท่านั้น → กลุ่มใหม่บนเอกสาร (ยอดไม่เปลี่ยน) */
  async mergeLines(id: string, lineIds: string[], expected?: number): Promise<InvoiceDto> {
    const tx = this.db.tx;
    await this.lock(tx, id, expected);
    const lines = await this.activeLines(tx, id, lineIds);
    if (lines.length < 2)
      throw invalid([
        { field: 'lineIds', code: 'too_few', message: 'select at least two lines to merge' },
      ]);
    if (
      !canMergeInvoiceLines(lines.map((l) => ({ vatType: l.vatType, whtRate: money(l.whtRate) })))
    )
      throw invalid([
        {
          field: 'lineIds',
          code: 'mixed_tax_treatment',
          message: 'lines with different VAT type or withholding rate cannot be merged',
        },
      ]);
    const top = await tx.invoiceLine.aggregate({
      where: { invoiceId: id },
      _max: { printGroup: true },
    });
    const group = (top._max.printGroup ?? 0) + 1;
    await tx.invoiceLine.updateMany({
      where: { id: { in: lines.map((l) => l.id) } },
      data: { printGroup: group },
    });
    await this.bump(tx, id);
    await this.audit.record({
      action: 'invoice.lines_merged',
      entityType: ENTITY,
      entityId: id,
      after: { printGroup: group, lineNos: lines.map((l) => l.lineNo) },
    });
    return this.get(id);
  }

  /** แยกบรรทัดที่รวมไว้ (ล้างกลุ่ม) — กลับไปตามรูปบรรทัดของใบ */
  async splitLines(id: string, lineIds: string[], expected?: number): Promise<InvoiceDto> {
    const tx = this.db.tx;
    await this.lock(tx, id, expected);
    const lines = await this.activeLines(tx, id, lineIds);
    const grouped = lines.filter((l) => l.printGroup !== null);
    if (!grouped.length)
      throw invalid([{ field: 'lineIds', code: 'not_merged', message: 'lines are not merged' }]);
    await tx.invoiceLine.updateMany({
      where: { id: { in: grouped.map((l) => l.id) } },
      data: { printGroup: null },
    });
    await this.bump(tx, id);
    await this.audit.record({
      action: 'invoice.lines_split',
      entityType: ENTITY,
      entityId: id,
      before: { lineNos: grouped.map((l) => l.lineNo) },
    });
    return this.get(id);
  }

  /** ยกเลิกร่าง (DRAFT → CANCELLED — docs/01 §4.4 "DO กลับ UNBILLED") · เหตุผล + audit · ไม่มีการลบ */
  async cancel(id: string, reason: string, expected?: number): Promise<InvoiceDto> {
    const tx = this.db.tx;
    await this.lock(tx, id, expected);
    const doIds = (
      await tx.invoiceLine.findMany({
        where: { invoiceId: id, active: true, deliveryOrderId: { not: null } },
        select: { deliveryOrderId: true },
      })
    ).map((l) => l.deliveryOrderId!);
    const orders = await this.lockOrders(tx, doIds);
    const ctx = requestContext.require();
    await tx.invoice.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: this.clock.now(),
        cancelledBy: ctx.actorId ?? 'system',
        cancelReason: reason,
        updatedBy: ctx.actorId ?? null,
        version: { increment: 1 },
      },
    });
    const released = await this.guard.syncFromInvoice(id, tx);
    await this.rebuildOrders(tx, orders);
    const out = await this.get(id);
    await this.audit.record({
      action: 'invoice.draft_cancelled',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { status: 'DRAFT' },
      after: { status: 'CANCELLED', deliveryOrdersReleased: released, total: out.sellTotal },
    });
    return out;
  }

  // ---------- ภายใน ----------

  /**
   * review L1: ถอด DO ออกจากร่าง/ยกเลิกร่าง → DO ไม่แช่แข็งแล้ว ต้องคิดบรรทัดรายได้ของใบสั่งใหม่ (ยอดเหมา/ขั้นต่ำแบ่งใหม่ — ไม่หายเงียบ)
   * ล็อกตามลำดับเดียวกับ rebuild: advisory lock ของใบสั่ง (เรียง id) → DO ทุกใบของใบสั่ง FOR UPDATE (เรียง id) — ก่อนถอด
   */
  async lockOrders(tx: Tx, doIds: string[]): Promise<string[]> {
    if (!doIds.length) return [];
    const rows = await tx.deliveryOrder.findMany({
      where: { id: { in: doIds } },
      select: { salesOrderId: true },
    });
    const orders = [...new Set(rows.map((r) => r.salesOrderId))].sort();
    for (const so of orders)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REVENUE_LOCK_NS}::int, hashtext(${so}))`;
    await tx.$queryRaw`SELECT id FROM delivery_order WHERE sales_order_id = ANY(${orders}::uuid[]) ORDER BY id FOR UPDATE`;
    return orders;
  }

  async rebuildOrders(tx: Tx, orders: string[]) {
    for (const so of orders) await this.revenue.rebuild(so, tx);
  }

  /** รายงานจำนวนตามสถานะ (แท็บ/KPI ของหน้า "วางบิลและใบแจ้งหนี้") */
  async summary(): Promise<InvoiceSummaryCountsDto> {
    // ST5-T18 เกินกำหนดเป็นแท็บของตัวเอง (ต้นแบบ invSt: เกินกำหนดมาก่อนออกแล้ว/ชำระบางส่วน) — นับแยกจากสถานะ
    const tx = this.db.tx;
    const today = bangkokToday(this.clock.now());
    const od = overdueWhere(tx, today);
    const rows = await tx.invoice.groupBy({
      by: ['status'],
      where: { NOT: od },
      _count: { _all: true },
      _sum: { totalAmount: true, paidAmount: true },
    });
    const odAgg = await tx.invoice.aggregate({
      where: od,
      _count: { _all: true },
      _sum: { totalAmount: true, paidAmount: true },
    });
    const overdue = odAgg._count._all;
    const pick = (st: string[]) => rows.filter((r) => st.includes(r.status));
    const n = (...st: string[]) => pick(st).reduce((a, r) => a + r._count._all, 0);
    const ZERO = new Prisma.Decimal(0);
    const dec = (v: Prisma.Decimal | null) => v ?? ZERO;
    // ST9-T02 ยอดต่อแท็บ (Decimal — ไม่ใช้ float): ร่าง = ยอดรวมใบ · ใบที่ออกแล้ว = ยอดค้าง (ยอดรวม − ยอดตัดชำระ)
    // ชุดเดียวกับจำนวน (แท็บของหน้า "วางบิลและใบแจ้งหนี้") — Σ ออกแล้ว + ชำระบางส่วน + เกินกำหนด = ยอดค้างรับ
    const total = (...st: string[]) =>
      pick(st).reduce((a, r) => a.add(dec(r._sum.totalAmount)), ZERO);
    const outstanding = (...st: string[]) =>
      pick(st).reduce((a, r) => a.add(dec(r._sum.totalAmount).sub(dec(r._sum.paidAmount))), ZERO);
    // เดือนนี้ vs เดือนก่อน: ใบที่ออกเลขในเดือน (issue_date เวลาไทย) ไม่รวมร่าง/ยกเลิก (CANCELLED/VOIDED)
    const m = billingMonthRanges(today);
    const issuedIn = (r: { from: string; to: string }) =>
      tx.invoice.aggregate({
        where: {
          status: { in: [...ISSUED_INVOICE_STATUSES] },
          issueDate: { gte: day(r.from), lte: day(r.to) },
        },
        _count: { _all: true },
        _sum: { totalAmount: true },
      });
    const [cur, prev] = [await issuedIn(m.thisMonth), await issuedIn(m.lastMonth)];
    return {
      total:
        n('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'ADJUSTED', 'VOIDED', 'CANCELLED') + overdue,
      draft: n('DRAFT'),
      // ST9-T02 (review M2) นิยามลูกหนี้เดียว = PAYABLE_INVOICE_STATUSES (ISSUED/PARTIALLY_PAID) เหมือน payments/summary + แท็บ
      // "ออกแล้ว" (`status=ISSUED&overdue=false`) — ADJUSTED (ลดหนี้บางส่วน) ไม่เกิดในเฟส 0 (ใบลดหนี้ย้ายไป AccountSystem — D-54) นับใน `total` เท่านั้น
      issued: n('ISSUED'),
      partiallyPaid: n('PARTIALLY_PAID'),
      paid: n('PAID'),
      overdue,
      cancelled: n('CANCELLED', 'VOIDED'),
      today,
      sellDraftTotal: money(total('DRAFT')),
      sellIssuedOutstanding: money(outstanding('ISSUED')),
      sellPartiallyPaidOutstanding: money(outstanding('PARTIALLY_PAID')),
      sellOverdueOutstanding: money(dec(odAgg._sum.totalAmount).sub(dec(odAgg._sum.paidAmount))),
      issuedThisMonth: {
        month: m.thisMonth.month,
        count: cur._count._all,
        sellTotal: money(dec(cur._sum.totalAmount)),
      },
      issuedLastMonth: {
        month: m.lastMonth.month,
        count: prev._count._all,
        sellTotal: money(dec(prev._sum.totalAmount)),
      },
    };
  }

  /** ล็อกใบ (FOR UPDATE) + ต้องเป็นร่าง (409) + If-Match (412) */
  private async lock(tx: Tx, id: string, expected?: number) {
    await tx.$queryRaw`SELECT id FROM invoice WHERE id = ${id}::uuid FOR UPDATE`;
    const inv = await tx.invoice.findUnique({ where: { id } });
    if (!inv) throw new ProblemException('not_found');
    if (expected !== undefined && expected !== inv.version)
      throw new ProblemException('precondition_failed');
    if (inv.status !== 'DRAFT')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: inv.status,
      });
    return inv;
  }

  private async bump(tx: Tx, id: string) {
    await tx.invoice.update({
      where: { id },
      data: {
        version: { increment: 1 },
        updatedBy: requestContext.require().actorId ?? null,
      },
    });
  }

  /** ดึง DO เข้าร่าง: ตรวจความพร้อมซ้ำ + สร้างบรรทัดจากบรรทัดรายได้ (ผ่าน InvoiceBillingGuard — ตัวกันวางบิลซ้ำ) */
  /** ดึง DO เข้าร่าง (ตรวจความพร้อมซ้ำ + บรรทัดจากบรรทัดรายได้) — ใช้ร่วมกับออกใบแทน (ST5-T10) */
  async pull(tx: Tx, invoiceId: string, doIds: string[]) {
    await this.assertDoCap(tx, invoiceId, doIds.length);
    await this.guard.attachDos(
      invoiceId,
      doIds,
      {
        verify: (t, rows) => this.verifyReady(t, rows),
        build: (t, rows) => this.buildLines(t, rows),
      },
      tx,
    );
  }

  /**
   * เพดาน DO ต่อใบแจ้งหนี้ (`MAX_DOS_PER_INVOICE` — PO 22 พ.ย. 2569): DO ที่อยู่บนร่างแล้ว + ที่จะดึงเพิ่ม เกิน = 422 `too_many`
   * (เพดานเดียวกันทุกทาง: สร้างมือ, เพิ่ม DO เข้าร่าง, รอบวางบิล, ออกใบแทน)
   */
  private async assertDoCap(tx: Tx, invoiceId: string, adding: number) {
    const [{ n }] = await tx.$queryRaw<[{ n: number }]>`
      SELECT count(DISTINCT delivery_order_id)::int AS n FROM invoice_line
       WHERE invoice_id = ${invoiceId}::uuid AND active AND delivery_order_id IS NOT NULL`;
    if (n + adding > MAX_DOS_PER_INVOICE)
      throw invalid([
        {
          field: 'deliveryOrderIds',
          code: 'too_many',
          message: `an invoice can hold at most ${MAX_DOS_PER_INVOICE} delivery orders (already ${n}, adding ${adding})`,
        },
      ]);
  }

  /** ST5-T07 / ST5-T04 review: ตรวจความพร้อมซ้ำทุกครั้งที่ดึง — ส่งบัญชีแล้ว **และ** เงื่อนไขคิวยังผ่าน (ไม่เชื่อ `released_at` อย่างเดียว) */
  private async verifyReady(tx: Tx, rows: BillingDoRow[]) {
    const fails: {
      deliveryOrderId: string;
      doNo: string | null;
      reasons: NotReadyReason[];
      missing?: unknown[];
    }[] = [];
    // ST5-T12b: ตรวจทั้งชุดด้วย query คงที่ (ไม่ query ต่อ DO — ร่าง ≤ 1,000 DO) · ผลต่อ DO = `release.check`
    const checks = await this.release.checkMany(tx, rows);
    for (const d of rows) {
      const c = checks.get(d.id)!;
      const reasons = c.reasons.filter((r) => r !== 'IN_INVOICE');
      if (!c.released && !reasons.includes('NOT_DELIVERED')) reasons.push('NOT_RELEASED');
      if (reasons.length)
        fails.push({
          deliveryOrderId: encodeId('deliveryOrder', d.id),
          doNo: d.doNo,
          reasons,
          ...(c.missing ? { missing: c.missing } : {}),
        });
    }
    if (fails.length)
      throw new ProblemException('not_ready_to_bill', undefined, undefined, {
        reasons: [...new Set(fails.flatMap((f) => f.reasons))],
        deliveryOrders: fails,
      });
  }

  private async buildLines(tx: Tx, rows: BillingDoRow[]): Promise<RevenueInvoiceLineInput[]> {
    const lines = await tx.revenueLine.findMany({
      where: { deliveryOrderId: { in: rows.map((r) => r.id) }, status: 'ACTIVE' },
      orderBy: [{ salesOrderId: 'asc' }, { lineNo: 'asc' }],
      include: { serviceItem: { select: { unitLabel: true, defaultAccountCode: true } } },
    });
    const units = new Map(
      (
        await tx.$queryRaw<{ id: string; unit: string | null }[]>`
          SELECT l.id, ${LINE_UNIT_EXPR} AS unit FROM revenue_line l ${LINE_UNIT_JOINS}
           WHERE l.id = ANY(${lines.map((l) => l.id)}::uuid[])`
      ).map((r) => [r.id, r.unit]),
    );
    return lines.map((l) => ({
      deliveryOrderId: l.deliveryOrderId!,
      revenueLineId: l.id,
      doSurchargeId: l.sourceType === 'DO_SURCHARGE' ? l.sourceId : null,
      serviceItemId: l.serviceItemId,
      description: l.description,
      quantity: l.qty.toFixed(4),
      unitLabel:
        units.get(l.id) ??
        (l.serviceItemSnapshot as ServiceItemSnapshot | null)?.unitLabel ??
        l.serviceItem.unitLabel,
      unitPrice: money(l.unitPrice),
      amount: money(l.amount),
      vatType: l.vatType,
      whtRate: money(l.whtRate),
      accountCode: l.serviceItem.defaultAccountCode,
    }));
  }

  /** ST5-T09: คำนวณยอดหัวใบใหม่ก่อนออกเลข (ค่าตั้ง WHT อาจเปลี่ยนหลังแก้ร่างครั้งล่าสุด) — ไม่เพิ่ม version */
  async refreshTotals(tx: Tx, id: string): Promise<void> {
    await this.recompute(tx, id, false);
  }

  /** ยอดหัวใบ + VAT รายบรรทัด (แสดงผล) จากบรรทัดที่ยังใช้ — computeDocumentTax (ประมาณการ D-54) */
  async recompute(tx: Tx, id: string, bump: boolean) {
    const lines = await tx.invoiceLine.findMany({
      where: { invoiceId: id, active: true },
      orderBy: { lineNo: 'asc' },
    });
    const settings = await readSettings(tx, requestContext.require().tenantId!, [
      'tax.whtMinimumAmount',
    ]);
    const tax = computeDocumentTax(
      lines.map((l) => ({
        amount: satangFromDecimal(money(l.amount)),
        vatType: toCalcVatType(l.vatType as Parameters<typeof toCalcVatType>[0]),
        whtRate: toCalcWhtRate(money(l.whtRate)),
      })),
      taxOptionsFromSettings({ whtMinimumAmount: settings['tax.whtMinimumAmount'] as number }),
    );
    // ST5-T12b: VAT รายบรรทัดที่เปลี่ยน อัปเดตในคำสั่งเดียว (เดิม 1 คำสั่งต่อบรรทัด — ร่าง 1,000 DO = หลายพันคำสั่ง)
    const changed = lines.flatMap((l, i) => {
      const vat = decimalFromSatang(tax.lines[i]!.vat);
      return money(l.vatAmount) !== vat ? [{ id: l.id, vat }] : [];
    });
    if (changed.length)
      await tx.$executeRaw`
        UPDATE invoice_line l SET vat_amount = v.vat
          FROM unnest(${changed.map((c) => c.id)}::uuid[], ${changed.map((c) => c.vat)}::numeric[]) AS v(id, vat)
         WHERE l.id = v.id AND l.invoice_id = ${id}::uuid`;
    const discount = lines.reduce((a, l) => a.add(l.discount), new Prisma.Decimal(0));
    await tx.invoice.update({
      where: { id },
      data: {
        subtotalExempt: decimalFromSatang(tax.exemptBase),
        subtotalVatable: decimalFromSatang(tax.vatableBase),
        subtotalZeroRated: decimalFromSatang(tax.zeroRatedBase),
        vatAmount: decimalFromSatang(tax.vat),
        totalAmount: decimalFromSatang(tax.grandTotal),
        whtExpectedAmount: decimalFromSatang(tax.wht),
        netExpectedAmount: decimalFromSatang(tax.netPayable),
        discountAmount: discount,
        ...(bump
          ? {
              version: { increment: 1 },
              updatedBy: requestContext.require().actorId ?? null,
            }
          : {}),
      },
    });
  }

  private async activeLine(tx: Tx, invoiceId: string, lineId: string) {
    const line = await tx.invoiceLine.findFirst({ where: { id: lineId, invoiceId } });
    if (!line) throw new ProblemException('not_found');
    if (!line.active)
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        lineStatus: 'REMOVED',
      });
    return line;
  }

  private async activeLines(tx: Tx, invoiceId: string, refs: string[]) {
    const ids = refs.map((r) => tryDecodeId('invoiceLine', r));
    const lines = await tx.invoiceLine.findMany({
      where: { invoiceId, active: true, id: { in: ids.filter((x): x is string => !!x) } },
      orderBy: { lineNo: 'asc' },
    });
    const found = new Set(lines.map((l) => l.id));
    const errors = refs.flatMap((r, i) =>
      ids[i] && found.has(ids[i]!) && ids.indexOf(ids[i]) === i
        ? []
        : [
            {
              field: `lineIds[${i}]`,
              code: ids[i] && found.has(ids[i]!) ? 'duplicate' : 'not_on_invoice',
              message: 'not an active line of this draft',
            },
          ],
    );
    if (errors.length) throw invalid(errors);
    return lines;
  }

  /** DO ที่ส่งมา (`do_…`) — รูปแบบผิด = ไม่พบ (422 ต่อช่อง) */
  private decodeDos(refs: string[]): string[] {
    const ids = refs.map((r) => tryDecodeId('deliveryOrder', r));
    const errors = refs.flatMap((_, i) =>
      ids[i] ? [] : [{ field: `deliveryOrderIds[${i}]`, code: 'not_found', message: 'not found' }],
    );
    if (errors.length) throw invalid(errors);
    return ids as string[];
  }

  private async doNos(tx: Tx, ids: string[]) {
    const rows = await tx.deliveryOrder.findMany({
      where: { id: { in: ids } },
      select: { id: true, doNo: true },
    });
    return ids.map((id) => rows.find((r) => r.id === id)?.doNo ?? encodeId('deliveryOrder', id));
  }

  private async doCounts(tx: Tx, ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await tx.invoiceLine.groupBy({
      by: ['invoiceId'],
      where: {
        invoiceId: { in: ids },
        // ST5-T10 ใบที่ยกเลิก/ลดหนี้เต็มใบ นับ DO ของเอกสาร ณ วันยกเลิก
        OR: [{ active: true }, { releasedWithInvoice: true }],
        doAnchor: true,
        deliveryOrderId: { not: null },
      },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.invoiceId, r._count._all]));
  }

  private async customerRef(tx: Tx, ref: string): Promise<string | null> {
    if (ref.startsWith(EXT_PREFIX)) {
      const ext = ref.slice(EXT_PREFIX.length);
      if (!EXTERNAL_ID_RE.test(ext)) return null;
      const c = await tx.customer.findFirst({
        where: { externalId: ext, deletedAt: null },
        select: { id: true },
      });
      return c?.id ?? null;
    }
    return tryDecodeId('customer', ref);
  }

  /**
   * ผู้ออกใบ: บริษัทวางบิลตั้งต้นของลูกค้า (ไม่ตั้ง = บริษัทเดียวของ tenant / บริษัทแรกที่มีสาขาผู้ออกตั้งต้น) ·
   * สาขาผู้ออก = สาขาผู้ออกตั้งต้นของบริษัท → สำนักงานใหญ่ (00000) · ไม่มี → 422 `issuer_missing`
   */
  private async issuer(tx: Tx, preferred: string | null) {
    const companies = await tx.company.findMany({
      where: { status: 'ACTIVE', ...(preferred ? { id: preferred } : {}) },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const branches = await tx.branch.findMany({
      where: { companyId: { in: companies.map((c) => c.id) } },
      orderBy: { branchCode: 'asc' },
    });
    for (const c of companies) {
      const own = branches.filter((x) => x.companyId === c.id);
      const b = own.find((x) => x.isDefaultIssuer) ?? own.find((x) => x.branchCode === '00000');
      if (b) return { companyId: c.id, branchId: b.id };
    }
    throw invalid([
      {
        field: 'customerId',
        code: 'issuer_missing',
        message: 'no issuing company/branch is set up (settings → legal entities)',
      },
    ]);
  }

  private checkPeriod(from?: string, to?: string) {
    const errors = (
      [
        ['periodFrom', from],
        ['periodTo', to],
      ] as const
    ).flatMap(([f, v]) =>
      v !== undefined && !isRealDay(v)
        ? [{ field: f, code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' }]
        : [],
    );
    if (errors.length) throw invalid(errors);
  }
}

function headerOf(i: {
  periodFrom: Date | null;
  periodTo: Date | null;
  lineMode: string;
  creditTermDays: number;
  customerPoNo: string | null;
  note: string | null;
}) {
  return {
    periodFrom: i.periodFrom ? ymd(i.periodFrom) : null,
    periodTo: i.periodTo ? ymd(i.periodTo) : null,
    lineMode: i.lineMode,
    creditTermDays: i.creditTermDays,
    customerPoNo: i.customerPoNo,
    note: i.note,
  };
}

/** snapshot ลูกค้า/ผู้ออก ณ วันออก (ST5-T09 — `invoice.customer_snapshot` / `issuer_snapshot`) */
export interface InvoicePartySnapshot {
  code?: string;
  name: string;
  taxId: string | null;
  branchCode: string | null;
  address: string;
  vatRegistered?: boolean;
}

/** ใบที่ออกแล้ว = ชื่อ/เลขผู้เสียภาษี/สาขา ณ วันออก (snapshot) · ร่าง = ข้อมูลลูกค้าปัจจุบัน */
function customerDto(c: InvoiceRow['customer'], snap?: unknown) {
  const x = snap as InvoicePartySnapshot | null | undefined;
  return {
    id: encodeId('customer', c.id),
    code: x?.code ?? c.code,
    legalName: x?.name ?? c.legalName,
    taxId: x ? x.taxId : c.taxId,
    branchCode: x ? x.branchCode : c.branchCode,
  };
}

/**
 * ST5-T18 (review M1) เกินกำหนดที่อ่าน = ธงที่ job/การรับชำระตั้งไว้ **หรือ** ค้างรับ + ยอดตัด < ยอดรวม + ครบกำหนด < วันนี้ (เวลาไทย)
 * — หน้าจอไม่พลาดเมื่อ worker ล่มหรือช่วงก่อน job 00:05 (ธงที่เก็บยังใช้กับ audit/การล้างธง)
 */
export function overdueWhere(tx: Tx, today: string): Prisma.InvoiceWhereInput {
  return {
    OR: [
      { overdueAt: { not: null } },
      {
        status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
        dueDate: { lt: day(today) },
        paidAmount: { lt: tx.invoice.fields.totalAmount },
      },
    ],
  };
}

/**
 * ST5-T22 ใบค้างรับในช่วงอายุ (ชุดเดียวกับ `AgingService` — ยอดในการ์ด "อายุลูกหนี้" ตรงกับตารางที่กรอง)
 * daysPastDue = วันนี้ − dueDate ∈ [lo, hi] ⇔ dueDate ∈ [วันนี้ − hi, วันนี้ − lo] · ไม่มีวันครบกำหนด = ยังไม่ครบกำหนด
 */
export function agingWhere(tx: Tx, bucket: AgingBucket, today: string): Prisma.InvoiceWhereInput {
  const [lo, hi] = AGING_BUCKET_RANGE[bucket];
  const due: Prisma.DateTimeNullableFilter = {};
  if (hi !== null) due.gte = day(addDays(today, -hi));
  if (lo !== null) due.lte = day(addDays(today, -lo));
  return {
    status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
    paidAmount: { lt: tx.invoice.fields.totalAmount },
    ...(lo === null ? { OR: [{ dueDate: null }, { dueDate: due }] } : { dueDate: due }),
  };
}

function isOverdue(
  r: {
    status: string;
    overdueAt: Date | null;
    totalAmount: Prisma.Decimal;
    paidAmount: Prisma.Decimal;
    dueDate: Date | null;
  },
  today: string,
): boolean {
  if (r.overdueAt) return true;
  return invoiceOverdue(
    r.status as InvoiceStatus,
    satangFromDecimal(r.totalAmount.toFixed(2)),
    satangFromDecimal(r.paidAmount.toFixed(2)),
    r.dueDate ? ymd(r.dueDate) : null,
    today,
  );
}

function summary(
  r: Prisma.InvoiceGetPayload<{ include: { customer: typeof LOAD.customer } }>,
  doCount: number,
  today: string,
): InvoiceSummaryDto {
  return {
    id: encodeId('invoice', r.id),
    invoiceNo: r.invoiceNo,
    status: r.status as InvoiceStatus,
    customer: customerDto(r.customer, r.customerSnapshot),
    periodFrom: r.periodFrom ? ymd(r.periodFrom) : null,
    periodTo: r.periodTo ? ymd(r.periodTo) : null,
    deliveryOrderCount: doCount,
    lineMode: r.lineMode as InvoiceLineMode,
    sellTotal: money(r.totalAmount),
    sellNetExpected: money(r.netExpectedAmount),
    sellPaidAmount: money(r.paidAmount),
    sellOutstanding: RECEIVABLE_STATUSES.includes(r.status)
      ? money(r.totalAmount.sub(r.paidAmount))
      : '0.00',
    issueDate: r.issueDate ? ymd(r.issueDate) : null,
    dueDate: r.dueDate ? ymd(r.dueDate) : null,
    overdue: isOverdue(r, today),
    overdueAt: r.overdueAt ? r.overdueAt.toISOString() : null,
    sentToCustomerAt: r.sentToCustomerAt ? r.sentToCustomerAt.toISOString() : null,
    sentToCustomerChannel: (r.sentToCustomerChannel as InvoiceSentChannel | null) ?? null,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function lineDto(l: LineRow): InvoiceLineDto {
  return {
    id: encodeId('invoiceLine', l.id),
    lineNo: l.lineNo,
    deliveryOrderId: l.deliveryOrderId ? encodeId('deliveryOrder', l.deliveryOrderId) : null,
    deliveryOrderNo: l.deliveryOrder?.doNo ?? null,
    revenueLineId: l.revenueLineId ? encodeId('revenueLine', l.revenueLineId) : null,
    kind: l.revenueLine?.kind ?? null,
    serviceItemId: encodeId('serviceItem', l.serviceItemId),
    description: l.description,
    quantity: new Prisma.Decimal(l.quantity).toString(),
    unitLabel: l.unitLabel,
    sellUnitPrice: money(l.unitPrice),
    sellDiscount: money(l.discount),
    sellAmount: money(l.amount),
    sellVatAmount: money(l.vatAmount),
    vatType: l.vatType as VatType,
    whtRate: money(l.whtRate),
    printGroup: l.printGroup,
    isUserAdded: l.isUserAdded,
    active: l.active,
    releasedWithInvoice: l.releasedWithInvoice,
    removeReason: l.removeReason,
  };
}

function toDto(r: InvoiceRow, today: string): InvoiceDto {
  // บรรทัดของเอกสาร: ที่ยังใช้ + ที่หยุดนับเพราะใบถูกยกเลิก (ST5-T10 — ใบที่ยกเลิกยังแสดงรายการเดิม) — ไม่รวมที่ถอดออกจากร่าง
  const active = r.lines.filter((l) => l.active || l.releasedWithInvoice);
  const dos = new Map<string, InvoiceDto['deliveryOrders'][number]>();
  const perDo = new Map<string, Prisma.Decimal>();
  for (const l of active) {
    if (!l.deliveryOrder) continue;
    perDo.set(
      l.deliveryOrder.id,
      (perDo.get(l.deliveryOrder.id) ?? new Prisma.Decimal(0)).add(l.amount),
    );
    if (!dos.has(l.deliveryOrder.id))
      dos.set(l.deliveryOrder.id, {
        id: encodeId('deliveryOrder', l.deliveryOrder.id),
        doNo: l.deliveryOrder.doNo,
        doDate: ymd(l.deliveryOrder.doDate),
        originSiteName: l.deliveryOrder.originSite.name,
        destSiteName: l.deliveryOrder.destSite.name,
        sellAmount: '0.00',
      });
  }
  for (const [k, v] of dos) v.sellAmount = money(perDo.get(k)!);
  const print = invoicePrintLines(
    active.map((l) => ({
      id: encodeId('invoiceLine', l.id),
      lineNo: l.lineNo,
      serviceItemId: l.serviceItemId,
      description: l.description,
      quantity: new Prisma.Decimal(l.quantity).toString(),
      unitLabel: l.unitLabel,
      unitPrice: money(l.unitPrice),
      amount: money(l.amount),
      discount: money(l.discount),
      vatType: l.vatType,
      whtRate: money(l.whtRate),
      printGroup: l.printGroup,
      deliveryOrderNo: l.deliveryOrder?.doNo ?? null,
    })),
    r.lineMode as InvoiceLineMode,
  );
  return {
    ...summary(r, dos.size, today),
    issuingCompanyId: encodeId('company', r.issuingCompanyId),
    issuingBranchId: encodeId('branch', r.issuingBranchId),
    creditTermDays: r.creditTermDays,
    customerPoNo: r.customerPoNo,
    note: r.note,
    sellSubtotalExempt: money(r.subtotalExempt),
    sellSubtotalVatable: money(r.subtotalVatable),
    sellSubtotalZeroRated: money(r.subtotalZeroRated),
    sellVatAmount: money(r.vatAmount),
    sellWhtExpected: money(r.whtExpectedAmount),
    sellDiscountTotal: money(r.discountAmount),
    taxEstimated: true,
    deliveryOrders: [...dos.values()],
    lines: r.lines.map(lineDto),
    printLines: print.map((p) => ({
      no: p.no,
      lineIds: p.lineIds,
      description: p.description,
      quantity: p.quantity,
      unitLabel: p.unitLabel,
      sellUnitPrice: p.unitPrice,
      sellDiscount: p.discount,
      sellAmount: p.amount,
      vatType: p.vatType,
      whtRate: p.whtRate,
      deliveryOrderNos: p.deliveryOrderNos,
      manual: p.manual,
    })),
    cancelReason: r.cancelReason,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    replacesInvoice: r.replaces
      ? {
          id: encodeId('invoice', r.replaces.id),
          invoiceNo: r.replaces.invoiceNo,
          issueDate: r.replaces.issueDate ? ymd(r.replaces.issueDate) : null,
        }
      : null,
    replacedByInvoice: (() => {
      const x = r.replacedBy.find((i) => i.status !== 'CANCELLED') ?? r.replacedBy[0];
      return x
        ? {
            id: encodeId('invoice', x.id),
            invoiceNo: x.invoiceNo,
            status: x.status as InvoiceStatus,
          }
        : null;
    })(),
    createdBy: r.createdBy,
    issuedAt: r.issuedAt?.toISOString() ?? null,
    issuedBy: r.issuedBy,
    pdf:
      r.pdfDocument && r.pdfDocument.sha256
        ? {
            documentId: encodeId('document', r.pdfDocument.id),
            filename: r.pdfDocument.filename ?? `${r.invoiceNo ?? 'invoice'}.pdf`,
            sha256: r.pdfDocument.sha256,
            sizeBytes: r.pdfDocument.sizeBytes,
          }
        : null,
    billingNoteId: r.billingNoteLinks[0]
      ? encodeId('billingNote', r.billingNoteLinks[0].billingNoteId)
      : null,
  };
}
