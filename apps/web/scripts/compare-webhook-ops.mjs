// ภาพเทียบ "ต้นแบบ | ของจริง" ของประวัติการส่ง webhook ใน drawer (ST7-T05) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev (WEBHOOK_ALLOW_PRIVATE_TARGETS=1 — ปลายทางในเครื่อง) + seed · ต้องตั้ง PLATFORM_DATABASE_URL
// (โหลด .env ของ worktree ก่อน) · ใช้: WEB=http://localhost:4635 node scripts/compare-webhook-ops.mjs
// สคริปต์สร้าง endpoint ในเครื่อง + event ตัวอย่างใน demo-a แล้วส่งผ่าน `POST /v1/events/{id}/redeliver` (ลบ endpoint ตอนจบ)
import { chromium } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? `http://localhost:${process.env.WEB_PORT ?? 4420}`;
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const protoDir = fileURLToPath(new URL('../../../design/prototype/', import.meta.url));
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = createServer((req, res) => {
  const p = join(protoDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(protoDir) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
}).listen(0);
const port = srv.address().port;

// ปลายทาง webhook ในเครื่อง (ตอบตาม `status`)
let status = 200;
const rx = createServer((req, res) => {
  req.resume();
  req.on('end', () =>
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(status < 300 ? '{"received":true}' : '{"error":"maintenance"}'),
  );
}).listen(0, '127.0.0.1');
await new Promise((ok) => rx.once('listening', ok));
const rxPort = rx.address().port;

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('ตั้งค่า', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
await P.getByText('นักพัฒนา / Open API', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
await P.getByRole('button', { name: /^Webhooks/ })
  .first()
  .click();
await P.waitForTimeout(900);
await P.locator('tbody tr').filter({ hasText: 'ล้มเหลวต่อเนื่อง' }).first().click();
await P.waitForTimeout(900);
await P.getByText('ประวัติการส่ง', { exact: true })
  .filter({ visible: true })
  .first()
  .scrollIntoViewIfNeeded();
await P.waitForTimeout(300);
const a = { drawer: await P.screenshot() };
await P.getByText('ดูข้อมูล', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(600);
a.payload = await P.screenshot();
await P.getByText('ปิด', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(400);
await P.getByText('ส่งซ้ำ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(500);
a.resend = await P.screenshot();

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
const tok = await (
  await W.request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  })
).json();
const auth = { Authorization: `Bearer ${tok.accessToken}` };
const clean = async () => {
  for (const x of (await (await W.request.get('/v1/webhooks?limit=200', { headers: auth })).json())
    .data)
    if (x.url.startsWith('http://127.0.0.1:'))
      await W.request.delete(`/v1/webhooks/${x.id}`, {
        headers: { ...auth, 'If-Match': `"${x.version}"` },
        data: { reason: 'ลบ endpoint ตัวอย่างหลังถ่ายภาพเทียบ' },
      });
};
await clean();
const hook = await (
  await W.request.post('/v1/webhooks', {
    headers: auth,
    data: {
      url: `http://127.0.0.1:${rxPort}/erp/webhook`,
      events: ['order.created', 'trip.dispatched'],
      extraHeaders: [{ name: 'X-Client-Id', value: 'srithai-erp' }],
    },
  })
).json();
const db = new PrismaClient({ datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } } });
const user = await db.appUser.findFirst({ where: { email: 'owner@demo-a.test' } });
const emit = async (type, snapshot) => {
  const e = await db.domainEvent.create({
    data: {
      tenantId: user.tenantId,
      type,
      entityType: type.split('.')[0],
      localId: randomUUID(),
      snapshot,
    },
  });
  return `evt_${e.id.replace(/-/g, '')}`;
};
const send = (evt) =>
  W.request.post(`/v1/events/${evt}/redeliver?endpointId=${hook.id}`, { headers: auth });
status = 200;
await send(await emit('trip.dispatched', { id: 'trp_demo', status: 'dispatched' }));
await send(await emit('order.created', { id: 'ord_demo1', status: 'created' }));
status = 503;
await send(await emit('order.created', { id: 'ord_demo2', status: 'created' }));
await db.$disconnect();

await W.goto('/settings/api?tab=hooks');
await W.waitForTimeout(1500);
await W.locator('tbody tr')
  .filter({ hasText: `127.0.0.1:${rxPort}` })
  .first()
  .click();
await W.waitForTimeout(900);
await W.getByText('ประวัติการส่ง', { exact: true }).scrollIntoViewIfNeeded();
await W.waitForTimeout(300);
const c = { drawer: await W.screenshot() };
await W.getByTestId('whk-delivery').first().getByRole('button', { name: 'ดูข้อมูล' }).click();
await W.waitForTimeout(600);
c.payload = await W.screenshot();
await W.getByRole('dialog', { name: /^Event / })
  .getByRole('button', { name: 'ปิด', exact: true })
  .last()
  .click();
await W.waitForTimeout(2200);
status = 200;
await W.getByRole('button', { name: 'ส่งซ้ำ' }).first().click();
await W.getByRole('status').waitFor();
await W.waitForTimeout(300);
c.resend = await W.screenshot();
await clean();

for (const tag of Object.keys(c)) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st7-webhook-ops-${tag}-1440.png` });
  console.log(`wrote design/compare/st7-webhook-ops-${tag}-1440.png`);
}
await b.close();
srv.close();
rx.close();
