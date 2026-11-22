import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { JobQueue } from '../src/jobs/job-queue.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { MAX_DOS_PER_INVOICE } from '../src/modules/invoices/billing-limits';
import { BillingQueueService } from '../src/modules/invoices/billing-queue.service';
import { BillingReleaseService } from '../src/modules/invoices/billing-release.service';
import { INVOICE_RUN_JOB, InvoiceRunService } from '../src/modules/invoices/invoice-run.service';
import { InvoicesService } from '../src/modules/invoices/invoices.service';
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

/**
 * ST5-T12 รอบวางบิล (async) — เกณฑ์ตรวจรับ: รันรอบของลูกค้ารายเดือน 3 ราย → ได้ 3 ร่าง; job รายงาน progress และจบ succeeded
 * + สั่งซ้ำไม่สร้างซ้ำ · ลูกค้าที่ล้มไม่ทำให้ลูกค้าอื่นล้ม · รอบอื่น/MANUAL ไม่เข้า · ยังไม่ส่งบัญชีไม่เข้า (เว้น releaseDeliveryOrders) ·
 * PER_DO 1 ร่างต่อ DO · ร่างใบวางบิลอัตโนมัติ · webhook job.completed · audit · สิทธิ์ · validation · แยก tenant
 */
describe('invoice runs (ST5-T12)', { timeout: 900_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherTenant: string;
  let companyId: string;
  let branchId: string;
  let admin: string;
  let drafter: string;
  let viewer: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const NONE_REQ = { success: { fields: [] } };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท รอบวางบิล' })).id;
    otherTenant = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิลรอบ จำกัด', taxId: validTaxId(1971) },
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
    drafter = await tokenFor(tenantId, 'invoices:read invoices:draft', 'u-run');
    viewer = await tokenFor(tenantId, 'invoices:read jobs:read', 'u-view');
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
          plate: `8${++seed % 10}-${String(5000 + seed)}`,
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
        name: `คนขับรอบ ${n}`,
        phone: `087-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
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

  const newCustomer = async (
    billingCycle: 'PER_DO' | 'WEEKLY' | 'MONTHLY' | 'MANUAL' = 'MONTHLY',
  ) => {
    const n = ++seed;
    const body = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้ารอบวางบิล ${n}`, taxId: validTaxId(19_900 + n) })
        .expect(201)
    ).body as { id: string };
    await db.customer.update({
      where: { id: uuid('customer', body.id) },
      data: { podRequirements: NONE_REQ, billingCycle },
    });
    return body.id;
  };

  /** ลูกค้า → rate card → SO → DO → เที่ยว → ส่งสำเร็จ (→ ส่งบัญชี) */
  const delivered = async (customer: string, releaseIt = true) => {
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
          overrideReason: 'ทดสอบรอบวางบิล',
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
    if (releaseIt)
      await api(app, admin).post(`/v1/delivery-orders/${doId}/release`).send({}).expect(200);
    return doId;
  };

  const startRun = async (body: object, token = drafter) => {
    const r = await api(app, token).post('/v1/invoice-runs').send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.statusUrl).toBe(`/v1/jobs/${r.body.jobId}`);
    return r.body.jobId as string;
  };
  const drain = async () => {
    const q = app.get(JobQueue);
    while (await q.runOnce());
  };
  const job = async (jobId: string, token = drafter) =>
    (await api(app, token).get(`/v1/jobs/${jobId}`).expect(200)).body as {
      status: string;
      progress: number;
      type: string;
      result: any;
    };
  const resultOf = (j: { result: any }, customer: string) =>
    (j.result.results as any[]).find((r) => r.customerId === customer);
  const monthly = { billingCycle: 'MONTHLY', periodFrom: yesterday, periodTo: today };

  /**
   * คัดลอก DO ที่ส่งถึง + ส่งบัญชีแล้ว (ใบสั่ง + DO + บรรทัดรายได้) n ชุดด้วย SQL — สร้าง DO หลายร้อยใบผ่าน API ช้าเกินใน test
   * (เที่ยว/จุดส่งใช้ของต้นแบบร่วมกัน — ความพร้อมวางบิลดูแค่เวลาถึง/ออกของจุดส่ง)
   */
  const cloneDelivered = async (doId: string, n: number): Promise<string[]> => {
    const src = await db.deliveryOrder.findUniqueOrThrow({
      where: { id: uuid('deliveryOrder', doId) },
    });
    const tag = ++seed;
    const sos = Array.from({ length: n }, () => randomUUID());
    const dos = Array.from({ length: n }, () => randomUUID());
    const nos = sos.map((_, i) => `${tag}-${String(i).padStart(4, '0')}`);
    const map = Prisma.sql`unnest(${sos}::uuid[], ${dos}::uuid[], ${nos}::text[]) AS m(so, d, no)`;
    await db.$executeRaw`
      INSERT INTO sales_order SELECT (jsonb_populate_record(NULL::sales_order, to_jsonb(s) ||
        jsonb_build_object('id', m.so, 'so_no', 'SO-CL-' || m.no, 'external_id', NULL))).*
        FROM sales_order s, ${map} WHERE s.id = ${src.salesOrderId}::uuid`;
    await db.$executeRaw`
      INSERT INTO delivery_order SELECT (jsonb_populate_record(NULL::delivery_order, to_jsonb(x) ||
        jsonb_build_object('id', m.d, 'do_no', 'DO-CL-' || m.no, 'sales_order_id', m.so))).*
        FROM delivery_order x, ${map} WHERE x.id = ${src.id}::uuid`;
    // บรรทัดสินค้า / บรรทัดราคาของใบสั่ง + บรรทัดของ DO (id ใหม่ = md5(ใบสั่งใหม่ + id เดิม) — อ้างกันได้) ให้ rebuild ของใบสั่งที่คัดลอก
    // เห็นแหล่งเดียวกับต้นแบบ (ถอด/ยกเลิกแล้วคิดบรรทัดรายได้ใหม่ได้ผลเท่าต้นแบบ)
    await db.$executeRaw`
      INSERT INTO sales_order_line SELECT (jsonb_populate_record(NULL::sales_order_line, to_jsonb(x) ||
        jsonb_build_object('id', md5(m.so::text || x.id::text)::uuid, 'sales_order_id', m.so))).*
        FROM sales_order_line x, ${map} WHERE x.sales_order_id = ${src.salesOrderId}::uuid`;
    await db.$executeRaw`
      INSERT INTO sales_order_charge SELECT (jsonb_populate_record(NULL::sales_order_charge, to_jsonb(x) ||
        jsonb_build_object('id', md5(m.so::text || x.id::text)::uuid, 'sales_order_id', m.so))).*
        FROM sales_order_charge x, ${map} WHERE x.sales_order_id = ${src.salesOrderId}::uuid`;
    await db.$executeRaw`
      INSERT INTO delivery_order_line SELECT (jsonb_populate_record(NULL::delivery_order_line, to_jsonb(x) ||
        jsonb_build_object('id', gen_random_uuid(), 'delivery_order_id', m.d,
          'sales_order_line_id', CASE WHEN x.sales_order_line_id IS NULL THEN NULL
                                      ELSE md5(m.so::text || x.sales_order_line_id::text)::uuid END))).*
        FROM delivery_order_line x, ${map} WHERE x.delivery_order_id = ${src.id}::uuid`;
    await db.$executeRaw`
      INSERT INTO revenue_line SELECT (jsonb_populate_record(NULL::revenue_line, to_jsonb(l) ||
        jsonb_build_object('id', gen_random_uuid(), 'sales_order_id', m.so, 'delivery_order_id', m.d,
          'source_id', CASE WHEN l.source_type = 'SO_CHARGE' AND l.source_id IS NOT NULL
                            THEN md5(m.so::text || l.source_id::text)::uuid ELSE l.source_id END))).*
        FROM revenue_line l, ${map} WHERE l.delivery_order_id = ${src.id}::uuid AND l.status = 'ACTIVE'`;
    // สถิติของ planner ตามข้อมูลที่เพิ่งเพิ่ม (ระบบจริง autovacuum ทำให้ — test เพิ่มทีเดียวหลายร้อยแถว)
    // (TMS_NO_ANALYZE=1 = ข้าม — ใช้ตรวจว่า query ความพร้อมทนสถิติที่ยังไม่ทัน)
    if (process.env.TMS_NO_ANALYZE !== '1')
      await db.$executeRawUnsafe('ANALYZE sales_order, delivery_order, revenue_line');
    return dos.map((id) => encodeId('deliveryOrder', id));
  };

  /** ตัวเลข perf: log + ต่อท้ายไฟล์ `TMS_PERF_LOG` (ถ้าตั้ง — vitest ซ่อน log ของ test ที่ผ่าน) */
  const perfLog = (msg: string) => {
    console.log(msg);
    if (process.env.TMS_PERF_LOG) appendFileSync(process.env.TMS_PERF_LOG, `${msg}\n`);
  };
  /** เวลาต่อคำสั่งของ `counted` ครั้งล่าสุด (วินิจฉัย perf) */
  const slow: [string, number][] = [];
  let inflight = '';
  /** นับจำนวนคำสั่งที่ส่งถึงฐานข้อมูลผ่าน transaction (ทุก `tx.<model>.<method>()` และ `tx.$queryRaw/$executeRaw`) */
  const counted = async <T>(fn: () => Promise<T>): Promise<{ out: T; queries: number }> => {
    let queries = 0;
    slow.length = 0;
    const timed = (name: string, call: () => unknown) => {
      const t = Date.now();
      inflight = name;
      const r = call();
      void Promise.resolve(r).then(
        () => slow.push([name, Date.now() - t]),
        () => undefined,
      );
      return r;
    };
    const out = await app.get(DbService).withTenant(
      tenantId,
      (tx) => {
        const proxy = new Proxy(tx as object, {
          get(t, k) {
            const v = (t as Record<string | symbol, unknown>)[k];
            if (typeof k !== 'string') return v;
            if (typeof v === 'function')
              return (...a: unknown[]) => {
                if (!k.startsWith('$')) return (v as (...x: unknown[]) => unknown).apply(t, a);
                queries++;
                return timed(k, () => (v as (...x: unknown[]) => unknown).apply(t, a));
              };
            if (v && typeof v === 'object')
              return new Proxy(v, {
                get(m, f) {
                  const fn2 = (m as Record<string | symbol, unknown>)[f];
                  return typeof fn2 === 'function'
                    ? (...a: unknown[]) => {
                        queries++;
                        return timed(`${k}.${String(f)}`, () =>
                          (fn2 as (...x: unknown[]) => unknown).apply(m, a),
                        );
                      }
                    : fn2;
                },
              });
            return v;
          },
        }) as Tx;
        return requestContext.run(
          {
            requestId: randomUUID(),
            tenantId,
            actorId: 'user-test',
            locale: 'th',
            scopes: ['*'],
            tx: proxy,
          },
          fn,
        );
      },
      120_000,
    );
    return { out, queries };
  };

  it('เกณฑ์ตรวจรับ: ลูกค้ารายเดือน 3 ราย → 3 ร่าง · job progress → succeeded · ลิงก์ร่าง · job.completed · รอบอื่น/MANUAL ไม่เข้า', async () => {
    const cs = [await newCustomer(), await newCustomer(), await newCustomer()];
    const dos = [await delivered(cs[0]!), await delivered(cs[1]!), await delivered(cs[1]!)];
    dos.push(await delivered(cs[2]!));
    const weekly = await newCustomer('WEEKLY');
    const weeklyDo = await delivered(weekly);
    const manual = await newCustomer('MANUAL');
    const manualDo = await delivered(manual);

    const jobId = await startRun(monthly);
    const pending = await job(jobId);
    expect(pending).toMatchObject({ type: INVOICE_RUN_JOB, status: 'pending', progress: 0 });
    await drain();
    const j = await job(jobId);
    expect(j.status).toBe('succeeded');
    expect(j.progress).toBe(100);
    expect(j.result).toMatchObject({
      billingCycle: 'MONTHLY',
      periodFrom: yesterday,
      periodTo: today,
      customers: 3,
      invoicesCreated: 3,
      billingNotesCreated: 0,
      failed: 0,
    });
    for (const [i, c] of cs.entries()) {
      const r = resultOf(j, c);
      expect(r, c).toMatchObject({
        outcome: 'SUCCEEDED',
        problem: null,
        skippedDeliveryOrders: [],
        skippedCount: 0,
        failedGroups: 0,
        invoiceCount: 1,
        invoicesListUrl: `/v1/invoices?customerId=${c}&status=DRAFT`,
      });
      expect(r.invoices).toHaveLength(1);
      expect(r.invoices[0].url).toBe(`/v1/invoices/${r.invoices[0].id}`);
      expect(r.invoices[0].deliveryOrderCount).toBe(i === 1 ? 2 : 1);
      // ไม่มียอดเงินในผลของ job (ผู้อ่าน job อาจไม่มีสิทธิ์ราคา)
      expect(JSON.stringify(r)).not.toMatch(/sell|total|amount/i);
      const inv = (await api(app, admin).get(r.invoices[0].url).expect(200)).body;
      expect(inv).toMatchObject({
        status: 'DRAFT',
        invoiceNo: null,
        periodFrom: yesterday,
        periodTo: today,
      });
      expect(inv.customer.id).toBe(c);
      // review M1: ผู้สั่งรอบ = ผู้สร้างร่าง (นับเป็นผู้เตรียมในกฎแบ่งหน้าที่ของ finalize)
      const row = await db.invoice.findUniqueOrThrow({ where: { id: uuid('invoice', inv.id) } });
      expect(row.createdBy).toBe('u-run');
    }
    // รอบอื่น / MANUAL ไม่ถูกแตะ
    expect(resultOf(j, weekly)).toBeUndefined();
    expect(resultOf(j, manual)).toBeUndefined();
    for (const d of [weeklyDo, manualDo]) {
      const x = (await api(app, admin).get(`/v1/delivery-orders/${d}`).expect(200)).body;
      expect(x.billingStatus).toBe('UNBILLED');
    }
    // webhook job.completed (data.object = JobDto) + audit ของร่าง/การสั่งรอบลงชื่อผู้สั่ง
    const ev = await db.domainEvent.findFirst({
      where: { type: 'job.completed', localId: uuid('job', jobId) },
    });
    expect(ev?.snapshot).toMatchObject({ id: jobId, status: 'succeeded', type: INVOICE_RUN_JOB });
    const audits = await db.auditLog.findMany({
      where: { tenantId, action: { in: ['invoice.draft_created', 'invoice_run.requested'] } },
    });
    expect(audits.filter((a) => a.action === 'invoice.draft_created')).toHaveLength(3);
    expect(audits.every((a) => a.actorId === 'u-run')).toBe(true);
    const req = audits.find((a) => a.action === 'invoice_run.requested');
    expect(req?.entityId).toBe(uuid('job', jobId));

    // ---- สั่งรอบเดิมซ้ำ → ไม่สร้างซ้ำ
    const again = await startRun(monthly);
    await drain();
    const j2 = await job(again);
    expect(j2.status).toBe('succeeded');
    expect(j2.result).toMatchObject({ customers: 0, invoicesCreated: 0, failed: 0 });
    expect(await db.invoice.count({ where: { tenantId } })).toBe(3);

    // ---- รอบรายสัปดาห์ แยกจากรายเดือน
    const wk = await startRun({ ...monthly, billingCycle: 'WEEKLY' });
    await drain();
    const jw = await job(wk);
    expect(jw.result).toMatchObject({ customers: 1, invoicesCreated: 1 });
    expect(resultOf(jw, weekly).outcome).toBe('SUCCEEDED');
  });

  it('ลูกค้าที่ล้มไม่ทำให้ลูกค้าอื่นล้ม → succeeded_with_errors + FAILED + problem ต่อลูกค้า (กลุ่มที่ล้มย้อนทั้งกลุ่ม)', async () => {
    const ok = await newCustomer();
    const okDo = await delivered(ok);
    const broken = await newCustomer();
    const brokenDo = await delivered(broken);
    // บริษัทวางบิลตั้งต้นที่ไม่มีสาขาผู้ออก → สร้างร่างไม่ได้ (422 issuer_missing) เฉพาะลูกค้ารายนี้
    const noBranch = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ไม่มีสาขา จำกัด', taxId: validTaxId(1972) },
    });
    await db.customer.update({
      where: { id: uuid('customer', broken) },
      data: { defaultBillingCompanyId: noBranch.id },
    });
    const jobId = await startRun(monthly);
    await drain();
    const j = await job(jobId);
    expect(j.status).toBe('succeeded_with_errors');
    expect(j.progress).toBe(100);
    expect(j.result).toMatchObject({ customers: 2, invoicesCreated: 1, failed: 1 });
    expect(resultOf(j, ok)).toMatchObject({ outcome: 'SUCCEEDED', problem: null });
    const bad = resultOf(j, broken);
    expect(bad).toMatchObject({
      outcome: 'FAILED',
      invoices: [],
      invoiceCount: 0,
      failedGroups: 1,
    });
    expect(bad.problem).toMatchObject({ status: 422, code: 'validation_failed' });
    expect(bad.problem.errors[0].code).toBe('issuer_missing');
    expect(
      (await api(app, admin).get(`/v1/delivery-orders/${brokenDo}`).expect(200)).body.billingStatus,
    ).toBe('UNBILLED');
    expect(
      (await api(app, admin).get(`/v1/delivery-orders/${okDo}`).expect(200)).body.billingStatus,
    ).not.toBe('UNBILLED');
    // แก้แล้วสั่งใหม่ → เฉพาะลูกค้าที่ค้าง
    await db.customer.update({
      where: { id: uuid('customer', broken) },
      data: { defaultBillingCompanyId: null },
    });
    // บริษัทที่ 2 ทำให้การเลือกบริษัทของใบสั่งใหม่กำกวม — ลบออก (test ถัดไปสร้างใบสั่ง)
    await db.company.delete({ where: { id: noBranch.id } });
    const retry = await startRun(monthly);
    await drain();
    const j2 = await job(retry);
    expect(j2.status).toBe('succeeded');
    expect(j2.result).toMatchObject({ customers: 1, invoicesCreated: 1 });
    expect(resultOf(j2, broken).outcome).toBe('SUCCEEDED');
  });

  it('DO ยังไม่ส่งบัญชีไม่เข้า · releaseDeliveryOrders=true ส่งบัญชีพร้อมสร้างร่าง · นอกงวดไม่เข้า', async () => {
    const c = await newCustomer();
    const d = await delivered(c, false);
    const a = await startRun(monthly);
    await drain();
    expect(resultOf(await job(a), c)).toBeUndefined();
    // งวดที่ไม่ครอบวันที่ DO
    const past = await startRun({
      billingCycle: 'MONTHLY',
      periodFrom: '2020-01-01',
      periodTo: '2020-01-31',
      releaseDeliveryOrders: true,
    });
    await drain();
    expect((await job(past)).result).toMatchObject({ customers: 0, invoicesCreated: 0 });
    const b = await startRun({ ...monthly, releaseDeliveryOrders: true });
    await drain();
    const r = resultOf(await job(b), c);
    expect(r).toMatchObject({ outcome: 'SUCCEEDED' });
    const x = (await api(app, admin).get(`/v1/delivery-orders/${d}`).expect(200)).body;
    expect(x.releasedAt).toBeTruthy();
    expect(x.billingStatus).not.toBe('UNBILLED');
  });

  it('PER_DO = 1 ร่างต่อ DO (งวด = วันที่ DO)', async () => {
    const c = await newCustomer('PER_DO');
    await delivered(c);
    await delivered(c);
    const id = await startRun({ ...monthly, billingCycle: 'PER_DO' });
    await drain();
    const j = await job(id);
    expect(j.result).toMatchObject({ customers: 1, invoicesCreated: 2 });
    const r = resultOf(j, c);
    expect(r.invoices.map((i: { deliveryOrderCount: number }) => i.deliveryOrderCount)).toEqual([
      1, 1,
    ]);
  });

  it('ร่างใบวางบิลอัตโนมัติ: ใบที่ออกแล้วค้าง (แยกผู้ออก/สาขา) → ร่างใบวางบิล · สั่งซ้ำไม่สร้างซ้ำ · billingNotes=false ไม่สร้าง', async () => {
    const c = await newCustomer();
    const cid = uuid('customer', c);
    const branch2 = await db.branch.create({
      data: { tenantId, companyId, branchCode: '00009', branchLabel: 'สาขา 9', address: ADDR },
    });
    const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
    const back = (n: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    /** `period` = งวดของใบ (ค่าเริ่มต้น = งวดของรอบ) · null = ใบไม่มีงวด (ใช้ `issueDate`) */
    const mk = (
      no: string,
      o: {
        branch?: string;
        status?: 'ISSUED' | 'PAID';
        period?: [string, string] | null;
        issueDate?: string;
      } = {},
    ) => {
      const period: [string, string] | null =
        o.period === undefined ? [yesterday, today] : o.period;
      return db.invoice.create({
        data: {
          tenantId,
          customerId: cid,
          issuingCompanyId: companyId,
          issuingBranchId: o.branch ?? branchId,
          status: o.status ?? 'ISSUED',
          totalAmount: new Prisma.Decimal('1000.00'),
          subtotalExempt: new Prisma.Decimal('1000.00'),
          netExpectedAmount: new Prisma.Decimal('1000.00'),
          ...(o.status === 'PAID' ? { paidAmount: new Prisma.Decimal('1000.00') } : {}),
          ...issuedTestFields(no),
          // ค่าเริ่มต้น: วันที่ออกอยู่นอกงวดของรอบ (ใบของงวดนี้ออกเลขหลังสิ้นงวดได้ — เลือกด้วยงวดของใบ ไม่ใช่วันที่ออก)
          issueDate: d(o.issueDate ?? back(5)),
          ...(period ? { periodFrom: d(period[0]), periodTo: d(period[1]) } : {}),
        },
      });
    };
    await mk('INV-T12-0001');
    await mk('INV-T12-0002');
    await mk('INV-T12-0003', { branch: branch2.id });
    await mk('INV-T12-0004', { status: 'PAID' });
    // PO 22 พ.ย. 2569: เฉพาะใบของงวดของรอบ — งวดก่อนหน้า / งวดคร่อมออกนอกรอบ / ไม่มีงวด + วันที่ออกนอกงวด ไม่เข้า
    const older = await mk('INV-T12-0005', { period: [back(40), back(35)] });
    const straddle = await mk('INV-T12-0006', { period: [back(2), today] });
    const noPeriodIn = await mk('INV-T12-0007', { period: null, issueDate: today });
    const noPeriodOut = await mk('INV-T12-0008', { period: null, issueDate: back(40) });
    const off = await startRun({ ...monthly, billingNotes: false });
    await drain();
    expect(resultOf(await job(off), c)).toBeUndefined();
    const id = await startRun(monthly);
    await drain();
    const j = await job(id);
    expect(j.status).toBe('succeeded');
    const r = resultOf(j, c);
    expect(r).toMatchObject({ outcome: 'SUCCEEDED', invoices: [] });
    expect(r.billingNotes.map((b: { invoiceCount: number }) => b.invoiceCount).sort()).toEqual([
      1, 3,
    ]);
    for (const b of r.billingNotes) {
      expect(b.url).toBe(`/v1/billing-notes/${b.id}`);
      const bn = (await api(app, admin).get(b.url).expect(200)).body;
      expect(bn).toMatchObject({ status: 'DRAFT', billingNoteNo: null });
    }
    const linked = async (invoiceId: string) =>
      db.billingNoteInvoice.count({ where: { invoiceId, active: true } });
    expect(await linked(noPeriodIn.id)).toBe(1);
    for (const x of [older, straddle, noPeriodOut])
      expect(await linked(x.id), x.invoiceNo!).toBe(0);
    const again = await startRun(monthly);
    await drain();
    expect(resultOf(await job(again), c)).toBeUndefined();
    // รอบที่งวดครอบ → ใบที่เหลือเข้าร่างใบวางบิลของรอบนั้น (ไม่หาย — แค่ไม่อยู่ในงวดของรอบแรก)
    const wide = await startRun({ ...monthly, periodFrom: back(45) });
    await drain();
    const rw = resultOf(await job(wide), c);
    expect(rw.billingNotes.map((b: { invoiceCount: number }) => b.invoiceCount)).toEqual([3]);
    await park(c);
  });

  it('สิทธิ์ · validation · ผู้สั่งดู job ได้ · แยก tenant', async () => {
    await api(app, viewer).post('/v1/invoice-runs').send(monthly).expect(403);
    const bad = await api(app, drafter)
      .post('/v1/invoice-runs')
      .send({ billingCycle: 'MANUAL', periodFrom: today, periodTo: yesterday });
    expect(bad.status).toBe(422);
    const bad2 = await api(app, drafter)
      .post('/v1/invoice-runs')
      .send({ billingCycle: 'MONTHLY', periodFrom: today, periodTo: yesterday });
    expect(bad2.status).toBe(422);
    expect(bad2.body.errors[0]).toMatchObject({ field: 'periodTo', code: 'before_period_from' });
    const bad3 = await api(app, drafter)
      .post('/v1/invoice-runs')
      .send({ billingCycle: 'MONTHLY', periodFrom: '2026-02-30', periodTo: today });
    expect(bad3.status).toBe(422);
    // ลูกค้าพร้อมวางบิลของบริษัท A — รอบของบริษัทอื่นไม่เห็น/ไม่แตะ
    const c = await newCustomer();
    const d = await delivered(c);
    const other = await tokenFor(otherTenant, '*', 'u-other');
    const ojob = await startRun(monthly, other);
    await drain();
    const oj = await job(ojob, other);
    expect(oj.result).toMatchObject({ customers: 0, invoicesCreated: 0 });
    await api(app, other).get(`/v1/jobs/${ojob}`).expect(200);
    const mine = await startRun(monthly);
    await api(app, other).get(`/v1/jobs/${mine}`).expect(404);
    await drain();
    expect(resultOf(await job(mine), c)).toMatchObject({ outcome: 'SUCCEEDED' });
    expect(
      (await api(app, admin).get(`/v1/delivery-orders/${d}`).expect(200)).body.billingStatus,
    ).not.toBe('UNBILLED');
  });
  /** ปิดรอบของลูกค้า (DO ที่ค้างในคิวไม่ไปโผล่ใน test ถัดไป) */
  const park = (c: string) =>
    db.customer.update({ where: { id: uuid('customer', c) }, data: { billingCycle: 'MANUAL' } });

  it('review M1: ร่างจากรอบ = ผู้สั่งเป็นผู้เตรียม — ผู้สั่งออกเองไม่ได้ (invoice_self_finalize) · ผู้ใช้อื่นออกได้', async () => {
    await db.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: 'billing.allowSelfFinalize' } },
      create: { tenantId, key: 'billing.allowSelfFinalize', value: false },
      update: { value: false },
    });
    const c = await newCustomer();
    await db.customer.update({
      where: { id: uuid('customer', c) },
      data: { branchCode: '00000', billingAddress: ADDR },
    });
    await delivered(c);
    const runner = await tokenFor(
      tenantId,
      'invoices:read invoices:draft invoices:finalize prices.sell:read',
      'u-run',
    );
    const id = await startRun(monthly, runner);
    await drain();
    const r = resultOf(await job(id, runner), c);
    const inv = (await api(app, admin).get(r.invoices[0].url).expect(200)).body;
    const self = await api(app, runner)
      .post(`/v1/invoices/${inv.id}/finalize`)
      .set('If-Match', `"${inv.version}"`);
    expect(self.status, JSON.stringify(self.body)).toBe(403);
    expect(self.body.code).toBe('invoice_self_finalize');
    const other = await tokenFor(
      tenantId,
      'invoices:read invoices:finalize prices.sell:read',
      'u-fin',
    );
    const ok = await api(app, other)
      .post(`/v1/invoices/${inv.id}/finalize`)
      .set('If-Match', `"${inv.version}"`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('ISSUED');
    await park(c);
  });

  it('DO ที่ไม่ผ่านตอนดึง (หลักฐานไม่ครบตาม checklist ปัจจุบัน) → skippedDeliveryOrders ไม่เงียบ · DO ไม่เปลี่ยน', async () => {
    const c = await newCustomer();
    const d = await delivered(c);
    // checklist เข้มขึ้นหลัง DO ผ่าน — คิวยังเห็น (สถานะที่เก็บ) แต่ตรวจซ้ำตอนดึงไม่ผ่าน
    await db.customer.update({
      where: { id: uuid('customer', c) },
      data: { podRequirements: { success: { fields: [{ type: 'NOTE', level: 'REQUIRED' }] } } },
    });
    const id = await startRun(monthly);
    await drain();
    const j = await job(id);
    expect(j.status).toBe('succeeded');
    const r = resultOf(j, c);
    expect(r).toMatchObject({ outcome: 'NOTHING_TO_BILL', invoiceCount: 0, skippedCount: 1 });
    expect(r.skippedDeliveryOrders[0]).toMatchObject({ deliveryOrderId: d });
    expect(r.skippedDeliveryOrders[0].reasons).toContain('POD_INCOMPLETE');
    expect(
      (await api(app, admin).get(`/v1/delivery-orders/${d}`).expect(200)).body.billingStatus,
    ).toBe('UNBILLED');
    await park(c);
  });

  it('แข่งกับการสร้างร่างมือ: DO ที่ถูกดึงไปแล้ว (do_already_drafted) → ข้าม DO นั้น แล้วสร้างร่างจาก DO ที่เหลือ', async () => {
    const c = await newCustomer();
    const d1 = await delivered(c);
    const d2 = await delivered(c);
    await api(app, admin)
      .post('/v1/invoices')
      .send({ customerId: c, deliveryOrderIds: [d1] })
      .expect(201);
    // จำลองคิวที่อ่านก่อนร่างมือ commit: คิวยังคืน d1
    const q = app.get(BillingQueueService);
    const orig = q.readyForRun.bind(q);
    const spy = vi.spyOn(q, 'readyForRun').mockImplementation(async (tx, f) => {
      const rows = await orig(tx, f);
      if (!f.customerId || f.customerId === uuid('customer', c))
        rows.unshift({ id: uuid('deliveryOrder', d1), customer_id: uuid('customer', c) });
      return rows;
    });
    try {
      const id = await startRun(monthly);
      await drain();
      const r = resultOf(await job(id), c);
      expect(r).toMatchObject({ outcome: 'SUCCEEDED', invoiceCount: 1, skippedCount: 1 });
      expect(r.invoices[0].deliveryOrderCount).toBe(1);
      expect(r.skippedDeliveryOrders[0]).toMatchObject({
        deliveryOrderId: d1,
        reasons: ['IN_INVOICE'],
      });
      expect(
        (await api(app, admin).get(`/v1/delivery-orders/${d2}`).expect(200)).body.billingStatus,
      ).not.toBe('UNBILLED');
    } finally {
      spy.mockRestore();
    }
    await park(c);
  });

  it('แบ่งร่างเกินเพดาน + กลุ่มหนึ่งล้ม → PARTIAL · กลุ่มที่ล้มไม่มีร่าง ไม่มี DO ส่งบัญชีค้าง', async () => {
    const svc = app.get(InvoiceRunService);
    const c = await newCustomer();
    const dos = [await delivered(c, false), await delivered(c, false), await delivered(c, false)];
    svc.groupSize = 2; // แทนเพดาน MAX_DOS_PER_INVOICE
    const inv = app.get(InvoicesService);
    const orig = inv.create.bind(inv);
    let n = 0;
    const spy = vi.spyOn(inv, 'create').mockImplementation(async (...a) => {
      if (++n === 2) throw new Error('boom: กลุ่มที่สอง');
      return orig(...a);
    });
    try {
      const id = await startRun({ ...monthly, releaseDeliveryOrders: true });
      await drain();
      const j = await job(id);
      expect(j.status).toBe('succeeded_with_errors');
      expect(j.progress).toBe(100);
      const r = resultOf(j, c);
      expect(r).toMatchObject({
        outcome: 'PARTIAL',
        invoiceCount: 1,
        failedGroups: 1,
        // เกินเพดาน DO ต่อใบ → แบ่งหลายร่าง + รายงาน (ปกติ 1 ร่างต่อลูกค้าต่อรอบ)
        splitByCap: true,
      });
      expect(j.result.maxDeliveryOrdersPerInvoice).toBe(2);
      expect(r.invoices[0].deliveryOrderCount).toBe(2);
      expect(r.problem).toMatchObject({ code: 'internal_error' });
      const states = await Promise.all(
        dos.map(
          async (d) => (await api(app, admin).get(`/v1/delivery-orders/${d}`).expect(200)).body,
        ),
      );
      const billed = states.filter((x) => x.billingStatus !== 'UNBILLED');
      const left = states.filter((x) => x.billingStatus === 'UNBILLED');
      expect(billed).toHaveLength(2);
      expect(billed.every((x) => x.releasedAt)).toBe(true);
      expect(left).toHaveLength(1);
      expect(left[0].releasedAt).toBeNull(); // ส่งบัญชีย้อนพร้อมกลุ่มที่ล้ม
    } finally {
      spy.mockRestore();
      svc.groupSize = MAX_DOS_PER_INVOICE;
    }
    await park(c);
  });

  it('ถูกถอดสิทธิ์ระหว่างรอคิว (ผู้ใช้จริง) → งานล้ม permission_denied ไม่สร้างร่าง', async () => {
    const roles = await ensureSystemRoles(db, tenantId);
    const u = await db.appUser.create({
      data: { tenantId, email: 'demote@run.test', name: 'demote', status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles.admin! } });
    const c = await newCustomer();
    const d = await delivered(c);
    const t = await tokenFor(tenantId, 'invoices:read invoices:draft', u.id);
    const id = await startRun(monthly, t);
    const jid = uuid('job', id);
    const row = await db.job.findUniqueOrThrow({ where: { id: jid } });
    const pl = row.payload as { actor: object };
    // token dev ใช้ scope ตอนสั่ง — จำลอง principal ผู้ใช้จริง (แบบ exports.test)
    await db.job.update({
      where: { id: jid },
      data: { payload: { ...pl, actor: { ...pl.actor, principalType: 'user' } } },
    });
    await db.userRole.deleteMany({ where: { userId: u.id } });
    await drain();
    const st = (await api(app, t).get(`/v1/jobs/${id}`).expect(200)).body;
    expect(st.status).toBe('failed');
    expect(JSON.stringify(st.error)).toMatch(/permission_denied/);
    expect(
      (await api(app, admin).get(`/v1/delivery-orders/${d}`).expect(200)).body.billingStatus,
    ).toBe('UNBILLED');
    await park(c);
  });

  it('API key: สั่งรอบด้วย key → 202 → job succeeded (อ่านสถานะด้วย key) · ร่างลงชื่อผู้สั่ง', async () => {
    const u = await db.appUser.create({
      data: { tenantId, email: 'keyowner@run.test', name: 'เจ้าของ key', status: 'ACTIVE' },
    });
    const sa = await tokenFor(tenantId, '*', u.id);
    const k = await api(app, sa)
      .post('/v1/api-keys')
      .send({ name: 'ERP รอบวางบิล', scopes: ['invoices:read', 'invoices:draft', 'jobs:read'] });
    expect(k.status, JSON.stringify(k.body)).toBe(201);
    const c = await newCustomer();
    await delivered(c);
    const id = await startRun(monthly, k.body.secret as string);
    await drain();
    const j = await job(id, k.body.secret as string);
    expect(j.status).toBe('succeeded');
    const r = resultOf(j, c);
    expect(r).toMatchObject({ outcome: 'SUCCEEDED', invoiceCount: 1 });
    const row = await db.invoice.findUniqueOrThrow({
      where: { id: uuid('invoice', r.invoices[0].id) },
    });
    expect(row.createdBy).toBeTruthy();
    expect(row.createdBy).not.toMatch(/^system:/);
    await park(c);
  });

  // ---------- ST5-T12b (PO 22 พ.ย. 2569) ----------

  it('perf: ดึง DO เข้าร่าง — จำนวนคำสั่งฐานข้อมูลไม่ขึ้นกับจำนวน DO (ไม่มี N+1)', async () => {
    const c = await newCustomer('MANUAL');
    const tpl = await delivered(c);
    const small = await cloneDelivered(tpl, 20);
    const big = await cloneDelivered(tpl, 200);
    const inv = app.get(InvoicesService);
    const a = await counted(() => inv.create({ customerId: c, deliveryOrderIds: small }));
    const t0 = Date.now();
    const b = await counted(() => inv.create({ customerId: c, deliveryOrderIds: big }));
    perfLog(
      `[perf] draft create: 20 DO = ${a.queries} queries · 200 DO = ${b.queries} queries (${Date.now() - t0} ms)`,
    );
    if (process.env.TMS_PERF === '1') {
      const huge = await cloneDelivered(tpl, 1000);
      const t1 = Date.now();
      const h = await counted(() => inv.create({ customerId: c, deliveryOrderIds: huge })).catch(
        (e: unknown) => {
          perfLog(
            `[perf] 1,000 DO FAILED after ${Date.now() - t1} ms: ${String(e).slice(0, 200)} · in flight: ${inflight} · done: ${JSON.stringify(slow)}`,
          );
          throw e;
        },
      );
      perfLog(
        `[perf] draft create: 1,000 DO = ${h.queries} queries (${Date.now() - t1} ms) · slowest: ${JSON.stringify(
          [...slow].sort((x, y) => y[1] - x[1]).slice(0, 8),
        )}`,
      );
    }
    expect(a.out.deliveryOrders).toHaveLength(20);
    expect(b.out.deliveryOrders).toHaveLength(200);
    expect(b.queries).toBe(a.queries);
    expect(b.queries).toBeLessThan(60);
  });

  it('คำถาม #71: ลูกค้า 446 DO ในงวด → ใบแจ้งหนี้ร่างเดียว (ไม่แบ่ง 3 ใบ) · สั่งซ้ำไม่สร้างซ้ำ', async () => {
    const c = await newCustomer();
    const tpl = await delivered(c);
    const dos = [tpl, ...(await cloneDelivered(tpl, 445))];
    const t0 = Date.now();
    const id = await startRun(monthly);
    await drain();
    const ms = Date.now() - t0;
    const j = await job(id);
    expect(j.status, JSON.stringify(j.result)).toBe('succeeded');
    expect(j.result.maxDeliveryOrdersPerInvoice).toBe(MAX_DOS_PER_INVOICE);
    const r = resultOf(j, c);
    expect(r).toMatchObject({
      outcome: 'SUCCEEDED',
      invoiceCount: 1,
      splitByCap: false,
      skippedCount: 0,
      failedGroups: 0,
    });
    expect(r.invoices).toHaveLength(1);
    expect(r.invoices[0].deliveryOrderCount).toBe(446);
    const inv = (await api(app, admin).get(r.invoices[0].url).expect(200)).body;
    expect(inv.deliveryOrders).toHaveLength(446);
    expect(new Set(inv.deliveryOrders.map((d: { id: string }) => d.id))).toEqual(new Set(dos));
    // ยอดรวม = 446 × ยอดของ DO ต้นแบบ (Decimal — ไม่มี DO ตกหล่น/ซ้ำ)
    const one = await db.revenueLine.aggregate({
      where: { deliveryOrderId: uuid('deliveryOrder', tpl), status: 'ACTIVE' },
      _sum: { amount: true },
    });
    const head = await db.invoice.findUniqueOrThrow({ where: { id: uuid('invoice', inv.id) } });
    expect(
      head.subtotalExempt.add(head.subtotalVatable).add(head.subtotalZeroRated).toFixed(2),
    ).toBe(one._sum.amount!.mul(446).toFixed(2));
    // ทุก DO: IN_DRAFT + ประวัติ billing 1 แถว (draft) ลงชื่อผู้สั่ง
    const rows = await db.deliveryOrder.groupBy({
      by: ['billingStatus'],
      where: { customerId: uuid('customer', c) },
      _count: true,
    });
    expect(rows).toEqual([{ billingStatus: 'IN_DRAFT', _count: 446 }]);
    const hist = await db.docStatusHistory.findMany({
      where: {
        docId: { in: dos.map((d) => uuid('deliveryOrder', d)) },
        event: 'draft',
        toStatus: 'IN_DRAFT',
      },
    });
    expect(hist).toHaveLength(446);
    expect(new Set(hist.map((h) => h.docId)).size).toBe(446);
    expect(
      hist.every(
        (h) =>
          h.fromStatus === 'UNBILLED' && h.actorId === 'u-run' && h.note === `invoice:${head.id}`,
      ),
    ).toBe(true);
    perfLog(`[perf] invoice run: 1 customer × 446 DO → 1 draft in ${ms} ms`);
    const again = await startRun(monthly);
    await drain();
    expect(resultOf(await job(again), c)).toBeUndefined();
    await park(c);
  });

  it('เพดานเดียวกันกับสร้างมือ: POST /invoices > เพดาน = 422 · ร่าง + ออกเอกสาร 500 DO (NFR docs/04) · TMS_PERF=1: ร่างเต็มเพดาน 1,000 DO + PDF', async () => {
    const c = await newCustomer('MANUAL');
    await db.customer.update({
      where: { id: uuid('customer', c) },
      data: { branchCode: '00000', billingAddress: ADDR },
    });
    const tpl = await delivered(c);
    const over = await api(app, admin)
      .post('/v1/invoices')
      .send({
        customerId: c,
        deliveryOrderIds: Array.from({ length: MAX_DOS_PER_INVOICE + 1 }, () =>
          encodeId('deliveryOrder', randomUUID()),
        ),
      });
    expect(over.status).toBe(422);
    expect(JSON.stringify(over.body.errors)).toMatch(/deliveryOrderIds/);
    // เต็มเพดาน 1,000 DO ผ่าน API + PDF pro forma — หนัก: รันเมื่อ TMS_PERF=1 (เครื่องว่าง) · ชุดปกติใช้ 500 DO ด้านล่าง
    let t0 = Date.now();
    let createMs = 0;
    let proformaMs = 0;
    if (process.env.TMS_PERF === '1') {
      const many = await cloneDelivered(tpl, MAX_DOS_PER_INVOICE);
      t0 = Date.now();
      const big = await api(app, admin)
        .post('/v1/invoices')
        .send({ customerId: c, deliveryOrderIds: many });
      createMs = Date.now() - t0;
      if (big.status !== 201) {
        // วินิจฉัย: ทำซ้ำผ่าน service ตรง ๆ เพื่อดูคำสั่งที่ช้า
        const t1 = Date.now();
        await counted(() =>
          app.get(InvoicesService).create({ customerId: c, deliveryOrderIds: many }),
        ).then(
          (x) =>
            perfLog(
              `[diag] HTTP ${big.status} after ${createMs} ms · direct ok ${Date.now() - t1} ms ${x.queries} q · ${JSON.stringify([...slow].sort((u, v) => v[1] - u[1]).slice(0, 8))}`,
            ),
          (e: unknown) =>
            perfLog(
              `[diag] HTTP ${big.status} after ${createMs} ms · direct FAILED ${Date.now() - t1} ms ${String(e).slice(0, 200)} · in flight ${inflight} · ${JSON.stringify(slow)}`,
            ),
        );
      }
      expect(big.status, JSON.stringify(big.body).slice(0, 500)).toBe(201);
      expect(big.body.deliveryOrders).toHaveLength(MAX_DOS_PER_INVOICE);
      t0 = Date.now();
      const pf = await api(app, admin).get(`/v1/invoices/${big.body.id}/proforma`);
      proformaMs = Date.now() - t0;
      expect(pf.status, JSON.stringify(pf.body).slice(0, 300)).toBe(200);
      // ร่างเต็มเพดานแล้ว เพิ่มอีก 1 ใบ = 422 too_many (เพดานรวมต่อใบ ไม่ใช่ต่อคำขอ)
      const add = await api(app, admin)
        .post(`/v1/invoices/${big.body.id}/delivery-orders`)
        .set('If-Match', `"${big.body.version}"`)
        .send({ deliveryOrderIds: [tpl] });
      expect(add.status, JSON.stringify(add.body)).toBe(422);
      expect(add.body.errors[0]).toMatchObject({ field: 'deliveryOrderIds', code: 'too_many' });
    }
    // ออกเอกสารใบ 500 DO
    const half = await cloneDelivered(tpl, 500);
    t0 = Date.now();
    const draft = await api(app, admin)
      .post('/v1/invoices')
      .send({ customerId: c, deliveryOrderIds: half });
    const create500Ms = Date.now() - t0;
    expect(draft.status, JSON.stringify(draft.body).slice(0, 500)).toBe(201);
    expect(draft.body.deliveryOrders).toHaveLength(500);
    const fin = await tokenFor(tenantId, '*', 'u-fin-500');
    t0 = Date.now();
    const ok = await api(app, fin)
      .post(`/v1/invoices/${draft.body.id}/finalize`)
      .set('If-Match', `"${draft.body.version}"`);
    const finalizeMs = Date.now() - t0;
    expect(ok.status, JSON.stringify(ok.body).slice(0, 500)).toBe(200);
    expect(ok.body.status).toBe('ISSUED');
    expect(ok.body.deliveryOrders).toHaveLength(500);
    perfLog(
      `[perf] POST /invoices 500 DO = ${create500Ms} ms · 1,000 DO = ${createMs} ms · pro forma PDF 1,000 DO = ${proformaMs} ms · finalize 500 DO (รวม PDF ต้นฉบับ) = ${finalizeMs} ms · pdf=${JSON.stringify(ok.body.pdf)}`,
    );
    // เครื่อง test ใช้ร่วมกับงานอื่น — ไม่ยืนยันเวลา (ตอบ 201/200 = ไม่ชน timeout 15 วิ ของ transaction); ตัวเลขจริงดูใน log
    expect(ok.body.pdf).toBeTruthy();
  });

  it('ตรวจความพร้อมแบบชุด (checkMany) = ตรวจทีละใบ (check) ทุก DO — พร้อม/ระงับ/ยังไม่ส่งบัญชี/หลักฐานไม่ครบ/ไม่มีรายได้/อยู่ในร่าง', async () => {
    const c = await newCustomer('MANUAL');
    const tpl = await delivered(c);
    const [held, noRev, drafted, ok2] = await cloneDelivered(tpl, 4);
    const notReleased = await delivered(c, false);
    await db.deliveryOrder.update({
      where: { id: uuid('deliveryOrder', held!) },
      data: { billingHold: true },
    });
    await db.revenueLine.deleteMany({
      where: { deliveryOrderId: uuid('deliveryOrder', noRev!) },
    });
    await api(app, admin)
      .post('/v1/invoices')
      .send({ customerId: c, deliveryOrderIds: [drafted] })
      .expect(201);
    const rel = app.get(BillingReleaseService);
    const ids = [tpl, held!, noRev!, drafted!, ok2!, notReleased].map((d) => ({
      id: uuid('deliveryOrder', d),
      customerId: uuid('customer', c),
    }));
    const compare = async () => {
      const { out } = await counted(async () => {
        const tx = app.get(DbService).tx;
        const many = await rel.checkMany(tx, ids);
        const single = new Map<string, unknown>();
        for (const d of ids) single.set(d.id, await rel.check(tx, d));
        return { many, single };
      });
      expect(out.many.size).toBe(ids.length);
      for (const d of ids) expect(out.many.get(d.id), d.id).toEqual(out.single.get(d.id));
      return out.many;
    };
    const first = await compare();
    expect(first.get(ids[0]!.id)).toEqual({ reasons: [], released: true });
    expect(first.get(ids[1]!.id)!.reasons).toEqual(['BILLING_HOLD']);
    expect(first.get(ids[2]!.id)!.reasons).toEqual(['NO_REVENUE']);
    expect(first.get(ids[3]!.id)!.reasons).toEqual(['IN_INVOICE']);
    expect(first.get(ids[5]!.id)).toEqual({ reasons: [], released: false });
    // checklist ปัจจุบันเข้มขึ้น (บังคับรูป) → POD_INCOMPLETE + missing เท่ากันทั้งสองทาง
    await db.customer.update({
      where: { id: uuid('customer', c) },
      data: {
        podRequirements: { success: { fields: [{ type: 'NOTE', level: 'REQUIRED' }] } },
      },
    });
    const strict = await compare();
    expect(strict.get(ids[0]!.id)!.reasons).toContain('POD_INCOMPLETE');
    expect(strict.get(ids[0]!.id)!.missing?.length).toBeGreaterThan(0);
  });

  it('PO 22 พ.ย.: ลูกค้าปิดใช้ (INACTIVE) ไม่เข้ารอบ (ร่างใบแจ้งหนี้ + ร่างใบวางบิล) · สร้างร่างมือยังได้', async () => {
    const c = await newCustomer();
    const cid = uuid('customer', c);
    const d = await delivered(c);
    await db.invoice.create({
      data: {
        tenantId,
        customerId: cid,
        issuingCompanyId: companyId,
        issuingBranchId: branchId,
        status: 'ISSUED',
        totalAmount: new Prisma.Decimal('500.00'),
        subtotalExempt: new Prisma.Decimal('500.00'),
        netExpectedAmount: new Prisma.Decimal('500.00'),
        ...issuedTestFields('INV-T12B-OFF1'),
        periodFrom: new Date(`${yesterday}T00:00:00.000Z`),
        periodTo: new Date(`${today}T00:00:00.000Z`),
      },
    });
    await db.customer.update({ where: { id: cid }, data: { status: 'INACTIVE' } });
    const id = await startRun(monthly);
    await drain();
    const j = await job(id);
    expect(j.status).toBe('succeeded');
    expect(resultOf(j, c)).toBeUndefined();
    expect(
      (await api(app, admin).get(`/v1/delivery-orders/${d}`).expect(200)).body.billingStatus,
    ).toBe('UNBILLED');
    expect(await db.billingNote.count({ where: { customerId: cid } })).toBe(0);
    // สร้างร่างมือไม่เปลี่ยน — ปิดใช้ลูกค้าไม่ได้ห้ามเก็บเงินงานที่ส่งแล้ว
    const manual = await api(app, admin)
      .post('/v1/invoices')
      .send({ customerId: c, deliveryOrderIds: [d] });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    // เปิดใช้อีกครั้ง → ใบแจ้งหนี้ของงวดเข้าร่างใบวางบิลในรอบถัดไป
    await db.customer.update({ where: { id: cid }, data: { status: 'ACTIVE' } });
    const id2 = await startRun(monthly);
    await drain();
    const r2 = resultOf(await job(id2), c);
    expect(r2).toMatchObject({ outcome: 'SUCCEEDED', invoiceCount: 0 });
    expect(r2.billingNotes).toHaveLength(1);
    await park(c);
  });

  it('PO 22 พ.ย.: ไฟล์สรุปรอบ .xlsx — แถวต่อร่าง/ลูกค้า · ยอดเงินเฉพาะผู้มี prices.sell:read · ลิงก์ใน result + แจ้งเตือน · เฉพาะผู้สั่ง', async () => {
    const roles = await ensureSystemRoles(db, tenantId);
    const mkUser = async (email: string) => {
      const u = await db.appUser.create({
        data: { tenantId, email, name: email, status: 'ACTIVE' },
      });
      await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles.admin! } });
      return u.id;
    };
    const download = async (url: string): Promise<string[][]> => {
      const u = new URL(url);
      const res = await request(app.getHttpServer())
        .get(u.pathname + u.search)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (x: Buffer) => chunks.push(x));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as unknown as ArrayBuffer);
      const out: string[][] = [];
      wb.worksheets[0]!.eachRow({ includeEmpty: true }, (row) => {
        const v = row.values as unknown[];
        out.push(
          Array.from({ length: wb.worksheets[0]!.columnCount }, (_, i) =>
            v[i + 1] == null ? '' : String(v[i + 1]),
          ),
        );
      });
      return out;
    };
    const base = 'invoices:read invoices:draft jobs:read export:run';

    // ---- ผู้สั่งมีสิทธิ์ราคาขาย: มีคอลัมน์ยอดเงิน
    const priced = await mkUser('sum-priced@run.test');
    const tPriced = await tokenFor(tenantId, `${base} prices.sell:read`, priced);
    const a = await newCustomer();
    const aDo = await delivered(a);
    await cloneDelivered(aDo, 2);
    const failing = await newCustomer();
    await delivered(failing);
    const inv = app.get(InvoicesService);
    const orig = inv.create.bind(inv);
    const spy = vi.spyOn(inv, 'create').mockImplementation(async (body, ...rest) => {
      if (body.customerId === failing) throw new Error('boom: สรุปรอบ');
      return orig(body, ...rest);
    });
    let id: string;
    try {
      id = await startRun(monthly, tPriced);
      await drain();
    } finally {
      spy.mockRestore();
    }
    const j = await job(id, tPriced);
    expect(j.status).toBe('succeeded_with_errors');
    expect(j.result.summary).toMatchObject({
      url: `/v1/exports/${id}`,
      fileName: `สรุปรอบวางบิล_${yesterday}_${today}.xlsx`,
      rows: 2,
    });
    expect(j.result.summary.documentId).toMatch(/^doc_/);
    // ผลของ job ยังไม่มียอดเงิน (ผู้อ่าน job อาจไม่มีสิทธิ์ราคา) — ยอดอยู่ในไฟล์เท่านั้น
    expect(JSON.stringify(j.result)).not.toMatch(/sell|amount/i);
    const st = (await api(app, tPriced).get(j.result.summary.url).expect(200)).body;
    expect(st).toMatchObject({
      id,
      resource: 'invoice-run-summary',
      format: 'xlsx',
      status: 'succeeded',
      rows: 2,
      filter: { billingCycle: 'MONTHLY', periodFrom: yesterday, periodTo: today },
      error: null,
    });
    expect(new Date(st.expiresAt).getTime() - new Date(st.finishedAt).getTime()).toBe(
      7 * 86_400_000,
    );
    const rows = await download(st.downloadUrl);
    const head = rows[0]!;
    expect(head).toEqual([
      'รหัสลูกค้า',
      'ชื่อลูกค้า',
      'ผลของลูกค้า',
      'ประเภทเอกสาร',
      'รหัสร่าง',
      'ลิงก์ร่าง (API)',
      'จำนวนใบส่งของ',
      'จำนวนใบแจ้งหนี้ในใบวางบิล',
      'ยอดก่อน VAT (ประมาณการ)',
      'VAT (ประมาณการ)',
      'ยอดรวม (ประมาณการ)',
      'ใบส่งของที่ข้าม (ของลูกค้า)',
      'กลุ่มที่ไม่สำเร็จ (ของลูกค้า)',
      'แบ่งร่างเพราะเกินเพดาน',
      'สาเหตุที่ไม่สำเร็จ',
    ]);
    const col = (r: string[], h: string) => r[head.indexOf(h)]!;
    const ra = resultOf(j, a);
    const rowA = rows.find((r) => col(r, 'รหัสลูกค้า') === ra.customerCode)!;
    const draft = (await api(app, admin).get(ra.invoices[0].url).expect(200)).body;
    expect(col(rowA, 'ผลของลูกค้า')).toBe('สำเร็จ');
    expect(col(rowA, 'ประเภทเอกสาร')).toBe('ร่างใบแจ้งหนี้');
    expect(col(rowA, 'รหัสร่าง')).toBe(draft.id);
    expect(col(rowA, 'ลิงก์ร่าง (API)')).toBe(`/v1/invoices/${draft.id}`);
    expect(col(rowA, 'จำนวนใบส่งของ')).toBe('3');
    expect(col(rowA, 'ยอดรวม (ประมาณการ)')).toBe(draft.sellTotal);
    expect(col(rowA, 'VAT (ประมาณการ)')).toBe(draft.sellVatAmount);
    expect(col(rowA, 'ยอดก่อน VAT (ประมาณการ)')).toBe(
      new Prisma.Decimal(draft.sellSubtotalExempt)
        .add(draft.sellSubtotalVatable)
        .add(draft.sellSubtotalZeroRated)
        .toFixed(2),
    );
    expect(Number(draft.sellTotal)).toBeGreaterThan(0);
    const rf = resultOf(j, failing);
    const rowF = rows.find((r) => col(r, 'รหัสลูกค้า') === rf.customerCode)!;
    expect(col(rowF, 'ผลของลูกค้า')).toBe('ไม่สำเร็จ');
    expect(col(rowF, 'รหัสร่าง')).toBe('');
    expect(col(rowF, 'ยอดรวม (ประมาณการ)')).toBe('');
    expect(col(rowF, 'กลุ่มที่ไม่สำเร็จ (ของลูกค้า)')).toBe('1');
    expect(col(rowF, 'สาเหตุที่ไม่สำเร็จ')).toMatch(/internal_error/);
    // แจ้งเตือนผู้สั่งพร้อมลิงก์ดาวน์โหลด (หน้าเว็บ /exports/{jobId} เดิม)
    const note = await db.notification.findFirst({
      where: { tenantId, recipientId: priced, templateCode: 'export.ready' },
    });
    expect(note?.link).toBe(`/exports/${id}`);
    expect(note?.body).toMatch(/สรุปรอบวางบิล/);
    // review L3: แจ้งเตือนถูกเขียนก่อนงานปิดสถานะ — ผู้สั่งกดลิงก์ขณะงานยัง RUNNING ได้ 200 `running` (หน้าเว็บรอแล้วดาวน์โหลด) ไม่ใช่ 404
    const jrow = await db.job.findUniqueOrThrow({ where: { id: uuid('job', id) } });
    await db.job.update({
      where: { id: jrow.id },
      data: { status: 'RUNNING', result: Prisma.DbNull, finishedAt: null },
    });
    const running = (await api(app, tPriced).get(`/v1/exports/${id}`).expect(200)).body;
    expect(running).toMatchObject({ status: 'running', resource: 'invoice-run-summary' });
    expect(running.downloadUrl).toBeUndefined();
    await db.job.update({
      where: { id: jrow.id },
      data: {
        status: jrow.status,
        result: jrow.result as Prisma.InputJsonValue,
        finishedAt: jrow.finishedAt,
      },
    });
    // เฉพาะผู้สั่ง: คนอื่น (แม้เป็น admin) = 404
    await api(app, admin).get(`/v1/exports/${id}`).expect(404);
    const doc = await db.storedDocument.findUniqueOrThrow({
      where: { id: uuid('document', j.result.summary.documentId) },
    });
    expect(doc).toMatchObject({ kind: 'EXPORT', entityType: 'job', entityId: uuid('job', id) });
    await park(a);
    await park(failing);

    // ---- ผู้สั่งไม่มีสิทธิ์ราคาขาย: ไม่มีคอลัมน์ยอดเงินในไฟล์
    const plain = await mkUser('sum-plain@run.test');
    const tPlain = await tokenFor(tenantId, base, plain);
    const b = await newCustomer();
    await delivered(b);
    const id2 = await startRun(monthly, tPlain);
    await drain();
    const j2 = await job(id2, tPlain);
    expect(j2.status).toBe('succeeded');
    const st2 = (await api(app, tPlain).get(j2.result.summary.url).expect(200)).body;
    const rows2 = await download(st2.downloadUrl);
    expect(rows2[0]).toEqual(head.filter((h) => !/ยอด|VAT/.test(h)));
    expect(rows2).toHaveLength(2);
    expect(rows2[1]![rows2[0]!.indexOf('จำนวนใบส่งของ')]).toBe('1');
    const draftB = (await api(app, admin).get(resultOf(j2, b).invoices[0].url).expect(200)).body;
    expect(JSON.stringify(rows2)).not.toContain(draftB.sellTotal);
    await park(b);

    // ---- ผู้สั่งไม่มี export:run: ไม่สร้างไฟล์ (รอบสำเร็จตามปกติ)
    const noExport = await mkUser('sum-noexp@run.test');
    const tNo = await tokenFor(tenantId, 'invoices:read invoices:draft jobs:read', noExport);
    const c3 = await newCustomer();
    await delivered(c3);
    const id3 = await startRun(monthly, tNo);
    await drain();
    const j3 = await job(id3, tNo);
    expect(j3.status).toBe('succeeded');
    expect(resultOf(j3, c3)).toMatchObject({ outcome: 'SUCCEEDED', invoiceCount: 1 });
    expect(j3.result.summary).toBeNull();
    await api(app, await tokenFor(tenantId, '*', noExport))
      .get(`/v1/exports/${id3}`)
      .expect(404);
    // รอบที่ไม่มีลูกค้า → ไม่มีไฟล์
    await park(c3);
    const id4 = await startRun(monthly, tPriced);
    await drain();
    expect((await job(id4, tPriced)).result).toMatchObject({ customers: 0, summary: null });
  });

  // ---------- review ST5-T12b ----------

  /** ร่าง n DO ของลูกค้าใหม่ (คัดลอก DO) — คืน token ผู้ออก + ร่าง */
  const bigDraft = async (n: number) => {
    const c = await newCustomer('MANUAL');
    await db.customer.update({
      where: { id: uuid('customer', c) },
      data: { branchCode: '00000', billingAddress: ADDR },
    });
    const tpl = await delivered(c);
    const dos = [tpl, ...(await cloneDelivered(tpl, n - 1))];
    const d = await api(app, admin)
      .post('/v1/invoices')
      .send({ customerId: c, deliveryOrderIds: dos });
    expect(d.status, JSON.stringify(d.body).slice(0, 300)).toBe(201);
    return { c, dos, draft: d.body as { id: string; version: number } };
  };
  const billingOf = async (dos: string[]) =>
    (
      await db.deliveryOrder.groupBy({
        by: ['billingStatus', 'status'],
        where: { id: { in: dos.map((d) => uuid('deliveryOrder', d)) } },
        _count: true,
      })
    ).map((g) => `${g.status}/${g.billingStatus}=${g._count}`);

  for (const n of process.env.TMS_PERF === '1' ? [500, MAX_DOS_PER_INVOICE] : [500])
    it(`review H1: ยกเลิกร่าง / ถอด DO / ยกเลิกใบที่ออกแล้ว ${n} DO — ภายในเวลา transaction · DO กลับวางบิลได้`, async () => {
      // ยกเลิกร่าง
      const a = await bigDraft(n);
      let t0 = Date.now();
      const cancel = await api(app, admin)
        .post(`/v1/invoices/${a.draft.id}/cancel`)
        .set('If-Match', `"${a.draft.version}"`)
        .send({ reason: 'ทดสอบยกเลิกร่างใบใหญ่' });
      const cancelMs = Date.now() - t0;
      expect(cancel.status, JSON.stringify(cancel.body).slice(0, 300)).toBe(200);
      expect(await billingOf(a.dos)).toEqual([`UNBILLED/UNBILLED=${n}`]);
      // ถอด DO ครึ่งหนึ่งออกจากร่าง
      const b = await bigDraft(n);
      t0 = Date.now();
      const rm = await api(app, admin)
        .post(`/v1/invoices/${b.draft.id}/delivery-orders/remove`)
        .set('If-Match', `"${b.draft.version}"`)
        .send({ deliveryOrderIds: b.dos.slice(0, n / 2), reason: 'ทดสอบถอดใบส่งของจำนวนมาก' });
      const removeMs = Date.now() - t0;
      expect(rm.status, JSON.stringify(rm.body).slice(0, 300)).toBe(200);
      expect(rm.body.deliveryOrders).toHaveLength(n / 2);
      expect(await billingOf(b.dos.slice(0, n / 2))).toEqual([`UNBILLED/UNBILLED=${n / 2}`]);
      // ออกเอกสารใบ n DO แล้วยกเลิกใบที่ออกแล้ว (void)
      const v = await bigDraft(n);
      const fin = await tokenFor(tenantId, '*', `u-fin-${n}`);
      const issued = await api(app, fin)
        .post(`/v1/invoices/${v.draft.id}/finalize`)
        .set('If-Match', `"${v.draft.version}"`);
      expect(issued.status, JSON.stringify(issued.body).slice(0, 300)).toBe(200);
      t0 = Date.now();
      const voided = await api(app, fin)
        .post(`/v1/invoices/${v.draft.id}/void`)
        .set('If-Match', `"${issued.body.version}"`)
        .send({ reason: 'ทดสอบยกเลิกใบที่ออกแล้วใบใหญ่' });
      const voidMs = Date.now() - t0;
      expect(voided.status, JSON.stringify(voided.body).slice(0, 300)).toBe(200);
      expect(voided.body.status).toBe('CANCELLED');
      expect(await billingOf(v.dos)).toEqual([`UNBILLED/UNBILLED=${n}`]);
      perfLog(
        `[perf] ${n} DO: cancel draft = ${cancelMs} ms · remove ${n / 2} DO = ${removeMs} ms · void issued (${n} DO) = ${voidMs} ms`,
      );
    });

  it('review M1: ออกเอกสาร + ยกเลิก (3 DO) — event / ประวัติ / outbox ต่อ DO เท่ากับทางทีละใบ', async () => {
    const sub = await db.integrationSubscription.create({
      data: {
        tenantId,
        kind: 'WEBHOOK',
        sink: 'demo',
        eventTypes: ['delivery_order.status_changed'],
      },
    });
    try {
      const a = await bigDraft(3);
      const ids = a.dos.map((d) => uuid('deliveryOrder', d));
      const since = new Date();
      const fin = await tokenFor(tenantId, '*', 'u-fin-m1');
      const issued = await api(app, fin)
        .post(`/v1/invoices/${a.draft.id}/finalize`)
        .set('If-Match', `"${a.draft.version}"`);
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      const invId = uuid('invoice', a.draft.id);
      /** ตรวจ event + ประวัติ + outbox ของการเปลี่ยนสถานะ DO หนึ่งรอบ (from → to ด้วย event) เทียบค่าที่คาดต่อ DO */
      const check = async (from: string, to: string, event: string, after: Date) => {
        const evs = await db.domainEvent.findMany({
          where: {
            tenantId,
            type: 'delivery_order.status_changed',
            localId: { in: ids },
            occurredAt: { gte: after },
          },
        });
        expect(evs).toHaveLength(3);
        for (const id of ids) {
          const ev = evs.find((e) => e.localId === id)!;
          expect(ev, id).toBeTruthy();
          expect(ev.entityType).toBe('delivery_order');
          expect(ev.previousAttributes).toEqual({ status: from });
          const now = (
            await api(app, admin)
              .get(`/v1/delivery-orders/${encodeId('deliveryOrder', id)}`)
              .expect(200)
          ).body;
          expect(now.status).toBe(to);
          // snapshot = รูปเดียวกับ GET /delivery-orders/{id} หลังเปลี่ยน
          expect(ev.snapshot).toEqual(now);
          const h = await db.docStatusHistory.findMany({
            where: { docType: 'delivery_order', docId: id, event, at: { gte: after } },
          });
          expect(h).toHaveLength(1);
          expect(h[0]).toMatchObject({
            fromStatus: from,
            toStatus: to,
            note: `invoice:${invId}`,
            actorId: 'u-fin-m1',
            tenantId,
          });
          const ob = await db.integrationOutbox.findMany({ where: { eventId: ev.id } });
          expect(ob).toHaveLength(1);
          expect(ob[0]).toMatchObject({
            subscriptionId: sub.id,
            entityType: 'delivery_order',
            localId: id,
            eventType: 'delivery_order.status_changed',
            operation: 'delivery_order.status_changed',
            idempotencyKey: `demo:-:delivery_order.status_changed:${ev.id}`,
            serializeKey: `demo:-:evt:${ev.id}`,
          });
        }
      };
      await check('UNBILLED', 'BILLED', 'bill', since);
      const since2 = new Date();
      const voided = await api(app, fin)
        .post(`/v1/invoices/${a.draft.id}/void`)
        .set('If-Match', `"${issued.body.version}"`)
        .send({ reason: 'ทดสอบเทียบ event ต่อ DO' });
      expect(voided.status, JSON.stringify(voided.body)).toBe(200);
      await check('BILLED', 'UNBILLED', 'unbill', since2);
    } finally {
      await db.integrationOutbox.deleteMany({ where: { subscriptionId: sub.id } });
      await db.integrationSubscription.delete({ where: { id: sub.id } });
    }
  });
});
