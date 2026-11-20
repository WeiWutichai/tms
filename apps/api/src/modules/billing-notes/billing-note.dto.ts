import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { ListQuery } from '../../common/pagination';
import { PriceField } from '../../common/price-fields';
import { CleanText } from '../master/master-kit';
import { InvoiceCustomerDto, InvoicePdfDto } from '../invoices/invoice.dto';

/** สถานะใบวางบิล (docs/01 §3.4) — "ผู้รับวางบิล" เป็นข้อมูล ไม่ใช่สถานะ (plan/00a §4.4) */
export const BILLING_NOTE_STATUSES = ['DRAFT', 'ISSUED', 'COLLECTED', 'CANCELLED'] as const;
export type BillingNoteStatusDto = (typeof BILLING_NOTE_STATUSES)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** เหตุผล 10–500 ตัวอักษร (ยกเลิกต้องมีเหตุผล + audit — CLAUDE.md) */
const IsReason = () =>
  ValidateBy({
    name: 'reason',
    validator: {
      validate: (v: unknown) => typeof v === 'string' && [...v].length >= 10 && v.length <= 500,
      defaultMessage: () => 'reason must be 10–500 characters',
    },
  });

const InvoiceIds = () => (t: object, k: string) => {
  ApiProperty({
    type: [String],
    example: ['ivc_…'],
    description:
      'ใบแจ้งหนี้ (≤ 200) ของลูกค้ารายนี้ที่**ออกแล้วและยังค้างชำระ** (ISSUED) · ผู้ออก/สาขาผู้ออกเดียวกัน · ไม่อยู่ในใบวางบิลอื่นที่ active',
  })(t, k);
  IsArray()(t, k);
  ArrayMinSize(1)(t, k);
  ArrayMaxSize(200)(t, k);
  IsString({ each: true })(t, k);
  MaxLength(120, { each: true })(t, k);
};

// ---------- คำขอ ----------

export class CreateBillingNoteDto {
  @ApiProperty({ example: 'cus_…', description: 'ลูกค้า — id หรือ `ext:{externalId}`' })
  @IsString()
  @MaxLength(120)
  customerId!: string;

  @InvoiceIds()
  invoiceIds!: string[];

  @ApiPropertyOptional({
    example: '2026-12-05',
    description: 'วันนัดรับเช็ค/โอน (บังคับก่อนออกเอกสาร · ≥ วันวางบิล)',
  })
  @IsOptional()
  @Matches(DATE_RE)
  collectionDate?: string;

  @ApiPropertyOptional({ description: 'หมายเหตุบนเอกสาร (≤ 2,000)' })
  @IsOptional()
  @CleanText()
  @MaxLength(2000)
  note?: string;
}

