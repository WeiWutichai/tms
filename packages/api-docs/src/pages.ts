/** สร้างหน้าเอกสาร (markdown) จาก openapi.json + guides/ (ST7-T12) */
import {
  deref,
  fieldRows,
  jsonBodySchema,
  oneLine,
  operations,
  parameters,
  refName,
  sample,
  title,
  typeLabel,
  type FieldRow,
  type Json,
  type Operation,
} from './openapi';

export interface Page {
  slug: string;
  title: string;
  /** กลุ่มในเมนูซ้าย (spec/07 §9: เริ่มต้นใช้งาน → แนวทาง → resource → webhook events → error codes → changelog) */
  group: string;
  /** คำอธิบายสั้น (llms.txt) */
  summary: string;
  md: string;
}

export interface Guide {
  slug: string;
  md: string;
}

export const GROUPS = ['เริ่มต้นใช้งาน', 'แนวทาง', 'Resource', 'อ้างอิง'] as const;
const START_GUIDES = new Set(['quickstart', 'authentication']);

/** ลำดับ + ชื่อไทยของกลุ่ม resource (ตาม docs/04 G2 ก่อน แล้ว master/อื่น ๆ) */
export const TAGS: [string, string][] = [
  ['orders', 'ใบสั่งขนส่ง (orders)'],
  ['delivery-orders', 'ใบส่งของ (delivery-orders)'],
  ['trips', 'เที่ยววิ่ง (trips)'],
  ['stops', 'จุดส่ง (stops)'],
  ['documents', 'ไฟล์และเอกสาร (documents)'],
  ['webhooks', 'Webhooks และ events'],
  ['sandbox', 'Sandbox'],
  ['jobs', 'งานเบื้องหลัง (jobs)'],
  ['customers', 'ลูกค้า (customers)'],
  ['customer-sites', 'สถานที่ (customer-sites)'],
  ['products', 'สินค้า (products)'],
  ['units', 'หน่วย (units)'],
  ['vehicle-types', 'ประเภทรถ (vehicle-types)'],
  ['service-items', 'รายการค่าบริการ (service-items)'],
  ['reason-codes', 'รหัสเหตุผล (reason-codes)'],
  ['routes', 'เส้นทาง (routes)'],
  ['rate-cards', 'ตารางราคา (rate-cards)'],
  ['carriers', 'รถร่วม (carriers)'],
  ['vehicles', 'รถ (vehicles)'],
  ['drivers', 'คนขับ (drivers)'],
  ['vehicle-documents', 'เอกสารรถ (vehicle-documents)'],
  ['carrier-docs', 'เอกสารรถร่วม (carrier-docs)'],
  ['order-templates', 'แม่แบบใบสั่ง (order-templates)'],
  ['planning', 'วางแผน (planning)'],
  ['schedule', 'ตารางงาน (schedule)'],
  ['exports', 'ส่งออกไฟล์ (exports)'],
  ['connectors', 'Connector ERP (connectors)'],
  ['messaging', 'ส่งข้อความ (messaging)'],
  ['companies', 'นิติบุคคล (companies)'],
  ['branches', 'สาขา (branches)'],
  ['document-sequences', 'เลขที่เอกสาร (document-sequences)'],
  ['settings', 'ตั้งค่า (settings)'],
  ['audit', 'ประวัติการทำรายการ (audit)'],
  ['auth', 'OAuth และระบบ (auth)'],
];

const tagTitle = (t: string) => TAGS.find(([k]) => k === t)?.[1] ?? t;
const tagRank = (t: string) => {
  const i = TAGS.findIndex(([k]) => k === t);
  return i < 0 ? TAGS.length : i;
};

function table(head: string[], rows: string[][]): string {
  if (!rows.length) return '';
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map((c) => c || ' ').join(' | ')} |`),
  ].join('\n');
}

const code = (s: string) => (s ? `\`${s.replace(/`/g, "'")}\`` : '');

