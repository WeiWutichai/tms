import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import { IS_PUBLIC, REQUIRED_SCOPE } from '../common/decorators';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';

/**
 * ⚠️ ชั่วคราวสำหรับ ST0: ตรวจ JWT HS256 ที่เซ็นด้วย AUTH_DEV_SECRET
 * ST1 (login/OIDC/API key/OAuth2 CC — plan/02 T-04) จะแทนที่ไฟล์นี้ แต่ claim ที่ใช้คงเดิม:
 * `sub` = ผู้ใช้/คีย์, `tid` = tenant uuid, `scope` = "resource:verb ..." (docs/01 §5.1)
 */
function secret(): Uint8Array {
  const s = process.env.AUTH_DEV_SECRET;
  if (!s || s.length < 32) throw new Error('AUTH_DEV_SECRET (>= 32 chars) required');
  return new TextEncoder().encode(s);
}

export async function signDevToken(
  claims: { sub: string; tid: string; scope?: string },
  ttl = '1h',
) {
  return new SignJWT({ tid: claims.tid, scope: claims.scope ?? '*' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret());
}

function scopeAllows(granted: string[], required: string): boolean {
  if (granted.includes('*') || granted.includes(required)) return true;
  const [resource] = required.split(':');
  return granted.includes(`${resource}:*`);
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new ProblemException('unauthorized');

    let payload: { sub?: string; tid?: unknown; scope?: unknown };
    try {
      ({ payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] }));
    } catch {
      throw new ProblemException('unauthorized');
    }
    if (typeof payload.tid !== 'string' || !payload.sub) throw new ProblemException('unauthorized');

    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
    const required = this.reflector.getAllAndOverride<string>(REQUIRED_SCOPE, targets);
    if (required && !scopeAllows(scopes, required)) throw new ProblemException('forbidden');

    const ctx = requestContext.require();
    ctx.tenantId = payload.tid;
    ctx.actorId = payload.sub;
    ctx.scopes = scopes;
    return true;
  }
}
