import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PriceField } from '../../common/price-fields';
import { CleanText, IsNullable, IsOptionalNotNull, NormalizeCode } from '../master/master-kit';

/**
 * ฝั่ง — ขาขาย (SELL, ต่อลูกค้า — ST2-T13) · ขาซื้อ (BUY, ต่อรถร่วม/ผู้รับเหมา — ST2-T14) ใช้ตาราง/ตัวตรวจชุดเดียวกัน
 * ราคาใช้ชื่อตามฝั่ง: ขาขาย `sell*` (`prices.sell:*`) · ขาซื้อ `buy*` (`prices.buy:*`) — ส่งราคาของอีกฝั่ง → 422 `wrong_side`
 */
export const RATE_SIDES = ['SELL', 'BUY'] as const;
export type RateSideKey = (typeof RATE_SIDES)[number];
export const WRITABLE_SIDES = ['SELL', 'BUY'] as const;
const CARRIER_RE = /^car_[0-9a-f]{32}$/;

/**
 * สูตรราคาเฟส 0 (docs/04 B1): เหมาเที่ยว (PER_TRIP) · ตามระยะทาง (PER_KM) · ตามน้ำหนัก/ปริมาตร/หน่วยนับ (PER_TON/PER_CBM/PER_UNIT)
 * เหมาวัน (PER_DAY) = P1 — ยังไม่รับ (ชื่อ enum ตาม plan/11 ข้อ 3)
 */
export const RATE_PRICING_MODELS = [
  'PER_TRIP',
  'PER_KM',
  'PER_TON',
  'PER_CBM',
  'PER_UNIT',
] as const;
export type RatePricingModel = (typeof RATE_PRICING_MODELS)[number];

/**
 * สถานะที่ API แสดง — draft (ร่าง/รออนุมัติ) · pending_approval (P1) · active (อนุมัติแล้ว ยังไม่พ้นวันหมด)
 * · expired (อนุมัติแล้ว พ้นวันหมด — คำนวณจากวันที่ ไม่ต้องรอ job) · retired (ยกเลิก/ถูกฉบับใหม่แทนทั้งช่วง)
 */
export const RATE_STATUSES = ['draft', 'pending_approval', 'active', 'expired', 'retired'] as const;
export type RateStatusKey = (typeof RATE_STATUSES)[number];
/** เตือนใกล้หมดอายุล่วงหน้า (docs/04 B "เตือน NEAR_EXPIRY 30 วัน") */
export const NEAR_EXPIRY_DAYS = 30;

const CODE_RE = /^[A-Z0-9][A-Z0-9_\-./]{0,19}$/;
const EXT_RE = /^[\x21-\x7e]{1,100}$/;
const SITE_RE = /^loc_[0-9a-f]{32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** เงิน numeric(14,2) เป็นสตริง (ไม่ใช้ float — CLAUDE.md) */
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
const MONEY_MSG = 'must be a decimal string ≥ 0 with ≤ 2 decimals';

const NotesText = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : value,
  );

/** ราคาค่าบริการเสริมเฉพาะ rate นี้ (แทนราคาตั้งต้นของ catalog) */
export class RateAccessorialInputDto {
  @ApiProperty({
    example: 'svc_3f2a…',
    description: 'ค่าบริการเสริม (`service-items`) ฝั่งขาย/ทั้งคู่',
  })
  @Matches(/^svc_[0-9a-f]{32}$/)
  serviceItemId!: string;

  @ApiPropertyOptional({
    example: '300.00',
    type: String,
    description:
      'ราคาขาย (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาขายเท่านั้น · ต้องมีสิทธิ์ `prices.sell:write`',
  })
  @PriceField('sell')
  @IsOptionalNotNull()
  @Matches(MONEY_RE, { message: `sellPrice ${MONEY_MSG}` })
  sellPrice?: string;

  @ApiPropertyOptional({
    example: '250.00',
    type: String,
    description:
      'ราคาซื้อ (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาซื้อเท่านั้น · ต้องมีสิทธิ์ `prices.buy:write`',
  })
  @PriceField('buy')
  @IsOptionalNotNull()
  @Matches(MONEY_RE, { message: `buyPrice ${MONEY_MSG}` })
  buyPrice?: string;
}

