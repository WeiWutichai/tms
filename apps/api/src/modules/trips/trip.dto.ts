import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TRIP_STATUSES, type TripStatus } from '@tms/domain';
import { ListQuery } from '../../common/pagination';
import { PriceField } from '../../common/price-fields';
import { CleanText, IsNullable } from '../master/master-kit';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DO_ID = /^do_[0-9a-f]{32}$/;
const VEH_ID = /^veh_[0-9a-f]{32}$/;
const DRV_ID = /^drv_[0-9a-f]{32}$/;
const STP_ID = /^stp_[0-9a-f]{32}$/;
const TRP_ID = /^trp_[0-9a-f]{32}$/;

export class TripListQuery extends ListQuery {
  @ApiPropertyOptional({
    description: `สถานะ คั่นด้วย , (${TRIP_STATUSES.join(' / ')})`,
    example: 'PLANNING,ASSIGNED',
  })
  @IsOptional()
  @Matches(new RegExp(`^(${TRIP_STATUSES.join('|')})(,(${TRIP_STATUSES.join('|')}))*$`))
  status?: string;

  @ApiPropertyOptional({ example: '2026-11-13', description: 'วันที่เที่ยวตั้งแต่ (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE_RE)
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-11-13', description: 'วันที่เที่ยวถึง (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE_RE)
  dateTo?: string;

  @ApiPropertyOptional({ example: 'veh_3f2a…' })
  @IsOptional()
  @Matches(VEH_ID)
  vehicleId?: string;

  @ApiPropertyOptional({ example: 'drv_3f2a…', description: 'คนขับหลักหรือคนขับสำรอง' })
  @IsOptional()
  @Matches(DRV_ID)
  driverId?: string;

  @ApiPropertyOptional({ example: 'car_3f2a…' })
  @IsOptional()
  @Matches(/^car_[0-9a-f]{32}$/)
  carrierId?: string;
}

class DeliveryOrderIdsDto {
  @ApiProperty({
    type: [String],
    example: ['do_3f2a…'],
    description: 'ใบส่งของ (DRAFT ไม่อยู่ในเที่ยวอื่น)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @Matches(DO_ID, { each: true })
  deliveryOrderIds!: string[];
}

/**
 * ST3-T14 (D-07 PO 16 พ.ย. 2569) — ยืนยัน/ยกเว้นกฎตอนจัดในคำขอเดียวกัน (create + รถ / schedule / assign / dispatch)
 * บล็อก (กฎเอกสาร/ใบขับขี่) ไม่ยกเว้น → 409 `assignment_blocked` · คำเตือนที่ไม่ยืนยัน → บันทึกได้ แต่ปล่อยรถไม่ได้ (409 `assignment_warnings`)
 */
export class RuleConfirmDto {
  @ApiPropertyOptional({
    type: [String],
    maxItems: 50,
    example: ['OVERWEIGHT|v=…'],
    description:
      'กุญแจของกฎที่ค้างที่ผู้ใช้ยกเว้น/ยืนยัน (`warnings[].key` หรือ `blocks[].key`/`warnings[].key` ของ 409) — ' +
      'มีผลเฉพาะกฎเหล่านี้ · กุญแจที่ไม่ค้างแล้ว → 422 `not_pending` · บล็อกต้องมี scope `trips:override` · ต้องมี `overrideReason`',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(400, { each: true })
  ruleKeys?: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 10,
    maxLength: 500,
    example: 'ลูกค้ายืนยันรับของเกินพิกัด แยกส่งรอบบ่ายไม่ได้',
    description: 'เหตุผล ≥ 10 ตัวอักษร (บันทึกใน audit)',
  })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(500)
  overrideReason?: string | null;
}

export class CreateTripDto extends IntersectionType(DeliveryOrderIdsDto, RuleConfirmDto) {
  @ApiProperty({ example: '2026-11-13', description: 'วันที่เที่ยว (YYYY-MM-DD)' })
  @Matches(DATE_RE)
  tripDate!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '2026-11-13T08:00:00+07:00',
    description: 'เริ่มวิ่งตามแผน',
  })
  @IsOptional()
  @IsNullable()
  @IsISO8601({ strict: true })
  plannedStartAt?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '2026-11-13T17:00:00+07:00',
    description: 'จบตามแผน (≥ เริ่ม)',
  })
  @IsOptional()
  @IsNullable()
  @IsISO8601({ strict: true })
  plannedEndAt?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'veh_3f2a…',
    description:
      'รถที่วางแผนไว้ (กระดานวางแผน — ลาก SO ลงแถวรถ) · เที่ยวยังเป็น PLANNING ไม่มีคนขับ — จัดรถจริงที่ /assign',
  })
  @IsOptional()
  @IsNullable()
  @Matches(VEH_ID)
  vehicleId?: string | null;
}

