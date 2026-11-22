import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { confirmStepUp, DEMO_EMAIL, expect, test, withStepUp } from './fixtures';

/**
 * E2E ST7-T04 ตั้งค่า → นักพัฒนา / Open API → Webhooks (ผ่าน API จริง ฐาน e2e)
 * เกณฑ์ตรวจรับ: endpoint ทดสอบตรวจลายเซ็นผ่าน (HMAC-SHA256 ของ `t.rawBody`) · หมุน secret แล้ว 24 ชม. ส่ง 2 ลายเซ็น
 * (retry 8 ครั้ง → EXHAUSTED ทดสอบใน apps/api/test/webhooks.test.ts — ต้องเลื่อนเวลา)
 */
const RUN = String(Date.now()).slice(-6);
const hits: { headers: IncomingHttpHeaders; body: string }[] = [];
let server: Server;
let port = 0;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

/** ลายเซ็นตามที่ผู้รับฝั่งลูกค้าตรวจ (ไม่ใช้โค้ดของแอป) */
function verify(secret: string, header: string, body: string): boolean {
  const parts = header.split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;
  const want = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return parts.some(([k, v]) => k === 'v1' && v === want);
}

/** access token ของผู้ใช้เดโม (login แยก) — ใช้สร้าง endpoint ปลายทางในเครื่องผ่าน API (ฟอร์มรับเฉพาะ https://) */
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

