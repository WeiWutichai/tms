import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST2-T09 เส้นทาง + คลัง: สร้างคลัง/จุดส่ง (API) → เพิ่มเส้นทางจากหน้าจอ + "คำนวณจากพิกัด" + ค่าผ่านทาง
 * → สร้างคู่เดิมซ้ำถูกปฏิเสธ (เกณฑ์ตรวจรับ) → ปิดใช้ (เหตุผล) · คลังแสดงช่องโหลด — ผ่าน API จริง (ฐาน tms_e2e)
 */
const RUN = String(Date.now()).slice(-6);
const DEPOT = `คลังอีทูอี ${RUN}`;
const DROP = `จุดส่งเส้นทางอีทูอี ${RUN}`;

/** token สำหรับเตรียมข้อมูลผ่าน API (login ซ้ำในบริบทเดียวกัน — cookie ใหม่ยังใช้กับหน้าได้) */
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

async function pickSite(dlg: ReturnType<Page['getByRole']>, label: string, name: string) {
  const f = dlg.getByRole('combobox', { name: `${label} *`, exact: true });
  await f.click();
  await f.fill(name);
  await dlg.getByRole('option', { name: new RegExp(name) }).click();
}

test.describe.serial('ข้อมูลหลัก → เส้นทาง', () => {
  test('เพิ่มเส้นทาง + คำนวณจากพิกัด → OD ซ้ำถูกปฏิเสธ → ปิดใช้', async ({ page }) => {
    const H = { Authorization: `Bearer ${await token(page)}` };
    for (const [name, kind, lat, lng, dock] of [
      [DEPOT, 'WAREHOUSE', 13.6416, 100.6911, 8],
      [DROP, 'DROPOFF', 13.3611, 100.9847, null],
    ] as const) {
      const r = await page.request.post('/v1/customer-sites', {
        headers: H,
        data: { name, kind, address: { line1: name }, lat, lng, dockCount: dock },
      });
      expect(r.status(), await r.text()).toBe(201);
    }

    await page.goto('/master/routes');
    await expect(page.getByRole('heading', { name: 'เส้นทาง', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'เพิ่มเส้นทาง' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'เพิ่มเส้นทาง' }).click();
    await expect(d.getByRole('alert')).toContainText('กรอกข้อมูลให้ครบ 3 ช่อง');
    await expect(d.getByText('กรุณาเลือกต้นทาง')).toBeVisible();
    await pickSite(d, 'ต้นทาง', DEPOT);
    await pickSite(d, 'ปลายทาง', DROP);
    await d.getByRole('button', { name: 'คำนวณจากพิกัด' }).click();
    await expect(d.getByText(/คำนวณจากพิกัดแล้ว/)).toBeVisible();
    await expect(d.getByLabel('ระยะทาง (กม.)')).not.toHaveValue('');
    await d.getByLabel('ระยะทาง (กม.)').fill('95.5');
    await d.getByLabel('ค่าผ่านทาง (บาท)').fill('1.234');
    await d.getByRole('button', { name: 'เพิ่มเส้นทาง' }).click();
    await expect(d.getByText('กรอกจำนวนเงินไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง')).toBeVisible();
    await d.getByLabel('ค่าผ่านทาง (บาท)').fill('1250.5');
    await d.getByRole('button', { name: 'เพิ่มเส้นทาง' }).click();
    await expect(page.getByRole('status')).toContainText(/เพิ่มเส้นทาง RT-\d+ แล้ว/);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('1,250.50', { exact: true })).toBeVisible();
    await expect(drawer.getByText('95.5 กม.', { exact: true })).toBeVisible();
    const code = (await drawer.getByText(/^RT-\d+$/).textContent())!;
    await page.keyboard.press('Escape');

    // เกณฑ์ตรวจรับ: คู่เดิมซ้ำ → แจ้งรหัสเส้นทางเดิม
    await page.getByRole('button', { name: 'เพิ่มเส้นทาง' }).click();
    const d2 = page.getByRole('dialog');
    await pickSite(d2, 'ต้นทาง', DEPOT);
    await pickSite(d2, 'ปลายทาง', DROP);
    await d2.getByLabel('ระยะทาง (กม.)').fill('90');
    await d2.getByRole('button', { name: 'เพิ่มเส้นทาง' }).click();
    await expect(d2.getByText(`มีเส้นทางนี้แล้ว: ${code}`)).toBeVisible();
    await d2.getByRole('button', { name: 'ยกเลิก' }).click();

    // ค้นด้วยชื่อจุด → ปิดใช้ (เหตุผล ≥ 10)
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(RUN);
    const row = page.getByRole('row', { name: new RegExp(code) });
    await expect(row).toBeVisible();
    await row.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: 'ปิดใช้' }).click();
    const dlg = page.getByRole('dialog', { name: /ปิดใช้เส้นทาง/ });
    await dlg.getByRole('textbox').fill('เลิกวิ่งเส้นทางนี้ทดสอบ');
    await dlg.getByRole('button', { name: 'ปิดใช้' }).click();
    await expect(page.getByRole('row', { name: new RegExp(code) })).toContainText('ปิดใช้');

    // สร้างคู่เดิมซ้ำขณะเส้นทางเดิมปิดใช้ → บอกว่าปิดใช้อยู่ + ปุ่ม "เปิดใช้เส้นทางเดิม"
    await page.getByRole('button', { name: 'เพิ่มเส้นทาง' }).click();
    const d3 = page.getByRole('dialog');
    await pickSite(d3, 'ต้นทาง', DEPOT);
    await pickSite(d3, 'ปลายทาง', DROP);
    await d3.getByLabel('ระยะทาง (กม.)').fill('90');
    await d3.getByRole('button', { name: 'เพิ่มเส้นทาง' }).click();
    await expect(d3.getByText(`มีเส้นทางนี้แล้วแต่ปิดใช้อยู่: ${code}`)).toBeVisible();
    await d3.getByRole('button', { name: 'เปิดใช้เส้นทางเดิม' }).click();
    await expect(page.getByRole('status')).toContainText(`เปิดใช้เส้นทาง ${code} แล้ว`);
    await expect(page.getByRole('row', { name: new RegExp(code) })).toContainText('ใช้งาน');
  });

  test('คลัง: สถานที่ชนิดคลังแสดงช่องโหลด', async ({ page }) => {
    await page.goto('/master/locations');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(DEPOT);
    await page.locator('tbody tr').filter({ hasText: DEPOT }).first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('ช่องโหลด')).toBeVisible();
    await expect(drawer.getByText('8', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    // ปิดใช้จุดส่งที่มีเส้นทางใช้อยู่ → ปิดได้ + toast บอกจำนวนเส้นทาง
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(DROP);
    const row = page.locator('tbody tr').filter({ hasText: DROP }).first();
    await row.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: 'ปิดใช้' }).click();
    const dlg = page.getByRole('dialog', { name: /ปิดใช้/ });
    await dlg.getByRole('textbox').fill('ปิดจุดส่งทดสอบเส้นทาง');
    await dlg.getByRole('button', { name: 'ปิดใช้' }).click();
    await expect(page.getByRole('status')).toContainText('มีเส้นทางใช้อยู่ 1 เส้น');
  });
});
