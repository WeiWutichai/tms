import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsDecimal } from '../../common/validation';
import {
  CleanText,
  IsNullable,
  IsOptionalNotNull,
  MasterListQuery,
  NormalizeCode,
} from '../master/master-kit';
import { UNIT_KINDS, type UnitKind } from './unit.dto';

/** รหัสสินค้า string(30) (spec/02 §3) — รหัสสินค้าของลูกค้าใช้ได้ */
const CODE_RE = /^[A-Z0-9][A-Z0-9_\-./]{0,29}$/;
const EXT_RE = /^[\x21-\x7e]{1,100}$/;
/** หน่วย: id (`unt_…`) หรือรหัสหน่วย `code:BAG` (สะดวกสำหรับระบบต้นทางที่ไม่รู้ id) */
export const UNIT_REF_RE = /^(unt_[0-9a-f]{32}|code:[A-Za-z0-9][A-Za-z0-9_\-.]{0,9})$/;
/** เลข UN 4 หลัก — รับ "UN1993" / "un 1993" แล้วเก็บ "1993" */
const UN_RE = /^\d{4}$/;
/**
 * class/division ตามระบบ UN (spec/02 §3 class 1–9): 1.1–1.6, 2.1–2.3, 3, 4.1–4.3, 5.1–5.2, 6.1–6.2, 7, 8, 9
 * (review ST2-T10 #7 — CHECK เดียวกันใน migration 0049)
 */
export const HAZARD_CLASSES = [
  '1.1',
  '1.2',
  '1.3',
  '1.4',
  '1.5',
  '1.6',
  '2.1',
  '2.2',
  '2.3',
  '3',
  '4.1',
  '4.2',
  '4.3',
  '5.1',
  '5.2',
  '6.1',
  '6.2',
  '7',
  '8',
  '9',
] as const;
export const TEMP_MIN = -40;
export const TEMP_MAX = 30;
export const ALT_UNITS_MAX = 10;

/** ประเภทพิเศษสำหรับตัวกรอง (ต้นแบบ specProd: —/เปราะบาง/อันตราย/ควบคุมอุณหภูมิ + แท็บ ทั่วไป/ประเภทพิเศษ) */
export const PRODUCT_SPECIALS = ['none', 'any', 'fragile', 'hazardous', 'temp'] as const;
export type ProductSpecial = (typeof PRODUCT_SPECIALS)[number];

/** ป้ายความสามารถของประเภทรถที่สินค้าต้องการ (ใช้ชื่อเดียวกับ vehicle_type.capability_tags — ST2-T16) */
export const PRODUCT_REQUIRED_CAPABILITIES = ['REFRIGERATED', 'HAZMAT'] as const;
export type ProductRequiredCapability = (typeof PRODUCT_REQUIRED_CAPABILITIES)[number];

const UnNumber = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/^\s*UN\s*/i, '').trim() : value,
  );

export class AltUnitInputDto {
  @ApiProperty({ example: 'code:PLT', description: 'หน่วยแปลง: `unt_…` หรือ `code:{รหัสหน่วย}`' })
  @IsString()
  @Matches(UNIT_REF_RE)
  unitId!: string;

  @ApiProperty({ example: 40, description: '1 หน่วยนี้ = ? หน่วยหลัก (> 0) เช่น 1 พาเลท = 40 ถุง' })
  @IsDecimal(6)
  @Min(0.000001)
  @Max(99_999_999)
  factorToBase!: number;
}

