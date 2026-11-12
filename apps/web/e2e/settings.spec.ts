import { DEMO_TOTP_SECRET, expect, test, totp } from './fixtures';

/** ST1-T12/T14/T15: หน้าตั้งค่า + ซ่อนเมนูตามสิทธิ์ */
test.describe('ตั้งค่า (owner)', () => {
  test('นิติบุคคลและสาขา / เลขที่เอกสาร / ผู้ใช้และสิทธิ์', async ({ page }) => {
    await page.goto('/settings?sec=ent');
    await expect(page.getByRole('heading', { name: 'นิติบุคคลและสาขา' })).toBeVisible();
    // กลุ่มเมนู "ตั้งค่า" กางอยู่ และเห็นเมนูย่อยที่ active (ต้นแบบ)
    await expect(page.getByRole('button', { name: 'ตั้งค่า', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
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

test.describe('ตั้งค่า: องค์กร / ภาษี / ความปลอดภัย (owner)', () => {
  test('แก้ค่าแล้วกดบันทึก → toast และค่าคงอยู่หลังโหลดใหม่', async ({ page }) => {
    await page.goto('/settings?sec=sec');
    await expect(page.getByRole('heading', { name: 'ความปลอดภัย' })).toBeVisible();
    const save = page.getByRole('button', { name: 'บันทึก' });
    await page.getByLabel('Session timeout').selectOption('60');
    await save.click();
    await expect(page.getByRole('status')).toHaveText('บันทึกการตั้งค่าความปลอดภัยแล้ว');
    await page.reload();
    await expect(page.getByLabel('Session timeout')).toHaveValue('60');
    // ยืด timeout = ลดความปลอดภัย → ต้องยืนยัน 2FA อีกครั้ง
    await page.getByLabel('Session timeout').selectOption('480');
    await page.getByRole('button', { name: 'บันทึก' }).click();
    const box = page.getByRole('group', { name: 'ยืนยันตัวตน 2 ชั้นอีกครั้ง' });
    await expect(box).toBeVisible();
    await box.getByLabel('รหัส 6 หลัก').fill(totp(DEMO_TOTP_SECRET, 1));
    await box.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByRole('status')).toHaveText('บันทึกการตั้งค่าความปลอดภัยแล้ว');

    await page.goto('/settings?sec=tax');
    await expect(page.getByRole('radio', { name: 'เลือกตามลูกค้า' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.goto('/settings?sec=org');
    await expect(page.getByLabel('เลขผู้เสียภาษี')).toHaveValue(/^0000000000/);
    await expect(page.getByRole('radio', { name: /^พ\.ศ\./ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

test.describe('ตั้งค่า (viewer)', () => {
  test.use({ loginEmail: 'viewer@demo-a.test' });
  test('เห็นเฉพาะหัวข้อ "เหตุผล" แบบอ่านอย่างเดียว (ST2-T12: master:read)', async ({ page }) => {
    await page.goto('/settings');
    const menu = page.getByRole('navigation', { name: 'ตั้งค่า' });
    await expect(menu.getByRole('button')).toHaveText(['เหตุผล']);
    await expect(page.getByRole('heading', { name: 'เหตุผล (reason master)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'เพิ่มเหตุผล' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'บันทึก' })).toHaveCount(0);
    await expect(page.getByLabel('บังคับรูป — ลูกค้าปิดทำการ')).toBeDisabled();
    // หัวข้อองค์กรเข้าทาง URL ไม่ได้ (กรองตามสิทธิ์ต่อหัวข้อ) และปุ่ม "ไม่ได้เชื่อมระบบบัญชี" ยังปิด
    await page.goto('/settings?sec=org');
    await expect(page.getByRole('heading', { name: 'เหตุผล (reason master)' })).toBeVisible();
    await expect(page.getByRole('button', { name: /ไม่ได้เชื่อมระบบบัญชี/ })).toBeDisabled();
  });
});
