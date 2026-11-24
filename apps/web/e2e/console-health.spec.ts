import { expect, test, type Page } from '@playwright/test';
import { DEMO_PASSWORD, freshCode } from './fixtures';

/**
 * #96 Platform Console → Connector ระบบบัญชี → แท็บ "สุขภาพการเชื่อมต่อ" (PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ)
 * #81 drawer ลูกค้า → ผู้ใช้: ป้าย 2FA ต่อคน · ปุ่มรีเซ็ต 2FA เฉพาะ SUPER_ADMIN (ไม่กดจริง — ผู้ใช้เดโมใช้ร่วมกับ spec อื่น;
 * การเรียก API ทดสอบใน unit test ของเว็บ + integration test ของ API)
 */
async function consoleLogin(page: Page, email: `${string}@platform.test`) {
  await page.goto('/console');
  await page.getByLabel('อีเมล').fill(email);
  await page.getByLabel('รหัสผ่าน').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.getByLabel('รหัส 6 หลัก').fill(await freshCode(email));
  await page.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(page).toHaveURL(/\/console\/tenants$/);
}

test('support: แท็บสุขภาพการเชื่อมต่อแสดงหัวตาราง · ไม่เห็นปุ่มรีเซ็ต 2FA', async ({ page }) => {
  await consoleLogin(page, 'support@platform.test');
  await page.locator('tbody tr', { hasText: 'ตัวอย่างขนส่ง (DEMO)' }).click();
  const drawer = page.getByRole('dialog', { name: 'ตัวอย่างขนส่ง (DEMO)' });
  await drawer.getByRole('tab', { name: 'ผู้ใช้' }).click();
  await expect(drawer.getByText('เปิด 2FA').first()).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'รีเซ็ต 2FA' })).toHaveCount(0);

  // token Console อยู่ในหน่วยความจำ (reload = login ใหม่) → ปิด drawer แล้วไปทางเมนู
  await page.keyboard.press('Escape');
  await page
    .getByRole('navigation', { name: 'เมนู Platform Console' })
    .getByRole('button', { name: 'Connector ระบบบัญชี' })
    .click();
  await page.getByRole('tab', { name: /สุขภาพการเชื่อมต่อ/ }).click();
  const tbl = page.getByRole('table', { name: 'สุขภาพการเชื่อมต่อ' });
  await expect(tbl.getByRole('columnheader', { name: 'ค้างนานสุด' })).toBeVisible();
  await expect(tbl.getByRole('columnheader', { name: 'ล้มเหลว 7 วัน' })).toBeVisible();
});

test('super admin: ปุ่มรีเซ็ต 2FA → dialog เหตุผล (ยกเลิก)', async ({ page }) => {
  await consoleLogin(page, 'super-admin@platform.test');
  await page.locator('tbody tr', { hasText: 'ตัวอย่างขนส่ง (DEMO)' }).click();
  const drawer = page.getByRole('dialog', { name: 'ตัวอย่างขนส่ง (DEMO)' });
  await drawer.getByRole('tab', { name: 'ผู้ใช้' }).click();
  await drawer.getByRole('button', { name: 'รีเซ็ต 2FA' }).first().click();
  const dlg = page.getByRole('dialog', { name: /^รีเซ็ต 2FA · / });
  await expect(dlg.getByText('ระบบส่งอีเมลแจ้งเจ้าของบัญชี')).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'รีเซ็ต 2FA' })).toBeDisabled();
  await dlg.getByRole('button', { name: 'ยกเลิก' }).click();
  await expect(dlg).toBeHidden();
});
