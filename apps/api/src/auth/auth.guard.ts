import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { requiresTwoFactor, scopeAllows } from '@tms/domain';
import type { Request } from 'express';
import {
  ALLOW_BEFORE_2FA,
  ALLOW_READ_ONLY_TENANT,
  IS_PUBLIC,
  LINK_ACTION,
  PLATFORM_ROLES,
  REQUIRE_STEP_UP,
  REQUIRED_FEATURE,
  REQUIRED_SCOPE,
  SANDBOX_AWARE,
  LIVE_ONLY,
} from '../common/decorators';
import { MagicLinkService } from '../modules/links/magic-link.service';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { AuthService } from './auth.service';
import { PrismaService } from '../db/prisma.service';
import { END_IMPERSONATION_PATH } from '../platform/impersonation.controller';
import { ApiKeyAuthService, type KeyPrincipal } from '../modules/api-keys/api-key-auth.service';
import { looksLikeApiKey } from '../modules/api-keys/key-material';
import { MODE_HEADER, SandboxService } from '../modules/sandbox/sandbox.service';
import { isRs256, verifyClientToken } from './signing-keys';
import { canWrite, tenantStatusOut } from '../modules/tenants/tenant-status';
import {
  signAccessToken,
  verifyAccessToken,
  verifyPlatformStepUpToken,
  verifyPlatformToken,
  verifyStepUpToken,
  type AccessClaims,
} from './tokens';

/**
 * P1-ST1-T03 (spec/01 ตาราง 1.6 + "API ที่ยกเว้นจาก guard สถานะเสมอ: /auth/*, /billing/*, /payments/*, /exports/*, /me"):
 * ยกเว้นจาก guard สถานะ tenant ทั้งกลุ่ม + หน้าแพ็กเกจ (`/plan*`, `/subscription*` — ฝั่งลูกค้า P1-ST4) ที่ suspended/cancelled ยังเข้าได้
 * `/v1/payments` ตาม spec ตรงตัว (review S3 — เดิมไม่ยกเว้นเพราะในระบบนี้คือรับชำระจากลูกค้าของ tenant: [OPEN — PO] ความหมาย `/payments/*`)
 */
const TENANT_STATUS_EXEMPT =
  /^\/v1\/(auth|oauth|me|exports|billing|payments|plans?|subscriptions?)(\/|$)/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** principal ของ API key / client credentials (ST7-T01) — actor = `apikey:<uuid>` ใน audit */
