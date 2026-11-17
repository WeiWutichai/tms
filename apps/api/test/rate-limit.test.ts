import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMIT_PROFILES } from '../src/http/rate-limit/profiles';
import {
  gcra,
  RateLimitService,
  slidingWindow,
  type Bucket,
} from '../src/http/rate-limit/rate-limit.service';
import { PrismaService } from '../src/db/prisma.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * ST7-T08 Rate limit (docs/04 G1 "Rate limit", J; docs/01 §5.1; spec/07 INT-081/082)
 * เกณฑ์ตรวจรับ: ยิงเกิน limit ได้ 429 พร้อม `Retry-After`; tenant อื่นไม่ถูกกระทบ
 */
const STD = RATE_LIMIT_PROFILES.standard;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ตัวจำกัดกลาง: อัลกอริทึม (tms_rate_limit_take)', () => {
  let app: NestExpressApplication;
  let rl: RateLimitService;
  let n = 0;
  /** key ใหม่ทุกครั้ง — ไม่ชนกันระหว่าง test */
  const k = () => `unit:${Date.now()}:${n++}`;

  beforeAll(async () => {
    app = await bootApp();
    rl = app.get(RateLimitService);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('GCRA: ผ่านได้ burst ครั้งติดกัน แล้ว 429 พร้อม retry ≈ 1/rate · เติมคืนตามเวลา', async () => {
    const b = gcra(k(), { rate: 10, burst: 3 }, 'tenant');
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await rl.take([b], { failOpen: false }));
    expect(rs.map((r) => r!.allowed)).toEqual([true, true, true, false]);
    expect(rs.slice(0, 3).map((r) => r!.remaining)).toEqual([2, 1, 0]);
    expect(rs[0]!.limit).toBe(3);
    expect(rs[3]!.retryAfterS).toBe(1); // ~100 ms ปัดขึ้นเป็นวินาที
    expect(rs[3]!.scope).toBe('tenant');
    await sleep(120); // เติม 1 token (100 ms ต่อ token)
    expect((await rl.take([b], { failOpen: false }))!.allowed).toBe(true);
    expect((await rl.take([b], { failOpen: false }))!.allowed).toBe(false);
  });

  it('sliding window: N ครั้งในหน้าต่าง · Retry-After = จนคำขอเก่าสุดหลุดหน้าต่าง', async () => {
    const b = slidingWindow(k(), 2, 3000, 'link');
    expect((await rl.take([b], { failOpen: false }))!.allowed).toBe(true);
    expect((await rl.take([b], { failOpen: false }))!.remaining).toBe(0);
    const d = (await rl.take([b], { failOpen: false }))!;
    expect(d.allowed).toBe(false);
    expect(d.retryAfterS).toBeGreaterThanOrEqual(2);
    expect(d.retryAfterS).toBeLessThanOrEqual(3);
    expect(d.scope).toBe('link');
  });

  it('all-or-nothing: bucket หนึ่งเต็ม = ไม่ตัด bucket อื่น · cost หลายหน่วย', async () => {
    const wide = gcra(k(), { rate: 1, burst: 10 }, 'tenant');
    const narrow = slidingWindow(k(), 1, 60_000, 'endpoint');
    expect((await rl.take([wide, narrow], { failOpen: false }))!.allowed).toBe(true);
    const denied = (await rl.take([wide, narrow], { failOpen: false }))!;
    expect(denied.allowed).toBe(false);
    expect(denied.scope).toBe('endpoint');
    // wide ถูกตัดแค่ครั้งแรกครั้งเดียว → เหลือ 9 ก่อนครั้งนี้ → หลังตัด 8
    expect((await rl.take([wide], { failOpen: false }))!.remaining).toBe(8);
    const heavy: Bucket = { ...slidingWindow(k(), 5, 60_000, 'tenant'), cost: 4 };
    expect((await rl.take([heavy], { failOpen: false }))!.remaining).toBe(1);
    expect((await rl.take([heavy], { failOpen: false }))!.allowed).toBe(false);
  });

  it('ใช้ร่วมทุก instance: service ตัวที่ 2 (API อีกเครื่อง) เห็น bucket เดียวกัน', async () => {
    const other = new RateLimitService(app.get(PrismaService));
    try {
      const b = gcra(k(), { rate: 0.01, burst: 2 }, 'key');
      expect((await rl.take([b], { failOpen: false }))!.allowed).toBe(true);
      expect((await other.take([b], { failOpen: false }))!.allowed).toBe(true);
      const d = (await rl.take([b], { failOpen: false }))!;
      expect(d.allowed).toBe(false);
      expect(d.scope).toBe('key');
    } finally {
      other.onModuleDestroy();
    }
  });

  it('พร้อมกันหลายคำขอ: ตัดตรงจำนวน (ล็อกแถว ไม่นับหาย)', async () => {
    const b = gcra(k(), { rate: 0.01, burst: 25 }, 'key');
    const rs = await Promise.all(
      Array.from({ length: 40 }, () => rl.take([b], { failOpen: false })),
    );
    expect(rs.filter((r) => r!.allowed)).toHaveLength(25);
  });

  it('ฐานใช้ไม่ได้: failOpen → ผ่าน (null) · fail-closed → 503 service_busy', async () => {
    const real = (rl as unknown as { prisma: unknown }).prisma;
    (rl as unknown as { prisma: unknown }).prisma = {
      platform: { $queryRaw: () => Promise.reject(new Error('db down')) },
    };
    try {
      expect(await rl.take([gcra(k(), STD.tenant, 'tenant')], { failOpen: true })).toBeNull();
      await expect(rl.assert([gcra(k(), STD.tenant, 'tenant')])).rejects.toMatchObject({
        code: 'service_busy',
      });
    } finally {
      (rl as unknown as { prisma: unknown }).prisma = real;
    }
  });

  it('วัด overhead ต่อคำขอ (3 bucket, 1 round trip) — p50 < 2 ms ในเครื่อง', async () => {
    const t = 'bench';
    const buckets = [
      gcra(`${k()}:${t}`, STD.tenant, 'tenant'),
      gcra(`${k()}:${t}`, STD.user, 'user'),
      gcra(`${k()}:${t}`, STD.heavy, 'endpoint'),
    ];
    const big = buckets.map((b) => ({ ...b, periodMs: 1, limit: 1_000_000 }));
    for (let i = 0; i < 20; i++) await rl.take(big, { failOpen: true }); // warm up
    const ms: number[] = [];
    for (let i = 0; i < 300; i++) {
      const s = performance.now();
      await rl.take(big, { failOpen: true });
      ms.push(performance.now() - s);
    }
    ms.sort((a, b) => a - b);
    const p50 = ms[Math.floor(ms.length / 2)]!;
    const p95 = ms[Math.floor(ms.length * 0.95)]!;
    process.stderr.write(
      `rate limit overhead: p50 ${p50.toFixed(2)} ms · p95 ${p95.toFixed(2)} ms\n`,
    );
    expect(p50).toBeLessThan(5); // เพดานหลวมกันเครื่อง CI ช้า — ค่าจริงรายงานใน log
  });
});

