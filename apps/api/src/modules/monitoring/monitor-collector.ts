import { Injectable } from '@nestjs/common';
import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeId } from '../../common/ids';
import { PrismaService } from '../../db/prisma.service';
import { loadRules, type RuleConfig, type RuleKey } from './monitor-config';

/** สถานะคิว outbox ต่อ sink (ไม่นับคำสั่งที่พักเพราะบริษัทถูกระงับใน lag/age — แยกเป็น parked) */
export interface OutboxSinkStat {
  sink: string;
  pending: number;
  retrying: number;
  inFlight: number;
  parked: number;
  failedFinal: number;
  /** คำสั่งที่ถึงเวลาแล้วยังไม่ถูกหยิบ — รอนานสุด (วินาที) */
  lagSec: number;
  /** คำสั่งที่ยังไม่จบ — อายุนับจากสร้าง (วินาที) */
  oldestAgeSec: number;
}

export interface ConnectorStat {
  /** external id (`con_…`) — ไม่ใช่ชื่อบริษัท */
  id: string;
  adapter: string;
  status: string;
  healthOk: boolean | null;
  /** เฉพาะ connector ที่เปิด pullOrders: วินาทีนับจากดึงสำเร็จล่าสุด (ยังไม่เคย = นับจากเปิดใช้) */
  pullLagSec: number | null;
}

/** ภาพรวม ณ เวลาหนึ่ง — ใช้ทั้ง /v1/metrics และ alert evaluator (ตัวเลขชุดเดียวกัน) */
export interface MonitorSnapshot {
  at: Date;
  outbox: OutboxSinkStat[];
  webhook: { delivered: number; failed: number; exhausted: number; autoDisabled: number };
  jobs: { pending: number; running: number; lagSec: number; failedWindow: number };
  email: { pending: number; lagSec: number; failedWindow: number };
  connectors: ConnectorStat[];
  inbound: { stuck: number; oldestSec: number };
  disk: { freeBytes: number; totalBytes: number; usedRatio: number } | null;
  worker: { newestBeatAgeSec: number | null; instances: number };
  http: { total: number; errors: number };
  probe: { total: number; failed: number };
}

type Num = number | bigint | null;
const n = (v: Num | undefined) => (v === null || v === undefined ? 0 : Number(v));

/** ตัวเก็บตัวเลข (role platform — ข้ามทุก tenant · คืนเฉพาะจำนวน/อายุ ไม่มีข้อมูลลูกค้า) */
@Injectable()
export class MonitorCollector {
  readonly rules: Record<RuleKey, RuleConfig> = loadRules();
  constructor(private readonly prisma: PrismaService) {}

