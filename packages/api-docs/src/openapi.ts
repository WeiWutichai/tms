/** อ่าน openapi.json → โครงที่ใช้สร้างเอกสาร (ST7-T12 — แหล่งเดียว INT-093) */
import { API_KEY_SCOPES } from '@tms/domain';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export interface Operation {
  method: string;
  path: string;
  tag: string;
  op: Json;
  scopes: string[];
  /** id สำหรับ anchor */
  anchor: string;
}

export const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * endpoint ที่อยู่ในเอกสารสาธารณะ = เรียกด้วย API key / OAuth client ได้
 * [DECISION ST7-T12 — spec/12 §3] มี `x-required-scopes` อย่างน้อย 1 ตัวที่ให้ key ได้ (API_KEY_SCOPES) ไม่อยู่ในกลุ่มที่ key ใช้ไม่ได้
 * + endpoint ไม่ต้องมี scope ที่ผู้เชื่อมระบบใช้ (ออก token, JWKS, health, เนื้อไฟล์ผ่าน URL ลงนาม)
 * ไม่รวม: login/2FA/me ของคนที่ login, Platform Console, ลิงก์สาธารณะ (/public/* — สำหรับคนขับ/ผู้รับ), api-keys (จัดการได้เฉพาะคนที่ login)
 */
const EXCLUDED_TAGS = new Set(['api-keys', 'platform', 'platform-console', 'public', 'auth']);
const NO_SCOPE_ALLOW = new Set([
  'POST /v1/oauth/token',
  'POST /v1/oauth/revoke',
  'GET /v1/.well-known/jwks.json',
  'GET /v1/health',
  'PUT /v1/documents/{id}/content',
  'GET /v1/documents/{id}/content',
]);

/** ค่าตั้งส่วนตัวของผู้ใช้ที่ login (ไม่ใช่ข้อมูลบริษัท) — ไม่อยู่ในเอกสารสาธารณะ */
const USER_PREFERENCE = /\/preferences(\/|$)/;

export function isPublicOperation(method: string, path: string, op: Json): boolean {
  const key = `${method.toUpperCase()} ${path}`;
  if (NO_SCOPE_ALLOW.has(key)) return true;
  if (USER_PREFERENCE.test(path)) return false;
  const scopes: string[] | undefined = op['x-required-scopes'];
  if (!scopes?.length) return false;
  if (EXCLUDED_TAGS.has(op.tags?.[0])) return false;
  return scopes.some((s) => (API_KEY_SCOPES as readonly string[]).includes(s));
}

export function anchorOf(method: string, path: string): string {
  return `${method}-${path
    .replace(/^\/v1\//, '')
    .replace(/[{}]/g, '')
    .replace(/[^\w]+/g, '-')}`.replace(/-+$/, '');
}

export function operations(doc: Json): Operation[] {
  const out: Operation[] = [];
  for (const path of Object.keys(doc.paths)) {
    for (const m of METHODS) {
      const op = doc.paths[path][m];
      if (!op || !isPublicOperation(m, path, op)) continue;
      const tag = NO_SCOPE_ALLOW.has(`${m.toUpperCase()} ${path}`)
        ? path.startsWith('/v1/documents')
          ? 'documents'
          : 'auth'
        : (op.tags?.[0] ?? 'other');
      out.push({
        method: m,
        path,
        tag,
        op,
        scopes: op['x-required-scopes'] ?? [],
        anchor: anchorOf(m, path),
      });
    }
  }
  return out;
}

export function deref(doc: Json, node: Json): Json {
  let n = node;
  const seen = new Set<string>();
  while (n && typeof n === 'object' && typeof n.$ref === 'string') {
    if (seen.has(n.$ref)) break;
    seen.add(n.$ref);
    n = n.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce((o: Json, k: string) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  }
  return n;
}

export function refName(node: Json): string | undefined {
  const r: string | undefined =
    node?.$ref ?? (node?.allOf?.length === 1 ? node.allOf[0].$ref : undefined);
  return r?.split('/').pop();
}

/** schema ที่ห่อด้วย allOf ตัวเดียว (nullable object) → ตัวใน */
export function unwrapSchema(doc: Json, s: Json): Json {
  let n = deref(doc, s);
  if (n?.allOf?.length === 1) n = { ...deref(doc, n.allOf[0]), ...omit(n, 'allOf') };
  return n;
}

function omit(o: Json, k: string): Json {
  const { [k]: _drop, ...rest } = o;
  return rest;
}

export function typeLabel(doc: Json, s: Json): string {
  if (!s) return '';
  const name = refName(s);
  const n = unwrapSchema(doc, s);
  if (n?.type === 'array') {
    const inner = typeLabel(doc, n.items);
    return `array<${inner}>`;
  }
  if (name && (n?.type === 'object' || n?.properties)) return name;
  let t = n?.type ?? (n?.properties ? 'object' : n?.oneOf ? 'oneOf' : 'any');
  if (Array.isArray(t)) t = t.join(' | ');
  if (n?.format) t += ` (${n.format})`;
  return t;
}

export interface FieldRow {
  name: string;
  required: boolean;
  type: string;
  rules: string;
  description: string;
  example: string;
}

function rules(n: Json): string {
  const r: string[] = [];
  if (n?.enum) r.push(`ค่า: ${n.enum.map((e: unknown) => `\`${String(e)}\``).join(', ')}`);
  if (n?.maxLength != null) r.push(`ยาว ≤ ${n.maxLength}`);
  if (n?.minLength != null) r.push(`ยาว ≥ ${n.minLength}`);
  if (n?.minimum != null) r.push(`≥ ${n.minimum}`);
  if (n?.maximum != null) r.push(`≤ ${n.maximum}`);
  if (n?.maxItems != null) r.push(`≤ ${n.maxItems} รายการ`);
  if (n?.pattern) r.push(`รูปแบบ \`${n.pattern}\``);
  if (n?.nullable) r.push('null ได้');
  return r.join(' · ');
}

