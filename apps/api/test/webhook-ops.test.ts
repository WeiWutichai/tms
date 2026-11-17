import type { NestExpressApplication } from '@nestjs/platform-express';
import { WEBHOOK_EVENT_TYPES } from '@tms/domain';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService, type Tx } from '../src/db/db.service';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { WebhookEngine } from '../src/modules/webhooks/webhook-engine';
import { WebhookOpsService } from '../src/modules/webhooks/webhook-ops.service';
import { WebhookRetentionService } from '../src/modules/webhooks/webhook-retention';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

interface Hit {
  headers: IncomingHttpHeaders;
  body: string;
}

/** ปลายทางทดสอบในเครื่อง — `status` กำหนดคำตอบ */
class Receiver {
  hits: Hit[] = [];
  status = 200;
  private server!: Server;
  port = 0;
  async start() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(this.status, { 'content-type': 'application/json' });
        res.end(this.status < 300 ? '{"received":true}' : '{"error":"down"}');
      });
    });
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', ok));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  url(path = '/hook') {
    return `http://127.0.0.1:${this.port}${path}`;
  }
  close() {
    this.server.closeAllConnections?.();
    return new Promise<void>((ok) => this.server.close(() => ok()));
  }
}

/**
 * ST7-T05 Webhook ops (docs/04 G1 "Webhook ops"; spec/07 INT-105/106/109)
 * เกณฑ์ตรวจรับ: ดู delivery ที่ล้มเหลวแล้วสั่ง retry สำเร็จ (UI ใน e2e/webhook-ops.spec.ts)
 */
