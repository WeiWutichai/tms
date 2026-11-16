import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TRIP_STATUSES, type TripStatus } from '@tms/domain';
import { ListQuery } from '../../common/pagination';
import { CleanText, IsNullable } from '../master/master-kit';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DO_ID = /^do_[0-9a-f]{32}$/;
const VEH_ID = /^veh_[0-9a-f]{32}$/;
const DRV_ID = /^drv_[0-9a-f]{32}$/;

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
    description:
      'ยืนยันคำเตือนทั้งหมดของผลตรวจนี้ (น้ำหนักเกิน, รถไม่เข้ากับงาน/จุดส่ง, ชั่วโมงขับ, ซ้อนเวลา ฯลฯ) — ต้องมี `overrideReason`',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeWarnings?: boolean;

  @ApiPropertyOptional({
    description:
      'ยกเว้นบล็อก (เอกสารรถบังคับหมด/ไม่มี, ใบขับขี่ไม่มี/หมด/ชั้นไม่ถึง) — ต้องมี scope `trips:override` (ผู้จัดการ/ผู้ดูแล) + `overrideReason`',
  })
  @IsOptional()
  @IsBoolean()
  overrideBlocks?: boolean;

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
}

/** ปล่อยรถ — ยืนยัน/ยกเว้นกฎที่ค้างในคำขอนี้ได้ (ST3-T14) */
export class DispatchTripDto extends RuleConfirmDto {}

/** ยืนยันคำเตือนที่ค้าง + ยกเว้นบล็อก (ถ้า `overrideBlocks` และมี `trips:override`) ของเที่ยวภายหลัง (ST3-T14) */
export class ConfirmRulesDto {
  @ApiPropertyOptional({
    description: 'ยกเว้นบล็อกที่ค้างด้วย — ต้องมี scope `trips:override` (ผู้จัดการ/ผู้ดูแล)',
  })
  @IsOptional()
  @IsBoolean()
  overrideBlocks?: boolean;

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

export class OfferTripDto {
  @ApiProperty({ example: 'car_3f2a…', description: 'รถร่วมที่เสนองาน (ลิงก์รับงาน = ST3-T23)' })
  @Matches(/^car_[0-9a-f]{32}$/)
  carrierId!: string;
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
  @ApiProperty({ description: 'ยังตรงกับผลตรวจล่าสุด (เปลี่ยนรถ/คนขับ = หมดผล)' }) active!: boolean;
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
  @ApiProperty({ nullable: true, type: String }) assignedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) dispatchedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) completedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ type: [TripStopDto] }) stops!: TripStopDto[];
  @ApiProperty({ type: [TripDeliveryOrderDto] }) deliveryOrders!: TripDeliveryOrderDto[];
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
