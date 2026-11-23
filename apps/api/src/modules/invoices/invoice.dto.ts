import { MAX_DOS_PER_INVOICE } from './billing-limits';
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
import {
  AGING_BUCKETS,
  INVOICE_LINE_MODES,
  INVOICE_SENT_CHANNELS,
  INVOICE_STATUSES,
  type AgingBucket,
  type InvoiceLineMode,
  type InvoiceSentChannel,
} from '@tms/domain';
import { ListQuery } from '../../common/pagination';
import { PriceField } from '../../common/price-fields';
import { DOCUMENT_SYNC_DOC, ErpDocumentSyncDto } from '../erp/document-sync.dto';
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
export const INVOICE_RECEIVABLE = ['all', 'open', 'overdue', 'due'] as const;

// ---------- คำขอ ----------

/** สร้างร่างใบแจ้งหนี้จาก DO หลายใบของลูกค้าเดียว */
export class CreateInvoiceDto {
  @ApiProperty({ example: 'cus_…', description: 'ลูกค้า — id หรือ `ext:{externalId}`' })
  @IsString()
  @MaxLength(120)
  customerId!: string;

  @IdList(
    MAX_DOS_PER_INVOICE,
    'do_…',
    `ใบส่งของ (≤ ${MAX_DOS_PER_INVOICE} ต่อใบแจ้งหนี้ — PO 22 พ.ย. 2569) ของลูกค้ารายนี้ที่ **ส่งบัญชีแล้ว** และยังผ่านเงื่อนไขคิวพร้อมวางบิลตอนดึง (ตรวจซ้ำทุกครั้ง)`,
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

/** ยกเลิกใบที่ออกแล้ว (ST5-T10 `POST /invoices/{id}/void`) — CANCELLED คงเลข (+ ออกฉบับใหม่แทนอ้างเลขเดิม — spec/05 §7) */
export class VoidInvoiceDto extends InvoiceReasonDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'สร้าง**ร่างฉบับใหม่แทน**ใน transaction เดียวกัน (DO ชุดเดิม + บรรทัดที่เพิ่มเอง · อ้างเลขเดิม `replacesInvoice`) — ' +
      'ร่างใหม่ต้องออกเอกสารตามปกติ (ได้เลขถัดไป ไม่ใช้เลขเดิม)',
  })
  @IsOptional()
  @IsBoolean()
  reissue?: boolean;
}

export class InvoiceDeliveryOrdersDto {
  @IdList(
    MAX_DOS_PER_INVOICE,
    'do_…',
    `ใบส่งของ (≤ ${MAX_DOS_PER_INVOICE}) · ร่างหนึ่งใบถือใบส่งของรวมได้ไม่เกิน ${MAX_DOS_PER_INVOICE} ใบ (เพิ่มแล้วเกิน = 422 \`too_many\`)`,
  )
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
      '`overdue` = ใบที่มีธงเกินกำหนด (`overdue: true` — ST5-T18) · ' +
      '`due` = ครบกำหนดแล้ว (D-81 · D68-94 — docs/04 H "ครบกำหนด"): ค้างรับที่ยังมียอดค้างและ `dueDate` ≤ วันนี้ (เวลาไทย) **รวมใบเกินกำหนด** ' +
      '(การ์ด "ครบกำหนด" ของ Dashboard บิล) — ใช้ร่วมกับ `status` ได้',
  })
  @IsOptional()
  @IsIn(INVOICE_RECEIVABLE)
  receivable?: (typeof INVOICE_RECEIVABLE)[number];

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'ST5-T18 ธงเกินกำหนด — `false` = ไม่รวมใบเกินกำหนด (แท็บ "ออกแล้ว"/"ชำระบางส่วน" ของต้นแบบ: เกินกำหนดแสดงก่อน) · `true` = เฉพาะเกินกำหนด',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  overdue?: 'true' | 'false';

  @ApiPropertyOptional({
    enum: AGING_BUCKETS,
    description:
      'ST5-T22 ช่วงอายุลูกหนี้ (การ์ด "อายุลูกหนี้" ของหน้ารับชำระ) — เฉพาะใบค้างรับที่ยังมียอดค้าง และ `daysPastDue = วันนี้ − dueDate` (เวลาไทย) อยู่ในช่วง · ' +
      'ชุดเดียวกับ `GET /payments/aging`',
  })
  @IsOptional()
  @IsIn(AGING_BUCKETS)
  aging?: AgingBucket;
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
  @ApiProperty({
    description:
      'หยุดนับเพราะใบถูกยกเลิก (ST5-T10) — เป็นบรรทัดของเอกสาร ณ วันยกเลิก (≠ ถอดออกจากร่าง) · บรรทัดบนเอกสาร = `active || releasedWithInvoice`',
  })
  releasedWithInvoice!: boolean;
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
  @ApiProperty({
    description:
      'เกินกำหนด (ST5-T18) — ค้างรับ (ISSUED/PARTIALLY_PAID) และเลยวันครบกำหนด (เวลาไทย) · **ธงแยกจาก `status`** ' +
      '(ใบชำระบางส่วนที่เลยกำหนด = `PARTIALLY_PAID` + `overdue: true`) · ตั้งโดย job รายวัน 00:05 และตอนรับชำระ/กลับรายการ · ชำระครบแล้วหลุดเอง',
  })
  overdue!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-11-21T17:05:00.000Z',
    description: 'เวลาที่ระบบตั้งธงเกินกำหนด — ไม่เกิน = null',
  })
  overdueAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'ส่งลูกค้าแล้วเมื่อ (ST5-T18 — ทำเครื่องหมายเอง / ออกใบวางบิล / อีเมล) — ส่งแล้วยกเลิกใบไม่ได้ (409 `invoice_sent_to_customer`)',
  })
  sentToCustomerAt!: string | null;
  @ApiProperty({
    nullable: true,
    enum: INVOICE_SENT_CHANNELS,
    description:
      'ช่องทางที่ทำให้ "ส่งลูกค้าแล้ว": MANUAL = ทำเครื่องหมายเอง · BILLING_NOTE = ออกใบวางบิล · EMAIL = ส่งอีเมล (ST5-T21)',
  })
  sentToCustomerChannel!: InvoiceSentChannel | null;
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

