import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { Prisma, Tenant } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { AuthService } from '../auth/auth.service';
import { webBaseUrl } from '../auth/password-reset.controller';
import { ensureSystemRoles } from '../auth/system-roles';
import { signAccessToken } from '../auth/tokens';
import { PlatformAuth } from '../common/decorators';
import { decodeIdOr404, encodeId, tryDecodeId } from '../common/ids';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { safeName } from '../common/safe-text';
import { PrismaService } from '../db/prisma.service';
import { EmailService } from '../modules/email/email.service';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { bootstrapTenant } from '../modules/tenants/bootstrap';
import { issueInvitation } from '../modules/users/invitations.controller';

/** spec/01 §10 กติการ่วม: ทุกการเปลี่ยนข้อมูลลูกค้าต้องมีเหตุผล ≥ 10 ตัว + audit (PLT-004) */
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
class ReasonBody {
  @ApiProperty({ example: 'ลูกค้าขอระงับชั่วคราวระหว่างย้ายระบบ', minLength: 10 })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
/** เข้าใช้งานแทนได้นานสุด (spec/01 PLT-121 `impersonation.maxMinutes`) */
export const IMPERSONATION_MINUTES = 60;

export class CreatePlatformTenantDto extends ReasonBody {
  @ApiProperty({ example: 'บริษัท ตัวอย่างขนส่ง จำกัด' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;
  @ApiProperty({ example: 'owner@example.co.th' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  ownerEmail!: string;
  @ApiProperty({ example: 'สมชาย ใจดี' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  ownerName!: string;
  @ApiPropertyOptional({ example: 'std' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_]{1,20}$/)
  planCode?: string;
  @ApiPropertyOptional({ example: 30, nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  vehicleQuota?: number | null;
}
export class UpdatePlanDto extends ReasonBody {
  @ApiPropertyOptional({ example: 'ent' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_]{1,20}$/)
  planCode?: string;
  @ApiPropertyOptional({ example: 40, nullable: true, description: 'null = ล้างค่า' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  vehicleQuota?: number | null;
}
export class TenantReasonDto extends ReasonBody {}
export class ImpersonateDto extends ReasonBody {
  @ApiPropertyOptional({ example: 'usr_…', description: 'ผู้ใช้ที่จะสวม (ไม่ส่ง = owner คนแรก)' })
  @IsOptional()
  @IsString()
  asUserId?: string;
  @ApiPropertyOptional({ example: '#4412' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  ticketRef?: string;
}
export class PlatformTenantListQuery {
  @ApiPropertyOptional({ description: 'ค้นชื่อบริษัท' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class PlatformTenantDto {
  @ApiProperty({ example: 'ten_…' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['trial', 'active', 'suspended', 'cancelled'] }) status!: string;
  @ApiProperty() planCode!: string;
  @ApiProperty({ nullable: true, type: Number }) vehicleQuota!: number | null;
  @ApiProperty() users!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class PlatformTenantUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
}
export class PlatformTenantDetailDto extends PlatformTenantDto {
  @ApiProperty({ type: [PlatformTenantUserDto] }) members!: PlatformTenantUserDto[];
}
export class ImpersonationStartDto {
  @ApiProperty() sessionId!: string;
  @ApiProperty({
    description: 'access token ของผู้ใช้ที่สวม (อ่านอย่างเดียว) — ส่งให้แอปลูกค้าทาง URL fragment',
  })
  accessToken!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ description: 'ลิงก์เปิดแอปลูกค้าในแท็บใหม่' }) url!: string;
}

/**
 * ลูกค้า (tenant) ใน Platform Console (ST1-T24; docs/04 A6, spec/01 §10–11)
 * สิทธิ์ (docs/04 A6): SUPER_ADMIN ทำได้ทุกอย่าง · SUPPORT ดู + เข้าใช้งานแทน · BILLING ดู + แพ็กเกจ/โควตา
 * ทุกการเปลี่ยนแปลงลง audit_log ของ tenant นั้น (actor = `platform:<id>`) พร้อมเหตุผล
 */
@ApiTags('platform-console')
@ApiBearerAuth()
@Controller('platform/tenants')
export class PlatformTenantsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly auth: AuthService,
    private readonly entitlements: EntitlementService,
  ) {}

  @Get()
  @PlatformAuth()
  @ApiOkResponse({ type: [PlatformTenantDto] })
  async list(@Query() q: PlatformTenantListQuery): Promise<PlatformTenantDto[]> {
    const rows = await this.prisma.platform.tenant.findMany({
      where: q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {},
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 50,
    });
    const counts = await this.prisma.platform.appUser.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: rows.map((t) => t.id) }, status: { not: 'DELETED' } },
      _count: { _all: true },
    });
    const n = new Map(counts.map((c) => [c.tenantId, c._count._all]));
    return rows.map((t) => this.toDto(t, n.get(t.id) ?? 0));
  }

  @Get(':id')
  @PlatformAuth()
  @ApiOkResponse({ type: PlatformTenantDetailDto })
  async get(@Param('id') id: string): Promise<PlatformTenantDetailDto> {
    const t = await this.tenant(id);
    const users = await this.prisma.platform.appUser.findMany({
      where: { tenantId: t.id, status: { not: 'DELETED' } },
      orderBy: { createdAt: 'asc' },
    });
    const links = await this.prisma.platform.userRole.findMany({
      where: { tenantId: t.id },
      select: { userId: true, roleId: true },
    });
    const roles = await this.prisma.platform.role.findMany({
      where: { tenantId: t.id },
      select: { id: true, code: true },
    });
    const code = new Map(roles.map((r) => [r.id, r.code]));
    return {
      ...this.toDto(t, users.length),
      members: users.map((u) => ({
        id: encodeId('user', u.id),
        name: u.name,
        email: u.email,
        status: u.status.toLowerCase(),
        roles: links.filter((l) => l.userId === u.id).map((l) => code.get(l.roleId) ?? ''),
      })),
    };
  }

  /** สร้าง tenant (pilot) + ค่าเริ่มต้น + owner รับคำเชิญทางอีเมล */
  @Post()
  @PlatformAuth('SUPER_ADMIN')
  @ApiCreatedResponse({ type: PlatformTenantDto })
  async create(@Body() body: CreatePlatformTenantDto): Promise<PlatformTenantDto> {
    const db = this.prisma.platform;
    if (body.planCode && !(await db.plan.findUnique({ where: { code: body.planCode } })))
      throw new ProblemException('validation_failed', undefined, [
        { field: 'planCode', code: 'unknown_plan', message: 'plan not found' },
      ]);
    // ทุกอย่างใน transaction เดียว (spec/01 PLT-025): tenant + ค่าเริ่มต้น + role + owner + คำเชิญ + audit
    return db.$transaction(
      async (tx) => {
        const created = await tx.tenant.create({
          data: {
            name: body.name,
            status: 'TRIAL',
            ...(body.planCode ? { planCode: body.planCode } : {}),
            ...(body.vehicleQuota !== undefined ? { vehicleQuota: body.vehicleQuota } : {}),
          },
        });
        await bootstrapTenant(tx, created.id);
        const t = created;
        const tenant = created;
        const roles = await ensureSystemRoles(tx, t.id);
        const owner = await tx.appUser.create({
          data: {
            tenantId: t.id,
            email: body.ownerEmail,
            name: body.ownerName,
            status: 'INVITED',
          },
        });
        await tx.userRole.create({
          data: { tenantId: t.id, userId: owner.id, roleId: roles.owner! },
        });
        const ownerRole = await tx.role.findUniqueOrThrow({ where: { id: roles.owner! } });
        await issueInvitation(tx, this.email, owner, [ownerRole], null);
        await this.audit(tx, t.id, 'platform.tenant_created', body.reason, {
          name: tenant.name,
          planCode: tenant.planCode,
          vehicleQuota: tenant.vehicleQuota,
          owner: encodeId('user', owner.id),
        });
        return this.toDto(tenant, 1);
      },
      { timeout: 30_000 },
    );
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN')
  @ApiOkResponse({ type: PlatformTenantDto })
  async suspend(@Param('id') id: string, @Body() body: TenantReasonDto) {
    return this.setStatus(id, 'SUSPENDED', body.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN')
  @ApiOkResponse({ type: PlatformTenantDto })
  async reactivate(@Param('id') id: string, @Body() body: TenantReasonDto) {
    return this.setStatus(id, 'ACTIVE', body.reason);
  }

  /** เปลี่ยนแพ็กเกจ / quota รถ (จำนวนรถตามสัญญา — บังคับใช้ในโมดูลรถ ST2) */
  @Patch(':id/plan')
  @PlatformAuth('SUPER_ADMIN', 'BILLING')
  @ApiOkResponse({ type: PlatformTenantDto })
  async plan(@Param('id') id: string, @Body() body: UpdatePlanDto): Promise<PlatformTenantDto> {
    const db = this.prisma.platform;
    const t = await this.tenant(id);
    if (body.planCode === undefined && body.vehicleQuota === undefined)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'planCode', code: 'nothing_to_change', message: 'send planCode or vehicleQuota' },
      ]);
    if (body.planCode && !(await db.plan.findUnique({ where: { code: body.planCode } })))
      throw new ProblemException('validation_failed', undefined, [
        { field: 'planCode', code: 'unknown_plan', message: 'plan not found' },
      ]);
    const next = await db.$transaction(async (tx) => {
      const u = await tx.tenant.update({
        where: { id: t.id },
        data: {
          ...(body.planCode ? { planCode: body.planCode } : {}),
          ...(body.vehicleQuota !== undefined ? { vehicleQuota: body.vehicleQuota } : {}),
        },
      });
      await this.audit(
        tx,
        t.id,
        'platform.plan_changed',
        body.reason,
        { planCode: u.planCode, vehicleQuota: u.vehicleQuota },
        { planCode: t.planCode, vehicleQuota: t.vehicleQuota },
      );
      return u;
    });
    // แคช entitlement ของ instance นี้ล้างทันที; instance อื่นหมดอายุเองใน 60 วิ (ตาม TTL)
    this.entitlements.invalidate(t.id);
    return this.toDto(next, await this.countUsers(t.id));
  }

  /**
   * เข้าใช้งานแทน (docs/04 A6; spec/01 §11) — เฟส 0 อ่านอย่างเดียวเสมอ, 60 นาที
   * token ของผู้ใช้ที่สวมมี claim `act` = platform user → audit ทุกแถวมีทั้ง sub และ act · อีเมลแจ้ง owner ทุกครั้ง
   */
  @Post(':id/impersonate')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  @ApiOkResponse({ type: ImpersonationStartDto })
  async impersonate(
    @Param('id') id: string,
    @Body() body: ImpersonateDto,
  ): Promise<ImpersonationStartDto> {
    const db = this.prisma.platform;
    const ctx = requestContext.require();
    const staff = await db.platformUser.findUniqueOrThrow({ where: { id: ctx.platformUser!.id } });
    const t = await this.tenant(id);
    if (t.status === 'CANCELLED') throw new ProblemException('invalid_state_transition');
    const owners = await this.owners(t.id);
    let asUserId = owners[0]?.id;
    if (body.asUserId) {
      const uid = tryDecodeId('user', body.asUserId);
      const u = uid
        ? await db.appUser.findFirst({ where: { id: uid, tenantId: t.id, status: 'ACTIVE' } })
        : null;
      if (!u)
        throw new ProblemException('validation_failed', undefined, [
          {
            field: 'asUserId',
            code: 'invalid_user',
            message: 'must be an active user of this tenant',
          },
        ]);
      asUserId = u.id;
    }
    if (!asUserId)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'asUserId',
          code: 'no_active_user',
          message: 'tenant has no active user to act as',
        },
      ]);
    const asUser = await db.appUser.findUniqueOrThrow({ where: { id: asUserId } });
    const expiresAt = new Date(Date.now() + IMPERSONATION_MINUTES * 60_000);
    const session = await db.$transaction(async (tx) => {
      const s = await tx.impersonationSession.create({
        data: {
          platformUserId: staff.id,
          tenantId: t.id,
          asUserId,
          reason: body.reason,
          ticketRef: body.ticketRef ?? null,
          expiresAt,
          ip: ctx.ip ?? null,
          userAgent: null,
        },
      });
      await this.audit(
        tx,
        t.id,
        'impersonation.started',
        body.reason,
        {
          sessionId: s.id,
          asUserId: encodeId('user', asUserId!),
          mode: 'read_only',
          ticketRef: body.ticketRef ?? null,
        },
        undefined,
        asUserId!,
      );
      // แจ้ง owner ทุกคนทุกครั้ง (docs/04 A6)
      const at = new Intl.DateTimeFormat('th-TH', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Bangkok',
      }).format(new Date());
      await this.email.enqueueMany(
        tx,
        owners.map((o) => ({
          tenantId: t.id,
          to: o.email,
          template: 'impersonation_started' as const,
          locale: o.locale,
          vars: {
            tenantName: safeName(t.name),
            staffName: safeName(staff.name),
            asUserName: safeName(asUser.name),
            reason: safeName(body.reason, 300),
            minutes: IMPERSONATION_MINUTES,
            at,
          },
        })),
      );
      return s;
    });
    const scope = await this.auth.scopeOf(t.id, asUserId);
    const accessToken = await signAccessToken(
      { sub: asUserId, tid: t.id, scope, pt: 'imp', act: staff.id, sid: session.id },
      Math.floor(expiresAt.getTime() / 1000),
    );
    return {
      sessionId: session.id,
      accessToken,
      expiresAt: expiresAt.toISOString(),
      url: `${webBaseUrl()}/impersonate#token=${accessToken}`,
    };
  }

  private async setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED', reason: string) {
    const db = this.prisma.platform;
    const t = await this.tenant(id);
    const ok =
      status === 'SUSPENDED'
        ? t.status !== 'SUSPENDED' && t.status !== 'CANCELLED'
        : t.status === 'SUSPENDED';
    if (!ok) throw new ProblemException('invalid_state_transition');
    const next = await db.$transaction(async (tx) => {
      const u = await tx.tenant.update({ where: { id: t.id }, data: { status } });
      // ระงับ = เข้าใช้งานแทนที่เปิดอยู่จบทันที
      if (status === 'SUSPENDED')
        await tx.impersonationSession.updateMany({
          where: { tenantId: t.id, endedAt: null },
          data: { endedAt: new Date(), endReason: 'revoked' },
        });
      await this.audit(
        tx,
        t.id,
        status === 'SUSPENDED' ? 'platform.tenant_suspended' : 'platform.tenant_reactivated',
        reason,
        { status },
        { status: t.status },
      );
      return u;
    });
    this.entitlements.invalidate(t.id);
    return this.toDto(next, await this.countUsers(t.id));
  }

  private async tenant(id: string): Promise<Tenant> {
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: decodeIdOr404('tenant', id) },
    });
    if (!t) throw new ProblemException('not_found');
    return t;
  }

