import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import { DEFAULT_SERVICE_ITEMS } from '../src/modules/service-items/defaults';
import { ServiceItemsService } from '../src/modules/service-items/service-items.service';
import { snapshotServiceItem } from '../src/modules/service-items/snapshot';
import { bootstrapTenant, createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

const BASE = { calcUnit: 'PER_TRIP', defaultPrice: '500.00', vatType: 'VAT_7', whtRate: '3.00' };
type Item = { id: string; code: string; name: string; version: number; [k: string]: unknown };

/** ST2-T11 ค่าบริการเสริม (service_item) — docs/04 B Accessorial catalog, docs/01 §3.2, spec/02 §6 */
describe('ค่าบริการเสริม (service-items)', () => {
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

  const http = (token = admin) => api(app, token);
  const create = (body: object, token = admin) => http(token).post('/v1/service-items').send(body);
  const newItem = async (extra: object = {}): Promise<Item> =>
    (await create({ name: `รายการทดสอบ ${++seed}`, ...BASE, ...extra }).expect(201)).body;
  const patch = (it: Item, body: object, token = admin) =>
    http(token).patch(`/v1/service-items/${it.id}`).set('If-Match', `"${it.version}"`).send(body);
  /** เรียก service ภายใต้ tenant (เหมือนโมดูลเอกสาร ST3+ เรียก) */
  const inTenant = <T>(t: string, fn: (svc: ServiceItemsService) => Promise<T>) => {
    const dbs = app.get(DbService);
    const svc = app.get(ServiceItemsService);
    return dbs.withTenant(t, (tx) =>
      requestContext.run({ requestId: randomUUID(), tenantId: t, locale: 'th', tx }, () => fn(svc)),
    );
  };
  const errField = (body: { errors?: { field: string; code: string }[] }) =>
    body.errors?.map((e) => `${e.field}:${e.code}`);

  it('เกณฑ์ตรวจรับ: แก้ราคา/VAT ใน catalog แล้ว snapshot ที่ copy ไว้ก่อนหน้าไม่เปลี่ยน', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท snapshot' });
    const tok = await tokenFor(t.id);
    const list = await http(tok).get('/v1/service-items').expect(200);
    const wait = list.body.data.find((x: Item) => x.code === 'WAIT') as Item;
    const uuid = tryDecodeId('serviceItem', wait.id)!;

    // 1) snapshot ผ่าน service (ตัวช่วยของ ST3/ST4/ST5/ST6) แล้วคัดลอกลงบรรทัดเอกสารจริง (do_surcharge — schema v0)
    const snap = await inTenant(t.id, (svc) => svc.snapshotFor(uuid, 'SELL'));
    expect(snap).toEqual({
      sourceItemId: uuid,
      sourceVersion: 1,
      code: 'WAIT',
      name: 'ค่ารอ',
      nameEn: null,
      unit: 'PER_HOUR',
      unitLabel: 'ชั่วโมง',
      unitPrice: '200.00',
      fuelRefPrice: null,
      vatType: 'EXEMPT_TRANSPORT',
      whtRate: '1.00',
      isSurcharge: true,
      defaultAccountCode: null,
    });
    expect(Object.isFrozen(snap)).toBe(true);
    const line = await db.doSurcharge.create({
      data: {
        tenantId: t.id,
        deliveryOrderId: randomUUID(),
        serviceItemId: snap.sourceItemId,
        vatType: snap.vatType,
        whtRate: snap.whtRate,
        qty: '1.5',
        unitPrice: snap.unitPrice!,
        amount: '300.00',
      },
    });

    // 2) แก้ราคาและธงภาษีใน catalog (ค่าบริการ 7% / 3%)
    const e = await patch(
      wait,
      { defaultPrice: '250.00', vatType: 'VAT_7', whtRate: '3.00' },
      tok,
    ).expect(200);
    expect(e.body).toMatchObject({ defaultPrice: '250.00', vatType: 'VAT_7', whtRate: '3.00' });
    expect(e.body.version).toBe(2);
    expect(e.body.usage).toEqual({ rateCards: 0, doSurcharges: 1 });

    // 3) snapshot และบรรทัดเอกสารที่คัดลอกไว้ก่อนหน้าไม่เปลี่ยน; snapshot ใหม่ได้ค่าใหม่
    expect(snap).toMatchObject({
      unitPrice: '200.00',
      vatType: 'EXEMPT_TRANSPORT',
      whtRate: '1.00',
    });
    const after = await db.doSurcharge.findUniqueOrThrow({ where: { id: line.id } });
    expect([after.vatType, after.whtRate.toFixed(2), after.unitPrice.toFixed(2)]).toEqual([
      'EXEMPT_TRANSPORT',
      '1.00',
      '200.00',
    ]);
    const snap2 = await inTenant(t.id, (svc) => svc.snapshotFor(uuid, 'BUY'));
    expect(snap2).toMatchObject({
      sourceVersion: 2,
      unitPrice: '250.00',
      vatType: 'VAT_7',
      whtRate: '3.00',
    });
    // ฟังก์ชันบริสุทธิ์ให้ค่าเดียวกับ service
    const row = await db.serviceItem.findUniqueOrThrow({ where: { id: uuid } });
    expect(snapshotServiceItem(row)).toEqual(snap2);
  });

  it('tenant ใหม่มีชุดภาษาไทย 8 รายการ + ธงภาษีตามที่ตั้งไว้ (ไม่แน่นอน = ค่าขนส่ง ACC-3)', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท ชุดเริ่มต้น' });
    const tok = await tokenFor(t.id);
    const r = await http(tok).get('/v1/service-items').expect(200);
    const by = Object.fromEntries(r.body.data.map((x: Item) => [x.code, x]));
    expect(Object.keys(by).sort()).toEqual(
      ['EXTRA_STOP', 'FREIGHT', 'FSC', 'LOAD', 'OVERNIGHT', 'TOLL', 'UNLOAD', 'WAIT'].sort(),
    );
    expect(by.FREIGHT).toMatchObject({
      name: 'ค่าขนส่ง',
      vatType: 'EXEMPT_TRANSPORT',
      whtRate: '1.00',
      defaultPrice: null,
      isSurcharge: false,
      system: true,
      reserved: true,
      side: 'BOTH',
    });
    expect(by.LOAD).toMatchObject({ vatType: 'VAT_7', whtRate: '3.00', defaultPrice: '500.00' });
    expect(by.TOLL).toMatchObject({ calcUnit: 'ACTUAL', defaultPrice: null, unitLabel: 'ตามจริง' });
    expect(by.WAIT).toMatchObject({ reserved: false, system: true, condition: 'ฟรี 2 ชม. แรก' });
    const s = await http(tok).get('/v1/service-items/summary').expect(200);
    expect(s.body).toEqual({ total: 8, active: 8, inactive: 0, vat7: 2, exempt: 6, zeroRated: 0 });
    // audit ผู้ทำ = ระบบ + event
    expect(
      await db.auditLog.count({
        where: { tenantId: t.id, action: 'service_item.created', actorId: null },
      }),
    ).toBe(8);
    expect(
      await db.tenantDefault.count({
        where: { tenantId: t.id, key: { startsWith: 'service_item:' }, outcome: 'INSERTED' },
      }),
    ).toBe(DEFAULT_SERVICE_ITEMS.length);
  });

  it('bootstrap รันซ้ำได้: ไม่สร้างซ้ำ ไม่ทับที่แก้ ไม่คืนชีพที่ลบ; ชนรหัส/ชื่อที่มีอยู่ → ข้าม', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท รันซ้ำ' });
    const rows = await db.serviceItem.findMany({ where: { tenantId: t.id } });
    const wait = rows.find((r) => r.code === 'WAIT')!;
    const night = rows.find((r) => r.code === 'OVERNIGHT')!;
    await db.serviceItem.update({
      where: { id: wait.id },
      data: { code: 'WAITING', defaultPrice: '350.00' },
    });
    await db.serviceItem.update({ where: { id: night.id }, data: { deletedAt: new Date() } });
    await bootstrapTenant(db, t.id);
    await bootstrapTenant(db, t.id);
    const after = await db.serviceItem.findMany({ where: { tenantId: t.id } });
    expect(after).toHaveLength(DEFAULT_SERVICE_ITEMS.length);
    expect(after.find((r) => r.id === wait.id)!.defaultPrice!.toFixed(2)).toBe('350.00');
    expect(after.find((r) => r.id === night.id)!.deletedAt).not.toBeNull();

    // tenant เก่า (ก่อนมีขั้น service-items) ที่มีรหัส/ชื่อเดียวกันอยู่แล้ว
    const old = (await createTenant(db)).id;
    await db.serviceItem.create({
      data: {
        tenantId: old,
        code: 'WAIT',
        nameTh: 'ค่ารอของเรา',
        vatType: 'VAT_7',
        whtRate: '3.00',
        unitLabel: 'ชั่วโมง',
        calcUnit: 'PER_HOUR',
      },
    });
    await bootstrapTenant(db, old);
    const mine = await db.serviceItem.findMany({ where: { tenantId: old } });
    expect(mine).toHaveLength(DEFAULT_SERVICE_ITEMS.length); // WAIT ของระบบถูกข้าม
    expect(mine.find((r) => r.code === 'WAIT')).toMatchObject({
      nameTh: 'ค่ารอของเรา',
      vatType: 'VAT_7',
    });
    const skipped = await db.tenantDefault.findUnique({
      where: { tenantId_key: { tenantId: old, key: 'service_item:WAIT' } },
    });
    expect(skipped).toMatchObject({ outcome: 'SKIPPED', detail: 'code_or_name_taken' });
  });

  it('สร้าง: รหัส AX-0001, ชื่อซ้ำ/รหัสซ้ำ 409, Idempotency-Key, หน่วยบนเอกสารตามหน่วยคิด', async () => {
    const n = await http().get('/v1/service-items/next-code').expect(200);
    expect(n.body.code).toBe('AX-0001');
    const a = await newItem({ name: 'ค่ายกเลิกงาน', condition: '  ยกเลิก​หลังรถออก  ' });
    expect(a).toMatchObject({
      code: 'AX-0001',
      unitLabel: 'เที่ยว',
      condition: 'ยกเลิก หลังรถออก',
      side: 'BOTH',
      isSurcharge: true,
      system: false,
      reserved: false,
      status: 'active',
    });
    expect(a.id).toMatch(/^svc_[0-9a-f]{32}$/);
    const dup = await create({ name: 'ค่ายกเลิกงาน', ...BASE }).expect(409);
    expect(dup.body.existing).toMatchObject({ code: 'AX-0001' });
    await create({ name: 'อื่น', code: 'ax-0001', ...BASE }).expect(409);
    const key = randomUUID();
    const r1 = await http()
      .post('/v1/service-items')
      .set('Idempotency-Key', key)
      .send({ name: 'ค่าแรงยกพิเศษ', ...BASE })
      .expect(201);
    const r2 = await http()
      .post('/v1/service-items')
      .set('Idempotency-Key', key)
      .send({ name: 'ค่าแรงยกพิเศษ', ...BASE })
      .expect(201);
    expect(r2.body.id).toBe(r1.body.id);
  });

  it('ตรวจเงินและธงภาษี: ทศนิยม ≤ 2 สตริงเท่านั้น, WHT เฉพาะ 0/1/3, คู่ VAT × WHT, ตามจริง/%/ราคาน้ำมัน', async () => {
    const bad = async (body: object, expectErr: string) => {
      const r = await create({ name: `ผิด ${++seed}`, ...BASE, ...body }).expect(422);
      expect(errField(r.body)).toContain(expectErr);
    };
    await bad({ defaultPrice: '-1.00' }, 'defaultPrice:matches');
    await bad({ defaultPrice: '10.555' }, 'defaultPrice:matches');
    await bad({ defaultPrice: 500 }, 'defaultPrice:matches'); // float ไม่รับ
    await bad({ whtRate: '2.00' }, 'whtRate:isIn');
    await bad({ whtRate: 3 }, 'whtRate:isIn');
    await bad({ vatType: 'VAT_10' }, 'vatType:isIn');
    await bad({ vatType: 'EXEMPT_TRANSPORT', whtRate: '3.00' }, 'whtRate:vat_wht_combo');
    await bad({ vatType: 'VAT_7', whtRate: '1.00' }, 'whtRate:vat_wht_combo');
    await bad({ calcUnit: 'ACTUAL', defaultPrice: '10.00' }, 'defaultPrice:actual_no_price');
    await bad(
      { calcUnit: 'PERCENT_OF_FREIGHT', defaultPrice: '100.01' },
      'defaultPrice:percent_max',
    );
    await bad({ fuelRefPrice: '31.50' }, 'fuelRefPrice:not_percent');
    await bad(
      { calcUnit: 'PERCENT_OF_FREIGHT', defaultPrice: '4.5', fuelRefPrice: '0' },
      'fuelRefPrice:min',
    );
    await bad({ calcUnit: 'PER_KM' }, 'calcUnit:isIn');
    await bad({ side: 'ALL' }, 'side:isIn');
    // null บนช่องบังคับ → 422
    await bad({ vatType: null }, 'vatType:isIn');
    // คู่ที่ถูก
    await newItem({ vatType: 'EXEMPT_TRANSPORT', whtRate: '1.00' });
    await newItem({ vatType: 'EXEMPT_TRANSPORT', whtRate: '0.00' });
    await newItem({ vatType: 'ZERO_RATED', whtRate: '1.00' });
    const fsc = await newItem({
      calcUnit: 'PERCENT_OF_FREIGHT',
      defaultPrice: '4.5',
      fuelRefPrice: '31.5',
      vatType: 'EXEMPT_TRANSPORT',
      whtRate: '1.00',
    });
    expect(fsc).toMatchObject({ defaultPrice: '4.50', fuelRefPrice: '31.50', unitLabel: '%' });

    // PATCH: เปลี่ยนแค่ VAT จนคู่ผิด → 422 ชี้ vatType; เปลี่ยนหน่วยเป็นตามจริง → ล้างราคา/ราคาน้ำมันให้เอง
    const it1 = await newItem();
    const p = await patch(it1, { vatType: 'EXEMPT_TRANSPORT' }).expect(422);
    expect(errField(p.body)).toEqual(['vatType:vat_wht_combo']);
    await patch(it1, { vatType: 'EXEMPT_TRANSPORT', whtRate: '1.00' }).expect(200);
    const c = await patch(fsc, { calcUnit: 'ACTUAL' }).expect(200);
    expect(c.body).toMatchObject({ defaultPrice: null, fuelRefPrice: null, unitLabel: 'ตามจริง' });
  });

  it('รหัสสงวน FREIGHT/EXTRA_STOP/FSC: แก้ชื่อ/ธงภาษีได้ ปิดใช้/ลบ/เปลี่ยนรหัสไม่ได้ · แถวระบบอื่นปิดใช้ได้', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท สงวน' });
    const tok = await tokenFor(t.id);
    const all = (await http(tok).get('/v1/service-items').expect(200)).body.data as Item[];
    const fr = all.find((x) => x.code === 'FREIGHT')!;
    const r1 = await http(tok)
      .post(`/v1/service-items/${fr.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้รหัสสงวน' })
      .expect(409);
    expect(errField(r1.body)).toEqual(['id:reserved_item']);
    await http(tok)
      .post(`/v1/service-items/${fr.id}/delete`)
      .send({ reason: 'ทดสอบลบรหัสสงวน' })
      .expect(409);
    const c = await patch(fr, { code: 'FRT' }, tok).expect(422);
    expect(errField(c.body)).toEqual(['code:reserved_code']);
    const ok = await patch(fr, { name: 'ค่าขนส่งสินค้า', whtRate: '0.00' }, tok).expect(200);
    expect(ok.body).toMatchObject({ name: 'ค่าขนส่งสินค้า', whtRate: '0.00', reserved: true });

    const wait = all.find((x) => x.code === 'WAIT')!;
    const off = await http(tok)
      .post(`/v1/service-items/${wait.id}/deactivate`)
      .set('If-Match', `"${wait.version}"`)
      .send({ reason: 'ไม่คิดค่ารอกับลูกค้าแล้ว' })
      .expect(200);
    expect(off.body.status).toBe('inactive');
    // ปิดใช้แล้ว → ใช้สร้างบรรทัดเอกสารไม่ได้
    const uuid = tryDecodeId('serviceItem', wait.id)!;
    await expect(inTenant(t.id, (svc) => svc.snapshotFor(uuid, 'SELL'))).rejects.toMatchObject({
      code: 'validation_failed',
      errors: [expect.objectContaining({ code: 'service_item_inactive' })],
    });
    await http(tok).post(`/v1/service-items/${wait.id}/activate`).send({}).expect(200);
    // รหัสแถวระบบที่ไม่สงวนเปลี่ยนได้
    const w2 = (await http(tok).get(`/v1/service-items/${wait.id}`).expect(200)).body as Item;
    await patch(w2, { code: 'WAITING' }, tok).expect(200);
  });

  it('snapshotFor: ฝั่งไม่ตรง/ไม่พบ → 422; ลบ: ถูกอ้างอิง → 409 in_use, ไม่ถูกอ้างอิง → soft delete ใช้ชื่อซ้ำได้', async () => {
    const buy = await newItem({ name: 'ค่าเบี้ยเลี้ยงรถร่วม', side: 'BUY' });
    const uuid = tryDecodeId('serviceItem', buy.id)!;
    const err = await inTenant(tenantId, (svc) => svc.snapshotFor(uuid, 'SELL')).catch((e) => e);
    expect(err.errors).toEqual([
      expect.objectContaining({ field: 'serviceItemId', code: 'service_item_side' }),
    ]);
    await expect(inTenant(tenantId, (svc) => svc.snapshotFor(uuid, 'BUY'))).resolves.toMatchObject({
      code: buy.code,
    });
    // tenant อื่นมองไม่เห็น (RLS)
    const other = (await createTenant(db)).id;
    const e2 = await inTenant(other, (svc) => svc.snapshotFor(uuid, 'BUY')).catch((e) => e);
    expect(e2.errors[0].code).toBe('service_item_not_found');

    await db.doSurcharge.create({
      data: {
        tenantId,
        deliveryOrderId: randomUUID(),
        serviceItemId: uuid,
        vatType: 'VAT_7',
        whtRate: '3.00',
        qty: '1',
        unitPrice: '500.00',
        amount: '500.00',
      },
    });
    const r = await http()
      .post(`/v1/service-items/${buy.id}/delete`)
      .send({ reason: 'ทดสอบลบที่ถูกอ้างอิง' })
      .expect(409);
    expect(r.body.code).toBe('in_use');

    const tmp = await newItem({ name: 'รายการชั่วคราว' });
    await http()
      .post(`/v1/service-items/${tmp.id}/delete`)
      .send({ reason: 'สร้างผิด ไม่ได้ใช้งาน' })
      .expect(204);
    await http().get(`/v1/service-items/${tmp.id}`).expect(404);
    await newItem({ name: 'รายการชั่วคราว' }); // ชื่อเดิมใช้ใหม่ได้
    const h = await http()
      .get(`/v1/service-items?includeDeleted=true&name=${encodeURIComponent('ชั่วคราว')}`)
      .expect(200);
    expect(h.body.data.some((x: Item) => x.deletedAt)).toBe(true);
  });

  it('PATCH 412/no-op, PUT external idempotent, history, list filters, export', async () => {
    const it1 = await newItem({ name: 'ค่าบริการรายการ A' });
    await patch({ ...it1, version: 99 }, { defaultPrice: '1.00' }).expect(412);
    const same = await patch(it1, { defaultPrice: '500.00', whtRate: '3.00' }).expect(200);
    expect(same.body.version).toBe(1); // ค่าเดิม = ไม่เพิ่ม version

    const put = (body: object) => http().put('/v1/service-items/external/ERP-SVC-1').send(body);
    const c1 = await put({ name: 'ค่าบริการจาก ERP', ...BASE }).expect(201);
    const c2 = await put({ name: 'ค่าบริการจาก ERP', ...BASE, defaultPrice: '600.00' }).expect(200);
    expect(c2.body.id).toBe(c1.body.id);
    expect(c2.body.defaultPrice).toBe('600.00');
    await http().get('/v1/service-items/ext:ERP-SVC-1').expect(200);

    const h = await http().get(`/v1/service-items/${c1.body.id}/history`).expect(200);
    expect(h.body.data.map((x: { action: string }) => x.action)).toEqual([
      'service_item.updated',
      'service_item.created',
    ]);

    const f = await http().get('/v1/service-items?vatType=VAT_7&calcUnit=PER_TRIP').expect(200);
    expect(f.body.data.every((x: Item) => x.vatType === 'VAT_7' && x.calcUnit === 'PER_TRIP')).toBe(
      true,
    );
    await newItem({ name: 'เฉพาะฝั่งขาย', side: 'SELL' });
    const sell = await http().get('/v1/service-items?side=BUY').expect(200);
    expect(sell.body.data.some((x: Item) => x.side === 'SELL')).toBe(false);

    const csv = await http().get('/v1/service-items/export?format=csv').expect(200);
    expect(csv.text.split('\n')[0]).toContain('รหัส');
    expect(csv.text).toContain('ค่าบริการจาก ERP');
    const viewer = await tokenFor(tenantId, 'master:read');
    await http(viewer).get('/v1/service-items/export?format=csv').expect(403);
    await create({ name: 'ไม่มีสิทธิ์', ...BASE }, viewer).expect(403);
  });
});
