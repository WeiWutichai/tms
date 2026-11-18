import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { PrismaService } from '../../db/prisma.service';
import { DEPRECATED_ROUTE, VERSION_GATES } from './api-version.decorators';
import {
  deprecationHeaders,
  effectiveRelease,
  FIRST_API_VERSION,
  pendingChanges,
  resolveApiVersion,
  type DeprecationInfo,
  type VersionError,
} from './versions';

const DETAIL: Record<VersionError, string> = {
  format: 'X-Api-Version ต้องเป็นวันที่ YYYY-MM-DD ที่มีจริง',
  before_first: `X-Api-Version ต้องไม่ก่อน ${FIRST_API_VERSION} (เวอร์ชันแรกของ API)`,
  future: 'X-Api-Version ต้องไม่เป็นวันในอนาคต',
};

/** วันสร้างบริษัทไม่เปลี่ยน — cache ในหน่วยความจำ (จำกัดขนาดกันโตไม่หยุด) */
const CACHE_MAX = 10_000;

/**
 * ST7-T07 Versioning (docs/04 G1) — ทำงานหลัง guard (รู้ tenant/key แล้ว) และอยู่นอกสุดของ interceptor
 * (response ที่ replay จาก Idempotency-Key ถูกแปลงตามเวอร์ชันของ "ผู้เรียกปัจจุบัน")
 * 1. เลือกวันที่ pin: header → key → วันสร้างบริษัท → ล่าสุด · header ผิด → 400 `invalid_api_version`
 * 2. ตอบ header `X-Api-Version: <วันที่ pin>` ทุกคำขอที่ผ่าน guard
 * 3. route/เวอร์ชันที่ประกาศเลิกใช้ → `Deprecation`/`Sunset`/`Link`
 * 4. route ที่ติด @VersionGate และคำขอ pin ก่อนวันของการเปลี่ยน → แปลง request (ก่อน validation) + response (ย้อนรูปแบบ)
 */
@Injectable()
export class ApiVersionInterceptor implements NestInterceptor {
  private readonly created = new Map<string, Date>();

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  private async tenantCreatedAt(tenantId: string): Promise<Date | null> {
    const hit = this.created.get(tenantId);
    if (hit) return hit;
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { createdAt: true, liveTenant: { select: { createdAt: true } } },
    });
    if (!t) return null;
    // ST7-T09: sandbox ได้พฤติกรรมตามวันสร้างบริษัทจริง (key test ทดสอบแบบเดียวกับ live)
    const at = t.liveTenant?.createdAt ?? t.createdAt;
    if (this.created.size >= CACHE_MAX) this.created.clear();
    this.created.set(tenantId, at);
    return at;
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const ctx = requestContext.get();
    const header = req.header('x-api-version');
    const r = resolveApiVersion({
      header: header ?? null,
      keyPin: ctx?.apiVersionPin ?? null,
      // อ่านวันสร้างบริษัทเฉพาะเมื่อไม่มี header/pin ของ key (UI ส่ง header เสมอ → ไม่ต้องถามฐาน)
      tenantCreatedAt:
        header === undefined && !ctx?.apiVersionPin && ctx?.tenantId
          ? await this.tenantCreatedAt(ctx.tenantId)
          : null,
    });
    if (!r.ok)
      throw new ProblemException('invalid_api_version', DETAIL[r.reason], undefined, {
        reason: r.reason,
      });
    const pinned = r.version;
    if (ctx) ctx.apiVersion = pinned;
    res.setHeader('X-Api-Version', pinned);

    const targets = [context.getHandler(), context.getClass()];
    const route = this.reflector.getAllAndOverride<DeprecationInfo>(DEPRECATED_ROUTE, targets);
    const release = effectiveRelease(pinned);
    const dep: DeprecationInfo | undefined =
      route ??
      (release.deprecatedAt
        ? { deprecatedAt: release.deprecatedAt, sunset: release.sunset, link: '/v1/openapi.json' }
        : undefined);
    if (dep) for (const [k, v] of Object.entries(deprecationHeaders(dep))) res.setHeader(k, v);

    const gates = this.reflector.getAllAndOverride<string[]>(VERSION_GATES, targets) ?? [];
    const changes = pendingChanges(gates, pinned);
    if (!changes.length) return next.handle();
    // request: เก่า → ใหม่ (ย้อนลำดับของ downgrade) · Express 5 คำนวณ req.query ใหม่ทุกครั้ง → ตั้งค่าคงที่ทับบนตัว req
    const upgrades = [...changes].reverse().filter((c) => c.upgradeRequest);
    if (upgrades.length) {
      const query = { ...(req.query as Record<string, unknown>) };
      for (const c of upgrades) c.upgradeRequest!({ query });
      Object.defineProperty(req, 'query', { value: query, configurable: true, writable: true });
    }
    return next
      .handle()
      .pipe(
        map((body: unknown) =>
          changes.reduce(
            (b, c) => (c.downgradeResponse ? c.downgradeResponse(b) : b),
            body as unknown,
          ),
        ),
      );
  }
}