/** ย้าย/ปรับขนาดเที่ยวบนกระดาน — ไม่ส่งช่องไหน = คงค่าเดิม */
export class ScheduleTripDto extends RuleConfirmDto {
  @ApiPropertyOptional({ example: '2026-11-13', description: 'วันที่เที่ยว (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE_RE)
  tripDate?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-11-13T08:00:00+07:00' })
  @IsOptional()
  @IsNullable()
  @IsISO8601({ strict: true })
  plannedStartAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-11-13T11:00:00+07:00' })
  @IsOptional()
  @IsNullable()
  @IsISO8601({ strict: true })
  plannedEndAt?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'veh_3f2a…',
    description: 'ย้ายไปรถคันอื่น (เฉพาะ PLANNING — ASSIGNED ใช้ /assign) · null = ถอดรถที่วางไว้',
  })
  @IsOptional()
  @IsNullable()
  @Matches(VEH_ID)
  vehicleId?: string | null;
}

export class AttachDeliveryOrdersDto extends DeliveryOrderIdsDto {}

/** ST3-T16 เรียงจุดแวะเอง — id ของจุดที่ยังใช้ครบทุกจุดตามลำดับใหม่ */
export class ReorderStopsDto {
  @ApiProperty({
    type: [String],
    example: ['stp_3f2a…', 'stp_8c1d…', 'stp_77b0…'],
    description:
      'จุดแวะทุกจุดของเที่ยว (`stops[].id`) ตามลำดับใหม่ — ขาด/เกิน/ซ้ำ → 422 `stop_set_mismatch` · ' +
      'จุดส่งของใบส่งของอยู่ก่อนจุดรับของใบเดียวกัน → 422 `stop_order_invalid`',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @Matches(STP_ID, { each: true })
  stopIds!: string[];
}

export class DetachDeliveryOrdersDto extends DeliveryOrderIdsDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500, example: 'ย้ายไปรถคันอื่น' })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class AssignTripDto extends RuleConfirmDto {
  @ApiProperty({ example: 'veh_3f2a…', description: 'รถหลัก (ไม่ใช่หาง)' })
  @Matches(VEH_ID)
  vehicleId!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'drv_3f2a…',
    description: 'คนขับ — ไม่ส่ง = คนขับประจำของรถ (มีคนเดียว) · รถบริษัทต้องมีคนขับ',
  })
  @IsOptional()
  @IsNullable()
  @Matches(DRV_ID)
  driverId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'drv_3f2a…',
    description: 'คนขับสำรอง (งานทางไกล)',
  })
  @IsOptional()
  @IsNullable()
  @Matches(DRV_ID)
  reliefDriverId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'veh_3f2a…',
    description: 'หาง (รถที่ unitRole = TRAILER)',
  })
  @IsOptional()
  @IsNullable()
  @Matches(VEH_ID)
  trailerId?: string | null;

  @ApiPropertyOptional({
    description:
      'ST3-T17 "จัดรถและปล่อยเที่ยว" (docs/04 D2 Assign & dispatch) — จัดรถแล้วปล่อยรถในคำขอเดียว (atomic: ปล่อยไม่ได้ = ไม่จัดรถด้วย) · ' +
      'ต้องมี scope `trips:dispatch` เพิ่ม · ตรวจกฎแบบตอนปล่อยรถ: คำเตือนที่ยังไม่ยืนยัน → 409 `assignment_warnings`',
  })
  @IsOptional()
  @IsBoolean()
  dispatch?: boolean;
}

/** ปล่อยรถ — ยืนยัน/ยกเว้นกฎที่ค้างในคำขอนี้ได้ (ST3-T14) */
export class DispatchTripDto extends RuleConfirmDto {}

/** เที่ยว 1 รายการของคำขอทำหลายเที่ยว (ST3-T17) */
export class BulkTripItemDto {
  @ApiProperty({ example: 'trp_3f2a…' })
  @Matches(TRP_ID)
  tripId!: string;

