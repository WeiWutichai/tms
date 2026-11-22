import { RateLimitService } from '../src/http/rate-limit/rate-limit.service';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WEBHOOK_RETRY_SCHEDULE_MIN } from '@tms/domain';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { DbService, type Tx } from '../src/db/db.service';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { verifyWebhookSignature } from '../src/modules/webhooks/signature';
import { WebhookEngine } from '../src/modules/webhooks/webhook-engine';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

interface Hit {
  headers: IncomingHttpHeaders;
  body: string;
  at: number;
}

/** ปลายทางทดสอบในเครื่อง — `reply` กำหนดคำตอบ (status/body/หน่วง/redirect) */
class Receiver {
  hits: Hit[] = [];
  reply: (h: Hit) => {
    status?: number;
    body?: string;
    delayMs?: number;
    headers?: Record<string, string>;
  } = () => ({
    status: 200,
    body: '{"received":true}',
  });
  private server!: Server;
  port = 0;
  async start() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const hit = {
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          at: Date.now(),
        };
        this.hits.push(hit);
        const r = this.reply(hit);
        const send = () => {
          if (res.destroyed) return;
          res.writeHead(r.status ?? 200, {
            'content-type': 'application/json',
            ...(r.headers ?? {}),
          });
          res.end(r.body ?? '');
        };
        if (r.delayMs) setTimeout(send, r.delayMs);
        else send();
      });
    });
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', ok));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  url(path = '/hook') {
    return `http://127.0.0.1:${this.port}${path}`;
  }
  reset() {
    this.hits = [];
    this.reply = () => ({ status: 200, body: '{"received":true}' });
  }
  close() {
    this.server.closeAllConnections?.();
    return new Promise<void>((ok) => this.server.close(() => ok()));
  }
}

/**
 * ST7-T04 Webhook dispatcher (docs/04 G1 Webhook; docs/01 §3.7, §5.3; spec/07 §10)
 * เกณฑ์ตรวจรับ: endpoint ทดสอบตรวจลายเซ็นผ่าน · endpoint ที่ตอบ 500 ถูก retry ตามตาราง 8 ครั้งแล้วเป็น EXHAUSTED
 */
