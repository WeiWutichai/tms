import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { resetLinkWriteRate } from '../src/http/link-rate-limit';
import { resetPublicRateLimit } from '../src/http/public-rate-limit.middleware';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { normalizeDoNo } from '../src/modules/trips/pod-link.service';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/** ตัด token/id สุ่ม (ยาว ≥16) ออกก่อนตรวจว่าไม่มี PIN/ราคา — กันพังสุ่มเมื่อ token บังเอิญมีตัวเลขนั้น */
const scrubIds = (s: string) => s.replace(/[A-Za-z0-9_-]{16,}/g, '');

/**
 * ST4-T09 ลิงก์รถร่วม ส่วน POD (docs/04 E2 "ePOD ผ่านลิงก์", E2.1 M10; docs/01 §5.5 `/public/pod/{token}`)
 * เกณฑ์ตรวจรับ — ปิดงานจากมือถือพร้อมรูป 2 ใบ + ลายเซ็น แล้ว DO เป็น UNBILLED; รูปที่ 6 ถูกปฏิเสธ
 * + ไฟล์ผูกกับ DO/ลิงก์ (ไฟล์เว็บ/DO อื่น/ลิงก์อื่น/บริษัทอื่น = 422) · ไม่ครบ checklist = ไม่ปิดงาน · ส่ง POD อย่างเดียว
 *   (POD_PENDING → UNBILLED) · ส่งซ้ำ idempotent · เพิกถอน 404 · rate limit · ไม่มี PIN/ราคา/ที่อยู่ในผล · ผู้บันทึก = รถร่วม · ลิงก์รถร่วม
 */
