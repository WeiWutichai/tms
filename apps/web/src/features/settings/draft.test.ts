import { describe, expect, it } from 'vitest';
import { rebaseDraft } from './draft';

describe('rebaseDraft', () => {
  it('คงค่าที่ผู้ใช้แก้ก่อนข้อมูลจาก server โหลดเสร็จ', () => {
    const next = { 'security.idleTimeoutMinutes': 480, 'security.autoLogout': true };
    expect(rebaseDraft(null, { 'security.idleTimeoutMinutes': 60 }, next)).toEqual({
      'security.idleTimeoutMinutes': 60,
      'security.autoLogout': true,
    });
  });

  it('refetch ที่ server ไม่ได้เปลี่ยน key → คงค่าที่แก้ค้าง', () => {
    const base = { a: 1, b: 'x' };
    expect(rebaseDraft(base, { a: 2, b: 'x' }, { a: 1, b: 'x' })).toEqual({ a: 2, b: 'x' });
  });

  it('server เปลี่ยน key (บันทึกสำเร็จ/คนอื่นแก้) → ใช้ค่าจาก server', () => {
    const base = { a: 1, b: 'x' };
    expect(rebaseDraft(base, { a: 2, b: 'x' }, { a: 3, b: 'y' })).toEqual({ a: 3, b: 'y' });
  });

  it('ไม่มีค่าที่แก้ → เท่ากับ server', () => {
    const base = { a: [1, 2] };
    expect(rebaseDraft(base, { a: [1, 2] }, { a: [2] })).toEqual({ a: [2] });
  });
});
