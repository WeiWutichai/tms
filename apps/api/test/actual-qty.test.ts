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
 * ST4-T10 Actual quantity + reject reason ต่อรายการ (docs/04 E2, docs/01 §3.3 / §5.3) — เกณฑ์ตรวจรับ:
 * ส่งจริงน้อยกว่าแผนโดยไม่เลือกเหตุผล → ถูกปฏิเสธ (422) · ลูกค้าที่ตั้ง "ตามยอดจริง" ได้ยอดเงินตามปริมาณส่งจริง
 * + ตรวจค่า, เหตุผลหมวด/ธง, ฉบับ/เหตุผล/If-Match หลัง UNBILLED, ราคาที่กำหนดเอง, ขั้นต่ำ, สูตรเหมาเที่ยว, CHECK ฐานข้อมูล
 */
describe('actual quantity + reject reason (ST4-T10)', () => {
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ยอดส่งจริง' })).id;
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
          overrideReason: 'ทดสอบยอดส่งจริง',
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

  it('เกณฑ์ตรวจรับ: ส่งจริงน้อยกว่าแผนโดยไม่เลือกเหตุผล → 422 reason_required · เลือกเหตุผล + รูป → บันทึก + ฉายลงบรรทัด DO', async () => {
    const d = await delivered();
    const photo = await doc('POD_PHOTO');
    const sig = await doc('POD_SIGNATURE', 'image/png');
    const r1 = await putPod(d.doId, {
      photoDocumentIds: [photo],
      signatureDocumentId: sig,
      lines: [{ lineNo: 1, qtyActual: '18' }],
    })
      .set('If-Match', '"0"')
      .expect(422);
    expect(r1.body.errors).toEqual([
      expect.objectContaining({ field: 'lines.0.rejectReasonCodeId', code: 'reason_required' }),
    ]);
    // ไม่มีอะไรถูกบันทึก
    expect(await db.deliveryOrderPod.count({ where: { deliveryOrderId: d.uuid } })).toBe(0);

    const short = await reason('REJECTED_BY_RECEIVER', 'SHORT_QTY');
    const ok = await putPod(d.doId, {
      photoDocumentIds: [photo],
      signatureDocumentId: sig,
      lines: [{ lineNo: 1, qtyActual: '18', rejectReasonCodeId: short }],
    })
      .set('If-Match', '"0"')
      .expect(200);
    expect(ok.body.doStatus).toBe('UNBILLED');
    expect(ok.body.lines).toEqual([
      {
        lineNo: 1,
        description: 'ปูนซีเมนต์',
        unit: expect.any(String),
        qtyPlanned: '20',
        qtyActual: '18',
        rejectQty: '2',
        rejectReason: { id: short, code: 'SHORT_QTY', label: 'จำนวนไม่ครบ' },
        note: null,
      },
      expect.objectContaining({ lineNo: 2, qtyPlanned: '5', qtyActual: null, rejectReason: null }),
    ]);
    const lines = await db.deliveryOrderLine.findMany({
      where: { deliveryOrderId: d.uuid },
      orderBy: { lineNo: 'asc' },
    });
    expect(lines.map((l) => [l.qtyActual?.toFixed(), l.rejectQty?.toFixed()])).toEqual([
      ['18', '2'],
      [undefined, undefined],
    ]);
    expect(lines[0]!.rejectReasonCodeId).toBe(uuid('reasonCode', short));
    const g = await api(app, admin).get(`/v1/delivery-orders/${d.doId}`).expect(200);
    expect(g.body.lines[0]).toMatchObject({
      qtyActual: '18',
      rejectQty: '2',
      rejectReasonCodeId: short,
    });
    // แก้ข้อความเหตุผลใน master ภายหลัง → หลักฐานยังแสดงข้อความเดิม (snapshot)
    await db.reasonCode.update({
      where: { id: uuid('reasonCode', short) },
      data: { labelTh: 'ของขาด (แก้แล้ว)' },
    });
    const v = await api(app, admin).get(`/v1/delivery-orders/${d.doId}/pod`).expect(200);
    expect(v.body.lines[0].rejectReason.label).toBe('จำนวนไม่ครบ');
    await db.reasonCode.update({
      where: { id: uuid('reasonCode', short) },
      data: { labelTh: 'จำนวนไม่ครบ' },
    });
  });

  it('ตรวจค่า: เกินแผน / บรรทัดไม่มี / เหตุผลผิดหมวด / บังคับโน้ต / บังคับรูป / ครบแต่ส่งเหตุผล / DO ส่งไม่สำเร็จ', async () => {
    const d = await delivered({ podRequirements: { success: { fields: [] } } });
    const short = await reason('REJECTED_BY_RECEIVER', 'SHORT_QTY');
    const partial = await reason('REJECTED_BY_RECEIVER', 'PARTIAL_REFUSED');
    const failed = await reason('DELIVERY_FAILED', 'SHOP_CLOSED');
    const codes = async (lines: object[], extra: object = {}) =>
      (await putPod(d.doId, { lines, ...extra }).expect(422)).body.errors.map(
        (e: { field: string; code: string }) => `${e.field}:${e.code}`,
      );
    expect(await codes([{ lineNo: 1, qtyActual: '20.001' }])).toEqual([
      'lines.0.qtyActual:exceeds_planned',
    ]);
    expect(await codes([{ lineNo: 9, qtyActual: '1' }])).toEqual(['lines.0.lineNo:unknown_line']);
    expect(await codes([{ lineNo: 1, qtyActual: '20', rejectReasonCodeId: short }])).toEqual([
      'lines.0.rejectReasonCodeId:reason_not_applicable',
    ]);
    expect(
      await codes([{ lineNo: 1, qtyActual: '19', rejectQty: '2', rejectReasonCodeId: short }]),
    ).toEqual(['lines.0.rejectQty:reject_qty_mismatch']);
    expect(await codes([{ lineNo: 1, qtyActual: '19', rejectReasonCodeId: failed }])).toEqual([
      'lines.0.rejectReasonCodeId:reason_category',
    ]);
    // PARTIAL_REFUSED บังคับรูป + โน้ต
    expect(await codes([{ lineNo: 2, qtyActual: '4', rejectReasonCodeId: partial }])).toEqual([
      'lines.0.note:note_required',
      'photoDocumentIds:photo_required',
    ]);
    // ทศนิยมเกิน 3 ตำแหน่ง → DTO
    await putPod(d.doId, { lines: [{ lineNo: 1, qtyActual: '1.0001' }] }).expect(422);
    expect(await db.deliveryOrderPod.count({ where: { deliveryOrderId: d.uuid } })).toBe(0);

    // DO ส่งไม่สำเร็จ → ยอดส่งจริงไม่ใช้กับชุดไม่สำเร็จ
    const f = await delivered({ fail: true, podRequirements: { failure: { fields: [] } } });
    const nf = await putPod(f.doId, { lines: [{ lineNo: 1, qtyActual: '20' }] }).expect(422);
    expect(nf.body.errors).toEqual([
      expect.objectContaining({ field: 'lines', code: 'not_applicable' }),
    ]);
  });

  it('แก้หลัง UNBILLED = ฉบับใหม่ + เหตุผล + If-Match (412 เมื่อเก่า) · บรรทัดที่ไม่ส่ง = คงเดิม · audit มีบรรทัด', async () => {
    const d = await delivered({ podRequirements: { success: { fields: [] } } });
    const short = await reason('REJECTED_BY_RECEIVER', 'SHORT_QTY');
    const photo = await doc('POD_PHOTO');
    await putPod(d.doId, {
      photoDocumentIds: [photo],
      lines: [{ lineNo: 1, qtyActual: '15', rejectReasonCodeId: short }],
    })
      .set('If-Match', '"0"')
      .expect(200);
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: d.uuid } })).status).toBe(
      'UNBILLED',
    );
    // ไม่มีเหตุผลการแก้ → 422 · If-Match เก่า → 412
    await putPod(d.doId, { photoDocumentIds: [photo], lines: [{ lineNo: 2, qtyActual: '5' }] })
      .set('If-Match', '"1"')
      .expect(422);
    await putPod(d.doId, {
      photoDocumentIds: [photo],
      lines: [{ lineNo: 2, qtyActual: '5' }],
      reason: 'ยืนยันยอดบรรทัดที่สองกับลูกค้าแล้ว',
    })
      .set('If-Match', '"0"')
      .expect(412);
    const v2 = await putPod(d.doId, {
      photoDocumentIds: [photo],
      lines: [{ lineNo: 2, qtyActual: '5' }],
      reason: 'ยืนยันยอดบรรทัดที่สองกับลูกค้าแล้ว',
    })
      .set('If-Match', '"1"')
      .expect(200);
    expect(v2.body.lines.map((l: { qtyActual: string | null }) => l.qtyActual)).toEqual([
      '15',
      '5',
    ]);
    // ไม่ส่ง lines เลย = คงค่าเดิม
    const v3 = await putPod(d.doId, {
      photoDocumentIds: [photo],
      receiverName: 'สมชาย',
      reason: 'เพิ่มชื่อผู้รับตามใบส่งของ',
    })
      .set('If-Match', '"2"')
      .expect(200);
    expect(v3.body.lines[0]).toMatchObject({ qtyActual: '15', rejectQty: '5' });
    // ส่งครบกลับ (แก้ตัวเลขผิด) → ปฏิเสธ 0 ไม่มีเหตุผล
    await putPod(d.doId, {
      photoDocumentIds: [photo],
      lines: [{ lineNo: 1, qtyActual: '20' }],
      reason: 'กรอกตัวเลขผิด ลูกค้ารับครบ',
    })
      .set('If-Match', '"3"')
      .expect(200);
    const l1 = await db.deliveryOrderLine.findFirstOrThrow({
      where: { deliveryOrderId: d.uuid, lineNo: 1 },
    });
    expect([l1.qtyActual?.toFixed(), l1.rejectQty?.toFixed(), l1.rejectReasonCodeId]).toEqual([
      '20',
      '0',
      null,
    ]);
    const audits = await db.auditLog.findMany({
      where: { entityId: d.uuid, action: { startsWith: 'pod.' } },
      orderBy: { seq: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([
      'pod.recorded',
      'pod.amended',
      'pod.amended',
      'pod.amended',
    ]);
    expect((audits[1]!.after as { lines: unknown[] }).lines).toEqual([
      expect.objectContaining({ lineNo: 1, qtyActual: '15', reason: 'SHORT_QTY' }),
      expect.objectContaining({ lineNo: 2, qtyActual: '5', reason: null }),
    ]);
    // ฉบับเก่ายังอยู่ครบ (append-only)
    expect(await db.deliveryOrderPod.count({ where: { deliveryOrderId: d.uuid } })).toBe(4);
  });

  it('เกณฑ์ตรวจรับ: ลูกค้า "ตามยอดจริง" (ต่อตัน 350) ได้ยอดตามปริมาณส่งจริง · ลูกค้าตามใบสั่งได้ยอดเดิม', async () => {
    const short = await reason('REJECTED_BY_RECEIVER', 'SHORT_QTY');
    const photo = () => doc('POD_PHOTO');
    const cfg = { success: { fields: [] } };
    const act = await delivered({
      byActual: true,
      podRequirements: cfg,
      rateBody: { pricingModel: 'PER_TON', sellRate: '350' },
    });
    // ก่อนบันทึก: ยอดตามใบสั่ง 25 ตัน × 350
    expect(await billing(act.soId)).toMatchObject({
      basis: 'ACTUAL',
      status: 'NOT_RECORDED',
      sellPlannedTotal: '8750.00',
      sellBillableTotal: '8750.00',
    });
    await putPod(act.doId, {
      photoDocumentIds: [await photo()],
      lines: [{ lineNo: 1, qtyActual: '17.5', rejectReasonCodeId: short }],
    }).expect(200);
    const b = await billing(act.soId);
    expect(b).toMatchObject({
      basis: 'ACTUAL',
      status: 'ACTUAL',
      actualRecorded: true,
      sellPlannedTotal: '8750.00',
      sellBillableTotal: '7875.00', // (17.5 + 5) × 350
    });
    expect(b.charges[0]).toMatchObject({
      kind: 'FREIGHT',
      qtyPlanned: '25',
      qty: '22.5',
      sellUnitPrice: '350.00',
      sellPlannedAmount: '8750.00',
      sellAmount: '7875.00',
      adjusted: true,
      note: null,
    });
    // ภาษีตาม snapshot ของบรรทัด (ไม่เปลี่ยน)
    const so = await api(app, admin).get(`/v1/orders/${act.soId}`).expect(200);
    expect(b.charges[0].vatType).toBe(so.body.sellCharges[0].vatType);
    expect(b.charges[0].whtRate).toBe(so.body.sellCharges[0].whtRate);
    // ยอดใน SO (ใบสั่ง) ไม่ถูกแก้
    expect(so.body.sellTotal).toBe('8750.00');

    const plan = await delivered({
      byActual: false,
      podRequirements: cfg,
      rateBody: { pricingModel: 'PER_TON', sellRate: '350' },
    });
    await putPod(plan.doId, {
      photoDocumentIds: [await photo()],
      lines: [{ lineNo: 1, qtyActual: '17.5', rejectReasonCodeId: short }],
    }).expect(200);
    expect(await billing(plan.soId)).toMatchObject({
      basis: 'PLANNED',
      status: 'PLANNED',
      sellBillableTotal: '8750.00',
    });

    // เปลี่ยนตั้งค่าลูกค้า → คำนวณใหม่ตอนอ่าน (ไม่เก็บยอด)
    const cust = (await api(app, admin).get(`/v1/orders/${plan.soId}`).expect(200)).body.customer
      .id as string;
    const c = await api(app, admin).get(`/v1/customers/${cust}`).expect(200);
    expect(c.body.billByActualQty).toBe(false);
    await api(app, admin)
      .patch(`/v1/customers/${cust}`)
      .set('If-Match', `"${c.body.version}"`)
      .send({ billByActualQty: true })
      .expect(200);
    expect((await billing(plan.soId)).sellBillableTotal).toBe('7875.00');
  });

  it('ขั้นต่ำของ rate ยังใช้ · เหมาเที่ยวไม่เปลี่ยน · ส่งได้ 0 ทั้งหมด = คิดไม่ได้ (null)', async () => {
    const short = await reason('REJECTED_BY_RECEIVER', 'SHORT_QTY');
    const cfg = { success: { fields: [] } };
    const min = await delivered({
      byActual: true,
      podRequirements: cfg,
      rateBody: { pricingModel: 'PER_TON', sellRate: '350', sellMinCharge: '8000' },
    });
    await putPod(min.doId, {
      photoDocumentIds: [await doc('POD_PHOTO')],
      lines: [{ lineNo: 1, qtyActual: '10', rejectReasonCodeId: short }],
    }).expect(200);
    const bm = await billing(min.soId);
    expect(bm.charges[0]).toMatchObject({ sellAmount: '8000.00', minChargeApplied: true });
    expect(bm.sellBillableTotal).toBe('8000.00');

    const trip = await delivered({
      byActual: true,
      podRequirements: cfg,
      rateBody: { pricingModel: 'PER_TRIP', sellRate: '4500' },
    });
    await putPod(trip.doId, {
      photoDocumentIds: [await doc('POD_PHOTO')],
      lines: [{ lineNo: 1, qtyActual: '10', rejectReasonCodeId: short }],
    }).expect(200);
    const bt = await billing(trip.soId);
    expect(bt).toMatchObject({ status: 'ACTUAL', sellBillableTotal: '4500.00' });
    expect(bt.charges[0]).toMatchObject({ note: 'NOT_QTY_BASED', adjusted: false });

    const zero = await delivered({
      byActual: true,
      podRequirements: cfg,
      rateBody: { pricingModel: 'PER_TON', sellRate: '350' },
    });
    await putPod(zero.doId, {
      photoDocumentIds: [await doc('POD_PHOTO')],
      lines: [
        { lineNo: 1, qtyActual: '0', rejectReasonCodeId: short },
        { lineNo: 2, qtyActual: '0', rejectReasonCodeId: short },
      ],
    }).expect(200);
    const bz = await billing(zero.soId);
    expect(bz).toMatchObject({ status: 'CALCULATION_FAILURE', sellBillableTotal: null });
    expect(bz.reasons.map((r: { code: string }) => r.code)).toEqual(['QUANTITY_INVALID']);
  });

  it('ราคาที่กำหนดเอง (MANUAL) ชนะ — ยอดเหมาไม่เปลี่ยนตามยอดส่งจริง', async () => {
    const short = await reason('REJECTED_BY_RECEIVER', 'SHORT_QTY');
    const d = await delivered({
      byActual: true,
      manualPrice: '5000',
      podRequirements: { success: { fields: [] } },
    });
    await putPod(d.doId, {
      photoDocumentIds: [await doc('POD_PHOTO')],
      lines: [{ lineNo: 1, qtyActual: '10', rejectReasonCodeId: short }],
    }).expect(200);
    const b = await billing(d.soId);
    expect(b).toMatchObject({ status: 'ACTUAL', sellBillableTotal: '5000.00' });
    expect(b.charges).toEqual([
      expect.objectContaining({ origin: 'MANUAL', note: 'MANUAL_PRICE', sellAmount: '5000.00' }),
    ]);
  });

  it('ยอดวางบิลเป็นราคาขาย: ผู้ไม่มี prices.sell:read ไม่เห็น · บริษัทอื่น 404 · CHECK ฐานข้อมูลกันค่าขัดกัน', async () => {
    const d = await delivered({
      byActual: true,
      rateBody: { pricingModel: 'PER_TON', sellRate: '350' },
    });
    const ops = await tokenFor(tenantId, 'orders:read trips:read');
    const r = await api(app, ops).get(`/v1/orders/${d.soId}`).expect(200);
    expect(r.body.sellBilling).toBeUndefined();
    expect(r.body.sellTotal).toBeUndefined();
    await api(app, other).get(`/v1/orders/${d.soId}`).expect(404);
    await api(app, other).get(`/v1/delivery-orders/${d.doId}/pod`).expect(404);
    await putPod(d.doId, { lines: [{ lineNo: 1, qtyActual: '1' }] }, other).expect(404);

    const line = await db.deliveryOrderLine.findFirstOrThrow({
      where: { deliveryOrderId: d.uuid, lineNo: 1 },
    });
    await expect(
      db.deliveryOrderLine.update({ where: { id: line.id }, data: { qtyActual: '25' } }),
    ).rejects.toThrow(/qty_actual_range/);
    await expect(
      db.deliveryOrderLine.update({
        where: { id: line.id },
        data: { qtyActual: '15', rejectQty: '5' },
      }),
    ).rejects.toThrow(/reject_reason_required/);
    await expect(
      db.deliveryOrderLine.update({
        where: { id: line.id },
        data: { qtyActual: '15', rejectQty: '4' },
      }),
    ).rejects.toThrow(/reject_qty_consistent/);
  });

  it('review/QA: สินค้าถูกลบแบบ soft ภายหลัง → GET ใบสั่งยังได้ 200 และยอดประมาณคิดได้ (preview)', async () => {
    const product = (
      await api(app, admin)
        .post('/v1/products')
        .send({ name: `ปูนผง ${++seed}`, unitId: encodeId('unit', unitTon), weightPerUnitKg: 1000 })
        .expect(201)
    ).body.id as string;
    const d = await delivered({
      byActual: true,
      productId: uuid('product', product),
      podRequirements: { success: { fields: [] } },
      rateBody: { pricingModel: 'PER_TON', sellRate: '350' },
    });
    const short = await reason('REJECTED_BY_RECEIVER', 'SHORT_QTY');
    await putPod(d.doId, {
      photoDocumentIds: [await doc('POD_PHOTO')],
      lines: [{ lineNo: 1, qtyActual: '18', rejectReasonCodeId: short }],
    }).expect(200);
    await db.product.update({
      where: { id: uuid('product', product) },
      data: { deletedAt: new Date() },
    });
    const b = await billing(d.soId);
    expect(b).toMatchObject({ preview: true, status: 'ACTUAL', sellBillableTotal: '8050.00' });
    expect(b.charges[0]).toMatchObject({ qty: '23', qtyUnit: 'ตัน' });
  });

  it('review L: ส่งบรรทัดเดิมซ้ำ (เหตุผลเดิมถูกปิดใช้ภายหลัง) ไม่ล้ม · เปลี่ยนเป็นเหตุผลที่ปิดใช้ → 422 reason_inactive', async () => {
    const d = await delivered({ podRequirements: { success: { fields: [] } } });
    const wrong = await reason('REJECTED_BY_RECEIVER', 'WRONG_ITEM');
    const dmg = await reason('REJECTED_BY_RECEIVER', 'DAMAGED');
    const photo = await doc('POD_PHOTO');
    await putPod(d.doId, {
      photoDocumentIds: [photo],
      lines: [{ lineNo: 1, qtyActual: '19', rejectReasonCodeId: wrong, note: 'ผิดรุ่น' }],
    })
      .set('If-Match', '"0"')
      .expect(200);
    for (const id of [wrong, dmg])
      await db.reasonCode.update({
        where: { id: uuid('reasonCode', id) },
        data: { status: 'INACTIVE' },
      });
    try {
      await putPod(d.doId, {
        photoDocumentIds: [photo],
        lines: [{ lineNo: 1, qtyActual: '18', rejectReasonCodeId: wrong, note: 'ผิดรุ่น' }],
        reason: 'แก้จำนวนที่ผู้รับปฏิเสธเพิ่ม',
      })
        .set('If-Match', '"1"')
        .expect(200);
      const r = await putPod(d.doId, {
        photoDocumentIds: [photo],
        lines: [{ lineNo: 1, qtyActual: '18', rejectReasonCodeId: dmg }],
        reason: 'เปลี่ยนเหตุผลเป็นสินค้าเสียหาย',
      })
        .set('If-Match', '"2"')
        .expect(422);
      expect(r.body.errors[0]).toMatchObject({
        field: 'lines.0.rejectReasonCodeId',
        code: 'reason_inactive',
      });
    } finally {
      for (const id of [wrong, dmg])
        await db.reasonCode.update({
          where: { id: uuid('reasonCode', id) },
          data: { status: 'ACTIVE' },
        });
    }
  });

  it('review L: เปลี่ยน "วางบิลตามยอดส่งจริง" ต้องมี prices.sell:write (ไม่ใช่แค่ customers:write) + audit', async () => {
    const c = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า สิทธิ์ ${++seed}`, taxId: validTaxId(9600 + seed) })
        .expect(201)
    ).body;
    const ms = await tokenFor(tenantId, 'customers:read customers:write master:read master:write');
    const deny = await api(app, ms)
      .patch(`/v1/customers/${c.id}`)
      .set('If-Match', `"${c.version}"`)
      .send({ billByActualQty: true })
      .expect(403);
    expect(deny.body).toMatchObject({ code: 'permission_denied', required: ['prices.sell:write'] });
    await api(app, ms)
      .post('/v1/customers')
      .send({
        legalName: `ลูกค้า สิทธิ์ ${++seed}`,
        taxId: validTaxId(9600 + seed),
        billByActualQty: true,
      })
      .expect(403);
    // แก้ช่องอื่นได้ตามปกติ
    await api(app, ms)
      .patch(`/v1/customers/${c.id}`)
      .set('If-Match', `"${c.version}"`)
      .send({ creditTermDays: 45 })
      .expect(200);
    const ok = await api(app, admin)
      .patch(`/v1/customers/${c.id}`)
      .set('If-Match', `"${c.version + 1}"`)
      .send({ billByActualQty: true })
      .expect(200);
    expect(ok.body.billByActualQty).toBe(true);
    const a = await db.auditLog.findFirstOrThrow({
      where: { entityId: uuid('customer', c.id), action: 'customer.updated' },
      orderBy: { seq: 'desc' },
    });
    expect(a.before).toMatchObject({ billByActualQty: false });
    expect(a.after).toMatchObject({ billByActualQty: true });
  });
  it('ST5-T01b บรรทัดรายได้ต่อ DO: ตามยอดส่งจริง ก่อนบันทึก = แผน (provisional) → บันทึก = snapshot × ยอดจริง · เปลี่ยนเกณฑ์ลูกค้า → คิดใหม่ · ส่งได้ 0 = 0.00', async () => {
    const cfg = { success: { fields: [] } };
    const short = await reason('REJECTED_BY_RECEIVER', 'SHORT_QTY');
    const d = await delivered({
      byActual: true,
      podRequirements: cfg,
      rateBody: { pricingModel: 'PER_TON', sellRate: '350' },
    });
    const rev = async (doId: string) =>
      (await api(app, admin).get(`/v1/delivery-orders/${doId}/revenue-lines`).expect(200)).body;
    const before = await rev(d.doId);
    expect(before).toMatchObject({ sellRevenueTotal: '8750.00', provisional: true });
    expect(before.data[0]).toMatchObject({ sourceType: 'SO_CHARGE', qty: '25', provisional: true });
    await putPod(d.doId, {
      photoDocumentIds: [await doc('POD_PHOTO')],
      lines: [{ lineNo: 1, qtyActual: '10', rejectReasonCodeId: short }],
    }).expect(200);
    const after = await rev(d.doId);
    expect(after).toMatchObject({ sellRevenueTotal: '5250.00', provisional: false });
    expect(after.data).toHaveLength(1);
    expect(after.data[0]).toMatchObject({
      id: before.data[0].id,
      qty: '15',
      sellUnitPrice: '350.00',
      sellAmount: '5250.00',
      provisional: false,
    });
    // ยอดประมาณ (sellBilling) ตรงกับบรรทัดรายได้เมื่อมี DO เดียว
    expect((await billing(d.soId)).sellBillableTotal).toBe('5250.00');
    // เปลี่ยนลูกค้าเป็นวางบิลตามใบสั่ง → คิดใหม่ตามแผน 25 ตัน
    const so = await db.salesOrder.findUniqueOrThrow({ where: { id: uuid('salesOrder', d.soId) } });
    const cust = encodeId('customer', so.customerId!);
    const c = await api(app, admin).get(`/v1/customers/${cust}`).expect(200);
    await api(app, admin)
      .patch(`/v1/customers/${cust}`)
      .set('If-Match', `"${c.body.version}"`)
      .send({ billByActualQty: false })
      .expect(200);
    expect(await rev(d.doId)).toMatchObject({ sellRevenueTotal: '8750.00', provisional: false });

    // ส่งได้ 0 ทุกรายการ → 0.00 (ไม่คิดขั้นต่ำ — เหมือนคืนคลังทั้งหมด ST4-T11)
    const zero = await delivered({
      byActual: true,
      podRequirements: cfg,
      rateBody: { pricingModel: 'PER_TON', sellRate: '350', sellMinCharge: '1000' },
    });
    await putPod(zero.doId, {
      photoDocumentIds: [await doc('POD_PHOTO')],
      lines: [
        { lineNo: 1, qtyActual: '0', rejectReasonCodeId: short },
        { lineNo: 2, qtyActual: '0', rejectReasonCodeId: short },
      ],
    }).expect(200);
    const z = await rev(zero.doId);
    expect(z).toMatchObject({ sellRevenueTotal: '0.00', provisional: false });
    expect(z.data[0]).toMatchObject({ qty: '0', sellAmount: '0.00' });
  });
});
