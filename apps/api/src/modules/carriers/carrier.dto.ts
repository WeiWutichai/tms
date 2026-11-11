import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
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
  ValidateNested,
} from 'class-validator';
import { IsThaiTaxId } from '../../common/thai-tax-id';
import { CustomerAddressDto } from '../customers/customer.dto';
import {
  CleanText,
  IsNullable,
  IsOptionalNotNull,
  MasterListQuery,
  NormalizeCode,
} from '../master/master-kit';

/** บุคคลธรรมดา (ภ.ง.ด.3 — เลขบัตรประชาชน) / นิติบุคคล (ภ.ง.ด.53) — docs/01 §3.2 */
export const CARRIER_ENTITY_TYPES = ['INDIVIDUAL', 'JURISTIC'] as const;
export type CarrierEntityType = (typeof CARRIER_ENTITY_TYPES)[number];

/** อัตราหัก ณ ที่จ่ายตั้งต้น: 1% ค่าขนส่ง (ท.ป.4/2528 ข้อ 12/4) / 3% ค่าบริการ — ต้นแบบมี 2 ตัวเลือก; ค่าจริงอยู่ที่บรรทัด */
export const CARRIER_WHT_RATES = ['1.00', '3.00'] as const;
export type CarrierWhtRate = (typeof CARRIER_WHT_RATES)[number];

/**
 * ธนาคารที่รับโอน (รหัสสั้น) — ชื่อไทยอยู่ใน i18n ของเว็บ (`car.bank.<code>`)
 * รายการคงที่ของระบบ: เพิ่มธนาคาร = เพิ่มที่นี่ + i18n (ไม่มี CHECK ใน DB)
 */
export const BANK_CODES = [
  'KBANK',
  'SCB',
  'BBL',
  'KTB',
  'BAY',
  'TTB',
  'GSB',
  'BAAC',
  'GHB',
  'KKP',
  'CIMBT',
  'UOBT',
  'TISCO',
  'LHFG',
  'ICBCT',
  'TCRB',
  'IBANK',
] as const;
export type BankCode = (typeof BANK_CODES)[number];

/** ข้อมูลที่ถอดรหัสดูได้ (`POST /{id}/reveal`) */
export const REVEAL_FIELDS = ['taxId', 'bankAccountNo'] as const;
export type RevealField = (typeof REVEAL_FIELDS)[number];

const CODE_RE = /^[A-Z0-9][A-Z0-9_\-./]{0,19}$/;
const EXT_RE = /^[\x21-\x7e]{1,100}$/;
/** เลขบัญชี: ตัวเลข 10–15 หลัก (รับขีด/ช่องว่างคั่นได้ — ตัดออกก่อนตรวจ) */
const ACCOUNT_RE = /^\d{10,15}$/;
const digitsOnly = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s-]/g, '') : value,
  );

export class CarrierAddressDto extends CustomerAddressDto {}

/** บัญชีรับเงิน — เลขบัญชีเก็บแบบเข้ารหัส (FieldCipher) ส่งเข้าได้อย่างเดียว ไม่มีใน response */
export class CarrierBankAccountInputDto {
  @ApiProperty({ enum: BANK_CODES, example: 'KBANK', description: 'รหัสธนาคาร' })
  @IsIn(BANK_CODES)
  bankCode!: BankCode;

  @ApiPropertyOptional({
    example: '1234567891',
    description:
      'เลขบัญชี 10–15 หลัก (ขีด/ช่องว่างตัดให้) — ตอนแก้ไม่ส่ง = คงเลขเดิม (ต้องมีบัญชีอยู่แล้ว)',
  })
  @IsOptionalNotNull()
  @digitsOnly()
  @Matches(ACCOUNT_RE, { message: 'accountNo must be 10-15 digits' })
  accountNo?: string;

  @ApiProperty({ example: 'หจก. ทรัพย์สมบูรณ์ขนส่ง', description: 'ชื่อบัญชี' })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  accountName!: string;
}

/** ฟิลด์ที่แก้ได้ (create / PATCH / PUT external) — ช่องบังคับประกาศใน DTO ของแต่ละแบบ */
export class CarrierFieldsDto {
  @ApiPropertyOptional({
    example: '00000',
    nullable: true,
    type: String,
    description: 'รหัสสาขา 5 หลัก — นิติบุคคลไม่ส่ง = 00000 (สำนักงานใหญ่); บุคคลธรรมดาไม่มีสาขา',
  })
  @IsNullable()
  @Matches(/^\d{5}$/)
  branchCode?: string | null;

  @ApiPropertyOptional({
    type: CarrierAddressDto,
    nullable: true,
    description: 'ที่อยู่ (พิมพ์บน 50 ทวิ)',
  })
  @IsNullable()
  @ValidateNested()
  @Type(() => CarrierAddressDto)
  address?: CarrierAddressDto | null;

  @ApiPropertyOptional({
    enum: CARRIER_WHT_RATES,
    description:
      'อัตราหัก ณ ที่จ่ายตั้งต้น (ค่าเริ่มต้น 1.00 = ค่าขนส่ง) — ค่าจริงอยู่ที่บรรทัด settlement',
  })
  @IsOptionalNotNull()
  @IsIn(CARRIER_WHT_RATES)
  whtRate?: CarrierWhtRate;

