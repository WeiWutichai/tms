import { expect, test } from './fixtures';

/** E2E ST0: shell ตามต้นแบบ + routing + ภาษา (เส้นทางหลักตาม plan/03 §3 จะเพิ่มทีละ stage) */
test.describe('shell', () => {
  test('แสดง tenant จาก /v1/me, เมนูเฟส 0 และหัวหน้า/breadcrumb ตาม META ต้นแบบ', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByText('ตัวอย่างขนส่ง (DEMO)')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'ภาพรวม' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText('หลัก');
    // เมนูที่อยู่นอกเฟส 0 ต้องไม่มี
    await expect(page.getByRole('button', { name: 'ติดตามรถ', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ใบสั่งขนส่ง (SO)', exact: true })).toBeVisible();
  });

  test('หน้าที่ยังไม่ถึง stage บอก stage และกลับภาพรวมได้', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'ใบสั่งขนส่ง (SO)', exact: true }).click();
    await expect(page).toHaveURL(/\/so$/);
    await expect(page.getByRole('heading', { level: 1, name: 'ใบสั่งขนส่ง (SO)' })).toBeVisible();
    await expect(page.getByText(/ST3/)).toBeVisible();
    await page.getByRole('button', { name: 'กลับไปภาพรวม' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('URL ที่ไม่มี → หน้าไม่พบ', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.getByText('ไม่พบหน้านี้')).toBeVisible();
  });

  test('สลับภาษาเป็น EN แล้วยังคงอยู่หลังโหลดใหม่', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Planning board', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Planning board', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'TH', exact: true }).click();
    await expect(page.getByRole('button', { name: 'กระดานวางแผน', exact: true })).toBeVisible();
  });

  test('ST1-T09: ภาษาเก็บในโปรไฟล์ — เปิดเครื่องใหม่ (ไม่มี localStorage) ก็ได้ภาษาเดิม', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Planning board', exact: true })).toBeVisible();
    await page.waitForResponse(
      (r) => r.url().includes('/v1/me/profile') && r.request().method() === 'PATCH',
    );
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole('button', { name: 'Planning board', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'TH', exact: true }).click();
    await expect(page.getByRole('button', { name: 'กระดานวางแผน', exact: true })).toBeVisible();
  });

  test('ย่อ/ขยาย sidebar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'ย่อเมนู' }).click();
    await expect(page.getByText('ตัวอย่างขนส่ง (DEMO)')).toHaveCount(0);
    await page.getByRole('button', { name: 'ย่อ / ขยายเมนู' }).click();
    await expect(page.getByText('ตัวอย่างขนส่ง (DEMO)')).toBeVisible();
  });
});
