import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '@tms/domain';
import { findSellFields, PriceField, redactPrices } from './price-fields';

class LineDto {
  description!: string;
  @PriceField('sell') sellUnitPrice!: string;
  @PriceField('sell') sellAmount!: string;
  @PriceField('buy') buyAmount!: string;
  qty!: number;
}
void LineDto;

const doc = {
  id: 'trp_1',
  sellAmount: '1000.00',
  buyAmount: '800.00',
  lines: [
    {
      description: 'ค่าขนส่ง',
      qty: 1,
      sellUnitPrice: '1000.00',
      sellAmount: '1000.00',
      buyAmount: '800.00',
    },
  ],
  meta: { at: new Date('2026-11-11T00:00:00Z') },
};

describe('price field permission (ST1-T13)', () => {
  it('Dispatcher (ค่าเริ่มต้น A3) ไม่เห็นราคาขายทุกชั้น แต่เห็นราคาซื้อ', () => {
    const out = redactPrices(doc, SYSTEM_ROLES.dispatcher.permissions) as typeof doc;
    expect(JSON.stringify(out)).not.toMatch(/sell/);
    expect(out.buyAmount).toBe('800.00');
    expect(out.lines[0]).toEqual({ description: 'ค่าขนส่ง', qty: 1, buyAmount: '800.00' });
    expect(out.meta.at).toBeInstanceOf(Date);
  });
  it('Invoicer เห็นทั้งราคาขายและราคาซื้อ', () => {
    expect(redactPrices(doc, SYSTEM_ROLES.invoicer.permissions)).toEqual(doc);
  });
  it('Viewer ไม่เห็นทั้งสองแบบ ("เลือกได้" = ค่าเริ่มต้นไม่ให้)', () => {
    expect(JSON.stringify(redactPrices(doc, SYSTEM_ROLES.viewer.permissions))).not.toMatch(
      /sell|buy/,
    );
  });
  it('principal ภายนอก/ไม่มี scope (ลิงก์รถร่วม) ไม่มีทางเห็นราคาขาย', () => {
    expect(JSON.stringify(redactPrices(doc, ['driver']))).not.toMatch(/sell/);
    expect(JSON.stringify(redactPrices(doc, []))).not.toMatch(/sell|buy/);
  });
  it('ลงทะเบียนชื่อเดียวเป็นทั้ง sell และ buy ไม่ได้', () => {
    expect(() => {
      class Bad {
        @PriceField('buy') sellAmount!: string;
      }
      void Bad;
    }).toThrow(/both sell and buy/);
  });
  it('ไม่แตะ object ที่ไม่ใช่ plain (Decimal/stream/class) และไม่ล้มกับ circular', () => {
    class Money {
      constructor(readonly v: string) {}
    }
    const m = new Money('12.50');
    const circ: Record<string, unknown> = { id: 'x', sellAmount: '1.00' };
    circ.self = circ;
    const out = redactPrices({ m, at: new Date(0), circ }, []) as {
      m: Money;
      circ: Record<string, unknown>;
    };
    expect(out.m).toBe(m);
    expect(out.circ.sellAmount).toBeUndefined();
    expect(out.circ.self).toBe(out.circ);
  });
  it('principal ภายนอก (ลิงก์รถร่วม/คนขับ) ไม่เห็นราคาขายแม้ scope จะมี (ห้ามเด็ดขาด — A3)', () => {
    const out = redactPrices(doc, ['*'], 'link') as typeof doc;
    expect(JSON.stringify(out)).not.toMatch(/sell/);
    expect(out.buyAmount).toBe('800.00');
    expect(redactPrices(doc, ['*'], 'user')).toEqual(doc);
  });
  it('findSellFields หา field ราคาขายใน body ทุกชั้น', () => {
    expect(findSellFields({ lines: [{ sellAmount: '1' }], buyAmount: '2' })).toEqual([
      'lines[0].sellAmount',
    ]);
  });
});
