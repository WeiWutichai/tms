import { describe, expect, it } from 'vitest';
import { BILL_TILES } from '../dashboard/billCards';
import { PAY_TAB_QUERY, PAY_TABS, PAY_URL_TABS } from './payTabs';

describe('หน้ารับชำระ: มุมมอง "ครบกำหนด" (D-81 · D68-94)', () => {
  it('การ์ด "ครบกำหนด" ของ Dashboard บิล → /pay?tab=due = receivable=due (ชุดเดียวกับ summary.due)', () => {
    const tile = BILL_TILES.find((x) => x.key === 'due')!;
    expect(tile.label).toBe('dash.bill.due');
    expect(tile.link).toBe('/pay?tab=due');
    expect(PAY_URL_TABS).toContain('due');
    expect(PAY_TAB_QUERY.due).toEqual({ receivable: 'due' });
  });
  it('แท็บที่แสดงคงตามต้นแบบ (ไม่เพิ่มแท็บ "ครบกำหนด")', () => {
    expect([...PAY_TABS]).toEqual(['all', 'open', 'over', 'part', 'paid']);
    expect(PAY_TAB_QUERY.over).toEqual({ receivable: 'overdue' });
  });
});
