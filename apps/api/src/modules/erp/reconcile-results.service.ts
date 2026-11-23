import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type ReconcileResult, type ReconcileSource } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { canonicalJson } from '../integration/outbox.service';
import { ErpAdapterRegistry } from './erp-adapter.registry';
import {
  type CompareResult,
  type DocumentDiff,
  MONEY_FIELDS,
  RECONCILE_CHECK_DOCUMENT,
} from './reconcile-compare';
import type {
  ReconcileDocumentDiffDto,
  ReconcileResultDto,
  ReconcileResultListQuery,
  ReconcileResultPageDto,
} from './reconcile-result.dto';

const NONE = '00000000-0000-0000-0000-000000000000';
const ENTITY = 'reconcile_result';

/** การตรวจที่สร้างผล (ค่าใน `diff.check`) — ST7-T21 ยอดรับชำระ · เทียบเนื้อหาเอกสาร = `DOCUMENT` (ST8-T11 `reconcile-compare.ts`) */
export const RECONCILE_CHECK_PAYMENT_STATUS = 'PAYMENT_STATUS';

/**
 * ST8-T11 รหัสผลของการเทียบเอกสาร (`diff.code` ของ check `DOCUMENT`)
 * - `content_mismatch` เนื้อหาไม่ตรง (ดู `levels`) · `remote_missing` อ่านแล้วระบบบัญชีไม่พบเอกสาร (ST7-T16 ใช้รหัสเดียวกัน)
 * - `erp_unreachable` อ่านเอกสารไม่สำเร็จจนหมดรอบลองใหม่ (ปลายทางล่ม) — INFO ไม่เปลี่ยนผลกระทบยอดของใบ
 */
export const DOCUMENT_RESULT_CODES = [
  'content_mismatch',
  'remote_missing',
  'erp_unreachable',
  'remote_ref_mismatch',
  'not_comparable',
] as const;
/** รหัส `last_error` ของ external_mapping ที่ reconcile ตั้ง (รอบถัดไปตรง = คืน SYNCED) */
const RECONCILE_MAPPING_CODES = new Set([
  'reconcile_mismatch',
  'remote_missing',
  'remote_ref_mismatch',
]);

export type DocumentOutcome =
  | { kind: 'MATCH' }
  | { kind: 'MISMATCH'; compare: CompareResult }
  | { kind: 'REMOTE_MISSING'; externalId: string }
  | { kind: 'ERP_UNREACHABLE'; errorClass: string | null }
  /** ST8-T11 (review 1) เลขฝั่ง ERP ที่รู้ชี้ไปเอกสารที่ไม่ใช่ของใบนี้ (เลขอ้างอิงของเราไม่ตรง) — MISMATCH MONEY */
  | {
      kind: 'REF_MISMATCH';
      mismatched: { externalId: string; expectedRef: string; actualRef: string | null }[];
    }
  /** ST8-T11 (review 4) เทียบไม่ได้ (adapter ไม่มี comparableDocument / ไม่มีฐานของการส่ง / ผังรหัสไม่ครบ) — INFO ครั้งเดียว */
  | { kind: 'NOT_COMPARABLE'; reason: string };

export interface DocumentOutcomeInput {
  connectorId: string;
  adapterKey: string;
  /** external_mapping.entity_type — ST8-T11 ใช้กับใบแจ้งหนี้ */
  entityType: 'INVOICE';
  localId: string;
  localNumber: string | null;
  source: ReconcileSource;
  runAt: Date;
  outcome: DocumentOutcome;
  /** สรุปสั้นของแต่ละฝั่ง (ไม่เก็บเอกสารทั้งก้อน — ขนาด + ข้อมูลส่วนบุคคล) */
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
  /** id คำสั่ง outbox ที่อ่านเอกสาร (audit) */
  outboxId?: string | null;
}

