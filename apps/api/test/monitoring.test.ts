import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { currentStep, hotp } from '../src/auth/totp';
import { Clock } from '../src/common/clock';
import { FieldCipher } from '../src/common/crypto';
import { EmailDispatcher } from '../src/modules/email/email.service';
import { MemoryTransport } from '../src/modules/email/transport';
import { AlertEvaluator, observe } from '../src/modules/monitoring/alert-evaluator';
import {
  AvailabilityService,
  bangkokMonthRange,
} from '../src/modules/monitoring/availability.service';
import { HttpMetrics, httpMetrics } from '../src/modules/monitoring/http-metrics';
import { MonitorCollector } from '../src/modules/monitoring/monitor-collector';
import { DEFAULT_RULES, loadRules } from '../src/modules/monitoring/monitor-config';
import { MonitorScheduler, msToNextMinute } from '../src/modules/monitoring/monitor-scheduler';
import { bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

const SECRET = 'JBSWY3DPEHPK3PXP';
const PW = 'platform-password-2569';
const MIN = 60_000;
const TOKEN = 'metrics-token-for-tests-0123456789';

/**
 * ST9-T19 Monitoring + alert — เกณฑ์ตรวจรับ: "จำลองคิวค้างเกินเกณฑ์ → ทีมได้ alert ภายใน 5 นาที"
 * นาฬิกาฉีด (Clock) — evaluator รับเวลาเป็นพารามิเตอร์ทุก query จึงจำลองนาทีได้โดยไม่รอจริง
 */
describe('monitoring + alert (ST9-T19)', () => {
  let app: NestExpressApplication;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  let evaluator: AlertEvaluator;
  let availability: AvailabilityService;
  let dispatcher: EmailDispatcher;
  let clock: Clock;
  let mail: MemoryTransport;
  let tenantId: string;
  const staff: Record<string, { id: string; email: string }> = {};
  const http = () => request(app.getHttpServer());

  async function signIn(role: 'SUPER_ADMIN' | 'SUPPORT' | 'BILLING') {
    const u = staff[role]!;
    await db.platformUser.update({ where: { id: u.id }, data: { totpLastStep: null } });
    const c = await http().post('/v1/platform/auth/login').send({ email: u.email, password: PW });
    expect(c.status).toBe(200);
    const t = await http()
      .post('/v1/platform/auth/mfa')
      .send({ challenge: c.body.challenge, code: hotp(SECRET, currentStep()) });
    expect(t.status).toBe(200);
    return t.body.accessToken as string;
  }

  async function seedOutbox(o: {
    createdAt: Date;
    nextRunAt: Date;
    sink?: string;
    status?: string;
    parked?: boolean;
  }) {
    const id = randomUUID();
    await owner.$executeRaw`
      INSERT INTO integration_outbox (id, tenant_id, kind, sink, operation, entity_type, local_id, serialize_key,
                                      idempotency_key, status, next_run_at, created_at, updated_at, parked_at)
      VALUES (${id}::uuid, ${tenantId}::uuid, 'ADAPTER', ${o.sink ?? 'demo'}, 'PUSH_INVOICE', 'invoice', gen_random_uuid(),
              ${`k-${id}`}, ${`i-${id}`}, ${o.status ?? 'PENDING'}::"OutboxStatus", ${o.nextRunAt}::timestamptz,
              ${o.createdAt}::timestamptz, now(), ${o.parked ? o.createdAt : null}::timestamptz)`;
    return id;
  }

  const alertsFor = (key: string) =>
    db.monitorAlert.findMany({ where: { key }, orderBy: { openedAt: 'asc' } });
  const mailsFor = (needle: string) =>
    db.emailOutbox.findMany({
      where: { template: 'monitor_alert', subject: { contains: needle } },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    process.env.MONITOR_PROBE_URL = `http://127.0.0.1:${port}/v1/readyz`;
    evaluator = app.get(AlertEvaluator);
    availability = app.get(AvailabilityService);
    dispatcher = app.get(EmailDispatcher);
    clock = app.get(Clock);
    tenantId = (await createTenant(db, 'บริษัท ลับเฉพาะ ขนส่ง จำกัด')).id;
    for (const role of ['SUPER_ADMIN', 'SUPPORT', 'BILLING'] as const) {
      const u = await db.platformUser.create({
        data: {
          email: `${role.toLowerCase()}-mon@innovera.test`,
          name: `ทีม ${role}`,
          role,
          passwordHash: await hashPassword(PW),
          totpSecret: new FieldCipher().encrypt(SECRET),
        },
      });
      staff[role] = { id: u.id, email: u.email };
    }
  });
  beforeEach(async () => {
    clock.set(null);
    delete process.env.MONITOR_ALERT_EMAILS;
    delete process.env.METRICS_TOKEN;
    await owner.$executeRawUnsafe(
      'TRUNCATE monitor_check, monitor_alert, email_outbox, integration_outbox, job, worker_heartbeat, http_request_minute, availability_probe CASCADE',
    );
    mail = new MemoryTransport();
    dispatcher.use(mail);
  });
  afterAll(async () => {
    delete process.env.MONITOR_PROBE_URL;
    await app.close();
    await Promise.all([db.$disconnect(), owner.$disconnect(), appDb.$disconnect()]);
  });

  it('healthz = liveness · readyz: DB + migration ครบ; worker ไม่มี/เก่า = degraded (200) · ส่ง heartbeat แล้ว = ok', async () => {
    const h = await http().get('/v1/healthz').expect(200);
    expect(h.body).toEqual({ status: 'ok' });
    let r = await http().get('/v1/readyz').expect(200);
    expect(r.body).toMatchObject({
      status: 'degraded',
      db: 'ok',
      migrations: 'ok',
      worker: 'missing',
    });
    expect(r.headers['cache-control']).toBe('no-store');
    await availability.beat('worker', new Date(Date.now() - 4 * MIN), 'w-old');
    r = await http().get('/v1/readyz').expect(200);
    expect(r.body).toMatchObject({ status: 'degraded', worker: 'stale' });
    expect(r.body.workerHeartbeatAgeSec).toBeGreaterThanOrEqual(239);
    await availability.beat('worker', new Date(), 'w-new');
    r = await http().get('/v1/readyz').expect(200);
    expect(r.body).toMatchObject({ status: 'ok', worker: 'ok' });
  });

  it('metrics: ไม่ตั้ง METRICS_TOKEN = 404 · token ผิด/ไม่ส่ง = 401 · ถูก = Prometheus text ไม่มีชื่อบริษัท', async () => {
    const off = await http().get('/v1/metrics').expect(404);
    expect(off.text).toBe('');
    // token สั้นเกิน = ปิด — 404 เปล่า ไม่บอกกติกาให้ผู้เรียก
    process.env.METRICS_TOKEN = 'short';
    const short = await http().get('/v1/metrics').set('Authorization', 'Bearer short').expect(404);
    expect(short.text).toBe('');
    process.env.METRICS_TOKEN = TOKEN;
    await http().get('/v1/metrics').expect(401);
    await http().get('/v1/metrics').set('Authorization', `Bearer ${TOKEN}x`).expect(401);
    const now = new Date();
    await seedOutbox({
      createdAt: new Date(now.getTime() - 20 * MIN),
      nextRunAt: new Date(now.getTime() - 7 * MIN),
    });
    await seedOutbox({
      createdAt: new Date(now.getTime() - 50 * MIN),
      nextRunAt: now,
      parked: true,
    });
    await db.$executeRaw`
      INSERT INTO job (id, tenant_id, type, status, run_at, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'mon.test', 'PENDING', ${new Date(now.getTime() - 2 * MIN)}::timestamptz, now())`;
    // dead-letter: นับเฉพาะ 24 ชม. ล่าสุด
    await seedOutbox({ createdAt: now, nextRunAt: now, status: 'FAILED_FINAL' });
    const oldDead = await seedOutbox({ createdAt: now, nextRunAt: now, status: 'FAILED_FINAL' });
    await owner.$executeRaw`UPDATE integration_outbox SET updated_at = now() - interval '2 days' WHERE id = ${oldDead}::uuid`;
    await http().get('/v1/healthz').expect(200);
    const res = await http().get('/v1/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const t = res.text;
    expect(t).toContain('tms_up 1');
    expect(t).toMatch(
      /tms_http_requests_total\{method="GET",route="\/healthz",status_class="2xx"\} \d+/,
    );
    expect(t).toMatch(
      /tms_http_request_duration_seconds_bucket\{route_class="healthz",le="\+Inf"\} \d+/,
    );
    expect(t).toContain('tms_outbox_commands{sink="demo",state="pending"} 1');
    expect(t).toContain('tms_outbox_commands{sink="demo",state="parked"} 1');
    expect(t).toContain('tms_outbox_commands{sink="demo",state="failed_final_24h"} 1');
    // ไม่นับคำสั่งที่พัก: lag ~7 นาที · อายุ ~20 นาที (ไม่ใช่ 50)
    expect(
      Number(/tms_outbox_lag_seconds\{sink="demo"\} (\d+)/.exec(t)?.[1]),
    ).toBeGreaterThanOrEqual(419);
    expect(Number(/tms_outbox_oldest_age_seconds\{sink="demo"\} (\d+)/.exec(t)?.[1])).toBeLessThan(
      1500,
    );
    expect(t).toContain('tms_job_queue{state="pending"} 1');
    expect(t).toMatch(/tms_job_lag_seconds \d+/);
    expect(t).toMatch(/tms_disk_free_bytes\{volume="files"\} \d+/);
    expect(t).toContain('tms_worker_heartbeat_age_seconds -1');
    // URL จริงที่มี id ไม่เป็น label (ใช้แม่แบบ route) · ไม่มีชื่อบริษัท/อีเมล
    await http().get(`/v1/no-such-route-${randomUUID()}`).expect(404);
    const t2 = (await http().get('/v1/metrics').set('Authorization', `Bearer ${TOKEN}`)).text;
    expect(t2).toContain('route="unmatched"');
    expect(t2).not.toContain('no-such-route');
    expect(t2).not.toContain('ลับเฉพาะ');
    expect(t2).not.toContain('@innovera.test');
    expect(t2).not.toContain(tenantId);
  });

  it('เกณฑ์ตรวจรับ: outbox ค้างเกินเกณฑ์ → alert + อีเมลทีมภายใน 5 นาที · ไม่ซ้ำ · ปิดเมื่อกลับปกติ (hysteresis)', async () => {
    const T0 = new Date('2026-11-19T03:00:00.000Z');
    const at = (m: number) => new Date(T0.getTime() + m * MIN);
    // คิวเริ่มค้างที่ T0: คำสั่งถึงเวลาแล้วไม่มี worker หยิบ
    const id = await seedOutbox({ createdAt: T0, nextRunAt: T0 });
    const threshold = DEFAULT_RULES.outbox_lag.threshold;
    const crossed = new Date(T0.getTime() + threshold * 1000);
    let alertAt: Date | null = null;
    for (let m = 1; m <= 12 && !alertAt; m++) {
      clock.set(at(m));
      const r = await evaluator.evaluate(at(m));
      expect(r.skipped).toBeUndefined();
      if (r.opened.includes('outbox_lag:demo')) alertAt = at(m);
    }
    expect(alertAt).not.toBeNull();
    // ทีมได้ alert ภายใน 5 นาทีหลังคิวค้างเกินเกณฑ์
    expect(alertAt!.getTime() - crossed.getTime()).toBeLessThanOrEqual(5 * MIN);
    const [a] = await alertsFor('outbox_lag:demo');
    expect(a).toMatchObject({
      status: 'OPEN',
      rule: 'outbox_lag',
      subject: 'demo',
      severity: 'warning',
    });
    expect(a!.notifiedAt).toEqual(alertAt);
    // อีเมลเข้าคิวถึง SUPER_ADMIN + SUPPORT (ไม่ใช่ BILLING) แล้ว worker ส่งจริง
    let mails = await mailsFor('คิว outbox ค้าง');
    expect(mails.map((m) => m.toAddress).sort()).toEqual(
      [staff.SUPER_ADMIN!.email, staff.SUPPORT!.email].sort(),
    );
    expect(mails.every((m) => m.tenantId === null)).toBe(true);
    await dispatcher.drain();
    const sent = mail.sent.filter((m) => m.subject.includes('คิว outbox ค้าง'));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.subject).toContain('[เตือน]');
    expect(sent[0]!.subject).toContain('(demo)');
    expect(sent[0]!.text).not.toContain('ลับเฉพาะ');

    // ยังค้างต่อ 3 รอบ → alert เดิม ไม่สร้าง/ไม่ส่งซ้ำ
    const base = (alertAt!.getTime() - T0.getTime()) / MIN;
    for (let m = base + 1; m <= base + 3; m++) {
      const r = await evaluator.evaluate(at(m));
      expect(r.opened).not.toContain('outbox_lag:demo');
    }
    expect(await alertsFor('outbox_lag:demo')).toHaveLength(1);
    expect(await mailsFor('คิว outbox ค้าง')).toHaveLength(2);
    expect((await alertsFor('outbox_lag:demo'))[0]!.lastSeenAt).toEqual(at(base + 3));

    // กลับปกติ: ต้องปกติติดกัน 3 รอบจึงปิด (ค้าง 1 รอบระหว่างทาง = เริ่มนับใหม่)
    await owner.$executeRaw`UPDATE integration_outbox SET status = 'DONE', done_at = now() WHERE id = ${id}::uuid`;
    let m = base + 4;
    expect((await evaluator.evaluate(at(m++))).resolved).toEqual([]);
    expect((await evaluator.evaluate(at(m++))).resolved).toEqual([]);
    expect((await alertsFor('outbox_lag:demo'))[0]!.status).toBe('OPEN');
    const r3 = await evaluator.evaluate(at(m++));
    expect(r3.resolved).toContain('outbox_lag:demo');
    const [closed] = await alertsFor('outbox_lag:demo');
    expect(closed).toMatchObject({ status: 'RESOLVED', resolvedAt: at(m - 1) });
    expect(closed!.resolveNotifiedAt).toEqual(at(m - 1));
    mails = await mailsFor('[ปิดแล้ว] คิว outbox ค้าง');
    expect(mails).toHaveLength(2);
    // ปกติต่อ → ไม่มีอะไรเพิ่ม · sink ที่ไม่มีคำสั่งค้างแล้ว: check ถูกลบ (ไม่สะสม)
    await evaluator.evaluate(at(m++));
    expect(await mailsFor('คิว outbox ค้าง')).toHaveLength(4);
    expect(await db.monitorCheck.findUnique({ where: { key: 'outbox_lag:demo' } })).toBeNull();

    // ค้างใหม่อีกรอบ → alert แถวใหม่ (ประวัติเดิมคงอยู่)
    await seedOutbox({ createdAt: at(m - 10), nextRunAt: at(m - 10) });
    await evaluator.evaluate(at(m++));
    await evaluator.evaluate(at(m++));
    const all = await alertsFor('outbox_lag:demo');
    expect(all.map((x) => x.status)).toEqual(['RESOLVED', 'OPEN']);
  });

  it('เกณฑ์ตรวจรับ (job): job ค้าง/lease หมดเกิน 5 นาที → alert job_lag ภายใน 5 นาที · หลาย evaluator พร้อมกันไม่ซ้ำ', async () => {
    const T0 = new Date('2026-11-19T05:00:00.000Z');
    const at = (m: number) => new Date(T0.getTime() + m * MIN);
    // worker ตายกลางงาน: RUNNING แต่ lease หมดตั้งแต่ T0
    await db.$executeRaw`
      INSERT INTO job (id, tenant_id, type, status, attempts, run_at, locked_until, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'mon.stuck', 'RUNNING', 1, ${at(-10)}::timestamptz, ${T0}::timestamptz, now())`;
    let alertAt: number | null = null;
    for (let m = 1; m <= 12 && alertAt === null; m++) {
      // evaluator 3 ตัวพร้อมกัน (worker หลายตัว / API สำรอง) — ทำงานจริงตัวเดียว
      const rs = await Promise.all([1, 2, 3].map(() => evaluator.evaluate(at(m))));
      expect(rs.filter((r) => !r.skipped)).toHaveLength(1);
      if (rs.some((r) => r.opened.includes('job_lag'))) alertAt = m;
    }
    expect(alertAt).not.toBeNull();
    expect(alertAt! * MIN - DEFAULT_RULES.job_lag.threshold * 1000).toBeLessThanOrEqual(5 * MIN);
    expect(await alertsFor('job_lag')).toHaveLength(1);
    expect(await mailsFor('คิว job ค้าง')).toHaveLength(2);
    // OPEN ได้แถวเดียวต่อ key (partial unique index)
    await expect(
      db.$executeRaw`INSERT INTO monitor_alert (id, key, rule, severity, status, threshold, open_value, last_value, opened_at, last_seen_at)
        VALUES (gen_random_uuid(), 'job_lag', 'job_lag', 'warning', 'OPEN', 300, 1, 1, now(), now())`,
    ).rejects.toThrow(/23505|already exists/);
  });

  it('MONITOR_ALERT_EMAILS ทับผู้รับ · อัตรา 5xx ข้าม instance (ตัวนับต่อนาที) > 1% → critical ทันที', async () => {
    process.env.MONITOR_ALERT_EMAILS =
      'oncall@innovera.test, OnCall@innovera.test ,ops@innovera.test';
    const T0 = new Date('2026-11-19T06:00:00.000Z');
    // ตัวนับในหน่วยความจำ → flush ลงฐาน (2 instance)
    // ไม่มีตัว flush (MONITOR=off / worker) = ไม่สะสมรายนาที
    const idle = new HttpMetrics();
    idle.record('GET', '/orders', 200, 0.01);
    expect(idle.pendingMinutes).toBe(0);
    expect(idle.requests.size).toBe(1);
    // สะสมไม่เกิน 60 นาที (ฐานล่มนาน)
    const capped = new HttpMetrics();
    capped.persist = true;
    for (let i = 0; i < 90; i++) capped.record('GET', '/orders', 200, 0.01, T0.getTime() + i * MIN);
    expect(capped.pendingMinutes).toBe(60);
    const m1 = new HttpMetrics();
    m1.persist = true;
    for (let i = 0; i < 90; i++) m1.record('GET', '/orders', 200, 0.02, T0.getTime() - 2 * MIN);
    for (let i = 0; i < 5; i++) m1.record('GET', '/orders/:id', 503, 0.4, T0.getTime() - 2 * MIN);
    expect(await m1.flush(db, 'api-a')).toBe(1);
    const m2 = new HttpMetrics();
    m2.persist = true;
    for (let i = 0; i < 30; i++) m2.record('POST', '/orders', 201, 0.05, T0.getTime() - MIN);
    await m2.flush(db, 'api-b');
    const rows = await db.httpRequestMinute.findMany({ orderBy: { instanceId: 'asc' } });
    expect(rows.map((r) => [r.instanceId, r.total, r.errors])).toEqual([
      ['api-a', 95, 5],
      ['api-b', 30, 0],
    ]);
    const r = await evaluator.evaluate(T0);
    expect(r.opened).toContain('http_5xx_rate');
    const [a] = await alertsFor('http_5xx_rate');
    expect(a!.severity).toBe('critical');
    expect(a!.openValue).toBeCloseTo(5 / 125, 5);
    const mails = await mailsFor('อัตรา error 5xx');
    expect(mails.map((x) => x.toAddress).sort()).toEqual([
      'oncall@innovera.test',
      'ops@innovera.test',
    ]);
    expect(mails[0]!.subject).toContain('[วิกฤต]');
  });

  it('API probe ทุกนาที (worker restart ไม่ทำให้นาทีหาย) · worker หยุด: API ประเมินแทน + ส่งอีเมลตรง · SMTP ล้ม = ลองใหม่รอบหน้า', async () => {
    const scheduler = app.get(MonitorScheduler);
    const T0 = new Date(Math.floor(Date.now() / MIN) * MIN + 10 * MIN);
    clock.set(T0);
    await availability.beat('worker', new Date(T0.getTime() - MIN), 'w-1');
    // worker ทำงาน: API ไม่ประเมิน แต่ยัง probe นาทีนี้
    expect(await scheduler.tickApi()).toEqual({ evaluated: null });
    expect(await db.availabilityProbe.findUniqueOrThrow({ where: { minute: T0 } })).toMatchObject({
      ok: true,
      source: 'api',
    });
    // heartbeat ล่าสุด 10 นาทีก่อน + SMTP ล้ม
    await owner.$executeRaw`UPDATE worker_heartbeat SET last_beat_at = ${new Date(T0.getTime() - 10 * MIN)}::timestamptz`;
    const T1 = new Date(T0.getTime() + MIN);
    clock.set(T1);
    evaluator.useTransport({
      name: 'broken',
      send: async () => {
        throw new Error('smtp down');
      },
    });
    const r = await scheduler.tickApi();
    expect(r.evaluated?.opened).toContain('worker_down');
    expect((await alertsFor('worker_down'))[0]!.notifiedAt).toBeNull();
    // รอบถัดไป SMTP กลับมา → ส่ง alert ที่ค้างแจ้ง (ไม่ใช่ alert ใหม่)
    const direct = new MemoryTransport();
    evaluator.useTransport(direct);
    const T2 = new Date(T1.getTime() + MIN);
    clock.set(T2);
    const r2 = await scheduler.tickApi();
    expect(r2.evaluated?.opened).not.toContain('worker_down');
    const [a] = await alertsFor('worker_down');
    expect(a!.notifiedAt).toEqual(T2);
    const sentTo = () =>
      direct.sent
        .filter((m) => m.subject.includes('worker หยุดทำงาน'))
        .map((m) => m.to)
        .sort();
    expect(sentTo()).toEqual([staff.SUPER_ADMIN!.email, staff.SUPPORT!.email].sort());
    // แจ้งแล้ว → รอบต่อไปไม่ส่งซ้ำ
    clock.set(new Date(T2.getTime() + MIN));
    await scheduler.tickApi();
    expect(sentTo()).toHaveLength(2);
    // ไม่เข้าคิว outbox (worker ไม่มีใครส่ง — และกันส่งซ้ำเมื่อ worker กลับมา)
    expect(await mailsFor('worker หยุดทำงาน')).toHaveLength(0);
    expect(await db.availabilityProbe.count({ where: { minute: { gte: T0 } } })).toBe(4);
  });

  it('จังหวะต้นนาที: msToNextMinute ไม่สะสมความคลาดเคลื่อน', () => {
    const base = Date.UTC(2026, 10, 19, 3, 0, 0);
    expect(msToNextMinute(base, 2_000)).toBe(2_000);
    expect(msToNextMinute(base + 1_500, 2_000)).toBe(500);
    expect(msToNextMinute(base + 2_000, 2_000)).toBe(60_000);
    expect(msToNextMinute(base + 59_999, 5_000)).toBe(5_001);
  });

  it('availability: probe 1 แถว/นาที · รายเดือน (เวลาไทย) นาทีที่ไม่มีผลนับเป็นล่ม · เป้า 99.5%', async () => {
    const now = new Date();
    const first = await availability.probe(now, 'worker');
    expect(first).toMatchObject({ ok: true, status: 200, recorded: true });
    expect((await availability.probe(now, 'api')).recorded).toBe(false);
    // probe ไปที่ที่ไม่มีคนฟัง = ล่ม
    const down = await availability.probe(
      new Date(now.getTime() + MIN),
      'worker',
      'http://127.0.0.1:9/v1/readyz',
    );
    expect(down).toMatchObject({ ok: false, status: null, recorded: true });

    // ต.ค. 2569 เวลาไทย: 44,640 นาที — ล่ม 240 นาที, ไม่มีผล 60 นาที → 99.33% ต่ำกว่าเป้า
    const { start, end } = bangkokMonthRange('2026-10');
    expect(start.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect((end.getTime() - start.getTime()) / MIN).toBe(44_640);
    await owner.$executeRaw`
      INSERT INTO availability_probe (minute, ok, status, source)
      SELECT m, (i NOT BETWEEN 1000 AND 1239), 200, 'worker'
        FROM generate_series(0, 44639) AS i, LATERAL (SELECT ${start}::timestamptz + i * interval '1 minute' AS m) x
       WHERE i NOT BETWEEN 20000 AND 20059`;
    const token = await signIn('SUPPORT');
    const r = await http()
      .get('/v1/platform/monitoring/availability?month=2026-10')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(r.body).toMatchObject({
      month: '2026-10',
      targetPct: 99.5,
      minutes: 44_640,
      upMinutes: 44_640 - 300,
      downMinutes: 240,
      missingMinutes: 60,
      met: false,
    });
    expect(r.body.availabilityPct).toBeCloseTo(((44_640 - 300) / 44_640) * 100, 2);
    expect(r.body.measuredFrom).toBe(start.toISOString());
    // ยังไม่มีข้อมูล = null · รูปแบบเดือนผิด = 422 · BILLING = 403 · token ลูกค้า = 401
    const empty = await http()
      .get('/v1/platform/monitoring/availability?month=2026-01')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(empty.body).toMatchObject({ minutes: 0, availabilityPct: null, met: null });
    await http()
      .get('/v1/platform/monitoring/availability?month=2026-13')
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
    const billing = await signIn('BILLING');
    await http()
      .get('/v1/platform/monitoring/alerts')
      .set('Authorization', `Bearer ${billing}`)
      .expect(403);
    const customer = await tokenFor(tenantId);
    await http()
      .get('/v1/platform/monitoring/status')
      .set('Authorization', `Bearer ${customer}`)
      .expect(401);
  });

  it('Console API: status (เงื่อนไขทั้งหมด) + alerts (เปิดก่อน, กรองสถานะ) — id เป็น alr_…', async () => {
    const T0 = new Date('2026-11-19T08:00:00.000Z');
    await db.$executeRaw`
      INSERT INTO job (id, tenant_id, type, status, run_at, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'mon.lag', 'PENDING', ${new Date(T0.getTime() - 30 * MIN)}::timestamptz, now())`;
    await evaluator.evaluate(T0);
    await evaluator.evaluate(new Date(T0.getTime() + MIN));
    const token = await signIn('SUPER_ADMIN');
    const s = await http()
      .get('/v1/platform/monitoring/status')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(s.body.openAlerts).toBeGreaterThanOrEqual(1);
    const job = s.body.checks.find((c: { key: string }) => c.key === 'job_lag');
    expect(job).toMatchObject({
      rule: 'job_lag',
      state: 'firing',
      unit: 'seconds',
      threshold: 300,
    });
    expect(s.body.readiness.db).toBe('ok');
    const open = await http()
      .get('/v1/platform/monitoring/alerts?status=open')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const a = open.body.find((x: { key: string }) => x.key === 'job_lag');
    expect(a).toMatchObject({
      status: 'open',
      rule: 'job_lag',
      severity: 'warning',
      unit: 'seconds',
    });
    expect(a.id).toMatch(/^alr_[0-9a-f]{32}$/);
    const resolved = await http()
      .get('/v1/platform/monitoring/alerts?status=resolved')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(resolved.body).toEqual([]);
    await http()
      .get('/v1/platform/monitoring/alerts?status=bogus')
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
  });

  it('ตาราง monitoring: role แอป (tms_app) อ่าน/เขียนไม่ได้ · platform ลบ alert ไม่ได้ (ไม่มี hard delete)', async () => {
    for (const t of [
      'worker_heartbeat',
      'monitor_check',
      'monitor_alert',
      'availability_probe',
      'http_request_minute',
    ])
      await expect(appDb.$queryRawUnsafe(`SELECT 1 FROM ${t} LIMIT 1`)).rejects.toThrow(
        /permission denied/,
      );
    await expect(db.$executeRaw`DELETE FROM monitor_alert`).rejects.toThrow(/permission denied/);
  });

  it('กฎ: ค่าเริ่ม/ปรับด้วย MONITOR_RULES (ผิดรูป = ล้มทันที) · ปิดกฎ = ไม่เตือน · connector/webhook/disk จาก snapshot', async () => {
    const r = loadRules('{"outbox_lag":{"threshold":600,"for":3},"disk_usage":{"enabled":false}}');
    expect(r.outbox_lag).toMatchObject({ threshold: 600, for: 3, clearAfter: 3 });
    expect(r.disk_usage.enabled).toBe(false);
    expect(() => loadRules('{"nope":{}}')).toThrow(/unknown rule/);
    expect(() => loadRules('{"job_lag":{"for":0}}')).toThrow(/integer/);
    expect(() => loadRules('{"job_lag":{"threshold":"5"}}')).toThrow(/number/);
    const snap = await app.get(MonitorCollector).collect(new Date());
    const obs = observe(
      {
        ...snap,
        connectors: [
          { id: 'con_a', adapter: 'demo', status: 'ACTIVE', healthOk: false, pullLagSec: 4000 },
          { id: 'con_b', adapter: 'demo', status: 'PAUSED', healthOk: null, pullLagSec: null },
        ],
        webhook: { delivered: 5, failed: 10, exhausted: 10, autoDisabled: 0 },
        disk: { freeBytes: 1, totalBytes: 10, usedRatio: 0.9 },
      },
      DEFAULT_RULES,
    );
    const v = (k: string, s: string | null = null) =>
      obs.find((o) => o.rule === k && o.subject === s)?.value;
    expect(v('connector_unhealthy', 'con_a')).toBe(1);
    expect(v('connector_lag', 'con_a')).toBe(4000);
    expect(obs.some((o) => o.subject === 'con_b')).toBe(false);
    expect(v('webhook_failure_rate')).toBeCloseTo(0.8);
    expect(v('disk_usage')).toBe(0.9);
    // ต่ำกว่าจำนวนขั้นต่ำ (20 ครั้ง) = ไม่คิดอัตรา
    const few = observe(
      { ...snap, webhook: { delivered: 0, failed: 5, exhausted: 0, autoDisabled: 0 } },
      DEFAULT_RULES,
    );
    expect(few.find((o) => o.rule === 'webhook_failure_rate')?.value).toBe(0);
    expect(httpMetrics).toBeInstanceOf(HttpMetrics);
  });
});
