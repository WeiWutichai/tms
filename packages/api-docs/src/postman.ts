/** Postman Collection v2.1 จาก openapi.json (ST7-T12; spec/07 INT-092 — ฉบับกลาง ไม่มี custom fields ของ tenant) */
import { jsonBodySchema, operations, parameters, sample, title, type Json } from './openapi';
import { TAGS } from './pages';

export function postmanCollection(doc: Json): Json {
  const ops = operations(doc);
  const folders = new Map<string, Json[]>();
  for (const o of ops) {
    const prms = parameters(doc, o.op);
    const pathParams = prms.filter((p: Json) => p.in === 'path');
    const segs = o.path.replace(/^\//, '').split('/');
    const rawPath = segs.map((s) => s.replace(/\{([^}]+)\}/g, ':$1')).join('/');
    const query = prms
      .filter((p: Json) => p.in === 'query')
      .map((p: Json) => ({
        key: p.name,
        value: p.schema?.example != null ? String(p.schema.example) : '',
        description: p.description ?? '',
        disabled: !p.required,
      }));
    const header: Json[] = [{ key: 'X-Api-Version', value: '{{apiVersion}}' }];
    for (const p of prms.filter((x: Json) => x.in === 'header'))
      if (p.name !== 'Idempotency-Key')
        header.push({
          key: p.name,
          value: '',
          description: p.description ?? '',
          disabled: !p.required,
        });
    if (o.method === 'post') header.push({ key: 'Idempotency-Key', value: '{{$guid}}' });
    const bodySchema = jsonBodySchema(o.op);
    if (bodySchema) header.push({ key: 'Content-Type', value: 'application/json' });
    const request: Json = {
      method: o.method.toUpperCase(),
      header,
      url: {
        raw: `{{baseUrl}}/${rawPath}${
          query.some((q: Json) => !q.disabled)
            ? '?' +
              query
                .filter((q: Json) => !q.disabled)
                .map((q: Json) => `${q.key}=${q.value}`)
                .join('&')
            : ''
        }`,
        host: ['{{baseUrl}}'],
        path: rawPath.split('/'),
        ...(query.length ? { query } : {}),
        ...(pathParams.length
          ? {
              variable: pathParams.map((p: Json) => ({
                key: p.name,
                value: String(p.example ?? p.schema?.example ?? ''),
                description: p.description ?? '',
              })),
            }
          : {}),
      },
      description: [o.scopes.length ? `scope: ${o.scopes.join(' | ')}` : '', o.op.description ?? '']
        .filter(Boolean)
        .join('\n\n'),
    };
    if (bodySchema)
      request.body = {
        mode: 'raw',
        raw: JSON.stringify(sample(doc, bodySchema), null, 2),
        options: { raw: { language: 'json' } },
      };
    const list = folders.get(o.tag) ?? [];
    list.push({ name: title(o), request });
    folders.set(o.tag, list);
  }
  const rank = (t: string) => {
    const i = TAGS.findIndex(([k]) => k === t);
    return i < 0 ? TAGS.length : i;
  };
  return {
    info: {
      name: 'TMS API v1',
      description:
        'สร้างจาก OpenAPI ของ TMS (packages/contracts/openapi.json) — ตั้งตัวแปร baseUrl (ไม่ต้องใส่ /v1) และ apiKey (tk_test_… สำหรับ Sandbox)',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{apiKey}}', type: 'string' }] },
    variable: [
      { key: 'baseUrl', value: 'https://api.tms.example' },
      { key: 'apiKey', value: 'tk_test_' },
      { key: 'apiVersion', value: String(doc.info?.['x-api-version-latest'] ?? '') },
    ],
    item: [...folders.keys()]
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((tag) => ({ name: TAGS.find(([k]) => k === tag)?.[1] ?? tag, item: folders.get(tag) })),
  };
}
