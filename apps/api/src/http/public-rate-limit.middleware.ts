import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * rate limit ของ route group `/v1/public/*` (ST1-T06; docs/04 J) — นับต่อ IP ในหน้าต่าง 1 นาที
 * ในหน่วยความจำต่อ process — หลาย instance ให้ตั้งที่ load balancer/WAF ซ้อนอีกชั้น (plan/02 T-08)
 */
export const PUBLIC_LIMIT_PER_MIN = Number(process.env.PUBLIC_RATE_LIMIT_PER_MIN ?? 120);
const WINDOW_MS = 60_000;
/** เพดานจำนวน key — เกินแล้วทิ้ง key เก่าสุด (Map เรียงตามลำดับใส่) ไม่วนทั้ง map ต่อ request */
const MAX_KEYS = 50_000;
const hits = new Map<string, number[]>();
/** IPv6 นับต่อ /64 (ผู้ใช้หนึ่งคนเปลี่ยนเลขท้ายได้ทั้ง block) */
export function rateKey(ip: string): string {
  const v6 = ip.startsWith('::ffff:') ? null : ip.includes(':') ? ip : null;
  if (!v6) return ip.replace(/^::ffff:/, '');
  const parts = v6.split(':');
  return `${parts.slice(0, 4).join(':')}::/64`;
}
// กวาด key ที่พ้นหน้าต่างทุก 1 นาที (ไม่ทำใน request)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now - (v.at(-1) ?? 0) >= WINDOW_MS) hits.delete(k);
}, WINDOW_MS).unref();

@Injectable()
export class PublicRateLimitMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // ⚠ req.ip เชื่อ X-Forwarded-For 1 ชั้น (trust proxy 1) — deployment ต้องมี proxy หน้า API พอดี 1 ชั้น
    const ip = rateKey(req.ip ?? 'unknown');
    const now = Date.now();
    const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (list.length >= PUBLIC_LIMIT_PER_MIN) {
      const retry = Math.ceil((WINDOW_MS - (now - list[0]!)) / 1000);
      res.setHeader('Retry-After', String(retry));
      res.setHeader('Cache-Control', 'no-store');
      res.status(429).type('application/problem+json').json({
        type: 'https://docs.tms.example/problems/rate_limited',
        title: 'เรียกถี่เกินไป',
        status: 429,
        code: 'rate_limited',
        instance: req.originalUrl,
        retryAfter: retry,
      });
      return;
    }
    list.push(now);
    hits.delete(ip); // ย้ายไปท้าย (ใช้ล่าสุด)
    hits.set(ip, list);
    if (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value!);
    // ข้อมูลที่เปิดด้วยลิงก์ห้าม cache (token อยู่ใน URL)
    res.setHeader('Cache-Control', 'no-store');
    next();
  }
}

/** สำหรับ test */
export function resetPublicRateLimit() {
  hits.clear();
}
