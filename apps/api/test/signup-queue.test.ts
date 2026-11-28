import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { newOpaqueToken } from '../src/auth/tokens';
import { currentStep, hotp } from '../src/auth/totp';
import { addBusinessDays } from '../src/common/business-days';
import { FieldCipher } from '../src/common/crypto';
import { encodeId } from '../src/common/ids';
import { bootApp, platform, stepUpHeaderFor, tokenFor, truncateAll } from './helpers';

/**
 * P1-ST2-T06 คิวอนุมัติการสมัคร (spec/01 §10.3 PLT-105–107, §11.4) — เกณฑ์ตรวจรับ (plan/13):
 * ชื่อที่กรอกต่างจาก RD → ช่องชื่อถูกไฮไลต์ · ปฏิเสธโดยไม่มีเหตุผล → 422 · support อนุมัติได้ (§11.4)
 * + คำขอเข้าร่วมบริษัทเดิมส่ง owner ก่อน ไม่ตอบ 3 วันทำการ → เข้าคิว · ขอข้อมูลเพิ่ม · PLT-106 · ประวัติ IP/อีเมล · ธง R-02
 * ใช้ผู้ให้บริการค้นบริษัท `mock` (ค่าเริ่มของ test)
 */
const FOUND = '0105567153766'; // fixture: ผู้จด VAT "บริษัท ตัวอย่างขนส่ง จำกัด" สำนักงานใหญ่
const FOUND_NAME = 'บริษัท ตัวอย่างขนส่ง จำกัด';
const ADDRESS = {
  houseNo: '99/1',
  moo: '4',
  soi: '',
  street: 'พระราม 2',
  subDistrict: 'แสมดำ',
  district: 'บางขุนเทียน',
  province: 'กรุงเทพมหานคร',
  postalCode: '10150',
};
const PW = 'platform-password-2569';
const SECRET = 'JBSWY3DPEHPK3PXP';
const APPLICANT_PW = 'correct horse battery staple';
type Role = 'SUPER_ADMIN' | 'SUPPORT' | 'BILLING';

const b64url = (b: Buffer) => b.toString('base64url');
const challenge = () =>
  b64url(
    createHash('sha256')
      .update(b64url(randomBytes(32)))
      .digest(),
  );