/** ฟิลด์ราคา/เงื่อนไข — ใช้ทั้งสร้าง แก้ร่าง และออกฉบับแก้ไข */
export class RateCardTermsDto {
  @ApiPropertyOptional({ enum: RATE_PRICING_MODELS, description: 'สูตรราคา (docs/04 B1)' })
  @IsOptionalNotNull()
  @IsIn(RATE_PRICING_MODELS)
  pricingModel?: RatePricingModel;

  @ApiPropertyOptional({
    example: 'unt_3f2a…',
    nullable: true,
    type: String,
    description:
      'หน่วยนับ (ชนิด COUNT เช่น ชิ้น พาเลท) — บังคับเมื่อ PER_UNIT, สูตรอื่นต้องเป็น null',
  })
  @IsNullable()
  @Matches(/^unt_[0-9a-f]{32}$/)
  unitId?: string | null;

  @ApiPropertyOptional({
    example: '6500.00',
    type: String,
    description:
      'ราคาขายต่อหน่วยของสูตร (บาท) — ต่อเที่ยว/กม./ตัน/ลบ.ม./หน่วย · rate ขาขาย · ต้องมีสิทธิ์ `prices.sell:write` (เห็นเมื่อมี `prices.sell:read`)',
  })
  @PriceField('sell')
  @IsOptionalNotNull()
  @Matches(MONEY_RE, { message: `sellRate ${MONEY_MSG}` })
  sellRate?: string;

  @ApiPropertyOptional({
    example: '1500.00',
    nullable: true,
    type: String,
    description: 'ขั้นต่ำต่อเที่ยว (บาท) — ผล = max(ราคาคำนวณ, ขั้นต่ำ) · null = ไม่มี',
  })
  @PriceField('sell')
  @IsNullable()
  @Matches(MONEY_RE, { message: `sellMinCharge ${MONEY_MSG}` })
  sellMinCharge?: string | null;

  @ApiPropertyOptional({
    example: '300.00',
    nullable: true,
    type: String,
    description: 'ค่าจุดเพิ่มต่อจุด เมื่อจำนวนจุดเกิน `includedStops` (MD-115) · null = ไม่คิด',
  })
  @PriceField('sell')
  @IsNullable()
  @Matches(MONEY_RE, { message: `sellExtraStopRate ${MONEY_MSG}` })
  sellExtraStopRate?: string | null;

  @ApiPropertyOptional({
    example: '5200.00',
    type: String,
    description:
      'ราคาซื้อต่อหน่วยของสูตร (บาท) — rate ขาซื้อ · ต้องมีสิทธิ์ `prices.buy:write` (เห็นเมื่อมี `prices.buy:read`)',
  })
  @PriceField('buy')
  @IsOptionalNotNull()
  @Matches(MONEY_RE, { message: `buyRate ${MONEY_MSG}` })
  buyRate?: string;

  @ApiPropertyOptional({
    example: '1200.00',
    nullable: true,
    type: String,
    description: 'ขั้นต่ำต่อเที่ยว (บาท) ขาซื้อ · null = ไม่มี',
  })
  @PriceField('buy')
  @IsNullable()
  @Matches(MONEY_RE, { message: `buyMinCharge ${MONEY_MSG}` })
  buyMinCharge?: string | null;

  @ApiPropertyOptional({
    example: '250.00',
    nullable: true,
    type: String,
    description: 'ค่าจุดเพิ่มต่อจุด ขาซื้อ (เกิน `includedStops`) · null = ไม่คิด',
  })
  @PriceField('buy')
  @IsNullable()
  @Matches(MONEY_RE, { message: `buyExtraStopRate ${MONEY_MSG}` })
  buyExtraStopRate?: string | null;

  @ApiPropertyOptional({
    example: 2,
    minimum: 0,
    maximum: 99,
    description: 'จำนวนจุดที่รวมในราคา (N) — ค่าเริ่มต้น 2 (รับ 1 + ส่ง 1)',
  })
  @IsOptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(99)
  includedStops?: number;

