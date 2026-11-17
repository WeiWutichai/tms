import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST4-T11 ตีกลับบางส่วน/ทั้งหมด (docs/04 E2; docs/01 §4.3) — เกณฑ์ตรวจรับ:
 * ของถูกปฏิเสธ 10 ชิ้น → เลือก "ส่งซ้ำ" ได้ DO ใหม่ 10 ชิ้นอ้างใบเดิม
 * + ใบเดิมคงส่งแล้ว, ปริมาณจัดสรร SO ไม่เกิน, SO ส่งครบ → ส่งบางส่วน → ส่งครบ, กดซ้ำ/If-Match, คืนคลัง,
 * ส่งไม่สำเร็จทั้งใบ (ส่งซ้ำ = ใบเดิม CANCELLED / คืนคลัง = RETURNED), สิทธิ์, แยก tenant, แก้หลักฐานหลังจัดการ, ยกเลิกใบส่งซ้ำ
 */
describe('partial/full return (ST4-T11)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherTenant: string;
  let admin: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const addDays = (d: string, n: number) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ตีกลับ' })).id;
    otherTenant = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(941) },
    });
    await db.branch.create({
      data: {
        tenantId,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherTenant);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    app
      .get(DbService)
      .withTenant(tenantId, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const newSite = async () =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  const newCustomer = async (billByActualQty: boolean, podRequirements?: object) => {
    const id = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9700 + seed), billByActualQty })
        .expect(201)
    ).body.id as string;
    if (podRequirements)
      await db.customer.update({ where: { id: uuid('customer', id) }, data: { podRequirements } });
    return id;
  };
  const rate = async (
    key: { customer: string; origin: string; dest: string },
    body: Record<string, unknown>,
  ) => {
    const r = (
      await api(app, admin)
        .post('/v1/rate-cards')
        .send({
          customerId: key.customer,
          originId: key.origin,
          destinationId: key.dest,
          vehicleTypeId: vt6,
          validFrom: addDays(today, -30),
          includedStops: 2,
          ...body,
        })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${r.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
  };
  const newVehicle = async () => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `7${++seed % 10}-${String(3000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string };
    const n = ++seed;
    await api(app, admin)
      .post('/v1/drivers')
      .send({
        name: `คนขับ ${n}`,
        phone: `089-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    return v;
  };
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const post = (stop: string, action: string, min: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/stops/${stop}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra });

  /**
   * SO (2 บรรทัด: 20 ตัน + 5 ตัน) → DO → เที่ยวปล่อยรถ → ปิดจุดรับ + จุดส่ง
   * `rateBody` = rate card ขาขายของลูกค้า/เส้นทางนี้ · `manualPrice` = ไม่มี rate → กำหนดราคาเอง
   */
  const delivered = async (
    opts: {
      byActual?: boolean;
      rateBody?: Record<string, unknown>;
      manualPrice?: string;
      podRequirements?: object;
      fail?: boolean;
      productId?: string;
    } = {},
  ) => {
    const customer = await newCustomer(opts.byActual ?? false, opts.podRequirements);
    const origin = await newSite();
    const dest = await newSite();
    if (opts.rateBody) await rate({ customer, origin, dest }, opts.rateBody);
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: uuid('customer', customer) },
      requestedDate: today,
      vehicleTypeId: uuid('vehicleType', vt6),
      stops: [
        { type: 'PICKUP', siteId: uuid('site', origin) },
        { type: 'DELIVERY', siteId: uuid('site', dest) },
      ],
      lines: [
        {
          description: 'ปูนซีเมนต์',
          qty: '20',
          unitId: unitTon,
          weightKg: '20000',
          ...(opts.productId ? { productId: opts.productId } : {}),
        },
        { description: 'เหล็กเส้น', qty: '5', unitId: unitTon, weightKg: '5000' },
      ],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const soId = encodeId('salesOrder', so.id);
    if (opts.manualPrice)
      await api(app, admin)
        .post(`/v1/orders/${soId}/manual-price`)
        .send({ sellAmount: opts.manualPrice, reason: 'ลูกค้าตกลงราคาเหมาทางโทรศัพท์' })
        .expect(200);
    let [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    if (!d) {
      await run((tx) => app.get(DeliveryOrderService).createFromOrder(so.id, {}, tx));
      [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    }
    const doId = encodeId('deliveryOrder', d!.id);
    const vid = (await newVehicle()).id;
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [doId], vehicleId: vid })
        .expect(201)
    ).body;
    const r = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: vid, dispatch: true });
    if (r.status !== 200)
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: vid,
          dispatch: true,
          ruleKeys: r.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบตีกลับ',
        })
        .expect(200);
    const full = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    const [pickup, drop] = [...full.stops].sort(
      (a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence,
    );
    await post(pickup.id, 'arrive', 60).expect(201);
    await post(pickup.id, 'complete', 55, { outcome: 'DELIVERED' }).expect(201);
    await post(drop.id, 'arrive', 20).expect(201);
    if (opts.fail) {
      const rsn = await db.reasonCode.findFirstOrThrow({
        where: { tenantId, category: 'DELIVERY_FAILED', code: 'SHOP_CLOSED' },
      });
      await post(drop.id, 'fail', 10, {
        outcome: 'FAILED',
        reasonCodeId: encodeId('reasonCode', rsn.id),
        note: 'ร้านปิด',
      }).expect(201);
    } else await post(drop.id, 'complete', 10, { outcome: 'DELIVERED' }).expect(201);
    return { doId, uuid: d!.id, soId };
  };

  const reason = async (category: string, code: string) =>
    encodeId(
      'reasonCode',
      (
        await db.reasonCode.findFirstOrThrow({
          where: { tenantId, category: category as never, code },
        })
      ).id,
    );
  const doc = async (kind: string, mime = 'image/jpeg') =>
    encodeId(
      'document',
      (
        await db.storedDocument.create({
          data: {
            tenantId,
            status: 'READY',
            kind,
            mimeType: mime,
            sizeBytes: 1234,
            filename: `${kind.toLowerCase()}-${++seed}.jpg`,
            createdBy: 'user-test',
            fileKey: `k/${seed}`,
            sha256: 'x'.repeat(64),
          },
        })
      ).id,
    );
  const putPod = (doId: string, body: object, token = admin) =>
    api(app, token).put(`/v1/delivery-orders/${doId}/pod`).send(body);
  const billing = async (soId: string) =>
    (await api(app, admin).get(`/v1/orders/${soId}`).expect(200)).body.sellBilling;

  /** ส่งแล้ว + หลักฐานส่ง: บรรทัด 1 ส่งได้ `actual` จาก 20 (ปฏิเสธ SHORT_QTY) */
  const rejected = async (actual = '10', opts: Parameters<typeof delivered>[0] = {}) => {
    const d = await delivered({ podRequirements: { success: { fields: [] } }, ...opts });
    const short = await reason('REJECTED_BY_RECEIVER', 'SHORT_QTY');
    const photo = await doc('POD_PHOTO');
    await putPod(d.doId, {
      photoDocumentIds: [photo],
      lines: [{ lineNo: 1, qtyActual: actual, rejectReasonCodeId: short }],
    })
      .set('If-Match', '"0"')
      .expect(200);
    return { ...d, short, photo };
  };
  const redeliver = (doId: string, body: object, token = admin) =>
    api(app, token).post(`/v1/delivery-orders/${doId}/redeliver`).send(body);
  const ret = (doId: string, body: object, token = admin) =>
    api(app, token).post(`/v1/delivery-orders/${doId}/return`).send(body);
  const soStatus = async (soId: string) =>
    (await db.salesOrder.findUniqueOrThrow({ where: { id: uuid('salesOrder', soId) } })).status;
  const errs = (r: { body: { errors?: { field: string; code: string }[] } }) =>
    (r.body.errors ?? []).map((e) => `${e.field}:${e.code}`);

  it('เกณฑ์ตรวจรับ: ปฏิเสธ 10 → ส่งซ้ำ → DO ใหม่ 10 อ้างใบเดิม · ใบเดิมคงส่งแล้ว · SO ส่งบางส่วน · จัดสรรไม่เกิน', async () => {
    const d = await rejected('10');
    expect(await soStatus(d.soId)).toBe('DELIVERED');
    const before = await api(app, admin).get(`/v1/delivery-orders/${d.doId}`).expect(200);
    expect(before.body.lines[0]).toMatchObject({
      rejectQty: '10',
      redeliveredQty: '0',
      returnedQty: '0',
      openRejectQty: '10',
    });
    const r = await redeliver(d.doId, { reasonCodeId: d.short })
      .set('If-Match', before.headers.etag!)
      .expect(200);
    expect(r.body.source).toMatchObject({ id: d.doId, status: 'UNBILLED' });
    expect(r.body.source.version).toBe(before.body.version + 1);
    expect(r.body.source.lines[0]).toMatchObject({
      qtyActual: '10',
      redeliveredQty: '10',
      openRejectQty: '0',
    });
    expect(r.body.redelivery).toMatchObject({
      status: 'DRAFT',
      tripId: null,
      redeliveryOfId: d.doId,
      rejectedFromId: d.doId,
      redeliveryManual: true,
      rescheduleCount: 0,
      doDate: today,
      weightKg: '10000',
    });
    expect(r.body.redelivery.lines).toEqual([
      expect.objectContaining({
        soLineNo: 1,
        qtyPlanned: '10',
        weightKg: '10000',
        qtyActual: null,
      }),
    ]);
    // SO: ส่งครบ → ส่งบางส่วน (reopen) · ปริมาณจัดสรรไม่เกินที่สั่ง (ใบส่งซ้ำไม่นับ)
    expect(await soStatus(d.soId)).toBe('PARTIALLY_DELIVERED');
    const alloc = await run((tx) =>
      app.get(DeliveryOrderService).allocation(uuid('salesOrder', d.soId), tx),
    );
    expect(alloc.map((a) => a.remaining)).toEqual(['0', '0']);
    // audit + ประวัติ SO มีเหตุผล
    const audit = await db.auditLog.findFirstOrThrow({
      where: { tenantId, action: 'delivery_order.rejected_redelivered', entityId: d.uuid },
    });
    expect(audit.reason).toBe('จำนวนไม่ครบ');
    const h = await db.docStatusHistory.findFirstOrThrow({
      where: { docType: 'sales_order', docId: uuid('salesOrder', d.soId), event: 'reopen' },
    });
    expect(h.note).toContain(r.body.redelivery.doNo);
    // ลงกล่อง SO รอจัดของกระดาน (SO ส่งบางส่วนยังลงเที่ยวได้)
    const pool = (await api(app, admin).get(`/v1/planning/board?date=${today}`).expect(200)).body;
    expect(JSON.stringify(pool)).toContain(r.body.redelivery.doNo);
  });

  it('กดซ้ำ: If-Match เดิม → 412 · ไม่ส่ง If-Match → 422 nothing_open · ไม่สร้าง DO ซ้ำ', async () => {
    const d = await rejected('10');
    const g = await api(app, admin).get(`/v1/delivery-orders/${d.doId}`).expect(200);
    await redeliver(d.doId, { reasonCodeId: d.short }).set('If-Match', g.headers.etag!).expect(200);
    await redeliver(d.doId, { reasonCodeId: d.short }).set('If-Match', g.headers.etag!).expect(412);
    const again = await redeliver(d.doId, { reasonCodeId: d.short }).expect(422);
    expect(errs(again)).toEqual(['lines:nothing_open']);
    expect(await ret(d.doId, { reasonCodeId: d.short }).expect(422)).toBeTruthy();
    expect(await db.deliveryOrder.count({ where: { rejectedFromId: d.uuid } })).toBe(1);
  });

  it('บางส่วน: ส่งซ้ำ 4 + คืนคลัง 6 · เกินคงเหลือ → 422 · แก้หลักฐานให้ปฏิเสธน้อยกว่าที่จัดการ → 422 · ยกเลิกใบส่งซ้ำ → คืนยอด', async () => {
    const d = await rejected('10');
    const over = await redeliver(d.doId, {
      reasonCodeId: d.short,
      lines: [{ lineNo: 1, qty: '10.001' }],
    }).expect(422);
    expect(errs(over)).toEqual(['lines.0.qty:exceeds_open']);
    expect(
      errs(
        await redeliver(d.doId, {
          reasonCodeId: d.short,
          lines: [{ lineNo: 2, qty: '1' }],
        }).expect(422),
      ),
    ).toEqual(['lines.0.qty:exceeds_open']);
    expect(
      errs(
        await redeliver(d.doId, { reasonCodeId: d.short, lines: [{ lineNo: 9, qty: '1' }] }).expect(
          422,
        ),
      ),
    ).toEqual(['lines.0.lineNo:unknown_line']);
    const r = await redeliver(d.doId, {
      reasonCodeId: d.short,
      lines: [{ lineNo: 1, qty: '4' }],
      note: 'ลูกค้ารับเพิ่มรอบหน้า',
    }).expect(200);
    expect(r.body.redelivery.lines).toEqual([
      expect.objectContaining({ qtyPlanned: '4', weightKg: '4000' }),
    ]);
    expect(r.body.source.lines[0]).toMatchObject({ redeliveredQty: '4', openRejectQty: '6' });
    // คืนคลังที่เหลือ (ไม่ส่ง lines = ทั้งหมดที่คงเหลือ)
    const back = await ret(d.doId, {
      reasonCodeId: d.short,
      note: 'กล่องบุบ คืนคลังต้นทาง',
    }).expect(200);
    expect(back.body.status).toBe('UNBILLED');
    expect(back.body.lines[0]).toMatchObject({ returnedQty: '6', openRejectQty: '0' });
    const a = await db.auditLog.findFirstOrThrow({
      where: { tenantId, action: 'delivery_order.rejected_returned', entityId: d.uuid },
    });
    expect(a.reason).toBe('จำนวนไม่ครบ — กล่องบุบ คืนคลังต้นทาง');
    // แก้หลักฐานให้ปฏิเสธเหลือ 5 (< ส่งซ้ำ 4 + คืน 6) → 422
    const amend = await putPod(d.doId, {
      photoDocumentIds: [d.photo],
      lines: [{ lineNo: 1, qtyActual: '15', rejectReasonCodeId: d.short }],
      reason: 'ลูกค้ายืนยันยอดรับใหม่ทางโทรศัพท์',
    })
      .set('If-Match', '"1"')
      .expect(422);
    expect(errs(amend)).toEqual(['lines.0.qtyActual:reject_resolved']);
    // ยกเลิกใบส่งซ้ำ → ยอด 4 กลับมารอจัดการ
    await api(app, admin)
      .post(`/v1/delivery-orders/${r.body.redelivery.id}/cancel`)
      .send({ reason: 'ลูกค้าไม่ต้องการแล้ว ขอคืนคลัง' })
      .expect(200);
    const g = await api(app, admin).get(`/v1/delivery-orders/${d.doId}`).expect(200);
    expect(g.body.lines[0]).toMatchObject({
      redeliveredQty: '0',
      returnedQty: '6',
      openRejectQty: '4',
    });
    expect(await soStatus(d.soId)).toBe('DELIVERED');
    // CHECK ฐานข้อมูล: คืนคลังเกินที่ปฏิเสธไม่ได้
    await expect(
      db.deliveryOrderLine.updateMany({
        where: { deliveryOrderId: d.uuid, lineNo: 1 },
        data: { returnedQty: '11' },
      }),
    ).rejects.toThrow();
  });

  it('ส่งซ้ำแล้วจัดรถ → ส่งถึง → SO ส่งครบ', async () => {
    const d = await rejected('10');
    const r = await redeliver(d.doId, { reasonCodeId: d.short }).expect(200);
    const vid = (await newVehicle()).id;
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [r.body.redelivery.id], vehicleId: vid })
        .expect(201)
    ).body;
    const a = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: vid, dispatch: true });
    if (a.status !== 200)
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: vid,
          dispatch: true,
          ruleKeys: a.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบส่งซ้ำของที่ตีกลับ',
        })
        .expect(200);
    expect(await soStatus(d.soId)).toBe('IN_TRANSIT');
    const full = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    const [pickup, drop] = [...full.stops].sort(
      (x: { sequence: number }, y: { sequence: number }) => x.sequence - y.sequence,
    );
    await post(pickup.id, 'arrive', 9).expect(201);
    await post(pickup.id, 'complete', 8, { outcome: 'DELIVERED' }).expect(201);
    await post(drop.id, 'arrive', 5).expect(201);
    await post(drop.id, 'complete', 4, { outcome: 'DELIVERED' }).expect(201);
    expect(await soStatus(d.soId)).toBe('DELIVERED');
    // ไทม์ไลน์เที่ยวเดิม: ใต้จุดส่ง "ส่งซ้ำ" (มือ)
    const old = await db.deliveryOrder.findUniqueOrThrow({ where: { id: d.uuid } });
    const ot = (
      await api(app, admin)
        .get(`/v1/trips/${encodeId('trip', old.tripId!)}`)
        .expect(200)
    ).body;
    const res = ot.stops.flatMap((s: { reschedules: object[] }) => s.reschedules);
    expect(res).toEqual([
      expect.objectContaining({
        fromDoNo: old.doNo,
        doNo: r.body.redelivery.doNo,
        manual: true,
        attempt: 0,
      }),
    ]);
  });

  it('ส่งไม่สำเร็จทั้งใบ: ส่งซ้ำ = ใบเดิม CANCELLED + DO ใหม่ทั้งใบ (มือ) · คืนคลัง = RETURNED · ผิดหมวด/ส่ง lines → 422', async () => {
    const plain = await db.reasonCode.create({
      data: {
        tenantId,
        category: 'DELIVERY_FAILED',
        code: `T11_${++seed}`,
        labelTh: 'ลูกค้าขอเลื่อนรับสินค้า',
      },
    });
    const fr = encodeId('reasonCode', plain.id);
    const f = await delivered({ fail: true });
    // SHOP_CLOSED ติ๊กนัดส่งใหม่อัตโนมัติ → ใบเดิมถูกส่งใหม่แล้ว → 409
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: f.uuid } })).status).toBe(
      'CANCELLED',
    );
    await redeliver(f.doId, { reasonCodeId: fr }).expect(409);
    // ทำให้ไม่นัดอัตโนมัติ: ปิดธงของ SHOP_CLOSED ชั่วคราว
    await db.reasonCode.updateMany({
      where: { tenantId, category: 'DELIVERY_FAILED', code: 'SHOP_CLOSED' },
      data: { autoReschedule: false },
    });
    try {
      const g = await delivered({ fail: true });
      expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: g.uuid } })).status).toBe(
        'FAILED',
      );
      expect(
        errs(
          await redeliver(g.doId, { reasonCodeId: fr, lines: [{ lineNo: 1, qty: '1' }] }).expect(
            422,
          ),
        ),
      ).toEqual(['lines:not_applicable']);
      expect(
        errs(
          await redeliver(g.doId, {
            reasonCodeId: await reason('REJECTED_BY_RECEIVER', 'SHORT_QTY'),
          }).expect(422),
        ),
      ).toEqual(['reasonCodeId:reason_category']);
      await redeliver(g.doId, { reasonCodeId: fr, doDate: '2020-01-01' }).expect(422);
      const r = await redeliver(g.doId, { reasonCodeId: fr }).expect(200);
      expect(r.body.source.status).toBe('CANCELLED');
      expect(r.body.redelivery).toMatchObject({
        status: 'DRAFT',
        redeliveryOfId: g.doId,
        rejectedFromId: null,
        redeliveryManual: true,
      });
      expect(r.body.redelivery.lines.map((l: { qtyPlanned: string }) => l.qtyPlanned)).toEqual([
        '20',
        '5',
      ]);
      // ใบสั่งกลับรอจัด (RECEIVED) แล้วประเมินใบค้างใหม่ (ไม่มี rate → ค้าง)
      expect(['RECEIVED', 'ON_HOLD']).toContain(await soStatus(g.soId));
      // T12: ใบส่งซ้ำมือไม่ถูกคืนเองเมื่อผลถูกพลิก
      const restored = await run((tx) =>
        app.get(DeliveryOrderService).restoreRedelivered(tx, g.uuid, 'ทดสอบคืน'),
      );
      expect(restored).toBe(false);
      await redeliver(g.doId, { reasonCodeId: fr }).expect(409);

      // คืนคลัง
      const h = await delivered({ fail: true });
      const back = await ret(h.doId, { reasonCodeId: fr }).expect(200);
      expect(back.body.status).toBe('RETURNED');
      const hist = await db.docStatusHistory.findFirstOrThrow({
        where: { docType: 'delivery_order', docId: h.uuid, event: 'return' },
      });
      expect(hist.reasonCodeId).toBe(plain.id);
      await db.auditLog.findFirstOrThrow({
        where: { tenantId, action: 'delivery_order.returned', entityId: h.uuid },
      });
      await ret(h.doId, { reasonCodeId: fr }).expect(409);
      await redeliver(h.doId, { reasonCodeId: fr }).expect(409);
    } finally {
      await db.reasonCode.updateMany({
        where: { tenantId, category: 'DELIVERY_FAILED', code: 'SHOP_CLOSED' },
        data: { autoReschedule: true },
      });
    }
  });

  it('สถานะ/สิทธิ์/แยก tenant/ธงเหตุผล: DRAFT → 409 · ไม่มีปฏิเสธ → 422 · ไม่มี orders:write → 403 · tenant อื่น → 404 · บังคับโน้ต/รูป', async () => {
    const d = await rejected('10');
    const dispatcher = await tokenFor(tenantId, 'orders:read trips:read trips:dispatch');
    await redeliver(d.doId, { reasonCodeId: d.short }, dispatcher).expect(403);
    await ret(d.doId, { reasonCodeId: d.short }, dispatcher).expect(403);
    await redeliver(d.doId, { reasonCodeId: d.short }, other).expect(404);
    await ret(d.doId, { reasonCodeId: d.short }, other).expect(404);
    // PARTIAL_REFUSED บังคับโน้ต
    const partial = await reason('REJECTED_BY_RECEIVER', 'PARTIAL_REFUSED');
    expect(errs(await redeliver(d.doId, { reasonCodeId: partial }).expect(422))).toEqual([
      'note:note_required',
    ]);
    // ชื่อเหตุผล + โน้ต < 10 ตัวอักษร (MD-222)
    const tiny = await db.reasonCode.create({
      data: { tenantId, category: 'REJECTED_BY_RECEIVER', code: `T11S_${++seed}`, labelTh: 'บุบ' },
    });
    expect(
      errs(await redeliver(d.doId, { reasonCodeId: encodeId('reasonCode', tiny.id) }).expect(422)),
    ).toEqual(['note:too_short']);
    // ส่งครบไม่มีปฏิเสธ → nothing_open
    const ok = await delivered({ podRequirements: { success: { fields: [] } } });
    expect(errs(await redeliver(ok.doId, { reasonCodeId: d.short }).expect(422))).toEqual([
      'lines:nothing_open',
    ]);
    // เหตุผลบังคับรูป แต่หลักฐานส่งฉบับล่าสุดไม่มีรูป → 422 photo_required
    await putPod(d.doId, {
      photoDocumentIds: [],
      lines: [
        {
          lineNo: 1,
          qtyActual: '10',
          rejectReasonCodeId: encodeId('reasonCode', tiny.id),
        },
      ],
      reason: 'ลบรูปที่ถ่ายผิดออกจากหลักฐาน',
    })
      .set('If-Match', '"1"')
      .expect(200);
    expect(errs(await redeliver(d.doId, { reasonCodeId: d.short }).expect(422))).toEqual([
      'reasonCodeId:photo_required',
    ]);
    // DRAFT (ใบส่งซ้ำ) → 409
    const r = await redeliver(d.doId, {
      reasonCodeId: encodeId('reasonCode', tiny.id),
      note: 'กล่องบุบสองใบ',
    }).expect(200);
    await redeliver(r.body.redelivery.id, { reasonCodeId: d.short }).expect(409);
  });
});
