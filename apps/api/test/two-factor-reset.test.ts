import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import {
  signPlatformStepUpToken,
  signPlatformToken,
  pkceChallenge,
  signStepUpToken,
  sha256,
} from '../src/auth/tokens';
import { newTotpSecret } from '../src/auth/totp';
import { FieldCipher } from '../src/common/crypto';
import { encodeId } from '../src/common/ids';
import { renderEmail } from '../src/modules/email/templates';
import { api, bootApp, createTenant, loginFull, platform, tokenFor, truncateAll } from './helpers';

/**
 * คำถามค้าง #81 (PO 24 พ.ย. 2569) — รีเซ็ต 2FA ของผู้ใช้ที่ทำเครื่องหาย + รหัสสำรองหมด
 * ฝั่งบริษัท: `POST /v1/users/{id}/reset-2fa` (users:write + step-up + เหตุผล; owner ทำกับ owner เท่านั้น)
 * ฝั่ง Console: `POST /v1/platform/tenants/{id}/users/{userId}/reset-2fa` (SUPER_ADMIN + step-up Console + เหตุผล ≥ 10)
 */
describe('รีเซ็ต 2FA (#81)', () => {
  let app: NestExpressApplication;
  const db = platform();
  const srv = () => app.getHttpServer();
  const PW = 'reset-2fa-test-password-2569';
  let ip = 0;
  const nextIp = () => `10.81.${Math.floor(++ip / 250)}.${ip % 250}`;
  let tenantId: string;
  let roles: Record<string, string>;

  async function user(email: string, role: string) {
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
  /** ผู้ทำ (token dev ของผู้ใช้จริงในบริษัท) + step-up ของคนนั้น */
  async function actor(role: string) {
    const u = await user(`${role}-${randomUUID().slice(0, 6)}@reset.test`, role);
    return {
      u,
      token: await tokenFor(tenantId, 'users:read users:write audit:read', u.id),
      su: await signStepUpToken(u.id, tenantId),
    };
  }
  const reset = (token: string, target: { id: string }, su?: string, reason = 'ทำมือถือหาย') => {
    const r = api(app, token).post(`/v1/users/${encodeId('user', target.id)}/reset-2fa`);
    return (su ? r.set('X-Step-Up', su) : r).send({ reason });
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db, 'บริษัท รีเซ็ต')).id;
    roles = await ensureSystemRoles(db, tenantId);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('admin รีเซ็ต 2FA ของ planner: ต้อง step-up + เหตุผล; ล้าง TOTP/รหัสสำรอง, session/อุปกรณ์หลุด, login ใหม่ต้องตั้ง 2FA, audit + อีเมล', async () => {
    const admin = await actor('admin');
    const target = await user('planner@reset.test', 'planner');
    // planner ถือสิทธิ์สำคัญ (D-78) → login แรกตั้ง 2FA ให้ (loginFull)
    const s = await loginFull(app, 'planner@reset.test', PW, nextIp());
    expect(s.secret).toBeTruthy();
    expect(await db.backupCode.count({ where: { userId: target.id } })).toBe(10);
    const tv = (await db.appUser.findUniqueOrThrow({ where: { id: target.id } })).tokenVersion;
    await db.trustedDevice.create({
      data: {
        tokenHash: sha256(`dev-${target.id}`),
        tenantId,
        userId: target.id,
        tokenVersion: tv,
        expiresAt: new Date(Date.now() + 86400_000),
      },
    });

    // ไม่มี step-up → 403 · เหตุผลว่าง → 422 · ตัวเอง → 422
    expect((await reset(admin.token, target)).body.code).toBe('step_up_required');
    const blank = await reset(admin.token, target, admin.su, '  ');
    expect(blank.status).toBe(422);
    const self = await reset(admin.token, admin.u, admin.su);
    expect(self.status).toBe(422);
    expect(self.body.errors?.[0]?.code ?? self.body.code).toBe('self');
    // ไม่มีสิทธิ์ users:write → 403
    const viewer = await tokenFor(tenantId, 'users:read', admin.u.id);
    expect((await reset(viewer, target, admin.su)).status).toBe(403);

    const ok = await reset(admin.token, target, admin.su, 'ทำมือถือหาย รหัสสำรองหมด');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ id: encodeId('user', target.id), status: 'active' });

    const after = await db.appUser.findUniqueOrThrow({ where: { id: target.id } });
    expect([after.totpSecret, after.totpEnabledAt, after.totpLastStep]).toEqual([null, null, null]);
    expect(after.tokenVersion).toBe(tv + 1);
    expect(await db.backupCode.count({ where: { userId: target.id } })).toBe(0);
    expect(await db.trustedDevice.count({ where: { userId: target.id, revokedAt: null } })).toBe(0);
    expect(await db.refreshToken.count({ where: { userId: target.id, revokedAt: null } })).toBe(0);
    // session เดิมหลุดทันที (access + refresh)
    expect((await api(app, s.access).get('/v1/me')).status).toBe(401);
    const rt = await request(srv())
      .post('/v1/oauth/token')
      .set('Cookie', s.cookie)
      .send({ grantType: 'refresh_token' });
    expect(rt.status).toBe(400);
    // login ใหม่ → ขั้นตั้ง 2FA (D-78) — TOTP เดิมใช้ไม่ได้
    const login = await request(srv())
      .post('/v1/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({
        email: 'planner@reset.test',
        password: PW,
        codeChallenge: pkceChallenge('x'.repeat(43)),
      });
    expect(login.body.code).toBe('mfa_enrollment_required');
    const again = await loginFull(app, 'planner@reset.test', PW, nextIp());
    expect(again.secret).toBeTruthy();
    expect(again.secret).not.toBe(s.secret);

    const audit = await db.auditLog.findMany({
      where: { entityId: target.id, action: 'user.2fa_reset' },
    });
    expect(audit.map((a) => [a.actorId, a.reason, a.before, a.after])).toEqual([
      [
        admin.u.id,
        'ทำมือถือหาย รหัสสำรองหมด',
        { twoFactorEnabled: true },
        { twoFactorEnabled: false },
      ],
    ]);
    const mail = await db.emailOutbox.findMany({
      where: { toAddress: 'planner@reset.test', template: 'two_factor_reset' },
    });
    expect(mail).toHaveLength(1);
    expect(mail[0]!.tenantId).toBe(tenantId);
    expect(mail[0]!.textBody).toContain(admin.u.name);
    expect(mail[0]!.textBody).toContain('ทำมือถือหาย รหัสสำรองหมด');
    expect(mail[0]!.textBody).not.toContain('ทีมงาน TMS');
    expect(mail[0]!.textBody).toContain('ระบบจะให้ตั้ง 2FA ใหม่');
  });

  it('ผู้ใช้ที่ role ไม่บังคับ 2FA: หลังรีเซ็ตเข้าด้วยรหัสผ่านได้เลย (ไม่ถามตั้ง 2FA) + อีเมลบอกว่า 2FA ปิดอยู่', async () => {
    const admin = await actor('admin');
    const v = await user('viewer@reset.test', 'viewer');
    await db.appUser.update({
      where: { id: v.id },
      data: { totpEnabledAt: new Date(), totpSecret: new FieldCipher().encrypt(newTotpSecret()) },
    });
    expect((await reset(admin.token, v, admin.su)).status).toBe(200);
    const login = await request(srv())
      .post('/v1/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({
        email: 'viewer@reset.test',
        password: PW,
        codeChallenge: pkceChallenge('y'.repeat(43)),
      });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.code).toBeTruthy();
    const [mail] = await db.emailOutbox.findMany({
      where: { toAddress: 'viewer@reset.test', template: 'two_factor_reset' },
    });
    expect(mail!.textBody).toContain('ตอนนี้บัญชีของคุณไม่มี 2FA');
    expect(mail!.textBody).not.toContain('ระบบจะให้ตั้ง 2FA ใหม่');
  });

  it('ลบแล้ว → 409 · ตัวเอง → 422 · ไม่ส่ง X-Step-Up → 403 step_up_required', async () => {
    const admin = await actor('admin');
    const gone = await user('gone@reset.test', 'planner');
    await db.appUser.update({
      where: { id: gone.id },
      data: { status: 'DELETED', totpEnabledAt: new Date(), totpSecret: 'enc' },
    });
    expect((await reset(admin.token, gone, admin.su)).status).toBe(409);
    const self = await reset(admin.token, admin.u, admin.su);
    expect(self.status).toBe(422);
    const noSu = await reset(admin.token, gone);
    expect(noSu.status).toBe(403);
    expect(noSu.body.code).toBe('step_up_required');
  });

  it('รีเซ็ตพร้อมกัน 2 ครั้ง → 200 หนึ่งครั้ง 409 หนึ่งครั้ง · audit/อีเมลแถวเดียว', async () => {
    const admin = await actor('admin');
    const t = await user('race@reset.test', 'planner');
    await db.appUser.update({
      where: { id: t.id },
      data: { totpEnabledAt: new Date(), totpSecret: 'enc' },
    });
    const rs = await Promise.all([
      reset(admin.token, t, admin.su, 'พร้อมกัน 1'),
      reset(admin.token, t, admin.su, 'พร้อมกัน 2'),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.auditLog.count({ where: { entityId: t.id, action: 'user.2fa_reset' } })).toBe(
      1,
    );
    expect(
      await db.emailOutbox.count({
        where: { toAddress: 'race@reset.test', template: 'two_factor_reset' },
      }),
    ).toBe(1);
  });

  it('ยังไม่ได้ตั้ง 2FA → 409 · ข้าม tenant → 404', async () => {
    const admin = await actor('admin');
    const plain = await user('plain@reset.test', 'dispatcher');
    expect((await reset(admin.token, plain, admin.su)).status).toBe(409);
    const other = (await createTenant(db, 'บริษัทอื่น')).id;
    const stranger = await db.appUser.create({
      data: {
        tenantId: other,
        email: 'x@other.test',
        name: 'x',
        status: 'ACTIVE',
        totpEnabledAt: new Date(),
        totpSecret: 'x',
      },
    });
    const r = await reset(admin.token, stranger, admin.su);
    expect(r.status).toBe(404);
    expect(
      (await db.appUser.findUniqueOrThrow({ where: { id: stranger.id } })).totpEnabledAt,
    ).not.toBeNull();
  });

  it('owner: admin รีเซ็ตให้ไม่ได้ (403 manage_owner) · owner อีกคนรีเซ็ตได้', async () => {
    const admin = await actor('admin');
    const owner = await actor('owner');
    const lost = await user('owner2@reset.test', 'owner');
    await db.appUser.update({
      where: { id: lost.id },
      data: { totpEnabledAt: new Date(), totpSecret: 'enc' },
    });
    const denied = await reset(admin.token, lost, admin.su);
    expect(denied.status).toBe(403);
    expect(denied.body.action).toBe('manage_owner');
    // owner ที่ยังไม่ตั้ง 2FA: ด่าน owner มาก่อนสถานะ → admin ได้ 403 ไม่ใช่ 409 (ไม่เผยสถานะ 2FA ของ owner)
    const owner3 = await user('owner3@reset.test', 'owner');
    expect((await reset(admin.token, owner3, admin.su)).status).toBe(403);
    expect((await reset(owner.token, owner3, owner.su)).status).toBe(409);
    expect((await reset(owner.token, lost, owner.su)).status).toBe(200);
  });

  describe('Platform Console', () => {
    const mk = async (role: 'SUPER_ADMIN' | 'SUPPORT') => {
      const u = await db.platformUser.create({
        data: {
          email: `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@innovera.test`,
          name: `ทีม ${role}`,
          role,
          passwordHash: 'x',
          totpSecret: 'x',
        },
      });
      return {
        u,
        token: await signPlatformToken({ sub: u.id, role, tv: u.tokenVersion }),
        su: await signPlatformStepUpToken(u.id, u.tokenVersion),
      };
    };
    const call = (
      s: { token: string; su?: string },
      tid: string,
      uid: string,
      reason = 'owner คนเดียวทำมือถือหาย ยืนยันตัวตนทางโทรศัพท์แล้ว',
    ) => {
      const r = request(srv())
        .post(
          `/v1/platform/tenants/${encodeId('tenant', tid)}/users/${encodeId('user', uid)}/reset-2fa`,
        )
        .set('Authorization', `Bearer ${s.token}`);
      return (s.su ? r.set('X-Step-Up', s.su) : r).send({ reason });
    };

    it('owner คนเดียวทำเครื่องหาย: SUPER_ADMIN + step-up รีเซ็ตได้ · audit actor platform + อีเมลแจ้ง', async () => {
      const tid = (await createTenant(db, 'บริษัท owner เดียว')).id;
      const r = await ensureSystemRoles(db, tid);
      const owner = await db.appUser.create({
        data: {
          tenantId: tid,
          email: 'solo@reset.test',
          name: 'เจ้าของ',
          status: 'ACTIVE',
          passwordHash: await hashPassword(PW),
          totpEnabledAt: new Date(),
          totpSecret: 'enc',
        },
      });
      await db.userRole.create({ data: { tenantId: tid, userId: owner.id, roleId: r.owner! } });
      const sa = await mk('SUPER_ADMIN');
      const support = await mk('SUPPORT');

      const noSu = await call({ token: sa.token }, tid, owner.id);
      expect(noSu.body.code).toBe('step_up_required');
      expect((await call(support, tid, owner.id)).status).toBe(403);
      expect((await call(sa, tid, owner.id, 'สั้น')).status).toBe(422);
      // ผู้ใช้ของบริษัทอื่นผ่าน tenant นี้ → 404
      expect((await call(sa, tenantId, owner.id)).status).toBe(404);
      // token ลูกค้าเรียก route Console ไม่ได้
      const cust = await tokenFor(tid, '*', owner.id);
      expect(
        (await call({ token: cust, su: await signStepUpToken(owner.id, tid) }, tid, owner.id))
          .status,
      ).toBe(401);

      const ok = await call(sa, tid, owner.id);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toEqual({ id: encodeId('user', owner.id), twoFactorEnabled: false });
      expect(
        (await db.appUser.findUniqueOrThrow({ where: { id: owner.id } })).totpEnabledAt,
      ).toBeNull();
      expect((await call(sa, tid, owner.id)).status).toBe(409);

      const audit = await db.auditLog.findMany({
        where: { tenantId: tid, action: 'user.2fa_reset' },
      });
      expect(audit.map((a) => [a.actorId, a.entityId, a.reason])).toEqual([
        [`platform:${sa.u.id}`, owner.id, 'owner คนเดียวทำมือถือหาย ยืนยันตัวตนทางโทรศัพท์แล้ว'],
      ]);
      const mail = await db.emailOutbox.findMany({
        where: { tenantId: tid, template: 'two_factor_reset' },
      });
      expect(mail.map((m) => m.toAddress)).toEqual(['solo@reset.test']);
      expect(mail[0]!.textBody).toContain('ทีม SUPER_ADMIN จากทีมงาน TMS');

      // owner เข้าได้อีกครั้ง → ขั้นตั้ง 2FA ใหม่
      const again = await loginFull(app, 'solo@reset.test', PW, nextIp());
      expect(again.secret).toBeTruthy();

      // รายละเอียดบริษัทใน Console แสดงสถานะ 2FA ของสมาชิก
      const detail = await request(srv())
        .get(`/v1/platform/tenants/${encodeId('tenant', tid)}`)
        .set('Authorization', `Bearer ${sa.token}`);
      expect(detail.body.members[0].twoFactorEnabled).toBe(true);
    });

    it('ผู้ใช้ที่ถูกระงับ: รีเซ็ตได้ (เหมือนฝั่งบริษัท) · ลบแล้ว → 404 · รีเซ็ตพร้อมกัน → 200 + 409', async () => {
      const sa = await mk('SUPER_ADMIN');
      const mkUser = (email: string, status: 'DISABLED' | 'DELETED' | 'ACTIVE') =>
        db.appUser.create({
          data: {
            tenantId,
            email,
            name: email,
            status,
            totpEnabledAt: new Date(),
            totpSecret: 'e',
          },
        });
      const off = await mkUser('off@reset.test', 'DISABLED');
      expect((await call(sa, tenantId, off.id)).status).toBe(200);
      expect(
        (await db.appUser.findUniqueOrThrow({ where: { id: off.id } })).totpEnabledAt,
      ).toBeNull();
      const gone = await mkUser('gone2@reset.test', 'DELETED');
      expect((await call(sa, tenantId, gone.id)).status).toBe(404);
      const race = await mkUser('race2@reset.test', 'ACTIVE');
      const rs = await Promise.all([call(sa, tenantId, race.id), call(sa, tenantId, race.id)]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        await db.auditLog.count({ where: { entityId: race.id, action: 'user.2fa_reset' } }),
      ).toBe(1);
      expect(
        await db.emailOutbox.count({
          where: { toAddress: 'race2@reset.test', template: 'two_factor_reset' },
        }),
      ).toBe(1);
    });
  });

  it('template อีเมล: ไทย/อังกฤษ escape HTML', () => {
    const v = {
      tenantName: 'A<b>',
      actorName: 'สมชาย',
      byStaff: false,
      reason: 'หาย',
      at: '24 พ.ย. 2569',
      mustEnroll: true,
    };
    const th = renderEmail('two_factor_reset', 'th', v);
    expect(th.subject).toContain('2FA');
    expect(th.html).toContain('A&lt;b&gt;');
    const en = renderEmail('two_factor_reset', 'en', { ...v, byStaff: true });
    expect(en.text).toContain('from the TMS team');
    expect(en.text).toContain('asked to set up 2FA again');
    const off = renderEmail('two_factor_reset', 'en', { ...v, mustEnroll: false });
    expect(off.text).toContain('no longer has 2FA');
    expect(off.text).not.toContain('set up 2FA again');
  });
});
