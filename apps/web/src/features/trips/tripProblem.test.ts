import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api';
import { th } from '../../i18n/th';
import { tripProblemText } from './tripProblem';

const t = ((k: string, p?: Record<string, string | number>) =>
  String((th as Record<string, string>)[k] ?? k).replace(/\{(\w+)\}/g, (_, x) =>
    String(p?.[x] ?? ''),
  )) as never;

describe('tripProblemText (ST3-T17 ข้อความปฏิเสธการจัดรถ — ใช้ร่วมกระดาน/bulk)', () => {
  it('422 driverId required → "ยังไม่กำหนดคนขับ" (ทั้ง ApiError และ problem ของ bulk)', () => {
    const p = {
      type: '',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
      errors: [{ field: 'driverId', code: 'required', message: 'company vehicles need a driver' }],
    };
    expect(tripProblemText(new ApiError(p as never), t)).toContain('ยังไม่กำหนดคนขับ');
    expect(tripProblemText(p, t)).toContain('ยังไม่กำหนดคนขับ');
    expect(tripProblemText(p, t)).not.toContain('company');
  });
  it('detail ไทยจาก API แสดงแทนข้อความช่อง · 409 กฎ → ข้อความกฎ', () => {
    expect(
      tripProblemText(
        {
          code: 'validation_failed',
          detail: 'รถคันนี้ไม่มีคนขับประจำ — เปิดเที่ยวเพื่อเลือกคนขับ',
          errors: [{ field: 'driverId', code: 'required' }],
        },
        t,
      ),
    ).toContain('รถคันนี้ไม่มีคนขับประจำ');
    expect(
      tripProblemText({ code: 'assignment_warnings', warnings: [{ message: 'น้ำหนักเกิน' }] }, t),
    ).toContain('น้ำหนักเกิน');
  });
});
