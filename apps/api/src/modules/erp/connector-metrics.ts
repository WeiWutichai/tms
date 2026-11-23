import { Injectable } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import type { Connector } from '@prisma/client';
import { CONNECTOR_STATUSES } from '@tms/domain';
import { encodeId } from '../../common/ids';
import { DbService, type Tx } from '../../db/db.service';
import { RETRIED_SQL, tabSql } from './connector-queue';
import { ErpAdapterRegistry } from './erp-adapter.registry';
import { ERP_SINK } from './erp-adapter.sink';
import { PAYMENT_STATUS_PULL_JOB } from './payment-status-pull.service';

/**
 * ST9-T04 Dashboard เชื่อมต่อ (docs/04 H "ต่อ connector: คิว, ล้มเหลว, lag, health") + หน้า Health ของ admin portal
 * (docs/02 §5 "คิวค้าง, MISMATCH เปิดอยู่, poller ล่าสุด, error rate 7 วัน ต่อ tenant")
 *
 * ตัวเลขชุดเดียวใช้ทั้ง `GET /v1/connectors/metrics` (ใต้ RLS ของ tenant) และ `GET /v1/platform/connectors/health` (role platform)
 * - คิว: `queued` / `failed` = เงื่อนไขเดียวกับแท็บของหน้าคิว (ST7-T19 `tabSql`) → ตัวเลขตรงกับ badge
 * - lag = อายุของคำสั่งที่ค้างนานสุด (แท็บรอคิว: PENDING / IN_FLIGHT / FAILED_RETRYABLE) — ปลายทางล่ม คำสั่งพัก (`connector_unhealthy`) → lag โต
 * - health = สถานะ connector + ผล healthCheck ล่าสุด (worker ตรวจทุก 5 นาที — docs/01 §A.4 "healthCheck ทุก 5 นาที")
 * - error rate 7 วัน = สัดส่วนการเรียกระบบบัญชี (erp_sync_log) ที่ปลายทางไม่ตอบ / 5xx / 401 / 403 / 408 / 429 —
 *   ความผิดพลาดของระบบ/การเชื่อมต่อ ไม่นับคำตอบทางธุรกิจ (400/404/409/422 = ข้อมูลไม่ผ่าน/ไม่พบ) [DECISION spec/12 §3 ST9-T04]
 * - ไม่มีเนื้อหาเอกสาร/ยอดเงิน/ข้อความ error ดิบ — เฉพาะตัวนับ เวลา และรหัส
 * query ต่อ connector ใช้ index: integration_outbox (target_id, status, done_at) WHERE sink='erp' (migration 0173),
 * erp_sync_log (tenant_id, connector_id, occurred_at), reconcile_result (connector_id, …), connector_cursor (connector_id),
 * job (tenant_id, created_at) ช่วง 8 วัน
 */

export const HEALTH_STATES = ['OK', 'DEGRADED', 'DOWN', 'PAUSED', 'UNKNOWN'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];
const ERROR_RATE_DAYS = 7;

export class ConnectorHealthStateDto {
  @ApiProperty({
    enum: HEALTH_STATES,
    description:
      '`OK` healthCheck ล่าสุดผ่าน · `DEGRADED` ACTIVE แต่ healthCheck ล่าสุดล้ม (คิวพัก — ครบ 30 นาที = ERROR) · ' +
      '`DOWN` connector ERROR · `PAUSED` ผู้ดูแลหยุด · `UNKNOWN` ยังไม่เคยตรวจ',
  })
  state!: HealthState;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastCheckAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'เริ่มล้มต่อเนื่องเมื่อ',
  })
  failingSince!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'TRANSIENT' }) errorClass!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'unreachable' }) code!: string | null;
}

export class ConnectorQueueMetricsDto {
  @ApiProperty({ description: 'แท็บรอคิว (ระบบกำลังส่ง/รอส่งซ้ำเอง)' }) queued!: number;
  @ApiProperty({ description: 'แท็บล้มเหลว — ต้องมีคนทำ (= badge เมนู)' }) failed!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'คำสั่งค้างที่เก่าสุด',
  })
  oldestQueuedAt!: string | null;
  @ApiProperty({ description: 'lag (วินาที) = อายุของคำสั่งค้างที่เก่าสุด · ไม่มีค้าง = 0' })
  lagSeconds!: number;
}

export class ConnectorPollerDto {
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'รอบดึงล่าสุด (ดึง SO `pullOrders` / ดึงสถานะรับชำระ — อันที่ใหม่กว่า) · null = ไม่มี poller',
  })
  lastRunAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'รอบดึง SO ล่าสุด',
  })
  ordersLastRunAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'รอบดึง SO ที่ครบโดยไม่มีใบ error ล่าสุด',
  })
  ordersLastSuccessAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'รอบดึงสถานะรับชำระที่จบล่าสุด',
  })
  paymentStatusLastRunAt!: string | null;
}

