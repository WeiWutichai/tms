import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId, type IdKind } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import {
  CompatibilityService,
  type CompatibilityCheckInput,
} from '../src/modules/compatibility/compatibility.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/** ST2-T16 Vehicle-type compatibility — docs/04 B (เตือน ไม่บล็อก) · spec/03 §6 รหัสกฎ · MD-054/071/072/093 */
describe('ความเข้ากันได้ของประเภทรถ (CompatibilityService)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let svc: CompatibilityService;
  let dbs: DbService;
  let bag: string;
  let seed = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ทดสอบความเข้ากันได้' })).id;
    admin = await tokenFor(tenantId);
    svc = app.get(CompatibilityService);
    dbs = app.get(DbService);
    const u = await api(app, admin).get('/v1/units?limit=50').expect(200);
    bag = (u.body.data as { id: string; code: string }[]).find((x) => x.code === 'BAG')!.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const uuid = (kind: IdKind, id: string) => tryDecodeId(kind, id)!;
  const vtype = async (extra: object) =>
    (
      await api(app, admin)
        .post('/v1/vehicle-types')
        .send({
          name: `ประเภททดสอบ ${++seed}`,
          vehicleClass: '6W',
          payloadKg: 6000,
          minLicenceClass: 'T2',
          ...extra,
        })
        .expect(201)
    ).body as { id: string; code: string };
  const product = async (extra: object) =>
    (
      await api(app, admin)
        .post('/v1/products')
        .send({ name: `สินค้าทดสอบ ${++seed}`, unitId: bag, weightPerUnitKg: 25, ...extra })
        .expect(201)
    ).body as { id: string; code: string };
  const site = async (extra: object = {}) =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({
          name: `จุดทดสอบ ${++seed}`,
          kind: 'DROPOFF',
          address: { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
          ...extra,
        })
        .expect(201)
    ).body as { id: string; code: string };
  const check = (input: CompatibilityCheckInput, tenant = tenantId) =>
    dbs.withTenant(tenant, (tx) => svc.check(input, tx));

  it('เกณฑ์ตรวจรับ: สินค้าห้องเย็นเท่านั้น + รถธรรมดา → คำเตือน TEMP_MISMATCH (ไม่บล็อก, ไม่เขียนข้อมูล)', async () => {
    const normal = await vtype({ name: '6 ล้อ ตู้ทึบ ทดสอบ' });
    const reefer = await vtype({
      name: '6 ล้อ ห้องเย็น ทดสอบ',
      capabilityTags: ['REFRIGERATED'],
      tempMinC: 0,
      tempMaxC: 8,
    });
    const chilled = await product({
      name: 'นมพาสเจอไรซ์',
      tempControlled: true,
      tempMinC: 2,
      tempMaxC: 6,
    });
    const audits = await db.auditLog.count({ where: { tenantId } });

    const r = await check({
      vehicleTypeId: uuid('vehicleType', normal.id),
      productIds: [uuid('product', chilled.id)],
    });
    expect(r.vehicleType).toMatchObject({ id: normal.id, code: normal.code });
    expect(r.requiresOverride).toBe(true);
    expect(r.warnings).toEqual([
      {
        code: 'TEMP_MISMATCH',
        severity: 'warning',
        messageKey: 'compat.tempNotRefrigerated',
        params: { productTempMinC: 2, productTempMaxC: 6 },
        source: { kind: 'product', id: chilled.id, code: chilled.code },
        message: `สินค้าควบคุมอุณหภูมิ (${chilled.code} นมพาสเจอไรซ์) ต้องใช้รถห้องเย็น แต่ประเภทรถที่เลือกไม่ใช่ห้องเย็น`,
      },
    ]);

    const ok = await check({
      vehicleTypeId: uuid('vehicleType', reefer.id),
      productIds: [uuid('product', chilled.id)],
    });
    expect(ok.warnings).toEqual([]);
    expect(ok.requiresOverride).toBe(false);
    expect(await db.auditLog.count({ where: { tenantId } })).toBe(audits);
  });

  it('ช่วงอุณหภูมิ (numeric 4,1) ไม่ครอบคลุม + สินค้าอันตราย + จุดรับรถได้สูงสุด 6 ล้อ (ห้าม 10 ล้อเข้าซอย)', async () => {
    const reefer10 = await vtype({
      vehicleClass: '10W',
      payloadKg: 12000,
      capabilityTags: ['REFRIGERATED'],
      tempMinC: -5,
      tempMaxC: 8,
    });
    const frozen = await product({
      name: 'ไอศกรีม',
      tempControlled: true,
      tempMinC: -20,
      tempMaxC: -18,
    });
    const chem = await product({
      name: 'ทินเนอร์',
      hazardous: true,
      unNumber: '1263',
      hazardClass: '3',
    });
    const soi = await site({ name: 'ร้านในซอย', maxVehicleClass: '6W' });
    const open = await site({ name: 'คลังใหญ่' });
    const r = await check({
      vehicleTypeId: uuid('vehicleType', reefer10.id),
      productIds: [uuid('product', frozen.id), uuid('product', chem.id)],
      siteIds: [uuid('site', open.id), uuid('site', soi.id)],
    });
    expect(r.warnings.map((w) => [w.code, w.source.id])).toEqual([
      ['TEMP_MISMATCH', frozen.id],
      ['HAZMAT_NOT_ALLOWED', chem.id],
      ['LOCATION_VEHICLE_LIMIT', soi.id],
    ]);
    expect(r.warnings.map((w) => w.message)).toEqual([
      `ช่วงอุณหภูมิรถ -5…8 °C ไม่ครอบคลุมสินค้า (${frozen.code} ไอศกรีม) -20…-18 °C`,
      `สินค้าอันตราย (${chem.code} ทินเนอร์) แต่ประเภทรถที่เลือกไม่มีป้าย "สินค้าอันตราย"`,
      `สถานที่ (${soi.code} ร้านในซอย) รับรถได้สูงสุด 6 ล้อ — รถ 10 ล้อ เข้าไม่ได้`,
    ]);
  });

  it('ส่ง vehicleId แทนประเภทรถได้ · งานต้องการติดเครน / SO ขอรถใหญ่กว่า (MD-093) · ใหญ่กว่า = info ไม่ต้อง override', async () => {
    const t6 = await vtype({ vehicleClass: '6W' });
    const t10 = await vtype({ vehicleClass: '10W', payloadKg: 15000 });
    const v = await api(app, admin)
      .post('/v1/vehicles')
      .send({ plate: '70-1616', plateProvince: 'TH-10', vehicleTypeId: t6.id, ownership: 'OWN' })
      .expect(201);
    const r = await check({
      vehicleId: uuid('vehicle', v.body.id),
      job: { requestedVehicleTypeId: uuid('vehicleType', t10.id), requiredCapabilities: ['CRANE'] },
    });
    expect(r.vehicleType.id).toBe(t6.id);
    expect(r.warnings.map((w) => [w.code, w.message])).toEqual([
      ['CAPABILITY_MISSING', 'งานนี้ต้องใช้รถติดเครน แต่ประเภทรถที่เลือกไม่มี'],
      ['VEHICLE_SMALLER_THAN_REQUESTED', 'รถ 6 ล้อ เล็กกว่าที่ SO ขอ (10 ล้อ)'],
    ]);
    const larger = await check({
      vehicleTypeId: uuid('vehicleType', t10.id),
      job: { requestedVehicleTypeId: uuid('vehicleType', t6.id) },
    });
    expect(larger.warnings.map((w) => [w.code, w.severity])).toEqual([
      ['VEHICLE_LARGER_THAN_REQUESTED', 'info'],
    ]);
    expect(larger.requiresOverride).toBe(false);
  });

  it('แยก tenant: ประเภทรถ/รถของ tenant อื่น → 404 · สินค้า/จุด/ประเภทที่ขอของ tenant อื่น → 422 reference_not_found · id ผิดรูปแบบไม่ใช่ 500', async () => {
    const mine = await vtype({ vehicleClass: '10W', payloadKg: 15000 });
    const chilled = await product({ tempControlled: true, tempMinC: 2, tempMaxC: 8 });
    const soi = await site({ maxVehicleClass: '6W' });
    const other = await createTenantWithDefaults(db, { name: 'บริษัท อื่น' });
    // 10 ล้อธรรมดาของ tenant อื่น — ถ้ามองเห็นสินค้า/จุดของเรา จะต้องได้คำเตือน
    const otherVt = (
      await db.vehicleType.findFirstOrThrow({
        where: { tenantId: other.id, vehicleClass: '10W', capabilityTags: { isEmpty: true } },
        select: { id: true },
      })
    ).id;
    // ควบคุม: ใน tenant ของเรา สินค้า/จุดชุดนี้กับ 10 ล้อธรรมดาได้ 2 คำเตือน
    const control = await check({
      vehicleTypeId: uuid('vehicleType', mine.id),
      productIds: [uuid('product', chilled.id)],
      siteIds: [uuid('site', soi.id)],
    });
    expect(control.warnings.map((w) => w.code)).toEqual([
      'TEMP_MISMATCH',
      'LOCATION_VEHICLE_LIMIT',
    ]);
    // ประเภทรถของเรา เรียกใน tenant อื่น → 404
    await expect(
      check({ vehicleTypeId: uuid('vehicleType', mine.id) }, other.id),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    // รถของเรา (vehicleId) เรียกใน tenant อื่น → 404
    const v = await api(app, admin)
      .post('/v1/vehicles')
      .send({ plate: '70-1617', plateProvince: 'TH-10', vehicleTypeId: mine.id, ownership: 'OWN' })
      .expect(201);
    await expect(check({ vehicleId: uuid('vehicle', v.body.id) }, other.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    // tenant อื่นใช้ประเภทรถของตัวเอง + id สินค้า/จุด/ประเภทที่ขอของเรา → RLS ซ่อน = 422 reference_not_found (ไม่ผ่านเงียบ)
    await expect(
      check(
        {
          vehicleTypeId: otherVt,
          productIds: [uuid('product', chilled.id)],
          siteIds: [uuid('site', soi.id)],
          job: { requestedVehicleTypeId: uuid('vehicleType', mine.id) },
        },
        other.id,
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      errors: [
        { field: 'productIds[0]', code: 'reference_not_found' },
        { field: 'siteIds[0]', code: 'reference_not_found' },
        { field: 'job.requestedVehicleTypeId', code: 'reference_not_found' },
      ],
    });
    // id ไม่ใช่ uuid: ประเภทรถ/รถ → 404, สินค้า/จุด → 422 (ไม่ใช่ 500)
    await expect(check({ vehicleTypeId: 'not-a-uuid' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(check({ vehicleId: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      check({ vehicleTypeId: uuid('vehicleType', mine.id), productIds: ['abc'], siteIds: ['1'] }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      errors: [{ field: 'productIds[0]' }, { field: 'siteIds[0]' }],
    });
    await expect(
      check({ vehicleTypeId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('ประเภทรถ/รถที่ลบแล้ว (soft delete) → 404', async () => {
    const t = await vtype({});
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({ plate: '70-1618', plateProvince: 'TH-10', vehicleTypeId: t.id, ownership: 'OWN' })
        .expect(201)
    ).body as { id: string };
    expect((await check({ vehicleId: uuid('vehicle', v.id) })).vehicleType.id).toBe(t.id);
    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/delete`)
      .send({ reason: 'สร้างผิด ลบทิ้ง ทดสอบ' })
      .expect(204);
    await expect(check({ vehicleId: uuid('vehicle', v.id) })).rejects.toMatchObject({
      code: 'not_found',
    });
    await api(app, admin)
      .post(`/v1/vehicle-types/${t.id}/delete`)
      .send({ reason: 'สร้างผิด ลบทิ้ง ทดสอบ' })
      .expect(204);
    await expect(check({ vehicleTypeId: uuid('vehicleType', t.id) })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('ประเภทรถที่ SO ขอเป็นห้องเย็น 6 ล้อ + รถ 6 ล้อธรรมดา → CAPABILITY_MISSING (REFRIGERATED) แม้ไม่มีสินค้า', async () => {
    const reqReefer = await vtype({
      vehicleClass: '6W',
      capabilityTags: ['REFRIGERATED'],
      tempMinC: 0,
      tempMaxC: 8,
    });
    const plain = await vtype({ vehicleClass: '6W' });
    const r = await check({
      vehicleTypeId: uuid('vehicleType', plain.id),
      job: {
        requestedVehicleTypeId: uuid('vehicleType', reqReefer.id),
        requiredCapabilities: ['REFRIGERATED'],
      },
    });
    expect(r.warnings.map((w) => [w.code, w.params.capability])).toEqual([
      ['CAPABILITY_MISSING', 'REFRIGERATED'],
    ]);
    expect(r.requiresOverride).toBe(true);
    // ใช้ประเภทเดียวกับที่ขอ → ไม่มีคำเตือน
    const same = await check({
      vehicleTypeId: uuid('vehicleType', reqReefer.id),
      job: { requestedVehicleTypeId: uuid('vehicleType', reqReefer.id) },
    });
    expect(same.warnings).toEqual([]);
  });

  it('สินค้าที่ปิดใช้/ลบแล้วยังถูกนำมาเทียบ (SO เก่าอ้างได้)', async () => {
    const plain = await vtype({ vehicleClass: '6W' });
    const off = await product({
      name: 'ปลาแช่เย็น',
      tempControlled: true,
      tempMinC: 0,
      tempMaxC: 4,
    });
    const gone = await product({
      name: 'กรดซัลฟิวริก',
      hazardous: true,
      unNumber: '1830',
      hazardClass: '8',
    });
    await api(app, admin)
      .post(`/v1/products/${off.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้สินค้า' })
      .expect(200);
    await api(app, admin)
      .post(`/v1/products/${gone.id}/delete`)
      .send({ reason: 'ทดสอบลบสินค้า' })
      .expect(204);
    const r = await check({
      vehicleTypeId: uuid('vehicleType', plain.id),
      productIds: [uuid('product', off.id), uuid('product', gone.id)],
    });
    expect(r.warnings.map((w) => [w.code, w.source.id])).toEqual([
      ['TEMP_MISMATCH', off.id],
      ['HAZMAT_NOT_ALLOWED', gone.id],
    ]);
  });
});
