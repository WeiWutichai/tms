import type { NestExpressApplication } from '@nestjs/platform-express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient, VatType } from '@prisma/client';
import { SYSTEM_ROLES } from '@tms/domain';
import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import { DbService } from '../src/db/db.service';
import { ConnectorsService } from '../src/modules/erp/connectors.service';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import {
  MAX_IN_FLIGHT_PER_TARGET,
  OutboxDispatcher,
  RETRY_SCHEDULE_MIN,
  type ClaimedCommand,
} from '../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../src/modules/integration/outbox.service';
import { OutboxSinkRegistry } from '../src/modules/integration/outbox-sink.registry';
import { PrismaService } from '../src/db/prisma.service';
import { ErpAdapterSink } from '../src/modules/erp/erp-adapter.sink';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { safeHttpRequest } from '../src/modules/webhooks/webhook-http';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST8-T09 จัดการ error ของ KRS ตาม docs/01 Appendix A.5 (+ §6.2–6.3) — ทุกแถวของตาราง A.5 ครบวงจรกับ mock KRS (ST8-T01)
 * เกณฑ์ตรวจรับ (plan/01 ST8-T09): "ทุกแถวของตาราง A.5 มี test กับ mock และผลตรงคอลัมน์ ทำอะไร"
 *
 * | Response [KRS]            | ErrorClass | ทำอะไร (A.5)                                                                          | test |
 * | 201 (POST)                | —          | บันทึก mapping (GET AFTER_PUSH ทันที = reconcile engine ST8-T11)                          | A5-201 |
 * | 200 (PUT)                 | —          | บันทึก mapping (ST8-T13 replaceDocument · GET AFTER_PUSH = ST8-T11)                       | A5-PUT-200 |
 * | 409 tmsVoucherNo ซ้ำ       | DUPLICATE  | หา transactionNo จาก mapping · ไม่มี → คิวให้คนกรอกมือ (ต่อใบ) แล้ว GET เทียบ — ไม่ POST ซ้ำ | A5-409* |
 * | 503 DB KRS ล่ม             | TRANSIENT  | backoff 1, 2, 5, 15, 30, 60 นาที + jitter · healthCheck ไม่ผ่าน → หยุดทั้งคิว               | A5-503 |
 * | timeout / connection reset| AMBIGUOUS  | ไม่ POST ซ้ำทันที · มี transactionNo → GET · ไม่มี → รอ 2 นาทีแล้ว POST (ถึงแล้วได้ 409)    | A5-AMB* |
 * | 400                       | VALIDATION | ไม่ retry · เก็บ response ตัวเต็ม · ขึ้นคิว                                               | A5-400 |
 * | 401                       | AUTH       | หยุด connector ทั้งตัว แจ้ง admin                                                       | A5-401 |
 * | 404 (PUT/GET)             | NOT_FOUND  | REMOTE_MISSING ให้คนตัดสิน · ไม่ POST (PUT = ST8-T13)                                     | A5-404*, A5-PUT-404 |
 * Concurrency 3 ต่อ connector · serialize ต่อลูกค้า                                                                   | A5-CONC |
 */

const KEY = 'krs-a5-test-key-9e1f07';

