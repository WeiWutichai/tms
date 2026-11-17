import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST4-T04 อัปเดตสถานะผ่านเว็บ (docs/04 E2) — เกณฑ์ตรวจรับ: บันทึกย้อนเวลาได้ (`occurredAt`) และเห็นชื่อผู้บันทึกใน timeline
 * API: `GET /v1/trips/{id}/events` (ไทม์ไลน์ทั้งเที่ยว + ชื่อผู้บันทึก) และ TripDto `stops[].arrivedAt/departedAt/outcome/lastEventId`
 * ลำดับที่หน้าเว็บส่ง: ถึงจุด → ปิดงาน · "ออกจากจุด" = DEPART ของจุดถัดไป (docs/01 §3.9) · ส่งไม่สำเร็จจุดที่เหลือ = FAIL ทีละจุด
 */
describe('trip timeline / web status updates (ST4-T04)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let staff: string;
  let staffId: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ไทม์ไลน์' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(911) },
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
    const u = await db.appUser.create({
      data: { tenantId, email: 'wh@timeline.test', name: 'สมพร หน้าคลัง', status: 'ACTIVE' },
    });
    staffId = u.id;
    staff = await tokenFor(tenantId, 'trips:read trips:dispatch master:read', u.id);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = us.find((x) => x.code === 'TON')!.id;
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const newSite = async () =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;

  /** เที่ยว 1 DO (รับ → ส่ง) ที่ปล่อยรถแล้ว */
  const dispatchedTrip = async () => {
    const cust = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9800 + seed) })
        .expect(201)
    ).body.id as string;
    const so = (
      await api(app, admin)
        .post('/v1/orders')
        .send({
          customer: { id: cust },
          requestedDate: today,
          stops: [
            { type: 'PICKUP', siteId: await newSite() },
            { type: 'DELIVERY', siteId: await newSite() },
          ],
          lines: [{ description: 'ปูนซีเมนต์', qty: '2', unitId: unitTon, weightKg: '2000' }],
        })
        .expect(201)
    ).body.id as string;
    const doId = (await api(app, admin).get(`/v1/delivery-orders?orderId=${so}`).expect(200)).body
      .data[0].id as string;
    const veh = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `7${++seed % 10}-${String(2000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body.id as string;
    const n = ++seed;
    const drv = (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: `คนขับ ${n}`,
          phone: `089-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: '2030-03-31',
          defaultVehicleId: veh,
        })
        .expect(201)
    ).body.id as string;
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [doId], vehicleId: veh })
        .expect(201)
    ).body;
    const body = { vehicleId: veh, driverId: drv, dispatch: true };
    const r = await api(app, admin).post(`/v1/trips/${t.id}/assign`).send(body);
    if (r.status !== 200) {
      expect(r.status).toBe(409);
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          ...body,
          ruleKeys: r.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบไทม์ไลน์เที่ยวรถ',
        })
        .expect(200);
    }
    const full = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    expect(full.status).toBe('DISPATCHED');
    return full as { id: string; stops: { id: string; sequence: number; type: string }[] };
  };

  /** เวลาไทยย้อนหลัง `min` นาที แบบที่หน้าเว็บส่ง (`+07:00`) */
  const bkkAgo = (min: number) => {
    const d = new Date(Date.now() - min * 60_000 + 7 * 3600_000);
    return `${d.toISOString().slice(0, 16)}:00+07:00`;
  };
  const rec = (tok: string, stop: string, action: string, at: string, extra: object = {}) =>
    api(app, tok)
      .post(`/v1/stops/${stop}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: at, ...extra });
  type Ev = {
    id: string;
    stopId: string;
    type: string;
    outcome: string | null;
    occurredAt: string;
    source: string;
    recordedBy: string | null;
    recordedByName: string | null;
    seqStatus: string;
    counted: boolean;
    flags: string[];
  };
  const timeline = async (id: string, tok = staff) =>
    (await api(app, tok).get(`/v1/trips/${id}/events`).expect(200)).body.data as Ev[];

  it('เกณฑ์ตรวจรับ: บันทึกแทนคนขับย้อนเวลา (ถึง → ปิดงาน → ออกจากจุด = DEPART จุดถัดไป) แล้วเห็นชื่อผู้บันทึกในไทม์ไลน์', async () => {
    const t = await dispatchedTrip();
    const [pickup, drop] = t.stops;
    expect(await timeline(t.id)).toEqual([]);

    const v0 = (await api(app, staff).get(`/v1/trips/${t.id}`).expect(200)).headers.etag;
    await rec(staff, pickup!.id, 'arrive', bkkAgo(180)).expect(201);
    await rec(staff, pickup!.id, 'complete', bkkAgo(150), { outcome: 'DELIVERED' }).expect(201);
    const v1 = (await api(app, staff).get(`/v1/trips/${t.id}`).expect(200)).headers.etag;
    expect(v1).not.toBe(v0);
    // "ออกจากจุด" ที่จุดรับ = DEPART ของจุดส่ง (มุ่งหน้าไปจุดถัดไป) — สถานะเที่ยวไม่เปลี่ยน แต่ departedAt ของจุดรับเปลี่ยน
    // → ETag ต้องเปลี่ยน (GET แบบมีเงื่อนไขไม่ได้ 304 + จุดเก่า)
    await rec(staff, drop!.id, 'depart', bkkAgo(140)).expect(201);
    const r304 = await api(app, staff).get(`/v1/trips/${t.id}`).set('If-None-Match', v1!);
    expect(r304.status).toBe(200);
    expect(r304.body.stops[0].departedAt).toBe(new Date(bkkAgo(140)).toISOString());
    await rec(staff, drop!.id, 'arrive', bkkAgo(60)).expect(201);
    await rec(staff, drop!.id, 'complete', bkkAgo(30), { outcome: 'PARTIAL' }).expect(201);

    const tl = await timeline(t.id);
    expect(tl.map((e) => [e.stopId, e.type])).toEqual([
      [pickup!.id, 'ARRIVE'],
      [pickup!.id, 'COMPLETE'],
      [drop!.id, 'DEPART'],
      [drop!.id, 'ARRIVE'],
      [drop!.id, 'COMPLETE'],
    ]);
    for (const e of tl) {
      expect(e.recordedByName).toBe('สมพร หน้าคลัง');
      expect(e.recordedBy).toBe(staffId);
      expect(e.source).toBe('WEB');
      expect(e.seqStatus).toBe('APPLIED');
      expect(e.counted).toBe(true);
      expect(e.flags).toEqual([]);
    }
    // เวลาที่ย้อน = เวลาเกิดจริง (ไม่ใช่เวลาที่กดบันทึก)
    expect(new Date(tl[0]!.occurredAt).toISOString()).toBe(new Date(bkkAgo(180)).toISOString());

    const full = (await api(app, staff).get(`/v1/trips/${t.id}`).expect(200)).body;
    expect(full.status).toBe('COMPLETED');
    const [p, d] = full.stops;
    expect(p.status).toBe('COMPLETED');
    expect(p.outcome).toBe('DELIVERED');
    expect(p.arrivedAt).toBe(new Date(bkkAgo(180)).toISOString());
    expect(p.departedAt).toBe(new Date(bkkAgo(140)).toISOString());
    expect(p.lastEventId).toBe(tl[1]!.id);
    expect(d.status).toBe('COMPLETED');
    expect(d.outcome).toBe('PARTIAL');
    expect(d.arrivedAt).toBe(new Date(bkkAgo(60)).toISOString());
    expect(d.departedAt).toBe(new Date(bkkAgo(30)).toISOString());
  });

  it('ปิดงานโดยไม่ถึงจุด → ธงขัดลำดับในไทม์ไลน์ (เว็บต้องส่งถึงจุดก่อน) · ส่งไม่สำเร็จจุดที่เหลือ → เที่ยวจบ', async () => {
    const t = await dispatchedTrip();
    const [pickup, drop] = t.stops;
    await rec(staff, pickup!.id, 'complete', bkkAgo(90), { outcome: 'DELIVERED' }).expect(201);
    let tl = await timeline(t.id);
    expect(tl[0]!.seqStatus).toBe('CONFLICT');
    expect(tl[0]!.flags).toEqual(['SEQUENCE_CONFLICT']);
    // ส่ง "ถึงจุด" ย้อนเวลาก่อนปิดงาน → ธงหายเอง
    await rec(staff, pickup!.id, 'arrive', bkkAgo(100)).expect(201);
    tl = await timeline(t.id);
    expect(tl.map((e) => [e.type, e.seqStatus, e.flags.length])).toEqual([
      ['ARRIVE', 'APPLIED', 0],
      ['COMPLETE', 'APPLIED', 0],
    ]);

    // ส่งไม่สำเร็จจุดที่เหลือ (FAIL ทีละจุด เหตุผลบังคับ)
    const rsn = await db.reasonCode.findFirstOrThrow({
      where: { tenantId, category: 'DELIVERY_FAILED', code: 'SHOP_CLOSED' },
    });
    await rec(staff, drop!.id, 'fail', bkkAgo(10)).expect(422);
    await rec(staff, drop!.id, 'fail', bkkAgo(10), {
      reasonCodeId: encodeId('reasonCode', rsn.id),
      note: 'ร้านปิด โทรไม่รับสาย',
    }).expect(201);
    const full = (await api(app, staff).get(`/v1/trips/${t.id}`).expect(200)).body;
    expect(full.status).toBe('COMPLETED');
    expect(full.stops[1].status).toBe('FAILED');
    expect(full.stops[1].outcome).toBe('FAILED');
    expect(full.stops[1].arrivedAt).toBeNull();
    expect(full.stops[1].departedAt).toBeNull();
    tl = await timeline(t.id);
    expect(tl[2]).toMatchObject({ type: 'FAIL', recordedByName: 'สมพร หน้าคลัง' });
  });

  it('สิทธิ์และการแยกบริษัท: ไม่มี trips:read → 403 · เที่ยวบริษัทอื่น/ไม่มีจริง → 404 · ไม่มี trips:dispatch บันทึกไม่ได้', async () => {
    const t = await dispatchedTrip();
    const noRead = await tokenFor(tenantId, 'orders:read');
    await api(app, noRead).get(`/v1/trips/${t.id}/events`).expect(403);
    const readOnly = await tokenFor(tenantId, 'trips:read');
    await rec(readOnly, t.stops[0]!.id, 'arrive', bkkAgo(5)).expect(403);
    await api(app, readOnly).get(`/v1/trips/${t.id}/events`).expect(200);

    const other = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await api(app, await tokenFor(other))
      .get(`/v1/trips/${t.id}/events`)
      .expect(404);
    await api(app, admin)
      .get(`/v1/trips/${encodeId('trip', randomUUID())}/events`)
      .expect(404);
    expect(uuid('trip', t.id)).toBeTruthy();
  });
});
