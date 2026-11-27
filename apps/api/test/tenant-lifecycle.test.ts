import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient, type TenantStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { signPlatformToken } from '../src/auth/tokens';
import { Clock } from '../src/common/clock';
import { encodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { TenantLifecycleService } from '../src/modules/tenants/tenant-lifecycle.service';
import {
  dunningStage,
  dunningSteps,
  subscriptionStatusFor,
  type DunningSettings,
} from '../src/modules/tenants/tenant-status';
import { api, bootApp, loginFull, platform, tokenFor, truncateAll } from './helpers';

/**
 * P1-ST1-T03 วงจรสถานะ tenant 7 ค่า (R-10 · spec/01 §1 PLT-010–019 · D-45)
 * เกณฑ์ตรวจรับ plan/13: เลื่อนนาฬิกา วัน trial+1 → read_only · สร้าง SO ได้ 403 · export ได้ · ชำระแล้ว → active ≤ 1 นาที ·
 * harness แยก tenant ครอบตารางประวัติ
 */
describe('วงจรสถานะ tenant (P1-ST1-T03)', () => {
  let app: NestExpressApplication;
  let svc: TenantLifecycleService;
  let clock: Clock;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const staff: Record<string, string> = {};
  const staffId: Record<string, string> = {};
  const as = (role: string) => api(app, staff[role]!);
  /** เวลาไทย "YYYY-MM-DD HH:mm" → instant */
  const bkk = (s: string) => new Date(`${s.replace(' ', 'T')}:00+07:00`);

  /** tenant + owner (อีเมลแจ้งเตือนไปที่นี่) */
  async function tenant(status: TenantStatus, opts: { trialEndsAt?: Date } = {}) {
    const n = randomUUID().slice(0, 6);
    const t = await createTenantWithDefaults(db, { name: `บริษัท ทดสอบสถานะ ${n} จำกัด`, status });
    const roles = await ensureSystemRoles(db, t.id);
    const u = await db.appUser.create({
      data: {
        tenantId: t.id,
        email: `owner-${n}@life.test`,
        name: `เจ้าของ ${n}`,
        status: 'ACTIVE',
        passwordHash: await hashPassword('owner-password-2569'),
      },
    });
    await db.userRole.create({ data: { tenantId: t.id, userId: u.id, roleId: roles.owner! } });
    if (opts.trialEndsAt)
      await db.subscription.update({
        where: { tenantId: t.id },
        data: { trialEndsAt: opts.trialEndsAt },
      });
    return { id: t.id, ownerId: u.id, email: u.email, ref: encodeId('tenant', t.id) };
  }
  const statusOf = async (id: string) =>
    (await db.tenant.findUniqueOrThrow({ where: { id }, include: { subscription: true } }))!;
  const history = (id: string) =>
    db.tenantStatusHistory.findMany({ where: { tenantId: id }, orderBy: { seq: 'asc' } });
  /** ปลุก cron ณ เวลาไทยที่กำหนด (นาฬิกาที่ฉีดได้) */
  async function cronAt(s: string) {
    clock.set(bkk(s));
    return svc.sweep(clock.now());
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    svc = app.get(TenantLifecycleService);
    clock = app.get(Clock);
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
      staffId[role] = u.id;
      staff[role] = await signPlatformToken({ sub: u.id, role, tv: u.tokenVersion });
    }
  });
  afterAll(async () => {
    clock.set(null);
    await app.close();
    await owner.platformSetting.deleteMany({});
    await owner.$disconnect();
    await db.$disconnect();
  });

  /** active → past_due → read_only (วัน 0 = 10 วันก่อน) ด้วยนาฬิกาปัจจุบัน */
  async function toReadOnly(id: string) {
    const since = new Date(Date.now() - 10 * 86_400_000 + 7 * 3600_000).toISOString().slice(0, 10);
    const base = { tenantId: id, reason: 'ทดสอบ read_only', actor: { type: 'system' as const } };
    const dunning = { kind: 'invoice' as const, since };
    await svc.transition({ ...base, to: 'PAST_DUE', dunning });
    await svc.transition({ ...base, to: 'READ_ONLY', expectFrom: 'PAST_DUE', dunning });
  }

  describe('กติกาวัน (pure)', () => {
    const S: DunningSettings = {
      pastDueDays: 7,
      readOnlyUntilDay: 21,
      suspendUntilDay: 60,
      trialReadOnlyDays: 14,
    };
    it.each([
      ['invoice', 0, 'PAST_DUE'],
      ['invoice', 7, 'PAST_DUE'],
      ['invoice', 8, 'READ_ONLY'],
      ['invoice', 21, 'READ_ONLY'],
      ['invoice', 22, 'SUSPENDED'],
      ['invoice', 60, 'SUSPENDED'],
      ['invoice', 61, 'CANCELLED'],
      ['trial', 1, 'READ_ONLY'],
      ['trial', 14, 'READ_ONLY'],
      ['trial', 15, 'SUSPENDED'],
      ['trial', 60, 'SUSPENDED'],
      ['trial', 61, 'CANCELLED'],
    ] as const)('%s วันที่ %i → %s (PLT-011/012)', (kind, day, want) => {
      expect(dunningStage(kind, day, S)).toBe(want);
    });
    it('เดินทีละขั้น · trial ข้าม past_due · ไม่ถอยหลัง', () => {
      expect(dunningSteps('TRIALING', 'trial', 'CANCELLED')).toEqual([
        'READ_ONLY',
        'SUSPENDED',
        'CANCELLED',
      ]);
      expect(dunningSteps('PAST_DUE', 'invoice', 'SUSPENDED')).toEqual(['READ_ONLY', 'SUSPENDED']);
      expect(dunningSteps('SUSPENDED', 'invoice', 'READ_ONLY')).toEqual([]);
    });
    it('subscription.status ตาม tenant.status', () => {
      expect(subscriptionStatusFor('PENDING_VERIFICATION', null, null)).toBe('trialing');
      expect(subscriptionStatusFor('READ_ONLY', 'trial', 'trialing')).toBe('past_due');
      expect(subscriptionStatusFor('SUSPENDED', null, 'active')).toBe('active'); // ระงับด้วยมือ
      expect(subscriptionStatusFor('CANCELLED', null, 'active')).toBe('cancelled');
    });
  });

  it('trial หมด: วันหมด trial ยังไม่เปลี่ยน → วัน trial+1 00:30 = read_only (ประวัติ + audit + อีเมล + subscription) · รันซ้ำไม่เปลี่ยน', async () => {
    const t = await tenant('TRIALING', { trialEndsAt: bkk('2026-12-10 12:00') });
    expect((await cronAt('2026-12-10 23:59')).transitions).toBe(0);
    // ก่อน 00:30 cron ยังไม่รัน
    clock.set(bkk('2026-12-11 00:10'));
    expect(await svc.scheduleDue()).toBeNull();
    clock.set(bkk('2026-12-11 00:31'));
    const r = await svc.scheduleDue();
    expect(r).toMatchObject({ day: '2026-12-11', tenants: 1, transitions: 1, failed: 0 });
    const s = await statusOf(t.id);
    expect(s).toMatchObject({ status: 'READ_ONLY', dunningKind: 'trial' });
    expect(s.pastDueSince!.toISOString().slice(0, 10)).toBe('2026-12-10');
    expect(s.subscription!.status).toBe('past_due');
    expect(s.statusChangedAt!.toISOString()).toBe(bkk('2026-12-11 00:31').toISOString());
    const h = await history(t.id);
    expect(h.map((x) => [x.fromStatus, x.toStatus, x.actorType])).toEqual([
      ['TRIALING', 'READ_ONLY', 'system'],
    ]);
    expect(h[0]!.reason).toContain('ทดลองใช้');
    const au = await db.auditLog.findFirstOrThrow({
      where: { tenantId: t.id, action: 'tenant.status_changed' },
    });
    expect(au).toMatchObject({
      actorId: 'system',
      before: { status: 'trialing' },
      after: { status: 'read_only', dunningKind: 'trial', pastDueSince: '2026-12-10' },
    });
    const mail = await db.emailOutbox.findFirstOrThrow({
      where: { tenantId: t.id, template: 'tenant_status_changed' },
    });
    expect(mail.toAddress).toBe(t.email);
    expect(mail.subject).toContain('อ่านอย่างเดียว');
    // วันเดียวกันรันซ้ำ (process เดิม/ใหม่) = ไม่มีอะไรเปลี่ยน
    expect(await svc.scheduleDue()).toBeNull();
    expect((await cronAt('2026-12-11 09:00')).transitions).toBe(0);
    expect(await history(t.id)).toHaveLength(1);

    // วันที่ 14 ยัง read_only · วันที่ 15 ระงับ · วันที่ 61 ยกเลิก + วันครบเก็บข้อมูล 90 วัน (purge ปิด — ไม่มีอะไรถูกลบ)
    await cronAt('2026-12-24 00:30');
    expect((await statusOf(t.id)).status).toBe('READ_ONLY');
    await cronAt('2026-12-25 00:30');
    expect((await statusOf(t.id)).status).toBe('SUSPENDED');
    await cronAt('2027-02-09 00:30');
    const c = await statusOf(t.id);
    expect(c).toMatchObject({ status: 'CANCELLED', dunningKind: null, pastDueSince: null });
    expect(c.subscription!.status).toBe('cancelled');
    expect(c.cancelledAt!.toISOString()).toBe(bkk('2027-02-09 00:30').toISOString());
    expect(c.dataPurgeAt!.getTime() - c.cancelledAt!.getTime()).toBe(90 * 86_400_000);
    expect((await history(t.id)).map((x) => x.toStatus)).toEqual([
      'READ_ONLY',
      'SUSPENDED',
      'CANCELLED',
    ]);
    expect(await db.appUser.count({ where: { tenantId: t.id } })).toBe(1);
  });

  it('cron ไม่ได้รันหลายวัน → รันย้อนตามวันจริงทีละขั้น (spec/01 §1.8) · pending_verification ไม่เปลี่ยนเอง', async () => {
    const t = await tenant('TRIALING', { trialEndsAt: bkk('2026-10-01 09:00') });
    const p = await tenant('PENDING_VERIFICATION', { trialEndsAt: bkk('2026-10-01 09:00') });
    await cronAt('2026-12-20 00:30');
    const h = await history(t.id);
    expect(h.map((x) => [x.fromStatus, x.toStatus])).toEqual([
      ['TRIALING', 'READ_ONLY'],
      ['READ_ONLY', 'SUSPENDED'],
      ['SUSPENDED', 'CANCELLED'],
    ]);
    // review N1: ประทับวันที่ขั้นนั้นมีผลจริง (00:30 ของวันที่ 1 / 15 / 61 นับจากวันหมด trial) + เหตุผลบอกว่าบันทึกย้อนหลัง
    expect(h.map((x) => x.at.toISOString())).toEqual([
      bkk('2026-10-02 00:30').toISOString(),
      bkk('2026-10-16 00:30').toISOString(),
      bkk('2026-12-01 00:30').toISOString(),
    ]);
    expect(h[0]!.reason).toContain('มีผลวันที่ 2026-10-02');
    const c = await statusOf(t.id);
    expect(c.cancelledAt!.toISOString()).toBe(bkk('2026-12-01 00:30').toISOString());
    // อีเมลเฉพาะขั้นสุดท้าย
    const mails = await db.emailOutbox.findMany({
      where: { tenantId: t.id, template: 'tenant_status_changed' },
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('ยกเลิก');
    expect((await statusOf(p.id)).status).toBe('PENDING_VERIFICATION');
  });

  describe('ค้างชำระ (PLT-011) + guard read_only', () => {
    let t: Awaited<ReturnType<typeof tenant>>;
    let token: string;
    beforeAll(async () => {
      t = await tenant('ACTIVE');
      token = await tokenFor(t.id);
    });

    it('ใบครบกำหนด 1 พ.ย. ไม่ชำระ → past_due → cron 9 พ.ย. = read_only และ POST /orders ได้ 403 tenant_read_only', async () => {
      clock.set(bkk('2026-11-02 10:00'));
      expect(await svc.markPastDue(t.id, '2026-11-01')).toBe(true);
      let s = await statusOf(t.id);
      expect(s).toMatchObject({ status: 'PAST_DUE', dunningKind: 'invoice' });
      expect(s.subscription!.status).toBe('past_due');
      // past_due ยังเขียนได้ (ตาราง 1.6)
      expect((await api(app, token).post('/v1/customers').send({})).body.code).not.toBe(
        'tenant_read_only',
      );
      await cronAt('2026-11-08 00:30');
      expect((await statusOf(t.id)).status).toBe('PAST_DUE');
      await cronAt('2026-11-09 00:30');
      s = await statusOf(t.id);
      expect(s.status).toBe('READ_ONLY');
      const r = await api(app, token).post('/v1/orders').send({});
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: 'tenant_read_only', tenantStatus: 'read_only' });
    });

    it('read_only: เขียนไม่ได้ทุก endpoint ตัวแทน · อ่านได้ · export / /me / ประมาณการเส้นทางได้', async () => {
      const a = api(app, token);
      const writes = [
        a.post('/v1/customers').send({ name: 'x' }),
        a.post('/v1/vehicles').send({}),
        a.post('/v1/trips').send({}),
        a.post('/v1/invoices').send({}),
        a.patch(`/v1/customers/${encodeId('customer', randomUUID())}`).send({ name: 'x' }),
        a.post('/v1/webhooks').send({}),
        a.patch('/v1/settings').send({}),
      ];
      for (const w of writes) {
        const r = await w;
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body.code, JSON.stringify(r.body)).toBe('tenant_read_only');
        expect(r.headers['content-type']).toContain('application/problem+json');
      }
      await a.get('/v1/customers').expect(200);
      await a.get('/v1/orders').expect(200);
      const me = await a.get('/v1/me').expect(200);
      expect(me.body.tenant.status).toBe('read_only');
      // export ได้ (ตาราง 1.6 "ดู/ค้นหา/พิมพ์/export")
      await a.post('/v1/exports').send({ resource: 'customers' }).expect(202);
      // POST ที่เป็นการอ่าน (@AllowReadOnlyTenant) ผ่าน guard (ไปตรวจ validation ต่อ)
      expect((await a.post('/v1/routes/estimate').send({})).body.code).not.toBe('tenant_read_only');
      // /me ยกเว้นจาก guard สถานะ
      expect((await a.post('/v1/me/notifications/read-all').send({})).body.code).not.toBe(
        'tenant_read_only',
      );
    });

    it('read_only ผู้ใช้ยัง login ได้ · ระงับ → ใช้ได้เฉพาะ /me ชำระเงิน export (ตาราง 1.6 — review S3)', async () => {
      const { access, secret } = await loginFull(app, t.email, 'owner-password-2569', '10.33.0.1');
      const srv = app.getHttpServer();
      await request(srv).get('/v1/me').set('Authorization', `Bearer ${access}`).expect(200);
      await cronAt('2026-11-23 00:30'); // วันที่ 22 → ระงับ
      expect((await statusOf(t.id)).status).toBe('SUSPENDED');
      const me = await request(srv).get('/v1/me').set('Authorization', `Bearer ${access}`);
      expect(me.status).toBe(200);
      expect(me.body.tenant.status).toBe('suspended');
      // login ใหม่ได้ (ตาราง 1.6 "L")
      await loginFull(app, t.email, 'owner-password-2569', '10.33.0.2', { secret });
      for (const r of [
        await request(srv).get('/v1/customers').set('Authorization', `Bearer ${access}`),
        await api(app, token).post('/v1/customers').send({}),
        await api(app, token).get('/v1/orders'),
      ]) {
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body).toMatchObject({ code: 'tenant_suspended', tenantStatus: 'suspended' });
      }
      // ขอ export ได้ · /v1/payments ยกเว้นตาม spec (ไปถึง validation/handler)
      await api(app, token).post('/v1/exports').send({ resource: 'customers' }).expect(202);
      expect((await api(app, token).get('/v1/payments')).body.code).not.toBe('tenant_suspended');
    });

    it('ชำระแล้ว (Console BILLING) → active ทันที ในคำขอเดียว (PLT-013) · ล้าง dunning · cron ถัดไปไม่เปลี่ยน', async () => {
      const R = 'ลูกค้าโอนชำระครบ ตรวจสลิปแล้ว';
      // review N4: ระงับเพราะค้างชำระ (ระบบ) ปลดระงับไม่ได้ — ต้องชำระ · Console ซ่อนปุ่ม (manualSuspension=false)
      await as('SUPER_ADMIN')
        .post(`/v1/platform/tenants/${t.ref}/reactivate`)
        .send({ reason: 'ลองปลดระงับเอง ไม่ควรได้' })
        .expect(409);
      expect(
        (await as('SUPPORT').get(`/v1/platform/tenants/${t.ref}`).expect(200)).body
          .manualSuspension,
      ).toBe(false);
      await as('SUPPORT')
        .post(`/v1/platform/tenants/${t.ref}/activate`)
        .send({ reason: R })
        .expect(403);
      await as('BILLING')
        .post(`/v1/platform/tenants/${t.ref}/activate`)
        .send({ reason: 'สั้น' })
        .expect(422);
      const started = Date.now();
      const r = await as('BILLING')
        .post(`/v1/platform/tenants/${t.ref}/activate`)
        .send({ reason: R })
        .expect(200);
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(r.body.status).toBe('active');
      const s = await statusOf(t.id);
      expect(s).toMatchObject({ status: 'ACTIVE', dunningKind: null, pastDueSince: null });
      expect(s.subscription!.status).toBe('active');
      expect((await api(app, token).post('/v1/customers').send({})).body.code).not.toBe(
        'tenant_read_only',
      );
      const last = (await history(t.id)).at(-1)!;
      expect(last).toMatchObject({
        fromStatus: 'SUSPENDED',
        toStatus: 'ACTIVE',
        actorType: 'platform_user',
        actorId: staffId.BILLING,
        reason: R,
      });
      expect(
        await db.auditLog.count({ where: { tenantId: t.id, action: 'platform.tenant_activated' } }),
      ).toBe(1);
      expect((await cronAt('2026-11-30 00:30')).transitions).toBe(0);
      expect((await statusOf(t.id)).status).toBe('ACTIVE');
      await as('BILLING')
        .post(`/v1/platform/tenants/${t.ref}/activate`)
        .send({ reason: R })
        .expect(409);
    });
  });

  it('ระยะทุกช่วงอ่านจาก PlatformSetting — dunning.pastDueDays = 3 → วันที่ 4 เป็น read_only', async () => {
    await owner.platformSetting.create({ data: { key: 'dunning.pastDueDays', value: 3 } });
    try {
      const t = await tenant('ACTIVE');
      clock.set(bkk('2026-12-01 09:00'));
      await svc.markPastDue(t.id, '2026-12-01');
      await cronAt('2026-12-04 00:30');
      expect((await statusOf(t.id)).status).toBe('PAST_DUE');
      await cronAt('2026-12-05 00:30');
      expect((await statusOf(t.id)).status).toBe('READ_ONLY');
    } finally {
      await owner.platformSetting.deleteMany({ where: { key: 'dunning.pastDueDays' } });
    }
  });

  it('การชำระชนะ cron (row lock + expectFrom): สถานะเปลี่ยนไปแล้ว → cron ข้าม', async () => {
    const t = await tenant('ACTIVE');
    clock.set(bkk('2026-12-01 09:00'));
    await svc.markPastDue(t.id, '2026-11-20');
    expect((await statusOf(t.id)).status).toBe('READ_ONLY'); // เดินต่อถึงวันนี้ทันที (วันที่ 11)
    const skipped = await svc.transition({
      tenantId: t.id,
      to: 'SUSPENDED',
      reason: 'cron เห็นสถานะเก่า',
      actor: { type: 'system' },
      expectFrom: 'PAST_DUE',
    });
    expect(skipped).toBeNull();
    expect((await statusOf(t.id)).status).toBe('READ_ONLY');
  });

  it('Console ระงับ/ปลดระงับ: กลับสถานะก่อนหน้า · SUPER_ADMIN เท่านั้น · รายละเอียดมีประวัติ + วันหมด trial', async () => {
    const t = await tenant('TRIALING', { trialEndsAt: bkk('2027-01-31 12:00') });
    const R = 'ตรวจพบการใช้งานผิดเงื่อนไขบริการ';
    await as('SUPPORT')
      .post(`/v1/platform/tenants/${t.ref}/suspend`)
      .send({ reason: R })
      .expect(403);
    await as('SUPER_ADMIN')
      .post(`/v1/platform/tenants/${t.ref}/suspend`)
      .send({ reason: R })
      .expect(200);
    const s = await statusOf(t.id);
    expect(s.status).toBe('SUSPENDED');
    expect(s.subscription!.status).toBe('trialing'); // ระงับด้วยมือ ไม่ใช่ค้างชำระ
    expect(
      (await as('SUPPORT').get(`/v1/platform/tenants/${t.ref}`).expect(200)).body.manualSuspension,
    ).toBe(true);
    await as('SUPER_ADMIN')
      .post(`/v1/platform/tenants/${t.ref}/reactivate`)
      .send({ reason: 'ลูกค้าชี้แจงแล้ว ปลดระงับ' })
      .expect(200);
    expect((await statusOf(t.id)).status).toBe('TRIALING');
    const d = (await as('SUPPORT').get(`/v1/platform/tenants/${t.ref}`).expect(200)).body;
    expect(d.trialEndsAt).toBe(bkk('2027-01-31 12:00').toISOString());
    expect(d).toHaveProperty('currentPeriodEnd'); // review S6 — วันต่ออายุเมื่อไม่ได้ทดลองใช้
    expect(d.statusHistory.map((h: { from: string; to: string }) => `${h.from}>${h.to}`)).toEqual([
      'suspended>trialing',
      'trialing>suspended',
    ]);
    expect(d.statusHistory[1]).toMatchObject({
      reason: R,
      actorType: 'platform_user',
      actorName: 'ทีม SUPER_ADMIN',
    });
    // อีเมลแจ้ง owner ทั้งสองครั้ง (PLT-103)
    expect(
      await db.emailOutbox.count({ where: { tenantId: t.id, template: 'tenant_status_changed' } }),
    ).toBe(2);
  });

  it('ยกเลิกแล้วกลับมาใช้งานได้ก่อนครบวันลบข้อมูล (PLT-018) — ล้าง cancelledAt/dataPurgeAt', async () => {
    const t = await tenant('ACTIVE');
    await svc.transition({
      tenantId: t.id,
      to: 'CANCELLED',
      reason: 'ลูกค้าขอยกเลิก (ทดสอบ)',
      actor: { type: 'system' },
    });
    // review N7: ยกเลิก → 403 tenant_cancelled (ขอ export ได้)
    const tok = await tokenFor(t.id);
    const r = await api(app, tok).get('/v1/customers');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('tenant_cancelled');
    await api(app, tok).post('/v1/exports').send({ resource: 'customers' }).expect(202);
    await as('SUPER_ADMIN')
      .post(`/v1/platform/tenants/${t.ref}/activate`)
      .send({ reason: 'ลูกค้ากลับมาชำระค่าบริการ' })
      .expect(200);
    expect(await statusOf(t.id)).toMatchObject({
      status: 'ACTIVE',
      cancelledAt: null,
      dataPurgeAt: null,
    });
  });

  it('สร้าง tenant จาก Console → แถวแรกของประวัติ (ใหม่ → trialing)', async () => {
    const r = await as('SUPER_ADMIN')
      .post('/v1/platform/tenants')
      .send({
        name: 'บริษัท ประวัติแรก จำกัด',
        ownerEmail: 'first@life.test',
        ownerName: 'คุณแรก',
        reason: 'ลูกค้านำร่องตามสัญญา',
      })
      .expect(201);
    expect(r.body.status).toBe('trialing');
    const tid = (await db.tenant.findFirstOrThrow({ where: { name: 'บริษัท ประวัติแรก จำกัด' } }))
      .id;
    expect((await history(tid)).map((h) => [h.fromStatus, h.toStatus, h.actorType])).toEqual([
      [null, 'TRIALING', 'platform_user'],
    ]);
  });

  it('version gate tenant.status_lifecycle (review S2): client ที่ pin ก่อน 2026-11-27 ได้สถานะ 4 ค่าเดิม', async () => {
    const t = await tenant('ACTIVE');
    const tok = await tokenFor(t.id);
    clock.set(null);
    await toReadOnly(t.id);
    expect((await statusOf(t.id)).status).toBe('READ_ONLY');
    const get = (v: string) => api(app, tok).get('/v1/me').set('X-Api-Version', v);
    expect((await get('2026-11-27').expect(200)).body.tenant.status).toBe('read_only');
    expect((await get('2026-11-18').expect(200)).body.tenant.status).toBe('active');
    const tr = await tenant('TRIALING');
    const old = await api(app, await tokenFor(tr.id))
      .get('/v1/me')
      .set('X-Api-Version', '2026-11-01')
      .expect(200);
    expect(old.body.tenant.status).toBe('trial');
  });

  describe('read_only: แอปคนขับปิดงานเฉพาะเที่ยวที่ออกวิ่งก่อนเปลี่ยนสถานะ + จองไฟล์ได้เฉพาะรูป/ลายเซ็น POD (review S1)', () => {
    let seed = 0;
    async function trip(tid: string) {
      const n = ++seed;
      const vt = await db.vehicleType.create({
        data: { tenantId: tid, code: `RO${n}`, nameTh: `6 ล้อ ${n}`, vehicleClass: '6W' },
      });
      const v = await db.vehicle.create({
        data: {
          tenantId: tid,
          plate: `72-${1000 + n}`,
          plateProvince: 'TH-10',
          plateKey: `72${1000 + n}|TH-10`,
          plateNorm: `72${1000 + n}`,
          vehicleTypeId: vt.id,
          ownership: 'OWN',
        },
      });
      const site = (k: string) =>
        db.customerSite.create({
          data: {
            tenantId: tid,
            code: `RO-${k}${n}`,
            name: `จุด ${k}${n}`,
            address: { line1: 'x' },
          },
        });
      const [a, b] = [await site('A'), await site('B')];
      const t = await db.trip.create({
        data: {
          tenantId: tid,
          tripNo: `TRP-RO-${n}`,
          tripDate: new Date(),
          status: 'DISPATCHED',
          dispatchedAt: new Date(),
          vehicleId: v.id,
          vehiclePlateSnapshot: v.plate,
          vehicleTypeId: vt.id,
        },
      });
      const stop = (sequence: number, siteId: string, type: 'PICKUP' | 'DELIVERY') =>
        db.tripStop.create({ data: { tenantId: tid, tripId: t.id, sequence, type, siteId } });
      return {
        trip: t,
        pickup: await stop(1, a.id, 'PICKUP'),
        drop: await stop(2, b.id, 'DELIVERY'),
      };
    }
    const url = (s: { id: string }, action: string) =>
      `/v1/stops/${encodeId('tripStop', s.id)}/${action}`;
    const ev = () => ({ clientEventId: randomUUID(), occurredAt: new Date().toISOString() });

    it('เที่ยวที่ถึงจุดแรกก่อน read_only ปิดงานต่อได้ · เที่ยวที่ยังไม่ออกวิ่ง 403 · จองไฟล์อื่นนอกจาก POD 403', async () => {
      clock.set(null);
      const t = await tenant('ACTIVE');
      const tok = await tokenFor(t.id);
      const running = await trip(t.id);
      const idle = await trip(t.id);
      await api(app, tok).post(url(running.pickup, 'arrive')).send(ev()).expect(201);
      expect((await db.trip.findUniqueOrThrow({ where: { id: running.trip.id } })).status).toBe(
        'IN_PROGRESS',
      );
      await new Promise((r) => setTimeout(r, 20));
      await toReadOnly(t.id);
      await api(app, tok).post(url(running.pickup, 'depart')).send(ev()).expect(201);
      const blocked = await api(app, tok).post(url(idle.pickup, 'arrive')).send(ev());
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('tenant_read_only');
      // POST /documents: รูป/ลายเซ็น POD ได้ · ไฟล์ชนิดอื่น 403
      await api(app, tok)
        .post('/v1/documents')
        .send({ kind: 'POD_PHOTO', mime: 'image/jpeg', bytes: 1000 })
        .expect(201);
      await api(app, tok)
        .post('/v1/documents')
        .send({ kind: 'POD_SIGNATURE', mime: 'image/png', bytes: 1000 })
        .expect(201);
      const other = await api(app, tok)
        .post('/v1/documents')
        .send({ kind: 'CONTRACT', mime: 'application/pdf', bytes: 1000 });
      expect(other.status).toBe(403);
      expect(other.body.code).toBe('tenant_read_only');
    });
  });

  it('review N10: ชำระพร้อม cron (Promise.all) → จบที่ active เสมอ ไม่มีขั้นหลัง active', async () => {
    for (let i = 0; i < 3; i++) {
      const t = await tenant('ACTIVE');
      clock.set(bkk('2026-12-15 09:00'));
      await svc.transition({
        tenantId: t.id,
        to: 'PAST_DUE',
        reason: 'ทดสอบชนกัน',
        actor: { type: 'system' },
        dunning: { kind: 'invoice', since: '2026-10-01' },
      });
      await Promise.all([
        svc.markPaid(t.id, 'ชำระพร้อม cron (ทดสอบ)', { type: 'system' }),
        svc.advance(t.id, '2026-12-15').catch(() => 0),
      ]);
      expect((await statusOf(t.id)).status).toBe('ACTIVE');
      expect((await history(t.id)).at(-1)!.toStatus).toBe('ACTIVE');
    }
  });

  it('แยก tenant: ประวัติสถานะ (RLS) — role แอปเห็นเฉพาะของตัวเอง และเขียน/แก้/ลบไม่ได้', async () => {
    const a = await tenant('ACTIVE');
    const b = await tenant('ACTIVE');
    await svc.suspend(a.id, 'ทดสอบแยกข้อมูลประวัติ', { type: 'system' });
    const dbs = app.get(DbService);
    expect(await dbs.withTenant(a.id, (tx) => tx.tenantStatusHistory.count())).toBe(1);
    expect(await dbs.withTenant(b.id, (tx) => tx.tenantStatusHistory.count())).toBe(0);
    expect(
      await dbs.withTenant(b.id, (tx) =>
        tx.tenantStatusHistory.count({ where: { tenantId: a.id } }),
      ),
    ).toBe(0);
    const priv = await db.$queryRaw<{ ins: boolean; upd: boolean; del: boolean }[]>`
      SELECT has_table_privilege('tms_app', 'tenant_status_history', 'INSERT') AS ins,
             has_table_privilege('tms_app', 'tenant_status_history', 'UPDATE') AS upd,
             has_table_privilege('tms_app', 'tenant_status_history', 'DELETE') AS del`;
    expect(priv[0]).toEqual({ ins: false, upd: false, del: false });
    // append-only แม้ role platform
    await expect(
      db.tenantStatusHistory.deleteMany({ where: { tenantId: a.id } }),
    ).rejects.toThrow();
  });
});
