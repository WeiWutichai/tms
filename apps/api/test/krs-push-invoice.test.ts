import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient, VatType } from '@prisma/client';
import { SYSTEM_ROLES } from '@tms/domain';
import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import { parseKrsCreated, redactKrsBody, splitByVatType } from '../src/erp-adapters/krs/krs-push';
import type { CanonicalDocument } from '../src/modules/erp/erp-adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { ERP_DRIVER_NAME_SUBSTITUTED } from '../src/modules/erp/erp-document-warnings';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST8-T08 `pushInvoice` ของ KRS (docs/01 A.1–A.3, A.6; D-64, D-69) — ครบวงจรผ่าน API + outbox กับ mock KRS (ST8-T01)
 * เกณฑ์ตรวจรับ (plan/01 ST8-T08): finalize ใน TMS → mock ได้ POST 1 ครั้ง → mapping มี `transactionNo` / `voucherNo`
 * + แยกใบตาม `vat_type` (สัญญาไม่มี VAT ต่อรายการ) · routing ตามนิติบุคคล (SO จาก NSF ใบออกบริษัท PP) ·
 * D-64 เที่ยวรถร่วมไม่มีชื่อคนขับ → `carPerson` = ชื่อบริษัทรถร่วม + เตือนตั้งแต่ร่าง · sync log (ST7-T16) ไม่มี key/ชื่อคนขับ
 */

const KEY = 'krs-push-test-key-4c81d2';

describe('KRS push helpers (ST8-T08) — ไม่แตะฐานข้อมูล', () => {
  const doc = (vats: (string | null)[]): CanonicalDocument => ({
    id: 'x',
    number: 'INV-1',
    lines: vats.map((v, i) => ({ lineNo: i + 1, vatType: v })),
  });

  it('แยกตาม vat_type: กลุ่มเดียว = เลขใบแจ้งหนี้ · หลายกลุ่ม = ลำดับคงที่ (ยกเว้น → 7% → 0%) ไม่ขึ้นกับลำดับรายการ', () => {
    const one = splitByVatType(doc(['VAT_7', 'VAT_7']));
    expect(one.ok && one.groups.map((g) => [g.group, g.tmsVoucherNo])).toEqual([
      ['VAT_7', 'INV-1'],
    ]);
    const two = splitByVatType(doc(['VAT_7', 'EXEMPT_TRANSPORT', 'VAT_7', 'ZERO_RATED']));
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(two.groups.map((g) => [g.group, g.tmsVoucherNo])).toEqual([
      ['EXEMPT_TRANSPORT', 'INV-1'],
      ['VAT_7', 'INV-1-V7'],
      ['ZERO_RATED', 'INV-1-V0'],
    ]);
    expect(
      two.groups.map((g) => (g.doc.lines as { lineNo: number }[]).map((l) => l.lineNo)),
    ).toEqual([[2], [1, 3], [4]]);
    // ชนิด VAT ไม่รู้จัก = ไม่เดา
    const bad = splitByVatType(doc(['VAT_7', null]));
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.problem).toMatchObject({
        errorClass: 'VALIDATION',
        problem: { code: 'krs_payload_invalid', fields: [{ code: 'krs_vat_type_unknown' }] },
      });
  });

  it('response 201: อ่านเลข KRS · JSON ถูกตัดยังหาเลขได้ · ไม่มีเลข = null · sync log ไม่มีชื่อคนขับ', () => {
    expect(parseKrsCreated('{"transactionNo":"100001","voucherNo":"SA-S6911-0001"}')).toEqual({
      transactionNo: '100001',
      voucherNo: 'SA-S6911-0001',
    });
    expect(
      parseKrsCreated('{"transactionNo":"100002","voucherNo":"SA-S6911-0002","lines":[{'),
    ).toEqual({ transactionNo: '100002', voucherNo: 'SA-S6911-0002' });
    expect(parseKrsCreated('{"error":"x"}')).toBeNull();
    const body = redactKrsBody({
      lines: [{ carPerson: 'สมชาย ใจดี', carId: '70-1' }],
    } as never) as { lines: { carPerson: string; carId: string }[] };
    expect(body.lines[0]).toEqual({ carPerson: '***', carId: '70-1' });
  });
});

