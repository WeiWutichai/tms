import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ScheduleEntryDto } from '../schedule/schedule.dto';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { TRIP_STATUSES, type TripStatus } from '@tms/domain';
import { DaySendStateDto } from '../trips/trip.dto';

export class PlanningBoardQuery {
  @ApiPropertyOptional({
    example: '2026-11-13',
    description: 'วันแรกของกระดาน (YYYY-MM-DD) — ไม่ส่ง = วันนี้ (เวลาไทย)',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @ApiPropertyOptional({
    enum: [1, 7],
    default: 1,
    description: 'จำนวนวัน: 1 = วันเดียว · 7 = 7 วัน',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 7])
  days?: number;
}

class BoardBlockIssueDto {
  @ApiProperty({ example: 'DOC_CMI_EXPIRED' }) code!: string;
  @ApiProperty({ example: 'พ.ร.บ. หมดอายุ 1 พ.ย. 2569' }) message!: string;
}

class BoardRuleDto {
  @ApiProperty({ description: 'กุญแจของกฎ (ส่งใน `ruleKeys` ของ /confirm-rules)' }) key!: string;
  @ApiProperty({ example: 'OVERWEIGHT' }) code!: string;
  @ApiProperty({ enum: ['block', 'warning'] }) severity!: 'block' | 'warning';
  @ApiProperty({ example: 'น้ำหนักเกิน 800 กก. (6,800 / 6,000 กก.)' }) message!: string;
}

class BoardBlockDayDto {
  @ApiProperty({ example: '2026-11-13' }) date!: string;
  @ApiProperty({ type: [BoardBlockIssueDto] }) issues!: BoardBlockIssueDto[];
}

class BoardDriverDto {
  @ApiProperty({ example: 'drv_3f2a…' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String, example: 'T2' }) licenceClass!: string | null;
  @ApiProperty({
    enum: ['ACTIVE', 'ON_LEAVE'],
    description: 'สถานะคนขับ — ON_LEAVE (ลาพัก ไม่มีวัน) = ลาทุกวันบนกระดาน',
  })
  status!: 'ACTIVE' | 'ON_LEAVE';
}

export class BoardVehicleDto {
  @ApiProperty({ example: 'veh_3f2a…' }) id!: string;
  @ApiProperty({ example: '70-1234' }) plate!: string;
  @ApiProperty({ example: 'TH-10', description: 'จังหวัดของทะเบียน (ISO 3166-2:TH)' })
  plateProvince!: string;
  @ApiProperty({ example: 'vty_3f2a…' }) vehicleTypeId!: string;
  @ApiProperty({ example: '6 ล้อ' }) vehicleTypeName!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '6000',
    description: 'น้ำหนักบรรทุก (กก.) ของรถ หรือของประเภทรถ',
  })
  capacityKg!: string | null;
  @ApiProperty({ enum: ['OWN', 'SUBCONTRACT'] }) ownership!: string;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อรถร่วม (SUBCONTRACT)' })
  carrierName!: string | null;
  @ApiProperty({ enum: ['READY', 'MAINTENANCE', 'PARKED', 'RETIRED'] }) status!: string;
  @ApiProperty({
    nullable: true,
    type: BoardDriverDto,
    description: 'คนขับประจำ (ค่าเริ่มต้นตอนจัด)',
  })
  driver!: BoardDriverDto | null;
  @ApiProperty({
    type: [BoardBlockDayDto],
    description:
      'วันในช่วงกระดานที่รถติดกฎห้ามจ่ายงาน (ST2-T20 `checkAssignability` — รถร่วมเอกสารบังคับหมด/ไม่มี) · ไม่มี = ว่าง',
  })
  blocks!: BoardBlockDayDto[];
}

class BoardOrderRefDto {
  @ApiProperty({ example: 'ord_3f2a…' }) id!: string;
  @ApiProperty({ example: 'SO-6911-0001' }) orderNo!: string;
  @ApiProperty({ nullable: true, type: String }) customerName!: string | null;
}

