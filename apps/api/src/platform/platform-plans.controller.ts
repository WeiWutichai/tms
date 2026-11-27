import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { Feature, Plan, PlanEntitlement, PlanVersion, Prisma } from '@prisma/client';
import {
  basicFeatureViolations,
  ENTITLEMENT_MODES,
  planPricingErrors,
  type EntitlementMode,
  type PlanPricingInput,
  type VolumeTier,
} from '@tms/domain';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PlatformAuth } from '../common/decorators';
import { expectedVersion, setEtag } from '../common/etag';
import { decodeIdOr404, encodeId } from '../common/ids';
import { ProblemException, type FieldError } from '../common/problem';
import { requestContext } from '../common/request-context';
import { PrismaService } from '../db/prisma.service';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { platformAudit } from './platform-audit';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** เงิน numeric(14,2): ทศนิยม ≤ 2 (ตรวจละเอียดด้วย planPricingErrors ของ @tms/domain) */
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
const PCT_RE = /^\d{1,3}(\.\d{1,2})?$/;

export class VolumeTierDto {
  @ApiProperty({ example: 51, description: 'คันที่เริ่มได้ส่วนลด (รวมคันนี้)' })
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(1_000_000)
  fromVehicle!: number;
  @ApiProperty({ example: '10.00', description: 'ส่วนลด % (0–100 ทศนิยม ≤ 2)' })
  @IsString()
  @Matches(PCT_RE)
  discountPct!: string;
}

export class PlanEntitlementDto {
  @ApiProperty({ example: 'settle' }) featureKey!: string;
  @ApiProperty({ enum: ENTITLEMENT_MODES }) mode!: EntitlementMode;
  @ApiProperty({ nullable: true, type: Number, description: 'null = ไม่จำกัด' }) limit!:
    number | null;
}