describe('subcon link POD (ST4-T09)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let viewer: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const day = (n: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = {
    line1: '99/9 ถ.ลับเฉพาะ ซอยไม่เปิดเผย',
    district: 'เมือง',
    province: 'ชลบุรี',
    postcode: '20000',
  };
  const jur = (n: number) => {
    const base = `0105${String(80_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'ศรีไทยขนส่ง' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ศรีไทยขนส่ง จำกัด', taxId: validTaxId(901) },
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
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
  });
  beforeEach(async () => {
    await resetPublicRateLimit();
    await resetLinkWriteRate();
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const pub = () => request(app.getHttpServer());
  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    app
      .get(DbService)
      .withTenant(tenantId, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const newSite = async (name: string) =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `${name} ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  const newCarrier = async (phone?: string) =>
    (
      await api(app, admin)
        .post('/v1/carriers')
        .send({
          legalName: `หจก. ศรีราชาโลจิสติกส์ ${++seed}`,
          entityType: 'JURISTIC',
          taxId: jur(seed),
          ...(phone ? { phone } : {}),
        })
        .expect(201)
    ).body as { id: string; legalName: string };
  /** รถ 6 ล้อของรถร่วม + ประกัน/พ.ร.บ. (หมดอายุ `docUntil` วัน) */
  const vehicle = async (carrierId: string, plate: string, docUntil = 200, province = 'TH-20') => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate,
          plateProvince: province,
          vehicleTypeId: vt6,
          ownership: 'SUBCONTRACT',
          carrierId,
        })
        .expect(201)
    ).body as { id: string };
    for (const docType of ['INSURANCE', 'COMPULSORY_ACT'] as const)
      await db.vehicleDocument.create({
        data: {
          tenantId,
          vehicleId: uuid('vehicle', v.id),
          docType,
          startsOn: new Date(`${day(-200)}T00:00:00Z`),
          expiresOn: new Date(`${day(docUntil)}T00:00:00Z`),
          isRequiredForDispatch: true,
        },
      });
    return v;
  };
  const driver = async (carrierId: string, phone: string, licenceExpiresOn = day(300)) =>
    (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: `สมชาย ใจดี ${++seed}`,
          phone,
          employmentType: 'CARRIER_DRIVER',
          carrierId,
          licenceClass: 'T2',
          licenceExpiresOn,
        })
        .expect(201)
    ).body as { id: string; name: string };
  const newTrip = async (opts: { split?: boolean; both?: boolean } = {}) => {
    const [a, b] = [await newSite('คลังบางปู'), await newSite('ท่าเรือแหลมฉบัง ประตู 3')];
    const cust = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `บจก. เอ็นเอสเอฟ อินดัสทรี ${++seed}`, taxId: validTaxId(7000 + seed) })
        .expect(201)
    ).body.id as string;
    // ราคาขาย 7,800 (rate card ขาขาย) — ต้องไม่ปรากฏในหน้าลิงก์
    const rc = (
      await api(app, admin)
        .post('/v1/rate-cards')
        .send({
          customerId: cust,
          originId: a,
          destinationId: b,
          vehicleTypeId: vt6,
          validFrom: day(-30),
          pricingModel: 'PER_TRIP',
          sellRate: '7800',
        })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${rc.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: uuid('customer', cust) },
      requestedDate: today,
      vehicleTypeId: uuid('vehicleType', vt6),
      stops: [
        { type: 'PICKUP', siteId: uuid('site', a) },
        { type: 'DELIVERY', siteId: uuid('site', b) },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: unitTon, weightKg: '8600' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    let [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    let extraDo: string | null = null;
    if (opts.split) {
      // SO เดียวแยกเป็น 2 DO (ใบที่สองไปอยู่อีกเที่ยว)
      const [line] = await db.salesOrderLine.findMany({ where: { salesOrderId: so.id } });
      const kids = await run((tx) =>
        app
          .get(DeliveryOrderService)
          .split(
            d!.id,
            [
              [{ salesOrderLineId: line!.id, qty: '2' }],
              [{ salesOrderLineId: line!.id, qty: '3' }],
            ],
            tx,
          ),
      );
      d = kids[0]!;
      extraDo = encodeId('deliveryOrder', kids[1]!.id);
    }
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({
          tripDate: today,
          deliveryOrderIds: [
            encodeId('deliveryOrder', d!.id),
            ...(opts.both && extraDo ? [extraDo] : []),
          ],
        })
        .expect(201)
    ).body as { id: string; tripNo: string; version: number };
    return { ...t, soId: so.id, extraDo };
  };
  /** จ้างรถร่วม (ราคากรอกเอง + เหตุผล) → OFFERED + ลิงก์ */
  const hire = async (tripId: string, carrierId: string, cost = '5600') => {
    await api(app, admin)
      .post(`/v1/trips/${tripId}/offer`)
      .send({ carrierId, cost, selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว' })
      .expect(200);
    const l = (await api(app, admin).get(`/v1/trips/${tripId}/offer-link`).expect(200)).body
      .link as { url: string; offerId: string; linkId: string; expiresAt: string };
    return { ...l, token: new URL(l.url).pathname.split('/').pop()! };
  };
  /** รถร่วมพร้อมรถ + คนขับ + เที่ยวที่เสนองานแล้ว */
  async function offered(opts: { docUntil?: number; licence?: string; twoDos?: boolean } = {}) {
    const C = await newCarrier('0812345678');
    const plate = `74-${String(5000 + ++seed)}`;
    const v = await vehicle(C.id, plate, opts.docUntil ?? 200);
    const phone = `08${String(10_000_000 + ++seed).slice(-8)}`;
    const d = await driver(C.id, phone, opts.licence);
    const t = await newTrip(opts.twoDos ? { split: true, both: true } : {});
    const link = await hire(t.id, C.id);
    return { C, v, d, t, plate, phone, link };
  }
  const trip = (id: string) => api(app, admin).get(`/v1/trips/${id}`).expect(200);
  const so = (id: string) =>
    db.salesOrder.findUniqueOrThrow({
      where: { id },
      include: { holdReasonCode: { select: { code: true } } },
    });

  /** รถร่วมรับงานผ่านลิงก์ข้อเสนอ → ลิงก์งาน (pod) */
  async function accepted(opts: { twoDos?: boolean } = {}) {
    const o = await offered(opts);
    await pub()
      .post(`/v1/public/offers/${o.link.token}/accept`)
      .send({ vehiclePlate: o.plate, driverName: 'สมชาย', driverPhone: o.phone })
      .expect(200);
    const st = (await api(app, admin).get(`/v1/trips/${o.t.id}/offer-link`).expect(200)).body as {
      podLink: { url: string; linkId: string } | null;
    };
    const podToken = new URL(st.podLink!.url).pathname.split('/').pop()!;
    const doNo = (
      await db.deliveryOrder.findFirstOrThrow({ where: { tripId: uuid('trip', o.t.id) } })
    ).doNo!;
    return { ...o, pod: st.podLink!, podToken, doNo };
  }
  const dispatch = async (tripId: string) => {
    const r = await api(app, admin).post(`/v1/trips/${tripId}/dispatch`).send({});
    if (r.status !== 200) {
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      await api(app, admin)
        .post(`/v1/trips/${tripId}/dispatch`)
        .send({
          ruleKeys: (r.body.warnings ?? []).map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบลิงก์รถร่วม ส่วนสถานะ',
        })
        .expect(200);
    }
  };
  const view = (token: string, doNo?: string) =>
    pub().get(
      `/v1/public/pod/${token}${doNo !== undefined ? `?doNo=${encodeURIComponent(doNo)}` : ''}`,
    );
  const bkk = (minAgo = 0) => {
    const d = new Date(Date.now() - minAgo * 60_000 + 7 * 3600_000);
    return `${d.toISOString().slice(0, 19)}+07:00`;
  };
  const press = (token: string, stopId: string, body: Record<string, unknown>) =>
    pub()
      .post(`/v1/public/pod/${token}/stops/${stopId}/events`)
      .send({ clientEventId: randomUUID(), occurredAt: bkk(), ...body });

  // ---------------------------------------------------------------------------------------------
  // ST4-T09

  /** PNG ขนาดเล็ก (magic bytes ถูก — server ตรวจ MIME จากเนื้อไฟล์) */
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('0123456789abcdef'),
  ]);
  const reserve = (token: string, body: Record<string, unknown>) =>
    pub().post(`/v1/public/pod/${token}/files`).send(body);
  /** จอง + อัปโหลดเนื้อไฟล์ผ่านลิงก์ → id */
  const upload = async (token: string, doNo: string, kind = 'POD_PHOTO') => {
    const r = await reserve(token, { doNo, kind, mime: 'image/png', bytes: PNG.length }).expect(
      201,
    );
    const u = new URL(r.body.uploadUrl);
    await pub()
      .put(u.pathname + u.search)
      .set('Content-Type', 'application/octet-stream')
      .send(PNG)
      .expect(200);
    return r.body.id as string;
  };
  const capture = (token: string, body: Record<string, unknown>) =>
    pub().post(`/v1/public/pod/${token}/pod`).send(body);

  /** รับงาน → ปล่อยรถ → ถึงจุดรับ → ออกจากจุดรับ → ถึงจุดส่ง (ผ่านลิงก์) */
  async function atDrop() {
    const a = await accepted();
    await dispatch(a.t.id);
    const m = (await view(a.podToken, a.doNo).expect(200)).body.match;
    await press(a.podToken, m.pickup.id, { type: 'ARRIVE', occurredAt: bkk(30) }).expect(201);
    await press(a.podToken, m.pickup.id, { type: 'LOADED', occurredAt: bkk(25) }).expect(201);
    await press(a.podToken, m.delivery.id, { type: 'DEPART', occurredAt: bkk(25) }).expect(201);
    await press(a.podToken, m.delivery.id, { type: 'ARRIVE', occurredAt: bkk(5) }).expect(201);
    return {
      ...a,
      m,
      doId: (await db.deliveryOrder.findFirstOrThrow({ where: { doNo: a.doNo } })).id,
    };
  }
  const close = (
    token: string,
    stopId: string,
    pod: Record<string, unknown> | undefined,
    extra = {},
  ) =>
    press(token, stopId, {
      type: 'COMPLETE',
      outcome: 'DELIVERED',
      ...(pod ? { pod } : {}),
      ...extra,
    });

  it('เกณฑ์ตรวจรับ: ปิดงานจากมือถือพร้อมรูป 2 ใบ + ลายเซ็น → DO UNBILLED · source LINK · ผู้บันทึก = รถร่วม · ส่งซ้ำได้ผลเดิม · ไม่มี PIN/ราคา/ที่อยู่', async () => {
    const a = await atDrop();
    const v0 = (await view(a.podToken, a.doNo).expect(200)).body;
    expect(v0.match.pod).toMatchObject({
      mode: 'CLOSE',
      sent: false,
      podStatus: 'NONE',
      photosMax: 5,
    });
    expect(v0.match.pod.fields.map((f: { type: string }) => f.type)).toEqual(
      expect.arrayContaining(['PHOTO', 'SIGNATURE']),
    );
    expect(v0.sent).toEqual([]);

    const p1 = await upload(a.podToken, a.doNo);
    const p2 = await upload(a.podToken, a.doNo);
    const sig = await upload(a.podToken, a.doNo, 'POD_SIGNATURE');
    const cid = randomUUID();
    const pod = {
      doNo: a.doNo.toLowerCase(),
      photoDocumentIds: [p1, p2],
      signatureDocumentId: sig,
    };
    const r = await close(a.podToken, a.m.delivery.id, pod, { clientEventId: cid }).expect(201);
    expect(r.body).toMatchObject({
      type: 'COMPLETE',
      source: 'LINK',
      counted: true,
      replayed: false,
      pod: {
        doNo: a.doNo,
        doStatus: 'UNBILLED',
        podStatus: 'COMPLETE',
        photoCount: 2,
        hasSignature: true,
        replayed: false,
      },
    });
    const d = await db.deliveryOrder.findUniqueOrThrow({ where: { id: a.doId } });
    expect(d).toMatchObject({ status: 'UNBILLED', podStatus: 'COMPLETE' });
    const row = await db.deliveryOrderPod.findFirstOrThrow({ where: { deliveryOrderId: a.doId } });
    expect(row).toMatchObject({ version: 1, source: 'LINK', podStatus: 'COMPLETE' });
    expect(row.createdBy).toBe(`link:${uuid('magicLink', a.pod.linkId)}`);
    // ไฟล์ผูกกับ DO
    const docs = await db.storedDocument.findMany({ where: { id: { in: row.photoDocumentIds } } });
    expect(docs.every((x) => x.entityType === 'delivery_order' && x.entityId === a.doId)).toBe(
      true,
    );

    // ส่งซ้ำ (เน็ตหลุด กดใหม่) → 200 event + POD เดิม ไม่มีฉบับใหม่
    const again = await close(a.podToken, a.m.delivery.id, pod, { clientEventId: cid }).expect(200);
    expect(again.body).toMatchObject({
      id: r.body.id,
      replayed: true,
      pod: { replayed: true, photoCount: 2 },
    });
    expect(await db.deliveryOrderPod.count({ where: { deliveryOrderId: a.doId } })).toBe(1);

    // ผู้จัดรถเห็น: หลักฐาน source LINK + ชื่อรถร่วม · ไทม์ไลน์ COMPLETE ผ่านลิงก์
    const doPub = encodeId('deliveryOrder', a.doId);
    const g = (await api(app, admin).get(`/v1/delivery-orders/${doPub}/pod`).expect(200)).body;
    expect(g.current).toMatchObject({ source: 'LINK', recordedByName: a.C.legalName });
    expect(g.current.photos).toHaveLength(2);
    const tl = (await api(app, admin).get(`/v1/trips/${a.t.id}/events`).expect(200)).body.data;
    expect(tl.find((e: { type: string }) => e.type === 'COMPLETE')).toMatchObject({
      type: 'COMPLETE',
      source: 'LINK',
      recordedByName: a.C.legalName,
    });
    // audit pod.recorded โดยลิงก์ → ชื่อรถร่วม
    const aud = (
      await api(app, admin)
        .get(`/v1/audit-logs?entityType=delivery_order&entityId=${a.doId}`)
        .expect(200)
    ).body.data as { action: string; actor: { id: string; name: string } }[];
    expect(aud.find((x) => x.action === 'pod.recorded')?.actor).toMatchObject({
      id: expect.stringMatching(/^link:/),
      name: a.C.legalName,
    });

    // หน้าลิงก์: ส่งแล้ว + ไม่มีปุ่มส่งอีก · ไม่มีราคาขาย/ที่อยู่/ลิงก์ไฟล์
    const v1 = (await view(a.podToken, a.doNo).expect(200)).body;
    expect(v1.match.pod).toMatchObject({ mode: null, sent: true, podStatus: 'COMPLETE' });
    expect(v1.sent).toEqual([{ doNo: a.doNo, photoCount: 2 }]);
    const raw = scrubIds(JSON.stringify([v1, r.body]));
    for (const bad of ['7800', 'ลับเฉพาะ', '20000', 'downloadUrl', '/content?'])
      expect(raw).not.toContain(bad);
  });

  it('เกณฑ์ตรวจรับ: รูปที่ 6 ถูกปฏิเสธ · ไม่มี pod / ไม่ครบ checklist → ไม่ปิดงาน (rollback) · ยังไม่ถึงจุดส่ง → 409', async () => {
    const a = await atDrop();
    const ids = [] as string[];
    for (let i = 0; i < 6; i++) ids.push(await upload(a.podToken, a.doNo));
    const sig = await upload(a.podToken, a.doNo, 'POD_SIGNATURE');
    const six = await close(a.podToken, a.m.delivery.id, {
      doNo: a.doNo,
      photoDocumentIds: ids,
      signatureDocumentId: sig,
    }).expect(422);
    expect(six.body.errors[0].field).toMatch(/^pod\.photoDocumentIds/);
    // ไม่มี pod
    expect(
      (await close(a.podToken, a.m.delivery.id, undefined).expect(422)).body.errors[0],
    ).toMatchObject({ field: 'pod', code: 'pod_required' });
    // ไม่ครบ (ไม่มีลายเซ็น — ค่าระบบบังคับ) → 422 pod_incomplete · จุดส่งยังไม่ปิด · ไม่มี event COMPLETE
    const inc = (
      await close(a.podToken, a.m.delivery.id, {
        doNo: a.doNo,
        photoDocumentIds: ids.slice(0, 2),
      }).expect(422)
    ).body;
    expect(inc.code).toBe('pod_incomplete');
    expect(inc.errors[0]).toMatchObject({ field: 'pod.signatureDocumentId', code: 'required' });
    expect(
      (await db.tripStop.findUniqueOrThrow({ where: { id: uuid('tripStop', a.m.delivery.id) } }))
        .status,
    ).toBe('ARRIVED');
    expect(
      await db.stopEvent.count({
        where: { tripStopId: uuid('tripStop', a.m.delivery.id), type: 'COMPLETE' },
      }),
    ).toBe(0);
    expect(await db.deliveryOrderPod.count({ where: { deliveryOrderId: a.doId } })).toBe(0);
    // ไฟล์ยังไม่ถูกผูกกับฉบับใด — ส่งใหม่ครบได้
    await close(a.podToken, a.m.delivery.id, {
      doNo: a.doNo,
      photoDocumentIds: ids.slice(0, 5),
      signatureDocumentId: sig,
    }).expect(201);
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: a.doId } })).status).toBe(
      'UNBILLED',
    );
    // ส่งอีกครั้ง (clientEventId ใหม่) → เที่ยวจบแล้ว (จุดส่งจุดเดียว) ไม่รับ event ใหม่
    expect(
      (await close(a.podToken, a.m.delivery.id, { doNo: a.doNo, photoDocumentIds: [] }).expect(409))
        .body.code,
    ).toBe('trip_not_in_progress');

    // ยังไม่ถึงจุดส่ง → 409 · pod ที่ event อื่น → 422
    const b = await accepted();
    await dispatch(b.t.id);
    const mb = (await view(b.podToken, b.doNo).expect(200)).body.match;
    expect(mb.pod.mode).toBeNull();
    expect((await close(b.podToken, mb.delivery.id, { doNo: b.doNo }).expect(409)).body.code).toBe(
      'stop_not_arrived',
    );
    expect(
      (await press(b.podToken, mb.pickup.id, { type: 'ARRIVE', pod: { doNo: b.doNo } }).expect(422))
        .body.errors[0],
    ).toMatchObject({ field: 'pod', code: 'not_applicable' });
    // DO ที่ไม่ได้ส่งที่จุดนี้ → 422
    expect(
      (await close(b.podToken, mb.delivery.id, { doNo: a.doNo }).expect(422)).body.errors[0],
    ).toMatchObject({ field: 'pod.doNo', code: 'not_found' });
  });

  it('ไฟล์: ใช้ได้เฉพาะที่จองผ่านลิงก์นี้สำหรับ DO นี้ — ไฟล์เว็บ / ลิงก์อื่น / บริษัทอื่น / ยังไม่อัปโหลด → 422 · จองผิดชนิด/DO นอกเที่ยว', async () => {
    const a = await atDrop();
    const b = await accepted();
    const sig = await upload(a.podToken, a.doNo, 'POD_SIGNATURE');
    const own = await upload(a.podToken, a.doNo);
    // ไฟล์ที่ผู้ใช้เว็บอัปโหลด (POST /v1/documents) ของบริษัทเดียวกัน
    const web = (
      await api(app, admin)
        .post('/v1/documents')
        .send({ kind: 'POD_PHOTO', mime: 'image/png', bytes: PNG.length })
        .expect(201)
    ).body.id as string;
    // ไฟล์ของลิงก์อื่น (DO ของเที่ยว b)
    const otherLink = await upload(b.podToken, b.doNo);
    // ไฟล์ของบริษัทอื่น
    const tb = (await createTenant(db, 'B-pod-link')).id;
    const foreign = encodeId(
      'document',
      (
        await db.storedDocument.create({
          data: {
            tenantId: tb,
            status: 'READY',
            kind: 'POD_PHOTO',
            mimeType: 'image/png',
            sizeBytes: 10,
            fileKey: 'tb/x.png',
            sha256: 'a'.repeat(64),
          },
        })
      ).id,
    );
    // จองแล้วไม่อัปโหลด
    const pending = (
      await reserve(a.podToken, {
        doNo: a.doNo,
        kind: 'POD_PHOTO',
        mime: 'image/png',
        bytes: 10,
      }).expect(201)
    ).body.id as string;
    for (const bad of [web, otherLink, foreign]) {
      const e = (
        await close(a.podToken, a.m.delivery.id, {
          doNo: a.doNo,
          photoDocumentIds: [own, bad],
          signatureDocumentId: sig,
        }).expect(422)
      ).body;
      expect(e.errors).toEqual([
        expect.objectContaining({ field: 'pod.photoDocumentIds.1', code: 'not_found' }),
      ]);
    }
    const np = (
      await close(a.podToken, a.m.delivery.id, {
        doNo: a.doNo,
        photoDocumentIds: [own, pending],
        signatureDocumentId: sig,
      }).expect(422)
    ).body;
    expect(np.errors[0]).toMatchObject({ field: 'pod.photoDocumentIds.1', code: 'not_ready' });
    // ลายเซ็นต้องเป็นไฟล์ชนิดลายเซ็น
    expect(
      (
        await close(a.podToken, a.m.delivery.id, {
          doNo: a.doNo,
          photoDocumentIds: [own],
          signatureDocumentId: otherLink,
        }).expect(422)
      ).body.errors[0],
    ).toMatchObject({ field: 'pod.signatureDocumentId', code: 'not_found' });
    expect(
      await db.stopEvent.count({
        where: { tripStopId: uuid('tripStop', a.m.delivery.id), type: 'COMPLETE' },
      }),
    ).toBe(0);

    // จอง: ชนิดไฟล์ไม่ตรงชนิด / DO นอกเที่ยว / ขนาดเกิน
    expect(
      (
        await reserve(a.podToken, {
          doNo: a.doNo,
          kind: 'POD_PHOTO',
          mime: 'application/pdf',
          bytes: 10,
        }).expect(422)
      ).body.errors[0],
    ).toMatchObject({ field: 'mime', code: 'mime_not_allowed' });
    await reserve(a.podToken, {
      doNo: a.doNo,
      kind: 'POD_FILE',
      mime: 'application/pdf',
      bytes: 10,
    }).expect(201);
    await reserve(a.podToken, {
      doNo: b.doNo,
      kind: 'POD_PHOTO',
      mime: 'image/png',
      bytes: 10,
    }).expect(404);
    await reserve(a.podToken, {
      doNo: a.doNo,
      kind: 'POD_PHOTO',
      mime: 'image/png',
      bytes: 11 * 1024 * 1024,
    }).expect(422);
    await reserve(a.podToken, { doNo: a.doNo, kind: 'IMPORT', mime: 'text/csv', bytes: 10 }).expect(
      422,
    );
    // เนื้อไฟล์ไม่ตรงชนิดที่จอง → 422 (ตรวจ MIME จริง)
    const fake = (
      await reserve(a.podToken, {
        doNo: a.doNo,
        kind: 'POD_PHOTO',
        mime: 'image/jpeg',
        bytes: PNG.length,
      }).expect(201)
    ).body;
    const u = new URL(fake.uploadUrl);
    await pub()
      .put(u.pathname + u.search)
      .set('Content-Type', 'application/octet-stream')
      .send(PNG)
      .expect(422);
    // เพดานไฟล์ต่อ DO
    const link = `link:${uuid('magicLink', a.pod.linkId)}`;
    const n = await db.storedDocument.count({ where: { createdBy: link, entityId: a.doId } });
    await db.storedDocument.createMany({
      data: Array.from({ length: 20 - n }, () => ({
        tenantId,
        status: 'PENDING',
        kind: 'POD_PHOTO',
        mimeType: 'image/png',
        sizeBytes: 10,
        entityType: 'delivery_order',
        entityId: a.doId,
        createdBy: link,
      })),
    });
    expect(
      (
        await reserve(a.podToken, {
          doNo: a.doNo,
          kind: 'POD_PHOTO',
          mime: 'image/png',
          bytes: 10,
        }).expect(429)
      ).body.code,
    ).toBe('rate_limited');
  });

  it('ส่ง POD อย่างเดียว: ผู้จัดรถปิดจุดส่งแล้ว (POD_PENDING) → ลิงก์ส่ง POD → UNBILLED · ส่งซ้ำ 200 · มีแล้ว 409 · ยังไม่ปิด 409', async () => {
    const a = await atDrop();
    // ยังไม่ปิดงาน → ส่ง POD อย่างเดียวไม่ได้
    expect((await capture(a.podToken, { doNo: a.doNo }).expect(409)).body.code).toBe(
      'pod_not_allowed',
    );
    // ผู้จัดรถปิดงานจุดส่งในเว็บ (ไม่มี POD) → POD_PENDING
    await api(app, admin)
      .post(`/v1/stops/${a.m.delivery.id}/complete`)
      .send({
        clientEventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        outcome: 'DELIVERED',
      })
      .expect(201);
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: a.doId } })).status).toBe(
      'POD_PENDING',
    );
    expect((await view(a.podToken, a.doNo).expect(200)).body.match.pod.mode).toBe('SUBMIT');

    const p1 = await upload(a.podToken, a.doNo);
    const sig = await upload(a.podToken, a.doNo, 'POD_SIGNATURE');
    // ไม่ครบ → 422 สถานะคงเดิม
    expect(
      (await capture(a.podToken, { doNo: a.doNo, photoDocumentIds: [p1] }).expect(422)).body.code,
    ).toBe('pod_incomplete');
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: a.doId } })).status).toBe(
      'POD_PENDING',
    );
    const body = { doNo: a.doNo, photoDocumentIds: [p1], signatureDocumentId: sig, pin: '4821' };
    const r = await capture(a.podToken, body).expect(201);
    expect(r.body).toMatchObject({
      doStatus: 'UNBILLED',
      podStatus: 'COMPLETE',
      photoCount: 1,
      replayed: false,
    });
    expect(scrubIds(JSON.stringify(r.body))).not.toContain('4821');
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: a.doId } })).status).toBe(
      'UNBILLED',
    );
    // ส่งซ้ำ (ชุดเดิม) → 200 ผลเดิม · ชุดอื่น → 409
    expect((await capture(a.podToken, body).expect(200)).body).toMatchObject({ replayed: true });
    expect(
      (await capture(a.podToken, { ...body, photoDocumentIds: [] }).expect(409)).body.code,
    ).toBe('pod_exists');
    expect(await db.deliveryOrderPod.count({ where: { deliveryOrderId: a.doId } })).toBe(1);
    // จองไฟล์เพิ่มหลังมี POD แล้ว → 409
    await reserve(a.podToken, {
      doNo: a.doNo,
      kind: 'POD_PHOTO',
      mime: 'image/png',
      bytes: 10,
    }).expect(409);
    // PIN ไม่ออกในหน้าลิงก์ / audit / domain_event
    const v = scrubIds(JSON.stringify((await view(a.podToken, a.doNo).expect(200)).body));
    expect(v).not.toContain('4821');
    const aud = await db.auditLog.findMany({ where: { entityId: a.doId } });
    expect(
      scrubIds(JSON.stringify(aud, (_k, v) => (typeof v === 'bigint' ? String(v) : v))),
    ).not.toContain('4821');
  });

  it('เพิกถอน/หมดผล → 404 ทุก endpoint · rate limit 30 คำขอเขียน/นาที ต่อลิงก์ → 429', async () => {
    const a = await atDrop();
    const p1 = await upload(a.podToken, a.doNo);
    // ออกลิงก์งานใหม่ → ลิงก์เดิมใช้ไม่ได้ (รวมจองไฟล์ / ส่ง POD / ปิดงาน / อัปโหลดเนื้อไฟล์ที่จองไว้)
    const pend = (
      await reserve(a.podToken, {
        doNo: a.doNo,
        kind: 'POD_PHOTO',
        mime: 'image/png',
        bytes: PNG.length,
      }).expect(201)
    ).body;
    await api(app, admin).post(`/v1/trips/${a.t.id}/offer-link`).expect(201);
    await reserve(a.podToken, {
      doNo: a.doNo,
      kind: 'POD_PHOTO',
      mime: 'image/png',
      bytes: 10,
    }).expect(404);
    await capture(a.podToken, { doNo: a.doNo, photoDocumentIds: [p1] }).expect(404);
    await close(a.podToken, a.m.delivery.id, { doNo: a.doNo, photoDocumentIds: [p1] }).expect(404);
    const u = new URL(pend.uploadUrl);
    await pub()
      .put(u.pathname + u.search)
      .set('Content-Type', 'application/octet-stream')
      .send(PNG)
      .expect(404);
    // ลิงก์ใหม่ใช้ไฟล์ของลิงก์เดิมไม่ได้
    const fresh = (await api(app, admin).get(`/v1/trips/${a.t.id}/offer-link`).expect(200)).body
      .podLink;
    const tok = new URL(fresh.url).pathname.split('/').pop()!;
    const sig = await upload(tok, a.doNo, 'POD_SIGNATURE');
    expect(
      (
        await close(tok, a.m.delivery.id, {
          doNo: a.doNo,
          photoDocumentIds: [p1],
          signatureDocumentId: sig,
        }).expect(422)
      ).body.errors[0],
    ).toMatchObject({ field: 'pod.photoDocumentIds.0', code: 'not_found' });

    // rate limit ต่อลิงก์ (นับทุกคำขอเขียน)
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await capture(tok, { doNo: 'DO-0000-00000' })).status;
    expect(last).toBe(429);
  });

  it('review L: รหัสข้อผิดพลาด — จุดรับยังไม่ปิด → 409 stop_not_ready · ปิดพร้อมกันสองคำขอ → หนึ่ง 201 อีกหนึ่ง 409 (ไม่ปิดซ้ำ ไม่มี POD ซ้ำ)', async () => {
    // ถึงจุดส่งโดยไม่ปิดจุดรับ
    const a = await accepted();
    await dispatch(a.t.id);
    const m = (await view(a.podToken, a.doNo).expect(200)).body.match;
    await press(a.podToken, m.delivery.id, { type: 'ARRIVE', occurredAt: bkk(5) }).expect(201);
    const p1 = await upload(a.podToken, a.doNo);
    const sig = await upload(a.podToken, a.doNo, 'POD_SIGNATURE');
    const pod = { doNo: a.doNo, photoDocumentIds: [p1], signatureDocumentId: sig };
    const nr = (await close(a.podToken, m.delivery.id, pod).expect(409)).body;
    expect(nr.code).toBe('stop_not_ready');
    expect(nr.title).toBe('ปิดงานจุดก่อนหน้าก่อน');
    expect(
      await db.stopEvent.count({
        where: { tripStopId: uuid('tripStop', m.delivery.id), type: 'COMPLETE' },
      }),
    ).toBe(0);

    // แข่งกัน: สองเครื่องกดส่งพร้อมกัน (clientEventId ต่างกัน)
    const b = await atDrop();
    const q1 = await upload(b.podToken, b.doNo);
    const s1 = await upload(b.podToken, b.doNo, 'POD_SIGNATURE');
    const body = { doNo: b.doNo, photoDocumentIds: [q1], signatureDocumentId: s1 };
    const rs = await Promise.all([
      close(b.podToken, b.m.delivery.id, body),
      close(b.podToken, b.m.delivery.id, body),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(['stop_already_closed', 'trip_not_in_progress', 'pod_exists']).toContain(
      rs.find((r) => r.status === 409)!.body.code,
    );
    expect(await db.deliveryOrderPod.count({ where: { deliveryOrderId: b.doId } })).toBe(1);
  });

  it('review L: ส่ง POD อย่างเดียวพร้อมกันสองคำขอ → หนึ่ง 201 อีกหนึ่ง 409 pod_exists · จองไฟล์เกิน 60/ชม. → 429 + retryAfter', async () => {
    const a = await atDrop();
    await api(app, admin)
      .post(`/v1/stops/${a.m.delivery.id}/complete`)
      .send({
        clientEventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        outcome: 'DELIVERED',
      })
      .expect(201);
    const p1 = await upload(a.podToken, a.doNo);
    const p2 = await upload(a.podToken, a.doNo);
    const sig = await upload(a.podToken, a.doNo, 'POD_SIGNATURE');
    const rs = await Promise.all([
      capture(a.podToken, { doNo: a.doNo, photoDocumentIds: [p1], signatureDocumentId: sig }),
      capture(a.podToken, { doNo: a.doNo, photoDocumentIds: [p2], signatureDocumentId: sig }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(rs.find((r) => r.status === 409)!.body.code).toBe('pod_exists');
    expect(await db.deliveryOrderPod.count({ where: { deliveryOrderId: a.doId } })).toBe(1);

    // เพดาน 60 ไฟล์/ชม. ต่อลิงก์ (นับทุก DO)
    const b = await atDrop();
    const link = `link:${uuid('magicLink', b.pod.linkId)}`;
    await db.storedDocument.createMany({
      data: Array.from({ length: 60 }, () => ({
        tenantId,
        status: 'PENDING',
        kind: 'POD_PHOTO',
        mimeType: 'image/png',
        sizeBytes: 10,
        entityType: 'delivery_order',
        entityId: randomUUID(),
        createdBy: link,
      })),
    });
    const lim = (
      await reserve(b.podToken, {
        doNo: b.doNo,
        kind: 'POD_PHOTO',
        mime: 'image/png',
        bytes: 10,
      }).expect(429)
    ).body;
    expect(lim.code).toBe('rate_limited');
    expect(lim.retryAfter).toBeGreaterThan(3000);
    expect(lim.retryAfter).toBeLessThanOrEqual(3600);
  });

  it('review L: จุดส่งเดียวมีหลาย DO — ปิดงานพร้อม POD ของ DO หนึ่ง → อีก DO เป็น POD_PENDING (checklist บังคับ) แล้วส่ง POD ทีหลังได้', async () => {
    // SO เดียวแยกเป็น 2 DO ไปจุดส่งเดียวกัน แล้วใส่เที่ยวเดียวกัน
    const a = await accepted({ twoDos: true });
    const dos = await db.deliveryOrder.findMany({
      where: { tripId: uuid('trip', a.t.id) },
      select: { id: true, doNo: true, tripId: true, tripStopId: true },
      orderBy: { doNo: 'asc' },
    });
    expect(dos).toHaveLength(2);
    // ทั้งสองใบอยู่ในเที่ยว + จุดส่งเดียวกัน
    expect(new Set(dos.map((d) => d.tripId)).size).toBe(1);
    expect(dos[0]!.tripId).toBe(uuid('trip', a.t.id));
    expect(new Set(dos.map((d) => d.tripStopId)).size).toBe(1);
    const [x, y] = dos as { id: string; doNo: string }[];
    await dispatch(a.t.id);
    const m = (await view(a.podToken, x!.doNo).expect(200)).body.match;
    await press(a.podToken, m.pickup.id, { type: 'ARRIVE', occurredAt: bkk(30) }).expect(201);
    await press(a.podToken, m.pickup.id, { type: 'LOADED', occurredAt: bkk(25) }).expect(201);
    await press(a.podToken, m.delivery.id, { type: 'ARRIVE', occurredAt: bkk(5) }).expect(201);
    const p1 = await upload(a.podToken, x!.doNo);
    const s1 = await upload(a.podToken, x!.doNo, 'POD_SIGNATURE');
    await close(a.podToken, m.delivery.id, {
      doNo: x!.doNo,
      photoDocumentIds: [p1],
      signatureDocumentId: s1,
    }).expect(201);
    const st = async (id: string) =>
      (await db.deliveryOrder.findUniqueOrThrow({ where: { id } })).status;
    expect(await st(x!.id)).toBe('UNBILLED');
    expect(await st(y!.id)).toBe('POD_PENDING');
    // DO ที่สอง: หน้าลิงก์ = ส่ง POD อย่างเดียว · ไฟล์ของ DO แรกใช้ไม่ได้
    expect((await view(a.podToken, y!.doNo).expect(200)).body.match.pod.mode).toBe('SUBMIT');
    const p2 = await upload(a.podToken, y!.doNo);
    const s2 = await upload(a.podToken, y!.doNo, 'POD_SIGNATURE');
    expect(
      (
        await capture(a.podToken, {
          doNo: y!.doNo,
          photoDocumentIds: [p1],
          signatureDocumentId: s2,
        }).expect(422)
      ).body.errors[0],
    ).toMatchObject({ field: 'photoDocumentIds.0', code: 'not_found' });
    await capture(a.podToken, {
      doNo: y!.doNo,
      photoDocumentIds: [p2],
      signatureDocumentId: s2,
    }).expect(201);
    expect(await st(y!.id)).toBe('UNBILLED');
  });

  it('review L: อัปโหลดเนื้อไฟล์ที่จองไว้หลังเที่ยวจบเกิน 7 วัน → 404 (กฎเดียวกับหน้าลิงก์)', async () => {
    const a = await atDrop();
    const r = (
      await reserve(a.podToken, {
        doNo: a.doNo,
        kind: 'POD_PHOTO',
        mime: 'image/png',
        bytes: PNG.length,
      }).expect(201)
    ).body;
    const tid = uuid('trip', a.t.id);
    await db.$executeRaw`UPDATE trip SET status = 'COMPLETED', completed_at = now() - interval '8 days' WHERE id = ${tid}::uuid`;
    const u = new URL(r.uploadUrl);
    await pub()
      .put(u.pathname + u.search)
      .set('Content-Type', 'application/octet-stream')
      .send(PNG)
      .expect(404);
  });

  // ---------------------------------------------------------------------------------------------
  // ST4-T10 ยอดส่งจริงผ่านลิงก์รถร่วม

  it('ST4-T10: หน้าลิงก์ได้บรรทัดสินค้า + เหตุผลปฏิเสธรับ · ส่งน้อยกว่าแผนไม่มีเหตุผล → 422 ไม่ปิดงาน · มีเหตุผล → ปิดงาน + ยอดส่งจริงลงบรรทัด DO', async () => {
    const a = await atDrop();
    const v0 = (await view(a.podToken, a.doNo).expect(200)).body;
    expect(v0.match.pod.lines).toEqual([
      {
        doLineId: expect.stringMatching(/^dol_[0-9a-f]{32}$/),
        lineNo: 1,
        description: 'ปูนซีเมนต์',
        unit: expect.any(String),
        qtyPlanned: '5',
      },
    ]);
    const reasons = v0.match.pod.rejectReasons as { id: string; label: string }[];
    expect(reasons.map((r) => r.label)).toEqual(
      expect.arrayContaining(['จำนวนไม่ครบ', 'สินค้าเสียหายระหว่างขนส่ง']),
    );
    const short = reasons.find((r) => r.label === 'จำนวนไม่ครบ')!;
    expect(short).toMatchObject({ requiresPhoto: true, requiresNote: false });

    const p1 = await upload(a.podToken, a.doNo);
    const sig = await upload(a.podToken, a.doNo, 'POD_SIGNATURE');
    const pod = { doNo: a.doNo, photoDocumentIds: [p1], signatureDocumentId: sig };
    // QA L4: field ราคาที่ลิงก์ไม่มี = field ไม่รู้จัก → 422 (ไม่ใช่ 403 ที่บอกว่าเป็น field ราคา)
    const px = await close(a.podToken, a.m.delivery.id, { ...pod, sellAmount: '100.00' }).expect(
      422,
    );
    expect(px.body.code).toBe('validation_failed');
    const bad = await close(a.podToken, a.m.delivery.id, {
      ...pod,
      lines: [{ lineNo: 1, qtyActual: '4' }],
    }).expect(422);
    expect(bad.body.errors).toEqual([
      expect.objectContaining({ field: 'pod.lines.0.rejectReasonCodeId', code: 'reason_required' }),
    ]);
    // ไม่ปิดงาน (rollback ทั้งคำขอ)
    expect((await view(a.podToken, a.doNo).expect(200)).body.match.delivery.status).toBe('ARRIVED');
    expect(await db.deliveryOrderPod.count({ where: { deliveryOrderId: a.doId } })).toBe(0);

    const ok = await close(a.podToken, a.m.delivery.id, {
      ...pod,
      // D-81 · D68-52 ลิงก์อ้างบรรทัดด้วย doLineId ได้
      lines: [
        { doLineId: v0.match.pod.lines[0].doLineId, qtyActual: '4', rejectReasonCodeId: short.id },
      ],
    }).expect(201);
    expect(ok.body.pod).toMatchObject({ doStatus: 'UNBILLED', podStatus: 'COMPLETE' });
    const line = await db.deliveryOrderLine.findFirstOrThrow({
      where: { deliveryOrderId: a.doId },
    });
    expect([line.qtyActual?.toFixed(), line.rejectQty?.toFixed()]).toEqual(['4', '1']);
    const g = (
      await api(app, admin)
        .get(`/v1/delivery-orders/${encodeId('deliveryOrder', a.doId)}/pod`)
        .expect(200)
    ).body;
    expect(g.current.source).toBe('LINK');
    expect(g.lines[0]).toMatchObject({
      qtyActual: '4',
      rejectQty: '1',
      rejectReason: { label: 'จำนวนไม่ครบ' },
    });
  });
  it('D-81 · D68-39 review: ส่งบางส่วนผ่านลิงก์ (COMPLETE PARTIAL + เหตุผล) พร้อม POD ยอดขาด → จุดส่ง COMPLETED ผล PARTIAL · ยอดส่งจริงลงบรรทัด · เหตุผลบังคับรูปใช้ได้เมื่อ POD มีรูป', async () => {
    const a = await atDrop();
    const v0 = (await view(a.podToken, a.doNo).expect(200)).body;
    const short = (v0.match.pod.rejectReasons as { id: string; label: string }[]).find(
      (r) => r.label === 'จำนวนไม่ครบ',
    )!; // บังคับรูป
    const p1 = await upload(a.podToken, a.doNo);
    const sig = await upload(a.podToken, a.doNo, 'POD_SIGNATURE');
    const lines = [
      { doLineId: v0.match.pod.lines[0].doLineId, qtyActual: '3', rejectReasonCodeId: short.id },
    ];
    // บางส่วนต้องมีเหตุผลของจุด
    expect(
      (
        await close(
          a.podToken,
          a.m.delivery.id,
          {
            doNo: a.doNo,
            photoDocumentIds: [p1],
            signatureDocumentId: sig,
            lines,
          },
          { outcome: 'PARTIAL' },
        ).expect(422)
      ).body.errors[0],
    ).toMatchObject({ field: 'reasonCodeId', code: 'required' });
    const ok = await close(
      a.podToken,
      a.m.delivery.id,
      { doNo: a.doNo, photoDocumentIds: [p1], signatureDocumentId: sig, lines },
      { outcome: 'PARTIAL', reasonCodeId: short.id },
    ).expect(201);
    expect(ok.body).toMatchObject({ type: 'COMPLETE', outcome: 'PARTIAL', counted: true });
    expect(ok.body.pod).toMatchObject({ doStatus: 'UNBILLED' });
    expect((await view(a.podToken, a.doNo).expect(200)).body.match.delivery).toMatchObject({
      status: 'COMPLETED',
      outcome: 'PARTIAL',
    });
    const line = await db.deliveryOrderLine.findFirstOrThrow({
      where: { deliveryOrderId: a.doId },
    });
    expect([line.qtyActual?.toFixed(), line.rejectQty?.toFixed()]).toEqual(['3', '2']);
    const ev = await db.stopEvent.findFirstOrThrow({
      where: { tripStopId: uuid('tripStop', a.m.delivery.id), type: 'COMPLETE' },
    });
    expect(ev.reasonCodeId).toBe(uuid('reasonCode', short.id));
  });

  it('Q-LINK (PO 24 พ.ย. 2569): แจ้งส่ง/รับไม่สำเร็จพร้อมรูป → เหตุผลบังคับรูปใช้ได้ · รูปเป็นหลักฐานชุด "ไม่สำเร็จ" ของ DO · ส่งซ้ำได้ผลเดิม · ใช้ผิดชนิด/ไฟล์ไม่ใช่ของลิงก์ → 422', async () => {
    const rsn = async (category: string, code: string) =>
      encodeId(
        'reasonCode',
        (
          await db.reasonCode.findFirstOrThrow({
            where: { tenantId, category: category as never, code },
          })
        ).id,
      );
    const wrong = await rsn('DELIVERY_FAILED', 'WRONG_ADDRESS'); // บังคับรูป + หมายเหตุ
    const a = await atDrop();
    // เหตุผลบังคับรูปแสดงในลิงก์แล้ว
    const fr = (await view(a.podToken, a.doNo).expect(200)).body.match.failReasons as {
      id: string;
      requiresPhoto: boolean;
    }[];
    expect(fr.find((r) => r.id === wrong)).toMatchObject({ requiresPhoto: true });
    const fail = (extra: Record<string, unknown>) =>
      press(a.podToken, a.m.delivery.id, {
        type: 'COMPLETE',
        outcome: 'FAILED',
        reasonCodeId: wrong,
        note: 'ที่อยู่ไม่ตรงกับป้ายหน้าร้าน',
        ...extra,
      });
    // ไม่มีรูป → 422 photo_required (ไม่ปิดงาน)
    expect((await fail({}).expect(422)).body.errors[0]).toMatchObject({
      field: 'reasonCodeId',
      code: 'photo_required',
    });
    // รูปที่ไม่ได้จองผ่านลิงก์นี้ → 422 failurePhotos.photoDocumentIds.0 not_found
    const foreign = encodeId('document', randomUUID());
    expect(
      (await fail({ failurePhotos: { doNo: a.doNo, photoDocumentIds: [foreign] } }).expect(422))
        .body.errors[0],
    ).toMatchObject({ field: 'failurePhotos.photoDocumentIds.0', code: 'not_found' });
    // DO ไม่อยู่ที่จุดนี้ → 422
    expect(
      (
        await fail({ failurePhotos: { doNo: 'DO-NOPE-1', photoDocumentIds: [foreign] } }).expect(
          422,
        )
      ).body.errors[0],
    ).toMatchObject({ field: 'failurePhotos.doNo', code: 'not_found' });
    const p1 = await upload(a.podToken, a.doNo);
    const p2 = await upload(a.podToken, a.doNo);
    // ใช้กับผลที่ไม่ใช่ไม่สำเร็จ → 422 not_applicable
    expect(
      (
        await press(a.podToken, a.m.pickup.id, {
          type: 'COMPLETE',
          outcome: 'PARTIAL',
          reasonCodeId: wrong,
          note: 'x',
          failurePhotos: { doNo: a.doNo, photoDocumentIds: [p1] },
        }).expect(422)
      ).body.errors[0],
    ).toMatchObject({ field: 'failurePhotos', code: 'not_applicable' });
    expect(
      await db.stopEvent.count({
        where: { tripStopId: uuid('tripStop', a.m.delivery.id), type: 'COMPLETE' },
      }),
    ).toBe(0);
    const cid = randomUUID();
    const ok = await fail({
      clientEventId: cid,
      failurePhotos: { doNo: a.doNo, photoDocumentIds: [p1, p2] },
    }).expect(201);
    expect(ok.body).toMatchObject({ type: 'COMPLETE', outcome: 'FAILED', counted: true });
    expect(ok.body.pod).toMatchObject({ doNo: a.doNo, photoCount: 2, replayed: false });
    const pod = await db.deliveryOrderPod.findFirstOrThrow({ where: { deliveryOrderId: a.doId } });
    expect(pod.photoDocumentIds).toHaveLength(2);
    expect(pod).toMatchObject({
      outcome: 'FAILURE',
      source: 'LINK',
      createdBy: `link:${uuid('magicLink', a.pod.linkId)}`,
    });
    // DO ส่งไม่สำเร็จ (หรือยกเลิกเพราะนัดส่งใหม่อัตโนมัติ) — หลักฐานเห็นในเว็บของผู้จัดรถ
    const d = await db.deliveryOrder.findUniqueOrThrow({ where: { id: a.doId } });
    expect(['FAILED', 'CANCELLED']).toContain(d.status);
    const web = (
      await api(app, admin)
        .get(`/v1/delivery-orders/${encodeId('deliveryOrder', a.doId)}/pod`)
        .expect(200)
    ).body;
    expect(web.current.photos).toHaveLength(2);
    // ส่งซ้ำ clientEventId เดิม → 200 ผลเดิม ไม่มีฉบับใหม่
    const again = await fail({
      clientEventId: cid,
      failurePhotos: { doNo: a.doNo, photoDocumentIds: [p1, p2] },
    }).expect(200);
    expect(again.body).toMatchObject({ replayed: true, pod: { photoCount: 2, replayed: true } });
    expect(await db.deliveryOrderPod.count({ where: { deliveryOrderId: a.doId } })).toBe(1);

    // รับไม่ได้ที่จุดรับ (ยังไม่ถึงก็แจ้งได้) พร้อมรูป → DO ส่งไม่สำเร็จ + หลักฐานชุดไม่สำเร็จ
    const b = await accepted();
    await dispatch(b.t.id);
    const mb = (await view(b.podToken, b.doNo).expect(200)).body.match;
    const bp = await upload(b.podToken, b.doNo);
    const r = await press(b.podToken, mb.pickup.id, {
      type: 'FAIL',
      reasonCodeId: wrong,
      note: 'คลังต้นทางย้ายไปแล้ว',
      failurePhotos: { doNo: b.doNo, photoDocumentIds: [bp] },
    }).expect(201);
    expect(r.body.pod).toMatchObject({ photoCount: 1 });
    const bDo = await db.deliveryOrder.findFirstOrThrow({ where: { doNo: b.doNo } });
    expect(await db.deliveryOrderPod.count({ where: { deliveryOrderId: bDo.id } })).toBe(1);
  });
});
