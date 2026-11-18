import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { DEMO_EMAIL, expect, test } from './fixtures';

/**
 * E2E ST7-T22 Inbound webhook ledger (ผ่าน API จริง ฐาน e2e — ไม่มีหน้าจอในงานนี้; หน้า connector = ST7-T20)
 * เกณฑ์ตรวจรับ: ส่ง inbound event เดิม 2 ครั้ง → ประมวลผลครั้งเดียว (ครั้งที่สอง `duplicate: true`) · signature ผิด → 401
 * (การประมวลผลใน worker ครั้งเดียว/พร้อมกัน/หมุน token ทดสอบใน apps/api/test/inbound-webhook.test.ts)
 */
const RUN = String(Date.now()).slice(-6);
const SECRET = `demo-inbound-${RUN}`;

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

/** ลายเซ็นแบบที่ Demo ERP ส่ง (ไม่ใช้โค้ดของแอป): `t=<unix>,v1=HMAC-SHA256(secret, "t.body")` */
const sign = (secret: string, body: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};

test('webhook ขาเข้า: ส่ง event เดิม 2 ครั้ง → รับครั้งเดียว (duplicate) · ลายเซ็นผิด/token ผิด → 401', async ({
  page,
}) => {
  const auth = { Authorization: `Bearer ${await token(page)}` };
  const c = await page.request.post('/v1/connectors', {
    headers: auth,
    data: { adapterKey: 'demo', credentials: { apiKey: `demo-${RUN}`, inboundSecret: SECRET } },
  });
  expect(c.status(), await c.text()).toBe(201);
  const conId = ((await c.json()) as { id: string }).id;
  try {
    const rot = await page.request.post(`/v1/connectors/${conId}/inbound-token/rotate`, {
      headers: auth,
      data: {},
    });
    expect(rot.status(), await rot.text()).toBe(200);
    const { url, token: inboundToken } = (await rot.json()) as { url: string; token: string };
    const path = new URL(url).pathname;
    expect(path).toBe(`/v1/inbound/demo/${inboundToken}`);

    const body = JSON.stringify({ id: `evt-${RUN}`, type: 'invoice.paid' });
    const send = (sig: string, p = path) =>
      page.request.post(p, {
        headers: { 'Content-Type': 'application/json', 'X-Demo-Signature': sig },
        data: body,
      });
    const first = await send(sign(SECRET, body));
    expect(first.status(), await first.text()).toBe(200);
    const a = (await first.json()) as { duplicate: boolean; id: string };
    expect(a.duplicate).toBe(false);
    const second = await send(sign(SECRET, body));
    expect(second.status()).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true, id: a.id });

    const bad = await send(sign('wrong-secret', body));
    expect(bad.status()).toBe(401);
    const unknown = await send(sign(SECRET, body), `/v1/inbound/demo/whin_${'Z'.repeat(43)}`);
    expect(unknown.status()).toBe(401);
    expect(((await unknown.json()) as { code: string }).code).toBe(
      ((await bad.json()) as { code: string }).code,
    );
  } finally {
    await page.request.post(`/v1/connectors/${conId}/disconnect`, {
      headers: auth,
      data: { reason: 'ล้างข้อมูลหลังทดสอบ E2E' },
    });
  }
});