describe('KRS pushInvoice ครบวงจร (ST8-T08)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let dispatcher: OutboxDispatcher;
  let mock: MockKrs;
  let tenantId: string;
  let ppCompany: string; // บริษัท PP — connector KRS ผูก (ใบออกที่นี่)
  let ppBranch: string;
  let otherCompany: string; // นิติบุคคลที่ไม่มี connector (standalone)
  let otherBranch: string;
  let customerId: string;
  let freight: string;
  let service: string;
  let admin: string;
  let accounting: string;
  let conId: string;
  let conUuid: string;
  let seq = 0;
  const today = bangkokToday();
  const prevPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  const CARRIER = 'บริษัท รถร่วมตัวอย่าง จำกัด';
  const DRIVER = 'สมชาย คนขับทดสอบ';

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
  const posts = () => mock.requests().filter((q) => q.method === 'POST');

  /** DO 1 ใบ (SO จาก KRS บริษัท NSF) + เที่ยว: รถบริษัท (มีชื่อคนขับ) หรือ รถร่วม (ไม่มีชื่อคนขับ) */
  async function deliveryOrder(kind: 'own' | 'subcon' | 'subcon-blank') {
    const tag = `P${++seq}`;
    const site = (k: string) =>
      plat.customerSite.create({
        data: { tenantId, code: `S${k}-${tag}`, name: `คลัง ${k} ${tag}`, address: { line1: 'x' } },
      });
    const [a, b] = [await site('A'), await site('B')];
    const so = await plat.salesOrder.create({
      data: {
        tenantId,
        soNo: `SO-${tag}`,
        // A.1 ข้อสมมติ: SO อยู่บริษัท NSF ฝั่ง KRS (external id KRS-NSF-…) แต่ใบแจ้งหนี้ออกในบริษัท PP
        externalId: `KRS-NSF-SAMPLE-SO-${tag}`,
        source: 'MANUAL',
        customerId,
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
        vehiclePlateSnapshot: kind === 'own' ? '70-1234' : '71-9999',
        ...(kind === 'own'
          ? { driverNameSnapshot: DRIVER }
          : // review L1: ชื่อคนขับที่เป็นช่องว่างล้วน = ไม่มีชื่อ
            {
              carrierNameSnapshot: CARRIER,
              ...(kind === 'subcon-blank' ? { driverNameSnapshot: '   ' } : {}),
            }),
      },
    });
    return plat.deliveryOrder.create({
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
  }

  type Line = { doId: string; vat: VatType; amount: string };
  /** ร่างใบแจ้งหนี้ (บรรทัดผูก DO) */
  async function draft(lines: Line[], company: 'pp' | 'other' = 'pp') {
    // บรรทัดแรกของแต่ละ DO = บรรทัดหลัก (`do_anchor` — กันวางบิลซ้ำต่อ DO) · บรรทัดถัดไปของ DO เดียวกัน = บริการเสริม
    const anchored = new Set<string>();
    const anchor = (doId: string) => (anchored.has(doId) ? false : !!anchored.add(doId));
    const inv = await plat.invoice.create({
      data: {
        tenantId,
        customerId,
        issuingCompanyId: company === 'pp' ? ppCompany : otherCompany,
        issuingBranchId: company === 'pp' ? ppBranch : otherBranch,
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
            deliveryOrderId: l.doId,
            doAnchor: anchor(l.doId),
          })),
        },
      },
    });
    return { uuid: inv.id, id: encodeId('invoice', inv.id), version: inv.version };
  }
  async function finalize(d: { id: string; uuid: string; version: number }) {
    const r = await api(app, accounting)
      .post(`/v1/invoices/${d.id}/finalize`)
      .set('If-Match', `"${d.version}"`)
      .send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.invoiceNo as string;
  }
  const getInv = async (id: string) =>
    (await api(app, admin).get(`/v1/invoices/${id}`).expect(200)).body as Record<string, any>;
  const mapping = (localId: string) =>
    plat.externalMapping.findFirst({ where: { tenantId, entityType: 'INVOICE', localId } });

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    await truncateAll();
    app = await bootApp();
    dispatcher = app.get(OutboxDispatcher);
    // adapter ตัวจริง แต่ยอมปลายทาง 127.0.0.1 ของ mock
    app.get(ErpAdapterRegistry).replace(new KrsAdapter({ allowPrivate: true }));
    mock = await startMockKrs({ apiKey: KEY });
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ขนส่ง KRS ทดสอบ จำกัด' })).id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    const company = async (name: string, seed: number) => {
      const c = await plat.company.create({
        data: { tenantId, legalName: name, taxId: validTaxId(seed) },
      });
      const b = await plat.branch.create({
        data: {
          tenantId,
          companyId: c.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          isDefaultIssuer: true,
          address: { line1: '1', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
        },
      });
      return [c.id, b.id] as const;
    };
    [ppCompany, ppBranch] = await company('บริษัท พีพี ตัวอย่าง จำกัด', 8101);
    [otherCompany, otherBranch] = await company('บริษัท อื่น ตัวอย่าง จำกัด', 8102);
    customerId = (
      await plat.customer.create({
        data: {
          tenantId,
          code: 'C-KRS1',
          legalName: 'บริษัท ลูกค้า KRS ตัวอย่าง จำกัด',
          taxId: validTaxId(8103),
          branchCode: '00000',
          billingAddress: { line1: '9 ถ.ตัวอย่าง', province: 'ระยอง', postcode: '21000' },
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
    freight = (await item('T08-FRT', 'EXEMPT_TRANSPORT', '1.00')).id;
    service = (await item('T08-LIFT', 'VAT_7', '3.00')).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');

    // connector KRS ผูกบริษัท PP (routing ตามนิติบุคคล — docs/04 G3)
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
    // ผังรหัส KRS (ST8-T06) + รหัสลูกค้าฝั่ง PP (ST8-T05) + รหัสสินค้า (ST7-T18)
    for (const [kind, code] of [
      ['UNIT', 'เที่ยว'],
      ['SALESPERSON', 'S01'],
    ] as const)
      await plat.erpMasterCode.create({
        data: {
          tenantId,
          connectorId: conUuid,
          kind,
          code,
          name: `${code} (ตัวอย่าง)`,
          source: 'IMPORT',
        },
      });
    for (const [serviceItemId, itemCode] of [
      [freight, 'SAMPLE-ITEM-FRT'],
      [service, 'SAMPLE-ITEM-LIFT'],
    ] as const)
      await plat.erpCodeMapping.create({
        data: { tenantId, connectorId: conUuid, serviceItemId, itemCode },
      });
    await api(app, admin)
      .put(`/v1/customers/${encodeId('customer', customerId)}/erp-codes/${conId}`)
      .send({ externalId: 'PP-C001' })
      .expect(200);
    await api(app, admin).post(`/v1/connectors/${conId}/resume`).send({}).expect(200);
    const on = await api(app, admin)
      .patch(`/v1/connectors/${conId}`)
      .send({
        capabilitiesEnabled: ['pullOrders', 'pushInvoice', 'ownsDocumentNumber', 'fetchDocument'],
      });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.capabilitiesEnabled).toEqual(
      expect.arrayContaining(['pushInvoice', 'ownsDocumentNumber']),
    );
  });
  beforeEach(() => mock.clearFaults());
  afterAll(async () => {
    if (prevPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = prevPrivate;
    await mock?.stop();
    await app?.close();
    await plat.$disconnect();
  });

  it('catalog: pushInvoice + ownsDocumentNumber + fetchDocument (ST8-T10) + replaceDocument (ST8-T13) ไม่ pending แล้ว', async () => {
    const cat = await api(app, admin).get('/v1/connectors/adapters').expect(200);
    const k = cat.body.data.find((a: { key: string }) => a.key === 'krs');
    expect(k.capabilitiesPending).toEqual([]);
  });

  it('เกณฑ์ตรวจรับ: finalize → mock ได้ POST 1 ครั้ง (tmsVoucherNo = เลขใบแจ้งหนี้) → mapping มี transactionNo / voucherNo', async () => {
    const d = await deliveryOrder('own');
    const inv = await draft([{ doId: d.id, vat: 'EXEMPT_TRANSPORT', amount: '1500.00' }]);
    // ร่างที่เที่ยวมีชื่อคนขับ = ไม่มีคำเตือน
    expect((await getInv(inv.id)).erpWarnings).toEqual([]);
    const before = posts().length;
    const invoiceNo = await finalize(inv);
    await drain();
    expect(posts().length - before).toBe(1);
    const got = mock.getInvoiceByTmsVoucherNo(invoiceNo)!;
    expect(got).toBeTruthy();
    expect(got.data).toMatchObject({
      tmsVoucherNo: invoiceNo,
      voucherDate: today,
      paymentInDay: 30,
      custOrSuppCode: 'PP-C001',
      salePerson: 'S01',
      entryBy: 'TMS',
    });
    expect(got.data.lines).toEqual([
      expect.objectContaining({
        lineId: 1,
        mainQuantity: 1,
        mainUnits: 'เที่ยว',
        unitPrice: 1500,
        flowNo: d.doNo,
        carId: '70-1234',
        carPerson: DRIVER,
        itemCode: 'SAMPLE-ITEM-FRT',
      }),
    ]);
    const cmd = (await commands(inv.uuid)).find((c) => c.operation === 'PUSH_INVOICE')!;
    expect(cmd.status).toBe('DONE');
    expect(cmd.result).toMatchObject({
      externalId: got.transactionNo,
      externalDocNo: got.voucherNo,
      applied: true,
    });
    const m = await mapping(inv.uuid);
    expect(m).toMatchObject({
      connectorId: conUuid,
      localNumber: invoiceNo,
      externalId: got.transactionNo,
      externalDocNo: got.voucherNo,
      status: 'SYNCED',
    });
    expect(got.voucherNo).toMatch(/^SA-S\d{4}-\d{4}$/);
    const out = await getInv(inv.id);
    expect(out.sync).toMatchObject({
      connectorId: conId,
      state: 'SYNCED',
      externalId: got.transactionNo,
      externalDocNo: got.voucherNo,
      externalDocuments: [],
    });
    // ST7-T16 sync log: 1 แถวต่อ POST · ไม่มี API key · ชื่อคนขับ (ข้อมูลส่วนบุคคล) ถูกปิด
    const logs = await plat.erpSyncLog.findMany({ where: { outboxId: cmd.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      method: 'POST',
      statusCode: 201,
      url: `${mock.apiBaseUrl}/invoice`,
      localNumber: invoiceNo,
    });
    expect(logs[0]!.requestBody).toContain(invoiceNo);
    expect(logs[0]!.responseBody).toContain(got.transactionNo);
    expect(logs[0]!.requestBody).not.toContain(DRIVER);
    expect(JSON.stringify(logs)).not.toContain(KEY);
    // review M1: KRS สะท้อนรายการกลับใน response — ชื่อคนขับต้องไม่อยู่ในแถวใดของ sync log
    expect(JSON.stringify(logs)).not.toContain(DRIVER);
    expect(logs[0]!.responseBody).toContain('"carPerson":"***"');
    // สั่งส่งซ้ำ (payload เดิม) = ไม่ POST ซ้ำ
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'PENDING', attempt = 0 WHERE id = ${cmd.id}::uuid`;
    await drain();
    expect(posts().length - before).toBe(1);
  });

  it('แยกใบตาม vat_type (D-69 — สัญญา KRS ไม่มี VAT ต่อรายการ): ค่าขนส่งยกเว้น + ค่ายกขน 7% = 2 ใบใน KRS · mapping เก็บทั้งสองใบ', async () => {
    const d1 = await deliveryOrder('own');
    const d2 = await deliveryOrder('own');
    const inv = await draft([
      { doId: d1.id, vat: 'VAT_7', amount: '500.00' },
      { doId: d1.id, vat: 'EXEMPT_TRANSPORT', amount: '2000.00' },
      { doId: d2.id, vat: 'EXEMPT_TRANSPORT', amount: '1800.00' },
    ]);
    const before = posts().length;
    const invoiceNo = await finalize(inv);
    await drain();
    expect(posts().length - before).toBe(2);
    const exempt = mock.getInvoiceByTmsVoucherNo(invoiceNo)!;
    const vat7 = mock.getInvoiceByTmsVoucherNo(`${invoiceNo}-V7`)!;
    expect(exempt.data.lines.map((l) => [l.lineId, l.flowNo, l.unitPrice])).toEqual([
      [2, d1.doNo, 2000],
      [3, d2.doNo, 1800],
    ]);
    expect(vat7.data.lines.map((l) => [l.lineId, l.flowNo, l.unitPrice])).toEqual([
      [1, d1.doNo, 500],
    ]);
    // ไม่ส่งยอด/VAT (A.3: KRS คำนวณเอง) — หัวเอกสารเดียวกันทั้งสองใบ
    for (const k of ['custOrSuppCode', 'voucherDate', 'dueDate', 'salePerson'] as const)
      expect(vat7.data[k]).toBe(exempt.data[k]);
    const m = await mapping(inv.uuid);
    expect(m).toMatchObject({
      externalId: exempt.transactionNo,
      externalDocNo: exempt.voucherNo,
      status: 'SYNCED',
    });
    expect((m!.detail as { documents: unknown[] }).documents).toEqual([
      {
        ref: invoiceNo,
        externalId: exempt.transactionNo,
        externalDocNo: exempt.voucherNo,
        group: 'EXEMPT_TRANSPORT',
        lineNos: [2, 3],
      },
      {
        ref: `${invoiceNo}-V7`,
        externalId: vat7.transactionNo,
        externalDocNo: vat7.voucherNo,
        group: 'VAT_7',
        lineNos: [1],
      },
    ]);
    expect((await getInv(inv.id)).sync.externalDocuments).toEqual([
      {
        ref: invoiceNo,
        externalId: exempt.transactionNo,
        externalDocNo: exempt.voucherNo,
        group: 'EXEMPT_TRANSPORT',
      },
      {
        ref: `${invoiceNo}-V7`,
        externalId: vat7.transactionNo,
        externalDocNo: vat7.voucherNo,
        group: 'VAT_7',
      },
    ]);
  });

  it('D-64: เที่ยวรถร่วมไม่มีชื่อคนขับ → เตือนตั้งแต่ร่าง · KRS ได้ carPerson = ชื่อบริษัทรถร่วม', async () => {
    const own = await deliveryOrder('own');
    const sub = await deliveryOrder('subcon');
    const blank = await deliveryOrder('subcon-blank');
    const inv = await draft([
      { doId: own.id, vat: 'EXEMPT_TRANSPORT', amount: '1000.00' },
      { doId: sub.id, vat: 'EXEMPT_TRANSPORT', amount: '1200.00' },
      { doId: blank.id, vat: 'EXEMPT_TRANSPORT', amount: '1100.00' },
    ]);
    const warn = (await getInv(inv.id)).erpWarnings;
    expect(warn).toEqual([
      {
        code: ERP_DRIVER_NAME_SUBSTITUTED,
        message: expect.stringContaining('จะส่งชื่อบริษัทรถร่วมแทนชื่อคนขับ'),
        connectorId: conId,
        deliveryOrderNos: [sub.doNo, blank.doNo],
      },
    ]);
    const invoiceNo = await finalize(inv);
    // ออกเอกสารแล้วยังเห็นคำเตือน (ไม่บล็อกการออก)
    expect((await getInv(inv.id)).erpWarnings).toHaveLength(1);
    await drain();
    const got = mock.getInvoiceByTmsVoucherNo(invoiceNo)!;
    expect(got.data.lines.map((l) => [l.flowNo, l.carPerson, l.carId])).toEqual([
      [own.doNo, DRIVER, '70-1234'],
      [sub.doNo, CARRIER, '71-9999'],
      [blank.doNo, CARRIER, '71-9999'],
    ]);
    expect((await mapping(inv.uuid))?.status).toBe('SYNCED');
    // review L1: ส่งแล้ว = ข้อความแบบอดีต (ไม่ใช่ "จะส่ง")
    const after = (await getInv(inv.id)).erpWarnings;
    expect(after[0].message).toContain('ส่งชื่อบริษัทรถร่วมแทนชื่อคนขับเข้าระบบบัญชีแล้ว');
    expect(after[0].message).not.toContain('จะส่ง');
    // review M1: ไม่มีชื่อคนขับใน sync log ของใบนี้ทั้ง request และ response
    const cmd = (await commands(inv.uuid)).find((c) => c.operation === 'PUSH_INVOICE')!;
    const logs = await plat.erpSyncLog.findMany({ where: { outboxId: cmd.id } });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(DRIVER);
  });

  it('routing ตามนิติบุคคล: ใบที่ออกในนิติบุคคลที่ไม่มี connector ไม่ถูกส่งเข้า KRS และไม่มีคำเตือน', async () => {
    const sub = await deliveryOrder('subcon');
    const inv = await draft([{ doId: sub.id, vat: 'EXEMPT_TRANSPORT', amount: '900.00' }], 'other');
    expect((await getInv(inv.id)).erpWarnings).toEqual([]);
    const before = posts().length;
    const invoiceNo = await finalize(inv);
    await drain();
    expect(await commands(inv.uuid)).toEqual([]);
    expect(posts().length).toBe(before);
    expect(invoiceNo).toBeTruthy();
    expect((await getInv(inv.id)).sync).toBeNull();
  });

  it('ข้อมูลไม่ครบตามสัญญา (หน่วยไม่อยู่ในผัง KRS) = ไม่ POST เลย · คำสั่ง FAILED_FINAL (VALIDATION)', async () => {
    const d = await deliveryOrder('own');
    const inv = await draft([{ doId: d.id, vat: 'EXEMPT_TRANSPORT', amount: '700.00' }]);
    await plat.invoiceLine.updateMany({
      where: { invoiceId: inv.uuid },
      data: { unitLabel: 'ตู้' },
    });
    const before = posts().length;
    await finalize(inv);
    await drain();
    expect(posts().length).toBe(before);
    const cmd = (await commands(inv.uuid))[0]!;
    expect(cmd).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
  });

  it('KRS ตอบ 400 = VALIDATION (ไม่ลองใหม่) · response เก็บใน sync log (การจัดการเต็มตาม A.5 = ST8-T09)', async () => {
    const d = await deliveryOrder('own');
    const inv = await draft([{ doId: d.id, vat: 'EXEMPT_TRANSPORT', amount: '650.00' }]);
    mock.injectFault({ kind: 'status', status: 400, times: 1, method: 'POST' });
    await finalize(inv);
    await drain();
    const cmd = (await commands(inv.uuid))[0]!;
    expect(cmd).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    const logs = await plat.erpSyncLog.findMany({ where: { outboxId: cmd.id } });
    expect(logs.map((l) => l.statusCode)).toEqual([400]);
    // ไม่มีเลขฝั่ง KRS — mapping บันทึกแค่ผลล้ม
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'FAILED',
      externalId: null,
      lastError: { code: 'krs_rejected', errorClass: 'VALIDATION' },
    });
  });
  /** ร่างใบที่แยก 2 เอกสาร KRS (ยกเว้น + 7%) แล้ว finalize */
  async function splitInvoice() {
    const d1 = await deliveryOrder('own');
    const d2 = await deliveryOrder('own');
    const inv = await draft([
      { doId: d1.id, vat: 'EXEMPT_TRANSPORT', amount: '3000.00' },
      { doId: d2.id, vat: 'VAT_7', amount: '400.00' },
    ]);
    const invoiceNo = await finalize(inv);
    return { inv, invoiceNo };
  }

  for (const [label, status, retry] of [
    ['503 (TRANSIENT — ลองใหม่ตามรอบ)', 503, 'auto'],
    ['400 (VALIDATION — ส่งใหม่ด้วยมือ)', 400, 'manual'],
  ] as const)
    it(`review H1: ใบที่ 2 ล้ม ${label} → mapping เก็บใบแรก (ยังไม่ SYNCED) → ส่งซ้ำ POST เฉพาะใบที่ขาด → mapping ครบ 2 ใบ`, async () => {
      mock.injectFault({ kind: 'status', status, method: 'POST', skip: 1, times: 1 });
      const before = posts().length;
      const { inv, invoiceNo } = await splitInvoice();
      await drain();
      expect(posts().length - before).toBe(2);
      const first = mock.getInvoiceByTmsVoucherNo(invoiceNo)!;
      expect(mock.getInvoiceByTmsVoucherNo(`${invoiceNo}-V7`)).toBeUndefined();
      const cmd = (await commands(inv.uuid)).find((c) => c.operation === 'PUSH_INVOICE')!;
      const row = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } });
      expect(row).toMatchObject(
        status === 503
          ? { status: 'FAILED_RETRYABLE', errorClass: 'TRANSIENT' }
          : { status: 'FAILED_FINAL', errorClass: 'VALIDATION' },
      );
      expect(row.lastError).toMatchObject({ knownOutcome: true, documentsCreated: 1 });
      const m1 = await mapping(inv.uuid);
      expect(m1).toMatchObject({
        externalId: first.transactionNo,
        externalDocNo: first.voucherNo,
        lastSyncedHash: null,
      });
      expect(m1!.status).not.toBe('SYNCED');
      expect(m1!.detail).toMatchObject({
        documentsPartial: true,
        documentsComplete: true,
        documents: [{ ref: invoiceNo, externalId: first.transactionNo, group: 'EXEMPT_TRANSPORT' }],
      });
      // ส่งซ้ำ: อัตโนมัติ (TRANSIENT) / ผู้ใช้สั่งส่งใหม่ (VALIDATION → ตั้งคำสั่งกลับเป็น PENDING)
      if (retry === 'manual')
        await plat.$executeRaw`UPDATE integration_outbox SET status = 'PENDING', attempt = 0, done_at = NULL WHERE id = ${cmd.id}::uuid`;
      await drain();
      const sent = posts().slice(before + 2);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.status).toBe(201);
      const second = mock.getInvoiceByTmsVoucherNo(`${invoiceNo}-V7`)!;
      expect(second).toBeTruthy();
      expect(mock.listInvoices().filter((i) => i.data.tmsVoucherNo === invoiceNo)).toHaveLength(1);
      expect(
        (await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } })).status,
      ).toBe('DONE');
      const m2 = await mapping(inv.uuid);
      expect(m2).toMatchObject({ status: 'SYNCED', externalId: first.transactionNo });
      const detail = m2!.detail as Record<string, unknown>;
      expect(detail.documentsPartial).toBeUndefined();
      expect(detail.documentsComplete).toBeUndefined();
      expect((detail.documents as { externalId: string }[]).map((x) => x.externalId)).toEqual([
        first.transactionNo,
        second.transactionNo,
      ]);
    });

  it('review M2: ใบแรกล้ม 503 (ได้คำตอบชัด = ไม่มีใบใดถูกสร้าง) → ลองใหม่ตามปกติ ไม่พักคำสั่ง', async () => {
    const d = await deliveryOrder('own');
    const inv = await draft([{ doId: d.id, vat: 'EXEMPT_TRANSPORT', amount: '820.00' }]);
    mock.injectFault({ kind: 'status', status: 503, method: 'POST', times: 1 });
    const before = posts().length;
    const invoiceNo = await finalize(inv);
    await drain();
    const cmd = (await commands(inv.uuid)).find((c) => c.operation === 'PUSH_INVOICE')!;
    const row = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(row).toMatchObject({ status: 'FAILED_RETRYABLE', errorClass: 'TRANSIENT' });
    expect(row.lastError).toMatchObject({ knownOutcome: true, documentsCreated: 0 });
    expect(await mapping(inv.uuid)).toBeNull();
    await drain();
    expect(posts().length - before).toBe(2);
    expect((await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } })).status).toBe(
      'DONE',
    );
    expect(mock.getInvoiceByTmsVoucherNo(invoiceNo)).toBeTruthy();
    expect((await mapping(inv.uuid))?.status).toBe('SYNCED');
  });
  it('re-review M1 + ST8-T10: ใบที่ 2 ล้ม 504 (ไม่รู้แน่) → รอบถัดไปค้นก่อน: รู้เลข KRS ของใบแรก (mapping) แต่ไม่ครบทุกรายการ → POST เฉพาะใบที่ขาด', async () => {
    mock.injectFault({ kind: 'status', status: 504, method: 'POST', skip: 1, times: 1 });
    const before = posts().length;
    const { inv, invoiceNo } = await splitInvoice();
    await drain();
    expect(posts().length - before).toBe(2);
    const cmd = (await commands(inv.uuid)).find((c) => c.operation === 'PUSH_INVOICE')!;
    const row = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(row).toMatchObject({ status: 'FAILED_RETRYABLE', errorClass: 'TRANSIENT' });
    expect(row.lastError).toMatchObject({ knownOutcome: false, documentsCreated: 1 });
    expect((await mapping(inv.uuid))!.detail).toMatchObject({
      documentsPartial: true,
      documentsComplete: false,
    });
    await drain();
    // KRS ไม่มีใบ -V7 (504 ของ mock ไม่บันทึก) — ใบที่อาจถึงแล้ว KRS จะตอบ 409 (A.5) จึงส่งได้โดยไม่สร้างซ้ำ
    const sent = posts().slice(before + 2);
    expect(sent.map((q) => q.status)).toEqual([201]);
    expect(mock.listInvoices().filter((i) => i.data.tmsVoucherNo === invoiceNo)).toHaveLength(1);
    const done = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(done.status).toBe('DONE');
    const m = await mapping(inv.uuid);
    expect(m).toMatchObject({ status: 'SYNCED' });
    expect((m!.detail as { documents: { ref: string }[] }).documents.map((x) => x.ref)).toEqual([
      invoiceNo,
      `${invoiceNo}-V7`,
    ]);
  });

  it('re-review M2 + ST8-T10: worker ตายหลัง KRS ตอบ 201 (ไม่มีผล/ sync log) → ยึดคืน → POST ใบที่ขาด ได้ 409 → DUPLICATE ให้คนกรอกเลข (A.5) ไม่สร้างซ้ำ', async () => {
    mock.injectFault({ kind: 'status', status: 503, method: 'POST', skip: 1, times: 1 });
    const before = posts().length;
    const { inv, invoiceNo } = await splitInvoice();
    await drain();
    const cmd = (await commands(inv.uuid)).find((c) => c.operation === 'PUSH_INVOICE')!;
    expect(
      (await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } })).lastError,
    ).toMatchObject({ knownOutcome: true, documentsCreated: 1 });
    // รอบถัดไป: worker ส่งใบที่ 2 ถึง KRS (201) แล้วตายก่อนบันทึกผล/sync log — คำสั่งค้าง IN_FLIGHT ที่ lease หมดอายุ
    const part1 = mock.getInvoiceByTmsVoucherNo(invoiceNo)!;
    const r = await fetch(`${mock.apiBaseUrl}/invoice`, {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...part1.data, tmsVoucherNo: `${invoiceNo}-V7` }),
    });
    expect(r.status).toBe(201);
    await plat.$executeRaw`UPDATE integration_outbox
                              SET status = 'IN_FLIGHT', attempt = attempt + 1, lease_id = gen_random_uuid(),
                                  lease_until = now() - interval '1 second'
                            WHERE id = ${cmd.id}::uuid`;
    const crashed = posts().length;
    await drain();
    // ยึดคืนแล้ว: ค้นก่อน — รู้แค่ใบแรก (KRS ค้นด้วย tmsVoucherNo ไม่ได้) → POST เฉพาะใบที่ขาด → KRS ตอบ 409 (มีอยู่แล้ว)
    expect(
      posts()
        .slice(crashed)
        .map((q) => q.status),
    ).toEqual([409]);
    expect(posts().length - before).toBe(4);
    const row = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(row).toMatchObject({ status: 'DONE', errorClass: 'DUPLICATE' });
    expect(row.lastError).toMatchObject({
      code: 'duplicate_unresolved',
      manualExternalIdRequired: true,
    });
    expect(
      mock.listInvoices().filter((i) => i.data.tmsVoucherNo === `${invoiceNo}-V7`),
    ).toHaveLength(1);
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'MISMATCH',
      externalId: part1.transactionNo,
    });
  });

  /**
   * ใบเดียวที่ KRS บันทึกแล้วแต่ผลหาย (สายหลุดหลังบันทึก) → จำลองว่า sync log ของครั้งนั้นได้ 201 (เช่น บันทึก mapping ล้มหลังได้คำตอบ)
   * `transactionNo` = เลขที่ใส่ใน response ของ sync log (ไม่ระบุ = เลขจริงใน KRS) · `truncate` = request body ใน sync log ถูกตัดท้าย
   */
  async function lostResult(lines: Line[], o: { transactionNo?: string; truncate?: boolean } = {}) {
    const inv = await draft(lines);
    mock.injectFault({ kind: 'reset-after-commit', method: 'POST', times: 1 });
    const invoiceNo = await finalize(inv);
    await drain();
    const got = mock.getInvoiceByTmsVoucherNo(invoiceNo)!;
    expect(got).toBeTruthy();
    const cmd = (await commands(inv.uuid)).find((c) => c.operation === 'PUSH_INVOICE')!;
    expect((await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } })).status).toBe(
      'FAILED_RETRYABLE',
    );
    const log = await plat.erpSyncLog.findFirstOrThrow({
      where: { outboxId: cmd.id, method: 'POST' },
    });
    await plat.erpSyncLog.update({
      where: { id: log.id },
      data: {
        statusCode: 201,
        errorCode: null,
        responseBody: JSON.stringify({
          transactionNo: o.transactionNo ?? got.transactionNo,
          voucherNo: got.voucherNo,
        }),
        ...(o.truncate ? { requestBody: log.requestBody!.slice(0, 80) } : {}),
      },
    });
    return { inv, invoiceNo, got, cmd };
  }
  const gets = () => mock.requests().filter((q) => q.method === 'GET').length;

  for (const truncate of [false, true])
    it(`ST8-T10: ผลหายแต่ sync log มี 201 พร้อมเลข KRS${truncate ? ' (review H1: request body ถูกตัด — ไม่รู้รายการของใบ)' : ''} → GET แล้วเทียบ: ตรง = SYNCED ไม่ POST ซ้ำ`, async () => {
      const d = await deliveryOrder('own');
      const before = posts().length;
      const { inv, got, cmd } = await lostResult(
        [{ doId: d.id, vat: 'EXEMPT_TRANSPORT', amount: truncate ? '1235.00' : '1234.00' }],
        { truncate },
      );
      const g = gets();
      await drain();
      expect(posts().length - before).toBe(1);
      // review H1: ต้อง GET ยืนยันก่อนเสมอ (ไม่เชื่อหลักฐานใน sync log อย่างเดียว)
      expect(gets() - g).toBe(1);
      const row = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } });
      expect(row.status).toBe('DONE');
      expect(row.result).toMatchObject({
        externalId: got.transactionNo,
        externalDocNo: got.voucherNo,
        applied: true,
        // ST8-T09: สายหลุดหลังต่อติด = AMBIGUOUS (docs/01 A.5) → ค้นก่อนส่งซ้ำ
        recoveredAfter: 'AMBIGUOUS',
      });
      expect(await mapping(inv.uuid)).toMatchObject({
        status: 'SYNCED',
        externalId: got.transactionNo,
        externalDocNo: got.voucherNo,
      });
      // GET อยู่ใน sync log — ไม่มีชื่อคนขับ / API key
      const logs = await plat.erpSyncLog.findMany({ where: { outboxId: cmd.id, method: 'GET' } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ statusCode: 200 });
      expect(JSON.stringify(logs)).not.toContain(DRIVER);
      expect(JSON.stringify(logs)).not.toContain(KEY);
    });

  it('review H1: รู้เลข KRS แต่รายการที่อ่านกลับไม่ครบ (KRS ทำรายการหาย) และไม่มีใบที่ต้องส่งเพิ่ม → ไม่ POST · ไม่ SYNCED (MISMATCH ไม่ยืนยันเนื้อหา)', async () => {
    const d1 = await deliveryOrder('own');
    const d2 = await deliveryOrder('own');
    const before = posts().length;
    const { inv, got, cmd } = await lostResult(
      [
        { doId: d1.id, vat: 'EXEMPT_TRANSPORT', amount: '410.00' },
        { doId: d2.id, vat: 'EXEMPT_TRANSPORT', amount: '420.00' },
      ],
      { truncate: true },
    );
    mock.overwriteInvoice(got.transactionNo, { keepLines: null, dropFlowNos: [d2.doNo!] });
    await drain();
    expect(posts().length - before).toBe(1);
    const row = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(row.status).toBe('DONE');
    expect(row.result).toMatchObject({ externalId: got.transactionNo, applied: false });
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'MISMATCH',
      externalId: got.transactionNo,
      lastSyncedHash: null,
      lastError: { code: 'erp_content_unverified' },
    });
  });

  it('review H2: เลข KRS ที่รู้จาก sync log แต่ GET ได้ 404 → ไม่ POST ใหม่ · FAILED_FINAL NOT_FOUND + mapping MISMATCH remote_missing + REMOTE_MISSING ให้คนตัดสิน', async () => {
    const d = await deliveryOrder('own');
    const before = posts().length;
    const { inv, cmd } = await lostResult(
      [{ doId: d.id, vat: 'EXEMPT_TRANSPORT', amount: '640.00' }],
      {
        transactionNo: '99999901',
      },
    );
    await drain();
    expect(posts().length - before).toBe(1);
    const row = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(row).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'NOT_FOUND' });
    expect(row.lastError).toMatchObject({ code: 'remote_missing' });
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'MISMATCH',
      externalId: '99999901',
      lastError: { code: 'remote_missing', errorClass: 'NOT_FOUND' },
    });
    expect(
      await plat.reconcileResult.count({ where: { tenantId, localId: inv.uuid } }),
    ).toBeGreaterThan(0);
  });

  it('review H2 (ใบที่แยก): ใบแรกที่รู้เลข (mapping) GET ได้ 404 → ไม่ POST ใบใดเลย ให้คนตัดสิน', async () => {
    mock.injectFault({ kind: 'status', status: 504, method: 'POST', skip: 1, times: 1 });
    const before = posts().length;
    const { inv } = await splitInvoice();
    await drain();
    expect(posts().length - before).toBe(2);
    const m = (await mapping(inv.uuid))!;
    const detail = m.detail as { documents: { externalId: string }[] };
    detail.documents[0]!.externalId = '99999902';
    await plat.externalMapping.update({
      where: { id: m.id },
      data: { detail, externalId: '99999902' },
    });
    await drain();
    expect(posts().length - before).toBe(2);
    const cmd = (await commands(inv.uuid)).find((c) => c.operation === 'PUSH_INVOICE')!;
    expect(await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } })).toMatchObject(
      {
        status: 'FAILED_FINAL',
        errorClass: 'NOT_FOUND',
      },
    );
    expect(await mapping(inv.uuid)).toMatchObject({
      status: 'MISMATCH',
      lastError: { code: 'remote_missing' },
    });
  });

  it('ST8-T10 (A.5 timeout/สายหลุด): ไม่รู้เลข KRS เลย → POST ใหม่ · ถึงแล้วได้ 409 → DUPLICATE ให้คนกรอก transactionNo (ไม่สร้างซ้ำ ไม่พักเงียบ)', async () => {
    const d = await deliveryOrder('own');
    const inv = await draft([{ doId: d.id, vat: 'EXEMPT_TRANSPORT', amount: '777.00' }]);
    mock.injectFault({ kind: 'reset-after-commit', method: 'POST', times: 1 });
    const before = posts().length;
    const invoiceNo = await finalize(inv);
    await drain();
    await drain();
    expect(
      posts()
        .slice(before)
        .map((q) => q.status),
    ).toEqual(['reset', 409]);
    expect(mock.listInvoices().filter((i) => i.data.tmsVoucherNo === invoiceNo)).toHaveLength(1);
    const cmd = (await commands(inv.uuid)).find((c) => c.operation === 'PUSH_INVOICE')!;
    const row = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(row).toMatchObject({ status: 'DONE', errorClass: 'DUPLICATE' });
    expect(row.lastError).toMatchObject({
      code: 'duplicate_unresolved',
      manualExternalIdRequired: true,
    });
    expect(await mapping(inv.uuid)).toMatchObject({ status: 'MISMATCH', externalId: null });
  });
});
