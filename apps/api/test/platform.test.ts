import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { hotp, currentStep } from '../src/auth/totp';
import { FieldCipher } from '../src/common/crypto';
import { encodeId } from '../src/common/ids';
import { EmailDispatcher } from '../src/modules/email/email.service';
import { MemoryTransport } from '../src/modules/email/transport';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bootApp, loginFull, platform, tokenFor, truncateAll } from './helpers';

const SECRET = 'JBSWY3DPEHPK3PXP';
const PW = 'platform-password-2569';

/** ST1-T24: Platform Console — login แยก + 2FA, สร้าง/ระงับ tenant, แพ็กเกจ/quota, เข้าใช้งานแทน (act + อีเมล owner) */
describe('platform console (ST1-T24)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let mail: MemoryTransport;
  let dispatcher: EmailDispatcher;
  const ids: Record<string, string> = {};
  const http = () => request(app.getHttpServer());

  async function staff(role: 'SUPER_ADMIN' | 'SUPPORT' | 'BILLING') {
    const u = await db.platformUser.create({
      data: {
        email: `${role.toLowerCase()}-${Date.now()}@innovera.test`,
        name: `ทีม ${role}`,
        role,
        passwordHash: await hashPassword(PW),
        totpSecret: new FieldCipher().encrypt(SECRET),
      },
    });
    ids[role] = u.id;
    return u;
  }
  /** login ครบ 2 ขั้น — ใช้ step TOTP ใหม่ทุกครั้ง (รีเซ็ต lastStep ให้ test อิสระจากเวลา) */
  async function signIn(role: 'SUPER_ADMIN' | 'SUPPORT' | 'BILLING') {
    const u = await db.platformUser.findUniqueOrThrow({ where: { id: ids[role]! } });
    await db.platformUser.update({ where: { id: u.id }, data: { totpLastStep: null } });
    const c = await http().post('/v1/platform/auth/login').send({ email: u.email, password: PW });
    expect(c.status).toBe(200);
    const t = await http()
      .post('/v1/platform/auth/mfa')
      .send({ challenge: c.body.challenge, code: hotp(SECRET, currentStep()) });
    expect(t.status).toBe(200);
    return t.body.accessToken as string;
  }
  const as = (token: string) => ({
    get: (p: string) => http().get(p).set('Authorization', `Bearer ${token}`),
    post: (p: string, b: object = {}) =>
      http().post(p).set('Authorization', `Bearer ${token}`).send(b),
    patch: (p: string, b: object) =>
      http().patch(p).set('Authorization', `Bearer ${token}`).send(b),
  });

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    dispatcher = app.get(EmailDispatcher);
    await staff('SUPER_ADMIN');
    await staff('SUPPORT');
    await staff('BILLING');
  });
  beforeEach(() => {
    mail = new MemoryTransport();
    dispatcher.use(mail);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('login แยก: รหัสผิด 401, TOTP ผิด/ใช้ซ้ำ 401, token Console ใช้กับ route ลูกค้าไม่ได้ (และกลับกัน)', async () => {
    const u = await db.platformUser.findUniqueOrThrow({ where: { id: ids.SUPER_ADMIN! } });
    await http()
      .post('/v1/platform/auth/login')
      .send({ email: u.email, password: 'wrong-password-xx' })
      .expect(401);
    await http()
      .post('/v1/platform/auth/login')
      .send({ email: 'nobody@innovera.test', password: PW })
      .expect(401);
    await db.platformUser.update({
      where: { id: u.id },
      data: { failedLogins: 0, totpLastStep: null },
    });
    const c = (
      await http()
        .post('/v1/platform/auth/login')
        .send({ email: u.email, password: PW })
        .expect(200)
    ).body.challenge;
    await http().post('/v1/platform/auth/mfa').send({ challenge: c, code: '000000' }).expect(401);
    const code = hotp(SECRET, currentStep());
    const ok = await http().post('/v1/platform/auth/mfa').send({ challenge: c, code }).expect(200);
    await http().post('/v1/platform/auth/mfa').send({ challenge: c, code }).expect(401); // ใช้ซ้ำ
    const token = ok.body.accessToken;
    expect((await as(token).get('/v1/platform/auth/me').expect(200)).body).toMatchObject({
      role: 'SUPER_ADMIN',
    });
    // token Console ไม่ใช่ token ลูกค้า
    await as(token).get('/v1/me').expect(401);
    // token ลูกค้า (แม้ scope *) เข้า Console ไม่ได้
    const t = await createTenantWithDefaults(db, { name: 'x' });
    await as(await tokenFor(t.id, '*'))
      .get('/v1/platform/tenants')
      .expect(401);
    // challenge ใช้แทน token ไม่ได้
    await as(c).get('/v1/platform/tenants').expect(401);
    // ออกจากระบบ → token เดิมใช้ไม่ได้
    await as(token).post('/v1/platform/auth/logout').expect(204);
    await as(token).get('/v1/platform/tenants').expect(401);
  });

  it('สร้าง tenant: TRIAL + ค่าเริ่มต้น + owner ได้อีเมลคำเชิญ + audit พร้อมเหตุผล; SUPPORT สร้างไม่ได้', async () => {
    const sa = as(await signIn('SUPER_ADMIN'));
    const sp = as(await signIn('SUPPORT'));
    const body = {
      name: 'บริษัท นำร่อง ขนส่ง จำกัด',
      ownerEmail: 'Owner@Pilot.test',
      ownerName: 'คุณเจ้าของ',
      planCode: 'ent',
      vehicleQuota: 30,
      reason: 'ลูกค้านำร่องตามสัญญา',
    };
    await sp.post('/v1/platform/tenants', body).expect(403);
    await sa.post('/v1/platform/tenants', { ...body, reason: 'สั้น' }).expect(422);
    await sa.post('/v1/platform/tenants', { ...body, planCode: 'nope' }).expect(422);
    const r = (await sa.post('/v1/platform/tenants', body).expect(201)).body;
    expect(r).toMatchObject({
      name: 'บริษัท นำร่อง ขนส่ง จำกัด',
      status: 'trial',
      planCode: 'ent',
      vehicleQuota: 30,
      users: 1,
    });
    expect(r.id).toMatch(/^ten_/);
    await dispatcher.drain();
    const m = mail.sent.find((x) => x.to === 'owner@pilot.test');
    expect(m?.subject).toContain('คำเชิญเข้าร่วม บริษัท นำร่อง ขนส่ง จำกัด');
    const tid = (await db.tenant.findFirstOrThrow({ where: { name: body.name } })).id;
    const au = await db.auditLog.findFirstOrThrow({
      where: { tenantId: tid, action: 'platform.tenant_created' },
    });
    expect(au).toMatchObject({ actorId: `platform:${ids.SUPER_ADMIN}`, reason: body.reason });
    expect(await db.documentSeries.count({ where: { tenantId: tid } })).toBeGreaterThan(0);
    const list = (await sp.get('/v1/platform/tenants?q=นำร่อง').expect(200)).body;
    expect(list.map((x: { id: string }) => x.id)).toContain(r.id);
    const d = (await sp.get(`/v1/platform/tenants/${r.id}`).expect(200)).body;
    expect(d.members).toEqual([
      expect.objectContaining({ email: 'owner@pilot.test', status: 'invited', roles: ['owner'] }),
    ]);
  });

  it('แพ็กเกจ/quota: SUPER_ADMIN และ BILLING ได้, SUPPORT ไม่ได้; audit before/after', async () => {
    const t = await createTenantWithDefaults(db, { name: 'แพ็กเกจ' });
    const id = encodeId('tenant', t.id);
    const bi = as(await signIn('BILLING'));
    const sp = as(await signIn('SUPPORT'));
    await sp
      .patch(`/v1/platform/tenants/${id}/plan`, { planCode: 'ent', reason: 'อัปเกรดตามใบเสนอราคา' })
      .expect(403);
    const r = (
      await bi
        .patch(`/v1/platform/tenants/${id}/plan`, {
          planCode: 'ent',
          vehicleQuota: 45,
          reason: 'อัปเกรดตามใบเสนอราคา',
        })
        .expect(200)
    ).body;
    expect(r).toMatchObject({ planCode: 'ent', vehicleQuota: 45 });
    const au = await db.auditLog.findFirstOrThrow({
      where: { tenantId: t.id, action: 'platform.plan_changed' },
    });
    expect(au.before).toMatchObject({ planCode: 'std', vehicleQuota: null });
    expect(au.after).toMatchObject({ planCode: 'ent', vehicleQuota: 45 });
    await bi
      .patch(`/v1/platform/tenants/${id}/plan`, { reason: 'ไม่มีอะไรเปลี่ยนเลยนะ' })
      .expect(422);
  });

  it('ระงับ → ผู้ใช้ของ tenant ใช้งานไม่ได้ทันที; ปลดระงับ → ใช้ได้; เฉพาะ SUPER_ADMIN', async () => {
    const t = await createTenantWithDefaults(db, { name: 'ระงับ', status: 'ACTIVE' });
    const roles = await ensureSystemRoles(db, t.id);
    const u = await db.appUser.create({
      data: {
        tenantId: t.id,
        email: 'u@suspend.test',
        name: 'u',
        status: 'ACTIVE',
        passwordHash: await hashPassword('member-password-2569'),
      },
    });
    await db.userRole.create({ data: { tenantId: t.id, userId: u.id, roleId: roles.admin! } });
    const { access: accessToken } = await loginFull(
      app,
      'u@suspend.test',
      'member-password-2569',
      '10.9.9.9',
    );
    await http().get('/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    const id = encodeId('tenant', t.id);
    const sp = as(await signIn('SUPPORT'));
    await sp
      .post(`/v1/platform/tenants/${id}/suspend`, { reason: 'ค้างชำระเกินกำหนด 60 วัน' })
      .expect(403);
    const sa = as(await signIn('SUPER_ADMIN'));
    expect(
      (
        await sa
          .post(`/v1/platform/tenants/${id}/suspend`, { reason: 'ค้างชำระเกินกำหนด 60 วัน' })
          .expect(200)
      ).body.status,
    ).toBe('suspended');
    await http().get('/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
    await sa.post(`/v1/platform/tenants/${id}/suspend`, { reason: 'ซ้ำอีกครั้งหนึ่ง' }).expect(409);
    await sa
      .post(`/v1/platform/tenants/${id}/reactivate`, { reason: 'ลูกค้าชำระครบแล้ว' })
      .expect(200);
    await http().get('/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(
      await db.auditLog.count({
        where: {
          tenantId: t.id,
          action: { in: ['platform.tenant_suspended', 'platform.tenant_reactivated'] },
        },
      }),
    ).toBe(2);
  });

  it('เข้าใช้งานแทน: audit มี sub + act, owner ได้อีเมล, อ่านอย่างเดียว, ออกแล้ว token ใช้ไม่ได้', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท ลูกค้า จำกัด', status: 'ACTIVE' });
    const roles = await ensureSystemRoles(db, t.id);
    const owner = await db.appUser.create({
      data: { tenantId: t.id, email: 'owner@cust.test', name: 'คุณโอ', status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId: t.id, userId: owner.id, roleId: roles.owner! } });
    const id = encodeId('tenant', t.id);
    const bi = as(await signIn('BILLING'));
    await bi
      .post(`/v1/platform/tenants/${id}/impersonate`, { reason: 'ลูกค้าแจ้งนำเข้า Excel ไม่ผ่าน' })
      .expect(403);
    const sp = as(await signIn('SUPPORT'));
    await sp.post(`/v1/platform/tenants/${id}/impersonate`, { reason: 'สั้น' }).expect(422);
    const r = (
      await sp
        .post(`/v1/platform/tenants/${id}/impersonate`, {
          reason: 'ลูกค้าแจ้งนำเข้า Excel ไม่ผ่าน',
          ticketRef: '#4412',
        })
        .expect(200)
    ).body;
    expect(r.url).toMatch(/\/impersonate#token=/);
    const imp = (p: string) => http().get(p).set('Authorization', `Bearer ${r.accessToken}`);
    const me = (await imp('/v1/me').expect(200)).body;
    expect(me.user.email).toBe('owner@cust.test');
    expect(me.impersonation).toMatchObject({ staffName: 'ทีม SUPPORT', mode: 'read_only' });
    const started = await db.auditLog.findFirstOrThrow({
      where: { tenantId: t.id, action: 'impersonation.started' },
    });
    expect(started).toMatchObject({ actorId: owner.id, actAs: `platform:${ids.SUPPORT}` });
    // อีเมลแจ้ง owner ทุกครั้ง
    await dispatcher.drain();
    const m = mail.sent.find((x) => x.to === 'owner@cust.test');
    expect(m?.subject).toBe('ทีมงาน TMS เข้าใช้งานบัญชี บริษัท ลูกค้า จำกัด — TMS');
    expect(m?.text).toContain('ลูกค้าแจ้งนำเข้า Excel ไม่ผ่าน');
    // อ่านอย่างเดียว: เขียน → 403 + บันทึกความพยายาม
    const w = await http()
      .patch('/v1/settings')
      .set('Authorization', `Bearer ${r.accessToken}`)
      .send({ values: { 'org.name': 'แก้' } });
    expect(w.status).toBe(403);
    expect(w.body.code).toBe('impersonation_read_only');
    const blocked = await db.auditLog.findFirstOrThrow({
      where: { tenantId: t.id, action: 'impersonation.write_blocked' },
    });
    expect(blocked).toMatchObject({ actorId: owner.id, actAs: `platform:${ids.SUPPORT}` });
    // ออก → token ใช้ไม่ได้
    await http()
      .post('/v1/me/impersonation/end')
      .set('Authorization', `Bearer ${r.accessToken}`)
      .expect(204);
    await imp('/v1/me').expect(401);
    const ended = await db.auditLog.findFirstOrThrow({
      where: { tenantId: t.id, action: 'impersonation.ended' },
    });
    expect(ended.actAs).toBe(`platform:${ids.SUPPORT}`);
  });

  it('เข้าใช้งานแทน: หมดเวลา / tenant ถูกระงับระหว่างใช้ → token ใช้ไม่ได้; ผู้ใช้ปกติเรียก end ไม่ได้', async () => {
    const t = await createTenantWithDefaults(db, { name: 'หมดเวลา', status: 'ACTIVE' });
    const roles = await ensureSystemRoles(db, t.id);
    const owner = await db.appUser.create({
      data: { tenantId: t.id, email: 'o@exp.test', name: 'o', status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId: t.id, userId: owner.id, roleId: roles.owner! } });
    const id = encodeId('tenant', t.id);
    const sa = as(await signIn('SUPER_ADMIN'));
    const r = (
      await sa
        .post(`/v1/platform/tenants/${id}/impersonate`, { reason: 'ตรวจสอบปัญหาการตั้งค่า' })
        .expect(200)
    ).body;
    await db.impersonationSession.update({
      where: { id: r.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await http().get('/v1/me').set('Authorization', `Bearer ${r.accessToken}`).expect(401);
    const r2 = (
      await sa
        .post(`/v1/platform/tenants/${id}/impersonate`, { reason: 'ตรวจสอบปัญหาการตั้งค่า' })
        .expect(200)
    ).body;
    await sa
      .post(`/v1/platform/tenants/${id}/suspend`, { reason: 'ทดสอบระงับระหว่างเข้าใช้' })
      .expect(200);
    await http().get('/v1/me').set('Authorization', `Bearer ${r2.accessToken}`).expect(401);
    await http()
      .post('/v1/me/impersonation/end')
      .set('Authorization', `Bearer ${await tokenFor(t.id, '*', owner.id)}`)
      .expect(404);
  });

  it('เข้าใช้งานแทน (review): JWT หมดอายุพร้อม session, ไม่ได้ URL อัปโหลด, ผู้ใช้ที่สวมถูกปิด/ทีมงาน logout → ใช้ไม่ได้', async () => {
    const t = await createTenantWithDefaults(db, { name: 'รีวิว', status: 'ACTIVE' });
    const roles = await ensureSystemRoles(db, t.id);
    const owner = await db.appUser.create({
      data: { tenantId: t.id, email: 'o@review.test', name: 'o', status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId: t.id, userId: owner.id, roleId: roles.owner! } });
    const id = encodeId('tenant', t.id);
    const supportToken = await signIn('SUPPORT');
    const sp = as(supportToken);
    const start = async () =>
      (
        await sp
          .post(`/v1/platform/tenants/${id}/impersonate`, { reason: 'ตรวจสอบปัญหาของลูกค้า' })
          .expect(200)
      ).body;
    const r = await start();
    const exp = JSON.parse(Buffer.from(r.accessToken.split('.')[1], 'base64url').toString()).exp;
    expect(exp * 1000).toBeLessThanOrEqual(new Date(r.expiresAt).getTime() + 2000);
    // เอกสาร PENDING ของผู้ใช้ที่สวม → ไม่ได้ uploadUrl (PUT เป็น public — ข้ามด่าน read-only)
    const doc = await db.storedDocument.create({
      data: {
        tenantId: t.id,
        status: 'PENDING',
        kind: 'OTHER',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        createdBy: owner.id,
      },
    });
    const g = await http()
      .get(`/v1/documents/${encodeId('document', doc.id)}`)
      .set('Authorization', `Bearer ${r.accessToken}`)
      .expect(200);
    expect(g.body.uploadUrl).toBeUndefined();
    // ผู้ใช้ที่สวมถูกปิด → token ใช้ไม่ได้ทันที
    await db.appUser.update({ where: { id: owner.id }, data: { status: 'DISABLED' } });
    await http().get('/v1/me').set('Authorization', `Bearer ${r.accessToken}`).expect(401);
    await db.appUser.update({ where: { id: owner.id }, data: { status: 'ACTIVE' } });
    // ทีมงาน logout → session ที่เปิดไว้จบ
    const r2 = await start();
    await http().get('/v1/me').set('Authorization', `Bearer ${r2.accessToken}`).expect(200);
    await sp.post('/v1/platform/auth/logout').expect(204);
    await http().get('/v1/me').set('Authorization', `Bearer ${r2.accessToken}`).expect(401);
  });
});
