import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RATE_LIMIT_CLASS } from '../../common/decorators';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import type { RouteClass } from './profiles';
import { gcra, RateLimitService, setRateHeaders, type Bucket } from './rate-limit.service';

/**
 * rate limit ของ `/v1` ทุก route ที่ยืนยันตัวตนแล้ว (ST7-T08; docs/04 G1) — ทำงานหลัง AuthGuard (รู้ tenant/principal แล้ว)
 * UI ใช้ `/v1` ชุดเดียวกับลูกค้า จึงโดนเพดานเดียวกัน (API-first) · bucket ที่ตัดในคำขอเดียว (all-or-nothing):
 * - `t:<tenant>` ทุกคำขอของบริษัท (scope `tenant`)
 * - `k:<api key>` เมื่อเรียกด้วย API key / OAuth client (scope `key`) หรือ `u:<tenant>:<user>` เมื่อเป็นผู้ใช้ (scope `user`)
 * - `h:<tenant>` เพิ่มเมื่อ route ติด `@RateLimitClass('heavy')` (scope `endpoint`)
 * ไม่ครอบ: route สาธารณะ/ลิงก์ (จำกัดต่อ IP + ต่อลิงก์แยก), Platform Console
 * ผ่าน → header `RateLimit-Limit/-Remaining/-Reset` · เกิน → 429 problem+json `rate_limited` + `Retry-After` + `scope`
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.limiter.enabled || context.getType() !== 'http') return true;
    const ctx = requestContext.get();
    const tid = ctx?.tenantId;
    if (!ctx || !tid || ctx.principalType === 'link' || ctx.platformUser) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const cls: RouteClass =
      this.reflector.getAllAndOverride<'heavy'>(RATE_LIMIT_CLASS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? (req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write');
    const p = await this.limiter.profile(tid);
    const actor = ctx.actorId ?? '-';
    const buckets: Bucket[] = [gcra(`t:${tid}`, p.tenant, 'tenant')];
    if (ctx.principalType === 'client' && actor.startsWith('apikey:'))
      buckets.push(gcra(`k:${actor.slice('apikey:'.length)}`, p.key, 'key'));
    else buckets.push(gcra(`u:${tid}:${actor}`, p.user, 'user'));
    if (cls === 'heavy') buckets.push(gcra(`h:${tid}`, p.heavy, 'endpoint'));
    const d = await this.limiter.take(buckets, { failOpen: true });
    if (!d) return true;
    setRateHeaders(res, d);
    if (!d.allowed)
      throw new ProblemException('rate_limited', undefined, undefined, {
        retryAfter: d.retryAfterS,
        scope: d.scope,
      });
    return true;
  }
}
