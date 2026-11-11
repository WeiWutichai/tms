import { expect, test } from './fixtures';

/**
 * E2E ST2-T02 สถานที่ / จุดรับส่ง: เพิ่ม (alias 2 ตัว + พิกัด) → ค้นด้วย alias เจอ → แก้ไข → ปิดใช้ (เหตุผล)
 * + แท็บ "ที่อยู่ส่ง" ใน drawer ลูกค้า — ผ่าน API จริง (ฐาน tms_e2e)
 */
const RUN = String(Date.now()).slice(-6);
const NAME = `คลังอีทูอี ${RUN}`;
const ALIAS1 = `E2E-DC-${RUN}`;
const ALIAS2 = `ศูนย์กระจายอีทูอี ${RUN}`;
function taxIdFor(seed: string): string {
  const base = `0777${seed}`.padEnd(12, '0').slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

test.describe.serial('ข้อมูลหลัก → สถานที่ / จุดรับส่ง', () => {
  test('เปิดหน้า → หัว แถบสรุป แท็บประเภท ตาราง', async ({ page }) => {
    await page.goto('/master/locations');
    await expect(
      page.getByRole('heading', { name: 'สถานที่ / จุดรับส่ง', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('สถานที่ทั้งหมด')).toBeVisible();
    await expect(page.getByText('ยังไม่ปักหมุด').first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /คลัง \/ ศูนย์กระจาย/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'รถเข้าได้สูงสุด' })).toBeVisible();
  });

  test('เพิ่มสถานที่ที่มี alias 2 ตัว + พิกัด → ค้นด้วย alias เจอ (เกณฑ์ตรวจรับ)', async ({
    page,
  }) => {
    await page.goto('/master/locations');
    await page.getByRole('button', { name: 'เพิ่มสถานที่' }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('เพิ่มสถานที่ / จุดรับส่ง')).toBeVisible();
    // ว่าง → error ไทย
    await d.getByRole('button', { name: 'เพิ่มสถานที่' }).click();
    await expect(d.getByText('กรุณากรอก ชื่อสถานที่')).toBeVisible();
    await d.getByLabel('ชื่อสถานที่').fill(NAME);
    await d.getByLabel('ประเภท').selectOption('WAREHOUSE');
    await d.getByLabel('ที่อยู่').fill('88/12 ถนนตัวอย่าง ต.ตัวอย่าง อ.บางพลี จ.สมุทรปราการ 10540');
    // พิกัดสลับกัน → เตือน + ปุ่มสลับ
    await d.getByLabel('พิกัด').fill('100.69110, 13.64160');
    await expect(d.getByText('พิกัดอาจสลับกัน')).toBeVisible();
    await d.getByRole('button', { name: 'สลับ lat/lng' }).click();
    await expect(d.getByLabel('พิกัด')).toHaveValue('13.64160, 100.69110');
    await d.getByLabel('ชื่อเรียกอื่น (alias)').fill(`${ALIAS1}\n${ALIAS2}`);
    await d.getByLabel('ผู้ติดต่อ').fill('คุณสมชาย · 02-000-0001');
    await d.getByRole('button', { name: 'เพิ่มสถานที่' }).click();
    await expect(page.getByRole('status')).toContainText(`เพิ่ม ${NAME} แล้ว`);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('สถานที่ · คลัง / ศูนย์กระจาย')).toBeVisible();
    await expect(drawer.getByText('13.64160, 100.69110')).toBeVisible();
    await expect(drawer.getByText(ALIAS2)).toBeVisible();
    await page.keyboard.press('Escape');

    // ค้นด้วย alias ในช่องค้นหาของคอลัมน์ "ชื่อ / ที่อยู่"
    const search = page.getByRole('columnheader').getByPlaceholder('ค้นหา').first();
    for (const q of [ALIAS1.toLowerCase(), ALIAS2]) {
      await search.fill(q);
      await expect(page.getByRole('row', { name: new RegExp(NAME) })).toBeVisible();
      await expect(page.getByRole('row', { name: new RegExp(NAME) })).toContainText(
        '13.6416, 100.6911',
      );
    }
    await search.fill(`ไม่มีจริง-${RUN}`);
    await expect(page.getByText('ไม่มีรายการที่ตรงกับตัวกรองที่เลือก')).toBeVisible();
  });

  test('แก้ไขจากเมนู ⋯ ใน drawer: รัศมี geofence → บันทึก → ตาราง + กิจกรรม', async ({ page }) => {
    await page.goto('/master/locations');
    await page.getByRole('row', { name: new RegExp(NAME) }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await page.getByRole('menuitem', { name: 'แก้ไข' }).click();
    const f = page.getByRole('dialog', { name: /แก้ไขสถานที่/ });
    await f.getByLabel('รัศมี geofence (เมตร)').fill('20');
    await f.getByRole('button', { name: 'บันทึก' }).click();
    await expect(f.getByText('ต้องอยู่ระหว่าง 50–2,000 เมตร')).toBeVisible();
    await f.getByLabel('รัศมี geofence (เมตร)').fill('450');
    await f.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`บันทึกข้อมูล ${NAME} แล้ว`);
    await expect(page.getByRole('row', { name: new RegExp(NAME) })).toContainText('450 ม.');
    const d2 = page.getByRole('dialog');
    await d2.getByRole('tab', { name: 'กิจกรรม' }).click();
    await d2.getByText('แก้ไขข้อมูล').click();
    await expect(d2.getByText('รัศมี geofence (เมตร): 300 → 450')).toBeVisible();
  });

  test('ปิดใช้ต้องมีเหตุผล ≥ 10 ตัว → ป้าย "ปิดใช้"', async ({ page }) => {
    await page.goto('/master/locations');
    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await row.getByRole('button', { name: 'การกระทำ' }).click();
    await page.getByRole('menuitem', { name: 'ปิดใช้' }).click();
    const dlg = page.getByRole('dialog', { name: /ปิดใช้สถานที่/ });
    const ok = dlg.getByRole('button', { name: 'ปิดใช้' });
    await dlg.getByLabel('เหตุผล').fill('สั้น');
    await expect(ok).toBeDisabled();
    await dlg.getByLabel('เหตุผล').fill('ปิดคลังนี้ ทดสอบอีทูอี');
    await ok.click();
    await expect(page.getByRole('status')).toContainText(`อัปเดตสถานะ ${NAME} แล้ว`);
    await expect(row).toContainText('ปิดใช้');
  });

  test('drawer ลูกค้า → แท็บ "ที่อยู่ส่ง": ว่าง → เพิ่มที่อยู่ส่ง → แสดงในรายการ', async ({
    page,
  }) => {
    const cust = `บจก. ลูกค้าจุดส่งอีทูอี ${RUN}`;
    await page.goto('/master/customers');
    await page.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
    const c = page.getByRole('dialog');
    await c.getByLabel('ชื่อลูกค้า').fill(cust);
    await c.getByLabel('เลขผู้เสียภาษี').fill(taxIdFor(RUN));
    await c.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
    await expect(page.getByRole('status')).toContainText(/เพิ่มลูกค้า CUS-\d{4} แล้ว/);
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('tab', { name: 'ที่อยู่ส่ง' }).click();
    await expect(drawer.getByText('ยังไม่มีที่อยู่ส่ง')).toBeVisible();
    await drawer.getByRole('button', { name: 'เพิ่มที่อยู่ส่ง' }).click();
    const f = page.getByRole('dialog', { name: /เพิ่มสถานที่/ });
    await expect(f.getByLabel('ลูกค้า')).toHaveValue(/^cus_/);
    await f.getByLabel('ชื่อสถานที่').fill(`โรงงานลูกค้า ${RUN}`);
    await f.getByLabel('ที่อยู่').fill('99 นิคมตัวอย่าง จ.ชลบุรี 20000');
    await f.getByRole('button', { name: 'เพิ่มสถานที่' }).click();
    await expect(drawer.getByText(`โรงงานลูกค้า ${RUN}`, { exact: true })).toBeVisible();
    await expect(drawer.getByText('ยังไม่ปักหมุด')).toBeVisible();
  });
});
