import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { INTAKE_HOLD_CODES, ORDER_SOURCES, SO_STATUSES } from '@tms/domain';
import { PriceField } from '../../common/price-fields';
import { CleanText, IsOptionalNotNull } from '../master/master-kit';

/**
 * DTO ของ Open API `orders` (ST3-T03; docs/04 C + G1, docs/01 §5.2 #1)
 * ขาเข้า: โครงเท่านั้นที่ตรวจด้วย class-validator (field แปลกปลอม → 422) — รูปแบบค่า (วันที่/ทศนิยม/id/ความยาว)
 * ตรวจด้วยกฎชุดเดียวของทุกทางเข้า `normalizeOrderInput` (422 รวมทุกช่อง `stops[0].siteId` ฯลฯ) — ไม่ซ้ำกฎสองที่
 * เงิน/จำนวนเป็นสตริงทศนิยม (ไม่รับ number — float)
 */

export const SO_STATUS_VALUES = SO_STATUSES.map((s) => s.toLowerCase()) as Lowercase<
  (typeof SO_STATUSES)[number]
>[];
export type SoStatusValue = (typeof SO_STATUS_VALUES)[number];
const STOP_TYPES = ['PICKUP', 'DELIVERY', 'RETURN'] as const;

export class OrderCustomerInputDto {
  @ApiPropertyOptional({ example: 'cus_3f2a…', nullable: true, description: 'ลูกค้าใน master' })
  @Allow()
  id?: string | null;

  @ApiPropertyOptional({
    example: 'C-001',
    nullable: true,
    description:
      'รหัสลูกค้าตามระบบต้นทาง — จับคู่กับ customer.externalId (ไม่พบ = ใบค้าง CUSTOMER_UNMAPPED)',
  })
  @Allow()
  externalId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ชื่อ/ข้อความลูกค้าตามต้นทาง' })
  @Allow()
  name?: string | null;
}

export class OrderStopInputDto {
  @ApiProperty({ enum: STOP_TYPES })
  @Allow()
  type!: (typeof STOP_TYPES)[number];

  @ApiPropertyOptional({
    example: 'loc_3f2a…',
    nullable: true,
    description: 'สถานที่ใน master — ไม่ส่ง = ใช้ `siteText` (ใบค้าง LOCATION_UNMAPPED)',
  })
  @Allow()
  siteId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 500,
    description: 'ข้อความสถานที่ตามต้นทาง (บังคับเมื่อไม่มี siteId)',
  })
  @Allow()
  siteText?: string | null;

  @ApiPropertyOptional({
    example: '2026-11-12T07:00:00+07:00',
    nullable: true,
    description: 'ISO 8601 พร้อม timezone',
  })
  @Allow()
  windowStart?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ISO 8601 พร้อม timezone (≥ windowStart)' })
  @Allow()
  windowEnd?: string | null;
}

export class OrderLineInputDto {
  @ApiProperty({ maxLength: 500 })
  @Allow()
  description!: string;

  @ApiProperty({ example: '12.5', type: String, description: '> 0 ทศนิยม ≤ 3 (สตริง)' })
  @Allow()
  qty!: string;

  @ApiPropertyOptional({ example: 'unt_3f2a…', nullable: true, description: 'หน่วยใน master' })
  @Allow()
  unitId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ข้อความหน่วย (บังคับเมื่อไม่มี unitId)' })
  @Allow()
  unit?: string | null;

  @ApiPropertyOptional({ example: 'prd_3f2a…', nullable: true })
  @Allow()
  productId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'รหัสสินค้าตามต้นทาง' })
  @Allow()
  itemCode?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: '12500' })
  @Allow()
  weightKg?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @Allow()
  cbm?: string | null;

  @ApiPropertyOptional()
  @Allow()
  isDangerous?: boolean;

  @ApiPropertyOptional({ nullable: true, type: String, example: '2.0' })
  @Allow()
  tempMin?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: '8.0' })
  @Allow()
  tempMax?: string | null;
}

/** ข้อมูลงานของ order (ใช้ร่วม POST / PUT external) — PUT = แทนทั้งใบ (ช่องที่ไม่ส่ง = ว่าง/ค่าตั้งต้น) */
export class OrderFieldsDto {
  @ApiPropertyOptional({
    description: 'บันทึกเป็นร่าง (ไม่ออกเลข SO — D-21) · ใบที่พ้นร่างแล้วกลับเป็นร่างไม่ได้',
  })
  @Allow()
  draft?: boolean;

