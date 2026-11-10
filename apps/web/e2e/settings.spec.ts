import { expect, test } from './fixtures';

/** ST1-T12/T14/T15: หน้าตั้งค่า + ซ่อนเมนูตามสิทธิ์ */
test.describe('ตั้งค่า (owner)', () => {
  test('นิติบุคคลและสาขา / เลขที่เอกสาร / ผู้ใช้และสิทธิ์', async ({ page }) => {
    await page.goto('/settings?sec=ent');
    await expect(page.getByRole('heading', { name: 'นิติบุคคลและสาขา' })).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'บริษัท ตัวอย่างขนส่ง จำกัด (สำนักงานใหญ่)' }),
    ).toBeVisible();
    await expect(page.getByRole('switch').first()).toBeDisabled(); // สำนักงานใหญ่ออกเองเสมอ

    await page.getByRole('button', { name: 'เลขที่เอกสาร' }).click();
    await expect(page.getByRole('cell', { name: 'ใบกำกับภาษี' })).toBeVisible();
    await expect(page.getByText(/^INV-00000-\d{4}-\d{4}$/)).toBeVisible();

    await page.getByRole('button', { name: 'ผู้ใช้และสิทธิ์' }).click();
    await expect(page.getByText('viewer@demo-a.test')).toBeVisible();
    await page.getByRole('tab', { name: 'สิทธิ์ตามบทบาท' }).click();
    await expect(page.getByRole('columnheader', { name: 'ผู้จ่ายงาน' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'แก้ราคาขาย — ผู้วางบิล' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'แก้ราคาขาย — ผู้จ่ายงาน' })).not.toBeChecked();
  });

  test('เพิ่มสาขาผ่าน drawer แล้วขึ้นในตาราง', async ({ page }) => {
    await page.goto('/settings?sec=ent');
    await page.getByRole('button', { name: 'เพิ่มสาขา' }).click();
    const code = String(10000 + Math.floor(Math.random() * 89999));
    await page.getByLabel('รหัสสาขา').fill(code);
    await page.getByLabel('ที่อยู่', { exact: true }).fill('9/9 ถนนทดสอบ');
    await page.getByLabel('ตำบล / แขวง').fill('ทดสอบ');
    await page.getByLabel('อำเภอ / เขต').fill('ทดสอบ');
    await page.getByLabel('จังหวัด').fill('กรุงเทพมหานคร');
    await page.getByLabel('รหัสไปรษณีย์').fill('10100');
    await page.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('cell', { name: code, exact: true })).toBeVisible();
  });
});

test.describe('ตั้งค่า (viewer)', () => {
  test.use({ loginEmail: 'viewer@demo-a.test' });
  test('เมนูตั้งค่าถูกซ่อน และเข้าทาง URL ได้หน้าไม่มีสิทธิ์', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'ตั้งค่าระบบ' })).toHaveCount(0);
    await page.goto('/settings');
    await expect(page.getByText('ไม่มีสิทธิ์เข้าถึงหน้านี้')).toBeVisible();
    await expect(page.getByText('บทบาท "ดูอย่างเดียว"')).toBeVisible();
  });
});
