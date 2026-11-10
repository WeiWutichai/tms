import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MeTenantDto {
  @ApiProperty({ example: 'ten_…' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['trial', 'active', 'suspended', 'cancelled'] }) status!: string;
  @ApiProperty({ enum: ['BE', 'CE'], description: 'ปีบนเอกสาร: BE = พ.ศ., CE = ค.ศ.' })
  yearStyle!: string;
}
export class MeUserDto {
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ type: [String], description: 'ชื่อ role (ไทย) ที่ผู้ใช้ถือ' }) roles!: string[];
}
export class MeDto {
  @ApiProperty({ description: 'ผู้ใช้หรือ API key ที่เรียก (sub)' }) actorId!: string;
  @ApiProperty({ type: [String] }) scopes!: string[];
  @ApiProperty({ type: MeTenantDto }) tenant!: MeTenantDto;
  @ApiProperty({
    type: MeUserDto,
    nullable: true,
    description: 'ผู้ใช้ที่ login (null เมื่อเรียกด้วย API key/token ที่ไม่ใช่ผู้ใช้)',
  })
  user!: MeUserDto | null;
}

/** ข้อมูลของ credential ที่เรียกอยู่ (docs/01 §5.2 #15) — UI ใช้แสดง shell */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly db: DbService) {}

  @Get()
  @ApiOkResponse({ type: MeDto })
  async me(): Promise<MeDto> {
    const ctx = requestContext.require();
    const t = await this.db.tx.tenant.findUnique({ where: { id: ctx.tenantId! } });
    if (!t) throw new ProblemException('unauthorized');
    const u = UUID.test(ctx.actorId!)
      ? await this.db.tx.appUser.findFirst({ where: { id: ctx.actorId! } })
      : null;
    const roles = u
      ? await this.db.tx.role.findMany({
          where: {
            id: {
              in: (await this.db.tx.userRole.findMany({ where: { userId: u.id } })).map(
                (r) => r.roleId,
              ),
            },
          },
          orderBy: { code: 'asc' },
        })
      : [];
    return {
      user: u ? { name: u.name, email: u.email, roles: roles.map((r) => r.nameTh) } : null,
      actorId: ctx.actorId!,
      scopes: ctx.scopes ?? [],
      tenant: {
        id: encodeId('tenant', t.id),
        name: t.name,
        status: t.status.toLowerCase(),
        yearStyle: t.yearStyle,
      },
    };
  }
}
