import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { Clock } from '../common/clock';
import { PlatformAuth } from '../common/decorators';
import { decodeIdOr404, encodeId } from '../common/ids';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { safeName } from '../common/safe-text';
import { PrismaService } from '../db/prisma.service';
import { DEFAULT_PROFILE, profileOf, RATE_LIMIT_PROFILES } from '../http/rate-limit/profiles';
import { EmailService } from '../modules/email/email.service';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { tenantStatusOut, TENANT_STATUS_ENUM_DOC } from '../modules/tenants/tenant-status';
import { p95FromHist, sumHist } from '../modules/usage/api-traffic-meter';
import { bangkokDate } from '../modules/usage/usage-metrics';
import { TenantReasonDto } from './platform-tenants.controller';

/** ช่วงของตาราง (spec/01 §10.7 "calls 30 วัน") — รวมวันนี้ (เวลาไทย) */
export const API_USAGE_DAYS = 30;

export class ApiUsageRateLimitDto {
  @ApiProperty({
    example: 'standard',
    description: 'โปรไฟล์ที่ใช้ (tenant ทับแพ็กเกจ) — standard | high',
  })
  profile!: string;
  @ApiProperty({
    description: 'ปรับเฉพาะบริษัทนี้ (tenant.rate_limit_profile) — false = ตามแพ็กเกจ',
  })
  override!: boolean;
  @ApiProperty({
    example: 3000,
    description: 'เพดานรวมของบริษัท (req/นาที) = rate ของชั้น tenant × 60',
  })
  tenantPerMinute!: number;
  @ApiProperty({ example: 1200, description: 'เพดานต่อ API key / OAuth client (req/นาที)' })
  keyPerMinute!: number;
}

export class ApiUsageRowDto {
  @ApiProperty({ example: 'ten_…' }) tenantId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ example: 'std' }) planCode!: string;
  @ApiProperty({ example: 'มาตรฐาน' }) planName!: string;
  @ApiProperty({ enum: TENANT_STATUS_ENUM_DOC }) status!: string;
  @ApiProperty({ description: 'แพ็กเกจ/override เปิดฟีเจอร์ Open API (`api`)' })
  apiInPlan!: boolean;
  @ApiProperty({
    description:
      'ทีมผู้ให้บริการปิด Open API อยู่ (PLT-115) — key ได้ 403 `api_disabled_by_platform`',
  })
  apiDisabled!: boolean;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  apiDisabledAt!: string | null;
  @ApiProperty({
    description: `คำขอ REST ของ API key / OAuth client ${API_USAGE_DAYS} วัน (ทุกสถานะ รวม 429)`,
  })
  requests!: number;
  @ApiProperty({ description: '4xx ที่ไม่ใช่ 429' }) errors4xx!: number;
  @ApiProperty() errors5xx!: number;
  @ApiProperty({ description: '429 ที่ rate limit ตัด' }) throttled!: number;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'p95 เวลาตอบ (ms) = ขอบบนของช่อง histogram (ค่าจริง ≤ ค่านี้) · null = ไม่มีคำขอ · ไม่รวม 429',
  })
  p95Ms!: number | null;
  @ApiProperty({ description: 'p95 เกินขอบสุดท้ายของ histogram (แสดงเป็น "> p95Ms")' })
  p95Over!: boolean;
  @ApiProperty({ type: ApiUsageRateLimitDto }) rateLimit!: ApiUsageRateLimitDto;
}

export class ApiUsageDto {
  @ApiProperty({ example: '2026-10-30', description: 'วันแรกของช่วง (เวลาไทย)' }) from!: string;
  @ApiProperty({ example: '2026-11-28', description: 'วันสุดท้าย (วันนี้)' }) to!: string;
  @ApiProperty({ example: API_USAGE_DAYS }) days!: number;
  @ApiProperty({ description: 'คำขอรวมทุกบริษัทในตาราง' }) totalRequests!: number;
  @ApiProperty({ type: [ApiUsageRowDto] }) rows!: ApiUsageRowDto[];
}

export class ApiAccessDto {
  @ApiProperty({ example: 'ten_…' }) tenantId!: string;
  @ApiProperty() apiDisabled!: boolean;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  apiDisabledAt!: string | null;
}

