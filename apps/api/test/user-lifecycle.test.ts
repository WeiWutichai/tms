import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeAuthData } from '../src/auth/maintenance';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { encodeId } from '../src/common/ids';
import { api, bootApp, createTenant, loginFull, platform, tokenFor, truncateAll } from './helpers';

/** ST1-T10 ระงับ/เปิดใช้/ลบผู้ใช้ · ST1-T11 ประวัติ login */
describe('user lifecycle + login history', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let roles: Record<string, string>;
  let admin: string;
  let ip = 0;
  const PW = 'lifecycle-test-password-2569';
  const nextIp = () => `10.40.${Math.floor(++ip / 250)}.${ip % 250}`;

  async function user(email: string, role = 'planner') {
    const u = await db.appUser.create({
      data: {
        tenantId,
        email,
        name: `ทดสอบ ${email}`,
        status: 'ACTIVE',
        passwordHash: await hashPassword(PW),
      },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles[role]! } });
    return u;
  }
  const act = (token: string, u: { id: string }, action: string, reason = 'ทดสอบ') =>
    api(app, token)
      .post(`/v1/users/${encodeId('user', u.id)}/${action}`)
      .send({ reason });

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    roles = await ensureSystemRoles(db, tenantId);
    admin = await tokenFor(tenantId, 'users:read users:write audit:read');
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('ระงับ → session ที่เปิดอยู่หลุดทันที (access + refresh) และ login ไม่ได้; เปิดใช้คืนแล้วเข้าได้', async () => {
    const u = await user('s@life.test');
    const s = await loginFull(app, 's@life.test', PW, nextIp());
    expect((await api(app, s.access).get('/v1/me')).status).toBe(200);
    const blank = await act(admin, u, 'suspend', '  ');
    expect(blank.status).toBe(422);
    const res = await act(admin, u, 'suspend', 'ลาพักยาว');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disabled');
    expect((await api(app, s.access).get('/v1/me')).status).toBe(401);
    const rt = await request(app.getHttpServer())
      .post('/v1/oauth/token')
      .set('Cookie', s.cookie)
      .send({ grantType: 'refresh_token' });
    expect(rt.status).toBe(400);
    await expect(loginFull(app, 's@life.test', PW, nextIp())).rejects.toThrow(/401/);
    expect((await act(admin, u, 'suspend')).status).toBe(409);
    await act(admin, u, 'activate', 'กลับมาทำงาน').expect(200);
    expect((await loginFull(app, 's@life.test', PW, nextIp())).access).toBeTruthy();
    const audit = await db.auditLog.findMany({
      where: { entityId: u.id },
      orderBy: { seq: 'asc' },
    });
    expect(audit.map((a) => [a.action, a.reason])).toEqual([
      ['user.disabled', 'ลาพักยาว'],
      ['user.enabled', 'กลับมาทำงาน'],
    ]);
  });

  it('ลบ = anonymize: ข้อมูลส่วนตัวหาย, ไม่อยู่ในรายการ, login ไม่ได้, audit ยังอ้างถึงแบบไม่เผยชื่อ', async () => {
    const u = await user('d@life.test');
    const d = await loginFull(app, 'd@life.test', PW, nextIp());
    // ผู้ใช้นี้ทำรายการไว้ก่อนถูกลบ → audit ของรายการนั้นต้องแสดงชื่อแบบ anonymize
    await db.auditLog.create({
      data: { tenantId, actorId: u.id, action: 'x.did', entityType: 'company' },
    });
    await act(admin, u, 'delete', 'พนักงานลาออก').expect(200);
    const row = await db.appUser.findUniqueOrThrow({ where: { id: u.id } });
    expect(row).toMatchObject({
      status: 'DELETED',
      name: 'ผู้ใช้ที่ลบแล้ว',
      passwordHash: null,
      phone: null,
      totpSecret: null,
    });
    expect(row.email).not.toContain('d@life.test');
    expect(await db.userRole.count({ where: { userId: u.id } })).toBe(0);
    expect((await api(app, d.access).get('/v1/me')).status).toBe(401);
    const list = await api(app, admin).get('/v1/users').expect(200);
    expect(list.body.data.map((x: { email: string }) => x.email)).not.toContain(row.email);
    const audit = await api(app, admin).get('/v1/audit-logs?entityType=company').expect(200);
    const mine = audit.body.data.find((a: { action: string }) => a.action === 'x.did');
    expect(mine.actor.name).toBe('ผู้ใช้ที่ลบแล้ว');
    expect(JSON.stringify(audit.body)).not.toContain('d@life.test');
    expect((await act(admin, u, 'delete')).status).toBe(409);
  });

  it('ทำกับตัวเองไม่ได้; admin ระงับ/ลบ owner ไม่ได้ (owner ทำได้)', async () => {
    const owner1 = await user('o1@life.test', 'owner');
    await user('o2@life.test', 'owner');
    const o1 = await loginFull(app, 'o1@life.test', PW, nextIp());
    expect((await act(o1.access, owner1, 'suspend')).body.errors[0].code).toBe('self');
    await user('ad@life.test', 'admin');
    const ad = await loginFull(app, 'ad@life.test', PW, nextIp());
    const o2 = await db.appUser.findFirstOrThrow({ where: { email: 'o2@life.test' } });
    const denied = await act(ad.access, o2, 'suspend');
    expect(denied.status).toBe(403);
    expect(denied.body.action).toBe('manage_owner');
    await act(o1.access, o2, 'suspend').expect(200);
    // manager/viewer ไม่มีสิทธิ์
    await user('mg@life.test', 'manager');
    const mg = await loginFull(app, 'mg@life.test', PW, nextIp());
    expect((await act(mg.access, o2, 'activate')).status).toBe(403);
  });

  it('ประวัติ login: สำเร็จ/ผิด/ล็อกของผู้ใช้ใน tenant, กรองตามผู้ใช้, tenant อื่นไม่เห็น, ไม่แสดงแถวภายใน', async () => {
    const u = await user('h@life.test');
    const hip = nextIp();
    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('X-Forwarded-For', hip)
      .send({
        email: 'h@life.test',
        password: 'wrong-password-123',
        codeChallenge: 'a'.repeat(43),
      });
    await loginFull(app, 'h@life.test', PW, hip);
    const res = await api(app, admin)
      .get(`/v1/login-history?userId=${encodeId('user', u.id)}`)
      .expect(200);
    const reasons = res.body.data.map((r: { reason: string }) => r.reason);
    expect(reasons).toContain('invalid_credentials');
    expect(reasons).toContain('ok');
    expect(reasons).not.toContain('attempt');
    expect(res.body.data[0]).toMatchObject({
      userId: encodeId('user', u.id),
      email: 'h@life.test',
      ip: hip,
    });
    expect(res.body.data.find((r: { reason: string }) => r.reason === 'ok').result).toBe('success');
    const t2 = await createTenant(db);
    const other = await tokenFor(t2.id, 'users:read');
    expect((await api(app, other).get('/v1/login-history')).body.data).toEqual([]);
    const viewer = await tokenFor(tenantId, 'companies:read');
    expect((await api(app, viewer).get('/v1/login-history')).status).toBe(403);
  });

  it('job บำรุงรักษา: ลบประวัติ login ที่เก่ากว่า 1 ปี เก็บที่ใหม่กว่าไว้', async () => {
    const old = await db.loginAttempt.create({
      data: {
        email: 'old@life.test',
        ip: '1.1.1.1',
        success: true,
        reason: 'ok',
        tenantId,
        createdAt: new Date(Date.now() - 400 * 864e5),
      },
    });
    const recent = await db.loginAttempt.create({
      data: {
        email: 'new@life.test',
        ip: '1.1.1.1',
        success: true,
        reason: 'ok',
        tenantId,
        createdAt: new Date(Date.now() - 300 * 864e5),
      },
    });
    const r = await purgeAuthData(db);
    expect(r.loginAttempts).toBeGreaterThanOrEqual(1);
    expect(await db.loginAttempt.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.loginAttempt.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});
