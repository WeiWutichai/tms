import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { SYSTEM_ROLES, billingMonthRanges } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
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

type Row = Record<string, any>;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const sum = (xs: (string | undefined)[]) => xs.reduce((a, x) => a.add(D(x ?? 0)), D(0)).toFixed(2);

/**
 * ST9-T02 Dashboard บิล (docs/04 H; spec/09 §1 การ์ดบิล — ย่อ D-54: ไม่มีการ์ด "WHT รอ 50 ทวิ")
 * เกณฑ์ตรวจรับ: ยอดบน dashboard = ผลรวมจากเอกสารจริง — ทุกการ์ดเทียบกับ (ก) รายการเอกสารที่คลิกลงไป (`/v1` ตัวกรองเดียวกัน)
 * และ (ข) query ตรงที่ฐาน · ไม่มีสิทธิ์ราคาขาย = เห็นแต่จำนวน · แยก tenant
 */
describe('Dashboard บิล (ST9-T02)', { timeout: 300_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let companyId: string;
  let branchId: string;
  let admin: string;
  let accounting: string;
  let readOnly: string;
  let other: string;
  let custA: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const m = billingMonthRanges(today);
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท แดชบอร์ดบิล' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(951) },
    });
    companyId = c.id;
    branchId = (
      await db.branch.create({
        data: {
          tenantId,
          companyId: c.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: ADDR,
          isDefaultIssuer: true,
        },
      })
    ).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    readOnly = await tokenFor(tenantId, 'invoices:read', 'u-read'); // ไม่มี prices.sell:read
    other = await tokenFor(otherId);
    custA = (
      await db.customer.create({
        data: { tenantId, code: 'C-A', legalName: 'ก ลูกค้าแรก', taxId: validTaxId(3101) },
      })
    ).id;
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as Row[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as Row[];
    vt6 = types.find((t) => t.code === '6W')!.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  // ---------- DO ส่งแล้วในคิวพร้อมวางบิล (ชุดเดียวกับ billing-queue.test.ts — ลูกค้าปิด "ไม่มี POD ไม่วางบิล") ----------
  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    app
      .get(DbService)
      .withTenant(tenantId, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const newSite = async () =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const post = (stop: string, action: string, min: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/stops/${stop}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra });
  /** ลูกค้า (ไม่บังคับ POD) → rate card `rate`/ตัน → SO `qty` ตัน → DO → เที่ยว → ส่งสำเร็จ */
  const delivered = async (rate: string, qty: string) => {
    const customer = (
      await api(app, admin)
        .post('/v1/customers')
        .send({
          legalName: `ลูกค้าคิว ${++seed}`,
          taxId: validTaxId(9700 + seed),
          requirePodToBill: false,
        })
        .expect(201)
    ).body.id as string;
    const origin = await newSite();
    const dest = await newSite();
    const r = (
      await api(app, admin)
        .post('/v1/rate-cards')
        .send({
          customerId: customer,
          originId: origin,
          destinationId: dest,
          vehicleTypeId: vt6,
          validFrom: today,
          pricingModel: 'PER_TON',
          sellRate: rate,
        })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${r.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: uuid('customer', customer) },
      requestedDate: today,
      vehicleTypeId: uuid('vehicleType', vt6),
      stops: [
        { type: 'PICKUP', siteId: uuid('site', origin) },
        { type: 'DELIVERY', siteId: uuid('site', dest) },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty, unitId: unitTon, weightKg: '5000' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    const doId = encodeId('deliveryOrder', d!.id);
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `8${++seed % 10}-${String(4000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string };
    const n = ++seed;
    await api(app, admin)
      .post('/v1/drivers')
      .send({
        name: `คนขับ ${n}`,
        phone: `086-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [doId], vehicleId: v.id })
        .expect(201)
    ).body;
    const a = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: v.id, dispatch: true });
    if (a.status !== 200)
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: v.id,
          dispatch: true,
          ruleKeys: a.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบแดชบอร์ดบิล',
        })
        .expect(200);
    const full = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    const [pickup, drop] = [...full.stops].sort(
      (x: { sequence: number }, y: { sequence: number }) => x.sequence - y.sequence,
    );
    await post(pickup.id, 'arrive', 60).expect(201);
    await post(pickup.id, 'complete', 55, { outcome: 'DELIVERED' }).expect(201);
    await post(drop.id, 'arrive', 20).expect(201);
    await post(drop.id, 'complete', 10, { outcome: 'DELIVERED' }).expect(201);
    return d!.id;
  };

  // ---------- ใบแจ้งหนี้ (เขียนตรงที่ฐานแบบ aging.test.ts) ----------
  const inv = async (
    total: string,
    o: {
      status?: 'DRAFT' | 'ISSUED' | 'ADJUSTED' | 'CANCELLED' | 'VOIDED';
      issue?: string;
      due?: string | null;
      tenant?: string;
      customerId?: string;
    } = {},
  ) => {
    const status = o.status ?? 'ISSUED';
    const tenant = o.tenant ?? tenantId;
    let iss = { companyId, branchId };
    let customerId = o.customerId ?? custA;
    if (tenant !== tenantId) {
      const c = await db.company.create({
        data: { tenantId: tenant, legalName: `ผู้ออก ${++seed}`, taxId: validTaxId(5000 + seed) },
      });
      const b = await db.branch.create({
        data: {
          tenantId: tenant,
          companyId: c.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: ADDR,
        },
      });
      iss = { companyId: c.id, branchId: b.id };
      customerId = (
        await db.customer.create({
          data: { tenantId: tenant, code: `X-${++seed}`, legalName: 'ลูกค้าอื่น' },
        })
      ).id;
    }
    const n = ++seed;
    const issue = o.issue ?? today;
    const row = await db.invoice.create({
      data: {
        tenantId: tenant,
        customerId,
        issuingCompanyId: iss.companyId,
        issuingBranchId: iss.branchId,
        status,
        totalAmount: total,
        subtotalExempt: total,
        ...(status === 'DRAFT'
          ? {}
          : {
              ...issuedTestFields(`INV-DB-${n}`),
              issueDate: new Date(`${issue}T00:00:00.000Z`),
              dueDate:
                o.due === null ? null : new Date(`${o.due ?? addDays(today, 30)}T00:00:00.000Z`),
            }),
        ...(status === 'CANCELLED' || status === 'VOIDED'
          ? { cancelledAt: new Date(), cancelledBy: 'test', cancelReason: 'ทดสอบยกเลิกใบ' }
          : {}),
      },
    });
    return encodeId('invoice', row.id);
  };
  const pay = (invoiceId: string, amount: string, receivedDate = today) =>
    api(app, accounting)
      .post('/v1/payments')
      .send({
        receivedDate,
        method: 'TRANSFER',
        amountReceived: amount,
        allocations: [{ invoiceId, amount }],
      })
      .expect(201);

  /** เดินทุกหน้าของรายการ (cursor) */
  const all = async (path: string, token = admin) => {
    const out: Row[] = [];
    let cursor: string | null = null;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const q: string = `${path}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const b: { data: Row[]; nextCursor: string | null } = (
        await api(app, token).get(q).expect(200)
      ).body;
      out.push(...b.data);
      cursor = b.nextCursor;
    } while (cursor);
    return out;
  };

  let readyIds: string[] = [];

  it('เกณฑ์ตรวจรับ: ทุกการ์ด = ผลรวมของเอกสารจริง (รายการที่คลิกลงไป + query ฐาน)', async () => {
    // คิวพร้อมวางบิล: 2 DO (350 × 5 = 1,750.00 · 412.35 × 3 = 1,237.05)
    readyIds = [await delivered('350', '5'), await delivered('412.35', '3')];
    // ร่าง 2 ใบ · ออกแล้ว (ยังไม่ครบ) 2 ใบ · ชำระบางส่วน 1 · เกินกำหนด 2 (หนึ่งใบชำระบางส่วน) · ชำระครบ 1
    // ยกเลิก/void (ไม่นับ) · ใบเดือนก่อน · ใบของบริษัทอื่น (ไม่นับ)
    await inv('1000.00', { status: 'DRAFT' });
    await inv('2500.50', { status: 'DRAFT' });
    await inv('10700.00');
    await inv('321.07', { due: today }); // ครบวันนี้ = ยังไม่เกินกำหนด
    const part = await inv('5000.00');
    await pay(part, '1234.56');
    await inv('5000.00', { issue: addDays(today, -40), due: addDays(today, -10) });
    const odPart = await inv('7500.00', { issue: addDays(today, -60), due: addDays(today, -1) });
    await pay(odPart, '500.00');
    const paid = await inv('999.00');
    await pay(paid, '999.00');
    await inv('777.00', { status: 'CANCELLED' });
    await inv('888.00', { status: 'VOIDED' });
    // เดือนก่อน: ออกวันที่ 1 ของเดือนก่อน (ครบกำหนดอนาคต) + รับชำระเดือนก่อน 1 รายการ
    await inv('4200.00', { issue: m.lastMonth.from, due: addDays(today, 30) });
    const prevPaid = await inv('200.00', { issue: m.lastMonth.from, due: addDays(today, 30) });
    await pay(prevPaid, '200.00', m.lastMonth.to);
    await inv('666.00', { tenant: otherId });
    // review M2: ADJUSTED (ลดหนี้บางส่วน — ไม่เกิดในเฟส 0, D-54) ไม่อยู่ในการ์ดลูกหนี้ใด ๆ แต่นับใน total
    await inv('1500.00', { status: 'ADJUSTED' });

    const s = (await api(app, admin).get('/v1/invoices/summary').expect(200)).body;
    const p = (await api(app, admin).get('/v1/payments/summary').expect(200)).body;
    const q = (await api(app, admin).get('/v1/invoices/queue?limit=1').expect(200)).body;
    expect(s.today).toBe(today);

    // (1) ร่าง = Σ ยอดรวมของ `GET /invoices?status=DRAFT` = Σ ฐาน
    const drafts = await all('/v1/invoices?status=DRAFT');
    expect(s.draft).toBe(drafts.length);
    expect(s.draft).toBe(2);
    expect(s.sellDraftTotal).toBe(sum(drafts.map((x) => x.sellTotal)));
    expect(s.sellDraftTotal).toBe('3500.50');

    // (2) ค้างวางบิล (มูลค่า) = Σ แถวคิว = Σ ต่อลูกค้า = Σ บรรทัดรายได้ที่ยังใช้ของ DO ในคิว (ฐาน)
    const rows = await all('/v1/invoices/queue');
    expect(q.totals.deliveryOrderCount).toBe(rows.length);
    expect(q.totals.deliveryOrderCount).toBe(2);
    expect(q.totals.sellTotal).toBe(sum(rows.map((x) => x.sellTotal)));
    expect(q.totals.sellTotal).toBe(sum(q.customers.map((c: Row) => c.sellTotal)));
    const rl = await db.revenueLine.aggregate({
      where: { deliveryOrderId: { in: readyIds }, status: 'ACTIVE' },
      _sum: { amount: true },
    });
    expect(q.totals.sellTotal).toBe(D(rl._sum.amount!).toFixed(2));
    expect(q.totals.sellTotal).toBe('2987.05');

    // (3) ออกแล้วรอชำระ = แท็บ "ออกแล้ว" (ไม่เกินกำหนด) · (4) เกินกำหนด · (5) ชำระบางส่วน (ไม่เกินกำหนด)
    const issued = await all('/v1/invoices?status=ISSUED&overdue=false');
    const over = await all('/v1/invoices?receivable=overdue');
    const partial = await all('/v1/invoices?status=PARTIALLY_PAID&overdue=false');
    expect([s.issued, s.overdue, s.partiallyPaid]).toEqual([
      issued.length,
      over.length,
      partial.length,
    ]);
    expect([s.issued, s.overdue, s.partiallyPaid]).toEqual([3, 2, 1]);
    // แท็บ "ออกแล้ว" ของหน้าวางบิล (`/bill?tab=ISSUED`) = ตัวกรองเดียวกัน · ADJUSTED อยู่ใน total เท่านั้น
    expect(issued.some((x) => x.status === 'ADJUSTED')).toBe(false);
    expect(s.total).toBe(
      s.draft + s.issued + s.partiallyPaid + s.paid + s.overdue + s.cancelled + 1,
    );
    expect(s.sellIssuedOutstanding).toBe(sum(issued.map((x) => x.sellOutstanding)));
    expect(s.sellOverdueOutstanding).toBe(sum(over.map((x) => x.sellOutstanding)));
    expect(s.sellPartiallyPaidOutstanding).toBe(sum(partial.map((x) => x.sellOutstanding)));
    expect(s.sellIssuedOutstanding).toBe('15221.07'); // 10,700 + 321.07 + 4,200 (ออกเดือนก่อน)
    expect(s.sellOverdueOutstanding).toBe('12000.00'); // 5,000 + (7,500 − 500)
    expect(s.sellPartiallyPaidOutstanding).toBe('3765.44');
    // ตรงกับหน้า "รับชำระ" (สรุปค้างรับ/เกินกำหนด) — RPT-032 Σ การ์ด = ลูกหนี้คงค้าง
    expect(s.sellOverdueOutstanding).toBe(p.sellOverdueOutstanding);
    expect(s.overdue).toBe(p.overdue);
    expect(
      sum([s.sellIssuedOutstanding, s.sellPartiallyPaidOutstanding, s.sellOverdueOutstanding]),
    ).toBe(p.sellOutstanding);
    // query ฐานตรง: ค้างรับ = Σ (ยอดรวม − ยอดตัด) ของ ISSUED/PARTIALLY_PAID ของ tenant นี้
    const open = await db.invoice.findMany({
      where: { tenantId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
      select: { totalAmount: true, paidAmount: true },
    });
    expect(p.sellOutstanding).toBe(
      open.reduce((a, i) => a.add(i.totalAmount.sub(i.paidAmount)), D(0)).toFixed(2),
    );

    // (6) เดือนนี้ vs เดือนก่อน — ใบที่ออก (ตาม issueDate เวลาไทย ไม่รวมร่าง/ยกเลิก) + เงินเข้าจริง
    const inMonth = async (from: string, to: string) => {
      const r = await db.invoice.aggregate({
        where: {
          tenantId,
          status: { notIn: ['DRAFT', 'CANCELLED', 'VOIDED'] },
          issueDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        },
        _count: { _all: true },
        _sum: { totalAmount: true },
      });
      return { count: r._count._all, sellTotal: D(r._sum.totalAmount ?? 0).toFixed(2) };
    };
    expect(s.issuedThisMonth).toEqual({
      month: m.thisMonth.month,
      ...(await inMonth(m.thisMonth.from, m.thisMonth.to)),
    });
    expect(s.issuedLastMonth).toEqual({
      month: m.lastMonth.month,
      ...(await inMonth(m.lastMonth.from, m.lastMonth.to)),
    });
    expect(s.issuedLastMonth.sellTotal).toBe(
      // ใบ "เกินกำหนด" ที่ออก 40/60 วันก่อนอาจตกเดือนก่อนด้วย — นับจากรายการที่ออกจริง
      sum(
        (await all('/v1/invoices?receivable=all'))
          .filter((x) => x.issueDate >= m.lastMonth.from && x.issueDate <= m.lastMonth.to)
          .map((x) => x.sellTotal),
      ),
    );
    const received = async (from: string, to: string) => {
      const r = await db.payment.aggregate({
        where: {
          tenantId,
          status: 'RECORDED',
          receivedDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        },
        _count: { _all: true },
        _sum: { amountReceived: true },
      });
      return [r._count._all, D(r._sum.amountReceived ?? 0).toFixed(2)];
    };
    expect([p.receivedThisMonth, p.sellReceivedThisMonth]).toEqual(
      await received(m.thisMonth.from, m.thisMonth.to),
    );
    expect([p.receivedLastMonth, p.sellReceivedLastMonth]).toEqual(
      await received(m.lastMonth.from, m.lastMonth.to),
    );
    expect(p.sellReceivedLastMonth).toBe('200.00');
    // รายการรับชำระ (ไม่กลับรายการ) ของเดือนก่อน = เอกสารเดียวกัน
    const pays = (await all('/v1/payments')).filter(
      (x) =>
        x.status === 'RECORDED' &&
        x.receivedDate >= m.lastMonth.from &&
        x.receivedDate <= m.lastMonth.to,
    );
    expect(sum(pays.map((x) => x.sellAmountReceived))).toBe(p.sellReceivedLastMonth);
  });

  it('กลับรายการรับชำระ → ไม่นับในเดือน · ใบกลับไปค้าง', async () => {
    const x = await inv('300.00');
    const r = (await pay(x, '300.00')).body;
    const before = (await api(app, admin).get('/v1/payments/summary').expect(200)).body;
    await api(app, admin)
      .post(`/v1/payments/${r.id}/reverse`)
      .set('If-Match', `"${r.version}"`)
      .send({ reason: 'บันทึกผิดใบ ทดสอบกลับรายการ' })
      .expect(200);
    const after = (await api(app, admin).get('/v1/payments/summary').expect(200)).body;
    expect(after.receivedThisMonth).toBe(before.receivedThisMonth - 1);
    expect(D(before.sellReceivedThisMonth).sub(after.sellReceivedThisMonth).toFixed(2)).toBe(
      '300.00',
    );
    const s = (await api(app, admin).get('/v1/invoices/summary').expect(200)).body;
    const issued = await all('/v1/invoices?status=ISSUED&overdue=false');
    expect(s.sellIssuedOutstanding).toBe(sum(issued.map((i) => i.sellOutstanding)));
  });

  it('ไม่มีสิทธิ์ราคาขาย → เห็นจำนวนแต่ไม่มีฟิลด์เงิน (RPT-011)', async () => {
    const s = (await api(app, readOnly).get('/v1/invoices/summary').expect(200)).body;
    expect(s.draft).toBe(2);
    for (const k of [
      'sellDraftTotal',
      'sellIssuedOutstanding',
      'sellPartiallyPaidOutstanding',
      'sellOverdueOutstanding',
    ])
      expect(s).not.toHaveProperty(k);
    expect(s.issuedThisMonth).not.toHaveProperty('sellTotal');
    expect(s.issuedThisMonth.count).toBeGreaterThan(0);
    const p = (await api(app, readOnly).get('/v1/payments/summary').expect(200)).body;
    expect(p).not.toHaveProperty('sellReceivedLastMonth');
    expect(p.receivedLastMonth).toBe(1);
    const q = (await api(app, readOnly).get('/v1/invoices/queue?limit=1').expect(200)).body;
    expect(q.totals.deliveryOrderCount).toBe(2);
    expect(q.totals).not.toHaveProperty('sellTotal');
    // ไม่มี invoices:read → 403
    const planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-pl');
    await api(app, planner).get('/v1/invoices/summary').expect(403);
  });

  it('แยก tenant: บริษัทอื่นเห็นเฉพาะเอกสารของตัวเอง', async () => {
    const s = (await api(app, other).get('/v1/invoices/summary').expect(200)).body;
    expect([s.draft, s.issued, s.overdue, s.partiallyPaid]).toEqual([0, 1, 0, 0]);
    expect(s.sellIssuedOutstanding).toBe('666.00');
    expect(s.sellDraftTotal).toBe('0.00');
    const q = (await api(app, other).get('/v1/invoices/queue?limit=1').expect(200)).body;
    expect(q.totals).toEqual({ deliveryOrderCount: 0, releasedCount: 0, sellTotal: '0.00' });
    const p = (await api(app, other).get('/v1/payments/summary').expect(200)).body;
    expect([p.receivedThisMonth, p.receivedLastMonth]).toEqual([0, 0]);
  });
});
