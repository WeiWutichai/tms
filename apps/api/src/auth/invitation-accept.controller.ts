import { Body, Controller, HttpCode, Injectable, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { AppUser, PrismaClient } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { PrismaService } from '../db/prisma.service';
import { hashPassword, verifyPassword } from './password';
import { PasswordPolicy } from './password-policy';
import { lockSeconds, recordAttempt } from './throttle';
import { sha256 } from './tokens';

export class InvitationTokenDto {
  @ApiProperty({ description: 'token จากลิงก์ในอีเมลเชิญ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token!: string;
}

export class InvitationInfoDto {
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty() tenantName!: string;
  @ApiProperty({ type: [String], description: 'ชื่อ role (ไทย)' }) roles!: string[];
  @ApiProperty({
    description:
      'มีบัญชีในบริษัทอื่นแล้ว → รับคำเชิญด้วยรหัสผ่านเดิม (currentPassword) แทนการตั้งรหัสใหม่',
  })
  existingAccount!: boolean;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class AcceptInvitationDto extends InvitationTokenDto {
  @ApiPropertyOptional({ example: 'สมชาย ใจดี' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ format: 'password', description: 'ผู้ใช้ใหม่: รหัสผ่าน (นโยบาย ST1-T02)' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  password?: string;

  @ApiPropertyOptional({ format: 'password', description: 'มีบัญชีแล้ว: รหัสผ่านปัจจุบัน' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  currentPassword?: string;
}

const LIVE = ['TRIAL', 'ACTIVE'] as const;

@Injectable()
export class InvitationAcceptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PasswordPolicy,
  ) {}

  /** คำเชิญที่ยังใช้ได้ — ผิดทุกกรณี (ไม่มี/ใช้แล้ว/เพิกถอน/หมดอายุ/บริษัทระงับ) → invitation_invalid เหมือนกัน */
  private async load(token: string) {
    const db = this.prisma.platform;
    const inv = await db.userInvitation.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    if (
      !inv ||
      inv.acceptedAt ||
      inv.revokedAt ||
      inv.expiresAt.getTime() <= Date.now() ||
      inv.user.status !== 'INVITED'
    )
      throw new ProblemException('invitation_invalid');
    const tenant = await db.tenant.findUnique({ where: { id: inv.tenantId } });
    if (!tenant || !(LIVE as readonly string[]).includes(tenant.status))
      throw new ProblemException('invitation_invalid');
    return { inv, tenant };
  }

  /** บัญชีเดิมของอีเมลนี้ในบริษัทอื่นที่ใช้งานได้ (ตัวตนเดียวข้ามบริษัท — PLT-035) */
  private async accounts(email: string, exceptTenant: string): Promise<AppUser[]> {
    const db = this.prisma.platform;
    const users = await db.appUser.findMany({
      where: {
        email: { equals: email, mode: 'insensitive' },
        status: 'ACTIVE',
        passwordHash: { not: null },
        tenantId: { not: exceptTenant },
      },
    });
    if (!users.length) return [];
    const live = await db.tenant.findMany({
      where: { id: { in: users.map((u) => u.tenantId) }, status: { in: [...LIVE] } },
      select: { id: true },
    });
    return users.filter((u) => live.some((t) => t.id === u.tenantId));
  }

  async inspect(token: string): Promise<InvitationInfoDto> {
    const { inv, tenant } = await this.load(token);
    const links = await this.prisma.platform.userRole.findMany({ where: { userId: inv.userId } });
    const roles = await this.prisma.platform.role.findMany({
      where: { id: { in: links.map((l) => l.roleId) } },
    });
    return {
      email: inv.user.email,
      name: inv.user.name,
      tenantName: tenant.name,
      roles: roles.map((r) => r.nameTh),
      existingAccount: (await this.accounts(inv.email, inv.tenantId)).length > 0,
      expiresAt: inv.expiresAt.toISOString(),
    };
  }

  async accept(body: AcceptInvitationDto, client: { ip: string; userAgent?: string }) {
    const { inv } = await this.load(body.token);
    const db = this.prisma.platform;
    const email = inv.email.toLowerCase();
    const existing = await this.accounts(email, inv.tenantId);
    let hash: string;
    if (existing.length) {
      // มีบัญชีแล้ว: ยืนยันตัวตนด้วยรหัสเดิม (นับรวมเพดานผิด 5 ครั้ง/15 นาทีของ login)
      if (!body.currentPassword)
        throw new ProblemException('validation_failed', undefined, [
          { field: 'currentPassword', code: 'isNotEmpty', message: 'currentPassword is required' },
        ]);
      // จองช่องแบบเดียวกับ login: ล็อกต่ออีเมล → IP แล้วตรวจเพดาน + เขียน attempt ใน transaction สั้น (กันยิงขนานเลี่ยงเพดาน)
      const who = { tenantId: inv.tenantId, userId: inv.userId };
      let locked = 0;
      try {
        locked = await db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(1, hashtext(${email}))`;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(2, hashtext(${client.ip}))`;
            const t = tx as unknown as PrismaClient;
            const l = await lockSeconds(t, email, client.ip, Date.now());
            await recordAttempt(t, email, client, {
              success: false,
              reason: l > 0 ? 'locked' : 'attempt',
              ...who,
            });
            return l;
          },
          { maxWait: 2_000, timeout: 5_000 },
        );
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'P2024' || code === 'P2028' || code === 'P2010')
          throw new ProblemException('rate_limited');
        throw e;
      }
      if (locked > 0)
        throw new ProblemException('account_locked', undefined, undefined, { retryAfter: locked });
      let match: AppUser | undefined;
      for (const u of existing)
        if (await verifyPassword(u.passwordHash!, body.currentPassword)) {
          match = u;
          break;
        }
      if (!match) {
        // ให้เห็นในประวัติ login ของบริษัทเจ้าของบัญชีด้วย (เหมือน login ผิด)
        for (const u of existing)
          await recordAttempt(db, email, client, {
            success: false,
            reason: 'invalid_credentials',
            tenantId: u.tenantId,
            userId: u.id,
          });
        throw new ProblemException('validation_failed', undefined, [
          {
            field: 'currentPassword',
            code: 'password_incorrect',
            message: 'password is incorrect',
          },
        ]);
      }
      await recordAttempt(db, email, client, { success: true, reason: 'password_ok', ...who });
      hash = match.passwordHash!;
    } else {
      if (!body.password)
        throw new ProblemException('validation_failed', undefined, [
          { field: 'password', code: 'isNotEmpty', message: 'password is required' },
        ]);
      await this.policy.validate(body.password, undefined, 'password');
      hash = await hashPassword(body.password);
    }
    await db.$transaction(async (tx) => {
      const claimed = await tx.userInvitation.updateMany({
        where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count !== 1) throw new ProblemException('invitation_invalid');
      const r = await tx.appUser.updateMany({
        where: { id: inv.userId, status: 'INVITED' },
        data: {
          status: 'ACTIVE',
          passwordHash: hash,
          ...(body.name ? { name: body.name } : {}),
          tokenVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      if (r.count !== 1) throw new ProblemException('invitation_invalid');
      await tx.auditLog.create({
        data: {
          tenantId: inv.tenantId,
          actorId: inv.userId,
          action: 'user.joined',
          entityType: 'user',
          entityId: inv.userId,
          after: { invitationId: inv.id, existingAccount: existing.length > 0 },
          ip: client.ip,
          requestId: requestContext.get()?.requestId ?? null,
        },
      });
    });
  }
}

/** รับคำเชิญ (ST1-T07; spec/01 §3 "หน้ารับคำเชิญ", PLT-035) — ไม่ต้อง login */
@ApiTags('auth')
@Public()
@Controller('auth/invitations')
export class InvitationAcceptController {
  constructor(private readonly svc: InvitationAcceptService) {}

  @Post('inspect')
  @HttpCode(200)
  @ApiOkResponse({ type: InvitationInfoDto })
  @ApiBadRequestResponse({ description: 'invitation_invalid — ไม่มี/หมดอายุ/ใช้แล้ว/เพิกถอน' })
  async inspect(
    @Body() body: InvitationTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvitationInfoDto> {
    res.setHeader('Cache-Control', 'no-store');
    return this.svc.inspect(body.token);
  }

  @Post('accept')
  @HttpCode(204)
  @ApiNoContentResponse({
    description:
      'เป็นสมาชิกแล้ว — เข้าสู่ระบบด้วยอีเมลนี้ (role ที่บังคับ 2FA จะถูกพาไปตั้ง 2FA ตอน login)',
  })
  @ApiBadRequestResponse({ description: 'invitation_invalid' })
  async accept(
    @Body() body: AcceptInvitationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    await this.svc.accept(body, {
      ip: req.ip ?? 'unknown',
      userAgent: req.header('user-agent') ?? undefined,
    });
  }
}
