import { describe, expect, it } from 'vitest';
import {
  isPodEditable,
  maskPin,
  normalizeBarcodes,
  podDoEvent,
  podSetForDo,
  podStatusOf,
} from './pod';
import { DO_TRANSITIONS } from './delivery-order';

describe('podStatusOf', () => {
  it('ไม่มีฉบับ = NONE · ครบ = COMPLETE · ไม่ครบ = PARTIAL', () => {
    expect(podStatusOf(false, true)).toBe('NONE');
    expect(podStatusOf(false, false)).toBe('NONE');
    expect(podStatusOf(true, true)).toBe('COMPLETE');
    expect(podStatusOf(true, false)).toBe('PARTIAL');
  });
});

describe('podDoEvent', () => {
  it('DELIVERED → pod_accept เมื่อผ่าน / pod_wait เมื่อไม่ครบ', () => {
    expect(podDoEvent('DELIVERED', true)).toBe('pod_accept');
    expect(podDoEvent('DELIVERED', false)).toBe('pod_wait');
  });
  it('POD_PENDING → pod_accept เมื่อครบเท่านั้น', () => {
    expect(podDoEvent('POD_PENDING', true)).toBe('pod_accept');
    expect(podDoEvent('POD_PENDING', false)).toBeNull();
  });
  it('UNBILLED/BILLED/FAILED ไม่เปลี่ยน (ไม่ถอยหลัง)', () => {
    for (const s of ['UNBILLED', 'BILLED', 'FAILED', 'DISPATCHED'] as const) {
      expect(podDoEvent(s, true)).toBeNull();
      expect(podDoEvent(s, false)).toBeNull();
    }
  });
  it('ทุก event ที่คืนมีใน DO_TRANSITIONS', () => {
    for (const s of ['DELIVERED', 'POD_PENDING'] as const)
      for (const ok of [true, false]) {
        const ev = podDoEvent(s, ok);
        if (ev) expect(DO_TRANSITIONS[s]?.[ev]).toBeDefined();
      }
  });
});

describe('podSetForDo / isPodEditable', () => {
  it('FAILED/RETURNED ใช้ชุดไม่สำเร็จ', () => {
    expect(podSetForDo('FAILED')).toBe('FAILURE');
    expect(podSetForDo('RETURNED')).toBe('FAILURE');
    expect(podSetForDo('DELIVERED')).toBe('SUCCESS');
    expect(podSetForDo('UNBILLED')).toBe('SUCCESS');
  });
  it('แก้ได้หลังส่ง ยกเว้นวางบิลแล้ว/ยังไม่ส่ง', () => {
    expect(isPodEditable('DELIVERED')).toBe(true);
    expect(isPodEditable('POD_PENDING')).toBe(true);
    expect(isPodEditable('UNBILLED')).toBe(true);
    expect(isPodEditable('FAILED')).toBe(true);
    expect(isPodEditable('BILLED')).toBe(false);
    expect(isPodEditable('RETURNED')).toBe(false); // ST4-T11
    expect(isPodEditable('DISPATCHED')).toBe(false);
    expect(isPodEditable('CANCELLED')).toBe(false);
  });
});

describe('normalizeBarcodes', () => {
  it('รับชื่อ barcodes (docs/01 §5.3) หรือ scanCodes (spec/04 §13) — ตัดว่าง/ซ้ำ', () => {
    expect(normalizeBarcodes([' A1 ', '', 'A1', 'B2'], undefined)).toEqual({
      value: ['A1', 'B2'],
      conflict: false,
    });
    expect(normalizeBarcodes(undefined, ['X'])).toEqual({ value: ['X'], conflict: false });
    expect(normalizeBarcodes(null, null)).toEqual({ value: [], conflict: false });
  });
  it('ส่งทั้งคู่: เหมือนกัน = ผ่าน · ต่างกัน = conflict', () => {
    expect(normalizeBarcodes(['A'], [' A '])).toEqual({ value: ['A'], conflict: false });
    expect(normalizeBarcodes(['A'], ['B']).conflict).toBe(true);
  });
});

describe('maskPin', () => {
  it('ปิดบังทุกหลัก', () => {
    expect(maskPin('1234')).toBe('••••');
    expect(maskPin(null)).toBeNull();
  });
});
