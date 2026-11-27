import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { safeName } from '../../common/safe-text';
import { NotificationService } from '../notifications/notification.service';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { cheapestPlanWith, EntitlementService } from '../entitlements/entitlement.service';
import { PLANS } from '../entitlements/plan-catalog';
import { TENANT_STATUS_DOC, TENANT_STATUS_ENUM_DOC } from '../tenants/tenant-status';
import { VersionGate } from '../../http/api-version/api-version.decorators';
import { Clock } from '../../common/clock';
import { BILLING_MANAGE_SCOPE, scopeAllows } from '@tms/domain';
import { TenantLifecycleService } from '../tenants/tenant-lifecycle.service';
import { bangkokToday, daysBetween } from '../vehicle-documents/expiry';
import { VehiclesService } from '../vehicles/vehicles.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MeTenantDto {
  @ApiProperty({ example: 'ten_…' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: TENANT_STATUS_ENUM_DOC, description: TENANT_STATUS_DOC })
  status!: string;
  @ApiProperty({ enum: ['BE', 'CE'], description: 'ปีบนเอกสาร: BE = พ.ศ., CE = ค.ศ.' })
  yearStyle!: string;
}
export class MeUserDto {
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ type: [String], description: 'ชื่อ role (ไทย) ที่ผู้ใช้ถือ' }) roles!: string[];
  @ApiProperty({ enum: ['th', 'en', 'zh'], description: 'ภาษา UI ที่ผู้ใช้เลือก (ST1-T09)' })
  locale!: string;
}
export class MePlanDto {
  @ApiProperty({ example: 'std' }) code!: string;
  @ApiProperty({ example: 'มาตรฐาน' }) name!: string;
}

export class MeImpersonationDto {
  @ApiProperty({ description: 'ชื่อทีมงาน TMS ที่เข้าใช้งานแทน' }) staffName!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ enum: ['read_only'] }) mode!: string;
}

export class MeVehicleQuotaDto {
  @ApiProperty({ description: 'รถ active เดือนนี้ (เวลาไทย — P1-ST1-T06)' }) active!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'โควตารถ (สัญญา → แพ็กเกจ) · null = ไม่จำกัด',
  })
  limit!: number | null;
}

/**
 * ข้อมูลบัญชีสำหรับแถบสถานะ (P1-ST1-T05 · spec/01 §5 PLT-050/051) — จำนวนวันคำนวณตามวันที่เวลาไทย ปัดลง
 * UI เลือกแถบเดียวตามลำดับ PLT-050 จาก `tenant.status` + ช่องเหล่านี้
 */
export class MeAccountDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) trialEndsAt!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'trialing: เหลือกี่วัน (วันที่ไทยของวันหมด − วันนี้, ≥ 0) · สถานะอื่น null',
  })
  trialDaysLeft!: number | null;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'past_due: วันครบกำหนดของใบที่ค้าง (วัน 0 ของ dunning)',
  })
  pastDueSince!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'past_due: เหลือกี่วันก่อนเป็นอ่านอย่างเดียว (ตามค่าตั้ง `dunning.pastDueDays`) · สถานะอื่น null',
  })
  readOnlyInDays!: number | null;
  @ApiProperty({ description: 'ขอยกเลิกเมื่อครบรอบแล้ว' }) cancelAtPeriodEnd!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) currentPeriodEnd!:
    string | null;
  @ApiProperty({ type: () => MeVehicleQuotaDto }) vehicles!: MeVehicleQuotaDto;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'none',
    description:
      'โปรแกรมบัญชีที่ตอบตอนสมัคร (P1-ST2-T05) — `none` = ไม่มี (UI แสดงข้อความ R-02) · null = ไม่ได้มาจากหน้าสมัคร',
  })
  accountingSoftware!: string | null;
  @ApiProperty({
    description:
      'ผู้ใช้นี้จัดการแพ็กเกจ/ชำระเงินได้ (`billing.manage` — ตอนนี้ใช้สิทธิ์ `settings:write` แทน)',
  })
  canManageBilling!: boolean;
}

