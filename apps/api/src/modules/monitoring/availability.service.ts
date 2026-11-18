import { Injectable, Logger } from '@nestjs/common';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../../db/prisma.service';
import { AVAILABILITY_TARGET_PCT, WORKER_STALE_SEC } from './monitor-config';
import { INSTANCE_ID } from './http-metrics';

const MINUTE = 60_000;
const BKK_OFFSET_MS = 7 * 3600_000;

/** ต้นเดือนตามเวลาไทย (Asia/Bangkok ไม่มี DST) → เวลา UTC */
export function bangkokMonthRange(month: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) throw new Error(`invalid month '${month}'`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return {
    start: new Date(Date.UTC(y, mo, 1) - BKK_OFFSET_MS),
    end: new Date(Date.UTC(y, mo + 1, 1) - BKK_OFFSET_MS),
  };
}

export function bangkokMonthOf(d: Date): string {
  const b = new Date(d.getTime() + BKK_OFFSET_MS);
  return `${b.getUTCFullYear()}-${String(b.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface MonthlyAvailability {
  month: string;
  targetPct: number;
  /** นาทีแรกที่เริ่มวัดในเดือนนี้ (ต้นเดือน หรือ probe แรกของระบบ) · null = ยังไม่มีข้อมูล */
  measuredFrom: Date | null;
  measuredTo: Date | null;
  minutes: number;
  upMinutes: number;
  downMinutes: number;
  /** นาทีที่ไม่มีผล probe (ตัววัดเองหยุด) — นับเป็นล่ม (ประเมินแบบระวัง) */
  missingMinutes: number;
  availabilityPct: number | null;
  /** สัดส่วนนาทีที่มีผล probe */
  coveragePct: number | null;
  met: boolean | null;
}

/** รายการ migration ที่ build มาด้วย (prisma/migrations) — ไม่เจอโฟลเดอร์ = ไม่ตรวจ */
function expectedMigration(): string | null {
  for (const dir of [
    resolve(process.cwd(), 'prisma/migrations'),
    resolve(__dirname, '../../../prisma/migrations'),
  ]) {
    try {
      const names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}_/.test(d.name))
        .map((d) => d.name)
        .sort();
      if (names.length) return names[names.length - 1]!;
    } catch {
      /* ลองที่ถัดไป */
    }
  }
  return null;
}
const EXPECTED_MIGRATION = expectedMigration();

export interface Readiness {
  status: 'ok' | 'degraded' | 'down';
  db: 'ok' | 'down';
  migrations: 'ok' | 'pending' | 'failed' | 'unknown';
  worker: 'ok' | 'stale' | 'missing' | 'unknown';
  workerHeartbeatAgeSec: number | null;
}

/**
 * ST9-T19 availability (docs/04 NFR Availability 99.5% รายเดือน; spec/11 NFR-901) + readiness + heartbeat
 * self-probe ทุก 1 นาที: GET /v1/readyz (DB + migration) → 1 แถว/นาที · วัดจากภายในระบบ (ยังไม่ใช่ synthetic check จากภายนอก)
 */
@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger('Availability');
  private readonly startedAt = new Date();
  constructor(private readonly prisma: PrismaService) {}

  async readiness(now = new Date()): Promise<Readiness> {
    const db = this.prisma.platform;
    let dbOk = true;
    let migrations: Readiness['migrations'] = 'unknown';
    try {
      const [m] = await db.$queryRaw<{ latest: string | null; broken: number }[]>`
        SELECT max(migration_name) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS latest,
               count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS broken
          FROM _prisma_migrations`;
      if (m?.broken) migrations = 'failed';
      else if (EXPECTED_MIGRATION && (m?.latest ?? '') < EXPECTED_MIGRATION) migrations = 'pending';
      else migrations = 'ok';
    } catch {
      // _prisma_migrations อ่านไม่ได้: ลอง SELECT 1 แยกว่าฐานล่มหรือแค่ไม่มีตาราง/สิทธิ์
      try {
        await db.$queryRaw`SELECT 1`;
      } catch {
        dbOk = false;
      }
    }
    let worker: Readiness['worker'] = 'unknown';
    let age: number | null = null;
    if (dbOk) {
      try {
        const [hb] = await db.$queryRaw<{ at: Date | null }[]>`
          SELECT max(last_beat_at) AS at FROM worker_heartbeat WHERE kind = 'worker'`;
        if (!hb?.at) worker = 'missing';
        else {
          age = Math.max(0, Math.round((now.getTime() - hb.at.getTime()) / 1000));
          worker = age > WORKER_STALE_SEC ? 'stale' : 'ok';
        }
      } catch {
        worker = 'unknown';
      }
    }
    // worker หยุด ≠ API รับคำขอไม่ได้ → `degraded` (200) ไม่ถอด instance ออกจาก load balancer ทั้งชุด
    const status: Readiness['status'] =
      !dbOk || migrations === 'pending' || migrations === 'failed'
        ? 'down'
        : worker === 'ok'
          ? 'ok'
          : 'degraded';
    return { status, db: dbOk ? 'ok' : 'down', migrations, worker, workerHeartbeatAgeSec: age };
  }

  async beat(kind: 'worker' | 'api', now = new Date(), instanceId = INSTANCE_ID): Promise<void> {
    await this.prisma.platform.$executeRaw`
      INSERT INTO worker_heartbeat (instance_id, kind, started_at, last_beat_at)
      VALUES (${instanceId}, ${kind}, ${this.startedAt}::timestamptz, ${now}::timestamptz)
      ON CONFLICT (instance_id) DO UPDATE SET last_beat_at = excluded.last_beat_at, kind = excluded.kind`;
  }

  async workerBeatAgeSec(now = new Date()): Promise<number | null> {
    const [hb] = await this.prisma.platform.$queryRaw<{ at: Date | null }[]>`
      SELECT max(last_beat_at) AS at FROM worker_heartbeat WHERE kind = 'worker'`;
    return hb?.at ? (now.getTime() - hb.at.getTime()) / 1000 : null;
  }

  /** probe 1 ครั้งต่อนาที — นาทีเดิมมีผลแล้ว (instance อื่น probe แล้ว) = ไม่เขียนซ้ำ */
  async probe(
    now: Date,
    source: 'worker' | 'api',
    url = process.env.MONITOR_PROBE_URL ||
      `http://127.0.0.1:${process.env.API_PORT ?? 4410}/v1/readyz`,
  ): Promise<{ ok: boolean; status: number | null; recorded: boolean }> {
    const minute = new Date(Math.floor(now.getTime() / MINUTE) * MINUTE);
    const t0 = performance.now();
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
      if (status !== 200) error = `http_${status}`;
    } catch (e) {
      error = String((e as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable');
    }
    const latency = Math.round(performance.now() - t0);
    const ok = status === 200;
    const n = await this.prisma.platform.$executeRaw`
      INSERT INTO availability_probe (minute, ok, status, latency_ms, error, source)
      VALUES (${minute}::timestamptz, ${ok}, ${status}, ${latency}, ${error}, ${source})
      ON CONFLICT (minute) DO NOTHING`;
    if (!ok) this.logger.warn(`self-probe failed: ${error}`);
    return { ok, status, recorded: n > 0 };
  }

  /** availability รายเดือน (เดือนตามเวลาไทย) — นาทีที่ไม่มีผล probe นับเป็นล่ม · maintenance ตามแผนยังไม่หักออก */
  async monthly(month: string, now = new Date()): Promise<MonthlyAvailability> {
    const { start, end } = bangkokMonthRange(month);
    const db = this.prisma.platform;
    const [first] = await db.$queryRaw<
      { at: Date | null }[]
    >`SELECT min(minute) AS at FROM availability_probe`;
    const nowMin = new Date(Math.floor(now.getTime() / MINUTE) * MINUTE);
    // นับถึงนาทีปัจจุบัน (รวมนาทีนี้ถ้า probe แล้ว)
    const [cur] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM availability_probe WHERE minute = ${nowMin}::timestamptz`;
    const upto = new Date(Math.min(end.getTime(), nowMin.getTime() + (cur?.n ? MINUTE : 0)));
    const from = first?.at ? new Date(Math.max(start.getTime(), first.at.getTime())) : null;
    const base: MonthlyAvailability = {
      month,
      targetPct: AVAILABILITY_TARGET_PCT,
      measuredFrom: null,
      measuredTo: null,
      minutes: 0,
      upMinutes: 0,
      downMinutes: 0,
      missingMinutes: 0,
      availabilityPct: null,
      coveragePct: null,
      met: null,
    };
    if (!from || from >= upto) return base;
    const [c] = await db.$queryRaw<{ up: number; down: number }[]>`
      SELECT count(*) FILTER (WHERE ok)::int AS up, count(*) FILTER (WHERE NOT ok)::int AS down
        FROM availability_probe WHERE minute >= ${from}::timestamptz AND minute < ${upto}::timestamptz`;
    const minutes = Math.round((upto.getTime() - from.getTime()) / MINUTE);
    const up = c?.up ?? 0;
    const down = c?.down ?? 0;
    const pct = (up / minutes) * 100;
    return {
      ...base,
      measuredFrom: from,
      measuredTo: upto,
      minutes,
      upMinutes: up,
      downMinutes: down,
      missingMinutes: Math.max(0, minutes - up - down),
      availabilityPct: Math.floor(pct * 1000) / 1000,
      coveragePct: Math.floor(((up + down) / minutes) * 100_000) / 1000,
      met: pct >= AVAILABILITY_TARGET_PCT,
    };
  }

  /** งานรายวัน: heartbeat เก่า 1 วัน · probe 400 วัน · นับคำขอ 35 วัน */
  async purge(now = new Date()): Promise<{ heartbeats: number; probes: number; http: number }> {
    const db = this.prisma.platform;
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const heartbeats =
      await db.$executeRaw`DELETE FROM worker_heartbeat WHERE last_beat_at < ${ago(86_400_000)}::timestamptz`;
    const probes =
      await db.$executeRaw`DELETE FROM availability_probe WHERE minute < ${ago(400 * 86_400_000)}::timestamptz`;
    const http =
      await db.$executeRaw`DELETE FROM http_request_minute WHERE minute < ${ago(35 * 86_400_000)}::timestamptz`;
    return { heartbeats, probes, http };
  }
}
