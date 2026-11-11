import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { DbService } from '../src/db/db.service';
import { JobQueue } from '../src/jobs/job-queue.service';
import { EmailDispatcher } from '../src/modules/email/email.service';
import { MemoryTransport, type EmailTransport } from '../src/modules/email/transport';
import {
  NotificationService,
  type NotificationChannel,
} from '../src/modules/notifications/notification.service';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

/** ST1-T23: เรียก notify() แล้วผู้รับเห็นใน in-app และได้อีเมล */
describe('notifications (ST1-T23)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let svc: NotificationService;
  let dbs: DbService;
  let dispatcher: EmailDispatcher;
  let mail: MemoryTransport;
  let tA: string;
  let tB: string;
  let somchai: string; // admin, th
  let jane: string; // planner, en
  let disabled: string;
  let other: string; // tenant B

  async function member(
    tenantId: string,
    email: string,
    role: string,
    extra: { locale?: string; status?: 'ACTIVE' | 'DISABLED' } = {},
  ) {
    const roles = await ensureSystemRoles(db, tenantId);
    const u = await db.appUser.create({
      data: {
        tenantId,
        email,
        name: email,
        status: extra.status ?? 'ACTIVE',
        locale: extra.locale ?? 'th',
      },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles[role]! } });
    return u.id;
  }
  const as = async (tenantId: string, userId: string) =>
    api(app, await tokenFor(tenantId, '*', userId));
  const notify = (tenantId: string, input: Parameters<NotificationService['notify']>[1]) =>
    dbs.withTenant(tenantId, (tx) => svc.notify(tx, input));

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    svc = app.get(NotificationService);
    dbs = app.get(DbService);
    dispatcher = app.get(EmailDispatcher);
    tA = (await createTenant(db, 'บริษัท เอ ขนส่ง จำกัด')).id;
    tB = (await createTenant(db, 'บริษัท บี ขนส่ง จำกัด')).id;
    somchai = await member(tA, 'somchai@ntf.test', 'admin');
    jane = await member(tA, 'jane@ntf.test', 'planner', { locale: 'en' });
    disabled = await member(tA, 'gone@ntf.test', 'planner', { status: 'DISABLED' });
    other = await member(tB, 'b@ntf.test', 'admin');
  });
  beforeEach(async () => {
    mail = new MemoryTransport();
    dispatcher.use(mail);
    await db.notification.deleteMany({});
    await db.emailOutbox.deleteMany({});
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('notify() → กระดิ่ง (ภาษาผู้รับ) + อีเมล; อ่านแล้วตัวนับลด', async () => {
    const n = await notify(tA, {
      tenantId: tA,
      to: { userIds: [somchai, jane] },
      template: 'job.succeeded',
      vars: { label: 'นำเข้าลูกค้า' },
      link: '/settings/users',
    });
    expect(n).toBe(2);
    const s = await as(tA, somchai);
    expect((await s.get('/v1/me/notifications/unread-count').expect(200)).body).toEqual({
      unread: 1,
    });
    const list = (await s.get('/v1/me/notifications').expect(200)).body;
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      type: 'job.succeeded',
      title: 'งานเสร็จแล้ว',
      body: 'นำเข้าลูกค้า เสร็จเรียบร้อย',
      link: '/settings/users',
      readAt: null,
    });
    expect(list.data[0].id).toMatch(/^ntf_[0-9a-f]{32}$/);
    const j = (await (await as(tA, jane)).get('/v1/me/notifications').expect(200)).body;
    expect(j.data[0].title).toBe('Job finished');

    // อีเมล: ส่งผ่าน outbox → สถานะแถวช่องอีเมลเป็น SENT
    expect(await dispatcher.drain()).toBe(2);
    const th = mail.sent.find((m) => m.to === 'somchai@ntf.test')!;
    expect(th.subject).toBe('งานเสร็จแล้ว — TMS');
    expect(th.text).toContain('นำเข้าลูกค้า เสร็จเรียบร้อย');
    expect(th.text).toContain('http://localhost:4420/settings/users');
    expect(mail.sent.find((m) => m.to === 'jane@ntf.test')!.subject).toBe('Job finished — TMS');
    const emailRows = await db.notification.findMany({ where: { channel: 'email' } });
    expect(emailRows.map((r) => r.status)).toEqual(['SENT', 'SENT']);
    expect(emailRows.every((r) => r.sentAt)).toBe(true);

    await s.post(`/v1/me/notifications/${list.data[0].id}/read`).expect(204);
    await s.post(`/v1/me/notifications/${list.data[0].id}/read`).expect(204); // ซ้ำได้
    expect((await s.get('/v1/me/notifications/unread-count')).body.unread).toBe(0);
    expect((await s.get('/v1/me/notifications?unread=true')).body.data).toHaveLength(0);
    expect((await s.get('/v1/me/notifications')).body.data[0].readAt).not.toBeNull();
  });

  it('ส่งตาม role: เฉพาะผู้ใช้ ACTIVE ของ tenant นั้น ไม่ซ้ำ', async () => {
    const n = await notify(tA, {
      tenantId: tA,
      to: { roles: ['planner', 'admin'], userIds: [somchai] },
      template: 'job.failed',
      vars: { label: 'x' },
      channels: ['in_app'],
    });
    expect(n).toBe(2); // somchai + jane — ไม่รวม disabled, ไม่ซ้ำ somchai
    const rows = await db.notification.findMany();
    expect(rows.map((r) => r.recipientId).sort()).toEqual([somchai, jane].sort());
    expect(rows.some((r) => r.recipientId === disabled || r.recipientId === other)).toBe(false);
    expect(await db.emailOutbox.count()).toBe(0);
  });

  it('เห็นเฉพาะของตัวเอง: ของคนอื่นใน tenant เดียวกัน/ต่าง tenant → 404', async () => {
    await notify(tA, {
      tenantId: tA,
      to: { userIds: [jane] },
      template: 'job.succeeded',
      vars: { label: 'x' },
      channels: ['in_app'],
    });
    const row = await db.notification.findFirstOrThrow();
    const id = `ntf_${row.id.replace(/-/g, '')}`;
    await (await as(tA, somchai)).post(`/v1/me/notifications/${id}/read`).expect(404);
    await (await as(tB, other)).post(`/v1/me/notifications/${id}/read`).expect(404);
    expect((await (await as(tA, somchai)).get('/v1/me/notifications')).body.data).toHaveLength(0);
    // อ่านทั้งหมดของ somchai ไม่แตะของ jane
    expect((await (await as(tA, somchai)).post('/v1/me/notifications/read-all')).body).toEqual({
      updated: 0,
    });
    expect((await db.notification.findFirstOrThrow()).readAt).toBeNull();
    expect((await (await as(tA, jane)).post('/v1/me/notifications/read-all')).body).toEqual({
      updated: 1,
    });
  });

  it('rollback ของงานหลัก = ไม่มีแจ้งเตือนและไม่มีอีเมล', async () => {
    await expect(
      dbs.withTenant(tA, async (tx) => {
        await svc.notify(tx, {
          tenantId: tA,
          to: { userIds: [somchai] },
          template: 'job.succeeded',
          vars: { label: 'x' },
        });
        throw new Error('งานหลักล้ม');
      }),
    ).rejects.toThrow('งานหลักล้ม');
    expect(await db.notification.count()).toBe(0);
    expect(await db.emailOutbox.count()).toBe(0);
  });

  it('อีเมลส่งไม่สำเร็จครบจำนวนครั้ง → แถวช่องอีเมลเป็น FAILED', async () => {
    const failing: EmailTransport = {
      name: 'failing',
      send: async () => {
        throw new Error('smtp down');
      },
    };
    dispatcher.use(failing);
    await notify(tA, {
      tenantId: tA,
      to: { userIds: [somchai] },
      template: 'job.succeeded',
      vars: { label: 'x' },
      channels: ['email'],
    });
    await db.emailOutbox.updateMany({ data: { maxAttempts: 1 } });
    await dispatcher.drain();
    const r = await db.notification.findFirstOrThrow({ where: { channel: 'email' } });
    expect(r.status).toBe('FAILED');
    expect(r.failedReason).toBe('email_failed');
  });

  it('ช่องทางเสียบเพิ่มได้ (interface) และช่องที่ยังไม่ลงทะเบียนถูกปฏิเสธ', async () => {
    const seen: string[] = [];
    const fake: NotificationChannel = {
      name: 'push',
      deliver: async (_tx, items) => {
        for (const n of items) seen.push(`${n.recipient.id}:${n.title}`);
      },
    };
    await expect(
      notify(tA, {
        tenantId: tA,
        to: { userIds: [somchai] },
        template: 'job.succeeded',
        vars: { label: 'x' },
        channels: ['line'],
      }),
    ).rejects.toThrow(/not registered/);
    svc.register(fake);
    await notify(tA, {
      tenantId: tA,
      to: { userIds: [somchai] },
      template: 'job.succeeded',
      vars: { label: 'x' },
      channels: ['push'],
    });
    expect(seen).toEqual([`${somchai}:งานเสร็จแล้ว`]);
  });

  it('link ต้องเป็น path ภายในเว็บ (กันลิงก์ไปเว็บอื่นในอีเมล)', async () => {
    for (const link of [
      'https://evil.test/x',
      '//evil.test',
      '/\\evil.test',
      '/a\\b',
      'javascript:alert(1)',
    ])
      await expect(
        notify(tA, {
          tenantId: tA,
          to: { userIds: [somchai] },
          template: 'job.succeeded',
          vars: { label: 'x' },
          link,
        }),
      ).rejects.toThrow(/internal path/);
  });

  it('job ที่สั่งด้วย notify → ผู้สั่งได้แจ้งเตือนเมื่อสำเร็จ/ล้มครบจำนวนครั้ง', async () => {
    const queue = app.get(JobQueue);
    queue.register('test.ntf.ok', async () => ({ ok: true }));
    queue.register('test.ntf.fail', async () => {
      throw new Error('boom');
    });
    await db.job.deleteMany({});
    await dbs.withTenant(tA, async (tx) => {
      await queue.enqueue(tx, {
        tenantId: tA,
        type: 'test.ntf.ok',
        notify: { userId: somchai, label: 'นำเข้ารถ', link: '/settings/users' },
      });
      await queue.enqueue(tx, {
        tenantId: tA,
        type: 'test.ntf.fail',
        maxAttempts: 1,
        notify: { userId: somchai, label: 'นำเข้าคนขับ' },
      });
    });
    while (await queue.runOnce());
    const rows = await db.notification.findMany({
      where: { channel: 'in_app' },
      orderBy: { templateCode: 'asc' },
    });
    expect(rows.map((r) => [r.templateCode, r.body])).toEqual([
      ['job.failed', 'นำเข้าคนขับ ไม่สำเร็จ ลองใหม่ครบจำนวนครั้งแล้ว'],
      ['job.succeeded', 'นำเข้ารถ เสร็จเรียบร้อย'],
    ]);
    expect(
      rows.every((r) => r.relatedEntityType === 'job' && /^job_/.test(r.relatedEntityId!)),
    ).toBe(true);
  });

  it('role แอปแก้เนื้อหา/ลบแจ้งเตือนไม่ได้ (แก้ได้แค่สถานะการอ่าน)', async () => {
    await notify(tA, {
      tenantId: tA,
      to: { userIds: [somchai] },
      template: 'job.succeeded',
      vars: { label: 'x' },
      channels: ['in_app'],
    });
    await expect(
      dbs.withTenant(tA, (tx) => tx.notification.updateMany({ data: { title: 'แก้' } })),
    ).rejects.toThrow(/permission denied/);
    await expect(dbs.withTenant(tA, (tx) => tx.notification.deleteMany({}))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('label จากผู้ใช้: ตัด URL/โดเมนก่อนลงข้อความและอีเมล', async () => {
    await notify(tA, {
      tenantId: tA,
      to: { userIds: [somchai] },
      template: 'job.succeeded',
      vars: { label: 'นำเข้า https://evil.test/login ไฟล์ www.evil.test evil.com.xlsx' },
    });
    const r = await db.notification.findFirstOrThrow({ where: { channel: 'in_app' } });
    expect(r.body).not.toMatch(/evil/);
    await dispatcher.drain();
    expect(mail.sent[0]!.text).not.toMatch(/evil/);
  });

  it('job ที่ lease หมดแล้วถูกหยิบซ้ำ: worker เดิมจบทีหลังไม่ทับผลและไม่แจ้งซ้ำ', async () => {
    const queue = app.get(JobQueue);
    let first = true;
    queue.register('test.ntf.slow', async () => {
      if (first) {
        first = false;
        // จำลอง lease หมด: worker อื่นหยิบงานเดียวกันและทำเสร็จก่อน
        await db.job.updateMany({
          where: { type: 'test.ntf.slow' },
          data: { lockedUntil: new Date(Date.now() - 1000) },
        });
        await queue.runOnce();
      }
      return { ok: true };
    });
    await db.job.deleteMany({});
    await dbs.withTenant(tA, (tx) =>
      queue.enqueue(tx, {
        tenantId: tA,
        type: 'test.ntf.slow',
        notify: { userId: somchai, label: 'งานช้า' },
      }),
    );
    await queue.runOnce();
    expect(await db.notification.count({ where: { channel: 'in_app' } })).toBe(1);
    expect((await db.job.findFirstOrThrow()).status).toBe('SUCCEEDED');
  });

  it('ลบผู้ใช้: อีเมลที่ยังรอส่งถูกยกเลิก ที่อยู่จริงถูกลบ แถวช่องอีเมลเป็น FAILED', async () => {
    const victim = await member(tA, 'victim@ntf.test', 'planner');
    await notify(tA, {
      tenantId: tA,
      to: { userIds: [victim] },
      template: 'job.succeeded',
      vars: { label: 'x' },
      channels: ['email'],
    });
    await (
      await as(tA, somchai)
    )
      .post(`/v1/users/usr_${victim.replace(/-/g, '')}/delete`)
      .send({ reason: 'ลาออก' })
      .expect(200);
    expect(await dispatcher.drain()).toBe(0);
    const e = await db.emailOutbox.findFirstOrThrow();
    expect(e.status).toBe('FAILED');
    expect(e.toAddress).not.toContain('victim');
    expect((await db.notification.findFirstOrThrow()).status).toBe('FAILED');
  });

  it('แบ่งหน้า: 25 รายการที่สร้างใน transaction เดียว (เวลาเท่ากัน) ได้ครบไม่ข้าม', async () => {
    await dbs.withTenant(tA, async (tx) => {
      for (let i = 0; i < 25; i++)
        await svc.notify(tx, {
          tenantId: tA,
          to: { userIds: [somchai] },
          template: 'job.succeeded',
          vars: { label: `n${i}` },
          channels: ['in_app'],
        });
    });
    const s = await as(tA, somchai);
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `&cursor=${cursor}` : '';
      const r = (await s.get(`/v1/me/notifications?limit=7${q}`).expect(200)).body;
      for (const x of r.data) seen.add(x.id);
      cursor = r.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(25);
  });

  it('job notify ตรวจตอนสั่งงาน; payload._notify จากผู้เรียกถูกตัดทิ้ง', async () => {
    const queue = app.get(JobQueue);
    await dbs.withTenant(tA, async (tx) => {
      await expect(
        queue.enqueue(tx, { tenantId: tA, type: 'x', notify: { userId: 'nope', label: 'a' } }),
      ).rejects.toThrow(/uuid/);
      await expect(
        queue.enqueue(tx, {
          tenantId: tA,
          type: 'x',
          notify: { userId: somchai, label: 'a', link: 'https://evil.test' },
        }),
      ).rejects.toThrow(/internal path/);
      const j = await queue.enqueue(tx, {
        tenantId: tA,
        type: 'x',
        payload: { a: 1, _notify: { userId: somchai, label: 'ปลอม' } },
      });
      expect(j.payload).toEqual({ a: 1 });
    });
  });

  it('API key (ไม่ใช่ผู้ใช้) ไม่มีกล่องแจ้งเตือน → 404', async () => {
    const t = await tokenFor(tA, '*');
    await api(app, t).get('/v1/me/notifications').expect(404);
  });
});
