/**
 * node dist/cli.js          → เขียน site/ ใหม่ทั้งโฟลเดอร์ (ลบไฟล์ที่ไม่ได้สร้างแล้ว)
 * node dist/cli.js --check  → ไม่เขียน; ต่างจากที่ commit = exit 1 (CI gate เหมือน openapi:check)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadInputs, SITE_DIR } from './inputs';
import { buildSite } from './site';

function main() {
  const check = process.argv.includes('--check');
  const { doc, guides, include } = loadInputs();
  const files = buildSite(doc, guides, include);
  const existing = existsSync(SITE_DIR) ? readdirSync(SITE_DIR) : [];
  if (check) {
    const problems: string[] = [];
    for (const [name, body] of files) {
      const p = join(SITE_DIR, name);
      if (!existsSync(p)) problems.push(`ขาด ${name}`);
      else if (readFileSync(p, 'utf8') !== body) problems.push(`ไม่ตรง ${name}`);
    }
    for (const name of existing) if (!files.has(name)) problems.push(`เกิน ${name}`);
    if (problems.length) {
      console.error(
        `✘ เอกสาร API (packages/api-docs/site) ไม่ตรงกับ openapi.json/guides — รัน \`pnpm --filter @tms/api-docs docs:build\` แล้ว commit\n  ${problems.slice(0, 20).join('\n  ')}`,
      );
      process.exit(1);
    }
    console.log(`✔ เอกสาร API ตรงกับ openapi.json (${files.size} ไฟล์)`);
    return;
  }
  mkdirSync(SITE_DIR, { recursive: true });
  for (const name of existing) if (!files.has(name)) rmSync(join(SITE_DIR, name));
  for (const [name, body] of files) writeFileSync(join(SITE_DIR, name), body);
  console.log(`wrote ${files.size} files → ${SITE_DIR}`);
}

main();
