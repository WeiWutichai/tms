import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newOpaqueToken } from '../src/auth/tokens';
import {
  BREAKER_OPEN_MS,
  CompanyLookupService,
  companyLookupMaintenance,
  LOOKUP_FOUND_TTL_MS,
  LOOKUP_NOT_FOUND_TTL_MS,
} from '../src/modules/signup/company-lookup/company-lookup.service';
import { vatResponseXml } from '../src/modules/signup/company-lookup/fixtures';
import {
  parseTinResponse,
  parseVatResponse,
  soapField,
  vatRequestXml,
} from '../src/modules/signup/company-lookup/rd-soap';
import { RegistryUnavailable } from '../src/modules/signup/company-lookup/types';
import {
  normalizeCompanyName,
  TERMS_VERSION_PLACEHOLDER,
} from '../src/modules/signup/signup-company.service';
import { signupMaintenance } from '../src/modules/signup/signup.service';
import { bootApp, createTenant, platform, truncateAll } from './helpers';
import { startMockRd, type MockRd } from './mock-rd-soap';

/**
 * P1-ST2-T04 สมัครขั้น 2 "ข้อมูลบริษัท" — เกณฑ์ตรวจรับ (plan/13; spec/01 §2 ขั้น 2 PLT-020–023):
 * checksum ผิด → error ไม่มี request ไป RD · เลขซ้ำ tenant เดิม → ไม่มีปุ่มสร้าง (duplicate / 409) ·
 * RD ล่ม 5 ครั้ง → ทุกเคส pending_verification 5 นาที (mock SOAP) · cache 24 ชม./1 ชม. · log ทุกการส่งเลขออก · concurrency ≤ 2
 * adapter `rd` (SOAP จริง) ชี้มาที่ mock SOAP server ในเครื่อง — ไม่มีการเรียกออกภายนอก
 */
const FOUND = '0105567153766'; // fixture: ผู้จด VAT (สำนักงานใหญ่ + สาขา 00001)
const TIN_ONLY = '0105569000011'; // fixture: มีเลขแต่ไม่จด VAT
const FOUND_NAME = 'บริษัท ตัวอย่างขนส่ง จำกัด';

