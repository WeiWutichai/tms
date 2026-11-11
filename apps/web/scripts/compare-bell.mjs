// ภาพเทียบ "ต้นแบบ | ของจริง" ของกระดิ่งแจ้งเตือน (ST1-T23) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) + seed · ใส่แจ้งเตือนตัวอย่าง 2 รายการให้ owner ในฐาน dev
// ใช้: node scripts/compare-bell.mjs
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const env = Object.fromEntries(
  readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^"|"$/g, '')]),
);
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });
const owner = await db.appUser.findFirstOrThrow({ where: { email: 'owner@demo-a.test' } });
for (const body of ['นำเข้ารถ เสร็จเรียบร้อย', 'นำเข้าลูกค้า เสร็จเรียบร้อย'])
  await db.notification.create({
    data: {
      tenantId: owner.tenantId,
      recipientId: owner.id,
      channel: 'in_app',
      templateCode: 'job.succeeded',
      locale: 'th',
      title: 'งานเสร็จแล้ว',
      body,
      status: 'SENT',
      sentAt: new Date(),
    },
  });
await db.$disconnect();

const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const proto =
  'file://' + fileURLToPath(new URL('../../../design/prototype/TMS v4.dc.html', import.meta.url));
const vp = { width: 1440, height: 900 };
const b = await chromium.launch();
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(proto);
await P.waitForTimeout(2500);
const a0 = await P.screenshot();
await P.locator('button:has(lu-i[n="bell"])').filter({ visible: true }).first().click();
await P.waitForTimeout(500);
const a1 = await P.screenshot();

const ctx = await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: 'http://localhost:4420' });
await ctx.addCookies([
  {
    name: 'tms_td',
    value: 'demo-trusted-device-e2e-only-0000000000000:00000000-0000-4000-8000-0000000e0a01',
    url: 'http://localhost:4420/v1/auth',
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
await W.goto('/');
await W.waitForTimeout(1500);
const c0 = await W.screenshot();
await W.getByRole('banner')
  .getByRole('button', { name: /การแจ้งเตือน/ })
  .click();
await W.waitForTimeout(800);
const c1 = await W.screenshot();
for (const [tag, a, c] of [
  ['dot', a0, c0],
  ['toast', a1, c1],
]) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st1-bell-${tag}-1440.png` });
  console.log(`wrote design/compare/st1-bell-${tag}-1440.png`);
}
await b.close();
