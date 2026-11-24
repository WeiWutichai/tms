import { describe, expect, it } from 'vitest';
import { th } from '../../i18n/th';
import { docLabel, hoursLeft, subQueryStatus, subStatusKey, SUB_STATUSES, SUB_TABS } from './sub';

/** หน้า "จ่ายงานรถร่วม" (/sub — ต้นแบบ TMS v4 specSub): แท็บ/การ์ด → ตัวกรองสถานะของ API · ป้ายสถานะ · "เหลือ N ชม." · เลข SO / DO */
describe('sub page helpers', () => {
  it('แท็บต้นแบบ ทั้งหมด/รอตอบ/รับงาน/ปฏิเสธ/หมดเวลา + ป้ายไทยตรงต้นแบบ', () => {
    expect(SUB_TABS).toEqual(['all', 'OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED']);
    expect(SUB_STATUSES.map((s) => th[subStatusKey(s)])).toEqual([
      'รอตอบ',
      'รับงาน',
      'ปฏิเสธ',
      'หมดเวลา',
    ]);
    expect(th['subl.kpi.bad']).toBe('ปฏิเสธ / หมดเวลา');
    expect(th['subl.kpi.cost']).toBe('ต้นทุนรถร่วมเดือนนี้ (฿)');
  });

  it('ตัวกรองสถานะ = แท็บ/การ์ด ∩ คอลัมน์ "สถานะ" · ไม่มีทางตรง = null (ไม่เรียก API)', () => {
    expect(subQueryStatus('all', '')).toBeUndefined();
    expect(subQueryStatus('OFFERED', '')).toBe('OFFERED');
    expect(subQueryStatus('bad', '')).toBe('REJECTED,EXPIRED');
    expect(subQueryStatus('bad', 'EXPIRED')).toBe('EXPIRED');
    expect(subQueryStatus('bad', 'OFFERED')).toBeNull();
    expect(subQueryStatus('all', 'ACCEPTED')).toBe('ACCEPTED');
    expect(subQueryStatus('ACCEPTED', 'REJECTED')).toBeNull();
  });

  it('หมดเวลาใน: ชั่วโมงปัดลง · < 1 ชม. = นาที · หมดแล้ว/ไม่มี = null', () => {
    const now = Date.parse('2026-11-24T03:00:00Z');
    expect(hoursLeft('2026-11-25T02:30:00Z', now)).toEqual({ unit: 'h', n: 23 });
    expect(hoursLeft('2026-11-24T03:20:00Z', now)).toEqual({ unit: 'm', n: 20 });
    expect(hoursLeft('2026-11-24T02:00:00Z', now)).toBeNull();
    expect(hoursLeft(null, now)).toBeNull();
  });

  it('เลข SO / DO = DO ใบแรก (+n) · ไม่มี DO = เลขเที่ยว', () => {
    expect(docLabel({ deliveryOrderNos: ['DO-1', 'DO-2', 'DO-3'], tripNo: 'TRP-1' })).toEqual({
      no: 'DO-1',
      more: 2,
    });
    expect(docLabel({ deliveryOrderNos: [], tripNo: 'TRP-1' })).toEqual({ no: 'TRP-1', more: 0 });
  });
});