  @ApiPropertyOptional({ type: OrderCustomerInputDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => OrderCustomerInputDto)
  customer?: OrderCustomerInputDto;

  @ApiPropertyOptional({
    example: 'cmp_3f2a…',
    nullable: true,
    description: 'นิติบุคคลที่ออกบิล — ไม่ส่ง = ตามลูกค้า/ค่าตั้งต้นของบริษัท',
  })
  @Allow()
  billingCompanyId?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 50, description: 'เลข PO / อ้างอิงของลูกค้า' })
  @Allow()
  customerRef?: string | null;

  @ApiProperty({ example: '2026-11-12', description: 'วันรับของ YYYY-MM-DD (ใช้หา rate)' })
  @Allow()
  requestedDate!: string;

  @ApiPropertyOptional({ example: 'vty_3f2a…', nullable: true })
  @Allow()
  vehicleTypeId?: string | null;

  @ApiProperty({ type: [OrderStopInputDto], description: '1–50 จุด เรียงตามลำดับวิ่ง' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderStopInputDto)
  stops!: OrderStopInputDto[];

  @ApiPropertyOptional({ type: [OrderLineInputDto], description: '≤ 200 บรรทัด' })
  @IsOptionalNotNull()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  lines?: OrderLineInputDto[];
}

export class CreateOrderDto extends OrderFieldsDto {
  @ApiPropertyOptional({
    example: 'PO-2026-0001',
    nullable: true,
    maxLength: 100,
    description:
      'externalRef ของระบบต้นทาง — unique ต่อบริษัท; มีใบเดิมจากช่องทางเดียวกัน = อัปเดตใบเดิม (เหมือน PUT external)',
  })
  @Allow()
  externalId?: string | null;
}

/** PUT /orders/external/{externalId} — externalId มาจาก path */
export class UpsertOrderDto extends OrderFieldsDto {}

/**
 * PATCH — ส่งเฉพาะช่องที่จะแก้ (ช่องบนสุด); `customer` / `stops` / `lines` ส่งแล้วแทนทั้งก้อน
 * ช่องที่แก้ได้ขึ้นกับสถานะ (ดู `editableFields` ของ 409 `order_locked_for_update`)
 */
export class UpdateOrderDto {
  @ApiPropertyOptional({
    description: 'false = ส่งร่าง (ออกเลข SO) · true ใช้ได้เฉพาะใบที่ยังเป็นร่าง',
  })
  @Allow()
  draft?: boolean;

  @ApiPropertyOptional({ type: OrderCustomerInputDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => OrderCustomerInputDto)
  customer?: OrderCustomerInputDto;

  @ApiPropertyOptional({ nullable: true, type: String })
  @Allow()
  billingCompanyId?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 50 })
  @Allow()
  customerRef?: string | null;

  @ApiPropertyOptional({ example: '2026-11-12' })
  @Allow()
  requestedDate?: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @Allow()
  vehicleTypeId?: string | null;

  @ApiPropertyOptional({ type: [OrderStopInputDto] })
  @IsOptionalNotNull()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderStopInputDto)
  stops?: OrderStopInputDto[];

  @ApiPropertyOptional({ type: [OrderLineInputDto] })
  @IsOptionalNotNull()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  lines?: OrderLineInputDto[];
}

// ---------- ขาออก ----------

export class OrderCustomerDto {
  @ApiProperty({ nullable: true, type: String, description: 'null = ยังจับคู่ลูกค้าไม่ได้' })
  id!: string | null;
  @ApiProperty({ nullable: true, type: String }) code!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อลูกค้าใน master' })
  legalName!: string | null;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ข้อความลูกค้าตามต้นทาง' })
  name!: string | null;
}

export class OrderHoldReasonDto {
  @ApiProperty({ example: 'RATE_MISSING' }) code!: string;
  @ApiProperty({ example: 'ไม่มีเรท' }) label!: string;
  @ApiProperty({ nullable: true, type: String, description: 'รายละเอียดเหตุค้าง (ไทย)' })
  note!: string | null;
}

export class OrderStopDto {
  @ApiProperty() sequence!: number;
  @ApiProperty({ enum: STOP_TYPES }) type!: string;
  @ApiProperty({ nullable: true, type: String }) siteId!: string | null;
  @ApiProperty() siteText!: string;
  @ApiProperty({ nullable: true, type: String }) windowStart!: string | null;
  @ApiProperty({ nullable: true, type: String }) windowEnd!: string | null;
}

