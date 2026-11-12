import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsThaiTaxId } from '../../common/thai-tax-id';
import { CleanText, IsNullable, IsOptionalNotNull, NormalizeCode } from '../master/master-kit';
import { LICENCE_CLASSES, type LicenceClass } from '../vehicle-types/vehicle-type.dto';

export { LICENCE_CLASSES, type LicenceClass };

/**
 * ประเภทคนขับ (docs/01 §3.2 — ชื่อ enum ตาม docs, plan/00a): กำหนดวิธีคิดค่าเที่ยว/เอกสารจ่าย (docs/04 B, M2)
 * EMPLOYEE_SALARIED = พขร.มีเงินเดือน · EMPLOYEE_PER_TRIP = พขร.ไม่มีเงินเดือน (ค่าเที่ยว) · CARRIER_DRIVER = คนขับของรถร่วม (ต้องมี carrierId)
 */
export const EMPLOYMENT_TYPES = [
  'EMPLOYEE_SALARIED',
  'EMPLOYEE_PER_TRIP',
  'CARRIER_DRIVER',
] as const;
export type EmploymentTypeKey = (typeof EMPLOYMENT_TYPES)[number];

/** active = พร้อมใช้ · on_leave = ลาพัก · inactive = ปิดใช้ (พ้นสภาพ/เลิกจ้าง) */
export const DRIVER_STATUSES = ['active', 'on_leave', 'inactive'] as const;
export type DriverStatusKey = (typeof DRIVER_STATUSES)[number];

/**
 * สถานะใบขับขี่ตามวันหมด (คำนวณตามวันนี้ เวลาไทย — ไม่รอ job ST2-T18):
 * valid (เหลือ > 60 วัน) · expiring (0–60 วัน — spec/06 FLT-P/FLT-300 เตือน 60/30/7) · expired (เลยวันหมด) · missing (ไม่มีวันหมด)
 */
export const LICENCE_STATUSES = ['valid', 'expiring', 'expired', 'missing'] as const;
export type LicenceStatusKey = (typeof LICENCE_STATUSES)[number];

const CODE_RE = /^[A-Z0-9][A-Z0-9_\-./]{0,19}$/;
const EXT_RE = /^[\x21-\x7e]{1,100}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** เบอร์ไทย: 0XXXXXXXX(X) หรือ +66 … — ตัวคั่นขีด/ช่องว่างได้ (normalize ที่ service) */
const PHONE_RE = /^(\+66|0)[0-9 \-]{8,16}$/;
/** เลขที่ใบขับขี่ (เลข/อักษร ขีด ทับ) */
export const LICENCE_NO_RE = /^[0-9A-Za-z][0-9A-Za-z\-/. ]{0,29}$/;
const digitsOnly = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s-]/g, '') : value,
  );

/** ฟิลด์ที่แก้ได้ (create / PATCH / PUT external) — ช่องบังคับประกาศใน DTO ของแต่ละแบบ */
export class DriverFieldsDto {
  @ApiPropertyOptional({
    example: '3100500123457',
    nullable: true,
    type: String,
    description:
      'เลขบัตรประชาชน 13 หลัก (ตรวจ check digit) — เก็บแบบเข้ารหัส ไม่คืนใน response (คืน `nationalIdLast4`) · null = ลบ',
  })
  @IsNullable()
  @digitsOnly()
  @IsThaiTaxId()
  @Matches(/^[1-8]/, { message: 'nationalId must start with 1-8' })
  nationalId?: string | null;

  @ApiPropertyOptional({ example: '58001234', nullable: true, type: String })
  @IsNullable()
  @CleanText()
  @Matches(LICENCE_NO_RE)
  licenceNo?: string | null;

  @ApiPropertyOptional({
    example: 'car_…',
    nullable: true,
    type: String,
    description:
      'รถร่วม/ผู้รับเหมาต้นสังกัด (car_… — บังคับเมื่อ CARRIER_DRIVER, ห้ามมีเมื่อเป็นคนขับบริษัท)',
  })
  @IsNullable()
  @IsString()
  carrierId?: string | null;

  @ApiPropertyOptional({
    example: 'veh_…',
    nullable: true,
    type: String,
    description:
      'รถประจำ (veh_…) — ไม่ปลดระวาง ไม่ใช่หาง; คนขับรถร่วมต้องเป็นรถของผู้รับเหมาเดียวกัน, คนขับบริษัทต้องเป็นรถบริษัท · null = ไม่มี',
  })
  @IsNullable()
  @IsString()
  defaultVehicleId?: string | null;
}

