import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_KEY_SCOPES } from '@tms/domain';
import Ajv, { type ValidateFunction } from 'ajv';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { WebhookEngine } from '../src/modules/webhooks/webhook-engine';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST7-T11 Conformance ของ resource เฟสแรก (docs/04 G2; docs/01 §5.2; spec/07 §5.2)
 * เกณฑ์ตรวจรับ: "ตาราง G2 ทุกแถว P0 มี contract test เขียวที่เรียกด้วย API key (ไม่ใช่ session ของ UI)"
 *
 * - ทุกคำขอใน flow ใช้ API key จริง (`tk_live_…` จาก ST7-T01) — session ใช้แค่ออก key
 * - ทุก response ตรวจกับ OpenAPI ที่แอปเผยแพร่ (`GET /v1/openapi.json` = ฉบับเดียวกับ `packages/contracts/openapi.json`
 *   ที่ CI ตรวจ diff): status ต้องถูกบรรยายไว้ · body 2xx ตรง schema (ajv) · error เป็น problem+json ตรง ProblemDto
 * - ทุก endpoint ใน MATRIX: scope ใน OpenAPI (`x-required-scopes`) ตรงกับตาราง · key ไม่มี scope → 403 `permission_denied`
 *   (`required` ตรง) · key ของบริษัทอื่น → 404 · ไม่มี credential → 401 · OpenAPI มีตัวอย่าง 403/404
 * - list: cursor pagination (`limit`/`nextCursor`/`hasMore`) · GET ใบเดียวมี ETag · If-Match ไม่ตรง → 412
 * - แถว #6 invoices อยู่ในตารางแล้ว (ST5-T09: list/สร้างร่าง/อ่าน/ออกเอกสาร) · void / invoice-runs / payments = DEFERRED (ST5-T10/T12/T13)
 *   — ตรวจว่ายังไม่มี path (กันลืมย้ายเข้าตาราง)
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface Endpoint {
  method: Method;
  path: string;
  /** scope ตาม OpenAPI `x-required-scopes` (หลายตัว = ตัวใดก็ได้) · null = public (ลายเซ็นของ URL) */
  scope: string[] | null;
}
interface Row {
  g2: string;
  resource: string;
  endpoints: Endpoint[];
}
const E = (method: Method, path: string, ...scope: string[]): Endpoint => ({
  method,
  path,
  scope: scope.length ? scope : null,
});

/** master CRUD + external upsert (G2 #5, #8) */
const master = (r: string, extra: Endpoint[] = []): Endpoint[] => [
  E('get', `/v1/${r}`, 'master:read'),
  E('post', `/v1/${r}`, 'master:write'),
  E('get', `/v1/${r}/{id}`, 'master:read'),
  E('patch', `/v1/${r}/{id}`, 'master:write'),
  E('put', `/v1/${r}/external/{externalId}`, 'master:write'),
  E('patch', `/v1/${r}/external/{externalId}`, 'master:write'),
  ...extra,
];

/** ตาราง conformance (ต้องตรงกับ spec/07 §5.2) */
export const MATRIX: Row[] = [
  {
    g2: '#1',
    resource: 'orders',
    endpoints: [
      E('get', '/v1/orders', 'orders:read'),
      E('post', '/v1/orders', 'orders:write'),
      E('get', '/v1/orders/{id}', 'orders:read'),
      E('patch', '/v1/orders/{id}', 'orders:write'),
      E('put', '/v1/orders/external/{externalId}', 'orders:write'),
      E('patch', '/v1/orders/external/{externalId}', 'orders:write'),
      E('post', '/v1/orders/{id}/cancel', 'orders:cancel'),
      E('get', '/v1/orders/{id}/documents', 'orders:read'),
      E('get', '/v1/orders/{id}/tracking', 'orders:read'),
      E('get', '/v1/orders/{id}/events', 'orders:read'),
    ],
  },
  {
    g2: '#2',
    resource: 'webhooks, events, webhook-deliveries, event-types',
    endpoints: [
      E('get', '/v1/webhooks', 'settings:read'),
      E('get', '/v1/webhooks/{id}', 'settings:read'),
      E('get', '/v1/webhooks/event-types', 'settings:read'),
      E('get', '/v1/webhook-deliveries', 'settings:read'),
      E('get', '/v1/webhook-deliveries/{id}', 'settings:read'),
      E('get', '/v1/events', 'events:read'),
      E('get', '/v1/events/{id}', 'events:read'),
    ],
  },
  {
    g2: '#3',
    resource: 'stops',
    endpoints: [
      E('get', '/v1/stops/{id}', 'trips:read'),
      E('get', '/v1/stops/{id}/events', 'trips:read'),
      E('post', '/v1/stops/{id}/arrive', 'trips:dispatch'),
      E('post', '/v1/stops/{id}/depart', 'trips:dispatch'),
      E('post', '/v1/stops/{id}/complete', 'trips:dispatch'),
      E('post', '/v1/stops/{id}/fail', 'trips:dispatch'),
    ],
  },
  {
    g2: '#4',
    resource: 'documents',
    endpoints: [
      E('post', '/v1/documents', 'documents:write'),
      E('get', '/v1/documents/{id}', 'documents:read'),
      E('put', '/v1/documents/{id}/content'),
      E('get', '/v1/documents/{id}/content'),
    ],
  },
  {
    g2: '#5',
    resource: 'customers',
    endpoints: master('customers', [E('post', '/v1/customers/{id}/delete', 'master:write')]),
  },
  {
    g2: '#5',
    resource: 'locations (= customer-sites)',
    endpoints: master('customer-sites', [
      E('post', '/v1/customer-sites/{id}/delete', 'master:write'),
    ]),
  },
  {
    g2: '#7',
    resource: 'trips',
    endpoints: [
      E('get', '/v1/trips', 'trips:read'),
      E('post', '/v1/trips', 'trips:assign'),
      E('get', '/v1/trips/{id}', 'trips:read'),
      E('post', '/v1/trips/{id}/assign', 'trips:assign'),
      E('post', '/v1/trips/{id}/dispatch', 'trips:dispatch'),
      E('post', '/v1/trips/{id}/complete', 'trips:close'),
    ],
  },
  {
    // ST5-T09 (D-54 ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี) — void = ST5-T10 (ยังอยู่ใน DEFERRED)
    g2: '#6',
    resource: 'invoices',
    endpoints: [
      E('get', '/v1/invoices', 'invoices:read'),
      E('post', '/v1/invoices', 'invoices:draft'),
      E('get', '/v1/invoices/{id}', 'invoices:read'),
      E('post', '/v1/invoices/{id}/finalize', 'invoices:finalize'),
    ],
  },
  { g2: '#8', resource: 'drivers', endpoints: master('drivers') },
  { g2: '#8', resource: 'vehicles', endpoints: master('vehicles') },
  { g2: '#8', resource: 'carriers', endpoints: master('carriers') },
  {
    g2: '#10',
    resource: 'jobs, api-keys, openapi.json',
    endpoints: [E('get', '/v1/jobs/{id}', 'jobs:read'), E('get', '/v1/openapi.json')],
  },
];

