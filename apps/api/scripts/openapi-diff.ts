/**
 * CI gate: เทียบ OpenAPI ของ base branch กับของ PR
 * ใช้: tsx scripts/openapi-diff.ts <base.json> [head.json]   (head ค่าเริ่มต้น = packages/contracts/openapi.json)
 * มี breaking → exit 1 (ยกเว้นตั้ง ALLOW_BREAKING=1 พร้อมเหตุผลใน PR — ต้องมี ADR)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffOpenApi } from '../src/openapi-diff';

const [baseFile, headFile = resolve(__dirname, '../../../packages/contracts/openapi.json')] =
  process.argv.slice(2);
if (!baseFile) {
  console.error('usage: openapi-diff <base.json> [head.json]');
  process.exit(2);
}
const breaking = diffOpenApi(
  JSON.parse(readFileSync(baseFile, 'utf8')),
  JSON.parse(readFileSync(headFile, 'utf8')),
);
if (breaking.length === 0) {
  console.log('OpenAPI: no breaking changes');
} else {
  console.error(`OpenAPI: ${breaking.length} breaking change(s):`);
  for (const b of breaking) console.error(`  - ${b.where}: ${b.change}`);
  if (process.env.ALLOW_BREAKING !== '1') process.exit(1);
}
