import { Injectable } from '@nestjs/common';
import type { ReconcileResult } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { ConnectorResolver } from './connector-resolver';
import { ConnectorsService } from './connectors.service';
import { isPendingCapability } from './erp-adapter';
import { ErpAdapterRegistry } from './erp-adapter.registry';
import { ErpSyncService } from './erp-sync.service';
import { RECONCILE_REASON_MIN, type ReconcileResultDto } from './reconcile-result.dto';
import { ReconcileResultsService } from './reconcile-results.service';
import { RECONCILE_CHECK_DOCUMENT } from './reconcile-compare';

const ENTITY = 'reconcile_result';
/** ผลที่ต้องให้คนตัดสิน (INFO = อ่านเอกสารไม่ได้ / เทียบไม่ได้ — ไม่ใช่ความต่าง) */
const CLOSABLE_RESULTS = new Set(['MISMATCH', 'REMOTE_MISSING']);

const conflict = (reason: string, extra: Record<string, unknown> = {}) =>
  new ProblemException('invalid_state_transition', undefined, undefined, { reason, ...extra });

/**
 * ST8-T12 ปิดรายการที่ข้อมูลไม่ตรงกับระบบบัญชี (docs/01 §6.5 "ปิด MISMATCH ได้ 3 ทาง บันทึกคนและเหตุผลทุกครั้ง") — ไม่ผูก ERP ใด
 *
 * 1. **แก้ที่ TMS** (ERP ถูก): docs = credit/debit note — **D-54 [OPEN — PO]** ใบลด/เพิ่มหนี้ไม่อยู่ใน TMS เฟส 0 → ระหว่างรอ = ยกเลิกใบ
 *    แล้วออกใหม่ (ST5-T10 `POST /invoices/{id}/void` + `reissue` — สิทธิ์/step-up/If-Match ของ endpoint นั้น) แล้วปิดรายการนี้ด้วย
 *    `resolve-in-tms` (ตรวจว่าใบยกเลิกแล้วจริง) → `resolution` FIXED_IN_TMS
 * 2. **ส่งทับระบบบัญชีด้วยค่า TMS** (TMS ถูก): ขออนุมัติ (`overwrite-request`) → ผู้อนุมัติ **คนละคน** อนุมัติ → คำสั่ง REPLACE_DOCUMENT
 *    ผ่าน `ErpSyncService.resend` (canonical ฉบับที่ออก + `payload.approval` — ผ่านประตู "ลงบัญชีแล้วต้องอนุมัติ" ของ sink) ·
 *    adapter ยังไม่รองรับ `replaceDocument` (เช่น KRS — ST8-T13) = sink พักคำสั่ง (`capability_not_implemented`) — หน้าจอแสดงสถานะ ·
 *    รอบเทียบหลังส่ง (AFTER_PUSH) ตรงกัน = ปิดเอง `resolution` ERP_OVERWRITTEN
 * 3. **ยอมรับความต่าง** (`acknowledge`): `acknowledged_*` + `external_mapping.reconcile_state` ACCEPTED (docs/01 §4.4) ·
 *    รอบถัดไป `diff_hash` เท่าเดิม = ไม่แจ้งซ้ำ (ST8-T11)
 *
 * ทุกทาง: คนเท่านั้น (API key → 403) · เหตุผล ≥ 10 ตัวอักษร · audit มีผู้ทำ (actor) + เหตุผล · tenant อื่น = 404 (RLS + `@TenantResource`)
 */
