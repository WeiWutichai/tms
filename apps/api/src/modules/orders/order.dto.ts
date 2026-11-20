import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsBoolean,
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
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  INTAKE_HOLD_CODES,
  ORDER_HOLD_CODES,
  ORDER_SOURCES,
  SO_FIELD_GROUPS,
  SO_STATUSES,
  SOURCE_CHANGE_STATUSES,
} from '@tms/domain';
import { PriceField } from '../../common/price-fields';
import { CleanText, IsNullable, IsOptionalNotNull } from '../master/master-kit';

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
  @ApiPropertyOptional({
    type: String,
    example: 'cus_3f2a…',
    nullable: true,
    description: 'ลูกค้าใน master',
  })
  @Allow()
  id?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: 'C-001',
    nullable: true,
    description:
      'รหัสลูกค้าตามระบบต้นทาง — จับคู่กับ customer.externalId (ไม่พบ = ใบค้าง CUSTOMER_UNMAPPED)',
  })
  @Allow()
  externalId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'ชื่อ/ข้อความลูกค้าตามต้นทาง' })
  @Allow()
  name?: string | null;
}

export class OrderStopInputDto {
  @ApiProperty({ enum: STOP_TYPES })
  @Allow()
  type!: (typeof STOP_TYPES)[number];

  @ApiPropertyOptional({
    type: String,
    example: 'loc_3f2a…',
    nullable: true,
    description: 'สถานที่ใน master — ไม่ส่ง = ใช้ `siteText` (ใบค้าง LOCATION_UNMAPPED)',
  })
  @Allow()
  siteId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description: 'ข้อความสถานที่ตามต้นทาง (บังคับเมื่อไม่มี siteId)',
  })
  @Allow()
  siteText?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '2026-11-12T07:00:00+07:00',
    nullable: true,
    description: 'ISO 8601 พร้อม timezone',
  })
  @Allow()
  windowStart?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'ISO 8601 พร้อม timezone (≥ windowStart)',
  })
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

  @ApiPropertyOptional({
    type: String,
    example: 'unt_3f2a…',
    nullable: true,
    description: 'หน่วยใน master',
  })
  @Allow()
  unitId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'ข้อความหน่วย (บังคับเมื่อไม่มี unitId)',
  })
  @Allow()
  unit?: string | null;

  @ApiPropertyOptional({ type: String, example: 'prd_3f2a…', nullable: true })
  @Allow()
  productId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'รหัสสินค้าตามต้นทาง' })
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
    type: String,
    example: 'cmp_3f2a…',
    nullable: true,
    description:
      'นิติบุคคลที่ออกบิล (`cmp_…` จาก `GET /v1/companies`) — ไม่ส่ง = "ออกบิลในนาม" ของลูกค้า → ค่าตั้งต้นของบริษัท → นิติบุคคลเดียวที่ใช้งานอยู่; บริษัทมีหลายนิติบุคคลและไม่ได้ตั้งค่าใดเลย = 422 `routing_not_configured` (errors[].field = `billingCompanyId`) · ใบเดิมไม่ส่ง = คงของเดิม',
  })
  @Allow()
  billingCompanyId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 50,
    description: 'เลข PO / อ้างอิงของลูกค้า',
  })
  @Allow()
  customerRef?: string | null;

  @ApiProperty({ example: '2026-11-12', description: 'วันรับของ YYYY-MM-DD (ใช้หา rate)' })
  @Allow()
  requestedDate!: string;

  @ApiPropertyOptional({ type: String, example: 'vty_3f2a…', nullable: true })
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
    type: String,
    example: 'PO-2026-0001',
    nullable: true,
    maxLength: 100,
    description:
      'externalRef ของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง — ผิด = 422) — unique ต่อบริษัท; มีใบเดิมจากช่องทางเดียวกัน = อัปเดตใบเดิม (เหมือน PUT external)',
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

export class OrderMatchCandidateDto {
  @ApiProperty({ example: 'loc_3f2a…', description: 'id สาธารณะ (loc_ สถานที่ / cus_ ลูกค้า)' })
  id!: string;
  @ApiProperty({ example: 'LOC-00012' }) code!: string;
  @ApiProperty({ example: 'คลังสินค้าบางนา' }) name!: string;
  @ApiProperty({ example: 0.82, description: 'ความคล้าย 0–1 (1 = ตรงตัวหลัง normalize)' })
  score!: number;
}

