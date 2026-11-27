import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { currentStep, hotp } from '../src/auth/totp';
import { FieldCipher } from '../src/common/crypto';
import { encodeId } from '../src/common/ids';
import { EmailDispatcher } from '../src/modules/email/email.service';
import { MemoryTransport } from '../src/modules/email/transport';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bootApp, platform, stepUpHeaderFor, tokenFor, truncateAll } from './helpers';

const SECRET = 'JBSWY3DPEHPK3PXP';
const PW = 'platform-password-2569';
type Role = 'SUPER_ADMIN' | 'SUPPORT' | 'BILLING';

/**
 * P1-ST4-T06 Console ทีมงาน + Audit log (spec/01 §10.8, §11.5)
 * เกณฑ์ตรวจรับ: ปิดทีมงานแล้ว session หลุดทันที · audit แสดงการเข้าใช้งานแทนพร้อม `act`
 */
describe('platform console: ทีมงาน + audit log (P1-ST4-T06)', () => {
  let app: NestExpressApplication;
  const db = platform();
  const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  let mail: MemoryTransport;
  let dispatcher: EmailDispatcher;
  const ids: Record<string, string> = {};
  const http = () => request(app.getHttpServer());

  async function staff(key: string, role: Role) {
    const u = await db.platformUser.create({
      data: {
        email: `${key}@innovera.test`,
        name: `ทีม ${key}`,
        role,
        passwordHash: await hashPassword(PW),
        totpSecret: new FieldCipher().encrypt(SECRET),
      },
    });
    ids[key] = u.id;
    return u;
  }
  async function signIn(key: string, secret = SECRET, password = PW) {
    const u = await db.platformUser.findUniqueOrThrow({ where: { id: ids[key]! } });
    await db.platformUser.update({ where: { id: u.id }, data: { totpLastStep: null } });
    const c = await http().post('/v1/platform/auth/login').send({ email: u.email, password });
    expect(c.status).toBe(200);
    const t = await http()
      .post('/v1/platform/auth/mfa')
      .send({ challenge: c.body.challenge, code: hotp(secret, currentStep()) });
    expect(t.status).toBe(200);
    return t.body.accessToken as string;
  }
  const as = (token: string, stepUp = true) => ({
    get: (p: string) => http().get(p).set('Authorization', `Bearer ${token}`),
    post: (p: string, b: object = {}) => {
      const r = http().post(p).set('Authorization', `Bearer ${token}`);
      const su = stepUp ? stepUpHeaderFor(token) : null;
      return (su ? r.set('X-Step-Up', su) : r).send(b);
    },
  });
  const sid = (k: string) => encodeId('platformUser', ids[k]!);

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    dispatcher = app.get(EmailDispatcher);
    await staff('admin', 'SUPER_ADMIN');
    await staff('admin2', 'SUPER_ADMIN');
    await staff('support', 'SUPPORT');
    await staff('billing', 'BILLING');
  });
  beforeEach(() => {
    mail = new MemoryTransport();
    dispatcher.use(mail);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await appDb.$disconnect();
  });

  it('ตารางทีม: ทุกบทบาทดูได้ (role, 2FA, login ล่าสุด, สถานะ) · token ลูกค้าใช้ไม่ได้', async () => {
    const list = (
      await as(await signIn('billing'))
        .get('/v1/platform/team')
        .expect(200)
    ).body;
    const me = list.find((x: { id: string }) => x.id === sid('billing'));
    expect(me).toMatchObject({
      email: 'billing@innovera.test',
      role: 'BILLING',
      twoFactorEnabled: true,
      status: 'active',
      inviteExpiresAt: null,
    });
    expect(me.lastLoginAt).toMatch(/^\d{4}-/);
    const tenant = await createTenantWithDefaults(db, { name: 'ลูกค้า ก', status: 'ACTIVE' });
    await http()
      .get('/v1/platform/team')
      .set('Authorization', `Bearer ${await tokenFor(tenant.id)}`)
      .expect(401);
  });

  it('เชิญทีมงาน: SUPER_ADMIN + step-up + เหตุผล → อีเมลลิงก์ → ตั้งรหัสผ่าน + 2FA → login ได้ · audit ครบ', async () => {
    const support = as(await signIn('support'));
    const body = {
      email: 'New.Staff@Innovera.test',
      name: 'มาลี ใจดี',
      role: 'SUPPORT',
      reason: 'รับพนักงานซัพพอร์ตใหม่ประจำทีม',
    };
    await support.post('/v1/platform/team/invitations', body).expect(403); // ไม่ใช่ SUPER_ADMIN
    const adminToken = await signIn('admin');
    const admin = as(adminToken);
    const noSu = await as(adminToken, false).post('/v1/platform/team/invitations', body);
    expect(noSu.status).toBe(403);
    expect(noSu.body.code).toBe('step_up_required');
    await admin.post('/v1/platform/team/invitations', { ...body, reason: 'สั้น' }).expect(422);
    await admin.post('/v1/platform/team/invitations', { ...body, role: 'OWNER' }).expect(422);
    const inv = (await admin.post('/v1/platform/team/invitations', body).expect(201)).body;
    expect(inv).toMatchObject({
      email: 'new.staff@innovera.test',
      status: 'invited',
      twoFactorEnabled: false,
      lastLoginAt: null,
    });
    // บัญชีที่ใช้งานอยู่แล้ว → 409
    await admin
      .post('/v1/platform/team/invitations', { ...body, email: 'support@innovera.test' })
      .expect(409);
    await dispatcher.drain();
    const m = mail.sent.find((x) => x.to === 'new.staff@innovera.test');
    expect(m?.subject).toContain('TMS Platform Console');
    const token = /\/console\/invite#token=([\w-]+)/.exec(m!.text)![1]!;
    // ยังรับคำเชิญไม่เสร็จ = login ไม่ได้
    await http()
      .post('/v1/platform/auth/login')
      .send({ email: 'new.staff@innovera.test', password: PW })
      .expect(401);
    const info = (
      await http().post('/v1/platform/auth/invitations/inspect').send({ token }).expect(200)
    ).body;
    expect(info).toMatchObject({ email: 'new.staff@innovera.test', role: 'SUPPORT' });
    expect(info.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const accept = (code: string, password = 'staff-password-2569') =>
      http().post('/v1/platform/auth/invitations/accept').send({ token, password, code });
    const bad = await accept('000000');
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'code', code: 'invalid_otp' });
    await accept(hotp(info.secret, currentStep()), 'short').expect(422);
    await accept(hotp(info.secret, currentStep())).expect(204);
    await accept(hotp(info.secret, currentStep())).expect(400); // ใช้ซ้ำไม่ได้
    await http().post('/v1/platform/auth/invitations/inspect').send({ token }).expect(400);
    ids.newbie = (
      await db.platformUser.findUniqueOrThrow({ where: { email: 'new.staff@innovera.test' } })
    ).id;
    expect(inv.id).toBe(sid('newbie'));
    const t = await signIn('newbie', info.secret, 'staff-password-2569');
    expect((await as(t).get('/v1/platform/auth/me').expect(200)).body.role).toBe('SUPPORT');
    const rows = await db.platformAuditLog.findMany({
      where: { entityId: ids.newbie },
      orderBy: { seq: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['platform.staff_invited', 'platform.staff_joined']);
    expect(rows[0]).toMatchObject({ actorId: ids.admin, reason: body.reason });
    // ไม่มี secret/รหัสผ่านใน audit (PLT-127)
    expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(
      info.secret,
    );
  });

  it('ปิดทีมงาน: token Console + การเข้าใช้งานแทนที่เปิดอยู่หลุดทันที · login ไม่ได้ · เชิญกลับได้', async () => {
    const tenant = await createTenantWithDefaults(db, {
      name: 'บริษัท ปิดทีม จำกัด',
      status: 'ACTIVE',
    });
    const roles = await ensureSystemRoles(db, tenant.id);
    const owner = await db.appUser.create({
      data: {
        tenantId: tenant.id,
        email: 'owner@close.test',
        name: 'คุณเจ้าของ',
        status: 'ACTIVE',
      },
    });
    await db.userRole.create({
      data: { tenantId: tenant.id, userId: owner.id, roleId: roles.owner! },
    });
    const supportToken = await signIn('support');
    const sp = as(supportToken);
    await sp.get('/v1/platform/auth/me').expect(200);
    const imp = (
      await sp
        .post(`/v1/platform/tenants/${encodeId('tenant', tenant.id)}/impersonate`, {
          reason: 'ช่วยลูกค้าตรวจการนำเข้า',
        })
        .expect(200)
    ).body;
    await http().get('/v1/me').set('Authorization', `Bearer ${imp.accessToken}`).expect(200);

    const admin = as(await signIn('admin'));
    const reason = 'ลาออกจากบริษัท ปิดสิทธิ์ทันที';
    await as(supportToken)
      .post(`/v1/platform/team/${sid('admin2')}/deactivate`, { reason })
      .expect(403);
    await admin
      .post(`/v1/platform/team/${sid('support')}/deactivate`, { reason: 'สั้น' })
      .expect(422);
    await admin.post(`/v1/platform/team/stf_${'0'.repeat(32)}/deactivate`, { reason }).expect(404);
    const self = await admin.post(`/v1/platform/team/${sid('admin')}/deactivate`, { reason });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('staff_deactivate_not_allowed');
    const r = (
      await admin.post(`/v1/platform/team/${sid('support')}/deactivate`, { reason }).expect(200)
    ).body;
    expect(r).toMatchObject({ id: sid('support'), status: 'disabled' });

    // session หลุดทันที — token Console เดิม + token เข้าใช้งานแทน
    await sp.get('/v1/platform/auth/me').expect(401);
    await sp.get('/v1/platform/tenants').expect(401);
    await http().get('/v1/me').set('Authorization', `Bearer ${imp.accessToken}`).expect(401);
    const s = await db.impersonationSession.findUniqueOrThrow({ where: { id: imp.sessionId } });
    expect(s.endReason).toBe('revoked');
    expect(s.endedAt).not.toBeNull();
    // login ใหม่ไม่ได้
    await db.platformUser.update({ where: { id: ids.support! }, data: { failedLogins: 0 } });
    await http()
      .post('/v1/platform/auth/login')
      .send({ email: 'support@innovera.test', password: PW })
      .expect(401);
    // ปิดซ้ำ → 409
    await admin.post(`/v1/platform/team/${sid('support')}/deactivate`, { reason }).expect(409);
    const a = await db.platformAuditLog.findFirstOrThrow({
      where: { action: 'platform.staff_deactivated', entityId: ids.support },
    });
    expect(a).toMatchObject({ actorId: ids.admin, reason });
    expect(a.after).toMatchObject({ status: 'disabled', impersonationsEnded: 1 });

    // SUPER_ADMIN ปิด SUPER_ADMIN อีกคนได้ (ยังเหลือผู้ปิดเอง)
    await admin.post(`/v1/platform/team/${sid('admin2')}/deactivate`, { reason }).expect(200);
    // เชิญกลับ = บัญชีเดิม (สถานะ invited) ต้องตั้งรหัส + 2FA ใหม่
    const back = (
      await admin
        .post('/v1/platform/team/invitations', {
          email: 'support@innovera.test',
          name: 'ทีม support',
          role: 'SUPPORT',
          reason: 'กลับมาทำงานต่อหลังลาพัก',
        })
        .expect(201)
    ).body;
    expect(back).toMatchObject({ id: sid('support'), status: 'invited' });
    const re = await db.platformAuditLog.findFirstOrThrow({
      where: { action: 'platform.staff_reinvited', entityId: ids.support },
    });
    expect(re.before).toMatchObject({ status: 'disabled' });
  });

  it('Audit log ข้าม tenant: การเข้าใช้งานแทนแสดงทีมงานจาก claim `act` + ในนามผู้ใช้ · กรอง · แบ่งหน้า · ส่งออก CSV', async () => {
    await db.platformUser.update({
      where: { id: ids.support! },
      data: {
        status: 'ACTIVE',
        inviteTokenHash: null,
        failedLogins: 0,
        lockedUntil: null,
        totpSecret: new FieldCipher().encrypt(SECRET),
        passwordHash: await hashPassword(PW),
      },
    });
    const t1 = await createTenantWithDefaults(db, { name: 'บริษัท หนึ่ง จำกัด', status: 'ACTIVE' });
    const t2 = await createTenantWithDefaults(db, { name: 'บริษัท สอง จำกัด', status: 'ACTIVE' });
    const roles = await ensureSystemRoles(db, t1.id);
    const owner = await db.appUser.create({
      data: { tenantId: t1.id, email: 'owner@one.test', name: 'คุณหนึ่ง', status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId: t1.id, userId: owner.id, roleId: roles.owner! } });
    // การกระทำของผู้ใช้ลูกค้าเอง — ไม่อยู่ใน audit ของ Console
    await db.auditLog.create({
      data: {
        tenantId: t1.id,
        actorId: owner.id,
        action: 'company.updated',
        entityType: 'company',
      },
    });
    const sp = as(await signIn('support'));
    const imp = (
      await sp
        .post(`/v1/platform/tenants/${encodeId('tenant', t1.id)}/impersonate`, {
          reason: 'ลูกค้าแจ้งหน้ารายงานว่าง',
          ticketRef: '#77',
        })
        .expect(200)
    ).body;
    // พยายามเขียนระหว่างเข้าใช้งานแทน → บันทึก write_blocked (sub + act)
    await http()
      .patch('/v1/settings')
      .set('Authorization', `Bearer ${imp.accessToken}`)
      .send({ values: { 'org.name': 'x' } })
      .expect(403);
    const admin = as(await signIn('admin'));
    await admin
      .post(`/v1/platform/tenants/${encodeId('tenant', t2.id)}/suspend`, {
        reason: 'ค้างชำระเกินกำหนด 30 วัน',
      })
      .expect(200);

    const bi = as(await signIn('billing')); // ทุกบทบาทดู audit ได้ (§11.4)
    const all = (await bi.get('/v1/platform/audit-logs?limit=200').expect(200)).body;
    expect(all.data.some((e: { action: string }) => e.action === 'company.updated')).toBe(false);
    const started = all.data.find((e: { action: string }) => e.action === 'impersonation.started');
    expect(started).toMatchObject({
      staff: { id: sid('support'), name: 'ทีม support', role: 'SUPPORT' },
      onBehalfOf: { id: encodeId('user', owner.id), name: 'คุณหนึ่ง' },
      tenant: { id: encodeId('tenant', t1.id), name: 'บริษัท หนึ่ง จำกัด' },
      reason: 'ลูกค้าแจ้งหน้ารายงานว่าง',
      impersonationSessionId: imp.sessionId,
    });
    const blocked = all.data.find(
      (e: { action: string }) => e.action === 'impersonation.write_blocked',
    );
    expect(blocked).toMatchObject({
      staff: { id: sid('support') },
      onBehalfOf: { id: encodeId('user', owner.id) },
      impersonationSessionId: imp.sessionId,
    });
    const suspended = all.data.find(
      (e: { action: string }) => e.action === 'platform.tenant_suspended',
    );
    expect(suspended).toMatchObject({
      staff: { id: sid('admin'), role: 'SUPER_ADMIN' },
      onBehalfOf: null,
      tenant: { id: encodeId('tenant', t2.id) },
    });
    // แถวระดับแพลตฟอร์ม (เชิญ/ปิดทีมงาน) อยู่ในรายการเดียวกัน ไม่มีลูกค้า
    const deact = all.data.find(
      (e: { action: string; entityId: string }) =>
        e.action === 'platform.staff_deactivated' && e.entityId === sid('support'),
    );
    expect(deact).toMatchObject({ tenant: null, entityId: sid('support') });
    expect(deact.id).toMatch(/^pal_/);
    // เรียงใหม่ก่อน
    const times = all.data.map((e: { at: string }) => e.at);
    expect([...times].sort().reverse()).toEqual(times);

    // กรอง: ลูกค้า / ทีมงาน / การกระทำ / ช่วงวันที่
    const byTenant = (
      await bi.get(`/v1/platform/audit-logs?tenantId=${encodeId('tenant', t1.id)}`).expect(200)
    ).body.data;
    expect(byTenant.length).toBeGreaterThan(0);
    expect(
      byTenant.every((e: { tenant: { id: string } }) => e.tenant?.id === encodeId('tenant', t1.id)),
    ).toBe(true);
    const byStaff = (await bi.get(`/v1/platform/audit-logs?staffId=${sid('support')}`).expect(200))
      .body.data;
    expect(byStaff.every((e: { staff: { id: string } }) => e.staff?.id === sid('support'))).toBe(
      true,
    );
    expect(byStaff.some((e: { action: string }) => e.action === 'impersonation.started')).toBe(
      true,
    );
    const byAction = (await bi.get('/v1/platform/audit-logs?action=impersonation.').expect(200))
      .body.data;
    expect(byAction.length).toBeGreaterThan(0);
    expect(byAction.every((e: { action: string }) => e.action.startsWith('impersonation.'))).toBe(
      true,
    );
    expect(
      (await bi.get('/v1/platform/audit-logs?from=2000-01-01&to=2000-01-02').expect(200)).body.data,
    ).toEqual([]);
    await bi.get('/v1/platform/audit-logs?from=2026-12-01&to=2026-11-01').expect(422);
    await bi.get('/v1/platform/audit-logs?action=DROP%20TABLE').expect(422);

    // แบ่งหน้า: ต่อกันครบไม่ซ้ำ
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: { id: string }[]; nextCursor: string | null } = (
        await bi
          .get(`/v1/platform/audit-logs?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
          .expect(200)
      ).body;
      seen.push(...page.data.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.data.map((e: { id: string }) => e.id));
    await bi.get('/v1/platform/audit-logs?cursor=bogus').expect(422);

    // ส่งออก CSV + บันทึกว่าใครส่งออก
    const csv = await bi.get('/v1/platform/audit-logs/export?action=impersonation.').expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const text = csv.text.replace(/^﻿/, '');
    expect(text.split('\r\n')[0]).toContain('การเข้าใช้งานแทน');
    expect(text).toContain('impersonation.started');
    expect(text).toContain('คุณหนึ่ง');
    expect(text).toContain(imp.sessionId);
    const ex = await db.platformAuditLog.findFirstOrThrow({
      where: { action: 'platform.audit_exported' },
    });
    expect(ex).toMatchObject({ actorId: ids.billing });

    // token ลูกค้าเข้าไม่ได้
    await http()
      .get('/v1/platform/audit-logs')
      .set('Authorization', `Bearer ${await tokenFor(t1.id)}`)
      .expect(401);
  });

  it('platform_audit_log append-only: platform แก้/ลบไม่ได้ · role แอปอ่านไม่ได้', async () => {
    await expect(db.$executeRaw`DELETE FROM platform_audit_log`).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.$executeRaw`UPDATE platform_audit_log SET reason = 'x'`).rejects.toThrow(
      /permission denied/,
    );
    await expect(appDb.$queryRaw`SELECT 1 FROM platform_audit_log LIMIT 1`).rejects.toThrow(
      /permission denied/,
    );
    await expect(appDb.$queryRaw`SELECT 1 FROM platform_user LIMIT 1`).rejects.toThrow(
      /permission denied/,
    );
  });
});
