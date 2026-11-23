import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { DEMO_MAX_SCOPES, DemoAdapter } from '../src/erp-adapters/demo/demo.adapter';
import { ConnectorsService } from '../src/modules/erp/connectors.service';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { ERP_SINK } from '../src/modules/erp/erp-adapter.sink';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../src/modules/integration/outbox.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { FakeErpAdapter } from './fake-erp-adapter';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * D-81 กลุ่ม (F) D68-47/57 (+ เงื่อนไข D68-09) และ (I) D68-58/96 (PO 23 พ.ย. 2569)
 * (F) AUTH → connector ERROR + แจ้ง admin ทันที ไม่ retry · healthCheck ล้ม → พักทั้งคิว / ผ่าน → เปิดต่อ ·
 *     เอกสารไม่ถูกส่ง ERP (FAILED_FINAL / SKIPPED ที่ต้องมีคนทำ) → แจ้งฝ่ายบัญชี (`payments:record`)
 * (I) tenant sandbox (mode test) สร้าง/ใช้ DemoProvider ได้ (แม้ demo ใช้ได้เฉพาะ sandbox ใน production) · connector จริงใน sandbox ยังปิด
 */
describe('D-81 (F)(I) connector: AUTH/health หยุดคิว · แจ้งบัญชี · sandbox ใช้ DemoProvider', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  let demo: DemoAdapter;
  const fake = new FakeErpAdapter('fake-erp');
  let tenantId: string;
  let sandboxId: string;
  let token: string;
  let sbToken: string;
  let admin: string;
  let accounting: string;
  let planner: string;
  let seq = 0;
  const demoCreds = { apiKey: 'demo-key-d68' };

  const uuid = (id: string) => tryDecodeId('connector', id)!;
  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };
  const cmd = (id: string) => plat.integrationOutbox.findUniqueOrThrow({ where: { id } });
  const notes = (tid: string, templateCode: string) =>
    plat.notification.findMany({ where: { tenantId: tid, templateCode, channel: 'in_app' } });

  async function member(tid: string, role: string) {
    const r = await plat.role.findFirstOrThrow({ where: { tenantId: tid, code: role } });
    const u = await plat.appUser.create({
      data: {
        tenantId: tid,
        email: `d68-${++seq}-${role}@d68.test`,
        name: `${role} ${seq}`,
        status: 'ACTIVE',
      },
    });
    await plat.userRole.create({ data: { tenantId: tid, userId: u.id, roleId: r.id } });
    return u.id;
  }

  async function connector(
    tok: string,
    adapterKey = 'demo',
    settings: Record<string, string> = {},
  ) {
    const r = await api(app, tok)
      .post('/v1/connectors')
      .send({ taxDocumentOwner: 'TMS', adapterKey, credentials: demoCreds, settings });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await api(app, tok).post(`/v1/connectors/${r.body.id}/resume`).send({}).expect(200);
    return { id: r.body.id as string, uuid: uuid(r.body.id) };
  }

  async function enqueue(
    tid: string,
    connectorId: string,
    n: number,
    operation = 'PUSH_INVOICE',
    entityType = 'invoice',
  ) {
    const localId = randomUUID();
    const { id } = await db.withTenant(tid, (tx) =>
      app.get(OutboxService).enqueueCommand(tx, {
        tenantId: tid,
        kind: 'ADAPTER',
        sink: ERP_SINK,
        targetId: connectorId,
        operation,
        entityType,
        localId,
        payload: {
          document: {
            id: localId,
            number: `INV-00000-2611-${String(n).padStart(4, '0')}`,
            totals: { total: '1070.00' },
          },
        },
      }),
    );
    return id;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    const reg = app.get(ErpAdapterRegistry);
    demo = reg.get('demo') as DemoAdapter;
    reg.replace(fake);
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ทดสอบคิวเชื่อมบัญชี' })).id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    sandboxId = (
      await plat.tenant.create({
        data: { name: 'sandbox D68', mode: 'test', liveTenantId: tenantId, planCode: 'ent' },
      })
    ).id;
    admin = await member(tenantId, 'admin');
    accounting = await member(tenantId, 'accounting');
    planner = await member(tenantId, 'planner');
    token = await tokenFor(tenantId, '*', admin);
    sbToken = await tokenFor(sandboxId, '*', admin);
  });
  beforeEach(async () => {
    demo.reset();
    fake.reset();
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
    await plat.notification.deleteMany({});
  });
  afterAll(async () => {
    app.get(ErpAdapterRegistry).unregister(fake.key);
    await app.close();
    await plat.$disconnect();
  });

  it('D68-47 AUTH (401/403): connector → ERROR ทันที + แจ้ง admin · คำสั่งคง PENDING ไม่ยิงซ้ำ · ทดสอบผ่าน → ส่งต่อ', async () => {
    const con = await connector(token);
    // ตั้งหลังเปิดใช้ (demo ฉีด AUTH ให้ healthCheck ด้วย — เปิดใช้ไม่ผ่าน)
    await api(app, token)
      .patch(`/v1/connectors/${con.id}`)
      .send({ settings: { failMode: 'AUTH' } })
      .expect(200);
    const a = await enqueue(tenantId, con.uuid, 1);
    const b = await enqueue(tenantId, con.uuid, 2);
    await drain();
    expect((await plat.connector.findUniqueOrThrow({ where: { id: con.uuid } })).status).toBe(
      'ERROR',
    );
    for (const id of [a, b]) expect(await cmd(id)).toMatchObject({ status: 'PENDING', attempt: 0 });
    // แจ้ง admin (settings:write) ทันที — ไม่ใช่ฝ่ายบัญชี/ผู้วางแผน
    const down = await notes(tenantId, 'connector.error');
    expect(down.map((n) => n.recipientId)).toContain(admin);
    expect(down.map((n) => n.recipientId)).not.toContain(planner);
    // ไม่ retry ด้วย credential เดิม: รอบถัดไปพักโดยไม่เรียกปลายทาง
    const calls = demo.documents(tenantId, con.uuid).length;
    await drain();
    await drain();
    expect(demo.documents(tenantId, con.uuid)).toHaveLength(calls);
    for (const id of [a, b])
      expect(await cmd(id)).toMatchObject({
        status: 'PENDING',
        attempt: 0,
        lastError: expect.objectContaining({ code: 'connector_not_active' }),
      });
    // AUTH ไม่ใช่เอกสาร "ส่งไม่สำเร็จ" (ยังรอ) → ไม่แจ้งบัญชี
    expect(await notes(tenantId, 'connector.document_not_sent')).toHaveLength(0);
    await api(app, token).patch(`/v1/connectors/${con.id}`).send({ settings: {} }).expect(200);
    await api(app, token).post(`/v1/connectors/${con.id}/health`).expect(200);
    await drain();
    expect((await cmd(a)).status).toBe('DONE');
    expect((await cmd(b)).status).toBe('DONE');
  });

  it('D68-57 healthCheck ล้ม (ACTIVE แต่ health_failing_since มีค่า) → พักทั้งคิว ไม่ยิง ไม่เสียครั้ง · ตรวจซ้ำผ่าน → ปลุกคิวส่งต่อ', async () => {
    const con = await connector(token);
    await plat.connector.update({
      where: { id: con.uuid },
      data: { healthFailingSince: new Date(Date.now() - 60_000), lastHealthOk: false },
    });
    const a = await enqueue(tenantId, con.uuid, 10);
    await drain();
    expect(await cmd(a)).toMatchObject({
      status: 'PENDING',
      errorClass: 'AUTH',
      attempt: 0,
      lastError: expect.objectContaining({ code: 'connector_unhealthy' }),
    });
    expect((await cmd(a)).nextRunAt.getTime()).toBeGreaterThan(Date.now()); // พักไว้ ไม่วนทันที
    expect(demo.documents(tenantId, con.uuid)).toHaveLength(0);
    // worker ตรวจซ้ำ (ทุก 5 นาที) — demo ตอบผ่าน → ล้างเวลา + ปลุกคิว (ไม่ต้องรอรอบพัก 15 นาที)
    await app.get(ConnectorsService).recheckUnhealthy();
    const row = await plat.connector.findUniqueOrThrow({ where: { id: con.uuid } });
    expect(row).toMatchObject({ status: 'ACTIVE', healthFailingSince: null, lastHealthOk: true });
    expect((await cmd(a)).nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
    await dispatcher.drain();
    expect((await cmd(a)).status).toBe('DONE');

    // ผู้ดูแลกด "ทดสอบการเชื่อมต่อ" ผ่าน = เปิดคิวต่อทันทีเช่นกัน
    await plat.connector.update({
      where: { id: con.uuid },
      data: { healthFailingSince: new Date() },
    });
    const b = await enqueue(tenantId, con.uuid, 11);
    await drain();
    expect(await cmd(b)).toMatchObject({ status: 'PENDING', errorClass: 'AUTH' });
    const h = await api(app, token).post(`/v1/connectors/${con.id}/health`).expect(200);
    expect(h.body.ok).toBe(true);
    expect((await cmd(b)).nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
    await dispatcher.drain();
    expect((await cmd(b)).status).toBe('DONE');
  });

  it('D68-57 เอกสารไม่ถูกส่ง ERP → แจ้งฝ่ายบัญชี (payments:record): FAILED_FINAL / SKIPPED ที่ต้องทำเอง · ส่งถึงแล้ว/ยกเลิกก่อนส่ง = ไม่แจ้ง', async () => {
    const con = await connector(token, 'demo', { failMode: 'VALIDATION' });
    const v = await enqueue(tenantId, con.uuid, 20);
    await drain();
    expect(await cmd(v)).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    const n = await notes(tenantId, 'connector.document_not_sent');
    const who = new Set(n.map((x) => x.recipientId));
    expect(who.has(accounting)).toBe(true);
    expect(who.has(planner)).toBe(false);
    const mine = n.find((x) => x.recipientId === accounting)!;
    expect(mine.title).toBe('เอกสารไม่ถูกส่งเข้าระบบบัญชี');
    expect(mine.body).toContain('INV-00000-2611-0020');
    expect(mine.body).toContain('customer_unmapped');
    expect(mine.link).toBe('/bill');
    expect(mine.relatedEntityType).toBe('invoice');
    expect(n.every((x) => x.tenantId === tenantId)).toBe(true);
    // อีเมลด้วย (ค่าเริ่มต้นของหมวด "การเชื่อมต่อขัดข้อง")
    expect(
      await plat.notification.count({
        where: {
          templateCode: 'connector.document_not_sent',
          channel: 'email',
          recipientId: accounting,
        },
      }),
    ).toBeGreaterThan(0);

    // SKIPPED ที่บัญชีต้องทำเอง (ยกเลิกเอกสารในระบบบัญชีเอง) → แจ้ง
    await plat.notification.deleteMany({});
    await api(app, token).patch(`/v1/connectors/${con.id}`).send({ settings: {} }).expect(200);
    const voidCmd = await enqueue(tenantId, con.uuid, 21, 'VOID_DOCUMENT');
    await drain();
    expect(await cmd(voidCmd)).toMatchObject({ status: 'SKIPPED' });
    const vn = await notes(tenantId, 'connector.document_not_sent');
    expect(vn.find((x) => x.recipientId === accounting)?.body).toContain('ยกเลิกในระบบบัญชีเอง');

    // ส่งสำเร็จ / คำสั่งดึงข้อมูลล้ม = ไม่แจ้ง
    await plat.notification.deleteMany({});
    const ok = await enqueue(tenantId, con.uuid, 22);
    await drain();
    expect((await cmd(ok)).status).toBe('DONE');
    expect(await notes(tenantId, 'connector.document_not_sent')).toHaveLength(0);

    // dead-letter จาก lease หมดในครั้งสุดท้าย (worker ตาย) → แจ้งเช่นกัน
    const dead = await enqueue(tenantId, con.uuid, 23);
    await plat.integrationOutbox.update({
      where: { id: dead },
      data: {
        status: 'IN_FLIGHT',
        attempt: 7,
        maxAttempt: 7,
        leaseId: randomUUID(),
        leaseUntil: new Date(Date.now() - 1000),
      },
    });
    await dispatcher.drain();
    expect(await cmd(dead)).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'AMBIGUOUS' });
    const dn = await notes(tenantId, 'connector.document_not_sent');
    const deadNote = dn.find((x) => x.recipientId === accounting)!;
    expect(deadNote.body).toContain('INV-00000-2611-0023');
    // review M2: AMBIGUOUS (lease หมด) = อาจถึงระบบบัญชีแล้ว
    expect(deadNote.body).toContain(
      'อาจถึงระบบบัญชีแล้ว — ตรวจในระบบบัญชีก่อนส่งใหม่หรือบันทึกเอง',
    );
    expect(deadNote.payload).toMatchObject({ errorClass: 'AMBIGUOUS', code: 'lease_expired' });
  });

  it('review M1: ล้ม 50 ใบ (connector + รหัสเดียวกัน ใน 1 ชม.) → แจ้งในระบบ 1 ฉบับ + อีเมล 1 ฉบับต่อผู้รับ (นับรวม + ตัวอย่าง 5 เลข) · อ่านแล้ว = แจ้งใหม่', async () => {
    const con = await connector(token);
    await api(app, token)
      .patch(`/v1/connectors/${con.id}`)
      .send({ settings: { failMode: 'VALIDATION' } })
      .expect(200);
    for (let i = 0; i < 50; i++) await enqueue(tenantId, con.uuid, 100 + i);
    await drain();
    const inApp = await notes(tenantId, 'connector.document_not_sent');
    const mine = inApp.filter((x) => x.recipientId === accounting);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.payload).toMatchObject({ count: 50, code: 'customer_unmapped' });
    expect((mine[0]!.payload as { documentNos: string[] }).documentNos).toHaveLength(5);
    expect(mine[0]!.body).toContain('เอกสาร 50 ใบ');
    expect(
      await plat.notification.count({
        where: {
          templateCode: 'connector.document_not_sent',
          channel: 'email',
          recipientId: accounting,
        },
      }),
    ).toBe(1);
    // อ่านแล้ว → ใบถัดไปเป็นฉบับใหม่
    await plat.notification.update({ where: { id: mine[0]!.id }, data: { readAt: new Date() } });
    await enqueue(tenantId, con.uuid, 200);
    await drain();
    const again = (await notes(tenantId, 'connector.document_not_sent')).filter(
      (x) => x.recipientId === accounting,
    );
    expect(again).toHaveLength(2);
  });

  it('review M1/L1: ยกเลิกการเชื่อมที่มีคำสั่งค้าง → แจ้งบัญชีฉบับเดียว (จำนวนค้าง) ไม่แจ้งทีละคำสั่ง · DemoProvider ทิ้งข้อมูลของ connector', async () => {
    const con = await connector(token);
    const first = await enqueue(tenantId, con.uuid, 300);
    await drain();
    expect((await cmd(first)).status).toBe('DONE');
    expect(demo.documents(tenantId, con.uuid)).toHaveLength(1);
    await api(app, token).post(`/v1/connectors/${con.id}/pause`).send({}).expect(200);
    for (let i = 0; i < 3; i++) await enqueue(tenantId, con.uuid, 301 + i);
    await api(app, token)
      .post(`/v1/connectors/${con.id}/disconnect`)
      .send({ reason: 'เลิกใช้โปรแกรมบัญชีนี้' })
      .expect(200);
    expect(demo.documents(tenantId, con.uuid)).toHaveLength(0); // ทิ้งแล้ว
    let n = (await notes(tenantId, 'connector.document_not_sent')).filter(
      (x) => x.recipientId === accounting,
    );
    expect(n).toHaveLength(1);
    expect(n[0]!.payload).toMatchObject({ count: 3, code: 'connector_disconnected' });
    expect(n[0]!.body).toContain('เอกสาร 3 ใบ');
    await drain(); // คำสั่งค้างถูกข้าม — ไม่แจ้งเพิ่ม
    n = (await notes(tenantId, 'connector.document_not_sent')).filter(
      (x) => x.recipientId === accounting,
    );
    expect(n).toHaveLength(1);
    expect(n[0]!.payload).toMatchObject({ count: 3 });
  });

  it('review L1: DemoProvider เก็บข้อมูลไม่เกิน DEMO_MAX_SCOPES ชุด (LRU)', () => {
    const d = new DemoAdapter();
    d.setMasterCodes('t-keep', 'c', 'UNIT', []);
    for (let i = 0; i < DEMO_MAX_SCOPES + 10; i++) {
      d.setMasterCodes(`t${i}`, 'c', 'UNIT', []);
      d.setMasterCodes('t-keep', 'c', 'UNIT', []); // ใช้ล่าสุดเสมอ = ไม่ถูกทิ้ง
    }
    const size = (d as unknown as { scopes: Map<string, unknown> }).scopes.size;
    expect(size).toBe(DEMO_MAX_SCOPES);
    expect((d as unknown as { scopes: Map<string, unknown> }).scopes.has('t-keep:c')).toBe(true);
    expect((d as unknown as { scopes: Map<string, unknown> }).scopes.has('t0:c')).toBe(false);
  });

  it('review L3: recheckUnhealthy ไม่ซ้อนรอบ (รอบก่อนยังไม่จบ = ข้าม)', async () => {
    const con = await connector(token);
    await plat.connector.update({
      where: { id: con.uuid },
      data: { healthFailingSince: new Date() },
    });
    const svc = app.get(ConnectorsService);
    const [a, b] = await Promise.all([svc.recheckUnhealthy(), svc.recheckUnhealthy()]);
    expect([a, b].sort()).toEqual([0, 1]);
    expect(await svc.recheckUnhealthy()).toBe(0); // ผ่านแล้ว (ไม่มีตัวที่ล้ม) — และ flag ถูกปล่อย
  });

  it('D68-58/96 sandbox: สร้าง/ทดสอบ/ส่งผ่าน DemoProvider ได้ · adapter จริง 403 · catalog เห็นเฉพาะ demo · แยกข้อมูลจากบริษัทจริง', async () => {
    const cat = await api(app, sbToken).get('/v1/connectors/adapters').expect(200);
    const keys = (cat.body.data ?? cat.body).map((a: { key: string }) => a.key);
    expect(keys).toContain('demo');
    expect(keys).not.toContain('fake-erp');
    const real = await api(app, sbToken)
      .post('/v1/connectors')
      .send({ taxDocumentOwner: 'TMS', adapterKey: 'fake-erp', credentials: demoCreds });
    expect(real.status).toBe(403);
    expect(real.body.code).toBe('sandbox_unsupported');
    expect(
      await plat.connector.count({ where: { tenantId: sandboxId, adapterKey: 'fake-erp' } }),
    ).toBe(0);

    const con = await connector(sbToken);
    const eff = await api(app, sbToken).get('/v1/connectors/effective').expect(200);
    expect(eff.body).toMatchObject({ adapterKey: 'demo', adapterAvailable: true, sending: true });
    const c = await enqueue(sandboxId, con.uuid, 30);
    await drain();
    expect((await cmd(c)).status).toBe('DONE');
    expect(demo.documents(sandboxId, con.uuid).map((d) => d.number)).toEqual([
      'INV-00000-2611-0030',
    ]);
    // แยกข้อมูล: บริษัทจริงไม่เห็น connector ของ sandbox (404) และกลับกัน
    await api(app, token).get(`/v1/connectors/${con.id}`).expect(404);
    const live = await connector(token);
    await api(app, sbToken).get(`/v1/connectors/${live.id}`).expect(404);
    const list = await api(app, token).get('/v1/connectors').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(con.id);
  });

  it('D68-96 environment ที่ demo ใช้ได้เฉพาะ sandbox (production cluster): sandbox ใช้ได้ · บริษัทจริงสร้าง/ส่งไม่ได้', async () => {
    const reg = app.get(ErpAdapterRegistry);
    const env = { node: process.env.NODE_ENV, demo: process.env.ERP_DEMO_ADAPTERS };
    const liveCon = await connector(token); // ค้างจากก่อนเปลี่ยน environment
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ERP_DEMO_ADAPTERS;
      reg.replace(demo); // ลงทะเบียนใหม่ใน "production" → demo ใช้ได้เฉพาะ sandbox
      expect(reg.isSandboxOnly('demo')).toBe(true);
      expect(reg.usableIn('demo', true)).toBe(demo);
      expect(reg.usableIn('demo', false)).toBeNull();
      expect(reg.usableIn('fake-erp', true)).toBeNull();
      expect(reg.usableIn('fake-erp', false)).toBe(fake);
      process.env.NODE_ENV = env.node; // คำขอ HTTP ใน test ต้องใช้ env เดิม (dev token)

      const r = await api(app, token)
        .post('/v1/connectors')
        .send({ taxDocumentOwner: 'TMS', adapterKey: 'demo', credentials: demoCreds });
      expect(r.status).toBe(422);
      expect(r.body.errors[0]).toMatchObject({ field: 'adapterKey', code: 'unknown_adapter' });
      const cat = await api(app, token).get('/v1/connectors/adapters').expect(200);
      expect((cat.body.data ?? cat.body).map((a: { key: string }) => a.key)).not.toContain('demo');
      // connector demo ที่ค้างของบริษัทจริง: ใช้ไม่ได้ ไม่มีขั้น sync · คำสั่งพักไว้ ไม่ถึง demo
      const eff = await api(app, token).get('/v1/connectors/effective').expect(200);
      expect(eff.body).toMatchObject({ adapterAvailable: false, sending: false, capabilities: [] });
      const lc = await enqueue(tenantId, liveCon.uuid, 40);
      await drain();
      expect(await cmd(lc)).toMatchObject({ status: 'PENDING', errorClass: 'AUTH' });
      expect(demo.documents(tenantId, liveCon.uuid)).toHaveLength(0);

      // sandbox: สร้าง + ส่งได้
      await plat.connector.update({
        where: { id: liveCon.uuid },
        data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
      });
      const sb = await connector(sbToken);
      const c = await enqueue(sandboxId, sb.uuid, 41);
      await drain();
      expect((await cmd(c)).status).toBe('DONE');
    } finally {
      process.env.NODE_ENV = env.node;
      if (env.demo === undefined) delete process.env.ERP_DEMO_ADAPTERS;
      else process.env.ERP_DEMO_ADAPTERS = env.demo;
      reg.replace(demo);
    }
    expect(reg.isSandboxOnly('demo')).toBe(false);
  });
});
