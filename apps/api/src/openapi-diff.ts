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

/**
 * การแก้ชนิดใน OpenAPI ที่ไม่เปลี่ยนข้อมูลบนสาย (ADR T-22) — `schema` = `Name.prop` ตามที่ diff รายงาน
 * ยอมเฉพาะ type object → string (DTO ที่ลืม `type: String` บนช่อง nullable) ไม่ใช่ทางลัดของ breaking อื่น
 */
export interface OpenApiCorrection {
  schema: string;
  from: string;
  to: string;
  adr: string;
}

export function diffOpenApi(
  base: Json,
  head: Json,
  corrections: readonly OpenApiCorrection[] = [],
): Breaking[] {
  const out = diffAll(base, head);
  const allowed = new Set(
    corrections
      .filter((c) => c.from === 'object' && c.to === 'string' && !!c.adr)
      .map((c) => `schema ${c.schema}: type object → string`),
  );
  return out.filter((x) => !allowed.has(`${x.where}: ${x.change}`));
}

function diffAll(base: Json, head: Json): Breaking[] {
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

/** ทุก schema ใน OpenAPI ที่ export แล้ว: ห้าม `type: object` เปล่า (DTO ลืม `type: String` → client generate เป็น object) */
export function bareObjects(spec: {
  components?: { schemas?: Record<string, unknown> };
}): string[] {
  const bad: string[] = [];
  const walk = (where: string, s: unknown) => {
    if (!s || typeof s !== 'object') return;
    const o = s as Record<string, unknown>;
    if (
      o.type === 'object' &&
      !o.properties &&
      !o.$ref &&
      o.additionalProperties === undefined &&
      !o.allOf &&
      !o.oneOf &&
      !o.anyOf
    )
      bad.push(where);
    for (const [k, v] of Object.entries((o.properties as Record<string, unknown>) ?? {}))
      walk(`${where}.${k}`, v);
    if (o.items) walk(`${where}[]`, o.items);
  };
  for (const [n, s] of Object.entries(spec.components?.schemas ?? {})) walk(n, s);
  return bad;
}