export class OrderLineDto {
  @ApiProperty() lineNo!: number;
  @ApiProperty() description!: string;
  @ApiProperty({ example: '12.5' }) qty!: string;
  @ApiProperty({ nullable: true, type: String }) unitId!: string | null;
  @ApiProperty() unit!: string;
  @ApiProperty({ nullable: true, type: String }) productId!: string | null;
  @ApiProperty({ nullable: true, type: String }) itemCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) weightKg!: string | null;
  @ApiProperty({ nullable: true, type: String }) cbm!: string | null;
  @ApiProperty() isDangerous!: boolean;
  @ApiProperty({ nullable: true, type: String }) tempMin!: string | null;
  @ApiProperty({ nullable: true, type: String }) tempMax!: string | null;
}

export class OrderPricingReasonDto {
  @ApiProperty({ example: 'RATE_MISSING' }) code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional() field?: string;
}

/** บรรทัดราคาขาย (snapshot) — ทั้งก้อนอยู่ใต้ `sellCharges` (ต้องมี `prices.sell:read`) */
export class OrderChargeDto {
  @ApiProperty() lineNo!: number;
  @ApiProperty({ enum: ['FREIGHT', 'EXTRA_STOP', 'ACCESSORIAL'] }) kind!: string;
  @ApiProperty({ example: 'RATE_CARD', description: 'RATE_CARD = ระบบคิด · MANUAL = คนกำหนด' })
  origin!: string;
  @ApiProperty({ example: 'svc_3f2a…' }) serviceItemId!: string;
  @ApiProperty() serviceItemVersion!: number;
  @ApiProperty() description!: string;
  @ApiProperty({ example: '1' }) qty!: string;
  @ApiProperty({ example: '4500.00', description: 'ราคาขายต่อหน่วย (บาท ก่อน VAT)' })
  @PriceField('sell')
  sellUnitPrice!: string;
  @ApiProperty({ example: '4500.00', description: 'ราคาขายของบรรทัด (บาท ก่อน VAT)' })
  @PriceField('sell')
  sellAmount!: string;
  @ApiProperty({ example: 'EXEMPT_TRANSPORT' }) vatType!: string;
  @ApiProperty({ example: '1.00', description: 'อัตราหัก ณ ที่จ่าย (%) ตาม snapshot' })
  whtRate!: string;
  @ApiProperty({ nullable: true, type: String }) rateCardId!: string | null;
  @ApiProperty({ nullable: true, type: String }) rateCardCode!: string | null;
  @ApiProperty({ nullable: true, type: Number }) rateCardRevision!: number | null;
}

