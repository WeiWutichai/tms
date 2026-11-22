import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { ACCOUNTING_DATASETS } from './file-export-adapter';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ตัวกรองของ "ส่งออกให้นักบัญชี" (ST7-T23) — ใช้ทั้ง `GET /v1/accounting-exports/summary` และ `filter` ของ
 * `POST /v1/exports` (resource `accounting-sales` / `accounting-receipts` / `accounting-settlements`)
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
      'sales = ใบแจ้งหนี้ที่ออกแล้ว (ตามวันที่ออก) · receipts = รับชำระที่ยังไม่กลับรายการ (ตามวันที่รับ) · ' +
      'settlements = ใบสำคัญจ่ายรถร่วมที่บันทึกจ่ายแล้ว (ตามวันที่จ่าย)',
  })
  dataset!: string;

  @ApiProperty({ example: 'accounting-sales', description: '`resource` ของ `POST /v1/exports`' })
  resource!: string;

  @ApiProperty({ description: 'จำนวนเอกสารในช่วง' }) documents!: number;

  @ApiProperty({ description: 'จำนวนแถวในไฟล์ (แถวเอกสาร + แถวรายการ ไม่รวมหัวคอลัมน์)' })
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
    description: 'เฉพาะชุดที่ผู้เรียกมีสิทธิ์อ่าน (`invoices:read` / `settlements:read`)',
  })
  datasets!: AccountingExportDatasetDto[];

  @ApiProperty({ type: [AccountingExportTemplateDto] })
  templates!: AccountingExportTemplateDto[];
}
