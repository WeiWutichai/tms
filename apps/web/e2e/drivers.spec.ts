import { expect, test } from './fixtures';

/**
 * E2E ST2-T08 คนขับ: เปิดหน้า "คนขับและผู้รับเหมา" (แท็บเริ่มต้น = คนขับ) → เพิ่มคนขับ (ช่องบังคับ, เลขบัตรไม่แสดงเต็ม)
 * → ป้ายใบขับขี่ใกล้หมดอายุ + กล่องเตือน → คนขับรถร่วมต้องเลือกผู้รับเหมา → เปลี่ยนสถานะเป็นลาพัก (เหตุผล)
 * ผ่าน API จริง (ฐาน tms_e2e) — ชื่อ/เบอร์สุ่มต่อรอบ (ข้อมูลสมมติ)
 */
const RUN = String(Date.now()).slice(-6);
const NAME = `นายอีทูอี คนขับ ${RUN}`;
const PHONE = `089-${RUN.slice(0, 3)}-${RUN.slice(2, 6)}`;

/** เลขบัตรประชาชน 13 หลัก checksum ถูก (ขึ้นต้น 3) */
function nid(): string {
  const base = `31006${RUN}0`.slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}
/** วันนี้ + n วัน (เวลาไทย) YYYY-MM-DD */
const day = (n: number) =>
  new Date(Date.now() + 7 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);

test.describe.serial('รถ → คนขับและผู้รับเหมา (คนขับ)', () => {
  test('แท็บเริ่มต้น = คนขับ คอลัมน์ตามต้นแบบ', async ({ page }) => {
    await page.goto('/fleet/drivers');
    await expect(page.getByRole('heading', { name: 'คนขับและผู้รับเหมา', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^คนขับ/, selected: true })).toBeVisible();
    for (const c of ['ชื่อ', 'เบอร์', 'ประเภท', 'ใบขับขี่', 'สังกัด', 'รถประจำ', 'สถานะ'])
      await expect(page.getByRole('columnheader', { name: c, exact: true })).toBeVisible();
    await expect(page.getByText('ใบขับขี่ใกล้หมดอายุ 30 วัน')).toBeVisible();
    await expect(page.getByRole('button', { name: 'เพิ่มคนขับ' })).toBeVisible();
  });

  test('เพิ่มคนขับ → เลขบัตรไม่แสดงเต็ม → ป้ายใกล้หมดอายุ → รถร่วมต้องมีผู้รับเหมา → ลาพัก', async ({
    page,
  }) => {
    const id = nid();
    await page.goto('/fleet/drivers');
    await page.getByRole('button', { name: 'เพิ่มคนขับ' }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('เพิ่มคนขับใหม่')).toBeVisible();
    await d.getByRole('button', { name: 'บันทึก' }).click();
    await expect(d.getByText('กรอกข้อมูลให้ครบ 3 ช่อง')).toBeVisible();
    await expect(d.getByText('กรุณากรอกชื่อ-นามสกุล')).toBeVisible();
    await d.getByLabel('ชื่อ-นามสกุล').fill(NAME);
    await d.getByLabel('เบอร์โทร').fill(PHONE);
    await d.getByLabel('ประเภทใบขับขี่').selectOption('T3');
    await d.getByLabel('ใบขับขี่หมดอายุ').fill(day(10));
    await d.getByLabel('เลขบัตรประชาชน').fill('1234567890123');
    await d.getByRole('button', { name: 'บันทึก' }).click();
    await expect(d.getByText('เลขบัตรประชาชน 13 หลักไม่ถูกต้อง')).toBeVisible();
    await d.getByLabel('เลขบัตรประชาชน').fill(id);
    await d.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`เพิ่ม ${NAME} แล้ว`);

    // drawer ของคนขับที่สร้าง: เลขบัตรกลับมาเป็น •••• 4 หลักท้าย + กล่องเตือนใบขับขี่
    const dr = page.getByRole('dialog');
    await expect(dr.getByText('คนขับ · พขร.มีเงินเดือน')).toBeVisible();
    await expect(dr.getByLabel('เลขบัตรประชาชน')).toHaveValue('');
    await expect(dr.getByLabel('เลขบัตรประชาชน')).toHaveAttribute(
      'placeholder',
      `•••• ${id.slice(-4)}`,
    );
    await expect(dr.getByRole('note')).toContainText('ใบขับขี่จะหมดอายุ');
    await expect(page.locator('body')).not.toContainText(id);

    // เปลี่ยนเป็นคนขับรถร่วมโดยไม่เลือกผู้รับเหมา → บันทึกไม่ได้
    await dr.getByLabel('ประเภท', { exact: true }).selectOption('CARRIER_DRIVER');
    await dr.getByRole('button', { name: 'บันทึก' }).click();
    await expect(dr.getByText('คนขับรถร่วมต้องเลือกผู้รับเหมา')).toBeVisible();
    await dr.getByLabel('ประเภท', { exact: true }).selectOption('EMPLOYEE_SALARIED');

    // ลาพัก (เหตุผล ≥ 10) ผ่านช่องสถานะ
    await dr.getByLabel('สถานะ', { exact: true }).selectOption('on_leave');
    await dr.getByRole('button', { name: 'บันทึก' }).click();
    const rd = page.getByRole('dialog', { name: /เปลี่ยนสถานะ/ });
    await rd.getByLabel('เหตุผล').fill('ลาพักร้อน 3 วัน ทดสอบ');
    await rd.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByRole('status')).toContainText(`อัปเดตสถานะ ${NAME} แล้ว`);
    await page.keyboard.press('Escape');

    // ตาราง: ค้นชื่อ → ใบขับขี่ ท.3 + ป้ายใกล้หมดอายุ + สถานะลาพัก
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(RUN);
    const row = page.locator('tbody tr', { hasText: NAME });
    await expect(row).toContainText('ท.3');
    await expect(row.getByTestId('lic-cell')).toContainText('ใกล้หมดอายุ');
    await expect(row).toContainText('ลาพัก');
    await expect(row).not.toContainText(id);
  });
});
