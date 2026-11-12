import ExcelJS from 'exceljs';
import { XLSX_MIME } from '../documents/mime';

/** spec/02 MD-280: ≤ 5,000 แถวต่อไฟล์ (ไม่นับหัวคอลัมน์) */
export const MAX_IMPORT_ROWS = 5000;

export interface ParsedSheet {
  headers: string[];
  /** ค่าเป็นข้อความทุกช่อง (ตัดช่องว่างหัวท้าย) ยาวเท่า headers */
  rows: string[][];
  /** ลำดับแถวในไฟล์ (1 = หัวคอลัมน์) — ใช้รายงานผลตรวจให้ตรงกับที่ผู้ใช้เห็นใน Excel */
  rowNumbers: number[];
}

export class ImportFileError extends Error {
  constructor(
    readonly code:
      | 'no_header'
      | 'too_many_rows'
      | 'unreadable'
      | 'duplicate_header'
      | 'file_rejected'
      | 'quota_exceeded',
    message: string,
  ) {
    super(message);
  }
}

/** เพดานหลังแตก zip (กัน zip bomb) และจำนวนคอลัมน์ */
export const MAX_XLSX_UNZIPPED = 20 * 1024 * 1024;
export const MAX_IMPORT_COLUMNS = 100;

export async function parseImportFile(buf: Buffer, mime: string): Promise<ParsedSheet> {
  const grid = mime === XLSX_MIME ? await readXlsx(buf) : readCsv(buf);
  // ข้ามแถวว่างด้านบน — หัวคอลัมน์คือแถวแรกที่มีค่า
  let h = 0;
  while (h < grid.length && grid[h]!.cells.every((c) => !c)) h++;
  const head = grid[h];
  if (!head) throw new ImportFileError('no_header', 'ไฟล์ไม่มีหัวคอลัมน์');
  let width = Math.min(head.cells.length, MAX_IMPORT_COLUMNS);
  while (width > 0 && !head.cells[width - 1]) width--;
  const headers = head.cells.slice(0, width).map((c) => c.trim());
  if (!headers.length) throw new ImportFileError('no_header', 'ไฟล์ไม่มีหัวคอลัมน์');
  const seen = new Set<string>();
  for (const x of headers) {
    const k = x.toLowerCase();
    if (x && seen.has(k))
      throw new ImportFileError('duplicate_header', `หัวคอลัมน์ "${x}" ซ้ำกันในไฟล์`);
    seen.add(k);
  }
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (const r of grid.slice(h + 1)) {
    const cells = Array.from({ length: width }, (_, i) => (r.cells[i] ?? '').trim());
    if (cells.every((c) => !c)) continue; // แถวว่างไม่นับ
    rows.push(cells);
    rowNumbers.push(r.n);
  }
  if (rows.length > MAX_IMPORT_ROWS) throw tooMany();
  if (!rows.length) throw new ImportFileError('no_header', 'ไฟล์มีแต่หัวคอลัมน์ ไม่มีแถวข้อมูล');
  return { headers, rows, rowNumbers };
}

const tooMany = () =>
  new ImportFileError(
    'too_many_rows',
    `ไฟล์มีเกิน ${MAX_IMPORT_ROWS.toLocaleString('en-US')} แถว — แบ่งเป็นหลายไฟล์`,
  );

interface GridRow {
  n: number;
  cells: string[];
}

/**
 * ขนาดรวมหลังแตก zip จาก central directory (ไม่แตกไฟล์จริง) — null = อ่านโครง zip ไม่ได้/เป็น zip64
 */
export function zipUncompressedSize(buf: Buffer): number | null {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const entries = buf.readUInt16LE(i + 10);
    let p = buf.readUInt32LE(i + 16);
    let total = 0;
    for (let e = 0; e < entries; e++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
      const size = buf.readUInt32LE(p + 24);
      if (size === 0xffffffff) return null;
      total += size;
      p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    return total;
  }
  return null;
}