/**
 * ตัดการอ้างอิงเอกสารภายใน (docs/04 G1, spec/07 §9, ST7-T01, D-21, INT-090, [DECISION …]) ออกจากข้อความที่เผยแพร่
 * — คำอธิบายใน OpenAPI เขียนให้ทีมด้วย จึงกรองตอนสร้างหน้าสาธารณะ (ข้อความต้นทางในโค้ดคงเดิม)
 */
const REF =
  '(?:ST\\d+-T\\d+(?:/T?\\d+)*|D-\\d+|(?:INT|MD|NFR|PLT|EXE|ORD|INV)-\\d+|(?:docs|spec|plan|research)/[\\w.-]+(?:\\s*§\\s*[\\d.]+)?(?:\\s+[A-Z]\\d+)?|benchmark(?:\\s+[\\d.]+)?|\\bPO\\b)';
const PAREN_REF = new RegExp(`\\s*\\((?:[^()]*?)${REF}(?:[^()]*)\\)`, 'g');
const BARE_REF = new RegExp(`(?:\\s*[;,·—]\\s*)?${REF}(?:\\s*(?:,|และ|\\+|/)\\s*${REF})*`, 'g');

export function scrubInternal(text: string): string {
  let t = text.replace(/\s*\[(?:DECISION|PROPOSED|OPEN)[^\]]*\]/g, '');
  for (let i = 0; i < 3; i++) t = t.replace(PAREN_REF, '');
  t = t
    .replace(BARE_REF, '')
    .replace(/\(\s*[—·,;:-]?\s*\)/g, '')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/·\s*·/g, '·')
    .replace(/—\s*—/g, '—')
    .replace(/(?:\s*[·—-]\s*)+$/g, '')
    .replace(/^\s*[·—:-]\s*/g, '');
  return t.trim();
}

const oneLine = (s: unknown) =>
  s == null
    ? ''
    : scrubInternal(String(s).replace(/\s*\n\s*/g, ' '))
        .replace(/\|/g, '\\|')
        .trim();

/** ตารางฟิลด์ของ schema (object ซ้อนลงไปไม่เกิน maxDepth ชั้น ชื่อแบบ `a.b`, array ของ object = `a[].b`) */
export function fieldRows(
  doc: Json,
  schema: Json,
  maxDepth = 2,
  prefix = '',
  depth = 0,
  seen = new Set<string>(),
): FieldRow[] {
  const n = unwrapSchema(doc, schema);
  if (!n) return [];
  if (n.type === 'array' && !prefix) return fieldRows(doc, n.items, maxDepth, '[]', depth, seen);
  const props: Json = n.properties ?? {};
  const req = new Set<string>(n.required ?? []);
  const rows: FieldRow[] = [];
  for (const [k, raw] of Object.entries<Json>(props)) {
    const p = unwrapSchema(doc, raw);
    const name = prefix && prefix !== '[]' ? `${prefix}.${k}` : prefix === '[]' ? `[].${k}` : k;
    const ex = raw?.example ?? p?.example;
    rows.push({
      name,
      required: req.has(k),
      type: typeLabel(doc, raw),
      rules: rules({ ...p, nullable: raw?.nullable ?? p?.nullable }),
      description: oneLine(raw?.description ?? p?.description),
      example: ex === undefined ? '' : oneLine(typeof ex === 'string' ? ex : JSON.stringify(ex)),
    });
    const ref = refName(raw) ?? refName(p?.items);
    if (depth + 1 >= maxDepth || (ref && seen.has(ref))) continue;
    const next = new Set(seen);
    if (ref) next.add(ref);
    if (p?.type === 'object' || p?.properties)
      rows.push(...fieldRows(doc, p, maxDepth, name, depth + 1, next));
    else if (p?.type === 'array') {
      const it = unwrapSchema(doc, p.items);
      if (it?.properties) rows.push(...fieldRows(doc, it, maxDepth, `${name}[]`, depth + 1, next));
    }
  }
  return rows;
}

