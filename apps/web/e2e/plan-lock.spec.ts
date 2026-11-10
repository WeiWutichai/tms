import { expect, test } from './fixtures';

/** ST1-T18 / spec/01 PLT-076: ฟีเจอร์นอกแพ็กเกจแสดงเมนูพร้อม 🔒 (ไม่ซ่อน) และเปิดเป็นหน้า "ไม่รวมในแพ็กเกจ" */
test.describe('แพ็กเกจเริ่มต้น (demo-b)', () => {
  test.use({ loginEmail: 'owner@demo-b.test' });

  test('เมนูจ่ายงานรถร่วมมี 🔒 และเปิดเป็นหน้าไม่รวมในแพ็กเกจ', async ({ page }) => {
    await page.goto('/');
    const item = page.getByRole('button', { name: 'จ่ายงานรถร่วม' });
    await expect(item).toBeVisible();
    await expect(item.getByLabel('locked')).toBeVisible();
    await item.click();
    await expect(page.getByText('ไม่รวมในแพ็กเกจเริ่มต้น')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'จ่ายงานรถร่วม' })).toBeVisible();
    await expect(page.getByText('มาตรฐาน', { exact: true })).toBeVisible();
    // ฟีเจอร์ที่มีในแพ็กเกจไม่มี 🔒
    await expect(
      page.getByRole('button', { name: 'ใบสั่งขนส่ง (SO)' }).getByLabel('locked'),
    ).toHaveCount(0);
  });
});
