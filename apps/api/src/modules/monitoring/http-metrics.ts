import { hostname } from 'node:os';
import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';

/**
 * ST9-T19 ตัวนับคำขอ HTTP ในหน่วยความจำของ API instance (Prometheus counter/histogram — ไม่มี lib ภายนอก)
 * label: method, route = แม่แบบ route ของ Nest (เช่น `/orders/:id` — ไม่มี id/ข้อมูลลูกค้า), status class (2xx/4xx/5xx)
 * route ที่ไม่ตรงแม่แบบใด (404 สุ่ม URL) รวมเป็น `unmatched` — กันจำนวน series โตตามผู้เรียก
 * histogram แยกตาม route class (ส่วนแรกของ route) เพื่อคุมจำนวน series
 */
export const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export const INSTANCE_ID = `${hostname()}:${process.pid}`.slice(0, 120);

interface Hist {
  buckets: number[];
  sum: number;
  count: number;
}

export class HttpMetrics {
  readonly requests = new Map<string, number>();
  readonly latency = new Map<string, Hist>();
  /** นาที (epoch ms) → [ทั้งหมด, 5xx] ที่ยังไม่ flush ลงฐาน */
  private pending = new Map<number, [number, number]>();

  record(method: string, route: string, status: number, seconds: number, at = Date.now()): void {
    const sc = `${Math.floor(status / 100)}xx`;
    const k = `${method}\u0000${route}\u0000${sc}`;
    this.requests.set(k, (this.requests.get(k) ?? 0) + 1);
    const cls = routeClass(route);
    let h = this.latency.get(cls);
    if (!h)
      this.latency.set(cls, (h = { buckets: LATENCY_BUCKETS.map(() => 0), sum: 0, count: 0 }));
    LATENCY_BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.buckets[i]!++;
    });
    h.sum += seconds;
    h.count++;
    const minute = Math.floor(at / 60_000) * 60_000;
    const p = this.pending.get(minute) ?? [0, 0];
    p[0]++;
    if (status >= 500) p[1]++;
    this.pending.set(minute, p);
  }

  /** เขียนจำนวนต่อนาทีลง `http_request_minute` (บวกเพิ่ม) — ใช้คิด alert 5xx ข้าม instance */
  async flush(db: Pick<PrismaClient, '$executeRaw'>, instanceId = INSTANCE_ID): Promise<number> {
    const rows = [...this.pending.entries()];
    if (!rows.length) return 0;
    this.pending = new Map();
    try {
      for (const [minute, [total, errors]] of rows)
        await db.$executeRaw`
          INSERT INTO http_request_minute (minute, instance_id, total, errors)
          VALUES (${new Date(minute)}::timestamptz, ${instanceId}, ${total}, ${errors})
          ON CONFLICT (minute, instance_id) DO UPDATE
            SET total = http_request_minute.total + excluded.total,
                errors = http_request_minute.errors + excluded.errors`;
    } catch (e) {
      // ฐานล่ม: เก็บไว้ส่งรอบหน้า (ไม่ทิ้งตัวเลขช่วงที่ระบบมีปัญหาที่สุด)
      for (const [minute, [t, er]] of rows) {
        const p = this.pending.get(minute) ?? [0, 0];
        this.pending.set(minute, [p[0] + t, p[1] + er]);
      }
      throw e;
    }
    return rows.length;
  }
}

/** ส่วนแรกของ route (`/orders/:id` → `orders`, `/platform/tenants` → `platform`) */
export function routeClass(route: string): string {
  if (route === 'unmatched') return 'unmatched';
  return route.split('/').filter(Boolean)[0] ?? 'root';
}

/** instance เดียวต่อ process (middleware ใช้ร่วมกับ controller /metrics) */
export const httpMetrics = new HttpMetrics();

/** middleware: นับเมื่อส่งคำตอบเสร็จ — อ่านแม่แบบ route ที่ Express จับได้ (ไม่ใช้ URL จริง) */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const tpl = (req as Request & { route?: { path?: unknown } }).route?.path;
    const route =
      typeof tpl === 'string' && tpl ? tpl.replace(/^\/v1(?=\/|$)/, '') || '/' : 'unmatched';
    const sec = Number(process.hrtime.bigint() - started) / 1e9;
    httpMetrics.record(req.method, route, res.statusCode, sec);
  });
  next();
}
