import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { signStepUpToken } from '../src/auth/tokens';
import { EmailDispatcher } from '../src/modules/email/email.service';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { MemoryTransport } from '../src/modules/email/transport';
import { api, bootApp, createTenant, loginFull, platform, tokenFor, truncateAll } from './helpers';

/** ST1-T07: เชิญ → รับลิงก์ → ตั้งรหัส → เข้าได้ด้วย role ที่กำหนด; เกิน seat ถูกปฏิเสธ */
describe('user invitations', () => {
  let app: NestExpressApplication;
  const db = platform();
  let mail: MemoryTransport;
  let dispatcher: EmailDispatcher;
  let tA: string;
  let tB: string;
  let ownerA: string;
  let adminA: string;
  let n = 0;
  const ip = () => `10.71.${Math.floor(++n / 250)}.${n % 250}`;

  /** ผู้เรียกในนาม user จริง (actor) + step-up */
  async function as(tenantId: string, userId: string, stepUp = true) {
    const token = await tokenFor(tenantId, '*', userId);
    const su = stepUp ? await signStepUpToken(userId, tenantId) : undefined;
    const a = api(app, token);
    return {
      invite: (body: object) => {
        const r = a.post('/v1/users/invitations').send(body);
        return su ? r.set('X-Step-Up', su) : r;
      },
      list: () => a.get('/v1/users/invitations'),
      resend: (id: string) => a.post(`/v1/users/invitations/${id}/resend`).send({}),
      revoke: (id: string, reason = 'เชิญผิดคน') =>
        a.post(`/v1/users/invitations/${id}/revoke`).send({ reason }),
      users: () => a.get('/v1/users'),
    };
  }
  async function tokenOf(to: string): Promise<string> {
    await dispatcher.drain();
    const m = [...mail.sent].reverse().find((x) => x.to === to);
    const t = /invite#token=([A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1];
    if (!t) throw new Error(`no invite mail for ${to}`);
    return t;
  }
  /** ย้อนเวลาสร้างคำเชิญ (ข้าม cooldown ส่งใหม่) */
  const backdate = (email: string) =>
    db.userInvitation.updateMany({
      where: { email },
      data: { createdAt: new Date(Date.now() - 120_000) },
    });
  const pub = (path: string, body: object) =>
    request(app.getHttpServer())
      .post(`/v1/auth/invitations/${path}`)
      .set('X-Forwarded-For', ip())
      .send(body);

  async function member(
    tenantId: string,
    email: string,
    role: string,
    pw = 'member-password-2569',
  ) {
    const roles = await ensureSystemRoles(db, tenantId);
    const u = await db.appUser.create({
      data: {
        tenantId,
        email,
        name: email,
        status: 'ACTIVE',
        passwordHash: await hashPassword(pw),
      },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles[role]! } });
    return u.id;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    dispatcher = app.get(EmailDispatcher);
    tA = (await createTenant(db, 'บริษัท เอ ขนส่ง จำกัด')).id;
    tB = (await createTenant(db, 'บริษัท บี ขนส่ง จำกัด')).id;
    ownerA = await member(tA, 'owner@inv.test', 'owner');
    adminA = await member(tA, 'admin@inv.test', 'admin');
    await member(tB, 'existing@inv.test', 'planner', 'existing-password-2569');
  });
  beforeEach(() => {
    mail = new MemoryTransport();
    dispatcher.use(mail);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('เชิญ → อีเมล → ตั้งรหัส → login ได้ด้วย role ที่กำหนด', async () => {
    const o = await as(tA, ownerA);
    const r = await o.invite({ email: 'New.Person@inv.test', name: 'คนใหม่', roles: ['planner'] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      email: 'new.person@inv.test',
      roles: ['planner'],
      status: 'pending',
    });
    expect(r.body.id).toMatch(/^inv_/);
    const exp = new Date(r.body.expiresAt).getTime() - Date.now();
    expect(exp).toBeGreaterThan(6.99 * 86400_000);
    expect(exp).toBeLessThanOrEqual(7 * 86400_000);
    const token = await tokenOf('new.person@inv.test');
    expect(mail.sent[0]!.subject).toBe('คำเชิญเข้าร่วม บริษัท เอ ขนส่ง จำกัด — TMS');
    expect(mail.sent[0]!.text).toContain('ผู้วางแผน');
    // ยังไม่รับ → login ไม่ได้
    await expect(loginFull(app, 'new.person@inv.test', 'x', ip())).rejects.toThrow(/401/);
    const info = await pub('inspect', { token });
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({
      email: 'new.person@inv.test',
      tenantName: 'บริษัท เอ ขนส่ง จำกัด',
      roles: ['ผู้วางแผน'],
      existingAccount: false,
    });
    expect((await pub('accept', { token, password: 'short' })).body.errors[0].code).toBe(
      'password_too_short',
    );
    await pub('accept', { token, password: 'new-person-pass-2569', name: 'คนใหม่ จริง' }).expect(
      204,
    );
    const s = await loginFull(app, 'new.person@inv.test', 'new-person-pass-2569', ip());
    const me = await api(app, s.access).get('/v1/me');
    expect(me.body.user).toMatchObject({ name: 'คนใหม่ จริง', roles: ['ผู้วางแผน'] });
    expect(
      await db.auditLog.count({
        where: { tenantId: tA, action: { in: ['user.invited', 'user.joined'] } },
      }),
    ).toBe(2);
    // ใช้ลิงก์ซ้ำไม่ได้
    expect((await pub('accept', { token, password: 'another-pass-2569' })).body.code).toBe(
      'invitation_invalid',
    );
    expect((await pub('inspect', { token })).status).toBe(400);
  });

  it('ต้อง step-up และสิทธิ์ users:write', async () => {
    const noSu = await as(tA, adminA, false);
    const r = await noSu.invite({ email: 'x@inv.test', name: 'x', roles: ['viewer'] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('step_up_required');
    const viewer = api(app, await tokenFor(tA, 'users:read', adminA));
    expect(
      (
        await viewer
          .post('/v1/users/invitations')
          .send({ email: 'x@inv.test', name: 'x', roles: ['viewer'] })
      ).status,
    ).toBe(403);
  });

  it('admin มอบ owner ไม่ได้ (owner เท่านั้น)', async () => {
    const a = await as(tA, adminA);
    const r = await a.invite({ email: 'boss@inv.test', name: 'boss', roles: ['owner'] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('permission_denied');
  });

  it('อีเมลที่เป็นสมาชิก/เชิญอยู่แล้ว → 409 already_member', async () => {
    const o = await as(tA, ownerA);
    expect(
      (await o.invite({ email: 'ADMIN@inv.test', name: 'a', roles: ['viewer'] })).body.code,
    ).toBe('already_member');
    await o.invite({ email: 'twice@inv.test', name: 't', roles: ['viewer'] }).expect(201);
    const r = await o.invite({ email: 'twice@inv.test', name: 't', roles: ['viewer'] });
    expect(r.status).toBe(409);
    expect(r.body.userStatus).toBe('invited');
  });

  it('เกิน seat ตามแพ็กเกจ → 409 seat_limit_reached (นับ ACTIVE + INVITED)', async () => {
    const used = await db.appUser.count({
      where: { tenantId: tA, status: { in: ['ACTIVE', 'INVITED'] } },
    });
    await db.tenantEntitlementOverride.create({
      data: {
        tenantId: tA,
        featureKey: 'users',
        mode: 'set_limit',
        limit: used + 1,
        reason: 'ทดสอบจำนวนผู้ใช้',
      },
    });
    app.get(EntitlementService).invalidate(tA);
    try {
      const o = await as(tA, ownerA);
      await o.invite({ email: 'seat1@inv.test', name: 's1', roles: ['viewer'] }).expect(201);
      const r = await o.invite({ email: 'seat2@inv.test', name: 's2', roles: ['viewer'] });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'seat_limit_reached', limit: used + 1 });
    } finally {
      await db.tenantEntitlementOverride.deleteMany({
        where: { tenantId: tA, featureKey: 'users' },
      });
      app.get(EntitlementService).invalidate(tA);
    }
  });

  it('มีบัญชีในบริษัทอื่นแล้ว → รับด้วยรหัสเดิม (รหัสผิด 422) แล้วเลือกบริษัทตอน login', async () => {
    const o = await as(tA, ownerA);
    await o
      .invite({ email: 'existing@inv.test', name: 'มีบัญชี', roles: ['dispatcher'] })
      .expect(201);
    const token = await tokenOf('existing@inv.test');
    expect((await pub('inspect', { token })).body.existingAccount).toBe(true);
    expect(
      (await pub('accept', { token, password: 'whatever-pass-2569' })).body.errors[0].field,
    ).toBe('currentPassword');
    expect(
      (await pub('accept', { token, currentPassword: 'wrong-password-2569' })).body.errors[0].code,
    ).toBe('password_incorrect');
    await pub('accept', { token, currentPassword: 'existing-password-2569' }).expect(204);
    const r = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('X-Forwarded-For', ip())
      .send({
        email: 'existing@inv.test',
        password: 'existing-password-2569',
        codeChallenge: 'x'.repeat(43),
      });
    expect(r.status).toBe(409);
    expect(r.body.tenants).toHaveLength(2);
  });

  it('ส่งใหม่: ลิงก์เดิมใช้ไม่ได้ ลิงก์ใหม่ใช้ได้; เพิกถอน: ลิงก์ใช้ไม่ได้และผู้ใช้หายจากรายการ', async () => {
    const o = await as(tA, ownerA);
    const inv = (await o.invite({ email: 'resend@inv.test', name: 'r', roles: ['viewer'] })).body;
    const first = await tokenOf('resend@inv.test');
    // ส่งใหม่ทันทีไม่ได้ (cooldown 60 วิ)
    const early = await o.resend(inv.id);
    expect(early.status).toBe(429);
    expect(Number(early.headers['retry-after'])).toBeGreaterThan(0);
    await backdate('resend@inv.test');
    const again = await o.resend(inv.id);
    expect(again.status).toBe(200);
    const second = await tokenOf('resend@inv.test');
    expect(second).not.toBe(first);
    expect((await pub('inspect', { token: first })).body.code).toBe('invitation_invalid');
    expect((await pub('inspect', { token: second })).status).toBe(200);
    expect(
      (await o.list()).body.data.some((x: { email: string }) => x.email === 'resend@inv.test'),
    ).toBe(true);
    await o.revoke(again.body.id).expect(204);
    expect((await pub('inspect', { token: second })).body.code).toBe('invitation_invalid');
    expect(
      (await o.list()).body.data.some((x: { email: string }) => x.email === 'resend@inv.test'),
    ).toBe(false);
    expect(
      (await o.users()).body.data.some((x: { email: string }) => x.email === 'resend@inv.test'),
    ).toBe(false);
    // อีเมลจริงไม่เหลือในประวัติคำเชิญ/audit (PDPA)
    expect(await db.userInvitation.count({ where: { email: 'resend@inv.test' } })).toBe(0);
    const audits = await db.auditLog.findMany({ where: { tenantId: tA } });
    expect(JSON.stringify(audits.map((a) => [a.before, a.after, a.reason]))).not.toContain(
      'resend@inv.test',
    );
    // เพิกถอนแล้วเชิญอีเมลเดิมใหม่ได้
    await o.invite({ email: 'resend@inv.test', name: 'r', roles: ['viewer'] }).expect(201);
    // เพิกถอนต้องมีเหตุผล / ทำซ้ำไม่ได้
    expect((await o.revoke(again.body.id, '')).status).toBe(422);
    expect((await o.revoke(again.body.id)).status).toBe(409);
  });

  it('หมดอายุ 7 วัน → ใช้ไม่ได้ แต่ส่งใหม่ได้', async () => {
    const o = await as(tA, ownerA);
    const inv = (await o.invite({ email: 'late@inv.test', name: 'l', roles: ['viewer'] })).body;
    const token = await tokenOf('late@inv.test');
    await db.userInvitation.updateMany({
      where: { email: 'late@inv.test' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await pub('accept', { token, password: 'late-person-pass-2569' })).body.code).toBe(
      'invitation_invalid',
    );
    expect((await o.list()).body.data.find((x: { id: string }) => x.id === inv.id).status).toBe(
      'expired',
    );
    await backdate('late@inv.test');
    await o.resend(inv.id).expect(200);
    await pub('accept', {
      token: await tokenOf('late@inv.test'),
      password: 'late-person-pass-2569',
    }).expect(204);
  });

  it('บริษัทถูกระงับ → ลิงก์ใช้ไม่ได้; รับพร้อมกันสำเร็จครั้งเดียว', async () => {
    const o = await as(tA, ownerA);
    await o.invite({ email: 'race@inv.test', name: 'race', roles: ['viewer'] }).expect(201);
    const token = await tokenOf('race@inv.test');
    await db.tenant.update({ where: { id: tA }, data: { status: 'SUSPENDED' } });
    expect((await pub('inspect', { token })).body.code).toBe('invitation_invalid');
    await db.tenant.update({ where: { id: tA }, data: { status: 'ACTIVE' } });
    const rs = await Promise.all(
      [1, 2, 3].map((i) => pub('accept', { token, password: `race-person-pass-${i}-2569` })),
    );
    expect(rs.filter((r) => r.status === 204)).toHaveLength(1);
  });

  it('แยก tenant: tenant B มองไม่เห็นคำเชิญของ A; token มั่ว → 400', async () => {
    const ownerB = await member(tB, 'ownerb@inv.test', 'owner');
    const b = await as(tB, ownerB);
    const list = (await b.list()).body.data as { email: string }[];
    expect(list.some((x) => x.email.endsWith('@inv.test') && x.email !== 'ownerb@inv.test')).toBe(
      false,
    );
    expect((await pub('inspect', { token: 'nope' })).body.code).toBe('invitation_invalid');
  });

  it('owner invitation: admin เพิกถอนไม่ได้, owner ทำได้', async () => {
    const o = await as(tA, ownerA);
    const inv = (await o.invite({ email: 'co-owner@inv.test', name: 'co', roles: ['owner'] })).body;
    const a = await as(tA, adminA);
    expect((await a.revoke(inv.id)).status).toBe(403);
    await o.revoke(inv.id).expect(204);
  });

  it('เพิกถอนหลังผู้รับกดรับแล้ว → 409 ผู้ใช้ไม่ถูกลบ', async () => {
    const o = await as(tA, ownerA);
    const inv = (await o.invite({ email: 'late-revoke@inv.test', name: 'lr', roles: ['viewer'] }))
      .body;
    await pub('accept', {
      token: await tokenOf('late-revoke@inv.test'),
      password: 'late-revoke-pass-2569',
    }).expect(204);
    expect((await o.revoke(inv.id)).status).toBe(409);
    expect((await db.appUser.findFirst({ where: { email: 'late-revoke@inv.test' } }))?.status).toBe(
      'ACTIVE',
    );
  });

  it('role ซ้ำในรายการ → 422; ชื่อที่มี URL ถูกตัดออกจากอีเมล', async () => {
    const o = await as(tA, ownerA);
    expect(
      (await o.invite({ email: 'dup@inv.test', name: 'd', roles: ['viewer', 'viewer'] })).status,
    ).toBe(422);
    const { safeName } = await import('../src/common/safe-text');
    expect(safeName('บริษัท ดี ยืนยันที่ https://evil.example/x ด่วน')).toBe(
      'บริษัท ดี ยืนยันที่ ด่วน',
    );
    expect(safeName('กดที่ www.evil.com เลย')).toBe('กดที่ เลย');
    expect(safeName('ไปที่ evil.co.th/login')).toBe('ไปที่');
    expect(safeName('ABC Co.,Ltd.')).toBe('ABC Co.,Ltd.');
  });

  it('เชิญ+ส่งใหม่เกิน 50 ฉบับ/วัน → 429; เปิดใช้คืนเกิน seat → 409', async () => {
    const o = await as(tA, ownerA);
    const fakeUser = await db.appUser.create({
      data: { tenantId: tA, email: 'cap-filler@inv.test', name: 'f', status: 'DISABLED' },
    });
    const count = await db.userInvitation.count({ where: { tenantId: tA } });
    await db.userInvitation.createMany({
      data: Array.from({ length: Math.max(0, 50 - count) }, (_, i) => ({
        tenantId: tA,
        userId: fakeUser.id,
        email: 'cap-filler@inv.test',
        tokenHash: `cap-${i}-${Date.now()}`,
        expiresAt: new Date(Date.now() + 86400_000),
        revokedAt: new Date(),
      })),
    });
    const r = await o.invite({ email: 'over-cap@inv.test', name: 'o', roles: ['viewer'] });
    expect(r.status).toBe(429);
    // seat ตอนเปิดใช้คืน
    const used = await db.appUser.count({
      where: { tenantId: tA, status: { in: ['ACTIVE', 'INVITED'] } },
    });
    await db.tenantEntitlementOverride.create({
      data: {
        tenantId: tA,
        featureKey: 'users',
        mode: 'set_limit',
        limit: used,
        reason: 'ทดสอบจำนวนผู้ใช้',
      },
    });
    app.get(EntitlementService).invalidate(tA);
    try {
      const act = await api(app, await tokenFor(tA, '*', ownerA))
        .post(`/v1/users/usr_${fakeUser.id.replace(/-/g, '')}/activate`)
        .send({ reason: 'กลับมาทำงาน' });
      expect(act.status).toBe(409);
      expect(act.body.code).toBe('seat_limit_reached');
    } finally {
      await db.tenantEntitlementOverride.deleteMany({
        where: { tenantId: tA, featureKey: 'users' },
      });
      app.get(EntitlementService).invalidate(tA);
    }
  });
});
