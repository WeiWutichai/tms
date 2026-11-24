import { API_KEY_SCOPES } from '@tms/domain';
import { describe, expect, it } from 'vitest';
import { parseQuickstartCurl } from './curl';
import { loadInputs } from './inputs';
import { renderMarkdown } from './markdown';
import { isPublicOperation, operations } from './openapi';
import { buildSite, POSTMAN_FILE } from './site';

const { doc, guides, include } = loadInputs();
const files = buildSite(doc, guides, include);

describe('docs site (ST7-T12)', () => {
  it('ทุกหน้ามีทั้ง .html และ .md · มี llms.txt / llms-full.txt / Postman', () => {
    const md = [...files.keys()].filter((f) => f.endsWith('.md'));
    expect(md.length).toBeGreaterThan(20);
    for (const f of md) expect(files.has(f.replace(/\.md$/, '.html')), f).toBe(true);
    for (const f of ['index.md', 'quickstart.md', 'llms.txt', 'llms-full.txt', POSTMAN_FILE])
      expect(files.has(f), f).toBe(true);
  });

  it('สร้างซ้ำได้ผลเดิมทุกไบต์ (CI เทียบกับที่ commit)', () => {
    const again = buildSite(doc, guides, include);
    expect([...again.entries()]).toEqual([...files.entries()]);
  });

  it('ลิงก์ภายในทุกลิงก์ชี้ไฟล์และหัวข้อที่มีจริง', () => {
    const ids = new Map<string, Set<string>>();
    for (const [name, body] of files)
      if (name.endsWith('.html'))
        ids.set(name, new Set([...body.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!)));
    const broken: string[] = [];
    for (const [name, body] of files) {
      if (!name.endsWith('.html')) continue;
      for (const m of body.matchAll(/href="([^"]+)"/g)) {
        const href = m[1]!.replace(/&amp;/g, '&');
        if (/^https?:/.test(href)) continue;
        const [file, anchor] = href.split('#');
        const target = file || name;
        if (!files.has(target)) broken.push(`${name} → ${href}`);
        else if (
          anchor &&
          target.endsWith('.html') &&
          !ids.get(target)!.has(decodeURIComponent(anchor))
        )
          broken.push(`${name} → ${href}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('เอกสารสาธารณะมีเฉพาะ endpoint ที่ API key เรียกได้ · มี G2 หลักครบ', () => {
    const ops = operations(doc);
    const keys = new Set(ops.map((o) => `${o.method.toUpperCase()} ${o.path}`));
    for (const k of [
      'POST /v1/orders',
      'PUT /v1/orders/external/{externalId}',
      'POST /v1/orders/{id}/cancel',
      'POST /v1/orders:bulk',
      'GET /v1/jobs/{id}',
      'POST /v1/stops/{id}/arrive',
      'POST /v1/test/events/trigger',
      'GET /v1/events',
      'POST /v1/oauth/token',
      'PUT /v1/customers/external/{externalId}',
    ])
      expect(keys.has(k), k).toBe(true);
    for (const o of ops) {
      expect(o.path.startsWith('/v1/platform')).toBe(false);
      expect(o.path.startsWith('/v1/public/')).toBe(false);
      expect(o.tag).not.toBe('api-keys');
      if (o.scopes.length)
        expect(o.scopes.some((s) => (API_KEY_SCOPES as readonly string[]).includes(s))).toBe(true);
    }
    // scope ที่ให้ key ไม่ได้ (settings:write อย่างเดียว) ไม่อยู่ในเอกสาร
    expect(isPublicOperation('post', '/v1/companies', doc.paths['/v1/companies'].post)).toBe(false);
    // D-81 · D68-49/62: จัดการ webhook ด้วย API key ได้ผ่าน scope `webhooks:manage` (settings:write ยังให้ key ไม่ได้) → อยู่ในเอกสาร
    expect(doc.paths['/v1/webhooks'].post['x-required-scopes']).toContain('webhooks:manage');
    expect(isPublicOperation('post', '/v1/webhooks', doc.paths['/v1/webhooks'].post)).toBe(true);
    expect(isPublicOperation('post', '/v1/auth/login', doc.paths['/v1/auth/login'].post)).toBe(
      false,
    );
  });

  it('Postman v2.1: bearer {{apiKey}} · ทุก endpoint อยู่ครบ · POST มี Idempotency-Key', () => {
    const pm = JSON.parse(files.get(POSTMAN_FILE)!);
    expect(pm.info.schema).toBe(
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    );
    expect(pm.auth).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{apiKey}}', type: 'string' }],
    });
    expect(pm.variable.map((v: { key: string }) => v.key)).toEqual([
      'baseUrl',
      'apiKey',
      'apiVersion',
    ]);
    const items = pm.item.flatMap((f: { item: unknown[] }) => f.item);
    expect(items).toHaveLength(operations(doc).length);
    for (const it of items) {
      expect(it.request.url.raw.startsWith('{{baseUrl}}/v1/')).toBe(true);
      if (it.request.method === 'POST')
        expect(it.request.header.some((h: { key: string }) => h.key === 'Idempotency-Key')).toBe(
          true,
        );
    }
  });

  it('llms.txt ตามรูปแบบ llmstxt.org (H1, blockquote, รายการลิงก์ .md)', () => {
    const t = files.get('llms.txt')!;
    expect(t.startsWith('# TMS API v1\n\n> ')).toBe(true);
    const links = [...t.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(20);
    for (const l of links) expect(files.has(l), l).toBe(true);
    expect(files.get('llms-full.txt')!).toContain('<!-- quickstart.md -->');
  });

  it('quickstart ฝังตัวอย่าง TypeScript ไฟล์จริง และ curl แปลงเป็นขั้นตอนได้ครบ', () => {
    const q = files.get('quickstart.md')!;
    expect(q).toContain('export async function runQuickstart');
    const steps = parseQuickstartCurl(q, { now: new Date('2026-11-19T20:00:00Z') });
    expect(steps.map((s) => `${s.method} ${s.url.replace(/^\$\{TMS_BASE_URL\}/, '')}`)).toEqual([
      'GET /v1/orders?limit=1',
      'GET /v1/companies?limit=50',
      'PUT /v1/customers/external/QS-CUS-001',
      'PUT /v1/customer-sites/external/QS-SITE-PICKUP',
      'PUT /v1/customer-sites/external/QS-SITE-DROPOFF',
      'PUT /v1/orders/external/QS-ORDER-001',
      'GET /v1/orders/${ORDER_ID}',
    ]);
    expect(steps[1]!.capture).toEqual({ variable: 'COMPANY_ID', path: '.data[0].id' });
    expect(steps[2]!.capture).toEqual({ variable: 'CUSTOMER_ID', path: '.id' });
    const order = JSON.parse(steps[5]!.body!);
    // วันพรุ่งนี้ตามเวลาไทย (20:00Z = 03:00 วันที่ 20 ที่ไทย → พรุ่งนี้ = 21)
    expect(order.stops[0].windowStart).toBe('2026-11-21T08:00:00+07:00');
    expect(order.billingCompanyId).toBe('${COMPANY_ID}');
    // ทุก curl ล้มดัง ๆ (--fail-with-body) และ jq -e
    expect(q).toContain('set -euo pipefail');
    for (const m of q.matchAll(/curl -sS ([^\n]*)/g)) expect(m[1]).toContain('--fail-with-body');
    expect(q).not.toMatch(/jq -r /);
  });
});

describe('เนื้อหาสาธารณะ (ST7-T12 review/QA)', () => {
  it('ทุก code ใน catalog ของ API (x-problem-codes = PROBLEMS) มีหัวข้อในหน้า รหัส error', () => {
    const html = files.get('errors.html')!;
    const codes = Object.keys(doc['x-problem-codes'] ?? {});
    expect(codes.length).toBeGreaterThan(80);
    for (const c of [
      'sandbox_only',
      'invalid_api_version',
      'rate_limited',
      'key_revoked',
      'routing_not_configured',
      ...codes,
    ])
      expect(html, c).toContain(` id="${c}"`);
  });

  it('ไม่มีการอ้างอิงเอกสารภายใน (docs/spec/plan, ST?-T??, [DECISION]) ในหน้า/ไฟล์ที่เผยแพร่', () => {
    const bad = /\bST\d+-T\d+|\b(?:docs|spec|plan)\/\d|\[(?:DECISION|PROPOSED|OPEN)/;
    for (const [name, body] of files) {
      const hit = bad.exec(body);
      expect(
        hit ? `${name}: …${body.slice(Math.max(0, hit.index - 40), hit.index + 30)}…` : null,
      ).toBeNull();
    }
  });

  it('ไม่มี endpoint ค่าตั้งส่วนตัวของผู้ใช้ · openapi.json สาธารณะมีเฉพาะ endpoint ในเอกสาร และ $ref ครบ', () => {
    const ops = operations(doc).map((o) => o.path);
    expect(ops.some((p) => p.includes('/preferences'))).toBe(false);
    const pub = JSON.parse(files.get('openapi.json')!);
    const n = Object.values<Record<string, unknown>>(pub.paths).reduce(
      (a, p) => a + Object.keys(p).length,
      0,
    );
    expect(n).toBe(operations(doc).length);
    const refs = [
      ...files.get('openapi.json')!.matchAll(/"\$ref": "#\/components\/schemas\/([^"]+)"/g),
    ].map((m) => m[1]!);
    for (const r of new Set(refs)) expect(pub.components.schemas[r], r).toBeDefined();
  });

  it('openapi.json สาธารณะ: ไม่มี x-webhooks (PathItem ของ OAS 3.0) · ProblemDto รับ extension + module/action/required', () => {
    const pub = JSON.parse(files.get('openapi.json')!);
    expect(pub['x-webhooks']).toBeUndefined();
    expect(Object.keys(pub['x-tms-webhook-events'])).toContain('order.created');
    const pd = pub.components.schemas.ProblemDto;
    expect(pd.additionalProperties).toBe(true);
    for (const k of ['module', 'action', 'required']) expect(pd.properties[k], k).toBeDefined();
    expect(files.get('openapi.json')!).not.toContain('Innovera');
  });

  it('webhook events แสดงฟิลด์ของ data.object', () => {
    expect(files.get('webhook-events.md')!).toMatch(/## order\.created[\s\S]*?\| `id` \|/);
  });
});

describe('markdown renderer', () => {
  it('escape HTML · หัวข้อมี id · ตาราง · code block · ลิงก์ .md → .html', () => {
    const html = renderMarkdown(
      '# หัวข้อ <b>\n\n## เวอร์ชัน {#ver}\n\n| a | b \\| c |\n|---|---|\n| `x|y` | [ลิงก์](p.md#z) |\n\n```ts\nconst a = 1 < 2;\n```\n\n- หนึ่ง\n- **สอง**\n\n[x](javascript:alert(1))',
      { rewriteHref: (h) => h.replace('.md', '.html') },
    );
    expect(html).toContain('<h1 id="หัวข้อ-b">หัวข้อ &lt;b&gt;</h1>');
    expect(html).toContain('<h2 id="ver">เวอร์ชัน</h2>');
    expect(html).toContain('<th>b | c</th>');
    expect(html).toContain('<td><code>x|y</code></td>');
    expect(html).toContain('<a href="p.html#z">ลิงก์</a>');
    expect(html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
    expect(html).toContain('<ul><li>หนึ่ง</li><li><strong>สอง</strong></li></ul>');
    expect(html).not.toContain('javascript:');
  });
});
