import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { ProblemException } from '../src/common/problem';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  InvoiceBillingGuard,
  isActiveDoViolation,
  type DoInvoiceLineInput,
} from '../src/modules/invoices/billing-guard.service';
import { BillingQueueService } from '../src/modules/invoices/billing-queue.service';
import { OrderIntakeService } from '../src/modules/orders/order-intake.service';
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

/** ใบที่ยกเลิกต้องมีเวลา/ผู้ยกเลิก/เหตุผล (CHECK `invoice_cancelled_fields_check` — ST5-T10) */
const CANCEL = {
  cancelledAt: new Date(),
  cancelledBy: 'user-test',
  cancelReason: 'ยกเลิกร่างในการทดสอบ',
};

/**
 * ST5-T05 กันวางบิลซ้ำ — เกณฑ์ตรวจรับ: 2 request พร้อมกันดึง DO เดียวเข้า 2 draft → สำเร็จ 1 อีก 1 ได้ 409
 * พิสูจน์ด้วย transaction จริงพร้อมกันบน PostgreSQL (คนละ connection): (ก) จัดลำดับให้รายที่สองรอล็อกจริง (ดูจาก pg_stat_activity)
 * (ข) ยิงพร้อมกัน 6 ราย (ค) ทางเขียนที่ข้ามตัวกัน → unique partial index ชน · + lifecycle billingStatus / trigger / ไม่มีลบ / แยก tenant
 */
