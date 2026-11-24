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
 * E2E หน้าเที่ยวรถ `/trips` (UAT 24 พ.ย. 2569 — ต้นแบบ TMS v4 specTrp + vTrpB) + ปิดต้นทุนเที่ยวจาก drawer
 * - การ์ด/แท็บ: ตัวเลข = จำนวนแถวเมื่อคลิก · ตัวกรองเลขเที่ยว
 * - กระดาน: ลาก DO จาก "DO รอเข้าเที่ยว" ลงการ์ดเที่ยว (attach) และลง "เที่ยวใหม่" (สร้างเที่ยว)
 * - เที่ยวที่จบแล้ว → drawer ส่วน "ยอดเงิน" + ปุ่ม "ปิดต้นทุนเที่ยว" → COSTED
 * login ครั้งเดียวทั้งไฟล์ (แบบ ops-dashboard.spec) · ข้อมูลสมมติผ่าน /v1 + ตั้งสถานะเที่ยวผ่านฐาน e2e
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
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const num = (s: string | null) => Number((s ?? '').replace(/[^\d]/g, ''));
let tripA = { id: '', tripNo: '' };
let dos: { id: string; doNo: string }[] = [];

async function countRows(p: Page): Promise<number> {
  const busy = p.locator('[aria-busy="true"]');
  const size = p.getByLabel('แถวต่อหน้า');
  if ((await size.inputValue()) !== '50') await size.selectOption('50');
  let n = 0;
  for (;;) {
    await p.waitForTimeout(400);
    await p.waitForLoadState('networkidle');
    await expect(busy).toHaveCount(0);
    n += await p.locator('tbody tr[aria-selected]').count();
    const next = p.getByRole('button', { name: 'ถัดไป', exact: true });
    if (await next.isDisabled()) return n;
    await next.click();
  }
}

test.describe.serial('หน้าเที่ยวรถ /trips', () => {
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
      legalName: `ลูกค้าเที่ยวรถ ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังเที่ยวรถ ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทางเที่ยวรถ ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<P>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<P>('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W')!.id;
    const veh = await post<{ id: string }>('/v1/vehicles', {
      plate: `5${RUN.slice(-1)}-${RUN.slice(-4)}`,
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
    tripA = await post<{ id: string; tripNo: string }>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [dos[0]!.id],
      vehicleId: veh.id,
    });
  });
  test.afterAll(async () => page?.context().close());

  test('หน้าเปิดได้ (ไม่ใช่ "ยังไม่เปิดใช้") + การ์ด + กระดาน + ตาราง', async () => {
    await page.goto('/trips');
    await expect(page.getByRole('heading', { name: 'เที่ยวรถ / ใบคุมรถ' })).toBeVisible();
    await expect(page.getByText('ยังไม่เปิดใช้')).toHaveCount(0);
    await expect(page.getByText('DO รอเข้าเที่ยว')).toBeVisible();
    await expect(page.getByTestId('trip-pool-do').filter({ hasText: dos[1]!.doNo })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('trip-card').filter({ hasText: tripA.tripNo })).toBeVisible();
    await page.screenshot({ path: 'test-results/uitrips-trips-e2e.png', fullPage: true });
  });

  test('ลาก DO ลงการ์ดเที่ยว = เพิ่มเข้าเที่ยว · ลงเที่ยวใหม่ = สร้างเที่ยว', async () => {
    await page.goto('/trips');
    const card = page.getByTestId('trip-card').filter({ hasText: tripA.tripNo });
    await page.getByTestId('trip-pool-do').filter({ hasText: dos[1]!.doNo }).dragTo(card);
    await expect(page.getByText(`เพิ่ม ${dos[1]!.doNo} เข้า ${tripA.tripNo} แล้ว`)).toBeVisible();
    const t = (await (await page.request.get(`/v1/trips/${tripA.id}`, { headers: H })).json()) as {
      deliveryOrders: { id: string }[];
    };
    expect(t.deliveryOrders.map((d) => d.id).sort()).toEqual([dos[0]!.id, dos[1]!.id].sort());
    await page
      .getByTestId('trip-pool-do')
      .filter({ hasText: dos[2]!.doNo })
      .dragTo(page.getByTestId('trip-new'));
    await expect(
      page.getByText(new RegExp(`สร้างเที่ยว TRP-\\S+ จาก ${dos[2]!.doNo} แล้ว`)),
    ).toBeVisible();
    await expect(page.getByTestId('trip-pool-do').filter({ hasText: dos[2]!.doNo })).toHaveCount(0);
  });

  test('การ์ด "วางแผน" = จำนวนแถวของแท็บ · ค้นเลขเที่ยว → drawer', async () => {
    await page.goto('/trips');
    const strip = page.locator('.tms-strip__item').filter({ hasText: 'วางแผน' });
    await expect(strip.locator('.tms-strip__v')).toHaveText(/^\d+$/, { timeout: 15_000 });
    const n = num(await strip.locator('.tms-strip__v').textContent());
    expect(n).toBeGreaterThan(0);
    await strip.click();
    expect(await countRows(page)).toBe(n);
    await page.getByRole('tab', { name: /ทั้งหมด/ }).click();
    await page.locator('thead').getByPlaceholder('ค้นหา').first().fill(tripA.tripNo);
    await expect(page.locator('tbody tr[aria-selected]')).toHaveCount(1, { timeout: 15_000 });
    await page.locator('tbody tr[aria-selected]').first().click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText(tripA.tripNo).first()).toBeVisible();
    await expect(dlg.getByText('จุดรับ / ส่ง ตามลำดับ')).toBeVisible();
    await dlg.getByRole('button', { name: 'ปิด' }).first().click();
  });

  test('เที่ยวจบแล้ว → ส่วนยอดเงิน + ปิดต้นทุนเที่ยว → ปิดต้นทุนแล้ว', async () => {
    const t = await db.trip.findFirstOrThrow({ where: { tripNo: tripA.tripNo } });
    await db.trip.update({
      where: { id: t.id },
      data: { status: 'COMPLETED', completedAt: new Date(), dispatchedAt: new Date() },
    });
    await db.deliveryOrder.updateMany({ where: { tripId: t.id }, data: { status: 'UNBILLED' } });
    await page.goto('/trips');
    await page.getByRole('tab', { name: /ส่งแล้ว/ }).click();
    await page.locator('thead').getByPlaceholder('ค้นหา').first().fill(tripA.tripNo);
    await page.locator('tbody tr[aria-selected]').first().click({ timeout: 15_000 });
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByTestId('trip-money')).toContainText('ยอดเงิน');
    await expect(dlg.getByTestId('trip-money')).toContainText('ยังไม่ปิดต้นทุน');
    const btn = dlg.getByTestId('trip-cost-close');
    await expect(btn).toBeEnabled({ timeout: 15_000 });
    await page.screenshot({ path: 'test-results/uitrips-trip-cost-e2e.png' });
    await btn.click();
    const confirm = page.getByRole('dialog', { name: `ปิดต้นทุนเที่ยว ${tripA.tripNo}` });
    await confirm.getByRole('button', { name: 'ปิดต้นทุน', exact: true }).click();
    await expect(page.getByText(`ปิดต้นทุน ${tripA.tripNo} แล้ว`)).toBeVisible();
    const after = (await (
      await page.request.get(`/v1/trips/${tripA.id}`, { headers: H })
    ).json()) as { status: string };
    expect(after.status).toBe('COSTED');
    await expect(page.getByRole('dialog').getByTestId('trip-money')).toContainText('ปิดต้นทุนแล้ว');
  });
});
