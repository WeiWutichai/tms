import type { ExportColumn } from '../master/export';
import type { RevenueGroupBy, RevenueRowDto } from './revenue-report.dto';

/**
 * คอลัมน์/หัวเอกสารของไฟล์ส่งออก "รายงานรายได้" (ST9-T05) — ไม่มี import ของ Nest (ใช้ใน test PDF ภาษาไทยได้ตรง)
 * ข้อความต้องอยู่ในชุดอักขระ Sarabun (ไม่มี "→" — ใช้ "–")
 */
const TH_MONTH = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];
/** 2026-11 → "พฤศจิกายน 2569" */
export const thMonth = (m: string) =>
  `${TH_MONTH[Number(m.slice(5, 7)) - 1]} ${Number(m.slice(0, 4)) + 543}`;

const REVENUE_DIM: Record<RevenueGroupBy, { label: string; key: string; detail?: string }> = {
  customer: { label: 'ลูกค้า', key: 'ลูกค้า', detail: 'รหัสลูกค้า' },
  route: { label: 'เส้นทาง', key: 'เส้นทาง' },
  vehicle: { label: 'รถ', key: 'ทะเบียนรถ', detail: 'ประเภทรถ' },
  vehicleType: { label: 'ประเภทรถ', key: 'ประเภทรถ', detail: 'รหัสประเภทรถ' },
  legalEntity: { label: 'นิติบุคคล', key: 'นิติบุคคล', detail: 'เลขประจำตัวผู้เสียภาษี' },
  month: { label: 'เดือน', key: 'เดือน' },
};

export const revenuePeriodText = (from: string, to: string) =>
  from === to ? thMonth(from) : `${thMonth(from)} – ${thMonth(to)}`;
export const revenuePdfTitle = (g: RevenueGroupBy) => `รายงานรายได้ต่อ${REVENUE_DIM[g].label}`;
export const revenuePdfSubtitle = (period: string) =>
  `งวด ${period} · ตามวันที่ออกใบแจ้งหนี้ · ยอดก่อน VAT`;

const money = (s: string | undefined) => (s === undefined ? null : Number(s));

/** คอลัมน์ไฟล์ — รายได้เฉพาะผู้มี `prices.sell:read` (`sell`) · แถว id `total` = "รวม", `none` = "ไม่ระบุ" */
export function revenueExportColumns(
  g: RevenueGroupBy,
  sell: boolean,
): ExportColumn<RevenueRowDto>[] {
  const dim = REVENUE_DIM[g];
  const name = (r: RevenueRowDto) =>
    r.id === 'total'
      ? 'รวม'
      : r.id === 'none'
        ? 'ไม่ระบุ'
        : g === 'month' && r.label
          ? thMonth(r.label)
          : r.label;
  const cols: ExportColumn<RevenueRowDto>[] = [{ header: dim.key, value: name }];
  if (dim.detail) cols.push({ header: dim.detail, value: (r) => r.detail });
  cols.push(
    { header: 'ใบแจ้งหนี้', value: (r) => r.invoiceCount },
    { header: 'DO', value: (r) => r.deliveryOrderCount },
    { header: 'บรรทัด', value: (r) => r.lineCount },
  );
  if (sell)
    cols.push({
      header: 'รายได้ (ก่อน VAT)',
      value: (r) => money(r.sellAmount),
      money: true,
      raw: (r) => r.sellAmount,
    });
  return cols;
}
