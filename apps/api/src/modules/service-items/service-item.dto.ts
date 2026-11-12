import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  SERVICE_ITEM_VAT_TYPES,
  SERVICE_ITEM_WHT_RATES,
  type ServiceItemVatType,
  type ServiceItemWhtRate,
} from '@tms/domain';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  CleanText,
  IsNullable,
  IsOptionalNotNull,
  MasterListQuery,
  NormalizeCode,
} from '../master/master-kit';

export { SERVICE_ITEM_VAT_TYPES, SERVICE_ITEM_WHT_RATES };
export type { ServiceItemVatType, ServiceItemWhtRate };

/**
 * หน่วยคิด — ตัวเลือกตามต้นแบบ TMS v4 cfAx (ต่อเที่ยว/ต่อชั่วโมง/ต่อคืน/ต่อจุด/% ของค่าขนส่ง/ตามจริง)
 * spec/02 §6 มี per_km/per_ton/per_unit เพิ่ม — ยังไม่เปิด (ต้นแบบไม่มี) [OPEN spec/12 §3]
 */
export const CALC_UNITS = [
  'PER_TRIP',
  'PER_HOUR',
  'PER_NIGHT',
  'PER_STOP',
  'PERCENT_OF_FREIGHT',
  'ACTUAL',
] as const;
export type CalcUnit = (typeof CALC_UNITS)[number];
/** ข้อความหน่วยบนเอกสาร (`unit_label` — docs/01 §3.2) ระบบเติมตามหน่วยคิด */
export const CALC_UNIT_LABEL: Record<CalcUnit, string> = {
  PER_TRIP: 'เที่ยว',
  PER_HOUR: 'ชั่วโมง',
  PER_NIGHT: 'คืน',
  PER_STOP: 'จุด',
  PERCENT_OF_FREIGHT: '%',
  ACTUAL: 'ตามจริง',
};

export const SERVICE_ITEM_SIDES = ['SELL', 'BUY', 'BOTH'] as const;
export type ServiceItemSide = (typeof SERVICE_ITEM_SIDES)[number];

const CODE_RE = /^[A-Z0-9][A-Z0-9_\-./]{0,19}$/;
const EXT_RE = /^[\x21-\x7e]{1,100}$/;
/** เงิน numeric(14,2) เป็นสตริง (ไม่ใช้ float — CLAUDE.md) */
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;

/** ฟิลด์ที่แก้ได้ (create / PATCH / PUT external) — ช่องบังคับประกาศใน DTO ของแต่ละแบบ */
export class ServiceItemFieldsDto {
  @ApiPropertyOptional({
    example: '500.00',
    nullable: true,
    type: String,
    description:
      'ราคาตั้งต้น (บาท ก่อน VAT) — PERCENT_OF_FREIGHT = เปอร์เซ็นต์ (≤ 100) · ACTUAL ต้องเป็น null (ตามใบเสร็จ) · null = ไม่มีราคาตั้งต้น (ใช้ rate card)',
  })
  @IsNullable()
  @Matches(MONEY_RE, { message: 'defaultPrice must be a decimal string ≥ 0 with ≤ 2 decimals' })
  defaultPrice?: string | null;

  @ApiPropertyOptional({
    example: '31.50',
    nullable: true,
    type: String,
    description: 'ราคาน้ำมันอ้างอิง (฿/ลิตร) — ใช้กับ PERCENT_OF_FREIGHT เท่านั้น',
  })
  @IsNullable()
  @Matches(MONEY_RE, { message: 'fuelRefPrice must be a decimal string with ≤ 2 decimals' })
  fuelRefPrice?: string | null;

  @ApiPropertyOptional({ example: 'ฟรี 2 ชม. แรก', nullable: true, type: String })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(200)
  condition?: string | null;

  @ApiPropertyOptional({
    enum: SERVICE_ITEM_SIDES,
    description:
      'ใช้กับ: SELL = ฝั่งขาย (ลูกค้า), BUY = ฝั่งซื้อ (รถร่วม), BOTH = ทั้งสองฝั่ง (ค่าเริ่มต้น)',
  })
  @IsOptionalNotNull()
  @IsIn(SERVICE_ITEM_SIDES)
  side?: ServiceItemSide;

  @ApiPropertyOptional({
    description:
      'เป็นค่าใช้จ่ายเพิ่ม (ค่ารอ ทางด่วน ยกของ) — false = ค่าขนส่งหลัก (ค่าเริ่มต้น true)',
  })
  @IsOptionalNotNull()
  @IsBoolean()
  isSurcharge?: boolean;

  @ApiPropertyOptional({ example: 'en name', nullable: true, type: String })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(100)
  nameEn?: string | null;