class RequiredDriverFields extends DriverFieldsDto {
  @ApiProperty({ example: 'สมชาย ใจดี', description: 'ชื่อ-นามสกุล' })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    example: '081-234-5678',
    description: 'เบอร์โทร (ไทย) — ห้ามซ้ำกับคนขับที่ยังไม่ปิดใช้งาน (ใช้ login แอปคนขับภายหลัง)',
  })
  @CleanText()
  @Matches(PHONE_RE, { message: 'phone must be a Thai phone number' })
  phone!: string;

  @ApiProperty({ enum: EMPLOYMENT_TYPES })
  @IsIn(EMPLOYMENT_TYPES)
  employmentType!: EmploymentTypeKey;

  @ApiProperty({ enum: LICENCE_CLASSES, description: 'PERSONAL = ส่วนบุคคล, T1–T4 = ท.1–ท.4' })
  @IsIn(LICENCE_CLASSES)
  licenceClass!: LicenceClass;

  @ApiProperty({
    example: '2028-03-31',
    format: 'date',
    description: 'วันหมดอายุใบขับขี่ (ใช้ได้ถึงสิ้นวัน; 2000-01-01 – 2100-12-31)',
  })
  @Matches(DATE_RE)
  licenceExpiresOn!: string;
}

export class CreateDriverDto extends RequiredDriverFields {
  @ApiPropertyOptional({ example: 'DRV-0001', description: 'รหัส — ไม่ส่ง = ระบบออกเลขถัดไป' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;

  @ApiPropertyOptional({ description: 'รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้' })
  @IsOptionalNotNull()
  @Matches(EXT_RE)
  externalId?: string;
}

/** `PUT /drivers/external/{externalId}` — ข้อมูลเต็ม (ฟิลด์ที่ไม่ส่งตอนอัปเดต = คงเดิม) */
export class UpsertDriverDto extends RequiredDriverFields {
  @ApiPropertyOptional({ example: 'DRV-0001', description: 'ใช้ตอนสร้างเท่านั้น' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;
}

export class UpdateDriverDto extends DriverFieldsDto {
  @ApiPropertyOptional({ example: 'สมชาย ใจดี' })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: '081-234-5678' })
  @IsOptionalNotNull()
  @CleanText()
  @Matches(PHONE_RE, { message: 'phone must be a Thai phone number' })
  phone?: string;

  @ApiPropertyOptional({
    enum: EMPLOYMENT_TYPES,
    description: 'เปลี่ยนเป็น/จาก CARRIER_DRIVER ต้องส่ง carrierId (หรือ null) ในคำขอเดียวกัน',
  })
  @IsOptionalNotNull()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: EmploymentTypeKey;

  @ApiPropertyOptional({ enum: LICENCE_CLASSES })
  @IsOptionalNotNull()
  @IsIn(LICENCE_CLASSES)
  licenceClass?: LicenceClass;

  @ApiPropertyOptional({ example: '2028-03-31', format: 'date' })
  @IsOptionalNotNull()
  @Matches(DATE_RE)
  licenceExpiresOn?: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'null = ลบการผูก' })
  @IsNullable()
  @Matches(EXT_RE)
  externalId?: string | null;
}

/** เปลี่ยนสถานะ — เหตุผล ≥ 10 ตัวอักษรทุกครั้ง (ลง audit + doc_status_history) */
export class DriverStatusDto {
  @ApiProperty({
    enum: DRIVER_STATUSES,
    description:
      'active = พร้อมใช้, on_leave = ลาพัก (ไม่เสนอในการจัดรถ), inactive = ปิดใช้ (พ้นสภาพ — เบอร์/เลขบัตรนำไปใช้กับ record ใหม่ได้)',
  })
  @IsIn(DRIVER_STATUSES)
  status!: DriverStatusKey;

