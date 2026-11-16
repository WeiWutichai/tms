import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { DEMO_IDS, DEMO_PASSWORD, DEMO_TRUSTED_DEVICE, expect, test } from './fixtures';

/**
 * E2E ST3-T13 มุมมองกระดาน (docs/04 D2 "View") — เกณฑ์ตรวจรับ: สลับมุมมองแล้วข้อมูลชุดเดียวกันจัดกลุ่มใหม่ ·
 * ค่าที่เลือกจำต่อผู้ใช้ (ฝั่ง server — คงอยู่หลังโหลดหน้าใหม่และ login ใหม่)
 * สลับผ่านปุ่ม "มุมมอง: …" (PO 16 พ.ย. 2569 — ปุ่มของหน้ารายการในต้นแบบ) · ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 */
const EMAIL = 'dispatcher@demo-a.test';
test.use({ loginEmail: EMAIL });

const RUN = String(Date.now()).slice(-6);
const OWN = `8${RUN.slice(-1)}-${RUN.slice(-4)}`;
const SUB = `1${RUN.slice(-1)}-${RUN.slice(-4)}`;
const jur = (n: number) => {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
};

async function login(page: Page, email: string): Promise<string> {
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
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
let SO = '';

/** เปิดกระดาน "วันนี้" แล้วคืนลำดับแถวรถ — เฉพาะทะเบียนของรอบนี้ */
async function rowOrder(page: Page, go = true): Promise<string[]> {
  if (go) await page.goto('/plan');
  await page.getByRole('tab', { name: /^วันนี้/ }).click();
  await expect(page.getByTestId(`plan-track-${OWN}`)).toBeAttached();
  await expect(page.getByTestId(`plan-track-${SUB}`)).toBeAttached();
  const ids = await page
    .locator('[data-testid^="plan-track-"]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')!.slice('plan-track-'.length)),
    );
  return ids.filter((p) => p === OWN || p === SUB);
}

/** เลือกมุมมองจากปุ่ม "มุมมอง: …" */
async function pickView(page: Page, label: string) {
  await page.getByRole('button', { name: /^มุมมอง:/ }).click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  await expect(page.getByRole('button', { name: `มุมมอง: ${label}` })).toBeVisible();
}

