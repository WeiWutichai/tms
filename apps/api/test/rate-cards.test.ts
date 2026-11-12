import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { RateCardsService } from '../src/modules/rate-cards/rate-cards.service';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/** ST2-T13 Rate card ขาขาย — docs/04 B Rate card + B1, docs/01 §3.2, spec/02 §5 */
describe('rate card ขาขาย (rate-cards)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let seed = 0;
  let vt6: string;
  let vt10: string;
  const today = bangkokToday();
  const d = (n: number) => addDays(today, n);

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ราคาขาย' })).id;
    admin = await tokenFor(tenantId);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body.data;
    vt6 = types.find((t: { code: string }) => t.code === '6W').id;
    vt10 = types.find((t: { code: string }) => t.code === '10W').id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const newSite = async (extra: object = {}) =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุดราคา ${++seed}`, kind: 'DROPOFF', address: ADDR, ...extra })
        .expect(201)
    ).body as { id: string; version: number };
  const newCustomer = async () =>
    (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้าราคา ${++seed}`, taxId: validTaxId(4000 + seed) })
        .expect(201)
    ).body as { id: string; code: string; version: number };
  /** key ใหม่ (ลูกค้า + เส้นทาง) */
  const newKey = async () => {
    const [c, a, b] = [await newCustomer(), await newSite(), await newSite()];
    return { customerId: c.id, originId: a.id, destinationId: b.id, vehicleTypeId: vt6 };
  };
  const create = (body: object, token = admin) => api(app, token).post('/v1/rate-cards').send(body);
  const approve = (id: string, token = admin) =>
    api(app, token).post(`/v1/rate-cards/${id}/approve`).send({ reason: 'อนุมัติตามใบเสนอราคา' });

  it('สร้างร่าง: รหัส RC-S-0001, เงินเป็นสตริง 2 ตำแหน่ง, ค่าขนส่ง (FREIGHT) เป็นรายการบนเอกสาร, ค่าบริการเสริมเฉพาะ', async () => {
    const key = await newKey();
    const items = (await api(app, admin).get('/v1/service-items?limit=50').expect(200)).body.data;
    const wait = items.find((s: { code: string }) => s.code === 'WAIT');
    const r = await create({
      ...key,
      pricingModel: 'PER_TRIP',
      sellRate: '6500',
      sellExtraStopRate: '300.5',
      includedStops: 2,
      validFrom: d(-10),
      validTo: d(355),
      accessorials: [{ serviceItemId: wait.id, sellPrice: '250' }],
      notes: 'สัญญาปี 2569',
    }).expect(201);
    expect(r.body).toMatchObject({
      code: 'RC-S-0001',
      revision: 1,
      side: 'SELL',
      customer: { id: key.customerId },
      origin: { id: key.originId },
      destination: { id: key.destinationId },
      vehicleType: { id: vt6 },
      pricingModel: 'PER_TRIP',
      sellRate: '6500.00',
      sellMinCharge: null,
      sellExtraStopRate: '300.50',
      includedStops: 2,
      serviceItem: { code: 'FREIGHT', vatType: 'EXEMPT_TRANSPORT', whtRate: '1.00' },
      accessorials: [{ serviceItem: { code: 'WAIT' }, sellPrice: '250.00' }],
      validFrom: d(-10),
      validTo: d(355),
      status: 'draft',
      nearExpiry: false,
      version: 1,
    });
    expect(r.body.id).toMatch(/^rcd_[0-9a-f]{32}$/);
    const row = await db.rateCard.findUniqueOrThrow({
      where: { id: tryDecodeId('rateCard', r.body.id)! },
    });
    expect(row.unitPrice.toString()).toBe('6500');
    expect(row.status).toBe('DRAFT');
    // audit + event + ประวัติ
    expect(
      await db.domainEvent.count({ where: { localId: row.id, type: 'rate_card.created' } }),
    ).toBe(1);
    const h = await api(app, admin).get(`/v1/rate-cards/${r.body.id}/history`).expect(200);
    expect(h.body.data[0].action).toBe('rate_card.created');
  });

  it('เกณฑ์ตรวจรับ: สร้าง rate ช่วงเวลาซ้อน key เดิม → 422 overlap (ร่างก็นับ), ต่างประเภทรถ/ช่วงไม่ทับ สร้างได้', async () => {
    const key = await newKey();
    const base = { ...key, pricingModel: 'PER_TRIP', sellRate: '5000' };
    const first = (await create({ ...base, validFrom: d(0), validTo: d(99) }).expect(201)).body;
    const dup = await create({ ...base, validFrom: d(50), validTo: d(150) }).expect(422);
    expect(dup.body.code).toBe('validation_failed');
    expect(dup.body.errors[0]).toMatchObject({ field: 'validFrom', code: 'overlap' });
    expect(dup.body.conflicts).toEqual([
      expect.objectContaining({ id: first.id, code: first.code, status: 'draft' }),
    ]);
    // ไม่มีราคาใน problem (filter เขียน response ตรง ไม่ผ่านตัวตัดราคา)
    expect(JSON.stringify(dup.body)).not.toContain('5000');
    // ไม่มีวันหมด (null) ทับทุกช่วงหลังจากนั้น
    await create({ ...base, validFrom: d(200), validTo: null }).expect(201);
    await create({ ...base, validFrom: d(500), validTo: d(510) }).expect(422);
    // ชนวันเดียว (วันสุดท้าย = วันแรก) ก็นับว่าทับ
    await create({ ...base, validFrom: d(99), validTo: d(120) }).expect(422);
    // วันถัดไป / ต่างประเภทรถ / ทิศกลับ → ได้
    await create({ ...base, validFrom: d(100), validTo: d(199) }).expect(201);
    await create({ ...base, vehicleTypeId: vt10, validFrom: d(0), validTo: d(99) }).expect(201);
    await create({
      ...base,
      originId: key.destinationId,
      destinationId: key.originId,
      validFrom: d(0),
    }).expect(201);
    // แก้ร่างให้ทับ → 422
    const other = (
      await create({ ...base, vehicleTypeId: vt10, validFrom: d(300), validTo: d(310) }).expect(201)
    ).body;
    await api(app, admin)
      .patch(`/v1/rate-cards/${other.id}`)
      .set('If-Match', `"${other.version}"`)
      .send({ validFrom: d(50) })
      .expect(422);
  });

  it('ส่งพร้อมกันหลายคำขอ key + ช่วงเดียวกัน → สำเร็จ 1 ที่เหลือ 422 (advisory lock ต่อ key)', async () => {
    const key = await newKey();
    const body = { ...key, pricingModel: 'PER_TRIP', sellRate: '7000', validFrom: d(1) };
    const res = await Promise.all([create(body), create(body), create(body)]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 422, 422]);
  });

  it('ฐานข้อมูลกันช่วงทับของ rate ที่ใช้งาน (exclusion constraint) แม้เขียนตรงไม่ผ่านแอป', async () => {
    const key = await newKey();
    const r = (
      await create({ ...key, pricingModel: 'PER_TRIP', sellRate: '100', validFrom: d(0) }).expect(
        201,
      )
    ).body;
    await approve(r.id).expect(200);
    const row = await db.rateCard.findUniqueOrThrow({
      where: { id: tryDecodeId('rateCard', r.id)! },
    });
    const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = row;
    await expect(
      db.rateCard.create({ data: { ...copy, code: 'RC-S-9999', validFrom: new Date(d(5)) } }),
    ).rejects.toThrow(/rate_card_no_overlap/);
    // ร่างทับได้ในฐาน (ฉบับแก้ไขทับฉบับเดิมจนกว่าจะอนุมัติ) — แอปตรวจเอง
    await expect(
      db.rateCard.create({
        data: { ...copy, code: 'RC-S-9998', status: 'DRAFT', validFrom: new Date(d(5)) },
      }),
    ).resolves.toBeTruthy();
  });

  it('สถานะ: ร่าง → อนุมัติ (เหตุผล + audit) → มีผล · ร่างแก้ได้ อนุมัติแล้วแก้ตรงไม่ได้ (409) · อนุมัติซ้ำ 409', async () => {
    const key = await newKey();
    const r = (
      await create({
        ...key,
        pricingModel: 'PER_KM',
        sellRate: '18',
        sellMinCharge: '1500',
        validFrom: d(0),
      }).expect(201)
    ).body;
    const p = await api(app, admin)
      .patch(`/v1/rate-cards/${r.id}`)
      .set('If-Match', `"${r.version}"`)
      .send({ sellRate: '19.50' })
      .expect(200);
    expect(p.body).toMatchObject({ sellRate: '19.50', version: 2 });
    // ส่งค่าเดิมซ้ำ = ไม่เพิ่ม version
    const same = await api(app, admin)
      .patch(`/v1/rate-cards/${r.id}`)
      .send({ sellRate: '19.5' })
      .expect(200);
    expect(same.body.version).toBe(2);
    // If-Match เก่า → 412
    await api(app, admin)
      .patch(`/v1/rate-cards/${r.id}`)
      .set('If-Match', `"${r.version}"`)
      .send({ sellRate: '20' })
      .expect(412);
    // อนุมัติต้องมีเหตุผล ≥ 10
    await api(app, admin).post(`/v1/rate-cards/${r.id}/approve`).send({}).expect(422);
    const a = await approve(r.id).expect(200);
    expect(a.body).toMatchObject({ status: 'active', version: 3 });
    expect(a.body.approvedAt).toBeTruthy();
    const hist = await db.docStatusHistory.findFirst({
      where: { docId: tryDecodeId('rateCard', r.id)!, toStatus: 'APPROVED' },
    });
    expect(hist?.note).toBe('อนุมัติตามใบเสนอราคา');
    const audit = await db.auditLog.findFirst({
      where: { entityId: tryDecodeId('rateCard', r.id)!, action: 'rate_card.activated' },
    });
    expect(audit?.reason).toBe('อนุมัติตามใบเสนอราคา');
    const no = await api(app, admin)
      .patch(`/v1/rate-cards/${r.id}`)
      .send({ sellRate: '21' })
      .expect(409);
    expect(no.body.errors[0].code).toBe('not_editable');
    await approve(r.id).expect(409);
    // ลบได้เฉพาะร่าง
    await api(app, admin)
      .post(`/v1/rate-cards/${r.id}/delete`)
      .send({ reason: 'ทดสอบลบ rate ที่อนุมัติ' })
      .expect(409);
  });

  it('อนุมัติตรวจช่วงทับกับ rate ที่ใช้งานอีกครั้ง และข้อมูลที่อ้างต้องยังใช้งาน', async () => {
    const key = await newKey();
    const r = (
      await create({ ...key, pricingModel: 'PER_TRIP', sellRate: '100', validFrom: d(0) }).expect(
        201,
      )
    ).body;
    // ลูกค้าถูกปิดใช้หลังสร้างร่าง → อนุมัติไม่ได้
    const c = (await api(app, admin).get(`/v1/customers/${key.customerId}`).expect(200)).body;
    await api(app, admin)
      .post(`/v1/customers/${key.customerId}/deactivate`)
      .set('If-Match', `"${c.version}"`)
      .send({ reason: 'ทดสอบปิดใช้ลูกค้า' })
      .expect(200);
    const e = await approve(r.id).expect(422);
    expect(e.body.errors[0]).toMatchObject({ field: 'customerId', code: 'customer_inactive' });
  });

  it('ฉบับแก้ไข (MD-118): revise → ร่างฉบับ 2 รหัสเดิม · ฉบับเดิมยังใช้ได้จนอนุมัติ · อนุมัติแล้วฉบับเดิมสิ้นสุดวันก่อนหน้า', async () => {
    const svc = app.get(RateCardsService);
    const dbs = app.get(DbService);
    const key = await newKey();
    const v1 = (
      await create({
        ...key,
        pricingModel: 'PER_TRIP',
        sellRate: '7800',
        validFrom: d(-30),
        validTo: d(330),
      }).expect(201)
    ).body;
    const a1 = (await approve(v1.id).expect(200)).body;
    const v2 = await api(app, admin)
      .post(`/v1/rate-cards/${v1.id}/revise`)
      .set('If-Match', `"${a1.version}"`)
      .send({ sellRate: '8200', validFrom: d(10) })
      .expect(201);
    expect(v2.body).toMatchObject({
      code: v1.code,
      revision: 2,
      parentId: v1.id,
      status: 'draft',
      sellRate: '8200.00',
      validFrom: d(10),
      validTo: d(330),
    });
    // ร่างฉบับแก้ไขค้างอยู่ → revise ซ้ำ 409
    const again = await api(app, admin)
      .post(`/v1/rate-cards/${v1.id}/revise`)
      .send({ sellRate: '8300' })
      .expect(409);
    expect(again.body.errors[0].code).toBe('draft_exists');
    // ฉบับแก้ไขเปลี่ยน key ไม่ได้
    await api(app, admin)
      .patch(`/v1/rate-cards/${v2.body.id}`)
      .send({ vehicleTypeId: vt10 })
      .expect(422);
    const lookup = (date: string) =>
      dbs.withTenant(tenantId, (tx) =>
        svc.findApplicableRate(
          {
            side: 'SELL',
            partyId: tryDecodeId('customer', key.customerId)!,
            originSiteId: tryDecodeId('site', key.originId)!,
            destSiteId: tryDecodeId('site', key.destinationId)!,
            vehicleTypeId: tryDecodeId('vehicleType', vt6)!,
            date,
          },
          tx,
        ),
      );
    expect((await lookup(d(20)))?.unitPrice.toFixed(2)).toBe('7800.00'); // ยังเป็นฉบับเดิม
    await approve(v2.body.id).expect(200);
    const old = (await api(app, admin).get(`/v1/rate-cards/${v1.id}`).expect(200)).body;
    expect(old).toMatchObject({ status: 'active', validTo: d(9) });
    expect((await lookup(d(9)))?.unitPrice.toFixed(2)).toBe('7800.00');
    expect((await lookup(d(10)))?.revision).toBe(2);
    expect((await lookup(d(10)))?.unitPrice.toFixed(2)).toBe('8200.00');
    const sup = await db.auditLog.findFirst({
      where: { entityId: tryDecodeId('rateCard', v1.id)!, action: 'rate_card.superseded' },
    });
    expect(sup?.reason).toContain(`${v1.code} v2`);
    // ฉบับ 3 เริ่มก่อน/เท่าวันเริ่มฉบับ 2 → ฉบับ 2 ถูกแทนทั้งช่วง (ยกเลิก)
    const v3 = (
      await api(app, admin)
        .post(`/v1/rate-cards/${v2.body.id}/revise`)
        .send({ sellRate: '8100', validFrom: d(10) })
        .expect(201)
    ).body;
    expect(v3.revision).toBe(3);
    await approve(v3.id).expect(200);
    const v2After = (await api(app, admin).get(`/v1/rate-cards/${v2.body.id}`).expect(200)).body;
    expect(v2After.status).toBe('retired');
    expect((await lookup(d(15)))?.revision).toBe(3);
  });

  it('เกณฑ์ตรวจรับ: rate หมดอายุ/ร่าง/ยกเลิก ไม่ถูกเลือกใช้ (findApplicableRate) + สถานะ expired คำนวณจากวันที่', async () => {
    const svc = app.get(RateCardsService);
    const dbs = app.get(DbService);
    const key = await newKey();
    const ids = {
      partyId: tryDecodeId('customer', key.customerId)!,
      originSiteId: tryDecodeId('site', key.originId)!,
      destSiteId: tryDecodeId('site', key.destinationId)!,
      vehicleTypeId: tryDecodeId('vehicleType', vt6)!,
    };
    const lookup = (date: string, vehicleTypeId = ids.vehicleTypeId) =>
      dbs.withTenant(tenantId, (tx) =>
        svc.findApplicableRate({ side: 'SELL', ...ids, vehicleTypeId, date }, tx),
      );
    // หมดอายุแล้ว (เมื่อวาน)
    const exp = (
      await create({
        ...key,
        pricingModel: 'PER_TRIP',
        sellRate: '4000',
        validFrom: d(-100),
        validTo: d(-1),
      }).expect(201)
    ).body;
    const ea = (await approve(exp.id).expect(200)).body;
    expect(ea).toMatchObject({ status: 'expired', nearExpiry: false, daysToExpiry: -1 });
    expect(await lookup(today)).toBeNull();
    expect((await lookup(d(-1)))?.id).toBe(tryDecodeId('rateCard', exp.id));
    // ร่างไม่ถูกเลือก
    await create({
      ...key,
      pricingModel: 'PER_TRIP',
      sellRate: '4500',
      validFrom: d(0),
      validTo: d(20),
    }).expect(201);
    expect(await lookup(today)).toBeNull();
    // ใช้งาน + ใกล้หมด 30 วัน
    const act = (
      await create({
        ...key,
        vehicleTypeId: vt10,
        pricingModel: 'PER_TRIP',
        sellRate: '9000',
        validFrom: d(0),
        validTo: d(30),
      }).expect(201)
    ).body;
    const aa = (await approve(act.id).expect(200)).body;
    expect(aa).toMatchObject({ status: 'active', nearExpiry: true, daysToExpiry: 30 });
    const hit = await lookup(today, tryDecodeId('vehicleType', vt10)!);
    expect(hit?.unitPrice.toFixed(2)).toBe('9000.00');
    expect(await lookup(d(31), tryDecodeId('vehicleType', vt10)!)).toBeNull();
    // กรองรายการ / สรุป
    const list = await api(app, admin)
      .get(`/v1/rate-cards?customerId=${key.customerId}&status=expired`)
      .expect(200);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([exp.id]);
    const near = await api(app, admin)
      .get(`/v1/rate-cards?customerId=${key.customerId}&nearExpiry=true`)
      .expect(200);
    expect(near.body.data.map((x: { id: string }) => x.id)).toEqual([act.id]);
    const sum = await api(app, admin)
      .get(`/v1/rate-cards/summary?customerId=${key.customerId}`)
      .expect(200);
    expect(sum.body).toEqual({
      total: 3,
      draft: 1,
      pendingApproval: 0,
      active: 1,
      nearExpiry: 1,
      expired: 1,
      retired: 0,
    });
  });

  it('ยกเลิก: ได้เฉพาะ rate ที่อนุมัติแล้วยังไม่ถึงวันเริ่ม (เหตุผล ≥ 10) · ร่างใช้ลบ', async () => {
    const key = await newKey();
    const base = { ...key, pricingModel: 'PER_TRIP', sellRate: '100' };
    const now = (await create({ ...base, validFrom: d(0), validTo: d(9) }).expect(201)).body;
    await approve(now.id).expect(200);
    const e = await api(app, admin)
      .post(`/v1/rate-cards/${now.id}/cancel`)
      .send({ reason: 'ทดสอบยกเลิก rate' })
      .expect(409);
    expect(e.body.errors[0].code).toBe('in_effect');
    const fut = (await create({ ...base, validFrom: d(10) }).expect(201)).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${fut.id}/cancel`)
      .send({ reason: 'ทดสอบยกเลิก rate' })
      .expect(409); // ร่าง → ใช้ลบ
    await approve(fut.id).expect(200);
    await api(app, admin)
      .post(`/v1/rate-cards/${fut.id}/cancel`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const c = await api(app, admin)
      .post(`/v1/rate-cards/${fut.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกสัญญาก่อนเริ่ม' })
      .expect(200);
    expect(c.body.status).toBe('retired');
    // ยกเลิกแล้วช่วงนั้นว่าง สร้างใหม่ได้
    await create({ ...base, validFrom: d(20) }).expect(201);
    // ลบร่าง (soft) → 404, ประวัติยังอยู่ในฐาน
    const dr = (await create({ ...base, vehicleTypeId: vt10, validFrom: d(0) }).expect(201)).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${dr.id}/delete`)
      .send({ reason: 'สร้างผิดลูกค้า ลบทิ้ง' })
      .expect(204);
    await api(app, admin).get(`/v1/rate-cards/${dr.id}`).expect(404);
    expect(
      await db.rateCard.count({
        where: { id: tryDecodeId('rateCard', dr.id)!, deletedAt: { not: null } },
      }),
    ).toBe(1);
  });

  it('validation: เงินติดลบ/float/ทศนิยมเกิน, วันที่ผิด, ถึง < ตั้งแต่, PER_UNIT ต้องมีหน่วยนับ, เหมาวัน (P1), ต้นทาง = ปลายทาง, อ้างข้ามบริษัท → 422', async () => {
    const key = await newKey();
    const ok = { ...key, pricingModel: 'PER_TRIP', sellRate: '100', validFrom: d(0) };
    const v = async (body: object, field: string, code?: string) => {
      const r = await create({ ...ok, ...body }).expect(422);
      expect(r.body.errors.map((e: { field: string }) => e.field)).toContain(field);
      if (code)
        expect(r.body.errors.find((e: { field: string }) => e.field === field).code).toBe(code);
    };
    await v({ sellRate: '-1' }, 'sellRate');
    await v({ sellRate: 100.5 }, 'sellRate');
    await v({ sellRate: '1.234' }, 'sellRate');
    await v({ sellMinCharge: '1e3' }, 'sellMinCharge');
    await v({ sellRate: null }, 'sellRate');
    await v({ validFrom: '2026-02-30' }, 'validFrom', 'invalid_date');
    await v({ validFrom: '0026-01-01' }, 'validFrom', 'invalid_date');
    await v({ validTo: d(-1) }, 'validTo', 'before_start');
    await v({ pricingModel: 'PER_DAY' }, 'pricingModel');
    await v({ pricingModel: 'PER_UNIT' }, 'unitId', 'required');
    await v({ destinationId: key.originId }, 'destinationId', 'same_site');
    await v({ includedStops: 100 }, 'includedStops');
    await v({ customerId: undefined }, 'customerId', 'required');
    const units = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data;
    const ton = units.find((u: { kind: string }) => u.kind === 'WEIGHT');
    const pcs = units.find((u: { kind: string }) => u.kind === 'COUNT');
    await v({ pricingModel: 'PER_UNIT', unitId: ton.id }, 'unitId', 'unit_kind');
    await v({ unitId: pcs.id }, 'unitId', 'not_applicable');
    const u = await create({ ...ok, pricingModel: 'PER_UNIT', unitId: pcs.id }).expect(201);
    expect(u.body.unit).toMatchObject({ id: pcs.id });
    // ค่าขนส่งเป็น % / ค่าจุดเพิ่ม ใช้เป็นค่าบริการเสริมเฉพาะไม่ได้, ซ้ำไม่ได้
    const items = (await api(app, admin).get('/v1/service-items?limit=50').expect(200)).body.data;
    const by = (c: string) => items.find((s: { code: string }) => s.code === c).id;
    await v(
      { vehicleTypeId: vt10, accessorials: [{ serviceItemId: by('FSC'), sellPrice: '5' }] },
      'accessorials.0.serviceItemId',
      'not_applicable',
    );
    await v(
      { vehicleTypeId: vt10, accessorials: [{ serviceItemId: by('FREIGHT'), sellPrice: '5' }] },
      'accessorials.0.serviceItemId',
      'not_applicable',
    );
    await v(
      {
        vehicleTypeId: vt10,
        accessorials: [
          { serviceItemId: by('WAIT'), sellPrice: '5' },
          { serviceItemId: by('WAIT'), sellPrice: '6' },
        ],
      },
      'accessorials.1.serviceItemId',
      'duplicate',
    );
    // ข้าม tenant
    const other = await createTenantWithDefaults(db, { name: 'บริษัทอื่น' });
    const otherSite = await db.customerSite.create({
      data: { tenantId: other.id, code: 'X-1', name: 'x', address: { line1: 'x' } },
    });
    await v(
      { originId: `loc_${otherSite.id.replace(/-/g, '')}`, vehicleTypeId: vt10 },
      'originId',
      'reference_not_found',
    );
  });

  it('สิทธิ์ราคา: ไม่มี prices.sell:read ไม่เห็นราคา (รายการ/ประวัติ/ไฟล์ส่งออก) · ไม่มี prices.sell:write สร้าง/อนุมัติไม่ได้', async () => {
    const key = await newKey();
    const r = (
      await create({ ...key, pricingModel: 'PER_TRIP', sellRate: '12345', validFrom: d(0) }).expect(
        201,
      )
    ).body;
    await api(app, admin).patch(`/v1/rate-cards/${r.id}`).send({ sellRate: '12346' }).expect(200);
    const planner = await tokenFor(tenantId, 'master:read master:write export:run prices.buy:read');
    const g = await api(app, planner).get(`/v1/rate-cards/${r.id}`).expect(200);
    expect(g.body.sellRate).toBeUndefined();
    expect(g.body.code).toBe(r.code);
    const h = await api(app, planner).get(`/v1/rate-cards/${r.id}/history`).expect(200);
    expect(JSON.stringify(h.body)).not.toContain('1234');
    const csv = await api(app, planner)
      .get(`/v1/rate-cards/export?format=csv&ids=${r.id}`)
      .expect(200);
    expect(csv.text).toContain(r.code);
    expect(csv.text).not.toContain('12346');
    const full = await api(app, admin)
      .get(`/v1/rate-cards/export?format=csv&ids=${r.id}`)
      .expect(200);
    expect(full.text).toContain('12346.00');
    await create(
      { ...key, vehicleTypeId: vt10, pricingModel: 'PER_TRIP', sellRate: '1', validFrom: d(0) },
      planner,
    ).expect(403);
    await approve(r.id, planner).expect(403);
    // invoicer: แก้ราคาขายได้ (A3)
    const invoicer = await tokenFor(tenantId, 'master:read prices.sell:read prices.sell:write');
    await approve(r.id, invoicer).expect(200);
  });

  it('PUT external: สร้างร่าง / ส่งซ้ำแก้ร่างเดิม / อนุมัติแล้ว 409 · เรียกด้วย ext:', async () => {
    const key = await newKey();
    const body = { ...key, pricingModel: 'PER_TON', sellRate: '350', validFrom: d(0) };
    const a = await api(app, admin).put('/v1/rate-cards/external/ERP-RC-1').send(body).expect(201);
    const b = await api(app, admin)
      .put('/v1/rate-cards/external/ERP-RC-1')
      .send({ ...body, sellRate: '360' })
      .expect(200);
    expect(b.body).toMatchObject({ id: a.body.id, sellRate: '360.00', externalId: 'ERP-RC-1' });
    await api(app, admin).get('/v1/rate-cards/ext:ERP-RC-1').expect(200);
    await approve(a.body.id).expect(200);
    await api(app, admin)
      .put('/v1/rate-cards/external/ERP-RC-1')
      .send({ ...body, sellRate: '370' })
      .expect(409);
  });

  it('ลบข้อมูลหลักที่ rate card อ้างไม่ได้ (409 in_use)', async () => {
    const key = await newKey();
    await create({ ...key, pricingModel: 'PER_TRIP', sellRate: '100', validFrom: d(0) }).expect(
      201,
    );
    const site = (await api(app, admin).get(`/v1/customer-sites/${key.originId}`).expect(200)).body;
    const e = await api(app, admin)
      .post(`/v1/customer-sites/${key.originId}/delete`)
      .set('If-Match', `"${site.version}"`)
      .send({ reason: 'ทดสอบลบสถานที่' })
      .expect(409);
    expect(e.body.references.rateCards).toBe(1);
  });
});
