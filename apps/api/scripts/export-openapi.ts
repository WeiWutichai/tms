/** สร้าง OpenAPI จาก decorator แล้วเขียนลง packages/contracts/openapi.json (ไม่ต้องต่อฐานข้อมูล) */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApi, createApp } from '../src/bootstrap';

async function main() {
  process.env.APP_DATABASE_URL ??= 'postgresql://x:x@localhost:1/x';
  process.env.PLATFORM_DATABASE_URL ??= 'postgresql://x:x@localhost:1/x';
  process.env.AUTH_DEV_SECRET ??= 'x'.repeat(32);
  process.env.NODE_ENV = 'test';
  const app = await createApp();
  const doc = buildOpenApi(app);
  const out = resolve(__dirname, '../../../packages/contracts/openapi.json');
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  await app.close();
  console.log(`wrote ${out}`);
}
void main();