export class MeBillingAdminDto {
  @ApiProperty() name!: string;
}
export class BillingNotifyResultDto {
  @ApiProperty({ description: 'จำนวนผู้ดูแลที่ได้รับแจ้ง (0 เมื่อแจ้งซ้ำภายใน 24 ชม.)' })
  notified!: number;
  @ApiProperty({ description: 'แจ้งไปแล้วภายใน 24 ชม. — ไม่ส่งซ้ำ' }) alreadyRequested!: boolean;
}
const NOTIFY_DEDUPE_MS = 24 * 3600e3;
let hasSignupTable: boolean | null = null;
export class MeBillingAdminListDto {
  @ApiProperty({ type: [MeBillingAdminDto] }) data!: MeBillingAdminDto[];
}

export class MeDto {
  @ApiProperty({
    type: () => MeImpersonationDto,
    nullable: true,
    description: 'กำลังเข้าใช้งานแทน (ST1-T24) — UI แสดงแถบส้มตลอดเวลา (spec/01 §5 banner)',
  })
  impersonation!: MeImpersonationDto | null;

  @ApiProperty({ description: 'ผู้ใช้หรือ API key ที่เรียก (sub)' }) actorId!: string;
  @ApiProperty({ type: [String] }) scopes!: string[];
  @ApiProperty({ type: MeTenantDto }) tenant!: MeTenantDto;
  @ApiProperty({
    type: MeUserDto,
    nullable: true,
    description: 'ผู้ใช้ที่ login (null เมื่อเรียกด้วย API key/token ที่ไม่ใช่ผู้ใช้)',
  })
  user!: MeUserDto | null;

  @ApiProperty({
    type: [String],
    example: ['so', 'bill', 'sub'],
    description: 'ฟีเจอร์ที่เปิดในแพ็กเกจ/override ของ tenant (ST1-T18) — UI ซ่อนเมนูที่ปิด',
  })
  features!: string[];

  @ApiProperty({ type: () => MePlanDto, description: 'แพ็กเกจปัจจุบัน' })
  plan!: MePlanDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { multi: 'องค์กร' },
    description:
      'ฟีเจอร์ที่ยังไม่มี → ชื่อแพ็กเกจแรกที่รวมไว้ (หน้า "ไม่รวมในแพ็กเกจ" — spec/01 PLT-076)',
  })
  lockedIn!: Record<string, string>;

  @ApiProperty({ type: () => MeAccountDto, description: 'ข้อมูลแถบสถานะบัญชี (P1-ST1-T05)' })
  account!: MeAccountDto;
}

