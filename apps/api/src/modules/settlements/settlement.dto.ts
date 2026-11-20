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
import {
  COMPANY_DISPUTE_ACTIONS,
  LINE_STATUSES,
  type CompanyDisputeAction,
  type LineStatus,
} from './settlement-dispute';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** ยอดหักติดลบ (บาท ทศนิยม ≤ 2) — numeric(14,2) */
/** ยอดหักติดลบ ≠ 0 ("-0", "-0.00", "-00.00" ไม่ผ่าน) */
const NEG_MONEY = /^-(?!0+(\.0{1,2})?$)\d{1,12}(\.\d{1,2})?$/;

/** docs/01 §4.5 — SENT_TO_CARRIER (ST6-T05) · DISPUTED (ST6-T06) · PAID (ST6-T09) เพิ่มภายหลัง */
export const SETTLEMENT_STATUSES = [
  'DRAFT',
  'SENT_TO_CARRIER',
  'DISPUTED',
  'APPROVED',
  'CANCELLED',
] as const;
/** คำตอบของรถร่วมต่อบรรทัด (ST6-T05) */
export const CARRIER_REVIEW_RESPONSES = ['ACCEPTED', 'DISPUTED'] as const;
export type CarrierReviewResponse = (typeof CARRIER_REVIEW_RESPONSES)[number];
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export const SETTLEMENT_LINE_TYPES = ['FREIGHT', 'SURCHARGE', 'DEDUCTION'] as const;
/** ชนิดบรรทัดหัก (docs/04 F6: เงินเบิกล่วงหน้า, ค่าน้ำมันที่เราจ่าย, ค่าปรับ, ค่าเสียหาย — ชื่อตาม spec/05 §11.4 sourceType) */
export const DEDUCTION_TYPES = ['CASH_ADVANCE', 'FUEL_PROVIDED', 'FINE', 'DAMAGE'] as const;
export type DeductionType = (typeof DEDUCTION_TYPES)[number];
/** ที่มาของอัตราหัก ณ ที่จ่ายที่ใช้ (ST6-T08) · แบบยื่น ภ.ง.ด. */
export const WHT_RATE_SOURCES = ['LINE', 'CARRIER_DEFAULT'] as const;
export type WhtRateSource = (typeof WHT_RATE_SOURCES)[number];
export const WHT_FORMS = ['PND3', 'PND53'] as const;

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

/** คำตอบล่าสุดของรถร่วมต่อบรรทัดในรอบตรวจปัจจุบัน (ST6-T05) */
export class SettlementLineReviewDto {
  @ApiProperty({
    enum: CARRIER_REVIEW_RESPONSES,
    description: 'ACCEPTED = รถร่วมยอมรับ · DISPUTED = โต้แย้ง (ติดธง — อนุมัติไม่ได้)',
  })
  response!: CarrierReviewResponse;
  @ApiProperty({ nullable: true, type: String, description: 'เหตุผลที่รถร่วมกรอก' })
  reason!: string | null;
  @ApiProperty({
    type: [String],
    example: ['doc_…'],
    description: 'รูปประกอบ — เปิดดูผ่าน GET /v1/documents/{id}',
  })
  photoIds!: string[];
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '5200.00',
    description:
      'ยอดที่รถร่วมเรียก (ST6-T06 — เฉพาะโต้แย้ง ไม่บังคับ; null = ไม่ระบุ) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyClaimedAmount?: string | null;
  @ApiProperty({ description: 'รอบตรวจ (เพิ่มทุกครั้งที่ส่งให้รถร่วมตรวจ)' }) round!: number;
  @ApiProperty({ format: 'date-time' }) respondedAt!: string;
}

/** การตัดสินล่าสุดของบริษัทต่อบรรทัดในรอบตรวจปัจจุบัน (ST6-T06) */
export class SettlementLineCompanyReviewDto {
  @ApiProperty({
    enum: COMPANY_DISPUTE_ACTIONS,
    description:
      'DISPUTED = บริษัท (บัญชี) ติด dispute รายการเอง · RESOLVED = เคลียร์ — ยืนยันยอดเดิมพร้อมเหตุผล',
  })
  action!: CompanyDisputeAction;
  @ApiProperty({ description: 'เหตุผล (RESOLVED: แสดงให้รถร่วมเห็นบนลิงก์ตรวจ)' }) reason!: string;
  @ApiProperty({ description: 'รอบตรวจ' }) round!: number;
  @ApiProperty({ description: 'ผู้บันทึก' }) by!: string;
  @ApiProperty({ format: 'date-time' }) at!: string;
}

