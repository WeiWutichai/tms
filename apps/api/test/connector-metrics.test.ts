import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signPlatformToken } from '../src/auth/tokens';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { ConnectorsService } from '../src/modules/erp/connectors.service';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { ERP_SINK } from '../src/modules/erp/erp-adapter.sink';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../src/modules/integration/outbox.service';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

/**
 * ST9-T04 Dashboard เชื่อมต่อ (docs/04 H) + หน้า Health ของ Console (docs/02 §5)
 * เกณฑ์ตรวจรับ: หยุด mock KRS แล้ว dashboard แสดง health แดงและ lag เพิ่มภายใน 5 นาที
 */
const KEY = 'krs-metrics-key-5a1c0e';
const SECRET = 'demo-secret-key-9404';

describe('connector metrics (ST9-T04)', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  let tenantId: string;
  let otherId: string;
  let token: string;
  let mock: MockKrs;
  const staff: Record<string, string> = {};
  const prevPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;

  const uuid = (id: string) => tryDecodeId('connector', id)!;
  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };
  async function demo(t = token, settings: Record<string, string> = {}) {
    const r = await api(app, t)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'demo',
        credentials: { apiKey: SECRET },
        capabilitiesEnabled: ['pushInvoice'],
        settings,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await api(app, t).post(`/v1/connectors/${r.body.id}/resume`).send({}).expect(200);
    return r.body.id as string;
  }
  async function enqueue(tid: string, connectorId: string) {
    const localId = randomUUID();
    const { id } = await db.withTenant(tid, (tx) =>
      app.get(OutboxService).enqueueCommand(tx, {
        tenantId: tid,
        kind: 'ADAPTER',
        sink: ERP_SINK,
        targetId: connectorId,
        operation: 'PUSH_INVOICE',
        entityType: 'invoice',
        localId,
        payload: { document: { id: localId, number: 'INV-00000-2611-0001' } },
      }),
    );
    return id;
  }
  const metrics = async (t = token) =>
    (await api(app, t).get('/v1/connectors/metrics').expect(200)).body.data as Array<
      Record<string, any>
    >;

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    mock = await startMockKrs({ apiKey: KEY });
    tenantId = (await createTenant(plat, 'บริษัท แดชบอร์ดเชื่อม')).id;
    otherId = (await createTenant(plat, 'บริษัท อื่น')).id;
    await plat.tenant.updateMany({ data: { planCode: 'ent' } });
    token = await tokenFor(tenantId);
    for (const role of ['SUPER_ADMIN', 'SUPPORT', 'BILLING'] as const) {
      const u = await plat.platformUser.create({
        data: {
          email: `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@innovera.test`,
          name: `ทีม ${role}`,
          role,
          passwordHash: 'x',
          totpSecret: 'x',
        },
      });
      staff[role] = await signPlatformToken({ sub: u.id, role, tv: u.tokenVersion });
    }
  });
  beforeEach(async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
  });
  afterAll(async () => {
    if (prevPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = prevPrivate;
    await mock?.stop();
    await app?.close();
    await plat.$disconnect();
  });

  it('ต่อ connector: คิว/ล้มเหลว (= แท็บของหน้าคิว) · lag · ซิงก์ล่าสุด · MISMATCH เปิดอยู่ · poller · error rate 7 วัน', async () => {
    expect(await metrics()).toEqual([]); // Standalone = ไม่มีรายการ
    const id = await demo(token, { failMode: 'VALIDATION' });
    const cid = uuid(id);
    // ล้มเหลว 1 (VALIDATION → FAILED_FINAL)
    await enqueue(tenantId, cid);
    await drain();
    // สำเร็จ 1 (ซิงก์ล่าสุด)
    await api(app, token)
      .patch(`/v1/connectors/${id}`)
      .send({ settings: { failMode: 'none' } })
      .expect(200);
    await enqueue(tenantId, cid);
    await drain();
    // ค้าง 1 — สร้างเมื่อ 10 นาทีก่อน (lag)
    const stuck = await enqueue(tenantId, cid);
    await plat.$executeRaw`UPDATE integration_outbox SET created_at = now() - interval '10 minutes',
                            next_run_at = now() + interval '1 hour' WHERE id = ${stuck}::uuid`;

    // MISMATCH เปิด 1 · ack แล้ว 1 · ปิดแล้ว 1 · ERP_UNREACHABLE เปิด 1
    const rr = (result: string, severity: string, extra: Record<string, unknown> = {}) =>
      plat.reconcileResult.create({
        data: {
          tenantId,
          connectorId: cid,
          entityType: 'INVOICE',
          localId: randomUUID(),
          runAt: new Date(),
          source: 'NIGHTLY',
          localSnapshot: {},
          remoteSnapshot: {},
          diff: {},
          diffHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          result: result as never,
          severity: severity as never,
          lastSeenAt: new Date(),
          ...extra,
        },
      });
    await rr('MISMATCH', 'MONEY');
    await rr('MISMATCH', 'FIELD', { acknowledgedAt: new Date(), acknowledgedBy: 'u' });
    await rr('REMOTE_MISSING', 'MONEY', { resolvedAt: new Date() });
    await rr('ERP_UNREACHABLE', 'INFO');
    // poller: รอบดึง SO
    const pulled = new Date(Date.now() - 3 * 60_000);
    await plat.connectorCursor.create({
      data: { tenantId, connectorKey: 'demo', connectorId: cid, lastPullAt: pulled },
    });
    // error rate: ใน 7 วัน — 503 / ไม่ตอบ / 401 นับ · 422 / 404 ไม่นับ · เก่ากว่า 7 วันไม่นับ
    await plat.erpSyncLog.deleteMany({ where: { connectorId: cid } });
    const log = (statusCode: number | null, daysAgo = 0) =>
      plat.erpSyncLog.create({
        data: {
          tenantId,
          connectorId: cid,
          operation: 'PUSH_INVOICE',
          method: 'POST',
          url: 'https://demo-erp.invalid/x',
          statusCode,
          durationMs: 10,
          occurredAt: new Date(Date.now() - daysAgo * 86_400_000),
        },
      });
    for (const s of [200, 200, 201, 422, 404, 503, null, 401]) await log(s);
    await log(503, 8);

    const [m] = await metrics();
    expect(m).toMatchObject({
      id,
      adapterKey: 'demo',
      status: 'ACTIVE',
      health: { state: 'OK', failingSince: null, errorClass: null, code: null },
      queue: { queued: 1, failed: 1 },
      openMismatches: 1,
      reconcileUnreachable: 1,
      poller: { ordersLastRunAt: pulled.toISOString(), lastRunAt: pulled.toISOString() },
      errorRate7d: { calls: 8, failed: 3, rate: 0.375 },
    });
    expect(m!.queue.lagSeconds).toBeGreaterThanOrEqual(600);
    expect(m!.queue.lagSeconds).toBeLessThan(700);
    expect(m!.lastSyncAt).not.toBeNull();
    // ตรงกับ badge ของหน้าคิว (ST7-T19)
    const sum = (await api(app, token).get(`/v1/connectors/${id}/queue/summary`).expect(200)).body;
    expect([sum.queued, sum.failed]).toEqual([m!.queue.queued, m!.queue.failed]);
    expect(JSON.stringify(m)).not.toContain(SECRET);
  });

  it('สิทธิ์: integrations:read / settings:read ดูได้ · อย่างอื่น 403 · tenant อื่นไม่เห็น (isolation)', async () => {
    const id = await demo();
    for (const scope of ['integrations:read', 'settings:read'])
      expect((await metrics(await tokenFor(tenantId, scope))).map((x) => x.id)).toEqual([id]);
    await api(app, await tokenFor(tenantId, 'orders:read'))
      .get('/v1/connectors/metrics')
      .expect(403);
    // tenant อื่น: ไม่เห็น connector ของ tenant นี้ · มีของตัวเองก็เห็นเฉพาะของตัวเอง
    const other = await tokenFor(otherId);
    expect(await metrics(other)).toEqual([]);
    const mine = await demo(other);
    expect((await metrics(other)).map((x) => x.id)).toEqual([mine]);
    expect((await metrics()).map((x) => x.id)).toEqual([id]);
    // path `metrics` ไม่ถูก `:id` จับ · id ของ tenant อื่น = 404
    await api(app, token).get(`/v1/connectors/${mine}/queue/summary`).expect(404);
  });

  it('เกณฑ์ตรวจรับ: หยุด mock KRS → healthCheck ตามรอบ (≤ 5 นาที) → health แดง (DEGRADED) + lag เพิ่ม · PAUSED/ERROR แสดงตามสถานะ', async () => {
    const down = await startMockKrs({ apiKey: KEY });
    const r = await api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'krs',
        settings: { baseUrl: down.apiBaseUrl },
        credentials: { apiKey: KEY },
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    await api(app, token).post(`/v1/connectors/${id}/resume`).send({}).expect(200);
    const svc = app.get(ConnectorsService);
    svc.sweepConfirmMs = 0; // ตรวจยืนยันครั้งที่ 2 ทันที (จริง 60 วิ)
    // ผ่านล่าสุดเมื่อ 6 นาทีก่อน (ถึงรอบ) · มีคำสั่งค้าง
    await plat.connector.update({
      where: { id: uuid(id) },
      data: { lastHealthAt: new Date(Date.now() - 6 * 60_000) },
    });
    const c = await enqueue(tenantId, uuid(id));
    await plat.$executeRaw`UPDATE integration_outbox SET created_at = now() - interval '2 minutes',
                            next_run_at = now() + interval '1 hour' WHERE id = ${c}::uuid`;
    let [m] = await metrics();
    expect(m!.health.state).toBe('OK');
    const lag0 = m!.queue.lagSeconds as number;
    expect(lag0).toBeGreaterThanOrEqual(120);

    await down.stop();
    expect(await svc.healthSweep({ tenantId })).toBe(1);
    [m] = await metrics();
    expect(m).toMatchObject({
      status: 'ACTIVE',
      health: { state: 'DEGRADED', errorClass: 'TRANSIENT', code: 'unreachable' },
    });
    expect(m!.health.failingSince).not.toBeNull();
    // คำสั่งพัก (connector_unhealthy) → lag โตต่อ
    await plat.$executeRaw`UPDATE integration_outbox SET created_at = created_at - interval '5 minutes' WHERE id = ${c}::uuid`;
    [m] = await metrics();
    expect(m!.queue.lagSeconds).toBeGreaterThan(lag0 + 290);
    // ตรวจไปแล้ว (ยังไม่ถึงรอบ / ล้มอยู่ = recheckUnhealthy ดูแล) → sweep ไม่ตรวจซ้ำ
    expect(await svc.healthSweep({ tenantId })).toBe(0);

    // tenant ถูกระงับ = ไม่เรียกระบบบัญชีของลูกค้า
    await plat.connector.update({
      where: { id: uuid(id) },
      data: { healthFailingSince: null, lastHealthOk: true, lastHealthAt: null },
    });
    const prev = (await plat.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status;
    await plat.tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } });
    try {
      expect(await svc.healthSweep({ tenantId })).toBe(0);
    } finally {
      await plat.tenant.update({ where: { id: tenantId }, data: { status: prev } });
    }
    // review L2: แพ็กเกจไม่มี `conn` = ไม่ตรวจ
    const ent = app.get(EntitlementService);
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'start' } });
    ent.invalidate(tenantId);
    try {
      expect(await svc.healthSweep({ tenantId })).toBe(0);
    } finally {
      await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
      ent.invalidate(tenantId);
    }

    await plat.connector.update({ where: { id: uuid(id) }, data: { status: 'ERROR' } });
    expect((await metrics())[0]!.health.state).toBe('DOWN');
    await plat.connector.update({ where: { id: uuid(id) }, data: { status: 'PAUSED' } });
    expect((await metrics())[0]!.health.state).toBe('PAUSED');
  });

  it('review M1: healthCheck ตามรอบต้องล้มติดกัน 2 ครั้ง — สะดุดครั้งเดียว (503 / 401) ไม่พักคิว ไม่หยุด · 401 ติดกัน 2 ครั้ง = ERROR', async () => {
    const svc = app.get(ConnectorsService);
    svc.sweepConfirmMs = 0;
    const r = await api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'krs',
        settings: { baseUrl: mock.apiBaseUrl },
        credentials: { apiKey: KEY },
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    await api(app, token).post(`/v1/connectors/${id}/resume`).send({}).expect(200);
    const due = () =>
      plat.connector.update({
        where: { id: uuid(id) },
        data: { lastHealthAt: new Date(Date.now() - 6 * 60_000) },
      });
    const row = () => plat.connector.findUniqueOrThrow({ where: { id: uuid(id) } });
    try {
      // 503 ครั้งเดียว → ครั้งยืนยันผ่าน = ปกติ
      await due();
      mock.injectFault({ status: 503, method: 'GET', times: 1 });
      expect(await svc.healthSweep({ tenantId })).toBe(1);
      expect(await row()).toMatchObject({
        status: 'ACTIVE',
        healthFailingSince: null,
        lastHealthOk: true,
      });
      expect((await metrics())[0]!.health.state).toBe('OK');
      // 401 ครั้งเดียว → ไม่หยุด connector
      await due();
      mock.injectFault({ status: 401, method: 'GET', times: 1 });
      await svc.healthSweep({ tenantId });
      expect(await row()).toMatchObject({ status: 'ACTIVE', lastHealthOk: true });
      // 503 ติดกัน → DEGRADED (พักคิว)
      await due();
      mock.injectFault({ status: 503, method: 'GET', times: 2 });
      await svc.healthSweep({ tenantId });
      expect((await row()).healthFailingSince).not.toBeNull();
      expect((await metrics())[0]!.health).toMatchObject({
        state: 'DEGRADED',
        errorClass: 'TRANSIENT',
      });
      // 401 ติดกัน → ERROR (DOWN)
      await plat.connector.update({
        where: { id: uuid(id) },
        data: {
          healthFailingSince: null,
          lastHealthOk: true,
          lastHealthAt: new Date(Date.now() - 6 * 60_000),
        },
      });
      mock.injectFault({ status: 401, method: 'GET', times: 2 });
      await svc.healthSweep({ tenantId });
      expect(await row()).toMatchObject({ status: 'ERROR' });
      expect((await metrics())[0]!.health).toMatchObject({ state: 'DOWN', errorClass: 'AUTH' });
    } finally {
      mock.clearFaults();
    }
  });

  it('Console หน้า Health: ทุก role อ่านได้ · token ลูกค้า 401 · ต่อ tenant (live เท่านั้น) · ตัวนับเท่านั้น ไม่มี credential/ข้อความ error', async () => {
    const a = await demo();
    const b = await demo(await tokenFor(otherId));
    await plat.connector.update({
      where: { id: uuid(b) },
      data: {
        status: 'ERROR',
        lastHealthOk: false,
        lastHealthError: {
          errorClass: 'AUTH',
          code: 'unauthorized',
          message: `rejected ${SECRET}`,
        },
      },
    });
    const c = await enqueue(tenantId, uuid(a));
    await plat.$executeRaw`UPDATE integration_outbox SET created_at = now() - interval '3 minutes',
                            next_run_at = now() + interval '1 hour' WHERE id = ${c}::uuid`;
    // sandbox ไม่แสดง
    const sb = await plat.tenant.create({
      data: { name: 'sandbox', mode: 'test', liveTenantId: tenantId, planCode: 'ent' },
    });
    await plat.connector.create({
      data: { tenantId: sb.id, adapterKey: 'demo', status: 'ACTIVE' },
    });

    for (const role of ['SUPPORT', 'BILLING', 'SUPER_ADMIN'])
      await api(app, staff[role]).get('/v1/platform/connectors/health').expect(200);
    await api(app, token).get('/v1/platform/connectors/health').expect(401);

    const res = (await api(app, staff.SUPPORT).get('/v1/platform/connectors/health').expect(200))
      .body;
    expect(res.data.map((x: { tenantName: string }) => x.tenantName)).toEqual([
      'บริษัท อื่น', // DOWN ขึ้นก่อน
      'บริษัท แดชบอร์ดเชื่อม',
    ]);
    expect(res.data[0]).toMatchObject({
      tenantId: encodeId('tenant', otherId),
      connectors: [{ id: b, health: { state: 'DOWN', errorClass: 'AUTH', code: 'unauthorized' } }],
    });
    expect(res.data[1]).toMatchObject({
      tenantId: encodeId('tenant', tenantId),
      totals: {
        queued: 1,
        failed: 0,
        openMismatches: 0,
        errorRate7d: { rate: expect.any(Number) },
      },
    });
    expect(res.data[1].totals.lagSeconds).toBeGreaterThanOrEqual(180);
    const text = JSON.stringify(res);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('rejected');
    // กรอง tenant
    const one = (
      await api(app, staff.SUPPORT)
        .get(`/v1/platform/connectors/health?tenantId=${encodeId('tenant', tenantId)}`)
        .expect(200)
    ).body;
    expect(one.data).toHaveLength(1);
    expect(one.data[0].connectors.map((x: { id: string }) => x.id)).toEqual([a]);
  });
});