/** ตัวอย่าง JSON จาก schema — ใช้ example ถ้ามี; object ใส่ฟิลด์บังคับ + ฟิลด์ที่มี example */
export function sample(doc: Json, schema: Json, depth = 0, seen = new Set<string>()): Json {
  const ref = refName(schema);
  if (ref && seen.has(ref)) return {};
  const nextSeen = ref ? new Set([...seen, ref]) : seen;
  const n = unwrapSchema(doc, schema);
  if (!n) return null;
  if (schema?.example !== undefined) return schema.example;
  if (n.example !== undefined) return n.example;
  if (n.enum?.length) return n.enum[0];
  if (n.oneOf?.length) return sample(doc, n.oneOf[0], depth, nextSeen);
  if (n.type === 'array') return depth > 3 ? [] : [sample(doc, n.items, depth + 1, nextSeen)];
  if (n.type === 'object' || n.properties) {
    if (depth > 3) return {};
    const req = new Set<string>(n.required ?? []);
    const out: Json = {};
    for (const [k, v] of Object.entries<Json>(n.properties ?? {})) {
      const vv = unwrapSchema(doc, v);
      const hasEx = v?.example !== undefined || vv?.example !== undefined;
      if (!req.has(k) && !hasEx) continue;
      if (!req.has(k) && (v?.nullable || vv?.nullable)) continue;
      out[k] = sample(doc, v, depth + 1, nextSeen);
    }
    return out;
  }
  switch (n.type) {
    case 'string':
      return n.format === 'date'
        ? '2026-11-20'
        : n.format === 'date-time'
          ? '2026-11-20T08:00:00+07:00'
          : 'string';
    case 'integer':
    case 'number':
      return n.minimum ?? 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

export function jsonBodySchema(op: Json): Json | undefined {
  return op.requestBody?.content?.['application/json']?.schema;
}

export function parameters(doc: Json, op: Json): Json[] {
  return (op.parameters ?? [])
    .map((p: Json) => deref(doc, p))
    .filter((p: Json) => p && p.name !== 'X-Api-Version');
}

export function title(op: Operation): string {
  return oneLine(op.op.summary) || `${op.method.toUpperCase()} ${op.path}`;
}

export { oneLine };

/** spec สาธารณะ: เฉพาะ endpoint ในเอกสาร + schema ที่ถูกอ้างถึง · description/summary ผ่าน scrubInternal */
export function publicSpec(doc: Json): Json {
  const paths: Json = {};
  for (const o of operations(doc)) (paths[o.path] ??= {})[o.method] = o.op;
  const keep = new Set<string>();
  const walk = (n: Json): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (typeof n.$ref === 'string' && n.$ref.startsWith('#/components/schemas/')) {
      const name = n.$ref.slice('#/components/schemas/'.length);
      if (!keep.has(name)) {
        keep.add(name);
        walk(doc.components.schemas[name]);
      }
    }
    for (const v of Object.values(n)) walk(v);
  };
  walk(paths);
  walk(doc.components.responses);
  walk(doc.components.parameters);
  walk(doc.components.headers);
  walk(doc['x-webhooks']);
  walk({ $ref: '#/components/schemas/WebhookEnvelope' });
  const schemas: Json = {};
  for (const n of [...keep].sort())
    if (doc.components.schemas[n]) schemas[n] = doc.components.schemas[n];
  const scrub = (n: Json): Json => {
    if (Array.isArray(n)) return n.map(scrub);
    if (!n || typeof n !== 'object') return n;
    const r: Json = {};
    for (const [k, v] of Object.entries<Json>(n)) {
      if (k === 'pendingTask') continue; // งานภายในที่จะเปิด event — ไม่เผยแพร่
      r[k] =
        (k === 'description' || k === 'summary') && typeof v === 'string'
          ? scrubInternal(v)
          : scrub(v);
    }
    return r;
  };
  return scrub({
    openapi: doc.openapi,
    info: {
      ...doc.info,
      description: 'TMS Open API v1 — เฉพาะ endpoint ที่เรียกด้วย API key / OAuth client ได้',
    },
    servers: [{ url: 'https://api.tms.example' }],
    paths,
    components: { ...doc.components, schemas },
    // `x-webhooks` ของ OAS 3.0 เครื่องมือ (Redocly) ตีความเป็น PathItem — ฉบับสาธารณะใช้ชื่อ vendor extension อื่น
    'x-tms-webhook-events': doc['x-webhooks'],
    'x-problem-codes': doc['x-problem-codes'],
  });
}
