// ภาพเทียบ "ต้นแบบ | ของจริง" ของปุ่ม "นำเข้า Excel" + wizard บนหน้าข้อมูลหลัก (ST2-T23) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev + seed · ใช้: WEB=http://localhost:4420 node scripts/compare-master-import.mjs
// หน้าที่ต้นแบบมีปุ่มนำเข้า: ลูกค้า สถานที่ รถ คนขับ ผู้รับเหมา rate card · เส้นทาง/สินค้า/ค่าบริการเสริม ต้นแบบไม่มี [OPEN spec/12 §3]
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const samples = fileURLToPath(new URL('../../api/test/fixtures/imports/', import.meta.url));
const proto =
  'file://' + fileURLToPath(new URL('../../../design/prototype/TMS v4.dc.html', import.meta.url));
const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(proto);
await P.waitForTimeout(2500);
async function protoGo(group, item) {
  const side = P.locator('nav, aside').first();
  const it = side.getByText(item, { exact: true }).filter({ visible: true });
  if (!(await it.count())) {
    await side.getByText(group, { exact: true }).filter({ visible: true }).first().click();
    await P.waitForTimeout(400);
  }
  await it.first().click();
  await P.waitForTimeout(1200);
}
async function protoWizard() {
  await P.getByText('นำเข้า Excel', { exact: true }).filter({ visible: true }).first().click();
  await P.waitForTimeout(500);
  await P.getByRole('button', { name: 'เลือกไฟล์' }).click();
  await P.waitForTimeout(300);
  await P.getByRole('button', { name: 'ถัดไป' }).click();
  await P.waitForTimeout(400);
  const shot = await P.screenshot();
  await P.getByRole('button', { name: 'ย้อนกลับ' }).click();
  await P.waitForTimeout(200);
  await P.getByRole('button', { name: 'ยกเลิก' }).click();
  await P.waitForTimeout(300);
  return shot;
}
const proto_ = {};
await protoGo('ข้อมูลหลัก', 'ลูกค้า');
proto_.customers = [await P.screenshot(), await protoWizard()];
await protoGo('ข้อมูลหลัก', 'Rate card');
proto_.rate = [await P.screenshot(), await protoWizard()];
await protoGo('ยานพาหนะ', 'ทะเบียนรถ');
proto_.vehicles = [await P.screenshot(), await protoWizard()];

// ---------- ของจริง ----------
const ctx = await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB });
await ctx.addCookies([
  {
    name: 'tms_td',
    value: 'demo-trusted-device-e2e-only-0000000000000:00000000-0000-4000-8000-0000000e0a01',
    url: `${WEB}/v1/auth`,
  },
]);
const W = await ctx.newPage();
const v = randomBytes(32).toString('base64url');
const r1 = await W.request.post('/v1/auth/login', {
  data: {
    email: 'owner@demo-a.test',
    password: 'demo-password-2569',
    codeChallenge: createHash('sha256').update(v).digest('base64url'),
  },
});
const { code } = await r1.json();
await W.request.post('/v1/oauth/token', {
  data: { grantType: 'authorization_code', code, codeVerifier: v },
});
async function built(path, file, title) {
  await W.goto(path);
  await W.getByRole('button', { name: 'นำเข้า Excel' }).waitFor();
  await W.waitForTimeout(1500);
  const list = await W.screenshot();
  await W.getByRole('button', { name: 'นำเข้า Excel' }).click();
  const dlg = W.getByRole('dialog', { name: title });
  await dlg.getByTestId('imp-file').setInputFiles(file);
  await W.waitForTimeout(2000);
  await dlg.getByRole('button', { name: 'ถัดไป' }).click();
  await W.waitForTimeout(600);
  const map = await W.screenshot();
  await dlg
    .getByRole('button', { name: 'ยกเลิก' })
    .click()
    .catch(() => {});
  return [list, map];
}
const copy = (name) => {
  const p = join(tmpdir(), name);
  writeFileSync(p, readFileSync(samples + name));
  return p;
};
const real = {
  customers: await built('/master/customers', copy('customers.csv'), 'นำเข้าลูกค้าจาก Excel'),
  rate: await built(
    '/master/rate-cards',
    copy('rate-cards-sell.csv'),
    'นำเข้าRate card ขาขายจาก Excel',
  ),
  vehicles: await built('/fleet/vehicles', copy('vehicles.csv'), 'นำเข้ารถจาก Excel'),
};
for (const k of Object.keys(real))
  for (const [i, tag] of ['list', 'map'].entries()) {
    const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
    await M.setContent(
      `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${proto_[k][i].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${real[k][i].toString('base64')}"></div></body>`,
    );
    await M.screenshot({ path: `${out}st2-import-${k}-${tag}-1440.png` });
    console.log(`wrote design/compare/st2-import-${k}-${tag}-1440.png`);
  }
await b.close();
