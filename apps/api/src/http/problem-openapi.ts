import type { OpenAPIObject } from '@nestjs/swagger';
import { PROBLEMS, type ProblemCode } from '../common/problem';

/**
 * ST7-T11 ตัวอย่าง problem+json ที่ขาดใน OpenAPI (docs/01 §5.1 Errors; docs/04 G2 "ตัวอย่างใน OpenAPI")
 * ทุก operation ที่ต้องมี credential (`security`) ได้ — ถ้ายังไม่ได้บรรยายเองที่ route:
 * - 401 `unauthorized` (components.responses.Unauthorized)
 * - 403 `permission_denied` + `required` = scope จาก `@RequireScope` (`x-required-scopes`) — มีหลายตัว = ตัวใดก็ได้
 * - 404 `not_found` เมื่อ path มี `{id}` (รวมของบริษัทอื่น — ไม่บอกว่ามีอยู่)
 * - 422 `validation_failed` (`errors[]` รายช่อง) เมื่อรับ query parameter หรือ body
 * - 412 `precondition_failed` เมื่อรับ header `If-Match`
 * route ที่บรรยายเองแล้ว (ApiProblems) คงไว้ตามเดิม · ตัวที่เติมเป็น `$ref` ไป `components.responses` (ไม่ขยายขนาดเอกสาร)
 */
const example = (code: ProblemCode, instance: string, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  instance,
  requestId: 'b6a1c2d3-…',
  ...extra,
});

type Op = {
  security?: unknown[];
  parameters?: { in?: string; name?: string; $ref?: string }[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  'x-required-scopes'?: string[];
  'x-step-up'?: { mode: 'always' | 'human' | 'user' | 'platform'; when?: string };
};

const problem = (description: string, examples: Record<string, unknown>) => ({
  description,
  content: {
    'application/problem+json': {
      schema: { $ref: '#/components/schemas/ProblemDto' },
      examples: Object.fromEntries(Object.entries(examples).map(([k, v]) => [k, { value: v }])),
    },
  },
});

/** path ตัวอย่างใน `instance` — `{id}` → id ตัวอย่าง */
const samplePath = (path: string) => path.replace(/\{[^}]+\}/g, '3f2a…');

/** ชื่อ component ของ 403 ต่อชุด scope เช่น `Forbidden_orders.read` / `Forbidden_orders.write_trips.dispatch` */
const forbiddenName = (scopes: string[]) => `Forbidden_${scopes.join('_').replace(/:/g, '.')}`;