test.describe.serial('นักพัฒนา / Open API → Webhooks', () => {
  test('เพิ่ม endpoint จากฟอร์ม → ตรวจ URL/event → signing secret แสดงครั้งเดียว → แถวในตาราง', async ({
    page,
  }) => {
    await page.goto('/settings/api');
    await page.getByRole('tab', { name: /Webhooks/ }).click();
    await expect(page).toHaveURL(/tab=hooks/);
    await page.getByRole('button', { name: 'เพิ่ม endpoint' }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('เพิ่ม webhook endpoint')).toBeVisible();
    await d.getByRole('button', { name: 'เพิ่ม endpoint' }).click();
    await expect(d.getByText('ต้องเป็น https:// และเป็น URL ที่ถูกต้อง')).toBeVisible();
    await expect(d.getByText('เลือกอย่างน้อย 1 event')).toBeVisible();
    const url = `https://erp-${RUN}.example.com/tms/webhook`;
    await d.getByLabel('Endpoint URL').fill(url);
    await d.getByText('order.created', { exact: true }).click();
    await d.getByText('trip.dispatched', { exact: true }).click();
    await d.getByLabel('Header เพิ่มเติม').fill('X-Client-Id srithai');
    await d.getByRole('button', { name: 'เพิ่ม endpoint' }).click();
    await expect(d.getByText('รูปแบบต้องเป็น Name: value')).toBeVisible();
    await d.getByLabel('Header เพิ่มเติม').fill('X-Client-Id: srithai-erp');
    await d.getByRole('button', { name: 'เพิ่ม endpoint' }).click();
    await confirmStepUp(page); // D-67 ผลมี signing secret

    const sec = page.getByRole('dialog', { name: 'เพิ่ม endpoint แล้ว' });
    await expect(sec.getByText(`${url} · 2 event`)).toBeVisible();
    const secret = await sec.getByLabel('Signing secret').inputValue();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
    await sec.getByRole('button', { name: 'คัดลอกแล้ว · ปิดหน้าต่าง' }).click();
    const row = page.getByRole('row', { name: new RegExp(url.replace(/\./g, '\\.')) });
    await expect(row).toContainText('2 event');
    await expect(row).toContainText('ใช้งาน');
    // ไม่แสดง secret อีก
    await row.click();
    const dr = page.getByRole('dialog');
    await expect(dr.getByText('Webhook endpoint · Production')).toBeVisible();
    await expect(dr.getByText('ตรวจลายเซ็น (Node.js)')).toBeVisible();
    await expect(dr).not.toContainText(secret);
  });

  test('เกณฑ์ตรวจรับ: ส่ง event ทดสอบ → ผู้รับตรวจลายเซ็นผ่าน · หมุน secret → 2 ลายเซ็น (ใหม่ + เดิม) · ปิดใช้งาน', async ({
    page,
  }) => {
    const tok = await token(page);
    const auth = { Authorization: `Bearer ${tok}` };
    // endpoint จากรอบก่อน (รันซ้ำโดยไม่ prepare) — แพ็กเกจมาตรฐานมีได้ 3 endpoint
    const old = (await (
      await page.request.get('/v1/webhooks?limit=50', { headers: auth })
    ).json()) as {
      data: { id: string; url: string; version: number }[];
    };
    for (const x of old.data)
      if (x.url.startsWith('http://127.0.0.1:'))
        await page.request.delete(`/v1/webhooks/${x.id}`, {
          headers: { ...auth, 'If-Match': `"${x.version}"` },
          data: {},
        });
    const r = await page.request.post('/v1/webhooks', {
      headers: await withStepUp(page.request, auth), // D-67
      data: { url: `http://127.0.0.1:${port}/hook-${RUN}`, events: ['order.created'] },
    });
    expect(r.status(), await r.text()).toBe(201);
    const created = (await r.json()) as { secret: string; url: string };
    hits.length = 0;

    await page.goto('/settings/api?tab=hooks');
    const row = page.getByRole('row', { name: new RegExp(`hook-${RUN}`) });
    await row.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: 'ส่ง event ทดสอบ' }).click();
    await expect(page.getByRole('status')).toContainText(
      'ส่ง event ทดสอบแล้ว · endpoint ตอบ 200 ใน',
    );
    const test1 = hits.find((h) => h.headers['x-tms-event'] === 'webhook.test')!;
    expect(test1).toBeTruthy();
    expect(JSON.parse(test1.body)).toMatchObject({ type: 'webhook.test', test: true });
    expect(verify(created.secret, String(test1.headers['x-tms-signature']), test1.body)).toBe(true);
    expect(verify('whsec_wrong', String(test1.headers['x-tms-signature']), test1.body)).toBe(false);

    await row.click();
    const dr = page.getByRole('dialog');
    await dr.getByRole('button', { name: 'หมุน signing secret' }).click();
    await confirmStepUp(page); // D-67
    const sec = page.getByRole('dialog', { name: 'Signing secret ใหม่' });
    await expect(sec.getByText('secret เดิมยังใช้ตรวจได้อีก 24 ชั่วโมง')).toBeVisible();
    const fresh = await sec.getByLabel('Signing secret').inputValue();
    expect(fresh).not.toBe(created.secret);
    await sec.getByRole('button', { name: 'คัดลอกแล้ว · ปิดหน้าต่าง' }).click();

    hits.length = 0;
    // ส่งทดสอบได้ 1 ครั้ง / 5 วิ ต่อ endpoint (429 rate_limited)
    await page.waitForTimeout(5200);
    // drawer ยังเปิดอยู่หลังปิดหน้าต่าง secret
    await page.getByRole('dialog').getByRole('button', { name: 'ส่ง event ทดสอบ' }).click();
    await expect(page.getByRole('status')).toContainText('endpoint ตอบ 200');
    const h2 = hits.find((h) => h.headers['x-tms-event'] === 'webhook.test')!;
    const sig = String(h2.headers['x-tms-signature']);
    expect(sig.match(/v1=/g)).toHaveLength(2);
    expect(verify(fresh, sig, h2.body)).toBe(true);
    expect(verify(created.secret, sig, h2.body)).toBe(true);

    await page.getByRole('dialog').getByRole('button', { name: 'ปิดใช้งาน' }).click();
    // ปิด = ต้องมีเหตุผล ≥ 10 ตัว
    const off = page.getByRole('dialog', { name: /ปิดใช้งาน endpoint/ });
    await off.getByRole('textbox').fill('ปิดชั่วคราวระหว่างย้ายระบบ ERP');
    await off.getByRole('button', { name: 'ปิดใช้งาน' }).click();
    await expect(page.getByRole('status')).toContainText('ปิดใช้งาน endpoint แล้ว');
    await page.keyboard.press('Escape');
    await expect(row).toContainText('ปิด');
    await row.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: 'ส่ง event ทดสอบ' }).click();
    await expect(page.getByRole('status')).toContainText('เปิดใช้งาน endpoint ก่อนส่ง event ทดสอบ');
  });
});