/** เลขนิติบุคคล checksum ถูก ที่ไม่อยู่ใน fixture (ไม่พบ) */
function jur(seed: number): string {
  const base = `01055${String(80_000_00 + seed).padStart(7, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

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

describe('P1-ST2-T04 สมัครขั้น 2 ข้อมูลบริษัท', () => {
  let app: NestExpressApplication;
  let rd: MockRd;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  const http = () => request(app.getHttpServer());
  let seq = 0;

  beforeAll(async () => {
    await truncateAll();
    rd = await startMockRd();
    process.env.COMPANY_LOOKUP_PROVIDER = 'rd';
    process.env.RD_VAT_URL = `${rd.url}/vat`;
    process.env.RD_TIN_URL = `${rd.url}/tin`;
    process.env.RD_LOOKUP_TIMEOUT_MS = '2000';
    app = await bootApp();
  });
  beforeEach(async () => {
    rd.reset();
    // log เป็น append-only (UPDATE/DELETE ไม่ได้) — แต่ละ test เริ่มจากวงจรปิดด้วย TRUNCATE (owner)
    await owner.$executeRawUnsafe('TRUNCATE company_lookup_log, company_lookup');
  });
  afterAll(async () => {
    for (const k of ['COMPANY_LOOKUP_PROVIDER', 'RD_VAT_URL', 'RD_TIN_URL', 'RD_LOOKUP_TIMEOUT_MS'])
      delete process.env[k];
    await app.close();
    await rd.close();
    await db.$disconnect();
    await owner.$disconnect();
    await appDb.$disconnect();
  });

  /** การสมัครที่ยืนยัน OTP แล้ว (ขั้น 2) — สร้างแถวตรง ๆ (ขั้น 1 ทดสอบใน signup.test.ts) */
  async function verified(status: 'account_verified' | 'account_pending_otp' = 'account_verified') {
    const { token, hash } = newOpaqueToken();
    const s = await db.signupSession.create({
      data: {
        status,
        fullName: 'ทดสอบ ขั้นสอง',
        email: `co${Date.now().toString(36)}${++seq}@company.co.th`,
        mobile: '+66812345678',
        passwordHash: 'x',
        resumeTokenHash: hash,
        verifiedAt: status === 'account_verified' ? new Date() : null,
      },
    });
    return { token, id: s.id };
  }
  const lookup = (token: string, taxId: string, branchCode?: string) =>
    http()
      .post('/v1/public/signup/session/company/lookup')
      .set('X-Signup-Token', token)
      .send({ taxId, ...(branchCode ? { branchCode } : {}) });
  const submitBody = (taxId: string, extra: Record<string, unknown> = {}) => ({
    taxId,
    branchType: 'hq',
    legalName: FOUND_NAME,
    address: ADDRESS,
    fleetSizeOwn: 20,
    fleetSizeSubcon: 8,
    accountingSoftware: 'none',
    acceptTerms: true,
    acceptPrivacy: true,
    ...extra,
  });
  const submit = (token: string, body: Record<string, unknown>) =>
    http()
      .post('/v1/public/signup/session/company')
      .set('X-Signup-Token', token)
      .set('X-Forwarded-For', '10.88.0.7')
      .send(body);
  const upload = (token: string, data: Buffer, filename = 'หนังสือรับรอง.pdf') =>
    http()
      .put(`/v1/public/signup/session/company/certificate?filename=${encodeURIComponent(filename)}`)
      .set('X-Signup-Token', token)
      .set('Content-Type', 'application/octet-stream')
      .send(data);
  const logs = (taxId?: string) =>
    db.companyLookupLog.findMany({
      where: taxId ? { taxId } : {},
      orderBy: { createdAt: 'asc' },
    });

  it('checksum ผิด (PLT-020) → 422 thai_tax_id ทันที · ไม่มี request ไป RD และไม่มี log', async () => {
    const { token } = await verified();
    const bad = FOUND.slice(0, 12) + String((Number(FOUND[12]) + 1) % 10);
    const r = await lookup(token, bad);
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toMatchObject({ field: 'taxId', code: 'thai_tax_id' });
    const s = await submit(token, submitBody(bad));
    expect(s.status).toBe(422);
    expect((await lookup(token, '12345')).status).toBe(422);
    expect(rd.requests).toHaveLength(0);
    expect(await logs()).toHaveLength(0);
  });

  it('ค้นได้หลังยืนยัน OTP เท่านั้น · token ผิด = 401', async () => {
    const { token } = await verified('account_pending_otp');
    const r = await lookup(token, FOUND);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('invalid_state_transition');
    expect((await lookup('nope', FOUND)).status).toBe(401);
    expect(rd.requests).toHaveLength(0);
  });

  it('RD VAT พบ → prefill ชื่อ + ที่อยู่แยกฟิลด์ (source rd_vat) · SOAP 1.2 · log การส่งเลข · cache 24 ชม. (กดซ้ำไม่ยิงซ้ำ)', async () => {
    const { token, id } = await verified();
    const r = await lookup(token, FOUND);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({
      taxId: FOUND,
      branchCode: '00000',
      result: 'vat_found',
      source: 'rd_vat',
      duplicate: null,
      requiresCertificate: false,
      company: {
        legalName: FOUND_NAME,
        branchNumber: 0,
        vatRegisteredSince: '2024-05-02',
        address: {
          houseNo: '99/1',
          moo: '4',
          soi: '',
          street: 'พระราม 2',
          subDistrict: 'แสมดำ',
          district: 'บางขุนเทียน',
          province: 'กรุงเทพมหานคร',
          postalCode: '10150',
        },
      },
    });
    expect(rd.requests).toEqual([
      {
        service: 'vat',
        tin: FOUND,
        branch: '0',
        contentType: 'application/soap+xml; charset=utf-8',
      },
    ]);
    const l = await logs(FOUND);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({
      agency: 'RD',
      service: 'vat',
      provider: 'rd',
      outcome: 'found',
      httpStatus: 200,
      branchCode: '00000',
      signupSessionId: id,
    });
    const c = await db.companyLookup.findFirstOrThrow({ where: { taxId: FOUND } });
    expect(c.result).toBe('vat_found');
    const ttl = c.expiresAt.getTime() - c.fetchedAt.getTime();
    expect(ttl).toBe(LOOKUP_FOUND_TTL_MS);
    expect(c.rawResponse).toContain('vNID');
    // กดซ้ำ (session อื่นก็ได้) → จาก cache ไม่ยิง RD ไม่เพิ่ม log
    const other = await verified();
    const again = await lookup(other.token, FOUND);
    expect(again.body.result).toBe('vat_found');
    expect(rd.requests).toHaveLength(1);
    expect(await logs()).toHaveLength(1);
  });

  it('สาขา: ค้นด้วย BranchNumber ของสาขา (00001) · cache แยกตามสาขา', async () => {
    const { token } = await verified();
    const r = await lookup(token, FOUND, '00001');
    expect(r.body).toMatchObject({
      result: 'vat_found',
      branchCode: '00001',
      company: { branchNumber: 1, branchName: 'สาขาบางนา' },
    });
    expect(rd.requests[0]).toMatchObject({ service: 'vat', branch: '1' });
  });

  it('VAT ไม่พบ → RD TIN มีเลข → tin_exists (กรอกเอง + หนังสือรับรอง) · log 2 แถว · cache 24 ชม.', async () => {
    const { token } = await verified();
    const r = await lookup(token, TIN_ONLY);
    expect(r.body).toMatchObject({
      result: 'tin_exists',
      source: 'rd_tin',
      company: null,
      requiresCertificate: true,
    });
    expect(rd.requests.map((x) => x.service)).toEqual(['vat', 'tin']);
    expect((await logs(TIN_ONLY)).map((x) => [x.service, x.outcome])).toEqual([
      ['vat', 'not_found'],
      ['tin', 'found'],
    ]);
    const c = await db.companyLookup.findFirstOrThrow({ where: { taxId: TIN_ONLY } });
    expect(c.expiresAt.getTime() - c.fetchedAt.getTime()).toBe(LOOKUP_FOUND_TTL_MS);
  });

  it('ไม่พบทั้ง VAT และ TIN → not_found · cache 1 ชม. → หมดอายุแล้วค้นใหม่', async () => {
    const { token } = await verified();
    const tax = jur(1);
    const r = await lookup(token, tax);
    expect(r.body).toMatchObject({ result: 'not_found', requiresCertificate: true });
    const c = await db.companyLookup.findFirstOrThrow({ where: { taxId: tax } });
    expect(c.expiresAt.getTime() - c.fetchedAt.getTime()).toBe(LOOKUP_NOT_FOUND_TTL_MS);
    await lookup(token, tax);
    expect(rd.requests).toHaveLength(2); // จาก cache
    await db.companyLookup.update({
      where: { id: c.id },
      data: {
        fetchedAt: new Date(Date.now() - 2 * 3_600_000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await lookup(token, tax);
    expect(rd.requests).toHaveLength(4);
    expect(await logs(tax)).toHaveLength(4);
  });

  it('เลขซ้ำ tenant เดิม (taxId, branchCode) → duplicate ไม่ค้น RD · ส่งขั้น 2 = 409 company_exists · สาขาอื่น = สร้างได้ + ธง', async () => {
    const t = await createTenant(db, 'ศรีไทยขนส่ง');
    const tax = jur(2);
    const co = await db.company.create({
      data: { tenantId: t.id, legalName: 'บริษัท ศรีไทยขนส่ง จำกัด', taxId: tax },
    });
    await db.branch.create({
      data: {
        tenantId: t.id,
        companyId: co.id,
        branchCode: '00001',
        branchLabel: 'สาขา 00001',
        address: {},
      },
    });
    const { token } = await verified();
    const hq = await lookup(token, tax);
    expect(hq.body).toMatchObject({
      result: 'duplicate',
      duplicate: { companyName: 'บริษัท ศรีไทยขนส่ง จำกัด' },
      company: null,
    });
    const br = await lookup(token, tax, '00001');
    expect(br.body).toMatchObject({
      result: 'duplicate',
      duplicate: { branchLabel: 'สาขา 00001' },
    });
    expect(rd.requests).toHaveLength(0);
    expect(await logs()).toHaveLength(0);
    const s = await submit(token, submitBody(tax));
    expect(s.status).toBe(409);
    expect(s.body.code).toBe('company_exists');
    // สาขาที่ยังไม่มี → ไม่ซ้ำ ค้น RD ได้ + ธง sameTaxOtherBranch
    const other = await lookup(token, tax, '00002');
    expect(other.body).toMatchObject({ result: 'not_found', sameTaxOtherBranch: true });
    // sandbox (mode test) ไม่นับเป็นบริษัทเดิม
    const sbTax = jur(3);
    const sb = await db.tenant.create({ data: { name: 'sb', mode: 'test', liveTenantId: t.id } });
    await db.company.create({ data: { tenantId: sb.id, legalName: 'sandbox', taxId: sbTax } });
    expect((await lookup(token, sbTax)).body.result).not.toBe('duplicate');

    // "ส่งคำขอเข้าร่วมบริษัท" → บันทึกใน session (ไม่สร้างบริษัท)
    const j = await http()
      .post('/v1/public/signup/session/company/join-request')
      .set('X-Signup-Token', token)
      .send({ taxId: tax, kind: 'join' });
    expect(j.status).toBe(200);
    expect(j.body).toMatchObject({
      status: 'account_verified',
      joinRequest: { kind: 'join', companyName: 'บริษัท ศรีไทยขนส่ง จำกัด' },
    });
    const row = await db.signupSession.findFirstOrThrow({ where: { joinTenantId: t.id } });
    expect(row.joinRequestKind).toBe('join');
    const g = await http().get('/v1/public/signup/session').set('X-Signup-Token', token);
    expect(g.body.joinRequest.companyName).toBe('บริษัท ศรีไทยขนส่ง จำกัด');
    const notDup = await http()
      .post('/v1/public/signup/session/company/join-request')
      .set('X-Signup-Token', token)
      .send({ taxId: jur(4), kind: 'contact' });
    expect(notDup.status).toBe(422);
  });

  it('RD ล่ม 5 ครั้ง → circuit breaker 5 นาที: ทุกเคส unavailable / pending_verification โดยไม่ยิง RD (mock SOAP 500)', async () => {
    rd.fail = true;
    const { token } = await verified();
    for (let i = 0; i < 5; i++) {
      const r = await lookup(token, jur(10 + i));
      expect(r.body.result).toBe('unavailable');
    }
    expect(rd.requests).toHaveLength(5);
    const l = await logs();
    expect(l.map((x) => [x.outcome, x.httpStatus, x.errorCode])).toEqual(
      Array(5).fill(['error', 500, 'http_error']),
    );
    // วงจรเปิด: RD กลับมาแล้วก็ยังไม่ยิง (5 นาที) — ทุกเคสรวมเลขที่ปกติพบ
    rd.fail = false;
    const r6 = await lookup(token, FOUND);
    expect(r6.body).toMatchObject({ result: 'unavailable', company: null });
    expect(rd.requests).toHaveLength(5);
    // ส่งขั้น 2 ระหว่างวงจรเปิด → pending_verification (ไม่บังคับหนังสือรับรอง)
    const s = await submit(token, submitBody(FOUND));
    expect(s.status).toBe(200);
    expect(s.body.company).toMatchObject({ verificationStatus: 'pending_verification' });
    const row = await db.signupSession.findFirstOrThrow({ where: { taxId: FOUND } });
    expect(row.verificationReason).toBe('rd_unavailable:breaker_open');
    expect(rd.requests).toHaveLength(5);
    // ครบ 5 นาทีนับจากครั้งล่าสุด → ปิดวงจร (half-open: ลองยิงใหม่)
    const svc = app.get(CompanyLookupService);
    expect(await svc.breakerOpenUntil('rd')).not.toBeNull();
    expect(await svc.breakerOpenUntil('rd', Date.now() + BREAKER_OPEN_MS + 1000)).toBeNull();
    // ล้มเหลว 4 ครั้งไม่เปิดวงจร
    await owner.$executeRawUnsafe('TRUNCATE company_lookup_log');
    rd.fail = true;
    for (let i = 0; i < 4; i++) await lookup(token, jur(20 + i));
    rd.fail = false;
    const ok = await lookup(token, FOUND);
    expect(ok.body.result).toBe('vat_found');
  });

  it('timeout ของ RD นับเป็นล้มเหลว (log error timeout)', async () => {
    process.env.RD_LOOKUP_TIMEOUT_MS = '150';
    rd.delayMs = 600;
    try {
      const { token } = await verified();
      const r = await lookup(token, jur(30));
      expect(r.body.result).toBe('unavailable');
      const l = await logs();
      expect(l[0]).toMatchObject({ outcome: 'error', errorCode: 'timeout' });
    } finally {
      process.env.RD_LOOKUP_TIMEOUT_MS = '2000';
    }
  });

  it('concurrency ≤ 2: ค้นพร้อมกัน 6 เลข → RD เห็นคำขอค้างพร้อมกันไม่เกิน 2 และทุกคำขอเสร็จ', async () => {
    rd.delayMs = 150;
    const sessions = await Promise.all(Array.from({ length: 6 }, () => verified()));
    const rs = await Promise.all(sessions.map((s, i) => lookup(s.token, jur(40 + i))));
    expect(rs.map((r) => r.body.result)).toEqual(Array(6).fill('not_found'));
    expect(rd.requests).toHaveLength(12);
    expect(rd.maxInFlight).toBeLessThanOrEqual(2);
    expect(rd.maxInFlight).toBeGreaterThanOrEqual(1);
  });

  it('ส่งขั้น 2: VAT พบ + ชื่อตรง → auto_vat · company_submitted (ขั้น 3) · เก็บเวอร์ชันข้อกำหนด + เวลา + IP · accountingSoftware เป็น lead', async () => {
    const { token, id } = await verified();
    await lookup(token, FOUND);
    const r = await submit(
      token,
      submitBody(FOUND, {
        legalName: 'บจก. ตัวอย่างขนส่ง',
        accountingSoftware: 'flow_account',
        marketingOptIn: true,
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: 'company_submitted',
      step: 3,
      company: {
        taxId: FOUND,
        branchCode: '00000',
        legalName: 'บจก. ตัวอย่างขนส่ง',
        address: ADDRESS,
        fleetSizeOwn: 20,
        fleetSizeSubcon: 8,
        accountingSoftware: 'flow_account',
        verificationStatus: 'auto_vat',
        verificationSource: 'rd_vat',
        marketingOptIn: true,
        certificate: null,
      },
    });
    expect(rd.requests).toHaveLength(1); // ใช้ผลจาก cache ของปุ่มค้นหา
    const s = await db.signupSession.findUniqueOrThrow({ where: { id } });
    expect(s).toMatchObject({
      termsVersion: TERMS_VERSION_PLACEHOLDER,
      privacyVersion: TERMS_VERSION_PLACEHOLDER,
      termsAcceptedIp: '10.88.0.7',
      verificationReason: 'rd_vat_found',
    });
    expect(s.termsAcceptedAt).not.toBeNull();
    expect(s.companyLookupId).not.toBeNull();
    // ไม่เปิด connector ใด ๆ (ยังไม่มี tenant — ขั้น 3 = T05)
    expect(await db.connector.count()).toBe(0);
    // GET session (กลับมาทำต่อ) เห็นข้อมูลบริษัท · แก้ซ้ำได้ระหว่าง company_submitted
    const g = await http().get('/v1/public/signup/session').set('X-Signup-Token', token);
    expect(g.body).toMatchObject({
      status: 'company_submitted',
      step: 3,
      company: { taxId: FOUND },
    });
    const again = await submit(token, submitBody(FOUND, { legalName: 'บริษัท อื่น จำกัด' }));
    expect(again.body.company.verificationStatus).toBe('pending_verification');
    expect((await db.signupSession.findUniqueOrThrow({ where: { id } })).verificationReason).toBe(
      'name_mismatch',
    );
  });

  it('ไม่จด VAT (tin_exists) → ต้องแนบหนังสือรับรอง (pending_manual) · ตรวจชนิดไฟล์จากเนื้อไฟล์', async () => {
    const { token, id } = await verified();
    const noCert = await submit(
      token,
      submitBody(TIN_ONLY, { legalName: 'บริษัท ไม่จดแวต จำกัด' }),
    );
    expect(noCert.status).toBe(422);
    expect(noCert.body.errors[0]).toMatchObject({
      field: 'certificateFile',
      code: 'certificate_required',
    });
    const fake = await upload(token, Buffer.from('not a pdf at all'), 'x.pdf');
    expect(fake.status).toBe(422);
    expect(fake.body.errors[0]).toMatchObject({ field: 'content', code: 'unsupported_type' });
    const empty = await upload(token, Buffer.alloc(0));
    expect(empty.status).toBe(422);
    const up = await upload(token, PDF);
    expect(up.status).toBe(200);
    expect(up.body.company).toBeNull(); // ยังไม่ส่งขั้น 2
    expect(up.body.certificate).toMatchObject({
      filename: 'หนังสือรับรอง.pdf',
      mime: 'application/pdf',
    });
    const row = await db.signupSession.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      certificateFilename: 'หนังสือรับรอง.pdf',
      certificateMime: 'application/pdf',
      certificateBytes: PDF.length,
    });
    expect(row.certificateFileKey).toMatch(new RegExp(`^${id}/[0-9a-f]{64}\\.pdf$`));
    const ok = await submit(token, submitBody(TIN_ONLY, { legalName: 'บริษัท ไม่จดแวต จำกัด' }));
    expect(ok.status).toBe(200);
    expect(ok.body.company).toMatchObject({
      verificationStatus: 'pending_manual',
      verificationSource: 'rd_tin',
      certificate: { filename: 'หนังสือรับรอง.pdf', mime: 'application/pdf' },
    });
    // CHECK: pending_manual ต้องมีไฟล์
    await expect(
      db.signupSession.update({ where: { id }, data: { certificateFileKey: null } }),
    ).rejects.toThrow(/check constraint/i);
  });

  it('บุคคลธรรมดา (หลักแรก ≠ 0) → ไม่ส่งเลขออก · pending_verification', async () => {
    const { token } = await verified();
    const person = '1101700203450';
    const r = await lookup(token, person);
    expect(r.body).toMatchObject({ result: 'individual', company: null });
    const s = await submit(token, submitBody(person, { legalName: 'นาย ทดสอบ ขนส่ง' }));
    expect(s.body.company.verificationStatus).toBe('pending_verification');
    expect(rd.requests).toHaveLength(0);
    expect(await logs()).toHaveLength(0);
  });

  it('validation ขั้น 2: จำนวนรถ 0–5000 · ยอมรับข้อกำหนด/นโยบาย · สาขา 5 หลักไม่ใช่ 00000 · รหัสไปรษณีย์ · โปรแกรมบัญชี', async () => {
    const { token } = await verified();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ fleetSizeOwn: 5001 }, 'fleetSizeOwn'],
      [{ fleetSizeSubcon: -1 }, 'fleetSizeSubcon'],
      [{ acceptTerms: false }, 'acceptTerms'],
      [{ acceptPrivacy: undefined }, 'acceptPrivacy'],
      [{ branchType: 'branch', branchCode: '00000' }, 'branchCode'],
      [{ branchType: 'branch' }, 'branchCode'],
      [{ address: { ...ADDRESS, postalCode: '1015' } }, 'address.postalCode'],
      [{ address: { ...ADDRESS, province: '' } }, 'address.province'],
      [{ accountingSoftware: 'sap' }, 'accountingSoftware'],
      [{ legalName: '  ' }, 'legalName'],
    ];
    for (const [extra, field] of cases) {
      const r = await submit(token, submitBody(FOUND, extra));
      expect(r.status, field).toBe(422);
      expect(
        (r.body.errors as Array<{ field: string }>).map((e) => e.field),
        field,
      ).toContain(field);
    }
  });

  it('เพดานค้นหา 20 ครั้งต่อการสมัคร → 429 signup_lookup_limit', async () => {
    const { token, id } = await verified();
    await db.signupSession.update({ where: { id }, data: { lookupCount: 20 } });
    const r = await lookup(token, FOUND);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('signup_lookup_limit');
    expect(rd.requests).toHaveLength(0);
  });

  it('ผู้ให้บริการ disabled (ค่าเริ่มนอก dev/test) → unavailable ไม่ส่งเลขออก ไม่มี log', async () => {
    process.env.COMPANY_LOOKUP_PROVIDER = 'disabled';
    try {
      const { token } = await verified();
      const r = await lookup(token, FOUND);
      expect(r.body.result).toBe('unavailable');
      expect(rd.requests).toHaveLength(0);
      expect(await logs()).toHaveLength(0);
    } finally {
      process.env.COMPANY_LOOKUP_PROVIDER = 'rd';
    }
  });

  it('งานรายวัน: raw response > 90 วันถูกล้าง · ลบข้อมูลส่วนบุคคลวันที่ 30 ล้างข้อมูลขั้น 2 + ลบไฟล์หนังสือรับรอง', async () => {
    const { token, id } = await verified();
    await lookup(token, TIN_ONLY);
    await upload(token, PDF);
    await submit(token, submitBody(TIN_ONLY));
    const c = await db.companyLookup.findFirstOrThrow({ where: { taxId: TIN_ONLY } });
    await db.companyLookup.update({
      where: { id: c.id },
      data: { fetchedAt: new Date(Date.now() - 91 * 86_400_000) },
    });
    expect((await companyLookupMaintenance(db)).rawPurged).toBe(1);
    const c2 = await db.companyLookup.findUniqueOrThrow({ where: { id: c.id } });
    expect(c2.rawResponse).toBeNull();
    expect(c2.rawPurgedAt).not.toBeNull();

    const key = (await db.signupSession.findUniqueOrThrow({ where: { id } })).certificateFileKey!;
    const path = join(process.env.FILES_ROOT ?? join(process.cwd(), '.data', 'files'), key);
    expect(existsSync(path)).toBe(true);
    await db.signupSession.update({
      where: { id },
      data: { lastActivityAt: new Date(Date.now() - 31 * 86_400_000) },
    });
    const m = await signupMaintenance(db);
    expect(m.certificates).toBeGreaterThanOrEqual(1);
    expect(existsSync(path)).toBe(false);
    const e = await db.signupSession.findUniqueOrThrow({ where: { id } });
    expect(e).toMatchObject({
      status: 'abandoned',
      taxId: null,
      legalName: null,
      address: null,
      termsAcceptedIp: null,
      certificateFileKey: null,
      certificateFilename: null,
    });
    // log การส่งเลขออกคงอยู่ (PDPA accountability)
    expect((await logs(TIN_ONLY)).length).toBeGreaterThan(0);
  });

  it('แยกข้อมูล: company_lookup / company_lookup_log เป็นตาราง platform — tms_app อ่าน/เขียนไม่ได้ · log แก้/ลบไม่ได้', async () => {
    await expect(appDb.companyLookup.findMany()).rejects.toThrow(/permission denied/);
    await expect(appDb.companyLookupLog.findMany()).rejects.toThrow(/permission denied/);
    const { token } = await verified();
    await lookup(token, FOUND);
    const [l] = await logs();
    await expect(
      db.companyLookupLog.update({ where: { id: l!.id }, data: { outcome: 'not_found' } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.companyLookupLog.delete({ where: { id: l!.id } })).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('RD SOAP adapter (parser)', () => {
  it('คำขอ VAT = SOAP 1.2 anonymous + TIN + BranchNumber', () => {
    const x = vatRequestXml('0105567153766', 1);
    expect(x).toContain('http://www.w3.org/2003/05/soap-envelope');
    expect(soapField(x, 'username')).toBe('anonymous');
    expect(soapField(x, 'TIN')).toBe('0105567153766');
    expect(soapField(x, 'BranchNumber')).toBe('1');
  });
  it('แปลงผลลัพธ์: anyType, entity, "-" = ว่าง, ไม่พบ = null, SOAP Fault = unavailable', () => {
    const xml = vatResponseXml('0105567153766', {
      title: 'บริษัท',
      name: 'เอ & บี จำกัด',
      branchNumber: 0,
      houseNo: '1',
      thambol: 'ต',
      amphur: 'อ',
      province: 'จ',
      postCode: '10000',
      businessFirstDate: '2020-01-05',
    });
    expect(parseVatResponse(xml)).toMatchObject({
      legalName: 'บริษัท เอ & บี จำกัด',
      address: { moo: '', soi: '', street: '', houseNo: '1' },
      vatRegisteredSince: '2020-01-05',
    });
    expect(parseVatResponse(vatResponseXml('0105569000029', null))).toBeNull();
    expect(() =>
      parseVatResponse(
        '<soap:Envelope><soap:Body><soap:Fault>x</soap:Fault></soap:Body></soap:Envelope>',
      ),
    ).toThrow(RegistryUnavailable);
    expect(() => parseVatResponse('<html>gateway</html>')).toThrow(RegistryUnavailable);
    expect(
      parseTinResponse('<ServiceTINResult><vIsExist>มีอยู่จริง</vIsExist></ServiceTINResult>'),
    ).toBe(true);
    expect(
      parseTinResponse('<ServiceTINResult><vIsExist>ไม่มีอยู่จริง</vIsExist></ServiceTINResult>'),
    ).toBe(false);
  });
  it('ชื่อ "ตรง" หลัง normalize คำนำหน้า/ช่องว่าง', () => {
    expect(normalizeCompanyName('บริษัท ตัวอย่างขนส่ง จำกัด')).toBe(
      normalizeCompanyName('บจก.ตัวอย่างขนส่ง'),
    );
    expect(normalizeCompanyName('ห้างหุ้นส่วนจำกัด เอบี')).toBe(normalizeCompanyName('หจก. เอบี'));
    expect(normalizeCompanyName('บริษัท ก จำกัด (มหาชน)')).toBe(normalizeCompanyName('บมจ. ก'));
    expect(normalizeCompanyName('บริษัท ก จำกัด')).not.toBe(normalizeCompanyName('บริษัท ข จำกัด'));
  });
});
