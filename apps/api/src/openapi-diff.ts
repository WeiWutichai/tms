/**
 * ตรวจ breaking change ระหว่าง OpenAPI 2 ฉบับ (ST0-T09 CI diff gate, docs/01 §5.1 Versioning)
 * breaking = ลบ path/method, ลบ property ของ schema, ลบค่า enum, เปลี่ยน type, เพิ่ม required ใน request body/parameter
 * non-breaking = เพิ่ม path, เพิ่ม property ที่ไม่บังคับ, เพิ่มค่า enum
 */
type Json = any;

export interface Breaking {
  where: string;
  change: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function requestSchemaNames(spec: Json): Set<string> {
  const names = new Set<string>();
  for (const item of Object.values<Json>(spec.paths ?? {})) {
    for (const m of METHODS) {
      const ref = item?.[m]?.requestBody?.content?.['application/json']?.schema?.$ref as
        string | undefined;
      if (ref) names.add(ref.split('/').pop()!);
    }
  }
  return names;
}

export function diffOpenApi(base: Json, head: Json): Breaking[] {
  const out: Breaking[] = [];
  for (const [path, item] of Object.entries<Json>(base.paths ?? {})) {
    for (const m of METHODS) {
      if (!item[m]) continue;
      const h = head.paths?.[path]?.[m];
      if (!h) {
        out.push({ where: `${m.toUpperCase()} ${path}`, change: 'operation removed' });
        continue;
      }
      const baseParams = new Map<string, Json>(
        (item[m].parameters ?? []).map((p: Json) => [`${p.in}:${p.name}`, p]),
      );
      for (const p of h.parameters ?? []) {
        const b = baseParams.get(`${p.in}:${p.name}`);
        if (p.required && (!b || !b.required))
          out.push({
            where: `${m.toUpperCase()} ${path}`,
            change: `parameter ${p.name} became required`,
          });
      }
    }
  }

  const reqSchemas = requestSchemaNames(head);
  const bs = base.components?.schemas ?? {};
  const hs = head.components?.schemas ?? {};
  for (const [name, b] of Object.entries<Json>(bs)) {
    const h = hs[name];
    if (!h) {
      out.push({ where: `schema ${name}`, change: 'schema removed' });
      continue;
    }
    compareSchema(`schema ${name}`, b, h, reqSchemas.has(name), out);
  }
  return out;
}

function compareSchema(where: string, b: Json, h: Json, isRequest: boolean, out: Breaking[]) {
  if (b.type && h.type && b.type !== h.type)
    out.push({ where, change: `type ${b.type} → ${h.type}` });
  if (Array.isArray(b.enum)) {
    const removed = b.enum.filter((v: unknown) => !(h.enum ?? []).includes(v));
    if (removed.length) out.push({ where, change: `enum values removed: ${removed.join(', ')}` });
  }
  for (const [prop, bp] of Object.entries<Json>(b.properties ?? {})) {
    const hp = h.properties?.[prop];
    if (!hp) out.push({ where: `${where}.${prop}`, change: 'property removed' });
    else compareSchema(`${where}.${prop}`, bp, hp, isRequest, out);
  }
  if (isRequest) {
    const added = (h.required ?? []).filter((r: string) => !(b.required ?? []).includes(r));
    if (added.length)
      out.push({ where, change: `request fields became required: ${added.join(', ')}` });
  }
  if (b.items && h.items) compareSchema(`${where}[]`, b.items, h.items, isRequest, out);
}
