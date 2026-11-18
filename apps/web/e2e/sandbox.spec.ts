import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { DEMO_EMAIL, expect, test } from './fixtures';

/**
 * E2E ST7-T09 Sandbox — ตั้งค่า → นักพัฒนา / Open API สลับ Production / Sandbox (ผ่าน API จริง ฐาน e2e)
 * เกณฑ์ตรวจรับ: key test มองไม่เห็นข้อมูล live · trigger event จำลองแล้ว webhook ถูกส่ง
 */
const RUN = String(Date.now()).slice(-6);
const NAME = `Sandbox อีทูอี ${RUN}`;
const hits: { headers: IncomingHttpHeaders; body: string; path: string }[] = [];
let server: Server;
let port = 0;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        path: req.url ?? '',
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

function verify(secret: string, header: string, body: string): boolean {
  const parts = header.split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;
  const want = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return parts.some(([k, v]) => k === 'v1' && v === want);
}

async function token(page: Page): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await page.request.post('/v1/auth/login', {
    data: {
      email: DEMO_EMAIL,
      password: 'demo-password-2569',
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
  });
  const { code } = (await r1.json()) as { code: string };
  const r2 = await page.request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  });
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

test.describe.serial('นักพัฒนา / Open API → Sandbox', () => {
  let secret = '';

  test('สลับเป็น Sandbox → แถบ SANDBOX → สร้าง key test จากฟอร์ม → Production ไม่เห็น key นี้', async ({
    page,
  }) => {
    await page.goto('/settings/api');
    await expect(
      page.getByRole('heading', { name: 'นักพัฒนา / Open API', level: 1 }),
    ).toBeVisible();
    const modes = page.getByRole('group', { name: 'โหมด' });
    await expect(modes.getByRole('button', { name: 'Production' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const listRes = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/v1/api-keys' && r.request().method() === 'GET',
    );
    await modes.getByRole('button', { name: 'Sandbox' }).click();
    expect((await listRes).request().headers()['x-tms-mode']).toBe('test');
    await expect(page.getByRole('status').filter({ hasText: 'สลับเป็น Sandbox' })).toBeVisible();
    await expect(
      page.getByText('โหมดทดสอบ · key, webhook และ log แยกจาก Production และไม่กระทบงานจริง'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'สร้าง API key' }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByLabel('โหมด')).toHaveValue('test');
    await d.getByLabel('ชื่อ key').fill(NAME);
    await d.getByText('orders:read', { exact: true }).click();
    await d.getByText('settings:read', { exact: true }).click();
    await d.getByRole('button', { name: 'สร้าง key' }).click();
    const sec = page.getByRole('dialog', { name: 'สร้าง API key แล้ว' });
    await expect(sec.getByText(new RegExp(`${NAME} · Sandbox ·`))).toBeVisible();
    secret = await sec.getByLabel('Secret key').inputValue();
    expect(secret).toMatch(/^tk_test_[0-9a-f]{48}$/);
    await sec.getByRole('button', { name: 'คัดลอกแล้ว · ปิดหน้าต่าง' }).click();
    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await expect(row).toContainText('Sandbox');

    await modes.getByRole('button', { name: 'Production' }).click();
    await expect(page.getByText('โหมดทดสอบ · key, webhook')).toHaveCount(0);
    await expect(page.getByRole('row', { name: new RegExp(NAME) })).toHaveCount(0);
  });

  test('เกณฑ์ตรวจรับ: key test มองไม่เห็นข้อมูล live', async ({ page }) => {
    const tok = await token(page);
    const live = await page.request.get('/v1/orders?limit=5', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(live.status()).toBe(200);
    const liveOrders = ((await live.json()) as { data: { id: string }[] }).data;
    expect(liveOrders.length).toBeGreaterThan(0); // ฐาน e2e มีใบสั่งเดโม
    const auth = { Authorization: `Bearer ${secret}` };
    const sb = await page.request.get('/v1/orders?limit=5', { headers: auth });
    expect(sb.status()).toBe(200);
    expect(((await sb.json()) as { data: unknown[] }).data).toEqual([]);
    const one = await page.request.get(`/v1/orders/${liveOrders[0]!.id}`, { headers: auth });
    expect(one.status()).toBe(404);
  });

  test('เกณฑ์ตรวจรับ: trigger event จำลอง → webhook ของ sandbox ถูกส่งจริง (mode test, ลายเซ็นถูก) → เห็นในแท็บ Webhooks ของ Sandbox', async ({
    page,
  }) => {
    const tok = await token(page);
    const auth = { Authorization: `Bearer ${tok}`, 'X-Tms-Mode': 'test' };
    const old = (await (
      await page.request.get('/v1/webhooks?limit=50', { headers: auth })
    ).json()) as { data: { id: string; url: string; version: number }[] };
    for (const x of old.data)
      if (x.url.startsWith('http://127.0.0.1:'))
        await page.request.delete(`/v1/webhooks/${x.id}`, {
          headers: { ...auth, 'If-Match': `"${x.version}"` },
          data: { reason: 'ล้าง endpoint ของรอบก่อน' },
        });
    const r = await page.request.post('/v1/webhooks', {
      headers: auth,
      data: { url: `http://127.0.0.1:${port}/sbx-${RUN}`, events: ['order.created'] },
    });
    expect(r.status(), await r.text()).toBe(201);
    const hook = (await r.json()) as { id: string; secret: string };
    hits.length = 0;

    const t = await page.request.post('/v1/test/events/trigger', {
      headers: { Authorization: `Bearer ${secret}` },
      data: { type: 'order.created' },
    });
    expect(t.status(), await t.text()).toBe(200);
    const body = (await t.json()) as {
      eventId: string;
      mode: string;
      deliveries: { endpointId: string; state: string }[];
    };
    expect(body.mode).toBe('test');
    expect(body.deliveries).toEqual([
      expect.objectContaining({ endpointId: hook.id, state: 'delivered' }),
    ]);
    const hit = hits.find((h) => h.headers['x-tms-event-id'] === body.eventId)!;
    expect(hit).toBeTruthy();
    expect(hit.path).toBe(`/sbx-${RUN}`);
    expect(JSON.parse(hit.body)).toMatchObject({ type: 'order.created', mode: 'test' });
    expect(verify(hook.secret, String(hit.headers['x-tms-signature']), hit.body)).toBe(true);

    // live: ไม่มี sandbox → 403
    const liveTrig = await page.request.post('/v1/test/events/trigger', {
      headers: { Authorization: `Bearer ${tok}` },
      data: { type: 'order.created' },
    });
    expect(liveTrig.status()).toBe(403);

    await page.goto('/settings/api?tab=hooks');
    await page
      .getByRole('group', { name: 'โหมด' })
      .getByRole('button', { name: 'Sandbox' })
      .click();
    const row = page.getByRole('row', { name: new RegExp(`sbx-${RUN}`) });
    await expect(row).toBeVisible();
    await row.click();
    await expect(
      page
        .getByRole('dialog')
        .getByText(/Sandbox/)
        .first(),
    ).toBeVisible();
  });
});
