import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '@tms/domain';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { resetPublicRateLimit } from '../src/http/public-rate-limit.middleware';
import { resetTrackingRate } from '../src/http/tracking-rate-limit';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { encodeLinkToken } from '../src/modules/links/magic-link.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { maskPlate, trackingStage } from '../src/modules/tracking/tracking.service';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST4-T14 Tracking link สาธารณะ (docs/04 E2, docs/01 §5.2 #4, spec/04 §4 EXE-D) — เกณฑ์ตรวจรับ:
 * ค้นด้วยเลข PO ของลูกค้าเห็นสถานะล่าสุด; response ไม่มี field ราคา (ตรวจทั้งก้อนแบบ recursive)
 * + ลิงก์ต่อ DO, ค้นด้วยเลข DO, เบอร์ไม่ตรง/ลูกค้าอื่น/ลิงก์ DO = 404 เดียวกัน, ล็อกเมื่อค้นผิด 5 ครั้ง,
 *   เพิกถอน/หมดอายุ/งานจบเกิน linkDays = 404, POD เฉพาะเมื่อเปิด, ทะเบียนปิด, แยก tenant
 */
describe('tracking link (ST4-T14)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherTenant: string;
  let admin: string;
  let viewer: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const addr = (province: string) => ({
    line1: '99/9 ถ.ลับเฉพาะ ซอยไม่เปิดเผย',
    district: 'เมือง',
    province,
    postcode: '20000',
  });
  const PRICE_KEY = /price|amount|rate|cost|revenue|sell|buy|vat|wht|fee|total|margin|baht/i;
  const SECRET_KEY =
    /^(.*phone.*|.*driver.*|.*address.*|line1|postcode|lat|lng|note|notes|pin.*|plate|tenant.*|trip.*|.*contact.*|reason.*)$/i;

  /** ตรวจ response ทั้งก้อน: ไม่มี key ราคา/ข้อมูลภายใน และไม่มีค่าที่รั่ว */
  function assertPublicSafe(body: unknown, leaks: string[]) {
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          expect(k, `${path}.${k}`).not.toMatch(PRICE_KEY);
          if (!(path === '$.company' && k === 'phone'))
            expect(k, `${path}.${k}`).not.toMatch(SECRET_KEY);
          walk(x, `${path}.${k}`);
        }
    };
    walk(body, '$');
    const raw = JSON.stringify(body);
    for (const l of leaks) expect(raw, `leak ${l}`).not.toContain(l);
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'ศรีไทยขนส่ง' })).id;
    otherTenant = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ศรีไทยขนส่ง จำกัด', taxId: validTaxId(941) },
    });
    await db.branch.create({
      data: {
        tenantId,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: addr('กรุงเทพมหานคร'),
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
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'tracking.contactPhone': '02-118-4400' } })
      .expect(200);
  });
  beforeEach(() => {
    resetPublicRateLimit();
    resetTrackingRate();
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
  const newSite = async (province: string, phone?: string) =>
    uuid(
      'site',
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({
            name: `จุด ${++seed}`,
            kind: 'DROPOFF',
            address: addr(province),
            ...(phone ? { contact: { name: 'คุณวิไล', phone } } : {}),
          })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async () =>
    uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: `บจก. สยามพลาสติก ${++seed}`, taxId: validTaxId(9600 + seed) })
          .expect(201)
      ).body.id,
    );
  const newVehicle = async () => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `7${++seed % 10}-${String(4000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string; plate: string };
    const n = ++seed;
    await api(app, admin)
      .post('/v1/drivers')
      .send({
        name: `สมชาย ใจดี ${n}`,
        phone: `081-${String(n).padStart(3, '0')}-4507`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    return v;
  };
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const stop = (id: string, action: string, min: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/stops/${id}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra });

  /** SO (PO ลูกค้า) → DO → (ไม่บังคับ) เที่ยวปล่อยรถ → ถึง/รับของ/ส่ง */
  const shipment = async (
    o: {
      customerId?: string;
      po?: string;
      phone?: string | null;
      upTo?: 'PLANNED' | 'DISPATCHED' | 'PICKED' | 'DELIVERED' | 'FAILED' | 'NONE';
      window?: [string, string];
    } = {},
  ) => {
    const customerId = o.customerId ?? (await newCustomer());
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: customerId },
      customerRef: o.po ?? null,
      requestedDate: today,
      stops: [
        { type: 'PICKUP', siteId: await newSite('สมุทรปราการ') },
        {
          type: 'DELIVERY',
          siteId: await newSite(
            'ชลบุรี',
            o.phone === undefined ? '081-234-4507' : (o.phone ?? undefined),
          ),
          ...(o.window ? { windowStart: o.window[0], windowEnd: o.window[1] } : {}),
        },
      ],
      lines: [{ description: 'เม็ดพลาสติก PP', qty: '2', unitId: unitTon, weightKg: '2000' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    const doId = encodeId('deliveryOrder', d!.id);
    const res = { doId, uuid: d!.id, doNo: d!.doNo!, customerId, plate: '' };
    if (o.upTo === 'NONE') return res;
    const v = await newVehicle();
    res.plate = v.plate;
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [doId], vehicleId: v.id })
        .expect(201)
    ).body;
    if (o.upTo === 'PLANNED') return res;
    const r = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: v.id, dispatch: true });
    if (r.status !== 200)
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: v.id,
          dispatch: true,
          ruleKeys: r.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบหน้าติดตาม',
        })
        .expect(200);
    if (o.upTo === 'DISPATCHED') return res;
    const full = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    const [pickup, drop] = [...full.stops].sort(
      (a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence,
    );
    await stop(pickup.id, 'arrive', 60).expect(201);
    await stop(pickup.id, 'complete', 55, { outcome: 'DELIVERED' }).expect(201);
    if (o.upTo === 'PICKED') return res;
    await stop(drop.id, 'arrive', 20).expect(201);
    if (o.upTo === 'FAILED') {
      const rsn = await db.reasonCode.findFirstOrThrow({
        where: { tenantId, category: 'DELIVERY_FAILED', code: 'SHOP_CLOSED' },
      });
      await stop(drop.id, 'fail', 10, {
        outcome: 'FAILED',
        reasonCodeId: encodeId('reasonCode', rsn.id),
        note: 'ร้านปิด ข้อความภายใน',
      }).expect(201);
    } else await stop(drop.id, 'complete', 10, { outcome: 'DELIVERED' }).expect(201);
    return res;
  };
  const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;
  const doLink = async (doId: string) =>
    (await api(app, admin).post(`/v1/delivery-orders/${doId}/tracking-link`).expect(201)).body as {
      url: string;
      linkId: string;
      expiresAt: string;
    };
  const custLink = async (customerId: string) =>
    (
      await api(app, admin)
        .post(`/v1/customers/${encodeId('customer', customerId)}/tracking-link`)
        .expect(201)
    ).body as { url: string; linkId: string };
  const view = (token: string) => pub().get(`/v1/public/tracking/${token}`);
  const lookup = (token: string, ref: string, phoneLast4: string, ip = '10.9.0.1') =>
    pub()
      .post(`/v1/public/tracking/${token}/lookup`)
      .set('X-Forwarded-For', ip)
      .send({ ref, phoneLast4 });

  it('ฟังก์ชันล้วน: stage จากสถานะ DO + ความคืบหน้าเที่ยว · ทะเบียนปิด 2 หลักท้าย', () => {
    const t0 = { started: false, pickupDone: false };
    expect(trackingStage('DRAFT', t0)).toBe('ACCEPTED');
    expect(trackingStage('PLANNED', t0)).toBe('ACCEPTED');
    expect(trackingStage('DISPATCHED', t0)).toBe('ACCEPTED');
    expect(trackingStage('DISPATCHED', { started: true, pickupDone: false })).toBe('DEPARTED');
    expect(trackingStage('DISPATCHED', { started: true, pickupDone: true })).toBe('IN_TRANSIT');
    expect(trackingStage('PICKED_UP', t0)).toBe('IN_TRANSIT');
    for (const s of ['DELIVERED', 'POD_PENDING', 'UNBILLED', 'BILLED'])
      expect(trackingStage(s, t0)).toBe('DELIVERED');
    expect(trackingStage('FAILED', t0)).toBe('FAILED');
    expect(trackingStage('RETURNED', t0)).toBe('FAILED');
    expect(trackingStage('CANCELLED', t0)).toBe('CANCELLED');
    expect(maskPlate('70-1234 กทม.')).toBe('70-12xx กทม.');
    expect(maskPlate('กข 1234')).toBe('กข 12xx');
    expect(maskPlate('7')).toBe('xx');
    expect(maskPlate(null)).toBeNull();
  });

  it('เกณฑ์ตรวจรับ: ลิงก์ของลูกค้า ค้นด้วยเลข PO + เบอร์ 4 ตัวท้าย → สถานะล่าสุด · ไม่มี field ราคา (recursive) · noindex/no-referrer/no-store', async () => {
    const customerId = await newCustomer();
    // PO เดียวกันสองใบ: ใบเก่า (ยังไม่ออกรถ) + ใบใหม่ (ส่งแล้ว) → ได้ใบใหม่
    await shipment({ customerId, po: 'PO-45861', upTo: 'PLANNED' });
    const s = await shipment({ customerId, po: 'PO-45861', upTo: 'DELIVERED' });
    const { url } = await custLink(customerId);
    expect(url).toMatch(/\/t\/ml1\./);
    const token = tokenOf(url);

    const v = await view(token).expect(200);
    expect(v.headers['cache-control']).toBe('no-store');
    expect(v.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(v.headers['referrer-policy']).toBe('no-referrer');
    expect(v.body).toEqual({
      company: { name: 'ศรีไทยขนส่ง', phone: '02-118-4400' },
      mode: 'SEARCH',
      shipment: null,
    });

    const r = await lookup(token, ' po-45861 ', '4507').expect(200);
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(r.body).toMatchObject({
      doNo: s.doNo,
      customerRef: 'PO-45861',
      status: 'DELIVERED',
      route: { from: 'สมุทรปราการ', to: 'ชลบุรี' },
      items: [{ description: 'เม็ดพลาสติก PP', qty: '2', unit: 'ตัน' }],
      pod: null, // ค่าเริ่ม tracking.showPod = false
      eta: null,
    });
    expect(r.body.steps.map((x: { done: boolean }) => x.done)).toEqual([true, true, true, true]);
    expect(r.body.deliveredAt).toEqual(expect.any(String));
    expect(r.body.vehicle.plateMasked).toMatch(/xx/);
    // ราคาขายมีอยู่ในฐาน (rate card ไม่มี → ใส่ revenue ตรง ๆ) แต่ไม่ออกทาง response
    await db.deliveryOrder.update({ where: { id: s.uuid }, data: { revenueAmount: '7800.00' } });
    const again = await lookup(token, 'PO-45861', '4507').expect(200);
    assertPublicSafe(again.body, ['7800', s.plate, 'ลับเฉพาะ', '081-', 'สมชาย', 'คุณวิไล']);
    assertPublicSafe(v.body, []);
  });

  it('ค้นด้วยเลข DO (ตัวเล็ก/ช่องว่าง) · เบอร์ไม่ตรง / DO ของลูกค้าอื่น / ไม่มีเบอร์ปลายทาง → 404 เดียวกัน', async () => {
    const customerId = await newCustomer();
    const s = await shipment({ customerId, upTo: 'PLANNED', phone: '089 777 1234' });
    const token = tokenOf((await custLink(customerId)).url);
    const ok = await lookup(token, ` ${s.doNo.toLowerCase()} `, '1234').expect(200);
    expect(ok.body).toMatchObject({ doNo: s.doNo, status: 'ACCEPTED', vehicle: null });
    expect(ok.body.steps.map((x: { done: boolean }) => x.done)).toEqual([
      true,
      false,
      false,
      false,
    ]);

    const wrong = await lookup(token, s.doNo, '9999', '10.9.1.1').expect(404);
    const other = await shipment({ upTo: 'NONE', phone: '089 777 1234' });
    const foreign = await lookup(token, other.doNo, '1234', '10.9.1.2').expect(404);
    const noPhone = await shipment({ customerId, upTo: 'NONE', phone: null });
    const none = await lookup(token, noPhone.doNo, '4507', '10.9.1.3').expect(404);
    for (const x of [wrong, foreign, none]) {
      expect(x.body.code).toBe('not_found');
      expect(Object.keys(x.body).sort()).toEqual(Object.keys(wrong.body).sort());
    }
    // body ไม่ถูกต้อง → 422
    await lookup(token, s.doNo, '12').expect(422);
  });

  it('ค้นผิด 5 ครั้ง/ชม./IP → 429 (แม้เลขถูก) · IP อื่นยังค้นได้', async () => {
    const customerId = await newCustomer();
    const s = await shipment({ customerId, po: 'PO-LOCK', upTo: 'NONE' });
    const token = tokenOf((await custLink(customerId)).url);
    for (let i = 0; i < 5; i++) await lookup(token, 'PO-LOCK', '0000', '10.9.2.1').expect(404);
    const locked = await lookup(token, 'PO-LOCK', '4507', '10.9.2.1').expect(429);
    expect(locked.body.code).toBe('rate_limited');
    expect((await lookup(token, 'PO-LOCK', '4507', '10.9.2.2').expect(200)).body.doNo).toBe(s.doNo);
  });

  it('ลิงก์ต่อ DO: เปิดแล้วเห็นงาน (กำลังส่ง + ETA ช่วงเวลาตามแผน) · lookup ด้วยลิงก์ DO = 404 · ออกใหม่ = อันเก่าใช้ไม่ได้', async () => {
    const s = await shipment({
      upTo: 'PICKED',
      po: 'PO-ETA',
      window: [`${today}T10:30:00+07:00`, `${today}T11:00:00+07:00`],
    });
    const first = await doLink(s.doId);
    const r = await view(tokenOf(first.url)).expect(200);
    expect(r.body.mode).toBe('SHIPMENT');
    expect(r.body.shipment).toMatchObject({
      doNo: s.doNo,
      status: 'IN_TRANSIT',
      eta: { basis: 'PLAN' },
      deliveredAt: null,
      vehicle: { typeName: expect.any(String) },
    });
    expect(Date.parse(r.body.shipment.eta.from)).toBe(Date.parse(`${today}T10:30:00+07:00`));
    expect(Date.parse(r.body.shipment.eta.to)).toBe(Date.parse(`${today}T11:00:00+07:00`));
    expect(r.body.shipment.steps.map((x: { done: boolean }) => x.done)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    assertPublicSafe(r.body, [s.plate, 'ลับเฉพาะ']);
    await lookup(tokenOf(first.url), 'PO-ETA', '4507').expect(404);

    const state = await api(app, viewer).get(`/v1/delivery-orders/${s.doId}/tracking-link`);
    expect(state.status).toBe(200);
    expect(state.body.link.url).toBe(first.url);
    // viewer ออก/เพิกถอนไม่ได้
    await api(app, viewer).post(`/v1/delivery-orders/${s.doId}/tracking-link`).expect(403);
    const second = await doLink(s.doId);
    await view(tokenOf(first.url)).expect(404);
    await view(tokenOf(second.url)).expect(200);
    const audit = await db.auditLog.findMany({
      where: { tenantId, entityId: s.uuid, action: { startsWith: 'magic_link.' } },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'magic_link.issued',
      'magic_link.issued',
      'magic_link.revoked',
    ]);
  });

  it('เพิกถอน (เหตุผลบังคับ) / token ปลอม / หมดอายุ → 404 · งานจบเกิน linkDays วัน → 404', async () => {
    const s = await shipment({ upTo: 'DELIVERED' });
    const l = await doLink(s.doId);
    const token = tokenOf(l.url);
    await view(token).expect(200);
    await api(app, admin)
      .post(`/v1/delivery-orders/${s.doId}/tracking-link/revoke`)
      .send({ reason: 'สั้น' })
      .expect(422);
    expect(
      (
        await api(app, admin)
          .post(`/v1/delivery-orders/${s.doId}/tracking-link/revoke`)
          .send({ reason: 'ส่งลิงก์ผิดคน ขอเพิกถอน' })
          .expect(200)
      ).body,
    ).toEqual({ link: null });
    await view(token).expect(404);
    await view(`${token.slice(0, -2)}xx`).expect(404);
    await view('ml1.nope').expect(404);

    // หมดอายุตาม token
    const past = new Date(Date.now() - 60_000);
    const old = await db.magicLink.create({
      data: {
        tenantId,
        purpose: 'tracking',
        entityType: 'delivery_order',
        entityId: s.uuid,
        actions: ['tracking.view'],
        scopes: [],
        expiresAt: past,
      },
    });
    await view(encodeLinkToken(old.id, Math.floor(past.getTime() / 1000))).expect(404);

    // ส่งแล้วเกิน 30 วัน (tracking.linkDays) → ใช้ไม่ได้
    const l3 = await doLink(s.doId);
    await view(tokenOf(l3.url)).expect(200);
    await db.docStatusHistory.updateMany({
      where: { docId: s.uuid, toStatus: 'DELIVERED' },
      data: { at: new Date(Date.now() - 31 * 86_400_000) },
    });
    await view(tokenOf(l3.url)).expect(404);
  });

  it('ส่งไม่สำเร็จ → FAILED (ขั้นสุดท้าย) ไม่มีเหตุผล/โน้ตภายใน · DO ยกเลิกออกลิงก์ไม่ได้', async () => {
    const s = await shipment({ upTo: 'FAILED' });
    const r = await view(tokenOf((await doLink(s.doId)).url)).expect(200);
    expect(r.body.shipment.status).toBe('FAILED');
    expect(r.body.shipment.eta).toBeNull();
    assertPublicSafe(r.body, ['ร้านปิด', 'SHOP_CLOSED']);
    const c = await shipment({ upTo: 'NONE' });
    await db.deliveryOrder.update({ where: { id: c.uuid }, data: { status: 'CANCELLED' } });
    await api(app, admin).post(`/v1/delivery-orders/${c.doId}/tracking-link`).expect(409);
  });

  it('POD เฉพาะเมื่อบริษัทเปิด tracking.showPod: ชื่อผู้รับ + รูป/ลายเซ็นผ่าน URL มีลายเซ็น 15 นาที · ไม่มี PIN/โน้ต', async () => {
    const s = await shipment({ upTo: 'DELIVERED' });
    const doc = async (kind: string) =>
      encodeId(
        'document',
        (
          await db.storedDocument.create({
            data: {
              tenantId,
              status: 'READY',
              kind,
              mimeType: 'image/jpeg',
              sizeBytes: 1234,
              filename: `${kind}-${++seed}.jpg`,
              createdBy: 'user-test',
              fileKey: `k/${seed}`,
              sha256: 'x'.repeat(64),
            },
          })
        ).id,
      );
    await api(app, admin)
      .put(`/v1/delivery-orders/${s.doId}/pod`)
      .send({
        photoDocumentIds: [await doc('POD_PHOTO')],
        signatureDocumentId: await doc('POD_SIGNATURE'),
        receiverName: 'คุณสมศรี',
        note: 'โน้ตภายในของผู้จัดรถ',
      })
      .expect(200);
    const token = tokenOf((await doLink(s.doId)).url);
    expect((await view(token).expect(200)).body.shipment.pod).toBeNull();
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'tracking.showPod': true } })
      .expect(200);
    try {
      const r = await view(token).expect(200);
      const pod = r.body.shipment.pod;
      expect(pod).toMatchObject({ receiverName: 'คุณสมศรี', recordedAt: expect.any(String) });
      expect(pod.photos).toHaveLength(1);
      expect(pod.photos[0].url).toMatch(/\/v1\/documents\/doc_[0-9a-f]{32}\/content\?t=/);
      expect(pod.signature.url).toMatch(/sig=/);
      const ttl = Date.parse(pod.photos[0].expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(14 * 60_000);
      expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 1000);
      assertPublicSafe(r.body, ['โน้ตภายใน']);
    } finally {
      await api(app, admin)
        .patch('/v1/settings')
        .send({ values: { 'tracking.showPod': false } })
        .expect(200);
    }
  });

  it('ค่าตั้ง tracking.*: เบอร์ผิดรูป/วันนอกช่วง → 422', async () => {
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'tracking.contactPhone': '<script>' } })
      .expect(422);
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'tracking.linkDays': 5 } })
      .expect(422);
  });

  it('แยก tenant: ออก/ดูลิงก์ของ DO/ลูกค้าบริษัทอื่น → 404 · ลิงก์ลูกค้าค้น DO บริษัทอื่นไม่เจอ', async () => {
    const otherAdmin = await tokenFor(otherTenant);
    const s = await shipment({ upTo: 'NONE', po: 'PO-ISO' });
    await api(app, otherAdmin).get(`/v1/delivery-orders/${s.doId}/tracking-link`).expect(404);
    await api(app, otherAdmin).post(`/v1/delivery-orders/${s.doId}/tracking-link`).expect(404);
    const cid = encodeId('customer', s.customerId);
    await api(app, otherAdmin).post(`/v1/customers/${cid}/tracking-link`).expect(404);
    await api(app, otherAdmin)
      .post(`/v1/customers/${cid}/tracking-link/revoke`)
      .send({ reason: 'ทดสอบแยกบริษัท' })
      .expect(404);
    // ลูกค้าของบริษัทอื่น (สร้างตรงในฐาน) + ลิงก์ → ค้น PO ของบริษัทนี้ไม่เจอ
    const oc = await db.customer.create({
      data: { tenantId: otherTenant, code: 'ISO-T14', legalName: 'อื่น', taxId: validTaxId(9990) },
    });
    const ol = (
      await api(app, otherAdmin)
        .post(`/v1/customers/${encodeId('customer', oc.id)}/tracking-link`)
        .expect(201)
    ).body as { url: string };
    const ov = await view(tokenOf(ol.url)).expect(200);
    expect(ov.body.company.name).toBe('บริษัท อื่น');
    await lookup(tokenOf(ol.url), 'PO-ISO', '4507', '10.9.3.1').expect(404);
    await lookup(tokenOf(ol.url), s.doNo, '4507', '10.9.3.1').expect(404);
  });
});
