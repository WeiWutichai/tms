import {
  computeDocumentTax,
  decimalFromSatang,
  satangFromDecimal,
  sumSatang,
  taxOptionsFromSettings,
} from '@tms/domain';
import type { T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { addDays } from '../rate-cards/rateFormat';

/**
 * หน้า "วางบิลและใบแจ้งหนี้" (ST5-T07) — ตัวช่วยที่ไม่ขึ้นกับ React
 * ช่วงวันที่ส่งของขั้น "เลือกลูกค้าและงวด" ตามต้นแบบ vBill ranges: งวดครึ่งเดือน (16 เดือนก่อน – วันนี้) · เดือนก่อน · 7 วันล่าสุด
 */
export interface BillRange {
  from: string;
  to: string;
}

export function billRanges(today: string): BillRange[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const prevLast = addDays(first, -1);
  const prevFirst = `${prevLast.slice(0, 7)}-01`;
  return [
    { from: `${prevLast.slice(0, 7)}-16`, to: today },
    { from: prevFirst, to: prevLast },
    { from: addDays(today, -7), to: today },
  ];
}

export interface QueueAmounts {
  sellFreightAmount?: string;
  sellServiceAmount?: string;
  sellExemptBase?: string;
  sellVatableBase?: string;
  sellTotal?: string;
}

const s = (v: string | undefined) => satangFromDecimal(v ?? '0.00');

/**
 * ยอดท้ายตารางของ DO ที่ติ๊ก — VAT ประมาณการด้วย computeDocumentTax ตัวเดียวกับ API (D-54: ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี)
 * ฐานที่ไม่ใช่ยกเว้น/7% (อัตราศูนย์) รวมในยอดสุทธิ · ยอดของร่างจริงคิดที่ API
 */
export function selectionTotals(rows: readonly QueueAmounts[]) {
  const freight = sumSatang(rows.map((r) => s(r.sellFreightAmount)));
  const service = sumSatang(rows.map((r) => s(r.sellServiceAmount)));
  const exempt = sumSatang(rows.map((r) => s(r.sellExemptBase)));
  const vatable = sumSatang(rows.map((r) => s(r.sellVatableBase)));
  const other = sumSatang(rows.map((r) => s(r.sellTotal))) - exempt - vatable;
  const tax = computeDocumentTax(
    [
      { amount: exempt, vatType: 'EXEMPT', whtRate: '0' },
      { amount: vatable, vatType: 'VAT7', whtRate: '0' },
      { amount: other, vatType: 'ZERO', whtRate: '0' },
    ],
    taxOptionsFromSettings({ whtMinimumAmount: 0 }),
  );
  return {
    freight: decimalFromSatang(freight),
    service: decimalFromSatang(service),
    vat: decimalFromSatang(tax.vat),
    net: decimalFromSatang(tax.grandTotal),
  };
}

/**
 * สถานะที่แสดง (ต้นแบบ invSt): ใบค้างรับที่เลยวันครบกำหนด (เวลาไทย) = "เกินกำหนด" — คำนวณตอนแสดงเท่านั้น
 * (สถานะ OVERDUE ในฐานข้อมูล + job = ST5-T18)
 */
export function invoiceDisplayStatus(
  x: { status: string; dueDate: string | null },
  today: string,
): string {
  if ((x.status === 'ISSUED' || x.status === 'PARTIALLY_PAID') && x.dueDate && x.dueDate < today)
    return 'OVERDUE';
  return x.status;
}

/** จำนวนวันที่เกินกำหนด (0 = ยังไม่เกิน / ไม่ค้าง) */
export function overdueDays(x: { status: string; dueDate: string | null }, today: string): number {
  if (invoiceDisplayStatus(x, today) !== 'OVERDUE') return 0;
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${x.dueDate}T00:00:00Z`)) / 86_400_000,
  );
}

/** วิธีรับเงิน → ป้ายไทย (ต้นแบบ: โอนเงิน / เช็ค / เงินสด / หักกลบลบหนี้) */
export function methodLabel(t: T, m: string): string {
  return t(`pay.m.${m}` as MessageKey);
}
