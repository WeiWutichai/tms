import type { ReasonCategory } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  ACTIVE_EVENT_TYPES,
  EVENT_REGISTRY,
  PENDING_EVENT_TYPES,
  WEBHOOK_EVENT_TYPES,
  eventDefinition,
  eventSchemaName,
  strictEventSchema,
  type EventSchema,
} from '@tms/domain';
import { priceFieldNames, redactPrices } from '../src/common/price-fields';
import { eventSchemaComponents, publishedEventSchema } from '../src/modules/webhooks/event-openapi';
import Ajv, { type ValidateFunction } from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { JobQueue } from '../src/jobs/job-queue.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { ConnectorsService } from '../src/modules/erp/connectors.service';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { OutboxService } from '../src/modules/integration/outbox.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { OrderStateService } from '../src/modules/orders/order-state.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { WebhookEngine } from '../src/modules/webhooks/webhook-engine';
import { FakeErpAdapter, GOOD_KEY } from './fake-erp-adapter';
import {
  api,
  bootApp,
  platform,
  settleTripCostsForTest,
  tokenFor,
  truncateAll,
  validTaxId,
} from './helpers';

/**
 * ST7-T06 contract test ของ event สาธารณะ (docs/01 §5.3; docs/04 G1) — เกณฑ์ตรวจรับ:
 * "ทุก event ใน 01§5.3 ที่เป็นของเฟส 0 ถูกยิงจริงใน test และตรง schema"
 * - รัน flow จริงผ่าน API/service (order → DO → เที่ยว → จุด → POD → ส่งไม่สำเร็จ/นัดส่งใหม่ → ยกเลิก, connector, งานนำเข้า)
 * - เก็บ domain_event + คำสั่ง outbox ของ subscription `*` แล้วตรวจ `data.object` กับ schema ในทะเบียน (ajv)
 *   + previousAttributes ใช้ชื่อ field ของ object + ไม่มี field ราคา + envelope ตาม G1
 * - event `phase: pending` (invoice/payment/settlement/… ST5–ST6, reconcile ST8) ไม่อยู่ในเกณฑ์ — ตรวจว่าไม่มีใครยิง
 */
