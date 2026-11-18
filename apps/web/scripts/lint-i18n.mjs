// ST0-T15 lint: (1) ทุก key ที่ใช้ใน t('...') ต้องมีใน th.ts (2) ห้ามมีข้อความไทย hard-code ในไฟล์ .tsx/.ts นอก src/i18n
// ST9-T12 เพิ่ม (สแกน key ภาษาที่ขาด): (3) key แบบ template `pre.${x}.suf` ต้องมีอย่างน้อย 1 key ที่ขึ้นต้น/ลงท้ายตรงกัน
//   (4) 'key' as MessageKey (cast ข้ามการตรวจของ TypeScript) ต้องมีจริง (5) enumLabel(t, 'pre.') ต้องมี key ขึ้นต้นนั้น
//   (6) error code ทุกตัวของ API (apps/api/src/common/problem.ts) ต้องมี problem.<code> — UI แสดงด้วย t(`problem.${code}`)
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
const keyList = [...keys];
const hasPattern = (pre, suf) =>
  keyList.some((k) => k.length > pre.length + suf.length && k.startsWith(pre) && k.endsWith(suf));
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const at = relative(root, f);
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g))
    if (!keys.has(m[1])) errors.push(`${at}: key '${m[1]}' ไม่มีใน th.ts`);
  for (const m of src.matchAll(/'([A-Za-z0-9_.]+)' as MessageKey/g))
    if (!keys.has(m[1])) errors.push(`${at}: key '${m[1]}' (as MessageKey) ไม่มีใน th.ts`);
  // template ที่มีตัวแปรตัวเดียว: t(`pre.${x}.suf`) หรือ `pre.${x}` as MessageKey
  for (const m of src.matchAll(
    /(?:\bt\(\s*`([^`$]*)\$\{[^`}]*\}([^`$]*)`|`([^`$]*)\$\{[^`}]*\}([^`$]*)` as MessageKey)/g,
  )) {
    const pre = m[1] ?? m[3];
    const suf = m[2] ?? m[4];
    if (/^[a-z][A-Za-z0-9_.]*\.$/.test(pre) && !hasPattern(pre, suf))
      errors.push(`${at}: ไม่มี key รูป '${pre}*${suf}' ใน th.ts`);
  }
  for (const m of src.matchAll(/\benumLabel\(\s*t\s*,\s*'([^']+)'/g))
    if (!hasPattern(m[1], '')) errors.push(`${at}: enumLabel ไม่มี key ขึ้นต้น '${m[1]}' ใน th.ts`);
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (THAI.test(code) && !/^\s*\*/.test(line))
      errors.push(`${relative(root, f)}:${i + 1}: ข้อความไทย hard-code — ย้ายไป src/i18n/th.ts`);
  });
}
// (6) error code ของ API — catalog คงที่ (ห้ามเปลี่ยนชื่อ) แสดงในหน้าจอผ่าน problem.<code>
const problemSrc = readFileSync(join(root, '../../api/src/common/problem.ts'), 'utf8');
const body = problemSrc.slice(
  problemSrc.indexOf('export const PROBLEMS = {'),
  problemSrc.indexOf('} as const', problemSrc.indexOf('export const PROBLEMS = {')),
);
const codes = [...body.matchAll(/^ {2}([a-z][a-z0-9_]*): \{/gm)].map((m) => m[1]);
if (codes.length < 50)
  errors.push(`อ่าน error code จาก problem.ts ได้แค่ ${codes.length} ตัว — รูปแบบไฟล์เปลี่ยน?`);
for (const c of codes)
  if (!keys.has(`problem.${c}`))
    errors.push(
      `problem.${c}: error code ของ API ไม่มีข้อความใน th.ts (ใช้ข้อความ PROBLEMS.${c}.th)`,
    );

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(
  `lint-i18n: ${files.length} files, ${keys.size} keys, ${codes.length} API error codes OK`,
);
