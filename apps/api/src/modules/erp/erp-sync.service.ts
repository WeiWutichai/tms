import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { tryDecodeId } from '../../common/ids';
import type { Tx } from '../../db/db.service';
import { OutboxService } from '../integration/outbox.service';
import type { SettlementDto } from '../settlements/settlement.dto';
import {
  type CanonicalInvoicePayload,
  type CanonicalSettlementPayload,
  withSyncHash,
} from './canonical';
import { ConnectorResolver } from './connector-resolver';
import { ERP_SINK } from './erp-adapter.sink';

const money = (d: Prisma.Decimal | number | string | null | undefined) =>
  new Prisma.Decimal(d ?? 0).toFixed(2);
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** entity ใน external_mapping / integration_outbox */
export const ERP_ENTITY = {
  invoice: 'invoice',
  settlement: 'settlement',
  payment: 'payment',
} as const;

/**
 * ST8-T16 ทางส่งเอกสารเข้า ERP (ส่วนย่อยของ ST7-T16 push pipeline — ไม่ผูก ERP ใด)
 * เรียกใน transaction เดียวกับการเปลี่ยนสถานะเอกสาร (rollback = ไม่มีคำสั่ง) — คำสั่งเข้า `integration_outbox` sink `erp`
 * แล้ว ErpAdapterSink ส่งนอก transaction (ประตู capability / system-of-record / mapping ทำที่ sink)
 * - เฉพาะ connector ของนิติบุคคลของเอกสาร (routing ST7-T13) ที่ **เปิด capability นั้นอยู่** — ไม่มี/ปิด = Standalone ไม่มีคำสั่ง
 * - กันซ้ำ: payload เดิม = คำสั่งเดิม (`enqueueCommand` idempotency_key ตาม hash) + adapter ส่งเลข TMS เป็น ref กันซ้ำฝั่ง ERP
 * - ประตู `syncFromDate` / ส่งใหม่เมื่อเอกสารเปลี่ยน = ST7-T16
 */
@Injectable()
export class ErpSyncService {
  private readonly logger = new Logger('ErpSync');

  constructor(
    private readonly resolver: ConnectorResolver,
    private readonly outbox: OutboxService,
  ) {}