  @ApiPropertyOptional({
    example: '2026-11-01',
    format: 'date',
    description: 'มีผลตั้งแต่ (รวมวันนี้)',
  })
  @IsOptionalNotNull()
  @Matches(DATE_RE)
  validFrom?: string;

  @ApiPropertyOptional({
    example: '2027-10-31',
    format: 'date',
    nullable: true,
    type: String,
    description: 'ถึง (รวมวันนี้) ≥ validFrom · null = ไม่มีวันหมด',
  })
  @IsNullable()
  @Matches(DATE_RE)
  validTo?: string | null;

  @ApiPropertyOptional({
    type: [RateAccessorialInputDto],
    description:
      'ราคาค่าบริการเสริมเฉพาะ rate นี้ — ส่ง = แทนทั้งชุด (ไม่ส่ง = คงเดิม) · สูงสุด 50 รายการ ห้ามซ้ำ',
  })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RateAccessorialInputDto)
  accessorials?: RateAccessorialInputDto[];

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 1000, description: 'หมายเหตุ' })
  @IsNullable()
  @NotesText()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

/** key ของ rate — แก้ได้เฉพาะร่าง · ขาขายใช้ `customerId` ขาซื้อใช้ `carrierId` */
export class RateCardKeyDto extends RateCardTermsDto {
  @ApiPropertyOptional({ example: 'cus_3f2a…', description: 'ลูกค้า (ขาขายเท่านั้น)' })
  @IsOptionalNotNull()
  @Matches(/^cus_[0-9a-f]{32}$/)
  customerId?: string;

  @ApiPropertyOptional({
    example: 'car_3f2a…',
    description: 'รถร่วม/ผู้รับเหมา (ขาซื้อเท่านั้น — ST2-T05 `carriers`)',
  })
  @IsOptionalNotNull()
  @Matches(CARRIER_RE)
  carrierId?: string;

  @ApiPropertyOptional({ example: 'loc_3f2a…', description: 'ต้นทาง (สถานที่)' })
  @IsOptionalNotNull()
  @Matches(SITE_RE)
  originId?: string;

  @ApiPropertyOptional({ example: 'loc_8c1d…', description: 'ปลายทาง (สถานที่) — ต่างจากต้นทาง' })
  @IsOptionalNotNull()
  @Matches(SITE_RE)
  destinationId?: string;

  @ApiPropertyOptional({ example: 'vty_3f2a…', description: 'ประเภทรถ (ตรงตัวเท่านั้น — MD-111)' })
  @IsOptionalNotNull()
  @Matches(/^vty_[0-9a-f]{32}$/)
  vehicleTypeId?: string;

  @ApiPropertyOptional({
    example: 'svc_3f2a…',
    description:
      'รายการบนเอกสารที่กำหนด vat_type/wht_rate ของค่าขนส่งจาก rate นี้ — ไม่ส่งตอนสร้าง = ค่าขนส่ง (FREIGHT)',
  })
  @IsOptionalNotNull()
  @Matches(/^svc_[0-9a-f]{32}$/)
  serviceItemId?: string;
}

/** `POST /rate-cards` — สร้างเป็นร่าง (สถานะ draft) แล้ว `POST /{id}/approve` เพื่อใช้งาน */
export class CreateRateCardDto extends RateCardKeyDto {
  @ApiPropertyOptional({
    enum: WRITABLE_SIDES,
    default: 'SELL',
    description:
      'ฝั่ง — SELL (ลูกค้า, ต้องมี `prices.sell:write`) · BUY (รถร่วม, ต้องมี `prices.buy:write`)',
  })
  @IsOptionalNotNull()
  @IsIn(WRITABLE_SIDES)
  side?: RateSideKey;

  @ApiPropertyOptional({
    example: 'RC-S-0001',
    description: 'รหัส — ไม่ส่ง = ระบบออกเลขถัดไป (ขาขาย RC-S-0001 · ขาซื้อ RC-B-0001)',
  })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;

  @ApiPropertyOptional({ description: 'รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้' })
  @IsOptionalNotNull()
  @Matches(EXT_RE)
  externalId?: string;
}

