import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApi } from '../src/bootstrap';
import { LINK_PURPOSES, type LinkPurpose } from '../src/modules/links/magic-link.service';
import { bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';
import { collectRoutes, PURPOSE_ACTIONS, type RouteInfo } from './route-inventory';

/**
 * ST9-T13 route inventory — ทุก route ของแอปต้องอยู่ในหมวดที่มีหลักฐานการทดสอบแยก tenant / การยืนยันตัวตน
 * (docs/04 J "test cross-tenant ทุก endpoint อัตโนมัติ"; spec/11 NFR-132 deny by default, NFR-204)
 * route ใหม่ที่ไม่เข้าหมวดใด = test แดง → ต้องเพิ่ม @TenantResource + fixture (isolation.test.ts) หรือใส่รายการยกเว้นพร้อมเหตุผลที่นี่
 *
 * หมวด:
 * - `tenant:id`       ใช้ token ลูกค้า + มี `:id` → harness isolation.test.ts (2)(3): token B เรียก resource A = 404
 * - `tenant:list`     ใช้ token ลูกค้า ไม่มี path param → tenant มาจาก token + RLS (isolation (1)) + isolation (4) ไม่รั่ว id ของ A
 * - `tenant:external` `/external/:externalId` → external-id-conformance.test.ts (4) "แยก tenant"
 * - `tenant:static`   param ที่ไม่ใช่ข้อมูลของ tenant (เช่น ชนิดการนำเข้า) — รายการ OTHER_PARAM
 * - `link`            @LinkAction + `:token` ใต้ `/v1/public/` → tenant มาจากลิงก์ (magic-link-matrix.test.ts)
 * - `platform`        @PlatformAuth → token ลูกค้าใช้ไม่ได้ (ตรวจที่นี่ + platform.test.ts)
 * - `public`          @Public ที่ไม่ใช่ลิงก์ → ต้องอยู่ใน PUBLIC_ROUTES พร้อมกลไกยืนยันตัวตนแทน + test อ้างอิง
 */

/** route @Public (ไม่ใช่ magic link) — กลไกที่ใช้แทน token และ test ที่พิสูจน์ */
const PUBLIC_ROUTES: Record<string, string> = {
  'POST /v1/auth/login':
    'รหัสผ่าน · ล็อก 5 ครั้ง/15 นาที ต่อบัญชีและ IP (auth.test.ts, password-policy.test.ts)',
  'POST /v1/oauth/token':
    'PKCE code / refresh cookie httpOnly SameSite=Strict / client credentials · rate limit ต่อ IP + client (auth.test.ts, api-keys.test.ts)',
  'POST /v1/oauth/revoke': 'ออกจากระบบด้วย refresh cookie ของตัวเอง (auth.test.ts)',
  'GET /v1/.well-known/jwks.json': 'กุญแจสาธารณะ — ไม่มีข้อมูล tenant',
  'POST /v1/auth/2fa/verify': 'ต้องมี mfaToken จากขั้นรหัสผ่าน · ล็อกเมื่อผิด (mfa.test.ts)',
  'POST /v1/auth/2fa/enroll': 'ต้องมี mfaToken จากขั้นรหัสผ่าน (mfa.test.ts)',
  'POST /v1/auth/2fa/enroll/confirm': 'ต้องมี mfaToken จากขั้นรหัสผ่าน (mfa.test.ts)',
  'POST /v1/auth/password/forgot': 'ไม่เผยว่ามีอีเมล · จำกัดต่ออีเมล/IP (password-reset.test.ts)',
  'POST /v1/auth/password/reset':
    'token สุ่ม 256 bit ใช้ครั้งเดียว อายุ 30 นาที (password-reset.test.ts)',
  'POST /v1/auth/invitations/inspect': 'token คำเชิญสุ่ม 256 bit อายุ 7 วัน (invitations.test.ts)',
  'POST /v1/auth/invitations/accept': 'token คำเชิญ + ล็อกตามรหัสผ่านผิด (invitations.test.ts)',
  'POST /v1/platform/auth/login': 'login ทีม Innovera แยก + rate limit ต่อ IP (platform.test.ts)',
  'POST /v1/platform/auth/mfa': 'TOTP บังคับของทีม Innovera (platform.test.ts)',
  'GET /v1/health': 'สถานะ process — ไม่มีข้อมูล tenant',
  'GET /v1/healthz': 'liveness — ไม่มีข้อมูล tenant (monitoring.test.ts)',
  'GET /v1/readyz': 'readiness — ไม่มีข้อมูล tenant (monitoring.test.ts)',
  'GET /v1/metrics':
    'Bearer METRICS_TOKEN (ไม่ตั้ง = 404) · ตัวเลขรวมไม่มีข้อมูล tenant (monitoring.test.ts)',
  'PUT /v1/documents/:id/content':
    'URL ลายเซ็น HMAC (action|tenant|id|exp) อายุ 15 นาที · ตรวจ magic bytes (documents.test.ts)',
  'GET /v1/documents/:id/content':
    'URL ลายเซ็น HMAC อายุ 5 นาที (นำเข้า 60 วิ) · attachment + nosniff (documents.test.ts)',
  'POST /v1/inbound/:provider/:token':
    'token ขาเข้าต่อ connector (ผูก tenant) + ลายเซ็น (inbound-webhook.test.ts)',
  'GET /v1/public/plans':
    'ราคาแพ็กเกจของแพลตฟอร์มเอง (ไม่มีข้อมูล tenant) · ปิดด้วย pricing.publicVisible → 404 · rate limit ต่อ IP (public-plans.test.ts)',
  'GET /v1/public/tracking/pod-image/:doc':
    'URL ลายเซ็น preview อายุ 15 นาที · เฉพาะรูป POD · ตัด EXIF (tracking-link.test.ts)',
};

/**
 * P1-ST2-T02: ราคาแพ็กเกจ (ราคาขายของแพลตฟอร์มเอง — ตั้งใจเผยแพร่ docs/02 §7 "ราคาสาธารณะบนเว็บ") ไม่ใช่ราคาของ tenant
 * → ยกเว้นจากตรวจ "ไม่รั่วราคา" · ไม่มีข้อมูล tenant (public-plans.test.ts)
 */
const PUBLIC_PRICE_LIST = ['/v1/public/plans'];

/** route ที่ใช้ token ลูกค้าแต่มี path param ที่ไม่ใช่ `:id` (และไม่ใช่ `/external/:externalId`) */
const OTHER_PARAM: Record<string, string> = {
  'GET /v1/imports/kinds/:kind/template':
    'ไฟล์ template คงที่ต่อชนิด (ไม่มีข้อมูล tenant) — สิทธิ์ตามชนิดตรวจใน handler',
};

/**
 * route ที่ใช้ token ลูกค้าแต่ไม่ประกาศ @RequireScope (NFR-132 deny by default) — ต้องมีเหตุผลว่าตรวจสิทธิ์ที่ไหน
 * key = regex ของ `METHOD path`
 */
const SELF_AUTHORIZED: [RegExp, string][] = [
  [/^(GET|POST|PATCH|DELETE) \/v1\/me(\/|$)/, 'ข้อมูลของผู้ใช้ที่ login เอง (sub ของ token)'],
  [/^POST \/v1\/auth\/step-up$/, 'ยืนยัน 2FA ของผู้ใช้เอง'],
  [
    /^(GET|POST|PATCH|DELETE) \/v1\/saved-views(\/|$)/,
    'มุมมองส่วนตัว ผูกกับผู้ใช้ (saved-views.test.ts)',
  ],
  [
    /^(GET|POST|PATCH) \/v1\/imports(\/|$)/,
    'สิทธิ์ตามชนิดการนำเข้า (ImportSpec.scope) ตรวจใน handler — ไม่มีสิทธิ์ = 404 (imports.test.ts)',
  ],
  [
    /^GET \/v1\/jobs\/:id$/,
    '`jobs:read` หรือเป็นผู้สั่งงานเอง ตรวจใน handler (jobs.test.ts, exports.test.ts)',
  ],
];

/** purpose ที่ผู้รับเป็นลูกค้า/คนขับ — ห้ามเห็นทั้งราคาขายและราคาซื้อ (A3: Driver "ห้าม", ผู้รับสินค้าไม่ใช่คู่สัญญา) */
const NO_PRICE_PURPOSES: LinkPurpose[] = ['tracking', 'trip_sheet', 'carrier_docs'];

type Category =
  | 'tenant:id'
  | 'tenant:list'
  | 'tenant:external'
  | 'tenant:static'
  | 'link'
  | 'platform'
  | 'public'
  | 'UNCLASSIFIED';

const keyOf = (r: RouteInfo) => `${r.method} ${r.path}`;

function classify(r: RouteInfo): { category: Category; why?: string } {
  if (r.linkAction) {
    if (!r.path.startsWith('/v1/public/') || !r.params.includes('token'))
      return { category: 'UNCLASSIFIED', why: 'route ลิงก์ต้องอยู่ใต้ /v1/public/ และมี :token' };
    return { category: 'link' };
  }
  if (r.isPlatform) return { category: 'platform' };
  if (r.isPublic)
    return PUBLIC_ROUTES[keyOf(r)]
      ? { category: 'public' }
      : {
          category: 'UNCLASSIFIED',
          why: 'route @Public ใหม่ — เพิ่มใน PUBLIC_ROUTES พร้อมกลไก/test',
        };
  if (r.path.startsWith('/v1/public/'))
    return { category: 'UNCLASSIFIED', why: '/v1/public/ ต้องเป็นลิงก์หรือ @Public' };
  if (r.params.includes('id')) {
    if (!r.resource) return { category: 'UNCLASSIFIED', why: 'มี :id แต่ไม่มี @TenantResource' };
    return { category: 'tenant:id' };
  }
  if (r.params.length === 0) return { category: 'tenant:list' };
  if (
    r.params.length === 1 &&
    r.params[0] === 'externalId' &&
    /\/external\/:externalId$/.test(r.path)
  )
    return { category: 'tenant:external' };
  if (OTHER_PARAM[keyOf(r)]) return { category: 'tenant:static' };
  return { category: 'UNCLASSIFIED', why: `param ${r.params.join(',')} ไม่มีหลักฐานแยก tenant` };
}

/** property ทั้งหมดที่เข้าถึงได้จาก schema (ตาม $ref/allOf/oneOf/items) */
function propertyNames(doc: OpenAPIObject, schema: unknown, seen = new Set<string>()): string[] {
  const s = schema as Record<string, any> | undefined;
  if (!s || typeof s !== 'object') return [];
  if (typeof s.$ref === 'string') {
    const name = s.$ref.split('/').pop()!;
    if (seen.has(name)) return [];
    seen.add(name);
    return propertyNames(doc, doc.components?.schemas?.[name], seen);
  }
  const out: string[] = [];
  for (const k of ['allOf', 'oneOf', 'anyOf'])
    for (const x of (s[k] as unknown[] | undefined) ?? []) out.push(...propertyNames(doc, x, seen));
  if (s.items) out.push(...propertyNames(doc, s.items, seen));
  if (s.additionalProperties && typeof s.additionalProperties === 'object')
    out.push(...propertyNames(doc, s.additionalProperties, seen));
  for (const [k, v] of Object.entries((s.properties as Record<string, unknown>) ?? {})) {
    out.push(k);
    out.push(...propertyNames(doc, v, seen));
  }
  return out;
}

describe('route inventory (ST9-T13)', () => {
  let app: NestExpressApplication;
  let routes: RouteInfo[];
  let tenantToken: string;
  const plat = platform();

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    routes = collectRoutes(app);
    tenantToken = await tokenFor((await createTenant(plat, 'inventory')).id);
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  it('ทุก route อยู่ในหมวดที่มีหลักฐานแยก tenant/ยืนยันตัวตน — coverage 100%', () => {
    expect(routes.length).toBeGreaterThan(400);
    const rows = routes.map((r) => ({ r, ...classify(r) }));
    const bad = rows
      .filter((x) => x.category === 'UNCLASSIFIED')
      .map((x) => `${keyOf(x.r)} — ${x.why}`);
    const count: Record<string, number> = {};
    for (const x of rows) count[x.category] = (count[x.category] ?? 0) + 1;
    const covered = rows.length - bad.length;
    // รายงานใน log ของ CI (แนบใน docs/security/st9-t13-review.md)
    console.info(
      `[route-inventory] ${covered}/${rows.length} routes covered (${((covered / rows.length) * 100).toFixed(1)}%) ${JSON.stringify(count)}`,
    );
    expect(bad, `route ที่ยังไม่มีหลักฐาน:\n${bad.join('\n')}`).toEqual([]);
  });

  it('รายการยกเว้นไม่ค้าง (ทุกแถวยังตรงกับ route จริง)', () => {
    const keys = new Set(routes.map(keyOf));
    const stale = [...Object.keys(PUBLIC_ROUTES), ...Object.keys(OTHER_PARAM)].filter(
      (k) => !keys.has(k),
    );
    expect(stale, `รายการยกเว้นที่ไม่มี route แล้ว: ${stale.join(', ')}`).toEqual([]);
    for (const [re] of SELF_AUTHORIZED)
      expect(
        routes.some((r) => re.test(keyOf(r))),
        `SELF_AUTHORIZED ${re} ไม่ตรง route ใด`,
      ).toBe(true);
  });

  it('deny by default (NFR-132): route ที่ใช้ token ลูกค้าต้องมี @RequireScope หรืออยู่ใน SELF_AUTHORIZED', () => {
    const missing = routes
      .filter((r) => !r.isPublic && !r.linkAction && !r.requiredScope?.length)
      .map(keyOf)
      .filter((k) => !SELF_AUTHORIZED.some(([re]) => re.test(k)));
    expect(missing, `route ไม่มี @RequireScope:\n${missing.join('\n')}`).toEqual([]);
  });

  it('magic link: ทุก action ของ route ลิงก์เป็นของ purpose เดียว (ลิงก์ purpose อื่นเรียกไม่ได้) · ทุก purpose มีชุด action', () => {
    expect(Object.keys(PURPOSE_ACTIONS).sort()).toEqual([...LINK_PURPOSES].sort());
    const owners = new Map<string, LinkPurpose[]>();
    for (const [p, acts] of Object.entries(PURPOSE_ACTIONS) as [LinkPurpose, string[]][])
      for (const a of acts) owners.set(a, [...(owners.get(a) ?? []), p]);
    const linkRoutes = routes.filter((r) => r.linkAction);
    expect(linkRoutes.length).toBeGreaterThan(10);
    for (const r of linkRoutes)
      expect(owners.get(r.linkAction!), `${keyOf(r)} action ${r.linkAction}`).toHaveLength(1);
    // ทุก action ที่ purpose ออกให้ มี route ใช้จริง (ไม่มี action ลอย)
    const used = new Set(linkRoutes.map((r) => r.linkAction));
    expect([...owners.keys()].filter((a) => !used.has(a))).toEqual([]);
  });

  it('ไม่รั่วราคา (OpenAPI): response ของ /v1/public/* ไม่มี field ราคาขาย · ลิงก์ผู้รับ/คนขับ/เอกสารรถไม่มีราคาซื้อด้วย', () => {
    const doc = buildOpenApi(app);
    const purposeOf = (action?: string) =>
      (Object.entries(PURPOSE_ACTIONS) as [LinkPurpose, string[]][]).find(([, a]) =>
        a.includes(action ?? ''),
      )?.[0];
    const leaks: string[] = [];
    let positive = 0; // ตัวควบคุม: walker เจอราคาซื้อของรถร่วมในหน้าข้อเสนองานจริง (ไม่ใช่ผ่านเพราะอ่าน schema ไม่ออก)
    for (const r of routes.filter(
      (x) => x.path.startsWith('/v1/public/') && !PUBLIC_PRICE_LIST.includes(x.path),
    )) {
      const oaPath = r.path.replace(/(?<!\\):([A-Za-z0-9_]+)/g, '{$1}').replace(/\\:/g, ':');
      const op = (doc.paths[oaPath] as Record<string, any> | undefined)?.[r.method.toLowerCase()];
      expect(op, `${keyOf(r)} ไม่มีใน OpenAPI`).toBeTruthy();
      const names = Object.values((op.responses ?? {}) as Record<string, any>).flatMap((res) =>
        Object.values((res?.content ?? {}) as Record<string, any>).flatMap((c) =>
          propertyNames(doc, c?.schema),
        ),
      );
      const p = purposeOf(r.linkAction);
      const forbidden =
        p && !NO_PRICE_PURPOSES.includes(p) ? /^sell/i : /^(sell|buy)|price|cost|margin/i;
      for (const n of names) if (forbidden.test(n)) leaks.push(`${keyOf(r)} → ${n}`);
      if (r.path === '/v1/public/offers/:token' && names.includes('buyAmount')) positive++;
    }
    expect(positive).toBe(1);
    expect(leaks).toEqual([]);
  });

  it('ไม่มี credential → 401 ทุก route ที่ต้อง login · route ลิงก์ที่ token ปลอม → 404 · token ลูกค้าเรียก Console → 401', async () => {
    const server = app.getHttpServer();
    const call = (r: RouteInfo, url: string) =>
      (request(server) as any)[r.method.toLowerCase()](url) as request.Test;
    const fill = (r: RouteInfo) =>
      r.path
        .replace(
          ':token',
          'ml1.00000000000000000000000000000000.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        )
        .replace(/(?<!\\):([A-Za-z0-9_]+)/g, 'x')
        .replace(/\\:/g, ':');
    const wrong: string[] = [];
    for (const r of routes) {
      if (r.linkAction) {
        const res = await call(r, fill(r));
        if (res.status !== 404 || res.body?.code !== 'not_found')
          wrong.push(`${keyOf(r)} → ${res.status}`);
        else if (!String(res.headers['cache-control']).includes('no-store'))
          wrong.push(`${keyOf(r)} ไม่มี Cache-Control: no-store`);
      } else if (r.isPlatform) {
        const res = await call(r, fill(r)).set('Authorization', `Bearer ${tenantToken}`);
        if (res.status !== 401) wrong.push(`${keyOf(r)} (token ลูกค้า) → ${res.status}`);
      } else if (!r.isPublic) {
        const res = await call(r, fill(r));
        if (res.status !== 401) wrong.push(`${keyOf(r)} (ไม่มี token) → ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('security headers ของ API (NFR-161): CSP default-src none, frame deny, nosniff, HSTS, Referrer-Policy, ไม่มี X-Powered-By', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
    // ไม่เปิด CORS — เว็บเรียก /v1 ผ่าน origin เดียวกัน (proxy) · origin อื่นอ่านคำตอบไม่ได้
    const cors = await request(app.getHttpServer())
      .options('/v1/me')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(cors.headers['access-control-allow-origin']).toBeUndefined();
  });
});