export interface DocumentOutcomeResult {
  /** แถว reconcile_result ที่เกี่ยวข้อง (MATCH = null) */
  id: string | null;
  /** พบส่วนต่าง**ใหม่** (แจ้งเตือนได้) — ส่วนต่างเดิม (diff_hash เท่าเดิม รวมที่คนยอมรับแล้ว) = false */
  created: boolean;
  /** ERP_UNREACHABLE ที่ยังเปิดอยู่จากรอบก่อน (= ติดกัน ≥ 2 รอบ) */
  repeated: boolean;
  severity: 'MONEY' | 'FIELD' | 'INFO' | null;
  /** ผลกระทบยอดของใบหลังรอบนี้ (null = ไม่เปลี่ยน) */
  state: 'ACCEPTED' | 'MISMATCH' | null;
}

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
const mappingCode = (k: DocumentOutcome['kind']) =>
  k === 'MISMATCH'
    ? 'reconcile_mismatch'
    : k === 'REF_MISMATCH'
      ? 'remote_ref_mismatch'
      : 'remote_missing';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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
    private readonly adapters: ErpAdapterRegistry,
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
      await tx.reconcileResult.update({
        where: { id: r.id },
        data: { resolvedAt: at, resolution: 'NEXT_RUN_MATCHED' },
      });
      await this.audit.record({
        action: 'reconcile.mismatch_resolved',
        entityType: ENTITY,
        entityId: r.id,
        after: { check: RECONCILE_CHECK_PAYMENT_STATUS, resolvedBy: 'next_run_matched' },
      });
    }
    return mine.length;
  }

  /**
   * ST8-T11 ผลการเทียบเนื้อหาเอกสาร 1 ใบ (docs/01 §6.5, §4.4) — ผู้เรียกอยู่ใน transaction ของ tenant
   * - MATCH: ปิดส่วนต่างเอกสารที่ค้าง (`resolved_at` + audit `reconcile.mismatch_resolved`) · mapping → `reconcile_state` ACCEPTED
   *   (mapping ที่ reconcile เคยตั้ง MISMATCH กลับเป็น SYNCED — docs/01 §4.4 "MISMATCH → ACCEPTED : รอบถัดไปตรง")
   * - MISMATCH / REMOTE_MISSING: ส่วนต่างเดิมที่ยังเปิด (`diff_hash` เท่าเดิม — รวมที่คนยอมรับแล้ว) = ไม่สร้างแถว/ไม่ลง audit/ไม่แจ้งซ้ำ
   *   (อัปเดต `last_seen_at`) · ส่วนต่างเปลี่ยน = ปิดแถวเดิม เปิดแถวใหม่ + audit `reconcile.mismatch_found` (ไม่มีค่าในเอกสาร — นับเท่านั้น)
   *   · mapping `status` MISMATCH + `reconcile_state` MISMATCH (คนยอมรับส่วนต่างเดิมแล้ว = ACCEPTED — docs/01 §4.4 "ack พร้อมเหตุผล")
   * - ERP_UNREACHABLE: แถว INFO (ไม่เปลี่ยนผลกระทบยอดของใบ ไม่ปิดส่วนต่างอื่น) · `repeated` = รอบก่อนก็อ่านไม่ได้
   */
  async recordDocumentOutcome(
    tx: Tx,
    tenantId: string,
    m: DocumentOutcomeInput,
  ): Promise<DocumentOutcomeResult> {
    const scope = {
      connectorId: m.connectorId,
      entityType: m.entityType,
      localId: m.localId,
      resolvedAt: null,
    };
    const openDocs = (
      await tx.reconcileResult.findMany({
        where: scope,
        select: {
          id: true,
          diff: true,
          diffHash: true,
          acknowledgedAt: true,
          result: true,
          overwriteStatus: true,
        },
      })
    ).filter((r) => (r.diff as { check?: unknown } | null)?.check === RECONCILE_CHECK_DOCUMENT);
    const o = m.outcome;
    if (o.kind === 'MATCH') {
      for (const r of openDocs) {
        // ST8-T12 ส่งทับแล้ว (ส่งซ้ำตรง/อนุมัติแล้ว) รอบถัดไปตรง = ปิดทาง "TMS ถูก" (ERP_OVERWRITTEN) · อื่น ๆ = ตรงเอง
        const resolution =
          r.overwriteStatus === 'APPROVED' || r.overwriteStatus === 'SENT'
            ? 'ERP_OVERWRITTEN'
            : 'NEXT_RUN_MATCHED';
        await tx.reconcileResult.update({
          where: { id: r.id },
          data: { resolvedAt: m.runAt, resolution },
        });
        await this.audit.record({
          action: 'reconcile.mismatch_resolved',
          entityType: ENTITY,
          entityId: r.id,
          after: {
            check: RECONCILE_CHECK_DOCUMENT,
            resolution,
            resolvedBy: 'next_run_matched',
            source: m.source,
            connector: m.adapterKey,
          },
        });
      }
      await this.setMappingState(tx, m, 'ACCEPTED', null);
      return { id: null, created: false, repeated: false, severity: null, state: 'ACCEPTED' };
    }
    let diff: Record<string, unknown>;
    let diffHash: string;
    let result: 'MISMATCH' | 'REMOTE_MISSING' | 'ERP_UNREACHABLE' | 'NOT_COMPARABLE';
    let severity: 'MONEY' | 'FIELD' | 'INFO';
    if (o.kind === 'MISMATCH') {
      diff = o.compare.diff as unknown as Record<string, unknown>;
      diffHash = o.compare.diffHash;
      result = 'MISMATCH';
      severity = o.compare.severity ?? 'FIELD';
    } else if (o.kind === 'REMOTE_MISSING') {
      // รูปเดียวกับ ST7-T16 (ErpAdapterSink.remoteMissing) — hash เดียวกัน = ไม่ซ้ำกันข้ามสองทาง
      diff = {
        check: RECONCILE_CHECK_DOCUMENT,
        code: 'remote_missing',
        externalId: o.externalId.slice(0, 100),
      };
      diffHash = sha256(canonicalJson(diff));
      result = 'REMOTE_MISSING';
      severity = 'MONEY';
    } else if (o.kind === 'REF_MISMATCH') {
      diff = {
        check: RECONCILE_CHECK_DOCUMENT,
        code: 'remote_ref_mismatch',
        mismatched: o.mismatched.slice(0, 200).map((x) => ({
          externalId: x.externalId.slice(0, 100),
          expectedRef: x.expectedRef.slice(0, 100),
          actualRef: x.actualRef?.slice(0, 100) ?? null,
        })),
      };
      diffHash = sha256(canonicalJson(diff));
      result = 'MISMATCH';
      severity = 'MONEY';
    } else if (o.kind === 'NOT_COMPARABLE') {
      diff = {
        check: RECONCILE_CHECK_DOCUMENT,
        code: 'not_comparable',
        reason: /^[a-z0-9_.]{1,60}$/.test(o.reason) ? o.reason : 'not_comparable',
      };
      diffHash = sha256(canonicalJson(diff));
      result = 'NOT_COMPARABLE';
      severity = 'INFO';
    } else {
      diff = { check: RECONCILE_CHECK_DOCUMENT, code: 'erp_unreachable' };
      diffHash = sha256(canonicalJson(diff));
      result = 'ERP_UNREACHABLE';
      severity = 'INFO';
    }
    const same = openDocs.find((r) => r.diffHash === diffHash);
    if (same) {
      await tx.reconcileResult.update({ where: { id: same.id }, data: { lastSeenAt: m.runAt } });
      if (o.kind === 'ERP_UNREACHABLE' || o.kind === 'NOT_COMPARABLE')
        return { id: same.id, created: false, repeated: true, severity, state: null };
      const state = same.acknowledgedAt ? 'ACCEPTED' : 'MISMATCH';
      await this.setMappingState(tx, m, state, mappingCode(o.kind));
      return { id: same.id, created: false, repeated: false, severity, state };
    }
    // ส่วนต่างเปลี่ยน → ปิดแถวเดิม (ไม่ใช่ "ตรงกันแล้ว" — ไม่ลง audit resolved) · อ่านไม่ได้ ไม่ปิดส่วนต่างที่รู้อยู่
    if (o.kind !== 'ERP_UNREACHABLE' && o.kind !== 'NOT_COMPARABLE')
      await tx.reconcileResult.updateMany({
        where: { id: { in: openDocs.map((r) => r.id) } },
        data: { resolvedAt: m.runAt },
      });
    const row = await tx.reconcileResult.create({
      data: {
        tenantId,
        connectorId: m.connectorId,
        entityType: m.entityType,
        localId: m.localId,
        localNumber: m.localNumber?.slice(0, 60) ?? null,
        runAt: m.runAt,
        source: m.source,
        localSnapshot: m.local as Prisma.InputJsonValue,
        remoteSnapshot: m.remote as Prisma.InputJsonValue,
        diff: diff as Prisma.InputJsonValue,
        diffHash,
        result,
        severity,
        lastSeenAt: m.runAt,
      },
    });
    const d = o.kind === 'MISMATCH' ? o.compare.diff : null;
    await this.audit.record({
      action: o.kind === 'NOT_COMPARABLE' ? 'reconcile.not_comparable' : 'reconcile.mismatch_found',
      entityType: ENTITY,
      entityId: row.id,
      after: {
        check: RECONCILE_CHECK_DOCUMENT,
        code: diff.code,
        result,
        severity,
        source: m.source,
        connector: m.adapterKey,
        invoiceId: encodeId('invoice', m.localId),
        invoiceNo: m.localNumber,
        outboxId: m.outboxId ?? null,
        ...(d
          ? {
              levels: d.levels,
              localLines: d.lineCount.local,
              remoteLines: d.lineCount.remote,
              missingLines: d.missingLines.length,
              extraLines: d.extraLines.length,
              fieldDiffs: d.header.length + d.lineFields.length,
            }
          : {}),
      },
    });
    if (o.kind === 'ERP_UNREACHABLE' || o.kind === 'NOT_COMPARABLE')
      return { id: row.id, created: true, repeated: false, severity, state: null };
    await this.setMappingState(tx, m, 'MISMATCH', mappingCode(o.kind), row.id);
    return { id: row.id, created: true, repeated: false, severity, state: 'MISMATCH' };
  }

  /**
   * ผลกระทบยอดลง external_mapping (docs/01 §4.4 — แยกจาก `status` ของการส่ง):
   * ACCEPTED (รอบนี้ตรง / คนยอมรับส่วนต่าง) — mapping ที่ reconcile ตั้ง MISMATCH ไว้คืน SYNCED ·
   * MISMATCH — mapping `status` MISMATCH + `last_error` (รหัส reconcile) ให้หน้าคิว/การส่งใหม่เห็น
   */
  async setMappingState(
    tx: Tx,
    m: Pick<DocumentOutcomeInput, 'connectorId' | 'entityType' | 'localId' | 'runAt' | 'source'>,
    state: 'ACCEPTED' | 'MISMATCH',
    code: string | null,
    resultId?: string,
  ): Promise<void> {
    const row = await tx.externalMapping.findUnique({
      where: {
        connectorId_entityType_localId: {
          connectorId: m.connectorId,
          entityType: m.entityType,
          localId: m.localId,
        },
      },
      select: { id: true, status: true, lastError: true, reconcileState: true },
    });
    if (!row) return;
    const prevCode = (row.lastError as { code?: unknown } | null)?.code;
    const restore =
      state === 'ACCEPTED' &&
      row.status === 'MISMATCH' &&
      typeof prevCode === 'string' &&
      RECONCILE_MAPPING_CODES.has(prevCode);
    const flag =
      state === 'MISMATCH' && code !== null && !(row.status === 'MISMATCH' && prevCode === code);
    await tx.externalMapping.update({
      where: { id: row.id },
      data: {
        reconcileState: state,
        reconciledAt: m.runAt,
        ...(restore ? { status: 'SYNCED', lastError: Prisma.DbNull } : {}),
        ...(flag
          ? {
              status: 'MISMATCH',
              lastError: {
                code,
                source: m.source,
                ...(resultId ? { reconcileResultId: encodeId('reconcileResult', resultId) } : {}),
                at: m.runAt.toISOString(),
              },
            }
          : {}),
        ...(restore || flag || row.reconcileState !== state
          ? { updatedBy: 'system:reconcile', version: { increment: 1 } }
          : {}),
      },
    });
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
    // ST8-T12 ตัวกรองของหน้า MISMATCH
    if (q.check) and.push({ diff: { path: ['check'], equals: q.check } });
    if (q.actionable === 'true') and.push({ severity: { in: ['MONEY', 'FIELD'] } });
    else if (q.actionable === 'false') and.push({ severity: 'INFO' });
    if (q.overwriteStatus === 'NONE')
      and.push({ OR: [{ overwriteStatus: null }, { NOT: { overwriteStatus: 'REQUESTED' } }] });
    else if (q.overwriteStatus) and.push({ overwriteStatus: q.overwriteStatus });
    const rows = await tx.reconcileResult.findMany({
      where: { AND: and },
      orderBy: k.orderBy as unknown as Prisma.ReconcileResultOrderByWithRelationInput[],
      take: k.take,
      include: { connector: { select: { adapterKey: true } } },
    });
    const ctx = await this.context(tx, rows.slice(0, k.limit));
    return toPage(rows, k, (r) => toReconcileResultDto(r, ctx), q.fields) as ReconcileResultPageDto;
  }

  async get(id: string): Promise<ReconcileResultDto> {
    const tx = this.db.tx;
    const r = await tx.reconcileResult.findUnique({
      where: { id },
      include: { connector: { select: { adapterKey: true } } },
    });
    if (!r) throw new ProblemException('not_found');
    return toReconcileResultDto(r, await this.context(tx, [r]));
  }

  /** ST8-T12 ข้อมูลประกอบของหน้า MISMATCH (ลูกค้า สถานะใบ ใบที่ออกแทน การส่ง คำสั่งส่งทับ) — ดึงเป็นชุดต่อหน้า */
  private async context(tx: Tx, rows: ReconcileResult[]): Promise<ResultContext> {
    const invIds = [
      ...new Set(rows.filter((r) => r.entityType === 'INVOICE').map((r) => r.localId)),
    ];
    const cmdIds = rows.map((r) => r.overwriteCommandId).filter((x): x is string => !!x);
    const [invoices, sends, commands] = await Promise.all([
      invIds.length
        ? tx.invoice.findMany({
            where: { id: { in: invIds } },
            select: {
              id: true,
              status: true,
              customerId: true,
              customerSnapshot: true,
              customer: { select: { legalName: true } },
              replacedBy: {
                select: { id: true, invoiceNo: true },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
          })
        : [],
      invIds.length
        ? tx.$queryRaw<{ local_id: string; target_id: string; n: bigint; last: Date | null }[]>`
            SELECT local_id, target_id, count(*) AS n, max(COALESCE(done_at, created_at)) AS last
              FROM integration_outbox
             WHERE sink = ${ERP_SINK_KEY} AND entity_type = 'invoice'
               AND operation IN ('PUSH_INVOICE', 'REPLACE_DOCUMENT')
               AND local_id IN (${Prisma.join(invIds.map((x) => Prisma.sql`${x}::uuid`))})
             GROUP BY local_id, target_id`
        : [],
      cmdIds.length
        ? tx.integrationOutbox.findMany({
            where: { id: { in: cmdIds } },
            select: { id: true, status: true, lastError: true },
          })
        : [],
    ]);
    return {
      invoices: new Map(invoices.map((i) => [i.id, i])),
      sends: new Map(sends.map((x) => [`${x.local_id}:${x.target_id}`, x])),
      commands: new Map(commands.map((c) => [c.id, c])),
      actorId: requestContext.get()?.actorId ?? null,
      adapterName: (key) => this.adapters.get(key)?.displayName ?? null,
    };
  }
}

/** sink key ของคำสั่ง ERP (ค่าเดียวกับ `ERP_SINK` — ไม่ import sink เพื่อกันวนของโมดูล) */
const ERP_SINK_KEY = 'erp';

interface ResultContext {
  invoices: Map<
    string,
    {
      id: string;
      status: string;
      customerId: string;
      customerSnapshot: unknown;
      customer: { legalName: string };
      replacedBy: { id: string; invoiceNo: string | null }[];
    }
  >;
  sends: Map<string, { n: bigint; last: Date | null }>;
  commands: Map<string, { id: string; status: string; lastError: unknown }>;
  actorId: string | null;
  adapterName: (key: string) => string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toReconcileResultDto(
  r: ReconcileResult & { connector: { adapterKey: string } },
  ctx: ResultContext,
): ReconcileResultDto {
  const diff = (r.diff ?? {}) as Record<string, unknown>;
  const remote = (r.remoteSnapshot ?? {}) as Record<string, unknown>;
  const local = (r.localSnapshot ?? {}) as Record<string, unknown>;
  const inv = r.entityType === 'INVOICE' ? ctx.invoices.get(r.localId) : undefined;
  const snap = (inv?.customerSnapshot ?? null) as { name?: unknown } | null;
  const send = ctx.sends.get(`${r.localId}:${r.connectorId}`);
  const cmd = r.overwriteCommandId ? ctx.commands.get(r.overwriteCommandId) : undefined;
  const rep = inv?.replacedBy[0];
  return {
    id: encodeId('reconcileResult', r.id),
    connector: {
      id: encodeId('connector', r.connectorId),
      adapterKey: r.connector.adapterKey,
      displayName: ctx.adapterName(r.connector.adapterKey),
    },
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
    refMismatches:
      diff.check === RECONCILE_CHECK_DOCUMENT && Array.isArray(diff.mismatched)
        ? (diff.mismatched as {
            externalId: string;
            expectedRef: string;
            actualRef: string | null;
          }[])
        : null,
    documentDiff:
      diff.check === RECONCILE_CHECK_DOCUMENT && diff.code === 'content_mismatch'
        ? documentDiffDto(diff as unknown as DocumentDiff)
        : null,
    runAt: r.runAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    ackReason: r.ackReason,
    resolution: r.resolution,
    resolutionReason: r.resolutionReason,
    overwrite:
      r.overwriteStatus && r.overwriteRequestedAt
        ? {
            status: r.overwriteStatus,
            requestedAt: r.overwriteRequestedAt.toISOString(),
            reason: r.overwriteReason ?? '',
            requestedByMe: !!ctx.actorId && r.overwriteRequestedBy === ctx.actorId,
            decidedAt: r.overwriteDecidedAt?.toISOString() ?? null,
            decisionReason: r.overwriteDecisionReason,
            commandId: r.overwriteCommandId
              ? encodeId('outboxCommand', r.overwriteCommandId)
              : null,
            commandStatus: cmd?.status ?? null,
            commandErrorCode: str((cmd?.lastError as { code?: unknown } | null)?.code),
          }
        : null,
    customer: inv
      ? {
          id: encodeId('customer', inv.customerId),
          name: typeof snap?.name === 'string' ? snap.name : inv.customer.legalName,
        }
      : null,
    invoiceStatus: inv?.status ?? null,
    replacedByInvoice: rep ? { id: encodeId('invoice', rep.id), number: rep.invoiceNo } : null,
    sends: send ? { count: Number(send.n), lastSentAt: send.last?.toISOString() ?? null } : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** ช่องเงิน → `sellLocalValue` / `sellRemoteValue` (ตัดตามสิทธิ์ราคาขาย) · ช่องอื่น → `local` / `remote` */
function valueDto(field: string, local: string | null, remote: string | null) {
  const last = field.split('.').pop() ?? field;
  if (MONEY_FIELDS.has(last))
    return { field, local: null, remote: null, sellLocalValue: local, sellRemoteValue: remote };
  return { field, local, remote };
}

function documentDiffDto(d: DocumentDiff): ReconcileDocumentDiffDto {
  const arr = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  return {
    levels: arr(d.levels),
    lineCount: d.lineCount ?? null,
    missingLines: arr(d.missingLines),
    extraLines: arr(d.extraLines),
    header: arr(d.header).map((h) => valueDto(h.field, h.local, h.remote)),
    lineFields: arr(d.lineFields).map((l) => ({
      lineNo: l.lineNo,
      deliveryOrderNumber: l.deliveryOrderNumber,
      ...valueDto(l.field, l.local, l.remote),
    })),
    total: arr(d.total).map((t) => valueDto(t.field, t.local, t.remote)),
    totalSkipped: d.totalSkipped ?? null,
    truncated: !!d.truncated && Object.keys(d.truncated).length > 0,
  };
}
