import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import ExcelJS from 'exceljs';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import {
  pkceChallenge,
  signAccessToken,
  signPlatformStepUpToken,
  signPlatformToken,
  signStepUpToken,
} from '../src/auth/tokens';
import { newTotpSecret } from '../src/auth/totp';
import { FieldCipher } from '../src/common/crypto';
import { encodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, freshOtp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** เลขผู้เสียภาษีนิติบุคคล (checksum ถูก) — ข้อมูลสมมติ */
function jurTax(n: number): string {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

/**
 * ต่อจาก D-67 — คำตัดสิน PO 23 พ.ย. 2569
 * - D-77 Platform Console step-up: ใส่/หมุน credential / เปิด connector พร้อม credential หรือ settings ต้องยืนยัน TOTP ซ้ำ
 * - D-78 บังคับตั้ง 2FA เมื่อถือ settings:write / settlements:pay / invoices:void / export:run
 * - D-79 API key แก้/ดูบัญชีธนาคารผู้รับเหมาไม่ได้ (403 bank_change_requires_user)
 */
describe('2FA ต่อจาก D-67 (D-77 / D-78 / D-79)', () => {
  let app: NestExpressApplication;
  const db = platform();
  const cipher = new FieldCipher();
  const srv = () => app.getHttpServer();
  const PW = 'd78-test-password-2569';
  let ip = 0;
  const nextIp = () => `10.78.${Math.floor(++ip / 250)}.${ip % 250}`;
  let tenantId: string;
  let roleIds: Record<string, string>;
  let admin: string;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท สองชั้น' })).id;
    await db.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    roleIds = await ensureSystemRoles(db as never, tenantId);
    admin = await tokenFor(tenantId, '*', randomUUID());
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });

  // ---------------------------------------------------------------- D-77
  describe('D-77 Platform Console step-up', () => {
    let staffId: string;
    let staffToken: string;
    let otherToken: string;
    let secret: string;
    let conId: string;
    const tenantPub = () => encodeId('tenant', tenantId);
    const con = (tok: string, su?: string) => {
      const r = request(srv())
        .put(`/v1/platform/connectors/${conId}/credentials`)
        .set('Authorization', `Bearer ${tok}`);
      return su === undefined ? r : r.set('X-Step-Up', su);
    };

    beforeAll(async () => {
      secret = newTotpSecret();
      const mk = async (role: 'SUPER_ADMIN') => {
        const u = await db.platformUser.create({
          data: {
            email: `sa-${randomUUID().slice(0, 6)}@innovera.test`,
            name: 'ทีม SA',
            role,
            passwordHash: 'x',
            totpSecret: cipher.encrypt(secret),
          },
        });
        return {
          id: u.id,
          token: await signPlatformToken({ sub: u.id, role, tv: u.tokenVersion }),
        };
      };
      const a = await mk('SUPER_ADMIN');
      staffId = a.id;
      staffToken = a.token;
      otherToken = (await mk('SUPER_ADMIN')).token;
      // เปิด connector ด้วย step-up ของ Console (helpers.api แนบให้อัตโนมัติ)
      const r = await api(app, staffToken)
        .post(`/v1/platform/tenants/${tenantPub()}/connectors`)
        .send({
          adapterKey: 'demo',
          credentials: { apiKey: 'demo-d77' },
          reason: 'เปิดให้ลูกค้า D-77',
        });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      conId = r.body.id;
    });

    it('หมุน credential: ไม่ส่ง / ของคนอื่น / step-up ของลูกค้า / ปลอม → 403 step_up_required · ข้อมูลผิด = 422 ก่อน', async () => {
      const body = { credentials: { apiKey: 'demo-d77' }, reason: 'หมุน key ตามรอบ D-77' };
      const otherSu = await signPlatformStepUpToken(randomUUID(), 0);
      const tenantSu = await signStepUpToken(staffId, tenantId);
      for (const su of [undefined, '', otherSu, tenantSu, 'x.y.z']) {
        const r = await con(staffToken, su).send(body);
        expect(r.status, String(su)).toBe(403);
        expect(r.body.code).toBe('step_up_required');
      }
      // token step-up ของ staff คนนี้ ใช้กับ token ของอีกคนไม่ได้
      const mine = await signPlatformStepUpToken(staffId, 0);
      expect((await con(otherToken, mine).send(body)).body.code).toBe('step_up_required');
      // validation ก่อน step-up
      await con(staffToken)
        .send({ credentials: { apiKey: 'x' } })
        .expect(422);
      // ไม่พบ connector → 404 ก่อน step-up
      await request(srv())
        .put(`/v1/platform/connectors/${encodeId('connector', randomUUID())}/credentials`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send(body)
        .expect(404);
    });

    it('POST /platform/auth/step-up: รหัสผิด 401 invalid_otp · ถูก → token 5 นาที → หมุน credential ได้ · ออกจากระบบแล้ว token ใช้ไม่ได้', async () => {
      const step = (code: string) =>
        request(srv())
          .post('/v1/platform/auth/step-up')
          .set('Authorization', `Bearer ${staffToken}`)
          .send({ code });
      expect((await step('000000')).body.code).toBe('invalid_otp');
      const ok = await step(await freshOtp(secret));
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.expiresIn).toBe(300);
      // token Console ของลูกค้าใช้ step-up ของ Console ไม่ได้
      await request(srv()).post('/v1/platform/auth/step-up').send({ code: '123456' }).expect(401);
      const r = await con(staffToken, ok.body.stepUpToken).send({
        credentials: { apiKey: 'demo-d77' },
        reason: 'หมุน key ตามรอบ D-77',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // tokenVersion เปลี่ยน (ออกจากระบบทุกเครื่อง) → step-up เดิมใช้ไม่ได้
      await db.platformUser.update({
        where: { id: staffId },
        data: { tokenVersion: { increment: 1 } },
      });
      const u = await db.platformUser.findUniqueOrThrow({ where: { id: staffId } });
      const fresh = await signPlatformToken({ sub: staffId, role: u.role, tv: u.tokenVersion });
      const again = await con(fresh, ok.body.stepUpToken).send({
        credentials: { apiKey: 'demo-d77' },
        reason: 'หมุน key ตามรอบ D-77',
      });
      expect(again.body.code).toBe('step_up_required');
      staffToken = fresh;
    });

    it('เปิด connector: ส่ง credentials หรือ settings ต้อง step-up · ยืนยันแล้วเปิดได้', async () => {
      const t2 = (await createTenantWithDefaults(db, { name: 'บริษัท สองชั้น 2' })).id;
      await db.tenant.update({ where: { id: t2 }, data: { planCode: 'ent' } });
      const open = (body: object, su?: string) => {
        const r = request(srv())
          .post(`/v1/platform/tenants/${encodeId('tenant', t2)}/connectors`)
          .set('Authorization', `Bearer ${staffToken}`);
        return (su ? r.set('X-Step-Up', su) : r).send(body);
      };
      const reason = 'เปิดให้ลูกค้าทดลอง D-77';
      for (const extra of [
        { credentials: { apiKey: 'k' } },
        { settings: { baseUrl: 'https://x.test' } },
      ]) {
        const r = await open({ adapterKey: 'demo', reason, ...extra });
        expect(r.status, JSON.stringify(extra)).toBe(403);
        expect(r.body.code).toBe('step_up_required');
      }
      // ยืนยันแล้ว (step-up ของ Console) → เปิดได้
      const ok = await api(app, staffToken)
        .post(`/v1/platform/tenants/${encodeId('tenant', t2)}/connectors`)
        .send({ adapterKey: 'demo', reason, credentials: { apiKey: 'k' } });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    });

    it('OpenAPI: route Console ประกาศ X-Step-Up จาก /v1/platform/auth/step-up', async () => {
      const doc = (await request(srv()).get('/v1/openapi.json').expect(200)).body;
      for (const [p, m] of [
        ['/v1/platform/connectors/{id}/credentials', 'put'],
        ['/v1/platform/tenants/{id}/connectors', 'post'],
      ] as const) {
        const h = doc.paths[p][m].parameters.find((x: { name: string }) => x.name === 'X-Step-Up');
        expect(h.description, p).toContain('/v1/platform/auth/step-up');
      }
    });
  });

  // ---------------------------------------------------------------- D-78
  describe('D-78 บังคับตั้ง 2FA ตามสิทธิ์', () => {
    async function user(email: string, roleId: string) {
      const u = await db.appUser.create({
        data: {
          tenantId,
          email,
          name: `ทดสอบ ${email}`,
          status: 'ACTIVE',
          passwordHash: await hashPassword(PW),
        },
      });
      await db.userRole.create({ data: { tenantId, userId: u.id, roleId } });
      return u;
    }
    /** token ผู้ใช้ที่ออกก่อนบังคับ (เช่น ต่ออายุด้วย refresh token เดิม) */
    const userToken = async (u: { id: string; tokenVersion: number }, scope: string) =>
      signAccessToken({ sub: u.id, tid: tenantId, scope, pt: 'user', tv: u.tokenVersion });
    const login = (email: string) => {
      const v = randomBytes(32).toString('base64url');
      return request(srv())
        .post('/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email, password: PW, codeChallenge: pkceChallenge(v) })
        .then((res) => ({ res, v }));
    };

    it('ผู้ใช้สิทธิ์สำคัญ (planner — export:run) ยังไม่ตั้ง: route ปกติ 403 · ดูสถานะ 2FA ได้ · login → ขั้นตั้ง 2FA → ตั้งแล้วใช้งานได้', async () => {
      const u = await user('planner@d78.test', roleIds.planner!);
      const tok = await userToken(u, SYSTEM_ROLES.planner.permissions.join(' '));
      const blocked = await api(app, tok).get('/v1/customers');
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('two_factor_enrolment_required');
      expect(blocked.body.title).toBe('บัญชีนี้ต้องตั้งการยืนยันตัวตน 2 ชั้นก่อนใช้งาน');
      // route ที่ไม่มีสิทธิ์อยู่แล้วก็ได้รหัสเดียวกัน (ไม่บอกเรื่องสิทธิ์ก่อนตั้ง 2FA)
      expect((await api(app, tok).get('/v1/users')).body.code).toBe(
        'two_factor_enrolment_required',
      );
      const st = await api(app, tok).get('/v1/me/2fa').expect(200);
      expect(st.body).toEqual({ enabled: false, required: true, backupCodesRemaining: 0 });

      // ขั้นตั้ง 2FA เดิม (mfaToken จาก login)
      const { res, v } = await login('planner@d78.test');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('mfa_enrollment_required');
      const s = await request(srv())
        .post('/v1/auth/2fa/enroll')
        .send({ mfaToken: res.body.mfaToken })
        .expect(200);
      const c = await request(srv())
        .post('/v1/auth/2fa/enroll/confirm')
        .send({ mfaToken: res.body.mfaToken, otp: await freshOtp(s.body.secret) });
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      const t = await request(srv())
        .post('/v1/oauth/token')
        .send({ grantType: 'authorization_code', code: c.body.code, codeVerifier: v })
        .expect(200);
      await api(app, t.body.accessToken).get('/v1/customers').expect(200);
      // ตั้งแล้ว token เดิมก็ใช้ได้
      await api(app, tok).get('/v1/customers').expect(200);
    });

    it('role กำหนดเองที่มี settlements:pay ต้องตั้ง 2FA · ผู้ใช้ทั่วไป (dispatcher / viewer) ไม่ถูกบังคับ', async () => {
      const custom = await db.role.create({
        data: {
          tenantId,
          code: `pay-${randomUUID().slice(0, 6)}`,
          nameTh: 'จ่ายเงิน',
          nameEn: 'Payer',
          permissions: ['settlements:read', 'settlements:pay'],
          isSystem: false,
        },
      });
      await user('payer@d78.test', custom.id);
      expect((await login('payer@d78.test')).res.body.code).toBe('mfa_enrollment_required');

      for (const role of ['dispatcher', 'viewer'] as const) {
        const u = await user(`${role}@d78.test`, roleIds[role]!);
        const { res, v } = await login(`${role}@d78.test`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const t = await request(srv())
          .post('/v1/oauth/token')
          .send({ grantType: 'authorization_code', code: res.body.code, codeVerifier: v })
          .expect(200);
        await api(app, t.body.accessToken).get('/v1/customers').expect(200);
        const st = await api(app, t.body.accessToken).get('/v1/me/2fa').expect(200);
        expect(st.body.required).toBe(false);
        expect(u.totpEnabledAt).toBeNull();
      }
    });

    it('token dev / API key ไม่เกี่ยว (บังคับเฉพาะผู้ใช้ที่ login)', async () => {
      await api(app, admin).get('/v1/customers').expect(200);
      const k = await api(app, admin)
        .post('/v1/api-keys')
        .send({ name: 'd78-key', scopes: ['master:read', 'export:run'] });
      expect(k.status, JSON.stringify(k.body)).toBe(201);
      await request(srv())
        .get('/v1/customers')
        .set('Authorization', `Bearer ${k.body.secret}`)
        .expect(200);
    });
  });

  // ---------------------------------------------------------------- D-79
  describe('D-79 API key กับบัญชีธนาคารผู้รับเหมา', () => {
    let key: string;
    let seq = 0;
    const BANK = { bankCode: 'KBANK', accountNo: '1234567891', accountName: 'หจก. บัญชีคีย์' };
    const juristic = (extra: object = {}) => ({
      legalName: `หจก. บัญชีคีย์ ${++seq}`,
      entityType: 'JURISTIC',
      taxId: jurTax(79_000 + seq),
      ...extra,
    });
    const byKey = (m: 'get' | 'post' | 'patch' | 'put', url: string) =>
      request(srv())[m](url).set('Authorization', `Bearer ${key}`);
    const denied = (r: request.Response) => {
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.code).toBe('bank_change_requires_user');
    };

    beforeAll(async () => {
      const r = await api(app, admin)
        .post('/v1/api-keys')
        .send({
          name: 'd79-key',
          scopes: [
            'master:read',
            'master:write',
            'settlements:pay',
            'documents:read',
            'documents:write',
          ],
        });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      key = r.body.secret;
    });

    it('สร้าง/แก้/upsert ที่เปลี่ยนบัญชี → 403 · ช่องอื่นแก้ได้ · ส่งธนาคาร+ชื่อเดิมไม่มีเลข = ไม่ใช่การเปลี่ยน', async () => {
      denied(await byKey('post', '/v1/carriers').send(juristic({ bankAccount: BANK })));
      const c = await byKey('post', '/v1/carriers').send(juristic());
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      const url = `/v1/carriers/${c.body.id}`;
      denied(await byKey('patch', url).send({ bankAccount: BANK }));
      const ok = await byKey('patch', url).send({ phone: '021234567' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);

      const ext = `EXT-D79-${randomUUID().slice(0, 6)}`;
      denied(
        await byKey('put', `/v1/carriers/external/${ext}`).send(juristic({ bankAccount: BANK })),
      );
      const up = await byKey('put', `/v1/carriers/external/${ext}`).send(juristic());
      expect(up.status, JSON.stringify(up.body)).toBe(201);
      denied(await byKey('patch', `/v1/carriers/external/${ext}`).send({ bankAccount: BANK }));

      // ผู้ใช้ตั้งบัญชีให้ (step-up) → key ส่งธนาคาร+ชื่อเดิม (ไม่มีเลข) ได้ · เปลี่ยนชื่อบัญชี / ลบ ไม่ได้
      await api(app, admin).patch(url).send({ bankAccount: BANK }).expect(200);
      const same = await byKey('patch', url).send({
        bankAccount: { bankCode: BANK.bankCode, accountName: BANK.accountName },
      });
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      denied(
        await byKey('patch', url).send({
          bankAccount: { bankCode: BANK.bankCode, accountName: 'ชื่อใหม่' },
        }),
      );
      denied(await byKey('patch', url).send({ bankAccount: null }));
    });

    it('ดูเลขบัญชีเต็มด้วย key → 403 · เลขผู้เสียภาษียังดูได้', async () => {
      const c = await api(app, admin)
        .post('/v1/carriers')
        .send(juristic({ bankAccount: BANK }));
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      denied(
        await byKey('post', `/v1/carriers/${c.body.id}/reveal`).send({
          field: 'bankAccountNo',
          reason: 'ตรวจเลขบัญชีก่อนโอน',
        }),
      );
      const tax = await byKey('post', `/v1/carriers/${c.body.id}/reveal`).send({
        field: 'taxId',
        reason: 'ตรวจเลขผู้เสียภาษี',
      });
      expect(tax.status, JSON.stringify(tax.body)).toBe(200);
    });

    it('นำเข้าไฟล์ผู้รับเหมาที่มีคอลัมน์บัญชีด้วย key: ยืนยันนำเข้า → 403', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('a');
      ws.addRow(['ชื่อ', 'เลขผู้เสียภาษี', 'ประเภท', 'ธนาคาร', 'เลขบัญชี', 'ชื่อบัญชี']);
      ws.addRow([
        'นายนำเข้า ด้วยคีย์',
        validTaxId(79_900),
        'บุคคลธรรมดา',
        'SCB',
        '1112223334',
        'นายนำเข้า',
      ]);
      const data = Buffer.from(await wb.xlsx.writeBuffer());
      const d = await byKey('post', '/v1/documents').send({
        kind: 'IMPORT',
        mime: XLSX,
        bytes: data.length,
        filename: 'carrier.xlsx',
      });
      expect(d.status, JSON.stringify(d.body)).toBe(201);
      const u = new URL(d.body.uploadUrl);
      await request(srv())
        .put(u.pathname + u.search)
        .set('Content-Type', 'application/octet-stream')
        .send(data)
        .expect(200);
      const imp = await byKey('post', '/v1/imports').send({
        kind: 'carrier',
        documentId: d.body.id,
      });
      expect(imp.status, JSON.stringify(imp.body)).toBe(201);
      denied(await byKey('post', `/v1/imports/${imp.body.id}/commit`));
    });

    it('OpenAPI: route บัญชีธนาคารมีตัวอย่าง 403 bank_change_requires_user', async () => {
      const doc = (await request(srv()).get('/v1/openapi.json').expect(200)).body;
      for (const [p, m] of [
        ['/v1/carriers', 'post'],
        ['/v1/carriers/{id}', 'patch'],
        ['/v1/carriers/{id}/reveal', 'post'],
        ['/v1/imports/{id}/commit', 'post'],
      ] as const) {
        const ex = doc.paths[p][m].responses['403'].content['application/problem+json'].examples;
        expect(Object.keys(ex), `${m} ${p}`).toContain('bank_change_requires_user');
      }
    });
  });
});