function fieldTable(rows: FieldRow[]): string {
  return table(
    ['ฟิลด์', 'บังคับ', 'ชนิด', 'กฎ', 'คำอธิบาย', 'ตัวอย่าง'],
    rows.map((r) => [
      code(r.name),
      r.required ? 'ใช่' : '',
      code(r.type),
      r.rules,
      r.description,
      r.example ? code(r.example) : '',
    ]),
  );
}

function examplePath(doc: Json, o: Operation): string {
  let p = o.path;
  for (const prm of parameters(doc, o.op).filter((x: Json) => x.in === 'path')) {
    const ex = prm.example ?? prm.schema?.example ?? `<${prm.name}>`;
    p = p.replace(`{${prm.name}}`, String(ex));
  }
  return p;
}

function curl(doc: Json, o: Operation): string {
  const m = o.method.toUpperCase();
  const lines = [
    `curl -sS -X ${m} "$TMS_BASE_URL${examplePath(doc, o)}" \\`,
    `  -H "Authorization: Bearer $TMS_API_KEY"`,
  ];
  const body = jsonBodySchema(o.op);
  if (m === 'POST') lines[lines.length - 1] += ' \\\n  -H "Idempotency-Key: $(uuidgen)"';
  if (body) {
    lines[lines.length - 1] += ' \\\n  -H "Content-Type: application/json"';
    lines[lines.length - 1] +=
      ` \\\n  -d '${JSON.stringify(sample(doc, body)).replace(/'/g, "'\\''")}'`;
  }
  return '```bash\n' + lines.join('\n') + '\n```';
}

function sdkSnippet(doc: Json, o: Operation): string {
  const prms = parameters(doc, o.op);
  const path = prms.filter((x: Json) => x.in === 'path');
  const parts: string[] = [];
  if (path.length)
    parts.push(
      `params: { path: { ${path
        .map(
          (x: Json) =>
            `${/^\w+$/.test(x.name) ? x.name : JSON.stringify(x.name)}: ${JSON.stringify(String(x.example ?? x.schema?.example ?? '…'))}`,
        )
        .join(', ')} } }`,
    );
  const body = jsonBodySchema(o.op);
  if (body)
    parts.push(`body: ${JSON.stringify(sample(doc, body), null, 2).replace(/\n/g, '\n  ')}`);
  const args = parts.length ? `, {\n  ${parts.join(',\n  ')},\n}` : '';
  return (
    '```ts\n' +
    `const { data, error } = await tms.${o.method.toUpperCase()}('${o.path}'${args});\n` +
    '```'
  );
}

function responses(doc: Json, o: Operation): string {
  const rows: string[][] = [];
  for (const [status, raw] of Object.entries<Json>(o.op.responses ?? {})) {
    const r = deref(doc, raw);
    const content = r?.content ?? {};
    const ct = Object.keys(content)[0];
    const schema = ct ? content[ct].schema : undefined;
    const codes = ct === 'application/problem+json' ? Object.keys(content[ct].examples ?? {}) : [];
    rows.push([
      code(status),
      [
        oneLine(r?.description),
        codes.length ? codes.map((c) => `[${c}](errors.md#${c})`).join(', ') : '',
      ]
        .filter(Boolean)
        .join(' — '),
      schema ? code(typeLabel(doc, schema)) : '',
    ]);
  }
  return table(['สถานะ', 'ความหมาย', 'body'], rows);
}

