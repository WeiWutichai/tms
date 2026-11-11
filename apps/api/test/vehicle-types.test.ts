import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { bootstrapTenant, createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { DEFAULT_VEHICLE_TYPES } from '../src/modules/vehicle-types/defaults';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

const BASE = { vehicleClass: '10W', payloadKg: 15000, minLicenceClass: 'T2' };

/** ST2-T04 ประเภทรถ + capability tags + ค่าเริ่มต้นไทย — spec/02 §4, docs/04 B รถ / A5 */
describe('ประเภทรถ (vehicle-types)', () => {
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
    api(app, token).post('/v1/vehicle-types').send(body);
  const newType = async (extra: object = {}) =>
    (await create({ name: `ประเภททดสอบ ${++seed}`, ...BASE, ...extra }).expect(201)).body;
  const addVehicle = (vehicleTypeId: string, status: 'READY' | 'RETIRED' = 'READY') =>
    db.vehicle.create({
      data: {
        tenantId,
        plate: `70-${String(++seed).padStart(4, '0')}`,
        plateProvince: 'กรุงเทพมหานคร',
        vehicleTypeId: tryDecodeId('vehicleType', vehicleTypeId)!,
        ownership: 'OWN',
        status,
      },
    });

  it('เกณฑ์ตรวจรับ: tenant ใหม่มีประเภทรถไทยพร้อมใช้ แก้/เพิ่มได้', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท ขนส่งใหม่' });
    const tok = await tokenFor(t.id);
    const r = await api(app, tok).get('/v1/vehicle-types').expect(200);
    expect(r.body.data.map((x: { code: string }) => x.code)).toEqual([
      '10W',
      '4W',
      '6W',
      'REF6',
      'TRC',
      'TRL',
    ]);
    const six = r.body.data.find((x: { code: string }) => x.code === '6W');
    expect(six).toMatchObject({
      name: '6 ล้อ',
      vehicleClass: '6W',
      sizeRank: 3,
      payloadKg: 6000,
      volumeCbm: null,
      minLicenceClass: 'T2',
      capabilityTags: [],
      system: true,
      status: 'active',
      usage: { vehicles: 0, rateCards: 0 },
    });
    const cold = r.body.data.find((x: { code: string }) => x.code === 'REF6');
    expect(cold).toMatchObject({ capabilityTags: ['REFRIGERATED'], tempMinC: 0, tempMaxC: 8 });
    // แก้ได้
    const e = await api(app, tok)
      .patch(`/v1/vehicle-types/${six.id}`)
      .set('If-Match', `"${six.version}"`)
      .send({ volumeCbm: 22, capabilityTags: ['CRANE'] })
      .expect(200);
    expect(e.body).toMatchObject({ volumeCbm: 22, capabilityTags: ['CRANE'], version: 2 });
    // เพิ่มได้ (รหัส VT-0001)
    const n = await api(app, tok)
      .post('/v1/vehicle-types')
      .send({ name: '10 ล้อ ตู้แห้ง', ...BASE, capabilityTags: ['CONTAINER'] })
      .expect(201);
    expect(n.body).toMatchObject({ code: 'VT-0001', system: false, capabilityTags: ['CONTAINER'] });
    expect(n.body.id).toMatch(/^vty_[0-9a-f]{32}$/);
    const s = await api(app, tok).get('/v1/vehicle-types/summary').expect(200);
    expect(s.body).toMatchObject({ total: 7, active: 7, inactive: 0, vehicles: 0, rateCards: 0 });
  });

  it('bootstrap รันซ้ำได้: ไม่สร้างซ้ำ ไม่ทับที่แก้ ไม่คืนชีพแถวที่ลบ แม้เปลี่ยนรหัส/ชื่อ', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท รันซ้ำ' });
    const rows = await db.vehicleType.findMany({ where: { tenantId: t.id } });
    expect(rows).toHaveLength(DEFAULT_VEHICLE_TYPES.length);
    const four = rows.find((r) => r.code === '4W')!;
    const ten = rows.find((r) => r.code === '10W')!;
    await db.vehicleType.update({
      where: { id: four.id },
      data: { code: 'PICKUP', nameTh: 'กระบะ', capacityKg: 1200 },
    });
    await db.vehicleType.update({ where: { id: ten.id }, data: { deletedAt: new Date() } });
    await bootstrapTenant(db, t.id);
    await bootstrapTenant(db, t.id);
    const after = await db.vehicleType.findMany({ where: { tenantId: t.id } });
    expect(after).toHaveLength(DEFAULT_VEHICLE_TYPES.length);
    const f = after.find((r) => r.id === four.id)!;
    expect([f.code, f.nameTh, Number(f.capacityKg)]).toEqual(['PICKUP', 'กระบะ', 1200]);
    expect(after.find((r) => r.id === ten.id)!.deletedAt).not.toBeNull();
  });

  it('bootstrap: tenant เดิมที่สร้างรหัส/ชื่อเดียวกันเองไว้แล้ว → ข้ามแถวนั้น ไม่ล้ม', async () => {
    const t = (await createTenant(db)).id; // tenant เก่า (ก่อนมีขั้น vehicle-types)
    await db.vehicleType.create({
      data: { tenantId: t, code: '6W', nameTh: 'หกล้อของเรา', vehicleClass: '6W' },
    });
    await db.vehicleType.create({
      data: { tenantId: t, code: 'X10', nameTh: '10 ล้อ', vehicleClass: '10W' },
    });
    await bootstrapTenant(db, t);
    const rows = await db.vehicleType.findMany({
      where: { tenantId: t },
      orderBy: { code: 'asc' },
    });
    expect(rows.map((r) => r.code)).toEqual(['4W', '6W', 'REF6', 'TRC', 'TRL', 'X10']);
    expect(rows.find((r) => r.code === '6W')!.systemKey).toBeNull();
  });

  it('ตรวจค่า: ชั้นรถ/ใบขับขี่/น้ำหนัก/ป้าย ผิด → 422 · null ในช่องบังคับ → 422', async () => {
    await create({ name: 'x1', ...BASE, vehicleClass: '18W' }).expect(422);
    await create({ name: 'x2', ...BASE, minLicenceClass: 'T5' }).expect(422);
    await create({ name: 'x3', ...BASE, payloadKg: 0 }).expect(422);
    await create({ name: 'x4', ...BASE, payloadKg: 1.5 }).expect(422);
    await create({ name: 'x5', ...BASE, capabilityTags: ['FLYING'] }).expect(422);
    await create({ name: 'x6', ...BASE, volumeCbm: -1 }).expect(422);
    await create({ name: 'x7', vehicleClass: '6W', minLicenceClass: 'T2' }).expect(422);
    const v = await newType();
    for (const body of [{ name: null }, { payloadKg: null }, { capabilityTags: null }])
      await api(app, admin).patch(`/v1/vehicle-types/${v.id}`).send(body).expect(422);
  });

  it('ห้องเย็น: ต้องมีอุณหภูมิ min < max · เอาป้ายออก = ล้างอุณหภูมิ · ไม่ใช่ห้องเย็นส่งอุณหภูมิ → 422', async () => {
    const r1 = await create({ name: 'เย็น 1', ...BASE, capabilityTags: ['REFRIGERATED'] }).expect(
      422,
    );
    expect(r1.body.errors[0]).toMatchObject({ field: 'tempMinC', code: 'required' });
    const r2 = await create({
      name: 'เย็น 2',
      ...BASE,
      capabilityTags: ['REFRIGERATED'],
      tempMinC: 8,
      tempMaxC: 2,
    }).expect(422);
    expect(r2.body.errors[0]).toMatchObject({ field: 'tempMaxC', code: 'temp_range' });
    await create({ name: 'เย็น 3', ...BASE, tempMinC: 0, tempMaxC: 4 }).expect(422);
    const v = await newType({ capabilityTags: ['REFRIGERATED'], tempMinC: -18, tempMaxC: -12.5 });
    expect(v).toMatchObject({ tempMinC: -18, tempMaxC: -12.5 });
    const off = await api(app, admin)
      .patch(`/v1/vehicle-types/${v.id}`)
      .send({ capabilityTags: ['CRANE'] })
      .expect(200);
    expect(off.body).toMatchObject({ capabilityTags: ['CRANE'], tempMinC: null, tempMaxC: null });
  });

  it('ชื่อห้ามซ้ำ (ไม่สนตัวพิมพ์) → 409 + รายการเดิม · รหัสซ้ำ → 409 · รหัสเก็บตัวใหญ่', async () => {
    const v = await newType({ name: 'Box Truck 6' });
    const d = await create({ name: 'box truck 6', ...BASE }).expect(409);
    expect(d.body.existing).toMatchObject({ code: v.code });
    const c = await newType({ code: 'dry-10' });
    expect(c.code).toBe('DRY-10');
    await create({ name: 'อื่น ๆ', ...BASE, code: 'Dry-10' }).expect(409);
    // ลบแล้วใช้ชื่อเดิมได้
    await api(app, admin)
      .post(`/v1/vehicle-types/${v.id}/delete`)
      .send({ reason: 'สร้างผิด ลบทิ้ง' })
      .expect(204);
    await create({ name: 'Box Truck 6', ...BASE }).expect(201);
  });

  it('MD-094: ปิดใช้ไม่ได้ถ้ามีรถในทะเบียน (ไม่นับปลดระวาง) · ลบไม่ได้ถ้าเคยถูกอ้างอิง → ปิดใช้แทน', async () => {
    const v = await newType();
    const car = await addVehicle(v.id);
    const g = await api(app, admin).get(`/v1/vehicle-types/${v.id}`).expect(200);
    expect(g.body.usage).toEqual({ vehicles: 1, rateCards: 0 });
    const off = await api(app, admin)
      .post(`/v1/vehicle-types/${v.id}/deactivate`)
      .send({ reason: 'เลิกใช้รถประเภทนี้แล้ว' })
      .expect(409);
    expect(off.body).toMatchObject({ code: 'in_use', references: { vehicles: 1 } });
    await db.vehicle.update({ where: { id: car.id }, data: { status: 'RETIRED' } });
    await api(app, admin)
      .post(`/v1/vehicle-types/${v.id}/deactivate`)
      .send({ reason: 'เลิกใช้รถประเภทนี้แล้ว' })
      .expect(200);
    const del = await api(app, admin)
      .post(`/v1/vehicle-types/${v.id}/delete`)
      .send({ reason: 'ไม่ใช้แล้วจริง ๆ' })
      .expect(409);
    expect(del.body.references).toEqual({ vehicles: 1 });
    const on = await api(app, admin)
      .post(`/v1/vehicle-types/${v.id}/activate`)
      .send({})
      .expect(200);
    expect(on.body.status).toBe('active');
    const h = await api(app, admin).get(`/v1/vehicle-types/${v.id}/history`).expect(200);
    expect(h.body.data.map((e: { action: string }) => e.action)).toEqual([
      'vehicle_type.reactivated',
      'vehicle_type.deactivated',
      'vehicle_type.created',
    ]);
  });

  it('แถวค่าเริ่มต้นของระบบ ปิดใช้/ลบได้เหมือนแถวอื่น (ไม่มีกฎรหัสระบบแบบ reason_code)', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท ลบค่าเริ่มต้น' });
    const tok = await tokenFor(t.id);
    const list = await api(app, tok).get('/v1/vehicle-types').query({ q: 'TRC' }).expect(200);
    const trc = list.body.data[0];
    await api(app, tok)
      .post(`/v1/vehicle-types/${trc.id}/delete`)
      .send({ reason: 'ไม่มีรถหัวลากในกิจการ' })
      .expect(204);
    await api(app, tok).get(`/v1/vehicle-types/${trc.id}`).expect(404);
  });

  it('PUT external: ครั้งแรก 201 ส่งซ้ำ 200 ไม่เกิดแถวใหม่ ไม่เพิ่ม version · GET ext:{id}', async () => {
    const body = { name: 'รถเครนจาก ERP', ...BASE, capabilityTags: ['CRANE'] };
    const a = await api(app, admin)
      .put('/v1/vehicle-types/external/ERP-VT-1')
      .send(body)
      .expect(201);
    const b = await api(app, admin)
      .put('/v1/vehicle-types/external/ERP-VT-1')
      .send(body)
      .expect(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.version).toBe(a.body.version);
    await api(app, admin).get('/v1/vehicle-types/ext:ERP-VT-1').expect(200);
    expect(await db.vehicleType.count({ where: { tenantId, externalId: 'ERP-VT-1' } })).toBe(1);
  });

  it('ค้นหา/กรอง: q (รหัส/ชื่อ), ใบขับขี่, ชั้นรถ, ป้าย · If-Match ไม่ตรง → 412 · ส่งค่าเดิมไม่เพิ่ม version', async () => {
    const t = (await createTenant(db)).id;
    const tok = await tokenFor(t);
    const mk = (body: object) =>
      api(app, tok)
        .post('/v1/vehicle-types')
        .send({ ...BASE, ...body })
        .expect(201);
    const crane = (await mk({ name: 'สิบล้อติดเครน', capabilityTags: ['CRANE'] })).body;
    await mk({ name: 'หัวลากตู้', vehicleClass: 'SEMI_TRAILER', minLicenceClass: 'T3' });
    const q = async (query: object) =>
      (await api(app, tok).get('/v1/vehicle-types').query(query).expect(200)).body.data.map(
        (x: { name: string }) => x.name,
      );
    expect(await q({ q: 'เครน' })).toEqual(['สิบล้อติดเครน']);
    expect(await q({ q: 'vt-0002' })).toEqual(['หัวลากตู้']);
    expect(await q({ minLicenceClass: 'T3' })).toEqual(['หัวลากตู้']);
    expect(await q({ vehicleClass: '10W' })).toEqual(['สิบล้อติดเครน']);
    expect(await q({ capability: 'CRANE' })).toEqual(['สิบล้อติดเครน']);
    await api(app, tok)
      .patch(`/v1/vehicle-types/${crane.id}`)
      .set('If-Match', '"99"')
      .send({ payloadKg: 1 })
      .expect(412);
    const same = await api(app, tok)
      .patch(`/v1/vehicle-types/${crane.id}`)
      .send({ payloadKg: 15000, capabilityTags: ['CRANE'] })
      .expect(200);
    expect(same.body.version).toBe(crane.version);
  });

  it('สิทธิ์: master:read อ่านได้แต่แก้ไม่ได้ · ส่งออกต้อง export:run · ประวัติไม่ส่ง ip ให้ผู้ไม่มี audit:read', async () => {
    const v = await newType();
    const viewer = await tokenFor(tenantId, 'master:read');
    await api(app, viewer).get(`/v1/vehicle-types/${v.id}`).expect(200);
    await api(app, viewer)
      .post('/v1/vehicle-types')
      .send({ name: 'x', ...BASE })
      .expect(403);
    await api(app, viewer).patch(`/v1/vehicle-types/${v.id}`).send({ payloadKg: 1 }).expect(403);
    await api(app, viewer).get('/v1/vehicle-types/export').expect(403);
    const csv = await api(app, admin).get('/v1/vehicle-types/export?format=csv').expect(200);
    expect(csv.text).toContain('ประเภทรถ');
    const h = await api(app, viewer).get(`/v1/vehicle-types/${v.id}/history`).expect(200);
    expect(h.body.data[0].ip).toBeNull();
    const none = await tokenFor(tenantId, 'orders:read');
    await api(app, none).get('/v1/vehicle-types').expect(403);
  });
});