  @ApiPropertyOptional({
    example: 3,
    description: '`version` ที่ผู้ใช้เห็น (แทน If-Match ต่อรายการ) — ไม่ตรง → รายการนั้น 412',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  version?: number;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 50,
    description: 'กุญแจกฎที่ยกเว้น/ยืนยันของเที่ยวนี้ (ใช้ `overrideReason` ของคำขอ)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(400, { each: true })
  ruleKeys?: string[];
}

/**
 * จัดรถ / จัดรถและปล่อยเที่ยว หลายเที่ยว (ST3-T17 bulk — docs/04 D2, spec/03 PLN-047/048)
 * แต่ละเที่ยวทำแยกกัน (สำเร็จบางรายการได้ — ไม่ใช่ all-or-nothing) · รถ = รถที่วางไว้/จัดไว้ของเที่ยว · คนขับ = คนขับประจำรถ (เที่ยว PLANNING)
 */
export class BulkAssignTripsDto {
  @ApiProperty({ type: [BulkTripItemDto], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BulkTripItemDto)
  items!: BulkTripItemDto[];

  @ApiPropertyOptional({
    description:
      'true = จัดรถและปล่อยเที่ยว (เที่ยวที่จัดรถแล้ว = ปล่อยอย่างเดียว) — ต้องมี scope `trips:dispatch` เพิ่ม',
  })
  @IsOptional()
  @IsBoolean()
  dispatch?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 10,
    maxLength: 500,
    description: 'เหตุผลการยกเว้น/ยืนยันกฎ (≥ 10 ตัวอักษร) — ใช้กับทุกรายการที่ส่ง `ruleKeys`',
  })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(500)
  overrideReason?: string | null;
}

/** ยกเว้น/ยืนยันกฎที่ค้างของเที่ยวภายหลัง — เฉพาะ `ruleKeys` ที่ส่ง (ST3-T14) */
export class ConfirmRulesDto {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: 50,
    description: 'กุญแจของกฎที่ค้าง (`warnings[].key`) — บล็อกต้องมี scope `trips:override`',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(400, { each: true })
  ruleKeys!: string[];

  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    example: 'ลูกค้ายืนยันรับของเกินพิกัด แยกส่งรอบบ่ายไม่ได้',
    description: 'เหตุผล ≥ 10 ตัวอักษร (บันทึกใน audit)',
  })
  @CleanText()
  @IsString()
  @MaxLength(500)
  overrideReason!: string;
}

/**
 * จ้างรถร่วม = เสนองาน (ST3-T22; docs/04 D3) — ทุกการจ้างมีราคาซื้อ (`trip_cost` CARRIER_FEE) และ `selectionReason`
 * ต้องมี `trips:assign` + `prices.buy:read`
 */
export class OfferTripDto {
  @ApiProperty({ example: 'car_3f2a…', description: 'รถร่วมที่จ้าง (ลิงก์รับงาน = ST3-T23)' })
  @Matches(/^car_[0-9a-f]{32}$/)
  carrierId!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '6800.00',
    description:
      'ราคาซื้อที่ตกลงต่อเที่ยว (บาท ก่อน VAT ก่อนหัก ณ ที่จ่าย, > 0, ทศนิยม ≤ 2) — ไม่ส่ง = ราคาตาม rate card ขาซื้อของรายนี้ ' +
      '(ไม่มี rate card → 422 `cost_required`)',
  })
  @IsOptional()
  @IsNullable()
  @Matches(/^\d{1,12}(\.\d{1,2})?$/)
  cost?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 10,
    maxLength: 500,
    example: 'รายที่ถูกกว่ารถไม่ว่างช่วงเช้า ลูกค้าต้องการรถเข้าก่อน 8 โมง',
    description:
      'เหตุผลที่เลือกรายนี้ — **บังคับ (≥ 10 ตัวอักษร)** เมื่อราคาที่จ้างสูงกว่ารายที่ถูกสุด หรือไม่มีราคาจาก rate card ให้เทียบ ' +
      '(422 `selection_reason_required`) · เลือกรายที่ถูกสุด = ระบบเขียนเหตุผลให้',
  })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(500)
  selectionReason?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'vty_3f2a…',
    description: 'ประเภทรถที่จ้าง (ใช้หา rate card ขาซื้อ) — ไม่ส่ง = ตามเที่ยว/ใบสั่งขาย',
  })
  @IsOptional()
  @IsNullable()
  @Matches(/^vty_[0-9a-f]{32}$/)
  vehicleTypeId?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'ST3-T24 "ส่งรายถัดไป" ระหว่างรอตอบ: true = ปิดการจ้างที่รอตอบซึ่งครบเวลาตอบ N ชม. แล้ว (WITHDRAWN — ลิงก์เดิมใช้ไม่ได้, ' +
      'ค่าจ้างเดิมกลับรายการ) แล้วจ้างรายนี้ในคำขอเดียว · ยังไม่ครบเวลา → 409 `offer_not_timed_out` · ไม่ส่ง = เที่ยวต้องเป็น PLANNING',
  })
  @IsOptional()
  @IsBoolean()
  replaceOffer?: boolean;
}

