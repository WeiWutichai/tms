import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdKind } from '../src/common/ids';
import { EXT_REF_RESOURCES } from '../src/common/external-id';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST7-T02 External id conformance (docs/04 G1 "External id", G2; docs/01 §5.1 Idempotency)
 *
 * ทะเบียน resource ที่มี externalId — CI แดงเมื่อ:
 * (1) มีตาราง (Prisma model) ที่มีฟิลด์ `externalId` แต่ไม่อยู่ใน REGISTRY / EXT_ONLY
 * (2) มี route `PUT|PATCH /{resource}/external/:externalId` ที่ไม่อยู่ใน REGISTRY หรือมีไม่ครบคู่
 * (3) resource P0 ใน G2 ที่ docs กำหนด `PUT /external/{id}` ไม่อยู่ใน REGISTRY
 * (4) resource ใน REGISTRY ไม่ผ่านพฤติกรรมร่วม: PUT 201 → PUT ซ้ำ 200 (แถวเดิม version เดิม),
 *     ทุก GET `/{resource}/:id…` รับ `ext:{externalId}`, PATCH ด้วย `ext:` และ `/external/{id}` → 200,
 *     If-Match ไม่ตรง 412, ไม่มี → 404, externalId ผิดรูปแบบ 422, tenant อื่น 404 + unique ต่อ tenant
 *
 * เพิ่ม resource ใหม่ที่มี externalId = เพิ่มแถวใน REGISTRY (body เต็มของ PUT + patch ที่เปลี่ยนค่าได้)
 */

type Http = (token: string) => ReturnType<typeof api>;
interface Ctx {
  app: NestExpressApplication;
  token: string;
  n: () => number;
}
interface ExtResource {
  /** path ใต้ /v1 */
  path: string;
  /** ชื่อ Prisma model */
  model: string;
  /** ชนิด id (prefix) — route ใต้ resource ห้ามถอด `{id}` ตรง ๆ ด้วย decodeIdOr404 (ต้องผ่าน resolveRef/refToId) */
  kind: IdKind;
  /** POST sub-route ที่เรียกด้วย `ext:` แล้วต้องสำเร็จ (2xx) — [suffix, body] */
  action: [string, object];
  /** body เต็มของ PUT /external/{externalId} (สร้างข้อมูลอ้างอิงที่ต้องใช้ใน tenant ของ token) */
  body: (c: Ctx) => Promise<object>;
  /** PATCH ที่เปลี่ยนค่า (ส่งครั้งที่สอง = ไม่เปลี่ยน) */
  patch: object;
}

const REASON = 'ทดสอบเรียกด้วย ext id';
const DEACTIVATE: [string, object] = ['deactivate', { reason: REASON }];
const ADDR = { line1: '22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540' };
const today = bangkokToday();

