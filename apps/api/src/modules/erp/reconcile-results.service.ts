import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type ReconcileResult, type ReconcileSource } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { DbService, type Tx } from '../../db/db.service';
import type {
  ReconcileResultDto,
  ReconcileResultListQuery,
  ReconcileResultPageDto,
} from './reconcile-result.dto';

const NONE = '00000000-0000-0000-0000-000000000000';
const ENTITY = 'reconcile_result';

/** การตรวจที่สร้างผล (ค่าใน `diff.check`) — ST7-T21 มีชนิดเดียว · เทียบเอกสารรายบรรทัด = ST8-T11 */
export const RECONCILE_CHECK_PAYMENT_STATUS = 'PAYMENT_STATUS';

/**
 * ส่วนต่างยอดรับชำระ (ST7-T21) — ทุกตัว = ไม่แตะเงินใน TMS ให้คนตัดสิน
 * - `remote_exceeds_total`: ERP ตัดหนี้เกินยอดรวมของใบใน TMS
 * - `remote_paid_amount_short`: ERP บอกว่าชำระครบ แต่ยอดตัดหนี้ < ยอดรวมของใบ (ไม่เดาว่าส่วนที่ขาดเป็น WHT/ส่วนลด)
 * - `remote_less_than_tms`: ERP ตัดหนี้น้อยกว่าที่ TMS บันทึกรับไว้ (ERP ยังไม่รู้ / ERP กลับรายการ)
 * - `tms_has_other_payments`: ERP ตัดหนี้มากกว่า TMS แต่ใบนี้มีรับชำระที่คนบันทึกเอง/มาจากช่องทางอื่น — ไม่รู้ว่ายอด ERP รวมรายการนั้นหรือไม่
 * - `connector_payment_reversed`: ใบนี้เคยมีรับชำระที่ระบบสร้างจากยอด ERP แล้วถูกกลับรายการใน TMS — ไม่สร้างอัตโนมัติให้ใบนี้อีก
 *   (ปิดเองเมื่อยอด ERP = ยอด TMS)
 * - `remote_wht_unknown`: ERP ไม่บอกยอด WHT → ไม่ยืนยันตัวเลขเงินเข้าแทน ERP
 * - `remote_wht_inconsistent`: WHT ที่ ERP รายงานขัดกับที่บันทึกไว้
 * - `remote_paid_at_invalid`: วันที่รับชำระจาก ERP ไม่มี / เป็นอนาคต / ก่อนวันออกใบ (ไม่ปัดวันที่เอง)
 * - `payment_rejected`: กฎรับชำระของ TMS ไม่รับ (`diff.reason` = รหัสของกฎ — ไม่มียอดเงิน)
 */
export const PAYMENT_MISMATCH_CODES = [
  'remote_exceeds_total',
  'remote_paid_amount_short',
  'remote_less_than_tms',
  'tms_has_other_payments',
  'connector_payment_reversed',
  'remote_wht_unknown',
  'remote_wht_inconsistent',
  'remote_paid_at_invalid',
  'payment_rejected',
] as const;
export type PaymentMismatchCode = (typeof PAYMENT_MISMATCH_CODES)[number];

export interface PaymentMismatchInput {
  connectorId: string;
  adapterKey: string;
  invoiceId: string;
  invoiceNo: string | null;
  source: ReconcileSource;
  runAt: Date;
  code: PaymentMismatchCode;
  /** สตริงเงิน 2 ตำแหน่ง */
  localPaid: string;
  remotePaid: string;
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
  reason?: string | null;
}

