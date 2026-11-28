import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { bangkokDate } from './usage-metrics';

/**
 * ขอบบนของช่อง histogram เวลาตอบ (ms) — ช่องที่ i นับคำขอที่ใช้เวลา ≤ LATENCY_BOUNDS_MS[i] (และ > ช่องก่อนหน้า)
 * ช่องสุดท้าย (index = length) = เกินขอบสุดท้าย · **ห้ามแก้ลำดับ/ค่าเดิม** (แถวเก่าใน api_traffic_daily อ้าง index นี้) — เพิ่มได้ท้ายเท่านั้น
 */
export const LATENCY_BOUNDS_MS = [
  10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000,
] as const;
const SLOTS = LATENCY_BOUNDS_MS.length + 1;

/** ช่องของเวลาตอบ */
export function latencySlot(ms: number): number {
  for (let i = 0; i < LATENCY_BOUNDS_MS.length; i++) if (ms <= LATENCY_BOUNDS_MS[i]!) return i;
  return LATENCY_BOUNDS_MS.length;
}

/**
 * p95 จาก histogram = ขอบบนของช่องที่ยอดสะสมถึง 95% (ประมาณค่าแบบปัดขึ้น — ค่าจริง ≤ ค่าที่คืน)
 * ไม่มีคำขอ = null · เกินขอบสุดท้าย = ขอบสุดท้าย (ผู้แสดงผลบอกว่า "> …")
 */
export function p95FromHist(hist: readonly number[]): { ms: number; over: boolean } | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const need = Math.ceil(total * 0.95);
  let run = 0;
  for (let i = 0; i < hist.length; i++) {
    run += hist[i]!;
    if (run >= need)
      return i < LATENCY_BOUNDS_MS.length
        ? { ms: LATENCY_BOUNDS_MS[i]!, over: false }
        : { ms: LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1]!, over: true };
  }
  return { ms: LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1]!, over: true };
}

/** รวม histogram หลายวัน (ความยาวต่างกันได้ — ช่องที่ไม่มี = 0) */
export function sumHist(rows: readonly (readonly number[] | null)[]): number[] {
  const out = new Array<number>(SLOTS).fill(0);
  for (const h of rows) h?.forEach((n, i) => (out[i] = (out[i] ?? 0) + n));
  return out;
}

interface Pending {
  requests: number;
  e4: number;
  e5: number;
  throttled: number;
  hist: number[];
}

const MAX_PENDING_KEYS = 50_000;

/**
 * สถิติคำขอ Open API ต่อบริษัทต่อวัน (P1-ST4-T05; spec/01 §10.7 "calls 30 วัน, error rate 5xx/4xx, p95 latency, 429 ที่ถูกตัด")
 * แบบเดียวกับ ApiUsageMeter: ต่อคำขอ = บวกในหน่วยความจำ (ไม่มี I/O) → flush batch ทุก 30 วิ (INSERT … ON CONFLICT บวกเพิ่ม)
 * - นับทุกคำขอของ API key / OAuth client ที่ยืนยันตัวตนผ่าน (รวม 4xx/5xx/429) · UI ของเราไม่นับ · sandbox ไม่นับ
 * - latency = เวลาตั้งแต่ middleware รับคำขอจนส่งคำตอบเสร็จ · 429 ไม่เข้า histogram (ไม่ได้ทำงานจริง — ไม่ให้ดึง p95 ลง)
 * - ไม่ใช่ตัวเลขออกบิล (ตัวนับบิล = usage_daily `api.calls`) · ฐานล่ม: เก็บไว้รอบหน้า
 */
export class ApiTrafficMeter {
  private readonly logger = new Logger('ApiTrafficMeter');
  private pending = new Map<string, Pending>();
  dropped = 0;
  private warnedAt = 0;

  get pendingKeys(): number {
    return this.pending.size;
  }

