import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { pkceChallenge } from '../src/auth/tokens';
import { currentStep, hotp } from '../src/auth/totp';
import { encodeId } from '../src/common/ids';
import { api, bootApp, createTenant, loginFull, platform, truncateAll } from './helpers';

/** ST1-T05 2FA TOTP + backup code + จำอุปกรณ์ + step-up; ST1-T12 เปลี่ยน role ต้อง step-up */
describe('2FA', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let roleIds: Record<string, string>;
  let ip = 0;
  const PW = 'mfa-test-password-2569';
  const nextIp = () => `10.20.${Math.floor(++ip / 250)}.${ip % 250}`;
  const srv = () => app.getHttpServer();

  async function user(email: string, role: string) {
    const u = await db.appUser.create({
      data: {
        tenantId,
        email,
        name: `ทดสอบ ${role}`,
        status: 'ACTIVE',
        passwordHash: await hashPassword(PW),
      },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roleIds[role]! } });
    return u;
  }
  const start = (email: string, cookie?: string) => {
    const v = randomBytes(32).toString('base64url');
    const r = request(srv()).post('/v1/auth/login').set('X-Forwarded-For', nextIp());
    if (cookie) r.set('Cookie', cookie);
    return r
      .send({ email, password: PW, codeChallenge: pkceChallenge(v) })
      .then((res) => ({ res, v }));
  };
  const exchange = (code: string, v: string) =>
    request(srv())
      .post('/v1/oauth/token')
      .send({ grantType: 'authorization_code', code, codeVerifier: v });

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    roleIds = await ensureSystemRoles(db, tenantId);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('role ที่ไม่บังคับ (planner) login ได้เลยโดยไม่ต้อง 2FA', async () => {
    await user('planner@mfa.test', 'planner');
    const { res } = await start('planner@mfa.test');
    expect(res.status).toBe(200);
    expect(res.body.code).toBeTruthy();
  });

  it('owner ยังไม่ตั้ง → ต้องตั้งก่อนเข้า; ตั้งแล้วได้ code + backup code 10 ชุด; secret เก็บแบบเข้ารหัส', async () => {
    const u = await user('owner@mfa.test', 'owner');
    const { res, v } = await start('owner@mfa.test');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('mfa_enrollment_required');
    // ยังไม่ผ่าน 2FA ห้ามได้ code
    expect(res.body).not.toHaveProperty('code', expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/));
    const s = await request(srv())
      .post('/v1/auth/2fa/enroll')
      .send({ mfaToken: res.body.mfaToken })
      .expect(200);
    expect(s.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/TMS%3Aowner%40mfa\.test\?secret=/);
    const bad = await request(srv())
      .post('/v1/auth/2fa/enroll/confirm')
      .send({ mfaToken: res.body.mfaToken, otp: '000000' });
    expect(bad.status).toBe(401);
    const ok = await request(srv())
      .post('/v1/auth/2fa/enroll/confirm')
      .send({ mfaToken: res.body.mfaToken, otp: hotp(s.body.secret, currentStep()) })
      .expect(200);
    expect(ok.body.backupCodes).toHaveLength(10);
    expect(new Set(ok.body.backupCodes).size).toBe(10);
    await exchange(ok.body.code, v).expect(200);
    const row = await db.appUser.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.totpEnabledAt).not.toBeNull();
    expect(row.totpSecret).toMatch(/^v1\./);
    expect(row.totpSecret).not.toContain(s.body.secret);
    // mfaToken ใช้ซ้ำไม่ได้
    const again = await request(srv())
      .post('/v1/auth/2fa/enroll/confirm')
      .send({ mfaToken: res.body.mfaToken, otp: hotp(s.body.secret, currentStep() + 1) });
    expect(again.status).toBe(401);
  });

  it('ตั้งแล้ว: login ต้องกรอก TOTP; รหัสเดิมใช้ซ้ำไม่ได้; ผิด 5 ครั้ง challenge ใช้ต่อไม่ได้', async () => {
    await user('acc@mfa.test', 'accounting');
    const first = await loginFull(app, 'acc@mfa.test', PW, nextIp());
    const { res, v } = await start('acc@mfa.test');
    expect(res.body.code).toBe('mfa_required');
    const otp = hotp(first.secret!, currentStep() + 1);
    const ok = await request(srv())
      .post('/v1/auth/2fa/verify')
      .send({ mfaToken: res.body.mfaToken, otp })
      .expect(200);
    await exchange(ok.body.code, v).expect(200);
    const second = await start('acc@mfa.test');
    const reuse = await request(srv())
      .post('/v1/auth/2fa/verify')
      .send({ mfaToken: second.res.body.mfaToken, otp });
    expect(reuse.status).toBe(401);
    for (let i = 0; i < 4; i++)
      await request(srv())
        .post('/v1/auth/2fa/verify')
        .send({ mfaToken: second.res.body.mfaToken, otp: '111111' });
    const dead = await request(srv())
      .post('/v1/auth/2fa/verify')
      .send({ mfaToken: second.res.body.mfaToken, otp: hotp(first.secret!, currentStep()) });
    expect(dead.status).toBe(401);
  });

  it('backup code ใช้ได้ครั้งเดียว', async () => {
    await user('admin@mfa.test', 'admin');
    const { res, v } = await start('admin@mfa.test');
    const s = await request(srv())
      .post('/v1/auth/2fa/enroll')
      .send({ mfaToken: res.body.mfaToken });
    const done = await request(srv())
      .post('/v1/auth/2fa/enroll/confirm')
      .send({ mfaToken: res.body.mfaToken, otp: hotp(s.body.secret, currentStep()) });
    await exchange(done.body.code, v).expect(200);
    const bc = done.body.backupCodes[0] as string;
    const a = await start('admin@mfa.test');
    await request(srv())
      .post('/v1/auth/2fa/verify')
      .send({ mfaToken: a.res.body.mfaToken, backupCode: bc.toUpperCase() })
      .expect(200);
    const b = await start('admin@mfa.test');
    expect(
      (
        await request(srv())
          .post('/v1/auth/2fa/verify')
          .send({ mfaToken: b.res.body.mfaToken, backupCode: bc })
      ).status,
    ).toBe(401);
  });

  it('จำอุปกรณ์ 30 วัน: login ครั้งถัดไปข้าม TOTP; bump tokenVersion แล้วต้องกรอกใหม่', async () => {
    const u = await user('remember@mfa.test', 'owner');
    const first = await loginFull(app, 'remember@mfa.test', PW, nextIp());
    const { res } = await start('remember@mfa.test');
    const ok = await request(srv())
      .post('/v1/auth/2fa/verify')
      .send({
        mfaToken: res.body.mfaToken,
        otp: hotp(first.secret!, currentStep() + 1),
        rememberDevice: true,
      })
      .expect(200);
    const raw = (ok.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('tms_td='),
    )!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\/v1\/auth/);
    const cookie = raw.split(';')[0]!;
    const skip = await start('remember@mfa.test', cookie);
    expect(skip.res.status).toBe(200);
    await db.appUser.update({ where: { id: u.id }, data: { tokenVersion: { increment: 1 } } });
    expect((await start('remember@mfa.test', cookie)).res.body.code).toBe('mfa_required');
  });

  it('เปลี่ยน role ต้อง step-up; สำเร็จแล้ว session เดิมของผู้ถูกเปลี่ยนหลุด; ลบ owner คนสุดท้ายไม่ได้', async () => {
    await user('boss@mfa.test', 'owner');
    const o = await loginFull(app, 'boss@mfa.test', PW, nextIp());
    const target = await user('target@mfa.test', 'viewer');
    const t = await loginFull(app, 'target@mfa.test', PW, nextIp());
    const url = `/v1/users/${encodeId('user', target.id)}/roles`;
    const body = { roles: ['planner'], reason: 'ย้ายฝ่าย' };
    const no = await api(app, o.access).put(url).send(body);
    expect(no.status).toBe(403);
    expect(no.body.code).toBe('step_up_required');
    const bad = await api(app, o.access).post('/v1/auth/step-up').send({ otp: '123456' });
    expect(bad.status).toBe(401);
    const su = await api(app, o.access)
      .post('/v1/auth/step-up')
      .send({ otp: hotp(o.secret!, currentStep() + 1) })
      .expect(200);
    const done = await api(app, o.access)
      .put(url)
      .set('X-Step-Up', su.body.stepUpToken)
      .send(body)
      .expect(200);
    expect(done.body.roles.map((r: { code: string }) => r.code)).toEqual(['planner']);
    expect((await api(app, t.access).get('/v1/me')).status).toBe(401);
    const audit = await db.auditLog.findFirst({
      where: { action: 'user.role_changed', entityId: target.id },
    });
    expect(audit).toMatchObject({
      before: { roles: ['viewer'] },
      after: { roles: ['planner'] },
      reason: 'ย้ายฝ่าย',
    });
    // step-up token ใช้เป็น access token ไม่ได้
    expect((await api(app, su.body.stepUpToken).get('/v1/me')).status).toBe(401);
  });

  it('ห้ามเหลือ owner 0 คน', async () => {
    const t2 = (await createTenant(db)).id;
    const ids = await ensureSystemRoles(db, t2);
    const u = await db.appUser.create({
      data: {
        tenantId: t2,
        email: 'solo@mfa.test',
        name: 'คนเดียว',
        status: 'ACTIVE',
        passwordHash: await hashPassword(PW),
      },
    });
    await db.userRole.create({ data: { tenantId: t2, userId: u.id, roleId: ids.owner! } });
    const o = await loginFull(app, 'solo@mfa.test', PW, nextIp());
    const su = await api(app, o.access)
      .post('/v1/auth/step-up')
      .send({ otp: hotp(o.secret!, currentStep() + 1) })
      .expect(200);
    const res = await api(app, o.access)
      .put(`/v1/users/${encodeId('user', u.id)}/roles`)
      .set('X-Step-Up', su.body.stepUpToken)
      .send({ roles: ['admin'], reason: 'ทดสอบ' });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('last_owner');
  });

  it('GET /me/2fa บอกสถานะ; role แอปอ่านตาราง 2FA ไม่ได้', async () => {
    const p = await loginFull(app, 'planner@mfa.test', PW, nextIp());
    const st = await api(app, p.access).get('/v1/me/2fa').expect(200);
    expect(st.body).toEqual({ enabled: false, required: false, backupCodesRemaining: 0 });
    const { PrismaService } = await import('../src/db/prisma.service');
    const ps = new PrismaService();
    await expect(
      ps.app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.$queryRaw`SELECT * FROM backup_code`;
      }),
    ).rejects.toThrow(/permission denied/);
    await ps.onModuleDestroy();
  });
});