export class OrderCustomerMatchDto {
  @ApiProperty({
    nullable: true,
    enum: ['INPUT', 'EXTERNAL_ID', 'ALIAS', 'MANUAL'],
    description:
      'ได้ลูกค้ามาอย่างไร (ST3-T06): INPUT = ระบุ id มา · EXTERNAL_ID = รหัสต้นทางตรง externalId ของลูกค้า · ' +
      'ALIAS = รหัส/ชื่อที่คนเคยจับคู่ไว้ · MANUAL = คนเลือก · null = ยังไม่ได้',
  })
  method!: string | null;
  @ApiProperty({
    type: [OrderMatchCandidateDto],
    description:
      'ลูกค้าที่ชื่อคล้าย (แนะนำเมื่อยังจับคู่ไม่ได้ — ระบบไม่จับคู่ลูกค้าเองด้วยความคล้าย)',
  })
  candidates!: OrderMatchCandidateDto[];
}

export class OrderCustomerDto {
  @ApiProperty({ nullable: true, type: String, description: 'null = ยังจับคู่ลูกค้าไม่ได้' })
  id!: string | null;
  @ApiProperty({ nullable: true, type: String }) code!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อลูกค้าใน master' })
  legalName!: string | null;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ข้อความลูกค้าตามต้นทาง' })
  name!: string | null;
  @ApiProperty({ type: OrderCustomerMatchDto }) match!: OrderCustomerMatchDto;
}

export class OrderHoldReasonDto {
  @ApiProperty({ example: 'RATE_MISSING' }) code!: string;
  @ApiProperty({ example: 'ไม่มีเรท' }) label!: string;
  @ApiProperty({ nullable: true, type: String, description: 'รายละเอียดเหตุค้าง (ไทย)' })
  note!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'stops[1].site',
    description:
      'ช่องที่เป็นต้นเหตุ (เหตุของทางเข้า: `customer`, `stops[i].site`, `stops.pickup`, `pricing`, `source`) · เหตุที่ flow อื่นตั้ง = null',
  })
  field!: string | null;
  @ApiProperty({
    type: [String],
    example: ['stops[0].site', 'stops[2].site'],
    description:
      'ช่องต้นเหตุทั้งหมดของเหตุหลัก (เช่น ทุกจุดที่หาพิกัดไม่ได้ของ GEOCODING_ERROR) — `field` = ช่องแรก · เหตุที่ flow อื่นตั้ง = []',
  })
  fields!: string[];
}

export class OrderStopMatchDto {
  @ApiProperty({
    nullable: true,
    enum: ['ALIAS', 'NAME', 'FUZZY', 'MANUAL'],
    description:
      'ได้สถานที่มาอย่างไร (ST3-T06): ALIAS = ข้อความตรง alias ที่เรียนรู้ · NAME = ตรงชื่อสถานที่ · ' +
      'FUZZY = ความคล้ายเกินเกณฑ์ (ปิดในเฟส 0 — ความคล้ายเป็นรายการแนะนำเท่านั้น) · MANUAL = คนเลือก · null = ต้นทางระบุ siteId มาเอง หรือยังจับคู่ไม่ได้',
  })
  method!: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    example: 0.94,
    description: 'ความคล้ายตอนจับคู่อัตโนมัติ',
  })
  score!: number | null;
  @ApiProperty({
    type: [OrderMatchCandidateDto],
    description:
      'สถานที่ที่แนะนำเมื่อยังจับคู่ไม่ได้/กำกวม (หน้าใบค้าง) — เรียงคะแนนมาก → น้อย ≤ 5',
  })
  candidates!: OrderMatchCandidateDto[];
}

