import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { DEMO_EMAIL, expect, test } from './fixtures';

/**
 * E2E ST7-T05 Webhook ops (ผ่าน API จริง ฐาน e2e) — ปลายทางในเครื่องตอบ 500 ก่อน แล้วแก้ให้ตอบ 200
 * เกณฑ์ตรวจรับ: ดู delivery ที่ล้มเหลวแล้วกด "ส่งซ้ำ" สำเร็จจาก UI (และ API ใน apps/api/test/webhook-ops.test.ts)
 * event จริง = แถว domain_event ของบริษัทเดโม (เขียนตรงฐาน e2e) → ส่งด้วย `POST /v1/events/{id}/redeliver` (ผ่าน outbox)
 */
const env = Object.fromEntries(
  readFileSync(new URL('./.env.e2e', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], m[2]]),
);
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });

const RUN = String(Date.now()).slice(-6);
const hits: { headers: IncomingHttpHeaders; body: string }[] = [];
let status = 500;
let server: Server;
let port = 0;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res
        .writeHead(status, { 'content-type': 'application/json' })
        .end(status < 300 ? '{"received":true}' : '{"error":"maintenance"}');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await db.$disconnect();
});

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

test('เกณฑ์ตรวจรับ: delivery ที่ล้มเหลว → ดูข้อมูล (payload/response) → แก้ปลายทาง → ส่งซ้ำสำเร็จจาก drawer', async ({
  page,
}) => {
  const tok = await token(page);
  const auth = { Authorization: `Bearer ${tok}` };
  // endpoint ในเครื่องจากรอบก่อน/spec อื่น — แพ็กเกจมาตรฐานมีได้ 3 endpoint
  const old = (await (
    await page.request.get('/v1/webhooks?limit=50', { headers: auth })
  ).json()) as {
    data: { id: string; url: string; version: number }[];
  };
  for (const x of old.data)
    if (x.url.startsWith('http://127.0.0.1:'))
      await page.request.delete(`/v1/webhooks/${x.id}`, {
        headers: { ...auth, 'If-Match': `"${x.version}"` },
        data: { reason: 'ลบ endpoint ทดสอบจากรอบก่อน' },
      });
  const r = await page.request.post('/v1/webhooks', {
    headers: auth,
    data: {
      url: `http://127.0.0.1:${port}/ops-${RUN}`,
      events: ['order.created'],
      extraHeaders: [{ name: 'X-Client-Token', value: `tok-${RUN}-secret` }],
    },
  });
  expect(r.status(), await r.text()).toBe(201);
  const hook = (await r.json()) as { id: string };

  // event จริงของบริษัทเดโม (ระบบภายนอกจะได้ envelope id = evt_ ของแถวนี้)
  const user = await db.appUser.findFirst({ where: { email: DEMO_EMAIL } });
  const ev = await db.domainEvent.create({
    data: {
      tenantId: user.tenantId,
      type: 'order.created',
      entityType: 'order',
      localId: randomUUID(),
      snapshot: { id: `ord_${RUN}`, status: 'created', customerRef: `PO-${RUN}` },
    },
  });
  const evtId = `evt_${ev.id.replace(/-/g, '')}`;

  // ส่งครั้งแรก (ผ่าน outbox) — ปลายทางตอบ 500 → delivery ล้มเหลว
  status = 500;
  const first = await page.request.post(`/v1/events/${evtId}/redeliver?endpointId=${hook.id}`, {
    headers: auth,
  });
  expect(first.status(), await first.text()).toBe(200);
  expect((await first.json()).data[0]).toMatchObject({ state: 'failed', status: 500, attempt: 1 });
  const list = await page.request.get(`/v1/webhook-deliveries?eventId=${evtId}`, { headers: auth });
  expect((await list.json()).data).toEqual([
    expect.objectContaining({ eventId: evtId, status: 'exhausted', responseStatus: 500 }),
  ]);

  await page.goto('/settings/api?tab=hooks');
  await page.getByRole('row', { name: new RegExp(`ops-${RUN}`) }).click();
  const dr = page.getByRole('dialog');
  await expect(dr.getByText('ประวัติการส่ง', { exact: true })).toBeVisible();
  const row = dr.getByTestId('whk-delivery').filter({ hasText: 'order.created' });
  await expect(row).toContainText('500');
  await expect(row).toContainText('ลอง 1 ครั้ง');

  // ดูข้อมูล: payload ที่ส่ง (id เดิม) + response · ค่า header เพิ่มเติมไม่แสดง
  await row.getByRole('button', { name: 'ดูข้อมูล' }).click();
  const pl = page.getByRole('dialog', { name: 'Event order.created' });
  await expect(pl).toContainText(`POST http://127.0.0.1:${port}/ops-${RUN}`);
  await expect(pl).toContainText(`"id": "${evtId}"`);
  await expect(pl).toContainText('X-Client-Token: ***');
  await expect(pl).toContainText('— response —');
  await expect(pl).toContainText('HTTP/1.1 500 Internal Server Error');
  await expect(pl).toContainText(/whd_[0-9a-f]{32}/);
  await expect(pl).not.toContainText(`tok-${RUN}-secret`);
  await pl.getByRole('button', { name: 'ปิด', exact: true }).last().click();
  await expect(pl).toBeHidden();

  // แก้ปลายทาง → ส่งซ้ำจาก UI (event เดิมที่ endpoint เดิมส่งซ้ำได้ 1 ครั้ง / 2 วิ)
  await page.waitForTimeout(2100);
  status = 200;
  hits.length = 0;
  await row.getByRole('button', { name: 'ส่งซ้ำ' }).click();
  await expect(page.getByRole('status')).toContainText('ส่งซ้ำสำเร็จ · 200 OK');
  await expect(row).toContainText('200');
  await expect(row).toContainText('ลอง 2 ครั้ง');
  await expect(row.getByRole('button', { name: 'ส่งซ้ำ' })).toHaveCount(0);
  expect(hits).toHaveLength(1);
  expect(hits[0]!.headers['x-tms-event-id']).toBe(evtId);
  expect(hits[0]!.headers['x-tms-attempt']).toBe('2');
  expect(hits[0]!.headers['x-client-token']).toBe(`tok-${RUN}-secret`);

  // กิจกรรมของ endpoint บันทึกการส่งซ้ำ
  await dr.getByRole('tab', { name: 'กิจกรรม' }).click();
  await expect(dr.getByText('ส่งซ้ำ order.created')).toBeVisible();
});
