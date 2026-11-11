import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { scopeAllows } from '@tms/domain';
import type { Request } from 'express';
import {
  IS_PUBLIC,
  LINK_ACTION,
  PLATFORM_ROLES,
  REQUIRE_STEP_UP,
  REQUIRED_FEATURE,
  REQUIRED_SCOPE,
} from '../common/decorators';
import { MagicLinkService } from '../modules/links/magic-link.service';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { AuthService } from './auth.service';
import { PrismaService } from '../db/prisma.service';
import { END_IMPERSONATION_PATH } from '../platform/impersonation.controller';
import {
  signAccessToken,
  verifyAccessToken,
  verifyPlatformToken,
  verifyStepUpToken,
} from './tokens';

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
    private readonly links: MagicLinkService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    // ลิงก์ตรวจก่อน @Public เสมอ — ติดทั้งคู่ต้องไม่ทำให้ข้ามการตรวจลิงก์ (review T06)
    const linkAction = this.reflector.getAllAndOverride<string>(LINK_ACTION, targets);
    if (linkAction) {
      const req = context.switchToHttp().getRequest<Request>();
      const token = String((req.params as Record<string, string>)?.token ?? '');
      const link = await this.links.resolve(token, linkAction);
      if (!link) throw new ProblemException('not_found');
      const ctx = requestContext.require();
      ctx.tenantId = link.tenantId;
      ctx.actorId = `link:${link.id}`;
      ctx.scopes = link.scopes;
      ctx.principalType = 'link';
      ctx.link = link;
      // ฟีเจอร์ของแพ็กเกจใช้กับลิงก์ด้วย (เช่น ลิงก์รถร่วมเมื่อ tenant ไม่มีฟีเจอร์ sub)
      const linkFeature = this.reflector.getAllAndOverride<string>(REQUIRED_FEATURE, targets);
      if (linkFeature && !(await this.entitlements.enabled(link.tenantId, linkFeature)))
        throw new ProblemException('not_found');
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    // Platform Console (ST1-T24) — token ชนิดแยก รับเฉพาะ route ที่ประกาศ @PlatformAuth
    const platformRoles = this.reflector.getAllAndOverride<string[]>(PLATFORM_ROLES, targets);
    if (platformRoles) return this.platform(context, platformRoles);

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new ProblemException('unauthorized');

    const claims = await verifyAccessToken(token);
    if (!claims) throw new ProblemException('unauthorized');
    // เข้าใช้งานแทน (ST1-T24): session ต้องยังไม่จบ/ไม่หมดเวลา · อ่านอย่างเดียว (spec/01 §11 เฟส 0)
    if (claims.pt === 'imp') {
      const s = await this.prisma.platform.impersonationSession.findUnique({
        where: { id: claims.sid! },
        include: { platformUser: { select: { status: true } } },
      });
      if (
        !s ||
        s.endedAt ||
        s.expiresAt <= new Date() ||
        s.tenantId !== claims.tid ||
        s.asUserId !== claims.sub ||
        s.platformUser.status !== 'ACTIVE'
      )
        throw new ProblemException('unauthorized');
      // ผู้ใช้ที่สวมต้องยังใช้งานอยู่ และใช้สิทธิ์ปัจจุบันของเขา (ไม่ใช่ที่ฝังไว้ตอนเริ่ม) — tenant ถูกระงับยังอ่านได้ (spec/01 §11.8)
      const asUser = await this.prisma.platform.appUser.findFirst({
        where: { id: claims.sub, tenantId: claims.tid, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!asUser) throw new ProblemException('unauthorized');
      claims.scope = await this.auth.scopeOf(claims.tid, claims.sub);
      const method = req.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && req.path !== END_IMPERSONATION_PATH) {
        // บันทึกความพยายามแก้ข้อมูล (spec/01 §11.9) แล้วปฏิเสธ
        await this.prisma.platform.auditLog
          .create({
            data: {
              tenantId: claims.tid,
              actorId: claims.sub,
              actAs: `platform:${claims.act}`,
              action: 'impersonation.write_blocked',
              entityType: 'impersonation_session',
              entityId: s.id,
              after: { method, path: req.path },
              requestId: requestContext.get()?.requestId ?? null,
            },
          })
          .catch(() => undefined);
        throw new ProblemException('impersonation_read_only');
      }
    }
    // A1 token version: ระงับผู้ใช้/เปลี่ยน role → bump → token เดิมใช้ไม่ได้ทันที
    if (claims.pt === 'user') {
      const tv = await this.auth.currentTokenVersion(claims.tid, claims.sub);
      if (tv === null || tv !== claims.tv) throw new ProblemException('unauthorized');
    }
    // spec/01 PLT-001 ลำดับ: สถานะ tenant (ตรวจกับ tokenVersion แล้ว) → entitlement → สิทธิ์ role
    const feature = this.reflector.getAllAndOverride<string>(REQUIRED_FEATURE, targets);
    if (feature && !(await this.entitlements.enabled(claims.tid, feature)))
      throw new ProblemException('feature_not_in_plan', undefined, undefined, {
        featureKey: feature,
      }); // spec/01 PLT-078
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
    if (claims.pt === 'imp') {
      ctx.actAs = `platform:${claims.act}`;
      ctx.impersonationSessionId = claims.sid;
    }
    return true;
  }

  /** ทีม Innovera: token Console + บัญชียังใช้งาน (tokenVersion ตรง) + role อยู่ในรายการ */
  private async platform(context: ExecutionContext, roles: string[]): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const claims = token ? await verifyPlatformToken(token) : null;
    if (!claims) throw new ProblemException('unauthorized');
    const u = await this.prisma.platform.platformUser.findUnique({
      where: { id: claims.sub },
      select: { status: true, tokenVersion: true, role: true },
    });
    if (!u || u.status !== 'ACTIVE' || u.tokenVersion !== claims.tv)
      throw new ProblemException('unauthorized');
    if (roles.length && !roles.includes(u.role))
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'platform',
        action: 'role',
        required: roles,
      });
    const ctx = requestContext.require();
    ctx.platformUser = { id: claims.sub, role: u.role };
    ctx.actorId = `platform:${claims.sub}`;
    ctx.principalType = 'platform';
    return true;
  }
}