/** ไม่แสดงในตาราง (ต้นแบบ Console `use` กรอง 'ยกเลิก', 'รอยืนยัน') */
const HIDDEN = ['CANCELLED', 'PENDING_VERIFICATION'] as const;

/**
 * Console "การใช้งาน API" (P1-ST4-T05; spec/01 §10.7 PLT-115 · ต้นแบบ Platform Console `use`)
 * - ดู: ทุก role ของ Console · ปิด/เปิด API: owner (SUPER_ADMIN) + support (SUPPORT) (§11.4 "ปิด API/AI")
 * - ปิด = `tenant.api_disabled_at` — ApiKeyAuthService ตรวจทุกคำขอ (มีผลทันที) → 403 `api_disabled_by_platform` · key ไม่ถูกลบ
 * - เหตุผล ≥ 10 ตัว → audit_log ของบริษัท (actor `platform:<id>`) + อีเมลแจ้ง owner (PLT-103)
 * - ส่วน AI / MCP ไม่แสดง (D-48 — หลังเฟสขาย 1) · ปรับ rate limit (PLT-116) ยังไม่ทำ — แสดงค่าปัจจุบันอย่างเดียว
 */
@ApiTags('platform-console')
@ApiBearerAuth()
@Controller('platform')
export class PlatformApiUsageController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly email: EmailService,
    private readonly clock: Clock,
  ) {}

  @Get('api-usage')
  @PlatformAuth()
  @ApiOperation({
    summary: `การใช้งาน Open API ทุกบริษัท ${API_USAGE_DAYS} วันล่าสุด — คำขอ, error rate, p95, 429, rate limit, สถานะปิด API`,
  })
  @ApiOkResponse({ type: ApiUsageDto })
  async list(): Promise<ApiUsageDto> {
    const db = this.prisma.platform;
    const to = bangkokDate(this.clock.now());
    const fromD = new Date(`${to}T00:00:00Z`);
    fromD.setUTCDate(fromD.getUTCDate() - (API_USAGE_DAYS - 1));
    const from = fromD.toISOString().slice(0, 10);
    const tenants = await db.tenant.findMany({
      where: { mode: 'live', status: { notIn: [...HIDDEN] } },
      include: { plan: { select: { nameTh: true, rateLimitProfile: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // แถว ≤ บริษัท × 30 วัน — รวมใน JS (histogram ความยาวต่างกันได้ถ้าเพิ่มช่องในอนาคต)
    const days = await db.apiTrafficDaily.findMany({
      where: { date: { gte: new Date(from), lte: new Date(to) } },
    });
    const byT = new Map<string, { r: number; e4: number; e5: number; th: number; h: number[][] }>();
    for (const d of days) {
      let a = byT.get(d.tenantId);
      if (!a) byT.set(d.tenantId, (a = { r: 0, e4: 0, e5: 0, th: 0, h: [] }));
      a.r += d.requests;
      a.e4 += d.errors4xx;
      a.e5 += d.errors5xx;
      a.th += d.throttled;
      a.h.push(d.latencyHist);
    }
    const rows: ApiUsageRowDto[] = [];
    for (const t of tenants) {
      const x = byT.get(t.id);
      const p95 = x ? p95FromHist(sumHist(x.h)) : null;
      const name = t.rateLimitProfile ?? t.plan.rateLimitProfile;
      const known = name in RATE_LIMIT_PROFILES ? name : DEFAULT_PROFILE;
      const prof = profileOf(known);
      rows.push({
        tenantId: encodeId('tenant', t.id),
        name: t.name,
        planCode: t.planCode,
        planName: t.plan.nameTh,
        status: tenantStatusOut(t.status),
        apiInPlan: await this.entitlements.enabled(t.id, 'api'),
        apiDisabled: !!t.apiDisabledAt,
        apiDisabledAt: t.apiDisabledAt?.toISOString() ?? null,
        requests: x?.r ?? 0,
        errors4xx: x?.e4 ?? 0,
        errors5xx: x?.e5 ?? 0,
        throttled: x?.th ?? 0,
        p95Ms: p95?.ms ?? null,
        p95Over: p95?.over ?? false,
        rateLimit: {
          profile: known,
          override: t.rateLimitProfile != null,
          tenantPerMinute: prof.tenant.rate * 60,
          keyPerMinute: prof.key.rate * 60,
        },
      });
    }
    return {
      from,
      to,
      days: API_USAGE_DAYS,
      totalRequests: rows.reduce((a, r) => a + r.requests, 0),
      rows,
    };
  }

  @Post('tenants/:id/api/disable')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  @ApiOperation({
    summary:
      'ปิด Open API ของบริษัทชั่วคราว (PLT-115) — API key / OAuth client ทุกตัว (รวม sandbox) ได้ 403 `api_disabled_by_platform` ทันที · key ไม่ถูกลบ · ปิดอยู่แล้ว = 409',
  })
  @ApiOkResponse({ type: ApiAccessDto })
  disable(@Param('id') id: string, @Body() body: TenantReasonDto): Promise<ApiAccessDto> {
    return this.setAccess(id, true, body.reason);
  }

  @Post('tenants/:id/api/enable')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  @ApiOperation({
    summary: 'เปิด Open API ของบริษัทอีกครั้ง — key เดิมใช้ได้ทันที · ไม่ได้ปิดอยู่ = 409',
  })
  @ApiOkResponse({ type: ApiAccessDto })
  enable(@Param('id') id: string, @Body() body: TenantReasonDto): Promise<ApiAccessDto> {
    return this.setAccess(id, false, body.reason);
  }

  private async setAccess(id: string, disable: boolean, reason: string): Promise<ApiAccessDto> {
    const db = this.prisma.platform;
    const t = await db.tenant.findUnique({ where: { id: decodeIdOr404('tenant', id) } });
    if (!t || t.mode !== 'live') throw new ProblemException('not_found');
    const ctx = requestContext.require();
    const staff = ctx.platformUser!.id;
    const now = this.clock.now();
    const next = await db.$transaction(async (tx) => {
      // เงื่อนไขในคำสั่งเดียว — กดซ้ำ/สองคนพร้อมกัน ได้ 409 คนเดียว
      const n = await tx.tenant.updateMany({
        where: { id: t.id, apiDisabledAt: disable ? null : { not: null } },
        data: disable
          ? { apiDisabledAt: now, apiDisabledBy: staff }
          : { apiDisabledAt: null, apiDisabledBy: null },
      });
      if (!n.count) throw new ProblemException('invalid_state_transition');
      await this.audit(tx, t.id, disable, reason, t.apiDisabledAt);
      const owners = await this.owners(tx, t.id);
      const at = new Intl.DateTimeFormat('th-TH', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Bangkok',
      }).format(now);
      await this.email.enqueueMany(
        tx,
        owners.map((o) => ({
          tenantId: t.id,
          to: o.email,
          template: 'api_access_changed' as const,
          locale: o.locale,
          vars: {
            tenantName: safeName(t.name),
            disabled: disable,
            reason: safeName(reason, 500),
            at,
          },
        })),
      );
      return tx.tenant.findUniqueOrThrow({ where: { id: t.id } });
    });
    return {
      tenantId: encodeId('tenant', next.id),
      apiDisabled: !!next.apiDisabledAt,
      apiDisabledAt: next.apiDisabledAt?.toISOString() ?? null,
    };
  }

  /** audit ลง audit_log ของบริษัท (ลูกค้าเห็นได้ — spec/01 §11.5) — หน้า Audit log ของ Console รวมแหล่งนี้ */
  private audit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    disabled: boolean,
    reason: string,
    before: Date | null,
  ) {
    const ctx = requestContext.require();
    return tx.auditLog.create({
      data: {
        tenantId,
        actorId: `platform:${ctx.platformUser!.id}`,
        action: disabled ? 'platform.api_disabled' : 'platform.api_enabled',
        entityType: 'tenant',
        entityId: tenantId,
        before: { apiDisabled: !!before } as Prisma.InputJsonValue,
        after: { apiDisabled: disabled } as Prisma.InputJsonValue,
        reason,
        requestId: ctx.requestId,
        ip: ctx.ip ?? null,
      },
    });
  }

  private async owners(tx: Prisma.TransactionClient, tenantId: string) {
    const role = await tx.role.findFirst({ where: { tenantId, code: 'owner' } });
    if (!role) return [];
    const links = await tx.userRole.findMany({ where: { tenantId, roleId: role.id } });
    return tx.appUser.findMany({
      where: { tenantId, id: { in: links.map((l) => l.userId) }, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
  }
}