export class OrderStopDto {
  @ApiProperty() sequence!: number;
  @ApiProperty({ enum: STOP_TYPES }) type!: string;
  @ApiProperty({ nullable: true, type: String }) siteId!: string | null;
  @ApiProperty() siteText!: string;
  @ApiProperty({ nullable: true, type: String }) windowStart!: string | null;
  @ApiProperty({ nullable: true, type: String }) windowEnd!: string | null;
  @ApiProperty({ type: OrderStopMatchDto }) match!: OrderStopMatchDto;
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

/** ST4-T10 บรรทัดราคาขายสำหรับวางบิล (ตามแผน หรือ ตามยอดส่งจริง) — ทั้งก้อนอยู่ใต้ `sellBilling` */
export class OrderBillingChargeDto {
  @ApiProperty() lineNo!: number;
  @ApiProperty({ enum: ['FREIGHT', 'EXTRA_STOP', 'ACCESSORIAL'] }) kind!: string;
  @ApiProperty({ example: 'RATE_CARD' }) origin!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ example: '15', description: 'จำนวนตามใบสั่ง (snapshot ของบรรทัด)' })
  qtyPlanned!: string;
  @ApiProperty({ example: '13.5', description: 'จำนวนที่ใช้คิดเงิน (ค่าแสดงผล ≤ 4 ตำแหน่ง)' })
  qty!: string;
  @ApiProperty({ example: '13.5', description: 'จำนวนเต็มความละเอียด (ทศนิยมครบ หรือ "n/d")' })
  qtyExact!: string;
  @ApiProperty({ example: '350.00' })
  @PriceField('sell')
  sellUnitPrice!: string;
  @ApiProperty({ example: '5250.00', description: 'ยอดตามใบสั่ง' })
  @PriceField('sell')
  sellPlannedAmount!: string;
  @ApiProperty({ example: '4725.00', description: 'ยอดที่วางบิล' })
  @PriceField('sell')
  sellAmount!: string;
  @ApiProperty() minChargeApplied!: boolean;
  @ApiProperty({ example: 'EXEMPT_TRANSPORT', description: 'snapshot — ไม่เปลี่ยนตามยอดส่งจริง' })
  vatType!: string;
  @ApiProperty({ example: '1.00' }) whtRate!: string;
  @ApiProperty({ description: 'ยอดวางบิลต่างจากใบสั่ง' }) adjusted!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'ตัน',
    description:
      'หน่วยของ `qty` เมื่อคิดใหม่ตามยอดส่งจริง (หน่วยของสูตรราคา) — บรรทัดที่ไม่คิดใหม่ = null',
  })
  qtyUnit!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    enum: ['MANUAL_PRICE', 'NOT_QTY_BASED'],
    description:
      'เหตุที่ไม่คิดใหม่: MANUAL_PRICE = ค่าขนส่งที่คนกำหนดเป็นยอดเหมา (ราคาที่กำหนดเองชนะ rate card) · NOT_QTY_BASED = สูตรเหมาเที่ยว/ตามระยะทาง ยอดไม่ขึ้นกับจำนวนสินค้า',
  })
  note!: string | null;
}

/**
 * ST4-T10 **ยอดประมาณ** สำหรับวางบิลของใบสั่ง (docs/04 E2 "วางบิลตามยอดส่งจริงได้ (ตั้งต่อลูกค้า)") — คำนวณทุกครั้งที่อ่าน (ไม่เก็บ)
 * ไม่ผูกพัน/ยังไม่ใช้ออกใบแจ้งหนี้: กติกาเงิน [OPEN spec/12 §3] รวมความต่างกับ docs/01 §3.3 (revenue ต่อ DO)
 * ลูกค้าตั้ง "ตามยอดส่งจริง" → บรรทัดค่าขนส่งของสูตรตามน้ำหนัก/ปริมาตร/หน่วยนับ คิดใหม่ด้วย engine เดิมจาก rate card ฉบับที่ใช้
 * + จำนวนส่งจริงรวมของ DO ที่ไม่ยกเลิก · ค่าจุดเพิ่ม/ค่าบริการเสริม/ราคาที่กำหนดเองไม่เปลี่ยน · VAT/WHT ตาม snapshot ของบรรทัด
 */
