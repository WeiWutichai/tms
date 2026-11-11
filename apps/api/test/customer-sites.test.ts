import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const ADDR = { line1: '99 นิคมตัวอย่าง ต.ตัวอย่าง อ.เมือง จ.ชลบุรี 20000' };

/** ST2-T02 สถานที่ / จุดรับส่ง (customer_site) — docs/01 §3.2, docs/04 B จุดส่ง, spec/02 §2 */
describe('สถานที่ (customer-sites)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let seed = 0;

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

  const create = (body: object, token = admin) =>
    api(app, token).post('/v1/customer-sites').send(body);
  const newSite = async (extra: object = {}) =>
    (await create({ name: `จุดตัวอย่าง ${++seed}`, address: ADDR, ...extra }).expect(201)).body;
  const newCustomer = async () =>
    (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `บจก. ลูกค้าจุดส่ง ${++seed}`, taxId: validTaxId(5000 + seed) })
        .expect(201)
    ).body;

  it('เกณฑ์ตรวจรับ: สร้างจุดส่งที่มี alias 2 ตัว แล้วค้นด้วย alias เจอ', async () => {
    const s = await newSite({
      name: 'โรงงานสยามพลาสติก ชลบุรี',
      aliases: ['SPC ชลบุรี', 'สยามพลาสติก โรง 2'],
    });
    expect(s.id).toMatch(/^loc_[0-9a-f]{32}$/);
    expect(s.aliases).toEqual(['SPC ชลบุรี', 'สยามพลาสติก โรง 2']);
    for (const q of ['spc ชลบุรี', 'โรง 2', 'SPC']) {
      const r = await api(app, admin).get('/v1/customer-sites').query({ q }).expect(200);
      expect(r.body.data.map((x: { id: string }) => x.id)).toContain(s.id);
    }
    // alias ตรงตัว (ไม่สนตัวพิมพ์) — ใช้จับคู่ข้อความปลายทาง (ST3-T06)
    const exact = await api(app, admin)
      .get('/v1/customer-sites')
      .query({ alias: 'spc ชลบุรี' })
      .expect(200);
    expect(exact.body.data.map((x: { id: string }) => x.id)).toEqual([s.id]);
    const part = await api(app, admin)
      .get('/v1/customer-sites')
      .query({ alias: 'SPC' })
      .expect(200);
    expect(part.body.data).toHaveLength(0);
  });

  it('สร้างได้ พร้อมรหัส LOC-00001 + ค่าเริ่มต้น (ปลายทาง, รัศมี 200 ม., ยังไม่ปักหมุด = PENDING)', async () => {
    const t = (await createTenant(db)).id;
    const tok = await tokenFor(t);
    const r = await api(app, tok)
      .post('/v1/customer-sites')
      .send({ name: 'คลังบางนา', address: ADDR })
      .expect(201);
    expect(r.body).toMatchObject({
      code: 'LOC-00001',
      kind: 'DROPOFF',
      geofenceRadiusM: 200,
      geocodeStatus: 'PENDING',
      lat: null,
      lng: null,
      customer: null,
      aliases: [],
      status: 'active',
    });
    expect(r.headers.etag).toBe('"1"');
    const next = await api(app, tok).get('/v1/customer-sites/next-code').expect(200);
    expect(next.body.code).toBe('LOC-00002');
  });

  it('พิกัดที่กรอกเอง → geocodeStatus OK; ล้างพิกัด → PENDING; ส่งข้างเดียว/นอกช่วง → 422', async () => {
    const s = await newSite({ lat: 13.6416, lng: 100.6911, geofenceRadiusM: 300 });
    expect(s).toMatchObject({ lat: 13.6416, lng: 100.6911, geocodeStatus: 'OK' });
    const cleared = await api(app, admin)
      .patch(`/v1/customer-sites/${s.id}`)
      .set('If-Match', `"${s.version}"`)
      .send({ lat: null, lng: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ lat: null, lng: null, geocodeStatus: 'PENDING' });
    const one = await create({ name: 'ข้างเดียว', address: ADDR, lat: 13.6 });
    expect(one.status).toBe(422);
    expect(one.body.errors[0]).toMatchObject({ field: 'lng', code: 'pair_required' });
    expect((await create({ name: 'นอกช่วง', address: ADDR, lat: 95, lng: 100 })).status).toBe(422);
    // รัศมี geofence 50–2,000 ม. (spec/02 §2)
    const r = await create({ name: 'รัศมีเล็ก', address: ADDR, geofenceRadiusM: 20 });
    expect(r.status).toBe(422);
    expect(r.body.errors[0].field).toBe('geofenceRadiusM');
  });

  it('ลูกค้า: ผูกกับลูกค้าได้ (กรองด้วย customerId/ชื่อ), null = จุดของบริษัทเอง, ลูกค้าไม่มี → 422', async () => {
    const c = await newCustomer();
    const s = await newSite({ customerId: c.id, kind: 'PICKUP' });
    expect(s.customer).toMatchObject({ id: c.id, code: c.code, name: c.legalName });
    const own = await newSite({ kind: 'WAREHOUSE' });
    const byCust = await api(app, admin)
      .get('/v1/customer-sites')
      .query({ customerId: c.id })
      .expect(200);
    expect(byCust.body.data.map((x: { id: string }) => x.id)).toEqual([s.id]);
    const byName = await api(app, admin)
      .get('/v1/customer-sites')
      .query({ customerName: c.legalName.slice(4) })
      .expect(200);
    expect(byName.body.data.map((x: { id: string }) => x.id)).toEqual([s.id]);
    const mine = await api(app, admin)
      .get('/v1/customer-sites')
      .query({ customerId: 'none', kind: 'WAREHOUSE' })
      .expect(200);
    expect(mine.body.data.map((x: { id: string }) => x.id)).toContain(own.id);
    const bad = await create({
      name: 'ลูกค้าไม่มี',
      address: ADDR,
      customerId: 'cus_00000000000000000000000000000000',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'customerId', code: 'not_found' });
  });

  it('เวลาเปิด-ปิด HH:MM ต้องมาคู่กัน (ข้ามเที่ยงคืนได้); ผู้ติดต่อ/หมายเหตุ/service time', async () => {
    const s = await newSite({
      openTime: '22:00',
      closeTime: '06:00',
      serviceTimeMin: 45,
      maxVehicleClass: '10W',
      contact: { name: 'คุณวิไล', phone: '02-300-4100' },
      notes: 'เข้าประตู 3 เท่านั้น\nติดต่อ รปภ. ก่อน',
    });
    expect(s).toMatchObject({
      openTime: '22:00',
      closeTime: '06:00',
      serviceTimeMin: 45,
      maxVehicleClass: '10W',
      contact: { name: 'คุณวิไล', phone: '02-300-4100' },
      notes: 'เข้าประตู 3 เท่านั้น\nติดต่อ รปภ. ก่อน',
    });
    const r = await create({ name: 'เวลาไม่ครบ', address: ADDR, openTime: '08:00' });
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toMatchObject({ field: 'closeTime', code: 'pair_required' });
    expect(
      (await create({ name: 'เวลาผิด', address: ADDR, openTime: '25:00', closeTime: '06:00' }))
        .status,
    ).toBe(422);
    expect((await create({ name: 'รถผิด', address: ADDR, maxVehicleClass: '18W' })).status).toBe(
      422,
    );
  });

  it('แก้ด้วย If-Match: version ถูก → 200 + audit diff; version เก่า → 412; ค่าเดิม ไม่เพิ่ม version', async () => {
    const s = await newSite({ aliases: ['A1'] });
    const r = await api(app, admin)
      .patch(`/v1/customer-sites/${s.id}`)
      .set('If-Match', `"${s.version}"`)
      .send({ aliases: ['A1', ' a1 ', 'B2'], geofenceRadiusM: 500 })
      .expect(200);
    expect(r.body.aliases).toEqual(['A1', 'B2']); // ตัดซ้ำแบบไม่สนตัวพิมพ์
    expect(r.headers.etag).toBe(`"${s.version + 1}"`);
    await api(app, admin)
      .patch(`/v1/customer-sites/${s.id}`)
      .set('If-Match', `"${s.version}"`)
      .send({ geofenceRadiusM: 600 })
      .expect(412);
    const same = await api(app, admin)
      .patch(`/v1/customer-sites/${s.id}`)
      .send({ aliases: ['A1', 'B2'], geofenceRadiusM: 500 })
      .expect(200);
    expect(same.body.version).toBe(r.body.version);
    const h = await api(app, admin).get(`/v1/customer-sites/${s.id}/history`).expect(200);
    const upd = h.body.data.find((e: { action: string }) => e.action === 'location.updated');
    expect(upd).toBeTruthy();
    expect(JSON.stringify(upd)).toContain('geofenceRadiusM');
    // null ในช่องที่ห้ามว่าง → 422 (ไม่ใช่ 500)
    for (const body of [{ name: null }, { address: null }, { kind: null }, { aliases: null }])
      expect((await api(app, admin).patch(`/v1/customer-sites/${s.id}`).send(body)).status).toBe(
        422,
      );
  });

  it('ถูกอ้างอิงจาก SO: ลบไม่ได้ (409 in_use) แต่ปิดใช้ได้ (เหตุผล ≥ 10 ตัว) + domain event', async () => {
    const s = await newSite();
    const c = await newCustomer();
    const co = await db.company.create({
      data: { tenantId, legalName: 'บจก. ผู้ออกบิล', taxId: validTaxId(78) },
    });
    const so = await db.salesOrder.create({
      data: {
        tenantId,
        source: 'MANUAL',
        customerId: tryDecodeId('customer', c.id)!,
        billingCompanyId: co.id,
        requestedDate: new Date('2026-11-20'),
      },
    });
    await db.salesOrderStop.create({
      data: {
        tenantId,
        salesOrderId: so.id,
        sequence: 1,
        type: 'DELIVERY',
        siteId: tryDecodeId('site', s.id)!,
        siteText: s.name,
      },
    });
    const del = await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/delete`)
      .send({ reason: 'สร้างผิดรายการ ทดสอบ' });
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('in_use');
    expect(del.body.references).toEqual({ salesOrders: 1 });
    await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/deactivate`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const off = await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/deactivate`)
      .set('If-Match', `"${s.version}"`)
      .send({ reason: 'ปิดคลังนี้ตั้งแต่ ธ.ค. 2569' })
      .expect(200);
    expect(off.body.status).toBe('inactive');
    expect(off.headers.etag).toBe(`"${s.version + 1}"`);
    const on = await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/activate`)
      .send({})
      .expect(200);
    expect(on.body.status).toBe('active');
    const ev = await db.domainEvent.findMany({
      where: { tenantId, localId: tryDecodeId('site', s.id)! },
      orderBy: { occurredAt: 'asc' },
    });
    expect(ev.map((e) => e.type)).toEqual(
      expect.arrayContaining(['location.created', 'location.deactivated', 'location.reactivated']),
    );
  });

  it('ไม่เคยถูกอ้างอิง: ลบ = soft delete (GET 404, แถวยังอยู่) — ลูกค้าที่มีแต่จุดที่ลบแล้วลบได้', async () => {
    const c = await newCustomer();
    const s = await newSite({ customerId: c.id, externalId: 'ERP-LOC-DEL' });
    // ลูกค้ามีจุดส่งอยู่ → ลบลูกค้าไม่ได้
    expect(
      (
        await api(app, admin)
          .post(`/v1/customers/${c.id}/delete`)
          .send({ reason: 'สร้างผิดรายการ ทดสอบ' })
      ).status,
    ).toBe(409);
    await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/delete`)
      .send({ reason: 'สร้างผิดรายการ ทดสอบ' })
      .expect(204);
    await api(app, admin).get(`/v1/customer-sites/${s.id}`).expect(404);
    const row = await db.customerSite.findUnique({ where: { id: tryDecodeId('site', s.id)! } });
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.deletedExternalId).toBe('ERP-LOC-DEL');
    const tomb = await api(app, admin)
      .get('/v1/customer-sites')
      .query({ includeDeleted: 'true', q: s.code })
      .expect(200);
    expect(tomb.body.data[0].deletedAt).toBeTruthy();
    await api(app, admin)
      .post(`/v1/customers/${c.id}/delete`)
      .send({ reason: 'สร้างผิดรายการ ทดสอบ' })
      .expect(204);
  });

  it('PUT /customer-sites/external/{id}: ครั้งแรก 201, ส่งซ้ำ 200 ไม่เกิดแถวใหม่ไม่เพิ่ม version; ext:{id}', async () => {
    const body = {
      name: 'ศูนย์กระจายสินค้า ตัวอย่าง',
      address: ADDR,
      kind: 'WAREHOUSE',
      lat: 13.5902,
      lng: 100.8034,
      aliases: ['DC บางเสาธง'],
      contact: { name: 'คุณสมชาย', phone: '02-000-0001' },
    };
    const a = await api(app, admin).put('/v1/customer-sites/external/ERP-LOC-1').send(body);
    expect(a.status).toBe(201);
    const b = await api(app, admin).put('/v1/customer-sites/external/ERP-LOC-1').send(body);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.version).toBe(a.body.version);
    expect(await db.customerSite.count({ where: { tenantId, externalId: 'ERP-LOC-1' } })).toBe(1);
    const g = await api(app, admin).get('/v1/customer-sites/ext:ERP-LOC-1').expect(200);
    expect(g.body.code).toBe(a.body.code);
  });

  it('ค้นหา/กรอง (ประเภท, ปักหมุด) + cursor + summary', async () => {
    const t = (await createTenant(db)).id;
    const tok = await tokenFor(t);
    const mk = (body: object) =>
      api(app, tok)
        .post('/v1/customer-sites')
        .send({ address: ADDR, ...body })
        .expect(201);
    await mk({
      name: 'ต้นทาง 1',
      kind: 'PICKUP',
      lat: 13.6,
      lng: 100.6,
      maxVehicleClass: 'TRAILER',
    });
    await mk({ name: 'ปลายทาง 1', lat: 13.4, lng: 101.0, maxVehicleClass: '6W' });
    await mk({ name: 'ปลายทาง 2', maxVehicleClass: '10W' });
    await mk({ name: 'คลัง 1', kind: 'WAREHOUSE' });
    const sum = await api(app, tok).get('/v1/customer-sites/summary').expect(200);
    expect(sum.body).toEqual({
      total: 4,
      pinned: 2,
      unpinned: 2,
      restricted: 2,
      byKind: { PICKUP: 1, DROPOFF: 2, WAREHOUSE: 1 },
      active: 4,
      inactive: 0,
    });
    const nopin = await api(app, tok).get('/v1/customer-sites?pinned=false').expect(200);
    expect(nopin.body.data.map((x: { name: string }) => x.name).sort()).toEqual([
      'คลัง 1',
      'ปลายทาง 2',
    ]);
    const p1 = await api(app, tok).get('/v1/customer-sites?limit=3').expect(200);
    expect(p1.body.data.map((x: { code: string }) => x.code)).toEqual([
      'LOC-00001',
      'LOC-00002',
      'LOC-00003',
    ]);
    const p2 = await api(app, tok)
      .get('/v1/customer-sites')
      .query({ limit: 3, cursor: p1.body.nextCursor })
      .expect(200);
    expect(p2.body.data.map((x: { code: string }) => x.code)).toEqual(['LOC-00004']);
    // ค้นด้วยที่อยู่ + % ไม่ใช่ wildcard
    const byAddr = await api(app, tok).get('/v1/customer-sites').query({ q: 'นิคมตัวอย่าง' });
    expect(byAddr.body.data).toHaveLength(4);
    const pct = await api(app, tok).get('/v1/customer-sites').query({ q: '%' });
    expect(pct.body.data).toHaveLength(0);
  });

  it('ส่งออก .xlsx / .csv (ต้องมี export:run); สิทธิ์ master:read อ่านได้แต่แก้ไม่ได้', async () => {
    await newSite({ name: '=CMD("x")', aliases: ['ก', 'ข'] });
    const csv = await api(app, admin).get('/v1/customer-sites/export?format=csv').expect(200);
    expect(csv.headers['content-disposition']).toContain('customer-sites.csv');
    expect(csv.text).toContain('รหัส,ชื่อสถานที่,ประเภท');
    expect(csv.text).toContain(`"'=CMD(""x"")"`);
    expect(csv.text).toContain('ก | ข');
    const viewer = await tokenFor(tenantId, 'master:read');
    await api(app, viewer).get('/v1/customer-sites/export').expect(403);
    const s = await newSite();
    await api(app, viewer).get(`/v1/customer-sites/${s.id}`).expect(200);
    await api(app, viewer).get(`/v1/customer-sites/${s.id}/history`).expect(200);
    await api(app, viewer)
      .post('/v1/customer-sites')
      .send({ name: 'x', address: ADDR })
      .expect(403);
    await api(app, viewer)
      .patch(`/v1/customer-sites/${s.id}`)
      .send({ geofenceRadiusM: 100 })
      .expect(403);
    const none = await tokenFor(tenantId, 'orders:read');
    await api(app, none).get('/v1/customer-sites').expect(403);
  });
  it('review: ส่งซ้ำลูกค้าเดิมที่ปิดใช้แล้ว = ไม่เปลี่ยน (200 no-op); เปลี่ยนไปลูกค้าที่ปิดใช้ → 422', async () => {
    const c = await newCustomer();
    const body = { name: `จุด ext ${++seed}`, address: ADDR, customerId: c.id };
    const a = await api(app, admin).put('/v1/customer-sites/external/ERP-LOC-OFF').send(body);
    expect(a.status).toBe(201);
    await api(app, admin)
      .post(`/v1/customers/${c.id}/deactivate`)
      .send({ reason: 'เลิกใช้บริการ ทดสอบ review' })
      .expect(200);
    const b = await api(app, admin).put('/v1/customer-sites/external/ERP-LOC-OFF').send(body);
    expect(b.status).toBe(200);
    expect(b.body.version).toBe(a.body.version);
    await api(app, admin)
      .patch(`/v1/customer-sites/${a.body.id}`)
      .send({ customerId: c.id })
      .expect(200);
    const other = await newSite();
    const bad = await api(app, admin)
      .patch(`/v1/customer-sites/${other.id}`)
      .send({ customerId: c.id });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'customerId', code: 'not_found' });
  });

  it('review: alias_search/address_search มาจาก trigger — แก้ aliases ด้วย SQL ตรงแล้วค้นเจอ; ค้นที่อยู่ไม่สนตัวพิมพ์', async () => {
    const s = await newSite({ address: { line1: '9 Bangna-Trad Road ต.ตัวอย่าง' } });
    await db.$executeRaw`UPDATE customer_site SET aliases = ARRAY['Raw Alias X'] WHERE id = ${tryDecodeId('site', s.id)!}::uuid`;
    const byAlias = await api(app, admin).get('/v1/customer-sites').query({ alias: 'raw alias x' });
    expect(byAlias.body.data.map((x: { id: string }) => x.id)).toEqual([s.id]);
    const byAddr = await api(app, admin).get('/v1/customer-sites').query({ q: 'BANGNA-TRAD' });
    expect(byAddr.body.data.map((x: { id: string }) => x.id)).toContain(s.id);
  });

  it('review: พิกัดส่งช่องเดียว (แม้ null) → 422; เวลาเปิด = ปิด → 422', async () => {
    const s = await newSite({ lat: 13.6, lng: 100.6 });
    const r = await api(app, admin).patch(`/v1/customer-sites/${s.id}`).send({ lat: null });
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toMatchObject({ field: 'lng', code: 'pair_required' });
    const g = await api(app, admin).get(`/v1/customer-sites/${s.id}`).expect(200);
    expect(g.body.lat).toBe(13.6);
    const same = await create({
      name: 'เวลาเท่ากัน',
      address: ADDR,
      openTime: '08:00',
      closeTime: '08:00',
    });
    expect(same.status).toBe(422);
    expect(same.body.errors[0]).toMatchObject({ field: 'closeTime', code: 'same_time' });
  });

  it('review: กรองชื่อลูกค้าด้วยชื่อบริษัทเอง → เห็นจุดของบริษัท (ไม่มีลูกค้า)', async () => {
    const t = (await createTenant(db)).id;
    const tok = await tokenFor(t);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: t } });
    const own = await api(app, tok)
      .post('/v1/customer-sites')
      .send({ name: 'คลังของบริษัท', address: ADDR })
      .expect(201);
    const r = await api(app, tok)
      .get('/v1/customer-sites')
      .query({ customerName: tenant.name.slice(0, 4) })
      .expect(200);
    expect(r.body.data.map((x: { id: string }) => x.id)).toEqual([own.body.id]);
  });
});
