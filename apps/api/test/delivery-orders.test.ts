import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST3-T09 ใบส่งของ (delivery_order): สร้างจาก SO (1 DO = ทั้ง SO), แยก (ปริมาณรวมเท่าเดิม), รวม, ยกเลิก + เหตุผล,
 * ห้ามจัดสรรเกิน (พร้อมกัน), SO แก้ → DO ชุดใหม่ (ORD-085), "DO อยู่ในเที่ยว" ล็อกทางเข้า, constraint, แยก tenant, call path
 */
describe('delivery orders (ST3-T09)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let seed = 0;
  let unitTon: string;
  let unitPallet: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const yymm = () => {
    const [y, m] = today.split('-');
    return `${String(Number(y) + 543).slice(-2)}${m}`;
  };

  async function company(tid: string) {
    const c = await db.company.create({
      data: {
        tenantId: tid,
        legalName: `บริษัท ผู้ออกบิล ${++seed}`,
        taxId: validTaxId(700 + seed),
      },
    });
    await db.branch.create({
      data: {
        tenantId: tid,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ส่งของ' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    unitPallet = uuid('unit', us.find((u) => u.code === 'PLT')!.id);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  /** ทำงานภายใต้ tenant ใน transaction ของตัวเอง (เหมือนคำขอ HTTP) */
  const run = <T>(fn: (tx: Tx) => Promise<T>, tid = tenantId) =>
    app
      .get(DbService)
      .withTenant(tid, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId: tid, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const svc = () => app.get(DeliveryOrderService);
  const upsert = (input: UpsertOrderInput, tid = tenantId) =>
    run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx), tid);
  const errOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const x = e as { code?: string; errors?: { field: string; code: string }[] };
      return { code: x.code, fields: x.errors?.map((f) => `${f.field}:${f.code}`) ?? [] };
    }
    throw new Error('expected failure');
  };

  const newSite = async () =>
    uuid(
      'site',
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({ name: `จุดรับส่ง ${++seed}`, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async () =>
    uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9500 + seed) })
          .expect(201)
      ).body.id,
    );
  const key = async () => ({
    customer: await newCustomer(),
    origin: await newSite(),
    dest: await newSite(),
  });
  type Key = Awaited<ReturnType<typeof key>>;
  const order = (k: Key, extra: Partial<UpsertOrderInput> = {}): UpsertOrderInput => ({
    source: 'MANUAL',
    customer: { id: k.customer },
    requestedDate: today,
    stops: [
      { type: 'PICKUP', siteId: k.origin },
      { type: 'DELIVERY', siteId: k.dest },
    ],
    lines: [
      { description: 'ปูนซีเมนต์', qty: '24', unitId: unitTon, weightKg: '24000' },
      { description: 'พาเลทไม้', qty: '10', unitId: unitPallet, weightKg: '100.5' },
    ],
    ...extra,
  });
  const activeDos = (salesOrderId: string) => run(() => svc().listForOrder(salesOrderId));
  const qtyOf = (
    dos: { lines: { soLineNo: number; qtyPlanned: { toFixed: () => string } }[] }[],
    no: number,
  ) =>
    dos
      .flatMap((d) => d.lines.filter((l) => l.soLineNo === no))
      .reduce((s, l) => s + Number(l.qtyPlanned.toFixed()), 0);
  const lineIds = async (salesOrderId: string) =>
    (await db.salesOrderLine.findMany({ where: { salesOrderId }, orderBy: { lineNo: 'asc' } })).map(
      (l) => l.id,
    );

  it('SO จุดส่งเดียวเข้าระบบ → DO 1 ใบ = ทั้ง SO (DRAFT, เลข DO, บรรทัดอ้างบรรทัด SO, ประวัติ/event/audit)', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k, { customerRef: 'PO-1001' }));
    expect(so.status).toBe('ON_HOLD'); // ไม่มี rate → RATE_MISSING แต่ข้อมูลพร้อมจัดส่ง
    const dos = await activeDos(so.id);
    expect(dos).toHaveLength(1);
    const d = dos[0]!;
    expect(d).toMatchObject({
      status: 'DRAFT',
      salesOrderId: so.id,
      customerId: k.customer,
      originSiteId: k.origin,
      destSiteId: k.dest,
      originStopSeq: 1,
      destStopSeq: 2,
      customerRef: 'PO-1001',
      tripId: null,
      splitIndex: null,
    });
    expect(d.doNo).toMatch(new RegExp(`^DO-${yymm()}-\\d{4}$`));
    expect(d.weightKg!.toFixed(3)).toBe('24100.500');
    const ids = await lineIds(so.id);
    expect(
      d.lines.map((l) => [
        l.lineNo,
        l.salesOrderLineId,
        l.soLineNo,
        l.qtyPlanned.toFixed(),
        l.unit,
      ]),
    ).toEqual([
      [1, ids[0], 1, '24', 'TON'],
      [2, ids[1], 2, '10', 'PLT'],
    ]);
    const alloc = await run(() => svc().allocation(so.id));
    expect(alloc.map((a) => [a.ordered, a.allocated, a.remaining])).toEqual([
      ['24', '24', '0'],
      ['10', '10', '0'],
    ]);
    const hist = await db.docStatusHistory.findMany({
      where: { docType: 'delivery_order', docId: d.id },
    });
    expect(hist.map((h) => [h.fromStatus, h.toStatus, h.event])).toEqual([
      ['NONE', 'DRAFT', 'create'],
    ]);
    const ev = await db.domainEvent.findFirst({
      where: { entityType: 'delivery_order', localId: d.id },
    });
    expect(ev).toMatchObject({ type: 'delivery_order.status_changed' });
    expect(JSON.stringify(ev!.snapshot)).not.toMatch(/price|amount|revenue/i);
    expect(
      await db.auditLog.count({ where: { action: 'delivery_order.created', entityId: d.id } }),
    ).toBe(1);

    // ส่งซ้ำค่าเดิม → ไม่สร้าง DO ใหม่ ไม่ยกเลิกใบเดิม
    await upsert({ ...order(k, { customerRef: 'PO-1001' }), id: so.id });
    const again = await activeDos(so.id);
    expect(again.map((x) => x.id)).toEqual([d.id]);
    expect(await db.deliveryOrder.count({ where: { salesOrderId: so.id } })).toBe(1);
  });

  it('เกณฑ์ตรวจรับ: แยก SO เป็น 2 DO แล้วปริมาณรวมเท่าเดิม · เลข DO-…-1/-2 · ใบแม่ยกเลิก (split) · แยกซ้ำต่อเลข', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k));
    const [parent] = await activeDos(so.id);
    const [l1, l2] = await lineIds(so.id);
    const kids = await run(() =>
      svc().split(parent!.id, [
        [
          { salesOrderLineId: l1!, qty: '12' },
          { salesOrderLineId: l2!, qty: '3' },
        ],
        [
          { salesOrderLineId: l1!, qty: '12' },
          { salesOrderLineId: l2!, qty: '7' },
        ],
      ]),
    );
    expect(kids.map((c) => [c.doNo, c.splitIndex, c.splitFromId, c.status])).toEqual([
      [`${parent!.doNo}-1`, 1, parent!.id, 'DRAFT'],
      [`${parent!.doNo}-2`, 2, parent!.id, 'DRAFT'],
    ]);
    const after = await activeDos(so.id);
    expect(after).toHaveLength(2);
    expect(qtyOf(after, 1)).toBe(24);
    expect(qtyOf(after, 2)).toBe(10);
    // น้ำหนักรวมเท่าเดิม (เศษไปใบสุดท้าย)
    expect(after.reduce((s, d) => s + Number(d.weightKg!.toFixed(3)), 0)).toBeCloseTo(24100.5, 3);
    expect(kids.map((c) => c.weightKg!.toFixed(3))).toEqual(['12030.150', '12070.350']);
    const p = await db.deliveryOrder.findUniqueOrThrow({ where: { id: parent!.id } });
    expect(p.status).toBe('CANCELLED');
    const h = await db.docStatusHistory.findFirstOrThrow({
      where: { docId: parent!.id, toStatus: 'CANCELLED' },
    });
    expect(h).toMatchObject({ fromStatus: 'DRAFT', event: 'split' });
    expect(h.note).toContain(`${parent!.doNo}-2`);
    expect(
      await db.auditLog.count({ where: { action: 'delivery_order.split', entityId: parent!.id } }),
    ).toBe(1);
    const alloc = await run(() => svc().allocation(so.id));
    expect(alloc.map((a) => a.remaining)).toEqual(['0', '0']);

    // แยกใบลูกต่อ → เลขต่อจากแม่เดียวกัน (-3, -4)
    const more = await run(() =>
      svc().split(kids[1]!.id, [
        [{ salesOrderLineId: l1!, qty: '12' }],
        [{ salesOrderLineId: l2!, qty: '7' }],
      ]),
    );
    expect(more.map((c) => c.doNo)).toEqual([`${parent!.doNo}-3`, `${parent!.doNo}-4`]);
    expect(more.every((c) => c.splitRootNo === parent!.doNo && c.splitFromId === kids[1]!.id)).toBe(
      true,
    );
    const all = await activeDos(so.id);
    expect(qtyOf(all, 1)).toBe(24);
    expect(qtyOf(all, 2)).toBe(10);

    // ปริมาณไม่เท่า / ใบที่ยกเลิกแล้ว → ปฏิเสธ ไม่มีอะไรเปลี่ยน
    expect(
      await errOf(
        run(() =>
          svc().split(kids[0]!.id, [
            [{ salesOrderLineId: l1!, qty: '6' }],
            [
              { salesOrderLineId: l1!, qty: '5.999' },
              { salesOrderLineId: l2!, qty: '3', unit: 'KG' },
            ],
          ]),
        ),
      ),
    ).toEqual({
      code: 'validation_failed',
      fields: [
        'parts[1][1].unit:unit_mismatch',
        'lines.1:qty_not_conserved',
        'lines.2:qty_not_conserved',
      ],
    });
    expect(
      await errOf(
        run(() =>
          svc().split(parent!.id, [
            [{ salesOrderLineId: l1!, qty: '12' }],
            [{ salesOrderLineId: l1!, qty: '12' }],
          ]),
        ),
      ),
    ).toMatchObject({ code: 'invalid_state_transition' });
    expect(await db.deliveryOrder.count({ where: { salesOrderId: so.id } })).toBe(5);
  });

  it('รวม DO ของ SO + จุดส่งเดียวกันกลับเป็นใบเดียว (ORD-086) · ต่าง SO/จุดส่ง → 422', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k));
    const [parent] = await activeDos(so.id);
    const [l1, l2] = await lineIds(so.id);
    const [a, b] = await run(() =>
      svc().split(parent!.id, [
        [{ salesOrderLineId: l1!, qty: '10' }],
        [
          { salesOrderLineId: l1!, qty: '14' },
          { salesOrderLineId: l2!, qty: '10' },
        ],
      ]),
    );
    const merged = await run(() => svc().merge([a!.id, b!.id]));
    expect(merged.id).toBe(a!.id);
    expect(merged.lines.map((l) => [l.soLineNo, l.qtyPlanned.toFixed(), l.unit])).toEqual([
      [1, '24', 'TON'],
      [2, '10', 'PLT'],
    ]);
    expect(merged.weightKg!.toFixed(3)).toBe('24100.500');
    expect(merged.version).toBe(a!.version + 1);
    const bAfter = await db.deliveryOrder.findUniqueOrThrow({ where: { id: b!.id } });
    expect(bAfter.status).toBe('CANCELLED');
    expect(
      await db.docStatusHistory.findFirstOrThrow({
        where: { docId: b!.id, toStatus: 'CANCELLED' },
      }),
    ).toMatchObject({ event: 'merge', note: `รวมเข้า ${a!.doNo}` });
    expect(
      await db.auditLog.count({ where: { action: 'delivery_order.merged', entityId: a!.id } }),
    ).toBe(1);
    expect((await activeDos(so.id)).map((d) => d.id)).toEqual([a!.id]);

    // ต่าง SO
    const k2 = await key();
    const { order: so2 } = await upsert(order(k2));
    const [x] = await activeDos(so2.id);
    expect(await errOf(run(() => svc().merge([a!.id, x!.id])))).toEqual({
      code: 'validation_failed',
      fields: ['deliveryOrderIds[1]:different_order'],
    });
    // ต่างจุดส่ง (SO สองจุดส่ง)
    const k3 = await key();
    const drop2 = await newSite();
    const { order: so3 } = await upsert(
      order(k3, {
        stops: [
          { type: 'PICKUP', siteId: k3.origin },
          { type: 'DELIVERY', siteId: k3.dest },
          { type: 'DELIVERY', siteId: drop2 },
        ],
      }),
    );
    const [m1, m2] = await lineIds(so3.id);
    const d1 = await run(() =>
      svc().createFromOrder(so3.id, {
        destStopSeq: 2,
        lines: [{ salesOrderLineId: m1!, qty: '24' }],
      }),
    );
    const d2 = await run(() => svc().createFromOrder(so3.id, { destStopSeq: 3 }));
    expect(d2.lines.map((l) => [l.salesOrderLineId, l.qtyPlanned.toFixed()])).toEqual([[m2, '10']]);
    expect(await errOf(run(() => svc().merge([d1.id, d2.id])))).toEqual({
      code: 'validation_failed',
      fields: ['deliveryOrderIds[1]:different_drop'],
    });
    expect(await errOf(run(() => svc().merge([d1.id, d1.id])))).toMatchObject({
      fields: ['deliveryOrderIds:too_few'],
    });
  });

  it('SO หลายจุดส่ง: ไม่สร้าง DO อัตโนมัติ · ต้องเลือกจุดส่ง · จัดสรรเกินคงเหลือไม่ได้ · หน่วยต้องตรง', async () => {
    const k = await key();
    const drop2 = await newSite();
    const { order: so } = await upsert(
      order(k, {
        stops: [
          { type: 'PICKUP', siteId: k.origin },
          { type: 'DELIVERY', siteId: k.dest },
          { type: 'DELIVERY', siteId: drop2 },
        ],
      }),
    );
    expect(await activeDos(so.id)).toEqual([]);
    const [l1, l2] = await lineIds(so.id);
    expect(await errOf(run(() => svc().createFromOrder(so.id)))).toEqual({
      code: 'validation_failed',
      fields: ['destStopSeq:required'],
    });
    expect(await errOf(run(() => svc().createFromOrder(so.id, { destStopSeq: 1 })))).toMatchObject({
      fields: ['destStopSeq:invalid_stop'],
    });
    const first = await run(() =>
      svc().createFromOrder(so.id, {
        destStopSeq: 2,
        lines: [
          { salesOrderLineId: l1!, qty: '16.5', unit: 'TON' },
          { salesOrderLineId: l2!, qty: '4' },
        ],
      }),
    );
    expect(first).toMatchObject({ destStopSeq: 2, destSiteId: k.dest, originStopSeq: 1 });
    expect(first.weightKg!.toFixed(3)).toBe('16540.200');
    expect(
      await errOf(
        run(() =>
          svc().createFromOrder(so.id, {
            destStopSeq: 3,
            lines: [
              { salesOrderLineId: l1!, qty: '7.501' },
              { salesOrderLineId: l2!, qty: '1', unit: 'TON' },
            ],
          }),
        ),
      ),
    ).toEqual({
      code: 'validation_failed',
      fields: ['lines[1].unit:unit_mismatch', 'lines[0].qty:over_allocated'],
    });
    const rest = await run(() => svc().createFromOrder(so.id, { destStopSeq: 3 }));
    expect(
      rest.lines.map((l) => [l.soLineNo, l.qtyPlanned.toFixed(), l.weightKg?.toFixed(3)]),
    ).toEqual([
      [1, '7.5', '7500.000'],
      [2, '6', '60.300'],
    ]);
    expect(await errOf(run(() => svc().createFromOrder(so.id, { destStopSeq: 3 })))).toMatchObject({
      fields: ['lines:fully_allocated'],
    });
    // ยกเลิกแล้วปริมาณคืนให้จัดสรรใหม่ได้
    await run(() => svc().cancel(rest.id, { note: 'ลูกค้าขอเลื่อนส่งจุดที่สอง' }));
    const alloc = await run(() => svc().allocation(so.id));
    expect(alloc.map((a) => a.remaining)).toEqual(['7.5', '6']);
  });

  it('ยกเลิก: เหตุผล ≥ 10 ตัวอักษร + reason code หมวด CANCEL · ลง audit · ยกเลิกซ้ำ 409', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k));
    const [d] = await activeDos(so.id);
    expect(await errOf(run(() => svc().cancel(d!.id, { note: ' สั้นไป ' })))).toEqual({
      code: 'validation_failed',
      fields: ['note:too_short'],
    });
    const hold = await db.reasonCode.findFirstOrThrow({
      where: { tenantId, category: 'ORDER_HOLD' },
    });
    expect(
      await errOf(
        run(() => svc().cancel(d!.id, { note: 'ลูกค้ายกเลิกงานนี้แล้ว', reasonCodeId: hold.id })),
      ),
    ).toMatchObject({ fields: ['reasonCodeId:invalid_reference'] });
    const rc = await db.reasonCode.findFirst({
      where: { tenantId, category: 'CANCEL', status: 'ACTIVE' },
    });
    const out = await run(() =>
      svc().cancel(d!.id, { note: 'ลูกค้ายกเลิกงานนี้แล้ว', reasonCodeId: rc?.id ?? null }),
    );
    expect(out.status).toBe('CANCELLED');
    expect(
      await db.auditLog.findFirstOrThrow({
        where: { action: 'delivery_order.cancelled', entityId: d!.id },
      }),
    ).toMatchObject({ reason: 'ลูกค้ายกเลิกงานนี้แล้ว' });
    expect(
      await db.docStatusHistory.findFirstOrThrow({
        where: { docId: d!.id, toStatus: 'CANCELLED' },
      }),
    ).toMatchObject({ event: 'cancel', reasonCodeId: rc?.id ?? null });
    expect(
      await errOf(run(() => svc().cancel(d!.id, { note: 'ลูกค้ายกเลิกงานนี้แล้ว' }))),
    ).toMatchObject({
      code: 'invalid_state_transition',
    });
    // สร้างใหม่จากคงเหลือได้
    const again = await run(() => svc().createFromOrder(so.id));
    expect(again.lines.map((l) => l.qtyPlanned.toFixed())).toEqual(['24', '10']);
  });

  it('SO ยังไม่พร้อม (ร่าง / ลูกค้าไม่รู้จัก) → ไม่มี DO และสร้างไม่ได้ · จับคู่แล้ว (ส่งใหม่) → DO เกิด', async () => {
    const k = await key();
    const { order: draft } = await upsert(order(k, { draft: true }));
    expect(await activeDos(draft.id)).toEqual([]);
    expect(await errOf(run(() => svc().createFromOrder(draft.id)))).toMatchObject({
      code: 'order_not_ready_for_delivery',
    });
    const ext = `CUS-${randomUUID().slice(0, 8)}`;
    const { order: un } = await upsert(
      order(k, {
        source: 'API',
        externalId: `EXT-${ext}`,
        customer: { externalId: ext, text: 'ลูกค้าใหม่' },
      }),
    );
    expect(un.holdReasonCode?.code).toBe('CUSTOMER_UNMAPPED');
    expect(await activeDos(un.id)).toEqual([]);
    expect(await errOf(run(() => svc().createFromOrder(un.id)))).toMatchObject({
      code: 'order_not_ready_for_delivery',
    });
    // reevaluate ข้อมูลเดิม = ยังค้าง → ไม่มี DO; ต้นทางส่งใหม่พร้อมลูกค้าที่จับคู่ได้ → DO เกิด
    await run((tx) => app.get(OrderIntakeService).reevaluate(un.id, tx));
    expect(await activeDos(un.id)).toEqual([]);
    await db.customer.update({ where: { id: k.customer }, data: { externalId: ext } });
    const { order: mapped } = await upsert(
      order(k, { source: 'API', externalId: `EXT-${ext}`, customer: { externalId: ext } }),
    );
    expect(mapped.customerId).toBe(k.customer);
    expect(await activeDos(un.id)).toHaveLength(1);
  });

  it('SO แก้ข้อมูลที่ DO ใช้ → DO ชุดเดิม (รวมใบที่แยก) ยกเลิกแล้วสร้างใหม่ (ORD-085) · ลดบรรทัดสินค้าได้ (FK RESTRICT + ปลดใบที่ยกเลิก)', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k));
    const [d] = await activeDos(so.id);
    const [l1, l2] = await lineIds(so.id);
    await run(() =>
      svc().split(d!.id, [
        [{ salesOrderLineId: l1!, qty: '24' }],
        [{ salesOrderLineId: l2!, qty: '10' }],
      ]),
    );
    // แก้เฉพาะหมายเหตุ/ราคา (ไม่กระทบ DO) — customerRef อยู่ใน DO จึงใช้ sourceIssues ไม่ได้; ใช้ rawPayload ซึ่งไม่อยู่ใน hash
    await upsert({ ...order(k), id: so.id, rawPayload: { note: 'x' } });
    expect((await activeDos(so.id)).map((x) => x.splitIndex)).toEqual([1, 2]);

    await upsert({
      ...order(k, {
        lines: [{ description: 'ปูนซีเมนต์', qty: '30', unitId: unitTon, weightKg: '30000' }],
      }),
      id: so.id,
    });
    const now = await activeDos(so.id);
    expect(now).toHaveLength(1);
    expect(now[0]!.splitIndex).toBeNull();
    expect(now[0]!.lines.map((l) => [l.salesOrderLineId, l.qtyPlanned.toFixed()])).toEqual([
      [l1, '30'],
    ]);
    const old = await db.deliveryOrder.findMany({
      where: { salesOrderId: so.id, status: 'CANCELLED' },
      include: { lines: true },
    });
    expect(old).toHaveLength(3);
    // บรรทัด SO ที่ 2 ถูกลบ → บรรทัด DO ที่ยกเลิกแล้วเหลือ snapshot (ไม่อ้างบรรทัดที่หาย)
    const detached = old.flatMap((o) => o.lines).filter((l) => l.soLineNo === 2);
    expect(detached.length).toBeGreaterThan(0);
    expect(detached.every((l) => l.salesOrderLineId === null && l.description === 'พาเลทไม้')).toBe(
      true,
    );
    expect(await db.salesOrderLine.count({ where: { id: l2! } })).toBe(0);
    const notes = await db.docStatusHistory.findMany({
      where: { docType: 'delivery_order', docId: { in: old.map((o) => o.id) }, event: 'cancel' },
    });
    expect(notes.length).toBe(2);
    expect(notes.every((n) => /ORD-085/.test(n.note ?? ''))).toBe(true);
    expect(
      await db.auditLog.count({
        where: { action: 'delivery_order.cancelled', entityId: { in: old.map((o) => o.id) } },
      }),
    ).toBe(2);
  });

  it('จัดสรรพร้อมกัน 6 คำขอ (ล็อก SO) → รวมไม่เกินที่สั่ง', async () => {
    const k = await key();
    const { order: so } = await upsert(
      order(k, { lines: [{ description: 'ทราย', qty: '12', unitId: unitTon }] }),
    );
    const [d] = await activeDos(so.id);
    await run(() => svc().cancel(d!.id, { note: 'แบ่งส่งหลายคันแทน' }));
    const [l1] = await lineIds(so.id);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        run(() => svc().createFromOrder(so.id, { lines: [{ salesOrderLineId: l1!, qty: '5' }] })),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'validation_failed' });
    expect((await run(() => svc().allocation(so.id)))[0]).toMatchObject({
      allocated: '10',
      remaining: '2',
    });
    const nos = (await activeDos(so.id)).map((x) => x.doNo);
    expect(new Set(nos).size).toBe(2);
  });

  it('DO อยู่ในเที่ยว (trip ที่ไม่ยกเลิก) → ทางเข้าแก้ SO ไม่ได้ (409) และแยก/รวม/ยกเลิกไม่ได้ · trip ยกเลิก → ปลดล็อก', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k));
    const [d] = await activeDos(so.id);
    const [l1, l2] = await lineIds(so.id);
    const trip = await db.trip.create({
      data: { tenantId, tripNo: `TRP-DO-${++seed}`, tripDate: new Date(`${today}T00:00:00Z`) },
    });
    await db.deliveryOrder.update({ where: { id: d!.id }, data: { tripId: trip.id } });
    expect(await run((tx) => svc().hasDoOnTrip(tx, so.id))).toBe(true);
    expect(
      await errOf(upsert({ ...order(k, { lines: [order(k).lines![0]!] }), id: so.id })),
    ).toMatchObject({ code: 'order_locked_for_update' });
    expect(
      await errOf(
        run(() =>
          svc().split(d!.id, [
            [{ salesOrderLineId: l1!, qty: '24' }],
            [{ salesOrderLineId: l2!, qty: '10' }],
          ]),
        ),
      ),
    ).toMatchObject({ code: 'delivery_order_on_trip' });
    expect(
      await errOf(run(() => svc().cancel(d!.id, { note: 'ลูกค้ายกเลิกงานนี้แล้ว' }))),
    ).toMatchObject({
      code: 'delivery_order_on_trip',
    });
    await db.trip.update({
      where: { id: trip.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'ยกเลิกเที่ยวทดสอบ' },
    });
    expect(await run((tx) => svc().hasDoOnTrip(tx, so.id))).toBe(false);
  });

  it('constraint ในฐานข้อมูล: ปริมาณ > 0, พ้น DRAFT ต้องมีเที่ยว, มีเลขเสมอ, FK RESTRICT บรรทัด SO, tms_app ลบ DO ไม่ได้', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k));
    const [d] = await activeDos(so.id);
    const line = d!.lines[0]!;
    await expect(
      db.$executeRaw`UPDATE delivery_order_line SET qty_planned = 0 WHERE id = ${line.id}::uuid`,
    ).rejects.toThrow(/delivery_order_line_values/);
    await expect(
      db.$executeRaw`UPDATE delivery_order SET status = 'PLANNED' WHERE id = ${d!.id}::uuid`,
    ).rejects.toThrow(/delivery_order_trip/);
    await expect(
      db.$executeRaw`UPDATE delivery_order SET do_no = NULL WHERE id = ${d!.id}::uuid`,
    ).rejects.toThrow(/delivery_order_number/);
    await expect(
      db.$executeRaw`UPDATE delivery_order SET split_index = 1 WHERE id = ${d!.id}::uuid`,
    ).rejects.toThrow(/delivery_order_split/);
    await expect(
      db.$executeRaw`DELETE FROM sales_order_line WHERE id = ${line.salesOrderLineId}::uuid`,
    ).rejects.toThrow(/foreign key/i);
    const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
    try {
      for (const sql of [
        `DELETE FROM delivery_order_line WHERE id = '${line.id}'`,
        `DELETE FROM delivery_order WHERE id = '${d!.id}'`,
      ])
        await expect(
          appDb.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
            await tx.$executeRawUnsafe(sql);
          }),
        ).rejects.toThrow(/permission denied/);
    } finally {
      await appDb.$disconnect();
    }
  });

  it('แยก tenant: DO / SO ของ tenant อื่น = ไม่พบ (RLS)', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k));
    const [d] = await activeDos(so.id);
    const [l1] = await lineIds(so.id);
    expect(await run(() => svc().listForOrder(so.id), otherId)).toEqual([]);
    for (const p of [
      () => run(() => svc().get(d!.id), otherId),
      () => run(() => svc().cancel(d!.id, { note: 'ลองยกเลิกข้าม tenant' }), otherId),
      () =>
        run(
          () =>
            svc().split(d!.id, [
              [{ salesOrderLineId: l1!, qty: '1' }],
              [{ salesOrderLineId: l1!, qty: '23' }],
            ]),
          otherId,
        ),
      () => run(() => svc().createFromOrder(so.id), otherId),
    ])
      expect(await errOf(p())).toMatchObject({ code: 'not_found' });
    expect(await errOf(run(() => svc().merge([d!.id, randomUUID()]), otherId))).toMatchObject({
      code: 'not_found',
    });
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: d!.id } })).status).toBe(
      'DRAFT',
    );
  });

  it('คนยกเลิก DO แล้วต้นทางส่งซ้ำค่าเดิม / reevaluate → DO ไม่ฟื้น · ข้อมูลจัดสรรเปลี่ยน → ชุดใหม่', async () => {
    const k = await key();
    const input = order(k, { source: 'API', externalId: `RESEND-${randomUUID().slice(0, 8)}` });
    const { order: so } = await upsert(input);
    const [d] = await activeDos(so.id);
    await run(() => svc().cancel(d!.id, { note: 'ลูกค้าแจ้งยกเลิกรอบนี้' }));
    await upsert(input);
    await run((tx) => app.get(OrderIntakeService).reevaluate(so.id, tx));
    expect(await activeDos(so.id)).toEqual([]);
    expect(await db.deliveryOrder.count({ where: { salesOrderId: so.id } })).toBe(1);
    // ปริมาณเปลี่ยน = ข้อมูลชุดใหม่ → สร้าง DO ให้ใหม่
    await upsert({
      ...input,
      lines: [{ description: 'ปูนซีเมนต์', qty: '20', unitId: unitTon, weightKg: '20000' }],
    });
    const now = await activeDos(so.id);
    expect(now.map((x) => x.lines.map((l) => l.qtyPlanned.toFixed()))).toEqual([['20']]);
  });

  it('ข้อมูลหัว (PO ลูกค้า วันที่ ชื่อสินค้า) เปลี่ยน → แก้ใน DO เดิม ไม่ยกเลิกใบที่แยกไว้', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k, { customerRef: 'PO-A' }));
    const [d] = await activeDos(so.id);
    const [l1, l2] = await lineIds(so.id);
    const kids = await run(() =>
      svc().split(d!.id, [
        [{ salesOrderLineId: l1!, qty: '24' }],
        [{ salesOrderLineId: l2!, qty: '10' }],
      ]),
    );
    const next = new Date(Date.parse(`${today}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
    const base = order(k);
    await upsert({
      ...base,
      id: so.id,
      customerRef: 'PO-B',
      requestedDate: next,
      stops: [
        { type: 'PICKUP', siteId: k.origin, windowStart: `${next}T08:00:00+07:00` },
        { type: 'DELIVERY', siteId: k.dest },
      ],
      lines: [{ ...base.lines![0]!, description: 'ปูนซีเมนต์ถุง' }, base.lines![1]!],
    });
    const now = await activeDos(so.id);
    expect(now.map((x) => x.id).sort()).toEqual(kids.map((x) => x.id).sort());
    for (const x of now) {
      expect(x.customerRef).toBe('PO-B');
      expect(x.doDate.toISOString().slice(0, 10)).toBe(next);
      expect(x.version).toBe(2);
    }
    expect(now.flatMap((x) => x.lines.map((l) => l.description)).sort()).toEqual([
      'ปูนซีเมนต์ถุง',
      'พาเลทไม้',
    ]);
    expect(
      await db.auditLog.count({
        where: { action: 'delivery_order.updated', entityId: { in: kids.map((x) => x.id) } },
      }),
    ).toBe(2);
  });

  it('SO หลายจุดส่งถูกแก้จนต้องสร้าง DO ใหม่ → ยกเลิกชุดเดิม + event delivery_order.rebuild_required', async () => {
    const k = await key();
    const drop2 = await newSite();
    const input = order(k, {
      stops: [
        { type: 'PICKUP', siteId: k.origin },
        { type: 'DELIVERY', siteId: k.dest },
        { type: 'DELIVERY', siteId: drop2 },
      ],
    });
    const { order: so } = await upsert(input);
    const a = await run(() => svc().createFromOrder(so.id, { destStopSeq: 2 }));
    await upsert({
      ...input,
      id: so.id,
      lines: [{ description: 'ปูนซีเมนต์', qty: '30', unitId: unitTon }, input.lines![1]!],
    });
    expect(await activeDos(so.id)).toEqual([]);
    const ev = await db.domainEvent.findFirstOrThrow({
      where: { type: 'delivery_order.rebuild_required', localId: so.id },
    });
    expect(ev).toMatchObject({ entityType: 'sales_order' });
    expect(ev.snapshot).toEqual({ cancelled: [a.doNo], reason: 'MULTI_DROP' });
  });

  it('ข้อมูลหลักปิดใช้ (ค้าง CUSTOMER_UNMAPPED) → คง DO ที่คนแยกไว้ แต่สร้างใหม่ไม่ได้ · ค้าง SOURCE_ERROR ไม่สร้าง DO', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k));
    const [d] = await activeDos(so.id);
    const [l1, l2] = await lineIds(so.id);
    const kids = await run(() =>
      svc().split(d!.id, [
        [{ salesOrderLineId: l1!, qty: '24' }],
        [{ salesOrderLineId: l2!, qty: '10' }],
      ]),
    );
    await db.customer.update({ where: { id: k.customer }, data: { status: 'INACTIVE' } });
    const r = await run((tx) => app.get(OrderIntakeService).reevaluate(so.id, tx));
    expect(r.order.holdReasonCode?.code).toBe('CUSTOMER_UNMAPPED');
    expect((await activeDos(so.id)).map((x) => x.id).sort()).toEqual(kids.map((x) => x.id).sort());
    expect(await run(() => svc().isOrderReady(so.id))).toBe(false);
    await run(() => svc().cancel(kids[1]!.id, { note: 'ทดสอบสร้างใหม่ตอนค้าง' }));
    expect(await errOf(run(() => svc().createFromOrder(so.id)))).toMatchObject({
      code: 'order_not_ready_for_delivery',
    });
    await db.customer.update({ where: { id: k.customer }, data: { status: 'ACTIVE' } });

    const k2 = await key();
    const { order: bad } = await upsert(
      order(k2, {
        source: 'ERP:krs',
        externalId: `SRCERR-${randomUUID().slice(0, 8)}`,
        sourceIssues: ['ไม่มีน้ำหนักสินค้า'],
      }),
    );
    expect(bad.holdReasonCode?.code).toBe('SOURCE_ERROR');
    expect(await activeDos(bad.id)).toEqual([]);
  });

  it('trip ที่ยกเลิกแล้วแม้ trip_id ค้าง = ไม่อยู่ในเที่ยว (นิยามเดียวกันทุกจุด) → แยก/ยกเลิกได้', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k));
    const [d] = await activeDos(so.id);
    const [l1, l2] = await lineIds(so.id);
    const trip = await db.trip.create({
      data: {
        tenantId,
        tripNo: `TRP-DO-${++seed}`,
        tripDate: new Date(`${today}T00:00:00Z`),
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: 'ยกเลิกเที่ยวทดสอบ',
      },
    });
    await db.deliveryOrder.update({ where: { id: d!.id }, data: { tripId: trip.id } });
    expect(await run((tx) => svc().hasDoOnTrip(tx, so.id))).toBe(false);
    // ทางเข้าแก้ SO ได้ (ไม่ถูกล็อก) และ sync ไม่ข้าม DO ใบนี้
    await upsert({ ...order(k), id: so.id, customerRef: 'PO-TRIP' });
    expect((await activeDos(so.id))[0]!.customerRef).toBe('PO-TRIP');
    const kids = await run(() =>
      svc().split(d!.id, [
        [{ salesOrderLineId: l1!, qty: '24' }],
        [{ salesOrderLineId: l2!, qty: '10' }],
      ]),
    );
    expect(kids).toHaveLength(2);
  });

  it('API /v1/delivery-orders: list (กรอง SO/สถานะ/ลูกค้า/วันที่) · get + ETag · สร้าง · แยก (If-Match) · รวม · ยกเลิก · สิทธิ์', async () => {
    const k = await key();
    const { order: so } = await upsert(order(k));
    const ord = `ord_${so.id.replace(/-/g, '')}`;
    const cus = `cus_${k.customer.replace(/-/g, '')}`;
    const list = await api(app, admin)
      .get(
        `/v1/delivery-orders?orderId=${ord}&status=DRAFT&customerId=${cus}&dateFrom=${today}&dateTo=${today}`,
      )
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    const d = list.body.data[0];
    expect(d).toMatchObject({ orderId: ord, customerId: cus, status: 'DRAFT', destStopSeq: 2 });
    expect(d.id).toMatch(/^do_[0-9a-f]{32}$/);
    expect(JSON.stringify(d)).not.toMatch(/revenue|sellRate|amount/i);
    expect(
      (await api(app, admin).get(`/v1/delivery-orders?orderId=${ord}&status=CANCELLED`).expect(200))
        .body.data,
    ).toEqual([]);
    const one = await api(app, admin).get(`/v1/delivery-orders/${d.id}`).expect(200);
    expect(one.headers.etag).toBe(`"${d.version}"`);
    expect(
      one.body.lines.map((l: { soLineNo: number; qtyPlanned: string }) => [
        l.soLineNo,
        l.qtyPlanned,
      ]),
    ).toEqual([
      [1, '24'],
      [2, '10'],
    ]);

    const parts = {
      parts: [
        {
          lines: [
            { soLineNo: 1, qty: '12' },
            { soLineNo: 2, qty: '4' },
          ],
        },
        {
          lines: [
            { soLineNo: 1, qty: '12' },
            { soLineNo: 2, qty: '6' },
          ],
        },
      ],
    };
    await api(app, admin)
      .post(`/v1/delivery-orders/${d.id}/split`)
      .set('If-Match', '"99"')
      .send(parts)
      .expect(412);
    const bad = await api(app, admin)
      .post(`/v1/delivery-orders/${d.id}/split`)
      .send({
        parts: [{ lines: [{ soLineNo: 1, qty: '12' }] }, { lines: [{ soLineNo: 9, qty: 1 }] }],
      })
      .expect(422);
    expect(bad.body.code).toBe('validation_failed');
    const split = await api(app, admin)
      .post(`/v1/delivery-orders/${d.id}/split`)
      .set('If-Match', `"${d.version}"`)
      .send(parts)
      .expect(200);
    const [a, b] = split.body.data;
    expect([a.doNo, b.doNo]).toEqual([`${d.doNo}-1`, `${d.doNo}-2`]);
    expect(a.splitFromId).toBe(d.id);

    const merged = await api(app, admin)
      .post(`/v1/delivery-orders/${a.id}/merge`)
      .send({ deliveryOrderIds: [b.id] })
      .expect(200);
    expect(merged.body.lines.map((l: { qtyPlanned: string }) => l.qtyPlanned)).toEqual([
      '24',
      '10',
    ]);
    expect(merged.headers.etag).toBe(`"${merged.body.version}"`);

    await api(app, admin)
      .post(`/v1/delivery-orders/${a.id}/cancel`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const viewer = await tokenFor(tenantId, 'orders:read');
    await api(app, viewer)
      .post(`/v1/delivery-orders/${a.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกรอบนี้' })
      .expect(403);
    await api(app, viewer).post(`/v1/delivery-orders/${a.id}/split`).send(parts).expect(403);
    await api(app, viewer).get(`/v1/delivery-orders/${a.id}`).expect(200);
    const cancelled = await api(app, admin)
      .post(`/v1/delivery-orders/${a.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกรอบนี้' })
      .expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    await api(app, admin)
      .post(`/v1/delivery-orders/${a.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกรอบนี้' })
      .expect(409);

    // สร้างจาก SO: ห้ามเกินคงเหลือ · SO ไม่พบ → 422
    const over = await api(app, admin)
      .post('/v1/delivery-orders')
      .send({ orderId: ord, lines: [{ soLineNo: 1, qty: '25' }] })
      .expect(422);
    expect(over.body.errors.map((e: { code: string }) => e.code)).toEqual(['over_allocated']);
    const created = await api(app, admin)
      .post('/v1/delivery-orders')
      .send({ orderId: ord, lines: [{ soLineNo: 1, qty: '20' }] })
      .expect(201);
    expect(created.body.lines.map((l: { qtyPlanned: string }) => l.qtyPlanned)).toEqual(['20']);
    await api(app, admin)
      .post('/v1/delivery-orders')
      .send({ orderId: `ord_${'0'.repeat(32)}` })
      .expect(422);
    const otherTok = await tokenFor(otherId);
    await api(app, otherTok).post('/v1/delivery-orders').send({ orderId: ord }).expect(422);
    expect(
      (await api(app, otherTok).get(`/v1/delivery-orders?orderId=${ord}`).expect(200)).body.data,
    ).toEqual([]);
  });

  it('QA B1: แยกแล้วเปลี่ยนจุดส่งแล้วเปลี่ยนกลับ → มี DO 1 ใบ (ใบที่ถูกแยก/รวม/ระบบยกเลิกไม่กันการสร้าง)', async () => {
    const k = await key();
    const other = await newSite();
    const { order: so } = await upsert(order(k));
    const [d] = await activeDos(so.id);
    const [l1, l2] = await lineIds(so.id);
    const [a, b] = await run(() =>
      svc().split(d!.id, [
        [{ salesOrderLineId: l1!, qty: '12' }],
        [
          { salesOrderLineId: l1!, qty: '12' },
          { salesOrderLineId: l2!, qty: '10' },
        ],
      ]),
    );
    await run(() => svc().merge([a!.id, b!.id]));
    const moved = {
      ...order(k),
      id: so.id,
      stops: [
        { type: 'PICKUP' as const, siteId: k.origin },
        { type: 'DELIVERY' as const, siteId: other },
      ],
    };
    await upsert(moved);
    expect((await activeDos(so.id)).map((x) => x.destSiteId)).toEqual([other]);
    await upsert({ ...order(k), id: so.id });
    const back = await activeDos(so.id);
    expect(back).toHaveLength(1);
    expect(back[0]!.destSiteId).toBe(k.dest);
    expect(back[0]!.lines.map((l) => l.qtyPlanned.toFixed())).toEqual(['24', '10']);
  });

  it('QA B2: ต้นทางลดบรรทัดสินค้า → DO ถูกยกเลิกก่อน sync แต่ยังได้ event rebuild_required (หลายจุดส่ง / ลูกค้าปิดใช้)', async () => {
    const k = await key();
    const drop2 = await newSite();
    const multi = order(k, {
      stops: [
        { type: 'PICKUP', siteId: k.origin },
        { type: 'DELIVERY', siteId: k.dest },
        { type: 'DELIVERY', siteId: drop2 },
      ],
    });
    const { order: so } = await upsert(multi);
    const x = await run(() => svc().createFromOrder(so.id, { destStopSeq: 2 }));
    await upsert({ ...multi, id: so.id, lines: [multi.lines![0]!] });
    expect(await activeDos(so.id)).toEqual([]);
    expect(
      (
        await db.domainEvent.findFirstOrThrow({
          where: { type: 'delivery_order.rebuild_required', localId: so.id },
        })
      ).snapshot,
    ).toEqual({ cancelled: [x.doNo], reason: 'MULTI_DROP' });

    const k2 = await key();
    const { order: so2 } = await upsert(order(k2));
    const [y] = await activeDos(so2.id);
    await db.customer.update({ where: { id: k2.customer }, data: { status: 'INACTIVE' } });
    const r = await upsert({ ...order(k2), id: so2.id, lines: [order(k2).lines![0]!] });
    expect(r.order.holdReasonCode?.code).toBe('CUSTOMER_UNMAPPED');
    expect(await activeDos(so2.id)).toEqual([]);
    expect(
      (
        await db.domainEvent.findFirstOrThrow({
          where: { type: 'delivery_order.rebuild_required', localId: so2.id },
        })
      ).snapshot,
    ).toEqual({ cancelled: [y!.doNo], reason: 'ORDER_NOT_READY' });
    await db.customer.update({ where: { id: k2.customer }, data: { status: 'ACTIVE' } });
  });

  it('QA B3: list วันที่ที่ไม่มีจริง → 422 (ไม่ใช่ 500/ปัดเดือน)', async () => {
    for (const v of ['2026-13-45', '0000-00-00', '2026-02-31']) {
      const r = await api(app, admin).get(`/v1/delivery-orders?dateFrom=${v}`).expect(422);
      expect(
        r.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`),
      ).toEqual(['dateFrom:invalid_date']);
    }
    await api(app, admin).get('/v1/delivery-orders?dateTo=2026-02-30').expect(422);
    await api(app, admin)
      .get('/v1/delivery-orders?dateFrom=2028-02-29&dateTo=2028-03-01')
      .expect(200);
  });

  it('call path: เขียน delivery_order* ได้จาก DeliveryOrderService ที่เดียว', () => {
    const root = resolve(__dirname, '../src');
    const allowed = new Set(['modules/delivery-orders/delivery-order.service.ts']);
    const WRITE =
      /\b(deliveryOrder|deliveryOrderLine)\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?delivery_order|\b(deliveryOrders|deliveryOrderLines|redeliveries|splitChildren|doOrigins|doDests|doLineRejects)\s*:\s*\{\s*(create|createMany|connectOrCreate|update|updateMany|upsert|delete|deleteMany|set|connect)\b/i;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) {
          const rel = relative(root, p);
          if (!allowed.has(rel) && WRITE.test(readFileSync(p, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
