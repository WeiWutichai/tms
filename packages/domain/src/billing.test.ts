import { describe, expect, it } from 'vitest';
import {
  BILLING_REVERT_RULES,
  BILLING_STATUSES,
  BILLING_TRANSITIONS,
  REVERT_DELIVERY_WINDOW_MS,
  INVOICE_STATUSES,
  billingStage,
  invoiceOverdue,
  invoicePaymentStatus,
  isBillable,
  isInvoiceActive,
  revertDeliveryWindow,
} from './billing';
import { DO_TRANSITIONS } from './delivery-order';
import { SO_TRANSITIONS } from './sales-order';
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
  it('ร่าง → ถอด (UNBILLED) / ออกเลข (INVOICED) · INVOICED ไปได้แค่ CREDITED (ลดหนี้เต็มใบ) / UNBILLED (ยกเลิกใบ ST5-T10)', () => {
    expect(BILLING_TRANSITIONS.IN_DRAFT).toEqual({ undraft: 'UNBILLED', invoice: 'INVOICED' });
    expect(BILLING_TRANSITIONS.INVOICED).toEqual({ credit: 'CREDITED', uninvoice: 'UNBILLED' });
    expect(transition('do.billing', BILLING_TRANSITIONS, 'INVOICED', 'uninvoice')).toBe('UNBILLED');
    expect(() => transition('do.billing', BILLING_TRANSITIONS, 'IN_DRAFT', 'uninvoice')).toThrow();
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

describe('lifecycle + revert rules (ST5-T06)', () => {
  it('ช่วงย้อนผลส่งถึง 24 ชม. (ขอบรวม)', () => {
    const at = new Date('2026-11-19T17:30:00.000Z'); // 00:30 น. 20 พ.ย. เวลาไทย
    const w = revertDeliveryWindow(at, new Date(at.getTime() + REVERT_DELIVERY_WINDOW_MS));
    expect(w).toEqual({ deadline: new Date('2026-11-20T17:30:00.000Z'), within: true });
    expect(
      revertDeliveryWindow(at, new Date(at.getTime() + REVERT_DELIVERY_WINDOW_MS + 1)).within,
    ).toBe(false);
  });

  it('สิทธิ์ต่อขั้น: DELIVERED dispatcher 24 ชม./admin · RELEASED/IN_DRAFT invoicer · ออกใบแล้วย้อนไม่ได้', () => {
    expect(BILLING_REVERT_RULES.DELIVERED).toEqual({
      scope: 'trips:close',
      windowHours: 24,
      overrideScope: 'deliveries:revert',
    });
    expect(BILLING_REVERT_RULES.RELEASED?.scope).toBe('invoices:draft');
    expect(BILLING_REVERT_RULES.IN_DRAFT?.scope).toBe('invoices:draft');
    for (const s of ['INVOICED', 'PARTIALLY_PAID', 'PAID', 'CREDITED'] as const)
      expect(BILLING_REVERT_RULES[s]).toBeNull();
  });

  it('transition: DO ส่งถึง → revert_delivery → FAILED (ไม่ใช่ BILLED) · SO ส่งครบ → reopen → กำลังขนส่ง', () => {
    for (const s of ['DELIVERED', 'POD_PENDING', 'UNBILLED'] as const)
      expect(DO_TRANSITIONS[s]?.revert_delivery).toBe('FAILED');
    expect(DO_TRANSITIONS.BILLED?.revert_delivery).toBeUndefined();
    expect(() => transition('do', DO_TRANSITIONS, 'BILLED', 'revert_delivery')).toThrow(
      InvalidTransitionError,
    );
    expect(SO_TRANSITIONS.DELIVERED?.reopen).toBe('IN_TRANSIT');
  });

  it('billingStage: paidAt = PAID เมื่อไม่ส่งสถานะใบ', () => {
    const d = {
      status: 'BILLED',
      billingStatus: 'INVOICED',
      releasedAt: null,
      paidAt: new Date(),
    } as const;
    expect(billingStage(d)).toBe('PAID');
    expect(billingStage(d, 'PARTIALLY_PAID')).toBe('PARTIALLY_PAID');
    expect(billingStage({ ...d, paidAt: null })).toBe('INVOICED');
  });
});

describe('invoicePaymentStatus (ST5-T13)', () => {
  it('ISSUED ↔ PARTIALLY_PAID ↔ PAID ตามยอดตัด · สถานะอื่นไม่เปลี่ยน', () => {
    expect(invoicePaymentStatus('ISSUED', 10000n, 0n)).toBe('ISSUED');
    expect(invoicePaymentStatus('ISSUED', 10000n, 9900n)).toBe('PARTIALLY_PAID');
    expect(invoicePaymentStatus('ISSUED', 10000n, 10000n)).toBe('PAID');
    expect(invoicePaymentStatus('PAID', 10000n, 0n)).toBe('ISSUED');
    expect(invoicePaymentStatus('PARTIALLY_PAID', 10000n, 0n)).toBe('ISSUED');
    expect(invoicePaymentStatus('DRAFT', 10000n, 10000n)).toBe('DRAFT');
    expect(invoicePaymentStatus('CANCELLED', 10000n, 0n)).toBe('CANCELLED');
  });
});

describe('invoiceOverdue (ST5-T18)', () => {
  const T = '2026-11-21';
  it('ค้างรับ + เลยวันครบกำหนด (เวลาไทย) = เกินกำหนด · ครบกำหนดวันนี้ยังไม่เกิน', () => {
    expect(invoiceOverdue('ISSUED', 10000n, 0n, '2026-11-20', T)).toBe(true);
    expect(invoiceOverdue('PARTIALLY_PAID', 10000n, 5000n, '2026-11-20', T)).toBe(true);
    expect(invoiceOverdue('ISSUED', 10000n, 0n, T, T)).toBe(false);
    expect(invoiceOverdue('ISSUED', 10000n, 0n, '2026-12-01', T)).toBe(false);
    expect(invoiceOverdue('ISSUED', 10000n, 0n, null, T)).toBe(false);
  });
  it('ชำระครบ / ร่าง / ยกเลิก / ปรับยอด ไม่เกินกำหนด', () => {
    expect(invoiceOverdue('PAID', 10000n, 10000n, '2026-11-01', T)).toBe(false);
    expect(invoiceOverdue('ISSUED', 10000n, 10000n, '2026-11-01', T)).toBe(false);
    for (const s of ['DRAFT', 'CANCELLED', 'VOIDED', 'ADJUSTED'] as const)
      expect(invoiceOverdue(s, 10000n, 0n, '2026-11-01', T)).toBe(false);
  });
});
