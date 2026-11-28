import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { pkceChallenge } from '../src/auth/tokens';
import {
  OTP_LOCK_MS,
  signupMaintenance,
  thaiMobileE164,
} from '../src/modules/signup/signup.service';
import { bootApp, createTenant, platform, truncateAll } from './helpers';

/**
 * P1-ST2-T03 สมัครขั้น 1 "สร้างบัญชี" — เกณฑ์ตรวจรับ (plan/13):
 * OTP ผิด 5 ครั้ง → ล็อก 15 นาที · ปิดเบราว์เซอร์กลางทาง login แล้วกลับขั้นที่ค้าง ·
 * session ค้าง 7 วัน → abandoned + job ลบข้อมูลส่วนบุคคลวันที่ 30 · OTP อายุ 5 นาที / ขอใหม่หลัง 60 วิ / เก็บแค่ hash
 * เวลาเลื่อนด้วยการแก้แถวในฐานตรง ๆ (ไม่ใช้ fake timer — Prisma/pg ใช้เวลาจริง)
 */
const PW = 'signup-password-2569';
let seq = 0;
const nextIp = () => `10.77.${Math.floor(++seq / 250)}.${seq % 250}`;
const uniq = () => `su${Date.now().toString(36)}${++seq}`;

describe('P1-ST2-T03 สมัครขั้น 1', () => {
  let app: NestExpressApplication;
  const db = platform();
  const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.SIGNUP_RATE_LIMIT_PER_IP_PER_HOUR = '1000';
    process.env.OTP_RATE_LIMIT_PER_RECIPIENT_PER_DAY = '1000';
    await truncateAll();
    app = await bootApp();
  });
  afterAll(async () => {
    delete process.env.SIGNUP_RATE_LIMIT_PER_IP_PER_HOUR;
    delete process.env.OTP_RATE_LIMIT_PER_RECIPIENT_PER_DAY;
    await app.close();
    await db.$disconnect();
    await appDb.$disconnect();
  });

  const body = (email: string, extra: Record<string, unknown> = {}) => ({
    name: 'สมชาย ใจดี',
    email,
    mobile: '+66812345678',
    password: PW,
    ...extra,
  });
  const start = (email: string, extra: Record<string, unknown> = {}) =>
    http().post('/v1/public/signup').set('X-Forwarded-For', nextIp()).send(body(email, extra));
  /** รหัสล่าสุดที่ส่งทางอีเมล — อ่านจากเนื้ออีเมลใน outbox (test ไม่รัน worker · หัวเรื่องไม่มีรหัส) */
  async function lastCode(email: string): Promise<string> {
    const m = await db.emailOutbox.findFirst({
      where: { toAddress: email, template: 'signup_otp' },
      orderBy: { createdAt: 'desc' },
    });
    expect(m!.subject).not.toMatch(/\d{6}/);
    return /\b(\d{6})\b/.exec(m!.textBody ?? '')![1]!;
  }
  const verify = (token: string, code: string) =>
    http().post('/v1/public/signup/session/otp/verify').set('X-Signup-Token', token).send({ code });
  const resend = (token: string) =>
    http().post('/v1/public/signup/session/otp/resend').set('X-Signup-Token', token).send({});
  const session = (email: string) => db.signupSession.findFirstOrThrow({ where: { email } });
  const wrong = (code: string) => (code === '000000' ? '000001' : '000000');
  /** เลื่อนเวลาส่งรหัสย้อนหลัง (ขอใหม่ได้) */
  const ageSend = async (email: string, ms: number) => {
    const s = await session(email);
    await db.signupSession.update({
      where: { id: s.id },
      data: { otpSentAt: new Date(s.otpSentAt!.getTime() - ms) },
    });
  };

  it('เริ่มสมัคร → 201 + token + OTP ทางอีเมล · เก็บ OTP เป็น HMAC เท่านั้น · รหัสผ่าน argon2', async () => {
    const email = `${uniq()}@company.co.th`;
    const r = await start(email.toUpperCase());
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.session).toMatchObject({
      status: 'account_pending_otp',
      step: 1,
      name: 'สมชาย ใจดี',
      email,
      mobile: '+66812345678',
      otp: { channel: 'email', sentTo: email, attemptsLeft: 5, lockedUntil: null },
    });
    const exp = Date.parse(r.body.session.otp.expiresAt) - Date.now();
    expect(exp).toBeGreaterThan(4 * 60_000);
    expect(exp).toBeLessThanOrEqual(5 * 60_000);
    const s = await session(email);
    const code = await lastCode(email);
    expect(s.otpHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // ไม่มีรหัสดิบ / token ดิบ / รหัสผ่านดิบ ในแถว
    const raw = JSON.stringify(s);
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(r.body.token);
    expect(raw).not.toContain(PW);
    expect(s.passwordHash).toMatch(/^\$argon2id\$/);
    // CHECK constraint กันเก็บรหัสดิบ
    await expect(
      db.signupSession.update({ where: { id: s.id }, data: { otpHash: code } }),
    ).rejects.toThrow();
  });

  it('validation: รหัสผ่านตามนโยบาย ST1-T02 (≥ 12) · เบอร์มือถือไทย · อีเมล', async () => {
    const e = `${uniq()}@company.co.th`;
    const short = await start(e, { password: 'short1234' });
    expect(short.status).toBe(422);
    expect(short.body.errors[0]).toMatchObject({ field: 'password', code: 'password_too_short' });
    const breached = await start(e, { password: 'password1234' });
    expect(breached.body.errors[0]).toMatchObject({ code: 'password_breached' });
    const mob = await start(e, { mobile: '+6621234567' });
    expect(mob.status).toBe(422);
    expect(mob.body.errors[0]).toMatchObject({ field: 'mobile', code: 'invalid_mobile' });
    expect((await start('not-an-email')).status).toBe(422);
    expect(thaiMobileE164('081 234 5678')).toBe('+66812345678');
    expect(thaiMobileE164('+66 81-234-5678')).toBe('+66812345678');
    expect(thaiMobileE164('021234567')).toBeNull();
    expect(await db.signupSession.count({ where: { email: e } })).toBe(0);
  });

  it('อีเมลมีบัญชีแล้ว → 409 account_exists "เข้าสู่ระบบเพื่อเพิ่มบริษัทใหม่" (ไม่สร้าง session ไม่ส่ง OTP)', async () => {
    const t = await createTenant(db);
    const email = `${uniq()}@company.co.th`;
    await db.appUser.create({
      data: { tenantId: t.id, email, name: 'มีแล้ว', status: 'ACTIVE', passwordHash: 'x' },
    });
    const r = await start(email);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('account_exists');
    expect(JSON.stringify(r.body)).toContain('เข้าสู่ระบบเพื่อเพิ่มบริษัทใหม่');
    expect(await db.signupSession.count({ where: { email } })).toBe(0);
    expect(await db.emailOutbox.count({ where: { toAddress: email } })).toBe(0);
  });

  it('OTP ถูก → account_verified (ขั้น 2) · state machine: ขอรหัสใหม่หลังยืนยัน = 409 · เริ่มใหม่ด้วยอีเมลเดิม = signup_in_progress', async () => {
    const email = `${uniq()}@company.co.th`;
    const { token } = (await start(email)).body;
    const ok = await verify(token, await lastCode(email));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'account_verified', step: 2, otp: null });
    const s = await session(email);
    expect(s.verifiedAt).not.toBeNull();
    expect(s.otpHash).toBeNull();
    const g = await http().get('/v1/public/signup/session').set('X-Signup-Token', token);
    expect(g.body).toMatchObject({ status: 'account_verified', step: 2 });
    // verify ซ้ำ = idempotent (ไม่ย้อนสถานะ)
    expect((await verify(token, '123456')).body.status).toBe('account_verified');
    await ageSend(email, 120_000);
    const rs = await resend(token);
    expect(rs.status).toBe(409);
    expect(rs.body.code).toBe('invalid_state_transition');
    const again = await start(email);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('signup_in_progress');
  });

  it('OTP หมดอายุ 5 นาที → 422 otp_expired', async () => {
    const email = `${uniq()}@company.co.th`;
    const { token } = (await start(email)).body;
    const s = await session(email);
    await db.signupSession.update({
      where: { id: s.id },
      data: { otpExpiresAt: new Date(Date.now() - 1000) },
    });
    const r = await verify(token, await lastCode(email));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('otp_expired');
  });

  it('ขอรหัสใหม่ได้หลัง 60 วิ (429 otp_resend_too_soon + Retry-After) · รหัสเดิมใช้ไม่ได้', async () => {
    const email = `${uniq()}@company.co.th`;
    const { token } = (await start(email)).body;
    const first = await lastCode(email);
    const early = await resend(token);
    expect(early.status).toBe(429);
    expect(early.body.code).toBe('otp_resend_too_soon');
    expect(Number(early.headers['retry-after'])).toBeGreaterThan(50);
    expect(Number(early.headers['retry-after'])).toBeLessThanOrEqual(60);
    await ageSend(email, 61_000);
    const r = await resend(token);
    expect(r.status).toBe(200);
    expect(Date.parse(r.body.otp.resendAvailableAt) - Date.now()).toBeGreaterThan(55_000);
    const second = await lastCode(email);
    expect(await db.emailOutbox.count({ where: { toAddress: email } })).toBe(2);
    expect((await session(email)).otpSendCount).toBe(2);
    if (first !== second) {
      const old = await verify(token, first);
      expect(old.status).toBe(422);
      expect(old.body.code).toBe('otp_invalid');
    }
    expect((await verify(token, second)).status).toBe(200);
  });

  it('ผิด 5 ครั้ง → ล็อก 15 นาที (รหัสถูกก็ไม่ผ่าน · ขอใหม่ไม่ได้ · เริ่มใหม่ไม่ได้) → ปลดล็อกแล้วขอรหัสใหม่ใช้ได้', async () => {
    const email = `${uniq()}@company.co.th`;
    const { token } = (await start(email)).body;
    const code = await lastCode(email);
    for (let i = 1; i <= 4; i++) {
      const r = await verify(token, wrong(code));
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'otp_invalid', attemptsLeft: 5 - i });
    }
    const fifth = await verify(token, wrong(code));
    expect(fifth.status).toBe(429);
    expect(fifth.body.code).toBe('otp_locked');
    const ra = Number(fifth.headers['retry-after']);
    expect(ra).toBeGreaterThan(14 * 60);
    expect(ra).toBeLessThanOrEqual(15 * 60);
    const s = await session(email);
    expect(s.otpLockedUntil!.getTime() - Date.now()).toBeGreaterThan(OTP_LOCK_MS - 60_000);
    expect(s.otpHash).toBeNull();
    // ระหว่างล็อก: รหัสถูกก็ไม่ผ่าน, ขอใหม่ไม่ได้, เริ่มสมัครใหม่ด้วยอีเมลเดิมไม่ได้
    expect((await verify(token, code)).body.code).toBe('otp_locked');
    await ageSend(email, 120_000);
    expect((await resend(token)).body.code).toBe('otp_locked');
    expect((await start(email)).body.code).toBe('otp_locked');
    const g = await http().get('/v1/public/signup/session').set('X-Signup-Token', token);
    expect(g.body.otp).toMatchObject({ attemptsLeft: 0, expiresAt: null });
    expect(g.body.otp.lockedUntil).not.toBeNull();
    // ครบ 15 นาที → ขอรหัสใหม่ได้ ตัวนับเริ่ม 0
    await db.signupSession.update({
      where: { id: s.id },
      data: { otpLockedUntil: new Date(Date.now() - 1000) },
    });
    const rs = await resend(token);
    expect(rs.status).toBe(200);
    expect(rs.body.otp).toMatchObject({ attemptsLeft: 5, lockedUntil: null });
    expect((await verify(token, await lastCode(email))).status).toBe(200);
  });

  it('เริ่มสมัครใหม่ด้วยอีเมลเดิม: session เดิมถูกแทนที่ (token เก่าใช้ไม่ได้) และตัวนับผิดไม่ถูกล้าง', async () => {
    const email = `${uniq()}@company.co.th`;
    const a = (await start(email)).body.token;
    const code = await lastCode(email);
    for (let i = 0; i < 3; i++) await verify(a, wrong(code));
    const b = await start(email, { mobile: '0898765432' });
    expect(b.status).toBe(201);
    expect(b.body.session).toMatchObject({ mobile: '+66898765432', otp: { attemptsLeft: 2 } });
    expect((await verify(a, code)).body.code).toBe('signup_session_invalid');
    const rows = await db.signupSession.findMany({
      where: { email },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['abandoned', 'account_pending_otp']);
  });

  it('token ผิด/ไม่มี → 401 signup_session_invalid', async () => {
    const r = await http().get('/v1/public/signup/session').set('X-Signup-Token', 'nope');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('signup_session_invalid');
    expect((await http().get('/v1/public/signup/session')).status).toBe(401);
  });

  it('ปิดเบราว์เซอร์กลางทาง → login ด้วยอีเมล/รหัสของการสมัคร → 409 signup_incomplete + token ใหม่ → กลับขั้นที่ค้าง', async () => {
    const email = `${uniq()}@company.co.th`;
    const old = (await start(email)).body.token;
    const login = (password: string) =>
      http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({
          email,
          password,
          codeChallenge: pkceChallenge(randomBytes(32).toString('base64url')),
        });
    const bad = await login('wrong-password-xx');
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('invalid_credentials');
    const r = await login(PW);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('signup_incomplete');
    const fresh = r.body.signupToken as string;
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // token เดิม (ในเบราว์เซอร์ที่ปิดไป) ใช้ไม่ได้แล้ว
    expect((await http().get('/v1/public/signup/session').set('X-Signup-Token', old)).status).toBe(
      401,
    );
    const g = await http().get('/v1/public/signup/session').set('X-Signup-Token', fresh);
    expect(g.body).toMatchObject({ status: 'account_pending_otp', step: 1 });
    // ยืนยันแล้ว login อีกรอบ → กลับมาที่ขั้น 2
    await ageSend(email, 61_000);
    await resend(fresh);
    await verify(fresh, await lastCode(email));
    const r2 = await login(PW);
    expect(r2.body.code).toBe('signup_incomplete');
    const g2 = await http()
      .get('/v1/public/signup/session')
      .set('X-Signup-Token', r2.body.signupToken);
    expect(g2.body).toMatchObject({ status: 'account_verified', step: 2 });
  });

  it('ผู้ใช้เดิมที่มีบัญชีอยู่แล้ว login ตามปกติ (ไม่ถูกการสมัครค้างของอีเมลเดียวกันแทรก)', async () => {
    const t = await createTenant(db);
    const email = `${uniq()}@company.co.th`;
    await db.signupSession.create({
      data: { email, fullName: 'x', mobile: '+66812345678', passwordHash: await hashPassword(PW) },
    });
    await db.appUser.create({
      data: {
        tenantId: t.id,
        email,
        name: 'u',
        status: 'ACTIVE',
        passwordHash: await hashPassword('another-password-2569'),
      },
    });
    const r = await http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({ email, password: PW, codeChallenge: pkceChallenge('x'.repeat(43)) });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('invalid_credentials');
  });

  it('ไม่เคลื่อน 7 วัน → abandoned (token ใช้ไม่ได้, login ไม่พากลับ) · 30 วัน → ลบข้อมูลส่วนบุคคล คงแถวไว้วัด funnel', async () => {
    const day = 86_400_000;
    const mk = async (ageDays: number, status: Prisma.SignupSessionCreateInput['status']) =>
      db.signupSession.create({
        data: {
          status,
          email: `${uniq()}@company.co.th`,
          fullName: 'ทดสอบ ลบข้อมูล',
          mobile: '+66812345678',
          passwordHash: 'h',
          resumeTokenHash: randomBytes(16).toString('hex'),
          ip: '10.0.0.1',
          lastActivityAt: new Date(Date.now() - ageDays * day),
          ...(status === 'abandoned' ? { abandonedAt: new Date() } : {}),
          // P1-ST2-T05: completed ต้องมีบริษัทที่สร้าง (CHECK signup_session_completed_check)
          ...(status === 'completed'
            ? { createdTenantId: randomUUID(), completedAt: new Date() }
            : {}),
          ...(status !== 'account_pending_otp' && status !== 'abandoned'
            ? { verifiedAt: new Date() }
            : {}),
        },
      });
    // การสมัครจริง (มีรหัสผ่าน) ที่ค้าง 8 วัน → abandoned แล้ว login ไม่พากลับ (401 ตามปกติ)
    const realEmail = `${uniq()}@company.co.th`;
    const realToken = (await start(realEmail)).body.token as string;
    await db.signupSession.updateMany({
      where: { email: realEmail },
      data: { lastActivityAt: new Date(Date.now() - 8 * day) },
    });
    // อีเมล OTP: ส่งแล้ว → ลบแถว · ยังรอส่ง (ใหม่) → คงไว้
    await db.emailOutbox.updateMany({
      where: { toAddress: realEmail, template: 'signup_otp' },
      data: { status: 'SENT', textBody: null, htmlBody: null },
    });
    const pendingMail = `${uniq()}@company.co.th`;
    await db.emailOutbox.create({
      data: {
        toAddress: pendingMail,
        template: 'signup_otp',
        locale: 'th',
        subject: 's',
        textBody: 't',
        htmlBody: 'h',
      },
    });
    const fresh = await mk(6, 'account_pending_otp');
    const stale = await mk(8, 'account_verified');
    const old = await mk(31, 'abandoned');
    const done = await mk(31, 'completed');
    const now = Date.now();
    const r1 = await signupMaintenance(db, now);
    expect(r1.abandoned).toBeGreaterThanOrEqual(2);
    expect(r1.otpEmails).toBeGreaterThanOrEqual(1);
    expect(await db.emailOutbox.count({ where: { toAddress: realEmail } })).toBe(0);
    expect(await db.emailOutbox.count({ where: { toAddress: pendingMail } })).toBe(1);
    expect(
      (await http().get('/v1/public/signup/session').set('X-Signup-Token', realToken)).status,
    ).toBe(401);
    const lg = await http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({ email: realEmail, password: PW, codeChallenge: pkceChallenge('y'.repeat(43)) });
    expect(lg.status).toBe(401);
    expect(lg.body.code).toBe('invalid_credentials');
    const get = (id: string) => db.signupSession.findUniqueOrThrow({ where: { id } });
    expect((await get(fresh.id)).status).toBe('account_pending_otp');
    const s = await get(stale.id);
    expect(s).toMatchObject({ status: 'abandoned', resumeTokenHash: null });
    expect(s.abandonedAt).not.toBeNull();
    expect(s.email).not.toBeNull(); // ยังไม่ถึง 30 วัน
    for (const id of [old.id, done.id]) {
      const e = await get(id);
      expect(e).toMatchObject({
        fullName: null,
        email: null,
        mobile: null,
        passwordHash: null,
        resumeTokenHash: null,
        otpHash: null,
        ip: null,
      });
      expect(e.personalDataErasedAt).not.toBeNull();
    }
    expect((await get(done.id)).status).toBe('completed');
    // รันซ้ำไม่กระทบแถวที่ลบแล้ว
    expect((await signupMaintenance(db, now)).erased).toBe(0);
    // abandoned ครบ 30 วันจากเคลื่อนไหวล่าสุด (ทิ้งวันที่ 7 → ลบวันที่ 30)
    await db.signupSession.update({
      where: { id: stale.id },
      data: { lastActivityAt: new Date(now - 30 * day - 1000) },
    });
    await signupMaintenance(db, now);
    expect((await get(stale.id)).email).toBeNull();
  });

  it('CHECK ของ signup_session: มือถือ E.164 · ตัวนับ ≥ 0 · verified ⇒ verified_at · abandoned ⇒ abandoned_at', async () => {
    for (const data of [
      { mobile: '0812345678' },
      { otpFailedCount: -1 },
      { status: 'account_verified' as const },
      { status: 'abandoned' as const },
    ])
      await expect(db.signupSession.create({ data })).rejects.toThrow(/check constraint/i);
  });

  it('SIGNUP_ENABLED=false: ทุก route สมัคร 404 (ก่อนถึงฐาน) + login ไม่พากลับการสมัครค้าง', async () => {
    const email = `${uniq()}@company.co.th`;
    const token = (await start(email)).body.token as string;
    process.env.SIGNUP_ENABLED = 'false';
    try {
      const r = await start(`${uniq()}@company.co.th`);
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('not_found');
      expect(r.headers['content-type']).toContain('application/problem+json');
      for (const call of [
        http().get('/v1/public/signup/session').set('X-Signup-Token', token),
        resend(token),
        verify(token, '123456'),
      ])
        expect((await call).status).toBe(404);
      const lg = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email, password: PW, codeChallenge: pkceChallenge('z'.repeat(43)) });
      expect(lg.status).toBe(401);
      expect(lg.body.code).toBe('invalid_credentials');
    } finally {
      delete process.env.SIGNUP_ENABLED;
    }
    expect(
      (await http().get('/v1/public/signup/session').set('X-Signup-Token', token)).status,
    ).toBe(200);
  });

  it('แยกข้อมูล: signup_session เป็นตาราง platform (ไม่มี tenant_id) — role แอป (tms_app) อ่าน/เขียนไม่ได้', async () => {
    await expect(appDb.signupSession.findMany()).rejects.toThrow(/permission denied/);
    await expect(
      appDb.$executeRaw`INSERT INTO signup_session (id, updated_at) VALUES (gen_random_uuid(), now())`,
    ).rejects.toThrow(/permission denied/);
  });
});
