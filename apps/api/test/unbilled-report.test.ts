import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { Clock } from '../src/common/clock';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { renderNotification } from '../src/modules/notifications/templates';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import {
  UNBILLED_REMINDER_JOB,
  UnbilledReminderService,
} from '../src/modules/reminders/unbilled-reminder.service';
import { unbilledExportSpec } from '../src/modules/reports/reports.controller';
import { UnbilledReportService } from '../src/modules/reports/unbilled-report.service';
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
const cents = (s: string | undefined | null) => Math.round(Number(s ?? '0') * 100);

/**
 * ST9-T06 รายงาน "DO ยังไม่วางบิลเกิน N วัน" + แจ้งผู้วางบิลอัตโนมัติ + ส่งออก (D-54) — เกณฑ์ตรวจรับ:
 * DO ที่ส่งแล้วเกิน N วันและยังไม่อยู่ในใบใดขึ้นรายงาน (เทียบกับ query ตรงจากใบแจ้งหนี้/บรรทัด) · ยอด aging ตรงกับ ST5-T22
 */
describe('รายงาน DO ยังไม่วางบิล + aging (ST9-T06)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let clock: Clock;
  let reminders: UnbilledReminderService;
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let invoicer: string;
  let financeNoSell: string;
  let planner: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  let customer: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const NONE_REQ = { success: { fields: [] } };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    clock = app.get(Clock);
    reminders = app.get(UnbilledReminderService);
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท รายงานค้างบิล' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(961) },
    });
    await db.branch.create({
      data: {
        tenantId,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
    admin = await tokenFor(tenantId);
    invoicer = await tokenFor(tenantId, SYSTEM_ROLES.invoicer.permissions.join(' '), 'u-inv');
    financeNoSell = await tokenFor(tenantId, 'reports.finance:read invoices:read', 'u-fin');
    planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-plan');
    other = await tokenFor(otherId);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as Row[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as Row[];
    vt6 = types.find((t) => t.code === '6W')!.id;
    const cus = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: 'ลูกค้าค้างบิล', taxId: validTaxId(9951), externalId: 'CUS-UB-1' })
        .expect(201)
    ).body as { id: string };
    await db.customer.update({
      where: { id: uuid('customer', cus.id) },
      data: { podRequirements: NONE_REQ, paymentTermDays: 30 },
    });
    customer = cus.id;
  });
  afterEach(() => clock.set(null));
  afterAll(async () => {
    clock.set(null);
    await app.close();
    await db.$disconnect();
  });

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
  const newVehicle = async () => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `6${++seed % 10}-${String(5000 + seed)}`,
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
        phone: `085-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    return v.id;
  };
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const post = (stop: string, action: string, min: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/stops/${stop}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra });

  /** rate card 350/ตัน → SO 5 ตัน → DO → เที่ยว → ส่งสำเร็จ → ส่งบัญชี (ยอด 1,750.00) */
  const delivered = async () => {
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
          sellRate: '350',
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
    const vid = await newVehicle();
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [doId], vehicleId: vid })
        .expect(201)
    ).body;
    const a = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: vid, dispatch: true });
    if (a.status !== 200)
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: vid,
          dispatch: true,
          ruleKeys: a.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบรายงานค้างบิล',
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
    return { doId, uuid: d!.id };
  };

  /** วันนี้ + n วัน (เวลาไทย 10:00) */
  const at = (n: number) => new Date(`${addDays(today, n)}T03:00:00Z`);
  const report = async (qs = '', token = admin) =>
    (await api(app, token).get(`/v1/reports/unbilled-delivery-orders${qs}`).expect(200))
      .body as Row;

  /**
   * นิยามอิสระ (ไม่ใช้ billing_status): DO ส่งถึงแล้วที่ไม่มีบรรทัด active ในใบแจ้งหนี้ที่ยังไม่ยกเลิก
   * + วันที่ส่งถึง (เวลาไทย) จากประวัติสถานะ ≤ asOf − N − 1
   */
  const direct = async (asOf: string, n: number): Promise<string[]> => {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT d.id FROM delivery_order d
       WHERE d.tenant_id = ${tenantId}::uuid
         AND d.status::text IN ('DELIVERED', 'POD_PENDING', 'UNBILLED')
         AND NOT EXISTS (
           SELECT 1 FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id
            WHERE il.delivery_order_id = d.id AND il.active AND i.status::text NOT IN ('CANCELLED', 'VOIDED'))
         AND (SELECT (max(h.at) AT TIME ZONE 'Asia/Bangkok')::date FROM doc_status_history h
               WHERE h.doc_id = d.id AND h.doc_type = 'delivery_order' AND h.event = 'deliver')
             <= ${addDays(asOf, -(n + 1))}::date`;
    return rows.map((r) => encodeId('deliveryOrder', r.id)).sort();
  };
  const ids = (b: Row) => (b.data as Row[]).map((x) => x.id as string).sort();

  let d1: Awaited<ReturnType<typeof delivered>>;
  let d2: Awaited<ReturnType<typeof delivered>>;
  let d3: Awaited<ReturnType<typeof delivered>>;
  let draftId: string;

  it('เกณฑ์ตรวจรับ: DO ส่งแล้วเกิน N วัน และยังไม่อยู่ในใบใด ขึ้นรายงาน · ในร่างไม่ขึ้น · ยกเลิกร่างกลับมา · ตรงกับ query ตรง', async () => {
    d1 = await delivered();
    d2 = await delivered();
    d3 = await delivered();
    // d3 อยู่ในร่างใบแจ้งหนี้ → ไม่ขึ้นรายงาน
    draftId = (
      await api(app, invoicer)
        .post('/v1/invoices')
        .send({ customerId: customer, deliveryOrderIds: [d3.doId] })
        .expect(201)
    ).body.id;

    // วันนี้: ยังไม่เกิน 7 วัน (ค่าเริ่ม)
    const r0 = await report();
    expect(r0).toMatchObject({ asOf: today, minDays: 7, count: 0, data: [], hasMore: false });
    expect(r0.deliveredOnOrBefore).toBe(addDays(today, -8));

    // +7 วัน = ส่งถึงมา 7 วัน → ยัง "ไม่เกิน" 7
    clock.set(at(7));
    expect((await report()).count).toBe(0);

    // +8 วัน → เกิน 7 วัน
    clock.set(at(8));
    const r1 = await report();
    expect(ids(r1)).toEqual([d1.doId, d2.doId].sort());
    expect(ids(r1)).toEqual(await direct(addDays(today, 8), 7));
    expect(r1.count).toBe(2);
    const row = (r1.data as Row[]).find((x) => x.id === d1.doId)!;
    expect(row).toMatchObject({
      status: 'UNBILLED',
      billingStatus: 'UNBILLED',
      deliveredOn: today,
      daysSinceDelivery: 8,
      sellAmount: '1750.00',
      customer: { id: customer, code: expect.any(String), legalName: 'ลูกค้าค้างบิล' },
    });
    expect(row.deliveredAt).toEqual(expect.any(String));
    expect(row.releasedAt).toEqual(expect.any(String));
    expect(cents(r1.sellAmount)).toBe(
      (r1.data as Row[]).reduce((a, x) => a + cents(x.sellAmount), 0),
    );

    // D-71 ธง "ร่างค้างเกิน N วัน": d3 อยู่ในร่างมา 8 วัน (> 7) → ขึ้นเมื่อ includeStaleDrafts=true พร้อม id ร่าง + อายุ
    const s1 = await report('?includeStaleDrafts=true');
    expect(ids(s1)).toEqual([d1.doId, d2.doId, d3.doId].sort());
    expect(s1).toMatchObject({ count: 3, staleDraftCount: 1, includeStaleDrafts: true });
    expect((s1.data as Row[]).find((x) => x.id === d3.doId)).toMatchObject({
      billingStatus: 'IN_DRAFT',
      draftInvoice: { id: draftId, addedOn: today, ageDays: 8, addedAt: expect.any(String) },
    });
    expect((s1.data as Row[]).find((x) => x.id === d1.doId)!.draftInvoice).toBeNull();
    expect(cents(s1.sellAmount)).toBe(
      (s1.data as Row[]).reduce((a, x) => a + cents(x.sellAmount), 0),
    );
    // ค่าเริ่ม (ไม่ส่ง/false) = เดิม
    expect(r1).toMatchObject({ includeStaleDrafts: false, staleDraftCount: null });
    expect((await report('?includeStaleDrafts=false')).count).toBe(2);
    await api(app, admin)
      .get('/v1/reports/unbilled-delivery-orders?includeStaleDrafts=yes')
      .expect(422);
    // ร่างยังไม่เกิน N (อยู่ในร่าง 7 วัน = ไม่เกิน 7) → ไม่ขึ้น
    clock.set(at(7));
    expect(await report('?includeStaleDrafts=true')).toMatchObject({
      count: 0,
      staleDraftCount: 0,
    });
    expect((await report('?includeStaleDrafts=true&minDays=6')).staleDraftCount).toBe(1);
    clock.set(at(8));
    // อายุนับจากวันที่ DO เข้าร่าง (invoice_line.created_at ของบรรทัดหลัก) — เลื่อนเวลาเข้าร่างไป 3 วันก่อน → 11 วัน
    await db.$executeRaw`UPDATE invoice_line SET created_at = created_at - interval '3 days'
      WHERE delivery_order_id = ${d3.uuid}::uuid AND active`;
    try {
      const s2 = await report('?includeStaleDrafts=true&minDays=10');
      expect(ids(s2)).toEqual([d3.doId]);
      expect((s2.data as Row[])[0]!.draftInvoice).toMatchObject({
        addedOn: addDays(today, -3),
        ageDays: 11,
      });
    } finally {
      await db.$executeRaw`UPDATE invoice_line SET created_at = created_at + interval '3 days'
        WHERE delivery_order_id = ${d3.uuid}::uuid AND active`;
    }

    // ยกเลิกร่าง → d3 กลับมา (ใบที่ยกเลิกคืน DO — ST5-T10)
    await api(app, invoicer)
      .post(`/v1/invoices/${draftId}/cancel`)
      .send({ reason: 'ทดสอบยกเลิกร่างเพื่อดูรายงาน' })
      .expect(200);
    const r2 = await report();
    expect(ids(r2)).toEqual([d1.doId, d2.doId, d3.doId].sort());
    expect(ids(r2)).toEqual(await direct(addDays(today, 8), 7));
    // D-71: ยกเลิกร่างแล้ว d3 ไม่ใช่ "ร่างค้าง" อีก (คืนเป็นยังไม่วางบิล)
    const s3 = await report('?includeStaleDrafts=true');
    expect(s3).toMatchObject({ count: 3, staleDraftCount: 0 });
    expect((s3.data as Row[]).find((x) => x.id === d3.doId)).toMatchObject({
      billingStatus: 'UNBILLED',
      draftInvoice: null,
    });

    // d2 เข้าร่างใบใหม่ → หลุดจากรายงาน
    const inv2 = (
      await api(app, invoicer)
        .post('/v1/invoices')
        .send({ customerId: customer, deliveryOrderIds: [d2.doId] })
        .expect(201)
    ).body.id as string;
    expect(inv2).toEqual(expect.any(String));
    const r3 = await report();
    expect(ids(r3)).toEqual([d1.doId, d3.doId].sort());
    expect(ids(r3)).toEqual(await direct(addDays(today, 8), 7));
    // d2 อยู่ในร่างใหม่ 8 วัน (> 7) → ร่างค้าง
    const s4 = await report('?includeStaleDrafts=true');
    expect(s4).toMatchObject({ count: 3, staleDraftCount: 1 });
    expect((s4.data as Row[]).find((x) => x.id === d2.doId)!.draftInvoice).toMatchObject({
      id: inv2,
      ageDays: 8,
      createdOn: today,
    });

    // review L6 (พฤติกรรมที่บันทึกไว้ — spec/12 ข้อ 17 [DECISION — ย้อนได้]): ย้าย DO ไปร่างใหม่ = นับอายุใหม่จากวันที่เข้าร่างใหม่
    await db.$executeRaw`UPDATE invoice_line SET created_at = created_at - interval '5 days'
      WHERE delivery_order_id = ${d2.uuid}::uuid AND active`;
    expect(
      ((await report('?includeStaleDrafts=true')).data as Row[]).find((x) => x.id === d2.doId)!
        .draftInvoice.ageDays,
    ).toBe(13);
    await api(app, invoicer)
      .post(`/v1/invoices/${inv2}/cancel`)
      .send({ reason: 'ทดสอบย้าย DO ไปร่างใหม่' })
      .expect(200);
    const inv3 = (
      await api(app, invoicer)
        .post('/v1/invoices')
        .send({ customerId: customer, deliveryOrderIds: [d2.doId] })
        .expect(201)
    ).body.id as string;
    expect(
      ((await report('?includeStaleDrafts=true')).data as Row[]).find((x) => x.id === d2.doId)!
        .draftInvoice,
    ).toMatchObject({ id: inv3, ageDays: 8, addedOn: today });
  });

  it('เกณฑ์ N: minDays / ค่าตั้งองค์กร billing.unbilledAlertDays · ตัวกรองลูกค้า · cursor', async () => {
    clock.set(at(8));
    expect((await report('?minDays=8')).count).toBe(0);
    expect((await report('?minDays=7')).count).toBe(2);
    expect((await report('?minDays=1')).count).toBe(2);
    await api(app, admin).get('/v1/reports/unbilled-delivery-orders?minDays=0').expect(422);
    await api(app, admin).get('/v1/reports/unbilled-delivery-orders?minDays=366').expect(422);
    await api(app, admin).get('/v1/reports/unbilled-delivery-orders?cursor=xyz').expect(422);

    // ค่าตั้งองค์กร
    const s = (await api(app, admin).get('/v1/settings').expect(200)).body as Row;
    const list = (Array.isArray(s) ? s : s.data) as Row[];
    expect(list.find((x) => x.key === 'billing.unbilledAlertDays')).toMatchObject({ value: 7 });
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'billing.unbilledAlertDays': 10 } })
      .expect(200);
    expect(await report()).toMatchObject({ minDays: 10, count: 0 });
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'billing.unbilledAlertDays': 0 } })
      .expect(422);
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'billing.unbilledAlertDays': 7 } })
      .expect(200);

    // ลูกค้า (id / ext:) · ลูกค้าอื่น = ว่าง
    expect((await report(`?customerId=${customer}`)).count).toBe(2);
    expect((await report('?customerId=ext:CUS-UB-1')).count).toBe(2);
    expect((await report('?customerId=ext:NOPE')).count).toBe(0);

    // cursor: หน้าละ 1 → ครบ 2 แถว ไม่ซ้ำ เรียงส่งถึงเก่าสุดก่อน
    const p1 = await report('?limit=1');
    expect(p1).toMatchObject({ hasMore: true, count: 2 });
    const p2 = await report(`?limit=1&cursor=${p1.nextCursor}`);
    expect(p2.hasMore).toBe(false);
    // review L4: ยอดรวมเฉพาะหน้าแรก
    expect(p2.count).toBeNull();
    expect(p2.sellAmount).toBeUndefined();
    const all = [...(p1.data as Row[]), ...(p2.data as Row[])];
    expect(new Set(all.map((x) => x.id)).size).toBe(2);
    expect(all[0]!.deliveredAt <= all[1]!.deliveredAt).toBe(true);
  });

  it('review L3: cursor ไม่ขึ้นกับความละเอียดเวลา — เวลาส่งถึงระดับไมโครวินาที (และเท่ากัน) เดินหน้าละ 1 ไม่ซ้ำ ไม่ตกหล่น', async () => {
    clock.set(at(8));
    const ids0 = ids(await report('?limit=50'));
    // เวลาส่งถึงของทุก DO = ค่าเดียวกันระดับ µs (ms ของ JS ปัดทิ้ง .000456) → ต้องเรียงด้วย id ต่อ
    const saved = await db.$queryRaw<{ id: string; at: Date }[]>`
      SELECT id, at FROM doc_status_history WHERE tenant_id = ${tenantId}::uuid AND event = 'deliver'`;
    try {
      await db.$executeRaw`
        UPDATE doc_status_history SET at = date_trunc('day', at) + interval '03:04:05.123456'
         WHERE tenant_id = ${tenantId}::uuid AND event = 'deliver'`;
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const p: Row = await report(`?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...(p.data as Row[]).map((x) => x.id as string));
        cursor = p.nextCursor;
        if (!cursor) break;
      }
      expect(seen.length).toBe(ids0.length);
      expect([...seen].sort()).toEqual(ids0);
    } finally {
      for (const r of saved)
        await db.$executeRaw`UPDATE doc_status_history SET at = ${r.at} WHERE id = ${r.id}::uuid`;
    }
  });

  it('สิทธิ์: ต้องมี reports.finance:read · ไม่มี prices.sell:read = ไม่เห็นมูลค่า · tenant อื่นไม่เห็น', async () => {
    clock.set(at(8));
    await api(app, planner).get('/v1/reports/unbilled-delivery-orders').expect(403);
    const r = await report('', financeNoSell);
    expect(r.count).toBe(2);
    expect(r.sellAmount).toBeUndefined();
    expect((r.data as Row[])[0]!.sellAmount).toBeUndefined();
    const o = await report('', other);
    expect(o).toMatchObject({ count: 0, data: [] });
    expect((await report(`?customerId=${customer}`, other)).count).toBe(0);
    expect(await report('?includeStaleDrafts=true', other)).toMatchObject({
      count: 0,
      staleDraftCount: 0,
      data: [],
    });
    expect((await report('?includeStaleDrafts=true', financeNoSell)).staleDraftCount).toBe(1);
  });

  it('ยอด aging ของหน้ารายงาน = GET /payments/aging (ST5-T22) และ Σ ช่วง = ยอดค้างรวม', async () => {
    const c = await db.company.findFirstOrThrow({ where: { tenantId } });
    const b = await db.branch.findFirstOrThrow({ where: { tenantId } });
    const cus = uuid('customer', customer);
    for (const [i, due, total] of [
      [1, addDays(today, 5), '1000.00'],
      [2, addDays(today, -45), '250.50'],
      [3, addDays(today, -120), '99.99'],
    ] as const)
      await db.invoice.create({
        data: {
          tenantId,
          customerId: cus,
          issuingCompanyId: c.id,
          issuingBranchId: b.id,
          status: 'ISSUED',
          totalAmount: total,
          subtotalExempt: total,
          ...issuedTestFields(`INV-UB-${i}`),
          issueDate: new Date(`${addDays(due, -30)}T00:00:00.000Z`),
          dueDate: new Date(`${due}T00:00:00.000Z`),
        },
      });
    const ag = (await api(app, admin).get('/v1/payments/aging').expect(200)).body as Row;
    const sum = (await api(app, admin).get('/v1/payments/summary').expect(200)).body as Row;
    expect(cents(ag.sellOutstanding)).toBe(cents(sum.sellOutstanding));
    const mine = (ag.data as Row[]).find((x) => x.customer.id === customer)!;
    expect(mine.buckets.map((x: Row) => x.sellOutstanding)).toEqual([
      '1000.00',
      '0.00',
      '250.50',
      '0.00',
      '99.99',
    ]);
    expect(mine.buckets.reduce((a: number, x: Row) => a + cents(x.sellOutstanding), 0)).toBe(
      cents(mine.sellOutstanding),
    );
  });

  it('ส่งออก: unbilled-delivery-orders + receivables-aging (job) — จำนวนแถวตรงกับรายงาน · สิทธิ์/ตัวกรองตรวจตอนสั่ง', async () => {
    clock.set(at(8));
    const { JobQueue } = await import('../src/jobs/job-queue.service');
    const q = app.get(JobQueue);
    const runExport = async (resource: string, token = admin, filter = {}) => {
      const j = (
        await api(app, token)
          .post('/v1/exports')
          .send({ resource, format: 'xlsx', filter })
          .expect(202)
      ).body as Row;
      for (let i = 0; i < 20 && (await q.runOnce()); i++);
      const s = (await api(app, token).get(`/v1/exports/${j.id}`).expect(200)).body as Row;
      expect(s.status).toBe('succeeded');
      return s;
    };
    expect((await runExport('unbilled-delivery-orders')).rows).toBe((await report()).count);
    expect((await runExport('unbilled-delivery-orders', admin, { minDays: '8' })).rows).toBe(0);
    // D-71: ส่งออกพร้อมร่างค้าง — จำนวนแถวตรงกับรายงาน + คอลัมน์ id ร่าง / อายุในร่าง
    const withDrafts = (await report('?includeStaleDrafts=true')).count as number;
    expect(withDrafts).toBe(3);
    expect(
      (await runExport('unbilled-delivery-orders', admin, { includeStaleDrafts: 'true' })).rows,
    ).toBe(withDrafts);
    // review L4: คอลัมน์ร่างอยู่ท้ายตาราง เฉพาะเมื่อสั่งแบบรวมร่าง · ระบุร่างด้วยวันที่สร้าง (ไม่ใช่ id)
    const spec = unbilledExportSpec(app.get(UnbilledReportService));
    const DRAFT_COLS = ['ร่างใบแจ้งหนี้ (วันที่สร้าง)', 'วันที่เข้าร่าง', 'อยู่ในร่าง (วัน)'];
    const plain = spec.columns(['prices.sell:read'], {}).map((c) => c.header);
    expect(plain.filter((h) => DRAFT_COLS.includes(h))).toEqual([]);
    const cols = spec.columns(['prices.sell:read'], { includeStaleDrafts: 'true' });
    expect(cols.map((c) => c.header)).toEqual([...plain, ...DRAFT_COLS]);
    const rows = (await report('?includeStaleDrafts=true')).data as Row[];
    const dr = rows.find((x) => x.draftInvoice)!;
    const val = (h: string, r: Row) => cols.find((c) => c.header === h)!.value(r as never);
    expect(val('ร่างใบแจ้งหนี้ (วันที่สร้าง)', dr)).toBe(today);
    expect(val('วันที่เข้าร่าง', dr)).toBe(today);
    expect(val('อยู่ในร่าง (วัน)', dr)).toBe(8);
    expect(
      val(
        'อยู่ในร่าง (วัน)',
        rows.find((x) => !x.draftInvoice)!,
      ),
    ).toBeNull();
  });

  describe('แจ้งผู้วางบิลอัตโนมัติ (job delivery_order.unbilled)', () => {
    let n = 0;
    const member = async (role: string, status: 'ACTIVE' | 'DISABLED' = 'ACTIVE') => {
      const roles = await ensureSystemRoles(db, tenantId);
      const u = await db.appUser.create({
        data: {
          tenantId,
          email: `${role}-${++n}@unbilled.test`,
          name: `${role} ${n}`,
          status,
          locale: 'th',
        },
      });
      await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles[role]! } });
      return u.id;
    };
    const inbox = (userId: string) =>
      db.notification.findMany({
        where: { tenantId, recipientId: userId, templateCode: 'delivery_order.unbilled' },
        orderBy: { createdAt: 'asc' },
      });

    it('D-71: ผู้วางบิล (invoices:draft) ได้สรุปทุกเช้าที่ยังมีใบค้าง — แยก เพิ่งเกินวันนี้ / ค้างทั้งหมด / ร่างค้าง · วันละฉบับ · ไม่มีค้าง = ไม่ส่ง · ไม่ใส่ยอดเงิน · ปิดรับได้', async () => {
      const inv = await member('invoicer');
      const acc = await member('accounting');
      const pl = await member('planner');
      const off = await member('invoicer', 'DISABLED');
      const D = addDays(today, 8);
      const d3DoNo = (await db.deliveryOrder.findUniqueOrThrow({ where: { id: d3.uuid } })).doNo!;
      const inApp = async (u: string) => (await inbox(u)).filter((x) => x.channel === 'in_app');

      // ไม่มีใบค้าง (ทุก DO ส่งถึงวันนี้ · ร่างอายุ 0 วัน) → ไม่ส่ง
      const r0 = await reminders.runForTenant(tenantId, today);
      expect(r0).toMatchObject({ outstanding: 0, staleDrafts: 0, digests: 0, recipients: 0 });
      expect(await inbox(inv)).toHaveLength(0);

      // review L6: ไม่มี DO ค้าง แต่มีร่างค้างเกิน N วัน → ส่ง (ข้อความชวนออกเอกสารร่าง + ลิงก์หน้าวางบิล — L5)
      await db.$executeRaw`UPDATE invoice_line SET created_at = created_at - interval '10 days'
        WHERE delivery_order_id = ${d2.uuid}::uuid AND active`;
      try {
        const rd = await reminders.runForTenant(tenantId, today);
        expect(rd).toMatchObject({ outstanding: 0, staleDrafts: 1, fresh: 0 });
        expect(rd.digests).toBeGreaterThanOrEqual(2);
      } finally {
        await db.$executeRaw`UPDATE invoice_line SET created_at = created_at + interval '10 days'
          WHERE delivery_order_id = ${d2.uuid}::uuid AND active`;
      }
      const dOnly = (await inApp(inv))[0]!;
      expect(dOnly.title).toBe('ร่างใบแจ้งหนี้ค้างเกิน 7 วัน 1 ใบ');
      expect(dOnly.body).toContain('ออกเอกสารใบแจ้งหนี้ร่าง');
      expect(dOnly.body).not.toContain('ค้างทั้งหมด');
      expect(dOnly.link).toBe('/bill');

      // วันแรกที่เกิน: d1, d3 เพิ่งเกินวันนี้ (ส่งถึง D − 8) · d2 อยู่ในร่างมา 8 วัน
      const r1 = await reminders.runForTenant(tenantId, D);
      expect(r1).toMatchObject({
        minDays: 7,
        fresh: 2,
        outstanding: 2,
        staleDrafts: 1,
        failedRecipients: 0,
      });
      expect(r1.digests).toBeGreaterThanOrEqual(2);
      const m = await inbox(inv);
      expect(m.filter((x) => x.channel === 'in_app')).toHaveLength(2);
      expect(m.filter((x) => x.channel === 'email')).toHaveLength(2);
      const n0 = m.filter((x) => x.channel === 'in_app').at(-1)!;
      expect(n0.title).toBe('DO ยังไม่วางบิลเกิน 7 วัน');
      expect(n0.body).toContain(
        'เพิ่งเกินวันนี้ 2 ใบ · ค้างทั้งหมด 2 ใบ · อยู่ในร่างใบแจ้งหนี้ค้างเกิน 7 วัน 1 ใบ',
      );
      expect(n0.link).toBe('/reports?tab=unbilled');
      expect(`${n0.title} ${n0.body}`).not.toMatch(/1,?750|฿/);
      const mail = m.filter((x) => x.channel === 'email').at(-1)!;
      expect(JSON.stringify(mail)).not.toMatch(/1,?750|฿/);
      expect((await inbox(acc)).length).toBeGreaterThan(0);
      expect(await inbox(pl)).toHaveLength(0);
      expect(await inbox(off)).toHaveLength(0);

      // รันซ้ำวันเดียวกัน → ไม่ส่งซ้ำ (สมุดเตือน 1 แถว/คน/วัน)
      const r2 = await reminders.runForTenant(tenantId, D);
      expect(r2.digests).toBe(0);
      expect(await inbox(inv)).toHaveLength(4);
      // review L1: สมุดเตือน 1 แถว/คน/วัน รูปแบบ TENANT / UNBILLED_DAILY (migration 0161)
      const led = await db.expiryReminder.findMany({
        where: { tenantId, recipientId: inv, sentOn: new Date(`${D}T00:00:00Z`) },
      });
      expect(led).toHaveLength(1);
      expect(led[0]).toMatchObject({
        entityType: 'TENANT',
        entityId: tenantId,
        level: 'UNBILLED_DAILY',
        expiresOn: new Date(`${D}T00:00:00Z`),
      });

      // review L6: วันที่ deploy — ผู้รับมีแถวแบบเดิม (ต่อ DO) ของวันนั้นแล้ว → ไม่ได้ฉบับที่สอง
      const legacy = await member('invoicer');
      await db.expiryReminder.create({
        data: {
          tenantId,
          entityType: 'DELIVERY_ORDER',
          entityId: d1.uuid,
          level: 'UNBILLED',
          expiresOn: new Date(`${today}T00:00:00Z`),
          recipientId: legacy,
          sentOn: new Date(`${addDays(D, 1)}T00:00:00Z`),
        },
      });

      // วันถัดไป: ยังค้าง → ส่งอีกฉบับ (ไม่มีใบเพิ่งเกิน)
      const r3 = await reminders.runForTenant(tenantId, addDays(D, 1));
      expect(r3).toMatchObject({ fresh: 0, outstanding: 2, staleDrafts: 1 });
      expect(r3.digests).toBeGreaterThanOrEqual(2);
      const day2 = (await inApp(inv)).at(-1)!;
      expect(await inApp(inv)).toHaveLength(3);
      expect(await inbox(legacy)).toHaveLength(0);
      expect(day2.body).toContain('เพิ่งเกินวันนี้ 0 ใบ · ค้างทั้งหมด 2 ใบ');

      // ยกเลิกร่างของ d2 → ไม่ใช่ร่างค้างแล้ว กลับมาเป็นค้างวางบิล (ไม่นับเป็น "เพิ่งเกินวันนี้" — เกินเกณฑ์มาก่อนแล้ว)
      const inv2 = await db.invoiceLine.findFirstOrThrow({
        where: { deliveryOrderId: d2.uuid, active: true },
        select: { invoiceId: true },
      });
      await api(app, invoicer)
        .post(`/v1/invoices/${encodeId('invoice', inv2.invoiceId)}/cancel`)
        .send({ reason: 'ทดสอบยกเลิกร่างเพื่อแจ้งเตือน' })
        .expect(200);
      const r4 = await reminders.runForTenant(tenantId, addDays(D, 2));
      expect(r4).toMatchObject({ fresh: 0, outstanding: 3, staleDrafts: 0 });
      const day3 = (await inApp(inv)).at(-1)!;
      expect(day3.body).toContain('ค้างทั้งหมด 3 ใบ');
      expect(day3.body).not.toContain('ร่าง');

      // ปิดรับทั้งกระดิ่งและอีเมลของ event → ไม่ได้ข้อความ
      const fresh = await member('invoicer');
      await db.userPreference.create({
        data: {
          tenantId,
          userId: fresh,
          key: 'notifications',
          value: { events: { 'delivery_order.unbilled': { in_app: false, email: false } } },
        },
      });
      await reminders.runForTenant(tenantId, addDays(D, 3));
      expect(await inbox(fresh)).toHaveLength(0);
      expect(await inApp(inv)).toHaveLength(5);

      // review M1: แพ็กเกจไม่มีโมดูลรายงาน (start) → ลิงก์หน้าวางบิล + ข้อความชี้หน้าวางบิล · แพ็กเกจที่มี → ลิงก์รายงาน
      const ent = app.get(EntitlementService);
      const late = await member('invoicer');
      await db.tenant.update({ where: { id: tenantId }, data: { planCode: 'start' } });
      ent.invalidate(tenantId);
      try {
        await reminders.runForTenant(tenantId, addDays(D, 4));
        const s1 = (await inbox(late)).find((x) => x.channel === 'in_app')!;
        expect(s1.link).toBe('/bill');
        expect(s1.title).toBe('DO ยังไม่วางบิลเกิน 7 วัน');
        expect(s1.body).toContain('ค้างทั้งหมด 3 ใบ');
        expect(s1.body).toContain('หน้า วางบิลและใบแจ้งหนี้');
        expect(s1.body).not.toContain('รายงาน');
      } finally {
        await db.tenant.update({ where: { id: tenantId }, data: { planCode: 'std' } });
        ent.invalidate(tenantId);
      }
      expect(n0.body).toContain('รายงาน → DO ยังไม่วางบิล');

      // review L2: วันที่ job ไม่ได้รัน (D+5) ไม่ตกหล่น — d3 ข้ามเกณฑ์วัน D+5 → นับเป็น "เพิ่งเกิน" ในฉบับ D+6
      await db.$executeRaw`UPDATE doc_status_history SET at = at + interval '5 days'
        WHERE doc_type = 'delivery_order' AND event = 'deliver' AND doc_id = ${d3.uuid}::uuid`;
      try {
        const D6 = addDays(D, 6);
        // นับแบบ "ข้ามเกณฑ์วันนี้พอดี" จะได้ 0
        expect((await run((tx) => reminders.counts(tx, D6, 7))).fresh).toBe(0);
        const r6 = await reminders.runForTenant(tenantId, D6);
        expect(r6).toMatchObject({ fresh: 1, outstanding: 3 });
        const day6 = (await inApp(inv)).at(-1)!;
        expect(day6.body).toContain('เพิ่งเกินวันนี้ 1 ใบ');
        const mail6 = (await inbox(inv)).filter((x) => x.channel === 'email').at(-1)!;
        expect(JSON.stringify(mail6)).toContain(d3DoNo);
      } finally {
        await db.$executeRaw`UPDATE doc_status_history SET at = at - interval '5 days'
          WHERE doc_type = 'delivery_order' AND event = 'deliver' AND doc_id = ${d3.uuid}::uuid`;
      }

      // sandbox ไม่สร้าง job — ทดสอบใน "ตั้งเวลา" · tenant อื่นไม่มีใบค้าง → ไม่ส่ง
      expect((await reminders.runForTenant(otherId, D)).digests).toBe(0);

      // L5: แพ็กเกจไม่มีรายงาน + มีร่างค้าง → ข้อความหน้าวางบิลพูดถึงร่างด้วย
      const tb = renderNotification('delivery_order.unbilled', 'th', {
        target: 'bill',
        minDays: 7,
        fresh: 0,
        outstanding: 2,
        staleDrafts: 1,
        more: 0,
        items: [],
      });
      expect(tb.body).toContain('ออกเอกสารร่างที่ค้างที่หน้า วางบิลและใบแจ้งหนี้');
      const t = renderNotification('delivery_order.unbilled', 'th', {
        target: 'report',
        minDays: 7,
        fresh: 25,
        outstanding: 30,
        staleDrafts: 2,
        more: 5,
        items: [{ doNo: 'DO-1', customer: 'ลูกค้า ก', deliveredOn: '2026-11-03', days: 9 }],
      });
      expect(t.body).toContain(
        'เพิ่งเกินวันนี้ 25 ใบ · ค้างทั้งหมด 30 ใบ · อยู่ในร่างใบแจ้งหนี้ค้างเกิน 7 วัน 2 ใบ',
      );
      expect(t.detail).toContain('DO-1 · ลูกค้า ก — ส่งถึง 3 พฤศจิกายน 2569 (9 วัน)');
      expect(t.detail).toContain('และอีก 5 ใบ');
    });

    it('ตั้งเวลา: ก่อน 08:00 ไม่สร้าง job · หลัง 08:00 สร้าง 1 job/tenant/วัน เฉพาะ live (sandbox ไม่ส่ง)', async () => {
      const day = addDays(today, 30);
      expect(await reminders.scheduleDue(new Date(`${addDays(day, -1)}T23:59:00Z`))).toBe(0); // 06:59 ไทย
      const live = await reminders.scheduleDue(new Date(`${day}T01:05:00Z`));
      expect(live).toBeGreaterThanOrEqual(2);
      expect(await reminders.scheduleDue(new Date(`${day}T02:05:00Z`))).toBe(0);
      const jobs = await db.job.findMany({ where: { type: UNBILLED_REMINDER_JOB } });
      const tenants = await db.tenant.findMany({
        where: { id: { in: jobs.map((j) => j.tenantId) } },
        select: { mode: true },
      });
      expect(tenants.every((t) => t.mode === 'live')).toBe(true);
    });
  });
});