class BoardPlaceDto {
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String, example: 'ชลบุรี' }) province!: string | null;
}

export class BoardTripDto {
  @ApiProperty({ example: 'trp_3f2a…' }) id!: string;
  @ApiProperty({ example: 'TRP-6911-0001' }) tripNo!: string;
  @ApiProperty({ example: '2026-11-13' }) tripDate!: string;
  @ApiProperty({ enum: TRIP_STATUSES }) status!: TripStatus;
  @ApiProperty({ nullable: true, type: String, description: 'รถที่วาง/จัด — null = ยังไม่วางลงรถ' })
  vehicleId!: string | null;
  @ApiProperty({ nullable: true, type: String }) vehiclePlate!: string | null;
  @ApiProperty({ nullable: true, type: String }) plannedStartAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) plannedEndAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) driverName!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'drv_3f2a…',
    description:
      'คนขับของเที่ยว (ST3-T19 — ป้าย "คนขับลา" ใช้คนขับจริงของเที่ยว ไม่ใช่คนขับประจำรถ)',
  })
  driverId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'drv_3f2a…' })
  reliefDriverId!: string | null;
  @ApiProperty({ nullable: true, type: String }) reliefDriverName!: string | null;
  @ApiProperty({ nullable: true, type: String }) carrierName!: string | null;
  @ApiProperty({ type: [BoardOrderRefDto] }) orders!: BoardOrderRefDto[];
  @ApiProperty({ nullable: true, type: BoardPlaceDto, description: 'จุดรับแรก' })
  origin!: BoardPlaceDto | null;
  @ApiProperty({ nullable: true, type: BoardPlaceDto, description: 'จุดส่งสุดท้าย' })
  dest!: BoardPlaceDto | null;
  @ApiProperty({ example: '5400', description: 'น้ำหนักรวมของ DO ในเที่ยว (กก.)' })
  weightKg!: string;
  @ApiProperty({ type: [String], example: ['DO-6911-0001'] }) doNos!: string[];
  @ApiProperty({
    nullable: true,
    type: String,
    example: '120.5',
    description: 'ระยะทางตามแผน (กม.)',
  })
  plannedDistanceKm!: string | null;
  @ApiProperty({
    example: 0,
    description:
      'ST3-T16 จำนวนช่วงวิ่งที่ไม่ทราบระยะ (ไม่มีเส้นทาง/พิกัด) — > 0 = `plannedDistanceKm` ยังไม่ครบ (นับเฉพาะช่วงที่ทราบ)',
  })
  missingLegs!: number;
  @ApiProperty({
    type: [String],
    description:
      'เที่ยวอื่นของรถคันเดียวกันที่ซ้อนเวลา (คำนวณ ณ ตอนอ่าน — ช่วงวิ่งทับกัน หรือวันเดียวกันเมื่อไม่มีช่วงวิ่ง) — เตือน ไม่บล็อก',
  })
  overlapsWith!: string[];
  @ApiProperty({
    description:
      'จำนวนคำเตือนจากการตรวจล่าสุดของเที่ยว ไม่นับ `vehicle_overlap` (ซ้อนเวลารถใช้ `overlapsWith` ที่คำนวณ ณ ตอนอ่าน)',
  })
  warningCount!: number;
  @ApiProperty({
    type: [BoardRuleDto],
    description:
      'ST3-T14: กฎที่ติดและยังไม่ยกเว้น/ยืนยัน (ผลตรวจล่าสุดของเที่ยว — บล็อกก่อน) → การ์ด "ติดเงื่อนไข · รออนุมัติ" / "ต้องย้ายรถ"',
  })
  pendingRules!: BoardRuleDto[];
  @ApiProperty({
    description:
      'ST3-T14: จำนวนกฎที่ยกเว้น/ยืนยันแล้ว (ยังตรงกับผลตรวจล่าสุด) → การ์ด "อนุมัติยกเว้นแล้ว"',
  })
  confirmedRules!: number;
  @ApiProperty() version!: number;
}

