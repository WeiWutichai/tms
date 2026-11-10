import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { signDevToken } from '../src/auth/auth.guard';
import { isLocalEnv, pkceChallenge, verifyAccessToken } from '../src/auth/tokens';
import { encodeId } from '../src/common/ids';
import { bootApp, createTenant, platform, truncateAll } from './helpers';

/** ST1-T01 (login + ล็อก) และ ST1-T04 (session: PKCE, refresh หมุน, tokenVersion) */
describe('auth: login + Auth Code/PKCE + refresh', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantA: string;
  let tenantB: string;
  let ipSeq = 0;
  const PW = 'correct horse battery staple';

  const nextIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  const verifier = () => randomBytes(32).toString('base64url');

  async function makeUser(tenantId: string, email: string, opts: { roles?: string[] } = {}) {
    const user = await db.appUser.create({
      data: {
        tenantId,
        email,
        name: 'ผู้ใช้ทดสอบ',
        status: 'ACTIVE',
        passwordHash: await hashPassword(PW),
      },
    });
    for (const code of opts.roles ?? ['owner']) {
      const role = await db.role.upsert({
        where: { tenantId_code: { tenantId, code } },
        create: { tenantId, code, nameTh: code, permissions: ['*'], isSystem: true },
        update: {},
      });
      await db.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    }
    return user;
  }

  function login(body: Record<string, unknown>, ip: string) {
    return request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send(body);
  }

  /** login → code → token; คืน access token และ cookie */
  async function fullLogin(email: string, ip = nextIp(), extra: Record<string, unknown> = {}) {
    const v = verifier();
    const r1 = await login({ email, password: PW, codeChallenge: pkceChallenge(v), ...extra }, ip);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const r2 = await request(app.getHttpServer())
      .post('/v1/oauth/token')
      .send({ grantType: 'authorization_code', code: r1.body.code, codeVerifier: v });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    const cookie = (r2.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('tms_rt='),
    )!;
    return {
      access: r2.body.accessToken as string,
      cookie: cookie.split(';')[0]!,
      rawCookie: cookie,
    };
  }

  const me = (token: string) =>
    request(app.getHttpServer()).get('/v1/me').set('Authorization', `Bearer ${token}`);
  const refresh = (cookie: string) =>
    request(app.getHttpServer())
      .post('/v1/oauth/token')
      .set('Cookie', cookie)
      .send({ grantType: 'refresh_token' });

  beforeAll(async () => {
    await truncateAll();
    tenantA = (await createTenant(db, 'บริษัท เอ')).id;
    tenantB = (await createTenant(db, 'บริษัท บี')).id;
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('login สำเร็จ → access token เรียก /v1/me ได้ และ refresh cookie เป็น httpOnly', async () => {
    const u = await makeUser(tenantA, 'ok@example.co.th');
    const { access, rawCookie } = await fullLogin('OK@Example.co.th');
    expect(rawCookie).toMatch(/HttpOnly/i);
    expect(rawCookie).toMatch(/SameSite=Strict/i);
    expect(rawCookie).toMatch(/Path=\/v1\/oauth/);
    const r = await me(access);
    expect(r.status).toBe(200);
    expect(r.body.actorId).toBe(u.id);
    expect(r.body.tenant.id).toBe(encodeId('tenant', tenantA));
    const hist = await db.loginAttempt.findFirst({ where: { userId: u.id, success: true } });
    expect(hist?.tenantId).toBe(tenantA);
  });

  it('hash ในฐานข้อมูลเป็น argon2id', async () => {
    const u = await db.appUser.findFirst({ where: { email: 'ok@example.co.th' } });
    expect(u?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('อีเมลไม่มีในระบบ กับ รหัสผิด ได้คำตอบเดียวกัน (ไม่เผยว่ามีบัญชี)', async () => {
    await makeUser(tenantA, 'exists@example.co.th');
    const c = pkceChallenge(verifier());
    const a = await login(
      { email: 'exists@example.co.th', password: 'wrong-password!!', codeChallenge: c },
      nextIp(),
    );
    const b = await login(
      { email: 'nobody@example.co.th', password: 'wrong-password!!', codeChallenge: c },
      nextIp(),
    );
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.code).toBe('invalid_credentials');
    expect(b.body.code).toBe(a.body.code);
    expect(b.body.title).toBe(a.body.title);
  });

  it('ผิดครั้งที่ 6 ใน 15 นาทีถูกล็อก (ต่อบัญชี) แม้รหัสถูก + มี Retry-After', async () => {
    await makeUser(tenantA, 'lock@example.co.th');
    const c = pkceChallenge(verifier());
    for (let i = 0; i < 5; i++) {
      const r = await login(
        { email: 'lock@example.co.th', password: 'bad-password-xx', codeChallenge: c },
        nextIp(),
      );
      expect(r.status).toBe(401);
    }
    const r = await login(
      { email: 'lock@example.co.th', password: PW, codeChallenge: c },
      nextIp(),
    );
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('account_locked');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(800);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(900);
  });

  it('ผิด 5 ครั้งจาก IP เดียว (หลายบัญชี) → IP นั้นถูกล็อก บัญชีอื่นจาก IP อื่นยังเข้าได้', async () => {
    await makeUser(tenantA, 'victim@example.co.th');
    const ip = nextIp();
    const c = pkceChallenge(verifier());
    for (let i = 0; i < 5; i++)
      await login(
        { email: `guess${i}@example.co.th`, password: 'bad-password-xx', codeChallenge: c },
        ip,
      );
    const r = await login({ email: 'victim@example.co.th', password: PW, codeChallenge: c }, ip);
    expect(r.status).toBe(429);
    await fullLogin('victim@example.co.th', nextIp());
  });

  it('PKCE: verifier ผิด → invalid_grant; code ใช้ซ้ำไม่ได้', async () => {
    await makeUser(tenantA, 'pkce@example.co.th');
    const v = verifier();
    const r1 = await login(
      { email: 'pkce@example.co.th', password: PW, codeChallenge: pkceChallenge(v) },
      nextIp(),
    );
    const bad = await request(app.getHttpServer())
      .post('/v1/oauth/token')
      .send({ grantType: 'authorization_code', code: r1.body.code, codeVerifier: verifier() });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_grant');
    const ok = await request(app.getHttpServer())
      .post('/v1/oauth/token')
      .send({ grantType: 'authorization_code', code: r1.body.code, codeVerifier: v });
    expect(ok.status).toBe(200);
    const again = await request(app.getHttpServer())
      .post('/v1/oauth/token')
      .send({ grantType: 'authorization_code', code: r1.body.code, codeVerifier: v });
    expect(again.status).toBe(400);
  });

  it('refresh หมุน token; ใช้ token เก่าซ้ำ → เพิกถอนทั้ง family', async () => {
    await makeUser(tenantA, 'rotate@example.co.th');
    const { cookie } = await fullLogin('rotate@example.co.th');
    const r1 = await refresh(cookie);
    expect(r1.status).toBe(200);
    expect((await me(r1.body.accessToken)).status).toBe(200);
    const next = (r1.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect(next).not.toBe(cookie);
    // ใช้ซ้ำหลังพ้น grace 30 วินาที = ถูกขโมย → เพิกถอนทั้ง family
    await db.refreshToken.updateMany({
      where: { usedAt: { not: null } },
      data: { usedAt: new Date(Date.now() - 60_000) },
    });
    const reuse = await refresh(cookie);
    expect(reuse.status).toBe(400);
    expect((await refresh(next)).status).toBe(400);
  });

  it('สองแท็บ refresh พร้อมกัน (ภายใน 30 วินาที) → ใบหนึ่งได้ 400 แต่ไม่หลุดทั้ง family', async () => {
    await makeUser(tenantA, 'tabs@example.co.th');
    const { cookie } = await fullLogin('tabs@example.co.th');
    const r1 = await refresh(cookie);
    expect(r1.status).toBe(200);
    const next = (r1.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect((await refresh(cookie)).status).toBe(400);
    expect((await refresh(next)).status).toBe(200);
  });

  it('ยิง login ผิดพร้อมกัน 20 ครั้ง → ตรวจรหัสจริงได้ไม่เกิน 5 ครั้ง ที่เหลือถูกล็อก', async () => {
    await makeUser(tenantA, 'burst@example.co.th');
    const res = await Promise.all(
      Array.from({ length: 20 }, () =>
        login(
          {
            email: 'burst@example.co.th',
            password: 'wrong-password-x',
            codeChallenge: pkceChallenge(verifier()),
          },
          nextIp(),
        ),
      ),
    );
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s !== 401 && s !== 429)).toEqual([]);
  }, 60_000);

  it('token dev และ cookie ไม่ Secure ใช้ได้เฉพาะเครื่อง dev/test (staging ปฏิเสธ)', async () => {
    const dev = await signDevToken({ sub: 'x', tid: tenantA });
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'staging';
    process.env.AUTH_JWT_SECRET = 'staging-secret-0123456789abcdef0123456789';
    try {
      expect(await verifyAccessToken(dev)).toBeNull();
      expect(isLocalEnv()).toBe(false);
    } finally {
      process.env.NODE_ENV = env;
      delete process.env.AUTH_JWT_SECRET;
    }
    expect(await verifyAccessToken(dev)).not.toBeNull();
  });

  it('tenant ถูกระงับ → access token เดิม 401 และ refresh ใช้ไม่ได้', async () => {
    const t = await createTenant(db);
    await makeUser(t.id, 'suspend@example.co.th');
    const { access, cookie } = await fullLogin('suspend@example.co.th');
    expect((await me(access)).status).toBe(200);
    await db.tenant.update({ where: { id: t.id }, data: { status: 'SUSPENDED' } });
    expect((await me(access)).status).toBe(401);
    expect((await refresh(cookie)).status).toBe(400);
  });

  it('bump tokenVersion → access token เดิม 401 ทันที และ refresh ใช้ไม่ได้', async () => {
    const u = await makeUser(tenantA, 'bump@example.co.th');
    const { access, cookie } = await fullLogin('bump@example.co.th');
    expect((await me(access)).status).toBe(200);
    await db.appUser.update({ where: { id: u.id }, data: { tokenVersion: { increment: 1 } } });
    expect((await me(access)).status).toBe(401);
    expect((await refresh(cookie)).status).toBe(400);
  });

  it('ผู้ใช้ถูกระงับ → token เดิม 401 และ login ไม่ได้', async () => {
    const u = await makeUser(tenantA, 'disabled@example.co.th');
    const { access } = await fullLogin('disabled@example.co.th');
    await db.appUser.update({ where: { id: u.id }, data: { status: 'DISABLED' } });
    expect((await me(access)).status).toBe(401);
    const r = await login(
      { email: 'disabled@example.co.th', password: PW, codeChallenge: pkceChallenge(verifier()) },
      nextIp(),
    );
    expect(r.status).toBe(401);
  });

  it('อีเมลเดียวกันอยู่ 2 บริษัท → 409 ให้เลือก แล้วส่ง tenantId เข้าได้', async () => {
    await makeUser(tenantA, 'multi@example.co.th');
    await makeUser(tenantB, 'multi@example.co.th');
    const r = await login(
      { email: 'multi@example.co.th', password: PW, codeChallenge: pkceChallenge(verifier()) },
      nextIp(),
    );
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('tenant_selection_required');
    expect(r.body.tenants.map((t: { id: string }) => t.id).sort()).toEqual(
      [encodeId('tenant', tenantA), encodeId('tenant', tenantB)].sort(),
    );
    const { access } = await fullLogin('multi@example.co.th', nextIp(), {
      tenantId: encodeId('tenant', tenantB),
    });
    expect((await me(access)).body.tenant.id).toBe(encodeId('tenant', tenantB));
  });

  it('ออกจากระบบ → refresh cookie ใช้ไม่ได้', async () => {
    await makeUser(tenantA, 'logout@example.co.th');
    const { cookie } = await fullLogin('logout@example.co.th');
    const r = await request(app.getHttpServer()).post('/v1/oauth/revoke').set('Cookie', cookie);
    expect(r.status).toBe(204);
    expect((await refresh(cookie)).status).toBe(400);
  });

  it('role tms_app อ่านตาราง auth ไม่ได้', async () => {
    const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
    await expect(appDb.$queryRawUnsafe('SELECT 1 FROM refresh_token LIMIT 1')).rejects.toThrow(
      /permission denied/,
    );
    await expect(appDb.$queryRawUnsafe('SELECT 1 FROM login_attempt LIMIT 1')).rejects.toThrow(
      /permission denied/,
    );
    await appDb.$disconnect();
  });
});
