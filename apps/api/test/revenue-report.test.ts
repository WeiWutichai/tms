import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { SYSTEM_ROLES, addMonths, billingMonthRanges, monthRange } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { Clock } from '../src/common/clock';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { JobQueue } from '../src/jobs/job-queue.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
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

type Row = Record<string, any>;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const sum = (xs: (string | undefined)[]) => xs.reduce((a, x) => a.add(D(x ?? 0)), D(0)).toFixed(2);

/**
 * ST9-T05 รายงานรายได้ (docs/04 H "รายได้"; ย่อ D-54 — ไม่มีส่วนเอกสารภาษี) — เกณฑ์ตรวจรับ:
 * ยอดรวมรายงานเดือน = ผลรวมใบแจ้งหนี้ที่ออกในเดือน (query อิสระจากหัวใบ — ใบที่ยกเลิก/ร่าง/เดือนอื่น/บริษัทอื่นไม่นับ)
 * และทุกมิติ (ลูกค้า / เส้นทาง / รถ / ประเภทรถ / นิติบุคคล / เดือน) รวมได้ยอดเดียวกัน · สิทธิ์ราคา · แพ็กเกจ · แยก tenant · ส่งออก xlsx/pdf
 */
describe('รายงานรายได้ (ST9-T05)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let company1: string;
  let company2: string;
  let branch1: string;
  let branch2: string;
  let admin: string;
  let invoicer: string;
  let accounting: string;
  let financeNoSell: string;
  let planner: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  let serviceItem: string;
  // นาฬิกาคงที่ทั้งชุด (ออกเลข/รายงานใช้ Clock เดียวกัน — ไม่แกว่งเมื่อรันคร่อมเที่ยงคืน/สิ้นเดือน)
  const NOW = new Date();
  const today = bangkokToday(NOW);
  const thisMonth = today.slice(0, 7);
  const lastMonth = billingMonthRanges(today).lastMonth;
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const NONE_REQ = { success: { fields: [] } };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    app.get(Clock).set(NOW);
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท รายงานรายได้' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c1 = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ขนส่งหนึ่ง จำกัด', taxId: validTaxId(971) },
    });
    company1 = c1.id;
    branch1 = (
      await db.branch.create({
        data: {
          tenantId,
          companyId: c1.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: ADDR,
          isDefaultIssuer: true,
        },
      })
    ).id;
    admin = await tokenFor(tenantId);
    invoicer = await tokenFor(tenantId, SYSTEM_ROLES.invoicer.permissions.join(' '), 'u-inv');
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    financeNoSell = await tokenFor(tenantId, 'reports.finance:read', 'u-fin');
    planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-plan');
    other = await tokenFor(otherId);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as Row[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as Row[];
    vt6 = types.find((t) => t.code === '6W')!.id;
    serviceItem = (
      await db.serviceItem.findFirstOrThrow({
        where: { tenantId, status: 'ACTIVE', deletedAt: null },
      })
    ).id;
  });
  afterAll(async () => {
    app.get(Clock).set(null);
    await app.close();
    await db.$disconnect();
  });

  // ---------- DO ส่งแล้ว + ส่งบัญชี (ชุดเดียวกับ invoice-finalize.test.ts) ----------
  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    app
      .get(DbService)
      .withTenant(tenantId, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const newSite = async (name: string) =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  const newVehicle = async () => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `7${++seed % 10}-${String(6000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string; plate: string };
    const n = ++seed;
    await api(app, admin)
      .post('/v1/drivers')
      .send({
        name: `คนขับ ${n}`,
        phone: `088-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    return v;
  };
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const post = (stop: string, action: string, min: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/stops/${stop}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra });
  const newCustomer = async (legalName: string) => {
    const body = (
      await api(app, admin)
        .post('/v1/customers')
        .send({
          legalName,
          taxId: validTaxId(8900 + ++seed),
          branchCode: '00000',
          billingAddress: ADDR,
        })
        .expect(201)
    ).body as { id: string };
    await db.customer.update({
      where: { id: uuid('customer', body.id) },
      data: { podRequirements: NONE_REQ, paymentTermDays: 30 },
    });
    return body.id;
  };
  /** ลูกค้า → rate card `rate`/ตัน → SO 5 ตัน → DO → เที่ยว (รถ `vehicleId`) → ส่งสำเร็จ → ส่งบัญชี */
  const delivered = async (customer: string, vehicleId: string, rate: string) => {
    const origin = await newSite(`ต้นทาง ${++seed}`);
    const dest = await newSite(`ปลายทาง ${seed}`);
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
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: unitTon, weightKg: '5000' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    const doId = encodeId('deliveryOrder', d!.id);
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [doId], vehicleId })
        .expect(201)
    ).body;
    const a = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId, dispatch: true });
    if (a.status !== 200)
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId,
          dispatch: true,
          ruleKeys: a.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบรายงานรายได้',
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
    await api(app, admin).post(`/v1/delivery-orders/${doId}/release`).send({}).expect(200);
    return { doId, origin, dest };
  };
  /** ร่างจาก DO (ผู้วางบิล) → ออกเลข (บัญชี) — ทางจริงของ API */
  const issueViaApi = async (customer: string, doIds: string[]) => {
    const dr = (
      await api(app, invoicer)
        .post('/v1/invoices')
        .send({ customerId: customer, deliveryOrderIds: doIds })
        .expect(201)
    ).body;
    return (
      await api(app, accounting)
        .post(`/v1/invoices/${dr.id}/finalize`)
        .set('If-Match', `"${dr.version}"`)
        .expect(200)
    ).body as Row;
  };
  /**
   * ใบที่เขียนตรงที่ฐาน (ร่าง + บรรทัดที่เพิ่มเอง ไม่ผูก DO → ออกเลขวันที่ `issue`) — ใช้จำลองเดือนอื่น/ผู้ออกอื่น/ยกเลิก
   * ยอดหัวใบ = Σ บรรทัด (ยกเว้น VAT)
   */
  const issueViaDb = async (
    amounts: string[],
    o: {
      issue?: string;
      tenant?: string;
      customerId: string;
      companyId?: string;
      branchId?: string;
      issuer?: string;
      status?: 'ISSUED' | 'DRAFT';
    },
  ) => {
    const tenant = o.tenant ?? tenantId;
    const total = sum(amounts);
    const svc =
      tenant === tenantId
        ? serviceItem
        : (
            await db.serviceItem.findFirstOrThrow({
              where: { tenantId: tenant, status: 'ACTIVE', deletedAt: null },
            })
          ).id;
    const inv = await db.invoice.create({
      data: {
        tenantId: tenant,
        customerId: o.customerId,
        issuingCompanyId: o.companyId ?? company1,
        issuingBranchId: o.branchId ?? branch1,
        status: 'DRAFT',
        subtotalExempt: total,
        totalAmount: total,
        netExpectedAmount: total,
      },
    });
    let n = 0;
    for (const a of amounts)
      await db.invoiceLine.create({
        data: {
          tenantId: tenant,
          invoiceId: inv.id,
          lineNo: ++n,
          serviceItemId: svc,
          description: `ค่าบริการเพิ่ม ${n}`,
          quantity: '1',
          unitLabel: 'ครั้ง',
          unitPrice: a,
          amount: a,
          vatType: 'EXEMPT_TRANSPORT',
          whtRate: '1.00',
          isUserAdded: true,
          doAnchor: false,
        },
      });
    // บรรทัดที่ถอดออกจากร่าง (ไม่อยู่บนเอกสาร) — ต้องไม่นับ
    const removed = await db.invoiceLine.create({
      data: {
        tenantId: tenant,
        invoiceId: inv.id,
        lineNo: ++n,
        serviceItemId: svc,
        description: 'บรรทัดที่ถอดออก',
        quantity: '1',
        unitLabel: 'ครั้ง',
        unitPrice: '50000.00',
        amount: '50000.00',
        vatType: 'EXEMPT_TRANSPORT',
        whtRate: '1.00',
        isUserAdded: true,
        doAnchor: false,
      },
    });
    await db.invoiceLine.update({
      where: { id: removed.id },
      data: { active: false, removedAt: new Date(), removedBy: 'test', removeReason: 'ทดสอบถอด' },
    });
    if ((o.status ?? 'ISSUED') === 'DRAFT') return inv.id;
    const f = issuedTestFields(`INV-RV-${++seed}`);
    const cu = await db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    await db.invoice.update({
      where: { id: inv.id },
      data: {
        ...f,
        status: 'ISSUED',
        issueDate: new Date(`${o.issue ?? today}T00:00:00.000Z`),
        customerSnapshot: { ...f.customerSnapshot, code: cu.code, name: cu.legalName },
        ...(o.issuer ? { issuerSnapshot: { ...f.issuerSnapshot, name: o.issuer } } : {}),
      },
    });
    return inv.id;
  };

  const report = async (q: string, token = admin) =>
    (await api(app, token).get(`/v1/reports/revenue?${q}`).expect(200)).body as Row;

  /** query อิสระจากหัวใบ: Σ ยอดก่อน VAT ของใบที่ออกในช่วง (ไม่รวมร่าง/ยกเลิก/void) */
  const issuedTotal = async (from: string, to: string, tenant = tenantId) => {
    const [r] = await db.$queryRaw<{ n: bigint; amt: Prisma.Decimal | null }[]>`
      SELECT count(*) AS n, sum(subtotal_vatable + subtotal_exempt + subtotal_zero_rated) AS amt
        FROM invoice
       WHERE tenant_id = ${tenant}::uuid AND status NOT IN ('DRAFT', 'CANCELLED', 'VOIDED')
         AND issue_date BETWEEN ${from}::date AND ${to}::date`;
    return { n: Number(r!.n), amount: D(r!.amt ?? 0).toFixed(2) };
  };

  let cus1: string;
  let cus2: string;
  let v1: { id: string; plate: string };
  let v2: { id: string; plate: string };
  const routes: { origin: string; dest: string }[] = [];

  let issuedA: Row;
  let issuedB: Row;
  /** ข้อมูลชุดเดียวของทุก test (สร้างครั้งเดียว — แต่ละ it ไม่พึ่งลำดับกัน) */
  beforeAll(async () => {
    cus1 = await newCustomer('ลูกค้า ก รายได้');
    cus2 = await newCustomer('ลูกค้า ข รายได้');
    v1 = await newVehicle();
    v2 = await newVehicle();
    // ทางจริง: ใบ A (ลูกค้า ก — DO 2 ใบ รถ 1 คันเดียวกัน 350 × 5 + 412.35 × 5) · ใบ B (ลูกค้า ข — DO 1 ใบ รถ 2)
    const d1 = await delivered(cus1, v1.id, '350');
    const d2 = await delivered(cus1, v1.id, '412.35');
    const d3 = await delivered(cus2, v2.id, '300');
    routes.push(d1, d2, d3);
    const a = await issueViaApi(cus1, [d1.doId, d2.doId]);
    const b = await issueViaApi(cus2, [d3.doId]);
    issuedA = a;
    issuedB = b;
    // นิติบุคคลที่สอง — สร้างหลังออกใบทางจริง (มีหลายนิติบุคคลแล้วใบสั่ง/ร่างต้องตั้ง routing)
    const c2 = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ขนส่งสอง จำกัด', taxId: validTaxId(972) },
    });
    company2 = c2.id;
    branch2 = (
      await db.branch.create({
        data: {
          tenantId,
          companyId: c2.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: ADDR,
        },
      })
    ).id;
    // ใบ C: ลูกค้า ข ผู้ออกนิติบุคคลที่สอง บรรทัดเพิ่มเอง (ไม่ผูก DO)
    await issueViaDb(['1000.10', '234.56'], {
      customerId: uuid('customer', cus2),
      companyId: company2,
      branchId: branch2,
      issuer: 'บริษัท ขนส่งสอง จำกัด',
    });
    // ไม่นับ: ใบที่ยกเลิกหลังออก · ร่าง · เดือนก่อน · บริษัทอื่น
    const cancelled = await issueViaDb(['999.99'], { customerId: uuid('customer', cus1) });
    await db.invoice.update({
      where: { id: cancelled },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: 'test',
        cancelReason: 'ทดสอบยกเลิกใบ',
      },
    });
    await issueViaDb(['5000.00'], { customerId: uuid('customer', cus1), status: 'DRAFT' });
    await issueViaDb(['4200.00'], { customerId: uuid('customer', cus1), issue: lastMonth.from });
    const oc = await db.customer.create({
      data: { tenantId: otherId, code: 'X-1', legalName: 'ลูกค้าบริษัทอื่น' },
    });
    const oco = await db.company.create({
      data: { tenantId: otherId, legalName: 'ผู้ออกอื่น', taxId: validTaxId(5999) },
    });
    const obr = await db.branch.create({
      data: {
        tenantId: otherId,
        companyId: oco.id,
        branchCode: '00000',
        branchLabel: 'สนญ.',
        address: ADDR,
      },
    });
    await issueViaDb(['666.00'], {
      tenant: otherId,
      customerId: oc.id,
      companyId: oco.id,
      branchId: obr.id,
    });
  }, 600_000);

  it('เกณฑ์ตรวจรับ: ยอดรวมเดือน = Σ ใบที่ออกในเดือน (ยกเลิก/ร่าง/เดือนอื่น/บริษัทอื่นไม่นับ) และทุกมิติรวมได้ยอดเดียวกัน', async () => {
    expect(issuedA.issueDate).toBe(today);
    // ทางจริงคิดยอดหัวใบจากบรรทัด — ยอดก่อน VAT ของใบ A = 1,750.00 + 2,061.75
    expect(
      D(issuedA.sellSubtotalVatable ?? 0)
        .add(D(issuedA.sellSubtotalExempt ?? 0))
        .add(D(issuedA.sellSubtotalZeroRated ?? 0))
        .toFixed(2),
    ).toBe('3811.75');
    expect(issuedB.status).toBe('ISSUED');
    // query อิสระ (หัวใบ) — เดือนนี้ 3 ใบ: 3,811.75 + 1,500.00 + 1,234.66
    const expected = await issuedTotal(monthRange(thisMonth).from, monthRange(thisMonth).to);
    expect(expected).toEqual({ n: 3, amount: '6546.41' });

    const byCustomer = await report('groupBy=customer');
    expect(byCustomer).toMatchObject({
      groupBy: 'customer',
      fromMonth: thisMonth,
      toMonth: thisMonth,
      from: `${thisMonth}-01`,
      asOf: today,
      invoiceCount: expected.n,
      sellAmount: expected.amount,
    });
    // = "ออกใบแจ้งหนี้เดือนนี้" ของ Dashboard บิล (ST9-T02 — ชุดสถานะเดียวกัน)
    const summary = (await api(app, admin).get('/v1/invoices/summary').expect(200)).body;
    expect(summary.issuedThisMonth.count).toBe(expected.n);

    // ทุกมิติ: Σ แถว = ยอดรวม
    const dims: Record<string, Row> = {};
    for (const g of ['customer', 'route', 'vehicle', 'vehicleType', 'legalEntity', 'month']) {
      const r = await report(`groupBy=${g}`);
      dims[g] = r;
      expect(r.sellAmount, g).toBe(expected.amount);
      expect(sum(r.data.map((x: Row) => x.sellAmount)), g).toBe(expected.amount);
      expect(
        r.data.reduce((n: number, x: Row) => n + x.lineCount, 0),
        g,
      ).toBe(r.lineCount);
    }
    const by = (g: string) =>
      Object.fromEntries(dims[g]!.data.map((x: Row) => [x.id, x])) as Record<string, Row>;

    // ลูกค้า — ชื่อ/รหัส ณ วันออก (snapshot) · เรียงรายได้มากไปน้อย
    expect(dims.customer!.data.map((x: Row) => [x.id, x.sellAmount])).toEqual([
      [cus1, '3811.75'],
      [cus2, '2734.66'],
    ]);
    expect(by('customer')[cus1]).toMatchObject({
      label: 'ลูกค้า ก รายได้',
      invoiceCount: 1,
      deliveryOrderCount: 2,
      lineCount: 2,
    });
    // นิติบุคคล — ผู้ออกใบ
    expect(by('legalEntity')[encodeId('company', company1)]).toMatchObject({
      label: 'บริษัท ขนส่งหนึ่ง จำกัด',
      detail: validTaxId(971),
      sellAmount: '5311.75',
      invoiceCount: 2,
    });
    expect(by('legalEntity')[encodeId('company', company2)]).toMatchObject({
      label: 'บริษัท ขนส่งสอง จำกัด',
      sellAmount: '1234.66',
    });
    // รถ — จากเที่ยวของ DO · บรรทัดไม่ผูก DO = ไม่ระบุ
    expect(by('vehicle')[v1.id]).toMatchObject({
      label: v1.plate,
      sellAmount: '3811.75',
      deliveryOrderCount: 2,
    });
    expect(by('vehicle')[v2.id]).toMatchObject({ label: v2.plate, sellAmount: '1500.00' });
    expect(by('vehicle').none).toMatchObject({ label: null, sellAmount: '1234.66', lineCount: 2 });
    // ประเภทรถ
    expect(by('vehicleType')[vt6]).toMatchObject({ detail: '6W', sellAmount: '5311.75' });
    expect(by('vehicleType').none!.sellAmount).toBe('1234.66');
    // เส้นทาง — ต้นทาง → ปลายทางของ DO
    const rk = (r: { origin: string; dest: string }) => `${r.origin}>${r.dest}`;
    expect(by('route')[rk(routes[0]!)]).toMatchObject({
      label: expect.stringMatching(/^ต้นทาง \d+ – ปลายทาง \d+$/),
      originName: expect.stringMatching(/^ต้นทาง \d+$/),
      destinationName: expect.stringMatching(/^ปลายทาง \d+$/),
      sellAmount: '1750.00',
    });
    expect(by('route')[rk(routes[1]!)]!.sellAmount).toBe('2061.75');
    expect(by('route').none!.sellAmount).toBe('1234.66');
    // เดือน — 1 แถว (เดือนนี้)
    expect(dims.month!.data).toEqual([
      expect.objectContaining({ id: thisMonth, label: thisMonth, invoiceCount: 3 }),
    ]);

    // ช่วง 2 เดือน รายเดือน: เดือนก่อน (4,200.00) + เดือนนี้ — แต่ละเดือนเท่ากับ query อิสระ
    const two = await report(
      `groupBy=month&fromMonth=${addMonths(thisMonth, -1)}&toMonth=${thisMonth}`,
    );
    const prev = await issuedTotal(lastMonth.from, lastMonth.to);
    expect(prev).toEqual({ n: 1, amount: '4200.00' });
    expect(two.data.map((x: Row) => [x.id, x.sellAmount])).toEqual([
      [lastMonth.month, prev.amount],
      [thisMonth, expected.amount],
    ]);
    expect(two.sellAmount).toBe(D(prev.amount).add(expected.amount).toFixed(2));

    // บริษัทอื่นเห็นเฉพาะของตน
    const o = await report('groupBy=customer', other);
    expect(o).toMatchObject({ invoiceCount: 1, sellAmount: '666.00' });
    expect(o.data).toHaveLength(1);
  });

  it('สิทธิ์: ไม่มีสิทธิ์ราคาขาย = เห็นจำนวนไม่เห็นยอด · ไม่มี reports.finance:read = 403 · แพ็กเกจไม่มีรายงาน = 403 · ตัวกรองผิด = 422', async () => {
    const r = await report('groupBy=vehicle', financeNoSell);
    expect(r.invoiceCount).toBe(3);
    expect(r).not.toHaveProperty('sellAmount');
    for (const x of r.data) expect(x).not.toHaveProperty('sellAmount');
    expect(r.data.map((x: Row) => x.lineCount)).toEqual([2, 2, 1]); // เรียงตามจำนวนบรรทัด (ไม่เผยลำดับยอด)

    await api(app, planner).get('/v1/reports/revenue').expect(403);

    // P1-ST1-T01: ทุกแพ็กเกจมีรายงานพื้นฐาน (docs/02 §2) — ปิดโมดูลด้วย override revoke
    const ent = app.get(EntitlementService);
    await db.tenantEntitlementOverride.create({
      data: { tenantId, featureKey: 'report', mode: 'revoke', reason: 'ทดสอบไม่มีโมดูลรายงาน' },
    });
    ent.invalidate(tenantId);
    try {
      const res = await api(app, admin).get('/v1/reports/revenue');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'feature_not_in_plan', featureKey: 'report' });
      const ex = await api(app, admin)
        .post('/v1/exports')
        .send({ resource: 'revenue', format: 'xlsx', filter: {} });
      expect(ex.status).toBe(403);
      expect(ex.body.code).toBe('feature_not_in_plan');
    } finally {
      await db.tenantEntitlementOverride.deleteMany({ where: { tenantId, featureKey: 'report' } });
      ent.invalidate(tenantId);
    }

    for (const q of [
      'groupBy=driver',
      'toMonth=2026-13',
      `fromMonth=${thisMonth}&toMonth=${addMonths(thisMonth, -1)}`,
      `fromMonth=${addMonths(thisMonth, -24)}&toMonth=${thisMonth}`,
      'month=2026-11',
    ])
      await api(app, admin).get(`/v1/reports/revenue?${q}`).expect(422);
    // 24 เดือนพอดีได้
    await api(app, admin)
      .get(`/v1/reports/revenue?fromMonth=${addMonths(thisMonth, -23)}&toMonth=${thisMonth}`)
      .expect(200);
  });

  describe('ส่งออก (ST9-T10 งานเบื้องหลัง) — xlsx / pdf', () => {
    let userId: string;
    let noSellUser: string;
    beforeAll(async () => {
      const roles = await ensureSystemRoles(db, tenantId);
      const mk = async (email: string, role: string) => {
        const u = await db.appUser.create({
          data: { tenantId, email, name: email, status: 'ACTIVE' },
        });
        await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles[role]! } });
        return u.id;
      };
      userId = await mk('admin@rev.test', 'admin');
      noSellUser = await mk('fin@rev.test', 'admin');
    });
    const exportNow = async (body: object, scope = '*', user = userId) => {
      const a = api(app, await tokenFor(tenantId, scope, user));
      const r = await a.post('/v1/exports').send(body).expect(202);
      while (await app.get(JobQueue).runOnce()) {
        /* drain */
      }
      return (await a.get(r.body.statusUrl).expect(200)).body as Row;
    };
    const download = async (url: string): Promise<Buffer> => {
      const u = new URL(url);
      const r = await request(app.getHttpServer())
        .get(u.pathname + u.search)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      return r.body as Buffer;
    };

    it('xlsx ต่อลูกค้า: แถว = รายงาน + แถว "รวม" · ผู้ไม่มีสิทธิ์ราคาขายไม่มีคอลัมน์รายได้', async () => {
      const st = await exportNow({
        resource: 'revenue',
        format: 'xlsx',
        filter: { groupBy: 'customer' },
      });
      expect(st).toMatchObject({ status: 'succeeded', resource: 'revenue', rows: 2 });
      expect(st.fileName).toMatch(/^revenue-\d{8}-\d{4}\.xlsx$/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await download(st.downloadUrl)) as unknown as ArrayBuffer);
      const out: string[][] = [];
      wb.worksheets[0]!.eachRow((row) =>
        out.push((row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v)))),
      );
      expect(out[0]).toEqual([
        'ลูกค้า',
        'รหัสลูกค้า',
        'ใบแจ้งหนี้',
        'DO',
        'บรรทัด',
        'รายได้ (ก่อน VAT)',
      ]);
      expect(out.slice(1).map((r) => [r[0], r[5]])).toEqual([
        ['ลูกค้า ก รายได้', '3811.75'],
        ['ลูกค้า ข รายได้', '2734.66'],
        ['รวม', '6546.41'],
      ]);

      const ns = await exportNow(
        { resource: 'revenue', format: 'csv', filter: { groupBy: 'month' } },
        'reports.finance:read export:run',
        noSellUser,
      );
      const csv = (await download(ns.downloadUrl))
        .toString('utf8')
        .slice(1)
        .trimEnd()
        .split('\r\n');
      expect(csv[0]).toBe('เดือน,ใบแจ้งหนี้,DO,บรรทัด');
      expect(csv.join('\n')).not.toContain('6546.41');
      expect(csv.at(-1)).toBe('รวม,3,3,5');
    });

    it('pdf ต่อรถ: ไฟล์ PDF จริง · resource อื่นขอ pdf = 422', async () => {
      const st = await exportNow({
        resource: 'revenue',
        format: 'pdf',
        filter: { groupBy: 'vehicle' },
      });
      expect(st).toMatchObject({ status: 'succeeded', format: 'pdf', rows: 3 });
      expect(st.fileName).toMatch(/\.pdf$/);
      const buf = await download(st.downloadUrl);
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const a = api(app, await tokenFor(tenantId, '*', userId));
      await a
        .post('/v1/exports')
        .send({ resource: 'customers', format: 'pdf', filter: {} })
        .expect(422);
    });
  });
});
