import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST3-T15 Filter รถที่รับได้สองทาง (docs/04 D2; spec/03 §5):
 * (1) เกณฑ์ตรวจรับ: คลิก SO ห้องเย็น → เน้นเฉพาะรถห้องเย็นที่น้ำหนักพอ (ขอบเขียว) · ห้องเย็นเล็กเกิน/รถธรรมดา = ขอบส้ม + จาง
 * (2) คลิกรถ → การ์ด SO ที่รถรับได้ถูกเน้น · เลข SO บนการ์ด = เปิด drawer
 * (3) "ย้ายไปรถอื่น" (ต้นแบบ moveBlock): เที่ยวติดเงื่อนไขย้ายไปรถที่ผ่านกฎทั้งหมด · ข้อมูลสมมติ ผ่าน /v1 จริง (ฐาน e2e)
 */
const RUN = String(Date.now()).slice(-6);
const CUST = `ลูกค้ารถที่รับได้อีทูอี ${RUN}`;
const COLD = `8${RUN.slice(-1)}-${RUN.slice(-4)}`;
const SMALL = `8${(Number(RUN.slice(-1)) + 1) % 10}-${RUN.slice(-4)}`;
const DRY = `8${(Number(RUN.slice(-1)) + 2) % 10}-${RUN.slice(-4)}`;
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

