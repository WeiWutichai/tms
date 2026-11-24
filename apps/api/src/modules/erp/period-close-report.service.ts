import { Injectable } from '@nestjs/common';
import { monthRange, scopeAllows } from '@tms/domain';
import { Prisma, type ReconcileResult } from '@prisma/client';
import { Clock } from '../../common/clock';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService, type Tx } from '../../db/db.service';
import { actorNames } from '../stops/actor-names';
import { DOCUMENT_PUSH_OPS, RETRIED_SQL, tabSql } from './connector-queue';
import { ERP_SINK } from './erp-adapter.sink';
import { ErpAdapterRegistry } from './erp-adapter.registry';
import type { ExportSpec } from '../exports/export-spec';
import {
  type PeriodCloseExportRow,
  periodCloseExportColumns,
  periodCloseExportRows,
  periodCloseFileName,
  periodClosePdfSubtitle,
  periodClosePdfTitle,
} from './period-close-export';
import {
  type PeriodCloseAcknowledgedDto,
  type PeriodCloseMismatchDto,
  type PeriodCloseReportDto,
  PeriodCloseReportQuery,
  type PeriodCloseUnsentDto,
} from './period-close-report.dto';
import { RECONCILE_CHECK_DOCUMENT } from './reconcile-compare';
import { RECONCILE_CHECK_PAYMENT_STATUS } from './reconcile-results.service';

/** เพดานรายการต่อส่วน (ตัวนับใน summary ไม่ถูกตัด) */
export const PERIOD_CLOSE_MAX_ROWS = 5000;
/** ผลที่เป็น "MISMATCH" ของเกณฑ์ (ก) — INFO (อ่านไม่ได้/เทียบไม่ได้) แยกนับเป็น `unverified` */
const MISMATCH_RESULTS = ['MISMATCH', 'REMOTE_MISSING'] as const;
const INFO_RESULTS = ['ERP_UNREACHABLE', 'NOT_COMPARABLE'] as const;
const NONE = '00000000-0000-0000-0000-000000000000';
const BKK_OFFSET_MS = 7 * 3600_000;

/** เวลาเริ่ม/สิ้นสุดของเดือน (เวลาไทย) เป็น instant UTC — สิ้นเดือน = 00:00 น. วันที่ 1 ของเดือนถัดไป (ไม่รวม) */
export function bangkokMonthBounds(month: string): { start: Date; end: Date } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - BKK_OFFSET_MS),
    end: new Date(Date.UTC(y, m, 1) - BKK_OFFSET_MS),
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const MONEY_RE = /^-?\d+(\.\d+)?$/;

/** ส่วนต่างยอด (ระบบบัญชี − TMS) จาก diff — ยอดรับชำระ (PAYMENT_STATUS) หรือ `totals.total` ของเอกสาร (DOCUMENT) */
function differenceOf(diff: Record<string, unknown>): string | undefined {
  if (diff.check === RECONCILE_CHECK_PAYMENT_STATUS) return str(diff.difference) ?? undefined;
  if (diff.check === RECONCILE_CHECK_DOCUMENT && Array.isArray(diff.total)) {
    const t = (diff.total as { field?: unknown; local?: unknown; remote?: unknown }[]).find(
      (x) => x?.field === 'totals.total',
    );
    const a = str(t?.local);
    const b = str(t?.remote);
    if (a && b && MONEY_RE.test(a) && MONEY_RE.test(b))
      return new Prisma.Decimal(b).sub(a).toFixed(2);
  }
  return undefined;
}

function mismatchDto(r: ReconcileResult, asOf: Date): PeriodCloseMismatchDto {
  const diff = (r.diff ?? {}) as Record<string, unknown>;
  const closed = [r.resolvedAt, r.acknowledgedAt]
    .filter((d): d is Date => !!d && d >= asOf)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const sellDifferenceAmount = differenceOf(diff);
  return {
    id: encodeId('reconcileResult', r.id),
    invoiceId: r.entityType === 'INVOICE' ? encodeId('invoice', r.localId) : null,
    localNumber: r.localNumber,
    check: str(diff.check),
    code: str(diff.code),
    result: r.result,
    severity: r.severity,
    foundAt: r.runAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    currentStatus: r.resolvedAt ? 'RESOLVED' : r.acknowledgedAt ? 'ACKNOWLEDGED' : 'OPEN',
    closedAt: closed?.toISOString() ?? null,
    ...(sellDifferenceAmount !== undefined ? { sellDifferenceAmount } : {}),
  };
}

