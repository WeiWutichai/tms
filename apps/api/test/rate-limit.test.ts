import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMIT_PROFILES } from '../src/http/rate-limit/profiles';
import { PrismaClient } from '@prisma/client';
import {
  gcra,
  ipKey,
  rateKey,
  RateLimitService,
  storedKey,
  slidingWindow,
  type Bucket,
} from '../src/http/rate-limit/rate-limit.service';
import { TOKEN_PER_CLIENT_PER_MIN, TOKEN_PER_IP_PER_MIN } from '../src/auth/auth.controller';
import { BAD_SIGNATURE_PER_MIN } from '../src/modules/documents/documents.controller';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * ST7-T08 Rate limit (docs/04 G1 "Rate limit", J; docs/01 §5.1; spec/07 INT-081/082)
 * เกณฑ์ตรวจรับ: ยิงเกิน limit ได้ 429 พร้อม `Retry-After`; tenant อื่นไม่ถูกกระทบ
 */
const STD = RATE_LIMIT_PROFILES.standard;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ที่เก็บล่ม (ทุกคำสั่ง error) */
const down = {
  $queryRaw: () => Promise.reject(new Error('db down')),
  $executeRaw: () => Promise.reject(new Error('db down')),
  $disconnect: async () => undefined,
} as unknown as RateLimitService['db'];

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

  it('GCRA: ผ่านได้ burst ครั้งติดกัน แล้วปฏิเสธพร้อม retry ≈ 1/rate · เติมคืนตามเวลา', async () => {
    const b = gcra(k(), { rate: 1, burst: 3 }, 'tenant');
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await rl.take([b], { failOpen: false }));
    expect(rs.map((r) => r!.allowed)).toEqual([true, true, true, false]);
    expect(rs.slice(0, 3).map((r) => r!.remaining)).toEqual([2, 1, 0]);
    expect(rs[0]!.limit).toBe(3);
    expect(rs[3]!.retryAfterS).toBe(1); // ≤ 1 วินาที ปัดขึ้น
    expect(rs[3]!.scope).toBe('tenant');
    await sleep(1100); // เติม 1 token (1 วินาทีต่อ token)
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
    const other = new RateLimitService();
    try {
      const b = gcra(k(), { rate: 0.01, burst: 2 }, 'key');
      expect((await rl.take([b], { failOpen: false }))!.allowed).toBe(true);
      expect((await other.take([b], { failOpen: false }))!.allowed).toBe(true);
      const d = (await rl.take([b], { failOpen: false }))!;
      expect(d.allowed).toBe(false);
      expect(d.scope).toBe('key');
    } finally {
      await other.onModuleDestroy();
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
    const real = rl.db;
    rl.db = down;
    try {
      expect(await rl.take([gcra(k(), STD.tenant, 'tenant')], { failOpen: true })).toBeNull();
      await expect(rl.assert([gcra(k(), STD.tenant, 'tenant')])).rejects.toMatchObject({
        code: 'service_busy',
      });
    } finally {
      rl.db = real;
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
    const real = rl.db;
    rl.db = down;
    try {
      const r = await api(app, u).get('/v1/customers').expect(200);
      expect(r.headers['ratelimit-limit']).toBeUndefined();
    } finally {
      rl.db = real;
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

describe('ST7-T08 แก้ตาม review/QA: แยก pool, สิทธิ์, คืน, ล้าง, token, URL ลายเซ็น', () => {
  let app: NestExpressApplication;
  let rl: RateLimitService;
  const db = platform();
  const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  let tA: string;
  let tB: string;
  let n = 0;
  const k = () => `fix:${Date.now()}:${n++}`;

  beforeAll(async () => {
    app = await bootApp();
    rl = app.get(RateLimitService);
    rl.enabled = true;
    tA = (await createTenantWithDefaults(db, { name: 'บริษัท ร้อน เอ' })).id;
    tB = (await createTenantWithDefaults(db, { name: 'บริษัท ร้อน บี' })).id;
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await appDb.$disconnect();
  });

  it('(M2) แอป tms_app อ่าน/เขียนที่เก็บและเรียกฟังก์ชันไม่ได้ · role platform ได้', async () => {
    await expect(appDb.$queryRaw`SELECT * FROM rate_limit_bucket LIMIT 1`).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      appDb.$executeRaw`INSERT INTO rate_limit_bucket ("key") VALUES ('x')`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      appDb.$queryRaw`SELECT * FROM tms_rate_limit_take(ARRAY['x'], ARRAY['g'], ARRAY[1000]::float8[], ARRAY[1], ARRAY[1])`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      appDb.$queryRaw`SELECT tms_rate_limit_refund(ARRAY['x'], 1::float8)`,
    ).rejects.toThrow(/permission denied/);
    expect((await rl.take([gcra(k(), STD.tenant, 'tenant')], { failOpen: false }))!.allowed).toBe(
      true,
    );
  });

  it('(M2) IP ในที่เก็บเป็น hash ไม่ใช่ IP ดิบ · IPv6 นับต่อ /64 · loopback', async () => {
    expect(ipKey('203.0.113.7')).not.toContain('203');
    expect(ipKey('::ffff:203.0.113.7')).toBe(ipKey('203.0.113.7'));
    expect(rateKey('::1')).toBe('::1');
    expect(rateKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateKey('2001:db8:0:0:aa::1')).toBe(rateKey('2001:0db8::ffff'));
    const r = await request(app.getHttpServer())
      .get('/v1/public/tracking/nope')
      .set('X-Forwarded-For', '198.51.100.23');
    expect(r.status).toBe(404);
    const rows = await db.$queryRaw<{ key: string }[]>`
      SELECT "key" FROM rate_limit_bucket WHERE "key" LIKE ${storedKey('%')}`;
    expect(rows.some((x) => x.key.includes('198.51.100.23'))).toBe(false);
  });

  it('(M1) แถวร้อนถูกล็อกค้าง: คำขอของบริษัทนั้นผ่านแบบ fail-open ใน ≤ ~1 วิ · บริษัทอื่นและ /health ไม่กระทบ', async () => {
    const ua = await tokenFor(tA, '*', 'hot-a');
    const ub = await tokenFor(tB, '*', 'hot-b');
    await api(app, ua).get('/v1/customers').expect(200); // สร้างแถว t:<tA> + cache โปรไฟล์
    await api(app, ub).get('/v1/customers').expect(200);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const tx = db.$transaction(
      async (t) => {
        await t.$queryRaw`SELECT 1 FROM rate_limit_bucket WHERE "key" = ${storedKey(`t:${tA}`)} FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    try {
      const started = performance.now();
      const burstA = Promise.all(
        Array.from({ length: 40 }, () => api(app, ua).get('/v1/customers')),
      );
      await sleep(50);
      const t0 = performance.now();
      await api(app, ub).get('/v1/customers').expect(200);
      const bMs = performance.now() - t0;
      const t1 = performance.now();
      await request(app.getHttpServer()).get('/v1/health').expect(200);
      const hMs = performance.now() - t1;
      const rs = await burstA;
      const aMs = performance.now() - started;
      process.stderr.write(
        `hot row: tenant B ${bMs.toFixed(0)} ms · health ${hMs.toFixed(0)} ms · tenant A 40 คำขอ ${aMs.toFixed(0)} ms\n`,
      );
      expect(bMs).toBeLessThan(1000);
      expect(hMs).toBeLessThan(1000);
      expect(rs.every((r) => r.status === 200)).toBe(true); // fail-open (lock_timeout 200 ms)
    } finally {
      release();
      await tx;
    }
  }, 30_000);

  it('(M1) ถูกปฏิเสธแล้วจำในเครื่องจนถึง Retry-After — ไม่ถามฐานซ้ำ', async () => {
    const b = gcra(k(), { rate: 0.5, burst: 1 }, 'user');
    expect((await rl.take([b], { failOpen: true }))!.allowed).toBe(true);
    expect((await rl.take([b], { failOpen: true }))!.allowed).toBe(false);
    const real = rl.db;
    let calls = 0;
    rl.db = {
      ...down,
      $queryRaw: () => {
        calls++;
        return Promise.reject(new Error('should not be called'));
      },
    } as unknown as RateLimitService['db'];
    try {
      const d = (await rl.take([b], { failOpen: true }))!;
      expect(d.allowed).toBe(false);
      expect(d.scope).toBe('user');
      expect(d.retryAfterS).toBeGreaterThanOrEqual(1);
      expect(calls).toBe(0);
    } finally {
      rl.db = real;
    }
  });

  it('(QA M3) คืนการจองของหน้าต่างเลื่อน (refund) → ใช้ช่องนั้นได้อีก', async () => {
    const b = slidingWindow(k(), 1, 60_000, 'lookup');
    const d = (await rl.take([b], { failOpen: false }))!;
    expect((await rl.take([b], { failOpen: false }))!.allowed).toBe(false);
    await rl.refund([b.key], d.atMs);
    expect((await rl.take([b], { failOpen: false }))!.allowed).toBe(true);
  });

  it('(M4) ล้าง bucket ตามเวลาหมดของ bucket เอง (ไม่ใช่ 1 วัน) จนหมด', async () => {
    const w = slidingWindow(k(), 5, 50, 'ip');
    const g = gcra(k(), { rate: 20, burst: 1 }, 'user');
    const long = slidingWindow(k(), 5, 3_600_000, 'ip');
    await rl.take([w, g, long], { failOpen: false });
    await sleep(120);
    await rl.cleanup();
    const rows = await db.$queryRaw<{ key: string }[]>`
      SELECT "key" FROM rate_limit_bucket WHERE "key" = ANY(${[w.key, g.key, long.key].map(storedKey)})`;
    expect(rows.map((r) => r.key)).toEqual([storedKey(long.key)]);
  });

  it('(M3) POST /oauth/token จำกัดต่อ client id และต่อ IP → 429 + Retry-After + scope', async () => {
    const srv = app.getHttpServer();
    const cc = (i: number) =>
      request(srv)
        .post('/v1/oauth/token')
        .set('X-Forwarded-For', `192.0.2.${(i % 200) + 1}`)
        .send({ grantType: 'client_credentials', clientId: 'cli-brute', clientSecret: 'x' });
    const codes: number[] = [];
    for (let i = 0; i < TOKEN_PER_CLIENT_PER_MIN + 1; i++) codes.push((await cc(i)).status);
    expect(codes.slice(0, TOKEN_PER_CLIENT_PER_MIN).every((c) => c !== 429)).toBe(true);
    const last = await cc(250);
    expect(last.status).toBe(429);
    expect(last.body.scope).toBe('key');
    expect(Number(last.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const ip = () =>
      request(srv)
        .post('/v1/oauth/token')
        .set('X-Forwarded-For', '198.51.100.77')
        .send({ grantType: 'authorization_code' });
    for (let i = 0; i < TOKEN_PER_IP_PER_MIN; i++) expect((await ip()).status).not.toBe(429);
    const r = await ip();
    expect(r.status).toBe(429);
    expect(r.body.scope).toBe('ip');
  }, 60_000);

  it('(L1) URL ไฟล์ลายเซ็นผิด: นับต่อ IP เกิน → 429 (ก่อนหน้านั้น 404)', async () => {
    const bad = () =>
      request(app.getHttpServer())
        .get('/v1/documents/doc_zzzz/content?t=x&exp=1&sig=bad')
        .set('X-Forwarded-For', '198.51.100.88');
    for (let i = 0; i < BAD_SIGNATURE_PER_MIN; i++) expect((await bad()).status).toBe(404);
    const r = await bad();
    expect(r.status).toBe(429);
    expect(r.body.scope).toBe('ip');
  });
});