export function describeProblemDefaults(doc: OpenAPIObject): OpenAPIObject {
  const responses = ((doc.components ??= {}).responses ??= {}) as Record<string, unknown>;
  const ref = (name: string) => ({ $ref: `#/components/responses/${name}` });
  responses.Unauthorized = problem(
    'ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired`',
    { unauthorized: example('unauthorized', '/v1/orders') },
  );
  responses.NotFound = problem('ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่)', {
    not_found: example('not_found', '/v1/orders/ord_3f2a…'),
  });
  responses.PreconditionFailed = problem('If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET)', {
    precondition_failed: example('precondition_failed', '/v1/customers/cus_3f2a…'),
  });
  responses.ValidationFailed = problem('ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body)', {
    validation_failed: example('validation_failed', '/v1/customers', {
      errors: [{ field: 'name', code: 'isNotEmpty', message: 'name should not be empty' }],
    }),
  });
  for (const [path, item] of Object.entries(doc.paths ?? {}))
    for (const op of Object.values(item as Record<string, Op>)) {
      if (!op?.responses || !op.security?.length) continue;
      const r = op.responses;
      r['401'] ??= ref('Unauthorized');
      const scopes = op['x-required-scopes'];
      if (scopes?.length && !r['403']) {
        const name = forbiddenName(scopes);
        if (!responses[name]) {
          const [module, action] = scopes[0]!.split(':');
          responses[name] = problem(
            `ไม่มีสิทธิ์ (${scopes.map((x) => `\`${x}\``).join(' / ')}${scopes.length > 1 ? ' — มีตัวใดตัวหนึ่งก็พอ' : ''})`,
            {
              // instance = path แรกที่ใช้ชุด scope นี้ (ตัวอย่าง)
              permission_denied: example('permission_denied', samplePath(path), {
                module,
                action,
                required: scopes,
              }),
            },
          );
        }
        r['403'] = ref(name);
      }
    }
  // D-67 step-up 2FA: header `X-Step-Up` + ตัวอย่าง 403 `step_up_required` (รวมกับ 403 เดิมของ route)
  for (const [path, item] of Object.entries(doc.paths ?? {}))
    for (const op of Object.values(item as Record<string, Op>)) {
      const su = op?.['x-step-up'];
      if (!su || !op.responses) continue;
      const when = su.when ? `เมื่อ${su.when}` : 'ทุกครั้ง';
      const who =
        su.mode === 'human'
          ? ' · API key / OAuth client ไม่ต้อง (คุมด้วย scope — D-67)'
          : su.mode === 'user'
            ? ' · API key / OAuth client ทำรายการนี้ไม่ได้ → 403 `bank_change_requires_user` (D-79)'
            : su.mode === 'platform'
              ? ''
              : ' · API key ใช้ route นี้ไม่ได้';
      const source =
        su.mode === 'platform'
          ? '`POST /v1/platform/auth/step-up` (ทีม Innovera ยืนยัน TOTP ซ้ำ อายุ 5 นาที — D-77)'
          : '`POST /v1/auth/step-up` (ยืนยัน TOTP อายุ 5 นาที)';
      op.parameters ??= [];
      if (!op.parameters.some((p) => p.in === 'header' && p.name?.toLowerCase() === 'x-step-up'))
        (op.parameters as unknown[]).push({
          name: 'X-Step-Up',
          in: 'header',
          required: false,
          description: `stepUpToken จาก ${source} — ผู้ใช้ต้องส่ง${when} ไม่งั้น 403 \`step_up_required\`${who}`,
          schema: { type: 'string' },
        });
      const stepEx = {
        step_up_required: { value: example('step_up_required', samplePath(path)) },
        ...(su.mode === 'user'
          ? {
              bank_change_requires_user: {
                value: example('bank_change_requires_user', samplePath(path)),
              },
            }
          : {}),
      };
      const cur = op.responses['403'] as
        | { $ref?: string; description?: string; content?: Record<string, { examples?: object }> }
        | undefined;
      const base = cur?.$ref ? (responses[cur.$ref.split('/').pop()!] as typeof cur) : cur;
      const json = base?.content?.['application/problem+json'];
      op.responses['403'] = {
        description: `${base?.description ? `${base.description} · ` : ''}ต้องยืนยัน 2FA ซ้ำ (\`step_up_required\`)${su.when ? ` ${when}` : ''}${su.mode === 'user' ? ' · API key → `bank_change_requires_user`' : ''}`,
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/ProblemDto' },
            examples: { ...(json?.examples ?? {}), ...stepEx },
          },
        },
      };
    }
  for (const [path, item] of Object.entries(doc.paths ?? {}))
    for (const op of Object.values(item as Record<string, Op>)) {
      if (!op?.responses || !op.security?.length) continue;
      const r = op.responses;
      if (/\{id\}/.test(path)) r['404'] ??= ref('NotFound');
      const ifMatch = (op.parameters ?? []).some(
        (p) => p.in === 'header' && p.name?.toLowerCase() === 'if-match',
      );
      if (ifMatch) r['412'] ??= ref('PreconditionFailed');
      const hasInput = !!op.requestBody || (op.parameters ?? []).some((p) => p.in === 'query');
      if (hasInput) r['422'] ??= ref('ValidationFailed');
    }
  return doc;
}

/**
 * ST7-T12: catalog ของ `code` ทั้งหมด (PROBLEMS) → `x-problem-codes` ของ openapi.json
 * หน้า "รหัส error" ของ docs site generate จากตรงนี้ → ทุก `type` (`…/problems/<code>`) มีหัวข้อจริง
 */
export function describeProblemCatalog(doc: OpenAPIObject): OpenAPIObject {
  // RFC 9457 §3.2: extension member ตาม `code` (orderStatus, editableFields, …) — ประกาศว่า schema รับช่องเพิ่มได้
  const pd = doc.components?.schemas?.['ProblemDto'] as Record<string, unknown> | undefined;
  if (pd) {
    pd.additionalProperties = true;
    pd.description =
      'RFC 9457 application/problem+json — ช่องเสริม (extension member) ขึ้นกับ `code` เช่น `orderStatus`/`editableFields` ของ `order_locked_for_update`';
  }
  const codes = Object.keys(PROBLEMS).sort() as ProblemCode[];
  (doc as OpenAPIObject & Record<string, unknown>)['x-problem-codes'] = Object.fromEntries(
    codes.map((c) => {
      const p = PROBLEMS[c] as { status: number; th: string; en?: string };
      return [c, { status: p.status, title: p.th, ...(p.en ? { titleEn: p.en } : {}) }];
    }),
  );
  return doc;
}
