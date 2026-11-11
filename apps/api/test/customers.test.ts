import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const ADDR = { line1: '22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540' };

/** ST2-T01 ลูกค้า — slice ต้นแบบของ master ทุกตัว (docs/04 B กฎร่วม, spec/02 §0–1) */
describe('ลูกค้า (customers)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let seed = 3000;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const create = (body: object, token = admin) => api(app, token).post('/v1/customers').send(body);
  const newCustomer = async (extra: object = {}) =>
    (
      await create({
        legalName: `บจก. ตัวอย่าง ${++seed}`,
        taxId: validTaxId(seed),
        billingAddress: ADDR,
        ...extra,
      }).expect(201)
    ).body;

  it('สร้างได้ พร้อมรหัสอัตโนมัติ CUS-0001 และค่าเริ่มต้นตาม docs/01 §3.2', async () => {
    const c = await newCustomer({
      contacts: [{ name: 'คุณธีรพงษ์', phone: '02-317-4133', isPrimary: true }],
    });
    expect(c.id).toMatch(/^cus_[0-9a-f]{32}$/);
    expect(c.code).toBe('CUS-0001');
    expect(c.branchCode).toBe('00000');
    expect(c.creditTermDays).toBe(30);
    expect(c.billingCycle).toBe('MONTHLY');
    expect(c.taxInvoiceMode).toBe('ON_PAYMENT');
    expect(c.status).toBe('active');
    expect(c.contacts[0].name).toBe('คุณธีรพงษ์');
    const next = await api(app, admin).get('/v1/customers/next-code').expect(200);
    expect(next.body.code).toBe('CUS-0002');
  });

  it('เลขผู้เสียภาษี 13 หลักผิด check digit → 422', async () => {
    const good = validTaxId(42);
    const bad = good.slice(0, 12) + String((Number(good[12]) + 1) % 10);
    const res = await create({ legalName: 'บจก. ผิด', taxId: bad });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'taxId', code: 'thai_tax_id' });
    expect((await create({ legalName: 'บจก. สั้น', taxId: '12345' })).status).toBe(422);
    // รหัสสาขาต้อง 5 หลัก
    const b = await create({ legalName: 'บจก. สาขา', taxId: validTaxId(43), branchCode: '1' });
    expect(b.status).toBe(422);
    expect(b.body.errors[0].field).toBe('branchCode');
  });

  it('เลขผู้เสียภาษี + สาขาเดียวกันซ้ำ → 409 พร้อมรายการเดิม; สาขาต่างกันสร้างได้ (MD-020)', async () => {
    const a = await newCustomer();
    const dup = await create({ legalName: 'อีกราย', taxId: a.taxId, branchCode: '00000' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('duplicate');
    expect(dup.body.existing.code).toBe(a.code);
    await create({ legalName: 'สาขา 1', taxId: a.taxId, branchCode: '00001' }).expect(201);
  });

  it('แก้ด้วย If-Match: version ถูก → 200 + audit diff; version เก่า → 412', async () => {
    const c = await newCustomer();
    const r = await api(app, admin)
      .patch(`/v1/customers/${c.id}`)
      .set('If-Match', `"${c.version}"`)
      .send({ creditTermDays: 60, billingCycle: 'WEEKLY', etaxCapable: true, freeTimeMin: 120 })
      .expect(200);
    expect(r.body).toMatchObject({ creditTermDays: 60, billingCycle: 'WEEKLY', etaxCapable: true });
    expect(r.headers.etag).toBe(`"${c.version + 1}"`);
    await api(app, admin)
      .patch(`/v1/customers/${c.id}`)
      .set('If-Match', `"${c.version}"`)
      .send({ creditTermDays: 45 })
      .expect(412);
    const h = await api(app, admin).get(`/v1/customers/${c.id}/history`).expect(200);
    expect(h.body.data.map((e: { action: string }) => e.action)).toEqual([
      'customer.updated',
      'customer.created',
    ]);
    expect(h.body.data[0].before).toMatchObject({ creditTermDays: 30, billingCycle: 'MONTHLY' });
    expect(h.body.data[0].after).toMatchObject({ creditTermDays: 60, billingCycle: 'WEEKLY' });
  });

  it('ออกบิลในนาม: ต้องเป็นนิติบุคคลที่มีอยู่ (422 ถ้าไม่มี)', async () => {
    const co = await db.company.create({
      data: { tenantId, legalName: 'บจก. ศรีไทยขนส่ง', taxId: validTaxId(77) },
    });
    const { encodeId } = await import('../src/common/ids');
    const c = await newCustomer({ billingCompanyId: encodeId('company', co.id) });
    expect(c.billingCompanyId).toBe(encodeId('company', co.id));
    const bad = await create({
      legalName: 'บจก. ไม่มีบริษัท',
      billingCompanyId: 'cmp_00000000000000000000000000000000',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].field).toBe('billingCompanyId');
  });

  it('ลูกค้าที่มีเอกสารอ้างถึง: ลบไม่ได้ (409 in_use) แต่ปิดใช้ได้ (เหตุผล ≥ 10 ตัว)', async () => {
    const c = await newCustomer();
    const co = await db.company.create({
      data: { tenantId, legalName: 'บจก. ผู้ออกบิล', taxId: validTaxId(78) },
    });
    await db.salesOrder.create({
      data: {
        tenantId,
        source: 'MANUAL',
        customerId: tryDecodeId('customer', c.id)!,
        billingCompanyId: co.id,
        requestedDate: new Date('2026-11-20'),
      },
    });
    const del = await api(app, admin)
      .post(`/v1/customers/${c.id}/delete`)
      .send({ reason: 'สร้างผิดรายการ ทดสอบ' });
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('in_use');
    expect(del.body.references).toEqual({ salesOrders: 1 });

    // เหตุผลสั้นเกิน → 422
    await api(app, admin)
      .post(`/v1/customers/${c.id}/deactivate`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const off = await api(app, admin)
      .post(`/v1/customers/${c.id}/deactivate`)
      .send({ reason: 'เลิกใช้บริการตั้งแต่ ธ.ค. 2569' })
      .expect(200);
    expect(off.body.status).toBe('inactive');
    // ปิดซ้ำ → 409 transition ผิด
    await api(app, admin)
      .post(`/v1/customers/${c.id}/deactivate`)
      .send({ reason: 'เลิกใช้บริการตั้งแต่ ธ.ค. 2569' })
      .expect(409);
    const on = await api(app, admin).post(`/v1/customers/${c.id}/activate`).send({}).expect(200);
    expect(on.body.status).toBe('active');
    const h = await api(app, admin).get(`/v1/customers/${c.id}/history`).expect(200);
    const off1 = h.body.data.find((e: { action: string }) => e.action === 'customer.deactivated');
    expect(off1.reason).toBe('เลิกใช้บริการตั้งแต่ ธ.ค. 2569');
  });

  it('ลูกค้าที่ไม่เคยถูกอ้างอิง: ลบ = soft delete (หายจากรายการ/GET 404, แถวยังอยู่ + audit)', async () => {
    const c = await newCustomer();
    await api(app, admin)
      .post(`/v1/customers/${c.id}/delete`)
      .send({ reason: 'สร้างซ้ำโดยไม่ตั้งใจ' })
      .expect(204);
    await api(app, admin).get(`/v1/customers/${c.id}`).expect(404);
    const list = await api(app, admin)
      .get(`/v1/customers?q=${encodeURIComponent(c.code)}`)
      .expect(200);
    expect(list.body.data).toEqual([]);
    const row = await db.customer.findUnique({ where: { id: tryDecodeId('customer', c.id)! } });
    expect(row?.deletedAt).not.toBeNull();
    const audit = await db.auditLog.findFirst({
      where: { entityId: row!.id, action: 'customer.deleted' },
    });
    expect(audit?.reason).toBe('สร้างซ้ำโดยไม่ตั้งใจ');
  });

  it('PUT /customers/external/{id}: ครั้งแรก 201, ส่งซ้ำ 200 ไม่เกิดแถวใหม่', async () => {
    const body = { legalName: 'บจก. จากระบบต้นทาง', taxId: validTaxId(900), billingAddress: ADDR };
    const r1 = await api(app, admin)
      .put('/v1/customers/external/ERP-C-0001')
      .send(body)
      .expect(201);
    expect(r1.body.externalId).toBe('ERP-C-0001');
    const r2 = await api(app, admin)
      .put('/v1/customers/external/ERP-C-0001')
      .send(body)
      .expect(200);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.body.version).toBe(r1.body.version); // ไม่มีอะไรเปลี่ยน
    const r3 = await api(app, admin)
      .put('/v1/customers/external/ERP-C-0001')
      .send({ ...body, creditTermDays: 45 })
      .expect(200);
    expect(r3.body.id).toBe(r1.body.id);
    expect(r3.body.creditTermDays).toBe(45);
    expect(await db.customer.count({ where: { tenantId, externalId: 'ERP-C-0001' } })).toBe(1);
    // เรียกด้วย ext: ได้
    const g = await api(app, admin).get('/v1/customers/ext:ERP-C-0001').expect(200);
    expect(g.body.id).toBe(r1.body.id);
  });

  it('ค้นหา/กรอง + cursor + summary', async () => {
    const t2 = (await createTenant(db)).id;
    const tok = await tokenFor(t2);
    for (let i = 0; i < 3; i++)
      await create({ legalName: `บจก. ค้นหา ${i}`, taxId: validTaxId(1200 + i) }, tok).expect(201);
    const x = await create(
      { legalName: 'บมจ. ไทยเบฟ', taxId: validTaxId(1300), billingCycle: 'WEEKLY' },
      tok,
    ).expect(201);
    await api(app, tok)
      .post(`/v1/customers/${x.body.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้งาน' })
      .expect(200);

    const byName = await api(app, tok).get('/v1/customers?q=ไทยเบฟ').expect(200);
    expect(byName.body.data.map((c: { legalName: string }) => c.legalName)).toEqual([
      'บมจ. ไทยเบฟ',
    ]);
    const byTax = await api(app, tok)
      .get(`/v1/customers?q=${validTaxId(1201)}`)
      .expect(200);
    expect(byTax.body.data).toHaveLength(1);
    const inactive = await api(app, tok).get('/v1/customers?status=inactive').expect(200);
    expect(inactive.body.data).toHaveLength(1);
    const weekly = await api(app, tok).get('/v1/customers?billingCycle=WEEKLY').expect(200);
    expect(weekly.body.data).toHaveLength(1);

    const p1 = await api(app, tok).get('/v1/customers?limit=2').expect(200);
    expect(p1.body.hasMore).toBe(true);
    const p2 = await api(app, tok)
      .get(`/v1/customers?limit=2&cursor=${p1.body.nextCursor}`)
      .expect(200);
    expect(p2.body.hasMore).toBe(false);
    const ids = [...p1.body.data, ...p2.body.data].map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(4);

    const s = await api(app, tok).get('/v1/customers/summary').expect(200);
    expect(s.body).toEqual({ total: 4, active: 3, inactive: 1, noTaxId: 0 });
  });

  it('ส่งออก .xlsx / .csv ตามตัวกรอง (ต้องมี export:run)', async () => {
    await newCustomer({ legalName: '=HYPERLINK("x")' });
    const csv = await api(app, admin).get('/v1/customers/export?format=csv').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('customers.csv');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain('รหัส,ชื่อ,เลขผู้เสียภาษี');
    expect(csv.text).toContain(`"'=HYPERLINK(""x"")"`); // กัน formula injection
    const xlsx = await api(app, admin)
      .get('/v1/customers/export')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const viewer = await tokenFor(tenantId, 'master:read');
    await api(app, viewer).get('/v1/customers/export').expect(403);
  });

  it('สิทธิ์: master:read อ่านได้แต่แก้ไม่ได้ (403)', async () => {
    const c = await newCustomer();
    const viewer = await tokenFor(tenantId, 'master:read');
    await api(app, viewer).get(`/v1/customers/${c.id}`).expect(200);
    await api(app, viewer).get(`/v1/customers/${c.id}/history`).expect(200);
    await api(app, viewer).post('/v1/customers').send({ legalName: 'x' }).expect(403);
    await api(app, viewer).patch(`/v1/customers/${c.id}`).send({ creditTermDays: 1 }).expect(403);
    const none = await tokenFor(tenantId, 'orders:read');
    await api(app, none).get('/v1/customers').expect(403);
  });
  it('review: รหัสตัวเลขยาวเกินไม่ทำ next-code พัง (ไม่ overflow) + รหัสไม่สนตัวพิมพ์', async () => {
    const t = (await createTenant(db)).id;
    const tok = await tokenFor(t);
    await create({ legalName: 'บจก. รหัสยาว', code: 'CUS-99999999999' }, tok).expect(201);
    await create({ legalName: 'บจก. รหัสเล็ก', code: 'cus-0007' }, tok)
      .expect(201)
      .expect((r) => expect(r.body.code).toBe('CUS-0007'));
    const n = await api(app, tok).get('/v1/customers/next-code').expect(200);
    expect(n.body.code).toBe('CUS-0008');
    const dup = await create({ legalName: 'ซ้ำ', code: 'Cus-0007' }, tok);
    expect(dup.status).toBe(409);
    const auto = await create({ legalName: 'บจก. อัตโนมัติ' }, tok).expect(201);
    expect(auto.body.code).toBe('CUS-0008');
  });

  it('review: null ในช่องที่ห้ามว่าง → 422 (ไม่ใช่ 500)', async () => {
    const c = await newCustomer();
    for (const body of [
      { legalName: null },
      { billingCycle: null },
      { creditTermDays: null },
      { taxInvoiceMode: null },
      { vatRegistered: null },
      { etaxCapable: null },
      { contacts: null },
      { branchCode: null },
    ]) {
      const r = await api(app, admin).patch(`/v1/customers/${c.id}`).send(body);
      expect(r.status, JSON.stringify(body)).toBe(422);
    }
    expect((await create({ legalName: 'บจก. ว่าง', billingCycle: null })).status).toBe(422);
    const put = await api(app, admin)
      .put('/v1/customers/external/NULL-1')
      .send({ legalName: 'x', vatRegistered: null });
    expect(put.status).toBe(422);
    // ช่องที่ล้างได้ยังส่ง null ได้
    await api(app, admin).patch(`/v1/customers/${c.id}`).send({ taxId: null }).expect(200);
  });

  it('review: PUT external ซ้ำด้วยที่อยู่เต็ม/ผู้ติดต่อ/วงเงิน "500000" ไม่เพิ่ม version', async () => {
    const body = {
      legalName: 'บจก. ข้อมูลเต็ม',
      taxId: validTaxId(950),
      billingAddress: {
        postcode: '10540',
        line1: '1 ถนนตัวอย่าง',
        subdistrict: 'บางพลีใหญ่',
        district: 'บางพลี',
        province: 'สมุทรปราการ',
      },
      contacts: [
        { name: 'คุณเอ', phone: '+66812345678', email: 'a@example.com', isPrimary: true },
        { name: 'คุณบี', email: 'b@example.com' },
      ],
      creditLimit: '500000',
      whtExpectedRate: '1.00',
    };
    const r1 = await api(app, admin).put('/v1/customers/external/FULL-1').send(body).expect(201);
    const r2 = await api(app, admin).put('/v1/customers/external/FULL-1').send(body).expect(200);
    expect(r2.body.version).toBe(r1.body.version);
    expect(r2.body.creditLimit).toBe('500000.00');
  });

  it('review: ลบแล้วปล่อย externalId — ERP ส่งซ้ำได้รายการใหม่; includeDeleted เห็น tombstone', async () => {
    const r1 = await api(app, admin)
      .put('/v1/customers/external/DEL-1')
      .send({ legalName: 'บจก. จะถูกลบ' })
      .expect(201);
    const since = new Date(Date.now() - 1000).toISOString();
    await api(app, admin)
      .post(`/v1/customers/${r1.body.id}/delete`)
      .send({ reason: 'ทดสอบลบแล้วส่งใหม่' })
      .expect(204);
    const r2 = await api(app, admin)
      .put('/v1/customers/external/DEL-1')
      .send({ legalName: 'บจก. ส่งใหม่' })
      .expect(201);
    expect(r2.body.id).not.toBe(r1.body.id);
    const row = await db.customer.findUnique({
      where: { id: tryDecodeId('customer', r1.body.id)! },
    });
    expect(row).toMatchObject({ externalId: null, deletedExternalId: 'DEL-1' });
    const pull = await api(app, admin)
      .get(`/v1/customers?includeDeleted=true&sort=updatedAt&updatedAfter=${since}`)
      .expect(200);
    const tomb = pull.body.data.find((c: { id: string }) => c.id === r1.body.id);
    expect(tomb.deletedAt).toBeTruthy();
    const normal = await api(app, admin).get(`/v1/customers?updatedAfter=${since}&sort=updatedAt`);
    expect(normal.body.data.find((c: { id: string }) => c.id === r1.body.id)).toBeUndefined();
  });

  it('review: ค้นหา % / _ ไม่ใช่ wildcard; ตัดอักขระมองไม่เห็นในชื่อ', async () => {
    const t = (await createTenant(db)).id;
    const tok = await tokenFor(t);
    const c = await create({ legalName: 'บจก.​ทดสอบ\tตัด\nอักขระ' }, tok).expect(201);
    expect(c.body.legalName).toBe('บจก. ทดสอบ ตัด อักขระ');
    await create({ legalName: 'บจก. 100% จริง' }, tok).expect(201);
    const pct = await api(app, tok)
      .get(`/v1/customers?q=${encodeURIComponent('%')}`)
      .expect(200);
    expect(pct.body.data.map((x: { legalName: string }) => x.legalName)).toEqual([
      'บจก. 100% จริง',
    ]);
    const us = await api(app, tok)
      .get(`/v1/customers?q=${encodeURIComponent('_')}`)
      .expect(200);
    expect(us.body.data).toEqual([]);
  });

  it('review: ประวัติไม่ส่ง ip/requestId ให้ผู้ไม่มี audit:read; ปิดใช้ส่ง ETag', async () => {
    const c = await newCustomer();
    const off = await api(app, admin)
      .post(`/v1/customers/${c.id}/deactivate`)
      .set('If-Match', `"${c.version}"`)
      .send({ reason: 'ทดสอบ etag ปิดใช้' })
      .expect(200);
    expect(off.headers.etag).toBe(`"${c.version + 1}"`);
    await api(app, admin)
      .post(`/v1/customers/${c.id}/activate`)
      .set('If-Match', `"${c.version}"`)
      .send({})
      .expect(412);
    const viewer = await tokenFor(tenantId, 'master:read');
    const h = await api(app, viewer).get(`/v1/customers/${c.id}/history`).expect(200);
    expect(h.body.data[0].ip).toBeNull();
    expect(h.body.data[0].requestId).toBeNull();
    const full = await api(app, admin).get(`/v1/customers/${c.id}/history`).expect(200);
    expect(full.body.data[0].requestId).not.toBeNull();
  });
});
