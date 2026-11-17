import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { ConnectorResolver } from '../src/modules/erp/connector-resolver';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { ERP_SINK } from '../src/modules/erp/erp-adapter.sink';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../src/modules/integration/outbox.service';
import { FakeErpAdapter, GOOD_KEY } from './fake-erp-adapter';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST7-T13 ErpAdapter + connector registry ต่อ tenant + routing ตามนิติบุคคล (docs/01 §3.7, §6.1; docs/04 G3)
 * เกณฑ์ตรวจรับ: core ไม่ import adapter ตรง (lint — test/erp-adapter.test.ts) · tenant ที่มี 2 นิติบุคคลชี้ connector ต่างกันได้
 */
describe('connectors (ST7-T13)', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  const fake = new FakeErpAdapter('fake-erp', [
    'pushInvoice',
    'pushCreditNote',
    'fetchDocument',
    'ownsDocumentNumber',
  ]);
  const other = new FakeErpAdapter('other-erp', ['pushInvoice']);
  let tenantId: string;
  let token: string;
  let readToken: string;
  const goodCreds = { apiKey: GOOD_KEY };
  const settings = { baseUrl: 'https://erp.example.com/api' };

  async function company(n: number, tid = tenantId) {
    const c = await plat.company.create({
      data: { tenantId: tid, legalName: `บริษัท ทดสอบ ${n} จำกัด`, taxId: validTaxId(9100 + n) },
    });
    const b = await plat.branch.create({
      data: {
        tenantId: tid,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        isDefaultIssuer: true,
        address: { line1: 'x', subdistrict: 'x', district: 'x', province: 'x', postcode: '10000' },
      },
    });
    return {
      id: c.id,
      branchId: b.id,
      cmp: encodeId('company', c.id),
      brn: encodeId('branch', b.id),
    };
  }

  async function create(body: Record<string, unknown>, tok = token) {
    return api(app, tok)
      .post('/v1/connectors')
      .send({ settings, credentials: goodCreds, ...body });
  }

  const uuid = (id: string) => tryDecodeId('connector', id)!;
  const due = () =>
    plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                      WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    const reg = app.get(ErpAdapterRegistry);
    reg.replace(fake);
    reg.replace(other);
    tenantId = (await createTenant(plat, 'บริษัท เชื่อมบัญชี')).id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    const userId = (
      await plat.appUser.create({
        data: { tenantId, email: 'admin@conn.test', name: 'ผู้ดูแล ทดสอบ', status: 'ACTIVE' },
      })
    ).id;
    token = await tokenFor(tenantId, '*', userId);
    readToken = await tokenFor(tenantId, 'settings:read', userId);
  });
  beforeEach(async () => {
    fake.reset();
    other.reset();
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
  });
  afterAll(async () => {
    const reg = app.get(ErpAdapterRegistry);
    reg.unregister(fake.key);
    reg.unregister(other.key);
    await app.close();
    await plat.$disconnect();
  });

  it('ไม่มี connector = Standalone (ค่าเริ่มต้นทุก tenant) · catalog เรียงตามรหัส ไม่มี standalone', async () => {
    const eff = await api(app, readToken).get('/v1/connectors/effective').expect(200);
    expect(eff.body).toMatchObject({
      standalone: true,
      connectorId: null,
      adapterKey: 'standalone',
      capabilities: [],
      sending: false,
      scope: 'none',
    });
    const cat = await api(app, readToken).get('/v1/connectors/adapters').expect(200);
    const keys = cat.body.data.map((a: { key: string }) => a.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain('fake-erp');
    expect(keys).not.toContain('standalone');
    const f = cat.body.data.find((a: { key: string }) => a.key === 'fake-erp');
    expect(f.capabilities).toEqual([
      'pushInvoice',
      'pushCreditNote',
      'fetchDocument',
      'ownsDocumentNumber',
    ]);
    expect(f.configFields).toContainEqual({
      key: 'apiKey',
      secret: true,
      required: true,
      kind: 'string',
      maxLength: null,
    });
    const list = await api(app, readToken).get('/v1/connectors').expect(200);
    expect(list.body.data).toEqual([]);
  });

  it('สร้าง: PAUSED · credential เข้ารหัส ไม่ส่งกลับ ไม่ลง audit · ขอบเขตซ้ำ 409 · ตรวจค่า 422', async () => {
    const r = await create({
      adapterKey: 'fake-erp',
      capabilitiesEnabled: ['pushInvoice'],
      syncFromDate: '2026-11-01',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.id).toMatch(/^con_[0-9a-f]{32}$/);
    expect(r.headers.etag).toBeDefined();
    expect(r.body).toMatchObject({
      adapterKey: 'fake-erp',
      displayName: 'Fake fake-erp',
      companyId: null,
      status: 'PAUSED',
      capabilitiesEnabled: ['pushInvoice'],
      capabilities: ['pushInvoice'],
      settings,
      credentialKeys: ['apiKey'],
      syncFromDate: '2026-11-01',
    });
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain(GOOD_KEY);
    const row = await plat.connector.findUniqueOrThrow({ where: { id: uuid(r.body.id) } });
    expect(row.credentialsEnc).toMatch(/^v1\./);
    expect(row.credentialsEnc).not.toContain(GOOD_KEY);
    const got = await api(app, readToken).get(`/v1/connectors/${r.body.id}`).expect(200);
    expect(JSON.stringify(got.body)).not.toContain(GOOD_KEY);
    const audits = await plat.auditLog.findMany({ where: { entityType: 'connector' } });
    expect(audits.map((a) => a.action)).toContain('connector.created');
    expect(JSON.stringify(audits.map((a) => [a.before, a.after, a.reason]))).not.toContain(
      GOOD_KEY,
    );

    // ขอบเขต "ทุกนิติบุคคล" มีอยู่แล้ว
    const dup = await create({ adapterKey: 'other-erp', credentials: goodCreds });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('connector_scope_taken');

    // ตรวจค่า
    const bad = async (body: Record<string, unknown>, field: string | RegExp) => {
      const x = await create({
        adapterKey: 'fake-erp',
        companyId: (await company(Math.floor(Math.random() * 900))).cmp,
        ...body,
      });
      expect(x.status, JSON.stringify(x.body)).toBe(422);
      if (typeof field === 'string') expect(x.body.errors[0].field).toBe(field);
      else expect(x.body.errors[0].field).toMatch(field);
    };
    await bad({ adapterKey: 'krs' }, 'adapterKey');
    await bad({ adapterKey: 'standalone' }, 'adapterKey');
    await bad({ capabilitiesEnabled: ['pushSettlement'] }, 'capabilitiesEnabled');
    await bad({ credentials: {} }, 'credentials.apiKey');
    await bad({ settings: { baseUrl: 'ftp://x' } }, 'settings.baseUrl');
    await bad({ settings: { ...settings, apiKey: GOOD_KEY } }, 'settings.apiKey');
    await bad({ credentials: { ...goodCreds, other: 'x' } }, 'credentials.other');
    await bad({ syncFromDate: '2099-01-01' }, 'syncFromDate');
    await bad({ branchMap: { [encodeId('branch', randomUUID())]: 'X' } }, /^branchMap\./);
  });

  it('เกณฑ์ตรวจรับ: tenant ที่มี 2 นิติบุคคลชี้ connector ต่างกันได้ (routing Invoice As) + ค่าเริ่มต้นทุกนิติบุคคล', async () => {
    const a = await company(1);
    const b = await company(2);
    const c = await company(3);
    const ca = await create({
      adapterKey: 'fake-erp',
      companyId: a.cmp,
      erpCompanyCode: 'A01',
      branchMap: { [a.brn]: 'A01-HQ' },
    });
    expect(ca.status, JSON.stringify(ca.body)).toBe(201);
    const cb = await create({ adapterKey: 'other-erp', companyId: b.cmp, erpCompanyCode: 'B01' });
    expect(cb.status, JSON.stringify(cb.body)).toBe(201);
    // สาขาของนิติบุคคลอื่นใน branchMap → 422
    const wrong = await api(app, token)
      .patch(`/v1/connectors/${ca.body.id}`)
      .send({ branchMap: { [b.brn]: 'X' } });
    expect(wrong.status).toBe(422);

    const eff = async (q: string) =>
      (await api(app, readToken).get(`/v1/connectors/effective?${q}`).expect(200)).body;
    expect(await eff(`companyId=${a.cmp}`)).toMatchObject({
      standalone: false,
      connectorId: ca.body.id,
      adapterKey: 'fake-erp',
      scope: 'company',
      erpCompanyCode: 'A01-HQ',
      capabilities: ['pushInvoice', 'pushCreditNote', 'fetchDocument', 'ownsDocumentNumber'],
      sending: false,
      status: 'PAUSED',
      companyId: a.cmp,
      branchId: a.brn,
    });
    expect(await eff(`companyId=${b.cmp}&kind=tender`)).toMatchObject({
      connectorId: cb.body.id,
      adapterKey: 'other-erp',
      erpCompanyCode: 'B01',
      capabilities: ['pushInvoice'],
    });
    // นิติบุคคลที่ 3 ไม่มีของตัวเอง + ยังไม่มีค่าเริ่มต้น → Standalone
    expect(await eff(`companyId=${c.cmp}`)).toMatchObject({ standalone: true, scope: 'none' });
    // เพิ่มค่าเริ่มต้นทุกนิติบุคคล → นิติบุคคลที่ 3 ใช้ตัวนั้น, A/B ยังใช้ของตัวเอง
    const all = await create({ adapterKey: 'other-erp' });
    expect(all.status).toBe(201);
    expect(await eff(`companyId=${c.cmp}`)).toMatchObject({
      connectorId: all.body.id,
      scope: 'tenant',
    });
    expect((await eff(`companyId=${a.cmp}`)).connectorId).toBe(ca.body.id);

    // resolver ใน core (ตามเอกสาร) ให้ผลเดียวกัน
    const resolver = app.get(ConnectorResolver);
    const r = await db.withTenant(tenantId, (tx) =>
      resolver.forDocument(tx, tenantId, { kind: 'invoice', partyCompanyId: b.id }),
    );
    expect(r.connector?.id).toBe(uuid(cb.body.id));
    expect(r.routing.company.id).toBe(b.id);
  });

  it('วงจรสถานะ: resume ต้องทดสอบผ่าน · AUTH → ERROR · ผ่านแล้วกลับ ACTIVE · pause · disconnect ต้องมีเหตุผล · If-Match', async () => {
    const r = await create({ adapterKey: 'fake-erp', credentials: { apiKey: 'wrong-key-xyz' } });
    const id = r.body.id as string;
    let v = r.body.version as number;
    // ทดสอบไม่ผ่าน → เปิดไม่ได้
    const no = await api(app, token).post(`/v1/connectors/${id}/resume`).send({});
    expect(no.status).toBe(409);
    expect(no.body.code).toBe('connector_health_failed');
    expect(no.body).toMatchObject({ errorClass: 'AUTH', healthCode: 'unauthorized' });
    expect(JSON.stringify(no.body)).not.toContain('wrong-key-xyz');
    // หมุน credential (stale If-Match → 412)
    await api(app, token)
      .put(`/v1/connectors/${id}/credentials`)
      .set('If-Match', `"${v + 10}"`)
      .send({ credentials: goodCreds })
      .expect(412);
    const rot = await api(app, token)
      .put(`/v1/connectors/${id}/credentials`)
      .send({ credentials: goodCreds, reason: 'หมุน key ตามรอบ' })
      .expect(200);
    expect(rot.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(rot.body)).not.toContain(GOOD_KEY);
    v = rot.body.version;
    const on = await api(app, token)
      .post(`/v1/connectors/${id}/resume`)
      .set('If-Match', `"${v}"`)
      .send({})
      .expect(200);
    expect(on.body).toMatchObject({ status: 'ACTIVE', lastHealthOk: true });
    expect(on.body.activatedAt).toBeTruthy();
    // ปลายทางปฏิเสธ credential → ERROR (ระบบหยุดเอง)
    fake.health = {
      ok: false,
      errorClass: 'AUTH',
      problem: { code: 'unauthorized', message: `key ${GOOD_KEY} revoked` },
    };
    const h = await api(app, token).post(`/v1/connectors/${id}/health`).expect(200);
    expect(h.body).toMatchObject({ ok: false, errorClass: 'AUTH', code: 'unauthorized' });
    expect(h.body.message).not.toContain(GOOD_KEY); // ตัด credential ออกจากข้อความของปลายทาง
    expect(h.body.connector.status).toBe('ERROR');
    fake.health = undefined;
    const h2 = await api(app, token).post(`/v1/connectors/${id}/health`).expect(200);
    expect(h2.body.connector.status).toBe('ACTIVE');
    const p = await api(app, token).post(`/v1/connectors/${id}/pause`).send({}).expect(200);
    expect(p.body.status).toBe('PAUSED');
    await api(app, token).post(`/v1/connectors/${id}/pause`).send({}).expect(409);
    await api(app, token).post(`/v1/connectors/${id}/disconnect`).send({}).expect(422);
    const d = await api(app, token)
      .post(`/v1/connectors/${id}/disconnect`)
      .send({ reason: 'เลิกใช้โปรแกรมบัญชีนี้แล้ว' })
      .expect(200);
    expect(d.body).toMatchObject({ status: 'DISCONNECTED', capabilities: [] });
    await api(app, token).patch(`/v1/connectors/${id}`).send({ erpCompanyCode: 'X' }).expect(409);
    // กลับเป็น Standalone และสร้างใหม่ในขอบเขตเดิมได้
    expect(
      (await api(app, readToken).get('/v1/connectors/effective').expect(200)).body.standalone,
    ).toBe(true);
    expect((await create({ adapterKey: 'fake-erp' })).status).toBe(201);
    const hist = await api(app, readToken).get(`/v1/connectors/${id}/history`).expect(200);
    const actions = hist.body.data.map((x: { action: string }) => x.action);
    for (const a of [
      'connector.created',
      'connector.credentials_changed',
      'connector.resumed',
      'connector.health_checked',
      'connector.error',
      'connector.recovered',
      'connector.paused',
      'connector.disconnected',
    ])
      expect(actions).toContain(a);
    expect(JSON.stringify(hist.body)).not.toContain(GOOD_KEY);
    expect(JSON.stringify(hist.body)).not.toContain('wrong-key-xyz');
  });

  it('สิทธิ์และแพ็กเกจ: settings:read เขียนไม่ได้ · แพ็กเกจเริ่มต้นไม่มี conn · มาตรฐานจำกัด 1 ตัว', async () => {
    await api(app, readToken).post('/v1/connectors').send({ adapterKey: 'fake-erp' }).expect(403);
    const t2 = (await createTenant(plat, 'บริษัท แพ็กเกจ')).id;
    const tok2 = await tokenFor(t2, '*', randomUUID());
    expect((await create({ adapterKey: 'fake-erp' }, tok2)).status).toBe(201); // std: 1 ตัว
    const a = await company(50, t2);
    const second = await create({ adapterKey: 'other-erp', companyId: a.cmp }, tok2);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('connector_limit_reached');
    await plat.tenant.update({ where: { id: t2 }, data: { planCode: 'start' } });
    app.get(EntitlementService).invalidate(t2);
    await api(app, tok2).get('/v1/connectors').expect(403);
    // tenant อื่นมองไม่เห็น connector ของกัน
    const mine = await api(app, readToken).get('/v1/connectors').expect(200);
    expect(mine.body.data.every((c: { id: string }) => c.id)).toBe(true);
    const theirs = await plat.connector.findFirstOrThrow({ where: { tenantId: t2 } });
    await api(app, token)
      .get(`/v1/connectors/${encodeId('connector', theirs.id)}`)
      .expect(404);
  });

  describe('sink `erp` บน integration outbox (คิวเดียวกับ webhook)', () => {
    async function activeConnector(caps = ['pushInvoice']) {
      const r = await create({ adapterKey: 'fake-erp', capabilitiesEnabled: caps });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await api(app, token).post(`/v1/connectors/${r.body.id}/resume`).send({}).expect(200);
      return uuid(r.body.id);
    }
    async function enqueue(connectorId: string, operation: string, localId = randomUUID()) {
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
          payload: { document: { id: localId, number: 'INV-00000-2611-0001' } },
        }),
      );
      return id;
    }
    const drain = async () => {
      await due();
      await dispatcher.drain();
    };
    const cmd = (id: string) => plat.integrationOutbox.findUniqueOrThrow({ where: { id } });

    it('PUSH_INVOICE ถึง adapter พร้อม idempotencyKey + config ถอดรหัส → DONE + externalId', async () => {
      const cid = await activeConnector();
      const id = await enqueue(cid, 'PUSH_INVOICE');
      await drain();
      const c = await cmd(id);
      expect(c.status).toBe('DONE');
      expect(c.result).toMatchObject({ externalId: 'ext-1', externalDocNo: 'ERP-ext-1' });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.ctx).toMatchObject({
        tenantId,
        connectorId: cid,
        idempotencyKey: c.idempotencyKey,
        config: { baseUrl: settings.baseUrl, apiKey: GOOD_KEY },
      });
    });

    it('capability ไม่ได้เปิด → SKIPPED · operation ไม่รู้จัก → FAILED_FINAL', async () => {
      const cid = await activeConnector(['pushInvoice']);
      const a = await enqueue(cid, 'PUSH_CREDIT_NOTE');
      const b = await enqueue(cid, 'PUSH_SETTLEMENT');
      const x = await enqueue(cid, 'DELETE_EVERYTHING');
      await drain();
      expect((await cmd(a)).status).toBe('SKIPPED');
      expect((await cmd(a)).errorClass).toBe('CAPABILITY');
      expect((await cmd(b)).status).toBe('SKIPPED');
      expect((await cmd(x)).status).toBe('FAILED_FINAL');
      expect(fake.calls).toHaveLength(0);
    });

    it('PAUSED → คำสั่งรอ (PENDING ไม่นับครั้ง) · DISCONNECTED → SKIPPED', async () => {
      const cid = await activeConnector();
      const conId = encodeId('connector', cid);
      await api(app, token).post(`/v1/connectors/${conId}/pause`).send({}).expect(200);
      const id = await enqueue(cid, 'PUSH_INVOICE');
      await drain();
      expect(await cmd(id)).toMatchObject({ status: 'PENDING', attempt: 0, errorClass: 'AUTH' });
      await api(app, token)
        .post(`/v1/connectors/${conId}/disconnect`)
        .send({ reason: 'ยกเลิกการเชื่อมระหว่างทดสอบ' })
        .expect(200);
      await drain();
      expect((await cmd(id)).status).toBe('SKIPPED');
      expect(fake.calls).toHaveLength(0);
    });

    it('adapter ตอบ AUTH → connector ERROR (หยุดทั้งตัว) + คำสั่งรอ · ข้อความไม่มี credential', async () => {
      const cid = await activeConnector();
      fake.fail = { errorClass: 'AUTH', message: `token ${GOOD_KEY} expired` };
      const id = await enqueue(cid, 'PUSH_INVOICE');
      await drain();
      const c = await cmd(id);
      expect(c).toMatchObject({ status: 'PENDING', errorClass: 'AUTH' });
      expect(JSON.stringify(c.lastError)).not.toContain(GOOD_KEY);
      const con = await plat.connector.findUniqueOrThrow({ where: { id: cid } });
      expect(con).toMatchObject({ status: 'ERROR', lastHealthOk: false });
      expect(JSON.stringify(con.lastHealthError)).not.toContain(GOOD_KEY);
      const audit = await plat.auditLog.findFirst({
        where: { entityId: cid, action: 'connector.error' },
      });
      expect(audit).toBeTruthy();
    });

    it('VALIDATION → FAILED_FINAL · TRANSIENT → FAILED_RETRYABLE (ตาม policy ของ dispatcher)', async () => {
      const cid = await activeConnector();
      fake.fail = { errorClass: 'VALIDATION', message: 'customer code unknown' };
      const v = await enqueue(cid, 'PUSH_INVOICE');
      await drain();
      expect(await cmd(v)).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
      fake.fail = { errorClass: 'TRANSIENT', message: '503' };
      const t = await enqueue(cid, 'PUSH_INVOICE');
      await drain();
      expect(await cmd(t)).toMatchObject({ status: 'FAILED_RETRYABLE', errorClass: 'TRANSIENT' });
    });
  });
});
