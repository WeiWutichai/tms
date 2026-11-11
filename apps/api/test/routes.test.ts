import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { GeoService } from '../src/modules/geo/geo.service';
import { MockGeoProvider } from '../src/modules/geo/providers/mock.provider';
import { RoutesService } from '../src/modules/routes/routes.service';
import { DbService } from '../src/db/db.service';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

/** ST2-T09 เส้นทาง (OD pair) + คลัง/ต้นทาง — docs/04 B เส้นทาง, B คลัง/ต้นทาง */
describe('เส้นทาง (routes) + คลัง', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let geo: GeoService;
  let seed = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    geo = app.get(GeoService);
    geo.use(new MockGeoProvider());
    tenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const newSite = async (extra: object = {}, token = admin) =>
    (
      await api(app, token)
        .post('/v1/customer-sites')
        .send({ name: `จุดทดสอบ ${++seed}`, kind: 'DROPOFF', address: ADDR, ...extra })
        .expect(201)
    ).body as { id: string; version: number };
  const create = (body: object, token = admin) => api(app, token).post('/v1/routes').send(body);

  it('สร้างเส้นทาง: รหัส RT-0001, ระยะทาง/เวลา/ค่าผ่านทาง (เงิน numeric 2 ตำแหน่ง), route chip ต้นทาง→ปลายทาง', async () => {
    const a = await newSite({ name: 'คลังบางนา', kind: 'WAREHOUSE' });
    const b = await newSite({ name: 'โรงงานชลบุรี' });
    const r = await create({
      originId: a.id,
      destinationId: b.id,
      distanceKm: 95.5,
      standardMinutes: 120,
      tollAmount: '85.5',
    }).expect(201);
    expect(r.body).toMatchObject({
      code: 'RT-0001',
      origin: { id: a.id, name: 'คลังบางนา', kind: 'WAREHOUSE', status: 'active' },
      destination: { id: b.id, name: 'โรงงานชลบุรี' },
      distanceKm: 95.5,
      standardMinutes: 120,
      tollAmount: '85.50',
      status: 'active',
      version: 1,
    });
    expect(r.body.id).toMatch(/^rte_[0-9a-f]{32}$/);
    const row = await db.route.findUniqueOrThrow({
      where: { id: tryDecodeId('route', r.body.id)! },
    });
    expect(row.tollAmount?.toString()).toBe('85.5');
    expect(row.distanceKm.toString()).toBe('95.5');
    // audit + event
    const ev = await db.domainEvent.findFirst({
      where: { localId: row.id, type: 'route.created' },
    });
    expect(ev).not.toBeNull();
    const h = await api(app, admin).get(`/v1/routes/${r.body.id}/history`).expect(200);
    expect(h.body.data[0].action).toBe('route.created');
  });

  it('เกณฑ์ตรวจรับ: สร้าง OD ซ้ำคู่เดิมถูกปฏิเสธ (409) — ปิดใช้แล้วก็ยังซ้ำ, ทิศกลับ (B→A) สร้างได้, ลบแล้วสร้างใหม่ได้', async () => {
    const a = await newSite();
    const b = await newSite();
    const first = (
      await create({ originId: a.id, destinationId: b.id, distanceKm: 10 }).expect(201)
    ).body;
    const dup = await create({ originId: a.id, destinationId: b.id, distanceKm: 12 }).expect(409);
    expect(dup.body.code).toBe('duplicate');
    expect(dup.body.errors[0]).toMatchObject({ field: 'destinationId', code: 'duplicate_route' });
    expect(dup.body.existing).toMatchObject({ id: first.id, code: first.code, status: 'active' });
    // ทิศกลับเป็นอีกเส้นทาง
    await create({ originId: b.id, destinationId: a.id, distanceKm: 11 }).expect(201);
    // ปิดใช้ → ยังซ้ำ (ให้เปิดใช้ของเดิม)
    const off = await api(app, admin)
      .post(`/v1/routes/${first.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้เส้นทาง' })
      .expect(200);
    expect(off.body.status).toBe('inactive');
    const dup2 = await create({ originId: a.id, destinationId: b.id, distanceKm: 12 }).expect(409);
    expect(dup2.body.existing.status).toBe('inactive');
    // แก้เส้นทางอื่นให้ชนคู่เดิม → 409
    const c = await newSite();
    const other = (await create({ originId: a.id, destinationId: c.id, distanceKm: 5 }).expect(201))
      .body;
    await api(app, admin)
      .patch(`/v1/routes/${other.id}`)
      .set('If-Match', `"${other.version}"`)
      .send({ destinationId: b.id })
      .expect(409);
    // ลบ (เหตุผล ≥ 10) แล้วสร้างคู่เดิมได้
    await api(app, admin)
      .post(`/v1/routes/${first.id}/delete`)
      .send({ reason: 'ทดสอบลบเส้นทางซ้ำ' })
      .expect(204);
    await api(app, admin).get(`/v1/routes/${first.id}`).expect(404);
    await create({ originId: a.id, destinationId: b.id, distanceKm: 12 }).expect(201);
  });

  it('ส่งพร้อมกัน 2 คำขอคู่เดิม → สำเร็จ 1 ซ้ำ 1 (lock + partial unique index)', async () => {
    const a = await newSite();
    const b = await newSite();
    const res = await Promise.all([
      create({ originId: a.id, destinationId: b.id, distanceKm: 10 }),
      create({ originId: a.id, destinationId: b.id, distanceKm: 10 }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await db.route.count({
        where: { originSiteId: tryDecodeId('site', a.id)!, deletedAt: null },
      }),
    ).toBe(1);
  });

  it('validation: ต้นทาง = ปลายทาง, ระยะ ≤ 0/ทศนิยมเกิน, เงินติดลบ/float, สถานที่ปิดใช้/ไม่มี/ข้าม tenant → 422', async () => {
    const a = await newSite();
    const b = await newSite();
    const v = async (body: object, field: string, code?: string) => {
      const r = await create({
        originId: a.id,
        destinationId: b.id,
        distanceKm: 10,
        ...body,
      }).expect(422);
      const e = r.body.errors.find((x: { field: string }) => x.field === field);
      expect(e, JSON.stringify(r.body.errors)).toBeTruthy();
      if (code) expect(e.code).toBe(code);
    };
    await v({ destinationId: a.id }, 'destinationId', 'same_site');
    await v({ distanceKm: 0 }, 'distanceKm');
    await v({ distanceKm: 10.25 }, 'distanceKm');
    await v({ distanceKm: null }, 'distanceKm');
    await v({ tollAmount: '-1' }, 'tollAmount');
    await v({ tollAmount: '1.234' }, 'tollAmount');
    await v({ tollAmount: 12.5 }, 'tollAmount');
    await v({ standardMinutes: 0 }, 'standardMinutes');
    await v({ originId: `loc_${'0'.repeat(32)}` }, 'originId', 'reference_not_found');
    // สถานที่ของ tenant อื่น = ไม่พบ
    const other = await createTenant(db);
    const otherSite = await newSite({}, await tokenFor(other.id));
    await v({ originId: otherSite.id }, 'originId', 'reference_not_found');
    // สถานที่ปิดใช้ → สร้างไม่ได้
    const off = await newSite();
    await api(app, admin)
      .post(`/v1/customer-sites/${off.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้สถานที่' })
      .expect(200);
    await v({ originId: off.id }, 'originId', 'site_inactive');
  });

  it('แก้ไข: If-Match → 412, ส่งค่าเดิมไม่เพิ่ม version, ล้างค่าผ่านทาง/เวลาเป็น null, export + ค้นหาชื่อจุด', async () => {
    const a = await newSite({ name: 'ลานตู้บางปู' });
    const b = await newSite({ name: 'ท่าเรือแหลมฉบัง' });
    const r = (
      await create({
        originId: a.id,
        destinationId: b.id,
        distanceKm: 110,
        tollAmount: '120.00',
        standardMinutes: 90,
      }).expect(201)
    ).body;
    await api(app, admin)
      .patch(`/v1/routes/${r.id}`)
      .set('If-Match', '"99"')
      .send({ distanceKm: 111 })
      .expect(412);
    const same = await api(app, admin)
      .patch(`/v1/routes/${r.id}`)
      .set('If-Match', `"${r.version}"`)
      .send({ distanceKm: 110.0, tollAmount: '120', originId: a.id })
      .expect(200);
    expect(same.body.version).toBe(r.version);
    const u = await api(app, admin)
      .patch(`/v1/routes/${r.id}`)
      .set('If-Match', `"${r.version}"`)
      .send({ tollAmount: null, standardMinutes: null, distanceKm: 112.4 })
      .expect(200);
    expect(u.body).toMatchObject({
      tollAmount: null,
      standardMinutes: null,
      distanceKm: 112.4,
      version: r.version + 1,
    });
    const list = await api(app, admin).get('/v1/routes').query({ q: 'แหลมฉบัง' }).expect(200);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([r.id]);
    const bySite = await api(app, admin).get('/v1/routes').query({ siteId: a.id }).expect(200);
    expect(bySite.body.data.map((x: { id: string }) => x.id)).toContain(r.id);
    const csv = await api(app, admin)
      .get('/v1/routes/export')
      .query({ format: 'csv', route: 'บางปู' })
      .expect(200);
    expect(csv.text).toContain('ลานตู้บางปู');
    expect(csv.text).toContain('112.4');
  });

  it('PUT external: สร้าง 201 → ส่งซ้ำ 200 ไม่เพิ่มแถว', async () => {
    const a = await newSite();
    const b = await newSite();
    const body = { originId: a.id, destinationId: b.id, distanceKm: 33.3 };
    const c = await api(app, admin).put('/v1/routes/external/ERP-R-1').send(body).expect(201);
    const u = await api(app, admin).put('/v1/routes/external/ERP-R-1').send(body).expect(200);
    expect(u.body.id).toBe(c.body.id);
    expect(u.body.version).toBe(c.body.version);
    await api(app, admin).get('/v1/routes/ext:ERP-R-1').expect(200);
  });

  it('getRouteDistance (สำหรับ pricing ST2-T15): คืน Decimal ของเส้นทางที่ใช้งาน · ไม่มี/ปิดใช้ = null', async () => {
    const a = await newSite();
    const b = await newSite();
    const r = (
      await create({
        originId: a.id,
        destinationId: b.id,
        distanceKm: 95,
        tollAmount: '60',
      }).expect(201)
    ).body;
    const svc = app.get(RoutesService);
    const dbs = app.get(DbService);
    const oa = tryDecodeId('site', a.id)!;
    const ob = tryDecodeId('site', b.id)!;
    const d = await dbs.withTenant(tenantId, (tx) => svc.getRouteDistance(oa, ob, tx));
    expect(d?.distanceKm.toString()).toBe('95');
    expect(d?.tollAmount?.toFixed(2)).toBe('60.00');
    expect(d?.code).toBe(r.code);
    // ทิศกลับไม่มี
    expect(await dbs.withTenant(tenantId, (tx) => svc.getRouteDistance(ob, oa, tx))).toBeNull();
    // tenant อื่นมองไม่เห็น (RLS)
    const other = await createTenant(db);
    expect(await dbs.withTenant(other.id, (tx) => svc.getRouteDistance(oa, ob, tx))).toBeNull();
    // ปิดใช้ = ไม่ถูกใช้คิดราคา
    await api(app, admin)
      .post(`/v1/routes/${r.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้เส้นทาง' })
      .expect(200);
    expect(await dbs.withTenant(tenantId, (tx) => svc.getRouteDistance(oa, ob, tx))).toBeNull();
  });

  it('คำนวณจากพิกัด: มีพิกัดทั้งคู่ = ระยะ/เวลาจากผู้ให้บริการ (ไม่บันทึก) · ไม่มีพิกัด = no_coords · ผู้ให้บริการไม่รองรับ = unavailable', async () => {
    const a = await newSite({ lat: 13.75, lng: 100.5 });
    const b = await newSite({ lat: 13.36, lng: 100.98 });
    const e = await api(app, admin)
      .post('/v1/routes/estimate')
      .send({ originId: a.id, destinationId: b.id })
      .expect(200);
    expect(e.body.result).toBe('ok');
    expect(e.body.provider).toBe('mock');
    expect(e.body.distanceKm).toBeGreaterThan(60);
    expect(e.body.distanceKm).toBeLessThan(150);
    expect(Number.isInteger(e.body.distanceKm * 10)).toBe(true);
    expect(e.body.standardMinutes).toBeGreaterThan(0);
    expect(await db.route.count({ where: { originSiteId: tryDecodeId('site', a.id)! } })).toBe(0);
    const c = await newSite();
    const n = await api(app, admin)
      .post('/v1/routes/estimate')
      .send({ originId: a.id, destinationId: c.id })
      .expect(200);
    expect(n.body).toMatchObject({ result: 'no_coords', distanceKm: null });
    geo.use({ name: 'none', enabled: false, geocode: async () => [], distance: async () => null });
    try {
      const u = await api(app, admin)
        .post('/v1/routes/estimate')
        .send({ originId: a.id, destinationId: b.id })
        .expect(200);
      expect(u.body).toMatchObject({ result: 'unavailable', distanceKm: null, provider: 'none' });
      geo.use({
        name: 'down',
        enabled: true,
        geocode: async () => [],
        distance: async () => {
          throw new Error('boom');
        },
      });
      const down = await api(app, admin)
        .post('/v1/routes/estimate')
        .send({ originId: a.id, destinationId: b.id })
        .expect(200);
      expect(down.body.result).toBe('unavailable');
    } finally {
      geo.use(new MockGeoProvider());
    }
    // สถานที่ tenant อื่น → 422
    const other = await createTenant(db);
    const os = await newSite({}, await tokenFor(other.id));
    await api(app, admin)
      .post('/v1/routes/estimate')
      .send({ originId: a.id, destinationId: os.id })
      .expect(422);
  });

  it('คลัง/ต้นทาง: สถานที่ชนิด WAREHOUSE ของบริษัท (ไม่มีลูกค้า) มีช่องโหลด + เวลาทำการ + พิกัด', async () => {
    const d = await api(app, admin)
      .post('/v1/customer-sites')
      .send({
        name: 'คลังสินค้าวังน้อย',
        kind: 'WAREHOUSE',
        address: ADDR,
        lat: 14.23,
        lng: 100.71,
        openTime: '06:00',
        closeTime: '20:00',
        dockCount: 8,
      })
      .expect(201);
    expect(d.body).toMatchObject({
      kind: 'WAREHOUSE',
      customer: null,
      dockCount: 8,
      openTime: '06:00',
      closeTime: '20:00',
      geocodeStatus: 'OK',
    });
    const depots = await api(app, admin)
      .get('/v1/customer-sites')
      .query({ kind: 'WAREHOUSE', customerId: 'none' })
      .expect(200);
    expect(depots.body.data.map((x: { id: string }) => x.id)).toContain(d.body.id);
    const p = await api(app, admin)
      .patch(`/v1/customer-sites/${d.body.id}`)
      .set('If-Match', `"${d.body.version}"`)
      .send({ dockCount: null })
      .expect(200);
    expect(p.body.dockCount).toBeNull();
    await api(app, admin)
      .patch(`/v1/customer-sites/${d.body.id}`)
      .set('If-Match', `"${p.body.version}"`)
      .send({ dockCount: -1 })
      .expect(422);
    // สถานที่ที่เส้นทางอ้างอยู่ ลบไม่ได้ (409 in_use, references.routes)
    const b = await newSite();
    await create({ originId: d.body.id, destinationId: b.id, distanceKm: 70 }).expect(201);
    const del = await api(app, admin)
      .post(`/v1/customer-sites/${b.id}/delete`)
      .send({ reason: 'ทดสอบลบสถานที่ที่มีเส้นทาง' })
      .expect(409);
    expect(del.body.references).toMatchObject({ routes: 1 });
  });

  it('สิทธิ์: อ่านอย่างเดียวสร้างไม่ได้ (403), สรุปยอด', async () => {
    const viewer = await tokenFor(tenantId, 'master:read');
    const a = await newSite();
    const b = await newSite();
    await create({ originId: a.id, destinationId: b.id, distanceKm: 1 }, viewer).expect(403);
    const s = await api(app, viewer).get('/v1/routes/summary').expect(200);
    expect(s.body.total).toBe(s.body.active + s.body.inactive);
    expect(s.body.withToll).toBeGreaterThanOrEqual(1);
    const nc = await api(app, admin).get('/v1/routes/next-code').expect(200);
    expect(nc.body.code).toMatch(/^RT-\d{4}$/);
  });
});
