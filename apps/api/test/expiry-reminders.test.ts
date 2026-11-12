import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { Clock } from '../src/common/clock';
import { DbService } from '../src/db/db.service';
import { JobQueue } from '../src/jobs/job-queue.service';
import { renderNotification } from '../src/modules/notifications/templates';
import { dueLevel, REMINDER_THRESHOLDS } from '../src/modules/reminders/expiry-policy';
import {
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
  it('ข้อความไทย: วันที่ พ.ศ. + จำนวนวันที่เหลือ', () => {
    const r = renderNotification('expiry.vehicle_document', 'th', {
      level: 'D30',
      expiresOn: '2026-11-30',
      days: 30,
      plate: '70-1234',
      docType: 'ANNUAL_TAX',
      title: null,
    });
    expect(r.title).toBe('เอกสารรถใกล้หมดอายุ');
    expect(r.body).toContain('ภาษี ของรถ 70-1234 จะหมดอายุ 30 พฤศจิกายน 2569 (อีก 30 วัน)');
    const x = renderNotification('expiry.driver_licence', 'th', {
      level: 'EXPIRED',
      expiresOn: '2026-11-30',
      days: -1,
      name: 'สมชาย ขับดี',
      code: 'DRV-0001',
    });
    expect(x.title).toBe('ใบขับขี่หมดอายุแล้ว');
    expect(x.body).toContain('หมดอายุแล้วเมื่อ 30 พฤศจิกายน 2569');
  });
});

