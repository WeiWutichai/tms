import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient, VatType } from '@prisma/client';
import { SYSTEM_ROLES } from '@tms/domain';
import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock';
import { encodeId, tryDecodeId } from '../src/common/ids';
import type { Tx } from '../src/db/db.service';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import { DocumentReconcileService } from '../src/modules/erp/document-reconcile.service';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { InvoicesService } from '../src/modules/invoices/invoices.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST8-T13 Fallback ใบลด/เพิ่มหนี้สำหรับ KRS (plan/01 ST8-T13; docs/01 A.2, A.5, A.6, §6.1; D-54 ภาพหลังปรับ = ยกเลิกแล้วออกใหม่)
 * เกณฑ์ตรวจรับ: ยกเลิกแล้วออกใหม่ใน TMS → mock ได้ PUT ยอดหลังปรับ · ใบที่ติดธง "ลงบัญชีแล้ว" ต้องมีผู้อนุมัติก่อนส่ง
 * + ใบที่แยก (D-69) = PUT ทีละใบ · แผนไม่ตรงกับใบที่มี = ไม่ส่ง · กันเขียนผิดใบ · กฎอายุ N วัน · สายการแทนที่ขาด = แจ้งบัญชี
 *
 * DO ในชุดนี้สร้างตรงในฐาน (เหมือน krs-a5-errors) → ตอน "ออกใหม่แทน" (`reissue: true`) ใช้ตัวดึง DO ของ test (คัดลอกบรรทัดของใบเดิม
 * พร้อมยอดที่ปรับ) แทนการตรวจความพร้อมวางบิล (ST5-T10 ตรวจแยกใน invoice-cancel.test) — ทางยกเลิก/ออกใหม่/ออกเลข/คิว/sink เป็นของจริง
 */

const KEY = 'krs-t13-test-key-41c0aa';

