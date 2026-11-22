import { escapeHtml, type RenderOptions } from '../../pdf/pdf-renderer';
import type { ExportColumn } from '../master/export';

/** หัวเอกสาร PDF ของงานส่งออก (ST9-T05) */
export interface ExportPdfHead {
  title: string;
  subtitle?: string;
  /** เวลาพิมพ์ (แสดงเป็นเวลาไทย) */
  printedAt: Date;
}

/** วันเวลาไทยแบบอ่าน เช่น 22/11/2569 09:30 */
function thaiStamp(d: Date): string {
  const b = new Date(d.getTime() + 7 * 3600_000).toISOString();
  return `${b.slice(8, 10)}/${b.slice(5, 7)}/${Number(b.slice(0, 4)) + 543} ${b.slice(11, 16)}`;
}

/** เงินจากค่า Decimal (string/number) → "1,750.00" ทศนิยม 2 ตำแหน่งเสมอ (ไม่ผ่าน float เมื่อเป็น string) */
function moneyText(v: string | number): string {
  const s = typeof v === 'number' ? v.toFixed(2) : v;
  const neg = s.startsWith('-');
  const [i = '0', f = ''] = s.replace('-', '').split('.');
  return `${neg ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f.padEnd(2, '0').slice(0, 2)}`;
}

function cellText(v: string | number | null | undefined, money: boolean): string {
  if (v === null || v === undefined || v === '') return '';
  if (money) return moneyText(v);
  return escapeHtml(typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
}

/**
 * PDF ตาราง A4 แนวนอนของงานส่งออก (ST9-T05 รายงานสรุป) — ฟอนต์ Sarabun (PdfRenderer) · คอลัมน์ `money` จัดขวา ทศนิยม 2 ตำแหน่ง
 * แถว id `total` = แถวรวม (ตัวหนา) · ข้อความต้องอยู่ในชุดอักขระ Sarabun (ห้าม "→" — test/pdf-thai.test.ts)
 */
export function exportTableDocument<R>(
  columns: ExportColumn<R>[],
  rows: R[],
  head: ExportPdfHead,
): RenderOptions {
  const right = (c: ExportColumn<R>, v: unknown) => c.money || typeof v === 'number';
  const body = rows
    .map(
      (r) =>
        `<tr${(r as { id?: unknown }).id === 'total' ? ' class="t"' : ''}>${columns
          .map((c) => {
            const v = c.money && c.raw ? c.raw(r) : c.value(r);
            return `<td${right(c, v) ? ' class="r"' : ''}>${cellText(v, !!c.money)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  const html = `<div class="page"><h1>${escapeHtml(head.title)}</h1>
<p class="sub">${head.subtitle ? `${escapeHtml(head.subtitle)} · ` : ''}พิมพ์เมื่อ ${escapeHtml(thaiStamp(head.printedAt))}</p>
<table><thead><tr>${columns.map((c) => `<th${c.money ? ' class="r"' : ''}>${escapeHtml(c.header)}</th>`).join('')}</tr></thead>
<tbody>${body}</tbody></table></div>`;
  const css = `@page{size:A4 landscape;margin:12mm}.page{font-size:12px}h1{font-size:18px;margin:0 0 4px}
.sub{color:#3B424C;margin:0 0 10px}table{width:100%;border-collapse:collapse}
th,td{border:1px solid #CDD1C8;padding:4px 6px;text-align:left;vertical-align:top}th{background:#EEF0EC;font-weight:600}
thead{display:table-header-group}tr{break-inside:avoid}.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.t td{font-weight:700;background:#F4F5F2}`;
  return { body: html, css, title: head.title };
}
