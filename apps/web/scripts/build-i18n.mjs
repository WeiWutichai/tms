// สร้าง src/i18n/en.ts และ zh.ts จาก th.ts + พจนานุกรมของต้นแบบ (design/prototype/i18n.js: บรรทัด "ไทย|EN|中文")
// key ที่หาคำแปลไม่ได้จะไม่ถูกใส่ (fallback เป็นไทยตอนรัน) — ดูรายการใน output แล้วเติมใน src/i18n/extra.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { EXTRA } from '../src/i18n/extra.mjs';

const root = new URL('..', import.meta.url).pathname;
const thSrc = readFileSync(root + 'src/i18n/th.ts', 'utf8');
const th = Object.fromEntries(
  [...thSrc.matchAll(/^\s+'([^']+)': '((?:[^'\\]|\\.)*)',$/gm)].map((m) => [m[1], m[2]]),
);
const raw = readFileSync(root + '../../design/prototype/i18n.js', 'utf8');
const dict = new Map();
for (const line of raw.split('\n')) {
  const parts = line.split('|');
  if (parts.length === 3 && !dict.has(parts[0].trim()))
    dict.set(parts[0].trim(), [parts[1].trim(), parts[2].trim()]);
}
const out = { en: {}, zh: {} };
const missing = [];
for (const [k, v] of Object.entries(th)) {
  const d = dict.get(v);
  const ex = EXTRA[k];
  const en = ex?.en ?? d?.[0];
  const zh = ex?.zh ?? d?.[1];
  if (en) out.en[k] = en;
  else missing.push(`${k} (en)`);
  if (zh) out.zh[k] = zh;
  else missing.push(`${k} (zh)`);
}
for (const lang of ['en', 'zh']) {
  const body = Object.entries(out[lang])
    .map(([k, v]) => `  '${k}': ${JSON.stringify(v)},`)
    .join('\n');
  writeFileSync(
    root + `src/i18n/${lang}.ts`,
    `// สร้างอัตโนมัติโดย scripts/build-i18n.mjs — อย่าแก้มือ (แก้ใน th.ts หรือ extra.mjs แล้วรันใหม่)\nimport type { MessageKey } from './th';\n\nexport const ${lang}: Partial<Record<MessageKey, string>> = {\n${body}\n};\n`,
  );
}
console.log(
  `en ${Object.keys(out.en).length}/${Object.keys(th).length}, zh ${Object.keys(out.zh).length}/${Object.keys(th).length}`,
);
if (missing.length) console.log('missing:', missing.join(', '));