  /** ใบแจ้งหนี้ที่ออกเลขแล้ว (ST5-T09) → PUSH_INVOICE */
  async invoiceFinalized(tx: Tx, invoiceId: string): Promise<string[]> {
    const inv = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        customer: true,
        issuingBranch: { select: { branchCode: true } },
        lines: {
          where: { active: true },
          orderBy: { lineNo: 'asc' },
          include: { deliveryOrder: { select: { doNo: true } } },
        },
      },
    });
    if (!inv || !inv.invoiceNo || inv.status === 'DRAFT') return [];
    const r = await this.resolver.forCompany(tx, inv.issuingCompanyId, inv.issuingBranchId);
    if (r.standalone || !r.connector || !r.capabilities.includes('pushInvoice')) return [];
    const snap = (inv.customerSnapshot ?? {}) as {
      code?: string;
      name?: string;
      taxId?: string | null;
      branchCode?: string | null;
    };
    const doc: CanonicalInvoicePayload = withSyncHash({
      kind: 'invoice',
      id: inv.id,
      number: inv.invoiceNo,
      issueDate: ymd(inv.issueDate)!,
      dueDate: ymd(inv.dueDate),
      issuer: {
        companyId: inv.issuingCompanyId,
        branchId: inv.issuingBranchId,
        branchCode: inv.issuingBranch?.branchCode ?? null,
      },
      customer: {
        id: inv.customerId,
        code: snap.code ?? inv.customer.code,
        legalName: snap.name ?? inv.customer.legalName,
        taxId: snap.taxId ?? null,
        branchCode: snap.branchCode ?? null,
      },
      customerPoNo: inv.customerPoNo,
      totals: {
        subtotalVatable: money(inv.subtotalVatable),
        subtotalExempt: money(inv.subtotalExempt),
        subtotalZeroRated: money(inv.subtotalZeroRated),
        vatAmount: money(inv.vatAmount),
        total: money(inv.totalAmount),
        whtExpected: money(inv.whtExpectedAmount),
      },
      taxEstimated: true,
      lines: inv.lines.map((l) => ({
        lineNo: l.lineNo,
        deliveryOrder: l.deliveryOrder?.doNo ? { number: l.deliveryOrder.doNo } : null,
        serviceItem: { id: l.serviceItemId },
        description: l.description,
        quantity: new Prisma.Decimal(l.quantity).toString(),
        unitLabel: l.unitLabel,
        unitPrice: new Prisma.Decimal(l.unitPrice).toString(),
        discount: money(l.discount),
        amount: money(l.amount),
        vatType: l.vatType,
        vatAmount: money(l.vatAmount),
        whtRate: money(l.whtRate),
      })),
    });
    await this.enqueue(tx, {
      tenantId: inv.tenantId,
      connectorId: r.connector.id,
      operation: 'PUSH_INVOICE',
      entityType: ERP_ENTITY.invoice,
      localId: inv.id,
      customerId: inv.customerId,
      payload: { document: doc, branchId: inv.issuingBranchId },
    });
    return [r.connector.id];
  }

  /**
   * ใบแจ้งหนี้ที่ส่งเข้า ERP แล้วถูกยกเลิกใน TMS (ST5-T10) → VOID_DOCUMENT ต่อ connector ที่มี mapping ของใบนี้
   * adapter ไม่รองรับ = SKIPPED `void_manual_required` (ขึ้นบันทึกการซิงก์ให้บัญชียกเลิกในระบบบัญชีเอง — ไม่เดาแทน)
   */
  async invoiceVoided(tx: Tx, invoiceId: string): Promise<string[]> {
    const maps = await tx.externalMapping.findMany({
      where: { entityType: ERP_ENTITY.invoice, localId: invoiceId },
    });
    const out: string[] = [];
    for (const m of maps) {
      const c = await tx.connector.findUnique({ where: { id: m.connectorId } });
      if (!c || c.status === 'DISCONNECTED') continue;
      await this.enqueue(tx, {
        tenantId: m.tenantId,
        connectorId: c.id,
        operation: 'VOID_DOCUMENT',
        entityType: ERP_ENTITY.invoice,
        localId: invoiceId,
        customerId: null,
        payload: {
          ref: {
            entityType: ERP_ENTITY.invoice,
            localId: invoiceId,
            number: m.localNumber ?? '',
            externalId: m.externalId,
          },
        },
      });
      out.push(c.id);
    }
    return out;
  }

  /** ใบสำคัญจ่ายที่บันทึกจ่ายแล้ว (ST6-T09) → PUSH_SETTLEMENT (AP ร่าง + WHT ประมาณการ — D-58) */
  async settlementPaid(tx: Tx, s: SettlementDto): Promise<string[]> {
    const id = tryDecodeId('settlement', s.id);
    if (!id || s.status !== 'PAID' || !s.settlementNo || !s.paidDate) return [];
    const row = await tx.carrierSettlement.findUnique({
      where: { id },
      select: {
        tenantId: true,
        payingCompanyId: true,
        carrierId: true,
        grossAmount: true,
        deductionAmount: true,
        netPayable: true,
        whtAmount: true,
      },
    });
    if (!row) return [];
    const r = await this.resolver.forCompany(tx, row.payingCompanyId);
    if (r.standalone || !r.connector || !r.capabilities.includes('pushSettlement')) return [];
    const wht = row.whtAmount ?? new Prisma.Decimal(0);
    const doc: CanonicalSettlementPayload = withSyncHash({
      kind: 'settlement',
      id,
      number: s.settlementNo,
      paidDate: s.paidDate,
      payingCompanyId: row.payingCompanyId,
      period: { from: s.periodFrom, to: s.periodTo },
      carrierInvoiceNumber: s.carrierInvoiceNo,
      carrier: {
        id: row.carrierId,
        code: s.carrier.code,
        legalName: s.carrier.legalName,
        // บุคคลธรรมดา: ไม่ส่งเลขบัตรประชาชนออกนอก TMS (PDPA — ระบบบัญชีกรอกเองตอนออก 50 ทวิ)
        taxId: s.carrier.entityType === 'JURISTIC' ? s.carrier.taxId : null,
        branchCode: s.carrier.branchCode,
        entityType: s.carrier.entityType === 'JURISTIC' ? 'JURISTIC' : 'INDIVIDUAL',
      },
      payment: {
        method: s.paymentMethod ?? null,
        reference: s.paymentReference ?? null,
        bank: s.paymentBank ?? null,
      },
      totals: {
        gross: money(row.grossAmount),
        deduction: money(row.deductionAmount),
        net: money(row.netPayable),
        wht: money(wht),
        netAfterWht: money(row.netPayable.minus(wht)),
      },
      whtEstimate: {
        pndForm: s.whtEstimate.form,
        byRate: s.whtEstimate.byRate.map((b) => ({
          whtRate: b.whtRate,
          base: b.buyBaseAmount ?? '0.00',
          amount: b.buyWhtAmount ?? '0.00',
        })),
        reviewedByAccountant: false,
      },
      taxEstimated: true,
      lines: s.lines
        .filter((l) => l.active)
        .map((l) => ({
          lineNo: l.lineNo,
          lineType: l.lineType,
          trip: l.tripNo ? { number: l.tripNo } : null,
          description: l.description,
          amount: l.buyAmount ?? '0.00',
          vatType: l.vatType,
          whtRate: l.whtRateApplied,
          whtAmount: l.buyWhtAmount ?? null,
        })),
    });
    await this.enqueue(tx, {
      tenantId: row.tenantId,
      connectorId: r.connector.id,
      operation: 'PUSH_SETTLEMENT',
      entityType: ERP_ENTITY.settlement,
      localId: id,
      customerId: null,
      payload: { document: doc },
    });
    return [r.connector.id];
  }

  private async enqueue(
    tx: Tx,
    c: {
      tenantId: string;
      connectorId: string;
      operation: string;
      entityType: string;
      localId: string;
      customerId: string | null;
      payload: Record<string, unknown>;
    },
  ) {
    const r = await this.outbox.enqueueCommand(tx, {
      tenantId: c.tenantId,
      kind: 'ADAPTER',
      sink: ERP_SINK,
      targetId: c.connectorId,
      operation: c.operation,
      entityType: c.entityType,
      localId: c.localId,
      customerId: c.customerId,
      payload: c.payload,
    });
    this.logger.debug(
      `${c.operation} ${c.entityType}/${c.localId} → connector ${c.connectorId} (${r.created ? 'new' : 'same payload'})`,
    );
  }
}
