import { Injectable } from '@nestjs/common';
import { Prisma, type ChequeStatus, type PaymentMethod } from '@prisma/client';
import {
  PAYABLE_INVOICE_STATUSES,
  eventDefinition,
  scopeAllows,
  type InvoiceStatus,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { EXT_PREFIX, EXTERNAL_ID_RE } from '../../common/external-id';
import { encodeId, tryDecodeId } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { redactPrices } from '../../common/price-fields';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { readSettings } from '../settings/settings.service';
import { InvoiceStatusService } from '../invoices/invoice-status.service';
import { issueNumber } from '../sequences/sequences.service';
import { addDays, bangkokToday, isRealDate } from '../vehicle-documents/expiry';
import type {
  CreatePaymentDto,
  PaymentDto,
  PaymentListQuery,
  PaymentPageDto,
  PaymentSummaryDto,
} from './payment.dto';

const ENTITY = 'payment';
const NONE = '00000000-0000-0000-0000-000000000000';
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const money = (d: Prisma.Decimal | string | number) => new Prisma.Decimal(d).toFixed(2);
const ZERO = new Prisma.Decimal(0);

const LOAD = {
  customer: { select: { id: true, code: true, legalName: true } },
  allocations: {
    orderBy: { createdAt: 'asc' },
    include: { invoice: { select: { id: true, invoiceNo: true } } },
  },
} as const satisfies Prisma.PaymentInclude;
type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof LOAD }>;

function invalid(errors: FieldError[]): ProblemException {
  return new ProblemException('validation_failed', undefined, errors);
}

