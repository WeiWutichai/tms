import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signStepUpToken } from '../src/auth/tokens';
import { encodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/** เลขผู้เสียภาษีนิติบุคคล (checksum ถูก) — ข้อมูลสมมติ */
function jurTax(n: number): string {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

/**
 * D-67 (PO 22 พ.ย. 2569; spec/11 NFR-107; ST9-T13 M-02) — step-up 2FA ขยาย:
 * API key (สร้าง/หมุน) · credential connector · secret webhook · บัญชีธนาคารรถร่วม · ส่งออกทั้งบริษัท · ยกเลิกใบแจ้งหนี้ที่ออกแล้ว
 * - ผู้ใช้: ไม่มี `X-Step-Up` ที่ถูกต้องของตัวเอง → 403 `step_up_required` · มี → ผ่าน
 * - API key: ทำ step-up ไม่ได้ → route ที่ key เข้าได้อยู่แล้วคุมด้วย scope (ไม่ถาม step-up)
 * (`api()` ใน helpers แนบ step-up ให้ route เหล่านี้อัตโนมัติ — ที่นี่ส่งคำขอดิบเพื่อทดสอบด่านเอง)
 */
describe('step-up 2FA ขยาย (D-67)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let userId: string;
  let admin: string;
  let seed = 0;
  const srv = () => app.getHttpServer();

  /** คำขอของผู้ใช้ — `su` = step-up token (ไม่ส่ง = ยังไม่ยืนยัน 2FA) */
  const raw = (method: 'get' | 'post' | 'put' | 'patch', url: string, su?: string, tok = admin) => {
    const r = request(srv())[method](url).set('Authorization', `Bearer ${tok}`);
    return su ? r.set('X-Step-Up', su) : r;
  };
  const mine = () => signStepUpToken(userId, tenantId);
  const keyOf = async (scopes: string[]) => {
    const r = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: `k-${++seed}`, scopes });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.secret as string;
  };
  const juristic = (extra: object = {}) => ({
    legalName: `หจก. สเต็ปอัพ ${++seed}`,
    entityType: 'JURISTIC',
    taxId: jurTax(20_000 + seed),
    ...extra,
  });
  const BANK = { bankCode: 'KBANK', accountNo: '1234567891', accountName: 'หจก. สเต็ปอัพ' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท สเต็ปอัพ' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    userId = (
      await db.appUser.create({
        data: { tenantId, email: 'owner@d67.test', name: 'เจ้าของ', status: 'ACTIVE' },
      })
    ).id;
    admin = await tokenFor(tenantId, '*', userId);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });

  it('route ที่ต้อง step-up ทุกครั้ง: ไม่ส่ง / token ของคนอื่น / ของ tenant อื่น / ปลอม → 403 step_up_required', async () => {
    const fake = (kind: string) => encodeId(kind, randomUUID());
    const routes: ['post' | 'put', string][] = [
      ['post', '/v1/api-keys'],
      ['post', `/v1/api-keys/${fake('apiKey')}/rotate`],
      ['post', '/v1/webhooks'],
      ['post', `/v1/webhooks/${fake('webhookEndpoint')}/rotate-secret`],
      ['put', `/v1/connectors/${fake('connector')}/credentials`],
      ['post', `/v1/connectors/${fake('connector')}/inbound-token/rotate`],
      ['post', `/v1/invoices/${fake('invoice')}/void`],
    ];
    const bad = [
      undefined,
      await signStepUpToken(randomUUID(), tenantId),
      await signStepUpToken(userId, otherId),
      'not-a-token',
    ];
    for (const [m, url] of routes)
      for (const su of bad) {
        const r = await raw(m, url, su).send({});
        expect(r.status, `${m} ${url}`).toBe(403);
        expect(r.body.code, `${m} ${url}`).toBe('step_up_required');
      }
    // token ของตัวเอง → ผ่านด่าน (สร้าง key ได้ · id ปลอม = 404 ตามปกติ)
    const ok = await raw('post', '/v1/api-keys', await mine()).send({
      name: 'ด้วย step-up',
      scopes: ['orders:read'],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    for (const [m, url] of routes.slice(1)) {
      const r = await raw(m, url, await mine()).send({});
      expect(r.body.code, `${m} ${url}`).not.toBe('step_up_required');
    }
  });

  it('API key: route ที่ key เข้าได้คุมด้วย scope (ไม่ถาม step-up) — ยกเลิกใบแจ้งหนี้ / ส่งออกทั้งตาราง / บัญชีธนาคาร', async () => {
    const k = await keyOf([
      'invoices:read',
      'invoices:void',
      'export:run',
      'master:read',
      'master:write',
      'settlements:pay',
    ]);
    const byKey = (m: 'get' | 'post', url: string) =>
      request(srv())[m](url).set('Authorization', `Bearer ${k}`);
    const v = await byKey('post', `/v1/invoices/${encodeId('invoice', randomUUID())}/void`)
      .set('If-Match', '"1"')
      .send({ reason: 'ทดสอบยกเลิกด้วย key' });
    expect(v.status).toBe(404); // ผ่านด่าน step-up/สิทธิ์ ไปถึงการหาใบ
    await byKey('get', '/v1/customers/export').expect(200);
    const c = await byKey('post', '/v1/carriers').send(juristic({ bankAccount: BANK }));
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const rv = await byKey('post', `/v1/carriers/${c.body.id}/reveal`).send({
      field: 'bankAccountNo',
      reason: 'ตรวจเลขบัญชีก่อนโอน',
    });
    expect(rv.status).toBe(200);
    expect(rv.body.value).toBe(BANK.accountNo);
    // key จัดการ API key / webhook / connector ไม่ได้อยู่แล้ว (settings:write ห้ามให้ key)
    const kk = await byKey('post', '/v1/api-keys').send({ name: 'x', scopes: [] });
    expect(kk.status).toBe(403);
  });

  it('บัญชีธนาคารรถร่วม: เปลี่ยนจริงต้อง step-up · ส่งค่าเดิม/ไม่แตะบัญชีไม่ต้อง · ดูเลขบัญชีเต็มต้อง step-up', async () => {
    const no = await raw('post', '/v1/carriers').send(juristic({ bankAccount: BANK }));
    expect(no.status).toBe(403);
    expect(no.body.code).toBe('step_up_required');
    // ไม่มีบัญชี = ไม่ต้อง step-up
    await raw('post', '/v1/carriers').send(juristic()).expect(201);
    const c = (
      await raw('post', '/v1/carriers', await mine())
        .send(juristic({ bankAccount: BANK }))
        .expect(201)
    ).body;
    const url = `/v1/carriers/${c.id}`;
    // แก้ช่องอื่น / ส่งบัญชีเดิมซ้ำ (เลขเดิม) → ไม่ต้อง step-up
    await raw('patch', url).send({ phone: '081-000-1111' }).expect(200);
    await raw('patch', url).send({ bankAccount: BANK }).expect(200);
    await raw('patch', url)
      .send({ bankAccount: { bankCode: BANK.bankCode, accountName: BANK.accountName } })
      .expect(200);
    // เปลี่ยนชื่อบัญชี / เลข / ธนาคาร / ลบ → ต้อง step-up
    for (const bankAccount of [
      { ...BANK, accountName: 'ชื่ออื่น' },
      { ...BANK, accountNo: '9876543210' },
      { bankCode: 'SCB', accountName: BANK.accountName },
      null,
    ]) {
      const r = await raw('patch', url).send({ bankAccount });
      expect(r.status, JSON.stringify(bankAccount)).toBe(403);
      expect(r.body.code).toBe('step_up_required');
    }
    await raw('patch', url, await mine())
      .send({ bankAccount: { ...BANK, accountNo: '9876543210' } })
      .expect(200);
    // ดูเลขเต็ม: บัญชี → step-up · เลขผู้เสียภาษี → ตามเดิม
    const rv = { field: 'bankAccountNo', reason: 'ตรวจเลขบัญชีก่อนโอน' };
    const r1 = await raw('post', `${url}/reveal`).send(rv);
    expect(r1.status).toBe(403);
    expect(r1.body.code).toBe('step_up_required');
    const r2 = await raw('post', `${url}/reveal`, await mine())
      .send(rv)
      .expect(200);
    expect(r2.body.value).toBe('9876543210');
    await raw('post', `${url}/reveal`)
      .send({ field: 'taxId', reason: 'ตรวจเลขผู้เสียภาษี' })
      .expect(200);
  });

  it('ส่งออกทั้งบริษัท: ไม่มีตัวกรอง / accounting-* ต้อง step-up · กรองแล้วไม่ต้อง', async () => {
    for (const q of ['', '?format=csv', '?name=']) {
      const r = await raw('get', `/v1/customers/export${q}`);
      expect(r.status, q).toBe(403);
      expect(r.body.code).toBe('step_up_required');
    }
    await raw('get', '/v1/customers/export?name=ขนส่ง').expect(200);
    await raw('get', '/v1/customers/export', await mine()).expect(200);

    const job = (body: object, su?: string) => raw('post', '/v1/exports', su).send(body);
    const whole = await job({ resource: 'customers' });
    expect(whole.status).toBe(403);
    expect(whole.body.code).toBe('step_up_required');
    expect((await job({ resource: 'customers', filter: { name: '' } })).status).toBe(403);
    expect((await job({ resource: 'customers', filter: { name: 'ขนส่ง' } })).status).toBe(202);
    const acc = { dateFrom: '2026-11-01', dateTo: '2026-11-30' };
    const a = await job({ resource: 'accounting-sales', format: 'csv', filter: acc });
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('step_up_required');
    const ok = await job(
      { resource: 'accounting-sales', format: 'csv', filter: acc },
      await mine(),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
  });

  it('connector: สร้างพร้อม credential ต้อง step-up (ไม่มี credential ไม่ต้อง — ไปตกด่านอื่นตามปกติ)', async () => {
    const r = await raw('post', '/v1/connectors').send({
      adapterKey: 'no-such-adapter',
      credentials: { apiKey: 'secret-value' },
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('step_up_required');
    const n = await raw('post', '/v1/connectors').send({ adapterKey: 'no-such-adapter' });
    expect(n.body.code).not.toBe('step_up_required');
  });

  it('OpenAPI: route D-67 ประกาศ header X-Step-Up + ตัวอย่าง 403 step_up_required', async () => {
    const doc = (await request(srv()).get('/v1/openapi.json').expect(200)).body as {
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: { name?: string; in?: string }[];
            responses: Record<string, { content?: Record<string, { examples?: object }> }>;
          }
        >
      >;
    };
    const ops: [string, string][] = [
      ['/v1/api-keys', 'post'],
      ['/v1/api-keys/{id}/rotate', 'post'],
      ['/v1/webhooks', 'post'],
      ['/v1/webhooks/{id}/rotate-secret', 'post'],
      ['/v1/connectors', 'post'],
      ['/v1/connectors/{id}/credentials', 'put'],
      ['/v1/connectors/{id}/inbound-token/rotate', 'post'],
      ['/v1/carriers', 'post'],
      ['/v1/carriers/{id}', 'patch'],
      ['/v1/carriers/{id}/reveal', 'post'],
      ['/v1/carriers/export', 'get'],
      ['/v1/exports', 'post'],
      ['/v1/invoices/{id}/void', 'post'],
      ['/v1/billing-notes/{id}/cancel', 'post'],
      ['/v1/imports/{id}/commit', 'post'],
    ];
    for (const [p, m] of ops) {
      const op = doc.paths[p]?.[m];
      expect(op, `${m} ${p}`).toBeDefined();
      expect(
        op!.parameters?.some((x) => x.in === 'header' && x.name === 'X-Step-Up'),
        `${m} ${p}`,
      ).toBe(true);
      const ex = op!.responses['403']?.content?.['application/problem+json']?.examples ?? {};
      expect(Object.keys(ex), `${m} ${p}`).toContain('step_up_required');
    }
  });
});