/** ST2-T18: job รายวันตั้งสถานะใกล้หมด/หมด + แจ้ง in-app/อีเมล ไม่เตือนซ้ำ */
describe('เตือนต่ออายุ: job รายวัน (ST2-T18)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let svc: ExpiryReminderService;
  let queue: JobQueue;
  let dbs: DbService;
  let clock: Clock;
  let tA: string;
  let tB: string;
  let owner: string; // master:write + prices.sell:write + prices.buy:write
  let planner: string; // master:write + prices.buy:write
  let invoicer: string; // prices.sell:write
  let dispatcher: string; // ไม่มีสิทธิ์ที่เกี่ยว
  let ownerB: string;
  let vtA: string;
  let n = 0;

  /** วัน D เวลา 07:00 น. ไทย (00:00Z) */
  const at = (day: string) => new Date(`${day}T00:00:00Z`);
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
        phone: `08100000${String(i).padStart(2, '0')}`,
        phoneNorm: `08100000${String(i).padStart(2, '0')}`,
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
      db.customerSite.create({
        data: { tenantId, code: `LOC-${i}-${name}`, name, address: {} },
      });
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
    code = `RC-${side[0]}-${String(++n).padStart(4, '0')}`,
  ) {
    return db.rateCard.create({
      data: {
        tenantId,
        side,
        code,
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
  const inApp = (tenantId: string, entityId?: string) =>
    db.notification.findMany({
      where: {
        tenantId,
        channel: 'in_app',
        templateCode: { startsWith: 'expiry.' },
        ...(entityId ? { relatedEntityId: entityId } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  const enc = async (prefix: string, id: string) =>
    (await import('../src/common/ids')).encodeId(prefix as never, id);

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    svc = app.get(ExpiryReminderService);
    queue = app.get(JobQueue);
    dbs = app.get(DbService);
    clock = app.get(Clock);
    tA = (await createTenant(db, 'บริษัท เตือน เอ จำกัด')).id;
    tB = (await createTenant(db, 'บริษัท เตือน บี จำกัด')).id;
    owner = await member(tA, 'owner');
    planner = await member(tA, 'planner');
    invoicer = await member(tA, 'invoicer');
    dispatcher = await member(tA, 'dispatcher');
    ownerB = await member(tB, 'owner');
    vtA = await vehicleType(tA);
  });
  beforeEach(async () => {
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
    const id = await enc('vehicleDocument', d.id);

    await runDay(D0);
    await runDay(D0); // รันซ้ำวันเดียวกัน
    await svc.scheduleDue(at(D0)); // worker เรียกซ้ำทุก 10 นาที — job ของวันนี้มีแล้ว ไม่สร้างใหม่
    expect(await db.job.count({ where: { tenantId: tA, type: EXPIRY_REMINDER_JOB } })).toBe(1);
    let rows = await inApp(tA, id);
    // ผู้รับ = role ที่แก้ข้อมูลหลักได้ (owner, planner) — dispatcher/invoicer ไม่ได้
    expect(rows.map((r) => r.recipientId).sort()).toEqual([owner, planner].sort());
    expect(rows.every((r) => (r.payload as { level: string }).level === 'D30')).toBe(true);
    expect(rows[0]!.title).toBe('เอกสารรถใกล้หมดอายุ');
    expect(rows[0]!.body).toContain('70-3030');
    expect(rows[0]!.link).toBe('/fleet/documents');
    // อีเมลเข้าคิว outbox (ทดสอบไม่ส่งจริง) คนละ 1 ฉบับ
    const mails = await db.notification.findMany({
      where: { tenantId: tA, channel: 'email', relatedEntityId: id },
    });
    expect(mails).toHaveLength(2);
    expect(await db.emailOutbox.count({ where: { tenantId: tA } })).toBe(2);
    // สมุดเตือน 1 แถว
    const ledger = await db.expiryReminder.findMany({ where: { entityId: d.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      level: 'D30',
      recipients: 2,
      entityType: 'VEHICLE_DOCUMENT',
    });

    // วันถัดไปจนเหลือ 8 วัน — ไม่มีอะไรเพิ่ม
    for (let i = 1; i <= 22; i++) await runDay(addDays(D0, i));
    rows = await inApp(tA, id);
    expect(rows).toHaveLength(2);

    // เหลือ 7 วัน → ระดับถัดไปครั้งเดียว
    await runDay(addDays(D0, 23));
    await runDay(addDays(D0, 23));
    await runDay(addDays(D0, 24));
    rows = await inApp(tA, id);
    expect(rows).toHaveLength(4);
    expect(rows.slice(2).every((r) => (r.payload as { level: string }).level === 'D7')).toBe(true);

    // หมดแล้ว (วันถัดจากวันหมด) → "หมดอายุแล้ว" ครั้งเดียว + สถานะในฐาน EXPIRED
    await runDay(addDays(D0, 30));
    expect(await inApp(tA, id)).toHaveLength(4); // วันหมดยังใช้ได้ทั้งวัน
    await runDay(addDays(D0, 31));
    await runDay(addDays(D0, 32));
    rows = await inApp(tA, id);
    expect(rows).toHaveLength(6);
    expect(rows[5]!.title).toBe('เอกสารรถหมดอายุแล้ว');
    expect((await db.vehicleDocument.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(
      'EXPIRED',
    );
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
    // ฉบับที่ถูกแทนไม่เตือน · เพิ่งหมด (เมื่อวาน) เตือน "หมดแล้ว" · เหลือ 60 วัน เตือน D60
    const levels = await db.expiryReminder.findMany({ select: { entityId: true, level: true } });
    expect(levels).toEqual(
      expect.arrayContaining([
        { entityId: near.id, level: 'D60' },
        { entityId: gone.id, level: 'EXPIRED' },
      ]),
    );
    expect(levels).toHaveLength(2);
  });

  it('ต่ออายุแล้วเริ่มรอบใหม่: เอกสารรถฉบับใหม่ (ฉบับเดิม SUPERSEDED) · ใบขับขี่เปลี่ยนวันหมด', async () => {
    const v = await vehicle(tA, vtA);
    const old = await doc(tA, v.id, addDays(D0, 30));
    const drv = await driver(tA, addDays(D0, 30));
    await runDay(D0);
    expect(await db.expiryReminder.count()).toBe(2);

    // ต่ออายุเอกสารรถ (ตามที่ T17 ทำ): ฉบับเดิม SUPERSEDED + ฉบับใหม่หมดอีก 1 ปี
    await db.vehicleDocument.update({ where: { id: old.id }, data: { status: 'SUPERSEDED' } });
    const renewed = await doc(tA, v.id, addDays(D0, 365), { renewsId: old.id });
    // ใบขับขี่: อัปเดตวันหมดเป็นใบใหม่
    await db.driver.update({
      where: { id: drv.id },
      data: { licenceExpiresAt: date(addDays(D0, 30 + 5 * 365)) },
    });
    await runDay(addDays(D0, 23)); // จุด 7 วันของวันหมดเดิม — ไม่เตือนแล้ว
    expect(await db.expiryReminder.count()).toBe(2);

    // ปีถัดไป: ฉบับใหม่ถึง 60 วัน → เตือนรอบใหม่
    await runDay(addDays(D0, 365 - 60));
    const fresh = await db.expiryReminder.findMany({ where: { entityId: renewed.id } });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.level).toBe('D60');

    // ใบขับขี่เปลี่ยนวันหมดแล้วเปลี่ยนกลับ (แก้ผิด) = key เดิม → ไม่ส่งซ้ำระดับที่ส่งไปแล้ว
    await db.driver.update({
      where: { id: drv.id },
      data: { licenceExpiresAt: date(addDays(D0, 30)) },
    });
    await runDay(addDays(D0, 1));
    expect(await db.expiryReminder.count({ where: { entityId: drv.id } })).toBe(1);
  });

  it('ใบขับขี่: เตือน 60/30/7 ถึง role ที่แก้ข้อมูลหลักได้ · คนขับที่ปิดใช้งาน/ลบแล้วไม่เตือน', async () => {
    const a = await driver(tA, addDays(D0, 7));
    const off = await driver(tA, addDays(D0, 7));
    await db.driver.update({ where: { id: off.id }, data: { status: 'INACTIVE' } });
    const del = await driver(tA, addDays(D0, 7));
    await db.driver.update({ where: { id: del.id }, data: { deletedAt: new Date() } });
    await runDay(D0);
    const rows = await inApp(tA);
    expect(rows.map((r) => r.relatedEntityId)).toEqual([
      await enc('driver', a.id),
      await enc('driver', a.id),
    ]);
    expect(rows.map((r) => r.recipientId).sort()).toEqual([owner, planner].sort());
    expect(rows[0]!.title).toBe('ใบขับขี่ใกล้หมดอายุ');
    expect(rows[0]!.body).toContain('อีก 7 วัน');
  });

  it('rate card: ขาขายถึงผู้แก้ราคาขาย ขาซื้อถึงผู้แก้ราคาซื้อ · มีราคาช่วงถัดไปแล้ว = ไม่เตือน · 45 วันยังไม่เตือน', async () => {
    const f = await rateFixtures(tA);
    const sell = await rateCard(tA, f, 'SELL', addDays(D0, -300), addDays(D0, 30));
    const buy = await rateCard(tA, f, 'BUY', addDays(D0, -300), addDays(D0, 30));
    const f2 = await rateFixtures(tA);
    const renewedOld = await rateCard(tA, f2, 'SELL', addDays(D0, -300), addDays(D0, 10));
    await rateCard(tA, f2, 'SELL', addDays(D0, 11), addDays(D0, 400));
    const f3 = await rateFixtures(tA);
    const later = await rateCard(tA, f3, 'SELL', addDays(D0, -300), addDays(D0, 45));
    await runDay(D0);
    const rows = await inApp(tA);
    const by = (id: string) => rows.filter((r) => r.relatedEntityId === id);
    const sellRows = by(await enc('rateCard', sell.id));
    expect(sellRows.map((r) => r.recipientId).sort()).toEqual([owner, invoicer].sort());
    expect(sellRows[0]!.body).toContain('ขาขาย');
    expect(sellRows[0]!.body).toMatch(/คลังบางนา \d+ → ร้านลาดพร้าว \d+/);
    expect(sellRows[0]!.body).not.toMatch(/3,?500/); // ไม่มีราคาในข้อความ
    const buyRows = by(await enc('rateCard', buy.id));
    expect(buyRows.map((r) => r.recipientId).sort()).toEqual([owner, planner].sort());
    expect(buyRows[0]!.link).toBe('/master/rate-cards?side=buy');
    expect(by(await enc('rateCard', renewedOld.id))).toHaveLength(0);
    expect(by(await enc('rateCard', later.id))).toHaveLength(0);
    expect(rows.some((r) => r.recipientId === dispatcher)).toBe(false);
  });

  it('สอง job พร้อมกัน (สอง worker) → เตือนครั้งเดียว', async () => {
    const v = await vehicle(tA, vtA);
    const d = await doc(tA, v.id, addDays(D0, 7));
    const drv = await driver(tA, addDays(D0, 30));
    const results = await Promise.all(
      [1, 2, 3].map(() => dbs.withTenant(tA, (tx) => svc.runForTenant(tx, tA, D0))),
    );
    expect(results.reduce((s, r) => s + r.reminders, 0)).toBe(2);
    expect(await db.expiryReminder.count()).toBe(2);
    expect(await inApp(tA, await enc('vehicleDocument', d.id))).toHaveLength(2);
    expect(await inApp(tA, await enc('driver', drv.id))).toHaveLength(2);
    // job ซ้ำในคิว (สอง worker สร้างพร้อมกัน) ก็ไม่ส่งซ้ำ
    clock.set(at(D0));
    for (const t of [tA, tA])
      await dbs.withTenant(t, (tx) =>
        queue.enqueue(tx, { tenantId: t, type: EXPIRY_REMINDER_JOB, payload: { day: D0 } }),
      );
    while (await queue.runOnce());
    expect(await db.expiryReminder.count()).toBe(2);
  });

  it('แยก tenant: สมุดเตือน/แจ้งเตือนของ tenant อื่นมองไม่เห็นและไม่ส่งข้าม', async () => {
    const vtB = await vehicleType(tB);
    const vB = await vehicle(tB, vtB);
    const dB = await doc(tB, vB.id, addDays(D0, 30));
    const vA = await vehicle(tA, vtA);
    const dA = await doc(tA, vA.id, addDays(D0, 30));
    await runDay(D0);
    expect(await db.expiryReminder.count()).toBe(2);
    // RLS: ใน transaction ของ A เห็นเฉพาะแถวของ A
    const seenA = await dbs.withTenant(tA, (tx) => tx.expiryReminder.findMany());
    expect(seenA.map((r) => r.entityId)).toEqual([dA.id]);
    const seenB = await dbs.withTenant(tB, (tx) => tx.expiryReminder.findMany());
    expect(seenB.map((r) => r.entityId)).toEqual([dB.id]);
    // เขียนแถวให้ tenant อื่นจาก transaction ของ A ไม่ได้
    await expect(
      dbs.withTenant(tA, (tx) =>
        tx.expiryReminder.create({
          data: {
            tenantId: tB,
            entityType: 'VEHICLE_DOCUMENT',
            entityId: dB.id,
            level: 'D7',
            expiresOn: date(D0),
            sentOn: date(D0),
          },
        }),
      ),
    ).rejects.toThrow();
    // ผู้รับของ B ได้เฉพาะเอกสารของ B
    const rowsB = await inApp(tB);
    expect(rowsB.map((r) => r.recipientId)).toEqual([ownerB]);
    expect(rowsB[0]!.relatedEntityId).toBe(await enc('vehicleDocument', dB.id));
    expect((await inApp(tA)).some((r) => r.recipientId === ownerB)).toBe(false);
  });

  it('ตารางตาม schedule: ก่อน 06:00 เวลาไทยไม่สร้าง job · tenant ที่ถูกระงับข้าม · วันใหม่สร้าง job ใหม่', async () => {
    const tS = (await createTenant(db, 'บริษัท ระงับ จำกัด')).id;
    await db.tenant.update({ where: { id: tS }, data: { status: 'SUSPENDED' } });
    expect(await svc.scheduleDue(new Date(`${D0}T22:59:00Z`))).toBe(0); // 05:59 น. ของวันถัดไป
    expect(await svc.scheduleDue(new Date(`${D0}T23:00:00Z`))).toBe(2); // 06:00 น. — A, B
    expect(await svc.scheduleDue(new Date(`${D0}T23:30:00Z`))).toBe(0);
    const jobs = await db.job.findMany({ where: { type: EXPIRY_REMINDER_JOB } });
    expect(jobs.map((j) => j.tenantId).sort()).toEqual([tA, tB].sort());
    expect(jobs.every((j) => (j.payload as { day: string }).day === addDays(D0, 1))).toBe(true);
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
    expect(await inApp(tA)).toHaveLength(0);
  });
});
