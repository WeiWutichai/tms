import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { newOpaqueToken } from '../src/auth/tokens';
import { defaultFileStore } from '../src/pdf/file-store';
import { SignupCompleteService } from '../src/modules/signup/signup-complete.service';
import { TERMS_VERSION_PLACEHOLDER } from '../src/modules/signup/signup-company.service';
import { bootApp, platform, truncateAll } from './helpers';

/**
 * P1-ST2-T05 สมัครขั้น 3 "เลือกแพ็กเกจ" + สร้างบริษัทในธุรกรรมเดียว — เกณฑ์ตรวจรับ (plan/13; spec/01 §2 PLT-022, PLT-025):
 * RD พบ + ชื่อตรง → trialing + เข้าแอปได้ทันที · ฉีด error หลังสร้าง tenant → ไม่มีแถวค้างสักตาราง · event `signup.completed`
 * ใช้ผู้ให้บริการค้นบริษัท `mock` (ค่าเริ่มของ test) — ไม่มีการเรียกออกภายนอก
 */
const FOUND = '0105567153766'; // fixture: ผู้จด VAT สำนักงานใหญ่ ชื่อ "บริษัท ตัวอย่างขนส่ง จำกัด"
const FOUND_NAME = 'บริษัท ตัวอย่างขนส่ง จำกัด';
const TIN_ONLY = '0105569000011'; // fixture: มีเลขแต่ไม่จด VAT → pending_manual
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
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PASSWORD = 'correct horse battery staple';

