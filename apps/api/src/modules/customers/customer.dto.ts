import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsThaiTaxId } from '../../common/thai-tax-id';
import { MasterListQuery } from '../master/master-kit';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const BILLING_CYCLES = ['PER_DO', 'WEEKLY', 'MONTHLY', 'MANUAL'] as const;
export const TAX_INVOICE_MODES = ['ON_PAYMENT', 'ON_ISSUE'] as const;
/** VAT ค่าเริ่มต้นของบรรทัดใหม่ของลูกค้านี้ (D-28: ค่าจริงอยู่ที่บรรทัด) */
export const CUSTOMER_VAT_DEFAULTS = ['EXEMPT_TRANSPORT', 'VAT_7'] as const;
/** อัตราหัก ณ ที่จ่ายที่ลูกค้าคาดว่าจะหักเรา — ค่าขนส่ง 1% (ท.ป.4/2528 ข้อ 12/4) */
export const WHT_EXPECTED_RATES = ['1.00'] as const;

/**
 * ที่อยู่ออกใบกำกับ — `line1` บังคับ (ต้นแบบกรอกเป็นข้อความเดียว), แยกตำบล/อำเภอ/จังหวัด/รหัสไปรษณีย์ได้ (MD-009)
 * [OPEN spec/12 §3] ฟอร์มแยกช่อง + ฐานข้อมูลตำบล ยังไม่มีในต้นแบบ
 */
