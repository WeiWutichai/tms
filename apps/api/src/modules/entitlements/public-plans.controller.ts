import { Controller, Get } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Feature, Plan, PlanEntitlement, PlanVersion } from '@prisma/client';
import {
  entitlementCell,
  type EntitlementCell,
  type EntitlementMode,
  type VolumeTier,
} from '@tms/domain';
import { Public } from '../../common/decorators';
import { ProblemException } from '../../common/problem';
import { PrismaService } from '../../db/prisma.service';
import { readPlatformSetting } from '../../platform/platform-settings.service';
import { currentPlanVersions } from './plan-catalog';

const CELL_KINDS = ['yes', 'addon', 'no', 'limit', 'unlimited'] as const;

export class PublicVolumeTierDto {
  @ApiProperty({ example: 51, description: 'คันที่เริ่มได้ส่วนลด (รวมคันนี้)' })
  fromVehicle!: number;
  @ApiProperty({ example: '10.00', description: 'ส่วนลด %' }) discountPct!: string;
}

export class PublicPlanCellDto {
  @ApiProperty({
    enum: CELL_KINDS,
    description:
      'yes = ✓ · addon = ซื้อเพิ่ม · no = — · limit = ตัวเลขโควตา · unlimited = ไม่จำกัด',
  })
  kind!: EntitlementCell['kind'];
  @ApiProperty({ nullable: true, type: Number, description: 'เฉพาะ kind = limit' })
  limit!: number | null;
}

export class PublicFeatureDto {
  @ApiProperty({ example: 'track' }) key!: string;
  @ApiProperty({ example: 'ปฏิบัติการ' }) category!: string;
  @ApiProperty({ example: 'ติดตามรถ (GPS)' }) nameTh!: string;
  @ApiProperty({ nullable: true, type: String }) nameEn!: string | null;
  @ApiProperty({ enum: ['boolean', 'limit', 'metered'] }) type!: string;
  @ApiProperty({ nullable: true, type: String, example: 'ตัว' }) unit!: string | null;
  @ApiProperty({ description: 'ฟีเจอร์พื้นฐาน — มีทุกแพ็กเกจ (PLT-061)' }) isBasic!: boolean;
  @ApiProperty({
    type: [PublicPlanCellDto],
    description: 'เซลล์ต่อแพ็กเกจ เรียงตาม `plans` — มาจาก plan_entitlement ของเวอร์ชันที่มีผล',
  })
  cells!: PublicPlanCellDto[];
}

export class PublicPlanDto {
  @ApiProperty({ example: 'std' }) code!: string;
  @ApiProperty({ example: 'Growth' }) nameTh!: string;
  @ApiProperty({ nullable: true, type: String }) nameEn!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'นิยม' }) badge!: string | null;
  @ApiProperty({ description: 'ตกลงราคากับฝ่ายขาย (ไม่มีราคาต่อรถ)' }) isContactSales!: boolean;
  @ApiProperty({ example: 1, description: 'เลขเวอร์ชันราคาที่มีผล' }) version!: number;
  @ApiProperty({ format: 'date-time' }) effectiveFrom!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '280.00',
    description: 'บาท/รถ active/เดือน ก่อน VAT — null = ตกลงราคา',
  })
  pricePerVehicleMonthly!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '4500.00', description: 'ก่อน VAT' })
  minimumMonthly!: string | null;
  @ApiProperty({ example: '15.00', description: 'ส่วนลดรายปี %' }) annualDiscountPct!: string;
  @ApiProperty({ type: [PublicVolumeTierDto] }) volumeTiers!: PublicVolumeTierDto[];
  @ApiProperty({ example: 16 }) vehicleMin!: number;
  @ApiProperty({ nullable: true, type: Number, example: 60 }) vehicleMax!: number | null;
  @ApiProperty({ example: 30 }) trialDays!: number;
  @ApiProperty({ description: 'ราคาตั้งต้น — ยังไม่ประกาศ (D-40)' }) provisional!: boolean;
}

export class PublicPlansDto {
  @ApiProperty({ example: 'THB' }) currency!: string;
  @ApiProperty({ example: 'exclusive', description: 'ราคาทั้งหมดยังไม่รวม VAT' }) vatMode!: string;
  @ApiProperty({ description: 'มีแพ็กเกจที่ราคาตั้งต้น (ยังไม่ประกาศ) อย่างน้อย 1 รายการ' })
  provisional!: boolean;
  @ApiProperty({
    example: 90,
    description: 'เก็บข้อมูลหลังยกเลิกกี่วัน (retention.operationalDays)',
  })
  retentionDays!: number;
  @ApiProperty({
    example: 30,
    description: 'จำนวนวันทดลองใช้ของ tenant ใหม่ (trial.days — ที่ใช้จริงตอนสมัคร)',
  })
  trialDays!: number;
  @ApiProperty({
    example: '1.00',
    description: 'น้ำหนักรถร่วมในการนับรถ active (usage.subconWeight — 1.00 = เต็มคัน)',
  })
  subconWeight!: string;
  @ApiProperty({ type: [PublicPlanDto], description: 'เรียงตาม sortOrder' })
  plans!: PublicPlanDto[];
  @ApiProperty({ type: [PublicFeatureDto], description: 'feature matrix เรียงตามแคตตาล็อก' })
  features!: PublicFeatureDto[];
}

