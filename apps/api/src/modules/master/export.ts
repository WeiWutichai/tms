import { StreamableFile } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { Response } from 'express';

/** ส่งออกข้อมูลหลัก (docs/04 B "export", spec/02 MD-010: Excel/CSV) — ใช้ร่วมทุก master */
export const EXPORT_MAX_ROWS = 10_000;

export class ExportFormatQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';
}

export interface ExportColumn<R> {
  header: string;
  value: (r: R) => string | number | null | undefined;
}

/** กัน CSV/formula injection: ค่าที่ขึ้นต้นด้วย = + - @ tab CR ใส่ ' นำหน้า (OWASP) */
function safe(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : safe(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV UTF-8 + BOM (Excel ไทยเปิดได้ถูก) หรือ .xlsx หนึ่ง sheet — ตั้ง header ดาวน์โหลดให้ */
export async function sendExport<R>(
  res: Response,
  format: 'xlsx' | 'csv',
  baseName: string,
  columns: ExportColumn<R>[],
  rows: R[],
): Promise<StreamableFile> {
  const name = `${baseName.replace(/[^\w.\-]/g, '_')}.${format}`;
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  if (format === 'csv') {
    const lines = [columns.map((c) => csvCell(c.header)).join(',')];
    for (const r of rows) lines.push(columns.map((c) => csvCell(c.value(r))).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return new StreamableFile(Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8'));
  }
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(baseName.slice(0, 31));
  ws.addRow(columns.map((c) => c.header)).font = { bold: true };
  for (const r of rows)
    ws.addRow(
      columns.map((c) => {
        const v = c.value(r);
        return typeof v === 'string' ? safe(v) : (v ?? null);
      }),
    );
  ws.columns.forEach((col) => (col.width = 20));
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  return new StreamableFile(Buffer.from(await wb.xlsx.writeBuffer()));
}
