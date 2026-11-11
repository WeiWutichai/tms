import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CleanText, IsNullable, IsOptionalNotNull } from '../master/master-kit';
import { PROVINCE_CODES, type ProvinceCode } from './provinces';

/** docs/01 §3.8 `unit_role`: SINGLE = รถเดี่ยว, TRACTOR = หัวลาก, TRAILER = หาง */
export const UNIT_ROLES = ['SINGLE', 'TRACTOR', 'TRAILER'] as const;
export type UnitRole = (typeof UNIT_ROLES)[number];
export const OWNERSHIPS = ['OWN', 'SUBCONTRACT'] as const;
export type OwnershipKind = (typeof OWNERSHIPS)[number];
/** docs/01 §3.8 `fuel_type` (docs เหนือ spec/06 ที่แยก b7/b20) */
export const FUEL_TYPES = ['DIESEL', 'GASOLINE', 'NGV', 'LPG', 'EV', 'HYBRID'] as const;
export type FuelType = (typeof FUEL_TYPES)[number];
export const DEPRECIATION_METHODS = ['STRAIGHT_LINE'] as const;
/** สถานะรถ (docs/01 §3.2 READY/MAINTENANCE/PARKED/RETIRED) — API ตัวเล็กเหมือน master อื่น */
export const VEHICLE_STATUSES = ['ready', 'maintenance', 'parked', 'retired'] as const;
export type VehicleStatusKey = (typeof VEHICLE_STATUSES)[number];
export const ODOMETER_REASONS = [
  'TYPO',
  'METER_REPLACED',
  'GPS_ERROR',
  'MISSED_ENTRY',
  'OTHER',
] as const;
export type OdometerReason = (typeof ODOMETER_REASONS)[number];

const EXT_RE = /^[\x21-\x7e]{1,100}$/;
/** เงิน: สตริงทศนิยม ≤ 2 ตำแหน่ง (numeric(14,2) — ไม่รับ float) */
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ฟิลด์ที่แก้ได้ (create / PATCH / PUT external) — ช่องบังคับประกาศใน DTO ของแต่ละแบบ */
export class VehicleFieldsDto {
  @ApiPropertyOptional({
    enum: UNIT_ROLES,
    default: 'SINGLE',
    description: 'SINGLE = รถเดี่ยว, TRACTOR = หัวลาก, TRAILER = หาง (จับคู่ได้เฉพาะหัวลากกับหาง)',
  })
  @IsOptionalNotNull()
  @IsIn(UNIT_ROLES)
  unitRole?: UnitRole;

  @ApiPropertyOptional({
    example: 'car_…',
    nullable: true,
    type: String,
    description: 'รถร่วม: ผู้รับเหมาเจ้าของรถ — บังคับเมื่อ ownership = SUBCONTRACT (ไม่ส่ง → 422)',
  })
  @IsNullable()
  @IsString()
  carrierId?: string | null;

