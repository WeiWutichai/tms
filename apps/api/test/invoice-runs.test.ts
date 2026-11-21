import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { JobQueue } from '../src/jobs/job-queue.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { BillingQueueService } from '../src/modules/invoices/billing-queue.service';
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
    const mk = (no: string, o: { branch?: string; status?: 'ISSUED' | 'PAID' } = {}) =>
      db.invoice.create({
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
        },
      });
    await mk('INV-T12-0001');
    await mk('INV-T12-0002');
    await mk('INV-T12-0003', { branch: branch2.id });
    await mk('INV-T12-0004', { status: 'PAID' });
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
      1, 2,
    ]);
    for (const b of r.billingNotes) {
      expect(b.url).toBe(`/v1/billing-notes/${b.id}`);
      const bn = (await api(app, admin).get(b.url).expect(200)).body;
      expect(bn).toMatchObject({ status: 'DRAFT', billingNoteNo: null });
    }
    const again = await startRun(monthly);
    await drain();
    expect(resultOf(await job(again), c)).toBeUndefined();
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
    svc.groupSize = 2; // แทนเพดาน 200 (สร้าง DO 201 ใบช้าเกินใน test)
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
      expect(r).toMatchObject({ outcome: 'PARTIAL', invoiceCount: 1, failedGroups: 1 });
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
      svc.groupSize = 200;
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
});
