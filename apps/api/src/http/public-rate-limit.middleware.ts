import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ProblemFilter } from '../common/problem.filter';
import { ProblemException } from '../common/problem';
import {
  ipKey,
  rateKey,
  rateLimitInstance,
  RateLimitService,
  slidingWindow,
} from './rate-limit/rate-limit.service';

/**
 * rate limit ของ route group `/v1/public/*` และ `/v1/platform/auth/*` (ST1-T06/T24; docs/04 J) — ต่อ IP 120 ครั้งในหน้าต่างเลื่อน 1 นาที
 * ST7-T08: ย้ายจากหน่วยความจำต่อ process มาที่ตัวจำกัดกลาง (ใช้ร่วมทุก instance; ความหมายเดิม) · ฐานใช้ไม่ได้ = 503 (fail-closed)
 */
export const PUBLIC_LIMIT_PER_MIN = Number(process.env.PUBLIC_RATE_LIMIT_PER_MIN ?? 120);
const WINDOW_MS = 60_000;
export { rateKey };

@Injectable()
export class PublicRateLimitMiddleware implements NestMiddleware {
  private readonly filter = new ProblemFilter();
  constructor(private readonly limiter: RateLimitService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // ข้อมูลที่เปิดด้วยลิงก์ห้าม cache (token อยู่ใน URL)
    res.setHeader('Cache-Control', 'no-store');
    // ⚠ req.ip เชื่อ X-Forwarded-For ตาม TRUST_PROXY — deployment ต้องตั้งจำนวน proxy ให้ตรง
    try {
      await this.limiter.assert(
        [slidingWindow(`ip:${ipKey(req.ip)}`, PUBLIC_LIMIT_PER_MIN, WINDOW_MS, 'ip')],
        res,
      );
    } catch (e) {
      // middleware อยู่นอก exception filter ของ Nest — ส่ง problem+json รูปเดียวกับ ProblemFilter เอง
      if (e instanceof ProblemException) {
        this.filter.catch(e, {
          switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
        } as never);
        return;
      }
      return next(e);
    }
    next();
  }
}

/** สำหรับ test: ล้างตัวนับต่อ IP ของไฟล์ test นี้ */
export async function resetPublicRateLimit(): Promise<void> {
  await rateLimitInstance()?.reset('ip:');
}
