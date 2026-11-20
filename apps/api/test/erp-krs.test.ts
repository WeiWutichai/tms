import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clock } from '../src/common/clock';
import { ConnectorsService } from '../src/modules/erp/connectors.service';
import { NotificationEvents } from '../src/modules/notifications/notification-events';
import { tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import { ERP_ADAPTER_FACTORIES } from '../src/erp-adapters';
import { adapterShapeProblems, type ErpContext } from '../src/modules/erp/erp-adapter';
import { ERP_SINK } from '../src/modules/erp/erp-adapter.sink';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../src/modules/integration/outbox.service';
import { describeErpAdapterContract } from './erp-adapter-contract';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

/**
 * ST8-T03 โครง KrsAdapter (docs/04 G4; docs/01 A.1–A.2, A.5) — ทดสอบกับ mock KRS (ST8-T01, พอร์ตสุ่มในโปรเซสเดียวกัน)
 * เกณฑ์ตรวจรับ: เปิด connector KRS ให้ tenant ทดสอบแล้ว healthCheck เขียว · ปิด mock → คิวหยุดและขึ้นสถานะ ERROR
 */

const KEY = 'krs-test-key-7d1f0c2a9e';
const TENANT = '00000000-0000-4000-8000-0000000000a1';

const ctx = (config: Record<string, string>): ErpContext => ({
  tenantId: TENANT,
  connectorId: '00000000-0000-4000-8000-0000000000a2',
  companyId: null,
  erpCompanyCode: null,
  config: Object.freeze({ ...config }),
});

// contract (ค่า baseUrl ตั้งหลัง mock เริ่ม — contract อ่าน config ตอนรันแต่ละข้อ)
const contractMock: { m?: MockKrs } = {};
const good: Record<string, string> = { baseUrl: '', apiKey: KEY };
const bad: Record<string, string> = { baseUrl: '', apiKey: 'wrong-key' };
beforeAll(async () => {
  contractMock.m = await startMockKrs({ apiKey: KEY });
  good.baseUrl = bad.baseUrl = contractMock.m.apiBaseUrl;
});
afterAll(async () => {
  await contractMock.m?.stop();
});

describeErpAdapterContract('krs (KrsAdapter — โครง)', {
  make: () => new KrsAdapter({ allowPrivate: true }),
  config: good,
  badConfig: bad,
  notImplemented: ['pullOrders', 'pushInvoice', 'fetchDocument', 'replaceDocument'],
});

describe('KrsAdapter (ST8-T03) — ไม่แตะฐานข้อมูล', () => {
  let mock: MockKrs;
  const krs = new KrsAdapter({ allowPrivate: true });
  beforeAll(async () => {
    mock = await startMockKrs({ apiKey: KEY });
  });
  afterEach(() => mock.clearFaults());
  afterAll(async () => {
    await mock.stop();
  });

  it('ลงทะเบียนผ่าน composition root · capabilities ตาม docs/01 A.2 · ไม่ใช่ localOnly · ช่องลับ = apiKey/sqlPassword', () => {
    const a = ERP_ADAPTER_FACTORIES.map((f) => f()).find((x) => x.key === 'krs');
    expect(a).toBeInstanceOf(KrsAdapter);
    expect(adapterShapeProblems(a!)).toEqual([]);
    expect(a!.localOnly).toBeFalsy();
    expect([...a!.capabilities()].sort()).toEqual(
      [
        'fetchDocument',
        'ownsDocumentNumber',
        'pullOrders',
        'pushInvoice',
        'replaceDocument',
      ].sort(),
    );
    for (const m of ['pushCreditNote', 'pushSettlement', 'fetchPaymentStatus', 'listDocuments'])
      expect((a as unknown as Record<string, unknown>)[m]).toBeUndefined();
    expect(a!.masterCodeKinds ?? []).toEqual([]);
    expect(a!.configFields.filter((f) => f.secret).map((f) => f.key)).toEqual([
      'apiKey',
      'sqlPassword',
    ]);
    expect(a!.configFields.find((f) => f.key === 'baseUrl')).toMatchObject({
      kind: 'url',
      required: true,
      secret: false,
    });
  });

  it('healthCheck: เขียว · key ผิด = AUTH · 503 = TRANSIENT · ปลายทางตัดสาย = TRANSIENT · ใบที่รู้จัก = found', async () => {
    const cfg = { baseUrl: mock.apiBaseUrl, apiKey: KEY };
    expect(await krs.healthCheck(ctx(cfg))).toMatchObject({
      ok: true,
      detail: { probe: 'not_found' },
    });
    // key ส่งใน header X-API-Key เท่านั้น
    const req = mock.requests().at(-1)!;
    expect(req).toMatchObject({ method: 'GET', status: 404 });
    expect(JSON.stringify(req)).not.toContain(KEY);

    const wrong = await krs.healthCheck(ctx({ ...cfg, apiKey: 'nope' }));
    expect(wrong).toMatchObject({
      ok: false,
      errorClass: 'AUTH',
      problem: { code: 'unauthorized' },
    });

    mock.injectFault({ kind: 'status', status: 503, times: 0 });
    const down = await krs.healthCheck(ctx(cfg));
    expect(down).toMatchObject({
      ok: false,
      errorClass: 'TRANSIENT',
      problem: { code: 'service_unavailable' },
    });
    mock.clearFaults();
    mock.injectFault({ kind: 'reset', times: 1 });
    expect(await krs.healthCheck(ctx(cfg))).toMatchObject({
      ok: false,
      errorClass: 'TRANSIENT',
      problem: { code: 'unreachable' },
    });
    mock.clearFaults();

    // ตั้งเลขใบที่รู้จัก (docs/01 A.2 "GET ใบที่รู้จักแล้ว 1 ใบ")
    const created = await fetch(`${mock.apiBaseUrl}/invoice`, {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleInvoice()),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { transactionNo } = (await created.json()) as { transactionNo: string };
    expect(
      await krs.healthCheck(ctx({ ...cfg, healthTransactionNo: transactionNo })),
    ).toMatchObject({ ok: true, detail: { probe: 'found' } });
  });

  it('healthCheck: ค่าตั้งขาด/URL ภายในเมื่อไม่อนุญาต = ok:false ไม่ throw · ไม่มี credential ในผล', async () => {
    expect(await krs.healthCheck(ctx({ apiKey: KEY }))).toMatchObject({
      ok: false,
      errorClass: 'VALIDATION',
      problem: { code: 'config_missing' },
    });
    expect(await krs.healthCheck(ctx({ baseUrl: mock.apiBaseUrl }))).toMatchObject({
      ok: false,
      errorClass: 'AUTH',
    });
    const strict = new KrsAdapter({ allowPrivate: false });
    const r = await strict.healthCheck(ctx({ baseUrl: mock.apiBaseUrl, apiKey: KEY }));
    expect(r).toMatchObject({
      ok: false,
      errorClass: 'VALIDATION',
      problem: { code: 'url_not_allowed' },
    });
    expect(JSON.stringify(r)).not.toContain(KEY);
    // mock หยุด → ต่อไม่ได้
    const gone = await startMockKrs({ apiKey: KEY });
    const url = gone.apiBaseUrl;
    await gone.stop();
    const off = await krs.healthCheck(ctx({ baseUrl: url, apiKey: KEY }));
    expect(off).toMatchObject({
      ok: false,
      errorClass: 'TRANSIENT',
      problem: { code: 'unreachable' },
    });
    expect(JSON.stringify(off)).not.toContain(KEY);
  });

  it('SSRF ตอนเรียกจริง: ชื่อโฮสต์ที่ resolve เป็น IP ภายใน (*.nip.io) / DNS rebinding (มี address ภายในปน) = ไม่ส่งคำขอ', async () => {
    const port = new URL(mock.apiBaseUrl).port;
    const before = mock.requests().length;
    const nip = new KrsAdapter({
      allowPrivate: false,
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(
      await nip.healthCheck(ctx({ baseUrl: `http://127.0.0.1.nip.io:${port}/api`, apiKey: KEY })),
    ).toMatchObject({ ok: false, errorClass: 'VALIDATION', problem: { code: 'url_not_allowed' } });
    const rebind = new KrsAdapter({
      allowPrivate: false,
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    });
    expect(
      await rebind.healthCheck(ctx({ baseUrl: `http://krs.sslip.io:${port}/api`, apiKey: KEY })),
    ).toMatchObject({ ok: false, errorClass: 'VALIDATION', problem: { code: 'url_not_allowed' } });
    expect(mock.requests()).toHaveLength(before);
  });
});

describe('connector KRS ต่อ tenant (ST8-T03) — API + คิว', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  let connectors: ConnectorsService;
  let clock: Clock;
  let mock: MockKrs;
  let tenantId: string;
  let userId: string;
  let token: string;
  const prevPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  const logged: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  const uuid = (id: string) => tryDecodeId('connector', id)!;
  const cmd = (id: string) => plat.integrationOutbox.findUniqueOrThrow({ where: { id } });
  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };
  async function enqueue(connectorId: string, operation = 'PUSH_INVOICE') {
    const localId = randomUUID();
    const { id } = await db.withTenant(tenantId, (tx) =>
      app.get(OutboxService).enqueueCommand(tx, {
        tenantId,
        kind: 'ADAPTER',
        sink: ERP_SINK,
        targetId: connectorId,
        operation,
        entityType: 'invoice',
        localId,
        payload: { document: { id: localId, number: 'INV-00000-2611-0001' } },
      }),
    );
    return id;
  }

  beforeAll(async () => {
    // ปลายทาง mock อยู่ที่ 127.0.0.1 — dev/test เท่านั้นที่ยอมได้ (ตอนบันทึก + HTTP client ของ adapter)
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    connectors = app.get(ConnectorsService);
    clock = app.get(Clock);
    mock = await startMockKrs({ apiKey: KEY });
    tenantId = (await createTenant(plat, 'บริษัท เชื่อม KRS')).id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    userId = (
      await plat.appUser.create({
        data: { tenantId, email: 'admin@krs.test', name: 'ผู้ดูแล KRS', status: 'ACTIVE' },
      })
    ).id;
    token = await tokenFor(tenantId, '*', userId);
    const capture =
      (orig: typeof process.stdout.write) =>
      (chunk: unknown, ...rest: unknown[]) => {
        logged.push(String(chunk));
        return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
      };
    process.stdout.write = capture(origOut) as typeof process.stdout.write;
    process.stderr.write = capture(origErr) as typeof process.stderr.write;
  });
  beforeEach(async () => {
    clock.set(null);
    mock.clearFaults();
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
  });
  afterAll(async () => {
    clock?.set(null);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    if (prevPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = prevPrivate;
    await mock?.stop();
    await app?.close();
    await plat.$disconnect();
  });

  const createKrs = (credentials: Record<string, string> = { apiKey: KEY }, base?: string) =>
    api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'krs',
        settings: {
          baseUrl: base ?? mock.apiBaseUrl,
          sqlServer: 'krs-sql.example:1433',
          sqlUser: 'tms_ro',
        },
        credentials: { ...credentials, sqlPassword: 'sql-ro-pass-55aa' },
      });

  it('catalog มี KRS (ไม่ใช่ demo) · capability ทั้งหมดยังไม่รองรับ (pending) · ช่องตั้งค่า', async () => {
    const cat = await api(app, token).get('/v1/connectors/adapters').expect(200);
    const k = cat.body.data.find((a: { key: string }) => a.key === 'krs');
    expect(k).toMatchObject({ key: 'krs', displayName: 'KRS', demo: false, masterCodeKinds: [] });
    const all = [
      'pullOrders',
      'pushInvoice',
      'fetchDocument',
      'replaceDocument',
      'ownsDocumentNumber',
    ];
    expect(k.capabilities).toEqual(all);
    expect(k.capabilitiesPending).toEqual(all);
    expect(k.configFields.map((f: { key: string }) => f.key)).toEqual([
      'baseUrl',
      'apiKey',
      'healthTransactionNo',
      'salePerson',
      'sqlServer',
      'sqlDatabase',
      'sqlUser',
      'sqlPassword',
    ]);
  });

  it('M1: capability ที่ยังไม่ได้ทำไม่เปิดเป็นค่าเริ่มต้น · ขอเปิด = 422 · คำสั่ง PUSH_INVOICE ที่ค้าง = PENDING (ไม่ SKIPPED ไม่เสียครั้ง)', async () => {
    const r = await createKrs();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      capabilitiesSupported: [],
      capabilitiesEnabled: [],
      capabilities: [],
    });
    expect(r.body.capabilitiesPending).toContain('pushInvoice');
    const bad = await api(app, token)
      .patch(`/v1/connectors/${r.body.id}`)
      .send({ capabilitiesEnabled: ['pushInvoice'] });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({
      field: 'capabilitiesEnabled',
      code: 'capability_not_supported',
    });
    await api(app, token).post(`/v1/connectors/${r.body.id}/resume`).send({}).expect(200);
    const c = await enqueue(uuid(r.body.id));
    await drain();
    await drain();
    const row = await cmd(c);
    expect(row).toMatchObject({ status: 'PENDING', errorClass: 'AUTH', attempt: 0 });
    expect(row.lastError).toMatchObject({
      code: 'capability_not_implemented',
      capability: 'pushInvoice',
    });
    expect(mock.requests().some((q) => q.method === 'POST')).toBe(false);
  });

  it('เปิด connector KRS → healthCheck เขียว → ACTIVE · credential เข้ารหัส ไม่ส่งกลับ ไม่ลง audit/log', async () => {
    const r = await createKrs();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.credentialKeys).toEqual(['apiKey', 'sqlPassword']);
    expect(r.body.settings).toMatchObject({ baseUrl: mock.apiBaseUrl, sqlUser: 'tms_ro' });
    const h = await api(app, token).post(`/v1/connectors/${r.body.id}/health`).expect(200);
    expect(h.body).toMatchObject({ ok: true, errorClass: null });
    const on = await api(app, token)
      .post(`/v1/connectors/${r.body.id}/resume`)
      .send({})
      .expect(200);
    expect(on.body).toMatchObject({ status: 'ACTIVE', lastHealthOk: true });
    const row = await plat.connector.findUniqueOrThrow({ where: { id: uuid(r.body.id) } });
    expect(row.credentialsEnc).toBeTruthy();
    expect(row.credentialsEnc).not.toContain(KEY);
    const hist = await api(app, token).get(`/v1/connectors/${r.body.id}/history`).expect(200);
    const all = JSON.stringify([r.body, h.body, on.body, hist.body, row.settings]);
    for (const s of [KEY, 'sql-ro-pass-55aa']) {
      expect(all).not.toContain(s);
      expect(logged.join('')).not.toContain(s);
    }
    const audits = await plat.auditLog.findMany({ where: { entityId: row.id } });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits.map((a) => [a.before, a.after, a.reason]))).not.toContain(KEY);
  });

  it('key ผิด → เปิดใช้ไม่ได้ 409 (AUTH) ไม่มี credential ในคำตอบ', async () => {
    const r = await createKrs({ apiKey: 'wrong-key-krs-0000' });
    const no = await api(app, token).post(`/v1/connectors/${r.body.id}/resume`).send({});
    expect(no.status).toBe(409);
    expect(no.body).toMatchObject({
      code: 'connector_health_failed',
      errorClass: 'AUTH',
      healthCode: 'unauthorized',
    });
    expect(JSON.stringify(no.body)).not.toContain('wrong-key-krs-0000');
  });

  it('M2: ปิด mock → ล้ม TRANSIENT ครั้งเดียวยังไม่หยุด · ล้มต่อเนื่อง ≥ 30 นาที → ERROR หยุดคิว · ปลายทางกลับมา → worker คืน ACTIVE เอง', async () => {
    const t0 = new Date('2026-11-19T03:00:00Z');
    clock.set(t0);
    const down = await startMockKrs({ apiKey: KEY });
    const r = await createKrs({ apiKey: KEY }, down.apiBaseUrl);
    const id = r.body.id as string;
    await api(app, token).post(`/v1/connectors/${id}/resume`).send({}).expect(200);
    await down.stop();
    const h = await api(app, token).post(`/v1/connectors/${id}/health`).expect(200);
    expect(h.body).toMatchObject({
      ok: false,
      errorClass: 'TRANSIENT',
      code: 'unreachable',
      message: expect.stringContaining('ติดต่อระบบปลายทางไม่ได้'),
    });
    expect(h.body.connector.status).toBe('ACTIVE');
    let row = await plat.connector.findUniqueOrThrow({ where: { id: uuid(id) } });
    expect(row.healthFailingSince?.toISOString()).toBe(t0.toISOString());
    // worker ตรวจซ้ำ 29 นาทีต่อมา — ยังล้ม แต่ไม่ถึง 30 นาที
    clock.set(new Date(t0.getTime() + 29 * 60_000));
    await connectors.recheckUnhealthy();
    row = await plat.connector.findUniqueOrThrow({ where: { id: uuid(id) } });
    expect(row).toMatchObject({ status: 'ACTIVE' });
    expect(row.healthFailingSince?.toISOString()).toBe(t0.toISOString()); // คงเวลาเริ่มเดิม
    // ครบ 30 นาที → ERROR หยุดคิว
    clock.set(new Date(t0.getTime() + 31 * 60_000));
    await connectors.recheckUnhealthy();
    row = await plat.connector.findUniqueOrThrow({ where: { id: uuid(id) } });
    expect(row).toMatchObject({ status: 'ERROR', statusReason: 'unreachable' });
    expect(row.lastHealthError).toMatchObject({ errorClass: 'TRANSIENT' });
    const c = await enqueue(uuid(id));
    await drain();
    expect(await cmd(c)).toMatchObject({ status: 'PENDING', errorClass: 'AUTH', attempt: 0 });
    expect((await cmd(c)).lastError).toMatchObject({ code: 'connector_not_active' });
    // ปลายทางกลับมา (ชี้ไป mock ที่ทำงาน) → worker ตรวจรอบถัดไป → ACTIVE เอง + audit + แจ้ง
    await plat.connector.update({
      where: { id: uuid(id) },
      data: { settings: { baseUrl: mock.apiBaseUrl } },
    });
    const notify = vi.spyOn(app.get(NotificationEvents), 'connectorRecovered');
    clock.set(new Date(t0.getTime() + 36 * 60_000));
    await connectors.recheckUnhealthy();
    row = await plat.connector.findUniqueOrThrow({ where: { id: uuid(id) } });
    expect(row).toMatchObject({ status: 'ACTIVE', healthFailingSince: null, lastHealthOk: true });
    expect(notify).toHaveBeenCalledTimes(1);
    notify.mockRestore();
    const audit = await plat.auditLog.findFirst({
      where: { entityId: uuid(id), action: 'connector.recovered' },
    });
    expect(audit?.after).toMatchObject({ status: 'ACTIVE', by: 'system' });
    // คำสั่งที่พักไว้ถูกปลุก → ถึง sink อีกครั้ง → พักต่อเพราะ capability ยังไม่ได้ทำ (ไม่ SKIPPED)
    await drain();
    expect(await cmd(c)).toMatchObject({ status: 'PENDING', attempt: 0 });
    expect((await cmd(c)).lastError).toMatchObject({ code: 'capability_not_implemented' });
  });

  it('M2: KRS ตอบ 503 ครั้งเดียว = ยังไม่หยุด · 401 (AUTH) = ERROR ทันที และ worker ไม่กู้คืนเอง', async () => {
    clock.set(new Date('2026-11-19T05:00:00Z'));
    const r = await createKrs();
    const id = r.body.id as string;
    await api(app, token).post(`/v1/connectors/${id}/resume`).send({}).expect(200);
    mock.injectFault({ kind: 'status', status: 503, times: 1 });
    const h = await api(app, token).post(`/v1/connectors/${id}/health`).expect(200);
    expect(h.body).toMatchObject({
      ok: false,
      errorClass: 'TRANSIENT',
      code: 'service_unavailable',
    });
    expect(h.body.connector.status).toBe('ACTIVE');
    // ผ่านรอบถัดไป → ล้างเวลาเริ่มล้ม
    await connectors.recheckUnhealthy();
    expect(
      (await plat.connector.findUniqueOrThrow({ where: { id: uuid(id) } })).healthFailingSince,
    ).toBeNull();
    mock.injectFault({ kind: 'status', status: 401, times: 1 });
    const a = await api(app, token).post(`/v1/connectors/${id}/health`).expect(200);
    expect(a.body).toMatchObject({ ok: false, errorClass: 'AUTH', code: 'unauthorized' });
    expect(a.body.connector.status).toBe('ERROR');
    await connectors.recheckUnhealthy(); // ปลายทางตอบปกติแล้ว แต่ ERROR(AUTH) ต้องให้คนแก้ key
    expect((await plat.connector.findUniqueOrThrow({ where: { id: uuid(id) } })).status).toBe(
      'ERROR',
    );
  });

  it('PUT credentials บางช่อง = รวมกับค่าเดิม (หมุน apiKey ไม่ลบ sqlPassword)', async () => {
    const r = await createKrs();
    const id = r.body.id as string;
    const put = await api(app, token)
      .put(`/v1/connectors/${id}/credentials`)
      .send({ credentials: { apiKey: 'rotated-key-1234' }, reason: 'หมุน key ตามรอบทดสอบ' })
      .expect(200);
    expect(put.body.credentialKeys).toEqual(['apiKey', 'sqlPassword']);
    const row = await plat.connector.findUniqueOrThrow({ where: { id: uuid(id) } });
    const cfg = connectors.configOf(row);
    expect(cfg).toMatchObject({ apiKey: 'rotated-key-1234', sqlPassword: 'sql-ro-pass-55aa' });
    await api(app, token)
      .put(`/v1/connectors/${id}/credentials`)
      .send({ credentials: {} })
      .expect(422);
  });

  it('tenant sandbox ใช้ connector KRS ไม่ได้ (LiveOnly)', async () => {
    const sb = await plat.tenant.create({
      data: { name: 'sandbox KRS', mode: 'test', liveTenantId: tenantId, planCode: 'ent' },
    });
    const sbToken = await tokenFor(sb.id, '*', userId);
    const r = await api(app, sbToken)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'krs',
        settings: { baseUrl: mock.apiBaseUrl },
        credentials: { apiKey: KEY },
      });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.code).toBe('sandbox_unsupported');
    expect(await plat.connector.count({ where: { tenantId: sb.id } })).toBe(0);
  });
});

function sampleInvoice() {
  return {
    tmsVoucherNo: `INV-T03-${randomUUID().slice(0, 8)}`,
    voucherDate: '2026-11-19',
    dueDate: '2026-12-19',
    paymentInDay: 30,
    custOrSuppCode: 'C001',
    custOrSuppName: 'ลูกค้า ทดสอบ',
    address: 'กรุงเทพฯ',
    deliveryAddress: 'กรุงเทพฯ',
    salePerson: 'S001',
    saleName: 'พนักงานขาย',
    entryBy: 'TMS',
    lines: [
      {
        lineId: 1,
        mainQuantity: 1,
        mainUnits: 'เที่ยว',
        unitPrice: 1000,
        flowNo: 'DO-0001',
        flowDate: '2026-11-19',
        carId: '70-1234',
        carPerson: 'คนขับ',
        frWay: 'ต้นทาง',
        toWay: 'ปลายทาง',
      },
    ],
  };
}
