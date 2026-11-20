import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decimalFromSatang as s,
  mulRateHalfUp,
  satangFromDecimal as d,
  type Satang,
} from './money';
import {
  computeDocumentTax,
  toCalcVatType,
  toCalcWhtRate,
  type ServiceItemVatType,
  type TaxCalcOptions,
  type WhtMinimumBasis,
} from './tax';

/**
 * ST5-T02 golden test ภาษี (plan/03 §4) — **ร่าง — ยังไม่ผ่านนักบัญชี** (D-54: ยอดแสดง/ประมาณการ)
 * ข้อมูลอยู่ในไฟล์ `golden/tax-calc.golden.json` (ไม่ใช่โค้ด) — คำตอบนักบัญชีเปลี่ยนกฎ → แก้ไฟล์ golden ก่อน แล้วค่อยแก้โค้ด
 * expected คำนวณแยกด้วย Decimal ROUND_HALF_UP (สคริปต์นอก repo) + ตรวจกับ "วิธีของ AccountSystem" ด้านล่าง
 */
interface GoldenLine {
  amount: string;
  vatType: ServiceItemVatType;
  whtRate: string;
  kind?: 'CHARGE' | 'DEDUCTION';
}
interface GoldenCase {
  id: string;
  title: string;
  lines: GoldenLine[];
  options: {
    whtMinimum?: string;
    whtMinimumBasis?: WhtMinimumBasis;
    whtContractAmount?: string;
  };
  accountSystem: 'MATCH' | 'DIFF_MINIMUM' | 'N/A';
  pending?: string[];
  expected: {
    exemptBase: string;
    vatableBase: string;
    zeroRatedBase: string;
    vat: string;
    grandTotal: string;
    wht: string;
    deductions: string;
    netPayable: string;
    whtBelowMinimum: boolean;
    whtMinimumTested: string | null;
    whtByRate: { ratePercent: string; base: string; wht: string }[];
    lineVat: string[];
    lineWht: string[];
    accountSystemWht?: string;
  };
}
interface GoldenFile {
  status: string;
  label: string;
  cases: GoldenCase[];
}

const golden = JSON.parse(
  readFileSync(join(__dirname, 'golden', 'tax-calc.golden.json'), 'utf8'),
) as GoldenFile;

function run(c: GoldenCase) {
  const opts: TaxCalcOptions = {};
  if (c.options.whtMinimum !== undefined) opts.whtMinimum = d(c.options.whtMinimum);
  if (c.options.whtMinimumBasis !== undefined) opts.whtMinimumBasis = c.options.whtMinimumBasis;
  if (c.options.whtContractAmount !== undefined)
    opts.whtContractAmount = d(c.options.whtContractAmount);
  return computeDocumentTax(
    c.lines.map((l) => ({
      amount: d(l.amount),
      vatType: toCalcVatType(l.vatType),
      whtRate: toCalcWhtRate(l.whtRate),
      ...(l.kind ? { kind: l.kind } : {}),
    })),
    opts,
  );
}

/**
 * วิธีของ AccountSystem (อ่านอย่างเดียว 20 พ.ย. 2569 — commit 1e295e8):
 * VAT = round_half_up(Σ ฐานบรรทัด VAT × 0.07) ครั้งเดียวต่อเอกสาร (`packages/ledger/src/sales.ts` docTotals)
 * WHT = Σ ต่อประเภทเงินได้ round_half_up(Σ ฐานก่อน VAT ของประเภทนั้น × อัตรา) (`apps/accounting-web/app/purchase/_lib/wht.ts`
 * expectedWht, `packages/db/src/purchase.ts` whtForBill → `packages/tax-th` whtOnPayment) — ไม่มีขั้นต่ำ 1,000
 * บรรทัดหัก (หักกลบตอนจ่าย) ไม่อยู่ในฐาน — เขียนแยกจาก tax.ts (ตัวเลขจำนวนเต็มหมื่นส่วน) เพื่อเทียบอิสระ
 */
