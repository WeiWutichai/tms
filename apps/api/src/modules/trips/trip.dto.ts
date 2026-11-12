import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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

export class CreateTripDto extends DeliveryOrderIdsDto {
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

export class AssignTripDto {
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
    enum: ['warning', 'block'],
    description: 'block = กฎเอกสารรถร่วม (บังคับ/override ใน ST3-T14)',
  })
  severity!: 'warning' | 'block';
  @ApiProperty({ enum: ['compatibility', 'assignability', 'schedule', 'stops', 'assignment'] })
  source!: string;
  @ApiProperty({ example: 'trip.vehicleOverlap' }) messageKey!: string;
  @ApiProperty({ description: 'ข้อความไทยพร้อมแสดง' }) message!: string;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'ค่าประกอบข้อความ' })
  params!: Record<string, unknown>;
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
    description: 'คำเตือนจากการตรวจล่าสุด (ไม่บล็อก — บังคับ/override = ST3-T14)',
  })
  warnings!: TripWarningDto[];
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class TripPageDto {
  @ApiProperty({ type: [TripDto] }) data!: TripDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}
