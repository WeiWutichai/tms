import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  hasUnresolvedStopFlags,
  planAutoReschedule,
  rescheduleExhaustedNoteTh,
  shiftWindowToDay,
} from './reschedule';

describe('planAutoReschedule (ST4-T12)', () => {
  const base = { previousCount: 0, max: 2, today: '2026-11-17' };

  it('ธงไม่ติ๊ก → ไม่นัดใหม่', () => {
    expect(
      planAutoReschedule({ ...base, autoReschedule: false, failedAt: '2026-11-17T09:00:00+07:00' }),
    ).toBeNull();
  });

  it('วันถัดไปตามเวลาไทย (ปิด 23:30 น. ไทย = วันที่ 17 → ส่ง 18)', () => {
    expect(
      planAutoReschedule({ ...base, autoReschedule: true, failedAt: '2026-11-17T16:30:00Z' }),
    ).toEqual({ doDate: '2026-11-18', attempt: 1, exhausted: false });
    // 00:30 น. ไทยวันที่ 18 (UTC ยังเป็น 17) → ส่ง 19
    expect(
      planAutoReschedule({
        ...base,
        today: '2026-11-18',
        autoReschedule: true,
        failedAt: '2026-11-17T17:30:00Z',
      })!.doDate,
    ).toBe('2026-11-19');
  });

  it('บันทึกย้อนหลังหลายวัน → ไม่ก่อนวันนี้', () => {
    expect(
      planAutoReschedule({
        ...base,
        today: '2026-11-20',
        autoReschedule: true,
        failedAt: '2026-11-10T09:00:00+07:00',
      })!.doDate,
    ).toBe('2026-11-20');
  });

  it('นับครั้ง: เกินค่าตั้ง → exhausted', () => {
    const at = '2026-11-17T09:00:00+07:00';
    expect(
      planAutoReschedule({ ...base, previousCount: 1, autoReschedule: true, failedAt: at }),
    ).toMatchObject({ attempt: 2, exhausted: false });
    expect(
      planAutoReschedule({ ...base, previousCount: 2, autoReschedule: true, failedAt: at }),
    ).toMatchObject({ attempt: 3, exhausted: true });
    expect(
      planAutoReschedule({ ...base, max: 0, autoReschedule: true, failedAt: at }),
    ).toMatchObject({ attempt: 1, exhausted: true });
  });

  it('addCalendarDays ข้ามเดือน/ปี', () => {
    expect(addCalendarDays('2026-12-31')).toBe('2027-01-01');
    expect(addCalendarDays('2028-02-28')).toBe('2028-02-29');
  });
});

describe('shiftWindowToDay', () => {
  it('คงเวลาในวัน เลื่อนวัน', () => {
    expect(
      shiftWindowToDay(
        { start: '2026-11-17T01:00:00.000Z', end: '2026-11-17T10:00:00.000Z' },
        '2026-11-18',
      ),
    ).toEqual({ start: '2026-11-18T01:00:00.000Z', end: '2026-11-18T10:00:00.000Z' });
  });
  it('อิงวันไทยของต้นช่วง (07:00 ไทย = 00:00Z)', () => {
    expect(
      shiftWindowToDay({ start: '2026-11-16T23:30:00.000Z', end: null }, '2026-11-19'),
    ).toEqual({ start: '2026-11-18T23:30:00.000Z', end: null });
  });
  it('ไม่มีช่วง / วันเดียวกัน = เดิม', () => {
    expect(shiftWindowToDay({ start: null, end: null }, '2026-11-18')).toEqual({
      start: null,
      end: null,
    });
    const w = { start: '2026-11-18T01:00:00.000Z', end: null };
    expect(shiftWindowToDay(w, '2026-11-18')).toBe(w);
  });
});

describe('hasUnresolvedStopFlags / ข้อความครบจำนวน (review H1, L)', () => {
  const at = new Date('2026-11-17T03:00:00Z');
  it('ไม่มีธง / ธงที่ตัดสินแล้ว = นิ่ง · ธงค้าง = ยังไม่นัด', () => {
    expect(hasUnresolvedStopFlags([{ flags: [], resolutions: [] }])).toBe(false);
    expect(hasUnresolvedStopFlags([{ flags: ['SEQUENCE_CONFLICT'], resolutions: [] }])).toBe(true);
    expect(
      hasUnresolvedStopFlags([
        {
          flags: ['SEQUENCE_CONFLICT'],
          resolutions: [{ decision: 'IGNORE', flags: ['SEQUENCE_CONFLICT'], at }],
        },
      ]),
    ).toBe(false);
    // ตัดสินกับธงชุดเก่า = หมดผล
    expect(
      hasUnresolvedStopFlags([
        { flags: ['CLOCK_SKEW'], resolutions: [{ decision: 'ACCEPT', flags: ['LATE'], at }] },
      ]),
    ).toBe(true);
    expect(hasUnresolvedStopFlags([{ flags: ['OUTCOME_MISMATCH'], resolutions: [] }])).toBe(true);
  });
  it('ค่าตั้ง 0 ใช้ถ้อยคำ "ไม่นัดอัตโนมัติ"', () => {
    expect(rescheduleExhaustedNoteTh(0, 'ร้านปิด')).toBe(
      'ไม่นัดส่งใหม่อัตโนมัติ (ตั้งไว้ 0 ครั้ง) — ร้านปิด',
    );
    expect(rescheduleExhaustedNoteTh(2, 'ร้านปิด')).toBe(
      'นัดส่งใหม่อัตโนมัติครบ 2 ครั้งแล้ว — ร้านปิด',
    );
  });
});