  @ApiPropertyOptional({
    example: 6000,
    type: Number,
    description: 'น้ำหนักบรรทุก (กก.) > 0 — ไม่ส่งตอนสร้าง = ค่าของประเภทรถ',
  })
  @IsOptionalNotNull()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99_999_999)
  payloadKg?: number;

  @ApiPropertyOptional({
    example: 32,
    nullable: true,
    type: Number,
    description: 'ปริมาตร (ลบ.ม.)',
  })
  @IsNullable()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  volumeCbm?: number | null;

  @ApiPropertyOptional({
    example: 3300,
    nullable: true,
    type: Number,
    description: 'น้ำหนักรถเปล่า (กก.)',
  })
  @IsNullable()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99_999_999)
  tareWeightKg?: number | null;

  @ApiPropertyOptional({
    example: 9500,
    nullable: true,
    type: Number,
    description: 'น้ำหนักรวมตามทะเบียน (กก.) — น้ำหนักบรรทุก ≤ น้ำหนักรวม − น้ำหนักเปล่า',
  })
  @IsNullable()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99_999_999)
  grossWeightKg?: number | null;

  @ApiPropertyOptional({
    example: 'Cartrack',
    nullable: true,
    type: String,
    description: 'ค่าย GPS',
  })
  @IsNullable()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  gpsProvider?: string | null;

  @ApiPropertyOptional({
    example: '356938035643809',
    nullable: true,
    type: String,
    description: 'เลขอุปกรณ์ GPS (IMEI) — ต้องมีค่าย GPS, ห้ามซ้ำในค่ายเดียวกัน',
  })
  @IsNullable()
  @CleanText()
  @Matches(/^[\x21-\x7e]{1,50}$/)
  gpsDeviceId?: string | null;

  @ApiPropertyOptional({
    example: 'MPATFR86JMT000417',
    nullable: true,
    type: String,
    description: 'เลขตัวถัง — ห้ามซ้ำ',
  })
  @IsNullable()
  @CleanText()
  @Matches(/^[A-Za-z0-9\-./ ]{1,40}$/)
  chassisNo?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'เลขเครื่องยนต์' })
  @IsNullable()
  @CleanText()
  @Matches(/^[A-Za-z0-9\-./ ]{1,40}$/)
  engineNo?: string | null;

  @ApiPropertyOptional({ example: 'Isuzu', nullable: true, type: String })
  @IsNullable()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  brand?: string | null;

  @ApiPropertyOptional({ example: 'FRR 210', nullable: true, type: String })
  @IsNullable()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  model?: string | null;

  @ApiPropertyOptional({
    example: 2021,
    nullable: true,
    type: Number,
    description: 'ปีผลิต (ค.ศ.) 1980 – ปีหน้า (spec/06 FLT-A)',
  })
  @IsNullable()
  @IsInt()
  @Min(1980)
  @Max(2200)
  year?: number | null;

  @ApiPropertyOptional({ example: 'ขาว', nullable: true, type: String })
  @IsNullable()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  color?: string | null;

  @ApiPropertyOptional({ enum: FUEL_TYPES, nullable: true })
  @IsNullable()
  @IsIn(FUEL_TYPES)
  fuelType?: FuelType | null;

  @ApiPropertyOptional({
    example: 200,
    nullable: true,
    type: Number,
    description: 'ความจุถัง (ลิตร) 20–2,000',
  })
  @IsNullable()
  @IsInt()
  @Min(20)
  @Max(2000)
  tankCapacityL?: number | null;

  @ApiPropertyOptional({
    example: 148220,
    type: Number,
    description:
      'เลขไมล์ (กม.) — สร้าง = ค่าเริ่มต้น · แก้ = บันทึกค่าใหม่ (น้อยกว่าเดิม → 422 `odometer_backwards`; แก้ค่าผิดใช้ POST /{id}/odometer/correct)',
  })
  @IsOptionalNotNull()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(99_999_999)
  odometerKm?: number;

  @ApiPropertyOptional({
    example: 'veh_…',
    nullable: true,
    type: String,
    description:
      'หัวลาก ↔ หาง ที่จับคู่ (ต้องเป็นหัวลากกับหาง) — ตั้งแล้วเห็นทั้งสองฝั่ง · null = ปลดคู่',
  })
  @IsNullable()
  @IsString()
  pairedVehicleId?: string | null;

  @ApiPropertyOptional({
    example: '1450000.00',
    nullable: true,
    type: String,
    description: 'ราคาซื้อ (บาท) — ต้องมีสิทธิ์ reports.finance:read (ไม่มี → 403)',
  })
  @IsNullable()
  @Matches(MONEY_RE)
  purchaseCost?: string | null;

  @ApiPropertyOptional({ example: '2021-11-04', nullable: true, type: String, format: 'date' })
  @IsNullable()
  @Matches(DATE_RE)
  @IsISO8601({ strict: true })
  purchasedOn?: string | null;

  @ApiPropertyOptional({
    enum: DEPRECIATION_METHODS,
    nullable: true,
    description: 'วิธีคิดค่าเสื่อม (เส้นตรง N ปี — ต้องมีราคาซื้อและจำนวนปี)',
  })
  @IsNullable()
  @IsIn(DEPRECIATION_METHODS)
  depreciationMethod?: 'STRAIGHT_LINE' | null;

  @ApiPropertyOptional({
    example: 10,
    nullable: true,
    type: Number,
    description: 'อายุใช้งาน (ปี) 1–30',
  })
  @IsNullable()
  @IsInt()
  @Min(1)
  @Max(30)
  depreciationYears?: number | null;

  @ApiPropertyOptional({
    example: '400000.00',
    nullable: true,
    type: String,
    description: 'มูลค่าซาก ≤ ราคาซื้อ',
  })
  @IsNullable()
  @Matches(MONEY_RE)
  salvageValue?: string | null;

  @ApiPropertyOptional({
    type: [String],
    example: ['doc_…'],
    description: 'รูปรถ — id ไฟล์จาก /v1/documents (ST1-T08) สูงสุด 10 รูป',
  })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(10)
  @Matches(/^doc_[0-9a-f]{32}$/, { each: true })
  photoDocumentIds?: string[];
}

