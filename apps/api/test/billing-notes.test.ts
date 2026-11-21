import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
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
 * ST5-T11 ใบวางบิล (`billing_note`) — D-54 บัญชีเบา (ไม่ใช่เอกสารภาษี ไม่กระทบ VAT/WHT)
 * เกณฑ์ตรวจรับ: รวม 3 ใบแจ้งหนี้เป็นใบวางบิล 1 ใบ ยอดรวมตรง · ใบแจ้งหนี้เดียวอยู่ 2 ใบวางบิลที่ active ไม่ได้
 * + DRAFT → ISSUED (เลข BN + PDF) → COLLECTED · ผู้รับวางบิล · ยกเลิก (เหตุผล + สิทธิ์) · สิทธิ์ราคา · guard ระดับ DB
 */
describe('billing notes (ST5-T11)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherTenant: string;
  let companyId: string;
  let branchId: string;
  let branch2Id: string;
  let customerId: string;
  let customer2Id: string;
  let admin: string;
  let drafter: string;
  let viewer: string;
  let noPrice: string;
  let seq = 0;
  const today = bangkokToday();
  const addDays = (d: string, n: number) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท วางบิล' })).id;
    otherTenant = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้วางบิล จำกัด', taxId: validTaxId(911) },
    });
    companyId = c.id;
    branchId = (
      await db.branch.create({
        data: {
          tenantId,
          companyId,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: ADDR,
          isDefaultIssuer: true,
        },
      })
    ).id;
    branch2Id = (
      await db.branch.create({
        data: { tenantId, companyId, branchCode: '00001', branchLabel: 'สาขา 1', address: ADDR },
      })
    ).id;
    customerId = (
      await db.customer.create({
        data: {
          tenantId,
          code: 'C-BN-1',
          legalName: 'บริษัท ลูกค้าวางบิล จำกัด',
          taxId: validTaxId(912),
          branchCode: '00000',
          billingAddress: ADDR,
        },
      })
    ).id;
    customer2Id = (
      await db.customer.create({
        data: { tenantId, code: 'C-BN-2', legalName: 'ลูกค้าอีกราย', taxId: validTaxId(913) },
      })
    ).id;
    admin = await tokenFor(tenantId);
    drafter = await tokenFor(
      tenantId,
      'invoices:read invoices:draft prices.sell:read',
      'u-drafter',
    );
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
    noPrice = await tokenFor(tenantId, 'invoices:read invoices:draft', 'u-noprice');
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  /** ใบแจ้งหนี้ที่ออกแล้ว (ตั้งตรงในฐาน — การออกใบเต็มทดสอบใน invoice-finalize.test.ts) */
  async function issuedInvoice(
    total: string,
    wht = '0.00',
    o: {
      customer?: string;
      branch?: string;
      status?: 'ISSUED' | 'DRAFT' | 'PAID';
      tenant?: string;
    } = {},
  ) {
    const n = ++seq;
    const status = o.status ?? 'ISSUED';
    const inv = await db.invoice.create({
      data: {
        tenantId: o.tenant ?? tenantId,
        customerId: o.customer ?? customerId,
        issuingCompanyId: companyId,
        issuingBranchId: o.branch ?? branchId,
        status,
        totalAmount: new Prisma.Decimal(total),
        subtotalExempt: new Prisma.Decimal(total),
        whtExpectedAmount: new Prisma.Decimal(wht),
        netExpectedAmount: new Prisma.Decimal(total).minus(wht),
        ...(status === 'DRAFT' ? {} : issuedTestFields(`INV-T11-${String(n).padStart(4, '0')}`)),
      },
    });
    return encodeId('invoice', inv.id);
  }
  const cus = (id = customerId) => encodeId('customer', id);
  const create = (token: string, invoiceIds: string[], extra: object = {}) =>
    api(app, token)
      .post('/v1/billing-notes')
      .send({ customerId: cus(), invoiceIds, ...extra });

  it('route: /summary และ /candidates ประกาศก่อน /:id', async () => {
    await api(app, admin).get('/v1/billing-notes/summary').expect(200);
    await api(app, admin).get(`/v1/billing-notes/candidates?customerId=${cus()}`).expect(200);
  });

  it('เกณฑ์ตรวจรับ: รวม 3 ใบแจ้งหนี้เป็นใบวางบิล 1 ใบ ยอดรวมตรง (ร่าง ไม่มีเลข)', async () => {
    const ids = [
      await issuedInvoice('7000.00', '70.00'),
      await issuedInvoice('12194.50', '121.95'),
      await issuedInvoice('6550.00', '64.55'),
    ];
    const r = await create(drafter, ids, { collectionDate: addDays(today, 14) }).expect(201);
    expect(r.body.status).toBe('DRAFT');
    expect(r.body.billingNoteNo).toBeNull();
    expect(r.body.invoiceCount).toBe(3);
    expect(r.body.invoices.map((i: { invoiceId: string }) => i.invoiceId)).toEqual(ids);
    expect(r.body.sellTotal).toBe('25744.50');
    expect(r.body.sellWhtExpected).toBe('256.50');
    expect(r.body.sellNetExpected).toBe('25488.00');
    expect(r.headers.etag).toBe('"1"');
    const row = await db.billingNote.findUniqueOrThrow({
      where: { id: tryDecodeId('billingNote', r.body.id)! },
    });
    expect(row.totalAmount.toFixed(2)).toBe('25744.50');
    const audit = await db.auditLog.findFirst({
      where: { tenantId, entityId: row.id, action: 'billing_note.draft_created' },
    });
    expect(audit).not.toBeNull();
  });

  it('ST5-T13: ใบที่ชำระบางส่วน ใส่ใบวางบิลได้ · ยอดในใบวางบิล = คงค้าง · WHT = ส่วนที่ยังไม่ถูกหัก · ชำระครบแล้วใส่ไม่ได้', async () => {
    const id = await issuedInvoice('10000.00', '100.00');
    const paid = await issuedInvoice('500.00');
    const pay = (invoiceId: string, amount: string, wht = '0.00') =>
      api(app, admin)
        .post('/v1/payments')
        .send({
          receivedDate: today,
          method: 'TRANSFER',
          amountReceived: new Prisma.Decimal(amount).minus(wht).toFixed(2),
          whtAmount: wht,
          allocations: [{ invoiceId, amount }],
        })
        .expect(201);
    await pay(id, '4000.00', '40.00');
    await pay(paid, '500.00');
    const cand = (
      await api(app, admin).get(`/v1/billing-notes/candidates?customerId=${cus()}`).expect(200)
    ).body.data as {
      invoiceId: string;
      status: string;
      sellOutstanding: string;
      sellWhtExpected: string;
    }[];
    expect(cand.find((c) => c.invoiceId === id)).toMatchObject({
      status: 'PARTIALLY_PAID',
      sellOutstanding: '6000.00',
      sellWhtExpected: '60.00',
    });
    expect(cand.map((c) => c.invoiceId)).not.toContain(paid);
    const r = await create(drafter, [id]).expect(201);
    expect(r.body).toMatchObject({
      sellTotal: '6000.00',
      sellWhtExpected: '60.00',
      sellNetExpected: '5940.00',
    });
    expect(r.body.invoices[0]).toMatchObject({ sellTotal: '10000.00', sellOutstanding: '6000.00' });
    await create(drafter, [paid])
      .expect(409)
      .expect((x) => expect(x.body.code).toBe('invoice_not_billable'));
  });

  it('เกณฑ์ตรวจรับ: ใบแจ้งหนี้เดียวอยู่ 2 ใบวางบิลที่ active ไม่ได้ (409 + พร้อมกัน) · candidates ไม่แสดงใบที่ติดแล้ว', async () => {
    const a = await issuedInvoice('1000.00');
    const b = await issuedInvoice('2000.00');
    const first = await create(drafter, [a]).expect(201);
    const dup = await create(drafter, [b, a]).expect(409);
    expect(dup.body.code).toBe('invoice_already_billed');
    expect(dup.body.invoices).toEqual([
      expect.objectContaining({ invoiceId: a, billingNoteId: first.body.id, billingNoteNo: null }),
    ]);
    // ไม่มีอะไรค้าง (ทั้งคำขอย้อน)
    const cand = (
      await api(app, drafter).get(`/v1/billing-notes/candidates?customerId=${cus()}`).expect(200)
    ).body.data.map((x: { invoiceId: string }) => x.invoiceId);
    expect(cand).toContain(b);
    expect(cand).not.toContain(a);
    // สองคำขอพร้อมกัน → ได้ใบเดียว (unique partial ระดับ DB)
    const c = await issuedInvoice('3000.00');
    const res = await Promise.all([
      create(drafter, [c]),
      create(drafter, [c]),
      create(drafter, [c]),
    ]);
    expect(res.map((x) => x.status).sort()).toEqual([201, 409, 409]);
    expect(
      await db.billingNoteInvoice.count({
        where: { invoiceId: tryDecodeId('invoice', c)!, active: true },
      }),
    ).toBe(1);
  });

  it('ตรวจใบแจ้งหนี้: ลูกค้าอื่น 422 · ร่าง/ชำระแล้ว 409 invoice_not_billable · ผู้ออกต่างสาขา 422 · id ของ tenant อื่น 422', async () => {
    const own = await issuedInvoice('100.00');
    const other = await issuedInvoice('100.00', '0.00', { customer: customer2Id });
    const r1 = await create(drafter, [own, other]).expect(422);
    expect(r1.body.errors[0].code).toBe('customer_mismatch');
    const draft = await issuedInvoice('100.00', '0.00', { status: 'DRAFT' });
    const paid = await issuedInvoice('100.00', '0.00', { status: 'PAID' });
    const r2 = await create(drafter, [own, draft, paid]).expect(409);
    expect(r2.body.code).toBe('invoice_not_billable');
    expect(r2.body.invoices.map((x: { status: string }) => x.status).sort()).toEqual([
      'DRAFT',
      'PAID',
    ]);
    const br2 = await issuedInvoice('100.00', '0.00', { branch: branch2Id });
    const r3 = await create(drafter, [own, br2]).expect(422);
    expect(r3.body.errors[0].code).toBe('issuer_mismatch');
    const foreign = encodeId(
      'invoice',
      (
        await db.invoice.create({
          data: {
            tenantId: otherTenant,
            customerId: (
              await db.customer.create({
                data: { tenantId: otherTenant, code: 'X', legalName: 'X' },
              })
            ).id,
            issuingCompanyId: (
              await db.company.create({
                data: { tenantId: otherTenant, legalName: 'X', taxId: validTaxId(914) },
              })
            ).id,
            issuingBranchId: branchId,
          },
        })
      ).id,
    );
    const r4 = await create(drafter, [foreign]).expect(422);
    expect(r4.body.errors[0].code).toBe('invalid_reference');
  });

  it('DRAFT → ISSUED → COLLECTED: ออกเลข BN, วันวางบิล = วันนี้, PDF ต้นฉบับเก็บ, ล็อก, ผู้รับวางบิล, ใบแจ้งหนี้วางบิลใหม่ได้หลังเก็บเงิน', async () => {
    const ids = [await issuedInvoice('5000.00', '50.00'), await issuedInvoice('2500.00', '25.00')];
    const d = await create(drafter, ids).expect(201);
    const id = d.body.id as string;
    // If-Match บังคับ · ต้องมีวันนัดรับเช็คก่อน · drafter ไม่มี invoices:finalize
    await api(app, drafter)
      .post(`/v1/billing-notes/${id}/finalize`)
      .set('If-Match', '"1"')
      .expect(403);
    const noIfMatch = await api(app, admin).post(`/v1/billing-notes/${id}/finalize`).expect(422);
    expect(noIfMatch.body.errors[0].code).toBe('if_match_required');
    const noDate = await api(app, admin)
      .post(`/v1/billing-notes/${id}/finalize`)
      .set('If-Match', '"1"')
      .expect(422);
    expect(noDate.body.errors[0]).toMatchObject({ field: 'collectionDate', code: 'required' });
    const past = await api(app, drafter)
      .patch(`/v1/billing-notes/${id}`)
      .set('If-Match', '"1"')
      .send({ collectionDate: addDays(today, -1), note: 'โอนเข้าบัญชีกสิกร' })
      .expect(200);
    const before = await api(app, admin)
      .post(`/v1/billing-notes/${id}/finalize`)
      .set('If-Match', `"${past.body.version}"`)
      .expect(422);
    expect(before.body.errors[0].code).toBe('before_billing_date');
    const ok = await api(app, drafter)
      .patch(`/v1/billing-notes/${id}`)
      .set('If-Match', `"${past.body.version}"`)
      .send({ collectionDate: addDays(today, 10) })
      .expect(200);
    await api(app, admin)
      .post(`/v1/billing-notes/${id}/finalize`)
      .set('If-Match', `"${ok.body.version - 1}"`)
      .expect(412);
    // ร่างมี PDF ตัวอย่าง · ยังไม่มี /pdf
    const pf = await api(app, drafter).get(`/v1/billing-notes/${id}/proforma`).expect(200);
    expect(pf.headers['content-type']).toContain('application/pdf');
    await api(app, drafter).get(`/v1/billing-notes/${id}/pdf`).expect(409);
    const iss = await api(app, admin)
      .post(`/v1/billing-notes/${id}/finalize`)
      .set('If-Match', `"${ok.body.version}"`)
      .expect(200);
    expect(iss.body.status).toBe('ISSUED');
    expect(iss.body.billingNoteNo).toMatch(/^BN-\d{4}-\d{4}$/);
    expect(iss.body.billingDate).toBe(today);
    expect(iss.body.collectionDate).toBe(addDays(today, 10));
    expect(iss.body.sellTotal).toBe('7500.00');
    expect(iss.body.pdf).toMatchObject({ filename: `${iss.body.billingNoteNo}.pdf` });
    const pdf = await api(app, admin).get(`/v1/billing-notes/${id}/pdf`).expect(200);
    expect(pdf.headers['x-content-sha256']).toBe(iss.body.pdf.sha256);
    const copy = await api(app, admin).get(`/v1/billing-notes/${id}/pdf?copy=COPY`).expect(200);
    expect(copy.headers['x-content-sha256']).not.toBe(iss.body.pdf.sha256);
    await api(app, admin).get(`/v1/billing-notes/${id}/proforma`).expect(409);
    // หลังออก: แก้ไม่ได้
    await api(app, drafter)
      .patch(`/v1/billing-notes/${id}`)
      .send({ note: 'แก้หลังออก' })
      .expect(409);
    // DB: เนื้อหาแก้ไม่ได้ / ลบไม่ได้ (ทุก role)
    const uid = tryDecodeId('billingNote', id)!;
    await expect(
      db.billingNote.update({ where: { id: uid }, data: { totalAmount: new Prisma.Decimal(1) } }),
    ).rejects.toThrow(/billing_note_issued_immutable|content cannot change/);
    await expect(
      db.billingNoteInvoice.updateMany({
        where: { billingNoteId: uid },
        data: { active: false, removedAt: new Date() },
      }),
    ).rejects.toThrow(/issued/);
    const audit = await db.auditLog.findFirst({
      where: { tenantId, entityId: uid, action: 'billing_note.issued' },
    });
    expect(audit?.after).toMatchObject({ billingNoteNo: iss.body.billingNoteNo });
    // ใบแจ้งหนี้ใน BN ที่ออกแล้ว ยังใส่ใบใหม่ไม่ได้
    expect((await create(drafter, [ids[0]!]).expect(409)).body.code).toBe('invoice_already_billed');
    // L1: ใบแจ้งหนี้บอกใบวางบิลที่อยู่ (docs/01 invoice.billing_note_id)
    expect(
      (await api(app, admin).get(`/v1/invoices/${ids[0]}`).expect(200)).body.billingNoteId,
    ).toBe(id);
    // M2: ใบแจ้งหนี้ในใบวางบิลที่ออกแล้ว ยกเลิก/void ไม่ได้ (guard ระดับ DB — ยกเลิกใบวางบิลก่อน)
    await expect(
      db.invoice.update({
        where: { id: tryDecodeId('invoice', ids[0]!)! },
        data: { status: 'VOIDED' },
      }),
    ).rejects.toThrow(/invoice_on_issued_billing_note|cancel the billing note first/);

    // ผู้รับวางบิล
    const fut = await api(app, admin)
      .post(`/v1/billing-notes/${id}/acknowledge`)
      .send({ receivedBy: 'คุณสมศรี', receivedOn: addDays(today, 1) })
      .expect(422);
    expect(fut.body.errors[0].code).toBe('future_date');
    const ack = await api(app, admin)
      .post(`/v1/billing-notes/${id}/acknowledge`)
      .set('If-Match', `"${iss.body.version}"`)
      .send({ receivedBy: 'คุณสมศรี (บัญชี)', receivedOn: today })
      .expect(200);
    expect(ack.body.acknowledgement).toMatchObject({ name: 'คุณสมศรี (บัญชี)', receivedOn: today });
    expect(ack.body.status).toBe('ISSUED');

    // รับเช็ค/โอนแล้ว → COLLECTED (สิ้นสุด) · ผูกคงไว้ → วางบิลซ้ำไม่ได้ (review M1) · ยกเลิกไม่ได้
    const col = await api(app, admin)
      .post(`/v1/billing-notes/${id}/collect`)
      .set('If-Match', `"${ack.body.version}"`)
      .send({ note: 'เช็คกสิกร 0012345' })
      .expect(200);
    expect(col.body.status).toBe('COLLECTED');
    expect(col.body.invoiceCount).toBe(2);
    expect(col.body.invoices.every((i: { active: boolean }) => i.active)).toBe(true);
    await api(app, admin)
      .post(`/v1/billing-notes/${id}/cancel`)
      .send({ reason: 'ทดสอบยกเลิกหลังเก็บเงิน' })
      .expect(409);
    await api(app, admin).post(`/v1/billing-notes/${id}/collect`).expect(409);
    expect((await create(drafter, [ids[0]!]).expect(409)).body.code).toBe('invoice_already_billed');
    const cand = (
      await api(app, drafter).get(`/v1/billing-notes/candidates?customerId=${cus()}`).expect(200)
    ).body.data.map((x: { invoiceId: string }) => x.invoiceId);
    expect(cand).not.toContain(ids[0]);
    expect(await db.billingNoteInvoice.count({ where: { billingNoteId: uid, active: true } })).toBe(
      2,
    );
    await expect(
      db.invoice.update({
        where: { id: tryDecodeId('invoice', ids[1]!)! },
        data: { status: 'VOIDED' },
      }),
    ).rejects.toThrow(/cancel the billing note first/);
    // PDF ต้นฉบับยังได้หลังเก็บเงิน (ไฟล์เดิม)
    const again = await api(app, admin).get(`/v1/billing-notes/${id}/pdf`).expect(200);
    expect(again.headers['x-content-sha256']).toBe(iss.body.pdf.sha256);
  });

  it('ยกเลิก: เหตุผล ≥ 10 · ใบที่ออกแล้วต้องมี invoices:finalize · เลขคงอยู่ไม่ถูกใช้ซ้ำ · ใบแจ้งหนี้วางบิลใหม่ได้', async () => {
    const inv = await issuedInvoice('800.00');
    const d = await create(drafter, [inv], { collectionDate: addDays(today, 3) }).expect(201);
    const id = d.body.id as string;
    const iss = await api(app, admin)
      .post(`/v1/billing-notes/${id}/finalize`)
      .set('If-Match', '"1"')
      .expect(200);
    await api(app, admin)
      .post(`/v1/billing-notes/${id}/cancel`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const denied = await api(app, drafter)
      .post(`/v1/billing-notes/${id}/cancel`)
      .send({ reason: 'ลูกค้าขอแยกวางบิลตามสาขา' })
      .expect(403);
    expect(denied.body.requiredScope).toBe('invoices:finalize');
    const c = await api(app, admin)
      .post(`/v1/billing-notes/${id}/cancel`)
      .send({ reason: 'ลูกค้าขอแยกวางบิลตามสาขา' })
      .expect(200);
    expect(c.body.status).toBe('CANCELLED');
    expect(c.body.billingNoteNo).toBe(iss.body.billingNoteNo);
    expect(c.body.cancelReason).toBe('ลูกค้าขอแยกวางบิลตามสาขา');
    // DTO ตรงกับฐาน: ยกเลิกแล้วผูกหยุดนับ (active=false) แต่ยังอยู่ในใบ (removed=false)
    expect(c.body.invoices).toEqual([expect.objectContaining({ active: false, removed: false })]);
    const audit = await db.auditLog.findFirst({
      where: {
        tenantId,
        entityId: tryDecodeId('billingNote', id)!,
        action: 'billing_note.cancelled',
      },
    });
    expect(audit?.reason).toBe('ลูกค้าขอแยกวางบิลตามสาขา');
    // ใบแจ้งหนี้กลับมาวางบิลได้ · ใบใหม่ได้เลขถัดไป
    const d2 = await create(drafter, [inv], { collectionDate: addDays(today, 3) }).expect(201);
    const iss2 = await api(app, admin)
      .post(`/v1/billing-notes/${d2.body.id}/finalize`)
      .set('If-Match', '"1"')
      .expect(200);
    expect(iss2.body.billingNoteNo).not.toBe(iss.body.billingNoteNo);
    expect(Number(iss2.body.billingNoteNo.slice(-4))).toBe(
      Number(iss.body.billingNoteNo.slice(-4)) + 1,
    );
    // ยกเลิกร่างได้ด้วย invoices:draft
    const d3 = await create(drafter, [await issuedInvoice('10.00')]).expect(201);
    await api(app, drafter)
      .post(`/v1/billing-notes/${d3.body.id}/cancel`)
      .set('If-Match', '"1"')
      .send({ reason: 'สร้างผิดลูกค้า ยกเลิก' })
      .expect(200);
  });

  it('แก้ร่าง: ถอด/ใส่ใบแจ้งหนี้ ยอดคำนวณใหม่ · ใบที่ถอดใส่ใบวางบิลอื่นได้', async () => {
    const [a, b, c] = [
      await issuedInvoice('100.00'),
      await issuedInvoice('200.00'),
      await issuedInvoice('300.00'),
    ];
    const d = await create(drafter, [a, b]).expect(201);
    expect(d.body.sellTotal).toBe('300.00');
    const u = await api(app, drafter)
      .patch(`/v1/billing-notes/${d.body.id}`)
      .set('If-Match', '"1"')
      .send({ invoiceIds: [b, c] })
      .expect(200);
    expect(u.body.sellTotal).toBe('500.00');
    expect(u.body.invoiceCount).toBe(2);
    expect(
      u.body.invoices.map((i: { invoiceId: string; removed: boolean }) => [
        i.invoiceId,
        !i.removed,
      ]),
    ).toEqual([
      [a, false],
      [b, true],
      [c, true],
    ]);
    await create(drafter, [a]).expect(201);
  });

  it('สิทธิ์: viewer อ่านได้ สร้างไม่ได้ · ไม่มี prices.sell:read ไม่เห็นยอด + PDF 403 · รายการ/จำนวนตามสถานะ', async () => {
    const d = await create(drafter, [await issuedInvoice('999.00')]).expect(201);
    await api(app, viewer).get(`/v1/billing-notes/${d.body.id}`).expect(200);
    await create(viewer, [await issuedInvoice('1.00')]).expect(403);
    const np = await api(app, noPrice).get(`/v1/billing-notes/${d.body.id}`).expect(200);
    expect(np.body.sellTotal).toBeUndefined();
    expect(np.body.invoices[0].sellOutstanding).toBeUndefined();
    await api(app, noPrice).get(`/v1/billing-notes/${d.body.id}/proforma`).expect(403);
    const list = await api(app, admin).get('/v1/billing-notes?status=DRAFT&limit=200').expect(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(list.body.data.every((x: { status: string }) => x.status === 'DRAFT')).toBe(true);
    const s = (await api(app, admin).get('/v1/billing-notes/summary').expect(200)).body;
    expect(s.total).toBe(s.draft + s.issued + s.collected + s.cancelled);
    expect(s.collected).toBeGreaterThanOrEqual(1);
    // tenant อื่นไม่เห็น
    const b = await tokenFor(otherTenant);
    await api(app, b).get(`/v1/billing-notes/${d.body.id}`).expect(404);
    expect((await api(app, b).get('/v1/billing-notes').expect(200)).body.data).toEqual([]);
  });
});
