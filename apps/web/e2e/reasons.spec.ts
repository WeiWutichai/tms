import { expect, test } from './fixtures';

/**
 * E2E ST2-T12 ตั้งค่า → เหตุผล: tenant เดโมมีชุดไทยครบทุกหมวดจาก bootstrap → ติ๊กธงในตาราง + "บันทึก" ลอย
 * → โหลดใหม่ค่ายังอยู่ → เพิ่มเหตุผล (ฟอร์มว่างแจ้ง) → ลบเหตุผลที่สร้าง (เหตุผล ≥ 10) · รหัสระบบไม่มีปุ่มลบ — ผ่าน API จริง
 */
const RUN = String(Date.now()).slice(-6);
const LABEL = `ด่านตรวจอีทูอี ${RUN}`;

test.describe.serial('ตั้งค่า → เหตุผล', () => {
  test('ชุดเริ่มต้นครบทุกหมวด + ติ๊กธงแล้วบันทึก', async ({ page }) => {
    await page.goto('/settings?sec=reason');
    await expect(page.getByRole('heading', { name: 'เหตุผล (reason master)' })).toBeVisible();
    for (const h of ['หมวด', 'บังคับรูป', 'บังคับโน้ต', 'นัดส่งใหม่อัตโนมัติ', 'แสดงบน tracking'])
      await expect(page.getByRole('columnheader', { name: h })).toBeVisible();
    for (const c of ['ตีกลับ', 'ส่งไม่สำเร็จ', 'ยกเลิก', 'ไม่เซ็นเอกสาร', 'ล่าช้า', 'ค้างวางแผน'])
      await expect(page.getByText(c, { exact: true }).first()).toBeVisible();
    // นัดส่งใหม่ใช้ได้เฉพาะส่งไม่สำเร็จ · "อื่น ๆ" ปิดบังคับโน้ตไม่ได้
    await expect(page.getByLabel('นัดส่งใหม่อัตโนมัติ — การจราจรติดขัด')).toBeDisabled();

    const box = page.getByLabel('บังคับรูป — ลูกค้าปิดทำการ');
    const before = await box.isChecked();
    await box.click();
    await page.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText('บันทึกการตั้งค่าเหตุผลแล้ว');
    await page.reload();
    await expect(page.getByLabel('บังคับรูป — ลูกค้าปิดทำการ')).toBeChecked({ checked: !before });
  });

  test('เพิ่มเหตุผล → แก้ไข → ลบ; รหัสระบบไม่มีปุ่มลบ', async ({ page }) => {
    await page.goto('/settings?sec=reason');
    await page.getByRole('button', { name: 'เพิ่มเหตุผล' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'เพิ่มเหตุผล' }).click();
    await expect(d.getByText('กรุณากรอกเหตุผล')).toBeVisible();
    await d.getByRole('combobox').selectOption('DELAY');
    await d.getByRole('textbox', { name: /^เหตุผล/ }).fill(LABEL);
    await d.getByRole('button', { name: 'เพิ่มเหตุผล' }).click();
    await expect(page.getByText(`เพิ่มเหตุผล "${LABEL}" แล้ว`)).toBeVisible();
    await expect(page.getByRole('button', { name: LABEL })).toBeVisible();

    await page.getByRole('button', { name: LABEL }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'ลบ' }).click();
    const dlg = page.getByRole('dialog').last();
    await dlg.getByRole('textbox').fill('ทดสอบลบเหตุผลอีทูอี');
    await dlg.getByRole('button', { name: 'ลบ' }).click();
    await expect(page.getByText(`ลบเหตุผล "${LABEL}" แล้ว`)).toBeVisible();
    await expect(page.getByRole('button', { name: LABEL })).toHaveCount(0);

    await page.getByRole('button', { name: 'ยังไม่ได้จับคู่ลูกค้า' }).click();
    const sys = page.getByRole('dialog');
    await expect(sys.getByText(/รหัสของระบบ/)).toBeVisible();
    await expect(sys.getByRole('button', { name: 'ลบ' })).toHaveCount(0);
    await expect(sys.getByRole('combobox')).toBeDisabled();
  });
});

test.describe('ตั้งค่า → เหตุผล (planner แก้ได้)', () => {
  test.use({ loginEmail: 'planner@demo-a.test' });
  test('planner เข้าเมนูตั้งค่าได้ เห็นเฉพาะ "เหตุผล" และบันทึกธงได้', async ({ page }) => {
    await page.goto('/');
    // เมนู "ตั้งค่า" ใน sidebar แสดงแล้ว (กลุ่มยุบอยู่ — กดขยายก่อน)
    await page.getByRole('button', { name: 'ตั้งค่า', exact: true }).click();
    await page.getByRole('button', { name: 'ตั้งค่าระบบ' }).click();
    await expect(page.getByRole('navigation', { name: 'ตั้งค่า' }).getByRole('button')).toHaveText([
      'เหตุผล',
    ]);
    const box = page.getByLabel('บังคับโน้ต — สร้างซ้ำ');
    const before = await box.isChecked();
    await box.click();
    await page.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText('บันทึกการตั้งค่าเหตุผลแล้ว');
    await page.reload();
    await expect(page.getByLabel('บังคับโน้ต — สร้างซ้ำ')).toBeChecked({ checked: !before });
  });
});

test.describe('ตั้งค่า → เหตุผล (dispatcher อ่านอย่างเดียว)', () => {
  test.use({ loginEmail: 'dispatcher@demo-a.test' });
  test('dispatcher เห็นตารางแต่แก้ไม่ได้', async ({ page }) => {
    await page.goto('/settings?sec=reason');
    await expect(page.getByRole('heading', { name: 'เหตุผล (reason master)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'เพิ่มเหตุผล' })).toHaveCount(0);
    await expect(page.getByLabel('บังคับรูป — ไม่พบผู้รับ')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'ไม่พบผู้รับ' })).toHaveCount(0);
  });
});
