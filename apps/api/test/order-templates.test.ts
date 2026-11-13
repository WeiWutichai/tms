import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST3-T02 เทมเพลตงานประจำ (`/v1/order-templates`) + ส่วน API ที่ฟอร์มใบสั่งใช้ (`editableFields`, `/orders/summary`)
 * เกณฑ์ตรวจรับ: duplicate ภายใน 3 คลิกได้ข้อมูลครบเท่าต้นฉบับ (ฝั่ง API = GET ใบเดิม → POST ใบใหม่ได้ข้อมูลเดียวกัน)
 */
describe('order templates + form API (ST3-T02)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let vt6: string;
  let unitTon: string;
  let seed = 0;
  const today = bangkokToday();
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  async function company(tid: string) {
    const c = await db.company.create({
      data: { tenantId: tid, legalName: `บริษัท ออกบิล ${++seed}`, taxId: validTaxId(800 + seed) },
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง เทมเพลต' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง อื่น' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body.data;
    vt6 = types.find((t: { code: string }) => t.code === '6W').id;
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data;
    unitTon = us.find((u: { code: string }) => u.code === 'TON').id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const newSite = async () =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body as { id: string; name: string };
  const newCustomer = async () =>
    (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า เทมเพลต ${++seed}`, taxId: validTaxId(9700 + seed) })
        .expect(201)
    ).body as { id: string; code: string; legalName: string };

  const payload = async () => {
    const c = await newCustomer();
    const a = await newSite();
    const b = await newSite();
    return {
      customer: c,
      body: {
        customer: { id: c.id },
        customerRef: 'PO-REF-1',
        requestedDate: today,
        vehicleTypeId: vt6,
        stops: [
          {
            type: 'PICKUP',
            siteId: a.id,
            siteText: a.name,
            windowStart: `${today}T07:00:00+07:00`,
            windowEnd: `${today}T09:00:00+07:00`,
          },
          {
            type: 'DELIVERY',
            siteId: b.id,
            siteText: b.name,
            windowStart: `${today}T13:00:00+07:00`,
            windowEnd: `${today}T16:00:00+07:00`,
          },
        ],
        lines: [{ description: 'น้ำดื่ม', qty: '012.50', unitId: unitTon, weightKg: '12500' }],
      },
    };
  };

  it('บันทึก → อ่าน/รายการ/ค้นชื่อ → แก้ (If-Match) → ลบ (เหตุผล) · payload เก็บรูปมาตรฐาน · audit ทุกครั้ง', async () => {
    const { customer, body } = await payload();
    const created = await api(app, admin)
      .post('/v1/order-templates')
      .send({ name: 'ส่งน้ำดื่ม ทุกจันทร์', payload: body })
      .expect(201);
    expect(created.headers.etag).toBe('"1"');
    const t = created.body;
    expect(t.id).toMatch(/^otp_[0-9a-f]{32}$/);
    expect(t.customer).toEqual({
      id: customer.id,
      code: customer.code,
      legalName: customer.legalName,
    });
    // รูปมาตรฐาน: ทศนิยมตัด 0 นำหน้า เวลาเป็น UTC
    expect(t.payload.lines[0].qty).toBe('12.5');
    expect(t.payload.stops[0].windowStart).toBe(new Date(`${today}T07:00:00+07:00`).toISOString());
    expect(t.payload.stops[1].siteText).toBe(body.stops[1]!.siteText);
    expect(t.payload).not.toHaveProperty('draft');

    const got = await api(app, admin).get(`/v1/order-templates/${t.id}`).expect(200);
    expect(got.body).toEqual(t);
    const list = await api(app, admin).get('/v1/order-templates?q=ทุกจันทร์').expect(200);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect(
      (await api(app, admin).get('/v1/order-templates?q=ไม่มี').expect(200)).body.data,
    ).toEqual([]);

    await api(app, admin)
      .patch(`/v1/order-templates/${t.id}`)
      .set('If-Match', '"9"')
      .send({ name: 'x' })
      .expect(412);
    const upd = await api(app, admin)
      .patch(`/v1/order-templates/${t.id}`)
      .set('If-Match', '"1"')
      .send({ name: 'ส่งน้ำดื่ม ทุกอังคาร' })
      .expect(200);
    expect(upd.body.name).toBe('ส่งน้ำดื่ม ทุกอังคาร');
    expect(upd.body.version).toBe(2);
    expect(upd.body.payload).toEqual(t.payload);

    await api(app, admin)
      .post(`/v1/order-templates/${t.id}/delete`)
      .send({ reason: 'สั้น' })
      .expect(422);
    await api(app, admin)
      .post(`/v1/order-templates/${t.id}/delete`)
      .set('If-Match', '"2"')
      .send({ reason: 'ลูกค้าเลิกส่งงานประจำนี้แล้ว' })
      .expect(204);
    await api(app, admin).get(`/v1/order-templates/${t.id}`).expect(404);
    const row = await db.orderTemplate.findUnique({
      where: { id: tryDecodeId('orderTemplate', t.id)! },
    });
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedReason).toBe('ลูกค้าเลิกส่งงานประจำนี้แล้ว');
    const audit = await db.auditLog.findMany({
      where: { tenantId, entityType: 'order_template', entityId: row!.id },
      orderBy: { seq: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'order_template.created',
      'order_template.updated',
      'order_template.deleted',
    ]);
    expect(audit[2]!.reason).toBe('ลูกค้าเลิกส่งงานประจำนี้แล้ว');
    // ลบแล้วตั้งชื่อเดิมใหม่ได้
    await api(app, admin)
      .post('/v1/order-templates')
      .send({ name: 'ส่งน้ำดื่ม ทุกอังคาร', payload: body })
      .expect(201);
  });

  it('ชื่อซ้ำ (ไม่สนตัวพิมพ์) → 409 · payload ผิดรูป → 422 รวมช่อง `payload.…` · ช่องแปลกปลอม/null → 422', async () => {
    const { body } = await payload();
    await api(app, admin)
      .post('/v1/order-templates')
      .send({ name: 'Weekly Run', payload: body })
      .expect(201);
    const dup = await api(app, admin)
      .post('/v1/order-templates')
      .send({ name: 'weekly run', payload: body })
      .expect(409);
    expect(dup.body.code).toBe('duplicate');
    // `_` ไม่ใช่ wildcard (iEquals)
    await api(app, admin)
      .post('/v1/order-templates')
      .send({ name: 'Weekly_Run', payload: body })
      .expect(201);

    const bad = await api(app, admin)
      .post('/v1/order-templates')
      .send({
        name: 'ผิดรูป',
        payload: {
          ...body,
          requestedDate: '2026-02-30',
          stops: [{ type: 'PICKUP', siteId: 'loc_zz' }],
          lines: [{ description: 'x', qty: '0', unit: 'ตัน' }],
        },
      })
      .expect(422);
    const fields = bad.body.errors.map((e: { field: string }) => e.field).sort();
    expect(fields).toEqual(
      ['payload.lines[0].qty', 'payload.requestedDate', 'payload.stops[0].siteId'].sort(),
    );
    await api(app, admin)
      .post('/v1/order-templates')
      .send({ name: 'มีช่องแปลก', payload: { ...body, draft: true } })
      .expect(422);
    await api(app, admin)
      .post('/v1/order-templates')
      .send({ name: 'null', payload: null })
      .expect(422);
    await api(app, admin)
      .post('/v1/order-templates')
      .send({ name: '   ', payload: body })
      .expect(422);
  });

  it('สิทธิ์: orders:read อ่านได้แต่บันทึก/แก้/ลบไม่ได้ · ไม่มี orders:read = 403 · บริษัทอื่น = 404', async () => {
    const { body } = await payload();
    const t = (
      await api(app, admin)
        .post('/v1/order-templates')
        .send({ name: 'สิทธิ์', payload: body })
        .expect(201)
    ).body;
    const reader = await tokenFor(tenantId, 'orders:read');
    const none = await tokenFor(tenantId, 'customers:read');
    await api(app, reader).get(`/v1/order-templates/${t.id}`).expect(200);
    await api(app, reader).get('/v1/order-templates').expect(200);
    await api(app, reader)
      .post('/v1/order-templates')
      .send({ name: 'อ่านอย่างเดียว', payload: body })
      .expect(403);
    await api(app, reader).patch(`/v1/order-templates/${t.id}`).send({ name: 'y' }).expect(403);
    await api(app, reader)
      .post(`/v1/order-templates/${t.id}/delete`)
      .send({ reason: 'ไม่มีสิทธิ์ลบเทมเพลตนี้' })
      .expect(403);
    await api(app, none).get('/v1/order-templates').expect(403);

    await api(app, other).get(`/v1/order-templates/${t.id}`).expect(404);
    await api(app, other).patch(`/v1/order-templates/${t.id}`).send({ name: 'z' }).expect(404);
    await api(app, other)
      .post(`/v1/order-templates/${t.id}/delete`)
      .send({ reason: 'ลบข้ามบริษัทไม่ได้แน่นอน' })
      .expect(404);
    expect((await api(app, other).get('/v1/order-templates').expect(200)).body.data).toEqual([]);
    // ชื่อซ้ำข้ามบริษัทได้ (unique ต่อบริษัท)
    await api(app, other)
      .post('/v1/order-templates')
      .send({
        name: 'สิทธิ์',
        payload: { requestedDate: today, stops: [{ type: 'PICKUP', siteText: 'คลัง' }] },
      })
      .expect(201);
  });

  it('สร้างใบจากเทมเพลต = POST /orders ด้วย payload (ไม่มี endpoint ลัด) · เทมเพลตไม่เก็บ PO · ช่องสินค้าครบทุกช่อง (อันตราย/อุณหภูมิ/ปริมาตร) · คัดลอก (body = ทุกช่องของใบเดิม) ได้ข้อมูลเท่าต้นฉบับ', async () => {
    const { body } = await payload();
    const full = {
      ...body,
      lines: [
        {
          description: 'สารเคมีแช่เย็น',
          qty: '3',
          unitId: unitTon,
          itemCode: 'CHEM-01',
          weightKg: '3000',
          cbm: '4.5',
          isDangerous: true,
          tempMin: '2',
          tempMax: '8',
        },
      ],
    };
    const t = (
      await api(app, admin)
        .post('/v1/order-templates')
        .send({ name: 'ใช้สร้างใบ', payload: full })
        .expect(201)
    ).body;
    expect(t.payload.customerRef).toBeNull();
    expect(t.payload.lines[0]).toMatchObject({
      itemCode: 'CHEM-01',
      cbm: '4.5',
      isDangerous: true,
      tempMin: '2',
      tempMax: '8',
    });
    const fromTpl = await api(app, admin)
      .post('/v1/orders')
      .send({ ...t.payload, draft: true })
      .expect(201);
    expect(fromTpl.body.status).toBe('draft');
    expect(fromTpl.body.source).toBe('API'); // dev token = API client (ผู้ใช้หน้าจอ = MANUAL)
    expect(fromTpl.body.editableFields).toContain('stops');
    expect(fromTpl.body.lines[0]).toMatchObject({
      isDangerous: true,
      tempMin: '2',
      tempMax: '8',
      cbm: '4.5',
    });

    // duplicate (ORD-022): ทุกช่องของจุด/สินค้าของใบเดิมส่งกลับได้ตรง ๆ (การแปลงของฟอร์มทดสอบใน web orderForm.test.ts)
    const src = (await api(app, admin).get(`/v1/orders/${fromTpl.body.id}`).expect(200)).body;
    const copy = (
      await api(app, admin)
        .post('/v1/orders')
        .send({
          draft: true,
          customer: { id: src.customer.id },
          billingCompanyId: src.billingCompanyId,
          requestedDate: src.requestedDate,
          vehicleTypeId: src.vehicleTypeId,
          stops: src.stops.map(({ sequence: _s, ...x }: Record<string, unknown>) => x),
          lines: src.lines.map(({ lineNo: _n, ...x }: Record<string, unknown>) => x),
        })
        .expect(201)
    ).body;
    expect(copy.id).not.toBe(src.id);
    expect(copy.externalId).toBeNull();
    expect(copy.customerRef).toBeNull();
    const strip = (o: Record<string, unknown>) => ({
      customer: o.customer,
      billingCompanyId: o.billingCompanyId,
      vehicleTypeId: o.vehicleTypeId,
      stops: o.stops,
      lines: o.lines,
    });
    expect(strip(copy)).toEqual(strip(src));
  });

  it('อ้างอิงที่ไม่มีในบริษัทนี้ (รวมของบริษัทอื่น) → 422 reference_not_found ที่ช่องนั้น', async () => {
    const { body } = await payload();
    const otherCust = (
      await api(app, other)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้าบริษัทอื่น ${++seed}`, taxId: validTaxId(9900 + seed) })
        .expect(201)
    ).body.id;
    const otherSite = (
      await api(app, other)
        .post('/v1/customer-sites')
        .send({ name: `จุดบริษัทอื่น ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id;
    const r = await api(app, admin)
      .post('/v1/order-templates')
      .send({
        name: 'อ้างข้ามบริษัท',
        payload: {
          ...body,
          customer: { id: otherCust },
          stops: [body.stops[0], { ...body.stops[1], siteId: otherSite }],
        },
      })
      .expect(422);
    expect(
      r.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`).sort(),
    ).toEqual([
      'payload.customer.id:reference_not_found',
      'payload.stops[1].siteId:reference_not_found',
    ]);
  });

  it('GET /orders/{id} มี editableFields ตามสถานะ · /orders/summary นับร่าง/ค้าง/วางแผน/เกินกำหนด', async () => {
    const { body } = await payload();
    const o = (await api(app, admin).post('/v1/orders').send(body).expect(201)).body;
    expect(o.editableFields).toEqual(expect.arrayContaining(['customer', 'stops', 'lines']));
    await db.salesOrder.update({
      where: { id: tryDecodeId('salesOrder', o.id)! },
      data: { status: 'PLANNED', holdReasonCodeId: null },
    });
    const planned = (await api(app, admin).get(`/v1/orders/${o.id}`).expect(200)).body;
    expect(planned.editableFields).toEqual(['customerRef', 'stops.window']);
    await db.salesOrder.update({
      where: { id: tryDecodeId('salesOrder', o.id)! },
      data: { status: 'CANCELLED', holdReasonCodeId: null },
    });
    expect(
      (await api(app, admin).get(`/v1/orders/${o.id}`).expect(200)).body.editableFields,
    ).toEqual([]);
    // ไม่อยู่ในรายการ
    const list = (await api(app, admin).get('/v1/orders?limit=5').expect(200)).body.data;
    expect(list[0]).not.toHaveProperty('editableFields');

    // ใบค้าง: สถานที่ยังจับคู่ไม่ได้ (ข้อความ) + ลูกค้าไม่รู้จัก
    await api(app, admin)
      .post('/v1/orders')
      .send({ ...body, stops: [{ type: 'PICKUP', siteText: 'คลังไม่รู้จัก' }, body.stops[1]] })
      .expect(201);
    await api(app, admin)
      .post('/v1/orders')
      .send({ ...body, customer: { externalId: 'NO-SUCH', name: 'ลูกค้าไม่รู้จัก' } })
      .expect(201);
    await api(app, admin)
      .post('/v1/orders')
      .send({ ...body, draft: true })
      .expect(201);
    const s = (await api(app, admin).get('/v1/orders/summary').expect(200)).body;
    const all = await db.salesOrder.groupBy({ by: ['status'], where: { tenantId }, _count: true });
    const n = (st: string) => all.find((x) => x.status === st)?._count ?? 0;
    expect(s.total).toBe(all.reduce((a, x) => a + x._count, 0));
    expect(s.draft).toBe(n('DRAFT'));
    expect(s.onHold).toBe(n('ON_HOLD'));
    expect(s.locationUnmapped).toBeGreaterThanOrEqual(1);
    expect(s.customerUnmapped).toBeGreaterThanOrEqual(1);
    expect(s.planned).toBe(n('PLANNED'));
    expect(typeof s.overdue).toBe('number');
    expect((await api(app, other).get('/v1/orders/summary').expect(200)).body.total).toBe(0);
    await api(app, await tokenFor(tenantId, 'customers:read'))
      .get('/v1/orders/summary')
      .expect(403);
  });
});
