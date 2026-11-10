import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD } from './fixtures';

/** role ที่ไม่บังคับ 2FA — ขั้น 2FA ทดสอบใน mfa.spec.ts */
const DEMO_EMAIL = 'planner@demo-a.test';

/** E2E ST1-T01/T04: หน้า login ตามต้นแบบ (TMS Signup #login) + session จริง */
test.describe('เข้าสู่ระบบ', () => {
  test('ยังไม่ login → พาไปหน้า login พร้อม next แล้วกลับหน้าเดิมหลัง login', async ({ page }) => {
    await page.goto('/design-system');
    await expect(page).toHaveURL(/\/login\?next=%2Fdesign-system$/);
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible();
    await page.getByLabel('อีเมล').fill(DEMO_EMAIL);
    await page.getByLabel('รหัสผ่าน').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page).toHaveURL(/\/design-system$/);
    // reload แล้วยังอยู่ในระบบ (refresh cookie httpOnly)
    await page.reload();
    await expect(page.getByText('วางแผน ตัวอย่าง')).toBeVisible();
  });

  test('รหัสผิด → ข้อความตามต้นแบบ; กรอกไม่ครบ → เตือน', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByRole('alert')).toHaveText('กรอกอีเมลและรหัสผ่าน');
    await page.getByLabel('อีเมล').fill(DEMO_EMAIL);
    await page.getByLabel('รหัสผ่าน').fill('not-the-password');
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByRole('alert')).toHaveText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  });

  test('ออกจากระบบ → กลับหน้า login และ reload ไม่กลับเข้าระบบ', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('อีเมล').fill(DEMO_EMAIL);
    await page.getByLabel('รหัสผ่าน').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByText('วางแผน ตัวอย่าง')).toBeVisible();
    await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});
