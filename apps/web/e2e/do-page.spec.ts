import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import {
  DEMO_IDS,
  DEMO_PASSWORD,
  DEMO_TRUSTED_DEVICE,
  E2E_WEB,
  expect,
  test as base,
} from './fixtures';

/**
 * E2E หน้าใบส่งของ `/do` (UAT 24 พ.ย. 2569 — ต้นแบบ TMS v4 specDo + kpisX do + vPanel do)
 * - การ์ด "ร่าง" / "ระหว่างส่ง" = จำนวนแถวเมื่อคลิก · แท็บ → สถานะ · ค้นเลข DO
 * - drawer DO: ข้อมูล + จุดรับ–ส่ง + แท็บไทม์ไลน์ + เมนู "…" เปิดเที่ยวรถ · ยืนยันส่งแล้ว (เมนูแถว) → ไทม์ไลน์เที่ยว + dialog ปิดงาน
 * login ครั้งเดียวทั้งไฟล์ · ข้อมูลสมมติผ่าน /v1 + ตั้งสถานะ DO ผ่านฐาน e2e
 */
const test = base.extend<{ loggedIn: void }>({
  loggedIn: [
    async ({}, use) => {
      await use();
    },
    { auto: true },
  ],
});
let page: Page;
let H: Record<string, string> = {};
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
test.afterAll(async () => db.$disconnect());

const RUN = String(Date.now()).slice(-6);
/** เที่ยวที่สร้างในไฟล์นี้ (ยกเลิกตอนจบ) */
const created: string[] = [];
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const num = (s: string | null) => Number((s ?? '').replace(/[^\d]/g, ''));
let trip = { id: '', tripNo: '' };
let dos: { id: string; doNo: string }[] = [];

async function countRows(p: Page): Promise<number> {
  const busy = p.locator('[aria-busy="true"]');
  const size = p.getByLabel('แถวต่อหน้า');
  if ((await size.inputValue()) !== '50') await size.selectOption('50');
  let n = 0;
  for (;;) {
    // ตัวกรองหน่วง 300 ms (useCursorList) — ระหว่างนั้นตารางเป็น aria-busy อยู่แล้ว จึงรอเงื่อนไขแทนการหน่วงเวลา
    await expect(busy).toHaveCount(0);
    await p.waitForLoadState('networkidle');
    await expect(busy).toHaveCount(0);
    n += await p.locator('tbody tr[aria-selected]').count();
    const next = p.getByRole('button', { name: 'ถัดไป', exact: true });
    if (await next.isDisabled()) return n;
    await next.click();
  }
}

