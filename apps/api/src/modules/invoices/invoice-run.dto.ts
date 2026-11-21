import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, Matches } from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** รอบวางบิลที่สั่งรอบได้ (`MANUAL` = ลูกค้าสร้างร่างเองเท่านั้น ไม่เข้ารอบ — docs/01 §3.2 `billing_cycle`) */
export const INVOICE_RUN_CYCLES = ['PER_DO', 'WEEKLY', 'MONTHLY'] as const;
export type InvoiceRunCycle = (typeof INVOICE_RUN_CYCLES)[number];

/** สั่งรอบวางบิล (ST5-T12; docs/04 F3 "Invoice run (async)", docs/04 G2 #6 `POST /invoice-runs`) */
export class CreateInvoiceRunDto {
  @ApiProperty({
    enum: INVOICE_RUN_CYCLES,
    description:
      'รอบวางบิลของลูกค้าที่เข้ารอบนี้ (`customer.billingCycle`) · `MANUAL` ไม่เข้ารอบ · ' +
      '`MONTHLY`/`WEEKLY` = 1 ร่างต่อลูกค้า (เกิน 200 DO แบ่งเป็นหลายร่าง) · `PER_DO` = 1 ร่างต่อ DO',
  })
  @IsIn(INVOICE_RUN_CYCLES)
  billingCycle!: InvoiceRunCycle;

  @ApiProperty({ example: '2026-10-01', description: 'งวดตั้งแต่ (วันที่ DO — `doDate`)' })
  @Matches(DATE_RE)
  periodFrom!: string;

  @ApiProperty({ example: '2026-10-31', description: 'งวดถึง (วันที่ DO — `doDate`) ≥ periodFrom' })
  @Matches(DATE_RE)
  periodTo!: string;

  @ApiPropertyOptional({
    description:
      'true = ส่งบัญชี DO ที่ยังไม่ส่งพร้อมสร้างร่าง (เหมือน `POST /invoices` `releaseDeliveryOrders`) · ' +
      'ไม่ส่ง/false = ดึงเฉพาะ DO ที่ส่งบัญชีแล้ว',
  })
  @IsOptional()
  @IsBoolean()
  releaseDeliveryOrders?: boolean;

  @ApiPropertyOptional({
    description:
      'สร้างร่างใบวางบิลอัตโนมัติ (docs/04 F2) จากใบแจ้งหนี้ที่ออกแล้วยังค้างและยังไม่อยู่ในใบวางบิลที่ active ' +
      'ของลูกค้าในรอบนี้ (1 ร่างต่อผู้ออก/สาขาผู้ออก) · ไม่ส่ง = true',
  })
  @IsOptional()
  @IsBoolean()
  billingNotes?: boolean;
}

/** 202 — ติดตามที่ `statusUrl` (`GET /v1/jobs/{id}`) */
export class InvoiceRunAcceptedDto {
  @ApiProperty({ example: 'job_3f2a…' }) jobId!: string;
  @ApiProperty({ example: '/v1/jobs/job_3f2a…' }) statusUrl!: string;
}

// ---------- ผลของ job (`GET /v1/jobs/{id}` → `result`) ----------

export class InvoiceRunDocRefDto {
  @ApiProperty({ example: 'inv_…' }) id!: string;
  @ApiProperty({ example: '/v1/invoices/inv_…' }) url!: string;
  @ApiPropertyOptional({ description: 'จำนวน DO ในร่าง (เฉพาะใบแจ้งหนี้)' })
  deliveryOrderCount?: number;
  @ApiPropertyOptional({ description: 'จำนวนใบแจ้งหนี้ในร่าง (เฉพาะใบวางบิล)' })
  invoiceCount?: number;
}

export class InvoiceRunSkippedDoDto {
  @ApiProperty({ example: 'do_…' }) deliveryOrderId!: string;
  @ApiProperty({ nullable: true, type: String }) doNo!: string | null;
  @ApiProperty({ type: [String], example: ['POD_INCOMPLETE'] }) reasons!: string[];
}

export class InvoiceRunCustomerResultDto {
  @ApiProperty({ example: 'cus_…' }) customerId!: string;
  @ApiProperty() customerCode!: string;
  @ApiProperty() customerName!: string;
  @ApiProperty({ enum: ['CREATED', 'NOTHING_TO_BILL', 'FAILED'] }) outcome!: string;
  @ApiProperty({ type: [InvoiceRunDocRefDto] }) invoices!: InvoiceRunDocRefDto[];
  @ApiProperty({ type: [InvoiceRunDocRefDto] }) billingNotes!: InvoiceRunDocRefDto[];
  @ApiProperty({
    type: [InvoiceRunSkippedDoDto],
    description:
      'DO ที่ขึ้นคิวแต่ตรวจซ้ำตอนดึงไม่ผ่าน (เช่น หลักฐานไม่ครบตาม checklist ปัจจุบัน) — ไม่อยู่ในร่าง',
  })
  skippedDeliveryOrders!: InvoiceRunSkippedDoDto[];
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'problem+json ของลูกค้าที่ล้ม (ลูกค้ารายอื่นไม่ล้มตาม)',
  })
  problem!: Record<string, unknown> | null;
}

export class InvoiceRunResultDto {
  @ApiProperty({ enum: INVOICE_RUN_CYCLES }) billingCycle!: string;
  @ApiProperty() periodFrom!: string;
  @ApiProperty() periodTo!: string;
  @ApiProperty() customers!: number;
  @ApiProperty() invoicesCreated!: number;
  @ApiProperty() billingNotesCreated!: number;
  @ApiProperty() failed!: number;
  @ApiProperty({ type: [InvoiceRunCustomerResultDto] }) results!: InvoiceRunCustomerResultDto[];
}
