import { expect, test } from './fixtures';

/**
 * E2E ST2-T04 ประเภทรถ: tenant เดโมมีประเภทรถไทยจากค่าเริ่มต้น (bootstrap) → เพิ่มประเภทห้องเย็น (ป้าย + อุณหภูมิ)
 * → ชื่อซ้ำแจ้ง "มีประเภทนี้แล้ว" → แก้ไข → ปิดใช้ (เหตุผล) — ผ่าน API จริง (ฐาน tms_e2e)
 */
const RUN = String(Date.now()).slice(-6);
const NAME = `10 ล้อ ห้องเย็นอีทูอี ${RUN}`;

test.describe.serial('ข้อมูลหลัก → ประเภทรถ', () => {
  test('เปิดหน้า → ค่าเริ่มต้นภาษาไทยพร้อมใช้ (เกณฑ์ตรวจรับ)', async ({ page }) => {
    await page.goto('/master/vehicle-types');
    await expect(page.getByRole('heading', { name: 'ประเภทรถ', level: 1 })).toBeVisible();
    await expect(page.getByText('Rate card ที่อ้างอิง')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'ใบขับขี่ขั้นต่ำ' })).toBeVisible();
    for (const n of ['4 ล้อ กระบะตู้ทึบ', '6 ล้อ', '10 ล้อ', 'หัวลาก + หางเทรลเลอร์'])
      await expect(page.getByRole('cell', { name: n, exact: true })).toBeVisible();
    // กรองใบขับขี่ ท.3 → พ่วง + หัวลาก
    await page.getByRole('columnheader').locator('select').first().selectOption('T3');
    await expect(page.getByRole('row', { name: /พ่วง \(10 ล้อ/ })).toBeVisible();
    await expect(page.getByRole('cell', { name: '6 ล้อ', exact: true })).toHaveCount(0);
  });

  test('เพิ่มประเภทห้องเย็น → ชื่อซ้ำถูกแจ้ง → แก้ไข → ปิดใช้', async ({ page }) => {
    await page.goto('/master/vehicle-types');
    await page.getByRole('button', { name: 'เพิ่มประเภทรถ' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'เพิ่มประเภทรถ' }).click();
    await expect(d.getByText('กรุณากรอกชื่อประเภทรถ')).toBeVisible();
    await expect(d.getByRole('alert')).toContainText('กรอกข้อมูลให้ครบ 3 ช่อง');
    await expect(d.getByLabel('ชื่อประเภทรถ')).toHaveCSS('border-color', 'rgb(179, 50, 42)');
    await d.getByLabel('ชื่อประเภทรถ').fill(NAME);
    await d.getByLabel('น้ำหนักบรรทุก (กก.)').fill('12000');
    await d.getByLabel('ปริมาตร (ลบ.ม.)').fill('36.5');
    await d.getByLabel('ชั้นรถ').selectOption('10W');
    await d.getByLabel('ห้องเย็น').check();
    await d.getByLabel('อุณหภูมิต่ำสุด (°C)').fill('8');
    await d.getByLabel('อุณหภูมิสูงสุด (°C)').fill('2');
    await d.getByRole('button', { name: 'เพิ่มประเภทรถ' }).click();
    await expect(d.getByText('อุณหภูมิต่ำสุดต้องน้อยกว่าสูงสุด')).toBeVisible();
    await d.getByLabel('อุณหภูมิต่ำสุด (°C)').fill('-2');
    await d.getByRole('button', { name: 'เพิ่มประเภทรถ' }).click();
    await expect(page.getByRole('status')).toContainText(`เพิ่ม ${NAME} แล้ว`);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('−2 ถึง 2 °C')).toBeVisible();
    await expect(drawer.getByText('12,000 กก.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    // ชื่อซ้ำ (ไม่สนตัวพิมพ์) → "มีประเภทนี้แล้ว"
    await page.getByRole('button', { name: 'เพิ่มประเภทรถ' }).click();
    const d2 = page.getByRole('dialog');
    await d2.getByLabel('ชื่อประเภทรถ').fill(NAME);
    await d2.getByLabel('น้ำหนักบรรทุก (กก.)').fill('1000');
    await d2.getByLabel('ชั้นรถ').selectOption('6W');
    await d2.getByRole('button', { name: 'เพิ่มประเภทรถ' }).click();
    await expect(d2.getByText('มีประเภทนี้แล้ว')).toBeVisible();
    await d2.getByRole('button', { name: 'ยกเลิก' }).click();

    // แก้ไขจาก drawer: เพิ่มป้ายติดเครน
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(RUN);
    await page.getByText(NAME, { exact: true }).click();
    const dr = page.getByRole('dialog');
    await dr.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await page.getByRole('menuitem', { name: 'แก้ไข' }).click();
    const ed = page.getByRole('dialog', { name: /แก้ไขประเภทรถ/ });
    await ed.getByLabel('ติดเครน').check();
    await ed.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`บันทึกข้อมูล ${NAME} แล้ว`);
    await expect(page.getByRole('dialog').getByText('ห้องเย็น, ติดเครน')).toBeVisible();

    // ปิดใช้ (เหตุผล ≥ 10) จากเมนู ⋯ ของแถว — เมนูต้องปิดเมื่อ dialog เปิด
    await page.keyboard.press('Escape');
    const row = page.locator('tbody tr', { hasText: NAME });
    await row.getByRole('button', { name: 'การกระทำ' }).click();
    await page.getByRole('menuitem', { name: 'ปิดใช้' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    const dlg = page.getByRole('dialog', { name: /ปิดใช้ประเภทรถ/ });
    await dlg.getByLabel('เหตุผล').fill('ทดสอบปิดใช้ประเภทรถ');
    await dlg.getByRole('button', { name: 'ปิดใช้' }).click();
    await expect(page.getByRole('status')).toContainText(`อัปเดตสถานะ ${NAME} แล้ว`);
    await expect(page.locator('tbody tr', { hasText: NAME })).toContainText('ปิดใช้');
  });
});
