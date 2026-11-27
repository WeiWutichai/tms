/**
 * node dist/cli.js          → เขียน site/ ใหม่ (ลบไฟล์ที่ไม่ได้สร้างแล้ว — ยกเว้น site/images/ ของ Playwright) แล้วตรวจลิงก์/ภาพ
 * node dist/cli.js --check  → ไม่เขียน; ต่างจากที่ commit หรือลิงก์/ภาพขาด = exit 1 (CI gate แบบ api-docs docs:check)
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { checkSite } from './check';
import { connectorEntries, problemCodes } from './errors';
import { IMAGES_DIR, IMAGES_SUBDIR, loadInputs, SITE_DIR } from './inputs';
import { buildSite } from './site';

function main() {
  const check = process.argv.includes('--check');
  const { articles, doc, problemMessages } = loadInputs();
  const files = buildSite(articles, doc, problemMessages);
  const existing = existsSync(SITE_DIR)
    ? readdirSync(SITE_DIR).filter((f) => f !== IMAGES_SUBDIR)
    : [];
  const images = new Set(
    existsSync(IMAGES_DIR)
      ? readdirSync(IMAGES_DIR).filter(
          (f) => /\.(png|jpe?g|webp|svg)$/.test(f) && statSync(join(IMAGES_DIR, f)).size > 0,
        )
      : [],
  );
  const problems = checkSite(files, images, problemCodes(doc, problemMessages), connectorEntries());
  if (check) {
    for (const [name, body] of files) {
      const p = join(SITE_DIR, name);
      if (!existsSync(p)) problems.push(`ขาด ${name}`);
      else if (readFileSync(p, 'utf8') !== body) problems.push(`ไม่ตรง ${name}`);
    }
    for (const name of existing) if (!files.has(name)) problems.push(`เกิน ${name}`);
    if (problems.length) {
      console.error(
        `✘ help center (packages/help-center/site) ไม่ตรง/ลิงก์หรือภาพขาด — รัน \`pnpm --filter @tms/help-center docs:build\` (ภาพ: \`pnpm --filter @tms/web help:shots\`) แล้ว commit\n  ${problems.slice(0, 30).join('\n  ')}`,
      );
      process.exit(1);
    }
    console.log(
      `✔ help center ตรงกับบทความ/catalog error · ลิงก์และภาพครบ (${files.size} ไฟล์ + ภาพ ${images.size})`,
    );
    return;
  }
  mkdirSync(IMAGES_DIR, { recursive: true });
  for (const name of existing) if (!files.has(name)) rmSync(join(SITE_DIR, name));
  for (const [name, body] of files) writeFileSync(join(SITE_DIR, name), body);
  console.log(`wrote ${files.size} files → ${SITE_DIR}`);
  if (problems.length) {
    console.error(`✘ ลิงก์/ภาพขาด:\n  ${problems.slice(0, 30).join('\n  ')}`);
    process.exit(1);
  }
}

main();
