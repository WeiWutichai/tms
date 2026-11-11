import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { AppUser, Role, UserInvitation } from '@prisma/client';
import { ROLE_CODES } from '@tms/domain';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { AuditService } from '../../audit/audit.service';
import { safeName } from '../../common/safe-text';
import { webBaseUrl } from '../../auth/password-reset.controller';
import { newOpaqueToken } from '../../auth/tokens';
import { RequireScope, RequireStepUp, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { EmailService } from '../email/email.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { ReasonDto } from './user-lifecycle.controller';

/** docs/04 A2: ลิงก์เชิญ 7 วัน */
export const INVITE_TTL_DAYS = 7;
/** กันใช้ระบบเป็นช่องส่งอีเมลขยะ/ฟิชชิง: เชิญ+ส่งใหม่ได้ 50 ฉบับ/วัน/บริษัท, ส่งใหม่ฉบับเดิมห่างกัน ≥ 60 วิ */
export const INVITES_PER_DAY = 50;
export const RESEND_COOLDOWN_S = 60;

/** นับ seat (ACTIVE + INVITED) เทียบ entitlement `users` — ล็อกต่อ tenant ให้นับพร้อมกันถูก (ใช้ทั้งเชิญและเปิดใช้คืน) */
export async function assertSeat(tx: Tx, entitlements: EntitlementService, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(6, hashtext(${tenantId}))`;
  const limit = (await entitlements.resolve(tenantId)).users?.limit ?? null;
  if (limit === null) return;
  const used = await tx.appUser.count({ where: { status: { in: ['ACTIVE', 'INVITED'] } } });
  if (used >= limit)
    throw new ProblemException('seat_limit_reached', undefined, undefined, { limit });
}

/** อีเมลจริงของผู้ใช้ที่ลบ/เพิกถอน → ค่า anonymize (PDPA) — ใช้ร่วมกับ users/:id/delete */
export const anonymizedEmail = (userId: string) => `deleted-${userId}@deleted.invalid`;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateInvitationDto {
  @ApiProperty({ example: 'somchai@company.co.th' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'สมชาย ใจดี', description: 'ชื่อที่แสดง (ผู้รับแก้ได้ตอนรับคำเชิญ)' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ type: [String], example: ['planner'], description: 'role code ระบบ (ตาราง A3)' })
  @ArrayMinSize(1)
  @ArrayMaxSize(9)
  @ArrayUnique()
  @IsIn([...ROLE_CODES], { each: true })
  roles!: string[];
}

export class InvitationDto {
  @ApiProperty({ example: 'inv_…' }) id!: string;
  @ApiProperty({ example: 'usr_…' }) userId!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty({ enum: ['pending', 'expired'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class InvitationListDto {
  @ApiProperty({ type: [InvitationDto] }) data!: InvitationDto[];
}

/**
 * เชิญผู้ใช้ (ST1-T07; docs/04 A2; spec/01 §3 PLT-035) — เชิญ = สร้างผู้ใช้สถานะ INVITED พร้อม role + ส่งอีเมลลิงก์ 7 วัน
 * กำหนด role ตอนเชิญ = มอบสิทธิ์ → ต้อง step-up 2FA (เหมือนเปลี่ยน role — A3) · มอบ owner ได้เฉพาะ owner
 * นับ seat ตาม entitlement `users` ของแพ็กเกจ (limit null = ไม่จำกัด — plan/00b "user ไม่จำกัด")
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users/invitations')
export class InvitationsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly entitlements: EntitlementService,
  ) {}

  @Post()
  @RequireScope('users:write')
  @RequireStepUp()
  @ApiHeader({
    name: 'X-Step-Up',
    required: true,
    description: 'stepUpToken จาก POST /v1/auth/step-up',
  })
  @ApiCreatedResponse({ type: InvitationDto })
  @ApiConflictResponse({ description: 'already_member / seat_limit_reached (มี `limit`)' })
  async create(@Body() body: CreateInvitationDto): Promise<InvitationDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const tenantId = ctx.tenantId!;
    // ล็อกต่อ tenant (ใน assertSeat) — นับ seat และกันเชิญอีเมลเดียวกันพร้อมกัน
    await assertSeat(tx, this.entitlements, tenantId);
    await this.assertDailyCap(tx);
    const existing = await tx.appUser.findFirst({
      where: { email: { equals: body.email, mode: 'insensitive' }, status: { not: 'DELETED' } },
    });
    if (existing)
      throw new ProblemException('already_member', undefined, undefined, {
        userId: encodeId('user', existing.id),
        userStatus: existing.status.toLowerCase(),
      });
    const roles = await tx.role.findMany({ where: { code: { in: body.roles } } });
    await this.guardOwnerGrant(tx, roles);
    const user = await tx.appUser.create({
      data: { tenantId, email: body.email, name: body.name, status: 'INVITED', locale: 'th' },
    });
    await tx.userRole.createMany({
      data: roles.map((r) => ({ tenantId, userId: user.id, roleId: r.id })),
    });
    const inv = await this.issue(tx, user, roles);
    await this.audit.record({
      action: 'user.invited',
      entityType: 'user',
      entityId: user.id,
      // ไม่เก็บอีเมลใน audit (append-only ลบไม่ได้ — PDPA); อ้างผู้ใช้ด้วย entityId
      after: { roles: [...body.roles].sort(), invitationId: inv.id },
    });
    return this.toDto(inv, user, roles);
  }

  @Get()
  @RequireScope('users:read')
  @ApiOkResponse({ type: InvitationListDto })
  async list(): Promise<InvitationListDto> {
    const tx = this.db.tx;
    const rows = await tx.userInvitation.findMany({
      where: { acceptedAt: null, revokedAt: null, user: { status: 'INVITED' } },
      orderBy: { createdAt: 'desc' },
      include: { user: true },
    });
    const links = await tx.userRole.findMany({
      where: { userId: { in: rows.map((r) => r.userId) } },
    });
    const roles = await tx.role.findMany({ where: { id: { in: links.map((l) => l.roleId) } } });
    return {
      data: rows.map((r) =>
        this.toDto(
          r,
          r.user,
          roles.filter((x) => links.some((l) => l.userId === r.userId && l.roleId === x.id)),
        ),
      ),
    };
  }

  /** ส่งใหม่ — ลิงก์เดิมใช้ไม่ได้ทันที, อายุใหม่ 7 วัน */
  @Post(':id/resend')
  @HttpCode(200)
  @TenantResource('invitation')
  @RequireScope('users:write')
  @ApiOkResponse({ type: InvitationDto })
  async resend(@Param('id') id: string): Promise<InvitationDto> {
    const tx = this.db.tx;
    const { inv, user } = await this.open(id);
    const wait = Math.ceil(RESEND_COOLDOWN_S - (Date.now() - inv.createdAt.getTime()) / 1000);
    if (wait > 0)
      throw new ProblemException('rate_limited', undefined, undefined, { retryAfter: wait });
    await this.assertDailyCap(tx);
    await tx.userInvitation.update({
      where: { id: inv.id },
      data: { revokedAt: new Date(), revokedReason: 'resent' },
    });
    const roles = await this.rolesOf(tx, user.id);
    const next = await this.issue(tx, user, roles);
    await this.audit.record({
      action: 'user.invitation_resent',
      entityType: 'user',
      entityId: user.id,
      before: { invitationId: inv.id },
      after: { invitationId: next.id },
    });
    return this.toDto(next, user, roles);
  }

  /** เพิกถอนคำเชิญ (เหตุผลบังคับ) — ผู้ใช้ที่ยังไม่รับถูก anonymize ไม่แสดงในรายการ (ไม่มี hard delete) */
  @Post(':id/revoke')
  @HttpCode(204)
  @TenantResource('invitation')
  @RequireScope('users:write')
  async revoke(@Param('id') id: string, @Body() body: ReasonDto): Promise<void> {
    const tx = this.db.tx;
    const { inv, user } = await this.open(id);
    // คำเชิญที่มอบ owner เพิกถอนได้เฉพาะ owner (เหมือนลบ owner — users/:id/delete)
    await this.guardOwnerGrant(tx, await this.rolesOf(tx, user.id));
    await tx.userInvitation.update({
      where: { id: inv.id },
      data: { revokedAt: new Date(), revokedReason: body.reason },
    });
    await tx.userRole.deleteMany({ where: { userId: user.id } });
    const r = await tx.appUser.updateMany({
      where: { id: user.id, status: 'INVITED' },
      data: {
        status: 'DELETED',
        name: 'ผู้ใช้ที่ลบแล้ว',
        email: anonymizedEmail(user.id),
        deletedAt: new Date(),
        tokenVersion: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ProblemException('invalid_state_transition');
    // อีเมลจริงในประวัติคำเชิญถูกแทนด้วยค่า anonymize ด้วย
    await tx.userInvitation.updateMany({
      where: { userId: user.id },
      data: { email: anonymizedEmail(user.id) },
    });
    await this.audit.record({
      action: 'user.invitation_revoked',
      entityType: 'user',
      entityId: user.id,
      before: { invitationId: inv.id },
      reason: body.reason,
    });
  }

  /** คำเชิญที่ยังเปิดอยู่ (ไม่รับ/ไม่เพิกถอน, ผู้ใช้ยัง INVITED) — หมดอายุแล้วส่งใหม่/เพิกถอนได้ */
  private async open(id: string) {
    const tx = this.db.tx;
    const invId = decodeIdOr404('invitation', id);
    // ล็อกแถวคำเชิญก่อนอ่าน — รับคำเชิญ (claim แถวเดียวกัน) กับส่งใหม่/เพิกถอนทำทีละราย (review T07 #1)
    await tx.$queryRaw`SELECT id FROM user_invitation WHERE id = ${invId}::uuid FOR UPDATE`;
    const inv = await tx.userInvitation.findUnique({
      where: { id: invId },
      include: { user: true },
    });
    if (!inv) throw new ProblemException('not_found');
    if (inv.acceptedAt || inv.revokedAt || inv.user.status !== 'INVITED')
      throw new ProblemException('invalid_state_transition');
    return { inv, user: inv.user };
  }

  /** เชิญ + ส่งใหม่ไม่เกิน 50 ฉบับ/24 ชม./บริษัท */
  private async assertDailyCap(tx: Tx) {
    const since = new Date(Date.now() - 86400_000);
    const sent = await tx.userInvitation.count({ where: { createdAt: { gte: since } } });
    if (sent >= INVITES_PER_DAY)
      throw new ProblemException('rate_limited', undefined, undefined, { retryAfter: 3600 });
  }

  private async rolesOf(tx: Tx, userId: string): Promise<Role[]> {
    const links = await tx.userRole.findMany({ where: { userId } });
    return tx.role.findMany({ where: { id: { in: links.map((l) => l.roleId) } } });
  }

  /** มอบ owner ได้เฉพาะ owner (เหมือน PUT /users/{id}/roles) */
  private async guardOwnerGrant(tx: Tx, roles: Role[]) {
    const owner = roles.find((r) => r.code === 'owner');
    if (!owner) return;
    const actor = requestContext.require().actorId;
    const isOwner =
      !!actor &&
      /^[0-9a-f-]{36}$/i.test(actor) &&
      !!(await tx.userRole.findFirst({ where: { userId: actor, roleId: owner.id } }));
    if (!isOwner)
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'users',
        action: 'grant_owner',
        required: ['owner'],
      });
  }

  /** ออก token + ส่งอีเมล (outbox ใน transaction เดียวกัน — rollback = ไม่ส่ง) */
  private async issue(tx: Tx, user: AppUser, roles: Role[]): Promise<UserInvitation> {
    const ctx = requestContext.require();
    const by = ctx.actorId && /^[0-9a-f-]{36}$/i.test(ctx.actorId) ? ctx.actorId : null;
    return issueInvitation(tx, this.email, user, roles, by);
  }

  private toDto(inv: UserInvitation, user: AppUser, roles: Role[]): InvitationDto {
    return {
      id: encodeId('invitation', inv.id),
      userId: encodeId('user', user.id),
      email: user.email,
      name: user.name,
      roles: roles.map((r) => r.code),
      status: inv.expiresAt.getTime() <= Date.now() ? 'expired' : 'pending',
      expiresAt: inv.expiresAt.toISOString(),
      createdAt: inv.createdAt.toISOString(),
    };
  }
}

/**
 * ออกลิงก์คำเชิญ + อีเมล (ST1-T07) — ใช้ร่วมกับ Platform Console (ST1-T24 สร้าง tenant แล้วเชิญ owner)
 * invitedBy = ผู้ใช้ใน tenant (null = ทีม Innovera/ระบบ → อีเมลใช้ชื่อบริษัทเป็นผู้เชิญ)
 */
export async function issueInvitation(
  tx: Tx,
  email: EmailService,
  user: AppUser,
  roles: Role[],
  invitedBy: string | null,
): Promise<UserInvitation> {
  const { token, hash } = newOpaqueToken();
  const inv = await tx.userInvitation.create({
    data: {
      tenantId: user.tenantId,
      userId: user.id,
      email: user.email,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86400_000),
      invitedBy,
    },
  });
  const [tenant, inviter] = await Promise.all([
    tx.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } }),
    invitedBy ? tx.appUser.findUnique({ where: { id: invitedBy } }) : null,
  ]);
  await email.enqueue(tx, {
    tenantId: user.tenantId,
    to: user.email,
    template: 'user_invitation',
    locale: inviter?.locale ?? 'th',
    vars: {
      link: `${webBaseUrl()}/invite#token=${token}`,
      days: INVITE_TTL_DAYS,
      tenantName: safeName(tenant?.name ?? ''),
      inviterName: safeName(inviter?.name ?? tenant?.name ?? ''),
      roles: roles.map((r) => r.nameTh).join(', '),
    },
  });
  return inv;
}