test.describe.serial('มุมมองกระดานวางแผน (ST3-T13)', () => {
  let me: Record<string, string>;
  const setView = async (page: Page, view: string) => {
    const r = await page.request.put('/v1/planning/board/preferences', {
      headers: me,
      data: { view, cardFields: ['ORDER_NO', 'CUSTOMER', 'TIME', 'ROUTE', 'WEIGHT'] },
    });
    expect(r.status(), await r.text()).toBe(200);
  };

  test.beforeAll(async ({ browser }) => {
    // ข้อมูลตั้งต้นด้วยเจ้าของบริษัท (ผู้จัดรถไม่มีสิทธิ์เพิ่มรถ): รถบริษัท 8x-… + รถร่วม 1x-…
    const page = await browser.newPage();
    // เจ้าของบริษัทบังคับ 2FA — ใช้ cookie อุปกรณ์ที่จำไว้จาก seed (แบบเดียวกับ fixtures.ts)
    await page.context().addCookies([
      {
        name: 'tms_td',
        value: `${DEMO_TRUSTED_DEVICE}:${DEMO_IDS['owner@demo-a.test']}`,
        url: 'http://localhost:4520/v1/auth',
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    const H = { Authorization: `Bearer ${await login(page, 'owner@demo-a.test')}` };
    const post = async (path: string, data: object) => {
      const r = await page.request.post(path, {
        headers: { ...H, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as { id: string };
    };
    const vts = (await (
      await page.request.get('/v1/vehicle-types?limit=50', { headers: H })
    ).json()) as {
      data: { id: string; code: string }[];
    };
    const vt6 = vts.data.find((x) => x.code === '6W')!.id;
    const own = await post('/v1/vehicles', {
      plate: OWN,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    const carrier = await post('/v1/carriers', {
      legalName: `หจก. รถร่วมมุมมอง ${RUN}`,
      entityType: 'JURISTIC',
      taxId: jur(Number(RUN) + 7),
    });
    await post('/v1/vehicles', {
      plate: SUB,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'SUBCONTRACT',
      carrierId: carrier.id,
      payloadKg: 6000,
    });
    // เที่ยว 1 เที่ยวบนรถบริษัท (ไว้ตรวจ field บนการ์ด)
    const get = async (path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as {
        data: { id: string; code?: string }[];
      };
    const company = (await get('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post('/v1/customers', {
      legalName: `ลูกค้ามุมมองอีทูอี ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post('/v1/customer-sites', {
      name: `คลังมุมมอง ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post('/v1/customer-sites', {
      name: `ปลายทางมุมมอง ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const so = (await post('/v1/orders', {
      customer: { id: cust.id },
      requestedDate: today,
      vehicleTypeId: vt6,
      stops: [
        { type: 'PICKUP', siteId: a.id },
        { type: 'DELIVERY', siteId: b.id },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: '3000' }],
    })) as unknown as { soNo: string };
    SO = so.soNo;
    const board = (await (
      await page.request.get(`/v1/planning/board?date=${today}&days=1`, { headers: H })
    ).json()) as { pool: { orderNo: string; deliveryOrders: { id: string }[] }[] };
    const p = board.pool.find((x) => x.orderNo === SO)!;
    await post('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: p.deliveryOrders.map((d) => d.id),
      vehicleId: own.id,
      plannedStartAt: `${today}T08:00:00+07:00`,
      plannedEndAt: `${today}T11:00:00+07:00`,
    });
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    me = { Authorization: `Bearer ${await login(page, EMAIL)}` };
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    me = { Authorization: `Bearer ${await login(page, EMAIL)}` };
    await setView(page, 'FLEET');
    await page.close();
  });

  test('ค่าเริ่มต้น "รถบริษัท + รถร่วม": รถบริษัทก่อนรถร่วม', async ({ page }) => {
    await setView(page, 'FLEET');
    expect(await rowOrder(page)).toEqual([OWN, SUB]);
    await expect(page.getByRole('button', { name: 'มุมมอง: รถบริษัท + รถร่วม' })).toBeVisible();
  });

  test('สลับเป็น "ตามรถ" จากปุ่มมุมมอง → ข้อมูลชุดเดียวกันเรียงตามทะเบียน · จำหลังโหลดใหม่และ login ใหม่', async ({
    page,
  }) => {
    expect(await rowOrder(page)).toEqual([OWN, SUB]);
    await pickView(page, 'ตามรถ');
    expect(await rowOrder(page, false)).toEqual([SUB, OWN]);
    await expect
      .poll(async () => {
        const r = await page.request.get('/v1/planning/board/preferences', { headers: me });
        return ((await r.json()) as { view: string }).view;
      })
      .toBe('VEHICLE');
    // โหลดหน้าใหม่
    await page.reload();
    expect(await rowOrder(page, false)).toEqual([SUB, OWN]);
    // ออกจากระบบ (ล้าง cookie + storage) แล้ว login ใหม่ — ค่ามาจาก server ไม่ใช่ browser
    await page.context().clearCookies();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto('/plan');
    await expect(page).toHaveURL(/\/login/);
    await login(page, EMAIL);
    expect(await rowOrder(page)).toEqual([SUB, OWN]);
    await expect(page.getByRole('button', { name: 'มุมมอง: ตามรถ' })).toBeVisible();
  });

  test('ติ๊กเอา "ลูกค้า" ออกจากข้อมูลบนการ์ด → การ์ดไม่แสดงลูกค้า · จำหลังโหลดใหม่', async ({
    page,
  }) => {
    await rowOrder(page);
    const card = page.getByTestId(`plan-track-${OWN}`).getByTestId(/^plan-trip-/);
    await expect(card).toContainText(SO);
    await expect(card).toContainText(`ลูกค้ามุมมองอีทูอี ${RUN}`);
    await page.getByRole('button', { name: /^มุมมอง:/ }).click();
    const box = page.getByRole('checkbox', { name: 'ลูกค้า' });
    await expect(box).toBeChecked();
    await box.click();
    await expect(box).not.toBeChecked();
    await expect(card).not.toContainText(`ลูกค้ามุมมองอีทูอี ${RUN}`);
    await expect(card).toContainText(SO);
    await expect
      .poll(async () => {
        const r = await page.request.get('/v1/planning/board/preferences', { headers: me });
        return ((await r.json()) as { cardFields: string[] }).cardFields;
      })
      .toEqual(['ORDER_NO', 'TIME', 'ROUTE', 'WEIGHT']);
    await page.reload();
    await rowOrder(page, false);
    await expect(card).toContainText(SO);
    await expect(card).not.toContainText(`ลูกค้ามุมมองอีทูอี ${RUN}`);
  });

  test('สลับกลับ "รถบริษัท + รถร่วม" → กลับลำดับเดิม', async ({ page }) => {
    expect(await rowOrder(page)).toEqual([SUB, OWN]);
    await pickView(page, 'รถบริษัท + รถร่วม');
    expect(await rowOrder(page, false)).toEqual([OWN, SUB]);
  });
});