/** แถว P0 ที่เลื่อนไป task อื่น (ยังไม่มี module) — path ต้องยังไม่มีใน OpenAPI; มีแล้ว = ย้ายเข้า MATRIX */
export const DEFERRED: { g2: string; resource: string; paths: string[]; task: string }[] = [
  { g2: '#6', resource: 'invoices (void)', paths: ['/v1/invoices/{id}/void'], task: 'ST5-T10' },
  { g2: '#6', resource: 'invoice-runs', paths: ['/v1/invoice-runs'], task: 'ST5-T12' },
  { g2: '#6', resource: 'payments', paths: ['/v1/payments'], task: 'ST5-T13' },
];

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const ADDR = {
  line1: '22 หมู่ 3 ต.บางพลีใหญ่',
  district: 'บางพลี',
  province: 'สมุทรปราการ',
  postcode: '10540',
};
const REASON = 'ทดสอบสัญญา API ด้วย API key';

function jurTax(n: number): string {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

/** OpenAPI 3.0 `nullable` → JSON Schema (ajv) */
function jsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(jsonSchema);
  if (!s || typeof s !== 'object') return s;
  const o = Object.fromEntries(
    Object.entries(s as Record<string, unknown>).map(([k, v]) => [
      k,
      k === 'properties' || k === 'examples'
        ? k === 'examples'
          ? v
          : Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, jsonSchema(pv)]))
        : jsonSchema(v),
    ]),
  ) as Record<string, unknown>;
  if (o.nullable !== true) return o;
  const { nullable: _n, ...rest } = o;
  return { anyOf: [rest, { type: 'null' }] };
}

type Doc = {
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, Resp> };
};
type Resp = {
  $ref?: string;
  content?: Record<string, { schema?: unknown; examples?: Record<string, { value: unknown }> }>;
};
type Op = { responses: Record<string, Resp>; security?: unknown[]; 'x-required-scopes'?: string[] };

