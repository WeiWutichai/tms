import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, Matches } from 'class-validator';
import { MAX_DOS_PER_INVOICE } from './billing-limits';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** รอบวางบิลที่สั่งรอบได้ (`MANUAL` = ลูกค้าสร้างร่างเองเท่านั้น ไม่เข้ารอบ — docs/01 §3.2 `billing_cycle`) */
export const INVOICE_RUN_CYCLES = ['PER_DO', 'WEEKLY', 'MONTHLY'] as const;
export type InvoiceRunCycle = (typeof INVOICE_RUN_CYCLES)[number];

/** สั่งรอบวางบิล (ST5-T12; docs/04 F3 "Invoice run (async)", docs/04 G2 #6 `POST /invoice-runs`) */
export class CreateInvoiceRunDto {
  @ApiProperty({
    enum: INVOICE_RUN_CYCLES,
    description:
      'รอบวางบิลของลูกค้าที่เข้ารอบนี้ (`customer.billingCycle`) · `MANUAL` และลูกค้าที่ปิดใช้ (`INACTIVE`) ไม่เข้ารอบ · ' +
      `\`MONTHLY\`/\`WEEKLY\` = **ใบแจ้งหนี้ใบเดียวต่อลูกค้าต่อรอบ** (เกิน ${MAX_DOS_PER_INVOICE} DO จึงแบ่งเป็นหลายร่าง + \`splitByCap\`) · \`PER_DO\` = 1 ร่างต่อ DO`,
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
      'ของลูกค้าในรอบนี้ **เฉพาะใบของงวดนี้**: วันสิ้นงวดของใบ (`periodTo`) อยู่ในงวดของรอบ (ใบที่งวดคร่อมขอบรอบเข้ารอบที่งวดของใบจบ) · ใบที่ออกเลขหลังรอบของงวดนั้นสั่งไปแล้ว **ไม่ถูกเลือกโดยรอบถัดไป** (periodTo อยู่นอกงวด) — ทำใบวางบิลมือ (`GET /billing-notes/candidates`) หรือสั่งรอบของงวดนั้นซ้ำ · ' +
      'ใบที่ไม่มีงวดใช้วันที่ออก (`issueDate`) อยู่ในงวดของรอบ (1 ร่างต่อผู้ออก/สาขาผู้ออก) · ไม่ส่ง = true',
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
  @ApiProperty({
    enum: ['SUCCEEDED', 'PARTIAL', 'FAILED', 'NOTHING_TO_BILL'],
    description:
      '`SUCCEEDED` = ทุกกลุ่มผ่าน (สร้าง ≥ 1 ร่าง) · `PARTIAL` = บางกลุ่มล้ม (กลุ่มที่ล้มย้อนทั้งกลุ่ม) · `FAILED` = ทุกกลุ่มที่ทำล้ม · ' +
      '`NOTHING_TO_BILL` = ไม่มีร่างที่ต้องสร้าง (DO ที่ข้ามดูใน `skippedDeliveryOrders`) · client ต้องรับค่าที่ไม่รู้จักได้',
  })
  outcome!: string;
  @ApiProperty({ description: 'จำนวนร่างใบแจ้งหนี้ที่สร้างของลูกค้านี้ (ทั้งหมด)' })
  invoiceCount!: number;
  @ApiProperty({
    type: [InvoiceRunDocRefDto],
    description:
      'ร่างใบแจ้งหนี้ที่สร้าง — แสดงไม่เกิน 50 รายการ (ครบใน `invoiceCount` + `invoicesListUrl`)',
  })
  invoices!: InvoiceRunDocRefDto[];
  @ApiProperty({ example: '/v1/invoices?customerId=cus_…&status=DRAFT' })
  invoicesListUrl!: string;
  @ApiProperty({ type: [InvoiceRunDocRefDto] }) billingNotes!: InvoiceRunDocRefDto[];
  @ApiProperty({
    description: `true = DO ของลูกค้าในงวดเกินเพดาน ${MAX_DOS_PER_INVOICE} ใบต่อใบแจ้งหนี้ จึงแบ่งเป็นหลายร่าง (ปกติ 1 ร่างต่อลูกค้าต่อรอบ)`,
  })
  splitByCap!: boolean;
  @ApiProperty({ description: 'จำนวน DO ที่ข้าม (ทั้งหมด)' }) skippedCount!: number;
  @ApiProperty({
    type: [InvoiceRunSkippedDoDto],
    description:
      'DO ที่ขึ้นคิวแต่ไม่ผ่านตอนส่งบัญชี/ดึงเข้าร่าง (เช่น หลักฐานไม่ครบตาม checklist ปัจจุบัน, อยู่ในร่างอื่นแล้ว `IN_INVOICE`) — ' +
      'ไม่อยู่ในร่าง · แสดงไม่เกิน 50 รายการ',
  })
  skippedDeliveryOrders!: InvoiceRunSkippedDoDto[];
  @ApiProperty({ description: 'จำนวนกลุ่ม (ร่าง) ที่ล้ม' }) failedGroups!: number;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'problem+json ของกลุ่มแรกที่ล้ม (กลุ่ม/ลูกค้าอื่นไม่ล้มตาม)',
  })
  problem!: Record<string, unknown> | null;
}