function operationMd(doc: Json, o: Operation, schemas: Set<string>): string {
  const out: string[] = [];
  out.push(`## ${title(o)} {#${o.anchor}}`);
  out.push(`\`${o.method.toUpperCase()} ${o.path}\``);
  const meta: string[] = [];
  if (o.scopes.length) meta.push(`scope: ${o.scopes.map(code).join(' หรือ ')}`);
  else meta.push('scope: —');
  if (o.op.operationId) meta.push(`operationId: ${code(o.op.operationId)}`);
  if (o.op.deprecated) meta.push('**เลิกใช้ (deprecated)**');
  out.push(meta.join(' · '));
  if (o.op.description) out.push(oneLine(o.op.description).replace(/\\\|/g, '|'));
  const prms = parameters(doc, o.op);
  if (prms.length) {
    out.push('**Parameters**');
    out.push(
      table(
        ['ชื่อ', 'อยู่ที่', 'บังคับ', 'ชนิด', 'คำอธิบาย'],
        prms.map((p: Json) => [
          code(p.name),
          p.in,
          p.required ? 'ใช่' : '',
          code(typeLabel(doc, p.schema)) +
            (deref(doc, p.schema)?.enum
              ? ` ค่า: ${deref(doc, p.schema)
                  .enum.map((e: unknown) => code(String(e)))
                  .join(', ')}`
              : ''),
          oneLine(p.description),
        ]),
      ),
    );
  }
  const body = jsonBodySchema(o.op);
  if (body) {
    out.push(`**Request body** ${code(typeLabel(doc, body))}`);
    const rows = fieldRows(doc, body, 3);
    if (rows.length) out.push(fieldTable(rows));
  }
  out.push('**Responses**');
  out.push(responses(doc, o));
  for (const raw of Object.values<Json>(o.op.responses ?? {})) {
    const r = deref(doc, raw);
    const s = r?.content?.['application/json']?.schema;
    const n = refName(s);
    if (n) schemas.add(n);
  }
  out.push('**ตัวอย่าง**');
  out.push(curl(doc, o));
  out.push(sdkSnippet(doc, o));
  return out.join('\n\n');
}

