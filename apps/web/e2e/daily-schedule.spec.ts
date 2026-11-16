import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST3-T19 ตารางรถ/คนขับรายวัน (docs/04 D2 "ภาระงาน ว่าง ซ่อม ลา (คลิกขวาใส่วันลา/โน้ต)") — เกณฑ์ตรวจรับ:
 * ใส่วันลาคนขับแล้วคนขับไม่ขึ้นเป็น "ว่าง" ในวันนั้น
 * (1) กระดาน 7 วัน: ช่องรถที่ไม่มีงาน = "ว่าง" → คลิกขวา → "ใส่วันลา · {คนขับ}" → ช่องวันนั้นเป็น "ลา · {คนขับ}" (วันอื่นยังว่าง)
 *     · เที่ยวที่จัดคนขับคนนี้ไว้ในวันลา → คำเตือน "ลาวันที่ …" (ST3-T14)
 * (2) คลิกขวา → "เพิ่มโน้ต" → โน้ตขึ้นในช่อง · ยกเลิกวันลา (เหตุผล ≥ 10) → กลับเป็น "ว่าง"
 * ใช้วัน +3/+4 ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const PLATE = `3${RUN.slice(-1)}-${RUN.slice(-4)}`;
const DRIVER = `คนขับตารางรถ ${RUN}`;
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const plus = (n: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const DAY = plus(3);
const DAY2 = plus(4);
const DAY3 = plus(5);

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

test.describe.serial('ตารางรถ/คนขับรายวัน (ST3-T19)', () => {
  let H: Record<string, string> = {};
  let tripId = '';
  let tripNo = '';

  const post = async <X>(page: Page, path: string, data: object) => {
    const r = await page.request.post(path, {
      headers: { ...H, 'Idempotency-Key': randomUUID() },
      data,
    });
    expect(r.status(), await r.text()).toBeLessThan(300);
    return (await r.json()) as X;
  };
  const warnings = async (page: Page) =>
    (
      (await (await page.request.get(`/v1/trips/${tripId}`, { headers: H })).json()) as {
        warnings: { code: string; message: string }[];
      }
    ).warnings;
  const week = async (page: Page) => {
    await page.goto('/plan');
    await page.getByRole('tab', { name: /^7 วัน/ }).click();
    await expect(page.getByTestId(`plan-cell-${PLATE}-${DAY}`)).toBeVisible();
  };

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (tripId) return;
    const get = async <X>(path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as X;
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>(page, '/v1/customers', {
      legalName: `ลูกค้าตารางรถ ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>(page, '/v1/customer-sites', {
      name: `คลังตารางรถ ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>(page, '/v1/customer-sites', {
      name: `ปลายทางตารางรถ ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const v = await post<{ id: string }>(page, '/v1/vehicles', {
      plate: PLATE,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    const d = await post<{ id: string }>(page, '/v1/drivers', {
      name: DRIVER,
      phone: `086-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
      employmentType: 'EMPLOYEE_SALARIED',
      licenceClass: 'T2',
      licenceExpiresOn: '2030-03-31',
      defaultVehicleId: v.id,
    });
    // เที่ยววันที่ 2 จัดรถ + คนขับคนนี้ไว้ก่อน (ภาระงาน)
    const so = await post<{ id: string }>(page, '/v1/orders', {
      customer: { id: cust.id },
      requestedDate: DAY2,
      vehicleTypeId: vt6,
      stops: [
        { type: 'PICKUP', siteId: a.id },
        { type: 'DELIVERY', siteId: b.id },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '1', unitId: ton, weightKg: '1500' }],
    });
    const doId = (await get<Page1>(`/v1/delivery-orders?orderId=${so.id}`)).data[0]!.id;
    const t = await post<{ id: string; tripNo: string }>(page, '/v1/trips', {
      tripDate: DAY2,
      deliveryOrderIds: [doId],
      vehicleId: v.id,
      plannedStartAt: `${DAY2}T09:00:00+07:00`,
      plannedEndAt: `${DAY2}T12:00:00+07:00`,
    });
    await post(page, `/v1/trips/${t.id}/assign`, { vehicleId: v.id, driverId: d.id });
    tripId = t.id;
    tripNo = t.tripNo;
  });

  test('เกณฑ์ตรวจรับ: คลิกขวาใส่วันลาคนขับ → ช่องวันนั้นเป็น "ลา" ไม่ใช่ "ว่าง" · เที่ยวในวันลามีคำเตือน', async ({
    page,
  }) => {
    await week(page);
    const cell = page.getByTestId(`plan-cell-${PLATE}-${DAY}`);
    const state = page.getByTestId(`plan-cellstate-${PLATE}-${DAY}`);
    await expect(state).toHaveAttribute('data-state', 'FREE');
    await expect(state).toHaveText('ว่าง');
    // วันที่มีเที่ยว = ภาระงาน (การ์ดเที่ยว) ไม่ใช่ "ว่าง"
    const busy = page.getByTestId(`plan-cell-${PLATE}-${DAY2}`);
    await expect(busy.getByTestId(`plan-trip-${tripNo}`)).toBeVisible();
    await expect(busy.getByTestId(`plan-cellstate-${PLATE}-${DAY2}`)).toHaveCount(0);
    expect((await warnings(page)).map((w) => w.code)).not.toContain('driver_on_leave');

    await cell.click({ button: 'right' });
    const menu = page.getByTestId('plan-ctx');
    await expect(menu).toBeVisible();
    await page.screenshot({ path: 'test-results/st3-schedule-menu.png' });
    await menu.getByRole('menuitem', { name: `ใส่วันลา · ${DRIVER}` }).click();
    const dlg = page.getByRole('dialog', { name: 'ใส่วันลาคนขับ' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByLabel('คนขับ')).toHaveValue(/^drv_/);
    await expect(dlg.getByLabel('ตั้งแต่วันที่')).toHaveValue(DAY);
    await dlg.getByLabel('ถึงวันที่').fill(DAY2);
    await dlg.getByLabel('เหตุผลการลา').fill('ลาป่วย');
    await page.screenshot({ path: 'test-results/st3-schedule-dialog.png' });
    await dlg.getByRole('button', { name: 'บันทึก' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'บันทึกวันลา' })).toContainText(DRIVER);

    // วันลา: ไม่ใช่ "ว่าง" แต่เป็น "ลา · {คนขับ}"
    await expect(state).toHaveAttribute('data-state', 'LEAVE');
    await expect(state).toHaveText(`ลา · ${DRIVER}`);
    await expect(cell).not.toContainText('ว่าง');
    // วันที่มีเที่ยว + ลา = ป้ายลาบนช่องด้วย · วันถัดไปยังว่าง
    await expect(page.getByTestId(`plan-leave-${PLATE}-${DAY2}`)).toBeVisible();
    await expect(page.getByTestId(`plan-cellstate-${PLATE}-${DAY3}`)).toHaveText('ว่าง');
    await page.screenshot({ path: 'test-results/st3-schedule-leave.png' });
    // กฎตอนจัด (ST3-T14): เที่ยวที่จัดคนขับคนนี้ในวันลา → คำเตือนพร้อมวัน
    const w = (await warnings(page)).find((x) => x.code === 'driver_on_leave');
    expect(w?.message).toContain(`${DRIVER} ลาวันที่`);
    await expect(page.getByTestId(`plan-trip-${tripNo}`)).toBeVisible();
  });

  test('คลิกขวาเพิ่มโน้ต → ขึ้นในช่อง · ยกเลิกวันลาพร้อมเหตุผล → กลับเป็น "ว่าง"', async ({
    page,
  }) => {
    await week(page);
    const cell = page.getByTestId(`plan-cell-${PLATE}-${DAY}`);
    await cell.click({ button: 'right' });
    await page.getByTestId('plan-ctx').getByRole('menuitem', { name: 'เพิ่มโน้ต' }).click();
    const dlg = page.getByRole('dialog', { name: /^เพิ่มโน้ต/ });
    await dlg.getByLabel('โน้ต').fill('นัดเปลี่ยนยางช่วงบ่าย');
    await dlg.getByRole('button', { name: 'บันทึก' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByTestId(`plan-note-${PLATE}-${DAY}`)).toHaveText('นัดเปลี่ยนยางช่วงบ่าย');
    await page.screenshot({ path: 'test-results/st3-schedule-note.png' });

    await cell.click({ button: 'right' });
    await page
      .getByTestId('plan-ctx')
      .getByRole('menuitem', { name: `ยกเลิกวันลา · ${DRIVER}` })
      .click();
    const rd = page.getByRole('dialog', { name: `ยกเลิกวันลา · ${DRIVER}` });
    await expect(rd).toContainText('ลาป่วย');
    const ok = rd.getByRole('button', { name: 'ยืนยัน' });
    await rd.getByRole('textbox').fill('สั้นไป');
    await expect(ok).toBeDisabled();
    await rd.getByRole('textbox').fill('คนขับแจ้งยกเลิกการลาแล้ว');
    await ok.click();
    await expect(rd).toBeHidden();
    const state = page.getByTestId(`plan-cellstate-${PLATE}-${DAY}`);
    await expect(state).toHaveAttribute('data-state', 'FREE');
    await expect(state).toHaveText('ว่าง');
    await expect(page.getByTestId(`plan-note-${PLATE}-${DAY}`)).toBeVisible();
    expect((await warnings(page)).map((x) => x.code)).not.toContain('driver_on_leave');
  });
});
