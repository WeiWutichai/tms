import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST3-T01 `upsertOrder()` — ทางเดียวที่ order เข้าระบบ (docs/04 C): idempotent ต่อ (source, externalId),
 * source ทุกแบบ, pricingStatus + บรรทัดราคา snapshot, ใบค้าง + reason code, state machine, เลข SO, แยก tenant
 */
describe('order intake (upsertOrder)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let seed = 0;
  let vt6: string;
  let unitTon: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  async function company(tid: string) {
    const c = await db.company.create({
      data: {
        tenantId: tid,
        legalName: `บริษัท ผู้ออกบิล ${++seed}`,
        taxId: validTaxId(500 + seed),
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
    return c.id;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท รับงาน' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body.data;
    vt6 = uuid('vehicleType', types.find((t: { code: string }) => t.code === '6W').id);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  /** เรียก service ภายใต้ tenant ใน transaction ของตัวเอง (เหมือนทางเข้า T02–T05 เรียก) */
  const upsert = (input: UpsertOrderInput, tid = tenantId) =>
    app
      .get(DbService)
      .withTenant(tid, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId: tid, actorId: 'user-test', locale: 'th', tx },
          () => app.get(OrderIntakeService).upsertOrder(input, tx),
        ),
      );

  const newSite = async (token = admin) =>
    uuid(
      'site',
      (
        await api(app, token)
          .post('/v1/customer-sites')
          .send({ name: `จุดรับส่ง ${++seed}`, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async (extra: object = {}, token = admin) =>
    uuid(
      'customer',
      (
        await api(app, token)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9000 + seed), ...extra })
          .expect(201)
      ).body.id,
    );
  const approveRate = async (key: { customer: string; origin: string; dest: string }) => {
    const r = (
      await api(app, admin)
        .post('/v1/rate-cards')
        .send({
          customerId: `cus_${key.customer.replace(/-/g, '')}`,
          originId: `loc_${key.origin.replace(/-/g, '')}`,
          destinationId: `loc_${key.dest.replace(/-/g, '')}`,
          vehicleTypeId: `vty_${vt6.replace(/-/g, '')}`,
          validFrom: addDays(today, -30),
          pricingModel: 'PER_TRIP',
          sellRate: '4500',
          sellExtraStopRate: '300',
          includedStops: 2,
        })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${r.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
    return r as { id: string; code: string };
  };
  const key = async () => ({
    customer: await newCustomer(),
    origin: await newSite(),
    dest: await newSite(),
  });
  const order = (
    k: { customer: string; origin: string; dest: string },
    extra: Partial<UpsertOrderInput> = {},
  ): UpsertOrderInput => ({
    source: 'MANUAL',
    customer: { id: k.customer },
    requestedDate: today,
    vehicleTypeId: vt6,
    stops: [
      { type: 'PICKUP', siteId: k.origin, windowStart: `${today}T07:00:00+07:00` },
      { type: 'DELIVERY', siteId: k.dest, windowEnd: `${today}T16:00:00+07:00` },
    ],
    lines: [{ description: 'ปูนซีเมนต์', qty: '12.5', unitId: unitTon, weightKg: '12500' }],
    ...extra,
  });
  const yymm = () => {
    const [y, m] = today.split('-');
    return `${String(Number(y) + 543).slice(-2)}${m}`;
  };
  const errFields = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const x = e as { code?: string; errors?: { field: string; code: string }[] };
      return { code: x.code, fields: x.errors?.map((f) => `${f.field}:${f.code}`) ?? [] };
    }
    throw new Error('expected failure');
  };

  it('กรอกมือครบ + มี rate → RECEIVED, เลข SO, pricingStatus AVAILABLE, บรรทัดราคา snapshot (ภาษีที่บรรทัด)', async () => {
    const k = await key();
    const rc = await approveRate(k);
    const r = await upsert(
      order(k, {
        stops: [...order(k).stops, { type: 'DELIVERY', siteText: 'ร้านค้าย่อย', siteId: k.dest }],
      }),
    );
    expect(r.created).toBe(true);
    expect(r.holds).toEqual([]);
    const o = r.order;
    expect(o.status).toBe('RECEIVED');
    expect(o.soNo).toMatch(new RegExp(`^SO-${yymm()}-\\d{4}$`));
    expect(o.source).toBe('MANUAL');
    expect(o.sourceConnector).toBe('');
    expect(o.pricingStatus).toBe('AVAILABLE');
    expect(o.priceTotal!.toFixed(2)).toBe('4800.00');
    expect(o.stops.map((s) => [s.sequence, s.type, s.siteText.length > 0])).toEqual([
      [1, 'PICKUP', true],
      [2, 'DELIVERY', true],
      [3, 'DELIVERY', true],
    ]);
    expect(o.lines[0]).toMatchObject({ lineNo: 1, unit: 'TON', unitId: unitTon });
    expect(
      o.charges.map((c) => [
        c.lineNo,
        c.kind,
        c.origin,
        c.qty.toFixed(),
        c.unitPrice.toFixed(2),
        c.amount.toFixed(2),
        c.vatType,
        c.whtRate.toFixed(2),
        c.rateCardCode,
        c.rateCardRevision,
      ]),
    ).toEqual([
      [
        1,
        'FREIGHT',
        'RATE_CARD',
        '1',
        '4500.00',
        '4500.00',
        'EXEMPT_TRANSPORT',
        '1.00',
        rc.code,
        1,
      ],
      [
        2,
        'EXTRA_STOP',
        'RATE_CARD',
        '1',
        '300.00',
        '300.00',
        'EXEMPT_TRANSPORT',
        '1.00',
        rc.code,
        1,
      ],
    ]);
    // snapshot ไม่ต้อง join กลับ: รายการบริการ (id + version + ก้อน snapshot) และพารามิเตอร์ (MD-117)
    expect(o.charges[0]!.serviceItemVersion).toBeGreaterThanOrEqual(1);
    expect(o.charges[0]!.serviceItemSnapshot).toMatchObject({ code: 'FREIGHT', whtRate: '1.00' });
    expect(o.pricingDetail).toMatchObject({
      params: { rateCode: rc.code, rateRevision: 1, pricingModel: 'PER_TRIP', stops: 3 },
    });
    const audit = await db.auditLog.findMany({ where: { entityId: o.id } });
    expect(audit.map((a) => a.action)).toEqual(['sales_order.created']);
    const ev = await db.domainEvent.findMany({ where: { localId: o.id } });
    expect(ev.map((e) => e.type)).toEqual(['order.created']);
    // event ไม่มีราคา (ผู้รับ webhook อาจไม่มีสิทธิ์ราคา)
    expect(JSON.stringify(ev[0]!.snapshot)).not.toMatch(/4500|4800|price/i);
  });

  it('idempotent: externalId เดิม 2 ครั้ง = 1 order (ครั้งที่ 2 ไม่เปลี่ยนอะไร); ข้อมูลเปลี่ยน = อัปเดตใบเดิม', async () => {
    const k = await key();
    await approveRate(k);
    const input = order(k, { source: 'API', externalId: 'PO-7781', customerRef: 'PO-7781' });
    const a = await upsert(input);
    const b = await upsert(input);
    expect(b).toMatchObject({ created: false, changed: false });
    expect(b.order.id).toBe(a.order.id);
    expect(b.order.version).toBe(a.order.version);
    expect(b.order.soNo).toBe(a.order.soNo);
    const c = await upsert({ ...input, customerRef: 'PO-7781-แก้' });
    expect(c).toMatchObject({ created: false, changed: true });
    expect(c.order.id).toBe(a.order.id);
    expect(c.order.version).toBe(a.order.version + 1);
    expect(c.order.soNo).toBe(a.order.soNo);
    expect(c.order.customerRef).toBe('PO-7781-แก้');
    expect(c.order.charges).toHaveLength(1);
    expect(await db.salesOrder.count({ where: { externalId: 'PO-7781' } })).toBe(1);
    const audit = await db.auditLog.findMany({
      where: { entityId: a.order.id },
      orderBy: { seq: 'asc' },
    });
    expect(audit.map((x) => x.action)).toEqual(['sales_order.created', 'sales_order.updated']);
    expect(audit[1]!.after).toEqual({ customerRef: 'PO-7781-แก้', version: undefined });
  });

  it('upsert พร้อมกัน 6 คำขอ key เดียวกัน → 1 order (advisory lock + unique)', async () => {
    const k = await key();
    const input = order(k, { source: 'ERP:krs', externalId: 'KRS-SO-0001' });
    const rs = await Promise.all(Array.from({ length: 6 }, () => upsert(input)));
    expect(new Set(rs.map((r) => r.order.id)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(
      await db.salesOrder.count({
        where: { tenantId, source: 'CONNECTOR', sourceConnector: 'krs', externalId: 'KRS-SO-0001' },
      }),
    ).toBe(1);
  });

  it('source ทุกแบบ: MANUAL / EXCEL / API / PORTAL / ERP:{connector}; externalId unique ต่อ tenant — ช่องทางอื่นใช้ซ้ำ = 409; ช่องทางผิด 422', async () => {
    const k = await key();
    const variants: [UpsertOrderInput['source'], string, string][] = [
      ['MANUAL', 'MANUAL', ''],
      ['EXCEL', 'IMPORT', ''],
      ['API', 'API', ''],
      ['PORTAL', 'PORTAL', ''],
      ['ERP:KRS', 'CONNECTOR', 'krs'],
      [{ source: 'CONNECTOR', connector: 'express' }, 'CONNECTOR', 'express'],
    ];
    const ids = new Set<string>();
    for (const [source, stored, connector] of variants) {
      const r = await upsert(order(k, { source, externalId: `EXT-${stored}-${connector}` }));
      expect(r.created).toBe(true);
      expect([r.order.source, r.order.sourceConnector]).toEqual([stored, connector]);
      ids.add(r.order.id);
    }
    expect(ids.size).toBe(variants.length);
    const ev = await db.domainEvent.findFirst({
      where: { localId: [...ids][4]!, type: 'order.created' },
    });
    expect(ev!.snapshot).toMatchObject({ source: 'ERP:krs', externalId: 'EXT-CONNECTOR-krs' });
    // externalId เดิมจากช่องทาง/connector อื่น → 409 ไม่ทับใบของต้นทางอื่น (plan/00a: unique ต่อ tenant)
    for (const other of ['API', 'ERP:express'])
      expect(
        (await errFields(upsert(order(k, { source: other, externalId: 'EXT-CONNECTOR-krs' }))))
          .code,
      ).toBe('external_id_conflict');
    for (const bad of ['FAX', 'ERP:', 'CONNECTOR', { source: 'API', connector: 'krs' }] as const)
      expect(await errFields(upsert(order(k, { source: bad as never })))).toEqual({
        code: 'validation_failed',
        fields: ['source:invalid_source'],
      });
    // ฐานข้อมูลกันซ้ำ: CONNECTOR ต้องมีรหัส connector
    await expect(
      db.$executeRaw`UPDATE sales_order SET source_connector = '' WHERE id = ${[...ids][4]!}::uuid`,
    ).rejects.toThrow(/sales_order_source_connector/);
  });

  it('ไม่มี rate → เข้าระบบเป็น ON_HOLD RATE_MISSING (pricingStatus RATE_MISSING ไม่มีบรรทัดราคา) → อนุมัติ rate แล้ว upsert ใหม่ → RECEIVED', async () => {
    const k = await key();
    const input = order(k, { source: 'API', externalId: 'NO-RATE-1' });
    const a = await upsert(input);
    expect(a.order).toMatchObject({ status: 'ON_HOLD', pricingStatus: 'RATE_MISSING' });
    expect(a.order.holdReasonCode?.code).toBe('RATE_MISSING');
    expect(a.order.soNo).not.toBeNull();
    expect(a.order.priceTotal).toBeNull();
    expect(a.order.charges).toEqual([]);
    expect(a.holds).toEqual([{ code: 'RATE_MISSING', field: 'pricing' }]);
    expect((a.order.pricingDetail as { reasons: { code: string }[] }).reasons[0]!.code).toBe(
      'RATE_MISSING',
    );
    await approveRate(k);
    const b = await upsert({ ...input, customerRef: 'ส่งใหม่หลังมีราคา' });
    expect(b.order).toMatchObject({
      status: 'RECEIVED',
      pricingStatus: 'AVAILABLE',
      holdReasonCodeId: null,
    });
    expect(b.order.charges).toHaveLength(1);
    const hist = await db.docStatusHistory.findMany({
      where: { docId: a.order.id },
      orderBy: { at: 'asc' },
    });
    expect(hist.map((h) => [h.fromStatus, h.event, h.toStatus])).toEqual([
      ['NONE', 'create', 'RECEIVED'],
      ['RECEIVED', 'hold', 'ON_HOLD'],
      ['ON_HOLD', 'release', 'RECEIVED'],
    ]);
    expect(hist[1]!.reasonCodeId).toBe(a.order.holdReasonCodeId);
    expect(hist[1]!.note).toBe('ยังไม่มีราคาขาย (ไม่พบ rate card ที่ใช้ได้ หรือคิดราคาไม่ได้)');
    const ev = await db.domainEvent.findMany({
      where: { localId: a.order.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(ev.map((e) => e.type)).toEqual([
      'order.created',
      'order.held',
      'order.released',
      'order.updated',
    ]);
  });

  it('connector ส่งรหัสลูกค้าที่ไม่รู้จัก + จุดส่งเป็นข้อความ → เข้าระบบเสมอเป็น ON_HOLD CUSTOMER_UNMAPPED (เหตุรองเก็บไว้); จับคู่ด้วย externalId ของลูกค้าได้', async () => {
    const origin = await newSite();
    const input: UpsertOrderInput = {
      source: 'ERP:krs',
      externalId: 'KRS-SO-0002',
      customer: { externalId: 'KRS-C-404', text: 'ร้านค้าไม่รู้จัก' },
      requestedDate: today,
      vehicleTypeId: vt6,
      stops: [
        { type: 'PICKUP', siteId: origin },
        { type: 'DELIVERY', siteText: 'ตลาดสดเมืองใหม่ ชลบุรี' },
      ],
      rawPayload: { soNo: 'SO-0002', cust: 'KRS-C-404' },
    };
    const a = await upsert(input);
    expect(a.order).toMatchObject({
      status: 'ON_HOLD',
      customerId: null,
      customerExternalId: 'KRS-C-404',
      customerText: 'ร้านค้าไม่รู้จัก',
      rawPayload: { soNo: 'SO-0002', cust: 'KRS-C-404' },
    });
    expect(a.order.holdReasonCode?.code).toBe('CUSTOMER_UNMAPPED');
    expect(a.holds.map((h) => h.code)).toEqual([
      'CUSTOMER_UNMAPPED',
      'LOCATION_UNMAPPED',
      'RATE_MISSING',
    ]);
    expect(a.order.stops[1]).toMatchObject({ siteId: null, siteText: 'ตลาดสดเมืองใหม่ ชลบุรี' });
    expect(a.order.holdNote).toBe('ยังไม่ได้จับคู่ลูกค้า (รหัสต้นทาง KRS-C-404)');
    // raw ต่างแต่ข้อมูลเดิม = no-op (rawPayload ไม่อยู่ใน hash)
    const same = await upsert({ ...input, rawPayload: { soNo: 'SO-0002', polledAt: 'x' } });
    expect(same.changed).toBe(false);

    // ลูกค้าที่มี externalId ตรง → จับคู่ได้ เหตุค้างเลื่อนเป็นตัวถัดไป (ไม่ใช่ transition — บันทึกประวัติเหตุเปลี่ยน)
    const cust = await newCustomer({ externalId: 'KRS-C-404' });
    const b = await upsert({
      ...input,
      customerRef: 'PO-2',
      rawPayload: { soNo: 'SO-0002', rev: 2 },
    });
    expect(b.order.customerId).toBe(cust);
    expect(b.order.status).toBe('ON_HOLD');
    expect(b.order.holdReasonCode?.code).toBe('LOCATION_UNMAPPED');
    expect(b.order.holdNote).toBe('จุดที่ 2 ยังไม่ได้จับคู่สถานที่: ตลาดสดเมืองใหม่ ชลบุรี');
    const last = await db.docStatusHistory.findFirst({
      where: { docId: a.order.id },
      orderBy: { at: 'desc' },
    });
    expect(last).toMatchObject({
      fromStatus: 'ON_HOLD',
      toStatus: 'ON_HOLD',
      event: 'hold_reason_changed',
    });

    // connector แจ้งข้อมูลไม่ครบ → SOURCE_ERROR มาก่อน
    const c = await upsert({ ...input, externalId: 'KRS-SO-0003', sourceIssues: ['ไม่มีวันส่ง'] });
    expect(c.order.holdReasonCode?.code).toBe('SOURCE_ERROR');
  });

  it('ร่างไม่กินเลข: DRAFT ไม่มีเลข → ส่ง (submit) ได้เลขถัดไป; ขอเป็นร่างอีก → invalid_state_transition', async () => {
    const k = await key();
    await approveRate(k);
    const d = await upsert(order(k, { source: 'API', externalId: 'DRAFT-1', draft: true }));
    expect(d.order).toMatchObject({ status: 'DRAFT', soNo: null, pricingStatus: 'AVAILABLE' });
    const x = await upsert(order(k));
    const s = await upsert(order(k, { source: 'API', externalId: 'DRAFT-1' }));
    expect(s.order.status).toBe('RECEIVED');
    const n = (no: string | null) => Number(no!.slice(-4));
    expect(n(s.order.soNo)).toBe(n(x.order.soNo) + 1);
    const hist = await db.docStatusHistory.findMany({ where: { docId: d.order.id } });
    expect(hist.map((h) => `${h.fromStatus}>${h.event}>${h.toStatus}`).sort()).toEqual([
      'DRAFT>submit>RECEIVED',
      'NONE>create>DRAFT',
    ]);
    // ร่างไม่ส่ง event — order.created เกิดตอนพ้นร่าง
    const ev = await db.domainEvent.findMany({ where: { localId: d.order.id } });
    expect(ev.map((e) => e.type)).toEqual(['order.created']);
    expect(
      (
        await errFields(
          upsert(order(k, { source: 'API', externalId: 'DRAFT-1', draft: true, customerRef: 'x' })),
        )
      ).code,
    ).toBe('invalid_state_transition');
  });

  it('ส่งซ้ำค่าเดิมหลังอนุมัติ rate → ไม่เขียนข้อมูลซ้ำ แต่คิดราคาใหม่และปล่อยใบค้าง RATE_MISSING → RECEIVED; reevaluate() ก็ได้ผลเดียวกัน', async () => {
    const k = await key();
    const input = order(k, { source: 'API', externalId: 'RESEND-1' });
    const a = await upsert(input);
    expect(a.order.holdReasonCode?.code).toBe('RATE_MISSING');
    const lineIds = a.order.lines.map((l) => l.id);
    await approveRate(k);
    const b = await upsert(input);
    expect(b).toMatchObject({ created: false, changed: true });
    expect(b.order).toMatchObject({ status: 'RECEIVED', pricingStatus: 'AVAILABLE' });
    expect(b.order.priceTotal!.toFixed(2)).toBe('4500.00');
    expect(b.order.lines.map((l) => l.id)).toEqual(lineIds);
    expect(b.order.version).toBe(a.order.version + 1);
    expect((await upsert(input)).changed).toBe(false);

    // reevaluate (หน้าใบค้าง T07): ข้อมูลเดิม ประเมินใหม่ได้
    const k2 = await key();
    const c = await upsert(order(k2));
    expect(c.order.status).toBe('ON_HOLD');
    await approveRate(k2);
    const r = await app
      .get(DbService)
      .withTenant(tenantId, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'user-test', locale: 'th', tx },
          () => app.get(OrderIntakeService).reevaluate(c.order.id, tx),
        ),
      );
    expect(r.order.status).toBe('RECEIVED');
  });

  it('แก้ใบด้วย id (กรอกมือ/ร่างไม่มี externalId): ทางเดียวกัน — ร่าง → แก้ → ส่ง; id ของจุด/สินค้าคงเดิม; externalId เปลี่ยนไม่ได้', async () => {
    const k = await key();
    await approveRate(k);
    const d = await upsert(order(k, { draft: true }));
    expect(d.order).toMatchObject({ status: 'DRAFT', soNo: null, externalId: null });
    const stopIds = d.order.stops.map((s) => s.id);
    const lineId = d.order.lines[0]!.id;
    const e = await upsert(
      order(k, {
        id: d.order.id,
        draft: true,
        lines: [
          { description: 'ปูนซีเมนต์ (แก้)', qty: '13', unitId: unitTon },
          { description: 'เหล็กเส้น', qty: '2', unitId: unitTon },
        ],
      }),
    );
    expect(e.order.id).toBe(d.order.id);
    expect(e.order.status).toBe('DRAFT');
    expect(e.order.stops.map((s) => s.id)).toEqual(stopIds);
    expect(e.order.lines.map((l) => [l.id === lineId, l.description])).toEqual([
      [true, 'ปูนซีเมนต์ (แก้)'],
      [false, 'เหล็กเส้น'],
    ]);
    const audit = await db.auditLog.findFirst({
      where: { entityId: d.order.id, action: 'sales_order.updated' },
    });
    expect(JSON.stringify(audit!.after)).toContain('เหล็กเส้น');
    const f = await upsert(
      order(k, { id: d.order.id, lines: [{ description: 'ปูน', qty: '1', unitId: unitTon }] }),
    );
    expect(f.order).toMatchObject({ status: 'RECEIVED', source: 'MANUAL' });
    expect(f.order.soNo).not.toBeNull();
    expect(f.order.lines).toHaveLength(1);
    expect(f.order.lines[0]!.id).toBe(lineId);
    expect(
      (await errFields(upsert(order(k, { id: d.order.id, externalId: 'NEW-EXT' })))).fields,
    ).toEqual(['externalId:external_id_locked']);
    expect((await errFields(upsert(order(k, { id: randomUUID() })))).code).toBe('not_found');
  });

  it('อ้างอิงที่ปิดใช้ → เข้าระบบแต่ค้าง (ลูกค้า → CUSTOMER_UNMAPPED, สถานที่ → LOCATION_UNMAPPED) · สถานที่ของลูกค้าอื่น → 422 site_other_customer · จำนวนต้องเป็นสตริง; ทศนิยมรูปต่างค่าเดียวกัน = no-op', async () => {
    const k = await key();
    await approveRate(k);
    await api(app, admin)
      .post(`/v1/customers/cus_${k.customer.replace(/-/g, '')}/deactivate`)
      .send({ reason: 'เลิกใช้บริการทดสอบระบบ' })
      .expect(200);
    // ลูกค้าปิดใช้: order ยังเข้าระบบ (docs/04 C) แต่ค้าง CUSTOMER_UNMAPPED และไม่ใช้ rate ของลูกค้านั้น
    const inact = await upsert(order(k));
    expect(inact.order).toMatchObject({ status: 'ON_HOLD', pricingStatus: 'RATE_MISSING' });
    expect(inact.order.holdReasonCode?.code).toBe('CUSTOMER_UNMAPPED');
    expect(inact.order.holdNote).toBe('ลูกค้าถูกปิดใช้งาน — เลือกลูกค้าใหม่หรือเปิดใช้ลูกค้า');
    expect(inact.order.charges).toEqual([]);
    // สถานที่ปิดใช้ → LOCATION_UNMAPPED
    const k3 = await key();
    await api(app, admin)
      .post(`/v1/customer-sites/loc_${k3.dest.replace(/-/g, '')}/deactivate`)
      .send({ reason: 'ปิดจุดส่งนี้แล้ว ทดสอบระบบ' })
      .expect(200);
    const st = await upsert(order(k3));
    expect(st.order.holdReasonCode?.code).toBe('LOCATION_UNMAPPED');
    expect(st.order.holdNote).toMatch(/^จุดที่ 2 สถานที่ถูกปิดใช้งาน/);
    const k2 = await key();
    const otherCustomersSite = (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({
          name: `จุดของลูกค้าอื่น ${++seed}`,
          kind: 'DROPOFF',
          address: ADDR,
          customerId: `cus_${(await newCustomer()).replace(/-/g, '')}`,
        })
        .expect(201)
    ).body.id;
    expect(
      (
        await errFields(
          upsert(
            order(k2, {
              stops: [
                { type: 'PICKUP', siteId: k2.origin },
                { type: 'DELIVERY', siteId: uuid('site', otherCustomersSite) },
              ],
            }),
          ),
        )
      ).fields,
    ).toEqual(['stops[1].siteId:site_other_customer']);
    expect(
      (
        await errFields(
          upsert(order(k2, { lines: [{ description: 'x', qty: 12.5 as never, unitId: unitTon }] })),
        )
      ).fields,
    ).toEqual(['lines[0].qty:invalid_type']);
    const a = await upsert(
      order(k2, {
        source: 'API',
        externalId: 'CANON-1',
        lines: [{ description: 'x', qty: '12.50', unitId: unitTon }],
      }),
    );
    const b = await upsert(
      order(k2, {
        source: 'API',
        externalId: 'CANON-1',
        lines: [{ description: 'x', qty: '012.5', unitId: unitTon }],
      }),
    );
    expect(b.changed).toBe(false);
    expect(b.order.version).toBe(a.order.version);
  });

  it('เลข SO เรียงต่อกันไม่ซ้ำเมื่อสร้างพร้อมกัน (document_series SO, รายเดือน)', async () => {
    const k = await key();
    await approveRate(k);
    const rs = await Promise.all(Array.from({ length: 8 }, () => upsert(order(k))));
    const nos = rs.map((r) => Number(r.order.soNo!.slice(-4))).sort((a, b) => a - b);
    expect(new Set(nos).size).toBe(8);
    expect(nos[7]! - nos[0]!).toBe(7);
  });

  it('รูปแบบผิดรวมทุกช่องใน 422 เดียว · อ้าง id ที่ไม่มี/ของ tenant อื่น → 422 reference_not_found', async () => {
    const k = await key();
    const bad = await errFields(
      upsert({
        source: 'MANUAL',
        requestedDate: '2026-02-30',
        stops: [{ type: 'DROP' as never, siteText: '' }],
        lines: [{ description: '', qty: '-1', unit: 'kg', weightKg: '1.2345' }],
        vehicleTypeId: 'not-a-uuid',
      }),
    );
    expect(bad.code).toBe('validation_failed');
    expect(bad.fields).toEqual(
      expect.arrayContaining([
        'requestedDate:invalid_date',
        'stops[0].type:invalid_enum',
        'stops[0].siteText:required',
        'lines[0].qty:invalid_decimal',
        'lines[0].description:required',
        'lines[0].weightKg:invalid_decimal',
        'vehicleTypeId:invalid_id',
      ]),
    );
    expect((await errFields(upsert(order(k, { customer: { id: randomUUID() } })))).fields).toEqual([
      'customer.id:reference_not_found',
    ]);
    // สถานที่ของ tenant อื่น — RLS มองไม่เห็น = ไม่พบ
    const foreignSite = await newSite(other);
    expect(
      (
        await errFields(
          upsert(
            order(k, {
              stops: [
                { type: 'PICKUP', siteId: foreignSite },
                { type: 'DELIVERY', siteId: k.dest },
              ],
            }),
          ),
        )
      ).fields,
    ).toEqual(['stops[0].siteId:reference_not_found']);
  });

  it('แยก tenant: externalId เดียวกันของอีก tenant = คนละใบ, เลขนับแยก, มองไม่เห็นข้ามกัน (RLS)', async () => {
    const k = await key();
    const mine = await upsert(order(k, { source: 'API', externalId: 'SHARED-EXT-1' }));
    const kb = {
      customer: await newCustomer({}, other),
      origin: await newSite(other),
      dest: await newSite(other),
    };
    const vtB = (
      await api(app, other).get('/v1/vehicle-types?limit=50').expect(200)
    ).body.data.find((t: { code: string }) => t.code === '6W').id;
    const theirs = await upsert(
      order(kb, {
        source: 'API',
        externalId: 'SHARED-EXT-1',
        vehicleTypeId: uuid('vehicleType', vtB),
        lines: [],
      }),
      otherId,
    );
    expect(theirs.created).toBe(true);
    expect(theirs.order.id).not.toBe(mine.order.id);
    expect(theirs.order.soNo).toBe(`SO-${yymm()}-0001`);
    const seen = await app
      .get(DbService)
      .withTenant(otherId, (tx) =>
        tx.salesOrder.findMany({ where: { externalId: 'SHARED-EXT-1' } }),
      );
    expect(seen.map((o) => o.id)).toEqual([theirs.order.id]);
    const charges = await app
      .get(DbService)
      .withTenant(otherId, (tx) =>
        tx.salesOrderCharge.count({ where: { salesOrderId: mine.order.id } }),
      );
    expect(charges).toBe(0);
  });

  it('หลังวางแผน upsert แก้ได้เฉพาะช่องที่สถานะอนุญาต (ST3-T03) — ช่องอื่น/ยกเลิกแล้ว → 409 order_locked_for_update (diff = ST3-T10)', async () => {
    const k = await key();
    await approveRate(k);
    const input = order(k, { source: 'API', externalId: 'LOCK-1' });
    const a = await upsert(input);
    await db.salesOrder.update({ where: { id: a.order.id }, data: { status: 'PLANNED' } });
    // เลข PO แก้ได้หลังวางแผน
    const po = await upsert({ ...input, customerRef: 'แก้หลังวางแผน' });
    expect(po.changed).toBe(true);
    expect(po.order.customerRef).toBe('แก้หลังวางแผน');
    expect(po.order.status).toBe('PLANNED');
    // เปลี่ยนปลายทาง → 409 พร้อมช่อง
    const other = await newSite();
    const moved = await errFields(
      upsert({
        ...input,
        customerRef: 'แก้หลังวางแผน',
        stops: [input.stops[0]!, { ...input.stops[1]!, siteId: other }],
      }),
    );
    expect(moved).toEqual({ code: 'order_locked_for_update', fields: ['stops[1].siteId:locked'] });
    // ส่งซ้ำค่าเดิม = idempotent ไม่ error
    expect((await upsert({ ...input, customerRef: 'แก้หลังวางแผน' })).changed).toBe(false);
    await db.salesOrder.update({ where: { id: a.order.id }, data: { status: 'CANCELLED' } });
    expect((await errFields(upsert({ ...input, customerRef: 'หลังยกเลิก' }))).code).toBe(
      'order_locked_for_update',
    );
  });

  it('constraint ในฐานข้อมูล: ON_HOLD ต้องมี reason code, พ้นร่างต้องมีเลข, tms_app ลบ SO ไม่ได้', async () => {
    const k = await key();
    const a = await upsert(order(k, { source: 'API', externalId: 'CONSTRAINT-1' }));
    await expect(
      db.$executeRaw`UPDATE sales_order SET hold_reason_code_id = NULL WHERE id = ${a.order.id}::uuid`,
    ).rejects.toThrow(/sales_order_hold_reason/);
    await expect(
      db.$executeRaw`UPDATE sales_order SET so_no = NULL WHERE id = ${a.order.id}::uuid`,
    ).rejects.toThrow(/sales_order_number/);
    const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
    try {
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await tx.$executeRaw`DELETE FROM sales_order WHERE id = ${a.order.id}::uuid`;
        }),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await appDb.$disconnect();
    }
  });

  it('call path: เขียนตาราง sales_order* ได้จาก OrderIntakeService ที่เดียว (ทุกทางเข้าต้องเรียก upsertOrder)', () => {
    const root = resolve(__dirname, '../src');
    // ทางเข้า: order-intake.service · ที่ว่างไว้สำหรับ service สถานะ SO ของโมดูลเดียวกัน (T09–T11 plan/dispatch/cancel)
    const allowed = new Set([
      'modules/orders/order-intake.service.ts',
      'modules/orders/order-state.service.ts',
    ]);
    const WRITE =
      /\b(salesOrder|salesOrderStop|salesOrderLine|salesOrderCharge)\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?sales_order/i;
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
