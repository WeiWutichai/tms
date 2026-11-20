import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MockSalesOrder as MockSo } from '@tms/mock-krs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { JobQueue } from '../src/jobs/job-queue.service';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import { KRS_ISSUE, krsLinesIncomplete } from '../src/erp-adapters/krs/krs-so-poller';
import { type KrsSalesOrder, loadKrsSoMapping } from '../src/erp-adapters/krs/krs-so-source';
import { ConnectorIntakeService } from '../src/modules/connectors/connector-intake.service';
import { ConnectorPullScheduler } from '../src/modules/connectors/connector-pull.scheduler';
import { ErpAdapterError, type ErpContext } from '../src/modules/erp/erp-adapter';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST8-T04 SO poller ของ KRS (docs/01 A.2/A.4) — mock KRS (ST8-T01/T02, พอร์ตสุ่มในโปรเซสเดียวกัน) → KrsAdapter.pullOrders
 * → ConnectorIntakeService (cursor/lease) → OrderIntakeService.upsertOrder (ทางเดียวกับ PUT /v1/orders/external/{id})
 * เกณฑ์ตรวจรับ: SO ใหม่ใน mock ปรากฏเป็น order ภายใน 1 รอบ · รัน poll ซ้ำไม่เกิด order ซ้ำ
 */

const KEY = 'krs-poll-test-key-51c0d9';
const SO = (n: number) => `SAMPLE-SO-6911-000${n}`;
const EXT = (n: number) => `KRS-SAMPLE-${SO(n)}`;

const ctxOf = (config: Record<string, string>): ErpContext => ({
  tenantId: '00000000-0000-4000-8000-0000000000b1',
  connectorId: '00000000-0000-4000-8000-0000000000b2',
  companyId: null,
  erpCompanyCode: null,
  config: Object.freeze({ ...config }),
});

describe('KrsAdapter.pullOrders (ST8-T04) — ไม่แตะฐานข้อมูล', () => {
  let mock: MockKrs;
  const krs = new KrsAdapter({ allowPrivate: true });
  beforeAll(async () => {
    mock = await startMockKrs({ apiKey: KEY });
  });
  afterAll(async () => {
    await mock.stop();
  });

  it('แปลงเป็น ExternalOrder KRS-{company}-{soNo} + แถวดิบ · ใบยกเลิกมีเหตุ · หน้าละไม่เกิน limit', async () => {
    const p1 = await krs.pullOrders(ctxOf({ baseUrl: mock.apiBaseUrl, apiKey: KEY }), null, 2);
    expect(p1.orders.map((o) => o.externalId)).toEqual([EXT(1), EXT(2)]);
    expect(p1.hasMore).toBe(true);
    expect(p1.problem).toBeUndefined();
    const o2 = p1.orders[1]!;
    expect(o2).toMatchObject({
      customer: { code: 'SAMPLE-C002', name: 'บริษัทตัวอย่าง ข จำกัด' },
      requestedDate: '2026-11-05',
      vehicleTypeCode: '10W',
      stops: [
        { type: 'PICKUP', siteCode: 'SAMPLE-WH01', text: 'คลังตัวอย่าง บางนา' },
        { type: 'DELIVERY', siteCode: null, text: 'โรงงานตัวอย่าง นิคมฯ ตัวอย่าง' },
      ],
      lines: [
        { itemCode: 'SAMPLE-ITEM-02', qty: '12.500', unit: 'ตัน' },
        { itemCode: 'SAMPLE-ITEM-03', qty: '8', unit: 'พาเลท' },
      ],
    });
    expect((o2.raw as { view: string; rows: unknown[] }).view).toBe('vw_TMS_SalesOrder');
    expect((o2.raw as { rows: unknown[] }).rows).toHaveLength(2);
    const p2 = await krs.pullOrders(
      ctxOf({ baseUrl: mock.apiBaseUrl, apiKey: KEY }),
      p1.nextCursor,
      10,
    );
    expect(p2.orders.map((o) => o.externalId)).toEqual([EXT(3), EXT(4), EXT(5)]);
    expect(p2.hasMore).toBe(false);
    expect(p2.orders[2]!.issues).toEqual([KRS_ISSUE.cancelled]);
    expect(p2.orders[0]!.issues).toBeUndefined();
  });

  it('key ผิด = ErpAdapterError AUTH · ปลายทางล่ม = TRANSIENT (ไม่มี key ในข้อความ)', async () => {
    const bad = krs.pullOrders(ctxOf({ baseUrl: mock.apiBaseUrl, apiKey: 'wrong' }), null, 5);
    await expect(bad).rejects.toBeInstanceOf(ErpAdapterError);
    await expect(bad).rejects.toMatchObject({ errorClass: 'AUTH' });
    mock.injectFault({ status: 503, method: 'GET' });
    const down = await krs
      .pullOrders(ctxOf({ baseUrl: mock.apiBaseUrl, apiKey: KEY }), null, 5)
      .catch((e: unknown) => e);
    mock.clearFaults();
    expect(down).toMatchObject({ errorClass: 'TRANSIENT' });
    expect(String((down as Error).message)).not.toContain(KEY);
  });

  it('ตรวจใบไม่ครบ: line_no ต้องเป็น 1..n ไม่ซ้ำไม่ขาด', () => {
    const so = (nos: unknown[]) =>
      ({ lines: nos.map((lineNo) => ({ lineNo })) }) as unknown as KrsSalesOrder;
    expect(krsLinesIncomplete(so([1, 2]))).toBeNull();
    expect(krsLinesIncomplete(so([2, 1]))).toBeNull();
    expect(krsLinesIncomplete(so([2]))).toBe('line_no 1 missing');
    expect(krsLinesIncomplete(so([1, 1]))).toBe('duplicate line_no');
    expect(krsLinesIncomplete(so([1, 'x']))).toBe('line_no is not a positive integer');
  });
});