export class CustomerAddressDto {
  @ApiProperty({ example: '22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  line1!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) line2?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) subdistrict?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) district?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) province?: string;
  @ApiPropertyOptional({ example: '10540' }) @IsOptional() @Matches(/^\d{5}$/) postcode?: string;
}

export class CustomerContactDto {
  @ApiProperty({ example: 'คุณธีรพงษ์' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: '02-317-4133' })
  @IsOptional()
  @Transform(trim)
  @Matches(/^\+?[0-9][0-9 \-]{5,24}$/)
  phone?: string;

  @ApiPropertyOptional({ example: 'ap@example.co.th' })
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string;

  @ApiPropertyOptional({ description: 'ผู้ติดต่อหลัก (ค่าเริ่มต้น false)' })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

/** ฟิลด์ที่แก้ได้ (ใช้ร่วม create / PATCH / PUT external) — `legalName` ประกาศในแต่ละ DTO (บังคับ/ไม่บังคับต่างกัน) */
export class CustomerFieldsDto {
  @ApiPropertyOptional({
    example: '0105536012451',
    nullable: true,
    type: String,
    description: 'เลขผู้เสียภาษี 13 หลัก (ตรวจ check digit — ผิด → 422)',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsThaiTaxId()
  taxId?: string | null;

  @ApiPropertyOptional({ example: '00000', description: 'รหัสสาขา 5 หลัก (00000 = สำนักงานใหญ่)' })
  @IsOptional()
  @Matches(/^\d{5}$/)
  branchCode?: string;

  @ApiPropertyOptional({ type: CustomerAddressDto, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @ValidateNested()
  @Type(() => CustomerAddressDto)
  billingAddress?: CustomerAddressDto | null;

  @ApiPropertyOptional({ type: [CustomerContactDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CustomerContactDto)
  contacts?: CustomerContactDto[];

  @ApiPropertyOptional({ minimum: 0, maximum: 365, description: 'เครดิต (วัน) — ค่าเริ่มต้น 30' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  creditTermDays?: number;

  @ApiPropertyOptional({ enum: BILLING_CYCLES, description: 'ค่าเริ่มต้น MONTHLY' })
  @IsOptional()
  @IsIn(BILLING_CYCLES)
  billingCycle?: (typeof BILLING_CYCLES)[number];

  @ApiPropertyOptional({
    enum: TAX_INVOICE_MODES,
    description: 'ออกใบกำกับภาษีเมื่อรับชำระ (tax point = รับเงิน — ค่าเริ่มต้น) / พร้อมใบแจ้งหนี้',
  })
  @IsOptional()
  @IsIn(TAX_INVOICE_MODES)
  taxInvoiceMode?: (typeof TAX_INVOICE_MODES)[number];

  @ApiPropertyOptional({
    enum: CUSTOMER_VAT_DEFAULTS,
    nullable: true,
    description: 'VAT ค่าเริ่มต้นของบรรทัดใหม่ — ค่าจริงอยู่ที่บรรทัด (D-28)',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(CUSTOMER_VAT_DEFAULTS)
  defaultVatType?: (typeof CUSTOMER_VAT_DEFAULTS)[number] | null;

  @ApiPropertyOptional({
    enum: WHT_EXPECTED_RATES,
    nullable: true,
    description: 'อัตราหัก ณ ที่จ่ายที่ลูกค้าคาดว่าจะหักเรา (null = ไม่หัก) — ใช้ประมาณยอดรับสุทธิ',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(WHT_EXPECTED_RATES)
  whtExpectedRate?: (typeof WHT_EXPECTED_RATES)[number] | null;

  @ApiPropertyOptional({ example: '500000.00', nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^\d{1,12}(\.\d{1,2})?$/)
  creditLimit?: string | null;

  @ApiPropertyOptional({ description: 'ลูกค้าจดทะเบียน VAT (ค่าเริ่มต้น true)' })
  @IsOptional()
  @IsBoolean()
  vatRegistered?: boolean;

  @ApiPropertyOptional({
    description: 'ลูกค้ารับใบกำกับภาษีอิเล็กทรอนิกส์ (e-Tax) ได้ (ค่าเริ่มต้น false)',
  })
  @IsOptional()
  @IsBoolean()
  etaxCapable?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1440,
    nullable: true,
    type: Number,
    description: 'free time ค่ารอ (นาที) — null = ใช้ค่าตั้งองค์กร `billing.freeTimeMinutes`',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1440)
  freeTimeMin?: number | null;

  @ApiPropertyOptional({
    example: 'cmp_…',
    nullable: true,
    type: String,
    description: 'ออกบิลในนาม (Invoice As) — null = ใช้ค่าเริ่มต้นขององค์กร (docs/04 A4)',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  billingCompanyId?: string | null;

  @ApiPropertyOptional({
    example: 'usr_…',
    nullable: true,
    type: String,
    description: 'พนักงานขาย',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  salesOwnerUserId?: string | null;
}

export class CreateCustomerDto extends CustomerFieldsDto {
  @ApiProperty({ example: 'บจก. สยามพลาสติก' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName!: string;

  @ApiPropertyOptional({
    example: 'CUS-0001',
    description: 'รหัสลูกค้า — ไม่ส่ง = ระบบออกเลขถัดไป (MD-002)',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_\-./]{0,19}$/)
  code?: string;

  @ApiPropertyOptional({
    description: 'รหัสในระบบต้นทาง (ERP/ระบบของลูกค้า) — เรียกด้วย ext:{externalId} ได้',
  })
  @IsOptional()
  @Matches(/^[\x21-\x7e]{1,100}$/)
  externalId?: string;
}

export class UpdateCustomerDto extends CustomerFieldsDto {
  @ApiPropertyOptional({
    example: 'บจก. สยามพลาสติก',
    description: 'ชื่อตามจดทะเบียน (พิมพ์บนเอกสารภาษี)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName?: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'null = ลบการผูก' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^[\x21-\x7e]{1,100}$/)
  externalId?: string | null;
}

/** `PUT /customers/external/{externalId}` — ข้อมูลเต็มของลูกค้า (ฟิลด์ที่ไม่ส่งตอนอัปเดต = คงเดิม) */
export class UpsertCustomerDto extends CustomerFieldsDto {
  @ApiProperty({ example: 'บจก. สยามพลาสติก' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName!: string;

  @ApiPropertyOptional({ example: 'CUS-0001', description: 'ใช้ตอนสร้างเท่านั้น' })
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_\-./]{0,19}$/)
  code?: string;
}

export class CustomerListQuery extends MasterListQuery {
  @ApiPropertyOptional({ enum: BILLING_CYCLES })
  @IsOptional()
  @IsIn(BILLING_CYCLES)
  billingCycle?: (typeof BILLING_CYCLES)[number];

  @ApiPropertyOptional({ description: 'รหัสขึ้นต้นด้วย/มีคำนี้' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  code?: string;

  @ApiPropertyOptional({ description: 'ชื่อมีคำนี้' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  name?: string;
}

export class CustomerExportQuery extends CustomerListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง' })
  @IsOptional()
  @Matches(/^cus_[0-9a-f]{32}(,cus_[0-9a-f]{32}){0,199}$/)
  ids?: string;
}

export class CustomerRefDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
}

export class CustomerDto {
  @ApiProperty({ example: 'cus_3f2a…' }) id!: string;
  @ApiProperty({ example: 'CUS-0001' }) code!: string;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty() legalName!: string;
  @ApiProperty({ nullable: true, type: String }) taxId!: string | null;
  @ApiProperty({ nullable: true, type: String }) branchCode!: string | null;
  @ApiProperty({ type: CustomerAddressDto, nullable: true })
  billingAddress!: CustomerAddressDto | null;
  @ApiProperty({ type: [CustomerContactDto] }) contacts!: CustomerContactDto[];
  @ApiProperty() creditTermDays!: number;
  @ApiProperty({ enum: BILLING_CYCLES }) billingCycle!: (typeof BILLING_CYCLES)[number];
  @ApiProperty({ enum: TAX_INVOICE_MODES }) taxInvoiceMode!: (typeof TAX_INVOICE_MODES)[number];
  @ApiProperty({ enum: ['EXEMPT_TRANSPORT', 'VAT_7', 'ZERO_RATED'], nullable: true })
  defaultVatType!: 'EXEMPT_TRANSPORT' | 'VAT_7' | 'ZERO_RATED' | null;
  @ApiProperty({ nullable: true, type: String, example: '1.00' }) whtExpectedRate!: string | null;
  @ApiProperty({ nullable: true, type: String }) creditLimit!: string | null;
  @ApiProperty() vatRegistered!: boolean;
  @ApiProperty() etaxCapable!: boolean;
  @ApiProperty({ nullable: true, type: Number }) freeTimeMin!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'ออกบิลในนาม (cmp_…)' })
  billingCompanyId!: string | null;
  @ApiProperty({ type: CustomerRefDto, nullable: true }) salesOwner!: CustomerRefDto | null;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: 'active' | 'inactive';
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class CustomerPageDto {
  @ApiProperty({ type: [CustomerDto] }) data!: CustomerDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class CustomerSummaryDto {
  @ApiProperty() total!: number;
  @ApiProperty() active!: number;
  @ApiProperty() inactive!: number;
  @ApiProperty({ description: 'ไม่มีเลขผู้เสียภาษี (ออกใบกำกับภาษีเต็มรูปไม่ได้ — MD-021)' })
  noTaxId!: number;
}

export class NextCodeDto {
  @ApiProperty({ example: 'CUS-0010' }) code!: string;
}