async function token(page: Page, email: string): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await page.request.post('/v1/auth/login', {
    data: {
      email,
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

const so: Record<'cold' | 'dry' | 'cold2', { id: string; soNo: string }> = {} as never;
const veh: Record<string, string> = {};
let H: Record<string, string> = {};

async function seed(page: Page) {
  H = { Authorization: `Bearer ${await token(page, 'planner@demo-a.test')}` };
  if (so.cold) return;
  const get = async (path: string) =>
    (await (await page.request.get(path, { headers: H })).json()) as {
      data: { id: string; code?: string }[];
    };
  const post = async (path: string, data: object) => {
    const r = await page.request.post(path, {
      headers: { ...H, 'Idempotency-Key': randomUUID() },
      data,
    });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()) as { id: string; soNo: string };
  };
  const company = (await get('/v1/companies?status=active&limit=1')).data[0]!.id;
  const cust = await post('/v1/customers', { legalName: CUST, billingCompanyId: company });
  const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
  const a = await post('/v1/customer-sites', {
    name: `คลังห้องเย็น ${RUN}`,
    kind: 'PICKUP',
    address: addr('สมุทรปราการ'),
  });
  const b = await post('/v1/customer-sites', {
    name: `ปลายทางห้องเย็น ${RUN}`,
    kind: 'DROPOFF',
    address: addr('ชลบุรี'),
  });
  const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
  const types = (await get('/v1/vehicle-types?limit=50')).data;
  const vt6 = types.find((x) => x.code === '6W')!.id;
  const ref6 = types.find((x) => x.code === 'REF6')!.id;
  for (const [plate, vehicleTypeId, payloadKg] of [
    [COLD, ref6, 4500],
    [SMALL, ref6, 3000],
    [DRY, vt6, 6000],
  ] as const)
    veh[plate] = (
      await post('/v1/vehicles', {
        plate,
        plateProvince: 'TH-10',
        vehicleTypeId,
        ownership: 'OWN',
        payloadKg,
      })
    ).id;
  const order = (vehicleTypeId: string, weightKg: string) =>
    post('/v1/orders', {
      customer: { id: cust.id },
      requestedDate: today,
      vehicleTypeId,
      stops: [
        { type: 'PICKUP', siteId: a.id },
        { type: 'DELIVERY', siteId: b.id },
      ],
      lines: [{ description: 'นมพาสเจอไรซ์', qty: '4', unitId: ton, weightKg }],
    });
  so.cold = await order(ref6, '4000');
  so.dry = await order(vt6, '2000');
  so.cold2 = await order(ref6, '4000');
}

const open = async (page: Page) => {
  await page.goto('/plan');
  await page.getByRole('tab', { name: /^วันนี้/ }).click();
  await page.getByLabel('ลูกค้า', { exact: true }).selectOption({ label: CUST });
  await expect(page.getByTestId(`plan-row-${COLD}`)).toBeVisible();
};
/** คลิกที่ตัวการ์ด (บรรทัดเส้นทาง) — ไม่ใช่เลข SO ที่เปิด drawer */
const pick = (page: Page, soNo: string) =>
  page.getByTestId(`plan-pool-${soNo}`).getByText(/→/).click();

test.describe.serial('Filter รถที่รับได้สองทาง (ST3-T15)', () => {
  test.use({ loginEmail: 'planner@demo-a.test' });
  test.beforeEach(async ({ page }) => seed(page));

  test('เกณฑ์ตรวจรับ: คลิก SO ห้องเย็น → เน้นเฉพาะรถห้องเย็นที่น้ำหนักพอ', async ({ page }) => {
    await open(page);
    await pick(page, so.cold.soNo);
    const row = (p: string) => page.getByTestId(`plan-row-${p}`);
    await expect(row(COLD)).toHaveAttribute('data-elig', 'OK');
    await expect(row(SMALL)).toHaveAttribute('data-elig', 'WARNING');
    await expect(row(DRY)).toHaveAttribute('data-elig', 'WARNING');
    // ขอบเขียว = รับได้ · ส้ม = ติดเงื่อนไข · ที่ไม่ผ่านจาง
    await expect(page.getByTestId(`plan-track-${COLD}`)).toHaveCSS(
      'box-shadow',
      /rgb\(23, 115, 63\)/,
    );
    await expect(page.getByTestId(`plan-track-${DRY}`)).toHaveCSS(
      'box-shadow',
      /rgb\(143, 85, 0\)/,
    );
    await expect(row(COLD)).toHaveCSS('opacity', '1');
    await expect(row(DRY)).toHaveCSS('opacity', '0.6');
    await expect(page.getByTestId(`plan-track-${DRY}`)).toHaveAttribute(
      'title',
      /ต้องใช้รถห้องเย็น/,
    );
    await expect(page.getByTestId(`plan-track-${SMALL}`)).toHaveAttribute(
      'title',
      'น้ำหนักเกิน 1,000 กก. (4,000 / 3,000 กก.)',
    );
    // การ์ดที่เลือก + คลิกซ้ำ/Esc = เลิกเน้น
    await expect(page.getByTestId(`plan-pool-${so.cold.soNo}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await pick(page, so.cold.soNo);
    await expect(row(COLD)).not.toHaveAttribute('data-elig', /.*/);
    await pick(page, so.cold.soNo);
    await expect(row(COLD)).toHaveAttribute('data-elig', 'OK');
    await page.keyboard.press('Escape');
    await expect(row(COLD)).not.toHaveAttribute('data-elig', /.*/);
  });

  test('คลิกรถ → SO ที่รถรับได้ถูกเน้น · เลข SO เปิด drawer', async ({ page }) => {
    await open(page);
    await page.getByTestId(`plan-veh-${DRY}`).click();
    await expect(page.getByTestId(`plan-veh-${DRY}`)).toHaveAttribute('aria-pressed', 'true');
    const card = (n: string) => page.getByTestId(`plan-pool-${n}`);
    await expect(card(so.dry.soNo)).toHaveAttribute('data-elig', 'OK');
    await expect(card(so.cold.soNo)).toHaveAttribute('data-elig', 'WARNING');
    await expect(card(so.cold.soNo)).toHaveCSS('opacity', '0.6');
    await expect(card(so.cold.soNo)).toHaveAttribute('title', /ต้องใช้รถห้องเย็น/);
    // รถห้องเย็นคันใหญ่รับได้ทั้งคู่
    await page.getByTestId(`plan-veh-${COLD}`).click();
    await expect(card(so.cold.soNo)).toHaveAttribute('data-elig', 'OK');
    await expect(card(so.dry.soNo)).toHaveAttribute('data-elig', 'OK');
    await card(so.dry.soNo).getByRole('button', { name: so.dry.soNo }).click();
    await expect(page.getByRole('dialog')).toContainText(so.dry.soNo);
  });

  test('ย้ายไปรถอื่น: เที่ยวห้องเย็นบนรถธรรมดา → ย้ายไปรถห้องเย็นที่รับได้', async ({ page }) => {
    const board = (await (
      await page.request.get(`/v1/planning/board?date=${today}&days=1`, { headers: H })
    ).json()) as { pool: { orderNo: string; deliveryOrders: { id: string }[] }[] };
    const p = board.pool.find((x) => x.orderNo === so.cold2.soNo)!;
    const r = await page.request.post('/v1/trips', {
      headers: { ...H, 'Idempotency-Key': randomUUID() },
      data: {
        tripDate: today,
        deliveryOrderIds: p.deliveryOrders.map((d) => d.id),
        vehicleId: veh[DRY],
        plannedStartAt: `${today}T13:00:00+07:00`,
        plannedEndAt: `${today}T15:00:00+07:00`,
      },
    });
    expect(r.status(), await r.text()).toBe(201);
    const t = (await r.json()) as { id: string; tripNo: string };
    await page.goto('/plan');
    await page.getByRole('tab', { name: /^7 วัน/ }).click();
    await page.getByLabel('ลูกค้า', { exact: true }).selectOption({ label: CUST });
    const card = page.getByTestId(`plan-trip-${t.tripNo}`);
    await card.scrollIntoViewIfNeeded();
    await card.click();
    await page.getByTestId(`plan-move-${t.tripNo}`).click();
    await expect(page.getByRole('status')).toContainText(
      `ย้าย ${so.cold2.soNo} จาก ${DRY} ไป ${COLD} แล้ว`,
    );
    const after = (await (await page.request.get(`/v1/trips/${t.id}`, { headers: H })).json()) as {
      vehicle: { plate: string };
    };
    expect(after.vehicle.plate).toBe(COLD);
  });
});
