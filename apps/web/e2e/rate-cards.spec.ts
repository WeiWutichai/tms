import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST2-T13 Rate card ขาขาย: เตรียมลูกค้า/สถานที่/เส้นทาง (API) → เพิ่ม rate จากหน้าจอ (บันทึกร่าง)
 * → อนุมัติ (เหตุผล) → คัดลอกเป็น rate ใหม่ช่วงวันทับ → 422 แจ้งรหัสที่ชน (เกณฑ์ตรวจรับ)
 * → แท็บ Rate card ใน drawer ลูกค้า + ปุ่มเปิดหน้า Rate card กรองลูกค้านี้ — ผ่าน API จริง (ฐาน tms_e2e)
 */
const RUN = String(Date.now()).slice(-6);
const CUST = `ลูกค้าราคาอีทูอี ${RUN}`;
const A = `ต้นทางราคา ${RUN}`;
const B = `ปลายทางราคา ${RUN}`;

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

async function pick(d: ReturnType<Page['getByRole']>, label: string, text: string) {
  const f = d.getByRole('combobox', { name: label, exact: true });
  await f.click();
  await f.fill(text);
  await d
    .getByRole('option', { name: new RegExp(text) })
    .first()
    .click();
}

const day = (n: number) =>
  new Date(Date.now() + 7 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);

test.describe.serial('ข้อมูลหลัก → Rate card', () => {
  test('เพิ่ม rate → อนุมัติ → คัดลอกช่วงวันทับถูกปฏิเสธ → แท็บ Rate card ของลูกค้า', async ({
    page,
  }) => {
    const H = { Authorization: `Bearer ${await token(page)}` };
    const post = async (path: string, data: object) => {
      const r = await page.request.post(path, { headers: H, data });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as { id: string };
    };
    await post('/v1/customers', { legalName: CUST });
    const o = await post('/v1/customer-sites', { name: A, kind: 'PICKUP', address: { line1: A } });
    const d = await post('/v1/customer-sites', { name: B, kind: 'DROPOFF', address: { line1: B } });
    await post('/v1/routes', { originId: o.id, destinationId: d.id, distanceKm: 95 });

    await page.goto('/master/rate-cards');
    await expect(page.getByRole('heading', { name: 'Rate card', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'เพิ่ม rate' }).click();
    const dr = page.getByRole('dialog');
    await dr.getByRole('button', { name: 'บันทึกร่าง' }).click();
    await expect(dr.getByText(/กรอกข้อมูลให้ครบ \d+ ช่อง/)).toBeVisible();
    await pick(dr, 'ลูกค้า', CUST);
    await pick(dr, 'เส้นทาง', RUN);
    await dr.getByLabel('ประเภทรถ').selectOption({ label: '6 ล้อ' });
    await dr.getByLabel('ราคา (฿ ต่อเที่ยว)').fill('6,500.123');
    await dr.getByLabel('มีผลตั้งแต่').fill(day(0));
    await dr.getByLabel('ถึง', { exact: true }).fill(day(60));
    await dr.getByRole('button', { name: 'บันทึกร่าง' }).click();
    await expect(dr.getByText('กรอกจำนวนเงิน ไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง')).toBeVisible();
    await dr.getByLabel('ราคา (฿ ต่อเที่ยว)').fill('6,500');
    await dr.getByRole('button', { name: 'บันทึกร่าง' }).click();
    await expect(page.getByRole('status')).toContainText(/เพิ่ม RC-S-\d+ แล้ว \(รออนุมัติ\)/);
    const code = (await dr.getByText(/^RC-S-\d+$/).textContent())!;
    await expect(dr.getByText('รออนุมัติ').first()).toBeVisible();

    // อนุมัติ (เหตุผล ≥ 10 + audit)
    await dr.getByRole('button', { name: 'อนุมัติ' }).click();
    const dlg = page.getByRole('dialog', { name: new RegExp(`อนุมัติ ${code}`) });
    await dlg.getByRole('textbox').fill('อนุมัติตามใบเสนอราคาทดสอบ');
    await dlg.getByRole('button', { name: 'อนุมัติ' }).click();
    await expect(page.getByRole('status')).toContainText(`อนุมัติ ${code} แล้ว`);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('มีผล').first()).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'ส่งขออนุมัติ' })).toBeDisabled();

    // เกณฑ์ตรวจรับ: คัดลอกเป็น rate ใหม่ช่วงวันทับ key เดิม → 422 แจ้งรหัสที่ชน
    await drawer.getByRole('button', { name: 'คัดลอกเป็น rate ใหม่' }).click();
    const cp = page.getByRole('dialog');
    await expect(cp.getByText('rate ใหม่', { exact: true })).toBeVisible();
    await expect(cp.getByLabel('มีผลตั้งแต่')).toHaveValue(day(61));
    await cp.getByLabel('มีผลตั้งแต่').fill(day(30));
    await cp.getByRole('button', { name: 'บันทึกร่าง' }).click();
    await expect(cp.getByText(`ช่วงวันทับกับ ${code}`, { exact: false })).toBeVisible();
    await page.keyboard.press('Escape');

    // ตาราง: แถว rate ที่อนุมัติ (ราคา + ป้าย)
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(CUST);
    const row = page.locator('tbody tr').filter({ hasText: CUST }).first();
    await expect(row).toContainText('6,500.00');
    await expect(row).toContainText('มีผล');

    // แท็บ Rate card ใน drawer ลูกค้า → ปุ่มเปิดหน้า Rate card กรองลูกค้านี้
    await page.goto('/master/customers');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').nth(1).fill(CUST);
    await page.locator('tbody tr').filter({ hasText: CUST }).first().click();
    const cd = page.getByRole('dialog');
    await cd.getByRole('tab', { name: 'Rate card' }).click();
    await expect(cd.getByText('Rate ขาขายของลูกค้านี้')).toBeVisible();
    await expect(cd.getByText('6,500.00 / เที่ยว')).toBeVisible();
    await cd.getByRole('button', { name: 'เปิดหน้า Rate card กรองลูกค้านี้' }).click();
    await expect(page).toHaveURL(/\/master\/rate-cards$/);
    await expect(page.getByRole('columnheader').getByPlaceholder('ค้นหา').first()).toHaveValue(
      CUST,
    );
    await expect(page.locator('tbody tr')).toHaveCount(1);
  });
});