/** สรุปการตรวจของรถร่วมในรอบปัจจุบัน (ST6-T05) — นับเฉพาะบรรทัดที่ยังใช้ */
export class SettlementCarrierReviewDto {
  @ApiProperty({ description: 'รอบตรวจปัจจุบัน (0 = ยังไม่เคยส่ง)' }) round!: number;
  @ApiProperty() accepted!: number;
  @ApiProperty({
    description: 'บรรทัดที่รถร่วมโต้แย้ง (> 0 = อนุมัติไม่ได้ — 409 `settlement_disputed`)',
  })
  disputed!: number;
  @ApiProperty({ description: 'บรรทัดที่รถร่วมยังไม่ตอบ' }) pending!: number;
}

/** สรุป dispute ของใบในรอบปัจจุบัน (ST6-T06) — นับเฉพาะบรรทัดที่ยังใช้ */
export class SettlementDisputeSummaryDto {
  @ApiProperty({
    description:
      'รายการโต้แย้งค้าง (`disputed_count` — รถร่วมโต้แย้งหรือบริษัทติด dispute ที่ยังไม่เคลียร์) · > 0 = อนุมัติไม่ได้ (409 `settlement_disputed`)',
  })
  disputed!: number;
  @ApiProperty({ description: 'รายการที่ยอมรับ/เคลียร์แล้ว (APPROVED)' }) approved!: number;
  @ApiProperty({ description: 'รายการที่ยังไม่มีคำตอบ (OPEN)' }) open!: number;
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
    description:
      'อัตราหัก ณ ที่จ่าย (%) ที่คัดลอกจาก trip_cost ตอนจ้าง — null = ไม่มีธง (ราคากรอกเอง) → ใช้ค่าตั้งต้นของรถร่วม (`whtRateApplied`)',
  })
  whtRate!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '1.00',
    description:
      'อัตราหัก ณ ที่จ่าย (%) ที่ใช้คำนวณประมาณการ (ST6-T08) = `whtRate` ของบรรทัด หรือค่าตั้งต้นของรถร่วม (`wht_rate_default`) เมื่อบรรทัดไม่มีธง · null = บรรทัดหัก/บรรทัดที่นำออกแล้ว',
  })
  whtRateApplied!: string | null;
  @ApiProperty({
    nullable: true,
    enum: WHT_RATE_SOURCES,
    description:
      'ที่มาของ `whtRateApplied`: LINE = ธงของบรรทัด · CARRIER_DEFAULT = ค่าตั้งต้นของรถร่วม',
  })
  whtRateSource!: WhtRateSource | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '45.00',
    description:
      'หัก ณ ที่จ่ายประมาณการรายบรรทัด (ค่าแสดงผล — ปัดรายบรรทัด เศษไปบรรทัดสุดท้ายของกลุ่มอัตรา; ผลรวม = `buyWhtAmount` ของใบ) · null = บรรทัดหัก/นำออกแล้ว — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyWhtAmount?: string | null;
  @ApiProperty({ description: 'false = ถูกนำออกจากใบแล้ว (ดู voidReason)' }) active!: boolean;
  @ApiProperty({ nullable: true, type: String }) voidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) voidedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) voidReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({
    nullable: true,
    type: SettlementLineReviewDto,
    description: 'คำตอบล่าสุดของรถร่วมในรอบตรวจปัจจุบัน (ST6-T05) — null = ยังไม่ตอบ/ไม่ได้ส่งตรวจ',
  })
  carrierReview!: SettlementLineReviewDto | null;
  @ApiProperty({
    nullable: true,
    enum: LINE_STATUSES,
    description:
      'สถานะรายการ (ST6-T06; docs/04 F6) ในรอบตรวจปัจจุบัน — OPEN = ยังไม่มีคำตอบ · DISPUTED = โต้แย้งค้าง (บล็อกอนุมัติทั้งใบ) · APPROVED = รถร่วมยอมรับ/บริษัทเคลียร์แล้ว · null = บรรทัดที่นำออกแล้ว',
  })
  status!: LineStatus | null;
  @ApiProperty({
    nullable: true,
    type: SettlementLineCompanyReviewDto,
    description: 'การตัดสินล่าสุดของบริษัทในรอบตรวจปัจจุบัน (ST6-T06) — null = ไม่มี',
  })
  companyReview!: SettlementLineCompanyReviewDto | null;
}