class BoardPoolDoDto {
  @ApiProperty({ example: 'do_3f2a…' }) id!: string;
  @ApiProperty({ example: 'DO-6911-0001' }) doNo!: string;
  @ApiProperty({ nullable: true, type: String }) weightKg!: string | null;
  @ApiProperty({
    example: '2026-11-13',
    description: 'วันส่งของ DO (ส่งใหม่ = วันที่นัด — ST4-T12)',
  })
  doDate!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'DO-6911-0001',
    description: 'ST4-T12 ส่งซ้ำของ DO ใบนี้ (redelivery_of) — ป้าย "ส่งซ้ำ" (spec/03 ORD-087)',
  })
  redeliveryOfNo!: string | null;
  @ApiProperty({ example: 0, description: 'ครั้งที่นัดส่งใหม่อัตโนมัติ (0 = ไม่ใช่)' })
  rescheduleCount!: number;
}

export class BoardPoolOrderDto {
  @ApiProperty({ example: 'ord_3f2a…' }) id!: string;
  @ApiProperty({ example: 'SO-6911-0001' }) orderNo!: string;
  @ApiProperty({ nullable: true, type: String }) customerId!: string | null;
  @ApiProperty({ nullable: true, type: String }) customerName!: string | null;
  @ApiProperty({ example: '2026-11-13', description: 'วันที่ลูกค้าขอ (กำหนดส่ง)' })
  requestedDate!: string;
  @ApiProperty({ example: 'RECEIVED' }) status!: string;
  @ApiProperty({ nullable: true, type: String, description: 'รหัสเหตุผลที่ค้าง (ON_HOLD)' })
  holdReason!: string | null;
  @ApiProperty({
    description: 'ต้นทางแก้ไขหลังวางแผน รอตรวจ (ST3-T10) — ลงเที่ยวไม่ได้จนกว่าจะเคลียร์',
  })
  sourceChangePending!: boolean;
  @ApiProperty({ nullable: true, type: String }) vehicleTypeId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '6 ล้อ' }) vehicleTypeName!: string | null;
  @ApiProperty({ type: BoardPlaceDto }) origin!: BoardPlaceDto;
  @ApiProperty({ type: BoardPlaceDto }) dest!: BoardPlaceDto;
  @ApiProperty({ nullable: true, type: String, description: 'ต้นช่วงเวลาส่งที่ลูกค้าขอ' })
  windowStart!: string | null;
  @ApiProperty({ nullable: true, type: String }) windowEnd!: string | null;
  @ApiProperty({ example: '5400', description: 'น้ำหนักรวมของ DO รอจัด (กก.)' }) weightKg!: string;
  @ApiProperty({ type: [BoardPoolDoDto], description: 'ใบส่งของรอจัด (DRAFT ไม่อยู่ในเที่ยว)' })
  deliveryOrders!: BoardPoolDoDto[];
}

export class PlanningBoardDto {
  @ApiProperty({ example: '2026-11-13' }) from!: string;
  @ApiProperty({ example: '2026-11-13' }) to!: string;
  @ApiProperty({ example: '2026-11-13', description: 'วันนี้ (เวลาไทย)' }) today!: string;
  @ApiProperty({ type: [BoardVehicleDto], description: 'แถวรถ: รถบริษัท → รถร่วม (PLN-049)' })
  vehicles!: BoardVehicleDto[];
  @ApiProperty({
    type: [BoardTripDto],
    description: 'เที่ยวในช่วง (± 1 วัน — เที่ยวข้ามคืน) ยกเว้นที่ยกเลิก',
  })
  trips!: BoardTripDto[];
  @ApiProperty({
    type: [BoardPoolOrderDto],
    description: 'SO รอจัด (จัดกลุ่ม DO ตาม SO) เรียงกำหนดส่ง',
  })
  pool!: BoardPoolOrderDto[];
  @ApiProperty({
    type: [DaySendStateDto],
    description:
      'สถานะการส่งต่อวันในช่วง from–to (ST3-T18 ปฏิทินขึ้นเขียวเมื่อส่งครบ) — นับตามวันเที่ยว `tripDate`',
  })
  days!: DaySendStateDto[];
  @ApiProperty({
    type: [ScheduleEntryDto],
    description:
      'วันลาคนขับ/โน้ตรายวันที่ทับช่วง from–to (ST3-T19 ตารางรถ/คนขับรายวัน) — ไม่รวมที่ยกเลิก · ชุดเดียวกับ GET /v1/schedule-entries',
  })
  schedule!: ScheduleEntryDto[];
}

