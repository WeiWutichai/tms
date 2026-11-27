import { describe, expect, it } from 'vitest';
import {
  addOnLayer,
  nextExpiry,
  overrideLayer,
  planLayer,
  statusLayer,
  type Entitlements,
} from './entitlement-layers';

/** P1-ST1-T02 ชั้นของ entitlement (spec/01 PLT-062) — ตารางกรณี */
const now = new Date('2026-11-27T03:00:00Z');
const later = new Date(now.getTime() + 3600e3);
const earlier = new Date(now.getTime() - 1000);
const limitTyped = new Set(['conn', 'api', 'webhook', 'veh']);

const plan = planLayer([
  { featureKey: 'so', mode: 'included', limit: null },
  { featureKey: 'report', mode: 'included', limit: null },
  { featureKey: 'conn', mode: 'addon', limit: null },
  { featureKey: 'api', mode: 'not_available', limit: null },
  { featureKey: 'webhook', mode: 'included', limit: 3 },
  { featureKey: 'veh', mode: 'included', limit: 20 },
]);

describe('entitlement layers (P1-ST1-T02)', () => {
  it('แพ็กเกจ: included เปิด · addon/not_available ปิด', () => {
    expect(plan.so).toEqual({ enabled: true, limit: null });
    expect(plan.conn).toEqual({ enabled: false, limit: null });
    expect(plan.api).toEqual({ enabled: false, limit: null });
  });

  it('add-on: เปิดฟีเจอร์ที่ปิด (limit = จำนวน) · เพิ่ม limit ของที่เปิด · หมดอายุแล้วไม่มีผล', () => {
    const out = addOnLayer(
      plan,
      [
        { featureKey: 'conn', quantity: 1, endAt: null },
        { featureKey: 'webhook', quantity: 2, endAt: later },
        { featureKey: 'api', quantity: 300, endAt: earlier },
      ],
      limitTyped,
      now,
    );
    expect(out.conn).toEqual({ enabled: true, limit: 1 });
    expect(out.webhook).toEqual({ enabled: true, limit: 5 });
    expect(out.api).toEqual({ enabled: false, limit: null });
    // ไม่แก้ object เดิม
    expect(plan.conn?.enabled).toBe(false);
  });

  it('override ทับ add-on: revoke ปิดแม้ซื้อ add-on · grant หมดอายุไม่มีผล · set_limit', () => {
    const withAddOn = addOnLayer(
      plan,
      [{ featureKey: 'conn', quantity: 1, endAt: null }],
      limitTyped,
      now,
    );
    const out = overrideLayer(
      withAddOn,
      [
        { featureKey: 'conn', mode: 'revoke', limit: null, expiresAt: null },
        { featureKey: 'api', mode: 'grant', limit: null, expiresAt: earlier },
        { featureKey: 'veh', mode: 'set_limit', limit: 35, expiresAt: later },
        { featureKey: 'report', mode: 'revoke', limit: null, expiresAt: later },
      ],
      () => 1000,
      now,
    );
    expect(out.conn).toEqual({ enabled: false, limit: 1 });
    expect(out.api).toEqual({ enabled: false, limit: null });
    expect(out.veh).toEqual({ enabled: true, limit: 35 });
    expect(out.report?.enabled).toBe(false);
  });

  it('grant ไม่ระบุ limit บนฟีเจอร์ที่ปิด → limit สูงสุดของแพ็กเกจ (ไม่ใช่ไม่จำกัด)', () => {
    const out = overrideLayer(
      plan,
      [{ featureKey: 'api', mode: 'grant', limit: null, expiresAt: null }],
      (k) => (k === 'api' ? 1000 : null),
      now,
    );
    expect(out.api).toEqual({ enabled: true, limit: 1000 });
  });

  it.each([
    ['TRIAL', true],
    ['ACTIVE', true],
    ['trialing', true],
    ['past_due', true],
    ['read_only', true], // ตัดที่ guard ของ P1-ST1-T03 ไม่ใช่ entitlement (คิว webhook ต้องพัก ไม่ทิ้ง)
  ])('สถานะ %s ไม่ตัดฟีเจอร์', (status, same) => {
    expect(statusLayer(plan, status) === plan).toBe(same);
  });

  it.each(['SUSPENDED', 'CANCELLED', 'suspended', 'cancelled'])(
    'สถานะ %s → ไม่มีฟีเจอร์ใดทำงาน (รวมพื้นฐาน)',
    (status) => {
      expect(statusLayer(plan, status)).toEqual({});
    },
  );

  it('pending_verification: API/webhook/connector ปิด · รถ active ≤ 5 (PLT-014)', () => {
    const open: Entitlements = {
      ...plan,
      api: { enabled: true, limit: 300 },
      conn: { enabled: true, limit: 1 },
    };
    const out = statusLayer(open, 'PENDING_VERIFICATION');
    expect(out.api?.enabled).toBe(false);
    expect(out.conn?.enabled).toBe(false);
    expect(out.webhook?.enabled).toBe(false);
    expect(out.veh).toEqual({ enabled: true, limit: 5 });
    expect(out.so?.enabled).toBe(true);
    expect(
      statusLayer({ veh: { enabled: true, limit: null } }, 'pending_verification').veh?.limit,
    ).toBe(5);
  });

  it('nextExpiry = เวลาหมดอายุที่ใกล้ที่สุดในอนาคต', () => {
    const soon = new Date(now.getTime() + 5000);
    expect(
      nextExpiry(
        [{ expiresAt: later }, { expiresAt: earlier }, { expiresAt: null }],
        [{ endAt: soon }],
        now,
      ),
    ).toEqual(soon);
    expect(nextExpiry([{ expiresAt: null }], [], now)).toBeNull();
  });
});