describe('webhooks (ST7-T04)', () => {
  let app: NestExpressApplication;
  const plat = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  let engine: WebhookEngine;
  const rx = new Receiver();
  let tenantId: string;
  let token: string;
  let userId: string;

  const emit = (t: string, type: string, snapshot: object = {}) =>
    db.withTenant(t, (tx: Tx) =>
      tx.domainEvent.create({
        data: {
          tenantId: t,
          type,
          entityType: type.split('.')[0]!,
          localId: randomUUID(),
          snapshot: snapshot as object,
          previousAttributes: { status: 'draft' },
          requestId: 'req_test',
        },
      }),
    );
  const due = () =>
    plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                      WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
  const drainAll = async () => {
    let n = 0;
    for (let i = 0; i < 20; i++) {
      await due();
      const k = await dispatcher.drain();
      n += k;
      if (!k) break;
    }
    return n;
  };
  /** สร้าง endpoint ผ่าน API (ปลายทางในเครื่อง = ต้องเปิด WEBHOOK_ALLOW_PRIVATE_TARGETS ตอนบันทึก) */
  async function createHook(body: Record<string, unknown>, tok = token) {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    try {
      const r = await api(app, tok).post('/v1/webhooks').send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as { id: string; secret: string; version: number; url: string };
    } finally {
      delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    }
  }
  const uuid = (id: string) => tryDecodeId('webhookEndpoint', id)!;
  /** ล้างตัวจำกัด "ส่ง event ทดสอบ" (1 ครั้ง/5 วิ ต่อ endpoint) ระหว่าง test */
  const resetTestLimits = () => app.get(RateLimitService).reset('wht:');
  /** ข้ามคำสั่ง verification ที่เกิดตอนสร้าง (test ส่วนใหญ่สนใจเฉพาะ event) */
  const skipVerification = () =>
    plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED'
                      WHERE operation = 'webhook.verification' AND status = 'PENDING'`;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    engine = app.get(WebhookEngine);
    await rx.start();
    tenantId = (await createTenant(plat, 'บริษัท เว็บฮุก')).id;
    userId = (
      await plat.appUser.create({
        data: { tenantId, email: 'dev@hook.test', name: 'นักพัฒนา ทดสอบ', status: 'ACTIVE' },
      })
    ).id;
    token = await tokenFor(tenantId, '*', userId);
  });
  beforeEach(async () => {
    rx.reset();
    await resetTestLimits();
    engine.sendOptions = { allowPrivate: true };
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    // endpoint จาก test ก่อนหน้า ไม่ให้นับ limit 3 ของแพ็กเกจมาตรฐาน
    await plat.webhookEndpoint.updateMany({
      where: { deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await plat.integrationSubscription.updateMany({
      where: { sink: 'webhook' },
      data: { active: false },
    });
  });
  afterEach(() => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  });
  afterAll(async () => {
    await rx.close();
    await app.close();
    await plat.$disconnect();
  });

  it('สร้าง: secret แสดงครั้งเดียว · เก็บเข้ารหัส · audit ไม่มี secret · subscription ตาม event · ซ้ำ URL → 409', async () => {
    const h = await createHook({
      url: rx.url(),
      events: ['order.created', 'trip.dispatched'],
      description: 'ERP ทดสอบ',
      extraHeaders: [{ name: 'X-Client-Id', value: 'secret-client-token' }],
    });
    expect(h.id).toMatch(/^whe_[0-9a-f]{32}$/);
    expect(h.secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
    const row = await plat.webhookEndpoint.findUniqueOrThrow({ where: { id: uuid(h.id) } });
    expect(row.secretEnc).not.toContain(h.secret.slice(6));
    expect(row.extraHeadersEnc).not.toContain('secret-client-token');
    expect(row.extraHeaderNames).toEqual(['X-Client-Id']);
    expect(row.events).toEqual(['order.created', 'trip.dispatched']);
    const sub = await plat.integrationSubscription.findUniqueOrThrow({
      where: { id: row.subscriptionId! },
    });
    expect(sub).toMatchObject({ kind: 'WEBHOOK', sink: 'webhook', targetId: row.id, active: true });
    expect(sub.eventTypes).toEqual(['order.created', 'trip.dispatched']);

    const got = await api(app, token).get(`/v1/webhooks/${h.id}`).expect(200);
    expect(got.body.secret).toBeUndefined();
    expect(got.body).toMatchObject({
      status: 'active',
      successRate7d: null,
      createdByName: 'นักพัฒนา ทดสอบ',
    });
    expect(JSON.stringify(got.body)).not.toContain('secret-client-token');

    const audit = await plat.auditLog.findMany({ where: { entityId: row.id } });
    expect(audit.map((a) => a.action)).toEqual(['webhook_endpoint.created']);
    const auditText = JSON.stringify(audit.map((a) => ({ before: a.before, after: a.after })));
    expect(auditText).not.toContain(h.secret.slice(6));
    expect(auditText).not.toContain('secret-client-token');

    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    const dup = await api(app, token)
      .post('/v1/webhooks')
      .send({ url: rx.url(), events: ['order.created'] });
    expect(dup.status).toBe(409);
  });

  it('validation: event ไม่รู้จัก / `*` / header สงวน → 422 · ไม่ใช่ https/IP ภายใน → 422', async () => {
    const bad = async (body: Record<string, unknown>, field: string, code?: string) => {
      const r = await api(app, token).post('/v1/webhooks').send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      const e = r.body.errors.find((x: { field: string }) => x.field.startsWith(field));
      expect(e, JSON.stringify(r.body)).toBeTruthy();
      if (code) expect(e.code).toBe(code);
    };
    const ok = 'https://hooks.example.com/tms';
    await bad({ url: ok, events: ['order.exploded'] }, 'events');
    await bad({ url: ok, events: ['*'] }, 'events');
    await bad({ url: ok, events: [] }, 'events');
    await bad(
      {
        url: ok,
        events: ['order.created'],
        extraHeaders: [{ name: 'X-TMS-Signature', value: 'x' }],
      },
      'extraHeaders',
      'reserved_header',
    );
    await bad(
      { url: ok, events: ['order.created'], extraHeaders: [{ name: 'Content-Type', value: 'x' }] },
      'extraHeaders',
      'reserved_header',
    );
    await bad(
      { url: 'ftp://hooks.example.com', events: ['order.created'] },
      'url',
      'https_required',
    );
    for (const u of [
      'https://127.0.0.1/h',
      'https://10.0.0.5/h',
      'http://169.254.169.254/latest/meta-data',
      'https://localhost/h',
      'https://[::1]/h',
    ])
      await bad({ url: u, events: ['order.created'] }, 'url', 'url_not_allowed');
    await bad(
      { url: 'https://user:pw@hooks.example.com/', events: ['order.created'] },
      'url',
      'credentials_in_url',
    );
  });

  it('เกณฑ์ตรวจรับ: event → ส่งพร้อม envelope + header มาตรฐาน · ผู้รับตรวจลายเซ็นด้วย secret ผ่าน · header เพิ่มเติมส่งไป', async () => {
    const h = await createHook({
      url: rx.url(),
      events: ['order.created'],
      extraHeaders: [{ name: 'X-Client-Id', value: 'erp-01' }],
    });
    await skipVerification();
    const ev = await emit(tenantId, 'order.created', {
      id: 'ord_1',
      customerId: null,
      status: 'confirmed',
    });
    await emit(tenantId, 'order.updated', { id: 'ord_1' }); // ไม่ได้สมัคร
    await drainAll();
    expect(rx.hits).toHaveLength(1);
    const hit = rx.hits[0]!;
    expect(hit.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(hit.headers['x-tms-event']).toBe('order.created');
    expect(hit.headers['x-tms-event-id']).toBe(`evt_${ev.id.replace(/-/g, '')}`);
    expect(hit.headers['x-tms-attempt']).toBe('1');
    expect(hit.headers['x-client-id']).toBe('erp-01');
    const t = Number(hit.headers['x-tms-timestamp']);
    expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(30);
    const sig = String(hit.headers['x-tms-signature']);
    expect(sig).toMatch(new RegExp(`^t=${t},v1=[0-9a-f]{64}$`));
    expect(verifyWebhookSignature({ secret: h.secret, header: sig, rawBody: hit.body })).toEqual({
      ok: true,
      t,
    });
    expect(
      verifyWebhookSignature({ secret: 'whsec_wrong', header: sig, rawBody: hit.body }).ok,
    ).toBe(false);
    const env = JSON.parse(hit.body);
    expect(env).toEqual({
      id: `evt_${ev.id.replace(/-/g, '')}`,
      type: 'order.created',
      version: '1',
      occurredAt: ev.occurredAt.toISOString(),
      tenantId: `ten_${tenantId.replace(/-/g, '')}`,
      mode: 'live',
      data: {
        object: { id: 'ord_1', customerId: null, status: 'confirmed' },
        previousAttributes: { status: 'draft' },
      },
      request: { id: 'req_test', idempotencyKey: null },
    });
    // บันทึกการส่ง: ไม่มีค่า header เพิ่มเติม/secret
    const d = await plat.webhookDelivery.findMany({ where: { endpointId: uuid(h.id) } });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      status: 'DELIVERED',
      attempt: 1,
      responseStatus: 200,
      test: false,
      eventId: ev.id,
    });
    expect((d[0]!.requestHeaders as Record<string, string>)['X-Client-Id']).toBe('***');
    expect(JSON.stringify(d[0])).not.toContain(h.secret);
    const g = await api(app, token).get(`/v1/webhooks/${h.id}`).expect(200);
    expect(g.body).toMatchObject({ status: 'active', successRate7d: 100, consecutiveFailures: 0 });
    expect(g.body.lastSuccessAt).toBeTruthy();
  });

  it('หมุน secret: 24 ชม. ส่ง v1 2 ตัว (ใหม่ + เดิม) ตรวจผ่านทั้งคู่ · หมดช่วงแล้วเหลือ 1 · audit', async () => {
    const h = await createHook({ url: rx.url(), events: ['trip.dispatched'] });
    await skipVerification();
    const r = await api(app, token)
      .post(`/v1/webhooks/${h.id}/rotate-secret`)
      .set('If-Match', `"${h.version}"`)
      .send({});
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const fresh = r.body.secret as string;
    expect(fresh).not.toBe(h.secret);
    expect(r.body.previousSecretExpiresAt).toBeTruthy();
    await emit(tenantId, 'trip.dispatched', { id: 'trp_1' });
    await drainAll();
    const hit = rx.hits[0]!;
    const sig = String(hit.headers['x-tms-signature']);
    expect(sig.match(/v1=/g)).toHaveLength(2);
    for (const s of [fresh, h.secret])
      expect(verifyWebhookSignature({ secret: s, header: sig, rawBody: hit.body }).ok).toBe(true);
    // หมดช่วง 24 ชม.
    await plat.webhookEndpoint.update({
      where: { id: uuid(h.id) },
      data: { secretPrevExpiresAt: new Date(Date.now() - 1000) },
    });
    rx.reset();
    await emit(tenantId, 'trip.dispatched', { id: 'trp_2' });
    await drainAll();
    const sig2 = String(rx.hits[0]!.headers['x-tms-signature']);
    expect(sig2.match(/v1=/g)).toHaveLength(1);
    expect(
      verifyWebhookSignature({ secret: h.secret, header: sig2, rawBody: rx.hits[0]!.body }).ok,
    ).toBe(false);
    expect(
      verifyWebhookSignature({ secret: fresh, header: sig2, rawBody: rx.hits[0]!.body }).ok,
    ).toBe(true);
    // stale If-Match → 412
    const stale = await api(app, token)
      .post(`/v1/webhooks/${h.id}/rotate-secret`)
      .set('If-Match', `"${h.version}"`)
      .send({});
    expect(stale.status).toBe(412);
    const acts = (
      await plat.auditLog.findMany({ where: { entityId: uuid(h.id) }, orderBy: { at: 'asc' } })
    ).map((a) => a.action);
    expect(acts).toEqual(['webhook_endpoint.created', 'webhook_endpoint.secret_rotated']);
  });

  it('เกณฑ์ตรวจรับ: ตอบ 500 → retry ตามตาราง 8 ครั้ง (รวม 9 ครั้ง) แล้ว EXHAUSTED · X-TMS-Attempt เพิ่ม · event id เดิม', async () => {
    const h = await createHook({ url: rx.url(), events: ['order.cancelled'] });
    await skipVerification();
    rx.reply = () => ({ status: 500, body: 'boom' });
    const ev = await emit(tenantId, 'order.cancelled', { id: 'ord_9' });
    const gaps: number[] = [];
    for (let i = 0; i < 12; i++) {
      await due();
      if (!(await dispatcher.drain())) break;
    }
    expect(rx.hits).toHaveLength(9);
    expect(rx.hits.map((x) => x.headers['x-tms-attempt'])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
    expect(new Set(rx.hits.map((x) => x.headers['x-tms-event-id']))).toEqual(
      new Set([`evt_${ev.id.replace(/-/g, '')}`]),
    );
    const d = await plat.webhookDelivery.findMany({
      where: { endpointId: uuid(h.id) },
      orderBy: { attempt: 'asc' },
    });
    expect(d.map((x) => x.status)).toEqual([...Array(8).fill('FAILED'), 'EXHAUSTED']);
    expect(d.every((x) => x.responseStatus === 500 && x.errorCode === 'http_status')).toBe(true);
    // next_retry_at ตามตาราง 1m, 5m, 30m, 2h, 6h, 12h, 24h, 24h (±10%)
    d.slice(0, 8).forEach((x, i) => {
      const gap = (x.nextRetryAt!.getTime() - x.sentAt.getTime()) / 60_000;
      gaps.push(gap);
      expect(gap).toBeGreaterThan(WEBHOOK_RETRY_SCHEDULE_MIN[i]! * 0.89);
      expect(gap).toBeLessThan(WEBHOOK_RETRY_SCHEDULE_MIN[i]! * 1.11 + 0.1);
    });
    expect(d[8]!.nextRetryAt).toBeNull();
    const ob = await plat.integrationOutbox.findFirstOrThrow({
      where: { eventId: ev.id, sink: 'webhook' },
    });
    expect(ob).toMatchObject({
      status: 'FAILED_FINAL',
      attempt: 9,
      maxAttempt: 9,
      errorClass: 'TRANSIENT',
    });
    const g = await api(app, token).get(`/v1/webhooks/${h.id}`).expect(200);
    expect(g.body).toMatchObject({ status: 'failing', consecutiveFailures: 1, successRate7d: 0 });
  });

  it('4xx (400/401/410) และ redirect 3xx ไม่ retry → EXHAUSTED ครั้งแรก · ไม่ follow redirect', async () => {
    const h = await createHook({ url: rx.url(), events: ['stop.arrived'] });
    await skipVerification();
    const cases: [number, Record<string, string>][] = [
      [400, {}],
      [401, {}],
      [410, {}],
      [302, { location: 'http://127.0.0.1:1/elsewhere' }],
    ];
    for (const [status, extra] of cases) {
      rx.reset();
      rx.reply = () => ({ status, headers: extra });
      await emit(tenantId, 'stop.arrived', { id: `stp_${status}` });
      await drainAll();
      expect(rx.hits, String(status)).toHaveLength(1);
    }
    const d = await plat.webhookDelivery.findMany({
      where: { endpointId: uuid(h.id) },
      orderBy: { sentAt: 'asc' },
    });
    expect(d.map((x) => [x.responseStatus, x.status, x.errorCode])).toEqual([
      [400, 'EXHAUSTED', 'http_status'],
      [401, 'EXHAUSTED', 'http_status'],
      [410, 'EXHAUSTED', 'http_status'],
      [302, 'EXHAUSTED', 'redirect'],
    ]);
    const e = await plat.webhookEndpoint.findUniqueOrThrow({ where: { id: uuid(h.id) } });
    expect(e.consecutiveFailures).toBe(4);
  });

  it('ส่งสำเร็จ = ตัวนับล้มเหลวกลับเป็น 0 · ล้มครบ 50 event ติด → AUTO_DISABLED + หยุดรับ event + audit + แจ้งอีเมลผู้ดูแล', async () => {
    const h = await createHook({
      url: rx.url(),
      events: ['trip.completed'],
      description: 'คลังบางนา',
    });
    await skipVerification();
    const id = uuid(h.id);
    await plat.webhookEndpoint.update({ where: { id }, data: { consecutiveFailures: 48 } });
    rx.reply = () => ({ status: 404 });
    await emit(tenantId, 'trip.completed', { id: 'trp_a' });
    await drainAll();
    expect(
      (await plat.webhookEndpoint.findUniqueOrThrow({ where: { id } })).consecutiveFailures,
    ).toBe(49);
    rx.reply = () => ({ status: 200 });
    await emit(tenantId, 'trip.completed', { id: 'trp_b' });
    await drainAll();
    expect(
      (await plat.webhookEndpoint.findUniqueOrThrow({ where: { id } })).consecutiveFailures,
    ).toBe(0);

    await plat.webhookEndpoint.update({ where: { id }, data: { consecutiveFailures: 49 } });
    rx.reply = () => ({ status: 404 });
    await emit(tenantId, 'trip.completed', { id: 'trp_c' });
    await drainAll();
    const e = await plat.webhookEndpoint.findUniqueOrThrow({ where: { id } });
    expect(e).toMatchObject({ status: 'AUTO_DISABLED', consecutiveFailures: 50 });
    expect(e.disabledReason).toContain('50');
    const sub = await plat.integrationSubscription.findFirstOrThrow({ where: { targetId: id } });
    expect(sub.active).toBe(false);
    const a = await plat.auditLog.findFirst({
      where: { entityId: id, action: 'webhook_endpoint.auto_disabled' },
    });
    expect(a?.actorId).toBeNull();
    const n = await plat.notification.findMany({
      where: { tenantId, templateCode: 'webhook.auto_disabled', channel: 'in_app' },
    });
    expect(n.length).toBeGreaterThan(0);
    expect(n.some((x) => x.recipientId === userId)).toBe(true); // ผู้สร้างได้แจ้งด้วย
    expect(n[0]!.body).toContain('คลังบางนา');
    const mails = await plat.emailOutbox.findMany({
      where: { tenantId, template: 'notification' },
    });
    expect(mails.some((m) => m.toAddress === 'dev@hook.test')).toBe(true);
    // ปิดแล้ว: event ใหม่ไม่เข้าคิว
    rx.reset();
    const ev = await emit(tenantId, 'trip.completed', { id: 'trp_d' });
    expect(await plat.integrationOutbox.count({ where: { eventId: ev.id, sink: 'webhook' } })).toBe(
      0,
    );
    const g = await api(app, token).get(`/v1/webhooks/${h.id}`).expect(200);
    expect(g.body.status).toBe('auto_disabled');
    // เปิดใช้อีกครั้ง → ตัวนับเริ่มใหม่ + รับ event
    const on = await api(app, token)
      .post(`/v1/webhooks/${h.id}/enable`)
      .set('If-Match', `"${g.body.version}"`)
      .send({});
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ status: 'active', consecutiveFailures: 0 });
    rx.reply = () => ({ status: 200 });
    await emit(tenantId, 'trip.completed', { id: 'trp_e' });
    await drainAll();
    expect(rx.hits).toHaveLength(1);
  });

  it('timeout: ปลายทางช้าเกินเวลา → timeout (retry) · ค่าเริ่ม 10 วิ', async () => {
    const { WEBHOOK_TIMEOUT_MS } = await import('../src/modules/webhooks/webhook-http');
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);
    const h = await createHook({ url: rx.url(), events: ['trip.started'] });
    await skipVerification();
    engine.sendOptions = { allowPrivate: true, timeoutMs: 300 };
    rx.reply = () => ({ status: 200, delayMs: 2000 });
    await emit(tenantId, 'trip.started', { id: 'trp_slow' });
    await due();
    const t0 = Date.now();
    await dispatcher.drain();
    expect(Date.now() - t0).toBeLessThan(1800);
    const d = await plat.webhookDelivery.findFirstOrThrow({ where: { endpointId: uuid(h.id) } });
    expect(d).toMatchObject({
      status: 'FAILED',
      responseStatus: null,
      errorCode: 'timeout',
      errorClass: 'TRANSIENT',
    });
    expect(d.durationMs).toBeLessThan(1500);
    expect(d.nextRetryAt).toBeTruthy();
  });

  it('response ใหญ่ > 64 KB: อ่านแค่ 64 KB แล้วถือว่าสำเร็จ · เก็บ 4 KB', async () => {
    const h = await createHook({ url: rx.url(), events: ['trip.assigned'] });
    await skipVerification();
    rx.reply = () => ({ status: 200, body: 'x'.repeat(200 * 1024) });
    await emit(tenantId, 'trip.assigned', { id: 'trp_big' });
    await drainAll();
    const d = await plat.webhookDelivery.findFirstOrThrow({ where: { endpointId: uuid(h.id) } });
    expect(d.status).toBe('DELIVERED');
    expect(d.responseBody!.length).toBe(4096);
  });

  it('SSRF ตอนส่ง: DNS ชี้ IP ภายใน (127.0.0.1 / 10.x / 169.254.169.254 / rebinding หลังบันทึก) → ssrf_blocked ไม่ส่ง ไม่ retry', async () => {
    // บันทึกตอน DNS ยังชี้ IP สาธารณะ/resolve ไม่ได้ แล้วชี้ภายในตอนส่ง (DNS rebinding)
    const h = await createHook({
      url: `http://rebind.invalid:${rx.port}/hook`,
      events: ['stop.departed'],
    });
    await skipVerification();
    for (const ip of ['127.0.0.1', '10.20.30.40', '169.254.169.254', '::1']) {
      engine.sendOptions = {
        allowPrivate: false,
        resolver: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: ip, family: ip.includes(':') ? 6 : 4 },
        ],
      };
      await emit(tenantId, 'stop.departed', { id: `stp_${ip}` });
      await drainAll();
    }
    expect(rx.hits).toHaveLength(0);
    const d = await plat.webhookDelivery.findMany({ where: { endpointId: uuid(h.id) } });
    expect(d).toHaveLength(4);
    expect(
      d.every((x) => x.status === 'EXHAUSTED' && x.errorCode === 'ssrf_blocked' && x.attempt === 1),
    ).toBe(true);
  });

  it('ต่อด้วย address ที่ตรวจแล้วเท่านั้น (pin): ชื่อโฮสต์ใด ๆ ถูกส่งไป IP ที่ resolver คืน ไม่ resolve ซ้ำ', async () => {
    const h = await createHook({
      url: `http://pinned.invalid:${rx.port}/hook`,
      events: ['stop.completed'],
    });
    await skipVerification();
    let calls = 0;
    engine.sendOptions = {
      allowPrivate: true,
      resolver: async () => {
        calls++;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    };
    await emit(tenantId, 'stop.completed', { id: 'stp_pin' });
    await drainAll();
    expect(rx.hits).toHaveLength(1);
    expect(rx.hits[0]!.headers.host).toBe(`pinned.invalid:${rx.port}`);
    expect(calls).toBe(1);
    const d = await plat.webhookDelivery.findFirstOrThrow({ where: { endpointId: uuid(h.id) } });
    expect(d.status).toBe('DELIVERED');
  });

  it('verification challenge: ส่งหลังบันทึก 1 ครั้ง → ผู้รับ echo → verifiedAt · ไม่ echo = ยังไม่ verified (ไม่บล็อก)', async () => {
    rx.reply = (hit) => {
      const env = JSON.parse(hit.body);
      return env.type === 'webhook.verification'
        ? { status: 200, body: JSON.stringify({ challenge: env.data.object.challenge }) }
        : { status: 200 };
    };
    const h = await createHook({ url: rx.url(), events: ['order.held'] });
    await drainAll();
    expect(rx.hits).toHaveLength(1);
    expect(rx.hits[0]!.headers['x-tms-event']).toBe('webhook.verification');
    const env = JSON.parse(rx.hits[0]!.body);
    expect(env.test).toBe(true);
    expect(env.data.object.challenge).toMatch(/^[0-9a-f]{32}$/);
    expect(
      verifyWebhookSignature({
        secret: h.secret,
        header: String(rx.hits[0]!.headers['x-tms-signature']),
        rawBody: rx.hits[0]!.body,
      }).ok,
    ).toBe(true);
    const g = await api(app, token).get(`/v1/webhooks/${h.id}`).expect(200);
    expect(g.body.verifiedAt).toBeTruthy();
    expect(g.body.status).toBe('active'); // verification ไม่นับเป็นการส่ง event

    rx.reset();
    const h2 = await createHook({ url: rx.url('/other'), events: ['order.held'] });
    await drainAll();
    expect(rx.hits).toHaveLength(1);
    const g2 = await api(app, token).get(`/v1/webhooks/${h2.id}`).expect(200);
    expect(g2.body).toMatchObject({ verifiedAt: null, status: 'active' });
  });

  it('ส่ง event ทดสอบ (sync): webhook.test + test:true · ไม่นับอัตราสำเร็จ · endpoint ปิดอยู่ → 409 · ไม่มีสิทธิ์ → 403', async () => {
    const h = await createHook({ url: rx.url(), events: ['invoice.finalized', 'order.created'] });
    await skipVerification();
    const r = await api(app, token).post(`/v1/webhooks/${h.id}/test`).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ delivered: true, status: 200, errorCode: null });
    const env = JSON.parse(rx.hits[0]!.body);
    expect(env).toMatchObject({
      type: 'webhook.test',
      test: true,
      sampleEventType: 'invoice.finalized',
    });
    expect(env.data.object).not.toHaveProperty('sampleEventType');
    expect(
      verifyWebhookSignature({
        secret: h.secret,
        header: String(rx.hits[0]!.headers['x-tms-signature']),
        rawBody: rx.hits[0]!.body,
      }).ok,
    ).toBe(true);
    // ส่งทดสอบซ้ำภายใน 5 วิ → 429 (กันใช้เป็นเครื่องยิงคำขอ)
    const fast = await api(app, token).post(`/v1/webhooks/${h.id}/test`).send({});
    expect(fast.status).toBe(429);
    expect(fast.body.code).toBe('rate_limited');
    expect(rx.hits).toHaveLength(1);
    await resetTestLimits();
    rx.reply = () => ({ status: 503 });
    const f = await api(app, token)
      .post(`/v1/webhooks/${h.id}/test`)
      .send({ eventType: 'order.created' });
    expect(f.body).toMatchObject({ delivered: false, status: 503, errorCode: 'http_status' });
    const g = await api(app, token).get(`/v1/webhooks/${h.id}`).expect(200);
    expect(g.body).toMatchObject({ successRate7d: null, status: 'active', consecutiveFailures: 0 });
    const d = await plat.webhookDelivery.findMany({ where: { endpointId: uuid(h.id) } });
    expect(d.every((x) => x.test)).toBe(true);
    expect(d.map((x) => x.status).sort()).toEqual(['DELIVERED', 'EXHAUSTED']);

    const off = await api(app, token)
      .post(`/v1/webhooks/${h.id}/disable`)
      .set('If-Match', `"${g.body.version}"`)
      .send({ reason: 'ปิดชั่วคราวระหว่างย้ายระบบ' });
    expect(off.status).toBe(200);
    expect(off.body.status).toBe('disabled');
    expect((await api(app, token).post(`/v1/webhooks/${h.id}/test`).send({})).status).toBe(409);
    const viewer = await tokenFor(tenantId, 'settings:read', userId);
    expect((await api(app, viewer).get(`/v1/webhooks/${h.id}`)).status).toBe(200);
    expect((await api(app, viewer).post(`/v1/webhooks/${h.id}/test`).send({})).status).toBe(403);
    expect(
      (
        await api(app, viewer)
          .post('/v1/webhooks')
          .send({ url: 'https://a.example.com', events: ['order.created'] })
      ).status,
    ).toBe(403);
    const a = await plat.auditLog.findMany({
      where: { entityId: uuid(h.id) },
      orderBy: { at: 'asc' },
    });
    expect(a.map((x) => x.action)).toEqual([
      'webhook_endpoint.created',
      'webhook_endpoint.test_sent',
      'webhook_endpoint.test_sent',
      'webhook_endpoint.disabled',
    ]);
    expect(a[3]!.reason).toBe('ปิดชั่วคราวระหว่างย้ายระบบ');
  });

  it('ปิด endpoint ขณะมีคำสั่งค้าง → ข้าม (SKIPPED) ไม่ส่ง · ลบ → GET 404 · สถานะ/สรุปตามแท็บ · limit แพ็กเกจ → 409', async () => {
    const h = await createHook({ url: rx.url(), events: ['order.released'] });
    await skipVerification();
    const ev = await emit(tenantId, 'order.released', { id: 'ord_r' });
    const g = await api(app, token).get(`/v1/webhooks/${h.id}`).expect(200);
    await api(app, token)
      .post(`/v1/webhooks/${h.id}/disable`)
      .set('If-Match', `"${g.body.version}"`)
      .send({})
      .expect(422); // ต้องมีเหตุผล
    await api(app, token)
      .post(`/v1/webhooks/${h.id}/disable`)
      .set('If-Match', `"${g.body.version}"`)
      .send({ reason: 'ปิดชั่วคราวระหว่างย้ายระบบ' })
      .expect(200);
    await drainAll();
    expect(rx.hits).toHaveLength(0);
    const ob = await plat.integrationOutbox.findFirstOrThrow({
      where: { eventId: ev.id, sink: 'webhook' },
    });
    expect(ob.status).toBe('SKIPPED');

    const s = await api(app, token).get('/v1/webhooks/summary').expect(200);
    expect(s.body).toMatchObject({ all: 1, active: 0, failing: 0, disabled: 1, limit: 3 });
    const list = await api(app, token)
      .get('/v1/webhooks?status=disabled,auto_disabled')
      .expect(200);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([h.id]);
    expect(
      (await api(app, token).get('/v1/webhooks?status=active').expect(200)).body.data,
    ).toHaveLength(0);

    await createHook({ url: rx.url('/b'), events: ['order.created'] });
    await createHook({ url: rx.url('/c'), events: ['order.created'] });
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    const over = await api(app, token)
      .post('/v1/webhooks')
      .send({ url: rx.url('/d'), events: ['order.created'] });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: 'webhook_limit_reached', limit: 3 });

    const cur = await api(app, token).get(`/v1/webhooks/${h.id}`).expect(200);
    await api(app, token)
      .delete(`/v1/webhooks/${h.id}`)
      .set('If-Match', `"${cur.body.version}"`)
      .send({ reason: 'เลิกใช้ระบบปลายทางนี้แล้ว' })
      .expect(204);
    expect((await api(app, token).get(`/v1/webhooks/${h.id}`)).status).toBe(404);
    // ลบแล้วช่องว่างคืน
    const again = await api(app, token)
      .post('/v1/webhooks')
      .send({ url: rx.url('/d'), events: ['order.created'] });
    expect(again.status).toBe(201);
  });

  it('ค่า header เพิ่มเติมนอก ASCII → 422 · ค่าที่ประกอบคำขอไม่ได้ (ข้อมูลเก่า) = invalid_request ไม่ retry ไม่นับปิดอัตโนมัติ', async () => {
    const bad = await api(app, token)
      .post('/v1/webhooks')
      .send({
        url: 'https://hooks.example.com/hdr',
        events: ['order.created'],
        extraHeaders: [{ name: 'X-Name', value: 'ศรีไทย' }],
      });
    expect(bad.status).toBe(422);
    const h = await createHook({ url: rx.url('/hdr'), events: ['order.updated'] });
    await skipVerification();
    // จำลองข้อมูลที่หลุด validation มาก่อน (เช่น ค่าเดิมก่อนกฎนี้)
    await plat.webhookEndpoint.update({
      where: { id: uuid(h.id) },
      data: {
        extraHeadersEnc: engine.cipher.encrypt(
          JSON.stringify([{ name: 'X-Bad', value: 'ก\u0001' }]),
        ),
        extraHeaderNames: ['X-Bad'],
      },
    });
    const ev = await emit(tenantId, 'order.updated', { id: 'ord_hdr' });
    await drainAll();
    expect(rx.hits).toHaveLength(0);
    const d = await plat.webhookDelivery.findMany({ where: { endpointId: uuid(h.id) } });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: 'EXHAUSTED', errorCode: 'invalid_request', attempt: 1 });
    const ob = await plat.integrationOutbox.findFirstOrThrow({
      where: { eventId: ev.id, sink: 'webhook' },
    });
    expect(ob.status).toBe('FAILED_FINAL');
    const e = await plat.webhookEndpoint.findUniqueOrThrow({ where: { id: uuid(h.id) } });
    expect(e.consecutiveFailures).toBe(0);
  });

  it('แก้ URL → ล้าง verifiedAt + ส่ง challenge ใหม่ · URL มีช่องว่าง/พอร์ตต้องห้าม → 422 · เก็บรูปมาตรฐาน', async () => {
    rx.reply = (hit) => {
      const env = JSON.parse(hit.body);
      return env.type === 'webhook.verification'
        ? { status: 200, body: env.data.object.challenge }
        : { status: 200 };
    };
    const h = await createHook({ url: rx.url('/v1'), events: ['order.held'] });
    await drainAll();
    expect(
      (await api(app, token).get(`/v1/webhooks/${h.id}`).expect(200)).body.verifiedAt,
    ).toBeTruthy();
    for (const [url, code] of [
      ['https://hooks.example.com/a b', 'invalid_url'],
      ['https://hooks.example.com:25/x', 'port_not_allowed'],
    ] as const) {
      const r = await api(app, token)
        .patch(`/v1/webhooks/${h.id}`)
        .set('If-Match', `"${h.version}"`)
        .send({ url });
      expect(r.status, url).toBe(422);
      expect(r.body.errors[0].code).toBe(code);
    }
    rx.reply = () => ({ status: 200 }); // ปลายทางใหม่ไม่ echo
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    // D-67 review M1: เปลี่ยน URL / header ลับ ต้อง step-up (api() แนบให้ — ส่งค่าว่างทับ = ยังไม่ยืนยัน)
    const ns = await api(app, token)
      .patch(`/v1/webhooks/${h.id}`)
      .set('X-Step-Up', '')
      .set('If-Match', `"${h.version}"`)
      .send({ url: `HTTP://127.0.0.1:${rx.port}/v2` });
    expect(ns.status).toBe(403);
    expect(ns.body.code).toBe('step_up_required');
    const nh = await api(app, token)
      .patch(`/v1/webhooks/${h.id}`)
      .set('X-Step-Up', '')
      .set('If-Match', `"${h.version}"`)
      .send({ extraHeaders: [{ name: 'X-Leak', value: 'secret-value' }] });
    expect(nh.body.code).toBe('step_up_required');
    // แก้คำอธิบายอย่างเดียวไม่ต้อง step-up
    const nd = await api(app, token)
      .patch(`/v1/webhooks/${h.id}`)
      .set('X-Step-Up', '')
      .set('If-Match', `"${h.version}"`)
      .send({ description: 'ปลายทางทดสอบ' });
    expect(nd.status, JSON.stringify(nd.body)).toBe(200);
    h.version = nd.body.version;
    const p = await api(app, token)
      .patch(`/v1/webhooks/${h.id}`)
      .set('If-Match', `"${h.version}"`)
      .send({ url: `HTTP://127.0.0.1:${rx.port}/v2` });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ url: `http://127.0.0.1:${rx.port}/v2`, verifiedAt: null });
    const cmds = await plat.integrationOutbox.findMany({
      where: { targetId: uuid(h.id), operation: 'webhook.verification', status: 'PENDING' },
    });
    expect(cmds).toHaveLength(1);
    rx.reset();
    await drainAll();
    expect(rx.hits[0]!.headers['x-tms-event']).toBe('webhook.verification');
    expect(
      (await api(app, token).get(`/v1/webhooks/${h.id}`).expect(200)).body.verifiedAt,
    ).toBeNull();
  });

  it('ยกเลิกกลางส่ง (lease หาย/ปิด worker) → ไม่บันทึก delivery ไม่นับล้มเหลว', async () => {
    const h = await createHook({ url: rx.url('/slow'), events: ['order.created'] });
    await skipVerification();
    rx.reply = () => ({ status: 200, delayMs: 2000 });
    const e = await plat.webhookEndpoint.findUniqueOrThrow({ where: { id: uuid(h.id) } });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error('outbox lease lost')), 150);
    const r = await engine.attempt({
      tenantId,
      endpoint: e,
      envelope: engine.systemEnvelope(tenantId, 'order.created', {}),
      attempt: 9,
      test: false,
      signal: ctl.signal,
      withTx: (fn) => db.withTenant(tenantId, fn),
    });
    expect(r.outcome).toBe('ABORTED');
    expect(await plat.webhookDelivery.count({ where: { endpointId: e.id } })).toBe(0);
    const after = await plat.webhookEndpoint.findUniqueOrThrow({ where: { id: e.id } });
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastFailureAt).toBeNull();
  });

  it('event-types: รายการ event สาธารณะ (docs/01 §5.3) ไม่มี `*`', async () => {
    const r = await api(app, token).get('/v1/webhooks/event-types').expect(200);
    const types = r.body.data.map((x: { type: string }) => x.type);
    expect(types).toContain('order.created');
    expect(types).toContain('delivery_order.status_changed');
    expect(types).not.toContain('*');
    expect(types).not.toContain('webhook.test');
  });

  it('แก้ event (PATCH) → subscription ตาม · tenant อื่นมองไม่เห็น (404)', async () => {
    const h = await createHook({ url: rx.url(), events: ['order.created'] });
    await skipVerification();
    const p = await api(app, token)
      .patch(`/v1/webhooks/${h.id}`)
      .set('If-Match', `"${h.version}"`)
      .send({ events: ['payment.recorded', 'order.created'], description: 'บัญชี' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.events).toEqual(['order.created', 'payment.recorded']);
    const sub = await plat.integrationSubscription.findFirstOrThrow({
      where: { targetId: uuid(h.id) },
    });
    expect(sub.eventTypes).toEqual(['order.created', 'payment.recorded']);
    const other = (await createTenant(plat)).id;
    const ot = await tokenFor(other, '*', randomUUID());
    expect((await api(app, ot).get(`/v1/webhooks/${h.id}`)).status).toBe(404);
    expect((await api(app, ot).get('/v1/webhooks').expect(200)).body.data).toHaveLength(0);
  });
});
