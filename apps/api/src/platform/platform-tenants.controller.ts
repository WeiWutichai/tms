import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { Prisma, Tenant } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsIn,
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
import { assertStepUp } from '../auth/step-up';
import { MfaService } from '../auth/mfa.service';
import { cleanupSecondFactor, resetSecondFactor } from '../auth/two-factor-reset';
import { webBaseUrl } from '../auth/password-reset.controller';
import { ensureSystemRoles } from '../auth/system-roles';
import { signAccessToken } from '../auth/tokens';
import { Clock } from '../common/clock';
import { PlatformAuth, StepUpAlways } from '../common/decorators';
import { decodeIdOr404, encodeId, tryDecodeId } from '../common/ids';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { safeName } from '../common/safe-text';
import { PrismaService } from '../db/prisma.service';
import { EmailService } from '../modules/email/email.service';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { currentPlanVersion } from '../modules/entitlements/plan-catalog';
import { moveSubscriptionPlan } from '../modules/entitlements/subscription';
import { bootstrapTenant } from '../modules/tenants/bootstrap';
import { platformAudit } from './platform-audit';
import { PlatformSettingsService } from './platform-settings.service';
import { issueInvitation } from '../modules/users/invitations.controller';

async function sellablePlan(db: PrismaService['platform'], code: string): Promise<boolean> {
  const p = await db.plan.findUnique({ where: { code } });
  return !!p && p.status !== 'archived' && !!(await currentPlanVersion(db, code));
}

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
/** เข้าใช้งานแทนได้นานสุด — ค่าเริ่มต้นของ `impersonation.maxMinutes` (spec/01 PLT-121; แก้ได้จาก Console — P1-ST1-T04) */
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
  @ApiPropertyOptional({ example: 30, nullable: true, type: Number })
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
  @ApiPropertyOptional({ example: 40, nullable: true, type: Number, description: 'null = ล้างค่า' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  vehicleQuota?: number | null;
}
export class TenantReasonDto extends ReasonBody {}
export class PlatformUserTwoFactorResetDto {
  @ApiProperty({ example: 'usr_…' }) id!: string;
  @ApiProperty({ example: false }) twoFactorEnabled!: boolean;
}
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
  @ApiProperty({ description: 'ตั้ง 2FA แล้ว (#81 — รีเซ็ตได้เมื่อ true)' })
  twoFactorEnabled!: boolean;
}
/**
 * ข้อความใน audit_log ของ tenant (ลูกค้าเห็น) เมื่อทีมงานตั้ง/ลบ override — เหตุผลจริงเป็นข้อมูลภายใน (PLT-066) อยู่ใน platform_audit_log
 */
