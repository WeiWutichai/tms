import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST9-T11 มุมมองที่บันทึกไว้ — เกณฑ์ตรวจรับ: บันทึก view แล้วเปิดใหม่ได้ filter/คอลัมน์เดิม
 * หน้าทะเบียนรถ: ตัวกรองทะเบียน + แท็บ "จอด" + ซ่อนคอลัมน์ "หัวลาก – หาง" → บันทึก → ล้าง ("ทั้งหมด") →
 * เปิดแท็บใหม่ (ล้าง sessionStorage + reload) → เลือกมุมมอง = ได้ค่าเดิม · ตั้งค่าเริ่มต้น → เปิดใหม่ใช้อัตโนมัติ
 */
const RUN = String(Date.now()).slice(-5);
const NAME = `รถจอด E2E ${RUN}`;
const PLATE = `7${RUN.slice(-1)}-`;

const plateFilter = (page: Page) =>
  page.getByRole('columnheader').getByPlaceholder('ค้นหา').first();
const viewBtn = (page: Page) => page.getByRole('button', { name: /^มุมมอง:/ });
const pairHeader = (page: Page) => page.getByRole('columnheader', { name: 'หัวลาก – หาง' });

async function newTab(page: Page) {
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'ทะเบียนรถ', level: 1 })).toBeVisible();
}

test('บันทึกมุมมองแล้วเปิดใหม่ได้ตัวกรอง/แท็บ/คอลัมน์เดิม · ค่าเริ่มต้นใช้อัตโนมัติ (ST9-T11)', async ({
  page,
}) => {
  await page.goto('/fleet/vehicles');
  await expect(page.getByRole('heading', { name: 'ทะเบียนรถ', level: 1 })).toBeVisible();
  await newTab(page);
  await expect(viewBtn(page)).toHaveText('มุมมอง: ทั้งหมด');

  // ตั้งตัวกรอง + แท็บ + ซ่อนคอลัมน์
  await plateFilter(page).fill(PLATE);
  await page.getByRole('tab', { name: /^จอด/ }).click();
  await page.getByRole('button', { name: 'คอลัมน์' }).click();
  await page.getByRole('checkbox', { name: 'หัวลาก – หาง' }).uncheck();
  await page.getByRole('button', { name: 'คอลัมน์' }).click();
  await expect(pairHeader(page)).toHaveCount(0);
  await expect(viewBtn(page)).toHaveText('มุมมอง: กำหนดเอง');

  // บันทึก
  await viewBtn(page).click();
  await page.getByRole('menuitem', { name: 'บันทึกเป็นมุมมองใหม่…' }).click();
  const d = page.getByRole('dialog', { name: 'บันทึกมุมมอง' });
  await d.getByLabel('ชื่อมุมมอง').fill(NAME);
  await d.getByRole('button', { name: 'บันทึกมุมมอง' }).click();
  await expect(page.getByRole('status')).toContainText(`บันทึกมุมมอง "${NAME}" แล้ว`);
  await expect(viewBtn(page)).toHaveText(`มุมมอง: ${NAME}`);

  // "ทั้งหมด" ล้างตัวกรอง + คอลัมน์กลับค่าเริ่มต้น
  await viewBtn(page).click();
  await page.getByRole('menuitemradio', { name: 'ทั้งหมด' }).click();
  await expect(plateFilter(page)).toHaveValue('');
  await expect(page.getByRole('tab', { name: /^ทั้งหมด/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(pairHeader(page)).toHaveCount(1);

  // เปิดใหม่ (แท็บใหม่) → เลือกมุมมอง = ค่าเดิมครบ
  await newTab(page);
  await viewBtn(page).click();
  await page.getByRole('menuitemradio', { name: NAME }).click();
  await expect(plateFilter(page)).toHaveValue(PLATE);
  await expect(page.getByRole('tab', { name: /^จอด/ })).toHaveAttribute('aria-selected', 'true');
  await expect(pairHeader(page)).toHaveCount(0);
  await expect(viewBtn(page)).toHaveText(`มุมมอง: ${NAME}`);

  // ตั้งเป็นค่าเริ่มต้น → แท็บใหม่เปิดหน้าด้วยมุมมองนี้เอง
  await viewBtn(page).click();
  await page.getByRole('menuitem', { name: 'ตั้งเป็นค่าเริ่มต้น' }).click();
  await expect(page.getByRole('status')).toContainText(`ตั้ง "${NAME}" เป็นค่าเริ่มต้นแล้ว`);
  await newTab(page);
  await expect(viewBtn(page)).toHaveText(`มุมมอง: ${NAME}`);
  await expect(plateFilter(page)).toHaveValue(PLATE);
  await expect(pairHeader(page)).toHaveCount(0);

  // ลบ (ไม่ให้ค่าเริ่มต้นค้างกับ spec อื่น)
  await viewBtn(page).click();
  await page.getByRole('menuitem', { name: 'ลบมุมมองนี้' }).click();
  await page
    .getByRole('alertdialog', { name: `ลบมุมมอง "${NAME}"` })
    .getByRole('button', { name: 'ลบมุมมอง' })
    .click();
  await expect(page.getByRole('status')).toContainText(`ลบมุมมอง "${NAME}" แล้ว`);
  await newTab(page);
  await expect(viewBtn(page)).toHaveText('มุมมอง: ทั้งหมด');
});