test.describe.serial('หน้าใบส่งของ /do', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({
      baseURL: E2E_WEB,
      locale: 'th-TH',
      timezoneId: 'Asia/Bangkok',
      viewport: { width: 1440, height: 900 },
    });
    const email = 'owner@demo-a.test';
    await ctx.addCookies([
      {
        name: 'tms_td',
        value: `${DEMO_TRUSTED_DEVICE}:${DEMO_IDS[email]}`,
        url: `${E2E_WEB}/v1/auth`,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    page = await ctx.newPage();
    const v = randomBytes(32).toString('base64url');
    const r1 = await page.request.post('/v1/auth/login', {
      data: {
        email,
        password: DEMO_PASSWORD,
        codeChallenge: createHash('sha256').update(v).digest('base64url'),
      },
    });
    expect(r1.status(), await r1.text()).toBe(200);
    const { code } = (await r1.json()) as { code: string };
    const r2 = await page.request.post('/v1/oauth/token', {
      data: { grantType: 'authorization_code', code, codeVerifier: v },
    });
    expect(r2.status(), await r2.text()).toBe(200);
    H = { Authorization: `Bearer ${((await r2.json()) as { accessToken: string }).accessToken}` };

    const get = async <X>(path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as X;
    const post = async <X>(path: string, data: object) => {
      const r = await page.request.post(path, {
        headers: { ...H, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), await r.text()).toBeLessThan(300);
      return (await r.json()) as X;
    };
    type P = { data: { id: string; code?: string }[] };
    const company = (await get<P>('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `ลูกค้าใบส่งของ ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังใบส่งของ ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทางใบส่งของ ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<P>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<P>('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W')!.id;
    const veh = await post<{ id: string }>('/v1/vehicles', {
      plate: `4${RUN.slice(-1)}-${RUN.slice(-4)}`,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    dos = [];
    for (let i = 0; i < 3; i++) {
      const so = await post<{ id: string }>('/v1/orders', {
        customer: { id: cust.id },
        requestedDate: today,
        vehicleTypeId: vt6,
        stops: [
          { type: 'PICKUP', siteId: a.id },
          { type: 'DELIVERY', siteId: b.id },
        ],
        lines: [{ description: 'ปูนซีเมนต์', qty: '1', unitId: ton, weightKg: '1000' }],
      });
      const d = (
        await get<{ data: { id: string; doNo: string }[] }>(`/v1/delivery-orders?orderId=${so.id}`)
      ).data[0]!;
      dos.push({ id: d.id, doNo: d.doNo });
    }
    trip = await post<{ id: string; tripNo: string }>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [dos[0]!.id, dos[1]!.id],
      vehicleId: veh.id,
    });
    created.push(trip.id);
    // ใบแรกระหว่างส่ง (เที่ยวปล่อยแล้ว) · ใบที่สองส่งแล้ว · ใบที่สามยังเป็นร่าง (ไม่อยู่ในเที่ยว)
    const t = await db.trip.findFirstOrThrow({ where: { tripNo: trip.tripNo } });
    await db.trip.update({
      where: { id: t.id },
      data: { status: 'IN_PROGRESS', dispatchedAt: new Date(), version: { increment: 1 } },
    });
    await db.deliveryOrder.updateMany({
      where: { tenantId: t.tenantId, doNo: dos[0]!.doNo },
      data: { status: 'DISPATCHED' },
    });
    await db.deliveryOrder.updateMany({
      where: { tenantId: t.tenantId, doNo: dos[1]!.doNo },
      data: { status: 'UNBILLED' },
    });
  });
  test.afterAll(async () => {
    // เก็บกวาด: ยกเลิกเที่ยวที่สร้างในไฟล์นี้ที่ยังยกเลิกได้ (เที่ยวที่ปิดต้นทุน/ปล่อยแล้วคงไว้ — API ตอบ 409)
    for (const id of created) {
      const r = await page.request.get(`/v1/trips/${id}`, { headers: H });
      if (!r.ok()) continue;
      const tr = (await r.json()) as { version: number };
      await page.request.post(`/v1/trips/${id}/cancel`, {
        headers: { ...H, 'If-Match': `"${tr.version}"`, 'Idempotency-Key': randomUUID() },
        data: { reason: 'เก็บกวาดข้อมูลทดสอบ E2E หน้ารายการ' },
      });
    }
    await page?.context().close();
  });

  test('หน้าเปิดได้ + การ์ด 4 ใบ + แท็บตามต้นแบบ', async () => {
    await page.goto('/do');
    await expect(page.getByRole('heading', { name: 'ใบส่งของ (DO)' })).toBeVisible();
    await expect(page.getByText('ยังไม่เปิดใช้')).toHaveCount(0);
    for (const l of ['ร่าง', 'ระหว่างส่ง', 'ส่งแล้ววันนี้', 'ยังไม่วางบิล'])
      await expect(page.locator('.tms-strip__item').filter({ hasText: l }).first()).toBeVisible();
    for (const l of [
      'ทั้งหมด',
      'ร่าง',
      'ระหว่างส่ง',
      'ส่งแล้ว',
      'ตีกลับบางส่วน',
      'ส่งไม่สำเร็จ',
      'วางบิลแล้ว',
    ])
      await expect(page.getByRole('tab', { name: new RegExp(`^${l}`) }).first()).toBeVisible();
    await page.screenshot({ path: 'test-results/uitrips-do-e2e.png', fullPage: true });
  });

  for (const [label, doIdx] of [
    ['ร่าง', 2],
    ['ระหว่างส่ง', 0],
  ] as const)
    test(`การ์ด "${label}" = จำนวนแถวเมื่อคลิก และมี DO ที่คาด`, async () => {
      await page.evaluate(() => sessionStorage.clear()); // ตัวกรองคอลัมน์จาก test ก่อนจำไว้ใน session
      await page.goto('/do');
      const item = page
        .locator('.tms-strip__item')
        .filter({ hasText: new RegExp(`^\\d+${label}$`) });
      await expect(item.locator('.tms-strip__v')).toHaveText(/^\d+$/, { timeout: 15_000 });
      const n = num(await item.locator('.tms-strip__v').textContent());
      expect(n).toBeGreaterThan(0);
      await item.click();
      expect(await countRows(page)).toBe(n);
      await page.locator('thead').getByPlaceholder('ค้นหา').first().fill(dos[doIdx]!.doNo);
      await expect(page.locator('tbody tr[aria-selected]')).toHaveCount(1, { timeout: 15_000 });
    });

  test('drawer DO: ข้อมูล + จุดรับ–ส่ง + เปิดเที่ยวรถ', async () => {
    await page.evaluate(() => sessionStorage.clear());
    await page.goto('/do');
    await page.getByRole('tab', { name: /^ทั้งหมด/ }).click();
    await page.locator('thead').getByPlaceholder('ค้นหา').first().fill(dos[1]!.doNo);
    await expect(page.locator('tbody tr[aria-selected]')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('tbody tr[aria-selected]').first()).toContainText(dos[1]!.doNo);
    await page.locator('tbody tr[aria-selected]').first().click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText(dos[1]!.doNo).first()).toBeVisible();
    await expect(dlg.getByText('จุดรับ–ส่ง')).toBeVisible();
    await expect(dlg.getByText(trip.tripNo)).toBeVisible();
    await page.screenshot({ path: 'test-results/uitrips-do-drawer-e2e.png' });
    for (const l of ['ไทม์ไลน์', 'หลักฐานส่ง', 'ค่าใช้จ่ายหน้างาน'])
      await expect(dlg.getByRole('tab', { name: l })).toBeVisible();
    await dlg.getByRole('tab', { name: 'ไทม์ไลน์' }).click();
    await expect(dlg.getByText('สร้าง DO จาก SO')).toBeVisible();
    await dlg.getByRole('tab', { name: 'รายละเอียด' }).click();
    await dlg.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await dlg.getByRole('menuitem', { name: /เปิดเที่ยวรถ/ }).click();
    await expect(page.getByRole('dialog').getByText('เที่ยวรถ / ใบคุมรถ').first()).toBeVisible();
    await expect(page.getByRole('dialog').getByText(trip.tripNo).first()).toBeVisible();
  });

  test('เมนูแถว "ยืนยันส่งแล้ว" → drawer เที่ยวแท็บไทม์ไลน์ + dialog ปิดงานของจุดส่ง', async () => {
    await page.evaluate(() => sessionStorage.clear());
    await page.goto('/do');
    await page.getByRole('tab', { name: /^ระหว่างส่ง/ }).click();
    await page.locator('thead').getByPlaceholder('ค้นหา').first().fill(dos[0]!.doNo);
    const row = page.locator('tbody tr[aria-selected]');
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row.first()).toContainText(dos[0]!.doNo);
    await row.first().getByRole('button').last().click();
    await page.getByRole('button', { name: 'ยืนยันส่งแล้ว' }).click();
    await expect(page.getByRole('dialog').getByRole('tab', { name: 'ไทม์ไลน์' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('dialog').filter({ hasText: 'ปิดงาน' }).last()).toBeVisible();
    await page.screenshot({ path: 'test-results/uitrips-do-confirm-e2e.png' });
  });
});