export function toPaymentDto(r: PaymentRow): PaymentDto {
  const applied = r.allocations.reduce((a, x) => a.add(x.amount), ZERO);
  return {
    id: encodeId('payment', r.id),
    paymentNo: r.paymentNo,
    customer: {
      id: encodeId('customer', r.customer.id),
      code: r.customer.code,
      legalName: r.customer.legalName,
    },
    receivedDate: ymd(r.receivedDate),
    method: r.method,
    reference: r.reference,
    chequeNo: r.chequeNo,
    chequeBank: r.chequeBank,
    chequeDate: r.chequeDate ? ymd(r.chequeDate) : null,
    chequeStatus: r.chequeStatus,
    sellAmountReceived: money(r.amountReceived),
    sellWhtAmount: money(r.whtAmount),
    sellFeeAmount: money(r.feeAmount),
    sellDifferenceAmount: money(r.differenceAmount),
    sellAppliedTotal: money(applied),
    differenceReason: r.differenceReason,
    whtCertificateNo: r.whtCertificateNo,
    note: r.note,
    source: r.source,
    status: r.status,
    allocations: r.allocations.map((a) => ({
      invoiceId: encodeId('invoice', a.invoice.id),
      invoiceNo: a.invoice.invoiceNo,
      sellAmount: money(a.amount),
      sellWhtAmount: money(a.whtAmount),
    })),
    reversedAt: r.reversedAt?.toISOString() ?? null,
    reversedBy: r.reversedBy,
    reverseReason: r.reverseReason,
    createdBy: r.createdBy,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** `data.object` ของ event `payment.*` = DTO ของ REST − ราคา − omit (event registry) */
function eventObject(dto: PaymentDto): Record<string, unknown> {
  const o = JSON.parse(JSON.stringify(redactPrices(dto, []))) as Record<string, unknown>;
  for (const k of eventDefinition('payment.recorded')!.object!.omit) delete o[k];
  return o;
}

/**
 * รับชำระ (ST5-T13 — **บัญชีเบา D-54: บันทึกเงิน/เช็คใน TMS (D-57) ไม่ออกใบเสร็จ (D-56)**; docs/04 F5 "บันทึกรับชำระ", F4 "แก้รับชำระด้วย
 * reversal entry"; docs/01 §3.4 payment / payment_allocation; spec/05 §4 BIL-050/051/060/061)
 *
 * - บันทึก: ใบแจ้งหนี้ที่ออกแล้วของลูกค้ารายเดียว (หลายใบได้ — BIL-050) · ยอดตัดต่อใบ ≤ คงค้าง (**ล็อกใบเรียงตาม id** — 2 คำขอพร้อมกัน
 *   ตัดใบเดียวกันเกินไม่ได้; CHECK `invoice_paid_amount_check` เป็นด่านสุดท้าย) · เงินรับ + WHT + ค่าธรรมเนียม + ส่วนต่าง = Σ ยอดตัด (BIL-051)
 *   · ออกเลขภายใน PAY · สถานะใบจาก `InvoiceStatusService.apply` (ST5-T18 + webhook `invoice.paid`) · audit + event `payment.recorded` (transaction เดียว)
 * - แก้/ลบไม่ได้ (trigger) → กลับรายการ (`payments:reverse` + เหตุผล + If-Match) — ยอดค้างของใบกลับมา · event `payment.reversed`
 * - เช็ค: เลขเช็ค ธนาคาร วันที่เช็ค สถานะ (รอเคลียร์ → ผ่าน) · เช็คคืน = กลับรายการ + `chequeStatus` BOUNCED (BIL-060)
 * - WHT ที่ลูกค้าหัก = บันทึกยอด (+ เลขที่ 50 ทวิ ที่ลูกค้าแจ้ง) — รับ/ตรวจ 50 ทวิ อยู่ที่ระบบบัญชี (D-54 ย้าย ST5-T17)
 * - ส่งต่อระบบบัญชี (ร่าง RV) = ST8-T16 อ่านจากตารางนี้ / event
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly status: InvoiceStatusService,
  ) {}

  // ---------- อ่าน ----------

  async list(q: PaymentListQuery): Promise<PaymentPageDto> {
    const tx = this.db.tx;
    const k = keysetArgs(q);
    const and: Prisma.PaymentWhereInput[] = [k.where as Prisma.PaymentWhereInput];
    if (q.status) and.push({ status: q.status });
    if (q.invoiceId !== undefined)
      and.push({
        allocations: { some: { invoiceId: tryDecodeId('invoice', q.invoiceId) ?? NONE } },
      });
    if (q.customerId !== undefined)
      and.push({ customerId: (await this.customerRef(tx, q.customerId)) ?? NONE });
    const rows = await tx.payment.findMany({
      where: { AND: and },
      orderBy: k.orderBy as unknown as Prisma.PaymentOrderByWithRelationInput[],
      take: k.take,
      include: LOAD,
    });
    return toPage(rows, k, toPaymentDto, q.fields) as PaymentPageDto;
  }

  async get(id: string, tx: Tx = this.db.tx): Promise<PaymentDto> {
    const r = await tx.payment.findUnique({ where: { id }, include: LOAD });
    if (!r) throw new ProblemException('not_found');
    return toPaymentDto(r);
  }

  /** KPI หน้า "รับชำระ" — วันครบกำหนด/เดือน ตามเวลาไทย */
  async summary(): Promise<PaymentSummaryDto> {
    const tx = this.db.tx;
    const today = bangkokToday(this.clock.now());
    const monthStart = `${today.slice(0, 7)}-01`;
    const soon = addDays(today, 7);
    const rows = await tx.$queryRaw<
      {
        total: bigint;
        open: bigint;
        overdue: bigint;
        partially_paid: bigint;
        paid: bigint;
        due_soon: bigint;
        outstanding: Prisma.Decimal;
        overdue_outstanding: Prisma.Decimal;
      }[]
    >`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status IN ('ISSUED', 'PARTIALLY_PAID')) AS open,
             COUNT(*) FILTER (WHERE (overdue_at IS NOT NULL OR (status IN ('ISSUED', 'PARTIALLY_PAID') AND paid_amount < total_amount AND due_date < ${day(today)}::date))) AS overdue,
             COUNT(*) FILTER (WHERE status = 'PARTIALLY_PAID' AND NOT (overdue_at IS NOT NULL OR (status IN ('ISSUED', 'PARTIALLY_PAID') AND paid_amount < total_amount AND due_date < ${day(today)}::date))) AS partially_paid,
             COUNT(*) FILTER (WHERE status = 'PAID') AS paid,
             COUNT(*) FILTER (WHERE status IN ('ISSUED', 'PARTIALLY_PAID')
                                AND due_date >= ${day(today)}::date AND due_date <= ${day(soon)}::date) AS due_soon,
             COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE status IN ('ISSUED', 'PARTIALLY_PAID')), 0) AS outstanding,
             COALESCE(SUM(total_amount - paid_amount)
               FILTER (WHERE (overdue_at IS NOT NULL OR (status IN ('ISSUED', 'PARTIALLY_PAID') AND paid_amount < total_amount AND due_date < ${day(today)}::date))), 0) AS overdue_outstanding
        FROM invoice WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'ADJUSTED')`;
    // review M1: นับเฉพาะเงินเข้าจริง (amount_received) — ไม่นับ WHT/ค่าธรรมเนียม/ส่วนต่างที่ตัดยอด
    const rec = await tx.$queryRaw<{ amt: Prisma.Decimal }[]>`
      SELECT COALESCE(SUM(p.amount_received), 0) AS amt
        FROM payment p
       WHERE p.status = 'RECORDED' AND p.received_date >= ${day(monthStart)}::date
         AND p.received_date <= ${day(today)}::date`;
    const r = rows[0]!;
    return {
      sellOutstanding: money(r.outstanding),
      sellOverdueOutstanding: money(r.overdue_outstanding),
      sellReceivedThisMonth: money(rec[0]!.amt),
      dueSoon: Number(r.due_soon),
      total: Number(r.total),
      open: Number(r.open),
      overdue: Number(r.overdue),
      partiallyPaid: Number(r.partially_paid),
      paid: Number(r.paid),
    };
  }

  // ---------- บันทึก ----------

  async record(body: CreatePaymentDto): Promise<PaymentDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const now = this.clock.now();
    const input = this.validate(body, bangkokToday(now));

    // ล็อกใบเรียงตาม id (กัน deadlock) — ตรวจยอดคงค้างหลังได้ล็อก (2 คำขอพร้อมกัน = รอกัน แล้วรายที่สองเห็นยอดใหม่)
    const ids = [...input.allocations.map((a) => a.invoiceId)].sort();
    await tx.$queryRaw`SELECT id FROM invoice WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const invoices = await tx.invoice.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        invoiceNo: true,
        status: true,
        customerId: true,
        totalAmount: true,
        paidAmount: true,
        issueDate: true,
      },
    });
    const byId = new Map(invoices.map((i) => [i.id, i]));
    const missing = input.allocations.findIndex((a) => !byId.has(a.invoiceId));
    if (missing >= 0)
      throw invalid([
        {
          field: `allocations[${missing}].invoiceId`,
          code: 'not_found',
          message: 'invoice not found',
        },
      ]);
    const customers = new Set(invoices.map((i) => i.customerId));
    if (customers.size > 1)
      throw invalid([
        {
          field: 'allocations',
          code: 'mixed_customers',
          message: 'all invoices must belong to the same customer',
        },
      ]);
    for (const a of input.allocations) {
      const inv = byId.get(a.invoiceId)!;
      if (!PAYABLE_INVOICE_STATUSES.includes(inv.status as InvoiceStatus))
        throw new ProblemException('invoice_not_payable', undefined, undefined, {
          invoiceId: encodeId('invoice', inv.id),
          currentStatus: inv.status,
        });
      const outstanding = inv.totalAmount.sub(inv.paidAmount);
      if (a.amount.greaterThan(outstanding))
        throw new ProblemException('payment_exceeds_outstanding', undefined, undefined, {
          invoiceId: encodeId('invoice', inv.id),
          invoiceNo: inv.invoiceNo,
          outstanding: money(outstanding),
        });
    }
    // review L4: วันที่รับต้องไม่ก่อนวันที่ออกใบแจ้งหนี้
    const early = input.allocations.findIndex((a) => {
      const d = byId.get(a.invoiceId)!.issueDate;
      return d !== null && input.receivedDate < ymd(d);
    });
    if (early >= 0)
      throw invalid([
        {
          field: 'receivedDate',
          code: 'before_invoice_issue',
          message: `receivedDate must not be before the issue date of allocations[${early}]`,
        },
      ]);
    // review M1 (spec/05 BIL-059 "ผลต่างเล็กน้อย ≤ ค่าที่ตั้ง → manager อนุมัติ"): ส่วนต่างเกินวงเงินของ tenant ต้องมีสิทธิ์ผู้จัดการ
    if (input.differenceAmount.greaterThan(0)) {
      const cap = Number(
        (await readSettings(tx, ctx.tenantId!, ['payments.maxDifferenceAmount']))[
          'payments.maxDifferenceAmount'
        ] ?? 10,
      );
      if (
        input.differenceAmount.greaterThan(cap) &&
        !scopeAllows(ctx.scopes ?? [], 'payments:reverse')
      )
        throw new ProblemException('payment_difference_over_limit', undefined, undefined, {
          maxDifferenceAmount: money(cap),
          requiredScope: 'payments:reverse',
        });
    }
    const customerId = invoices[0]!.customerId;
    const paymentNo = await this.issuePaymentNo(tx, ctx.tenantId!, now);
    const created = await tx.payment.create({
      data: {
        tenantId: ctx.tenantId!,
        paymentNo,
        customerId,
        receivedDate: day(input.receivedDate),
        method: input.method,
        reference: input.reference,
        chequeNo: input.chequeNo,
        chequeBank: input.chequeBank,
        chequeDate: input.chequeDate ? day(input.chequeDate) : null,
        chequeStatus: input.method === 'CHEQUE' ? 'PENDING' : null,
        amountReceived: input.amountReceived,
        whtAmount: input.whtAmount,
        whtCertificateNo: input.whtCertificateNo,
        feeAmount: input.feeAmount,
        differenceAmount: input.differenceAmount,
        differenceReason: input.differenceReason,
        note: input.note,
        createdBy: ctx.actorId ?? null,
      },
    });
    for (const a of input.allocations)
      await tx.paymentAllocation.create({
        data: {
          tenantId: ctx.tenantId!,
          paymentId: created.id,
          invoiceId: a.invoiceId,
          amount: a.amount,
          whtAmount: a.whtAmount,
        },
      });
    const changes = await this.status.apply(tx, ids, now);
    const out = await this.get(created.id, tx);
    await this.audit.record({
      action: 'payment.recorded',
      entityType: ENTITY,
      entityId: created.id,
      after: {
        paymentNo,
        method: out.method,
        receivedDate: out.receivedDate,
        chequeNo: out.chequeNo,
        chequeBank: out.chequeBank,
        chequeDate: out.chequeDate,
        sellAmountReceived: out.sellAmountReceived,
        sellWhtAmount: out.sellWhtAmount,
        sellFeeAmount: out.sellFeeAmount,
        sellDifferenceAmount: out.sellDifferenceAmount,
        allocations: out.allocations,
        invoices: changes.map((c) => ({ ...c, id: encodeId('invoice', c.id) })),
      },
      ...(input.differenceReason ? { reason: input.differenceReason } : {}),
    });
    await this.event(tx, 'payment.recorded', out, {});
    return out;
  }

  /** เลข PAY — ชุดเลขสร้างตอนตั้ง tenant (bootstrap) · tenant เก่าที่ยังไม่มีชุดนี้ สร้างให้ตอนใช้ครั้งแรก */
  private async issuePaymentNo(tx: Tx, tenantId: string, at: Date): Promise<string> {
    await tx.documentSeries.upsert({
      where: { tenantId_docType: { tenantId, docType: 'PAY' } },
      create: {
        tenantId,
        docType: 'PAY',
        prefix: 'PAY-',
        resetPolicy: 'MONTHLY',
        perBranch: false,
      },
      update: {},
    });
    return issueNumber(tx, tenantId, { docType: 'PAY', at });
  }

  // ---------- กลับรายการ / เช็ค ----------

  /** กลับรายการ (BIL-061 แบบไม่มีใบเสร็จ) — ยอดค้างของใบกลับมา · เหตุผล + audit · If-Match บังคับ */
  reverse(id: string, expected: number | undefined, reason: string): Promise<PaymentDto> {
    return this.doReverse(id, expected, reason, false);
  }

  /** เช็คคืน (BIL-060): เช็คที่รอเคลียร์/ผ่านแล้ว → BOUNCED + กลับรายการ (เหตุผล + audit) */
  bounceCheque(id: string, expected: number | undefined, reason: string): Promise<PaymentDto> {
    return this.doReverse(id, expected, reason, true);
  }

  /** เช็คผ่าน (เคลียร์แล้ว): PENDING → CLEARED */
  async clearCheque(id: string, expected: number | undefined): Promise<PaymentDto> {
    const tx = this.db.tx;
    const p = await this.lock(tx, id, expected);
    if (p.method !== 'CHEQUE' || p.status !== 'RECORDED' || p.chequeStatus !== 'PENDING')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: p.status,
        chequeStatus: p.chequeStatus,
      });
    await tx.payment.update({
      where: { id },
      data: { chequeStatus: 'CLEARED', version: { increment: 1 } },
    });
    await this.audit.record({
      action: 'payment.cheque_cleared',
      entityType: ENTITY,
      entityId: id,
      before: { chequeStatus: 'PENDING' },
      after: { chequeStatus: 'CLEARED' },
    });
    return this.get(id, tx);
  }

  private async doReverse(
    id: string,
    expected: number | undefined,
    reason: string,
    bounce: boolean,
  ): Promise<PaymentDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const now = this.clock.now();
    const p = await this.lock(tx, id, expected);
    const chequeOk =
      p.method === 'CHEQUE' && (p.chequeStatus === 'PENDING' || p.chequeStatus === 'CLEARED');
    if (p.status !== 'RECORDED' || (bounce && !chequeOk))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: p.status,
        ...(bounce ? { method: p.method, chequeStatus: p.chequeStatus } : {}),
      });
    const before = await this.get(id, tx);
    const invoiceIds = (
      await tx.paymentAllocation.findMany({ where: { paymentId: id }, select: { invoiceId: true } })
    )
      .map((a) => a.invoiceId)
      .sort();
    await tx.$queryRaw`SELECT id FROM invoice WHERE id = ANY(${invoiceIds}::uuid[]) ORDER BY id FOR UPDATE`;
    const chequeStatus: ChequeStatus | null = bounce ? 'BOUNCED' : p.chequeStatus;
    await tx.payment.update({
      where: { id },
      data: {
        status: 'REVERSED',
        reversedAt: now,
        reversedBy: ctx.actorId ?? 'system',
        reverseReason: reason,
        chequeStatus,
        version: { increment: 1 },
      },
    });
    const changes = await this.status.apply(tx, invoiceIds, now);
    const out = await this.get(id, tx);
    await this.audit.record({
      action: bounce ? 'payment.cheque_bounced' : 'payment.reversed',
      entityType: ENTITY,
      entityId: id,
      before: { status: 'RECORDED', chequeStatus: p.chequeStatus },
      after: {
        status: 'REVERSED',
        chequeStatus,
        sellAppliedTotal: out.sellAppliedTotal,
        invoices: changes.map((c) => ({ ...c, id: encodeId('invoice', c.id) })),
      },
      reason,
    });
    await this.event(tx, 'payment.reversed', out, {
      status: before.status,
      chequeStatus: before.chequeStatus,
      reversedAt: null,
      version: before.version,
    });
    return out;
  }

  private async lock(tx: Tx, id: string, expected: number | undefined) {
    await tx.$queryRaw`SELECT id FROM payment WHERE id = ${id}::uuid FOR UPDATE`;
    const p = await tx.payment.findUnique({ where: { id } });
    if (!p) throw new ProblemException('not_found');
    // กลับรายการ/เช็ค = เปลี่ยนเงินที่ตัดยอดแล้ว ต้องอ้าง version ที่ผู้ทำเห็น (แบบออกเอกสาร ST5-T09)
    if (expected === undefined)
      throw invalid([
        {
          field: 'If-Match',
          code: 'if_match_required',
          message: 'send If-Match (ETag of the payment)',
        },
      ]);
    if (expected !== p.version) throw new ProblemException('precondition_failed');
    return p;
  }

  private async event(
    tx: Tx,
    type: 'payment.recorded' | 'payment.reversed',
    dto: PaymentDto,
    previous: Record<string, unknown>,
  ) {
    const ctx = requestContext.require();
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type,
        entityType: ENTITY,
        localId: tryDecodeId('payment', dto.id)!,
        snapshot: eventObject(dto) as Prisma.InputJsonValue,
        previousAttributes: previous as Prisma.InputJsonValue,
        requestId: ctx.requestId ?? null,
        actorId: ctx.actorId ?? null,
      },
    });
  }

  // ---------- ตรวจคำขอ ----------

  private validate(b: CreatePaymentDto, today: string) {
    const errors: FieldError[] = [];
    const dec = (v: string | undefined) => new Prisma.Decimal(v ?? '0');
    if (!isRealDate(b.receivedDate))
      errors.push({ field: 'receivedDate', code: 'invalid_date', message: 'not a real date' });
    else if (b.receivedDate > today)
      errors.push({
        field: 'receivedDate',
        code: 'date_in_future',
        message: 'receivedDate must not be after today (Asia/Bangkok)',
      });
    // review L2: หักกลบลบหนี้ต้องมีเครดิตลูกค้า (BIL-058) ซึ่งยังไม่มี — ปิดไว้ก่อน
    if (b.method === 'OFFSET')
      errors.push({
        field: 'method',
        code: 'method_not_available',
        message: 'OFFSET is not available until customer credit (BIL-058) exists',
      });
    const cheque = b.method === 'CHEQUE';
    for (const f of ['chequeNo', 'chequeBank', 'chequeDate'] as const) {
      if (cheque && !b[f])
        errors.push({ field: f, code: 'required', message: `${f} is required for CHEQUE` });
      if (!cheque && b[f] !== undefined)
        errors.push({ field: f, code: 'not_allowed', message: `${f} is only for CHEQUE` });
    }
    if (cheque && b.chequeDate && !isRealDate(b.chequeDate))
      errors.push({ field: 'chequeDate', code: 'invalid_date', message: 'not a real date' });
    const amountReceived = dec(b.amountReceived);
    const whtAmount = dec(b.whtAmount);
    const feeAmount = dec(b.feeAmount);
    const differenceAmount = dec(b.differenceAmount);
    if (differenceAmount.greaterThan(0) && !b.differenceReason)
      errors.push({
        field: 'differenceReason',
        code: 'required',
        message: 'differenceReason is required when differenceAmount > 0',
      });
    const settled = amountReceived.add(whtAmount).add(feeAmount).add(differenceAmount);
    if (!settled.greaterThan(0))
      errors.push({
        field: 'amountReceived',
        code: 'amount_required',
        message: 'amountReceived + whtAmount + feeAmount + differenceAmount must be > 0',
      });
    const ids = b.allocations.map((a, i) => {
      const id = tryDecodeId('invoice', a.invoiceId);
      if (!id)
        errors.push({
          field: `allocations[${i}].invoiceId`,
          code: 'not_found',
          message: 'invoice not found',
        });
      return id ?? NONE;
    });
    if (new Set(ids).size !== ids.length)
      errors.push({ field: 'allocations', code: 'duplicate', message: 'invoice listed twice' });
    const single = b.allocations.length === 1;
    const allocations = b.allocations.map((a, i) => {
      const amount = dec(a.amount);
      if (!amount.greaterThan(0))
        errors.push({
          field: `allocations[${i}].amount`,
          code: 'amount_required',
          message: 'amount must be > 0',
        });
      if (!single && a.whtAmount === undefined && whtAmount.greaterThan(0))
        errors.push({
          field: `allocations[${i}].whtAmount`,
          code: 'required',
          message: 'whtAmount per invoice is required when allocating to several invoices',
        });
      const wht = a.whtAmount !== undefined ? dec(a.whtAmount) : single ? whtAmount : ZERO;
      if (wht.greaterThan(amount))
        errors.push({
          field: `allocations[${i}].whtAmount`,
          code: 'exceeds_amount',
          message: 'whtAmount must not exceed amount',
        });
      return { invoiceId: ids[i]!, amount, whtAmount: wht };
    });
    const applied = allocations.reduce((a, x) => a.add(x.amount), ZERO);
    // BIL-051 (ไม่มีเงินรับเกิน/เครดิตลูกค้าในเฟสนี้): เงินรับ + WHT + ค่าธรรมเนียม + ส่วนต่าง = Σ ยอดตัด
    if (!applied.equals(settled))
      errors.push({
        field: 'allocations',
        code: 'payment_unbalanced',
        message: `allocations ${money(applied)} ≠ received + wht + fee + difference ${money(settled)} (diff ${money(settled.sub(applied))})`,
      });
    const whtAllocated = allocations.reduce((a, x) => a.add(x.whtAmount), ZERO);
    if (!whtAllocated.equals(whtAmount))
      errors.push({
        field: 'whtAmount',
        code: 'wht_unbalanced',
        message: `Σ allocations.whtAmount ${money(whtAllocated)} ≠ whtAmount ${money(whtAmount)}`,
      });
    if (errors.length) throw invalid(errors);
    return {
      receivedDate: b.receivedDate,
      method: b.method as PaymentMethod,
      reference: b.reference || null,
      chequeNo: cheque ? b.chequeNo! : null,
      chequeBank: cheque ? b.chequeBank! : null,
      chequeDate: cheque ? b.chequeDate! : null,
      amountReceived,
      whtAmount,
      whtCertificateNo: b.whtCertificateNo || null,
      feeAmount,
      differenceAmount,
      differenceReason: differenceAmount.greaterThan(0) ? b.differenceReason! : null,
      note: b.note || null,
      allocations,
    };
  }

  private async customerRef(tx: Tx, ref: string): Promise<string | null> {
    if (ref.startsWith(EXT_PREFIX)) {
      const ext = ref.slice(EXT_PREFIX.length);
      if (!EXTERNAL_ID_RE.test(ext)) return null;
      return (
        (await tx.customer.findFirst({ where: { externalId: ext }, select: { id: true } }))?.id ??
        null
      );
    }
    return tryDecodeId('customer', ref);
  }
}
