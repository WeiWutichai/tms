import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import { AGING_BUCKETS, type AgingBucket } from '@tms/domain';
import { ListQuery } from '../../common/pagination';
import { PriceField } from '../../common/price-fields';
import { CleanText } from '../master/master-kit';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** เงินบาท ≥ 0 ทศนิยม ≤ 2 — numeric(14,2) */
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

export const PAYMENT_METHODS = ['TRANSFER', 'CHEQUE', 'CASH', 'OFFSET'] as const;
export type PaymentMethodDto = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_STATUSES = ['RECORDED', 'REVERSED'] as const;
export const CHEQUE_STATUSES = ['PENDING', 'CLEARED', 'BOUNCED'] as const;

/** ข้อความเหตุผล 10–500 ตัวอักษร (กลับรายการ/เช็คคืน/ส่วนต่าง ต้องมีเหตุผล + audit — CLAUDE.md) */
const IsReason = () =>
  ValidateBy({
    name: 'reason',
    validator: {
      validate: (v: unknown) => typeof v === 'string' && [...v].length >= 10 && v.length <= 500,
      defaultMessage: () => 'reason must be 10–500 characters',
    },
  });

// ---------- คำขอ ----------

export class PaymentAllocationInputDto {
  @ApiProperty({ example: 'ivc_…', description: 'ใบแจ้งหนี้ที่ออกแล้วของลูกค้ารายเดียวกัน' })
  @IsString()
  @MaxLength(120)
  invoiceId!: string;

  @ApiProperty({
    example: '25000.00',
    description: 'ยอดตัดหนี้ของใบนี้ (รวม WHT ที่ถูกหัก) > 0 และ ≤ ยอดคงค้าง',
  })
  @Matches(MONEY, { message: 'amount must be a baht amount (≤ 2 decimals)' })
  amount!: string;

  @ApiPropertyOptional({
    example: '250.00',
    description:
      'WHT ที่ถูกหักของใบนี้ — ตัดใบเดียว: ไม่ส่ง = `whtAmount` ของการรับชำระ · หลายใบ: ส่งทุกใบ และรวม = `whtAmount`',
  })
  @IsOptional()
  @Matches(MONEY, { message: 'whtAmount must be a baht amount (≤ 2 decimals)' })
  whtAmount?: string;
}

/**
 * บันทึกรับชำระ (spec/05 §4; D-57) — สมการ (BIL-051 แบบไม่มีเงินเกิน): `amountReceived + whtAmount + feeAmount + differenceAmount = Σ allocations.amount`
 */
export class CreatePaymentDto {
  @ApiProperty({
    example: '2026-11-21',
    description:
      'วันที่รับ (เวลาไทย) ≤ วันนี้ และไม่ก่อนวันที่ออกใบแจ้งหนี้ (422 `before_invoice_issue`)',
  })
  @Matches(DATE_RE, { message: 'receivedDate must be YYYY-MM-DD' })
  receivedDate!: string;

