import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { safeName } from '../../common/safe-text';
import { NotificationService } from '../notifications/notification.service';
import { DbService } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { cheapestPlanWith, EntitlementService } from '../entitlements/entitlement.service';
import { currentPlanVersions, PLANS } from '../entitlements/plan-catalog';

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
  @ApiProperty({ enum: ['th', 'en', 'zh'], description: 'ภาษา UI ที่ผู้ใช้เลือก (ST1-T09)' })
  locale!: string;
}
export class MePlanDto {
  @ApiProperty({ example: 'std' }) code!: string;
  @ApiProperty({ example: 'มาตรฐาน' }) name!: string;
}

/** โมดูลที่ไม่รวมในแพ็กเกจ (P1-ST1-T02; spec/01 PLT-076) — ข้อมูลของหน้าแนะนำโมดูล (ต้นแบบ v4 `lkp`) */
export class MeLockDto {
  @ApiProperty({
    example: 'std',
    nullable: true,
    type: String,
    description: 'แพ็กเกจแรก (ถูกไปแพง) ที่รวมฟีเจอร์นี้ · null = ไม่มีแพ็กเกจใดรวมไว้',
  })
  planCode!: string | null;
  @ApiProperty({ example: 'Growth', nullable: true, type: String }) planName!: string | null;
  @ApiProperty({
    example: '280.00',
    nullable: true,
    type: String,
    description:
      'ราคา/รถ active/เดือน ก่อน VAT ของเวอร์ชันที่มีผลของแพ็กเกจนั้น · null = ตกลงราคา (ติดต่อฝ่ายขาย)',
  })
  pricePerVehicleMonthly!: string | null;
  @ApiProperty({
    description: 'แพ็กเกจปัจจุบันขายฟีเจอร์นี้เป็น add-on (ปุ่ม "ซื้อ Add-on" แทน "อัปเกรด")',
  })
  addon!: boolean;
  @ApiProperty({
    enum: ['not_in_plan', 'revoked'],
    description:
      'not_in_plan = แพ็กเกจไม่รวม (อัปเกรด/ซื้อ add-on) · revoked = แพ็กเกจรวมอยู่แต่ผู้ให้บริการปิดสิทธิ์ให้ tenant นี้ (override) — ' +
      'ไม่มีแพ็กเกจให้อัปเกรด (planCode/planName/ราคา = null) ติดต่อทีมงานผู้ให้บริการ',
  })
  reason!: 'not_in_plan' | 'revoked';
}

export class MeImpersonationDto {
  @ApiProperty({ description: 'ชื่อทีมงาน TMS ที่เข้าใช้งานแทน' }) staffName!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ enum: ['read_only'] }) mode!: string;
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
      '[deprecated — ใช้ `locks` แทน; คงไว้เพื่อไม่ breaking] ' +
      'ฟีเจอร์ที่ยังไม่มี → ชื่อแพ็กเกจแรกที่รวมไว้ (หน้า "ไม่รวมในแพ็กเกจ" — spec/01 PLT-076)',
  })
  lockedIn!: Record<string, string>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: getSchemaPath(MeLockDto) },
    description:
      'P1-ST1-T02: ฟีเจอร์ที่ไม่รวมในแพ็กเกจ (หลัง add-on/override ก่อนตัดตามสถานะ) → เมนูขึ้น 🔒 + หน้าแนะนำโมดูล (PLT-076) · ' +
      'ฟีเจอร์พื้นฐาน (isBasic) ไม่อยู่ที่นี่ทุกกรณี (PLT-077)',
  })
  locks!: Record<string, MeLockDto>;
}

export class FeatureRequestDto {
  @ApiProperty({
    example: 'report',
    description: 'featureKey ของโมดูลที่ไม่รวมในแพ็กเกจ (จาก `locks` ของ GET /me)',
  })
  @IsString()
  @Matches(/^[a-z0-9_.]{1,40}$/)
  featureKey!: string;
}
export class FeatureRequestResultDto {
  @ApiProperty({ description: 'จำนวนผู้ดูแลระบบที่ได้รับแจ้ง (0 เมื่อแจ้งซ้ำภายใน 24 ชม.)' })
  notified!: number;
  @ApiProperty({ description: 'แจ้งโมดูลนี้ไปแล้วภายใน 24 ชม. — ไม่ส่งซ้ำ' })
  alreadyRequested!: boolean;
}

/** ผู้ที่ได้รับแจ้งเมื่อผู้ใช้ขอโมดูลที่ไม่รวมในแพ็กเกจ — สิทธิ์จัดการแพ็กเกจ (`billing.manage` มากับ P1-ST3-T03) ระหว่างนี้ใช้ `settings:write` (owner/admin) */
export const BILLING_MANAGE_STANDIN = 'settings:write';
const REQUEST_DEDUPE_MS = 24 * 3600e3;