describe('billing guard — กันวางบิลซ้ำ (ST5-T05)', { timeout: 300_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let companyId: string;
  let branchId: string;
  let freight: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท กันวางบิลซ้ำ' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(951) },
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
    freight = (await db.serviceItem.findFirstOrThrow({ where: { tenantId, systemKey: 'FREIGHT' } }))
      .id;
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await owner.$disconnect();
  });

  const guard = () => app.get(InvoiceBillingGuard);
  /** 1 คำขอ = 1 transaction ของ tenant (คนละ connection ของ pool — เหมือน request จริงผ่าน TransactionInterceptor) */
  const run = <T>(fn: (tx: Tx) => Promise<T>, tid = tenantId) =>
    app
      .get(DbService)
      .withTenant(
        tid,
        (tx) =>
          requestContext.run(
            { requestId: randomUUID(), tenantId: tid, actorId: 'user-test', locale: 'th', tx },
            () => fn(tx),
          ),
        60_000,
      );

  const newCustomer = async () =>
    (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9700 + seed) })
        .expect(201)
    ).body.id as string;
  const newSite = async () =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;

  /** ใบสั่ง → DO แล้วตั้งเป็น "รอวางบิล" (UNBILLED) ตรงที่ฐาน — การส่งจริงทดสอบใน ST4/ST5-T04 แล้ว */
  const unbilledDo = async (customer: string, status: 'UNBILLED' | 'DRAFT' = 'UNBILLED') => {
    const [origin, dest] = [await newSite(), await newSite()];
    const { order: so } = await run((tx) =>
      app.get(OrderIntakeService).upsertOrder(
        {
          source: 'MANUAL',
          customer: { id: uuid('customer', customer) },
          requestedDate: today,
          vehicleTypeId: uuid('vehicleType', vt6),
          stops: [
            { type: 'PICKUP', siteId: uuid('site', origin) },
            { type: 'DELIVERY', siteId: uuid('site', dest) },
          ],
          lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: unitTon, weightKg: '5000' }],
        },
        tx,
      ),
    );
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    if (status !== 'DRAFT') {
      // DO ที่ส่งแล้วต้องอยู่ในเที่ยว (CHECK delivery_order_trip)
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [encodeId('deliveryOrder', d!.id)] })
        .expect(201);
      await db.deliveryOrder.update({ where: { id: d!.id }, data: { status } });
    }
    return d!.id;
  };
  const draft = async (customer: string) =>
    (
      await db.invoice.create({
        data: {
          tenantId,
          customerId: uuid('customer', customer),
          issuingCompanyId: companyId,
          issuingBranchId: branchId,
          createdBy: 'user-test',
        },
      })
    ).id;
  const line = (deliveryOrderId: string): DoInvoiceLineInput => ({
    deliveryOrderId,
    serviceItemId: freight,
    description: 'ค่าขนส่ง',
    quantity: '5',
    unitLabel: 'ตัน',
    unitPrice: '350.00',
    amount: '1750.00',
    vatType: 'EXEMPT_TRANSPORT',
    whtRate: '1.00',
  });
  const billing = async (id: string) =>
    (await db.deliveryOrder.findUniqueOrThrow({ where: { id } })).billingStatus;
  const activeLines = (id: string) =>
    db.invoiceLine.findMany({ where: { deliveryOrderId: id, active: true } });
  /** จำนวน backend ของฐานนี้ที่รอล็อกอยู่ (role owner เห็นทุก session) */
  const waitingOnLock = async () =>
    (
      await owner.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`
    )[0]!.n;
  const until = async (cond: () => Promise<boolean>, ms = 20_000) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error('timeout waiting for condition');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const problemCode = (r: PromiseSettledResult<unknown>) =>
    r.status === 'rejected' && r.reason instanceof ProblemException ? r.reason.code : null;

  it('เกณฑ์ตรวจรับ (ก): 2 คำขอพร้อมกัน — รายที่สองรอล็อกจริงแล้วได้ 409 do_already_drafted · สำเร็จ 1', async () => {
    const cus = await newCustomer();
    const doId = await unbilledDo(cus);
    const [a, b] = [await draft(cus), await draft(cus)];
    expect(await waitingOnLock()).toBe(0);

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let attached = false;
    const first = run(async (tx) => {
      const out = await guard().attach(a, [line(doId)], tx);
      attached = true;
      await hold; // ถือล็อกไว้ (ยังไม่ commit) จนรายที่สองติดรอ
      return out;
    });
    await until(async () => attached);
    expect(await activeLines(doId)).toHaveLength(0); // ยังไม่ commit — นอก transaction ไม่เห็น
    const second = run((tx) => guard().attach(b, [line(doId)], tx));
    await until(async () => (await waitingOnLock()) >= 1); // รายที่สองติดรอล็อกของรายแรกจริง
    release();
    const res = await Promise.allSettled([first, second]);

    expect(res[0].status).toBe('fulfilled');
    expect(problemCode(res[1])).toBe('do_already_drafted');
    const e = (res[1] as PromiseRejectedResult).reason as ProblemException;
    expect(e.getStatus()).toBe(409);
    expect(e.extra).toMatchObject({
      deliveryOrderId: encodeId('deliveryOrder', doId),
      billingStatus: 'IN_DRAFT',
    });
    const lines = await activeLines(doId);
    expect(lines.map((l) => l.invoiceId)).toEqual([a]);
    expect(await billing(doId)).toBe('IN_DRAFT');
    expect(await db.invoiceLine.count({ where: { invoiceId: b } })).toBe(0);
    // ประวัติแกนวางบิล 1 แถว (UNBILLED → IN_DRAFT)
    const h = await db.docStatusHistory.findMany({
      where: { docType: 'delivery_order.billing', docId: doId },
    });
    expect(h.map((x) => [x.fromStatus, x.toStatus, x.event])).toEqual([
      ['UNBILLED', 'IN_DRAFT', 'draft'],
    ]);
  });

  it('เกณฑ์ตรวจรับ (ข): ยิงพร้อมกัน 6 คำขอ (6 ร่าง) → สำเร็จ 1 ที่เหลือ 409 ทั้งหมด', async () => {
    const cus = await newCustomer();
    const doId = await unbilledDo(cus);
    const drafts = await Promise.all(Array.from({ length: 6 }, () => draft(cus)));
    const res = await Promise.allSettled(
      drafts.map((inv) => run((tx) => guard().attach(inv, [line(doId)], tx))),
    );
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(res.filter((r) => r.status === 'rejected').map(problemCode)).toEqual(
      Array(5).fill('do_already_drafted'),
    );
    expect(await activeLines(doId)).toHaveLength(1);
    expect(await billing(doId)).toBe('IN_DRAFT');
  });

  it('เกณฑ์ตรวจรับ (ค): ทางเขียนที่ข้ามตัวกัน — unique partial index ชนแม้เขียนพร้อมกัน', async () => {
    const cus = await newCustomer();
    const doId = await unbilledDo(cus);
    const [a, b] = [await draft(cus), await draft(cus)];
    const raw = (tx: Tx, inv: string) =>
      tx.invoiceLine.create({
        data: { tenantId, invoiceId: inv, lineNo: 1, ...line(doId) },
      });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let inserted = false;
    const first = run(async (tx) => {
      await raw(tx, a);
      inserted = true;
      await hold;
    });
    await until(async () => inserted);
    const second = run((tx) => raw(tx, b)); // ไม่มีล็อก DO — รอที่ index จนรายแรก commit
    await until(async () => (await waitingOnLock()) >= 1);
    release();
    const res = await Promise.allSettled([first, second]);
    expect(res[0].status).toBe('fulfilled');
    expect(res[1].status).toBe('rejected');
    const err = (res[1] as PromiseRejectedResult).reason;
    expect(isActiveDoViolation(err), String(err?.message) + JSON.stringify(err?.meta)).toBe(true);
    expect(await activeLines(doId)).toHaveLength(1);

    // ตัวกันชั้นที่ 2 ของ guard: บรรทัดมีแล้วแต่ billingStatus ยัง UNBILLED (เขียนข้ามตัวกัน) → ชน index → 409 เดียวกัน
    const c = await draft(cus);
    await expect(run((tx) => guard().attach(c, [line(doId)], tx))).rejects.toMatchObject({
      code: 'do_already_drafted',
    });
  });

  it('lifecycle: ถอดออกจากร่าง / ยกเลิกร่าง → UNBILLED · ออกเลข → INVOICED (ดึงซ้ำ 409) · ลดหนี้เต็มใบ → CREDITED (วางบิลใหม่ได้)', async () => {
    const cus = await newCustomer();
    const d1 = await unbilledDo(cus);
    const d2 = await unbilledDo(cus);
    const a = await draft(cus);
    const lines = await run((tx) => guard().attach(a, [line(d1), line(d2)], tx));
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect([await billing(d1), await billing(d2)]).toEqual(['IN_DRAFT', 'IN_DRAFT']);
    const v0 = (await db.deliveryOrder.findUniqueOrThrow({ where: { id: d1 } })).version;

    // ถอด d2 ออกจากร่าง: บรรทัดไม่ถูกลบ (active=false) · d2 กลับ UNBILLED · ดึงเข้าร่างอื่นได้
    await run((tx) => guard().detach(a, [d2], tx));
    expect(await billing(d2)).toBe('UNBILLED');
    expect(await db.invoiceLine.count({ where: { invoiceId: a } })).toBe(2);
    const b = await draft(cus);
    await run((tx) => guard().attach(b, [line(d2)], tx));
    expect(await billing(d2)).toBe('IN_DRAFT');
    await expect(run((tx) => guard().detach(a, [d2], tx))).rejects.toMatchObject({
      code: 'validation_failed',
    });

    // ยกเลิกร่าง b (trigger ปิดบรรทัด) + sync → d2 UNBILLED
    await run(async (tx) => {
      await tx.invoice.update({ where: { id: b }, data: { status: 'CANCELLED', ...CANCEL } });
      expect(await guard().syncFromInvoice(b, tx)).toBe(1);
    });
    expect(await billing(d2)).toBe('UNBILLED');
    expect(await activeLines(d2)).toHaveLength(0);

    // ออกเลขใบ a + sync → d1 INVOICED · ดึง d1 เข้าร่างอื่น → 409 (billingStatus INVOICED)
    await run(async (tx) => {
      await tx.invoice.update({
        where: { id: a },
        data: { status: 'ISSUED', ...issuedTestFields('INV-1') },
      });
      expect(await guard().syncFromInvoice(a, tx)).toBe(1);
      expect(await guard().syncFromInvoice(a, tx)).toBe(0); // idempotent
    });
    expect(await billing(d1)).toBe('INVOICED');
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: d1 } })).version).toBe(v0 + 1);
    const c = await draft(cus);
    await expect(run((tx) => guard().attach(c, [line(d1)], tx))).rejects.toMatchObject({
      code: 'do_already_drafted',
      extra: { billingStatus: 'INVOICED' },
    });
    // ใบที่ออกแล้ว: ถอด/เพิ่มบรรทัดไม่ได้
    await expect(run((tx) => guard().detach(a, [d1], tx))).rejects.toMatchObject({
      code: 'invalid_state_transition',
    });
    await expect(run((tx) => guard().attach(a, [line(d2)], tx))).rejects.toMatchObject({
      code: 'invalid_state_transition',
    });

    // ลดหนี้เต็มใบ (VOIDED) + sync → d1 CREDITED → ดึงเข้าร่างใหม่ได้
    await run(async (tx) => {
      await tx.invoice.update({ where: { id: a }, data: { status: 'VOIDED' } });
      expect(await guard().syncFromInvoice(a, tx)).toBe(1);
    });
    expect(await billing(d1)).toBe('CREDITED');
    await run((tx) => guard().attach(c, [line(d1)], tx));
    expect(await billing(d1)).toBe('IN_DRAFT');
    const h = await db.docStatusHistory.findMany({
      where: { docType: 'delivery_order.billing', docId: d1 },
      orderBy: { at: 'asc' },
    });
    expect(h.map((x) => x.toStatus)).toEqual(['IN_DRAFT', 'INVOICED', 'CREDITED', 'IN_DRAFT']);

    // API แสดง billingStatus ของ DO
    const res = await api(app, admin)
      .get(`/v1/delivery-orders/${encodeId('deliveryOrder', d1)}`)
      .expect(200);
    expect(res.body.billingStatus).toBe('IN_DRAFT');
  });

  it('ตรวจคำขอ: ลูกค้าคนละราย 422 · DO ยังไม่ส่ง 409 not_ready_to_bill · ซ้ำในคำขอ 422 · ใบไม่พบ 404', async () => {
    const cus = await newCustomer();
    const cus2 = await newCustomer();
    const a = await draft(cus);
    const foreign = await unbilledDo(cus2);
    await expect(run((tx) => guard().attach(a, [line(foreign)], tx))).rejects.toMatchObject({
      code: 'validation_failed',
      errors: [{ field: 'lines[0].deliveryOrderId', code: 'customer_mismatch' }],
    });
    const notYet = await unbilledDo(cus, 'DRAFT');
    await expect(run((tx) => guard().attach(a, [line(notYet)], tx))).rejects.toMatchObject({
      code: 'not_ready_to_bill',
      extra: { reasons: ['NOT_DELIVERED'] },
    });
    const ok = await unbilledDo(cus);
    await expect(run((tx) => guard().attach(a, [line(ok), line(ok)], tx))).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(run((tx) => guard().attach(randomUUID(), [line(ok)], tx))).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await billing(ok)).toBe('UNBILLED');
    expect(await db.invoiceLine.count({ where: { invoiceId: a } })).toBe(0);
  });

  it('คิวพร้อมวางบิล: DO ที่อยู่ในร่างไม่ขึ้นคิว — เหตุ IN_INVOICE (spec/05 BIL-020 (จ))', async () => {
    const cus = await newCustomer();
    const d = await unbilledDo(cus);
    const before = await run((tx) => app.get(BillingQueueService).readiness(tx, d));
    expect(BillingQueueService.blockers(before!)).not.toContain('IN_INVOICE');
    const a = await draft(cus);
    await run((tx) => guard().attach(a, [line(d)], tx));
    const after = await run((tx) => app.get(BillingQueueService).readiness(tx, d));
    expect(after!.billed).toBe(true);
    expect(BillingQueueService.blockers(after!)).toContain('IN_INVOICE');
  });

  it('ฐานข้อมูล: เพิ่มบรรทัดในใบที่ไม่ใช่ร่างไม่ได้ · active ย้อนเป็น true ไม่ได้ · role แอปลบใบ/บรรทัดไม่ได้ · ร่างมีเลขไม่ได้', async () => {
    const cus = await newCustomer();
    const d = await unbilledDo(cus);
    const a = await draft(cus);
    await run((tx) => guard().attach(a, [line(d)], tx));
    const [l] = await activeLines(d);
    await expect(
      run((tx) => tx.invoiceLine.update({ where: { id: l!.id }, data: { active: false } })),
    ).resolves.toBeTruthy();
    await expect(
      run((tx) => tx.invoiceLine.update({ where: { id: l!.id }, data: { active: true } })),
    ).rejects.toThrow(/invoice_line_active_one_way|cannot reactivate/);
    await expect(run((tx) => tx.invoiceLine.delete({ where: { id: l!.id } }))).rejects.toThrow(
      /permission denied/,
    );
    await expect(run((tx) => tx.invoice.delete({ where: { id: a } }))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      run((tx) => tx.invoice.update({ where: { id: a }, data: { invoiceNo: 'X-1' } })),
    ).rejects.toThrow(
      /invoice_draft_no_number|invoice_no is assigned only when a draft is finalized/,
    );
    const issued = await draft(cus);
    await db.invoice.update({
      where: { id: issued },
      data: { status: 'ISSUED', ...issuedTestFields('INV-9') },
    });
    await expect(
      run((tx) =>
        tx.invoiceLine.create({
          data: { tenantId, invoiceId: issued, lineNo: 1, ...line(d) },
        }),
      ),
    ).rejects.toThrow(/invoice_line_draft_only|not a draft/);
  });

  it('ฐานข้อมูล (review M / QA L1, L3): ย้ายบรรทัดข้ามใบ/เปลี่ยน DO ไม่ได้ · ปิดบรรทัดของใบที่ออกแล้วไม่ได้ · CANCELLED/VOIDED เป็นสถานะสิ้นสุด', async () => {
    const cus = await newCustomer();
    const d = await unbilledDo(cus);
    const d2 = await unbilledDo(cus);
    const a = await draft(cus);
    await run((tx) => guard().attach(a, [line(d)], tx));
    const [l] = await activeLines(d);
    const issued = await draft(cus);
    await db.invoice.update({
      where: { id: issued },
      data: { status: 'ISSUED', ...issuedTestFields('INV-20') },
    });
    // ย้ายบรรทัดจากร่างไปใบที่ออกแล้ว / เปลี่ยน DO / เปลี่ยน tenant
    await expect(
      run((tx) => tx.invoiceLine.update({ where: { id: l!.id }, data: { invoiceId: issued } })),
    ).rejects.toThrow(/invoice_line_immutable_ref|cannot change/);
    await expect(
      run((tx) => tx.invoiceLine.update({ where: { id: l!.id }, data: { deliveryOrderId: d2 } })),
    ).rejects.toThrow(/invoice_line_immutable_ref|cannot change/);
    await expect(
      db.invoiceLine.update({ where: { id: l!.id }, data: { tenantId: otherId } }),
    ).rejects.toThrow(/invoice_line_immutable_ref|cannot change/);
    // ออกเลขใบ a แล้วปิดบรรทัดตรง ๆ (ข้ามใบลดหนี้) ไม่ได้ — DO ยังถูกกันวางบิลซ้ำ
    await run(async (tx) => {
      await tx.invoice.update({
        where: { id: a },
        data: { status: 'ISSUED', ...issuedTestFields('INV-21') },
      });
      await guard().syncFromInvoice(a, tx);
    });
    await expect(
      run((tx) => tx.invoiceLine.update({ where: { id: l!.id }, data: { active: false } })),
    ).rejects.toThrow(/invoice_line_release_state|cannot be released/);
    await expect(
      run((tx) => tx.invoiceLine.updateMany({ where: { invoiceId: a }, data: { active: false } })),
    ).rejects.toThrow(/invoice_line_release_state|cannot be released/);
    expect(await activeLines(d)).toHaveLength(1);
    // ลดหนี้เต็มใบ (VOIDED) → trigger ปิดบรรทัดได้ · แล้วสถานะใบเปลี่ยนต่อไม่ได้
    await run((tx) => tx.invoice.update({ where: { id: a }, data: { status: 'VOIDED' } }));
    expect(await activeLines(d)).toHaveLength(0);
    await expect(
      run((tx) => tx.invoice.update({ where: { id: a }, data: { status: 'ISSUED' } })),
    ).rejects.toThrow(/invoice_status_terminal|terminal/);
    const c = await draft(cus);
    await run((tx) =>
      tx.invoice.update({ where: { id: c }, data: { status: 'CANCELLED', ...CANCEL } }),
    );
    for (const to of ['DRAFT', 'ISSUED', 'VOIDED'] as const)
      await expect(db.invoice.update({ where: { id: c }, data: { status: to } })).rejects.toThrow(
        /invoice_status_terminal|terminal/,
      );
  });

  it('DO ในร่าง/ใบที่ออกแล้ว: เพิ่ม/ยกเลิกบรรทัดรายได้เอง และยืนยันค่าใช้จ่ายหน้างานฝั่งขาย → 409 do_in_invoice (docs/04 F4, BIL-024)', async () => {
    const cus = await newCustomer();
    const d = await unbilledDo(cus);
    const { salesOrderId } = await db.deliveryOrder.findUniqueOrThrow({ where: { id: d } });
    const orderId = encodeId('salesOrder', salesOrderId);
    const body = {
      serviceItemId: encodeId('serviceItem', freight),
      sellUnitPrice: '100.00',
      deliveryOrderId: encodeId('deliveryOrder', d),
      reason: 'ลูกค้าขอเพิ่มค่าบริการพิเศษ',
    };
    // ก่อนเข้าร่าง: เพิ่มได้
    const manual = (
      await api(app, admin).post(`/v1/orders/${orderId}/revenue-lines`).send(body).expect(201)
    ).body as { id: string };
    const sur = await db.doSurcharge.create({
      data: {
        tenantId,
        deliveryOrderId: d,
        serviceItemId: freight,
        vatType: 'EXEMPT_TRANSPORT',
        whtRate: '1.00',
        qty: '1',
        unitPrice: '50.00',
        amount: '50.00',
      },
    });
    const inv = await draft(cus);
    await run((tx) => guard().attach(inv, [line(d)], tx));
    const add = await api(app, admin).post(`/v1/orders/${orderId}/revenue-lines`).send(body);
    expect(add.status, JSON.stringify(add.body)).toBe(409);
    expect(add.body).toMatchObject({
      code: 'invalid_state_transition',
      billingStatus: 'IN_DRAFT',
      errors: [{ field: 'deliveryOrderId', code: 'do_in_invoice' }],
    });
    const v = await api(app, admin)
      .post(`/v1/revenue-lines/${manual.id}/void`)
      .send({ reason: 'ยกเลิกบรรทัดที่เพิ่มผิด' });
    expect(v.status, JSON.stringify(v.body)).toBe(409);
    expect(v.body.billingStatus).toBe('IN_DRAFT');
    const cf = await api(app, admin)
      .post(`/v1/do-surcharges/${encodeId('doSurcharge', sur.id)}/confirm`)
      .send({ reason: 'ยืนยันค่าใช้จ่ายหน้างานตามใบเสร็จ' });
    expect(cf.status, JSON.stringify(cf.body)).toBe(409);
    expect(cf.body.billingStatus).toBe('IN_DRAFT');
    expect((await db.doSurcharge.findUniqueOrThrow({ where: { id: sur.id } })).status).toBe(
      'PENDING_CONFIRM',
    );
  });

  it('แยก tenant: tenant อื่นไม่เห็นใบ/บรรทัด · ใช้ DO/ใบของ tenant อื่นไม่ได้ · index แยกต่อ tenant', async () => {
    const cus = await newCustomer();
    const d = await unbilledDo(cus);
    const a = await draft(cus);
    await run((tx) => guard().attach(a, [line(d)], tx));
    const seen = await run(
      async (tx) => [await tx.invoice.count(), await tx.invoiceLine.count()],
      otherId,
    );
    expect(seen).toEqual([0, 0]);
    // ใบของ tenant A จาก tenant B → 404 · DO ของ tenant A ในใบของ tenant B → ไม่พบ (422)
    await expect(run((tx) => guard().attach(a, [line(d)], tx), otherId)).rejects.toMatchObject({
      code: 'not_found',
    });
    const oc = (
      await api(app, other)
        .post('/v1/customers')
        .send({ legalName: 'ลูกค้า B', taxId: validTaxId(9899) })
        .expect(201)
    ).body.id as string;
    const oCompany = await db.company.create({
      data: { tenantId: otherId, legalName: 'บริษัท B', taxId: validTaxId(952) },
    });
    const oBranch = await db.branch.create({
      data: {
        tenantId: otherId,
        companyId: oCompany.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
      },
    });
    const ob = await db.invoice.create({
      data: {
        tenantId: otherId,
        customerId: uuid('customer', oc),
        issuingCompanyId: oCompany.id,
        issuingBranchId: oBranch.id,
      },
    });
    await expect(run((tx) => guard().attach(ob.id, [line(d)], tx), otherId)).rejects.toMatchObject({
      code: 'validation_failed',
      errors: [{ code: 'not_found' }],
    });
    expect(await billing(d)).toBe('IN_DRAFT');
  });
});
