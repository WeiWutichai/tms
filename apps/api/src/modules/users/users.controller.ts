import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { requestContext } from '../../common/request-context';
import { ROLE_CODES } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { ProblemException } from '../../common/problem';
import type { AppUser, Role } from '@prisma/client';
import { RequireScope, RequireStepUp, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { keysetArgs, ListQuery, toPage } from '../../common/pagination';
import { DbService } from '../../db/db.service';

export class RoleDto {
  @ApiProperty({ example: 'rol_…' }) id!: string;
  @ApiProperty({ example: 'planner' }) code!: string;
  @ApiProperty({ example: 'ผู้วางแผน' }) name!: string;
  @ApiProperty({ nullable: true, type: String }) nameEn!: string | null;
  @ApiProperty({ description: 'role ระบบ (ตาราง A3) — แก้/ลบไม่ได้' }) isSystem!: boolean;
  @ApiProperty({ type: [String], description: 'scope แบบ resource:verb' }) permissions!: string[];
}
export class RoleListDto {
  @ApiProperty({ type: [RoleDto] }) data!: RoleDto[];
}
export class UserRoleRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}
export class UserDto {
  @ApiProperty({ example: 'usr_…' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ['invited', 'active', 'disabled'] }) status!: string;
  @ApiProperty({ type: [UserRoleRefDto] }) roles!: UserRoleRefDto[];
  @ApiProperty({ description: 'ตั้ง 2FA (TOTP) แล้ว' }) twoFactorEnabled!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastLoginAt!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class SetRolesDto {
  @ApiProperty({ type: [String], example: ['planner'], description: 'role code ระบบ (ตาราง A3)' })
  @ArrayMinSize(1)
  @ArrayMaxSize(9)
  @ArrayUnique()
  @IsIn([...ROLE_CODES], { each: true })
  roles!: string[];

  @ApiProperty({ example: 'ย้ายไปฝ่ายวางแผน', description: 'เหตุผล (บังคับ — ลง audit)' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class UserPageDto {
  @ApiProperty({ type: [UserDto] }) data!: UserDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

/** ลำดับ role ตามตาราง A3 (ซ้าย → ขวา) */
const ORDER = [
  'owner',
  'admin',
  'manager',
  'planner',
  'dispatcher',
  'invoicer',
  'accounting',
  'approver',
  'viewer',
];
const rank = (code: string) => {
  const i = ORDER.indexOf(code);
  return i < 0 ? ORDER.length : i;
};

function toRoleDto(r: Role): RoleDto {
  return {
    id: encodeId('role', r.id),
    code: r.code,
    name: r.nameTh,
    nameEn: r.nameEn,
    isSystem: r.isSystem,
    permissions: [...r.permissions].sort(),
  };
}

/** ผู้ใช้และ role ของ tenant (ST1-T12; spec/01 §12) — เปลี่ยน role ต้อง step-up 2FA จึงมาพร้อม ST1-T05/T07 */
@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('roles')
  @RequireScope('users:read')
  @ApiOkResponse({ type: RoleListDto })
  async roles(): Promise<RoleListDto> {
    const rows = await this.db.tx.role.findMany();
    rows.sort((a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code));
    return { data: rows.map(toRoleDto) };
  }

  /**
   * เปลี่ยน role ของผู้ใช้ — ต้อง step-up 2FA (A3) · bump tokenVersion ให้ทุก session ของผู้ใช้นั้นหลุดทันที (A1)
   * ห้ามเหลือ owner 0 คน
   */
  @Put('users/:id/roles')
  @TenantResource('user')
  @RequireScope('users:write')
  @RequireStepUp()
  @ApiHeader({
    name: 'X-Step-Up',
    required: true,
    description: 'stepUpToken จาก POST /v1/auth/step-up',
  })
  @ApiOkResponse({ type: UserDto })
  async setRoles(@Param('id') id: string, @Body() body: SetRolesDto): Promise<UserDto> {
    const tx = this.db.tx;
    const userId = decodeIdOr404('user', id);
    const user = await tx.appUser.findUnique({ where: { id: userId } });
    if (!user) throw new ProblemException('not_found');
    if (user.status === 'DELETED') throw new ProblemException('invalid_state_transition');
    const roles = await tx.role.findMany({ where: { code: { in: body.roles } } });
    const before = await tx.userRole.findMany({ where: { userId } });
    const beforeCodes = (
      await tx.role.findMany({ where: { id: { in: before.map((b) => b.roleId) } } })
    ).map((r) => r.code);
    const owner = await tx.role.findFirst({ where: { code: 'owner' } });
    // มอบ/ถอด owner ได้เฉพาะ owner (admin ยกตัวเองเป็น owner แล้วถอด owner จริงไม่ได้ — review T05 S2; [OPEN] ยืนยันกับ PO)
    const touchesOwner = beforeCodes.includes('owner') !== body.roles.includes('owner');
    if (touchesOwner && owner) {
      const actor = requestContext.require().actorId ?? '';
      const actorIsOwner = await tx.userRole
        .findFirst({
          where: { userId: actor, roleId: owner.id },
        })
        .catch(() => null);
      if (!actorIsOwner)
        throw new ProblemException('permission_denied', undefined, undefined, {
          module: 'users',
          action: 'grant_owner',
          required: ['owner'],
        });
    }
    if (owner && beforeCodes.includes('owner') && !body.roles.includes('owner')) {
      // ล็อกแถวผู้ใช้ที่เป็น owner ทั้งหมด กันสองคนถอดกันเองพร้อมกันจนไม่เหลือ owner
      await tx.$queryRaw`SELECT id FROM user_role WHERE role_id = ${owner.id}::uuid FOR UPDATE`;
      const ownerLinks = await tx.userRole.findMany({ where: { roleId: owner.id } });
      // นับเฉพาะ owner ที่ยังใช้งานได้ (ผู้ใช้ที่ถูกระงับไม่นับ — review T05 M4)
      const owners = await tx.appUser.count({
        where: { id: { in: ownerLinks.map((l) => l.userId) }, status: 'ACTIVE' },
      });
      if (owners <= 1)
        throw new ProblemException('validation_failed', undefined, [
          { field: 'roles', code: 'last_owner', message: 'tenant must keep at least one owner' },
        ]);
    }
    await tx.userRole.deleteMany({ where: { userId } });
    await tx.userRole.createMany({
      data: roles.map((r) => ({ tenantId: user.tenantId, userId, roleId: r.id })),
    });
    const updated = await tx.appUser.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 }, version: { increment: 1 } },
    });
    await this.audit.record({
      action: 'user.role_changed',
      entityType: 'user',
      entityId: userId,
      before: { roles: [...beforeCodes].sort() },
      after: { roles: [...body.roles].sort() },
      reason: body.reason,
    });
    return (await this.toDtos([updated]))[0]!;
  }