/** ฟิลด์ที่แก้ได้ (create / PATCH / PUT external) — ช่องบังคับประกาศใน DTO ของแต่ละแบบ */
export class ProductFieldsDto {
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'cus_3f2a…',
    description: 'สินค้าของลูกค้ารายเดียว — null/ไม่ส่ง = ใช้ได้ทุกลูกค้า',
  })
  @IsNullable()
  @Matches(/^cus_[0-9a-f]{32}$/)
  customerId?: string | null;

  @ApiPropertyOptional({
    example: 50,
    nullable: true,
    type: Number,
    description:
      'น้ำหนักต่อหน่วยหลัก (กก.) > 0 ทศนิยม 3 — บังคับเมื่อหน่วยเป็นชนิดนับ (COUNT); หน่วยน้ำหนัก = ตัวแปลงของหน่วย (ไม่ส่งได้)',
  })
  @IsNullable()
  @IsDecimal(3)
  @Min(0.001)
  @Max(999_999_999)
  weightPerUnitKg?: number | null;

  @ApiPropertyOptional({
    example: 0.035,
    nullable: true,
    type: Number,
    description: 'ปริมาตรต่อหน่วยหลัก (ลบ.ม.) ≥ 0 ทศนิยม 4 — หน่วยปริมาตร = ตัวแปลงของหน่วย',
  })
  @IsNullable()
  @IsDecimal(4)
  @Min(0)
  @Max(99_999_999)
  volumePerUnitCbm?: number | null;

  @ApiPropertyOptional({
    type: [AltUnitInputDto],
    description: `หน่วยแปลง (แทนทั้งชุด) ≤ ${ALT_UNITS_MAX} — ห้ามซ้ำ ห้ามเป็นหน่วยหลัก`,
  })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(ALT_UNITS_MAX)
  @ValidateNested({ each: true })
  @Type(() => AltUnitInputDto)
  altUnits?: AltUnitInputDto[];

  @ApiPropertyOptional({ description: 'เปราะบาง' })
  @IsOptionalNotNull()
  @IsBoolean()
  fragile?: boolean;

  @ApiPropertyOptional({
    description: 'สินค้าอันตราย — ต้องมี unNumber + hazardClass (ต้องใช้รถป้าย HAZMAT)',
  })
  @IsOptionalNotNull()
  @IsBoolean()
  hazardous?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '1993',
    description: 'เลข UN 4 หลัก (รับ "UN1993")',
  })
  @IsNullable()
  @UnNumber()
  @IsString()
  @Matches(UN_RE)
  unNumber?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '3',
    enum: HAZARD_CLASSES,
    description: 'class/division UN เช่น 3, 2.1, 4.3',
  })
  @IsNullable()
  @IsString()
  @IsIn(HAZARD_CLASSES)
  hazardClass?: string | null;

  @ApiPropertyOptional({
    description:
      'ควบคุมอุณหภูมิ — ต้องมี tempMinC/tempMaxC (ต้องใช้รถห้องเย็นที่ช่วงอุณหภูมิครอบคลุม)',
  })
  @IsOptionalNotNull()
  @IsBoolean()
  tempControlled?: boolean;

  @ApiPropertyOptional({
    example: 2,
    nullable: true,
    type: Number,
    description: `°C ${TEMP_MIN}…${TEMP_MAX}, min < max`,
  })
  @IsNullable()
  @IsDecimal(1)
  @Min(TEMP_MIN)
  @Max(TEMP_MAX)
  tempMinC?: number | null;

  @ApiPropertyOptional({ example: 8, nullable: true, type: Number })
  @IsNullable()
  @IsDecimal(1)
  @Min(TEMP_MIN)
  @Max(TEMP_MAX)
  tempMaxC?: number | null;

  @ApiPropertyOptional({ description: 'วางซ้อนได้ (ค่าเริ่มต้น true)' })
  @IsOptionalNotNull()
  @IsBoolean()
  stackable?: boolean;

  @ApiPropertyOptional({ nullable: true, type: String, example: '8851234567890' })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(50)
  barcode?: string | null;
}

class RequiredProductFields extends ProductFieldsDto {
  @ApiProperty({ example: 'ปูนซีเมนต์ถุง 50 กก.' })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    example: 'code:BAG',
    description: 'หน่วยหลัก: `unt_…` หรือ `code:{รหัสหน่วย}` (หน่วยต้องใช้งานอยู่)',
  })
  @IsString()
  @Matches(UNIT_REF_RE)
  unitId!: string;
}

