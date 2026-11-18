import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { DemoAdapter } from '../src/erp-adapters/demo/demo.adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { ERP_SINK } from '../src/modules/erp/erp-adapter.sink';
import { adapterShapeProblems } from '../src/modules/erp/erp-adapter';
import { ErpMasterCodesService } from '../src/modules/erp/erp-master-codes.service';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../src/modules/integration/outbox.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { FakeErpAdapter, GOOD_KEY } from './fake-erp-adapter';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * ST7-T18 Sync master ลงมา (docs/04 G3 + B; docs/01 §7.4) — ผังรหัส ERP ต่อ connector (adapter / นำเข้าไฟล์)
 * + หน้า mapping ค่าบริการ ↔ รหัสสินค้า ERP + ประตูก่อนส่ง (plan/11 #9: ไม่กันออกเอกสาร — คำสั่ง push FAILED_FINAL VALIDATION)
 * เกณฑ์ตรวจรับ: service_item ที่ยังไม่ map → เอกสารถูกกัน (ไม่เข้า ERP) พร้อมลิงก์ไปหน้า mapping
 */
describe('ผังรหัส ERP + mapping (ST7-T18)', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  let demo: DemoAdapter;
  const fake = new FakeErpAdapter('fake-erp');
  let tenantId: string;
  let otherTenant: string;
  let token: string;
  let viewer: string;
  let freight: string;
  let wait: string;

  const uuid = (id: string) => tryDecodeId('connector', id)!;
  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                      WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };

  async function demoConnector(creds = { apiKey: 'demo-key-0001' }, activate = true) {
    const r = await api(app, token)
      .post('/v1/connectors')
      .send({ adapterKey: 'demo', credentials: creds });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    if (activate)
      await api(app, token).post(`/v1/connectors/${r.body.id}/resume`).send({}).expect(200);
    return r.body.id as string;
  }

  async function serviceItem(code: string, nameTh: string, side: 'SELL' | 'BUY' | 'BOTH' = 'BOTH') {
    const s = await plat.serviceItem.create({
      data: {
        tenantId,
        code,
        nameTh,
        vatType: 'VAT_7',
        whtRate: '3.00',
        calcUnit: 'PER_TRIP',
        unitLabel: 'เที่ยว',
        side,
      },
    });
    return encodeId('serviceItem', s.id);
  }

  async function enqueueInvoice(connectorId: string, lines: { serviceItem: { id: string } }[]) {
    const id = randomUUID();
    const { id: cmdId } = await db.withTenant(tenantId, (tx) =>
      app.get(OutboxService).enqueueCommand(tx, {
        tenantId,
        kind: 'ADAPTER',
        sink: ERP_SINK,
        targetId: uuid(connectorId),
        operation: 'PUSH_INVOICE',
        entityType: 'invoice',
        localId: id,
        payload: { document: { id, number: `INV-T18-${id.slice(0, 6)}`, lines } },
      }),
    );
    return cmdId;
  }
  const cmd = (id: string) => plat.integrationOutbox.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    const reg = app.get(ErpAdapterRegistry);
    demo = reg.get('demo') as DemoAdapter;
    reg.replace(fake);
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ผังรหัส จำกัด' })).id;
    otherTenant = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น จำกัด' })).id;
    for (const t of [tenantId, otherTenant])
      await plat.tenant.update({ where: { id: t }, data: { planCode: 'ent' } });
    token = await tokenFor(tenantId);
    viewer = await tokenFor(tenantId, 'settings:read');
    freight = await serviceItem('T18-FRT', 'ค่าขนส่งทดสอบ');
    wait = await serviceItem('T18-WAIT', 'ค่ารอคิวทดสอบ', 'SELL');
    await serviceItem('T18-BUY', 'ค่าจ้างรถร่วมทดสอบ', 'BUY');
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
  });
  afterAll(async () => {
    app.get(ErpAdapterRegistry).unregister(fake.key);
    await app.close();
    await plat.$disconnect();
  });

  it('รูปของ adapter: ประกาศชนิดผังรหัส ⇔ มี fetchMasterCodes · catalog แสดงชนิดที่ดึงได้', async () => {
    expect(adapterShapeProblems(demo)).toEqual([]);
    const bad = Object.assign(new FakeErpAdapter('fake-bad'), {
      masterCodeKinds: ['ITEM'] as const,
    });
    expect(adapterShapeProblems(bad)).toContain(
      'masterCodeKinds declared but fetchMasterCodes() missing',
    );
    const cat = (await api(app, token).get('/v1/connectors/adapters').expect(200)).body.data;
    expect(cat.find((a: { key: string }) => a.key === 'demo').masterCodeKinds).toEqual([
      'UNIT',
      'SALESPERSON',
      'ACCOUNT',
      'ITEM',
      'VAT_RATE',
    ]);
    expect(cat.find((a: { key: string }) => a.key === 'fake-erp').masterCodeKinds).toEqual([]);
  });

  it('ซิงก์ผังรหัสจาก DemoProvider ครบทุกชนิด · ซิงก์ซ้ำ = ไม่สร้างซ้ำ · รหัสที่ ERP เลิกใช้ถูกปิด (ไม่ลบ) + audit', async () => {
    const con = await demoConnector();
    const r = await api(app, token).post(`/v1/connectors/${con}/master-codes/sync`).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.results.map((x: { kind: string }) => x.kind)).toEqual([
      'UNIT',
      'SALESPERSON',
      'ACCOUNT',
      'ITEM',
      'VAT_RATE',
    ]);
    expect(r.body.results.find((x: { kind: string }) => x.kind === 'ITEM')).toMatchObject({
      fetched: 6,
      created: 6,
      deactivated: 0,
    });
    const vat = (
      await api(app, token).get(`/v1/connectors/${con}/master-codes?kind=VAT_RATE`).expect(200)
    ).body.data;
    expect(vat).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'V7', rate: '7.00', source: 'ADAPTER' }),
      ]),
    );

    // ERP เลิกใช้ SV-OVN และเพิ่ม SV-NEW
    demo.setMasterCodes(tenantId, uuid(con), 'ITEM', [
      { code: 'SV-FRT-01', name: 'ค่าขนส่ง' },
      { code: 'SV-WAIT', name: 'ค่ารอคิว (แก้ชื่อ)' },
      { code: 'SV-NEW', name: 'ใหม่' },
      { code: '', name: 'ผิดรูป' },
      { code: 'sv-new', name: 'ซ้ำ' },
    ]);
    const r2 = await api(app, token)
      .post(`/v1/connectors/${con}/master-codes/sync`)
      .send({ kinds: ['ITEM'] })
      .expect(200);
    expect(r2.body.results).toEqual([
      { kind: 'ITEM', fetched: 3, created: 1, updated: 1, deactivated: 4, skipped: 2 },
    ]);
    const active = (await api(app, token).get(`/v1/connectors/${con}/master-codes?kind=ITEM`)).body
      .data;
    expect(active.map((x: { code: string }) => x.code).sort()).toEqual([
      'SV-FRT-01',
      'SV-NEW',
      'SV-WAIT',
    ]);
    const all = (
      await api(app, token).get(`/v1/connectors/${con}/master-codes?kind=ITEM&includeInactive=true`)
    ).body.data;
    expect(all).toHaveLength(7);
    expect(all.find((x: { code: string }) => x.code === 'SV-OVN').active).toBe(false);
    expect(
      await plat.auditLog.count({
        where: { tenantId, action: 'connector.master_codes_synced', entityId: uuid(con) },
      }),
    ).toBe(2);
  });

  it('ซิงก์ไม่ได้: adapter ไม่รองรับ → 409 · credential ผิด → 409 master_sync_failed ไม่เปลี่ยนข้อมูล · ชนิดที่ไม่รองรับ → 422 · ผู้ดูอย่างเดียว → 403', async () => {
    const f = await api(app, token)
      .post('/v1/connectors')
      .send({
        adapterKey: 'fake-erp',
        settings: { baseUrl: 'https://erp.example.com' },
        credentials: { apiKey: GOOD_KEY },
      })
      .expect(201);
    const r = await api(app, token).post(`/v1/connectors/${f.body.id}/master-codes/sync`).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('master_sync_not_supported');
    await api(app, token)
      .post(`/v1/connectors/${f.body.id}/disconnect`)
      .send({ reason: 'ทดสอบเปลี่ยน connector' })
      .expect(200);

    const con = await demoConnector({ apiKey: 'invalid' }, false); // PAUSED — ซิงก์ได้ (ทดสอบก่อนเปิดใช้)
    const bad = await api(app, token).post(`/v1/connectors/${con}/master-codes/sync`).send({});
    expect(bad.status).toBe(409);
    expect(bad.body).toMatchObject({ code: 'master_sync_failed', kind: 'UNIT' });
    expect(JSON.stringify(bad.body)).not.toContain('invalid"'); // ไม่สะท้อน credential
    expect(await plat.erpMasterCode.count({ where: { connectorId: uuid(con) } })).toBe(0);

    const k = await api(app, token)
      .post(`/v1/connectors/${con}/master-codes/sync`)
      .send({ kinds: ['NOPE'] });
    expect(k.status).toBe(422);
    await api(app, viewer).post(`/v1/connectors/${con}/master-codes/sync`).send({}).expect(403);
    await api(app, viewer).get(`/v1/connectors/${con}/master-codes`).expect(200);
  });

  it('หน้า mapping: ค่าบริการฝั่งขายทุกตัว · มีผังรหัสแล้วรหัสต้องอยู่ในผัง (422 erp_code_unknown) · ยกเลิกด้วย null · audit', async () => {
    const con = await demoConnector();
    // ยังไม่มีผังรหัส = รับรหัสที่กรอก (ERP ตรวจตอนรับ)
    const free = await api(app, token)
      .put(`/v1/connectors/${con}/mappings/${wait}`)
      .send({ itemCode: ' ANY-CODE ' });
    expect(free.status, JSON.stringify(free.body)).toBe(200);
    expect(free.body).toMatchObject({ itemCode: 'ANY-CODE', status: 'MAPPED' });

    await api(app, token)
      .post(`/v1/connectors/${con}/master-codes/sync`)
      .send({ kinds: ['ITEM'] })
      .expect(200);
    const list = (await api(app, token).get(`/v1/connectors/${con}/mappings`).expect(200)).body;
    const codes = list.data.map((d: { serviceItem: { code: string } }) => d.serviceItem.code);
    expect(codes).toEqual(expect.arrayContaining(['T18-FRT', 'T18-WAIT']));
    expect(codes).not.toContain('T18-BUY'); // ฝั่งซื้อไม่ออกใบแจ้งหนี้
    expect(
      list.data.find((d: { serviceItem: { id: string } }) => d.serviceItem.id === wait),
    ).toMatchObject({
      itemCode: 'ANY-CODE',
      status: 'CODE_UNKNOWN', // ผังรหัสมาแล้ว รหัสเดิมไม่อยู่ในผัง
    });
    expect(list.summary.itemCodes).toBe(6);
    expect(list.summary.missing).toBe(list.summary.total - list.summary.mapped);

    const unknown = await api(app, token)
      .put(`/v1/connectors/${con}/mappings/${freight}`)
      .send({ itemCode: 'NOT-IN-ERP' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({ field: 'itemCode', code: 'erp_code_unknown' });

    const ok = await api(app, token)
      .put(`/v1/connectors/${con}/mappings/${freight}`)
      .send({ itemCode: 'sv-frt-01' })
      .expect(200);
    expect(ok.body).toMatchObject({
      itemCode: 'SV-FRT-01',
      itemName: 'ค่าขนส่ง',
      status: 'MAPPED',
    });

    const cleared = await api(app, token)
      .put(`/v1/connectors/${con}/mappings/${wait}`)
      .send({ itemCode: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ itemCode: null, status: 'UNMAPPED' });
    expect(
      await plat.auditLog.count({ where: { tenantId, action: 'connector.mapping_changed' } }),
    ).toBeGreaterThanOrEqual(3);

    await api(app, viewer)
      .put(`/v1/connectors/${con}/mappings/${freight}`)
      .send({ itemCode: null })
      .expect(403);
    await api(app, token)
      .put(`/v1/connectors/${con}/mappings/svc_${'0'.repeat(32)}`)
      .send({ itemCode: null })
      .expect(404);
    // tenant อื่นมองไม่เห็น
    const other = api(app, await tokenFor(otherTenant));
    await other.get(`/v1/connectors/${con}/mappings`).expect(404);
    await other
      .put(`/v1/connectors/${con}/mappings/${freight}`)
      .send({ itemCode: null })
      .expect(404);
  });

  it('เกณฑ์ตรวจรับ: ค่าบริการยังไม่ map → คำสั่งส่งใบแจ้งหนี้ FAILED_FINAL (VALIDATION) + ลิงก์หน้า mapping · map แล้วส่งถึง ERP พร้อมรหัส', async () => {
    const con = await demoConnector();
    await api(app, token)
      .post(`/v1/connectors/${con}/master-codes/sync`)
      .send({ kinds: ['ITEM'] })
      .expect(200);
    await api(app, token)
      .put(`/v1/connectors/${con}/mappings/${freight}`)
      .send({ itemCode: 'SV-FRT-01' })
      .expect(200);

    const blocked = await enqueueInvoice(con, [
      { serviceItem: { id: freight } },
      { serviceItem: { id: wait } },
    ]);
    await drain();
    const b = await cmd(blocked);
    expect(b).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    expect(b.lastError).toMatchObject({
      code: 'erp_mapping_incomplete',
      link: `/settings?sec=conn&connector=${con}`,
      missing: [
        { serviceItemId: wait, code: 'T18-WAIT', nameTh: 'ค่ารอคิวทดสอบ', status: 'UNMAPPED' },
      ],
    });
    expect(demo.documents(tenantId, uuid(con))).toHaveLength(0); // ไม่ถึง ERP

    await api(app, token)
      .put(`/v1/connectors/${con}/mappings/${wait}`)
      .send({ itemCode: 'SV-WAIT' })
      .expect(200);
    const ok = await enqueueInvoice(con, [
      { serviceItem: { id: freight } },
      { serviceItem: { id: tryDecodeId('serviceItem', wait)! } }, // uuid ก็ได้
    ]);
    await drain();
    expect((await cmd(ok)).status).toBe('DONE');
    const sent = demo.documents(tenantId, uuid(con));
    expect(sent).toHaveLength(1);
    const lines = (
      sent[0]!.document as unknown as { lines: { serviceItem: { externalId: string } }[] }
    ).lines;
    expect(lines.map((l) => l.serviceItem.externalId)).toEqual(['SV-FRT-01', 'SV-WAIT']);
    // payload ในคิวไม่ถูกแก้
    expect(JSON.stringify((await cmd(ok)).payload)).not.toContain('SV-FRT-01');

    // ERP เลิกใช้รหัสที่ map ไว้ → กันอีกครั้ง (CODE_UNKNOWN)
    demo.setMasterCodes(tenantId, uuid(con), 'ITEM', [{ code: 'SV-FRT-01' }]);
    await api(app, token)
      .post(`/v1/connectors/${con}/master-codes/sync`)
      .send({ kinds: ['ITEM'] })
      .expect(200);
    const again = await enqueueInvoice(con, [{ serviceItem: { id: wait } }]);
    await drain();
    expect((await cmd(again)).lastError).toMatchObject({
      code: 'erp_mapping_incomplete',
      missing: [{ status: 'CODE_UNKNOWN', itemCode: 'SV-WAIT' }],
    });
  });

  it('checkMapping ใช้ซ้ำได้ (ST7-T16) · ไม่มีบรรทัดค่าบริการ = ผ่าน · id ที่ไม่มีในบริษัท = NOT_FOUND', async () => {
    const con = await demoConnector();
    const svc = app.get(ErpMasterCodesService);
    const none = await db.withTenant(tenantId, (tx) => svc.checkMapping(tx, uuid(con), []));
    expect(none.gaps).toEqual([]);
    const ghost = randomUUID();
    const r = await db.withTenant(tenantId, (tx) =>
      svc.checkMapping(tx, uuid(con), [tryDecodeId('serviceItem', freight)!, ghost]),
    );
    expect(r.gaps.map((g) => g.status)).toEqual(['UNMAPPED', 'NOT_FOUND']);
    // ค่าบริการของบริษัทอื่น = ไม่พบ (RLS)
    const r2 = await db.withTenant(otherTenant, (tx) =>
      svc.checkMapping(tx, uuid(con), [tryDecodeId('serviceItem', freight)!]),
    );
    expect(r2.gaps[0]!.status).toBe('NOT_FOUND');
  });

  it('นำเข้าผังรหัสจากไฟล์ CSV (dry-run → ยืนยัน) สำหรับ connector ที่ดึงเองไม่ได้', async () => {
    const f = await api(app, token)
      .post('/v1/connectors')
      .send({
        adapterKey: 'fake-erp',
        settings: { baseUrl: 'https://erp.example.com' },
        credentials: { apiKey: GOOD_KEY },
      })
      .expect(201);
    const csv = Buffer.from(
      [
        'ระบบบัญชี,ชนิดรหัส,รหัส,ชื่อ,อัตรา (%),ใช้งาน',
        `${f.body.id},รหัสสินค้า/บริการ,IT-01,ค่าขนส่ง,,`,
        `fake-erp,หน่วย,TRIP,เที่ยว,,ใช่`,
        `fake-erp,อัตรา VAT,V7,VAT 7%,7,`,
        `fake-erp,หน่วย,trip,ซ้ำ,,`,
        `fake-erp,ไม่มีชนิดนี้,X,,,`,
        `fake-erp,หน่วย,KM,กม.,5,`,
      ].join('\n'),
      'utf8',
    );
    const a = api(app, token);
    const doc = await a
      .post('/v1/documents')
      .send({ kind: 'IMPORT', mime: 'text/csv', bytes: csv.length, filename: 'erp-codes.csv' })
      .expect(201);
    const u = new URL(doc.body.uploadUrl);
    await request(app.getHttpServer())
      .put(u.pathname + u.search)
      .set('Content-Type', 'application/octet-stream')
      .send(csv)
      .expect(200);
    const imp = await a
      .post('/v1/imports')
      .send({ kind: 'erp_master_code', documentId: doc.body.id });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    expect(imp.body.okRows).toBe(3);
    const codes = imp.body.issues.map((i: { row: number; code: string }) => `${i.row}:${i.code}`);
    expect(codes).toEqual(
      expect.arrayContaining(['5:duplicate_in_file', '6:invalid_option', '7:not_applicable']),
    );
    await a
      .patch(`/v1/imports/${imp.body.id}`)
      .send({ errorPolicy: 'skip_invalid_rows' })
      .expect(200);
    const c = await a.post(`/v1/imports/${imp.body.id}/commit`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const rows = (await a.get(`/v1/connectors/${f.body.id}/master-codes`).expect(200)).body.data;
    expect(rows.map((r: { kind: string; code: string }) => `${r.kind}:${r.code}`).sort()).toEqual([
      'ITEM:IT-01',
      'UNIT:TRIP',
      'VAT_RATE:V7',
    ]);
    expect(rows.find((r: { code: string }) => r.code === 'V7')).toMatchObject({
      rate: '7.00',
      source: 'IMPORT',
    });
    // ผู้ดูอย่างเดียวไม่เห็นชนิดนำเข้านี้
    const kinds = (await api(app, viewer).get('/v1/imports/kinds').expect(200)).body;
    expect(kinds.map((k: { kind: string }) => k.kind)).not.toContain('erp_master_code');
  });
});
