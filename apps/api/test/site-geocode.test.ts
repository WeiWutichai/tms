import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { JobQueue } from '../src/jobs/job-queue.service';
import { GeoService } from '../src/modules/geo/geo.service';
import { MockGeoProvider } from '../src/modules/geo/providers/mock.provider';
import { TenantRateLimiter } from '../src/modules/geo/rate-limit';
import { SitesController } from '../src/modules/sites/sites.controller';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

const REAL = { line1: '99 ถ.สุขุมวิท ต.ศรีราชา อ.ศรีราชา จ.ชลบุรี 20110' };
const GARBAGE = { line1: 'zzz ไม่มีที่นี่ 123' };

/** ST2-T03 geocode อัตโนมัติ + คนยืนยัน (backlog: ที่อยู่จริงได้พิกัดรอยืนยัน; ที่อยู่มั่ว = FAILED; ใช้ provider จำลอง) */
describe('สถานที่: geocode (ST2-T03)', () => {
  let app: NestExpressApplication;
  let queue: JobQueue;
  let geo: GeoService;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let seed = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    queue = app.get(JobQueue);
    geo = app.get(GeoService);
    tenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId);
  });
  afterAll(async () => {
    geo.use(new MockGeoProvider());
    await app.close();
    await db.$disconnect();
  });

  const newSite = async (extra: object = {}) =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุด geocode ${++seed}`, address: REAL, ...extra })
        .expect(201)
    ).body;
  const get = async (id: string) =>
    (await api(app, admin).get(`/v1/customer-sites/${id}`).expect(200)).body;
  const drain = async () => {
    while (await queue.runOnce());
  };
  const jobsFor = (id: string) =>
    db.job.findMany({
      where: {
        type: 'site.geocode',
        payload: { path: ['siteId'], equals: tryDecodeId('site', id)! },
      },
    });

  it('เกณฑ์ตรวจรับ: ที่อยู่จริง → job geocode → พิกัดเสนอรอคนยืนยัน (ยังไม่ใช่พิกัดจริง)', async () => {
    const s = await newSite();
    expect(s).toMatchObject({ geocodeStatus: 'PENDING', lat: null, geocodeProposal: null });
    expect(await jobsFor(s.id)).toHaveLength(1);
    await drain();
    const g = await get(s.id);
    expect(g.geocodeStatus).toBe('PENDING');
    expect(g.lat).toBeNull();
    expect(g.geocodeProposal).toMatchObject({ provider: 'mock', confidence: 0.9 });
    expect(Math.abs(g.geocodeProposal.lat - 13.17)).toBeLessThanOrEqual(0.02);
    // DM-013: ระบบเขียนผลแล้วเพิ่ม version (ETag เปลี่ยน — ฟอร์มที่เปิดค้างได้ 412 แล้วโหลดใหม่)
    expect(g.version).toBe(s.version + 1);
    // ตัวกรอง + สรุป "รอยืนยัน"
    const review = await api(app, admin).get('/v1/customer-sites').query({ geocode: 'REVIEW' });
    expect(review.body.data.map((x: { id: string }) => x.id)).toContain(s.id);
    const sum = await api(app, admin).get('/v1/customer-sites/summary').expect(200);
    expect(sum.body.geocodeReview).toBeGreaterThanOrEqual(1);
    // audit โดยระบบ (actor null)
    const h = await api(app, admin).get(`/v1/customer-sites/${s.id}/history`).expect(200);
    expect(h.body.data.map((x: { action: string }) => x.action)).toContain('location.geocoded');
  });

  it('เกณฑ์ตรวจรับ: ที่อยู่มั่ว → geocodeStatus FAILED + ตัวกรอง/สรุป "หาพิกัดไม่พบ"', async () => {
    const s = await newSite({ address: GARBAGE });
    await drain();
    const g = await get(s.id);
    expect(g).toMatchObject({ geocodeStatus: 'FAILED', lat: null, geocodeProposal: null });
    const failed = await api(app, admin).get('/v1/customer-sites').query({ geocode: 'FAILED' });
    expect(failed.body.data.map((x: { id: string }) => x.id)).toEqual([s.id]);
    const sum = await api(app, admin).get('/v1/customer-sites/summary').expect(200);
    expect(sum.body.geocodeFailed).toBe(1);
    // แก้ที่อยู่ให้ถูก → PENDING + geocode ใหม่ → ได้ข้อเสนอ
    await api(app, admin)
      .patch(`/v1/customer-sites/${s.id}`)
      .send({ address: REAL })
      .expect(200)
      .expect((r) => expect(r.body.geocodeStatus).toBe('PENDING'));
    await drain();
    expect((await get(s.id)).geocodeProposal).not.toBeNull();
  });

  it('ยืนยันพิกัดที่เสนอ → lat/lng + OK, audit มีเหตุผล, If-Match ไม่ตรง → 412, ยืนยันซ้ำ → 409', async () => {
    const s = await newSite();
    await drain();
    const g = await get(s.id);
    await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/geocode/confirm`)
      .set('If-Match', `"${g.version + 5}"`)
      .send({})
      .expect(412);
    const c = await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/geocode/confirm`)
      .set('If-Match', `"${g.version}"`)
      .send({ reason: 'ตรวจกับแผนที่แล้ว' })
      .expect(200);
    expect(c.body).toMatchObject({
      geocodeStatus: 'OK',
      lat: g.geocodeProposal.lat,
      lng: g.geocodeProposal.lng,
      geocodeProposal: null,
      version: g.version + 1,
    });
    const h = await api(app, admin).get(`/v1/customer-sites/${s.id}/history`).expect(200);
    const row = h.body.data.find(
      (x: { action: string }) => x.action === 'location.geocode_confirmed',
    );
    expect(row.reason).toBe('ตรวจกับแผนที่แล้ว');
    await api(app, admin).post(`/v1/customer-sites/${s.id}/geocode/confirm`).send({}).expect(409);
    // มีพิกัดแล้ว → ไม่สั่ง geocode ซ้ำ
    expect(await jobsFor(s.id)).toHaveLength(1);
  });

  it('ปฏิเสธพิกัดที่เสนอ → FAILED (ต้องมีเหตุผล ≥ 10) แล้วปักหมุดเองได้ = OK', async () => {
    const s = await newSite();
    await drain();
    await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/geocode/reject`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const r = await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/geocode/reject`)
      .send({ reason: 'หมุดอยู่คนละฝั่งถนนกับประตูโรงงาน' })
      .expect(200);
    expect(r.body).toMatchObject({ geocodeStatus: 'FAILED', geocodeProposal: null, lat: null });
    const p = await api(app, admin)
      .patch(`/v1/customer-sites/${s.id}`)
      .send({ lat: 13.1712, lng: 100.9301 })
      .expect(200);
    expect(p.body).toMatchObject({ geocodeStatus: 'OK', lat: 13.1712 });
  });

  it('กรอกพิกัดเอง = OK ไม่สั่ง geocode · ล้างพิกัด → geocode ใหม่ · ไม่มีผู้ให้บริการ (none) = ไม่สั่งงาน', async () => {
    const s = await newSite({ lat: 13.36, lng: 100.98 });
    expect(s.geocodeStatus).toBe('OK');
    expect(await jobsFor(s.id)).toHaveLength(0);
    await api(app, admin)
      .patch(`/v1/customer-sites/${s.id}`)
      .send({ lat: null, lng: null })
      .expect(200);
    expect(await jobsFor(s.id)).toHaveLength(1);
    await drain();
    expect((await get(s.id)).geocodeProposal).not.toBeNull();

    geo.use({ name: 'none', enabled: false, geocode: async () => [], distance: async () => null });
    try {
      const n = await newSite();
      expect(await jobsFor(n.id)).toHaveLength(0);
      const e = await api(app, admin)
        .post('/v1/customer-sites/geocode')
        .send({ address: REAL.line1 })
        .expect(200);
      expect(e.body).toEqual({ provider: 'none', candidates: [] });
    } finally {
      geo.use(new MockGeoProvider());
    }
  });

  it('ที่อยู่เปลี่ยนก่อน job รัน → job เก่าข้าม (ไม่ทับด้วยพิกัดของที่อยู่เดิม)', async () => {
    const s = await newSite();
    await api(app, admin)
      .patch(`/v1/customer-sites/${s.id}`)
      .send({ address: GARBAGE })
      .expect(200);
    expect(await jobsFor(s.id)).toHaveLength(2);
    await drain();
    expect(await get(s.id)).toMatchObject({ geocodeStatus: 'FAILED', geocodeProposal: null });
  });

  it('ผู้ให้บริการล่ม → ลองใหม่ · ครบจำนวนครั้ง → FAILED', async () => {
    geo.use({
      name: 'down',
      enabled: true,
      geocode: async () => {
        throw new Error('provider down');
      },
      distance: async () => null,
    });
    try {
      const s = await newSite();
      for (let i = 0; i < 3; i++) {
        await db.job.updateMany({ where: { type: 'site.geocode' }, data: { runAt: new Date(0) } });
        await drain();
        if (i < 2) expect((await get(s.id)).geocodeStatus).toBe('PENDING');
      }
      const [j] = await jobsFor(s.id);
      expect(j!.status).toBe('FAILED');
      expect(await get(s.id)).toMatchObject({ geocodeStatus: 'FAILED', geocodeProposal: null });
    } finally {
      geo.use(new MockGeoProvider());
    }
  });

  it('ปุ่ม "ประมาณจากที่อยู่": คืนตำแหน่งโดยไม่บันทึก · ที่อยู่มั่ว = candidates ว่าง · ต้องมีสิทธิ์ master:write', async () => {
    const r = await api(app, admin)
      .post('/v1/customer-sites/geocode')
      .send({ address: REAL.line1 })
      .expect(200);
    expect(r.body.provider).toBe('mock');
    expect(r.body.candidates[0]).toMatchObject({ label: 'ศรีราชา', confidence: 0.9 });
    const g = await api(app, admin)
      .post('/v1/customer-sites/geocode')
      .send({ address: GARBAGE.line1 })
      .expect(200);
    expect(g.body.candidates).toEqual([]);
    await api(app, admin).post('/v1/customer-sites/geocode').send({ address: '' }).expect(422);
    const viewer = await tokenFor(tenantId, 'master:read');
    await api(app, viewer)
      .post('/v1/customer-sites/geocode')
      .send({ address: REAL.line1 })
      .expect(403);
  });
  /** เลื่อนงาน geocode ที่รออยู่ของสถานที่นี้ (ตาม seq) ไปอนาคต/กลับมาตอนนี้ */
  const setRunAt = async (id: string, seq: number, runAt: Date, maxAttempts?: number) => {
    const [j] = (await jobsFor(id)).filter((x) => (x.payload as { seq: number }).seq === seq);
    await db.job.update({
      where: { id: j!.id },
      data: { runAt, ...(maxAttempts ? { maxAttempts } : {}) },
    });
  };
  const FUTURE = new Date(Date.now() + 3_600_000);

  it('job เก่า (ที่อยู่ A→B→A) ไม่ทับการปฏิเสธของคน', async () => {
    const s = await newSite();
    await api(app, admin)
      .patch(`/v1/customer-sites/${s.id}`)
      .send({ address: GARBAGE })
      .expect(200);
    await api(app, admin).patch(`/v1/customer-sites/${s.id}`).send({ address: REAL }).expect(200);
    expect(await jobsFor(s.id)).toHaveLength(3);
    await setRunAt(s.id, 1, FUTURE); // job แรก (ที่อยู่ A เดียวกัน) ค้างไว้
    await drain();
    expect((await get(s.id)).geocodeProposal).not.toBeNull();
    await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/geocode/reject`)
      .send({ reason: 'หมุดอยู่คนละฝั่งถนนกับประตูโรงงาน' })
      .expect(200);
    await setRunAt(s.id, 1, new Date(0));
    await drain();
    expect(await get(s.id)).toMatchObject({ geocodeStatus: 'FAILED', geocodeProposal: null });
  });

  it('ปัก→ล้างพิกัด: job ของคำขอเดิมข้าม, job ใหม่เสนอพิกัด', async () => {
    const s = await newSite();
    await api(app, admin)
      .patch(`/v1/customer-sites/${s.id}`)
      .send({ lat: 13.2, lng: 100.9 })
      .expect(200);
    await api(app, admin)
      .patch(`/v1/customer-sites/${s.id}`)
      .send({ lat: null, lng: null })
      .expect(200);
    await drain();
    const jobs = await jobsFor(s.id);
    expect(
      jobs.map((j) => (j.result as { skipped?: boolean } | null)?.skipped ?? false).sort(),
    ).toEqual([false, true]);
    expect((await get(s.id)).geocodeProposal).not.toBeNull();
  });

  it('onFinalFailure ของ job ที่ไม่ใช่คำขอล่าสุดแล้ว ไม่ตั้ง FAILED ทับ (ที่อยู่ถูกแก้ระหว่างเรียกผู้ให้บริการ)', async () => {
    const s = await newSite();
    const [j1] = await jobsFor(s.id);
    await db.job.update({ where: { id: j1!.id }, data: { maxAttempts: 1 } });
    geo.use({
      name: 'flaky',
      enabled: true,
      // ระหว่างรอผู้ให้บริการ (นอก transaction) ผู้ใช้แก้ที่อยู่ → คำขอใหม่ แล้วผู้ให้บริการล่ม
      geocode: async () => {
        geo.use(new MockGeoProvider());
        await api(app, admin)
          .patch(`/v1/customer-sites/${s.id}`)
          .send({ address: { line1: `${REAL.line1} (อาคาร 2)` } })
          .expect(200);
        throw new Error('provider down');
      },
      distance: async () => null,
    });
    try {
      await drain();
    } finally {
      geo.use(new MockGeoProvider());
    }
    expect((await db.job.findUnique({ where: { id: j1!.id } }))!.status).toBe('FAILED');
    const g = await get(s.id);
    expect(g.geocodeStatus).toBe('PENDING');
    expect(g.geocodeProposal).not.toBeNull();
  });

  it('ปิดผู้ให้บริการหลังสั่งงาน → worker ข้าม (คง PENDING ไม่ตั้ง FAILED)', async () => {
    const s = await newSite();
    geo.use({ name: 'none', enabled: false, geocode: async () => [], distance: async () => null });
    try {
      await drain();
    } finally {
      geo.use(new MockGeoProvider());
    }
    const g = await get(s.id);
    expect(g).toMatchObject({
      geocodeStatus: 'PENDING',
      geocodeProposal: null,
      version: s.version,
    });
    const [j] = await jobsFor(s.id);
    expect(j!.status).toBe('SUCCEEDED');
    expect(j!.result).toMatchObject({ skipped: true });
  });

  it('ลองหาพิกัดอีกครั้ง: FAILED → PENDING + job ใหม่ · มีงานรออยู่ไม่สั่งซ้ำ · มีข้อเสนอ → 409 · ไม่มีผู้ให้บริการ → 409', async () => {
    const s = await newSite({ address: GARBAGE });
    await drain();
    const f = await get(s.id);
    expect(f.geocodeStatus).toBe('FAILED');
    await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/geocode/retry`)
      .set('If-Match', `"${f.version + 3}"`)
      .expect(412);
    const r = await api(app, admin)
      .post(`/v1/customer-sites/${s.id}/geocode/retry`)
      .set('If-Match', `"${f.version}"`)
      .expect(200);
    expect(r.body).toMatchObject({ geocodeStatus: 'PENDING', version: f.version + 1 });
    expect(await jobsFor(s.id)).toHaveLength(2);
    // งานของคำขอนี้ยังรอ → กดซ้ำไม่สั่งเพิ่ม
    await api(app, admin).post(`/v1/customer-sites/${s.id}/geocode/retry`).expect(200);
    expect(await jobsFor(s.id)).toHaveLength(2);
    const h = await api(app, admin).get(`/v1/customer-sites/${s.id}/history`).expect(200);
    expect(h.body.data.map((x: { action: string }) => x.action)).toContain(
      'location.geocode_retried',
    );

    const ok = await newSite();
    await drain();
    await api(app, admin).post(`/v1/customer-sites/${ok.id}/geocode/retry`).expect(409);
    geo.use({ name: 'none', enabled: false, geocode: async () => [], distance: async () => null });
    try {
      await api(app, admin).post(`/v1/customer-sites/${s.id}/geocode/retry`).expect(409);
    } finally {
      geo.use(new MockGeoProvider());
    }
  });

  it('ผู้ให้บริการช้าเกินเส้นตาย → ล้ม (ไม่ค้าง) · ปุ่มประมาณ → 500 ไม่ถือ transaction', async () => {
    geo.timeoutMs = 50;
    geo.use({
      name: 'slow',
      enabled: true,
      geocode: (_a, o) =>
        new Promise((resolve) => {
          const t = setTimeout(() => resolve([]), 5_000);
          o?.signal?.addEventListener('abort', () => clearTimeout(t));
        }),
      distance: async () => null,
    });
    try {
      await expect(geo.geocode('จ.ชลบุรี')).rejects.toThrow(/timeout/);
      await api(app, admin)
        .post('/v1/customer-sites/geocode')
        .send({ address: REAL.line1 })
        .expect(500);
    } finally {
      geo.timeoutMs = 5_000;
      geo.use(new MockGeoProvider());
    }
  });

  it('ปุ่มประมาณจำกัดต่อบริษัท → 429 + Retry-After (บริษัทอื่นไม่โดน)', async () => {
    const t2 = (await createTenant(db)).id;
    const other = await tokenFor(t2);
    const ctl = app.get(SitesController);
    const original = ctl.geocodeLimiter;
    (ctl as { geocodeLimiter: TenantRateLimiter }).geocodeLimiter = new TenantRateLimiter(2);
    try {
      for (let i = 0; i < 2; i++)
        await api(app, admin).post('/v1/customer-sites/geocode').send({ address: 'x' }).expect(200);
      const r = await api(app, admin)
        .post('/v1/customer-sites/geocode')
        .send({ address: 'x' })
        .expect(429);
      expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(r.body.code).toBe('rate_limited');
      await api(app, other).post('/v1/customer-sites/geocode').send({ address: 'x' }).expect(200);
    } finally {
      (ctl as { geocodeLimiter: TenantRateLimiter }).geocodeLimiter = original;
    }
  });
});