  @ApiPropertyOptional({
    example: '4110-01',
    nullable: true,
    type: String,
    description: 'รหัสบัญชีรายได้/ค่าใช้จ่ายตั้งต้น (ไม่บังคับ — mapping ERP อยู่ที่ connector)',
  })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(40)
  defaultAccountCode?: string | null;
}

class RequiredServiceItemFields extends ServiceItemFieldsDto {
  @ApiProperty({
    example: 'ค่ารอ',
    description: 'ชื่อรายการ (พิมพ์บนเอกสาร) — ห้ามซ้ำ (ไม่สนตัวพิมพ์)',
  })
  @CleanText()
  @IsString()
  @MaxLength(100)
  // class-validator รายงานจากตัวล่างขึ้นบน → ชื่อว่าง/หายได้ "isNotEmpty" เป็นข้อแรก (QA ST2-T11)
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    enum: CALC_UNITS,
    description:
      'หน่วยคิด: PER_TRIP ต่อเที่ยว, PER_HOUR ต่อชั่วโมง, PER_NIGHT ต่อคืน, PER_STOP ต่อจุด, PERCENT_OF_FREIGHT % ของค่าขนส่ง, ACTUAL ตามจริง (ตามใบเสร็จ)',
  })
  @IsIn(CALC_UNITS)
  calcUnit!: CalcUnit;

  @ApiProperty({
    enum: SERVICE_ITEM_VAT_TYPES,
    description:
      'VAT ตั้งต้นของบรรทัด: EXEMPT_TRANSPORT = ยกเว้น (ค่าขนส่ง ม.81(1)(ณ)), VAT_7 = 7%, ZERO_RATED = 0% — snapshot ลงบรรทัดเอกสาร',
  })
  @IsIn(SERVICE_ITEM_VAT_TYPES)
  vatType!: ServiceItemVatType;

  @ApiProperty({
    enum: SERVICE_ITEM_WHT_RATES,
    description:
      'หัก ณ ที่จ่าย (%) ตั้งต้นของบรรทัด: 1.00 ค่าขนส่ง, 3.00 ค่าบริการ, 0.00 ไม่หัก — คู่ EXEMPT_TRANSPORT+3.00 และ VAT_7+1.00 บันทึกได้แต่ได้คำเตือน `vat_wht_unusual` ใน `warnings`',
  })
  @IsIn(SERVICE_ITEM_WHT_RATES)
  whtRate!: ServiceItemWhtRate;
}

export class CreateServiceItemDto extends RequiredServiceItemFields {
  @ApiPropertyOptional({
    example: 'WAIT',
    description: 'รหัส — ไม่ส่ง = ระบบออกเลขถัดไป `AX-0001` (MD-002)',
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

/** `PUT /service-items/external/{externalId}` — ข้อมูลเต็ม (ฟิลด์ที่ไม่ส่งตอนอัปเดต = คงเดิม) */
export class UpsertServiceItemDto extends RequiredServiceItemFields {
  @ApiPropertyOptional({ example: 'WAIT', description: 'ใช้ตอนสร้างเท่านั้น' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;
}

export class UpdateServiceItemDto extends ServiceItemFieldsDto {
  @ApiPropertyOptional({
    example: 'WAIT',
    description: 'รหัสสงวนของระบบ (FREIGHT/EXTRA_STOP/FSC) แก้ไม่ได้',
  })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;

  @ApiPropertyOptional({ example: 'ค่ารอ' })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @MaxLength(100)
  // class-validator รายงานจากตัวล่างขึ้นบน → ชื่อว่าง/หายได้ "isNotEmpty" เป็นข้อแรก (QA ST2-T11)
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ enum: CALC_UNITS })
  @IsOptionalNotNull()
  @IsIn(CALC_UNITS)
  calcUnit?: CalcUnit;

  @ApiPropertyOptional({ enum: SERVICE_ITEM_VAT_TYPES })
  @IsOptionalNotNull()
  @IsIn(SERVICE_ITEM_VAT_TYPES)
  vatType?: ServiceItemVatType;

  @ApiPropertyOptional({ enum: SERVICE_ITEM_WHT_RATES })
  @IsOptionalNotNull()
  @IsIn(SERVICE_ITEM_WHT_RATES)
  whtRate?: ServiceItemWhtRate;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'null = ลบการผูก' })
  @IsNullable()
  @Matches(EXT_RE)
  externalId?: string | null;
}

export class ServiceItemListQuery extends MasterListQuery {
  @ApiPropertyOptional({ description: 'ชื่อ/เงื่อนไขมีคำนี้' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ enum: CALC_UNITS })
  @IsOptional()
  @IsIn(CALC_UNITS)
  calcUnit?: CalcUnit;