export class OrderBillingDto {
  @ApiProperty({
    enum: [true],
    type: Boolean,
    description:
      '**ยอดประมาณ — ยังไม่ใช้ออกใบแจ้งหนี้** (กติกาเงินของ "วางบิลตามยอดส่งจริง" ยัง OPEN ใน spec/12 §3 — ต้องให้ PO/นักบัญชีตัดสินก่อน ST5-T01) · ห้ามใช้เป็นยอดผูกพัน',
  })
  preview!: true;
  @ApiProperty({
    enum: ['PLANNED', 'ACTUAL'],
    description: 'ตั้งค่าของลูกค้า: ตามใบสั่ง / ตามยอดส่งจริง',
  })
  basis!: 'PLANNED' | 'ACTUAL';
  @ApiProperty({
    enum: ['PLANNED', 'NOT_RECORDED', 'ACTUAL', 'CALCULATION_FAILURE'],
    description:
      'PLANNED = ลูกค้าวางบิลตามใบสั่ง · NOT_RECORDED = ตามยอดจริงแต่ยังไม่มียอดส่งจริง (ใช้ยอดใบสั่ง) · ACTUAL = คิดตามยอดส่งจริงแล้ว · CALCULATION_FAILURE = คิดไม่ได้ (เช่น ส่งได้ 0) ต้องให้คนกำหนด',
  })
  status!: string;
  @ApiProperty({ description: 'มี DO ของใบนี้ที่บันทึกยอดส่งจริงแล้ว' }) actualRecorded!: boolean;
  @ApiProperty({ type: [OrderBillingChargeDto] }) charges!: OrderBillingChargeDto[];
  @ApiProperty({ nullable: true, type: String, example: '5250.00' })
  @PriceField('sell')
  sellPlannedTotal!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '4725.00',
    description: 'null = คิดไม่ได้',
  })
  @PriceField('sell')
  sellBillableTotal!: string | null;
  @ApiProperty({ type: [OrderPricingReasonDto] }) reasons!: OrderPricingReasonDto[];
}

/** ช่องหนึ่งของ diff ต้นทาง (ค่าแสดงผล — ไม่มีราคา) */
export class SourceChangeEntryDto {
  @ApiProperty({ enum: SO_FIELD_GROUPS, example: 'stops' }) group!: string;
  @ApiProperty({ example: 'stops[1].siteId', description: 'path ของช่อง' }) field!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'คลังสินค้า บางนา',
    description: 'ค่าใน TMS',
  })
  before!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'คลังสินค้า ลาดกระบัง',
    description: 'ค่าตามต้นทาง',
  })
  after!: string | null;
  @ApiProperty({
    enum: ['text', 'date', 'datetime'],
    description: 'วิธีแสดงค่า: date = YYYY-MM-DD, datetime = ISO 8601',
  })
  kind!: string;
}

/** ชุดการเปลี่ยนแปลงจากต้นทางที่รอตัดสิน (ST3-T10) */
export class OrderSourceChangeDto {
  @ApiProperty({ example: 'osc_3f2a…' }) id!: string;
  @ApiProperty({ enum: SOURCE_CHANGE_STATUSES }) status!: string;
  @ApiProperty({ example: 'ERP:krs', description: 'ต้นทางที่ส่งมา' }) source!: string;
  @ApiProperty({ enum: SO_STATUS_VALUES, description: 'สถานะใบตอนต้นทางส่งมา' })
  orderStatus!: string;
  @ApiProperty({ description: 'เวลาที่ต้นทางส่งมา' }) receivedAt!: string;
  @ApiProperty({ type: [SourceChangeEntryDto] }) changes!: SourceChangeEntryDto[];
}

export class CancelOrderDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'ลูกค้ายกเลิกคำสั่งทางอีเมล' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'rsn_3f2a…',
    description: 'เหตุผลมาตรฐานหมวด CANCEL (ไม่บังคับ)',
  })
  @IsOptional()
  @IsNullable()
  @Matches(/^rsn_[0-9a-f]{32}$/)
  reasonCodeId?: string | null;
}

