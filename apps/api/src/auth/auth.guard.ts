import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { scopeAllows } from '@tms/domain';
import type { Request } from 'express';
import { IS_PUBLIC, REQUIRE_STEP_UP, REQUIRED_FEATURE, REQUIRED_SCOPE } from '../common/decorators';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { AuthService } from './auth.service';
import { signAccessToken, verifyAccessToken, verifyStepUpToken } from './tokens';

/**
 * token สำหรับพัฒนา/test (`pt=dev`) — production ปฏิเสธ (ดู tokens.ts)
 * ผู้ใช้จริงได้ token จาก /auth/login → /oauth/token (pt=user)
 */
export async function signDevToken(
  claims: { sub: string; tid: string; scope?: string },
  ttl = '1h',
) {
  return signAccessToken(
    { sub: claims.sub, tid: claims.tid, scope: claims.scope ?? '*', pt: 'dev' },
    ttl,
  );
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly entitlements: EntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new ProblemException('unauthorized');

    const claims = await verifyAccessToken(token);
    if (!claims) throw new ProblemException('unauthorized');
    // A1 token version: ระงับผู้ใช้/เปลี่ยน role → bump → token เดิมใช้ไม่ได้ทันที
    if (claims.pt === 'user') {
      const tv = await this.auth.currentTokenVersion(claims.tid, claims.sub);
      if (tv === null || tv !== claims.tv) throw new ProblemException('unauthorized');
    }
    // spec/01 PLT-001 ลำดับ: สถานะ tenant (ตรวจกับ tokenVersion แล้ว) → entitlement → สิทธิ์ role
    const feature = this.reflector.getAllAndOverride<string>(REQUIRED_FEATURE, targets);
    if (feature && !(await this.entitlements.enabled(claims.tid, feature)))
      throw new ProblemException('feature_not_enabled', undefined, undefined, { feature });
    const scopes = claims.scope ? claims.scope.split(' ') : [];
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPE, targets);
    // spec/01 PLT-132: 403 permission_denied พร้อม module/action ของสิทธิ์ที่ขาด
    if (required && !required.some((r) => scopeAllows(scopes, r))) {
      const [module, action] = required[0]!.split(':');
      throw new ProblemException('permission_denied', undefined, undefined, {
        module,
        action,
        required,
      });
    }

    if (this.reflector.getAllAndOverride<boolean>(REQUIRE_STEP_UP, targets)) {
      const su = await verifyStepUpToken(req.header('x-step-up') ?? '');
      if (!su || su.sub !== claims.sub || su.tid !== claims.tid)
        throw new ProblemException('step_up_required');
    }
    const ctx = requestContext.require();
    ctx.tenantId = claims.tid;
    ctx.actorId = claims.sub;
    ctx.scopes = scopes;
    ctx.principalType = claims.pt;
    return true;
  }
}
