import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPlatformToken } from '../src/auth/tokens';
import { PLATFORM_SETTINGS } from '../src/platform/platform-settings.registry';
import { PlatformSettingsService } from '../src/platform/platform-settings.service';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

/**
 * P1-ST1-T04: PlatformSetting registry (spec/01 §9 + plan/13 §4.1) — แก้ได้เฉพาะ Console owner + เหตุผล + audit (PLT-099)
 * เกณฑ์ตรวจรับ: ค่าผิด type → 422 · แก้แล้วมีผลกับเหตุการณ์ถัดไป ไม่ย้อนหลัง · audit มีเหตุผล
 */
describe('ค่าตั้งแพลตฟอร์ม (P1-ST1-T04)', () => {
  let app: NestExpressApplication;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const staff: Record<string, string> = {};
  const as = (role: string) => api(app, staff[role]!);
  const put = (role: string, key: string, body: object) =>
    as(role).put(`/v1/platform/settings/${key}`).send(body);
  const R = 'PO เคาะค่าตั้งรอบทดสอบ';

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    for (const role of ['SUPER_ADMIN', 'SUPPORT', 'BILLING'] as const) {
      const u = await db.platformUser.create({
        data: {
          email: `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@innovera.test`,
          name: `ทีม ${role}`,
          role,
          passwordHash: 'x',
          totpSecret: 'x',
        },
      });
      staff[role] = await signPlatformToken({ sub: u.id, role, tv: u.tokenVersion });
    }
  });
  afterAll(async () => {
    await app.close();
    // ค่าตั้งเป็นของทั้งแพลตฟอร์ม — คืนค่าเริ่มต้นให้ไฟล์อื่น (role platform ลบไม่ได้ — ใช้เจ้าของตาราง)
    await owner.platformSetting.deleteMany({});
    await owner.$disconnect();
    await db.$disconnect();
  });

  it('ค่าเริ่มต้นตาม spec/01 §9 + plan/13 §4.1 · ทุกบทบาทดูได้', async () => {
    const rows = (await as('SUPPORT').get('/v1/platform/settings').expect(200)).body as {
      key: string;
      value: unknown;
      isDefault: boolean;
      version: number;
    }[];
    const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(v).toMatchObject({
      'trial.days': 30,
      'trial.vehicleLimit': 20,
      'signup.approvalPolicy': 'auto_when_verified',
      'dunning.pastDueDays': 7,
      'dunning.readOnlyUntilDay': 21,
      'dunning.suspendUntilDay': 60,
      'trialExpiry.readOnlyDays': 14,
      'retention.operationalDays': 90,
      'retention.purgeEnabled': false,
      'usage.activeVehicleRule': 'trip_started',
      'usage.subconWeight': '1.00',
      'pricing.publicVisible': false,
      'billing.paymentMethods': ['transfer'],
      'planMigration.noticeDays': 30,
      'impersonation.maxMinutes': 60,
    });
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(PLATFORM_SETTINGS).sort());
    expect(rows.every((r) => r.isDefault && r.version === 0)).toBe(true);
  });

  it.each([
    ['trial.days', '30', 'setting_type'],
    ['trial.days', 0, 'setting_range'],
    ['trial.days', 12.5, 'setting_type'],
    ['retention.purgeEnabled', 'false', 'setting_type'],
    ['signup.approvalPolicy', 'auto', 'setting_option'],
    ['usage.subconWeight', 0.5, 'setting_type'],
    ['usage.subconWeight', '1.50', 'setting_range'],
    ['billing.paymentMethods', [], 'setting_range'],
    ['billing.paymentMethods', ['transfer', 'transfer'], 'setting_range'],
    ['billing.paymentMethods', ['cash'], 'setting_option'],
    [
      'dunning.reminderDays',
      { past_due: [3, 1], read_only: [8], suspended: [22] },
      'setting_range',
    ],
    ['dunning.reminderDays', { past_due: [1] }, 'setting_type'],
  ])('ค่าผิด type/ช่วง → 422: %s = %j', async (key, value, code) => {
    const r = await put('SUPER_ADMIN', key, { value, reason: R }).expect(422);
    expect(r.body).toMatchObject({ code: 'validation_failed', errors: [{ field: 'value', code }] });
  });

  it('key ไม่มีใน registry → 404 · เหตุผลสั้น → 422 · ไม่ใช่ owner → 403 · token ลูกค้า → 401', async () => {
    await put('SUPER_ADMIN', 'nope.key', { value: 1, reason: R }).expect(404);
    await put('SUPER_ADMIN', 'trial.days', { value: 20, reason: 'สั้น' }).expect(422);
    await put('SUPPORT', 'trial.days', { value: 20, reason: R }).expect(403);
    await put('BILLING', 'trial.days', { value: 20, reason: R }).expect(403);
    const t = await createTenant(db);
    await api(app, await tokenFor(t.id, '*'))
      .get('/v1/platform/settings')
      .expect(401);
  });

  it('แก้ค่า: normalize + audit before/after พร้อมเหตุผล + optimistic version · กฎข้ามช่อง dunning', async () => {
    const r = await put('SUPER_ADMIN', 'billing.paymentMethods', {
      value: ['promptpay', 'transfer'],
      expectedVersion: 0,
      reason: R,
    }).expect(200);
    expect(r.body).toMatchObject({
      value: ['transfer', 'promptpay'],
      isDefault: false,
      version: 1,
    });
    expect(r.body.updatedBy).toBe('ทีม SUPER_ADMIN');
    await put('SUPER_ADMIN', 'billing.paymentMethods', {
      value: ['transfer'],
      expectedVersion: 0,
      reason: R,
    }).expect(412);
    const a = await db.platformAuditLog.findFirstOrThrow({
      where: { entityType: 'platform_setting', entityId: 'billing.paymentMethods' },
    });
    expect(a).toMatchObject({
      action: 'platform.setting_changed',
      reason: R,
      before: { value: ['transfer'] },
      after: { value: ['transfer', 'promptpay'] },
    });
    expect(a.platformUserId).toBeTruthy();

    const d = await put('SUPER_ADMIN', 'dunning.readOnlyUntilDay', { value: 70, reason: R }).expect(
      422,
    );
    expect(d.body.errors[0].code).toBe('dunning_order');
    await put('SUPER_ADMIN', 'usage.subconWeight', { value: '0.5', reason: R }).expect(200);
    expect(await app.get(PlatformSettingsService).get('usage.subconWeight')).toBe('0.50');
  });

  it('มีผลกับเหตุการณ์ถัดไป ไม่ย้อนหลัง: trial.days 30 → 14 — tenant เดิมคงวันหมด trial เดิม, tenant ใหม่ได้ 14 วัน', async () => {
    const before = await createTenant(db, 'สมัครก่อนแก้');
    const s1 = await db.subscription.findUniqueOrThrow({ where: { tenantId: before.id } });
    await put('SUPER_ADMIN', 'trial.days', { value: 14, reason: R }).expect(200);
    const after = await createTenant(db, 'สมัครหลังแก้');
    const s2 = await db.subscription.findUniqueOrThrow({ where: { tenantId: after.id } });
    const days = (s: { trialEndsAt: Date | null; createdAt: Date }) =>
      Math.round((s.trialEndsAt!.getTime() - s.createdAt.getTime()) / 864e5);
    expect(days(s2)).toBe(14);
    const s1again = await db.subscription.findUniqueOrThrow({ where: { tenantId: before.id } });
    expect(s1again.trialEndsAt).toEqual(s1.trialEndsAt);
    expect(days(s1again)).toBe(30);
  });
});