/** การจ้างรถร่วมที่ใช้งานอยู่ของเที่ยว (ST3-T22) */
export class TripHireDto {
  @ApiProperty({ example: 'sco_3f2a…' }) id!: string;
  @ApiProperty({ example: 'car_3f2a…' }) carrierId!: string;
  @ApiProperty({ enum: ['OFFERED', 'ACCEPTED'] }) status!: string;
  @ApiPropertyOptional({
    type: String,
    example: '6800.00',
    description: 'ราคาซื้อที่ตกลง (ก่อน VAT) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyAmount?: string;
  @ApiPropertyOptional({
    enum: ['RATE_CARD', 'MANUAL'],
    description:
      'RATE_CARD = ตามราคา rate card ขาซื้อของรายนี้ · MANUAL = กรอก/แก้ราคาเอง — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyPriceSource?: string;
  @ApiProperty({ nullable: true, type: String, example: 'RC-B-0001' }) rateCardCode!: string | null;
  @ApiPropertyOptional({
    enum: ['CHEAPEST', 'OVERRIDE'],
    description:
      'CHEAPEST = ราคาไม่เกินรายที่ถูกสุด · OVERRIDE = เลือกด้วยเหตุผลของผู้จ้าง — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buySelectionKind?: string;
  @ApiProperty({ description: 'เหตุผลการเลือก (ไม่ว่างเสมอ — docs/04 D3)' })
  selectionReason!: string;
  @ApiProperty({ nullable: true, type: String, description: 'ผู้จ้าง (actor id)' })
  offeredBy!: string | null;
  @ApiProperty() offeredAt!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'ST3-T24 ครบเวลาตอบ (เวลาเสนอ + N ชม. ตามค่าตั้ง `dispatch.subconResponseHours`) — เลยแล้วยังไม่ตอบ = แจ้งผู้จัดรถ + "ส่งรายถัดไป" ได้',
  })
  responseDueAt!: string | null;
}

export class CancelTripDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'ลูกค้ายกเลิกการส่งทั้งเที่ยว' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'rsn_3f2a…',
    description: 'เหตุผลมาตรฐานหมวด CANCEL',
  })
  @IsOptional()
  @IsNullable()
  @Matches(/^rsn_[0-9a-f]{32}$/)
  reasonCodeId?: string | null;
}

export class TripWarningDto {
  @ApiProperty({ example: 'vehicle_overlap' }) code!: string;
  @ApiProperty({
    enum: ['warning', 'block', 'info'],
    description:
      'block = กฎเอกสาร/ใบขับขี่ (D-07 — ยกเว้นได้โดย `trips:override`) · warning = ต้องยืนยันพร้อมเหตุผลก่อนปล่อยรถ · info = แจ้งเฉย ๆ',
  })
  severity!: 'warning' | 'block' | 'info';
  @ApiProperty({
    enum: ['compatibility', 'assignability', 'schedule', 'stops', 'assignment', 'load'],
  })
  source!: string;
  @ApiProperty({
    description:
      'ยกเว้น (block) / ยืนยัน (warning) แล้วสำหรับรถ + คนขับชุดนี้ — info เป็น true เสมอ',
  })
  confirmed!: boolean;
  @ApiProperty({ example: 'trip.vehicleOverlap' }) messageKey!: string;
  @ApiProperty({ description: 'ข้อความไทยพร้อมแสดง' }) message!: string;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'ค่าประกอบข้อความ' })
  params!: Record<string, unknown>;
}

export class TripRuleOverrideDto {
  @ApiProperty({ example: 'OVERWEIGHT' }) code!: string;
  @ApiProperty({ enum: ['block', 'warning'] }) severity!: 'block' | 'warning';
  @ApiProperty({ enum: ['OVERRIDE', 'ACKNOWLEDGE'], description: 'ยกเว้นบล็อก / ยืนยันคำเตือน' })
  kind!: 'OVERRIDE' | 'ACKNOWLEDGE';
  @ApiProperty({ example: 'ลูกค้ายืนยันรับของเกินพิกัด แยกส่งรอบบ่ายไม่ได้' }) reason!: string;
  @ApiProperty({ nullable: true, type: String, description: 'ผู้ยกเว้น/ยืนยัน (user id)' })
  actorId!: string | null;
  @ApiProperty() at!: string;
  @ApiProperty({ description: 'ข้อความกฎ ณ ตอนยกเว้น' }) message!: string;
  @ApiProperty({ description: 'ยังมีผล (ข้อเท็จจริงเปลี่ยน/แย่ลง = หมดผล)' }) active!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'หมดผลเมื่อ' }) supersededAt!:
    string | null;
  @ApiProperty({ nullable: true, enum: ['CHANGED', 'WORSENED'], type: String })
  supersededReason!: string | null;
}

