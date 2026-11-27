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
    expect((await history(t.id)).map((x) => [x.fromStatus, x.toStatus])).toEqual([
      ['TRIALING', 'READ_ONLY'],
      ['READ_ONLY', 'SUSPENDED'],
      ['SUSPENDED', 'CANCELLED'],
    ]);
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
        expect(r.status, r.req.path).toBe(403);
        expect(r.body.code, r.req.path).toBe('tenant_read_only');
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

    it('read_only ผู้ใช้ยัง login ได้ (ตาราง 1.6) · ระงับ → token เดิมใช้ไม่ได้ทันที + login ไม่ได้', async () => {
      const { access } = await loginFull(app, t.email, 'owner-password-2569', '10.33.0.1');
      const srv = app.getHttpServer();
      await request(srv).get('/v1/me').set('Authorization', `Bearer ${access}`).expect(200);
      await cronAt('2026-11-23 00:30'); // วันที่ 22 → ระงับ
      expect((await statusOf(t.id)).status).toBe('SUSPENDED');
      await request(srv).get('/v1/me').set('Authorization', `Bearer ${access}`).expect(401);
      // token dev (ไม่ผ่าน session) เขียน → tenant_suspended
      const w = await api(app, token).post('/v1/customers').send({});
      expect(w.status).toBe(403);
      expect(w.body.code).toBe('tenant_suspended');
    });

    it('ชำระแล้ว (Console BILLING) → active ทันที ในคำขอเดียว (PLT-013) · ล้าง dunning · cron ถัดไปไม่เปลี่ยน', async () => {
      const R = 'ลูกค้าโอนชำระครบ ตรวจสลิปแล้ว';
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
    await as('SUPER_ADMIN')
      .post(`/v1/platform/tenants/${t.ref}/reactivate`)
      .send({ reason: 'ลูกค้าชี้แจงแล้ว ปลดระงับ' })
      .expect(200);
    expect((await statusOf(t.id)).status).toBe('TRIALING');
    const d = (await as('SUPPORT').get(`/v1/platform/tenants/${t.ref}`).expect(200)).body;
    expect(d.trialEndsAt).toBe(bkk('2027-01-31 12:00').toISOString());
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
