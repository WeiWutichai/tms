import { assertHumanStepUp, exportNeedsStepUp } from '../../auth/step-up';
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

/**
 * หน้าของการส่งออกแบบ job (ST9-T10) — `exportRows(q, page)` ของแต่ละ master อ่านทีละหน้าต่อจากแถว `after`
 * (Prisma cursor บน id + orderBy เดิมที่ปิดท้ายด้วย id) · ไม่ส่ง page = ส่งออกแบบทันที (เพดาน EXPORT_MAX_ROWS)
 */
export interface ExportPage {
  after: string | null;
  take: number;
}

/** อาร์กิวเมนต์ take/cursor ของ findMany สำหรับ exportRows — ไม่มี page = เพดานส่งออกทันที + 1 (ใช้ตรวจเกิน) */
export function exportFetchArgs(page?: ExportPage) {
  if (!page) return { take: EXPORT_MAX_ROWS + 1 };
  return { take: page.take, ...(page.after ? { cursor: { id: page.after }, skip: 1 } : {}) };
}

/** เกินเพดานเฉพาะการส่งออกทันที (job มีเพดานของตัวเอง — EXPORT_JOB_MAX_ROWS) */
export const overSyncCap = (n: number, page?: ExportPage) => !page && n > EXPORT_MAX_ROWS;

export interface ExportColumn<R> {
  header: string;
  value: (r: R) => string | number | null | undefined;
  /** เงิน (ST9-T05) — PDF แสดงทศนิยม 2 ตำแหน่งเสมอ · xlsx/csv ไม่เปลี่ยน */
  money?: boolean;
  /** ค่าเงินต้นฉบับ (Decimal string จาก DTO) — PDF ใช้ค่านี้แทน `value` (ไม่ผ่าน float) */
  raw?: (r: R) => string | null | undefined;
  /**
   * ST7-T23 คอลัมน์เงิน: `sell` ต้องมี `prices.sell:read` · `buy` ต้องมี `prices.buy:read` — ผู้ใช้ที่ไม่มีสิทธิ์ core ตัดคอลัมน์ทิ้ง
   * (ด่านที่สองหลัง adapter — `dropUnpricedColumns`)
   */
  price?: 'sell' | 'buy';
}

/** ตัดคอลัมน์เงินที่ผู้สั่งไม่มีสิทธิ์เห็น (ไม่ขึ้นกับว่า adapter กรองเองหรือไม่) */
export function dropUnpricedColumns<R>(
  cols: ExportColumn<R>[],
  money: { sell: boolean; buy: boolean },
): ExportColumn<R>[] {
  return cols.filter((c) => !c.price || money[c.price]);
}

/**
 * กัน CSV/formula injection ตาม OWASP: ค่าที่ขึ้นต้นด้วย = + - @ tab CR → ใส่ ' นำหน้า (ใช้ตัวเดียวทุกการส่งออก CSV)
 * ST9-T10 (review): `@` ทุกค่า รวม LINE ID `@sapsomboon` → `'@sapsomboon` (เดิม ST2-T05 ยกเว้น @ ที่ไม่มีวงเล็บ — Excel
 * บางรุ่นตีความ `@ชื่อ` เป็นการอ้างชื่อ/ฟังก์ชันได้) · .xlsx เก็บเป็นเซลล์ข้อความ ไม่ต้องเติม
 */
export function safe(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : safe(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV UTF-8 + BOM หรือ .xlsx หนึ่ง sheet — ตั้ง header ดาวน์โหลดให้
 * **แนะนำ .xlsx** (ค่าเริ่มต้น): เลขผู้เสียภาษี/รหัสสาขาเป็นข้อความ เลข 0 นำหน้าไม่หาย
 * CSV ใช้กับระบบอื่น/นำเข้ากลับ — ค่าเป็นข้อความดิบ (Excel ที่เปิด CSV ตรง ๆ อาจตัด 0 นำหน้า; [OPEN spec/12 §3])
 * กัน formula injection เฉพาะ CSV (ขึ้นต้นด้วย = + - @ tab CR → เติม ')
 */
export async function sendExport<R>(
  res: Response,
  format: 'xlsx' | 'csv',
  baseName: string,
  columns: ExportColumn<R>[],
  rows: R[],
): Promise<StreamableFile> {
  // D-67: ส่งออกของผู้ใช้ต้อง step-up 2FA ยกเว้นเลือกแถวเอง (`ids`) — API key ตาม scope
  // ไม่มีคำขอ HTTP ให้ตรวจ (ไม่ควรเกิด) = ปิดไว้ก่อน: ถือว่าต้อง step-up (review L2)
  const req = res.req as { query?: Record<string, unknown> } | undefined;
  if (!req || exportNeedsStepUp(baseName, req.query ?? {})) assertHumanStepUp();
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
        // .xlsx เก็บเป็นเซลล์ชนิดข้อความ (ไม่ถูกตีความเป็นสูตร) — ไม่ต้องเติม ' (ไม่งั้นเบอร์ +66… มี ' ติด)
        const v = c.value(r);
        return v ?? null;
      }),
    );
  ws.columns.forEach((col) => (col.width = 20));
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  return new StreamableFile(Buffer.from(await wb.xlsx.writeBuffer()));
}