  private async owners(tenantId: string) {
    const db = this.prisma.platform;
    const role = await db.role.findFirst({ where: { tenantId, code: 'owner' } });
    if (!role) return [];
    const links = await db.userRole.findMany({ where: { tenantId, roleId: role.id } });
    return db.appUser.findMany({
      where: { tenantId, id: { in: links.map((l) => l.userId) }, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
  }

  private countUsers(tenantId: string) {
    return this.prisma.platform.appUser.count({ where: { tenantId, status: { not: 'DELETED' } } });
  }

  /** audit ของทีม Innovera ลงใน audit_log ของ tenant นั้น (ลูกค้าเห็นได้ — spec/01 §11.5) */
  private audit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    action: string,
    reason: string,
    after: object,
    before?: object,
    actAsUser?: string,
  ) {
    const ctx = requestContext.require();
    const staff = `platform:${ctx.platformUser!.id}`;
    return tx.auditLog.create({
      data: {
        tenantId,
        // เข้าใช้งานแทน: sub = ผู้ใช้ที่สวม, act = ทีมงาน · การกระทำอื่น: ผู้กระทำ = ทีมงาน
        actorId: actAsUser ?? staff,
        actAs: actAsUser ? staff : null,
        action,
        entityType: 'tenant',
        entityId: tenantId,
        before: (before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: after as Prisma.InputJsonValue,
        reason,
        requestId: ctx.requestId,
        ip: ctx.ip ?? null,
      },
    });
  }

  private toDto(t: Tenant, users: number): PlatformTenantDto {
    return {
      id: encodeId('tenant', t.id),
      name: t.name,
      status: t.status.toLowerCase(),
      planCode: t.planCode,
      vehicleQuota: t.vehicleQuota,
      users,
      createdAt: t.createdAt.toISOString(),
    };
  }
}
