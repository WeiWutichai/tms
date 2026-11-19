import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const REASON = 'ลูกค้าขอให้ช่วยยกของขึ้นชั้นสอง';

interface Line {
  id: string;
  lineNo: number;
  sourceType: string;
  sourceId: string | null;
  isUserAdded: boolean;
  kind: string;
  deliveryOrderId: string | null;
  description: string;
  qty: string;
  sellUnitPrice?: string;
  sellAmount?: string;
  vatType: string;
  whtRate: string;
  status: string;
  locked: boolean;
  version: number;
}

/**
 * ST5-T01 บรรทัดรายได้ (docs/04 F3 "Revenue line ตั้งแต่สร้าง order") — เกณฑ์ตรวจรับ:
 * แก้ปริมาณ order → บรรทัดระบบเปลี่ยน บรรทัดที่คนเพิ่มยังอยู่; หลัง finalize (ล็อก) ไม่เปลี่ยน
 * + ค่าใช้จ่ายหน้างานที่ยืนยัน → บรรทัด DO_SURCHARGE, ยกเลิกบรรทัดที่คนเพิ่ม, guard ฐานข้อมูล, สิทธิ์, แยก tenant
 */
describe('revenue lines (ST5-T01)', () => {
  let app: NestExpressApplication;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  let tenantId: string;
  let otherTenant: string;
  let admin: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let unitTonPub: string;
  let vt6: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const addDays = (d: string, n: number) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท บรรทัดรายได้' })).id;
    otherTenant = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(951) },
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
    other = await tokenFor(otherTenant);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTonPub = us.find((u) => u.code === 'TON')!.id;
    unitTon = uuid('unit', unitTonPub);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
    waitSvc = await svcId('WAIT');
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await owner.$disconnect();
    await appDb.$disconnect();
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

  /** ใบสั่ง 20 + 5 ตัน (rate card ต่อตัน 350 → ค่าขนส่ง 8,750) สถานะ RECEIVED */
  const order = async () => {
    const customer = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9800 + seed) })
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
          validFrom: addDays(today, -30),
          includedStops: 2,
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
      lines: [
        { description: 'ปูนซีเมนต์', qty: '20', unitId: unitTon, weightKg: '20000' },
        { description: 'เหล็กเส้น', qty: '5', unitId: unitTon, weightKg: '5000' },
      ],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    return { id: so.id, pub: encodeId('salesOrder', so.id) };
  };
  const lines = async (pub: string, token = admin) =>
    (await api(app, token).get(`/v1/orders/${pub}/revenue-lines`).expect(200)).body.data as Line[];
  const svcId = async (code: string) =>
    encodeId(
      'serviceItem',
      (await db.serviceItem.findFirstOrThrow({ where: { tenantId, code } })).id,
    );
  let waitSvc = '';
  const addManual = (pub: string, body: Record<string, unknown> = {}) =>
    api(app, admin)
      .post(`/v1/orders/${pub}/revenue-lines`)
      .send({ serviceItemId: waitSvc, qty: '2', sellUnitPrice: '250', reason: REASON, ...body });
  const patchQty = (pub: string, q1: string) =>
    api(app, admin)
      .patch(`/v1/orders/${pub}`)
      .send({
        lines: [
          {
            description: 'ปูนซีเมนต์',
            qty: q1,
            unitId: unitTonPub,
            weightKg: `${Number(q1) * 1000}`,
          },
          { description: 'เหล็กเส้น', qty: '5', unitId: unitTonPub, weightKg: '5000' },
        ],
      });
  /** DO ของใบสั่ง (สร้างตรงที่ฐาน) */
  const deliveryOrder = async (soId: string, status: 'DRAFT' | 'CANCELLED' = 'DRAFT') => {
    const so = await db.salesOrder.findUniqueOrThrow({
      where: { id: soId },
      include: { stops: true },
    });
    const d = await db.deliveryOrder.create({
      data: {
        tenantId,
        doNo: `DO-RVL-${++seed}`,
        doDate: new Date(today),
        salesOrderId: soId,
        customerId: so.customerId!,
        originSiteId: so.stops[0]!.siteId!,
        destSiteId: so.stops[1]!.siteId!,
        originStopSeq: 1,
        destStopSeq: 2,
        status,
      },
    });
    return { id: d.id, pub: encodeId('deliveryOrder', d.id) };
  };

  it('เกณฑ์ตรวจรับ: แก้ปริมาณ order → บรรทัดระบบเปลี่ยน บรรทัดที่คนเพิ่มยังอยู่', async () => {
    const o = await order();
    const before = await lines(o.pub);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      sourceType: 'SO_CHARGE',
      isUserAdded: false,
      kind: 'FREIGHT',
      qty: '25',
      sellUnitPrice: '350.00',
      sellAmount: '8750.00',
      status: 'ACTIVE',
      locked: false,
    });
    expect(before[0]!.sourceId).toMatch(/^och_/);
    // ธงภาษีคัดลอกจากบรรทัดราคาของใบสั่ง (snapshot — ไม่ join catalog)
    const charge = await db.salesOrderCharge.findFirstOrThrow({ where: { salesOrderId: o.id } });
    expect(before[0]).toMatchObject({
      vatType: charge.vatType,
      whtRate: charge.whtRate.toFixed(2),
    });

    // คนเพิ่มบรรทัดเอง: ค่ารอ 2 × 250
    const added = await addManual(o.pub).expect(201);
    expect(added.body).toMatchObject({
      sourceType: 'MANUAL',
      sourceId: null,
      isUserAdded: true,
      kind: 'ACCESSORIAL',
      qty: '2',
      sellUnitPrice: '250.00',
      sellAmount: '500.00',
    });
    const wait = await db.serviceItem.findFirstOrThrow({ where: { tenantId, code: 'WAIT' } });
    expect(added.body).toMatchObject({
      vatType: wait.vatType,
      whtRate: wait.whtRate.toFixed(2),
    });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: o.id, action: 'sales_order.revenue_line_added' },
    });
    expect(audit.reason).toBe(REASON);

    // แก้ปริมาณ 20 → 30 ตัน → ค่าขนส่ง 35 × 350 = 12,250 · บรรทัดที่คนเพิ่มยังอยู่ (id เดิม)
    await patchQty(o.pub, '30').expect(200);
    const after = await lines(o.pub);
    expect(after).toHaveLength(2);
    const sys = after.find((l) => l.sourceType === 'SO_CHARGE')!;
    expect(sys).toMatchObject({ qty: '35', sellAmount: '12250.00' });
    expect(sys.id).not.toBe(before[0]!.id);
    const man = after.find((l) => l.isUserAdded)!;
    expect(man).toMatchObject({ id: added.body.id, sellAmount: '500.00', status: 'ACTIVE' });
    // ไม่มีบรรทัดค้างของราคาเดิม
    expect(await db.revenueLine.count({ where: { salesOrderId: o.id } })).toBe(2);

    // แก้ช่องที่ไม่กระทบราคา → ไม่เขียนบรรทัดใหม่ (idempotent)
    await api(app, admin)
      .patch(`/v1/orders/${o.pub}`)
      .send({ customerRef: 'PO-RVL-1' })
      .expect(200);
    expect((await lines(o.pub)).map((l) => l.id)).toEqual(after.map((l) => l.id));
  });

  it('เกณฑ์ตรวจรับ: หลัง finalize (บรรทัดล็อก) แก้ปริมาณแล้วบรรทัดไม่เปลี่ยน · ฐานข้อมูลกันแก้/ลบ', async () => {
    const o = await order();
    const man = (await addManual(o.pub).expect(201)).body as Line;
    const [sys] = await lines(o.pub);
    // จำลอง ST5-T09 finalize: ตั้งล็อกให้ทุกบรรทัดของใบสั่ง (เอกสารแม่ออกเลขแล้ว)
    const docId = randomUUID();
    await db.revenueLine.updateMany({
      where: { salesOrderId: o.id },
      data: { lockedAt: new Date(), lockedDocumentId: docId },
    });
    await patchQty(o.pub, '40').expect(200);
    const after = await lines(o.pub);
    expect(after).toHaveLength(2);
    expect(after.find((l) => l.sourceType === 'SO_CHARGE')).toMatchObject({
      id: sys!.id,
      qty: '25',
      sellAmount: '8750.00',
      locked: true,
    });
    // ราคาของใบสั่งคิดใหม่จริง แต่บรรทัดรายได้ไม่ตาม
    const charge = await db.salesOrderCharge.findFirstOrThrow({ where: { salesOrderId: o.id } });
    expect(charge.amount.toFixed(2)).toBe('15750.00');

    // เพิ่มบรรทัดเอง / ยกเลิกบรรทัดที่ล็อก → 409
    const add = await addManual(o.pub).expect(409);
    expect(add.body).toMatchObject({
      code: 'invalid_state_transition',
      reason: 'revenue_line_locked',
    });
    const v = await api(app, admin)
      .post(`/v1/revenue-lines/${man.id}/void`)
      .send({ reason: 'ทดสอบยกเลิกบรรทัดที่ล็อก' })
      .expect(409);
    expect(v.body.reason).toBe('revenue_line_locked');

    // guard ฐานข้อมูล (owner ก็ไม่ผ่าน): แก้เนื้อหา / ลบ แถวที่ล็อก
    const sysId = uuid('revenueLine', sys!.id);
    await expect(
      db.revenueLine.update({ where: { id: sysId }, data: { amount: '1.00' } }),
    ).rejects.toThrow(/locked/);
    await expect(
      db.revenueLine.update({ where: { id: sysId }, data: { status: 'VOIDED' } }),
    ).rejects.toThrow();
    await expect(db.revenueLine.delete({ where: { id: sysId } })).rejects.toThrow(/locked/);
    // ปลด/ย้ายล็อกตรงด้วย UPDATE ไม่ได้: role platform, เจ้าของตาราง (ไม่มีธง), role แอป (แม้ตั้งธงเอง)
    const unlock = { lockedAt: null, lockedDocumentId: null };
    await expect(db.revenueLine.update({ where: { id: sysId }, data: unlock })).rejects.toThrow(
      /tms_revenue_line_unlock/,
    );
    await expect(owner.revenueLine.update({ where: { id: sysId }, data: unlock })).rejects.toThrow(
      /tms_revenue_line_unlock/,
    );
    await expect(
      owner.revenueLine.update({ where: { id: sysId }, data: { lockedDocumentId: randomUUID() } }),
    ).rejects.toThrow(/tms_revenue_line_unlock/);
    const asApp = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx);
      });
    await expect(
      asApp(async (tx) => {
        await tx.$executeRaw`SELECT set_config('tms.revenue_line_unlock', 'on', true)`;
        return tx.revenueLine.update({ where: { id: sysId }, data: unlock });
      }),
    ).rejects.toThrow(/tms_revenue_line_unlock/);
    // role platform ไม่มีสิทธิ์เรียกฟังก์ชันปลด · เหตุผลสั้น → ปฏิเสธ
    await expect(
      db.$queryRaw`SELECT tms_revenue_line_unlock(${docId}::uuid, 'x', 'ยกเลิกใบแจ้งหนี้ทดสอบ')`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp((tx) => tx.$queryRaw`SELECT tms_revenue_line_unlock(${docId}::uuid, 'u', 'สั้น')`),
    ).rejects.toThrow(/reason/);
    // ทางเดียว: ฟังก์ชันปลด (ST5-T10) ในนาม role แอป → ปลดทุกบรรทัดของเอกสาร + audit
    const [res] = await asApp(
      (tx) =>
        tx.$queryRaw<{ n: number }[]>`
          SELECT tms_revenue_line_unlock(${docId}::uuid, 'user-test', 'ยกเลิกใบแจ้งหนี้ทดสอบระบบ') AS n`,
    );
    expect(Number(res!.n)).toBe(2);
    expect(
      await db.revenueLine.count({ where: { salesOrderId: o.id, lockedAt: { not: null } } }),
    ).toBe(0);
    const ua = await db.auditLog.findFirstOrThrow({
      where: { entityId: o.id, action: 'sales_order.revenue_lines_unlocked' },
    });
    expect(ua).toMatchObject({ actorId: 'user-test', reason: 'ยกเลิกใบแจ้งหนี้ทดสอบระบบ' });
    expect(ua.after).toMatchObject({ count: 2 });
    // ปลดแล้ว: แก้ใบสั่งครั้งต่อไป → บรรทัดระบบตามราคาปัจจุบัน
    await patchQty(o.pub, '41').expect(200);
    expect((await lines(o.pub)).find((l) => l.sourceType === 'SO_CHARGE')).toMatchObject({
      qty: '46',
      sellAmount: '16100.00',
      locked: false,
    });
  });

  it('ค่าใช้จ่ายหน้างานที่ยืนยัน → บรรทัด DO_SURCHARGE (รอยืนยัน/ปฏิเสธ = ไม่มี) · แก้ใบสั่งแล้วยังอยู่', async () => {
    const o = await order();
    const d = await deliveryOrder(o.id);
    const wait = await db.serviceItem.findFirstOrThrow({ where: { tenantId, code: 'WAIT' } });
    const trip = await db.trip.create({
      data: { tenantId, tripNo: `TRP-RVL-${++seed}`, tripDate: new Date(today) },
    });
    const mk = (withTrip = true) =>
      db.doSurcharge.create({
        data: {
          tenantId,
          deliveryOrderId: d.id,
          tripId: withTrip ? trip.id : null,
          serviceItemId: wait.id,
          serviceItemVersion: wait.version,
          description: 'ค่ารอ',
          vatType: 'VAT_7',
          whtRate: '3.00',
          qty: '3',
          unitPrice: '200',
          amount: '600',
          createdBy: 'user-recorder',
        },
      });
    // s2 = แถวก่อน ST4-T13 (ไม่มี trip_id) — ตัดสินแล้วต้องไม่ 500
    const [s1, s2] = [await mk(), await mk(false)];
    expect((await lines(o.pub)).filter((l) => l.sourceType === 'DO_SURCHARGE')).toHaveLength(0);
    await api(app, admin)
      .post(`/v1/do-surcharges/${encodeId('doSurcharge', s1.id)}/confirm`)
      .send({ reason: 'ตรวจใบเสร็จแล้วถูกต้อง' })
      .expect(200);
    await api(app, admin)
      .post(`/v1/do-surcharges/${encodeId('doSurcharge', s2.id)}/reject`)
      .send({ reason: 'ไม่มีหลักฐานการรอคิว' })
      .expect(200);
    const ls = await lines(o.pub);
    const sur = ls.filter((l) => l.sourceType === 'DO_SURCHARGE');
    expect(sur).toHaveLength(1);
    expect(sur[0]).toMatchObject({
      sourceId: encodeId('doSurcharge', s1.id),
      deliveryOrderId: d.pub,
      isUserAdded: false,
      kind: 'ACCESSORIAL',
      qty: '3',
      sellUnitPrice: '200.00',
      sellAmount: '600.00',
      vatType: 'VAT_7',
      whtRate: '3.00',
    });
    // แก้ใบสั่ง (ราคาคิดใหม่) → บรรทัดค่าใช้จ่ายหน้างานยังเป็นบรรทัดเดิม
    await patchQty(o.pub, '22').expect(200);
    const after = await lines(o.pub);
    expect(after.find((l) => l.sourceType === 'DO_SURCHARGE')!.id).toBe(sur[0]!.id);
    expect(after.map((l) => l.sourceType)).toEqual(['SO_CHARGE', 'DO_SURCHARGE']);
    // แหล่งเดียว = บรรทัดเดียว (unique ที่ฐานข้อมูล)
    const row = await db.revenueLine.findFirstOrThrow({ where: { sourceId: s1.id } });
    await expect(
      db.revenueLine.create({
        data: {
          tenantId,
          salesOrderId: o.id,
          deliveryOrderId: d.id,
          lineNo: 99,
          sourceType: 'DO_SURCHARGE',
          sourceId: s1.id,
          kind: 'ACCESSORIAL',
          serviceItemId: row.serviceItemId,
          description: 'x',
          qty: '1',
          unitPrice: '1',
          amount: '1',
          vatType: 'VAT_7',
          whtRate: '3.00',
        },
      }),
    ).rejects.toThrow();
  });

  it('ยกเลิกบรรทัดที่คนเพิ่ม: เหตุผล + audit + If-Match · บรรทัดระบบยกเลิกไม่ได้ · ฐานข้อมูลห้ามลบบรรทัดที่คนเพิ่ม', async () => {
    const o = await order();
    const man = (await addManual(o.pub).expect(201)).body as Line;
    const [sys] = await lines(o.pub);
    // บรรทัดระบบ → 409
    const s = await api(app, admin)
      .post(`/v1/revenue-lines/${sys!.id}/void`)
      .send({ reason: 'ทดสอบยกเลิกบรรทัดระบบ' })
      .expect(409);
    expect(s.body).toMatchObject({ code: 'invalid_state_transition', reason: 'system_line' });
    // เหตุผลสั้น → 422 · If-Match ไม่ตรง → 412
    await api(app, admin)
      .post(`/v1/revenue-lines/${man.id}/void`)
      .send({ reason: 'สั้น' })
      .expect(422);
    await api(app, admin)
      .post(`/v1/revenue-lines/${man.id}/void`)
      .set('If-Match', '"99"')
      .send({ reason: 'เพิ่มผิดรายการ ลูกค้าไม่ได้ขอ' })
      .expect(412);
    const ok = await api(app, admin)
      .post(`/v1/revenue-lines/${man.id}/void`)
      .set('If-Match', `"${man.version}"`)
      .send({ reason: 'เพิ่มผิดรายการ ลูกค้าไม่ได้ขอ' })
      .expect(200);
    expect(ok.body).toMatchObject({
      status: 'VOIDED',
      voidReason: 'เพิ่มผิดรายการ ลูกค้าไม่ได้ขอ',
    });
    expect(ok.header.etag).toBe(`"${man.version + 1}"`);
    await api(app, admin)
      .post(`/v1/revenue-lines/${man.id}/void`)
      .send({ reason: 'ยกเลิกซ้ำอีกครั้งหนึ่ง' })
      .expect(409);
    const a = await db.auditLog.findFirstOrThrow({
      where: { entityId: o.id, action: 'sales_order.revenue_line_voided' },
    });
    expect(a.reason).toBe('เพิ่มผิดรายการ ลูกค้าไม่ได้ขอ');
    // แก้ใบสั่งแล้วบรรทัดที่ยกเลิกยังอยู่ (ไม่ลบ)
    await patchQty(o.pub, '21').expect(200);
    expect((await lines(o.pub)).find((l) => l.id === man.id)).toMatchObject({ status: 'VOIDED' });
    await expect(
      db.revenueLine.delete({ where: { id: uuid('revenueLine', man.id) } }),
    ).rejects.toThrow(/void/);
  });

  it('ตรวจค่า + สิทธิ์ + แยก tenant', async () => {
    const o = await order();
    // รายการบริการไม่พบ / ฝั่งซื้ออย่างเดียว → 422
    const bad = await addManual(o.pub, { serviceItemId: 'svc_' + '0'.repeat(32) }).expect(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'serviceItemId' });
    const buyOnly = await db.serviceItem.create({
      data: {
        tenantId,
        code: 'BUYONLY',
        nameTh: 'ค่าซื้ออย่างเดียว',
        vatType: 'VAT_7',
        whtRate: '1.00',
        calcUnit: 'PER_TRIP',
        unitLabel: 'เที่ยว',
        side: 'BUY',
      },
    });
    const side = await addManual(o.pub, {
      serviceItemId: encodeId('serviceItem', buyOnly.id),
    }).expect(422);
    expect(side.body.errors[0]).toMatchObject({ code: 'service_item_side' });
    // จำนวน/ราคา ผิด → 422
    await addManual(o.pub, { qty: '0' }).expect(422);
    await addManual(o.pub, { sellUnitPrice: '0' }).expect(422);
    await addManual(o.pub, { sellUnitPrice: '1.234' }).expect(422);
    const zero = await addManual(o.pub, { qty: '0.001', sellUnitPrice: '0.01' }).expect(422);
    expect(zero.body.errors[0]).toMatchObject({ code: 'amount_zero' });
    await addManual(o.pub, { reason: 'สั้น' }).expect(422);
    // DO ของใบสั่งอื่น → 422 · DO ที่ยกเลิก → 409
    const o2 = await order();
    const d2 = await deliveryOrder(o2.id);
    const wrong = await addManual(o.pub, { deliveryOrderId: d2.pub }).expect(422);
    expect(wrong.body.errors[0]).toMatchObject({ field: 'deliveryOrderId' });
    const dc = await deliveryOrder(o.id, 'CANCELLED');
    await addManual(o.pub, { deliveryOrderId: dc.pub }).expect(409);
    // DO ของใบสั่งนี้ + ข้อความเอง + ปัดครึ่งขึ้น (1.5 × 33.33 = 49.995 → 50.00)
    const d = await deliveryOrder(o.id);
    const ok = await addManual(o.pub, {
      deliveryOrderId: d.pub,
      qty: '1.5',
      sellUnitPrice: '33.33',
      description: 'ค่ายกของขึ้นชั้น 2',
    }).expect(201);
    expect(ok.body).toMatchObject({
      deliveryOrderId: d.pub,
      description: 'ค่ายกของขึ้นชั้น 2',
      qty: '1.5',
      sellAmount: '50.00',
    });

    // ไม่มีสิทธิ์แก้ราคาขาย → 403 · ไม่เห็นราคาขาย → ไม่มียอดในคำตอบ
    const noPriceWrite = await tokenFor(tenantId, 'orders:read orders:write prices.sell:read');
    await api(app, noPriceWrite)
      .post(`/v1/orders/${o.pub}/revenue-lines`)
      .send({ serviceItemId: await svcId('WAIT'), sellUnitPrice: '100', reason: REASON })
      .expect(403);
    await api(app, noPriceWrite)
      .post(`/v1/revenue-lines/${ok.body.id}/void`)
      .send({ reason: 'ไม่มีสิทธิ์ยกเลิกบรรทัด' })
      .expect(403);
    const noPriceRead = await tokenFor(tenantId, 'orders:read');
    const seen = await lines(o.pub, noPriceRead);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.sellAmount).toBeUndefined();
    expect(seen[0]!.sellUnitPrice).toBeUndefined();
    await api(app, await tokenFor(tenantId, 'trips:read'))
      .get(`/v1/orders/${o.pub}/revenue-lines`)
      .expect(403);

    // บริษัทอื่น → 404 (อ่าน/เพิ่ม/ยกเลิก)
    await api(app, other).get(`/v1/orders/${o.pub}/revenue-lines`).expect(404);
    await api(app, other)
      .post(`/v1/orders/${o.pub}/revenue-lines`)
      .send({ serviceItemId: await svcId('WAIT'), sellUnitPrice: '100', reason: REASON })
      .expect(404);
    await api(app, other)
      .post(`/v1/revenue-lines/${ok.body.id}/void`)
      .send({ reason: 'บริษัทอื่นพยายามยกเลิก' })
      .expect(404);

    // ใบสั่งที่ยกเลิก → บรรทัดทั้งหมด VOIDED (ไม่ลบ) · เพิ่ม/ยกเลิกบรรทัดไม่ได้ (409)
    const o3 = await order();
    const m3 = (await addManual(o3.pub).expect(201)).body as Line;
    await api(app, admin)
      .post(`/v1/orders/${o3.pub}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกคำสั่งทางอีเมล' })
      .expect(200);
    const c = await addManual(o3.pub).expect(409);
    expect(c.body.orderStatus).toBe('CANCELLED');
    const l3 = await lines(o3.pub);
    expect(l3).toHaveLength(2);
    for (const l of l3)
      expect(l).toMatchObject({
        status: 'VOIDED',
        voidReason: 'ยกเลิกใบสั่ง: ลูกค้ายกเลิกคำสั่งทางอีเมล',
      });
    const ca = await db.auditLog.findFirstOrThrow({
      where: { entityId: o3.id, action: 'sales_order.cancelled' },
    });
    expect(ca.after).toMatchObject({ revenueLinesVoided: 2 });
    const v3 = await api(app, admin)
      .post(`/v1/revenue-lines/${m3.id}/void`)
      .send({ reason: 'ยกเลิกหลังใบสั่งถูกยกเลิก' })
      .expect(409);
    expect(v3.body.orderStatus).toBe('CANCELLED');

    // audit ของบรรทัดที่เพิ่ม: ยอดเป็น field ราคา — ผู้ไม่มี prices.sell:read ไม่เห็น
    const auditOf = async (token: string) =>
      (
        (
          await api(app, token)
            .get(`/v1/audit-logs?entityType=sales_order&entityId=${o.id}&limit=100`)
            .expect(200)
        ).body.data as { action: string; after: Record<string, unknown> }[]
      ).find((x) => x.action === 'sales_order.revenue_line_added')!;
    const full = await auditOf(await tokenFor(tenantId, 'audit:read prices.sell:read'));
    expect(full.after).toMatchObject({ sellAmount: '50.00', sellUnitPrice: '33.33' });
    const masked = await auditOf(await tokenFor(tenantId, 'audit:read'));
    expect(masked.after.sellAmount).toBeUndefined();
    expect(masked.after.sellUnitPrice).toBeUndefined();
    expect(masked.after.description).toBe('ค่ายกของขึ้นชั้น 2');
  });
});
