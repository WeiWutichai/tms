import { expect, test } from './fixtures';

/**
 * E2E ST2-T01 ลูกค้า: รายการ → เพิ่ม → แก้ไข → ปิดใช้ (เหตุผล) → กิจกรรม ผ่าน API จริง (ฐาน tms_e2e)
 */
const RUN = String(Date.now()).slice(-6);
const NAME = `บจก. ลูกค้าอีทูอี ${RUN}`;
function taxIdFor(seed: string): string {
  const base = `0888${seed}`.padEnd(12, '0').slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

test.describe.serial('ข้อมูลหลัก → ลูกค้า', () => {
  test('เปิดหน้าจากเมนู → หัว แถบสรุป แท็บ ตาราง', async ({ page }) => {
    await page.goto('/master/customers');
    await expect(page.getByRole('heading', { name: 'ลูกค้า', level: 1 })).toBeVisible();
    await expect(page.getByText('ลูกค้าทั้งหมด')).toBeVisible();
    await expect(page.getByRole('tab', { name: /ทั้งหมด/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'เลขผู้เสียภาษี / สาขา' })).toBeVisible();
  });

  test('เพิ่มลูกค้า: เลขผิด → error ไทย; ถูก → รหัส CUS- + เปิด drawer', async ({ page }) => {
    await page.goto('/master/customers');
    await page.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText(/เลขที่ถัดไป CUS-\d{4}/)).toBeVisible();
    await d.getByLabel('ชื่อลูกค้า').fill(NAME);
    await d.getByLabel('เลขผู้เสียภาษี').fill('1234567890123'); // 13 หลักแต่ check digit ผิด
    await d.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
    await expect(
      d.getByText('เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลักที่ถูกต้อง'),
    ).toBeVisible();
    await d.getByLabel('เลขผู้เสียภาษี').fill(taxIdFor(RUN));
    await d.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
    await expect(page.getByRole('status')).toContainText(/เพิ่มลูกค้า CUS-\d{4} แล้ว/);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(/^CUS-\d{4}$/)).toBeVisible();
    await expect(drawer.getByLabel('ชื่อลูกค้า')).toHaveValue(NAME);
  });

  test('แก้ไข: เครดิต + รอบวางบิล + เงื่อนไข → บันทึก → ตาราง + กิจกรรมแสดงการแก้', async ({
    page,
  }) => {
    await page.goto('/master/customers');
    await page.getByRole('row', { name: new RegExp(NAME) }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('เครดิต (วัน)').fill('60');
    await d.getByLabel('รอบวางบิล').selectOption('WEEKLY');
    await d.getByRole('tab', { name: 'เงื่อนไข' }).click();
    await d.getByRole('radio', { name: 'ออกพร้อมใบแจ้งหนี้' }).click();
    await d.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`บันทึกข้อมูล ${NAME} แล้ว`);
    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await expect(row).toContainText('60 วัน');
    await expect(row).toContainText('รายสัปดาห์');
    await d.getByRole('tab', { name: 'กิจกรรม' }).click();
    await expect(d.getByText('แก้ไขข้อมูล')).toBeVisible();
    await expect(d.getByText('สร้างข้อมูล')).toBeVisible();
    await d.getByText('แก้ไขข้อมูล').click();
    await expect(d.getByText('เครดิต (วัน): 30 → 60')).toBeVisible();
  });

  test('ปิดใช้ต้องมีเหตุผล ≥ 10 ตัว → สถานะ "ปิดใช้" → แท็บปิดใช้เห็น', async ({ page }) => {
    await page.goto('/master/customers');
    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await row.getByRole('button', { name: 'การกระทำ' }).click();
    await page.getByRole('menuitem', { name: 'ปิดใช้' }).click();
    const dlg = page.getByRole('dialog', { name: /ปิดใช้ลูกค้า/ });
    const ok = dlg.getByRole('button', { name: 'ปิดใช้' });
    await dlg.getByLabel('เหตุผล').fill('สั้น');
    await expect(ok).toBeDisabled();
    await dlg.getByLabel('เหตุผล').fill('เลิกใช้บริการ ทดสอบอีทูอี');
    await ok.click();
    await expect(page.getByRole('status')).toContainText(`อัปเดตสถานะ ${NAME} แล้ว`);
    await expect(row).toContainText('ปิดใช้');
    await page.getByRole('tab', { name: /ปิดใช้/ }).click();
    await expect(page.getByRole('row', { name: new RegExp(NAME) })).toBeVisible();
    await page.getByRole('tab', { name: /^ใช้งาน/ }).click();
    await expect(page.getByRole('row', { name: new RegExp(NAME) })).toHaveCount(0);
  });
});
