import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CleanText, IsNullable, IsOptionalNotNull } from '../master/master-kit';
import { OWNERSHIPS, type OwnershipKind } from '../vehicles/vehicle.dto';
import { VEHICLE_DOC_TYPES as DOMAIN_VEHICLE_DOC_TYPES } from '@tms/domain';

/** docs/01 §3.8 `doc_type` — ใบขับขี่อยู่ที่คนขับ ไม่ซ้ำที่นี่ (แหล่งเดียว: @tms/domain — ST2-T20 ใช้ร่วม) */
export const VEHICLE_DOC_TYPES = DOMAIN_VEHICLE_DOC_TYPES;
export type VehicleDocTypeKey = (typeof VEHICLE_DOC_TYPES)[number];
/**
 * สถานะที่ API คืน — คำนวณจากวันหมดทุกครั้ง (ไม่รอ job รายวัน ST2-T18):
 * active (เหลือ > 60 วัน) · expiring (0–60 วัน) · expired (เลยวันหมด — วันหมดใช้ได้ทั้งวัน FLT-042) · superseded (ต่ออายุแล้ว) · cancelled
 */
export const VEHICLE_DOC_STATUSES = [
  'active',
  'expiring',
  'expired',
  'superseded',
  'cancelled',
] as const;
export type VehicleDocStatusKey = (typeof VEHICLE_DOC_STATUSES)[number];

const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_ID_RE = /^doc_[0-9a-f]{32}$/;

/** ช่องร่วมของเอกสารที่ส่งได้ทั้งตอนเพิ่มและตอนต่ออายุ */
class VehicleDocumentBaseInput {
  @ApiPropertyOptional({
    example: 'POL-27-10431',
    description: 'เลขกรมธรรม์ / เลขใบอนุญาต / เลขที่เอกสาร — บังคับ ยกเว้น OTHER',
  })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  docNo?: string;

  @ApiPropertyOptional({
    example: 'วิริยะประกันภัย',
    nullable: true,
    type: String,
    description: 'บริษัทประกัน / หน่วยงานที่ออก',
  })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(120)
  issuer?: string | null;

  @ApiProperty({
    example: '2026-11-30',
    format: 'date',
    description: 'วันเริ่มมีผล (1980-01-01 – 2100-12-31)',
  })
  @Matches(DATE_RE)
  startsOn!: string;

  @ApiProperty({
    example: '2027-11-30',
    format: 'date',
    description: 'วันหมดอายุ (ใช้ได้ถึงสิ้นวัน) — ต้องหลังวันเริ่ม',
  })
  @Matches(DATE_RE)
  expiresOn!: string;

  @ApiPropertyOptional({
    example: '1',
    nullable: true,
    type: String,
    description: 'ชั้นประกัน — เฉพาะ INSURANCE',
  })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(20)
  insuranceClass?: string | null;

  @ApiPropertyOptional({
    example: '800000.00',
    nullable: true,
    type: String,
    description: 'ทุนประกัน — เฉพาะ INSURANCE',
  })
  @IsNullable()
  @Matches(MONEY_RE)
  sumInsured?: string | null;

  @ApiPropertyOptional({
    example: '28500.00',
    nullable: true,
    type: String,
    description: 'เบี้ยประกัน — เฉพาะ INSURANCE',
  })
  @IsNullable()
  @Matches(MONEY_RE)
  premiumAmount?: string | null;

  @ApiPropertyOptional({
    example: '28500.00',
    nullable: true,
    type: String,
    description:
      'ค่าใช้จ่ายของฉบับนี้ (เบี้ย / ค่าธรรมเนียม) — รถบริษัท: เขียน vehicle_cost หมวด DOCUMENT 1 แถว',
  })
  @IsNullable()
  @Matches(MONEY_RE)
  costAmount?: string | null;

