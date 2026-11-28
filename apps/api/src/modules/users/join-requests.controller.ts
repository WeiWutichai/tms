import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { TenantJoinRequest } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../../audit/audit.service';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { EmailService } from '../email/email.service';
import { notifyJoinApplicant } from '../signup/join-request';

export class JoinRequestDto {
  @ApiProperty({ example: 'jrq_…' }) id!: string;
  @ApiProperty() applicantName!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true, type: String }) mobile!: string | null;
  @ApiProperty() branchCode!: string;
  @ApiProperty({
    enum: ['pending_owner', 'pending'],
    description:
      'pending_owner = รอผู้ดูแลระบบตัดสิน · pending = เลย 3 วันทำการแล้ว ทีมงาน TMS ตรวจแทน (ยังตัดสินเองได้)',
  })
  status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) ownerDueAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class JoinRequestListDto {
  @ApiProperty({ type: [JoinRequestDto] }) data!: JoinRequestDto[];
}
export class DeclineJoinRequestDto {
  @ApiProperty({
    example: 'ไม่ใช่พนักงานของบริษัท',
    minLength: 10,
    description: 'เหตุผล (ส่งถึงผู้ขอทางอีเมล + ลง audit)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

const OWNER_VISIBLE = ['pending_owner', 'pending'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * คำขอเข้าร่วมบริษัท (P1-ST2-T06; spec/01 PLT-107) ฝั่งผู้ดูแลระบบของบริษัท — ผู้สมัครที่ค้นเจอเลขผู้เสียภาษีซ้ำกด "ส่งคำขอเข้าร่วมบริษัท"
 * - ดู: `users:read` · ปฏิเสธ: `users:write` + เหตุผล ≥ 10 ตัว (อีเมลถึงผู้ขอ + audit)
 * - อนุมัติ = เชิญผู้ขอด้วย `POST /v1/users/invitations` (อีเมลเดียวกัน — เลือกบทบาท + ยืนยัน 2FA ตามการเชิญปกติ) → คำขอเป็น approved อัตโนมัติ
 * - ไม่ตัดสินใน 3 วันทำการ → ทีมงาน TMS ตรวจในคิวอนุมัติ (ยังตัดสินเองได้จนกว่าจะมีผู้ตัดสิน) · "ติดต่อเรา" ไม่แสดงที่นี่ (ทีมงานตรวจ)
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users/join-requests')
export class JoinRequestsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  @Get()
  @RequireScope('users:read')
  @ApiOkResponse({ type: JoinRequestListDto })
  async list(): Promise<JoinRequestListDto> {
    const rows = await this.db.tx.tenantJoinRequest.findMany({
      where: { kind: 'join', status: { in: OWNER_VISIBLE } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return { data: rows.map(toDto) };
  }

  @Post(':id/decline')
  @HttpCode(204)
  @TenantResource('joinRequest')
  @RequireScope('users:write')
  async decline(@Param('id') id: string, @Body() body: DeclineJoinRequestDto): Promise<void> {
    const tx = this.db.tx;
    const rid = decodeIdOr404('joinRequest', id);
    await tx.$queryRaw`SELECT id FROM tenant_join_request WHERE id = ${rid}::uuid FOR UPDATE`;
    const j = await tx.tenantJoinRequest.findUnique({ where: { id: rid } });
    if (!j || j.kind !== 'join') throw new ProblemException('not_found');
    if (!OWNER_VISIBLE.includes(j.status)) throw new ProblemException('invalid_state_transition');
    const ctx = requestContext.require();
    await tx.tenantJoinRequest.update({
      where: { id: j.id },
      data: {
        status: 'rejected',
        reason: body.reason,
        decidedByType: 'tenant_user',
        decidedBy: ctx.actorId && UUID.test(ctx.actorId) ? ctx.actorId : null,
        decidedAt: new Date(),
      },
    });
    await this.audit.record({
      action: 'tenant.join_request_declined',
      entityType: 'join_request',
      entityId: j.id,
      before: { status: j.status },
      after: { status: 'rejected' },
      reason: body.reason,
    });
    await notifyJoinApplicant(tx, this.email, j, 'rejected', body.reason);
  }
}

const toDto = (j: TenantJoinRequest): JoinRequestDto => ({
  id: encodeId('joinRequest', j.id),
  applicantName: j.applicantName,
  email: j.email,
  mobile: j.mobile,
  branchCode: j.branchCode,
  status: j.status,
  ownerDueAt: j.ownerDueAt?.toISOString() ?? null,
  createdAt: j.createdAt.toISOString(),
});