  record(tenantId: string, status: number, ms: number, at: Date = new Date()): void {
    const k = `${tenantId}|${bangkokDate(at)}`;
    let p = this.pending.get(k);
    if (!p) {
      if (this.pending.size >= MAX_PENDING_KEYS) {
        this.dropped += 1;
        if (Date.now() - this.warnedAt > 60_000) {
          this.warnedAt = Date.now();
          this.logger.warn(`api traffic meter: pending keys full — dropped ${this.dropped}`);
        }
        return;
      }
      p = { requests: 0, e4: 0, e5: 0, throttled: 0, hist: new Array<number>(SLOTS).fill(0) };
      this.pending.set(k, p);
    }
    p.requests += 1;
    if (status === 429) {
      p.throttled += 1;
      return;
    }
    if (status >= 500) p.e5 += 1;
    else if (status >= 400) p.e4 += 1;
    p.hist[latencySlot(ms)]! += 1;
  }

  async flush(db: Pick<PrismaClient, '$executeRaw'>): Promise<number> {
    const rows = [...this.pending.entries()];
    if (!rows.length) return 0;
    this.pending = new Map();
    const payload = JSON.stringify(
      rows.map(([k, p]) => {
        const [t, d] = k.split('|');
        return { t, d, r: p.requests, e4: p.e4, e5: p.e5, th: p.throttled, h: p.hist };
      }),
    );
    try {
      await db.$executeRaw`
        INSERT INTO api_traffic_daily (tenant_id, date, requests, errors_4xx, errors_5xx, throttled, latency_hist)
        SELECT x.t, x.d, x.r, x.e4, x.e5, x.th, x.h
          FROM jsonb_to_recordset(${payload}::jsonb) AS x(t uuid, d date, r int, e4 int, e5 int, th int, h int[])
          JOIN tenant tn ON tn.id = x.t AND tn.mode = 'live'
        ON CONFLICT (tenant_id, date) DO UPDATE SET
          requests = api_traffic_daily.requests + excluded.requests,
          errors_4xx = api_traffic_daily.errors_4xx + excluded.errors_4xx,
          errors_5xx = api_traffic_daily.errors_5xx + excluded.errors_5xx,
          throttled = api_traffic_daily.throttled + excluded.throttled,
          latency_hist = ARRAY(
            SELECT coalesce(a, 0) + coalesce(b, 0)
              FROM unnest(coalesce(api_traffic_daily.latency_hist, '{}'::int[]), excluded.latency_hist)
                   WITH ORDINALITY AS u(a, b, i)
             ORDER BY i),
          updated_at = now()`;
    } catch (e) {
      for (const [k, p] of rows) {
        const cur = this.pending.get(k);
        if (!cur) this.pending.set(k, p);
        else {
          cur.requests += p.requests;
          cur.e4 += p.e4;
          cur.e5 += p.e5;
          cur.throttled += p.throttled;
          p.hist.forEach((n, i) => (cur.hist[i]! += n));
        }
      }
      throw e;
    }
    return rows.length;
  }
}

/** instance เดียวต่อ process */
export const apiTrafficMeter = new ApiTrafficMeter();

/**
 * บริษัทที่จะนับคำขอนี้เข้าสถิติ (null = ไม่นับ): API key / OAuth client ของบริษัท live ทุกสถานะ —
 * รวมคำขอที่ถูกปฏิเสธตอนตรวจ key (`trafficTenantId` — ปิด API, เพิกถอน, หมดอายุ, IP, แพ็กเกจ) และ `POST /oauth/token` · UI / sandbox ไม่นับ
 */
export function apiTrafficTenant(
  ctx:
    | { tenantId?: string; principalType?: string; sandbox?: unknown; trafficTenantId?: string }
    | undefined,
): string | null {
  if (!ctx || ctx.sandbox) return null;
  if (ctx.trafficTenantId) return ctx.trafficTenantId;
  return ctx.tenantId && ctx.principalType === 'client' ? ctx.tenantId : null;
}