export const OVERRIDE_AUDIT_TEXT = 'ผู้ให้บริการระบบปรับสิทธิ์พิเศษของบริษัท';
/** P1-ST1-T02 override สิทธิ์ต่อ tenant (spec/01 §6 `TenantEntitlementOverride`, PLT-062/066) */
export const OVERRIDE_MODES = ['grant', 'revoke', 'set_limit'] as const;
export class SetEntitlementOverrideDto extends ReasonBody {
  @ApiProperty({
    enum: OVERRIDE_MODES,
    description: 'grant = เปิดให้ · revoke = ปิด · set_limit = เปลี่ยนโควตา',
  })
  @IsIn([...OVERRIDE_MODES])
  mode!: (typeof OVERRIDE_MODES)[number];
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 3,
    description:
      'โควตา (set_limit ต้องส่งเป็นตัวเลข · grant ไม่ส่ง = คงโควตาเดิม หรือโควตาสูงสุดของแพ็กเกจที่มีฟีเจอร์นี้ · revoke ไม่ส่ง)',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  limit?: number | null;
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'หมดอายุ (ต้องเป็นอนาคต) · ไม่ส่ง/null = ไม่หมดอายุ — หมดแล้วฟีเจอร์กลับตามแพ็กเกจในรอบ cache ถัดไป (≤ 60 วิ)',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  expiresAt?: string | null;
}
export class EntitlementOverrideDto {
  @ApiProperty({ example: 'report' }) featureKey!: string;
  @ApiProperty({ example: 'รายงาน' }) featureName!: string;
  @ApiProperty({ enum: OVERRIDE_MODES }) mode!: string;
  @ApiProperty({ type: Number, nullable: true }) limit!: number | null;
  @ApiProperty({ description: 'เหตุผลภายใน (ไม่แสดงลูกค้า — PLT-066)' }) reason!: string;
  @ApiProperty({ type: String, nullable: true, description: 'ทีมงานที่อนุมัติ (platform user)' })
  approvedBy!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) expiresAt!: string | null;
  @ApiProperty({ description: 'หมดอายุแล้ว (ไม่มีผล)' }) expired!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
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
    private readonly mfa: MfaService,
    private readonly settings: PlatformSettingsService,
    private readonly clock: Clock,
  ) {}

  @Get()
  @PlatformAuth()
  @ApiOkResponse({ type: [PlatformTenantDto] })
  async list(@Query() q: PlatformTenantListQuery): Promise<PlatformTenantDto[]> {
    const rows = await this.prisma.platform.tenant.findMany({
      // ST7-T09: sandbox ของบริษัทไม่ใช่ลูกค้า — ไม่แสดง/จัดการจาก Console (ตามบริษัทจริง)
      where: {
        mode: 'live',
        ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
      },
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
        twoFactorEnabled: !!u.totpEnabledAt,
      })),
    };
  }

  /** สร้าง tenant (pilot) + ค่าเริ่มต้น + owner รับคำเชิญทางอีเมล */
  @Post()
  @PlatformAuth('SUPER_ADMIN')
  @ApiCreatedResponse({ type: PlatformTenantDto })
  async create(@Body() body: CreatePlatformTenantDto): Promise<PlatformTenantDto> {
    const db = this.prisma.platform;
    // P1-ST1-T01: แพ็กเกจต้องรับลูกค้าใหม่ (ไม่ archived) และมีเวอร์ชันที่มีผล — subscription ผูกเวอร์ชันนั้น (trigger 0175)
    if (body.planCode && !(await sellablePlan(db, body.planCode)))
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
    // P1-ST1-T01: แพ็กเกจต้องรับลูกค้าใหม่ (ไม่ archived) และมีเวอร์ชันที่มีผล — subscription ผูกเวอร์ชันนั้น (trigger 0175)
    if (body.planCode && !(await sellablePlan(db, body.planCode)))
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
      // P1-ST1-T01: เปลี่ยนแพ็กเกจ → subscription ไปเวอร์ชันที่มีผลของแพ็กเกจใหม่ (ลูกค้าเดิมของแพ็กเกจเดิมไม่ถูกย้าย — PLT-060)
      if (body.planCode && body.planCode !== t.planCode)
        await moveSubscriptionPlan(tx, t.id, body.planCode);
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
  // ST9-T13 R2-M02: เข้าใช้งานแทน = เห็นข้อมูลทั้งบริษัทของลูกค้า 60 นาที → ยืนยัน 2FA ซ้ำแบบ D-77 (ตรวจหลัง 404/สถานะ)
  // [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้]
  @StepUpAlways('platform') // ประกาศ X-Step-Up (ไม่บังคับใน schema — ไม่ breaking) + 403 ใน OpenAPI
  @ApiOkResponse({ type: ImpersonationStartDto })
  async impersonate(
    @Param('id') id: string,
    @Body() body: ImpersonateDto,
    @Req() req: Request,
  ): Promise<ImpersonationStartDto> {
    const db = this.prisma.platform;
    const ctx = requestContext.require();
    const staff = await db.platformUser.findUniqueOrThrow({ where: { id: ctx.platformUser!.id } });
    const t = await this.tenant(id);
    if (t.status === 'CANCELLED') throw new ProblemException('invalid_state_transition');
    assertStepUp(); // R2-M02
    // owner ทุกคน (รวมที่ยังรับคำเชิญไม่เสร็จ) ต้องได้อีเมลแจ้งทุกครั้ง (docs/04 A6) — ไม่มี owner = ห้ามเข้า
    const owners = await this.owners(t.id, ['ACTIVE', 'INVITED']);
    if (!owners.length)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'asUserId', code: 'no_owner', message: 'tenant has no owner to notify' },
      ]);
    let asUserId = owners.find((o) => o.status === 'ACTIVE')?.id;
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
    // P1-ST1-T04: อ่านค่าตั้งสด — มีผลกับ session ถัดไป ไม่ย้อน session ที่เปิดอยู่
    const minutes = await this.settings.get<number>('impersonation.maxMinutes');
    const expiresAt = new Date(Date.now() + minutes * 60_000);
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
          userAgent: req.header('user-agent')?.slice(0, 500) ?? null,
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
            minutes,
            at,
          },
        })),
      );
      return s;
    });
    const scope = await this.auth.scopeOf(t.id, asUserId);
    const accessToken = await signAccessToken(
      { sub: asUserId, tid: t.id, scope, pt: 'imp', act: staff.id, sid: session.id },
      minutes * 60, // อายุนับจากตอนนี้ (ตรงกับ session)
    );
    return {
      sessionId: session.id,
      accessToken,
      expiresAt: expiresAt.toISOString(),
      url: `${webBaseUrl()}/impersonate#token=${accessToken}`,
    };
  }

  /**
   * รีเซ็ต 2FA ของผู้ใช้ของลูกค้า (คำถามค้าง #81 — PO 24 พ.ย. 2569) — กรณีไม่มีผู้ดูแลในบริษัททำให้ได้ (เช่น owner คนเดียวทำเครื่องหาย)
   * SUPER_ADMIN เท่านั้น (docs/04 A6: SUPPORT ดู + เข้าใช้งานแทน) · step-up ของ Console (D-77 — ตรวจหลัง 404) · เหตุผล ≥ 10 ตัว
   * สถานะผู้ใช้: ใช้งาน / ระงับ / รอรับคำเชิญ ที่ตั้ง 2FA แล้ว → รีเซ็ตได้ (เหมือนฝั่งบริษัท — คนที่ถูกระงับได้ 2FA ใหม่ตอนเปิดใช้คืน) ·
   * ยังไม่ตั้ง 2FA → 409 · ลบแล้ว → 404 (ไม่อยู่ในรายชื่อสมาชิกของ Console; ฝั่งบริษัทตอบ 409 เพราะยังหาแถวเจอ)
   * ผลเหมือนฝั่งบริษัท (`POST /v1/users/{id}/reset-2fa`) · audit ลง audit_log ของบริษัทนั้น (actor = `platform:<id>`) + อีเมลแจ้งเจ้าของบัญชี
   */
  @Post(':id/users/:userId/reset-2fa')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN')
  @StepUpAlways('platform')
  @ApiHeader({
    name: 'X-Step-Up',
    required: true,
    description: 'stepUpToken จาก POST /v1/platform/auth/step-up',
  })
  @ApiOkResponse({ type: PlatformUserTwoFactorResetDto })
  async resetTwoFactor(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: TenantReasonDto,
  ): Promise<PlatformUserTwoFactorResetDto> {
    const db = this.prisma.platform;
    const t = await this.tenant(id);
    const uid = decodeIdOr404('user', userId);
    const user = await db.appUser.findFirst({
      where: { id: uid, tenantId: t.id, status: { not: 'DELETED' } },
    });
    if (!user) throw new ProblemException('not_found');
    assertStepUp(); // D-77
    if (!user.totpEnabledAt) throw new ProblemException('invalid_state_transition');
    const staff = await db.platformUser.findUniqueOrThrow({
      where: { id: requestContext.require().platformUser!.id },
    });
    // ทุกขั้นใน transaction เดียว (client platform) — รีเซ็ตซ้อน/ล้มเหลว = ไม่มีอะไรถูกลบ
    await db.$transaction(async (tx) => {
      await resetSecondFactor(tx, this.email, this.mfa, user, {
        tenantName: t.name,
        actorName: staff.name,
        byStaff: true,
        reason: body.reason,
      });
      const ctx = requestContext.require();
      await tx.auditLog.create({
        data: {
          tenantId: t.id,
          actorId: `platform:${staff.id}`,
          action: 'user.2fa_reset',
          entityType: 'user',
          entityId: user.id,
          before: { twoFactorEnabled: true },
          after: { twoFactorEnabled: false },
          reason: body.reason,
          requestId: ctx.requestId,
          ip: ctx.ip ?? null,
        },
      });
      await cleanupSecondFactor(tx, user);
    });
    return { id: encodeId('user', user.id), twoFactorEnabled: false };
  }

  /** override สิทธิ์ของ tenant (P1-ST1-T02) — ทีมงานทุก role ดูได้ (แท็บ "สิทธิ์พิเศษ" ของ Console เป็นงาน P1-ST4-T02) */
  @Get(':id/entitlement-overrides')
  @PlatformAuth()
  @ApiOkResponse({ type: [EntitlementOverrideDto] })
  async overrides(@Param('id') id: string): Promise<EntitlementOverrideDto[]> {
    const t = await this.tenant(id);
    const rows = await this.prisma.platform.tenantEntitlementOverride.findMany({
      where: { tenantId: t.id },
      orderBy: { featureKey: 'asc' },
    });
    return this.overrideDtos(rows);
  }

  /**
   * ตั้ง override (P1-ST1-T02; spec/01 PLT-062, PLT-066) — 1 แถวต่อฟีเจอร์ (ตั้งซ้ำ = แทนที่) · เหตุผล ≥ 10 + audit (before/after)
   * owner (SUPER_ADMIN) เท่านั้น → ผู้อนุมัติ = ผู้ตั้งเอง · คำขอจาก sales/support ที่ต้องให้ owner อนุมัติ = P1-ST4-T02
   * ฟีเจอร์พื้นฐาน (isBasic) ตั้งไม่ได้ (422 `basic_feature_locked` — PLT-077: ข้อจำกัดเดียวของพื้นฐาน = สถานะ tenant)
   * cache ของ instance นี้ล้างทันที · instance อื่น/worker ภายใน 60 วิ
   */
  @Put(':id/entitlement-overrides/:featureKey')
  @PlatformAuth('SUPER_ADMIN')
  @ApiOkResponse({ type: EntitlementOverrideDto })
  async setOverride(
    @Param('id') id: string,
    @Param('featureKey') featureKey: string,
    @Body() body: SetEntitlementOverrideDto,
  ): Promise<EntitlementOverrideDto> {
    const db = this.prisma.platform;
    const t = await this.tenant(id);
    const f = await this.overrideFeature(featureKey);
    const bad = (field: string, code: string, message: string) =>
      new ProblemException('validation_failed', undefined, [{ field, code, message }]);
    if (body.mode === 'set_limit' && (body.limit === undefined || body.limit === null))
      throw bad('limit', 'required', 'set_limit requires limit');
    if (body.mode === 'revoke' && body.limit !== undefined && body.limit !== null)
      throw bad('limit', 'not_allowed', 'revoke takes no limit');
    if (body.mode === 'grant' && body.limit === null)
      throw bad('limit', 'not_allowed', 'omit limit for the plan maximum');
    if (f.type === 'boolean' && body.limit !== undefined && body.limit !== null)
      throw bad('limit', 'not_allowed', 'feature has no limit');
    if (f.type === 'boolean' && body.mode === 'set_limit')
      throw bad('mode', 'not_allowed', 'set_limit needs a limit-type feature');
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= this.clock.now().getTime())
      throw bad('expiresAt', 'must_be_future', 'expiresAt must be in the future');
    const staff = requestContext.require().platformUser!.id;
    const data = {
      mode: body.mode,
      limit: body.mode === 'revoke' ? null : (body.limit ?? null),
      reason: body.reason,
      approvedBy: staff,
      expiresAt,
    };
    const row = await db.$transaction(async (tx) => {
      const before = await tx.tenantEntitlementOverride.findUnique({
        where: { tenantId_featureKey: { tenantId: t.id, featureKey: f.key } },
      });
      const r = await tx.tenantEntitlementOverride.upsert({
        where: { tenantId_featureKey: { tenantId: t.id, featureKey: f.key } },
        create: { tenantId: t.id, featureKey: f.key, ...data },
        update: { ...data, createdAt: this.clock.now() },
      });
      const after = { featureKey: f.key, mode: r.mode, limit: r.limit, expiresAt: r.expiresAt };
      const prev = before
        ? { featureKey: f.key, mode: before.mode, limit: before.limit, expiresAt: before.expiresAt }
        : undefined;
      // PLT-066: เหตุผลเป็นข้อมูลภายใน → platform_audit_log · audit ของ tenant (ลูกค้าเห็น) มีแค่ก่อน/หลัง + ข้อความกลาง
      await platformAudit(tx, {
        action: 'platform.entitlement_override_set',
        entityType: 'tenant',
        entityId: t.id,
        reason: body.reason,
        after,
        before: prev,
      });
      await this.audit(
        tx,
        t.id,
        'platform.entitlement_override_set',
        OVERRIDE_AUDIT_TEXT,
        after,
        prev,
      );
      return r;
    });
    this.entitlements.invalidate(t.id);
    return (await this.overrideDtos([row]))[0]!;
  }

  /** ลบ override (P1-ST1-T02) — ฟีเจอร์กลับตามแพ็กเกจ/add-on · เหตุผล + audit · ไม่มีแถว = 404 */
  @Post(':id/entitlement-overrides/:featureKey/remove')
  @HttpCode(204)
  @PlatformAuth('SUPER_ADMIN')
  async removeOverride(
    @Param('id') id: string,
    @Param('featureKey') featureKey: string,
    @Body() body: TenantReasonDto,
  ): Promise<void> {
    const t = await this.tenant(id);
    const f = await this.overrideFeature(featureKey);
    await this.prisma.platform.$transaction(async (tx) => {
      const before = await tx.tenantEntitlementOverride.findUnique({
        where: { tenantId_featureKey: { tenantId: t.id, featureKey: f.key } },
      });
      if (!before) throw new ProblemException('not_found');
      await tx.tenantEntitlementOverride.delete({ where: { id: before.id } });
      const after = { featureKey: f.key, removed: true };
      const prev = {
        featureKey: f.key,
        mode: before.mode,
        limit: before.limit,
        expiresAt: before.expiresAt,
      };
      await platformAudit(tx, {
        action: 'platform.entitlement_override_removed',
        entityType: 'tenant',
        entityId: t.id,
        reason: body.reason,
        after,
        before: prev,
      });
      await this.audit(
        tx,
        t.id,
        'platform.entitlement_override_removed',
        OVERRIDE_AUDIT_TEXT,
        after,
        prev,
      );
    });
    this.entitlements.invalidate(t.id);
  }

  private async overrideFeature(featureKey: string) {
    const f = await this.prisma.platform.feature.findUnique({ where: { key: featureKey } });
    if (!f)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'featureKey', code: 'unknown_feature', message: 'unknown feature' },
      ]);
    if (f.isBasic)
      throw new ProblemException('basic_feature_locked', undefined, undefined, {
        featureKey: f.key,
      });
    return f;
  }

  private async overrideDtos(
    rows: Prisma.TenantEntitlementOverrideGetPayload<object>[],
  ): Promise<EntitlementOverrideDto[]> {
    const names = new Map(
      (
        await this.prisma.platform.feature.findMany({
          where: { key: { in: rows.map((r) => r.featureKey) } },
          select: { key: true, nameTh: true },
        })
      ).map((f) => [f.key, f.nameTh]),
    );
    const now = this.clock.now().getTime();
    return rows.map((r) => ({
      featureKey: r.featureKey,
      featureName: names.get(r.featureKey) ?? r.featureKey,
      mode: r.mode,
      limit: r.limit,
      reason: r.reason,
      approvedBy: r.approvedBy,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      expired: !!r.expiresAt && r.expiresAt.getTime() <= now,
      createdAt: r.createdAt.toISOString(),
    }));
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
    if (!t || t.mode !== 'live') throw new ProblemException('not_found');
    return t;
  }

  private async owners(tenantId: string, statuses: ('ACTIVE' | 'INVITED')[] = ['ACTIVE']) {
    const db = this.prisma.platform;
    const role = await db.role.findFirst({ where: { tenantId, code: 'owner' } });
    if (!role) return [];
    const links = await db.userRole.findMany({ where: { tenantId, roleId: role.id } });
    return db.appUser.findMany({
      where: { tenantId, id: { in: links.map((l) => l.userId) }, status: { in: statuses } },
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