/** ST3-T15 Filter รถที่รับได้สองทาง — ส่ง `orderId` / `vehicleId` / `tripId` อย่างใดอย่างหนึ่ง */
export class PlanningEligibilityQuery {
  @ApiPropertyOptional({
    example: 'so_3f2a…',
    description: 'SO (การ์ดใน "SO รอจัด") → ประเมินรถทุกคันบนกระดาน',
  })
  @IsOptional()
  @IsString()
  orderId?: string;

  @ApiPropertyOptional({
    example: 'veh_3f2a…',
    description: 'รถ (แถวรถ) → ประเมิน SO รอจัดทุกใบ',
  })
  @IsOptional()
  @IsString()
  vehicleId?: string;

  @ApiPropertyOptional({
    example: 'trp_3f2a…',
    description:
      'เที่ยว ("ย้ายไปรถอื่น") → ประเมินรถทุกคันกับ DO ทั้งหมดของเที่ยว ในช่วงวิ่งของเที่ยว (รวมซ้อนเวลา)',
  })
  @IsOptional()
  @IsString()
  tripId?: string;

  @ApiPropertyOptional({
    example: '2026-11-13',
    description:
      'วันแรก (YYYY-MM-DD) ที่ตรวจเอกสารรถ/ใบขับขี่ — ไม่ส่ง = วันนี้ (เวลาไทย) · ไม่ใช้กับ `tripId`',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @ApiPropertyOptional({ enum: [1, 7], default: 1, description: 'จำนวนวัน: 1 / 7' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 7])
  days?: number;
}

export class EligibilityIssueDto {
  @ApiProperty({
    example: 'CAPABILITY_MISSING',
    description: 'รหัสกฎชุดเดียวกับ `warnings` ของเที่ยว (ST3-T14)',
  })
  code!: string;
  @ApiProperty({
    enum: ['block', 'warning', 'info'],
    description:
      'block = ห้ามจ่ายงาน (ยกเว้นได้โดย `trips:override`) · warning = วางได้แต่ต้องยืนยันพร้อมเหตุผล · info = แจ้งเฉย ๆ',
  })
  severity!: 'block' | 'warning' | 'info';
  @ApiProperty({ example: 'งานนี้ต้องใช้รถห้องเย็น แต่ประเภทรถที่เลือกไม่มี' }) message!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-11-14',
    description: 'วันที่ติดกฎนี้ (เอกสาร/ใบขับขี่ที่หมดระหว่างช่วง) · null = ทุกวันในช่วง',
  })
  date!: string | null;
}

export class EligibilityDayLevelDto {
  @ApiProperty({ example: '2026-11-14' }) date!: string;
  @ApiProperty({ enum: ['OK', 'WARNING', 'BLOCK'] }) level!: 'OK' | 'WARNING' | 'BLOCK';
}