export class ConnectorErrorRateDto {
  @ApiProperty({ description: `จำนวนการเรียกระบบบัญชีใน ${ERROR_RATE_DAYS} วัน` }) calls!: number;
  @ApiProperty({ description: 'ที่ปลายทางไม่ตอบ / 5xx / 401 / 403 / 408 / 429' }) failed!: number;
  @ApiProperty({
    description: 'failed / calls (0–1, 4 ตำแหน่ง) · ไม่มีการเรียก = 0',
    example: 0.0125,
  })
  rate!: number;
}

export class ConnectorMetricsDto {
  @ApiProperty({ example: 'con_8f3a…' }) id!: string;
  @ApiProperty({ example: 'demo' }) adapterKey!: string;
  @ApiProperty({ nullable: true, type: String, example: 'Demo ERP' }) displayName!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'cmp_…' }) companyId!: string | null;
  @ApiProperty({ enum: CONNECTOR_STATUSES }) status!: string;
  @ApiProperty({ type: ConnectorHealthStateDto }) health!: ConnectorHealthStateDto;
  @ApiProperty({ type: ConnectorQueueMetricsDto }) queue!: ConnectorQueueMetricsDto;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'ซิงก์ล่าสุด = คำสั่งที่สำเร็จล่าสุด',
  })
  lastSyncAt!: string | null;
  @ApiProperty({
    description: 'รายการไม่ตรงกับระบบบัญชีที่เปิดอยู่ (MONEY/FIELD ยังไม่ปิด ยังไม่ ack)',
  })
  openMismatches!: number;
  @ApiProperty({
    description: 'ใบที่รอบตรวจยอดอ่านจากระบบบัญชีไม่ได้ (ERP_UNREACHABLE ที่ยังเปิดอยู่)',
  })
  reconcileUnreachable!: number;
  @ApiProperty({ type: ConnectorPollerDto }) poller!: ConnectorPollerDto;
  @ApiProperty({ type: ConnectorErrorRateDto }) errorRate7d!: ConnectorErrorRateDto;
}

export class ConnectorMetricsListDto {
  @ApiProperty({ type: [ConnectorMetricsDto] }) data!: ConnectorMetricsDto[];
}

interface Row {
  id: string;
  queued: number;
  failed: number;
  oldest: Date | null;
  lag: number | null;
  last_done: Date | null;
  open_mismatch: number;
  unreachable: number;
  pull_at: Date | null;
  pull_ok_at: Date | null;
  pay_at: Date | null;
  calls: number;
  failed_calls: number;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

export function healthState(c: Connector): HealthState {
  if (c.status === 'ERROR') return 'DOWN';
  if (c.status === 'PAUSED' || c.status === 'DISCONNECTED') return 'PAUSED';
  if (c.healthFailingSince || c.lastHealthOk === false) return 'DEGRADED';
  if (c.lastHealthOk === true) return 'OK';
  return 'UNKNOWN';
}

@Injectable()
export class ConnectorMetricsService {
  constructor(
    private readonly db: DbService,
    private readonly adapters: ErpAdapterRegistry,
  ) {}

