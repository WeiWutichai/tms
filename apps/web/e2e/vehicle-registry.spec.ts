import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST2-T07 ทะเบียนรถ + โปรไฟล์รถ:
 * เปลี่ยนสถานะรถแล้วตัวนับแท็บเปลี่ยน · เปิดโปรไฟล์เห็นเอกสารของคันนั้น (คันอื่นไม่เห็น) · ป้ายเอกสารใกล้หมดในตาราง + การ์ดกรอง
 * ผ่าน API จริง (ฐาน tms_e2e, workers 1) — ทะเบียนสุ่มต่อรอบ
 */
const RUN = String(Date.now()).slice(-4);
const A = `75-${RUN}`;
const B = `76-${RUN}`;
const PDF = {
  name: 'ตรอ-ทดสอบ.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),
};
const day = (n: number) =>
  new Date(Date.now() + 7 * 3600_000 + n * 864e5).toISOString().slice(0, 10);

async function tabCount(page: Page, label: string): Promise<number> {
  const tab = page.getByRole('tab', { name: new RegExp(`^${label}\\s*\\d+$`) });
  await expect(tab).toBeVisible();
  return Number((await tab.innerText()).match(/(\d+)\s*$/)![1]);
}

async function addVehicle(page: Page, plate: string) {
  await page.getByRole('button', { name: 'เพิ่มรถ' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('ทะเบียน').fill(plate);
  await d.getByLabel('ประเภทรถ').selectOption({ label: '6 ล้อ' });
  await d.getByRole('button', { name: 'เพิ่มรถ' }).click();
  await expect(page.getByRole('status')).toContainText(`เพิ่มรถ ${plate} กทม. แล้ว`);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const openProfile = async (page: Page, plate: string) => {
  await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(plate);
  await page.getByRole('row', { name: new RegExp(`${plate} กทม`) }).click();
  await expect(page).toHaveURL(/\/fleet\/vehicles\/veh_[0-9a-f]{32}/);
  await expect(page.getByRole('heading', { name: 'โปรไฟล์รถ', level: 1 })).toBeVisible();
  await expect(page.getByTestId('vprof-head')).toContainText(`${plate} กทม.`);
};

test.describe.serial('รถ → ทะเบียนรถ + โปรไฟล์รถ (ST2-T07)', () => {
  test('เปลี่ยนสถานะรถแล้วตัวนับแท็บเปลี่ยน', async ({ page }) => {
    await page.goto('/fleet/vehicles');
    await addVehicle(page, A);
    await expect(page.getByRole('tab', { name: /^รถร่วม\s*\d+$/ })).toBeVisible();
    const all0 = await tabCount(page, 'ทั้งหมด');
    const ready0 = await tabCount(page, 'พร้อมใช้');
    const parked0 = await tabCount(page, 'จอด');

    await openProfile(page, A);
    await expect(page.getByTestId('vprof-status')).toHaveText('พร้อมใช้');
    await expect(page.getByTestId('vprof-info')).toContainText('ตัวถังและเครื่องยนต์');
    await page.getByRole('button', { name: 'แก้ไข', exact: true }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('สถานะ').selectOption('parked');
    await d.getByRole('button', { name: 'บันทึก' }).click();
    const r = page.getByRole('dialog', { name: /เปลี่ยนสถานะ/ });
    await r.getByLabel('เหตุผล').fill('จอดรอคนขับใหม่ประจำรถ');
    await r.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByRole('status')).toContainText(`เปลี่ยนสถานะ ${A} กทม. แล้ว`);
    await expect(page.getByTestId('vprof-status')).toHaveText('จอด');
    await page.keyboard.press('Escape');

    await page.getByRole('main').getByRole('button', { name: 'ทะเบียนรถ' }).click();
    await expect(
      page.getByRole('tab', { name: new RegExp(`^จอด\\s*${parked0 + 1}$`) }),
    ).toBeVisible();
    expect(await tabCount(page, 'พร้อมใช้')).toBe(ready0 - 1);
    expect(await tabCount(page, 'ทั้งหมด')).toBe(all0);
    // แท็บ "จอด" แสดงเฉพาะรถจอด + จำนวนรายการ = ตัวนับของแท็บ
    await page.getByRole('tab', { name: /^จอด/ }).click();
    await expect(page.getByRole('row', { name: new RegExp(`${A} กทม.*จอด`) })).toBeVisible();
    await expect(page.getByText(`${parked0 + 1} รายการ`, { exact: true })).toBeVisible();
    // การ์ด "พร้อมใช้" = แท็บพร้อมใช้ → รถจอดไม่อยู่
    await page
      .getByRole('button', { name: /พร้อมใช้/ })
      .first()
      .click();
    await expect(page.getByRole('tab', { name: /^พร้อมใช้/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('เปิดโปรไฟล์เห็นเอกสารของคันนั้น · ป้ายเอกสารใกล้หมด + การ์ดกรอง', async ({ page }) => {
    await page.goto('/fleet/vehicles');
    await addVehicle(page, B);
    const kpi0 = page.locator('.tms-kpi', { hasText: 'เอกสารใกล้หมด 30 วัน' });
    await expect(kpi0).toHaveText(/วัน\s*\d+/);
    const alert0 = Number((await kpi0.innerText()).match(/วัน\s*(\d+)/)![1]);
    await openProfile(page, B);
    await page.getByRole('tab', { name: 'เอกสาร', exact: true }).click();
    await expect(page).toHaveURL(/tab=docs/);
    await expect(page.getByText('ไม่มีเอกสารสำหรับรถคันนี้')).toBeVisible();
    await page.getByRole('button', { name: 'เพิ่มเอกสาร' }).click();
    const add = page.getByRole('dialog', { name: 'เพิ่มเอกสาร' });
    await add.getByLabel('ประเภทเอกสาร').selectOption({ label: 'ตรวจสภาพ ตรอ.' });
    await add.getByLabel('เลขที่').fill(`INS-${RUN}`);
    await add.getByLabel('เริ่ม').fill(day(-355));
    await add.getByLabel('หมดอายุ').fill(day(10));
    await add.getByLabel('บริษัท / หน่วยงาน').fill('ตรอ. สมมติการช่าง');
    await add.getByTestId('vdoc-file').setInputFiles(PDF);
    await expect(add.getByText(PDF.name)).toBeVisible();
    await add.getByRole('button', { name: 'บันทึกเอกสาร' }).click();
    const table = page.getByTestId('vdoc-list');
    const row = table.getByRole('row', { name: new RegExp(`ตรวจสภาพ ตรอ\\..*INS-${RUN}`) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('ตรอ. สมมติการช่าง');
    await expect(row).toContainText('หมดใน 10 วัน');
    await expect(row).toContainText(PDF.name);
    await expect(row.getByRole('button', { name: 'ต่ออายุ' })).toBeVisible();

    // ทะเบียนรถ: ป้าย "1 ฉบับ" + การ์ดเอกสารใกล้หมดเพิ่ม 1 + กดการ์ดกรอง
    await page.getByRole('main').getByRole('button', { name: 'ทะเบียนรถ' }).click();
    const kpi = page.locator('.tms-kpi', { hasText: 'เอกสารใกล้หมด 30 วัน' });
    await expect(kpi).toHaveText(new RegExp(`วัน\\s*${alert0 + 1}\\s*คลิก`));
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(RUN);
    await expect(page.getByRole('row', { name: new RegExp(`${B} กทม`) })).toContainText('1 ฉบับ');
    await kpi.click();
    await expect(page.getByRole('row', { name: new RegExp(`${B} กทม`) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(`${A} กทม`) })).toHaveCount(0);

    // คันอื่นไม่เห็นเอกสารของคันนี้ (เมนู "ดูเอกสาร" → แท็บเอกสาร)
    await kpi.click();
    await page
      .getByRole('row', { name: new RegExp(`${A} กทม`) })
      .getByRole('button', { name: 'การกระทำ' })
      .click();
    await page.getByRole('menuitem', { name: 'ดูเอกสาร' }).click();
    await expect(page).toHaveURL(/tab=docs/);
    await expect(page.getByTestId('vprof-head')).toContainText(`${A} กทม.`);
    await expect(page.getByText('ไม่มีเอกสารสำหรับรถคันนี้')).toBeVisible();
    await expect(page.getByText(`INS-${RUN}`)).toHaveCount(0);
  });
});