export class SourceChangeDecisionDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'ลูกค้ายืนยันเปลี่ยนจุดส่งทางโทรศัพท์' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
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
  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-11-18',
    description:
      'ST4-T12 วันที่นัดส่งใหม่ล่าสุดของ DO ส่งใหม่ที่ยังรอจัด (null = ไม่มี) — หน้าใบค้าง/รายการแสดงแทนกำหนดส่งเดิม',
  })
  rescheduledDate!: string | null;
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
  @ApiPropertyOptional({
    type: OrderBillingDto,
    description:
      'ST4-T10 **ยอดประมาณ (preview, ไม่ผูกพัน)** ของการวางบิล (ตามใบสั่ง / ตามยอดส่งจริงตามที่ตั้งในลูกค้า) — ยังไม่ใช้ออกใบแจ้งหนี้ (กติกา OPEN) · มีเฉพาะ GET ทีละใบและผลของการเขียน · เห็นเมื่อมี `prices.sell:read`',
  })
  @PriceField('sell')
  sellBilling?: OrderBillingDto;
  @ApiProperty({ type: [OrderStopDto] }) stops!: OrderStopDto[];
  @ApiProperty({ type: [OrderLineDto] }) lines!: OrderLineDto[];
  @ApiPropertyOptional({
    type: [String],
    enum: SO_FIELD_GROUPS,
    description:
      'ช่องที่แก้ได้ในสถานะปัจจุบัน (spec/03 ORD-032) — มีเฉพาะ GET ทีละใบและผลของ POST/PUT/PATCH (ไม่อยู่ในรายการ) · ' +
      'ว่าง = แก้ไม่ได้ (ปิดงาน/ยกเลิก) · ฟอร์มใช้ปิดช่องที่แก้ไม่ได้ก่อนส่ง (server ตรวจซ้ำ → 409 `order_locked_for_update`)',
  })
  editableFields?: string[];
  @ApiProperty({
    description:
      'ต้นทาง (connector) แก้ใบหลังวางแผน — ไม่ทับข้อมูล รอคนรับ/ไม่รับ (`sourceChange`) · สถานะใบไม่เปลี่ยน (docs/01 §4.1)',
  })
  sourceChangedAfterPlan!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'ST8-T05 ต้นทาง (ERP connector) แจ้งว่ายกเลิกใบนี้ — ใบที่ยังไม่มี DO ถูกยกเลิกอัตโนมัติ (`status = cancelled`) · ' +
      'มี DO แล้ว = ไม่ยกเลิก แจ้งเตือนผู้วางแผนให้ตรวจและยกเลิกเอง · null = ต้นทางไม่ได้ยกเลิก',
  })
  sourceCancelledAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: OrderSourceChangeDto,
    description:
      'ชุดการเปลี่ยนแปลงจากต้นทางที่รอตัดสิน (รับ: POST …/source-changes/{changeId}/accept · ไม่รับ: …/reject)',
  })
  sourceChange!: OrderSourceChangeDto | null;
  @ApiPropertyOptional({
    type: () => OrderEditLockDto,
    nullable: true,
    description:
      'ผู้ที่เปิดแก้ใบนี้อยู่ (ST3-T08 — ล็อกที่ยังไม่หมดอายุ) · null = ไม่มีใครแก้ · มีเฉพาะ GET ทีละใบและผลของ POST/PUT/PATCH (ไม่อยู่ในรายการ)',
  })
  editLock?: OrderEditLockDto | null;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/** ล็อกการแก้จากหน้าจอ (ST3-T08; docs/04 C Edit lock) — หมดอายุเมื่อไม่มีกิจกรรม 10 นาที */
export class OrderEditLockDto {
  @ApiProperty({ example: 'usr_3f2a…', description: 'ผู้ถือล็อก' }) userId!: string;
  @ApiProperty({ example: 'สมชาย ใจดี', description: 'ชื่อผู้ถือล็อก (ป้าย "กำลังแก้ไขโดย …")' })
  userName!: string;
  @ApiProperty({ format: 'date-time' }) acquiredAt!: string;
  @ApiProperty({ format: 'date-time', description: 'กิจกรรมล่าสุด' }) lastSeenAt!: string;
  @ApiProperty({
    format: 'date-time',
    description: 'หมดอายุ = กิจกรรมล่าสุด + 10 นาที — หลังเวลานี้คนอื่นขอล็อกได้ทันที',
  })
  expiresAt!: string;
  @ApiProperty({ description: 'ผู้เรียกเป็นผู้ถือล็อกเอง' }) mine!: boolean;
}

/** ขอล็อก (ST3-T08) — ไม่ส่ง/`heartbeat: false` = เปิดแก้ (ล้างการแจ้งว่าถูกปลด) · `heartbeat: true` = ต่ออายุระหว่างแก้ */
export class OrderLockDto {
  @ApiPropertyOptional({
    description:
      'true = ต่ออายุระหว่างแก้ (หน้าจอส่งเมื่อผู้ใช้มีกิจกรรม) — ถ้าล็อกเดิมถูกผู้อื่นปลดแล้วได้ 409 `order_lock_released` ' +
      '(ไม่ได้ล็อกคืนเอง) · ไม่ส่ง/false = เปิดแก้ใหม่',
  })
  @IsOptional()
  @IsBoolean()
  heartbeat?: boolean;
}