describe('KRS SO poller ต่อ tenant (ST8-T04) — mock → order', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let mock: MockKrs;
  let svc: ConnectorIntakeService;
  let tenantId: string;
  let token: string;
  let connectorId: string;
  let publicId: string;
  const prevPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  // ต้นทางแบบกำหนดเองสำหรับกรณีผิดปกติ (view หาย / คอลัมน์หาย / ใบไม่ครบ) — invoice = 404 (healthCheck ผ่าน)
  let custom: Server;
  let customBase = '';
  let customReply: { status: number; body: unknown } = { status: 200, body: { rows: [] } };

  const orders = () =>
    plat.salesOrder.findMany({
      where: { tenantId, externalId: { startsWith: 'KRS-' } },
      include: { holdReasonCode: { select: { code: true } }, lines: true, stops: true },
      orderBy: { externalId: 'asc' },
    });
  const cursor = () => plat.connectorCursor.findFirst({ where: { tenantId, connectorId } });
  const connector = () => plat.connector.findUniqueOrThrow({ where: { id: connectorId } });
  const setBase = (baseUrl: string) =>
    plat.$executeRaw`UPDATE connector SET settings = jsonb_set(settings, '{baseUrl}', to_jsonb(${baseUrl}::text))
                      WHERE id = ${connectorId}::uuid`;
  const resume = () =>
    api(app, token).post(`/v1/connectors/${publicId}/resume`).send({ reason: 'แก้ต้นทางแล้ว' });

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    await truncateAll();
    app = await bootApp();
    svc = app.get(ConnectorIntakeService);
    mock = await startMockKrs({ apiKey: KEY });
    custom = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if ((req.url ?? '').includes('/invoice/')) {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      res.statusCode = customReply.status;
      res.end(JSON.stringify(customReply.body));
    });
    await new Promise<void>((ok) => custom.listen(0, '127.0.0.1', ok));
    customBase = `http://127.0.0.1:${(custom.address() as AddressInfo).port}/api`;

    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ดึง SO KRS' })).id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    const co = await plat.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล KRS', taxId: validTaxId(7701) },
    });
    await plat.branch.create({
      data: {
        tenantId,
        companyId: co.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
    const userId = (
      await plat.appUser.create({
        data: { tenantId, email: 'admin@krs-poll.test', name: 'ผู้ดูแล', status: 'ACTIVE' },
      })
    ).id;
    token = await tokenFor(tenantId, '*', userId);
    // ลูกค้า SAMPLE-C001 จับคู่แล้ว (รหัสตามต้นทาง) — SAMPLE-C002/C999 ยังไม่จับคู่ (mapping NSF↔PP = ST8-T05)
    await api(app, token)
      .post('/v1/customers')
      .send({
        legalName: 'บริษัทตัวอย่าง ก จำกัด',
        taxId: validTaxId(7702),
        externalId: 'SAMPLE-C001',
      })
      .expect(201);

    const c = await api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'krs',
        settings: { baseUrl: mock.apiBaseUrl },
        credentials: { apiKey: KEY },
      });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.capabilitiesEnabled).toEqual(['pullOrders']);
    publicId = c.body.id;
    connectorId = tryDecodeId('connector', publicId)!;
    await resume().expect(200);
  });
  afterAll(async () => {
    if (prevPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = prevPrivate;
    custom?.closeAllConnections();
    await new Promise<void>((ok) => (custom ? custom.close(() => ok()) : ok()));
    await mock?.stop();
    await app?.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: scheduler 1 รอบ → SO ตัวอย่างทั้ง 5 ใบเป็น order (แถวดิบ · ลูกค้าไม่รู้จักค้าง · ใบยกเลิกค้าง SOURCE_ERROR)', async () => {
    expect(await app.get(ConnectorPullScheduler).scheduleDue()).toBe(1);
    const queue = app.get(JobQueue);
    while (await queue.runOnce()) {
      /* ทำจนคิวว่าง */
    }
    const job = await plat.job.findFirstOrThrow({
      where: { tenantId, type: 'connector.pull' },
      orderBy: { createdAt: 'desc' },
    });
    expect(job.status).toBe('SUCCEEDED');
    expect(job.result).toMatchObject({ connector: 'krs', counts: { created: 5, error: 0 } });

    const all = await orders();
    expect(all.map((o) => o.externalId)).toEqual([1, 2, 3, 4, 5].map(EXT));
    for (const o of all) {
      expect(o.source).toBe('CONNECTOR');
      expect(o.sourceConnector).toBe('krs');
      expect((o.rawPayload as { view: string; rows: unknown[] }).view).toBe('vw_TMS_SalesOrder');
    }
    const [o1, o2, o3, o4, o5] = all;
    expect(o1!.customerId).toBeTruthy();
    expect(o1!.customerRef).toBe('SAMPLE-PO-1001');
    expect(o1!.requestedDate.toISOString().slice(0, 10)).toBe('2026-11-04');
    expect(o2!.lines.map((l) => [l.lineNo, String(l.qtyOrdered), l.itemCode])).toEqual([
      [1, '12.5', 'SAMPLE-ITEM-02'],
      [2, '8', 'SAMPLE-ITEM-03'],
    ]);
    expect((o2!.rawPayload as { rows: unknown[] }).rows).toHaveLength(2);
    expect(o2!.holdReasonCode?.code).toBe('CUSTOMER_UNMAPPED');
    expect(o3!.holdReasonCode?.code).toBe('CUSTOMER_UNMAPPED');
    expect(o3!.customerExternalId).toBe('SAMPLE-C999');
    expect(o4!.lines.map((l) => String(l.qtyOrdered))).toEqual(['15']);
    expect(o5!.status).toBe('ON_HOLD');
    expect(o5!.sourceIssues).toContain(KRS_ISSUE.cancelled);
    expect(o1!.sourceIssues ?? []).not.toContain(KRS_ISSUE.cancelled);
    const cur = await cursor();
    expect(cur).toMatchObject({ connectorKey: 'krs', leaseId: null });
    expect(cur!.cursor).toBe(mock.salesOrders.list().at(-1)!.rowVersion.toString());
  });

  it('เกณฑ์ตรวจรับ: poll ซ้ำไม่เกิด order ซ้ำ — รอบถัดไปว่าง · ล้าง watermark แล้วอ่านใหม่ทั้งหมด = unchanged', async () => {
    const before = await orders();
    const again = await svc.pullConnector(tenantId, connectorId);
    expect(again.counts).toMatchObject({ total: 0, created: 0 });
    await plat.connectorCursor.updateMany({
      where: { tenantId, connectorId },
      data: { cursor: null },
    });
    const replay = await svc.pullConnector(tenantId, connectorId);
    expect(replay.counts).toMatchObject({
      total: 5,
      created: 0,
      updated: 0,
      unchanged: 5,
      error: 0,
    });
    const after = await orders();
    expect(after.map((o) => [o.id, o.version])).toEqual(before.map((o) => [o.id, o.version]));
  });

  it('SO ใหม่ใน mock → order ภายในรอบเดียว · SO ที่แก้ → updated (ใบเดิม ไม่ซ้ำ)', async () => {
    mock.salesOrders.upsert({
      company: 'SAMPLE',
      soNo: 'SAMPLE-SO-6911-0009',
      soDate: '2026-11-20',
      customerCode: 'SAMPLE-C001',
      customerName: 'บริษัทตัวอย่าง ก จำกัด',
      deliveryDate: '2026-11-22',
      originName: 'คลังตัวอย่าง บางนา',
      destinationName: 'ร้านตัวอย่าง สาขา 3',
      lines: [
        { lineNo: 1, itemCode: 'SAMPLE-ITEM-01', itemName: 'ค่าขนส่ง', qty: '1', unit: 'เที่ยว' },
      ],
    });
    mock.salesOrders.edit('SAMPLE', SO(4), { deliveryDate: '2026-11-09' });
    const r = await svc.pullConnector(tenantId, connectorId);
    expect(r.counts).toMatchObject({ total: 2, created: 1, updated: 1, error: 0 });
    const all = await orders();
    expect(all).toHaveLength(6);
    expect(
      all
        .find((o) => o.externalId === EXT(4))!
        .requestedDate.toISOString()
        .slice(0, 10),
    ).toBe('2026-11-09');
    expect(all.some((o) => o.externalId === 'KRS-SAMPLE-SAMPLE-SO-6911-0009')).toBe(true);
  });

  const rowsOf = (so: MockSo, rowVersion: number) => mock.salesOrders.toRows({ ...so, rowVersion });
  const byExt = async (ext: string) => (await orders()).find((o) => o.externalId === ext)!;

  it('M2 คอลัมน์หาย → ใบใหม่ค้าง SOURCE_ERROR · ใบเดิมไม่ถูกทับ (ตั้งปัญหาอย่างเดียว) · connector ERROR · watermark ไม่เลื่อน · ปุ่มทดสอบไม่ผ่านจนกว่าแก้ · แก้แล้วเปิดใช้ → ข้อมูลครบ', async () => {
    const m = loadKrsSoMapping();
    const so1 = mock.salesOrders.get('SAMPLE', SO(1))!;
    const fullRows = [
      ...rowsOf(so1, 900_000),
      ...rowsOf({ ...so1, soNo: 'SAMPLE-SO-6911-0010' }, 900_001),
    ];
    const broken = fullRows.map((r) => {
      const x = { ...r };
      delete x[m.columns.qty.column];
      return x;
    });
    customReply = { status: 200, body: { rows: broken, next: '900001', hasMore: false } };
    const wmBefore = (await cursor())!.cursor;
    const before1 = await byExt(EXT(1));
    await setBase(customBase);

    const r = await svc.pullConnector(tenantId, connectorId);
    expect(r.sourceError).toContain('source_columns_missing');
    expect(r.counts).toMatchObject({ created: 1, updated: 1, held: 2, error: 0 });
    const issue = KRS_ISSUE.columnsMissing(m.view, ['qty']);
    const o = await byExt('KRS-SAMPLE-SAMPLE-SO-6911-0010');
    expect(o.status).toBe('ON_HOLD');
    expect(o.holdReasonCode?.code).toBe('SOURCE_ERROR');
    expect((o.sourceIssues as string[])[0]).toBe(issue);
    // ใบเดิม: ข้อมูล/รายการเดิมครบ แค่ค้าง SOURCE_ERROR พร้อมเหตุ
    const held1 = await byExt(EXT(1));
    expect(held1.status).toBe('ON_HOLD');
    expect(held1.holdReasonCode?.code).toBe('SOURCE_ERROR');
    expect(held1.sourceIssues).toContain(issue);
    expect(held1.lines.map((l) => [l.lineNo, String(l.qtyOrdered)])).toEqual(
      before1.lines.map((l) => [l.lineNo, String(l.qtyOrdered)]),
    );
    expect(held1.rawPayload).toEqual(before1.rawPayload);
    expect(
      await plat.auditLog.count({
        where: { tenantId, entityId: held1.id, action: 'sales_order.source_held' },
      }),
    ).toBe(1);
    expect((await cursor())!.cursor).toBe(wmBefore);
    const c = await connector();
    expect(c.status).toBe('ERROR');
    expect(c.lastHealthError).toMatchObject({
      errorClass: 'VALIDATION',
      code: 'source_columns_missing',
    });
    expect(
      await plat.auditLog.count({
        where: { tenantId, entityId: connectorId, action: 'connector.error' },
      }),
    ).toBe(1);
    expect((await svc.pullConnector(tenantId, connectorId)).skipped).toBe('connector_not_active');

    // M3 ปุ่มทดสอบ: แหล่ง SO ยังเสีย = ไม่ผ่าน คง ERROR พร้อมเหตุ · เปิดใช้ไม่ได้
    const h = await api(app, token).post(`/v1/connectors/${publicId}/health`).expect(200);
    expect(h.body).toMatchObject({ ok: false, code: 'source_columns_missing' });
    expect(h.body.message).toContain('คอลัมน์');
    expect((await connector()).status).toBe('ERROR');
    expect((await connector()).lastHealthError).toMatchObject({ code: 'source_columns_missing' });
    await resume().expect(409);

    // KRS แก้ view → เปิดใช้ → หน้าเดิม (watermark ไม่เลื่อน) ได้แถวครบ → ทั้งสองใบพ้น SOURCE_ERROR
    customReply = { status: 200, body: { rows: fullRows, next: '900001', hasMore: false } };
    await resume().expect(200);
    const fixed = await svc.pullConnector(tenantId, connectorId);
    expect(fixed.sourceError).toBeUndefined();
    expect(fixed.counts).toMatchObject({ updated: 2, error: 0 });
    for (const ext of [EXT(1), 'KRS-SAMPLE-SAMPLE-SO-6911-0010']) {
      const x = await byExt(ext);
      expect(x.sourceIssues ?? []).toEqual([]);
      expect(x.holdReasonCode?.code).not.toBe('SOURCE_ERROR');
      expect(x.lines).toHaveLength(1);
    }
    expect((await cursor())!.cursor).toBe('900001');
  });

  it('view หาย (404) → connector ERROR source_not_found ไม่มีใบ ไม่เลื่อน watermark', async () => {
    await setBase(customBase);
    customReply = { status: 404, body: {} };
    const wm = (await cursor())!.cursor;
    const n = (await orders()).length;
    const r = await svc.pullConnector(tenantId, connectorId);
    expect(r.sourceError).toBeTruthy();
    expect((await connector()).status).toBe('ERROR');
    expect((await connector()).lastHealthError).toMatchObject({ code: 'source_not_found' });
    expect((await orders()).length).toBe(n);
    expect((await cursor())!.cursor).toBe(wm);
    await resume().expect(409); // ตรวจแหล่ง SO ด้วย — ยังหาย = เปิดไม่ได้
    customReply = { status: 200, body: { rows: [], next: null, hasMore: false } };
    await resume().expect(200);
  });

  it('M1 รายการท้ายใบหาย (ได้ 1..1 จาก 2) → ใบเดิมไม่ถูกลดรายการ ค้าง SOURCE_ERROR · connector ACTIVE · watermark เดินต่อ', async () => {
    await setBase(customBase);
    const so2 = mock.salesOrders.get('SAMPLE', SO(2))!;
    const line1 = rowsOf(so2, 900_050).filter(
      (r) => r[loadKrsSoMapping().columns.lineNo.column] === 1,
    );
    customReply = { status: 200, body: { rows: line1, next: '900050', hasMore: false } };
    const r = await svc.pullConnector(tenantId, connectorId);
    expect(r.sourceError).toBeUndefined();
    expect(r.counts).toMatchObject({ updated: 1, held: 1, error: 0 });
    const after = await byExt(EXT(2));
    expect(after.lines).toHaveLength(2);
    expect(after.holdReasonCode?.code).toBe('SOURCE_ERROR');
    expect((after.sourceIssues as string[]).join(' ')).toContain('น้อยกว่าที่มีอยู่ 2 รายการ');
    expect((await connector()).status).toBe('ACTIVE');
    expect((await cursor())!.cursor).toBe('900050');
    // ต้นทางส่งใบครบภายหลัง → ข้อมูลเขียนจริง ปัญหาหาย
    customReply = {
      status: 200,
      body: { rows: rowsOf(so2, 900_060), next: '900060', hasMore: false },
    };
    const ok = await svc.pullConnector(tenantId, connectorId);
    expect(ok.counts).toMatchObject({ updated: 1, error: 0 });
    const back = await byExt(EXT(2));
    expect(back.sourceIssues ?? []).toEqual([]);
    expect(back.lines).toHaveLength(2);
  });

  it('M1 เลขรายการเว้นช่อง (ได้เฉพาะรายการที่ 2) → ใบเดิมไม่ถูกทับ ค้าง SOURCE_ERROR · connector ไม่หยุด · watermark เดินต่อ · คนเคลียร์ได้ด้วยแก้มือ', async () => {
    await setBase(customBase);
    const so2 = mock.salesOrders.get('SAMPLE', SO(2))!;
    const onlyLine2 = rowsOf(so2, 900_100).filter(
      (r) => r[loadKrsSoMapping().columns.lineNo.column] === 2,
    );
    customReply = { status: 200, body: { rows: onlyLine2, next: '900100', hasMore: false } };
    const before = await byExt(EXT(2));
    const r = await svc.pullConnector(tenantId, connectorId);
    expect(r.sourceError).toBeUndefined();
    expect(r.counts).toMatchObject({ updated: 1, error: 0 });
    const after = await byExt(EXT(2));
    expect(after.lines.map((l) => l.itemCode)).toEqual(before.lines.map((l) => l.itemCode));
    expect(after.holdReasonCode?.code).toBe('SOURCE_ERROR');
    expect(after.sourceIssues).toContain(KRS_ISSUE.badLines('line_no 1 missing'));
    expect((await connector()).status).toBe('ACTIVE');
    expect((await cursor())!.cursor).toBe('900100');
    // ทางออกโดยไม่แก้ฐานข้อมูล: หน้าใบค้าง "แก้มือ" (resolve-source-error)
    await api(app, token)
      .post(`/v1/orders/${encodeId('salesOrder', after.id)}/resolve-source-error`)
      .send({ reason: 'ตรวจกับ KRS แล้ว รายการเดิมถูกต้อง' })
      .expect(200);
    expect((await byExt(EXT(2))).sourceIssues ?? []).toEqual([]);
  });

  it('Low: แถวที่รวมเป็นใบไม่ได้ → คำเตือนใน last_result + audit · ตอบไม่ใช่ JSON = TRANSIENT (ไม่หยุด connector, จดเวลาเริ่มล้ม)', async () => {
    await setBase(customBase);
    const so1 = mock.salesOrders.get('SAMPLE', SO(1))!;
    const bad = { ...rowsOf(so1, 900_200)[0]!, [loadKrsSoMapping().columns.soNo.column]: '' };
    customReply = { status: 200, body: { rows: [bad], next: '900200', hasMore: false } };
    const r = await svc.pullConnector(tenantId, connectorId);
    expect(r.warnings?.[0]).toContain('1 row(s)');
    const cur = await cursor();
    expect((cur!.lastResult as { warnings?: string[] }).warnings?.[0]).toContain('1 row(s)');
    const aud = await plat.auditLog.findFirst({
      where: { tenantId, action: 'connector.orders_pulled', entityId: cur!.id },
      orderBy: { at: 'desc' },
    });
    expect(JSON.stringify(aud?.after)).toContain('1 row(s)');

    customReply = { status: 200, body: '<html>proxy</html>' };
    const t = await svc.pullConnector(tenantId, connectorId);
    expect(t.sourceError).toBeTruthy();
    const c = await connector();
    expect(c.status).toBe('ACTIVE');
    expect(c.healthFailingSince).toBeTruthy();
  });
});
