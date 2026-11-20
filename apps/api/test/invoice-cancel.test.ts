import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/jobs/job-queue.service';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { invoiceDocument } from '../src/modules/invoices/invoice.template';
import { sampleInvoiceExempt } from '../src/modules/invoices/invoice.sample';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST5-T10 ยกเลิกใบแจ้งหนี้ (D-54 บัญชีเบา — ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี) · เกณฑ์ตรวจรับ: ยกเลิกแล้ว record และเลขยังอยู่ สถานะ CANCELLED ·
 * เลขนั้นไม่ถูกใช้ซ้ำ · DO กลับมาวางบิลใหม่ได้ · ใบในใบวางบิล ISSUED/COLLECTED → 409 บอกเลขใบวางบิล (ST5-T11 review M2) ·
 * รับชำระแล้ว → 409 (ST5-T13) · ปลดล็อกบรรทัดรายได้ (ST5-T09) · ออกฉบับใหม่แทนอ้างเลขเดิม · PDF ลายน้ำ "ยกเลิก" · event `invoice.voided`
 */
describe('invoice cancel (ST5-T10)', { timeout: 900_000 }, () => {
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ยกเลิกใบแจ้งหนี้' })).id;
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

  const cancel = (
    id: string,
    version: number | null,
    body: object = { reason: 'ลูกค้าแจ้งชื่อบริษัทผิด ขอออกใหม่' },
    token = accounting,
  ) => {
    const r = api(app, token).post(`/v1/invoices/${id}/void`);
    return (version === null ? r : r.set('If-Match', `"${version}"`)).send(body);
  };
  /** ร่าง (invoicer) → ออกเอกสาร (accounting — แบ่งหน้าที่) */
  const issued = async (cus: string, doIds: string[]) => {
    const d = await draft(cus, doIds);
    return (await finalize(d.id, d.version).expect(200)).body as Record<string, any>;
  };

  it('เกณฑ์ตรวจรับ: ยกเลิกใบที่ออกแล้ว → CANCELLED คงเลข · DO กลับวางบิลใหม่ได้ · ปลดล็อกบรรทัดรายได้ · เลขเดิมไม่ถูกใช้ซ้ำ · audit + event', async () => {
    const cus = await newCustomer();
    const d1 = await delivered(cus);
    const inv = await issued(cus, [d1.doId]);
    const iid = uuid('invoice', inv.id);
    const before = await db.revenueLine.findMany({ where: { lockedDocumentId: iid } });
    expect(before.length).toBeGreaterThan(0);

    const r = await cancel(inv.id, inv.version).expect(200);
    expect(r.headers.etag).toBe(`"${r.body.version}"`);
    expect(r.body).toMatchObject({
      status: 'CANCELLED',
      invoiceNo: inv.invoiceNo,
      issueDate: inv.issueDate,
      cancelReason: 'ลูกค้าแจ้งชื่อบริษัทผิด ขอออกใหม่',
      cancelledAt: expect.any(String),
      deliveryOrderCount: 1,
      sellTotal: inv.sellTotal,
      sellOutstanding: '0.00',
      replacedByInvoice: null,
      version: inv.version + 1,
    });
    // ใบที่ยกเลิกยังแสดงรายการเดิม (บรรทัดของเอกสาร ณ วันยกเลิก) แต่ไม่นับเป็นการวางบิลแล้ว
    expect(r.body.deliveryOrders.map((d: { doNo: string }) => d.doNo)).toHaveLength(1);
    expect(r.body.printLines.length).toBeGreaterThan(0);
    const lines = await db.invoiceLine.findMany({ where: { invoiceId: iid } });
    expect(lines.every((l) => !l.active && l.releasedWithInvoice)).toBe(true);
    // DO: INVOICED → UNBILLED · BILLED → UNBILLED · invoiced_at ล้าง
    const row = await db.deliveryOrder.findUniqueOrThrow({ where: { id: d1.uuid } });
    expect(row).toMatchObject({ billingStatus: 'UNBILLED', status: 'UNBILLED', invoicedAt: null });
    // บรรทัดรายได้ปลดล็อก (audit ต่อใบสั่งจาก tms_revenue_line_unlock)
    expect(await db.revenueLine.count({ where: { lockedDocumentId: iid } })).toBe(0);
    expect(
      await db.auditLog.count({
        where: { tenantId, action: 'sales_order.revenue_lines_unlocked', entityId: d1.soId },
      }),
    ).toBe(1);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { tenantId, action: 'invoice.cancelled', entityId: iid },
    });
    expect(audit.reason).toBe('ลูกค้าแจ้งชื่อบริษัทผิด ขอออกใหม่');
    expect(audit.after).toMatchObject({
      status: 'CANCELLED',
      invoiceNo: inv.invoiceNo,
      deliveryOrdersReleased: 1,
      deliveryOrdersUnbilled: 1,
    });
    const ev = await db.domainEvent.findFirstOrThrow({
      where: { tenantId, type: 'invoice.voided', localId: iid },
    });
    expect(ev.snapshot).toMatchObject({ status: 'CANCELLED', invoiceNo: inv.invoiceNo });
    expect(JSON.stringify(ev.snapshot)).not.toMatch(/"sell/);
    expect(ev.previousAttributes).toEqual({ status: 'ISSUED', version: inv.version });

    // DO กลับมาวางบิลใหม่ได้ → ใบใหม่ได้เลขถัดไป (เลขที่ยกเลิกไม่ถูกใช้ซ้ำ)
    const again = await issued(cus, [d1.doId]);
    const n = (x: string) => Number(NO_RE.exec(x)![2]);
    expect(n(again.invoiceNo)).toBe(n(inv.invoiceNo) + 1);
    expect(again.replacesInvoice).toBeNull();
    // ยกเลิกซ้ำ → 409 · ใบเดิมยังอยู่ (ไม่มีการลบ) สถานะ CANCELLED
    await cancel(inv.id, r.body.version).expect(409);
    expect(await getInv(inv.id)).toMatchObject({ status: 'CANCELLED', invoiceNo: inv.invoiceNo });
  });

  it('ออกฉบับใหม่แทน (reissue): ร่างใหม่ DO ชุดเดิม + บรรทัดที่เพิ่มเอง อ้างเลขเดิม · ออกเลขใหม่ · PDF หมายเหตุอ้างเลขเดิม', async () => {
    const cus = await newCustomer();
    const d1 = await delivered(cus);
    const d2 = await delivered(cus);
    const dr = await draft(cus, [d1.doId, d2.doId]);
    const withLine = (
      await api(app, invoicer)
        .post(`/v1/invoices/${dr.id}/lines`)
        .set('If-Match', `"${dr.version}"`)
        .send({
          serviceItemId: loading,
          quantity: '2',
          sellUnitPrice: '150.00',
          description: 'ค่ายกขึ้นชั้น 2',
          reason: 'ลูกค้าขอให้ยกขึ้นชั้นสอง',
        })
        .expect(200)
    ).body;
    const inv = (await finalize(dr.id, withLine.version).expect(200)).body;
    const r = await cancel(inv.id, inv.version, {
      reason: 'เลขที่ PO ผิด ออกฉบับใหม่แทน',
      reissue: true,
    }).expect(200);
    expect(r.body.replacedByInvoice).toMatchObject({ status: 'DRAFT', invoiceNo: null });
    const nid = r.body.replacedByInvoice.id as string;
    const re = await getInv(nid);
    expect(re).toMatchObject({
      status: 'DRAFT',
      replacesInvoice: { id: inv.id, invoiceNo: inv.invoiceNo, issueDate: inv.issueDate },
      deliveryOrderCount: 2,
      sellTotal: inv.sellTotal,
      creditTermDays: inv.creditTermDays,
      createdBy: 'u-acc',
    });
    expect(re.lines.filter((l: { deliveryOrderId: string | null }) => !l.deliveryOrderId)).toEqual([
      expect.objectContaining({ description: 'ค่ายกขึ้นชั้น 2', sellAmount: '300.00' }),
    ]);
    // DO อยู่ในร่างใหม่ (IN_DRAFT) — ไม่หลุดไปคิว
    for (const d of [d1, d2])
      expect(
        (await db.deliveryOrder.findUniqueOrThrow({ where: { id: d.uuid } })).billingStatus,
      ).toBe('IN_DRAFT');
    // ผู้ยกเลิก = ผู้สร้างร่างใหม่ → ออกเองไม่ได้ (A3) · คนอื่นออกได้ เลขถัดไป
    await finalize(nid, re.version).expect(403);
    const out = (await finalize(nid, re.version, invoicer).expect(200)).body;
    expect(Number(NO_RE.exec(out.invoiceNo)![2])).toBeGreaterThan(
      Number(NO_RE.exec(inv.invoiceNo)![2]),
    );
    expect((await getInv(inv.id)).replacedByInvoice).toMatchObject({
      id: nid,
      status: 'ISSUED',
      invoiceNo: out.invoiceNo,
    });
    // ร่าง → /void 409 (ร่างใช้ /cancel) · ฐานข้อมูล: ตั้งใบเดิมได้เฉพาะใบที่ยกเลิกแล้วของลูกค้าเดียวกัน · ใบที่ออกแล้วเปลี่ยนไม่ได้
    const dr2 = await draft(cus, [(await delivered(cus)).doId]);
    const bad = await cancel(dr2.id, dr2.version, {
      reason: 'ลองออกฉบับใหม่จากร่าง',
      reissue: true,
    }).expect(409);
    expect(bad.body).toMatchObject({ code: 'invalid_state_transition', currentStatus: 'DRAFT' });
    await expect(
      run((tx) =>
        tx.invoice.update({
          where: { id: uuid('invoice', dr2.id) },
          data: { replacesInvoiceId: uuid('invoice', out.id) },
        }),
      ),
    ).rejects.toThrow(/replaces_invoice_id must be a cancelled issued invoice/);
    await expect(
      run((tx) =>
        tx.invoice.update({
          where: { id: uuid('invoice', out.id) },
          data: { replacesInvoiceId: null },
        }),
      ),
    ).rejects.toThrow(/replaces_invoice_id cannot change/);
  });

  it('hand-off ST5-T13: รับชำระแล้ว → 409 `invoice_has_payments` (+ เลขรับชำระ) · กลับรายการแล้วยกเลิกได้ · ฐานข้อมูลกันซ้ำ', async () => {
    const cus = await newCustomer();
    const inv = await issued(cus, [(await delivered(cus)).doId]);
    const pay = (
      await api(app, accounting)
        .post('/v1/payments')
        .send({
          receivedDate: today,
          method: 'TRANSFER',
          amountReceived: '1000.00',
          allocations: [{ invoiceId: inv.id, amount: '1000.00' }],
        })
        .expect(201)
    ).body;
    const cur = await getInv(inv.id);
    expect(cur.status).toBe('PARTIALLY_PAID');
    const r = await cancel(inv.id, cur.version).expect(409);
    expect(r.body).toMatchObject({
      code: 'invoice_has_payments',
      currentStatus: 'PARTIALLY_PAID',
      payments: [{ paymentId: pay.id, paymentNo: pay.paymentNo }],
    });
    // ฐานข้อมูล: ใบที่รับชำระแล้วเปลี่ยนเป็น CANCELLED ตรง ๆ ไม่ได้
    await expect(
      run((tx) =>
        tx.invoice.update({
          where: { id: uuid('invoice', inv.id) },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledBy: 'x',
            cancelReason: 'ทดสอบแอบยกเลิก',
          },
        }),
      ),
    ).rejects.toThrow(/only an issued invoice without payments can be cancelled/);
    await api(app, admin)
      .post(`/v1/payments/${pay.id}/reverse`)
      .set('If-Match', `"${pay.version}"`)
      .send({ reason: 'บันทึกผิดใบ กลับรายการ' })
      .expect(200);
    const now = await getInv(inv.id);
    expect(now).toMatchObject({ status: 'ISSUED', sellPaidAmount: '0.00' });
    await cancel(inv.id, now.version).expect(200);
    // ใบที่ยกเลิกรับชำระไม่ได้
    await api(app, accounting)
      .post('/v1/payments')
      .send({
        receivedDate: today,
        method: 'TRANSFER',
        amountReceived: '10.00',
        allocations: [{ invoiceId: inv.id, amount: '10.00' }],
      })
      .expect(409);
  });

  it('hand-off ST5-T11: อยู่ในใบวางบิล ISSUED → 409 บอกเลขใบวางบิล · ยกเลิกใบวางบิลก่อนแล้วยกเลิกได้ · ใบวางบิลร่าง → ถอดออก + คิดยอดใหม่', async () => {
    const cus = await newCustomer();
    const a = await issued(cus, [(await delivered(cus)).doId]);
    const b = await issued(cus, [(await delivered(cus)).doId]);
    const bn = (
      await api(app, invoicer)
        .post('/v1/billing-notes')
        .send({ customerId: cus, invoiceIds: [a.id], collectionDate: addDays(today, 7) })
        .expect(201)
    ).body;
    const bnIssued = (
      await api(app, accounting)
        .post(`/v1/billing-notes/${bn.id}/finalize`)
        .set('If-Match', `"${bn.version}"`)
        .expect(200)
    ).body;
    const r = await cancel(a.id, a.version).expect(409);
    expect(r.body).toMatchObject({
      code: 'invoice_on_billing_note',
      billingNoteId: bn.id,
      billingNoteNo: bnIssued.billingNoteNo,
      billingNoteStatus: 'ISSUED',
    });
    expect(r.body.billingNoteNo).toBeTruthy();
    await api(app, accounting)
      .post(`/v1/billing-notes/${bn.id}/cancel`)
      .set('If-Match', `"${bnIssued.version}"`)
      .send({ reason: 'ลูกค้าขอแก้ใบแจ้งหนี้ก่อน' })
      .expect(200);
    await cancel(a.id, a.version).expect(200);

    // ใบวางบิลร่างที่มีใบ b + ใบ c → ยกเลิก b → ร่างเหลือ c ยอดรวมคิดใหม่
    const c = await issued(cus, [(await delivered(cus)).doId]);
    const draftBn = (
      await api(app, invoicer)
        .post('/v1/billing-notes')
        .send({ customerId: cus, invoiceIds: [b.id, c.id], collectionDate: addDays(today, 7) })
        .expect(201)
    ).body;
    await cancel(b.id, b.version).expect(200);
    const after = (await api(app, admin).get(`/v1/billing-notes/${draftBn.id}`).expect(200)).body;
    expect(after.version).toBe(draftBn.version + 1);
    expect(after.sellTotal ?? after.sellOutstanding ?? after.total).toBeDefined();
    const links = await db.billingNoteInvoice.findMany({
      where: { billingNoteId: uuid('billingNote', draftBn.id), active: true },
    });
    expect(links.map((l) => l.invoiceId)).toEqual([uuid('invoice', c.id)]);
    const note = await db.billingNote.findUniqueOrThrow({
      where: { id: uuid('billingNote', draftBn.id) },
    });
    expect(note.totalAmount.toFixed(2)).toBe(c.sellTotal);
    expect((await getInv(b.id)).billingNoteId).toBeNull();
  });

  it('สิทธิ์ + If-Match: /void ต้องมี `invoices:finalize` (403) · ไม่ส่ง If-Match 422 · version เก่า 412 · ข้าม tenant 404 · /cancel ใช้กับร่างเท่านั้น', async () => {
    const cus = await newCustomer();
    const inv = await issued(cus, [(await delivered(cus)).doId]);
    const drafterOnly = await tokenFor(tenantId, 'invoices:read invoices:draft', 'u-draft-only');
    const r403 = await cancel(inv.id, inv.version, undefined, drafterOnly).expect(403);
    expect(r403.body).toMatchObject({ code: 'permission_denied', required: ['invoices:finalize'] });
    // /cancel (ร่าง) ยกเลิกใบที่ออกแล้วไม่ได้
    await api(app, accounting)
      .post(`/v1/invoices/${inv.id}/cancel`)
      .set('If-Match', `"${inv.version}"`)
      .send({ reason: 'ยกเลิกด้วยทางของร่าง' })
      .expect(409);
    await cancel(inv.id, inv.version, undefined, viewer).expect(403);
    const r422 = await cancel(inv.id, null).expect(422);
    expect(r422.body.errors[0]).toMatchObject({ field: 'If-Match', code: 'if_match_required' });
    await cancel(inv.id, inv.version - 1).expect(412);
    await cancel(inv.id, inv.version, { reason: 'สั้น' }).expect(422);
    const other = (await createTenantWithDefaults(db, { name: 'บริษัทอื่น ยกเลิก' })).id;
    await cancel(inv.id, inv.version, undefined, await tokenFor(other)).expect(404);
    expect((await getInv(inv.id)).status).toBe('ISSUED');
    // ร่างที่ยกเลิก (ST5-T07 /cancel) ยังแสดง DO เดิม (บรรทัดของเอกสาร ณ วันยกเลิก) · DO กลับคิว
    const d = await delivered(cus);
    const dr = await draft(cus, [d.doId]);
    const ok = (
      await api(app, drafterOnly)
        .post(`/v1/invoices/${dr.id}/cancel`)
        .send({ reason: 'ลูกค้าขอแยกวางบิลงวดหน้า' })
        .expect(200)
    ).body;
    expect(ok).toMatchObject({ status: 'CANCELLED', invoiceNo: null, deliveryOrderCount: 1 });
    expect(
      (await db.deliveryOrder.findUniqueOrThrow({ where: { id: d.uuid } })).billingStatus,
    ).toBe('UNBILLED');
  });

  it('PDF ใบที่ยกเลิก: ลายน้ำ "ยกเลิก" (render จาก snapshot ไม่เก็บ) · ไฟล์ต้นฉบับที่เก็บคงเดิม · ใบออกแทนพิมพ์หมายเหตุอ้างเลขเดิม', async () => {
    const cus = await newCustomer();
    const inv = await issued(cus, [(await delivered(cus)).doId]);
    const queue = app.get(JobQueue);
    while (await queue.runOnce());
    const stored = (await getInv(inv.id)).pdf;
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    const r = await cancel(inv.id, inv.version, {
      reason: 'ที่อยู่ลูกค้าผิด ออกใหม่',
      reissue: true,
    }).expect(200);
    const pdf = await api(app, admin).get(`/v1/invoices/${inv.id}/pdf`).expect(200);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.headers['content-disposition']).toContain('-cancelled.pdf');
    expect(pdf.headers['x-content-sha256']).not.toBe(stored.sha256);
    expect((await getInv(inv.id)).pdf).toEqual(stored);
    expect(
      await db.storedDocument.count({
        where: { tenantId, entityType: 'invoice', entityId: uuid('invoice', inv.id) },
      }),
    ).toBe(2); // ต้นฉบับ + สำเนา ณ วันออก — ไม่เพิ่ม
    // pro forma ของร่างที่ออกแทน
    await api(app, admin).get(`/v1/invoices/${r.body.replacedByInvoice.id}/proforma`).expect(200);
    // แม่แบบ: ลายน้ำ + หมายเหตุอ้างเลข/วันที่เดิม (ไม่กระทบเอกสารปกติ)
    const plain = invoiceDocument(sampleInvoiceExempt()).body;
    expect(plain).not.toMatch(/class="fdoc"[^>]*data-wm/);
    const voided = invoiceDocument({ ...sampleInvoiceExempt(), cancelled: true }).body;
    expect(voided).toMatch(/class="fdoc"[^>]*data-wm="ยกเลิก"/);
    const re = invoiceDocument({
      ...sampleInvoiceExempt(),
      replaces: { invoiceNo: 'INV-00000-6911-0007', issueDate: '2026-11-03' },
    }).body;
    expect(re).toContain('ออกแทนใบแจ้งหนี้เลขที่ INV-00000-6911-0007 ลงวันที่ 3 พ.ย. 2569');
  });
});
