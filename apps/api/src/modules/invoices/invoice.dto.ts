import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
} from 'class-validator';
import { INVOICE_LINE_MODES, INVOICE_STATUSES, type InvoiceLineMode } from '@tms/domain';
import { ListQuery } from '../../common/pagination';
import { PriceField } from '../../common/price-fields';
import { CleanText } from '../master/master-kit';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** เงินบาท ≥ 0 ทศนิยม ≤ 2 — numeric(14,2) */
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
/** จำนวน > 0 ทศนิยม ≤ 4 — numeric(18,4) */
const QTY = /^(?!0+(\.0{1,4})?$)\d{1,14}(\.\d{1,4})?$/;

/** ข้อความเหตุผล 10–500 ตัวอักษร (override/ถอดออก/ยกเลิก ต้องมีเหตุผล + audit — CLAUDE.md) */
const IsReason = () =>
  ValidateBy({
    name: 'reason',
    validator: {
      validate: (v: unknown) => typeof v === 'string' && [...v].length >= 10 && v.length <= 500,
      defaultMessage: () => 'reason must be 10–500 characters',
    },
  });

const IdList = (max: number, example: string, description: string) => (t: object, k: string) => {
  ApiProperty({ type: [String], example: [example], description })(t, k);
  IsArray()(t, k);
  ArrayMinSize(1)(t, k);
  ArrayMaxSize(max)(t, k);
  IsString({ each: true })(t, k);
  MaxLength(120, { each: true })(t, k);
};

export type InvoiceStatusDto = (typeof INVOICE_STATUSES)[number];
export const INVOICE_RECEIVABLE = ['all', 'open', 'overdue'] as const;

// ---------- คำขอ ----------

/** สร้างร่างใบแจ้งหนี้จาก DO หลายใบของลูกค้าเดียว */
export class CreateInvoiceDto {
  @ApiProperty({ example: 'cus_…', description: 'ลูกค้า — id หรือ `ext:{externalId}`' })
  @IsString()
  @MaxLength(120)
  customerId!: string;

  @IdList(
    200,
    'do_…',
    'ใบส่งของ (≤ 200) ของลูกค้ารายนี้ที่ **ส่งบัญชีแล้ว** และยังผ่านเงื่อนไขคิวพร้อมวางบิลตอนดึง (ตรวจซ้ำทุกครั้ง)',
  )
  deliveryOrderIds!: string[];

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'งวดตั้งแต่ — ไม่ส่ง = วันที่ DO แรก',
  })
  @IsOptional()
  @Matches(DATE_RE)
  periodFrom?: string;

  @ApiPropertyOptional({
    example: '2026-11-15',
    description: 'งวดถึง — ไม่ส่ง = วันที่ DO สุดท้าย',
  })
  @IsOptional()
  @Matches(DATE_RE)
  periodTo?: string;

  @ApiPropertyOptional({ enum: INVOICE_LINE_MODES, description: 'ไม่ส่ง = SINGLE' })
  @IsOptional()
  @IsIn(INVOICE_LINE_MODES)
  lineMode?: InvoiceLineMode;

  @ApiPropertyOptional({
    description:
      'true = ส่งบัญชี DO ที่ยังไม่ส่งในคำขอเดียวกัน (atomic — ส่งไม่ผ่าน = 409 และไม่มีอะไรเปลี่ยน) · ไม่ส่ง/false = DO ต้องส่งบัญชีแล้ว',
  })
  @IsOptional()
  @IsBoolean()
  releaseDeliveryOrders?: boolean;

  @ApiPropertyOptional({
    maxLength: 60,
    nullable: true,
    type: String,
    description: 'เลข PO ลูกค้า',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(60)
  customerPoNo?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true, type: String })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

/** แก้หัวใบร่าง */
export class UpdateInvoiceDto {
  @ApiPropertyOptional({
    enum: INVOICE_LINE_MODES,
    description: 'รูปบรรทัดบนเอกสาร (Group / Merge / Single)',
  })
  @IsOptional()
  @IsIn(INVOICE_LINE_MODES)
  lineMode?: InvoiceLineMode;

  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @Matches(DATE_RE)
  periodFrom?: string;

