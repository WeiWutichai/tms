import { expect, test } from './fixtures';

/**
 * E2E ST2-T10 สินค้าและหน่วย: หน่วยเริ่มต้นจาก bootstrap → เพิ่มสินค้าควบคุมอุณหภูมิ (ตรวจช่วง) → รหัสซ้ำแจ้ง "รหัสนี้มีแล้ว"
 * → แก้ไข (เพิ่มหน่วยแปลง) → ปิดใช้ (เหตุผล) → จัดการหน่วย: เพิ่มหน่วยใหม่ — ผ่าน API จริง (ฐาน tms_e2e)
 */
const RUN = String(Date.now()).slice(-6);
const NAME = `นมพาสเจอร์ไรส์อีทูอี ${RUN}`;
const CODE = `E2E-${RUN}`;

test.describe.serial('ข้อมูลหลัก → สินค้าและหน่วย', () => {
  test('เพิ่มสินค้าควบคุมอุณหภูมิ → รหัสซ้ำ → แก้ไขหน่วยแปลง → ปิดใช้', async ({ page }) => {
    await page.goto('/master/products');
    await expect(page.getByRole('heading', { name: 'สินค้าและหน่วย', level: 1 })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'ประเภทพิเศษ' })).toBeVisible();
    await page.getByRole('button', { name: 'เพิ่มสินค้า' }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByLabel('รหัสสินค้า')).toHaveValue(/^P-\d{4}$/);
    await d.getByRole('button', { name: 'เพิ่มสินค้า' }).click();
    await expect(d.getByText('กรุณากรอกชื่อสินค้า')).toBeVisible();
    await expect(d.getByRole('alert')).toContainText('กรอกข้อมูลให้ครบ 2 ช่อง');
    await d.getByLabel('รหัสสินค้า').fill(CODE);
    await d.getByRole('combobox', { name: /^หน่วย/ }).selectOption({ label: 'กล่อง' });
    await d.getByLabel('ชื่อสินค้า').fill(NAME);
    await d.getByLabel('น้ำหนักต่อหน่วย (กก.)').fill('12.5');
    await d.getByLabel('ปริมาตรต่อหน่วย (ลบ.ม.)').fill('0.03');
    await d.getByLabel('ควบคุมอุณหภูมิ').check();
    await d.getByLabel('อุณหภูมิต่ำสุด (°C)').fill('8');
    await d.getByLabel('อุณหภูมิสูงสุด (°C)').fill('2');
    await d.getByRole('button', { name: 'เพิ่มสินค้า' }).click();
    await expect(d.getByText('ต่ำสุดต้องน้อยกว่าสูงสุด')).toBeVisible();
    await d.getByLabel('อุณหภูมิต่ำสุด (°C)').fill('2');
    await d.getByLabel('อุณหภูมิสูงสุด (°C)').fill('8');
    await d.getByRole('button', { name: 'เพิ่มสินค้า' }).click();
    await expect(page.getByRole('status')).toContainText(`เพิ่ม ${NAME} แล้ว`);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('2–8 °C')).toBeVisible();
    await expect(drawer.getByText('12.5 กก.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    // รหัสซ้ำ (ตัวพิมพ์ต่าง) → "รหัสนี้มีแล้ว"
    await page.getByRole('button', { name: 'เพิ่มสินค้า' }).click();
    const d2 = page.getByRole('dialog');
    await d2.getByLabel('รหัสสินค้า').fill(CODE.toLowerCase());
    await d2.getByLabel('ชื่อสินค้า').fill('ซ้ำ');
    await d2.getByLabel('น้ำหนักต่อหน่วย (กก.)').fill('1');
    await d2.getByRole('button', { name: 'เพิ่มสินค้า' }).click();
    await expect(d2.getByText('รหัสนี้มีแล้ว')).toBeVisible();
    await d2.getByRole('button', { name: 'ยกเลิก' }).click();

    // แก้ไขจาก drawer: เพิ่มหน่วยแปลง 1 พาเลท = 40 กล่อง
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(RUN);
    await page.getByText(NAME, { exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'เพิ่มเติม' }).click();
    await page.getByRole('menuitem', { name: 'แก้ไข' }).click();
    const ed = page.getByRole('dialog', { name: /แก้ไขสินค้า/ });
    await ed.getByRole('button', { name: 'เพิ่มหน่วยแปลง' }).click();
    await ed.getByLabel('เลือกหน่วย').selectOption({ label: 'พาเลท' });
    await ed.getByLabel('= หน่วยหลัก').fill('40');
    await ed.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`บันทึก ${NAME} แล้ว`);
    await expect(page.getByRole('dialog').getByText('1 พาเลท = 40 กล่อง')).toBeVisible();

    // ปิดใช้ (เหตุผล ≥ 10) จากเมนู ⋯ ของแถว
    await page.keyboard.press('Escape');
    const row = page.locator('tbody tr', { hasText: NAME });
    await row.getByRole('button', { name: 'การกระทำ' }).click();
    await page.getByRole('menuitem', { name: 'ปิดใช้' }).click();
    const dlg = page.getByRole('dialog', { name: /ปิดใช้/ });
    await dlg.getByLabel('เหตุผล').fill('ทดสอบปิดใช้สินค้า');
    await dlg.getByRole('button', { name: 'ปิดใช้' }).click();
    await expect(page.getByRole('status')).toContainText(`เปลี่ยนสถานะ ${NAME} แล้ว`);
    await expect(page.locator('tbody tr', { hasText: NAME })).toContainText('ปิดใช้');
  });

  test('จัดการหน่วย: หน่วยเริ่มต้นพร้อมใช้ → เพิ่มหน่วยน้ำหนักใหม่', async ({ page }) => {
    await page.goto('/master/products');
    await page.getByRole('button', { name: 'จัดการหน่วย' }).click();
    const u = page.getByRole('dialog');
    for (const n of ['BAG', 'PLT', 'TON', 'L'])
      await expect(u.getByText(n, { exact: true })).toBeVisible();
    await expect(u.getByText('1 ตัน = 1,000 กก.')).toBeVisible();
    await u.getByRole('button', { name: 'เพิ่มหน่วย' }).click();
    const f = page.getByRole('dialog', { name: /เพิ่มหน่วย/ });
    await f.getByLabel('รหัสหน่วย').fill(`Q${RUN}`);
    await f.getByLabel('ชื่อหน่วย').fill(`ควินทัล ${RUN}`);
    await f.getByLabel('ชนิด').selectOption({ label: 'น้ำหนัก' });
    await f.getByLabel('1 หน่วย = ? กก.').fill('100');
    await f.getByRole('button', { name: 'เพิ่มหน่วย' }).click();
    await expect(page.getByRole('status')).toContainText(`เพิ่มหน่วย ควินทัล ${RUN} แล้ว`);
    await expect(page.getByText(`1 ควินทัล ${RUN} = 100 กก.`)).toBeVisible();
  });
});
