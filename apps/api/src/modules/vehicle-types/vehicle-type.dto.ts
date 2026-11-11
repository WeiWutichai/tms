import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CleanText,
  IsNullable,
  IsOptionalNotNull,
  MasterListQuery,
  NormalizeCode,
} from '../master/master-kit';

/**
 * ชั้นรถ (docs/01 §3.2 enum `vehicle_type` → plan/00a: คงเป็นคอลัมน์ class ของ master) เรียงเล็ก → ใหญ่
 * ใช้เทียบกับ `customer_site.max_vehicle_class` (ST2-T02: 6W/10W/TRAILER/SEMI_TRAILER) — ห้องเย็นเป็นป้าย ไม่ใช่ชั้น
 * `sizeRank` ของ spec/02 §4 (4 ล้อ=1, 6 ล้อ=3, 10 ล้อ=5, พ่วง/เทรลเลอร์=8) คำนวณจากชั้น ไม่เก็บแยก
 */
export const VEHICLE_CLASSES = ['4W', '6W', '10W', 'TRAILER', 'SEMI_TRAILER'] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];
export const VEHICLE_CLASS_RANK: Record<VehicleClass, number> = {
  '4W': 1,
  '6W': 3,
  '10W': 5,
  TRAILER: 8,
  SEMI_TRAILER: 8,
};

/** ใบขับขี่ขั้นต่ำ — ลำดับ "สูงกว่าใช้แทนต่ำกว่าได้" (MD-090 [PROPOSED → OPEN-MD-4]) */
export const LICENCE_CLASSES = ['PERSONAL', 'T1', 'T2', 'T3', 'T4'] as const;
export type LicenceClass = (typeof LICENCE_CLASSES)[number];

/**
 * capability tags (docs/04 B รถ: ห้องเย็น ติดเครน ลากตู้ + spec/02 §4 `hazmatAllowed`)
 * รายการคงที่ของระบบ (CHECK ใน migration 0039) — เพิ่มป้าย = แก้ที่นี่ + migration · ชื่อไทยอยู่ใน i18n ของเว็บ
 */
export const VEHICLE_CAPABILITIES = ['REFRIGERATED', 'CRANE', 'CONTAINER', 'HAZMAT'] as const;
export type VehicleCapability = (typeof VEHICLE_CAPABILITIES)[number];

const CODE_RE = /^[A-Z0-9][A-Z0-9_\-./]{0,19}$/;
const EXT_RE = /^[\x21-\x7e]{1,100}$/;

/** ฟิลด์ที่แก้ได้ (create / PATCH / PUT external) — ช่องบังคับประกาศใน DTO ของแต่ละแบบ */
export class VehicleTypeFieldsDto {
  @ApiPropertyOptional({
    example: 40,
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
    enum: VEHICLE_CAPABILITIES,
    isArray: true,
    description:
      'ความสามารถพิเศษ: REFRIGERATED = ห้องเย็น (ต้องมี tempMinC/tempMaxC), CRANE = ติดเครน, CONTAINER = ลากตู้คอนเทนเนอร์, HAZMAT = ขนสินค้าอันตรายได้',
  })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(VEHICLE_CAPABILITIES.length)
  @IsIn(VEHICLE_CAPABILITIES, { each: true })
  capabilityTags?: VehicleCapability[];

  @ApiPropertyOptional({
    example: 0,
    nullable: true,
    type: Number,
    description: 'ห้องเย็น: อุณหภูมิต่ำสุด (°C) — ส่งคู่กับ tempMaxC และ min < max',
  })
  @IsNullable()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(-99)
  @Max(99)
  tempMinC?: number | null;

  @ApiPropertyOptional({ example: 8, nullable: true, type: Number })
  @IsNullable()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(-99)
  @Max(99)
  tempMaxC?: number | null;
}

class RequiredVehicleTypeFields extends VehicleTypeFieldsDto {
  @ApiProperty({ example: '10 ล้อ ตู้แห้ง', description: 'ชื่อประเภทรถ — ห้ามซ้ำ (ไม่สนตัวพิมพ์)' })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    enum: VEHICLE_CLASSES,
    description:
      'ชั้นรถ: 4W = 4 ล้อ, 6W = 6 ล้อ, 10W = 10 ล้อ, TRAILER = พ่วง, SEMI_TRAILER = หัวลาก + หางเทรลเลอร์ — เทียบกับ "รถเข้าได้สูงสุด" ของสถานที่',
  })
  @IsIn(VEHICLE_CLASSES)
  vehicleClass!: VehicleClass;

  @ApiProperty({ example: 15000, description: 'น้ำหนักบรรทุกมาตรฐาน (กก.) > 0' })
  @IsInt()
  @Min(1)
  @Max(99_999_999)
  payloadKg!: number;

  @ApiProperty({
    enum: LICENCE_CLASSES,
    description: 'ใบขับขี่ขั้นต่ำ: PERSONAL = ส่วนบุคคล, T1–T4 = ท.1–ท.4',
  })
  @IsIn(LICENCE_CLASSES)
  minLicenceClass!: LicenceClass;
}

