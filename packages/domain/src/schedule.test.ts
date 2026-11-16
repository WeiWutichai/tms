import { describe, expect, it } from 'vitest';
import { dayCellState, leaveDaysIn, spanCovers, spansOverlap } from './schedule';

describe('ตารางรถ/คนขับรายวัน (ST3-T19)', () => {
  const s = { startsOn: '2026-11-18', endsOn: '2026-11-20' };
  it('ช่วงวันรวมสองปลาย', () => {
    expect(spanCovers(s, '2026-11-18')).toBe(true);
    expect(spanCovers(s, '2026-11-20')).toBe(true);
    expect(spanCovers(s, '2026-11-17')).toBe(false);
    expect(spanCovers(s, '2026-11-21')).toBe(false);
  });
  it('ทับกันเมื่อปลายชนพอดี', () => {
    expect(spansOverlap(s, { startsOn: '2026-11-20', endsOn: '2026-11-22' })).toBe(true);
    expect(spansOverlap(s, { startsOn: '2026-11-21', endsOn: '2026-11-22' })).toBe(false);
  });
  it('วันลาในวันของเที่ยว (ข้ามคืน)', () => {
    expect(leaveDaysIn([s], ['2026-11-17', '2026-11-18', '2026-11-18'])).toEqual(['2026-11-18']);
    expect(leaveDaysIn([], ['2026-11-18'])).toEqual([]);
  });
  it('สถานะช่อง: เที่ยว > ซ่อม > จอด > ลา > ว่าง', () => {
    expect(dayCellState({ trips: 1, vehicleStatus: 'MAINTENANCE', driverOnLeave: true })).toBe('BUSY');
    expect(dayCellState({ trips: 0, vehicleStatus: 'MAINTENANCE', driverOnLeave: true })).toBe(
      'REPAIR',
    );
    expect(dayCellState({ trips: 0, vehicleStatus: 'PARKED', driverOnLeave: true })).toBe('PARKED');
    expect(dayCellState({ trips: 0, vehicleStatus: 'ACTIVE', driverOnLeave: true })).toBe('LEAVE');
    expect(dayCellState({ trips: 0, vehicleStatus: 'ACTIVE', driverOnLeave: false })).toBe('FREE');
  });
});
