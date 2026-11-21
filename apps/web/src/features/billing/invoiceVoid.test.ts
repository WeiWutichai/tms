import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api';
import type { T } from '../../i18n';
import { th, type MessageKey } from '../../i18n/th';
import { voidErrorText } from './InvoiceDrawer';

const t = ((k: MessageKey, v?: Record<string, unknown>) =>
  Object.entries(v ?? {}).reduce(
    (s, [a, b]) => s.replace(`{${a}}`, String(b)),
    (th as Record<string, string>)[k] ?? k,
  )) as unknown as T;

describe('ยกเลิกใบแจ้งหนี้ที่ออกแล้ว (ST5-T10) — ข้อความ error', () => {
  it('409 invoice_on_billing_note → บอกเลขใบวางบิล', () => {
    const e = new ApiError({
      type: '',
      title: '',
      status: 409,
      code: 'invoice_on_billing_note',
      billingNoteNo: 'BN-00000-6911-0003',
    } as never);
    expect(voidErrorText(e, t)).toBe(
      'ใบแจ้งหนี้นี้อยู่ในใบวางบิลที่ออกแล้ว ยกเลิกไม่ได้ — ยกเลิกใบวางบิลก่อน (ใบวางบิล BN-00000-6911-0003)',
    );
  });
  it('409 invoice_has_payments → บอกเลขรับชำระที่ต้องกลับรายการ', () => {
    const e = new ApiError({
      type: '',
      title: '',
      status: 409,
      code: 'invoice_has_payments',
      payments: [{ paymentNo: 'PAY-6911-0001' }, { paymentNo: 'PAY-6911-0004' }],
    } as never);
    expect(voidErrorText(e, t)).toBe(
      'ใบแจ้งหนี้นี้รับชำระแล้ว ยกเลิกไม่ได้ — กลับรายการรับชำระก่อน (PAY-6911-0001, PAY-6911-0004)',
    );
  });
});
