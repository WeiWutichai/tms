import { expect, test } from './fixtures';

/**
 * E2E ST2-T06 ทะเบียนรถ: เพิ่มรถ (ช่องบังคับ + น้ำหนักตั้งต้นจากประเภท) → ทะเบียนซ้ำ "มีทะเบียนนี้แล้ว"
 * → รถร่วมต้องเลือกผู้รับเหมา → หัวลาก + หาง จับคู่แล้วเห็นทั้งสองฝั่ง → เลขไมล์ถอยหลังถูกปฏิเสธ → เปลี่ยนสถานะพร้อมเหตุผล
 * ผ่าน API จริง (ฐาน tms_e2e) — ทะเบียนสุ่มต่อรอบ
 */
const RUN = String(Date.now()).slice(-4);
const P1 = `71-${RUN}`;
const HEAD = `72-${RUN}`;
const TRL = `73-${RUN}`;

test.describe.serial('รถ → ทะเบียนรถ', () => {
  test('เพิ่มรถ → ช่องบังคับ → ทะเบียนซ้ำ → รถร่วมต้องมีผู้รับเหมา', async ({ page }) => {
    await page.goto('/fleet/vehicles');
    await expect(page.getByRole('heading', { name: 'ทะเบียนรถ', level: 1 })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'หัวลาก – หาง' })).toBeVisible();
    await page.getByRole('button', { name: 'เพิ่มรถ' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'เพิ่มรถ' }).click();
    await expect(d.getByText('กรุณากรอก ทะเบียน')).toBeVisible();
    await expect(d.getByRole('alert')).toContainText('กรอกข้อมูลให้ครบ 3 ช่อง');
    await d.getByLabel('ทะเบียน').fill(P1);
    await d.getByLabel('ประเภทรถ').selectOption({ label: '6 ล้อ' });
    // น้ำหนักบรรทุกตั้งต้นจากประเภทรถ
    await expect(d.getByLabel('น้ำหนักบรรทุก (กก.)')).not.toHaveValue('');
    await d.getByLabel('เลขไมล์ปัจจุบัน (กม.)').fill('150000');
    await d.getByRole('button', { name: 'เพิ่มรถ' }).click();
    await expect(page.getByRole('status')).toContainText(`เพิ่มรถ ${P1} กทม. แล้ว`);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'เพิ่มรถ' }).click();
    const d2 = page.getByRole('dialog');
    await d2.getByLabel('ทะเบียน').fill(P1.replace('-', ' '));
    await d2.getByLabel('ประเภทรถ').selectOption({ label: '6 ล้อ' });
    await d2.getByRole('button', { name: 'เพิ่มรถ' }).click();
    await expect(d2.getByText('มีทะเบียนนี้แล้ว')).toBeVisible();
    await d2.getByLabel(/^เจ้าของ/).selectOption('SUBCONTRACT');
    await d2.getByRole('button', { name: 'เพิ่มรถ' }).click();
    await expect(d2.getByText('รถร่วมต้องเลือกผู้รับเหมา')).toBeVisible();
    await d2.getByRole('button', { name: 'ยกเลิก' }).click();
  });

  test('หัวลาก + หาง จับคู่แล้วเห็นทั้งสองฝั่ง', async ({ page }) => {
    await page.goto('/fleet/vehicles');
    for (const [plate, role] of [
      [TRL, 'TRAILER'],
      [HEAD, 'TRACTOR'],
    ] as const) {
      await page.getByRole('button', { name: 'เพิ่มรถ' }).click();
      const d = page.getByRole('dialog');
      await d.getByLabel('ทะเบียน').fill(plate);
      await d.getByLabel('ประเภทรถ').selectOption({ label: 'หัวลาก + หางเทรลเลอร์' });
      await d.getByLabel('บทบาท (หัวลาก / หาง)').selectOption(role);
      if (role === 'TRACTOR') {
        await d.getByLabel('จับคู่กับ').click();
        await d.getByLabel('จับคู่กับ').fill(TRL);
        await d.getByRole('option', { name: new RegExp(TRL) }).click();
      }
      await d.getByRole('button', { name: 'เพิ่มรถ' }).click();
      await expect(page.getByRole('status')).toContainText(`เพิ่มรถ ${plate} กทม. แล้ว`);
      await page.keyboard.press('Escape');
    }
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(RUN);
    await expect(
      page.getByRole('row', { name: new RegExp(`${HEAD}.*หัวลาก \\+ ${TRL}`) }),
    ).toBeVisible();
    await expect(
      page.getByRole('row', { name: new RegExp(`${TRL}.*หาง \\+ ${HEAD}`) }),
    ).toBeVisible();
  });

  test('เลขไมล์ถอยหลังถูกปฏิเสธ → เปลี่ยนสถานะเป็นซ่อมพร้อมเหตุผล', async ({ page }) => {
    await page.goto('/fleet/vehicles');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(P1);
    await page.getByRole('row', { name: new RegExp(`${P1} กทม`) }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('เลขไมล์ปัจจุบัน (กม.)').fill('149000');
    await d.getByRole('button', { name: 'บันทึก' }).click();
    await expect(d.getByText('เลขไมล์น้อยกว่าค่าปัจจุบันไม่ได้')).toBeVisible();
    await d.getByLabel('เลขไมล์ปัจจุบัน (กม.)').fill('150250');
    await d.getByLabel('สถานะ').selectOption('maintenance');
    await d.getByRole('button', { name: 'บันทึก' }).click();
    const r = page.getByRole('dialog', { name: /เปลี่ยนสถานะ/ });
    await r.getByLabel('เหตุผล').fill('เข้าอู่เปลี่ยนคลัตช์ 3 วัน');
    await r.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByRole('status')).toContainText(`เปลี่ยนสถานะ ${P1} กทม. แล้ว`);
    await expect(page.getByRole('row', { name: new RegExp(`${P1}.*150,250.*ซ่อม`) })).toBeVisible();
  });
});
