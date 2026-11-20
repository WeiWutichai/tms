import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decimalFromSatang as s, satangFromDecimal as d, type Satang } from './money';
import {
  estimateSettlementWht,
  SETTLEMENT_WHT_REVIEW,
  whtFormOf,
  type SettlementLineKind,
} from './settlement-wht';

/**
 * ST6-T08 golden — หัก ณ ที่จ่ายประมาณการบนใบสำคัญจ่ายรถร่วม · **ร่าง — ยังไม่ผ่านนักบัญชี** (D-54/D-58)
 * expected คำนวณแยกด้วย Python Decimal ROUND_HALF_UP (สคริปต์นอก repo) + เทียบ "วิธีของ AccountSystem" อิสระด้านล่าง
 */
interface GoldenLine {
  lineType: SettlementLineKind;
  amount: string;
  whtRate: string | null;
}
interface GoldenCase {
  id: string;
  title: string;
  entityType: string;
  carrierWhtRateDefault: string;
  whtMinimumAmount: number;
  lines: GoldenLine[];
  accountSystem: 'MATCH' | 'DIFF_MINIMUM';
  expected: {
    form: string;
    gross: string;
    deductions: string;
    whtBase: string;
    wht: string;
    netAfterWht: string;
    belowMinimum: boolean;
    byRate: { ratePercent: string; base: string; wht: string }[];
    lineRate: (string | null)[];
    lineRateSource: (string | null)[];
    lineWht: string[];
    accountSystemWht?: string;
  };
}
const golden = JSON.parse(
  readFileSync(join(__dirname, 'golden', 'settlement-wht.golden.json'), 'utf8'),
) as { status: string; label: string; cases: GoldenCase[] };

/**
 * **แบบจำลอง** วิธีของ AccountSystem สำหรับ AP — ไม่ได้เรียกระบบจริง; AccountSystem จัดกลุ่มตามประเภทเงินได้ ส่วนแบบจำลองนี้ (และ TMS)
 * จัดกลุ่มตามอัตรา (ถือว่า 1 อัตรา = 1 ประเภทเงินได้) [OPEN — นักบัญชี #62 ข้อ ง] (อ่านอย่างเดียว — `apps/accounting-web/app/purchase/_lib/wht.ts` expectedWht,
 * `packages/db/src/purchase.ts` whtForBill): WHT = Σ ต่ออัตรา round_half_up(Σ ฐานบรรทัดบิล × อัตรา) · ไม่มีขั้นต่ำ ·
 * รายการหักกลบตอนจ่ายไม่อยู่ในฐาน — เขียนด้วยจำนวนเต็มแยกจาก tax.ts เพื่อเทียบอิสระ
 */
function accountSystemWht(c: GoldenCase): Satang {
  const halfUp = (num: bigint, den: bigint) => {
    const neg = num < 0n;
    const a = neg ? -num : num;
    const r = (a * 2n + den) / (den * 2n);
    return neg ? -r : r;
  };
  const byRate = new Map<bigint, bigint>();
  for (const l of c.lines) {
    if (l.lineType === 'DEDUCTION') continue;
    const pct = d(l.whtRate ?? c.carrierWhtRateDefault);
    if (pct !== 0n) byRate.set(pct, (byRate.get(pct) ?? 0n) + d(l.amount));
  }
  let wht = 0n;
  for (const [pct, b] of byRate) wht += halfUp(b * pct, 10_000n);
  return wht;
}