export class PlanEntitlementInputDto {
  @ApiProperty({ example: 'report' })
  @IsString()
  @Matches(/^[a-z0-9_.]{1,40}$/)
  featureKey!: string;
  @ApiProperty({ enum: ENTITLEMENT_MODES })
  @IsIn(ENTITLEMENT_MODES)
  mode!: EntitlementMode;
  @ApiPropertyOptional({ nullable: true, type: Number, description: 'null/ไม่ส่ง = ไม่จำกัด' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  limit?: number | null;
}

/** ช่องที่แก้ได้ของเวอร์ชัน draft — ไม่ส่ง = คงค่าเดิม (สร้างใหม่ = คัดจากเวอร์ชันที่มีผล) */
export class PlanVersionInputDto {
  @ApiPropertyOptional({
    example: '350.00',
    nullable: true,
    type: String,
    description: 'บาท/รถ active/เดือน ก่อน VAT — null = ตกลงราคา',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(MONEY_RE)
  pricePerVehicleMonthly?: string | null;
  @ApiPropertyOptional({ example: '2500.00', nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(MONEY_RE)
  minimumMonthly?: string | null;
  @ApiPropertyOptional({ example: '15.00', description: 'ส่วนลดรายปี %' })
  @IsOptional()
  @IsString()
  @Matches(PCT_RE)
  annualDiscountPct?: string;
  @ApiPropertyOptional({ type: [VolumeTierDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VolumeTierDto)
  volumeTiers?: VolumeTierDto[];
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  vehicleMin?: number;
  @ApiPropertyOptional({
    example: 15,
    nullable: true,
    type: Number,
    description: 'null = ไม่มีเพดาน',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  vehicleMax?: number | null;
  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  trialDays?: number;
  @ApiPropertyOptional({ description: 'ราคาตั้งต้น — ยังไม่ประกาศ (D-40)' })
  @IsOptional()
  @IsBoolean()
  provisional?: boolean;
  @ApiPropertyOptional({
    type: [PlanEntitlementInputDto],
    description:
      'เซลล์ที่จะตั้ง (บางส่วนได้) — ฟีเจอร์พื้นฐานต้อง included (422 basic_feature_locked)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PlanEntitlementInputDto)
  entitlements?: PlanEntitlementInputDto[];
  @ApiProperty({ example: 'ปรับราคาตามมติ PO รอบ D-40', minLength: 10 })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class PublishPlanVersionDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'วันมีผล (ไม่ส่ง = ทันที) — ลูกค้าใหม่ใช้เวอร์ชันนี้ตั้งแต่วันนี้ ลูกค้าเดิมคงเวอร์ชันเดิม',
  })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
  @ApiProperty({ example: 'เผยแพร่ราคาใหม่ตามมติ PO', minLength: 10 })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class PlanVersionDto {
  @ApiProperty({ example: 'plv_…' }) id!: string;
  @ApiProperty({ example: 'std' }) planCode!: string;
  @ApiProperty({ example: 1, description: 'เลขเวอร์ชันราคาของแพ็กเกจ (v1, v2, …)' })
  version!: number;
  @ApiProperty({
    example: 1,
    description: 'เลขแก้ไขของแถว = ETag (ส่งกลับใน If-Match — docs/01 §5.1)',
  })
  rowVersion!: number;
  @ApiProperty({ enum: ['draft', 'published', 'retired'] }) status!: string;
  @ApiProperty({ nullable: true, type: String, example: '280.00' }) pricePerVehicleMonthly!:
    string | null;
  @ApiProperty({ nullable: true, type: String, example: '4500.00' }) minimumMonthly!: string | null;
  @ApiProperty({ example: '15.00' }) annualDiscountPct!: string;
  @ApiProperty({ type: [VolumeTierDto] }) volumeTiers!: VolumeTierDto[];
  @ApiProperty({ example: 16 }) vehicleMin!: number;
  @ApiProperty({ nullable: true, type: Number, example: 60 }) vehicleMax!: number | null;
  @ApiProperty({ example: 30 }) trialDays!: number;
  @ApiProperty({ example: 'THB' }) currency!: string;
  @ApiProperty({ example: 'exclusive' }) vatMode!: string;
  @ApiProperty({ description: 'ราคาตั้งต้น — ยังไม่ประกาศ' }) provisional!: boolean;
  @ApiProperty({ format: 'date-time' }) effectiveFrom!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) publishedAt!: string | null;
  @ApiProperty({ description: 'จำนวน tenant ที่อยู่บนเวอร์ชันนี้' }) subscribers!: number;
  @ApiProperty({ type: [PlanEntitlementDto] }) entitlements!: PlanEntitlementDto[];
}

export class PlatformPlanDto {
  @ApiProperty({ example: 'std' }) code!: string;
  @ApiProperty({ example: 'Growth' }) nameTh!: string;
  @ApiProperty({ nullable: true, type: String }) nameEn!: string | null;
  @ApiProperty({ enum: ['draft', 'active', 'archived'] }) status!: string;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() showOnWeb!: boolean;
  @ApiProperty() isContactSales!: boolean;
  @ApiProperty({ nullable: true, type: String }) badge!: string | null;
  @ApiProperty({ type: PlanVersionDto, nullable: true, description: 'เวอร์ชันที่มีผลตอนนี้' })
  current!: PlanVersionDto | null;
  @ApiProperty({ type: PlanVersionDto, nullable: true }) draft!: PlanVersionDto | null;
  @ApiProperty({ type: [PlanVersionDto], description: 'ทุกเวอร์ชัน (ใหม่ → เก่า)' })
  versions!: PlanVersionDto[];
}

export class PlatformFeatureDto {
  @ApiProperty({ example: 'settle' }) key!: string;
  @ApiProperty({ example: 'บัญชี' }) category!: string;
  @ApiProperty() nameTh!: string;
  @ApiProperty({ nullable: true, type: String }) nameEn!: string | null;
  @ApiProperty({ enum: ['boolean', 'limit', 'metered'] }) type!: string;
  @ApiProperty({ nullable: true, type: String }) unit!: string | null;
  @ApiProperty({ description: 'ฟีเจอร์พื้นฐาน — included ทุกแพ็กเกจ แก้ไม่ได้ (PLT-061)' })
  isBasic!: boolean;
  @ApiProperty() sortOrder!: number;
}

type VersionRow = PlanVersion & { entitlements: PlanEntitlement[] };

const IF_MATCH = {
  name: 'If-Match',
  required: false,
  description: 'ETag/rowVersion ของเวอร์ชัน — ไม่ตรง → 412 precondition_failed',
};

/**
 * แพ็กเกจ + เวอร์ชันราคา (P1-ST1-T01; spec/01 §6, §10.4 — PLT-060/061)
 * ดู: ทีมทุกบทบาท · สร้าง/แก้ draft/เผยแพร่: owner (SUPER_ADMIN — spec/01 §11.4 "แก้แพ็กเกจ/ราคา") พร้อมเหตุผล + platform_audit_log
 * publish แล้วแก้ไม่ได้ (trigger 0175) → เปลี่ยนราคา/สิทธิ์ = เวอร์ชันใหม่ · ลูกค้าเดิมอยู่บนเวอร์ชันเดิม (grandfather)
 * ตัวแก้ feature matrix ใน Console = P1-ST4-T03 (endpoint ชุดนี้)
 */
@ApiTags('platform-console')
@ApiBearerAuth()
@Controller('platform')
export class PlatformPlansController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
  ) {}

  @Get('features')
  @PlatformAuth()
  @ApiOkResponse({ type: [PlatformFeatureDto] })
  async features(): Promise<PlatformFeatureDto[]> {
    const rows = await this.prisma.platform.feature.findMany({
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });
    return rows.map((f: Feature) => ({
      key: f.key,
      category: f.category,
      nameTh: f.nameTh,
      nameEn: f.nameEn,
      type: f.type,
      unit: f.unit,
      isBasic: f.isBasic,
      sortOrder: f.sortOrder,
    }));
  }

  @Get('plans')
  @PlatformAuth()
  @ApiOkResponse({ type: [PlatformPlanDto] })
  async plans(): Promise<PlatformPlanDto[]> {
    const db = this.prisma.platform;
    const plans = await db.plan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      include: { versions: { include: { entitlements: true }, orderBy: { version: 'desc' } } },
    });
    const counts = await this.subscriberCounts();
    const now = Date.now();
    return plans.map((p: Plan & { versions: VersionRow[] }) => {
      const versions = p.versions.map((v) => this.toDto(v, counts.get(v.id) ?? 0));
      const cur = p.versions.find(
        (v) => v.status === 'published' && v.effectiveFrom.getTime() <= now,
      );
      const draft = p.versions.find((v) => v.status === 'draft');
      return {
        code: p.code,
        nameTh: p.nameTh,
        nameEn: p.nameEn,
        status: p.status,
        sortOrder: p.sortOrder,
        showOnWeb: p.showOnWeb,
        isContactSales: p.isContactSales,
        badge: p.badge,
        current: cur ? versions.find((v) => v.id === encodeId('planVersion', cur.id))! : null,
        draft: draft ? versions.find((v) => v.id === encodeId('planVersion', draft.id))! : null,
        versions,
      };
    });
  }

  @Get('plan-versions/:id')
  @PlatformAuth()
  @ApiOkResponse({ type: PlanVersionDto, description: 'header ETag = rowVersion' })
  async version(
    @Param('id') id: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<PlanVersionDto> {
    const v = await this.load(id);
    if (res) setEtag(res, v.rowVersion);
    return this.toDto(v, (await this.subscriberCounts()).get(v.id) ?? 0);
  }

  /**
   * สร้างเวอร์ชัน draft ใหม่ของแพ็กเกจ — คัดจากเวอร์ชันล่าสุด (เลขสูงสุด รวมที่ตั้งวันมีผลล่วงหน้า — review N1) แล้วทับด้วยค่าที่ส่ง
   * draft ได้ทีละ 1
   */
  @Post('plans/:code/versions')
  @PlatformAuth('SUPER_ADMIN')
  @ApiCreatedResponse({ type: PlanVersionDto })
  async createDraft(
    @Param('code') code: string,
    @Body() body: PlanVersionInputDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlanVersionDto> {
    const db = this.prisma.platform;
    const plan = await db.plan.findUnique({
      where: { code },
      include: { versions: { include: { entitlements: true }, orderBy: { version: 'desc' } } },
    });
    if (!plan) throw new ProblemException('not_found');
    if (plan.versions.some((v) => v.status === 'draft'))
      throw new ProblemException(
        'conflict',
        'แพ็กเกจนี้มีเวอร์ชันร่างอยู่แล้ว — แก้ร่างเดิมหรือเผยแพร่ก่อน',
        [{ field: 'code', code: 'draft_exists', message: 'a draft version already exists' }],
      );
    const base = plan.versions[0];
    const next = await this.merge(base ?? null, body);
    const created = await this.write(db, async (tx) => {
      const v = await tx.planVersion.create({
        data: {
          planCode: code,
          version: (plan.versions[0]?.version ?? 0) + 1,
          status: 'draft',
          ...next.fields,
          effectiveFrom: new Date(),
          createdBy: this.staffId(),
        },
      });
      if (next.cells.length)
        await tx.planEntitlement.createMany({
          data: next.cells.map((c) => ({ ...c, planVersionId: v.id })),
        });
      await platformAudit(tx, {
        action: 'platform.plan_version_created',
        entityType: 'plan_version',
        entityId: encodeId('planVersion', v.id),
        reason: body.reason,
        after: { planCode: code, version: v.version, ...this.snapshot(next) },
        before: base ? { version: base.version } : undefined,
      });
      return v.id;
    });
    return this.version(encodeId('planVersion', created), res);
  }

  /** แก้เวอร์ชัน draft — เวอร์ชันที่เผยแพร่แล้ว → 409 plan_version_immutable · If-Match ไม่ตรง → 412 */
  @Patch('plan-versions/:id')
  @PlatformAuth('SUPER_ADMIN')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({ type: PlanVersionDto })
  async updateDraft(
    @Param('id') id: string,
    @Body() body: PlanVersionInputDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlanVersionDto> {
    const cur = await this.load(id);
    if (cur.status !== 'draft') throw new ProblemException('plan_version_immutable');
    const want = expectedVersion(req);
    if (want !== undefined && want !== cur.rowVersion)
      throw new ProblemException('precondition_failed');
    const next = await this.merge(cur, body);
    await this.write(this.prisma.platform, async (tx) => {
      await this.bump(tx, cur, next.fields);
      await tx.planEntitlement.deleteMany({ where: { planVersionId: cur.id } });
      if (next.cells.length)
        await tx.planEntitlement.createMany({
          data: next.cells.map((c) => ({ ...c, planVersionId: cur.id })),
        });
      await platformAudit(tx, {
        action: 'platform.plan_version_updated',
        entityType: 'plan_version',
        entityId: id,
        reason: body.reason,
        before: this.snapshot({ fields: this.fieldsOf(cur), cells: cur.entitlements }),
        after: this.snapshot(next),
      });
    });
    return this.version(id, res);
  }

  /**
   * เผยแพร่ draft → published (แก้ไม่ได้อีก) · ลูกค้าใหม่/เปลี่ยนแพ็กเกจหลังวันมีผลได้เวอร์ชันนี้ · ลูกค้าเดิมคงเวอร์ชันเดิม (PLT-060)
   * การย้ายลูกค้าเดิม (แจ้งล่วงหน้า planMigration.noticeDays) = P1-ST4-T03
   */
  @Post('plan-versions/:id/publish')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({ type: PlanVersionDto })
  async publish(
    @Param('id') id: string,
    @Body() body: PublishPlanVersionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlanVersionDto> {
    const cur = await this.load(id);
    if (cur.status !== 'draft') throw new ProblemException('plan_version_immutable');
    const want = expectedVersion(req);
    if (want !== undefined && want !== cur.rowVersion)
      throw new ProblemException('precondition_failed');
    const at = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date();
    const now = new Date();
    // ขอบเขต (N8): ยอมย้อน ≤ 60 วิ (นาฬิกาเครื่องผู้ใช้ช้า) แล้วปัดเป็น now — ย้อนเกินนั้น = 422
    if (at.getTime() < now.getTime() - 60_000)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'effectiveFrom',
          code: 'in_past',
          message: 'effectiveFrom must not be in the past',
        },
      ]);
    const effectiveFrom = at < now ? now : at;
    // review N1: วันมีผลต้องไม่ก่อนเวอร์ชันที่เผยแพร่แล้วของแพ็กเกจเดียวกัน (กันลำดับเวอร์ชันสลับกับลำดับวันมีผล)
    const later = await this.prisma.platform.planVersion.findFirst({
      where: { planCode: cur.planCode, status: 'published', effectiveFrom: { gt: effectiveFrom } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (later)
      throw new ProblemException(
        'conflict',
        `มีเวอร์ชัน v${later.version} ตั้งวันมีผลไว้หลังวันนี้แล้ว — ตั้งวันมีผลของเวอร์ชันนี้ให้ไม่ก่อนวันนั้น`,
        [
          {
            field: 'effectiveFrom',
            code: 'version_scheduled',
            message: later.effectiveFrom.toISOString(),
          },
        ],
      );
    // ตรวจซ้ำก่อนล็อก (ข้อมูลร่างอาจมาจากก่อนเพิ่มฟีเจอร์พื้นฐาน — trigger 0177 ตรวจอีกชั้น)
    await this.merge(cur, { reason: body.reason });
    await this.write(this.prisma.platform, async (tx) => {
      await this.bump(tx, cur, {
        status: 'published',
        effectiveFrom,
        publishedAt: now,
        publishedBy: this.staffId(),
      });
      await platformAudit(tx, {
        action: 'platform.plan_version_published',
        entityType: 'plan_version',
        entityId: id,
        reason: body.reason,
        after: { planCode: cur.planCode, version: cur.version, effectiveFrom: at.toISOString() },
      });
    });
    // ลูกค้าเดิมไม่เปลี่ยน แต่ "limit สูงสุดของ grant" และ lockedIn อ่านเวอร์ชันที่มีผล → ล้าง cache ทั้งหมด
    this.entitlements.invalidate();
    return this.version(id, res);
  }

  // ───────────────────────── helpers ─────────────────────────

  /** อัปเดตแบบมีเงื่อนไข rowVersion (กันสองคนแก้ร่างพร้อมกันระหว่างอ่านกับเขียน) → 412 · rowVersion + 1 */
  private async bump(
    tx: Prisma.TransactionClient,
    cur: PlanVersion,
    data: Prisma.PlanVersionUpdateManyMutationInput,
  ) {
    const r = await tx.planVersion.updateMany({
      where: { id: cur.id, rowVersion: cur.rowVersion, status: 'draft' },
      data: { ...data, rowVersion: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
  }

  private staffId(): string | null {
    return requestContext.get()?.platformUser?.id ?? null;
  }

  private async load(id: string): Promise<VersionRow> {
    const uuid = decodeIdOr404('planVersion', id);
    const v = await this.prisma.platform.planVersion.findUnique({
      where: { id: uuid },
      include: { entitlements: true },
    });
    if (!v) throw new ProblemException('not_found');
    return v;
  }

  private async subscriberCounts(): Promise<Map<string, number>> {
    const rows = await this.prisma.platform.subscription.groupBy({
      by: ['planVersionId'],
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.planVersionId, r._count._all]));
  }

  private toDto(v: VersionRow, subscribers: number): PlanVersionDto {
    return {
      id: encodeId('planVersion', v.id),
      planCode: v.planCode,
      version: v.version,
      rowVersion: v.rowVersion,
      status: v.status,
      ...this.fieldsOf(v),
      currency: v.currency,
      vatMode: v.vatMode,
      effectiveFrom: v.effectiveFrom.toISOString(),
      publishedAt: v.publishedAt?.toISOString() ?? null,
      subscribers,
      entitlements: [...v.entitlements]
        .sort((a, z) => a.featureKey.localeCompare(z.featureKey))
        .map((e) => ({
          featureKey: e.featureKey,
          mode: e.mode as EntitlementMode,
          limit: e.limit,
        })),
    };
  }

  private fieldsOf(v: PlanVersion) {
    return {
      pricePerVehicleMonthly: v.pricePerVehicleMonthly?.toFixed(2) ?? null,
      minimumMonthly: v.minimumMonthly?.toFixed(2) ?? null,
      annualDiscountPct: v.annualDiscountPct.toFixed(2),
      volumeTiers: (v.volumeTiers ?? []) as unknown as VolumeTier[],
      vehicleMin: v.vehicleMin,
      vehicleMax: v.vehicleMax,
      trialDays: v.trialDays,
      provisional: v.provisional,
    };
  }

  /**
   * ค่าเดิม (เวอร์ชันฐาน) ทับด้วยค่าที่ส่ง → ตรวจราคา (@tms/domain) + ฟีเจอร์ในแคตตาล็อก + ฟีเจอร์พื้นฐานต้อง included (PLT-061)
   * ฟีเจอร์ในแคตตาล็อกที่เวอร์ชันฐานไม่มี → พื้นฐาน = included · อื่น ๆ = not_available
   */
  private async merge(base: VersionRow | null, body: PlanVersionInputDto) {
    const features = await this.prisma.platform.feature.findMany();
    const known = new Set(features.map((f) => f.key));
    const basic = new Set(features.filter((f) => f.isBasic).map((f) => f.key));
    const b = base
      ? this.fieldsOf(base)
      : {
          pricePerVehicleMonthly: null,
          minimumMonthly: null,
          annualDiscountPct: '0.00',
          volumeTiers: [] as VolumeTier[],
          vehicleMin: 1,
          vehicleMax: null,
          trialDays: 30,
          provisional: false,
        };
    const pick = <K extends keyof typeof b>(k: K) =>
      (body[k as keyof PlanVersionInputDto] === undefined
        ? b[k]
        : body[k as keyof PlanVersionInputDto]) as (typeof b)[K];
    const pricing: PlanPricingInput = {
      pricePerVehicleMonthly: pick('pricePerVehicleMonthly'),
      minimumMonthly: pick('minimumMonthly'),
      annualDiscountPct: pick('annualDiscountPct'),
      volumeTiers: (pick('volumeTiers') ?? []).map((t) => ({
        fromVehicle: t.fromVehicle,
        discountPct: t.discountPct,
      })),
      vehicleMin: pick('vehicleMin'),
      vehicleMax: pick('vehicleMax'),
      trialDays: pick('trialDays'),
    };
    const errors: FieldError[] = planPricingErrors(pricing).map((e) => ({
      field: e.field,
      code: e.code,
      message: e.code,
    }));
    const cells = new Map<
      string,
      { featureKey: string; mode: EntitlementMode; limit: number | null }
    >();
    for (const f of features)
      cells.set(f.key, {
        featureKey: f.key,
        mode: basic.has(f.key) ? 'included' : 'not_available',
        limit: null,
      });
    for (const e of base?.entitlements ?? [])
      if (known.has(e.featureKey))
        cells.set(e.featureKey, {
          featureKey: e.featureKey,
          mode: e.mode as EntitlementMode,
          limit: e.limit,
        });
    (body.entitlements ?? []).forEach((e, i) => {
      if (!known.has(e.featureKey))
        errors.push({
          field: `entitlements[${i}].featureKey`,
          code: 'unknown_feature',
          message: `unknown feature ${e.featureKey}`,
        });
      else
        cells.set(e.featureKey, { featureKey: e.featureKey, mode: e.mode, limit: e.limit ?? null });
    });
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
    const locked = basicFeatureViolations([...cells.values()], basic);
    if (locked.length)
      throw new ProblemException(
        'basic_feature_locked',
        undefined,
        locked.map((k) => ({ field: 'entitlements', code: 'basic_feature_locked', message: k })),
        { featureKeys: locked },
      );
    return {
      fields: {
        ...pricing,
        volumeTiers: pricing.volumeTiers as unknown as Prisma.InputJsonValue,
        provisional: pick('provisional'),
      },
      cells: [...cells.values()],
    };
  }

  private snapshot(n: {
    fields: object;
    cells: readonly { featureKey: string; mode: string; limit: number | null }[];
  }) {
    return {
      ...n.fields,
      entitlements: Object.fromEntries(
        [...n.cells]
          .sort((a, z) => a.featureKey.localeCompare(z.featureKey))
          .map((c) => [c.featureKey, c.limit === null ? c.mode : `${c.mode}:${c.limit}`]),
      ),
    };
  }

  /** transaction + แปลงข้อความจาก trigger ฐานข้อมูล (กันแข่งกัน) เป็น problem ที่ถูกต้อง */
  private async write<T>(
    db: PrismaService['platform'],
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await db.$transaction(fn);
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      if (m.includes('plan_version_immutable'))
        throw new ProblemException('plan_version_immutable');
      if (m.includes('basic_feature_locked')) throw new ProblemException('basic_feature_locked');
      if (
        m.includes('plan_version_one_draft_key') ||
        m.includes('plan_version_plan_code_version_key')
      )
        throw new ProblemException('conflict');
      throw e;
    }
  }
}
