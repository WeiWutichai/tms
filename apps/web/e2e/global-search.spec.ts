import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { DEMO_IDS, DEMO_TRUSTED_DEVICE, E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST9-T09 ค้นหา global (⌘K) — เกณฑ์ตรวจรับ: พิมพ์เลข DO บางส่วนแล้วเจอและเปิดเอกสารได้; ไม่เห็นผลของ tenant อื่น
 * เตรียม SO → DO → เที่ยว ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

async function token(page: Page, email = 'owner@demo-a.test'): Promise<string> {
  // บริษัท B บังคับ 2FA — ใช้ cookie อุปกรณ์ที่จำไว้จาก seed (แบบเดียวกับ fixtures.ts)
  if (DEMO_IDS[email])
    await page.context().addCookies([
      {
        name: 'tms_td',
        value: `${DEMO_TRUSTED_DEVICE}:${DEMO_IDS[email]}`,
        url: `${E2E_WEB}/v1/auth`,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
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

test.describe.serial('ค้นหา ⌘K (ST9-T09)', () => {
  test.describe.configure({ timeout: 90_000 });
  const S: { doNo?: string; tripId?: string; tripNo?: string; soNo?: string } = {};

  test.beforeEach(async ({ page }) => {
    if (S.doNo) return;
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
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `บจก. ค้นหาทั่วระบบ ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังต้นทาง ค้นหา ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทาง ค้นหา ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const rc = await post<{ id: string }>('/v1/rate-cards', {
      customerId: cust.id,
      originId: a.id,
      destinationId: b.id,
      vehicleTypeId: vt6,
      validFrom: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
      pricingModel: 'PER_TRIP',
      sellRate: '6500',
    });
    await post(`/v1/rate-cards/${rc.id}/approve`, { reason: 'อนุมัติตามใบเสนอราคา' });
    const so = await post<{ id: string }>('/v1/orders', {
      customer: { id: cust.id },
      customerRef: `PO-CMDK-${RUN}`,
      requestedDate: today,
      vehicleTypeId: vt6,
      stops: [
        { type: 'PICKUP', siteId: a.id },
        { type: 'DELIVERY', siteId: b.id },
      ],
      lines: [{ description: 'เม็ดพลาสติก PP', qty: '2', unitId: ton, weightKg: '2000' }],
    });
    const d = (await get<Page1>(`/v1/delivery-orders?orderId=${so.id}`)).data[0]!;
    const t = await post<{ id: string; tripNo: string }>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [d.id],
    });
    S.doNo = (await get<{ doNo: string }>(`/v1/delivery-orders/${d.id}`)).doNo;
    S.tripId = t.id;
    S.soNo = (await get<{ soNo: string }>(`/v1/orders/${so.id}`)).soNo;
    S.tripNo = t.tripNo;
  });

  test('⌘K/Ctrl+K → พิมพ์เลข DO บางส่วน → Enter เปิด drawer เที่ยวของ DO นั้น', async ({
    page,
  }) => {
    await page.goto('/');
    // รอโครงหน้า (sidebar) ขึ้นก่อนกดคีย์ลัด
    await expect(page.getByRole('button', { name: 'ค้นหา ⌘K' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const dlg = page.getByRole('dialog', { name: 'ค้นหา' });
    await expect(dlg).toBeVisible();
    const input = dlg.getByRole('combobox');
    await expect(input).toBeFocused();
    // เลข DO บางส่วน (ตัดตัวแรกออก ตัวพิมพ์เล็ก)
    const part = S.doNo!.slice(1).toLowerCase();
    await input.fill(part);
    const opt = dlg.getByRole('option', { name: new RegExp(S.doNo!) });
    await expect(opt).toBeVisible();
    await expect(opt).toContainText(`บจก. ค้นหาทั่วระบบ ${RUN}`);
    await opt.hover();
    await expect(opt).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter');
    await expect(dlg).toBeHidden();
    // เปิดแล้วล้างพารามิเตอร์ออกจาก URL
    await expect(page).toHaveURL(/\/plan$/);
    await expect(
      page.getByRole('dialog').getByText(S.tripNo!, { exact: true }).first(),
    ).toBeVisible();
  });

  test('เลข SO → Enter เปิด drawer SO', async ({ page }) => {
    await page.goto('/plan');
    await page.getByRole('button', { name: 'ค้นหา ⌘K' }).click();
    const dlg = page.getByRole('dialog', { name: 'ค้นหา' });
    await dlg.getByRole('combobox').fill(S.soNo!);
    const opt = dlg.getByRole('option', { name: new RegExp(S.soNo!) });
    await expect(opt).toBeVisible();
    await opt.click();
    await expect(page).toHaveURL(/\/so$/);
    await expect(
      page.getByRole('dialog').getByText(S.soNo!, { exact: true }).first(),
    ).toBeVisible();
  });

  test('Esc ปิด · ไม่พบผลแสดงกล่องว่าง', async ({ page }) => {
    await page.goto('/so');
    await page.getByRole('button', { name: 'ค้นหา ⌘K' }).click();
    const dlg = page.getByRole('dialog', { name: 'ค้นหา' });
    await dlg.getByRole('combobox').fill(`ไม่มีจริง-${RUN}`);
    await expect(dlg.getByText('ไม่พบผลลัพธ์')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
  });

  test('ไม่เห็นผลของ tenant อื่น (บริษัท B ค้นเลข DO ของบริษัท A)', async ({ page }) => {
    const r = await page.request.get(`/v1/search?q=${encodeURIComponent(S.doNo!)}`, {
      headers: { Authorization: `Bearer ${await token(page, 'owner@demo-b.test')}` },
    });
    expect(r.status()).toBe(200);
    expect(((await r.json()) as { data: unknown[] }).data).toEqual([]);
  });
});