  @ApiPropertyOptional({
    type: CarrierBankAccountInputDto,
    nullable: true,
    description: 'บัญชีรับเงิน — null = ลบบัญชี',
  })
  @IsNullable()
  @ValidateNested()
  @Type(() => CarrierBankAccountInputDto)
  bankAccount?: CarrierBankAccountInputDto | null;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 365,
    description: 'เงื่อนไขจ่าย (วัน) — ค่าเริ่มต้น 30',
  })
  @IsOptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermDays?: number;

  @ApiPropertyOptional({ description: 'ไม่มี POD ไม่จ่าย (ค่าเริ่มต้น true)' })
  @IsOptionalNotNull()
  @IsBoolean()
  requirePodToPay?: boolean;

  @ApiPropertyOptional({ example: '081-234-5678', nullable: true, type: String })
  @IsNullable()
  @CleanText()
  @Matches(/^\+?[0-9][0-9 \-]{5,24}$/)
  phone?: string | null;

  @ApiPropertyOptional({
    example: '@sapsomboon',
    nullable: true,
    type: String,
    description: 'LINE ID สำหรับส่งใบสั่งงาน',
  })
  @IsNullable()
  @CleanText()
  @Matches(/^@?[A-Za-z0-9._-]{1,50}$/)
  lineContact?: string | null;

  @ApiPropertyOptional({
    example: 'car_…',
    nullable: true,
    type: String,
    description: 'สังกัด (parent carrier) — ต้องอยู่ใน tenant เดียวกัน ห้ามวน',
  })
  @IsNullable()
  @IsString()
  parentCarrierId?: string | null;

  @ApiPropertyOptional({
    example: 'cmp_…',
    nullable: true,
    type: String,
    description: 'จ้างในนาม (Tender As — docs/04 A4) — null = ใช้ค่าเริ่มต้นขององค์กร',
  })
  @IsNullable()
  @IsString()
  billingCompanyId?: string | null;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 999,
    nullable: true,
    type: Number,
    description: 'เพดานเที่ยว/วัน — null = ไม่จำกัด',
  })
  @IsNullable()
  @IsInt()
  @Min(1)
  @Max(999)
  maxTripsPerDay?: number | null;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 999,
    nullable: true,
    type: Number,
    description: 'ลำดับใน cascade (1 = เสนองานก่อน) — null = ไม่จัดลำดับ',
  })
  @IsNullable()
  @IsInt()
  @Min(1)
  @Max(999)
  priority?: number | null;
}

class RequiredCarrierFields extends CarrierFieldsDto {
  @ApiProperty({
    example: 'หจก. ทรัพย์สมบูรณ์ขนส่ง',
    description: 'ชื่อผู้รับเหมา (ตามบัตร/จดทะเบียน)',
  })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName!: string;

  @ApiProperty({
    enum: CARRIER_ENTITY_TYPES,
    description: 'INDIVIDUAL = บุคคลธรรมดา (ภ.ง.ด.3), JURISTIC = นิติบุคคล (ภ.ง.ด.53)',
  })
  @IsIn(CARRIER_ENTITY_TYPES)
  entityType!: CarrierEntityType;

  @ApiProperty({
    example: '0103556012345',
    description:
      'เลขผู้เสียภาษี 13 หลัก (ตรวจ check digit — ผิด → 422) · บุคคลธรรมดา = เลขบัตรประชาชน (เก็บแบบเข้ารหัส ไม่คืนใน response)',
  })
  @digitsOnly()
  @IsThaiTaxId()
  taxId!: string;
}

