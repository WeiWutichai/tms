// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า public (TMS Signup) ที่ 1440 และ 390 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) · ใช้: node scripts/compare-public.mjs forgot
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PAGES = {
  // [hash ต้นแบบ, path ของจริง, ขั้นหลังกรอก (ส่งลิงก์)]
  forgot: ['#forgot', '/forgot', { email: 'owner@demo-a.test', button: 'ส่งลิงก์' }],
};
const names = process.argv.slice(2).filter((s) => PAGES[s]);
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const proto = 'file://' + fileURLToPath(new URL('../../../design/prototype/TMS Signup.dc.html', import.meta.url));
const b = await chromium.launch();

async function shot(url, vp, step) {
  const p = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
  await p.goto(url);
  await p.waitForTimeout(2000);
  const first = await p.screenshot({ fullPage: true });
  let second;
  if (step) {
    await p.getByRole('textbox').filter({ visible: true }).first().fill(step.email);
    await p.getByRole('button', { name: step.button }).filter({ visible: true }).first().click();
    await p.waitForTimeout(1000);
    second = await p.screenshot({ fullPage: true });
  }
  return [first, second];
}

for (const n of names) {
  const [hash, path, step] = PAGES[n];
  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const a = await shot(proto + hash, vp, step);
    const c = await shot('http://localhost:4420' + path, vp, step);
    for (const [i, tag] of [[0, ''], [1, '-sent']]) {
      if (!a[i] || !c[i]) continue;
      const M = await (await b.newContext({ viewport: { width: vp.width * 2 + 60, height: 400 } })).newPage();
      await M.setContent(
        `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS Signup)</div><img src="data:image/png;base64,${a[i].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[i].toString('base64')}"></div></body>`,
      );
      await M.screenshot({ path: `${out}${n}${tag}-${vp.width}.png`, fullPage: true });
    }
  }
}
await b.close();