interface UnsentRow {
  id: string;
  entity_type: string;
  local_id: string;
  operation: string;
  status: string;
  error_class: string | null;
  error_code: string | null;
  next_run_at: Date | null;
  updated_at: Date;
  tab: string;
  doc_number: string | null;
  doc_date: string | null;
  customer_name: string | null;
  carrier_name: string | null;
  invoice_total: string | null;
  settlement_net: string | null;
}

/**
 * ST8-T14 รายงานปิดงวดต่อ connector ต่อเดือน (docs/02 §7 เกณฑ์ผ่าน (ก) "KRS ปิดงวด 2 เดือนติด MISMATCH ค้าง = 0"; docs/01 §6.5)
 * - (1) MISMATCH ค้าง ณ สิ้นเดือน = `reconcile_result` result MISMATCH/REMOTE_MISSING severity MONEY/FIELD ที่รอบตรวจพบ (`run_at`) ก่อนสิ้นเดือน
 *   และ ณ สิ้นเดือนยังไม่ถูกระบบปิด (`resolved_at`) และยังไม่มีคนยอมรับ (`acknowledged_at`) — ปิดหลังสิ้นเดือนยังนับ · พบหลังสิ้นเดือนไม่นับ
 * - (2) รายการที่ยอมรับความต่างในเดือน (`acknowledged_at` ในเดือน) + ผู้ยอมรับ + เหตุผล
 * - (3) เอกสารที่ยังไม่ถูกส่ง = วันที่เอกสาร ≤ สิ้นเดือน และคำสั่งส่งล่าสุดอยู่แท็บ "รอคิว"/"ล้มเหลว" ของคิว ST7-T19 ณ เวลาที่ออกรายงาน
 *   (เงื่อนไขแท็บชุดเดียวกับ `ConnectorQueueService` — รายการที่คนข้าม/กรอกเลขเองแล้วไม่นับ)
 * - เดือนที่ยังไม่จบ: ตัด ณ เวลาปัจจุบัน (`monthEnded` false → `passed` false)
 * - `passed` (PO 24 พ.ย. 2569 — ข้อ #95-b) = เดือนจบแล้ว **และ** MISMATCH ค้าง ณ สิ้นเดือน = 0 **และ** เอกสารที่ยังไม่ส่ง (`notSent`) = 0
 *   **และ** ยังไม่ได้ยืนยัน (`unverified` — INFO ที่เปิด ณ สิ้นเดือน) = 0 · `notSent` เป็นสถานะคิว ณ เวลาที่ออกรายงาน → ผลของเดือนที่จบแล้ว
 *   เปลี่ยนจาก "ไม่ผ่าน" เป็น "ผ่าน" ได้เมื่อส่งเอกสารค้างครบ
 * อ่านอย่างเดียว · ใน transaction ของ tenant (RLS) · connector ของ tenant อื่น = 404
 */
