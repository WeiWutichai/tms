import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST3-T06 จับคู่อัตโนมัติ + เรียนรู้ alias (docs/04 C) — เกณฑ์ตรวจรับ: map ข้อความปลายทางครั้งแรกด้วยมือ →
 * order ถัดไปข้อความเดิมจับคู่เอง · ความคล้าย/กำกวม/ขอบเขตลูกค้า/แยก tenant/พร้อมกัน/ทางเขียน
 */
describe('order auto-matching + alias learning', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let reader: string;
  let vt6: string;
  let seed = 0;
  const today = bangkokToday();
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const pubOrder = (id: string) => encodeId('salesOrder', id);

  async function company(tid: string) {
    const c = await db.company.create({
      data: {
        tenantId: tid,
        legalName: `บริษัท ผู้ออกบิล ${++seed}`,
        taxId: validTaxId(700 + seed),
      },
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท จับคู่' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
    reader = await tokenFor(tenantId, 'orders:read');
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body.data;
    vt6 = uuid('vehicleType', types.find((t: { code: string }) => t.code === '6W').id);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const inTenant = <T>(tid: string, fn: (svc: OrderIntakeService) => Promise<T>) =>
    app
      .get(DbService)
      .withTenant(tid, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId: tid, actorId: 'user-test', locale: 'th', tx },
          () => fn(app.get(OrderIntakeService)),
        ),
      );
  const upsert = (input: UpsertOrderInput, tid = tenantId) =>
    inTenant(tid, (s) => s.upsertOrder(input));

  const newSite = async (name: string, customer?: string, token = admin, aliases?: string[]) =>
    uuid(
      'site',
      (
        await api(app, token)
          .post('/v1/customer-sites')
          .send({
            name,
            kind: 'DROPOFF',
            address: ADDR,
            ...(customer ? { customerId: encodeId('customer', customer) } : {}),
            ...(aliases ? { aliases } : {}),
          })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async (extra: object = {}, token = admin) =>
    uuid(
      'customer',
      (
        await api(app, token)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9300 + seed), ...extra })
          .expect(201)
      ).body.id,
    );
  const approveRate = async (customer: string, origin: string, dest: string) => {
    const r = (
      await api(app, admin)
        .post('/v1/rate-cards')
        .send({
          customerId: encodeId('customer', customer),
          originId: encodeId('site', origin),
          destinationId: encodeId('site', dest),
          vehicleTypeId: encodeId('vehicleType', vt6),
          validFrom: addDays(today, -30),
          pricingModel: 'PER_TRIP',
          sellRate: '4500',
        })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${r.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
  };
  /** order จาก ERP: ลูกค้าตามรหัสต้นทาง + ต้นทางเป็น id + ปลายทางเป็นข้อความ */
  const erpOrder = (
    ext: string,
    o: { custExt?: string; custId?: string; custText?: string; origin: string; dest: string },
    source = 'ERP:krs',
  ): UpsertOrderInput => ({
    source,
    externalId: ext,
    customer: o.custId
      ? { id: o.custId }
      : { externalId: o.custExt ?? null, text: o.custText ?? null },
    requestedDate: today,
    vehicleTypeId: vt6,
    stops: [
      { type: 'PICKUP', siteId: o.origin },
      { type: 'DELIVERY', siteText: o.dest },
    ],
  });
  const holdCodes = (r: { holds: { code: string }[] }) => r.holds.map((h) => h.code);

  it('เกณฑ์ตรวจรับ: map ข้อความปลายทางครั้งแรกด้วยมือ → order ถัดไปข้อความเดิมจับคู่เอง (alias บนสถานที่ + ราคา + ปล่อยใบค้าง)', async () => {
    const cust = await newCustomer({ externalId: 'KRS-C-100' });
    const origin = await newSite('คลังต้นทาง ศรีราชา');
    const dest = await newSite('ร้านวัสดุก่อสร้าง ส.เจริญ', cust);
    await approveRate(cust, origin, dest);
    const text = 'หจก. ส.เจริญ วัสดุ (บ้านบึง)';

    const a = await upsert(erpOrder('KRS-SO-100', { custExt: 'KRS-C-100', origin, dest: text }));
    expect(a.order.customerId).toBe(cust);
    expect(a.order.customerMatchMethod).toBe('EXTERNAL_ID');
    expect(a.order.status).toBe('ON_HOLD');
    expect(holdCodes(a)).toEqual(['LOCATION_UNMAPPED', 'RATE_MISSING']);
    expect(a.order.stops[1]).toMatchObject({ siteId: null, matchMethod: null });

    // คน map ผ่าน API (หน้าใบค้าง T07 เรียก endpoint นี้)
    const before = (
      await api(app, admin)
        .get(`/v1/orders/${pubOrder(a.order.id)}`)
        .expect(200)
    ).headers.etag;
    const m = await api(app, admin)
      .post(`/v1/orders/${pubOrder(a.order.id)}/stops/2/map-site`)
      .set('If-Match', before!)
      .send({ siteId: encodeId('site', dest) })
      .expect(200);
    expect(m.body).toMatchObject({
      status: 'received',
      aliasLearning: 'learned',
      pricingStatus: 'AVAILABLE',
      sellTotal: '4500.00',
      holdReason: null,
    });
    expect(m.body.stops[1]).toMatchObject({
      siteId: encodeId('site', dest),
      siteText: text,
      match: { method: 'MANUAL', score: null, candidates: [] },
    });
    expect(m.headers.etag).not.toBe(before);
    const site = await db.customerSite.findUniqueOrThrow({ where: { id: dest } });
    expect(site.aliases).toEqual([text]);
    expect(site.version).toBe(2);
    expect(
      await db.auditLog.count({ where: { entityId: dest, action: 'location.alias_learned' } }),
    ).toBe(1);
    expect(await db.domainEvent.count({ where: { localId: dest, type: 'location.updated' } })).toBe(
      1,
    );

    // order ถัดไป ข้อความเดิม (เว้นวรรค/ตัวพิมพ์ต่าง) → จับคู่เองด้วย alias → RECEIVED มีราคา
    const b = await upsert(
      erpOrder('KRS-SO-101', { custExt: 'KRS-C-100', origin, dest: 'หจก.ส.เจริญวัสดุ  (บ้านบึง)' }),
    );
    expect(b.order.status).toBe('RECEIVED');
    expect(b.order.pricingStatus).toBe('AVAILABLE');
    expect(b.order.stops[1]).toMatchObject({ siteId: dest, matchMethod: 'ALIAS' });
    expect(Number(b.order.stops[1]!.matchScore)).toBe(1);
    // map ซ้ำ = จำไว้แล้ว (ไม่เพิ่ม alias ซ้ำ)
    const again = await api(app, admin)
      .post(`/v1/orders/${pubOrder(a.order.id)}/stops/2/map-site`)
      .send({ siteId: encodeId('site', dest) })
      .expect(200);
    expect(again.body.aliasLearning).toBe('exists');
    expect(again.body.version).toBe(m.body.version);
    expect((await db.customerSite.findUniqueOrThrow({ where: { id: dest } })).aliases).toHaveLength(
      1,
    );
  });

  it('ใบที่ค้างอยู่ก่อนเรียนรู้: ส่งซ้ำค่าเดิมหรือ reevaluate() → จับคู่ด้วย alias ใหม่ (version +1, audit, order.updated)', async () => {
    const cust = await newCustomer({ externalId: 'KRS-C-110' });
    const origin = await newSite('คลังต้นทาง บางปู');
    const dest = await newSite('โกดังปลายทาง ลำลูกกา', cust);
    const text = 'ปลายทาง ลำลูกกา คลอง 4';
    const input1 = erpOrder('KRS-SO-110', { custExt: 'KRS-C-110', origin, dest: text });
    const input2 = erpOrder('KRS-SO-111', { custExt: 'KRS-C-110', origin, dest: text });
    const held1 = await upsert(input1);
    const held2 = await upsert(input2);
    expect(holdCodes(held2)[0]).toBe('LOCATION_UNMAPPED');

    await api(app, admin)
      .post(`/v1/orders/${pubOrder(held1.order.id)}/stops/2/map-site`)
      .send({ siteId: encodeId('site', dest) })
      .expect(200);
    const v = held2.order.version;
    const re = await inTenant(tenantId, (s) => s.reevaluate(held2.order.id));
    expect(re.order.stops[1]).toMatchObject({ siteId: dest, matchMethod: 'ALIAS' });
    expect(re.order.version).toBe(v + 1);
    expect(holdCodes(re)).toEqual(['RATE_MISSING']);
    expect(
      await db.domainEvent.count({ where: { localId: held2.order.id, type: 'order.updated' } }),
    ).toBeGreaterThan(0);
    // ส่งซ้ำค่าเดิม (hash เดิม) → ไม่เปลี่ยนอะไรอีก; สถานที่ที่จับคู่แล้วไม่หาย
    const same = await upsert(input2);
    expect(same.changed).toBe(false);
    expect(same.order.stops[1]!.siteId).toBe(dest);
    // ต้นทางแก้ช่องอื่น (PO) แต่ข้อความจุดเดิม → สถานที่ + วิธีจับคู่เดิมคงอยู่
    const edited = await upsert({ ...input2, customerRef: 'PO-777' });
    expect(edited.order.stops[1]).toMatchObject({ siteId: dest, matchMethod: 'ALIAS' });
  });

  it('ความคล้าย: ชื่อตรงหลัง normalize = NAME · พิมพ์ผิดเล็กน้อย = FUZZY · เลขสาขาต่าง/ไม่ถึงเกณฑ์ = ไม่จับคู่ + รายการแนะนำ', async () => {
    const cust = await newCustomer({ externalId: 'KRS-C-120' });
    const origin = await newSite('คลังต้นทาง ระยอง');
    const bangna = await newSite('คลังสินค้าบางนา กม.5', cust);
    const s2 = await newSite('ตลาดไท สาขา 2', cust);
    const s3 = await newSite('ตลาดไท สาขา 3', cust);
    const o = (ext: string, dest: string) =>
      upsert(erpOrder(ext, { custExt: 'KRS-C-120', origin, dest }));

    const name = await o('KRS-SO-120', 'บริษัท คลังสินค้า บางนา กม. ๕ จำกัด');
    expect(name.order.stops[1]).toMatchObject({ siteId: bangna, matchMethod: 'NAME' });

    const typo = await o('KRS-SO-121', 'คลังสินค้าบางน่า กม.5');
    expect(typo.order.stops[1]).toMatchObject({ siteId: bangna, matchMethod: 'FUZZY' });
    expect(Number(typo.order.stops[1]!.matchScore)).toBeGreaterThanOrEqual(0.9);

    const branch = await o('KRS-SO-122', 'ตลาดไท สาขา 4');
    expect(branch.order.stops[1]!.siteId).toBeNull();
    expect(holdCodes(branch)[0]).toBe('LOCATION_UNMAPPED');
    const cands = (branch.order.stops[1]!.matchCandidates as { id: string }[]).map((c) => c.id);
    expect(cands.sort()).toEqual([s2, s3].sort());
    // API แสดงรายการแนะนำเป็น public id + รหัส/ชื่อ/คะแนน
    const view = (
      await api(app, admin)
        .get(`/v1/orders/${pubOrder(branch.order.id)}`)
        .expect(200)
    ).body;
    expect(view.stops[1].match.method).toBeNull();
    expect(view.stops[1].match.candidates[0]).toMatchObject({
      id: expect.stringMatching(/^loc_/),
      code: expect.stringMatching(/^LOC-/),
      name: expect.stringMatching(/^ตลาดไท/),
      score: expect.any(Number),
    });

    const far = await o('KRS-SO-123', 'สนามบินเชียงใหม่');
    expect(far.order.stops[1]).toMatchObject({ siteId: null, matchCandidates: null });
  });

  it('กำกวม: ชื่อซ้ำ 2 แห่งในขอบเขต → ไม่จับคู่เอง + แนะนำทั้งสอง · คนเลือก → alias ชี้ขาด → ใบถัดไปจับคู่เอง', async () => {
    const cust = await newCustomer({ externalId: 'KRS-C-130' });
    const origin = await newSite('คลังต้นทาง แหลมฉบัง');
    const a = await newSite('โรงงานสระบุรี', cust);
    const b = await newSite('โรงงาน สระบุรี'); // ของบริษัท
    const first = await upsert(
      erpOrder('KRS-SO-130', { custExt: 'KRS-C-130', origin, dest: 'โรงงานสระบุรี' }),
    );
    expect(first.order.stops[1]!.siteId).toBeNull();
    expect(
      (first.order.stops[1]!.matchCandidates as { id: string; score: number }[])
        .map((c) => c.id)
        .sort(),
    ).toEqual([a, b].sort());
    const m = await api(app, admin)
      .post(`/v1/orders/${pubOrder(first.order.id)}/stops/2/map-site`)
      .send({ siteId: encodeId('site', a) })
      .expect(200);
    expect(m.body.aliasLearning).toBe('learned');
    const next = await upsert(
      erpOrder('KRS-SO-131', { custExt: 'KRS-C-130', origin, dest: 'โรงงานสระบุรี' }),
    );
    expect(next.order.stops[1]).toMatchObject({ siteId: a, matchMethod: 'ALIAS' });
  });

  it('ขอบเขต: alias บนสถานที่ของลูกค้า A ไม่ใช้กับลูกค้า B · alias บนสถานที่ของบริษัทใช้ได้ทุกลูกค้า · ใบยังไม่มีลูกค้าจับคู่ได้เฉพาะของบริษัท', async () => {
    const custA = await newCustomer({ externalId: 'KRS-C-140' });
    const custB = await newCustomer({ externalId: 'KRS-C-141' });
    const origin = await newSite('คลังต้นทาง ปราจีน');
    await newSite('ร้าน ก. ของลูกค้าเอ', custA, admin, ['จุดลงของ หน้าตลาด']);
    const hub = await newSite('ศูนย์กระจายสินค้ากลาง', undefined, admin, ['ฮับกลาง วังน้อย']);

    const b = await upsert(
      erpOrder('KRS-SO-140', { custExt: 'KRS-C-141', origin, dest: 'จุดลงของหน้าตลาด' }),
    );
    expect(b.order.customerId).toBe(custB);
    expect(b.order.stops[1]).toMatchObject({ siteId: null, matchCandidates: null });

    const hubB = await upsert(
      erpOrder('KRS-SO-141', { custExt: 'KRS-C-141', origin, dest: 'ฮับกลาง วังน้อย' }),
    );
    expect(hubB.order.stops[1]).toMatchObject({ siteId: hub, matchMethod: 'ALIAS' });
    const hubNoCust = await upsert(
      erpOrder('KRS-SO-142', { custExt: 'KRS-C-UNKNOWN', origin, dest: 'ฮับกลาง วังน้อย' }),
    );
    expect(hubNoCust.order.customerId).toBeNull();
    expect(hubNoCust.order.stops[1]!.siteId).toBe(hub);

    // map-site: สถานที่ของลูกค้าอื่น → 422 · ใบยังไม่มีลูกค้า + สถานที่ของลูกค้า → 422 customer_unmapped
    const siteA = await newSite('จุดส่ง เฉพาะลูกค้าเอ', custA);
    const e1 = await api(app, admin)
      .post(`/v1/orders/${pubOrder(b.order.id)}/stops/2/map-site`)
      .send({ siteId: encodeId('site', siteA) })
      .expect(422);
    expect(e1.body.errors[0]).toMatchObject({ field: 'siteId', code: 'site_other_customer' });
    const unk = await upsert(
      erpOrder('KRS-SO-143', { custExt: 'KRS-C-UNKNOWN', origin, dest: 'ข้อความใหม่ไม่รู้จัก' }),
    );
    const e2 = await api(app, admin)
      .post(`/v1/orders/${pubOrder(unk.order.id)}/stops/2/map-site`)
      .send({ siteId: encodeId('site', siteA) })
      .expect(422);
    expect(e2.body.errors[0].code).toBe('customer_unmapped');
    // ลำดับจุดที่ไม่มี → 404 · id สถานที่ผิดรูป → 422 · สิทธิ์อ่านอย่างเดียว → 403 · If-Match ไม่ตรง → 412
    await api(app, admin)
      .post(`/v1/orders/${pubOrder(b.order.id)}/stops/9/map-site`)
      .send({ siteId: encodeId('site', hub) })
      .expect(404);
    await api(app, admin)
      .post(`/v1/orders/${pubOrder(b.order.id)}/stops/2/map-site`)
      .send({ siteId: 'cus_123' })
      .expect(422);
    await api(app, reader)
      .post(`/v1/orders/${pubOrder(b.order.id)}/stops/2/map-site`)
      .send({ siteId: encodeId('site', hub) })
      .expect(403);
    await api(app, admin)
      .post(`/v1/orders/${pubOrder(b.order.id)}/stops/2/map-site`)
      .set('If-Match', '"999"')
      .send({ siteId: encodeId('site', hub) })
      .expect(412);
  });

  it('ลูกค้า: รหัสต้นทางไม่รู้จัก → CUSTOMER_UNMAPPED + แนะนำชื่อคล้าย · คน map → จำรหัสต่อช่องทาง → ใบถัดไปจับคู่เอง (ช่องทางอื่นไม่ใช้) · ไม่มีรหัส = จำชื่อ', async () => {
    const cust = await newCustomer({
      legalName: 'บริษัท ปูนซีเมนต์ทดสอบ จำกัด',
      taxId: validTaxId(9901),
    });
    const origin = await newSite('คลังต้นทาง สระบุรี');
    const dest = await newSite('ไซต์ก่อสร้าง ทดสอบ', cust);
    const held = await upsert(
      erpOrder('KRS-SO-150', {
        custExt: 'NSF-777',
        custText: 'ปูนซีเมนต์ทดสอบ',
        origin,
        dest: 'ไซต์ก่อสร้างทดสอบ',
      }),
    );
    expect(held.order.customerId).toBeNull();
    expect(holdCodes(held)[0]).toBe('CUSTOMER_UNMAPPED');
    // ยังไม่มีลูกค้า → สถานที่ของลูกค้าไม่อยู่ในขอบเขต
    expect(held.order.stops[1]!.siteId).toBeNull();
    const view = (
      await api(app, admin)
        .get(`/v1/orders/${pubOrder(held.order.id)}`)
        .expect(200)
    ).body;
    expect(view.customer.match).toMatchObject({
      method: null,
      candidates: [{ id: encodeId('customer', cust), score: 1 }],
    });

    const m = await api(app, admin)
      .post(`/v1/orders/${pubOrder(held.order.id)}/map-customer`)
      .send({ customerId: encodeId('customer', cust) })
      .expect(200);
    expect(m.body).toMatchObject({
      aliasLearning: 'learned',
      customer: { id: encodeId('customer', cust), match: { method: 'MANUAL', candidates: [] } },
    });
    // ได้ลูกค้าแล้ว จุดที่ว่างจับคู่ในขอบเขตลูกค้านั้นต่อทันที (ชื่อตรงหลัง normalize)
    expect(m.body.stops[1]).toMatchObject({
      siteId: encodeId('site', dest),
      match: { method: 'NAME' },
    });
    expect(m.body.holdCodes).toEqual(['RATE_MISSING']);
    expect(
      await db.customerAlias.findMany({
        where: { tenantId },
        select: { kind: true, source: true, value: true, customerId: true },
      }),
    ).toEqual([{ kind: 'EXTERNAL_ID', source: 'ERP:krs', value: 'NSF-777', customerId: cust }]);
    expect(
      await db.auditLog.count({ where: { entityId: cust, action: 'customer.alias_learned' } }),
    ).toBe(1);

    const next = await upsert(erpOrder('KRS-SO-151', { custExt: 'NSF-777', origin, dest: 'x' }));
    expect(next.order).toMatchObject({ customerId: cust, customerMatchMethod: 'ALIAS' });
    const otherSource = await upsert(
      erpOrder('API-SO-151', { custExt: 'NSF-777', origin, dest: 'x' }, 'API'),
    );
    expect(otherSource.order.customerId).toBeNull();

    // ไม่มีรหัส (กรอก/Excel ด้วยชื่อ) → จำชื่อ; ชื่อรูปต่าง (บจก./จำกัด/ช่องว่าง) ก็จับคู่
    const byName = await upsert({
      ...erpOrder('XL-1', { custText: 'บจก. ร้านค้าส่งตัวอย่าง', origin, dest: 'x' }, 'EXCEL'),
    });
    expect(byName.order.customerId).toBeNull();
    await api(app, admin)
      .post(`/v1/orders/${pubOrder(byName.order.id)}/map-customer`)
      .send({ customerId: encodeId('customer', cust) })
      .expect(200);
    const byName2 = await upsert(
      erpOrder('XL-2', { custText: 'ร้านค้าส่ง ตัวอย่าง จำกัด', origin, dest: 'x' }, 'EXCEL'),
    );
    expect(byName2.order).toMatchObject({ customerId: cust, customerMatchMethod: 'ALIAS' });

    // คน map รหัสเดิมไปลูกค้าอื่น = ย้าย (audit) · ลูกค้าปิดใช้ → 422
    const cust2 = await newCustomer();
    const held2 = await upsert(erpOrder('KRS-SO-152', { custExt: 'NSF-888', origin, dest: 'x' }));
    await api(app, admin)
      .post(`/v1/orders/${pubOrder(held2.order.id)}/map-customer`)
      .send({ customerId: encodeId('customer', cust2) })
      .expect(200);
    await api(app, admin)
      .post(`/v1/customers/${encodeId('customer', cust2)}/deactivate`)
      .send({ reason: 'เลิกใช้บริการแล้วครับ' })
      .expect(200);
    const held3 = await upsert(erpOrder('KRS-SO-153', { custExt: 'NSF-888', origin, dest: 'x' }));
    expect(held3.order.customerId).toBeNull(); // alias ชี้ลูกค้าที่ปิดใช้ = ไม่จับคู่
    const bad = await api(app, admin)
      .post(`/v1/orders/${pubOrder(held3.order.id)}/map-customer`)
      .send({ customerId: encodeId('customer', cust2) })
      .expect(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'customerId', code: 'reference_inactive' });
    await api(app, admin)
      .post(`/v1/orders/${pubOrder(held3.order.id)}/map-customer`)
      .send({ customerId: encodeId('customer', cust) })
      .expect(200);
    const moved = await db.customerAlias.findFirstOrThrow({
      where: { tenantId, kind: 'EXTERNAL_ID', valueKey: 'NSF-888' },
    });
    expect(moved.customerId).toBe(cust);
  });

  it('แยก tenant: alias/สถานที่ของ tenant A ไม่ถูกใช้จับคู่ใน tenant B; customer_alias มี RLS; map ใบของอีก tenant → 404', async () => {
    const cust = await newCustomer({ externalId: 'ISO-C-1' });
    const originA = await newSite('ต้นทาง ก');
    const destA = await newSite('ปลายทางแยกข้อมูล', undefined, admin, ['ข้อความลับของเอ']);
    const a = await upsert(
      erpOrder('ISO-SO-1', { custExt: 'ISO-C-1', origin: originA, dest: 'ข้อความลับของเอ' }),
    );
    expect(a.order.stops[1]!.siteId).toBe(destA);
    const held = await upsert(
      erpOrder('ISO-SO-2', { custExt: 'ISO-X', origin: originA, dest: 'z' }),
    );
    await api(app, admin)
      .post(`/v1/orders/${pubOrder(held.order.id)}/map-customer`)
      .send({ customerId: encodeId('customer', cust) })
      .expect(200);

    const originB = await newSite('ต้นทาง ข', undefined, other);
    await newCustomer({ externalId: 'ISO-C-1' }, other);
    const b = await upsert(
      {
        ...erpOrder('ISO-SO-1', { custExt: 'ISO-X', origin: originB, dest: 'ข้อความลับของเอ' }),
        vehicleTypeId: null,
      },
      otherId,
    );
    expect(b.order.customerId).toBeNull(); // alias ISO-X อยู่ใน tenant A
    expect(b.order.stops[1]).toMatchObject({ siteId: null, matchCandidates: null });
    // RLS: role แอปใน tenant B มองไม่เห็น alias ของ A
    const seen = await app.get(DbService).withTenant(otherId, (tx) => tx.customerAlias.count());
    expect(seen).toBe(0);
    await api(app, other)
      .post(`/v1/orders/${pubOrder(a.order.id)}/stops/2/map-site`)
      .send({ siteId: encodeId('site', originB) })
      .expect(404);
  });

  it('พร้อมกัน: map ข้อความต่างกัน 6 ใบเข้าสถานที่เดียวพร้อมกัน → alias ครบไม่หาย · ข้อความเดียวกันพร้อมกัน → alias เดียว', async () => {
    const cust = await newCustomer({ externalId: 'CC-C-1' });
    const origin = await newSite('ต้นทาง พร้อมกัน');
    const dest = await newSite('ปลายทาง พร้อมกัน', cust);
    const texts = ['จุดส่งเอ', 'จุดส่งบี', 'จุดส่งซี', 'จุดส่งดี', 'จุดส่งอี', 'จุดส่งเอฟ'];
    const orders = await Promise.all(
      texts.map((t, i) => upsert(erpOrder(`CC-SO-${i}`, { custExt: 'CC-C-1', origin, dest: t }))),
    );
    const same = await Promise.all(
      [0, 1, 2].map((i) =>
        upsert(erpOrder(`CC-SAME-${i}`, { custExt: 'CC-C-1', origin, dest: 'จุดส่ง เดียวกัน' })),
      ),
    );
    const res = await Promise.all(
      [...orders, ...same].map((o) =>
        api(app, admin)
          .post(`/v1/orders/${pubOrder(o.order.id)}/stops/2/map-site`)
          .send({ siteId: encodeId('site', dest) }),
      ),
    );
    expect(res.map((r) => r.status)).toEqual(Array(9).fill(200));
    const aliases = (await db.customerSite.findUniqueOrThrow({ where: { id: dest } })).aliases;
    expect([...aliases].sort()).toEqual([...texts, 'จุดส่ง เดียวกัน'].sort());
    expect(res.filter((r) => r.body.aliasLearning === 'learned')).toHaveLength(7);
  });

  it('ทางเขียน: map-site / map-customer เขียน SO ผ่าน OrderIntakeService เท่านั้น (ไม่มีทางลัดอื่น)', async () => {
    const intake = app.get(OrderIntakeService);
    const spySite = vi.spyOn(intake, 'mapStopSite');
    const spyCust = vi.spyOn(intake, 'mapCustomer');
    try {
      const cust = await newCustomer();
      const origin = await newSite('ต้นทาง ทางเขียน');
      const dest = await newSite('ปลายทาง ทางเขียน', cust);
      const held = await upsert(
        erpOrder('PATH-SO-1', { custExt: 'PATH-X', origin, dest: 'abc ทางเขียน' }),
      );
      await api(app, admin)
        .post(`/v1/orders/${pubOrder(held.order.id)}/map-customer`)
        .send({ customerId: encodeId('customer', cust) })
        .expect(200);
      await api(app, admin)
        .post(`/v1/orders/${pubOrder(held.order.id)}/stops/2/map-site`)
        .send({ siteId: encodeId('site', dest) })
        .expect(200);
      expect(spyCust).toHaveBeenCalledTimes(1);
      expect(spySite).toHaveBeenCalledTimes(1);
    } finally {
      spySite.mockRestore();
      spyCust.mockRestore();
    }
  });
});
