// ภาพเทียบ "ต้นแบบ | ของจริง" ของแถบสถานะบัญชี (P1-ST1-T05) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (WEB_PORT) + API dev (API_PORT) + seed · สคริปต์ตั้งสถานะ tenant demo-a ในฐาน dev ทีละแบบ แล้วคืนค่าเดิม
// ใช้: WEB_PORT=6383 node scripts/compare-status-banner.mjs
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
const tid = owner.tenantId;
const before = await db.tenant.findUniqueOrThrow({ where: { id: tid } });
const sub0 = await db.subscription.findUnique({ where: { tenantId: tid } });
const day = (n) => new Date(Date.now() + n * 86400e3);

/** [ชื่อ, ค่าตัวเลือก DEMO ของต้นแบบ, ตั้งค่าฐาน] */
const CASES = [
  [
    'trial',
    'ทดลองใช้',
    async () => {
      await db.tenant.update({ where: { id: tid }, data: { status: 'TRIALING' } });
      await db.subscription.update({ where: { tenantId: tid }, data: { trialEndsAt: day(12.5) } });
    },
  ],
  [
    'past-due',
    'ค้างชำระ',
    () =>
      db.tenant.update({
        where: { id: tid },
        data: { status: 'PAST_DUE', pastDueSince: day(-3), dunningKind: 'invoice' },
      }),
  ],
  [
    'read-only',
    'อ่านอย่างเดียว',
    () => db.tenant.update({ where: { id: tid }, data: { status: 'READ_ONLY' } }),
  ],
];

const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const proto =
  'file://' + fileURLToPath(new URL('../../../design/prototype/TMS v4.dc.html', import.meta.url));
const vp = { width: 1440, height: 900 };
const base = process.env.WEB ?? `http://localhost:${process.env.WEB_PORT ?? 4420}`;
const b = await chromium.launch();
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(proto);
await P.waitForTimeout(2500);

const ctx = await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: base });
await ctx.addCookies([
  {
    name: 'tms_td',
    value: 'demo-trusted-device-e2e-only-0000000000000:00000000-0000-4000-8000-0000000e0a01',
    url: `${base}/v1/auth`,
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

try {
  for (const [tag, demo, set] of CASES) {
    await P.locator('select')
      .filter({ has: P.locator(`option[value="${demo}"]`) })
      .first()
      .selectOption(demo);
    await P.waitForTimeout(600);
    const a = await P.screenshot();
    await set();
    await W.goto('/');
    await W.waitForTimeout(1800);
    const c = await W.screenshot();
    const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
    await M.setContent(
      `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c.toString('base64')}"></div></body>`,
    );
    await M.screenshot({ path: `${out}p1-st1-t05-banner-${tag}-1440.png` });
    console.log(`wrote design/compare/p1-st1-t05-banner-${tag}-1440.png`);
  }
} finally {
  await db.tenant.update({
    where: { id: tid },
    data: {
      status: before.status,
      pastDueSince: before.pastDueSince,
      dunningKind: before.dunningKind,
    },
  });
  if (sub0)
    await db.subscription.update({
      where: { tenantId: tid },
      data: { trialEndsAt: sub0.trialEndsAt },
    });
  await db.$disconnect();
  await b.close();
}
