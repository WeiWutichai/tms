import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { PROBLEMS, type ProblemCode } from '../../common/problem';

/** ผู้รับต่อการส่ง 1 ครั้ง (ST5-T21) */
export const DOCUMENT_EMAIL_MAX_RECIPIENTS = 5;
export const DOCUMENT_EMAIL_PURPOSES = ['DOCUMENT', 'PAYMENT_REMINDER'] as const;
export type DocumentEmailPurpose = (typeof DOCUMENT_EMAIL_PURPOSES)[number];
export const DOCUMENT_EMAIL_STATUSES = ['QUEUED', 'SENT', 'FAILED'] as const;

const Recipients = () => (t: object, k: string) => {
  ApiPropertyOptional({
    type: [String],
    example: ['ap@example.co.th'],
    description:
      `อีเมลผู้รับ 1–${DOCUMENT_EMAIL_MAX_RECIPIENTS} คน (ไม่ซ้ำ) · ไม่ระบุ = อีเมลผู้ติดต่อของลูกค้า ` +
      '(ผู้ติดต่อหลักที่มีอีเมล · ไม่มีผู้ติดต่อหลักที่มีอีเมล = ผู้ติดต่อทุกคนที่มีอีเมล สูงสุด 5) · ไม่มีเลย → 422 `document_email_no_recipient`',
  })(t, k);
  IsOptional()(t, k);
  IsArray()(t, k);
  ArrayMinSize(1)(t, k);
  ArrayMaxSize(DOCUMENT_EMAIL_MAX_RECIPIENTS)(t, k);
  ArrayUnique((e: string) => (typeof e === 'string' ? e.toLowerCase() : e))(t, k);
  IsEmail({}, { each: true })(t, k);
  MaxLength(200, { each: true })(t, k);
};

/** `POST /billing-notes/{id}/send` */
export class SendBillingNoteDto {
  @Recipients()
  to?: string[];
}

/** `POST /invoices/{id}/send` */
export class SendInvoiceDto {
  @Recipients()
  to?: string[];

  @ApiPropertyOptional({
    enum: DOCUMENT_EMAIL_PURPOSES,
    default: 'DOCUMENT',
    description:
      'DOCUMENT = ส่งใบแจ้งหนี้ · PAYMENT_REMINDER = ใบแจ้งเตือนชำระ (ต้นแบบหน้า "รับชำระ") — เฉพาะใบที่ยังมียอดค้าง (ISSUED / PARTIALLY_PAID) · ทั้งสองแบบแนบ PDF ต้นฉบับของใบ',
  })
  @IsOptional()
  @IsIn(DOCUMENT_EMAIL_PURPOSES)
  purpose?: DocumentEmailPurpose;
}

export class DocumentEmailDto {
  @ApiProperty({ example: 'dem_…' }) id!: string;
  @ApiProperty({ enum: ['invoice', 'billing_note'] }) entityType!: 'invoice' | 'billing_note';
  @ApiProperty({ example: 'bn_…', description: 'id ของใบแจ้งหนี้ (`ivc_`) หรือใบวางบิล (`bn_`)' })
  entityId!: string;
  @ApiProperty({ enum: DOCUMENT_EMAIL_PURPOSES }) purpose!: DocumentEmailPurpose;
  @ApiProperty({ example: 'BN-2611-0004', description: 'เลขเอกสาร ณ วันส่ง' }) documentNo!: string;
  @ApiProperty({ example: 'ap@example.co.th' }) to!: string;
  @ApiProperty({
    enum: DOCUMENT_EMAIL_STATUSES,
    description:
      'สถานะการส่ง (แยกจากสถานะเอกสาร — spec/05 §3 ข้อ 8): QUEUED = รอส่ง · SENT = ส่งออกจากระบบแล้ว · FAILED = ส่งไม่สำเร็จ',
  })
  status!: (typeof DOCUMENT_EMAIL_STATUSES)[number];
  @ApiProperty({
    nullable: true,
    type: String,
    example: null,
    description:
      '`email_failed` = ลองครบแล้วไม่สำเร็จ · `sandbox_suppressed` = บริษัททดสอบ (sandbox) ไม่ส่งอีเมลออกไปหาคนจริง (ST7-T09)',
  })
  failedReason!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) sentAt!: string | null;
  @ApiProperty({ example: 'doc_…', description: 'ไฟล์ที่แนบ (stored document)' })
  attachmentDocumentId!: string;
  @ApiProperty({ nullable: true, type: String, description: 'ผู้ส่ง' }) createdBy!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class DocumentEmailAttachmentDto {
  @ApiProperty({ example: 'doc_…' }) documentId!: string;
  @ApiProperty({ example: 'BN-2611-0004-ชุดเอกสาร.pdf' }) filename!: string;
  @ApiProperty({ example: 184320 }) sizeBytes!: number;
  @ApiProperty({ example: 'e3b0c442…' }) sha256!: string;
  @ApiProperty({
    type: [String],
    example: ['BN-2611-0004', 'INV-00000-2611-0013'],
    description: 'เอกสารในไฟล์ตามลำดับหน้า (ใบวางบิลก่อน แล้วใบแจ้งหนี้ตามลำดับในใบวางบิล)',
  })
  contents!: string[];
}

export class DocumentEmailResultDto {
  @ApiProperty({ type: DocumentEmailAttachmentDto }) attachment!: DocumentEmailAttachmentDto;
  @ApiProperty({ type: [DocumentEmailDto], description: '1 แถวต่อผู้รับ (สถานะเริ่ม QUEUED)' })
  emails!: DocumentEmailDto[];
}

export class DocumentEmailListDto {
  @ApiProperty({ type: [DocumentEmailDto], description: 'ใหม่สุดก่อน (สูงสุด 100 รายการ)' })
  data!: DocumentEmailDto[];
}

const prob = (code: ProblemCode, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  ...extra,
});

/** 422 ของการส่งเอกสารทางอีเมล (OpenAPI) */
export const SEND_422 = {
  status: 422,
  description:
    '`validation_failed` — `to` ผิดรูปแบบ/ซ้ำ/เกิน 5 · `document_email_no_recipient` — ไม่ระบุ `to` และลูกค้าไม่มีอีเมลผู้ติดต่อ · ' +
    '`email_attachment_too_large` — ไฟล์แนบเกินขนาด (`sizeBytes`, `maxBytes`) → ดาวน์โหลดแล้วส่งเอง',
  examples: {
    validation_failed: prob('validation_failed', {
      errors: [{ field: 'to.0', code: 'isEmail', message: 'each value in to must be an email' }],
    }),
    document_email_no_recipient: prob('document_email_no_recipient'),
    email_attachment_too_large: prob('email_attachment_too_large', {
      sizeBytes: 12582912,
      maxBytes: 10485760,
    }),
  },
};
