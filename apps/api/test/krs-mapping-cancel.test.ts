import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import { ConnectorIntakeService } from '../src/modules/connectors/connector-intake.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { connectorKeyOfSource } from '../src/modules/erp/external-mapping.service';
import { OrderIntakeService, SOURCE_DOWN_ISSUE } from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST8-T05 mapping ลูกค้า NSF ↔ PP ใน external_mapping + SO ที่ KRS ยกเลิก + SO ที่แก้หลังวางแผน (docs/01 A.4; docs/04 C)
 * เกณฑ์ตรวจรับ: SO ลูกค้าใหม่ค้าง CUSTOMER_UNMAPPED · map ครั้งเดียวได้ mapping 2 รหัส · SO ที่ยกเลิกใน mock ถูกยกเลิกใน TMS
 */

const KEY = 'krs-map-test-key-7f21a0';
const SO = (n: number) => `SAMPLE-SO-6911-00${String(n).padStart(2, '0')}`;
const EXT = (n: number) => `KRS-SAMPLE-${SO(n)}`;

describe('connectorKeyOfSource (ST8-T05) — ไม่แตะฐานข้อมูล', () => {
  it('ป้ายที่มา ERP:{key} เท่านั้น · KRS ไม่เดารหัสในระบบบัญชีจากรหัส SO ([OPEN — KRS A.6])', () => {
    expect(connectorKeyOfSource('ERP:krs')).toBe('krs');
    expect(connectorKeyOfSource('API')).toBeNull();
    expect(connectorKeyOfSource('ERP:')).toBeNull();
    expect(connectorKeyOfSource('ERP:KRS')).toBeNull();
    expect('deriveCustomerCode' in new KrsAdapter()).toBe(false);
  });
});

