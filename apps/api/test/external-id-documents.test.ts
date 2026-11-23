import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
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
 * D-81 · D68-45 (PO 23 พ.ย. 2569) externalId ของ invoices + payments (docs/04 G1 "External id")
 * - `PUT /{invoices|payments}/external/{externalId}` 201 สร้าง → ส่งซ้ำ 200 แถวเดิม version เดิม · unique ต่อ tenant · แยก tenant
 * - path `{id}` รับ `ext:{externalId}` · externalId ผิดรูปแบบ 422 · If-Match ไม่ตรง 412
 * - ใบแจ้งหนี้ที่ออกแล้วแก้ไม่ได้ (409) · การรับชำระแก้ไม่ได้ (เนื้อหาต่าง = 409) · externalId เปลี่ยนไม่ได้ (DB trigger)
 */
describe('external id ของเอกสาร (D68-45)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  const tenants: string[] = [];
  const tokens: string[] = [];
  const companies: string[] = [];
  const branches: string[] = [];
  let seed = 0;
  const today = bangkokToday();
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    for (const name of ['บริษัท เอกสาร ext เอ', 'บริษัท เอกสาร ext บี']) {
      const t = await createTenantWithDefaults(db, { name });
      const c = await db.company.create({
        data: { tenantId: t.id, legalName: `ผู้ออกบิล ${name}`, taxId: validTaxId(4500 + seed++) },
      });
      const b = await db.branch.create({
        data: {
          tenantId: t.id,
          companyId: c.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: ADDR,
          isDefaultIssuer: true,
        },
      });
      tenants.push(t.id);
      companies.push(c.id);
      branches.push(b.id);
      tokens.push(await tokenFor(t.id));
    }
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const http = (i: number) => api(app, tokens[i]!);

  // ---------- fixture: DO ส่งสำเร็จ + ส่งบัญชีแล้ว (แบบ invoices-draft.test.ts) ----------
  const run = <T>(i: number, fn: (tx: Tx) => Promise<T>) =>
    app
      .get(DbService)
      .withTenant(tenants[i]!, (tx) =>
        requestContext.run(
          {
            requestId: randomUUID(),
            tenantId: tenants[i]!,
            actorId: 'user-test',
            locale: 'th',
            tx,
          },
          () => fn(tx),
        ),
      );
  const lookup = async (i: number, path: string, code: string) =>
    (
      (await http(i).get(path).query({ limit: 50 }).expect(200)).body.data as {
        id: string;
        code: string;
      }[]
    ).find((x) => x.code === code)!.id;
  const newCustomer = async (i: number) => {
    const c = (
      await http(i)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ext เอกสาร ${++seed}`, taxId: validTaxId(8800 + seed) })
        .expect(201)
    ).body as { id: string };
    await db.customer.update({
      where: { id: uuid('customer', c.id) },
      data: { podRequirements: { success: { fields: [] } } },
    });
    return c.id;
  };
  const newSite = async (i: number) =>
    (
      await http(i)
        .post('/v1/customer-sites')
        .send({ name: `จุด ext ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  const delivered = async (i: number, customer: string) => {
    const vt6 = await lookup(i, '/v1/vehicle-types', '6W');
    const unitTon = uuid('unit', await lookup(i, '/v1/units', 'TON'));
    const origin = await newSite(i);
    const dest = await newSite(i);
    const r = (
      await http(i)
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
    await http(i)
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
    const { order: so } = await run(i, (tx) =>
      app.get(OrderIntakeService).upsertOrder(input, tx),
    );
    const [d] = await run(i, (tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    const doId = encodeId('deliveryOrder', d!.id);
    const v = (
      await http(i)
        .post('/v1/vehicles')
        .send({
          plate: `7${seed % 10}-${String(5000 + ++seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string };
    const n = ++seed;
    await http(i)
      .post('/v1/drivers')
      .send({
        name: `คนขับ ext ${n}`,
        phone: `085-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    const t = (
      await http(i)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [doId], vehicleId: v.id })
        .expect(201)
    ).body;
    const a = await http(i)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: v.id, dispatch: true });
    if (a.status !== 200)
      await http(i)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: v.id,
          dispatch: true,
          ruleKeys: a.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบ externalId เอกสาร',
        })
        .expect(200);
    const full = (await http(i).get(`/v1/trips/${t.id}`).expect(200)).body;
    const [pickup, drop] = [...full.stops].sort(
      (x: { sequence: number }, y: { sequence: number }) => x.sequence - y.sequence,
    );
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const ev = (stop: string, action: string, min: number, extra: object = {}) =>
      http(i)
        .post(`/v1/stops/${stop}/${action}`)
        .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra })
        .expect(201);
    await ev(pickup.id, 'arrive', 60);
    await ev(pickup.id, 'complete', 55, { outcome: 'DELIVERED' });
    await ev(drop.id, 'arrive', 20);
    await ev(drop.id, 'complete', 10, { outcome: 'DELIVERED' });
    await http(i).post(`/v1/delivery-orders/${doId}/release`).send({}).expect(200);
    return doId;
  };

  /** ใบแจ้งหนี้ที่ออกแล้ว (เขียนตรง — แบบ payments.test.ts) */
  const issued = async (i: number, customerId: string, total: string) => {
    const inv = await db.invoice.create({
      data: {
        tenantId: tenants[i]!,
        customerId: uuid('customer', customerId),
        issuingCompanyId: companies[i]!,
        issuingBranchId: branches[i]!,
        status: 'ISSUED',
        totalAmount: total,
        subtotalExempt: total,
        ...issuedTestFields(`INV-EXT-${++seed}`),
      },
    });
    return encodeId('invoice', inv.id);
  };

  it('invoices: PUT 201 → ซ้ำ 200 version เดิม · ext: ทุก GET · แก้หัวร่าง · PATCH external · ออกแล้วแก้ไม่ได้ · แยก tenant', async () => {
    const cust = await newCustomer(0);
    const do1 = await delivered(0, cust);
    const ext = `ERP-INV-${++seed}`;
    const body = { customerId: cust, deliveryOrderIds: [do1], customerPoNo: 'PO-1' };

    const c1 = await http(0).put(`/v1/invoices/external/${ext}`).send(body);
    expect(c1.status, JSON.stringify(c1.body)).toBe(201);
    expect(c1.body).toMatchObject({ externalId: ext, status: 'DRAFT', invoiceNo: null });
    expect(c1.headers.etag).toBe(`"${c1.body.version}"`);
    const c2 = await http(0).put(`/v1/invoices/external/${ext}`).send(body);
    expect(c2.status).toBe(200);
    expect(c2.body.id).toBe(c1.body.id);
    expect(c2.body.version).toBe(c1.body.version);
    expect(await db.invoice.count({ where: { externalId: ext } })).toBe(1);

    // ext: ใน path {id} (รวม route ไม่เปิด transaction — PDF ร่าง / อีเมล) · ไม่พบ/ผิดรูปแบบ 404
    for (const sub of ['', '/proforma', '/emails']) {
      const r = await http(0).get(`/v1/invoices/ext:${ext}${sub}`);
      expect(r.status, `${sub} ${r.status}`).toBe(200);
    }
    expect((await http(0).get(`/v1/invoices/ext:NOPE-${seed}`)).status).toBe(404);
    expect((await http(0).get(`/v1/invoices/ext:${'x'.repeat(101)}`)).status).toBe(404);
    // list แสดง externalId
    const list = await http(0).get('/v1/invoices').expect(200);
    expect(list.body.data.find((x: { id: string }) => x.id === c1.body.id).externalId).toBe(ext);

    // หัวร่างต่าง → แก้ (version +1) · If-Match ไม่ตรง 412
    const stale = await http(0)
      .put(`/v1/invoices/external/${ext}`)
      .set('If-Match', '"999"')
      .send({ ...body, note: 'แก้' });
    expect(stale.status).toBe(412);
    const u = await http(0)
      .put(`/v1/invoices/external/${ext}`)
      .send({ ...body, note: 'แก้จาก ERP' });
    expect(u.status).toBe(200);
    expect(u.body.note).toBe('แก้จาก ERP');
    expect(u.body.version).toBe(c2.body.version + 1);
    // PATCH external = PATCH ext:
    const p = await http(0)
      .patch(`/v1/invoices/external/${ext}`)
      .set('If-Match', `"${u.body.version}"`)
      .send({ customerPoNo: 'PO-2' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.customerPoNo).toBe('PO-2');
    expect((await http(0).patch(`/v1/invoices/external/NOPE-${seed}`).send({})).status).toBe(404);
    // ชุด DO ต่าง → 409 conflict (ไม่แก้ DO ผ่าน PUT)
    const other = await http(0)
      .put(`/v1/invoices/external/${ext}`)
      .send({ ...body, deliveryOrderIds: [do1, encodeId('deliveryOrder', randomUUID())] });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('conflict');
    // externalId ผิดรูปแบบ 422
    const bad = await http(0)
      .put(`/v1/invoices/external/${encodeURIComponent('มี ช่องว่าง')}`)
      .send(body);
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'externalId' });

    // ออกแล้ว (จำลองออกเลข) → ส่งซ้ำเหมือนเดิม 200 · แก้หัวใบ 409 · PATCH 409
    await db.invoice.update({
      where: { id: uuid('invoice', c1.body.id) },
      data: { status: 'ISSUED', ...issuedTestFields(`INV-EXT-${++seed}`) },
    });
    const cur = (await http(0).get(`/v1/invoices/ext:${ext}`).expect(200)).body;
    const same = await http(0)
      .put(`/v1/invoices/external/${ext}`)
      .send({ ...body, customerPoNo: 'PO-2', note: 'แก้จาก ERP' });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body.version).toBe(cur.version);
    const locked = await http(0)
      .put(`/v1/invoices/external/${ext}`)
      .send({ ...body, customerPoNo: 'PO-3' });
    expect(locked.status).toBe(409);
    expect(locked.body).toMatchObject({ code: 'invalid_state_transition', currentStatus: 'ISSUED' });
    expect(
      (await http(0).patch(`/v1/invoices/external/${ext}`).send({ note: 'x' })).status,
    ).toBe(409);

    // แยก tenant: B มองไม่เห็น · externalId เดียวกันสร้างของตัวเองได้
    expect((await http(1).get(`/v1/invoices/ext:${ext}`)).status).toBe(404);
    expect((await http(1).patch(`/v1/invoices/external/${ext}`).send({})).status).toBe(404);
    const custB = await newCustomer(1);
    const doB = await delivered(1, custB);
    const b1 = await http(1)
      .put(`/v1/invoices/external/${ext}`)
      .send({ customerId: custB, deliveryOrderIds: [doB] });
    expect(b1.status, JSON.stringify(b1.body)).toBe(201);
    expect(b1.body.id).not.toBe(c1.body.id);
    // A ใช้ DO ของ B ไม่ได้ (RLS)
    const cross = await http(0)
      .put(`/v1/invoices/external/X-${ext}`)
      .send({ customerId: cust, deliveryOrderIds: [doB] });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(await db.invoice.count({ where: { externalId: `X-${ext}` } })).toBe(0);

    // DB: externalId ตั้งได้ตอนสร้างเท่านั้น
    await expect(
      db.invoice.update({ where: { id: uuid('invoice', b1.body.id) }, data: { externalId: 'Z' } }),
    ).rejects.toThrow(/invoice_external_id_once|external_id is set only on create/);
  });

  it('payments: PUT 201 → ซ้ำ 200 ไม่บันทึกซ้ำ · เนื้อหาต่าง 409 · ext: ใน path · กลับรายการด้วย ext: · แยก tenant', async () => {
    const cust = await newCustomer(0);
    const inv = await issued(0, cust, '10000.00');
    const ext = `ERP-RCV-${++seed}`;
    const body = {
      receivedDate: today,
      method: 'TRANSFER',
      amountReceived: '9900.00',
      whtAmount: '100.00',
      reference: 'KBANK-1',
      allocations: [{ invoiceId: inv, amount: '10000.00' }],
    };
    const c1 = await http(0).put(`/v1/payments/external/${ext}`).send(body);
    expect(c1.status, JSON.stringify(c1.body)).toBe(201);
    expect(c1.body).toMatchObject({ externalId: ext, status: 'RECORDED' });
    const c2 = await http(0).put(`/v1/payments/external/${ext}`).send(body);
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);
    expect(c2.body.id).toBe(c1.body.id);
    expect(c2.body.version).toBe(c1.body.version);
    expect(await db.payment.count({ where: { externalId: ext } })).toBe(1);
    // ยอดตัดครั้งเดียว → ใบ PAID
    expect((await http(0).get(`/v1/invoices/${inv}`).expect(200)).body.status).toBe('PAID');

    // เนื้อหาต่าง → 409 conflict (แก้ไม่ได้) · If-Match ไม่ตรง 412
    const diff = await http(0)
      .put(`/v1/payments/external/${ext}`)
      .send({ ...body, reference: 'KBANK-2' });
    expect(diff.status).toBe(409);
    expect(diff.body).toMatchObject({ code: 'conflict', id: c1.body.id });
    expect(
      (await http(0).put(`/v1/payments/external/${ext}`).set('If-Match', '"9"').send(body)).status,
    ).toBe(412);
    // ไม่มี PATCH external (การรับชำระแก้ไม่ได้)
    expect((await http(0).patch(`/v1/payments/external/${ext}`).send({})).status).toBe(404);

    // ext: ใน path
    const one = await http(0).get(`/v1/payments/ext:${ext}`).expect(200);
    expect(one.body.id).toBe(c1.body.id);
    expect((await http(0).get(`/v1/payments/ext:NOPE-${seed}`)).status).toBe(404);
    const rev = await http(0)
      .post(`/v1/payments/ext:${ext}/reverse`)
      .set('If-Match', `"${one.body.version}"`)
      .send({ reason: 'ERP แจ้งกลับรายการ' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(rev.body.status).toBe('REVERSED');
    // ส่งซ้ำหลังกลับรายการ = แถวเดิม (ไม่บันทึกใหม่)
    const replay = await http(0).put(`/v1/payments/external/${ext}`).send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('REVERSED');
    expect(await db.payment.count({ where: { externalId: ext } })).toBe(1);

    // externalId ผิดรูปแบบ 422
    const bad = await http(0).put(`/v1/payments/external/${'x'.repeat(101)}`).send(body);
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'externalId' });

    // แยก tenant
    expect((await http(1).get(`/v1/payments/ext:${ext}`)).status).toBe(404);
    const custB = await newCustomer(1);
    const invB = await issued(1, custB, '500.00');
    const b1 = await http(1)
      .put(`/v1/payments/external/${ext}`)
      .send({ ...body, amountReceived: '500.00', whtAmount: '0', allocations: [{ invoiceId: invB, amount: '500.00' }] });
    expect(b1.status, JSON.stringify(b1.body)).toBe(201);
    expect(b1.body.id).not.toBe(c1.body.id);
    // A อ้างใบของ B ไม่ได้
    const cross = await http(0)
      .put(`/v1/payments/external/X-${ext}`)
      .send({ ...body, amountReceived: '500.00', whtAmount: '0', allocations: [{ invoiceId: invB, amount: '500.00' }] });
    expect(cross.status).toBe(422);

    // DB: externalId ตั้งได้ตอนบันทึกเท่านั้น
    await expect(
      db.payment.update({ where: { id: uuid('payment', b1.body.id) }, data: { externalId: 'Z' } }),
    ).rejects.toThrow(/payment_external_id_once|external_id is set only on create/);
  });

  it('payments: PUT พร้อมกัน externalId เดียวกัน → บันทึกครั้งเดียว', async () => {
    const cust = await newCustomer(0);
    const inv = await issued(0, cust, '3000.00');
    const ext = `ERP-RCV-RACE-${++seed}`;
    const body = {
      receivedDate: today,
      method: 'TRANSFER',
      amountReceived: '1000.00',
      allocations: [{ invoiceId: inv, amount: '1000.00' }],
    };
    const rs = await Promise.all(
      [0, 1, 2].map(() => http(0).put(`/v1/payments/external/${ext}`).send(body)),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await db.payment.count({ where: { externalId: ext } })).toBe(1);
    expect((await http(0).get(`/v1/invoices/${inv}`).expect(200)).body.sellPaidAmount).toBe(
      '1000.00',
    );
  });
});
