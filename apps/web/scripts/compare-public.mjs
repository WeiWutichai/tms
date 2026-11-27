// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า public (TMS Signup) ที่ 1440 และ 390 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) · ใช้: node scripts/compare-public.mjs forgot landing signup
// landing (P1-ST2-T01): ไม่ต้องมี API · ซ่อนแถบ DEMO ของต้นแบบ · เลื่อนลงสุดก่อนถ่าย (รูป loading=lazy)
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PAGES = {
  // [hash ต้นแบบ, path ของจริง, ขั้นหลังกรอก (ส่งลิงก์)]
  forgot: ['#forgot', '/forgot', { email: 'owner@demo-a.test', button: 'ส่งลิงก์' }],
  landing: ['#home', '/home'],
  // P1-ST2-T03: ขั้น 1 ฟอร์ม → (กรอก + ขอ OTP) กล่องกรอกรหัส · ต้นแบบซ่อนปุ่ม Google (R-08) ให้เทียบส่วนที่เหลือ
  signup: ['#signup', '/signup', { signup: true }],
};
/** กรอกฟอร์มสมัครขั้น 1 ทั้งสองฝั่ง (ต้นแบบ: เบอร์ 9 หลัก + รหัสผ่านมีตัวเลข · ของจริง: อีเมลใหม่ทุกครั้ง) */
async function fillSignup(p, real) {
  const email = real ? `compare-${Date.now()}@company.co.th` : 'porntip@chaiyapruek.co.th';
  const box = (ph) => p.locator(`input[placeholder="${ph}"]`).filter({ visible: true }).first();
  await box('สมชาย ใจดี').fill('พรทิพย์ ศรีวงศ์');
  await box('name@company.co.th').fill(email);
  await box('81 234 5678').fill('81 234 5678');
  await p
    .locator('input[type="password"]')
    .filter({ visible: true })
    .first()
    .fill('compare-password-2569');
  await p.getByRole('button', { name: 'ขอรหัส OTP' }).filter({ visible: true }).first().click();
  await p.waitForTimeout(1200);
}
const names = process.argv.slice(2).filter((s) => PAGES[s]);
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const proto =
  'file://' +
  fileURLToPath(new URL('../../../design/prototype/TMS Signup.dc.html', import.meta.url));
const pnpmDir = fileURLToPath(new URL('../../../node_modules/.pnpm/', import.meta.url));
const LOCAL_UMD = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': `${pnpmDir}react@18.3.1/node_modules/react/umd/react.production.min.js`,
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': `${pnpmDir}react-dom@18.3.1_react@18.3.1/node_modules/react-dom/umd/react-dom.production.min.js`,
};
const b = await chromium.launch();

async function shot(url, vp, step) {
  const ctx = await b.newContext({ viewport: vp, locale: 'th-TH' });
  // OFFLINE=1: ไม่เรียกออกภายนอก (Google Fonts / unpkg ของต้นแบบ) — ทั้งสองฝั่งใช้ฟอนต์สำรองเหมือนกัน ไอคอนต้นแบบไม่ขึ้น
  //   React UMD ของต้นแบบ (unpkg) เสิร์ฟจาก node_modules ในเครื่อง (react@18.3.1 รุ่นเดียวกัน)
  if (process.env.OFFLINE === '1')
    await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => {
      const local = LOCAL_UMD[r.request().url()];
      return local ? r.fulfill({ path: local, contentType: 'text/javascript' }) : r.abort();
    });
  const p = await ctx.newPage();
  await p.goto(url);
  await p.waitForTimeout(2000);
  await p.addStyleTag({ content: '[data-demo]{display:none!important}' });
  if (step?.signup) {
    const real = !url.includes('.dc.html');
    if (!real) {
      // R-08: ต้นแบบมีปุ่ม "สมัครด้วย Google" + "หรือกรอกข้อมูล" — ของจริงไม่มี → ซ่อนในภาพต้นแบบเพื่อเทียบส่วนอื่น
      await p.evaluate(() => {
        for (const b of document.querySelectorAll('button'))
          if (b.textContent?.includes('สมัครด้วย Google')) {
            b.style.display = 'none';
            if (b.nextElementSibling instanceof HTMLElement)
              b.nextElementSibling.style.display = 'none';
          }
      });
    }
    const first = await p.screenshot({ fullPage: true });
    await fillSignup(p, real);
    return [first, await p.screenshot({ fullPage: true })];
  }
  // รูป lazy: เลื่อนลงทีละจอจนสุด แล้วกลับบนสุด (header ของ landing เปลี่ยนสีตามการเลื่อน)
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += vp.height) {
    await p.evaluate((yy) => window.scrollTo(0, yy), y);
    await p.waitForTimeout(150);
  }
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(800);
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
  for (const vp of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const a = await shot(proto + hash, vp, step);
    const c = await shot(
      (process.env.WEB ?? `http://localhost:${process.env.WEB_PORT ?? 4420}`) + path,
      vp,
      step,
    );
    for (const [i, tag] of [
      [0, ''],
      [1, step?.signup ? '-otp' : '-sent'],
    ]) {
      if (!a[i] || !c[i]) continue;
      const M = await (
        await b.newContext({ viewport: { width: vp.width * 2 + 60, height: 400 } })
      ).newPage();
      await M.setContent(
        `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS Signup)</div><img src="data:image/png;base64,${a[i].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[i].toString('base64')}"></div></body>`,
      );
      await M.screenshot({ path: `${out}${n}${tag}-${vp.width}.png`, fullPage: true });
    }
  }
}
await b.close();