/**
 * อ่าน sheet แรก — ขนาดหลังแตก zip ถูกจำกัดก่อนโหลด (กัน zip bomb) และนับแถวก่อนแปลงค่า
 * (ไม่ใช้ stream reader ของ exceljs: อ่านไม่ได้เมื่อ worksheet อยู่ก่อน workbook.xml ใน zip)
 */
async function readXlsx(buf: Buffer): Promise<GridRow[]> {
  const size = zipUncompressedSize(buf);
  if (size === null) throw new ImportFileError('unreadable', 'อ่านไฟล์ Excel ไม่ได้');
  if (size > MAX_XLSX_UNZIPPED)
    throw new ImportFileError('unreadable', 'ไฟล์ Excel มีข้อมูลมากเกินไป — แบ่งเป็นหลายไฟล์');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    throw new ImportFileError('unreadable', 'อ่านไฟล์ Excel ไม่ได้');
  }
  const ws = wb.worksheets[0]; // MD-280: sheet แรก
  if (!ws) throw new ImportFileError('no_header', 'ไฟล์ไม่มีหัวคอลัมน์');
  // actualRowCount = แถวที่มีค่า (รวมหัวคอลัมน์)
  if (ws.actualRowCount > MAX_IMPORT_ROWS + 1) throw tooMany();
  const out: GridRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const vals = row.values as ExcelJS.CellValue[];
    const len = Math.min(vals.length - 1, MAX_IMPORT_COLUMNS);
    const cells: string[] = [];
    for (let c = 1; c <= len; c++) cells.push(cellText(vals[c] ?? null));
    out.push({ n, cells });
  });
  return out;
}

/** ค่าในเซลล์ → ข้อความ: สูตรใช้ค่าที่คำนวณแล้ว (spec/02 §11.8), วันที่ → YYYY-MM-DD */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    // สูตรใช้ค่าที่คำนวณแล้ว; ไฟล์ที่ไม่มีค่าที่คำนวณ (บางโปรแกรมสร้าง) = ว่าง
    if ('formula' in v || 'sharedFormula' in v || 'result' in v)
      return cellText(((v as unknown as { result?: unknown }).result ?? null) as ExcelJS.CellValue);
    if ('richText' in v)
      return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ('error' in v) return '';
  }
  return String(v);
}

/**
 * CSV (RFC 4180) — UTF-8 (มี/ไม่มี BOM) หรือ TIS-620/Windows-874 จาก Excel ไทย (spec/02 §11.9)
 * เลขแถว = ลำดับ record (เหมือนที่ Excel แสดง — newline ในเซลล์ที่มีเครื่องหมายคำพูดไม่ขึ้นแถวใหม่)
 */
function readCsv(buf: Buffer): GridRow[] {
  const text = decodeText(buf);
  const out: GridRow[] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  let record = 0;
  let dataRows = 0;
  const delim = sniffDelimiter(text);
  const flush = () => {
    row.push(cell);
    record++;
    if (row.length > MAX_IMPORT_COLUMNS) row.length = MAX_IMPORT_COLUMNS;
    if (row.some((c) => c.trim())) {
      if (out.length && ++dataRows > MAX_IMPORT_ROWS) throw tooMany();
      out.push({ n: record, cells: row });
    }
    row = [];
    cell = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') q = true;
    else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      flush();
    } else cell += c;
  }
  if (q)
    throw new ImportFileError(
      'unreadable',
      `เครื่องหมายคำพูด (") ในแถว ${record + 1} ไม่ปิด — ตรวจไฟล์ CSV`,
    );
  if (cell !== '' || row.length) flush();
  return out;
}

function decodeText(buf: Buffer): string {
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-874').decode(b);
  }
}

/** Excel บางเครื่องบันทึก CSV ด้วย ; หรือ tab — ดูจากบรรทัดแรก */
function sniffDelimiter(text: string): string {
  const nl = text.search(/\r?\n/);
  const first = nl < 0 ? text : text.slice(0, nl);
  const count = (d: string) => first.split(d).length - 1;
  const cands = [',', ';', '\t'].map((d) => [d, count(d)] as const);
  cands.sort((a, b) => b[1] - a[1]);
  return cands[0]![1] > 0 ? cands[0]![0] : ',';
}
