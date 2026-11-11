import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';

/** E2E ST1-T19: wizard นำเข้า — อัปโหลด → ตรวจ (แถวผิดพื้นแดง) → จับคู่คอลัมน์ → นำเข้า → ผลลัพธ์ + แถวที่ผิด */
test('นำเข้าจาก Excel: dry-run แสดงแถวผิด นำเข้าเฉพาะแถวที่ผ่าน', async ({ page }) => {
  const csv = join(tmpdir(), `import-${Date.now()}.csv`);
  writeFileSync(
    csv,
    'Code,Name,Tax ID\nA1,บจก. หนึ่ง,0000000000001\nA2,บจก. สอง,123\nA3,บจก. สาม,0000000000003\n',
  );
  await page.goto('/dev/import');
  await page.getByRole('button', { name: 'นำเข้าข้อมูลตัวอย่างจาก Excel' }).click();
  const dlg = page.getByRole('dialog', { name: 'นำเข้าข้อมูลตัวอย่างจาก Excel' });
  await expect(dlg.getByText('ลากไฟล์ .xlsx หรือ .csv มาวางที่นี่')).toBeVisible();
  await dlg.getByTestId('imp-file').setInputFiles(csv);
  await expect(dlg.getByText('3 แถว · 1 KB')).toBeVisible();
  await dlg.getByRole('button', { name: 'ถัดไป' }).click();

  await expect(dlg.getByRole('heading', { name: 'จับคู่คอลัมน์' })).toBeVisible();
  await expect(dlg.getByRole('combobox', { name: 'รหัส' })).toHaveValue('Code');
  await expect(dlg.locator('tbody tr[data-error]')).toHaveCount(1);
  // ไม่จับคู่ "ชื่อ" (ช่องบังคับ) → ทุกแถวผิด แล้วจับคู่กลับ
  await dlg.getByRole('combobox', { name: 'ชื่อ', exact: true }).selectOption('');
  await expect(dlg.locator('tbody tr[data-error]')).toHaveCount(3);
  await dlg.getByRole('combobox', { name: 'ชื่อ', exact: true }).selectOption('Name');
  await expect(dlg.locator('tbody tr[data-error]')).toHaveCount(1);

  await dlg.getByRole('button', { name: 'นำเข้า 2 แถว' }).click();
  await expect(dlg.getByText('นำเข้าสำเร็จ')).toBeVisible();
  await expect(dlg.getByText('แถว 3', { exact: true })).toBeVisible();
  await expect(dlg.getByText('เลขผู้เสียภาษี: เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก')).toBeVisible();
  const dl = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'ดาวน์โหลดแถวที่ผิด' }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.xlsx$/);
  await dlg.getByRole('button', { name: 'เสร็จสิ้น' }).click();
  await expect(page.getByRole('status')).toHaveText('นำเข้าข้อมูลตัวอย่าง สำเร็จ 2 แถว');
});