export class TripStopDto {
  @ApiProperty({ example: 'stp_3f2a…' }) id!: string;
  @ApiProperty() sequence!: number;
  @ApiProperty({ enum: ['PICKUP', 'DELIVERY', 'RETURN'] }) type!: string;
  @ApiProperty({ example: 'loc_3f2a…' }) siteId!: string;
  @ApiProperty({ enum: ['PENDING', 'ARRIVED', 'COMPLETED', 'FAILED', 'SKIPPED'] }) status!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ช่วงเวลาที่ลูกค้าขอ (ส่วนที่ทุก DO รับได้)',
  })
  windowStart!: string | null;
  @ApiProperty({ nullable: true, type: String }) windowEnd!: string | null;
  @ApiProperty({ nullable: true, type: String }) plannedArrival!: string | null;
  @ApiProperty({ nullable: true, type: String }) plannedDeparture!: string | null;
  @ApiProperty({ type: [String], description: 'DO ที่รับ (PICKUP) / ส่ง (DELIVERY) ที่จุดนี้' })
  deliveryOrderIds!: string[];
  @ApiProperty({ example: 'คลังสินค้าบางนา', description: 'ชื่อสถานที่ (ปัจจุบัน)' })
  siteName!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '45.2',
    description: 'ST3-T16 ระยะช่วงวิ่งจากจุดก่อนหน้า (กม.) — จุดแรก/ไม่ทราบ = null',
  })
  legDistanceKm!: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    example: 55,
    description: 'เวลาเดินทางช่วงนี้ (นาที)',
  })
  legMinutes!: number | null;
  @ApiProperty({
    nullable: true,
    enum: ['ROUTE', 'ESTIMATE', 'SAME_SITE'],
    type: String,
    description:
      'ที่มา: ROUTE = เส้นทางใน route master · ESTIMATE = ค่าประมาณจากพิกัด (เส้นตรง × 1.3, 50 กม./ชม.) · SAME_SITE = จุดเดียวกัน',
  })
  legSource!: string | null;
}

class TripRouteSummaryDto {
  @ApiProperty({
    nullable: true,
    type: String,
    example: '182.4',
    description: 'ระยะรวมของช่วงที่ทราบ (กม.) — จุด < 2 หรือไม่ทราบทุกช่วง = null',
  })
  distanceKm!: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    example: 230,
    description: 'เวลาเดินทางรวม (นาที) ไม่รวมเวลาที่จุด',
  })
  minutes!: number | null;
  @ApiProperty({
    example: 0,
    description: 'จำนวนช่วงที่ไม่ทราบระยะ (ไม่มีเส้นทางและไม่มีพิกัด) — > 0 = ยอดรวมยังไม่ครบ',
  })
  missingLegs!: number;
  @ApiProperty({ description: 'มีช่วงที่เป็นค่าประมาณจากพิกัด' })
  estimated!: boolean;
}

export class TripDeliveryOrderDto {
  @ApiProperty({ example: 'do_3f2a…' }) id!: string;
  @ApiProperty({ example: 'DO-6911-0001' }) doNo!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ example: 'ord_3f2a…' }) orderId!: string;
  @ApiProperty({ example: 'cus_3f2a…' }) customerId!: string;
  @ApiProperty({ nullable: true, type: String }) pickupStopId!: string | null;
  @ApiProperty({ nullable: true, type: String }) dropStopId!: string | null;
}

class TripVehicleDto {
  @ApiProperty({ example: 'veh_3f2a…' }) id!: string;
  @ApiProperty({ example: '70-1234', description: 'ทะเบียน ณ วันจัดรถ (snapshot)' }) plate!: string;
  @ApiProperty({ example: 'vty_3f2a…' }) vehicleTypeId!: string;
  @ApiProperty({ nullable: true, type: String, example: '6 ล้อ' }) vehicleTypeName!: string | null;
}
class TripTrailerDto {
  @ApiProperty({ example: 'veh_3f2a…' }) id!: string;
  @ApiProperty({ example: '70-5678' }) plate!: string;
}
class TripDriverDto {
  @ApiProperty({ example: 'drv_3f2a…' }) id!: string;
  @ApiProperty({ description: 'ชื่อ ณ วันจัดรถ (snapshot)' }) name!: string;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
}
class TripCarrierDto {
  @ApiProperty({ example: 'car_3f2a…' }) id!: string;
  @ApiProperty({ description: 'ชื่อ ณ วันเสนอ/จัดรถ (snapshot)' }) name!: string;
}