export class OrderDto {
  @ApiProperty({ example: 'ord_3f2a…' }) id!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'SO-6911-0001',
    description: 'ร่าง = null',
  })
  soNo!: string | null;
  @ApiProperty({ enum: SO_STATUS_VALUES }) status!: SoStatusValue;
  @ApiProperty({
    example: 'ERP:krs',
    description: 'ที่มาตาม docs/04 C: MANUAL / EXCEL / API / PORTAL / ERP:{connector}',
  })
  source!: string;
  @ApiProperty({
    enum: ORDER_SOURCES,
    description: 'ชนิดที่มา (ใช้กับป้ายที่มา): MANUAL / IMPORT / API / PORTAL / CONNECTOR',
  })
  sourceType!: (typeof ORDER_SOURCES)[number];
  @ApiProperty({ nullable: true, type: String, example: 'krs', description: 'รหัส connector' })
  connector!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'externalRef ของระบบต้นทาง' })
  externalId!: string | null;
  @ApiProperty({ type: OrderCustomerDto }) customer!: OrderCustomerDto;
  @ApiProperty() billingCompanyId!: string;
  @ApiProperty({ nullable: true, type: String }) customerRef!: string | null;
  @ApiProperty({ example: '2026-11-12' }) requestedDate!: string;
  @ApiProperty({ nullable: true, type: String }) vehicleTypeId!: string | null;
  @ApiProperty({ nullable: true, type: OrderHoldReasonDto, description: 'เหตุค้าง (ON_HOLD)' })
  holdReason!: OrderHoldReasonDto | null;
  @ApiProperty({
    type: [String],
    enum: INTAKE_HOLD_CODES,
    description: 'เหตุค้างทั้งหมดของการรับงานครั้งล่าสุด (ตัวแรก = holdReason)',
  })
  holdCodes!: string[];
  @ApiProperty({ enum: ['AVAILABLE', 'RATE_MISSING', 'CALCULATION_FAILURE'] })
  pricingStatus!: string;
  @ApiProperty({ type: [OrderPricingReasonDto] }) pricingReasons!: OrderPricingReasonDto[];
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '4500.00',
    description: 'ราคาขายรวมก่อน VAT (คาดการณ์) — เห็นเมื่อมี `prices.sell:read`',
  })
  @PriceField('sell')
  sellTotal?: string | null;
  @ApiPropertyOptional({
    type: [OrderChargeDto],
    description: 'บรรทัดราคาขาย — เห็นเมื่อมี `prices.sell:read`',
  })
  @PriceField('sell')
  sellCharges?: OrderChargeDto[];
  @ApiProperty({ type: [OrderStopDto] }) stops!: OrderStopDto[];
  @ApiProperty({ type: [OrderLineDto] }) lines!: OrderLineDto[];
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class OrderPageDto {
  @ApiProperty({ type: [OrderDto] }) data!: OrderDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

/** รายการ order — keyset (updatedAt, id) ตามมาตรฐาน (docs/04 G1 Pagination) */
export class OrderListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิม)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ description: 'คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull)' })
  @IsOptional()
  @IsISO8601()
  updatedAfter?: string;

  @ApiPropertyOptional({ enum: ['updatedAt', '-updatedAt'], default: 'updatedAt' })
  @IsOptional()
  @IsIn(['updatedAt', '-updatedAt'])
  sort?: 'updatedAt' | '-updatedAt';

  @ApiPropertyOptional({
    description:
      'รายชื่อ field ของ Order คั่นด้วย , เช่น id,soNo,status (ไม่รู้จัก → 422) — id คืนเสมอ',
  })
  @IsOptional()
  @Matches(/^[a-zA-Z]+(,[a-zA-Z]+)*$/)
  fields?: string;

  @ApiPropertyOptional({ description: `สถานะ คั่นด้วย , (${SO_STATUS_VALUES.join(', ')})` })
  @IsOptional()
  @Matches(new RegExp(`^(${SO_STATUS_VALUES.join('|')})(,(${SO_STATUS_VALUES.join('|')}))*$`))
  status?: string;

  @ApiPropertyOptional({
    description:
      'รหัสเหตุค้าง คั่นด้วย , เช่น RATE_MISSING,CUSTOMER_UNMAPPED — ตรงกับเหตุใดก็ได้ (OR) ของ `holdCodes` ' +
      '(เหตุทั้งหมดของการรับงานครั้งล่าสุด รวมเหตุรอง) หรือ `holdReason.code` (เหตุหลักบนใบ)',
  })
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{0,49}(,[A-Z][A-Z0-9_]{0,49}){0,19}$/)
  holdReason?: string;

  @ApiPropertyOptional({ example: 'cus_3f2a…', description: 'ลูกค้า' })
  @IsOptional()
  @Matches(/^cus_[0-9a-f]{32}$/)
  customerId?: string;

  @ApiPropertyOptional({
    description:
      'ที่มา คั่นด้วย , : MANUAL / EXCEL / API / PORTAL / ERP (ทุก connector) / ERP:{connector}',
  })
  @IsOptional()
  @Matches(
    /^(MANUAL|EXCEL|IMPORT|API|PORTAL|ERP|CONNECTOR|ERP:[a-z0-9][a-z0-9_-]{0,31})(,(MANUAL|EXCEL|IMPORT|API|PORTAL|ERP|CONNECTOR|ERP:[a-z0-9][a-z0-9_-]{0,31})){0,9}$/,
  )
  source?: string;

  @ApiPropertyOptional({ example: '2026-11-01', description: 'วันรับของตั้งแต่ (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  requestedFrom?: string;

  @ApiPropertyOptional({ example: '2026-11-30', description: 'วันรับของถึง (รวมวันนั้น)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  requestedTo?: string;

  @ApiPropertyOptional({ description: 'externalId ตรงตัว' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalId?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'ค้นหา — เลข SO, externalId, เลข PO, ชื่อ/รหัสลูกค้า (ไม่สนตัวพิมพ์)',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  q?: string;
}