/** ข้อมูลของ credential ที่เรียกอยู่ (docs/01 §5.2 #15) — UI ใช้แสดง shell */
@ApiTags('platform')
@ApiBearerAuth()
@ApiExtraModels(MeLockDto)
@Controller('me')
export class MeController {
  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  /**
   * "แจ้งผู้ดูแลระบบ" จากหน้าแนะนำโมดูลที่ไม่รวมในแพ็กเกจ (P1-ST1-T02; spec/01 PLT-076) — สำหรับผู้ไม่มีสิทธิ์จัดการแพ็กเกจ
   * แจ้งในแอป + อีเมล ถึงผู้มีสิทธิ์จัดการแพ็กเกจ (ดู BILLING_MANAGE_STANDIN) · ผู้ใช้คนเดิมขอโมดูลเดิมซ้ำภายใน 24 ชม. = ไม่ส่งซ้ำ
   * ใช้ได้เฉพาะผู้ใช้ที่ login (API key ไม่มีหน้าจอ) · ฟีเจอร์ที่ไม่ได้ล็อก → 422
   */
  @Post('feature-requests')
  @HttpCode(200)
  @ApiOkResponse({ type: FeatureRequestResultDto })
  async requestFeature(@Body() body: FeatureRequestDto): Promise<FeatureRequestResultDto> {
    const ctx = requestContext.require();
    const u = UUID.test(ctx.actorId ?? '')
      ? await this.db.tx.appUser.findFirst({ where: { id: ctx.actorId! } })
      : null;
    if (!u) throw new ProblemException('forbidden');
    const f = await this.db.tx.feature.findUnique({ where: { key: body.featureKey } });
    const ent = await this.entitlements.detail(ctx.tenantId!);
    const locked = !!f && !ent.basic.includes(f.key) && !ent.beforeStatus[f.key]?.enabled;
    if (!f || !locked)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'featureKey',
          code: f ? 'not_locked' : 'unknown_feature',
          message: f ? 'feature is already in plan' : 'unknown feature',
        },
      ]);
    // กันกดพร้อมกันหลายครั้งแล้วส่งซ้ำ (review L3) — ล็อกต่อ tenant+ผู้ขอ+ฟีเจอร์ จนจบ transaction ของคำขอ
    await this.db.tx
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`feature-request:${ctx.tenantId}:${u.id}:${f.key}`}))`;
    const dup = await this.db.tx.notification.findFirst({
      where: {
        tenantId: ctx.tenantId!,
        templateCode: 'feature.upgrade_requested',
        createdAt: { gt: new Date(this.clock.now().getTime() - REQUEST_DEDUPE_MS) },
        AND: [
          { payload: { path: ['featureKey'], equals: f.key } },
          { payload: { path: ['requesterId'], equals: u.id } },
        ],
      },
      select: { id: true },
    });
    if (dup) return { notified: 0, alreadyRequested: true };
    const notified = await this.notifications.notify(this.db.tx, {
      tenantId: ctx.tenantId!,
      to: { permissions: [BILLING_MANAGE_STANDIN], exclude: [u.id] },
      template: 'feature.upgrade_requested',
      vars: {
        feature: f.nameTh,
        requester: safeName(u.name),
        featureKey: f.key,
        requesterId: u.id,
      },
      link: '/settings/billing',
    });
    return { notified, alreadyRequested: false };
  }

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
    const ent = await this.entitlements.detail(ctx.tenantId!);
    const features = Object.entries(ent.effective)
      .filter(([, e]) => e.enabled)
      .map(([k]) => k)
      .sort();
    const plans = await this.db.tx.plan.findMany();
    const order = PLANS.map((p) => p.code).filter((c) => plans.some((p) => p.code === c));
    const first = await cheapestPlanWith(this.db.tx as never, order);
    const name = (code: string) => plans.find((p) => p.code === code)?.nameTh ?? code;
    const versions = await currentPlanVersions(this.db.tx as never);
    // P1-ST1-T02: 🔒 = ไม่มีในแพ็กเกจ+add-on+override (ก่อนตัดตามสถานะ) และไม่ใช่ฟีเจอร์พื้นฐาน (PLT-076/077)
    const catalog = await this.db.tx.feature.findMany({
      select: { key: true },
      orderBy: { key: 'asc' },
    });
    const locks: Record<string, MeLockDto> = {};
    for (const { key } of catalog) {
      if (ent.basic.includes(key) || ent.beforeStatus[key]?.enabled) continue;
      // แพ็กเกจรวมอยู่แล้วแต่ถูก override ปิด → ไม่ชี้ไปแพ็กเกจอื่น (กันแนะนำ "อัปเกรด" ไปแพ็กเกจที่ถูกกว่า — review M1)
      if (ent.planModes[key] === 'included') {
        locks[key] = {
          planCode: null,
          planName: null,
          pricePerVehicleMonthly: null,
          addon: false,
          reason: 'revoked',
        };
        continue;
      }
      const code = first[key] ?? null;
      const price = code ? versions.get(code)?.pricePerVehicleMonthly : null;
      locks[key] = {
        planCode: code,
        planName: code ? name(code) : null,
        pricePerVehicleMonthly: price ? price.toFixed(2) : null,
        addon: ent.planModes[key] === 'addon',
        reason: 'not_in_plan',
      };
    }
    const lockedIn = Object.fromEntries(
      Object.entries(locks)
        .filter(([, l]) => l.planName)
        .map(([f, l]) => [f, l.planName!]),
    );
    const imp = ctx.impersonationSessionId
      ? await this.prisma.platform.impersonationSession.findUnique({
          where: { id: ctx.impersonationSessionId },
          include: { platformUser: { select: { name: true } } },
        })
      : null;
    return {
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
      locks,
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
}