class RequiredVehicleFields extends VehicleFieldsDto {
  @ApiProperty({
    example: '70-1234',
    description: 'ทะเบียน (ไม่รวมจังหวัด) — ห้ามซ้ำกับคันที่ยังไม่ปลดระวาง',
  })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  plate!: string;

  @ApiProperty({
    enum: PROVINCE_CODES,
    example: 'TH-10',
    description: 'จังหวัดบนป้าย (ISO 3166-2:TH)',
  })
  @IsIn(PROVINCE_CODES)
  plateProvince!: ProvinceCode;

  @ApiProperty({ example: 'vty_…', description: 'ประเภทรถ (ใช้งานอยู่)' })
  @IsString()
  vehicleTypeId!: string;

  @ApiProperty({
    enum: OWNERSHIPS,
    description: 'OWN = รถบริษัท, SUBCONTRACT = รถร่วม (ต้องมี carrierId)',
  })
  @IsIn(OWNERSHIPS)
  ownership!: OwnershipKind;
}

export class CreateVehicleDto extends RequiredVehicleFields {
  @ApiPropertyOptional({ description: 'รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้' })
  @IsOptionalNotNull()
  @Matches(EXT_RE)
  externalId?: string;
}

/** `PUT /vehicles/external/{externalId}` — ข้อมูลเต็ม (ฟิลด์ที่ไม่ส่งตอนอัปเดต = คงเดิม) */
export class UpsertVehicleDto extends RequiredVehicleFields {}

export class UpdateVehicleDto extends VehicleFieldsDto {
  @ApiPropertyOptional({ example: '70-1234' })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  plate?: string;

  @ApiPropertyOptional({ enum: PROVINCE_CODES })
  @IsOptionalNotNull()
  @IsIn(PROVINCE_CODES)
  plateProvince?: ProvinceCode;

  @ApiPropertyOptional({ example: 'vty_…' })
  @IsOptionalNotNull()
  @IsString()
  vehicleTypeId?: string;

  @ApiPropertyOptional({ enum: OWNERSHIPS })
  @IsOptionalNotNull()
  @IsIn(OWNERSHIPS)
  ownership?: OwnershipKind;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'null = ลบการผูก' })
  @IsNullable()
  @Matches(EXT_RE)
  externalId?: string | null;
}

/** เปลี่ยนสถานะ (spec/06 FLT-A ข้อ 6) — เหตุผล ≥ 10 ตัวอักษรทุกครั้ง (ลง audit + doc_status_history) */
export class VehicleStatusDto {
  @ApiProperty({
    enum: VEHICLE_STATUSES,
    description:
      'ready = พร้อมใช้, maintenance = ซ่อม, parked = จอด, retired = ปลดระวาง (ย้อนกลับไม่ได้ — ต้องไม่มีเที่ยวค้าง)',
  })
  @IsIn(VEHICLE_STATUSES)
  status!: VehicleStatusKey;

