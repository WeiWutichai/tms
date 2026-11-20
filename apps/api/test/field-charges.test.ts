import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '@tms/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const REASON = 'ตรวจใบเสร็จแล้วถูกต้อง';

/**
 * ST4-T13 ค่าใช้จ่ายหน้างาน (docs/04 E2; docs/01 §3.3 do_surcharge / trip_cost) — เกณฑ์ตรวจรับ:
 * เพิ่ม "ค่ารอ" 500 บาท → มีบรรทัดฝั่งขาย VAT_7 (ตามที่บริษัทตั้งรายการไว้) พร้อมรูป รอผู้วางบิลยืนยัน
 * + snapshot ภาษี, ฝั่งซื้อ/ทั้งคู่, ยืนยัน/ปฏิเสธ/ยกเลิก, สิทธิ์, ไฟล์หลักฐานผูกได้รายการเดียว, แยก tenant
 */
describe('field charges (ST4-T13)', () => {
  let app: NestExpressApplication;
  const db = platform();
  const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let seed = 0;
  const as = (role: keyof typeof SYSTEM_ROLES, sub = `user-${role}`) =>
    tokenFor(tenantId, SYSTEM_ROLES[role].permissions.join(' '), sub);

  beforeAll(async () => {
    process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-files-'));
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท หน้างาน' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await appDb.$disconnect();
  });

  /** เที่ยว (สถานะที่ต้องการ) + DO ในเที่ยว 1 ใบ — สร้างตรงที่ฐาน */
  async function trip(
    status: 'PLANNING' | 'DISPATCHED' | 'IN_PROGRESS' | 'COMPLETED' | 'COSTED' = 'DISPATCHED',
    opts: { tid?: string; carrier?: boolean; doStatus?: 'DISPATCHED' | 'BILLED' } = {},
  ) {
    const tid = opts.tid ?? tenantId;
    const n = ++seed;
    const co = await db.company.create({
      data: { tenantId: tid, legalName: `Co FC ${n}`, taxId: validTaxId(3100 + n) },
    });
    const cus = await db.customer.create({
      data: {
        tenantId: tid,
        code: `FC-${n}`,
        legalName: `ลูกค้า ${n}`,
        taxId: validTaxId(3300 + n),
      },
    });
    const site = (k: string) =>
      db.customerSite.create({
        data: { tenantId: tid, code: `FC-${k}${n}`, name: `จุด ${k}${n}`, address: { line1: 'x' } },
      });
    const [a, b] = [await site('A'), await site('B')];
    const carrier = opts.carrier
      ? await db.carrier.create({
          data: {
            tenantId: tid,
            code: `CAR-FC${n}`,
            legalName: `รถร่วม ${n}`,
            taxId: validTaxId(3500 + n),
            entityType: 'JURISTIC',
          },
        })
      : null;
    const vt = await db.vehicleType.create({
      data: { tenantId: tid, code: `FC${n}`, nameTh: `6 ล้อ ${n}`, vehicleClass: '6W' },
    });
    const v = await db.vehicle.create({
      data: {
        tenantId: tid,
        plate: `72-${1000 + n}`,
        plateProvince: 'TH-10',
        plateKey: `72${1000 + n}|TH-10`,
        plateNorm: `72${1000 + n}`,
        vehicleTypeId: vt.id,
        ownership: opts.carrier ? 'SUBCONTRACT' : 'OWN',
        ...(carrier ? { carrierId: carrier.id } : {}),
      },
    });
    const t = await db.trip.create({
      data: {
        tenantId: tid,
        ...(status !== 'PLANNING'
          ? { vehicleId: v.id, vehiclePlateSnapshot: v.plate, vehicleTypeId: vt.id }
          : {}),
        tripNo: `TRP-FC-${n}`,
        tripDate: new Date('2026-11-17'),
        status,
        ...(status !== 'PLANNING' ? { dispatchedAt: new Date() } : {}),
        ...(carrier ? { carrierId: carrier.id, carrierNameSnapshot: carrier.legalName } : {}),
      },
    });
    const so = await db.salesOrder.create({
      data: {
        tenantId: tid,
        soNo: `SO-FC-${n}`,
        source: 'MANUAL',
        customerId: cus.id,
        billingCompanyId: co.id,
        requestedDate: new Date('2026-11-17'),
        status: 'RECEIVED',
        stops: {
          create: [
            { tenantId: tid, sequence: 1, type: 'PICKUP', siteId: a.id, siteText: 'A' },
            { tenantId: tid, sequence: 2, type: 'DELIVERY', siteId: b.id, siteText: 'B' },
          ],
        },
        lines: {
          create: [{ tenantId: tid, lineNo: 1, description: 'x', qtyOrdered: '2', unit: 'TON' }],
        },
      },
      include: { lines: true },
    });
    const d = await db.deliveryOrder.create({
      data: {
        tenantId: tid,
        doNo: `DO-FC-${n}`,
        doDate: new Date('2026-11-17'),
        salesOrderId: so.id,
        customerId: cus.id,
        originSiteId: a.id,
        destSiteId: b.id,
        originStopSeq: 1,
        destStopSeq: 2,
        tripId: t.id,
        status: opts.doStatus ?? 'DISPATCHED',
      },
    });
    return {
      trip: t,
      do: d,
      carrier,
      tripId: encodeId('trip', t.id),
      doId: encodeId('deliveryOrder', d.id),
      url: `/v1/trips/${encodeId('trip', t.id)}/field-charges`,
    };
  }

  const svc = async (code: string, tid = tenantId) =>
    db.serviceItem.findFirstOrThrow({ where: { tenantId: tid, code } });
  const svcId = async (code: string, tid = tenantId) =>
    encodeId('serviceItem', (await svc(code, tid)).id);

  /** อัปโหลดรูปใบเสร็จ (จอง → PUT) คืน doc id */
  async function receipt(token = admin, kind = 'RECEIPT', upload = true): Promise<string> {
    const r = await api(app, token)
      .post('/v1/documents')
      .send({ kind, mime: 'image/png', bytes: PNG.length, filename: 'receipt.png' })
      .expect(201);
    if (upload) {
      const u = new URL(r.body.uploadUrl);
      await request(app.getHttpServer())
        .put(u.pathname + u.search)
        .set('Content-Type', 'application/octet-stream')
        .send(PNG)
        .expect(200);
    }
    return r.body.id as string;
  }

  /** body ที่ใส่รูปใบเสร็จใหม่ให้เสมอ (บังคับ) */
  const withReceipt = async (body: Record<string, unknown>, token = admin) => ({
    ...body,
    evidenceDocumentId: await receipt(token),
  });
  const D = (line: { id: string }) =>
    line.id.startsWith('dsc_') ? `/v1/do-surcharges/${line.id}` : `/v1/trip-costs/${line.id}`;

  it('เกณฑ์ตรวจรับ: "ค่ารอ" 500 บาท → บรรทัดฝั่งขาย VAT_7 พร้อมรูป รอผู้วางบิลยืนยัน → ยืนยัน', async () => {
    // บริษัทตั้ง "ค่ารอ" เป็น VAT 7% / หัก 3% เอง (ค่าเริ่มต้นของระบบ = ยกเว้น — รอนักบัญชี)
    const wait = await svc('WAIT');
    await db.serviceItem.update({
      where: { id: wait.id },
      data: { vatType: 'VAT_7', whtRate: '3.00', version: { increment: 1 } },
    });
    const t = await trip();
    const doc = await receipt();
    const res = await api(app, admin)
      .post(t.url)
      .send({
        side: 'SELL',
        serviceItemId: encodeId('serviceItem', wait.id),
        deliveryOrderId: t.doId,
        sellUnitPrice: '500',
        evidenceDocumentId: doc,
        note: 'รอคิวลงสินค้า 3 ชม.',
      })
      .expect(201);
    expect(res.body.data).toHaveLength(1);
    const line = res.body.data[0];
    expect(line).toMatchObject({
      side: 'SELL',
      status: 'PENDING_CONFIRM',
      tripId: t.tripId,
      deliveryOrderId: t.doId,
      doNo: t.do.doNo,
      serviceItemCode: 'WAIT',
      description: 'ค่ารอ',
      vatType: 'VAT_7',
      whtRate: '3.00',
      qty: '1',
      sellUnitPrice: '500.00',
      sellAmount: '500.00',
      pairedId: null,
      note: 'รอคิวลงสินค้า 3 ชม.',
      createdBy: 'user-test',
      decidedAt: null,
      version: 1,
    });
    expect(line.id).toMatch(/^dsc_[0-9a-f]{32}$/);
    expect(line.evidence).toMatchObject({ id: doc, mime: 'image/png' });
    expect(line.evidence.downloadUrl).toContain(`/v1/documents/${doc}/content?`);

    // แก้ catalog ภายหลัง → บรรทัดเดิมไม่เปลี่ยน (snapshot)
    await db.serviceItem.update({
      where: { id: wait.id },
      data: { vatType: 'EXEMPT_TRANSPORT', whtRate: '1.00', nameTh: 'ค่ารอคิว' },
    });
    const list = await api(app, admin).get(t.url).expect(200);
    expect(list.body.data[0]).toMatchObject({
      vatType: 'VAT_7',
      whtRate: '3.00',
      description: 'ค่ารอ',
    });
    const row = await db.doSurcharge.findFirstOrThrow({ where: { tripId: t.trip.id } });
    expect(row).toMatchObject({ status: 'PENDING_CONFIRM', vatType: 'VAT_7' });
    expect(row.serviceItemVersion).toBe(wait.version + 1);
    expect((row.serviceItemSnapshot as { code: string }).code).toBe('WAIT');
    const sd = await db.storedDocument.findFirstOrThrow({ where: { entityId: row.id } });
    expect(sd.entityType).toBe('do_surcharge');

    // maker-checker: ผู้บันทึกยืนยันเองไม่ได้
    const self = await api(app, admin)
      .post(`${D(line)}/confirm`)
      .send({ reason: REASON })
      .expect(403);
    expect(self.body.code).toBe('self_approval_forbidden');
    // ST6-T07 review H1: บันทึกด้วย API key → ผู้ออก key = ผู้บันทึก (ยืนยันเองไม่ได้)
    const k = await db.apiKey.create({
      data: {
        tenantId,
        name: 'ERP บันทึกค่าหน้างาน',
        mode: 'live',
        prefix: 'tk_live_fc01',
        secretHash: `test-${randomUUID()}`,
        scopes: ['trips:read'],
        ipAllowlist: [],
        createdBy: 'user-keyowner',
      },
    });
    await db.doSurcharge.update({ where: { id: row.id }, data: { createdBy: `apikey:${k.id}` } });
    const viaKey = await api(app, await as('invoicer', 'user-keyowner'))
      .post(`${D(line)}/confirm`)
      .send({ reason: REASON })
      .expect(403);
    expect(viaKey.body.code).toBe('self_approval_forbidden');
    await db.doSurcharge.update({ where: { id: row.id }, data: { createdBy: 'user-test' } });

    // ผู้วางบิลยืนยัน (เหตุผล + audit)
    const inv = await as('invoicer');
    const ok = await api(app, inv)
      .post(`${D(line)}/confirm`)
      .set('If-Match', '"1"')
      .send({ reason: REASON })
      .expect(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.body).toMatchObject({
      status: 'CONFIRMED',
      decidedBy: 'user-invoicer',
      decisionReason: REASON,
      version: 2,
    });
    expect((await db.doSurcharge.findUniqueOrThrow({ where: { id: row.id } })).approvedBy).toBe(
      'user-invoicer',
    );
    const audits = await db.auditLog.findMany({
      where: { entityId: row.id },
      orderBy: { seq: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['do_surcharge.created', 'do_surcharge.confirmed']);
    expect(audits[1]!.reason).toBe(REASON);
    await api(app, inv)
      .post(`${D(line)}/confirm`)
      .send({ reason: REASON })
      .expect(409);
  });

  it('ฝั่งซื้อ: ทางด่วน 180 → trip_cost MANUAL รอยืนยัน (vat_amount 0, ธงภาษีจากรายการ, ผูกรถร่วมของเที่ยว) · ยืนยัน/ปฏิเสธ = settlements:approve', async () => {
    const t = await trip('IN_PROGRESS', { carrier: true });
    const toll = await svc('TOLL');
    const res = await api(app, admin)
      .post(t.url)
      .send(
        await withReceipt({
          side: 'BUY',
          serviceItemId: encodeId('serviceItem', toll.id),
          costAmount: '180.00',
        }),
      )
      .expect(201);
    const line = res.body.data[0];
    expect(line).toMatchObject({
      side: 'BUY',
      status: 'PENDING_CONFIRM',
      deliveryOrderId: null,
      costType: 'TOLL',
      buyAmount: '180.00',
      vatType: toll.vatType,
      whtRate: toll.whtRate.toFixed(2),
    });
    expect(line.id).toMatch(/^tco_[0-9a-f]{32}$/);
    const row = await db.tripCost.findFirstOrThrow({ where: { tripId: t.trip.id } });
    expect(row).toMatchObject({
      source: 'MANUAL',
      sourceType: 'FIELD',
      costType: 'TOLL',
      carrierId: t.carrier!.id,
      status: 'PENDING_CONFIRM',
      settlementLineId: null,
    });
    expect(row.vatAmount.toFixed(2)).toBe('0.00');
    // ผู้วางบิลไม่มี settlements:approve → 403 · ผู้อนุมัติปฏิเสธได้
    await api(app, await as('invoicer'))
      .post(`${D(line)}/reject`)
      .send({ reason: 'ไม่มีใบเสร็จทางด่วนแนบมา' })
      .expect(403);
    const approver = await as('approver');
    const rj = await api(app, approver)
      .post(`${D(line)}/reject`)
      .send({ reason: 'ใบเสร็จอ่านไม่ออก ขอถ่ายใหม่' })
      .expect(200);
    expect(rj.body).toMatchObject({ status: 'REJECTED', decidedBy: 'user-approver' });
    await api(app, approver)
      .post(`${D(line)}/confirm`)
      .send({ reason: REASON })
      .expect(409);
  });

  it('ทั้งสองฝั่ง (BOTH): 2 บรรทัดคู่ รูปเดียวกัน · จำนวน × ราคา ปัดครึ่งขึ้น · ยกเลิกฝั่งหนึ่ง = ยกเลิกทั้งคู่ (audit ทั้งคู่)', async () => {
    const t = await trip('COMPLETED');
    const doc = await receipt();
    const res = await api(app, admin)
      .post(t.url)
      .send({
        side: 'BOTH',
        serviceItemId: await svcId('OVERNIGHT'),
        deliveryOrderId: t.doId,
        qty: '1.5',
        sellUnitPrice: '333.33',
        costAmount: '400',
        evidenceDocumentId: doc,
      })
      .expect(201);
    const s = res.body.data.find((x: { side: string }) => x.side === 'SELL');
    const b = res.body.data.find((x: { side: string }) => x.side === 'BUY');
    expect(s).toMatchObject({ qty: '1.5', sellUnitPrice: '333.33', sellAmount: '500.00' });
    expect(b).toMatchObject({ buyAmount: '400.00', costType: 'OTHER', pairedId: s.id });
    expect(s.pairedId).toBe(b.id);
    expect(s.evidence.id).toBe(doc);
    expect(b.evidence.id).toBe(doc);
    const cost = await db.tripCost.findFirstOrThrow({ where: { tripId: t.trip.id } });
    expect(cost).toMatchObject({ sourceType: 'DO_SURCHARGE' });
    expect(cost.sourceId).toBe(cost.doSurchargeId);

    const why = 'บันทึกผิดเที่ยว จะบันทึกใหม่';
    await api(app, admin)
      .post(`${D(b)}/cancel`)
      .send({ reason: why })
      .expect(200);
    const all = (await api(app, admin).get(t.url).expect(200)).body.data;
    expect(all.map((x: { status: string }) => x.status)).toEqual(['CANCELLED', 'CANCELLED']);
    const audits = await db.auditLog.findMany({
      where: { action: { in: ['do_surcharge.cancelled', 'trip_cost.cancelled'] } },
    });
    expect(audits.filter((a) => [cost.id, cost.doSurchargeId].includes(a.entityId))).toHaveLength(
      2,
    );
    expect(audits.every((a) => a.reason === why)).toBe(true);
  });

  it('ตรวจข้อมูล: ช่องที่ต้องมี/ไม่ใช้, รูปบังคับ, ยอด > 0, DO ต้องอยู่ในเที่ยว, รายการต้องเป็นค่าบริการเสริมแบบบาท', async () => {
    const t = await trip();
    const t2 = await trip();
    const wait = await svcId('WAIT');
    const doc = `doc_${'0'.repeat(32)}`;
    const bad: [object, string, string][] = [
      [
        { side: 'SELL', serviceItemId: wait, sellUnitPrice: '1', evidenceDocumentId: doc },
        'deliveryOrderId',
        'required',
      ],
      [
        { side: 'SELL', serviceItemId: wait, deliveryOrderId: t.doId, evidenceDocumentId: doc },
        'sellUnitPrice',
        'required',
      ],
      [{ side: 'BUY', serviceItemId: wait, evidenceDocumentId: doc }, 'costAmount', 'required'],
      [
        { side: 'BUY', serviceItemId: wait, costAmount: '10' },
        'evidenceDocumentId',
        'evidence_required',
      ],
      [
        { side: 'SELL', serviceItemId: wait, deliveryOrderId: t.doId, sellUnitPrice: '1' },
        'evidenceDocumentId',
        'evidence_required',
      ],
      [
        {
          side: 'BUY',
          serviceItemId: wait,
          costAmount: '1',
          sellUnitPrice: '1',
          evidenceDocumentId: doc,
        },
        'sellUnitPrice',
        'not_applicable',
      ],
      [
        {
          side: 'SELL',
          serviceItemId: wait,
          deliveryOrderId: t.doId,
          sellUnitPrice: '1',
          qty: '0',
          evidenceDocumentId: doc,
        },
        'qty',
        'out_of_range',
      ],
      [
        {
          side: 'SELL',
          serviceItemId: wait,
          deliveryOrderId: t.doId,
          sellUnitPrice: '0',
          evidenceDocumentId: doc,
        },
        'sellUnitPrice',
        'out_of_range',
      ],
      [
        { side: 'BUY', serviceItemId: wait, costAmount: '0', evidenceDocumentId: doc },
        'costAmount',
        'out_of_range',
      ],
    ];
    for (const [body, field, code] of bad) {
      const r = await api(app, admin).post(t.url).send(body).expect(422);
      expect(r.body.errors, JSON.stringify(body)).toContainEqual(
        expect.objectContaining({ field, code }),
      );
    }
    const ref: [object, string, string][] = [
      [
        { side: 'SELL', serviceItemId: wait, deliveryOrderId: t2.doId, sellUnitPrice: '1' },
        'deliveryOrderId',
        'invalid_reference',
      ],
      [
        { side: 'BUY', serviceItemId: await svcId('FSC'), costAmount: '1' },
        'serviceItemId',
        'service_item_not_field',
      ],
      [
        { side: 'BUY', serviceItemId: await svcId('FREIGHT'), costAmount: '1' },
        'serviceItemId',
        'service_item_not_field',
      ],
      [
        { side: 'BUY', serviceItemId: `svc_${'0'.repeat(32)}`, costAmount: '1' },
        'serviceItemId',
        'service_item_not_found',
      ],
    ];
    for (const [body, field, code] of ref) {
      const r = await api(app, admin)
        .post(t.url)
        .send(await withReceipt(body as never))
        .expect(422);
      expect(r.body.errors, JSON.stringify(body)).toContainEqual(
        expect.objectContaining({ field, code }),
      );
    }
    for (const body of [
      { side: 'SELL', serviceItemId: wait, deliveryOrderId: t.doId, sellUnitPrice: '1.234' },
      { side: 'X', serviceItemId: wait },
      { side: 'BUY', serviceItemId: wait, costAmount: '-5' },
    ])
      await api(app, admin).post(t.url).send(body).expect(422);
    await db.serviceItem.updateMany({ where: { tenantId, code: 'LOAD' }, data: { side: 'SELL' } });
    const side = await api(app, admin)
      .post(t.url)
      .send(
        await withReceipt({
          side: 'BOTH',
          serviceItemId: await svcId('LOAD'),
          deliveryOrderId: t.doId,
          sellUnitPrice: '1',
          costAmount: '1',
        }),
      )
      .expect(422);
    expect(side.body.errors[0]).toMatchObject({
      field: 'serviceItemId',
      code: 'service_item_side',
    });
    expect(await db.doSurcharge.count({ where: { tripId: t.trip.id } })).toBe(0);
    expect(await db.tripCost.count({ where: { tripId: t.trip.id } })).toBe(0);
    // ฐาน: บรรทัดหน้างานยอด 0 ไม่ได้ (CHECK)
    await expect(
      db.tripCost.create({
        data: {
          tenantId,
          tripId: t.trip.id,
          costType: 'TOLL',
          amount: '0',
          source: 'MANUAL',
          sourceType: 'FIELD',
        },
      }),
    ).rejects.toThrow(/trip_cost_field_amount_check/);
  });

  it('สถานะ: บันทึกได้เฉพาะเที่ยวที่ปล่อยแล้ว · ยืนยันไม่ได้เมื่อ DO วางบิลแล้ว / เที่ยวคิดต้นทุนแล้ว (409)', async () => {
    const wait = await svcId('WAIT');
    for (const st of ['PLANNING', 'COSTED'] as const) {
      const t = await trip(st);
      const r = await api(app, admin)
        .post(t.url)
        .send(await withReceipt({ side: 'BUY', serviceItemId: wait, costAmount: '100' }))
        .expect(409);
      expect(r.body).toMatchObject({ code: 'invalid_state_transition', tripStatus: st });
    }
    const billed = await trip('COMPLETED', { doStatus: 'BILLED' });
    const r = await api(app, admin)
      .post(billed.url)
      .send(
        await withReceipt({
          side: 'SELL',
          serviceItemId: wait,
          deliveryOrderId: billed.doId,
          sellUnitPrice: '100',
        }),
      )
      .expect(409);
    expect(r.body).toMatchObject({ code: 'invalid_state_transition', doStatus: 'BILLED' });

    // บันทึกแล้ว → DO ถูกวางบิล / เที่ยวคิดต้นทุน → ยืนยันไม่ได้ (ปฏิเสธยังได้)
    const t = await trip('COMPLETED');
    const [s, b] = (
      await api(app, admin)
        .post(t.url)
        .send(
          await withReceipt({
            side: 'BOTH',
            serviceItemId: wait,
            deliveryOrderId: t.doId,
            sellUnitPrice: '100',
            costAmount: '80',
          }),
        )
        .expect(201)
    ).body.data.sort((x: { side: string }, y: { side: string }) => (x.side > y.side ? -1 : 1));
    await db.deliveryOrder.update({ where: { id: t.do.id }, data: { status: 'BILLED' } });
    const c1 = await api(app, await as('invoicer'))
      .post(`${D(s)}/confirm`)
      .send({ reason: REASON })
      .expect(409);
    expect(c1.body).toMatchObject({ doStatus: 'BILLED' });
    await db.trip.update({ where: { id: t.trip.id }, data: { status: 'COSTED' } });
    const c2 = await api(app, await as('approver'))
      .post(`${D(b)}/confirm`)
      .send({ reason: REASON })
      .expect(409);
    expect(c2.body).toMatchObject({ tripStatus: 'COSTED' });
    await api(app, await as('approver'))
      .post(`${D(b)}/reject`)
      .send({ reason: 'เที่ยวปิดต้นทุนแล้ว ไม่จ่ายเพิ่ม' })
      .expect(200);
  });

  it('สิทธิ์: ขายต้องแก้ราคาขายได้ · ซื้อ = แก้ราคาซื้อ หรือผู้จ่ายงาน · ยืนยันโดยผู้อื่น · ราคาถูกตัดตามสิทธิ์ดู', async () => {
    const t = await trip();
    const wait = await svcId('WAIT');
    const sellBody = () =>
      withReceipt({
        side: 'SELL',
        serviceItemId: wait,
        deliveryOrderId: t.doId,
        sellUnitPrice: '500',
      });
    const buyBody = () => withReceipt({ side: 'BUY', serviceItemId: wait, costAmount: '200' });
    // dispatcher: ฝั่งขายไม่ได้ (ไม่มี prices.sell:write) · ฝั่งซื้อได้ (trips:dispatch + prices.buy:read) · BOTH ไม่ได้
    const disp = await as('dispatcher');
    await api(app, disp)
      .post(t.url)
      .send(await sellBody())
      .expect(403);
    await api(app, disp)
      .post(t.url)
      .send({ ...(await sellBody()), side: 'BOTH', costAmount: '1' })
      .expect(403);
    const b = (
      await api(app, disp)
        .post(t.url)
        .send(await buyBody())
        .expect(201)
    ).body.data[0];
    expect(b.createdBy).toBe('user-dispatcher');
    // viewer: ฝั่งซื้อไม่ได้
    const viewer = await as('viewer');
    await api(app, viewer)
      .post(t.url)
      .send(await buyBody())
      .expect(403);
    // planner: ราคาขายไม่ได้
    const planner = await as('planner');
    await api(app, planner)
      .post(t.url)
      .send(await sellBody())
      .expect(403);
    // invoicer: บันทึกฝั่งขายได้ แต่ยืนยันของตัวเองไม่ได้
    const inv = await as('invoicer');
    const s = (
      await api(app, inv)
        .post(t.url)
        .send(await sellBody())
        .expect(201)
    ).body.data[0];
    const self = await api(app, inv)
      .post(`${D(s)}/reject`)
      .send({ reason: REASON })
      .expect(403);
    expect(self.body.code).toBe('self_approval_forbidden');
    // viewer เห็นรายการแต่ไม่เห็นยอด · dispatcher เห็นราคาซื้อ ไม่เห็นราคาขาย
    const v = await api(app, viewer).get(t.url).expect(200);
    expect(v.body.data).toHaveLength(2);
    for (const x of v.body.data) {
      expect(x.sellAmount).toBeUndefined();
      expect(x.buyAmount).toBeUndefined();
    }
    const dv = (await api(app, disp).get(t.url).expect(200)).body.data;
    expect(dv.find((x: { side: string }) => x.side === 'BUY').buyAmount).toBe('200.00');
    expect(dv.find((x: { side: string }) => x.side === 'SELL').sellAmount).toBeUndefined();
    // ยืนยันฝั่งขาย: dispatcher / planner / viewer ไม่ได้ · accounting ได้
    for (const tok of [disp, planner, viewer])
      await api(app, tok)
        .post(`${D(s)}/confirm`)
        .send({ reason: REASON })
        .expect(403);
    await api(app, await as('accounting'))
      .post(`${D(s)}/confirm`)
      .send({ reason: REASON })
      .expect(200);
    // ยืนยันฝั่งซื้อ: ผู้บันทึก (dispatcher) ไม่มีสิทธิ์อยู่แล้ว · ผู้จัดการ (settlements:approve) ได้
    await api(app, disp)
      .post(`${D(b)}/confirm`)
      .send({ reason: REASON })
      .expect(403);
    // ยกเลิก: invoicer ยกเลิกฝั่งซื้อไม่ได้ · ผู้จ่ายงานยกเลิกของที่บันทึกได้
    const b2 = (
      await api(app, disp)
        .post(t.url)
        .send(await buyBody())
        .expect(201)
    ).body.data[0];
    await api(app, inv)
      .post(`${D(b2)}/cancel`)
      .send({ reason: 'บันทึกผิดเที่ยว ขอยกเลิก' })
      .expect(403);
    const c = await api(app, disp)
      .post(`${D(b2)}/cancel`)
      .send({ reason: 'บันทึกผิดเที่ยว ขอยกเลิก' })
      .expect(200);
    expect(c.body).toMatchObject({ status: 'CANCELLED', decidedBy: 'user-dispatcher' });
    const ok = await api(app, await as('manager'))
      .post(`${D(b)}/confirm`)
      .send({ reason: REASON })
      .expect(200);
    expect(ok.body).toMatchObject({ status: 'CONFIRMED', decidedBy: 'user-manager' });
  });

  it('การตัดสิน: เหตุผล 10–500 (error เดียวต่อช่อง) · If-Match ไม่ตรง → 412 · บรรทัดระบบ (CARRIER_FEE) ไม่อยู่ในเส้นทางนี้ → 404', async () => {
    const t = await trip();
    const s = (
      await api(app, admin)
        .post(t.url)
        .send(
          await withReceipt({
            side: 'SELL',
            serviceItemId: await svcId('WAIT'),
            deliveryOrderId: t.doId,
            sellUnitPrice: '100',
          }),
        )
        .expect(201)
    ).body.data[0];
    const inv = await as('invoicer');
    await api(app, inv)
      .post(`${D(s)}/reject`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const empty = await api(app, inv)
      .post(`${D(s)}/reject`)
      .send({})
      .expect(422);
    expect(empty.body.errors).toEqual([
      expect.objectContaining({ field: 'reason', code: 'reason' }),
    ]);
    await api(app, inv)
      .post(`${D(s)}/reject`)
      .set('If-Match', '"7"')
      .send({ reason: REASON })
      .expect(412);
    expect((await db.doSurcharge.findFirstOrThrow({ where: { tripId: t.trip.id } })).status).toBe(
      'PENDING_CONFIRM',
    );
    const fee = await db.tripCost.create({
      data: {
        tenantId,
        tripId: t.trip.id,
        costType: 'CARRIER_FEE',
        amount: '5000',
        source: 'RATE_CARD',
      },
    });
    await api(app, admin)
      .post(`/v1/trip-costs/${encodeId('tripCost', fee.id)}/cancel`)
      .send({ reason: REASON })
      .expect(404);
    expect((await api(app, admin).get(t.url).expect(200)).body.data).toHaveLength(1);
  });

  it('ไฟล์หลักฐาน: ต้องเป็น RECEIPT ที่อัปโหลดเสร็จ และผูกได้รายการเดียว (ไม่ยืมไฟล์ของรายการอื่น)', async () => {
    const t = await trip();
    const wait = await svcId('WAIT');
    const body = (doc: string) => ({
      side: 'BUY',
      serviceItemId: wait,
      costAmount: '50',
      evidenceDocumentId: doc,
    });
    const doc = await receipt();
    await api(app, admin).post(t.url).send(body(doc)).expect(201);
    const reuse = await api(app, admin).post(t.url).send(body(doc)).expect(422);
    expect(reuse.body.errors[0]).toMatchObject({
      field: 'evidenceDocumentId',
      code: 'document_in_use',
    });
    const pending = await api(app, admin)
      .post(t.url)
      .send(body(await receipt(admin, 'RECEIPT', false)))
      .expect(422);
    expect(pending.body.errors[0].code).toBe('not_uploaded');
    const kind = await api(app, admin)
      .post(t.url)
      .send(body(await receipt(admin, 'POD_PHOTO')))
      .expect(422);
    expect(kind.body.errors[0].code).toBe('invalid_kind');
    const pod = await receipt();
    await db.storedDocument.update({
      where: { id: pod.replace(/^doc_/, '').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-') },
      data: { entityType: 'delivery_order', entityId: t.do.id },
    });
    const foreign = await api(app, admin).post(t.url).send(body(pod)).expect(422);
    expect(foreign.body.errors[0].code).toBe('document_in_use');
    const otherDoc = await receipt(other);
    const nf = await api(app, admin).post(t.url).send(body(otherDoc)).expect(422);
    expect(nf.body.errors[0].code).toBe('not_found');
    const race = await receipt();
    const rs = await Promise.all([
      api(app, admin).post(t.url).send(body(race)),
      api(app, admin).post(t.url).send(body(race)),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 422]);
  });

  it('แยก tenant: เที่ยว/บรรทัดของบริษัทอื่น → 404 · ไม่มี hard delete ที่ฐาน', async () => {
    const t = await trip();
    const s = (
      await api(app, admin)
        .post(t.url)
        .send(
          await withReceipt({ side: 'BUY', serviceItemId: await svcId('WAIT'), costAmount: '10' }),
        )
        .expect(201)
    ).body.data[0];
    await api(app, other).get(t.url).expect(404);
    await api(app, other)
      .post(t.url)
      .send(
        await withReceipt(
          { side: 'BUY', serviceItemId: await svcId('WAIT', otherId), costAmount: '10' },
          other,
        ),
      )
      .expect(404);
    await api(app, other)
      .post(`${D(s)}/confirm`)
      .send({ reason: REASON })
      .expect(404);
    const r = await api(app, admin)
      .post(t.url)
      .send(
        await withReceipt({
          side: 'BUY',
          serviceItemId: await svcId('WAIT', otherId),
          costAmount: '10',
        }),
      )
      .expect(422);
    expect(r.body.errors[0].code).toBe('service_item_not_found');
    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`DELETE FROM trip_cost WHERE trip_id = ${t.trip.id}::uuid`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
