import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * ST4-T02 Server idempotent (docs/04 E1 "Idempotent server", docs/01 §3.9) — เกณฑ์ตรวจรับ:
 * ส่ง event เดิม 2 ครั้ง = 1 แถว · ส่งสลับลำดับ (เวลาเครื่องถูก) → สถานะสุดท้ายถูก · กรณีขัดแย้งขึ้นธง
 * + ส่งซ้ำพร้อมกัน, นาฬิกาเพี้ยน, event มาหลังปิด, การตัดสิน (แถวใหม่ + เหตุผล + audit), สิทธิ์, แยก tenant
 */
describe('stop event idempotency / ordering / flags (ST4-T02)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let seed = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ธงหน้างาน' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  async function trip(
    status: 'DISPATCHED' | 'CANCELLED' | 'ASSIGNED' = 'DISPATCHED',
    tid = tenantId,
    dispatched = true,
  ) {
    const n = ++seed;
    const vt = await db.vehicleType.create({
      data: { tenantId: tid, code: `SF${n}`, nameTh: `6 ล้อ ${n}`, vehicleClass: '6W' },
    });
    const v = await db.vehicle.create({
      data: {
        tenantId: tid,
        plate: `72-${1000 + n}`,
        plateProvince: 'TH-10',
        plateKey: `72${1000 + n}|TH-10`,
        plateNorm: `72${1000 + n}`,
        vehicleTypeId: vt.id,
        ownership: 'OWN',
      },
    });
    const site = await db.customerSite.create({
      data: { tenantId: tid, code: `SF-${n}`, name: `คลังธง ${n}`, address: { line1: 'x' } },
    });
    const t = await db.trip.create({
      data: {
        tenantId: tid,
        tripNo: `TRP-SF-${n}`,
        tripDate: new Date('2026-11-17'),
        status,
        // ปล่อยรถแล้ว (event ของเที่ยวที่จบ/ยกเลิกรับแบบ late เฉพาะเที่ยวที่เคยปล่อยรถ)
        ...(status !== 'ASSIGNED' && dispatched ? { dispatchedAt: new Date() } : {}),
        vehicleId: v.id,
        vehiclePlateSnapshot: v.plate,
        vehicleTypeId: vt.id,
        ...(status === 'CANCELLED'
          ? { cancelledAt: new Date(), cancelReason: 'ลูกค้ายกเลิกทั้งเที่ยว' }
          : {}),
      },
    });
    const stop = await db.tripStop.create({
      data: { tenantId: tid, tripId: t.id, sequence: 1, type: 'DELIVERY', siteId: site.id },
    });
    const sid = encodeId('tripStop', stop.id);
    return {
      trip: t,
      stop,
      sid,
      post: (action: string, body: object, token = admin) =>
        api(app, token).post(`/v1/stops/${sid}/${action}`).send(body),
      seq: async (token = admin) =>
        (await api(app, token).get(`/v1/stops/${sid}/events`).expect(200)).body,
    };
  }

  const dec = (id: string) => tryDecodeId('event', id)!;
  const ev = (at: string, extra: Record<string, unknown> = {}) => ({
    clientEventId: randomUUID(),
    occurredAt: `2026-11-17T${at}:00+07:00`,
    ...extra,
  });
  const flags = async (q = '', token = admin) =>
    (await api(app, token).get(`/v1/stop-event-flags${q}`).expect(200)).body;
  const resolve = (id: string, body: object, token = admin) =>
    api(app, token).post(`/v1/stop-event-flags/${id}/resolve`).send(body);

  it('เกณฑ์ตรวจรับ: ส่ง event เดิม 2–3 ครั้ง = 1 แถว — ครั้งแรก 201 ครั้งถัดไป 200 + ผลเดิม', async () => {
    const s = await trip();
    const body = ev('09:00', { lat: 13.7, lng: 100.5 });
    const first = await s.post('arrive', body).expect(201);
    const again = await s.post('arrive', body).expect(200);
    const third = await s.post('arrive', { ...body, occurredAt: '2026-11-17T10:00:00+07:00' });
    expect(third.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(third.body).toEqual(first.body); // ค่าที่ส่งซ้ำต่างไปไม่ทับของเดิม
    expect(await db.stopEvent.count({ where: { clientEventId: body.clientEventId } })).toBe(1);
  });

  it('ส่งซ้ำพร้อมกัน 5 คำขอ (จุดเดียวกัน) → 1 แถว · ทุกคำขอได้ event เดียวกัน', async () => {
    const s = await trip();
    const body = ev('09:00');
    const rs = await Promise.all(Array.from({ length: 5 }, () => s.post('arrive', body)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(4);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await db.stopEvent.count({ where: { clientEventId: body.clientEventId } })).toBe(1);
  });

  it('เกณฑ์ตรวจรับ: ส่งสลับลำดับ (เวลาเครื่องถูก) → สถานะสุดท้ายถูก ไม่มีธง', async () => {
    const s = await trip();
    // ถึงจุดมาก่อน แล้ว "ออกเดินทางมุ่งหน้าไปจุดนี้" (เวลาก่อนหน้า) ตามมา
    await s.post('arrive', ev('09:10')).expect(201);
    await s.post('depart', ev('08:30')).expect(201);
    // ปิดงานมาก่อนถึงจุด → ขัดลำดับชั่วคราว
    const c = await s.post('complete', ev('09:40', { outcome: 'DELIVERED' })).expect(201);
    expect(c.body.sequenceConflict).toBe(false);
    const r = await s.seq();
    expect(r.data.map((e: { type: string }) => e.type)).toEqual(['DEPART', 'ARRIVE', 'COMPLETE']);
    expect(r.effective).toMatchObject({
      state: 'COMPLETED',
      outcome: 'DELIVERED',
      enRouteAt: '2026-11-17T01:30:00.000Z',
      arrivedAt: '2026-11-17T02:10:00.000Z',
      closedAt: '2026-11-17T02:40:00.000Z',
      lastEventId: c.body.id,
    });
    expect(r.data.every((e: { seqStatus: string }) => e.seqStatus === 'APPLIED')).toBe(true);
  });

  it('ปิดงานมาก่อน "ถึงจุด" → ธงขัดลำดับ · event ที่ขาดมาถึง → ธงหายเอง (ไม่ต้องตัดสิน)', async () => {
    const s = await trip();
    const c = await s.post('complete', ev('09:40', { outcome: 'DELIVERED' })).expect(201);
    expect(c.body).toMatchObject({ sequenceConflict: true, flags: ['SEQUENCE_CONFLICT'] });
    expect((await s.seq()).effective.state).toBe('PENDING');
    let open = await flags('?status=open');
    expect(open.data.map((f: { id: string }) => f.id)).toContain(c.body.id);
    const f = open.data.find((x: { id: string }) => x.id === c.body.id);
    expect(f).toMatchObject({
      status: 'OPEN',
      stateBefore: 'PENDING',
      tripNo: s.trip.tripNo,
      stopSequence: 1,
      vehiclePlate: s.trip.vehiclePlateSnapshot,
      resolution: null,
    });

    await s.post('arrive', ev('09:10')).expect(201);
    const r = await s.seq();
    expect(r.effective.state).toBe('COMPLETED');
    expect(
      (await db.stopEvent.findFirstOrThrow({ where: { id: dec(c.body.id) } })).sequenceConflict,
    ).toBe(false);
    open = await flags('?status=open');
    expect(open.data.map((x: { id: string }) => x.id)).not.toContain(c.body.id);
  });

  it('ขัดแย้ง (ปิดงานซ้ำต่างผล) → เก็บทั้งคู่ + ธง → ผู้จัดรถตัดสิน "ไม่ใช้" = แถวใหม่ + เหตุผล + audit', async () => {
    const s = await trip();
    await s.post('arrive', ev('09:00')).expect(201);
    await s.post('complete', ev('09:20', { outcome: 'DELIVERED' })).expect(201);
    const fail = await s.post('complete', ev('09:30', { outcome: 'PARTIAL' })).expect(201);
    expect(fail.body.sequenceConflict).toBe(true);
    expect(await db.stopEvent.count({ where: { tripStopId: s.stop.id } })).toBe(3);
    const before = await api(app, admin).get('/v1/stop-event-flags/summary').expect(200);

    // ตรวจข้อมูล: เหตุผลสั้น / decision ผิด → 422
    await resolve(fail.body.id, { decision: 'IGNORE', reason: 'สั้น' }).expect(422);
    await resolve(fail.body.id, { decision: 'DROP', reason: 'เหตุผลยาวพอสมควร' }).expect(422);
    // สิทธิ์: ผู้วางแผน (trips:read เท่านั้น) ดูได้ ตัดสินไม่ได้
    const planner = await tokenFor(
      tenantId,
      SYSTEM_ROLES.planner.permissions.join(' '),
      'u-planner',
    );
    await flags('', planner);
    await resolve(
      fail.body.id,
      { decision: 'IGNORE', reason: 'ไม่มีสิทธิ์ตัดสิน' },
      planner,
    ).expect(403);

    const res = await resolve(fail.body.id, {
      decision: 'IGNORE',
      reason: 'คนขับกดซ้ำ ยืนยันทางโทรศัพท์ว่าส่งครบ',
    }).expect(200);
    expect(res.body).toMatchObject({
      id: fail.body.id,
      status: 'RESOLVED',
      flags: ['SEQUENCE_CONFLICT'],
      resolution: {
        decision: 'IGNORE',
        reason: 'คนขับกดซ้ำ ยืนยันทางโทรศัพท์ว่าส่งครบ',
        flags: ['SEQUENCE_CONFLICT'],
        resolvedBy: 'user-test',
      },
    });
    // ธงของ event ไม่ถูกพลิก — การตัดสินเป็นแถวใหม่
    const row = await db.stopEvent.findFirstOrThrow({
      where: { id: dec(fail.body.id) },
      include: { resolutions: true },
    });
    expect(row.sequenceConflict).toBe(true);
    expect(row.resolutions).toHaveLength(1);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { tenantId, action: 'stop_event.resolve', entityId: row.id },
    });
    expect(audit).toMatchObject({
      entityType: 'stop_event',
      reason: 'คนขับกดซ้ำ ยืนยันทางโทรศัพท์ว่าส่งครบ',
      after: { decision: 'IGNORE' },
    });
    const r = await s.seq();
    expect(r.effective).toMatchObject({ state: 'COMPLETED', outcome: 'DELIVERED' });
    expect(r.data[2]).toMatchObject({ seqStatus: 'IGNORED', counted: false });

    // ตัดสินซ้ำ → 409 · event ไม่มีธง → 409
    expect(
      (await resolve(fail.body.id, { decision: 'ACCEPT', reason: 'เปลี่ยนใจขอใช้แทน' }).expect(409))
        .body.code,
    ).toBe('stop_event_already_resolved');
    expect(
      (await resolve(r.data[0].id, { decision: 'ACCEPT', reason: 'ไม่มีธงให้ตัดสิน' }).expect(409))
        .body.code,
    ).toBe('stop_event_not_flagged');

    const after = await api(app, admin).get('/v1/stop-event-flags/summary').expect(200);
    expect(after.body.open).toBe(before.body.open - 1);
    expect(after.body.resolved).toBe(before.body.resolved + 1);
    expect(after.body.resolvedToday).toBe(before.body.resolvedToday + 1);
    const resolved = await flags('?status=resolved');
    expect(resolved.data.map((x: { id: string }) => x.id)).toContain(fail.body.id);
  });

  it('ยอมรับ (ACCEPT) event ที่ขัดลำดับ → นับในลำดับที่มีผล', async () => {
    const s = await trip();
    const c = await s.post('complete', ev('09:40', { outcome: 'DELIVERED' })).expect(201);
    await resolve(c.body.id, {
      decision: 'ACCEPT',
      reason: 'คนขับลืมกดถึงจุด ลูกค้ายืนยันรับของแล้ว',
    }).expect(200);
    const r = await s.seq();
    expect(r.effective).toMatchObject({ state: 'COMPLETED', outcome: 'DELIVERED' });
    expect(r.data[0]).toMatchObject({ seqStatus: 'ACCEPTED', counted: true });
  });

  it('นาฬิกาเครื่องเพี้ยน: อนาคต > 5 นาที / ย้อนหลัง > 24 ชม. → ธง CLOCK_SKEW (ไม่แก้เวลา)', async () => {
    const s = await trip();
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    const fut = await s.post('depart', { clientEventId: randomUUID(), occurredAt: iso(3600_000) });
    expect(fut.status).toBe(201);
    expect(fut.body).toMatchObject({ clockSkew: true, flags: ['CLOCK_SKEW'] });
    const s2 = await trip();
    const old = await s2
      .post('arrive', { clientEventId: randomUUID(), occurredAt: iso(-25 * 3600_000) })
      .expect(201);
    expect(old.body.clockSkew).toBe(true);
    const s3 = await trip();
    const ok = await s3
      .post('arrive', { clientEventId: randomUUID(), occurredAt: iso(-23 * 3600_000) })
      .expect(201);
    expect(ok.body).toMatchObject({ clockSkew: false, flags: [] });
    const list = await flags('?status=open&flag=CLOCK_SKEW');
    const ids = list.data.map((x: { id: string }) => x.id);
    expect(ids).toEqual(expect.arrayContaining([fut.body.id, old.body.id]));
    expect(ids).not.toContain(ok.body.id);
  });

  it('event ของเที่ยวที่ยกเลิก → รับเก็บ + ธง LATE ไม่นับ จนกว่าผู้จัดรถยอมรับ', async () => {
    const s = await trip('CANCELLED');
    const a = await s.post('arrive', ev('09:00')).expect(201);
    expect(a.body).toMatchObject({ lateReason: 'TRIP_CANCELLED', flags: ['LATE'] });
    expect((await s.seq()).effective.state).toBe('PENDING');
    const f = (await flags('?flag=LATE')).data.find((x: { id: string }) => x.id === a.body.id);
    expect(f).toMatchObject({ tripStatus: 'CANCELLED', status: 'OPEN' });
    await resolve(a.body.id, { decision: 'ACCEPT', reason: 'เก็บเวลาถึงจุดไว้เป็นหลักฐาน' }).expect(
      200,
    );
    expect((await s.seq()).effective.state).toBe('ARRIVED');
  });

  it('ค้นหา + แบ่งหน้า (cursor)', async () => {
    const s = await trip();
    for (const at of ['09:00', '09:10', '09:20'])
      await s.post('complete', ev(at, { outcome: 'DELIVERED' })).expect(201);
    const p1 = await flags(`?q=${encodeURIComponent(s.trip.tripNo!)}&limit=2`);
    expect(p1.data).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    const p2 = await flags(
      `?q=${encodeURIComponent(s.trip.tripNo!)}&limit=2&cursor=${p1.nextCursor}`,
    );
    expect(p2.data).toHaveLength(1);
    expect(p2.hasMore).toBe(false);
    await api(app, admin).get('/v1/stop-event-flags?cursor=xyz').expect(422);
  });

  it('การตัดสิน append-only ที่ฐาน (แก้/ลบไม่ได้ทุก role) · CHECK decision/เหตุผล', async () => {
    const s = await trip();
    const c = await s.post('complete', ev('09:40', { outcome: 'DELIVERED' })).expect(201);
    await resolve(c.body.id, { decision: 'IGNORE', reason: 'ทดสอบห้ามแก้การตัดสิน' }).expect(200);
    const r = await db.stopEventResolution.findFirstOrThrow({
      where: { stopEventId: dec(c.body.id) },
    });
    await expect(
      db.$executeRawUnsafe(
        `UPDATE stop_event_resolution SET decision = 'ACCEPT' WHERE id = '${r.id}'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRawUnsafe(`DELETE FROM stop_event_resolution WHERE id = '${r.id}'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.stopEventResolution.create({
        data: { ...r, id: undefined, decision: 'MAYBE', stopEventId: r.stopEventId },
      }),
    ).rejects.toThrow();
  });

  it('ไม่เคยปล่อยรถ: เที่ยวยกเลิก / จุดที่ถอดออก → 409 trip_not_in_progress (ไม่รับแบบ late)', async () => {
    const c = await trip('CANCELLED', tenantId, false);
    const r = await c.post('arrive', ev('09:00')).expect(409);
    expect(r.body.code).toBe('trip_not_in_progress');
    const a = await trip('ASSIGNED', tenantId, false);
    await db.tripStop.update({ where: { id: a.stop.id }, data: { removedAt: new Date() } });
    expect((await a.post('arrive', ev('09:00')).expect(409)).body.code).toBe(
      'trip_not_in_progress',
    );
  });

  it('การตัดสินหมดผลเมื่อธงเปลี่ยน: "ไม่ใช้" (ขัดลำดับ) แล้ว "ถึงจุด" ที่เวลาก่อนมาถึง → ธงหาย ปิดงานนับตามปกติ', async () => {
    const s = await trip();
    const c = await s.post('complete', ev('09:40', { outcome: 'DELIVERED' })).expect(201);
    await resolve(c.body.id, { decision: 'IGNORE', reason: 'คนขับกดปิดงานผิดจุด' }).expect(200);
    expect((await s.seq()).effective.state).toBe('PENDING');
    await s.post('arrive', ev('09:10')).expect(201);
    const r = await s.seq();
    expect(r.effective).toMatchObject({ state: 'COMPLETED', outcome: 'DELIVERED' });
    const done = r.data.find((x: { id: string }) => x.id === c.body.id);
    expect(done).toMatchObject({ seqStatus: 'APPLIED', flags: [], resolution: null });
    const row = await db.stopEvent.findFirstOrThrow({ where: { id: dec(c.body.id) } });
    expect(row.resolutionId).toBeNull();
    // ไม่อยู่ทั้งรายการ "ใหม่" และ "ปิดแล้ว" (ไม่มีธง และการตัดสินเดิมหมดผล — แถวการตัดสินยังอยู่)
    const all = await flags('?status=all');
    expect(all.data.map((x: { id: string }) => x.id)).not.toContain(c.body.id);
    expect(await db.stopEventResolution.count({ where: { stopEventId: row.id } })).toBe(1);
  });

  it('ยอมรับ "เวลาเพี้ยน" แล้ว event อื่นทำให้ขัดลำดับ → การยอมรับหมดผล กลับเป็นใหม่ ตัดสินใหม่ได้ (แถวที่ 2)', async () => {
    const s = await trip();
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    const d = await s
      .post('depart', { clientEventId: randomUUID(), occurredAt: iso(3600_000) })
      .expect(201);
    // ยังไม่ยอมรับ = ไม่นับ (ไม่ขับสถานะ/เวลา)
    expect((await s.seq()).effective).toMatchObject({ state: 'PENDING', enRouteAt: null });
    await resolve(d.body.id, {
      decision: 'ACCEPT',
      reason: 'นาฬิกาเครื่องคนขับเร็ว ตรวจแล้ว',
    }).expect(200);
    expect((await s.seq()).effective.state).toBe('EN_ROUTE');
    await s.post('arrive', { clientEventId: randomUUID(), occurredAt: iso(0) }).expect(201);
    const open = await flags('?status=open');
    const f = open.data.find((x: { id: string }) => x.id === d.body.id);
    expect(f).toMatchObject({
      status: 'OPEN',
      flags: ['SEQUENCE_CONFLICT', 'CLOCK_SKEW'],
      resolution: null,
    });
    expect((await s.seq()).effective.state).toBe('ARRIVED');
    await resolve(d.body.id, {
      decision: 'IGNORE',
      reason: 'ออกเดินทางกดซ้ำหลังถึงจุดแล้ว',
    }).expect(200);
    expect(await db.stopEventResolution.count({ where: { stopEventId: dec(d.body.id) } })).toBe(2);
  });

  it('ปิดงานแข่งกัน: ตัวที่มาทีหลัง (เวลาก่อน) ไม่พลิกผล — ขึ้นธงทั้งคู่ ผลคงตามตัวที่รับก่อน', async () => {
    const s = await trip();
    await s.post('arrive', ev('10:00')).expect(201);
    const first = await s.post('complete', ev('10:30', { outcome: 'DELIVERED' })).expect(201);
    expect(first.body.flags).toEqual([]);
    const later = await s.post('complete', ev('10:20', { outcome: 'PARTIAL' })).expect(201);
    expect(later.body.flags).toEqual(['SEQUENCE_CONFLICT']);
    const r = await s.seq();
    expect(r.effective).toMatchObject({ state: 'COMPLETED', outcome: 'DELIVERED' });
    const ids = (await flags('?status=open')).data.map((x: { id: string }) => x.id);
    expect(ids).toEqual(expect.arrayContaining([first.body.id, later.body.id]));
    // ผู้จัดรถยอมรับตัวที่มาทีหลัง → ผลเปลี่ยนเป็นส่งบางส่วน
    await resolve(later.body.id, { decision: 'ACCEPT', reason: 'ลูกค้าแจ้งรับไม่ครบจริง' }).expect(
      200,
    );
    expect((await s.seq()).effective.outcome).toBe('PARTIAL');
  });

  it('ค้นหาด้วยเลข DO / ชื่อลูกค้า · ตัวกรอง resolvedToday', async () => {
    const s = await trip();
    const cust = await db.customer.create({
      data: { tenantId, code: `SFC-${seed}`, legalName: `บจก. ค้นธง ${seed}` },
    });
    const c = await s.post('complete', ev('09:40', { outcome: 'DELIVERED' })).expect(201);
    await db.customerSite.update({
      where: { id: s.stop.siteId },
      data: { customerId: cust.id },
    });
    const hit = await flags(`?q=${encodeURIComponent(cust.legalName)}`);
    expect(hit.data.map((x: { id: string }) => x.id)).toEqual([c.body.id]);
    await resolve(c.body.id, { decision: 'IGNORE', reason: 'ทดสอบตัวกรองวันนี้' }).expect(200);
    const today = await flags('?status=resolved&resolvedToday=true');
    expect(today.data.map((x: { id: string }) => x.id)).toContain(c.body.id);
  });

  it('แยก tenant: รายการ/สรุปไม่เห็นของบริษัทอื่น · ตัดสิน/ดูลำดับของบริษัทอื่น → 404', async () => {
    const s = await trip();
    const c = await s.post('complete', ev('09:40', { outcome: 'DELIVERED' })).expect(201);
    const o = await flags('', other);
    expect(o.data.map((x: { id: string }) => x.id)).not.toContain(c.body.id);
    const sum = await api(app, other).get('/v1/stop-event-flags/summary').expect(200);
    expect(sum.body).toMatchObject({ open: 0, resolved: 0 });
    const r = await resolve(c.body.id, { decision: 'IGNORE', reason: 'ข้ามบริษัทไม่ได้' }, other);
    expect(r.status).toBe(404);
    await api(app, other).get(`/v1/stops/${s.sid}/events`).expect(404);
  });
});
