// ST0-T15 lint: (1) ทุก key ที่ใช้ใน t('...') ต้องมีใน th.ts (2) ห้ามมีข้อความไทย hard-code ในไฟล์ .tsx/.ts นอก src/i18n
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../src', import.meta.url).pathname;
const thSrc = readFileSync(join(root, 'i18n/th.ts'), 'utf8');
const keys = new Set([...thSrc.matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1]));
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) {
      if (!p.endsWith('/i18n')) walk(p);
    } else if (/\.(tsx?|mjs)$/.test(p) && !/\.test\.tsx?$/.test(p)) files.push(p);
  }
})(root);

const errors = [];
const THAI = /[฀-๿]/;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g))
    if (!keys.has(m[1])) errors.push(`${relative(root, f)}: key '${m[1]}' ไม่มีใน th.ts`);
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (THAI.test(code) && !/^\s*\*/.test(line))
      errors.push(`${relative(root, f)}:${i + 1}: ข้อความไทย hard-code — ย้ายไป src/i18n/th.ts`);
  });
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`lint-i18n: ${files.length} files, ${keys.size} keys OK`);