  @ApiProperty({ minLength: 10, maxLength: 500, example: 'ลาพักร้อน 3 วัน 12–14 พ.ย.' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

/**
 * รายการคนขับ — โครงเดียวกับ `MasterListQuery` แต่สถานะเป็นของคนขับ
 * (ไม่ extends เพราะ class-validator รวม decorator ของคลาสแม่ — status ของ master จะชนกัน)
 */
export class DriverListQuery {
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

  @ApiPropertyOptional({ description: 'รายชื่อ field คั่นด้วย , เช่น id,name' })
  @IsOptional()
  @Matches(/^[a-zA-Z]+(,[a-zA-Z]+)*$/)
  fields?: string;

  @ApiPropertyOptional({
    description:
      'ค้นหา — รหัส ชื่อ เบอร์ เลขที่ใบขับขี่ externalId หรือ 4 หลักท้ายเลขบัตรประชาชน (ไม่สนตัวพิมพ์)',
    maxLength: 100,
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: 'คั่นด้วย , เช่น active,on_leave' })
  @IsOptional()
  @Matches(/^(active|on_leave|inactive)(,(active|on_leave|inactive))*$/)
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

  @ApiPropertyOptional({ description: 'ชื่อมีคำนี้' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ enum: EMPLOYMENT_TYPES })
  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: EmploymentTypeKey;

  @ApiPropertyOptional({ enum: LICENCE_CLASSES })
  @IsOptional()
  @IsIn(LICENCE_CLASSES)
  licenceClass?: LicenceClass;

  @ApiPropertyOptional({ description: 'เฉพาะคนขับของผู้รับเหมานี้ (car_…)' })
  @IsOptional()
  @Matches(/^car_[0-9a-f]{32}$/)
  carrierId?: string;

  @ApiPropertyOptional({
    description:
      'สังกัดมีคำนี้ — ชื่อผู้รับเหมา (คนขับรถร่วม) หรือชื่อบริษัทของ tenant (คนขับบริษัท)',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(200)
  affiliation?: string;

  @ApiPropertyOptional({ description: 'เฉพาะคนขับที่มีรถประจำคันนี้ (veh_…)' })
  @IsOptional()
  @Matches(/^veh_[0-9a-f]{32}$/)
  defaultVehicleId?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'true = ใบขับขี่หมดภายใน 30 วันหรือหมดแล้ว (ไม่นับคนขับปิดใช้งาน — ต้นแบบ "ใบขับขี่ใกล้หมดอายุ 30 วัน") · false = ไม่ใช่',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  licenceAlert?: 'true' | 'false';
}

export class DriverExportQuery extends DriverListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง' })
  @IsOptional()
  @Matches(/^drv_[0-9a-f]{32}(,drv_[0-9a-f]{32}){0,199}$/)
  ids?: string;
}

/** ดูเลขบัตรประชาชนเต็ม (spec/11 NFR-153) */
export class RevealDriverDto {
  @ApiPropertyOptional({ enum: ['nationalId'], default: 'nationalId' })
  @IsOptional()
  @IsIn(['nationalId'])
  field?: 'nationalId';

  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    description: 'เหตุผล ≥ 10 ตัวอักษร (ลง audit log)',
  })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class RevealDriverResultDto {
  @ApiProperty({ enum: ['nationalId'] }) field!: 'nationalId';
  @ApiProperty({ nullable: true, type: String, description: 'ค่าเต็ม — null = ไม่มีข้อมูล' })
  value!: string | null;
}

export class DriverCarrierRefDto {
  @ApiProperty({ example: 'car_…' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() legalName!: string;
}

export class DriverVehicleRefDto {
  @ApiProperty({ example: 'veh_…' }) id!: string;
  @ApiProperty({ example: '70-1234' }) plate!: string;
  @ApiProperty({ example: 'TH-10' }) plateProvince!: string;
  @ApiProperty({ example: 'รถ 6 ล้อ' }) vehicleTypeName!: string;
  @ApiProperty({ enum: ['ready', 'maintenance', 'parked', 'retired'] }) status!: string;
}

export class DriverDto {
  @ApiProperty({ example: 'drv_3f2a…' }) id!: string;
  @ApiProperty({ example: 'DRV-0001' }) code!: string;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ example: 'สมชาย ใจดี' }) name!: string;
  @ApiProperty({ example: '081-234-5678' }) phone!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '3457',
    description: '4 หลักท้ายเลขบัตรประชาชน (แสดง •••• 3457) — เลขเต็มไม่มีใน API ดูได้ทาง reveal',
  })
  nationalIdLast4!: string | null;
  @ApiProperty({ nullable: true, type: String }) licenceNo!: string | null;
  @ApiProperty({ enum: LICENCE_CLASSES, nullable: true }) licenceClass!: LicenceClass | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) licenceExpiresOn!: string | null;
  @ApiProperty({ enum: LICENCE_STATUSES }) licenceStatus!: LicenceStatusKey;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'จำนวนวันถึงวันหมด (ติดลบ = หมดมาแล้ว) ตามวันนี้เวลาไทย',
  })
  licenceDaysToExpiry!: number | null;
  @ApiProperty({ enum: EMPLOYMENT_TYPES }) employmentType!: EmploymentTypeKey;
  @ApiProperty({ type: DriverCarrierRefDto, nullable: true }) carrier!: DriverCarrierRefDto | null;
  @ApiProperty({ type: DriverVehicleRefDto, nullable: true })
  defaultVehicle!: DriverVehicleRefDto | null;
  @ApiProperty({ enum: DRIVER_STATUSES }) status!: DriverStatusKey;
  @ApiProperty({ nullable: true, type: String, description: 'เหตุผลการเปลี่ยนสถานะล่าสุด' })
  statusReason!: string | null;
  @ApiPropertyOptional({ format: 'date-time', description: 'มีเฉพาะรายการที่ถูกลบ (tombstone)' })
  deletedAt?: string;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class DriverPageDto {
  @ApiProperty({ type: [DriverDto] }) data!: DriverDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class DriverSummaryDto {
  @ApiProperty({ description: 'คนขับทั้งหมด (ไม่รวมที่ลบ — รวมปิดใช้งาน)' }) total!: number;
  @ApiProperty({ description: 'พร้อมใช้' }) active!: number;
  @ApiProperty({ description: 'ลาพัก' }) onLeave!: number;
  @ApiProperty({ description: 'ปิดใช้' }) inactive!: number;
  @ApiProperty({
    description: 'คนขับ (ไม่ปิดใช้งาน) ที่ใบขับขี่หมดภายใน 30 วันหรือหมดแล้ว',
  })
  licenceAlert!: number;
  @ApiProperty({ description: 'คนขับรถร่วม (ไม่ปิดใช้งาน)' }) carrierDrivers!: number;
}