  @ApiProperty({ minLength: 10, maxLength: 500, example: 'เข้าอู่เปลี่ยนคลัตช์ 3 วัน' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

/** บันทึกเลขไมล์ (spec/06 FLT-O, แหล่ง MANUAL) — น้อยกว่าค่าปัจจุบัน → 422 `odometer_backwards` */
export class OdometerReadingInput {
  @ApiProperty({ example: 150120.5 })
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(99_999_999)
  readingKm!: number;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'เวลาที่อ่านเลขไมล์ (ไม่ส่ง = ตอนนี้) — ห้ามเป็นอนาคต',
  })
  @IsOptional()
  @IsISO8601()
  readAt?: string;
}

/** แก้เลขไมล์ที่ผิด (FLT-285) — ค่าน้อยกว่าได้ ต้องมีชนิดเหตุผล + คำอธิบาย ≥ 10 ตัวอักษร (audit) */
export class OdometerCorrectionInput {
  @ApiPropertyOptional({
    example: 'odo_…',
    description: 'แถวที่จะแก้ (ต้องยังเป็น ACCEPTED) — ไม่ส่ง = แถวล่าสุด',
  })
  @IsOptional()
  @Matches(/^odo_[0-9a-f]{32}$/)
  readingId?: string;

  @ApiProperty({ example: 148200 })
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(99_999_999)
  readingKm!: number;

  @ApiProperty({
    enum: ODOMETER_REASONS,
    description:
      'TYPO = พิมพ์ผิด, METER_REPLACED = เปลี่ยนเรือนไมล์, GPS_ERROR, MISSED_ENTRY = ลืมบันทึก, OTHER',
  })
  @IsIn(ODOMETER_REASONS)
  reasonType!: OdometerReason;

  @ApiProperty({ minLength: 10, maxLength: 500, example: 'พิมพ์เลขเกินมา 1 หลักเมื่อวาน' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  note!: string;
}

export class OdometerListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * รายการรถ — โครงเดียวกับ `MasterListQuery` แต่เรียงตามทะเบียน และสถานะเป็นของรถ
 * (ไม่ extends เพราะ class-validator รวม decorator ของคลาสแม่ — sort/status ของ master จะชนกัน)
 */
export class VehicleListQuery {
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
    enum: ['plate', 'updatedAt', '-updatedAt'],
    default: 'plate',
    description:
      'plate = เรียงตามทะเบียน (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync',
  })
  @IsOptional()
  @IsIn(['plate', 'updatedAt', '-updatedAt'])
  sort?: 'plate' | 'updatedAt' | '-updatedAt';

  @ApiPropertyOptional({ description: 'รายชื่อ field คั่นด้วย , เช่น id,plate' })
  @IsOptional()
  @Matches(/^[a-zA-Z]+(,[a-zA-Z]+)*$/)
  fields?: string;

  @ApiPropertyOptional({
    description: 'ค้นหา — ทะเบียน ยี่ห้อ รุ่น เลขตัวถัง หรือ externalId (ไม่สนตัวพิมพ์)',
    maxLength: 100,
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: 'คั่นด้วย , เช่น ready,maintenance' })
  @IsOptional()
  @Matches(/^(ready|maintenance|parked|retired)(,(ready|maintenance|parked|retired))*$/)
  status?: string;

  @ApiPropertyOptional({ description: 'externalId ตรงตัว' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalId?: string;

  @ApiPropertyOptional({ description: 'true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`)' })
  @IsOptional()
  @IsIn(['true', 'false'])
  includeDeleted?: 'true' | 'false';

  @ApiPropertyOptional({ description: 'ทะเบียนมีคำนี้ (ไม่สนช่องว่าง/ขีด)' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(30)
  plate?: string;

  @ApiPropertyOptional({ description: 'ประเภทรถ (vty_…)' })
  @IsOptional()
  @Matches(/^vty_[0-9a-f]{32}$/)
  vehicleTypeId?: string;

  @ApiPropertyOptional({ enum: OWNERSHIPS })
  @IsOptional()
  @IsIn(OWNERSHIPS)
  ownership?: OwnershipKind;

  @ApiPropertyOptional({ description: 'เฉพาะรถของผู้รับเหมานี้ (car_…)' })
  @IsOptional()
  @Matches(/^car_[0-9a-f]{32}$/)
  carrierId?: string;

  @ApiPropertyOptional({ enum: UNIT_ROLES })
  @IsOptional()
  @IsIn(UNIT_ROLES)
  unitRole?: UnitRole;

  @ApiPropertyOptional({ description: 'true = เฉพาะที่ยังไม่จับคู่หัวลาก-หาง' })
  @IsOptional()
  @IsIn(['true', 'false'])
  unpaired?: 'true' | 'false';

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'true = มีเอกสารฉบับปัจจุบันหมดภายใน 30 วันหรือหมดแล้ว (ไม่นับรถปลดระวาง) · false = ไม่มี — คำนวณตามวันนี้ (ไม่สัมพันธ์กับ updatedAt)',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  docAlert?: 'true' | 'false';
}

export class VehicleExportQuery extends VehicleListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง' })
  @IsOptional()
  @Matches(/^veh_[0-9a-f]{32}(,veh_[0-9a-f]{32}){0,199}$/)
  ids?: string;
}

export class VehicleRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}
export class VehicleTypeRefDto extends VehicleRefDto {
  @ApiProperty({ example: '6W' }) vehicleClass!: string;
}
export class PairedVehicleDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '72-1111' }) plate!: string;
  @ApiProperty({ enum: PROVINCE_CODES }) plateProvince!: string;
  @ApiProperty({ enum: UNIT_ROLES }) unitRole!: UnitRole;
}