/** `external_mapping.external_id` ของรับชำระที่รอบดึงสร้างให้ใบนี้: `paystatus:{invoiceId}:{ยอดสะสม}` */
export const PULL_PAYMENT_KEY_PREFIX = 'paystatus:';
export const pullPaymentKeyPrefix = (invoiceId: string) =>
  `${PULL_PAYMENT_KEY_PREFIX}${invoiceId}:`;

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * ผลกระทบยอดกับระบบภายนอก (ST7-T21 — ชิ้นเล็กสุดของ docs/01 §3.7 `reconcile_result`, §6.5; ไม่ผูก ERP ใด)
 * - `recordPaymentMismatch`: ส่วนต่างยอดรับชำระ → แถว MISMATCH severity MONEY + audit `reconcile.mismatch_found`
 *   · ส่วนต่างเดิมที่ยังเปิด (รวมที่คนยอมรับแล้ว) ไม่สร้างแถว/ไม่ลง audit ซ้ำ (`diff_hash`) · ส่วนต่างเปลี่ยน = ปิดแถวเดิม เปิดแถวใหม่
 * - `resolvePaymentMismatches`: รอบที่ตรงกันแล้ว → ปิดแถวที่ค้าง (`resolved_at`) + audit `reconcile.mismatch_resolved`
 * - อ่าน: `GET /v1/reconcile-results` (API-first — หน้าจอ MISMATCH = ST8-T12)
 * ผู้เรียกต้องอยู่ใน transaction ของ tenant + request context (audit)
 */
