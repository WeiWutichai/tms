import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ProblemException } from '../../common/problem';
import { ProblemFilter } from '../../common/problem.filter';
import { signupEnabled } from './signup.service';

/**
 * สวิตช์ปิดการสมัครฝั่ง server (P1-ST2-T03) — `SIGNUP_ENABLED` ปิด = ทุก route `/v1/public/signup*` ตอบ 404
 * (เหมือนไม่มี endpoint) ก่อนถึงตัวจำกัด/ด่านกันบอท/ฐานข้อมูล · อ่าน env ทุกคำขอ (test สลับได้)
 */
@Injectable()
export class SignupEnabledMiddleware implements NestMiddleware {
  private readonly filter = new ProblemFilter();
  use(req: Request, res: Response, next: NextFunction) {
    if (signupEnabled()) return next();
    // middleware อยู่นอก exception filter ของ Nest — ส่ง problem+json รูปเดียวกับ ProblemFilter เอง
    this.filter.catch(new ProblemException('not_found'), {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
    } as never);
  }
}