function jurTax(n: number): string {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

const post = async (c: Ctx, path: string, body: object) => {
  const r = await api(c.app, c.token).post(path).send(body);
  expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(201);
  return r.body.id as string;
};
const site = (c: Ctx) =>
  post(c, '/v1/customer-sites', { name: `จุดทดสอบ ext ${c.n()}`, kind: 'DROPOFF', address: ADDR });
const customer = (c: Ctx) =>
  post(c, '/v1/customers', { legalName: `ลูกค้า ext ${c.n()}`, taxId: validTaxId(60_000 + c.n()) });
const lookup = async (c: Ctx, path: string, code: string) => {
  const r = await api(c.app, c.token).get(path).query({ limit: 50 });
  expect(r.status).toBe(200);
  const row = r.body.data.find((x: { code: string }) => x.code === code);
  expect(row, `${path} ${code}`).toBeTruthy();
  return row.id as string;
};

/** ทะเบียน resource ที่รองรับ external id ครบ (PUT/PATCH external + ext:) */
const REGISTRY: ExtResource[] = [
  {
    path: 'customers',
    model: 'Customer',
    kind: 'customer',
    action: DEACTIVATE,
    body: async (c) => ({
      legalName: `บจก. ต้นทาง ${c.n()}`,
      taxId: validTaxId(70_000 + c.n()),
      billingAddress: ADDR,
    }),
    patch: { creditTermDays: 45 },
  },
  {
    path: 'customer-sites',
    model: 'CustomerSite',
    kind: 'site',
    action: DEACTIVATE,
    body: async (c) => ({ name: `คลังต้นทาง ${c.n()}`, kind: 'WAREHOUSE', address: ADDR }),
    patch: { contact: { name: 'คุณแก้ไข', phone: '02-000-0009' } },
  },
  {
    path: 'routes',
    model: 'Route',
    kind: 'route',
    action: DEACTIVATE,
    body: async (c) => ({
      originId: await site(c),
      destinationId: await site(c),
      distanceKm: 33.3,
    }),
    patch: { distanceKm: 44.4 },
  },
  {
    path: 'carriers',
    model: 'Carrier',
    kind: 'carrier',
    action: DEACTIVATE,
    body: async (c) => ({
      legalName: `หจก. รถร่วมต้นทาง ${c.n()}`,
      entityType: 'JURISTIC',
      taxId: jurTax(20_000 + c.n()),
    }),
    patch: { maxTripsPerDay: 5 },
  },
  {
    path: 'vehicle-types',
    model: 'VehicleType',
    kind: 'vehicleType',
    action: DEACTIVATE,
    body: async (c) => ({
      name: `ประเภทรถต้นทาง ${c.n()}`,
      vehicleClass: '10W',
      payloadKg: 15000,
      minLicenceClass: 'T2',
    }),
    patch: { payloadKg: 16000 },
  },
  {
    path: 'products',
    model: 'Product',
    kind: 'product',
    action: DEACTIVATE,
    body: async (c) => ({
      name: `สินค้าต้นทาง ${c.n()}`,
      unitId: await lookup(c, '/v1/units', 'BAG'),
      weightPerUnitKg: 25,
    }),
    patch: { weightPerUnitKg: 30 },
  },
  {
    path: 'vehicles',
    model: 'Vehicle',
    kind: 'vehicle',
    action: ['status', { status: 'parked', reason: REASON }],
    body: async (c) => ({
      plate: `71-${String(c.n()).padStart(4, '0')}`,
      plateProvince: 'TH-11',
      vehicleTypeId: await lookup(c, '/v1/vehicle-types', '6W'),
      ownership: 'OWN',
    }),
    patch: { brand: 'Isuzu' },
  },
  {
    path: 'drivers',
    model: 'Driver',
    kind: 'driver',
    action: ['status', { status: 'on_leave', reason: REASON }],
    body: async (c) => {
      const n = c.n();
      return {
        name: `คนขับต้นทาง ${n}`,
        phone: `089-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2028-03-31',
      };
    },
    patch: { licenceExpiresOn: '2029-03-31' },
  },
  {
    path: 'service-items',
    model: 'ServiceItem',
    kind: 'serviceItem',
    action: DEACTIVATE,
    body: async (c) => ({
      name: `ค่าบริการต้นทาง ${c.n()}`,
      calcUnit: 'PER_TRIP',
      defaultPrice: '500.00',
      vatType: 'VAT_7',
      whtRate: '3.00',
    }),
    patch: { defaultPrice: '600.00' },
  },
  {
    path: 'rate-cards',
    model: 'RateCard',
    kind: 'rateCard',
    action: ['approve', { reason: 'อนุมัติตามใบเสนอราคา ext' }],
    body: async (c) => ({
      customerId: await customer(c),
      originId: await site(c),
      destinationId: await site(c),
      vehicleTypeId: await lookup(c, '/v1/vehicle-types', '6W'),
      pricingModel: 'PER_TRIP',
      sellRate: '3500',
      validFrom: today,
    }),
    patch: { sellRate: '3600' },
  },
  {
    path: 'reason-codes',
    model: 'ReasonCode',
    kind: 'reasonCode',
    action: DEACTIVATE,
    body: async (c) => ({ category: 'CANCEL', label: `ยกเลิกจากต้นทาง ${c.n()}` }),
    patch: { requiresNote: true },
  },
  {
    path: 'orders',
    model: 'SalesOrder',
    kind: 'salesOrder',
    action: ['reevaluate', {}],
    body: async (c) => ({
      customer: { id: await customer(c) },
      requestedDate: today,
      vehicleTypeId: await lookup(c, '/v1/vehicle-types', '6W'),
      stops: [
        { type: 'PICKUP', siteId: await site(c) },
        { type: 'DELIVERY', siteId: await site(c) },
      ],
      lines: [
        {
          description: 'ปูนซีเมนต์',
          qty: '10',
          unitId: await lookup(c, '/v1/units', 'TON'),
          weightKg: '10000',
        },
      ],
    }),
    patch: { customerRef: 'PO-EXT-PATCH' },
  },
];

/**
 * เอกสาร (D-81 · D68-45 · 23 พ.ย. 2569) — externalId + `PUT /{resource}/external/{externalId}` แต่กติกาแก้ต่างจาก master
 * (ออกแล้ว/บันทึกแล้วแก้ไม่ได้) → พฤติกรรมทดสอบใน `test/external-id-documents.test.ts` · ที่นี่ตรวจทะเบียน/route/ext:
 */
const DOC_REGISTRY: Record<string, { model: string; kind: IdKind; patch: boolean; why: string }> = {
  invoices: {
    model: 'Invoice',
    kind: 'invoice',
    patch: true,
    why: 'PATCH external = แก้หัวร่าง (DRAFT เท่านั้น)',
  },
  payments: {
    model: 'Payment',
    kind: 'payment',
    patch: false,
    why: 'การรับชำระแก้ไม่ได้ (docs/04 F4 — กลับรายการแล้วบันทึกใหม่) จึงไม่มี PATCH external',
  },
};

/**
 * ตารางที่มี externalId และรับ `ext:` ใน path `{id}` แต่ไม่มี PUT/PATCH external (เหตุผลกำกับ)
 * path = ใช้ทดสอบ GET ext:
 */
const EXT_ONLY: Record<string, { path: string; reason: string }> = {
  Company: {
    path: 'companies',
    reason:
      'นิติบุคคลของ tenant เอง (ผู้ออกเอกสารภาษี) ตั้งค่าในหน้าตั้งค่า ไม่ใช่ข้อมูลที่ระบบต้นทาง push — ไม่อยู่ใน G2; ' +
      'การผูกกับบริษัทใน ERP ใช้ connector routing (ST7-T13)',
  },
};

/**
 * ตารางที่มีฟิลด์ชื่อ `externalId` แต่**ไม่ใช่ resource** (ไม่มี `ext:` ใน path) — เหตุผลกำกับ
 */
const NOT_RESOURCE: Record<string, string> = {
  ExternalMapping:
    'ST8-T05 external_mapping (docs/01 §3.7) — `external_id` คือ id/รหัสฝั่ง ERP ของ entity อื่น (ลูกค้า/เอกสาร) ต่อ connector ' +
    'ไม่ใช่ externalId ของ resource (แก้ผ่าน /customers/{id}/erp-codes · /carriers/{id}/erp-codes)',
};

/**
 * resource ใน G2 (docs/04) ที่ไม่มี external id ในเฟส 0 — เหตุผลกำกับ (spec/12 §3 ST7-T02)
 * G2 กำหนด `PUT /external/{id}` เฉพาะ #1 orders, #5 customers/locations, #8 drivers/vehicles/carriers
 */
const G2_EXCLUDED: Record<string, string> = {
  trips: 'TMS สร้างเองจากการวางแผน — G2 #7 ไม่มี PUT external',
  stops: 'ลูกของเที่ยว — idempotency ด้วย clientEventId (G2 #3)',
  documents: 'ไฟล์ที่ TMS เก็บ — presigned upload (G2 #4)',
  'invoice-runs': 'งานภายใน (G2 #6)',
  webhooks: 'config ของ integration (G2 #2)',
  events: 'สร้างโดยระบบ (G2 #2)',
  'webhook-deliveries': 'สร้างโดยระบบ (G2 #2)',
  'event-types': 'ทะเบียนคงที่ (G2 #2)',
  jobs: 'สร้างโดยระบบ (G2 #10)',
  'api-keys': 'credential ของ tenant (G2 #10)',
};
/** G2 P0 ที่ docs กำหนด PUT /external — `locations` = `customer-sites` (docs/01 §5.2 #6) */
const G2_EXTERNAL = ['orders', 'customers', 'customer-sites', 'drivers', 'vehicles', 'carriers'];
/** resource ทุกแถว P0 ของ docs/04 G2 (#1–#8, #10) — `locations` = `customer-sites` */
const G2_P0 = [
  'orders',
  'webhooks',
  'events',
  'webhook-deliveries',
  'event-types',
  'stops',
  'documents',
  'customers',
  'locations',
  'invoices',
  'invoice-runs',
  'payments',
  'trips',
  'drivers',
  'vehicles',
  'carriers',
  'jobs',
  'api-keys',
].map((r) => (r === 'locations' ? 'customer-sites' : r));

interface RouteInfo {
  method: string;
  path: string;
  /** source ของ handler (ตรวจว่าไม่ถอด `{id}` ตรง ๆ) */
  src: string;
}
function collectRoutes(app: NestExpressApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const mod of app.get(ModulesContainer).values())
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as { prototype: Record<string, unknown> } | undefined;
      if (!cls) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = cls.prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        const m = Reflect.getMetadata(METHOD_METADATA, handler);
        if (sub === undefined || m === undefined) continue;
        routes.push({
          method: RequestMethod[m as number]!,
          path: `/v1/${[base, String(sub)].filter((s) => s && s !== '/').join('/')}`.replace(
            /\/+/g,
            '/',
          ),
          src: String(handler),
        });
      }
    }
  return routes;
}

describe('external id conformance (ST7-T02)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tokenA: string;
  let tokenB: string;
  let tenantA: string;
  let seq = 0;
  let routes: RouteInfo[];
  const ctx = (token: string): Ctx => ({ app, token, n: () => ++seq });
  const http: Http = (token) => api(app, token);

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    const tids: string[] = [];
    for (const name of ['บริษัท ขนส่ง ext เอ', 'บริษัท ขนส่ง ext บี']) {
      const t = await createTenantWithDefaults(db, { name });
      // ใบสั่งต้องมีนิติบุคคลผู้ออกบิล (ST1)
      const c = await db.company.create({
        data: {
          tenantId: t.id,
          legalName: `ผู้ออกบิล ${name}`,
          taxId: validTaxId(800 + tids.length),
        },
      });
      await db.branch.create({
        data: {
          tenantId: t.id,
          companyId: c.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: ADDR,
          isDefaultIssuer: true,
        },
      });
      tids.push(t.id);
    }
    tenantA = tids[0]!;
    tokenA = await tokenFor(tenantA);
    tokenB = await tokenFor(tids[1]!);
    routes = collectRoutes(app);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('(1) ทุก model ที่มี externalId อยู่ในทะเบียน (REGISTRY หรือ EXT_ONLY พร้อมเหตุผล)', () => {
    const withExt = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'externalId'))
      .map((m) => m.name);
    const known = new Set([
      ...REGISTRY.map((r) => r.model),
      ...Object.values(DOC_REGISTRY).map((r) => r.model),
      ...Object.keys(EXT_ONLY),
      ...Object.keys(NOT_RESOURCE),
    ]);
    expect(withExt.filter((m) => !known.has(m))).toEqual([]);
    // ทะเบียนไม่ชี้ model ที่ไม่มี externalId
    expect([...known].filter((m) => !withExt.includes(m))).toEqual([]);
  });

  it('(2) route external ทุกตัวอยู่ในทะเบียน และมีครบ PUT + PATCH', () => {
    const ext = routes
      .filter((r) => /^\/v1\/[^/]+\/external\/:externalId$/.test(r.path))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const expected = [
      ...REGISTRY.flatMap((r) => [
        `PATCH /v1/${r.path}/external/:externalId`,
        `PUT /v1/${r.path}/external/:externalId`,
      ]),
      ...Object.entries(DOC_REGISTRY).flatMap(([p, d]) => [
        ...(d.patch ? [`PATCH /v1/${p}/external/:externalId`] : []),
        `PUT /v1/${p}/external/:externalId`,
      ]),
    ].sort();
    expect(ext).toEqual(expected);
  });

  it('(3) resource G2 ที่ docs กำหนด PUT /external อยู่ในทะเบียน · ที่เหลือมีเหตุผลยกเว้น', () => {
    const paths = REGISTRY.map((r) => r.path);
    for (const p of G2_EXTERNAL) expect(paths, p).toContain(p);
    for (const p of Object.keys(G2_EXCLUDED)) expect(paths, p).not.toContain(p);
    // G2 ทุกแถว = มี external id (G2_EXTERNAL / เอกสาร D68-45) หรือยกเว้นพร้อมเหตุผล — ไม่ขาด ไม่เกิน
    expect(
      [...G2_EXTERNAL, ...Object.keys(DOC_REGISTRY), ...Object.keys(G2_EXCLUDED)].sort(),
    ).toEqual([...G2_P0].sort());
  });

  it('(5) ทุก route `/{resource}/:id…` ของ resource ในทะเบียนแปลง `{id}` ผ่าน resolveRef/refToId (ไม่ถอดตรง)', () => {
    // คำอธิบาย `{id}` ใน OpenAPI ใช้รายการเดียวกัน
    expect([...EXT_REF_RESOURCES].sort()).toEqual(
      [
        ...REGISTRY.map((r) => r.path),
        ...Object.values(EXT_ONLY).map((e) => e.path),
        ...Object.keys(DOC_REGISTRY),
      ].sort(),
    );
    const bad: string[] = [];
    const all = [
      ...REGISTRY,
      ...Object.entries(DOC_REGISTRY).map(([path, d]) => ({ path, kind: d.kind })),
    ];
    for (const res of all) {
      const direct = new RegExp(
        `(decodeIdOr404|tryDecodeId)\\)?\\(\\s*['"]${res.kind}['"]\\s*,\\s*id\\b`,
      );
      for (const r of routes)
        if (r.path.startsWith(`/v1/${res.path}/:id`) && direct.test(r.src))
          bad.push(`${r.method} ${r.path}`);
    }
    expect(bad, 'route ที่ไม่รับ ext: (ใช้ resolveRef / refToId)').toEqual([]);
  });

  it('(6) orders: externalId ทุกทางเขียนใช้กฎเดียวกับ master · PATCH external กันใบช่องทางอื่น (409)', async () => {
    const res = REGISTRY.find((r) => r.path === 'orders')!;
    const body = await res.body(ctx(tokenA));
    for (const bad of ['มี ช่องว่าง', 'SO 001', 'ใบสั่ง-1']) {
      const r = await http(tokenA)
        .post('/v1/orders')
        .send({ ...body, externalId: bad });
      expect(r.status, bad).toBe(422);
      expect(r.body.errors.map((e: { field: string }) => e.field)).toContain('externalId');
    }
    // ใบที่มาจากช่องทางอื่น (เช่น Excel) — PUT/PATCH external ไม่ทับ; แก้ด้วย id หรือ ext: ได้
    const ext = `XLS-${++seq}`;
    const c = await http(tokenA).put(`/v1/orders/external/${ext}`).send(body);
    expect(c.status).toBe(201);
    await db.salesOrder.updateMany({ where: { externalId: ext }, data: { source: 'IMPORT' } });
    const p = await http(tokenA).patch(`/v1/orders/external/${ext}`).send(res.patch);
    expect(p.status).toBe(409);
    expect(p.body).toMatchObject({ code: 'external_id_conflict', existingSource: 'IMPORT' });
    expect((await http(tokenA).put(`/v1/orders/external/${ext}`).send(body)).status).toBe(409);
    expect((await http(tokenA).patch(`/v1/orders/ext:${ext}`).send(res.patch)).status).toBe(200);
  });

  it('(7) OpenAPI: `{externalId}` มี pattern · `{id}` ของ resource ในทะเบียนอธิบาย ext:', async () => {
    const doc = (await http(tokenA).get('/v1/openapi.json')).body;
    for (const res of REGISTRY) {
      for (const m of ['put', 'patch']) {
        const op = doc.paths[`/v1/${res.path}/external/{externalId}`][m];
        const prm = op.parameters.find((x: { name: string }) => x.name === 'externalId');
        expect(prm.schema.pattern, `${m} ${res.path}`).toBe('^[\\x21-\\x7e]{1,100}$');
        expect(Object.keys(op.responses), `${m} ${res.path}`).toEqual(
          expect.arrayContaining(m === 'patch' ? ['404', '412', '422'] : ['412', '422']),
        );
      }
      const one = doc.paths[`/v1/${res.path}/{id}`].get;
      expect(one.parameters.find((x: { name: string }) => x.name === 'id').description).toContain(
        'ext:',
      );
    }
  });

  it('EXT_ONLY: GET ด้วย ext: ได้', async () => {
    const c = await db.company.findFirstOrThrow({ where: { tenantId: tenantA } });
    await db.company.update({ where: { id: c.id }, data: { externalId: 'ERP-CO-1' } });
    const r = await http(tokenA).get(`/v1/${EXT_ONLY.Company!.path}/ext:ERP-CO-1`);
    expect(r.status).toBe(200);
    expect(r.body.externalId).toBe('ERP-CO-1');
    expect((await http(tokenB).get('/v1/companies/ext:ERP-CO-1')).status).toBe(404);
  });

  for (const res of REGISTRY)
    it(`(4) ${res.path}: PUT 201/200 idempotent · ext: ทุก GET :id · PATCH external · 404/412/422 · แยก tenant`, async () => {
      const base = `/v1/${res.path}`;
      const ext = `ERP-${res.path.toUpperCase()}-${++seq}`;
      const body = await res.body(ctx(tokenA));

      // PUT ครั้งแรก 201, ซ้ำ 200 แถวเดิม version เดิม
      const c1 = await http(tokenA).put(`${base}/external/${ext}`).send(body);
      expect(c1.status, JSON.stringify(c1.body)).toBe(201);
      expect(c1.body.externalId).toBe(ext);
      const c2 = await http(tokenA).put(`${base}/external/${ext}`).send(body);
      expect(c2.status, JSON.stringify(c2.body)).toBe(200);
      expect(c2.body.id).toBe(c1.body.id);
      expect(c2.body.version).toBe(c1.body.version);
      expect(
        await (db as unknown as Record<string, { count: (a: object) => Promise<number> }>)[
          res.model[0]!.toLowerCase() + res.model.slice(1)
        ]!.count({ where: { externalId: ext } }),
      ).toBe(1);

      // ทุก GET ที่มีแค่ :id ใต้ resource นี้ รับ ext:
      const gets = routes.filter(
        (r) =>
          r.method === 'GET' &&
          r.path.startsWith(`${base}/:id`) &&
          (r.path.match(/:/g) ?? []).length === 1,
      );
      expect(gets.length).toBeGreaterThan(0);
      for (const g of gets) {
        const r = await http(tokenA).get(g.path.replace(':id', `ext:${ext}`));
        expect(r.status, `${g.path} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
      }
      const one = await http(tokenA).get(`${base}/ext:${encodeURIComponent(ext)}`);
      expect(one.body.id).toBe(c1.body.id);

      // PATCH /external/{id}: If-Match ไม่ตรง 412 · ตรง → 200 เปลี่ยนค่า · ซ้ำผ่าน ext: → 200 version เดิม
      const stale = await http(tokenA)
        .patch(`${base}/external/${ext}`)
        .set('If-Match', '"999"')
        .send(res.patch);
      expect(stale.status).toBe(412);
      const p1 = await http(tokenA)
        .patch(`${base}/external/${ext}`)
        .set('If-Match', `"${c2.body.version}"`)
        .send(res.patch);
      expect(p1.status, JSON.stringify(p1.body)).toBe(200);
      expect(p1.body.id).toBe(c1.body.id);
      expect(p1.body.version).toBe(c2.body.version + 1);
      expect(p1.headers.etag).toBe(`"${p1.body.version}"`);
      const p2 = await http(tokenA).patch(`${base}/ext:${ext}`).send(res.patch);
      expect(p2.status, JSON.stringify(p2.body)).toBe(200);
      expect(p2.body.version).toBe(p1.body.version);

      // ไม่มี → 404 (PATCH ไม่สร้าง) · รูปแบบผิด → 422 / 404
      const missing = await http(tokenA).patch(`${base}/external/NOPE-${seq}`).send(res.patch);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('not_found');
      for (const bad of ['x'.repeat(101), encodeURIComponent('มี ช่องว่าง')]) {
        const put = await http(tokenA).put(`${base}/external/${bad}`).send(body);
        expect(put.status).toBe(422);
        expect(put.body.errors[0]).toMatchObject({ field: 'externalId' });
        expect((await http(tokenA).patch(`${base}/external/${bad}`).send(res.patch)).status).toBe(
          422,
        );
        expect((await http(tokenA).get(`${base}/ext:${bad}`)).status).toBe(404);
      }

      // tenant อื่น: มองไม่เห็น (404) · externalId เดียวกันสร้างของตัวเองได้ (unique ต่อ tenant)
      expect((await http(tokenB).get(`${base}/ext:${ext}`)).status).toBe(404);
      expect((await http(tokenB).patch(`${base}/external/${ext}`).send(res.patch)).status).toBe(
        404,
      );
      const bBody = await res.body(ctx(tokenB));
      const b1 = await http(tokenB).put(`${base}/external/${ext}`).send(bBody);
      expect(b1.status, JSON.stringify(b1.body)).toBe(201);
      expect(b1.body.id).not.toBe(c1.body.id);
      // ของ A ไม่ถูกแตะ
      const again = await http(tokenA).get(`${base}/ext:${ext}`);
      expect(again.body.version).toBe(p1.body.version);

      // POST sub-route ด้วย ext: (อย่างน้อย 1 ต่อ resource)
      const [suffix, actionBody] = res.action;
      const act = await http(tokenA).post(`${base}/ext:${ext}/${suffix}`).send(actionBody);
      expect(act.status, `${suffix} ${JSON.stringify(act.body)}`).toBeLessThan(300);
    });
});