describe('webhook ops (ST7-T05)', () => {
  let app: NestExpressApplication;
  const plat = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  const rx = new Receiver();
  let tenantId: string;
  let token: string;
  let userId: string;

  const emit = (type: string, occurredAt?: Date) =>
    db.withTenant(tenantId, (tx: Tx) =>
      tx.domainEvent.create({
        data: {
          tenantId,
          type,
          entityType: type.split('.')[0]!,
          localId: randomUUID(),
          snapshot: { id: 'ord_x', status: 'created' },
          ...(occurredAt ? { occurredAt } : {}),
        },
      }),
    );
  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    return dispatcher.drain();
  };
  async function createHook(events: string[], extraHeaders?: { name: string; value: string }[]) {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    try {
      const r = await api(app, token)
        .post('/v1/webhooks')
        .send({ url: rx.url(`/h${randomUUID().slice(0, 8)}`), events, extraHeaders });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      // ข้ามคำสั่ง verification (สนใจเฉพาะ event)
      await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED'
                              WHERE operation = 'webhook.verification' AND status = 'PENDING'`;
      return r.body as { id: string; version: number; url: string };
    } finally {
      delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    }
  }
  const ep = (id: string) => tryDecodeId('webhookEndpoint', id)!;
  const resetLimits = () =>
    (app.get(WebhookOpsService) as unknown as { hits: Map<string, number[]> }).hits.clear();

  /** endpoint ที่ event แรกล้ม (500 → FAILED รอ retry) — คืน delivery ล่าสุด */
  async function failedDelivery(events = ['order.created']) {
    const h = await createHook(events, [{ name: 'X-Client-Token', value: 'client-secret-123' }]);
    rx.status = 500;
    const ev = await emit('order.created');
    await drain();
    const list = await api(app, token)
      .get(`/v1/webhook-deliveries?eventId=${encodeId('event', ev.id)}`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    return { h, ev, d: list.body.data[0] as Record<string, unknown> };
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    await rx.start();
    tenantId = (await createTenant(plat, 'บริษัท ส่งซ้ำ')).id;
    userId = (
      await plat.appUser.create({
        data: { tenantId, email: 'ops@hook.test', name: 'ผู้ดูแล ทดสอบ', status: 'ACTIVE' },
      })
    ).id;
    token = await tokenFor(tenantId, '*', userId);
  });
  beforeEach(async () => {
    rx.hits = [];
    rx.status = 200;
    resetLimits();
    app.get(WebhookEngine).sendOptions = { allowPrivate: true };
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    await plat.webhookEndpoint.updateMany({
      where: { deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await plat.integrationSubscription.updateMany({
      where: { sink: 'webhook' },
      data: { active: false },
    });
  });
  afterAll(async () => {
    await rx.close();
    await app.close();
    await plat.$disconnect();
  });

  it('event-types: ครบทุก event สาธารณะ + คำอธิบายไทย + ตัวอย่าง data.object', async () => {
    const r = await api(app, token).get('/v1/webhooks/event-types').expect(200);
    expect(r.body.data.map((x: { type: string }) => x.type)).toEqual([...WEBHOOK_EVENT_TYPES]);
    for (const x of r.body.data) {
      expect(x.description).toMatch(/[฀-๿]/);
      expect(x.resource).toBe(x.type.split('.')[0]);
      expect(x.sample.sampleEventType).toBe(x.type);
    }
  });

  it('ประวัติการส่ง: กรอง eventId/endpointId/status/test + แบ่งหน้า · รายละเอียดไม่เปิดค่า header เพิ่มเติม/ลายเซ็นเต็ม', async () => {
    const { h, ev, d } = await failedDelivery();
    expect(d).toMatchObject({
      endpointId: h.id,
      eventId: encodeId('event', ev.id),
      eventType: 'order.created',
      attempt: 1,
      test: false,
      status: 'failed',
      responseStatus: 500,
      errorCode: 'http_status',
    });
    expect(d.id).toMatch(/^whd_[0-9a-f]{32}$/);
    expect(d.nextRetryAt).not.toBeNull();
    // event ทดสอบ 1 ครั้ง (ของ endpoint เดียวกัน)
    rx.status = 200;
    await api(app, token).post(`/v1/webhooks/${h.id}/test`).send({}).expect(200);
    const all = await api(app, token).get(`/v1/webhook-deliveries?endpointId=${h.id}`).expect(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.data[0].test).toBe(true); // ใหม่สุดก่อน
    const real = await api(app, token)
      .get(`/v1/webhook-deliveries?endpointId=${h.id}&test=false&status=failed,exhausted`)
      .expect(200);
    expect(real.body.data.map((x: { id: string }) => x.id)).toEqual([d.id]);
    const p1 = await api(app, token)
      .get(`/v1/webhook-deliveries?endpointId=${h.id}&limit=1`)
      .expect(200);
    expect(p1.body.hasMore).toBe(true);
    const p2 = await api(app, token)
      .get(`/v1/webhook-deliveries?endpointId=${h.id}&limit=1&cursor=${p1.body.nextCursor}`)
      .expect(200);
    expect(p2.body.data[0].id).toBe(d.id);
    expect(p2.body.hasMore).toBe(false);
    expect(
      (await api(app, token).get('/v1/webhook-deliveries?cursor=bad').expect(422)).body.code,
    ).toBe('validation_failed');
    expect(
      (await api(app, token).get('/v1/webhook-deliveries?status=ok')).status,
    ).toBe(422);

    const det = await api(app, token).get(`/v1/webhook-deliveries/${d.id}`).expect(200);
    expect(det.body.requestHeaders['X-Client-Token']).toBe('***');
    expect(det.body.requestHeaders['X-TMS-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{4}…$/);
    expect(JSON.stringify(det.body)).not.toContain('client-secret-123');
    expect(JSON.stringify(det.body)).not.toContain('whsec_');
    expect(JSON.parse(det.body.requestBody)).toMatchObject({
      id: encodeId('event', ev.id),
      type: 'order.created',
    });
    expect(det.body.responseBody).toBe('{"error":"down"}');
    expect((await api(app, token).get(`/v1/webhook-deliveries/whd_${'0'.repeat(32)}`)).status).toBe(
      404,
    );
  });

  it('retry หลังแก้ปลายทาง: ผ่าน outbox → สำเร็จ · id เดิม · X-TMS-Attempt +1 · รอบอัตโนมัติที่ค้างถูกยกเลิก · ตัวนับล้าง · audit', async () => {
    const { h, ev, d } = await failedDelivery();
    const before = await plat.webhookEndpoint.findUniqueOrThrow({ where: { id: ep(h.id) } });
    expect(before.lastFailureAt).not.toBeNull();
    rx.status = 200;
    rx.hits = [];
    const r = await api(app, token).post(`/v1/webhook-deliveries/${d.id}/retry`).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      state: 'delivered',
      status: 200,
      attempt: 2,
      endpointId: h.id,
      eventId: encodeId('event', ev.id),
    });
    expect(rx.hits).toHaveLength(1);
    expect(rx.hits[0]!.headers['x-tms-event-id']).toBe(encodeId('event', ev.id));
    expect(rx.hits[0]!.headers['x-tms-attempt']).toBe('2');
    expect(rx.hits[0]!.headers['x-client-token']).toBe('client-secret-123');
    expect(JSON.parse(rx.hits[0]!.body).id).toBe(encodeId('event', ev.id));
    // คำสั่งส่งซ้ำอยู่ใน outbox (DONE) + คำสั่งรอบอัตโนมัติเดิมถูกยกเลิก (ไม่ส่งซ้ำอีกรอบ)
    const cmds = await plat.integrationOutbox.findMany({
      where: { eventId: ev.id, sink: 'webhook' },
      orderBy: { seq: 'asc' },
    });
    expect(cmds.map((c) => [c.operation, c.status])).toEqual([
      ['order.created', 'SKIPPED'],
      ['webhook.redeliver', 'DONE'],
    ]);
    expect((cmds[0]!.lastError as { code: string }).code).toBe('superseded_by_manual');
    expect(await drain()).toBe(0);
    const after = await plat.webhookEndpoint.findUniqueOrThrow({ where: { id: ep(h.id) } });
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastSuccessAt).not.toBeNull();
    const got = await api(app, token).get(`/v1/webhooks/${h.id}`).expect(200);
    expect(got.body.status).toBe('active');
    const list = await api(app, token)
      .get(`/v1/webhook-deliveries?eventId=${encodeId('event', ev.id)}`)
      .expect(200);
    expect(list.body.data.map((x: { attempt: number; status: string }) => [x.attempt, x.status])).toEqual([
      [2, 'delivered'],
      [1, 'failed'],
    ]);
    const audit = await plat.auditLog.findFirstOrThrow({
      where: { entityId: ep(h.id), action: 'webhook_endpoint.delivery_retried' },
    });
    expect(audit.actorId).toBe(userId);
    expect(audit.after).toMatchObject({ eventId: encodeId('event', ev.id), attempt: 2, deliveryId: d.id });
  });

  it('retry ที่ยังล้ม: ครั้งเดียว ไม่ retry อัตโนมัติ · ไม่นับเข้าการปิดอัตโนมัติ · รอบอัตโนมัติเดิมยังเดินต่อ', async () => {
    const { h, d } = await failedDelivery();
    rx.status = 503;
    const r = await api(app, token).post(`/v1/webhook-deliveries/${d.id}/retry`).send({});
    expect(r.body).toMatchObject({ state: 'failed', status: 503, attempt: 2 });
    const row = await plat.webhookDelivery.findFirstOrThrow({
      where: { id: tryDecodeId('webhookDelivery', r.body.deliveryId)! },
    });
    expect(row).toMatchObject({ status: 'EXHAUSTED', nextRetryAt: null, attempt: 2 });
    const cmds = await plat.integrationOutbox.findMany({
      where: { targetId: ep(h.id), sink: 'webhook', operation: { not: 'webhook.verification' } },
      orderBy: { seq: 'asc' },
    });
    expect(cmds.map((c) => c.status)).toEqual(['FAILED_RETRYABLE', 'FAILED_FINAL']);
    const e = await plat.webhookEndpoint.findUniqueOrThrow({ where: { id: ep(h.id) } });
    expect(e.consecutiveFailures).toBe(0);
  });

  it('retry ใช้ SSRF guard เดียวกัน: ปลายทางภายในเมื่อไม่อนุญาต → failed ssrf_blocked ไม่ยิงจริง', async () => {
    const { d } = await failedDelivery();
    app.get(WebhookEngine).sendOptions = {};
    rx.hits = [];
    rx.status = 200;
    const r = await api(app, token).post(`/v1/webhook-deliveries/${d.id}/retry`).send({});
    expect(r.body).toMatchObject({ state: 'failed', status: null, errorCode: 'ssrf_blocked' });
    expect(rx.hits).toHaveLength(0);
  });

  it('retry: event ทดสอบ → 422 · endpoint ปิด → 409 · ถี่เกิน → 429 · ไม่มีสิทธิ์เขียน/ไม่ใช่ผู้ใช้ → 403', async () => {
    const { h, d } = await failedDelivery();
    rx.status = 200;
    await api(app, token).post(`/v1/webhooks/${h.id}/test`).send({}).expect(200);
    const testRow = (
      await api(app, token).get(`/v1/webhook-deliveries?endpointId=${h.id}&test=true`).expect(200)
    ).body.data[0];
    expect(
      (await api(app, token).post(`/v1/webhook-deliveries/${testRow.id}/retry`).send({})).body.code,
    ).toBe('webhook_not_retryable');

    const viewer = await tokenFor(tenantId, 'settings:read', userId);
    expect((await api(app, viewer).get(`/v1/webhook-deliveries/${d.id}`)).status).toBe(200);
    expect((await api(app, viewer).post(`/v1/webhook-deliveries/${d.id}/retry`).send({})).status).toBe(
      403,
    );
    const ev = (d.eventId as string).slice(4);
    expect(
      (await api(app, viewer).post(`/v1/events/evt_${ev}/redeliver`).send({})).status,
    ).toBe(403);

    expect((await api(app, token).post(`/v1/webhook-deliveries/${d.id}/retry`).send({})).status).toBe(200);
    const again = await api(app, token).post(`/v1/webhook-deliveries/${d.id}/retry`).send({});
    expect(again.status).toBe(429);
    expect(again.body.retryAfter).toBeGreaterThan(0);

    resetLimits();
    const off = await api(app, token)
      .post(`/v1/webhooks/${h.id}/disable`)
      .set('If-Match', `"${(await api(app, token).get(`/v1/webhooks/${h.id}`)).body.version}"`)
      .send({ reason: 'ปิดชั่วคราวระหว่างย้ายระบบ' });
    expect(off.status).toBe(200);
    const r = await api(app, token).post(`/v1/webhook-deliveries/${d.id}/retry`).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('invalid_state_transition');
  });

  it('redeliver: event ที่เกิดระหว่างปิด endpoint ส่งได้หลังเปิด (INT-105) · ไม่ระบุ endpoint = ทุกตัวที่สมัคร · ไม่สมัคร/เกิน 30 วัน → 422', async () => {
    const a = await createHook(['order.created']);
    const b = await createHook(['order.updated', 'order.created']);
    const c = await createHook(['trip.dispatched']);
    // ปิด a ระหว่างเกิด event
    const v = (await api(app, token).get(`/v1/webhooks/${a.id}`)).body.version;
    await api(app, token)
      .post(`/v1/webhooks/${a.id}/disable`)
      .set('If-Match', `"${v}"`)
      .send({ reason: 'ปิดชั่วคราวระหว่างย้ายระบบ' })
      .expect(200);
    const ev = await emit('order.created');
    await drain(); // b ได้ครั้งที่ 1 · a ไม่มีคำสั่ง (ปิดอยู่)
    expect(
      await plat.integrationOutbox.count({ where: { eventId: ev.id, targetId: ep(a.id) } }),
    ).toBe(0);
    await api(app, token)
      .post(`/v1/webhooks/${a.id}/enable`)
      .set('If-Match', `"${v + 1}"`)
      .send({})
      .expect(200);
    rx.hits = [];
    const one = await api(app, token)
      .post(`/v1/events/${encodeId('event', ev.id)}/redeliver?endpointId=${a.id}`)
      .send({});
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.data).toEqual([
      expect.objectContaining({ endpointId: a.id, state: 'delivered', attempt: 1, status: 200 }),
    ]);
    expect(rx.hits.map((x) => x.headers['x-tms-attempt'])).toEqual(['1']);

    resetLimits();
    const all = await api(app, token)
      .post(`/v1/events/${encodeId('event', ev.id)}/redeliver`)
      .send({});
    expect(all.status).toBe(200);
    const byEp = Object.fromEntries(
      all.body.data.map((x: { endpointId: string; attempt: number; state: string }) => [
        x.endpointId,
        [x.attempt, x.state],
      ]),
    );
    expect(byEp).toEqual({ [a.id]: [2, 'delivered'], [b.id]: [2, 'delivered'] });

    resetLimits();
    const no = await api(app, token)
      .post(`/v1/events/${encodeId('event', ev.id)}/redeliver?endpointId=${c.id}`)
      .send({});
    expect(no.status).toBe(422);
    expect(no.body.code).toBe('webhook_event_not_subscribed');

    const old = await emit('order.created', new Date(Date.now() - 31 * 24 * 3600_000));
    const exp = await api(app, token)
      .post(`/v1/events/${encodeId('event', old.id)}/redeliver?endpointId=${a.id}`)
      .send({});
    expect(exp.status).toBe(422);
    expect(exp.body.code).toBe('webhook_event_expired');
    expect(
      (await api(app, token).post(`/v1/events/evt_${'0'.repeat(32)}/redeliver`).send({})).status,
    ).toBe(404);
    const audit = await plat.auditLog.count({
      where: { entityId: ep(a.id), action: 'webhook_endpoint.event_redelivered' },
    });
    expect(audit).toBe(2);
  });

  it('แยกบริษัท: รายการของบริษัทอื่นไม่เห็น · redeliver event ของบริษัทอื่น → 404', async () => {
    const { d, ev } = await failedDelivery();
    const other = (await createTenant(plat, 'บริษัท อื่น')).id;
    const tok = await tokenFor(other);
    const r = await api(app, tok).get('/v1/webhook-deliveries').expect(200);
    expect(r.body.data).toEqual([]);
    expect((await api(app, tok).get(`/v1/webhook-deliveries/${d.id}`)).status).toBe(404);
    expect(
      (await api(app, tok).post(`/v1/events/${encodeId('event', ev.id)}/redeliver`).send({}))
        .status,
    ).toBe(404);
  });

  it('ล้างตาม retention: delivery เกิน 30 วันลบ · คำสั่งที่พักเพราะบริษัทถูกระงับเกิน 30 วัน → SKIPPED (INT-109)', async () => {
    const { h, d } = await failedDelivery();
    const ev = await emit('order.created');
    const oldId = randomUUID();
    await plat.webhookDelivery.create({
      data: {
        id: oldId,
        tenantId,
        endpointId: ep(h.id),
        eventId: ev.id,
        envelopeId: encodeId('event', ev.id),
        eventType: 'order.created',
        attempt: 1,
        status: 'EXHAUSTED',
        requestUrl: h.url,
        requestHeaders: {},
        requestBody: '{}',
        durationMs: 1,
        sentAt: new Date(Date.now() - 31 * 24 * 3600_000),
      },
    });
    // คำสั่งที่พัก (tenant ถูกระงับ → AUTH → PENDING) เก่า 31 วัน และใหม่ 1 วัน
    const parked = await plat.integrationOutbox.findFirstOrThrow({
      where: { eventId: ev.id, targetId: ep(h.id) },
    });
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'PENDING', error_class = 'AUTH',
                             created_at = now() - interval '31 days', next_run_at = now() + interval '1 hour'
                            WHERE id = ${parked.id}::uuid`;
    const ev2 = await emit('order.created');
    const fresh = await plat.integrationOutbox.findFirstOrThrow({
      where: { eventId: ev2.id, targetId: ep(h.id) },
    });
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'PENDING', error_class = 'AUTH',
                             created_at = now() - interval '1 day', next_run_at = now() + interval '1 hour'
                            WHERE id = ${fresh.id}::uuid`;

    const r = await app.get(WebhookRetentionService).purge();
    expect(r.deliveries).toBeGreaterThanOrEqual(1);
    expect(r.parkedDropped).toBe(1);
    expect(await plat.webhookDelivery.count({ where: { id: oldId } })).toBe(0);
    expect(
      await plat.webhookDelivery.count({ where: { id: tryDecodeId('webhookDelivery', d.id as string)! } }),
    ).toBe(1);
    const p = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: parked.id } });
    expect(p.status).toBe('SKIPPED');
    expect((p.lastError as { code: string }).code).toBe('parked_expired');
    expect((await plat.integrationOutbox.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe(
      'PENDING',
    );
    // role แอปลบประวัติเองไม่ได้
    await expect(
      db.withTenant(tenantId, (tx) => tx.webhookDelivery.deleteMany({})),
    ).rejects.toThrow();
  });
});
