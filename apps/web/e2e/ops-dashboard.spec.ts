import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST9-T01 Dashboard ปฏิบัติการ — เกณฑ์ตรวจรับ: ตัวเลขแต่ละการ์ด = จำนวนแถวเมื่อคลิกเข้าไปดูรายการ
 * คลิกการ์ด KPI ทุกใบ (ตาราง "ต้องทำวันนี้" กรองตามการ์ด) + กล่องรถบริษัท (หน้าทะเบียนรถ) + แถวใบค้างต่อเหตุ (หน้าใบค้าง)
 * แล้วนับแถวจริงในตารางทุกหน้า เทียบกับตัวเลขบนการ์ด · ข้อมูลสมมติผ่าน /v1 จริง + ตั้งสถานะผ่านฐาน e2e
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
test.afterAll(async () => db.$disconnect());

const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

async function token(page: Page): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await page.request.post('/v1/auth/login', {
    data: {
      email: 'owner@demo-a.test',
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

/** จำนวนแถวจริงของตาราง (50 แถว/หน้า แล้วเดินหน้าถัดไปจนหมด) */
async function countRows(page: Page): Promise<number> {
  const busy = page.locator('[aria-busy="true"]');
  const size = page.getByLabel('แถวต่อหน้า');
  if ((await size.inputValue()) !== '50') await size.selectOption('50');
  let n = 0;
  for (;;) {
    // ตัวกรองหน่วง 300 ms ก่อนยิง API (useCursorList) — รอให้คำขอของตัวกรอง/หน้าปัจจุบันจบก่อนนับ
    await page.waitForTimeout(400);
    await page.waitForLoadState('networkidle');
    await expect(busy).toHaveCount(0);
    n += await page.locator('tbody tr[aria-selected]').count();
    const next = page.getByRole('button', { name: 'ถัดไป', exact: true });
    if (await next.isDisabled()) return n;
    await next.click();
  }
}
const num = (s: string | null) => Number((s ?? '').replace(/[^\d]/g, ''));

test.describe.serial('Dashboard ปฏิบัติการ (ST9-T01)', () => {
  // เตรียมข้อมูลใน test แรก (ใช้ context ที่ login แล้วของ fixture — owner ใช้อุปกรณ์ที่จำไว้ข้าม 2FA)
  test('เตรียมข้อมูล: SO รอจัด + เที่ยวที่ปล่อยแล้ว (DO ระหว่างส่ง/ส่งแล้ว/ส่งไม่สำเร็จ)', async ({
    page,
  }) => {
    const H = { Authorization: `Bearer ${await token(page)}` };
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
      legalName: `ลูกค้าแดชบอร์ด ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังแดชบอร์ด ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทางแดชบอร์ด ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<P>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<P>('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W')!.id;
    const veh = await post<{ id: string; plate: string }>('/v1/vehicles', {
      plate: `6${RUN.slice(-1)}-${RUN.slice(-4)}`,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    const so = () =>
      post<{ id: string }>('/v1/orders', {
        customer: { id: cust.id },
        requestedDate: today,
        vehicleTypeId: vt6,
        stops: [
          { type: 'PICKUP', siteId: a.id },
          { type: 'DELIVERY', siteId: b.id },
        ],
        lines: [{ description: 'ปูนซีเมนต์', qty: '1', unitId: ton, weightKg: '1000' }],
      });
    const doOf = async (id: string) =>
      (await get<P>(`/v1/delivery-orders?orderId=${id}`)).data[0]!.id;
    // SO รอจัด 1 ใบ + เที่ยว (3 DO) ที่จะตั้งเป็น ปล่อยรถแล้ว / ส่งแล้ว / ส่งไม่สำเร็จ
    await so();
    const dos = [
      await doOf((await so()).id),
      await doOf((await so()).id),
      await doOf((await so()).id),
    ];
    const trip = await post<{ tripNo: string; deliveryOrders: { doNo: string }[] }>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: dos,
    });
    const t = await db.trip.findFirstOrThrow({ where: { tripNo: trip.tripNo } });
    const v = await db.vehicle.findFirstOrThrow({
      where: { tenantId: t.tenantId, plate: veh.plate },
    });
    await db.trip.update({
      where: { id: t.id },
      data: {
        status: 'DISPATCHED',
        vehicleId: v.id,
        vehiclePlateSnapshot: veh.plate,
        vehicleTypeId: v.vehicleTypeId,
        dispatchedAt: new Date(),
      },
    });
    const [d1, d2, d3] = trip.deliveryOrders.map((x) => x.doNo);
    for (const [no, status] of [
      [d1, 'DISPATCHED'],
      [d2, 'DELIVERED'],
      [d3, 'FAILED'],
    ] as const)
      await db.deliveryOrder.updateMany({
        where: { tenantId: t.tenantId, doNo: no },
        data: { status },
      });
  });

  for (const card of ['today', 'waiting', 'running', 'failed', 'delivered', 'offered'] as const)
    test(`การ์ด ${card}: ตัวเลข = จำนวนแถวในตารางเมื่อคลิก`, async ({ page }) => {
      await page.goto('/');
      const kpi = page.getByTestId(`kpi-${card}`);
      await expect(kpi).toHaveText(/^\d[\d,]*$/);
      const n = num(await kpi.textContent());
      if (card !== 'offered') expect(n, card).toBeGreaterThan(0);
      await kpi.click();
      if (card !== 'today') await expect(page).toHaveURL(new RegExp(`\\?card=${card}$`));
      expect(await countRows(page), card).toBe(n);
      if (card === 'running')
        await page.screenshot({
          path: 'test-results/st9-ops-dashboard-running.png',
          fullPage: true,
        });
    });

  test('กล่องรถบริษัท ว่าง/ใช้งาน/ซ่อม = จำนวนแถวในหน้าทะเบียนรถที่กรองแล้ว', async ({ page }) => {
    for (const k of ['available', 'inUse', 'maintenance'] as const) {
      await page.goto('/');
      const box = page.getByTestId(`fleet-${k}-n`);
      await expect(box).toHaveText(/^\d[\d,]*$/);
      const n = num(await box.textContent());
      if (k === 'inUse') expect(n).toBeGreaterThan(0);
      await page.getByTestId(`fleet-${k}`).click();
      await expect(page).toHaveURL(/\/fleet\/vehicles\?ownership=OWN/);
      expect(await countRows(page), k).toBe(n);
    }
  });

  test('ใบค้างต่อเหตุ = จำนวนแถวในหน้าใบค้างที่กรองเหตุนั้น', async ({ page }) => {
    await page.goto('/');
    const rows = page.getByTestId('dash-holds').locator('.tms-dash-row');
    await expect(page.getByTestId('dash-holds')).toBeVisible();
    const codes = await rows.evaluateAll((els) =>
      els.map((e) => (e.getAttribute('data-testid') ?? '').replace(/^hold-/, '')),
    );
    for (const code of codes.slice(0, 3)) {
      await page.goto('/');
      const n = num(await page.getByTestId(`hold-${code}-n`).textContent());
      await page.getByTestId(`hold-${code}`).click();
      await expect(page).toHaveURL(new RegExp(`/so/hold\\?reason=${code}$`));
      expect(await countRows(page), code).toBe(n);
    }
  });
});