export class CreateVehicleTypeDto extends RequiredVehicleTypeFields {
  @ApiPropertyOptional({
    example: '10W-DRY',
    description: 'รหัส — ไม่ส่ง = ระบบออกเลขถัดไป `VT-0001` (MD-002)',
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

/** `PUT /vehicle-types/external/{externalId}` — ข้อมูลเต็ม (ฟิลด์ที่ไม่ส่งตอนอัปเดต = คงเดิม) */
export class UpsertVehicleTypeDto extends RequiredVehicleTypeFields {
  @ApiPropertyOptional({ example: '10W-DRY', description: 'ใช้ตอนสร้างเท่านั้น' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;
}

export class UpdateVehicleTypeDto extends VehicleTypeFieldsDto {
  @ApiPropertyOptional({ example: '10 ล้อ ตู้แห้ง' })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ enum: VEHICLE_CLASSES })
  @IsOptionalNotNull()
  @IsIn(VEHICLE_CLASSES)
  vehicleClass?: VehicleClass;

  @ApiPropertyOptional({ example: 15000 })
  @IsOptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(99_999_999)
  payloadKg?: number;

  @ApiPropertyOptional({ enum: LICENCE_CLASSES })
  @IsOptionalNotNull()
  @IsIn(LICENCE_CLASSES)
  minLicenceClass?: LicenceClass;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'null = ลบการผูก' })
  @IsNullable()
  @Matches(EXT_RE)
  externalId?: string | null;
}

export class VehicleTypeListQuery extends MasterListQuery {
  @ApiPropertyOptional({ description: 'ชื่อมีคำนี้' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ enum: VEHICLE_CLASSES })
  @IsOptional()
  @IsIn(VEHICLE_CLASSES)
  vehicleClass?: VehicleClass;

  @ApiPropertyOptional({ enum: LICENCE_CLASSES })
  @IsOptional()
  @IsIn(LICENCE_CLASSES)
  minLicenceClass?: LicenceClass;

  @ApiPropertyOptional({ enum: VEHICLE_CAPABILITIES, description: 'มีป้ายนี้' })
  @IsOptional()
  @IsIn(VEHICLE_CAPABILITIES)
  capability?: VehicleCapability;
}

export class VehicleTypeExportQuery extends VehicleTypeListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง' })
  @IsOptional()
  @Matches(/^vty_[0-9a-f]{32}(,vty_[0-9a-f]{32}){0,199}$/)
  ids?: string;
}

export class VehicleTypeUsageDto {
  @ApiProperty({ description: 'รถในทะเบียนที่ใช้ประเภทนี้ (ไม่นับที่ปลดระวาง)' }) vehicles!: number;
  @ApiProperty({ description: 'rate card ที่อ้างประเภทนี้' }) rateCards!: number;
}

export class VehicleTypeDto {
  @ApiProperty({ example: 'vty_3f2a…' }) id!: string;
  @ApiProperty({ example: '10W' }) code!: string;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ example: '10 ล้อ' }) name!: string;
  @ApiProperty({ enum: VEHICLE_CLASSES }) vehicleClass!: VehicleClass;
  @ApiProperty({ description: 'ขนาดเทียบข้อจำกัดสถานที่ (spec/02 §4 sizeRank) — คำนวณจากชั้นรถ' })
  sizeRank!: number;
  @ApiProperty({ nullable: true, type: Number, example: 15000 }) payloadKg!: number | null;
  @ApiProperty({ nullable: true, type: Number, example: 40 }) volumeCbm!: number | null;
  @ApiProperty({ enum: LICENCE_CLASSES, nullable: true })
  minLicenceClass!: LicenceClass | null;
  @ApiProperty({ enum: VEHICLE_CAPABILITIES, isArray: true })
  capabilityTags!: VehicleCapability[];
  @ApiProperty({ nullable: true, type: Number, example: 0 }) tempMinC!: number | null;
  @ApiProperty({ nullable: true, type: Number, example: 8 }) tempMaxC!: number | null;
  @ApiProperty({ description: 'แถวค่าเริ่มต้นที่ระบบสร้างให้ (แก้/ปิดใช้/ลบได้เหมือนแถวอื่น)' })
  system!: boolean;
  @ApiProperty({ type: VehicleTypeUsageDto }) usage!: VehicleTypeUsageDto;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: 'active' | 'inactive';
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
}

export class VehicleTypePageDto {
  @ApiProperty({ type: [VehicleTypeDto] }) data!: VehicleTypeDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class VehicleTypeSummaryDto {
  @ApiProperty({ description: 'ประเภทรถทั้งหมด (ไม่รวมที่ลบ)' }) total!: number;
  @ApiProperty() active!: number;
  @ApiProperty() inactive!: number;
  @ApiProperty({ description: 'รถในทะเบียน (ไม่นับที่ปลดระวาง)' }) vehicles!: number;
  @ApiProperty({ description: 'rate card ที่อ้างประเภทรถ' }) rateCards!: number;
}