/** ปลดล็อก — ของตัวเองไม่ต้องมีเหตุผล · ปลดของคนอื่น (`orders:unlock`) ต้องมีเหตุผล ≥ 10 ตัวอักษร (ลง audit) */
export class OrderUnlockDto {
  @ApiPropertyOptional({
    maxLength: 500,
    example: 'ผู้แก้ลาป่วย ต้องแก้วันรับของด่วน',
    description: 'บังคับ (≥ 10 ตัวอักษร) เมื่อปลดล็อกของผู้ใช้อื่น',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** ตัวนับของหน้ารายการใบสั่งขนส่ง (แถบสรุป + แท็บ — ต้นแบบ TMS v4 kpisX('so')) */
export class OrderSummaryDto {
  @ApiProperty({ description: 'ทุกใบ (รวมร่าง)' }) total!: number;
  @ApiProperty({ description: 'ร่าง (ยังไม่ออกเลข SO)' }) draft!: number;
  @ApiProperty({ description: 'ค้าง (ON_HOLD) ทุกเหตุ' }) onHold!: number;
  @ApiProperty({
    description: 'ค้างเพราะจับคู่สถานที่ไม่ได้ (LOCATION_UNMAPPED) — "รอกำหนดเส้นทาง"',
  })
  locationUnmapped!: number;
  @ApiProperty({ description: 'ค้างเพราะจับคู่ลูกค้าไม่ได้ (CUSTOMER_UNMAPPED)' })
  customerUnmapped!: number;
  @ApiProperty({
    description:
      'เกินกำหนด: ยังไม่ออกรถ (RECEIVED/ON_HOLD/PLANNED) และวันรับของก่อนวันนี้ (เวลาไทย)',
  })
  overdue!: number;
  @ApiProperty({ description: 'วางแผนแล้ว (PLANNED) ทั้งหมด' }) planned!: number;
  @ApiProperty({ description: 'วางแผนแล้ว (PLANNED) ที่วันรับของ = วันนี้ (เวลาไทย)' })
  plannedToday!: number;
  @ApiProperty({
    description:
      'หน้าใบค้าง (ST3-T07): ใบค้างทั้งหมด = ON_HOLD + ใบที่ต้นทางแก้หลังวางแผนรอตัดสิน (สถานะ PLANNED — เงื่อนไขเดียวกับ `held=true`)',
  })
  heldTotal!: number;
  @ApiProperty({
    type: () => [OrderHoldCountDto],
    description:
      'หน้าใบค้าง (ST3-T07): จำนวนใบค้างต่อเหตุ ครบ 12 รหัสของ docs/04 C (ไม่มี = 0) — นับเหตุหลักหรือเหตุรอง ' +
      '(เงื่อนไขเดียวกับตัวกรอง `held=true&holdReason=`) ใบหนึ่งจึงอาจนับในหลายเหตุ · ' +
      'SOURCE_CHANGED_AFTER_PLAN = ใบที่ต้นทางแก้หลังวางแผน (สถานะยัง PLANNED)',
  })
  holdReasons!: OrderHoldCountDto[];
  @ApiProperty({
    example: '2026-11-18',
    description: 'ST9-T01 วันนี้ตามเวลาไทยที่ใช้นับ `waiting*`',
  })
  today!: string;
  @ApiProperty({
    description:
      'ST9-T01 รอจัดรถ (spec/09 §1) = ยังไม่อยู่ในเที่ยว (รับแล้ว + ค้าง) และวันรับของ ≤ วันนี้ + 1 — เงื่อนไขเดียวกับ `status=received,on_hold&requestedTo={today+1}`',
  })
  waiting!: number;
  @ApiProperty({
    description: 'ST9-T01 รอจัดรถที่เลยกำหนดรับ = `status=received,on_hold&requestedTo={today−1}`',
  })
  waitingOverdue!: number;
}

export class OrderHoldCountDto {
  @ApiProperty({ enum: ORDER_HOLD_CODES, example: 'CUSTOMER_UNMAPPED' }) code!: string;
  @ApiProperty() count!: number;
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

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'หน้าใบค้าง (ST3-T07): true = เฉพาะใบค้าง (ON_HOLD + ใบที่ต้นทางแก้หลังวางแผนรอตัดสิน ซึ่งสถานะยัง PLANNED) · ' +
      'false = ไม่รวมใบค้างทั้งสองแบบ — ใช้คู่กับ `holdReason` ได้',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  held?: 'true' | 'false';

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

// ---------- จับคู่ด้วยมือ + เรียนรู้ alias (ST3-T06) ----------

export class MapStopSiteDto {
  @ApiProperty({
    example: 'loc_3f2a…',
    description: 'สถานที่ (ของลูกค้าของใบ หรือของบริษัท) ที่ใช้งานอยู่',
  })
  @IsString()
  @MaxLength(100)
  siteId!: string;
}

export class MapCustomerDto {
  @ApiProperty({ example: 'cus_3f2a…', description: 'ลูกค้าที่ใช้งานอยู่' })
  @IsString()
  @MaxLength(100)
  customerId!: string;

  @ApiPropertyOptional({
    description:
      'รหัส/ชื่อตามต้นทางนี้เคยจับคู่กับลูกค้ารายอื่น (409 `alias_conflict`) → ส่ง true + `reason` เพื่อย้ายมาลูกค้านี้',
  })
  @IsOptional()
  @IsBoolean()
  confirmReassign?: boolean;

  @ApiPropertyOptional({
    minLength: 10,
    maxLength: 500,
    description: 'เหตุผลการย้าย (บังคับเมื่อ confirmReassign = true, ≥ 10 ตัวอักษร — ลง audit)',
  })
  @ValidateIf((o: MapCustomerDto) => o.confirmReassign === true || o.reason !== undefined)
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason?: string;
}

export class ResolveSourceErrorDto {
  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    example: 'ตรวจกับเอกสารต้นฉบับแล้ว แก้วันรับของและจำนวนในใบให้ถูกต้อง',
    description:
      'เหตุผลที่ยืนยันว่าข้อมูลใบใช้ได้แม้ต้นทางแจ้งว่าไม่ครบ (≥ 10 ตัวอักษร — ลง audit)',
  })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class ManualPriceDto {
  @ApiProperty({
    example: '4200.00',
    type: String,
    description:
      'ค่าขนส่งที่กำหนดเอง (บาท ก่อน VAT, > 0, ทศนิยม ≤ 2) — ต้องมีสิทธิ์ `prices.sell:write` (ไม่มี → 403)',
  })
  @PriceField('sell')
  @IsString()
  @Matches(/^\d{1,12}(\.\d{1,2})?$/, {
    message: 'sellAmount must be a decimal string with ≤ 2 decimals',
  })
  sellAmount!: string;

  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    example: 'ลูกค้ารายใหม่ ยังไม่มีสัญญาราคา ตกลงราคาทางโทรศัพท์',
    description: 'เหตุผลที่กำหนดราคาเอง (≥ 10 ตัวอักษร — ลง audit)',
  })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class OrderMapResultDto extends OrderDto {
  @ApiProperty({
    enum: [
      'learned',
      'exists',
      'name',
      'full',
      'too_long',
      'empty',
      'generic',
      'conflict',
      'not_permitted',
    ],
    description:
      'ผลการเรียนรู้ alias (ใบนี้จับคู่แล้วทุกกรณี): learned = จำแล้ว (ใบถัดไปข้อความเดิมจับคู่เอง) · exists = จำไว้แล้ว · ' +
      'name = ข้อความตรงชื่อสถานที่อยู่แล้ว · full = alias ครบ 50 · too_long = ข้อความยาวเกิน · empty = ไม่มีข้อความ · ' +
      'generic = ข้อความทั่วไป/สั้นเกินไป (เช่น "คลัง", "เงินสด") ไม่จำ · conflict = ข้อความนี้เป็นชื่อ/alias ของสถานที่อื่น ' +
      'ในขอบเขตเดียวกัน ไม่จำ · not_permitted = สถานที่ของบริษัท (มีผลกับทุกลูกค้า) ต้องมีสิทธิ์ `master:write` จึงจำ',
  })
  aliasLearning!: string;
}
