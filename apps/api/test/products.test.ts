import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { requiredCapabilities } from '../src/modules/products/products.service';
import { ensureDefaultUnits } from '../src/modules/products/unit-defaults';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

type Unit = { id: string; code: string; name: string; kind: string; system: boolean };

/** ST2-T10 สินค้า / หน่วย — docs/04 B สินค้า/หน่วย, spec/02 §3 */
describe('สินค้าและหน่วย (products, units)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let units: Record<string, Unit> = {};
  let seed = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท สินค้าทดสอบ' })).id;
    admin = await tokenFor(tenantId);
    const r = await api(app, admin).get('/v1/units?limit=50').expect(200);
    units = Object.fromEntries((r.body.data as Unit[]).map((u) => [u.code, u]));
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const create = (body: object, token = admin) => api(app, token).post('/v1/products').send(body);
  const newProduct = async (extra: object = {}) =>
    (
      await create({
        name: `สินค้าทดสอบ ${++seed}`,
        unitId: units.BAG!.id,
        weightPerUnitKg: 25,
        ...extra,
      }).expect(201)
    ).body;
  const newCustomer = async (status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') => {
    const c = await db.customer.create({
      data: {
        tenantId,
        code: `PC-${++seed}`,
        legalName: `ลูกค้าสินค้า ${seed}`,
        taxId: validTaxId(500 + seed),
        status,
      },
    });
    return `cus_${c.id.replace(/-/g, '')}`;
  };

  // ---------- หน่วย ----------

  it('tenant ใหม่มีหน่วยเริ่มต้น 9 หน่วย (spec/02 §3) — ชนิด/ตัวแปลงถูก, รันซ้ำไม่สร้างซ้ำ', async () => {
    expect(Object.keys(units).sort()).toEqual(
      ['BAG', 'BOX', 'CBM', 'CTN', 'KG', 'L', 'PCS', 'PLT', 'TON'].sort(),
    );
    expect(units.TON).toMatchObject({ name: 'ตัน', kind: 'WEIGHT', toKg: 1000, system: true });
    expect(units.L).toMatchObject({ name: 'ลิตร', kind: 'VOLUME', toCbm: 0.001, toKg: null });
    expect(units.PLT).toMatchObject({ name: 'พาเลท', kind: 'COUNT', toKg: null, toCbm: null });
    await ensureDefaultUnits(db, tenantId);
    expect(await db.unit.count({ where: { tenantId } })).toBe(9);
    expect(
      await db.auditLog.count({ where: { tenantId, action: 'unit.created', actorId: null } }),
    ).toBe(9);
  });

  it('หน่วย: สร้าง/แก้/ปิดใช้; ชนิดน้ำหนักต้องมี toKg; รหัส/ชื่อซ้ำ 409; หน่วยของระบบแก้ได้เฉพาะชื่อและลบไม่ได้', async () => {
    const u = api(app, admin);
    await u.post('/v1/units').send({ code: 'G', name: 'กรัม', kind: 'WEIGHT' }).expect(422);
    await u
      .post('/v1/units')
      .send({ code: 'DRUM', name: 'ถัง', kind: 'COUNT', toKg: 200 })
      .expect(422);
    const drum = (
      await u.post('/v1/units').send({ code: 'drum', name: 'ถัง', kind: 'COUNT' }).expect(201)
    ).body;
    expect(drum).toMatchObject({ code: 'DRUM', kind: 'COUNT', system: false, products: 0 });
    expect(drum.id).toMatch(/^unt_[0-9a-f]{32}$/);
    const dupCode = await u
      .post('/v1/units')
      .send({ code: 'Drum', name: 'ถังใหญ่', kind: 'COUNT' })
      .expect(409);
    expect(dupCode.body.errors[0]).toMatchObject({ field: 'code', code: 'duplicate' });
    const dupName = await u
      .post('/v1/units')
      .send({ code: 'DR2', name: 'ถัง', kind: 'COUNT' })
      .expect(409);
    expect(dupName.body.errors[0]).toMatchObject({ field: 'name', code: 'duplicate' });
    // หน่วยของระบบ: เปลี่ยนชื่อได้ · เปลี่ยนชนิด/ตัวแปลง/รหัส → 422 system_unit · ลบ → 409
    const ton = units.TON!;
    const bad = await u.patch(`/v1/units/${ton.id}`).send({ toKg: 900 }).expect(422);
    expect(bad.body.errors[0].code).toBe('system_unit');
    await u.patch(`/v1/units/${ton.id}`).send({ code: 'T' }).expect(422);
    const renamed = await u.patch(`/v1/units/${ton.id}`).send({ name: 'ตัน (เมตริก)' }).expect(200);
    expect(renamed.body).toMatchObject({ name: 'ตัน (เมตริก)', toKg: 1000, version: 2 });
    await u.patch(`/v1/units/${ton.id}`).send({ name: 'ตัน' }).expect(200);
    const del = await u
      .post(`/v1/units/${ton.id}/delete`)
      .send({ reason: 'ทดสอบลบหน่วยของระบบ' })
      .expect(409);
    expect(del.body.code).toBe('conflict');
    // ปิดใช้หน่วยของระบบได้ (เหตุผล ≥ 10) แล้วเปิดคืน
    await u.post(`/v1/units/${ton.id}/deactivate`).send({ reason: 'สั้น' }).expect(422);
    const off = await u
      .post(`/v1/units/${ton.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้หน่วยตัน' })
      .expect(200);
    expect(off.body.status).toBe('inactive');
    await u.post(`/v1/units/${ton.id}/activate`).send({}).expect(200);
    // หน่วยที่ผู้ใช้สร้าง + ไม่มีสินค้าใช้: เปลี่ยนชนิดได้, ลบได้
    await u.patch(`/v1/units/${drum.id}`).send({ kind: 'VOLUME', toCbm: 0.2 }).expect(200);
    await u
      .post(`/v1/units/${drum.id}/delete`)
      .send({ reason: 'ทดสอบลบหน่วยที่สร้างเอง' })
      .expect(204);
    await u.get(`/v1/units/${drum.id}`).expect(404);
    const h = await u.get(`/v1/units/${ton.id}/history`).expect(200);
    expect(h.body.data.map((x: { action: string }) => x.action)).toContain('unit.deactivated');
  });

  // ---------- สินค้า ----------

  it('สร้างสินค้า: รหัส P-0001, หน่วย, น้ำหนัก/ปริมาตร numeric, audit + event; รหัสซ้ำ 409 (ไม่สนตัวพิมพ์)', async () => {
    const r = await create({
      name: 'ปูนซีเมนต์ถุง 50 กก.',
      unitId: units.BAG!.id,
      weightPerUnitKg: 50,
      volumePerUnitCbm: 0.035,
      barcode: '8851234567890',
    }).expect(201);
    expect(r.body).toMatchObject({
      code: 'P-0001',
      name: 'ปูนซีเมนต์ถุง 50 กก.',
      unit: { id: units.BAG!.id, code: 'BAG', name: 'ถุง', kind: 'COUNT' },
      weightPerUnitKg: 50,
      volumePerUnitCbm: 0.035,
      altUnits: [],
      fragile: false,
      hazardous: false,
      tempControlled: false,
      stackable: true,
      customer: null,
      requiredCapabilities: [],
      status: 'active',
      version: 1,
    });
    expect(r.body.id).toMatch(/^prd_[0-9a-f]{32}$/);
    const row = await db.product.findUniqueOrThrow({
      where: { id: tryDecodeId('product', r.body.id)! },
    });
    expect(row.weightPerUnitKg?.toString()).toBe('50');
    expect(row.volumePerUnitCbm?.toString()).toBe('0.035');
    expect(
      await db.domainEvent.count({ where: { localId: row.id, type: 'product.created' } }),
    ).toBe(1);
    const h = await api(app, admin).get(`/v1/products/${r.body.id}/history`).expect(200);
    expect(h.body.data[0].action).toBe('product.created');
    // รหัสซ้ำ (ตัวพิมพ์ต่าง) → 409 + รายการเดิม
    const dup = await create({
      code: 'p-0001',
      name: 'ซ้ำ',
      unitId: units.BAG!.id,
      weightPerUnitKg: 1,
    }).expect(409);
    expect(dup.body.errors[0]).toMatchObject({ field: 'code', code: 'duplicate' });
    expect(dup.body.existing).toMatchObject({ id: r.body.id, code: 'P-0001' });
    // หน่วยอ้างด้วยรหัส code:PLT ได้
    const byCode = await newProduct({ unitId: 'code:plt', weightPerUnitKg: 980 });
    expect(byCode.unit.code).toBe('PLT');
  });

  it('หน่วยกับน้ำหนัก: หน่วยนับต้องมีน้ำหนัก, หน่วยน้ำหนัก/ปริมาตร = ตัวแปลงของหน่วย (ระบบใส่ให้), หน่วยปิดใช้เลือกไม่ได้', async () => {
    const miss = await create({ name: 'ไม่มีน้ำหนัก', unitId: units.BOX!.id }).expect(422);
    expect(miss.body.errors[0]).toMatchObject({ field: 'weightPerUnitKg', code: 'required' });
    await create({ name: 'น้ำหนักศูนย์', unitId: units.BOX!.id, weightPerUnitKg: 0 }).expect(422);
    await create({ name: 'ทศนิยมเกิน', unitId: units.BOX!.id, weightPerUnitKg: 1.2345 }).expect(
      422,
    );
    // ตัน → น้ำหนักต่อหน่วย 1,000 กก. อัตโนมัติ; ส่งค่าอื่น → 422 fixed_by_unit
    const steel = await newProduct({
      name: 'เหล็กแผ่น',
      unitId: units.TON!.id,
      weightPerUnitKg: undefined,
    });
    expect(steel.weightPerUnitKg).toBe(1000);
    const fixed = await create({
      name: 'เหล็กผิด',
      unitId: units.TON!.id,
      weightPerUnitKg: 900,
    }).expect(422);
    expect(fixed.body.errors[0]).toMatchObject({ field: 'weightPerUnitKg', code: 'fixed_by_unit' });
    // ลิตร → ปริมาตร 0.001 ลบ.ม.; น้ำหนักไม่บังคับ
    const oil = await newProduct({ name: 'น้ำมัน', unitId: units.L!.id, weightPerUnitKg: 0.9 });
    expect(oil).toMatchObject({ volumePerUnitCbm: 0.001, weightPerUnitKg: 0.9 });
    // เปลี่ยนหน่วยของสินค้าเดิมเป็นตัน → น้ำหนักเปลี่ยนตาม
    const p = await newProduct();
    const moved = await api(app, admin)
      .patch(`/v1/products/${p.id}`)
      .send({ unitId: units.TON!.id })
      .expect(200);
    expect(moved.body.weightPerUnitKg).toBe(1000);
    // หน่วยปิดใช้ → 422 unit_inactive (สินค้าเดิมที่ใช้หน่วยนั้นยังแก้ฟิลด์อื่นได้)
    const box = units.BOX!;
    await api(app, admin)
      .post(`/v1/units/${box.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้หน่วยกล่อง' })
      .expect(200);
    const off = await create({ name: 'กล่องปิดใช้', unitId: box.id, weightPerUnitKg: 1 }).expect(
      422,
    );
    expect(off.body.errors[0]).toMatchObject({ field: 'unitId', code: 'unit_inactive' });
    await api(app, admin).post(`/v1/units/${box.id}/activate`).send({}).expect(200);
    // หน่วยที่สินค้าใช้: ลบไม่ได้ (409 in_use) · หน่วยที่สร้างเองเปลี่ยนชนิดไม่ได้ (422 unit_in_use)
    const crate = (
      await api(app, admin)
        .post('/v1/units')
        .send({ code: 'CRATE', name: 'ลัง', kind: 'COUNT' })
        .expect(201)
    ).body;
    await newProduct({ unitId: crate.id, weightPerUnitKg: 12 });
    const inUse = await api(app, admin)
      .post(`/v1/units/${crate.id}/delete`)
      .send({ reason: 'ทดสอบลบหน่วยที่ใช้อยู่' })
      .expect(409);
    expect(inUse.body).toMatchObject({ code: 'in_use', references: { products: 1 } });
    const kind = await api(app, admin)
      .patch(`/v1/units/${crate.id}`)
      .send({ kind: 'WEIGHT', toKg: 10 })
      .expect(422);
    expect(kind.body.errors[0].code).toBe('unit_in_use');
    const listed = await api(app, admin).get(`/v1/units/${crate.id}`).expect(200);
    expect(listed.body.products).toBe(1);
  });

  it('หน่วยแปลง (MD-070): 1 พาเลท = 40 ถุง; ห้ามซ้ำ/ห้ามเป็นหน่วยหลัก; แก้แทนทั้งชุด; ส่งซ้ำไม่เพิ่ม version', async () => {
    const p = await newProduct({
      name: 'ปูนถุง',
      weightPerUnitKg: 50,
      altUnits: [{ unitId: 'code:PLT', factorToBase: 40 }],
    });
    expect(p.altUnits).toEqual([
      { unit: expect.objectContaining({ code: 'PLT', name: 'พาเลท' }), factorToBase: 40 },
    ]);
    // เกณฑ์ตรวจรับ spec/02 §3: 12 พาเลท = 12 × 40 × 50 = 24,000 กก.
    expect(12 * p.altUnits[0].factorToBase * p.weightPerUnitKg).toBe(24000);
    const same = await create({
      name: 'หน่วยแปลงซ้ำหน่วยหลัก',
      unitId: units.BAG!.id,
      weightPerUnitKg: 1,
      altUnits: [{ unitId: units.BAG!.id, factorToBase: 2 }],
    }).expect(422);
    expect(same.body.errors[0]).toMatchObject({ field: 'altUnits.0.unitId', code: 'same_as_base' });
    const dup = await create({
      name: 'หน่วยแปลงซ้ำ',
      unitId: units.BAG!.id,
      weightPerUnitKg: 1,
      altUnits: [
        { unitId: units.PLT!.id, factorToBase: 2 },
        { unitId: 'code:PLT', factorToBase: 3 },
      ],
    }).expect(422);
    expect(dup.body.errors[0]).toMatchObject({ field: 'altUnits.1.unitId', code: 'duplicate' });
    await create({
      name: 'factor ศูนย์',
      unitId: units.BAG!.id,
      weightPerUnitKg: 1,
      altUnits: [{ unitId: units.PLT!.id, factorToBase: 0 }],
    }).expect(422);
    // ส่งชุดเดิม (ลำดับ/รูปแบบต่าง) → ไม่เพิ่ม version
    const noop = await api(app, admin)
      .patch(`/v1/products/${p.id}`)
      .send({ altUnits: [{ unitId: units.PLT!.id, factorToBase: 40.0 }], weightPerUnitKg: 50 })
      .expect(200);
    expect(noop.body.version).toBe(1);
    // แทนทั้งชุด
    const upd = await api(app, admin)
      .patch(`/v1/products/${p.id}`)
      .set('If-Match', '"1"')
      .send({
        altUnits: [
          { unitId: units.TON!.id, factorToBase: 20 },
          { unitId: units.PLT!.id, factorToBase: 36 },
        ],
      })
      .expect(200);
    expect(upd.body.version).toBe(2);
    expect(upd.body.altUnits.map((a: { unit: { code: string } }) => a.unit.code).sort()).toEqual([
      'PLT',
      'TON',
    ]);
    // เปลี่ยนหน่วยหลักเป็นหน่วยที่อยู่ในหน่วยแปลง โดยไม่ส่งหน่วยแปลง → 422
    await api(app, admin).patch(`/v1/products/${p.id}`).send({ unitId: units.PLT!.id }).expect(422);
    await api(app, admin)
      .patch(`/v1/products/${p.id}`)
      .send({ altUnits: [] })
      .expect(200)
      .then((r) => expect(r.body.altUnits).toEqual([]));
  });

  it('สินค้าอันตราย: ต้องมีเลข UN 4 หลัก + class 1–9 (รับ "UN1993"); เอาออก = ล้างค่า; ไม่อันตรายส่ง UN → 422', async () => {
    const miss = await create({
      name: 'สารเคมี',
      unitId: units.PCS!.id,
      weightPerUnitKg: 210,
      hazardous: true,
    }).expect(422);
    expect(miss.body.errors[0]).toMatchObject({ field: 'unNumber', code: 'required' });
    await create({
      name: 'สารเคมี',
      unitId: units.PCS!.id,
      weightPerUnitKg: 210,
      hazardous: true,
      unNumber: '199',
      hazardClass: '3',
    }).expect(422);
    await create({
      name: 'สารเคมี',
      unitId: units.PCS!.id,
      weightPerUnitKg: 210,
      hazardous: true,
      unNumber: '1993',
      hazardClass: '10',
    }).expect(422);
    const chem = await newProduct({
      name: 'สารเคมีอุตสาหกรรม',
      unitId: units.PCS!.id,
      weightPerUnitKg: 210,
      hazardous: true,
      unNumber: 'UN 1993',
      hazardClass: '3',
    });
    expect(chem).toMatchObject({
      hazardous: true,
      unNumber: '1993',
      hazardClass: '3',
      requiredCapabilities: ['HAZMAT'],
    });
    await newProduct({ hazardous: true, unNumber: '1005', hazardClass: '2.3' });
    const notHaz = await create({
      name: 'ไม่อันตรายแต่ส่ง UN',
      unitId: units.PCS!.id,
      weightPerUnitKg: 1,
      unNumber: '1993',
    }).expect(422);
    expect(notHaz.body.errors[0].code).toBe('not_hazardous');
    const off = await api(app, admin)
      .patch(`/v1/products/${chem.id}`)
      .send({ hazardous: false })
      .expect(200);
    expect(off.body).toMatchObject({ hazardous: false, unNumber: null, hazardClass: null });
  });

  it('ควบคุมอุณหภูมิ: ต้องมี min/max −40…+30 และ min < max; เทียบได้กับช่วงของประเภทรถห้องเย็น (REFRIGERATED)', async () => {
    const base = { name: 'นม', unitId: units.BOX!.id, weightPerUnitKg: 12, tempControlled: true };
    expect((await create(base).expect(422)).body.errors[0]).toMatchObject({
      field: 'tempMinC',
      code: 'required',
    });
    expect(
      (await create({ ...base, tempMinC: 8, tempMaxC: 2 }).expect(422)).body.errors[0].code,
    ).toBe('temp_range');
    await create({ ...base, tempMinC: -41, tempMaxC: 2 }).expect(422);
    await create({ ...base, tempMinC: 2, tempMaxC: 31 }).expect(422);
    await create({ ...base, tempMinC: 2.25, tempMaxC: 8 }).expect(422);
    const milk = await newProduct({ ...base, name: 'ผลิตภัณฑ์นม', tempMinC: 2, tempMaxC: 8 });
    expect(milk).toMatchObject({
      tempControlled: true,
      tempMinC: 2,
      tempMaxC: 8,
      requiredCapabilities: ['REFRIGERATED'],
    });
    // ช่วงของรถห้องเย็นเริ่มต้น (REF6: 0…8 °C) ครอบคลุมสินค้า 2…8 °C (MD-072 — ฟังก์ชันเทียบอยู่ใน ST2-T16)
    const ref6 = await db.vehicleType.findFirstOrThrow({ where: { tenantId, code: 'REF6' } });
    expect(ref6.capabilityTags).toContain('REFRIGERATED');
    expect(Number(ref6.tempMinC) <= milk.tempMinC && Number(ref6.tempMaxC) >= milk.tempMaxC).toBe(
      true,
    );
    expect(requiredCapabilities({ tempControlled: true, hazardous: true })).toEqual([
      'REFRIGERATED',
      'HAZMAT',
    ]);
    const plain = await create({ ...base, tempControlled: false, tempMinC: 2 }).expect(422);
    expect(plain.body.errors[0].code).toBe('not_temp_controlled');
    const off = await api(app, admin)
      .patch(`/v1/products/${milk.id}`)
      .send({ tempControlled: false })
      .expect(200);
    expect(off.body).toMatchObject({ tempMinC: null, tempMaxC: null, requiredCapabilities: [] });
  });

  it('ลูกค้า (ไม่บังคับ): สินค้าของลูกค้ารายเดียว; ลูกค้าปิดใช้/ไม่พบ → 422; ลบลูกค้าที่มีสินค้า → 409', async () => {
    const cus = await newCustomer();
    const p = await newProduct({ customerId: cus });
    expect(p.customer).toMatchObject({ id: cus, code: expect.stringMatching(/^PC-/) });
    const inactive = await newCustomer('INACTIVE');
    expect(
      (
        await create({
          name: 'x',
          unitId: units.BAG!.id,
          weightPerUnitKg: 1,
          customerId: inactive,
        }).expect(422)
      ).body.errors[0].code,
    ).toBe('customer_inactive');
    await create({
      name: 'x',
      unitId: units.BAG!.id,
      weightPerUnitKg: 1,
      customerId: `cus_${'0'.repeat(32)}`,
    }).expect(422);
    const del = await api(app, admin)
      .post(`/v1/customers/${cus}/delete`)
      .send({ reason: 'ทดสอบลบลูกค้าที่มีสินค้า' })
      .expect(409);
    expect(del.body.references).toMatchObject({ products: 1 });
    // กรองสินค้าของลูกค้า / ไม่ผูกลูกค้า
    const mine = await api(app, admin).get(`/v1/products?customerId=${cus}`).expect(200);
    expect(mine.body.data.map((x: { id: string }) => x.id)).toEqual([p.id]);
    const none = await api(app, admin).get('/v1/products?customerId=none&limit=200').expect(200);
    expect(none.body.data.some((x: { id: string }) => x.id === p.id)).toBe(false);
    // ล้างลูกค้า
    const cleared = await api(app, admin)
      .patch(`/v1/products/${p.id}`)
      .send({ customerId: null })
      .expect(200);
    expect(cleared.body.customer).toBeNull();
  });

  it('If-Match: version ถูก → 200 + audit diff; version เก่า → 412; null ในช่องห้ามว่าง → 422', async () => {
    const p = await newProduct();
    const r = await api(app, admin)
      .patch(`/v1/products/${p.id}`)
      .set('If-Match', '"1"')
      .send({ name: 'ชื่อใหม่', fragile: true })
      .expect(200);
    expect(r.headers.etag).toBe('"2"');
    expect(r.body).toMatchObject({ name: 'ชื่อใหม่', fragile: true, version: 2 });
    await api(app, admin)
      .patch(`/v1/products/${p.id}`)
      .set('If-Match', '"1"')
      .send({ name: 'ทับ' })
      .expect(412);
    for (const body of [{ name: null }, { unitId: null }, { fragile: null }, { altUnits: null }])
      await api(app, admin).patch(`/v1/products/${p.id}`).send(body).expect(422);
    const h = await api(app, admin).get(`/v1/products/${p.id}/history`).expect(200);
    const upd = h.body.data.find((x: { action: string }) => x.action === 'product.updated');
    expect(upd).toBeTruthy();
  });

  it('PUT /products/external/{id}: ครั้งแรก 201, ส่งซ้ำ 200 ไม่เกิดแถวใหม่/ไม่เพิ่ม version; GET ext:{id}; ลบแล้วปล่อย externalId', async () => {
    const body = {
      name: 'สินค้า ERP',
      unitId: 'code:BAG',
      weightPerUnitKg: 25,
      volumePerUnitCbm: 0.04,
      altUnits: [{ unitId: 'code:PLT', factorToBase: 40 }],
      hazardous: true,
      unNumber: '1993',
      hazardClass: '3',
    };
    const a = await api(app, admin).put('/v1/products/external/ERP-P1').send(body).expect(201);
    expect(a.body).toMatchObject({ externalId: 'ERP-P1', version: 1 });
    const b = await api(app, admin).put('/v1/products/external/ERP-P1').send(body).expect(200);
    expect(b.body).toMatchObject({ id: a.body.id, version: 1 });
    expect(await db.product.count({ where: { tenantId, externalId: 'ERP-P1' } })).toBe(1);
    const c = await api(app, admin)
      .put('/v1/products/external/ERP-P1')
      .send({ ...body, name: 'สินค้า ERP (แก้)' })
      .expect(200);
    expect(c.body.version).toBe(2);
    await api(app, admin).get('/v1/products/ext:ERP-P1').expect(200);
    // externalId ซ้ำผ่าน POST → 409
    await create({ ...body, externalId: 'ERP-P1' }).expect(409);
    await api(app, admin)
      .post(`/v1/products/${a.body.id}/delete`)
      .send({ reason: 'ทดสอบลบสินค้าจาก ERP' })
      .expect(204);
    await api(app, admin).get(`/v1/products/${a.body.id}`).expect(404);
    const tomb = await api(app, admin)
      .get('/v1/products?includeDeleted=true&limit=200')
      .expect(200);
    expect(tomb.body.data.find((x: { id: string }) => x.id === a.body.id)?.deletedAt).toBeTruthy();
    const again = await api(app, admin).put('/v1/products/external/ERP-P1').send(body).expect(201);
    expect(again.body.id).not.toBe(a.body.id);
  });

  it('ปิดใช้/เปิดใช้ (เหตุผล ≥ 10) + ลบ soft delete + เปิดใช้คืนตรวจหน่วยยังใช้งาน', async () => {
    const crate = (
      await api(app, admin)
        .post('/v1/units')
        .send({ code: 'SACK', name: 'กระสอบ', kind: 'COUNT' })
        .expect(201)
    ).body;
    const p = await newProduct({ unitId: crate.id, weightPerUnitKg: 30 });
    await api(app, admin)
      .post(`/v1/products/${p.id}/deactivate`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const off = await api(app, admin)
      .post(`/v1/products/${p.id}/deactivate`)
      .send({ reason: 'เลิกขายสินค้านี้แล้ว' })
      .expect(200);
    expect(off.body.status).toBe('inactive');
    await api(app, admin)
      .post(`/v1/units/${crate.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้กระสอบ' })
      .expect(200);
    const re = await api(app, admin).post(`/v1/products/${p.id}/activate`).send({}).expect(422);
    expect(re.body.errors[0].code).toBe('unit_inactive');
    await api(app, admin).post(`/v1/units/${crate.id}/activate`).send({}).expect(200);
    await api(app, admin).post(`/v1/products/${p.id}/activate`).send({}).expect(200);
    await api(app, admin)
      .post(`/v1/products/${p.id}/delete`)
      .send({ reason: 'ทดสอบลบสินค้าทิ้ง' })
      .expect(204);
    const row = await db.product.findUniqueOrThrow({
      where: { id: tryDecodeId('product', p.id)! },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(
      await db.auditLog.count({ where: { entityId: row.id, action: 'product.deleted' } }),
    ).toBe(1);
  });

  it('ค้นหา/กรอง (ทั่วไป/พิเศษ/หน่วย) + cursor + summary', async () => {
    const t = (await createTenant(db)).id;
    await ensureDefaultUnits(db, t);
    const tok = await tokenFor(t);
    const us = Object.fromEntries(
      ((await api(app, tok).get('/v1/units?limit=50').expect(200)).body.data as Unit[]).map((u) => [
        u.code,
        u.id,
      ]),
    );
    const mk = (body: object) =>
      api(app, tok)
        .post('/v1/products')
        .send({ unitId: us.BAG, weightPerUnitKg: 1, ...body })
        .expect(201);
    await mk({ name: 'เม็ดพลาสติก PP' });
    await mk({ name: 'ชิ้นส่วน_ยานยนต์', fragile: true, unitId: us.BOX });
    await mk({ name: 'อาหารแช่แข็ง', tempControlled: true, tempMinC: -20, tempMaxC: -18 });
    await mk({
      name: 'สารเคมี',
      hazardous: true,
      unNumber: '1993',
      hazardClass: '3',
      barcode: '885000',
    });
    const get = (qs: string) => api(app, tok).get(`/v1/products?${qs}`).expect(200);
    expect((await get('special=none')).body.data).toHaveLength(1);
    expect((await get('special=any')).body.data).toHaveLength(3);
    expect((await get('special=temp')).body.data[0].name).toBe('อาหารแช่แข็ง');
    expect((await get(`unitId=${us.BOX}`)).body.data[0].name).toBe('ชิ้นส่วน_ยานยนต์');
    expect((await get('q=885000')).body.data[0].name).toBe('สารเคมี');
    expect((await get('name=p-0001')).body.data[0].name).toBe('เม็ดพลาสติก PP');
    // % / _ ไม่ใช่ wildcard
    expect((await get('q=_')).body.data).toHaveLength(1);
    const p1 = await get('limit=2');
    expect(p1.body.hasMore).toBe(true);
    const p2 = await get(`limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.data.map((x: { code: string }) => x.code)).toEqual(['P-0003', 'P-0004']);
    const s = await api(app, tok).get('/v1/products/summary').expect(200);
    expect(s.body).toEqual({
      total: 4,
      active: 4,
      inactive: 0,
      general: 1,
      special: 3,
      unitsUsed: 2,
    });
    const nc = await api(app, tok).get('/v1/products/next-code').expect(200);
    expect(nc.body.code).toBe('P-0005');
  });

  it('ส่งออก .xlsx / .csv (export:run) + สิทธิ์: master:read อ่านได้แต่แก้ไม่ได้ (403)', async () => {
    await newProduct({ name: '=SUM(A1)' });
    const x = await api(app, admin)
      .get('/v1/products/export?format=xlsx')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const csv = await api(app, admin).get('/v1/products/export?format=csv').expect(200);
    expect(csv.text).toContain('รหัสสินค้า,ชื่อสินค้า,รหัสหน่วย,หน่วย');
    expect(csv.text).toContain("'=SUM(A1)");
    const reader = await tokenFor(tenantId, 'master:read');
    await api(app, reader).get('/v1/products').expect(200);
    await api(app, reader).get('/v1/units').expect(200);
    await api(app, reader)
      .post('/v1/products')
      .send({ name: 'x', unitId: units.BAG!.id, weightPerUnitKg: 1 })
      .expect(403);
    await api(app, reader)
      .post('/v1/units')
      .send({ code: 'X', name: 'x', kind: 'COUNT' })
      .expect(403);
    await api(app, reader).get('/v1/products/export').expect(403);
  });
});