describe('ST6-T08 golden หัก ณ ที่จ่ายใบสำคัญจ่าย — ร่าง ยังไม่ผ่านนักบัญชี', () => {
  it('ไฟล์ golden ติดธงร่าง ≥ 15 เคส ครอบคลุม 1% / 3% / ปน / ต่ำกว่าขั้นต่ำ / มีบรรทัดหัก', () => {
    expect(golden.status).toBe('DRAFT_UNREVIEWED');
    expect(golden.label).toBe('ร่าง — ยังไม่ผ่านนักบัญชี');
    expect(golden.cases.length).toBeGreaterThanOrEqual(15);
    expect(new Set(golden.cases.map((c) => c.id)).size).toBe(golden.cases.length);
    const rates = (c: GoldenCase) =>
      new Set(c.expected.lineRate.filter((r) => r !== null && r !== '0.00'));
    const has = (p: (c: GoldenCase) => boolean) => golden.cases.some(p);
    expect(has((c) => rates(c).size === 1 && rates(c).has('1.00'))).toBe(true);
    expect(has((c) => rates(c).size === 1 && rates(c).has('3.00'))).toBe(true);
    expect(has((c) => rates(c).size > 1)).toBe(true);
    expect(has((c) => c.expected.belowMinimum)).toBe(true);
    expect(has((c) => c.lines.some((l) => l.lineType === 'DEDUCTION'))).toBe(true);
    expect(has((c) => c.expected.form === 'PND3')).toBe(true);
    expect(has((c) => c.expected.form === 'PND53')).toBe(true);
  });

  for (const c of golden.cases) {
    it(`${c.id} ${c.title}`, () => {
      const r = estimateSettlementWht({
        lines: c.lines.map((l) => ({ ...l, amount: d(l.amount) })),
        carrierWhtRateDefault: c.carrierWhtRateDefault,
        entityType: c.entityType,
        whtMinimumAmount: c.whtMinimumAmount,
      });
      expect(r.review).toBe(SETTLEMENT_WHT_REVIEW);
      expect({
        form: r.form,
        gross: s(r.gross),
        deductions: s(r.deductions),
        whtBase: s(r.whtBase),
        wht: s(r.wht),
        netAfterWht: s(r.netAfterWht),
        belowMinimum: r.belowMinimum,
        byRate: r.byRate.map((g) => ({
          ratePercent: g.ratePercent,
          base: s(g.base),
          wht: s(g.wht),
        })),
        lineRate: r.lines.map((l) => l.ratePercent),
        lineRateSource: r.lines.map((l) => l.rateSource),
        lineWht: r.lines.map((l) => s(l.wht)),
      }).toEqual((({ accountSystemWht: _x, ...e }) => e)(c.expected));
      expect(s(r.minimum)).toBe(s(BigInt(c.whtMinimumAmount) * 100n));
      expect(s(r.lines.reduce((a, l) => a + l.wht, 0n))).toBe(c.expected.wht);

      const as = s(accountSystemWht(c));
      if (c.accountSystem === 'MATCH') expect(as).toBe(c.expected.wht);
      else {
        expect(c.expected.belowMinimum).toBe(true);
        expect(as).toBe(c.expected.accountSystemWht);
        expect(as).not.toBe(c.expected.wht);
      }
    });
  }
});

describe('estimateSettlementWht — ขอบเขต', () => {
  const base = { carrierWhtRateDefault: '1.00', entityType: 'JURISTIC', whtMinimumAmount: 0 };
  it('ใบว่าง = 0 ทุกยอด', () => {
    const r = estimateSettlementWht({ ...base, lines: [] });
    expect([r.gross, r.wht, r.netAfterWht, r.deductions]).toEqual([0n, 0n, 0n, 0n]);
    expect(r.belowMinimum).toBe(false);
  });
  it('บรรทัดหักต้องไม่เป็นบวก', () => {
    expect(() =>
      estimateSettlementWht({
        ...base,
        lines: [{ lineType: 'DEDUCTION', amount: 100n, whtRate: null }],
      }),
    ).toThrow(RangeError);
  });
  it('อัตราเปอร์เซ็นต์ผิดรูป = RangeError (ไม่ส่งสัดส่วนตรง ๆ)', () => {
    expect(() =>
      estimateSettlementWht({
        ...base,
        lines: [{ lineType: 'FREIGHT', amount: 100n, whtRate: 'abc' }],
      }),
    ).toThrow(RangeError);
  });
  it('แบบยื่น: บุคคล ภ.ง.ด.3 · นิติบุคคล ภ.ง.ด.53 · อื่น = RangeError', () => {
    expect(whtFormOf('INDIVIDUAL')).toBe('PND3');
    expect(whtFormOf('JURISTIC')).toBe('PND53');
    expect(() => whtFormOf('X')).toThrow(RangeError);
  });
});
