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

  const change = (token: string, currentPassword: string, newPassword: string) =>
    api(app, token).post('/v1/me/password').send({ currentPassword, newPassword });
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
