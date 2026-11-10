import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * rate limit ของ route group `/v1/public/*` (ST1-T06; docs/04 J) — นับต่อ IP ในหน้าต่าง 1 นาที
 * ในหน่วยความจำต่อ process — หลาย instance ให้ตั้งที่ load balancer/WAF ซ้อนอีกชั้น (plan/02 T-08)
 */
export const PUBLIC_LIMIT_PER_MIN = Number(process.env.PUBLIC_RATE_LIMIT_PER_MIN ?? 120);
const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

@Injectable()
export class PublicRateLimitMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (list.length >= PUBLIC_LIMIT_PER_MIN) {
      const retry = Math.ceil((WINDOW_MS - (now - list[0]!)) / 1000);
      res.setHeader('Retry-After', String(retry));
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
    hits.set(ip, list);
    if (hits.size > 50_000)
      for (const [k, v] of hits) if (now - (v.at(-1) ?? 0) > WINDOW_MS) hits.delete(k);
    next();
  }
}

/** สำหรับ test */
export function resetPublicRateLimit() {
  hits.clear();
}
