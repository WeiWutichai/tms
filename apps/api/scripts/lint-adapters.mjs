// ST7-T13: core ไม่ import ErpAdapter ตัวใดตรง ๆ (plan/01 ST7-T13 เกณฑ์ตรวจรับ; CLAUDE.md Standalone-first / ห้าม hard-code ERP)
// กติกา:
//  1. ไฟล์นอก src/erp-adapters/ import อะไรใน src/erp-adapters/ ไม่ได้ — ยกเว้น src/app.module.ts import src/erp-adapters/index.ts
//  2. adapter ใน src/erp-adapters/<key>/ import adapter ตัวอื่น (src/erp-adapters/<other>/) ไม่ได้
//  3. ไฟล์นอก src/erp-adapters/ ห้ามอ้างชื่อที่ export จาก adapter (class/const เช่น KrsAdapter, DemoProvider)
//     และห้าม `new|extends XxxAdapter` ใด ๆ — ต้องหาผ่าน ErpAdapterRegistry
//  ตรวจ import/export from, import()/require()/require.resolve() ทั้งสตริงและ template literal (ใช้ส่วนคงที่หน้า `${`)
// ตรวจ .ts/.mts/.cts/.js/.mjs/.cjs — ไฟล์ test (*.test.*) และ .d.ts ไม่ตรวจ (test ของ adapter ใช้ adapter ตรงได้)
// ใช้: node scripts/lint-adapters.mjs [srcRoot]   (srcRoot ใช้ใน test)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export function checkAdapterBoundary(srcRoot) {
  const root = resolve(srcRoot);
  const adaptersDir = join(root, 'erp-adapters');
  const composition = join(adaptersDir, 'index.ts');
  const appModule = join(root, 'app.module.ts');
  const files = [];
  (function walk(dir) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (
        /\.(c|m)?(t|j)s$/.test(p) &&
        !/\.test\.(c|m)?(t|j)s$/.test(p) &&
        !p.endsWith('.d.ts')
      )
        files.push(p);
    }
  })(root);

  const inside = (p, dir) => p === dir || p.startsWith(dir + sep);
  const resolveSpec = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(from), spec);
    for (const c of [
      base,
      ...['.ts', '.mts', '.js', '.mjs'].map((e) => base + e),
      join(base, 'index.ts'),
    ])
      if (existsSync(c) && statSync(c).isFile()) return c;
    return base;
  };
  const adapterOf = (p) => {
    const rel = relative(adaptersDir, p).split(sep);
    return rel.length > 1 ? rel[0] : null; // null = ไฟล์ระดับบน (index.ts / ส่วนกลางของ adapter)
  };
  const Q = '[\'"`]';
  const IMPORT_RE = new RegExp(
    [
      `(?:import|export)\\s[^'"\`;]*?from\\s*(${Q})((?:(?!\\1).)*)\\1`,
      `\\bimport\\s*\\(\\s*(${Q})((?:(?!\\3).)*)\\3`,
      `\\brequire(?:\\.resolve)?\\s*\\(\\s*(${Q})((?:(?!\\5).)*)\\5`,
      `\\bimport\\s*(${Q})((?:(?!\\7).)*)\\7`,
    ].join('|'),
    'g',
  );
  // ชื่อคลาส adapter ของ ERP ใด ๆ (KrsAdapter, FlowAccountAdapter ...) ยกเว้นชื่อกลางของ framework
  const CLASS_RE = /\b(?:new\s+|extends\s+)([A-Z][A-Za-z0-9]*Adapter)\b/g;
  const ALLOWED_CLASSES = new Set(['ErpAdapter', 'ErpAdapterRegistry', 'ErpAdapterSink']);

  // ชื่อที่ adapter export (class/function/const) — core อ้างชื่อเหล่านี้ไม่ได้ (เช่น DemoProvider, KrsAdapter)
  const exported = new Set();
  for (const f of files)
    if (inside(f, adaptersDir) && f !== composition)
      for (const m of readFileSync(f, 'utf8').matchAll(
        /\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:class|function|const|let)\s+([A-Z][\w$]*)/g,
      ))
        exported.add(m[1]);
  const NAME_RE = exported.size
    ? new RegExp(`\\b(${[...exported].map((n) => n.replace(/\$/g, '\\$')).join('|')})\\b`, 'g')
    : null;

  const problems = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const line = (i) => src.slice(0, i).split('\n').length;
    const inAdapters = inside(f, adaptersDir);
    for (const m of src.matchAll(IMPORT_RE)) {
      // template literal แบบมีตัวแปร → ใช้ส่วนคงที่หน้า `${` (เช่น `../erp-adapters/${key}` = เข้าโฟลเดอร์ adapter)
      const spec = (m[2] ?? m[4] ?? m[6] ?? m[8] ?? '').split('${')[0];
      const target = resolveSpec(f, spec);
      if (!target || !inside(target, adaptersDir)) continue;
      if (!inAdapters) {
        if (f === appModule && target === composition) continue;
        problems.push(
          `${relative(root, f)}:${line(m.index)}  core import adapter ตรงไม่ได้ ('${spec}') — ใช้ ErpAdapterRegistry / ConnectorResolver`,
        );
      } else {
        const a = adapterOf(f);
        const b = adapterOf(target);
        if (a && b && a !== b)
          problems.push(
            `${relative(root, f)}:${line(m.index)}  adapter '${a}' import adapter '${b}' ไม่ได้ ('${spec}')`,
          );
      }
    }
    if (!inAdapters && NAME_RE && f !== appModule)
      for (const m of src.matchAll(NAME_RE))
        problems.push(
          `${relative(root, f)}:${line(m.index)}  core อ้างชื่อจาก adapter ตรง (${m[1]}) — ใช้ ErpAdapterRegistry`,
        );
    if (!inAdapters)
      for (const m of src.matchAll(CLASS_RE))
        if (!ALLOWED_CLASSES.has(m[1]))
          problems.push(
            `${relative(root, f)}:${line(m.index)}  core อ้างคลาส adapter ตรง (${m[1]}) — ใช้ ErpAdapterRegistry`,
          );
  }
  return { files: files.length, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] ?? new URL('../src', import.meta.url).pathname;
  const { files, problems } = checkAdapterBoundary(root);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`lint-adapters: ${files} files OK (core ไม่ import ErpAdapter ตัวใดตรง)`);
}
