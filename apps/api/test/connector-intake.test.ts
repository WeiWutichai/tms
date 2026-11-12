import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import { JobQueue } from '../src/jobs/job-queue.service';
import {
  CONNECTOR_PULL_JOB,
  ConnectorIntakeService,
} from '../src/modules/connectors/connector-intake.service';
import {
  MockOrderSource,
  OrderSourceRegistry,
} from '../src/modules/connectors/order-source-registry';
import type { ExternalOrder } from '../src/modules/connectors/order-source.port';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST3-T05 ทางเข้าจาก connector (`pullOrders`) — puller จำลอง (MockOrderSource) → ConnectorIntakeService
 * → OrderIntakeService.upsertOrder (ทางเดียวกับ API) · ทุกใบเข้าระบบเสมอ (docs/04 C)
 */
describe('connector intake (pullOrders)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let seed = 0;
  let vt6: string;
  let svc: ConnectorIntakeService;
  let mock: MockOrderSource;
  const today = bangkokToday();
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;

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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท รับงาน ERP' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body.data;
    vt6 = types.find((t: { code: string }) => t.code === '6W').id;
    svc = app.get(ConnectorIntakeService);
    mock = app.get(OrderSourceRegistry).mock();

    // ข้อมูลหลักที่ต้นทางอ้างด้วยรหัส: ลูกค้า C-001 + สถานที่ S-ORG / S-DST + rate ที่อนุมัติแล้ว
    const cus = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: 'ลูกค้า ERP', taxId: validTaxId(9100), externalId: 'C-001' })
        .expect(201)
    ).body.id as string;
    const site = async (externalId: string) =>
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({ name: `จุด ${externalId}`, kind: 'DROPOFF', address: ADDR, externalId })
          .expect(201)
      ).body.id as string;
    const org = await site('S-ORG');
    const dst = await site('S-DST');
    const rc = (
      await api(app, admin)
        .post('/v1/rate-cards')
        .send({
          customerId: cus,
          originId: org,
          destinationId: dst,
          vehicleTypeId: vt6,
          validFrom: addDays(today, -30),
          pricingModel: 'PER_TRIP',
          sellRate: '4500',
          sellExtraStopRate: '300',
          includedStops: 2,
        })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${rc.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
  });
  afterAll(async () => {
    mock.reset();
    await app.close();
    await db.$disconnect();
  });
  beforeEach(() => {
    // feed ต่อ tenant สะสมข้ามข้อ (cursor ในฐานเดินต่อ) — ล้างเฉพาะตัวจำลองความผิดพลาด
    mock.delayMs = 0;
    mock.failNext = null;
  });

  /** order ตามต้นทาง — ลูกค้า C-001 + จุดที่จับคู่ได้ + มี rate → RECEIVED */
  const ext = (externalId: string, extra: Partial<ExternalOrder> = {}): ExternalOrder => ({
    externalId,
    customer: { code: 'C-001', name: 'ลูกค้า ERP' },
    customerRef: `PO-${externalId}`,
    requestedDate: today,
    vehicleTypeCode: '6W',
    stops: [
      { type: 'PICKUP', siteCode: 'S-ORG', windowStart: `${today}T07:00:00+07:00` },
      { type: 'DELIVERY', siteCode: 'S-DST', windowEnd: `${today}T16:00:00+07:00` },
    ],
    lines: [{ itemCode: 'CEM-01', description: 'ปูนซีเมนต์', qty: '12.5', unit: 'TON' }],
    raw: { soNo: externalId },
    ...extra,
  });
  const orders = (tid = tenantId, where: object = {}) =>
    db.salesOrder.findMany({
      where: { tenantId: tid, ...where },
      include: { holdReasonCode: { select: { code: true } }, stops: true, lines: true },
      orderBy: { externalId: 'asc' },
    });
  const cursorRow = (tid = tenantId, key = 'mock') =>
    db.connectorCursor.findUnique({
      where: { tenantId_connectorKey: { tenantId: tid, connectorKey: key } },
    });

  it('เกณฑ์ตรวจรับ: puller จำลองส่ง 10 ใบ (ลูกค้าไม่รู้จัก 3 ใบ) → มี 10 order โดย 3 ใบ ON_HOLD', async () => {
    const batch = Array.from({ length: 10 }, (_, i) =>
      ext(
        `ACC-${String(i + 1).padStart(2, '0')}`,
        i % 3 === 2 && i < 9 ? { customer: { code: `UNKNOWN-${i}`, name: `ลูกค้าใหม่ ${i}` } } : {},
      ),
    );
    mock.push(tenantId, ...batch);
    const r = await svc.pull(tenantId, 'mock');
    expect(r.counts).toMatchObject({ total: 10, created: 10, held: 3, error: 0 });

    const all = await orders(tenantId, { externalId: { startsWith: 'ACC-' } });
    expect(all).toHaveLength(10);
    const held = all.filter((o) => o.status === 'ON_HOLD');
    expect(held).toHaveLength(3);
    expect(held.map((o) => o.holdReasonCode?.code)).toEqual(Array(3).fill('CUSTOMER_UNMAPPED'));
    expect(held.map((o) => o.customerExternalId).sort()).toEqual([
      'UNKNOWN-2',
      'UNKNOWN-5',
      'UNKNOWN-8',
    ]);
    const ok = all.filter((o) => o.status !== 'ON_HOLD');
    expect(ok.map((o) => o.status)).toEqual(Array(7).fill('RECEIVED'));
    expect(ok.every((o) => o.pricingStatus === 'AVAILABLE' && o.soNo)).toBe(true);
    for (const o of all) {
      expect(o.source).toBe('CONNECTOR');
      expect(o.sourceConnector).toBe('mock');
      expect(o.stops.map((s) => s.siteId !== null)).toEqual([true, true]);
      expect(o.rawPayload).toEqual({ soNo: o.externalId });
    }
    // ผู้กระทำ = connector (audit + ประวัติสถานะ) · cursor เก็บแล้ว · audit สรุปรอบ
    const audits = await db.auditLog.findMany({
      where: { tenantId, entityType: 'sales_order', action: 'sales_order.created' },
    });
    expect(audits.length).toBe(10);
    expect(new Set(audits.map((a) => a.actorId))).toEqual(new Set(['connector:mock']));
    const cur = await cursorRow();
    expect(cur).toMatchObject({ cursor: '10', leaseId: null, leaseUntil: null });
    expect(cur!.lastSuccessAt).toBeTruthy();
    expect((cur!.lastResult as { counts: { created: number } }).counts.created).toBe(10);
    const runAudit = await db.auditLog.findFirst({
      where: { tenantId, action: 'connector.orders_pulled', entityId: cur!.id },
    });
    expect(runAudit?.actorId).toBe('connector:mock');
  });

  it('ดึงซ้ำ batch เดิม (ต้นทางส่งซ้ำ) → ไม่เกิดใบซ้ำ ผล unchanged · ไม่มีใบใหม่ = ไม่ลง audit', async () => {
    const before = await orders();
    const versions = new Map(before.map((o) => [o.id, o.version]));
    const batch = Array.from({ length: 10 }, (_, i) =>
      ext(
        `ACC-${String(i + 1).padStart(2, '0')}`,
        i % 3 === 2 && i < 9 ? { customer: { code: `UNKNOWN-${i}`, name: `ลูกค้าใหม่ ${i}` } } : {},
      ),
    );
    // ต้นทางส่งชุดเดิมอีกรอบ (ตั้ง cursor กลับไปต้นคิว)
    expect(batch).toHaveLength(10);
    await db.connectorCursor.update({
      where: { tenantId_connectorKey: { tenantId, connectorKey: 'mock' } },
      data: { cursor: null },
    });
    const r = await svc.pull(tenantId, 'mock');
    expect(r.counts).toMatchObject({ total: 10, unchanged: 10, created: 0, updated: 0 });
    const after = await orders();
    expect(after).toHaveLength(before.length);
    expect(after.every((o) => versions.get(o.id) === o.version)).toBe(true);

    const audits = await db.auditLog.count({
      where: { tenantId, action: 'connector.orders_pulled' },
    });
    const r2 = await svc.pull(tenantId, 'mock'); // ไม่มีใบใหม่
    expect(r2.counts.total).toBe(0);
    expect(
      await db.auditLog.count({ where: { tenantId, action: 'connector.orders_pulled' } }),
    ).toBe(audits);
  });

  it('ต้นทางแก้ใบ (ก่อนวางแผน) → updated · ลูกค้าถูกแก้ให้ถูก → ปล่อยใบค้าง', async () => {
    mock.push(tenantId, ext('ACC-03')); // เดิมลูกค้าไม่รู้จัก → ตอนนี้ C-001
    const r = await svc.pull(tenantId, 'mock');
    expect(r.results.find((x) => x.externalId === 'ACC-03')).toMatchObject({
      outcome: 'updated',
      status: 'RECEIVED',
    });
  });

  it('ข้อมูลผิดรูป/ขาด → ทุกใบยังเข้าระบบเป็น ON_HOLD SOURCE_ERROR พร้อม sourceIssues (ไม่ทิ้ง)', async () => {
    const bad: ExternalOrder[] = [
      ext('BAD-DATE', { requestedDate: undefined }),
      ext('BAD-DATE2', { requestedDate: '13/11/2569' }),
      ext('BAD-QTY', {
        lines: [
          { description: 'ปูน', qty: 'สิบ', unit: 'TON' },
          { description: 'ทราย', qty: 3, unit: 'TON', weightKg: 'หนัก' },
        ],
      }),
      ext('BAD-STOPS', { stops: 'คลังบางนา' as unknown }),
      ext('BAD-TYPE', {
        stops: [
          { type: 'DROP', siteCode: 'S-DST' },
          { type: 'PICKUP', windowStart: 'พรุ่งนี้เช้า' },
        ],
      }),
      ext('BAD-GARBAGE', {
        customer: 42 as unknown as ExternalOrder['customer'],
        customerRef: { po: 1 },
        lines: 'x',
        issues: ['ต้นทาง: คอลัมน์ ShipTo หายจาก view'],
      }),
      { externalId: undefined, customer: { code: 'C-001' }, raw: { soNo: null, row: 7 } },
      ext('BAD-LONG', { customerRef: 'P'.repeat(80) }),
    ];
    mock.push(tenantId, ...bad);
    const r = await svc.pull(tenantId, 'mock');
    const mine = r.results;
    expect(mine).toHaveLength(bad.length);
    expect(mine.every((x) => x.outcome === 'created' && x.status === 'ON_HOLD')).toBe(true);
    expect(mine.every((x) => x.holds![0] === 'SOURCE_ERROR' && x.sourceIssues! > 0)).toBe(true);
    expect(r.counts.error).toBe(0);

    const byExt = async (e: string) =>
      (await db.salesOrder.findFirst({
        where: { tenantId, externalId: e },
        include: { lines: true, stops: true, holdReasonCode: true },
      }))!;
    const noDate = await byExt('BAD-DATE');
    expect(noDate.requestedDate.toISOString().slice(0, 10)).toBe(today);
    expect(noDate.sourceIssues).toEqual([
      `ไม่มีวันรับของจากต้นทาง — ใช้วันที่รับเข้า ${today} ชั่วคราว`,
    ]);
    expect(noDate.holdNote).toContain('ไม่มีวันรับของ');
    const qty = await byExt('BAD-QTY');
    expect(qty.lines.map((l) => [l.description, l.qtyOrdered.toFixed(), l.weightKg])).toEqual([
      ['ทราย', '3', null],
    ]);
    expect(qty.sourceIssues).toEqual([
      'สินค้าบรรทัดที่ 1: ไม่มีจำนวนมากกว่า 0 — ไม่ได้รับบรรทัดนี้',
      'สินค้าบรรทัดที่ 2 น้ำหนัก: ตัวเลขไม่ถูกต้อง (หนัก)',
    ]);
    const stops = await byExt('BAD-STOPS');
    expect(stops.stops.map((s) => [s.type, s.siteText])).toEqual([
      ['DELIVERY', '(ต้นทางไม่ระบุสถานที่)'],
    ]);
    const type = await byExt('BAD-TYPE');
    expect(type.stops.map((s) => [s.type, s.siteId !== null, s.windowStart])).toEqual([
      ['DELIVERY', true, null],
      ['PICKUP', false, null],
    ]);
    const garbage = await byExt('BAD-GARBAGE');
    expect((garbage.sourceIssues as string[])[0]).toBe('ต้นทาง: คอลัมน์ ShipTo หายจาก view');
    expect(garbage.customerId).toBeNull();
    const noKey = await db.salesOrder.findFirst({
      where: { tenantId, externalId: { startsWith: 'mock-nokey-' } },
    });
    expect(noKey?.status).toBe('ON_HOLD');
    const long = await byExt('BAD-LONG');
    expect(long.customerRef).toBe('P'.repeat(50));

    // ส่งใบไม่มีเลขอ้างอิงเดิมซ้ำ → ใบเดิม (hash ของ payload)
    mock.push(tenantId, bad[6]!);
    const again = await svc.pull(tenantId, 'mock');
    expect(again.results).toEqual([
      expect.objectContaining({ externalId: noKey!.externalId, outcome: 'unchanged' }),
    ]);

    // ต้นทางแก้ข้อมูลให้ครบ → ปล่อยใบค้าง
    mock.push(tenantId, ext('BAD-DATE'));
    const fixed = await svc.pull(tenantId, 'mock');
    expect(fixed.results[0]).toMatchObject({ outcome: 'updated', status: 'RECEIVED' });
    expect((await byExt('BAD-DATE')).sourceIssues).toEqual([]);
  });

  it('upsert ยังปฏิเสธรูปแบบ (422) → รับเป็นใบสำรอง SOURCE_ERROR ไม่ทิ้ง', async () => {
    const intake = app.get(OrderIntakeService);
    const real = intake.upsertOrder.bind(intake);
    const spy = vi.spyOn(intake, 'upsertOrder').mockImplementationOnce(async (input, tx) =>
      // ครั้งแรกส่ง id ผิดรูปเข้าไป (จำลองกฎรูปแบบที่ mapper ไม่รู้จัก)
      real({ ...input, vehicleTypeId: 'not-a-uuid' }, tx),
    );
    try {
      mock.push(tenantId, ext('FALLBACK-1'));
      const r = await svc.pull(tenantId, 'mock');
      const x = r.results.find((y) => y.externalId === 'FALLBACK-1')!;
      expect(x).toMatchObject({ outcome: 'created', fallback: true, status: 'ON_HOLD' });
      const o = await db.salesOrder.findFirst({
        where: { tenantId, externalId: 'FALLBACK-1' },
        include: { lines: true },
      });
      expect(o!.sourceIssues).toEqual(['รับข้อมูลไม่ได้: vehicleTypeId invalid_id']);
      expect(o!.lines).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('externalId ซ้ำกับใบกรอกมือ → conflict ไม่ทับใบเดิม · เลื่อน cursor ต่อ (ผลสุดท้าย)', async () => {
    const manual = await app.get(DbService).withTenant(tenantId, (tx) =>
      requestContext.run(
        { requestId: randomUUID(), tenantId, actorId: 'user-test', locale: 'th', tx },
        async () => {
          const sites = await tx.customerSite.findMany({
            where: { externalId: { in: ['S-ORG', 'S-DST'] } },
          });
          const input: UpsertOrderInput = {
            source: 'MANUAL',
            externalId: 'DUP-1',
            customer: { externalId: 'C-001' },
            requestedDate: today,
            stops: sites.map((s, i) => ({ type: i ? 'DELIVERY' : 'PICKUP', siteId: s.id })),
          };
          return app.get(OrderIntakeService).upsertOrder(input, tx);
        },
      ),
    );
    const start = Number((await cursorRow())!.cursor);
    mock.push(tenantId, ext('DUP-1', { customerRef: 'จาก ERP' }));
    const r = await svc.pull(tenantId, 'mock');
    expect(r.results.find((x) => x.externalId === 'DUP-1')).toMatchObject({
      outcome: 'conflict',
      error: { code: 'external_id_conflict' },
    });
    const o = await db.salesOrder.findUniqueOrThrow({ where: { id: manual.order.id } });
    expect([o.source, o.customerRef, o.version]).toEqual(['MANUAL', null, manual.order.version]);
    expect((await cursorRow())!.cursor).toBe(String(start + 1));
  });

  it('ต้นทางแก้ใบหลังวางแผน → locked (ไม่ทับข้อมูล — diff เป็นงาน ST3-T10) · ช่องที่แก้ได้ (เลข PO) ยังรับ', async () => {
    mock.push(tenantId, ext('PLAN-1'));
    await svc.pull(tenantId, 'mock');
    const o = await db.salesOrder.findFirstOrThrow({
      where: { tenantId, externalId: 'PLAN-1' },
      include: { stops: true },
    });
    await db.salesOrder.update({ where: { id: o.id }, data: { status: 'PLANNED' } });
    // เปลี่ยนปลายทาง (ล็อกหลังวางแผน)
    mock.push(
      tenantId,
      ext('PLAN-1', {
        stops: [
          { type: 'PICKUP', siteCode: 'S-ORG' },
          { type: 'DELIVERY', text: 'ปลายทางใหม่' },
        ],
      }),
    );
    const r = await svc.pull(tenantId, 'mock');
    expect(r.results[0]).toMatchObject({
      externalId: 'PLAN-1',
      outcome: 'locked',
      error: { code: 'order_locked_for_update' },
    });
    const after = await db.salesOrder.findUniqueOrThrow({
      where: { id: o.id },
      include: { stops: true },
    });
    expect(after.version).toBe(o.version);
    expect(after.stops.map((s) => s.siteId)).toEqual(o.stops.map((s) => s.siteId));
    // เลข PO แก้ได้ที่ PLANNED
    mock.push(tenantId, ext('PLAN-1', { customerRef: 'PO-ใหม่' }));
    const r2 = await svc.pull(tenantId, 'mock');
    expect(r2.results[0]).toMatchObject({ outcome: 'updated', status: 'PLANNED' });
  });

  it('แยก tenant: order/cursor ของแต่ละบริษัทแยกกัน · รหัสลูกค้าของบริษัทอื่นไม่ถูกจับคู่', async () => {
    const before = (await orders()).length;
    mock.push(otherId, ext('OTHER-1'), ext('OTHER-2'));
    const r = await svc.pull(otherId, 'mock');
    expect(r.counts).toMatchObject({ created: 2, held: 2 });
    const theirs = await orders(otherId);
    expect(theirs.map((o) => o.externalId)).toEqual(['OTHER-1', 'OTHER-2']);
    // C-001 / S-ORG ไม่มีในบริษัทอื่น → ลูกค้า/สถานที่ไม่จับคู่
    expect(theirs.every((o) => o.customerId === null && o.stops.every((s) => !s.siteId))).toBe(
      true,
    );
    expect(theirs.map((o) => o.holdReasonCode?.code)).toEqual([
      'CUSTOMER_UNMAPPED',
      'CUSTOMER_UNMAPPED',
    ]);
    expect((await orders()).length).toBe(before);
    expect((await cursorRow(otherId))!.cursor).toBe('2');
    // RLS: tenant หนึ่งไม่เห็นแถว cursor ของอีก tenant
    const seen = await app
      .get(DbService)
      .withTenant(tenantId, (tx) => tx.connectorCursor.findMany({ select: { tenantId: true } }));
    expect(seen.map((x) => x.tenantId)).toEqual([tenantId]);
  });

  it('call path: ทุกใบเรียก OrderIntakeService.upsertOrder ด้วยที่มา ERP:{connector}', async () => {
    const intake = app.get(OrderIntakeService);
    const spy = vi.spyOn(intake, 'upsertOrder');
    try {
      mock.push(otherId, ext('PATH-1'), ext('PATH-2'));
      await svc.pull(otherId, 'mock');
      expect(spy).toHaveBeenCalledTimes(2);
      for (const [input] of spy.mock.calls)
        expect(input).toMatchObject({ source: { source: 'CONNECTOR', connector: 'mock' } });
    } finally {
      spy.mockRestore();
    }
  });

  it('cursor: ดึงทีละหน้า เลื่อนหลังรับครบทั้งหน้า · ใบที่ล้มไม่คาดคิด → ไม่เลื่อน รอบหน้าดึงซ้ำได้ครบ', async () => {
    const t = (await createTenantWithDefaults(db, { name: 'บริษัท cursor' })).id;
    await company(t);
    mock.push(t, ...Array.from({ length: 10 }, (_, i) => ext(`CUR-${String(i).padStart(2, '0')}`)));
    const intake = app.get(OrderIntakeService);
    const real = intake.upsertOrder.bind(intake);
    let n = 0;
    const spy = vi.spyOn(intake, 'upsertOrder').mockImplementation(async (input, tx) => {
      if (++n === 6) throw new Error('db hiccup'); // ใบที่ 6 (หน้า 2)
      return real(input, tx);
    });
    try {
      const r = await svc.pull(t, 'mock', { pageSize: 4 });
      expect(r.pages).toBe(2);
      expect(r.counts).toMatchObject({ created: 7, error: 1 });
      const c = await cursorRow(t);
      expect(c!.cursor).toBe('4'); // หน้า 2 ยังไม่ครบ
      expect(c!.lastSuccessAt).toBeNull();
      expect(c!.leaseId).toBeNull();
      expect((c!.lastResult as { ok: boolean }).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
    const r2 = await svc.pull(t, 'mock', { pageSize: 4 });
    expect(r2.counts).toMatchObject({ created: 3, unchanged: 3, error: 0 });
    expect(r2.pages).toBe(2);
    expect((await cursorRow(t))!.cursor).toBe('10');
    expect(await db.salesOrder.count({ where: { tenantId: t } })).toBe(10);

    // ต้นทางล่ม → ไม่เลื่อน cursor, ผลบันทึก sourceError
    mock.failNext = new Error('ERP unreachable');
    const r3 = await svc.pull(t, 'mock');
    expect(r3.sourceError).toBe('ERP unreachable');
    const c3 = await cursorRow(t);
    expect(c3!.cursor).toBe('10');
    expect((c3!.lastResult as { sourceError: string }).sourceError).toBe('ERP unreachable');
  });

  it('ดึงพร้อมกัน 2 รอบ (tenant + connector เดียวกัน) → รอบเดียวทำงาน อีกรอบ skipped · ไม่เกิดใบซ้ำ', async () => {
    const t = (await createTenantWithDefaults(db, { name: 'บริษัท พร้อมกัน' })).id;
    await company(t);
    mock.push(t, ...Array.from({ length: 5 }, (_, i) => ext(`CON-${i}`)));
    mock.delayMs = 300;
    const [a, b] = await Promise.all([svc.pull(t, 'mock'), svc.pull(t, 'mock')]);
    expect([a.skipped ?? null, b.skipped ?? null].sort()).toEqual(['in_progress', null].sort());
    expect(a.counts.created + b.counts.created).toBe(5);
    expect(await db.salesOrder.count({ where: { tenantId: t } })).toBe(5);
    // lease หมดอายุ (worker ตาย) → รอบใหม่หยิบได้
    await db.connectorCursor.update({
      where: { tenantId_connectorKey: { tenantId: t, connectorKey: 'mock' } },
      data: { leaseId: randomUUID(), leaseUntil: new Date(Date.now() - 1000) },
    });
    mock.delayMs = 0;
    expect((await svc.pull(t, 'mock')).skipped).toBeUndefined();
  });

  it('job connector.pull: JobQueue รันต่อ tenant → order เข้า · connector ไม่รู้จัก → job ล้ม', async () => {
    const t = (await createTenantWithDefaults(db, { name: 'บริษัท job' })).id;
    await company(t);
    mock.push(t, ext('JOB-1'), ext('JOB-2', { customer: { code: 'NEW' } }));
    const queue = app.get(JobQueue);
    const job = await app.get(DbService).withTenant(t, (tx) => svc.enqueue(tx, t, 'mock'));
    expect(job.type).toBe(CONNECTOR_PULL_JOB);
    while (await queue.runOnce()) {
      /* ทำจนคิวว่าง */
    }
    const done = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe('SUCCEEDED');
    expect(done.result).toMatchObject({ connector: 'mock', counts: { created: 2, held: 2 } });
    expect(await db.salesOrder.count({ where: { tenantId: t } })).toBe(2);

    const bad = await app.get(DbService).withTenant(t, (tx) =>
      app.get(JobQueue).enqueue(tx, {
        tenantId: t,
        type: CONNECTOR_PULL_JOB,
        payload: { connector: 'nope' },
        maxAttempts: 1,
      }),
    );
    while (await queue.runOnce()) {
      /* ทำจนคิวว่าง */
    }
    const failed = await db.job.findUniqueOrThrow({ where: { id: bad.id } });
    expect(failed.status).toBe('FAILED');
    expect(JSON.stringify(failed.error)).toContain("connector 'nope' is not registered");
  });

  it('production ไม่รับต้นทางจำลอง (เหมือน GEO_PROVIDER=mock)', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new MockOrderSource()).toThrow(/only allowed in development\/test/);
      expect(new OrderSourceRegistry().get('mock')).toBeNull();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
