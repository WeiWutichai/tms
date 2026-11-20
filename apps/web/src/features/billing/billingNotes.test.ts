import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api';
import type { T } from '../../i18n';
import { th, type MessageKey } from '../../i18n/th';
import { billingNoteErrorText, billingNoteStatusLabel } from './BillingNoteDrawer';

const t = ((k: MessageKey, v?: Record<string, unknown>) =>
  Object.entries(v ?? {}).reduce(
    (s, [a, b]) => s.replace(`{${a}}`, String(b)),
    (th as Record<string, string>)[k] ?? k,
  )) as unknown as T;

describe('ใบวางบิล (ST5-T11) — ป้ายสถานะ/ข้อความ error', () => {
  it('สถานะ → ป้ายแท็บของต้นแบบ (COLLECTED = ชำระแล้ว)', () => {
    expect(billingNoteStatusLabel(t, 'DRAFT')).toBe('ร่าง');
    expect(billingNoteStatusLabel(t, 'ISSUED')).toBe('ออกแล้ว');
    expect(billingNoteStatusLabel(t, 'COLLECTED')).toBe('ชำระแล้ว');
    expect(billingNoteStatusLabel(t, 'CANCELLED')).toBe('ยกเลิก');
  });

  it('409 invoice_already_billed ต่อท้ายเลขใบแจ้งหนี้ที่ติด', () => {
    const e = new ApiError({
      type: '',
      title: '',
      status: 409,
      code: 'invoice_already_billed',
      invoices: [{ invoiceNo: 'INV-00000-2611-0001', billingNoteNo: null }],
    } as never);
    expect(billingNoteErrorText(e, t)).toBe(
      'ใบแจ้งหนี้นี้อยู่ในใบวางบิลอื่นแล้ว: INV-00000-2611-0001',
    );
  });

  it('422 วันนัดรับเช็ค → ข้อความไทยของช่อง', () => {
    const e = new ApiError({
      type: '',
      title: '',
      status: 422,
      code: 'validation_failed',
      errors: [{ field: 'collectionDate', code: 'before_billing_date', message: 'x' }],
    } as never);
    expect(billingNoteErrorText(e, t)).toContain('ต้องไม่ก่อนวันวางบิล');
  });
});
