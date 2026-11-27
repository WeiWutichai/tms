import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { PlatformRole, PlatformUser } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/password';
import { PasswordPolicy } from '../auth/password-policy';
import { webBaseUrl } from '../auth/password-reset.controller';
import { assertStepUp } from '../auth/step-up';
import { newOpaqueToken, sha256 } from '../auth/tokens';
import { newTotpSecret, otpauthUri, verifyTotp } from '../auth/totp';
import { FieldCipher } from '../common/crypto';
import { PlatformAuth, Public, StepUpAlways } from '../common/decorators';
import { decodeIdOr404, encodeId } from '../common/ids';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { safeName } from '../common/safe-text';
import { PrismaService } from '../db/prisma.service';
import { EmailService } from '../modules/email/email.service';
import { platformAudit } from './platform-audit';

/** คำเชิญทีมงานใช้ได้ 7 วัน (เท่าคำเชิญผู้ใช้ของลูกค้า — ST1-T07) */
export const STAFF_INVITE_DAYS = 7;
const ROLES = ['SUPER_ADMIN', 'SUPPORT', 'BILLING'] as const;
/** ชื่อบทบาทในอีเมล (ตรงกับ con.role.* ของเว็บ) */
const ROLE_TH: Record<PlatformRole, string> = {
  SUPER_ADMIN: 'super admin',
  SUPPORT: 'support',
  BILLING: 'billing',
};

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class PlatformStaffDto {
  @ApiProperty({ example: 'stf_…' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ROLES }) role!: string;
  @ApiProperty({
    description: 'ตั้ง 2FA แล้ว — ทีมงานต้องตั้งตอนรับคำเชิญ (รอรับคำเชิญ = false)',
  })
  twoFactorEnabled!: boolean;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  lastLoginAt!: string | null;
  @ApiProperty({ enum: ['active', 'invited', 'disabled'] }) status!: string;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'คำเชิญหมดอายุ (เฉพาะ invited)',
  })
  inviteExpiresAt!: string | null;
}

