import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { AppUser } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuditService } from '../../audit/audit.service';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';

export class ReasonDto {
  @ApiProperty({ example: 'พนักงานลาออก', description: 'เหตุผล (บังคับ — ลง audit)' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class UserStatusDto {
  @ApiProperty({ example: 'usr_…' }) id!: string;
  @ApiProperty({ enum: ['invited', 'active', 'disabled', 'deleted'] }) status!: string;
}

export class LoginHistoryQuery {
  @ApiPropertyOptional({ example: 'usr_…' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'nextCursor จากหน้าก่อน' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class LoginHistoryEntryDto {
  @ApiProperty({ format: 'date-time' }) at!: string;
  @ApiProperty({ nullable: true, type: String }) userId!: string | null;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ['success', 'failed', 'locked'] }) result!: string;
  @ApiProperty({
    example: 'invalid_credentials',
    description:
      'ok / password_ok / mfa_ok / mfa_backup_ok / mfa_enrolled / invalid_credentials / otp_failed / locked / tenant_selection_required',
  })
  reason!: string;
  @ApiProperty() ip!: string;
  @ApiProperty({ nullable: true, type: String }) userAgent!: string | null;
}
export class LoginHistoryPageDto {
  @ApiProperty({ type: [LoginHistoryEntryDto] }) data!: LoginHistoryEntryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

const DELETED_NAME = 'ผู้ใช้ที่ลบแล้ว';
const SUCCESS = ['ok', 'mfa_ok', 'mfa_backup_ok', 'mfa_enrolled'];

/**
 * วงจรชีวิตผู้ใช้ (ST1-T10; docs/04 A2) และประวัติ login (ST1-T11)
 * - ระงับ = bump tokenVersion + เพิกถอน refresh token → session ที่เปิดอยู่หลุดทันที
 * - ลบ = anonymize ข้อมูลส่วนตัว (ชื่อ/อีเมล/เบอร์/รหัสผ่าน/2FA) แต่เก็บแถวไว้ → audit แสดงเป็น "ผู้ใช้ที่ลบแล้ว"
 * - owner ระงับ/ลบได้เฉพาะโดย owner และห้ามเหลือ owner ที่ใช้งานได้ 0 คน; ทำกับตัวเองไม่ได้
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class UserLifecycleController {
  constructor(
    private readonly db: DbService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Post('users/:id/suspend')
  @HttpCode(200)
  @TenantResource('user')
  @RequireScope('users:write')
  @ApiOkResponse({ type: UserStatusDto })
  async suspend(@Param('id') id: string, @Body() body: ReasonDto): Promise<UserStatusDto> {
    const user = await this.target(id);
    if (user.status !== 'ACTIVE') throw new ProblemException('invalid_state_transition');
    await this.guardOwner(user);
    return this.apply(user, 'user.disabled', body.reason, { status: 'DISABLED' });
  }

  @Post('users/:id/activate')
  @HttpCode(200)
  @TenantResource('user')
  @RequireScope('users:write')
  @ApiOkResponse({ type: UserStatusDto })
  async activate(@Param('id') id: string, @Body() body: ReasonDto): Promise<UserStatusDto> {
    const user = await this.target(id);
    if (user.status !== 'DISABLED') throw new ProblemException('invalid_state_transition');
    await this.guardOwner(user, false);
    return this.apply(user, 'user.enabled', body.reason, { status: 'ACTIVE' });
  }

  /** ลบแบบ anonymize — ไม่มี hard delete (CLAUDE.md) */
  @Post('users/:id/delete')
  @HttpCode(200)
  @TenantResource('user')
  @RequireScope('users:write')
  @ApiOkResponse({ type: UserStatusDto })
  async remove(@Param('id') id: string, @Body() body: ReasonDto): Promise<UserStatusDto> {
    const user = await this.target(id);
    if (user.status === 'DELETED') throw new ProblemException('invalid_state_transition');
    await this.guardOwner(user);
    const result = await this.apply(user, 'user.deleted', body.reason, {
      status: 'DELETED',
      name: DELETED_NAME,
      email: `deleted-${user.id}@deleted.invalid`,
      phone: null,
      passwordHash: null,
      totpSecret: null,
      totpEnabledAt: null,
      totpLastStep: null,
      deletedAt: new Date(),
    });
    await this.db.tx.userRole.deleteMany({ where: { userId: user.id } });
    await this.prisma.platform.backupCode.deleteMany({
      where: { tenantId: user.tenantId, userId: user.id },
    });
    // ประวัติ login ของคนที่ลบ: เก็บเวลา/IP/ผลไว้เป็นหลักฐานความปลอดภัย แต่ตัดอีเมลจริงออก (PDPA — review T10)
    await this.prisma.platform.loginAttempt.updateMany({
      where: { tenantId: user.tenantId, userId: user.id },
      data: { email: `deleted-${user.id}@deleted.invalid` },
    });
    return result;
  }

  /** ประวัติ login ของ tenant (ST1-T11) — เก็บ 1 ปี (worker ลบที่เก่ากว่า) · ไม่แสดงแถวภายใน `attempt` */
  @Get('login-history')
  @RequireScope('users:read')
  @ApiOkResponse({ type: LoginHistoryPageDto })
  async history(@Query() q: LoginHistoryQuery): Promise<LoginHistoryPageDto> {
    const tenantId = requestContext.require().tenantId!;
    const limit = q.limit ?? 50;
    const userId = q.userId ? tryDecodeId('user', q.userId) : undefined;
    if (q.userId && !userId)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'userId', code: 'invalid_id', message: 'userId must be a usr_ id' },
      ]);
    let cursor: { at: Date; id: string } | undefined;
    if (q.cursor) {
      try {
        const v = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as {
          a: string;
          i: string;
        };
        cursor = { at: new Date(v.a), id: v.i };
        if (Number.isNaN(cursor.at.getTime()) || !/^[0-9a-f-]{36}$/i.test(String(v.i)))
          throw new Error();
      } catch {
        throw new ProblemException('validation_failed', undefined, [
          { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
        ]);
      }
    }
    // ตาราง platform (ไม่มี RLS ของแอป) — กรอง tenantId ของผู้เรียกเสมอ
    const rows = await this.prisma.platform.loginAttempt.findMany({
      where: {
        tenantId,
        // แถวภายใน: `attempt` (ตัวนับ) และ `password_ok` (ผ่านรหัสผ่าน รอ 2FA — ผลจริงคือแถว mfa_* ถัดไป)
        reason: { notIn: ['attempt', 'password_ok'] },
        ...(userId ? { userId } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.at } },
                { createdAt: cursor.at, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map((r) => ({
        at: r.createdAt.toISOString(),
        userId: r.userId ? encodeId('user', r.userId) : null,
        email: r.email,
        result:
          r.reason === 'locked'
            ? 'locked'
            : SUCCESS.includes(r.reason ?? '')
              ? 'success'
              : 'failed',
        reason: r.reason ?? '',
        ip: r.ip,
        userAgent: r.userAgent,
      })),
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ a: last.createdAt.toISOString(), i: last.id })).toString(
              'base64url',
            )
          : null,
      hasMore,
    };
  }

  private async target(id: string): Promise<AppUser> {
    const user = await this.db.tx.appUser.findUnique({ where: { id: decodeIdOr404('user', id) } });
    if (!user) throw new ProblemException('not_found');
    if (user.id === requestContext.require().actorId)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'id', code: 'self', message: 'cannot change your own account status' },
      ]);
    return user;
  }

  /** เป้าหมายเป็น owner: ผู้ทำต้องเป็น owner และ (ถ้าทำให้ใช้ไม่ได้) ต้องเหลือ owner ที่ใช้งานได้ ≥ 1 */
  private async guardOwner(user: AppUser, removing = true) {
    const tx = this.db.tx;
    const owner = await tx.role.findFirst({ where: { code: 'owner' } });
    if (!owner) return;
    const isOwner = await tx.userRole.findFirst({ where: { userId: user.id, roleId: owner.id } });
    if (!isOwner) return;
    const actor = requestContext.require().actorId ?? '';
    const actorIsOwner = await tx.userRole
      .findFirst({ where: { userId: actor, roleId: owner.id } })
      .catch(() => null);
    if (!actorIsOwner)
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'users',
        action: 'manage_owner',
        required: ['owner'],
      });
    if (!removing) return;
    await tx.$queryRaw`SELECT id FROM user_role WHERE role_id = ${owner.id}::uuid FOR UPDATE`;
    const links = await tx.userRole.findMany({ where: { roleId: owner.id } });
    const others = await tx.appUser.count({
      where: {
        id: { in: links.map((l) => l.userId).filter((u) => u !== user.id) },
        status: 'ACTIVE',
      },
    });
    if (others === 0)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'id', code: 'last_owner', message: 'tenant must keep at least one active owner' },
      ]);
  }

  private async apply(
    user: AppUser,
    action: string,
    reason: string,
    data: Record<string, unknown>,
  ): Promise<UserStatusDto> {
    const tx = this.db.tx;
    const updated = await tx.appUser.update({
      where: { id: user.id },
      data: { ...data, tokenVersion: { increment: 1 }, version: { increment: 1 } },
    });
    // session ที่เปิดอยู่หลุดทันที: tokenVersion (access + อุปกรณ์ที่จำไว้) + เพิกถอน refresh token ทั้งหมด
    await this.prisma.platform.refreshToken.updateMany({
      where: { tenantId: user.tenantId, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      action,
      entityType: 'user',
      entityId: user.id,
      before: { status: user.status.toLowerCase() },
      after: { status: updated.status.toLowerCase() },
      reason,
    });
    return { id: encodeId('user', updated.id), status: updated.status.toLowerCase() };
  }
}
