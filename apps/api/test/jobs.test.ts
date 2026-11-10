import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId } from '../src/common/ids';
import { JobQueue } from '../src/jobs/job-queue.service';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

describe('job framework (ST0-T11)', () => {
  let app: NestExpressApplication;
  let queue: JobQueue;
  const plat = platform();
  const order: string[] = [];

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    queue = app.get(JobQueue);
    queue.register('test.record', async ({ tenantId, tx, progress }) => {
      order.push(tenantId);
      await progress(50);
      // handler รันใต้ RLS ของ tenant นั้น — เห็นเฉพาะ job ของตัวเอง
      return { visibleJobs: await tx.job.count() };
    });
    queue.register('test.fail', async () => {
      throw new Error('boom');
    });
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  it('งานของ 2 tenant ถูกหยิบสลับกัน (round-robin) แม้ A ใส่คิวก่อนทั้งหมด', async () => {
    const a = (await createTenant(plat, 'A')).id;
    const b = (await createTenant(plat, 'B')).id;
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 3; i++) {
      await plat.job.create({
        data: { tenantId: a, type: 'test.record', runAt: new Date(t0 + i) },
      });
    }
    for (let i = 0; i < 3; i++) {
      await plat.job.create({
        data: { tenantId: b, type: 'test.record', runAt: new Date(t0 + 100 + i) },
      });
    }
    while (await queue.runOnce());
    expect(order).toHaveLength(6);
    for (let i = 1; i < order.length; i++) expect(order[i]).not.toBe(order[i - 1]);
  });

  it('อ่านสถานะ pending → running → succeeded ผ่าน GET /v1/jobs/{id}', async () => {
    const t = (await createTenant(plat)).id;
    const tok = await tokenFor(t);
    const job = await plat.job.create({ data: { tenantId: t, type: 'test.record' } });
    const url = `/v1/jobs/${encodeId('job', job.id)}`;
    expect((await api(app, tok).get(url)).body.status).toBe('pending');

    await plat.job.update({ where: { id: job.id }, data: { status: 'RUNNING', progress: 40 } });
    const running = await api(app, tok).get(url);
    expect(running.body).toMatchObject({ status: 'running', progress: 40 });

    await plat.job.update({ where: { id: job.id }, data: { status: 'PENDING' } });
    while (await queue.runOnce());
    const done = await api(app, tok).get(url);
    expect(done.body).toMatchObject({
      status: 'succeeded',
      progress: 100,
      result: { visibleJobs: 1 },
    });
  });

  it('งานล้มเหลวถูกลองใหม่จนครบ maxAttempts แล้วเป็น failed', async () => {
    const t = (await createTenant(plat)).id;
    const job = await plat.job.create({ data: { tenantId: t, type: 'test.fail', maxAttempts: 2 } });
    await queue.runOnce();
    let j = await plat.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(j.status).toBe('PENDING');
    await plat.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });
    await queue.runOnce();
    j = await plat.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(j.status).toBe('FAILED');
    expect(j.attempts).toBe(2);
    expect(j.error).toMatchObject({ message: expect.stringContaining('boom') });
  });
});
