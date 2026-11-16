import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
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
import { tripSheetDocument } from '../src/modules/trip-sheets/trip-sheet.template';
import {
  SHEET_INCLUDE,
  sheetPage,
  unitNames,
} from '../src/modules/trip-sheets/trip-sheets.service';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST3-T20 ใบงานประจำวัน — PDF ใบคุมรถต่อเที่ยว/ต่อวัน ดาวน์โหลด + ส่งให้คนขับ (คัดลอกลิงก์)
 * เกณฑ์ตรวจรับ: PDF แสดงจุดแวะตามลำดับ เลข DO สินค้า ผู้ติดต่อ เป็นภาษาไทยถูกต้อง (ภาพไทยตรวจด้วย golden — trip-sheet-pdf.test.ts)
 * + snapshot (สร้างใหม่ = ไฟล์ใหม่) · audit · สิทธิ์ · แยก tenant · ลิงก์คนขับ (ไม่ login, หมดอายุ/เพิกถอน → 404)
 */
describe('trip sheets (ST3-T20)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let planner: string;
  let dispatcher: string;
  let viewer: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const addDays = (d: string, n: number) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '99 ถ.สุขุมวิท', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  async function company(tid: string, name: string) {
    const c = await db.company.create({
      data: { tenantId: tid, legalName: name, taxId: validTaxId(900 + ++seed) },
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ใบคุมรถ' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await company(tenantId, 'บริษัท ศรีไทยขนส่ง จำกัด');
    await company(otherId, 'บริษัท อื่นขนส่ง จำกัด');
    admin = await tokenFor(tenantId);
    planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-planner');
    dispatcher = await tokenFor(tenantId, SYSTEM_ROLES.dispatcher.permissions.join(' '), 'u-disp');
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
    other = await tokenFor(otherId);
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

  const run = <T>(fn: (tx: Tx) => Promise<T>, tid = tenantId) =>
    app
      .get(DbService)
      .withTenant(tid, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId: tid, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const newSite = async (name: string, contact?: object) =>
    uuid(
      'site',
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({ name: `${name} ${++seed}`, kind: 'DROPOFF', address: ADDR, contact })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async () =>
    uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9700 + seed) })
          .expect(201)
      ).body.id,
    );
  const newDo = async (origin: string, dest: string, goods: string, window?: [string, string]) => {
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: await newCustomer() },
      requestedDate: today,
      stops: [
        { type: 'PICKUP', siteId: origin },
        {
          type: 'DELIVERY',
          siteId: dest,
          ...(window ? { windowStart: window[0], windowEnd: window[1] } : {}),
        },
      ],
      lines: [{ description: goods, qty: '2.5', unitId: unitTon, weightKg: '2500' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    return { id: encodeId('deliveryOrder', d!.id), uuid: d!.id, doNo: d!.doNo! };
  };
  const newVehicle = async () =>
    (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `7${++seed % 10}-${String(1000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string; plate: string };
  const newDriver = async (vehicleId: string) =>
    (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: `สมชาย ใจดี ${++seed}`,
          phone: `089-${String(seed).padStart(3, '0')}-${String(seed).padStart(4, '0')}`,
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: '2030-03-31',
          defaultVehicleId: vehicleId,
        })
        .expect(201)
    ).body as { id: string; name: string };

  /** เที่ยวรับ 1 จุด ส่ง 2 จุด (DO 2 ใบ) บนรถที่มีคนขับประจำ วัน `date` · จัดรถแล้ว (snapshot คนขับ) */
  const trip = async (date = today) => {
    const origin = await newSite('คลังต้นทาง บางนา', { name: 'คุณวิภา', phone: '02-118-4400' });
    const d1 = await newSite('บจก. สยามพลาสติก', { name: 'คุณสมศักดิ์', phone: '081-234-5678' });
    const d2 = await newSite('ศูนย์กระจายสินค้า ชลบุรี');
    const a = await newDo(origin, d1, 'เม็ดพลาสติก', [
      `${date}T08:00:00+07:00`,
      `${date}T10:00:00+07:00`,
    ]);
    const b = await newDo(origin, d2, 'ปูนซีเมนต์ถุง');
    const v = await newVehicle();
    const drv = await newDriver(v.id);
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: date, deliveryOrderIds: [a.id, b.id], vehicleId: v.id })
        .expect(201)
    ).body as { id: string; tripNo: string; version: number };
    await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: v.id, driverId: drv.id })
      .expect(200);
    return { t, a, b, v, drv };
  };
  const sheet = (id: string, token = admin) =>
    api(app, token).post(`/v1/trips/${id}/sheet`).send({});
  const pages = (pdf: Buffer) =>
    (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const download = async (url: string) => {
    const u = new URL(url);
    const r = await api(app)
      .get(u.pathname + u.search)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    return r;
  };

  it('เกณฑ์ตรวจรับ: จุดแวะตามลำดับ + เลข DO + สินค้า + ผู้ติดต่อ (ข้อมูลหน้า + HTML ที่ render) · ใบคุมรถไม่ใช่เอกสารภาษี', async () => {
    const { t, a, b, drv } = await trip();
    const row = await db.trip.findUniqueOrThrow({
      where: { id: uuid('trip', t.id) },
      include: SHEET_INCLUDE,
    });
    const p = sheetPage(row, await run((tx) => unitNames(tx)));
    expect(p.tripNo).toBe(t.tripNo);
    expect(p.driverName).toBe(drv.name);
    expect(p.stops.map((s) => [s.sequence, s.type])).toEqual([
      [1, 'PICKUP'],
      [2, 'DELIVERY'],
      [3, 'DELIVERY'],
    ]);
    // จุดรับ = DO ทั้งสองใบ (ของที่ต้องขึ้นรถ) · จุดส่ง = DO ของจุดนั้น
    expect(p.stops[0]!.dos.map((d) => d.doNo).sort()).toEqual([a.doNo, b.doNo].sort());
    const s2 = p.stops.find((s) => s.dos.some((d) => d.doNo === a.doNo) && s.type === 'DELIVERY')!;
    expect(s2.dos).toEqual([{ doNo: a.doNo, goods: ['เม็ดพลาสติก 2.5 ตัน'] }]);
    expect(s2).toMatchObject({
      contactName: 'คุณสมศักดิ์',
      contactPhone: '081-234-5678',
      appointment: '08:00–10:00',
      address: '99 ถ.สุขุมวิท เมือง ชลบุรี 20000',
    });
    expect(p.stops[0]).toMatchObject({ contactName: 'คุณวิภา', contactPhone: '02-118-4400' });
    const html = tripSheetDocument({
      companyName: 'บริษัท ศรีไทยขนส่ง จำกัด',
      yearStyle: 'BE',
      pages: [p],
    }).body;
    for (const s of [
      'ใบคุมรถ',
      'TRIP SHEET',
      t.tripNo,
      a.doNo,
      b.doNo,
      'คุณสมศักดิ์',
      'นัด 08:00–10:00',
    ])
      expect(html).toContain(s);
    expect(html.indexOf(a.doNo, html.indexOf('<tbody>'))).toBeGreaterThan(0);
    expect(html).not.toMatch(/ใบกำกับภาษี|VAT/);
  });

  it('สร้าง PDF ต่อเที่ยว → ไฟล์ A4 ฝัง Sarabun, stored_document (kind PDF, entity trip) + downloadUrl + audit · สร้างซ้ำ = ไฟล์ใหม่ (snapshot)', async () => {
    const { t } = await trip();
    const r1 = await sheet(t.id).expect(201);
    expect(r1.body).toMatchObject({
      tripIds: [t.id],
      tripNos: [t.tripNo],
      document: { kind: 'PDF', mime: 'application/pdf', status: 'ready' },
    });
    expect(r1.body.document.filename).toBe(`ใบคุมรถ-${t.tripNo}.pdf`);
    const f = await download(r1.body.document.downloadUrl);
    expect(f.status).toBe(200);
    const pdf = f.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/FontName\s*\/[A-Z]{6}\+Sarabun/);
    expect(pages(pdf)).toBe(1);
    const doc = await db.storedDocument.findUniqueOrThrow({
      where: { id: uuid('document', r1.body.document.id) },
    });
    expect(doc).toMatchObject({
      tenantId,
      kind: 'PDF',
      entityType: 'trip',
      entityId: uuid('trip', t.id),
      createdBy: 'user-test',
    });
    expect(doc.metadata).toMatchObject({
      document: 'TRIP_SHEET',
      scope: 'TRIP',
      trips: [{ id: t.id, tripNo: t.tripNo }],
    });

    // ข้อมูลเปลี่ยน → สร้างใหม่ได้ไฟล์ใหม่ ไฟล์เดิมยังอยู่ (ไม่ทับ)
    await db.customerSite.updateMany({
      where: { tenantId, name: { startsWith: 'บจก. สยามพลาสติก' } },
      data: { contact: { name: 'คุณใหม่', phone: '080-000-0000' } },
    });
    const r2 = await sheet(t.id).expect(201);
    expect(r2.body.document.id).not.toBe(r1.body.document.id);
    expect(r2.body.document.sha256).not.toBe(r1.body.document.sha256);
    expect((await download(r1.body.document.downloadUrl)).body).toEqual(pdf);
    const audits = await db.auditLog.findMany({
      where: { action: 'trip_sheet.generated', entityId: uuid('trip', t.id) },
    });
    expect(audits).toHaveLength(2);
    expect(audits[0]!.after).toMatchObject({ scope: 'TRIP', trips: [t.tripNo] });
  }, 60_000);

  it('ใบงานประจำวัน: ทุกเที่ยวของวัน 1 เที่ยว/หน้า (ไม่รวมที่ยกเลิก/วันอื่น) · กรองรายรถ · ไม่มีเที่ยว → 422 no_trips', async () => {
    const D = addDays(today, 3);
    const x = await trip(D);
    const y = await trip(D);
    const gone = await trip(D);
    await api(app, admin)
      .post(`/v1/trips/${gone.t.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกการส่งทั้งเที่ยว' })
      .expect(200);
    await trip(addDays(today, 4));
    const r = await api(app, dispatcher).post('/v1/trip-sheets').send({ date: D }).expect(201);
    expect([...r.body.tripIds].sort()).toEqual([x.t.id, y.t.id].sort());
    expect(pages((await download(r.body.document.downloadUrl)).body)).toBe(2);
    expect(r.body.document.filename).toBe(`ใบคุมรถ-${D}.pdf`);
    const one = await api(app, dispatcher)
      .post('/v1/trip-sheets')
      .send({ date: D, vehicleId: x.v.id })
      .expect(201);
    expect(one.body.tripIds).toEqual([x.t.id]);
    const audit = await db.auditLog.findFirst({
      where: { action: 'trip_sheet.generated', entityType: 'vehicle' },
    });
    expect(audit?.after).toMatchObject({ scope: 'DAY', date: D, trips: [x.t.tripNo] });

    const none = await api(app, admin)
      .post('/v1/trip-sheets')
      .send({ date: addDays(today, 30) })
      .expect(422);
    expect(none.body.errors[0]).toMatchObject({ field: 'date', code: 'no_trips' });
    await api(app, admin).post('/v1/trip-sheets').send({ date: '2026-02-30' }).expect(422);
    await api(app, admin)
      .post('/v1/trip-sheets')
      .send({ date: D, vehicleId: 'veh_nope' })
      .expect(422);
  }, 90_000);

  it('เที่ยวยกเลิก → 409 · สิทธิ์: viewer 403 · planner พิมพ์ได้แต่ส่งให้คนขับไม่ได้ · dispatcher ได้ทั้งคู่', async () => {
    const { t } = await trip();
    await sheet(t.id, viewer).expect(403);
    await api(app, viewer).post('/v1/trip-sheets').send({ date: today }).expect(403);
    await sheet(t.id, planner).expect(201);
    await api(app, planner).post(`/v1/trips/${t.id}/sheet/driver-link`).send({}).expect(403);
    await api(app, dispatcher).post(`/v1/trips/${t.id}/sheet/driver-link`).send({}).expect(201);
    await api(app, admin)
      .post(`/v1/trips/${t.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกการส่งทั้งเที่ยว' })
      .expect(200);
    const c = await sheet(t.id).expect(409);
    expect(c.body.code).toBe('invalid_state_transition');
  }, 60_000);

  it('แยก tenant: เที่ยว/รถของบริษัทอื่น → 404 / 422 · ไฟล์ของบริษัทอื่นอ่านผ่าน /documents ไม่ได้', async () => {
    const { t, v } = await trip();
    await sheet(t.id, other).expect(404);
    await api(app, other).post(`/v1/trips/${t.id}/sheet/driver-link`).send({}).expect(404);
    const r = await api(app, other).post('/v1/trip-sheets').send({ date: today, vehicleId: v.id });
    expect(r.status).toBe(422);
    const mine = await sheet(t.id).expect(201);
    await api(app, other).get(`/v1/documents/${mine.body.document.id}`).expect(404);
  }, 60_000);

  it('ส่งให้คนขับ (คัดลอกลิงก์): ลิงก์เปิด PDF ไม่ต้อง login (inline) อายุ 72 ชม. + audit · เพิกถอน/ผิด → 404', async () => {
    const { t, drv } = await trip();
    const r = await api(app, dispatcher)
      .post(`/v1/trips/${t.id}/sheet/driver-link`)
      .send({})
      .expect(201);
    expect(r.body.url).toMatch(/\/v1\/public\/trip-sheets\/ml1\./);
    const hours = (Date.parse(r.body.expiresAt) - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);
    const open = await download(r.body.url);
    expect(open.status).toBe(200);
    expect(open.headers['content-type']).toBe('application/pdf');
    expect(open.headers['content-disposition']).toMatch(/^inline;/);
    expect(open.headers['cache-control']).toBe('private, no-store');
    expect((open.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const shared = await db.auditLog.findFirstOrThrow({
      where: { action: 'trip_sheet.shared', entityId: uuid('trip', t.id) },
    });
    expect(shared.actorId).toBe('u-disp');
    expect(shared.after).toMatchObject({ channel: 'COPY_LINK', driver: drv.name });
    const link = await db.magicLink.findFirstOrThrow({
      where: { purpose: 'trip_sheet', entityId: uuid('document', r.body.document.id) },
    });
    expect(link).toMatchObject({ entityType: 'stored_document', actions: ['sheet.view'] });

    const bad = r.body.url.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'));
    expect((await download(bad)).status).toBe(404);
    await db.magicLink.update({
      where: { id: link.id },
      data: { revokedAt: new Date(), revokedReason: 'ทดสอบ' },
    });
    expect((await download(r.body.url)).status).toBe(404);
  }, 60_000);
});
