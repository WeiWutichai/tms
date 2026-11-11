import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST0-T14: รายการ → drawer → ฟอร์ม ผ่าน API จริง (ฐาน tms_e2e ที่ seed ใหม่ทุกครั้ง)
 * ครอบ: list จาก API, สร้าง (Idempotency-Key), error ราย field จาก problem+json, เปลี่ยนสถานะพร้อมเหตุผล, กรองสถานะ
 */
/** ชื่อ/เลขภาษีไม่ซ้ำต่อรอบ — รันซ้ำบนฐานเดิมได้ (ไม่ชนข้อมูลรอบก่อน) */
const RUN = String(Date.now()).slice(-6);
const NAME = `บริษัท ทดสอบอีทูอี ${RUN} จำกัด`;
const NAME_RE = new RegExp(`ทดสอบอีทูอี ${RUN}`);
function taxIdFor(seed: string): string {
  const base = `000000${seed}`.slice(-12).padStart(12, '0');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

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
    await drawer.getByLabel('ชื่อนิติบุคคล').fill(NAME);
    await drawer.getByLabel('เลขผู้เสียภาษี').fill('1234567890123');
    await drawer.getByRole('button', { name: 'บันทึก' }).click();
    await expect(
      drawer.getByText('เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลักที่ถูกต้อง'),
    ).toBeVisible();
    await expect(drawer.getByLabel('เลขผู้เสียภาษี')).toHaveAttribute('aria-invalid', 'true');
    await page.keyboard.press('Escape');
    await expect(s.getByRole('row', { name: NAME_RE })).toHaveCount(0);
  });

  test('สร้างนิติบุคคลใหม่ → ปรากฏในรายการ', async ({ page }) => {
    const s = await openSample(page);
    await s.getByRole('button', { name: 'เพิ่มนิติบุคคล' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('ชื่อนิติบุคคล').fill(NAME);
    await drawer.getByLabel('เลขผู้เสียภาษี').fill(taxIdFor(RUN)); // checksum ถูก (ชุดเลขทดสอบขึ้นต้น 000000)
    await drawer.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(s.getByRole('row', { name: NAME_RE })).toBeVisible();
  });

  test('ปิดใช้งานต้องมีเหตุผล → สถานะเปลี่ยน → กรองเห็นเฉพาะที่ปิด → เปิดใช้งานคืน', async ({
    page,
  }) => {
    const s = await openSample(page);
    await s.getByRole('row', { name: NAME_RE }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await drawer.getByRole('menuitem', { name: 'ปิดใช้งาน' }).click();
    await drawer.getByLabel('เหตุผล').fill('ทดสอบ E2E');
    await drawer.getByRole('button', { name: 'ปิดใช้งาน' }).click();
    // รอให้บันทึกเสร็จจริง (ช่องเหตุผลหายไป) — ข้อความ "ปิดใช้งาน" มีบนปุ่มอยู่แล้ว ใช้รอไม่ได้ (race กับ Escape)
    await expect(drawer.getByLabel('เหตุผล')).toHaveCount(0);
    await expect(drawer.getByText('ปิดใช้งาน', { exact: true }).first()).toBeVisible();
    await page.keyboard.press('Escape');

    await s.getByLabel('สถานะ').selectOption('inactive');
    await expect(s.getByRole('row', { name: NAME_RE })).toBeVisible();
    await expect(s.getByRole('row', { name: /บริษัท ตัวอย่างขนส่ง จำกัด/ })).toHaveCount(0);

    await s.getByRole('row', { name: NAME_RE }).click();
    await drawer.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await drawer.getByRole('menuitem', { name: 'เปิดใช้งาน' }).click();
    await drawer.getByLabel('เหตุผล').fill('คืนสถานะ');
    await drawer.getByRole('button', { name: 'เปิดใช้งาน' }).click();
    await expect(drawer.getByText('ใช้งาน', { exact: true }).first()).toBeVisible();
  });
});