  async collect(now: Date): Promise<MonitorSnapshot> {
    const db = this.prisma.platform;
    const r = this.rules;
    const win = (k: RuleKey, def: number) =>
      new Date(now.getTime() - (r[k].windowMin ?? def) * 60_000);
    const [outbox, webhook, jobs, email, connectors, inbound, worker, http, probe, disk] =
      await Promise.all([
        db.$queryRaw<
          {
            sink: string;
            pending: Num;
            retrying: Num;
            in_flight: Num;
            parked: Num;
            failed_final: Num;
            lag: Num;
            age: Num;
          }[]
        >`
          SELECT sink,
                 count(*) FILTER (WHERE status = 'PENDING' AND parked_at IS NULL) AS pending,
                 count(*) FILTER (WHERE status = 'FAILED_RETRYABLE' AND parked_at IS NULL) AS retrying,
                 count(*) FILTER (WHERE status = 'IN_FLIGHT') AS in_flight,
                 count(*) FILTER (WHERE parked_at IS NOT NULL AND status IN ('PENDING', 'FAILED_RETRYABLE')) AS parked,
                 count(*) FILTER (WHERE status = 'FAILED_FINAL') AS failed_final,
                 coalesce(extract(epoch FROM ${now}::timestamptz - min(
                   CASE WHEN status IN ('PENDING', 'FAILED_RETRYABLE') AND parked_at IS NULL AND next_run_at <= ${now}::timestamptz
                          THEN next_run_at
                        WHEN status = 'IN_FLIGHT' AND lease_until <= ${now}::timestamptz THEN lease_until END)), 0) AS lag,
                 coalesce(extract(epoch FROM ${now}::timestamptz - min(created_at)
                   FILTER (WHERE status IN ('PENDING', 'FAILED_RETRYABLE', 'IN_FLIGHT') AND parked_at IS NULL)), 0) AS age
            FROM integration_outbox
           WHERE status IN ('PENDING', 'FAILED_RETRYABLE', 'IN_FLIGHT', 'FAILED_FINAL')
           GROUP BY sink ORDER BY sink`,
        db.$queryRaw<{ delivered: Num; failed: Num; exhausted: Num; disabled: Num }[]>`
          SELECT count(*) FILTER (WHERE status = 'DELIVERED') AS delivered,
                 count(*) FILTER (WHERE status = 'FAILED') AS failed,
                 count(*) FILTER (WHERE status = 'EXHAUSTED') AS exhausted,
                 (SELECT count(*) FROM webhook_endpoint WHERE status = 'AUTO_DISABLED' AND deleted_at IS NULL) AS disabled
            FROM webhook_delivery
           WHERE NOT test AND sent_at > ${win('webhook_failure_rate', 15)}::timestamptz AND sent_at <= ${now}::timestamptz`,
        db.$queryRaw<{ pending: Num; running: Num; lag: Num; failed: Num }[]>`
          SELECT count(*) FILTER (WHERE status = 'PENDING') AS pending,
                 count(*) FILTER (WHERE status = 'RUNNING') AS running,
                 coalesce(extract(epoch FROM ${now}::timestamptz - min(
                   CASE WHEN status = 'PENDING' AND run_at <= ${now}::timestamptz THEN run_at
                        WHEN status = 'RUNNING' AND locked_until <= ${now}::timestamptz THEN locked_until END)), 0) AS lag,
                 count(*) FILTER (WHERE status = 'FAILED' AND finished_at > ${win('job_failed', 60)}::timestamptz) AS failed
            FROM job WHERE status IN ('PENDING', 'RUNNING', 'FAILED')`,
        db.$queryRaw<{ pending: Num; lag: Num; failed: Num }[]>`
          SELECT count(*) FILTER (WHERE status IN ('PENDING', 'SENDING')) AS pending,
                 coalesce(extract(epoch FROM ${now}::timestamptz - min(
                   CASE WHEN status = 'PENDING' AND run_at <= ${now}::timestamptz THEN run_at
                        WHEN status = 'SENDING' AND locked_until <= ${now}::timestamptz THEN locked_until END)), 0) AS lag,
                 count(*) FILTER (WHERE status = 'FAILED' AND updated_at > ${new Date(now.getTime() - 3600_000)}::timestamptz) AS failed
            FROM email_outbox WHERE status IN ('PENDING', 'SENDING', 'FAILED')`,
        db.$queryRaw<
          {
            id: string;
            adapter: string;
            status: string;
            health_ok: boolean | null;
            pulls: boolean;
            last_ok: Date | null;
            activated: Date | null;
          }[]
        >`
          SELECT c.id::text, c.adapter_key AS adapter, c.status::text AS status, c.last_health_ok AS health_ok,
                 ('pullOrders' = ANY(c.capabilities_enabled)) AS pulls,
                 (SELECT max(cc.last_success_at) FROM connector_cursor cc WHERE cc.connector_id = c.id) AS last_ok,
                 coalesce(c.activated_at, c.status_changed_at, c.created_at) AS activated
            FROM connector c WHERE c.status <> 'DISCONNECTED' ORDER BY c.created_at, c.id`,
        db.$queryRaw<{ stuck: Num; oldest: Num }[]>`
          SELECT count(*) AS stuck, coalesce(extract(epoch FROM ${now}::timestamptz - min(e.received_at)), 0) AS oldest
            FROM processed_webhook_event e JOIN connector c ON c.id = e.connector_id
           WHERE e.status = 'RECEIVED' AND c.status = 'ACTIVE'
             AND e.received_at < ${win('inbound_stuck', 15)}::timestamptz`,
        db.$queryRaw<{ newest: Date | null; instances: Num }[]>`
          SELECT max(last_beat_at) AS newest,
                 count(*) FILTER (WHERE last_beat_at > ${new Date(now.getTime() - 180_000)}::timestamptz) AS instances
            FROM worker_heartbeat WHERE kind = 'worker'`,
        db.$queryRaw<{ total: Num; errors: Num }[]>`
          SELECT coalesce(sum(total), 0) AS total, coalesce(sum(errors), 0) AS errors FROM http_request_minute
           WHERE minute >= ${win('http_5xx_rate', 5)}::timestamptz AND minute <= ${now}::timestamptz`,
        db.$queryRaw<{ total: Num; failed: Num }[]>`
          SELECT count(*) AS total, count(*) FILTER (WHERE NOT ok) AS failed FROM availability_probe
           WHERE minute > ${win('probe_failed', 5)}::timestamptz AND minute <= ${now}::timestamptz`,
        diskStat(),
      ]);
    const w = webhook[0];
    const j = jobs[0];
    const e = email[0];
    const hb = worker[0];
    return {
      at: now,
      outbox: outbox.map((o) => ({
        sink: o.sink,
        pending: n(o.pending),
        retrying: n(o.retrying),
        inFlight: n(o.in_flight),
        parked: n(o.parked),
        failedFinal: n(o.failed_final),
        lagSec: Math.max(0, Math.round(n(o.lag))),
        oldestAgeSec: Math.max(0, Math.round(n(o.age))),
      })),
      webhook: {
        delivered: n(w?.delivered),
        failed: n(w?.failed),
        exhausted: n(w?.exhausted),
        autoDisabled: n(w?.disabled),
      },
      jobs: {
        pending: n(j?.pending),
        running: n(j?.running),
        lagSec: Math.max(0, Math.round(n(j?.lag))),
        failedWindow: n(j?.failed),
      },
      email: {
        pending: n(e?.pending),
        lagSec: Math.max(0, Math.round(n(e?.lag))),
        failedWindow: n(e?.failed),
      },
      connectors: connectors.map((c) => {
        const since = c.last_ok ?? c.activated;
        return {
          id: encodeId('connector', c.id),
          adapter: c.adapter,
          status: c.status,
          healthOk: c.health_ok,
          pullLagSec:
            c.pulls && c.status === 'ACTIVE' && since
              ? Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000))
              : null,
        };
      }),
      inbound: {
        stuck: n(inbound[0]?.stuck),
        oldestSec: Math.max(0, Math.round(n(inbound[0]?.oldest))),
      },
      disk,
      worker: {
        newestBeatAgeSec: hb?.newest
          ? Math.max(0, Math.round((now.getTime() - hb.newest.getTime()) / 1000))
          : null,
        instances: n(hb?.instances),
      },
      http: { total: n(http[0]?.total), errors: n(http[0]?.errors) },
      probe: { total: n(probe[0]?.total), failed: n(probe[0]?.failed) },
    };
  }
}

/** พื้นที่ของ filesystem ที่เก็บไฟล์ (FILES_ROOT) — อ่านไม่ได้ (ยังไม่มีโฟลเดอร์) = null */
export async function diskStat(
  path = resolve(process.env.FILES_ROOT ?? './.data/files'),
): Promise<MonitorSnapshot['disk']> {
  // โฟลเดอร์ยังไม่ถูกสร้าง → ดูโฟลเดอร์แม่ที่มีอยู่ (filesystem เดียวกันในเกือบทุกกรณี)
  for (let p = path; ;) {
    try {
      const s = await statfs(p);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      return { freeBytes: free, totalBytes: total, usedRatio: total > 0 ? 1 - free / total : 0 };
    } catch {
      const parent = resolve(p, '..');
      if (parent === p) return null;
      p = parent;
    }
  }
}
