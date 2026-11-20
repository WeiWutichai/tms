import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import { ListQuery } from '../../common/pagination';
import { PriceField } from '../../common/price-fields';
import { CleanText } from '../master/master-kit';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** ยอดหักติดลบ (บาท ทศนิยม ≤ 2) — numeric(14,2) */
/** ยอดหักติดลบ ≠ 0 ("-0", "-0.00", "-00.00" ไม่ผ่าน) */
const NEG_MONEY = /^-(?!0+(\.0{1,2})?$)\d{1,12}(\.\d{1,2})?$/;

/** docs/01 §4.5 — SENT_TO_CARRIER / DISPUTED (ST6-T05/T06) และ PAID (ST6-T09) เพิ่มภายหลัง */
export const SETTLEMENT_STATUSES = ['DRAFT', 'APPROVED', 'CANCELLED'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export const SETTLEMENT_LINE_TYPES = ['FREIGHT', 'SURCHARGE', 'DEDUCTION'] as const;
/** ชนิดบรรทัดหัก (docs/04 F6: เงินเบิกล่วงหน้า, ค่าน้ำมันที่เราจ่าย, ค่าปรับ, ค่าเสียหาย — ชื่อตาม spec/05 §11.4 sourceType) */
export const DEDUCTION_TYPES = ['CASH_ADVANCE', 'FUEL_PROVIDED', 'FINE', 'DAMAGE'] as const;
export type DeductionType = (typeof DEDUCTION_TYPES)[number];

/** ข้อความเหตุผล 10–500 ตัวอักษร — error เดียวต่อช่อง */
const IsReason = () =>
  ValidateBy({
    name: 'reason',
    validator: {
      validate: (v: unknown) => typeof v === 'string' && v.length >= 10 && v.length <= 500,
      defaultMessage: () => 'reason must be 10–500 characters',
    },
  });

/** บรรทัดหัก (กรอกมือ) — ยอดติดลบ + เอกสารอ้างอิง (BIL-134) */
export class SettlementDeductionInput {
  @ApiProperty({ enum: DEDUCTION_TYPES, description: 'ชนิดรายการหัก' })
  @IsIn(DEDUCTION_TYPES)
  deductionType!: DeductionType;

  @ApiProperty({ maxLength: 500, example: 'เงินเบิกล่วงหน้าค่าน้ำมัน 12 พ.ย.' })
  @CleanText()
  @IsString()
  @Matches(/\S/, { message: 'description must not be blank' })
  @MaxLength(500)
  description!: string;

  @ApiProperty({
    example: '-2000.00',
    description:
      'ยอดหัก **ติดลบ** (บาท ทศนิยม ≤ 2) — ไม่ใช่ราคาซื้อ (ไม่ต้องมี `prices.buy:write`) · ผู้มี `settlements:create` กรอกได้',
  })
  @Matches(NEG_MONEY, { message: 'amount must be a negative amount with up to 2 decimals' })
  amount!: string;

  @ApiProperty({
    maxLength: 200,
    example: 'ADV-2611-0007',
    description:
      'เอกสารอ้างอิง (เลขใบเบิก / ใบสั่งปรับ / ใบเสร็จน้ำมัน / รายงานความเสียหาย) — บังคับ',
  })
  @CleanText()
  @IsString()
  @Matches(/\S/, { message: 'reference must not be blank' })
  @MaxLength(200)
  reference!: string;

  @ApiPropertyOptional({ example: 'trp_…', description: 'ผูกกับเที่ยว (ไม่บังคับ)' })
  @IsOptional()
  @IsString()
  tripId?: string;
}

/** รายการที่เพิ่มเข้าใบ — เที่ยว (ทุกบรรทัดที่รอจ่าย) และ/หรือ บรรทัดต้นทุนรายบรรทัด และ/หรือ บรรทัดหัก */
export class SettlementItemsInput {
  @ApiPropertyOptional({
    type: [String],
    example: ['trp_…'],
    description:
      'ติ๊กเที่ยว → ทุกบรรทัดต้นทุนที่รอจ่ายของเที่ยว (กฎเดียวกับคิวจ่าย `GET /settlements/queue`)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  tripIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['tco_…'],
    description: 'บรรทัดต้นทุน (`trip_cost`) รายบรรทัด — ต้องเป็นบรรทัดที่รอจ่ายในคิว',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  tripCostIds?: string[];

  @ApiPropertyOptional({ type: [SettlementDeductionInput] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SettlementDeductionInput)
  deductions?: SettlementDeductionInput[];
}

/** ช่องหัวใบที่แก้ได้ในร่าง */
export class SettlementHeaderInput extends SettlementItemsInput {
  @ApiPropertyOptional({ example: '2026-11-01', description: 'งวดตั้งแต่ (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE_RE)
  periodFrom?: string;

  @ApiPropertyOptional({ example: '2026-11-15', description: 'งวดถึง (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE_RE)
  periodTo?: string;

  @ApiPropertyOptional({
    maxLength: 60,
    nullable: true,
    type: String,
    description: 'เลขใบแจ้งหนี้ที่รถร่วมวางมา (ใช้กระทบยอด)',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(60)
  carrierInvoiceNo?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: '2026-11-16' })
  @IsOptional()
  @Matches(DATE_RE)
  carrierInvoiceDate?: string | null;

  @ApiPropertyOptional({
    maxLength: 60,
    nullable: true,
    type: String,
    description: 'เลขใบเสร็จของรถร่วม',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(60)
  carrierReceiptNo?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true, type: String })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

/** สร้างร่างใบสำคัญจ่าย */
export class CreateSettlementDto extends SettlementHeaderInput {
  @ApiProperty({ example: 'car_…', description: 'รถร่วม — id หรือ `ext:{externalId}`' })
  @IsString()
  @MaxLength(120)
  carrierId!: string;
}

/** แก้หัวใบร่าง (ไม่รับรายการ — เพิ่มด้วย `POST /settlements/{id}/lines`) */
export class UpdateSettlementDto {
  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @Matches(DATE_RE)
  periodFrom?: string;

  @ApiPropertyOptional({ example: '2026-11-15' })
  @IsOptional()
  @Matches(DATE_RE)
  periodTo?: string;

  @ApiPropertyOptional({ maxLength: 60, nullable: true, type: String })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(60)
  carrierInvoiceNo?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: '2026-11-16' })
  @IsOptional()
  @Matches(DATE_RE)
  carrierInvoiceDate?: string | null;

  @ApiPropertyOptional({ maxLength: 60, nullable: true, type: String })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(60)
  carrierReceiptNo?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true, type: String })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class SettlementReasonDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า' })
  @CleanText()
  @IsReason()
  reason!: string;
}

export class SettlementListQuery extends ListQuery {
  @ApiPropertyOptional({ example: 'car_…', description: 'รถร่วม — id หรือ `ext:{externalId}`' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  carrierId?: string;

  @ApiPropertyOptional({ enum: SETTLEMENT_STATUSES })
  @IsOptional()
  @IsIn(SETTLEMENT_STATUSES)
  status?: SettlementStatus;
}

export class SettlementCarrierDto {
  @ApiProperty({ example: 'car_…' }) id!: string;
  @ApiProperty({ example: 'SUB-0001' }) code!: string;
  @ApiProperty({ description: 'ชื่อ ณ วันสร้างใบ' }) legalName!: string;
  @ApiProperty({ enum: ['INDIVIDUAL', 'JURISTIC'] }) entityType!: string;
  @ApiProperty({ nullable: true, type: String, description: 'นิติบุคคล = เลขผู้เสียภาษี' })
  taxId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'บุคคลธรรมดา = 4 หลักท้ายเลขบัตร' })
  taxIdLast4!: string | null;
  @ApiProperty({ nullable: true, type: String }) branchCode!: string | null;
}

export class SettlementLineDto {
  @ApiProperty({ example: 'stln_…' }) id!: string;
  @ApiProperty() lineNo!: number;
  @ApiProperty({
    enum: SETTLEMENT_LINE_TYPES,
    description:
      'FREIGHT = ค่าจ้างรถร่วม (CARRIER_FEE) · SURCHARGE = ค่าใช้จ่ายหน้างานฝั่งซื้อ · DEDUCTION = รายการหัก',
  })
  lineType!: string;
  @ApiProperty({ nullable: true, type: String, example: 'tco_…' }) tripCostId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'trp_…' }) tripId!: string | null;
  @ApiProperty({ nullable: true, type: String }) tripNo!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชนิดต้นทุนของ trip_cost' })
  costType!: string | null;
  @ApiProperty({ nullable: true, enum: DEDUCTION_TYPES }) deductionType!: string | null;
  @ApiProperty() description!: string;
  @ApiPropertyOptional({
    example: '4500.00',
    description:
      'ยอดของบรรทัด (ก่อน VAT ก่อนหัก ณ ที่จ่าย · บรรทัดหัก = ติดลบ) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyAmount?: string;
  @ApiProperty({ nullable: true, type: String, description: 'เอกสารอ้างอิงของบรรทัดหัก' })
  reference!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ธงภาษีที่คัดลอกจาก trip_cost' })
  vatType!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '1.00',
    description: 'อัตราหัก ณ ที่จ่ายที่คัดลอกจาก trip_cost (ข้อมูลเท่านั้น — คำนวณ WHT ใน ST6-T08)',
  })
  whtRate!: string | null;
  @ApiProperty({ description: 'false = ถูกนำออกจากใบแล้ว (ดู voidReason)' }) active!: boolean;
  @ApiProperty({ nullable: true, type: String }) voidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) voidedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) voidReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty() createdAt!: string;
}

/** ใบสำคัญจ่ายรถร่วม (ร่าง) */
export class SettlementDto {
  @ApiProperty({ example: 'stl_…' }) id!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เลขเอกสาร (ชุด STL) — ร่างยังไม่มีเลข · ออกตอนอนุมัติ (ST6-T07)',
  })
  settlementNo!: string | null;
  @ApiProperty({ enum: SETTLEMENT_STATUSES }) status!: SettlementStatus;
  @ApiProperty({ type: SettlementCarrierDto }) carrier!: SettlementCarrierDto;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'นิติบุคคลที่จ่าย ("จ้างในนาม" ของรถร่วม — null = ค่าเริ่มต้นองค์กร)',
  })
  payingCompanyId!: string | null;
  @ApiProperty({ example: '2026-11-01' }) periodFrom!: string;
  @ApiProperty({ example: '2026-11-15' }) periodTo!: string;
  @ApiProperty({ nullable: true, type: String }) carrierInvoiceNo!: string | null;
  @ApiProperty({ nullable: true, type: String }) carrierInvoiceDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) carrierReceiptNo!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ description: 'จำนวนเที่ยวในใบ (บรรทัดที่ยังใช้)' }) tripCount!: number;
  @ApiPropertyOptional({
    example: '13500.00',
    description:
      'ยอดรวม = Σ บรรทัดเที่ยวที่ยังใช้ (ก่อน VAT ก่อนหัก ณ ที่จ่าย) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyGrossAmount?: string;
  @ApiPropertyOptional({
    example: '2500.00',
    description: 'รวมรายการหัก (ค่าบวก = Σ |บรรทัดหัก|) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyDeductionAmount?: string;
  @ApiPropertyOptional({
    example: '11000.00',
    description:
      'ยอดสุทธิ = ยอดรวม − รายการหัก (ยังไม่หัก ณ ที่จ่าย — ST6-T08) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyNetPayable?: string;
  @ApiProperty({
    type: [SettlementLineDto],
    description: 'ทุกบรรทัด รวมบรรทัดที่นำออกแล้ว (`active` false)',
  })
  lines!: SettlementLineDto[];
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เวลาอนุมัติ (ST6-T07) — ออกเลข `settlementNo` พร้อมกัน',
  })
  approvedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ผู้อนุมัติ (ไม่ใช่ผู้สร้าง — separation of duties)',
  })
  approvedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/** แถวในรายการ (ไม่มีบรรทัด) */
export class SettlementSummaryDto {
  @ApiProperty({ example: 'stl_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) settlementNo!: string | null;
  @ApiProperty({ enum: SETTLEMENT_STATUSES }) status!: SettlementStatus;
  @ApiProperty({ type: SettlementCarrierDto }) carrier!: SettlementCarrierDto;
  @ApiProperty() periodFrom!: string;
  @ApiProperty() periodTo!: string;
  @ApiProperty({ nullable: true, type: String }) carrierInvoiceNo!: string | null;
  @ApiProperty() tripCount!: number;
  @ApiPropertyOptional({ description: 'เห็นเมื่อมี `prices.buy:read`' })
  @PriceField('buy')
  buyGrossAmount?: string;
  @ApiPropertyOptional({ description: 'เห็นเมื่อมี `prices.buy:read`' })
  @PriceField('buy')
  buyDeductionAmount?: string;
  @ApiPropertyOptional({ description: 'เห็นเมื่อมี `prices.buy:read`' })
  @PriceField('buy')
  buyNetPayable?: string;
  @ApiProperty({ nullable: true, type: String, description: 'เวลาอนุมัติ (ST6-T07)' })
  approvedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class SettlementPageDto {
  @ApiProperty({ type: [SettlementSummaryDto] }) data!: SettlementSummaryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}
