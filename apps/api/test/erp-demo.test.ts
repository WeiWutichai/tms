import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FieldCipher } from '../src/common/crypto';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { DemoAdapter, demoExternalSuffix } from '../src/erp-adapters/demo/demo.adapter';
import { JobQueue } from '../src/jobs/job-queue.service';
import {
  CONNECTOR_PULL_JOB,
  ConnectorIntakeService,
} from '../src/modules/connectors/connector-intake.service';
import { ConnectorPullScheduler } from '../src/modules/connectors/connector-pull.scheduler';
import { ConnectorsService } from '../src/modules/erp/connectors.service';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { ERP_SINK } from '../src/modules/erp/erp-adapter.sink';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../src/modules/integration/outbox.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { FakeErpAdapter, GOOD_KEY } from './fake-erp-adapter';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST7-T14 StandaloneProvider + DemoProvider (docs/04 G3; docs/01 §6.1–6.3) — ผ่าน API + outbox (ทางเดียวกับ worker)
 * เกณฑ์ตรวจรับ: tenant ไม่มี connector = Standalone ไม่มีขั้น sync · tenant demo: เอกสารที่ส่ง (PUSH_INVOICE) ถึง DemoProvider
 */
describe('Standalone + DemoProvider (ST7-T14)', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  let demo: DemoAdapter;
  const fake = new FakeErpAdapter('fake-erp');
  let tenantId: string;
  let token: string;
  const demoCreds = { apiKey: 'demo-key-0001' };

  const uuid = (id: string) => tryDecodeId('connector', id)!;
  const due = () =>
    plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                      WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
  const drain = async () => {
    await due();
    await dispatcher.drain();
  };
  const cmd = (id: string) => plat.integrationOutbox.findUniqueOrThrow({ where: { id } });
  /** เลขภายนอกที่ DemoProvider ให้กับคำสั่งนี้ (hash ของ tenant, connector, ประเภท, idempotency key) */
  const extOf = async (connectorId: string, id: string) =>
    demoExternalSuffix(`${tenantId}:${connectorId}`, 'invoice', (await cmd(id)).idempotencyKey);

  async function company(n: number) {
    const c = await plat.company.create({
      data: { tenantId, legalName: `บริษัท สาธิต ${n} จำกัด`, taxId: validTaxId(9300 + n) },
    });
    return encodeId('company', c.id);
  }

  async function demoConnector(
    body: Record<string, unknown> = {},
    opts: { activate?: boolean } = { activate: true },
  ) {
    const r = await api(app, token)
      .post('/v1/connectors')
      .send({ taxDocumentOwner: 'TMS', adapterKey: 'demo', credentials: demoCreds, ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    if (opts.activate !== false)
      await api(app, token).post(`/v1/connectors/${r.body.id}/resume`).send({}).expect(200);
    return { id: r.body.id as string, uuid: uuid(r.body.id) };
  }

  async function setSettings(conId: string, settings: Record<string, string>) {
    await api(app, token).patch(`/v1/connectors/${conId}`).send({ settings }).expect(200);
  }

  async function enqueue(
    connectorId: string,
    operation: string,
    payload: Record<string, unknown>,
    localId = randomUUID(),
  ) {
    const outbox = app.get(OutboxService);
    const { id } = await db.withTenant(tenantId, (tx) =>
      outbox.enqueueCommand(tx, {
        tenantId,
        kind: 'ADAPTER',
        sink: ERP_SINK,
        targetId: connectorId,
        operation,
        entityType: 'invoice',
        localId,
        payload,
      }),
    );
    return id;
  }
  const invoice = (n: number, total = '1070.00') => {
    const id = randomUUID();
    return {
      id,
      payload: {
        document: { id, number: `INV-00000-2611-${String(n).padStart(4, '0')}`, totals: { total } },
      },
    };
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    const reg = app.get(ErpAdapterRegistry);
    demo = reg.get('demo') as DemoAdapter;
    reg.replace(fake);
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท สาธิตเชื่อมบัญชี' })).id;
    // ผู้ออกเอกสารค่าเริ่มต้น (ใบที่ดึงเข้ามาต้องมีนิติบุคคล/สาขา)
    const issuer = await plat.company.create({
      data: { tenantId, legalName: 'บริษัท สาธิต ผู้ออกบิล จำกัด', taxId: validTaxId(9300) },
    });
    await plat.branch.create({
      data: {
        tenantId,
        companyId: issuer.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        isDefaultIssuer: true,
        address: { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
      },
    });
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    const userId = (
      await plat.appUser.create({
        data: { tenantId, email: 'admin@demo-erp.test', name: 'ผู้ดูแล สาธิต', status: 'ACTIVE' },
      })
    ).id;
    token = await tokenFor(tenantId, '*', userId);
    // มีหลายนิติบุคคลใน test → ตั้งค่าเริ่มต้นของ routing (ใบที่ดึงเข้ามาออกในนามผู้ออกบิลหลัก)
    await api(app, token)
      .patch('/v1/settings')
      .send({
        values: {
          'routing.invoiceAsCompanyId': encodeId('company', issuer.id),
          'routing.tenderAsCompanyId': encodeId('company', issuer.id),
        },
      })
      .expect(200);
  });
  beforeEach(async () => {
    demo.reset();
    fake.reset();
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    await plat.$executeRaw`UPDATE job SET status = 'SKIPPED' WHERE status IN ('PENDING', 'RUNNING')`;
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
  });
  afterAll(async () => {
    app.get(ErpAdapterRegistry).unregister(fake.key);
    await app.close();
    await plat.$disconnect();
  });

  it('Standalone เป็นค่าเริ่มต้น: ไม่มี connector = ไม่มีขั้น sync ทุกประเภทเอกสาร · demo ไม่ถูกเลือกให้เอง', async () => {
    const eff = await api(app, token).get('/v1/connectors/effective').expect(200);
    expect(eff.body).toMatchObject({
      standalone: true,
      adapterKey: 'standalone',
      capabilities: [],
      sending: false,
      documentSync: {
        invoice: 'NOT_APPLICABLE',
        creditNote: 'NOT_APPLICABLE',
        debitNote: 'NOT_APPLICABLE',
        settlement: 'NOT_APPLICABLE',
      },
    });
    expect(
      await plat.connector.count({ where: { tenantId, status: { not: 'DISCONNECTED' } } }),
    ).toBe(0);
    // แพ็กเกจที่ไม่มี conn ก็ตอบ Standalone เหมือนกัน
    const t2 = (await createTenant(plat, 'บริษัท ไม่มีแพ็กเกจเชื่อม')).id;
    const eff2 = await api(app, await tokenFor(t2, 'settings:read'))
      .get('/v1/connectors/effective')
      .expect(200);
    expect(eff2.body.documentSync.invoice).toBe('NOT_APPLICABLE');
  });

  it('catalog ติดป้าย demo · ช่องตั้งค่ามีตัวเลือก · ค่านอกรายการ 422 · credential ไม่ส่งกลับ', async () => {
    const cat = await api(app, token).get('/v1/connectors/adapters').expect(200);
    const d = cat.body.data.find((a: { key: string }) => a.key === 'demo');
    expect(d).toMatchObject({ key: 'demo', demo: true, displayName: 'Demo ERP (simulated)' });
    expect(cat.body.data.find((a: { key: string }) => a.key === 'fake-erp').demo).toBe(false);
    expect(d.capabilities).toEqual([
      'pullOrders',
      'pushInvoice',
      'pushCreditNote',
      'pushSettlement',
      'fetchDocument',
      'fetchPaymentStatus',
      'listDocuments',
      'replaceDocument',
    ]);
    const fm = d.configFields.find((f: { key: string }) => f.key === 'failMode');
    expect(fm.options).toContain('AMBIGUOUS');
    expect(d.configFields.find((f: { key: string }) => f.key === 'apiKey')).toMatchObject({
      secret: true,
      options: null,
    });
    const bad = await api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'demo',
        credentials: demoCreds,
        settings: { failMode: 'EXPLODE' },
      });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({
      field: 'settings.failMode',
      code: 'invalid_option',
    });
    const { id } = await demoConnector({}, { activate: false });
    const got = await api(app, token).get(`/v1/connectors/${id}`).expect(200);
    expect(JSON.stringify(got.body)).not.toContain(demoCreds.apiKey);
    expect(got.body).toMatchObject({
      adapterKey: 'demo',
      status: 'PAUSED',
      credentialKeys: ['apiKey'],
    });
  });

  it('เกณฑ์ตรวจรับ: tenant demo — PUSH_INVOICE ผ่าน outbox ถึง DemoProvider → DONE + เลขภายนอก · ส่งซ้ำ key เดิมไม่ซ้ำ · sync = PUSH', async () => {
    const con = await demoConnector();
    const eff = await api(app, token).get('/v1/connectors/effective').expect(200);
    expect(eff.body).toMatchObject({
      standalone: false,
      adapterKey: 'demo',
      sending: true,
      documentSync: { invoice: 'PUSH', creditNote: 'PUSH', settlement: 'PUSH' },
    });
    const inv = invoice(1);
    const id = await enqueue(con.uuid, 'PUSH_INVOICE', inv.payload, inv.id);
    await drain();
    const h = await extOf(con.uuid, id);
    expect(await cmd(id)).toMatchObject({
      status: 'DONE',
      result: {
        externalId: `DEMO-INV-${h}`,
        externalDocNo: `DMINV${h.slice(0, 10)}`,
        externalVersion: '1',
      },
    });
    const docs = demo.documents(tenantId, con.uuid);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.document).toMatchObject({ id: inv.id, number: 'INV-00000-2611-0001' });
    // คำสั่งเดิม (idempotency key เดิม) ไม่สร้างคำสั่งใหม่ · payload เดียวกันคำสั่งอื่น = ERP ตอบซ้ำ → DONE (DUPLICATE)
    const again = await enqueue(con.uuid, 'PUSH_INVOICE', inv.payload, inv.id);
    expect(again).toBe(id);
    const other = await enqueue(con.uuid, 'PUSH_INVOICE', inv.payload, randomUUID());
    await drain();
    expect(await cmd(other)).toMatchObject({ status: 'DONE', errorClass: 'DUPLICATE' });
    expect(demo.documents(tenantId, con.uuid)).toHaveLength(1);
    // อ่านกลับ: fetch + สถานะรับชำระ (ตามค่าตั้ง paymentStatus)
    await setSettings(con.id, { paymentStatus: 'PAID' });
    const ref = {
      entityType: 'invoice',
      localId: inv.id,
      number: 'INV-00000-2611-0001',
      externalId: `DEMO-INV-${h}`,
    };
    const f = await enqueue(con.uuid, 'FETCH_DOCUMENT', { ref });
    const p = await enqueue(con.uuid, 'FETCH_PAYMENT_STATUS', { ref });
    await drain();
    expect((await cmd(f)).result).toMatchObject({
      found: true,
      document: { number: 'INV-00000-2611-0001' },
    });
    expect((await cmd(p)).result).toMatchObject({
      found: true,
      paymentStatus: { status: 'PAID', paidAmount: '1070.00' },
    });
  });

  it('ฉีด error ผ่านค่าตั้ง → สถานะ outbox ตาม docs/01 §6.3 (TRANSIENT/VALIDATION/PERIOD_CLOSED/AUTH)', async () => {
    const con = await demoConnector();
    await setSettings(con.id, { failMode: 'TRANSIENT' });
    const t = await enqueue(con.uuid, 'PUSH_INVOICE', invoice(10).payload);
    await drain();
    expect(await cmd(t)).toMatchObject({
      status: 'FAILED_RETRYABLE',
      errorClass: 'TRANSIENT',
      attempt: 1,
    });
    expect((await cmd(t)).nextRunAt.getTime()).toBeGreaterThan(Date.now());
    // ตัดออกจากรอบถัดไป (drain เลื่อนทุกคำสั่งให้ถึงเวลา — ค่าตั้งใหม่จะใช้กับคำสั่งนี้ด้วย) — การฟื้นจาก TRANSIENT อยู่ใน test ถัดไป
    await plat.integrationOutbox.update({ where: { id: t }, data: { status: 'SKIPPED' } });

    await setSettings(con.id, { failMode: 'VALIDATION' });
    const v = await enqueue(con.uuid, 'PUSH_INVOICE', invoice(11).payload);
    await drain();
    expect(await cmd(v)).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    expect((await cmd(v)).lastError).toMatchObject({
      code: 'customer_unmapped',
      fields: [{ field: 'customer.externalId', code: 'unknown' }],
    });

    await setSettings(con.id, { failMode: 'PERIOD_CLOSED' });
    const pc = await enqueue(con.uuid, 'PUSH_INVOICE', invoice(12).payload);
    await drain();
    expect(await cmd(pc)).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'PERIOD_CLOSED' });

    await setSettings(con.id, { failMode: 'AUTH' });
    const a = await enqueue(con.uuid, 'PUSH_INVOICE', invoice(13).payload);
    await drain();
    expect(await cmd(a)).toMatchObject({ status: 'PENDING', errorClass: 'AUTH' });
    const row = await plat.connector.findUniqueOrThrow({ where: { id: con.uuid } });
    expect(row.status).toBe('ERROR');
    expect(JSON.stringify(row.lastHealthError)).not.toContain(demoCreds.apiKey);
    // แก้ค่าตั้งแล้วทดสอบผ่าน → ACTIVE → คำสั่งที่พักส่งต่อ (TRANSIENT ที่ค้างก็ส่งได้เมื่อหาย)
    await setSettings(con.id, {});
    await api(app, token).post(`/v1/connectors/${con.id}/health`).expect(200);
    await drain();
    expect((await cmd(a)).status).toBe('DONE');
    expect(
      demo
        .documents(tenantId, con.uuid)
        .map((d) => d.number)
        .sort(),
    ).toEqual(['INV-00000-2611-0013']);
  });

  it('TRANSIENT ล้ม n ครั้งแล้วสำเร็จ · AMBIGUOUS: ERP ได้รับแล้ว → ส่งใหม่ได้ใบเดิม ไม่ซ้ำ', async () => {
    const con = await demoConnector({ settings: { failMode: 'TRANSIENT', failTimes: '2' } });
    const t = await enqueue(con.uuid, 'PUSH_INVOICE', invoice(20).payload);
    await drain();
    expect(await cmd(t)).toMatchObject({ status: 'FAILED_RETRYABLE', attempt: 1 });
    await drain();
    expect(await cmd(t)).toMatchObject({ status: 'FAILED_RETRYABLE', attempt: 2 });
    await drain();
    expect(await cmd(t)).toMatchObject({
      status: 'DONE',
      attempt: 3,
      result: { externalId: `DEMO-INV-${await extOf(con.uuid, t)}` },
    });

    await setSettings(con.id, { failMode: 'AMBIGUOUS', failTimes: '1' });
    const amb = await enqueue(con.uuid, 'PUSH_INVOICE', invoice(21).payload);
    await drain();
    expect(await cmd(amb)).toMatchObject({ status: 'FAILED_RETRYABLE', errorClass: 'AMBIGUOUS' });
    // ไม่ส่งซ้ำทันที (รอ 2 นาที — docs/01 §6.3)
    const wait = (await cmd(amb)).nextRunAt.getTime() - Date.now();
    expect(wait).toBeGreaterThan(60_000);
    expect(demo.documents(tenantId, con.uuid)).toHaveLength(2); // ERP ได้รับแล้ว
    await drain();
    expect(await cmd(amb)).toMatchObject({
      status: 'DONE',
      result: { externalId: `DEMO-INV-${await extOf(con.uuid, amb)}` },
    });
    expect(demo.documents(tenantId, con.uuid)).toHaveLength(2);
  });

  it('ดึง order ผ่าน connector: cursor ต่อ connector id (2 นิติบุคคลใช้ demo ได้แยกกัน) · ใบเข้าเป็น ERP:demo · ข้ามเมื่อไม่ ACTIVE/ไม่เปิด pullOrders', async () => {
    const intake = app.get(ConnectorIntakeService);
    const a = await demoConnector({ companyId: await company(1) });
    const b = await demoConnector({ companyId: await company(2) });
    const r = await intake.pullConnector(tenantId, a.uuid, { pageSize: 2 });
    expect(r).toMatchObject({ connector: 'demo', connectorId: a.uuid, pages: 3, cursor: '5' });
    expect(r.counts).toMatchObject({ created: 5, error: 0 });
    const orders = await plat.salesOrder.findMany({
      where: { tenantId, externalId: { startsWith: 'DEMO-SO-' } },
      select: { source: true, sourceConnector: true, status: true },
    });
    expect(orders).toHaveLength(5);
    expect(orders.every((o) => o.sourceConnector === 'demo')).toBe(true);
    // ลูกค้า/สถานที่ตัวอย่างยังไม่ map → ใบค้าง (สาธิตการ map)
    expect(orders.every((o) => o.status === 'ON_HOLD')).toBe(true);
    // connector ที่สอง (adapter เดียวกัน) มี cursor ของตัวเอง — ใบเดิมไม่ซ้ำ (unchanged)
    const r2 = await intake.pullConnector(tenantId, b.uuid);
    expect(r2.counts).toMatchObject({ created: 0, unchanged: 5 });
    const cursors = await plat.connectorCursor.findMany({
      where: { tenantId, connectorId: { in: [a.uuid, b.uuid] } },
      select: { connectorId: true, connectorKey: true, cursor: true },
    });
    expect(cursors).toHaveLength(2);
    expect(cursors.every((c) => c.connectorKey === 'demo' && c.cursor === '5')).toBe(true);
    // รอบถัดไปไม่มีใบใหม่
    expect((await intake.pullConnector(tenantId, a.uuid)).counts.total).toBe(0);

    await api(app, token).post(`/v1/connectors/${b.id}/pause`).send({}).expect(200);
    expect((await intake.pullConnector(tenantId, b.uuid)).skipped).toBe('connector_not_active');
    await api(app, token)
      .patch(`/v1/connectors/${a.id}`)
      .send({ capabilitiesEnabled: ['pushInvoice'] })
      .expect(200);
    expect((await intake.pullConnector(tenantId, a.uuid)).skipped).toBe('pull_not_enabled');

    // ต้นทางล่ม → sourceError (ไม่มี credential) cursor ไม่เลื่อน
    const c = await demoConnector({ settings: { failMode: 'TRANSIENT' } });
    const bad = await intake.pullConnector(tenantId, c.uuid);
    expect(bad.sourceError).toMatch(/unavailable/);
    expect(bad.sourceError).not.toContain(demoCreds.apiKey);
  });

  it('scheduler: สร้าง job ต่อ connector ที่ ACTIVE + เปิด pullOrders · ไม่สร้างซ้ำเมื่อยังค้าง · job ดึงผ่าน connector id', async () => {
    const sched = app.get(ConnectorPullScheduler);
    const on = await demoConnector({ companyId: await company(3) });
    const off = await demoConnector({
      companyId: await company(4),
      capabilitiesEnabled: ['pushInvoice'],
    });
    const paused = await demoConnector({ companyId: await company(5) }, { activate: false });
    expect(await sched.scheduleDue()).toBe(1);
    expect(await sched.scheduleDue()).toBe(0); // job ยังค้าง
    const jobs = await plat.job.findMany({
      where: { tenantId, type: CONNECTOR_PULL_JOB, status: 'PENDING' },
    });
    expect(jobs.map((j) => j.payload)).toEqual([{ connectorId: on.uuid }]);
    expect([off.uuid, paused.uuid]).not.toContain(
      (jobs[0]!.payload as { connectorId: string }).connectorId,
    );
    const queue = app.get(JobQueue);
    while (await queue.runOnce()) {
      /* รันจนหมด */
    }
    const done = await plat.job.findUniqueOrThrow({ where: { id: jobs[0]!.id } });
    expect(done.status).toBe('SUCCEEDED');
    expect(done.result).toMatchObject({ connector: 'demo', connectorId: on.uuid });
    expect(await sched.scheduleDue()).toBe(1); // รอบถัดไปตั้งใหม่ได้
  });

  it('หมุน key เข้ารหัส: credential ที่เข้ารหัสด้วย key เก่า → เข้ารหัสใหม่ด้วย key ปัจจุบัน (ค่าเดิม, version เดิม)', async () => {
    const con = await demoConnector({}, { activate: false });
    const svc = app.get(ConnectorsService);
    const before = await plat.connector.findUniqueOrThrow({ where: { id: con.uuid } });
    const oldSpec = process.env.FIELD_ENCRYPTION_KEYS!;
    const k2 = `k2:${Buffer.alloc(32, 7).toString('base64')}`;
    const original = (svc as unknown as { cipherInstance?: FieldCipher }).cipherInstance;
    (svc as unknown as { cipherInstance?: FieldCipher }).cipherInstance = new FieldCipher(
      `${k2},${oldSpec}`,
    );
    try {
      const r = await svc.reencryptCredentials();
      expect(r.reencrypted).toBeGreaterThanOrEqual(1);
      expect(r).toMatchObject({ failed: 0, remaining: 0 });
      const after = await plat.connector.findUniqueOrThrow({ where: { id: con.uuid } });
      expect(after.credentialsEnc!.split('.')[1]).toBe('k2');
      expect(after.version).toBe(before.version);
      expect(svc.configOf(after)).toMatchObject(demoCreds);
      expect((await svc.reencryptCredentials()).reencrypted).toBe(0); // รันซ้ำไม่มีอะไรทำ
    } finally {
      (svc as unknown as { cipherInstance?: FieldCipher }).cipherInstance = original;
      // คืนเป็น key เดิม (test อื่นใช้ key ring เดิม)
      await plat.connector.update({
        where: { id: con.uuid },
        data: { credentialsEnc: before.credentialsEnc },
      });
    }
  });

  it('กัน SSRF ของช่อง URL ตั้งแต่บันทึก (ตัวตรวจเดียวกับ webhook): IP ภายใน / user:pass / พอร์ตต้องห้าม → 422', async () => {
    const send = (baseUrl: string) =>
      api(app, token)
        .post('/v1/connectors')
        .send({
          taxDocumentOwner: 'TMS',
          adapterKey: 'fake-erp',
          settings: { baseUrl },
          credentials: { apiKey: GOOD_KEY },
        });
    for (const [url, code] of [
      ['https://10.1.2.3/api', 'url_not_allowed'],
      ['https://169.254.169.254/latest', 'url_not_allowed'],
      ['https://erp.internal/api', 'url_not_allowed'],
      ['https://localhost./api', 'url_not_allowed'],
      ['https://erp.example.com./api', 'url_not_allowed'],
      ['https://user:pw@erp.example.com/api', 'credentials_in_url'],
      ['https://erp.example.com:22/api', 'port_not_allowed'],
    ] as const) {
      const r = await send(url);
      expect(r.status, url).toBe(422);
      expect(r.body.errors[0]).toMatchObject({ field: 'settings.baseUrl', code });
    }
    expect((await send('https://erp.example.com/api')).status).toBe(201);
  });
  it('adapter ที่ปิดใน environment นี้ (demo ใน production) ค้างเป็น connector: effective = ใช้ไม่ได้ ไม่มีขั้น sync (ไม่ใช่ PUSH)', async () => {
    const con = await demoConnector();
    const reg = app.get(ErpAdapterRegistry);
    reg.unregister('demo');
    reg.refuse('demo');
    try {
      const eff = await api(app, token).get('/v1/connectors/effective').expect(200);
      expect(eff.body).toMatchObject({
        standalone: false,
        adapterKey: 'demo',
        adapterAvailable: false,
        capabilities: [],
        sending: false,
        documentSync: { invoice: 'NOT_APPLICABLE', settlement: 'NOT_APPLICABLE' },
      });
      // คำสั่งที่ค้างไม่ถูกส่ง (พักไว้)
      const inv = invoice(90);
      const id = await enqueue(con.uuid, 'PUSH_INVOICE', inv.payload, inv.id);
      await drain();
      expect(await cmd(id)).toMatchObject({ status: 'PENDING', errorClass: 'AUTH' });
    } finally {
      reg.replace(demo);
    }
    const eff = await api(app, token).get('/v1/connectors/effective').expect(200);
    expect(eff.body).toMatchObject({ adapterAvailable: true, documentSync: { invoice: 'PUSH' } });
  });
});