const b64url = (b: Buffer) => b.toString('base64url');
function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/** เลขนิติบุคคล checksum ถูก ที่ไม่อยู่ใน fixture (RD ไม่พบ → pending_verification) */
function jur(seed: number): string {
  const base = `01055${String(90_000_00 + seed).padStart(7, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

describe('P1-ST2-T05 สมัครขั้น 3 + สร้างบริษัทในธุรกรรมเดียว', () => {
  let app: NestExpressApplication;
  let svc: SignupCompleteService;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  const http = () => request(app.getHttpServer());
  let seq = 0;
  let pwHash = '';

  const setSetting = (key: string, value: unknown) =>
    owner.platformSetting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: { value: value as never },
    });

  beforeAll(async () => {
    await truncateAll();
    pwHash = await hashPassword(PASSWORD);
    app = await bootApp();
    svc = app.get(SignupCompleteService);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await owner.platformSetting.deleteMany({
      where: { key: { in: ['signup.approvalPolicy', 'pricing.publicVisible', 'trial.days'] } },
    });
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await owner.$disconnect();
    await appDb.$disconnect();
  });

  /** การสมัครที่ยืนยัน OTP แล้ว → ค้นหา + ส่งขั้น 2 ผ่าน API จริง → company_submitted */
  async function submitted(
    taxId = FOUND,
    opts: { legalName?: string; certificate?: boolean; accountingSoftware?: string } = {},
  ) {
    const { token, hash } = newOpaqueToken();
    const email = `owner${Date.now().toString(36)}${++seq}@company.co.th`;
    const s = await db.signupSession.create({
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
    const look = await http()
      .post('/v1/public/signup/session/company/lookup')
      .set('X-Signup-Token', token)
      .send({ taxId });
    expect(look.status).toBe(200);
    if (opts.certificate) {
      const up = await http()
        .put('/v1/public/signup/session/company/certificate?filename=cert.pdf')
        .set('X-Signup-Token', token)
        .set('Content-Type', 'application/octet-stream')
        .send(PDF);
      expect(up.status).toBe(200);
    }
    const r = await http()
      .post('/v1/public/signup/session/company')
      .set('X-Signup-Token', token)
      .set('X-Forwarded-For', '10.88.0.9')
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
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { token, id: s.id, email };
  }
  const complete = (token: string, planCode = 'std', challenge = pkce().challenge) =>
    http()
      .post('/v1/public/signup/session/complete')
      .set('X-Signup-Token', token)
      .set('X-Forwarded-For', '10.88.0.9')
      .send({ planCode, codeChallenge: challenge });

  /** จำนวนแถวทุกตาราง (owner — ข้าม RLS) */
  async function rowCounts(): Promise<Record<string, number>> {
    const tables = await owner.$queryRaw<{ t: string }[]>`
      SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    const out: Record<string, number> = {};
    for (const { t } of tables) {
      const [r] = await owner.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "${t}"`,
      );
      out[t] = Number(r!.n);
    }
    return out;
  }

  it('GET session/plans: แพ็กเกจที่เลือกได้ · ราคาเฉพาะเมื่อเปิดราคาสาธารณะ · token ผิด 401', async () => {
    const { token } = await submitted(jur(1));
    const r = await http().get('/v1/public/signup/session/plans').set('X-Signup-Token', token);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.trialDays).toBe(30);
    expect(r.body.pricesVisible).toBe(false);
    const codes = r.body.plans.map((p: { code: string }) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['start', 'std', 'ent']));
    expect(
      r.body.plans.every(
        (p: { pricePerVehicleMonthly: unknown }) => p.pricePerVehicleMonthly === null,
      ),
    ).toBe(true);
    await setSetting('pricing.publicVisible', true);
    const v = await http().get('/v1/public/signup/session/plans').set('X-Signup-Token', token);
    const std = v.body.plans.find((p: { code: string }) => p.code === 'std');
    expect(v.body.pricesVisible).toBe(true);
    expect(std.pricePerVehicleMonthly).toMatch(/^\d+\.\d{2}$/);
    expect(v.body.plans.find((p: { code: string }) => p.code === 'ent').isContactSales).toBe(true);
    expect(
      (await http().get('/v1/public/signup/session/plans').set('X-Signup-Token', 'nope')).status,
    ).toBe(401);
  });

  it('RD พบ + ชื่อตรง → trialing ในธุรกรรมเดียว: tenant + ค่าเริ่มต้นไทย + subscription + owner + checklist + sandbox + event + อีเมล → เข้าแอปได้ทันที (2FA owner)', async () => {
    const { token, id, email } = await submitted(FOUND);
    const { verifier, challenge } = pkce();
    const t0 = Date.now();
    const r = await complete(token, 'std', challenge);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(r.body.completion).toMatchObject({
      outcome: 'ready',
      tenantStatus: 'trialing',
      companyName: FOUND_NAME,
      planCode: 'std',
    });
    // owner ต้องตั้ง 2FA ก่อนเข้า (D-78) — ขั้นเดียวกับ login
    expect(r.body.signIn).toMatchObject({ kind: 'mfa', purpose: 'enroll' });
    expect(r.body.session.status).toBe('completed');

    const s = await db.signupSession.findUniqueOrThrow({ where: { id } });
    expect(s.status).toBe('completed');
    expect(s.passwordHash).toBeNull();
    const tid = s.createdTenantId!;
    const t = await db.tenant.findUniqueOrThrow({
      where: { id: tid },
      include: { subscription: true, signup: true },
    });
    expect(t).toMatchObject({
      name: FOUND_NAME,
      status: 'TRIALING',
      planCode: 'std',
      mode: 'live',
    });
    // trialEndsAt = วันนี้ + trial.days (30)
    const days = (t.subscription!.trialEndsAt!.getTime() - t0) / 864e5;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
    expect(t.subscription!.status).toBe('trialing');
    // ค่าเริ่มต้นไทย (ST1-T20)
    expect(await db.vehicleType.count({ where: { tenantId: tid } })).toBeGreaterThan(0);
    expect(await db.reasonCode.count({ where: { tenantId: tid } })).toBeGreaterThan(0);
    // นิติบุคคล + สาขา
    const co = await db.company.findFirstOrThrow({ where: { tenantId: tid } });
    expect(co).toMatchObject({ taxId: FOUND, legalName: FOUND_NAME, vatRegistered: true });
    const br = await db.branch.findFirstOrThrow({ where: { tenantId: tid } });
    expect(br).toMatchObject({
      branchCode: '00000',
      branchLabel: 'สำนักงานใหญ่',
      isDefaultIssuer: true,
    });
    expect(br.address).toMatchObject({ line1: '99/1 หมู่ 4 ถนน พระราม 2', postcode: '10150' });
    // owner
    const u = await db.appUser.findFirstOrThrow({ where: { tenantId: tid } });
    expect(u).toMatchObject({ email, name: 'สมชาย ใจดี', status: 'ACTIVE', phone: '+66812345678' });
    expect(u.passwordHash).toBe(pwHash);
    const links = await db.userRole.findMany({ where: { tenantId: tid, userId: u.id } });
    const roles = await db.role.findMany({ where: { id: { in: links.map((l) => l.roleId) } } });
    expect(roles.map((x) => x.code)).toEqual(['owner']);
    // checklist (ST1-T21) + ประวัติสถานะแถวแรก
    expect(await db.setupChecklistState.count({ where: { tenantId: tid } })).toBe(1);
    const hist = await db.tenantStatusHistory.findMany({ where: { tenantId: tid } });
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ fromStatus: null, toStatus: 'TRIALING', actorType: 'system' });
    // sandbox (ST7-T09) + นิติบุคคลที่คัดลอก
    const sb = await db.tenant.findUniqueOrThrow({ where: { liveTenantId: tid } });
    expect(sb.mode).toBe('test');
    expect(await db.company.count({ where: { tenantId: sb.id } })).toBe(1);
    // การยอมรับข้อกำหนดคัดลอกเข้า tenant
    expect(t.signup).toMatchObject({
      signupSessionId: id,
      verificationStatus: 'auto_vat',
      approvalPolicy: 'auto_when_verified',
      termsVersion: TERMS_VERSION_PLACEHOLDER,
      privacyVersion: TERMS_VERSION_PLACEHOLDER,
      termsAcceptedIp: '10.88.0.9',
      accountingSoftware: 'flowaccount',
      planCode: 'std',
      certificateDocumentId: null,
    });
    expect(t.signup!.termsAcceptedAt.getTime()).toBe(s.termsAcceptedAt!.getTime());
    // event + audit + อีเมล
    const ev = await db.domainEvent.findMany({
      where: { tenantId: tid, type: 'signup.completed' },
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.snapshot).toMatchObject({
      status: 'trialing',
      verificationStatus: 'auto_vat',
      planCode: 'std',
    });
    expect(
      await db.auditLog.count({ where: { tenantId: tid, action: 'tenant.signup_completed' } }),
    ).toBe(1);
    const mail = await db.emailOutbox.findMany({
      where: { tenantId: tid, template: 'signup_completed' },
    });
    expect(mail).toHaveLength(1);
    expect(mail[0]!.toAddress).toBe(email);

    // เข้าแอปต่อด้วย challenge ที่ได้ (ตั้ง 2FA) — challenge ผูก PKCE ของคำขอนี้
    const ch = await db.mfaChallenge.findFirstOrThrow({ where: { tenantId: tid, userId: u.id } });
    expect(ch.purpose).toBe('enroll');
    expect(ch.codeChallenge).toBe(challenge);
    expect(verifier).toBeTruthy();
    // login ด้วยรหัสผ่านที่ตั้งตอนสมัคร → ผู้ใช้ปกติ (ไม่ใช่การสมัครค้าง)
    const login = await http()
      .post('/v1/auth/login')
      .send({ email, password: PASSWORD, codeChallenge: pkce().challenge });
    expect(login.body.code).toBe('mfa_enrollment_required');

    // เรียกซ้ำ (สายหลุด) → ผลเดิม ไม่สร้างซ้ำ ไม่ออก code ใหม่
    const again = await complete(token);
    expect(again.status).toBe(200);
    expect(again.body.completion.outcome).toBe('ready');
    expect(again.body.signIn).toBeNull();
    expect(await db.tenant.count({ where: { name: FOUND_NAME, mode: 'live' } })).toBe(1);
    // การสมัครเสร็จแล้ว → GET session ไม่ทำต่อ
    expect(
      (await http().get('/v1/public/signup/session').set('X-Signup-Token', token)).status,
    ).toBe(401);
  });

  it('ฉีด error หลังสร้าง tenant → rollback ทั้งหมด ไม่มีแถวค้างสักตาราง · session ยัง company_submitted · ลองใหม่ได้', async () => {
    const { token, id } = await submitted(jur(2));
    const before = await rowCounts();
    const spy = vi
      .spyOn(svc as unknown as { checkpoint: (n: string) => Promise<void> }, 'checkpoint')
      .mockImplementation(async (n) => {
        if (n === 'tenant_created') throw new Error('injected failure');
      });
    const r = await complete(token);
    expect(r.status).toBe(500);
    expect(spy).toHaveBeenCalledWith('tenant_created');
    expect(await rowCounts()).toEqual(before);
    expect((await db.signupSession.findUniqueOrThrow({ where: { id } })).status).toBe(
      'company_submitted',
    );
    spy.mockRestore();
    const ok = await complete(token);
    expect(ok.status).toBe(200);
  });

  it('ฉีด error ก่อน commit (หลังย้ายหนังสือรับรอง) → ไม่มีแถวค้าง + ไม่มีไฟล์ค้างในโฟลเดอร์ tenant + ไฟล์ของ session อยู่ครบ', async () => {
    const { token, id } = await submitted(TIN_ONLY, { certificate: true });
    const s0 = await db.signupSession.findUniqueOrThrow({ where: { id } });
    const before = await rowCounts();
    const sha = createHash('sha256').update(PDF).digest('hex');
    const root = process.env.FILES_ROOT ?? join(process.cwd(), '.data', 'files');
    // โฟลเดอร์ที่มีไฟล์เนื้อเดียวกัน (รวมของรอบก่อน ๆ) — หลังล้มต้องไม่เพิ่ม
    const holders = () =>
      readdirSync(root)
        .filter((d) => existsSync(join(root, d, `${sha}.pdf`)))
        .sort();
    const held = holders();
    vi.spyOn(
      svc as unknown as { checkpoint: (n: string) => Promise<void> },
      'checkpoint',
    ).mockImplementation(async (n) => {
      if (n === 'before_commit') throw new Error('injected failure');
    });
    const r = await complete(token);
    expect(r.status).toBe(500);
    expect(await rowCounts()).toEqual(before);
    expect(existsSync(join(root, s0.certificateFileKey!))).toBe(true);
    expect(holders()).toEqual(held);
    expect(held).toContain(id);
  });

  it('pending_manual (มีเลขไม่จด VAT + หนังสือรับรอง) → pending_verification · ไฟล์ย้ายเข้า tenant · ไม่ออก sign-in', async () => {
    const { token, id } = await submitted(TIN_ONLY, {
      certificate: true,
      accountingSoftware: 'none',
    });
    const s0 = await db.signupSession.findUniqueOrThrow({ where: { id } });
    expect(s0.verificationStatus).toBe('pending_manual');
    const r = await complete(token, 'start');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.completion).toMatchObject({
      outcome: 'pending',
      tenantStatus: 'pending_verification',
    });
    expect(r.body.signIn).toBeNull();
    const s = await db.signupSession.findUniqueOrThrow({ where: { id } });
    const t = await db.tenant.findUniqueOrThrow({
      where: { id: s.createdTenantId! },
      include: { signup: true, subscription: true },
    });
    expect(t.status).toBe('PENDING_VERIFICATION');
    expect(t.planCode).toBe('start');
    expect(t.subscription!.trialEndsAt).not.toBeNull();
    expect(t.signup!.flags).toContain('no_accounting_software');
    // หนังสือรับรอง → stored_document ของ tenant + ไฟล์ในโฟลเดอร์ tenant · ของ session ลบแล้ว
    const doc = await db.storedDocument.findUniqueOrThrow({
      where: { id: t.signup!.certificateDocumentId! },
    });
    expect(doc).toMatchObject({
      tenantId: t.id,
      kind: 'COMPANY_CERTIFICATE',
      entityType: 'company',
      mimeType: 'application/pdf',
    });
    expect(doc.fileKey!.startsWith(`${t.id}/`)).toBe(true);
    expect((await defaultFileStore().get(doc.fileKey!)).equals(PDF)).toBe(true);
    expect(s.certificateFileKey).toBeNull();
    const root = process.env.FILES_ROOT ?? join(process.cwd(), '.data', 'files');
    expect(existsSync(join(root, s0.certificateFileKey!))).toBe(false);
    // นิติบุคคลไม่จด VAT ตาม RD
    expect((await db.company.findFirstOrThrow({ where: { tenantId: t.id } })).vatRegistered).toBe(
      false,
    );
    expect(
      await db.domainEvent.count({ where: { tenantId: t.id, type: 'signup.completed' } }),
    ).toBe(1);
  });

  it('นโยบาย manual_all → ผลตรวจ auto_vat ก็เป็น pending_verification', async () => {
    const { token } = await submitted(jur(3));
    await setSetting('signup.approvalPolicy', 'manual_all');
    // ผลตรวจ jur(3) = ไม่พบใน RD อยู่แล้ว → ทดสอบกับ auto_vat แทน: บังคับผลตรวจของ session
    const s = await db.signupSession.findFirstOrThrow({ where: { taxId: jur(3) } });
    await db.signupSession.update({
      where: { id: s.id },
      data: { verificationStatus: 'auto_vat' },
    });
    const r = await complete(token);
    expect(r.status).toBe(200);
    expect(r.body.completion.tenantStatus).toBe('pending_verification');
    const t = await db.tenant.findUniqueOrThrow({
      where: {
        id: (await db.signupSession.findUniqueOrThrow({ where: { id: s.id } })).createdTenantId!,
      },
      include: { signup: true },
    });
    expect(t.signup!.approvalPolicy).toBe('manual_all');
  });

  it('สมัครเลขเดียวกันพร้อมกัน 2 ราย (ผ่านขั้น 2 ทั้งคู่) → สร้างได้รายเดียว อีกราย 409 company_exists', async () => {
    const tax = jur(4);
    const a = await submitted(tax);
    const b = await submitted(tax);
    const [ra, rb] = await Promise.all([complete(a.token), complete(b.token)]);
    const codes = [ra.status, rb.status].sort();
    expect(codes).toEqual([200, 409]);
    expect([ra.body.code, rb.body.code]).toContain('company_exists');
    const owners = await db.company.findMany({ where: { taxId: tax }, select: { tenantId: true } });
    expect(
      await db.tenant.count({ where: { id: { in: owners.map((o) => o.tenantId) }, mode: 'live' } }),
    ).toBe(1);
  });

  it('แพ็กเกจตกลงราคา (ent) → บันทึกคำขอนัด demo ไม่สร้างบริษัท · แพ็กเกจไม่รู้จัก 422 · ยังไม่ส่งขั้น 2 = 409', async () => {
    const { token, id } = await submitted(jur(5));
    const bad = await complete(token, 'nope');
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'planCode', code: 'unknown_plan' });
    const r = await complete(token, 'ent');
    expect(r.status).toBe(200);
    expect(r.body.completion.outcome).toBe('demo');
    expect(r.body.session.demoRequestedAt).not.toBeNull();
    const s = await db.signupSession.findUniqueOrThrow({ where: { id } });
    expect(s.status).toBe('company_submitted');
    expect(s.createdTenantId).toBeNull();
    expect(await db.company.count({ where: { taxId: jur(5) } })).toBe(0);

    const { token: t2, hash } = newOpaqueToken();
    await db.signupSession.create({
      data: {
        status: 'account_verified',
        fullName: 'ยังไม่ส่ง',
        email: `x${++seq}@company.co.th`,
        resumeTokenHash: hash,
        verifiedAt: new Date(),
      },
    });
    const early = await complete(t2);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('invalid_state_transition');
  });

  it('tenant_signup: แอปอ่านได้เฉพาะของ tenant ตัวเอง (RLS) และเขียนไม่ได้', async () => {
    const rows = await db.tenantSignup.findMany({ take: 2 });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const [a, b] = rows;
    const seen = await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a!.tenantId}, true)`;
      return tx.tenantSignup.findMany();
    });
    expect(seen.map((r) => r.tenantId)).toEqual([a!.tenantId]);
    expect(seen.some((r) => r.tenantId === b!.tenantId)).toBe(false);
    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a!.tenantId}, true)`;
        await tx.tenantSignup.update({ where: { tenantId: a!.tenantId }, data: { flags: [] } });
      }),
    ).rejects.toThrow();
  });
});