@Injectable()
export class PeriodCloseReportService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly adapters: ErpAdapterRegistry,
  ) {}

  async report(q: PeriodCloseReportQuery, tx: Tx = this.db.tx): Promise<PeriodCloseReportDto> {
    const connectorId = tryDecodeId('connector', q.connectorId) ?? NONE;
    const c = await tx.connector.findUnique({
      where: { id: connectorId },
      select: { id: true, adapterKey: true },
    });
    if (!c) throw new ProblemException('not_found');
    const now = this.clock.now();
    const { start, end } = bangkokMonthBounds(q.month);
    const monthEnded = now >= end;
    const asOf = monthEnded ? end : now;
    const range = monthRange(q.month);

    const outstandingWhere: Prisma.ReconcileResultWhereInput = {
      connectorId: c.id,
      // review: ใช้เวลาของรอบตรวจ (`run_at`) ไม่ใช่เวลาบันทึก — ฝั่งปิดก็เป็นเวลาของรอบ (`resolved_at` = run_at ของรอบที่ปิด)
      runAt: { lt: asOf },
      result: { in: [...MISMATCH_RESULTS] },
      severity: { in: ['MONEY', 'FIELD'] },
      AND: [
        { OR: [{ resolvedAt: null }, { resolvedAt: { gte: asOf } }] },
        { OR: [{ acknowledgedAt: null }, { acknowledgedAt: { gte: asOf } }] },
      ],
    };
    const ackWhere: Prisma.ReconcileResultWhereInput = {
      connectorId: c.id,
      acknowledgedAt: { gte: start, lt: asOf },
    };
    const [outstandingRows, bySeverity, unverified, ackRows, ackCount, unsent] = await Promise.all([
      tx.reconcileResult.findMany({
        where: outstandingWhere,
        orderBy: [{ runAt: 'asc' }, { id: 'asc' }],
        take: PERIOD_CLOSE_MAX_ROWS,
      }),
      tx.reconcileResult.groupBy({
        by: ['severity'],
        where: outstandingWhere,
        _count: { _all: true },
      }),
      tx.reconcileResult.count({
        where: {
          ...outstandingWhere,
          result: { in: [...INFO_RESULTS] },
          severity: 'INFO',
        },
      }),
      tx.reconcileResult.findMany({
        where: ackWhere,
        orderBy: [{ acknowledgedAt: 'asc' }, { id: 'asc' }],
        take: PERIOD_CLOSE_MAX_ROWS,
      }),
      tx.reconcileResult.count({ where: ackWhere }),
      this.unsent(tx, c.id, range.to),
    ]);
    const names = await actorNames(
      tx,
      ackRows.map((r) => r.acknowledgedBy),
    );
    const count = (s: string) => bySeverity.find((g) => g.severity === s)?._count._all ?? 0;
    const outstanding = count('MONEY') + count('FIELD');
    const notSent = unsent.map(unsentDto);
    return {
      connector: {
        id: encodeId('connector', c.id),
        adapterKey: c.adapterKey,
        displayName: this.adapters.get(c.adapterKey)?.displayName ?? null,
      },
      month: q.month,
      periodStart: range.from,
      periodEnd: range.to,
      asOf: asOf.toISOString(),
      monthEnded,
      // PO 24 พ.ย. 2569 (#95-b): ค้าง = 0 และยังไม่ส่ง = 0 และยังไม่ได้ยืนยัน = 0
      passed: monthEnded && outstanding === 0 && unsent.length === 0 && unverified === 0,
      generatedAt: now.toISOString(),
      summary: {
        outstanding,
        outstandingMoney: count('MONEY'),
        outstandingField: count('FIELD'),
        unverified,
        acknowledged: ackCount,
        notSent: unsent.length,
        notSentQueued: notSent.filter((x) => x.queueTab === 'queued').length,
        notSentFailed: notSent.filter((x) => x.queueTab === 'failed').length,
      },
      outstanding: outstandingRows.map((r) => mismatchDto(r, asOf)),
      acknowledged: ackRows.map((r): PeriodCloseAcknowledgedDto => ({
        ...mismatchDto(r, asOf),
        acknowledgedAt: r.acknowledgedAt!.toISOString(),
        acknowledgedBy: r.acknowledgedBy,
        acknowledgedByName: r.acknowledgedBy ? (names.get(r.acknowledgedBy) ?? null) : null,
        ackReason: r.ackReason,
      })),
      notSent: notSent.slice(0, PERIOD_CLOSE_MAX_ROWS),
      truncated:
        outstanding > outstandingRows.length ||
        ackCount > ackRows.length ||
        notSent.length > PERIOD_CLOSE_MAX_ROWS,
    };
  }

  /** คำสั่งส่งเอกสารล่าสุดต่อเอกสารที่ยังอยู่แท็บรอคิว/ล้มเหลว (ไม่รวมที่ส่งซ้ำแล้ว) และวันที่เอกสาร ≤ `lastDay` */
  private unsent(tx: Tx, connectorId: string, lastDay: string): Promise<UnsentRow[]> {
    const doc = Prisma.sql`o.payload->'document'`;
    return tx.$queryRaw<UnsentRow[]>`
      SELECT DISTINCT ON (o.entity_type, o.local_id)
             o.id, o.entity_type, o.local_id::text AS local_id, o.operation, o.status::text AS status,
             o.error_class, o.last_error->>'code' AS error_code, o.next_run_at, o.updated_at,
             CASE WHEN ${tabSql('queued')} THEN 'queued' ELSE 'failed' END AS tab,
             ${doc}->>'number' AS doc_number,
             COALESCE(${doc}->>'issueDate', ${doc}->>'paidDate') AS doc_date,
             ${doc}->'customer'->>'legalName' AS customer_name,
             ${doc}->'carrier'->>'legalName' AS carrier_name,
             ${doc}->'totals'->>'total' AS invoice_total,
             ${doc}->'totals'->>'net' AS settlement_net
        FROM integration_outbox o
       WHERE o.sink = ${ERP_SINK} AND o.target_id = ${connectorId}
         AND o.operation IN (${Prisma.join([...DOCUMENT_PUSH_OPS])})
         AND o.entity_type IN ('invoice', 'settlement')
         AND NOT ${RETRIED_SQL}
         AND ((${tabSql('queued')}) OR (${tabSql('failed')}))
         AND COALESCE(${doc}->>'issueDate', ${doc}->>'paidDate') <= ${lastDay}
       ORDER BY o.entity_type, o.local_id, o.seq DESC`.then((rows) =>
      rows.sort(
        (a, b) =>
          (a.doc_date ?? '').localeCompare(b.doc_date ?? '') ||
          (a.doc_number ?? '').localeCompare(b.doc_number ?? ''),
      ),
    );
  }
}

