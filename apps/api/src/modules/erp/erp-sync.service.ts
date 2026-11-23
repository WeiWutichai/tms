import { Injectable, Logger } from '@nestjs/common';
import { tryDecodeId } from '../../common/ids';
import type { Tx } from '../../db/db.service';
import { randomUUID } from 'node:crypto';
import { OutboxService } from '../integration/outbox.service';
import type { SettlementDto } from '../settlements/settlement.dto';
import {
  CANONICAL_INVOICE_INCLUDE,
  CANONICAL_SETTLEMENT_SELECT,
  canonicalInvoice,
  canonicalSettlement,
  documentDate,
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
 * - ST7-T16 ประตู `syncFromDate` (docs/01 §6.4 "ไม่ถูกสร้าง outbox"): เอกสารที่วันที่ก่อนวันเริ่มซิงก์ของ connector **ไม่มีคำสั่ง**
 *   (บัญชีคีย์ไว้เองก่อน go-live) · คำสั่งที่สร้างไว้ก่อนผู้ดูแลเลื่อนวัน = sink ข้ามเป็น SKIPPED `before_sync_from_date` ตอนส่ง
 * - ST7-T16 ตอนสร้างคำสั่ง PUSH_* / REPLACE_DOCUMENT ล็อกแถว connector `FOR KEY SHARE` ใน transaction เดียวกัน — กัน TOCTOU กับการเปลี่ยน
 *   เจ้าของเอกสาร (`setSystemOfRecord` ใช้ FOR UPDATE)
 * - ST7-T16 ส่งใหม่ (`resend`): ใช้ canonical **ฉบับที่ออก** (payload ของคำสั่งส่งครั้งแรก — ไม่สร้างจากข้อมูลปัจจุบัน) · เอกสารอยู่ใน ERP แล้ว
 *   = REPLACE_DOCUMENT · การเปลี่ยนถึง ERP แบบไหนตัดสินที่ sink ด้วย `fieldChangePolicy` (`documentInErp` จาก external_mapping)
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
    const q = await this.enqueue(tx, r.connector.syncFromDate, {
      tenantId: inv.tenantId,
      connectorId: r.connector.id,
      operation: 'PUSH_INVOICE',
      entityType: ERP_ENTITY.invoice,
      localId: inv.id,
      customerId: inv.customerId,
      payload: { document: doc, branchId: inv.issuingBranchId },
    });
    return q ? [r.connector.id] : [];
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
    // ST7-T16 เฉพาะ mapping ที่เอกสารถึง ERP แล้ว (มี external_id) — mapping FAILED (VALIDATION ก่อนถึง ERP) ไม่มีอะไรให้ยกเลิก
    const maps = await tx.externalMapping.findMany({
      where: { entityType: MAP_ENTITY.invoice, localId: invoiceId, externalId: { not: null } },
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
      await this.enqueue(tx, null, {
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
    const q = await this.enqueue(tx, r.connector.syncFromDate, {
      tenantId: row.tenantId,
      connectorId: r.connector.id,
      operation: 'PUSH_SETTLEMENT',
      entityType: ERP_ENTITY.settlement,
      localId: id,
      customerId: null,
      payload: { document: doc },
    });
    return q ? [r.connector.id] : [];
  }

  /**
   * ST7-T16 ส่งเอกสารที่ส่งแล้ว/ส่งไม่สำเร็จใหม่อีกครั้ง (ปุ่ม "ส่งใหม่" ของคิว ST7-T19 / ปิด MISMATCH ฝั่ง "TMS ถูก" — docs/01 §6.5)
   * - ใช้ canonical **ฉบับที่ออก** = payload ของคำสั่ง PUSH_* ล่าสุดของเอกสารนี้ต่อ connector (ไม่สร้างใหม่จากข้อมูลปัจจุบัน —
   *   เอกสารที่ออกแล้วแก้ไม่ได้; ส่วนที่ใส่ ณ ตอนส่ง เช่น รหัสฝั่ง ERP sink ใส่ใหม่ทุกครั้ง)
   * - external_mapping บอกว่าเอกสารอยู่ใน ERP แล้ว (มี external_id, ฝั่ง ERP ไม่ได้ยกเลิก) → REPLACE_DOCUMENT `{ref, document}`
   *   ไม่อยู่ → PUSH_* ด้วย payload ฉบับที่ออก
   * - review: สร้าง**คำสั่งใหม่**ใน transaction ของผู้เรียก (RLS ของ tenant — ไม่ใช้ role platform ไม่เขียนนอก transaction) ·
   *   idempotency key ต่อท้าย `:resend-{nonce}` (คำสั่งเดิมคงผล/ประวัติไว้) · ช่องผล/ข้อผิดพลาด/lease ว่างเหมือนคำสั่งใหม่ ·
   *   key ที่ ERP เห็นยังผูกกับเนื้อหา (`sentIdempotencyKey`) และ sink ค้นเอกสารฝั่ง ERP ก่อนส่งถ้าเคยส่งแบบไม่รู้ผล
   * - มีคำสั่งของเอกสารนี้ค้างอยู่ (PENDING / IN_FLIGHT / FAILED_RETRYABLE) = คืนคำสั่งนั้น ไม่สร้างซ้ำ
   * - sink ตัดสินต่อ: hash เท่าเดิม = ไม่ส่ง · เนื้อหาเปลี่ยน = `fieldChangePolicy` (AUTO_SYNC → replaceDocument / REGENERATE / BLOCKED)
   * คืน id คำสั่ง (null = ไม่เคยมีคำสั่งส่งเอกสารนี้ไป connector นั้น / connector ยกเลิกแล้ว)
   */
  async resend(
    tx: Tx,
    entity: 'invoice' | 'settlement',
    localId: string,
    connectorId: string,
  ): Promise<string | null> {
    const op = entity === 'invoice' ? 'PUSH_INVOICE' : 'PUSH_SETTLEMENT';
    const c = await tx.connector.findUnique({ where: { id: connectorId } });
    if (!c || c.status === 'DISCONNECTED') return null;
    const last = await tx.integrationOutbox.findFirst({
      where: { sink: ERP_SINK, targetId: connectorId, operation: op, entityType: entity, localId },
      orderBy: { seq: 'asc' },
      select: { payload: true },
    });
    const payload = (last?.payload ?? null) as { document?: { number?: unknown } } | null;
    if (!payload?.document) return null;
    const m = await tx.externalMapping.findUnique({
      where: {
        connectorId_entityType_localId: {
          connectorId,
          entityType: entity === 'invoice' ? MAP_ENTITY.invoice : MAP_ENTITY.settlement,
          localId,
        },
      },
    });
    const inErp = !!m?.externalId && m.externalStatus !== 'VOIDED';
    const open = await tx.integrationOutbox.findFirst({
      where: {
        sink: ERP_SINK,
        targetId: connectorId,
        entityType: entity,
        localId,
        operation: { in: [op, 'REPLACE_DOCUMENT'] },
        status: { in: ['PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE'] },
      },
      select: { id: true },
    });
    if (open) return open.id;
    const r = await this.enqueue(tx, c.syncFromDate, {
      resendNonce: randomUUID(),
      tenantId: c.tenantId,
      connectorId,
      operation: inErp ? 'REPLACE_DOCUMENT' : op,
      entityType: entity,
      localId,
      // คีย์ serialize เดียวกับคำสั่งส่งครั้งแรก (ต่อลูกค้า — ใบลด/แทนที่ไม่แซงใบต้นฉบับ)
      customerId:
        entity === 'invoice'
          ? ((await tx.invoice.findUnique({ where: { id: localId }, select: { customerId: true } }))
              ?.customerId ?? null)
          : null,
      payload: inErp
        ? {
            ...(payload as Record<string, unknown>),
            ref: {
              entityType: entity,
              localId,
              number: String(payload.document.number ?? ''),
              externalId: m!.externalId,
            },
          }
        : (payload as Record<string, unknown>),
    });
    if (!r) return null; // เอกสารก่อน syncFromDate — ไม่สร้างคำสั่ง (docs/01 §6.4)
    return r.id;
  }

  private async enqueue(
    tx: Tx,
    syncFromDate: Date | null,
    c: {
      tenantId: string;
      connectorId: string;
      operation: string;
      entityType: string;
      localId: string;
      customerId: string | null;
      payload: Record<string, unknown>;
      resendNonce?: string;
    },
  ): Promise<{ id: string; created: boolean } | null> {
    // ST7-T16 (backlog ST7-T16/T17) ล็อกแถว connector ร่วม (FOR KEY SHARE) — `setSystemOfRecord` (FOR UPDATE) รอจนคำสั่งนี้ commit
    // แล้วเห็นคำสั่ง/เอกสารนี้ตอนตรวจ "เปลี่ยนเจ้าของได้ไหม" (กัน TOCTOU)
    await tx.$queryRaw`SELECT 1 FROM connector WHERE id = ${c.connectorId}::uuid FOR KEY SHARE`;
    // ST7-T16 ประตู syncFromDate (docs/01 §6.4 "เอกสารที่ issue_date ก่อนวันนี้ไม่ถูกสร้าง outbox") — ไม่สร้างคำสั่ง
    const from = syncFromDate ? syncFromDate.toISOString().slice(0, 10) : null;
    const date = documentDate((c.payload as { document?: unknown }).document);
    if (from && date && date < from && c.operation !== 'VOID_DOCUMENT') {
      this.logger.debug(
        `${c.operation} ${c.entityType}/${c.localId}: dated ${date} before syncFromDate ${from} — no command`,
      );
      return null;
    }
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
      ...(c.resendNonce ? { resendNonce: c.resendNonce } : {}),
    });
    this.logger.debug(
      `${c.operation} ${c.entityType}/${c.localId} → connector ${c.connectorId} (${r.created ? 'new' : 'same payload'})`,
    );
    return r;
  }
}