  @ApiPropertyOptional({ example: '2026-11-15' })
  @IsOptional()
  @Matches(DATE_RE)
  periodTo?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 365,
    description: 'เครดิต (วัน) — ค่าเริ่มจากลูกค้า แก้ได้ในร่าง',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  creditTermDays?: number;

  @ApiPropertyOptional({ maxLength: 60, nullable: true, type: String })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(60)
  customerPoNo?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true, type: String })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class InvoiceReasonDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'ลูกค้าขอแยกวางบิลงวดหน้า' })
  @CleanText()
  @IsReason()
  reason!: string;
}

export class InvoiceDeliveryOrdersDto {
  @IdList(200, 'do_…', 'ใบส่งของ (≤ 200)')
  deliveryOrderIds!: string[];
}

export class RemoveInvoiceDeliveryOrdersDto extends InvoiceDeliveryOrdersDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'ลูกค้าขอวางบิล DO นี้งวดหน้า' })
  @CleanText()
  @IsReason()
  reason!: string;
}

export class MoveInvoiceDeliveryOrdersDto extends InvoiceDeliveryOrdersDto {
  @ApiProperty({ example: 'ivc_…', description: 'ร่างปลายทาง (ลูกค้า + สาขาผู้ออกเดียวกัน)' })
  @IsString()
  @MaxLength(120)
  targetInvoiceId!: string;
}

/** เพิ่มบรรทัดเอง (ไม่ผูก DO) — ภาษีตามรายการบริการ (snapshot) */
export class AddInvoiceLineDto {
  @ApiProperty({
    example: 'svc_…',
    description: 'รายการบริการ (catalog) — ประเภท VAT/อัตราหักตามรายการ',
  })
  @IsString()
  @MaxLength(120)
  serviceItemId!: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'ไม่ส่ง = ชื่อรายการบริการ' })
  @IsOptional()
  @CleanText()
  @IsString()
  @Matches(/\S/, { message: 'description must not be blank' })
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: '1', description: 'จำนวน > 0 (ทศนิยม ≤ 4)' })
  @Matches(QTY, { message: 'quantity must be > 0 with up to 4 decimals' })
  quantity!: string;

  @ApiProperty({
    example: '500.00',
    description: 'ราคาต่อหน่วย (บาท ก่อน VAT) — ต้องมี `prices.sell:write`',
  })
  @PriceField('sell')
  @Matches(MONEY, { message: 'sellUnitPrice must be money (2 decimals)' })
  sellUnitPrice!: string;

  @ApiProperty({ minLength: 10, maxLength: 500, example: 'ค่ายกขนเพิ่มตามที่ลูกค้าตกลงทางอีเมล' })
  @CleanText()
  @IsReason()
  reason!: string;
}

/** แก้บรรทัดในร่าง — คำอธิบาย / ส่วนลด (ส่วนลดต้องมีเหตุผล) */
export class UpdateInvoiceLineDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @CleanText()
  @IsString()
  @Matches(/\S/, { message: 'description must not be blank' })
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    example: '100.00',
    description:
      'ส่วนลดของบรรทัด (บาท ≥ 0, ≤ ยอดก่อนส่วนลด) — ต้องมี `prices.sell:write` + `reason`',
  })
  @IsOptional()
  @PriceField('sell')
  @Matches(MONEY, { message: 'sellDiscount must be money (2 decimals)' })
  sellDiscount?: string;

  @ApiPropertyOptional({ minLength: 10, maxLength: 500, description: 'บังคับเมื่อเปลี่ยนส่วนลด' })
  @IsOptional()
  @CleanText()
  @IsReason()
  reason?: string;
}

