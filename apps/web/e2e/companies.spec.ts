import { expect, test, type Page } from '@playwright/test';

/**
 * E2E ST0-T14: รายการ → drawer → ฟอร์ม ผ่าน API จริง (ฐาน tms_e2e ที่ seed ใหม่ทุกครั้ง)
 * ครอบ: list จาก API, สร้าง (Idempotency-Key), error ราย field จาก problem+json, เปลี่ยนสถานะพร้อมเหตุผล, กรองสถานะ
 */
async function openSample(page: Page) {
  await page.goto('/design-system');
  const section = page.locator('section', { hasText: 'ตัวอย่างข้อมูลจริง · นิติบุคคล' });
  await section.scrollIntoViewIfNeeded();
  return section;
}

test.describe.serial('นิติบุคคล (ตัวอย่าง list → drawer → form)', () => {
  test('รายการมาจาก API — seed 2 ราย', async ({ page }) => {
    const s = await openSample(page);
    await expect(s.getByRole('row', { name: /บริษัท ตัวอย่างขนส่ง จำกัด/ })).toBeVisible();
    await expect(s.getByRole('row', { name: /บริษัท ตัวอย่างโลจิสติกส์ จำกัด/ })).toBeVisible();
  });

  test('เลขผู้เสียภาษีผิด → แสดง error ใต้ช่องเป็นภาษาไทย และไม่ถูกบันทึก', async ({ page }) => {
    const s = await openSample(page);
    await s.getByRole('button', { name: 'เพิ่มนิติบุคคล' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('ชื่อนิติบุคคล').fill('บริษัท ทดสอบอีทูอี จำกัด');
    await drawer.getByLabel('เลขผู้เสียภาษี').fill('1234567890123');
    await drawer.getByRole('button', { name: 'บันทึก' }).click();
    await expect(
      drawer.getByText('เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลักที่ถูกต้อง'),
    ).toBeVisible();
    await expect(drawer.getByLabel('เลขผู้เสียภาษี')).toHaveAttribute('aria-invalid', 'true');
    await page.keyboard.press('Escape');
    await expect(s.getByRole('row', { name: /ทดสอบอีทูอี/ })).toHaveCount(0);
  });

  test('สร้างนิติบุคคลใหม่ → ปรากฏในรายการ', async ({ page }) => {
    const s = await openSample(page);
    await s.getByRole('button', { name: 'เพิ่มนิติบุคคล' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('ชื่อนิติบุคคล').fill('บริษัท ทดสอบอีทูอี จำกัด');
    await drawer.getByLabel('เลขผู้เสียภาษี').fill('0000000000035'); // checksum ถูก (ชุดเลขทดสอบขึ้นต้น 0000000000)
    await drawer.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(s.getByRole('row', { name: /บริษัท ทดสอบอีทูอี จำกัด/ })).toBeVisible();
  });

  test('ปิดใช้งานต้องมีเหตุผล → สถานะเปลี่ยน → กรองเห็นเฉพาะที่ปิด → เปิดใช้งานคืน', async ({
    page,
  }) => {
    const s = await openSample(page);
    await s.getByRole('row', { name: /บริษัท ทดสอบอีทูอี จำกัด/ }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await drawer.getByRole('menuitem', { name: 'ปิดใช้งาน' }).click();
    await drawer.getByLabel('เหตุผล').fill('ทดสอบ E2E');
    await drawer.getByRole('button', { name: 'ปิดใช้งาน' }).click();
    await expect(drawer.getByText('ปิดใช้งาน', { exact: true }).first()).toBeVisible();
    await page.keyboard.press('Escape');

    await s.getByLabel('สถานะ').selectOption('inactive');
    await expect(s.getByRole('row', { name: /บริษัท ทดสอบอีทูอี จำกัด/ })).toBeVisible();
    await expect(s.getByRole('row', { name: /บริษัท ตัวอย่างขนส่ง จำกัด/ })).toHaveCount(0);

    await s.getByRole('row', { name: /บริษัท ทดสอบอีทูอี จำกัด/ }).click();
    await drawer.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await drawer.getByRole('menuitem', { name: 'เปิดใช้งาน' }).click();
    await drawer.getByLabel('เหตุผล').fill('คืนสถานะ');
    await drawer.getByRole('button', { name: 'เปิดใช้งาน' }).click();
    await expect(drawer.getByText('ใช้งาน', { exact: true }).first()).toBeVisible();
  });
});
