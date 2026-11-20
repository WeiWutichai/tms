import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { JobQueue } from '../src/jobs/job-queue.service';
import {
  INVOICE_OVERDUE_JOB,
  InvoiceStatusService,
} from '../src/modules/invoices/invoice-status.service';
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

/**
 * ST5-T18 สถานะใบแจ้งหนี้จากการรับชำระ + เกินกำหนด + "ส่งลูกค้าแล้ว" · เกณฑ์ตรวจรับ:
 * ใบเลย due date ที่ยังไม่จ่ายเป็น OVERDUE (ธง `overdue`) หลัง job รัน · จ่ายครบเป็น PAID (ธงหลุด + webhook invoice.paid)
 * + job idempotent / เวลาไทย / แยก tenant · ส่งลูกค้าแล้วยกเลิกไม่ได้ (docs/04 F3) · ใบวางบิลตั้ง/ล้างธง · audit
 */
describe('invoice status / overdue / sent (ST5-T18)', { timeout: 300_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let svc: InvoiceStatusService;
  let queue: JobQueue;
  let clock: Clock;
  let tenantId: string;
  let otherTenantId: string;
  let companyId: string;
  let branchId: string;
  let customerId: string;
  let admin: string;
  let accounting: string;
  let manager: string;
  let viewer: string;
  let seq = 0;
  const today = bangkokToday();
  /** วันนี้ 00:06 เวลาไทย (หลังเวลาเริ่ม job 00:05) */
  const at = (d: string, hhmm = '00:06') => new Date(`${d}T${hhmm}:00+07:00`);
  const id = (x: string) => tryDecodeId('invoice', x)!;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    svc = app.get(InvoiceStatusService);
    queue = app.get(JobQueue);
    clock = app.get(Clock);
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท สถานะใบ' })).id;
    otherTenantId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    companyId = (
      await db.company.create({
        data: { tenantId, legalName: 'บริษัท ผู้ออก จำกัด', taxId: validTaxId(1801) },
      })
    ).id;
    branchId = (
      await db.branch.create({
        data: {
          tenantId,
          companyId,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: { line1: '1', district: 'x', province: 'x', postcode: '10000' },
        },
      })
    ).id;
    customerId = (
      await db.customer.create({
        data: { tenantId, code: 'C-ST', legalName: 'ลูกค้า สถานะ', taxId: validTaxId(1802) },
      })
    ).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    manager = await tokenFor(tenantId, SYSTEM_ROLES.manager.permissions.join(' '), 'u-mgr');
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
  });
  afterEach(() => clock.set(null));
  afterAll(async () => {
    clock.set(null);
    await app.close();
    await db.$disconnect();
  });

  /** ใบที่ออกแล้ว ครบกำหนด `due` (ออก 30 วันก่อน) */
  const issued = async (total: string, due: string, tenant = tenantId) => {
    const n = ++seq;
    let comp = companyId;
    let br = branchId;
    let cust = customerId;
    if (tenant !== tenantId) {
      comp = (
        await db.company.create({
          data: { tenantId: tenant, legalName: `ผู้ออก ${n}`, taxId: validTaxId(1900 + n) },
        })
      ).id;
      br = (
        await db.branch.create({
          data: {
            tenantId: tenant,
            companyId: comp,
            branchCode: '00000',
            branchLabel: 'สำนักงานใหญ่',
            address: { line1: '1', district: 'x', province: 'x', postcode: '10000' },
          },
        })
      ).id;
      cust = (
        await db.customer.create({
          data: { tenantId: tenant, code: `C-${n}`, legalName: `ลูกค้า ${n}` },
        })
      ).id;
    }
    const inv = await db.invoice.create({
      data: {
        tenantId: tenant,
        customerId: cust,
        issuingCompanyId: comp,
        issuingBranchId: br,
        status: 'ISSUED',
        totalAmount: total,
        subtotalExempt: total,
        ...issuedTestFields(`INV-ST-${n}`),
        issueDate: new Date(`${addDays(due, -30)}T00:00:00.000Z`),
        dueDate: new Date(`${due}T00:00:00.000Z`),
      },
    });
    return encodeId('invoice', inv.id);
  };
  const get = async (x: string) =>
    (await api(app, admin).get(`/v1/invoices/${x}`).expect(200)).body;
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
  /** worker: สร้าง job ของวัน → รันจนหมด */
  const runWorker = async (now: Date) => {
    clock.set(now);
    const made = await svc.scheduleDue();
    while (await queue.runOnce());
    return made;
  };

  it('เกณฑ์ตรวจรับ: ใบเลยวันครบกำหนดที่ยังไม่จ่าย → เกินกำหนดหลัง job รัน (00:05 เวลาไทย) · ยังไม่ครบ/ครบวันนี้ไม่เกิน · รันซ้ำไม่เปลี่ยน', async () => {
    const over = await issued('1000.00', addDays(today, -1));
    const dueToday = await issued('500.00', today);
    const later = await issued('300.00', addDays(today, 5));
    // ก่อน job: ยังไม่มีธงที่เก็บ แต่การอ่านเห็นว่าเกินกำหนดแล้ว (review M1 — ไม่พึ่ง worker)
    expect(await get(over)).toMatchObject({
      status: 'ISSUED',
      overdue: true,
      overdueAt: null,
      version: 1,
    });
    // ก่อน 00:05 เวลาไทย ยังไม่สร้าง job
    clock.set(at(today, '00:04'));
    expect(await svc.scheduleDue()).toBe(0);
    expect(await runWorker(at(today))).toBe(2); // ทุก tenant ที่ active (สอง tenant ในไฟล์นี้)
    const o = await get(over);
    expect(o).toMatchObject({ status: 'ISSUED', overdue: true, version: 2 });
    expect(o.overdueAt).not.toBeNull();
    expect(await get(dueToday)).toMatchObject({ overdue: false, version: 1 });
    expect(await get(later)).toMatchObject({ overdue: false, version: 1 });
    // รายการ/KPI อ่านธงที่เก็บ
    const list = (
      await api(app, admin).get('/v1/invoices?receivable=overdue&limit=200').expect(200)
    ).body.data as { id: string; overdue: boolean }[];
    expect(list.map((x) => x.id)).toEqual([over]);
    expect(list[0]!.overdue).toBe(true);
    expect((await api(app, admin).get('/v1/invoices/summary').expect(200)).body.overdue).toBe(1);
    const ps = (await api(app, admin).get('/v1/payments/summary').expect(200)).body;
    expect(ps).toMatchObject({ overdue: 1, sellOverdueOutstanding: '1000.00' });
    // audit โดยระบบ
    const audit = await db.auditLog.findFirst({
      where: { tenantId, action: 'invoice.overdue', entityId: id(over) },
    });
    expect(audit?.actorId).toBe('system:invoice-overdue');
    // รันซ้ำวันเดียวกัน: ไม่สร้าง job ซ้ำ · รันตรงก็ไม่เปลี่ยน (idempotent)
    expect(await runWorker(at(today, '03:00'))).toBe(0);
    expect(await svc.runOverdue(tenantId, at(today, '09:00'))).toMatchObject({
      marked: 0,
      cleared: 0,
    });
    expect((await get(over)).version).toBe(2);
    expect(
      await db.auditLog.count({
        where: { tenantId, action: 'invoice.overdue', entityId: id(over) },
      }),
    ).toBe(1);
    // วันถัดไป: ใบที่ครบกำหนดเมื่อวานกลายเป็นเกินกำหนด
    expect(await runWorker(at(addDays(today, 1)))).toBe(2);
    expect(await get(dueToday)).toMatchObject({ overdue: true });
    expect(await get(later)).toMatchObject({ overdue: false });
    const job = await db.job.findFirst({
      where: { tenantId, type: INVOICE_OVERDUE_JOB },
      orderBy: { createdAt: 'desc' },
    });
    expect(job?.status).toBe('SUCCEEDED');
  });

  it('เวลาไทย: 23:30 UTC ของวันครบกำหนด = วันถัดไปในไทย → เกินกำหนด', async () => {
    const due = addDays(today, -10);
    const x = await issued('100.00', due);
    // 16:59 UTC ของวันครบกำหนด = 23:59 ไทย (ยังเป็นวันครบกำหนด) → ไม่เกิน
    expect(await svc.runOverdue(tenantId, new Date(`${due}T16:59:00.000Z`))).toMatchObject({
      marked: 0,
    });
    const flag = async () =>
      (await db.invoice.findUniqueOrThrow({ where: { id: id(x) } })).overdueAt;
    expect(await flag()).toBeNull();
    // 17:00 UTC = 00:00 ไทยของวันถัดไป → เกิน
    await svc.runOverdue(tenantId, new Date(`${due}T17:00:00.000Z`));
    expect(await flag()).not.toBeNull();
  });

  it('แยก tenant: job ของ tenant หนึ่งไม่แตะใบของอีก tenant (RLS)', async () => {
    const mine = await issued('100.00', addDays(today, -3));
    const theirs = await issued('100.00', addDays(today, -3), otherTenantId);
    await svc.runOverdue(tenantId, new Date());
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: id(mine) } })).overdueAt,
    ).not.toBeNull();
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: id(theirs) } })).overdueAt,
    ).toBeNull();
    await svc.runOverdue(otherTenantId, new Date());
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: id(theirs) } })).overdueAt,
    ).not.toBeNull();
    // อ่านข้าม tenant ไม่ได้
    const other = await tokenFor(otherTenantId);
    await api(app, other).get(`/v1/invoices/${mine}`).expect(404);
  });

  it('เกณฑ์ตรวจรับ: เกินกำหนด + รับบางส่วน → PARTIALLY_PAID ยังเกินกำหนด · จ่ายครบ → PAID ธงหลุด + webhook invoice.paid · กลับรายการ → เกินกำหนดอีกทันที', async () => {
    const x = await issued('1000.00', addDays(today, -5));
    await svc.runOverdue(tenantId, new Date());
    await pay(x, '400.00');
    expect(await get(x)).toMatchObject({
      status: 'PARTIALLY_PAID',
      overdue: true,
      sellOutstanding: '600.00',
    });
    const full = (await pay(x, '600.00')).body as { id: string; version: number };
    const paid = await get(x);
    expect(paid).toMatchObject({ status: 'PAID', overdue: false, overdueAt: null });
    const ev = await db.domainEvent.findFirst({
      where: { tenantId, type: 'invoice.paid', localId: id(x) },
    });
    expect(ev?.snapshot).toMatchObject({ id: x, status: 'PAID', overdue: false });
    expect(ev?.previousAttributes).toMatchObject({ status: 'PARTIALLY_PAID' });
    expect(JSON.stringify(ev?.snapshot)).not.toMatch(/"sell/);
    // job รอบต่อไปไม่แตะใบที่ชำระครบ
    expect(await svc.runOverdue(tenantId, new Date())).toMatchObject({ marked: 0 });
    // กลับรายการ → ยอดค้างกลับมา + เกินกำหนดทันที (ไม่ต้องรอ job) · ไม่ยิง invoice.paid ซ้ำ
    await api(app, manager)
      .post(`/v1/payments/${full.id}/reverse`)
      .set('If-Match', `"${full.version}"`)
      .send({ reason: 'บันทึกผิดยอด กลับรายการ' })
      .expect(200);
    expect(await get(x)).toMatchObject({
      status: 'PARTIALLY_PAID',
      overdue: true,
      sellOutstanding: '600.00',
    });
    expect(
      await db.domainEvent.count({ where: { tenantId, type: 'invoice.paid', localId: id(x) } }),
    ).toBe(1);
  });

  it('ใบยังไม่ครบกำหนด: รับชำระครบ → PAID ไม่เคยเกินกำหนด', async () => {
    const x = await issued('250.00', addDays(today, 10));
    await pay(x, '250.00');
    expect(await get(x)).toMatchObject({ status: 'PAID', overdue: false });
  });

  it('DB: ธงเกินกำหนดมีได้เฉพาะใบค้างรับ · ยกเลิกใบที่เกินกำหนด → ธงล้างเอง', async () => {
    const x = await issued('100.00', addDays(today, -2));
    const y = await issued('100.00', addDays(today, -2));
    await svc.runOverdue(tenantId, new Date());
    // สถานะออกจากค้างรับ → trigger ล้างธงในคำสั่งเดียวกัน · ตั้งธงให้ใบที่ไม่ค้างรับ → CHECK
    const paidRow = await db.invoice.update({
      where: { id: id(y) },
      data: { status: 'PAID', paidAmount: '100.00' },
    });
    expect(paidRow.overdueAt).toBeNull();
    await expect(
      db.invoice.update({ where: { id: id(y) }, data: { overdueAt: new Date() } }),
    ).rejects.toThrow(/invoice_overdue_status_check/);
    const v = (await get(x)).version as number;
    const r = await api(app, admin)
      .post(`/v1/invoices/${x}/void`)
      .set('If-Match', `"${v}"`)
      .send({ reason: 'ออกผิดลูกค้า ยกเลิก' })
      .expect(200);
    expect(r.body).toMatchObject({ status: 'CANCELLED', overdue: false, overdueAt: null });
  });

  it('ส่งลูกค้าแล้ว: ทำเครื่องหมายเอง (audit) · ซ้ำ = ไม่เปลี่ยน · ยกเลิกใบไม่ได้ 409 · ล้างธงต้องมีเหตุผล + invoices:void · แล้วยกเลิกได้', async () => {
    const x = await issued('900.00', addDays(today, 7));
    await api(app, viewer).post(`/v1/invoices/${x}/mark-sent`).expect(403);
    await api(app, admin).post(`/v1/invoices/${x}/mark-sent`).set('If-Match', '"9"').expect(412);
    const m = await api(app, accounting).post(`/v1/invoices/${x}/mark-sent`).expect(200);
    expect(m.body).toMatchObject({ sentToCustomerChannel: 'MANUAL', version: 2 });
    expect(m.body.sentToCustomerAt).not.toBeNull();
    expect(m.headers.etag).toBe('"2"');
    const again = await api(app, accounting).post(`/v1/invoices/${x}/mark-sent`).expect(200);
    expect(again.body.version).toBe(2);
    expect(
      await db.auditLog.count({
        where: { tenantId, action: 'invoice.sent_to_customer', entityId: id(x) },
      }),
    ).toBe(1);
    // docs/04 F3 "ยกเลิกใบ — เฉพาะยังไม่ส่งลูกค้า"
    const blocked = await api(app, admin)
      .post(`/v1/invoices/${x}/void`)
      .set('If-Match', '"2"')
      .send({ reason: 'ทดสอบยกเลิกใบที่ส่งแล้ว' })
      .expect(409);
    expect(blocked.body).toMatchObject({
      code: 'invoice_sent_to_customer',
      sentToCustomerChannel: 'MANUAL',
    });
    // ฐานข้อมูลกันซ้ำ
    await expect(
      db.invoice.update({
        where: { id: id(x) },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: 't',
          cancelReason: 'xxxxxxxxxx',
        },
      }),
    ).rejects.toThrow(/invoice_cancel_sent|sent to the customer/);
    // ล้างธง: invoices:void เท่านั้น + เหตุผล ≥ 10
    await api(app, accounting)
      .post(`/v1/invoices/${x}/unmark-sent`)
      .send({ reason: 'ทำเครื่องหมายผิดใบ' })
      .expect(403);
    await api(app, manager)
      .post(`/v1/invoices/${x}/unmark-sent`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const u = await api(app, manager)
      .post(`/v1/invoices/${x}/unmark-sent`)
      .set('If-Match', '"2"')
      .send({ reason: 'ทำเครื่องหมายผิดใบ ยังไม่ได้ส่ง' })
      .expect(200);
    expect(u.body).toMatchObject({
      sentToCustomerAt: null,
      sentToCustomerChannel: null,
      version: 3,
    });
    const a = await db.auditLog.findFirst({
      where: { tenantId, action: 'invoice.sent_to_customer_cleared', entityId: id(x) },
    });
    expect(a?.reason).toBe('ทำเครื่องหมายผิดใบ ยังไม่ได้ส่ง');
    expect(a?.actorId).toBe('u-mgr');
    await api(app, admin)
      .post(`/v1/invoices/${x}/void`)
      .set('If-Match', '"3"')
      .send({ reason: 'ทดสอบยกเลิกหลังล้างธง' })
      .expect(200);
    // ใบที่ยกเลิกแล้วทำเครื่องหมายไม่ได้
    await api(app, admin).post(`/v1/invoices/${x}/mark-sent`).expect(409);
  });

  it('ออกใบวางบิล = ส่งลูกค้าแล้ว (BILLING_NOTE) · ธงที่ตั้งเองไม่ถูกทับ · ยกเลิกใบวางบิล → ล้างเฉพาะธงจากใบวางบิล', async () => {
    const a = await issued('1000.00', addDays(today, 20));
    const b = await issued('2000.00', addDays(today, 20));
    await api(app, admin).post(`/v1/invoices/${b}/mark-sent`).expect(200);
    const bManual = (await get(b)).sentToCustomerAt as string;
    const d = await api(app, admin)
      .post('/v1/billing-notes')
      .send({
        customerId: encodeId('customer', customerId),
        invoiceIds: [a, b],
        collectionDate: addDays(today, 3),
      })
      .expect(201);
    const iss = await api(app, admin)
      .post(`/v1/billing-notes/${d.body.id}/finalize`)
      .set('If-Match', `"${d.body.version}"`)
      .expect(200);
    expect(await get(a)).toMatchObject({ sentToCustomerChannel: 'BILLING_NOTE' });
    expect(await get(b)).toMatchObject({
      sentToCustomerChannel: 'MANUAL',
      sentToCustomerAt: bManual,
    });
    const audit = await db.auditLog.findFirst({
      where: { tenantId, action: 'invoice.sent_to_customer', entityId: id(a) },
    });
    expect(audit?.after).toMatchObject({
      channel: 'BILLING_NOTE',
      billingNoteNo: iss.body.billingNoteNo,
    });
    await api(app, admin)
      .post(`/v1/billing-notes/${d.body.id}/cancel`)
      .set('If-Match', `"${iss.body.version}"`)
      .send({ reason: 'ลูกค้าขอแยกวางบิลตามสาขา' })
      .expect(200);
    expect(await get(a)).toMatchObject({ sentToCustomerAt: null, sentToCustomerChannel: null });
    expect(await get(b)).toMatchObject({ sentToCustomerChannel: 'MANUAL' });
    const cleared = await db.auditLog.findFirst({
      where: { tenantId, action: 'invoice.sent_to_customer_cleared', entityId: id(a) },
    });
    expect(cleared?.reason).toContain('ลูกค้าขอแยกวางบิลตามสาขา');
    // ใบ a ยกเลิกได้ตามเดิม (ST5-T10) · ใบ b ยังส่งแล้ว → 409
    await api(app, admin)
      .post(`/v1/invoices/${a}/void`)
      .set('If-Match', `"${(await get(a)).version}"`)
      .send({ reason: 'ทดสอบยกเลิกหลังยกเลิกใบวางบิล' })
      .expect(200);
    await api(app, admin)
      .post(`/v1/invoices/${b}/void`)
      .set('If-Match', `"${(await get(b)).version}"`)
      .send({ reason: 'ทดสอบยกเลิกหลังยกเลิกใบวางบิล' })
      .expect(409);
  });

  it('review M1: job ไม่ได้รัน (worker ล่ม / ก่อน 00:05) → รายการ/ตัวนับ/DTO ยังเห็นเกินกำหนด · ยอดรวม 0 ไม่เกิน · job ไม่ค้างลูป', async () => {
    const x = await issued('700.00', addDays(today, -4));
    const zero = await issued('0.00', addDays(today, -4));
    const before = (await api(app, admin).get('/v1/invoices/summary').expect(200)).body;
    expect(await get(x)).toMatchObject({ overdue: true, overdueAt: null });
    expect(await get(zero)).toMatchObject({ overdue: false });
    const list = (
      await api(app, admin).get('/v1/invoices?receivable=overdue&limit=200').expect(200)
    ).body.data.map((r: { id: string }) => r.id);
    expect(list).toContain(x);
    expect(list).not.toContain(zero);
    const notOver = (
      await api(app, admin).get('/v1/invoices?status=ISSUED&overdue=false&limit=200').expect(200)
    ).body.data.map((r: { id: string }) => r.id);
    expect(notOver).not.toContain(x);
    expect(notOver).toContain(zero);
    expect(before.overdue).toBeGreaterThanOrEqual(1);
    const ps = (await api(app, admin).get('/v1/payments/summary').expect(200)).body;
    expect(Number(ps.sellOverdueOutstanding)).toBeGreaterThanOrEqual(700);
    // job: ตั้งธงใบ x · ใบยอด 0 ไม่ถูกหยิบ (ไม่ค้างลูป) · รันซ้ำ = 0
    expect((await svc.runOverdue(tenantId, new Date())).marked).toBeGreaterThanOrEqual(1);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: id(zero) } })).overdueAt).toBeNull();
    expect(await svc.runOverdue(tenantId, new Date())).toMatchObject({ marked: 0, cleared: 0 });
  });
});
