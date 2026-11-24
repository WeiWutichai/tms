#!/usr/bin/env node
// ST9-T13 R2 (L-06; NFR-154 [PROPOSED]): สแกน secret ในไฟล์ที่อยู่ใน git — ไม่ใช้เครือข่าย (แทน gitleaks ที่ต้องดาวน์โหลด)
// ใช้: node scripts/scan-secrets.mjs   (รันใน `pnpm lint` → ทั้ง ci:local และ GitHub CI)
// เจอ = exit 1 พร้อมไฟล์:บรรทัด · ค่าตัวอย่างที่ตั้งใจ (dev-only ใน .env.example / test) อยู่ใน ALLOW
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36,}\b|\bgithub_pat_[0-9A-Za-z_]{40,}\b/],
  ['Slack token', /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe key', /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/],
  ['TMS API key', /\btk_live_[0-9a-f]{48}\b/],
  ['LINE channel token', /\b[A-Za-z0-9+/]{150,}={0,2}\b/],
];
// ไฟล์ที่ข้าม: lock/artefact ที่สร้างอัตโนมัติ + ต้นแบบ UI ที่ export มา
const SKIP = [
  /^pnpm-lock\.yaml$/,
  /^design\/prototype\//,
  /^packages\/api-docs\/site\//,
  /\.(png|jpe?g|webp|gif|pdf|xlsx|woff2?|ico)$/i,
];
// ค่าที่ตั้งใจให้อยู่ใน repo (dev/test เท่านั้น — production ปฏิเสธที่ตอนบูต: assertNoDevKeys / API_KEY_PEPPER / signing keys)
const ALLOW = [
  /^apps\/api\/test\//,
  /\.test\.tsx?$/,
  /^apps\/web\/e2e\//,
  /^apps\/api\/test\/fixtures\//,
];

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const hits = [];
for (const f of files) {
  if (SKIP.some((r) => r.test(f))) continue;
  let text;
  try {
    if (statSync(f).size > 2_000_000) continue;
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of RULES) {
      if (!re.test(line)) continue;
      // test/e2e ใช้ key/ชุดทดสอบได้ ยกเว้น private key จริง
      if (name !== 'private key' && ALLOW.some((r) => r.test(f))) continue;
      // base64 ยาว: เฉพาะที่ดูเป็นค่าที่กำหนด (= หรือ :) ไม่ใช่ data URI / ข้อมูลรูป
      if (
        name === 'LINE channel token' &&
        (!/[=:]\s*['"]?[A-Za-z0-9+/]{150,}/.test(line) || /data:/.test(line))
      )
        continue;
      hits.push(`${f}:${i + 1}  ${name}`);
    }
  });
}
if (hits.length) {
  console.error(`✘ พบค่าที่อาจเป็น secret ${hits.length} จุด:\n  ` + hits.join('\n  '));
  console.error(
    '  ถ้าเป็นค่าทดสอบที่ตั้งใจ ให้ย้ายไปไว้ใต้ test/ หรือเพิ่มกฎใน scripts/scan-secrets.mjs (พร้อมเหตุผล)',
  );
  process.exit(1);
}
console.log(`scan-secrets: ${files.length} ไฟล์ — ไม่พบ secret`);
