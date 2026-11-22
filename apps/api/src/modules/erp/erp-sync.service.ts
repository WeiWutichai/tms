import { Injectable, Logger } from '@nestjs/common';
import { tryDecodeId } from '../../common/ids';
import type { Tx } from '../../db/db.service';
import { OutboxService } from '../integration/outbox.service';
import type { SettlementDto } from '../settlements/settlement.dto';
import {
  CANONICAL_INVOICE_INCLUDE,
  CANONICAL_SETTLEMENT_SELECT,
  canonicalInvoice,
  canonicalSettlement,
} from './canonical';
import { ConnectorResolver } from './connector-resolver';
import { ExternalMappingService } from './external-mapping.service';
import { ERP_SINK } from './erp-adapter.sink';

/** entity_type ของ external_mapping (enum `ExternalEntityType` — ตารางของ ST8-T05/0141) */
export const MAP_ENTITY = {
  invoice: 'INVOICE',
  settlement: 'SETTLEMENT',
  payment: 'PAYMENT',
} as const;

/** entity_type ของคำสั่งใน integration_outbox */
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
    private readonly mappings: ExternalMappingService,
  ) {}

  /** ใบแจ้งหนี้ที่ออกเลขแล้ว (ST5-T09) → PUSH_INVOICE */
  async invoiceFinalized(tx: Tx, invoiceId: string): Promise<string[]> {
    const inv = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: CANONICAL_INVOICE_INCLUDE,
    });
    if (!inv || !inv.invoiceNo || inv.status === 'DRAFT') return [];
    const r = await this.resolver.forCompany(tx, inv.issuingCompanyId, inv.issuingBranchId);
    if (r.standalone || !r.connector || !r.capabilities.includes('pushInvoice')) return [];
    // ST8-T05 รหัสลูกค้าฝั่ง ERP ที่ผู้ใช้ map ไว้ (null = adapter จับคู่เอง เช่น ด้วยเลขภาษี+สาขา)
    const customerExternalId = await this.mappings.customerErpCode(
      tx,
      r.connector.id,
      inv.customerId,
    );
    // ST8-T07 (PDPA): ชื่อคนขับลง payload เฉพาะ connector ที่ adapter ประกาศว่าต้องใช้
    const doc = canonicalInvoice(inv, customerExternalId, r.adapter?.personalDataNeeds ?? []);
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
   * ใบแจ้งหนี้ถูกยกเลิกใน TMS (ST5-T10) — review M1
   * - คำสั่ง PUSH_INVOICE ที่ยังไม่ส่ง (PENDING / พักไว้ตอน PAUSED/ERROR) ไม่ต้องทำอะไรที่นี่: sink ตรวจสถานะเอกสารก่อนส่งทุกครั้ง
   *   → ใบที่ยกเลิกแล้ว = SKIPPED `document_cancelled` (ไม่ส่งร่างของใบที่ยกเลิกเข้า ERP)
   * - ใบที่ **อาจถึง ERP แล้ว** = มี external_mapping (ส่งสำเร็จ) หรือคำสั่งกำลังส่ง/ลองใหม่อยู่ (IN_FLIGHT / FAILED_RETRYABLE —
   *   ครั้งก่อนอาจถึงปลายทางแล้ว เช่น timeout) → VOID_DOCUMENT ต่อ connector นั้น (คีย์ serialize เดียวกับ PUSH = ทำหลัง PUSH)
   *   ยังไม่มี adapter ใดยกเลิกผ่าน API ได้ = SKIPPED `void_manual_required` (บัญชีตรวจ/ยกเลิกในระบบบัญชีเอง)
   */
  async invoiceVoided(tx: Tx, invoiceId: string): Promise<string[]> {
    const inv = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: { tenantId: true, customerId: true, invoiceNo: true },
    });
    if (!inv) return [];
    const maps = await tx.externalMapping.findMany({
      where: { entityType: MAP_ENTITY.invoice, localId: invoiceId },
    });
    const inFlight = await tx.integrationOutbox.findMany({
      where: {
        sink: ERP_SINK,
        operation: 'PUSH_INVOICE',
        entityType: ERP_ENTITY.invoice,
        localId: invoiceId,
        status: { in: ['IN_FLIGHT', 'FAILED_RETRYABLE'] },
      },
      select: { targetId: true },
    });
    const targets = new Map<string, { number: string; externalId: string | null }>();
    for (const m of maps)
      targets.set(m.connectorId, {
        number: m.localNumber ?? inv.invoiceNo ?? '',
        externalId: m.externalId,
      });
    for (const o of inFlight)
      if (o.targetId && !targets.has(o.targetId))
        targets.set(o.targetId, { number: inv.invoiceNo ?? '', externalId: null });
    const out: string[] = [];
    for (const [connectorId, ref] of targets) {
      const c = await tx.connector.findUnique({ where: { id: connectorId } });
      if (!c || c.status === 'DISCONNECTED') continue;
      await this.enqueue(tx, {
        tenantId: inv.tenantId,
        connectorId: c.id,
        operation: 'VOID_DOCUMENT',
        entityType: ERP_ENTITY.invoice,
        localId: invoiceId,
        customerId: inv.customerId,
        payload: {
          ref: {
            entityType: ERP_ENTITY.invoice,
            localId: invoiceId,
            number: ref.number,
            externalId: ref.externalId,
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
    // ใบ PAID ต้องผ่านอนุมัติ (requireWhtEntityType) — ไม่มีผลประมาณการ = ข้อมูลเขียนฐานตรง → ไม่ส่ง AP ร่างที่ไม่มีแบบยื่น
    const est = s.whtEstimate;
    if (!est) return [];
    const row = await tx.carrierSettlement.findUnique({
      where: { id },
      select: CANONICAL_SETTLEMENT_SELECT,
    });
    if (!row) return [];
    const r = await this.resolver.forCompany(tx, row.payingCompanyId);
    if (r.standalone || !r.connector || !r.capabilities.includes('pushSettlement')) return [];
    const doc = canonicalSettlement(s, row);
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