function accountSystemReference(lines: GoldenLine[]): {
  vat: Satang;
  grandTotal: Satang;
  wht: Satang;
} {
  const halfUp = (num: bigint, den: bigint) => {
    const neg = num < 0n;
    const a = neg ? -num : num;
    const r = (a * 2n + den) / (den * 2n);
    return neg ? -r : r;
  };
  const charges = lines.filter((l) => l.kind !== 'DEDUCTION');
  let base = 0n;
  let vatBase = 0n;
  const byRate = new Map<string, bigint>();
  for (const l of charges) {
    const a = d(l.amount);
    base += a;
    if (l.vatType === 'VAT_7') vatBase += a;
    const pct = d(l.whtRate); // เปอร์เซ็นต์ × 100 (สตางค์ของเปอร์เซ็นต์)
    if (pct !== 0n) byRate.set(String(pct), (byRate.get(String(pct)) ?? 0n) + a);
  }
  const vat = halfUp(vatBase * 7n, 100n);
  let wht = 0n;
  for (const [pct, b] of byRate) wht += halfUp(b * BigInt(pct), 10_000n);
  return { vat, grandTotal: base + vat, wht };
}

describe('ST5-T02 golden ภาษี — ร่าง ยังไม่ผ่านนักบัญชี', () => {
  it('ไฟล์ golden ติดธงร่าง และมีอย่างน้อย 30 เคส ครอบคลุมหมวดตามเกณฑ์', () => {
    expect(golden.status).toBe('DRAFT_UNREVIEWED');
    expect(golden.label).toBe('ร่าง — ยังไม่ผ่านนักบัญชี');
    expect(golden.cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(golden.cases.map((c) => c.id)).size).toBe(golden.cases.length);
    const has = (p: (c: GoldenCase) => boolean) => golden.cases.some(p);
    const rates = (c: GoldenCase) => c.lines.map((l) => l.whtRate);
    expect(has((c) => rates(c).includes('1.00'))).toBe(true); // 1%
    expect(has((c) => rates(c).includes('3.00'))).toBe(true); // 3%
    expect(has((c) => c.lines.some((l) => l.vatType === 'VAT_7'))).toBe(true); // VAT 7%
    expect(
      has((c) => c.lines.every((l) => l.vatType === 'EXEMPT_TRANSPORT') && c.lines.length > 0),
    ).toBe(true); // ยกเว้น
    expect(has((c) => new Set(c.lines.map((l) => l.vatType)).size > 1)).toBe(true); // ปน
    expect(has((c) => c.expected.whtBelowMinimum)).toBe(true); // ต่ำกว่าขั้นต่ำ
    expect(has((c) => c.lines.some((l) => l.kind === 'DEDUCTION'))).toBe(true); // มีบรรทัดหัก
    expect(has((c) => /ปัด/.test(c.title))).toBe(true); // ปัดเศษ
  });

  for (const c of golden.cases) {
    it(`${c.id} ${c.title}`, () => {
      const r = run(c);
      const e = c.expected;
      expect({
        exemptBase: s(r.exemptBase),
        vatableBase: s(r.vatableBase),
        zeroRatedBase: s(r.zeroRatedBase),
        vat: s(r.vat),
        grandTotal: s(r.grandTotal),
        wht: s(r.wht),
        deductions: s(r.deductions),
        netPayable: s(r.netPayable),
        whtBelowMinimum: r.whtBelowMinimum,
        whtMinimumTested: r.whtMinimumTested === null ? null : s(r.whtMinimumTested),
        whtByRate: r.whtByRate.map((g) => ({
          ratePercent: s(mulRateHalfUp(10_000n, g.rate)), // สัดส่วน → เปอร์เซ็นต์ 2 ตำแหน่ง (ไม่ใช้ float)
          base: s(g.base),
          wht: s(g.wht),
        })),
        lineVat: r.lines.map((l) => s(l.vat)),
        lineWht: r.lines.map((l) => s(l.wht)),
      }).toEqual(omit(e, 'accountSystemWht'));
      // ผลรวมรายบรรทัด = ยอดใบเสมอ
      expect(s(r.lines.reduce((a, l) => a + l.vat, 0n))).toBe(e.vat);
      expect(s(r.lines.reduce((a, l) => a + l.wht, 0n))).toBe(e.wht);

      // เทียบวิธีของ AccountSystem
      if (c.accountSystem === 'N/A') return;
      const as = accountSystemReference(c.lines);
      expect(s(as.vat)).toBe(e.vat);
      expect(s(as.grandTotal)).toBe(e.grandTotal);
      if (c.accountSystem === 'MATCH') expect(s(as.wht)).toBe(e.wht);
      else {
        expect(e.whtBelowMinimum).toBe(true);
        expect(s(as.wht)).toBe(e.accountSystemWht);
        expect(e.accountSystemWht).not.toBe(e.wht);
      }
    });
  }
});

function omit<T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> {
  const { [k]: _drop, ...rest } = o;
  return rest;
}
