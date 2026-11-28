import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { signPlatformToken } from '../src/auth/tokens';
import { Clock } from '../src/common/clock';
import { encodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import {
  ApiTrafficMeter,
  apiTrafficMeter,
  apiTrafficTenant,
  latencySlot,
  LATENCY_BOUNDS_MS,
  p95FromHist,
  sumHist,
} from '../src/modules/usage/api-traffic-meter';
import { apiUsageMeter } from '../src/modules/usage/api-usage-meter';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * P1-ST4-T05 Console "การใช้งาน API" (spec/01 §10.7 PLT-115 · plan/13)
 * เกณฑ์ตรวจรับ: ปิด API → key ของ tenant ได้ 403 `api_disabled_by_platform` ทันที (key ไม่ถูกลบ) · เปิดกลับใช้ได้ ·
 * เหตุผล + audit + แจ้งลูกค้า · ตาราง: calls 30 วัน, 4xx/5xx, p95, 429, rate limit ปัจจุบัน
 */

const NOW = new Date();
const bkkDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

describe('สถิติคำขอ (ฟังก์ชันบริสุทธิ์)', () => {
  it('ช่อง histogram + p95 = ขอบบนของช่องที่ยอดสะสมถึง 95%', () => {
    expect(latencySlot(0)).toBe(0);
    expect(latencySlot(10)).toBe(0);
    expect(latencySlot(10.1)).toBe(1);
    expect(latencySlot(99_999)).toBe(LATENCY_BOUNDS_MS.length);
    expect(p95FromHist([])).toBeNull();
    // 100 คำขอ: 94 เร็ว ≤ 10 ms, 6 ช้า ≤ 500 ms → p95 = 500
    const h = sumHist([]);
    h[0] = 94;
    h[latencySlot(400)] = 6;
    expect(p95FromHist(h)).toEqual({ ms: 500, over: false });
    h[0] = 95;
    h[latencySlot(400)] = 5;
    expect(p95FromHist(h)).toEqual({ ms: 10, over: false });
    const slow = sumHist([
      [0, 1],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99],
    ]);
    expect(p95FromHist(slow)).toEqual({ ms: 10000, over: true });
  });
  it('นับเฉพาะ client ภายนอกที่รู้ tenant · ไม่นับ UI / sandbox', () => {
    expect(apiTrafficTenant({ tenantId: 't', principalType: 'client' })).toBe('t');
    expect(apiTrafficTenant({ tenantId: 't', principalType: 'user' })).toBeNull();
    expect(apiTrafficTenant({ tenantId: 't', principalType: 'client', sandbox: {} })).toBeNull();
    expect(apiTrafficTenant({ principalType: 'client' })).toBeNull();
    // ถูกปฏิเสธตอนตรวจ key (ยังไม่มี principal) — นับด้วย trafficTenantId
    expect(apiTrafficTenant({ trafficTenantId: 't' })).toBe('t');
    expect(apiTrafficTenant(undefined)).toBeNull();
    const m = new ApiTrafficMeter();
    m.record('t', 200, 5);
    m.record('t', 429, 1);
    expect(m.pendingKeys).toBe(1);
  });
});

