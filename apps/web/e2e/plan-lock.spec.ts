import { expect, test } from './fixtures';

/**
 * ST1-T18 / spec/01 PLT-076: ฟีเจอร์นอกแพ็กเกจแสดงเมนูพร้อม 🔒 (ไม่ซ่อน) และเปิดเป็นหน้า "ไม่รวมในแพ็กเกจ"
 * P1-ST1-T01 (plan/13 R-07): จ่ายงานรถร่วม/settlement เป็นฟีเจอร์พื้นฐานแล้ว — ใช้เมนู "รายงาน" (Starter ไม่มี) แทน
 */
test.describe('แพ็กเกจ Starter (demo-b)', () => {
  test.use({ loginEmail: 'owner@demo-b.test' });

  test('เมนูรายงานมี 🔒 และเปิดเป็นหน้าไม่รวมในแพ็กเกจ · จ่ายงานรถร่วมไม่มี 🔒', async ({
    page,
  }) => {
    await page.goto('/');
    const item = page.getByRole('button', { name: 'รายงาน' });
    await expect(item).toBeVisible();
    await expect(item.getByLabel('ไม่รวมในแพ็กเกจ')).toBeVisible();
    await item.click();
    await expect(page.getByText('ไม่รวมในแพ็กเกจStarter')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'รายงาน' })).toBeVisible();
    await expect(page.getByText('Growth', { exact: true })).toBeVisible();
    // ฟีเจอร์ที่มีในแพ็กเกจ (รวมฟีเจอร์พื้นฐาน R-07) ไม่มี 🔒
    for (const name of ['ใบสั่งขนส่ง (SO)', 'จ่ายงานรถร่วม'])
      await expect(page.getByRole('button', { name }).getByLabel('ไม่รวมในแพ็กเกจ')).toHaveCount(0);
  });
});