export class InvoiceLineIdsDto {
  @ApiProperty({ type: [String], example: ['ivl_…', 'ivl_…'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  lineIds!: string[];
}

export class InvoiceListQuery extends ListQuery {
  @ApiPropertyOptional({ example: 'cus_…', description: 'ลูกค้า — id หรือ `ext:{externalId}`' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerId?: string;

  @ApiPropertyOptional({ enum: INVOICE_STATUSES })
  @IsOptional()
  @IsIn(INVOICE_STATUSES)
  status?: InvoiceStatusDto;

  @ApiPropertyOptional({
    enum: INVOICE_RECEIVABLE,
    description:
      'หน้า "รับชำระ" (ST5-T13): `all` = ใบที่ออกแล้ว (ไม่รวมร่าง/ยกเลิก) · `open` = ค้างรับ (ISSUED + PARTIALLY_PAID) · ' +
      '`overdue` = ค้างรับและเลยวันครบกำหนด (เวลาไทย) — ใช้ร่วมกับ `status` ได้',
  })
  @IsOptional()
  @IsIn(INVOICE_RECEIVABLE)
  receivable?: (typeof INVOICE_RECEIVABLE)[number];
}

// ---------- คำตอบ ----------

export class InvoiceCustomerDto {
  @ApiProperty({ example: 'cus_…' }) id!: string;
  @ApiProperty({ example: 'C-0001' }) code!: string;
  @ApiProperty() legalName!: string;
  @ApiProperty({ nullable: true, type: String }) taxId!: string | null;
  @ApiProperty({ nullable: true, type: String }) branchCode!: string | null;
}

export class InvoiceLineDto {
  @ApiProperty({ example: 'ivl_…' }) id!: string;
  @ApiProperty() lineNo!: number;
  @ApiProperty({ nullable: true, type: String, example: 'do_…' }) deliveryOrderId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'DO-2611-00012' })
  deliveryOrderNo!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'rvl_…',
    description: 'บรรทัดรายได้ต้นทาง',
  })
  revenueLineId!: string | null;
  @ApiProperty({
    nullable: true,
    enum: ['FREIGHT', 'EXTRA_STOP', 'ACCESSORIAL'],
    description:
      'ชนิดบรรทัดรายได้ต้นทาง (ค่าขนส่ง / ค่าจุดเพิ่ม / บริการประกอบ) — null = บรรทัดเพิ่มเอง',
  })
  kind!: 'FREIGHT' | 'EXTRA_STOP' | 'ACCESSORIAL' | null;
  @ApiProperty({ example: 'svc_…' }) serviceItemId!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ example: '5' }) quantity!: string;
  @ApiProperty({ example: 'ตัน' }) unitLabel!: string;
  @ApiPropertyOptional({ example: '350.00', description: 'ต้องมี `prices.sell:read`' })
  @PriceField('sell')
  sellUnitPrice?: string;
  @ApiPropertyOptional({ example: '0.00', description: 'ส่วนลด — ต้องมี `prices.sell:read`' })
  @PriceField('sell')
  sellDiscount?: string;
  @ApiPropertyOptional({
    example: '1750.00',
    description: 'ยอดหลังหักส่วนลด (ก่อน VAT) — ต้องมี `prices.sell:read`',
  })
  @PriceField('sell')
  sellAmount?: string;
  @ApiPropertyOptional({
    example: '0.00',
    description: 'VAT ประมาณการของบรรทัด (แสดงผล) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellVatAmount?: string;
  @ApiProperty({ enum: ['VAT_7', 'EXEMPT_TRANSPORT', 'ZERO_RATED'] }) vatType!: string;
  @ApiProperty({ example: '1.00', description: 'อัตราหัก ณ ที่จ่าย (%)' }) whtRate!: string;
  @ApiProperty({ nullable: true, type: Number, description: 'กลุ่มที่ผู้ใช้รวมเอง' })
  printGroup!: number | null;
  @ApiProperty({ description: 'บรรทัดที่เพิ่มเอง (ไม่ผูก DO)' }) isUserAdded!: boolean;
  @ApiProperty({ description: 'false = ถอดออกแล้ว (เก็บเป็นประวัติ)' }) active!: boolean;
  @ApiProperty({ nullable: true, type: String }) removeReason!: string | null;
}

/** บรรทัดบนเอกสาร (Group / Merge / Single) — คำนวณจากบรรทัดจริง */
export class InvoicePrintLineDto {
  @ApiProperty() no!: number;
  @ApiProperty({ type: [String] }) lineIds!: string[];
  @ApiProperty() description!: string;
  @ApiProperty({ nullable: true, type: String, description: 'null = หน่วยต่างกัน' })
  quantity!: string | null;
  @ApiProperty({ nullable: true, type: String }) unitLabel!: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, description: '`prices.sell:read`' })
  @PriceField('sell')
  sellUnitPrice?: string | null;
  @ApiPropertyOptional({ description: '`prices.sell:read`' })
  @PriceField('sell')
  sellDiscount?: string;
  @ApiPropertyOptional({ description: '`prices.sell:read`' })
  @PriceField('sell')
  sellAmount?: string;
  @ApiProperty() vatType!: string;
  @ApiProperty() whtRate!: string;
  @ApiProperty({ type: [String] }) deliveryOrderNos!: string[];
  @ApiProperty() manual!: boolean;
}

