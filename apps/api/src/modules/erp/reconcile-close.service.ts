import { Injectable } from '@nestjs/common';
import type { ReconcileResult } from '@prisma/client';
import { SOR_PAYMENT_RECEIVED_STATUSES } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { ConnectorResolver } from './connector-resolver';
import { ConnectorsService } from './connectors.service';
import { isPendingCapability } from './erp-adapter';
import { ERP_SINK } from './erp-adapter.sink';
import { ErpAdapterRegistry } from './erp-adapter.registry';
import { invoiceActors, isPersonActor } from './erp-reissue';
import { ErpSyncService } from './erp-sync.service';
import { RECONCILE_REASON_MIN, type ReconcileResultDto } from './reconcile-result.dto';
import { ReconcileResultsService } from './reconcile-results.service';
import { RECONCILE_CHECK_DOCUMENT } from './reconcile-compare';

const ENTITY = 'reconcile_result';
/** ผลที่ต้องให้คนตัดสิน (INFO = อ่านเอกสารไม่ได้ / เทียบไม่ได้ — ไม่ใช่ความต่าง) */
const CLOSABLE_RESULTS = new Set(['MISMATCH', 'REMOTE_MISSING']);
/** คำสั่งที่ยังไม่จบ (จะส่ง/กำลังส่ง/รอลองใหม่) */
const OPEN_COMMAND = ['PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE'];

const conflict = (reason: string, extra: Record<string, unknown> = {}) =>
  new ProblemException('invalid_state_transition', undefined, undefined, { reason, ...extra });