describe('ST8-T13 KRS replaceDocument (PUT ภาพหลังปรับ)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let dispatcher: OutboxDispatcher;
  let mock: MockKrs;
  let tenantId: string;
  let ppCompany: string;
  let ppBranch: string;
  let freight: string;
  let service: string;
  let admin: string;
  let accounting: string;
  let manager: string;
  let approver: string;
  let conId: string;
  let conUuid: string;
  let seq = 0;
  let custSeq = 0;
  const today = bangkokToday();
  const prevPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  const REASON = 'ราคาผิด ออกฉบับใหม่แทนตามที่ลูกค้าแจ้ง';
  /** ตัวดึง DO ของ test: บรรทัดของใบเดิม → ร่างใหม่ (lineNo → ยอดใหม่ · null = ไม่เอาบรรทัดนั้น) */
  let pullFrom: string | null = null;
  let pullAmounts: Record<number, string | null> = {};

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
  const puts = () => mock.requests().filter((q) => q.method === 'PUT');
  const posts = () => mock.requests().filter((q) => q.method === 'POST');
  const mapping = (localId: string) =>
    plat.externalMapping.findFirst({ where: { tenantId, entityType: 'INVOICE', localId } });
  const settleAll = async () => {
    mock.clearFaults();
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', done_at = now(), lease_id = NULL, lease_until = NULL
                            WHERE tenant_id = ${tenantId}::uuid AND status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
  };

  async function newCustomer() {
    const n = ++custSeq;
    const c = await plat.customer.create({
      data: {
        tenantId,
        code: `C-T13-${n}`,
        legalName: `บริษัท ลูกค้า T13 ${n} จำกัด`,
        taxId: validTaxId(9500 + n),
        branchCode: '00000',
        billingAddress: { line1: '9 ถ.ตัวอย่าง', province: 'ระยอง', postcode: '21000' },
      },
    });
    await api(app, admin)
      .put(`/v1/customers/${encodeId('customer', c.id)}/erp-codes/${conId}`)
      .send({ externalId: `PP-T13-${n}` })
      .expect(200);
    return c.id;
  }

  async function deliveryOrder(cust: string) {
    const tag = `T${++seq}`;
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
        vehiclePlateSnapshot: '70-1313',
        driverNameSnapshot: 'สมชาย คนขับ T13',
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

  const lineData = (vat: VatType, amount: string) => ({
    tenantId,
    serviceItemId: vat === 'VAT_7' ? service : freight,
    description: vat === 'VAT_7' ? 'ค่ายกขน' : 'ค่าขนส่ง',
    quantity: '1',
    unitLabel: 'เที่ยว',
    unitPrice: amount,
    amount,
    vatType: vat,
    vatAmount: vat === 'VAT_7' ? (Number(amount) * 0.07).toFixed(2) : '0',
    whtRate: vat === 'VAT_7' ? '3.00' : '1.00',
    doAnchor: true,
  });

  type Line = { vat: VatType; amount: string };
  /** ใบแจ้งหนี้ที่ออกเลขแล้ว (1 DO ต่อบรรทัด) → ส่งเข้า KRS (POST) */
  async function issuedInKrs(lines: Line[]) {
    const cust = await newCustomer();
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
            ...lineData(l.vat, l.amount),
            lineNo: i + 1,
            deliveryOrderId: dos[i]!.id,
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
    await drain();
    const m = await mapping(inv.id);
    expect(m, 'ใบเดิมต้องอยู่ใน KRS ก่อน').toMatchObject({ status: 'SYNCED' });
    return { uuid: inv.id, id, invoiceNo: r.body.invoiceNo as string, version: r.body.version };
  }

  /** ยกเลิกใบที่ออกแล้ว + ออกฉบับใหม่แทน (ST5-T10 `reissue: true`) — ผู้ยกเลิก = ผู้จัดการ */
  async function voidReissue(
    inv: { uuid: string; id: string },
    amounts: Record<number, string | null>,
  ) {
    const cur = (await api(app, admin).get(`/v1/invoices/${inv.id}`).expect(200)).body;
    pullFrom = inv.uuid;
    pullAmounts = amounts;
    const r = await api(app, manager)
      .post(`/v1/invoices/${inv.id}/void`)
      .set('If-Match', `"${cur.version}"`)
      .send({ reason: REASON, reissue: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    pullFrom = null;
    return r.body.replacedByInvoice.id as string;
  }

  /** ออกเลขร่างใหม่ (ผู้ออก = บัญชี — ผู้ยกเลิกออกร่างที่ตัวเองสร้างไม่ได้ A3) */
  async function finalize(id: string) {
    const d = (await api(app, admin).get(`/v1/invoices/${id}`).expect(200)).body;
    const r = await api(app, accounting)
      .post(`/v1/invoices/${id}/finalize`)
      .set('If-Match', `"${d.version}"`)
      .send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { uuid: tryDecodeId('invoice', id)!, id, invoiceNo: r.body.invoiceNo as string };
  }

  const replaceCmd = async (localId: string) =>
    (await commands(localId)).filter((c) => c.operation === 'REPLACE_DOCUMENT');
  const voidCmds = async (localId: string) =>
    (await commands(localId)).filter((c) => c.operation === 'VOID_DOCUMENT');
  const failedQueue = async () =>
    (await api(app, admin).get(`/v1/connectors/${conId}/queue?tab=failed`).expect(200)).body
      .data as {
      id: string;
      operation: string;
      errorCode: string | null;
      actions: Record<string, boolean>;
    }[];

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    await truncateAll();
    app = await bootApp();
    dispatcher = app.get(OutboxDispatcher);
    app.get(ErpAdapterRegistry).replace(new KrsAdapter({ allowPrivate: true }));
    mock = await startMockKrs({ apiKey: KEY });
    // ตัวดึง DO ของ test (ดูหัวไฟล์) — เฉพาะตอนออกฉบับใหม่แทนในชุดนี้
    const invoices = app.get(InvoicesService);
    const realPull = invoices.pull.bind(invoices);
    invoices.pull = async (tx: Tx, draftId: string, doIds: string[]) => {
      if (!pullFrom) return realPull(tx, draftId, doIds);
      const src = await tx.invoiceLine.findMany({
        where: { invoiceId: pullFrom, deliveryOrderId: { in: doIds } },
        orderBy: { lineNo: 'asc' },
      });
      let n = 0;
      for (const l of src) {
        const amt = l.lineNo in pullAmounts ? pullAmounts[l.lineNo] : l.amount.toFixed(2);
        if (amt === null || amt === undefined) continue;
        await tx.invoiceLine.create({
          data: {
            ...lineData(l.vatType, amt),
            invoiceId: draftId,
            lineNo: ++n,
            deliveryOrderId: l.deliveryOrderId,
          },
        });
      }
    };
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ขนส่ง T13 ทดสอบ จำกัด' })).id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    const c = await plat.company.create({
      data: { tenantId, legalName: 'บริษัท พีพี T13 จำกัด', taxId: validTaxId(9401) },
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
    freight = (await item('T13-FRT', 'EXEMPT_TRANSPORT', '1.00')).id;
    service = (await item('T13-LIFT', 'VAT_7', '3.00')).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    manager = await tokenFor(tenantId, SYSTEM_ROLES.manager.permissions.join(' '), 'u-mgr');
    approver = await tokenFor(tenantId, SYSTEM_ROLES.approver.permissions.join(' '), 'u-appr');
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
    // ST8-T13 replaceDocument ไม่ pending แล้ว — เปิดได้
    expect(r.body.capabilitiesPending).toEqual([]);
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
          'pushInvoice',
          'ownsDocumentNumber',
          'fetchDocument',
          'replaceDocument',
        ],
      });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  });
  beforeEach(async () => {
    await settleAll();
    app.get(Clock).set(null);
  });
  afterAll(async () => {
    app?.get(Clock).set(null);
    if (prevPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = prevPrivate;
    await mock?.stop();
    await app?.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: ยกเลิกแล้วออกใหม่ → mock ได้ PUT ยอดหลังปรับ (tmsVoucherNo เดิม · ไม่ POST ใบใหม่) · mapping ย้ายไปใบใหม่ · ใบเดิมไม่ต้องยกเลิกเอง', async () => {
    const a = await issuedInKrs([
      { vat: 'EXEMPT_TRANSPORT', amount: '1000.00' },
      { vat: 'EXEMPT_TRANSPORT', amount: '500.00' },
    ]);
    const txNo = (await mapping(a.uuid))!.externalId!;
    const nid = await voidReissue(a, { 1: '900.00' });
    const b = await finalize(nid);
    const [p0, q0] = [posts().length, puts().length];
    await drain();
    // ไม่ POST · PUT 1 ครั้งไปที่ transactionNo เดิม
    expect(posts().length - p0).toBe(0);
    expect(
      puts()
        .slice(q0)
        .map((q) => q.path),
    ).toEqual([`/api/invoice/${txNo}`]);
    const krs = mock.getInvoice(txNo)!;
    expect(krs.revision).toBe(2);
    expect(krs.data.tmsVoucherNo).toBe(a.invoiceNo);
    expect(krs.data.lines.map((l) => Number(l.unitPrice))).toEqual([900, 500]);
    // mapping: ใบเดิม RETIRED (ไม่มี hard delete) → ใบใหม่ SYNCED ด้วยเอกสาร KRS เดิม
    expect(await mapping(a.uuid)).toMatchObject({
      status: 'RETIRED',
      externalId: null,
      detail: expect.objectContaining({ reissuedTo: b.uuid, replacedExternalId: txNo }),
    });
    const mb = (await mapping(b.uuid))!;
    expect(mb).toMatchObject({ status: 'SYNCED', externalId: txNo, localNumber: b.invoiceNo });
    expect(mb.detail).toMatchObject({
      externalRef: a.invoiceNo,
      reissueOf: a.uuid,
      documents: [expect.objectContaining({ ref: a.invoiceNo, externalId: txNo })],
    });
    const [cmd] = await replaceCmd(b.uuid);
    expect(cmd).toMatchObject({ status: 'DONE' });
    expect(cmd!.result).toMatchObject({ replacedInvoiceId: a.uuid, applied: true });
    // ใบเดิม: คำสั่งแจ้งยกเลิก = ไม่ต้องทำมือ (ใบใหม่แทนที่แล้ว) · ไม่อยู่ในคิว "ล้มเหลว"
    const [v] = await voidCmds(a.uuid);
    expect(v).toMatchObject({ status: 'SKIPPED' });
    expect(v!.lastError).toMatchObject({ code: 'void_replaced_by_reissue' });
    expect((await failedQueue()).filter((x) => x.id === encodeId('outboxCommand', v!.id))).toEqual(
      [],
    );
    // sync log: GET (ยืนยันเลขอ้างอิง) + PUT · ไม่มี header/ชื่อคนขับ
    const logs = await plat.erpSyncLog.findMany({ where: { outboxId: cmd!.id } });
    expect(logs.map((l) => l.method).sort()).toEqual(['GET', 'PUT']);
    for (const l of logs) {
      expect(`${l.requestBody ?? ''}${l.responseBody ?? ''}`).not.toContain('สมชาย');
      expect(`${l.requestBody ?? ''}${l.responseBody ?? ''}`).not.toContain(KEY);
    }
    // GET ใบใหม่: เลขสองฝั่ง
    const g = (await api(app, admin).get(`/v1/invoices/${b.id}`).expect(200)).body;
    expect(g.sync).toMatchObject({ state: 'SYNCED', externalId: txNo, postedAt: null });
  });

  it('ใบที่แยกตาม vat_type (D-69): PUT ทีละใบด้วย tmsVoucherNo ของใบนั้น · ไม่สร้างใบใหม่', async () => {
    const a = await issuedInKrs([
      { vat: 'EXEMPT_TRANSPORT', amount: '1000.00' },
      { vat: 'VAT_7', amount: '300.00' },
    ]);
    const docs = (
      (await mapping(a.uuid))!.detail as { documents: { ref: string; externalId: string }[] }
    ).documents;
    expect(docs.map((d) => d.ref)).toEqual([a.invoiceNo, `${a.invoiceNo}-V7`]);
    const nid = await voidReissue(a, { 1: '800.00', 2: '250.00' });
    const b = await finalize(nid);
    const [p0, q0, n0] = [posts().length, puts().length, mock.listInvoices().length];
    await drain();
    expect(posts().length - p0).toBe(0);
    expect(mock.listInvoices().length).toBe(n0);
    expect(
      puts()
        .slice(q0)
        .map((q) => q.path),
    ).toEqual(docs.map((d) => `/api/invoice/${d.externalId}`));
    const ex = mock.getInvoice(docs[0]!.externalId)!;
    const v7 = mock.getInvoice(docs[1]!.externalId)!;
    expect(ex.data).toMatchObject({ tmsVoucherNo: a.invoiceNo });
    expect(ex.data.lines.map((l) => Number(l.unitPrice))).toEqual([800]);
    expect(v7.data).toMatchObject({ tmsVoucherNo: `${a.invoiceNo}-V7` });
    expect(v7.data.lines.map((l) => Number(l.unitPrice))).toEqual([250]);
    const mb = (await mapping(b.uuid))!;
    expect(mb.status).toBe('SYNCED');
    expect((mb.detail as { documents: { ref: string; externalId: string }[] }).documents).toEqual([
      expect.objectContaining({ ref: a.invoiceNo, externalId: docs[0]!.externalId }),
      expect.objectContaining({ ref: `${a.invoiceNo}-V7`, externalId: docs[1]!.externalId }),
    ]);
    // ST8-T11 AFTER_PUSH ของการแทนที่: อ่านกลับด้วยเลขอ้างอิงที่ KRS เห็น (เลขใบเดิม) → ตรง = ACCEPTED (ไม่ใช่ส่วนต่างเทียม)
    await app.get(DocumentReconcileService).scheduleAfterPush();
    await drain();
    expect(await mapping(b.uuid)).toMatchObject({ status: 'SYNCED', reconcileState: 'ACCEPTED' });
    expect(
      await plat.reconcileResult.count({ where: { tenantId, localId: b.uuid, resolvedAt: null } }),
    ).toBe(0);
  });

  it('แผนหลังปรับไม่ตรงกับใบที่มี (กลุ่ม VAT หาย) → VALIDATION ไม่ PUT ไม่ POST · ขึ้นคิวล้มเหลว', async () => {
    const a = await issuedInKrs([
      { vat: 'EXEMPT_TRANSPORT', amount: '1000.00' },
      { vat: 'VAT_7', amount: '300.00' },
    ]);
    const nid = await voidReissue(a, { 2: null });
    const b = await finalize(nid);
    const [p0, q0] = [posts().length, puts().length];
    await drain();
    expect(posts().length - p0).toBe(0);
    expect(puts().length - q0).toBe(0);
    const [cmd] = await replaceCmd(b.uuid);
    expect(cmd).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    expect(cmd!.lastError).toMatchObject({ code: 'krs_replace_plan_mismatch' });
    // ใบใหม่ไม่มี mapping (เอกสารยังเป็นของใบเดิม) · ใบเดิมยังมีเลข KRS
    expect(await mapping(b.uuid)).toBeNull();
    expect((await mapping(a.uuid))!.externalId).not.toBeNull();
    expect((await failedQueue()).some((x) => x.id === encodeId('outboxCommand', cmd!.id))).toBe(
      true,
    );
  });

  it('กันเขียนผิดใบ: เลขฝั่ง KRS ของใบเดิมชี้ไปใบที่ tmsVoucherNo ไม่ตรง → VALIDATION ไม่ PUT', async () => {
    const a = await issuedInKrs([{ vat: 'EXEMPT_TRANSPORT', amount: '700.00' }]);
    const other = await issuedInKrs([{ vat: 'EXEMPT_TRANSPORT', amount: '710.00' }]);
    const otherTx = (await mapping(other.uuid))!.externalId!;
    // mapping ของใบเดิมผิด (เช่น คนกรอกเลขผิดในอดีต) — ชี้ไปเอกสาร KRS ของอีกใบ
    await plat.externalMapping.update({
      where: { id: (await mapping(other.uuid))!.id },
      data: { externalId: null, status: 'RETIRED' },
    });
    await plat.externalMapping.update({
      where: { id: (await mapping(a.uuid))!.id },
      data: { externalId: otherTx },
    });
    const nid = await voidReissue(a, { 1: '650.00' });
    const b = await finalize(nid);
    const q0 = puts().length;
    await drain();
    expect(puts().length - q0).toBe(0);
    const [cmd] = await replaceCmd(b.uuid);
    expect(cmd).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    expect(cmd!.lastError).toMatchObject({ code: 'krs_ref_mismatch' });
    expect(mock.getInvoice(otherTx)!.revision).toBe(1);
  });

  it('เกณฑ์ตรวจรับ: ใบที่กด "ลงบัญชีแล้ว" ต้องมีผู้อนุมัติ (คนละคนกับผู้ขอ) ก่อนส่ง · อนุมัติแล้ว PUT', async () => {
    const a = await issuedInKrs([{ vat: 'EXEMPT_TRANSPORT', amount: '1200.00' }]);
    const txNo = (await mapping(a.uuid))!.externalId!;
    // ปุ่ม "ลงบัญชีแล้ว" — ผู้ดูอย่างเดียว/ไม่มีสิทธิ์ = 403 · บัญชีกดได้ · กดซ้ำ = คงเวลาเดิม
    await api(app, manager).post(`/v1/invoices/${a.id}/erp-posted`).send({}).expect(403);
    const mk = await api(app, accounting).post(`/v1/invoices/${a.id}/erp-posted`).send({});
    expect(mk.status, JSON.stringify(mk.body)).toBe(200);
    expect(mk.body.sync.postedAt).toEqual(expect.any(String));
    const again = await api(app, accounting).post(`/v1/invoices/${a.id}/erp-posted`).send({});
    expect(again.body.sync.postedAt).toBe(mk.body.sync.postedAt);
    expect(
      await plat.auditLog.count({
        where: { tenantId, action: 'invoice.erp_posted_marked', entityId: a.uuid },
      }),
    ).toBe(1);

    const nid = await voidReissue(a, { 1: '1100.00' });
    const b = await finalize(nid);
    const q0 = puts().length;
    await drain();
    expect(puts().length - q0).toBe(0);
    const [cmd] = await replaceCmd(b.uuid);
    expect(cmd).toMatchObject({ status: 'SKIPPED' });
    expect(cmd!.lastError).toMatchObject({ code: 'replace_requires_approval', posted: true });
    expect(cmd!.payload).toMatchObject({ requestedBy: expect.arrayContaining(['u-acc', 'u-mgr']) });
    const item = (await failedQueue()).find((x) => x.id === encodeId('outboxCommand', cmd!.id))!;
    expect(item.actions).toMatchObject({ approve: true, retry: false, skip: true });
    const url = `/v1/connectors/${conId}/queue/${encodeId('outboxCommand', cmd!.id)}/approve`;
    // ผู้ขอ (ผู้ยกเลิกใบเดิม) อนุมัติเองไม่ได้ · ไม่มีสิทธิ์อนุมัติ = 403 · เหตุผลสั้น = 422
    const self = await api(app, manager).post(url).send({ reason: 'ตรวจยอดหลังปรับแล้วถูกต้อง' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('erp_replace_self_approval');
    await api(app, accounting).post(url).send({ reason: 'ตรวจยอดหลังปรับแล้วถูกต้อง' }).expect(403);
    await api(app, approver).post(url).send({ reason: 'สั้น' }).expect(422);
    const ok = await api(app, approver).post(url).send({ reason: 'ตรวจยอดหลังปรับแล้วถูกต้อง' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.resolution).toMatchObject({
      kind: 'RETRIED',
      reason: 'ตรวจยอดหลังปรับแล้วถูกต้อง',
    });
    // อนุมัติซ้ำ = 409
    await api(app, approver).post(url).send({ reason: 'ตรวจยอดหลังปรับแล้วถูกต้อง' }).expect(409);
    expect(
      await plat.auditLog.findFirst({
        where: { tenantId, action: 'connector.queue_approved' },
        orderBy: { seq: 'desc' },
      }),
    ).toMatchObject({
      actorId: 'u-appr',
      reason: 'ตรวจยอดหลังปรับแล้วถูกต้อง',
      after: expect.objectContaining({ approvedBy: 'u-appr', replacedInvoiceId: a.id }),
    });
    await drain();
    expect(puts().length - q0).toBe(1);
    expect(mock.getInvoice(txNo)!.data.lines.map((l) => Number(l.unitPrice))).toEqual([1100]);
    const done = (await replaceCmd(b.uuid)).at(-1)!;
    expect(done).toMatchObject({ status: 'DONE' });
    expect(done.result).toMatchObject({ approvedBy: 'u-appr' });
    // ธง "ลงบัญชีแล้ว" ตามเอกสารไปที่ใบใหม่
    expect(await mapping(b.uuid)).toMatchObject({ status: 'SYNCED', postedAt: expect.any(Date) });
  });

  it('กฎอายุ N วัน (`billing.erpReplaceApprovalDays`, ค่าเริ่ม 0): ใบเดิมอายุเกิน → ต้องอนุมัติ · ตั้ง N ให้ครอบคลุม → ส่งได้', async () => {
    const a = await issuedInKrs([{ vat: 'EXEMPT_TRANSPORT', amount: '1300.00' }]);
    const nid = await voidReissue(a, { 1: '1250.00' });
    const b = await finalize(nid);
    // 3 วันหลังวันที่ใบ (นาฬิกาของระบบ)
    app.get(Clock).set(new Date(Date.now() + 3 * 86_400_000));
    await drain();
    const [cmd] = await replaceCmd(b.uuid);
    expect(cmd).toMatchObject({ status: 'SKIPPED' });
    expect(cmd!.lastError).toMatchObject({
      code: 'replace_requires_approval',
      posted: false,
      ageDays: 3,
      approvalAfterDays: 0,
    });
    app.get(Clock).set(null);

    const a2 = await issuedInKrs([{ vat: 'EXEMPT_TRANSPORT', amount: '1400.00' }]);
    // เลื่อนเกณฑ์ = คุมหลวมขึ้น → ต้อง step-up (ไม่ส่ง X-Step-Up = 403)
    const loose = await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'billing.erpReplaceApprovalDays': 5 } });
    expect(loose.status).toBe(403);
    expect(loose.body.code).toBe('step_up_required');
    await plat.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: 'billing.erpReplaceApprovalDays' } },
      create: { tenantId, key: 'billing.erpReplaceApprovalDays', value: 5 },
      update: { value: 5 },
    });
    try {
      const b2 = await finalize(await voidReissue(a2, { 1: '1350.00' }));
      app.get(Clock).set(new Date(Date.now() + 3 * 86_400_000));
      const q0 = puts().length;
      await drain();
      expect(puts().length - q0).toBe(1);
      expect((await replaceCmd(b2.uuid))[0]).toMatchObject({ status: 'DONE' });
    } finally {
      app.get(Clock).set(null);
      await plat.tenantSetting.update({
        where: { tenantId_key: { tenantId, key: 'billing.erpReplaceApprovalDays' } },
        data: { value: 0 },
      });
    }
  });

  it('สายการแทนที่ขาด: ยกเลิกร่างใบออกใหม่ → แจ้งบัญชียกเลิกเอกสารของใบเดิมใน KRS เอง (KRS-6 ทาง C — ไม่มี DELETE)', async () => {
    const a = await issuedInKrs([{ vat: 'EXEMPT_TRANSPORT', amount: '1500.00' }]);
    const nid = await voidReissue(a, {});
    await drain();
    // ระหว่างร่างใบใหม่ยังอยู่ = ไม่ต้องยกเลิกเอง
    expect((await voidCmds(a.uuid))[0]!.lastError).toMatchObject({
      code: 'void_replaced_by_reissue',
    });
    const d = (await api(app, admin).get(`/v1/invoices/${nid}`).expect(200)).body;
    await api(app, admin)
      .post(`/v1/invoices/${nid}/cancel`)
      .set('If-Match', `"${d.version}"`)
      .send({ reason: 'ลูกค้าไม่ต้องการใบใหม่แล้ว' })
      .expect(200);
    await drain();
    const vs = await voidCmds(a.uuid);
    expect(vs).toHaveLength(2);
    expect(vs[1]).toMatchObject({ status: 'SKIPPED' });
    expect(vs[1]!.lastError).toMatchObject({ code: 'void_manual_required' });
    expect((await failedQueue()).some((x) => x.id === encodeId('outboxCommand', vs[1]!.id))).toBe(
      true,
    );
  });

  it('ลูกค้าของใบใหม่ไม่ใช่ลูกค้าเดิม → ไม่ใช่การปรับใบ: POST ใบใหม่ + แจ้งบัญชียกเลิกใบเดิมเอง', async () => {
    const a = await issuedInKrs([{ vat: 'EXEMPT_TRANSPORT', amount: '1600.00' }]);
    const nid = await voidReissue(a, {});
    const other = await newCustomer();
    await plat.invoice.update({
      where: { id: tryDecodeId('invoice', nid)! },
      data: { customerId: other },
    });
    const b = await finalize(nid);
    const p0 = posts().length;
    await drain();
    expect(posts().length - p0).toBe(1);
    expect(await replaceCmd(b.uuid)).toEqual([]);
    expect(await mapping(b.uuid)).toMatchObject({ status: 'SYNCED' });
    const vs = await voidCmds(a.uuid);
    expect(vs.at(-1)!.lastError).toMatchObject({ code: 'void_manual_required' });
  });
});