/** ไฟล์สรุปรอบ (.xlsx) — ดาวน์โหลดที่ `url` (`GET /v1/exports/{jobId}` เฉพาะผู้สั่งที่มี `export:run`; ไฟล์ใช้ได้ 7 วัน) */
export class InvoiceRunSummaryDto {
  @ApiProperty({ example: '/v1/exports/job_3f2a…' }) url!: string;
  @ApiProperty({ example: 'doc_…' }) documentId!: string;
  @ApiProperty({ example: 'สรุปรอบวางบิล_2026-10-01_2026-10-31.xlsx' }) fileName!: string;
  @ApiProperty({ description: 'จำนวนแถว (1 แถวต่อร่าง; ลูกค้าที่ไม่มีร่าง 1 แถว)' }) rows!: number;
  @ApiProperty() bytes!: number;
}

export class InvoiceRunResultDto {
  @ApiProperty({ enum: INVOICE_RUN_CYCLES }) billingCycle!: string;
  @ApiProperty() periodFrom!: string;
  @ApiProperty() periodTo!: string;
  @ApiProperty() customers!: number;
  @ApiProperty() invoicesCreated!: number;
  @ApiProperty({
    description:
      'จำนวนร่างใบวางบิลที่สร้าง (ใบแจ้งหนี้ที่ `periodTo` อยู่ในงวดของรอบ) · ใบที่ออกเลขหลังรอบของงวดนั้นสั่งไปแล้ว **ไม่ถูกเลือกโดยรอบถัดไป** (periodTo อยู่นอกงวด) — ทำใบวางบิลมือ (`GET /billing-notes/candidates`) หรือสั่งรอบของงวดนั้นซ้ำ',
  })
  billingNotesCreated!: number;
  @ApiProperty({ description: 'จำนวนลูกค้าที่ PARTIAL/FAILED' }) failed!: number;
  @ApiProperty({ example: MAX_DOS_PER_INVOICE, description: 'เพดาน DO ต่อใบแจ้งหนี้ที่รอบนี้ใช้' })
  maxDeliveryOrdersPerInvoice!: number;
  @ApiProperty({
    nullable: true,
    type: InvoiceRunSummaryDto,
    description:
      'ไฟล์สรุปรอบ .xlsx (ลูกค้า/ผล/ร่าง/จำนวน DO — **ยอดเงินเฉพาะผู้สั่งที่มี `prices.sell:read`**) · ผู้สั่งได้แจ้งเตือนพร้อมลิงก์ · ' +
      'null = ไม่มีลูกค้าในรอบ / ผู้สั่งไม่มี `export:run` / สร้างไฟล์ไม่สำเร็จ (ร่างที่สร้างแล้วไม่กระทบ)',
  })
  summary!: InvoiceRunSummaryDto | null;
  @ApiProperty({ type: [InvoiceRunCustomerResultDto] }) results!: InvoiceRunCustomerResultDto[];
}