/** ST5-T10 ใบเดิมที่ใบนี้ออกแทน (ยกเลิกแล้ว) */
export class InvoiceReplacesDto {
  @ApiProperty({ example: 'ivc_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String, example: 'INV-00000-6911-0001' })
  invoiceNo!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2026-11-03' }) issueDate!: string | null;
}

/** ST5-T10 ใบที่ออกแทนใบนี้ (ร่าง = ยังไม่มีเลข) */
export class InvoiceReplacedByDto {
  @ApiProperty({ example: 'ivc_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) invoiceNo!: string | null;
  @ApiProperty({ enum: INVOICE_STATUSES }) status!: InvoiceStatusDto;
}

export class InvoiceDto extends InvoiceSummaryDto {
  @ApiPropertyOptional({ nullable: true, type: ErpDocumentSyncDto, description: DOCUMENT_SYNC_DOC })
  sync?: ErpDocumentSyncDto | null;
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
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เวลายกเลิก (ร่าง/ใบที่ออกแล้ว — ST5-T10) · null = ไม่ถูกยกเลิก',
  })
  cancelledAt!: string | null;
  @ApiProperty({
    type: InvoiceReplacesDto,
    nullable: true,
    description:
      'ใบนี้ออกแทนใบที่ยกเลิก (docs/04 F3 "ฉบับใหม่อ้างเลขเดิม" — ST5-T10) · PDF พิมพ์หมายเหตุอ้างเลข/วันที่เดิม',
  })
  replacesInvoice!: InvoiceReplacesDto | null;
  @ApiProperty({
    type: InvoiceReplacedByDto,
    nullable: true,
    description: 'ใบที่ออกแทนใบนี้ (ใบที่ยกเลิกแล้วออกใหม่ — ล่าสุดที่ยังไม่ยกเลิก)',
  })
  replacedByInvoice!: InvoiceReplacedByDto | null;
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
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'bn_…',
    description:
      'ใบวางบิลที่ใบนี้อยู่ (ร่าง/ออกแล้ว/เก็บเงินแล้ว — ST5-T11; docs/01 §3.4 `billing_note_id`) · null = ไม่อยู่ในใบวางบิล',
  })
  billingNoteId!: string | null;
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
/** ST9-T02 ยอดใบแจ้งหนี้ที่ออกในเดือน (Dashboard บิล — เดือนนี้ vs เดือนก่อน) */
export class InvoiceMonthTotalDto {
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ description: 'จำนวนใบ' }) count!: number;
  @ApiPropertyOptional({ example: '96300.00', description: 'Σ ยอดรวมใบ — `prices.sell:read`' })
  @PriceField('sell')
  sellTotal?: string;
}

