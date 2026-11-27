import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { DemoAdapter } from '../src/erp-adapters/demo/demo.adapter';
import { rateLimitInstance } from '../src/http/rate-limit/rate-limit.service';
import { JobQueue } from '../src/jobs/job-queue.service';
import { CONNECTOR_PULL_JOB } from '../src/modules/connectors/connector-intake.service';
import { ConnectorsService } from '../src/modules/erp/connectors.service';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import {
  INBOUND_MAX_BYTES,
  INBOUND_PROCESS_JOB,
  InboundWebhookService,
} from '../src/modules/erp/inbound-webhook.service';
import { signatureHeader } from '../src/modules/webhooks/signature';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { TenantLifecycleService } from '../src/modules/tenants/tenant-lifecycle.service';
import { FakeErpAdapter, GOOD_KEY } from './fake-erp-adapter';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

// เพดานต่อ token ต่ำ (ค่าจริง 600/นาที) เพื่อทดสอบ 429 — อ่านตอน import โมดูล
vi.hoisted(() => {
  process.env.INBOUND_RATE_LIMIT_PER_TOKEN_MIN = '40';
});

/**
 * ST7-T22 Inbound webhook ledger (docs/04 G3 "Inbound webhook ledger" I10)
 * เกณฑ์ตรวจรับ: ส่ง inbound event เดิม 2 ครั้ง → ประมวลผลครั้งเดียว · signature ผิด → 401
 */
