import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma, type Notification } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { Clock } from '../src/common/clock';
import { DbService } from '../src/db/db.service';
import { JobQueue } from '../src/jobs/job-queue.service';
import { EmailDispatcher } from '../src/modules/email/email.service';
import { MemoryTransport } from '../src/modules/email/transport';
import { NotificationService } from '../src/modules/notifications/notification.service';
import { renderNotification, type ExpiryDigestItem } from '../src/modules/notifications/templates';
import { dueLevel, REMINDER_THRESHOLDS } from '../src/modules/reminders/expiry-policy';
import {
  DIGEST_MAX_ITEMS,
  EXPIRY_REMINDER_JOB,
  ExpiryReminderService,
} from '../src/modules/reminders/expiry-reminder.service';
import { addDays } from '../src/modules/vehicle-documents/expiry';
import { currentDbStatus } from '../src/modules/vehicle-documents/vehicle-documents.service';
import { bootApp, createTenant, platform, truncateAll } from './helpers';

/** กติการะดับเตือน (ฟังก์ชันบริสุทธิ์) — spec/06 FLT-C เกณฑ์ตรวจรับ */
describe('เตือนต่ออายุ: ระดับที่ถึงกำหนด (ST2-T18)', () => {
  const th = REMINDER_THRESHOLDS.VEHICLE_DOCUMENT;
  it('ภาษีหมด 30 พ.ย. ตั้ง 60/30/7 → ถึงกำหนด 1 ต.ค. (60) · 31 ต.ค. (30) · 23 พ.ย. (7) · 1 ธ.ค. หมดแล้ว', () => {
    const exp = '2026-11-30';
    const lv = (d: string) =>
      dueLevel(Math.round((Date.parse(exp) - Date.parse(d)) / 86_400_000), th);
    expect(lv('2026-09-30')).toBeNull(); // 61 วัน
    expect(lv('2026-10-01')).toBe('D60');
    expect(lv('2026-10-30')).toBe('D60');
    expect(lv('2026-10-31')).toBe('D30');
    expect(lv('2026-11-22')).toBe('D30');
    expect(lv('2026-11-23')).toBe('D7');
    expect(lv('2026-11-30')).toBe('D7'); // วันหมดใช้ได้ทั้งวัน (FLT-042)
    expect(lv('2026-12-01')).toBe('EXPIRED');
    expect(lv('2026-12-30')).toBe('EXPIRED'); // หมดไป 30 วัน
    expect(lv('2026-12-31')).toBeNull(); // เลยช่วงเตือน "หมดแล้ว"
  });
  it('หมดไปเกิน 30 วัน = ไม่เตือน · rate card เริ่มที่ 30 วัน (docs/04 B NEAR_EXPIRY)', () => {
    expect(dueLevel(-30, th)).toBe('EXPIRED');
    expect(dueLevel(-31, th)).toBeNull();
    expect(dueLevel(45, REMINDER_THRESHOLDS.RATE_CARD)).toBeNull();
    expect(dueLevel(30, REMINDER_THRESHOLDS.RATE_CARD)).toBe('D30');
    expect(dueLevel(7, REMINDER_THRESHOLDS.RATE_CARD)).toBe('D7');
  });
  it('ข้อความสรุป (ไทย): หัวเรื่อง/สรุปสั้นสำหรับกระดิ่ง + รายการเป็นกลุ่มตามระดับ + "และอีก N รายการ"', () => {
    const items: ExpiryDigestItem[] = [
      {
        kind: 'VEHICLE_DOCUMENT',
        level: 'EXPIRED',
        expiresOn: '2026-11-29',
        days: -1,
        label: '70-1111',
        docType: 'COMPULSORY_ACT',
        title: null,
      },
      {
        kind: 'VEHICLE_DOCUMENT',
        level: 'D30',
        expiresOn: '2026-12-30',
        days: 30,
        label: '70-1234',
        docType: 'ANNUAL_TAX',
        title: null,
      },
      {
        kind: 'DRIVER_LICENCE',
        level: 'D7',
        expiresOn: '2026-12-07',
        days: 7,
        label: 'สมชาย ขับดี (DRV-0001)',
      },
      {
        kind: 'RATE_CARD',
        level: 'D30',
        expiresOn: '2026-12-30',
        days: 30,
        label: 'RC-S-0001 (บจก. ลูกค้า · คลัง → ร้าน)',
        side: 'SELL',
      },
    ];
    const r = renderNotification('expiry.digest', 'th', { total: 9, more: 5, items });
    expect(r.title).toBe('เอกสารรถ / ใบขับขี่ / rate card ใกล้หมดอายุ 9 รายการ');
    expect(r.body).toContain('หมดอายุแล้ว 1 · เหลือไม่เกิน 7 วัน 1 · เหลือไม่เกิน 30 วัน 2');
    const lines = r.detail!.split('\n');
    expect(lines[0]).toBe('หมดอายุแล้ว:');
    expect(lines[1]).toBe('• พ.ร.บ. ของรถ 70-1111 — หมดเมื่อ 29 พฤศจิกายน 2569');
    expect(lines).toContain('• ภาษี ของรถ 70-1234 — หมด 30 ธันวาคม 2569 (อีก 30 วัน)');
    expect(lines).toContain('• ใบขับขี่ สมชาย ขับดี (DRV-0001) — หมด 7 ธันวาคม 2569 (อีก 7 วัน)');
    expect(lines).toContain(
      '• Rate card ขาขาย RC-S-0001 (บจก. ลูกค้า · คลัง → ร้าน) — หมด 30 ธันวาคม 2569 (อีก 30 วัน)',
    );
    expect(lines.at(-1)).toBe('และอีก 5 รายการ');
  });
});

