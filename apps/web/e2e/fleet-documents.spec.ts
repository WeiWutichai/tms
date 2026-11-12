import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST2-T19 หน้าเอกสารรถรวม (/fleet/documents):
 * การ์ด/แท็บ "ภายใน 30 วัน" แสดงเฉพาะเอกสารที่หมดใน 30 วัน · ต่ออายุจากหน้านี้ (modal + แนบไฟล์) แล้วแถวหายจากตัวกรอง 30 วัน
 * ผ่าน API จริง (ฐาน tms_e2e, workers 1) — ทะเบียนสุ่มต่อรอบ
 */
const RUN = String(Date.now()).slice(-4);
const PLATE = `77-${RUN}`;
const PDF = (name: string) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),
});
const day = (n: number) =>
  new Date(Date.now() + 7 * 3600_000 + n * 864e5).toISOString().slice(0, 10);

async function addDoc(page: Page, type: string, no: string, expiresIn: number) {
  await page.getByRole('button', { name: 'เพิ่มเอกสาร' }).click();
  const add = page.getByRole('dialog', { name: 'เพิ่มเอกสาร' });
  await add.getByLabel('ประเภทเอกสาร').selectOption({ label: type });
  await add.getByLabel('เลขที่').fill(no);
  await add.getByLabel('เริ่ม').fill(day(expiresIn - 365));
  await add.getByLabel('หมดอายุ').fill(day(expiresIn));
  await add.getByTestId('vdoc-file').setInputFiles(PDF(`${no}.pdf`));
  await expect(add.getByText(`${no}.pdf`)).toBeVisible();
  await add.getByRole('button', { name: 'บันทึกเอกสาร' }).click();
  await expect(page.getByTestId('vdoc-list').getByText(no)).toBeVisible();
}

test.describe.serial('รถ → เอกสารรถ (ST2-T19)', () => {
  test('กรองภายใน 30 วัน · ต่ออายุจากหน้าเอกสารรถรวม', async ({ page }) => {
    // เตรียม: รถ 1 คัน + เอกสาร หมดใน 10 วัน และ 45 วัน (ผ่านโปรไฟล์รถ)
    await page.goto('/fleet/vehicles');
    await page.getByRole('button', { name: 'เพิ่มรถ' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('ทะเบียน').fill(PLATE);
    await d.getByLabel('ประเภทรถ').selectOption({ label: '6 ล้อ' });
    await d.getByRole('button', { name: 'เพิ่มรถ' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'เพิ่มรถ' })).toContainText(
      `เพิ่มรถ ${PLATE} กทม. แล้ว`,
    );
    await page.keyboard.press('Escape');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(PLATE);
    await page
      .getByRole('row', { name: new RegExp(`${PLATE} กทม`) })
      .getByRole('cell')
      .nth(2)
      .click();
    await page.getByRole('tab', { name: 'เอกสาร', exact: true }).click();
    await addDoc(page, 'ภาษี', `TAX-${RUN}`, 10);
    await addDoc(page, 'พ.ร.บ.', `CMI-${RUN}`, 45);

    // หน้าเอกสารรถรวม (เมนู รถ → เอกสารรถ)
    await page.goto('/fleet/documents');
    await expect(page.getByRole('heading', { name: 'เอกสารรถ', level: 1 })).toBeVisible();
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(PLATE);
    const tax = page.getByRole('row', { name: new RegExp(`TAX-${RUN}`) });
    const cmi = page.getByRole('row', { name: new RegExp(`CMI-${RUN}`) });
    await expect(tax).toContainText('หมดใน 10 วัน');
    await expect(cmi).toContainText('หมดใน 45 วัน');
    await expect(tax).toContainText(`TAX-${RUN}.pdf`);

    // เกณฑ์ตรวจรับ: filter 30 วันแสดงเฉพาะเอกสารที่หมดใน 30 วัน (กดการ์ด = แท็บ)
    await page.locator('.tms-kpi', { hasText: 'ภายใน 30 วัน' }).click();
    await expect(page.getByRole('tab', { name: /^ภายใน 30 วัน/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(tax).toBeVisible();
    await expect(cmi).toHaveCount(0);
    await page.getByRole('tab', { name: /^ภายใน 60 วัน/ }).click();
    await expect(cmi).toBeVisible();
    // ตัวกรองสถานะ "ปกติ" (> 30 วัน) ภายในแท็บ 60 วัน
    await page.getByRole('columnheader').getByRole('combobox').last().selectOption('ok');
    await expect(cmi).toBeVisible();
    await expect(tax).toHaveCount(0);
    await page.getByRole('columnheader').getByRole('combobox').last().selectOption('');

    // ต่ออายุจากหน้านี้: คลิกแถว → modal → เลขที่ใหม่ + ไฟล์ → บันทึก
    await page.getByRole('tab', { name: /^ภายใน 30 วัน/ }).click();
    // คลิกช่องเลขที่ (ไม่ใช่ checkbox/ปุ่มเมนู)
    await tax.getByRole('cell', { name: `TAX-${RUN}`, exact: true }).click();
    const rnw = page.getByRole('dialog', { name: /ต่ออายุภาษี/ });
    await expect(rnw).toContainText(`เลขเดิม TAX-${RUN}`);
    await rnw.getByLabel('เลขที่ใหม่').fill(`TAX-${RUN}-N`);
    await rnw.getByTestId('vdoc-file').setInputFiles(PDF(`TAX-${RUN}-N.pdf`));
    await expect(rnw.getByText(`TAX-${RUN}-N.pdf`)).toBeVisible();
    await rnw.getByRole('button', { name: 'บันทึกการต่ออายุ' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'ต่ออายุ' })).toContainText(
      `ต่ออายุภาษี ${PLATE} กทม.`,
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // หายจาก "ภายใน 30 วัน" · ฉบับใหม่อยู่ในแท็บทั้งหมด
    await expect(page.getByRole('row', { name: new RegExp(`TAX-${RUN}`) })).toHaveCount(0);
    await page.getByRole('tab', { name: /^ทั้งหมด/ }).click();
    await expect(page.getByRole('row', { name: new RegExp(`TAX-${RUN}-N`) })).toContainText(
      'หมดใน',
    );
    await expect(page.getByRole('row', { name: new RegExp(`TAX-${RUN}\\s`) })).toHaveCount(0);

    // เมนู "ดูรถ" → โปรไฟล์รถ แท็บเอกสาร
    await page
      .getByRole('row', { name: new RegExp(`CMI-${RUN}`) })
      .getByRole('button', { name: 'การกระทำ' })
      .click();
    await page.getByRole('menuitem', { name: 'ดูรถ' }).click();
    await expect(page).toHaveURL(/\/fleet\/vehicles\/veh_[0-9a-f]{32}\?tab=docs/);
  });
});
