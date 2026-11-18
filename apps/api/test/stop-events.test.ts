import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * ST4-T01 stop_event (docs/04 E1 Stop event, docs/01 §3.9) — เกณฑ์ตรวจรับ:
 * ส่ง arrive → depart → complete ผ่าน API แล้วมี event 3 แถวพร้อมเวลาสองชุด (occurredAt เครื่อง / receivedAt server)
 * + clientEventId ซ้ำ, สถานะเที่ยว, outcome/เหตุผล/GPS, สิทธิ์, แยก tenant, append-only ที่ฐาน
 */
describe('stop events (ST4-T01)', () => {
  let app: NestExpressApplication;
  const db = platform();
  const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let seed = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท หน้างาน' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await appDb.$disconnect();
  });

  /** เที่ยว (สถานะที่ต้องการ) + จุดแวะ 2 จุด — สร้างตรงที่ฐาน (การปล่อยรถทดสอบใน trip-assign-dispatch.test.ts) */
  async function trip(
    status: 'ASSIGNED' | 'DISPATCHED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' = 'DISPATCHED',
    tid = tenantId,
    dispatched = true,
  ) {
    const n = ++seed;
    const vt = await db.vehicleType.create({
      data: { tenantId: tid, code: `SE${n}`, nameTh: `6 ล้อ ${n}`, vehicleClass: '6W' },
    });
    const v = await db.vehicle.create({
      data: {
        tenantId: tid,
        plate: `71-${1000 + n}`,
        plateProvince: 'TH-10',
        plateKey: `71${1000 + n}|TH-10`,
        plateNorm: `71${1000 + n}`,
        vehicleTypeId: vt.id,
        ownership: 'OWN',
      },
    });
    const site = (k: string) =>
      db.customerSite.create({
        data: { tenantId: tid, code: `SE-${k}${n}`, name: `จุด ${k}${n}`, address: { line1: 'x' } },
      });
    const [a, b] = [await site('A'), await site('B')];
    const t = await db.trip.create({
      data: {
        tenantId: tid,
        tripNo: `TRP-SE-${n}`,
        tripDate: new Date(new Date(BASE + 7 * 3600_000).toISOString().slice(0, 10)),
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
    const stop = (sequence: number, siteId: string, type: 'PICKUP' | 'DELIVERY') =>
      db.tripStop.create({ data: { tenantId: tid, tripId: t.id, sequence, type, siteId } });
    const pickup = await stop(1, a.id, 'PICKUP');
    const drop = await stop(2, b.id, 'DELIVERY');
    return {
      trip: t,
      pickup,
      drop,
      url: (s: { id: string }, action: string) =>
        `/v1/stops/${encodeId('tripStop', s.id)}/${action}`,
    };
  }

  const reason = async (category: 'DELIVERY_FAILED' | 'DELAY' | 'CANCEL', code: string) =>
    encodeId(
      'reasonCode',
      (await db.reasonCode.findFirstOrThrow({ where: { tenantId, category, code } })).id,
    );
  /**
   * เวลา "HH:MM" ของวันทดสอบ → ISO (UTC) โดยยึด "09:00" = เวลาปัจจุบัน − 6 ชม. — เดิมตายตัว 17 พ.ย. 2569 → พ้น 24 ชม.
   * ทุก event ติดธง CLOCK_SKEW (`CLOCK_SKEW_PAST_MS`) แล้ว test ล้มตามวันที่รัน
   */
  const BASE = Math.floor((Date.now() - 6 * 3600_000) / 60_000) * 60_000;
  const at = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(BASE + ((h! - 9) * 60 + m!) * 60_000).toISOString();
  };
  const ev = (extra: Record<string, unknown> = {}) => ({
    clientEventId: randomUUID(),
    occurredAt: at('09:00'),
    ...extra,
  });

  it('เกณฑ์ตรวจรับ: arrive → depart → complete ผ่าน API = event 3 แถว พร้อมเวลาสองชุด', async () => {
    const { trip: t, drop, url } = await trip();
    const before = Date.now();
    const sent = [
      ['arrive', ev({ occurredAt: at('09:10'), lat: 13.6447123, lng: 100.6089 })],
      ['depart', ev({ occurredAt: at('09:20') })],
      ['complete', ev({ occurredAt: at('09:35'), outcome: 'DELIVERED', accuracyM: 8.5 })],
    ] as const;
    const out = [];
    for (const [action, body] of sent) {
      const res = await api(app, admin).post(url(drop, action)).send(body).expect(201);
      out.push(res.body);
    }
    expect(out.map((e) => e.type)).toEqual(['ARRIVE', 'DEPART', 'COMPLETE']);
    expect(out[0]).toMatchObject({
      stopId: encodeId('tripStop', drop.id),
      tripId: encodeId('trip', t.id),
      outcome: null,
      clientEventId: sent[0][1].clientEventId,
      occurredAt: at('09:10'),
      lat: 13.644712,
      lng: 100.6089,
      accuracyM: null,
      source: 'WEB',
      recordedBy: 'user-test',
      reason: null,
      note: null,
    });
    expect(out[0].id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(out[2]).toMatchObject({ outcome: 'DELIVERED', accuracyM: 8.5 });

    const rows = await db.stopEvent.findMany({
      where: { tripStopId: drop.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(rows).toHaveLength(3);
    for (const [i, r] of rows.entries()) {
      expect(r.occurredAt.toISOString()).toBe(new Date(sent[i]![1].occurredAt).toISOString());
      // receivedAt = เวลา server (ไม่ใช่เวลาเครื่องที่ย้อนหลัง)
      expect(r.receivedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(r.receivedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(r.tripId).toBe(t.id);
      // ST4-T02: DEPART = ออกเดินทางมุ่งหน้าไปจุดนี้ (docs/01 §3.9) → DEPART หลังถึงจุดแล้ว = ขัดลำดับ (เก็บไว้ + ธง)
      expect(r.sequenceConflict).toBe(r.type === 'DEPART');
      // ST4-T03: event ที่นับ = มี applied_at · ที่ขัดลำดับ (ไม่นับ) = null
      expect(r.appliedAt === null).toBe(r.type === 'DEPART');
    }
    // ST4-T03 ไล่สถานะจุดแล้ว
    expect((await db.tripStop.findUniqueOrThrow({ where: { id: drop.id } })).status).toBe(
      'COMPLETED',
    );
  });

  it('clientEventId ใช้กับคนละชนิด → 409 stop_event_duplicate (ไม่มีแถวใหม่) · คนละ tenant ใช้ค่าเดียวกันได้ (ส่งซ้ำแบบเดิม = 200: stop-event-flags.test.ts)', async () => {
    const { pickup, url } = await trip();
    const body = ev();
    const first = await api(app, admin).post(url(pickup, 'arrive')).send(body).expect(201);
    const dup = await api(app, admin).post(url(pickup, 'depart')).send(body).expect(409);
    expect(dup.body).toMatchObject({ code: 'stop_event_duplicate' });
    expect(dup.body.eventId).toBe(first.body.id);
    expect(await db.stopEvent.count({ where: { clientEventId: body.clientEventId } })).toBe(1);

    const o = await trip('DISPATCHED', otherId);
    await api(app, other).post(o.url(o.pickup, 'arrive')).send(body).expect(201);
  });

  it('เที่ยวยังไม่ปล่อยรถ → 409 · จบ/ยกเลิกแล้ว → รับ + ธง LATE (ST4-T02)', async () => {
    {
      const { drop, url } = await trip('ASSIGNED');
      const res = await api(app, admin).post(url(drop, 'arrive')).send(ev()).expect(409);
      expect(res.body).toMatchObject({ code: 'trip_not_in_progress', tripStatus: 'ASSIGNED' });
    }
    for (const [status, late] of [
      ['COMPLETED', 'TRIP_COMPLETED'],
      ['CANCELLED', 'TRIP_CANCELLED'],
    ] as const) {
      const { drop, url } = await trip(status);
      const res = await api(app, admin).post(url(drop, 'arrive')).send(ev()).expect(201);
      expect(res.body).toMatchObject({ lateReason: late, flags: ['LATE'] });
    }
    const { drop, url } = await trip('IN_PROGRESS');
    await api(app, admin).post(url(drop, 'arrive')).send(ev()).expect(201);
  });

  it('outcome: complete บังคับ · arrive/depart ไม่รับ · fail รับเฉพาะ FAILED / UNDELIVERED_RETAIN', async () => {
    const { drop, url } = await trip();
    const failed = await reason('DELIVERY_FAILED', 'SHOP_CLOSED');
    const r1 = await api(app, admin).post(url(drop, 'complete')).send(ev()).expect(422);
    expect(r1.body.errors[0].field).toBe('outcome');
    await api(app, admin)
      .post(url(drop, 'complete'))
      .send(ev({ outcome: 'LOST' }))
      .expect(422);
    await api(app, admin)
      .post(url(drop, 'arrive'))
      .send(ev({ outcome: 'DELIVERED' }))
      .expect(422);
    await api(app, admin)
      .post(url(drop, 'fail'))
      .send(ev({ outcome: 'DELIVERED', reasonCodeId: failed, note: 'ร้านปิด' }))
      .expect(422);
    const ok = await api(app, admin)
      .post(url(drop, 'fail'))
      .send(ev({ outcome: 'UNDELIVERED_RETAIN', reasonCodeId: failed, note: 'ร้านปิด' }))
      .expect(201);
    expect(ok.body).toMatchObject({ type: 'FAIL', outcome: 'UNDELIVERED_RETAIN' });
    expect(await db.stopEvent.count({ where: { tripStopId: drop.id } })).toBe(1);
  });

  it('เหตุผล: ส่งไม่สำเร็จบังคับ + snapshot ลง payload · หมวดผิด / ส่งสำเร็จมีเหตุผล / ต้องมีหมายเหตุ → 422', async () => {
    const { drop, url } = await trip();
    const failed = await reason('DELIVERY_FAILED', 'SHOP_CLOSED');
    const r1 = await api(app, admin).post(url(drop, 'fail')).send(ev()).expect(422);
    expect(r1.body.errors[0]).toMatchObject({ field: 'reasonCodeId', code: 'required' });
    await api(app, admin)
      .post(url(drop, 'complete'))
      .send(ev({ outcome: 'FAILED' }))
      .expect(422);
    const cat = await api(app, admin)
      .post(url(drop, 'fail'))
      .send(ev({ reasonCodeId: await reason('CANCEL', 'DUPLICATE') }))
      .expect(422);
    expect(cat.body.errors[0]).toMatchObject({ field: 'reasonCodeId', code: 'reason_category' });
    const na = await api(app, admin)
      .post(url(drop, 'complete'))
      .send(ev({ outcome: 'DELIVERED', reasonCodeId: failed }))
      .expect(422);
    expect(na.body.errors[0]).toMatchObject({ field: 'reasonCodeId', code: 'not_applicable' });
    const noNote = await api(app, admin)
      .post(url(drop, 'fail'))
      .send(ev({ reasonCodeId: failed }))
      .expect(422);
    expect(noNote.body.errors[0]).toMatchObject({ field: 'note', code: 'required' });

    const ok = await api(app, admin)
      .post(url(drop, 'fail'))
      .send(ev({ reasonCodeId: failed, note: 'ร้านปิดวันหยุด' }))
      .expect(201);
    expect(ok.body).toMatchObject({
      outcome: null,
      reason: {
        id: failed,
        category: 'DELIVERY_FAILED',
        code: 'SHOP_CLOSED',
        label: 'ลูกค้าปิดทำการ',
      },
      note: 'ร้านปิดวันหยุด',
    });
    // ถึงจุดช้า: เหตุผลหมวดล่าช้า (ไม่บังคับหมายเหตุ)
    await api(app, admin)
      .post(url(drop, 'arrive'))
      .send(ev({ reasonCodeId: await reason('DELAY', 'TRAFFIC') }))
      .expect(201);
    // แก้ข้อความ master ภายหลังไม่ย้อนแก้ event เดิม (snapshot)
    await db.reasonCode.updateMany({
      where: { tenantId, code: 'SHOP_CLOSED' },
      data: { labelTh: 'ร้านปิด' },
    });
    const row = await db.stopEvent.findFirstOrThrow({
      where: { tripStopId: drop.id, type: 'FAIL' },
    });
    expect((row.payload as { reason: { label: string } }).reason.label).toBe('ลูกค้าปิดทำการ');
  });

  it('ตรวจข้อมูล: พิกัดต้องมาคู่/อยู่ในช่วง · occurredAt ต้องมี offset · clientEventId ต้องเป็น UUID', async () => {
    const { drop, url } = await trip();
    const bad = [
      ev({ lat: 13.6 }),
      ev({ lat: 91, lng: 100 }),
      ev({ lat: 13.6, lng: 100.5, accuracyM: -1 }),
      ev({ occurredAt: '2026-11-17T09:00:00' }),
      ev({ occurredAt: 'yesterday' }),
      // รูปย่อ ISO 8601 ที่ IsISO8601 ผ่านแต่ new Date() = NaN (เคยได้ 500 — review)
      ev({ occurredAt: '2026-11-17T09Z' }),
      ev({ occurredAt: '2026-11-17T0900+0700' }),
      ev({ occurredAt: '20261117T090000+0700' }),
      ev({ occurredAt: '2026-11-17T09:00+07:00' }),
      ev({ occurredAt: '2026-02-30T09:00:00+07:00' }),
      ev({ clientEventId: 'abc' }),
      ev({ source: 'APP' }),
      { occurredAt: '2026-11-17T09:00:00+07:00' },
    ];
    for (const body of bad) await api(app, admin).post(url(drop, 'arrive')).send(body).expect(422);
    expect(await db.stopEvent.count({ where: { tripStopId: drop.id } })).toBe(0);
  });

  it('occurredAt รับ RFC 3339 พร้อม offset (`Z`, `±HH:MM`, `±HHMM`, เศษวินาที)', async () => {
    const { drop, url } = await trip();
    for (const [occurredAt, iso] of [
      ['2026-11-17T09:00:00Z', '2026-11-17T09:00:00.000Z'],
      ['2026-11-17T09:00:00.250+07:00', '2026-11-17T02:00:00.250Z'],
      ['2026-11-17T09:00:00+0700', '2026-11-17T02:00:00.000Z'],
    ] as const) {
      const res = await api(app, admin)
        .post(url(drop, 'arrive'))
        .send(ev({ occurredAt }))
        .expect(201);
      expect(res.body.occurredAt).toBe(iso);
    }
  });

  it('clientEventId เดียวกันพร้อมกันคนละเที่ยว → 1 แถว อีกคำขอ 409 stop_event_duplicate + eventId เดิม', async () => {
    const [a, b] = [await trip(), await trip()];
    const body = ev();
    const rs = await Promise.all([
      api(app, admin).post(a.url(a.drop, 'arrive')).send(body),
      api(app, admin).post(b.url(b.drop, 'arrive')).send(body),
    ]);
    const ok = rs.filter((r) => r.status === 201);
    const dup = rs.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(dup).toHaveLength(1);
    expect(dup[0]!.body).toMatchObject({ code: 'stop_event_duplicate', eventId: ok[0]!.body.id });
    expect(await db.stopEvent.count({ where: { clientEventId: body.clientEventId } })).toBe(1);
  });

  it('จุดที่ถอดออกแล้ว → รับ + ธง LATE STOP_REMOVED (ST4-T02) · id ผิดรูป / ของบริษัทอื่น → 404', async () => {
    const { drop, url } = await trip();
    await db.tripStop.update({ where: { id: drop.id }, data: { removedAt: new Date() } });
    const r = await api(app, admin).post(url(drop, 'arrive')).send(ev()).expect(201);
    expect(r.body).toMatchObject({ lateReason: 'STOP_REMOVED', flags: ['LATE'] });
    await api(app, admin).post('/v1/stops/stp_123/arrive').send(ev()).expect(404);
    const o = await trip();
    const res = await api(app, other).post(o.url(o.drop, 'arrive')).send(ev()).expect(404);
    expect(res.body.code).toBe('not_found');
  });

  it('สิทธิ์ trips:dispatch — ผู้จ่ายงานบันทึกได้ · ผู้วางแผน/ดูอย่างเดียว 403', async () => {
    const { drop, url } = await trip();
    const as = (role: keyof typeof SYSTEM_ROLES) =>
      tokenFor(tenantId, SYSTEM_ROLES[role].permissions.join(' '), `u-${role}`);
    for (const role of ['planner', 'viewer', 'invoicer'] as const)
      await api(app, await as(role))
        .post(url(drop, 'arrive'))
        .send(ev())
        .expect(403);
    const res = await api(app, await as('dispatcher'))
      .post(url(drop, 'arrive'))
      .send(ev())
      .expect(201);
    expect(res.body.recordedBy).toBe('u-dispatcher');
  });

  it('Idempotency-Key ส่งซ้ำ → ผลเดิม ไม่มีแถวเพิ่ม', async () => {
    const { drop, url } = await trip();
    const body = ev();
    const key = randomUUID();
    const a = await api(app, admin)
      .post(url(drop, 'arrive'))
      .set('Idempotency-Key', key)
      .send(body);
    const b = await api(app, admin)
      .post(url(drop, 'arrive'))
      .set('Idempotency-Key', key)
      .send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await db.stopEvent.count({ where: { tripStopId: drop.id } })).toBe(1);
  });

  it('append-only ที่ฐาน: ลบไม่ได้ทุก role · แก้ได้เฉพาะช่องทำบัญชีของ projection · role แอปแก้ไม่ได้', async () => {
    const { drop, url } = await trip();
    const res = await api(app, admin).post(url(drop, 'arrive')).send(ev()).expect(201);
    const row = await db.stopEvent.findFirstOrThrow({ where: { tripStopId: drop.id } });
    const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    try {
      await expect(
        owner.$executeRawUnsafe(`UPDATE stop_event SET occurred_at = now() WHERE id = '${row.id}'`),
      ).rejects.toThrow(/append-only/);
      await expect(
        owner.$executeRawUnsafe(`DELETE FROM stop_event WHERE id = '${row.id}'`),
      ).rejects.toThrow(/append-only/);
      await owner.$executeRawUnsafe(
        `UPDATE stop_event SET applied_at = now(), sequence_conflict = true, attachments_pending = 2 WHERE id = '${row.id}'`,
      );
      await expect(
        owner.$executeRawUnsafe(
          `UPDATE stop_event SET attachments_pending = -1 WHERE id = '${row.id}'`,
        ),
      ).rejects.toThrow(/stop_event_attachments_pending_nonneg/);
    } finally {
      await owner.$disconnect();
    }
    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRawUnsafe(
          `UPDATE stop_event SET attachments_pending = 1 WHERE id = '${row.id}'`,
        );
      }),
    ).rejects.toThrow(/permission denied/);
    // ST4-T03: แอปแก้ applied_at ได้ (GRANT เฉพาะคอลัมน์) แต่ช่องอื่นยังไม่ได้
    await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.$executeRawUnsafe(`UPDATE stop_event SET applied_at = now() WHERE id = '${row.id}'`);
    });
    expect(res.body.id).toBe(encodeId('event', row.id));
  });

  it('CHECK ที่ฐาน: outcome ต่อชนิด, พิกัดคู่, source, จุดต้องอยู่ในเที่ยวเดียวกับ trip_id', async () => {
    const a = await trip();
    const b = await trip();
    const base = {
      tenantId,
      tripStopId: a.drop.id,
      tripId: a.trip.id,
      type: 'ARRIVE' as 'ARRIVE' | 'COMPLETE' | 'FAIL',
      source: 'WEB',
      occurredAt: new Date(),
    };
    const ins = (data: Partial<typeof base> & Record<string, unknown>) =>
      db.stopEvent.create({ data: { ...base, clientEventId: randomUUID(), ...data } as never });
    await expect(ins({ type: 'COMPLETE' })).rejects.toThrow(/stop_event_outcome/);
    await expect(ins({ outcome: 'DELIVERED' })).rejects.toThrow(/stop_event_outcome/);
    await expect(ins({ type: 'FAIL', outcome: 'PARTIAL' })).rejects.toThrow(/stop_event_outcome/);
    await expect(ins({ lat: 13.5 })).rejects.toThrow(/stop_event_gps/);
    await expect(ins({ source: 'SMS' })).rejects.toThrow(/stop_event_source/);
    await expect(ins({ tripId: b.trip.id })).rejects.toThrow(/stop_event_trip_stop_same_trip_fkey/);
    await expect(ins({ type: 'FAIL' })).resolves.toBeTruthy();
  });
});
