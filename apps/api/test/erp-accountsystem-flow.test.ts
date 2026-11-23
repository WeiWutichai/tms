import type { NestExpressApplication } from '@nestjs/platform-express';
import { type MockAccountSystem, startMockAccountSystem } from '@tms/mock-accountsystem';
import { SYSTEM_ROLES } from '@tms/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { AccountSystemAdapter } from '../src/erp-adapters/accountsystem/accountsystem.adapter';
import { JobQueue } from '../src/jobs/job-queue.service';
import { ERP_ADAPTER_FACTORIES } from '../src/erp-adapters';
import { ErpAdapterError } from '../src/modules/erp/erp-adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { injectPersonalData, redactNationalIds } from '../src/modules/erp/personal-data';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { rateLimitInstance } from '../src/http/rate-limit/rate-limit.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import {
  api,
  bootApp,
  platform,
  settleTripCostsForTest,
  tokenFor,
  truncateAll,
  validTaxId,
} from './helpers';

/**
 * ST8-T16 AccountSystemAdapter ครบวงจรผ่าน API + outbox + webhook ขาเข้า (ทางเดียวกับ worker) กับ mock จาก contract
 * เกณฑ์ตรวจรับ (plan/01 ST8-T16):
 * (1) finalize ใบแจ้งหนี้ → mock ได้ IV ร่าง 1 ใบ ส่งซ้ำไม่เกิดใบซ้ำ (2) บันทึกจ่ายใบสำคัญจ่าย → AP ร่าง 1 ใบ มี WHT
 * (3) webhook document.posted → เก็บเลขเอกสารฝั่งระบบบัญชี · payment.received → PARTIALLY_PAID/PAID · document.voided → คิวให้คนตัดสิน
 *     (ไม่ยกเลิกใบ TMS) · webhook ซ้ำ/ลายเซ็นผิดไม่มีผล (4) ปิด connector แล้ววางบิล/รับเช็ค/จ่ายรถร่วมได้
 * (6) ข้อมูล connector (external_mapping) แยก tenant · + D-55 เจ้าของเอกสารภาษี ERP ตายตัว · ยกเลิกใบ TMS → งานยกเลิกด้วยมือ
 */