export function resourcePages(doc: Json): Page[] {
  const ops = operations(doc);
  const byTag = new Map<string, Operation[]>();
  for (const o of ops) byTag.set(o.tag, [...(byTag.get(o.tag) ?? []), o]);
  const tags = [...byTag.keys()].sort((a, b) => tagRank(a) - tagRank(b) || a.localeCompare(b));
  return tags.map((tag) => {
    const list = byTag.get(tag)!;
    const schemas = new Set<string>();
    const sections = list.map((o) => operationMd(doc, o, schemas));
    const toc = table(
      ['Endpoint', 'scope'],
      list.map((o) => [
        `[\`${o.method.toUpperCase()} ${o.path}\`](#${o.anchor})`,
        o.scopes.map(code).join(' / '),
      ]),
    );
    const schemaMd = [...schemas].sort().map((n) => {
      const rows = fieldRows(doc, { $ref: `#/components/schemas/${n}` }, 1);
      return `### ${n} {#schema-${n}}\n\n${oneLine(doc.components.schemas[n]?.description)}\n\n${fieldTable(rows)}`;
    });
    const t = tagTitle(tag);
    const md = [
      `# ${t}`,
      `${list.length} endpoint · ทุกคำขอส่ง \`Authorization: Bearer <API key>\` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)`,
      toc,
      ...sections,
      schemaMd.length ? `## Schema ของ response {#schemas}\n\n${schemaMd.join('\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      slug: `ref-${tag}`,
      title: t,
      group: 'Resource',
      summary: `${list.length} endpoint: ${list
        .slice(0, 6)
        .map((o) => `${o.method.toUpperCase()} ${o.path}`)
        .join(', ')}${list.length > 6 ? ', …' : ''}`,
      md: md + '\n',
    };
  });
}

export function webhookEventsPage(doc: Json): Page {
  const hooks: Json = doc['x-webhooks'] ?? {};
  const types = Object.keys(hooks).sort();
  const rows = types.map((t) => [
    `[\`${t}\`](#${t.replace(/\./g, '-')})`,
    hooks[t].phase === 'active' ? 'ใช้งาน' : 'ยังไม่ส่ง (จองชื่อไว้)',
    code(hooks[t].dto ?? ''),
    oneLine(hooks[t].description),
  ]);
  const sections = types.map((t) => {
    const h = hooks[t];
    // `x-webhooks[type].schema` = schema ของ data.object (envelope อยู่ที่ WebhookEnvelope)
    const rowsObj = h.schema ? fieldRows(doc, h.schema, 1) : [];
    return [
      `## ${t} {#${t.replace(/\./g, '-')}}`,
      oneLine(h.description),
      h.phase === 'active' ? '' : '> ยังไม่ส่ง — ชื่อและ schema จองไว้ (สมัครรับล่วงหน้าได้)',
      `\`data.object\` = ${code(h.dto ?? '')}`,
      rowsObj.length ? fieldTable(rowsObj) : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  });
  const md = [
    '# Webhook events',
    'รายการ event สาธารณะทั้งหมด (= `GET /v1/webhooks/event-types`) — envelope, header และวิธีตรวจลายเซ็นดูที่ [Webhook และการตรวจลายเซ็น](webhooks.md)',
    table(['event', 'สถานะ', 'data.object', 'เกิดเมื่อ'], rows),
    ...sections,
  ].join('\n\n');
  return {
    slug: 'webhook-events',
    title: 'Webhook events',
    group: 'อ้างอิง',
    summary: `${types.length} event: ${types.slice(0, 8).join(', ')}, …`,
    md: md + '\n',
  };
}

/** รหัสที่ใช้เป็น errors[].code (ตัว problem = validation_failed) */
const FIELD_CODES = new Set([
  'routing_not_configured',
  'company_unavailable',
  'branch_unavailable',
]);

export function errorsPage(doc: Json): Page {
  const catalog = new Map<string, { status: number; title: string; ops: Set<string> }>();
  const add = (ex: Json, where: string | undefined) => {
    const v = ex?.value;
    if (!v?.code) return;
    const c = catalog.get(v.code) ?? { status: v.status, title: v.title, ops: new Set<string>() };
    if (!c.title) c.title = v.title;
    if (where) c.ops.add(where);
    catalog.set(v.code, c);
  };
  // catalog ของ API ทั้งหมด (PROBLEMS → x-problem-codes) — ทุก `type` ที่ API ตอบมีหัวข้อในหน้านี้
  for (const [c, p] of Object.entries<Json>(doc['x-problem-codes'] ?? {}))
    catalog.set(c, { status: p.status, title: p.title, ops: new Set<string>() });
  for (const r of Object.values<Json>(doc.components.responses ?? {}))
    for (const ex of Object.values<Json>(r?.content?.['application/problem+json']?.examples ?? {}))
      add(ex, undefined);
  for (const o of operations(doc))
    for (const raw of Object.values<Json>(o.op.responses ?? {})) {
      const r = deref(doc, raw);
      for (const ex of Object.values<Json>(
        r?.content?.['application/problem+json']?.examples ?? {},
      ))
        add(ex, `[\`${o.method.toUpperCase()} ${o.path}\`](ref-${o.tag}.md#${o.anchor})`);
    }
  const codes = [...catalog.keys()].sort(
    (a, b) => catalog.get(a)!.status - catalog.get(b)!.status || a.localeCompare(b),
  );
  const sections = codes.map((c) => {
    const e = catalog.get(c)!;
    const ops = [...e.ops];
    return [
      `## ${c} {#${c}}`,
      `HTTP \`${e.status}\` · ${oneLine(e.title)}`,
      ops.length
        ? `พบใน: ${ops.slice(0, 12).join(', ')}${ops.length > 12 ? ` และอีก ${ops.length - 12} endpoint` : ''}`
        : FIELD_CODES.has(c)
          ? 'อยู่ใน `errors[].code` ของ `422 validation_failed` (`errors[].field` = ช่องที่ต้องแก้)'
          : 'อาจตอบได้จากหลาย endpoint',
    ].join('\n\n');
  });
  const md = [
    '# รหัส error',
    'ทุก error เป็น `application/problem+json` (RFC 9457) — `type` = `https://docs.tms.example/problems/<code>` ชี้มาที่หัวข้อในหน้านี้ · ตัดสินใจจาก `code` เท่านั้น ดู [แนวทางการใช้ API](conventions.md#รูปแบบ-error-rfc-9457)',
    table(
      ['code', 'HTTP', 'ความหมาย'],
      codes.map((c) => [
        `[\`${c}\`](#${c})`,
        String(catalog.get(c)!.status),
        oneLine(catalog.get(c)!.title),
      ]),
    ),
    ...sections,
  ].join('\n\n');
  return {
    slug: 'errors',
    title: 'รหัส error',
    group: 'อ้างอิง',
    summary: `${codes.length} code ของ problem+json`,
    md: md + '\n',
  };
}

export function changelogPage(doc: Json): Page {
  const versions: Json[] = [...(doc.info?.['x-api-versions'] ?? [])].reverse();
  const sections = versions.map((v) => {
    const ch: Json[] = v.changes ?? [];
    return [
      `## ${v.version}`,
      oneLine(v.summary),
      ch.length
        ? table(
            ['รหัสการเปลี่ยน', 'รายละเอียด'],
            ch.map((c: Json) => [
              code(c.id ?? c.kind ?? c.type ?? ''),
              oneLine(c.summary ?? c.description ?? JSON.stringify(c)),
            ]),
          )
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  });
  const md = [
    '# Changelog',
    `เวอร์ชันพฤติกรรม (\`X-Api-Version\`) ล่าสุด: \`${doc.info?.['x-api-version-latest'] ?? ''}\` — วิธีเลือกเวอร์ชันดู [เวอร์ชันของ API](versioning.md)`,
    ...sections,
  ].join('\n\n');
  return {
    slug: 'changelog',
    title: 'Changelog',
    group: 'อ้างอิง',
    summary: 'ประวัติเวอร์ชันของ API (added/changed/deprecated)',
    md: md + '\n',
  };
}

/** หน้า guide: บรรทัดแรก `# ชื่อ`, ย่อหน้าแรก = summary · `<!-- include: path -->` → แทรกไฟล์เป็น code block */
export function guidePage(g: Guide, include: (path: string) => string): Page {
  const md = g.md.replace(/<!--\s*include:\s*(\S+)\s*-->/g, (_m, p: string) => {
    const lang = p.endsWith('.ts') ? 'ts' : '';
    return '```' + lang + '\n' + include(p).trimEnd() + '\n```';
  });
  const lines = md.split('\n');
  const t = (lines.find((l) => l.startsWith('# ')) ?? `# ${g.slug}`).slice(2).trim();
  const summary = lines.find((l, i) => i > 0 && l.trim() && !l.startsWith('#')) ?? '';
  return {
    slug: g.slug,
    title: t,
    group: START_GUIDES.has(g.slug) ? 'เริ่มต้นใช้งาน' : 'แนวทาง',
    summary: oneLine(summary.replace(/\*\*/g, '')),
    md: md.endsWith('\n') ? md : md + '\n',
  };
}

export function indexPage(doc: Json, pages: Page[]): Page {
  const groups = GROUPS.map((g) => {
    const ps = pages.filter((p) => p.group === g);
    return `## ${g}\n\n${ps.map((p) => `- [${p.title}](${p.slug}.md) — ${p.summary}`).join('\n')}`;
  });
  const md = [
    '# TMS API v1',
    `เอกสาร Open API ของ TMS — endpoint ชุดเดียวกับที่เว็บของ TMS ใช้ (API-first) · เวอร์ชันพฤติกรรมล่าสุด \`${doc.info?.['x-api-version-latest'] ?? ''}\` · ${operations(doc).length} endpoint`,
    'เริ่มที่ [Quickstart](quickstart.md) (สร้าง order แรกใน Sandbox ภายใน 15 นาที) · ดาวน์โหลด [Postman collection](tms-api.postman_collection.json) · [OpenAPI](openapi.json) · สำหรับ AI/LLM: [llms.txt](llms.txt), [llms-full.txt](llms-full.txt) · ทุกหน้ามีฉบับ Markdown (`<หน้า>.md`)',
    ...groups,
  ].join('\n\n');
  return { slug: 'index', title: 'TMS API v1', group: '', summary: 'หน้าแรก', md: md + '\n' };
}

export function buildPages(doc: Json, guides: Guide[], include: (path: string) => string): Page[] {
  const gp = guides.map((g) => guidePage(g, include));
  const start = gp.filter((p) => p.group === 'เริ่มต้นใช้งาน');
  const rest = gp.filter((p) => p.group !== 'เริ่มต้นใช้งาน');
  const pages = [
    ...start,
    ...rest,
    ...resourcePages(doc),
    webhookEventsPage(doc),
    errorsPage(doc),
    changelogPage(doc),
  ];
  return [indexPage(doc, pages), ...pages];
}