  @ApiPropertyOptional({ enum: SERVICE_ITEM_VAT_TYPES })
  @IsOptional()
  @IsIn(SERVICE_ITEM_VAT_TYPES)
  vatType?: ServiceItemVatType;

  @ApiPropertyOptional({
    enum: SERVICE_ITEM_SIDES,
    description: 'ใช้ได้กับฝั่งนี้ (SELL = SELL+BOTH, BUY = BUY+BOTH, BOTH = เฉพาะทั้งสองฝั่ง)',
  })
  @IsOptional()
  @IsIn(SERVICE_ITEM_SIDES)
  side?: ServiceItemSide;
}

export class ServiceItemExportQuery extends ServiceItemListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง' })
  @IsOptional()
  @Matches(/^svc_[0-9a-f]{32}(,svc_[0-9a-f]{32}){0,199}$/)
  ids?: string;
}

export class ServiceItemUsageDto {
  @ApiProperty({ description: 'rate card ที่อ้างรายการนี้' }) rateCards!: number;
  @ApiProperty({ description: 'ค่าใช้จ่ายหน้างานใน DO ที่ snapshot จากรายการนี้' })
  doSurcharges!: number;
}

export class ServiceItemDto {
  @ApiProperty({ example: 'svc_3f2a…' }) id!: string;
  @ApiProperty({ example: 'WAIT' }) code!: string;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ example: 'ค่ารอ' }) name!: string;
  @ApiProperty({ nullable: true, type: String }) nameEn!: string | null;
  @ApiProperty({ enum: CALC_UNITS }) calcUnit!: CalcUnit;
  @ApiProperty({ example: 'ชั่วโมง', description: 'ข้อความหน่วยบนเอกสาร' }) unitLabel!: string;
  @ApiProperty({ nullable: true, type: String, example: '200.00' }) defaultPrice!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '31.50' }) fuelRefPrice!: string | null;
  @ApiProperty({ nullable: true, type: String }) condition!: string | null;
  @ApiProperty({ enum: SERVICE_ITEM_VAT_TYPES }) vatType!: ServiceItemVatType;
  @ApiProperty({ enum: SERVICE_ITEM_WHT_RATES }) whtRate!: ServiceItemWhtRate;
  @ApiProperty({ enum: SERVICE_ITEM_SIDES }) side!: ServiceItemSide;
  @ApiProperty() isSurcharge!: boolean;
  @ApiProperty({ nullable: true, type: String }) defaultAccountCode!: string | null;
  @ApiProperty({ description: 'แถวค่าเริ่มต้นที่ระบบสร้างให้' }) system!: boolean;
  @ApiProperty({
    description: 'รหัสสงวนของระบบ (FREIGHT/EXTRA_STOP/FSC — MD-158): ปิดใช้/ลบ/เปลี่ยนรหัสไม่ได้',
  })
  reserved!: boolean;
  @ApiProperty({ type: ServiceItemUsageDto }) usage!: ServiceItemUsageDto;
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

export class ServiceItemWarningDto {
  @ApiProperty({ enum: ['vat_wht_unusual'] }) code!: 'vat_wht_unusual';
  @ApiProperty({
    enum: ['transport_wht_3', 'service_wht_1'],
    description:
      'transport_wht_3 = ยกเว้น VAT (ค่าขนส่ง) แต่หัก 3%; service_wht_1 = VAT 7% แต่หัก 1% (ถูกได้เมื่อจ่ายผ่าน e-WHT)',
  })
  reason!: 'transport_wht_3' | 'service_wht_1';
  @ApiProperty() message!: string;
}

/** ผลของ POST/PATCH/PUT — `warnings` = คำเตือนที่ไม่บล็อก (บันทึกแล้ว) เช่นคู่ VAT × หัก ณ ที่จ่ายไม่ปกติ */
export class ServiceItemWriteResultDto extends ServiceItemDto {
  @ApiProperty({ type: [ServiceItemWarningDto] }) warnings!: ServiceItemWarningDto[];
}

export class ServiceItemPageDto {
  @ApiProperty({ type: [ServiceItemDto] }) data!: ServiceItemDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class ServiceItemSummaryDto {
  @ApiProperty({ description: 'รายการทั้งหมด (ไม่รวมที่ลบ)' }) total!: number;
  @ApiProperty() active!: number;
  @ApiProperty() inactive!: number;
  @ApiProperty({ description: 'VAT 7%' }) vat7!: number;
  @ApiProperty({ description: 'ยกเว้น VAT' }) exempt!: number;
  @ApiProperty({ description: 'VAT 0%' }) zeroRated!: number;
}
