import { decimalFromSatang, satangFromDecimal, sumSatang } from './money';

/**
 * รูปบรรทัดบนใบแจ้งหนี้ (ST5-T07; docs/04 F3 "Draft (แก้ได้) — เพิ่ม/ลด/รวม/แยกบรรทัด (Group / Merge / Single)")
 * [DECISION spec/12 §3 — ST5-T07]: บรรทัดในฐานข้อมูลคง "1 บรรทัด = 1 บรรทัดรายได้ของ DO" เสมอ (ตัวกันวางบิลซ้ำต่อ DO / ต่อบรรทัดรายได้
 * อยู่ที่ระดับนี้ — docs/01 §7.2) · การรวม/แยกเป็น **รูปที่แสดงบนเอกสาร** (PDF/หน้าจอ) คำนวณจากบรรทัดจริงด้วยฟังก์ชันนี้:
 * - `SINGLE` บรรทัดละรายการ
 * - `GROUP`  รวมรายการที่เหมือนกัน (รายการบริการ + คำอธิบาย + หน่วย + ราคาต่อหน่วย เดียวกัน) → จำนวนรวม
 * - `MERGE`  รวมตามรายการบริการ (ราคาต่อหน่วยต่างกันได้ → ไม่แสดงราคาต่อหน่วย)
 * - กลุ่มที่ผู้ใช้รวมเอง (`printGroup`) มาก่อนรูปของใบ · "แยกบรรทัด" = ล้างกลุ่ม
 * ทุกแบบ **ไม่รวมข้ามประเภท VAT หรืออัตราหัก ณ ที่จ่าย** (ค่าขนส่งยกเว้น VAT กับบริการประกอบ 7% ต้องแยกบรรทัด — spec/05 T2)
 * ยอดภาษีคิดจากบรรทัดจริง (computeDocumentTax) ไม่ใช่จากบรรทัดที่รวม — รูปบรรทัดไม่เปลี่ยนยอดเงิน
 */
export const INVOICE_LINE_MODES = ['SINGLE', 'GROUP', 'MERGE'] as const;
export type InvoiceLineMode = (typeof INVOICE_LINE_MODES)[number];

export interface InvoiceDetailLine {
  id: string;
  lineNo: number;
  serviceItemId: string;
  description: string;
  /** ทศนิยม ≤ 4 ตำแหน่ง */
  quantity: string;
  unitLabel: string;
  /** ราคาต่อหน่วย (บาท ทศนิยม 2) */
  unitPrice: string;
  /** ยอดหลังหักส่วนลด (บาท ทศนิยม 2) */
  amount: string;
  discount: string;
  vatType: string;
  whtRate: string;
  printGroup: number | null;
  deliveryOrderNo?: string | null;
}

export interface InvoicePrintLine {
  /** ลำดับบนเอกสาร (1…) */
  no: number;
  /** บรรทัดจริงที่รวมอยู่ (เรียงตามเลขบรรทัด) */
  lineIds: string[];
  description: string;
  /** null = หน่วยต่างกัน (แสดงเฉพาะยอด) */
  quantity: string | null;
  unitLabel: string | null;
  /** null = ราคาต่อหน่วยต่างกัน/หน่วยต่างกัน */
  unitPrice: string | null;
  discount: string;
  amount: string;
  vatType: string;
  whtRate: string;
  /** เลข DO ที่อยู่ในบรรทัด (ไม่ซ้ำ ตามลำดับ) */
  deliveryOrderNos: string[];
  /** จากกลุ่มที่ผู้ใช้รวมเอง */
  manual: boolean;
}

const QTY_SCALE = 10_000n;
const QTY_RE = /^\d+(\.\d{1,4})?$/;

function qtyUnits(v: string): bigint {
  if (!QTY_RE.test(v)) throw new RangeError(`invalid quantity: ${v}`);
  const [w, f = ''] = v.split('.') as [string, string?];
  return BigInt(w) * QTY_SCALE + BigInt((f + '0000').slice(0, 4));
}

/** 12345000n → "1234.5" (ตัดศูนย์ท้าย) */
function qtyString(units: bigint): string {
  const w = units / QTY_SCALE;
  const f = (units % QTY_SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
}

const taxKey = (l: InvoiceDetailLine) => `${l.vatType}|${Number(l.whtRate).toFixed(2)}`;

function groupKey(l: InvoiceDetailLine, mode: InvoiceLineMode): string {
  if (l.printGroup !== null) return `p:${l.printGroup}|${taxKey(l)}`;
  if (mode === 'GROUP')
    return `g:${l.serviceItemId}|${l.description}|${l.unitLabel}|${l.unitPrice}|${taxKey(l)}`;
  if (mode === 'MERGE') return `m:${l.serviceItemId}|${taxKey(l)}`;
  return `l:${l.id}`;
}

/** บรรทัดบนเอกสารจากบรรทัดจริงที่ยังใช้ — ลำดับตามบรรทัดแรกของแต่ละกลุ่ม */
export function invoicePrintLines(
  lines: readonly InvoiceDetailLine[],
  mode: InvoiceLineMode,
): InvoicePrintLine[] {
  const sorted = [...lines].sort((a, b) => a.lineNo - b.lineNo);
  const groups = new Map<string, InvoiceDetailLine[]>();
  for (const l of sorted) {
    const k = groupKey(l, mode);
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  return [...groups.values()].map((g, i) => {
    const first = g[0]!;
    const sameUnit = g.every((l) => l.unitLabel === first.unitLabel);
    const samePrice = sameUnit && g.every((l) => l.unitPrice === first.unitPrice);
    const dos: string[] = [];
    for (const l of g)
      if (l.deliveryOrderNo && !dos.includes(l.deliveryOrderNo)) dos.push(l.deliveryOrderNo);
    return {
      no: i + 1,
      lineIds: g.map((l) => l.id),
      description: first.description,
      quantity: sameUnit ? qtyString(g.reduce((a, l) => a + qtyUnits(l.quantity), 0n)) : null,
      unitLabel: sameUnit ? first.unitLabel : null,
      unitPrice: samePrice ? first.unitPrice : null,
      discount: decimalFromSatang(sumSatang(g.map((l) => satangFromDecimal(l.discount)))),
      amount: decimalFromSatang(sumSatang(g.map((l) => satangFromDecimal(l.amount)))),
      vatType: first.vatType,
      whtRate: first.whtRate,
      deliveryOrderNos: dos,
      manual: first.printGroup !== null,
    };
  });
}

/** บรรทัดที่จะรวมเอง (Merge) ต้องประเภท VAT + อัตราหัก ณ ที่จ่ายเดียวกัน — คืน false เมื่อปนกัน */
export function canMergeInvoiceLines(
  lines: readonly Pick<InvoiceDetailLine, 'vatType' | 'whtRate'>[],
): boolean {
  if (lines.length < 2) return false;
  const k = (l: Pick<InvoiceDetailLine, 'vatType' | 'whtRate'>) =>
    `${l.vatType}|${Number(l.whtRate).toFixed(2)}`;
  return lines.every((l) => k(l) === k(lines[0]!));
}
