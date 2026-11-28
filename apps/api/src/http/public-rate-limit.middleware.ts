import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { isLocalEnv } from '../auth/tokens';
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
 * rate limit ของ route group `/v1/public/*` และ `/v1/platform/auth/*` (ST1-T06/T24; docs/04 J) — ต่อ IP 60 ครั้ง (dev/test 120) ในหน้าต่างเลื่อน 1 นาที
 * ST7-T08: ย้ายจากหน่วยความจำต่อ process มาที่ตัวจำกัดกลาง (ใช้ร่วมทุก instance; ความหมายเดิม) · ฐานใช้ไม่ได้ = 503 (fail-closed)
 */
/**
 * ST9-T13 รอบสุดท้าย R2 (L-04): นอก dev/test ค่าเริ่ม 60/นาที/IP ตาม NFR-1106 [PROPOSED] (dev/test คง 120 — test/E2E เดิมไม่เปลี่ยน)
 * [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้: ตั้ง env `PUBLIC_RATE_LIMIT_PER_MIN`]
 */
export const PUBLIC_LIMIT_PER_MIN = Number(
  process.env.PUBLIC_RATE_LIMIT_PER_MIN ?? (isLocalEnv() ? 120 : 60),
);
const WINDOW_MS = 60_000;
/**
 * P1-ST2-T08: เพดานต่อ IP ของ `/v1/auth/*` (login, 2FA, step-up, ลืม/ตั้งรหัสผ่าน) — กันยิงถี่ก่อนถึงฐานข้อมูล
 * ซ้อนกับการล็อกบัญชี 5 ครั้ง/15 นาที (auth/throttle.ts ซึ่งต้องอ่าน/เขียนฐาน) · นอก dev/test 60/นาที/IP, dev/test 600
 * (E2E/test login จาก 127.0.0.1 ทุก test — เหมือน TOKEN_RATE_LIMIT_PER_IP_PER_MIN ของ E2E) · อ่านทุกคำขอ (test ปรับได้)
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้: ตั้ง env `AUTH_RATE_LIMIT_PER_MIN`]
 */
export const authLimitPerMin = () =>
  Number(process.env.AUTH_RATE_LIMIT_PER_MIN ?? (isLocalEnv() ? 600 : 60));

/**
 * ST9-T13 R2 review: แยกตัวนับต่อกลุ่ม route — ลิงก์สาธารณะ / login Console / คำเชิญ ไม่ใช้เพดานร่วมกัน
 * (ผู้ใช้หลายคนหลัง NAT เดียวกันเปิดลิงก์รถร่วมเยอะ ไม่ทำให้ทีม Innovera login Console หรือผู้ถูกเชิญรับคำเชิญไม่ได้)
 * ⚠ ต่อ IP ต้องตั้ง `TRUST_PROXY` ให้ตรงกับจำนวน proxy (UAT/production) — ไม่ตั้ง = ทุกคำขอเป็น IP ของ load balancer = เพดานเดียวทั้งระบบ
 */
export function publicBucketGroup(
  url: string,
): 'public' | 'console' | 'invite' | 'auth' | 'pricing' {
  const path = url.split('?')[0] ?? '';
  // P1-ST2-T02 review S4: หน้าราคาสาธารณะ (ผู้เข้าชมเว็บจำนวนมาก) ไม่ใช้เพดานร่วมกับลิงก์รถร่วม/ผู้รับ
  if (/^\/v1\/public\/plans\/?$/.test(path)) return 'pricing';
  if (/^\/v1\/platform\/auth\//.test(path)) return 'console';
  if (/^\/v1\/auth\/invitations\//.test(path)) return 'invite';
  if (/^\/v1\/auth\//.test(path)) return 'auth';
  return 'public';
}
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
      const group = publicBucketGroup(req.originalUrl ?? req.url);
      await this.limiter.assert(
        [
          slidingWindow(
            `ip:${group}:${ipKey(req.ip)}`,
            group === 'auth' ? authLimitPerMin() : PUBLIC_LIMIT_PER_MIN,
            WINDOW_MS,
            'ip',
          ),
        ],
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
