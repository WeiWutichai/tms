import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { JobQueue } from '../src/jobs/job-queue.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST7-T10 Bulk/async สาธารณะ: `POST /v1/orders:bulk` ≤ 200 → 207 ผลต่อรายการ · `Prefer: respond-async` → 202 job
 * เกณฑ์ตรวจรับ: bulk 200 ใบที่ผิด 2 ใบได้ 207 ระบุผลรายใบ · ส่งซ้ำ key เดิมไม่สร้างซ้ำ
 */
describe('orders:bulk (ST7-T10)', () => {
  let app: NestExpressApplication;
  let queue: JobQueue;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let customer: string;
  let origin: string;
  let dest: string;
  let vt6: string;
  let seed = 0;
  const today = bangkokToday();
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const URL = '/v1/orders:bulk';

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    queue = app.get(JobQueue);
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง เอ' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง บี' })).id;
    for (const tid of [tenantId, otherId]) {
      const c = await db.company.create({
        data: { tenantId: tid, legalName: `บริษัท ออกบิล ${tid}`, taxId: validTaxId(700 + ++seed) },
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
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
    customer = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: 'ลูกค้า bulk', taxId: validTaxId(9600) })
        .expect(201)
    ).body.id;
    const site = async (name: string) =>
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({ name, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id as string;
    origin = await site('คลังต้นทาง');
    dest = await site('ร้านปลายทาง');
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body.data;
    vt6 = types.find((t: { code: string }) => t.code === '6W').id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const item = (extra: Record<string, unknown> = {}) => ({
    customer: { id: customer },
    requestedDate: today,
    vehicleTypeId: vt6,
    stops: [
      { type: 'PICKUP', siteId: origin },
      { type: 'DELIVERY', siteId: dest },
    ],
    ...extra,
  });
  const count = (where: Record<string, unknown> = {}) =>
    db.salesOrder.count({ where: { tenantId, ...where } });

  it('200 ใบ ผิด 2 ใบ → 207 ผลรายใบ (ใบที่ผิดไม่ย้อนใบอื่น) · Idempotency-Key เดิมส่งซ้ำ = ผลเดิม ไม่สร้างซ้ำ', async () => {
    const batch = `B1-${randomUUID().slice(0, 8)}`;
    const items: Record<string, unknown>[] = Array.from({ length: 200 }, (_, i) =>
      item({ customerRef: `${batch}-${i}` }),
    );
    items[17] = item({ customerRef: `${batch}-17`, requestedDate: '2026-13-45' }); // วันที่ผิด
    items[150] = { ...item({ customerRef: `${batch}-150` }), unknownField: 1 }; // field แปลกปลอม (DTO เดียวกับ POST /orders)
    const key = `bulk-${randomUUID()}`;
    const res = await api(app, admin)
      .post(URL)
      .set('Idempotency-Key', key)
      .send({ items })
      .expect(207);
    expect(res.body).toMatchObject({ total: 200, succeeded: 198, failed: 2 });
    expect(res.body.results).toHaveLength(200);
    expect(res.body.results.map((r: { index: number }) => r.index)).toEqual(
      Array.from({ length: 200 }, (_, i) => i),
    );
    const bad = res.body.results.filter((r: { outcome: string }) => r.outcome === 'FAILED');
    expect(bad.map((r: { index: number }) => r.index)).toEqual([17, 150]);
    for (const b of bad) {
      expect(b).toMatchObject({ status: 422, id: null, problem: { code: 'validation_failed' } });
      expect(b.problem.errors.length).toBeGreaterThan(0);
    }
    expect(bad[1].problem.errors[0]).toMatchObject({ field: 'unknownField' });
    const ok = res.body.results[0];
    expect(ok).toMatchObject({ status: 201, outcome: 'CREATED', problem: null, externalId: null });
    expect(ok.id).toMatch(/^ord_[0-9a-f]{32}$/);
    expect(ok.soNo).toMatch(/^SO-\d{4}-\d{4}$/);
    // ใบที่ผ่าน = ใบเดียวกับ POST /orders (ที่มา API, ราคา/ใบค้างตามทางเข้าเดียว — ไม่มีราคา = รับเข้าเป็น ON_HOLD)
    const got = await api(app, admin).get(`/v1/orders/${ok.id}`).expect(200);
    expect(got.body).toMatchObject({ source: 'API', customerRef: `${batch}-0`, soNo: ok.soNo });
    expect(ok.orderStatus).toBe(got.body.status);
    expect(ok.holdCodes).toEqual(got.body.holdCodes);
    expect(await count({ customerRef: { startsWith: batch } })).toBe(198);

    const again = await api(app, admin)
      .post(URL)
      .set('Idempotency-Key', key)
      .send({ items })
      .expect(207);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(res.body);
    expect(await count({ customerRef: { startsWith: batch } })).toBe(198);
    // key เดิม body ต่าง → 422
    const mismatch = await api(app, admin)
      .post(URL)
      .set('Idempotency-Key', key)
      .send({ items: items.slice(0, 1) })
      .expect(422);
    expect(mismatch.body.code).toBe('idempotency_mismatch');
  }, 120_000);

  it('externalId ต่อใบ = upsert (ส่งชุดเดิมซ้ำโดยไม่มี key → 200 UPDATED ไม่เกิดใบซ้ำ) · ซ้ำในชุดเดียวกัน = ตัวหลังอัปเดต', async () => {
    const ext = `EXT-${randomUUID().slice(0, 8)}`;
    const items = [
      item({ externalId: `${ext}-1` }),
      item({ externalId: `${ext}-2` }),
      item({ externalId: `${ext}-1`, customerRef: 'แก้ในชุดเดียวกัน' }),
    ];
    const r1 = await api(app, admin).post(URL).send({ items }).expect(207);
    expect(r1.body.results.map((r: { status: number }) => r.status)).toEqual([201, 201, 200]);
    expect(r1.body.results[2]).toMatchObject({ outcome: 'UPDATED', externalId: `${ext}-1` });
    expect(r1.body.results[2].id).toBe(r1.body.results[0].id);
    const r2 = await api(app, admin).post(URL).send({ items }).expect(207);
    expect(r2.body.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      'UPDATED',
      'UPDATED',
      'UPDATED',
    ]);
    expect(await count({ externalId: { startsWith: ext } })).toBe(2);
  });

  it('ทั้งคำขอ 422 เฉพาะ items ว่าง / เกิน 200 / ไม่ใช่ object · ไม่มี orders:write → 403', async () => {
    await api(app, admin).post(URL).send({ items: [] }).expect(422);
    const big = await api(app, admin)
      .post(URL)
      .send({ items: Array.from({ length: 201 }, () => ({})) })
      .expect(422);
    expect(big.body.errors[0]).toMatchObject({ field: 'items', code: 'arrayMaxSize' });
    await api(app, admin)
      .post(URL)
      .send({ items: [1, 'x'] })
      .expect(422);
    await api(app, admin).post(URL).send({}).expect(422);
    const ro = await tokenFor(tenantId, 'orders:read');
    const denied = await api(app, ro)
      .post(URL)
      .send({ items: [item()] })
      .expect(403);
    expect(denied.body.code).toBe('permission_denied');
  });

  it('ราคาขายในรายการโดยไม่มี prices.sell:write → 403 ทั้งคำขอ (เหมือน POST /orders)', async () => {
    const tok = await tokenFor(tenantId, 'orders:write orders:read');
    const before = await count();
    const r = await api(app, tok)
      .post(URL)
      .send({ items: [item({ sellCharges: [{ kind: 'FREIGHT', sellAmount: '100.00' }] })] })
      .expect(403);
    expect(r.body.code).toBe('permission_denied');
    expect(await count()).toBe(before);
  });

  it('Prefer: respond-async → 202 {jobId,statusUrl} → job succeeded_with_errors + ผลเดียวกับ 207 + webhook job.completed · key เดิม = jobId เดิม', async () => {
    const batch = `A-${randomUUID().slice(0, 8)}`;
    const items = [
      item({ customerRef: `${batch}-0` }),
      item({ customerRef: `${batch}-1`, stops: [] }),
      item({ customerRef: `${batch}-2` }),
    ];
    const key = `bulk-async-${randomUUID()}`;
    const res = await api(app, admin)
      .post(URL)
      .set('Prefer', 'respond-async')
      .set('Idempotency-Key', key)
      .send({ items })
      .expect(202);
    expect(res.headers['preference-applied']).toBe('respond-async');
    expect(res.body.jobId).toMatch(/^job_[0-9a-f]{32}$/);
    expect(res.body.statusUrl).toBe(`/v1/jobs/${res.body.jobId}`);
    expect(await count({ customerRef: { startsWith: batch } })).toBe(0);
    const pending = await api(app, admin).get(res.body.statusUrl).expect(200);
    expect(pending.body).toMatchObject({ status: 'pending', type: 'orders.bulk' });
    // tenant อื่นไม่เห็น job
    await api(app, other).get(res.body.statusUrl).expect(404);

    const replay = await api(app, admin)
      .post(URL)
      .set('Prefer', 'respond-async')
      .set('Idempotency-Key', key)
      .send({ items })
      .expect(202);
    expect(replay.body.jobId).toBe(res.body.jobId);
    expect(await db.job.count({ where: { tenantId, type: 'orders.bulk' } })).toBe(1);

    while (await queue.runOnce());
    const done = await api(app, admin).get(res.body.statusUrl).expect(200);
    expect(done.body).toMatchObject({
      status: 'succeeded_with_errors',
      progress: 100,
      result: { total: 3, succeeded: 2, failed: 1 },
    });
    expect(done.body.result.results[1]).toMatchObject({
      index: 1,
      outcome: 'FAILED',
      problem: { code: 'validation_failed' },
    });
    expect(await count({ customerRef: { startsWith: batch } })).toBe(2);
    // audit ของใบที่สร้างจาก job ผูก requestId ของ job
    const jobUuid = tryDecodeId('job', res.body.jobId)!;
    const ev = await db.domainEvent.findFirst({
      where: { tenantId, type: 'job.completed', localId: jobUuid },
    });
    expect(ev?.snapshot).toMatchObject({
      id: res.body.jobId,
      status: 'succeeded_with_errors',
      result: { total: 3, succeeded: 2, failed: 1 },
    });
  });

  it('job ที่ทุกใบผ่าน = succeeded · job ที่ถูกหยิบซ้ำหลังล้มกลางทาง = failed (ไม่ทำซ้ำ)', async () => {
    const r = await api(app, admin)
      .post(URL)
      .set('Prefer', 'respond-async')
      .send({ items: [item()] })
      .expect(202);
    while (await queue.runOnce());
    const ok = await api(app, admin).get(r.body.statusUrl).expect(200);
    expect(ok.body).toMatchObject({ status: 'succeeded', result: { succeeded: 1, failed: 0 } });

    const before = await count();
    const r2 = await api(app, admin)
      .post(URL)
      .set('Prefer', 'respond-async')
      .send({ items: [item()] })
      .expect(202);
    const id = tryDecodeId('job', r2.body.jobId)!;
    // จำลอง worker ตายระหว่างทำ: หยิบไปแล้ว 1 ครั้ง (attempts=1) lease หมด
    await db.job.update({
      where: { id },
      data: { status: 'RUNNING', attempts: 1, lockedUntil: new Date(Date.now() - 1000) },
    });
    while (await queue.runOnce());
    const failed = await api(app, admin).get(r2.body.statusUrl).expect(200);
    expect(failed.body.status).toBe('failed');
    expect(await count()).toBe(before);
  });

  it('job ที่ client เห็นเก็บ 7 วันหลังจบ แล้วลบ (GET → 404) · งานระบบไม่ลบ · งานที่ยังไม่จบไม่ลบ', async () => {
    const r = await api(app, admin)
      .post(URL)
      .set('Prefer', 'respond-async')
      .send({ items: [item()] })
      .expect(202);
    while (await queue.runOnce());
    const id = tryDecodeId('job', r.body.jobId)!;
    const old = new Date(Date.now() - 8 * 86_400_000);
    await db.job.update({ where: { id }, data: { finishedAt: old } });
    const sys = await db.job.create({
      data: { tenantId, type: 'reminders.expiry', status: 'SUCCEEDED', finishedAt: old },
    });
    const fresh = await api(app, admin)
      .post(URL)
      .set('Prefer', 'respond-async')
      .send({ items: [item()] })
      .expect(202);
    expect(await queue.purgeExpired()).toBeGreaterThanOrEqual(1);
    await api(app, admin).get(r.body.statusUrl).expect(404);
    await api(app, admin).get(fresh.body.statusUrl).expect(200);
    expect(await db.job.findUnique({ where: { id: sys.id } })).not.toBeNull();
  });
});