export class TripDto {
  @ApiProperty({ example: 'trp_3f2a…' }) id!: string;
  @ApiProperty({ example: 'TRP-6911-0001' }) tripNo!: string;
  @ApiProperty({ example: '2026-11-13' }) tripDate!: string;
  @ApiProperty({ enum: TRIP_STATUSES }) status!: TripStatus;
  @ApiProperty({ nullable: true, type: String }) plannedStartAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) plannedEndAt!: string | null;
  @ApiProperty({ nullable: true, type: TripVehicleDto }) vehicle!: TripVehicleDto | null;
  @ApiProperty({ nullable: true, type: TripTrailerDto }) trailer!: TripTrailerDto | null;
  @ApiProperty({ nullable: true, type: TripDriverDto }) driver!: TripDriverDto | null;
  @ApiProperty({ nullable: true, type: TripDriverDto, description: 'คนขับสำรอง' })
  reliefDriver!: TripDriverDto | null;
  @ApiProperty({ nullable: true, type: TripCarrierDto }) carrier!: TripCarrierDto | null;
  @ApiProperty({
    nullable: true,
    enum: ['OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED'],
    type: String,
  })
  assignmentStatus!: string | null;
  @ApiProperty({ nullable: true, type: String }) offeredAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ข้อเสนอหมดอายุ (48 ชม.)' })
  offerExpiresAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: TripHireDto,
    description:
      'ST3-T22 การจ้างรถร่วมที่ใช้งานอยู่ (รอตอบ/รับแล้ว) — ราคาซื้อเห็นเมื่อมี `prices.buy:read`',
  })
  hire!: TripHireDto | null;
  @ApiProperty({ nullable: true, type: String }) assignedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) dispatchedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) completedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ type: [TripStopDto] }) stops!: TripStopDto[];
  @ApiProperty({ type: [TripDeliveryOrderDto] }) deliveryOrders!: TripDeliveryOrderDto[];
  @ApiProperty({
    example: '5400',
    description: 'น้ำหนักรวมของ DO ในเที่ยว (กก.)',
  })
  weightKg!: string;
  @ApiProperty({
    type: TripRouteSummaryDto,
    description: 'ST3-T16 ระยะ/เวลารวมตามลำดับจุดปัจจุบัน (คำนวณใหม่ทุกครั้งที่จุดเปลี่ยน)',
  })
  route!: TripRouteSummaryDto;
  @ApiProperty({
    type: [TripWarningDto],
    description:
      'ผลตรวจกฎตอนจัดล่าสุด (ST3-T14 — D-07: block = กฎเอกสาร, warning = ต้องยืนยันก่อนปล่อยรถ)',
  })
  warnings!: TripWarningDto[];
  @ApiProperty({
    type: [TripRuleOverrideDto],
    description: 'ประวัติการยกเว้น/ยืนยันกฎของเที่ยว (เรียงตามเวลา)',
  })
  ruleOverrides!: TripRuleOverrideDto[];
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class TripPageDto {
  @ApiProperty({ type: [TripDto] }) data!: TripDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

/** ผลปฏิเสธของรายการ (รูปเดียวกับ application/problem+json ของคำขอเดี่ยว) */
export class BulkTripProblemDto {
  @ApiProperty({ example: 'https://docs.tms.example/problems/assignment_warnings' }) type!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ example: 409 }) status!: number;
  @ApiProperty({ example: 'assignment_warnings' }) code!: string;
  @ApiPropertyOptional() detail?: string;
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'รายช่อง (422)',
  })
  errors?: { field: string; code: string; message: string }[];
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: '409 `assignment_blocked` — กฎบล็อกที่ค้าง (`key` สำหรับยกเว้น)',
  })
  blocks?: Record<string, unknown>[];
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      '409 `assignment_blocked`/`assignment_warnings` — คำเตือนที่ค้าง (`key` สำหรับยืนยัน)',
  })
  warnings?: Record<string, unknown>[];
}

export class BulkTripResultDto {
  @ApiProperty({ example: 'trp_3f2a…' }) tripId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'TRP-6911-0001' }) tripNo!: string | null;
  @ApiProperty({ example: 200, description: 'สถานะ HTTP ของรายการนี้ (200 = สำเร็จ/ไม่เปลี่ยน)' })
  status!: number;
  @ApiProperty({
    enum: ['ASSIGNED', 'DISPATCHED', 'UNCHANGED', 'FAILED'],
    description:
      'ผลของรายการ — `UNCHANGED` = เที่ยวจัดรถแล้วอยู่ก่อน (จัดรถโดยไม่ปล่อย) ไม่ได้ทำอะไร',
  })
  outcome!: 'ASSIGNED' | 'DISPATCHED' | 'UNCHANGED' | 'FAILED';
  @ApiProperty({ nullable: true, type: TripDto, description: 'เที่ยวหลังทำ (สำเร็จ)' })
  trip!: TripDto | null;
  @ApiProperty({ nullable: true, type: BulkTripProblemDto, description: 'เหตุที่ไม่สำเร็จ' })
  problem!: BulkTripProblemDto | null;
}

