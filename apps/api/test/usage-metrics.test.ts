import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPlatformToken } from '../src/auth/tokens';
import { Clock } from '../src/common/clock';
import { encodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import {
  ApiUsageMeter,
  apiUsageMeter,
  countsAsApiCall,
} from '../src/modules/usage/api-usage-meter';
import { UsageFinalizeService } from '../src/modules/usage/usage-finalize.service';
import { bangkokDate, USAGE_METRIC } from '../src/modules/usage/usage-metrics';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * P1-ST1-T07 เมตริกอื่นต่อเดือน (docs/02 §5 · spec/01 §7 · plan/13 R-17)
 * เกณฑ์ตรวจรับ: ยอดรายวันรวม = ยอดรายเดือน · key ของ sandbox ไม่นับ · ไม่นับ 429/5xx · e-Tax = null ("—")
 */

describe('ตัวนับ API calls (ฟังก์ชันบริสุทธิ์)', () => {
  const c = { tenantId: 't1', principalType: 'client' };
  it('นับเฉพาะ client ภายนอก · ไม่นับ 429 / 5xx / UI / sandbox', () => {
    expect(countsAsApiCall(c, 200)).toBe(true);
    expect(countsAsApiCall(c, 404)).toBe(true);
    expect(countsAsApiCall(c, 304)).toBe(true);
    expect(countsAsApiCall(c, 429)).toBe(false);
    expect(countsAsApiCall(c, 500)).toBe(false);
    expect(countsAsApiCall(c, 503)).toBe(false);
    expect(countsAsApiCall({ ...c, principalType: 'user' }, 200)).toBe(false);
    expect(countsAsApiCall({ ...c, sandbox: {} }, 200)).toBe(false);
    expect(countsAsApiCall({ principalType: 'client' }, 200)).toBe(false);
    expect(countsAsApiCall(undefined, 200)).toBe(false);
  });
  it('วันเวลาไทย · รวมคีย์ในหน่วยความจำ (ไม่มี I/O ต่อคำขอ)', () => {
    expect(bangkokDate(new Date('2026-11-30T16:59:59Z'))).toBe('2026-11-30');
    expect(bangkokDate(new Date('2026-11-30T17:00:00Z'))).toBe('2026-12-01');
    const m = new ApiUsageMeter();
    for (let i = 0; i < 1000; i++) m.record('t1', 'rest', new Date('2026-11-10T03:00:00Z'));
    m.record('t1', 'rest', new Date('2026-11-11T03:00:00Z'));
    expect(m.pendingKeys).toBe(2);
  });
});

describe('เมตริกการใช้งานรายวัน/รายเดือน (P1-ST1-T07)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let liveId: string;
  let admin: string;
  let staff: string;
  const srv = () => app.getHttpServer();
  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    app.get(Clock).set(new Date('2026-11-15T10:00:00+07:00'));
    liveId = (await createTenantWithDefaults(db, { name: 'บริษัท นับการใช้งาน' })).id;
    const u = await db.appUser.create({
      data: { tenantId: liveId, email: 'owner@usage.test', name: 'เจ้าของ', status: 'ACTIVE' },
    });
    await db.appUser.create({
      data: { tenantId: liveId, email: 'off@usage.test', name: 'ปิดแล้ว', status: 'DISABLED' },
    });
    admin = await tokenFor(liveId, '*', u.id);
    const p = await db.platformUser.create({
      data: {
        email: `billing-${randomUUID().slice(0, 6)}@innovera.test`,
        name: 'ทีมการเงิน',
        role: 'BILLING',
        passwordHash: 'x',
        totpSecret: 'x',
      },
    });
    staff = await signPlatformToken({ sub: p.id, role: 'BILLING', tv: p.tokenVersion });
  });
  afterAll(async () => {
    app.get(Clock).set(null);
    await app.close();
    await db.$disconnect();
  });

  const daily = (tenantId: string, metric: string) =>
    db.usageDaily.findMany({ where: { tenantId, metric }, orderBy: { date: 'asc' } });

  it('API key live ถูกนับ (รวม 4xx) · UI และ key ของ sandbox ไม่นับ · flush บวกเพิ่มลง usage_daily', async () => {
    const live = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'live อ่าน', scopes: ['master:read'] })
      .expect(201);
    const test = await api(app, admin)
      .post('/v1/api-keys')
      .set('X-Tms-Mode', 'test')
      .send({ name: 'sandbox อ่าน', mode: 'test', scopes: ['master:read'] })
      .expect(201);
    await apiUsageMeter.flush(db); // ล้างของ test ก่อนหน้า
    await db.usageDaily.deleteMany({});
    for (let i = 0; i < 3; i++)
      await request(srv()).get('/v1/customers').set(bearer(live.body.secret)).expect(200);
    await request(srv())
      .get(`/v1/customers/${encodeId('customer', randomUUID())}`)
      .set(bearer(live.body.secret))
      .expect(404);
    for (let i = 0; i < 2; i++)
      await request(srv()).get('/v1/customers').set(bearer(test.body.secret)).expect(200);
    await api(app, admin).get('/v1/customers').expect(200); // UI ไม่นับ
    await apiUsageMeter.flush(db);
    const rows = await db.usageDaily.findMany({ where: { metric: USAGE_METRIC.apiCalls } });
    expect(rows.map((r) => [r.tenantId, r.source, Number(r.value)])).toEqual([[liveId, 'rest', 4]]);
    // flush รอบสอง บวกเพิ่มแถวเดิม (หลาย instance เขียนแถวเดียวกันได้)
    await request(srv()).get('/v1/customers').set(bearer(live.body.secret)).expect(200);
    await apiUsageMeter.flush(db);
    expect(Number((await daily(liveId, USAGE_METRIC.apiCalls))[0]!.value)).toBe(5);
    // ลูกค้าเห็นยอดเดือนนี้ · e-Tax = null (R-17)
    const r = await api(app, admin).get('/v1/usage/metrics').expect(200);
    expect(r.body).toMatchObject({
      period: '2026-11',
      status: 'open',
      apiCalls: { total: 5, rest: 5, mcp: 0 },
      users: 1,
      eTaxDocuments: null,
    });
  });

  it('ยอดรายวันรวม = ยอดรายเดือน (ปิดยอด) · GAUGE = วันล่าสุด · DO ที่ไม่มีจริงถูกล้างตอนคำนวณใหม่ · เดือนที่ปิดแล้วไม่ถูกบวก', async () => {
    await db.usageDaily.deleteMany({});
    // API calls กระจาย 3 วันของ พ.ย. (รวมวันสุดท้าย 23:59 ไทย) + 1 วันของ ธ.ค.
    const m = new ApiUsageMeter();
    const at = (s: string, n: number) => {
      for (let i = 0; i < n; i++) m.record(liveId, 'rest', new Date(s));
    };
    at('2026-11-01T00:30:00+07:00', 7);
    at('2026-11-15T12:00:00+07:00', 11);
    at('2026-11-30T23:59:00+07:00', 5);
    at('2026-12-01T00:00:01+07:00', 2);
    await m.flush(db);
    // แถว DO ค้าง (เช่น DO ที่ถูกยกเลิกภายหลัง) — การคำนวณใหม่ตอนปิดยอดต้องล้าง
    await db.usageDaily.create({
      data: {
        tenantId: liveId,
        date: new Date('2026-11-03'),
        metric: USAGE_METRIC.doCreated,
        value: 9,
      },
    });
    // POD 1.5 GB อัปโหลด · PDF ที่ระบบสร้างไม่นับ
    const f = { fileKey: 'usage/test', sha256: 'a'.repeat(64) };
    await db.storedDocument.createMany({
      data: [
        { tenantId: liveId, mimeType: 'image/jpeg', sizeBytes: 1024 ** 3, kind: 'POD_PHOTO', ...f },
        {
          tenantId: liveId,
          mimeType: 'image/jpeg',
          sizeBytes: 512 * 1024 ** 2,
          kind: 'OTHER',
          ...f,
        },
        { tenantId: liveId, mimeType: 'application/pdf', sizeBytes: 1024 ** 3, kind: 'PDF', ...f },
      ],
    });
    const svc = app.get(UsageFinalizeService);
    await svc.rollupDaily(new Date('2026-11-30T20:00:00+07:00')); // snapshot วันที่ 30
    expect(await svc.finalize(liveId, '2026-11', new Date('2026-12-01T02:05:00+07:00'))).toBe(true);

    const days = await db.usageDaily.findMany({
      where: {
        tenantId: liveId,
        date: { gte: new Date('2026-11-01'), lt: new Date('2026-12-01') },
      },
    });
    const recs = await db.usageRecord.findMany({ where: { tenantId: liveId, period: '2026-11' } });
    const rec = (k: string) => recs.find((r) => r.metric === k)!;
    for (const k of [USAGE_METRIC.doCreated, USAGE_METRIC.invoicesIssued, USAGE_METRIC.apiCalls]) {
      const sum = days.filter((d) => d.metric === k).reduce((a, d) => a + Number(d.value), 0);
      expect(Number(rec(k).value), k).toBe(sum);
      expect(rec(k).status).toBe('finalized');
    }
    expect(Number(rec(USAGE_METRIC.apiCalls).value)).toBe(23);
    expect(rec(USAGE_METRIC.apiCalls).detail).toEqual({ rest: 23, mcp: 0 });
    expect(Number(rec(USAGE_METRIC.doCreated).value)).toBe(0);
    expect(Number(rec(USAGE_METRIC.podStorage).value)).toBe(1.5);
    expect(rec(USAGE_METRIC.podStorage).detail).toEqual({ asOf: '2026-11-30' });
    expect(Number(rec(USAGE_METRIC.users).value)).toBe(1);
    expect(rec('vehicles.active')).toBeTruthy();
    // ปิดซ้ำ = false · flush หลังปิดยอดไม่บวกเดือน พ.ย.
    expect(await svc.finalize(liveId, '2026-11')).toBe(false);
    at('2026-11-30T23:59:30+07:00', 4);
    at('2026-12-01T09:00:00+07:00', 1);
    await m.flush(db);
    const nov30 = await db.usageDaily.findFirst({
      where: { tenantId: liveId, metric: USAGE_METRIC.apiCalls, date: new Date('2026-11-30') },
    });
    expect(Number(nov30!.value)).toBe(5);
    const dec1 = await db.usageDaily.findFirst({
      where: { tenantId: liveId, metric: USAGE_METRIC.apiCalls, date: new Date('2026-12-01') },
    });
    expect(Number(dec1!.value)).toBe(3);

    // ลูกค้า + Console เห็นยอดปิดเดียวกัน
    const c = await api(app, admin).get('/v1/usage/metrics?period=2026-11').expect(200);
    expect(c.body).toMatchObject({
      status: 'finalized',
      apiCalls: { total: 23, rest: 23, mcp: 0 },
      podStorageGb: 1.5,
      users: 1,
      doCreated: 0,
      invoicesIssued: 0,
      eTaxDocuments: null,
      gaugeAsOf: '2026-11-30',
      metricsSource: 'usage_record',
    });
    const p = await request(srv())
      .get(`/v1/platform/tenants/${encodeId('tenant', liveId)}/usage/metrics?period=2026-11`)
      .set(bearer(staff))
      .expect(200);
    expect(p.body).toEqual(c.body);
  });

  it('review M2: flush ที่ชนการปิดยอด (lock 20 exclusive) รอให้ปิดเสร็จ แล้วไม่บวกเดือนที่ปิด · ยอดรายวันรวม = ยอดเดือน', async () => {
    const m = new ApiUsageMeter();
    m.record(liveId, 'rest', new Date('2026-12-10T10:00:00+07:00'));
    let flushed: Promise<number> | null = null;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20, hashtext(${`${liveId}:2026-12`}))`;
      flushed = m.flush(db);
      await new Promise((ok) => setTimeout(ok, 500));
      await tx.$executeRaw`
        INSERT INTO usage_record (tenant_id, metric, period, value, status, finalized_at)
        VALUES (${liveId}::uuid, 'api.calls', '2026-12', 3, 'finalized', now())`;
    });
    await flushed;
    const dec = await db.usageDaily.findMany({
      where: {
        tenantId: liveId,
        metric: USAGE_METRIC.apiCalls,
        date: { gte: new Date('2026-12-01') },
      },
    });
    const sum = dec.reduce((a, d) => a + Number(d.value), 0);
    expect(sum).toBe(3); // ไม่มี +1 หลังปิด
    await db.$executeRaw`DELETE FROM usage_daily WHERE tenant_id = ${liveId}::uuid AND date >= '2026-12-01'`;
  });

  it('review M3: เดือนที่ปิดยอดรถ active ก่อน T07 (มีแต่แถวรถ) = finalized + คำนวณจาก usage_daily', async () => {
    await db.$executeRaw`
      INSERT INTO usage_record (tenant_id, metric, period, value, status, finalized_at)
      VALUES (${liveId}::uuid, 'vehicles.active', '2026-10', 2, 'invoiced', '2026-11-01T02:05:00+07:00')`;
    await db.usageDaily.create({
      data: {
        tenantId: liveId,
        date: new Date('2026-10-20'),
        metric: USAGE_METRIC.apiCalls,
        source: 'rest',
        value: 8,
      },
    });
    const r = await api(app, admin).get('/v1/usage/metrics?period=2026-10').expect(200);
    expect(r.body).toMatchObject({
      status: 'invoiced',
      metricsSource: 'usage_daily',
      apiCalls: { total: 8, rest: 8, mcp: 0 },
    });
    expect(r.body.finalizedAt).toBe('2026-10-31T19:05:00.000Z');
  });

  it('role แอปเขียน usage_daily ไม่ได้ · RLS เปิด', async () => {
    const priv = await db.$queryRaw<{ ins: boolean; upd: boolean; del: boolean }[]>`
      SELECT has_table_privilege('tms_app', 'usage_daily', 'INSERT') AS ins,
             has_table_privilege('tms_app', 'usage_daily', 'UPDATE') AS upd,
             has_table_privilege('tms_app', 'usage_daily', 'DELETE') AS del`;
    expect(priv[0]).toEqual({ ins: false, upd: false, del: false });
  });
});
