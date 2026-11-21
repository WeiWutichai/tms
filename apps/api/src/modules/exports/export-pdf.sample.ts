import {
  revenueExportColumns,
  revenuePdfSubtitle,
  revenuePdfTitle,
  revenuePeriodText,
} from '../reports/revenue-export';
import type { RevenueRowDto } from '../reports/revenue-report.dto';
import { exportTableDocument } from './export-pdf';

const row = (id: string, label: string | null, n: number, amount: string): RevenueRowDto => ({
  id,
  label,
  detail: null,
  invoiceCount: n,
  deliveryOrderCount: n,
  lineCount: n,
  sellAmount: amount,
});

/** ตัวอย่าง PDF ส่งออก "รายงานรายได้ต่อเส้นทาง" (ST9-T05) — test/pdf-thai.test.ts (KINDS) */
export function sampleRevenueRoutePdf() {
  const rows = [
    row('a', 'คลังสินค้าบางนา – ร้านค้าปลีกชลบุรี', 3, '125000.5'),
    row('b', 'โรงงานปูนสระบุรี – ไซต์ก่อสร้างศรีราชา', 2, '48250.00'),
    row('c', 'ท่าเรือแหลมฉบัง – คลังเย็นลาดกระบัง', 1, '1750'),
    row('none', null, 1, '1234.66'),
    row('total', null, 7, '176235.16'),
  ];
  return exportTableDocument(revenueExportColumns('route', true), rows, {
    title: revenuePdfTitle('route'),
    subtitle: revenuePdfSubtitle(revenuePeriodText('2026-10', '2026-11')),
    printedAt: new Date('2026-11-22T02:30:00Z'),
  });
}
