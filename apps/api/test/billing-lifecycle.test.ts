import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  InvoiceBillingGuard,
  type DoInvoiceLineInput,
} from '../src/modules/invoices/billing-guard.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST5-T06 Lifecycle และ revert rules ของ DO (docs/04 F4) — เกณฑ์ตรวจรับ:
 * Dispatcher ย้อนหลัง 24 ชม. ถูกปฏิเสธ (403 — ผู้มี trips:override ย้อนได้) · แก้ stop/qty หลัง RELEASED → 409
 * + ย้อนการส่งบัญชี (Invoicer, เหตุผล, audit) · DO ในใบแจ้งหนี้ย้อน/แก้ไม่ได้ · timestamp ต่อขั้น · สิทธิ์ · If-Match · แยก tenant
 */
describe('billing lifecycle + revert rules (ST5-T06)', { timeout: 300_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let viewer: string;
  let planner: string;
  let dispatcher: string;
  let invoicer: string;
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
  const NONE_REQ = { success: { fields: [] } };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท lifecycle วางบิล' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(961) },
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
    freight = (await db.serviceItem.findFirstOrThrow({ where: { tenantId, systemKey: 'FREIGHT' } }))
      .id;
    admin = await tokenFor(tenantId);
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
    planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-plan');
    dispatcher = await tokenFor(tenantId, SYSTEM_ROLES.dispatcher.permissions.join(' '), 'u-disp');
    invoicer = await tokenFor(tenantId, SYSTEM_ROLES.invoicer.permissions.join(' '), 'u-inv');
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
  afterEach(() => app.get(Clock).set(null));
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
          plate: `8${++seed % 10}-${String(3000 + seed)}`,
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

  interface Opts {
    /** มี rate card ขาขาย (ราคา AVAILABLE) — ค่าเริ่มต้น true */
    rate?: boolean;
    /** checklist ชุดสำเร็จของลูกค้า — ไม่ส่ง = ค่าองค์กร (รูป + ลายเซ็นบังคับ) */
    podRequirements?: object;
    /** ค่าตั้ง "ไม่มี POD ไม่วางบิล" — ไม่ส่ง = ค่าเริ่มต้น (เปิด) */
    requirePodToBill?: boolean;
    billByActualQty?: boolean;
    /** จุดส่งไม่มีเวลาถึง/ออก (ล้างที่ฐานหลังส่ง) */
    noArrive?: boolean;
    customerId?: string;
  }
  const newCustomer = async (o: Opts) => {
    const body = (
      await api(app, admin)
        .post('/v1/customers')
        .send({
          legalName: `ลูกค้าวางบิล ${++seed}`,
          taxId: validTaxId(9800 + seed),
          externalId: `CUS-EXT-${seed}`,
          ...(o.requirePodToBill !== undefined ? { requirePodToBill: o.requirePodToBill } : {}),
          ...(o.billByActualQty ? { billByActualQty: true } : {}),
        })
        .expect(201)
    ).body as { id: string; requirePodToBill: boolean };
    if (o.podRequirements)
      await db.customer.update({
        where: { id: uuid('customer', body.id) },
        data: { podRequirements: o.podRequirements },
      });
    return body.id;
  };

  /** ลูกค้า → (rate card) → SO 5 ตัน → DO → เที่ยวปล่อยรถ → ปิดจุดรับ + จุดส่ง (ส่งสำเร็จ) · คืน DO */
  const delivered = async (o: Opts = {}) => {
    const customer = o.customerId ?? (await newCustomer(o));
    const origin = await newSite();
    const dest = await newSite();
    if (o.rate !== false) {
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
    }
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
    const r = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: vid, dispatch: true });
    if (r.status !== 200)
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: vid,
          dispatch: true,
          ruleKeys: r.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบคิววางบิล',
        })
        .expect(200);
    const full = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    const [pickup, drop] = [...full.stops].sort(
      (a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence,
    );
    await post(pickup.id, 'arrive', 60).expect(201);
    await post(pickup.id, 'complete', 55, { outcome: 'DELIVERED' }).expect(201);
    await post(drop.id, 'arrive', 20).expect(201);
    await post(drop.id, 'complete', 10, { outcome: 'DELIVERED' }).expect(201);
    // ข้อมูลเก่า/นำเข้าที่จุดส่งไม่มีเวลาถึง-ออก (flow ปกติปิดงานได้หลังถึงจุดเท่านั้น) — ล้าง projection ตรงที่ฐาน
    if (o.noArrive)
      await db.tripStop.update({
        where: { id: uuid('tripStop', drop.id) },
        data: { arrivedAt: null, departedAt: null },
      });
    return {
      doId,
      uuid: d!.id,
      customer,
      soId: so.id,
      drop: drop.id as string,
      tripId: t.id as string,
    };
  };
  const queue = async (qs = '', token = admin) =>
    (await api(app, token).get(`/v1/invoices/queue${qs}`).expect(200)).body as {
      data: Record<string, any>[];
      nextCursor: string | null;
      hasMore: boolean;
      customers: Record<string, any>[];
    };
  const ids = (b: { data: Record<string, any>[] }) => b.data.map((x) => x.id as string);
  const release = (doId: string, token = admin) =>
    api(app, token).post(`/v1/delivery-orders/${doId}/release`).send({});

  const revert = (
    doId: string,
    token = dispatcher,
    body: object = { reason: 'คนขับกดปิดงานผิดจุด ของยังไม่ถึง' },
  ) => api(app, token).post(`/v1/delivery-orders/${doId}/revert-delivery`).send(body);
  const unrelease = (doId: string, token = invoicer, reason = 'ต้องแก้ยอดส่งจริงตามใบรับของ') =>
    api(app, token).post(`/v1/delivery-orders/${doId}/unrelease`).send({ reason });
  const getDo = async (doId: string) =>
    (await api(app, admin).get(`/v1/delivery-orders/${doId}`).expect(200)).body as Record<
      string,
      any
    >;
  const errCode = (r: { body: { errors?: { code: string }[] } }) => r.body.errors?.[0]?.code;
  const guard = () => app.get(InvoiceBillingGuard);
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

  it('ย้อนผลส่งถึงภายใน 24 ชม. โดย Dispatcher → FAILED + audit + ใบสั่งกลับเป็นส่งบางส่วน · คืนคลังต่อได้', async () => {
    const d = await delivered({ podRequirements: NONE_REQ });
    const before = await getDo(d.doId);
    expect(before).toMatchObject({
      status: 'UNBILLED',
      billingStage: 'DELIVERED',
      invoicedAt: null,
      paidAt: null,
    });
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: d.soId } })).status).toBe(
      'DELIVERED',
    );

    // สิทธิ์: planner/viewer ไม่มี trips:close → 403 · tenant อื่น 404 · เหตุผลสั้น 422 · If-Match ไม่ตรง 412
    await revert(d.doId, planner).expect(403);
    await revert(d.doId, viewer).expect(403);
    await revert(d.doId, other).expect(404);
    await revert(d.doId, dispatcher, { reason: 'สั้น' }).expect(422);
    await api(app, dispatcher)
      .post(`/v1/delivery-orders/${d.doId}/revert-delivery`)
      .set('If-Match', '"999"')
      .send({ reason: 'คนขับกดปิดงานผิดจุด ของยังไม่ถึง' })
      .expect(412);

    // 23 ชม. หลังส่งถึง ยังอยู่ในช่วง
    app.get(Clock).set(new Date(Date.now() + 23 * 3600_000));
    const r = await api(app, dispatcher)
      .post(`/v1/delivery-orders/${d.doId}/revert-delivery`)
      .set('If-Match', `"${before.version}"`)
      .send({ reason: 'คนขับกดปิดงานผิดจุด ของยังไม่ถึง' })
      .expect(200);
    expect(r.body).toMatchObject({
      status: 'FAILED',
      billingStage: null,
      version: before.version + 1,
    });
    const audit = await db.auditLog.findMany({
      where: { tenantId, action: 'delivery_order.delivery_reverted', entityId: d.uuid },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      reason: 'คนขับกดปิดงานผิดจุด ของยังไม่ถึง',
      actorId: 'u-disp',
    });
    expect(audit[0]!.after).toMatchObject({ status: 'FAILED', override: false });
    const hist = await db.docStatusHistory.findFirst({
      where: { docId: d.uuid, event: 'revert_delivery' },
    });
    expect(hist).toMatchObject({ fromStatus: 'UNBILLED', toStatus: 'FAILED' });
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: d.soId } })).status).toBe(
      'PARTIALLY_DELIVERED',
    );
    // ย้อนซ้ำ → 409 (ไม่ได้ส่งถึงแล้ว) · ไม่ออกจากคิวพร้อมวางบิล = ไม่อยู่ในคิว
    const again = await revert(d.doId).expect(409);
    expect(errCode(again)).toBe('not_delivered');
    const q = (await api(app, admin).get('/v1/invoices/queue').expect(200)).body.data as {
      id: string;
    }[];
    expect(q.map((x) => x.id)).not.toContain(d.doId);

    // จัดการต่อด้วยงานเดิม (ST4-T11): คืนคลัง FAILED → RETURNED
    const rsn = encodeId(
      'reasonCode',
      (await db.reasonCode.findFirstOrThrow({ where: { tenantId, category: 'DELIVERY_FAILED' } }))
        .id,
    );
    await api(app, admin)
      .post(`/v1/delivery-orders/${d.doId}/return`)
      .send({ reasonCodeId: rsn, note: 'คืนคลังหลังย้อนผลส่งถึง' })
      .expect(200);
    expect((await getDo(d.doId)).status).toBe('RETURNED');
  });

  it('เกณฑ์ตรวจรับ: Dispatcher ย้อนหลัง 24 ชม. → 403 · ผู้มี trips:override ย้อนได้ (audit override)', async () => {
    const d = await delivered({ podRequirements: NONE_REQ });
    app.get(Clock).set(new Date(Date.now() + 25 * 3600_000));
    const r = await revert(d.doId, dispatcher).expect(403);
    expect(r.body).toMatchObject({
      code: 'permission_denied',
      reason: 'revert_window_expired',
      required: ['trips:override'],
    });
    const deliveredAt = new Date(r.body.deliveredAt).getTime();
    expect(new Date(r.body.revertDeadline).getTime() - deliveredAt).toBe(24 * 3600_000);
    expect((await getDo(d.doId)).status).toBe('UNBILLED');

    // manager (trips:override) ย้อนได้หลัง 24 ชม.
    const manager = await tokenFor(tenantId, SYSTEM_ROLES.manager.permissions.join(' '), 'u-mgr');
    await revert(d.doId, manager, { reason: 'ผู้จัดการตรวจแล้ว ส่งไม่ถึงจริง' }).expect(200);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { tenantId, action: 'delivery_order.delivery_reverted', entityId: d.uuid },
    });
    expect(audit.after).toMatchObject({ override: true });
  });

  it('เกณฑ์ตรวจรับ: หลัง RELEASED แก้ stop/qty → 409 do_released · ย้อนผลส่งไม่ได้ · Invoicer ย้อนการส่งบัญชีแล้วแก้ได้', async () => {
    const d = await delivered({ podRequirements: NONE_REQ });
    const rel = await release(d.doId, invoicer).expect(200);
    expect(rel.body.billingStage).toBe('RELEASED');

    // จุดแวะ (เหตุการณ์ใหม่ที่จุดส่ง) → 409
    const ev = await post(d.drop, 'arrive', 1);
    expect(ev.status).toBe(409);
    expect(ev.body.code).toBe('invalid_state_transition');
    expect(errCode(ev)).toBe('do_released');
    // ยอดส่งจริง (POD lines) → 409
    const pod = await api(app, admin)
      .put(`/v1/delivery-orders/${d.doId}/pod`)
      .send({ lines: [{ lineNo: 1, qtyActual: '5' }] });
    expect(pod.status).toBe(409);
    expect(errCode(pod)).toBe('do_released');
    // ย้อนผลส่งถึง → 409 (ต้องย้อนการส่งบัญชีก่อน)
    expect(errCode(await revert(d.doId).expect(409))).toBe('do_released');

    // ย้อนการส่งบัญชี: dispatcher ไม่มี invoices:draft 403 · เหตุผลสั้น 422 · tenant อื่น 404
    await unrelease(d.doId, dispatcher).expect(403);
    await unrelease(d.doId, invoicer, 'สั้น').expect(422);
    await unrelease(d.doId, other).expect(404);
    await api(app, invoicer)
      .post(`/v1/delivery-orders/${d.doId}/unrelease`)
      .set('If-Match', '"999"')
      .send({ reason: 'ต้องแก้ยอดส่งจริงตามใบรับของ' })
      .expect(412);
    const u = await unrelease(d.doId).expect(200);
    expect(u.body).toMatchObject({ releasedAt: null, billingStage: 'DELIVERED' });
    expect(u.body.version).toBe(rel.body.version + 1);
    const audit = await db.auditLog.findMany({
      where: { tenantId, action: 'delivery_order.unreleased', entityId: d.uuid },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: 'ต้องแก้ยอดส่งจริงตามใบรับของ', actorId: 'u-inv' });
    // ยังไม่ส่งบัญชี = ตอบใบเดิม ไม่ลง audit ซ้ำ
    const same = await unrelease(d.doId).expect(200);
    expect(same.body.version).toBe(u.body.version);
    expect(
      await db.auditLog.count({
        where: { tenantId, action: 'delivery_order.unreleased', entityId: d.uuid },
      }),
    ).toBe(1);
    // หลังย้อน แก้จุดแวะได้อีก
    await post(d.drop, 'depart', 1).expect(201);
  });

  it('DO ในใบแจ้งหนี้: ย้อนการส่งบัญชี/ย้อนผลส่ง/แก้จุดแวะ → 409 do_in_invoice · ออกเลข → invoicedAt + ขั้น INVOICED', async () => {
    const d = await delivered({ podRequirements: NONE_REQ });
    await release(d.doId, invoicer).expect(200);
    const inv = await draft(d.customer);
    await run((tx) => guard().attach(inv, [line(d.uuid)], tx));
    expect(await getDo(d.doId)).toMatchObject({
      billingStatus: 'IN_DRAFT',
      billingStage: 'IN_DRAFT',
    });
    expect(errCode(await unrelease(d.doId).expect(409))).toBe('do_in_invoice');
    expect(errCode(await revert(d.doId, admin).expect(409))).toBe('do_in_invoice');
    expect(errCode(await post(d.drop, 'arrive', 1).expect(409))).toBe('do_in_invoice');

    const at = new Date('2026-11-20T03:00:00.000Z');
    app.get(Clock).set(at);
    await run(async (tx) => {
      await tx.invoice.update({
        where: { id: inv },
        data: { status: 'ISSUED', invoiceNo: 'INV-T06-1' },
      });
      await guard().syncFromInvoice(inv, tx);
    });
    expect(await getDo(d.doId)).toMatchObject({
      billingStatus: 'INVOICED',
      billingStage: 'INVOICED',
      invoicedAt: at.toISOString(),
      paidAt: null,
    });
    const r = await unrelease(d.doId).expect(409);
    expect(r.body).toMatchObject({ billingStatus: 'INVOICED' });
    expect(errCode(await revert(d.doId, admin).expect(409))).toBe('do_in_invoice');
  });

  it('งานต่อจากยอดปฏิเสธรับแล้ว → ย้อนผลส่งไม่ได้ (has_followups)', async () => {
    const d = await delivered({ podRequirements: NONE_REQ });
    await db.deliveryOrderLine.updateMany({
      where: { deliveryOrderId: d.uuid },
      data: {
        rejectQty: '1',
        returnedQty: '1',
        qtyActual: '4',
        rejectReasonCodeId: (
          await db.reasonCode.findFirstOrThrow({
            where: { tenantId, category: 'REJECTED_BY_RECEIVER' },
          })
        ).id,
      },
    });
    expect(errCode(await revert(d.doId).expect(409))).toBe('has_followups');
  });
});