/**
 * ST8-T12 ปิดรายการที่ข้อมูลไม่ตรงกับระบบบัญชี (docs/01 §6.5 "ปิด MISMATCH ได้ 3 ทาง บันทึกคนและเหตุผลทุกครั้ง") — ไม่ผูก ERP ใด
 *
 * 1. **แก้ที่ TMS** (ERP ถูก): docs = credit/debit note — **D-54 [OPEN — PO]** ใบลด/เพิ่มหนี้ไม่อยู่ใน TMS เฟส 0 → ระหว่างรอ = ยกเลิกใบ
 *    แล้วออกใหม่ (ST5-T10 `POST /invoices/{id}/void`) แล้วปิดรายการนี้ด้วย `resolve-in-tms` (ตรวจว่าใบยกเลิกแล้วจริง) → FIXED_IN_TMS
 * 2. **ส่งทับระบบบัญชีด้วยค่า TMS** (TMS ถูก — docs `replaceDocument`, ต้อง approval ถ้า posted):
 *    - `resend` ("ใช้ค่า TMS ส่งซ้ำ") = ส่งซ้ำตรง (`integrations:retry`) → ประตูอนุมัติของ ST8-T13 (`approvalGate` ใน sink: ลงบัญชีแล้ว /
 *      อายุใบเกิน N วัน) ตัดสิน — ต้องอนุมัติ = คำสั่ง SKIPPED `replace_requires_approval` → ใช้ทาง "ขออนุมัติแก้"
 *    - `overwrite-request` ("ขออนุมัติแก้") → `approve` โดยผู้อนุมัติที่**ไม่ใช่ผู้ขอและไม่ใช่ผู้สร้าง/แก้/ออกเลขใบ** (`erp_replace_self_approval`)
 *      → คำสั่งพร้อม `approval` {approvedBy, approvedAt, reason, reconcileResultId} ผ่านประตูของ ST8-T13
 *    - รอบเทียบหลังส่ง (AFTER_PUSH) ตรงกัน = ปิดเอง `resolution` ERP_OVERWRITTEN · คำสั่งจบแบบไม่สำเร็จ = กลับมาปิดทางอื่นได้
 * 3. **ยอมรับความต่าง** (`acknowledge`): `acknowledged_*` + `external_mapping.reconcile_state` ACCEPTED (docs/01 §4.4)
 *
 * ทุกทาง: คนเท่านั้น (API key → 403) · เหตุผล ≥ 10 ตัวอักษร · audit มีผู้ทำ (actor) + เหตุผล · tenant อื่น = 404
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
    await this.assertNoOverwriteInProgress(tx, r);
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
    await this.assertNoOverwriteInProgress(tx, r);
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
    await tx.reconcileResult.update({
      where: { id },
      data: {
        resolvedAt: this.clock.now(),
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

  /**
   * (2) "ใช้ค่า TMS ส่งซ้ำ" — ส่งเอกสารฉบับที่ออกทับระบบบัญชีทันที (docs/01 §6.5) · ประตูอนุมัติของ ST8-T13 ตัดสินที่ sink
   * (ลงบัญชีแล้ว/อายุใบเกิน → SKIPPED `replace_requires_approval` → ขออนุมัติแก้) · `overwrite_status` SENT
   */
  async resend(id: string, reasonRaw: string): Promise<ReconcileResultDto> {
    const { tx, r, reason } = await this.prepare(id, reasonRaw);
    this.assertDocumentOpen(r);
    await this.assertNoOverwriteInProgress(tx, r);
    await this.assertResendable(tx, r);
    const commandId = await this.erpSync.resend(tx, 'invoice', r.localId, r.connectorId);
    if (!commandId) throw conflict('nothing_to_resend');
    await tx.reconcileResult.update({
      where: { id },
      data: {
        overwriteStatus: 'SENT',
        overwriteRequestedBy: requestContext.require().actorId ?? null,
        overwriteRequestedAt: this.clock.now(),
        overwriteReason: reason,
        overwriteDecidedBy: null,
        overwriteDecidedAt: null,
        overwriteDecisionReason: null,
        overwriteCommandId: commandId,
      },
    });
    await this.audit.record({
      action: 'reconcile.overwrite_sent',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { overwriteStatus: r.overwriteStatus },
      after: {
        overwriteStatus: 'SENT',
        ...this.ref(r),
        commandId: encodeId('outboxCommand', commandId),
      },
    });
    return this.results.get(id);
  }

  /** (2ก) ขออนุมัติส่งทับระบบบัญชีด้วยค่า TMS ("ขออนุมัติแก้") */
  async requestOverwrite(id: string, reasonRaw: string): Promise<ReconcileResultDto> {
    const { tx, r, actor, reason } = await this.prepare(id, reasonRaw);
    this.assertDocumentOpen(r);
    await this.assertNoOverwriteInProgress(tx, r);
    await this.assertResendable(tx, r);
    await tx.reconcileResult.update({
      where: { id },
      data: {
        overwriteStatus: 'REQUESTED',
        overwriteRequestedBy: actor,
        overwriteRequestedAt: this.clock.now(),
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

  /**
   * (2ข) อนุมัติ → คำสั่งส่งทับพร้อม `approval` (ผ่าน approvalGate ของ ST8-T13) · ผู้อนุมัติต้องไม่ใช่ผู้ขอ และไม่ใช่ผู้สร้าง/แก้/ออกเลขใบ
   * (403 `erp_replace_self_approval` — กติกาเดียวกับคิว ST8-T13) · มีคำสั่งของเอกสารค้างอยู่ = 409 `command_in_progress` (ไม่ทิ้งการอนุมัติเงียบ ๆ)
   */
  async approveOverwrite(id: string, reasonRaw: string): Promise<ReconcileResultDto> {
    const { tx, r, actor, reason } = await this.prepare(id, reasonRaw);
    this.assertDocumentOpen(r);
    if (r.overwriteStatus !== 'REQUESTED')
      throw conflict('overwrite_not_requested', { overwriteStatus: r.overwriteStatus });
    const requesters = [
      ...new Set(
        [
          ...(r.overwriteRequestedBy ? [r.overwriteRequestedBy] : []),
          ...(await invoiceActors(tx, [r.localId])),
        ].filter(isPersonActor),
      ),
    ];
    if (!actor || !isPersonActor(actor) || requesters.includes(actor))
      throw new ProblemException('erp_replace_self_approval', undefined, undefined, {
        requestedBy: requesters,
      });
    await this.assertResendable(tx, r);
    const now = this.clock.now();
    const commandId = await this.erpSync.resend(tx, 'invoice', r.localId, r.connectorId, {
      approval: {
        approvedBy: actor,
        approvedAt: now.toISOString(),
        reason,
        reconcileResultId: encodeId('reconcileResult', r.id),
      },
      requesters: r.overwriteRequestedBy ? [r.overwriteRequestedBy] : [],
    });
    if (!commandId) throw conflict('nothing_to_resend');
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
        requestedBy: requesters,
        approvedBy: actor,
        commandId: encodeId('outboxCommand', commandId),
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
    if (r.overwriteRequestedBy === actor)
      throw new ProblemException('erp_replace_self_approval', undefined, undefined, {
        requestedBy: [r.overwriteRequestedBy],
      });
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
   * การส่งทับยังดำเนินอยู่ = มีคำขอรออนุมัติ หรือคำสั่งส่งทับ (SENT/APPROVED) ยังไม่จบ / ส่งสำเร็จแล้วรอรอบเทียบ (DONE)
   * คำสั่งจบแบบไม่สำเร็จ (FAILED_FINAL / SKIPPED) หรือไม่มีคำสั่ง = ปิดทางอื่น/ส่งใหม่ได้
   */
  private async assertNoOverwriteInProgress(tx: Tx, r: ReconcileResult): Promise<void> {
    if (r.overwriteStatus === 'REQUESTED')
      throw conflict('overwrite_in_progress', { overwriteStatus: r.overwriteStatus });
    if (
      (r.overwriteStatus === 'APPROVED' || r.overwriteStatus === 'SENT') &&
      r.overwriteCommandId
    ) {
      const c = await tx.integrationOutbox.findUnique({
        where: { id: r.overwriteCommandId },
        select: { status: true },
      });
      if (c && (OPEN_COMMAND.includes(c.status) || c.status === 'DONE'))
        throw conflict('overwrite_in_progress', {
          overwriteStatus: r.overwriteStatus,
          commandStatus: c.status,
        });
    }
  }

  /**
   * ส่งทับได้: ใบยังไม่ยกเลิก · ยังไม่รับชำระ (`paid_locked` — กฎ "แก้ได้จนรับชำระ") · connector ยังไม่ยกเลิก ·
   * ไม่มีคำสั่งของเอกสารนี้ค้าง (`command_in_progress`) · ระบบบัญชีแทนที่เอกสารได้ (adapter ยังไม่ทำ = `capability_not_implemented`
   * · ไม่รองรับ/ไม่เปิด = `replace_not_supported`) — เอกสารยังไม่อยู่ในระบบบัญชี = ส่งเป็นเอกสารใหม่ (ไม่ต้องแทนที่)
   */
  private async assertResendable(tx: Tx, r: ReconcileResult): Promise<void> {
    const [inv, c, m, open] = await Promise.all([
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
      tx.integrationOutbox.findFirst({
        where: {
          sink: ERP_SINK,
          targetId: r.connectorId,
          entityType: 'invoice',
          localId: r.localId,
          operation: { in: ['PUSH_INVOICE', 'REPLACE_DOCUMENT'] },
          status: { in: OPEN_COMMAND as never },
        },
        select: { id: true, status: true },
      }),
    ]);
    if (!inv) throw new ProblemException('not_found');
    if (inv.status === 'CANCELLED') throw conflict('invoice_voided');
    if ((SOR_PAYMENT_RECEIVED_STATUSES as readonly string[]).includes(inv.status))
      throw conflict('paid_locked', { invoiceStatus: inv.status });
    if (!c || c.status === 'DISCONNECTED') throw conflict('connector_disconnected');
    if (open)
      throw conflict('command_in_progress', {
        commandId: encodeId('outboxCommand', open.id),
        commandStatus: open.status,
      });
    // เงื่อนไข "อยู่ใน ERP แล้ว" เดียวกับ ErpSyncService.resend
    const partial = (m?.detail as { documentsPartial?: unknown } | null)?.documentsPartial === true;
    const inErp = !!m?.externalId && m.externalStatus !== 'VOIDED' && !partial;
    if (!inErp) return;
    if (this.resolver.describe(c).capabilities.includes('replaceDocument')) return;
    const adapter = this.adapters.get(c.adapterKey);
    if (adapter && isPendingCapability(adapter, 'replaceDocument'))
      throw conflict('capability_not_implemented');
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
