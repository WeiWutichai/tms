import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clock } from '../src/common/clock';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import { JobQueue } from '../src/jobs/job-queue.service';
import { EmailDispatcher } from '../src/modules/email/email.service';
import { MemoryTransport } from '../src/modules/email/transport';
import {
  DAILY_DIGEST_JOB,
  DailyDigestService,
  digestWindow,
} from '../src/modules/notifications/daily-digest.service';
import { NotificationEvents } from '../src/modules/notifications/notification-events';
import { NotificationService } from '../src/modules/notifications/notification.service';
import { OrderIntakeService } from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST9-T08 ศูนย์แจ้งเตือน (docs/04 I) — เกณฑ์ตรวจรับ:
 * ผู้ใช้ปิดการรับ event หนึ่งทางอีเมลแล้วไม่ได้อีเมลนั้นแต่ยังเห็น in-app · สรุป 08:00 ส่งครั้งเดียว
 */
describe('notification center (ST9-T08)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let dbs: DbService;
  let svc: NotificationService;
  let digest: DailyDigestService;
  let dispatcher: EmailDispatcher;
  let queue: JobQueue;
  let clock: Clock;
  let mail: MemoryTransport;
  let tA: string;
  let tB: string;
  let planner: string;
  let planner2: string;
  let invoicer: string;
  let viewer: string;
  let accounting: string;
  let otherUser: string;
  let seq = 0;

  async function member(tenantId: string, role: string, locale = 'th') {
    const r = await db.role.findFirstOrThrow({ where: { tenantId, code: role } });
    const u = await db.appUser.create({
      data: {
        tenantId,
        email: `nc${++seq}-${role}@nc.test`,
        name: `${role} ${seq}`,
        status: 'ACTIVE',
        locale,
      },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } });
    return u.id;
  }
  const as = async (tenantId: string, userId: string) =>
    api(app, await tokenFor(tenantId, '*', userId));
  const rows = (where: Record<string, unknown>) =>
    db.notification.findMany({ where, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    dbs = app.get(DbService);
    svc = app.get(NotificationService);
    digest = app.get(DailyDigestService);
    dispatcher = app.get(EmailDispatcher);
    queue = app.get(JobQueue);
    clock = app.get(Clock);
    tA = (await createTenantWithDefaults(db, { name: 'บริษัท ศูนย์แจ้งเตือน' })).id;
    tB = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น แจ้งเตือน' })).id;
    planner = await member(tA, 'planner');
    planner2 = await member(tA, 'planner', 'en');
    invoicer = await member(tA, 'invoicer');
    viewer = await member(tA, 'viewer');
    accounting = await member(tA, 'accounting');
    // นิติบุคคล + สาขาออกเอกสาร (order ต้องมีผู้ออกเอกสาร)
    const c = await db.company.create({
      data: { tenantId: tA, legalName: 'บริษัท ศูนย์แจ้งเตือน จำกัด', taxId: validTaxId(4242) },
    });
    await db.branch.create({
      data: {
        tenantId: tA,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
        isDefaultIssuer: true,
      },
    });
    otherUser = await member(tB, 'planner');
  });
  beforeEach(async () => {
    mail = new MemoryTransport();
    dispatcher.use(mail);
    await db.notification.deleteMany({});
    await db.emailOutbox.deleteMany({});
    await db.notificationDigest.deleteMany({});
    await db.userPreference.deleteMany({ where: { key: 'notifications' } });
  });
  afterAll(async () => {
    clock.set(null);
    await app.close();
    await db.$disconnect();
  });

  it('GET ค่าเริ่มต้น: 8 event ตาม docs/04 I + MISMATCH (D68-61) · ใบค้างใหม่ไม่ส่งอีเมล · LINE ปิด · event ที่โมดูลยังไม่มีบอกงาน · สรุปรายวันเปิด', async () => {
    const s = await as(tA, planner);
    const r = await s.get('/v1/me/notification-preferences').expect(200);
    expect(r.headers.etag).toBe('"0"');
    expect(r.body.version).toBe(0);
    expect(r.body.dailyDigest).toBe(true);
    const by: Record<string, { event: string; pendingTask: string | null }> = Object.fromEntries(
      (r.body.events as { event: string; pendingTask: string | null }[]).map((e) => [e.event, e]),
    );
    expect(Object.keys(by)).toEqual([
      'order.on_hold',
      'subcon.no_response',
      'dispute',
      'approval.requested',
      'document.expiring',
      'connector.down',
      'reconcile.mismatch',
      'delivery_order.unbilled',
      'payment.due',
    ]);
    expect(by['order.on_hold']).toEqual({
      event: 'order.on_hold',
      inApp: true,
      email: false,
      line: false,
      pendingTask: null,
    });
    expect(by['subcon.no_response']).toMatchObject({ inApp: true, email: true, line: false });
    expect(by.dispute!.pendingTask).toBeNull(); // ST6-T06 ยิงแล้ว (settlement.disputed)
    expect(by['delivery_order.unbilled']!.pendingTask).toBeNull(); // ST9-T06 ยิงแล้ว (delivery_order.unbilled)
    expect(by['payment.due']!.pendingTask).toBeNull(); // ST5-T22 ยิงแล้ว (invoice.payment_due)
    // D-81 · D68-61 docs/01 §6.5 MONEY → หัวหน้าบัญชีทันที (ในระบบ + อีเมล)
    expect(by['reconcile.mismatch']).toMatchObject({ inApp: true, email: true, pendingTask: null });
  });

  it('D68-61 MISMATCH: ผู้ดูแลรับชำระ (payments:record) ได้ในระบบ + อีเมล · ผู้วางบิล/ผู้วางแผน/ดูอย่างเดียวไม่ได้ · ไม่ข้าม tenant · ไม่มียอดเงิน · count 0 = ไม่แจ้ง', async () => {
    const ev = app.get(NotificationEvents);
    const connectorId = randomUUID();
    await dbs.withTenant(tA, (tx) =>
      ev.reconcileMismatch(tx, {
        tenantId: tA,
        connectorId,
        label: 'accountsystem',
        count: 7,
        invoiceNos: ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6'],
      }),
    );
    const n = await rows({ templateCode: 'reconcile.mismatch_found', channel: 'in_app' });
    const who = new Set(n.map((x) => x.recipientId));
    expect(who.has(accounting)).toBe(true);
    expect(who.has(invoicer)).toBe(false);
    expect(who.has(planner)).toBe(false);
    expect(who.has(viewer)).toBe(false);
    expect(who.has(otherUser)).toBe(false);
    expect(n.every((x) => x.tenantId === tA)).toBe(true);
    const mine = n.find((x) => x.recipientId === accounting)!;
    expect(mine.title).toBe('ข้อมูลไม่ตรงกับระบบบัญชี');
    expect(mine.link).toBe('/pay'); // review: ผู้รับ (บัญชี) ไม่มี settings:read
    expect(mine.body).toContain('7 ใบ');
    expect(mine.body).toContain('INV-5');
    expect(mine.body).not.toContain('INV-6'); // ตัวอย่างไม่เกิน 5
    const mails = await rows({ templateCode: 'reconcile.mismatch_found', channel: 'email' });
    expect(mails.map((x) => x.recipientId)).toContain(accounting);

    await db.notification.deleteMany({});
    await dbs.withTenant(tA, (tx) =>
      ev.reconcileMismatch(tx, { tenantId: tA, connectorId, label: 'x', count: 0, invoiceNos: [] }),
    );
    expect(await rows({ templateCode: 'reconcile.mismatch_found' })).toHaveLength(0);
  });

  it('PATCH เปลี่ยนเฉพาะที่ส่ง · If-Match ผิด → 412 · event ไม่รู้จัก → 422 · เห็นเฉพาะของตัวเอง', async () => {
    const s = await as(tA, planner);
    const r = await s
      .patch('/v1/me/notification-preferences')
      .set('If-Match', '"0"')
      .send({ events: [{ event: 'subcon.no_response', email: false }], dailyDigest: false })
      .expect(200);
    expect(r.headers.etag).toBe('"1"');
    const e = r.body.events.find((x: { event: string }) => x.event === 'subcon.no_response');
    expect(e).toMatchObject({ inApp: true, email: false });
    expect(r.body.dailyDigest).toBe(false);
    await s
      .patch('/v1/me/notification-preferences')
      .set('If-Match', '"0"')
      .send({ dailyDigest: true })
      .expect(412);
    await s
      .patch('/v1/me/notification-preferences')
      .send({ events: [{ event: 'nope', email: false }] })
      .expect(422);
    await s
      .patch('/v1/me/notification-preferences')
      .send({ events: [{ event: 'dispute', email: 'no' }] })
      .expect(422);
    // กลับเป็นค่าเริ่มต้น → ไม่เก็บค่าซ้ำค่าเริ่มต้น
    const back = await s
      .patch('/v1/me/notification-preferences')
      .send({ events: [{ event: 'subcon.no_response', email: true }] })
      .expect(200);
    expect(back.body.version).toBe(2);
    const stored = await db.userPreference.findFirstOrThrow({
      where: { userId: planner, key: 'notifications' },
    });
    expect(stored.value).toEqual({ events: {}, dailyDigest: false });
    // คนอื่นยังเป็นค่าเริ่มต้น
    const o = (await (await as(tA, planner2)).get('/v1/me/notification-preferences').expect(200))
      .body;
    expect(o.version).toBe(0);
    expect(o.dailyDigest).toBe(true);
    // API key / ผู้ใช้ที่ไม่มีอยู่ → 404
    await api(app, await tokenFor(tA, '*', randomUUID()))
      .get('/v1/me/notification-preferences')
      .expect(404);
  });

  it('เกณฑ์ตรวจรับ: ปิดอีเมลของ event หนึ่ง → ไม่ได้อีเมลนั้น แต่ยังเห็นในกระดิ่ง · คนที่ไม่ปิดได้ทั้งสองช่อง · event อื่นยังได้อีเมล', async () => {
    await (
      await as(tA, planner)
    )
      .patch('/v1/me/notification-preferences')
      .send({ events: [{ event: 'subcon.no_response', email: false }] })
      .expect(200);
    const n = await dbs.withTenant(tA, (tx) =>
      svc.notify(tx, {
        tenantId: tA,
        to: { userIds: [planner, planner2] },
        template: 'subcon_offer.no_response',
        vars: { tripNo: 'TRP-001', carrier: 'รถร่วม ก', hours: 2 },
        link: '/plan',
      }),
    );
    expect(n).toBe(2);
    expect((await rows({ recipientId: planner })).map((r) => r.channel)).toEqual(['in_app']);
    expect((await rows({ recipientId: planner2 })).map((r) => r.channel).sort()).toEqual([
      'email',
      'in_app',
    ]);
    expect(await dispatcher.drain()).toBe(1);
    expect(mail.sent.map((m) => m.to)).toEqual([expect.stringContaining('-planner@nc.test')]);
    expect(mail.sent[0]!.to).not.toBe(
      (await db.appUser.findUniqueOrThrow({ where: { id: planner } })).email,
    );
    // ผู้ใช้เห็นในกระดิ่ง
    const bell = (await (await as(tA, planner)).get('/v1/me/notifications').expect(200)).body;
    expect(bell.data[0]).toMatchObject({
      type: 'subcon_offer.no_response',
      title: 'รถร่วมยังไม่ตอบรับงาน',
    });
    // template ของ event เดียวกัน (หมดอายุ 48 ชม.) ก็ไม่ได้อีเมล · event อื่น (เอกสารใกล้หมด) ยังได้
    await dbs.withTenant(tA, async (tx) => {
      await svc.notify(tx, {
        tenantId: tA,
        to: { userIds: [planner] },
        template: 'subcon_offer.expired',
        vars: { tripNo: 'TRP-001', carrier: 'รถร่วม ก' },
      });
      await svc.notify(tx, {
        tenantId: tA,
        to: { userIds: [planner] },
        template: 'expiry.digest',
        vars: { total: 0, more: 0, items: [] },
      });
    });
    const mine = await rows({ recipientId: planner });
    expect(mine.filter((r) => r.channel === 'email').map((r) => r.templateCode)).toEqual([
      'expiry.digest',
    ]);
    // ปิดในกระดิ่งด้วย = ไม่ได้อะไรเลย · งานที่ผู้ใช้สั่งเอง (job.*) ปิดไม่ได้
    await (
      await as(tA, planner)
    )
      .patch('/v1/me/notification-preferences')
      .send({ events: [{ event: 'subcon.no_response', inApp: false }] })
      .expect(200);
    await db.notification.deleteMany({});
    await dbs.withTenant(tA, async (tx) => {
      await svc.notify(tx, {
        tenantId: tA,
        to: { userIds: [planner] },
        template: 'subcon_offer.expired',
        vars: { tripNo: 'TRP-002', carrier: 'รถร่วม ข' },
      });
      await svc.notify(tx, {
        tenantId: tA,
        to: { userIds: [planner] },
        template: 'job.succeeded',
        vars: { label: 'นำเข้า' },
      });
    });
    expect((await rows({ recipientId: planner })).map((r) => r.templateCode)).toEqual([
      'job.succeeded',
      'job.succeeded',
    ]);
  });

  it('ผู้รับตามสิทธิ์ (permissions) รวม role · exclude ผู้ทำเอง · ไม่ข้าม tenant', async () => {
    const n = await dbs.withTenant(tA, (tx) =>
      svc.notify(tx, {
        tenantId: tA,
        to: { permissions: ['orders:write'], exclude: [planner2] },
        template: 'job.succeeded',
        vars: { label: 'x' },
        channels: ['in_app'],
      }),
    );
    const got = new Set((await rows({})).map((r) => r.recipientId));
    expect(got.has(planner)).toBe(true);
    expect(got.has(planner2)).toBe(false);
    expect(got.has(invoicer)).toBe(false);
    expect(got.has(viewer)).toBe(false);
    expect(got.has(otherUser)).toBe(false);
    expect(n).toBe(got.size);
  });

  it('ใบค้างใหม่: order เข้าใบค้าง → ผู้มี orders:write เห็นในกระดิ่ง (ไม่มีอีเมลตามค่าเริ่มต้น) · ผู้วางบิล/ดูอย่างเดียวไม่ได้', async () => {
    const r = await dbs.withTenant(tA, (tx) =>
      requestContext.run(
        { requestId: randomUUID(), tenantId: tA, actorId: 'user-test', locale: 'th', tx },
        () =>
          app.get(OrderIntakeService).upsertOrder({
            source: 'ERP:krs',
            externalId: `NC-${randomUUID().slice(0, 8)}`,
            customer: { externalId: 'NC-404', text: 'ลูกค้าไม่รู้จัก' },
            requestedDate: bangkokToday(),
            stops: [
              { type: 'PICKUP', siteText: 'คลังต้นทาง' },
              { type: 'DELIVERY', siteText: 'ร้านปลายทาง' },
            ],
          }),
      ),
    );
    expect(r.order.status).toBe('ON_HOLD');
    const held = await rows({ templateCode: 'order.held' });
    expect(new Set(held.map((x) => x.recipientId))).toEqual(new Set([planner, planner2]));
    expect(held.every((x) => x.channel === 'in_app')).toBe(true);
    const th = held.find((x) => x.recipientId === planner)!;
    expect(th.title).toBe('ใบค้างใหม่');
    expect(th.body).toContain(r.order.soNo!);
    expect(th.body).toContain('ลูกค้าไม่รู้จัก');
    expect(th.link).toBe('/so/hold');
    expect(held.find((x) => x.recipientId === planner2)!.title).toBe('New on-hold order');
  });

  const heldOrder = (tx: Parameters<Parameters<DbService['withTenant']>[1]>[0]) =>
    requestContext.run(
      { requestId: randomUUID(), tenantId: tA, actorId: 'user-test', locale: 'th', tx },
      () =>
        app.get(OrderIntakeService).upsertOrder(
          {
            source: 'ERP:krs',
            externalId: `NB-${randomUUID().slice(0, 8)}`,
            customer: { externalId: 'NB-404', text: 'ลูกค้านำเข้า' },
            requestedDate: bangkokToday(),
            stops: [
              { type: 'PICKUP', siteText: 'คลัง' },
              { type: 'DELIVERY', siteText: 'ร้าน' },
            ],
          },
          tx,
        ),
    );

  it('review M: งานทีละมาก (นำเข้า/connector) → "ใบค้างใหม่ N ใบ" ฉบับเดียวต่อคน · ใบในขั้นตรวจที่ย้อนทิ้งไม่ถูกแจ้ง', async () => {
    const ev = app.get(NotificationEvents);
    await dbs.withTenant(tA, async (tx) => {
      const { held } = await ev.batchOrderHolds(async () => {
        for (let i = 0; i < 7; i++) await heldOrder(tx);
        // ใบที่ย้อนทิ้ง (เหมือนขั้นตรวจของการนำเข้า)
        await tx.$executeRawUnsafe('SAVEPOINT t_dry');
        await heldOrder(tx);
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT t_dry');
      });
      expect(held).toHaveLength(8);
      await ev.flushOrderHolds(tx, tA, held);
    });
    expect(await rows({ templateCode: 'order.held' })).toHaveLength(0);
    const b = await rows({ templateCode: 'order.held_batch', channel: 'in_app' });
    expect(b.map((x) => x.recipientId).sort()).toEqual([planner, planner2].sort());
    const th = b.find((x) => x.recipientId === planner)!;
    expect(th.title).toBe('ใบค้างใหม่ 7 ใบ');
    expect(th.body).toContain('และอีก 2 ใบ');
    expect(th.body).toContain('CUSTOMER_UNMAPPED 7');
    // ใบเดียวในงานทีละมาก = ข้อความปกติ
    await db.notification.deleteMany({});
    await dbs.withTenant(tA, async (tx) => {
      const { held } = await ev.batchOrderHolds(() => heldOrder(tx));
      await ev.flushOrderHolds(tx, tA, held);
    });
    expect((await rows({ channel: 'in_app' })).map((x) => x.templateCode)).toEqual([
      'order.held',
      'order.held',
    ]);
  });

  it('review M: แจ้งไม่สำเร็จ (เช่น ผู้รับเกินเพดาน) ไม่ย้อนการพักใบ', async () => {
    const spy = vi
      .spyOn(svc, 'notify')
      .mockRejectedValueOnce(new Error('too many notification recipients (501)'));
    try {
      const r = await dbs.withTenant(tA, (tx) => heldOrder(tx));
      expect(r.order.status).toBe('ON_HOLD');
      expect((await db.salesOrder.findUniqueOrThrow({ where: { id: r.order.id } })).status).toBe(
        'ON_HOLD',
      );
      expect(await rows({ templateCode: 'order.held' })).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('QA: PATCH พร้อมกันโดยไม่ส่ง If-Match → ทุกคำขอสำเร็จและรวมค่ากัน (ไม่ 412)', async () => {
    const s = await as(tA, planner2);
    const evs = ['subcon.no_response', 'approval.requested', 'document.expiring', 'connector.down'];
    const rs = await Promise.all(
      evs.map((event) =>
        s.patch('/v1/me/notification-preferences').send({ events: [{ event, email: false }] }),
      ),
    );
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const g = (await s.get('/v1/me/notification-preferences').expect(200)).body;
    for (const e of evs)
      expect(g.events.find((x: { event: string }) => x.event === e).email).toBe(false);
    expect(g.version).toBe(4);
  });

  it('ขออนุมัติ + connector ล่ม: ผู้รับตามสิทธิ์ยืนยันของฝั่ง · ผู้บันทึกเองไม่ได้', async () => {
    const ev = app.get(NotificationEvents);
    const trip = randomUUID();
    await dbs.withTenant(tA, (tx) =>
      requestContext.run(
        {
          requestId: randomUUID(),
          tenantId: tA,
          actorId: invoicer,
          principalType: 'user',
          locale: 'th',
          tx,
        },
        () =>
          ev.fieldChargePending(tx, {
            tenantId: tA,
            tripId: trip,
            item: 'ค่ายกของ',
            sell: true,
            buy: false,
          }),
      ),
    );
    const fc = await rows({ templateCode: 'field_charge.pending', channel: 'in_app' });
    const who = new Set(fc.map((x) => x.recipientId));
    expect(who.has(invoicer)).toBe(false); // ผู้บันทึกเอง (maker-checker)
    expect(who.has(planner)).toBe(false); // ไม่มี invoices:draft
    expect(who.has(accounting)).toBe(true);
    expect(fc[0]?.body).toContain('ค่ายกของ (ฝั่งขาย)');
    // review L3: บันทึกทั้งสองฝั่ง → ข้อความตามฝั่งที่ผู้รับยืนยันได้
    await db.notification.deleteMany({});
    await dbs.withTenant(tA, (tx) =>
      ev.fieldChargePending(tx, {
        tenantId: tA,
        tripId: trip,
        item: 'ค่ารอ',
        sell: true,
        buy: true,
      }),
    );
    const both = await rows({ templateCode: 'field_charge.pending', channel: 'in_app' });
    expect(both.find((x) => x.recipientId === invoicer)!.body).toContain('(ฝั่งขาย)');
    expect(both.find((x) => x.recipientId === accounting)!.body).toContain('(ฝั่งขายและฝั่งซื้อ)');

    await db.notification.deleteMany({});
    await dbs.withTenant(tA, (tx) =>
      ev.connectorDown(tx, {
        tenantId: tA,
        connectorId: randomUUID(),
        label: 'krs',
        code: 'auth_failed',
      }),
    );
    const cd = await rows({ templateCode: 'connector.error', channel: 'in_app' });
    const cw = new Set(cd.map((x) => x.recipientId));
    expect(cw.has(invoicer)).toBe(true); // integrations:retry
    expect(cw.has(accounting)).toBe(true);
    expect(cw.has(planner)).toBe(false);
    expect(cw.has(viewer)).toBe(false);
    expect(cd[0]!.body).toContain('krs');
  });

  describe('สรุปรายวัน 08:00', () => {
    const D = '2026-11-18';
    const at = (iso: string) => new Date(iso);
    async function seedInApp(userId: string, iso: string, template = 'order.held', read = false) {
      await db.notification.create({
        data: {
          tenantId: tA,
          recipientId: userId,
          channel: 'in_app',
          templateCode: template,
          locale: 'th',
          title: template === 'order.held' ? 'ใบค้างใหม่' : 'งานเสร็จแล้ว',
          body: `รายการ ${iso}`,
          status: read ? 'READ' : 'SENT',
          readAt: read ? new Date() : null,
          createdAt: at(iso),
        },
      });
    }

    it('ช่วงเวลา = เมื่อวาน 08:00 ถึงวันนี้ 08:00 เวลาไทย', () => {
      const w = digestWindow(D);
      expect(w.from.toISOString()).toBe('2026-11-17T01:00:00.000Z');
      expect(w.to.toISOString()).toBe('2026-11-18T01:00:00.000Z');
    });

    it('เกณฑ์ตรวจรับ: ส่งครั้งเดียว — รันซ้ำ / พร้อมกัน / job ซ้ำ ได้อีเมลฉบับเดียวต่อคน · ไม่มีอะไร = ไม่ส่ง · ปิดสรุป = ไม่ส่ง', async () => {
      await seedInApp(planner, '2026-11-17T01:00:00Z'); // 08:00 เมื่อวาน — นับ
      await seedInApp(planner, '2026-11-18T00:59:59Z', 'job.succeeded', true); // 07:59:59 วันนี้ — นับ
      await seedInApp(planner, '2026-11-17T00:59:59Z'); // ก่อนช่วง
      await seedInApp(planner, '2026-11-18T01:00:00Z'); // 08:00 วันนี้ = รอบหน้า
      await seedInApp(planner2, '2026-11-17T05:00:00Z');
      await seedInApp(viewer, '2026-11-17T05:00:00Z');
      await (
        await as(tA, viewer)
      )
        .patch('/v1/me/notification-preferences')
        .send({ dailyDigest: false })
        .expect(200);

      const runs = await Promise.all([1, 2, 3].map(() => digest.runForTenant(tA, D)));
      expect(runs.reduce((a, r) => a + r.sent, 0)).toBe(2); // planner + planner2
      expect(runs.reduce((a, r) => a + r.failed, 0)).toBe(0);
      const again = await digest.runForTenant(tA, D);
      expect(again).toMatchObject({ claimed: 0, sent: 0, failed: 0 });

      const emails = await rows({ templateCode: 'daily.digest' });
      expect(emails.map((e) => e.channel)).toEqual(['email', 'email']); // ไม่มีแถวในกระดิ่ง
      expect(new Set(emails.map((e) => e.recipientId))).toEqual(new Set([planner, planner2]));
      const ledger = await db.notificationDigest.findMany({ where: { tenantId: tA } });
      // ทุกคนที่เปิดสรุป (รวมคนที่ไม่มีอะไร) จองวันนี้แล้ว · viewer ปิดไว้ไม่จอง
      expect(ledger.find((l) => l.userId === viewer)).toBeUndefined();
      expect(ledger.find((l) => l.userId === invoicer)?.items).toBe(0);
      expect(ledger.find((l) => l.userId === planner)?.items).toBe(2);

      expect(await dispatcher.drain()).toBe(2);
      const me = (await db.appUser.findUniqueOrThrow({ where: { id: planner } })).email;
      const m = mail.sent.find((x) => x.to === me)!;
      expect(m.subject).toBe('สรุปแจ้งเตือนประจำวัน 18 พฤศจิกายน 2569 — TMS');
      expect(m.text).toContain('แจ้งเตือน 2 รายการใน 24 ชม. ที่ผ่านมา (ยังไม่อ่าน 1)');
      expect(m.text).toContain('ใบค้างใหม่ (1):');
      expect(m.text).toContain('อื่น ๆ (1):');
      expect(m.text).toContain('รายการ 2026-11-17T01:00:00Z');
      expect(m.text).not.toContain('รายการ 2026-11-17T00:59:59Z');
      expect(m.text).not.toContain('รายการ 2026-11-18T01:00:00Z');
      const en = mail.sent.find((x) => x.to !== me)!;
      expect(en.subject).toBe('Daily notification summary 2026-11-18 — TMS');
    });

    it('scheduleDue: ก่อน 08:00 ไม่สร้าง · ตั้งแต่ 08:00 สร้าง job tenant ละ 1 ต่อวัน (พร้อมกันได้ชุดเดียว) · worker รันแล้วส่งครั้งเดียว', async () => {
      await db.job.deleteMany({ where: { type: DAILY_DIGEST_JOB } });
      await seedInApp(planner, '2026-11-17T05:00:00Z');
      expect(await digest.scheduleDue(at('2026-11-18T00:59:00Z'))).toBe(0); // 07:59
      const made = await Promise.all(
        [1, 2, 3].map(() => digest.scheduleDue(at('2026-11-18T01:00:00Z'))),
      );
      expect(made.reduce((a, b) => a + b, 0)).toBe(2); // tenant A + B
      expect(await digest.scheduleDue(at('2026-11-18T09:00:00Z'))).toBe(0);
      clock.set(at('2026-11-18T01:05:00Z'));
      while (await queue.runOnce());
      // job ซ้ำที่หลุดเข้าคิว (เช่น สร้างมือ) ก็ไม่ส่งซ้ำ
      await dbs.withTenant(tA, (tx) =>
        queue.enqueue(tx, { tenantId: tA, type: DAILY_DIGEST_JOB, payload: { day: D } }),
      );
      while (await queue.runOnce());
      clock.set(null);
      const emails = await rows({ templateCode: 'daily.digest' });
      expect(emails.map((e) => e.recipientId)).toEqual([planner]);
      // วันถัดไปเป็นรอบใหม่
      expect(await digest.scheduleDue(at(`${addDays(D, 1)}T01:00:00Z`))).toBe(2);
    });
  });
});