  @ApiProperty({
    enum: PAYMENT_METHODS,
    description:
      'โอนเงิน / เช็ค / เงินสด · `OFFSET` (หักกลบลบหนี้) ยังปิด → 422 `method_not_available` (รอเครดิตลูกค้า BIL-058)',
  })
  @IsIn(PAYMENT_METHODS)
  method!: PaymentMethodDto;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'เลขอ้างอิงการโอน / หักกลบ (เช็คใช้ `chequeNo`)',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @ApiPropertyOptional({ maxLength: 30, description: 'เลขที่เช็ค — **บังคับเมื่อ `CHEQUE`**' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(30)
  chequeNo?: string;

  @ApiPropertyOptional({ maxLength: 100, description: 'ธนาคาร (สาขา) — **บังคับเมื่อ `CHEQUE`**' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  chequeBank?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'วันที่หน้าเช็ค — **บังคับเมื่อ `CHEQUE`**',
  })
  @IsOptional()
  @Matches(DATE_RE, { message: 'chequeDate must be YYYY-MM-DD' })
  chequeDate?: string;

  @ApiProperty({ example: '24750.00', description: 'เงินเข้าจริง ≥ 0' })
  @Matches(MONEY, { message: 'amountReceived must be a baht amount (≤ 2 decimals)' })
  amountReceived!: string;

  @ApiPropertyOptional({
    example: '250.00',
    description: 'WHT ที่ลูกค้าหักไว้ (บันทึกยอดอย่างเดียว — รับ/ตรวจ 50 ทวิ ที่ระบบบัญชี D-54)',
  })
  @IsOptional()
  @Matches(MONEY, { message: 'whtAmount must be a baht amount (≤ 2 decimals)' })
  whtAmount?: string;

  @ApiPropertyOptional({ maxLength: 40, description: 'เลขที่หนังสือรับรอง 50 ทวิ ที่ลูกค้าแจ้ง' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(40)
  whtCertificateNo?: string;

  @ApiPropertyOptional({ example: '0.00', description: 'ค่าธรรมเนียมโอนที่ลูกค้าหัก' })
  @IsOptional()
  @Matches(MONEY, { message: 'feeAmount must be a baht amount (≤ 2 decimals)' })
  feeAmount?: string;

  @ApiPropertyOptional({
    example: '0.00',
    description:
      'ส่วนต่างที่ยอมตัดยอด (ลูกค้าจ่ายขาด) — > 0 ต้องมี `differenceReason` · เกินค่าตั้ง `payments.maxDifferenceAmount` (ค่าเริ่ม 10 บาท) ต้องมีสิทธิ์ `payments:reverse` ไม่มี = 403 `payment_difference_over_limit` (BIL-059)',
  })
  @IsOptional()
  @Matches(MONEY, { message: 'differenceAmount must be a baht amount (≤ 2 decimals)' })
  differenceAmount?: string;

  @ApiPropertyOptional({ minLength: 10, maxLength: 500, description: 'เหตุผลของส่วนต่าง' })
  @IsOptional()
  @CleanText()
  @IsReason()
  differenceReason?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiProperty({ type: [PaymentAllocationInputDto], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PaymentAllocationInputDto)
  allocations!: PaymentAllocationInputDto[];
}

export class PaymentReasonDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'บันทึกยอดผิด ลูกค้าโอน 24,500.00' })
  @CleanText()
  @IsReason()
  reason!: string;
}

export class PaymentListQuery extends ListQuery {
  @ApiPropertyOptional({ example: 'ivc_…', description: 'การรับชำระที่ตัดใบแจ้งหนี้นี้' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  invoiceId?: string;

  @ApiPropertyOptional({ example: 'cus_…' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerId?: string;

  @ApiPropertyOptional({ enum: PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  status?: (typeof PAYMENT_STATUSES)[number];
}

// ---------- คำตอบ ----------

export class PaymentCustomerDto {
  @ApiProperty({ example: 'cus_…' }) id!: string;
  @ApiProperty({ example: 'C-0001' }) code!: string;
  @ApiProperty() legalName!: string;
}

export class PaymentAllocationDto {
  @ApiProperty({ example: 'ivc_…' }) invoiceId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'INV-00000-2611-0001' })
  invoiceNo!: string | null;
  @ApiPropertyOptional({ description: 'ยอดตัดหนี้ (รวม WHT) — `prices.sell:read`' })
  @PriceField('sell')
  sellAmount?: string;
  @ApiPropertyOptional({ description: 'WHT ที่ถูกหักของใบนี้ — `prices.sell:read`' })
  @PriceField('sell')
  sellWhtAmount?: string;
}

export class PaymentDto {
  @ApiProperty({ example: 'pay_…' }) id!: string;
  @ApiProperty({ example: 'PAY-2611-0001', description: 'เลขภายใน (ไม่ใช่ใบเสร็จ — D-56)' })
  paymentNo!: string;
  @ApiProperty({ type: PaymentCustomerDto }) customer!: PaymentCustomerDto;
  @ApiProperty({ example: '2026-11-21' }) receivedDate!: string;
  @ApiProperty({ enum: PAYMENT_METHODS }) method!: PaymentMethodDto;
  @ApiProperty({ nullable: true, type: String }) reference!: string | null;
  @ApiProperty({ nullable: true, type: String }) chequeNo!: string | null;
  @ApiProperty({ nullable: true, type: String }) chequeBank!: string | null;
  @ApiProperty({ nullable: true, type: String }) chequeDate!: string | null;
  @ApiProperty({
    nullable: true,
    enum: CHEQUE_STATUSES,
    description: 'สถานะเช็ค (รอเคลียร์ / ผ่าน / เช็คคืน) — ไม่ใช่เช็ค = null',
  })
  chequeStatus!: (typeof CHEQUE_STATUSES)[number] | null;
  @ApiPropertyOptional({ description: 'เงินเข้าจริง — `prices.sell:read`' })
  @PriceField('sell')
  sellAmountReceived?: string;
  @ApiPropertyOptional({ description: 'WHT ที่ลูกค้าหัก — `prices.sell:read`' })
  @PriceField('sell')
  sellWhtAmount?: string;
  @ApiPropertyOptional({ description: 'ค่าธรรมเนียมที่ลูกค้าหัก — `prices.sell:read`' })
  @PriceField('sell')
  sellFeeAmount?: string;
  @ApiPropertyOptional({ description: 'ส่วนต่างที่ยอมตัดยอด — `prices.sell:read`' })
  @PriceField('sell')
  sellDifferenceAmount?: string;
  @ApiPropertyOptional({ description: 'ยอดตัดหนี้รวม (= Σ allocations) — `prices.sell:read`' })
  @PriceField('sell')
  sellAppliedTotal?: string;
  @ApiProperty({ nullable: true, type: String }) differenceReason!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'เลขที่ 50 ทวิ ที่ลูกค้าแจ้ง' })
  whtCertificateNo!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ enum: ['MANUAL', 'CONNECTOR'] }) source!: 'MANUAL' | 'CONNECTOR';
  @ApiProperty({
    enum: PAYMENT_STATUSES,
    description: 'RECORDED · REVERSED (กลับรายการแล้ว — ไม่นับเป็นยอดรับ)',
  })
  status!: (typeof PAYMENT_STATUSES)[number];
  @ApiProperty({ type: [PaymentAllocationDto] }) allocations!: PaymentAllocationDto[];
  @ApiProperty({ nullable: true, type: String }) reversedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) reversedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) reverseReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PaymentPageDto {
  @ApiProperty({ type: [PaymentDto] }) data!: PaymentDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

/** KPI หน้า "รับชำระ" (ต้นแบบ kpisPay) — ยอดเงินต้องมี `prices.sell:read` */
export class PaymentSummaryDto {
  @ApiPropertyOptional({ description: 'ยอดค้างรับรวม (ใบที่ออกแล้ว) — `prices.sell:read`' })
  @PriceField('sell')
  sellOutstanding?: string;
  @ApiPropertyOptional({
    description: 'ยอดค้างของใบที่เลยวันครบกำหนด (เวลาไทย) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellOverdueOutstanding?: string;
  @ApiPropertyOptional({
    description:
      'เงินเข้าจริง (`amountReceived`) ของการรับชำระเดือนนี้ — ไม่รวม WHT/ค่าธรรมเนียม/ส่วนต่าง และที่กลับรายการ (เวลาไทย) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellReceivedThisMonth?: string;
  @ApiPropertyOptional({
    description:
      'ST9-T02 เงินเข้าจริงของการรับชำระเดือนก่อน (ทั้งเดือน — นิยามเดียวกับ `sellReceivedThisMonth`) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellReceivedLastMonth?: string;
  @ApiProperty({
    description: 'ST9-T02 จำนวนการรับชำระเดือนนี้ (ไม่รวมที่กลับรายการ — เวลาไทย)',
  })
  receivedThisMonth!: number;
  @ApiProperty({ description: 'ST9-T02 จำนวนการรับชำระเดือนก่อน (ทั้งเดือน)' })
  receivedLastMonth!: number;
  @ApiProperty({ description: 'ใบที่ค้างรับและครบกำหนดภายใน 7 วัน' }) dueSoon!: number;
  @ApiProperty({ description: 'ใบที่ออกแล้วทั้งหมด (ไม่รวมร่าง/ยกเลิก)' }) total!: number;
  @ApiProperty({ description: 'ค้างรับ (ISSUED + PARTIALLY_PAID)' }) open!: number;
  @ApiProperty({
    description:
      'เกินกำหนด — ธง `overdue` ของใบ (job รายวัน 00:05 เวลาไทย + ตอนรับชำระ/กลับรายการ — ST5-T18)',
  })
  overdue!: number;
  @ApiProperty({
    description: 'ชำระบางส่วนที่ไม่เกินกำหนด (ST5-T18 — แท็บต้นแบบ: เกินกำหนดแสดงก่อน)',
  })
  partiallyPaid!: number;
  @ApiProperty() paid!: number;
}

// ---------- อายุลูกหนี้ (ST5-T22) ----------

export class AgingQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50, description: 'ลูกค้าต่อหน้า' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน (เรียงตามชื่อลูกค้า)' })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  cursor?: string;

  @ApiPropertyOptional({
    example: 'cus_…',
    description: 'ลูกค้ารายเดียว — id หรือ `ext:{externalId}`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerId?: string;
}

export class AgingBucketDto {
  @ApiProperty({
    enum: AGING_BUCKETS,
    description:
      '`NOT_DUE` ยังไม่ครบกำหนด (daysPastDue ≤ 0) · `DAYS_1_30` · `DAYS_31_60` · `DAYS_61_90` · `DAYS_OVER_90` (> 90) — daysPastDue = asOf − dueDate',
  })
  bucket!: AgingBucket;
  @ApiProperty({ description: 'จำนวนใบที่ค้างในช่วงนี้' }) count!: number;
  @ApiPropertyOptional({ description: 'ยอดค้าง (total − paid) ในช่วงนี้ — `prices.sell:read`' })
  @PriceField('sell')
  sellOutstanding?: string;
}

export class AgingCustomerRefDto {
  @ApiProperty({ example: 'cus_…' }) id!: string;
  @ApiProperty({ example: 'C-0001' }) code!: string;
  @ApiProperty() legalName!: string;
  @ApiProperty({ nullable: true, type: String }) taxId!: string | null;
  @ApiProperty({ nullable: true, type: String }) branchCode!: string | null;
}

export class AgingCustomerDto {
  @ApiProperty({ type: AgingCustomerRefDto }) customer!: AgingCustomerRefDto;
  @ApiProperty({ description: 'ใบค้างรับของลูกค้า' }) count!: number;
  @ApiPropertyOptional({ description: 'ยอดค้างรวมของลูกค้า = Σ ทุกช่วง — `prices.sell:read`' })
  @PriceField('sell')
  sellOutstanding?: string;
  @ApiProperty({ type: [AgingBucketDto], description: 'ครบ 5 ช่วงเสมอ เรียงตามอายุ' })
  buckets!: AgingBucketDto[];
}

export class AgingReportDto {
  @ApiProperty({ example: '2026-11-09', description: 'วันที่คำนวณ (วันนี้ เวลาไทย Asia/Bangkok)' })
  asOf!: string;
  @ApiProperty({
    enum: ['DUE_DATE'],
    description:
      'นับอายุจากวันครบกำหนด (spec/05 §10, spec/09 §3) — ไม่มีวันครบกำหนด = ยังไม่ครบกำหนด',
  })
  basis!: 'DUE_DATE';
  @ApiProperty({ description: 'ใบค้างรับทั้งหมด (ตามตัวกรองลูกค้า — ไม่ขึ้นกับหน้า)' })
  count!: number;
  @ApiPropertyOptional({
    description:
      'ยอดค้างรวม = Σ ทุกช่วง = `sellOutstanding` ของ `GET /payments/summary` (ใบ ISSUED + PARTIALLY_PAID) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellOutstanding?: string;
  @ApiProperty({ type: [AgingBucketDto], description: 'รวมทุกลูกค้า (ไม่ขึ้นกับหน้า)' })
  buckets!: AgingBucketDto[];
  @ApiProperty({
    type: [AgingCustomerDto],
    description: 'ต่อลูกค้า (เฉพาะที่มียอดค้าง) เรียงตามชื่อ',
  })
  data!: AgingCustomerDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}
