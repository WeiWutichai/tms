import { DEMO_PASSWORD, DEMO_TOTP_SECRET, expect, test, totp } from './fixtures';

/** ST1-T05: role ที่บังคับ 2FA ต้องกรอกรหัสจากแอปหลังรหัสผ่าน */
test.describe('ยืนยันตัวตน 2 ชั้น', () => {
  test.use({ loginEmail: 'planner@demo-a.test' });

  test('admin: รหัสผ่าน → หน้า 2FA → รหัสผิดเตือน → รหัสถูกเข้าระบบ', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('อีเมล').fill('admin@demo-a.test');
    await page.getByLabel('รหัสผ่าน').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByRole('heading', { name: 'ยืนยันตัวตน 2 ชั้น' })).toBeVisible();
    await page.getByLabel('รหัส 6 หลัก').fill('000000');
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByRole('alert')).toHaveText('รหัสยืนยันไม่ถูกต้องหรือหมดอายุ');
    await page.getByLabel('รหัส 6 หลัก').fill(totp(DEMO_TOTP_SECRET, 1));
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByText('ผู้ดูแล ตัวอย่าง')).toBeVisible();
  });
});
