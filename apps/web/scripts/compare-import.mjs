// ภาพเทียบ "ต้นแบบ | ของจริง" ของ wizard นำเข้า (ST1-T19) 3 ขั้น ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) + seed · ของจริงใช้หน้า /dev/import (kind sample)
// ใช้: node scripts/compare-import.mjs
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const proto = 'file://' + fileURLToPath(new URL('../../../design/prototype/TMS v4.dc.html', import.meta.url));
const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(proto);
await P.waitForTimeout(2500);
for (const el of await P.getByText('ข้อมูลหลัก', { exact: true }).filter({ visible: true }).all()) {
  await el.click();
  await P.waitForTimeout(400);
}
await P.getByText('ลูกค้า', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(800);
await P.getByText('นำเข้า Excel', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(500);
await P.getByRole('button', { name: 'เลือกไฟล์' }).click();
await P.waitForTimeout(300);
const a1 = await P.screenshot();
await P.getByRole('button', { name: 'ถัดไป' }).click();
await P.waitForTimeout(400);
const a2 = await P.screenshot();
await P.getByRole('button', { name: /^นำเข้า \d+ แถว$/ }).click();
await P.waitForTimeout(400);
const a3 = await P.screenshot();

const ctx = await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: 'http://localhost:4420' });
await ctx.addCookies([
  { name: 'tms_td', value: 'demo-trusted-device-e2e-only-0000000000000:00000000-0000-4000-8000-0000000e0a01', url: 'http://localhost:4420/v1/auth' },
]);
const W = await ctx.newPage();
const v = randomBytes(32).toString('base64url');
const r1 = await W.request.post('/v1/auth/login', {
  data: { email: 'owner@demo-a.test', password: 'demo-password-2569', codeChallenge: createHash('sha256').update(v).digest('base64url') },
});
const { code } = await r1.json();
await W.request.post('/v1/oauth/token', { data: { grantType: 'authorization_code', code, codeVerifier: v } });
const rows = ['Code,Name,Tax ID,Start'];
for (let i = 1; i <= 16; i++)
  rows.push(`C${String(i).padStart(3, '0')},บจก. ตัวอย่าง ${i},${i === 7 ? '12345' : `00000000000${String(i).padStart(2, '0')}`},${i === 12 ? '31/02/2569' : '15/11/2569'}`);
const csv = join(tmpdir(), 'นำเข้าลูกค้า_พ.ย.2569.csv');
writeFileSync(csv, rows.join('\n') + '\n');
await W.goto('/dev/import');
await W.waitForTimeout(1200);
await W.getByRole('button', { name: /^นำเข้า.*จาก Excel$/ }).click();
await W.getByTestId('imp-file').setInputFiles(csv);
await W.waitForTimeout(1500);
const c1 = await W.screenshot();
await W.getByRole('button', { name: 'ถัดไป' }).click();
await W.waitForTimeout(500);
const c2 = await W.screenshot();
await W.getByRole('button', { name: /^นำเข้า \d+ แถว$/ }).click();
await W.waitForTimeout(1500);
const c3 = await W.screenshot();
for (const [tag, a, c] of [['upload', a1, c1], ['map', a2, c2], ['result', a3, c3]]) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st1-import-${tag}-1440.png` });
  console.log(`wrote design/compare/st1-import-${tag}-1440.png`);
}
await b.close();