describe('KRS mapping ลูกค้า + ยกเลิก SO (ST8-T05) — mock → order', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let mock: MockKrs;
  let svc: ConnectorIntakeService;
  let tenantId: string;
  let token: string;
  let connectorId: string;
  let connectorPub: string;
  let custA: string; // มี externalId SAMPLE-C001
  let custB: string; // ลูกค้าใหม่ — ยังไม่จับคู่
  let plannerId: string;
  let seq = 0;
  const prevPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const today = bangkokToday();

  const order = (ext: string) =>
    plat.salesOrder.findFirstOrThrow({
      where: { tenantId, externalId: ext },
      include: { holdReasonCode: { select: { code: true } } },
    });
  const mappings = (customerId: string) =>
    plat.externalMapping.findMany({
      where: { tenantId, entityType: 'CUSTOMER', localId: customerId },
    });
  const pull = () => svc.pullConnector(tenantId, connectorId);
  const rewind = () =>
    plat.connectorCursor.updateMany({ where: { tenantId, connectorId }, data: { cursor: null } });
  const newSo = (n: number, customerCode: string, extra: Record<string, unknown> = {}) =>
    mock.salesOrders.upsert({
      company: 'SAMPLE',
      soNo: SO(n),
      soDate: today,
      customerCode,
      customerName: `ลูกค้าตาม KRS ${customerCode}`,
      deliveryDate: today,
      originName: 'คลังตัวอย่าง บางนา',
      destinationName: `ร้านตัวอย่าง ${n}`,
      lines: [
        { lineNo: 1, itemCode: 'SAMPLE-ITEM-01', itemName: 'ค่าขนส่ง', qty: '1', unit: 'เที่ยว' },
      ],
      ...extra,
    });

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    await truncateAll();
    app = await bootApp();
    svc = app.get(ConnectorIntakeService);
    mock = await startMockKrs({ apiKey: KEY });

    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท mapping KRS' })).id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    const co = await plat.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล PP', taxId: validTaxId(8101) },
    });
    await plat.branch.create({
      data: {
        tenantId,
        companyId: co.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
    const owner = await plat.role.findFirstOrThrow({ where: { tenantId, code: 'owner' } });
    const u = await plat.appUser.create({
      data: { tenantId, email: 'admin@krs-map.test', name: 'ผู้ดูแล', status: 'ACTIVE' },
    });
    await plat.userRole.create({ data: { tenantId, userId: u.id, roleId: owner.id } });
    plannerId = u.id;
    token = await tokenFor(tenantId, '*', u.id);
    custA = (
      await api(app, token)
        .post('/v1/customers')
        .send({
          legalName: 'บริษัทตัวอย่าง ก จำกัด',
          taxId: validTaxId(8102),
          externalId: 'SAMPLE-C001',
        })
        .expect(201)
    ).body.id;
    custB = (
      await api(app, token)
        .post('/v1/customers')
        .send({ legalName: 'บริษัทตัวอย่าง ข จำกัด', taxId: validTaxId(8103) })
        .expect(201)
    ).body.id;

    const c = await api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'krs',
        settings: { baseUrl: mock.apiBaseUrl },
        credentials: { apiKey: KEY },
      });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    connectorPub = c.body.id;
    connectorId = tryDecodeId('connector', connectorPub)!;
    await api(app, token)
      .post(`/v1/connectors/${connectorPub}/resume`)
      .send({ reason: 'เริ่มทดสอบ mapping' })
      .expect(200);
  });
  afterAll(async () => {
    if (prevPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = prevPrivate;
    await mock?.stop();
    await app?.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: SO ของลูกค้าใหม่ค้าง CUSTOMER_UNMAPPED · แท็บรหัสระบบบัญชีของลูกค้ายัง "ยังไม่ map"', async () => {
    const r = await pull();
    expect(r.counts).toMatchObject({ created: 4, skipped: 1, error: 0 });
    const o2 = await order(EXT(2));
    expect(o2.customerExternalId).toBe('SAMPLE-C002');
    expect(o2.customerId).toBeNull();
    expect(o2.holdReasonCode?.code).toBe('CUSTOMER_UNMAPPED');
    const codes = await api(app, token).get(`/v1/customers/${custB}/erp-codes`).expect(200);
    expect(codes.body.data).toEqual([
      {
        connector: { id: connectorPub, adapterKey: 'krs', displayName: 'KRS', status: 'ACTIVE' },
        externalId: null,
        sourceCode: null,
        status: 'UNMAPPED',
        updatedAt: null,
        version: 0,
      },
    ]);
  });

  it('เกณฑ์ตรวจรับ (บางส่วน — [OPEN — KRS A.6]): map ลูกค้าที่หน้าใบค้าง → จำรหัส NSF (ใช้ดึง) อย่างเดียว · รหัส PP คนกรอกที่หน้าลูกค้า → mapping เดียวมี 2 รหัส · SO ถัดไปจับคู่เอง', async () => {
    const o2 = await order(EXT(2));
    const m = await api(app, token)
      .post(`/v1/orders/${encodeId('salesOrder', o2.id)}/map-customer`)
      .send({ customerId: custB })
      .expect(200);
    expect(m.body.aliasLearning).toBe('learned');
    const b = tryDecodeId('customer', custB)!;
    let rows = await mappings(b);
    expect(rows).toHaveLength(1);
    // ไม่เดารหัสในระบบบัญชี — ประตูก่อนส่ง (ST8-T06) ยังกัน custOrSuppCode ที่ว่าง
    expect(rows[0]).toMatchObject({
      connectorId,
      sourceCode: 'SAMPLE-C002',
      externalId: null,
      status: 'PENDING',
      createdBy: plannerId,
    });
    expect(await plat.customerAlias.count({ where: { tenantId, source: 'ERP:krs' } })).toBe(0);
    // ผู้มีแค่ orders:write ตั้งรหัสในระบบบัญชีไม่ได้ (settings:write — review M1)
    const ordersOnly = await tokenFor(tenantId, 'orders:write master:read master:write');
    await api(app, ordersOnly)
      .put(`/v1/customers/${custB}/erp-codes/${connectorPub}`)
      .send({ externalId: 'PP-0002' })
      .expect(403);
    const put = await api(app, token)
      .put(`/v1/customers/${custB}/erp-codes/${connectorPub}`)
      .set('If-Match', '"1"')
      .send({ externalId: 'PP-0002' })
      .expect(200);
    expect(put.body).toMatchObject({
      externalId: 'PP-0002',
      sourceCode: 'SAMPLE-C002',
      status: 'SYNCED',
      version: 2,
    });
    rows = await mappings(b);
    expect(rows).toHaveLength(1);
    expect(
      await plat.auditLog.count({
        where: { tenantId, action: 'external_mapping.changed', entityId: b },
      }),
    ).toBe(2);
    // ใบใหม่ของลูกค้าเดิม → จับคู่เองจาก mapping
    newSo(30, 'SAMPLE-C002');
    const r = await pull();
    expect(r.counts).toMatchObject({ created: 1, error: 0 });
    const o30 = await order(EXT(30));
    expect(o30.customerId).toBe(b);
    expect(o30.customerMatchMethod).toBe('ALIAS');
  });

  it('รหัสต้นทางเป็นของลูกค้าอื่น (mapping หรือ alias เดิม) → 409 alias_conflict จนกว่ายืนยัน + เหตุผล · ย้ายครบ · ลูกค้าที่มีรหัสต้นทางแล้วจำรหัสที่ 2 เป็น alias', async () => {
    const b = tryDecodeId('customer', custB)!;
    const a = tryDecodeId('customer', custA)!;
    const newCust = async (n: number) =>
      (
        await api(app, token)
          .post('/v1/customers')
          .send({ legalName: `บริษัทตัวอย่าง ${n} จำกัด`, taxId: validTaxId(8110 + n) })
          .expect(201)
      ).body.id as string;
    const mapTo = (ext: string, customerId: string, extra: Record<string, unknown> = {}) =>
      order(ext).then((o) =>
        api(app, token)
          .post(`/v1/orders/${encodeId('salesOrder', o.id)}/map-customer`)
          .send({ customerId, ...extra }),
      );
    // B มีรหัสต้นทาง SAMPLE-C002 แล้ว → SAMPLE-C999 จำเป็น alias ของช่องทาง (mapping ไม่ทับ)
    expect((await mapTo(EXT(3), custB)).status).toBe(200);
    expect((await mappings(b))[0]!.sourceCode).toBe('SAMPLE-C002');
    expect(
      await plat.customerAlias.count({
        where: { tenantId, source: 'ERP:krs', value: 'SAMPLE-C999', customerId: b },
      }),
    ).toBe(1);

    // (1) ชนกับ mapping ของลูกค้าอื่น: 2 ใบรหัส SAMPLE-C555 → ใบแรกเป็น D · ใบที่สองเลือก A = 409 → ยืนยัน = ย้าย
    newSo(36, 'SAMPLE-C555');
    newSo(37, 'SAMPLE-C555');
    await pull();
    const dPub = await newCust(1);
    const d = tryDecodeId('customer', dPub)!;
    expect((await mapTo(EXT(36), dPub)).status).toBe(200);
    expect((await mappings(d))[0]).toMatchObject({ sourceCode: 'SAMPLE-C555', externalId: null });
    // ให้ A มีรหัสต้นทางของตัวเองก่อน (SAMPLE-C888)
    newSo(32, 'SAMPLE-C888');
    await pull();
    expect((await mapTo(EXT(32), custA)).status).toBe(200);
    const c409 = await mapTo(EXT(37), custA);
    expect(c409.status).toBe(409);
    expect(c409.body).toMatchObject({ code: 'alias_conflict', mappedCustomerId: dPub });
    expect((await order(EXT(37))).customerId).toBeNull();
    const ok = await mapTo(EXT(37), custA, {
      confirmReassign: true,
      reason: 'ตรวจกับบัญชีแล้ว รหัสนี้เป็นของลูกค้า ก',
    });
    expect(ok.status).toBe(200);
    // ถอดรหัสต้นทางจาก D (ไม่มีรหัสที่เดาไว้ค้าง) · A มีรหัสต้นทางอื่นแล้ว → alias ของช่องทาง
    expect((await mappings(d))[0]).toMatchObject({ sourceCode: null, externalId: null });
    const moved = await plat.auditLog.findFirst({
      where: { tenantId, action: 'external_mapping.changed', entityId: d, reason: { not: null } },
    });
    expect(moved?.reason).toContain('ลูกค้า ก');
    newSo(38, 'SAMPLE-C555');
    await pull();
    expect((await order(EXT(38))).customerId).toBe(a);

    // (2) ชนกับ alias เดิมของช่องทาง: SAMPLE-C444 จำเป็น alias ของ B แล้ว → ลูกค้า E (ยังไม่มี mapping) ต้องยืนยัน — ไม่ทับเงียบ
    newSo(50, 'SAMPLE-C444');
    newSo(51, 'SAMPLE-C444');
    await pull();
    expect((await mapTo(EXT(50), custB)).status).toBe(200);
    const ePub = await newCust(2);
    const e = tryDecodeId('customer', ePub)!;
    const a409 = await mapTo(EXT(51), ePub);
    expect(a409.status).toBe(409);
    expect(a409.body).toMatchObject({ code: 'alias_conflict', mappedCustomerId: custB });
    expect(await mappings(e)).toHaveLength(0);
    expect(
      (
        await mapTo(EXT(51), ePub, {
          confirmReassign: true,
          reason: 'ลูกค้า จ ใช้รหัสนี้ตามสัญญาใหม่',
        })
      ).status,
    ).toBe(200);
    expect((await mappings(e))[0]).toMatchObject({ sourceCode: 'SAMPLE-C444' });
    expect(
      await plat.customerAlias.findFirst({
        where: { tenantId, source: 'ERP:krs', value: 'SAMPLE-C444' },
      }),
    ).toMatchObject({ customerId: e });
    newSo(52, 'SAMPLE-C444');
    await pull();
    expect((await order(EXT(52))).customerId).toBe(e);
  });

  it('PUT รหัสระบบบัญชี: 412 · 409 รหัสของลูกค้าอื่น · ตั้งใหม่ (ไม่แตะรหัสต้นทาง) · เปลี่ยน/ยกเลิกต้องมีเหตุผล 422 · 404 · สิทธิ์ settings:write', async () => {
    const c = await api(app, token)
      .post('/v1/customers')
      .send({ legalName: 'บริษัทตัวอย่าง ค จำกัด', taxId: validTaxId(8104) })
      .expect(201);
    const cid = tryDecodeId('customer', c.body.id)!;
    const url = `/v1/customers/${c.body.id}/erp-codes/${connectorPub}`;
    await api(app, token)
      .put(url)
      .set('If-Match', '"3"')
      .send({ externalId: 'PP-C010' })
      .expect(412);
    const dup = await api(app, token).put(url).send({ externalId: 'PP-0002' }).expect(409);
    expect(dup.body.code).toBe('external_id_conflict');
    await api(app, token).put(url).send({ externalId: 'bad\u0001code' }).expect(422);
    // ยังไม่มีแถว + null = ไม่สร้างแถว
    expect(
      (await api(app, token).put(url).send({ externalId: null }).expect(200)).body.status,
    ).toBe('UNMAPPED');
    const ok = await api(app, token)
      .put(url)
      .set('If-Match', '"0"')
      .send({ externalId: 'PP-C010' })
      .expect(200);
    expect(ok.body).toMatchObject({
      externalId: 'PP-C010',
      sourceCode: null,
      status: 'SYNCED',
      version: 1,
    });
    expect(ok.header.etag).toBe('"1"');
    // รหัสในระบบบัญชีไม่ใช้จับคู่ SO (ไม่เดารหัสต้นทาง)
    newSo(34, 'PP-C010');
    await pull();
    expect((await order(EXT(34))).customerId).toBeNull();
    // เปลี่ยน/ยกเลิกรหัสที่ตั้งแล้ว ต้องมีเหตุผล
    const noReason = await api(app, token).put(url).send({ externalId: 'PP-C011' }).expect(422);
    expect(noReason.body.errors[0]).toMatchObject({ field: 'reason', code: 'required' });
    await api(app, token).put(url).send({ externalId: null, reason: 'สั้น' }).expect(422);
    const off = await api(app, token)
      .put(url)
      .set('If-Match', '"1"')
      .send({ externalId: null, reason: 'บัญชีแจ้งว่ารหัสนี้ปิดใช้แล้ว' })
      .expect(200);
    expect(off.body).toMatchObject({ externalId: null, status: 'PENDING', version: 2 });
    const aud = await plat.auditLog.findFirst({
      where: { tenantId, action: 'external_mapping.changed', entityId: cid },
      orderBy: { at: 'desc' },
    });
    expect(aud?.reason).toBe('บัญชีแจ้งว่ารหัสนี้ปิดใช้แล้ว');
    await api(app, token)
      .put(`/v1/customers/${c.body.id}/erp-codes/con_${'0'.repeat(32)}`)
      .send({ externalId: 'X' })
      .expect(404);
    const ro = await tokenFor(tenantId, 'master:read');
    await api(app, ro).get(`/v1/customers/${c.body.id}/erp-codes`).expect(200);
    await api(app, ro).put(url).send({ externalId: 'PP-C011' }).expect(403);
    const master = await tokenFor(tenantId, 'master:read master:write');
    await api(app, master).put(url).send({ externalId: 'PP-C011' }).expect(403);
  });

  it('เกณฑ์ตรวจรับ: SO ที่ยกเลิกใน mock (ยังไม่มี DO ในเที่ยว) → ยกเลิกใน TMS อัตโนมัติ (เหตุผล + audit) · ดึงซ้ำไม่ทำซ้ำ', async () => {
    const before = await order(EXT(1));
    expect(before.status).not.toBe('CANCELLED');
    mock.salesOrders.cancel('SAMPLE', SO(1));
    const r = await pull();
    expect(r.counts).toMatchObject({ cancelled: 1, error: 0 });
    expect(r.results.find((x) => x.externalId === EXT(1))).toMatchObject({
      outcome: 'cancelled',
      reason: 'source_cancelled',
      status: 'CANCELLED',
    });
    const after = await order(EXT(1));
    expect(after.status).toBe('CANCELLED');
    expect(after.sourceCancelledAt).toBeTruthy();
    const aud = await plat.auditLog.findFirstOrThrow({
      where: { tenantId, entityId: after.id, action: 'sales_order.cancelled' },
    });
    expect(aud.actorId).toBe('connector:krs');
    expect(aud.reason).toContain('ERP:krs');
    // DO ที่ระบบสร้างรอจัด (ถ้ามี) ถูกยกเลิกตาม
    expect(
      await plat.deliveryOrder.count({
        where: { salesOrderId: after.id, status: { not: 'CANCELLED' } },
      }),
    ).toBe(0);
    await rewind();
    const again = await pull();
    expect(again.counts.error).toBe(0);
    expect(again.results.find((x) => x.externalId === EXT(1))?.outcome).toBe('unchanged');
    expect(
      await plat.auditLog.count({
        where: { tenantId, entityId: after.id, action: 'sales_order.cancelled' },
      }),
    ).toBe(1);
  });

  it('ใบวางแผนแล้ว: KRS แก้ → ไม่ทับ เก็บ diff (SOURCE_CHANGED_AFTER_PLAN) · KRS ยกเลิก → ไม่ยกเลิก แจ้งเตือนครั้งเดียว · KRS กลับมาไม่ยกเลิก → ล้างธง', async () => {
    // ใบจาก KRS ที่จัดรถแล้ว (สร้างผ่านทางเข้าเดียวกันด้วยสถานที่ในข้อมูลหลัก แล้วลงเที่ยว)
    const site = async (name: string) =>
      tryDecodeId(
        'site',
        (
          await api(app, token)
            .post('/v1/customer-sites')
            .send({ name: `${name} ${++seq}`, kind: 'DROPOFF', address: ADDR })
            .expect(201)
        ).body.id,
      )!;
    const units = (await api(app, token).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    const unitTon = tryDecodeId('unit', units.find((x) => x.code === 'TON')!.id)!;
    const ext = EXT(40);
    const origin = await site('คลังต้นทาง');
    const dest = await site('ร้านปลายทาง');
    const db = app.get(DbService);
    const { order: o } = await db.withTenant(tenantId, (tx) =>
      requestContext.run(
        { requestId: randomUUID(), tenantId, actorId: 'connector:krs', locale: 'th', tx },
        () =>
          app.get(OrderIntakeService).upsertOrder(
            {
              source: 'ERP:krs',
              externalId: ext,
              customer: { id: tryDecodeId('customer', custA)! },
              requestedDate: today,
              stops: [
                { type: 'PICKUP', siteId: origin },
                { type: 'DELIVERY', siteId: dest },
              ],
              lines: [{ description: 'ปูนซีเมนต์', qty: '10', unitId: unitTon, weightKg: '10000' }],
            },
            tx,
          ),
      ),
    );
    const [d] = (
      await db.withTenant(tenantId, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'u', locale: 'th', tx },
          () => app.get(DeliveryOrderService).listForOrder(o.id, {}, tx),
        ),
      )
    ).filter((x) => x.status !== 'CANCELLED');
    await api(app, token)
      .post('/v1/trips')
      .send({ tripDate: today, deliveryOrderIds: [encodeId('deliveryOrder', d!.id)] })
      .expect(201);
    expect((await order(ext)).status).toBe('PLANNED');

    // KRS แก้ SO หลังวางแผน → source_changed (ไม่ทับ — ST3-T10)
    newSo(40, 'SAMPLE-C001');
    const edited = await pull();
    expect(edited.results.find((x) => x.externalId === ext)?.outcome).toBe('source_changed');
    const planned = await order(ext);
    expect(planned.status).toBe('PLANNED');
    expect(planned.sourceChangedAfterPlan).toBe(true);
    expect(planned.sourceDiff).toBeTruthy();

    // KRS ยกเลิก → มี DO ในเที่ยว = ไม่ยกเลิก + ธง + audit + แจ้งเตือน (ครั้งเดียว)
    mock.salesOrders.cancel('SAMPLE', SO(40));
    const r = await pull();
    expect(r.counts).toMatchObject({ cancel_alert: 1, error: 0 });
    const held = await order(ext);
    expect(held.status).toBe('PLANNED');
    expect(held.sourceCancelledAt).toBeTruthy();
    expect(held.version).toBe(planned.version + 1);
    expect(
      await plat.auditLog.count({
        where: { tenantId, entityId: held.id, action: 'sales_order.source_cancel_alert' },
      }),
    ).toBe(1);
    const notes = await plat.notification.findMany({
      where: { tenantId, templateCode: 'order.source_cancelled', channel: 'in_app' },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.recipientId).toBe(plannerId);
    expect(notes[0]!.body).toContain('ERP:krs');
    expect(notes[0]!.link).toBe('/so');
    await rewind();
    const again = await pull();
    expect(again.results.find((x) => x.externalId === ext)?.outcome).toBe('unchanged');
    expect(
      await plat.notification.count({
        where: { tenantId, templateCode: 'order.source_cancelled' },
      }),
    ).toBe(notes.length);
    const dto = await api(app, token)
      .get(`/v1/orders/${encodeId('salesOrder', held.id)}`)
      .expect(200);
    expect(dto.body.sourceCancelledAt).toBe(held.sourceCancelledAt!.toISOString());

    // KRS เลิกยกเลิก (ใบกลับมาปกติ) → ล้างธง (ใบยังไม่ถูกยกเลิกใน TMS)
    mock.salesOrders.edit('SAMPLE', SO(40), { cancelled: false });
    await pull();
    const back = await order(ext);
    expect(back.sourceCancelledAt).toBeNull();
    expect(back.status).toBe('PLANNED');
    expect(
      await plat.auditLog.count({
        where: { tenantId, entityId: back.id, action: 'sales_order.source_cancel_cleared' },
      }),
    ).toBe(1);
  });

  it('แข่งกัน: จัดรถเข้าเที่ยวพร้อมกับรอบดึงที่ KRS ยกเลิก → ไม่มีทางได้ใบยกเลิกที่ DO ยังอยู่ในเที่ยว (ล็อก SO ก่อนเสมอ)', async () => {
    const site = async (name: string) =>
      tryDecodeId(
        'site',
        (
          await api(app, token)
            .post('/v1/customer-sites')
            .send({ name: `${name} ${++seq}`, kind: 'DROPOFF', address: ADDR })
            .expect(201)
        ).body.id,
      )!;
    const units = (await api(app, token).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    const ext = EXT(60);
    const origin = await site('คลังแข่ง');
    const dest = await site('ร้านแข่ง');
    const db = app.get(DbService);
    const { order: o } = await db.withTenant(tenantId, (tx) =>
      requestContext.run(
        { requestId: randomUUID(), tenantId, actorId: 'connector:krs', locale: 'th', tx },
        () =>
          app.get(OrderIntakeService).upsertOrder(
            {
              source: 'ERP:krs',
              externalId: ext,
              customer: { id: tryDecodeId('customer', custA)! },
              requestedDate: today,
              stops: [
                { type: 'PICKUP', siteId: origin },
                { type: 'DELIVERY', siteId: dest },
              ],
              lines: [
                {
                  description: 'ปูน',
                  qty: '5',
                  unitId: tryDecodeId('unit', units.find((x) => x.code === 'TON')!.id)!,
                  weightKg: '5000',
                },
              ],
            },
            tx,
          ),
      ),
    );
    const [d] = await plat.deliveryOrder.findMany({
      where: { salesOrderId: o.id, status: { not: 'CANCELLED' } },
    });
    expect(d).toBeTruthy();
    newSo(60, 'SAMPLE-C001', { cancelled: true });
    // ถือล็อกแถว SO ไว้ → จัดรถ + รอบดึงเริ่มพร้อมกันแล้วรอ → ปล่อย
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = plat.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM sales_order WHERE id = ${o.id}::uuid FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 60_000 },
    );
    await isLocked;
    const trip = api(app, token)
      .post('/v1/trips')
      .send({ tripDate: today, deliveryOrderIds: [encodeId('deliveryOrder', d!.id)] })
      .then((r) => r.status);
    const run = pull();
    await new Promise((r) => setTimeout(r, 500));
    release();
    await holder;
    const [tripStatus, r] = await Promise.all([trip, run]);
    const item = r.results.find((x) => x.externalId === ext)!;
    const after = await order(ext);
    const onTrip = await plat.deliveryOrder.count({
      where: { salesOrderId: o.id, status: { not: 'CANCELLED' }, tripId: { not: null } },
    });
    if (after.status === 'CANCELLED') {
      // รอบดึงชนะ: ยกเลิกแล้ว DO ถูกยกเลิกตาม → จัดรถไม่สำเร็จ
      expect(item.outcome).toBe('cancelled');
      expect(onTrip).toBe(0);
      expect(tripStatus).not.toBe(201);
    } else {
      // จัดรถชนะ: รอบดึงเห็น DO ในเที่ยว → แจ้งเตือนแทนการยกเลิก
      expect(tripStatus).toBe(201);
      expect(item.outcome).toBe('cancel_alert');
      expect(after.sourceCancelledAt).toBeTruthy();
      expect(onTrip).toBe(1);
    }
  });

  it('ใบที่ KRS ยกเลิกแต่เป็นของช่องทางอื่น (externalId ชน) → conflict ไม่แตะใบ', async () => {
    const ext = EXT(41);
    const units = (await api(app, token).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    await app.get(DbService).withTenant(tenantId, (tx) =>
      requestContext.run(
        { requestId: randomUUID(), tenantId, actorId: 'api', locale: 'th', tx },
        () =>
          app.get(OrderIntakeService).upsertOrder(
            {
              source: 'API',
              externalId: ext,
              customer: { id: tryDecodeId('customer', custA)! },
              requestedDate: today,
              stops: [
                { type: 'PICKUP', siteText: 'คลัง API' },
                { type: 'DELIVERY', siteText: 'ร้าน API' },
              ],
              lines: [
                {
                  description: 'สินค้า',
                  qty: '1',
                  unitId: tryDecodeId('unit', units.find((x) => x.code === 'TON')!.id)!,
                },
              ],
            },
            tx,
          ),
      ),
    );
    newSo(41, 'SAMPLE-C001', { cancelled: true });
    const r = await pull();
    expect(r.results.find((x) => x.externalId === ext)).toMatchObject({
      outcome: 'conflict',
      error: { code: 'external_id_conflict' },
    });
    expect((await order(ext)).status).not.toBe('CANCELLED');
  });
  it('D-81 · D68-63: ใบเคยวางแผน (ค้าง ALL_RETURNED — DO คืนคลังหมด ไม่มี DO ค้าง) → KRS ยกเลิก = ไม่ยกเลิกอัตโนมัติ แจ้งเตือน (ห้ามเงียบ)', async () => {
    newSo(42, 'SAMPLE-C001');
    await pull();
    const so = await order(EXT(42));
    const rc = await plat.reasonCode.findFirstOrThrow({
      where: { tenantId, category: 'ORDER_HOLD', code: 'ALL_RETURNED' },
    });
    // จำลองใบที่ผ่านการวางแผนมาแล้ว (ทุก DO คืนคลัง → PLANNED → ON_HOLD(ALL_RETURNED))
    await plat.salesOrder.update({
      where: { id: so.id },
      data: { status: 'ON_HOLD', holdReasonCodeId: rc.id },
    });
    const notes = await plat.notification.count({
      where: { tenantId, templateCode: 'order.source_cancelled' },
    });
    mock.salesOrders.cancel('SAMPLE', SO(42));
    const r = await pull();
    expect(r.results.find((x) => x.externalId === EXT(42))).toMatchObject({
      outcome: 'cancel_alert',
      status: 'ON_HOLD',
    });
    const after = await order(EXT(42));
    expect(after.status).toBe('ON_HOLD');
    expect(after.holdReasonCode?.code).toBe('ALL_RETURNED');
    expect(after.sourceCancelledAt).toBeTruthy();
    expect(
      await plat.auditLog.count({
        where: { tenantId, entityId: so.id, action: 'sales_order.source_cancel_alert' },
      }),
    ).toBe(1);
    expect(
      await plat.notification.count({
        where: { tenantId, templateCode: 'order.source_cancelled' },
      }),
    ).toBeGreaterThan(notes);
  });

  it('D-81 · D68-63: แหล่ง SO หาย (view 404) → ทุกใบที่ยังไม่วางแผนของต้นทาง ON_HOLD(SOURCE_ERROR) · ใบวางแผนแล้ว/ยกเลิกแล้วไม่แตะ · connector ERROR + แจ้งผู้ดูแล', async () => {
    const pending = await plat.salesOrder.findMany({
      where: {
        tenantId,
        source: 'CONNECTOR',
        sourceConnector: 'krs',
        status: { in: ['DRAFT', 'RECEIVED', 'ON_HOLD'] },
      },
      include: { holdReasonCode: { select: { code: true } } },
    });
    const preplan = pending.filter(
      (o) => o.status !== 'ON_HOLD' || o.holdReasonCode?.code !== 'ALL_RETURNED',
    );
    expect(preplan.length).toBeGreaterThan(0);
    const others = await plat.salesOrder.findMany({
      where: { tenantId, source: 'CONNECTOR', id: { notIn: preplan.map((o) => o.id) } },
      select: { id: true, status: true, holdReasonCodeId: true, version: true },
    });
    expect(others.some((o) => o.status === 'PLANNED')).toBe(true);
    const notesBefore = await plat.notification.count({
      where: { tenantId, recipientId: plannerId },
    });
    await plat.$executeRaw`UPDATE connector SET settings = jsonb_set(settings, '{baseUrl}', to_jsonb(${`${mock.apiBaseUrl}/missing-view`}::text))
                      WHERE id = ${connectorId}::uuid`;
    const r = await pull();
    expect(r.sourceError).toBeTruthy();
    expect((await plat.connector.findUniqueOrThrow({ where: { id: connectorId } })).status).toBe(
      'ERROR',
    );
    expect(r.sourceHeld).toBe(preplan.length);
    for (const o of preplan) {
      const x = await plat.salesOrder.findUniqueOrThrow({
        where: { id: o.id },
        include: { holdReasonCode: { select: { code: true } } },
      });
      expect(x.status).toBe('ON_HOLD');
      expect(x.holdReasonCode?.code).toBe('SOURCE_ERROR');
      expect(x.sourceIssues).toContain(SOURCE_DOWN_ISSUE);
      const a = await plat.auditLog.findFirstOrThrow({
        where: { tenantId, entityId: o.id, action: 'sales_order.source_held' },
        orderBy: { at: 'desc' },
      });
      expect(a.actorId).toBe('connector:krs');
    }
    // ใบวางแผนแล้ว / ยกเลิกแล้ว / ค้างด้วยเหตุตอนจัดรถ → ไม่แตะ
    for (const o of others)
      expect(
        await plat.salesOrder.findUniqueOrThrow({
          where: { id: o.id },
          select: { id: true, status: true, holdReasonCodeId: true, version: true },
        }),
      ).toEqual(o);
    expect(
      await plat.notification.count({ where: { tenantId, recipientId: plannerId } }),
    ).toBeGreaterThan(notesBefore);
  });
});
