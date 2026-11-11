import { expect, test } from './fixtures';

/**
 * E2E ST2-T17 เอกสารรถ: เพิ่มรถ → drawer แท็บ "เอกสารแนบ" → เพิ่ม พ.ร.บ. (แนบ PDF) → ซ้ำประเภทเดิมถูกปฏิเสธ
 * → ต่ออายุ → ฉบับใหม่เป็นฉบับปัจจุบัน และฉบับเดิมอยู่ใน "ประวัติการต่ออายุ"
 * ผ่าน API จริง (ฐาน tms_e2e) — ทะเบียนสุ่มต่อรอบ
 */
const RUN = String(Date.now()).slice(-4);
const PLATE = `74-${RUN}`;
const PDF = {
  name: 'พรบ-ทดสอบ.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),
};

test('เอกสารรถ: เพิ่ม + ต่ออายุจาก drawer — ฉบับเดิมยังอยู่ในประวัติ', async ({ page }) => {
  await page.goto('/fleet/vehicles');
  await page.getByRole('button', { name: 'เพิ่มรถ' }).click();
  const c = page.getByRole('dialog');
  await c.getByLabel('ทะเบียน').fill(PLATE);
  await c.getByLabel('ประเภทรถ').selectOption({ label: '6 ล้อ' });
  await c.getByRole('button', { name: 'เพิ่มรถ' }).click();
  await expect(page.getByRole('status')).toContainText(`เพิ่มรถ ${PLATE} กทม. แล้ว`);
  // หลังเพิ่มรถ drawer รถเปิดค้างไว้ (คลิกแถวในตาราง = โปรไฟล์รถ ST2-T07)
  await page.getByRole('tab', { name: 'เอกสารแนบ' }).click();
  await expect(page.getByText('ไม่มีเอกสารสำหรับรถคันนี้')).toBeVisible();

  // เพิ่ม พ.ร.บ.
  await page.getByRole('button', { name: 'เพิ่มเอกสาร' }).click();
  const add = page.getByRole('dialog', { name: 'เพิ่มเอกสาร' });
  await add.getByLabel('ประเภทเอกสาร').selectOption({ label: 'พ.ร.บ.' });
  await add.getByLabel('เลขที่').fill(`CMI-${RUN}-1`);
  await add.getByLabel('เริ่ม').fill('2026-01-15');
  await add.getByLabel('หมดอายุ').fill('2026-01-10');
  await expect(add.getByText('วันหมดอายุต้องหลังวันเริ่ม')).toBeVisible();
  await expect(add.getByRole('button', { name: 'บันทึกเอกสาร' })).toBeDisabled();
  await add.getByLabel('หมดอายุ').fill('2027-01-15');
  await add.getByLabel('บริษัท / หน่วยงาน').fill('บริษัท ประกันสมมติ จำกัด');
  await add.getByLabel('เบี้ย / ค่าใช้จ่าย (฿)').fill('1,830');
  await add.getByTestId('vdoc-file').setInputFiles(PDF);
  await expect(add.getByText(PDF.name)).toBeVisible();
  // กดบันทึกรัว ๆ → ได้เอกสารฉบับเดียว (review ST2-T17)
  await add.getByRole('button', { name: 'บันทึกเอกสาร' }).dblclick();
  await expect(page.getByRole('status').filter({ hasText: 'เพิ่มพ.ร.บ.' })).toContainText(
    `เพิ่มพ.ร.บ. ${PLATE} กทม. แล้ว`,
  );
  const list = page.getByTestId('vdoc-list');
  await expect(list.getByText(`พ.ร.บ. · CMI-${RUN}-1`)).toBeVisible();

  // ประเภทเดิมซ้ำ → ให้ต่ออายุแทน
  await page.getByRole('button', { name: 'เพิ่มเอกสาร' }).click();
  const dup = page.getByRole('dialog', { name: 'เพิ่มเอกสาร' });
  await dup.getByLabel('ประเภทเอกสาร').selectOption({ label: 'พ.ร.บ.' });
  await dup.getByLabel('เลขที่').fill(`CMI-${RUN}-X`);
  await dup.getByTestId('vdoc-file').setInputFiles(PDF);
  await expect(dup.getByText(PDF.name)).toBeVisible();
  await dup.getByRole('button', { name: 'บันทึกเอกสาร' }).click();
  await expect(dup.getByText('รถคันนี้มีพ.ร.บ.ฉบับปัจจุบันแล้ว — ใช้ "ต่ออายุ" แทน')).toBeVisible();
  await dup.getByRole('button', { name: 'ยกเลิก' }).click();

  // Esc ใน modal ปิดเฉพาะ modal — drawer ยังอยู่
  await list.getByRole('button', { name: 'ต่ออายุ' }).click();
  await expect(page.getByRole('dialog', { name: 'ต่ออายุพ.ร.บ.' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'ต่ออายุพ.ร.บ.' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'เอกสารแนบ' })).toBeVisible();
  await expect(list.getByText(`พ.ร.บ. · CMI-${RUN}-1`)).toHaveCount(1);

  // ต่ออายุ
  await list.getByRole('button', { name: 'ต่ออายุ' }).click();
  const rnw = page.getByRole('dialog', { name: 'ต่ออายุพ.ร.บ.' });
  await expect(rnw.getByText(`เลขเดิม CMI-${RUN}-1`)).toBeVisible();
  await expect(rnw.getByLabel('เริ่ม')).toHaveValue('2027-01-15');
  await expect(rnw.getByLabel('หมดอายุ')).toHaveValue('2028-01-15');
  await expect(rnw.getByLabel('บริษัท / หน่วยงาน')).toHaveValue('บริษัท ประกันสมมติ จำกัด');
  await expect(rnw.getByText('กรอกเลขที่ใหม่และแนบไฟล์')).toBeVisible();
  await rnw.getByLabel('เลขที่ใหม่').fill(`CMI-${RUN}-2`);
  await rnw.getByTestId('vdoc-file').setInputFiles(PDF);
  await expect(rnw.getByText('บันทึกแล้วเอกสารมีผลถึง 15 ม.ค. 2571')).toBeVisible();
  await rnw.getByRole('button', { name: 'บันทึกการต่ออายุ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ต่ออายุ' })).toContainText(
    `ต่ออายุพ.ร.บ. ${PLATE} กทม. ถึง 15 ม.ค. 2571 แล้ว`,
  );
  await expect(list.getByText(`พ.ร.บ. · CMI-${RUN}-2`)).toBeVisible();
  await expect(list.getByText(`CMI-${RUN}-1`)).toHaveCount(0);

  // เกณฑ์ตรวจรับ: ฉบับเก่ายังอยู่ในประวัติ
  await page.getByRole('button', { name: 'ประวัติการต่ออายุ (1)' }).click();
  const hist = page.getByTestId('vdoc-history');
  await expect(hist.getByText(`พ.ร.บ. · CMI-${RUN}-1`)).toBeVisible();
  await expect(hist.getByText('ต่ออายุแล้ว')).toBeVisible();
  await expect(hist.getByText('15 ม.ค. 2569 – 15 ม.ค. 2570')).toBeVisible();

  // แท็บกิจกรรมของรถแสดงประวัติเอกสาร
  await page.getByRole('tab', { name: 'กิจกรรม' }).click();
  await expect(page.getByText(`ต่ออายุ พ.ร.บ. CMI-${RUN}-2`)).toBeVisible();
  await expect(page.getByText(`เพิ่มเอกสาร พ.ร.บ. CMI-${RUN}-1`)).toBeVisible();
});
