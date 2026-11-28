import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient, type TripStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPlatformToken } from '../src/auth/tokens';
import { Clock } from '../src/common/clock';
import { encodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import {
  bangkokPeriod,
  finalizablePeriod,
  periodRange,
} from '../src/modules/usage/active-vehicles';
import { UsageFinalizeService } from '../src/modules/usage/usage-finalize.service';
import { plateNorm } from '../src/modules/vehicles/vehicles.service';
import { USAGE_ADJUST_CUSTOMER_REASON } from '../src/platform/platform-usage.controller';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

/**
 * P1-ST1-T06 นับรถ active (spec/01 §7 PLT-070–075 · plan/13 R-05 / D-41)
 * เกณฑ์ตรวจรับ: รถ 1 คันมี 10 เที่ยวที่ออกวิ่ง + อีกคันมีแค่ร่าง → vehicles.active = 1 · "กข-1234" กับ "กข1234" = 1 คัน ·
 * sandbox ไม่ถูกนับ · เที่ยวคร่อมเที่ยงคืนสิ้นเดือนนับตามเวลาไทย · ลบเมื่อย้อนสถานะก่อน finalize · finalize วันที่ 1 02:00 ·
 * หลัง finalize แก้ได้เฉพาะ Console การเงิน + เหตุผล (เหตุผลจริงไม่ถึงลูกค้า)
 */

describe('รถ active: เดือนเวลาไทย (ฟังก์ชันบริสุทธิ์)', () => {
  it('bangkokPeriod / finalizablePeriod / periodRange', () => {
    expect(bangkokPeriod(new Date('2026-10-31T16:59:59Z'))).toBe('2026-10'); // 23:59:59 ไทย
    expect(bangkokPeriod(new Date('2026-10-31T17:00:00Z'))).toBe('2026-11'); // 00:00 ไทย 1 พ.ย.
    // ปิดยอด ต.ค. ได้ตั้งแต่ 1 พ.ย. 02:00 ไทย (= 31 ต.ค. 19:00Z)
    expect(finalizablePeriod(new Date('2026-10-31T18:59:59Z'))).toBe('2026-09');
    expect(finalizablePeriod(new Date('2026-10-31T19:00:00Z'))).toBe('2026-10');
    expect(finalizablePeriod(new Date('2027-01-01T05:00:00+07:00'))).toBe('2026-12');
    const r = periodRange('2026-12');
    expect(r.start.toISOString()).toBe('2026-11-30T17:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-12-31T17:00:00.000Z');
  });
});

describe('รถ active ต่อเดือน (P1-ST1-T06)', () => {
  let app: NestExpressApplication;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const staff: Record<string, string> = {};
  let n = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    app.get(Clock).set(new Date('2026-11-15T10:00:00+07:00'));
    for (const role of ['SUPER_ADMIN', 'SUPPORT', 'BILLING'] as const) {
      const u = await db.platformUser.create({
        data: {
          email: `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@innovera.test`,
          name: `ทีม ${role}`,
          role,
          passwordHash: 'x',
          totpSecret: 'x',
        },
      });
      staff[role] = await signPlatformToken({ sub: u.id, role, tv: u.tokenVersion });
    }
  });
  afterAll(async () => {
    app.get(Clock).set(null);
    await app.close();
    await owner.platformSetting.deleteMany({});
    await owner.$disconnect();
    await db.$disconnect();
  });

  async function vehicle(tenantId: string, plate: string, province = 'TH-10') {
    const vt = await db.vehicleType.create({
      data: { tenantId, code: `VT-${++n}`, nameTh: `หกล้อ ${n}`, vehicleClass: '6W' },
    });
    const norm = plate.replace(/[\s\-.]/g, '');
    return db.vehicle.create({
      data: {
        tenantId,
        plate,
        plateProvince: province,
        plateKey: `${norm}|${province}`,
        plateNorm: norm,
        vehicleTypeId: vt.id,
        ownership: 'OWN',
      },
    });
  }

  /** เที่ยวร่าง (PLANNING) ที่ระบุรถแล้ว — snapshot ทะเบียนตามที่ส่ง (เอกสารอาจพิมพ์ต่างจาก master) */
  async function trip(tenantId: string, v: { id: string; vehicleTypeId: string }, plate: string) {
    return db.trip.create({
      data: {
        tenantId,
        tripNo: `TRP-AV-${++n}`,
        tripDate: new Date('2026-11-01'),
        vehicleId: v.id,
        vehicleTypeId: v.vehicleTypeId,
        vehiclePlateSnapshot: plate,
        vehicleTypeSnapshot: 'หกล้อ',
      },
    });
  }

  /** ย้ายสถานะเที่ยวแบบที่ service ทำ (trigger ของ DB เป็นตัวนับ — ครอบทุกทาง) */
  const move = (id: string, status: TripStatus, extra: Record<string, unknown> = {}) =>
    db.trip.update({ where: { id }, data: { status, ...extra } });
  const dispatch = (id: string, at: string) =>
    move(id, 'DISPATCHED', { dispatchedAt: new Date(at) });
  const cancel = (id: string) =>
    move(id, 'CANCELLED', { cancelledAt: new Date(), cancelReason: 'ลูกค้ายกเลิกงานกะทันหัน' });
  /** tenant ที่สร้างก่อนเดือนที่ทดสอบ (ปิดยอดนับเฉพาะ tenant ที่สร้างก่อนสิ้นเดือน) */
  const oldTenant = async () => {
    const t = await createTenant(db);
    await db.tenant.update({ where: { id: t.id }, data: { createdAt: new Date('2026-10-15') } });
    return t;
  };
  const rows = (tenantId: string, period?: string) =>
    db.activeVehicleUsage.findMany({
      where: { tenantId, ...(period ? { period } : {}) },
      orderBy: { firstCountedAt: 'asc' },
    });

  it('เกณฑ์ตรวจรับ: รถ 1 คันมี 10 เที่ยวที่ออกวิ่ง + อีกคันมีแค่ร่าง → vehicles.active = 1 · ลูกค้าเห็นทะเบียน + เที่ยวแรก', async () => {
    const t = await createTenant(db);
    const v1 = await vehicle(t.id, '70-1001');
    const v2 = await vehicle(t.id, '70-2002');
    const ten = [];
    for (let i = 0; i < 10; i++) ten.push(await trip(t.id, v1, '70-1001'));
    // วิ่ง 10 เที่ยว (บางเที่ยวปิดงานแล้ว) — เที่ยวแรกที่ทำให้นับ = ที่ปล่อยรถก่อนสุด
    for (const [i, x] of ten.entries()) {
      await dispatch(x.id, `2026-11-${String(10 - i).padStart(2, '0')}T08:00:00+07:00`);
      if (i % 2) {
        await move(x.id, 'IN_PROGRESS');
        await move(x.id, 'COMPLETED', { completedAt: new Date('2026-11-12T10:00:00+07:00') });
      }
    }
    // อีกคัน: มีแค่ร่าง/จัดรถ — ไม่นับ
    await trip(t.id, v2, '70-2002');
    const assigned = await trip(t.id, v2, '70-2002');
    await move(assigned.id, 'ASSIGNED');

    const r = await rows(t.id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      period: '2026-11',
      plateNormalized: '701001',
      plate: '70-1001',
      vehicleId: v1.id,
      subcontract: false,
      rule: 'trip_started',
      source: 'auto',
      firstTripId: ten[9]!.id, // ปล่อยรถ 1 พ.ย.
    });
    expect(r[0]!.firstCountedAt.toISOString()).toBe('2026-11-01T01:00:00.000Z');

    const tok = await tokenFor(t.id);
    const res = await api(app, tok).get('/v1/usage/active-vehicles').expect(200);
    expect(res.body).toMatchObject({
      period: '2026-11', // ค่าเริ่มต้น = เดือนนี้ตามนาฬิกา
      status: 'open',
      finalizedAt: null,
      activeVehicles: 1,
      own: 1,
      subcontract: 0,
      limit: expect.any(Number),
    });
    expect(res.body.data).toEqual([
      {
        plate: '70-1001',
        plateMissing: false,
        subcontract: false,
        vehicleType: 'หกล้อ',
        carrierName: null,
        trips: 10,
        firstTripId: encodeId('trip', ten[9]!.id),
        firstTripNo: ten[9]!.tripNo,
        firstCountedAt: '2026-11-01T01:00:00.000Z',
        adjusted: false,
      },
    ]);
    // แถบโควตาบนหน้าทะเบียนรถ: รถในทะเบียน 2 คัน แต่รถ active = 1 (D68-14)
    const sum = (await api(app, tok).get('/v1/vehicles/summary').expect(200)).body;
    expect(sum.quota).toMatchObject({ used: 2, active: 1 });
    // เดือนอื่นว่าง · period ผิดรูปแบบ → 422
    expect(
      (await api(app, tok).get('/v1/usage/active-vehicles?period=2026-10').expect(200)).body,
    ).toMatchObject({ activeVehicles: 0, data: [] });
    await api(app, tok).get('/v1/usage/active-vehicles?period=2026-13').expect(422);
    // tenant อื่นไม่เห็น (RLS)
    const other = await createTenant(db);
    const o = (await api(app, await tokenFor(other.id)).get('/v1/usage/active-vehicles')).body;
    expect(o).toMatchObject({ activeVehicles: 0, data: [] });
  });

  it('เกณฑ์ตรวจรับ: "กข-1234" / "กข1234" / "กข 1234" / เลขไทย = 1 คัน (normalize ทะเบียนบนเอกสาร — PLT-072)', async () => {
    const t = await createTenant(db);
    const a = await vehicle(t.id, 'กข-1234');
    const b = await vehicle(t.id, 'กข1234', 'TH-11'); // master อีกแถว (ต่างจังหวัด) — ทะเบียนเดียวกันบนเอกสาร
    // review L4: NBSP / ช่องว่าง Unicode / en-dash / em-dash / minus / zero-width / จุด — SQL = JS
    const plates = [
      'กข-1234',
      'กข1234',
      'กข 1234',
      'กข-๑๒๓๔',
      'กข\u00A01234',
      'กข\u20131234',
      'กข \u2014 1234',
      'กข\u22121234',
      'กข\u200B12.34',
      'กข\u30001234',
    ];
    for (const p of plates) expect(plateNorm(p)).toBe('กข1234');
    for (const [i, p] of plates.entries()) {
      const x = await trip(t.id, i % 2 ? b : a, p);
      await dispatch(x.id, `2026-11-${String(i + 2).padStart(2, '0')}T09:00:00+07:00`);
    }
    const r = await rows(t.id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ plateNormalized: 'กข1234', plate: 'กข-1234' });
    const res = (await api(app, await tokenFor(t.id)).get('/v1/usage/active-vehicles')).body;
    expect(res.activeVehicles).toBe(1);
    expect(res.data[0].trips).toBe(plates.length);
  });

  it('เกณฑ์ตรวจรับ: sandbox ไม่ถูกนับ (PLT-071)', async () => {
    const live = await createTenant(db);
    const sb = await db.tenant.create({
      data: { name: 'sandbox AV', mode: 'test', liveTenantId: live.id, planCode: 'ent' },
    });
    const v = await vehicle(sb.id, '71-0001');
    const x = await trip(sb.id, v, '71-0001');
    await dispatch(x.id, '2026-11-03T08:00:00+07:00');
    expect(await rows(sb.id)).toHaveLength(0);
    // ปิดยอดก็ไม่สร้างแถวให้ sandbox
    await app.get(UsageFinalizeService).scheduleDue(new Date('2026-12-01T02:00:00+07:00'));
    expect(await db.usageRecord.count({ where: { tenantId: sb.id } })).toBe(0);
  });

  it('เกณฑ์ตรวจรับ: เที่ยวคร่อมเที่ยงคืนสิ้นเดือนนับตามเวลาไทย (ทั้งสองกติกา)', async () => {
    const t = await createTenant(db);
    const v1 = await vehicle(t.id, '72-0001');
    const v2 = await vehicle(t.id, '72-0002');
    // ปล่อยรถ 31 ต.ค. 23:30 ไทย (= 16:30Z) ปิดงาน 1 พ.ย. 01:00 ไทย → trip_started = ต.ค.
    const x1 = await trip(t.id, v1, '72-0001');
    await dispatch(x1.id, '2026-10-31T23:30:00+07:00');
    await move(x1.id, 'IN_PROGRESS');
    await move(x1.id, 'COMPLETED', { completedAt: new Date('2026-11-01T01:00:00+07:00') });
    // ปล่อยรถ 1 พ.ย. 00:10 ไทย (= 31 ต.ค. 17:10Z — วันเดียวกันตาม UTC) → พ.ย.
    const x2 = await trip(t.id, v2, '72-0002');
    await dispatch(x2.id, '2026-11-01T00:10:00+07:00');
    expect((await rows(t.id)).map((r) => [r.plate, r.period])).toEqual([
      ['72-0001', '2026-10'],
      ['72-0002', '2026-11'],
    ]);

    // กติกา doc_closed (ค่าตั้ง usage.activeVehicleRule — PO เปลี่ยนได้โดยไม่แก้โค้ด): นับตามเวลาปิดงาน
    await owner.platformSetting.create({
      data: { key: 'usage.activeVehicleRule', value: 'doc_closed' },
    });
    try {
      const t2 = await createTenant(db);
      const w = await vehicle(t2.id, '73-0001');
      const y = await trip(t2.id, w, '73-0001');
      await dispatch(y.id, '2026-10-31T23:30:00+07:00');
      expect(await rows(t2.id)).toHaveLength(0); // ยังไม่ปิดงาน
      await move(y.id, 'IN_PROGRESS');
      await move(y.id, 'COMPLETED', { completedAt: new Date('2026-11-01T01:00:00+07:00') });
      const r = await rows(t2.id);
      expect(r.map((x) => [x.period, x.rule])).toEqual([['2026-11', 'doc_closed']]);
      const res = (
        await api(app, await tokenFor(t2.id)).get('/v1/usage/active-vehicles?period=2026-11')
      ).body;
      expect(res.data[0].trips).toBe(1);
    } finally {
      await owner.platformSetting.deleteMany({ where: { key: 'usage.activeVehicleRule' } });
    }
  });

  it('ย้อนสถานะก่อน finalize: ยกเลิกหลังปล่อยรถ → นำออก (PLT-075) · มีเที่ยวอื่นของทะเบียนเดียวกัน → เที่ยวแรกเลื่อน', async () => {
    const t = await createTenant(db);
    const v = await vehicle(t.id, '74-0001');
    const a = await trip(t.id, v, '74-0001');
    const b = await trip(t.id, v, '74-0001');
    await dispatch(a.id, '2026-11-03T08:00:00+07:00');
    await dispatch(b.id, '2026-11-05T08:00:00+07:00');
    expect((await rows(t.id))[0]!.firstTripId).toBe(a.id);
    await cancel(a.id);
    const r = await rows(t.id);
    expect(r).toHaveLength(1);
    expect(r[0]!.firstTripId).toBe(b.id);
    expect(r[0]!.firstCountedAt.toISOString()).toBe('2026-11-05T01:00:00.000Z');
    await cancel(b.id);
    expect(await rows(t.id)).toHaveLength(0);
    // ทะเบียนบนเที่ยวเปลี่ยน (ก่อนปล่อยรถเท่านั้นในระบบจริง — test ตรง ๆ ที่ trigger): ย้ายการนับไปทะเบียนใหม่
    const v2 = await vehicle(t.id, '74-0002');
    const c = await trip(t.id, v, '74-0001');
    await dispatch(c.id, '2026-11-06T08:00:00+07:00');
    await db.trip.update({
      where: { id: c.id },
      data: { vehicleId: v2.id, vehiclePlateSnapshot: '74-0002' },
    });
    expect((await rows(t.id)).map((x) => x.plateNormalized)).toEqual(['740002']);
  });

  it('finalize วันที่ 1 02:00 ไทย → usage_record · หลังปิดยอดเที่ยวที่ย้อน/เพิ่มย้อนหลังไม่เปลี่ยนยอด · Console การเงินปรับได้ + เหตุผล', async () => {
    const t = await oldTenant();
    const fin = app.get(UsageFinalizeService);
    const v1 = await vehicle(t.id, '75-0001');
    const v2 = await vehicle(t.id, '75-0002');
    const v3 = await vehicle(t.id, '75-0003');
    const a = await trip(t.id, v1, '75-0001');
    const b = await trip(t.id, v2, '75-0002');
    await dispatch(a.id, '2026-11-20T08:00:00+07:00');
    await dispatch(b.id, '2026-11-21T08:00:00+07:00');
    const rec = () =>
      db.usageRecord.findUnique({
        where: {
          tenantId_metric_period: { tenantId: t.id, metric: 'vehicles.active', period: '2026-11' },
        },
      });
    const tid = encodeId('tenant', t.id);
    const as = (role: string) => api(app, staff[role]!);
    const url = `/v1/platform/tenants/${tid}/usage/active-vehicles`;

    // ก่อนปิดยอด: Console ปรับไม่ได้ (ระบบนับเอง)
    const open = (await as('SUPPORT').get(`${url}?period=2026-11`).expect(200)).body;
    expect(open).toMatchObject({ status: 'open', activeVehicles: 2 });
    await as('BILLING')
      .post(`${url}/${open.data[0].id}/exclude`)
      .send({ reason: 'ทดสอบปรับก่อนปิดยอดเดือน' })
      .expect(409);

    // 1 ธ.ค. 01:59 ไทย ยังไม่ปิด · 02:00 ปิด
    await fin.scheduleDue(new Date('2026-12-01T01:59:00+07:00'));
    expect(await rec()).toBeNull();
    expect(await fin.scheduleDue(new Date('2026-12-01T02:00:00+07:00'))).toBeGreaterThan(0);
    const r1 = await rec();
    expect(r1).toMatchObject({ status: 'finalized', detail: expect.objectContaining({ own: 2 }) });
    expect(Number(r1!.value)).toBe(2);
    expect(r1!.finalizedAt!.toISOString()).toBe('2026-11-30T19:00:00.000Z');
    // รันซ้ำไม่สร้างซ้ำ
    expect(await fin.finalize(t.id, '2026-11')).toBe(false);

    // หลังปิดยอด: ยกเลิกเที่ยว / เที่ยวย้อนหลังในเดือนที่ปิด → ไม่แตะ
    await cancel(b.id);
    const late = await trip(t.id, v3, '75-0003');
    await dispatch(late.id, '2026-11-25T08:00:00+07:00');
    expect((await rows(t.id, '2026-11')).map((r) => r.plate)).toEqual(['75-0001', '75-0002']);
    const tok = await tokenFor(t.id);
    const cust = (await api(app, tok).get('/v1/usage/active-vehicles?period=2026-11')).body;
    expect(cust).toMatchObject({ status: 'finalized', activeVehicles: 2 });

    // สิทธิ์: SUPPORT ปรับไม่ได้ · เหตุผลสั้น → 422
    const row2 = (await rows(t.id, '2026-11')).find((r) => r.plate === '75-0002')!;
    const rid = encodeId('activeVehicleUsage', row2.id);
    const why = 'ลูกค้าแจ้งว่าเที่ยวนี้ยกเลิกก่อนรถออกจริง (ตั๋ว #881)';
    await as('SUPPORT').post(`${url}/${rid}/exclude`).send({ reason: why }).expect(403);
    await as('BILLING').post(`${url}/${rid}/exclude`).send({ reason: 'สั้น' }).expect(422);
    // ลูกค้าเรียก route ของ Console ไม่ได้
    await api(app, tok).post(`${url}/${rid}/exclude`).send({ reason: why }).expect(401);

    // การเงินตัดออก → ยอด 1 · ลูกค้าไม่เห็นแถวที่ตัด · เหตุผลจริงอยู่ใน platform_audit_log เท่านั้น
    const ex = (await as('BILLING').post(`${url}/${rid}/exclude`).send({ reason: why }).expect(200))
      .body;
    expect(ex).toMatchObject({ status: 'finalized', activeVehicles: 1 });
    expect(ex.data.find((d: { id: string }) => d.id === rid)).toMatchObject({ excluded: true });
    await as('BILLING').post(`${url}/${rid}/exclude`).send({ reason: why }).expect(409); // ตัดซ้ำ
    expect(Number((await rec())!.value)).toBe(1);
    expect((await rec())!.detail).toMatchObject({ adjusted: true, own: 1 });
    const c2 = (await api(app, tok).get('/v1/usage/active-vehicles?period=2026-11')).body;
    expect(c2.activeVehicles).toBe(1);
    expect(c2.data.map((d: { plate: string }) => d.plate)).toEqual(['75-0001']);
    const pa = await db.platformAuditLog.findFirst({
      where: { action: 'usage.active_vehicle_excluded', entityId: rid },
    });
    expect(pa).toMatchObject({ reason: why });
    const ta = await db.auditLog.findMany({
      where: { tenantId: t.id, action: 'platform.usage_adjusted' },
    });
    expect(ta).toHaveLength(1);
    expect(ta[0]!.reason).toBe(USAGE_ADJUST_CUSTOMER_REASON);
    expect(JSON.stringify({ ...ta[0], seq: undefined })).not.toContain('ตั๋ว #881');

    // เพิ่มทะเบียนที่ตกหล่น (normalize — "75 0003" = "75-0003") → ยอด 2 · ซ้ำ → 409 · ลูกค้าเห็นป้ายปรับโดยผู้ให้บริการ
    const add = (plate: string) =>
      as('BILLING')
        .post(url)
        .send({ period: '2026-11', plate, reason: 'เที่ยวบันทึกนอกระบบ ลูกค้ายืนยันว่าวิ่งจริง' });
    expect((await add('75 0003').expect(200)).body.activeVehicles).toBe(2);
    await add('75-0003').expect(409);
    await add('?own:abc').expect(422); // review L5: "?…" = ตัวนับเที่ยวไม่มีทะเบียน (ระบบสร้างเท่านั้น)
    await as('BILLING')
      .post(url)
      .send({ period: '2026-12', plate: '75-0009', reason: 'เดือนที่ยังไม่ปิดยอดต้องไม่ได้' })
      .expect(409);
    const c3 = (await api(app, tok).get('/v1/usage/active-vehicles?period=2026-11')).body;
    expect(c3.data.find((d: { plate: string }) => d.plate === '75 0003')).toMatchObject({
      adjusted: true,
      firstTripId: null,
    });
    // นับกลับ
    const inc = (
      await as('SUPER_ADMIN')
        .post(`${url}/${rid}/include`)
        .send({ reason: 'ตรวจซ้ำแล้วรถวิ่งจริงในเดือนนี้' })
        .expect(200)
    ).body;
    expect(inc.activeVehicles).toBe(3);
    expect(Number((await rec())!.value)).toBe(3);
    // แถวของ tenant อื่น → 404
    const other = await createTenant(db);
    await as('BILLING')
      .post(
        `/v1/platform/tenants/${encodeId('tenant', other.id)}/usage/active-vehicles/${rid}/exclude`,
      )
      .send({ reason: why })
      .expect(404);
  });

  it('review M1: worker หยุดข้ามวันที่ 1 สองครั้ง → ปิดยอดครบทั้งสองเดือน (ไม่ก่อนเดือนเริ่มนับ / เดือนที่สร้าง tenant)', async () => {
    const t = await oldTenant();
    const v = await vehicle(t.id, '77-0001');
    const a = await trip(t.id, v, '77-0001');
    const b = await trip(t.id, v, '77-0001');
    await dispatch(a.id, '2026-11-10T08:00:00+07:00');
    await dispatch(b.id, '2026-12-10T08:00:00+07:00');
    const late = await createTenant(db); // สร้างจริงวันนี้ → ไม่มีเดือน ต.ค.
    await app.get(UsageFinalizeService).scheduleDue(new Date('2027-01-01T03:00:00+07:00'));
    const recs = await db.usageRecord.findMany({
      where: { tenantId: t.id, metric: 'vehicles.active' }, // P1-ST1-T07 ปิดเมตริกอื่นในรอบเดียวกัน
      orderBy: { period: 'asc' },
    });
    expect(recs.map((r) => [r.period, r.status, Number(r.value)])).toEqual([
      ['2026-11', 'finalized', 1],
      ['2026-12', 'finalized', 1],
    ]);
    expect(await db.usageRecord.count({ where: { tenantId: late.id, period: '2026-10' } })).toBe(0);
  });

  it('review M2/M3/L2: นับใหม่ทั้งเดือน (backfill) · เที่ยวปิดงานที่ไม่มี dispatched_at ยังนับ · เลื่อนเวลาปล่อยรถในเดือน → เที่ยวแรกเลื่อน', async () => {
    const t = await createTenant(db);
    const v = await vehicle(t.id, '78-0001');
    const w = await vehicle(t.id, '78-0002');
    // M3: ข้อมูลเก่า/นำเข้า — ปิดงานแล้วแต่ไม่มีเวลาปล่อยรถ
    const x = await trip(t.id, v, '78-0001');
    await move(x.id, 'COMPLETED', { completedAt: new Date('2026-11-08T10:00:00+07:00') });
    expect((await rows(t.id)).map((r) => r.firstTripId)).toEqual([x.id]);
    await move(x.id, 'COSTED', { costedAt: new Date() });
    // L2: เลื่อนเวลาปล่อยรถภายในเดือน
    const y = await trip(t.id, w, '78-0002');
    await dispatch(y.id, '2026-11-20T08:00:00+07:00');
    await db.trip.update({
      where: { id: y.id },
      data: { dispatchedAt: new Date('2026-11-05T08:00:00+07:00') },
    });
    const r = await rows(t.id);
    expect(r.map((z) => [z.plate, z.firstCountedAt.toISOString()])).toEqual([
      ['78-0002', '2026-11-05T01:00:00.000Z'],
      ['78-0001', '2026-11-08T03:00:00.000Z'],
    ]);
    // M2: แถวหาย (เช่น ก่อน migration) → นับใหม่ทั้งเดือนได้คืน (role platform เรียกได้ · role แอปเรียกไม่ได้)
    await owner.activeVehicleUsage.deleteMany({ where: { tenantId: t.id } });
    await db.$queryRaw`SELECT tms_active_vehicle_recount_all('2026-11')::int AS n`;
    expect((await rows(t.id)).map((z) => z.plate)).toEqual(['78-0002', '78-0001']);
    const appPriv = await db.$queryRaw<{ ok: boolean }[]>`
      SELECT has_function_privilege('tms_app', 'tms_active_vehicle_recount_all(text)', 'EXECUTE') AS ok`;
    expect(appPriv[0]!.ok).toBe(false);
  });

  it('review L7: Console เปลี่ยนกติกา → นับใหม่เดือนนี้ทันที', async () => {
    const t = await createTenant(db);
    const v = await vehicle(t.id, '79-0001');
    const x = await trip(t.id, v, '79-0001');
    await dispatch(x.id, '2026-11-12T08:00:00+07:00'); // ยังไม่ปิดงาน
    expect(await rows(t.id)).toHaveLength(1);
    const put = (value: string) =>
      api(app, staff.SUPER_ADMIN!)
        .put('/v1/platform/settings/usage.activeVehicleRule')
        .send({ value, reason: 'ทดสอบเปลี่ยนกติกาการนับรถ active' });
    try {
      await put('doc_closed').expect(200);
      expect(await rows(t.id)).toHaveLength(0);
      await put('trip_started').expect(200);
      expect((await rows(t.id)).map((r) => r.rule)).toEqual(['trip_started']);
    } finally {
      await owner.platformSetting.deleteMany({ where: { key: 'usage.activeVehicleRule' } });
    }
  });

  it('trigger ทำงานใต้ role แอป + RLS (ทางเดียวกับ TripService.dispatch / cancel)', async () => {
    const t = await createTenant(db);
    const v = await vehicle(t.id, '76-0001');
    const x = await trip(t.id, v, '76-0001');
    const dbs = app.get(DbService);
    await dbs.withTenant(t.id, (tx) =>
      tx.trip.update({
        where: { id: x.id },
        data: { status: 'DISPATCHED', dispatchedAt: new Date('2026-11-04T08:00:00+07:00') },
      }),
    );
    expect((await rows(t.id)).map((r) => r.plate)).toEqual(['76-0001']);
    await dbs.withTenant(t.id, (tx) =>
      tx.trip.update({
        where: { id: x.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: 'ยกเลิกเพราะรถเสียก่อนออก',
        },
      }),
    );
    expect(await rows(t.id)).toHaveLength(0);
  });

  it('role แอปเขียนตารางนับไม่ได้ (นับด้วย trigger เท่านั้น) · RLS เปิด', async () => {
    const priv = await db.$queryRaw<{ t: string; ins: boolean; upd: boolean; del: boolean }[]>`
      SELECT t, has_table_privilege('tms_app', t, 'INSERT') AS ins, has_table_privilege('tms_app', t, 'UPDATE') AS upd,
             has_table_privilege('tms_app', t, 'DELETE') AS del
        FROM unnest(ARRAY['active_vehicle_usage', 'usage_record']) AS t`;
    expect(priv.filter((p) => p.ins || p.upd || p.del)).toEqual([]);
    const del = await db.$queryRaw<{ ok: boolean }[]>`
      SELECT has_table_privilege('tms_platform', 'usage_record', 'DELETE') AS ok`;
    expect(del[0]!.ok).toBe(false);
  });
});