export class CreateCarrierDto extends RequiredCarrierFields {
  @ApiPropertyOptional({
    example: 'SUB-0001',
    description: 'รหัส — ไม่ส่ง = ระบบออกเลขถัดไป (MD-002)',
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

/** `PUT /carriers/external/{externalId}` — ข้อมูลเต็ม (ฟิลด์ที่ไม่ส่งตอนอัปเดต = คงเดิม) */
export class UpsertCarrierDto extends RequiredCarrierFields {
  @ApiPropertyOptional({ example: 'SUB-0001', description: 'ใช้ตอนสร้างเท่านั้น' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;
}

export class UpdateCarrierDto extends CarrierFieldsDto {
  @ApiPropertyOptional({ example: 'หจก. ทรัพย์สมบูรณ์ขนส่ง' })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName?: string;

  @ApiPropertyOptional({
    enum: CARRIER_ENTITY_TYPES,
    description: 'เปลี่ยนประเภท: เลขเดิมย้ายที่เก็บให้เอง (นิติบุคคล ↔ เข้ารหัส)',
  })
  @IsOptionalNotNull()
  @IsIn(CARRIER_ENTITY_TYPES)
  entityType?: CarrierEntityType;

  @ApiPropertyOptional({ example: '0103556012345', description: 'ไม่ส่ง = คงเลขเดิม' })
  @IsOptionalNotNull()
  @digitsOnly()
  @IsThaiTaxId()
  taxId?: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'null = ลบการผูก' })
  @IsNullable()
  @Matches(EXT_RE)
  externalId?: string | null;
}

export class CarrierListQuery extends MasterListQuery {
  @ApiPropertyOptional({ description: 'ชื่อมีคำนี้' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ enum: CARRIER_ENTITY_TYPES })
  @IsOptional()
  @IsIn(CARRIER_ENTITY_TYPES)
  entityType?: CarrierEntityType;

  @ApiPropertyOptional({ description: 'เฉพาะที่สังกัด carrier นี้ (car_…)' })
  @IsOptional()
  @Matches(/^car_[0-9a-f]{32}$/)
  parentCarrierId?: string;
}

export class CarrierExportQuery extends CarrierListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง' })
  @IsOptional()
  @Matches(/^car_[0-9a-f]{32}(,car_[0-9a-f]{32}){0,199}$/)
  ids?: string;
}

export class RevealCarrierDto {
  @ApiProperty({
    enum: REVEAL_FIELDS,
    description: 'taxId = เลขผู้เสียภาษี/เลขบัตรประชาชนเต็ม · bankAccountNo = เลขบัญชีเต็ม',
  })
  @IsIn(REVEAL_FIELDS)
  field!: RevealField;

  @ApiPropertyOptional({ maxLength: 500, description: 'เหตุผล (ลง audit log)' })
  @IsOptional()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}

export class RevealCarrierResultDto {
  @ApiProperty({ enum: REVEAL_FIELDS }) field!: RevealField;
  @ApiProperty({ nullable: true, type: String, description: 'ค่าเต็ม — null = ไม่มีข้อมูล' })
  value!: string | null;
}

export class CarrierBankAccountDto {
  @ApiProperty({ enum: BANK_CODES }) bankCode!: BankCode;
  @ApiProperty({ example: '7891', description: '4 หลักท้ายของเลขบัญชี (แสดง •••• 7891)' })
  last4!: string;
  @ApiProperty() accountName!: string;
}

export class CarrierRefDto {
  @ApiProperty({ example: 'car_…' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() legalName!: string;
}

export class CarrierUsageDto {
  @ApiProperty({ description: 'รถในสังกัด (ไม่นับที่ปลดระวาง)' }) vehicles!: number;
  @ApiProperty({ description: 'คนขับในสังกัด' }) drivers!: number;
  @ApiProperty({ description: 'รถร่วมที่สังกัดรายนี้ (child)' }) children!: number;
}

export class CarrierDto {
  @ApiProperty({ example: 'car_3f2a…' }) id!: string;
  @ApiProperty({ example: 'SUB-0001' }) code!: string;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ example: 'หจก. ทรัพย์สมบูรณ์ขนส่ง' }) legalName!: string;
  @ApiProperty({ enum: CARRIER_ENTITY_TYPES }) entityType!: CarrierEntityType;
  @ApiProperty({
    enum: ['PND3', 'PND53'],
    description: 'แบบยื่นภาษีหัก ณ ที่จ่าย (คำนวณจากประเภท)',
  })
  whtForm!: 'PND3' | 'PND53';
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เลขผู้เสียภาษีเต็ม — เฉพาะนิติบุคคล; บุคคลธรรมดา = null (ดู taxIdLast4)',
  })
  taxId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2345', description: '4 หลักท้าย' })
  taxIdLast4!: string | null;
  @ApiProperty({ nullable: true, type: String }) branchCode!: string | null;
  @ApiProperty({ type: CarrierAddressDto, nullable: true }) address!: CarrierAddressDto | null;
  @ApiProperty({ enum: CARRIER_WHT_RATES }) whtRate!: CarrierWhtRate;
  @ApiProperty({ type: CarrierBankAccountDto, nullable: true })
  bankAccount!: CarrierBankAccountDto | null;
  @ApiProperty() paymentTermDays!: number;
  @ApiProperty() requirePodToPay!: boolean;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  @ApiProperty({ nullable: true, type: String }) lineContact!: string | null;
  @ApiProperty({ type: CarrierRefDto, nullable: true }) parent!: CarrierRefDto | null;
  @ApiProperty({ nullable: true, type: String, description: 'จ้างในนาม (cmp_…)' })
  billingCompanyId!: string | null;
  @ApiProperty({ nullable: true, type: Number }) maxTripsPerDay!: number | null;
  @ApiProperty({ nullable: true, type: Number }) priority!: number | null;
  @ApiProperty({ type: CarrierUsageDto }) usage!: CarrierUsageDto;
  @ApiProperty({ enum: ['active', 'inactive'], description: 'inactive = ระงับชั่วคราว' })
  status!: 'active' | 'inactive';
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

export class CarrierPageDto {
  @ApiProperty({ type: [CarrierDto] }) data!: CarrierDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class CarrierSummaryDto {
  @ApiProperty({ description: 'ผู้รับเหมาทั้งหมด (ไม่รวมที่ลบ)' }) total!: number;
  @ApiProperty() active!: number;
  @ApiProperty({ description: 'ระงับชั่วคราว' }) inactive!: number;
  @ApiProperty() individual!: number;
  @ApiProperty() juristic!: number;
}
