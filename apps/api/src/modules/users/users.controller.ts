import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { AppUser, Role } from '@prisma/client';
import { RequireScope } from '../../common/decorators';
import { encodeId } from '../../common/ids';
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
  constructor(private readonly db: DbService) {}

  @Get('roles')
  @RequireScope('users:read')
  @ApiOkResponse({ type: RoleListDto })
  async roles(): Promise<RoleListDto> {
    const rows = await this.db.tx.role.findMany();
    rows.sort((a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code));
    return { data: rows.map(toRoleDto) };
  }

  @Get('users')
  @RequireScope('users:read')
  @ApiOkResponse({ type: UserPageDto })
  async users(@Query() q: ListQuery) {
    const k = keysetArgs(q);
    const rows = await this.db.tx.appUser.findMany({
      where: k.where,
      orderBy: k.orderBy as never,
      take: k.take,
    });
    const links = await this.db.tx.userRole.findMany({
      where: { userId: { in: rows.map((u) => u.id) } },
    });
    const roles = new Map(
      (await this.db.tx.role.findMany({ where: { id: { in: links.map((l) => l.roleId) } } })).map(
        (r) => [r.id, r],
      ),
    );
    const map = (u: AppUser): UserDto => ({
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
      twoFactorEnabled: !!u.totpSecret,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      updatedAt: u.updatedAt.toISOString(),
    });
    return toPage(rows, k.limit, map, q.fields);
  }
}
