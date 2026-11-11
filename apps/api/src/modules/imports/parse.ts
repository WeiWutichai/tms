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
    readonly code: 'no_header' | 'too_many_rows' | 'unreadable' | 'duplicate_header',
    message: string,
  ) {
    super(message);
  }
}

export async function parseImportFile(buf: Buffer, mime: string): Promise<ParsedSheet> {
  const grid = mime === XLSX_MIME ? await readXlsx(buf) : readCsv(buf);
  // ข้ามแถวว่างด้านบน — หัวคอลัมน์คือแถวแรกที่มีค่า
  let h = 0;
  while (h < grid.length && grid[h]!.cells.every((c) => !c)) h++;
  const head = grid[h];
  if (!head) throw new ImportFileError('no_header', 'ไฟล์ไม่มีหัวคอลัมน์');
  let width = head.cells.length;
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
    if (rows.length > MAX_IMPORT_ROWS)
      throw new ImportFileError(
        'too_many_rows',
        `ไฟล์มีเกิน ${MAX_IMPORT_ROWS.toLocaleString('en-US')} แถว — แบ่งเป็นหลายไฟล์`,
      );
  }
  return { headers, rows, rowNumbers };
}

interface GridRow {
  n: number;
  cells: string[];
}

async function readXlsx(buf: Buffer): Promise<GridRow[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    throw new ImportFileError('unreadable', 'อ่านไฟล์ Excel ไม่ได้');
  }
  const ws = wb.worksheets[0]; // MD-280: sheet แรก
  if (!ws) throw new ImportFileError('no_header', 'ไฟล์ไม่มีหัวคอลัมน์');
  const out: GridRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = cellText(cell.value);
    });
    for (let i = 0; i < cells.length; i++) cells[i] ??= '';
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
    if ('result' in v) return cellText((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v)
      return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ('error' in v) return '';
  }
  return String(v);
}

/** CSV (RFC 4180) — UTF-8 (มี/ไม่มี BOM) หรือ TIS-620/Windows-874 จาก Excel ไทย (spec/02 §11.9) */
function readCsv(buf: Buffer): GridRow[] {
  const text = decodeText(buf);
  const out: GridRow[] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  let line = 1;
  let rowStart = 1;
  const delim = sniffDelimiter(text);
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === '') q = true;
    else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push({ n: rowStart, cells: row });
      row = [];
      cell = '';
      line++;
      rowStart = line;
      if (out.length > MAX_IMPORT_ROWS + 2) break;
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    out.push({ n: rowStart, cells: row });
  }
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
  const first = text.slice(0, text.search(/\r?\n/) >>> 0 || text.length);
  const count = (d: string) => first.split(d).length - 1;
  const cands = [',', ';', '\t'].map((d) => [d, count(d)] as const);
  cands.sort((a, b) => b[1] - a[1]);
  return cands[0]![1] > 0 ? cands[0]![0] : ',';
}
