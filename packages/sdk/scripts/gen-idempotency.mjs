// สร้าง src/idempotency.gen.ts จาก openapi.json: POST ที่ประกาศ header `Idempotency-Key` (ST7-T12 review)
// SDK ใส่ key อัตโนมัติเฉพาะ path เหล่านี้ — endpoint ที่ไม่รับ (เช่น POST /v1/carriers/{id}/reveal → 400) ไม่ใส่
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(resolve(here, '../../contracts/openapi.json'), 'utf8'));
const deref = (p) =>
  p && p.$ref ? p.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], doc) : p;
const paths = Object.entries(doc.paths)
  .filter(([, item]) =>
    (item.post?.parameters ?? []).some(
      (p) => deref(p)?.in === 'header' && deref(p)?.name?.toLowerCase() === 'idempotency-key',
    ),
  )
  .map(([p]) => p)
  .sort();
writeFileSync(
  resolve(here, '../src/idempotency.gen.ts'),
  `// generate จาก packages/contracts/openapi.json โดย scripts/gen-idempotency.mjs — ห้ามแก้เอง\n` +
    `/** POST ที่รับ header Idempotency-Key (schema path) */\n` +
    `export const IDEMPOTENT_POSTS: ReadonlySet<string> = new Set([\n${paths.map((p) => `  '${p}',`).join('\n')}\n]);\n`,
);
console.log(`idempotency.gen.ts: ${paths.length} POST`);