describe('AccountSystem connector — ครบวงจร (ST8-T16)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const plat = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  let queue: JobQueue;
  let mock: MockAccountSystem;
  let tenantId: string;
  let otherTenantId: string;
  let companyId: string;
  let branchId: string;
  let customerId: string;
  let serviceItemId: string;
  let admin: string;
  let accounting: string;
  let approver: string;
  let conId: string;
  let conUuid: string;
  let inboundPath: string;
  let seq = 0;
  const today = bangkokToday();
  const KEY = 'inn_tms_flowkey_5d0e7b1c';
  const SECRET = 'whsec_flow_9a3c';
  /** เลขผู้เสียภาษีนิติบุคคล (ขึ้นต้น 0) ที่ checksum ถูก */
  const juristicTaxId = (seed: number) => {
    const base = `0105${String(seed).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;

  const drainOutbox = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };
  const drainJobs = async () => {
    await plat.$executeRaw`UPDATE job SET run_at = now() - interval '1 second' WHERE status = 'PENDING'`;
    for (let i = 0; i < 30 && (await queue.runOnce()); i++);
  };
  const commands = (op?: string) =>
    plat.integrationOutbox.findMany({
      where: { tenantId, sink: 'erp', ...(op ? { operation: op } : {}) },
      orderBy: { seq: 'asc' },
    });
  const mapping = (entityType: 'INVOICE' | 'SETTLEMENT' | 'PAYMENT', localId: string) =>
    plat.externalMapping.findFirst({ where: { tenantId, entityType, localId } });
  const send = (w: { headers: Record<string, string>; body: string }, path = inboundPath) =>
    request(app.getHttpServer()).post(path).set(w.headers).send(w.body);
  const events = () =>
    plat.processedWebhookEvent.findMany({ where: { tenantId }, orderBy: { receivedAt: 'asc' } });
  const getInv = async (id: string) =>
    (await api(app, admin).get(`/v1/invoices/${id}`).expect(200)).body as Record<string, any>;

  /** ร่างใบแจ้งหนี้ 1 บรรทัด (เพิ่มเอง) แล้ว finalize ผ่าน API (ผู้ออก ≠ ผู้เตรียม) */
  const issuedInvoice = async (amount = '1000.00', deliveryOrderId?: string) => {
    const n = ++seq;
    const inv = await plat.invoice.create({
      data: {
        tenantId,
        customerId,
        issuingCompanyId: companyId,
        issuingBranchId: branchId,
        status: 'DRAFT',
        creditTermDays: 30,
        createdBy: 'u-prep',
        lines: {
          create: {
            tenantId,
            lineNo: 1,
            serviceItemId,
            description: `ค่าขนส่ง เที่ยวที่ ${n}`,
            quantity: '1',
            unitLabel: 'เที่ยว',
            unitPrice: amount,
            amount,
            vatType: 'EXEMPT_TRANSPORT',
            vatAmount: '0',
            whtRate: '1.00',
            isUserAdded: true,
            ...(deliveryOrderId ? { deliveryOrderId } : {}),
          },
        },
      },
    });
    const id = encodeId('invoice', inv.id);
    const r = await api(app, accounting)
      .post(`/v1/invoices/${id}/finalize`)
      .set('If-Match', `"${inv.version}"`)
      .send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { id, uuid: inv.id, invoiceNo: r.body.invoiceNo as string };
  };

  /** เที่ยว + ค่าจ้างรถร่วม → ใบสำคัญจ่ายร่าง (helper เดียวกับ test อื่น) → อนุมัติ → บันทึกจ่าย ผ่าน API */
  const paidSettlement = async (
    carrierId: string,
    amount = '9000.00',
    dos: { doNo: string; status?: 'CANCELLED' | 'DELIVERED' }[] = [],
  ) => {
    const trip = await plat.trip.create({
      data: {
        tenantId,
        tripNo: `TRP-AS-${++seq}`,
        tripDate: new Date(`${today}T00:00:00Z`),
      },
    });
    // D68-81 DO ของเที่ยว → เลข DO ต่อบรรทัดใน CanonicalSettlement
    if (dos.length) {
      const site = (k: string) =>
        plat.customerSite.create({
          data: { tenantId, code: `ST${k}-${seq}`, name: `สถานที่ ${k}`, address: { line1: 'x' } },
        });
      const [a, b] = [await site('A'), await site('B')];
      const so = await plat.salesOrder.create({
        data: {
          tenantId,
          soNo: `SO-STL-${seq}`,
          source: 'MANUAL',
          customerId,
          billingCompanyId: companyId,
          requestedDate: new Date(`${today}T00:00:00Z`),
          status: 'RECEIVED',
        },
      });
      for (const d of dos)
        await plat.deliveryOrder.create({
          data: {
            tenantId,
            doNo: d.doNo,
            doDate: new Date(`${today}T00:00:00Z`),
            salesOrderId: so.id,
            customerId,
            tripId: trip.id,
            originSiteId: a.id,
            destSiteId: b.id,
            originStopSeq: 1,
            destStopSeq: 2,
            ...(d.status ? { status: d.status } : {}),
          },
        });
    }
    await plat.tripCost.create({
      data: {
        tenantId,
        tripId: trip.id,
        costType: 'CARRIER_FEE',
        amount,
        source: 'MANUAL',
        carrierId,
        description: 'ค่าจ้างรถร่วม รอบทดสอบ',
      },
    });
    await settleTripCostsForTest(plat, { tripId: trip.id }, 'u-acc');
    const s = await plat.carrierSettlement.findFirstOrThrow({
      where: { tenantId, carrierId, status: 'DRAFT' },
      orderBy: { createdAt: 'desc' },
    });
    const car = await plat.carrier.findUniqueOrThrow({ where: { id: carrierId } });
    await plat.carrierSettlement.update({
      where: { id: s.id },
      data: {
        payingCompanyId: companyId,
        carrierSnapshot: {
          code: car.code,
          legalName: car.legalName,
          entityType: car.entityType,
          taxId: car.taxId,
          taxIdLast4: null,
          branchCode: car.branchCode,
          address: null,
        },
      },
    });
    const id = encodeId('settlement', s.id);
    const etag = async () =>
      `"${(await plat.carrierSettlement.findUniqueOrThrow({ where: { id: s.id } })).version}"`;
    const a = await api(app, approver)
      .post(`/v1/settlements/${id}/approve`)
      .set('If-Match', await etag())
      .send({ reason: 'ตรวจยอดตรงใบแจ้งหนี้รถร่วมแล้ว' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const p = await api(app, accounting)
      .post(`/v1/settlements/${id}/mark-paid`)
      .set('If-Match', await etag())
      .send({ paidDate: today, method: 'TRANSFER', reference: 'KBANK-0001', bank: 'กสิกรไทย' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    return { id, uuid: s.id, number: p.body.settlementNo as string };
  };

  const prevPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  beforeAll(async () => {
    // mock อยู่ที่ 127.0.0.1 — dev/test เท่านั้น (production ไม่สนค่านี้)
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    queue = app.get(JobQueue);
    // adapter ตัวจริงแต่ยอมปลายทาง 127.0.0.1 ของ mock
    app.get(ErpAdapterRegistry).replace(new AccountSystemAdapter({ allowPrivate: true }));
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท เชื่อมระบบบัญชี จำกัด' })).id;
    otherTenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น จำกัด' })).id;
    await plat.tenant.updateMany({ data: { planCode: 'ent' } });
    companyId = (
      await plat.company.create({
        data: { tenantId, legalName: 'บริษัท ผู้ออกบิล จำกัด', taxId: validTaxId(4101) },
      })
    ).id;
    branchId = (
      await plat.branch.create({
        data: {
          tenantId,
          companyId,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          isDefaultIssuer: true,
          address: { line1: '1', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
        },
      })
    ).id;
    const custTax = validTaxId(4102);
    customerId = (
      await plat.customer.create({
        data: {
          tenantId,
          code: 'C-AS1',
          legalName: 'บริษัท ลูกค้าบัญชี จำกัด',
          taxId: custTax,
          branchCode: '00000',
        },
      })
    ).id;
    serviceItemId = (
      await plat.serviceItem.findFirstOrThrow({
        where: { tenantId, vatType: 'EXEMPT_TRANSPORT', status: 'ACTIVE', deletedAt: null },
      })
    ).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    approver = await tokenFor(tenantId, SYSTEM_ROLES.approver.permissions.join(' '), 'u-appr');
    mock = await startMockAccountSystem({
      apiKey: KEY,
      webhookSecret: SECRET,
      contacts: [{ code: 'AR-001', tax_id: custTax, branch_code: '00000', kind: 'customer' }],
    });
  });
  afterAll(async () => {
    if (prevPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = prevPrivate;
    await mock?.stop();
    await app.close();
    await plat.$disconnect();
  });

  it('D-55: สร้าง connector → เจ้าของเอกสารภาษี = ERP ตายตัว (ส่ง TMS = 422 sor_fixed · เปลี่ยนภายหลังไม่ได้) · catalog บอก fixedTaxDocumentOwner', async () => {
    const cat = await api(app, admin).get('/v1/connectors/adapters').expect(200);
    const list = (Array.isArray(cat.body) ? cat.body : cat.body.data) as {
      key: string;
      fixedTaxDocumentOwner: string | null;
    }[];
    expect(list.find((a) => a.key === 'accountsystem')).toMatchObject({
      displayName: 'AccountSystem',
      fixedTaxDocumentOwner: 'ERP',
      capabilities: ['pushInvoice', 'pushSettlement'],
    });
    const body = {
      adapterKey: 'accountsystem',
      settings: { baseUrl: mock.url },
      credentials: { apiKey: KEY, webhookSecret: SECRET },
      capabilitiesEnabled: ['pushInvoice', 'pushSettlement'],
    };
    const bad = await api(app, admin)
      .post('/v1/connectors')
      .send({ ...body, taxDocumentOwner: 'TMS' });
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    expect(bad.body.code, JSON.stringify(bad.body)).toBe('sor_fixed');
    const r = await api(app, admin).post('/v1/connectors').send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    conId = r.body.id;
    conUuid = uuid('connector', conId);
    expect(r.body.systemOfRecord.taxDocumentOwner).toBe('ERP');
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    const res = await api(app, admin).post(`/v1/connectors/${conId}/resume`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c = await api(app, admin).get(`/v1/connectors/${conId}`).expect(200);
    const sor = await api(app, admin)
      .put(`/v1/connectors/${conId}/system-of-record`)
      .set('If-Match', String(c.headers.etag))
      .send({ taxDocumentOwner: 'TMS', reason: 'ลองเปลี่ยนผู้ออกเอกสารภาษี' });
    expect(sor.status, JSON.stringify(sor.body)).toBe(422);
    expect(sor.body.code).toBe('sor_fixed');
    // จับคู่รหัสสินค้า (ST7-T18) ก่อนส่ง
    await plat.erpCodeMapping.create({
      data: { tenantId, connectorId: conUuid, serviceItemId, itemCode: 'FREIGHT' },
    });
    const t = await api(app, admin)
      .post(`/v1/connectors/${conId}/inbound-token/rotate`)
      .send({ reason: 'ออก token รับ webhook จากระบบบัญชี' });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    inboundPath = new URL(t.body.url).pathname;
    expect(inboundPath).toMatch(/^\/v1\/inbound\/accountsystem\/whin_/);
  });

  it('(1) finalize → IV ร่าง 1 ใบใน mock · external_mapping เก็บ id · enqueue ซ้ำ/ส่งซ้ำไม่เกิดใบซ้ำ', async () => {
    const inv = await issuedInvoice('1000.00');
    const cmds = await commands('PUSH_INVOICE');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ entityType: 'invoice', localId: inv.uuid, status: 'PENDING' });
    await drainOutbox();
    expect((await commands('PUSH_INVOICE'))[0]!.status).toBe('DONE');
    const docs = mock.byRef(inv.invoiceNo, 'tms.invoice');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      doc_type: 'IV',
      status: 'draft',
      contact_code: 'AR-001',
      issue_date: today,
      branch_code: '00000',
    });
    expect(docs[0]!.lines[0]).toMatchObject({ amount: '1000.00', product_code: 'FREIGHT' });
    const m = await mapping('INVOICE', inv.uuid);
    expect(m).toMatchObject({
      connectorId: conUuid,
      localNumber: inv.invoiceNo,
      externalId: docs[0]!.id,
      externalStatus: 'DRAFT',
      status: 'SYNCED',
    });
    expect(m!.lastSyncedHash).toMatch(/^[0-9a-f]{64}$/);
    // enqueue ซ้ำด้วย payload เดิม = คำสั่งเดิม · ส่งซ้ำ (เช่น ลองใหม่หลัง timeout) = id เดิมฝั่งระบบบัญชี
    const { ErpSyncService } = await import('../src/modules/erp/erp-sync.service');
    await db.withTenant(tenantId, (tx) => app.get(ErpSyncService).invoiceFinalized(tx, inv.uuid));
    expect(await commands('PUSH_INVOICE')).toHaveLength(1);
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'PENDING', attempt = 0
                            WHERE tenant_id = ${tenantId}::uuid AND operation = 'PUSH_INVOICE'`;
    const posts = mock.requests.filter((q) => q.method === 'POST').length;
    await drainOutbox();
    expect(mock.byRef(inv.invoiceNo, 'tms.invoice')).toHaveLength(1);
    expect((await mapping('INVOICE', inv.uuid))!.externalId).toBe(docs[0]!.id);
    // ST7-T15 payload เดิม hash เท่าเดิม → SKIPPED ไม่เรียกระบบบัญชีซ้ำ
    const again = (await commands('PUSH_INVOICE'))[0]!;
    expect(again.status).toBe('SKIPPED');
    expect(again.lastError).toMatchObject({ code: 'payload_unchanged', externalId: docs[0]!.id });
    expect(mock.requests.filter((q) => q.method === 'POST').length).toBe(posts);
    // ST7-T15 เลขเอกสารสองฝั่ง: `sync` ของใบ (แยกจาก status) — ยังเป็นร่างฝั่งระบบบัญชี = ยังไม่มีเลข
    expect((await getInv(inv.id)).sync).toEqual({
      connectorId: conId,
      state: 'SYNCED',
      externalId: docs[0]!.id,
      externalDocNo: null,
      externalStatus: 'DRAFT',
      lastSyncedAt: m!.lastSyncedAt!.toISOString(),
      postedAt: null,
      externalDocuments: [],
    });
    // ST8-T05 รหัสลูกค้าฝั่งระบบบัญชีที่ map ไว้ (customerErpCode) ชนะการจับคู่ด้วยเลขภาษี
    mock.addContact({ code: 'AR-777', name: 'ลูกค้ารหัสที่ map', kind: 'customer' });
    const set = await api(app, admin)
      .put(`/v1/customers/${encodeId('customer', customerId)}/erp-codes/${conId}`)
      .send({ externalId: 'AR-777' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const puts = mock.requests.filter((q) => q.method === 'PUT').length;
    const inv2 = await issuedInvoice('200.00');
    await drainOutbox();
    expect(mock.byRef(inv2.invoiceNo, 'tms.invoice')[0]!.contact_code).toBe('AR-777');
    expect(mock.requests.filter((q) => q.method === 'PUT').length).toBe(puts);
    // คืนค่าเดิม (ข้อถัดไปใช้การจับคู่ด้วยเลขภาษี)
    await api(app, admin)
      .put(`/v1/customers/${encodeId('customer', customerId)}/erp-codes/${conId}`)
      .send({ externalId: null, reason: 'คืนค่าเพื่อทดสอบจับคู่ด้วยเลขภาษี' })
      .expect(200);
  });

  it('ST8-T07 (PDPA): ชื่อคนขับของเที่ยวไม่ลง payload ของคำสั่ง — adapter นี้ไม่ได้ประกาศ personalDataNeeds', async () => {
    const tag = `PD${++seq}`;
    const site = (k: string) =>
      plat.customerSite.create({
        data: { tenantId, code: `S${k}-${tag}`, name: `สถานที่ ${k}`, address: { line1: 'x' } },
      });
    const [a, b] = [await site('A'), await site('B')];
    const so = await plat.salesOrder.create({
      data: {
        tenantId,
        soNo: `SO-${tag}`,
        source: 'MANUAL',
        customerId,
        billingCompanyId: companyId,
        requestedDate: new Date(`${today}T00:00:00Z`),
        status: 'RECEIVED',
      },
    });
    const trip = await plat.trip.create({
      data: {
        tenantId,
        tripNo: `TRP-${tag}`,
        tripDate: new Date(`${today}T00:00:00Z`),
        vehiclePlateSnapshot: '70-1234',
        driverNameSnapshot: 'สมชาย ทดสอบ',
      },
    });
    const d = await plat.deliveryOrder.create({
      data: {
        tenantId,
        doNo: `DO-${tag}`,
        doDate: new Date(`${today}T00:00:00Z`),
        salesOrderId: so.id,
        customerId,
        tripId: trip.id,
        originSiteId: a.id,
        destSiteId: b.id,
        originStopSeq: 1,
        destStopSeq: 2,
      },
    });
    // ใบแจ้งหนี้ที่บรรทัดผูก DO ซึ่งเที่ยวมีชื่อคนขับ → finalize ผ่าน API → core สร้างคำสั่ง PUSH_INVOICE
    const inv = await issuedInvoice('1500.00', d.id);
    const cmds = (await commands('PUSH_INVOICE')).filter((c) => c.localId === inv.uuid);
    const payload = cmds.at(-1)!.payload as {
      document: { lines: { deliveryOrder: unknown; trip: Record<string, unknown> }[] };
    };
    const line = payload.document.lines[0]!;
    expect(line.deliveryOrder).toMatchObject({ number: `DO-${tag}` });
    expect(line.trip).toEqual({
      number: `TRP-${tag}`,
      vehiclePlate: '70-1234',
      driverName: null,
      carrierName: null,
    });
    // ไม่มีชื่อคนขับในคำสั่งใดของ connector นี้เลย
    expect(JSON.stringify((await commands()).map((c) => c.payload))).not.toContain('สมชาย ทดสอบ');
  });

  it('(3) document.posted → เลขเอกสารฝั่งระบบบัญชีใน external_mapping · webhook ซ้ำไม่มีผล · ลายเซ็นผิด 401 ไม่เข้า ledger', async () => {
    const inv = await issuedInvoice('500.00');
    await drainOutbox();
    const [doc] = mock.byRef(inv.invoiceNo, 'tms.invoice');
    const w = mock.post(doc!.id);
    const r1 = await send(w);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({ received: true, duplicate: false });
    const r2 = await send(w);
    expect(r2.body).toMatchObject({ received: true, duplicate: true });
    const before = (await events()).length;
    const forged = mock.webhook('document.posted', w.event.data, new Date(), {
      secret: 'whsec_attacker',
    });
    expect((await send(forged)).status).toBe(401);
    expect((await events()).length).toBe(before);
    await drainJobs();
    const m = await mapping('INVOICE', inv.uuid);
    expect(m).toMatchObject({ externalDocNo: doc!.doc_no, externalStatus: 'POSTED' });
    // ST7-T15 เลขที่ระบบบัญชีออก แสดงคู่กับเลข TMS ผ่าน `sync` (สถานะเอกสาร TMS ไม่เปลี่ยน)
    const got = await getInv(inv.id);
    expect(got.invoiceNo).toBe(inv.invoiceNo);
    expect(got.sync).toMatchObject({
      state: 'SYNCED',
      externalDocNo: doc!.doc_no,
      externalStatus: 'POSTED',
    });
    const ev = (await events()).find((e) => e.eventKey === w.event.id)!;
    expect(ev).toMatchObject({ status: 'PROCESSED', duplicateCount: 1 });
  });

  it('(3) payment.received → payment (source CONNECTOR) → PARTIALLY_PAID แล้ว PAID · webhook ใหม่ของ RV เดิมไม่สร้างซ้ำ · ยอดเกินค้าง = คิวตรวจ', async () => {
    const inv = await issuedInvoice('1000.00');
    await drainOutbox();
    const [doc] = mock.byRef(inv.invoiceNo, 'tms.invoice');
    await send(mock.post(doc!.id));
    // รับ 594 + WHT 6 = ตัดหนี้ 600
    const p1 = mock.receive([{ documentId: doc!.id, applied: '594.00', wht: '6.00' }]);
    await send(p1).expect(200);
    await drainJobs();
    let x = await getInv(inv.id);
    expect(x).toMatchObject({ status: 'PARTIALLY_PAID', sellPaidAmount: '600.00' });
    const pays = await plat.payment.findMany({ where: { tenantId, source: 'CONNECTOR' } });
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ method: 'TRANSFER', createdBy: 'system:connector-inbound' });
    expect(pays[0]!.amountReceived.toFixed(2)).toBe('594.00');
    expect(pays[0]!.whtAmount.toFixed(2)).toBe('6.00');
    expect(pays[0]!.reference).toBe(p1.event.data.doc_no);
    // ระบบบัญชีส่ง event ใหม่ (id ใหม่) ของ RV เดิม → ไม่สร้างซ้ำ (กันด้วย external_mapping)
    const again = mock.webhook('payment.received', p1.event.data);
    await send(again).expect(200);
    await drainJobs();
    expect(await plat.payment.count({ where: { tenantId, source: 'CONNECTOR' } })).toBe(1);
    // ยอดเกินค้าง (D-57 บันทึกซ้ำสองฝั่ง) → ไม่สร้าง + event FAILED รหัส payment_mismatch
    const over = mock.receive([{ documentId: doc!.id, applied: '500.00', wht: '0.00' }]);
    await send(over).expect(200);
    await drainJobs();
    const ov = (await events()).find((e) => e.eventKey === over.event.id)!;
    expect(ov.status).toBe('FAILED');
    expect(ov.lastError).toMatchObject({ code: 'payment_mismatch', review: true });
    expect(await plat.payment.count({ where: { tenantId, source: 'CONNECTOR' } })).toBe(1);
    // จ่ายส่วนที่เหลือ → PAID + audit/event ของการรับชำระ
    await send(mock.receive([{ documentId: doc!.id, applied: '396.00', wht: '4.00' }])).expect(200);
    await drainJobs();
    x = await getInv(inv.id);
    expect(x).toMatchObject({ status: 'PAID', sellOutstanding: '0.00' });
    const audit = await plat.auditLog.findMany({
      where: { tenantId, action: 'payment.recorded', actorId: 'system:connector-inbound' },
    });
    expect(audit).toHaveLength(2);
    expect(
      await plat.domainEvent.count({
        where: { tenantId, type: 'invoice.paid', localId: inv.uuid },
      }),
    ).toBe(1);
  });

  it('(3) document.voided ฝั่งระบบบัญชี → ใบ TMS ไม่ถูกยกเลิก · event ขึ้นคิวให้คนตัดสิน (FAILED external_document_voided)', async () => {
    const inv = await issuedInvoice('700.00');
    await drainOutbox();
    const [doc] = mock.byRef(inv.invoiceNo, 'tms.invoice');
    await send(mock.post(doc!.id));
    const v = mock.void(doc!.id, 'ลูกค้าขอยกเลิก');
    await send(v).expect(200);
    await drainJobs();
    expect((await getInv(inv.id)).status).toBe('ISSUED');
    const ev = (await events()).find((e) => e.eventKey === v.event.id)!;
    expect(ev.status).toBe('FAILED');
    expect(ev.lastError).toMatchObject({ code: 'external_document_voided', review: true });
    expect(await mapping('INVOICE', inv.uuid)).toMatchObject({ externalStatus: 'VOIDED' });
  });

  it('ยกเลิกใบใน TMS ที่ส่งเป็นร่างแล้ว → คำสั่ง VOID_DOCUMENT ถูกข้าม void_manual_required (ระบบบัญชีไม่มี API ยกเลิก) + audit แจ้งบัญชี', async () => {
    const inv = await issuedInvoice('300.00');
    await drainOutbox();
    const r = await api(app, admin)
      .post(`/v1/invoices/${inv.id}/void`)
      .set('If-Match', `"${(await getInv(inv.id)).version}"`)
      .send({ reason: 'ออกผิดลูกค้า ยกเลิกเพื่อออกใหม่' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = (await commands('VOID_DOCUMENT')).filter((c) => c.localId === inv.uuid);
    expect(v).toHaveLength(1);
    await drainOutbox();
    const done = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: v[0]!.id } });
    expect(done.status).toBe('SKIPPED');
    expect(done.lastError).toMatchObject({ code: 'void_manual_required' });
    const a = await plat.auditLog.findFirst({
      where: { tenantId, action: 'connector.command_skipped', reason: 'void_manual_required' },
    });
    expect(a).toBeTruthy();
    // ใบที่ยังไม่เคยส่ง (ไม่มี mapping) ไม่มีคำสั่งแจ้งยกเลิก — ร่างในระบบบัญชียังอยู่ ไม่ถูกแตะ
    expect(mock.byRef(inv.invoiceNo, 'tms.invoice')[0]!.status).toBe('draft');
  });

  it('(2) บันทึกจ่ายใบสำคัญจ่าย → AP ร่าง 1 ใบ + WHT ประมาณการ ภ.ง.ด.53 · payment.paid → mapping PAID + เลข 50 ทวิ', async () => {
    const car = await api(app, admin)
      .post('/v1/carriers')
      .send({
        legalName: 'บริษัท รถร่วมบัญชี จำกัด',
        entityType: 'JURISTIC',
        taxId: juristicTaxId(4103),
        branchCode: '00000',
        phone: '081-234-5678',
      });
    expect(car.status, JSON.stringify(car.body)).toBe(201);
    const s = await paidSettlement(uuid('carrier', car.body.id), '9000.00', [
      { doNo: 'DO-STL-B' },
      { doNo: 'DO-STL-A' },
      { doNo: 'DO-STL-X', status: 'CANCELLED' },
    ]);
    const cmds = await commands('PUSH_SETTLEMENT');
    expect(cmds).toHaveLength(1);
    // D68-81 (docs/01 §7.3): เลข DO ต่อบรรทัด — DO ของเที่ยวที่ไม่ถูกยกเลิก เรียงตามเลข
    const stlDoc = (cmds[0]!.payload as { document: { lines: { deliveryOrders: unknown }[] } })
      .document;
    expect(stlDoc.lines[0]!.deliveryOrders).toEqual([
      { number: 'DO-STL-A' },
      { number: 'DO-STL-B' },
    ]);
    await drainOutbox();
    expect((await commands('PUSH_SETTLEMENT'))[0]!.status).toBe('DONE');
    const ap = mock.byRef(s.number, 'tms.settlement');
    expect(ap).toHaveLength(1);
    expect(ap[0]).toMatchObject({ doc_type: 'AP', issue_date: today });
    expect(ap[0]!.contact_code).toMatch(/^EXT-/);
    expect(ap[0]!.lines[0]).toMatchObject({ line_type: 'item', amount: '9000.00' });
    expect(ap[0]!.lines[0]!.description).toContain('DO-STL-A, DO-STL-B');
    const note = ap[0]!.lines.find((l) => l.line_type === 'note')!;
    expect(note.description).toContain('90.00 บาท (ภ.ง.ด.53)');
    expect(await mapping('SETTLEMENT', s.uuid)).toMatchObject({ externalId: ap[0]!.id });
    // ระบบบัญชีลงบัญชีแล้วจ่าย (ออก 50 ทวิ) → TMS เก็บเลข
    await send(mock.post(ap[0]!.id)).expect(200);
    await send(
      mock.pay([{ documentId: ap[0]!.id, applied: '8910.00', wht: '90.00' }], ['WHT-6911-0001']),
    ).expect(200);
    await drainJobs();
    const m = await mapping('SETTLEMENT', s.uuid);
    expect(m).toMatchObject({ externalStatus: 'PAID' });
    expect(m!.detail).toMatchObject({
      whtCertificates: ['WHT-6911-0001'],
      paidAmount: '9000.00',
      whtAmount: '90.00',
    });
    // ST7-T15 `sync` ของใบสำคัญจ่าย
    const gotS = await api(app, admin).get(`/v1/settlements/${s.id}`).expect(200);
    expect(gotS.body.sync).toMatchObject({
      connectorId: conId,
      state: 'SYNCED',
      externalId: ap[0]!.id,
      externalStatus: 'PAID',
    });
    // ST7-T15 รหัสรถร่วมในระบบบัญชีที่ map ไว้ (external_mapping CARRIER) ชนะการจับคู่ด้วยเลขภาษี — ใช้ ณ ตอนส่ง
    mock.addContact({ code: 'AP-555', name: 'รถร่วมรหัสที่ map', kind: 'vendor' });
    const setCar = await api(app, admin)
      .put(`/v1/carriers/${car.body.id}/erp-codes/${conId}`)
      .send({ externalId: 'AP-555' });
    expect(setCar.status, JSON.stringify(setCar.body)).toBe(200);
    const puts = mock.requests.filter((q) => q.method === 'PUT').length;
    const s2 = await paidSettlement(uuid('carrier', car.body.id), '4000.00');
    await drainOutbox();
    expect(mock.byRef(s2.number, 'tms.settlement')[0]!.contact_code).toBe('AP-555');
    expect(mock.requests.filter((q) => q.method === 'PUT').length).toBe(puts);
  });

  it('D-80 (PDPA): รถร่วมบุคคลธรรมดา → เลขบัตรประชาชนเต็มถึงระบบบัญชีใน HTTP body (ใส่ ณ ตอนส่ง) · payload ในคิว/ผลของคำสั่ง/mapping ไม่มีเลข · audit ไม่มีเลข · error ถูกตัดเลข', async () => {
    const nid = validTaxId(4180);
    const car = await api(app, admin).post('/v1/carriers').send({
      legalName: 'นาย รถร่วม บุคคลบัญชี',
      entityType: 'INDIVIDUAL',
      taxId: nid,
      phone: '081-234-5680',
    });
    expect(car.status, JSON.stringify(car.body)).toBe(201);
    const carrierId = uuid('carrier', car.body.id);
    const before = mock.requests.length;
    const s = await paidSettlement(carrierId, '3000.00');
    const cmd = (await commands('PUSH_SETTLEMENT')).find((c) => c.localId === s.uuid)!;
    // payload ที่เก็บในคิว: ไม่มีเลขเต็ม (carrier.taxId = null)
    expect(JSON.stringify(cmd.payload)).not.toContain(nid);
    expect((cmd.payload as any).document.carrier).toMatchObject({
      entityType: 'INDIVIDUAL',
      taxId: null,
    });
    await drainOutbox();
    const done = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(done.status).toBe('DONE');
    // HTTP body ที่ถึง mock (จับคู่/สร้างผู้ติดต่อด้วยเลขภาษี) มีเลขเต็ม
    const sentBodies = mock.requests.slice(before).map((q) => JSON.stringify(q.body));
    const contactPut = mock.requests
      .slice(before)
      .find((q) => q.method === 'PUT' && q.path.startsWith('/ext/v1/contacts'))!;
    expect(contactPut.body).toEqual([expect.objectContaining({ tax_id: nid, kind: 'vendor' })]);
    expect(sentBodies.some((b) => b.includes(nid))).toBe(true);
    const ap = mock.byRef(s.number, 'tms.settlement');
    expect(ap).toHaveLength(1);
    // ที่เก็บใน TMS: payload / result / mapping ไม่มีเลข · result บอกแค่ชื่อช่อง
    expect(JSON.stringify(done.payload)).not.toContain(nid);
    expect(JSON.stringify(done.result)).not.toContain(nid);
    expect(done.result).toMatchObject({ personalDataSent: ['carrier.taxId'] });
    const m = await mapping('SETTLEMENT', s.uuid);
    expect(JSON.stringify(m)).not.toContain(nid);
    expect(m!.lastSyncedHash).toBe((done.result as any).sentHash);
    // ST7-T16 sync log: มีแถวของทุก HTTP call ของคำสั่งนี้ แต่ request/response ไม่มีเลขบัตร (ช่อง tax_id = *** + ตัดเลขซ้ำ)
    const logs = await plat.erpSyncLog.findMany({ where: { outboxId: cmd.id } });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.method === 'PUT' && l.url.includes('/ext/v1/contacts'))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(nid);
    expect(JSON.stringify(logs)).not.toContain(nid.slice(0, 8));
    // audit: บันทึกว่าส่งข้อมูลส่วนบุคคล (ไม่มีตัวเลข)
    const audits = await plat.auditLog.findMany({
      where: { tenantId, action: 'connector.pii_sent' },
    });
    const mine = audits.filter((a) => (a.after as any)?.localId === s.uuid);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ entityType: 'connector', entityId: conUuid });
    expect((mine[0]!.after as any).fields).toEqual(['carrier.taxId']);
    expect(JSON.stringify(audits.map((a) => [a.after, a.reason]))).not.toContain(nid);
    // hash: blind index แทนเลข — ส่งซ้ำด้วยเนื้อหาเดิม = ไม่ส่ง (hash คงที่) และไม่ลง audit เพิ่ม
    const sentReqs = mock.requests.length;
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'PENDING', attempt = 0 WHERE id = ${cmd.id}::uuid`;
    await drainOutbox();
    const again = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(again.status).toBe('SKIPPED');
    expect((again.lastError as any)?.code).toBe('payload_unchanged');
    expect(mock.requests.length).toBe(sentReqs);
    expect(
      (await plat.auditLog.findMany({ where: { tenantId, action: 'connector.pii_sent' } })).filter(
        (a) => (a.after as any)?.localId === s.uuid,
      ),
    ).toHaveLength(1);

    // ปลายทางตอบ error ที่สะท้อนเลขกลับมา (เต็ม / มีขีด / เว้นวรรค / ถูกตัดกลางเลข) → last_error ที่เก็บถูกตัดเลข
    // ทั้ง 3 ทาง: ผล ok:false · throw ErpAdapterError · throw Error ธรรมดา (TRANSIENT)
    const dashed = (d: string) =>
      `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`;
    const spaced = (d: string) =>
      `${d[0]} ${d.slice(1, 5)} ${d.slice(5, 10)} ${d.slice(10, 12)} ${d[12]}`;
    /** ข้อความแบบ AccountSystem ที่ตัด 300 ตัวอักษรกลางเลข (เหลือ 8 หลักแรก) */
    const truncated = (d: string) => `${'x'.repeat(292)}${d}`.slice(0, 300);
    const leaks = (v: unknown) => {
      const t = JSON.stringify(v);
      return [nid, dashed(nid), spaced(nid), nid.slice(0, 8), nid.slice(-6)].filter((f) =>
        t.includes(f),
      );
    };
    const echo = (d: string) => ({
      code: 'contact_invalid',
      message: `tax_id ${dashed(d)} / ${spaced(d)} rejected · ${truncated(d)}`,
      fields: [{ field: `contacts[${d}]`, code: 'invalid', message: `bad ${d} (${dashed(d)})` }],
    });
    const modes = {
      result: (d: string) => ({
        ok: false as const,
        errorClass: 'VALIDATION' as const,
        retryable: false,
        problem: echo(d),
      }),
      adapterError: (d: string) => {
        throw new ErpAdapterError('VALIDATION', echo(d));
      },
      thrown: (d: string) => {
        throw new Error(`socket hang up while sending ${spaced(d)} · ${truncated(d)}`);
      },
    } as const;
    const reg = app.get(ErpAdapterRegistry);
    for (const [mode, respond] of Object.entries(modes)) {
      const sN = await paidSettlement(carrierId, '2500.00');
      const cmdN = (await commands('PUSH_SETTLEMENT')).find((c) => c.localId === sN.uuid)!;
      class EchoAdapter extends AccountSystemAdapter {
        override async pushSettlement(_ctx: unknown, doc: any): Promise<any> {
          return respond(doc.carrier.taxId);
        }
      }
      reg.replace(new EchoAdapter({ allowPrivate: true }));
      try {
        await drainOutbox();
      } finally {
        reg.replace(new AccountSystemAdapter({ allowPrivate: true }));
      }
      const failed = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmdN.id } });
      expect(failed.status, mode).toBe(mode === 'thrown' ? 'FAILED_RETRYABLE' : 'FAILED_FINAL');
      expect(JSON.stringify(failed.lastError), mode).toContain('***');
      expect(leaks(failed.lastError), mode).toEqual([]);
      expect(leaks(failed.payload), mode).toEqual([]);
      expect(leaks(failed.result), mode).toEqual([]);
      // ปิดคำสั่งที่รอลองใหม่ ไม่ให้ค้างไปข้ออื่น
      await plat.$executeRaw`UPDATE integration_outbox SET status = 'FAILED_FINAL' WHERE id = ${cmdN.id}::uuid`;
    }
  });

  it('D-80 redactNationalIds: เต็ม / มีขีด / เว้นวรรค / ปน / ช่วง ≥ 6 หลัก (ถูกตัดกลางเลข) → *** · ช่วงสั้นกว่า 6 / เลขอื่น ไม่แตะ', () => {
    const d = '1101700230705';
    const r = (t: string) => redactNationalIds(t, ['key-not-an-id', d]);
    expect(r(`id ${d}.`)).toBe('id ***.');
    expect(r('id 1-1017-00230-70-5')).toBe('id ***');
    expect(r('id 1 1017 00230 70 5')).toBe('id ***');
    expect(r('id 1-1017 0023-0705')).toBe('id ***');
    expect(r('cut 11017002')).toBe('cut ***');
    expect(r('tail 230705')).toBe('tail ***');
    expect(r('short 11017 / other 9999999999999')).toBe('short 11017 / other 9999999999999');
    expect(redactNationalIds(`x ${d}`, ['abc'])).toBe(`x ${d}`);
  });

  it('D-80: adapter อื่น (Demo / KRS) ไม่ประกาศ carrier.taxId → ไม่ได้เลข · นิติบุคคลไม่ผ่านทางนี้ · รถร่วม tenant อื่น (RLS) ไม่ได้เลข', async () => {
    const nid = validTaxId(4181);
    const car = await api(app, admin).post('/v1/carriers').send({
      legalName: 'นาย รถร่วม บุคคลสอง',
      entityType: 'INDIVIDUAL',
      taxId: nid,
      phone: '081-234-5681',
    });
    expect(car.status, JSON.stringify(car.body)).toBe(201);
    const carrierId = uuid('carrier', car.body.id);
    const doc = {
      kind: 'settlement',
      number: 'PV-TEST',
      carrier: {
        id: carrierId,
        code: 'X',
        legalName: 'x',
        taxId: null,
        branchCode: null,
        entityType: 'INDIVIDUAL',
      },
    } as any;
    const adapters = ERP_ADAPTER_FACTORIES.map((f) => f());
    for (const a of adapters) {
      const r = await db.withTenant(tenantId, (tx) =>
        injectPersonalData(tx, doc, a.personalDataNeeds ?? []),
      );
      if (a instanceof AccountSystemAdapter) {
        expect(r.document.carrier.taxId).toBe(nid);
        expect(r.forHash.carrier.taxId).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(r.fields).toEqual(['carrier.taxId']);
      } else {
        expect(a.personalDataNeeds ?? []).not.toContain('carrier.taxId');
        expect(r.document).toBe(doc);
        expect(JSON.stringify(r)).not.toContain(nid);
      }
    }
    const needs = ['carrier.taxId'] as const;
    // นิติบุคคล: ไม่แตะ (เลขเปิดเผยได้ ใส่ตั้งแต่สร้าง canonical)
    const jur = {
      ...doc,
      carrier: { ...doc.carrier, entityType: 'JURISTIC', taxId: '0105500000001' },
    };
    const rj = await db.withTenant(tenantId, (tx) => injectPersonalData(tx, jur, needs));
    expect(rj.document).toBe(jur);
    expect(rj.fields).toEqual([]);
    // ใบแจ้งหนี้: ไม่มีช่อง carrier → ไม่แตะ
    const inv = {
      kind: 'invoice',
      number: 'IV-1',
      customer: { id: carrierId, taxId: null },
    } as any;
    expect(
      (await db.withTenant(tenantId, (tx) => injectPersonalData(tx, inv, needs))).document,
    ).toBe(inv);
    // tenant อื่นรู้ id ของรถร่วม → RLS ไม่เห็นแถว = ไม่ได้เลข
    const other = await db.withTenant(otherTenantId, (tx) => injectPersonalData(tx, doc, needs));
    expect(other.document).toBe(doc);
    expect(JSON.stringify(other)).not.toContain(nid);
  });

  it('review M1: ยกเลิกใบก่อนคำสั่งส่งถูกส่ง → PUSH_INVOICE ถูกข้าม document_cancelled (ไม่มี IV ร่างของใบที่ยกเลิก) · คำสั่งที่อาจถึงแล้ว (ลองใหม่อยู่) → VOID_DOCUMENT งานยกเลิกด้วยมือ', async () => {
    const voidInv = async (id: string) => {
      const r = await api(app, admin)
        .post(`/v1/invoices/${id}/void`)
        .set('If-Match', `"${(await getInv(id)).version}"`)
        .send({ reason: 'ยกเลิกก่อนส่งเข้าระบบบัญชี ทดสอบ' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    // (ก) ยังไม่ส่ง (PENDING — เช่น connector หยุดอยู่) → ยกเลิก → ไม่ส่ง
    const a = await issuedInvoice('410.00');
    await voidInv(a.id);
    expect((await commands('VOID_DOCUMENT')).filter((c) => c.localId === a.uuid)).toHaveLength(0);
    await drainOutbox();
    const pa = (await commands('PUSH_INVOICE')).find((c) => c.localId === a.uuid)!;
    expect(pa.status).toBe('SKIPPED');
    expect(pa.lastError).toMatchObject({ code: 'document_cancelled' });
    expect(mock.byRef(a.invoiceNo, 'tms.invoice')).toHaveLength(0);
    expect(
      await plat.auditLog.count({
        where: { tenantId, action: 'connector.command_skipped', reason: 'document_cancelled' },
      }),
    ).toBeGreaterThan(0);
    // (ข) ครั้งก่อนล้มแบบลองใหม่ (อาจถึงปลายทางแล้ว เช่น timeout) → ยกเลิก → แจ้งยกเลิกด้วยมือ + ไม่ส่งซ้ำ
    const b = await issuedInvoice('420.00');
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'FAILED_RETRYABLE', attempt = 1
                            WHERE tenant_id = ${tenantId}::uuid AND local_id = ${b.uuid}::uuid`;
    await voidInv(b.id);
    const v = (await commands('VOID_DOCUMENT')).filter((c) => c.localId === b.uuid);
    expect(v).toHaveLength(1);
    await drainOutbox();
    expect(
      (await plat.integrationOutbox.findUniqueOrThrow({ where: { id: v[0]!.id } })).lastError,
    ).toMatchObject({
      code: 'void_manual_required',
    });
    expect((await commands('PUSH_INVOICE')).find((c) => c.localId === b.uuid)!.status).toBe(
      'SKIPPED',
    );
    expect(mock.byRef(b.invoiceNo, 'tms.invoice')).toHaveLength(0);
  });

  it('review L1: document.posted มาก่อนผลการส่งถูกบันทึก → ลองใหม่ (คง RECEIVED) แล้วสำเร็จเมื่อ mapping มา', async () => {
    const inv = await issuedInvoice('430.00');
    const early = mock.webhook('document.posted', {
      id: '11111111-2222-4333-8444-555555555555',
      doc_type: 'IV',
      doc_no: 'IV-EARLY-1',
      external_source: 'tms.invoice',
      external_ref: inv.invoiceNo,
      grand_total: '430.00',
    });
    await send(early).expect(200);
    await drainJobs();
    expect((await events()).find((e) => e.eventKey === early.event.id)!.status).toBe('RECEIVED');
    await drainOutbox();
    await drainJobs();
    expect((await events()).find((e) => e.eventKey === early.event.id)!.status).toBe('PROCESSED');
    expect(await mapping('INVOICE', inv.uuid)).toMatchObject({
      externalStatus: 'POSTED',
      externalDocNo: 'IV-EARLY-1',
    });
  });

  it('review M3: ยอดที่ระบบบัญชีลงบัญชี ≠ ยอด TMS → คิวตรวจ external_total_mismatch (ยังเก็บเลขเอกสาร)', async () => {
    const inv = await issuedInvoice('440.00');
    await drainOutbox();
    const [doc] = mock.byRef(inv.invoiceNo, 'tms.invoice');
    const ok = mock.post(doc!.id);
    expect(ok.event.data.grand_total).toBe('440.00');
    const bad = mock.webhook('document.posted', { ...ok.event.data, grand_total: '470.80' });
    await send(bad).expect(200);
    await drainJobs();
    const ev = (await events()).find((e) => e.eventKey === bad.event.id)!;
    expect(ev.status).toBe('FAILED');
    expect(ev.lastError).toMatchObject({ code: 'external_total_mismatch', review: true });
    expect(await mapping('INVOICE', inv.uuid)).toMatchObject({
      externalStatus: 'POSTED',
      externalDocNo: ok.event.data.doc_no,
    });
    // ยอดตรง = ผ่าน
    await send(ok).expect(200);
    await drainJobs();
    expect((await events()).find((e) => e.eventKey === ok.event.id)!.status).toBe('PROCESSED');
  });

  it('review M2 + M4: ใบรับเงินถูกยกเลิกในระบบบัญชี (เช็คคืน) → คิวตรวจ payment_voided_external ไม่กลับรายการเอง · รับชำระอ้างเลขใบที่ TMS ไม่รู้จัก → คิวตรวจ', async () => {
    const inv = await issuedInvoice('450.00');
    await drainOutbox();
    const [doc] = mock.byRef(inv.invoiceNo, 'tms.invoice');
    await send(mock.post(doc!.id)).expect(200);
    const rv = mock.receive([{ documentId: doc!.id, applied: '450.00' }]);
    await send(rv).expect(200);
    await drainJobs();
    expect((await getInv(inv.id)).status).toBe('PAID');
    const rvVoid = mock.webhook('document.voided', {
      id: rv.event.data.id,
      doc_type: 'RV',
      doc_no: rv.event.data.doc_no,
      external_source: null,
      external_ref: null,
      reason: 'เช็คคืน',
      reversal: 'JV-R-1',
    });
    await send(rvVoid).expect(200);
    await drainJobs();
    const ev = (await events()).find((e) => e.eventKey === rvVoid.event.id)!;
    expect(ev.status).toBe('FAILED');
    expect(ev.lastError).toMatchObject({ code: 'payment_voided_external', review: true });
    expect((await getInv(inv.id)).status).toBe('PAID');
    const pay = await plat.externalMapping.findFirstOrThrow({
      where: { tenantId, entityType: 'PAYMENT', externalId: rv.event.data.id as string },
    });
    expect(pay.externalStatus).toBe('VOIDED');
    expect((await plat.payment.findUniqueOrThrow({ where: { id: pay.localId } })).status).toBe(
      'RECORDED',
    );
    // M4: เลขใบอ้างของ TMS ที่ไม่มี mapping → ไม่ข้ามเงียบ
    const unk = mock.webhook('payment.received', {
      id: '99999999-2222-4333-8444-555555555555',
      doc_no: 'RV-X',
      applications: [
        {
          document_id: '88888888-2222-4333-8444-555555555555',
          doc_no: 'IV-X',
          external_ref: 'INV-NOT-IN-TMS',
          applied: '10.00',
          wht: '0.00',
        },
      ],
    });
    await send(unk).expect(200);
    await drainJobs();
    const e2 = (await events()).find((e) => e.eventKey === unk.event.id)!;
    expect(e2.status).toBe('FAILED');
    expect(e2.lastError).toMatchObject({ code: 'payment_unmatched' });
    // RV ของเอกสารที่ไม่ได้มาจาก TMS (ไม่มีเลขอ้าง) = ไม่มีผล
    const other = mock.webhook('payment.received', {
      id: '77777777-2222-4333-8444-555555555555',
      doc_no: 'RV-Y',
      applications: [
        {
          document_id: '66666666-2222-4333-8444-555555555555',
          external_ref: null,
          applied: '10.00',
          wht: '0.00',
        },
      ],
    });
    await send(other).expect(200);
    await drainJobs();
    expect((await events()).find((e) => e.eventKey === other.event.id)!.status).toBe('PROCESSED');
  });

  it('(6) external_mapping แยก tenant (RLS) — tenant อื่นมองไม่เห็นแม้รู้ id', async () => {
    const all = await plat.externalMapping.findMany({ where: { tenantId } });
    expect(all.length).toBeGreaterThan(0);
    const seen = await db.withTenant(otherTenantId, (tx) =>
      tx.externalMapping.findMany({ where: { id: { in: all.map((m) => m.id) } } }),
    );
    expect(seen).toEqual([]);
    const own = await db.withTenant(tenantId, (tx) => tx.externalMapping.count());
    expect(own).toBe(all.length);
    // app role ลบไม่ได้ (ไม่มี hard delete)
    await expect(
      db.withTenant(tenantId, (tx) => tx.externalMapping.deleteMany({ where: { id: all[0]!.id } })),
    ).rejects.toThrow(/permission denied/);
  });

  it('(4) ปิด connector แล้ว: วางบิล (finalize) · รับเช็ค · จ่ายรถร่วม ทำได้ครบ ไม่มีคำสั่งเข้าคิว · URL webhook ใช้ไม่ได้', async () => {
    const c = await api(app, admin).get(`/v1/connectors/${conId}`).expect(200);
    const d = await api(app, admin)
      .post(`/v1/connectors/${conId}/disconnect`)
      .set('If-Match', String(c.headers.etag))
      .send({ reason: 'เลิกใช้ระบบบัญชี ทดสอบ standalone' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    await rateLimitInstance()?.reset('inb:');
    const before = (await commands()).length;
    const inv = await issuedInvoice('800.00');
    const pay = await api(app, accounting)
      .post('/v1/payments')
      .send({
        receivedDate: today,
        method: 'CHEQUE',
        chequeNo: '0012345',
        chequeBank: 'กรุงเทพ',
        chequeDate: today,
        amountReceived: '792.00',
        whtAmount: '8.00',
        allocations: [{ invoiceId: inv.id, amount: '800.00', whtAmount: '8.00' }],
      });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect((await getInv(inv.id)).status).toBe('PAID');
    // ไม่มี connector = ไม่มีผลการซิงก์ (สถานะเอกสารเดินเองใน TMS)
    expect((await getInv(inv.id)).sync).toBeNull();
    const car = await api(app, admin)
      .post('/v1/carriers')
      .send({
        legalName: 'บริษัท รถร่วมสแตนด์อโลน จำกัด',
        entityType: 'JURISTIC',
        taxId: juristicTaxId(4104),
        branchCode: '00000',
        phone: '081-234-5679',
      })
      .expect(201);
    await paidSettlement(uuid('carrier', car.body.id), '5000.00');
    expect((await commands()).length).toBe(before);
    const w = mock.webhook('document.posted', { id: 'x', external_source: 'tms.invoice' });
    expect((await send(w)).status).toBe(401);
  });
});
