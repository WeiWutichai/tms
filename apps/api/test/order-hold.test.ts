import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST3-T07 หน้าใบค้าง (docs/04 C "หน้าใบค้าง + reason code ครบชุด") — เกณฑ์ตรวจรับ:
 * order ที่ CUSTOMER_UNMAPPED เคลียร์จากหน้านี้แล้วกลับ RECEIVED · ไม่มี order ค้างที่ไม่มี reason code (constraint)
 * + ตัวกรอง/ตัวนับของหน้า, ตรวจอีกครั้ง (RATE_MISSING / GEOCODING_ERROR), ยืนยันข้อมูลต้นทาง (SOURCE_ERROR)
 */
describe('hold page (ใบค้าง)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let reader: string;
  let vt6: string;
  let seed = 0;
  const today = bangkokToday();
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const pub = (id: string) => encodeId('salesOrder', id);

  async function company(tid: string) {
    const c = await db.company.create({
      data: {
        tenantId: tid,
        legalName: `บริษัท ผู้ออกบิล ${++seed}`,
        taxId: validTaxId(800 + seed),
      },
    });
    await db.branch.create({
      data: {
        tenantId: tid,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ใบค้าง' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
    reader = await tokenFor(tenantId, 'orders:read');
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body.data;
    vt6 = uuid('vehicleType', types.find((t: { code: string }) => t.code === '6W').id);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const upsert = (input: UpsertOrderInput, tid = tenantId) =>
    app
      .get(DbService)
      .withTenant(tid, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId: tid, actorId: 'user-test', locale: 'th', tx },
          () => app.get(OrderIntakeService).upsertOrder(input),
        ),
      );
  const newSite = async (name: string, customer?: string) =>
    uuid(
      'site',
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({
            name,
            kind: 'DROPOFF',
            address: ADDR,
            ...(customer ? { customerId: encodeId('customer', customer) } : {}),
          })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async (extra: object = {}) =>
    uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ใบค้าง ${++seed}`, taxId: validTaxId(9600 + seed), ...extra })
          .expect(201)
      ).body.id,
    );
  const approveRate = async (customer: string, origin: string, dest: string) => {
    const r = (
      await api(app, admin)
        .post('/v1/rate-cards')
        .send({
          customerId: encodeId('customer', customer),
          originId: encodeId('site', origin),
          destinationId: encodeId('site', dest),
          vehicleTypeId: encodeId('vehicleType', vt6),
          validFrom: addDays(today, -30),
          pricingModel: 'PER_TRIP',
          sellRate: '3800',
        })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${r.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
  };
  const order = (
    ext: string,
    o: { custExt?: string; custId?: string; origin: string; dest: string; issues?: string[] },
  ): UpsertOrderInput => ({
    source: 'ERP:krs',
    externalId: ext,
    customer: o.custId ? { id: o.custId } : { externalId: o.custExt ?? null, text: 'ลูกค้าต้นทาง' },
    requestedDate: today,
    vehicleTypeId: vt6,
    stops: [
      { type: 'PICKUP', siteId: o.origin },
      { type: 'DELIVERY', siteId: o.dest },
    ],
    ...(o.issues ? { sourceIssues: o.issues } : {}),
  });
  const etag = async (id: string) =>
    (
      await api(app, admin)
        .get(`/v1/orders/${pub(id)}`)
        .expect(200)
    ).headers.etag!;
  const held = async (q = '', token = admin) =>
    (await api(app, token).get(`/v1/orders?held=true&limit=200${q}`).expect(200)).body.data as {
      id: string;
      status: string;
      holdReason: { code: string } | null;
      holdCodes: string[];
    }[];
  const counts = async () =>
    Object.fromEntries(
      (
        (await api(app, admin).get('/v1/orders/summary').expect(200)).body.holdReasons as {
          code: string;
          count: number;
        }[]
      ).map((x) => [x.code, x.count]),
    );

  it('เกณฑ์ตรวจรับ: CUSTOMER_UNMAPPED อยู่ในตารางใบค้าง → map ลูกค้าจากหน้านี้ → กลับ RECEIVED และหายจากตาราง', async () => {
    const cust = await newCustomer();
    const origin = await newSite('คลังต้นทาง ใบค้าง 1');
    const dest = await newSite('ปลายทาง ใบค้าง 1', cust);
    await approveRate(cust, origin, dest);
    const a = await upsert(order('HOLD-1', { custExt: 'NSF-404', origin, dest }));
    expect(a.order.status).toBe('ON_HOLD');

    const rows = await held('&holdReason=CUSTOMER_UNMAPPED');
    const row = rows.find((r) => r.id === pub(a.order.id))!;
    expect(row).toMatchObject({ status: 'on_hold', holdReason: { code: 'CUSTOMER_UNMAPPED' } });
    expect(rows.every((r) => r.status === 'on_hold')).toBe(true);
    const c0 = await counts();
    expect(Object.keys(c0)).toHaveLength(12);
    expect(c0.CUSTOMER_UNMAPPED).toBe(1);

    const m = await api(app, admin)
      .post(`/v1/orders/${pub(a.order.id)}/map-customer`)
      .set('If-Match', await etag(a.order.id))
      .send({ customerId: encodeId('customer', cust) })
      .expect(200);
    expect(m.body).toMatchObject({ status: 'received', holdReason: null, holdCodes: [] });
    expect((await held()).some((r) => r.id === pub(a.order.id))).toBe(false);
    expect((await counts()).CUSTOMER_UNMAPPED).toBe(0);
    // held=false = ไม่รวมใบค้าง
    const notHeld = (await api(app, admin).get('/v1/orders?held=false&limit=200').expect(200)).body
      .data as { id: string; status: string }[];
    expect(notHeld.some((r) => r.id === pub(a.order.id))).toBe(true);
    expect(notHeld.every((r) => r.status !== 'on_hold')).toBe(true);
    await api(app, admin).get('/v1/orders?held=yes').expect(422);
  });

  it('constraint: ไม่มี order ค้างที่ไม่มี reason code · พ้นค้างแล้วไม่เหลือเหตุ', async () => {
    const cust = await newCustomer();
    const origin = await newSite('คลังต้นทาง ใบค้าง 2');
    const dest = await newSite('ปลายทาง ใบค้าง 2', cust);
    const a = await upsert(order('HOLD-2', { custId: cust, origin, dest }));
    expect(a.order.status).toBe('ON_HOLD'); // RATE_MISSING
    await expect(
      db.salesOrder.update({ where: { id: a.order.id }, data: { holdReasonCodeId: null } }),
    ).rejects.toThrow(/sales_order_hold_reason/);
    await expect(
      db.salesOrder.update({ where: { id: a.order.id }, data: { status: 'RECEIVED' } }),
    ).rejects.toThrow(/sales_order_hold_reason/);
    const n = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM sales_order WHERE status = 'ON_HOLD' AND hold_reason_code_id IS NULL`;
    expect(Number(n[0]!.n)).toBe(0);
  });

  it('RATE_MISSING: เพิ่ม/อนุมัติ rate card แล้ว "ตรวจอีกครั้ง" → RECEIVED · ผลเดิมไม่เพิ่ม version · 412/403/409/404', async () => {
    const cust = await newCustomer();
    const origin = await newSite('คลังต้นทาง ใบค้าง 3');
    const dest = await newSite('ปลายทาง ใบค้าง 3', cust);
    const a = await upsert(order('HOLD-3', { custId: cust, origin, dest }));
    expect(a.order.holdReasonCode?.code).toBe('RATE_MISSING');
    const id = pub(a.order.id);

    // ยังไม่มี rate → ผลเหมือนเดิม: ค้างต่อ version ไม่เปลี่ยน
    const tag = await etag(a.order.id);
    const same = await api(app, admin)
      .post(`/v1/orders/${id}/reevaluate`)
      .set('If-Match', tag)
      .expect(200);
    expect(same.body).toMatchObject({ status: 'on_hold', holdReason: { code: 'RATE_MISSING' } });
    expect(same.headers.etag).toBe(tag);
    await api(app, admin).post(`/v1/orders/${id}/reevaluate`).set('If-Match', '"999"').expect(412);
    await api(app, reader).post(`/v1/orders/${id}/reevaluate`).expect(403);
    await api(app, other).post(`/v1/orders/${id}/reevaluate`).expect(404);

    await approveRate(cust, origin, dest);
    const ok = await api(app, admin).post(`/v1/orders/${id}/reevaluate`).expect(200);
    expect(ok.body).toMatchObject({
      status: 'received',
      holdReason: null,
      pricingStatus: 'AVAILABLE',
      sellTotal: '3800.00',
    });
    expect(ok.headers.etag).not.toBe(tag);
    const hist = await db.docStatusHistory.findMany({
      where: { docId: a.order.id },
      orderBy: { at: 'asc' },
    });
    expect(hist.at(-1)).toMatchObject({ fromStatus: 'ON_HOLD', toStatus: 'RECEIVED' });

    // หลังวางแผน → 409 (ประเมินใหม่ได้เฉพาะก่อนวางแผน)
    await db.salesOrder.update({ where: { id: a.order.id }, data: { status: 'PLANNED' } });
    const r = await api(app, admin).post(`/v1/orders/${id}/reevaluate`).expect(409);
    expect(r.body).toMatchObject({ code: 'invalid_state_transition', from: 'PLANNED' });
  });

  it('GEOCODING_ERROR: สถานที่หาพิกัดไม่ได้ → ค้าง · ปักพิกัดแล้ว "ตรวจอีกครั้ง" → RECEIVED', async () => {
    const cust = await newCustomer();
    const origin = await newSite('คลังต้นทาง ใบค้าง 4');
    const dest = await newSite('ปลายทาง ใบค้าง 4', cust);
    await approveRate(cust, origin, dest);
    await db.customerSite.update({ where: { id: dest }, data: { geocodeStatus: 'FAILED' } });
    const a = await upsert(order('HOLD-4', { custId: cust, origin, dest }));
    expect(a.order.status).toBe('ON_HOLD');
    expect(a.order.holdReasonCode?.code).toBe('GEOCODING_ERROR');
    expect(a.order.holdNote).toContain('จุดที่ 2 หาพิกัดสถานที่ไม่ได้');
    expect((await counts()).GEOCODING_ERROR).toBe(1);
    const rows = await held('&holdReason=GEOCODING_ERROR');
    expect(rows.map((r) => r.id)).toEqual([pub(a.order.id)]);
    expect(rows[0]!.holdCodes).toEqual(['GEOCODING_ERROR']);

    // ปักพิกัดในข้อมูลหลัก (ผ่าน API) → ตรวจอีกครั้ง
    const site = await api(app, admin)
      .get(`/v1/customer-sites/${encodeId('site', dest)}`)
      .expect(200);
    await api(app, admin)
      .patch(`/v1/customer-sites/${encodeId('site', dest)}`)
      .set('If-Match', site.headers.etag!)
      .send({ lat: 13.3611, lng: 100.9847 })
      .expect(200);
    const ok = await api(app, admin)
      .post(`/v1/orders/${pub(a.order.id)}/reevaluate`)
      .expect(200);
    expect(ok.body).toMatchObject({ status: 'received', holdReason: null, holdCodes: [] });
  });

  it('SOURCE_ERROR: ยืนยันข้อมูลใบ (เหตุผล ≥ 10 + audit) → ประเมินใหม่ · ไม่มีปัญหาค้าง = 409 · ไม่มีเหตุผล = 422', async () => {
    const cust = await newCustomer();
    const origin = await newSite('คลังต้นทาง ใบค้าง 5');
    const dest = await newSite('ปลายทาง ใบค้าง 5', cust);
    await approveRate(cust, origin, dest);
    const a = await upsert(
      order('HOLD-5', { custId: cust, origin, dest, issues: ['ไม่มีวันรับของจากต้นทาง'] }),
    );
    expect(a.order.holdReasonCode?.code).toBe('SOURCE_ERROR');
    const id = pub(a.order.id);
    const url = `/v1/orders/${id}/resolve-source-error`;
    await api(app, admin).post(url).send({}).expect(422);
    await api(app, admin).post(url).send({ reason: 'สั้นไป' }).expect(422);
    await api(app, reader).post(url).send({ reason: 'ตรวจกับเอกสารต้นฉบับแล้ว' }).expect(403);
    await api(app, other).post(url).send({ reason: 'ตรวจกับเอกสารต้นฉบับแล้ว' }).expect(404);
    await api(app, admin)
      .post(url)
      .set('If-Match', '"999"')
      .send({ reason: 'ตรวจกับเอกสารต้นฉบับแล้ว' })
      .expect(412);
    const ok = await api(app, admin)
      .post(url)
      .send({ reason: 'ตรวจกับเอกสารต้นฉบับแล้ว วันรับของถูกต้อง' })
      .expect(200);
    expect(ok.body).toMatchObject({ status: 'received', holdReason: null });
    const row = await db.salesOrder.findUniqueOrThrow({ where: { id: a.order.id } });
    expect(row.sourceIssues).toEqual([]);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: a.order.id, action: 'sales_order.source_error_resolved' },
    });
    expect(audit).toMatchObject({
      reason: 'ตรวจกับเอกสารต้นฉบับแล้ว วันรับของถูกต้อง',
      before: { sourceIssues: ['ไม่มีวันรับของจากต้นทาง'] },
    });
    const again = await api(app, admin)
      .post(url)
      .send({ reason: 'ตรวจกับเอกสารต้นฉบับแล้ว' })
      .expect(409);
    expect(again.body.code).toBe('invalid_state_transition');

    // ต้นทางส่งค่าเดิมซ้ำ (hash เดิม) → ไม่ค้างกลับ · ต้นทางแก้แล้วยังมีปัญหาใหม่ → ค้าง SOURCE_ERROR ชุดใหม่
    const re = await upsert(
      order('HOLD-5', { custId: cust, origin, dest, issues: ['ไม่มีวันรับของจากต้นทาง'] }),
    );
    expect(re.order.status).toBe('RECEIVED');
    const re2 = await upsert(
      order('HOLD-5', { custId: cust, origin, dest, issues: ['จำนวนสินค้าไม่ใช่ตัวเลข'] }),
    );
    expect(re2.order.holdReasonCode?.code).toBe('SOURCE_ERROR');
  });

  it('ใบค้างของอีก tenant ไม่ปนในตาราง/ตัวนับ', async () => {
    const origin = await newSite('คลังต้นทาง ใบค้าง 6');
    const mine = await held();
    const theirs = await held('', other);
    expect(theirs).toEqual([]);
    const otherOrigin = (
      await api(app, other)
        .post('/v1/customer-sites')
        .send({ name: 'คลังอื่น', kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id;
    await upsert(
      {
        source: 'ERP:krs',
        externalId: 'HOLD-OTHER',
        customer: { externalId: 'X-1', text: 'อื่น' },
        requestedDate: today,
        stops: [
          { type: 'PICKUP', siteId: uuid('site', otherOrigin) },
          { type: 'DELIVERY', siteText: 'ไม่รู้จัก' },
        ],
      },
      otherId,
    );
    expect((await held()).map((r) => r.id)).toEqual(mine.map((r) => r.id));
    expect(origin).toBeTruthy();
  });
});