describe('Rate limit ของ /v1 (ST7-T08)', () => {
  let app: NestExpressApplication;
  let rl: RateLimitService;
  const db = platform();
  let tA: string;
  let tB: string;
  const srv = (a = app) => a.getHttpServer();
  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  let seq = 0;
  /** ผู้ใช้ใหม่ทุกครั้ง (bucket ผู้ใช้สด) */
  const user = (tid: string) => tokenFor(tid, '*', `u-${seq++}`);
  const burst = (n: number, fn: () => request.Test) =>
    Promise.all(Array.from({ length: n }, () => fn()));

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    rl = app.get(RateLimitService);
    rl.enabled = true;
    tA = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง เอ' })).id;
    tB = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง บี' })).id;
  });
  beforeEach(async () => {
    await rl.reset();
    rl.invalidateProfile();
  });
  afterAll(async () => {
    await db.tenant.updateMany({ data: { rateLimitProfile: null } });
    await app?.close();
    await db.$disconnect();
  });

  it('ทุก response ที่ยืนยันตัวตนมี RateLimit-Limit/-Remaining/-Reset (bucket ที่ใกล้เต็มสุด)', async () => {
    const r = await api(app, await user(tA))
      .get('/v1/customers')
      .expect(200);
    // ผู้ใช้ (burst 40) ใกล้เต็มกว่าบริษัท (burst 100)
    expect(r.headers['ratelimit-limit']).toBe(String(STD.user.burst));
    expect(r.headers['ratelimit-remaining']).toBe(String(STD.user.burst - 1));
    expect(Number(r.headers['ratelimit-reset'])).toBeGreaterThanOrEqual(0);
    expect(r.headers['retry-after']).toBeUndefined();
    // route สาธารณะที่ไม่รู้ tenant ไม่ผ่านชั้นนี้
    const h = await request(srv()).get('/v1/health').expect(200);
    expect(h.headers['ratelimit-limit']).toBeUndefined();
  });

  it('เกณฑ์ตรวจรับ: ยิงเกินเพดานผู้ใช้ → 429 problem+json + Retry-After · ผู้ใช้อื่น/tenant อื่นไม่กระทบ', async () => {
    const a1 = await user(tA);
    const started = performance.now();
    const rs = await burst(STD.user.burst + 30, () => api(app, a1).get('/v1/customers'));
    const elapsedS = (performance.now() - started) / 1000;
    const tooMany = rs.filter((r) => r.status === 429);
    expect(tooMany.length).toBeGreaterThan(0);
    // ผ่านได้ไม่เกิน burst + ที่เติมระหว่างยิง (20/s)
    expect(rs.filter((r) => r.status === 200).length).toBeLessThanOrEqual(
      STD.user.burst + Math.ceil(elapsedS * STD.user.rate) + 1,
    );
    const x = tooMany[0]!;
    expect(x.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(x.body).toMatchObject({ status: 429, code: 'rate_limited', scope: 'user' });
    expect(Number(x.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(x.body.retryAfter).toBe(Number(x.headers['retry-after']));
    expect(x.headers['ratelimit-remaining']).toBe('0');
    expect(x.body.requestId).toBeTruthy();
    // ผู้ใช้อื่นในบริษัทเดียวกัน และบริษัทอื่น ใช้งานได้ปกติ
    await api(app, await user(tA))
      .get('/v1/customers')
      .expect(200);
    await api(app, await user(tB))
      .get('/v1/customers')
      .expect(200);
  });

  it('เพดานรวมของบริษัท (50/s burst 100) — หลายผู้ใช้รวมกันเกิน → 429 scope tenant · tenant อื่นไม่กระทบ', async () => {
    // ใช้โควตาบริษัทไป 95 จาก 100 (เหมือนผู้ใช้หลายคน/API key ยิงพร้อมกัน) แล้วผู้ใช้ใหม่ 3 คนยิงคนละ 10
    await rl.take([{ ...gcra(`t:${tA}`, STD.tenant, 'tenant'), cost: 95 }], { failOpen: false });
    const users = await Promise.all([1, 2, 3].map(() => user(tA)));
    const rs = await Promise.all(
      users.map((u) => burst(10, () => api(app, u).get('/v1/customers'))),
    );
    const all = rs.flat();
    const denied = all.filter((r) => r.status === 429);
    expect(denied.length).toBeGreaterThan(0);
    // ผู้ใช้แต่ละคนยังไม่ถึงเพดานของตัวเอง (10 < 40) → ที่ถูกตัดคือเพดานบริษัท
    expect(denied.every((r) => r.body.scope === 'tenant')).toBe(true);
    const b = await api(app, await user(tB))
      .get('/v1/customers')
      .expect(200);
    expect(b.headers['ratelimit-remaining']).toBe(String(STD.user.burst - 1));
  });

  it('ต่อ API key 20/s — key หนึ่งเต็ม key อื่นของบริษัทเดียวกันยังใช้ได้', async () => {
    const admin = await user(tA);
    const mk = async (name: string) =>
      (
        await api(app, admin)
          .post('/v1/api-keys')
          .send({ name, scopes: ['master:read'] })
      ).body.secret as string;
    const k1 = await mk('ERP หนึ่ง');
    const k2 = await mk('ERP สอง');
    await rl.reset();
    const started = performance.now();
    const rs = await Promise.all(
      Array.from({ length: STD.key.burst + 14 }, () =>
        request(srv()).get('/v1/customers').set(bearer(k1)),
      ),
    );
    const elapsedS = (performance.now() - started) / 1000;
    expect(
      rs
        .filter((r) => r.status !== 200 && r.status !== 429)
        .map((r) => JSON.stringify(r.body))
        .slice(0, 2),
    ).toEqual([]);
    const ok = rs.filter((r) => r.status === 200).length;
    // ผ่านได้ไม่เกิน burst + ที่เติมระหว่างยิง (20/s)
    expect(ok).toBeLessThanOrEqual(STD.key.burst + Math.ceil(elapsedS * STD.key.rate) + 1);
    const denied = rs.filter((r) => r.status === 429);
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]!.body.scope).toBe('key');
    expect(Number(denied[0]!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const other = await request(srv()).get('/v1/customers').set(bearer(k2)).expect(200);
    expect(other.headers['ratelimit-limit']).toBe(String(STD.key.burst));
  });

  it('คำขอหนัก (export) 5/s ต่อบริษัท → 429 scope endpoint · คำขอปกติของบริษัทเดียวกันยังผ่าน', async () => {
    const u = await user(tA);
    const started = performance.now();
    const rs = await burst(STD.heavy.burst + 10, () => api(app, u).get('/v1/customers/export'));
    const elapsedS = (performance.now() - started) / 1000;
    expect(rs.filter((r) => r.status === 200).length).toBeLessThanOrEqual(
      STD.heavy.burst + Math.ceil(elapsedS * STD.heavy.rate) + 1,
    );
    const denied = rs.filter((r) => r.status === 429);
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]!.body.scope).toBe('endpoint');
    await api(app, u).get('/v1/customers').expect(200);
  });

  it('rateLimitProfile: แพ็กเกจกำหนดค่าเริ่ม · บริษัททับได้ (high = 2 เท่า)', async () => {
    const plan = await db.tenant.findUniqueOrThrow({
      where: { id: tA },
      select: { plan: { select: { rateLimitProfile: true } } },
    });
    expect(plan.plan.rateLimitProfile).toBe('standard');
    await db.tenant.update({ where: { id: tA }, data: { rateLimitProfile: 'high' } });
    rl.invalidateProfile(tA);
    const r = await api(app, await user(tA))
      .get('/v1/customers')
      .expect(200);
    expect(r.headers['ratelimit-limit']).toBe(String(RATE_LIMIT_PROFILES.high.user.burst));
    // แพ็กเกจของบริษัท B ยังเป็น standard
    const b = await api(app, await user(tB))
      .get('/v1/customers')
      .expect(200);
    expect(b.headers['ratelimit-limit']).toBe(String(STD.user.burst));
    await db.tenant.update({ where: { id: tA }, data: { rateLimitProfile: null } });
    // ค่าที่ไม่รู้จักถูก CHECK ปฏิเสธ
    await expect(
      db.tenant.update({ where: { id: tA }, data: { rateLimitProfile: 'unlimited' } }),
    ).rejects.toThrow();
  });

  it('ฐานของตัวจำกัดใช้ไม่ได้ → ชั้น /v1 fail-open (ผ่าน ไม่มี header)', async () => {
    const u = await user(tA);
    await api(app, u).get('/v1/customers').expect(200); // cache โปรไฟล์ไว้ก่อน
    const real = (rl as unknown as { prisma: unknown }).prisma;
    (rl as unknown as { prisma: unknown }).prisma = {
      platform: { $queryRaw: () => Promise.reject(new Error('db down')) },
    };
    try {
      const r = await api(app, u).get('/v1/customers').expect(200);
      expect(r.headers['ratelimit-limit']).toBeUndefined();
    } finally {
      (rl as unknown as { prisma: unknown }).prisma = real;
    }
  });

  it('วัด overhead ต่อคำขอ HTTP จริง (เปิด vs ปิด)', async () => {
    const u = await user(tA);
    const run = async (on: boolean) => {
      rl.enabled = on;
      const ms: number[] = [];
      for (let i = 0; i < 30; i++) {
        const s = performance.now();
        await api(app, u).get('/v1/customers').expect(200);
        ms.push(performance.now() - s);
      }
      return ms.sort((a, b) => a - b)[15]!;
    };
    await run(false); // warm up
    const off = await run(false);
    const on = await run(true);
    rl.enabled = true;
    process.stderr.write(
      `GET /v1/customers p50: ปิด ${off.toFixed(2)} ms · เปิด ${on.toFixed(2)} ms (ต่าง ${(on - off).toFixed(2)} ms)\n`,
    );
  });

  it('ปิดด้วย enabled=false (เช่น RATE_LIMIT=off) → ไม่จำกัด ไม่มี header', async () => {
    rl.enabled = false;
    try {
      const r = await api(app, await user(tA))
        .get('/v1/customers')
        .expect(200);
      expect(r.headers['ratelimit-limit']).toBeUndefined();
    } finally {
      rl.enabled = true;
    }
  });

  it('OpenAPI: ทุก route ที่จำกัดมี response 429 (RateLimited) + header RateLimit-*', async () => {
    const doc = (await request(srv()).get('/v1/openapi.json').expect(200)).body;
    expect(doc.components.responses.RateLimited.headers['Retry-After']).toBeTruthy();
    const op = doc.paths['/v1/customers'].get;
    expect(op.responses['429'].$ref).toBe('#/components/responses/RateLimited');
    expect(Object.keys(op.responses['200'].headers)).toEqual(
      expect.arrayContaining(['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset']),
    );
    expect(doc.paths['/v1/health'].get.responses['429']).toBeUndefined();
  });
});
