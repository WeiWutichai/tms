import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signStepUpToken } from '../src/auth/tokens';
import { JobQueue } from '../src/jobs/job-queue.service';
import { PdfRenderer } from '../src/pdf/pdf-renderer';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { InvoicePdfService } from '../src/modules/invoices/invoice-pdf.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import {
  api,
  bootApp,
  issuedTestFields,
  platform,
  tokenFor,
  truncateAll,
  validTaxId,
} from './helpers';

/**
 * ST5-T09 ออกเอกสาร (finalize) ใบแจ้งหนี้ — D-54: ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี (ไม่มี `tax_invoice_no`) · เกณฑ์ตรวจรับ:
 * finalize 20 ใบพร้อมกันเลขเรียงไม่ข้าม · PATCH หลัง finalize ได้ 409 · ลูกค้าไม่มีรหัสสาขา finalize ไม่ได้ · ไม่มีทางออก tax_invoice_no
 * + ห้ามบรรทัด provisional · ผู้ออกไม่จด VAT แต่มีบรรทัด VAT 7% · แบ่งหน้าที่ (A3) · snapshot · DO/บรรทัดรายได้ · audit + event · PDF
 */
describe('invoice finalize (ST5-T09)', { timeout: 900_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let companyId: string;
  let admin: string;
  let viewer: string;
  let invoicer: string;
  let accounting: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  let loading: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const NONE_REQ = { success: { fields: [] } };
  const addDays = (d: string, n: number) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ออกใบแจ้งหนี้' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล จำกัด', taxId: validTaxId(981) },
    });
    companyId = c.id;
    await db.branch.create({
      data: {
        tenantId,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
    admin = await tokenFor(tenantId);
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
    invoicer = await tokenFor(tenantId, SYSTEM_ROLES.invoicer.permissions.join(' '), 'u-inv');
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
    const si = await db.serviceItem.findFirstOrThrow({
      where: { tenantId, vatType: 'VAT_7', status: 'ACTIVE', deletedAt: null },
    });
    loading = encodeId('serviceItem', si.id);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    app
      .get(DbService)
      .withTenant(tenantId, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const newSite = async () =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  const newVehicle = async () => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `8${++seed % 10}-${String(5000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string };
    const n = ++seed;
    await api(app, admin)
      .post('/v1/drivers')
      .send({
        name: `คนขับ ${n}`,
        phone: `087-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    return v.id;
  };
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const post = (stop: string, action: string, min: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/stops/${stop}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra });

  const newCustomer = async () => {
    const body = (
      await api(app, admin)
        .post('/v1/customers')
        .send({
          legalName: `ลูกค้าออกบิล ${++seed}`,
          taxId: validTaxId(8800 + seed),
          branchCode: '00000',
          billingAddress: ADDR,
        })
        .expect(201)
    ).body as { id: string };
    await db.customer.update({
      where: { id: uuid('customer', body.id) },
      data: { podRequirements: NONE_REQ, paymentTermDays: 45 },
    });
    return body.id;
  };

  /** ลูกค้า → rate card 350/ตัน → SO 5 ตัน → DO → เที่ยว → ส่งสำเร็จ → ส่งบัญชี */
  const delivered = async (customer: string) => {
    const origin = await newSite();
    const dest = await newSite();
    const r = (
      await api(app, admin)
        .post('/v1/rate-cards')
        .send({
          customerId: customer,
          originId: origin,
          destinationId: dest,
          vehicleTypeId: vt6,
          validFrom: today,
          pricingModel: 'PER_TON',
          sellRate: '350',
        })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${r.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: uuid('customer', customer) },
      requestedDate: today,
      vehicleTypeId: uuid('vehicleType', vt6),
      stops: [
        { type: 'PICKUP', siteId: uuid('site', origin) },
        { type: 'DELIVERY', siteId: uuid('site', dest) },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: unitTon, weightKg: '5000' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    const doId = encodeId('deliveryOrder', d!.id);
    const vid = await newVehicle();
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [doId], vehicleId: vid })
        .expect(201)
    ).body;
    const a = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: vid, dispatch: true });
    if (a.status !== 200)
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: vid,
          dispatch: true,
          ruleKeys: a.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบออกใบแจ้งหนี้',
        })
        .expect(200);
    const full = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    const [pickup, drop] = [...full.stops].sort(
      (x: { sequence: number }, y: { sequence: number }) => x.sequence - y.sequence,
    );
    await post(pickup.id, 'arrive', 60).expect(201);
    await post(pickup.id, 'complete', 55, { outcome: 'DELIVERED' }).expect(201);
    await post(drop.id, 'arrive', 20).expect(201);
    await post(drop.id, 'complete', 10, { outcome: 'DELIVERED' }).expect(201);
    await api(app, admin).post(`/v1/delivery-orders/${doId}/release`).send({}).expect(200);
    return { doId, uuid: d!.id, soId: so.id };
  };
  /** ร่างของผู้ออกบิล (invoicer) จาก DO */
  const draft = async (customer: string, doIds: string[]) =>
    (
      await api(app, invoicer)
        .post('/v1/invoices')
        .send({ customerId: customer, deliveryOrderIds: doIds })
        .expect(201)
    ).body as { id: string; version: number } & Record<string, any>;
  const finalize = (id: string, version: number | null, token = accounting) => {
    const r = api(app, token).post(`/v1/invoices/${id}/finalize`);
    return version === null ? r : r.set('If-Match', `"${version}"`);
  };
  const getInv = async (id: string) =>
    (await api(app, admin).get(`/v1/invoices/${id}`).expect(200)).body as Record<string, any>;
  const NO_RE = /^INV-00000-(\d{4})-(\d{4})$/;

  it('เกณฑ์ตรวจรับ: finalize 20 ใบพร้อมกัน → เลขเรียงไม่ข้าม ไม่ซ้ำ (row lock) + PDF ครบ', async () => {
    const cus = await newCustomer();
    const drafts = [];
    for (let i = 0; i < 20; i++) drafts.push(await draft(cus, [(await delivered(cus)).doId]));
    const rs = await Promise.all(drafts.map((d) => finalize(d.id, d.version)));
    expect(rs.map((r) => r.status)).toEqual(rs.map(() => 200));
    const nos = rs.map((r) => r.body.invoiceNo as string);
    expect(new Set(nos).size).toBe(20);
    const seq = nos.map((n) => Number(NO_RE.exec(n)![2])).sort((a, b) => a - b);
    // ชุดเลขใหม่ของ tenant นี้: 1..20 ต่อเนื่อง
    expect(seq).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // งวด (ปีเดือนตามเวลาไทย) เดียวกันทุกใบ
    expect(new Set(nos.map((n) => NO_RE.exec(n)![1])).size).toBe(1);
    for (const r of rs) {
      expect(r.body.status).toBe('ISSUED');
      expect(r.headers.etag).toBe(`"${r.body.version}"`);
    }
    // PDF ต้นฉบับครบทุกใบ — render ทันทีหลังออก หรือ (เครื่องโหลดสูง คิว render เต็ม) งาน invoice.render_pdf ที่ enqueue ตอนออกเลข
    const queue = app.get(JobQueue);
    while (await queue.runOnce());
    for (const r of rs)
      expect((await getInv(r.body.id)).pdf).toMatchObject({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
  });

  it('ออกเอกสาร: snapshot · วันที่ออก/ครบกำหนด · DO INVOICED+BILLED · ล็อกบรรทัดรายได้ · audit + event (outbox) · ไม่มี tax_invoice_no', async () => {
    const cus = await newCustomer();
    const d1 = await delivered(cus);
    const d2 = await delivered(cus);
    const inv = await draft(cus, [d1.doId, d2.doId]);
    const eventsBefore = await db.domainEvent.count({
      where: { tenantId, type: 'invoice.finalized' },
    });
    const r = await finalize(inv.id, inv.version).expect(200);
    const out = r.body;
    expect(out).toMatchObject({
      status: 'ISSUED',
      invoiceNo: expect.stringMatching(NO_RE),
      issueDate: today,
      dueDate: addDays(today, 45),
      issuedBy: 'u-acc',
      version: inv.version + 1,
      deliveryOrderCount: 2,
      taxEstimated: true,
      sellTotal: '3500.00',
      customer: { branchCode: '00000' },
    });
    expect(out.issuedAt).toBeTruthy();
    // D-54: ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี — ไม่มีเลขใบกำกับภาษีทั้งใน API และในฐานข้อมูล
    expect(Object.keys(out).filter((k) => /taxInvoice/i.test(k))).toEqual([]);
    const cols = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'invoice' AND column_name LIKE '%tax_invoice%'`;
    expect(cols).toEqual([]);
    // DO: billing_status INVOICED + invoiced_at · status UNBILLED → BILLED
    for (const d of [d1, d2]) {
      const row = await db.deliveryOrder.findUniqueOrThrow({ where: { id: d.uuid } });
      expect(row.billingStatus).toBe('INVOICED');
      expect(row.invoicedAt).not.toBeNull();
      expect(row.status).toBe('BILLED');
    }
    // บรรทัดรายได้ล็อกกับใบนี้ (ไม่ rebuild หลัง finalize)
    const iid = uuid('invoice', inv.id);
    const lines = await db.invoiceLine.findMany({ where: { invoiceId: iid, active: true } });
    const rls = await db.revenueLine.findMany({
      where: { id: { in: lines.map((l) => l.revenueLineId!) } },
    });
    expect(rls.length).toBeGreaterThan(0);
    for (const rl of rls) {
      expect(rl.lockedDocumentId).toBe(iid);
      expect(rl.lockedAt).not.toBeNull();
    }
    // audit + event ใน transaction เดียว (outbox) — payload ไม่มียอดเงิน
    const audit = await db.auditLog.findFirstOrThrow({
      where: { tenantId, action: 'invoice.finalized', entityId: iid },
    });
    expect(audit.after).toMatchObject({
      status: 'ISSUED',
      invoiceNo: out.invoiceNo,
      deliveryOrdersInvoiced: 2,
      deliveryOrdersBilled: 2,
      selfFinalized: false,
    });
    expect(await db.domainEvent.count({ where: { tenantId, type: 'invoice.finalized' } })).toBe(
      eventsBefore + 1,
    );
    const ev = await db.domainEvent.findFirstOrThrow({
      where: { tenantId, type: 'invoice.finalized', localId: iid },
    });
    expect(ev.snapshot).toMatchObject({ id: inv.id, status: 'ISSUED', invoiceNo: out.invoiceNo });
    expect(JSON.stringify(ev.snapshot)).not.toMatch(/"sell\w*"/);
    // snapshot ลูกค้า: เปลี่ยนชื่อลูกค้าภายหลัง → ใบที่ออกแล้วยังเป็นชื่อเดิม (API + ข้อมูลพิมพ์)
    const before = out.customer.legalName;
    await db.customer.update({
      where: { id: uuid('customer', cus) },
      data: { legalName: 'ชื่อใหม่หลังออกใบ' },
    });
    expect((await getInv(inv.id)).customer.legalName).toBe(before);
    const { model } = await run((tx) =>
      app.get(InvoicePdfService).loadModel(tx, iid, {
        issueDate: out.issueDate,
        dueDate: out.dueDate,
        copy: 'COPY',
      }),
    );
    expect(model).toMatchObject({
      invoiceNo: out.invoiceNo,
      issueDate: today,
      customer: { name: before, branchCode: '00000' },
    });
  });

  it('PDF ที่เก็บ ณ วันออก: ต้นฉบับ = ไฟล์เดิม (hash ตรง) · สำเนา render ครั้งเดียวแล้วเก็บ · ร่าง → 409', async () => {
    const cus = await newCustomer();
    const inv = await draft(cus, [(await delivered(cus)).doId]);
    await api(app, admin).get(`/v1/invoices/${inv.id}/pdf`).expect(409);
    const out = (await finalize(inv.id, inv.version).expect(200)).body;
    const orig = await api(app, admin).get(`/v1/invoices/${inv.id}/pdf`).expect(200);
    expect(orig.headers['content-type']).toMatch(/application\/pdf/);
    expect(orig.headers['x-content-sha256']).toBe(out.pdf.sha256);
    expect(orig.body.subarray(0, 4).toString()).toBe('%PDF');
    const c1 = await api(app, admin).get(`/v1/invoices/${inv.id}/pdf?copy=COPY`).expect(200);
    const c2 = await api(app, admin).get(`/v1/invoices/${inv.id}/pdf?copy=COPY`).expect(200);
    expect(c1.headers['x-content-sha256']).not.toBe(out.pdf.sha256);
    expect(c2.headers['x-content-sha256']).toBe(c1.headers['x-content-sha256']);
    const docs = await db.storedDocument.findMany({
      where: { tenantId, entityType: 'invoice', entityId: uuid('invoice', inv.id) },
    });
    expect(docs.map((d) => (d.metadata as { copy: string }).copy).sort()).toEqual([
      'COPY',
      'ORIGINAL',
    ]);
    // pro forma ของใบที่ออกแล้ว → 409 · ไม่มีสิทธิ์ราคา → 403
    await api(app, admin).get(`/v1/invoices/${inv.id}/proforma`).expect(409);
    const noPrice = await tokenFor(tenantId, 'invoices:read', 'u-noprice');
    await api(app, noPrice).get(`/v1/invoices/${inv.id}/pdf`).expect(403);
  });

  it('เกณฑ์ตรวจรับ: หลัง finalize ไม่มี PATCH (409) · แก้บรรทัด/ยกเลิกร่าง/ออกซ้ำ 409 · ฐานข้อมูลกันแก้หัวใบ/เลข', async () => {
    const cus = await newCustomer();
    const inv = await draft(cus, [(await delivered(cus)).doId]);
    const out = (await finalize(inv.id, inv.version).expect(200)).body;
    const im = { 'If-Match': `"${out.version}"` };
    const p = await api(app, invoicer)
      .patch(`/v1/invoices/${inv.id}`)
      .set(im)
      .send({ note: 'แก้หลังออก' })
      .expect(409);
    expect(p.body).toMatchObject({ code: 'invalid_state_transition', currentStatus: 'ISSUED' });
    await api(app, invoicer)
      .post(`/v1/invoices/${inv.id}/lines`)
      .set(im)
      .send({
        serviceItemId: loading,
        quantity: '1',
        sellUnitPrice: '10.00',
        reason: 'เพิ่มหลังออกใบ',
      })
      .expect(409);
    await api(app, invoicer)
      .post(`/v1/invoices/${inv.id}/cancel`)
      .set(im)
      .send({ reason: 'ยกเลิกใบที่ออกแล้วตรงนี้ไม่ได้' })
      .expect(409);
    await finalize(inv.id, out.version).expect(409);
    const iid = uuid('invoice', inv.id);
    await expect(
      run((tx) => tx.invoice.update({ where: { id: iid }, data: { note: 'แอบแก้' } })),
    ).rejects.toThrow(/content cannot change/);
    await expect(
      run((tx) => tx.invoice.update({ where: { id: iid }, data: { invoiceNo: 'INV-X' } })),
    ).rejects.toThrow(/invoice_no is assigned only when a draft is finalized/);
    await expect(
      run((tx) => tx.invoice.update({ where: { id: iid }, data: { totalAmount: '1.00' } })),
    ).rejects.toThrow(/content cannot change/);
    // ร่างข้ามไปสถานะอื่นที่ไม่ใช่ ISSUED/CANCELLED ไม่ได้ · ออกเลขโดยไม่มีข้อมูล ณ วันออก ไม่ได้
    const d2 = await draft(cus, [(await delivered(cus)).doId]);
    const d2id = uuid('invoice', d2.id);
    await expect(
      run((tx) => tx.invoice.update({ where: { id: d2id }, data: { status: 'PAID' } })),
    ).rejects.toThrow(/is not allowed \(finalize first\)/);
    await expect(
      run((tx) =>
        tx.invoice.update({ where: { id: d2id }, data: { status: 'ISSUED', invoiceNo: 'INV-Y' } }),
      ),
    ).rejects.toThrow(/invoice_issued_fields_check/);
  });

  it('เกณฑ์ตรวจรับ: ตรวจก่อนออก (409 `invoice_not_finalizable`) — ไม่มีรหัสสาขา/เลขผู้เสียภาษี · บรรทัด provisional · ผู้ออกไม่จด VAT + VAT 7% · ไม่กินเลข', async () => {
    const cus = await newCustomer();
    const d = await delivered(cus);
    const inv = await draft(cus, [d.doId]);
    const cid = uuid('customer', cus);
    const seqBefore = await db.documentSequence.findMany({ where: { tenantId, docType: 'INV' } });
    // ลูกค้าไม่มีรหัสสาขา
    await db.customer.update({ where: { id: cid }, data: { branchCode: null } });
    let r = await finalize(inv.id, inv.version).expect(409);
    expect(r.body).toMatchObject({
      code: 'invoice_not_finalizable',
      reasons: ['customer_branch_missing'],
    });
    await db.customer.update({ where: { id: cid }, data: { taxId: null } });
    r = await finalize(inv.id, inv.version).expect(409);
    expect(r.body.reasons).toEqual(['customer_tax_id_missing', 'customer_branch_missing']);
    await db.customer.update({
      where: { id: cid },
      data: { taxId: validTaxId(8800 + ++seed), branchCode: '00001' },
    });
    // บรรทัดรายได้ provisional (ยอดยังไม่ยืนยัน — ST5-T01b review)
    const line = await db.invoiceLine.findFirstOrThrow({
      where: { invoiceId: uuid('invoice', inv.id), active: true, revenueLineId: { not: null } },
    });
    await db.revenueLine.update({
      where: { id: line.revenueLineId! },
      data: { provisional: true },
    });
    r = await finalize(inv.id, inv.version).expect(409);
    expect(r.body).toMatchObject({
      reasons: ['revenue_line_provisional'],
      lines: [
        {
          id: encodeId('invoiceLine', line.id),
          revenueLineId: encodeId('revenueLine', line.revenueLineId!),
        },
      ],
    });
    await db.revenueLine.update({
      where: { id: line.revenueLineId! },
      data: { provisional: false },
    });
    // ผู้ออกไม่จด VAT แต่มีบรรทัด VAT 7% (BIL-038 · คำถามนักบัญชี #63)
    const added = (
      await api(app, invoicer)
        .post(`/v1/invoices/${inv.id}/lines`)
        .set('If-Match', `"${inv.version}"`)
        .send({
          serviceItemId: loading,
          quantity: '1',
          sellUnitPrice: '200.00',
          reason: 'ค่ายกขนตามที่ลูกค้าตกลง',
        })
        .expect(200)
    ).body;
    await db.company.update({ where: { id: companyId }, data: { vatRegistered: false } });
    try {
      r = await finalize(inv.id, added.version).expect(409);
      expect(r.body.reasons).toEqual(['issuer_not_vat_registered']);
    } finally {
      await db.company.update({ where: { id: companyId }, data: { vatRegistered: true } });
    }
    // ไม่มีการออกเลข/เปลี่ยนสถานะระหว่างที่ถูกบล็อก (rollback = ไม่กินเลข)
    expect(await getInv(inv.id)).toMatchObject({ status: 'DRAFT', invoiceNo: null });
    expect(await db.documentSequence.findMany({ where: { tenantId, docType: 'INV' } })).toEqual(
      seqBefore,
    );
    const ok = await finalize(inv.id, added.version).expect(200);
    expect(ok.body.customer).toMatchObject({ branchCode: '00001' });
  });

  it('แบ่งหน้าที่ (A3): ผู้สร้าง/ผู้แก้ร่างล่าสุดออกเองไม่ได้ (403) · tenant ปิดกฎ → ออกได้ + audit selfFinalized', async () => {
    const cus = await newCustomer();
    const inv = await draft(cus, [(await delivered(cus)).doId]);
    const self = await finalize(inv.id, inv.version, invoicer).expect(403);
    expect(self.body.code).toBe('invoice_self_finalize');
    // ผู้แก้ร่างล่าสุด (accounting แก้หมายเหตุ) ก็ออกเองไม่ได้
    const edited = (
      await api(app, accounting)
        .patch(`/v1/invoices/${inv.id}`)
        .set('If-Match', `"${inv.version}"`)
        .send({ note: 'ตรวจแล้ว' })
        .expect(200)
    ).body;
    await finalize(inv.id, edited.version, accounting).expect(403);
    // ปิดกฎ (owner ยอมรับความเสี่ยง) → ผู้สร้างออกเองได้
    const key = { tenantId_key: { tenantId, key: 'billing.allowSelfFinalize' } };
    await db.tenantSetting.upsert({
      where: key,
      create: { tenantId, key: 'billing.allowSelfFinalize', value: true },
      update: { value: true },
    });
    try {
      await finalize(inv.id, edited.version, accounting).expect(200);
      const a = await db.auditLog.findFirstOrThrow({
        where: { tenantId, action: 'invoice.finalized', entityId: uuid('invoice', inv.id) },
      });
      expect(a.after).toMatchObject({ selfFinalized: true });
    } finally {
      await db.tenantSetting.update({ where: key, data: { value: false } });
    }
  });

  it('If-Match บังคับ (422 / 412) · สิทธิ์ `invoices:finalize` (viewer 403) · ข้าม tenant 404', async () => {
    const cus = await newCustomer();
    const inv = await draft(cus, [(await delivered(cus)).doId]);
    const m = await finalize(inv.id, null).expect(422);
    expect(m.body.errors[0]).toMatchObject({ field: 'If-Match', code: 'if_match_required' });
    await finalize(inv.id, inv.version + 5).expect(412);
    await finalize(inv.id, inv.version, viewer).expect(403);
    const other = (await createTenantWithDefaults(db, { name: 'บริษัทอื่น' })).id;
    const otherToken = await tokenFor(other);
    await finalize(inv.id, inv.version, otherToken).expect(404);
    expect(await getInv(inv.id)).toMatchObject({ status: 'DRAFT', invoiceNo: null });
  });

  it('review M1: render PDF ล้มหลังออกเลข → ใบยัง ISSUED (pdf null) + งาน invoice.render_pdf ใน transaction เดียวกัน ลองใหม่จนเก็บได้ · แม่แบบเปลี่ยน → 409', async () => {
    const cus = await newCustomer();
    const inv = await draft(cus, [(await delivered(cus)).doId]);
    const renderer = app.get(PdfRenderer);
    const spy = vi.spyOn(renderer, 'pdf').mockRejectedValueOnce(new Error('chromium crashed'));
    const out = (await finalize(inv.id, inv.version).expect(200)).body;
    spy.mockRestore();
    expect(out).toMatchObject({ status: 'ISSUED', pdf: null });
    const iid = uuid('invoice', inv.id);
    const job = await db.job.findFirstOrThrow({
      where: {
        tenantId,
        type: 'invoice.render_pdf',
        payload: { path: ['invoiceId'], equals: iid },
      },
    });
    expect(job.status).toBe('PENDING');
    const queue = app.get(JobQueue);
    while (await queue.runOnce());
    const after = await getInv(inv.id);
    expect(after.pdf).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    // ใบที่บันทึกแม่แบบรุ่นอื่น (จำลองแม่แบบเปลี่ยนหลังวันออก) → ไม่ render ใหม่เงียบ ๆ
    const d2 = await draft(cus, [(await delivered(cus)).doId]);
    await db.invoice.update({
      where: { id: uuid('invoice', d2.id) },
      data: {
        status: 'ISSUED',
        ...issuedTestFields(`INV-OLD-${seed}`),
        printOptions: { yearStyle: 'BE', whtMinimumAmount: 0, templateVersion: 0 },
      },
    });
    const r = await api(app, admin).get(`/v1/invoices/${d2.id}/pdf`).expect(409);
    expect(r.body).toMatchObject({
      code: 'invoice_pdf_template_changed',
      issuedTemplateVersion: 0,
    });
  });

  it('review M2: ออกใบตอน DO ยังรอหลักฐาน (ลูกค้าไม่บังคับหลักฐานก่อนวางบิล) → บันทึกหลักฐานครบภายหลัง → BILLED (ไม่ค้าง UNBILLED)', async () => {
    const cus = await newCustomer();
    await db.customer.update({
      where: { id: uuid('customer', cus) },
      data: {
        requirePodToBill: false,
        podRequirements: { success: { fields: [{ type: 'NOTE', level: 'REQUIRED' }] } },
      },
    });
    const d = await delivered(cus);
    const before = await db.deliveryOrder.findUniqueOrThrow({ where: { id: d.uuid } });
    expect(['DELIVERED', 'POD_PENDING']).toContain(before.status);
    const inv = await draft(cus, [d.doId]);
    await finalize(inv.id, inv.version).expect(200);
    let row = await db.deliveryOrder.findUniqueOrThrow({ where: { id: d.uuid } });
    expect(row).toMatchObject({ status: before.status, billingStatus: 'INVOICED' });
    await api(app, admin)
      .put(`/v1/delivery-orders/${d.doId}/pod`)
      .send({ receiverName: 'สมชาย ใจดี', receiverRelation: 'SELF', note: 'วางไว้หน้าร้าน' })
      .expect(200);
    row = await db.deliveryOrder.findUniqueOrThrow({ where: { id: d.uuid } });
    expect(row).toMatchObject({ status: 'BILLED', billingStatus: 'INVOICED' });
  });

  it('review L4: sandbox → 409 · API key = ผู้ออก key (แบ่งหน้าที่) · เปิด billing.allowSelfFinalize เฉพาะ owner + step-up', async () => {
    // sandbox ของบริษัทนี้ (ร่างสร้างตรงในฐาน — ออกเลขไม่ได้จนกว่าจะตัดสิน [OPEN])
    const sb = await db.tenant.create({
      data: { name: 'sandbox ออกบิล', mode: 'test', liveTenantId: tenantId },
    });
    const sc = await db.company.create({
      data: { tenantId: sb.id, legalName: 'Co sandbox', taxId: validTaxId(991) },
    });
    const sbr = await db.branch.create({
      data: {
        tenantId: sb.id,
        companyId: sc.id,
        branchCode: '00000',
        branchLabel: 'HQ',
        address: ADDR,
      },
    });
    const scus = await db.customer.create({
      data: {
        tenantId: sb.id,
        code: 'SB-1',
        legalName: 'ลูกค้า sandbox',
        taxId: validTaxId(992),
        branchCode: '00000',
      },
    });
    const sinv = await db.invoice.create({
      data: {
        tenantId: sb.id,
        customerId: scus.id,
        issuingCompanyId: sc.id,
        issuingBranchId: sbr.id,
      },
    });
    const sr = await finalize(encodeId('invoice', sinv.id), 1, await tokenFor(sb.id)).expect(409);
    expect(sr.body.code).toBe('sandbox_finalize_disabled');

    // ผู้ใช้จริง (uuid) สร้างร่าง แล้วออก API key ของตัวเอง → key ออกใบนั้นไม่ได้ (key = ผู้ออก key)
    const u = await db.appUser.create({
      data: { tenantId, email: `inv-${seed}@finalize.test`, name: 'ผู้ออกบิล', status: 'ACTIVE' },
    });
    const ut = await tokenFor(tenantId, '*', u.id);
    const cus = await newCustomer();
    const d = await delivered(cus);
    const inv = (
      await api(app, ut)
        .post('/v1/invoices')
        .send({ customerId: cus, deliveryOrderIds: [d.doId] })
        .expect(201)
    ).body;
    const key = (
      await api(app, ut)
        .post('/v1/api-keys')
        .send({ name: 'ERP ออกบิล', scopes: ['invoices:read', 'invoices:finalize'] })
        .expect(201)
    ).body.secret as string;
    const kr = await api(app, key)
      .post(`/v1/invoices/${inv.id}/finalize`)
      .set('If-Match', `"${inv.version}"`)
      .expect(403);
    expect(kr.body.code).toBe('invoice_self_finalize');

    // ค่าตั้ง: admin (ไม่ใช่ owner) เปลี่ยนไม่ได้ · owner ต้อง step-up · ปิดกลับไม่ต้อง step-up
    const ownerRole = await db.role.findFirstOrThrow({ where: { tenantId, code: 'owner' } });
    const o = await db.appUser.create({
      data: { tenantId, email: `owner-${seed}@finalize.test`, name: 'เจ้าของ', status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId, userId: o.id, roleId: ownerRole.id } });
    const ot = await tokenFor(tenantId, '*', o.id);
    const on = { values: { 'billing.allowSelfFinalize': true } };
    const na = await api(app, admin).patch('/v1/settings').send(on).expect(403);
    expect(na.body.code).toBe('permission_denied');
    const ns = await api(app, ot).patch('/v1/settings').send(on).expect(403);
    expect(ns.body.code).toBe('step_up_required');
    await api(app, ot)
      .patch('/v1/settings')
      .set('X-Step-Up', await signStepUpToken(o.id, tenantId))
      .send(on)
      .expect(200);
    // เปิดแล้ว: key ของผู้สร้างออกใบได้ (audit selfFinalized)
    await api(app, key)
      .post(`/v1/invoices/${inv.id}/finalize`)
      .set('If-Match', `"${inv.version}"`)
      .expect(200);
    await api(app, ot)
      .patch('/v1/settings')
      .send({ values: { 'billing.allowSelfFinalize': false } })
      .expect(200);
  });
});
