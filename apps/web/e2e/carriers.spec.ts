import { expect, test } from './fixtures';

/**
 * E2E ST2-T05 รถร่วม / ผู้รับเหมา: เปิดหน้า "คนขับและผู้รับเหมา" → เพิ่มผู้รับเหมานิติบุคคลพร้อมบัญชีรับเงิน
 * (เลขบัญชีกลับมาเป็น •••• 1234) → เพิ่มบุคคลธรรมดา (เลขบัตรไม่แสดงเต็ม) → ระงับชั่วคราว (เหตุผล) — ผ่าน API จริง (ฐาน tms_e2e)
 */
const RUN = String(Date.now()).slice(-6);
const NAME = `หจก. อีทูอีขนส่ง ${RUN}`;
const PERSON = `นายอีทูอี ทดสอบ ${RUN}`;

/** เลขผู้เสียภาษี 13 หลัก checksum ถูก (ข้อมูลสมมติ) */
function taxId(prefix: string): string {
  const base = (prefix + RUN).padEnd(12, '0').slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

test.describe.serial('รถ → คนขับและผู้รับเหมา (ผู้รับเหมา)', () => {
  test('เปิดหน้า → แท็บผู้รับเหมา คอลัมน์ตามต้นแบบ', async ({ page }) => {
    await page.goto('/fleet/drivers');
    await expect(page.getByRole('heading', { name: 'คนขับและผู้รับเหมา', level: 1 })).toBeVisible();
    // แท็บเริ่มต้น = คนขับ (ST2-T08) → สลับไปผู้รับเหมา
    await expect(page.getByRole('tab', { name: /^คนขับ/, selected: true })).toBeVisible();
    await page.getByRole('tab', { name: /ผู้รับเหมา/ }).click();
    await expect(page.getByRole('tab', { name: /ผู้รับเหมา/, selected: true })).toBeVisible();
    for (const c of ['ชื่อ', 'เลขผู้เสียภาษี', 'บุคคล / นิติบุคคล', 'จำนวนรถ', 'หัก ณ ที่จ่าย'])
      await expect(page.getByRole('columnheader', { name: c, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'เพิ่มผู้รับเหมา' })).toBeVisible();
  });

  test('เพิ่มนิติบุคคลพร้อมบัญชี → เลขบัญชีปิดบัง → บุคคลธรรมดา → ระงับชั่วคราว', async ({
    page,
  }) => {
    await page.goto('/fleet/drivers?tab=con');
    await page.getByRole('button', { name: 'เพิ่มผู้รับเหมา' }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('เพิ่มผู้รับเหมาใหม่')).toBeVisible();
    await d.getByRole('button', { name: 'บันทึก' }).click();
    await expect(d.getByText('กรอกข้อมูลให้ครบ 2 ช่อง')).toBeVisible();
    await expect(d.getByText('กรุณากรอกชื่อผู้รับเหมา')).toBeVisible();
    await d.getByLabel('ชื่อผู้รับเหมา').fill(NAME);
    await d.getByLabel('เลขผู้เสียภาษี').fill(taxId('0105'));
    await d.getByLabel('LINE ID').fill('@e2e-sub');
    await d.getByLabel('ธนาคาร').selectOption('KBANK');
    await d.getByLabel('เลขบัญชี', { exact: true }).fill('123-4-56789-1');
    await d.getByLabel('ชื่อบัญชี').fill(NAME);
    await d.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`เพิ่ม ${NAME} แล้ว`);
    const dr = page.getByRole('dialog');
    await expect(dr.getByText('ผู้รับเหมา · นิติบุคคล')).toBeVisible();
    // เลขบัญชีไม่กลับมาที่หน้าจอ — แสดงเป็น •••• 4 หลักท้าย
    await expect(dr.getByLabel('เลขบัญชี', { exact: true })).toHaveValue('');
    await expect(dr.getByLabel('เลขบัญชี', { exact: true })).toHaveAttribute(
      'placeholder',
      '•••• 7891',
    );
    await expect(page.locator('body')).not.toContainText('1234567891');
    await page.keyboard.press('Escape');

    // บุคคลธรรมดา: เลขบัตรประชาชนแสดงเฉพาะ 4 หลักท้ายในตาราง
    const nid = taxId('3100');
    await page.getByRole('button', { name: 'เพิ่มผู้รับเหมา' }).click();
    const d2 = page.getByRole('dialog');
    await d2.getByLabel('ชื่อผู้รับเหมา').fill(PERSON);
    await d2.getByLabel('ประเภท', { exact: true }).selectOption('INDIVIDUAL');
    await d2.getByLabel('เลขผู้เสียภาษี').fill(nid);
    await d2.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`เพิ่ม ${PERSON} แล้ว`);
    await page.keyboard.press('Escape');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(RUN);
    const row = page.locator('tbody tr', { hasText: PERSON });
    await expect(row).toContainText(`•••• ${nid.slice(-4)}`);
    await expect(row).not.toContainText(nid);
    await expect(row).toContainText('บุคคล');

    // ระงับชั่วคราว (เหตุผล ≥ 10) จากเมนู ⋯ ของแถว
    const r1 = page.locator('tbody tr', { hasText: NAME });
    await r1.getByRole('button', { name: 'การกระทำ' }).click();
    await page.getByRole('menuitem', { name: 'ระงับชั่วคราว' }).click();
    const dlg = page.getByRole('dialog', { name: /ระงับผู้รับเหมา/ });
    await dlg.getByLabel('เหตุผล').fill('เอกสารรถหมดอายุ รอต่ออายุ');
    await dlg.getByRole('button', { name: 'ระงับชั่วคราว' }).click();
    await expect(page.getByRole('status')).toContainText(`อัปเดตสถานะ ${NAME} แล้ว`);
    await expect(page.locator('tbody tr', { hasText: NAME })).toContainText('ระงับชั่วคราว');
  });
});