  @ApiProperty({
    type: [String],
    example: ['doc_…'],
    description:
      'ไฟล์แนบ (PDF/รูป) จาก POST /v1/documents kind=VEHICLE_DOC ที่อัปโหลดเสร็จแล้ว — อย่างน้อย 1 ไฟล์ (spec/06 FLT-C)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @Matches(DOC_ID_RE, { each: true })
  fileDocumentIds!: string[];

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 500 })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class CreateVehicleDocumentDto extends VehicleDocumentBaseInput {
  @ApiProperty({ enum: VEHICLE_DOC_TYPES })
  @IsIn(VEHICLE_DOC_TYPES)
  docType!: VehicleDocTypeKey;

  @ApiPropertyOptional({
    example: 'สัญญาเช่าที่จอด',
    description: 'ชื่อเอกสาร — บังคับเมื่อ docType = OTHER',
  })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  title?: string;

  @ApiPropertyOptional({
    description:
      'หมดอายุแล้วห้ามจ่ายงาน (ใช้ใน ST3) — ไม่ส่ง = true สำหรับ INSURANCE / COMPULSORY_ACT (docs/01 §3.8)',
  })
  @IsOptionalNotNull()
  @IsBoolean()
  isRequiredForDispatch?: boolean;
}

/** ต่ออายุ = ฉบับใหม่อ้างฉบับเดิม (FLT-043) — ช่องที่ไม่ส่ง (ผู้ออก ชั้น ทุน ชื่อเอกสาร) คัดลอกจากฉบับเดิม */
export class RenewVehicleDocumentDto extends VehicleDocumentBaseInput {
  @ApiPropertyOptional({
    description: 'ชื่อเอกสารใหม่ — เฉพาะ OTHER (ไม่ส่ง = ชื่อเดิม)',
  })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  title?: string;
}

export class CancelVehicleDocumentDto {
  @ApiProperty({ minLength: 10, maxLength: 500, description: 'เหตุผล (ลง audit)' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class VehicleDocumentListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ description: 'คั่นด้วย , เช่น INSURANCE,COMPULSORY_ACT' })
  @IsOptional()
  @Matches(
    /^(INSURANCE|COMPULSORY_ACT|ANNUAL_TAX|INSPECTION|TRANSPORT_LICENSE|GPS_DLT_CERT|OTHER)(,(INSURANCE|COMPULSORY_ACT|ANNUAL_TAX|INSPECTION|TRANSPORT_LICENSE|GPS_DLT_CERT|OTHER))*$/,
  )
  docType?: string;

  @ApiPropertyOptional({
    description:
      'คั่นด้วย , (active, expiring, expired, superseded, cancelled) — ไม่ส่ง = ฉบับปัจจุบัน (active,expiring,expired)',
  })
  @IsOptional()
  @Matches(
    /^(active|expiring|expired|superseded|cancelled)(,(active|expiring|expired|superseded|cancelled))*$/,
  )
  status?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 3650,
    description: 'หมดภายใน N วันนับจากวันนี้ (ไม่รวมที่หมดแล้ว) เช่น 30 = หมดวันนี้ถึงอีก 30 วัน',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  expiresWithinDays?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 3650,
    description:
      'หมดหลังจากอีก N วัน เช่น 30 = เหลือมากกว่า 30 วัน (สถานะ "ปกติ" ของหน้าเอกสารรถรวม) — ใช้ร่วมกับ expiresWithinDays ได้',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  expiresBeyondDays?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 3650,
    description:
      'ถึงกำหนดต่อภายใน N วัน = หมดแล้ว หรือหมดภายใน N วัน (เช่น 30 = ไฟล์ "ส่งออกให้ฝ่ายธุรการ" ของต้นแบบ)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  dueWithinDays?: number;