@Injectable()
export class ReconcileCloseService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly results: ReconcileResultsService,
    private readonly erpSync: ErpSyncService,
    private readonly connectors: ConnectorsService,
    private readonly clock: Clock,
    private readonly resolver: ConnectorResolver,
    private readonly adapters: ErpAdapterRegistry,
  ) {}

  /** (3) ยอมรับความต่าง — ใช้ได้กับทุก check (ยอดรับชำระ ST7-T21 ด้วย) ที่ยังเปิดอยู่ */
  async acknowledge(id: string, reasonRaw: string): Promise<ReconcileResultDto> {
    const { tx, r, actor, reason } = await this.prepare(id, reasonRaw);
    this.assertOpen(r);
    if (r.overwriteStatus === 'REQUESTED' || r.overwriteStatus === 'APPROVED')
      throw conflict('overwrite_in_progress', { overwriteStatus: r.overwriteStatus });
    const now = this.clock.now();
    await tx.reconcileResult.update({
      where: { id },
      data: { acknowledgedAt: now, acknowledgedBy: actor, ackReason: reason },
    });
    if (this.isDocument(r) && r.entityType === 'INVOICE')
      await this.results.setMappingState(
        tx,
        {
          connectorId: r.connectorId,
          entityType: 'INVOICE',
          localId: r.localId,
          runAt: now,
          source: 'MANUAL',
        },
        'ACCEPTED',
        null,
      );
    await this.audit.record({
      action: 'reconcile.mismatch_acknowledged',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { status: 'OPEN' },
      after: { status: 'ACKNOWLEDGED', ...this.ref(r) },
    });
    return this.results.get(id);
  }

  /** (1) แก้ที่ TMS แล้ว — ใบยกเลิกแล้ว (ST5-T10; ออกใบใหม่แทนได้) · D-54 ระหว่างรอใบลด/เพิ่มหนี้ */
  async resolveInTms(id: string, reasonRaw: string): Promise<ReconcileResultDto> {
    const { tx, r, actor, reason } = await this.prepare(id, reasonRaw);
    this.assertDocumentOpen(r);
    if (r.overwriteStatus === 'REQUESTED' || r.overwriteStatus === 'APPROVED')
      throw conflict('overwrite_in_progress', { overwriteStatus: r.overwriteStatus });
    const inv = await tx.invoice.findUnique({
      where: { id: r.localId },
      select: {
        id: true,
        status: true,
        invoiceNo: true,
        replacedBy: {
          select: { id: true, invoiceNo: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!inv) throw new ProblemException('not_found');
    if (inv.status !== 'CANCELLED')
      throw conflict('invoice_not_voided', {
        invoiceId: encodeId('invoice', inv.id),
        invoiceStatus: inv.status,
      });
    const now = this.clock.now();
    await tx.reconcileResult.update({
      where: { id },
      data: {
        resolvedAt: now,
        resolvedBy: actor,
        resolution: 'FIXED_IN_TMS',
        resolutionReason: reason,
      },
    });
    const rep = inv.replacedBy[0];
    await this.audit.record({
      action: 'reconcile.mismatch_closed',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { status: 'OPEN' },
      after: {
        status: 'RESOLVED',
        resolution: 'FIXED_IN_TMS',
        ...this.ref(r),
        replacedByInvoiceId: rep ? encodeId('invoice', rep.id) : null,
        replacedByInvoiceNo: rep?.invoiceNo ?? null,
      },
    });
    return this.results.get(id);
  }

  /** (2ก) ขออนุมัติส่งทับระบบบัญชีด้วยค่า TMS */
  async requestOverwrite(id: string, reasonRaw: string): Promise<ReconcileResultDto> {
    const { tx, r, actor, reason } = await this.prepare(id, reasonRaw);
    this.assertDocumentOpen(r);
    if (r.overwriteStatus === 'REQUESTED' || r.overwriteStatus === 'APPROVED')
      throw conflict('overwrite_in_progress', { overwriteStatus: r.overwriteStatus });
    await this.assertResendable(tx, r);
    const now = this.clock.now();
    await tx.reconcileResult.update({
      where: { id },
      data: {
        overwriteStatus: 'REQUESTED',
        overwriteRequestedBy: actor,
        overwriteRequestedAt: now,
        overwriteReason: reason,
        overwriteDecidedBy: null,
        overwriteDecidedAt: null,
        overwriteDecisionReason: null,
        overwriteCommandId: null,
      },
    });
    await this.audit.record({
      action: 'reconcile.overwrite_requested',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { overwriteStatus: r.overwriteStatus },
      after: { overwriteStatus: 'REQUESTED', ...this.ref(r) },
    });
    return this.results.get(id);
  }

  /** (2ข) อนุมัติ — ผู้อนุมัติ ≠ ผู้ขอ → คำสั่งส่งทับ (REPLACE_DOCUMENT) */
  async approveOverwrite(id: string, reasonRaw: string): Promise<ReconcileResultDto> {
    const { tx, r, actor, reason } = await this.prepare(id, reasonRaw);
    this.assertDocumentOpen(r);
    if (r.overwriteStatus !== 'REQUESTED')
      throw conflict('overwrite_not_requested', { overwriteStatus: r.overwriteStatus });
    if (r.overwriteRequestedBy === actor) throw new ProblemException('self_approval_forbidden');
    const plan = await this.assertResendable(tx, r);
    // ระบบบัญชียังไม่รองรับการแทนที่ (adapter ประกาศแต่ยังไม่ได้ทำ — KRS ก่อน ST8-T13) = **พักไว้**: บันทึกการอนุมัติ ไม่สร้างคำสั่ง
    // (คำสั่งที่พักในคิวจะกั้นการส่งเอกสารอื่นของลูกค้ารายเดียวกัน — ลำดับต่อลูกค้า) · `overwrite.commandErrorCode` = capability_not_implemented
    let commandId: string | null = null;
    if (plan === 'send') {
      commandId = await this.erpSync.resend(tx, 'invoice', r.localId, r.connectorId, {
        reconcileResultId: encodeId('reconcileResult', r.id),
        approvedBy: actor,
        requestedBy: r.overwriteRequestedBy ?? '',
      });
      if (!commandId) throw conflict('nothing_to_resend');
    }
    const now = this.clock.now();
    await tx.reconcileResult.update({
      where: { id },
      data: {
        overwriteStatus: 'APPROVED',
        overwriteDecidedBy: actor,
        overwriteDecidedAt: now,
        overwriteDecisionReason: reason,
        overwriteCommandId: commandId,
      },
    });
    await this.audit.record({
      action: 'reconcile.overwrite_approved',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { overwriteStatus: 'REQUESTED' },
      after: {
        overwriteStatus: 'APPROVED',
        ...this.ref(r),
        requestedBy: r.overwriteRequestedBy,
        commandId: commandId ? encodeId('outboxCommand', commandId) : null,
        parked: plan === 'park' ? 'capability_not_implemented' : null,
      },
    });
    return this.results.get(id);
  }

  /** (2ค) ไม่อนุมัติ — ผู้อนุมัติ ≠ ผู้ขอ · รายการกลับเป็น "ไม่ตรง" (ปิดทางอื่นได้ / ขอใหม่ได้) */
  async rejectOverwrite(id: string, reasonRaw: string): Promise<ReconcileResultDto> {
    const { tx, r, actor, reason } = await this.prepare(id, reasonRaw);
    this.assertDocumentOpen(r);
    if (r.overwriteStatus !== 'REQUESTED')
      throw conflict('overwrite_not_requested', { overwriteStatus: r.overwriteStatus });
    if (r.overwriteRequestedBy === actor) throw new ProblemException('self_approval_forbidden');
    await tx.reconcileResult.update({
      where: { id },
      data: {
        overwriteStatus: 'REJECTED',
        overwriteDecidedBy: actor,
        overwriteDecidedAt: this.clock.now(),
        overwriteDecisionReason: reason,
      },
    });
    await this.audit.record({
      action: 'reconcile.overwrite_rejected',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { overwriteStatus: 'REQUESTED' },
      after: { overwriteStatus: 'REJECTED', ...this.ref(r), requestedBy: r.overwriteRequestedBy },
    });
    return this.results.get(id);
  }

  // ---------- ช่วย ----------

  private async prepare(id: string, reasonRaw: string) {
    // คนเท่านั้น (API key ปิดรายการไม่ได้ — docs/01 §6.5 "บันทึกคนและเหตุผล")
    this.connectors.assertHuman();
    const reason = (reasonRaw ?? '').trim();
    if (reason.length < RECONCILE_REASON_MIN)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'reason',
          code: 'too_short',
          message: `ระบุเหตุผลอย่างน้อย ${RECONCILE_REASON_MIN} ตัวอักษร`,
        },
      ]);
    const tx = this.db.tx;
    // ล็อกแถว — กดซ้ำ/สองคนพร้อมกันไม่ข้ามสถานะกัน
    await tx.$queryRaw`SELECT 1 FROM reconcile_result WHERE id = ${id}::uuid FOR UPDATE`;
    const r = await tx.reconcileResult.findUnique({ where: { id } });
    if (!r) throw new ProblemException('not_found');
    const actor = requestContext.require().actorId ?? '';
    return { tx, r, actor, reason };
  }

  private isDocument(r: ReconcileResult): boolean {
    return (r.diff as { check?: unknown } | null)?.check === RECONCILE_CHECK_DOCUMENT;
  }

  private assertOpen(r: ReconcileResult): void {
    if (r.resolvedAt) throw conflict('already_resolved');
    if (r.acknowledgedAt) throw conflict('already_acknowledged');
    if (!CLOSABLE_RESULTS.has(r.result)) throw conflict('not_a_mismatch', { result: r.result });
  }

  private assertDocumentOpen(r: ReconcileResult): void {
    this.assertOpen(r);
    if (!this.isDocument(r) || r.entityType !== 'INVOICE')
      throw conflict('not_a_document_mismatch');
  }

  /**
   * ส่งทับได้: ใบยังไม่ยกเลิก + connector ยังไม่ยกเลิกการเชื่อม + ระบบบัญชีแทนที่เอกสารได้ (รับชำระแล้ว = sink ข้าม `paid_locked` ตามกฎเดิม)
   * คืน `send` = สร้างคำสั่งได้ · `park` = adapter ประกาศ `replaceDocument` แต่ยังไม่ได้ทำ (พักไว้) ·
   * ไม่รองรับ/ไม่เปิด `replaceDocument` → 409 `replace_not_supported` (docs/01 §6.1 แจ้งบัญชีแก้เอง — TMS ไม่ออกใบลด/เพิ่มหนี้ D-54)
   * เอกสารยังไม่อยู่ในระบบบัญชี (ไม่พบ/ยกเลิกฝั่ง ERP) = ส่งเป็นเอกสารใหม่ (`resend` → PUSH_*) ไม่ต้องใช้ replaceDocument
   */
  private async assertResendable(tx: Tx, r: ReconcileResult): Promise<'send' | 'park'> {
    const [inv, c, m] = await Promise.all([
      tx.invoice.findUnique({ where: { id: r.localId }, select: { status: true } }),
      tx.connector.findUnique({ where: { id: r.connectorId } }),
      tx.externalMapping.findUnique({
        where: {
          connectorId_entityType_localId: {
            connectorId: r.connectorId,
            entityType: 'INVOICE',
            localId: r.localId,
          },
        },
        select: { externalId: true, externalStatus: true, detail: true },
      }),
    ]);
    if (!inv) throw new ProblemException('not_found');
    if (inv.status === 'CANCELLED') throw conflict('invoice_voided');
    if (!c || c.status === 'DISCONNECTED') throw conflict('connector_disconnected');
    // เงื่อนไข "อยู่ใน ERP แล้ว" เดียวกับ ErpSyncService.resend
    const partial = (m?.detail as { documentsPartial?: unknown } | null)?.documentsPartial === true;
    const inErp = !!m?.externalId && m.externalStatus !== 'VOIDED' && !partial;
    if (!inErp) return 'send';
    if (this.resolver.describe(c).capabilities.includes('replaceDocument')) return 'send';
    const adapter = this.adapters.get(c.adapterKey);
    if (adapter && isPendingCapability(adapter, 'replaceDocument')) return 'park';
    throw conflict('replace_not_supported');
  }

  private ref(r: ReconcileResult) {
    const d = (r.diff ?? {}) as { check?: unknown; code?: unknown };
    return {
      check: d.check ?? null,
      code: d.code ?? null,
      result: r.result,
      severity: r.severity,
      invoiceId: r.entityType === 'INVOICE' ? encodeId('invoice', r.localId) : null,
      invoiceNo: r.localNumber,
      connectorId: encodeId('connector', r.connectorId),
    };
  }
}
