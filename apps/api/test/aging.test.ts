import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { Clock } from '../src/common/clock';
import { encodeId } from '../src/common/ids';
import { JobQueue } from '../src/jobs/job-queue.service';
import { renderNotification } from '../src/modules/notifications/templates';
import {
  PAYMENT_DUE_JOB,
  PaymentDueReminderService,
} from '../src/modules/reminders/payment-due-reminder.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import {
  api,
  bootApp,
  issuedTestFields,
  platform,
  tokenFor,
  truncateAll,
  validTaxId,
} from './helpers';

type Bucket = { bucket: string; count: number; sellOutstanding?: string };
const cents = (s: string | undefined) => Math.round(Number(s ?? '0') * 100);
const sumB = (b: Bucket[]) => b.reduce((a, x) => a + cents(x.sellOutstanding), 0);

/**
 * ST5-T22 อายุลูกหนี้แบบง่าย + เตือนครบกำหนดชำระ (D-54; docs/04 F5; spec/05 §10 BIL-120/121; spec/09 §3 RPT-032)
 * เกณฑ์ตรวจรับ: ยอดรวม aging ทุกช่วง = ยอดค้างรวมของ invoice ที่ยังไม่ปิด (เทียบกับ `GET /payments/summary` และ Σ ใบ)
 */