  @Get('users')
  @RequireScope('users:read')
  @ApiOkResponse({ type: UserPageDto })
  async users(@Query() q: ListQuery) {
    const k = keysetArgs(q);
    // ผู้ใช้ที่ลบแล้ว (anonymize) ไม่แสดงในรายการ — ยังอยู่ให้ audit อ้างถึง
    const rows = await this.db.tx.appUser.findMany({
      where: { ...k.where, status: { not: 'DELETED' } },
      orderBy: k.orderBy as never,
      take: k.take,
    });
    const dtos = new Map((await this.toDtos(rows)).map((d, i) => [rows[i]!.id, d]));
    return toPage(rows, k, (u) => dtos.get(u.id)!, q.fields);
  }

  private async toDtos(rows: AppUser[]): Promise<UserDto[]> {
    const links = await this.db.tx.userRole.findMany({
      where: { userId: { in: rows.map((u) => u.id) } },
    });
    const roles = new Map(
      (await this.db.tx.role.findMany({ where: { id: { in: links.map((l) => l.roleId) } } })).map(
        (r) => [r.id, r],
      ),
    );
    return rows.map((u): UserDto => ({
      id: encodeId('user', u.id),
      name: u.name,
      email: u.email,
      status: u.status.toLowerCase(),
      roles: links
        .filter((l) => l.userId === u.id)
        .map((l) => roles.get(l.roleId))
        .filter((r): r is Role => !!r)
        .sort((a, b) => rank(a.code) - rank(b.code))
        .map((r) => ({ id: encodeId('role', r.id), code: r.code, name: r.nameTh })),
      twoFactorEnabled: !!u.totpEnabledAt,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      updatedAt: u.updatedAt.toISOString(),
    }));
  }
}
