import { expect, test } from './fixtures';

/**
 * E2E ST2-T11 ค่าบริการเสริม: tenant เดโมมีชุดไทยจากค่าเริ่มต้น (bootstrap) → กรองแท็บ VAT 7%
 * → เพิ่มรายการ (ฟอร์มว่างแจ้ง, คู่ VAT × หัก ณ ที่จ่ายผิดแจ้งจาก API) → แก้ราคา → ปิดใช้ (เหตุผล)
 * → รหัสสงวน (ค่าขนส่ง) ไม่มีเมนูปิดใช้ — ผ่าน API จริง (ฐาน tms_e2e)
 */
const RUN = String(Date.now()).slice(-6);
const NAME = `ค่าแรงยกพิเศษอีทูอี ${RUN}`;

test.describe.serial('ข้อมูลหลัก → ค่าบริการเสริม', () => {
  test('เปิดหน้า → ค่าเริ่มต้นภาษาไทยพร้อมใช้ + แท็บ VAT 7%', async ({ page }) => {
    await page.goto('/master/accessorials');
    await expect(page.getByRole('heading', { name: 'ค่าบริการเสริม', level: 1 })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'หัก ณ ที่จ่าย' })).toBeVisible();
    for (const n of ['ค่าขนส่ง', 'ค่าขึ้นสินค้า', 'ค่าค้างคืน'])
      await expect(page.getByText(n, { exact: true })).toBeVisible();
    await expect(page.getByRole('row', { name: /ค่าผ่านทาง \(ตามจริง\)/ })).toContainText(
      'ตามใบเสร็จ',
    );
    await page.getByRole('tab', { name: /VAT 7%/ }).click();
    await expect(page.getByText('ค่าขึ้นสินค้า', { exact: true })).toBeVisible();
    await expect(page.getByText('ค่าค้างคืน', { exact: true })).toHaveCount(0);
  });

  test('เพิ่ม → คู่ภาษีผิดถูกแจ้ง → แก้ราคา → ปิดใช้; รหัสสงวนไม่มีเมนูปิดใช้', async ({
    page,
  }) => {
    await page.goto('/master/accessorials');
    await page.getByRole('button', { name: 'เพิ่มค่าบริการ' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'เพิ่มค่าบริการ' }).click();
    await expect(d.getByText('กรุณากรอกชื่อรายการ')).toBeVisible();
    await expect(d.getByRole('alert')).toContainText('กรอกข้อมูลให้ครบ 2 ช่อง');
    await d.getByLabel('ชื่อรายการ').fill(NAME);
    await d.getByLabel('ราคา').fill('1,250.5');
    await d.getByLabel('เงื่อนไข').fill('เฉพาะสินค้าเกิน 50 กก.');
    await d.getByLabel('หัก ณ ที่จ่าย').selectOption('1.00'); // VAT 7% + 1% → API ปฏิเสธ
    await d.getByRole('button', { name: 'เพิ่มค่าบริการ' }).click();
    await expect(d.getByText(/VAT กับหัก ณ ที่จ่ายไม่เข้ากัน/)).toBeVisible();
    await d.getByLabel('หัก ณ ที่จ่าย').selectOption('3.00');
    await d.getByRole('button', { name: 'เพิ่มค่าบริการ' }).click();
    await expect(page.getByRole('status')).toContainText(`เพิ่ม ${NAME} แล้ว`);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('1,250.50 ฿')).toBeVisible();
    await expect(drawer.getByText('เฉพาะสินค้าเกิน 50 กก.')).toBeVisible();

    // แก้ราคาจาก drawer
    await drawer.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await page.getByRole('menuitem', { name: 'แก้ไข' }).click();
    const ed = page.getByRole('dialog', { name: /แก้ไขค่าบริการเสริม/ });
    await ed.getByLabel('ราคา').fill('1300');
    await ed.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`บันทึกข้อมูล ${NAME} แล้ว`);
    await expect(page.getByRole('dialog').getByText('1,300.00 ฿')).toBeVisible();
    await page.keyboard.press('Escape');

    // ปิดใช้จากเมนู ⋯ ของแถว
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(RUN);
    const row = page.locator('tbody tr', { hasText: NAME });
    await row.getByRole('button', { name: 'การกระทำ' }).click();
    await page.getByRole('menuitem', { name: 'ปิดใช้' }).click();
    const dlg = page.getByRole('dialog', { name: /ปิดใช้/ });
    await dlg.getByLabel('เหตุผล').fill('เลิกคิดค่าแรงยกพิเศษแล้ว');
    await dlg.getByRole('button', { name: 'ปิดใช้' }).click();
    await expect(page.getByRole('status')).toContainText(`อัปเดตสถานะ ${NAME} แล้ว`);
    await expect(row).toContainText('ปิดใช้');

    // รหัสสงวน (FREIGHT) — เมนูมีแค่ ดู/แก้ไข
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill('ค่าขนส่ง');
    const fr = page.locator('tbody tr', { hasText: 'ค่าขนส่ง' }).first();
    await fr.getByRole('button', { name: 'การกระทำ' }).click();
    await expect(page.getByRole('menuitem', { name: 'แก้ไข' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'ปิดใช้' })).toHaveCount(0);
  });
});