export class BulkTripResultsDto {
  @ApiProperty({ type: [BulkTripResultDto], description: 'ผลต่อรายการ เรียงตามคำขอ' })
  results!: BulkTripResultDto[];
  @ApiProperty({ example: 3, description: 'จัดรถ/ปล่อยสำเร็จ (ไม่นับ `UNCHANGED`)' })
  succeeded!: number;
  @ApiProperty({ example: 0, description: 'จัดรถแล้วอยู่ก่อน ไม่เปลี่ยน' }) unchanged!: number;
  @ApiProperty({ example: 1 }) failed!: number;
}

/**
 * ส่งแผนทั้งวัน (ST3-T18 "Send all" — docs/04 D2, spec/03 §9): ปล่อยทุกเที่ยวของวันในคำขอเดียว (ผลต่อเที่ยวแบบ bulk)
 */
export class SendAllTripsDto {
  @ApiProperty({ example: '2026-11-18', description: 'วันเที่ยว (เวลาไทย)' })
  @Matches(DATE_RE)
  date!: string;

  @ApiPropertyOptional({
    type: [BulkTripItemDto],
    minItems: 1,
    maxItems: 400,
    description:
      'เฉพาะเที่ยวที่ติ๊ก (+ `version` ที่เห็น) — ไม่ส่ง = ทุกเที่ยวของวันที่ยังไม่ส่ง (PLANNING/OFFERED/ASSIGNED ณ ตอนทำ)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(400)
  @ValidateNested({ each: true })
  @Type(() => BulkTripItemDto)
  items?: BulkTripItemDto[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 10,
    maxLength: 500,
    description: 'เหตุผลการยกเว้น/ยืนยันกฎ (≥ 10 ตัวอักษร) — ใช้กับทุกรายการที่ส่ง `ruleKeys`',
  })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(500)
  overrideReason?: string | null;

  @ApiPropertyOptional({
    description:
      'true = ตรวจล่วงหน้า: ประเมินทุกขั้นเหมือนส่งจริง (กฎ T14 ตอนปล่อยรถ) แล้วย้อนทั้งหมด — ไม่เปลี่ยนข้อมูล ไม่ลง audit/event · ' +
      '`outcome` = ผลที่คาดว่าจะได้ · `day` = สถานะปัจจุบัน',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/** สถานะการส่งของวัน — ส่งครบ = มีเที่ยว ≥ 1 และทุกเที่ยวที่ไม่ยกเลิกปล่อยรถแล้ว (หรือเลยไป) */
export class DaySendStateDto {
  @ApiProperty({ example: '2026-11-18' }) date!: string;
  @ApiProperty({ example: 12, description: 'เที่ยวที่ไม่ยกเลิกของวัน' }) trips!: number;
  @ApiProperty({ example: 12, description: 'ปล่อยรถแล้วหรือเลยไป' }) sent!: number;
  @ApiProperty({ description: 'ส่งครบ (ปฏิทินขึ้นเขียว)' }) complete!: boolean;
}

export class SendAllTripsResultDto extends BulkTripResultsDto {
  @ApiProperty({ type: DaySendStateDto, description: 'สถานะการส่งของวันหลังทำ' })
  day!: DaySendStateDto;
}

// ---------- ST3-T22 จ้างรถร่วม: ตัวเลือก ----------

export class HireOptionsQuery {
  @ApiPropertyOptional({
    description: 'ประเภทรถที่จะจ้าง (ใช้หา rate card ขาซื้อ) — ไม่ส่ง = ตามเที่ยว/ใบสั่งขาย',
    example: 'vty_3f2a…',
  })
  @IsOptional()
  @Matches(/^vty_[0-9a-f]{32}$/)
  vehicleTypeId?: string;
}

export class HireSiteDto {
  @ApiProperty({ example: 'loc_3f2a…' }) id!: string;
  @ApiProperty({ example: 'LOC-0001' }) code!: string;
  @ApiProperty({ example: 'คลังบางนา' }) name!: string;
}

export class HireCarrierDto {
  @ApiProperty({ example: 'car_3f2a…' }) id!: string;
  @ApiProperty({ example: 'SUB-0001' }) code!: string;
  @ApiProperty({ example: 'สมบูรณ์ทรานสปอร์ต' }) name!: string;
  @ApiProperty({
    example: '1.00',
    description: 'อัตราหัก ณ ที่จ่ายตั้งต้นของรายนี้ (%) — ค่าจริงอยู่ที่บรรทัด settlement',
  })
  whtRateDefault!: string;
  @ApiProperty({ example: 30 }) paymentTermDays!: number;
  @ApiProperty() requirePodToPay!: boolean;
}

export class HireOptionDto {
  @ApiProperty({ type: HireCarrierDto }) carrier!: HireCarrierDto;
  @ApiProperty({
    enum: ['AVAILABLE', 'RATE_MISSING', 'CALCULATION_FAILURE'],
    description: 'ผลคิดราคาขาซื้อจาก rate card ของรายนี้สำหรับเที่ยวนี้',
  })
  pricingStatus!: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '6800.00',
    description: 'ราคาขาซื้อจาก rate card (ก่อน VAT) — null = คิดไม่ได้',
  })
  @PriceField('buy')
  buyRateAmount?: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'RC-B-0001' }) rateCardCode!: string | null;
  @ApiProperty({ type: [String], description: 'เหตุที่คิดราคาไม่ได้ (ไทย)' })
  pricingReasons!: string[];
  @ApiProperty({
    nullable: true,
    type: String,
    enum: ['EXEMPT_TRANSPORT', 'VAT_7', 'ZERO_RATED'],
    description:
      'ธง VAT ของรายการบริการค่าขนส่งใน rate card (คัดลอกลงบรรทัดค่าจ้าง) — null = ไม่มี rate card',
  })
  vatType!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '1.00',
    description:
      'อัตราหัก ณ ที่จ่าย (%) ของรายการบริการค่าขนส่งใน rate card — null = ไม่มี rate card (ใช้ค่าตั้งต้นของรายนี้)',
  })
  whtRate!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'เอกสารบังคับของรถ (ประกัน/พ.ร.บ.) ไม่ครบหรือหมดอายุ ณ วันที่เที่ยว',
    description:
      'จ้างไม่ได้จริง ณ วันเที่ยว (กฎเอกสารบังคับ ST3-T14 / ไม่มีรถที่ลงทะเบียน) — ไม่นับในการเทียบถูกสุด, จ้างได้แต่ต้องมีเหตุผล',
  })
  blockedReason!: string | null;
  @ApiProperty({
    nullable: true,
    enum: ['REJECTED', 'EXPIRED', 'NO_RESPONSE'],
    type: String,
    description:
      'ST3-T24 รายนี้เคยได้ข้อเสนอของเที่ยวนี้แล้วไม่รับ: ปฏิเสธ / ลิงก์หมดอายุ / ไม่ตอบใน N ชม. (รวมรายที่รอตอบอยู่และครบเวลาแล้ว) — ' +
      'ไม่นับในการเทียบถูกสุด (รายถัดไปที่ถูกสุด = ถูกสุด)',
  })
  priorOutcome!: string | null;
  @ApiProperty({ description: 'ราคาต่ำสุดของตัวเลือก (เท่ากันได้หลายราย)' }) cheapest!: boolean;
  @ApiPropertyOptional({
    type: [String],
    example: ['6800.00', '6500.00'],
    description:
      'ราคา 5 ครั้งล่าสุดที่จ้างรายนี้ในเส้นทาง/ประเภทรถเดียวกัน (ใหม่สุดก่อน — ST2-T14)',
  })
  @PriceField('buy')
  buyRecentAmounts?: string[];
}