describe('ST8-T09 ไม่แตะฐาน: แยก "ต่อไม่ติด" ออกจาก "สายหลุดหลังส่ง"', () => {
  it('ต่อไม่ติด (ECONNREFUSED) = notSent (KRS: TRANSIENT รู้แน่ว่าไม่มีใบ) · ปลายทางเปิดแต่ตัดสาย = ไม่ notSent (AMBIGUOUS)', async () => {
    // พอร์ตที่ไม่มีใครฟัง (เปิดแล้วปิดทันที)
    const port = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    const refused = await safeHttpRequest('POST', `http://127.0.0.1:${port}/invoice`, {}, '{}', {
      allowPrivate: true,
      timeoutMs: 5_000,
    });
    expect(refused).toMatchObject({ status: null, errorCode: 'network', notSent: true });
    const mock = await startMockKrs({ apiKey: KEY });
    try {
      mock.injectFault({ kind: 'reset', method: 'POST', times: 1 });
      const reset = await safeHttpRequest(
        'POST',
        `${mock.apiBaseUrl}/invoice`,
        { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
        '{}',
        { allowPrivate: true, timeoutMs: 5_000 },
      );
      expect(reset).toMatchObject({ status: null, errorCode: 'network' });
      expect(reset.notSent).toBeUndefined();
    } finally {
      await mock.stop();
    }
  });
});

describe('ST8-T09 review L3: แผนการแยกใบของ KRS ไม่ต้องผ่านผังรหัส', () => {
  it('สร้าง payload ไม่ได้ (ไม่มีผังรหัส) → ยังได้ ref ตามกลุ่ม VAT (เลขใบแจ้งหนี้ / -V7)', () => {
    const doc = {
      id: 'x',
      number: 'INV-L3',
      lines: [
        { lineNo: 1, vatType: 'VAT_7' },
        { lineNo: 2, vatType: 'EXEMPT_TRANSPORT' },
      ],
    };
    const parts = new KrsAdapter().plannedDocuments(
      { tenantId: 't', connectorId: null, companyId: null, erpCompanyCode: null, config: {} },
      doc,
    );
    expect(parts).toEqual([
      { ref: 'INV-L3', group: 'EXEMPT_TRANSPORT', lineNos: [2] },
      { ref: 'INV-L3-V7', group: 'VAT_7', lineNos: [1] },
    ]);
  });
});

describe('ST8-T09 KRS error handling ตาม A.5', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let dispatcher: OutboxDispatcher;
  let mock: MockKrs;
  let tenantId: string;
  let ppCompany: string;
  let ppBranch: string;
  let customerId: string;
  let freight: string;
  let service: string;
  let admin: string;
  let accounting: string;
  let conId: string;
  let conUuid: string;
  let seq = 0;
  let custSeq = 0;
  const today = bangkokToday();
  const prevPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  const DRIVER = 'สมชาย คนขับ A5';
  const REASON = 'ตรวจในระบบบัญชี KRS แล้วพบเอกสารเลขนี้';

  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };
  const commands = (localId: string) =>
    plat.integrationOutbox.findMany({
      where: { tenantId, sink: 'erp', localId },
      orderBy: { seq: 'asc' },
    });
  const pushCmd = async (localId: string) =>
    (await commands(localId)).find((c) => c.operation === 'PUSH_INVOICE')!;
  const reload = (id: string) => plat.integrationOutbox.findUniqueOrThrow({ where: { id } });
  const posts = () => mock.requests().filter((q) => q.method === 'POST');
  const gets = () => mock.requests().filter((q) => q.method === 'GET');
  const mapping = (localId: string) =>
    plat.externalMapping.findFirst({ where: { tenantId, entityType: 'INVOICE', localId } });
  const connector = () => plat.connector.findUniqueOrThrow({ where: { id: conUuid } });

  /** ลูกค้าใหม่ที่มีรหัสฝั่ง PP (ST8-T05) — แยก serialize key */
  async function newCustomer() {
    const n = ++custSeq;
    const c = await plat.customer.create({
      data: {
        tenantId,
        code: `C-A5-${n}`,
        legalName: `บริษัท ลูกค้า A5 ${n} จำกัด`,
        taxId: validTaxId(9300 + n),
        branchCode: '00000',
        billingAddress: { line1: '9 ถ.ตัวอย่าง', province: 'ระยอง', postcode: '21000' },
      },
    });
    await api(app, admin)
      .put(`/v1/customers/${encodeId('customer', c.id)}/erp-codes/${conId}`)
      .send({ externalId: `PP-A5-${n}` })
      .expect(200);
    return c.id;
  }

  async function deliveryOrder(cust = customerId) {
    const tag = `A${++seq}`;
    const site = (k: string) =>
      plat.customerSite.create({
        data: { tenantId, code: `S${k}-${tag}`, name: `คลัง ${k} ${tag}`, address: { line1: 'x' } },
      });
    const [a, b] = [await site('A'), await site('B')];
    const so = await plat.salesOrder.create({
      data: {
        tenantId,
        soNo: `SO-${tag}`,
        externalId: `KRS-NSF-SAMPLE-SO-${tag}`,
        source: 'MANUAL',
        customerId: cust,
        billingCompanyId: ppCompany,
        requestedDate: new Date(`${today}T00:00:00Z`),
        status: 'RECEIVED',
      },
    });
    const trip = await plat.trip.create({
      data: {
        tenantId,
        tripNo: `TRP-${tag}`,
        tripDate: new Date(`${today}T00:00:00Z`),
        vehiclePlateSnapshot: '70-5555',
        driverNameSnapshot: DRIVER,
      },
    });
    return plat.deliveryOrder.create({
      data: {
        tenantId,
        doNo: `DO-${tag}`,
        doDate: new Date(`${today}T00:00:00Z`),
        salesOrderId: so.id,
        customerId: cust,
        tripId: trip.id,
        originSiteId: a.id,
        destSiteId: b.id,
        originStopSeq: 1,
        destStopSeq: 2,
      },
    });
  }

  type Line = { vat: VatType; amount: string };
  /** ใบแจ้งหนี้ที่ finalize แล้ว (1 DO ต่อบรรทัด) */
  async function invoice(lines: Line[], customer?: string) {
    // ลูกค้าใหม่ต่อใบ (คีย์ serialize ของตัวเอง — ไม่ติดคิวของ test อื่น) เว้นแต่ระบุ
    const cust = customer ?? (await newCustomer());
    const dos: { id: string }[] = [];
    for (const _ of lines) dos.push(await deliveryOrder(cust));
    const inv = await plat.invoice.create({
      data: {
        tenantId,
        customerId: cust,
        issuingCompanyId: ppCompany,
        issuingBranchId: ppBranch,
        status: 'DRAFT',
        creditTermDays: 30,
        createdBy: 'u-prep',
        lines: {
          create: lines.map((l, i) => ({
            tenantId,
            lineNo: i + 1,
            serviceItemId: l.vat === 'VAT_7' ? service : freight,
            description: l.vat === 'VAT_7' ? 'ค่ายกขน' : 'ค่าขนส่ง',
            quantity: '1',
            unitLabel: 'เที่ยว',
            unitPrice: l.amount,
            amount: l.amount,
            vatType: l.vat,
            vatAmount: l.vat === 'VAT_7' ? (Number(l.amount) * 0.07).toFixed(2) : '0',
            whtRate: l.vat === 'VAT_7' ? '3.00' : '1.00',
            deliveryOrderId: dos[i]!.id,
            doAnchor: true,
          })),
        },
      },
    });
    const id = encodeId('invoice', inv.id);
    const r = await api(app, accounting)
      .post(`/v1/invoices/${id}/finalize`)
      .set('If-Match', `"${inv.version}"`)
      .send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { uuid: inv.id, id, invoiceNo: r.body.invoiceNo as string };
  }
  const single = (amount: string, cust?: string) =>
    invoice([{ vat: 'EXEMPT_TRANSPORT', amount }], cust);
  const split = (a: string, b: string) =>
    invoice([
      { vat: 'EXEMPT_TRANSPORT', amount: a },
      { vat: 'VAT_7', amount: b },
    ]);
  const enterIds = (commandId: string, body: Record<string, unknown>) =>
    api(app, accounting)
      .post(`/v1/connectors/${conId}/queue/${encodeId('outboxCommand', commandId)}/external-id`)
      .send({ reason: REASON, ...body });
  /** KRS ล้างคำสั่งค้างทั้งหมดของ connector (กัน test ก่อนหน้ากระทบ) */
  const settleAll = async () => {
    mock.clearFaults();
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', done_at = now(), lease_id = NULL, lease_until = NULL
                            WHERE tenant_id = ${tenantId}::uuid AND status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
  };
  const activate = async () => {
    await plat.connector.update({
      where: { id: conUuid },
      data: {
        status: 'ACTIVE',
        statusReason: null,
        healthFailingSince: null,
        lastHealthError: undefined,
      },
    });
  };

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    await truncateAll();
    app = await bootApp();
    dispatcher = app.get(OutboxDispatcher);
    app.get(ErpAdapterRegistry).replace(new KrsAdapter({ allowPrivate: true }));
    // timeout ของ mock สั้น (ค้างแล้วตัดสาย) — A.5 timeout/connection reset
    mock = await startMockKrs({ apiKey: KEY, timeoutMs: 300 });
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ขนส่ง A5 ทดสอบ จำกัด' })).id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    const c = await plat.company.create({
      data: { tenantId, legalName: 'บริษัท พีพี A5 จำกัด', taxId: validTaxId(9201) },
    });
    ppCompany = c.id;
    ppBranch = (
      await plat.branch.create({
        data: {
          tenantId,
          companyId: c.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          isDefaultIssuer: true,
          address: { line1: '1', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
        },
      })
    ).id;
    const item = (code: string, vatType: VatType, whtRate: string) =>
      plat.serviceItem.create({
        data: {
          tenantId,
          code,
          nameTh: code,
          vatType,
          whtRate,
          calcUnit: 'PER_TRIP',
          unitLabel: 'เที่ยว',
          side: 'SELL',
        },
      });
    freight = (await item('A5-FRT', 'EXEMPT_TRANSPORT', '1.00')).id;
    service = (await item('A5-LIFT', 'VAT_7', '3.00')).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    const r = await api(app, admin)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'krs',
        companyId: encodeId('company', ppCompany),
        settings: { baseUrl: mock.apiBaseUrl, salePerson: 'S01' },
        credentials: { apiKey: KEY },
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    conId = r.body.id;
    conUuid = tryDecodeId('connector', conId)!;
    for (const [kind, code] of [
      ['UNIT', 'เที่ยว'],
      ['SALESPERSON', 'S01'],
    ] as const)
      await plat.erpMasterCode.create({
        data: { tenantId, connectorId: conUuid, kind, code, name: code, source: 'IMPORT' },
      });
    for (const [serviceItemId, itemCode] of [
      [freight, 'SAMPLE-ITEM-FRT'],
      [service, 'SAMPLE-ITEM-LIFT'],
    ] as const)
      await plat.erpCodeMapping.create({
        data: { tenantId, connectorId: conUuid, serviceItemId, itemCode },
      });
    await api(app, admin).post(`/v1/connectors/${conId}/resume`).send({}).expect(200);
    const on = await api(app, admin)
      .patch(`/v1/connectors/${conId}`)
      .send({
        capabilitiesEnabled: [
          'pullOrders',
          'pushInvoice',
          'ownsDocumentNumber',
          'fetchDocument',
          // ST8-T13 แถว PUT ของ A.5
          'replaceDocument',
        ],
      });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    customerId = await newCustomer();
  });
  beforeEach(async () => {
    // คำสั่งค้างของ test ก่อนหน้าไม่ถูกส่งระหว่าง test นี้ (นับ POST/GET ได้ตรง)
    await settleAll();
    await activate();
  });
  afterAll(async () => {
    if (prevPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = prevPrivate;
    await mock?.stop();
    await app?.close();
    await plat.$disconnect();
  });

  // ---------- concurrency / serialize (A.5 ย่อหน้าท้าย; docs/01 §6.2 ชั้น worker) ----------

  it('A5-CONC: ส่งพร้อมกันได้ไม่เกิน 3 คำสั่งต่อ connector · คำสั่งของลูกค้าเดียวกันเรียงทีละคำสั่ง (ใบหลังไม่แซงใบก่อน)', async () => {
    await settleAll();
    expect(MAX_IN_FLIGHT_PER_TARGET).toBe(3);
    const custs = [customerId];
    for (let i = 0; i < 4; i++) custs.push(await newCustomer());
    // ลูกค้าแรกมี 2 ใบ (ใบที่สองต้องรอใบแรก) · ลูกค้าอื่นคนละใบ
    const invs = [await single('101.00', custs[0])];
    invs.push(await single('102.00', custs[0]));
    for (const cu of custs.slice(1)) invs.push(await single('103.00', cu));
    const cmds = await Promise.all(invs.map((i) => pushCmd(i.uuid)));
    // serialize key = (sink, connector, ลูกค้า) — ไม่ใช่ต่อเอกสาร
    expect(cmds[0]!.serializeKey).toBe(cmds[1]!.serializeKey);
    expect(cmds[0]!.serializeKey).toContain(`erp:${conUuid}:cus:`);
    expect(new Set(cmds.map((c) => c.serializeKey)).size).toBe(5);
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE tenant_id = ${tenantId}::uuid AND status = 'PENDING'`;
    // review L1: 2 dispatcher (เหมือน 2 process — mutex ในหน่วยความจำไม่ช่วย) หยิบพร้อมกัน — advisory lock ต่อปลายทางกันนับเกิน
    const other = new OutboxDispatcher(
      app.get(PrismaService),
      app.get(DbService),
      app.get(OutboxSinkRegistry),
    );
    const got = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? other : dispatcher).claim()),
    );
    const claimed: ClaimedCommand[] = got.filter((c): c is ClaimedCommand => !!c);
    try {
      // เพดาน 3 ต่อ connector (docs/01 §6.2 config.maxConcurrency default 3; A.5 "จำกัด 3 ต่อ connector")
      expect(claimed).toHaveLength(3);
      expect(new Set(claimed.map((c) => c.serializeKey)).size).toBe(3);
      // ใบที่สองของลูกค้าแรกไม่ถูกหยิบระหว่างใบแรกยังไม่จบ (หัวคิวเท่านั้น)
      expect(claimed.map((c) => c.id)).not.toContain(cmds[1]!.id);
      // runNow (ส่งทันทีด้วยมือ) ก็เคารพเพดานเดียวกัน
      expect(await dispatcher.runNow(cmds[1]!.id)).toBe(false);
    } finally {
      await dispatcher.release(claimed);
    }
    const before = posts().length;
    await drain();
    expect(posts().length - before).toBe(6);
    for (const c of cmds) expect((await reload(c.id)).status).toBe('DONE');
    // ลำดับ: ใบแรกของลูกค้าแรกถึง KRS ก่อนใบที่สอง
    const a = mock.getInvoiceByTmsVoucherNo(invs[0]!.invoiceNo)!;
    const b = mock.getInvoiceByTmsVoucherNo(invs[1]!.invoiceNo)!;
    expect(Number(a.transactionNo)).toBeLessThan(Number(b.transactionNo));
  });

  // ---------- 201 ----------

  it('A5-201: POST 201 → บันทึก mapping (transactionNo / voucherNo) SYNCED · GET AFTER_PUSH = reconcile engine ST8-T11', async () => {
    const inv = await single('201.00');
    const before = posts().length;
    await drain();
    expect(posts().length - before).toBe(1);
    const got = mock.getInvoiceByTmsVoucherNo(inv.invoiceNo)!;
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'SYNCED',
      externalId: got.transactionNo,
      externalDocNo: got.voucherNo,
    });
  });

  // M2 (review): แถว A.5 ที่ย้ายไป task อื่น (plan/01 แถว ST8-T09)
  it.todo(
    'A5-201→GET: GET ทันที 1 ครั้งหลัง 201 (reconcile AFTER_PUSH → ACCEPTED/MISMATCH) — ST8-T11 (docs/01 §6.5)',
  );

  /**
   * ST8-T13 ใบออกใหม่แทนใบที่ยกเลิก (D-54 ภาพหลังปรับ) → `PUT /invoice/{transactionNo}` ของใบเดิม — ร่างใบใหม่สร้างตรงในฐาน
   * (`replaces_invoice_id` เหมือนที่ ST5-T10 `reissue` สร้าง — DO ของชุดนี้ไม่ผ่านการตรวจพร้อมวางบิล) · ยกเลิกใบเดิมผ่าน API จริง
   */
  async function reissued(orig: { uuid: string; id: string }, amount: string) {
    const cur = (await api(app, admin).get(`/v1/invoices/${orig.id}`).expect(200)).body;
    await api(app, admin)
      .post(`/v1/invoices/${orig.id}/void`)
      .set('If-Match', `"${cur.version}"`)
      .send({ reason: 'ราคาผิด ออกฉบับใหม่แทน' })
      .expect(200);
    const src = await plat.invoice.findUniqueOrThrow({
      where: { id: orig.uuid },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    const inv = await plat.invoice.create({
      data: {
        tenantId,
        customerId: src.customerId,
        issuingCompanyId: src.issuingCompanyId,
        issuingBranchId: src.issuingBranchId,
        status: 'DRAFT',
        creditTermDays: 30,
        createdBy: 'u-prep',
        replacesInvoiceId: src.id,
        lines: {
          create: src.lines.map((l) => ({
            tenantId,
            lineNo: l.lineNo,
            serviceItemId: l.serviceItemId,
            description: l.description,
            quantity: l.quantity,
            unitLabel: l.unitLabel,
            unitPrice: amount,
            amount,
            vatType: l.vatType,
            vatAmount: '0',
            whtRate: l.whtRate,
            deliveryOrderId: l.deliveryOrderId,
            doAnchor: true,
          })),
        },
      },
    });
    const id = encodeId('invoice', inv.id);
    const r = await api(app, accounting)
      .post(`/v1/invoices/${id}/finalize`)
      .set('If-Match', `"${inv.version}"`)
      .send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { uuid: inv.id, id };
  }
  const puts = () => mock.requests().filter((q) => q.method === 'PUT');
  const replaceOf = async (localId: string) =>
    (await commands(localId)).find((c) => c.operation === 'REPLACE_DOCUMENT')!;

  it('A5-PUT-200 (ST8-T13): PUT 200 → บันทึก mapping (เอกสาร KRS เดิม → ใบใหม่ SYNCED) · ไม่ POST · GET AFTER_PUSH = ST8-T11', async () => {
    const orig = await single('200.00');
    await drain();
    const txNo = (await mapping(orig.uuid))!.externalId!;
    const b = await reissued(orig, '180.00');
    const [p0, q0] = [posts().length, puts().length];
    await drain();
    expect(posts().length).toBe(p0);
    expect(puts().length - q0).toBe(1);
    expect(await reload((await replaceOf(b.uuid)).id)).toMatchObject({ status: 'DONE' });
    expect(await mapping(b.uuid)).toMatchObject({ status: 'SYNCED', externalId: txNo });
    expect(mock.getInvoice(txNo)!.data.lines.map((l) => Number(l.unitPrice))).toEqual([180]);
  });

  it('A5-PUT-404 (ST8-T13): PUT ได้ 404 → ไม่ POST · FAILED_FINAL NOT_FOUND + mapping ใบเดิม MISMATCH + REMOTE_MISSING ให้คนตัดสิน', async () => {
    const orig = await single('404.40');
    await drain();
    const txNo = (await mapping(orig.uuid))!.externalId!;
    const b = await reissued(orig, '400.00');
    mock.injectFault({ status: 404, method: 'PUT', times: 1 });
    const p0 = posts().length;
    await drain();
    expect(posts().length).toBe(p0);
    expect(await reload((await replaceOf(b.uuid)).id)).toMatchObject({
      status: 'FAILED_FINAL',
      errorClass: 'NOT_FOUND',
    });
    expect(await mapping(orig.uuid)).toMatchObject({
      status: 'MISMATCH',
      externalId: txNo,
      lastError: { code: 'remote_missing', errorClass: 'NOT_FOUND' },
    });
    expect(await mapping(b.uuid)).toBeNull();
    expect(
      await plat.reconcileResult.findFirst({ where: { tenantId, localId: orig.uuid } }),
    ).toMatchObject({ result: 'REMOTE_MISSING', severity: 'MONEY' });
    // เอกสาร KRS ไม่ถูกแตะ
    expect(mock.getInvoice(txNo)!.revision).toBe(1);
  });

  // ---------- 409 DUPLICATE ----------

  it('A5-409a: ไม่รู้ transactionNo (POST แรกที่ response หาย) → 409 → ไม่ POST ซ้ำ · คิวให้คนกรอก → GET เทียบ → SYNCED', async () => {
    const inv = await single('409.00');
    // KRS บันทึกใบแล้ว แต่ไม่มีหลักฐานฝั่งเรา (เช่น สร้างจากรอบที่ worker ตายก่อนบันทึก sync log)
    mock.injectFault({ kind: 'reset-after-commit', method: 'POST', times: 1 });
    const before = posts().length;
    await drain();
    await drain();
    expect(
      posts()
        .slice(before)
        .map((q) => q.status),
    ).toEqual(['reset', 409]);
    const cmd = await pushCmd(inv.uuid);
    const row = await reload(cmd.id);
    expect(row).toMatchObject({ status: 'DONE', errorClass: 'DUPLICATE' });
    expect(row.lastError).toMatchObject({
      code: 'duplicate_unresolved',
      manualExternalIdRequired: true,
    });
    // ขึ้นคิว "ล้มเหลว" ให้คนกรอกเลข
    const q = await api(app, accounting)
      .get(`/v1/connectors/${conId}/queue?tab=failed&errorClass=DUPLICATE`)
      .expect(200);
    const item = q.body.data.find(
      (x: { id: string }) => x.id === encodeId('outboxCommand', cmd.id),
    );
    expect(item).toMatchObject({ manualExternalIdRequired: true, actions: { externalId: true } });
    // ระบบรอ — ส่งซ้ำอัตโนมัติไม่ได้ (ไม่ POST ซ้ำ)
    await drain();
    expect(posts().length - before).toBe(2);
    // คนกรอก transactionNo จาก KRS → GET เทียบ (ไม่ POST)
    const got = mock.getInvoiceByTmsVoucherNo(inv.invoiceNo)!;
    const g = gets().length;
    const r = await enterIds(cmd.id, { externalId: got.transactionNo });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      tab: 'done',
      resolution: { kind: 'MANUAL_EXTERNAL_ID', externalId: got.transactionNo },
    });
    expect(r.body.resolution.supersededBy).toBeTruthy();
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'PENDING',
      externalId: got.transactionNo,
      detail: { documentsPartial: true, documentsComplete: false },
    });
    await drain();
    expect(posts().length - before).toBe(2);
    expect(gets().length - g).toBe(1);
    const verify = tryDecodeId('outboxCommand', r.body.resolution.supersededBy)!;
    expect(await reload(verify)).toMatchObject({ status: 'DONE' });
    const m = await mapping(inv.uuid);
    expect(m).toMatchObject({ status: 'SYNCED', externalId: got.transactionNo });
    expect((m!.detail as Record<string, unknown>)?.documentsPartial).toBeUndefined();
    expect(mock.listInvoices().filter((i) => i.data.tmsVoucherNo === inv.invoiceNo)).toHaveLength(
      1,
    );
    const audit = await plat.auditLog.findFirst({
      where: { tenantId, action: 'connector.queue_external_id' },
      orderBy: { seq: 'desc' },
    });
    expect(audit).toMatchObject({ reason: REASON, actorId: 'u-acc' });
  });

  it('A5-409b (ใบที่แยก): ใบแรกรู้เลขแล้ว ใบที่ 2 ได้ 409 → คิว → กรอกเลขต่อใบ (ตรวจ ref กับการแยกใบ) → GET ทั้งสองใบ → SYNCED ไม่ POST ซ้ำ', async () => {
    // ใบที่ 2 (-V7) ถูกบันทึกใน KRS แล้วแต่ response หาย
    mock.injectFault({ kind: 'reset-after-commit', method: 'POST', skip: 1, times: 1 });
    const inv = await split('3000.00', '450.00');
    const before = posts().length;
    await drain();
    await drain();
    // POST ใบแรก 201 · ใบที่ 2 สายหลุด (AMBIGUOUS) → รอบถัดไป GET ใบแรก (รู้เลข) แล้ว POST ใบที่ 2 → 409
    expect(
      posts()
        .slice(before)
        .map((q) => q.status),
    ).toEqual([201, 'reset', 409]);
    const cmd = await pushCmd(inv.uuid);
    expect(await reload(cmd.id)).toMatchObject({ status: 'DONE', errorClass: 'DUPLICATE' });
    const p1 = mock.getInvoiceByTmsVoucherNo(inv.invoiceNo)!;
    const p2 = mock.getInvoiceByTmsVoucherNo(`${inv.invoiceNo}-V7`)!;
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'MISMATCH',
      externalId: p1.transactionNo,
    });
    // ใบเดียวไม่พอ (แผนมี 2 ใบ)
    const one = await enterIds(cmd.id, { externalId: p2.transactionNo });
    expect(one.status).toBe(422);
    expect(one.body.errors[0]).toMatchObject({ field: 'documents', code: 'documents_required' });
    // ref นอกแผน
    const bad = await enterIds(cmd.id, {
      documents: [{ ref: `${inv.invoiceNo}-V0`, externalId: p2.transactionNo }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'documents[0].ref', code: 'unknown_ref' });
    // ใบแรกที่ระบบรู้เลขแล้วต้องตรง
    const wrong = await enterIds(cmd.id, {
      documents: [
        { ref: inv.invoiceNo, externalId: '99999911' },
        { ref: `${inv.invoiceNo}-V7`, externalId: p2.transactionNo },
      ],
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors[0]).toMatchObject({ code: 'known_mismatch' });
    // id เดียวกันสองใบ
    const dupId = await enterIds(cmd.id, {
      documents: [
        { ref: inv.invoiceNo, externalId: p1.transactionNo },
        { ref: `${inv.invoiceNo}-V7`, externalId: p1.transactionNo },
      ],
    });
    expect(dupId.status).toBe(422);
    // ส่งทั้ง externalId และ documents = 422
    const both = await enterIds(cmd.id, {
      externalId: p2.transactionNo,
      documents: [{ ref: `${inv.invoiceNo}-V7`, externalId: p2.transactionNo }],
    });
    expect(both.status).toBe(422);
    // ผู้ใช้ API key (ไม่ใช่คน) = 403
    const owner = await plat.appUser.create({
      data: { tenantId, email: `key-${seq}@a5.test`, name: 'เจ้าของ key', status: 'ACTIVE' },
    });
    const k = await api(app, await tokenFor(tenantId, '*', owner.id))
      .post('/v1/api-keys')
      .send({ name: 'A5 queue', scopes: ['integrations:read', 'integrations:retry'] });
    expect(k.status, JSON.stringify(k.body)).toBe(201);
    await api(app, k.body.secret as string)
      .post(`/v1/connectors/${conId}/queue/${encodeId('outboxCommand', cmd.id)}/external-id`)
      .send({
        reason: REASON,
        documents: [{ ref: `${inv.invoiceNo}-V7`, externalId: p2.transactionNo }],
      })
      .expect(403);
    // กรอกเฉพาะใบที่ขาด (ใบแรกระบบรู้แล้ว)
    const g = gets().length;
    const ok = await enterIds(cmd.id, {
      documents: [
        {
          ref: `${inv.invoiceNo}-V7`,
          externalId: p2.transactionNo,
          externalDocNo: p2.voucherNo,
        },
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.resolution).toMatchObject({
      kind: 'MANUAL_EXTERNAL_ID',
      externalId: p1.transactionNo,
    });
    const m0 = await mapping(inv.uuid);
    expect(m0).toMatchObject({ status: 'PENDING', externalId: p1.transactionNo });
    expect(m0!.detail).toMatchObject({
      documentsPartial: true,
      documentsComplete: false,
      documents: [
        { ref: inv.invoiceNo, externalId: p1.transactionNo, group: 'EXEMPT_TRANSPORT' },
        { ref: `${inv.invoiceNo}-V7`, externalId: p2.transactionNo, group: 'VAT_7' },
      ],
    });
    const audit = await plat.auditLog.findFirst({
      where: { tenantId, action: 'connector.queue_external_id' },
      orderBy: { seq: 'desc' },
    });
    expect(audit?.after).toMatchObject({
      documentsPlanned: 2,
      documents: [
        { ref: inv.invoiceNo, entered: false },
        { ref: `${inv.invoiceNo}-V7`, externalId: p2.transactionNo, entered: true },
      ],
    });
    // กรอกซ้ำไม่ได้ (จัดการแล้ว)
    expect(
      (
        await enterIds(cmd.id, {
          documents: [{ ref: `${inv.invoiceNo}-V7`, externalId: p2.transactionNo }],
        })
      ).status,
    ).toBe(409);
    const postsBefore = posts().length;
    await drain();
    expect(posts().length).toBe(postsBefore);
    expect(gets().length - g).toBe(2);
    const m = await mapping(inv.uuid);
    expect(m).toMatchObject({ status: 'SYNCED', externalId: p1.transactionNo });
    const detail = m!.detail as { documents: { externalId: string }[] };
    expect(detail.documents.map((x) => x.externalId)).toEqual([p1.transactionNo, p2.transactionNo]);
    expect(
      mock.listInvoices().filter((i) => i.data.tmsVoucherNo === `${inv.invoiceNo}-V7`),
    ).toHaveLength(1);
  });

  it('A5-409c: เลขที่กรอกผูกกับเอกสารอื่นแล้ว (รวมใบใน detail.documents) = 409 external_id_conflict', async () => {
    const other = await split('3100.00', '460.00');
    await drain();
    const taken = ((await mapping(other.uuid))!.detail as { documents: { externalId: string }[] })
      .documents[1]!.externalId;
    const inv = await single('409.30');
    mock.injectFault({ kind: 'reset-after-commit', method: 'POST', times: 1 });
    await drain();
    await drain();
    const cmd = await pushCmd(inv.uuid);
    expect(await reload(cmd.id)).toMatchObject({ errorClass: 'DUPLICATE' });
    const r = await enterIds(cmd.id, { externalId: taken });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('external_id_conflict');
  });

  /** ใบใน KRS ที่ไม่มี mapping ฝั่ง TMS (เช่น ของใบอื่น) — คืน transactionNo */
  async function decoyKrsDoc(amount: string) {
    const decoy = await single(amount);
    await drain();
    const no = mock.getInvoiceByTmsVoucherNo(decoy.invoiceNo)!.transactionNo;
    // ลบ mapping ของใบล่อ (ทำเหมือนเป็นใบที่ TMS ไม่รู้จัก) — ทดสอบการตรวจ ref เท่านั้น
    await plat.externalMapping.deleteMany({ where: { tenantId, localId: decoy.uuid } });
    return no;
  }
  /** ใบแยก 2 ใบ: ใบแรกถึง KRS แต่ผลหาย → POST ซ้ำได้ 409 → คิวให้คนกรอก (ไม่รู้เลขใบใดเลย · ใบที่ 2 ยังไม่ถูกสร้าง) */
  async function splitUnresolved(a: string, b: string) {
    mock.injectFault({ kind: 'reset-after-commit', method: 'POST', times: 1 });
    const inv = await split(a, b);
    await drain();
    await drain();
    const cmd = await pushCmd(inv.uuid);
    expect(await reload(cmd.id)).toMatchObject({ status: 'DONE', errorClass: 'DUPLICATE' });
    expect(mock.getInvoiceByTmsVoucherNo(`${inv.invoiceNo}-V7`)).toBeUndefined();
    return { inv, cmd };
  }
  const rejectedBack = async (commandId: string) => {
    const row = await reload(commandId);
    expect(row).toMatchObject({ status: 'DONE', errorClass: 'DUPLICATE' });
    expect(row.lastError).toMatchObject({
      code: 'manual_external_id_rejected',
      manualExternalIdRequired: true,
    });
    // กลับเข้าคิวล้มเหลวให้คนกรอกใหม่
    const q = await api(app, accounting)
      .get(`/v1/connectors/${conId}/queue?tab=failed&errorClass=DUPLICATE`)
      .expect(200);
    const item = q.body.data.find(
      (x: { id: string }) => x.id === encodeId('outboxCommand', commandId),
    );
    expect(item).toMatchObject({
      manualExternalIdRequired: true,
      actions: { externalId: true, retry: false },
      guide: { key: 'manual_external_id_rejected' },
    });
    return row;
  };

  it('A5-409d (review H1): กรอก id ที่มีอยู่ใน KRS แต่เป็นของใบอื่น (ใบอื่นไม่ได้กรอก) → GET แล้ว tmsVoucherNo ไม่ตรง = ไม่นับว่ามี · ไม่ POST ใบที่เหลือ · กลับเข้าคิว', async () => {
    const decoyNo = await decoyKrsDoc('409.40');
    const { inv, cmd } = await splitUnresolved('3200.00', '470.00');
    const r = await enterIds(cmd.id, { documents: [{ ref: inv.invoiceNo, externalId: decoyNo }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = posts().length;
    const g = gets().length;
    await drain();
    // ก่อนแก้ H1: ใบแรก "มีแล้ว" → POST ใบ -V7 ทั้งที่ใบแรกผิด · ตอนนี้: GET แล้วหยุด
    expect(posts().length).toBe(p);
    expect(gets().length - g).toBe(1);
    expect(mock.getInvoiceByTmsVoucherNo(`${inv.invoiceNo}-V7`)).toBeUndefined();
    const verify = tryDecodeId('outboxCommand', r.body.resolution.supersededBy)!;
    const row = await rejectedBack(verify);
    expect(row.lastError).toMatchObject({
      mismatched: [{ externalId: decoyNo, expectedRef: inv.invoiceNo }],
    });
    const m = await mapping(inv.uuid);
    expect(m).toMatchObject({
      status: 'MISMATCH',
      externalId: null,
      lastError: { code: 'manual_external_id_rejected' },
    });
    expect((m!.detail as Record<string, unknown> | null)?.documents).toBeUndefined();
    expect(await plat.reconcileResult.count({ where: { tenantId, localId: inv.uuid } })).toBe(0);
  });

  it('A5-409e (review H1/M1): สลับเลขของ 2 ใบ → ไม่ตรงทั้งคู่ → ตัดเลขที่กรอกทิ้ง กลับเข้าคิว · กรอกใหม่ถูกใบ → GET ทั้งสองใบ → SYNCED ไม่ POST', async () => {
    const { inv, cmd } = await splitUnresolved('3300.00', '480.00');
    // ใบที่ 2 ถูกสร้างใน KRS ทางอื่น (เช่น worker ตายหลัง 201)
    const p1 = mock.getInvoiceByTmsVoucherNo(inv.invoiceNo)!;
    const res = await fetch(`${mock.apiBaseUrl}/invoice`, {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...p1.data,
        tmsVoucherNo: `${inv.invoiceNo}-V7`,
        lines: p1.data.lines,
      }),
    });
    expect(res.status).toBe(201);
    const p2 = mock.getInvoiceByTmsVoucherNo(`${inv.invoiceNo}-V7`)!;
    const swapped = await enterIds(cmd.id, {
      documents: [
        { ref: inv.invoiceNo, externalId: p2.transactionNo },
        { ref: `${inv.invoiceNo}-V7`, externalId: p1.transactionNo },
      ],
    });
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    const p = posts().length;
    await drain();
    expect(posts().length).toBe(p);
    const verify = tryDecodeId('outboxCommand', swapped.body.resolution.supersededBy)!;
    const row = await rejectedBack(verify);
    expect((row.lastError as { mismatched: unknown[] }).mismatched).toHaveLength(2);
    expect(await mapping(inv.uuid)).toMatchObject({ status: 'MISMATCH', externalId: null });
    // กรอกใหม่บนคำสั่งยืนยันที่กลับเข้าคิว — ใบที่ 2 ของ KRS ถูกสร้างด้วยรายการของใบแรก → เนื้อหาไม่ตรง = MISMATCH (ไม่ SYNCED)
    const fixed = await enterIds(verify, {
      documents: [
        { ref: inv.invoiceNo, externalId: p1.transactionNo },
        { ref: `${inv.invoiceNo}-V7`, externalId: p2.transactionNo },
      ],
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    await drain();
    expect(posts().length).toBe(p);
    const m = await mapping(inv.uuid);
    expect(m).toMatchObject({ externalId: p1.transactionNo });
    expect(m!.status).not.toBe('PENDING');
    expect(
      (m!.detail as { documents: { externalId: string }[] }).documents.map((x) => x.externalId),
    ).toEqual([p1.transactionNo, p2.transactionNo]);
  });

  it('A5-409f (review M1): เลขที่คนกรอกแต่ยังไม่ได้ยืนยัน แก้ทับได้ (audit replaced) · เลขที่ระบบยืนยันแล้วแก้ไม่ได้ (422)', async () => {
    mock.injectFault({ kind: 'reset-after-commit', method: 'POST', skip: 1, times: 1 });
    const inv = await split('3400.00', '490.00');
    await drain();
    await drain();
    const cmd = await pushCmd(inv.uuid);
    expect(await reload(cmd.id)).toMatchObject({ errorClass: 'DUPLICATE' });
    const p1 = mock.getInvoiceByTmsVoucherNo(inv.invoiceNo)!;
    const p2 = mock.getInvoiceByTmsVoucherNo(`${inv.invoiceNo}-V7`)!;
    const first = await enterIds(cmd.id, {
      documents: [{ ref: `${inv.invoiceNo}-V7`, externalId: '99999913' }],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // จำลอง: คำสั่งยืนยันกลับเข้าคิวก่อนได้อ่าน KRS (ยังไม่ยืนยันเลขที่กรอก)
    const verify = tryDecodeId('outboxCommand', first.body.resolution.supersededBy)!;
    await plat.$executeRaw`UPDATE integration_outbox
                              SET status = 'DONE', error_class = 'DUPLICATE', done_at = now(),
                                  last_error = '{"code":"duplicate_unresolved","manualExternalIdRequired":true}'::jsonb
                            WHERE id = ${verify}::uuid`;
    expect((await mapping(inv.uuid))!.detail).toMatchObject({
      documents: [
        { ref: inv.invoiceNo, externalId: p1.transactionNo },
        { ref: `${inv.invoiceNo}-V7`, externalId: '99999913', source: 'manual' },
      ],
    });
    // ใบแรก (ระบบยืนยันเอง) แก้ไม่ได้
    const locked = await enterIds(verify, {
      documents: [{ ref: inv.invoiceNo, externalId: '99999914' }],
    });
    expect(locked.status).toBe(422);
    expect(locked.body.errors[0]).toMatchObject({ code: 'known_mismatch' });
    const again = await enterIds(verify, {
      documents: [{ ref: `${inv.invoiceNo}-V7`, externalId: p2.transactionNo }],
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const audit = await plat.auditLog.findFirst({
      where: { tenantId, action: 'connector.queue_external_id' },
      orderBy: { seq: 'desc' },
    });
    expect(audit?.after).toMatchObject({
      replaced: [{ ref: `${inv.invoiceNo}-V7`, from: '99999913', to: p2.transactionNo }],
    });
    const p = posts().length;
    await drain();
    expect(posts().length).toBe(p);
    expect(await mapping(inv.uuid)).toMatchObject({ status: 'SYNCED' });
  });

  // ---------- 503 TRANSIENT ----------

  it('A5-503: backoff 1 นาที (+jitter) → ลองใหม่ · healthCheck ไม่ผ่าน → หยุดทั้งคิว (ใบอื่นพักไม่ยิง) · ล่มต่อเนื่อง ≥ 30 นาที = ERROR · กลับมา = ส่งต่อเอง', async () => {
    await settleAll();
    const connectors = app.get(ConnectorsService);
    mock.injectFault({ kind: 'status', status: 503, times: 0 });
    const inv = await single('503.00');
    const before = posts().length;
    const t0 = Date.now();
    await drain();
    const cmd = await pushCmd(inv.uuid);
    const row = await reload(cmd.id);
    expect(row).toMatchObject({ status: 'FAILED_RETRYABLE', errorClass: 'TRANSIENT', attempt: 1 });
    // ตาราง retry docs/01 §6.3 / A.5: 1, 2, 5, 15, 30, 60 นาที ±10%
    expect(RETRY_SCHEDULE_MIN).toEqual([1, 2, 5, 15, 30, 60]);
    const wait = row.nextRunAt.getTime() - t0;
    expect(wait).toBeGreaterThan(0.85 * 60_000);
    expect(wait).toBeLessThan(1.15 * 60_000 + 5_000);
    expect(row.lastError).toMatchObject({ code: 'service_unavailable', knownOutcome: true });
    // healthCheck (GET) ก็ได้ 503 → connector ยัง ACTIVE แต่จดเวลาเริ่มล้ม = พักทั้งคิว
    const c1 = await connector();
    expect(c1.status).toBe('ACTIVE');
    expect(c1.healthFailingSince).not.toBeNull();
    // ใบอื่นของ connector นี้: พัก PENDING ไม่ยิง KRS ไม่เสียจำนวนครั้ง
    const inv2 = await single('503.01');
    const posted = posts().length;
    await drain();
    expect(posts().length).toBe(posted);
    const parked = await reload((await pushCmd(inv2.uuid)).id);
    expect(parked).toMatchObject({ status: 'PENDING', errorClass: 'AUTH', attempt: 0 });
    expect(parked.lastError).toMatchObject({ code: 'connector_unhealthy' });
    expect(await reload(cmd.id)).toMatchObject({ status: 'PENDING', errorClass: 'AUTH' });
    // ครั้งที่ 2 ของคำสั่งแรกยังไม่เกิด (พัก) — ล่มต่อเนื่องครบ 30 นาที → ERROR (หยุด connector) + แจ้ง
    await plat.connector.update({
      where: { id: conUuid },
      data: { healthFailingSince: new Date(Date.now() - 31 * 60_000) },
    });
    await connectors.recheckUnhealthy();
    expect(await connector()).toMatchObject({ status: 'ERROR' });
    // KRS กลับมา → ตรวจซ้ำผ่าน → ACTIVE เอง + ปลุกคิว → ส่งครบ
    mock.clearFaults();
    await connectors.recheckUnhealthy();
    expect(await connector()).toMatchObject({ status: 'ACTIVE', healthFailingSince: null });
    await drain();
    // 503 ครั้งแรก + ส่งต่อ 2 ใบหลังกลับมา
    expect(posts().length - before).toBe(3);
    expect(await reload(cmd.id)).toMatchObject({ status: 'DONE' });
    expect(await reload(parked.id)).toMatchObject({ status: 'DONE' });
    expect(mock.listInvoices().filter((i) => i.data.tmsVoucherNo === inv.invoiceNo)).toHaveLength(
      1,
    );
  });

  // ---------- timeout / connection reset AMBIGUOUS ----------

  it('A5-AMBa: timeout (ค้างแล้วตัดสาย) หลังบันทึก — ไม่รู้ transactionNo → ไม่ POST ซ้ำทันที (รอ 2 นาที) → POST ใหม่ได้ 409 (ไม่สร้างซ้ำ) → คิวให้คนกรอก', async () => {
    const inv = await single('604.00');
    mock.injectFault({ kind: 'timeout-after-commit', method: 'POST', times: 1 });
    const before = posts().length;
    const t0 = Date.now();
    await dispatcher.drain();
    const cmd = await pushCmd(inv.uuid);
    const row = await reload(cmd.id);
    expect(row).toMatchObject({ status: 'FAILED_RETRYABLE', errorClass: 'AMBIGUOUS' });
    expect(row.lastError).toMatchObject({ code: 'connection_reset', knownOutcome: false });
    const wait = row.nextRunAt.getTime() - t0;
    expect(wait).toBeGreaterThan(1.9 * 60_000);
    expect(wait).toBeLessThan(2 * 60_000 + 10_000);
    // ยังไม่ถึงเวลา = ไม่ส่ง
    await dispatcher.drain();
    expect(posts().length - before).toBe(1);
    await drain();
    expect(
      posts()
        .slice(before)
        .map((q) => q.status),
    ).toEqual(['timeout', 409]);
    expect(mock.listInvoices().filter((i) => i.data.tmsVoucherNo === inv.invoiceNo)).toHaveLength(
      1,
    );
    expect(await reload(cmd.id)).toMatchObject({
      status: 'DONE',
      errorClass: 'DUPLICATE',
      lastError: expect.objectContaining({ manualExternalIdRequired: true }),
    });
  });

  it('A5-AMBb: มี transactionNo (sync log มี 201) → GET เทียบก่อน ไม่ POST · ตรง = SYNCED', async () => {
    const inv = await single('604.10');
    mock.injectFault({ kind: 'reset-after-commit', method: 'POST', times: 1 });
    await drain();
    const got = mock.getInvoiceByTmsVoucherNo(inv.invoiceNo)!;
    const cmd = await pushCmd(inv.uuid);
    expect(await reload(cmd.id)).toMatchObject({ errorClass: 'AMBIGUOUS' });
    // หลักฐานเลข KRS (เช่น response ที่บันทึกได้ก่อนผลหาย)
    const log = await plat.erpSyncLog.findFirstOrThrow({
      where: { outboxId: cmd.id, method: 'POST' },
    });
    await plat.erpSyncLog.update({
      where: { id: log.id },
      data: {
        statusCode: 201,
        errorCode: null,
        responseBody: JSON.stringify({
          transactionNo: got.transactionNo,
          voucherNo: got.voucherNo,
        }),
      },
    });
    const p = posts().length;
    const g = gets().length;
    await drain();
    expect(posts().length).toBe(p);
    expect(gets().length - g).toBe(1);
    expect(await reload(cmd.id)).toMatchObject({
      status: 'DONE',
      result: expect.objectContaining({ recoveredAfter: 'AMBIGUOUS', applied: true }),
    });
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'SYNCED',
      externalId: got.transactionNo,
    });
  });

  it('A5-AMBc (review L4): client timeout (KRS ไม่ตอบภายในเวลา) = AMBIGUOUS `timeout` · ไม่ POST ซ้ำทันที', async () => {
    const reg = app.get(ErpAdapterRegistry);
    reg.replace(new KrsAdapter({ allowPrivate: true, timeoutMs: 100 }));
    try {
      const inv = await single('604.20');
      mock.injectFault({ kind: 'timeout-after-commit', method: 'POST', times: 1 });
      const before = posts().length;
      await dispatcher.drain();
      const row = await reload((await pushCmd(inv.uuid)).id);
      expect(row).toMatchObject({ status: 'FAILED_RETRYABLE', errorClass: 'AMBIGUOUS' });
      expect(row.lastError).toMatchObject({ code: 'timeout', knownOutcome: false });
      expect(row.nextRunAt.getTime() - Date.now()).toBeGreaterThan(1.8 * 60_000);
      await dispatcher.drain();
      expect(posts().length - before).toBe(1);
    } finally {
      reg.replace(new KrsAdapter({ allowPrivate: true }));
    }
  });

  // ---------- 400 VALIDATION ----------

  it('A5-400: ไม่ retry · เก็บ response ตัวเต็ม (sync log) + ช่องที่ผิด · ขึ้นคิวล้มเหลว (VALIDATION)', async () => {
    const body = {
      status: 400,
      error: 'Bad Request',
      message: 'payload ไม่ผ่าน schema',
      errors: [
        {
          path: '/lines/0/mainUnits',
          message: 'unknown unit',
          keyword: 'enum',
          params: {},
        },
      ],
    };
    mock.injectFault({ kind: 'status', status: 400, body, method: 'POST', times: 1 });
    const inv = await single('400.00');
    const before = posts().length;
    await drain();
    await drain();
    expect(posts().length - before).toBe(1);
    const cmd = await pushCmd(inv.uuid);
    const row = await reload(cmd.id);
    expect(row).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    expect(row.lastError).toMatchObject({
      code: 'krs_rejected',
      fields: [{ field: '/lines/0/mainUnits', code: 'enum', message: 'unknown unit' }],
    });
    const log = await plat.erpSyncLog.findFirstOrThrow({ where: { outboxId: cmd.id } });
    expect(JSON.parse(log.responseBody!)).toEqual(body);
    expect(await mapping(inv.uuid)).toMatchObject({ status: 'FAILED', externalId: null });
    const q = await api(app, accounting)
      .get(`/v1/connectors/${conId}/queue?tab=failed&errorClass=VALIDATION`)
      .expect(200);
    const item = q.body.data.find(
      (x: { id: string }) => x.id === encodeId('outboxCommand', cmd.id),
    );
    expect(item).toMatchObject({
      fields: [{ field: '/lines/0/mainUnits' }],
      actions: { retry: true },
    });
  });

  // ---------- 401 AUTH ----------

  it('A5-401: หยุด connector ทั้งตัว (ERROR) + แจ้ง admin · ไม่ retry ด้วย key เดิม (คำสั่งคง PENDING ไม่นับครั้ง)', async () => {
    await settleAll();
    mock.injectFault({ kind: 'status', status: 401, method: 'POST', times: 1 });
    const inv = await single('401.00');
    const before = posts().length;
    await drain();
    expect(await connector()).toMatchObject({ status: 'ERROR', statusReason: 'unauthorized' });
    const cmd = await pushCmd(inv.uuid);
    expect(await reload(cmd.id)).toMatchObject({
      status: 'PENDING',
      errorClass: 'AUTH',
      attempt: 0,
    });
    expect(
      await plat.auditLog.count({
        where: { tenantId, action: 'connector.error', entityId: conUuid },
      }),
    ).toBeGreaterThan(0);
    // รอบถัดไปไม่ยิง KRS (connector หยุด)
    await drain();
    await drain();
    expect(posts().length - before).toBe(1);
    // ผู้ดูแลแก้ key แล้วเปิดต่อ → ส่งต่อเอง
    await api(app, admin).post(`/v1/connectors/${conId}/resume`).send({}).expect(200);
    await drain();
    expect(posts().length - before).toBe(2);
    expect(await reload(cmd.id)).toMatchObject({ status: 'DONE' });
  });

  // ---------- 404 NOT_FOUND ----------

  it('A5-404a (GET ของเลขที่ระบบรู้เอง — sync log มี 201): KRS ไม่มีใบเลขนั้นแล้ว → ไม่ POST · FAILED_FINAL NOT_FOUND + REMOTE_MISSING ให้คนตัดสิน', async () => {
    const inv = await single('404.00');
    mock.injectFault({ kind: 'reset-after-commit', method: 'POST', times: 1 });
    await drain();
    const cmd = await pushCmd(inv.uuid);
    const log = await plat.erpSyncLog.findFirstOrThrow({
      where: { outboxId: cmd.id, method: 'POST' },
    });
    await plat.erpSyncLog.update({
      where: { id: log.id },
      data: {
        statusCode: 201,
        errorCode: null,
        responseBody: JSON.stringify({ transactionNo: '99999404', voucherNo: 'SA-S0000-0000' }),
      },
    });
    const p = posts().length;
    await drain();
    expect(posts().length).toBe(p);
    expect(await reload(cmd.id)).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'NOT_FOUND' });
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'MISMATCH',
      externalId: '99999404',
      lastError: { code: 'remote_missing', errorClass: 'NOT_FOUND' },
    });
    expect(
      await plat.reconcileResult.findFirst({ where: { tenantId, localId: inv.uuid } }),
    ).toMatchObject({ result: 'REMOTE_MISSING', severity: 'MONEY' });
  });

  it('A5-404c (review M1): เลขที่คนกรอกเอง GET ได้ 404 → ไม่ใช่ REMOTE_MISSING — ตัดเลขทิ้ง กลับเข้าคิวให้กรอกใหม่ · กรอกถูก → SYNCED', async () => {
    const inv = await single('404.20');
    mock.injectFault({ kind: 'reset-after-commit', method: 'POST', times: 1 });
    await drain();
    await drain();
    const cmd = await pushCmd(inv.uuid);
    const r = await enterIds(cmd.id, { externalId: '99999406' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = posts().length;
    await drain();
    expect(posts().length).toBe(p);
    const verify = tryDecodeId('outboxCommand', r.body.resolution.supersededBy)!;
    const row = await rejectedBack(verify);
    expect(row.lastError).toMatchObject({ missing: ['99999406'] });
    expect(await mapping(inv.uuid)).toMatchObject({ status: 'MISMATCH', externalId: null });
    expect(await plat.reconcileResult.count({ where: { tenantId, localId: inv.uuid } })).toBe(0);
    const got = mock.getInvoiceByTmsVoucherNo(inv.invoiceNo)!;
    const fixed = await enterIds(verify, { externalId: got.transactionNo });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    await drain();
    expect(posts().length).toBe(p);
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'SYNCED',
      externalId: got.transactionNo,
    });
  });

  it('A5-404b (คำสั่ง FETCH_DOCUMENT ของใบที่ mapping บอกว่าอยู่ใน KRS): ใบถูกลบฝั่ง KRS → MISMATCH + REMOTE_MISSING', async () => {
    const inv = await single('404.10');
    await drain();
    const m = (await mapping(inv.uuid))!;
    expect(m.status).toBe('SYNCED');
    // จำลองใบหายฝั่ง KRS (KRS ไม่มี DELETE — A.1; เช่น ถูกลบใน ERP เอง)
    await plat.externalMapping.update({ where: { id: m.id }, data: { externalId: '99999405' } });
    const db = app.get(DbService);
    const outbox = app.get(OutboxService);
    const invCustomer = (await plat.invoice.findUniqueOrThrow({ where: { id: inv.uuid } }))
      .customerId;
    const q = await db.withTenant(tenantId, (tx) =>
      outbox.enqueueCommand(tx, {
        tenantId,
        kind: 'ADAPTER',
        sink: 'erp',
        targetId: conUuid,
        operation: 'FETCH_DOCUMENT',
        entityType: 'invoice',
        localId: inv.uuid,
        customerId: invCustomer,
        payload: {
          ref: {
            entityType: 'invoice',
            localId: inv.uuid,
            number: inv.invoiceNo,
            externalId: '99999405',
          },
        },
      }),
    );
    await drain();
    expect(await reload(q.id)).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'NOT_FOUND' });
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'MISMATCH',
      lastError: { code: 'remote_missing' },
    });
    expect(
      await plat.reconcileResult.findFirst({ where: { tenantId, localId: inv.uuid } }),
    ).toMatchObject({ result: 'REMOTE_MISSING' });
  });

  it('review L2: adapter ไม่ได้ติดตั้ง / ไม่มี plannedDocuments = เอกสารเดียว (ทางกรอกเลขเดี่ยวของ ST7-T19)', async () => {
    const sink = app.get(ErpAdapterSink);
    const c = await connector();
    const r = await app
      .get(DbService)
      .withTenant(tenantId, (tx) =>
        sink.plannedDocuments(tx, { ...c, adapterKey: 'not-installed' }, 'PUSH_INVOICE', null),
      );
    expect(r).toEqual({ kind: 'single' });
  });
});