export class InvoiceSummaryCountsDto {
  @ApiProperty() total!: number;
  @ApiProperty() draft!: number;
  @ApiProperty({
    description:
      'ISSUED ที่ไม่เกินกำหนด (ST5-T18 — เกินกำหนดนับใน `overdue`) · ST9-T02: ไม่รวม ADJUSTED (นิยามลูกหนี้เดียวกับ `GET /payments/summary` — ADJUSTED นับใน `total` เท่านั้น)',
  })
  issued!: number;
  @ApiProperty({ description: 'PARTIALLY_PAID ที่ไม่เกินกำหนด (ST5-T18)' }) partiallyPaid!: number;
  @ApiProperty() paid!: number;
  @ApiProperty({
    description:
      'เกินกำหนด — ใบที่มีธง `overdue` (ST5-T18 · แท็บของต้นแบบ: ทั้งหมด = ผลรวมทุกแท็บ)',
  })
  overdue!: number;
  @ApiProperty({ description: 'CANCELLED + VOIDED' }) cancelled!: number;
  @ApiProperty({
    example: '2026-11-22',
    description: 'ST9-T02 วันนี้ตามเวลาไทยของ server (ใช้ตัดเกินกำหนด/เดือน)',
  })
  today!: string;
  @ApiPropertyOptional({
    example: '12500.00',
    description: 'ST9-T02 Σ ยอดรวมของร่าง (ประมาณการ — ยังไม่ออกเลข) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellDraftTotal?: string;
  @ApiPropertyOptional({
    example: '48000.00',
    description:
      'ST9-T02 Σ ยอดค้าง (ยอดรวม − ยอดตัดชำระ) ของใบในแท็บ "ออกแล้ว" (ISSUED ที่ไม่เกินกำหนด) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellIssuedOutstanding?: string;
  @ApiPropertyOptional({
    example: '3200.00',
    description: 'ST9-T02 Σ ยอดค้างของใบชำระบางส่วนที่ไม่เกินกำหนด — `prices.sell:read`',
  })
  @PriceField('sell')
  sellPartiallyPaidOutstanding?: string;
  @ApiPropertyOptional({
    example: '12500.00',
    description:
      'ST9-T02 Σ ยอดค้างของใบเกินกำหนด (ชุดเดียวกับ `overdue` และ `GET /payments/summary` `sellOverdueOutstanding`) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellOverdueOutstanding?: string;
  @ApiProperty({
    description:
      'D-81 · D68-94 ครบกำหนด (docs/04 H) — ใบค้างรับที่ยังมียอดค้างและ `dueDate` ≤ วันนี้ (เวลาไทย) **รวมใบเกินกำหนด** ' +
      '(= `overdue` + ใบที่ครบกำหนดวันนี้) · ชุดเดียวกับ `GET /invoices?receivable=due` · ซ้อนกับ `issued`/`partiallyPaid` เฉพาะใบที่ครบวันนี้ (ไม่นับใน `total` ซ้ำ)',
  })
  due!: number;
  @ApiPropertyOptional({
    example: '12821.07',
    description: 'D-81 · D68-94 Σ ยอดค้างของใบครบกำหนด (ชุดเดียวกับ `due`) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellDueOutstanding?: string;
  @ApiProperty({
    type: InvoiceMonthTotalDto,
    description:
      'ST9-T02 ใบที่ออกเลขเดือนนี้ (วันที่ 1 ถึงวันนี้ ตาม `issueDate` เวลาไทย) ไม่รวมร่าง/ยกเลิก',
  })
  issuedThisMonth!: InvoiceMonthTotalDto;
  @ApiProperty({
    type: InvoiceMonthTotalDto,
    description: 'ST9-T02 ใบที่ออกเลขเดือนก่อน (ทั้งเดือน) ไม่รวมร่าง/ยกเลิก',
  })
  issuedLastMonth!: InvoiceMonthTotalDto;
}

/** ฉบับของ PDF ใบที่ออกแล้ว (BIL-195): ต้นฉบับ / สำเนา */
export class InvoicePdfQuery {
  @ApiPropertyOptional({ enum: ['ORIGINAL', 'COPY'], default: 'ORIGINAL' })
  @IsOptional()
  @IsIn(['ORIGINAL', 'COPY'])
  copy?: 'ORIGINAL' | 'COPY';
}

/** ST5-T18 ล้างธง "ส่งลูกค้าแล้ว" (ทำเครื่องหมายผิด) — เหตุผล ≥ 10 ตัวอักษร */
export class UnmarkInvoiceSentDto extends InvoiceReasonDto {}
