/**
 * หมายเหตุ: หน้าเว็บ import `@tms/domain` ไม่ได้ (dist เป็น CommonJS — vite dev โหลดไม่ขึ้น หน้าว่าง)
 * → VAT ท้ายตารางคิดด้วยกติกาเดียวกับ `computeDocumentTax` (ฐาน VAT 7% รวมทั้งชุด × 7% ปัดครึ่งขึ้นครั้งเดียว)
 * — test `billing.test.ts` เทียบผลกับ computeDocumentTax ตัวจริง · ยอดของร่างจริงคิดที่ API
 */
type Satang = bigint;
function satangFromDecimal(v: string): Satang {
  const neg = v.startsWith('-');
  const [w = '0', f = ''] = v.replace('-', '').split('.');
  const x = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -x : x;
}
function decimalFromSatang(v: Satang): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
}
const sumSatang = (xs: Satang[]) => xs.reduce((a, b) => a + b, 0n);
/** round_half_up(base × 7 / 100) — เศษ .5 ปัดออกจากศูนย์ (แบบ mulRateHalfUp) */
export function vat7(base: Satang): Satang {
  const n = base * 7n;
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = a / 100n + ((a % 100n) * 2n >= 100n ? 1n : 0n);
  return neg ? -q : q;
}
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
 * ฐานที่ไม่ใช่ยกเว้น/7% (อัตราศูนย์) รวมในยอดสุทธิ
 */
export function selectionTotals(rows: readonly QueueAmounts[]) {
  const freight = sumSatang(rows.map((r) => s(r.sellFreightAmount)));
  const service = sumSatang(rows.map((r) => s(r.sellServiceAmount)));
  const exempt = sumSatang(rows.map((r) => s(r.sellExemptBase)));
  const vatable = sumSatang(rows.map((r) => s(r.sellVatableBase)));
  const other = sumSatang(rows.map((r) => s(r.sellTotal))) - exempt - vatable;
  const vat = vat7(vatable);
  return {
    freight: decimalFromSatang(freight),
    service: decimalFromSatang(service),
    vat: decimalFromSatang(vat),
    net: decimalFromSatang(exempt + vatable + other + vat),
  };
}