export class SettlementWhtRateDto {
  @ApiProperty({ example: '1.00', description: 'อัตรา (%)' }) whtRate!: string;
  @ApiPropertyOptional({
    example: '15000.00',
    description: 'ฐานก่อนหักของกลุ่มอัตรา — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyBaseAmount?: string;
  @ApiPropertyOptional({
    example: '150.00',
    description:
      'round_half_up(ฐานกลุ่ม × อัตรา) ครั้งเดียวต่อกลุ่ม — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyWhtAmount?: string;
}

/**
 * หัก ณ ที่จ่ายประมาณการ (ST6-T08; D-54/D-58) — 50 ทวิ และการยื่น ภ.ง.ด.3/53 ทำที่ระบบบัญชี (AccountSystem / โปรแกรมบัญชีของ tenant)
 */
export class SettlementWhtEstimateDto {
  @ApiProperty({
    enum: ['NOT_REVIEWED_BY_ACCOUNTANT'],
    description: 'วิธีคำนวณ **ร่าง — ยังไม่ผ่านนักบัญชี** (ยอดประมาณการ; ยอดจริงคำนวณที่ระบบบัญชี)',
  })
  review!: 'NOT_REVIEWED_BY_ACCOUNTANT';
  @ApiProperty({
    enum: WHT_FORMS,
    description:
      'แบบยื่นตามประเภทรถร่วม (snapshot ตอนสร้างใบ): INDIVIDUAL → PND3 (ภ.ง.ด.3) · JURISTIC → PND53 (ภ.ง.ด.53) — ส่งไปกับ AP ร่าง',
  })
  form!: (typeof WHT_FORMS)[number];
  @ApiProperty({
    description:
      'true = ตรึงยอดแล้วตอนอนุมัติ (`buyWhtAmount` และขั้นต่ำไม่เปลี่ยนตามค่าตั้งอีก) · false = คำนวณสดจากบรรทัดที่ยังใช้ + ค่าตั้งปัจจุบัน',
  })
  frozen!: boolean;
  @ApiProperty({
    example: '0.00',
    description:
      'ขั้นต่ำหัก ณ ที่จ่าย (บาท) ที่ใช้ — ค่าตั้ง `tax.whtMinimumAmount` (ค่าเริ่ม 0 = หักทุกยอด) เทียบกับฐานก่อนหักรวมทุกอัตราของใบ',
  })
  minimumAmount!: string;
  @ApiProperty({ description: 'true = ฐานต่ำกว่าขั้นต่ำ → ไม่หัก (ยอด 0)' }) belowMinimum!: boolean;
  @ApiProperty({ type: [SettlementWhtRateDto], description: 'แยกตามอัตรา (ไม่มีกลุ่มอัตรา 0)' })
  byRate!: SettlementWhtRateDto[];
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
      'ยอดสุทธิ = ยอดรวม − รายการหัก (**ก่อนหัก ณ ที่จ่าย** — ใช้เทียบวงเงิน step-up ตอนอนุมัติ) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyNetPayable?: string;
  @ApiPropertyOptional({
    example: '150.00',
    description:
      'หัก ณ ที่จ่าย **ประมาณการ** (ST6-T08) = Σ ต่ออัตรา round_half_up(ฐานก่อนหักของกลุ่ม × อัตรา) — ร่าง ยังไม่ผ่านนักบัญชี · เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyWhtAmount?: string;
  @ApiPropertyOptional({
    example: '10850.00',
    description:
      'ยอดจ่ายรถร่วมหลังหัก ณ ที่จ่าย = ยอดรวม − หัก ณ ที่จ่าย − รายการหัก (ประมาณการ) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyNetAfterWht?: string;
  @ApiProperty({ type: SettlementWhtEstimateDto })
  whtEstimate!: SettlementWhtEstimateDto;
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
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ส่งให้รถร่วมตรวจล่าสุด (ST6-T05) — ผู้ส่งนับเป็นผู้เตรียมใบ (อนุมัติใบนี้ไม่ได้)',
  })
  sentAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) sentBy!: string | null;
  @ApiProperty({ type: SettlementCarrierReviewDto }) carrierReview!: SettlementCarrierReviewDto;
  @ApiProperty({ type: SettlementDisputeSummaryDto }) dispute!: SettlementDisputeSummaryDto;
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
  @ApiPropertyOptional({
    description: 'หัก ณ ที่จ่ายประมาณการ (ST6-T08) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyWhtAmount?: string;
  @ApiPropertyOptional({
    description: 'ยอดจ่ายหลังหัก ณ ที่จ่าย (ประมาณการ) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyNetAfterWht?: string;
  @ApiProperty({ enum: WHT_FORMS, description: 'แบบยื่น ภ.ง.ด.3 (บุคคล) / ภ.ง.ด.53 (นิติบุคคล)' })
  whtForm!: (typeof WHT_FORMS)[number];
  @ApiProperty({ nullable: true, type: String, description: 'เวลาอนุมัติ (ST6-T07)' })
  approvedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ส่งให้รถร่วมตรวจล่าสุด (ST6-T05)' })
  sentAt!: string | null;
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
