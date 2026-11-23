import type { NestExpressApplication } from '@nestjs/platform-express';
import Ajv from 'ajv';
import { ACTIVE_EVENT_TYPES, PENDING_EVENT_TYPES, strictEventSchema } from '@tms/domain';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import {
  eventSample,
  eventSchemaComponents,
  publishedEventSchema,
} from '../src/modules/webhooks/event-openapi';
import { verifyWebhookSignature } from '../src/modules/webhooks/signature';
import { WebhookEngine } from '../src/modules/webhooks/webhook-engine';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

interface Hit {
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * ST7-T09 Sandbox (docs/04 G1 "Sandbox"; spec/07 INT-061)
 * เกณฑ์ตรวจรับ: key test มองไม่เห็นข้อมูล live · trigger event จำลองแล้ว webhook ถูกส่ง
 */
describe('sandbox (ST7-T09)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let liveId: string;
  let admin: string;
  let userId: string;
  let server: Server;
  let port = 0;
  const hits: Hit[] = [];
  const srv = () => app.getHttpServer();
  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const sbx = (r: request.Test) => r.set('X-Tms-Mode', 'test');

  const drain = async () => {
    const dispatcher = app.get(OutboxDispatcher);
    let n = 0;
    for (let i = 0; i < 10; i++) {
      await db.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
      const k = await dispatcher.drain();
      n += k;
      if (!k) break;
    }
    return n;
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    app.get(WebhookEngine).sendOptions = { allowPrivate: true };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    port = (server.address() as AddressInfo).port;
    liveId = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง จริง' })).id;
    userId = (
      await db.appUser.create({
        data: { tenantId: liveId, email: 'dev@live.test', name: 'นักพัฒนา จริง', status: 'ACTIVE' },
      })
    ).id;
    admin = await tokenFor(liveId, '*', userId);
  });
  afterAll(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
    await app?.close();
    await db.$disconnect();
  });

  async function testKey(scopes: string[], name = `sandbox ${scopes.join(' ')}`) {
    const r = await sbx(api(app, admin).post('/v1/api-keys')).send({ name, mode: 'test', scopes });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string; secret: string; mode: string; createdByName: string };
  }

  it('สลับโหมด Sandbox ครั้งแรก = สร้าง tenant mode test ผูกบริษัทจริง (1:1) · ค่าเริ่มต้นครบ · Console ไม่เห็น', async () => {
    const [a, b] = await Promise.all([
      sbx(api(app, admin).get('/v1/api-keys')).expect(200),
      sbx(api(app, admin).get('/v1/webhooks')).expect(200),
    ]);
    expect(a.body.data).toEqual([]);
    expect(b.body.data).toEqual([]);
    const sb = await db.tenant.findMany({ where: { liveTenantId: liveId } });
    expect(sb).toHaveLength(1);
    expect(sb[0]).toMatchObject({ mode: 'test', status: 'ACTIVE', planCode: 'std' });
    expect(await db.documentSeries.count({ where: { tenantId: sb[0]!.id } })).toBeGreaterThan(0);
    // แก้ mode/ผูกใหม่ไม่ได้ · sandbox ซ้อน sandbox ไม่ได้
    await expect(
      db.tenant.update({ where: { id: sb[0]!.id }, data: { mode: 'live', liveTenantId: null } }),
    ).rejects.toThrow();
    await expect(
      db.tenant.create({ data: { name: 'x', mode: 'test', liveTenantId: sb[0]!.id } }),
    ).rejects.toThrow();
    // header ผิดรูปแบบ → 400 · route ที่ไม่ใช่หน้า นักพัฒนา ไม่สนใจ header (ยังเป็น live)
    await api(app, admin).get('/v1/api-keys').set('X-Tms-Mode', 'prod').expect(400);
    await db.company.create({
      data: { tenantId: liveId, legalName: 'บริษัท จริง จำกัด', taxId: validTaxId(11) },
    });
    const co = await sbx(api(app, admin).get('/v1/companies')).expect(200);
    expect(co.body.data.length).toBe(1);
  });

  it('key test: prefix tk_test_ อยู่ในแถว sandbox · รายการ live ไม่เห็น key test · ไม่ตรงโหมด → 422', async () => {
    const k = await testKey(['orders:read']);
    expect(k.secret).toMatch(/^tk_test_[0-9a-f]{48}$/);
    expect(k.mode).toBe('test');
    expect(k.createdByName).toBe('นักพัฒนา จริง');
    const row = await db.apiKey.findUniqueOrThrow({ where: { id: tryDecodeId('apiKey', k.id)! } });
    const sb = await db.tenant.findUniqueOrThrow({ where: { liveTenantId: liveId } });
    expect(row.tenantId).toBe(sb.id);
    const live = (await api(app, admin).get('/v1/api-keys').expect(200)).body.data;
    expect(live.map((x: { id: string }) => x.id)).not.toContain(k.id);
    await api(app, admin).get(`/v1/api-keys/${k.id}`).expect(404);
    expect((await sbx(api(app, admin).get(`/v1/api-keys/${k.id}`)).expect(200)).body.id).toBe(k.id);
    // mode ไม่ตรงกับโหมดที่เลือก → 422 mode_mismatch (ไม่ย้าย tenant ให้เงียบ ๆ)
    const a = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'ผิดโหมด', mode: 'test', scopes: ['orders:read'] });
    expect(a.status).toBe(422);
    expect(a.body.errors[0].code).toBe('mode_mismatch');
    const b = await sbx(api(app, admin).post('/v1/api-keys')).send({
      name: 'ผิดโหมด',
      mode: 'live',
      scopes: ['orders:read'],
    });
    expect(b.status).toBe(422);
    // ไม่ส่ง mode ในโหมด Sandbox = test
    const c = await sbx(api(app, admin).post('/v1/api-keys'))
      .send({ name: 'ค่าเริ่ม', scopes: ['orders:read'] })
      .expect(201);
    expect(c.body.secret).toMatch(/^tk_test_/);
  });

  it('เกณฑ์ตรวจรับ: key test มองไม่เห็นข้อมูล live (รายการ/ดูตาม id/ext: = 404) และสิ่งที่สร้างด้วย key test ไม่โผล่ใน live', async () => {
    const liveCust = await db.customer.create({
      data: {
        tenantId: liveId,
        code: 'LIVE-1',
        legalName: 'ลูกค้าจริง',
        taxId: validTaxId(21),
        externalId: 'ERP-LIVE-1',
      },
    });
    const liveKey = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'live อ่าน', scopes: ['master:read', 'master:write'] })
      .expect(201);
    const k = await testKey(['master:read', 'master:write'], 'sandbox ลูกค้า');
    const liveId_ = `cus_${liveCust.id.replace(/-/g, '')}`;
    // live key เห็น
    const lr = await request(srv())
      .get('/v1/customers')
      .set(bearer(liveKey.body.secret))
      .expect(200);
    expect(lr.body.data.map((c: { code: string }) => c.code)).toContain('LIVE-1');
    // test key ไม่เห็น
    const tr = await request(srv()).get('/v1/customers').set(bearer(k.secret)).expect(200);
    expect(tr.body.data).toEqual([]);
    await request(srv()).get(`/v1/customers/${liveId_}`).set(bearer(k.secret)).expect(404);
    await request(srv()).get('/v1/customers/ext:ERP-LIVE-1').set(bearer(k.secret)).expect(404);
    // header X-Tms-Mode ของ key ไม่มีผล (โหมดตาม key) — key live + header test ยังเห็น live, key test + live ยังเป็น sandbox
    const lh = await request(srv())
      .get('/v1/api-keys')
      .set(bearer(liveKey.body.secret))
      .set('X-Tms-Mode', 'test');
    expect(lh.status).toBe(403); // จัดการ key ต้องเป็นผู้ใช้ (ST7-T01) — ไม่ได้สลับ tenant
    // สร้างด้วย key test → อยู่ใน sandbox เท่านั้น
    const created = await request(srv())
      .post('/v1/customers')
      .set(bearer(k.secret))
      .send({ code: 'SBX-1', legalName: 'ลูกค้าทดสอบ', taxId: validTaxId(22) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const lr2 = await request(srv())
      .get('/v1/customers')
      .set(bearer(liveKey.body.secret))
      .expect(200);
    expect(lr2.body.data.map((c: { code: string }) => c.code)).not.toContain('SBX-1');
    await request(srv())
      .get(`/v1/customers/${created.body.id}`)
      .set(bearer(liveKey.body.secret))
      .expect(404);
    const rows = await db.customer.findMany({ where: { code: 'SBX-1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).not.toBe(liveId);
  });

  it('บริษัทจริงถูกระงับ → key test หยุดด้วย · แพ็กเกจไม่มี Open API → key test 403', async () => {
    const k = await testKey(['orders:read'], 'sandbox สถานะ');
    await request(srv()).get('/v1/orders').set(bearer(k.secret)).expect(200);
    const ent = app.get(EntitlementService);
    await db.tenant.update({ where: { id: liveId }, data: { status: 'SUSPENDED' } });
    try {
      ent.invalidate();
      await request(srv()).get('/v1/orders').set(bearer(k.secret)).expect(401);
    } finally {
      await db.tenant.update({ where: { id: liveId }, data: { status: 'TRIAL' } });
      ent.invalidate();
    }
    await db.tenant.update({ where: { id: liveId }, data: { planCode: 'start' } });
    try {
      ent.invalidate();
      const r = await request(srv()).get('/v1/orders').set(bearer(k.secret));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('feature_not_in_plan');
    } finally {
      await db.tenant.update({ where: { id: liveId }, data: { planCode: 'std' } });
      ent.invalidate();
    }
    await request(srv()).get('/v1/orders').set(bearer(k.secret)).expect(200);
  });

  it('เกณฑ์ตรวจรับ: trigger event จำลอง → webhook ของ sandbox ถูกส่งจริง (ลายเซ็นถูก, mode test) · webhook live ไม่ได้รับ', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    let sbHook: { id: string; secret: string };
    try {
      sbHook = (
        await sbx(api(app, admin).post('/v1/webhooks'))
          .send({ url: `http://127.0.0.1:${port}/sandbox`, events: ['order.created'] })
          .expect(201)
      ).body;
      await api(app, admin)
        .post('/v1/webhooks')
        .send({ url: `http://127.0.0.1:${port}/live`, events: ['order.created'] })
        .expect(201);
    } finally {
      delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    }
    // รายการ webhook แยกตามโหมด
    const lw = (await api(app, admin).get('/v1/webhooks').expect(200)).body.data;
    const sw = (await sbx(api(app, admin).get('/v1/webhooks')).expect(200)).body.data;
    expect(lw.map((x: { url: string }) => x.url)).toEqual([`http://127.0.0.1:${port}/live`]);
    expect(sw.map((x: { url: string }) => x.url)).toEqual([`http://127.0.0.1:${port}/sandbox`]);
    expect(sw[0].createdByName).toBe('นักพัฒนา จริง');
    await drain(); // verification ของทั้งสอง endpoint
    hits.length = 0;

    const k = await testKey(['settings:read'], 'sandbox trigger');
    const r = await request(srv())
      .post('/v1/test/events/trigger')
      .set(bearer(k.secret))
      .send({ type: 'order.created' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ type: 'order.created', mode: 'test', queued: 1 });
    expect(r.body.eventId).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(r.body.deliveries).toEqual([
      expect.objectContaining({ endpointId: sbHook!.id, state: 'delivered', status: 200 }),
    ]);
    expect(hits.map((h) => h.headers['x-tms-event'])).toEqual(['order.created']);
    const hit = hits[0]!;
    expect(hit.headers['x-tms-event-id']).toBe(r.body.eventId);
    const env = JSON.parse(hit.body);
    expect(env).toMatchObject({ type: 'order.created', mode: 'test', id: r.body.eventId });
    expect(env.data.object).toEqual(r.body.object);
    // ตัวอย่างใกล้ของจริง (QA L1): id รูปจริง ใหม่ทุกครั้ง · array มีรายการ
    expect(r.body.object.id).toMatch(/^ord_[0-9a-f]{32}$/);
    expect(r.body.object.stops.length).toBeGreaterThan(0);
    expect(
      verifyWebhookSignature({
        secret: sbHook!.secret,
        header: String(hit.headers['x-tms-signature']),
        rawBody: hit.body,
      }).ok,
    ).toBe(true);
    // ประวัติการส่งของ sandbox
    const del = await sbx(
      api(app, admin).get(`/v1/webhook-deliveries?eventId=${r.body.eventId}`),
    ).expect(200);
    expect(del.body.data).toHaveLength(1);
    expect(del.body.data[0].status).toBe('delivered');
    const liveDel = await api(app, admin)
      .get(`/v1/webhook-deliveries?eventId=${r.body.eventId}`)
      .expect(200);
    expect(liveDel.body.data).toEqual([]);
    // ผู้ใช้ในโหมด Sandbox ยิงได้ · audit ลงใน sandbox
    const u = await sbx(api(app, admin).post('/v1/test/events/trigger')).send({
      type: 'trip.dispatched',
    });
    expect(u.status).toBe(200);
    expect(u.body.queued).toBe(0); // ไม่มี endpoint สมัคร
    const sb = await db.tenant.findUniqueOrThrow({ where: { liveTenantId: liveId } });
    expect(
      await db.auditLog.count({ where: { tenantId: sb.id, action: 'sandbox.event_triggered' } }),
    ).toBe(2);
  });

  it('trigger: live → 403 sandbox_only · event ไม่อยู่ในทะเบียน/pending → 422 · ไม่มี scope → 403', async () => {
    const live = await api(app, admin)
      .post('/v1/test/events/trigger')
      .send({ type: 'order.created' });
    expect(live.status).toBe(403);
    expect(live.body.code).toBe('sandbox_only');
    const liveKey = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'live trigger', scopes: ['settings:read'] })
      .expect(201);
    const lk = await request(srv())
      .post('/v1/test/events/trigger')
      .set(bearer(liveKey.body.secret))
      .set('X-Tms-Mode', 'test')
      .send({ type: 'order.created' });
    expect(lk.status).toBe(403);
    expect(lk.body.code).toBe('sandbox_only');
    await sbx(api(app, admin).post('/v1/test/events/trigger'))
      .send({ type: 'order.nope' })
      .expect(422);
    await sbx(api(app, admin).post('/v1/test/events/trigger'))
      .send({ type: PENDING_EVENT_TYPES[0] })
      .expect(422);
    await sbx(api(app, admin).post('/v1/test/events/trigger'))
      .send({ type: 'webhook.test' })
      .expect(422);
    const k = await testKey(['orders:read'], 'sandbox no scope');
    await request(srv())
      .post('/v1/test/events/trigger')
      .set(bearer(k.secret))
      .send({ type: 'order.created' })
      .expect(403);
  });

  it('review M1/M2/L5: connector ใน sandbox ใช้ได้เฉพาะ DemoProvider (D-81 · D68-58) · อีเมล/ข้อความไม่ส่งจริง · rate limit ตามแพ็กเกจบริษัทจริง · audit การสร้าง', async () => {
    // D-81 · D68-58/96 (เดิม ST7-T09 = 403 ทั้งหมด): sandbox เห็น/ใช้ connector ของ sandbox เอง — catalog มีเฉพาะ demo
    const k = await testKey(['settings:read'], 'sandbox connector');
    const c = await request(srv()).get('/v1/connectors').set(bearer(k.secret));
    expect(c.status).toBe(200);
    expect(c.body.data).toEqual([]);
    const cat = await request(srv()).get('/v1/connectors/adapters').set(bearer(k.secret));
    expect(cat.status).toBe(200);
    expect((cat.body.data ?? cat.body).every((a: { demo: boolean }) => a.demo)).toBe(true);
    // ST7-T15 รหัสรถร่วมในระบบบัญชี (external_mapping CARRIER) — route ใช้ได้ใน sandbox (รถร่วมของบริษัทจริงไม่อยู่ใน sandbox = 404)
    const km = await testKey(['master:read'], 'sandbox carrier erp codes');
    const ec = await request(srv())
      .get('/v1/carriers/car_00000000000040008000000000000001/erp-codes')
      .set(bearer(km.secret));
    expect(ec.status).toBe(404);
    // route connector เป็น @SandboxAware แล้ว — ผู้ใช้สลับโหมดด้วย header ได้ (ไม่มี header = บริษัทจริง)
    expect((await sbx(api(app, admin).get('/v1/connectors'))).status).toBe(200);
    expect((await api(app, admin).get('/v1/connectors')).status).not.toBe(403);
    const real = await sbx(api(app, admin).post('/v1/connectors')).send({
      taxDocumentOwner: 'TMS',
      adapterKey: 'krs',
      settings: { baseUrl: 'https://erp.example.com/api' },
      credentials: { apiKey: 'x' },
    });
    expect(real.status).toBe(403);
    expect(real.body.code).toBe('sandbox_unsupported');
    const sb = await db.tenant.findUniqueOrThrow({ where: { liveTenantId: liveId } });
    // อีเมลของ sandbox ไม่ส่งจริง
    const { EmailDispatcher } = await import('../src/modules/email/email.service');
    const sent: string[] = [];
    const ed = app.get(EmailDispatcher);
    ed.use({ send: async (m: { to: string }) => (sent.push(m.to), { messageId: 'x' }) } as never);
    await db.emailOutbox.create({
      data: {
        tenantId: sb.id,
        toAddress: 'customer@example.com',
        template: 'notification',
        locale: 'th',
        subject: 's',
        textBody: 't',
        htmlBody: 'h',
      },
    });
    await ed.drain();
    expect(sent).toEqual([]);
    const row = await db.emailOutbox.findFirstOrThrow({ where: { tenantId: sb.id } });
    expect(row).toMatchObject({ status: 'FAILED', error: 'sandbox_suppressed' });
    // rate limit: โปรไฟล์ของ sandbox ตามบริษัทจริงปัจจุบัน
    const { RateLimitService } = await import('../src/http/rate-limit/rate-limit.service');
    const rl = app.get(RateLimitService);
    await db.tenant.update({ where: { id: liveId }, data: { rateLimitProfile: 'high' } });
    try {
      rl.invalidateProfile(liveId);
      const { profileOf } = await import('../src/http/rate-limit/profiles');
      expect(await rl.profile(sb.id)).toEqual(profileOf('high'));
      expect(sb.rateLimitProfile).toBeNull();
    } finally {
      await db.tenant.update({ where: { id: liveId }, data: { rateLimitProfile: null } });
      rl.invalidateProfile();
    }
    // audit การสร้าง sandbox อยู่ที่บริษัทจริง
    const a = await db.auditLog.findFirst({
      where: { tenantId: liveId, action: 'sandbox.created' },
    });
    expect(a).toMatchObject({ entityId: sb.id, actorId: userId });
  });

  it('payload จำลองของทุก event ที่ active ตรง schema ที่เผยแพร่ (แบบปิด)', async () => {
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    const comps = Object.fromEntries(
      Object.entries(eventSchemaComponents()).map(([k, v]) => [
        k,
        jsonSchema(strictEventSchema(v)),
      ]),
    );
    for (const type of ACTIVE_EVENT_TYPES) {
      const s = publishedEventSchema(type);
      expect(s, type).not.toBeNull();
      const v = ajv.compile({
        ...(jsonSchema(strictEventSchema(s!)) as object),
        components: { schemas: comps },
      });
      expect(v(eventSample(type)), `${type}: ${ajv.errorsText(v.errors)}`).toBe(true);
    }
  });
});

/** OpenAPI 3.0 `nullable` → JSON Schema (เหมือน event-contract.test.ts) */
function jsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(jsonSchema);
  if (!s || typeof s !== 'object') return s;
  const o = Object.fromEntries(
    Object.entries(s as Record<string, unknown>).map(([k, v]) => [
      k,
      k === 'properties'
        ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, jsonSchema(pv)]))
        : jsonSchema(v),
    ]),
  ) as Record<string, unknown>;
  if (o.nullable !== true) return o;
  const { nullable: _n, ...rest } = o;
  return { anyOf: [rest, { type: 'null' }] };
}
