import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { HibpChecker, PasswordPolicy } from '../src/auth/password-policy';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { api, bootApp, createTenant, loginFull, platform, truncateAll } from './helpers';

/** ST1-T02: รหัสที่อยู่ใน HIBP หรือซ้ำของเดิมถูกปฏิเสธพร้อมข้อความ (code) */
describe('password policy', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let ip = 0;
  const PW = 'first-password-2569';

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    const roles = await ensureSystemRoles(db, tenantId);
    const u = await db.appUser.create({
      data: {
        tenantId,
        email: 'pw@policy.test',
        name: 'ทดสอบ',
        status: 'ACTIVE',
        passwordHash: await hashPassword(PW),
      },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles.planner! } });
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  let cip = 0;
  const change = (token: string, currentPassword: string, newPassword: string, from?: string) =>
    api(app, token)
      .post('/v1/me/password')
      .set('X-Forwarded-For', from ?? `10.52.${Math.floor(++cip / 250)}.${cip % 250}`)
      .send({ currentPassword, newPassword });
  const code = (r: request.Response) => r.body.errors?.[0]?.code;

  it('สั้นกว่า 12 / อยู่ในรายการรั่ว / รหัสเดิมผิด → 422 พร้อม code', async () => {
    const s = await loginFull(app, 'pw@policy.test', PW, `10.50.0.${++ip}`);
    expect(code(await change(s.access, PW, 'short-pw'))).toBe('password_too_short');
    expect(code(await change(s.access, PW, 'Password1234'))).toBe('password_breached');
    expect(code(await change(s.access, 'wrong-current-pw', 'brand-new-password-1'))).toBe(
      'password_incorrect',
    );
  });

  it('เปลี่ยนสำเร็จ → login ด้วยรหัสใหม่ได้, รหัสเก่าไม่ได้, session อื่นหลุด (refresh ใช้ไม่ได้)', async () => {
    const other = await loginFull(app, 'pw@policy.test', PW, `10.50.0.${++ip}`);
    const s = await loginFull(app, 'pw@policy.test', PW, `10.50.0.${++ip}`);
    await change(s.access, PW, 'second-password-2569').expect(204);
    const rt = await request(app.getHttpServer())
      .post('/v1/oauth/token')
      .set('Cookie', other.cookie)
      .send({ grantType: 'refresh_token' });
    expect(rt.status).toBe(400);
    await expect(loginFull(app, 'pw@policy.test', PW, `10.50.0.${++ip}`)).rejects.toThrow(/401/);
    expect(
      (await loginFull(app, 'pw@policy.test', 'second-password-2569', `10.50.0.${++ip}`)).access,
    ).toBeTruthy();
    const audit = await db.auditLog.findFirst({ where: { action: 'security.password_changed' } });
    expect(audit).not.toBeNull();
  });

  it('ห้ามซ้ำ 5 ครั้งล่าสุด (รวมรหัสปัจจุบัน); ครั้งที่ 6 ย้อนหลังใช้ได้', async () => {
    const pws = [
      'second-password-2569',
      'third-password-2569',
      'fourth-password-2569',
      'fifth-password-2569',
      'sixth-password-2569',
      'seventh-password-2569',
    ];
    let cur = pws[0]!;
    for (const next of pws.slice(1)) {
      const s = await loginFull(app, 'pw@policy.test', cur, `10.50.0.${++ip}`);
      await change(s.access, cur, next).expect(204);
      cur = next;
    }
    const s = await loginFull(app, 'pw@policy.test', cur, `10.50.0.${++ip}`);
    // 5 ล่าสุด = seventh(ปัจจุบัน), sixth, fifth, fourth, third → ซ้ำไม่ได้
    for (const old of ['seventh-password-2569', 'fourth-password-2569', 'third-password-2569'])
      expect(code(await change(s.access, cur, old))).toBe('password_reused');
    // second เก่ากว่า 5 ครั้ง → ใช้ได้
    await change(s.access, cur, 'second-password-2569').expect(204);
    const u = await db.appUser.findFirstOrThrow({ where: { email: 'pw@policy.test' } });
    expect(await db.passwordHistory.count({ where: { userId: u.id } })).toBeLessThanOrEqual(5);
  });

  it('เดารหัสเดิมผ่าน /me/password นับรวมเพดาน login: ผิด 5 ครั้ง → ถูกล็อก (429) แม้รหัสถูก', async () => {
    const u = await db.appUser.create({
      data: {
        tenantId,
        email: 'guess@policy.test',
        name: 'ทดสอบ',
        status: 'ACTIVE',
        passwordHash: await hashPassword(PW),
      },
    });
    void u;
    const s = await loginFull(app, 'guess@policy.test', PW, `10.51.0.${++ip}`);
    for (let i = 0; i < 5; i++)
      expect(code(await change(s.access, `wrong-guess-${i}-2569`, 'brand-new-password-1'))).toBe(
        'password_incorrect',
      );
    const locked = await change(s.access, PW, 'brand-new-password-1');
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('account_locked');
  });

  it('เปลี่ยนรหัสแล้ว access token เดิมใช้ไม่ได้ทันที (tokenVersion) — ทุก session ต้องเข้าใหม่', async () => {
    await db.appUser.create({
      data: {
        tenantId,
        email: 'tv@policy.test',
        name: 'ทดสอบ',
        status: 'ACTIVE',
        passwordHash: await hashPassword(PW),
      },
    });
    const a = await loginFull(app, 'tv@policy.test', PW, `10.51.0.${++ip}`);
    const b = await loginFull(app, 'tv@policy.test', PW, `10.51.0.${++ip}`);
    await change(a.access, PW, 'changed-password-2569').expect(204);
    expect((await api(app, b.access).get('/v1/me')).status).toBe(401);
    expect((await api(app, a.access).get('/v1/me')).status).toBe(401);
    const long = await change(
      (await loginFull(app, 'tv@policy.test', 'changed-password-2569', `10.51.0.${++ip}`)).access,
      'changed-password-2569',
      'x'.repeat(300),
    );
    expect(code(long)).toBe('password_too_long');
  });

  it('HIBP: ส่งแค่ prefix 5 ตัวของ SHA-1; ตรง suffix → รั่ว; บริการล่ม → ปล่อยผ่าน', async () => {
    const urls: string[] = [];
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    const ok = new HibpChecker(async (url) => {
      urls.push(String(url));
      return new Response(
        '1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\n0000000000000000000000000000000000A:0',
        { status: 200 },
      );
    });
    expect(await ok.isBreached('password')).toBe(true);
    expect(urls[0]).toBe('https://api.pwnedpasswords.com/range/5BAA6');
    expect(await ok.isBreached('not-in-list-2569')).toBe(false);
    const down = new HibpChecker(async () => {
      throw new Error('network');
    });
    expect(await down.isBreached('password')).toBe(false);
    void PasswordPolicy;
  });
});