describe(
  'API conformance ของ resource เฟสแรก — เรียกด้วย API key (ST7-T11)',
  { timeout: 180_000 },
  () => {
    let app: NestExpressApplication;
    const db = platform();
    let tenantA: string;
    let doc: Doc;
    /** key ของบริษัท A ที่มีทุก scope ที่ให้ key ได้ / key ที่ไม่มี scope ของ resource / key ของบริษัท B */
    let full: string;
    let none: string;
    let other: string;
    /** session ของผู้ดูแลบริษัท A — ใช้เฉพาะงานที่ key ทำไม่ได้ตามการตัดสิน ST7-T01 (ออก key, สร้าง webhook) */
    let sa: string;
    let rxServer: Server;
    let rxPort = 0;
    let seq = 0;
    const n = () => ++seq;
    const today = bangkokToday();
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    const validators = new Map<string, ValidateFunction>();
    /** endpoint ที่เรียกสำเร็จ (2xx) ด้วย key + ตัวอย่าง path params/body สำหรับเรียกซ้ำในด่านสิทธิ์/ข้าม tenant */
    const hits = new Map<
      string,
      { params: Record<string, string>; body?: unknown; raw?: boolean }
    >();
    const key = (m: Method, p: string) => `${m.toUpperCase()} ${p}`;

    const srv = () => app.getHttpServer();
    const fill = (tpl: string, params: Record<string, string>) =>
      tpl.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(params[k] ?? 'x'));

    const responseOf = (op: Op, status: number): Resp | undefined => {
      const r = op.responses[String(status)];
      if (r?.$ref) return doc.components.responses[r.$ref.split('/').pop()!];
      return r;
    };
    const validatorFor = (schema: unknown, id: string) => {
      if (!validators.has(id))
        validators.set(
          id,
          ajv.compile({
            ...(jsonSchema(schema) as object),
            components: {
              schemas: Object.fromEntries(
                Object.entries(doc.components.schemas).map(([k, v]) => [k, jsonSchema(v)]),
              ),
            },
          }),
        );
      return validators.get(id)!;
    };

    /** ตรวจ response กับ OpenAPI ของ operation */
    function conform(method: Method, tpl: string, res: request.Response) {
      const op = doc.paths[tpl]?.[method];
      expect(op, `${key(method, tpl)} ไม่อยู่ใน OpenAPI`).toBeTruthy();
      const r = responseOf(op!, res.status);
      expect(
        r,
        `${key(method, tpl)} ตอบ ${res.status} ที่ไม่ได้บรรยายใน OpenAPI: ${JSON.stringify(res.body)}`,
      ).toBeTruthy();
      if (res.status >= 400) {
        expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
        expect(res.body).toMatchObject({
          status: res.status,
          code: expect.any(String),
          title: expect.any(String),
        });
        expect(res.body.type).toMatch(/^https:\/\/docs\.tms\.example\/problems\//);
        expect(res.body.requestId).toEqual(expect.any(String));
        const v = validatorFor({ $ref: '#/components/schemas/ProblemDto' }, 'ProblemDto');
        expect(v(res.body), JSON.stringify(v.errors)).toBe(true);
        return;
      }
      const schema = r!.content?.['application/json']?.schema;
      if (!schema || res.status === 204) return;
      const v = validatorFor(schema, `${key(method, tpl)} ${res.status}`);
      expect(
        v(res.body),
        `${key(method, tpl)} ${res.status} ไม่ตรง schema: ${JSON.stringify(v.errors?.slice(0, 5))}`,
      ).toBe(true);
    }

    /** เรียกด้วย API key แล้วตรวจกับ OpenAPI · status = ที่คาด (2xx = บันทึกว่าครอบ endpoint นี้แล้ว) */
    async function call(
      secret: string | null,
      method: Method,
      tpl: string,
      opts: {
        params?: Record<string, string>;
        body?: unknown;
        headers?: Record<string, string>;
        query?: Record<string, string | number>;
        expect?: number;
        raw?: Buffer;
        url?: string;
      } = {},
    ) {
      const params = opts.params ?? {};
      let t = request(srv())[method](opts.url ?? fill(tpl, params));
      if (secret) t = t.set('Authorization', `Bearer ${secret}`);
      for (const [h, v] of Object.entries(opts.headers ?? {})) t = t.set(h, v);
      if (opts.query) t = t.query(opts.query);
      const res = opts.raw
        ? await t.set('Content-Type', 'application/octet-stream').send(opts.raw)
        : opts.body !== undefined
          ? await t.send(opts.body as object)
          : await t;
      if (opts.expect !== undefined)
        expect(res.status, `${key(method, tpl)} ${JSON.stringify(res.body)}`).toBe(opts.expect);
      conform(method, tpl, res);
      if (res.status < 300 && secret === full && !opts.url)
        hits.set(key(method, tpl), { params, body: opts.body });
      if (res.status < 300 && opts.url) hits.set(key(method, tpl), { params, raw: true });
      return res;
    }

    async function createKey(token: string, name: string, scopes: string[]) {
      const r = await api(app, token).post('/v1/api-keys').send({ name, scopes });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.secret).toMatch(/^tk_live_/);
      return r.body.secret as string;
    }

    beforeAll(async () => {
      process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-conformance-'));
      await truncateAll();
      app = await bootApp();
      tenantA = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง สัญญา เอ' })).id;
      const tenantB = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง สัญญา บี' })).id;
      const ua = await db.appUser.create({
        data: {
          tenantId: tenantA,
          email: 'admin@conf-a.test',
          name: 'ผู้ดูแล เอ',
          status: 'ACTIVE',
        },
      });
      const ub = await db.appUser.create({
        data: {
          tenantId: tenantB,
          email: 'admin@conf-b.test',
          name: 'ผู้ดูแล บี',
          status: 'ACTIVE',
        },
      });
      // session ของผู้ดูแลใช้แค่ออก key — ทุกคำขอใน test ใช้ key
      // ผู้ออกเอกสาร (นิติบุคคล + สาขาสำนักงานใหญ่) — order ต้องมีบริษัทที่ออกบิล
      const co = await db.company.create({
        data: { tenantId: tenantA, legalName: 'บริษัท ผู้ออกบิล สัญญา', taxId: validTaxId(941) },
      });
      await db.branch.create({
        data: {
          tenantId: tenantA,
          companyId: co.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: ADDR,
          isDefaultIssuer: true,
        },
      });
      sa = await tokenFor(tenantA, '*', ua.id);
      // ผู้รับ webhook ในเครื่อง (สร้าง delivery จริงให้ GET /v1/webhook-deliveries/{id})
      app.get(WebhookEngine).sendOptions = { allowPrivate: true };
      rxServer = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        });
      });
      await new Promise<void>((ok) => rxServer.listen(0, '127.0.0.1', ok));
      rxPort = (rxServer.address() as AddressInfo).port;
      const sb = await tokenFor(tenantB, '*', ub.id);
      full = await createKey(sa, 'ERP เต็มสิทธิ์', [...API_KEY_SCOPES]);
      none = await createKey(sa, 'อ่านบริษัทอย่างเดียว', ['companies:read']);
      other = await createKey(sb, 'ERP บริษัท บี', [...API_KEY_SCOPES]);
      const r = await request(srv()).get('/v1/openapi.json').set('Authorization', `Bearer ${full}`);
      expect(r.status).toBe(200);
      doc = r.body as Doc;
      hits.set(key('get', '/v1/openapi.json'), { params: {} });
    });
    afterAll(async () => {
      rxServer?.closeAllConnections?.();
      await new Promise<void>((ok) => (rxServer ? rxServer.close(() => ok()) : ok()));
      await app?.close();
      await db.$disconnect();
    });

    // ------------------------------------------------------------------ helpers ของ flow (ทุกตัวเรียกด้วย key)
    const ids: Record<string, string> = {};
    const lookup = async (path: string, code: string) => {
      const r = await call(full, 'get', path, { query: { limit: 100 }, expect: 200 });
      const row = (r.body.data as { id: string; code: string }[]).find((x) => x.code === code);
      expect(row, `${path} ${code}`).toBeTruthy();
      return row!.id;
    };

    /** list: cursor pagination ตามมาตรฐาน (docs/01 §5.1) — ต้องมีอย่างน้อย 2 แถว */
    async function paginates(tpl: string) {
      const p1 = await call(full, 'get', tpl, { query: { limit: 1 }, expect: 200 });
      expect(p1.body.data).toHaveLength(1);
      expect(p1.body.hasMore).toBe(true);
      expect(p1.body.nextCursor).toEqual(expect.any(String));
      const p2 = await call(full, 'get', tpl, {
        query: { limit: 1, cursor: p1.body.nextCursor },
        expect: 200,
      });
      expect(p2.body.data).toHaveLength(1);
      expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);
      const bad = await call(full, 'get', tpl, { query: { limit: 0 } });
      expect(bad.status).toBe(422);
    }

    /** GET ใบเดียว: ETag = version · PATCH ด้วย If-Match ตรง → 200 (ETag ใหม่) · If-Match เก่า → 412 */
    async function versioned(base: string, id: string, patch: object) {
      const g = await call(full, 'get', `${base}/{id}`, { params: { id }, expect: 200 });
      const etag = g.headers.etag as string;
      expect(etag).toMatch(/^(W\/)?"\d+"$/);
      const p = await call(full, 'patch', `${base}/{id}`, {
        params: { id },
        body: patch,
        headers: { 'If-Match': etag },
        expect: 200,
      });
      expect(p.headers.etag).toBeTruthy();
      expect(p.headers.etag).not.toBe(etag);
      const stale = await call(full, 'patch', `${base}/{id}`, {
        params: { id },
        body: patch,
        headers: { 'If-Match': etag },
      });
      expect(stale.status).toBe(412);
    }

    /** PUT external 201 → ซ้ำ 200 (แถวเดิม) · PATCH external 200 */
    async function external(base: string, body: object, patch: object) {
      const ext = `ERP-${randomUUID().slice(0, 8)}`;
      const c = await call(full, 'put', `${base}/external/{externalId}`, {
        params: { externalId: ext },
        body,
        expect: 201,
      });
      const again = await call(full, 'put', `${base}/external/{externalId}`, {
        params: { externalId: ext },
        body,
        expect: 200,
      });
      expect(again.body.id).toBe(c.body.id);
      await call(full, 'patch', `${base}/external/{externalId}`, {
        params: { externalId: ext },
        body: patch,
        expect: 200,
      });
      ids.lastExt = ext;
      return c.body.id as string;
    }

    const site = async () =>
      (
        await call(full, 'post', '/v1/customer-sites', {
          body: { name: `จุดสัญญา ${n()}`, kind: 'DROPOFF', address: ADDR },
          expect: 201,
        })
      ).body.id as string;

    const orderBody = async (customerId: string) => ({
      customer: { id: customerId },
      requestedDate: today,
      vehicleTypeId: ids.vt6,
      stops: [
        { type: 'PICKUP', siteId: await site() },
        {
          type: 'DELIVERY',
          siteId: await site(),
          windowStart: `${today}T09:00:00+07:00`,
          windowEnd: `${today}T17:00:00+07:00`,
        },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '2', unitId: ids.ton, weightKg: '2000' }],
    });

    const vehicleBody = () => ({
      plate: `7${n() % 10}-${String(4000 + seq)}`,
      plateProvince: 'TH-10',
      vehicleTypeId: ids.vt6,
      ownership: 'OWN',
    });
    const driverBody = (defaultVehicleId?: string) => {
      const k = n();
      return {
        name: `คนขับสัญญา ${k}`,
        phone: `089-${String(k).padStart(3, '0')}-${String(k).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        ...(defaultVehicleId ? { defaultVehicleId } : {}),
      };
    };

    /** DO แรกของ order */
    const firstDo = async (orderId: string) => {
      const r = await request(srv())
        .get('/v1/delivery-orders')
        .query({ orderId })
        .set('Authorization', `Bearer ${full}`)
        .expect(200);
      return (r.body.data as { id: string }[])[0]!.id;
    };

    /** เที่ยวจาก DO → จัดรถ (+ ข้ามคำเตือนกฎด้วยเหตุผล) → ปล่อยรถ */
    async function tripFor(doId: string) {
      const vid = (await call(full, 'post', '/v1/vehicles', { body: vehicleBody(), expect: 201 }))
        .body.id;
      await call(full, 'post', '/v1/drivers', { body: driverBody(vid), expect: 201 });
      const t = (
        await call(full, 'post', '/v1/trips', {
          body: { tripDate: today, deliveryOrderIds: [doId], vehicleId: vid },
          expect: 201,
        })
      ).body;
      let body: object = { vehicleId: vid };
      const a = await call(full, 'post', '/v1/trips/{id}/assign', { params: { id: t.id }, body });
      if (a.status !== 200) {
        expect(a.status, JSON.stringify(a.body)).toBe(409);
        body = {
          vehicleId: vid,
          ruleKeys: (a.body.warnings as { key: string }[]).map((w) => w.key),
          overrideReason: REASON,
        };
        await call(full, 'post', '/v1/trips/{id}/assign', {
          params: { id: t.id },
          body,
          expect: 200,
        });
      }
      const d = await call(full, 'post', '/v1/trips/{id}/dispatch', {
        params: { id: t.id },
        body: {},
      });
      if (d.status !== 200) {
        expect(d.status, JSON.stringify(d.body)).toBe(409);
        await call(full, 'post', '/v1/trips/{id}/dispatch', {
          params: { id: t.id },
          body: {
            ruleKeys: (d.body.warnings as { key: string }[]).map((w) => w.key),
            overrideReason: REASON,
          },
          expect: 200,
        });
      }
      const g = await call(full, 'get', '/v1/trips/{id}', { params: { id: t.id }, expect: 200 });
      expect(g.headers.etag).toBeTruthy();
      const stops = g.body.stops as { id: string; type: string }[];
      return {
        id: t.id as string,
        pickup: stops.find((s) => s.type === 'PICKUP')!.id,
        drop: stops.find((s) => s.type === 'DELIVERY')!.id,
      };
    }
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const stopEvent = (stop: string, action: string, min: number, extra: object = {}) =>
      call(full, 'post', `/v1/stops/{id}/${action}`, {
        params: { id: stop },
        body: {
          clientEventId: randomUUID(),
          occurredAt: ago(min),
          lat: 13.6658,
          lng: 100.6371,
          ...extra,
        },
        expect: 201,
      });

    // ------------------------------------------------------------------ flow

    it('#5 #8 master: customers, locations (customer-sites), carriers, vehicles, drivers — CRUD + external + pagination + ETag', async () => {
      ids.vt6 = await lookup('/v1/vehicle-types', '6W');
      ids.ton = await lookup('/v1/units', 'TON');

      // customers
      const c1 = (
        await call(full, 'post', '/v1/customers', {
          body: {
            legalName: `บจก. ลูกค้าสัญญา ${n()}`,
            taxId: validTaxId(81_000 + seq),
            billingAddress: ADDR,
          },
          expect: 201,
        })
      ).body.id as string;
      ids.customer = c1;
      await external(
        '/v1/customers',
        {
          legalName: `บจก. ลูกค้าต้นทาง ${n()}`,
          taxId: validTaxId(82_000 + seq),
          billingAddress: ADDR,
        },
        { creditTermDays: 45 },
      );
      await paginates('/v1/customers');
      await versioned('/v1/customers', c1, { creditTermDays: 60 });
      ids.customerExt = `ext-check-${n()}`;
      const spare = (
        await call(full, 'post', '/v1/customers', {
          body: { legalName: `บจก. ลูกค้าลบได้ ${n()}`, taxId: validTaxId(83_000 + seq) },
          expect: 201,
        })
      ).body.id as string;
      await call(full, 'post', '/v1/customers/{id}/delete', {
        params: { id: spare },
        body: { reason: REASON },
        expect: 204,
      });

      // locations = customer-sites (spec/12 §3 ST7-T02)
      const s1 = await site();
      await site();
      await external(
        '/v1/customer-sites',
        { name: `คลังต้นทาง ${n()}`, kind: 'WAREHOUSE', address: ADDR },
        {
          contact: { name: 'คุณแก้ไข', phone: '02-000-0009' },
        },
      );
      await paginates('/v1/customer-sites');
      await versioned('/v1/customer-sites', s1, {
        contact: { name: 'คุณสัญญา', phone: '02-000-0010' },
      });
      await call(full, 'post', '/v1/customer-sites/{id}/delete', {
        params: { id: await site() },
        body: { reason: REASON },
        expect: 204,
      });

      // carriers
      const carrierBody = () => ({
        legalName: `หจก. รถร่วมสัญญา ${n()}`,
        entityType: 'JURISTIC',
        taxId: jurTax(30_000 + seq),
      });
      const k1 = (await call(full, 'post', '/v1/carriers', { body: carrierBody(), expect: 201 }))
        .body.id;
      await external('/v1/carriers', carrierBody(), { maxTripsPerDay: 5 });
      await paginates('/v1/carriers');
      await versioned('/v1/carriers', k1, { maxTripsPerDay: 4 });

      // vehicles
      const v1 = (await call(full, 'post', '/v1/vehicles', { body: vehicleBody(), expect: 201 }))
        .body.id;
      await external('/v1/vehicles', vehicleBody(), { brand: 'Isuzu' });
      await paginates('/v1/vehicles');
      await versioned('/v1/vehicles', v1, { brand: 'Hino' });

      // drivers
      const d1 = (await call(full, 'post', '/v1/drivers', { body: driverBody(), expect: 201 })).body
        .id;
      await external('/v1/drivers', driverBody(), { licenceExpiresOn: '2031-03-31' });
      await paginates('/v1/drivers');
      await versioned('/v1/drivers', d1, { licenceExpiresOn: '2032-03-31' });
    });

    it('#1 #3 #4 #7 orders → trips → stops → documents (POD) → order documents/tracking/events', async () => {
      // orders
      const o1 = (
        await call(full, 'post', '/v1/orders', {
          body: await orderBody(ids.customer!),
          expect: 201,
        })
      ).body;
      ids.order = o1.id;
      ids.orderExtId = await external('/v1/orders', await orderBody(ids.customer!), {
        customerRef: 'PO-CONF-1',
      });
      ids.orderExt = ids.lastExt!;
      await paginates('/v1/orders');
      // GET order: ETag + PATCH If-Match
      const g = await call(full, 'get', '/v1/orders/{id}', { params: { id: o1.id }, expect: 200 });
      expect(g.headers.etag).toMatch(/^(W\/)?"\d+"$/);
      await call(full, 'patch', '/v1/orders/{id}', {
        params: { id: o1.id },
        body: { customerRef: 'PO-CONF-2' },
        headers: { 'If-Match': g.headers.etag as string },
        expect: 200,
      });
      const stale = await call(full, 'patch', '/v1/orders/{id}', {
        params: { id: o1.id },
        body: { customerRef: 'PO-CONF-3' },
        headers: { 'If-Match': g.headers.etag as string },
      });
      expect(stale.status).toBe(412);

      // trips (สร้าง จัดรถ ปล่อยรถ) + list
      const doA = await firstDo(o1.id);
      ids.do = doA;
      const t = await tripFor(doA);
      ids.trip = t.id;
      ids.stop = t.drop;

      // stops: GET + depart/arrive/complete (ทุก event มีพิกัด → ตำแหน่งล่าสุดใน tracking)
      const st = await call(full, 'get', '/v1/stops/{id}', {
        params: { id: t.pickup },
        expect: 200,
      });
      expect(st.body).toMatchObject({
        id: t.pickup,
        tripId: t.id,
        type: 'PICKUP',
        status: 'PENDING',
      });
      expect(st.body.deliveryOrderIds).toEqual([doA]);
      await stopEvent(t.pickup, 'depart', 70);
      await stopEvent(t.pickup, 'arrive', 60);
      await stopEvent(t.pickup, 'complete', 55, { outcome: 'DELIVERED' });
      await stopEvent(t.drop, 'arrive', 40);
      await stopEvent(t.drop, 'complete', 30, { outcome: 'DELIVERED' });
      const se = await call(full, 'get', '/v1/stops/{id}/events', {
        params: { id: t.drop },
        expect: 200,
      });
      expect(se.body.data.map((e: { type: string }) => e.type)).toEqual(['ARRIVE', 'COMPLETE']);
      const done = await call(full, 'get', '/v1/stops/{id}', {
        params: { id: t.drop },
        expect: 200,
      });
      expect(done.body).toMatchObject({ status: 'COMPLETED', outcome: 'DELIVERED' });
      expect(done.body.arrivedAt).toEqual(expect.any(String));
      // ทุกจุดจบแล้ว: เที่ยวปิดเองแล้ว (ST4-T03) หรือปิดด้วย /complete
      const tc = await call(full, 'post', '/v1/trips/{id}/complete', {
        params: { id: t.id },
        body: {},
      });
      expect([200, 409]).toContain(tc.status);
      if (tc.status === 409) {
        const tr = await call(full, 'get', '/v1/trips/{id}', { params: { id: t.id }, expect: 200 });
        expect(tr.body.status).toBe('COMPLETED');
        // เปิดเที่ยวที่ 2 เพื่อให้ /complete สำเร็จจริง (ไม่ปิดอัตโนมัติเมื่อยังไม่ครบทุกจุด → ปิดด้วยมือหลังครบ)
      }

      // stops /fail: order ที่ 2 ส่งไม่สำเร็จ
      const o2 = (
        await call(full, 'post', '/v1/orders', {
          body: await orderBody(ids.customer!),
          expect: 201,
        })
      ).body;
      const t2 = await tripFor(await firstDo(o2.id));
      await stopEvent(t2.pickup, 'arrive', 50);
      await stopEvent(t2.pickup, 'complete', 45, { outcome: 'DELIVERED' });
      await stopEvent(t2.drop, 'arrive', 30);
      const reasons = await call(full, 'get', '/v1/reason-codes', {
        query: { category: 'DELIVERY_FAILED', limit: 50 },
        expect: 200,
      });
      await stopEvent(t2.drop, 'fail', 20, {
        reasonCodeId: (reasons.body.data as { id: string }[])[0]!.id,
        note: 'ร้านปิด โทรไม่ติด',
      });
      ids.trip2 = t2.id;

      // documents: จอง → อัปโหลด (URL ลายเซ็น) → ready → ดาวน์โหลด
      const res = await call(full, 'post', '/v1/documents', {
        body: { kind: 'POD_PHOTO', mime: 'image/png', bytes: PNG.length, filename: 'pod.png' },
        expect: 201,
      });
      expect(res.body.uploadUrl).toEqual(expect.any(String));
      const up = new URL(res.body.uploadUrl as string);
      await call(null, 'put', '/v1/documents/{id}/content', {
        url: up.pathname + up.search,
        raw: PNG,
        expect: 200,
      });
      const meta = await call(full, 'get', '/v1/documents/{id}', {
        params: { id: res.body.id },
        expect: 200,
      });
      expect(meta.body.status).toBe('ready');
      const dl = new URL(meta.body.downloadUrl as string);
      const file = await request(srv())
        .get(dl.pathname + dl.search)
        .buffer(true)
        .expect(200);
      expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);
      hits.set(key('get', '/v1/documents/{id}/content'), { params: {}, raw: true });
      const badSig = await call(null, 'get', '/v1/documents/{id}/content', {
        url: `${dl.pathname}?${dl.searchParams.toString().replace(/sig=[^&]+/, 'sig=00')}`,
      });
      expect(badSig.status).toBe(404);
      ids.document = res.body.id;
      // ผูกไฟล์กับ DO เป็นหลักฐานส่ง
      const pod = await request(srv())
        .put(`/v1/delivery-orders/${doA}/pod`)
        .set('Authorization', `Bearer ${full}`)
        .send({
          receiverName: 'สมชาย ใจดี',
          receiverRelation: 'SELF',
          photoDocumentIds: [res.body.id],
        });
      expect(pod.status, JSON.stringify(pod.body)).toBe(200);

      // orders/{id}/documents
      const od = await call(full, 'get', '/v1/orders/{id}/documents', {
        params: { id: o1.id },
        expect: 200,
      });
      expect(od.body.data).toHaveLength(1);
      expect(od.body.data[0]).toMatchObject({
        id: res.body.id,
        deliveryOrderId: doA,
        kind: 'POD_PHOTO',
      });
      expect(od.body.data[0].downloadUrl).toEqual(expect.any(String));

      // orders/{id}/tracking
      const tk = await call(full, 'get', '/v1/orders/{id}/tracking', {
        params: { id: o1.id },
        expect: 200,
      });
      expect(tk.body.orderId).toBe(o1.id);
      // `{id}` รับ `ext:{externalId}` (ST7-T02) — ใบที่สร้างด้วย PUT external
      for (const sub of ['documents', 'tracking', 'events']) {
        const r = await call(full, 'get', `/v1/orders/{id}/${sub}`, {
          params: { id: `ext:${ids.orderExt}` },
          expect: 200,
        });
        if (sub === 'tracking') expect(r.body.orderId).toBe(ids.orderExtId);
      }
      expect(tk.body.deliveryOrders).toHaveLength(1);
      expect(tk.body.deliveryOrders[0]).toMatchObject({
        deliveryOrderId: doA,
        tripId: t.id,
        status: 'DELIVERED',
        lastPosition: { lat: 13.6658, lng: 100.6371, basis: 'STOP_EVENT' },
      });
      expect(tk.body.deliveryOrders[0].steps.every((s: { done: boolean }) => s.done)).toBe(true);
      const tk2 = await call(full, 'get', '/v1/orders/{id}/tracking', {
        params: { id: o2.id },
        expect: 200,
      });
      // ส่งไม่สำเร็จ (ของยังอยู่บนรถ) → ใบเดิมยกเลิก + นัดส่งใหม่อัตโนมัติเป็น DO ใบใหม่ (ST4-T12) — เห็นทั้งสองใบ
      expect(
        tk2.body.deliveryOrders.map((d: { status: string; doStatus: string }) => [
          d.status,
          d.doStatus,
        ]),
      ).toEqual([
        ['CANCELLED', 'CANCELLED'],
        ['ACCEPTED', 'DRAFT'],
      ]);

      // orders/{id}/events — สถานะใบสั่ง/DO + event หน้างาน เรียงตามเวลา
      const ev = await call(full, 'get', '/v1/orders/{id}/events', {
        params: { id: o1.id },
        expect: 200,
      });
      const data = ev.body.data as {
        kind: string;
        at: string;
        event: string;
        entityType: string;
      }[];
      expect(data.filter((e) => e.kind === 'STOP_EVENT').map((e) => e.event)).toEqual([
        'DEPART',
        'ARRIVE',
        'COMPLETE',
        'ARRIVE',
        'COMPLETE',
      ]);
      expect(data.some((e) => e.kind === 'STATUS' && e.entityType === 'order')).toBe(true);
      expect(data.some((e) => e.kind === 'STATUS' && e.entityType === 'delivery_order')).toBe(true);
      const at = data.map((e) => Date.parse(e.at));
      expect([...at].sort((a, b) => a - b)).toEqual(at);

      // orders/{id}/cancel (order ใหม่ที่ยังไม่วางแผน)
      const o3 = (
        await call(full, 'post', '/v1/orders', {
          body: await orderBody(ids.customer!),
          expect: 201,
        })
      ).body;
      const cx = await call(full, 'post', '/v1/orders/{id}/cancel', {
        params: { id: o3.id },
        body: { reason: 'ลูกค้ายกเลิกคำสั่งทางอีเมล' },
        expect: 200,
      });
      expect(cx.body.status).toBe('cancelled');
      ids.order3 = o3.id;
    });

    it('#7 trips: list (pagination) + /complete ปิดเที่ยวที่ทุกจุดจบแล้ว', async () => {
      await paginates('/v1/trips');
      // ปิดจุดสุดท้ายแล้วเที่ยวปิดเอง (ST4-T03) → /complete ซ้ำ = 409 ตามที่บรรยาย
      const tr = await call(full, 'get', '/v1/trips/{id}', {
        params: { id: ids.trip2! },
        expect: 200,
      });
      expect(tr.body.status).toBe('COMPLETED');
      const again = await call(full, 'post', '/v1/trips/{id}/complete', {
        params: { id: ids.trip2! },
        body: {},
      });
      expect(again.status).toBe(409);
      // /complete ด้วยมือ: เที่ยวที่ทุกจุดจบแล้วแต่ยังไม่ปิด (เช่น ผู้จัดรถเพิ่งตัดสิน event ที่ติดธง) — จำลองด้วยการคืนสถานะในฐาน
      await db.trip.update({
        where: { id: tryDecodeId('trip', ids.trip2!)! },
        data: { status: 'IN_PROGRESS', completedAt: null },
      });
      const etag = (
        await call(full, 'get', '/v1/trips/{id}', { params: { id: ids.trip2! }, expect: 200 })
      ).headers.etag as string;
      const done = await call(full, 'post', '/v1/trips/{id}/complete', {
        params: { id: ids.trip2! },
        body: {},
        headers: { 'If-Match': etag },
        expect: 200,
      });
      expect(done.body.status).toBe('COMPLETED');
    });

    it('#6 invoices: ราคาจาก rate card → ส่งถึง → ร่าง (ส่งบัญชีในคำขอเดียว) → list/อ่าน (ETag) → ออกเอกสาร (If-Match) ด้วย key', async () => {
      const cus = (
        await call(full, 'post', '/v1/customers', {
          body: {
            legalName: `บจก. ลูกค้าวางบิลสัญญา ${n()}`,
            taxId: validTaxId(82_000 + seq),
            branchCode: '00000',
            billingAddress: ADDR,
          },
          expect: 201,
        })
      ).body.id as string;
      // หลักฐานส่งไม่บังคับ (ลูกค้ารายนี้) — ไม่มี API ตั้ง checklist ด้วย key ในตาราง G2
      await db.customer.update({
        where: { id: tryDecodeId('customer', cus)! },
        data: { podRequirements: { success: { fields: [] } } },
      });
      const body = await orderBody(cus);
      const rc = (
        await call(full, 'post', '/v1/rate-cards', {
          expect: 201,
          body: {
            customerId: cus,
            originId: body.stops[0]!.siteId,
            destinationId: body.stops[1]!.siteId,
            vehicleTypeId: ids.vt6,
            validFrom: today,
            pricingModel: 'PER_TON',
            sellRate: '350',
          },
        })
      ).body as { id: string };
      expect(rc.id).toBeTruthy();
      await call(full, 'post', '/v1/rate-cards/{id}/approve', {
        params: { id: rc.id },
        body: { reason: REASON },
        expect: 200,
      });
      const o = (await call(full, 'post', '/v1/orders', { body, expect: 201 })).body;
      const d = await firstDo(o.id);
      const t = await tripFor(d);
      await stopEvent(t.pickup, 'arrive', 60);
      await stopEvent(t.pickup, 'complete', 55, { outcome: 'DELIVERED' });
      await stopEvent(t.drop, 'arrive', 40);
      await stopEvent(t.drop, 'complete', 30, { outcome: 'DELIVERED' });
      const draft = (
        await call(full, 'post', '/v1/invoices', {
          body: { customerId: cus, deliveryOrderIds: [d], releaseDeliveryOrders: true },
          expect: 201,
        })
      ).body;
      expect(draft).toMatchObject({ status: 'DRAFT', invoiceNo: null });
      await call(full, 'get', '/v1/invoices', { query: { limit: 10 }, expect: 200 });
      const g = await call(full, 'get', '/v1/invoices/{id}', {
        params: { id: draft.id },
        expect: 200,
      });
      expect(g.headers.etag).toMatch(/^(W\/)?"\d+"$/);
      // key ทั้งสองดอกออกโดยผู้ดูแลคนเดียวกัน = ผู้สร้างร่าง → แบ่งหน้าที่ (A3) บล็อก — บริษัทนี้ปิดกฎ (owner ยอมรับความเสี่ยง)
      const blocked = await call(full, 'post', '/v1/invoices/{id}/finalize', {
        params: { id: draft.id },
        headers: { 'If-Match': g.headers.etag as string },
      });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('invoice_self_finalize');
      await db.tenantSetting.upsert({
        where: { tenantId_key: { tenantId: tenantA, key: 'billing.allowSelfFinalize' } },
        create: { tenantId: tenantA, key: 'billing.allowSelfFinalize', value: true },
        update: { value: true },
      });
      const stale = await call(full, 'post', '/v1/invoices/{id}/finalize', {
        params: { id: draft.id },
        headers: { 'If-Match': '"999"' },
      });
      expect(stale.status).toBe(412);
      const fin = await call(full, 'post', '/v1/invoices/{id}/finalize', {
        params: { id: draft.id },
        headers: { 'If-Match': g.headers.etag as string },
        expect: 200,
      });
      expect(fin.body).toMatchObject({
        status: 'ISSUED',
        invoiceNo: expect.stringMatching(/^INV-00000-\d{4}-0001$/),
      });
    });

    it('#2 #10 webhooks/event-types/deliveries (อ่าน) · jobs · api-keys · openapi.json ด้วย key', async () => {
      // webhook endpoint + delivery: สร้าง/ส่งทดสอบด้วย session (ต้องมี settings:write ซึ่งให้ key ไม่ได้) แล้วอ่านด้วย key
      process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
      let wh: request.Response;
      let tst: request.Response;
      try {
        wh = await api(app, sa)
          .post('/v1/webhooks')
          .send({ url: `http://127.0.0.1:${rxPort}/hook`, events: ['order.created'] });
        expect(wh.status, JSON.stringify(wh.body)).toBe(201);
        tst = await api(app, sa).post(`/v1/webhooks/${wh.body.id}/test`).send({});
      } finally {
        delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
      }
      expect(tst.status, JSON.stringify(tst.body)).toBe(200);
      await call(full, 'get', '/v1/webhooks', { expect: 200 });
      await call(full, 'get', '/v1/webhooks/{id}', { params: { id: wh.body.id }, expect: 200 });
      await call(full, 'get', '/v1/webhooks/event-types', { expect: 200 });
      const dl = await call(full, 'get', '/v1/webhook-deliveries', { expect: 200 });
      expect(dl.body.data.length).toBeGreaterThan(0);
      await call(full, 'get', '/v1/webhook-deliveries/{id}', {
        params: { id: dl.body.data[0].id },
        expect: 200,
      });
      // events: event สาธารณะที่ flow ข้างบนยิง (order.created, trip.dispatched, stop.* …) — envelope เดียวกับ webhook
      await paginates('/v1/events');
      const evs = await call(full, 'get', '/v1/events', {
        query: { type: 'order.created', limit: 200 },
        expect: 200,
      });
      expect(evs.body.data.length).toBeGreaterThanOrEqual(3);
      expect(evs.body.data.every((e: { type: string }) => e.type === 'order.created')).toBe(true);
      const one = await call(full, 'get', '/v1/events/{id}', {
        params: { id: evs.body.data[0].id },
        expect: 200,
      });
      expect(one.body).toMatchObject({
        id: evs.body.data[0].id,
        type: 'order.created',
        mode: 'live',
      });
      expect(one.body.data.object.id).toEqual(expect.stringMatching(/^ord_/));
      // api-keys: จัดการ key ได้เฉพาะคนที่ login (ST7-T01 review M1 — spec/12 §3) → key ทุกตัว 403 แม้มี settings:read
      const keys = await call(full, 'get', '/v1/api-keys', { expect: 403 });
      expect(keys.body).toMatchObject({
        code: 'permission_denied',
        module: 'api-keys',
        action: 'manage',
      });
      const job = await db.job.create({ data: { tenantId: tenantA, type: 'test.record' } });
      ids.job = encodeId('job', job.id);
      await call(full, 'get', '/v1/jobs/{id}', { params: { id: ids.job }, expect: 200 });
    });

    it('#2 events: เห็นเฉพาะ event ของ resource ที่อ่านได้ (events:read + scope ของ resource) · type ไม่รู้จัก → 422', async () => {
      const all = await call(full, 'get', '/v1/events', { query: { limit: 200 }, expect: 200 });
      const types = new Set((all.body.data as { type: string }[]).map((e) => e.type));
      expect(types.has('order.created')).toBe(true);
      expect(types.has('trip.dispatched')).toBe(true);
      const orderEv = (all.body.data as { id: string; type: string }[]).find(
        (e) => e.type === 'order.created',
      )!;
      const tripEv = (all.body.data as { id: string; type: string }[]).find((e) =>
        e.type.startsWith('trip.'),
      )!;
      // settings:read อย่างเดียว (เดิมพอสำหรับ ST7-T11 รุ่นแรก — review M1) → 403 ต้องมี events:read
      const settingsOnly = await createKey(sa, 'อ่านตั้งค่าอย่างเดียว', ['settings:read']);
      const r0 = await call(settingsOnly, 'get', '/v1/events', {});
      expect(r0.status).toBe(403);
      expect(r0.body.required).toEqual(['events:read']);
      // events:read อย่างเดียว → ไม่เห็น order/trip (ไม่มีสิทธิ์อ่าน resource) · GET ใบเดียว = 404
      const evOnly = await createKey(sa, 'อ่าน event อย่างเดียว', ['events:read']);
      const r1 = await call(evOnly, 'get', '/v1/events', { query: { limit: 200 }, expect: 200 });
      expect(r1.body.data).toEqual([]);
      expect(
        (await call(evOnly, 'get', '/v1/events/{id}', { params: { id: orderEv.id } })).status,
      ).toBe(404);
      // events:read + orders:read → เห็น order.* แต่ไม่เห็น trip.* (มีเบอร์คนขับใน snapshot)
      const evOrders = await createKey(sa, 'อ่าน event ใบสั่ง', ['events:read', 'orders:read']);
      const r2 = await call(evOrders, 'get', '/v1/events', { query: { limit: 200 }, expect: 200 });
      const t2 = new Set((r2.body.data as { type: string }[]).map((e) => e.type.split('.')[0]));
      expect([...t2].sort()).toEqual(['delivery_order', 'order']);
      await call(evOrders, 'get', '/v1/events/{id}', { params: { id: orderEv.id }, expect: 200 });
      expect(
        (await call(evOrders, 'get', '/v1/events/{id}', { params: { id: tripEv.id } })).status,
      ).toBe(404);
      const tripOnly = await call(evOrders, 'get', '/v1/events', {
        query: { type: 'trip.dispatched' },
        expect: 200,
      });
      expect(tripOnly.body.data).toEqual([]);
      // ไม่มีสิทธิ์ราคา → ไม่มี field ราคาใน envelope (ตัดแบบเดียวกับ REST)
      expect(JSON.stringify(r2.body)).not.toMatch(/"sell(Price|Rate|Total)"/);
      // type ไม่อยู่ในทะเบียน → 422
      const bad = await call(full, 'get', '/v1/events', { query: { type: 'order.exploded' } });
      expect(bad.status).toBe(422);
      expect(bad.body.errors[0]).toMatchObject({ field: 'type', code: 'unknown_event_type' });
    });

    it('#2 events: mode ของ envelope ตามโหมด tenant (ST7-T09) — sandbox = test · live = live', async () => {
      const k = await api(app, sa)
        .post('/v1/api-keys')
        .set('X-Tms-Mode', 'test')
        .send({
          name: 'sandbox event',
          mode: 'test',
          scopes: ['settings:read', 'events:read', 'orders:read'],
        });
      expect(k.status, JSON.stringify(k.body)).toBe(201);
      const test = k.body.secret as string;
      expect(test).toMatch(/^tk_test_/);
      const tr = await request(srv())
        .post('/v1/test/events/trigger')
        .set('Authorization', `Bearer ${test}`)
        .send({ type: 'order.created' });
      expect(tr.status, JSON.stringify(tr.body)).toBe(200);
      const one = await call(test, 'get', '/v1/events/{id}', {
        params: { id: tr.body.eventId },
        expect: 200,
      });
      expect(one.body).toMatchObject({ id: tr.body.eventId, mode: 'test' });
      const list = await call(test, 'get', '/v1/events', { expect: 200 });
      expect(list.body.data.map((e: { mode: string }) => e.mode)).toEqual(['test']);
      // live key ไม่เห็น event ของ sandbox และ event ของ live เป็น mode live
      expect(
        (await call(full, 'get', '/v1/events/{id}', { params: { id: tr.body.eventId } })).status,
      ).toBe(404);
      const live = await call(full, 'get', '/v1/events', { query: { limit: 5 }, expect: 200 });
      expect(live.body.data.every((e: { mode: string }) => e.mode === 'live')).toBe(true);
    });

    it('cursor: แถวที่เวลาเท่ากันระดับ µs (ตั้งด้วย SQL) — เดินทุกหน้าทั้งสองทิศไม่ซ้ำ ไม่ขาด (review HIGH)', async () => {
      const T = '2026-11-19 10:00:00.123456+07';
      const t = tenantA;
      await db.$executeRaw`UPDATE domain_event SET occurred_at = ${T}::timestamptz WHERE tenant_id = ${t}::uuid`;
      for (const table of [
        'sales_order',
        'trip',
        'delivery_order',
        'customer',
        'customer_site',
        'vehicle',
        'driver',
        'carrier',
      ])
        await db.$executeRawUnsafe(
          `UPDATE "${table}" SET updated_at = $1::timestamptz WHERE tenant_id = $2::uuid`,
          T,
          t,
        );
      const lists: [string, string[], Record<string, string>?][] = [
        ['/v1/events', ['occurredAt', '-occurredAt']],
        ['/v1/orders', ['updatedAt', '-updatedAt']],
        ['/v1/trips', ['updatedAt', '-updatedAt']],
        ['/v1/delivery-orders', ['updatedAt', '-updatedAt']],
        ['/v1/customers', ['updatedAt', '-updatedAt', 'code']],
        ['/v1/customer-sites', ['updatedAt', '-updatedAt', 'code']],
        ['/v1/vehicles', ['updatedAt', '-updatedAt', 'plate']],
        ['/v1/drivers', ['updatedAt', '-updatedAt', 'code']],
        ['/v1/carriers', ['updatedAt', '-updatedAt', 'code']],
      ];
      for (const [path, sorts] of lists) {
        const whole = await request(srv())
          .get(path)
          .query({ limit: 200 })
          .set('Authorization', `Bearer ${full}`)
          .expect(200);
        const expected = (whole.body.data as { id: string }[]).map((x) => x.id).sort();
        expect(expected.length, path).toBeGreaterThanOrEqual(2);
        for (const sort of sorts) {
          const seen: string[] = [];
          let cursor: string | null = null;
          for (let i = 0; i < 400; i++) {
            const r: request.Response = await request(srv())
              .get(path)
              .query({ limit: 1, sort, ...(cursor ? { cursor } : {}) })
              .set('Authorization', `Bearer ${full}`);
            expect(r.status, `${path} ${sort} ${JSON.stringify(r.body)}`).toBe(200);
            seen.push(...(r.body.data as { id: string }[]).map((x) => x.id));
            cursor = r.body.nextCursor;
            if (!cursor) break;
          }
          expect(seen.length, `${path} ${sort} ซ้ำ`).toBe(new Set(seen).size);
          expect([...seen].sort(), `${path} ${sort} ขาด`).toEqual(expected);
        }
      }
    });

    it('cursor: คอลัมน์ที่ใช้เป็น cursor ความละเอียด ms (TIMESTAMPTZ(3)) — ตารางใหม่ที่มี updated_at µs = แดง', async () => {
      const rows = await db.$queryRaw<{ c: string; p: number }[]>`
      SELECT table_name || '.' || column_name AS c, datetime_precision AS p
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (column_name = 'updated_at'
              OR (table_name, column_name) IN (('domain_event', 'occurred_at'), ('webhook_delivery', 'sent_at'),
                  ('message_delivery', 'created_at'), ('login_attempt', 'created_at'),
                  ('notification', 'created_at'), ('import_job', 'created_at')))`;
      expect(rows.length).toBeGreaterThan(50);
      expect(rows.filter((r) => Number(r.p) > 3).map((r) => r.c)).toEqual([]);
    });

    // ------------------------------------------------------------------ ด่านสิทธิ์ / แยก tenant / OpenAPI ต่อ endpoint ในตาราง

    const all = () => MATRIX.flatMap((r) => r.endpoints.map((e) => ({ ...e, row: r })));

    it('ทุก endpoint ในตาราง: อยู่ใน OpenAPI · scope ตรงตาราง · มีตัวอย่าง 401/403/404 · ถูกเรียกสำเร็จด้วย key', () => {
      for (const e of all()) {
        const op = doc.paths[e.path]?.[e.method];
        // ตัวเอกสาร OpenAPI ไม่บรรยายตัวเอง (เรียกได้ใน beforeAll)
        if (e.path !== '/v1/openapi.json')
          expect(op, `${e.row.g2} ${key(e.method, e.path)} ไม่อยู่ใน OpenAPI`).toBeTruthy();
        expect(
          hits.has(key(e.method, e.path)),
          `${e.row.g2} ${key(e.method, e.path)} ยังไม่มี contract test ที่สำเร็จ`,
        ).toBe(true);
        if (!e.scope) continue;
        expect(op!.security?.length, key(e.method, e.path)).toBeTruthy();
        expect(op!['x-required-scopes'], key(e.method, e.path)).toEqual(e.scope);
        expect(API_KEY_SCOPES).toEqual(expect.arrayContaining(e.scope));
        const ex403 = responseOf(op!, 403)?.content?.['application/problem+json']?.examples;
        expect(ex403, `${key(e.method, e.path)} ไม่มีตัวอย่าง 403`).toBeTruthy();
        const required = Object.values(ex403!).map(
          (x) => (x.value as { required?: string[] }).required,
        );
        expect(
          required.some((r) => r?.some((s) => e.scope!.includes(s))),
          key(e.method, e.path),
        ).toBe(true);
        expect(responseOf(op!, 401), key(e.method, e.path)).toBeTruthy();
        if (e.path.includes('{id}'))
          expect(
            responseOf(op!, 404)?.content?.['application/problem+json']?.examples,
            `${key(e.method, e.path)} ไม่มีตัวอย่าง 404`,
          ).toBeTruthy();
      }
    });

    it('key ไม่มี scope → 403 permission_denied (required ตรง OpenAPI) · ไม่มี credential → 401', async () => {
      for (const e of all()) {
        if (!e.scope) continue;
        const h = hits.get(key(e.method, e.path));
        expect(h, `${key(e.method, e.path)} ยังไม่ถูกเรียกสำเร็จใน flow`).toBeTruthy();
        const r = await call(none, e.method, e.path, { params: h!.params, body: h!.body ?? {} });
        expect(r.status, `${key(e.method, e.path)} ${JSON.stringify(r.body)}`).toBe(403);
        expect(r.body.code).toBe('permission_denied');
        expect(r.body.required).toEqual(e.scope);
        const anon = await call(null, e.method, e.path, { params: h!.params, body: h!.body ?? {} });
        expect(anon.status, key(e.method, e.path)).toBe(401);
      }
    });

    it('key ของบริษัทอื่น → 404 ทุก endpoint ที่อ้าง {id}/{externalId} ของบริษัท A (ไม่บอกว่ามีอยู่)', async () => {
      for (const e of all()) {
        if (!e.scope || !/\{(id|externalId)\}/.test(e.path)) continue;
        // PUT external ของบริษัทอื่น = สร้างใหม่ในบริษัทของตัวเอง (unique ต่อ tenant) — ไม่ใช่การอ่านข้ามบริษัท
        if (e.method === 'put') continue;
        const h = hits.get(key(e.method, e.path));
        expect(h, `${key(e.method, e.path)} ยังไม่ถูกเรียกสำเร็จใน flow`).toBeTruthy();
        const r = await call(other, e.method, e.path, { params: h!.params, body: h!.body ?? {} });
        expect(r.status, `${key(e.method, e.path)} ${JSON.stringify(r.body)}`).toBe(404);
        expect(r.body.code).toBe('not_found');
      }
    });

    it('แถว #6 (void / invoice-runs / payments) = DEFERRED → ST5 — ยังไม่มี path ใน OpenAPI', () => {
      for (const d of DEFERRED) {
        expect(d.task).toMatch(/^ST5-T\d+$/);
        for (const p of d.paths)
          expect(doc.paths[p], `${p} มีแล้ว — ย้ายเข้า MATRIX (${d.task})`).toBeUndefined();
      }
    });
  },
);
