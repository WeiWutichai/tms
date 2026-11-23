import type { Page } from '@playwright/test';
import { confirmStepUp, DEMO_PASSWORD, E2E_WEB, expect, freshCode, test } from './fixtures';

/**
 * ST7-T20 หน้าจัดการ connector — เกณฑ์ตรวจรับ:
 * Innovera เปิด connector demo ให้ tenant จาก admin portal; tenant เห็นสถานะและกด healthCheck ได้; credential ไม่แสดงเต็ม
 * + ST7-T17 "ใครออกเลขเอกสาร" (เจ้าของเอกสารภาษี) เปลี่ยนได้พร้อมเหตุผล
 */
const KEY = `demo-e2e-key-${Date.now() % 1_000_000}`;

async function consoleLogin(p: Page) {
  await p.goto(`${E2E_WEB}/console/login`);
  await p.getByLabel('อีเมล').fill('super-admin@platform.test');
  await p.getByLabel('รหัสผ่าน').fill(DEMO_PASSWORD);
  await p.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  // รหัสใช้ซ้ำไม่ได้ (server ไม่รับ step ≤ step ล่าสุดของผู้ใช้) — ใช้ step ที่ยังไม่ถูกใช้จาก fixtures แทนการลองเดา offset
  // (รหัสที่ถูกปฏิเสธนับเป็นความพยายามล้มเหลวของ super-admin — ครบ 5 ครั้งล็อกบัญชี)
  await p.getByLabel('รหัส 6 หลัก').fill(await freshCode('super-admin@platform.test'));
  await p.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(p).toHaveURL(/\/console\/tenants/);
}

test('Innovera เปิด connector demo ให้ลูกค้า → ลูกค้าเห็นสถานะ กดทดสอบได้ และไม่เห็น credential', async ({
  page,
  browser,
}) => {
  const con = await (await browser.newContext({ locale: 'th-TH' })).newPage();
  await consoleLogin(con);
  await con.getByRole('button', { name: 'Connector ระบบบัญชี' }).click();
  await expect(con.getByRole('heading', { name: 'Connector ระบบบัญชี', level: 1 })).toBeVisible();
  await con.getByRole('button', { name: 'เปิด connector' }).click();
  const dlg = con.getByRole('dialog', { name: 'เปิด connector' });
  await dlg.getByLabel('บริษัท').selectOption({ label: 'ตัวอย่างขนส่ง (DEMO)' });
  await dlg.getByLabel('ระบบ', { exact: true }).selectOption('demo');
  await dlg.getByLabel('API key').fill(KEY);
  await dlg.getByLabel('เหตุผล').fill('เปิด connector ให้ลูกค้านำร่อง (E2E)');
  await dlg.getByRole('button', { name: 'เปิด connector' }).click();
  // D-77 (PO 23 พ.ย. 2569): เปิดพร้อม credential → ยืนยัน 2FA ซ้ำ (กล่อง StepUpBox ในกล่องเดิม) แล้วส่งซ้ำเอง
  await confirmStepUp(con, 'super-admin@platform.test');
  await expect(con.getByRole('status')).toContainText(
    'เปิด ERP จำลอง (Demo) ให้ ตัวอย่างขนส่ง (DEMO) แล้ว',
  );
  const drawer = con.getByRole('dialog', { name: 'ERP จำลอง (Demo)' });
  await expect(drawer.getByText('apiKey ••••••••')).toBeVisible();
  await expect(con.getByText(KEY)).toHaveCount(0);

  // ฝั่งลูกค้า
  await page.goto('/settings?sec=conn');
  const card = page.getByRole('group', { name: 'ERP จำลอง (Demo)' });
  await expect(card.getByText('เชื่อมต่อ', { exact: true })).toBeVisible();
  await expect(page.getByText('ERP จำลอง (Demo) เชื่อมต่อ')).toBeVisible(); // ท้าย sidebar
  await card.getByRole('button', { name: 'ทดสอบ' }).click();
  await expect(page.getByRole('status')).toContainText('ทดสอบการเชื่อมต่อ ERP จำลอง (Demo) สำเร็จ');
  const detail = page.getByTestId('connector-detail');
  await expect(detail.getByTestId('credential-row').first()).toContainText('••••••••');
  expect(await page.content()).not.toContain(KEY);

  // ST7-T17 ใครออกเลขเอกสาร = เจ้าของเอกสารภาษี (ไม่มีค่าเริ่มต้น — ต้องเลือก, D-53) — เปลี่ยนต้องมีเหตุผล
  const num = detail.getByRole('radiogroup', { name: 'ใครออกเลขเอกสาร' });
  for (const r of await num.getByRole('radio').all())
    await expect(r).toHaveAttribute('aria-checked', 'false');
  await expect(detail.getByText(/ยังไม่ได้เลือก/)).toBeVisible();
  await num.getByRole('radio', { name: 'TMS ออกเลข แล้วส่งให้ ERP จำลอง (Demo)' }).click();
  const nd = page.getByRole('dialog');
  await nd.getByLabel(/เหตุผล/).fill('ตกลงกับลูกค้าให้ TMS ออกใบกำกับภาษี (E2E)');
  await nd.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.getByRole('status')).toContainText('บันทึกการตั้งค่าการเชื่อมต่อแล้ว');
  await expect(
    num.getByRole('radio', { name: 'TMS ออกเลข แล้วส่งให้ ERP จำลอง (Demo)' }),
  ).toHaveAttribute('aria-checked', 'true');

  // ตัดการเชื่อมต่อ (เหตุผล ≥ 10) — กลับเป็นไม่เชื่อม (เก็บกวาดให้ spec อื่น)
  await card.getByRole('button', { name: 'ตัดการเชื่อมต่อ' }).click();
  const rd = page.getByRole('dialog');
  await rd.getByLabel(/เหตุผล/).fill('จบการทดสอบ E2E ของ connector');
  await rd.getByRole('button', { name: 'ตัดการเชื่อมต่อ' }).click();
  await expect(page.getByRole('status')).toContainText('ตัดการเชื่อมต่อ ERP จำลอง (Demo) แล้ว');
  await expect(page.getByText('ไม่ได้เชื่อมระบบบัญชี')).toBeVisible();
});
