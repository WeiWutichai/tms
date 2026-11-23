import { AGING_BUCKETS } from '@tms/domain';
import type { ExportColumn } from '../master/export';
import type { AgingCustomerDto } from '../payments/payment.dto';
import type { UnbilledDeliveryOrderDto } from './unbilled-report.dto';

/**
 * คอลัมน์/หัวเอกสารของไฟล์ส่งออก "DO ยังไม่วางบิล" และ "ลูกหนี้คงค้าง" (ST9-T06; PDF — D-81 · D68-99 docs/04 H "export CSV/Excel/PDF")
 * ไม่มี import ของ Nest (ใช้ใน test PDF ภาษาไทยได้ตรง — แบบเดียวกับ revenue-export.ts) · ข้อความต้องอยู่ในชุดอักขระ Sarabun (ไม่มี "→")
 * คอลัมน์เงิน: `value` = number (xlsx/csv เดิม) · `money` + `raw` = สตริง Decimal ให้ PDF จัดขวา ทศนิยม 2 ตำแหน่ง (ไม่ผ่าน float)
 */

const num = (s: string | undefined) => (s === undefined ? null : Number(s));

/** ชื่อช่วงอายุ (ตรงกับหน้ารับชำระ/ต้นแบบ agingB) */
const BUCKET_TH: Record<(typeof AGING_BUCKETS)[number], string> = {
  NOT_DUE: 'ยังไม่ครบกำหนด',
  DAYS_1_30: '1–30 วัน',
  DAYS_31_60: '31–60 วัน',
  DAYS_61_90: '61–90 วัน',
  DAYS_OVER_90: 'เกิน 90 วัน',
};
const DO_STATUS_TH: Record<string, string> = {
  DELIVERED: 'ส่งสำเร็จ',
  POD_PENDING: 'รอ POD',
  UNBILLED: 'รอวางบิล',
};

export const unbilledPdfTitle = () => 'รายงาน DO ยังไม่วางบิล';
/** minDays = ค่าที่ผู้สั่งระบุ (ไม่ระบุ = เกณฑ์ขององค์กร) */
export const unbilledPdfSubtitle = (minDays?: string) =>
  `${minDays ? `ส่งถึงแล้วเกิน ${minDays} วัน` : 'ส่งถึงแล้วเกินเกณฑ์วันที่ตั้งไว้ขององค์กร'} · มูลค่าก่อน VAT`;

export const agingPdfTitle = () => 'รายงานลูกหนี้คงค้าง';
export const agingPdfSubtitle = () =>
  'ยอดค้างรับต่อลูกค้า แยกช่วงอายุนับจากวันครบกำหนด ณ วันที่พิมพ์';

export function unbilledExportColumns(
  sell: boolean,
  staleDrafts: boolean,
): ExportColumn<UnbilledDeliveryOrderDto>[] {
  const cols: ExportColumn<UnbilledDeliveryOrderDto>[] = [
    { header: 'เลขที่ DO', value: (r) => r.doNo },
    { header: 'วันที่ DO', value: (r) => r.doDate },
    { header: 'รหัสลูกค้า', value: (r) => r.customer.code },
    { header: 'ลูกค้า', value: (r) => r.customer.legalName },
    { header: 'เลขที่ใบสั่ง', value: (r) => r.salesOrder.soNo },
    { header: 'สถานะ', value: (r) => DO_STATUS_TH[r.status] ?? r.status },
    { header: 'ส่งถึง', value: (r) => r.deliveredOn },
    { header: 'ค้างวางบิล (วัน)', value: (r) => r.daysSinceDelivery },
  ];
  if (sell)
    cols.push({
      header: 'มูลค่า (ก่อน VAT)',
      value: (r) => num(r.sellAmount),
      price: 'sell',
      money: true,
      raw: (r) => r.sellAmount,
    });
  // D-71 ธง "ร่างค้างเกิน N วัน" — ท้ายตาราง เฉพาะเมื่อสั่งด้วย includeStaleDrafts=true (review L4) · ร่างยังไม่มีเลขที่
  // จึงระบุด้วยวันที่สร้างร่าง (ลูกค้าของร่าง = ลูกค้าของ DO ในคอลัมน์ "ลูกค้า")
  if (staleDrafts)
    cols.push(
      { header: 'ร่างใบแจ้งหนี้ (วันที่สร้าง)', value: (r) => r.draftInvoice?.createdOn ?? null },
      { header: 'วันที่เข้าร่าง', value: (r) => r.draftInvoice?.addedOn ?? null },
      { header: 'อยู่ในร่าง (วัน)', value: (r) => r.draftInvoice?.ageDays ?? null },
    );
  return cols;
}

export type AgingExportRow = AgingCustomerDto & { id: string };

export function agingExportColumns(sell: boolean): ExportColumn<AgingExportRow>[] {
  const cols: ExportColumn<AgingExportRow>[] = [
    { header: 'รหัสลูกค้า', value: (r) => r.customer.code },
    { header: 'ลูกค้า', value: (r) => r.customer.legalName },
    { header: 'ใบค้างรับ', value: (r) => r.count },
  ];
  AGING_BUCKETS.forEach((b, i) =>
    cols.push(
      sell
        ? {
            header: BUCKET_TH[b],
            value: (r) => num(r.buckets[i]?.sellOutstanding),
            price: 'sell',
            money: true,
            raw: (r) => r.buckets[i]?.sellOutstanding,
          }
        : { header: `${BUCKET_TH[b]} (ใบ)`, value: (r) => r.buckets[i]?.count ?? 0 },
    ),
  );
  if (sell)
    cols.push({
      header: 'รวม',
      value: (r) => num(r.sellOutstanding),
      price: 'sell',
      money: true,
      raw: (r) => r.sellOutstanding,
    });
  return cols;
}