@Injectable()
export class ReconcileResultsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** คืน `created: false` เมื่อส่วนต่างเดิมยังเปิดอยู่ (ไม่แจ้งซ้ำ) */
  async recordPaymentMismatch(
    tx: Tx,
    tenantId: string,
    m: PaymentMismatchInput,
  ): Promise<{ id: string; created: boolean }> {
    const diff = {
      check: RECONCILE_CHECK_PAYMENT_STATUS,
      code: m.code,
      localPaid: m.localPaid,
      remotePaid: m.remotePaid,
      difference: new Prisma.Decimal(m.remotePaid).sub(m.localPaid).toFixed(2),
      // รหัสเท่านั้น (ตัวอักษร/ขีดล่าง) — ห้ามมียอดเงิน
      ...(m.reason && /^[a-z0-9_.]{1,60}$/.test(m.reason) ? { reason: m.reason } : {}),
    };
    const diffHash = sha({
      check: diff.check,
      code: diff.code,
      localPaid: diff.localPaid,
      remotePaid: diff.remotePaid,
      remoteStatus: m.remote.status ?? null,
      reason: m.reason ?? null,
    });
    const scope = {
      connectorId: m.connectorId,
      entityType: 'INVOICE' as const,
      localId: m.invoiceId,
      resolvedAt: null,
    };
    const same = await tx.reconcileResult.findFirst({ where: { ...scope, diffHash } });
    if (same) {
      await tx.reconcileResult.update({ where: { id: same.id }, data: { lastSeenAt: m.runAt } });
      return { id: same.id, created: false };
    }
    // ส่วนต่างเปลี่ยน → ปิดแถวเดิม (ไม่ใช่ "ตรงกันแล้ว" — ไม่ลง audit resolved)
    await tx.reconcileResult.updateMany({ where: scope, data: { resolvedAt: m.runAt } });
    const row = await tx.reconcileResult.create({
      data: {
        tenantId,
        connectorId: m.connectorId,
        entityType: 'INVOICE',
        localId: m.invoiceId,
        localNumber: m.invoiceNo?.slice(0, 60) ?? null,
        runAt: m.runAt,
        source: m.source,
        localSnapshot: m.local as Prisma.InputJsonValue,
        remoteSnapshot: m.remote as Prisma.InputJsonValue,
        diff: diff as Prisma.InputJsonValue,
        diffHash,
        result: 'MISMATCH',
        severity: 'MONEY',
        lastSeenAt: m.runAt,
      },
    });
    await this.audit.record({
      action: 'reconcile.mismatch_found',
      entityType: ENTITY,
      entityId: row.id,
      after: {
        check: diff.check,
        code: diff.code,
        severity: 'MONEY',
        connector: m.adapterKey,
        invoiceId: encodeId('invoice', m.invoiceId),
        invoiceNo: m.invoiceNo,
        // ชื่อขึ้นต้น sell = ยอดฝั่งขาย (กติกา price-fields ข้อ 3)
        sellLocalPaidAmount: diff.localPaid,
        sellRemotePaidAmount: diff.remotePaid,
        remoteStatus: m.remote.status ?? null,
      },
    });
    return { id: row.id, created: true };
  }

  /** รอบนี้ยอดตรงกันแล้ว → ปิดส่วนต่างยอดรับชำระที่ค้างของใบนี้ · คืนจำนวนที่ปิด */
  async resolvePaymentMismatches(
    tx: Tx,
    connectorId: string,
    invoiceId: string,
    at: Date,
  ): Promise<number> {
    const open = await tx.reconcileResult.findMany({
      where: { connectorId, entityType: 'INVOICE', localId: invoiceId, resolvedAt: null },
      select: { id: true, diff: true },
    });
    const mine = open.filter(
      (r) => (r.diff as { check?: unknown } | null)?.check === RECONCILE_CHECK_PAYMENT_STATUS,
    );
    for (const r of mine) {
      await tx.reconcileResult.update({ where: { id: r.id }, data: { resolvedAt: at } });
      await this.audit.record({
        action: 'reconcile.mismatch_resolved',
        entityType: ENTITY,
        entityId: r.id,
        after: { check: RECONCILE_CHECK_PAYMENT_STATUS, resolvedBy: 'next_run_matched' },
      });
    }
    return mine.length;
  }

  // ---------- อ่าน ----------

  async list(q: ReconcileResultListQuery): Promise<ReconcileResultPageDto> {
    const tx = this.db.tx;
    const k = keysetArgs(q);
    const and: Prisma.ReconcileResultWhereInput[] = [k.where as Prisma.ReconcileResultWhereInput];
    if (q.status === 'OPEN') and.push({ resolvedAt: null, acknowledgedAt: null });
    else if (q.status === 'ACKNOWLEDGED')
      and.push({ resolvedAt: null, NOT: { acknowledgedAt: null } });
    else if (q.status === 'RESOLVED') and.push({ NOT: { resolvedAt: null } });
    if (q.connectorId !== undefined)
      and.push({ connectorId: tryDecodeId('connector', q.connectorId) ?? NONE });
    if (q.invoiceId !== undefined)
      and.push({ entityType: 'INVOICE', localId: tryDecodeId('invoice', q.invoiceId) ?? NONE });
    if (q.severity) and.push({ severity: q.severity });
    const rows = await tx.reconcileResult.findMany({
      where: { AND: and },
      orderBy: k.orderBy as unknown as Prisma.ReconcileResultOrderByWithRelationInput[],
      take: k.take,
      include: { connector: { select: { adapterKey: true } } },
    });
    return toPage(rows, k, toReconcileResultDto, q.fields) as ReconcileResultPageDto;
  }

  async get(id: string): Promise<ReconcileResultDto> {
    const r = await this.db.tx.reconcileResult.findUnique({
      where: { id },
      include: { connector: { select: { adapterKey: true } } },
    });
    if (!r) throw new ProblemException('not_found');
    return toReconcileResultDto(r);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function toReconcileResultDto(
  r: ReconcileResult & { connector: { adapterKey: string } },
): ReconcileResultDto {
  const diff = (r.diff ?? {}) as Record<string, unknown>;
  const remote = (r.remoteSnapshot ?? {}) as Record<string, unknown>;
  const local = (r.localSnapshot ?? {}) as Record<string, unknown>;
  return {
    id: encodeId('reconcileResult', r.id),
    connector: { id: encodeId('connector', r.connectorId), adapterKey: r.connector.adapterKey },
    entityType: r.entityType,
    invoiceId: r.entityType === 'INVOICE' ? encodeId('invoice', r.localId) : null,
    localNumber: r.localNumber,
    result: r.result,
    severity: r.severity,
    source: r.source,
    status: r.resolvedAt ? 'RESOLVED' : r.acknowledgedAt ? 'ACKNOWLEDGED' : 'OPEN',
    check: str(diff.check),
    code: str(diff.code),
    reason: str(diff.reason),
    localStatus: str(local.status),
    remoteStatus: str(remote.status),
    remotePaidAt: str(remote.paidAt),
    externalDocNo: str(remote.externalDocNo),
    sellLocalPaidAmount: str(diff.localPaid) ?? undefined,
    sellRemotePaidAmount: str(diff.remotePaid) ?? undefined,
    sellDifferenceAmount: str(diff.difference) ?? undefined,
    runAt: r.runAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
