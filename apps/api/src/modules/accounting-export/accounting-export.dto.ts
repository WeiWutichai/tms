import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { ACCOUNTING_DATASETS } from './file-export-adapter';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ตัวกรองของ "ส่งออกให้นักบัญชี" (ST7-T23) — ใช้ทั้ง `GET /v1/accounting-exports/summary` และ `filter` ของ
 * `POST /v1/exports` (resource `accounting-sales` / `accounting-receipts` / `accounting-settlements` / `accounting-wht-summary`)
 */
export class AccountingExportQuery {
  @ApiProperty({
    example: '2026-10-01',
    description: 'วันแรกของช่วง (วันที่เอกสาร เวลาไทย) — ช่วงยาวสุด 366 วัน',
  })
  @IsString()
  @Matches(DAY_RE, { message: 'dateFrom must be YYYY-MM-DD' })
  dateFrom!: string;

  @ApiProperty({ example: '2026-10-31', description: 'วันสุดท้ายของช่วง (รวมวันนี้)' })
  @IsString()
  @Matches(DAY_RE, { message: 'dateTo must be YYYY-MM-DD' })
  dateTo!: string;

  @ApiPropertyOptional({
    example: 'generic',
    description:
      'รูปแบบไฟล์ (`templates[].key` จาก summary) — ไม่ส่ง = รูปแบบทั่วไป (layout กลาง: แถวเอกสาร + แถวรายการ)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{0,39}$/, { message: 'template must be a-z0-9-' })
  template?: string;
}

export class AccountingExportDatasetDto {
  @ApiProperty({
    enum: ACCOUNTING_DATASETS,
    description:
      'sales = ใบแจ้งหนี้ที่ออกแล้ว (ตามวันที่ออก — รวมใบที่ยกเลิกเป็นแถวแยกยอด D-73) · receipts = รับชำระ ' +
      '(ตามวันที่รับ — รวมที่กลับรายการเป็นแถวแยกยอด D-73) · settlements = ใบสำคัญจ่ายรถร่วมที่บันทึกจ่ายแล้ว (ตามวันที่จ่าย) · ' +
      'wht = สรุปหัก ณ ที่จ่าย **ประมาณการ** ต่อคู่ค้า (D-73 — ไม่ใช่แบบ ภ.ง.ด. / 50 ทวิ)',
  })
  dataset!: string;

  @ApiProperty({ example: 'accounting-sales', description: '`resource` ของ `POST /v1/exports`' })
  resource!: string;

  @ApiProperty({
    description:
      'จำนวนเอกสารที่ยังใช้ในช่วง (นับในยอดรวม) · wht = จำนวนใบสำคัญจ่าย/รับชำระที่มีหัก ณ ที่จ่าย',
  })
  documents!: number;

  @ApiProperty({
    description:
      'D-73 จำนวนเอกสารที่ยกเลิก (sales) / กลับรายการ (receipts) ในช่วง — อยู่ในไฟล์เป็นแถวเอกสารที่ยอดแยกคอลัมน์ ไม่นับรวม · ชุดอื่น = 0',
  })
  cancelledDocuments!: number;

  @ApiProperty({
    description:
      'จำนวนแถวในไฟล์ (แถวเอกสาร + แถวรายการ + แถวเอกสารที่ยกเลิก ไม่รวมหัวคอลัมน์) · wht = จำนวนคู่ค้า',
  })
  rows!: number;
}

export class AccountingExportTemplateDto {
  @ApiProperty({ example: 'generic' }) key!: string;
  @ApiProperty({ example: 'ทั่วไป' }) displayName!: string;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty({ enum: ACCOUNTING_DATASETS, isArray: true }) datasets!: string[];
}

export class AccountingExportSummaryDto {
  @ApiProperty({ example: '2026-10-01' }) dateFrom!: string;
  @ApiProperty({ example: '2026-10-31' }) dateTo!: string;

  @ApiProperty({
    type: [AccountingExportDatasetDto],
    description:
      'เฉพาะชุดที่ผู้เรียกมีสิทธิ์อ่าน (`invoices:read` / `settlements:read` · wht = อย่างใดอย่างหนึ่ง — มีเฉพาะฝั่งที่อ่านได้)',
  })
  datasets!: AccountingExportDatasetDto[];

  @ApiProperty({ type: [AccountingExportTemplateDto] })
  templates!: AccountingExportTemplateDto[];
}
