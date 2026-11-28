import { expect, test } from './fixtures';

/**
 * ST1-T18 / spec/01 PLT-076: ฟีเจอร์นอกแพ็กเกจแสดงเมนูพร้อม 🔒 (ไม่ซ่อน) และเปิดเป็นหน้า "ไม่รวมในแพ็กเกจ"
 * P1-ST1-T01 (plan/13 R-07 + docs/02 §2): จ่ายงานรถร่วม/settlement/รายงานพื้นฐานมีใน Starter แล้ว —
 * ใช้ "นักพัฒนา / Open API" (docs/02 §2: Open API เริ่มที่ Growth) เป็นเมนูที่ล็อก
 */
test.describe('แพ็กเกจ Starter (demo-b)', () => {
  test.use({ loginEmail: 'owner@demo-b.test' });

  test('Open API มี 🔒 และเปิดเป็นหน้าไม่รวมในแพ็กเกจ · รถร่วม/รายงานไม่มี 🔒', async ({
    page,
  }) => {
    await page.goto('/settings/api');
    await expect(page.getByText('ไม่รวมในแพ็กเกจ Starter')).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'นักพัฒนา / Open API' }),
    ).toBeVisible();
    await expect(page.getByText('Growth', { exact: true })).toBeVisible();
    const item = page.getByRole('button', { name: 'นักพัฒนา / Open API' });
    await expect(item.getByLabel('ไม่รวมในแพ็กเกจ')).toBeVisible();
    // ฟีเจอร์ที่มีในแพ็กเกจ (รวมฟีเจอร์พื้นฐาน R-07 และรายงานพื้นฐาน docs/02 §2) ไม่มี 🔒
    for (const name of ['ใบสั่งขนส่ง (SO)', 'จ่ายงานรถร่วม', 'รายงาน'])
      await expect(page.getByRole('button', { name }).getByLabel('ไม่รวมในแพ็กเกจ')).toHaveCount(0);
    // P1-ST1-T02 ต้นแบบ v4 `lkp`: ราคา/รถ/เดือนของแพ็กเกจที่มี + ปุ่ม "อัปเกรดเป็น…" (owner = จัดการแพ็กเกจได้) + "เทียบแพ็กเกจ"
    await expect(page.getByText(/^฿[\d,]+ \/ รถ \/ เดือน$/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'เทียบแพ็กเกจ' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'แจ้งผู้ดูแลระบบ' })).toHaveCount(0);
    await page.getByRole('button', { name: 'อัปเกรดเป็น Growth' }).click();
    await expect(page).toHaveURL(/\/settings\/billing\?plan=std$/);
    await expect(page.getByText('หน้านี้จะเปิดใช้ใน P1-ST3 ตามแผนพัฒนาเฟส 1')).toBeVisible();
  });
});
