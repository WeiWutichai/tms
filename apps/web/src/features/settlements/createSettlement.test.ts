import { describe, expect, it } from 'vitest';
import { draftTotals, tripAmounts } from './CreateSettlementDrawer';
import type { SettlementQueueTrip } from './useSettlements';

const trip = (lines: { costType: string; buyAmount?: string }[], buyTotal?: string) =>
  ({ id: 'trp_1', lines, ...(buyTotal ? { buyTotal } : {}) }) as unknown as SettlementQueueTrip;

/** "สร้างงวดใหม่" (ST6-T03 UI): ยอดค่าเที่ยว/ค่าใช้จ่ายหน้างานของเที่ยว + ยอดรวมฟอร์ม เป็นสตางค์ (ไม่ใช้ float) */
describe('create settlement form', () => {
  it('ค่าเที่ยว = CARRIER_FEE · ค่าใช้จ่ายหน้างาน = บรรทัดอื่น · บรรทัดกลับรายการ (ติดลบ) หักล้าง · ไม่มีสิทธิ์เห็นราคา = 0', () => {
    expect(
      tripAmounts(
        trip([
          { costType: 'CARRIER_FEE', buyAmount: '8000.00' },
          { costType: 'WAITING', buyAmount: '350.50' },
          { costType: 'LABOUR', buyAmount: '0.10' },
          { costType: 'CARRIER_FEE', buyAmount: '-500.00' },
        ]),
      ),
    ).toEqual({ fee: '7500.00', site: '350.60' });
    expect(tripAmounts(trip([{ costType: 'CARRIER_FEE' }]))).toEqual({ fee: '0.00', site: '0.00' });
  });

  it('ยอดซื้อ − รายการหัก = สุทธิก่อนหัก ณ ที่จ่าย (0.1 + 0.2 ไม่เพี้ยน) · ยอดหักที่กรอกผิดไม่นับ', () => {
    const r = draftTotals(
      [trip([], '0.10'), trip([], '0.20'), trip([], '8000.00')],
      [{ amount: '1,000' }, { amount: '0.05' }, { amount: 'abc' }, { amount: '-5' }],
    );
    expect(r).toEqual({ gross: '8000.30', ded: '1000.05', net: '7000.25' });
    expect(draftTotals([], [])).toEqual({ gross: '0.00', ded: '0.00', net: '0.00' });
  });
});