/** เลขนิติบุคคล checksum ถูก ที่ไม่อยู่ใน fixture (RD ไม่พบ → pending_verification) */
function jur(seed: number): string {
  const base = `01055${String(80_000_00 + seed).padStart(7, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

describe('P1-ST2-T06 คิวอนุมัติการสมัคร', () => {
  let app: NestExpressApplication;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const http = () => request(app.getHttpServer());
  const tokens: Record<string, string> = {};
  let seq = 0;
  let pwHash = '';

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
    await db.platformUser.update({ where: { id: u.id }, data: { totpLastStep: null } });
    const c = await http().post('/v1/platform/auth/login').send({ email: u.email, password: PW });
    const t = await http()
      .post('/v1/platform/auth/mfa')
      .send({ challenge: c.body.challenge, code: hotp(SECRET, currentStep()) });
    expect(t.status).toBe(200);
    tokens[key] = t.body.accessToken;
  }
  const as = (key: string) => ({
    get: (p: string) => http().get(p).set('Authorization', `Bearer ${tokens[key]}`),
    post: (p: string, b: object = {}) =>
      http().post(p).set('Authorization', `Bearer ${tokens[key]}`).send(b),
  });

  /** สมัครครบ 3 ขั้นผ่าน API จริง → tenant (trialing / pending_verification ตามผลตรวจ) */
  async function signUp(
    taxId: string,
    opts: { legalName?: string; accountingSoftware?: string; ip?: string; email?: string } = {},
  ) {
    const { token, hash } = newOpaqueToken();
    const email = opts.email ?? `owner${Date.now().toString(36)}${++seq}@company.co.th`;
    await db.signupSession.create({
      data: {
        status: 'account_verified',
        fullName: 'สมชาย ใจดี',
        email,
        mobile: '+66812345678',
        passwordHash: pwHash,
        resumeTokenHash: hash,
        verifiedAt: new Date(),
      },
    });
    const ip = opts.ip ?? '10.77.0.1';
    expect(
      (
        await http()
          .post('/v1/public/signup/session/company/lookup')
          .set('X-Signup-Token', token)
          .send({ taxId })
      ).status,
    ).toBe(200);
    const s = await http()
      .post('/v1/public/signup/session/company')
      .set('X-Signup-Token', token)
      .set('X-Forwarded-For', ip)
      .send({
        taxId,
        branchType: 'hq',
        legalName: opts.legalName ?? FOUND_NAME,
        address: ADDRESS,
        fleetSizeOwn: 20,
        fleetSizeSubcon: 8,
        accountingSoftware: opts.accountingSoftware ?? 'flowaccount',
        acceptTerms: true,
        acceptPrivacy: true,
      });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const c = await http()
      .post('/v1/public/signup/session/complete')
      .set('X-Signup-Token', token)
      .set('X-Forwarded-For', ip)
      .send({ planCode: 'std', codeChallenge: challenge() });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const session = await db.signupSession.findUniqueOrThrow({ where: { resumeTokenHash: hash } });
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: session.createdTenantId! } });
    return { tenant, email, id: encodeId('tenant', tenant.id) };
  }

  /** ผู้สมัครคนใหม่ค้นเลขที่มีบริษัทแล้ว → ส่งคำขอเข้าร่วม / ติดต่อเรา */
  async function joinRequest(taxId: string, kind: 'join' | 'contact', email?: string) {
    const { token, hash } = newOpaqueToken();
    const e = email ?? `join${Date.now().toString(36)}${++seq}@company.co.th`;
    await db.signupSession.create({
      data: {
        status: 'account_verified',
        fullName: 'ณัฐวุฒิ แก้วดี',
        email: e,
        mobile: '+66811112222',
        passwordHash: pwHash,
        resumeTokenHash: hash,
        verifiedAt: new Date(),
      },
    });
    await http()
      .post('/v1/public/signup/session/company/lookup')
      .set('X-Signup-Token', token)
      .send({ taxId });
    const r = await http()
      .post('/v1/public/signup/session/company/join-request')
      .set('X-Signup-Token', token)
      .set('X-Forwarded-For', '10.66.0.5')
      .send({ taxId, kind });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return db.tenantJoinRequest.findFirstOrThrow({
      where: { email: e },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** fixture RD มีเลขเดียว — ย้ายเลขของบริษัทที่สร้างไปแล้วออก (owner — ข้าม RLS) ให้สมัครเลขเดิมซ้ำได้ */
  let released = 0;
  const releaseFound = () =>
    owner.company.updateMany({ where: { taxId: FOUND }, data: { taxId: jur(900 + ++released) } });

  beforeAll(async () => {
    process.env.SIGNUP_COMPLETE_RATE_LIMIT_PER_IP_PER_HOUR = '1000';
    await truncateAll();
    pwHash = await hashPassword(APPLICANT_PW);
    app = await bootApp();
    await staff('admin', 'SUPER_ADMIN');
    await staff('support', 'SUPPORT');
    await staff('billing', 'BILLING');
  });
  afterEach(async () => {
    await owner.platformSetting.deleteMany({ where: { key: 'signup.approvalPolicy' } });
  });
  afterAll(async () => {
    delete process.env.SIGNUP_COMPLETE_RATE_LIMIT_PER_IP_PER_HOUR;
    await app.close();
    await db.$disconnect();
    await owner.$disconnect();
  });

  it('วันทำการ: ข้ามเสาร์–อาทิตย์ (เวลาไทย)', () => {
    // ศุกร์ 27 พ.ย. 2569 10:00 น. (เวลาไทย) + 1 วันทำการ = จันทร์ 30 พ.ย. 10:00
    const fri = new Date('2026-11-27T03:00:00Z');
    expect(addBusinessDays(fri, 1).toISOString()).toBe('2026-11-30T03:00:00.000Z');
    expect(addBusinessDays(fri, 3).toISOString()).toBe('2026-12-02T03:00:00.000Z');
    // เสาร์ → นับจากจันทร์ 00:00
    expect(addBusinessDays(new Date('2026-11-28T05:00:00Z'), 1).toISOString()).toBe(
      '2026-11-30T17:00:00.000Z',
    );
  });

  it('ชื่อที่กรอกต่างจาก RD → อยู่ในคิว "ข้อมูลต่าง" + drawer ไฮไลต์ช่องชื่อ · ธง R-02 · ไม่มี DBD (R-08)', async () => {
    const x = await signUp(FOUND, { legalName: 'บจก. ศรีไทยขนส่ง', accountingSoftware: 'none' });
    expect(x.tenant.status).toBe('PENDING_VERIFICATION');
    const list = await as('billing').get('/v1/platform/signup-queue');
    expect(list.status).toBe(200);
    const item = list.body.data.find((i: { id: string }) => i.id === x.id);
    expect(item).toMatchObject({
      kind: 'signup',
      name: 'บจก. ศรีไทยขนส่ง',
      taxId: FOUND,
      check: 'mismatch',
      status: 'pending',
      applicantEmail: x.email,
      fleetSizeOwn: 20,
      fleetSizeSubcon: 8,
      overSla: false,
    });
    expect(item.flags).toContain('no_accounting_software');
    expect(list.body.policy).toBe('auto_when_verified');

    const d = await as('support').get(`/v1/platform/signup-queue/${x.id}`);
    expect(d.status).toBe(200);
    expect(d.body.rdStatus).toBe('found');
    const name = d.body.compare.find((c: { field: string }) => c.field === 'name');
    expect(name).toMatchObject({
      entered: 'บจก. ศรีไทยขนส่ง',
      rd: FOUND_NAME,
      dbd: null,
      differs: true,
    });
    const addr = d.body.compare.find((c: { field: string }) => c.field === 'address');
    expect(addr.differs).toBe(false);
    expect(d.body.compare.every((c: { dbd: unknown }) => c.dbd === null)).toBe(true);
    expect(d.body.accountingSoftware).toBe('none');
  });

  it('ปฏิเสธโดยไม่มีเหตุผล / เหตุผลสั้น → 422 · finance (BILLING) ตัดสินไม่ได้ → 403', async () => {
    const x = await signUp(jur(1), { legalName: 'บริษัท ไม่พบขนส่ง จำกัด' });
    expect((await as('admin').post(`/v1/platform/signup-queue/${x.id}/reject`, {})).status).toBe(
      422,
    );
    const short = await as('admin').post(`/v1/platform/signup-queue/${x.id}/reject`, {
      reason: 'สั้น',
    });
    expect(short.status).toBe(422);
    expect(short.body.code).toBe('validation_failed');
    expect(
      (
        await as('billing').post(`/v1/platform/signup-queue/${x.id}/approve`, {
          reason: 'ตรวจเอกสารครบถ้วนแล้ว',
        })
      ).status,
    ).toBe(403);
    // ไม่พบใน RD → ผลตรวจ not_found
    const d = await as('admin').get(`/v1/platform/signup-queue/${x.id}`);
    expect(d.body.check).toBe('not_found');
    expect(d.body.rdStatus).toBe('not_found');
    // ปฏิเสธพร้อมเหตุผล → cancelled + อีเมลถึงผู้สมัคร + ออกจากคิว
    const ok = await as('admin').post(`/v1/platform/signup-queue/${x.id}/reject`, {
      reason: 'ไม่พบเลขนี้ในกรมสรรพากรและไม่มีเอกสาร',
    });
    expect(ok.status).toBe(204);
    const t = await db.tenant.findUniqueOrThrow({ where: { id: x.tenant.id } });
    expect(t.status).toBe('CANCELLED');
    const v = await db.tenantVerification.findUniqueOrThrow({ where: { tenantId: x.tenant.id } });
    expect(v).toMatchObject({
      status: 'rejected',
      reason: 'ไม่พบเลขนี้ในกรมสรรพากรและไม่มีเอกสาร',
    });
    const mail = await db.emailOutbox.findFirst({
      where: { tenantId: x.tenant.id, toAddress: x.email, textBody: { contains: 'ไม่พบเลขนี้' } },
    });
    expect(mail?.textBody).toContain('ไม่พบเลขนี้ในกรมสรรพากร');
    expect(
      await db.domainEvent.count({
        where: { tenantId: x.tenant.id, type: 'verification.rejected' },
      }),
    ).toBe(1);
    expect((await as('admin').get(`/v1/platform/signup-queue/${x.id}`)).status).toBe(404);
  });

  it('support อนุมัติได้ (§11.4) → trialing · audit + event · PLT-106 แก้ชื่อ/ที่อยู่ให้ตรง RD', async () => {
    await releaseFound();
    const x = await signUp(FOUND, { legalName: 'บจก. ตัวอย่างขนส่งไทย' });
    const r = await as('support').post(`/v1/platform/signup-queue/${x.id}/approve`, {
      reason: 'โทรยืนยันกับผู้สมัครแล้ว ชื่อย่อในฟอร์ม',
      message: 'ปรับชื่อบริษัทให้ตรงกับกรมสรรพากรแล้ว',
      applyOfficialData: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    // อีเมลอนุมัติ: วันหมดทดลอง + ข้อความถึงผู้สมัคร · เหตุผลภายในไม่อยู่ในอีเมล (review S3)
    const mails = await db.emailOutbox.findMany({ where: { toAddress: x.email } });
    const ok = mails.find((m) => m.subject.includes('ยืนยันบริษัทแล้ว'));
    expect(ok?.textBody).toContain('ปรับชื่อบริษัทให้ตรงกับกรมสรรพากรแล้ว');
    expect(ok?.textBody).toMatch(/ถึง \d+ /);
    expect(mails.some((m) => (m.textBody ?? '').includes('โทรยืนยันกับผู้สมัครแล้ว'))).toBe(false);
    const t = await db.tenant.findUniqueOrThrow({ where: { id: x.tenant.id } });
    expect(t.status).toBe('TRIALING');
    expect(t.name).toBe(FOUND_NAME);
    const c = await db.company.findFirstOrThrow({ where: { tenantId: x.tenant.id } });
    expect(c.legalName).toBe(FOUND_NAME);
    const v = await db.tenantVerification.findUniqueOrThrow({ where: { tenantId: x.tenant.id } });
    expect(v.status).toBe('approved');
    expect(v.diffFields).toContain('name');
    expect(v.snapshotRd).toMatchObject({ legalName: FOUND_NAME });
    const audit = await db.auditLog.findMany({
      where: { tenantId: x.tenant.id, action: { startsWith: 'platform.signup' } },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'platform.signup_approved',
      'platform.signup_official_data_applied',
    ]);
    expect(audit[0]!.actorId).toMatch(/^platform:/);
    expect(
      await db.domainEvent.count({
        where: { tenantId: x.tenant.id, type: 'verification.approved' },
      }),
    ).toBe(1);
    // ตัดสินแล้ว = ไม่อยู่ในคิว (GET 404) · ตัดสินซ้ำ = 409
    expect((await as('support').get(`/v1/platform/signup-queue/${x.id}`)).status).toBe(404);
    expect(
      (
        await as('support').post(`/v1/platform/signup-queue/${x.id}/approve`, {
          reason: 'อนุมัติซ้ำอีกครั้งหนึ่ง',
        })
      ).status,
    ).toBe(409);
  });

  it('นโยบายทีมตรวจทุกราย: ชื่อ/ที่อยู่ตรง RD ก็เข้าคิว ผลตรวจ "ตรงกัน"', async () => {
    await owner.platformSetting.upsert({
      where: { key: 'signup.approvalPolicy' },
      create: { key: 'signup.approvalPolicy', value: 'manual_all' },
      update: { value: 'manual_all' },
    });
    await releaseFound();
    const x = await signUp(FOUND);
    expect(x.tenant.status).toBe('PENDING_VERIFICATION');
    const list = await as('admin').get('/v1/platform/signup-queue');
    expect(list.body.policy).toBe('manual_all');
    expect(list.body.data.find((i: { id: string }) => i.id === x.id)).toMatchObject({
      check: 'match',
    });
    const d = await as('admin').get(`/v1/platform/signup-queue/${x.id}`);
    expect(d.body.compare.some((c: { differs: boolean }) => c.differs)).toBe(false);
  });

  it('ขอข้อมูลเพิ่ม → info_requested (ยังอยู่ในคิว ไม่นับ SLA) + อีเมลถึงผู้สมัคร', async () => {
    const x = await signUp(jur(2), { legalName: 'บริษัท ขอข้อมูลขนส่ง จำกัด' });
    expect(x.tenant.status).toBe('PENDING_VERIFICATION');
    const r = await as('support').post(`/v1/platform/signup-queue/${x.id}/request-info`, {
      reason: 'กรุณาแนบหนังสือรับรองบริษัทไม่เกิน 6 เดือน',
    });
    expect(r.status).toBe(204);
    const t = await db.tenant.findUniqueOrThrow({ where: { id: x.tenant.id } });
    expect(t.status).toBe('PENDING_VERIFICATION');
    const list = await as('support').get('/v1/platform/signup-queue');
    const item = list.body.data.find((i: { id: string }) => i.id === x.id);
    expect(item).toMatchObject({ status: 'info_requested', overSla: false });
    const mail = await db.emailOutbox.findFirst({
      where: { toAddress: x.email, subject: { contains: 'ขอข้อมูลเพิ่มเติม' } },
    });
    expect(mail?.textBody).toContain('หนังสือรับรองบริษัท');
    // ตรวจต่อ (ผู้สมัครตอบแล้ว) → pending เริ่มนับเวลารอใหม่ (review S2) · ตรวจต่อซ้ำ = 409
    const rs = await as('support').post(`/v1/platform/signup-queue/${x.id}/resume`, {
      reason: 'ผู้สมัครส่งเอกสารทางอีเมลแล้ว',
    });
    expect(rs.status).toBe(204);
    const v2 = await db.tenantVerification.findUniqueOrThrow({ where: { tenantId: x.tenant.id } });
    expect(v2.status).toBe('pending');
    expect(v2.waitingSince.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(
      (
        await as('support').post(`/v1/platform/signup-queue/${x.id}/resume`, {
          reason: 'ผู้สมัครส่งเอกสารทางอีเมลแล้ว',
        })
      ).status,
    ).toBe(409);
    // อนุมัติต่อได้
    expect(
      (
        await as('admin').post(`/v1/platform/signup-queue/${x.id}/approve`, {
          reason: 'ได้รับเอกสารทางอีเมลแล้ว',
        })
      ).status,
    ).toBe(204);
  });

  it('เกิน SLA 1 วันทำการ → overSla · เรียงตามเวลารอ (นานสุดก่อน)', async () => {
    const a = await signUp(jur(3), { legalName: 'บริษัท รอนานขนส่ง จำกัด' });
    const b = await signUp(jur(4), { legalName: 'บริษัท รอไม่นานขนส่ง จำกัด' });
    await owner.tenant.update({
      where: { id: a.tenant.id },
      data: { createdAt: new Date(Date.now() - 6 * 86_400_000) },
    });
    const list = await as('admin').get('/v1/platform/signup-queue');
    const ids = list.body.data.map((i: { id: string }) => i.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    expect(list.body.data.find((i: { id: string }) => i.id === a.id).overSla).toBe(true);
    expect(list.body.data.find((i: { id: string }) => i.id === b.id).overSla).toBe(false);
  });

  it('ประวัติจาก IP/อีเมลเดียวกัน + คำเตือนเลขซ้ำ (บริษัทเดิม)', async () => {
    const a = await signUp(jur(5), { legalName: 'บริษัท ไอพีเดียวกัน จำกัด', ip: '10.55.0.7' });
    const b = await signUp(jur(6), { legalName: 'บริษัท ไอพีเดียวกันสอง จำกัด', ip: '10.55.0.7' });
    const d = await as('admin').get(`/v1/platform/signup-queue/${b.id}`);
    expect(d.body.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tenant', name: 'บริษัท ไอพีเดียวกัน จำกัด', match: 'ip' }),
      ]),
    );
    expect(d.body.duplicate).toBeNull();
    expect(a.id).not.toBe(b.id);
  });

  it('คำขอเข้าร่วม: ส่ง owner ก่อน (อีเมล) · ไม่ตอบใน 3 วันทำการ → เข้าคิว · support อนุมัติ = เชิญเข้าบริษัทเดิม (viewer)', async () => {
    const host = await signUp(jur(7), { legalName: 'บริษัท บริษัทเดิมขนส่ง จำกัด' });
    await as('admin').post(`/v1/platform/signup-queue/${host.id}/approve`, {
      reason: 'ตรวจเอกสารครบแล้วอนุมัติ',
    });
    // ผู้ขอมีบัญชีในบริษัทอื่นอยู่แล้ว — ไม่ใช่ already_member ของบริษัทนี้ (review S1)
    const other = await signUp(jur(17), { legalName: 'บริษัท บัญชีอื่นขนส่ง จำกัด' });
    const j = await joinRequest(jur(7), 'join', other.email);
    expect(j).toMatchObject({ status: 'pending_owner', kind: 'join', tenantId: host.tenant.id });
    expect(j.ownerDueAt!.getTime()).toBeGreaterThan(Date.now() + 2 * 86_400_000);
    // อีเมลถึง owner ของบริษัทเดิม
    const m = await db.emailOutbox.findFirst({
      where: { toAddress: host.email, subject: { contains: 'คำขอเข้าร่วม' } },
    });
    expect(m?.textBody).toContain('ณัฐวุฒิ แก้วดี');
    const jid = encodeId('joinRequest', j.id);
    // ยังไม่ถึงกำหนด → ไม่อยู่ในคิว
    let list = await as('support').get('/v1/platform/signup-queue');
    expect(list.body.data.some((i: { id: string }) => i.id === jid)).toBe(false);
    expect((await as('support').get(`/v1/platform/signup-queue/${jid}`)).status).toBe(404);
    // เลยกำหนด → อยู่ในคิว ผลตรวจ "เลขซ้ำ"
    await owner.tenantJoinRequest.update({
      where: { id: j.id },
      data: { ownerDueAt: new Date(Date.now() - 60_000) },
    });
    list = await as('support').get('/v1/platform/signup-queue');
    expect(list.body.data.find((i: { id: string }) => i.id === jid)).toMatchObject({
      kind: 'join',
      check: 'duplicate',
      name: 'บริษัท บริษัทเดิมขนส่ง จำกัด',
    });
    const d = await as('support').get(`/v1/platform/signup-queue/${jid}`);
    expect(d.body.duplicate).toMatchObject({
      tenantId: host.id,
      name: 'บริษัท บริษัทเดิมขนส่ง จำกัด',
    });
    // owner เห็นว่าเลยกำหนดแล้ว = "ทีมงาน TMS กำลังตรวจ" (QA-S2)
    const tok = await tokenFor(host.tenant.id);
    const ol = await http().get('/v1/users/join-requests').set('Authorization', `Bearer ${tok}`);
    expect(ol.body.data[0]).toMatchObject({ id: jid, status: 'pending' });
    const ok = await as('support').post(`/v1/platform/signup-queue/${jid}/approve`, {
      reason: 'owner ไม่ตอบ ยืนยันกับผู้ขอทางโทรศัพท์แล้ว',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(204);
    // owner ทุกคนได้อีเมลว่าทีมงานเพิ่มใคร + วิธีปิดผู้ใช้ (review B1)
    const added = await db.emailOutbox.findFirst({
      where: { toAddress: host.email, subject: { contains: 'เพิ่มผู้ใช้' } },
    });
    expect(added?.textBody).toContain(j.email);
    expect(added?.textBody).toContain('ผู้ใช้และสิทธิ์');
    expect(
      await db.auditLog.count({
        where: { entityId: j.id, action: 'platform.join_request_approved' },
      }),
    ).toBe(1);
    const row = await db.tenantJoinRequest.findUniqueOrThrow({ where: { id: j.id } });
    expect(row).toMatchObject({ status: 'approved', decidedByType: 'platform_user' });
    const u = await db.appUser.findUniqueOrThrow({ where: { id: row.invitedUserId! } });
    expect(u).toMatchObject({ tenantId: host.tenant.id, status: 'INVITED', email: j.email });
    const links = await db.userRole.findMany({ where: { userId: u.id } });
    const roles = await db.role.findMany({ where: { id: { in: links.map((l) => l.roleId) } } });
    expect(roles.map((r) => r.code)).toEqual(['viewer']);
    expect(
      await db.emailOutbox.count({
        where: { toAddress: j.email, tenantId: host.tenant.id },
      }),
    ).toBe(1);
  });

  it('คำขอเข้าร่วม: owner เห็นในหน้าผู้ใช้ · ปฏิเสธ (เหตุผล ≥ 10) → อีเมลถึงผู้ขอ · owner เชิญอีเมลเดียวกัน = อนุมัติ · "ติดต่อเรา" เข้าคิวทันที', async () => {
    const host = await signUp(jur(8), { legalName: 'บริษัท เจ้าของตัดสิน จำกัด' });
    await as('admin').post(`/v1/platform/signup-queue/${host.id}/approve`, {
      reason: 'ตรวจเอกสารครบแล้วอนุมัติ',
    });
    const j1 = await joinRequest(jur(8), 'join');
    const j2 = await joinRequest(jur(8), 'join');
    const tok = await tokenFor(host.tenant.id);
    const list = await http().get('/v1/users/join-requests').set('Authorization', `Bearer ${tok}`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((x: { id: string }) => x.id).sort()).toEqual(
      [encodeId('joinRequest', j1.id), encodeId('joinRequest', j2.id)].sort(),
    );
    // ปฏิเสธ: เหตุผลสั้น 422 · ครบ → rejected + อีเมลถึงผู้ขอ
    const short = await http()
      .post(`/v1/users/join-requests/${encodeId('joinRequest', j1.id)}/decline`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ reason: 'ไม่' });
    expect(short.status).toBe(422);
    const dec = await http()
      .post(`/v1/users/join-requests/${encodeId('joinRequest', j1.id)}/decline`)
      .set('Authorization', `Bearer ${tok}`)
      .send({ reason: 'ไม่ใช่พนักงานของบริษัทเรา' });
    expect(dec.status).toBe(204);
    expect(await db.tenantJoinRequest.findUniqueOrThrow({ where: { id: j1.id } })).toMatchObject({
      status: 'rejected',
      decidedByType: 'tenant_user',
    });
    const m = await db.emailOutbox.findFirst({
      where: { toAddress: j1.email, subject: { contains: 'ไม่ได้รับอนุมัติ' } },
    });
    expect(m?.textBody).toContain('ไม่ใช่พนักงานของบริษัทเรา');
    // owner เชิญอีเมลของคำขอที่ 2 → คำขออนุมัติอัตโนมัติ
    const inv = await http()
      .post('/v1/users/invitations')
      .set('Authorization', `Bearer ${tok}`)
      .set('X-Step-Up', stepUpHeaderFor(tok)!)
      .send({ email: j2.email, name: 'ณัฐวุฒิ แก้วดี', roles: ['planner'] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(await db.tenantJoinRequest.findUniqueOrThrow({ where: { id: j2.id } })).toMatchObject({
      status: 'approved',
      decidedByType: 'tenant_user',
    });
    // ติดต่อเรา → เข้าคิวทีมงานทันที (owner ไม่เห็น)
    const c = await joinRequest(jur(8), 'contact');
    expect(c.status).toBe('pending');
    const cid = encodeId('joinRequest', c.id);
    const q = await as('admin').get('/v1/platform/signup-queue');
    expect(q.body.data.find((i: { id: string }) => i.id === cid)).toMatchObject({
      kind: 'contact',
    });
    const ol = await http().get('/v1/users/join-requests').set('Authorization', `Bearer ${tok}`);
    expect(ol.body.data).toEqual([]);
    // ติดต่อเรา: อนุมัติ (= เพิ่มคน) / ปฏิเสธ ไม่ได้ — ปิดเรื่องหรือส่งต่อ owner เท่านั้น (review B1)
    for (const a of ['approve', 'reject'])
      expect(
        (
          await as('admin').post(`/v1/platform/signup-queue/${cid}/${a}`, {
            reason: 'ตรวจแล้วอนุมัติได้เลย',
          })
        ).status,
      ).toBe(422);
    const fw = await as('admin').post(`/v1/platform/signup-queue/${cid}/forward-owner`, {
      reason: 'ผู้ติดต่อเป็นพนักงาน ส่งให้ owner ตัดสิน',
    });
    expect(fw.status).toBe(204);
    const fwd = await db.tenantJoinRequest.findUniqueOrThrow({ where: { id: c.id } });
    expect(fwd).toMatchObject({ kind: 'join', status: 'pending_owner' });
    expect(
      await db.emailOutbox.count({
        where: { toAddress: host.email, subject: { contains: 'คำขอเข้าร่วม' } },
      }),
    ).toBe(3);
    // ส่ง "ติดต่อเรา" ซ้ำขณะ owner ถือคำขออยู่ = คงคำขอเดิม (ไม่ข้าม owner)
    const again = await joinRequest(jur(8), 'contact', c.email);
    expect(again).toMatchObject({ id: c.id, kind: 'join', status: 'pending_owner' });
    // ติดต่อเราอีกราย → ปิดเรื่อง (เหตุผล ≥ 10) + อีเมลถึงผู้ติดต่อ
    const c2 = await joinRequest(jur(8), 'contact');
    const cl = await as('admin').post(
      `/v1/platform/signup-queue/${encodeId('joinRequest', c2.id)}/close`,
      { reason: 'ตรวจแล้วข้อมูลบริษัทถูกต้อง', message: 'ข้อมูลบริษัทในระบบถูกต้องแล้ว' },
    );
    expect(cl.status).toBe(204);
    expect(await db.tenantJoinRequest.findUniqueOrThrow({ where: { id: c2.id } })).toMatchObject({
      status: 'rejected',
    });
    const cm = await db.emailOutbox.findFirst({ where: { toAddress: c2.email } });
    expect(cm?.textBody).toContain('ข้อมูลบริษัทในระบบถูกต้องแล้ว');
    expect(cm?.textBody).not.toContain('ตรวจแล้วข้อมูลบริษัทถูกต้อง');
  });

  it('คำขอเข้าร่วมบริษัทที่ถูกยกเลิก → 409 · บริษัทไม่มี owner ที่ใช้งานอยู่ → เข้าคิวทันที (review S5)', async () => {
    const dead = await signUp(jur(9), { legalName: 'บริษัท ยกเลิกแล้วขนส่ง จำกัด' });
    await as('admin').post(`/v1/platform/signup-queue/${dead.id}/reject`, {
      reason: 'ปฏิเสธเพื่อทดสอบคำขอเข้าร่วม',
    });
    const { token, hash } = newOpaqueToken();
    await db.signupSession.create({
      data: {
        status: 'account_verified',
        fullName: 'ผู้ขอ ทดสอบ',
        email: `dead${++seq}@company.co.th`,
        passwordHash: pwHash,
        resumeTokenHash: hash,
        verifiedAt: new Date(),
      },
    });
    // บริษัทที่ยกเลิกแล้วไม่นับเป็นเลขซ้ำตอนค้นหา → ส่งคำขอเข้าร่วมไม่ได้
    await http()
      .post('/v1/public/signup/session/company/lookup')
      .set('X-Signup-Token', token)
      .send({ taxId: jur(9) });
    const r = await http()
      .post('/v1/public/signup/session/company/join-request')
      .set('X-Signup-Token', token)
      .send({ taxId: jur(9), kind: 'join' });
    expect([409, 422]).toContain(r.status);
    // บริษัทที่ไม่มี owner ที่ใช้งานอยู่ → คำขอเข้าคิวทีมงานทันที
    const host = await signUp(jur(10), { legalName: 'บริษัท ไม่มีเจ้าของขนส่ง จำกัด' });
    await as('admin').post(`/v1/platform/signup-queue/${host.id}/approve`, {
      reason: 'ตรวจเอกสารครบแล้วอนุมัติ',
    });
    await owner.appUser.updateMany({
      where: { tenantId: host.tenant.id },
      data: { status: 'DISABLED' },
    });
    const j = await joinRequest(jur(10), 'join');
    expect(j).toMatchObject({ status: 'pending', ownerDueAt: null });
  });

  it('สิทธิ์: ไม่มี token Console → 401 · token ลูกค้าเรียก /v1/platform/signup-queue ไม่ได้', async () => {
    expect((await http().get('/v1/platform/signup-queue')).status).toBe(401);
    const t = await tokenFor((await db.tenant.findFirstOrThrow()).id);
    const r = await http().get('/v1/platform/signup-queue').set('Authorization', `Bearer ${t}`);
    expect([401, 403]).toContain(r.status);
  });
});