describe('Inbound webhook ledger (ST7-T22)', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  let db: DbService;
  let queue: JobQueue;
  let demo: DemoAdapter;
  const fake = new FakeErpAdapter('fake-erp');
  let tenantId: string;
  let otherTenantId: string;
  let token: string;
  const SECRET = 'demo-inbound-secret-0001';

  let conId: string;
  let conUuid: string;
  let inboundToken: string;
  let inboundPath: string;

  const server = () => app.getHttpServer();
  const body = (o: Record<string, unknown>) => JSON.stringify(o);
  const sign = (raw: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
    signatureHeader(t, raw, [secret]);
  const send = (raw: string, sig: string | null = sign(raw), path = inboundPath) => {
    const r = request(server()).post(path).set('Content-Type', 'application/json');
    if (sig !== null) r.set('X-Demo-Signature', sig);
    return r.send(raw);
  };
  const ledger = () =>
    plat.processedWebhookEvent.findMany({ where: { tenantId }, orderBy: { receivedAt: 'asc' } });
  const inboundJobs = () => plat.job.findMany({ where: { tenantId, type: INBOUND_PROCESS_JOB } });
  /** รัน job ที่ถึงเวลาทั้งหมด (ทางเดียวกับ worker) */
  const drain = async () => {
    for (let i = 0; i < 20 && (await queue.runOnce()); i++);
  };

  async function demoConnector(
    creds: Record<string, string> = { apiKey: GOOD_KEY, inboundSecret: SECRET },
  ) {
    const r = await api(app, token)
      .post('/v1/connectors')
      .send({ adapterKey: 'demo', credentials: creds, capabilitiesEnabled: ['pullOrders'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await api(app, token).post(`/v1/connectors/${r.body.id}/resume`).send({}).expect(200);
    return r.body.id as string;
  }

  async function rotate(id = conId) {
    const r = await api(app, token)
      .post(`/v1/connectors/${id}/inbound-token/rotate`)
      .send({ reason: 'ออก token รับ webhook ขาเข้า' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { token: string; url: string; tokenPrefix: string };
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    queue = app.get(JobQueue);
    const reg = app.get(ErpAdapterRegistry);
    demo = reg.get('demo') as DemoAdapter;
    reg.replace(fake);
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท รับเว็บฮุค จำกัด' })).id;
    otherTenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น จำกัด' })).id;
    await plat.tenant.updateMany({ data: { planCode: 'ent' } });
    const userId = (
      await plat.appUser.create({
        data: { tenantId, email: 'admin@inbound.test', name: 'ผู้ดูแล', status: 'ACTIVE' },
      })
    ).id;
    token = await tokenFor(tenantId, '*', userId);
  });

  beforeEach(async () => {
    demo.reset();
    await rateLimitInstance()?.reset('inb:');
    await plat.$executeRaw`DELETE FROM processed_webhook_event`;
    await plat.$executeRaw`DELETE FROM job WHERE type = ${INBOUND_PROCESS_JOB}`;
    await plat.$executeRaw`UPDATE job SET status = 'SKIPPED' WHERE status IN ('PENDING', 'RUNNING')`;
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: {
        status: 'DISCONNECTED',
        disconnectedAt: new Date(),
        inboundTokenHash: null,
        inboundTokenPrefix: null,
      },
    });
    conId = await demoConnector();
    conUuid = tryDecodeId('connector', conId)!;
    const t = await rotate();
    inboundToken = t.token;
    inboundPath = new URL(t.url).pathname;
  });

  afterAll(async () => {
    app.get(ErpAdapterRegistry).unregister(fake.key);
    await app.close();
    await plat.$disconnect();
    await appDb.$disconnect();
  });

  it('ออก token: แสดงครั้งเดียว + URL · connector แสดงแค่ prefix · audit ไม่มีค่า token · ฐานเก็บแค่ hash', async () => {
    expect(inboundToken).toMatch(/^whin_[A-Za-z0-9_-]{43}$/);
    expect(inboundPath).toBe(`/v1/inbound/demo/${inboundToken}`);
    const c = await api(app, token).get(`/v1/connectors/${conId}`).expect(200);
    expect(c.body.inbound).toEqual({
      supported: true,
      tokenPrefix: inboundToken.slice(0, 9),
      tokenRotatedAt: expect.any(String),
    });
    expect(JSON.stringify(c.body)).not.toContain(inboundToken);
    const row = await plat.connector.findUniqueOrThrow({ where: { id: conUuid } });
    expect(row.inboundTokenHash).toBeTruthy();
    expect(row.inboundTokenHash).not.toContain(inboundToken);
    const audits = await plat.auditLog.findMany({
      where: { tenantId, entityId: conUuid, action: { startsWith: 'connector.inbound_token' } },
    });
    expect(audits.map((a) => a.action)).toEqual(['connector.inbound_token_issued']);
    expect(JSON.stringify(audits.map((a) => [a.before, a.after]))).not.toContain(inboundToken);
  });

  it('เกณฑ์ตรวจรับ: event เดิม 2 ครั้ง → บันทึก + ประมวลผลครั้งเดียว (ครั้งที่สอง duplicate)', async () => {
    const raw = body({
      id: 'evt-1001',
      type: 'invoice.paid',
      occurredAt: '2026-11-18T09:00:00+07:00',
    });
    const a = await send(raw);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({
      received: true,
      duplicate: false,
      id: expect.stringMatching(/^ibe_/),
    });
    expect(a.headers['cache-control']).toBe('no-store');
    const b = await send(raw);
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ ...a.body, duplicate: true });
    await drain();
    // ส่งครั้งที่สามหลังประมวลผลแล้ว — ยังไม่ทำซ้ำ
    await send(raw).expect(200);
    await drain();
    expect(demo.inboundHandled(tenantId, conUuid)).toEqual([
      { eventKey: 'evt-1001', type: 'invoice.paid', occurredAt: '2026-11-18T02:00:00.000Z' },
    ]);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'demo',
      eventKey: 'evt-1001',
      eventType: 'invoice.paid',
      status: 'PROCESSED',
      duplicateCount: 2,
      attempts: 1,
      payloadBytes: Buffer.byteLength(raw),
    });
    expect(rows[0]!.occurredAt?.toISOString()).toBe('2026-11-18T02:00:00.000Z');
    expect(rows[0]!.receivedAt).toBeInstanceOf(Date);
    // payload เข้ารหัส (ไม่มีข้อความเดิมในฐาน)
    expect(rows[0]!.payloadEnc).toBeTruthy();
    expect(rows[0]!.payloadEnc).not.toContain('evt-1001');
    expect(await inboundJobs()).toHaveLength(1);
  });

  it('เกณฑ์ตรวจรับ: signature ผิด → 401 และไม่มีแถวใน ledger / ไม่มี job', async () => {
    const raw = body({ id: 'evt-bad', type: 'invoice.paid' });
    const cases = [
      sign(raw, 'wrong-secret'),
      sign(`${raw} `), // body ถูกแก้หลังเซ็น
      sign(raw, SECRET, Math.floor(Date.now() / 1000) - 3600), // timestamp เก่า (replay)
      'garbage',
      null,
    ];
    const bodies: unknown[] = [];
    for (const sig of cases) {
      const r = await send(raw, sig);
      expect(r.status).toBe(401);
      bodies.push({ ...r.body, instance: undefined, requestId: undefined });
    }
    expect(new Set(bodies.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(await ledger()).toHaveLength(0);
    expect(await inboundJobs()).toHaveLength(0);
  });

  it('token ไม่รู้จัก / provider ไม่ตรง / รูปแบบผิด → 401 รูปเดียวกับลายเซ็นผิด (ไม่มี oracle)', async () => {
    const raw = body({ id: 'evt-x', type: 'invoice.paid' });
    const unknown = `whin_${'A'.repeat(43)}`;
    const paths = [
      `/v1/inbound/demo/${unknown}`,
      `/v1/inbound/fake-erp/${inboundToken}`,
      `/v1/inbound/demo/not-a-token`,
      `/v1/inbound/DEMO!/${inboundToken}`,
    ];
    const bad = await send(raw, sign(raw, 'nope'));
    for (const p of paths) {
      const r = await send(raw, sign(raw), p);
      expect(r.status, p).toBe(401);
      expect({ ...r.body, instance: undefined, requestId: undefined }).toEqual({
        ...bad.body,
        instance: undefined,
        requestId: undefined,
      });
    }
    expect(await ledger()).toHaveLength(0);
  });

  it('หมุน token: token เดิม 401 ทันที · token ใหม่ใช้ได้ · audit rotated (เหตุผล)', async () => {
    const old = inboundPath;
    const r = await api(app, token)
      .post(`/v1/connectors/${conId}/inbound-token/rotate`)
      .send({ reason: 'หมุนตามรอบความปลอดภัย' })
      .expect(200);
    expect(r.body.token).not.toBe(inboundToken);
    const raw = body({ id: 'evt-rot', type: 'invoice.paid' });
    await send(raw, sign(raw), old).expect(401);
    await send(raw, sign(raw), new URL(r.body.url).pathname).expect(200);
    const a = await plat.auditLog.findFirstOrThrow({
      where: { tenantId, entityId: conUuid, action: 'connector.inbound_token_rotated' },
    });
    expect(a.reason).toBe('หมุนตามรอบความปลอดภัย');
    expect(a.before).toEqual({ inboundTokenPrefix: inboundToken.slice(0, 9) });
    expect(JSON.stringify([a.before, a.after])).not.toContain(r.body.token);
  });

  it('พร้อมกัน: ส่ง event เดียวกัน 2 คำขอพร้อมกัน → แถวเดียว job เดียว ประมวลผลครั้งเดียว', async () => {
    const raw = body({ id: 'evt-race', type: 'invoice.paid' });
    const sig = sign(raw);
    const rs = await Promise.all([send(raw, sig), send(raw, sig), send(raw, sig)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rs.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
    expect(await inboundJobs()).toHaveLength(1);
    await drain();
    expect(demo.inboundHandled(tenantId, conUuid)).toHaveLength(1);
  });

  it('body เกิน 256 KB → 413 ไม่มีแถว', async () => {
    const raw = body({ id: 'evt-big', type: 'invoice.paid', pad: 'x'.repeat(INBOUND_MAX_BYTES) });
    const r = await send(raw);
    expect(r.status).toBe(413);
    expect(r.body.code).toBe('payload_too_large');
    expect(await ledger()).toHaveLength(0);
  });

  it('ลายเซ็นถูกแต่ body ไม่ใช่ event ที่รู้จัก → 400 ไม่มีแถว', async () => {
    for (const raw of ['not json', body({ type: 'x' }), body({ id: '', type: 'x' })]) {
      const r = await send(raw);
      expect(r.status, raw).toBe(400);
    }
    expect(await ledger()).toHaveLength(0);
  });

  it('event key เดียวกันคนละ tenant ไม่ชนกัน (unique ต่อ tenant + connector + eventKey)', async () => {
    const raw = body({ id: 'evt-shared', type: 'invoice.paid' });
    await send(raw).expect(200);
    const ownerB = (
      await plat.appUser.create({
        data: {
          tenantId: otherTenantId,
          email: `b-${randomUUID().slice(0, 6)}@x.test`,
          name: 'B',
          status: 'ACTIVE',
        },
      })
    ).id;
    const tb = await tokenFor(otherTenantId, '*', ownerB);
    const c = await api(app, tb)
      .post('/v1/connectors')
      .send({
        adapterKey: 'demo',
        credentials: { apiKey: GOOD_KEY, inboundSecret: 'secret-b-0001' },
      })
      .expect(201);
    await api(app, tb).post(`/v1/connectors/${c.body.id}/resume`).send({}).expect(200);
    const rb = await api(app, tb)
      .post(`/v1/connectors/${c.body.id}/inbound-token/rotate`)
      .send({ reason: 'ออก token รับ webhook ขาเข้า' })
      .expect(200);
    const pathB = new URL(rb.body.url).pathname;
    // ลายเซ็นด้วย secret ของ A ใช้กับ URL ของ B ไม่ได้
    await send(raw, sign(raw), pathB).expect(401);
    const r = await send(raw, sign(raw, 'secret-b-0001'), pathB).expect(200);
    expect(r.body.duplicate).toBe(false);
    const all = await plat.processedWebhookEvent.findMany({ where: { eventKey: 'evt-shared' } });
    expect(all.map((x) => x.tenantId).sort()).toEqual([tenantId, otherTenantId].sort());
  });

  it('แยก tenant (RLS): role แอปของ tenant อื่นมองไม่เห็นแถว · แก้ตัวตน/payload หรือลบแถวไม่ได้', async () => {
    await send(body({ id: 'evt-rls', type: 'invoice.paid' })).expect(200);
    const seen = await db.withTenant(otherTenantId, (tx) =>
      tx.processedWebhookEvent.count({ where: { eventKey: 'evt-rls' } }),
    );
    expect(seen).toBe(0);
    const own = await db.withTenant(tenantId, (tx) =>
      tx.processedWebhookEvent.count({ where: { eventKey: 'evt-rls' } }),
    );
    expect(own).toBe(1);
    const asApp = (sql: Prisma.Sql) =>
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.$executeRaw(sql);
      });
    await expect(
      asApp(
        Prisma.sql`UPDATE processed_webhook_event SET event_key = 'x' WHERE event_key = 'evt-rls'`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(
        Prisma.sql`UPDATE processed_webhook_event SET payload_enc = NULL WHERE event_key = 'evt-rls'`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(Prisma.sql`DELETE FROM processed_webhook_event WHERE event_key = 'evt-rls'`),
    ).rejects.toThrow(/permission denied/);
  });

  it('orders.changed → ตั้งรอบดึง order ทันที (connector เปิด pullOrders) ไม่ซ้ำถ้ามีรอบค้าง', async () => {
    await send(body({ id: 'evt-o1', type: 'orders.changed' })).expect(200);
    await send(body({ id: 'evt-o2', type: 'orders.changed' })).expect(200);
    // ประมวลผลทั้งสอง event ก่อนรอบดึงจะได้รัน
    const svc = app.get(InboundWebhookService);
    for (const r of await ledger()) await svc.process(tenantId, r.id);
    const pulls = await plat.job.findMany({
      where: { tenantId, type: CONNECTOR_PULL_JOB, status: 'PENDING' },
    });
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.payload).toEqual({ connectorId: conUuid });
    const rows = await ledger();
    expect(rows.map((r) => [r.status, r.result])).toEqual([
      ['PROCESSED', { triggers: ['pullOrders'], summary: { demo: true, type: 'orders.changed' } }],
      ['PROCESSED', { triggers: ['pullOrders'], summary: { demo: true, type: 'orders.changed' } }],
    ]);
  });

  it('adapter ปฏิเสธ event → FAILED พร้อมเหตุผล (ไม่ประมวลผลซ้ำ)', async () => {
    await send(body({ id: 'evt-f', type: 'demo.fail' })).expect(200);
    await drain();
    const [row] = await ledger();
    expect(row).toMatchObject({
      status: 'FAILED',
      lastError: { code: 'unsupported_event', message: 'demo ERP event rejected (simulated)' },
    });
    expect(row!.processedAt).toBeInstanceOf(Date);
  });

  it('connector หยุดชั่วคราว: รับเข้า ledger แต่ไม่ประมวลผล ไม่มี job ค้าง → เปิดใช้แล้วปลุกประมวลผล', async () => {
    await api(app, token).post(`/v1/connectors/${conId}/pause`).send({}).expect(200);
    await send(body({ id: 'evt-p', type: 'invoice.paid' })).expect(200);
    await drain();
    const [row] = await ledger();
    expect(row!.status).toBe('RECEIVED');
    expect(demo.inboundHandled(tenantId, conUuid)).toHaveLength(0);
    const open = () =>
      plat.job.count({
        where: { tenantId, type: INBOUND_PROCESS_JOB, status: { in: ['PENDING', 'RUNNING'] } },
      });
    expect(await open()).toBe(0);
    // เปิดใหม่ → wakeParked สร้าง job 1 ตัว (เรียกซ้ำไม่สร้างเพิ่ม) → ประมวลผล
    await api(app, token).post(`/v1/connectors/${conId}/resume`).send({}).expect(200);
    await app.get(ConnectorsService).wakeParked(tenantId, conUuid);
    expect(await open()).toBe(1);
    await drain();
    expect((await ledger())[0]!.status).toBe('PROCESSED');
    expect(demo.inboundHandled(tenantId, conUuid)).toHaveLength(1);
  });

  it('payload ถูกล้างแล้ว → FAILED payload_expired ทันที (ไม่ต้องรอ connector เปิดใหม่)', async () => {
    await api(app, token).post(`/v1/connectors/${conId}/pause`).send({}).expect(200);
    await send(body({ id: 'evt-px', type: 'invoice.paid' })).expect(200);
    const [row] = await ledger();
    await plat.$executeRaw`UPDATE processed_webhook_event SET payload_enc = NULL WHERE id = ${row!.id}::uuid`;
    await app.get(InboundWebhookService).process(tenantId, row!.id);
    expect((await ledger())[0]).toMatchObject({
      status: 'FAILED',
      lastError: { code: 'payload_expired' },
    });
  });

  it('บริษัทถูกระงับ → ไม่ประมวลผล คง RECEIVED', async () => {
    await send(body({ id: 'evt-susp', type: 'invoice.paid' })).expect(200);
    const [row] = await ledger();
    await plat.tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } });
    try {
      expect(await app.get(InboundWebhookService).process(tenantId, row!.id)).toEqual({
        skipped: 'tenant_inactive',
      });
    } finally {
      await plat.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } });
    }
    expect((await ledger())[0]!.status).toBe('RECEIVED');
    expect(demo.inboundHandled(tenantId, conUuid)).toHaveLength(0);
  });

  it('P1-ST1-T03 review S5: บริษัท read_only → รับเข้า ledger (RECEIVED ไม่มี job) → ชำระแล้วปลุกประมวลผล · ระงับ → 401', async () => {
    const open = () =>
      plat.job.count({
        where: { tenantId, type: INBOUND_PROCESS_JOB, status: { in: ['PENDING', 'RUNNING'] } },
      });
    await plat.tenant.update({ where: { id: tenantId }, data: { status: 'READ_ONLY' } });
    try {
      await send(body({ id: 'evt-ro', type: 'invoice.paid' })).expect(200);
      expect((await ledger())[0]!.status).toBe('RECEIVED');
      expect(await open()).toBe(0);
      await drain();
      expect(demo.inboundHandled(tenantId, conUuid)).toHaveLength(0);
      await app
        .get(TenantLifecycleService)
        .markPaid(tenantId, 'ลูกค้าชำระแล้ว ทดสอบปลุก inbound', { type: 'system' });
      expect(await open()).toBe(1);
      await drain();
      expect((await ledger())[0]!.status).toBe('PROCESSED');
      expect(demo.inboundHandled(tenantId, conUuid)).toHaveLength(1);
      await plat.tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } });
      await send(body({ id: 'evt-susp2', type: 'invoice.paid' })).expect(401);
    } finally {
      await plat.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } });
    }
  });

  it('handle ล้มแบบลองใหม่ได้ → รอ 1 นาทีก่อนลองครั้งที่ 2 (backoff ของ inbound.process)', async () => {
    await send(body({ id: 'evt-retry', type: 'demo.retry' })).expect(200);
    const before = Date.now();
    await queue.runOnce();
    const [job] = await inboundJobs();
    expect(job).toMatchObject({ status: 'PENDING', attempts: 1, maxAttempts: 6 });
    expect(job!.runAt.getTime()).toBeGreaterThanOrEqual(before + 55_000);
    expect(job!.runAt.getTime()).toBeLessThan(before + 120_000);
    expect((await ledger())[0]!.status).toBe('RECEIVED');
  });

  it('2 connector ของ adapter เดียวกันใน tenant เดียว: รหัส event เดียวกันไม่ชนกัน (unique ต่อ connector)', async () => {
    const co = await plat.company.create({
      data: {
        tenantId,
        legalName: `บริษัท สาขาสอง ${randomUUID().slice(0, 6)} จำกัด`,
        taxId: validTaxId(8800 + Math.floor(Math.random() * 99)),
      },
    });
    const r2 = await api(app, token)
      .post('/v1/connectors')
      .send({
        adapterKey: 'demo',
        companyId: encodeId('company', co.id),
        credentials: { apiKey: GOOD_KEY, inboundSecret: SECRET },
      })
      .expect(201);
    await api(app, token).post(`/v1/connectors/${r2.body.id}/resume`).send({}).expect(200);
    const path2 = new URL((await rotate(r2.body.id)).url).pathname;
    const raw = body({ id: 'evt-same', type: 'invoice.paid' });
    const a = await send(raw).expect(200);
    const b = await send(raw, sign(raw), path2).expect(200);
    expect(a.body.duplicate).toBe(false);
    expect(b.body.duplicate).toBe(false);
    expect(b.body.id).not.toBe(a.body.id);
    await drain();
    expect(demo.inboundHandled(tenantId, conUuid)).toHaveLength(1);
    expect(demo.inboundHandled(tenantId, tryDecodeId('connector', r2.body.id)!)).toHaveLength(1);
    // ซ้ำภายใน connector ที่ 2 ยังกันได้
    expect((await send(raw, sign(raw), path2).expect(200)).body).toMatchObject({
      duplicate: true,
      id: b.body.id,
    });
  });

  it('ออก/หมุน token: ต้องมีเหตุผล (422) · ไม่รับ Idempotency-Key (400) และไม่มี token ในตาราง idempotency', async () => {
    const r = await api(app, token).post(`/v1/connectors/${conId}/inbound-token/rotate`).send({});
    expect(r.status).toBe(422);
    const k = randomUUID();
    const r2 = await api(app, token)
      .post(`/v1/connectors/${conId}/inbound-token/rotate`)
      .set('Idempotency-Key', k)
      .send({ reason: 'หมุนตามรอบความปลอดภัย' });
    expect(r2.status).toBe(400);
    const stored = await plat.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM idempotency_key WHERE key = ${k}`;
    expect(stored[0]!.n).toBe(0);
    // token เดิมยังใช้ได้ (ไม่ได้หมุน)
    await send(body({ id: 'evt-idem', type: 'invoice.paid' })).expect(200);
  });

  it('occurredAt ต้องเป็น ISO 8601 ที่มี timezone → ไม่งั้น 400', async () => {
    for (const occurredAt of [
      '2026-11-18T09:00:00',
      '2026-11-18',
      'Nov 18 2026',
      '2026-11-18 09:00:00Z',
    ])
      await send(body({ id: `evt-tz-${occurredAt}`, type: 'x', occurredAt })).expect(400);
    await send(
      body({ id: 'evt-tz-ok', type: 'x', occurredAt: '2026-11-18T09:00:00.123+07:00' }),
    ).expect(200);
    expect((await ledger()).map((r) => r.eventKey)).toEqual(['evt-tz-ok']);
  });

  it('path ตัวพิมพ์ใหญ่: ยังอ่าน body ดิบ (ลายเซ็นผ่าน) และเพดาน 256 KB ใช้เหมือนกัน', async () => {
    const upper = inboundPath.replace('/v1/inbound/', '/V1/Inbound/');
    const raw = body({ id: 'evt-upper', type: 'invoice.paid' });
    await send(raw, sign(raw), upper).expect(200);
    const big = body({ id: 'evt-upper-big', type: 'x', pad: 'x'.repeat(INBOUND_MAX_BYTES) });
    const r = await send(big, sign(big), upper);
    expect(r.status).toBe(413);
  });

  it('เพิกถอน token / ยกเลิกการเชื่อม → URL เดิม 401', async () => {
    const raw = body({ id: 'evt-rv', type: 'invoice.paid' });
    await api(app, token)
      .post(`/v1/connectors/${conId}/inbound-token/revoke`)
      .send({ reason: 'เลิกใช้ webhook ขาเข้า' })
      .expect(200)
      .expect((r) => expect(r.body.inbound.tokenPrefix).toBeNull());
    await send(raw).expect(401);
    const t = await rotate();
    await api(app, token)
      .post(`/v1/connectors/${conId}/disconnect`)
      .send({ reason: 'ยกเลิกการเชื่อมทดสอบ' })
      .expect(200);
    await send(raw, sign(raw), new URL(t.url).pathname).expect(401);
    expect(await ledger()).toHaveLength(0);
  });

  it('adapter ที่ไม่รับ webhook ขาเข้า → ออก token ไม่ได้ (409) · catalog/connector บอก supported=false', async () => {
    await api(app, token)
      .post(`/v1/connectors/${conId}/disconnect`)
      .send({ reason: 'เปลี่ยนไปใช้ adapter อื่น' })
      .expect(200);
    const c = await api(app, token)
      .post('/v1/connectors')
      .send({
        adapterKey: 'fake-erp',
        settings: { baseUrl: 'https://erp.example.com' },
        credentials: { apiKey: GOOD_KEY },
      })
      .expect(201);
    expect(c.body.inbound).toEqual({ supported: false, tokenPrefix: null, tokenRotatedAt: null });
    const r = await api(app, token)
      .post(`/v1/connectors/${c.body.id}/inbound-token/rotate`)
      .send({ reason: 'ออก token รับ webhook ขาเข้า' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('inbound_not_supported');
  });

  it('rate limit ต่อ token → 429 (fail-closed ที่เก็บกลาง)', async () => {
    const unknown = `/v1/inbound/demo/whin_${'B'.repeat(43)}`;
    const raw = body({ id: 'evt-rl', type: 'x' });
    let last = 0;
    for (let i = 0; i < 41; i++) last = (await send(raw, sign(raw), unknown)).status;
    expect(last).toBe(429);
  });

  it('retention: payload เกิน 30 วันถูกล้าง (RECEIVED → FAILED payload_expired) · ไม่ลบแถว ledger', async () => {
    await send(body({ id: 'evt-old', type: 'invoice.paid' })).expect(200);
    await send(body({ id: 'evt-older', type: 'invoice.paid' })).expect(200);
    await send(body({ id: 'evt-new', type: 'invoice.paid' })).expect(200);
    await plat.$executeRaw`UPDATE processed_webhook_event SET status = 'PROCESSED', processed_at = now() WHERE event_key = 'evt-old'`;
    await plat.$executeRaw`UPDATE processed_webhook_event SET received_at = now() - interval '31 days' WHERE event_key = 'evt-old'`;
    await plat.$executeRaw`UPDATE processed_webhook_event SET received_at = now() - interval '800 days' WHERE event_key = 'evt-older'`;
    const r = await app.get(InboundWebhookService).purge();
    expect(r).toEqual({ payloadsCleared: 2, expired: 1 });
    const rows = await ledger();
    expect(rows.map((x) => [x.eventKey, x.status, x.payloadEnc === null])).toEqual([
      ['evt-older', 'FAILED', true],
      ['evt-old', 'PROCESSED', true],
      ['evt-new', 'RECEIVED', false],
    ]);
    expect(rows[0]!.lastError).toMatchObject({ code: 'payload_expired' });
  });
});
