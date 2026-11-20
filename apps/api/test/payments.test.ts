import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday, addDays } from '../src/modules/vehicle-documents/expiry';
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
 * ST5-T13 บันทึกรับชำระ + เช็ค — บัญชีเบา (D-54 · D-56 ไม่ออกใบเสร็จ · D-57) · เกณฑ์ตรวจรับ:
 * รับ 99% + WHT 1% → PAID · รับบางส่วน → PARTIALLY_PAID · reverse แล้วยอดค้างกลับมา · เช็ค (เลข/ธนาคาร/วันที่) + เช็คคืน = กลับรายการ
 * + ตัดเกินคงค้างไม่ได้ (พร้อมกันด้วย) · สมการยอด · สิทธิ์ · If-Match · แก้/ลบไม่ได้ (DB) · audit + event
 */
describe('payments (ST5-T13)', { timeout: 300_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let companyId: string;
  let branchId: string;
  let customerId: string;
  let otherCustomerId: string;
  let admin: string;
  let accounting: string;
  let manager: string;
  let invoicer: string;
  let viewer: string;
  let seq = 0;
  const today = bangkokToday();
  const uuid = (id: string) => tryDecodeId('payment', id)!;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท รับชำระ' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล จำกัด', taxId: validTaxId(1301) },
    });
    companyId = c.id;
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
        data: { tenantId, code: 'C-PAY', legalName: 'ลูกค้า รับชำระ', taxId: validTaxId(1302) },
      })
    ).id;
    otherCustomerId = (
      await db.customer.create({
        data: { tenantId, code: 'C-PAY2', legalName: 'ลูกค้า อื่น', taxId: validTaxId(1303) },
      })
    ).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    manager = await tokenFor(tenantId, SYSTEM_ROLES.manager.permissions.join(' '), 'u-mgr');
    invoicer = await tokenFor(tenantId, SYSTEM_ROLES.invoicer.permissions.join(' '), 'u-inv');
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  /** ใบแจ้งหนี้ที่ออกแล้ว (ข้อมูล ณ วันออกครบตาม CHECK 0140) */
  const issued = async (total: string, opts: { cust?: string; due?: string } = {}) => {
    const n = ++seq;
    const inv = await db.invoice.create({
      data: {
        tenantId,
        customerId: opts.cust ?? customerId,
        issuingCompanyId: companyId,
        issuingBranchId: branchId,
        status: 'ISSUED',
        totalAmount: total,
        subtotalExempt: total,
        ...issuedTestFields(`INV-PAY-${n}`),
        ...(opts.due
          ? {
              issueDate: new Date(`${addDays(opts.due, -30)}T00:00:00.000Z`),
              dueDate: new Date(`${opts.due}T00:00:00.000Z`),
            }
          : {}),
      },
    });
    return encodeId('invoice', inv.id);
  };
  const pay = (token: string, body: object) => api(app, token).post('/v1/payments').send(body);
  const one = (invoiceId: string, amount: string, extra: object = {}) => ({
    receivedDate: today,
    method: 'TRANSFER',
    allocations: [{ invoiceId, amount }],
    ...extra,
  });
  const inv = async (id: string) =>
    (await api(app, admin).get(`/v1/invoices/${id}`).expect(200)).body;

  it('รับ 99% + WHT 1% → ใบเป็น PAID · ยอดคงค้าง 0 · audit + event payment.recorded', async () => {
    const id = await issued('25000.00');
    const r = await pay(
      accounting,
      one(id, '25000.00', {
        amountReceived: '24750.00',
        whtAmount: '250.00',
        whtCertificateNo: '2569/0412',
        reference: 'KBANK-778812',
      }),
    ).expect(201);
    expect(r.headers.etag).toBe('"1"');
    expect(r.body).toMatchObject({
      paymentNo: expect.stringMatching(/^PAY-\d{4}-0001$/),
      method: 'TRANSFER',
      status: 'RECORDED',
      chequeStatus: null,
      sellAmountReceived: '24750.00',
      sellWhtAmount: '250.00',
      sellAppliedTotal: '25000.00',
      whtCertificateNo: '2569/0412',
      allocations: [
        {
          invoiceId: id,
          invoiceNo: expect.any(String),
          sellAmount: '25000.00',
          sellWhtAmount: '250.00',
        },
      ],
    });
    expect(await inv(id)).toMatchObject({
      status: 'PAID',
      sellPaidAmount: '25000.00',
      sellOutstanding: '0.00',
      version: 2,
    });
    const audit = await db.auditLog.findFirst({
      where: { tenantId, action: 'payment.recorded', entityId: uuid(r.body.id) },
    });
    expect(audit?.actorId).toBe('u-acc');
    const ev = await db.domainEvent.findFirst({
      where: { tenantId, type: 'payment.recorded', localId: uuid(r.body.id) },
    });
    expect(ev?.snapshot).toMatchObject({ id: r.body.id, status: 'RECORDED' });
    expect(JSON.stringify(ev?.snapshot)).not.toMatch(/sell|amount/i);
    // ใบที่ชำระครบรับเพิ่มไม่ได้
    await pay(accounting, one(id, '1.00', { amountReceived: '1.00' }))
      .expect(409)
      .expect((x) => expect(x.body.code).toBe('invoice_not_payable'));
  });

  it('รับบางส่วน → PARTIALLY_PAID · รับส่วนที่เหลือ → PAID · reverse แล้วยอดค้างกลับมา', async () => {
    const id = await issued('10000.00');
    const p1 = (
      await pay(accounting, one(id, '4000.00', { amountReceived: '4000.00' })).expect(201)
    ).body;
    expect(await inv(id)).toMatchObject({
      status: 'PARTIALLY_PAID',
      sellPaidAmount: '4000.00',
      sellOutstanding: '6000.00',
    });
    // ตัดเกินคงค้าง → 409
    await pay(accounting, one(id, '6000.01', { amountReceived: '6000.01' }))
      .expect(409)
      .expect((x) =>
        expect(x.body).toMatchObject({
          code: 'payment_exceeds_outstanding',
          invoiceId: id,
          outstanding: '6000.00',
        }),
      );
    const p2 = (
      await pay(
        accounting,
        one(id, '6000.00', {
          amountReceived: '5930.00',
          whtAmount: '60.00',
          feeAmount: '10.00',
        }),
      ).expect(201)
    ).body;
    expect(p2.sellFeeAmount).toBe('10.00');
    expect((await inv(id)).status).toBe('PAID');

    // กลับรายการ: บัญชีทำเองไม่ได้ (spec/05 §19 void = manager) · If-Match บังคับ · เหตุผลบังคับ
    await api(app, accounting)
      .post(`/v1/payments/${p2.id}/reverse`)
      .set('If-Match', '"1"')
      .send({ reason: 'บันทึกยอดผิด ต้องแก้ไข' })
      .expect(403);
    await api(app, manager)
      .post(`/v1/payments/${p2.id}/reverse`)
      .send({ reason: 'บันทึกยอดผิด ต้องแก้ไข' })
      .expect(422)
      .expect((x) => expect(x.body.errors[0].code).toBe('if_match_required'));
    await api(app, manager)
      .post(`/v1/payments/${p2.id}/reverse`)
      .set('If-Match', '"1"')
      .send({ reason: 'สั้น' })
      .expect(422);
    await api(app, manager)
      .post(`/v1/payments/${p2.id}/reverse`)
      .set('If-Match', '"9"')
      .send({ reason: 'บันทึกยอดผิด ต้องแก้ไข' })
      .expect(412);
    const rv = await api(app, manager)
      .post(`/v1/payments/${p2.id}/reverse`)
      .set('If-Match', '"1"')
      .send({ reason: 'บันทึกยอดผิด ต้องแก้ไข' })
      .expect(200);
    expect(rv.body).toMatchObject({
      status: 'REVERSED',
      reverseReason: 'บันทึกยอดผิด ต้องแก้ไข',
      reversedBy: 'u-mgr',
      version: 2,
    });
    expect(await inv(id)).toMatchObject({
      status: 'PARTIALLY_PAID',
      sellPaidAmount: '4000.00',
      sellOutstanding: '6000.00',
    });
    // กลับรายการซ้ำไม่ได้
    await api(app, manager)
      .post(`/v1/payments/${p2.id}/reverse`)
      .set('If-Match', '"2"')
      .send({ reason: 'บันทึกยอดผิด ต้องแก้ไข' })
      .expect(409);
    await api(app, manager)
      .post(`/v1/payments/${p1.id}/reverse`)
      .set('If-Match', '"1"')
      .send({ reason: 'ลูกค้าโอนผิดบัญชี คืนเงินแล้ว' })
      .expect(200);
    expect(await inv(id)).toMatchObject({
      status: 'ISSUED',
      sellPaidAmount: '0.00',
      sellOutstanding: '10000.00',
    });
    const a = await db.auditLog.findFirst({
      where: { tenantId, action: 'payment.reversed', entityId: uuid(p1.id) },
    });
    expect(a?.reason).toBe('ลูกค้าโอนผิดบัญชี คืนเงินแล้ว');
    expect(
      await db.domainEvent.count({ where: { tenantId, type: 'payment.reversed' } }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('เช็ค: เลขเช็ค/ธนาคาร/วันที่เช็ค บังคับ · รอเคลียร์ → ผ่าน · เช็คคืน = กลับรายการ ยอดค้างกลับมา', async () => {
    const id = await issued('5000.00');
    const bad = await pay(
      accounting,
      one(id, '5000.00', { method: 'CHEQUE', amountReceived: '5000.00' }),
    ).expect(422);
    expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'chequeBank',
      'chequeDate',
      'chequeNo',
    ]);
    await pay(
      accounting,
      one(id, '5000.00', { amountReceived: '5000.00', chequeNo: '1234567' }),
    ).expect(422);
    const cheque = {
      method: 'CHEQUE',
      chequeNo: '0012345',
      chequeBank: 'กสิกรไทย สาขาบางนา',
      chequeDate: addDays(today, 7),
      amountReceived: '4950.00',
      whtAmount: '50.00',
    };
    const p = (await pay(accounting, one(id, '5000.00', cheque)).expect(201)).body;
    expect(p).toMatchObject({
      method: 'CHEQUE',
      chequeNo: '0012345',
      chequeBank: 'กสิกรไทย สาขาบางนา',
      chequeDate: addDays(today, 7),
      chequeStatus: 'PENDING',
    });
    expect((await inv(id)).status).toBe('PAID');
    const cl = await api(app, accounting)
      .post(`/v1/payments/${p.id}/clear`)
      .set('If-Match', '"1"')
      .expect(200);
    expect(cl.body.chequeStatus).toBe('CLEARED');
    await api(app, accounting)
      .post(`/v1/payments/${p.id}/clear`)
      .set('If-Match', '"2"')
      .expect(409);
    const b = await api(app, manager)
      .post(`/v1/payments/${p.id}/bounce`)
      .set('If-Match', '"2"')
      .send({ reason: 'เช็คคืน เงินในบัญชีไม่พอจ่าย' })
      .expect(200);
    expect(b.body).toMatchObject({ status: 'REVERSED', chequeStatus: 'BOUNCED' });
    expect(await inv(id)).toMatchObject({ status: 'ISSUED', sellOutstanding: '5000.00' });
    const a = await db.auditLog.findFirst({
      where: { tenantId, action: 'payment.cheque_bounced', entityId: uuid(p.id) },
    });
    expect(a?.reason).toBe('เช็คคืน เงินในบัญชีไม่พอจ่าย');
    const ev = await db.domainEvent.findFirst({
      where: { tenantId, type: 'payment.reversed', localId: uuid(p.id) },
    });
    expect(ev?.snapshot).toMatchObject({ chequeStatus: 'BOUNCED', status: 'REVERSED' });
    expect(ev?.previousAttributes).toMatchObject({ status: 'RECORDED', chequeStatus: 'CLEARED' });
    // โอนเงิน → เช็คคืนไม่ได้
    const t = (await pay(accounting, one(id, '100.00', { amountReceived: '100.00' })).expect(201))
      .body;
    await api(app, manager)
      .post(`/v1/payments/${t.id}/bounce`)
      .set('If-Match', '"1"')
      .send({ reason: 'เช็คคืน เงินในบัญชีไม่พอจ่าย' })
      .expect(409);
  });

  it('สมการยอด (BIL-051) · วันที่อนาคต · ส่วนต่างต้องมีเหตุผล · ร่าง/ลูกค้าต่างกัน · หลายใบ', async () => {
    const id = await issued('3000.00');
    const u = await pay(
      accounting,
      one(id, '3000.00', { amountReceived: '2900.00', whtAmount: '30.00' }),
    ).expect(422);
    expect(u.body.errors).toEqual([
      expect.objectContaining({ field: 'allocations', code: 'payment_unbalanced' }),
    ]);
    await pay(
      accounting,
      one(id, '100.00', { amountReceived: '100.00', receivedDate: addDays(today, 1) }),
    )
      .expect(422)
      .expect((x) => expect(x.body.errors[0].code).toBe('date_in_future'));
    const d = await pay(
      accounting,
      one(id, '3000.00', { amountReceived: '2995.00', differenceAmount: '5.00' }),
    ).expect(422);
    expect(d.body.errors[0]).toMatchObject({ field: 'differenceReason', code: 'required' });
    const ok = await pay(
      accounting,
      one(id, '3000.00', {
        amountReceived: '2995.00',
        differenceAmount: '5.00',
        differenceReason: 'ลูกค้าโอนขาด ยอมตัดส่วนต่างเศษสตางค์',
      }),
    ).expect(201);
    expect(ok.body.sellDifferenceAmount).toBe('5.00');
    expect((await inv(id)).status).toBe('PAID');

    // ร่าง → รับชำระไม่ได้
    const draft = await db.invoice.create({
      data: {
        tenantId,
        customerId,
        issuingCompanyId: companyId,
        issuingBranchId: branchId,
        totalAmount: '100.00',
      },
    });
    await pay(
      accounting,
      one(encodeId('invoice', draft.id), '100.00', { amountReceived: '100.00' }),
    )
      .expect(409)
      .expect((x) => expect(x.body.code).toBe('invoice_not_payable'));

    // หลายใบของลูกค้าเดียว: WHT ต่อใบต้องส่ง และรวม = whtAmount
    const a = await issued('2000.00');
    const b = await issued('1000.00');
    await pay(accounting, {
      receivedDate: today,
      method: 'CASH',
      amountReceived: '2970.00',
      whtAmount: '30.00',
      allocations: [
        { invoiceId: a, amount: '2000.00' },
        { invoiceId: b, amount: '1000.00' },
      ],
    }).expect(422);
    const m = await pay(accounting, {
      receivedDate: today,
      method: 'CASH',
      amountReceived: '2970.00',
      whtAmount: '30.00',
      allocations: [
        { invoiceId: a, amount: '2000.00', whtAmount: '20.00' },
        { invoiceId: b, amount: '1000.00', whtAmount: '10.00' },
      ],
    }).expect(201);
    expect(m.body.allocations).toHaveLength(2);
    expect((await inv(a)).status).toBe('PAID');
    expect((await inv(b)).status).toBe('PAID');
    // ลูกค้าต่างกันในการรับชำระเดียว → 422
    const c = await issued('500.00', { cust: otherCustomerId });
    const e = await issued('500.00');
    await pay(accounting, {
      receivedDate: today,
      method: 'CASH',
      amountReceived: '1000.00',
      allocations: [
        { invoiceId: c, amount: '500.00' },
        { invoiceId: e, amount: '500.00' },
      ],
    })
      .expect(422)
      .expect((x) => expect(x.body.errors[0].code).toBe('mixed_customers'));
  });

  it('review M1/L2/L4: ส่วนต่างเกินวงเงิน (BIL-059) ต้องผู้จัดการ · OFFSET ปิด · วันที่รับก่อนวันออกใบไม่ได้ · KPI นับเงินเข้าจริง', async () => {
    const id = await issued('1000.00');
    const reason = { differenceReason: 'ลูกค้าขอส่วนลดพิเศษ ผู้จัดการอนุมัติ' };
    const before = (await api(app, admin).get('/v1/payments/summary').expect(200)).body;
    await pay(
      accounting,
      one(id, '1000.00', { amountReceived: '0.00', differenceAmount: '1000.00', ...reason }),
    )
      .expect(403)
      .expect((x) =>
        expect(x.body).toMatchObject({
          code: 'payment_difference_over_limit',
          maxDifferenceAmount: '10.00',
        }),
      );
    // ≤ วงเงิน (10 บาท) บัญชีทำเองได้
    await pay(
      accounting,
      one(id, '100.00', { amountReceived: '90.00', differenceAmount: '10.00', ...reason }),
    ).expect(201);
    // ผู้จัดการ (payments:reverse) เกินวงเงินได้ — ไม่นับเป็นเงินรับเดือนนี้
    await pay(
      manager,
      one(id, '900.00', { amountReceived: '0.00', differenceAmount: '900.00', ...reason }),
    ).expect(201);
    expect((await inv(id)).status).toBe('PAID');
    const after = (await api(app, admin).get('/v1/payments/summary').expect(200)).body;
    expect(Number(after.sellReceivedThisMonth) - Number(before.sellReceivedThisMonth)).toBe(90);
    // OFFSET (หักกลบลบหนี้) ปิดจนมีเครดิตลูกค้า (BIL-058)
    const id2 = await issued('500.00');
    await pay(accounting, one(id2, '500.00', { method: 'OFFSET', amountReceived: '500.00' }))
      .expect(422)
      .expect((x) => expect(x.body.errors[0].code).toBe('method_not_available'));
    // วันที่รับก่อนวันออกใบ (issuedTestFields = 2026-11-20)
    await pay(
      accounting,
      one(id2, '500.00', { amountReceived: '500.00', receivedDate: '2026-11-19' }),
    )
      .expect(422)
      .expect((x) => expect(x.body.errors[0].code).toBe('before_invoice_issue'));
  });

  it('พร้อมกัน: 2 การรับชำระตัดใบเดียวกันเกินคงค้าง → สำเร็จ 1 อีก 1 ได้ 409', async () => {
    const id = await issued('1000.00');
    const body = one(id, '600.00', { amountReceived: '600.00' });
    const rs = await Promise.all([pay(accounting, body), pay(manager, body)]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await inv(id)).toMatchObject({
      status: 'PARTIALLY_PAID',
      sellPaidAmount: '600.00',
      sellOutstanding: '400.00',
    });
  });

  it('สิทธิ์: viewer อ่านได้แต่ไม่เห็นยอด · บันทึกไม่ได้ · invoicer บันทึกไม่ได้', async () => {
    const id = await issued('700.00');
    await pay(viewer, one(id, '700.00', { amountReceived: '700.00' })).expect(403);
    await pay(invoicer, one(id, '700.00', { amountReceived: '700.00' })).expect(403);
    const p = (await pay(manager, one(id, '700.00', { amountReceived: '700.00' })).expect(201))
      .body;
    const v = await api(app, viewer).get(`/v1/payments/${p.id}`).expect(200);
    expect(v.body).not.toHaveProperty('sellAmountReceived');
    expect(v.body.allocations[0]).not.toHaveProperty('sellAmount');
    const l = await api(app, viewer).get(`/v1/payments?invoiceId=${id}`).expect(200);
    expect(l.body.data.map((x: { id: string }) => x.id)).toEqual([p.id]);
  });

  it('DB: แก้ยอด/ลบการรับชำระ และแก้/ลบการตัดชำระไม่ได้ · CHECK ยอดตัดเกินยอดรวม', async () => {
    const id = await issued('800.00');
    const p = (await pay(accounting, one(id, '800.00', { amountReceived: '800.00' })).expect(201))
      .body;
    const pid = uuid(p.id);
    await expect(
      db.payment.update({ where: { id: pid }, data: { amountReceived: '1.00' } }),
    ).rejects.toThrow(/payment_immutable|content cannot change/);
    await expect(db.payment.delete({ where: { id: pid } })).rejects.toThrow(
      /payment_no_delete|cannot be deleted/,
    );
    await expect(
      db.paymentAllocation.updateMany({ where: { paymentId: pid }, data: { amount: '1.00' } }),
    ).rejects.toThrow(/payment_allocation_immutable|cannot change/);
    await expect(db.paymentAllocation.deleteMany({ where: { paymentId: pid } })).rejects.toThrow(
      /payment_allocation_immutable|cannot change/,
    );
    await expect(
      db.invoice.update({
        where: { id: tryDecodeId('invoice', id)! },
        data: { paidAmount: '900.00' },
      }),
    ).rejects.toThrow(/invoice_paid_amount_check/);
  });

  it('สรุป KPI + รายการใบหน้า "รับชำระ" (ค้างรับ / เกินกำหนด)', async () => {
    const over = await issued('1200.00', { due: addDays(today, -3) });
    const soon = await issued('300.00', { due: addDays(today, 2) });
    const s = (await api(app, admin).get('/v1/payments/summary').expect(200)).body;
    expect(s.overdue).toBeGreaterThanOrEqual(1);
    expect(s.dueSoon).toBeGreaterThanOrEqual(1);
    expect(Number(s.sellOverdueOutstanding)).toBeGreaterThanOrEqual(1200);
    expect(Number(s.sellReceivedThisMonth)).toBeGreaterThan(0);
    const overList = (
      await api(app, admin).get('/v1/invoices?receivable=overdue&limit=200').expect(200)
    ).body.data.map((x: { id: string }) => x.id);
    expect(overList).toContain(over);
    expect(overList).not.toContain(soon);
    const all = (await api(app, admin).get('/v1/invoices?receivable=all&limit=200').expect(200))
      .body.data as { status: string }[];
    expect(all.every((x) => ['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(x.status))).toBe(true);
    const viewerSum = (await api(app, viewer).get('/v1/payments/summary').expect(200)).body;
    expect(viewerSum).not.toHaveProperty('sellOutstanding');
  });
});