/** ST2-T18: job รายวันตั้งสถานะใกล้หมด/หมด + สรุปแจ้ง in-app/อีเมล วันละฉบับต่อผู้รับ ไม่เตือนซ้ำ */
describe('เตือนต่ออายุ: job รายวัน (ST2-T18)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let svc: ExpiryReminderService;
  let queue: JobQueue;
  let dbs: DbService;
  let clock: Clock;
  let notifications: NotificationService;
  let dispatcher: EmailDispatcher;
  let tA: string;
  let tB: string;
  let owner: string; // master:write + prices.sell:write + prices.buy:write
  let planner: string; // master:write + prices.buy:write
  let invoicer: string; // prices.sell:write
  let dispatcherUser: string; // ไม่มีสิทธิ์ที่เกี่ยว
  let ownerB: string;
  let vtA: string;
  let n = 0;

  /** วัน D เวลา 08:00 น. ไทย (01:00Z) */
  const at = (day: string) => new Date(`${day}T01:00:00Z`);
  const D0 = '2027-03-01';
  const date = (d: string) => new Date(`${d}T00:00:00Z`);

  async function member(tenantId: string, role: string) {
    const roles = await ensureSystemRoles(db, tenantId);
    const u = await db.appUser.create({
      data: {
        tenantId,
        email: `${role}-${++n}@exp.test`,
        name: `${role} ${n}`,
        status: 'ACTIVE',
        locale: 'th',
      },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles[role]! } });
    return u.id;
  }
  async function vehicleType(tenantId: string) {
    return (
      await db.vehicleType.create({
        data: { tenantId, code: `VT-${++n}`, nameTh: `6 ล้อ ${n}`, vehicleClass: '6W' },
      })
    ).id;
  }
  async function vehicle(tenantId: string, vehicleTypeId: string, plate = `70-${1000 + ++n}`) {
    return db.vehicle.create({
      data: {
        tenantId,
        plate,
        plateProvince: 'TH-10',
        plateKey: `${plate.replace(/\D/g, '')}|TH-10`,
        plateNorm: plate.replace(/\D/g, ''),
        vehicleTypeId,
        ownership: 'OWN',
      },
    });
  }
  async function doc(
    tenantId: string,
    vehicleId: string,
    expiresOn: string,
    extra: Partial<Prisma.VehicleDocumentUncheckedCreateInput> = {},
  ) {
    return db.vehicleDocument.create({
      data: {
        tenantId,
        vehicleId,
        docType: 'ANNUAL_TAX',
        startsOn: date(addDays(expiresOn, -365)),
        expiresOn: date(expiresOn),
        status: 'ACTIVE',
        ...extra,
      },
    });
  }
  async function driver(tenantId: string, licenceExpiresOn: string) {
    const i = ++n;
    return db.driver.create({
      data: {
        tenantId,
        code: `DRV-${String(i).padStart(4, '0')}`,
        name: `คนขับ ทดสอบ ${i}`,
        phone: `0810${String(i).padStart(6, '0')}`,
        phoneNorm: `0810${String(i).padStart(6, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceExpiresAt: date(licenceExpiresOn),
      },
    });
  }
  async function rateFixtures(tenantId: string) {
    const i = ++n;
    const customer = await db.customer.create({
      data: { tenantId, code: `CUS-${i}`, legalName: `บริษัท ลูกค้า ${i} จำกัด` },
    });
    const carrier = await db.carrier.create({
      data: { tenantId, code: `SUB-${i}`, legalName: `หจก. รถร่วม ${i}`, entityType: 'JURISTIC' },
    });
    const site = (name: string) =>
      db.customerSite.create({ data: { tenantId, code: `LOC-${i}-${name}`, name, address: {} } });
    const origin = await site(`คลังบางนา ${i}`);
    const dest = await site(`ร้านลาดพร้าว ${i}`);
    const svcItem = await db.serviceItem.create({
      data: {
        tenantId,
        code: `FRT-${i}`,
        nameTh: `ค่าขนส่ง ${i}`,
        vatType: 'EXEMPT_TRANSPORT',
        whtRate: new Prisma.Decimal('1.00'),
        calcUnit: 'PER_TRIP',
        unitLabel: 'เที่ยว',
      },
    });
    return { customer, carrier, origin, dest, svcItem };
  }
  async function rateCard(
    tenantId: string,
    f: Awaited<ReturnType<typeof rateFixtures>>,
    side: 'SELL' | 'BUY',
    validFrom: string,
    validTo: string,
  ) {
    return db.rateCard.create({
      data: {
        tenantId,
        side,
        code: `RC-${side[0]}-${String(++n).padStart(4, '0')}`,
        customerId: side === 'SELL' ? f.customer.id : null,
        carrierId: side === 'BUY' ? f.carrier.id : null,
        originSiteId: f.origin.id,
        destSiteId: f.dest.id,
        vehicleTypeId: vtA,
        pricingModel: 'PER_TRIP',
        unitPrice: new Prisma.Decimal('3500.00'),
        serviceItemId: f.svcItem.id,
        validFrom: date(validFrom),
        validTo: date(validTo),
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });
  }

  /** เดินเวลาไปวันนั้นแล้วให้ worker ทำงาน: scheduleDue → รัน job ที่ค้างจนหมด */
  async function runDay(day: string) {
    clock.set(at(day));
    await svc.scheduleDue();
    while (await queue.runOnce());
  }
  /** สรุปในกระดิ่ง (in-app) */
  const digests = (tenantId: string, recipientId?: string) =>
    db.notification.findMany({
      where: {
        tenantId,
        channel: 'in_app',
        templateCode: 'expiry.digest',
        ...(recipientId ? { recipientId } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const items = (x: Notification) => (x.payload as unknown as { items: ExpiryDigestItem[] }).items;
  const allItems = (xs: Notification[]) => xs.flatMap(items);

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    svc = app.get(ExpiryReminderService);
    queue = app.get(JobQueue);
    dbs = app.get(DbService);
    clock = app.get(Clock);
    notifications = app.get(NotificationService);
    dispatcher = app.get(EmailDispatcher);
    tA = (await createTenant(db, 'บริษัท เตือน เอ จำกัด')).id;
    tB = (await createTenant(db, 'บริษัท เตือน บี จำกัด')).id;
    owner = await member(tA, 'owner');
    planner = await member(tA, 'planner');
    invoicer = await member(tA, 'invoicer');
    dispatcherUser = await member(tA, 'dispatcher');
    ownerB = await member(tB, 'owner');
    vtA = await vehicleType(tA);
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.notification.deleteMany({});
    await db.emailOutbox.deleteMany({});
    await db.expiryReminder.deleteMany({});
    await db.job.deleteMany({});
    await db.vehicleDocument.deleteMany({});
    await db.rateCard.deleteMany({});
    await db.driver.deleteMany({});
  });
  afterAll(async () => {
    clock.set(null);
    await app.close();
    await db.$disconnect();
  });

  it('เกณฑ์ตรวจรับ (เลื่อนเวลา): เอกสารหมดใน 30 วัน → เตือนครั้งเดียวที่จุด 30 วัน; รันซ้ำวันเดียวกัน/วันถัดไปก่อนถึง 7 วัน = ไม่ส่งเพิ่ม', async () => {
    const v = await vehicle(tA, vtA, '70-3030');
    const d = await doc(tA, v.id, addDays(D0, 30));

    await runDay(D0);
    await runDay(D0); // รันซ้ำวันเดียวกัน
    await svc.scheduleDue(at(D0)); // worker เรียกซ้ำทุก 10 นาที — job ของวันนี้มีแล้ว ไม่สร้างใหม่
    expect(await db.job.count({ where: { tenantId: tA, type: EXPIRY_REMINDER_JOB } })).toBe(1);
    let rows = await digests(tA);
    // ผู้รับ = role ที่แก้ข้อมูลหลักได้ (owner, planner) คนละ 1 สรุป — dispatcher/invoicer ไม่ได้
    expect(rows.map((r) => r.recipientId).sort()).toEqual([owner, planner].sort());
    expect(rows.every((r) => items(r).length === 1 && items(r)[0]!.level === 'D30')).toBe(true);
    expect(items(rows[0]!)[0]!.label).toBe('70-3030');
    expect(rows[0]!.title).toBe('เอกสารรถ ใกล้หมดอายุ 1 รายการ');
    expect(rows[0]!.link).toBe('/fleet/documents');
    // อีเมลสรุปคนละ 1 ฉบับ (outbox — test ไม่ส่งจริง) มีรายการเต็ม
    expect(await db.notification.count({ where: { tenantId: tA, channel: 'email' } })).toBe(2);
    const mails = await db.emailOutbox.findMany({ where: { tenantId: tA } });
    expect(mails).toHaveLength(2);
    expect(mails[0]!.textBody).toContain('• ภาษี ของรถ 70-3030');
    // สมุดเตือน 1 แถวต่อผู้รับ
    const ledger = await db.expiryReminder.findMany({ where: { entityId: d.id } });
    expect(ledger.map((l) => [l.level, l.recipientId]).sort()).toEqual(
      [
        ['D30', owner],
        ['D30', planner],
      ].sort(),
    );

    // วันถัดไปจนเหลือ 8 วัน — ไม่มีอะไรเพิ่ม
    for (let i = 1; i <= 22; i++) await runDay(addDays(D0, i));
    expect(await digests(tA)).toHaveLength(2);

    // เหลือ 7 วัน → ระดับถัดไปครั้งเดียว
    await runDay(addDays(D0, 23));
    await runDay(addDays(D0, 23));
    await runDay(addDays(D0, 24));
    rows = await digests(tA);
    expect(rows).toHaveLength(4);
    expect(rows.slice(2).every((r) => items(r)[0]!.level === 'D7')).toBe(true);
  }, 240_000);

  it('เดินเวลาครบรอบบนเอกสารเดียว: 61 → 60 → 30 → 7 → หมดแล้ว = 4 สรุปพอดี + สถานะในฐานตามวัน', async () => {
    const v = await vehicle(tA, vtA);
    const exp = addDays(D0, 61);
    const d = await doc(tA, v.id, exp);
    const statuses = new Set<string>();
    for (let i = 0; i <= 64; i++) {
      await runDay(addDays(D0, i));
      const s = (await db.vehicleDocument.findUniqueOrThrow({ where: { id: d.id } })).status;
      expect(s).toBe(currentDbStatus(exp, addDays(D0, i)));
      statuses.add(s);
    }
    expect([...statuses]).toEqual(['ACTIVE', 'EXPIRING', 'EXPIRED']);
    const rows = await digests(tA, owner);
    expect(rows.map((r) => items(r)[0]!.level)).toEqual(['D60', 'D30', 'D7', 'EXPIRED']);
    // วันที่ส่ง: เหลือ 60 (D0+1), 30 (D0+31), 7 (D0+54), วันถัดจากวันหมด (D0+62)
    const sent = await db.expiryReminder.findMany({
      where: { entityId: d.id, recipientId: owner },
      orderBy: { sentOn: 'asc' },
    });
    expect(sent.map((s) => s.sentOn.toISOString().slice(0, 10))).toEqual([
      addDays(D0, 1),
      addDays(D0, 31),
      addDays(D0, 54),
      addDays(D0, 62),
    ]);
    expect(rows[3]!.body).toContain('หมดอายุแล้ว 1');
  }, 240_000);

  it('สรุปฉบับเดียวต่อผู้รับมีครบทุกรายการ: 25 รายการ → in-app 1 + อีเมล 1 ต่อคน แสดง 20 + "และอีก 5 รายการ"', async () => {
    for (let i = 0; i < 24; i++) {
      const v = await vehicle(tA, vtA);
      await doc(tA, v.id, addDays(D0, 30 - (i % 20)));
    }
    const drv = await driver(tA, addDays(D0, 1));
    await runDay(D0);
    const rows = await digests(tA, owner);
    expect(rows).toHaveLength(1);
    const p = rows[0]!.payload as unknown as {
      total: number;
      more: number;
      items: ExpiryDigestItem[];
    };
    expect(p.total).toBe(25);
    expect(p.more).toBe(25 - DIGEST_MAX_ITEMS);
    expect(p.items).toHaveLength(DIGEST_MAX_ITEMS);
    expect(p.items[0]!.kind).toBe('DRIVER_LICENCE'); // ด่วนสุดก่อน (เหลือ 1 วัน)
    expect(rows[0]!.title).toBe('ใบขับขี่ / เอกสารรถ ใกล้หมดอายุ 25 รายการ');
    expect(
      await db.emailOutbox.count({ where: { tenantId: tA, toAddress: { startsWith: 'owner-' } } }),
    ).toBe(1);
    const mail = await db.emailOutbox.findFirstOrThrow({
      where: { tenantId: tA, toAddress: { startsWith: 'owner-' } },
    });
    expect(mail.textBody).toContain('และอีก 5 รายการ');
    expect(mail.htmlBody).toContain('<p style="margin:0 0 12px">และอีก 5 รายการ</p>');
    // สมุดเตือนจองครบ 25 รายการต่อผู้รับ (รายการที่ไม่ได้แสดงก็ไม่เตือนซ้ำวันพรุ่งนี้)
    expect(await db.expiryReminder.count({ where: { recipientId: owner } })).toBe(25);
    expect(await db.expiryReminder.count({ where: { entityId: drv.id } })).toBe(2);
    await runDay(addDays(D0, 1));
    expect(await digests(tA, owner)).toHaveLength(1);
  });

  it('ตั้งสถานะเอกสารรถในฐานให้ตรงวันหมด (helper ของ T17) — ฉบับที่ถูกแทน/ยกเลิกไม่แตะ', async () => {
    const v = await vehicle(tA, vtA);
    const far = await doc(tA, v.id, addDays(D0, 61), { status: 'EXPIRING' });
    const near = await doc(tA, v.id, addDays(D0, 60), { docType: 'INSURANCE' });
    const gone = await doc(tA, v.id, addDays(D0, -1), { docType: 'INSPECTION' });
    const sup = await doc(tA, v.id, addDays(D0, -1), {
      docType: 'COMPULSORY_ACT',
      status: 'SUPERSEDED',
    });
    await runDay(D0);
    for (const x of [far, near, gone]) {
      const s = (await db.vehicleDocument.findUniqueOrThrow({ where: { id: x.id } })).status;
      expect(s).toBe(currentDbStatus(x.expiresOn.toISOString().slice(0, 10), D0));
    }
    expect((await db.vehicleDocument.findUniqueOrThrow({ where: { id: far.id } })).status).toBe(
      'ACTIVE',
    );
    expect((await db.vehicleDocument.findUniqueOrThrow({ where: { id: near.id } })).status).toBe(
      'EXPIRING',
    );
    expect((await db.vehicleDocument.findUniqueOrThrow({ where: { id: sup.id } })).status).toBe(
      'SUPERSEDED',
    );
    const levels = await db.expiryReminder.findMany({
      where: { recipientId: owner },
      select: { entityId: true, level: true },
    });
    expect(levels).toHaveLength(2);
    expect(levels).toEqual(
      expect.arrayContaining([
        { entityId: near.id, level: 'D60' },
        { entityId: gone.id, level: 'EXPIRED' },
      ]),
    );
  });

  it('ต่ออายุแล้วเริ่มรอบใหม่: เอกสารรถฉบับใหม่ (ฉบับเดิม SUPERSEDED) · ใบขับขี่เปลี่ยนวันหมด', async () => {
    const v = await vehicle(tA, vtA);
    const old = await doc(tA, v.id, addDays(D0, 30));
    const drv = await driver(tA, addDays(D0, 30));
    await runDay(D0);
    const mine = () => db.expiryReminder.count({ where: { recipientId: owner } });
    expect(await mine()).toBe(2);

    await db.vehicleDocument.update({ where: { id: old.id }, data: { status: 'SUPERSEDED' } });
    const renewed = await doc(tA, v.id, addDays(D0, 365), { renewsId: old.id });
    await db.driver.update({
      where: { id: drv.id },
      data: { licenceExpiresAt: date(addDays(D0, 30 + 5 * 365)) },
    });
    await runDay(addDays(D0, 23)); // จุด 7 วันของวันหมดเดิม — ไม่เตือนแล้ว
    expect(await mine()).toBe(2);

    await runDay(addDays(D0, 365 - 60)); // ฉบับใหม่ถึง 60 วัน → รอบใหม่
    const fresh = await db.expiryReminder.findMany({
      where: { entityId: renewed.id, recipientId: owner },
    });
    expect(fresh.map((f) => f.level)).toEqual(['D60']);

    // แก้วันหมดใบขับขี่กลับเป็นค่าเดิม (แก้ผิด) = key เดิม → ไม่ส่งซ้ำระดับที่ส่งไปแล้ว
    await db.driver.update({
      where: { id: drv.id },
      data: { licenceExpiresAt: date(addDays(D0, 30)) },
    });
    await runDay(addDays(D0, 1));
    expect(await db.expiryReminder.count({ where: { entityId: drv.id, recipientId: owner } })).toBe(
      1,
    );
  });

  it('ใบขับขี่: ถึง role ที่แก้ข้อมูลหลักได้ · คนขับที่ปิดใช้งาน/ลบแล้วไม่เตือน', async () => {
    const a = await driver(tA, addDays(D0, 7));
    const off = await driver(tA, addDays(D0, 7));
    await db.driver.update({ where: { id: off.id }, data: { status: 'INACTIVE' } });
    const del = await driver(tA, addDays(D0, 7));
    await db.driver.update({ where: { id: del.id }, data: { deletedAt: new Date() } });
    await runDay(D0);
    const rows = await digests(tA);
    expect(rows.map((r) => r.recipientId).sort()).toEqual([owner, planner].sort());
    expect(allItems(rows).map((i) => i.label)).toEqual([
      `${a.name} (${a.code})`,
      `${a.name} (${a.code})`,
    ]);
    expect(rows[0]!.link).toBe('/fleet/drivers');
    expect(rows[0]!.title).toBe('ใบขับขี่ ใกล้หมดอายุ 1 รายการ');
  });

  it('rate card: ขาขายถึงผู้แก้ราคาขาย ขาซื้อถึงผู้แก้ราคาซื้อ · มี rate อนุมัติต่อเนื่องแล้ว = ไม่เตือน · มีช่องว่าง/45 วัน', async () => {
    const f = await rateFixtures(tA);
    const sell = await rateCard(tA, f, 'SELL', addDays(D0, -300), addDays(D0, 30));
    const buy = await rateCard(tA, f, 'BUY', addDays(D0, -300), addDays(D0, 30));
    const f2 = await rateFixtures(tA);
    const renewedOld = await rateCard(tA, f2, 'SELL', addDays(D0, -300), addDays(D0, 10));
    await rateCard(tA, f2, 'SELL', addDays(D0, 11), addDays(D0, 400)); // ต่อเนื่องพอดี
    const f3 = await rateFixtures(tA);
    const gap = await rateCard(tA, f3, 'SELL', addDays(D0, -300), addDays(D0, 10));
    await rateCard(tA, f3, 'SELL', addDays(D0, 15), addDays(D0, 400)); // ขาดช่วง 4 วัน → ยังเตือน
    const f4 = await rateFixtures(tA);
    await rateCard(tA, f4, 'SELL', addDays(D0, -300), addDays(D0, 45));
    await runDay(D0);
    const ids = async (u: string) =>
      (await db.expiryReminder.findMany({ where: { recipientId: u } }))
        .map((r) => r.entityId)
        .sort();
    expect(await ids(owner)).toEqual([sell.id, buy.id, gap.id].sort());
    expect(await ids(invoicer)).toEqual([sell.id, gap.id].sort());
    expect(await ids(planner)).toEqual([buy.id]);
    expect(await ids(dispatcherUser)).toEqual([]);
    expect(await db.expiryReminder.count({ where: { entityId: renewedOld.id } })).toBe(0);
    const inv = (await digests(tA, invoicer))[0]!;
    expect(inv.link).toBe('/master/rate-cards');
    expect(items(inv).every((i) => i.side === 'SELL')).toBe(true);
    expect(
      items(inv)
        .map((i) => i.label)
        .join(),
    ).toMatch(/คลังบางนา \d+ → ร้านลาดพร้าว \d+/);
    expect(JSON.stringify(inv.payload)).not.toMatch(/3,?500/); // ไม่มีราคา
    const pl = (await digests(tA, planner))[0]!;
    expect(pl.link).toBe('/master/rate-cards?side=buy');
  });

  it('สอง worker พร้อมกัน → เตือนครั้งเดียว (รันพร้อมกัน 3 ชุด + job ซ้ำในคิว + scheduleDue พร้อมกัน)', async () => {
    const v = await vehicle(tA, vtA);
    const d = await doc(tA, v.id, addDays(D0, 7));
    const drv = await driver(tA, addDays(D0, 30));
    const results = await Promise.all([1, 2, 3].map(() => svc.runForTenant(tA, D0)));
    expect(results.reduce((s, r) => s + r.reminders, 0)).toBe(4); // 2 รายการ × 2 ผู้รับ
    expect(results.reduce((s, r) => s + r.digests, 0)).toBe(2);
    expect(await db.expiryReminder.count({ where: { entityId: { in: [d.id, drv.id] } } })).toBe(4);
    expect(await digests(tA)).toHaveLength(2);
    // job ซ้ำในคิวก็ไม่ส่งซ้ำ
    clock.set(at(D0));
    for (let i = 0; i < 2; i++)
      await dbs.withTenant(tA, (tx) =>
        queue.enqueue(tx, { tenantId: tA, type: EXPIRY_REMINDER_JOB, payload: { day: D0 } }),
      );
    while (await queue.runOnce());
    expect(await digests(tA)).toHaveLength(2);
    // scheduleDue พร้อมกันหลายตัว (advisory lock) → job ของวันพรุ่งนี้ tenant ละ 1
    await db.job.deleteMany({});
    const made = await Promise.all([1, 2, 3, 4].map(() => svc.scheduleDue(at(addDays(D0, 1)))));
    expect(made.reduce((s, x) => s + x, 0)).toBe(2);
    expect(await db.job.count({ where: { tenantId: tA } })).toBe(1);
  });

  it('รายการที่ล้มไม่ขวางรายการอื่น และรอบหน้าส่งให้', async () => {
    const v1 = await vehicle(tA, vtA, '70-0001');
    const v2 = await vehicle(tA, vtA, '70-0002');
    const bad = await doc(tA, v1.id, addDays(D0, 30));
    const good = await doc(tA, v2.id, addDays(D0, 30));
    const real = svc.vehicleDocCandidate.bind(svc);
    const spy = vi.spyOn(svc, 'vehicleDocCandidate').mockImplementation((d, today) => {
      if (d.id === bad.id) throw new Error('ข้อมูลเสีย');
      return real(d, today);
    });
    const r = await svc.runForTenant(tA, D0);
    expect(r.failedItems).toBe(1);
    expect(allItems(await digests(tA, owner)).map((i) => i.label)).toEqual(['70-0002']);
    expect(await db.expiryReminder.count({ where: { entityId: good.id } })).toBe(2);
    spy.mockRestore();
    await svc.runForTenant(tA, addDays(D0, 1));
    expect(allItems(await digests(tA, owner)).map((i) => i.label)).toEqual(['70-0002', '70-0001']);
  });

  it('ผู้รับคนหนึ่งล้ม (แจ้งไม่สำเร็จ) ไม่กระทบคนอื่น — การจองของคนนั้น rollback แล้วรอบหน้าได้รับ', async () => {
    const v = await vehicle(tA, vtA);
    const d = await doc(tA, v.id, addDays(D0, 30));
    const real = notifications.notify.bind(notifications);
    const spy = vi.spyOn(notifications, 'notify').mockImplementation(async (tx, input) => {
      if (input.to.userIds?.includes(planner)) throw new Error('smtp outbox down');
      return real(tx, input);
    });
    const r = await svc.runForTenant(tA, D0);
    expect(r).toMatchObject({ digests: 1, failedRecipients: 1 });
    expect((await digests(tA)).map((x) => x.recipientId)).toEqual([owner]);
    expect(await db.expiryReminder.count({ where: { entityId: d.id, recipientId: planner } })).toBe(
      0,
    );
    spy.mockRestore();
    await svc.runForTenant(tA, addDays(D0, 1));
    expect((await digests(tA)).map((x) => x.recipientId).sort()).toEqual([owner, planner].sort());
    expect(await digests(tA, owner)).toHaveLength(1);
  });

  it('ผู้รับเกิน 500 คน (เพดานของ notify) → ทุกคนได้สรุป ไม่ล้ม', async () => {
    const tC = (await createTenant(db, 'บริษัท ผู้ใช้เยอะ จำกัด')).id;
    const roles = await ensureSystemRoles(db, tC);
    const users = Array.from({ length: 501 }, (_, i) => ({
      tenantId: tC,
      email: `bulk-${i}@exp.test`,
      name: `ผู้วางแผน ${i}`,
      status: 'ACTIVE' as const,
      locale: 'th',
    }));
    await db.appUser.createMany({ data: users });
    const ids = await db.appUser.findMany({ where: { tenantId: tC }, select: { id: true } });
    await db.userRole.createMany({
      data: ids.map((u) => ({ tenantId: tC, userId: u.id, roleId: roles.planner! })),
    });
    const vt = await vehicleType(tC);
    const v = await vehicle(tC, vt);
    await doc(tC, v.id, addDays(D0, 7));
    const r = await svc.runForTenant(tC, D0);
    expect(r).toMatchObject({ digests: 501, failedRecipients: 0 });
    expect(await db.notification.count({ where: { tenantId: tC, channel: 'in_app' } })).toBe(501);
    expect(await db.emailOutbox.count({ where: { tenantId: tC } })).toBe(501);
    await db.tenant.update({ where: { id: tC }, data: { status: 'SUSPENDED' } });
  }, 180_000);

  it('อีเมลยืนยันตัวตน (ลืมรหัสผ่าน) ไม่ต้องรอคิวสรุปเตือน', async () => {
    for (let i = 0; i < 3; i++) {
      const v = await vehicle(tA, vtA);
      await doc(tA, v.id, addDays(D0, 30));
    }
    await svc.runForTenant(tA, D0);
    expect(await db.emailOutbox.count({ where: { template: 'notification' } })).toBe(2);
    await db.emailOutbox.create({
      data: {
        toAddress: 'reset@exp.test',
        template: 'password_reset',
        locale: 'th',
        subject: 'ตั้งรหัสผ่านใหม่',
        textBody: 't',
        htmlBody: 'h',
      },
    });
    const mail = new MemoryTransport();
    dispatcher.use(mail);
    await dispatcher.runOnce();
    expect(mail.sent.map((m) => m.to)).toEqual(['reset@exp.test']);
    await dispatcher.drain();
    expect(mail.sent).toHaveLength(3);
  });

  it('แยก tenant: สมุดเตือน/แจ้งเตือนของ tenant อื่นมองไม่เห็นและไม่ส่งข้าม', async () => {
    const vtB = await vehicleType(tB);
    const vB = await vehicle(tB, vtB);
    const dB = await doc(tB, vB.id, addDays(D0, 30));
    const vA = await vehicle(tA, vtA);
    const dA = await doc(tA, vA.id, addDays(D0, 30));
    await runDay(D0);
    const seenA = await dbs.withTenant(tA, (tx) => tx.expiryReminder.findMany());
    expect(new Set(seenA.map((r) => r.entityId))).toEqual(new Set([dA.id]));
    const seenB = await dbs.withTenant(tB, (tx) => tx.expiryReminder.findMany());
    expect(seenB.map((r) => [r.entityId, r.recipientId])).toEqual([[dB.id, ownerB]]);
    await expect(
      dbs.withTenant(tA, (tx) =>
        tx.expiryReminder.create({
          data: {
            tenantId: tB,
            entityType: 'VEHICLE_DOCUMENT',
            entityId: dB.id,
            level: 'D7',
            expiresOn: date(D0),
            recipientId: ownerB,
            sentOn: date(D0),
          },
        }),
      ),
    ).rejects.toThrow();
    const rowsB = await digests(tB);
    expect(rowsB.map((r) => r.recipientId)).toEqual([ownerB]);
    expect(allItems(rowsB).map((i) => i.label)).toEqual([vB.plate]);
    expect((await digests(tA)).some((r) => r.recipientId === ownerB)).toBe(false);
  });

  it('ตารางเวลา: ก่อน 08:00 เวลาไทยไม่สร้าง job · tenant ที่ถูกระงับข้าม · วันใหม่สร้าง job ใหม่', async () => {
    const tS = (await createTenant(db, 'บริษัท ระงับ จำกัด')).id;
    await db.tenant.update({ where: { id: tS }, data: { status: 'SUSPENDED' } });
    expect(await svc.scheduleDue(new Date(`${D0}T00:59:00Z`))).toBe(0); // 07:59 น.
    expect(await svc.scheduleDue(new Date(`${D0}T01:00:00Z`))).toBe(2); // 08:00 น. — A, B
    expect(await svc.scheduleDue(new Date(`${D0}T05:00:00Z`))).toBe(0);
    const jobs = await db.job.findMany({ where: { type: EXPIRY_REMINDER_JOB } });
    expect(jobs.map((j) => j.tenantId).sort()).toEqual([tA, tB].sort());
    expect(jobs.every((j) => (j.payload as { day: string }).day === D0)).toBe(true);
    expect(await svc.scheduleDue(new Date(`${addDays(D0, 1)}T01:00:00Z`))).toBe(2);
    await db.tenant.delete({ where: { id: tS } });
  });

  it('รถที่ปลดแล้วไม่เตือน · หมดไปเกิน 30 วันไม่เตือน "หมดแล้ว"', async () => {
    const retired = await vehicle(tA, vtA);
    await db.vehicle.update({
      where: { id: retired.id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
    await doc(tA, retired.id, addDays(D0, 7));
    const v = await vehicle(tA, vtA);
    await doc(tA, v.id, addDays(D0, -31));
    await runDay(D0);
    expect(await db.expiryReminder.count()).toBe(0);
    expect(await digests(tA)).toHaveLength(0);
  });

  it('tenant ถูกระงับหลังสร้าง job ของวันนั้นแล้ว → job ข้าม ไม่ได้เตือน', async () => {
    const v = await vehicle(tA, vtA);
    await doc(tA, v.id, addDays(D0, 7));
    clock.set(at(D0));
    expect(await svc.scheduleDue()).toBe(2);
    await db.tenant.update({ where: { id: tA }, data: { status: 'SUSPENDED' } });
    try {
      while (await queue.runOnce());
      const job = await db.job.findFirstOrThrow({
        where: { tenantId: tA, type: EXPIRY_REMINDER_JOB },
      });
      expect(job.status).toBe('SUCCEEDED');
      expect(job.result).toMatchObject({ skipped: 'tenant_inactive' });
      expect(await db.expiryReminder.count({ where: { tenantId: tA } })).toBe(0);
      expect(await digests(tA)).toHaveLength(0);
    } finally {
      await db.tenant.update({ where: { id: tA }, data: { status: 'ACTIVE' } });
    }
  });

  it('รถที่ลบแล้ว (soft delete) ไม่เตือน', async () => {
    const v = await vehicle(tA, vtA);
    await doc(tA, v.id, addDays(D0, 7));
    await db.vehicle.update({ where: { id: v.id }, data: { deletedAt: new Date() } });
    await runDay(D0);
    expect(await db.expiryReminder.count()).toBe(0);
  });

  it('Clock.set ใช้ได้เฉพาะนอก production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new Clock().set(new Date())).toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