export class VehicleDocAlertDto {
  @ApiProperty({ description: 'เอกสารฉบับปัจจุบันที่หมดภายใน 30 วัน (รวมที่หมดแล้ว)' })
  count!: number;
  @ApiProperty({ description: 'ในจำนวนนั้น หมดแล้วกี่ฉบับ' }) expired!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date', description: 'วันหมดที่ใกล้สุด' })
  nextExpiresOn!: string | null;
}

export class VehicleDto {
  @ApiProperty({ example: 'veh_3f2a…' }) id!: string;
  @ApiProperty({ example: '70-1234' }) plate!: string;
  @ApiProperty({ enum: PROVINCE_CODES, example: 'TH-10' }) plateProvince!: string;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ type: VehicleTypeRefDto }) vehicleType!: VehicleTypeRefDto;
  @ApiProperty({ enum: UNIT_ROLES }) unitRole!: UnitRole;
  @ApiProperty({ enum: OWNERSHIPS }) ownership!: OwnershipKind;
  @ApiProperty({ type: VehicleRefDto, nullable: true, description: 'ผู้รับเหมา (รถร่วม)' })
  carrier!: VehicleRefDto | null;
  @ApiProperty({ nullable: true, type: Number }) payloadKg!: number | null;
  @ApiProperty({ nullable: true, type: Number }) volumeCbm!: number | null;
  @ApiProperty({ nullable: true, type: Number }) tareWeightKg!: number | null;
  @ApiProperty({ nullable: true, type: Number }) grossWeightKg!: number | null;
  @ApiProperty({ nullable: true, type: String }) gpsProvider!: string | null;
  @ApiProperty({ nullable: true, type: String }) gpsDeviceId!: string | null;
  @ApiProperty({ nullable: true, type: String }) chassisNo!: string | null;
  @ApiProperty({ nullable: true, type: String }) engineNo!: string | null;
  @ApiProperty({ nullable: true, type: String }) brand!: string | null;
  @ApiProperty({ nullable: true, type: String }) model!: string | null;
  @ApiProperty({ nullable: true, type: Number }) year!: number | null;
  @ApiProperty({ nullable: true, type: String }) color!: string | null;
  @ApiProperty({ enum: FUEL_TYPES, nullable: true }) fuelType!: FuelType | null;
  @ApiProperty({ nullable: true, type: Number }) tankCapacityL!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: 'เลขไมล์ปัจจุบัน (กม.)' })
  odometerKm!: number | null;
  @ApiProperty({ nullable: true, type: String, example: 'MANUAL' }) odometerSource!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  odometerUpdatedAt!: string | null;
  @ApiProperty({ type: PairedVehicleDto, nullable: true, description: 'หัวลาก/หางที่จับคู่' })
  paired!: PairedVehicleDto | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'ราคาซื้อ — มีเฉพาะผู้มีสิทธิ์ reports.finance:read (ข้อมูลการเงินรถ spec/06 FLT-A)',
  })
  purchaseCost?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date' }) purchasedOn?:
    string | null;
  @ApiPropertyOptional({ enum: DEPRECIATION_METHODS, nullable: true })
  depreciationMethod?: 'STRAIGHT_LINE' | null;
  @ApiPropertyOptional({ nullable: true, type: Number }) depreciationYears?: number | null;
  @ApiPropertyOptional({ nullable: true, type: String }) salvageValue?: string | null;
  @ApiProperty({ type: [String] }) photoDocumentIds!: string[];
  @ApiProperty({ enum: VEHICLE_STATUSES }) status!: VehicleStatusKey;
  @ApiProperty({ nullable: true, type: String, description: 'เหตุผลของสถานะล่าสุด' })
  statusReason!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) retiredAt!: string | null;
  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone)',
  })
  deletedAt?: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiPropertyOptional({
    description:
      'มีเฉพาะในผลการสร้าง: true = รถที่นับโควตา (ยังไม่ปลดระวาง) เกินโควตาของ tenant แล้ว — soft limit ยังสร้างได้ (header `Warning: 299` ด้วย)',
  })
  quotaExceeded?: boolean;
  @ApiPropertyOptional({
    type: VehicleDocAlertDto,
    description:
      'มีเฉพาะในรายการ (GET /vehicles): เอกสารใกล้หมด 30 วัน/หมดแล้วของคันนี้ (รถปลดระวาง = 0) — ST2-T07 · ' +
      'คำนวณจากเอกสารและวันนี้ทุกครั้ง **ไม่ทำให้ `updatedAt` ของรถเปลี่ยน** — ผู้ที่ sync แบบ `updatedAfter` ให้ดึงเอกสารจาก `GET /vehicle-documents` แทน',
  })
  docAlert?: VehicleDocAlertDto;
}

