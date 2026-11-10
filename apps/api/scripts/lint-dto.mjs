// ST0-T06: ทุก @Body()/@Query() ต้องเป็น class DTO (มี class-validator) — ห้าม any/object/Record/inline type
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../src', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.controller.ts')) files.push(p);
  }
})(root);

const BAD =
  /@(Body|Query)\(\s*(?:'[^']*')?\s*\)\s*\w+\??\s*:\s*(any|object|unknown|Record<[^>]*>|\{[^}]*\}|string|number|boolean)\b/g;
const problems = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(BAD)) {
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(`${f}:${line}  @${m[1]}() ต้องใช้ class DTO ที่มี validator (พบ '${m[2]}')`);
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`lint-dto: ${files.length} controllers OK`);