describe('Console การใช้งาน API + ปิด/เปิด API (P1-ST4-T05)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  const staff: Record<string, string> = {};
  const staffId: Record<string, string> = {};
  const srv = () => app.getHttpServer();
  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const con = (role: string) => ({
    get: (p: string) => request(srv()).get(p).set(bearer(staff[role]!)),
    post: (p: string, b: object) => request(srv()).post(p).set(bearer(staff[role]!)).send(b),
  });
  let live: { secret: string; clientId: string; id: string };
  let test: { secret: string };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    // ตัวนับใน middleware ใช้เวลาจริง → ตั้ง Clock = เวลาจริงด้วย (เดิมฝังวันที่ 28 พ.ย. — ล้มหลังเที่ยงคืน)
    app.get(Clock).set(NOW);
    const t = await createTenantWithDefaults(db, {
      name: 'บริษัท ใช้ API จำกัด',
      status: 'ACTIVE',
    });
    tenantId = t.id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท ข้างเคียง', status: 'ACTIVE' }))
      .id;
    await createTenantWithDefaults(db, { name: 'บริษัท ยกเลิกแล้ว', status: 'CANCELLED' });
    const roles = await ensureSystemRoles(db, t.id);
    const owner = await db.appUser.create({
      data: { tenantId, email: 'owner@api-usage.test', name: 'เจ้าของ', status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId, userId: owner.id, roleId: roles.owner! } });
    admin = await tokenFor(tenantId, '*', owner.id);
    for (const role of ['SUPER_ADMIN', 'SUPPORT', 'BILLING'] as const) {
      const p = await db.platformUser.create({
        data: {
          email: `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@innovera.test`,
          name: `ทีม ${role}`,
          role,
          passwordHash: 'x',
          totpSecret: 'x',
        },
      });
      staffId[role] = p.id;
      staff[role] = await signPlatformToken({ sub: p.id, role, tv: p.tokenVersion });
    }
    const k = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'ERP', scopes: ['master:read'] })
      .expect(201);
    live = { secret: k.body.secret, clientId: k.body.clientId, id: k.body.id };
    const s = await api(app, admin)
      .post('/v1/api-keys')
      .set('X-Tms-Mode', 'test')
      .send({ name: 'sandbox', mode: 'test', scopes: ['master:read'] })
      .expect(201);
    test = { secret: s.body.secret };
  });
  afterAll(async () => {
    app.get(Clock).set(null);
    await app.close();
    await db.$disconnect();
  });

  it('ตาราง: นับคำขอ/4xx/429 ของ key live · ไม่นับ UI และ sandbox · rate limit ปัจจุบัน · ซ่อนบริษัทที่ยกเลิก', async () => {
    await apiTrafficMeter.flush(db);
    await apiUsageMeter.flush(db);
    await db.apiTrafficDaily.deleteMany({});
    for (let i = 0; i < 3; i++)
      await request(srv()).get('/v1/customers').set(bearer(live.secret)).expect(200);
    await request(srv())
      .get(`/v1/customers/${encodeId('customer', randomUUID())}`)
      .set(bearer(live.secret))
      .expect(404);
    await request(srv()).get('/v1/customers').set(bearer(test.secret)).expect(200);
    await api(app, admin).get('/v1/customers').expect(200);
    await apiTrafficMeter.flush(db);
    // 429 + 5xx เขียนตรงผ่านตัวนับ (rate limit ปิดใน test) — flush รอบสองบวกเพิ่มแถวเดิม + histogram
    apiTrafficMeter.record(tenantId, 429, 1, NOW);
    apiTrafficMeter.record(tenantId, 503, 2000, NOW);
    // วันเก่ากว่า 30 วัน ไม่อยู่ในตาราง
    apiTrafficMeter.record(tenantId, 200, 5, new Date(NOW.getTime() - 60 * 86_400_000));
    await apiTrafficMeter.flush(db);
    const day = await db.apiTrafficDaily.findMany({ where: { tenantId } });
    expect(day).toHaveLength(2);

    await con('BILLING').get('/v1/platform/api-usage').expect(200); // ทุก role ดูได้
    const r = await con('SUPPORT').get('/v1/platform/api-usage').expect(200);
    expect(r.body).toMatchObject({
      from: bkkDate(new Date(NOW.getTime() - 29 * 86_400_000)),
      to: bkkDate(NOW),
      days: 30,
    });
    const names = r.body.rows.map((x: { name: string }) => x.name);
    expect(names).not.toContain('บริษัท ยกเลิกแล้ว');
    const row = r.body.rows.find(
      (x: { tenantId: string }) => x.tenantId === encodeId('tenant', tenantId),
    );
    expect(row).toMatchObject({
      requests: 6,
      errors4xx: 1,
      errors5xx: 1,
      throttled: 1,
      apiInPlan: true,
      apiDisabled: false,
      apiDisabledAt: null,
      rateLimit: {
        profile: 'standard',
        override: false,
        tenantPerMinute: 3000,
        keyPerMinute: 1200,
      },
    });
    expect(typeof row.p95Ms).toBe('number');
    expect(row.p95Ms).toBeGreaterThanOrEqual(10);
    const other = r.body.rows.find(
      (x: { tenantId: string }) => x.tenantId === encodeId('tenant', otherId),
    );
    expect(other).toMatchObject({ requests: 0, p95Ms: null, throttled: 0 });

    // tenant ปรับโปรไฟล์ high → แสดงเพดานใหม่ + override
    await db.tenant.update({ where: { id: otherId }, data: { rateLimitProfile: 'high' } });
    const r2 = await con('SUPPORT').get('/v1/platform/api-usage').expect(200);
    expect(
      r2.body.rows.find((x: { tenantId: string }) => x.tenantId === encodeId('tenant', otherId))
        .rateLimit,
    ).toEqual({ profile: 'high', override: true, tenantPerMinute: 6000, keyPerMinute: 2400 });
  });

  it('ปิด API → key live/sandbox/OAuth ได้ 403 api_disabled_by_platform ทันที · key ไม่ถูกลบ · UI ใช้ได้ · เปิดกลับใช้ได้ · เหตุผล + audit + อีเมล', async () => {
    const id = encodeId('tenant', tenantId);
    const reason = 'ลูกค้ายิง API ผิดปกติจนกระทบระบบ';
    // สิทธิ์: BILLING ไม่ได้ · เหตุผลสั้น = 422
    await con('BILLING').post(`/v1/platform/tenants/${id}/api/disable`, { reason }).expect(403);
    await con('SUPPORT')
      .post(`/v1/platform/tenants/${id}/api/disable`, { reason: 'สั้น' })
      .expect(422);
    await con('SUPPORT')
      .post(`/v1/platform/tenants/${encodeId('tenant', randomUUID())}/api/disable`, { reason })
      .expect(404);
    await con('SUPPORT').post(`/v1/platform/tenants/${id}/api/enable`, { reason }).expect(409);

    // JWT ของ client credentials ที่ขอไว้ก่อนปิด
    const jwt = (
      await request(srv())
        .post('/v1/oauth/token')
        .send({
          grantType: 'client_credentials',
          clientId: live.clientId,
          clientSecret: live.secret,
        })
        .expect(200)
    ).body.accessToken as string;
    await request(srv()).get('/v1/customers').set(bearer(jwt)).expect(200);
    await apiTrafficMeter.flush(db);
    await db.apiTrafficDaily.deleteMany({});

    const d = await con('SUPPORT')
      .post(`/v1/platform/tenants/${id}/api/disable`, { reason })
      .expect(200);
    expect(d.body).toMatchObject({ tenantId: id, apiDisabled: true });
    expect(d.body.apiDisabledAt).toBeTruthy();
    await con('SUPER_ADMIN').post(`/v1/platform/tenants/${id}/api/disable`, { reason }).expect(409);

    for (const k of [live.secret, test.secret]) {
      const res = await request(srv()).get('/v1/customers').set(bearer(k));
      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('api_disabled_by_platform');
    }
    const tok = await request(srv()).post('/v1/oauth/token').send({
      grantType: 'client_credentials',
      clientId: live.clientId,
      clientSecret: live.secret,
    });
    expect(tok.status).toBe(403);
    expect(tok.body.code).toBe('api_disabled_by_platform');
    // JWT ที่ออกก่อนปิดก็ใช้ไม่ได้ทันที (ตรวจ key กับฐานทุกคำขอ)
    const viaJwt = await request(srv()).get('/v1/customers').set(bearer(jwt));
    expect(viaJwt.status).toBe(403);
    expect(viaJwt.body.code).toBe('api_disabled_by_platform');
    // คำขอที่ถูกปฏิเสธตอนตรวจ key ถูกนับในสถิติ (key live + /oauth/token + JWT = 3 · sandbox ไม่นับ)
    await apiTrafficMeter.flush(db);
    const rej = await db.apiTrafficDaily.findMany({ where: { tenantId } });
    expect(rej.map((r) => [r.requests, r.errors4xx, r.errors5xx])).toEqual([[3, 3, 0]]);
    // key ยังอยู่ (ไม่ถูกเพิกถอน/ลบ) · ผู้ใช้หน้าเว็บใช้งานได้ตามปกติ
    const keys = await api(app, admin).get('/v1/api-keys').expect(200);
    expect(JSON.stringify(keys.body)).toContain(live.id);
    await api(app, admin).get('/v1/customers').expect(200);
    // บริษัทอื่นไม่โดน
    expect(
      (await db.tenant.findUniqueOrThrow({ where: { id: otherId } })).apiDisabledAt,
    ).toBeNull();
    const list = await con('BILLING').get('/v1/platform/api-usage').expect(200);
    expect(list.body.rows.find((x: { tenantId: string }) => x.tenantId === id).apiDisabled).toBe(
      true,
    );

    await con('SUPER_ADMIN')
      .post(`/v1/platform/tenants/${id}/api/enable`, { reason: 'ลูกค้าแก้ระบบที่เชื่อมแล้ว' })
      .expect(200);
    await request(srv()).get('/v1/customers').set(bearer(live.secret)).expect(200);
    await request(srv()).get('/v1/customers').set(bearer(test.secret)).expect(200);
    await request(srv()).get('/v1/customers').set(bearer(jwt)).expect(200);
    const t = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect([t.apiDisabledAt, t.apiDisabledBy]).toEqual([null, null]);

    const audit = await db.auditLog.findMany({
      where: { tenantId, action: { in: ['platform.api_disabled', 'platform.api_enabled'] } },
      orderBy: { seq: 'asc' },
    });
    expect(audit.map((a) => [a.action, a.actorId, a.reason])).toEqual([
      ['platform.api_disabled', `platform:${staffId.SUPPORT}`, reason],
      ['platform.api_enabled', `platform:${staffId.SUPER_ADMIN}`, 'ลูกค้าแก้ระบบที่เชื่อมแล้ว'],
    ]);
    const mails = await db.emailOutbox.findMany({
      where: { tenantId, template: 'api_access_changed' },
      orderBy: { createdAt: 'asc' },
    });
    expect(mails.map((m) => m.toAddress)).toEqual(['owner@api-usage.test', 'owner@api-usage.test']);
    expect(mails[0]!.subject).toContain('ปิดการใช้งาน API');
    expect(mails[0]!.textBody).toContain(reason);
    expect(mails[1]!.subject).toContain('เปิดการใช้งาน API');
  });

  it('ตาราง api_traffic_daily: role แอปเขียนไม่ได้', async () => {
    const priv = await db.$queryRaw<{ ins: boolean; upd: boolean }[]>`
      SELECT has_table_privilege('tms_app', 'api_traffic_daily', 'INSERT') AS ins,
             has_table_privilege('tms_app', 'api_traffic_daily', 'UPDATE') AS upd`;
    expect(priv[0]).toEqual({ ins: false, upd: false });
  });
});