export class VehiclePageDto {
  @ApiProperty({ type: [VehicleDto] }) data!: VehicleDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class VehicleQuotaDto {
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'โควตารถตามสัญญา/แพ็กเกจ (tenant.vehicle_quota → entitlement `veh`) — null = ไม่จำกัด',
  })
  limit!: number | null;
  @ApiProperty({ description: 'รถที่นับ = ในทะเบียนที่ยังไม่ปลดระวาง (บริษัท + รถร่วม)' })
  used!: number;
}

export class VehicleSummaryDto {
  @ApiProperty({ description: 'รถทั้งหมด (ไม่รวมที่ลบ — รวมปลดระวาง)' }) total!: number;
  @ApiProperty() ready!: number;
  @ApiProperty() maintenance!: number;
  @ApiProperty() parked!: number;
  @ApiProperty() retired!: number;
  @ApiProperty({ description: 'รถร่วม (ไม่นับปลดระวาง)' }) subcontract!: number;
  @ApiProperty({
    description: 'รถ (ไม่ปลดระวาง) ที่มีเอกสารฉบับปัจจุบันหมดภายใน 30 วันหรือหมดแล้ว',
  })
  docAlert!: number;
  @ApiProperty({ type: VehicleQuotaDto }) quota!: VehicleQuotaDto;
}

export class OdometerReadingDto {
  @ApiProperty({ example: 'odo_…' }) id!: string;
  @ApiProperty() readingKm!: number;
  @ApiProperty({ format: 'date-time' }) readAt!: string;
  @ApiProperty({ example: 'MANUAL' }) source!: string;
  @ApiProperty({ enum: ['ACCEPTED', 'SUPERSEDED'] }) status!: string;
  @ApiProperty({ enum: ODOMETER_REASONS, nullable: true }) reasonType!: OdometerReason | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'ต่างจากค่าก่อนหน้า (กม.)' })
  deltaKm!: number | null;
  @ApiProperty({ nullable: true, type: String }) originalReadingId!: string | null;
  @ApiProperty({ format: 'date-time', description: 'เวลาที่ระบบได้รับ' }) createdAt!: string;
}

export class OdometerPageDto {
  @ApiProperty({ type: [OdometerReadingDto] }) data!: OdometerReadingDto[];
}

export class OdometerResultDto {
  @ApiProperty({ type: OdometerReadingDto }) reading!: OdometerReadingDto;
  @ApiProperty({ type: VehicleDto }) vehicle!: VehicleDto;
}