export class EligibilityItemDto {
  @ApiProperty({ example: 'veh_3f2a…' }) vehicleId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'so_3f2a…' }) orderId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'trp_3f2a…' }) tripId!: string | null;
  @ApiProperty({
    enum: ['OK', 'WARNING', 'BLOCK'],
    description:
      'ระดับที่แย่ที่สุดของทั้งช่วง (worst-of-range): OK = ผ่านทุกกฎตอนวาง (เน้น) · WARNING = มีคำเตือน · BLOCK = ติดกฎห้ามจ่ายงาน — รายวันดู `levels`',
  })
  level!: 'OK' | 'WARNING' | 'BLOCK';
  @ApiProperty({
    type: [EligibilityDayLevelDto],
    description: 'ระดับรายวันในช่วง from–to (เอกสารที่หมดกลางช่วงติดเฉพาะวันหลังหมด)',
  })
  levels!: EligibilityDayLevelDto[];
  @ApiProperty({
    type: [EligibilityIssueDto],
    description:
      'กฎที่บังคับตอนวาง (POST /v1/trips + vehicleId) — ชุดเดียวกับ `warnings` ของเที่ยวที่ได้',
  })
  issues!: EligibilityIssueDto[];
  @ApiProperty({
    type: [EligibilityIssueDto],
    description:
      'ข้อสังเกตของคนขับประจำ (ใบขับขี่ไม่ถึงชั้น/หมด รวม ท.4 สินค้าอันตราย, ลา) — severity `info` ไม่นับในระดับ เพราะบังคับตอน /assign ไม่ใช่ตอนวาง',
  })
  driverHints!: EligibilityIssueDto[];
}

export class PlanningEligibilityDto {
  @ApiProperty({ example: '2026-11-13' }) from!: string;
  @ApiProperty({ example: '2026-11-19' }) to!: string;
  @ApiProperty({ enum: ['ORDER', 'VEHICLE', 'TRIP'] }) subject!: 'ORDER' | 'VEHICLE' | 'TRIP';
  @ApiProperty({
    type: [EligibilityItemDto],
    description: 'ORDER/TRIP = หนึ่งรายการต่อรถ · VEHICLE = หนึ่งรายการต่อ SO รอจัด',
  })
  items!: EligibilityItemDto[];
}

/**
 * มุมมองกระดาน (ST3-T13; docs/04 D2 "View") — ข้อมูลชุดเดียวกัน (รถ + เที่ยว) จัดกลุ่ม/เรียงแถวต่างกัน
 * FLEET = "รถบริษัท + รถร่วม" (ค่าเริ่มต้น — PLN-049) · VEHICLE = ตามรถ · DRIVER = ตามคนขับ · CARRIER = ตาม carrier
 */
export const BOARD_VIEWS = ['FLEET', 'VEHICLE', 'DRIVER', 'CARRIER'] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];
/** field บนการ์ดเที่ยว (spec/03 §5 การ์ดงาน: เลข SO · ลูกค้า / ช่วงเวลา · เส้นทาง / น้ำหนักต่อความจุ) */
export const BOARD_CARD_FIELDS = ['ORDER_NO', 'CUSTOMER', 'TIME', 'ROUTE', 'WEIGHT'] as const;
export type BoardCardField = (typeof BOARD_CARD_FIELDS)[number];

export class BoardPreferencesDto {
  @ApiProperty({
    enum: BOARD_VIEWS,
    description:
      'มุมมองกระดาน: FLEET = รถบริษัท + รถร่วม (ค่าเริ่มต้น) · VEHICLE = ตามรถ · DRIVER = ตามคนขับ · CARRIER = ตาม carrier',
  })
  view!: string;

  @ApiProperty({
    enum: BOARD_CARD_FIELDS,
    isArray: true,
    description: 'field ที่แสดงบนการ์ดเที่ยว (เรียงตามลำดับมาตรฐาน) — ค่าเริ่มต้น = ทุก field',
  })
  cardFields!: string[];

  @ApiProperty({ description: 'version ของค่าที่บันทึก (0 = ยังไม่เคยบันทึก ใช้ค่าเริ่มต้น)' })
  version!: number;
}

export class UpdateBoardPreferencesDto {
  @ApiProperty({ enum: BOARD_VIEWS })
  @IsIn([...BOARD_VIEWS])
  view!: BoardView;

  @ApiProperty({
    enum: BOARD_CARD_FIELDS,
    isArray: true,
    description: 'อย่างน้อย 1 field ไม่ซ้ำ — ระบบเรียงตามลำดับมาตรฐานเอง',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BOARD_CARD_FIELDS.length)
  @ArrayUnique()
  @IsIn([...BOARD_CARD_FIELDS], { each: true })
  cardFields!: BoardCardField[];
}