const money = (v: { toFixed(n: number): string } | null) => (v === null ? null : v.toFixed(2));

/**
 * แพ็กเกจและราคาสาธารณะ (P1-ST2-T02; spec/01 §2 ข้อ 3, PLT-002 "ทุกหน้าอ่านราคาจาก API เดียว") — ไม่ login
 * เฉพาะแพ็กเกจ `status = active` + `showOnWeb` ที่มีเวอร์ชัน published ซึ่งถึงวันมีผลแล้ว (draft ไม่แสดง)
 * `pricing.publicVisible = false` (ค่าเริ่ม — D-40 ยังไม่เคาะราคา) หรือไม่มีแพ็กเกจให้แสดง → 404 (หน้าราคา + ลิงก์ราคาใน landing ซ่อน)
 * rate limit ต่อ IP กลุ่ม `pricing` แยกจากลิงก์สาธารณะ (public-rate-limit.middleware) · no-store · ไม่มีข้อมูล tenant
 */
@ApiTags('public')
@Controller('public/plans')
export class PublicPlansController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'แพ็กเกจ ราคา และตารางเปรียบเทียบสำหรับหน้าราคาสาธารณะ',
    description:
      'ราคาไม่รวม VAT · คำนวณค่าใช้จ่ายด้วย `estimatePlanCharge` ของ @tms/domain (ตัวเดียวกับประมาณการบิล) · ' +
      'ปิดหน้าราคา (`pricing.publicVisible = false`) → 404',
  })
  @ApiOkResponse({ type: PublicPlansDto })
  @ApiNotFoundResponse({ description: 'หน้าราคาสาธารณะยังไม่เปิด (pricing.publicVisible = false)' })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป (ต่อ IP)' })
  async list(): Promise<PublicPlansDto> {
    const db = this.prisma.platform;
    if (!(await readPlatformSetting<boolean>(db, 'pricing.publicVisible')))
      throw new ProblemException('not_found');
    const [plans, current, features, retentionDays, subconWeight, trialDays] = await Promise.all([
      db.plan.findMany({
        where: { status: 'active', showOnWeb: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
      currentPlanVersions(db),
      // B1 (R-11): เฉพาะฟีเจอร์ที่แสดงบนเว็บได้ — นอกเฟส 1 / ไม่มีถ้อยคำใน docs/02 §2 ซ่อน (migration 0187)
      db.feature.findMany({
        where: { showOnWeb: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      }),
      readPlatformSetting<number>(db, 'retention.operationalDays'),
      readPlatformSetting<string>(db, 'usage.subconWeight'),
      readPlatformSetting<number>(db, 'trial.days'),
    ]);
    const shown = plans
      .map((p: Plan) => ({ plan: p, version: current.get(p.code) }))
      .filter((x): x is { plan: Plan; version: PlanVersion } => !!x.version);
    // S1: ไม่มีแพ็กเกจให้แสดง = ปิดหน้าราคา (landing + หน้าราคาซ่อนพร้อมกัน)
    if (!shown.length) throw new ProblemException('not_found');
    const ents = await db.planEntitlement.findMany({
      where: { planVersionId: { in: shown.map((x) => x.version.id) } },
    });
    const cellOf = new Map(
      ents.map((e: PlanEntitlement) => [`${e.planVersionId}|${e.featureKey}`, e]),
    );
    return {
      currency: 'THB',
      vatMode: 'exclusive',
      provisional: shown.some((x) => x.version.provisional),
      retentionDays,
      subconWeight,
      trialDays,
      plans: shown.map(({ plan, version: v }) => ({
        code: plan.code,
        nameTh: plan.nameTh,
        nameEn: plan.nameEn,
        badge: plan.badge,
        isContactSales: plan.isContactSales,
        version: v.version,
        effectiveFrom: v.effectiveFrom.toISOString(),
        pricePerVehicleMonthly: money(v.pricePerVehicleMonthly),
        minimumMonthly: money(v.minimumMonthly),
        annualDiscountPct: v.annualDiscountPct.toFixed(2),
        volumeTiers: (v.volumeTiers as unknown as VolumeTier[]) ?? [],
        vehicleMin: v.vehicleMin,
        vehicleMax: v.vehicleMax,
        trialDays: v.trialDays,
        provisional: v.provisional,
      })),
      features: features.map((f: Feature) => ({
        key: f.key,
        category: f.category,
        nameTh: f.nameTh,
        nameEn: f.nameEn,
        type: f.type,
        unit: f.unit,
        isBasic: f.isBasic,
        cells: shown.map(({ version: v }) => {
          const e = cellOf.get(`${v.id}|${f.key}`);
          const c = entitlementCell(
            f.type,
            e ? { mode: e.mode as EntitlementMode, limit: e.limit } : undefined,
          );
          return { kind: c.kind, limit: c.kind === 'limit' ? c.limit : null };
        }),
      })),
    };
  }
}