const keyClaims = (p: KeyPrincipal): AccessClaims => ({
  sub: `apikey:${p.keyId}`,
  tid: p.tenantId,
  scope: p.scopes.join(' '),
  pt: 'client',
});

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
    private readonly apiKeys: ApiKeyAuthService,
    private readonly sandbox: SandboxService,
  ) {}

  /**
   * ST7-T09: tenant ของคำขอ — ปกติ = tenant ของ token/key (key `tk_test_` อยู่ในแถวของ sandbox อยู่แล้ว)
   * ผู้ใช้ (UI) บน route @SandboxAware + `X-Tms-Mode: test` → sandbox ของบริษัท (สร้างเมื่อยังไม่มี · เข้าใช้งานแทน = ไม่สร้าง)
   */
  private async requestTenant(
    claims: AccessClaims,
    req: Request,
    targets: Parameters<Reflector['getAllAndOverride']>[1],
  ): Promise<string> {
    if (!this.reflector.getAllAndOverride<boolean>(SANDBOX_AWARE, targets)) return claims.tid;
    const want = req.header(MODE_HEADER);
    if (want === undefined || want === '' || want === 'live') return claims.tid;
    if (want !== 'test')
      throw new ProblemException('bad_request', 'X-Tms-Mode must be "live" or "test"');
    // API key / client credentials: โหมดตาม key เสมอ (header ไม่มีผล)
    if (claims.pt !== 'user' && claims.pt !== 'dev' && claims.pt !== 'imp') return claims.tid;
    const own = await this.sandbox.link(claims.tid);
    if (!own) throw new ProblemException('unauthorized');
    if (own.mode === 'test') return claims.tid;
    if (claims.pt === 'imp') {
      const sb = await this.sandbox.find(claims.tid);
      if (!sb) throw new ProblemException('not_found');
      return sb;
    }
    return this.sandbox.ensure(claims.tid);
  }

  /** Bearer: API key `tk_…` → JWT RS256 ของ client credentials → JWT ของ UI (HS256) */
  private async claimsOf(token: string, req: Request): Promise<AccessClaims | null> {
    // ST7-T07: เวอร์ชันที่ pin บน key → ApiVersionInterceptor (header ในคำขอมาก่อน)
    const pinned = (p: KeyPrincipal) => {
      requestContext.require().apiVersionPin = p.apiVersion;
      return keyClaims(p);
    };
    if (looksLikeApiKey(token)) return pinned(await this.apiKeys.authenticateSecret(token, req.ip));
    if (isRs256(token)) {
      const c = await verifyClientToken(token);
      if (!c) return null;
      return pinned(await this.apiKeys.authenticateClient(c, req.ip));
    }
    return verifyAccessToken(token);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    // ลิงก์ตรวจก่อน @Public เสมอ — ติดทั้งคู่ต้องไม่ทำให้ข้ามการตรวจลิงก์ (review T06)
    const linkAction = this.reflector.getAllAndOverride<string>(LINK_ACTION, targets);
    if (linkAction) {
      const req = context.switchToHttp().getRequest<Request>();
      const token = String((req.params as Record<string, string>)?.token ?? '');
      const link = await this.links.resolve(token, linkAction);
      if (!link) throw new ProblemException('not_found');
      await this.assertTenantAllowed(req, targets, link.tenantId, 'link');
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

    const claims = await this.claimsOf(token, req);
    if (!claims) throw new ProblemException('unauthorized');
    // เข้าใช้งานแทน (ST1-T24): session ต้องยังไม่จบ/ไม่หมดเวลา · อ่านอย่างเดียว (spec/01 §11 เฟส 0)
    if (claims.pt === 'imp') {
      const s = await this.prisma.platform.impersonationSession.findUnique({
        where: { id: claims.sid! },
        include: { platformUser: { select: { status: true } } },
      });
      // หมดเวลาแล้วแต่ยังไม่ปิด → บันทึกว่าจบเพราะ timeout (ครั้งเดียว)
      if (s && !s.endedAt && s.expiresAt <= new Date())
        await this.prisma.platform.impersonationSession
          .updateMany({
            where: { id: s.id, endedAt: null },
            data: { endedAt: s.expiresAt, endReason: 'timeout' },
          })
          .catch(() => undefined);
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
              ip: requestContext.get()?.ip ?? null,
            },
          })
          .catch(() => undefined);
        throw new ProblemException('impersonation_read_only');
      }
    }
    // A1 token version: ระงับผู้ใช้/เปลี่ยน role → bump → token เดิมใช้ไม่ได้ทันที
    if (claims.pt === 'user') {
      const s = await this.auth.currentSession(claims.tid, claims.sub);
      if (s === null || s.tokenVersion !== claims.tv) throw new ProblemException('unauthorized');
      // D-78 (PO 23 พ.ย. 2569): ถือสิทธิ์สำคัญแต่ยังไม่ตั้ง 2FA (token ออกก่อนบังคับ / ต่ออายุด้วย refresh) → ทำได้แค่ดูสถานะ 2FA
      // login ใหม่ = ขั้นตั้ง 2FA (mfa_enrollment_required) · token dev / API key / เข้าใช้งานแทน ไม่เกี่ยว
      if (
        !s.twoFactor &&
        requiresTwoFactor(claims.scope ? claims.scope.split(' ') : []) &&
        !this.reflector.getAllAndOverride<boolean>(ALLOW_BEFORE_2FA, targets)
      )
        throw new ProblemException('two_factor_enrolment_required');
    }
    // spec/01 PLT-001 ลำดับ: สถานะ tenant (ตรวจกับ tokenVersion แล้ว) → entitlement → สิทธิ์ role
    // P1-ST1-T03: read_only เขียนไม่ได้ · suspended/cancelled ใช้ได้เฉพาะเส้นทางที่ยกเว้น — tenant ของ token (sandbox ใช้สถานะบริษัทจริง)
    await this.assertTenantAllowed(req, targets, claims.tid, claims.pt);
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

    // step-up 2FA: token ต้องเป็นของผู้เรียกเอง (sub + tid ตรง) · D-67 เก็บผลไว้ให้ step-up แบบมีเงื่อนไขใน service ใช้
    const suHeader = req.header('x-step-up');
    const su = suHeader ? await verifyStepUpToken(suHeader) : null;
    const steppedUp = !!su && su.sub === claims.sub && su.tid === claims.tid;
    const stepUpRule = this.reflector.getAllAndOverride<boolean | 'human'>(
      REQUIRE_STEP_UP,
      targets,
    );
    // 'human' (D-67) = API key / OAuth client ข้ามได้ (คุมด้วย scope) — true = ทุก principal ต้อง step-up
    if (stepUpRule && !steppedUp && !(stepUpRule === 'human' && claims.pt === 'client'))
      throw new ProblemException('step_up_required');
    const ctx = requestContext.require();
    ctx.steppedUp = steppedUp;
    ctx.actorId = claims.sub; // ก่อนสร้าง sandbox — audit `sandbox.created` ต้องรู้ผู้เปิด
    const tenantId = await this.requestTenant(claims, req, targets);
    ctx.tenantId = tenantId;
    const link = await this.sandbox.link(tenantId);
    if (link?.mode === 'test')
      ctx.sandbox = {
        liveTenantId: link.liveTenantId,
        users: (w) => this.sandbox.liveUsers(link.liveTenantId, w),
      };
    if (link?.mode === 'test' && this.reflector.getAllAndOverride<boolean>(LIVE_ONLY, targets))
      throw new ProblemException('sandbox_unsupported');

    ctx.actorId = claims.sub;
    ctx.scopes = scopes;
    ctx.principalType = claims.pt;
    if (claims.pt === 'imp') {
      ctx.actAs = `platform:${claims.act}`;
      ctx.impersonationSessionId = claims.sid;
    }
    return true;
  }

  /**
   * P1-ST1-T03 guard สถานะ tenant (spec/01 ตาราง 1.6 · PLT-001 ลำดับแรก) — อ่านสถานะสดทุกคำขอ (ไม่มี cache)
   * - เขียนได้ (pending/trialing/active/past_due) หรือเส้นทางที่ยกเว้น → ผ่าน
   * - read_only: อ่านได้ · เขียน → 403 `tenant_read_only` (ยกเว้น `@AllowReadOnlyTenant()`)
   * - suspended/cancelled: login ได้แต่ใช้ได้เฉพาะเส้นทางที่ยกเว้น — อื่น ๆ ทุก method → 403 `tenant_suspended` / `tenant_cancelled`
   *   (เข้าใช้งานแทนยังอ่านได้ — spec/01 §11.8)
   */
  private async assertTenantAllowed(
    req: Request,
    targets: Parameters<Reflector['getAllAndOverride']>[1],
    tenantId: string,
    principal: string | undefined,
  ): Promise<void> {
    if (TENANT_STATUS_EXEMPT.test(req.path)) return;
    const safe = SAFE_METHODS.has(req.method.toUpperCase());
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, liveTenant: { select: { status: true } } },
    });
    const status = t?.liveTenant?.status ?? t?.status;
    if (!status || canWrite(status)) return;
    if (status === 'READ_ONLY') {
      if (safe || this.reflector.getAllAndOverride<boolean>(ALLOW_READ_ONLY_TENANT, targets))
        return;
      throw new ProblemException('tenant_read_only', undefined, undefined, {
        tenantStatus: 'read_only',
      });
    }
    if (safe && principal === 'imp') return;
    throw new ProblemException(
      status === 'CANCELLED' ? 'tenant_cancelled' : 'tenant_suspended',
      undefined,
      undefined,
      { tenantStatus: tenantStatusOut(status) },
    );
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
    // D-77: step-up ของ Console (header `X-Step-Up` จาก POST /v1/platform/auth/step-up) — ผูกคนเดียวกัน + tokenVersion ปัจจุบัน
    // route ตรวจเองใน handler ด้วย assertStepUp() (หลัง validation/404)
    const suHeader = req.header('x-step-up');
    const su = suHeader ? await verifyPlatformStepUpToken(suHeader) : null;
    const ctx = requestContext.require();
    ctx.steppedUp = !!su && su.sub === claims.sub && su.tv === u.tokenVersion;
    ctx.platformUser = { id: claims.sub, role: u.role };
    ctx.actorId = `platform:${claims.sub}`;
    ctx.principalType = 'platform';
    return true;
  }
}