  @ApiPropertyOptional({ maxLength: 60, description: 'ค้นหาเลขที่เอกสาร (บางส่วน ไม่สนตัวพิมพ์)' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(60)
  docNo?: string;

  @ApiPropertyOptional({
    maxLength: 120,
    description: 'ค้นหาบริษัท / หน่วยงาน (บางส่วน ไม่สนตัวพิมพ์)',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(120)
  issuer?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    default: 'false',
    description:
      'รวมเอกสารของรถปลดระวาง — ค่าเริ่มต้นไม่รวม (รถที่เลิกใช้ไม่ต้องต่ออายุ ตรงกับป้าย docAlert) · ระบุ vehicleId แล้วรวมเสมอ',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  includeRetired?: 'true' | 'false';

  @ApiPropertyOptional({ example: 'veh_…', description: 'เฉพาะรถคันนี้' })
  @IsOptional()
  @Matches(/^veh_[0-9a-f]{32}$/)
  vehicleId?: string;

  @ApiPropertyOptional({ maxLength: 20, description: 'ค้นหาทะเบียน (ไม่สนช่องว่าง/ขีด)' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(20)
  plate?: string;
}

/** ส่งออกเอกสารรถ (ST2-T19 ต้นแบบ "ส่งออกให้ฝ่ายธุรการ") — ตัวกรองเดียวกับรายการ หรือเฉพาะแถวที่เลือก */
export class VehicleDocumentExportQuery extends VehicleDocumentListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง' })
  @IsOptional()
  @Matches(/^vdoc_[0-9a-f]{32}(,vdoc_[0-9a-f]{32}){0,199}$/)
  ids?: string;
}

/**
 * ตัวนับหน้าเอกสารรถรวม (ST2-T19; ต้นแบบ kpisF('fdoc') + แท็บ) — เฉพาะฉบับปัจจุบันของรถที่ไม่ปลดระวาง
 * "ภายใน N วัน" = หมดวันนี้ถึงอีก N วัน (ไม่รวมที่หมดแล้ว) — วันตามเวลาไทย
 */
export class VehicleDocumentSummaryDto {
  @ApiProperty({ description: 'ฉบับปัจจุบันทั้งหมด' }) total!: number;
  @ApiProperty({ description: 'หมดแล้ว (เลยวันหมด)' }) expired!: number;
  @ApiProperty({ description: 'หมดภายใน 7 วัน' }) within7!: number;
  @ApiProperty({ description: 'หมดภายใน 30 วัน' }) within30!: number;
  @ApiProperty({ description: 'หมดภายใน 60 วัน' }) within60!: number;
}

export class VehicleDocumentVehicleDto {
  @ApiProperty({ example: 'veh_…' }) id!: string;
  @ApiProperty({ example: '70-1234' }) plate!: string;
  @ApiProperty({ example: 'TH-10' }) plateProvince!: string;
  @ApiProperty({ enum: OWNERSHIPS }) ownership!: OwnershipKind;
}

export class VehicleDocumentFileDto {
  @ApiProperty({ example: 'doc_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) filename!: string | null;
  @ApiProperty() mime!: string;
  @ApiProperty() bytes!: number;
}

export class VehicleDocumentDto {
  @ApiProperty({ example: 'vdoc_…' }) id!: string;
  @ApiProperty({ type: VehicleDocumentVehicleDto }) vehicle!: VehicleDocumentVehicleDto;
  @ApiProperty({ enum: VEHICLE_DOC_TYPES }) docType!: VehicleDocTypeKey;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อเอกสาร (OTHER)' })
  title!: string | null;
  @ApiProperty({ nullable: true, type: String }) docNo!: string | null;
  @ApiProperty({ nullable: true, type: String }) issuer!: string | null;
  @ApiProperty({ format: 'date' }) startsOn!: string;
  @ApiProperty({ format: 'date' }) expiresOn!: string;
  @ApiProperty({ enum: VEHICLE_DOC_STATUSES }) status!: VehicleDocStatusKey;
  @ApiProperty({
    description:
      'จำนวนวันจากวันนี้ (เวลาไทย) ถึงวันหมด — 0 = หมดวันนี้ (ยังใช้ได้), ติดลบ = หมดแล้ว',
  })
  daysToExpiry!: number;
  @ApiProperty({ nullable: true, type: String }) insuranceClass!: string | null;
  @ApiProperty({ nullable: true, type: String }) sumInsured!: string | null;
  @ApiProperty({ nullable: true, type: String }) premiumAmount!: string | null;
  @ApiProperty({ nullable: true, type: String }) costAmount!: string | null;
  @ApiProperty({ type: [VehicleDocumentFileDto] }) files!: VehicleDocumentFileDto[];
  @ApiProperty() isRequiredForDispatch!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'ฉบับก่อนหน้า (ที่ฉบับนี้ต่ออายุ)' })
  renewsDocumentId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ฉบับที่ต่ออายุจากฉบับนี้' })
  renewedByDocumentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) cancelledAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class VehicleDocumentListDto {
  @ApiProperty({ type: [VehicleDocumentDto] }) data!: VehicleDocumentDto[];
}

export class VehicleDocumentPageDto extends VehicleDocumentListDto {
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class VehicleDocumentRenewResultDto {
  @ApiProperty({ type: VehicleDocumentDto, description: 'ฉบับใหม่' }) document!: VehicleDocumentDto;
  @ApiProperty({ type: VehicleDocumentDto, description: 'ฉบับเดิม (superseded)' })
  previous!: VehicleDocumentDto;
}