export class CreateProductDto extends RequiredProductFields {
  @ApiPropertyOptional({
    example: 'P-0001',
    description: 'รหัส — ไม่ส่ง = ระบบออกเลขถัดไป `P-0001` (MD-002)',
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

/** `PUT /products/external/{externalId}` — ข้อมูลเต็ม (ฟิลด์ที่ไม่ส่งตอนอัปเดต = คงเดิม) */
export class UpsertProductDto extends RequiredProductFields {
  @ApiPropertyOptional({ example: 'P-0001', description: 'ใช้ตอนสร้างเท่านั้น' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;
}

export class UpdateProductDto extends ProductFieldsDto {
  @ApiPropertyOptional({ example: 'ปูนซีเมนต์ถุง 50 กก.' })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'P-0001', description: 'แก้รหัส (MD-002)' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;

  @ApiPropertyOptional({ example: 'code:BAG' })
  @IsOptionalNotNull()
  @IsString()
  @Matches(UNIT_REF_RE)
  unitId?: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'null = ลบการผูก' })
  @IsNullable()
  @Matches(EXT_RE)
  externalId?: string | null;
}

export class ProductListQuery extends MasterListQuery {
  @ApiPropertyOptional({ description: 'ชื่อหรือรหัสมีคำนี้ (ช่องกรองคอลัมน์ "สินค้า / รหัส")' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'หน่วยหลัก (`unt_…`)' })
  @IsOptional()
  @Matches(/^unt_[0-9a-f]{32}$/)
  unitId?: string;

  @ApiPropertyOptional({
    enum: PRODUCT_SPECIALS,
    description:
      'none = ทั่วไป, any = มีประเภทพิเศษ, fragile/hazardous/temp = เปราะบาง/อันตราย/ควบคุมอุณหภูมิ',
  })
  @IsOptional()
  @IsIn(PRODUCT_SPECIALS)
  special?: ProductSpecial;

  @ApiPropertyOptional({
    description: '`cus_…` = สินค้าของลูกค้ารายนี้ · `none` = สินค้าที่ใช้ได้ทุกลูกค้า',
  })
  @IsOptional()
  @Matches(/^(cus_[0-9a-f]{32}|none)$/)
  customerId?: string;
}

export class ProductExportQuery extends ProductListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง' })
  @IsOptional()
  @Matches(/^prd_[0-9a-f]{32}(,prd_[0-9a-f]{32}){0,199}$/)
  ids?: string;
}

export class ProductUnitRefDto {
  @ApiProperty({ example: 'unt_3f2a…' }) id!: string;
  @ApiProperty({ example: 'BAG' }) code!: string;
  @ApiProperty({ example: 'ถุง' }) name!: string;
  @ApiProperty({ enum: UNIT_KINDS }) kind!: UnitKind;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: 'active' | 'inactive';
}

export class ProductAltUnitDto {
  @ApiProperty({ type: ProductUnitRefDto }) unit!: ProductUnitRefDto;
  @ApiProperty({ example: 40 }) factorToBase!: number;
}

export class ProductCustomerRefDto {
  @ApiProperty({ example: 'cus_3f2a…' }) id!: string;
  @ApiProperty({ example: 'CUS-0001' }) code!: string;
  @ApiProperty({ example: 'บริษัท ตัวอย่าง จำกัด' }) name!: string;
}

export class ProductDto {
  @ApiProperty({ example: 'prd_3f2a…' }) id!: string;
  @ApiProperty({ example: 'P-0001' }) code!: string;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ example: 'ปูนซีเมนต์ถุง 50 กก.' }) name!: string;
  @ApiProperty({ type: ProductCustomerRefDto, nullable: true })
  customer!: ProductCustomerRefDto | null;
  @ApiProperty({ type: ProductUnitRefDto, description: 'หน่วยหลัก' }) unit!: ProductUnitRefDto;
  @ApiProperty({ nullable: true, type: Number, example: 50 }) weightPerUnitKg!: number | null;
  @ApiProperty({ nullable: true, type: Number, example: 0.035 }) volumePerUnitCbm!: number | null;
  @ApiProperty({ type: [ProductAltUnitDto] }) altUnits!: ProductAltUnitDto[];
  @ApiProperty() fragile!: boolean;
  @ApiProperty() hazardous!: boolean;
  @ApiProperty({ nullable: true, type: String, example: '1993' }) unNumber!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '3' }) hazardClass!: string | null;
  @ApiProperty() tempControlled!: boolean;
  @ApiProperty({ nullable: true, type: Number, example: 2 }) tempMinC!: number | null;
  @ApiProperty({ nullable: true, type: Number, example: 8 }) tempMaxC!: number | null;
  @ApiProperty() stackable!: boolean;
  @ApiProperty({ nullable: true, type: String }) barcode!: string | null;
  @ApiProperty({
    enum: PRODUCT_REQUIRED_CAPABILITIES,
    isArray: true,
    description:
      'ป้ายความสามารถของประเภทรถที่ต้องใช้ (คำนวณ): ควบคุมอุณหภูมิ → REFRIGERATED (ช่วงอุณหภูมิรถต้องครอบคลุม), อันตราย → HAZMAT',
  })
  requiredCapabilities!: ProductRequiredCapability[];
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

export class ProductPageDto {
  @ApiProperty({ type: [ProductDto] }) data!: ProductDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class ProductSummaryDto {
  @ApiProperty({ description: 'สินค้าทั้งหมด (ไม่รวมที่ลบ)' }) total!: number;
  @ApiProperty() active!: number;
  @ApiProperty() inactive!: number;
  @ApiProperty({ description: 'สินค้าทั่วไป (ไม่มีประเภทพิเศษ)' }) general!: number;
  @ApiProperty({
    description: 'สินค้าประเภทพิเศษ (เปราะบาง/อันตราย/ควบคุมอุณหภูมิ อย่างน้อยหนึ่งอย่าง)',
  })
  special!: number;
  @ApiProperty({ description: 'จำนวนหน่วยหลักที่สินค้าใช้ (ไม่ซ้ำ)' }) unitsUsed!: number;
}
