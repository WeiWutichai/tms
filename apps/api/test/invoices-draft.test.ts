import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { proformaHtml } from '../src/modules/invoices/invoice-pdf.service';
import { InvoicesController } from '../src/modules/invoices/invoices.controller';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { RevenueLinesService } from '../src/modules/revenue-lines/revenue-lines.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST5-T07 ร่างใบแจ้งหนี้ (D-54: ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี) — เกณฑ์ตรวจรับ:
 * สร้าง draft จาก 5 DO แก้บรรทัดได้ · draft ไม่มี `invoice_no` · DO ใน draft แก้ราคาที่ order ไม่ได้
 * + ตรวจความพร้อมซ้ำตอนดึง (ไม่เชื่อ released_at) · ลำดับ route queue ก่อน :id · ย้าย/ถอด/ยกเลิก · Group/Merge/Single · ส่วนลด ·
 * ไม่เข้า outbox · audit · สิทธิ์ · If-Match · pro forma PDF
 */
describe('invoice drafts (ST5-T07)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let viewer: string;
  let planner: string;
  let invoicer: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  let loading: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const NONE_REQ = { success: { fields: [] } };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ร่างใบแจ้งหนี้' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล จำกัด', taxId: validTaxId(971) },
    });
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
    planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-plan');
    invoicer = await tokenFor(tenantId, SYSTEM_ROLES.invoicer.permissions.join(' '), 'u-inv');
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
          plate: `7${++seed % 10}-${String(4000 + seed)}`,
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
        phone: `086-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
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
        .send({ legalName: `ลูกค้าร่างบิล ${++seed}`, taxId: validTaxId(9900 + seed) })
        .expect(201)
    ).body as { id: string };
    await db.customer.update({
      where: { id: uuid('customer', body.id) },
      data: { podRequirements: NONE_REQ, paymentTermDays: 45 },
    });
    return body.id;
  };

  /** ลูกค้า → rate card 350/ตัน → SO 5 ตัน → DO → เที่ยว → ส่งสำเร็จ (→ ส่งบัญชี) */
  const delivered = async (customer: string, releaseIt = true) => {
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
          overrideReason: 'ทดสอบร่างใบแจ้งหนี้',
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
    if (releaseIt)
      await api(app, admin).post(`/v1/delivery-orders/${doId}/release`).send({}).expect(200);
    return { doId, uuid: d!.id, soId: so.id };
  };
  const getDo = async (doId: string) =>
    (await api(app, admin).get(`/v1/delivery-orders/${doId}`).expect(200)).body as Record<
      string,
      any
    >;
  const create = (customerId: string, deliveryOrderIds: string[], token = invoicer, extra = {}) =>
    api(app, token)
      .post('/v1/invoices')
      .send({ customerId, deliveryOrderIds, ...extra });
  const getInv = async (id: string) =>
    (await api(app, admin).get(`/v1/invoices/${id}`).expect(200)).body as Record<string, any>;
  const ifMatch = (v: number) => ({ 'If-Match': `"${v}"` });

  it('route: ประกาศ GET /invoices/queue ก่อน :id (ไม่ถูกจับเป็น id) + test ลำดับ route', async () => {
    const names = Object.getOwnPropertyNames(InvoicesController.prototype);
    expect(names.indexOf('list')).toBeGreaterThan(-1);
    expect(names.indexOf('list')).toBeLessThan(names.indexOf('get'));
    expect(names.indexOf('list')).toBeLessThan(names.indexOf('proforma'));
    expect(names.indexOf('summary')).toBeLessThan(names.indexOf('get'));
    const sum = await api(app, invoicer).get('/v1/invoices/summary').expect(200);
    expect(sum.body).toMatchObject({ overdue: 0 });
    const q = await api(app, invoicer).get('/v1/invoices/queue').expect(200);
    expect(q.body).toHaveProperty('customers');
    await api(app, invoicer)
      .get(`/v1/invoices/ivc_${'0'.repeat(32)}`)
      .expect(404);
  });

  it('เกณฑ์ตรวจรับ: สร้างร่างจาก 5 DO · ไม่มีเลข · ยอดประมาณการ · DO → IN_DRAFT · ไม่เข้า outbox · audit', async () => {
    const cus = await newCustomer();
    const dos = [];
    for (let i = 0; i < 5; i++) dos.push(await delivered(cus));
    const outboxBefore = await db.integrationOutbox.count({ where: { tenantId } });
    const eventsBefore = await db.domainEvent.count({ where: { tenantId } });
    const r = await create(
      cus,
      dos.map((d) => d.doId),
    ).expect(201);
    const inv = r.body;
    expect(r.headers.etag).toBe('"1"');
    expect(inv).toMatchObject({
      status: 'DRAFT',
      invoiceNo: null,
      deliveryOrderCount: 5,
      lineMode: 'SINGLE',
      creditTermDays: 45,
      taxEstimated: true,
      sellSubtotalExempt: '8750.00',
      sellSubtotalVatable: '0.00',
      sellVatAmount: '0.00',
      sellTotal: '8750.00',
      sellWhtExpected: '87.50',
      sellNetExpected: '8662.50',
      periodFrom: today,
      periodTo: today,
    });
    expect(inv.id).toMatch(/^ivc_/);
    expect(inv.lines).toHaveLength(5);
    expect(inv.lines[0]).toMatchObject({
      quantity: '5',
      sellUnitPrice: '350.00',
      sellAmount: '1750.00',
      vatType: 'EXEMPT_TRANSPORT',
      whtRate: '1.00',
      active: true,
    });
    expect(inv.lines[0].revenueLineId).toMatch(/^rvl_/);
    for (const d of dos) expect((await getDo(d.doId)).billingStatus).toBe('IN_DRAFT');
    // ร่างไม่มีเลข (CHECK ระดับ DB) · ไม่เข้า outbox / ไม่มี event สาธารณะ
    const row = await db.invoice.findUniqueOrThrow({ where: { id: uuid('invoice', inv.id) } });
    expect(row.invoiceNo).toBeNull();
    expect(await db.integrationOutbox.count({ where: { tenantId } })).toBe(outboxBefore);
    expect(await db.domainEvent.count({ where: { tenantId } })).toBe(eventsBefore);
    const audit = await db.auditLog.findFirst({
      where: { tenantId, action: 'invoice.draft_created', entityId: row.id },
    });
    expect(audit).toBeTruthy();
    // ออกจากคิวพร้อมวางบิลแล้ว · รายการใบแจ้งหนี้เห็นร่าง
    const q = await api(app, admin).get(`/v1/invoices/queue?customerId=${cus}`).expect(200);
    expect(q.body.data).toHaveLength(0);
    const list = await api(app, admin)
      .get(`/v1/invoices?status=DRAFT&customerId=${cus}`)
      .expect(200);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([inv.id]);
    expect(list.body.data[0]).toMatchObject({ invoiceNo: null, deliveryOrderCount: 5 });

    // แก้บรรทัด: เพิ่มบรรทัดเอง (VAT 7%) → VAT ประมาณการ
    const v1 = (
      await api(app, invoicer)
        .post(`/v1/invoices/${inv.id}/lines`)
        .set(ifMatch(1))
        .send({
          serviceItemId: loading,
          quantity: '2',
          sellUnitPrice: '250.00',
          reason: 'ค่ายกขนตามที่ลูกค้าตกลง',
        })
        .expect(200)
    ).body;
    expect(v1).toMatchObject({
      version: 2,
      sellSubtotalVatable: '500.00',
      sellVatAmount: '35.00',
      sellTotal: '9285.00',
    });
    const manual = v1.lines.find((l: { isUserAdded: boolean }) => l.isUserAdded);
    expect(manual).toMatchObject({
      deliveryOrderId: null,
      vatType: 'VAT_7',
      sellVatAmount: '35.00',
    });
    // ส่วนลด (ราคาแก้ที่ร่าง) — เหตุผลบังคับ · เกินยอด → 422
    const first = v1.lines[0].id;
    await api(app, invoicer)
      .patch(`/v1/invoices/${inv.id}/lines/${first}`)
      .send({ sellDiscount: '50.00' })
      .expect(422);
    await api(app, invoicer)
      .patch(`/v1/invoices/${inv.id}/lines/${first}`)
      .send({ sellDiscount: '5000.00', reason: 'ส่วนลดพิเศษลูกค้าประจำ' })
      .expect(422);
    const v2 = (
      await api(app, invoicer)
        .patch(`/v1/invoices/${inv.id}/lines/${first}`)
        .set(ifMatch(2))
        .send({ sellDiscount: '50.00', reason: 'ส่วนลดพิเศษลูกค้าประจำ' })
        .expect(200)
    ).body;
    expect(v2.lines[0]).toMatchObject({ sellDiscount: '50.00', sellAmount: '1700.00' });
    expect(v2).toMatchObject({
      sellSubtotalExempt: '8700.00',
      sellDiscountTotal: '50.00',
      sellWhtExpected: '102.00',
    });
    // stale If-Match → 412
    await api(app, invoicer)
      .patch(`/v1/invoices/${inv.id}`)
      .set(ifMatch(1))
      .send({ lineMode: 'GROUP' })
      .expect(412);
    // Group / Merge / Single
    const g = (
      await api(app, invoicer)
        .patch(`/v1/invoices/${inv.id}`)
        .send({ lineMode: 'GROUP' })
        .expect(200)
    ).body;
    // 4 บรรทัดราคาเดียวกัน (1 ใบมีส่วนลด — ยอดต่างแต่ราคาต่อหน่วยเดียวกัน) รวมเป็น 1 + บรรทัด VAT แยก
    expect(g.printLines).toHaveLength(2);
    expect(g.printLines[0]).toMatchObject({
      quantity: '25',
      sellUnitPrice: '350.00',
      sellAmount: '8700.00',
    });
    expect(g.printLines[0].deliveryOrderNos).toHaveLength(5);
    const s = (
      await api(app, invoicer)
        .patch(`/v1/invoices/${inv.id}`)
        .send({ lineMode: 'SINGLE' })
        .expect(200)
    ).body;
    expect(s.printLines).toHaveLength(6);
    // รวมเอง: ข้ามประเภท VAT → 422 · VAT เดียวกัน → 1 บรรทัดบนเอกสาร (ยอดไม่เปลี่ยน)
    const mixed = await api(app, invoicer)
      .post(`/v1/invoices/${inv.id}/lines/merge`)
      .send({ lineIds: [first, manual.id] })
      .expect(422);
    expect(mixed.body.errors[0].code).toBe('mixed_tax_treatment');
    const m = (
      await api(app, invoicer)
        .post(`/v1/invoices/${inv.id}/lines/merge`)
        .send({ lineIds: [s.lines[0].id, s.lines[1].id] })
        .expect(200)
    ).body;
    expect(m.printLines).toHaveLength(5);
    expect(m.printLines[0]).toMatchObject({ manual: true, sellAmount: '3450.00' });
    expect(m.sellTotal).toBe(s.sellTotal);
    const sp = (
      await api(app, invoicer)
        .post(`/v1/invoices/${inv.id}/lines/split`)
        .send({ lineIds: [s.lines[0].id] })
        .expect(200)
    ).body;
    expect(sp.printLines).toHaveLength(6);
    // ถอดบรรทัดเอง (เหตุผล) · บรรทัดของ DO ถอดทีละบรรทัดไม่ได้
    await api(app, invoicer)
      .post(`/v1/invoices/${inv.id}/lines/${first}/remove`)
      .send({ reason: 'ถอดบรรทัดของ DO ทดสอบ' })
      .expect(422);
    const rm = (
      await api(app, invoicer)
        .post(`/v1/invoices/${inv.id}/lines/${manual.id}/remove`)
        .send({ reason: 'ลูกค้าไม่รับค่ายกขน' })
        .expect(200)
    ).body;
    expect(rm).toMatchObject({ sellVatAmount: '0.00', sellSubtotalVatable: '0.00' });
    expect(rm.lines.find((l: { id: string }) => l.id === manual.id)).toMatchObject({
      active: false,
      removeReason: 'ลูกค้าไม่รับค่ายกขน',
    });
    const actions = (
      await db.auditLog.findMany({
        where: { tenantId, entityId: row.id },
        select: { action: true },
      })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'invoice.line_added',
        'invoice.line_updated',
        'invoice.draft_updated',
        'invoice.lines_merged',
        'invoice.lines_split',
        'invoice.line_removed',
      ]),
    );
  });

  it('เกณฑ์ตรวจรับ: DO ในร่างแก้ราคาที่ order ไม่ได้ — บรรทัดรายได้ 409 · คิดราคาใบสั่งใหม่ไม่แตะ DO ในร่าง', async () => {
    const cus = await newCustomer();
    const d = await delivered(cus);
    await create(cus, [d.doId]).expect(201);
    const rl = await db.revenueLine.findFirstOrThrow({
      where: { deliveryOrderId: d.uuid, status: 'ACTIVE' },
    });
    const v = await api(app, admin)
      .post(`/v1/revenue-lines/${encodeId('revenueLine', rl.id)}/void`)
      .send({ reason: 'ทดสอบแก้ราคา DO ในร่าง' })
      .expect(409);
    expect(v.body.errors?.[0]?.code ?? v.body.code).toMatch(
      /do_in_invoice|revenue_line_locked|invalid_state/,
    );
    // ราคาใบสั่งเปลี่ยน (เช่น แก้ rate) → rebuild ไม่แตะบรรทัดของ DO ในร่าง
    await db.salesOrderCharge.updateMany({
      where: { salesOrderId: d.soId },
      data: { unitPrice: '999.00', amount: '4995.00', calculatedAmount: '4995.00' },
    });
    await run((tx) => app.get(RevenueLinesService).rebuild(d.soId, tx));
    const after = await db.revenueLine.findUniqueOrThrow({ where: { id: rl.id } });
    expect(after.amount.toFixed(2)).toBe(rl.amount.toFixed(2));
    expect(after.status).toBe('ACTIVE');
  });

  it('ตรวจความพร้อมซ้ำตอนดึง: ยังไม่ส่งบัญชี → NOT_RELEASED · ส่งบัญชีแล้วแต่ภายหลังติดระงับวางบิล → 409 (ไม่เชื่อ released_at)', async () => {
    const cus = await newCustomer();
    const notReleased = await delivered(cus, false);
    const r1 = await create(cus, [notReleased.doId]).expect(409);
    expect(r1.body).toMatchObject({ code: 'not_ready_to_bill', reasons: ['NOT_RELEASED'] });
    expect(r1.body.deliveryOrders[0].deliveryOrderId).toBe(notReleased.doId);
    const held = await delivered(cus);
    expect((await getDo(held.doId)).releasedAt).toBeTruthy();
    await db.deliveryOrder.update({ where: { id: held.uuid }, data: { billingHold: true } });
    const r2 = await create(cus, [held.doId]).expect(409);
    expect(r2.body.reasons).toContain('BILLING_HOLD');
    // ไม่มีอะไรค้าง (ทั้งคำขอย้อนทั้งหมด)
    expect(await db.invoice.count({ where: { tenantId, customerId: uuid('customer', cus) } })).toBe(
      0,
    );
    expect((await getDo(held.doId)).billingStatus).toBe('UNBILLED');
    // DO ของลูกค้าอื่น → 422
    const other = await newCustomer();
    const r3 = await create(other, [notReleased.doId]).expect(422);
    expect(r3.body.errors[0].code).toBe('customer_mismatch');
  });

  it('กันวางบิลซ้ำ: DO อยู่ในร่างอื่นแล้ว → 409 do_already_drafted · ถอด (เหตุผล) → กลับคิว · ย้ายระหว่างร่าง · ยกเลิกร่าง', async () => {
    const cus = await newCustomer();
    const [d1, d2, d3] = [await delivered(cus), await delivered(cus), await delivered(cus)];
    const a = (await create(cus, [d1.doId, d2.doId]).expect(201)).body;
    const dup = await create(cus, [d2.doId, d3.doId]).expect(409);
    expect(dup.body).toMatchObject({ code: 'do_already_drafted', doNo: expect.any(String) });
    const b = (await create(cus, [d3.doId]).expect(201)).body;

    // ถอด: เหตุผลบังคับ
    await api(app, invoicer)
      .post(`/v1/invoices/${a.id}/delivery-orders/remove`)
      .send({ deliveryOrderIds: [d2.doId] })
      .expect(422);
    const rem = (
      await api(app, invoicer)
        .post(`/v1/invoices/${a.id}/delivery-orders/remove`)
        .send({ deliveryOrderIds: [d2.doId], reason: 'ลูกค้าขอวางบิลงวดหน้า' })
        .expect(200)
    ).body;
    expect(rem).toMatchObject({ deliveryOrderCount: 1, sellTotal: '1750.00' });
    expect((await getDo(d2.doId)).billingStatus).toBe('UNBILLED');
    const q = await api(app, admin).get(`/v1/invoices/queue?customerId=${cus}`).expect(200);
    expect(q.body.data.map((x: { id: string }) => x.id)).toEqual([d2.doId]);
    // เพิ่มกลับเข้าร่าง b
    const added = (
      await api(app, invoicer)
        .post(`/v1/invoices/${b.id}/delivery-orders`)
        .send({ deliveryOrderIds: [d2.doId] })
        .expect(200)
    ).body;
    expect(added.deliveryOrderCount).toBe(2);
    // ย้าย d1 จาก a → b (ETag = ต้นทาง)
    const mv = await api(app, invoicer)
      .post(`/v1/invoices/${a.id}/delivery-orders/move`)
      .send({ deliveryOrderIds: [d1.doId], targetInvoiceId: b.id })
      .expect(200);
    expect(mv.body.source).toMatchObject({ deliveryOrderCount: 0, sellTotal: '0.00' });
    expect(mv.body.target).toMatchObject({ deliveryOrderCount: 3, sellTotal: '5250.00' });
    expect(mv.headers.etag).toBe(`"${mv.body.source.version}"`);
    expect((await getDo(d1.doId)).billingStatus).toBe('IN_DRAFT');
    // ย้ายไปร่างของลูกค้าอื่น → 422
    const other = await newCustomer();
    const od = await delivered(other);
    const oInv = (await create(other, [od.doId]).expect(201)).body;
    const bad = await api(app, invoicer)
      .post(`/v1/invoices/${b.id}/delivery-orders/move`)
      .send({ deliveryOrderIds: [d1.doId], targetInvoiceId: oInv.id })
      .expect(422);
    expect(bad.body.errors[0].code).toBe('customer_mismatch');

    // ยกเลิกร่าง: เหตุผล → DO กลับ UNBILLED · แก้ต่อไม่ได้ (409) · ไม่มีการลบ
    const c = (
      await api(app, invoicer)
        .post(`/v1/invoices/${b.id}/cancel`)
        .send({ reason: 'ลูกค้าขอรวมเป็นใบเดียวงวดหน้า' })
        .expect(200)
    ).body;
    expect(c).toMatchObject({ status: 'CANCELLED', cancelReason: 'ลูกค้าขอรวมเป็นใบเดียวงวดหน้า' });
    for (const d of [d1, d2, d3]) expect((await getDo(d.doId)).billingStatus).toBe('UNBILLED');
    await api(app, invoicer).patch(`/v1/invoices/${b.id}`).send({ lineMode: 'MERGE' }).expect(409);
    await api(app, invoicer)
      .post(`/v1/invoices/${b.id}/delivery-orders`)
      .send({ deliveryOrderIds: [d1.doId] })
      .expect(409);
    // DO ที่ถูกยกเลิกร่างดึงเข้าร่างใหม่ได้
    await create(cus, [d1.doId, d2.doId, d3.doId]).expect(201);
  });

  it('ฐานข้อมูล: บรรทัดของร่างที่ออกแล้ว/ถอดแล้วแก้ไม่ได้ · บรรทัดรายได้เดียวกันอยู่ 2 บรรทัด active ไม่ได้', async () => {
    const cus = await newCustomer();
    const d = await delivered(cus);
    const inv = (await create(cus, [d.doId]).expect(201)).body;
    const iid = uuid('invoice', inv.id);
    const line = await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: iid } });
    // บรรทัดรายได้เดียวกันซ้ำในใบเดียว (ข้ามตัวกัน) → unique partial
    await expect(
      run((tx) =>
        tx.invoiceLine.create({
          data: {
            tenantId,
            invoiceId: iid,
            lineNo: 99,
            revenueLineId: line.revenueLineId,
            doAnchor: false,
            deliveryOrderId: line.deliveryOrderId,
            serviceItemId: line.serviceItemId,
            description: 'ซ้ำ',
            quantity: '1',
            unitLabel: 'x',
            unitPrice: '1',
            amount: '1',
            vatType: 'EXEMPT_TRANSPORT',
            whtRate: '1.00',
          },
        }),
      ),
    ).rejects.toThrow(/invoice_line_active_revenue_line_key|Unique constraint/);
    await db.invoice.update({
      where: { id: iid },
      data: { status: 'ISSUED', invoiceNo: 'INV-T07-1' },
    });
    await expect(
      run((tx) => tx.invoiceLine.update({ where: { id: line.id }, data: { discount: '1.00' } })),
    ).rejects.toThrow(/invoice_line_draft_content|content can only change/);
    // API: ใบที่ไม่ใช่ร่าง → 409 · PDF ตัวอย่าง → 409
    await api(app, invoicer).patch(`/v1/invoices/${inv.id}`).send({ note: 'x' }).expect(409);
    await api(app, invoicer).get(`/v1/invoices/${inv.id}/proforma`).expect(409);
  });

  it('สิทธิ์: planner ไม่มี invoices:read (403) · viewer อ่านได้แต่สร้าง/แก้ไม่ได้ (403) · ไม่มีราคา → ไม่เห็นยอด', async () => {
    const cus = await newCustomer();
    const d = await delivered(cus);
    await api(app, planner).get('/v1/invoices').expect(403);
    await create(cus, [d.doId], viewer).expect(403);
    const inv = (await create(cus, [d.doId]).expect(201)).body;
    const v = await api(app, viewer).get(`/v1/invoices/${inv.id}`);
    if (v.status === 200) {
      const canSell = SYSTEM_ROLES.viewer.permissions.includes('prices.sell:read');
      if (!canSell) expect(v.body.sellTotal).toBeUndefined();
    } else expect(v.status).toBe(403);
    await api(app, viewer)
      .post(`/v1/invoices/${inv.id}/cancel`)
      .send({ reason: 'ผู้ดูอย่างเดียวยกเลิกไม่ได้' })
      .expect(403);
  });

  it('pro forma: PDF ของร่าง (ไม่มีเลข มีลายน้ำร่าง) · ไม่มีคำว่า "ใบกำกับภาษี"', async () => {
    const cus = await newCustomer();
    const d = await delivered(cus);
    const inv = (await create(cus, [d.doId]).expect(201)).body;
    const r = await api(app, invoicer)
      .get(`/v1/invoices/${inv.id}/proforma`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect((r.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const html = proformaHtml({
      yearStyle: 'BE',
      issuedOn: new Date('2026-11-20T03:00:00Z'),
      issuer: {
        name: 'บริษัท ผู้ออกบิล จำกัด',
        taxId: '0105560000001',
        branch: 'สำนักงานใหญ่',
        address: '',
      },
      customer: { name: 'ลูกค้า', taxId: null, branch: '', address: '' },
      inv: (await getInv(inv.id)) as never,
    });
    expect(html).toContain('ใบแจ้งหนี้');
    expect(html).toContain('ร่าง');
    expect(html).not.toContain('ใบกำกับภาษี');
    expect(html).toContain('1,750.00');
  });

  // ---------- review/QA ST5-T07 ----------

  it('review M1: ดึงเข้าร่างพร้อม rebuild บรรทัดรายได้ (ราคาใบสั่งเปลี่ยน) — บรรทัดใบตรงบรรทัดรายได้เสมอ ไม่มี 500', async () => {
    const cus = await newCustomer();
    for (let i = 0; i < 3; i++) {
      const d = await delivered(cus);
      await db.salesOrderCharge.updateMany({
        where: { salesOrderId: d.soId },
        data: { unitPrice: '400.00', amount: '2000.00', calculatedAmount: '2000.00' },
      });
      const [c] = await Promise.all([
        create(cus, [d.doId]),
        run((tx) => app.get(RevenueLinesService).rebuild(d.soId, tx)),
      ]);
      expect(c.status).toBe(201);
      const il = await db.invoiceLine.findFirstOrThrow({
        where: { invoiceId: uuid('invoice', c.body.id), active: true },
      });
      const rl = await db.revenueLine.findUniqueOrThrow({ where: { id: il.revenueLineId! } });
      expect(rl.status).toBe('ACTIVE');
      expect(il.amount.toFixed(2)).toBe(rl.amount.toFixed(2));
    }
  });

  it('QA1: สร้างร่างจาก DO เดียวกันพร้อมกัน 3 คำขอ → สำเร็จ 1 ที่เหลือ 409', async () => {
    const cus = await newCustomer();
    const d = await delivered(cus);
    const rs = await Promise.all([
      create(cus, [d.doId]),
      create(cus, [d.doId]),
      create(cus, [d.doId]),
    ]);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    expect(
      await db.invoiceLine.count({
        where: { deliveryOrderId: d.uuid, active: true, doAnchor: true },
      }),
    ).toBe(1);
  });

  it('review M2: ส่งบัญชี + สร้างร่างในคำขอเดียว (atomic) · ตัวอย่าง PDF ไม่บันทึกอะไร', async () => {
    const cus = await newCustomer();
    const a = await delivered(cus, false);
    const b = await delivered(cus, false);
    // b ติดระงับวางบิล → ทั้งคำขอ 409 และ a ยังไม่ถูกส่งบัญชี
    await db.deliveryOrder.update({ where: { id: b.uuid }, data: { billingHold: true } });
    const bad = await create(cus, [a.doId, b.doId], invoicer, {
      releaseDeliveryOrders: true,
    }).expect(409);
    expect(bad.body.code).toBe('not_ready_to_bill');
    expect((await getDo(a.doId)).releasedAt).toBeNull();
    // ตัวอย่าง: PDF ได้ แต่ไม่มีร่าง/การส่งบัญชี/audit ค้าง
    const before = await db.invoice.count({ where: { tenantId } });
    const audits = await db.auditLog.count({ where: { tenantId } });
    const pv = await api(app, invoicer)
      .post('/v1/invoices/preview')
      .send({ customerId: cus, deliveryOrderIds: [a.doId] })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (x: Buffer) => chunks.push(x));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((pv.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect(await db.invoice.count({ where: { tenantId } })).toBe(before);
    expect(await db.auditLog.count({ where: { tenantId } })).toBe(audits);
    expect((await getDo(a.doId)).releasedAt).toBeNull();
    expect((await getDo(a.doId)).billingStatus).toBe('UNBILLED');
    await api(app, invoicer)
      .post('/v1/invoices/preview')
      .send({ customerId: cus, deliveryOrderIds: [b.doId] })
      .expect(409);
    // ไม่ติดแล้ว → สำเร็จ ส่งบัญชีให้ในคำขอเดียว
    const ok = await create(cus, [a.doId], invoicer, { releaseDeliveryOrders: true }).expect(201);
    expect(ok.body.deliveryOrderCount).toBe(1);
    expect((await getDo(a.doId)).releasedAt).toBeTruthy();
  });

  it('review L1: ถอด DO ออกจากร่าง → คิดบรรทัดรายได้ของใบสั่งใหม่ (ราคาที่เปลี่ยนระหว่างแช่แข็งมีผล) · หน่วยค่าขนส่ง = ตัน', async () => {
    const cus = await newCustomer();
    const d = await delivered(cus);
    const q = await api(app, admin).get(`/v1/invoices/queue?customerId=${cus}`).expect(200);
    expect(q.body.data[0]).toMatchObject({ freightQty: '5', freightUnit: 'ตัน' });
    const inv = (await create(cus, [d.doId]).expect(201)).body;
    expect(inv.lines[0].unitLabel).toBe('ตัน');
    await db.salesOrderCharge.updateMany({
      where: { salesOrderId: d.soId },
      data: { unitPrice: '400.00', amount: '2000.00', calculatedAmount: '2000.00' },
    });
    await run((tx) => app.get(RevenueLinesService).rebuild(d.soId, tx));
    const frozen = await db.revenueLine.findFirstOrThrow({
      where: { deliveryOrderId: d.uuid, status: 'ACTIVE' },
    });
    expect(frozen.amount.toFixed(2)).toBe('1750.00');
    await api(app, invoicer)
      .post(`/v1/invoices/${inv.id}/delivery-orders/remove`)
      .send({ deliveryOrderIds: [d.doId], reason: 'ลูกค้าขอแก้ราคาก่อนวางบิล' })
      .expect(200);
    const after = await db.revenueLine.findFirstOrThrow({
      where: { deliveryOrderId: d.uuid, status: 'ACTIVE' },
    });
    expect(after.amount.toFixed(2)).toBe('2000.00');
  });
});
