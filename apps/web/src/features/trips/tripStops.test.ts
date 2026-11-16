import { describe, expect, it } from 'vitest';
import type { T } from '../../i18n';
import { th } from '../../i18n/th';
import {
  durationText,
  firstOrderViolation,
  legText,
  moveStop,
  routeDistanceText,
} from './tripStops';

const t: T = (k, p) =>
  Object.entries(p ?? {}).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), th[k] as string);

describe('tripStops (ST3-T16)', () => {
  it('moveStop สลับกับจุดข้างเคียง · ขอบ = null', () => {
    expect(moveStop(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveStop(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveStop(['a', 'b'], 0, -1)).toBeNull();
    expect(moveStop(['a', 'b'], 1, 1)).toBeNull();
  });
  it('firstOrderViolation: จุดส่งก่อน/ที่เดียวกับจุดรับของ DO เดียวกัน', () => {
    const trip = {
      deliveryOrders: [
        { doNo: 'DO-1', pickupStopId: 'p', dropStopId: 'q' },
        { doNo: 'DO-2', pickupStopId: 'p', dropStopId: 'r' },
      ],
    } as never;
    expect(firstOrderViolation(trip, ['p', 'q', 'r'])).toBeNull();
    expect(firstOrderViolation(trip, ['q', 'p', 'r'])).toEqual({ doNo: 'DO-1' });
    expect(firstOrderViolation(trip, ['q', 'r', 'p'])).toEqual({ doNo: 'DO-1' });
  });
  it('ข้อความเวลา/ระยะ', () => {
    expect(durationText(t, 45)).toBe('45 นาที');
    expect(durationText(t, 120)).toBe('2 ชม.');
    expect(durationText(t, 230)).toBe('3 ชม. 50 นาที');
    expect(
      routeDistanceText(t, { distanceKm: '1182.4', minutes: 1, missingLegs: 0, estimated: false }),
    ).toBe('1,182.4 กม.');
    expect(
      routeDistanceText(t, { distanceKm: '82.0', minutes: 1, missingLegs: 2, estimated: true }),
    ).toBe('82.0 กม. (ประมาณจากพิกัด) · ไม่ทราบระยะ 2 ช่วง');
    expect(
      routeDistanceText(t, { distanceKm: null, minutes: null, missingLegs: 1, estimated: false }),
    ).toBe('ไม่ทราบระยะ');
    const s = { legDistanceKm: '45.2', legSource: 'ROUTE' } as never;
    expect(legText(t, s, true)).toBe('');
    expect(legText(t, s, false)).toBe('+45.2 กม.');
    expect(legText(t, { legDistanceKm: '45.2', legSource: 'ESTIMATE' } as never, false)).toBe(
      '≈ +45.2 กม.',
    );
    expect(legText(t, { legDistanceKm: null, legSource: null } as never, false)).toBe(
      'ไม่ทราบระยะ',
    );
  });
});
