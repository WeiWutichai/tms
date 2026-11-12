import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST2-T14 Rate card ขาซื้อ: เตรียมผู้รับเหมา/สถานที่/เส้นทาง (API) → หน้า "คนขับและผู้รับเหมา" เมนูแถว "ดู rate ขาซื้อ"
 * → หน้า Rate card ฝั่ง "ขาซื้อ · รถร่วม" กรองผู้รับเหมานี้ → เพิ่ม rate (บันทึกร่าง RC-B-…) → อนุมัติ (เหตุผล)
 * → คัดลอกช่วงวันทับ → 422 แจ้งรหัสที่ชน (ตัวตรวจชุดเดียวกับขาขาย) → ฝั่งขาขายไม่มีแถวนี้
 * → drawer ผู้รับเหมา "ราคา 5 ครั้งล่าสุด" = "—" (ยังไม่เคยจ้าง — endpoint คืนรายการว่าง) — ผ่าน API จริง (ฐาน tms_e2e)
 */
const RUN = String(Date.now()).slice(-6);
const CAR = `หจก. รถร่วมอีทูอี ${RUN}`;
const A = `ต้นทางซื้อ ${RUN}`;
const B = `ปลายทางซื้อ ${RUN}`;

/** เลขนิติบุคคล (checksum ถูก) — ข้อมูลสมมติ */
function jurTax(n: number): string {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

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

test.describe.serial('ข้อมูลหลัก → Rate card ขาซื้อ', () => {
  test('ดู rate ขาซื้อจากผู้รับเหมา → เพิ่ม → อนุมัติ → ช่วงวันทับถูกปฏิเสธ → ราคา 5 ครั้งล่าสุดว่าง', async ({
    page,
  }) => {
    const H = { Authorization: `Bearer ${await token(page)}` };
    const post = async (path: string, data: object) => {
      const r = await page.request.post(path, { headers: H, data });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as { id: string };
    };
    await post('/v1/carriers', {
      legalName: CAR,
      entityType: 'JURISTIC',
      taxId: jurTax(Number(RUN)),
    });
    const o = await post('/v1/customer-sites', { name: A, kind: 'PICKUP', address: { line1: A } });
    const d = await post('/v1/customer-sites', { name: B, kind: 'DROPOFF', address: { line1: B } });
    await post('/v1/routes', { originId: o.id, destinationId: d.id, distanceKm: 120 });

    // เมนูแถวผู้รับเหมา "ดู rate ขาซื้อ" (ต้นแบบ :3735)
    await page.goto('/fleet/drivers?tab=con');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(CAR);
    const crow = page.locator('tbody tr').filter({ hasText: CAR }).first();
    await crow.getByRole('button', { name: 'การกระทำ' }).click();
    await page.getByRole('menuitem', { name: 'ดู rate ขาซื้อ' }).click();
    await expect(page).toHaveURL(/\/master\/rate-cards$/);
    await expect(page.getByRole('tab', { name: /ขาซื้อ · รถร่วม/, selected: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /ผู้รับเหมา/ })).toBeVisible();
    await expect(page.getByRole('columnheader').getByPlaceholder('ค้นหา').first()).toHaveValue(CAR);
    await expect(page.locator('tbody tr')).toHaveCount(0);

    // เพิ่ม rate ขาซื้อ
    await page.getByRole('button', { name: 'เพิ่ม rate' }).click();
    const dr = page.getByRole('dialog');
    await expect(dr.getByText('Rate ขาซื้อ · รถร่วม')).toBeVisible();
    await pick(dr, 'ผู้รับเหมา', CAR);
    await pick(dr, 'เส้นทาง', RUN);
    await dr.getByLabel('ประเภทรถ').selectOption({ label: '6 ล้อ' });
    await dr.getByLabel('ราคา (฿ ต่อเที่ยว)').fill('5,200');
    await dr.getByLabel('มีผลตั้งแต่').fill(day(0));
    await dr.getByLabel('ถึง', { exact: true }).fill(day(60));
    await dr.getByRole('button', { name: 'บันทึกร่าง' }).click();
    await expect(page.getByRole('status')).toContainText(/เพิ่ม RC-B-\d+ แล้ว \(รออนุมัติ\)/);
    const code = (await dr.getByText(/^RC-B-\d+$/).textContent())!;

    await dr.getByRole('button', { name: 'อนุมัติ' }).click();
    const dlg = page.getByRole('dialog', { name: new RegExp(`อนุมัติ ${code}`) });
    await dlg.getByRole('textbox').fill('อนุมัติตามราคาที่ตกลงกับรถร่วม');
    await dlg.getByRole('button', { name: 'อนุมัติ' }).click();
    await expect(page.getByRole('status')).toContainText(`อนุมัติ ${code} แล้ว`);

    // ตัวตรวจชุดเดียวกับขาขาย: ช่วงวันทับ key เดิม → 422
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: 'คัดลอกเป็น rate ใหม่' }).click();
    const cp = page.getByRole('dialog');
    await cp.getByLabel('มีผลตั้งแต่').fill(day(30));
    await cp.getByRole('button', { name: 'บันทึกร่าง' }).click();
    await expect(cp.getByText(`ช่วงวันทับกับ ${code} (ผู้รับเหมา`, { exact: false })).toBeVisible();
    await page.keyboard.press('Escape');

    const row = page.locator('tbody tr').filter({ hasText: CAR }).first();
    await expect(row).toContainText('5,200.00');
    await expect(row).toContainText('มีผล');
    // ฝั่งขาขายไม่มีแถวของผู้รับเหมา
    await page.getByRole('tab', { name: /ขาขาย · ลูกค้า/ }).click();
    await expect(page.getByRole('columnheader', { name: /ลูกค้า/ })).toBeVisible();
    await expect(page.locator('tbody tr').filter({ hasText: CAR })).toHaveCount(0);

    // drawer ผู้รับเหมา: ราคา 5 ครั้งล่าสุด = "—" (ยังไม่เคยจ้าง)
    const recent = page.waitForResponse((r) => /\/recent-prices$/.test(r.url()));
    await page.goto('/fleet/drivers?tab=con');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(CAR);
    await page.locator('tbody tr').filter({ hasText: CAR }).first().click();
    const res = await recent;
    expect(await res.json()).toEqual({ data: [] });
    const cd = page.getByRole('dialog');
    await expect(
      cd.locator('.tms-kv__item').filter({ hasText: 'ราคา 5 ครั้งล่าสุด' }),
    ).toContainText('—');
  });
});
