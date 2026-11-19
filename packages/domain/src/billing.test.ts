import { describe, expect, it } from 'vitest';
import {
  BILLING_STATUSES,
  BILLING_TRANSITIONS,
  INVOICE_STATUSES,
  billingStage,
  isBillable,
  isInvoiceActive,
} from './billing';
import { InvalidTransitionError, transition } from './state-machine';

describe('billing status (ST5-T05)', () => {
  it('ดึงเข้าร่างได้จาก UNBILLED / CREDITED เท่านั้น', () => {
    expect(transition('do.billing', BILLING_TRANSITIONS, 'UNBILLED', 'draft')).toBe('IN_DRAFT');
    expect(transition('do.billing', BILLING_TRANSITIONS, 'CREDITED', 'draft')).toBe('IN_DRAFT');
    for (const s of ['IN_DRAFT', 'INVOICED'] as const)
      expect(() => transition('do.billing', BILLING_TRANSITIONS, s, 'draft')).toThrow(
        InvalidTransitionError,
      );
    expect(BILLING_STATUSES.filter(isBillable)).toEqual(['UNBILLED', 'CREDITED']);
  });
  it('ร่าง → ถอด (UNBILLED) / ออกเลข (INVOICED) · INVOICED ย้อนไม่ได้ ไปได้แค่ CREDITED', () => {
    expect(BILLING_TRANSITIONS.IN_DRAFT).toEqual({ undraft: 'UNBILLED', invoice: 'INVOICED' });
    expect(BILLING_TRANSITIONS.INVOICED).toEqual({ credit: 'CREDITED' });
    expect(() => transition('do.billing', BILLING_TRANSITIONS, 'INVOICED', 'undraft')).toThrow();
    expect(() => transition('do.billing', BILLING_TRANSITIONS, 'UNBILLED', 'invoice')).toThrow();
  });
  it('ใบที่ยังนับ = ทุกสถานะยกเว้น CANCELLED / VOIDED', () => {
    expect(INVOICE_STATUSES.filter((s) => !isInvoiceActive(s))).toEqual(['VOIDED', 'CANCELLED']);
  });
  it('billingStage ตาม lifecycle docs/04 F4', () => {
    const at = new Date('2026-11-20T03:00:00Z');
    expect(
      billingStage({ status: 'DISPATCHED', billingStatus: 'UNBILLED', releasedAt: null }),
    ).toBe(null);
    expect(billingStage({ status: 'CANCELLED', billingStatus: 'UNBILLED', releasedAt: null })).toBe(
      null,
    );
    expect(
      billingStage({ status: 'POD_PENDING', billingStatus: 'UNBILLED', releasedAt: null }),
    ).toBe('DELIVERED');
    expect(billingStage({ status: 'UNBILLED', billingStatus: 'UNBILLED', releasedAt: at })).toBe(
      'RELEASED',
    );
    expect(billingStage({ status: 'UNBILLED', billingStatus: 'IN_DRAFT', releasedAt: at })).toBe(
      'IN_DRAFT',
    );
    const inv = { status: 'BILLED', billingStatus: 'INVOICED', releasedAt: at } as const;
    expect(billingStage(inv)).toBe('INVOICED');
    expect(billingStage(inv, 'ADJUSTED')).toBe('INVOICED');
    expect(billingStage(inv, 'PARTIALLY_PAID')).toBe('PARTIALLY_PAID');
    expect(billingStage(inv, 'PAID')).toBe('PAID');
    expect(billingStage({ status: 'UNBILLED', billingStatus: 'CREDITED', releasedAt: at })).toBe(
      'CREDITED',
    );
  });
});