/** แก้ร่าง — ส่งเฉพาะที่เปลี่ยน · `invoiceIds` = ชุดใหม่ทั้งหมด (ถอดใบที่ไม่อยู่ในชุด) */
export class UpdateBillingNoteDto {
  @ApiPropertyOptional({
    type: [String],
    example: ['ivc_…'],
    description: 'ชุดใบแจ้งหนี้ใหม่ทั้งหมด (≥ 1)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  invoiceIds?: string[];

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '2026-12-05',
    description: 'วันนัดรับเช็ค/โอน · null = ล้าง',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Matches(DATE_RE)
  collectionDate?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'หมายเหตุ · null/"" = ล้าง' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @CleanText()
  @MaxLength(2000)
  note?: string | null;
}

/** บันทึกผู้รับวางบิล (ชื่อฝั่งลูกค้า + วันที่รับ) */
export class AcknowledgeBillingNoteDto {
  @ApiProperty({ example: 'คุณสมศรี (ฝ่ายบัญชี)', description: 'ชื่อผู้รับวางบิลฝั่งลูกค้า' })
  @IsString()
  @CleanText()
  @MinLength(1)
  @MaxLength(200)
  receivedBy!: string;

  @ApiProperty({
    example: '2026-11-21',
    description: 'วันที่ลูกค้ารับวางบิล (≥ วันวางบิล, ≤ วันนี้)',
  })
  @Matches(DATE_RE)
  receivedOn!: string;
}

export class CollectBillingNoteDto {
  @ApiPropertyOptional({ description: 'หมายเหตุการรับเช็ค/โอน (≤ 500) เช่น เลขเช็ค' })
  @IsOptional()
  @CleanText()
  @MaxLength(500)
  note?: string;
}

export class BillingNoteReasonDto {
  @ApiProperty({ example: 'ลูกค้าขอแยกวางบิลตามสาขา', description: 'เหตุผล 10–500 ตัวอักษร' })
  @IsReason()
  reason!: string;
}

export class BillingNoteListQuery extends ListQuery {
  @ApiPropertyOptional({ example: 'cus_…', description: 'ลูกค้า — id หรือ `ext:{externalId}`' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerId?: string;

  @ApiPropertyOptional({ enum: BILLING_NOTE_STATUSES })
  @IsOptional()
  @IsIn(BILLING_NOTE_STATUSES)
  status?: BillingNoteStatusDto;
}

export class BillingNoteCandidatesQuery {
  @ApiProperty({ example: 'cus_…', description: 'ลูกค้า — id หรือ `ext:{externalId}`' })
  @IsString()
  @MaxLength(120)
  customerId!: string;
}

export class BillingNotePdfQuery {
  @ApiPropertyOptional({ enum: ['ORIGINAL', 'COPY'], default: 'ORIGINAL' })
  @IsOptional()
  @IsIn(['ORIGINAL', 'COPY'])
  copy?: 'ORIGINAL' | 'COPY';
}

// ---------- คำตอบ ----------

export class BillingNoteInvoiceDto {
  @ApiProperty({ example: 'ivc_…' }) invoiceId!: string;
  @ApiProperty({ example: 'INV-00000-2611-0013' }) invoiceNo!: string;
  @ApiProperty({ example: '2026-11-03' }) issueDate!: string;
  @ApiProperty({ example: '2026-12-03' }) dueDate!: string;
  @ApiProperty({
    description:
      'ผูกนับกันวางบิลซ้ำอยู่ (ตรงกับฐานข้อมูล) — false เมื่อถอดออกจากร่าง หรือใบวางบิลถูกยกเลิก',
  })
  active!: boolean;
  @ApiProperty({ description: 'true = ถอดออกจากร่างแล้ว (ไม่อยู่ในใบ)' }) removed!: boolean;
  @ApiPropertyOptional({ description: 'ยอดรวมของใบแจ้งหนี้ — `prices.sell:read`' })
  @PriceField('sell')
  sellTotal?: string;
  @ApiPropertyOptional({ description: 'WHT ที่คาดว่าจะถูกหัก (ประมาณการ) — `prices.sell:read`' })
  @PriceField('sell')
  sellWhtExpected?: string;
  @ApiPropertyOptional({ description: 'ยอดค้าง ณ วันใส่/ออก — `prices.sell:read`' })
  @PriceField('sell')
  sellOutstanding?: string;
}

/** ใบแจ้งหนี้ที่ใส่ในใบวางบิลได้ (ออกแล้ว ค้างชำระ ไม่อยู่ในใบวางบิลอื่นที่ active) */
export class BillingNoteCandidateDto {
  @ApiProperty({ example: 'ivc_…' }) invoiceId!: string;
  @ApiProperty({ example: 'INV-00000-2611-0013' }) invoiceNo!: string;
  @ApiProperty({ example: '2026-11-03' }) issueDate!: string;
  @ApiProperty({ example: '2026-12-03' }) dueDate!: string;
  @ApiProperty({ example: 'ISSUED' }) status!: string;
  @ApiProperty({ example: 'cmp_…' }) issuingCompanyId!: string;
  @ApiProperty({ example: 'brn_…' }) issuingBranchId!: string;
  @ApiPropertyOptional({ description: '`prices.sell:read`' })
  @PriceField('sell')
  sellTotal?: string;
  @ApiPropertyOptional({ description: '`prices.sell:read`' })
  @PriceField('sell')
  sellWhtExpected?: string;
  @ApiPropertyOptional({ description: '`prices.sell:read`' })
  @PriceField('sell')
  sellOutstanding?: string;
}

export class BillingNoteCandidatesDto {
  @ApiProperty({ type: [BillingNoteCandidateDto] }) data!: BillingNoteCandidateDto[];
}

export class BillingNoteSummaryDto {
  @ApiProperty({ example: 'bn_…' }) id!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เลขใบวางบิล (ชุด BN) — **ร่างไม่มีเลข**',
  })
  billingNoteNo!: string | null;
  @ApiProperty({ enum: BILLING_NOTE_STATUSES }) status!: BillingNoteStatusDto;
  @ApiProperty({ type: InvoiceCustomerDto }) customer!: InvoiceCustomerDto;
  @ApiProperty({ description: 'จำนวนใบแจ้งหนี้ในใบ' }) invoiceCount!: number;
  @ApiProperty({ nullable: true, type: String, description: 'วันวางบิล (วันที่ออก) — ร่าง = null' })
  billingDate!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'วันนัดรับเช็ค/โอน' })
  collectionDate!: string | null;
  @ApiPropertyOptional({ description: 'ยอดวางบิล (Σ ยอดค้างของใบแจ้งหนี้) — `prices.sell:read`' })
  @PriceField('sell')
  sellTotal?: string;
  @ApiPropertyOptional({
    description: 'ยอดวางบิล − WHT ที่คาดว่าจะถูกหัก (ประมาณการ) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellNetExpected?: string;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class BillingNoteAcknowledgementDto {
  @ApiProperty({ description: 'ชื่อผู้รับวางบิลฝั่งลูกค้า' }) name!: string;
  @ApiProperty({ example: '2026-11-21' }) receivedOn!: string;
  @ApiProperty({ description: 'เวลาที่บันทึก' }) recordedAt!: string;
  @ApiProperty({ nullable: true, type: String }) recordedBy!: string | null;
}

export class BillingNoteDto extends BillingNoteSummaryDto {
  @ApiProperty({ example: 'cmp_…' }) issuingCompanyId!: string;
  @ApiProperty({ example: 'brn_…' }) issuingBranchId!: string;
  @ApiPropertyOptional({
    description: 'Σ WHT ที่คาดว่าจะถูกหัก (ประมาณการ — D-54) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellWhtExpected?: string;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({
    type: [BillingNoteInvoiceDto],
    description: 'ใบแจ้งหนี้ในใบ (รวมที่ถอดออกจากร่างแล้ว `active=false`)',
  })
  invoices!: BillingNoteInvoiceDto[];
  @ApiProperty({
    type: BillingNoteAcknowledgementDto,
    nullable: true,
    description: 'ผู้รับวางบิล — ยังไม่บันทึก = null',
  })
  acknowledgement!: BillingNoteAcknowledgementDto | null;
  @ApiProperty({ nullable: true, type: String }) collectedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) collectedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) collectNote!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) issuedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) issuedBy!: string | null;
  @ApiProperty({
    type: InvoicePdfDto,
    nullable: true,
    description:
      'PDF ต้นฉบับที่เก็บ ณ วันออก — null = ร่าง หรือยังไม่ได้ render (`GET /v1/billing-notes/{id}/pdf` สร้างให้)',
  })
  pdf!: InvoicePdfDto | null;
}

export class BillingNotePageDto {
  @ApiProperty({ type: [BillingNoteSummaryDto] }) data!: BillingNoteSummaryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class BillingNoteSummaryCountsDto {
  @ApiProperty() total!: number;
  @ApiProperty() draft!: number;
  @ApiProperty() issued!: number;
  @ApiProperty() collected!: number;
  @ApiProperty() cancelled!: number;
}