export class InvoiceDeliveryOrderDto {
  @ApiProperty({ example: 'do_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) doNo!: string | null;
  @ApiProperty({ example: '2026-11-03' }) doDate!: string;
  @ApiProperty({ description: 'ต้นทาง (ชื่อจุดรับ)' }) originSiteName!: string;
  @ApiProperty({ description: 'ปลายทาง (ชื่อจุดส่ง)' }) destSiteName!: string;
  @ApiPropertyOptional({
    description: 'ยอดของ DO ในใบ (บรรทัดที่ยังใช้ หลังส่วนลด) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellAmount?: string;
}

export class InvoiceSummaryDto {
  @ApiProperty({ example: 'ivc_…' }) id!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เลขใบแจ้งหนี้ — **ร่างไม่มีเลข** (ออกตอนออกเอกสาร)',
  })
  invoiceNo!: string | null;
  @ApiProperty({ enum: INVOICE_STATUSES }) status!: InvoiceStatusDto;
  @ApiProperty({ type: InvoiceCustomerDto }) customer!: InvoiceCustomerDto;
  @ApiProperty({ nullable: true, type: String }) periodFrom!: string | null;
  @ApiProperty({ nullable: true, type: String }) periodTo!: string | null;
  @ApiProperty() deliveryOrderCount!: number;
  @ApiProperty({ enum: INVOICE_LINE_MODES }) lineMode!: InvoiceLineMode;
  @ApiPropertyOptional({ description: 'ยอดรวม (รวม VAT ประมาณการ) — `prices.sell:read`' })
  @PriceField('sell')
  sellTotal?: string;
  @ApiPropertyOptional({
    description: 'ยอดรวม − WHT ที่คาดว่าจะถูกหัก (ประมาณการ) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellNetExpected?: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-11-20',
    description: 'วันที่ออก (เวลาไทย) — ร่าง = null',
  })
  issueDate!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-12-20',
    description: 'ครบกำหนดชำระ = วันที่ออก + เครดิต (spec/05 BIL-031) — ร่าง = null',
  })
  dueDate!: string | null;
  @ApiPropertyOptional({
    description:
      'ยอดรับชำระแล้ว (ยอดตัดหนี้รวม WHT ที่ถูกหัก — ไม่นับที่กลับรายการ, ST5-T13) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellPaidAmount?: string;
  @ApiPropertyOptional({
    description: 'คงค้าง = ยอดรวม − รับชำระแล้ว (ร่าง/ยกเลิก = 0.00) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellOutstanding?: string;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/** PDF ต้นฉบับ ณ วันออก (เก็บแบบเขียนครั้งเดียว — BIL-196) */
export class InvoicePdfDto {
  @ApiProperty({ example: 'doc_…' }) documentId!: string;
  @ApiProperty({ example: 'INV-00000-6911-0001.pdf' }) filename!: string;
  @ApiProperty({ description: 'SHA-256 ของไฟล์' }) sha256!: string;
  @ApiProperty() sizeBytes!: number;
}

export class InvoiceDto extends InvoiceSummaryDto {
  @ApiProperty({ example: 'cmp_…' }) issuingCompanyId!: string;
  @ApiProperty({ example: 'brn_…' }) issuingBranchId!: string;
  @ApiProperty() creditTermDays!: number;
  @ApiProperty({ nullable: true, type: String }) customerPoNo!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiPropertyOptional({ description: 'ฐานยกเว้น VAT — `prices.sell:read`' })
  @PriceField('sell')
  sellSubtotalExempt?: string;
  @ApiPropertyOptional({ description: 'ฐาน VAT 7% — `prices.sell:read`' })
  @PriceField('sell')
  sellSubtotalVatable?: string;
  @ApiPropertyOptional({ description: 'ฐาน VAT 0% — `prices.sell:read`' })
  @PriceField('sell')
  sellSubtotalZeroRated?: string;
  @ApiPropertyOptional({ description: 'VAT 7% (ประมาณการ — D-54) — `prices.sell:read`' })
  @PriceField('sell')
  sellVatAmount?: string;
  @ApiPropertyOptional({
    description: 'WHT ที่คาดว่าจะถูกหัก (ประมาณการ — D-54) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellWhtExpected?: string;
  @ApiPropertyOptional({ description: 'ส่วนลดรวม — `prices.sell:read`' })
  @PriceField('sell')
  sellDiscountTotal?: string;
  @ApiProperty({
    description: 'ยอด VAT/WHT เป็นประมาณการ (ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี — D-54) — true เสมอ',
  })
  taxEstimated!: boolean;
  @ApiProperty({ type: [InvoiceDeliveryOrderDto] }) deliveryOrders!: InvoiceDeliveryOrderDto[];
  @ApiProperty({
    type: [InvoiceLineDto],
    description: 'บรรทัดจริง (รวมที่ถอดออกแล้ว `active=false`)',
  })
  lines!: InvoiceLineDto[];
  @ApiProperty({
    type: [InvoicePrintLineDto],
    description: 'บรรทัดบนเอกสารตาม `lineMode` + กลุ่มที่รวมเอง',
  })
  printLines!: InvoicePrintLineDto[];
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เวลาออกเอกสาร (ออกเลข) — ร่าง = null',
  })
  issuedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ผู้ออกเอกสาร' })
  issuedBy!: string | null;
  @ApiProperty({
    type: InvoicePdfDto,
    nullable: true,
    description:
      'PDF ต้นฉบับที่เก็บ ณ วันออก — null = ร่าง หรือยังไม่ได้ render (render หลังออกเลข; `GET /v1/invoices/{id}/pdf` สร้างให้ถ้ายังไม่มี)',
  })
  pdf!: InvoicePdfDto | null;
}

export class InvoicePageDto {
  @ApiProperty({ type: [InvoiceSummaryDto] }) data!: InvoiceSummaryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class InvoiceMoveResultDto {
  @ApiProperty({ type: InvoiceDto, description: 'ร่างต้นทาง (หลังย้าย)' }) source!: InvoiceDto;
  @ApiProperty({ type: InvoiceDto, description: 'ร่างปลายทาง (หลังย้าย)' }) target!: InvoiceDto;
}

/** จำนวนใบแจ้งหนี้ตามสถานะ — แท็บ/KPI ของหน้า "วางบิลและใบแจ้งหนี้" */
export class InvoiceSummaryCountsDto {
  @ApiProperty() total!: number;
  @ApiProperty() draft!: number;
  @ApiProperty({ description: 'ISSUED + ADJUSTED' }) issued!: number;
  @ApiProperty() partiallyPaid!: number;
  @ApiProperty() paid!: number;
  @ApiProperty({
    description: 'เกินกำหนด — คำนวณเมื่อมีการรับชำระ (ST5-T22) ตอนนี้ 0 เสมอ',
  })
  overdue!: number;
  @ApiProperty({ description: 'CANCELLED + VOIDED' }) cancelled!: number;
}

/** ฉบับของ PDF ใบที่ออกแล้ว (BIL-195): ต้นฉบับ / สำเนา */
export class InvoicePdfQuery {
  @ApiPropertyOptional({ enum: ['ORIGINAL', 'COPY'], default: 'ORIGINAL' })
  @IsOptional()
  @IsIn(['ORIGINAL', 'COPY'])
  copy?: 'ORIGINAL' | 'COPY';
}