class StaffReasonBody {
  @ApiProperty({ example: 'ย้ายไปทีมอื่น ไม่ต้องใช้ Console แล้ว', minLength: 10 })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
export class InviteStaffDto extends StaffReasonBody {
  @ApiProperty({ example: 'malee@innovera.co.th' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;
  @ApiProperty({ example: 'มาลี ใจดี' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
  @ApiProperty({ enum: ROLES })
  @IsIn(ROLES)
  role!: PlatformRole;
}
export class DeactivateStaffDto extends StaffReasonBody {}

export class StaffInviteTokenDto {
  @ApiProperty({ description: 'token จากลิงก์ในอีเมลเชิญทีมงาน' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token!: string;
}
export class StaffInvitationInfoDto {
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ROLES }) role!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ description: 'secret TOTP (base32) ของคำเชิญนี้ — ตั้งในแอป Authenticator' })
  secret!: string;
  @ApiProperty({ description: 'otpauth:// สำหรับสร้าง QR' }) otpauthUri!: string;
}
export class AcceptStaffInvitationDto extends StaffInviteTokenDto {
  @ApiPropertyOptional({ example: 'มาลี ใจดี' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;
  @ApiProperty({ format: 'password', description: 'รหัสผ่าน (นโยบายเดียวกับผู้ใช้ — ST1-T02)' })
  @IsString()
  @MaxLength(1024)
  password!: string;
  @ApiProperty({ example: '123456', description: 'รหัส 6 หลักจากแอป Authenticator ที่ตั้งแล้ว' })
  @Matches(/^\d{6}$/)
  code!: string;
}

const toDto = (u: PlatformUser): PlatformStaffDto => ({
  id: encodeId('platformUser', u.id),
  name: u.name,
  email: u.email,
  role: u.role,
  // ทีมงานที่ใช้งานได้ = ผ่านการตั้ง 2FA แล้วเสมอ (บังคับตอนรับคำเชิญ/สร้างบัญชี) · ปิดแล้วคงค่าเดิมไว้ให้ดูย้อนหลัง
  twoFactorEnabled: u.status !== 'INVITED',
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  status: u.status.toLowerCase(),
  inviteExpiresAt: u.status === 'INVITED' ? (u.inviteExpiresAt?.toISOString() ?? null) : null,
});

/**
 * ทีมงานและสิทธิ์ของ Platform Console (P1-ST4-T06; spec/01 §10.8, §11.4 "จัดการทีมงาน" = owner → SUPER_ADMIN ตาม docs/04 A6)
 * ดูรายชื่อ = ทีมงานทุกบทบาท · เชิญ/ปิด = SUPER_ADMIN + step-up ของ Console (D-77) + เหตุผล ≥ 10 ตัว + audit (`platform_audit_log`)
 * ปิดบัญชี = สถานะ DISABLED + bump tokenVersion (token Console เดิมใช้ไม่ได้ทันที) + จบการเข้าใช้งานแทนที่เปิดอยู่
 */
@ApiTags('platform-console')
@ApiBearerAuth()
@Controller('platform/team')
export class PlatformTeamController {
  private cipher?: FieldCipher;
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  @Get()
  @PlatformAuth()
  @ApiOkResponse({ type: [PlatformStaffDto] })
  async list(): Promise<PlatformStaffDto[]> {
    const rows = await this.prisma.platform.platformUser.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // ใช้งาน → รอรับคำเชิญ → ปิดแล้ว
    const rank = (s: string) => (s === 'ACTIVE' ? 0 : s === 'INVITED' ? 1 : 2);
    return rows.sort((a, b) => rank(a.status) - rank(b.status)).map(toDto);
  }

  /**
   * เชิญทีมงาน — อีเมลใหม่ = สร้างบัญชีสถานะ INVITED · อีเมลที่ปิดไปแล้วหรือยังรอรับคำเชิญ = ออกคำเชิญใหม่ (ลิงก์เดิมใช้ไม่ได้)
   * บัญชีที่ใช้งานอยู่ → 409 duplicate · ผู้รับตั้งรหัสผ่าน + 2FA เองในหน้ารับคำเชิญ (ไม่มีใครรู้รหัสแทน)
   */
  @Post('invitations')
  @PlatformAuth('SUPER_ADMIN')
  @StepUpAlways('platform')
  @ApiHeader({
    name: 'X-Step-Up',
    required: true,
    description: 'stepUpToken จาก POST /v1/platform/auth/step-up',
  })
  @ApiCreatedResponse({ type: PlatformStaffDto })
  async invite(@Body() body: InviteStaffDto): Promise<PlatformStaffDto> {
    const db = this.prisma.platform;
    const me = requestContext.require().platformUser!.id;
    const existing = await db.platformUser.findUnique({ where: { email: body.email } });
    if (existing?.status === 'ACTIVE') throw new ProblemException('duplicate');
    assertStepUp(); // D-77 — หลัง validation/409
    const inviter = await db.platformUser.findUniqueOrThrow({ where: { id: me } });
    const { token, hash } = newOpaqueToken();
    const expires = new Date(Date.now() + STAFF_INVITE_DAYS * 86400_000);
    // secret TOTP ของคำเชิญนี้ (เข้ารหัส) — แสดงในหน้ารับคำเชิญ; รหัสผ่านสุ่ม (ไม่มีใครรู้) จนผู้รับตั้งเอง
    const cipher = (this.cipher ??= new FieldCipher());
    const data = {
      name: body.name,
      role: body.role,
      status: 'INVITED',
      passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
      totpSecret: cipher.encrypt(newTotpSecret()),
      totpLastStep: null,
      failedLogins: 0,
      lockedUntil: null,
      inviteTokenHash: hash,
      inviteExpiresAt: expires,
      invitedBy: me,
      deactivatedAt: null,
    };
    const u = await db.$transaction(async (tx) => {
      let row: PlatformUser;
      if (existing) {
        // เขียนทับเฉพาะเมื่อแถวยังเป็นสถานะเดิมที่อ่านมา (review: กันชนกับผู้รับคำเชิญที่เพิ่งกดรับ — ไม่งั้นรหัสผ่าน/2FA
        // ที่เพิ่งตั้งถูกล้างเงียบ ๆ) · ไม่ตรง = 409 concurrent_update ให้ผู้เชิญโหลดใหม่
        const r = await tx.platformUser.updateMany({
          where: {
            id: existing.id,
            status: existing.status,
            inviteTokenHash: existing.inviteTokenHash,
            tokenVersion: existing.tokenVersion,
          },
          // token Console ใด ๆ ที่ค้างจากรอบก่อนใช้ไม่ได้
          data: { ...data, tokenVersion: { increment: 1 } },
        });
        if (r.count !== 1) throw new ProblemException('concurrent_update');
        row = await tx.platformUser.findUniqueOrThrow({ where: { id: existing.id } });
      } else {
        // อีเมลเดียวกันถูกเชิญพร้อมกัน → unique email ชน → 409 duplicate
        row = await tx.platformUser
          .create({ data: { email: body.email, ...data } })
          .catch((e: { code?: string }) => {
            if (e?.code === 'P2002') throw new ProblemException('duplicate');
            throw e;
          });
      }
      await platformAudit(tx, {
        action: existing ? 'platform.staff_reinvited' : 'platform.staff_invited',
        entityType: 'platform_user',
        entityId: row.id,
        before: existing ? { status: existing.status.toLowerCase(), role: existing.role } : null,
        after: { email: row.email, name: row.name, role: row.role, status: 'invited' },
        reason: body.reason,
      });
      await this.email.enqueue(tx, {
        tenantId: null,
        to: row.email,
        template: 'platform_staff_invitation',
        locale: 'th',
        vars: {
          link: `${webBaseUrl()}/console/invite#token=${token}`,
          days: STAFF_INVITE_DAYS,
          inviterName: safeName(inviter.name),
          role: ROLE_TH[row.role],
        },
      });
      return row;
    });
    return toDto(u);
  }

  /** ปิดทีมงาน — session หลุดทันที (tokenVersion) + การเข้าใช้งานแทนที่เปิดอยู่จบ (revoked) · ตัวเอง/SUPER_ADMIN คนสุดท้าย → 409 */
  @Post(':id/deactivate')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN')
  @StepUpAlways('platform')
  @ApiHeader({
    name: 'X-Step-Up',
    required: true,
    description: 'stepUpToken จาก POST /v1/platform/auth/step-up',
  })
  @ApiOkResponse({ type: PlatformStaffDto })
  async deactivate(
    @Param('id') id: string,
    @Body() body: DeactivateStaffDto,
  ): Promise<PlatformStaffDto> {
    const db = this.prisma.platform;
    const me = requestContext.require().platformUser!.id;
    const u = await db.platformUser.findUnique({
      where: { id: decodeIdOr404('platformUser', id) },
    });
    if (!u) throw new ProblemException('not_found');
    if (u.status === 'DISABLED') throw new ProblemException('invalid_state_transition');
    if (u.id === me) throw new ProblemException('staff_deactivate_not_allowed');
    assertStepUp(); // D-77
    const next = await db.$transaction(async (tx) => {
      // ล็อกแถว SUPER_ADMIN ทั้งหมด — ปิดพร้อมกันสองคนต้องไม่ทำให้เหลือ 0
      if (u.role === 'SUPER_ADMIN' && u.status === 'ACTIVE') {
        const admins = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM platform_user WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE' FOR UPDATE`;
        if (admins.filter((a) => a.id !== u.id).length === 0)
          throw new ProblemException('staff_deactivate_not_allowed');
      }
      const r = await tx.platformUser.updateMany({
        where: { id: u.id, status: { not: 'DISABLED' } },
        data: {
          status: 'DISABLED',
          tokenVersion: { increment: 1 },
          deactivatedAt: new Date(),
          inviteTokenHash: null,
          inviteExpiresAt: null,
        },
      });
      if (r.count !== 1) throw new ProblemException('invalid_state_transition');
      const ended = await tx.impersonationSession.updateMany({
        where: { platformUserId: u.id, endedAt: null },
        data: { endedAt: new Date(), endReason: 'revoked' },
      });
      await platformAudit(tx, {
        action: 'platform.staff_deactivated',
        entityType: 'platform_user',
        entityId: u.id,
        before: { status: u.status.toLowerCase() },
        after: { status: 'disabled', impersonationsEnded: ended.count },
        reason: body.reason,
      });
      return tx.platformUser.findUniqueOrThrow({ where: { id: u.id } });
    });
    return toDto(next);
  }
}

/**
 * รับคำเชิญทีมงาน (P1-ST4-T06) — ไม่ต้อง login · ใต้ `/v1/platform/auth/*` (rate limit ต่อ IP กลุ่ม console)
 * ตั้งรหัสผ่าน + ยืนยันรหัส 6 หลักจาก secret ของคำเชิญ (2FA บังคับทุกคน — docs/04 A6) → ACTIVE แล้ว login ตามปกติ
 */
@ApiTags('platform-console')
@Public()
@Controller('platform/auth/invitations')
export class PlatformInvitationController {
  private cipher?: FieldCipher;
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PasswordPolicy,
  ) {}

  /** คำเชิญที่ยังใช้ได้ — ผิดทุกกรณี (ไม่มี/ใช้แล้ว/ปิดแล้ว/หมดอายุ) → invitation_invalid เหมือนกัน */
  private async load(token: string): Promise<PlatformUser> {
    const u = await this.prisma.platform.platformUser.findUnique({
      where: { inviteTokenHash: sha256(token) },
    });
    if (!u || u.status !== 'INVITED' || !u.inviteExpiresAt || u.inviteExpiresAt <= new Date())
      throw new ProblemException('invitation_invalid');
    return u;
  }

  @Post('inspect')
  @HttpCode(200)
  @ApiOkResponse({ type: StaffInvitationInfoDto })
  @ApiBadRequestResponse({ description: 'invitation_invalid — ไม่มี/หมดอายุ/ใช้แล้ว/ปิดแล้ว' })
  async inspect(
    @Body() body: StaffInviteTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StaffInvitationInfoDto> {
    res.setHeader('Cache-Control', 'no-store');
    const u = await this.load(body.token);
    const secret = (this.cipher ??= new FieldCipher()).decrypt(u.totpSecret);
    return {
      email: u.email,
      name: u.name,
      role: u.role,
      expiresAt: u.inviteExpiresAt!.toISOString(),
      secret,
      otpauthUri: otpauthUri(secret, u.email, 'TMS Console'),
    };
  }

  @Post('accept')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'เป็นทีมงานแล้ว — เข้าสู่ระบบ Console ด้วยอีเมลนี้' })
  @ApiBadRequestResponse({ description: 'invitation_invalid' })
  async accept(
    @Body() body: AcceptStaffInvitationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const db = this.prisma.platform;
    const u = await this.load(body.token);
    await this.policy.validate(body.password, undefined, 'password');
    const secret = (this.cipher ??= new FieldCipher()).decrypt(u.totpSecret);
    const step = verifyTotp(secret, body.code, null);
    if (step === null)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'code', code: 'invalid_otp', message: 'code is incorrect' },
      ]);
    const hash = await hashPassword(body.password);
    await db.$transaction(async (tx) => {
      // ใช้ครั้งเดียว: เงื่อนไขเดียวกับ load ใน UPDATE เดียว (สอง request พร้อมกันผ่านได้ครั้งเดียว)
      const r = await tx.platformUser.updateMany({
        where: {
          id: u.id,
          status: 'INVITED',
          inviteTokenHash: u.inviteTokenHash,
          inviteExpiresAt: { gt: new Date() },
        },
        data: {
          status: 'ACTIVE',
          passwordHash: hash,
          totpLastStep: BigInt(step),
          inviteTokenHash: null,
          inviteExpiresAt: null,
          failedLogins: 0,
          lockedUntil: null,
          tokenVersion: { increment: 1 },
          ...(body.name ? { name: body.name } : {}),
        },
      });
      if (r.count !== 1) throw new ProblemException('invitation_invalid');
      await platformAudit(tx, {
        platformUserId: u.id,
        action: 'platform.staff_joined',
        entityType: 'platform_user',
        entityId: u.id,
        // ผู้รับแก้ชื่อที่ผู้เชิญตั้งไว้ได้ — บันทึกชื่อเดิม/ใหม่ไว้ตรวจย้อนหลัง (review)
        before: {
          status: 'invited',
          ...(body.name && body.name !== u.name ? { name: u.name } : {}),
        },
        after: {
          status: 'active',
          role: u.role,
          ...(body.name && body.name !== u.name ? { name: body.name } : {}),
        },
      });
    });
  }
}
