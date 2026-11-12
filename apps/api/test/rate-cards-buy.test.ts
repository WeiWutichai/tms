import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { RateCardsService } from '../src/modules/rate-cards/rate-cards.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/** เลขนิติบุคคล (checksum ถูก) — ข้อมูลสมมติ */
function jurTax(n: number): string {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

/**
 * ST2-T14 Rate card ขาซื้อ (ต่อรถร่วม) + "ราคา 5 ครั้งล่าสุดที่จ้างรายนี้"
 * docs/04 B Rate card ขาซื้อ · เกณฑ์ตรวจรับ: ใช้ตัวตรวจชุดเดียวกับขาขาย (side = BUY); endpoint คืนรายการว่างเมื่อยังไม่เคยจ้าง
 */
describe('rate card ขาซื้อ (side = BUY) + ราคา 5 ครั้งล่าสุด', () => {
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ราคาซื้อ' })).id;
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
        .send({ name: `จุดซื้อ ${++seed}`, kind: 'DROPOFF', address: ADDR, ...extra })
        .expect(201)
    ).body as { id: string; name: string; code: string };
  const newCarrier = async () =>
    (
      await api(app, admin)
        .post('/v1/carriers')
        .send({
          legalName: `หจก. รถร่วมทดสอบ ${++seed}`,
          entityType: 'JURISTIC',
          taxId: jurTax(20_000 + seed),
        })
        .expect(201)
    ).body as { id: string; code: string; legalName: string; version: number };
  const newKey = async () => {
    const [c, a, b] = [await newCarrier(), await newSite(), await newSite()];
    return { carrierId: c.id, originId: a.id, destinationId: b.id, vehicleTypeId: vt6 };
  };
  const create = (body: object, token = admin) =>
    api(app, token)
      .post('/v1/rate-cards')
      .send({ side: 'BUY', ...body });
  const approve = (id: string, token = admin) =>
    api(app, token).post(`/v1/rate-cards/${id}/approve`).send({ reason: 'อนุมัติตามราคาที่ตกลง' });

  it('สร้างร่างขาซื้อ: รหัส RC-B-0001, ผู้รับเหมา, ราคา buy* (ไม่มี sell*), สถานที่ของลูกค้าใดก็ได้, อนุมัติแล้ว findApplicableRate(BUY) เจอ', async () => {
    const cus = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: 'ลูกค้าของจุดส่ง', taxId: validTaxId(7001) })
        .expect(201)
    ).body;
    const custSite = await newSite({ customerId: cus.id });
    const key = { ...(await newKey()), destinationId: custSite.id };
    const items = (await api(app, admin).get('/v1/service-items?limit=50').expect(200)).body.data;
    const wait = items.find((s: { code: string }) => s.code === 'WAIT');
    const r = await create({
      ...key,
      pricingModel: 'PER_TRIP',
      buyRate: '5200',
      buyMinCharge: '1000',
      buyExtraStopRate: '250',
      validFrom: d(-5),
      accessorials: [{ serviceItemId: wait.id, buyPrice: '180' }],
    }).expect(201);
    expect(r.body).toMatchObject({
      code: 'RC-B-0001',
      side: 'BUY',
      customer: null,
      carrier: { id: key.carrierId },
      buyRate: '5200.00',
      buyMinCharge: '1000.00',
      buyExtraStopRate: '250.00',
      accessorials: [{ serviceItem: { code: 'WAIT' }, buyPrice: '180.00' }],
      serviceItem: { code: 'FREIGHT' },
      status: 'draft',
    });
    expect(JSON.stringify(r.body)).not.toMatch(/sell/);
    await approve(r.body.id).expect(200);
    // ขาขายเลขแยก (RC-S-0001 ยังว่าง)
    const svc = app.get(RateCardsService);
    const dbs = app.get(DbService);
    const lookup = {
      partyId: tryDecodeId('carrier', key.carrierId)!,
      originSiteId: tryDecodeId('site', key.originId)!,
      destSiteId: tryDecodeId('site', key.destinationId)!,
      vehicleTypeId: tryDecodeId('vehicleType', vt6)!,
      date: today,
    };
    const hit = await dbs.withTenant(tenantId, (tx) =>
      svc.findApplicableRate({ side: 'BUY', ...lookup }, tx),
    );
    expect(hit).toMatchObject({ code: 'RC-B-0001', side: 'BUY', includedStops: 2 });
    expect(hit!.unitPrice.toFixed(2)).toBe('5200.00');
    expect(hit!.accessorials[0]!.price.toFixed(2)).toBe('180.00');
    // ฝั่งขาย + id เดียวกัน → ไม่เจอ · ก่อนวันเริ่ม → ไม่เจอ
    expect(
      await dbs.withTenant(tenantId, (tx) =>
        svc.findApplicableRate({ side: 'SELL', ...lookup }, tx),
      ),
    ).toBeNull();
    expect(
      await dbs.withTenant(tenantId, (tx) =>
        svc.findApplicableRate({ side: 'BUY', ...lookup, date: d(-6) }, tx),
      ),
    ).toBeNull();
    // รายการ/สรุปแยกฝั่ง + กรองผู้รับเหมา (ชื่อ/รหัส)
    const list = await api(app, admin)
      .get(`/v1/rate-cards?side=BUY&carrierId=${key.carrierId}`)
      .expect(200);
    expect(list.body.data.map((x: { code: string }) => x.code)).toEqual(['RC-B-0001']);
    const carrier = (await api(app, admin).get(`/v1/carriers/${key.carrierId}`).expect(200)).body;
    const byName = await api(app, admin)
      .get(`/v1/rate-cards?side=BUY&party=${encodeURIComponent(carrier.legalName)}`)
      .expect(200);
    expect(byName.body.data).toHaveLength(1);
    expect((await api(app, admin).get('/v1/rate-cards?side=SELL').expect(200)).body.data).toEqual(
      [],
    );
    const sum = await api(app, admin)
      .get(`/v1/rate-cards/summary?side=BUY&carrierId=${key.carrierId}`)
      .expect(200);
    expect(sum.body).toMatchObject({ total: 1, active: 1 });
  });

  it('ตัวตรวจชุดเดียวกับขาขาย: ช่วงวันทับ key เดิม → 422 overlap · ขาขายเส้นทางเดียวกันไม่ชน · ฉบับแก้ไขขาซื้อ', async () => {
    const key = await newKey();
    const base = { ...key, pricingModel: 'PER_TRIP', buyRate: '4000' };
    const first = (await create({ ...base, validFrom: d(0), validTo: d(99) }).expect(201)).body;
    const dup = await create({ ...base, validFrom: d(50) }).expect(422);
    expect(dup.body.errors[0]).toMatchObject({ field: 'validFrom', code: 'overlap' });
    expect(dup.body.conflicts[0]).toMatchObject({ id: first.id });
    expect(JSON.stringify(dup.body)).not.toContain('4000');
    // รถร่วมอีกราย/ประเภทรถอื่น → ได้
    const other = await newCarrier();
    await create({ ...base, carrierId: other.id, validFrom: d(0) }).expect(201);
    await create({ ...base, vehicleTypeId: vt10, validFrom: d(0) }).expect(201);
    // ขาขาย key เดียวกัน (ลูกค้า + เส้นทางเดียวกัน) ไม่ชนกับขาซื้อ
    const cus = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: 'ลูกค้าขาขายคู่', taxId: validTaxId(7002) })
        .expect(201)
    ).body;
    await api(app, admin)
      .post('/v1/rate-cards')
      .send({
        customerId: cus.id,
        originId: key.originId,
        destinationId: key.destinationId,
        vehicleTypeId: vt6,
        pricingModel: 'PER_TRIP',
        sellRate: '6000',
        validFrom: d(0),
      })
      .expect(201);
    // อนุมัติ → ฉบับแก้ไข (ผู้รับเหมาล็อก) → อนุมัติ → ฉบับเดิมสิ้นสุดวันก่อนหน้า
    await approve(first.id).expect(200);
    const g = await api(app, admin).get(`/v1/rate-cards/${first.id}`).expect(200);
    const rev = await api(app, admin)
      .post(`/v1/rate-cards/${first.id}/revise`)
      .set('If-Match', `"${g.body.version}"`)
      .send({ buyRate: '4200', validFrom: d(10) })
      .expect(201);
    expect(rev.body).toMatchObject({ code: first.code, revision: 2, buyRate: '4200.00' });
    await api(app, admin)
      .patch(`/v1/rate-cards/${rev.body.id}`)
      .send({ carrierId: other.id })
      .expect(422)
      .expect((res) => expect(res.body.errors[0].code).toBe('key_locked'));
    await approve(rev.body.id).expect(200);
    const parent = await api(app, admin).get(`/v1/rate-cards/${first.id}`).expect(200);
    expect(parent.body.validTo).toBe(d(9));
  });

  it('ฟิลด์ผิดฝั่ง/ขาดผู้รับเหมา → 422 · รถร่วมระงับชั่วคราว → 422 carrier_inactive · ฝั่งเปลี่ยนผ่าน PUT external ไม่ได้', async () => {
    const key = await newKey();
    const ok = { ...key, pricingModel: 'PER_TRIP', buyRate: '100', validFrom: d(0) };
    const v = async (body: object, field: string, code: string) => {
      const r = await create(body).expect(422);
      expect(r.body.errors[0]).toMatchObject({ field, code });
    };
    await v({ ...ok, sellRate: '1' }, 'sellRate', 'wrong_side');
    const cus = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: 'ลูกค้าผิดฝั่ง', taxId: validTaxId(7003) })
        .expect(201)
    ).body;
    await v({ ...ok, customerId: cus.id }, 'customerId', 'wrong_side');
    await v({ ...ok, carrierId: undefined }, 'carrierId', 'required');
    await v({ ...ok, buyRate: undefined }, 'buyRate', 'required');
    const items = (await api(app, admin).get('/v1/service-items?limit=50').expect(200)).body.data;
    const wait = items.find((s: { code: string }) => s.code === 'WAIT');
    await v(
      { ...ok, accessorials: [{ serviceItemId: wait.id, sellPrice: '1' }] },
      'accessorials.0.sellPrice',
      'wrong_side',
    );
    await v(
      { ...ok, accessorials: [{ serviceItemId: wait.id }] },
      'accessorials.0.buyPrice',
      'required',
    );
    // ขาขายส่งผู้รับเหมา/ราคาซื้อ → 422
    const sellKey = {
      customerId: cus.id,
      originId: key.originId,
      destinationId: key.destinationId,
      vehicleTypeId: vt6,
      pricingModel: 'PER_TRIP',
      sellRate: '1',
      validFrom: d(0),
    };
    const s1 = await api(app, admin)
      .post('/v1/rate-cards')
      .send({ ...sellKey, buyRate: '1' })
      .expect(422);
    expect(s1.body.errors[0]).toMatchObject({ field: 'buyRate', code: 'wrong_side' });
    const s2 = await api(app, admin)
      .post('/v1/rate-cards')
      .send({ ...sellKey, carrierId: key.carrierId })
      .expect(422);
    expect(s2.body.errors[0]).toMatchObject({ field: 'carrierId', code: 'wrong_side' });
    // ค่าบริการเสริมฝั่งขายอย่างเดียวใช้กับขาซื้อไม่ได้
    const sellOnly = (
      await api(app, admin)
        .post('/v1/service-items')
        .send({
          name: 'ค่าบริการขายอย่างเดียว',
          calcUnit: 'PER_TRIP',
          vatType: 'VAT_7',
          whtRate: '3.00',
          side: 'SELL',
          defaultPrice: '100.00',
        })
        .expect(201)
    ).body;
    await v(
      { ...ok, accessorials: [{ serviceItemId: sellOnly.id, buyPrice: '1' }] },
      'accessorials.0.serviceItemId',
      'wrong_side',
    );
    // รถร่วมระงับชั่วคราว
    const c = (await api(app, admin).get(`/v1/carriers/${key.carrierId}`).expect(200)).body;
    await api(app, admin)
      .post(`/v1/carriers/${key.carrierId}/deactivate`)
      .set('If-Match', `"${c.version}"`)
      .send({ reason: 'ระงับเพื่อทดสอบ rate card' })
      .expect(200);
    await v(ok, 'carrierId', 'carrier_inactive');
    // PUT external: สร้างขาซื้อ แล้วส่งฝั่งขายมาที่ externalId เดิม → 422 side_locked
    const k2 = await newKey();
    const ext = { ...k2, side: 'BUY', pricingModel: 'PER_KM', buyRate: '18', validFrom: d(0) };
    const a = await api(app, admin).put('/v1/rate-cards/external/ERP-RB-1').send(ext).expect(201);
    expect(a.body).toMatchObject({ side: 'BUY', code: expect.stringMatching(/^RC-B-/) });
    await api(app, admin)
      .put('/v1/rate-cards/external/ERP-RB-1')
      .send({ ...ext, buyRate: '19' })
      .expect(200)
      .expect((res) => expect(res.body.buyRate).toBe('19.00'));
    const sl = await api(app, admin)
      .put('/v1/rate-cards/external/ERP-RB-1')
      .send({ side: 'SELL' })
      .expect(422);
    expect(sl.body.errors[0].code).toBe('side_locked');
  });

  it('สิทธิ์แยกฝั่ง: ผู้มีสิทธิ์ขาขายอย่างเดียวไม่เห็น/แก้ราคาซื้อ และกลับกัน (response/ประวัติ/ไฟล์ส่งออก)', async () => {
    const key = await newKey();
    const buy = (
      await create({ ...key, pricingModel: 'PER_TRIP', buyRate: '7777', validFrom: d(0) }).expect(
        201,
      )
    ).body;
    const cus = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: 'ลูกค้าสิทธิ์', taxId: validTaxId(7004) })
        .expect(201)
    ).body;
    const sellBody = {
      customerId: cus.id,
      originId: key.originId,
      destinationId: key.destinationId,
      vehicleTypeId: vt6,
      pricingModel: 'PER_TRIP',
      sellRate: '8888',
      validFrom: d(0),
    };
    const sell = (await api(app, admin).post('/v1/rate-cards').send(sellBody).expect(201)).body;
    const sellOnly = await tokenFor(
      tenantId,
      'master:read export:run prices.sell:read prices.sell:write',
    );
    const buyOnly = await tokenFor(
      tenantId,
      'master:read export:run prices.buy:read prices.buy:write',
    );
    // ขาขายอย่างเดียว: เห็น rate ขาซื้อแต่ไม่เห็นราคา · ประวัติ/ไฟล์ส่งออกไม่มีราคา · สร้าง/แก้/อนุมัติขาซื้อไม่ได้
    const g = await api(app, sellOnly).get(`/v1/rate-cards/${buy.id}`).expect(200);
    expect(g.body.buyRate).toBeUndefined();
    expect(g.body.code).toBe(buy.code);
    const h = await api(app, sellOnly).get(`/v1/rate-cards/${buy.id}/history`).expect(200);
    expect(JSON.stringify(h.body)).not.toContain('7777');
    const csv = await api(app, sellOnly)
      .get(`/v1/rate-cards/export?format=csv&side=BUY&ids=${buy.id}`)
      .expect(200);
    expect(csv.text).toContain(buy.code);
    expect(csv.text).toContain('ผู้รับเหมา');
    expect(csv.text).not.toContain('7777');
    const full = await api(app, buyOnly)
      .get(`/v1/rate-cards/export?format=csv&side=BUY&ids=${buy.id}`)
      .expect(200);
    expect(full.text).toContain('7777.00');
    await create(
      { ...key, vehicleTypeId: vt10, pricingModel: 'PER_TRIP', validFrom: d(0) },
      sellOnly,
    ).expect(403);
    await api(app, sellOnly)
      .patch(`/v1/rate-cards/${buy.id}`)
      .send({ notes: 'แก้หมายเหตุ' })
      .expect(403);
    await approve(buy.id, sellOnly).expect(403);
    // ส่งราคาซื้อโดยไม่มี prices.buy:write → 403 ที่ interceptor
    const deny = await api(app, sellOnly)
      .patch(`/v1/rate-cards/${buy.id}`)
      .send({ buyRate: '1' })
      .expect(403);
    expect(deny.body.required).toEqual(['prices.buy:write']);
    // ขาซื้ออย่างเดียว: ไม่เห็นราคาขาย แก้/อนุมัติขาขายไม่ได้ · แก้/อนุมัติขาซื้อได้
    const gs = await api(app, buyOnly).get(`/v1/rate-cards/${sell.id}`).expect(200);
    expect(gs.body.sellRate).toBeUndefined();
    await approve(sell.id, buyOnly).expect(403);
    await api(app, buyOnly)
      .post('/v1/rate-cards')
      .send({ ...sellBody, sellRate: undefined, vehicleTypeId: vt10 })
      .expect(403);
    const gb = await api(app, buyOnly).get(`/v1/rate-cards/${buy.id}`).expect(200);
    expect(gb.body.buyRate).toBe('7777.00');
    await api(app, buyOnly)
      .patch(`/v1/rate-cards/${buy.id}`)
      .set('If-Match', `"${gb.body.version}"`)
      .send({ buyRate: '7700' })
      .expect(200);
    await approve(buy.id, buyOnly).expect(200);
    // viewer (master:read อย่างเดียว) — ไม่เห็นราคาทั้งสองฝั่ง
    const viewer = await tokenFor(tenantId, 'master:read');
    const lv = await api(app, viewer).get('/v1/rate-cards?side=BUY').expect(200);
    expect(JSON.stringify(lv.body)).not.toMatch(/buyRate|7700/);
  });

  it('สิทธิ์แยกฝั่ง (review): revise/cancel/delete/PUT external ของอีกฝั่ง → 403 ทั้งสองทาง', async () => {
    const key = await newKey();
    const cus = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: 'ลูกค้าสิทธิ์ข้ามฝั่ง', taxId: validTaxId(7005) })
        .expect(201)
    ).body;
    const sellKey = {
      customerId: cus.id,
      originId: key.originId,
      destinationId: key.destinationId,
      vehicleTypeId: vt6,
      pricingModel: 'PER_TRIP',
    };
    const mk = async (side: 'SELL' | 'BUY', ext: string) => {
      const body =
        side === 'BUY'
          ? { side, ...key, pricingModel: 'PER_TRIP', buyRate: '100' }
          : { side, ...sellKey, sellRate: '100' };
      // อนุมัติแล้วยังไม่ถึงวันเริ่ม (ยกเลิก/ออกฉบับแก้ไขได้) + ร่าง (ลบได้) + externalId สำหรับ PUT
      const approved = (await create({ ...body, validFrom: d(10), validTo: d(20) }).expect(201))
        .body;
      await approve(approved.id).expect(200);
      const draft = (await create({ ...body, validFrom: d(30), validTo: d(40) }).expect(201)).body;
      await api(app, admin)
        .put(`/v1/rate-cards/external/${ext}`)
        .send({ ...body, validFrom: d(50), validTo: d(60) })
        .expect(201);
      return { approved, draft, ext };
    };
    const buy = await mk('BUY', 'X-SIDE-B');
    const sell = await mk('SELL', 'X-SIDE-S');
    const sellOnly = await tokenFor(tenantId, 'master:read prices.sell:read prices.sell:write');
    const buyOnly = await tokenFor(tenantId, 'master:read prices.buy:read prices.buy:write');
    const reason = { reason: 'ทดสอบสิทธิ์ข้ามฝั่ง' };
    for (const [token, r, scope] of [
      [sellOnly, buy, 'prices.buy:write'],
      [buyOnly, sell, 'prices.sell:write'],
    ] as const) {
      const http = api(app, token);
      const checks = [
        await http.post(`/v1/rate-cards/${r.approved.id}/revise`).send({ notes: 'แก้หมายเหตุ' }),
        await http.post(`/v1/rate-cards/${r.approved.id}/cancel`).send(reason),
        await http.post(`/v1/rate-cards/${r.draft.id}/delete`).send(reason),
        await http.post(`/v1/rate-cards/${r.draft.id}/approve`).send(reason),
        await http.put(`/v1/rate-cards/external/${r.ext}`).send({ notes: 'แก้หมายเหตุ' }),
      ];
      for (const res of checks) {
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.required).toEqual([scope]);
      }
    }
    // PUT external สร้างใหม่ฝั่งที่ไม่มีสิทธิ์ → 403
    await api(app, buyOnly)
      .put('/v1/rate-cards/external/X-SIDE-NEW')
      .send({ ...sellKey, vehicleTypeId: vt10, validFrom: d(0) })
      .expect(403);
    // สถานะไม่เปลี่ยน
    const g = await api(app, admin).get(`/v1/rate-cards/${buy.approved.id}`).expect(200);
    expect(g.body.status).toBe('active');
  });

  it('ลบผู้รับเหมาที่ rate อ้าง → 409 in_use · ข้าม tenant → 404', async () => {
    const key = await newKey();
    const r = (
      await create({ ...key, pricingModel: 'PER_TRIP', buyRate: '100', validFrom: d(0) }).expect(
        201,
      )
    ).body;
    const del = await api(app, admin)
      .post(`/v1/carriers/${key.carrierId}/delete`)
      .send({ reason: 'ทดสอบลบผู้รับเหมาที่มี rate' })
      .expect(409);
    expect(del.body.references).toMatchObject({ rateCards: 1 });
    // ร่างที่ลบแล้วยังนับ (ประวัติอ้างถึง — MD-004)
    await api(app, admin)
      .post(`/v1/rate-cards/${r.id}/delete`)
      .send({ reason: 'ลบร่างเพื่อทดสอบ' })
      .expect(204);
    await api(app, admin)
      .post(`/v1/carriers/${key.carrierId}/delete`)
      .send({ reason: 'ทดสอบลบผู้รับเหมาที่มี rate' })
      .expect(409);
    const other = await createTenantWithDefaults(db, { name: 'บริษัทอื่น ขาซื้อ' });
    const otherToken = await tokenFor(other.id);
    await api(app, otherToken).get(`/v1/rate-cards/${r.id}`).expect(404);
    await api(app, otherToken).get(`/v1/carriers/${key.carrierId}/recent-prices`).expect(404);
    // ใช้รถร่วมของ tenant อื่นเป็นคู่สัญญา → 422 reference_not_found
    const k2 = await newKey();
    const bad = await api(app, otherToken)
      .post('/v1/rate-cards')
      .send({ side: 'BUY', ...k2, pricingModel: 'PER_TRIP', buyRate: '1', validFrom: d(0) })
      .expect(422);
    expect(bad.body.errors[0].code).toBe('reference_not_found');
  });

  it('ราคา 5 ครั้งล่าสุด: ยังไม่เคยจ้าง = [] · มีเที่ยว = ใหม่สุด 5 เที่ยว รวม CARRIER_FEE ต่อเที่ยว ไม่นับเที่ยวยกเลิก/รถร่วมอื่น · กรองเส้นทาง/ประเภทรถ · ต้องมี prices.buy:read', async () => {
    const c = await newCarrier();
    const empty = await api(app, admin).get(`/v1/carriers/${c.id}/recent-prices`).expect(200);
    expect(empty.body).toEqual({ data: [] });
    const cid = tryDecodeId('carrier', c.id)!;
    const [a, b, x] = [await newSite(), await newSite(), await newSite()];
    const vehType = (id: string) => tryDecodeId('vehicleType', id)!;
    const veh = async (vtId: string) =>
      db.vehicle.create({
        data: {
          tenantId,
          plate: `70-${++seed}`,
          plateProvince: 'TH-10',
          plateKey: `70${seed}|TH-10`,
          plateNorm: `70${seed}`,
          vehicleTypeId: vehType(vtId),
          ownership: 'SUBCONTRACT',
          carrierId: cid,
        },
      });
    const v6 = await veh(vt6);
    const v10 = await veh(vt10);
    let n = 0;
    const trip = async (opts: {
      day: number;
      fees: string[];
      to?: string;
      vehicleId?: string;
      status?: 'COMPLETED' | 'CANCELLED' | 'OFFERED' | 'ASSIGNED' | 'PLANNING';
      assignmentStatus?: 'OFFERED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
      carrierId?: string;
      /** carrier_id ของบรรทัดค่าจ้าง (ค่าเริ่มต้น = รถร่วมของเที่ยว) ต่อบรรทัด */
      feeCarrierIds?: (string | null)[];
      rateCardCode?: string;
    }) => {
      const t = await db.trip.create({
        data: {
          tenantId,
          tripNo: `TRP-T14-${++n}`,
          tripDate: new Date(`${d(opts.day)}T00:00:00Z`),
          carrierId: opts.carrierId ?? cid,
          carrierNameSnapshot: c.legalName,
          vehicleId: opts.vehicleId ?? v6.id,
          vehicleTypeSnapshot: opts.vehicleId === v10.id ? '10 ล้อ' : '6 ล้อ',
          status: opts.status ?? 'COMPLETED',
          ...(opts.assignmentStatus ? { assignmentStatus: opts.assignmentStatus } : {}),
          ...(opts.rateCardCode ? { buyRateSnapshot: { rateCardCode: opts.rateCardCode } } : {}),
        },
      });
      const stops = [tryDecodeId('site', a.id)!, tryDecodeId('site', opts.to ?? b.id)!];
      for (const [i, siteId] of stops.entries())
        await db.tripStop.create({
          data: {
            tenantId,
            tripId: t.id,
            sequence: i + 1,
            type: i ? 'DELIVERY' : 'PICKUP',
            siteId,
          },
        });
      for (const [i, amount] of opts.fees.entries())
        await db.tripCost.create({
          data: {
            tenantId,
            tripId: t.id,
            costType: 'CARRIER_FEE',
            amount,
            source: 'RATE_CARD',
            carrierId:
              opts.feeCarrierIds?.[i] !== undefined
                ? opts.feeCarrierIds[i]
                : (opts.carrierId ?? cid),
          },
        });
      // ค่าใช้จ่ายอื่นของเที่ยวไม่นับ
      await db.tripCost.create({
        data: { tenantId, tripId: t.id, costType: 'TOLL', amount: '999', source: 'MANUAL' },
      });
      return t;
    };
    await trip({ day: -10, fees: ['5000'] });
    await trip({ day: -9, fees: ['5100'] });
    await trip({ day: -8, fees: ['5000', '300.50'], rateCardCode: 'RC-B-0009' });
    await trip({ day: -7, fees: ['5200'], to: x.id });
    await trip({ day: -6, fees: ['6100'], vehicleId: v10.id });
    await trip({ day: -5, fees: ['5300'] });
    // ไม่นับ (review ST2-T14 — กฎ "จ้างแล้ว"): ยกเลิก · ข้อเสนอที่ยังรอ/ปฏิเสธ/หมดเวลา · ยังไม่จ่ายงาน · วันเที่ยวในอนาคต
    await trip({ day: -4, fees: ['9999'], status: 'CANCELLED' });
    await trip({ day: -3, fees: ['9001'], status: 'OFFERED', assignmentStatus: 'OFFERED' });
    await trip({ day: -3, fees: ['9002'], status: 'ASSIGNED', assignmentStatus: 'REJECTED' });
    await trip({ day: -3, fees: ['9003'], status: 'ASSIGNED', assignmentStatus: 'EXPIRED' });
    await trip({ day: -3, fees: ['9004'], status: 'PLANNING' });
    await trip({ day: 2, fees: ['9005'], status: 'ASSIGNED', assignmentStatus: 'ACCEPTED' });
    // ข้อเสนอเดิมให้รายนี้ถูกปฏิเสธแล้วเที่ยวไปรายอื่น: บรรทัดค่าจ้างที่ผูกรายนี้ไม่นับทั้งกับรายนี้และรายใหม่
    const other = await newCarrier();
    const oid = tryDecodeId('carrier', other.id)!;
    await trip({ day: -1, fees: ['7777', '1111'], carrierId: oid, feeCarrierIds: [cid, oid] });

    const r = await api(app, admin).get(`/v1/carriers/${c.id}/recent-prices`).expect(200);
    expect(r.body.data.map((p: { buyAmount: string }) => p.buyAmount)).toEqual([
      '5300.00',
      '6100.00',
      '5200.00',
      '5300.50',
      '5100.00',
    ]);
    expect(r.body.data[0]).toMatchObject({
      tripId: expect.stringMatching(/^trp_[0-9a-f]{32}$/),
      tripNo: 'TRP-T14-6',
      date: d(-5),
      origin: { id: a.id, name: a.name },
      destination: { id: b.id, name: b.name },
      vehicleType: '6 ล้อ',
      rateCardCode: null,
    });
    expect(r.body.data[3].rateCardCode).toBe('RC-B-0009');
    const ro = await api(app, admin).get(`/v1/carriers/${other.id}/recent-prices`).expect(200);
    expect(ro.body.data.map((p: { buyAmount: string }) => p.buyAmount)).toEqual(['1111.00']);
    // กรองปลายทาง/ประเภทรถ
    const toB = await api(app, admin)
      .get(`/v1/carriers/${c.id}/recent-prices?originId=${a.id}&destinationId=${b.id}`)
      .expect(200);
    expect(toB.body.data.map((p: { buyAmount: string }) => p.buyAmount)).toEqual([
      '5300.00',
      '6100.00',
      '5300.50',
      '5100.00',
      '5000.00',
    ]);
    const ten = await api(app, admin)
      .get(`/v1/carriers/${c.id}/recent-prices?vehicleTypeId=${vt10}`)
      .expect(200);
    expect(ten.body.data.map((p: { buyAmount: string }) => p.buyAmount)).toEqual(['6100.00']);
    // ไม่มีสิทธิ์ดูราคาซื้อ → 403 · id ผิดรูปแบบ/ไม่พบ → 404
    const noBuy = await tokenFor(tenantId, 'master:read prices.sell:read');
    await api(app, noBuy).get(`/v1/carriers/${c.id}/recent-prices`).expect(403);
    await api(app, admin).get('/v1/carriers/car_zz/recent-prices').expect(404);
    await api(app, admin)
      .get(
        `/v1/carriers/${encodeId('carrier', '00000000-0000-4000-8000-000000000000')}/recent-prices`,
      )
      .expect(404);
  });
});