export class HireOptionsDto {
  @ApiProperty({ example: 'trp_3f2a…' }) tripId!: string;
  @ApiProperty({ example: 'TRP-6911-0001' }) tripNo!: string;
  @ApiProperty({ type: HireSiteDto, nullable: true, description: 'จุดแรกของเที่ยว' })
  origin!: HireSiteDto | null;
  @ApiProperty({ type: HireSiteDto, nullable: true, description: 'จุดสุดท้ายของเที่ยว' })
  destination!: HireSiteDto | null;
  @ApiProperty({ nullable: true, type: String, example: 'vty_3f2a…' }) vehicleTypeId!:
    string | null;
  @ApiProperty({ nullable: true, type: String, example: '6 ล้อ' }) vehicleTypeName!: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '9500.00',
    description:
      'รายได้ของเที่ยว (ผลรวมรายได้ DO ก่อน VAT) — เห็นเมื่อมี `prices.sell:read` · null = ยังไม่มีราคา',
  })
  @PriceField('sell')
  sellAmount?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '6500.00',
    description:
      'ราคาต่ำสุดจาก rate card ขาซื้อของตัวเลือก — null = ไม่มีให้เทียบ (การจ้างต้องมีเหตุผล)',
  })
  @PriceField('buy')
  buyCheapestAmount?: string | null;
  @ApiProperty({
    type: [HireOptionDto],
    description: 'รถร่วมที่ใช้งานอยู่ทุกราย — ราคาถูกก่อน แล้วรายที่คิดราคาไม่ได้ตามชื่อ',
  })
  options!: HireOptionDto[];
}
