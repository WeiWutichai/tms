import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeAuthData } from '../src/auth/maintenance';
import { hashPassword } from '../src/auth/password';
import { RESET_MAX_PER_EMAIL, webBaseUrl } from '../src/auth/password-reset.controller';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { EmailDispatcher } from '../src/modules/email/email.service';
import { renderEmail } from '../src/modules/email/templates';
import { MemoryTransport, transportFromEnv } from '../src/modules/email/transport';
import { bootApp, createTenant, loginFull, platform, truncateAll } from './helpers';

/** ST1-T03: ลืมรหัสผ่าน — อีเมลมี/ไม่มีได้ response เดียวกัน; ลิงก์ใช้ซ้ำหรือเกิน 30 นาทีใช้ไม่ได้ */
describe('password reset + email outbox', () => {
  let app: NestExpressApplication;
  const db = platform();
  let mail: MemoryTransport;
  let dispatcher: EmailDispatcher;
  let tA: string;
  let tB: string;
  const PW = 'reset-original-2569';
  let n = 0;
  const ip = () => `10.61.${Math.floor(++n / 250)}.${n % 250}`;

  const forgot = (email: string, from = ip()) =>
    request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .set('X-Forwarded-For', from)
      .send({ email });
  const reset = (token: string, newPassword: string) =>
    request(app.getHttpServer())
      .post('/v1/auth/password/reset')
      .set('X-Forwarded-For', ip())
      .send({ token, newPassword });
  /** ส่งอีเมลที่ค้างแล้วดึง token จากลิงก์ฉบับล่าสุด */
  async function latestToken(to: string): Promise<string> {
    await dispatcher.drain();
    const m = [...mail.sent].reverse().find((x) => x.to === to);
    const t = /reset-password#token=([A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1];
    if (!t) throw new Error(`no reset mail for ${to}`);
    return t;
  }

  async function user(tenantId: string, email: string, status: 'ACTIVE' | 'DISABLED' = 'ACTIVE') {
    const roles = await ensureSystemRoles(db, tenantId);
    const u = await db.appUser.create({
      data: { tenantId, email, name: 'ทดสอบ', status, passwordHash: await hashPassword(PW) },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles.planner! } });
    return u;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    dispatcher = app.get(EmailDispatcher);
    tA = (await createTenant(db)).id;
    tB = (await createTenant(db)).id;
    await user(tA, 'one@reset.test');
    await user(tA, 'two@reset.test');
    await user(tB, 'two@reset.test'); // อีเมลเดียวกันสองบริษัท
    await user(tA, 'off@reset.test', 'DISABLED');
    await user(tA, 'en@reset.test');
    await db.appUser.updateMany({ where: { email: 'en@reset.test' }, data: { locale: 'en' } });
  });
  beforeEach(() => {
    mail = new MemoryTransport();
    dispatcher.use(mail);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('อีเมลที่มี / ไม่มี / ถูกระงับ ได้ response เดียวกัน (202 ไม่มี body) — ส่งอีเมลเฉพาะที่มีจริง', async () => {
    const a = await forgot('One@Reset.test ');
    const b = await forgot('nobody@reset.test');
    const c = await forgot('off@reset.test');
    for (const r of [a, b, c]) {
      expect(r.status).toBe(202);
      expect(r.text).toBe('');
      expect(r.headers['cache-control']).toBe('no-store');
    }
    await dispatcher.drain();
    expect(mail.sent.map((m) => m.to)).toEqual(['one@reset.test']);
    expect(mail.sent[0]!.subject).toContain('ตั้งรหัสผ่านใหม่');
    expect(mail.sent[0]!.text).toContain(`${webBaseUrl()}/reset-password#token=`);
    expect(mail.sent[0]!.text).toContain('30 นาที');
    // ส่งแล้วเนื้อหา (มี token) ถูกลบจาก outbox
    const row = await db.emailOutbox.findFirst({ where: { toAddress: 'one@reset.test' } });
    expect(row).toMatchObject({ status: 'SENT', textBody: null, htmlBody: null, tenantId: null });
  });

  it('ภาษาอีเมลตามโปรไฟล์ผู้ใช้ (en)', async () => {
    await forgot('en@reset.test').expect(202);
    await dispatcher.drain();
    expect(mail.sent[0]!.subject).toBe('Reset your password — TMS');
  });

  it('ตั้งรหัสใหม่สำเร็จ → login ด้วยรหัสใหม่ได้ รหัสเก่าไม่ได้ session เดิมหลุด + audit; ใช้ลิงก์ซ้ำไม่ได้', async () => {
    const old = await loginFull(app, 'one@reset.test', PW, ip());
    await forgot('one@reset.test').expect(202);
    const token = await latestToken('one@reset.test');
    await reset(token, 'brand-new-reset-2569').expect(204);
    const rt = await request(app.getHttpServer())
      .post('/v1/oauth/token')
      .set('Cookie', old.cookie)
      .send({ grantType: 'refresh_token' });
    expect(rt.status).toBe(400);
    await expect(loginFull(app, 'one@reset.test', PW, ip())).rejects.toThrow(/401/);
    expect(
      (await loginFull(app, 'one@reset.test', 'brand-new-reset-2569', ip())).access,
    ).toBeTruthy();
    expect(await db.auditLog.count({ where: { action: 'auth.password_reset' } })).toBe(1);
    const again = await reset(token, 'another-new-reset-2569');
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('reset_link_invalid');
  });

  it('ลิงก์เก่าของอีเมลเดียวกันใช้ไม่ได้หลังตั้งรหัสสำเร็จ', async () => {
    await forgot('en@reset.test').expect(202);
    const first = await latestToken('en@reset.test');
    await forgot('en@reset.test').expect(202);
    const second = await latestToken('en@reset.test');
    expect(first).not.toBe(second);
    await reset(second, 'english-new-pass-2569').expect(204);
    expect((await reset(first, 'english-other-pass-2569')).body.code).toBe('reset_link_invalid');
  });

  it('เกิน 30 นาทีใช้ไม่ได้', async () => {
    await forgot('two@reset.test').expect(202);
    const token = await latestToken('two@reset.test');
    await db.passwordResetToken.updateMany({
      where: { email: 'two@reset.test', usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await reset(token, 'expired-reset-pass-2569')).body.code).toBe('reset_link_invalid');
  });

  it('token มั่ว → reset_link_invalid (400)', async () => {
    const r = await reset('x'.repeat(43), 'whatever-pass-2569');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('reset_link_invalid');
  });

  it('รหัสไม่ผ่านนโยบาย → 422 และ token ยังใช้ต่อได้', async () => {
    await forgot('two@reset.test').expect(202);
    const token = await latestToken('two@reset.test');
    const bad = await reset(token, 'short');
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].code).toBe('password_too_short');
    const reused = await reset(token, PW); // รหัสเดิม = ซ้ำประวัติ
    expect(reused.body.errors[0].code).toBe('password_reused');
    await reset(token, 'two-tenants-new-2569').expect(204);
  });

  it('อีเมลเดียวกันหลายบริษัท → ตั้งรหัสใหม่ทุกบริษัทในครั้งเดียว', async () => {
    const r = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('X-Forwarded-For', ip())
      .send({
        email: 'two@reset.test',
        password: 'two-tenants-new-2569',
        codeChallenge: 'x'.repeat(43),
      });
    expect(r.status).toBe(409);
    expect(r.body.tenants).toHaveLength(2);
    expect(
      await db.auditLog.count({ where: { action: 'auth.password_reset', tenantId: tB } }),
    ).toBe(1);
  });

  it(`เกิน ${RESET_MAX_PER_EMAIL} ครั้ง/15 นาทีต่ออีเมล → 429 + Retry-After (นับเหมือนกันไม่ว่าอีเมลมีหรือไม่)`, async () => {
    for (const email of ['limit@reset.test', 'nobody-limit@reset.test']) {
      for (let i = 0; i < RESET_MAX_PER_EMAIL; i++) await forgot(email).expect(202);
      const r = await forgot(email);
      expect(r.status).toBe(429);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    }
  });

  it('ต่อ IP: เกิน 10 ครั้ง/15 นาที → 429', async () => {
    const from = '10.62.0.1';
    for (let i = 0; i < 10; i++) await forgot(`ip${i}@reset.test`, from).expect(202);
    expect((await forgot('ip-last@reset.test', from)).status).toBe(429);
  });

  it('ขอพร้อมกันหลายคำขอไม่เกินเพดาน (advisory lock)', async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => forgot('race@reset.test')));
    expect(rs.filter((r) => r.status === 202)).toHaveLength(RESET_MAX_PER_EMAIL);
  });

  it('ส่งไม่สำเร็จ → ลองใหม่แบบ backoff; ครบจำนวนครั้ง → FAILED และลบเนื้อหา', async () => {
    const row = await db.emailOutbox.create({
      data: {
        toAddress: 'x@reset.test',
        template: 'password_reset',
        locale: 'th',
        subject: 's',
        textBody: 't',
        htmlBody: 'h',
        maxAttempts: 2,
      },
    });
    const failing = { name: 'fail', send: async () => Promise.reject(new Error('smtp down')) };
    dispatcher.use(failing);
    await dispatcher.drain();
    let r = await db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(r).toMatchObject({ status: 'PENDING', attempts: 1, error: 'smtp down' });
    await db.emailOutbox.update({ where: { id: row.id }, data: { runAt: new Date() } });
    await dispatcher.drain();
    r = await db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(r).toMatchObject({ status: 'FAILED', attempts: 2, textBody: null, htmlBody: null });
  });

  it('outbox แยก tenant: แอปเขียน/อ่านได้เฉพาะของ tenant ตัวเอง, แถวระบบ (null) มองไม่เห็น, แก้/ลบไม่ได้', async () => {
    const app1 = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
    const asTenant = <T>(tid: string, fn: (tx: any) => Promise<T>) =>
      app1.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
        return fn(tx);
      });
    const data = { toAddress: 'a@x.test', template: 'password_reset', locale: 'th', subject: 's' };
    await asTenant(tA, (tx) => tx.emailOutbox.create({ data: { ...data, tenantId: tA } }));
    await expect(
      asTenant(tA, (tx) => tx.emailOutbox.create({ data: { ...data, tenantId: tB } })),
    ).rejects.toThrow();
    const seen = await asTenant(tB, (tx) => tx.emailOutbox.findMany());
    expect(seen).toHaveLength(0);
    const seenA = await asTenant(tA, (tx) => tx.emailOutbox.findMany());
    expect(seenA.every((r: { tenantId: string }) => r.tenantId === tA)).toBe(true);
    await expect(asTenant(tA, (tx) => tx.emailOutbox.deleteMany())).rejects.toThrow();
    await expect(asTenant(tA, (tx) => tx.passwordResetToken.findMany())).rejects.toThrow();
    await app1.$disconnect();
  });

  it('template escape HTML และ transport log ใช้นอก dev ไม่ได้', () => {
    const r = renderEmail('password_reset', 'th', { link: 'https://x.test/?a=<b>&"', minutes: 30 });
    expect(r.html).not.toContain('<b>');
    expect(r.html).toContain('&lt;b&gt;');
    expect(() => transportFromEnv({ EMAIL_TRANSPORT: 'smtp' })).toThrow(/EMAIL_SMTP_URL/);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => transportFromEnv({ EMAIL_TRANSPORT: 'log' })).toThrow(/development/);
      expect(() => webBaseUrl({})).toThrow(/PUBLIC_WEB_BASE_URL/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('งานบำรุงรักษาลบ token หมดอายุ > 1 วัน และอีเมลที่ส่งแล้ว > 90 วัน', async () => {
    await db.passwordResetToken.create({
      data: {
        tokenHash: 'old-hash',
        email: 'z@reset.test',
        expiresAt: new Date(Date.now() - 2 * 86400_000),
      },
    });
    const sent = await db.emailOutbox.create({
      data: {
        toAddress: 'z@reset.test',
        template: 'password_reset',
        locale: 'th',
        subject: 's',
        status: 'SENT',
      },
    });
    await db.$executeRaw`UPDATE email_outbox SET updated_at = now() - interval '91 days' WHERE id = ${sent.id}::uuid`;
    const r = await purgeAuthData(db);
    expect(r.resetTokens).toBeGreaterThanOrEqual(1);
    expect(r.emails).toBe(1);
  });
});