describe('event registry contract (ST7-T06)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const fake = new FakeErpAdapter('contract-erp', ['pushInvoice']);

  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  const validators = new Map<string, ValidateFunction>();
  /** ตรวจแบบปิด: schema ที่เผยแพร่ + components ทุกตัว (ปิดทุกชั้น — field ที่ไม่ได้ประกาศใน DTO = ผิด) */
  const validatorOf = (type: string) => {
    const s = publishedEventSchema(type);
    if (!s) return null;
    if (!validators.has(type)) {
      const comps = Object.fromEntries(
        Object.entries(eventSchemaComponents()).map(([k, v]) => [
          k,
          jsonSchema(strictEventSchema(v)),
        ]),
      );
      validators.set(
        type,
        ajv.compile({
          ...(jsonSchema(strictEventSchema(s)) as object),
          components: { schemas: comps },
        }),
      );
    }
    return validators.get(type)!;
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    app.get(ErpAdapterRegistry).replace(fake);
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท สัญญา event' })).id;
    await db.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(931) },
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
    const userId = (
      await db.appUser.create({
        data: { tenantId, email: 'owner@event.test', name: 'ผู้ดูแล event', status: 'ACTIVE' },
      })
    ).id;
    admin = await tokenFor(tenantId, '*', userId);
    // ผู้รับทุก event (`*`) — trigger บน domain_event ต้องสร้างคำสั่งให้ทุก event (ไม่มี event ที่หลุด outbox)
    await app
      .get(DbService)
      .withTenant(tenantId, (tx) =>
        app
          .get(OutboxService)
          .subscribe(tx, { tenantId, kind: 'ADAPTER', sink: 'contract', eventTypes: ['*'] }),
      );
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
    app.get(ErpAdapterRegistry).unregister(fake.key);
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
    uuid(
      'site',
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async () =>
    uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9300 + seed) })
          .expect(201)
      ).body.id,
    );
  /** SO 1 ใบ (ไม่มี rate card → ค้าง RATE_MISSING) + DO ใบแรก */
  const newOrder = async () => {
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: await newCustomer() },
      requestedDate: today,
      stops: [
        { type: 'PICKUP', siteId: await newSite() },
        {
          type: 'DELIVERY',
          siteId: await newSite(),
          windowStart: `${today}T09:00:00+07:00`,
          windowEnd: `${today}T12:00:00+07:00`,
        },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '2', unitId: unitTon, weightKg: '2000' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const dos = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    return { soId: so.id, pub: encodeId('salesOrder', so.id), doId: dos[0]!.id };
  };
  const newVehicle = async () => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `7${++seed % 10}-${String(3000 + seed)}`,
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
        phone: `089-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    return v.id;
  };
  /** เที่ยวจาก DO → จัดรถ (+ ปล่อยรถ) — ข้ามคำเตือนกฎด้วยเหตุผล */
  const trip = async (doId: string, dispatch: boolean) => {
    const vid = await newVehicle();
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({
          tripDate: today,
          deliveryOrderIds: [encodeId('deliveryOrder', doId)],
          vehicleId: vid,
        })
        .expect(201)
    ).body;
    const r = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: vid, dispatch });
    if (r.status !== 200)
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: vid,
          dispatch,
          ruleKeys: r.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบสัญญา event',
        })
        .expect(200);
    const row = await db.deliveryOrder.findUniqueOrThrow({ where: { id: doId } });
    return {
      id: t.id as string,
      pickup: encodeId('tripStop', row.pickupTripStopId!),
      drop: encodeId('tripStop', row.tripStopId!),
    };
  };
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const post = (stop: string, action: string, min: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/stops/${stop}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra })
      .expect(201);
  const reason = async (category: ReasonCategory, code?: string) =>
    encodeId(
      'reasonCode',
      (
        await db.reasonCode.findFirstOrThrow({
          where: { tenantId, category, ...(code ? { code } : {}) },
        })
      ).id,
    );

  /** รูปของค่า (ชื่อ field + ชนิด ทุกชั้น; array ใช้สมาชิกตัวแรก) — เทียบรูป event กับ REST เมื่อค่าเปลี่ยนตามเวลาได้ */
  const shapeOf = (v: unknown): unknown =>
    v === null
      ? 'null'
      : Array.isArray(v)
        ? [v.length ? shapeOf(v[0]) : 'empty']
        : typeof v === 'object'
          ? Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shapeOf(x)]))
          : typeof v;
  /** field ของ OrderDto ที่ขึ้นกับผู้เรียก (ไม่อยู่ใน webhook) */
  const ORDER_OMIT = ['editableFields', 'editLock', 'sellBilling'];
  /** response REST ของ admin (เห็นทุกราคา) → ตัด field ราคา + field ที่ขึ้นกับผู้เรียก = สิ่งที่ webhook ต้องส่ง */
  const rest = async (path: string, omit: string[] = []) => {
    const body = (await api(app, admin).get(path).expect(200)).body as Record<string, unknown>;
    const out = JSON.parse(JSON.stringify(redactPrices(body, []))) as Record<string, unknown>;
    for (const k of omit) delete out[k];
    return out;
  };
  /** event สาธารณะล่าสุดของ object (ชนิดเดียว) */
  const latest = async (type: string, localId: string) =>
    (
      await db.domainEvent.findMany({
        where: { tenantId, type, localId },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      })
    )[0];
  /** event สาธารณะที่เกิดจาก fn (ของ object เดียว) */
  const newEvents = async (localId: string, fn: () => Promise<unknown>) => {
    const before = new Set(
      (await db.domainEvent.findMany({ where: { tenantId, localId }, select: { id: true } })).map(
        (e) => e.id,
      ),
    );
    await fn();
    return (
      await db.domainEvent.findMany({
        where: { tenantId, localId },
        orderBy: { occurredAt: 'asc' },
      })
    ).filter((e) => !before.has(e.id) && eventDefinition(e.type));
  };

  it('ทะเบียน: ครบทุกชื่อ · active มี schema จาก DTO ของ REST (ไม่มีราคา) · pending มี task', () => {
    expect(EVENT_REGISTRY.map((d) => d.type)).toEqual([...WEBHOOK_EVENT_TYPES]);
    const price = priceFieldNames();
    for (const d of EVENT_REGISTRY) {
      expect(d.type.split('.')[0]).toBe(d.resource);
      expect(d.description).toMatch(/[ก-๙]/);
      const s = publishedEventSchema(d.type);
      if (d.phase === 'active') {
        expect(s, d.type).not.toBeNull();
        expect(d.pendingTask).toBeNull();
        const keys = Object.keys(s!.properties!);
        expect(
          keys.filter((k) => price.has(k) || PRICE_WORD.test(k)),
          d.type,
        ).toEqual([]);
        expect(JSON.stringify(s)).not.toContain('"additionalProperties":false'); // เปิด (G1)
      } else {
        expect(s).toBeNull();
        expect(d.pendingTask, d.type).toMatch(/^ST\d-T\d+$/);
      }
    }
    expect(PENDING_EVENT_TYPES).toEqual([
      'invoice.finalized',
      'invoice.adjusted',
      'invoice.paid',
      'invoice.voided',
      'credit_note.finalized',
      'debit_note.finalized',
      'payment.recorded',
      'payment.reversed',
      'receipt.issued',
      'settlement.paid',
      'wht_certificate.issued',
      'reconcile.mismatch_found',
    ]);
  });

  it('GET /v1/webhooks/event-types และ openapi.json เผยแพร่ schema ชุดเดียวกัน · ตัวอย่างตรง schema แบบปิด', async () => {
    const r = await api(app, admin).get('/v1/webhooks/event-types').expect(200);
    expect(r.body.data.map((x: { type: string }) => x.type)).toEqual([...WEBHOOK_EVENT_TYPES]);
    const doc = (await api(app).get('/v1/openapi.json').expect(200)).body;
    for (const x of r.body.data as {
      type: string;
      phase: string;
      schema: EventSchema | null;
      sample: Record<string, unknown>;
    }[]) {
      const d = eventDefinition(x.type)!;
      expect(x.phase).toBe(d.phase);
      expect(x.schema).toEqual(publishedEventSchema(x.type));
      expect(x.sample).not.toHaveProperty('sampleEventType');
      expect(doc['x-webhooks'][d.type]).toMatchObject({ phase: d.phase });
      if (x.schema) {
        const v = validatorOf(d.type)!;
        expect(v(x.sample), `${d.type} ${ajv.errorsText(v.errors)}`).toBe(true);
        expect(doc.components.schemas[eventSchemaName(d.type)]).toEqual(x.schema);
        expect(doc['x-webhooks'][d.type].dto).toBe(d.object!.dto);
      }
    }
    expect(doc.components.schemas.WebhookEnvelope.required).toContain('data');
  });

  it('เกณฑ์ตรวจรับ: flow จริงยิงทุก event ของเฟส 0 · payload ตรง schema · มีคำสั่ง outbox · envelope ตาม G1', async () => {
    // ---- order: created + held (RATE_MISSING) → updated (PATCH) → released (ตั้งราคาเอง) ----
    const a = await newOrder();
    const patched = await newEvents(a.soId, () =>
      api(app, admin).patch(`/v1/orders/${a.pub}`).send({ customerRef: 'PO-EVENT-1' }).expect(200),
    );
    // QA: PATCH → order.updated 1 ตัว · previousAttributes มีค่าเดิม · object = GET /v1/orders/{id}
    expect(patched.map((e) => e.type)).toEqual(['order.updated']);
    expect(patched[0]!.previousAttributes).toMatchObject({ customerRef: null });
    expect(patched[0]!.snapshot).toEqual(await rest(`/v1/orders/${a.pub}`, ORDER_OMIT));
    const priced = await newEvents(a.soId, () =>
      api(app, admin)
        .post(`/v1/orders/${a.pub}/manual-price`)
        .send({ sellAmount: '1500.00', reason: 'ตกลงราคากับลูกค้าแล้ว' })
        .expect(200),
    );
    // QA: ปลดใบค้างด้วยราคาที่ตั้งเอง = order.released ครั้งเดียว (ไม่มี order.updated ซ้ำ) · ค่าเดิมรูป REST
    expect(priced.map((e) => e.type)).toEqual(['order.released']);
    expect(priced[0]!.previousAttributes).toMatchObject({ status: 'on_hold' });
    expect(priced[0]!.snapshot).toEqual(await rest(`/v1/orders/${a.pub}`, ORDER_OMIT));

    // ---- trip: assigned + dispatched → stops arrived/completed/departed → trip started/completed + DO ----
    const t = await trip(a.doId, true);
    const tripRest = () => rest(`/v1/trips/${t.id}`);
    // ปล่อยรถ: event เกิดตอนเปลี่ยนสถานะเที่ยว (ก่อนขั้นถัดไปในคำขอเดียวกัน เช่น DO → DISPATCHED) — ค่าอาจต่างจาก GET ภายหลัง
    // แต่รูป (ชื่อ field / ชนิด / enum) ต้องเหมือน REST ทุกชั้น
    expect(shapeOf((await latest('trip.dispatched', uuid('trip', t.id)))!.snapshot)).toEqual(
      shapeOf(await tripRest()),
    );
    await post(t.pickup, 'arrive', 55);
    await post(t.pickup, 'complete', 50, { outcome: 'DELIVERED' });
    await post(t.drop, 'arrive', 40);
    await post(t.drop, 'complete', 30, { outcome: 'DELIVERED' });
    // stop.* = จุดเดียวกับ GET /v1/trips/{id} stops[] + tripId · trip.completed = GET /v1/trips/{id}
    const tr = await tripRest();
    const dropRest = {
      ...(tr.stops as { id: string }[]).find((x) => x.id === t.drop),
      tripId: t.id,
    };
    expect((await latest('stop.completed', uuid('tripStop', t.drop)))!.snapshot).toEqual(dropRest);
    expect((await latest('trip.completed', uuid('trip', t.id)))!.snapshot).toEqual({
      ...tr,
      completedAt: tr.completedAt,
    });
    // ---- POD ----
    const doPub = encodeId('deliveryOrder', a.doId);
    // DO: สถานะล่าสุดหลังส่งถึง = GET (บันทึก POD เปลี่ยน podStatus ไม่ใช่สถานะ — ไม่ยิง status_changed)
    expect((await latest('delivery_order.status_changed', a.doId))!.snapshot).toEqual(
      await rest(`/v1/delivery-orders/${doPub}`),
    );
    await api(app, admin)
      .put(`/v1/delivery-orders/${doPub}/pod`)
      .send({ receiverName: 'สมชาย ใจดี', receiverRelation: 'SELF' })
      .expect(200);
    expect((await latest('pod.captured', a.doId))!.snapshot).toEqual(
      await rest(`/v1/delivery-orders/${doPub}/pod`),
    );

    // ---- stop.failed + นัดส่งใหม่อัตโนมัติ (ของยังอยู่บนรถ) ----
    const b = await newOrder();
    const tb = await trip(b.doId, true);
    await post(tb.pickup, 'arrive', 55);
    await post(tb.pickup, 'complete', 50, { outcome: 'DELIVERED' });
    await post(tb.drop, 'arrive', 40);
    await post(tb.drop, 'complete', 30, {
      outcome: 'UNDELIVERED_RETAIN',
      reasonCodeId: await reason('DELIVERY_FAILED', 'SHOP_CLOSED'),
      note: 'ร้านปิด โทรไม่ติด',
    });

    // ---- trip.cancelled + order.cancelled ----
    const c = await newOrder();
    const tc = await trip(c.doId, false);
    await api(app, admin)
      .post(`/v1/trips/${tc.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกงานทั้งเที่ยว' })
      .expect(200);
    const so = await db.salesOrder.findUniqueOrThrow({ where: { id: c.soId } });
    await api(app, admin)
      .post(`/v1/orders/${c.pub}/cancel`)
      .set('If-Match', `"${so.version}"`)
      .send({ reason: 'ลูกค้ายกเลิกคำสั่งทางอีเมล' })
      .expect(200);

    // ---- connector.health_changed: เปิดใช้ (PAUSED → ACTIVE) แล้วพัก ----
    const con = (
      await api(app, admin)
        .post('/v1/connectors')
        .send({
          taxDocumentOwner: 'TMS',
          adapterKey: fake.key,
          settings: { baseUrl: 'https://erp.example.com/api' },
          credentials: { apiKey: GOOD_KEY },
        })
        .expect(201)
    ).body;
    await api(app, admin).post(`/v1/connectors/${con.id}/resume`).send({}).expect(200);
    // ระบบหยุดเพราะ AUTH (ErpAdapterSink → markError) แล้วผู้ดูแลเปิดใหม่ (ERROR → ACTIVE ต้องทดสอบผ่าน)
    const conRow = await db.connector.findUniqueOrThrow({
      where: { id: uuid('connector', con.id) },
    });
    await run((tx) =>
      app
        .get(ConnectorsService)
        .markError(tx, conRow, { code: 'auth_failed', message: 'credential ผิด' }),
    );
    await api(app, admin).post(`/v1/connectors/${con.id}/resume`).send({}).expect(200);
    await api(app, admin)
      .post(`/v1/connectors/${con.id}/pause`)
      .send({ reason: 'ปิดชั่วคราวระหว่างทดสอบ' })
      .expect(200);
    expect((await latest('connector.health_changed', uuid('connector', con.id)))!.snapshot).toEqual(
      // ST7-T17: event สุขภาพไม่รวมค่าตั้ง system-of-record (registry `omit`)
      await rest(`/v1/connectors/${con.id}`, ['systemOfRecord']),
    );

    // ---- job.completed: งานนำเข้า (publicEvent) — งานระบบอื่นไม่ยิง ----
    const job = await db.job.create({
      data: { tenantId, type: 'import.validate', payload: { importJobId: randomUUID() } },
    });
    // งาน publicEvent ที่ล้มครั้งสุดท้าย → onFinalFailure ปิดงานของโมดูล (นำเข้า → FAILED) แล้วจึงยิง job.completed (failed)
    // ใน transaction เดียวกัน (handler ทดสอบที่ลงทะเบียนแบบเดียวกับ import.* — งานนำเข้าจริงล้มยากจากภายนอก)
    const doc = await db.storedDocument.create({
      data: { tenantId, status: 'PENDING', kind: 'OTHER', mimeType: 'text/csv', sizeBytes: 10 },
    });
    const imp = await db.importJob.create({
      data: {
        tenantId,
        kind: 'customers',
        documentId: doc.id,
        status: 'IMPORTING',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    let importStatusAtEvent: string | null = null;
    app.get(JobQueue).register('test.import_fail', () => Promise.reject(new Error('ไฟล์เสีย')), {
      publicEvent: true,
      onFinalFailure: async ({ tx }) => {
        await tx.importJob.update({ where: { id: imp.id }, data: { status: 'FAILED' } });
        importStatusAtEvent = 'FAILED';
      },
    });
    const failed = await db.job.create({
      data: { tenantId, type: 'test.import_fail', maxAttempts: 1, payload: {} },
    });
    const queue = app.get(JobQueue);
    while (await queue.runOnce());
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect((await db.job.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('FAILED');
    expect((await db.importJob.findUniqueOrThrow({ where: { id: imp.id } })).status).toBe('FAILED');
    expect(importStatusAtEvent).toBe('FAILED');
    for (const j of [job, failed])
      expect((await latest('job.completed', j.id))!.snapshot).toEqual(
        await rest(`/v1/jobs/${encodeId('job', j.id)}`),
      );

    // พักใบโดยระบบ (นัดส่งใหม่เกินจำนวนครั้ง — OrderStateService.holdSystem) → order.held
    const h = await newOrder();
    await api(app, admin)
      .post(`/v1/orders/${h.pub}/manual-price`)
      .send({ sellAmount: '900.00', reason: 'ตกลงราคากับลูกค้าแล้ว' })
      .expect(200);
    await run((tx) =>
      app.get(OrderStateService).holdReschedulesExhausted(tx, [h.soId], 'นัดส่งใหม่ครบจำนวนครั้ง'),
    );

    // ---- settlement.approved (ST6-T07): ค่าจ้างรถร่วมของเที่ยว t ในใบสำคัญจ่าย (ข้อมูลจริงผ่าน trigger) → อนุมัติ ----
    const car = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({
          legalName: 'หจก. รถร่วมสัญญา event',
          entityType: 'JURISTIC',
          taxId: '0105561000011',
        })
        .expect(201)
    ).body as { id: string; code: string };
    const fee = await db.tripCost.create({
      data: {
        tenantId,
        tripId: uuid('trip', t.id),
        costType: 'CARRIER_FEE',
        amount: '4500.00',
        source: 'RATE_CARD',
        carrierId: uuid('carrier', car.id),
      },
    });
    await settleTripCostsForTest(db, { id: fee.id }, 'u-preparer');
    const stl = await db.carrierSettlement.findFirstOrThrow({
      where: { tenantId, carrierId: uuid('carrier', car.id) },
    });
    await db.carrierSettlement.update({
      where: { id: stl.id },
      data: {
        carrierSnapshot: {
          code: car.code,
          legalName: 'หจก. รถร่วมสัญญา event',
          entityType: 'JURISTIC',
          taxId: '0105561000011',
          taxIdLast4: null,
          branchCode: null,
          address: null,
        },
      },
    });
    const stlPub = encodeId('settlement', stl.id);
    await api(app, admin)
      .post(`/v1/settlements/${stlPub}/approve`)
      .set(
        'If-Match',
        `"${(await db.carrierSettlement.findUniqueOrThrow({ where: { id: stl.id } })).version}"`,
      )
      .send({ reason: 'ตรวจยอดตรงใบแจ้งหนี้รถร่วมแล้ว' })
      .expect(200);
    expect((await latest('settlement.approved', stl.id))!.snapshot).toEqual(
      await rest(`/v1/settlements/${stlPub}`, [
        ...eventDefinition('settlement.approved')!.object!.omit,
      ]),
    );

    // ---------------- ตรวจ ----------------
    const events = await db.domainEvent.findMany({
      where: { tenantId },
      orderBy: { occurredAt: 'asc' },
    });
    const registered = events.filter((e) => eventDefinition(e.type));
    const seen = new Set(registered.map((e) => e.type));
    expect(
      ACTIVE_EVENT_TYPES.filter((x) => !seen.has(x)),
      'event ที่ยังไม่ถูกยิง',
    ).toEqual([]);
    expect(PENDING_EVENT_TYPES.filter((x) => seen.has(x))).toEqual([]);

    const engine = app.get(WebhookEngine);
    const outbox = await db.integrationOutbox.findMany({
      where: { tenantId, sink: 'contract' },
      select: { eventId: true, eventType: true },
    });
    const queued = new Map(outbox.map((o) => [o.eventId, o.eventType]));
    const failures: string[] = [];
    for (const e of registered) {
      const def = eventDefinition(e.type)!;
      const v = validatorOf(e.type)!;
      if (!v(e.snapshot)) failures.push(`${e.type}: ${ajv.errorsText(v.errors)}`);
      // previousAttributes: ชื่อ field ชุดเดียวกับ object
      const prev = (e.previousAttributes ?? {}) as Record<string, unknown>;
      const extra = Object.keys(prev).filter(
        (k) => !(k in publishedEventSchema(def.type)!.properties!),
      );
      if (extra.length)
        failures.push(`${e.type}: previousAttributes นอก schema ${extra.join(',')}`);
      // ไม่มีราคา / uuid ดิบ (id สาธารณะเป็น prefix เสมอ)
      const raw = JSON.stringify([e.snapshot, prev]);
      if (PRICE_KEY.test(raw)) failures.push(`${e.type}: มี field ราคา`);
      // id ผู้ใช้ (recordedBy/actorId) เป็น uuid ดิบทั้ง API อยู่แล้ว (รูปเดียวกับ REST) — นอกนั้นต้องเป็น id แบบ prefix
      if (
        /"(?!recordedBy"|actorId")\w+":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/.test(
          raw,
        )
      )
        failures.push(`${e.type}: มี uuid ดิบ`);
      // ทุก event ลง outbox ใน transaction เดียวกัน (trigger)
      if (queued.get(e.id) !== e.type) failures.push(`${e.type}: ไม่มีคำสั่ง outbox`);
      // envelope G1 — data.object = payload ที่ตรวจแล้ว
      const env = engine.envelopeOf(tenantId, e);
      expect(env).toMatchObject({
        id: encodeId('event', e.id),
        type: e.type,
        version: '1',
        tenantId: encodeId('tenant', tenantId),
        mode: 'live',
        data: { object: e.snapshot },
      });
      expect(env.occurredAt).toMatch(/Z$/);
    }
    expect(failures).toEqual([]);

    // รายละเอียดที่ต้องถูกต้อง (ไม่ใช่แค่รูปร่าง)
    const one = (type: string) => registered.find((e) => e.type === type)!;
    expect(one('order.held').snapshot).toMatchObject({ id: a.pub, status: 'on_hold' });
    expect(one('trip.started').snapshot).toMatchObject({ id: t.id, status: 'IN_PROGRESS' });
    expect(one('stop.arrived').snapshot).toMatchObject({ id: t.pickup, tripId: t.id });
    expect(
      registered.find(
        (e) => e.type === 'stop.failed' && (e.snapshot as { id: string }).id === tb.drop,
      )?.snapshot,
    ).toMatchObject({ status: 'FAILED', outcome: 'UNDELIVERED_RETAIN' });
    expect(one('pod.captured').snapshot).toMatchObject({
      deliveryOrderId: encodeId('deliveryOrder', a.doId),
      current: { receiverName: 'สมชาย ใจดี' },
    });
    expect(
      registered
        .filter((e) => e.type === 'connector.health_changed')
        .map((e) => [
          (e.previousAttributes as { status: string }).status,
          (e.snapshot as { status: string }).status,
        ]),
    ).toEqual([
      ['PAUSED', 'ACTIVE'],
      ['ACTIVE', 'ERROR'],
      ['ERROR', 'ACTIVE'],
      ['ACTIVE', 'PAUSED'],
    ]);
    expect(
      registered
        .filter((e) => e.type === 'connector.health_changed')
        .find((e) => (e.snapshot as { status: string }).status === 'ERROR')!.snapshot,
    ).toMatchObject({
      statusReason: 'auth_failed',
      lastHealthError: { errorClass: 'AUTH', code: 'auth_failed' },
    });
    expect(one('settlement.approved').snapshot).toMatchObject({
      status: 'APPROVED',
      settlementNo: expect.stringMatching(/^SA-\d{4}-0001$/),
    });
    expect(one('settlement.approved').previousAttributes).toEqual({
      status: 'DRAFT',
      settlementNo: null,
    });
    expect(registered.filter((e) => e.type === 'job.completed').map((e) => e.snapshot)).toEqual([
      expect.objectContaining({ id: encodeId('job', job.id), status: 'succeeded' }),
      expect.objectContaining({ id: encodeId('job', failed.id), status: 'failed' }),
    ]);
    expect(
      registered
        .filter((e) => e.type === 'order.held' && (e.snapshot as { id: string }).id === h.pub)
        .map((e) => (e.snapshot as { holdReason: { code: string } | null }).holdReason?.code),
    ).toContain('RESCHEDULES_EXHAUSTED');
  }, 180_000);
});

/** ชื่อ field ที่สื่อถึงราคา/ต้นทุน — ห้ามอยู่ใน payload ของ event (ดูรายละเอียดราคาผ่าน API ที่ตรวจสิทธิ์) */
const PRICE_WORD = /price|amount|total|cost|revenue|charge|rate/i;
const PRICE_KEY = /"(\w*(price|amount|total|cost|revenue|charge|rate)\w*)"\s*:/i;

/**
 * OpenAPI 3.0 → JSON Schema สำหรับ ajv: `nullable: true` = ยอม null (รวมกับ `$ref`/`allOf`/`enum` ที่ ajv ไม่รวม null ให้เอง)
 */
function jsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(jsonSchema);
  if (!s || typeof s !== 'object') return s;
  const o = Object.fromEntries(
    Object.entries(s as Record<string, unknown>).map(([k, v]) => [
      k,
      k === 'properties'
        ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, jsonSchema(pv)]))
        : jsonSchema(v),
    ]),
  ) as Record<string, unknown>;
  if (o.nullable !== true) return o;
  const { nullable: _n, ...rest } = o;
  return { anyOf: [rest, { type: 'null' }] };
}