  /** connector ของ tenant ปัจจุบัน (RLS) ที่ยังไม่ยกเลิก */
  async forTenant(tx: Tx = this.db.tx): Promise<ConnectorMetricsDto[]> {
    const rows = await tx.connector.findMany({
      where: { status: { not: 'DISCONNECTED' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return this.of(tx, rows);
  }

  /** ตัวเลขของ connector ที่ให้มา — `tx` ใต้ RLS ของ tenant หรือ client role platform (Console) */
  async of(tx: Tx, connectors: Connector[]): Promise<ConnectorMetricsDto[]> {
    if (!connectors.length) return [];
    const ids = connectors.map((c) => c.id);
    const rows = await tx.$queryRaw<Row[]>`
      SELECT c.id::text AS id,
             COALESCE(q.queued, 0)::int AS queued, COALESCE(q.failed, 0)::int AS failed, q.oldest,
             CASE WHEN q.oldest IS NULL THEN 0
                  ELSE GREATEST(0, floor(extract(epoch FROM (now() - q.oldest))))::int END AS lag,
             d.last_done,
             COALESCE(m.open_mismatch, 0)::int AS open_mismatch, COALESCE(m.unreachable, 0)::int AS unreachable,
             p.pull_at, p.pull_ok_at, j.pay_at,
             COALESCE(l.calls, 0)::int AS calls, COALESCE(l.failed_calls, 0)::int AS failed_calls
        FROM connector c
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE ${tabSql('queued')}) AS queued,
                 count(*) FILTER (WHERE ${tabSql('failed')}) AS failed,
                 min(o.created_at) FILTER (WHERE ${tabSql('queued')}) AS oldest
            FROM integration_outbox o
           WHERE o.sink = ${ERP_SINK} AND o.target_id = c.id::text AND o.tenant_id = c.tenant_id
             AND (o.status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'SKIPPED')
                  OR (o.status = 'DONE' AND (o.last_error->>'manualExternalIdRequired') = 'true'))
             AND NOT ${RETRIED_SQL}) q ON true
        LEFT JOIN LATERAL (
          SELECT max(o.done_at) AS last_done FROM integration_outbox o
           WHERE o.sink = ${ERP_SINK} AND o.target_id = c.id::text AND o.status = 'DONE') d ON true
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE r.result IN ('MISMATCH', 'REMOTE_MISSING')
                                    AND r.severity IN ('MONEY', 'FIELD')
                                    AND r.acknowledged_at IS NULL) AS open_mismatch,
                 count(*) FILTER (WHERE r.result = 'ERP_UNREACHABLE') AS unreachable
            FROM reconcile_result r
           WHERE r.connector_id = c.id AND r.resolved_at IS NULL) m ON true
        LEFT JOIN LATERAL (
          SELECT max(k.last_pull_at) AS pull_at, max(k.last_success_at) AS pull_ok_at
            FROM connector_cursor k WHERE k.connector_id = c.id) p ON true
        LEFT JOIN LATERAL (
          SELECT max(jb.finished_at) AS pay_at FROM job jb
           WHERE jb.tenant_id = c.tenant_id AND jb.type = ${PAYMENT_STATUS_PULL_JOB}
             AND jb.created_at >= now() - interval '8 days'
             AND jb.finished_at IS NOT NULL
             AND jb.payload->>'connectorId' = c.id::text) j ON true
        LEFT JOIN LATERAL (
          SELECT count(*) AS calls,
                 count(*) FILTER (WHERE s.status_code IS NULL OR s.status_code >= 500
                                     OR s.status_code IN (401, 403, 408, 429)) AS failed_calls
            FROM erp_sync_log s
           WHERE s.tenant_id = c.tenant_id AND s.connector_id = c.id
             AND s.occurred_at >= now() - make_interval(days => ${ERROR_RATE_DAYS}::int)) l ON true
       WHERE c.id = ANY(${ids}::uuid[])`;
    const by = new Map(rows.map((r) => [r.id, r]));
    return connectors.map((c) => this.dto(c, by.get(c.id)));
  }

  private dto(c: Connector, r: Row | undefined): ConnectorMetricsDto {
    const err = (c.lastHealthError ?? null) as { errorClass?: unknown; code?: unknown } | null;
    const state = healthState(c);
    const failing = state === 'DEGRADED' || state === 'DOWN';
    const calls = r?.calls ?? 0;
    const failedCalls = r?.failed_calls ?? 0;
    const pull = r?.pull_at ?? null;
    const pay = r?.pay_at ?? null;
    return {
      id: encodeId('connector', c.id),
      adapterKey: c.adapterKey,
      displayName: this.adapters.get(c.adapterKey)?.displayName ?? null,
      companyId: c.companyId ? encodeId('company', c.companyId) : null,
      status: c.status,
      health: {
        state,
        lastCheckAt: iso(c.lastHealthAt),
        failingSince: iso(c.healthFailingSince),
        errorClass: failing && typeof err?.errorClass === 'string' ? err.errorClass : null,
        code: failing && typeof err?.code === 'string' ? err.code.slice(0, 60) : null,
      },
      queue: {
        queued: r?.queued ?? 0,
        failed: r?.failed ?? 0,
        oldestQueuedAt: iso(r?.oldest),
        lagSeconds: r?.lag ?? 0,
      },
      lastSyncAt: iso(r?.last_done),
      openMismatches: r?.open_mismatch ?? 0,
      reconcileUnreachable: r?.unreachable ?? 0,
      poller: {
        lastRunAt: iso(later(pull, pay)),
        ordersLastRunAt: iso(pull),
        ordersLastSuccessAt: iso(r?.pull_ok_at),
        paymentStatusLastRunAt: iso(pay),
      },
      errorRate7d: {
        calls,
        failed: failedCalls,
        rate: calls ? Math.round((failedCalls / calls) * 10_000) / 10_000 : 0,
      },
    };
  }
}