/** ข้อมูลของ credential ที่เรียกอยู่ (docs/01 §5.2 #15) — UI ใช้แสดง shell */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly lifecycle: TenantLifecycleService,
    private readonly vehicles: VehiclesService,
    private readonly notifications: NotificationService,
  ) {}

  @Get()
  @VersionGate('tenant.status_lifecycle') // P1-ST1-T03 — client เก่าได้สถานะ 4 ค่าเดิม
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
    const ent = await this.entitlements.resolve(ctx.tenantId!);
    const features = Object.entries(ent)
      .filter(([, e]) => e.enabled)
      .map(([k]) => k)
      .sort();
    const plans = await this.db.tx.plan.findMany();
    const order = PLANS.map((p) => p.code).filter((c) => plans.some((p) => p.code === c));
    const first = await cheapestPlanWith(this.db.tx as never, order);
    const name = (code: string) => plans.find((p) => p.code === code)?.nameTh ?? code;
    const lockedIn = Object.fromEntries(
      Object.entries(first)
        .filter(([f]) => !features.includes(f))
        .map(([f, code]) => [f, name(code)]),
    );
    const imp = ctx.impersonationSessionId
      ? await this.prisma.platform.impersonationSession.findUnique({
          where: { id: ctx.impersonationSessionId },
          include: { platformUser: { select: { name: true } } },
        })
      : null;
    const account = await this.account(t, ent.veh?.limit ?? null, ctx.scopes ?? []);
    return {
      account,
      impersonation: imp
        ? {
            staffName: imp.platformUser.name,
            expiresAt: imp.expiresAt.toISOString(),
            mode: imp.mode,
          }
        : null,
      features,
      plan: { code: t.planCode, name: name(t.planCode) },
      lockedIn,
      user: u
        ? { name: u.name, email: u.email, roles: roles.map((r) => r.nameTh), locale: u.locale }
        : null,
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

  /**
   * ผู้ดูแลที่จัดการแพ็กเกจ/ชำระเงินได้ (spec/01 §5 ข้อ 8) — dialog "แจ้งผู้ดูแลระบบ" แสดงชื่ออย่างเดียว (PDPA: ไม่ส่งอีเมล)
   * เฉพาะผู้ใช้ที่ login ของบริษัท (token คนขับ/ลิงก์/API client → 403) [DECISION — lead 28 พ.ย. 2569, ย้อนได้]
   */
  @Get('billing-admins')
  @ApiOkResponse({ type: MeBillingAdminListDto })
  async billingAdmins(): Promise<MeBillingAdminListDto> {
    await this.requireAppUser();
    const users = await this.db.tx.appUser.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        id: { in: await this.billingAdminIds() },
      },
      orderBy: { name: 'asc' },
      select: { name: true },
    });
    return { data: users.map((u) => ({ name: safeName(u.name) })) };
  }

  /**
   * "แจ้งผู้ดูแลระบบ" จากแถบสถานะ — แจ้งในแอป + อีเมล ถึงผู้มีสิทธิ์จัดการแพ็กเกจ (ไม่รวมผู้ขอ) ·
   * ผู้ใช้คนเดิมกดซ้ำภายใน 24 ชม. = ไม่ส่งซ้ำ (แบบเดียวกับ feature-requests ของ P1-ST1-T02)
   */
  @Post('billing-admins/notify')
  @HttpCode(200)
  @ApiOkResponse({ type: BillingNotifyResultDto })
  async notifyBillingAdmins(): Promise<BillingNotifyResultDto> {
    const ctx = requestContext.require();
    const u = await this.requireAppUser();
    const t = await this.db.tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId! },
      select: { id: true, status: true, pastDueSince: true, dunningKind: true },
    });
    await this.db.tx
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing-attention:${ctx.tenantId}:${u.id}`}))`;
    const dup = await this.db.tx.notification.findFirst({
      where: {
        tenantId: ctx.tenantId!,
        templateCode: 'billing.attention_requested',
        createdAt: { gt: new Date(this.clock.now().getTime() - NOTIFY_DEDUPE_MS) },
        payload: { path: ['requesterId'], equals: u.id },
      },
      select: { id: true },
    });
    if (dup) return { notified: 0, alreadyRequested: true };
    const notified = await this.notifications.notify(this.db.tx, {
      tenantId: ctx.tenantId!,
      to: { permissions: [BILLING_MANAGE_SCOPE], exclude: [u.id] },
      template: 'billing.attention_requested',
      vars: {
        requester: safeName(u.name),
        status: t.status.toLowerCase(),
        requesterId: u.id,
      },
      link: '/billing',
    });
    return { notified, alreadyRequested: false };
  }

  /** ผู้ใช้จริงของบริษัทเท่านั้น (ไม่ใช่ API client / คนขับ / ลิงก์) */
  private async requireAppUser() {
    const ctx = requestContext.require();
    if (ctx.principalType && !['user', 'dev'].includes(ctx.principalType))
      throw new ProblemException('forbidden');
    const u = UUID.test(ctx.actorId ?? '')
      ? await this.db.tx.appUser.findFirst({
          where: { id: ctx.actorId!, status: 'ACTIVE', deletedAt: null },
        })
      : null;
    if (!u) throw new ProblemException('forbidden');
    return u;
  }

  private async billingAdminIds(): Promise<string[]> {
    const roles = await this.db.tx.role.findMany({ select: { id: true, permissions: true } });
    const ids = roles
      .filter((r) => scopeAllows(r.permissions, BILLING_MANAGE_SCOPE))
      .map((r) => r.id);
    if (!ids.length) return [];
    return (
      await this.db.tx.userRole.findMany({
        where: { roleId: { in: ids } },
        select: { userId: true },
      })
    ).map((r) => r.userId);
  }

  private async account(
    t: {
      id: string;
      status: string;
      pastDueSince: Date | null;
      dunningKind: string | null;
      vehicleQuota: number | null;
    },
    planVehicleLimit: number | null,
    scopes: readonly string[],
  ): Promise<MeAccountDto> {
    const today = bangkokToday(this.clock.now());
    const since = t.pastDueSince ? t.pastDueSince.toISOString().slice(0, 10) : null;
    const pastDue = t.status === 'PAST_DUE';
    const [sub, active, accountingSoftware, dunning] = await Promise.all([
      this.db.tx.subscription.findUnique({
        where: { tenantId: t.id },
        select: { trialEndsAt: true, cancelAtPeriodEnd: true, currentPeriodEnd: true },
      }),
      this.vehicles.activeThisMonth(),
      this.accountingSoftware(t.id),
      pastDue && since && t.dunningKind === 'invoice' ? this.lifecycle.dunningSettings() : null,
    ]);
    const trialDaysLeft =
      t.status === 'TRIALING' && sub?.trialEndsAt
        ? Math.max(0, daysBetween(today, bangkokToday(sub.trialEndsAt)))
        : null;
    // past_due ที่ไม่มีวัน 0 ของใบ (ทีมงานตั้งเอง) → null: UI ใช้หัวข้อแบบไม่มีจำนวนวัน
    const readOnlyInDays =
      dunning && since ? Math.max(0, dunning.pastDueDays + 1 - daysBetween(since, today)) : null;
    return {
      trialEndsAt: sub?.trialEndsAt?.toISOString() ?? null,
      trialDaysLeft,
      pastDueSince: pastDue ? since : null,
      readOnlyInDays,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
      vehicles: { active, limit: t.vehicleQuota ?? planVehicleLimit },
      accountingSoftware,
      canManageBilling: scopeAllows(scopes, BILLING_MANAGE_SCOPE),
    };
  }

  /**
   * R-02 — คำตอบ "โปรแกรมบัญชี" ตอนสมัคร อยู่ในตาราง `tenant_signup` ของ P1-ST2-T05 (branch ที่ยังไม่ merge)
   * TODO P1-ST2-T05: เปลี่ยนเป็น `this.db.tx.tenantSignup.findUnique` เมื่อ migration ของตารางนั้นเข้า main
   * — ตอนนี้อ่านด้วย SQL เมื่อมีตารางแล้วเท่านั้น (ยังไม่มี = null)
   */
  private async accountingSoftware(tenantId: string): Promise<string | null> {
    if (hasSignupTable === null) {
      const [has] = await this.db.tx.$queryRaw<{ t: string | null }[]>`
        SELECT to_regclass('tenant_signup')::text AS t`;
      hasSignupTable = !!has?.t; // ต่อ process — migration ใหม่มาพร้อม deploy/restart
    }
    if (!hasSignupTable) return null;
    const [row] = await this.db.tx.$queryRaw<{ a: string | null }[]>`
      SELECT accounting_software AS a FROM tenant_signup WHERE tenant_id = ${tenantId}::uuid`;
    return row?.a ?? null;
  }
}