function unsentDto(r: UnsentRow): PeriodCloseUnsentDto {
  const inv = r.entity_type === 'invoice';
  const money = (v: string | null) =>
    v && MONEY_RE.test(v) ? new Prisma.Decimal(v).toFixed(2) : undefined;
  const sellTotalAmount = inv ? money(r.invoice_total) : undefined;
  const buyNetAmount = inv ? undefined : money(r.settlement_net);
  return {
    commandId: encodeId('outboxCommand', r.id),
    entityType: r.entity_type,
    documentId: encodeId(inv ? 'invoice' : 'settlement', r.local_id),
    documentNo: r.doc_number,
    documentDate: r.doc_date,
    counterpartyName: inv ? r.customer_name : r.carrier_name,
    operation: r.operation,
    queueTab: r.tab,
    status: r.status,
    errorClass: r.error_class,
    errorCode: r.error_code,
    nextRunAt: r.tab === 'queued' ? (r.next_run_at?.toISOString() ?? null) : null,
    updatedAt: r.updated_at.toISOString(),
    ...(sellTotalAmount !== undefined ? { sellTotalAmount } : {}),
    ...(buyNetAmount !== undefined ? { buyNetAmount } : {}),
  };
}

/**
 * ST8-T14 ส่งออก "รายงานปิดงวด" — xlsx / csv / pdf (แถวสรุป + 3 ส่วนในตารางเดียว) · อ่านจาก `PeriodCloseReportService`
 * ตัวเดียวกับ `GET /v1/reconcile-reports/period-close` · สิทธิ์ `integrations:read` (+ `export:run`) · ฟีเจอร์ `conn`
 * เงินขายเฉพาะ `prices.sell:read` · เงินซื้อเฉพาะ `prices.buy:read` (คอลัมน์ + redactPrices ของงานส่งออก)
 */
export const periodCloseExportSpec = (
  svc: PeriodCloseReportService,
): ExportSpec<PeriodCloseReportQuery, PeriodCloseExportRow> => ({
  resource: 'reconcile-period-close',
  label: 'รายงานปิดงวดเชื่อมระบบบัญชี',
  fileBase: 'reconcile-period-close',
  fileName: (q) => periodCloseFileName(q.month),
  scope: 'integrations:read',
  feature: 'conn',
  idKind: 'reconcileResult',
  single: true,
  query: PeriodCloseReportQuery,
  fetch: async (q) => periodCloseExportRows(await svc.report(q)),
  pdf: { title: () => periodClosePdfTitle(), subtitle: (q) => periodClosePdfSubtitle(q.month) },
  columns: (scopes) =>
    periodCloseExportColumns(
      scopeAllows(scopes, 'prices.sell:read'),
      scopeAllows(scopes, 'prices.buy:read'),
    ),
});
