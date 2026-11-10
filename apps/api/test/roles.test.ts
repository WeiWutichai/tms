import type { NestExpressApplication } from '@nestjs/platform-express';
import { ROLE_CODES, SYSTEM_ROLES, type RoleCode } from '@tms/domain';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { pkceChallenge } from '../src/auth/tokens';
import { api, bootApp, createTenant, platform, truncateAll, validTaxId } from './helpers';

/**
 * ST1-T12 — ตาราง A3 ระดับ endpoint: login จริงเป็นผู้ใช้ 1 คนต่อ role แล้วเรียก endpoint ตัวแทนของแต่ละแถว
 * (แถวที่ยังไม่มี endpoint ตรวจที่ระดับ scope ใน packages/domain/src/permissions.test.ts)
 */
describe('roles: A3 ผ่าน API จริง', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  const tokens = {} as Record<RoleCode, string>;
  const PW = 'role-test-password-2569';

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    const ids = await ensureSystemRoles(db, tenantId);
    const passwordHash = await hashPassword(PW);
    let n = 0;
    for (const code of ROLE_CODES) {
      const email = `${code}@roles.test`;
      const u = await db.appUser.create({
        data: { tenantId, email, name: `ทดสอบ ${code}`, status: 'ACTIVE', passwordHash },
      });
      await db.userRole.create({ data: { tenantId, userId: u.id, roleId: ids[code]! } });
      const v = randomBytes(32).toString('base64url');
      const r1 = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Forwarded-For', `10.9.0.${++n}`)
        .send({ email, password: PW, codeChallenge: pkceChallenge(v) })
        .expect(200);
      const r2 = await request(app.getHttpServer())
        .post('/v1/oauth/token')
        .send({ grantType: 'authorization_code', code: r1.body.code, codeVerifier: v })
        .expect(200);
      tokens[code] = r2.body.accessToken;
    }
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const ROWS: Array<[string, (t: string) => Promise<number>, RoleCode[]]> = [
    [
      'user / role (GET /users)',
      async (t) => (await api(app, t).get('/v1/users')).status,
      ['owner', 'admin', 'manager'],
    ],
    [
      'user / role (GET /roles)',
      async (t) => (await api(app, t).get('/v1/roles')).status,
      ['owner', 'admin', 'manager'],
    ],
    [
      'ตั้งค่าองค์กร (POST /companies)',
      async (t) =>
        (
          await api(app, t)
            .post('/v1/companies')
            .send({
              legalName: 'บริษัท ทดสอบสิทธิ์ จำกัด',
              taxId: validTaxId(Math.floor(Math.random() * 1e8)),
            })
        ).status,
      ['owner', 'admin'],
    ],
    [
      'อ่านนิติบุคคล (GET /companies)',
      async (t) => (await api(app, t).get('/v1/companies')).status,
      [...ROLE_CODES],
    ],
    [
      'งานเบื้องหลัง (GET /jobs/:id)',
      async (t) => (await api(app, t).get('/v1/jobs/job_00000000000000000000000000000000')).status,
      ['owner', 'admin'],
    ],
  ];

  it.each(ROWS)('%s', async (_row, call, allowed) => {
    for (const code of ROLE_CODES) {
      const status = await call(tokens[code]);
      const ok = status !== 403;
      expect([code, ok], `status ${status}`).toEqual([code, allowed.includes(code)]);
    }
  });

  it('token ของผู้ใช้มี scope ตรงกับ role (ไม่มี *)', async () => {
    for (const code of ROLE_CODES) {
      const me = await api(app, tokens[code]).get('/v1/me').expect(200);
      expect(me.body.scopes).toEqual([...SYSTEM_ROLES[code].permissions].sort());
      expect(me.body.scopes).not.toContain('*');
    }
  });

  it('GET /users คืน role และสถานะ 2FA; ไม่ส่ง hash/secret', async () => {
    const res = await api(app, tokens.owner).get('/v1/users').expect(200);
    expect(res.body.data).toHaveLength(ROLE_CODES.length);
    const planner = res.body.data.find((u: { email: string }) => u.email === 'planner@roles.test');
    expect(planner.roles).toEqual([
      expect.objectContaining({ code: 'planner', name: 'ผู้วางแผน' }),
    ]);
    expect(planner.twoFactorEnabled).toBe(false);
    expect(planner.lastLoginAt).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|totpSecret|argon2/);
  });

  it('GET /roles เรียงตาม A3 และเป็น role ระบบทั้งหมด', async () => {
    const res = await api(app, tokens.admin).get('/v1/roles').expect(200);
    expect(res.body.data.map((r: { code: string }) => r.code)).toEqual([...ROLE_CODES]);
    expect(res.body.data.every((r: { isSystem: boolean }) => r.isSystem)).toBe(true);
  });
});