describe('อายุลูกหนี้ + เตือนครบกำหนด (ST5-T22)', { timeout: 300_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let clock: Clock;
  let queue: JobQueue;
  let reminders: PaymentDueReminderService;
  let tenantId: string;
  let otherTenantId: string;
  let companyId: string;
  let branchId: string;
  let custA: string;
  let custB: string;
  let custOther: string;
  let admin: string;
  let accounting: string;
  let readOnly: string;
  let other: string;
  let seq = 0;
  const today = bangkokToday();

  const company = async (tenant: string) => {
    const c = await db.company.create({
      data: { tenantId: tenant, legalName: `ผู้ออก ${++seq}`, taxId: validTaxId(2200 + seq) },
    });
    const b = await db.branch.create({
      data: {
        tenantId: tenant,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: { line1: '1', district: 'x', province: 'x', postcode: '10000' },
      },
    });
    return { companyId: c.id, branchId: b.id };
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    clock = app.get(Clock);
    queue = app.get(JobQueue);
    reminders = app.get(PaymentDueReminderService);
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท อายุหนี้' })).id;
    otherTenantId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    ({ companyId, branchId } = await company(tenantId));
    custA = (
      await db.customer.create({
        data: { tenantId, code: 'C-A', legalName: 'ก ลูกค้าแรก', taxId: validTaxId(2101) },
      })
    ).id;
    custB = (
      await db.customer.create({
        data: { tenantId, code: 'C-B', legalName: 'ข ลูกค้าสอง', taxId: validTaxId(2102) },
      })
    ).id;
    custOther = (
      await db.customer.create({
        data: { tenantId: otherTenantId, code: 'C-X', legalName: 'ลูกค้า บริษัทอื่น' },
      })
    ).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    readOnly = await tokenFor(tenantId, 'invoices:read', 'u-read'); // ไม่มี prices.sell:read
    other = await tokenFor(otherTenantId);
  });
  afterEach(() => clock.set(null));
  afterAll(async () => {
    clock.set(null);
    await app.close();
    await db.$disconnect();
  });

  /** ใบที่ออกแล้ว ครบกำหนด `due` (ออก 30 วันก่อน) */
  const issued = async (
    customerId: string,
    total: string,
    due: string | null,
    o: { tenant?: string; status?: 'ISSUED' | 'DRAFT' | 'CANCELLED' } = {},
  ) => {
    const tenant = o.tenant ?? tenantId;
    const iss = tenant === tenantId ? { companyId, branchId } : await company(tenant);
    const n = ++seq;
    const status = o.status ?? 'ISSUED';
    const issuedFields =
      status === 'DRAFT'
        ? {}
        : {
            ...issuedTestFields(`INV-AG-${n}`),
            issueDate: new Date(`${addDays(due ?? today, -30)}T00:00:00.000Z`),
            dueDate: due ? new Date(`${due}T00:00:00.000Z`) : null,
          };
    const inv = await db.invoice.create({
      data: {
        tenantId: tenant,
        customerId,
        issuingCompanyId: iss.companyId,
        issuingBranchId: iss.branchId,
        status,
        totalAmount: total,
        subtotalExempt: total,
        ...issuedFields,
        ...(status === 'CANCELLED'
          ? { cancelledAt: new Date(), cancelledBy: 'test', cancelReason: 'ทดสอบยกเลิกใบ' }
          : {}),
      },
    });
    return encodeId('invoice', inv.id);
  };
  const pay = (invoiceId: string, amount: string) =>
    api(app, accounting)
      .post('/v1/payments')
      .send({
        receivedDate: today,
        method: 'TRANSFER',
        amountReceived: amount,
        allocations: [{ invoiceId, amount }],
      })
      .expect(201);

  const ids: Record<string, string> = {};

  it('เกณฑ์ตรวจรับ: Σ ทุกช่วง = ยอดค้างรวม (summary) = Σ (ยอดรวม − ยอดตัด) ของใบค้างรับ · ต่อลูกค้ารวมกันได้ยอดเดียวกัน', async () => {
    // ลูกค้า A
    ids.notDue = await issued(custA, '10000.00', addDays(today, 20));
    ids.dueToday = await issued(custA, '700.00', today); // ครบวันนี้ = ยังไม่ครบกำหนด
    ids.d1 = await issued(custA, '100.00', addDays(today, -1));
    ids.d30 = await issued(custA, '130.00', addDays(today, -30));
    ids.d31 = await issued(custB, '310.00', addDays(today, -31));
    ids.d39 = await issued(custB, '5000.00', addDays(today, -39)); // spec/05 §10: 39 วัน → 31–60
    ids.d75 = await issued(custB, '750.00', addDays(today, -75));
    ids.d131 = await issued(custB, '2000.00', addDays(today, -131)); // spec/09: 131 วัน → เกิน 90
    // ชำระบางส่วน (ยอดค้าง = 5000 − 1234.56) · ชำระครบ (ไม่นับ) · ร่าง/ยกเลิก (ไม่นับ) · บริษัทอื่น (ไม่นับ)
    await pay(ids.d39, '1234.56');
    ids.paid = await issued(custA, '999.00', addDays(today, -45));
    await pay(ids.paid, '999.00');
    await issued(custA, '888.00', null, { status: 'DRAFT' });
    await issued(custA, '777.00', addDays(today, -10), { status: 'CANCELLED' });
    await issued(custOther, '666.00', addDays(today, -10), { tenant: otherTenantId });

    const r = (await api(app, admin).get('/v1/payments/aging').expect(200)).body;
    const sum = (await api(app, admin).get('/v1/payments/summary').expect(200)).body;
    expect(r.asOf).toBe(today);
    expect(r.basis).toBe('DUE_DATE');
    const by = Object.fromEntries((r.buckets as Bucket[]).map((b) => [b.bucket, b]));
    expect(by).toEqual({
      NOT_DUE: { bucket: 'NOT_DUE', count: 2, sellOutstanding: '10700.00' },
      DAYS_1_30: { bucket: 'DAYS_1_30', count: 2, sellOutstanding: '230.00' },
      DAYS_31_60: { bucket: 'DAYS_31_60', count: 2, sellOutstanding: '4075.44' },
      DAYS_61_90: { bucket: 'DAYS_61_90', count: 1, sellOutstanding: '750.00' },
      DAYS_OVER_90: { bucket: 'DAYS_OVER_90', count: 1, sellOutstanding: '2000.00' },
    });
    // เกณฑ์ตรวจรับ — Σ ทุกช่วง = ยอดรวม = ยอดค้างรับของ summary = Σ ใบในฐาน
    const open = await db.invoice.findMany({
      where: { tenantId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
      select: { totalAmount: true, paidAmount: true },
    });
    const dbOut = open.reduce(
      (a, i) => a + cents(i.totalAmount.toFixed(2)) - cents(i.paidAmount.toFixed(2)),
      0,
    );
    expect(sumB(r.buckets)).toBe(cents(r.sellOutstanding));
    expect(cents(r.sellOutstanding)).toBe(cents(sum.sellOutstanding));
    expect(cents(r.sellOutstanding)).toBe(dbOut);
    expect(r.count).toBe(8);
    // ต่อลูกค้า: เรียงตามชื่อ · Σ ช่วง = ยอดลูกค้า · Σ ลูกค้า = ยอดรวม · ช่วงต่อช่วงรวมกันได้ยอดรวมของช่วง
    expect(r.data.map((c: { customer: { code: string } }) => c.customer.code)).toEqual([
      'C-A',
      'C-B',
    ]);
    for (const c of r.data) expect(sumB(c.buckets)).toBe(cents(c.sellOutstanding));
    expect(
      r.data.reduce((a: number, c: { sellOutstanding: string }) => a + cents(c.sellOutstanding), 0),
    ).toBe(cents(r.sellOutstanding));
    for (let i = 0; i < 5; i++)
      expect(
        r.data.reduce(
          (a: number, c: { buckets: Bucket[] }) => a + cents(c.buckets[i]!.sellOutstanding),
          0,
        ),
      ).toBe(cents(r.buckets[i].sellOutstanding));
    expect(r.data[0]).toMatchObject({
      customer: {
        id: encodeId('customer', custA),
        legalName: 'ก ลูกค้าแรก',
        taxId: validTaxId(2101),
      },
      count: 4,
      sellOutstanding: '10930.00',
    });
  });

  it('ตัวกรอง `aging` ของรายการใบแจ้งหนี้ = ใบชุดเดียวกับช่วงในการ์ด (ยอดตรงกัน)', async () => {
    const r = (await api(app, admin).get('/v1/payments/aging').expect(200)).body;
    for (const b of r.buckets as Bucket[]) {
      const l = (
        await api(app, admin)
          .get('/v1/invoices')
          .query({ receivable: 'all', aging: b.bucket, limit: 200 })
          .expect(200)
      ).body;
      expect(l.data.length, b.bucket).toBe(b.count);
      expect(
        l.data.reduce(
          (a: number, x: { sellOutstanding: string }) => a + cents(x.sellOutstanding),
          0,
        ),
      ).toBe(cents(b.sellOutstanding));
    }
    const d31 = (
      await api(app, admin).get('/v1/invoices').query({ aging: 'DAYS_31_60' }).expect(200)
    ).body.data.map((x: { id: string }) => x.id);
    expect(d31.sort()).toEqual([ids.d31, ids.d39].sort());
    await api(app, admin).get('/v1/invoices').query({ aging: 'DAYS_0_30' }).expect(422);
  });

  it('ต่อลูกค้า: customerId (รวม ext: ที่ไม่มี) · cursor เดินครบไม่ซ้ำ · cursor เสีย → 422', async () => {
    const one = (
      await api(app, admin)
        .get('/v1/payments/aging')
        .query({ customerId: encodeId('customer', custB) })
        .expect(200)
    ).body;
    expect(one.data).toHaveLength(1);
    expect(one.count).toBe(4);
    expect(sumB(one.buckets)).toBe(cents(one.data[0].sellOutstanding));
    const none = (
      await api(app, admin).get('/v1/payments/aging').query({ customerId: 'ext:nope' }).expect(200)
    ).body;
    expect(none).toMatchObject({ count: 0, sellOutstanding: '0.00', data: [], hasMore: false });

    const p1 = (await api(app, admin).get('/v1/payments/aging').query({ limit: 1 }).expect(200))
      .body;
    expect(p1.hasMore).toBe(true);
    expect(p1.data[0].customer.code).toBe('C-A');
    const p2 = (
      await api(app, admin)
        .get('/v1/payments/aging')
        .query({ limit: 1, cursor: p1.nextCursor })
        .expect(200)
    ).body;
    expect(p2).toMatchObject({ hasMore: false, nextCursor: null });
    expect(p2.data[0].customer.code).toBe('C-B');
    // ยอดรวม/ช่วงไม่ขึ้นกับหน้า
    expect(p2.sellOutstanding).toBe(p1.sellOutstanding);
    const bad = await api(app, admin).get('/v1/payments/aging').query({ cursor: 'xyz' });
    expect(bad.status).toBe(422);
  });

  it('สิทธิ์: ไม่มี prices.sell:read เห็นจำนวนใบแต่ไม่เห็นยอด · ไม่มี invoices:read → 403 · บริษัทอื่นไม่เห็นใบของเรา', async () => {
    const r = (await api(app, readOnly).get('/v1/payments/aging').expect(200)).body;
    expect(r.count).toBe(8);
    expect(r).not.toHaveProperty('sellOutstanding');
    expect(r.buckets[0]).not.toHaveProperty('sellOutstanding');
    expect(r.data[0]).not.toHaveProperty('sellOutstanding');
    expect(r.data[0].buckets[0]).toEqual({ bucket: 'NOT_DUE', count: 2 });
    const noScope = await tokenFor(tenantId, 'orders:read', 'u-none');
    const f = await api(app, noScope).get('/v1/payments/aging');
    expect(f.status).toBe(403);
    const o = (await api(app, other).get('/v1/payments/aging').expect(200)).body;
    expect(o.count).toBe(1);
    expect(o.sellOutstanding).toBe('666.00');
    // ลูกค้าของบริษัท A จาก key บริษัทอื่น = ไม่มีข้อมูล (ไม่บอกว่ามีอยู่)
    const x = (
      await api(app, other)
        .get('/v1/payments/aging')
        .query({ customerId: encodeId('customer', custA) })
        .expect(200)
    ).body;
    expect(x).toMatchObject({ count: 0, data: [] });
  });

  // ---------- เตือนครบกำหนดชำระ ----------

  describe('เตือนครบกำหนดชำระ (BIL-121)', () => {
    let n = 0;
    let tR: string;
    let rCo: { companyId: string; branchId: string };
    let owner: string; // ผู้ดูแลลูกค้า (invoicer — อ่านใบแจ้งหนี้ได้ ไม่มี payments:record)
    let acc1: string;
    let acc2: string;
    let planner: string; // อ่านใบแจ้งหนี้ไม่ได้
    let viewerUser: string;

    const member = async (role: string, status: 'ACTIVE' | 'DISABLED' = 'ACTIVE') => {
      const roles = await ensureSystemRoles(db, tR);
      const u = await db.appUser.create({
        data: {
          tenantId: tR,
          email: `${role}-${++n}@due.test`,
          name: `${role} ${n}`,
          status,
          locale: 'th',
        },
      });
      await db.userRole.create({ data: { tenantId: tR, userId: u.id, roleId: roles[role]! } });
      return u.id;
    };
    const cust = async (salesOwnerUserId: string | null) =>
      (
        await db.customer.create({
          data: {
            tenantId: tR,
            code: `C-R${++n}`,
            legalName: `ลูกค้าเตือน ${n}`,
            salesOwnerUserId,
          },
        })
      ).id;
    const inv = async (customerId: string, due: string, total = '100.00') => {
      const i = await db.invoice.create({
        data: {
          tenantId: tR,
          customerId,
          issuingCompanyId: rCo.companyId,
          issuingBranchId: rCo.branchId,
          status: 'ISSUED',
          totalAmount: total,
          subtotalExempt: total,
          ...issuedTestFields(`INV-DUE-${++n}`),
          issueDate: new Date(`${addDays(due, -30)}T00:00:00.000Z`),
          dueDate: new Date(`${due}T00:00:00.000Z`),
        },
      });
      return i;
    };
    const inbox = (userId: string) =>
      db.notification.findMany({
        where: { tenantId: tR, recipientId: userId, templateCode: 'invoice.payment_due' },
        orderBy: { createdAt: 'asc' },
      });
    /** วัน D 08:00 น. ไทย */
    const at = (d: string) => new Date(`${d}T01:00:00Z`);
    const D = '2027-04-10';

    beforeAll(async () => {
      tR = (await createTenantWithDefaults(db, { name: 'บริษัท เตือนชำระ' })).id;
      const c = await db.company.create({
        data: { tenantId: tR, legalName: 'ผู้ออกเตือน', taxId: validTaxId(2301) },
      });
      const b = await db.branch.create({
        data: {
          tenantId: tR,
          companyId: c.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: { line1: '1', district: 'x', province: 'x', postcode: '10000' },
        },
      });
      rCo = { companyId: c.id, branchId: b.id };
      owner = await member('invoicer');
      acc1 = await member('accounting');
      acc2 = await member('manager');
      planner = await member('planner');
      viewerUser = await member('viewer');
    });

    it('ระดับ: ก่อน 3 วัน · วันครบกำหนด · เกิน 7 · เกิน 30 → ผู้ดูแลลูกค้าได้สรุปฉบับเดียว/วัน · รันซ้ำไม่ส่งซ้ำ · ระดับถัดไปส่งใหม่', async () => {
      const c = await cust(owner);
      const a = await inv(c, addDays(D, 3)); // DUE_IN_3
      const b = await inv(c, D); // DUE_TODAY
      const d = await inv(c, addDays(D, -7)); // OVERDUE_7
      const e = await inv(c, addDays(D, -30)); // OVERDUE_30
      const f = await inv(c, addDays(D, 4)); // ยังไม่ถึง (เหลือ 4 วัน)
      await inv(c, addDays(D, -60)); // เลยช่วงเตือน
      const r1 = await reminders.runForTenant(tR, D);
      expect(r1).toMatchObject({ candidates: 4, digests: 1, reminders: 4, unrouted: 0 });
      const m = await inbox(owner);
      expect(m.filter((x) => x.channel === 'in_app')).toHaveLength(1);
      expect(m.filter((x) => x.channel === 'email')).toHaveLength(1);
      const n0 = m.find((x) => x.channel === 'in_app')!;
      expect(n0.title).toBe('ใบแจ้งหนี้ครบกำหนดชำระ 4 ใบ');
      expect(n0.body).toContain(
        'เกินกำหนด 30 วันขึ้นไป 1 · เกินกำหนด 7 วันขึ้นไป 1 · ถึงวันครบกำหนด 1 · ครบกำหนดภายใน 3 วัน 1',
      );
      expect(n0.link).toBe('/pay');
      expect(n0.body).not.toMatch(/100\.00|฿/); // ไม่ใส่ยอดเงิน
      // ฝ่ายบัญชีไม่ได้ (ลูกค้ามีผู้ดูแลที่ใช้ได้)
      expect(await inbox(acc1)).toHaveLength(0);
      // รันซ้ำวันเดียวกัน = ไม่ส่งซ้ำ
      expect(await reminders.runForTenant(tR, D)).toMatchObject({ reminders: 0, digests: 0 });
      // วันถัดไป: ใบ a เหลือ 2 วัน · ใบ b เกิน 1 วัน (ระดับเดิม = ไม่ส่งซ้ำ) · ใบ f เหลือ 3 วัน → ส่งใหม่ใบเดียว
      expect(await reminders.runForTenant(tR, addDays(D, 1))).toMatchObject({
        candidates: 5,
        reminders: 1,
      });
      // 3 วันต่อมา: ใบ a ถึงวันครบกำหนด → ส่งใหม่ 1 ใบ
      expect(await reminders.runForTenant(tR, addDays(D, 3))).toMatchObject({
        reminders: 1,
        digests: 1,
      });
      const log = await db.expiryReminder.findMany({
        where: { tenantId: tR, entityType: 'INVOICE', recipientId: owner },
        orderBy: [{ sentOn: 'asc' }, { level: 'asc' }],
      });
      expect(log.map((l) => [l.entityId, l.level])).toEqual(
        expect.arrayContaining([
          [a.id, 'DUE_IN_3'],
          [b.id, 'DUE_TODAY'],
          [d.id, 'OVERDUE_7'],
          [e.id, 'OVERDUE_30'],
          [a.id, 'DUE_TODAY'],
          [f.id, 'DUE_IN_3'],
        ]),
      );
      expect(log).toHaveLength(6);
    });

    it('ไม่มีผู้ดูแล / ผู้ดูแลถูกระงับ / ผู้ดูแลอ่านใบแจ้งหนี้ไม่ได้ → ผู้ใช้ทุกคนที่มี payments:record (ไม่รวม viewer) · ชำระครบแล้วไม่เตือน', async () => {
      const day = '2028-01-20';
      const suspended = await member('invoicer', 'DISABLED');
      const noOwner = await inv(await cust(null), day);
      const susp = await inv(await cust(suspended), day);
      const plannerOwned = await inv(await cust(planner), day);
      const paid = await inv(await cust(null), day);
      await db.invoice.update({
        where: { id: paid.id },
        data: { status: 'PAID', paidAmount: '100.00' },
      });
      const r = await reminders.runForTenant(tR, day);
      expect(r).toMatchObject({ candidates: 3, digests: 2, reminders: 6, unrouted: 0 });
      for (const u of [acc1, acc2]) {
        const m = (await inbox(u)).filter((x) => x.channel === 'in_app');
        expect(m).toHaveLength(1);
        expect(m[0]!.title).toBe('ใบแจ้งหนี้ครบกำหนดชำระ 3 ใบ');
      }
      expect(await inbox(viewerUser)).toHaveLength(0);
      expect(await inbox(planner)).toHaveLength(0);
      expect(await inbox(suspended)).toHaveLength(0);
      const got = await db.expiryReminder.findMany({
        where: { tenantId: tR, entityType: 'INVOICE', sentOn: new Date(`${day}T00:00:00Z`) },
      });
      expect(new Set(got.map((g) => g.entityId))).toEqual(
        new Set([noOwner.id, susp.id, plannerOwned.id]),
      );
    });

    it('job รายวัน: ก่อน 08:00 เวลาไทยไม่สร้าง · ตั้งแต่ 08:00 สร้างครั้งเดียวต่อ tenant ต่อวัน · tenant อื่นไม่เห็นใบของเรา', async () => {
      const day = '2029-06-15';
      const c = await cust(owner);
      await inv(c, day);
      const before = (await inbox(owner)).filter((x) => x.channel === 'in_app').length;
      clock.set(new Date(`${day}T00:59:00Z`)); // 07:59 ไทย
      expect(await reminders.scheduleDue()).toBe(0);
      clock.set(at(day));
      const made = await reminders.scheduleDue();
      expect(made).toBeGreaterThanOrEqual(1);
      expect(await reminders.scheduleDue()).toBe(0);
      while (await queue.runOnce());
      const jobs = await db.job.findMany({
        where: { type: PAYMENT_DUE_JOB, payload: { path: ['day'], equals: day } },
        select: { tenantId: true, status: true },
      });
      expect(jobs.every((j) => j.status === 'SUCCEEDED')).toBe(true);
      const mine = (await inbox(owner)).filter((x) => x.channel === 'in_app');
      expect(mine).toHaveLength(before + 1);
      expect(mine.at(-1)!.title).toBe('ใบแจ้งหนี้ครบกำหนดชำระ 1 ใบ');
      // บริษัท A (ไฟล์ด้านบน) ไม่ได้ข้อความของบริษัทนี้
      const leaked = await db.expiryReminder.count({
        where: { tenantId: { not: tR }, entityType: 'INVOICE' },
      });
      expect(leaked).toBe(0);
    });

    it('ข้อความ (ไทย): รายการเป็นกลุ่มตามระดับ · "และอีก N ใบ"', () => {
      const r = renderNotification('invoice.payment_due', 'th', {
        total: 25,
        more: 5,
        items: [
          {
            level: 'OVERDUE_7',
            invoiceNo: 'INV-1',
            customer: 'บจก. เอ',
            dueDate: '2027-04-01',
            days: 9,
          },
          {
            level: 'DUE_IN_3',
            invoiceNo: 'INV-2',
            customer: 'บจก. บี',
            dueDate: '2027-04-13',
            days: -3,
          },
          {
            level: 'DUE_TODAY',
            invoiceNo: 'INV-3',
            customer: 'บจก. ซี',
            dueDate: '2027-04-10',
            days: 0,
          },
        ],
      });
      const lines = r.detail!.split('\n');
      expect(lines[0]).toBe('เกินกำหนด 7 วันขึ้นไป:');
      expect(lines[1]).toBe('• INV-1 · บจก. เอ — ครบกำหนด 1 เมษายน 2570 (เกิน 9 วัน)');
      expect(lines).toContain('• INV-3 · บจก. ซี — ครบกำหนดวันนี้ 10 เมษายน 2570');
      expect(lines).toContain('• INV-2 · บจก. บี — ครบกำหนด 13 เมษายน 2570 (อีก 3 วัน)');
      expect(lines.at(-1)).toBe('และอีก 5 ใบ');
      expect(r.body).toContain('(แสดง 3 จาก 25)');
    });
  });
});