/** `PATCH /rate-cards/{id}` — แก้ได้เฉพาะร่าง (rate ที่อนุมัติแล้วใช้ `POST /{id}/revise`) */
export class UpdateRateCardDto extends RateCardKeyDto {
  @ApiPropertyOptional({ nullable: true, type: String, description: 'null = ลบการผูก' })
  @IsNullable()
  @Matches(EXT_RE)
  externalId?: string | null;
}

/** `PUT /rate-cards/external/{externalId}` — ยังไม่มี = สร้างร่าง · มีและเป็นร่าง = แก้ · อนุมัติแล้ว = 409 (ใช้ revise) */
export class UpsertRateCardDto extends RateCardKeyDto {
  @ApiPropertyOptional({
    enum: WRITABLE_SIDES,
    default: 'SELL',
    description: 'ฝั่ง — ใช้ตอนสร้าง; แถวที่มีอยู่แล้วต้องเป็นฝั่งเดิม (ต่าง → 422 `side_locked`)',
  })
  @IsOptionalNotNull()
  @IsIn(WRITABLE_SIDES)
  side?: RateSideKey;

  @ApiPropertyOptional({ example: 'RC-S-0001', description: 'ใช้ตอนสร้างเท่านั้น' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;
}

/** `POST /rate-cards/{id}/revise` — ออกฉบับแก้ไข (ร่าง) ของ rate ที่อนุมัติแล้ว key เดิม (MD-118) */
export class ReviseRateCardDto extends RateCardTermsDto {}

const STATUS_LIST_RE = new RegExp(`^(${RATE_STATUSES.join('|')})(,(${RATE_STATUSES.join('|')}))*$`);

/**
 * รายการ rate — โครงเดียวกับ `MasterListQuery` แต่สถานะเป็นของ rate card
 * (ไม่ extends เพราะ class-validator รวม decorator ของคลาสแม่ — status ของ master จะชนกัน)
 */
export class RateCardListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ description: 'คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull)' })
  @IsOptional()
  @IsISO8601()
  updatedAfter?: string;

  @ApiPropertyOptional({
    enum: ['code', 'updatedAt', '-updatedAt'],
    default: 'code',
    description: 'code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync',
  })
  @IsOptional()
  @IsIn(['code', 'updatedAt', '-updatedAt'])
  sort?: 'code' | 'updatedAt' | '-updatedAt';

  @ApiPropertyOptional({ description: 'รายชื่อ field คั่นด้วย , เช่น id,code' })
  @IsOptional()
  @Matches(/^[a-zA-Z]+(,[a-zA-Z]+)*$/)
  fields?: string;

  @ApiPropertyOptional({
    description:
      'ค้นหา — รหัส ชื่อลูกค้า/ผู้รับเหมา ชื่อ/รหัสต้นทางหรือปลายทาง externalId (ไม่สนตัวพิมพ์)',
    maxLength: 100,
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    enum: RATE_SIDES,
    description:
      'ฝั่ง — ไม่ส่ง: มี carrierId = BUY ไม่งั้น SELL · ขัดกับ customerId/carrierId → 422 `wrong_side`',
  })
  @IsOptional()
  @IsIn(RATE_SIDES)
  side?: RateSideKey;

  @ApiPropertyOptional({
    description: `สถานะ คั่นด้วย , (${RATE_STATUSES.join(' / ')}) — active/expired คิดจากวันที่ (เวลาไทย)`,
  })
  @IsOptional()
  @Matches(STATUS_LIST_RE)
  status?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: `true = ใช้งานอยู่และหมดอายุภายใน ${NEAR_EXPIRY_DAYS} วัน (ต้นแบบ "หมดอายุใน 30 วัน")`,
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  nearExpiry?: 'true' | 'false';

  @ApiPropertyOptional({ description: 'เฉพาะลูกค้านี้ (cus_…)' })
  @IsOptional()
  @Matches(/^cus_[0-9a-f]{32}$/)
  customerId?: string;

  @ApiPropertyOptional({ description: 'เฉพาะรถร่วมนี้ (car_…) — ขาซื้อ' })
  @IsOptional()
  @Matches(CARRIER_RE)
  carrierId?: string;

  @ApiPropertyOptional({
    description: 'ชื่อ/รหัสลูกค้า (ขาขาย) หรือผู้รับเหมา (ขาซื้อ) มีคำนี้ (ตัวกรองคอลัมน์แรก)',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  party?: string;

  @ApiPropertyOptional({ description: 'ต้นทางตรงตัว (loc_…)' })
  @IsOptional()
  @Matches(SITE_RE)
  originId?: string;

  @ApiPropertyOptional({ description: 'ปลายทางตรงตัว (loc_…)' })
  @IsOptional()
  @Matches(SITE_RE)
  destinationId?: string;

  @ApiPropertyOptional({
    description: 'ชื่อ/รหัสต้นทางหรือปลายทางมีคำนี้ (ตัวกรองคอลัมน์ "เส้นทาง")',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  route?: string;

  @ApiPropertyOptional({ description: 'ประเภทรถ (vty_…)' })
  @IsOptional()
  @Matches(/^vty_[0-9a-f]{32}$/)
  vehicleTypeId?: string;

  @ApiPropertyOptional({ enum: RATE_PRICING_MODELS })
  @IsOptional()
  @IsIn(RATE_PRICING_MODELS)
  pricingModel?: RatePricingModel;

  @ApiPropertyOptional({ description: 'externalId ตรงตัว' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalId?: string;

  @ApiPropertyOptional({ description: 'true = รวมร่างที่ถูกลบ (tombstone มี `deletedAt`)' })
  @IsOptional()
  @IsIn(['true', 'false'])
  includeDeleted?: 'true' | 'false';
}

export class RateCardExportQuery extends RateCardListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง' })
  @IsOptional()
  @Matches(/^rcd_[0-9a-f]{32}(,rcd_[0-9a-f]{32}){0,199}$/)
  ids?: string;
}

export class RateCardSummaryQuery {
  @ApiPropertyOptional({
    enum: RATE_SIDES,
    description: 'ฝั่ง — ไม่ส่ง: มี carrierId = BUY ไม่งั้น SELL · ขัดกัน → 422 `wrong_side`',
  })
  @IsOptional()
  @IsIn(RATE_SIDES)
  side?: RateSideKey;

  @ApiPropertyOptional({ description: 'เฉพาะลูกค้านี้ (cus_…)' })
  @IsOptional()
  @Matches(/^cus_[0-9a-f]{32}$/)
  customerId?: string;

  @ApiPropertyOptional({ description: 'เฉพาะรถร่วมนี้ (car_…)' })
  @IsOptional()
  @Matches(CARRIER_RE)
  carrierId?: string;
}

// ---------- response ----------

export class RatePartyRefDto {
  @ApiProperty({ example: 'cus_3f2a…' }) id!: string;
  @ApiProperty({ example: 'CUS-0001' }) code!: string;
  @ApiProperty({ example: 'บริษัท ตัวอย่าง จำกัด' }) name!: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: 'active' | 'inactive';
}

export class RateSiteRefDto extends RatePartyRefDto {}
export class RateVehicleTypeRefDto extends RatePartyRefDto {}

export class RateUnitRefDto {
  @ApiProperty({ example: 'unt_3f2a…' }) id!: string;
  @ApiProperty({ example: 'PLT' }) code!: string;
  @ApiProperty({ example: 'พาเลท' }) name!: string;
}

export class RateServiceItemRefDto {
  @ApiProperty({ example: 'svc_3f2a…' }) id!: string;
  @ApiProperty({ example: 'FREIGHT' }) code!: string;
  @ApiProperty({ example: 'ค่าขนส่ง' }) name!: string;
  @ApiProperty({ example: 'เที่ยว' }) unitLabel!: string;
  @ApiProperty({ example: 'PER_TRIP' }) calcUnit!: string;
  @ApiProperty({ enum: ['VAT_7', 'EXEMPT_TRANSPORT', 'ZERO_RATED'] }) vatType!: string;
  @ApiProperty({ example: '1.00', description: 'อัตราหัก ณ ที่จ่าย (%)' }) whtRate!: string;
}

export class RateAccessorialDto {
  @ApiProperty({ type: RateServiceItemRefDto }) serviceItem!: RateServiceItemRefDto;
  @ApiPropertyOptional({
    example: '300.00',
    type: String,
    description: 'ราคาขายเฉพาะ rate นี้ (เห็นเมื่อมี `prices.sell:read`)',
  })
  @PriceField('sell')
  sellPrice?: string;
  @ApiPropertyOptional({
    example: '250.00',
    type: String,
    description: 'ราคาซื้อเฉพาะ rate นี้ (ขาซื้อ — เห็นเมื่อมี `prices.buy:read`)',
  })
  @PriceField('buy')
  buyPrice?: string;
}

export class RateCardDto {
  @ApiProperty({ example: 'rcd_3f2a…' }) id!: string;
  @ApiProperty({ example: 'RC-S-0001' }) code!: string;
  @ApiProperty({ example: 1, description: 'ฉบับที่ (ฉบับแก้ไขใช้รหัสเดิม — MD-118)' })
  revision!: number;
  @ApiProperty({ nullable: true, type: String, description: 'ฉบับก่อนหน้า (rcd_…)' })
  parentId!: string | null;
  @ApiProperty({ enum: RATE_SIDES }) side!: RateSideKey;
  @ApiProperty({ type: RatePartyRefDto, nullable: true, description: 'ลูกค้า (ขาขาย)' })
  customer!: RatePartyRefDto | null;
  @ApiProperty({
    type: RatePartyRefDto,
    nullable: true,
    description: 'รถร่วม/ผู้รับเหมา (ขาซื้อ)',
  })
  carrier!: RatePartyRefDto | null;
  @ApiProperty({ type: RateSiteRefDto }) origin!: RateSiteRefDto;
  @ApiProperty({ type: RateSiteRefDto }) destination!: RateSiteRefDto;
  @ApiProperty({ type: RateVehicleTypeRefDto }) vehicleType!: RateVehicleTypeRefDto;
  @ApiProperty({ enum: [...RATE_PRICING_MODELS, 'PER_DAY'] }) pricingModel!: string;
  @ApiProperty({ type: RateUnitRefDto, nullable: true }) unit!: RateUnitRefDto | null;
  @ApiPropertyOptional({
    example: '6500.00',
    type: String,
    description: 'ราคาขายต่อหน่วยของสูตร — rate ขาขาย (เห็นเมื่อมี `prices.sell:read`)',
  })
  @PriceField('sell')
  sellRate?: string;
  @ApiPropertyOptional({ example: '1500.00', nullable: true, type: String })
  @PriceField('sell')
  sellMinCharge?: string | null;
  @ApiPropertyOptional({ example: '300.00', nullable: true, type: String })
  @PriceField('sell')
  sellExtraStopRate?: string | null;
  @ApiPropertyOptional({
    example: '5200.00',
    type: String,
    description: 'ราคาซื้อต่อหน่วยของสูตร — rate ขาซื้อ (เห็นเมื่อมี `prices.buy:read`)',
  })
  @PriceField('buy')
  buyRate?: string;
  @ApiPropertyOptional({ example: '1200.00', nullable: true, type: String })
  @PriceField('buy')
  buyMinCharge?: string | null;
  @ApiPropertyOptional({ example: '250.00', nullable: true, type: String })
  @PriceField('buy')
  buyExtraStopRate?: string | null;
  @ApiProperty({ example: 2 }) includedStops!: number;
  @ApiProperty({ type: RateServiceItemRefDto }) serviceItem!: RateServiceItemRefDto;
  @ApiProperty({ type: [RateAccessorialDto] }) accessorials!: RateAccessorialDto[];
  @ApiProperty({ example: '2026-11-01', format: 'date' }) validFrom!: string;
  @ApiProperty({ example: '2027-10-31', format: 'date', nullable: true, type: String })
  validTo!: string | null;
  @ApiProperty({ enum: RATE_STATUSES }) status!: RateStatusKey;
  @ApiProperty({
    description: `ใช้งานอยู่และหมดอายุภายใน ${NEAR_EXPIRY_DAYS} วัน (NEAR_EXPIRY)`,
  })
  nearExpiry!: boolean;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'จำนวนวันถึงวันหมด (ติดลบ = หมดแล้ว) · null = ไม่มีวันหมด',
  })
  daysToExpiry!: number | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) approvedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true, type: String })
  deletedAt?: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class RateCardPageDto {
  @ApiProperty({ type: [RateCardDto] }) data!: RateCardDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class RateCardSummaryDto {
  @ApiProperty({ description: 'rate ทั้งหมด (ไม่รวมที่ลบ)' }) total!: number;
  @ApiProperty({ description: 'ร่าง (รออนุมัติ)' }) draft!: number;
  @ApiProperty({ description: 'รออนุมัติ (P1)' }) pendingApproval!: number;
  @ApiProperty({ description: 'ใช้งาน (มีผล)' }) active!: number;
  @ApiProperty({ description: `ใช้งานและหมดอายุใน ${NEAR_EXPIRY_DAYS} วัน` }) nearExpiry!: number;
  @ApiProperty({ description: 'หมดอายุ' }) expired!: number;
  @ApiProperty({ description: 'ยกเลิก/ถูกแทน' }) retired!: number;
}

// ---------- ราคา 5 ครั้งล่าสุดที่จ้างรถร่วมรายนี้ (ST2-T14; docs/04 B "Rate card ขาซื้อ", D2 PL4) ----------

export class CarrierRecentPricesQuery {
  @ApiPropertyOptional({ description: 'เฉพาะเที่ยวที่ต้นทาง (จุดแรก) เป็นสถานที่นี้ (loc_…)' })
  @IsOptional()
  @Matches(SITE_RE)
  originId?: string;

  @ApiPropertyOptional({ description: 'เฉพาะเที่ยวที่ปลายทาง (จุดสุดท้าย) เป็นสถานที่นี้ (loc_…)' })
  @IsOptional()
  @Matches(SITE_RE)
  destinationId?: string;

  @ApiPropertyOptional({ description: 'เฉพาะเที่ยวที่ใช้รถประเภทนี้ (vty_…)' })
  @IsOptional()
  @Matches(/^vty_[0-9a-f]{32}$/)
  vehicleTypeId?: string;
}

export class RecentPriceSiteDto {
  @ApiProperty({ example: 'loc_3f2a…' }) id!: string;
  @ApiProperty({ example: 'LOC-0001' }) code!: string;
  @ApiProperty({ example: 'คลังบางนา' }) name!: string;
}

export class CarrierRecentPriceDto {
  @ApiProperty({ example: 'trp_3f2a…' }) tripId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'TRP-2611-0001' }) tripNo!: string | null;
  @ApiProperty({ example: '2026-11-03', format: 'date', description: 'วันที่ของเที่ยว' })
  date!: string;
  @ApiProperty({ type: RecentPriceSiteDto, nullable: true, description: 'จุดแรกของเที่ยว' })
  origin!: RecentPriceSiteDto | null;
  @ApiProperty({ type: RecentPriceSiteDto, nullable: true, description: 'จุดสุดท้ายของเที่ยว' })
  destination!: RecentPriceSiteDto | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '6 ล้อ',
    description: 'ประเภทรถ ณ วันจ่ายงาน',
  })
  vehicleType!: string | null;
  @ApiPropertyOptional({
    example: '5200.00',
    type: String,
    description:
      'ค่าจ้างรถร่วมของเที่ยว (ผลรวม cost line CARRIER_FEE ก่อน VAT) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyAmount?: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'RC-B-0001',
    description: 'rate card ขาซื้อที่ใช้ตอนจ่ายงาน (จาก snapshot) — null = ราคาตกลงเอง',
  })
  rateCardCode!: string | null;
}

export class CarrierRecentPricesDto {
  @ApiProperty({
    type: [CarrierRecentPriceDto],
    description: 'ใหม่สุดก่อน ไม่เกิน 5 เที่ยว · ยังไม่เคยจ้าง = []',
  })
  data!: CarrierRecentPriceDto[];
}
