import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { DEMO_IDS, DEMO_PASSWORD, DEMO_TRUSTED_DEVICE, expect, test } from './fixtures';

/**
 * E2E ST3-T13 มุมมองกระดาน (docs/04 D2 "View") — เกณฑ์ตรวจรับ: สลับมุมมองแล้วข้อมูลชุดเดียวกันจัดกลุ่มใหม่ ·
 * ค่าที่เลือกจำต่อผู้ใช้ (ฝั่ง server — คงอยู่หลังโหลดหน้าใหม่และ login ใหม่)
 * ตัวสลับบนจอยังไม่มีในต้นแบบ (spec/12 §3 ST3-T13 รอ PO) → เปลี่ยนค่าผ่าน API ชุดเดียวกับที่ UI จะเรียก
 * (PUT /v1/planning/board/preferences) · ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
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

/** ลำดับแถวรถบนกระดาน "วันนี้" — เฉพาะทะเบียนของรอบนี้ */
async function rowOrder(page: Page): Promise<string[]> {
  await page.goto('/plan');
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
    await post('/v1/vehicles', {
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
  });

  test('สลับเป็น "ตามรถ" → ข้อมูลชุดเดียวกันเรียงตามทะเบียน · จำหลังโหลดใหม่และ login ใหม่', async ({
    page,
  }) => {
    await setView(page, 'VEHICLE');
    expect(await rowOrder(page)).toEqual([SUB, OWN]);
    // โหลดหน้าใหม่
    await page.reload();
    expect(await rowOrder(page)).toEqual([SUB, OWN]);
    // ออกจากระบบ (ล้าง cookie) แล้ว login ใหม่ — ค่ามาจาก server ไม่ใช่ browser
    await page.context().clearCookies();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto('/plan');
    await expect(page).toHaveURL(/\/login/);
    await login(page, EMAIL);
    expect(await rowOrder(page)).toEqual([SUB, OWN]);
    const r = await page.request.get('/v1/planning/board/preferences', { headers: me });
    expect(((await r.json()) as { view: string }).view).toBe('VEHICLE');
  });

  test('สลับกลับ "รถบริษัท + รถร่วม" → กลับลำดับเดิม', async ({ page }) => {
    await setView(page, 'FLEET');
    expect(await rowOrder(page)).toEqual([OWN, SUB]);
  });
});
