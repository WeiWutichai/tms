import { expect, test, type Page } from '@playwright/test';
import { DEMO_PASSWORD, DEMO_TOTP_SECRET, totp } from './fixtures';

/**
 * Platform Console (ST1-T24) — login 2 ขั้น + ลูกค้า + เข้าใช้งานแทน
 * ไม่ใช้ fixture loggedIn ของแอปลูกค้า: Console มี login/token ของตัวเอง และแท็บที่เข้าใช้งานแทนต้องไม่พึ่ง refresh cookie
 * ผู้ใช้ทีมงานจาก seed: super-admin / support / billing @platform.test · TOTP เดียวกับผู้ใช้เดโม
 */
async function consoleLogin(page: Page, email: string) {
  await page.goto('/console');
  await expect(page).toHaveURL(/\/console\/login/);
  await page.getByLabel('อีเมล').fill(email);
  await page.getByLabel('รหัสผ่าน').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.getByLabel('รหัส 6 หลัก').fill(totp(DEMO_TOTP_SECRET));
  await page.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(page).toHaveURL(/\/console\/tenants$/);
  await expect(page.getByRole('heading', { name: 'ลูกค้า', level: 1 })).toBeVisible();
}

const row = (page: Page, name: string) => page.locator('tbody tr', { hasText: name });

test.describe('Platform Console', () => {
  test('รหัสผ่านผิดไม่ผ่านขั้นแรก และ reload = ต้องเข้าสู่ระบบใหม่', async ({ page }) => {
    await page.goto('/console/tenants');
    await expect(page).toHaveURL(/\/console\/login\?next=/);
    await page.getByLabel('อีเมล').fill('billing@platform.test');
    await page.getByLabel('รหัสผ่าน').fill('wrong-password-0000');
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByRole('alert')).toHaveText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    await page.getByLabel('รหัสผ่าน').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await page.getByLabel('รหัส 6 หลัก').fill(totp(DEMO_TOTP_SECRET));
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page).toHaveURL(/\/console\/tenants$/);
    // billing: เปลี่ยนแพ็กเกจได้ แต่สร้าง/ระงับ/เข้าใช้งานแทนไม่ได้ (ปุ่มไม่แสดง)
    await expect(page.getByRole('button', { name: 'เพิ่มลูกค้า' })).toHaveCount(0);
    await row(page, 'ตัวอย่างขนส่ง (DEMO)').click();
    const drawer = page.getByRole('dialog', { name: 'ตัวอย่างขนส่ง (DEMO)' });
    await expect(drawer.getByRole('button', { name: 'เปลี่ยนแพ็กเกจ' })).toHaveCount(2);
    await expect(drawer.getByRole('button', { name: 'ระงับบัญชี' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'เข้าใช้งานแทน' })).toHaveCount(0);
    // token อยู่ในหน่วยความจำเท่านั้น
    await page.reload();
    await expect(page).toHaveURL(/\/console\/login/);
  });

  test('super admin: เห็นลูกค้าเดโม, เพิ่มลูกค้า, เปลี่ยนแพ็กเกจ, ระงับ และปลดระงับ', async ({
    page,
  }) => {
    await consoleLogin(page, 'super-admin@platform.test');
    await expect(row(page, 'ตัวอย่างขนส่ง (DEMO)')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'เมนู Platform Console' })).toBeVisible();

    // เพิ่มลูกค้า (ต้นแบบไม่มี — dialog แบบเดียวกับการกระทำอื่น)
    const name = `บจก. ทดสอบคอนโซล ${Date.now() % 100000}`;
    await page.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
    const dlg = page.getByRole('dialog', { name: 'เพิ่มลูกค้า' });
    await dlg.getByLabel('ชื่อบริษัท').fill(name);
    await dlg.getByLabel('ชื่อเจ้าของบริษัท').fill('สมหญิง ทดสอบ');
    await dlg.getByLabel('อีเมลเจ้าของบริษัท').fill(`owner-${Date.now()}@console.test`);
    await dlg.getByLabel('โควตารถ (คัน)').fill('25');
    const ok = dlg.getByRole('button', { name: 'เพิ่มลูกค้า' });
    await dlg.getByLabel('เหตุผล').fill('สั้นไป');
    await expect(dlg.getByText('อีก 4 ตัวอักษร')).toBeVisible();
    await expect(ok).toBeDisabled();
    await dlg.getByLabel('เหตุผล').fill('ลูกค้านำร่องเซ็นสัญญาแล้ว');
    await ok.click();
    await expect(page.getByRole('status')).toContainText(`เพิ่ม ${name} แล้ว`);

    const drawer = page.getByRole('dialog', { name });
    await expect(drawer.getByText('ทดลองใช้')).toBeVisible();
    await expect(drawer.getByText('— / 25')).toBeVisible();
    await drawer.getByRole('tab', { name: 'ผู้ใช้' }).click();
    await expect(drawer.getByText('รอตอบรับคำเชิญ')).toBeVisible();
    await drawer.getByRole('tab', { name: 'ภาพรวม' }).click();

    // เปลี่ยนแพ็กเกจ + โควตา
    await drawer.getByRole('button', { name: 'เปลี่ยนแพ็กเกจ' }).first().click();
    const plan = page.getByRole('dialog', { name: `เปลี่ยนแพ็กเกจ · ${name}` });
    await plan.getByLabel('แพ็กเกจ').selectOption('ent');
    await plan.getByLabel('โควตารถ (คัน)').fill('');
    await plan.getByLabel('เหตุผล').fill('ลูกค้าขยายกองรถทั้งบริษัท');
    await plan.getByRole('button', { name: 'เปลี่ยนแพ็กเกจ' }).click();
    await expect(page.getByRole('status')).toContainText('เป็นแพ็กเกจองค์กรแล้ว');
    await expect(drawer.getByText('— / ไม่จำกัด')).toBeVisible();

    // ระงับ → ปลดระงับ (เหตุผล ≥ 10 ตัว)
    await drawer.getByRole('button', { name: 'ระงับบัญชี' }).click();
    const susp = page.getByRole('dialog', { name: `ระงับบัญชี · ${name}` });
    await susp.getByLabel('เหตุผล').fill('ทดสอบระงับบัญชีจาก E2E');
    await susp.getByRole('button', { name: 'ระงับบัญชี' }).click();
    await expect(page.getByRole('status')).toContainText(`ระงับ ${name} แล้ว`);
    await expect(drawer.locator('.con-badge', { hasText: 'ระงับ' })).toBeVisible();
    await expect(row(page, name).getByText('ระงับ')).toBeVisible();

    await drawer.getByRole('button', { name: 'ปลดระงับ' }).click();
    const react = page.getByRole('dialog', { name: `ปลดระงับ · ${name}` });
    await react.getByLabel('เหตุผล').fill('ลูกค้าแก้ไขปัญหาเรียบร้อย');
    await react.getByRole('button', { name: 'ปลดระงับ' }).click();
    await expect(page.getByRole('status')).toContainText(`ปลดระงับ ${name} แล้ว`);
    await expect(drawer.locator('.con-badge', { hasText: 'ใช้งาน' })).toBeVisible();

    // ค้นหาจากแถบบน
    await page.keyboard.press('Escape');
    await page.getByRole('searchbox', { name: 'ค้นหาลูกค้า' }).fill('ทดสอบคอนโซล');
    await expect(page).toHaveURL(/q=/);
    await expect(row(page, name)).toBeVisible();
    await expect(row(page, 'ตัวอย่างขนส่ง (DEMO)')).toHaveCount(0);
  });

  test('support: เข้าใช้งานแทนเปิดแท็บใหม่ แถบส้ม อ่านอย่างเดียว และกด "ออก"', async ({
    page,
    context,
  }) => {
    await consoleLogin(page, 'support@platform.test');
    await expect(page.getByRole('button', { name: 'เพิ่มลูกค้า' })).toHaveCount(0);
    await row(page, 'ตัวอย่างขนส่ง (DEMO)').click();
    const drawer = page.getByRole('dialog', { name: 'ตัวอย่างขนส่ง (DEMO)' });
    await expect(drawer.getByRole('button', { name: 'เปลี่ยนแพ็กเกจ' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'ระงับบัญชี' })).toHaveCount(0);

    await drawer.getByRole('button', { name: 'เข้าใช้งานแทน' }).click();
    const dlg = page.getByRole('dialog', { name: 'เข้าใช้งานแทน · ตัวอย่างขนส่ง (DEMO)' });
    await expect(dlg.getByText('ลูกค้าได้รับอีเมลแจ้งเมื่อมีการเข้าใช้งานแทน')).toBeVisible();
    await dlg.getByLabel('เลข ticket (ไม่บังคับ)').fill('#4412');
    await dlg.getByLabel('เหตุผล').fill('ลูกค้าแจ้งนำเข้า Excel รถไม่ผ่าน');
    const popupP = context.waitForEvent('page');
    await dlg.getByRole('button', { name: 'เข้าใช้งานแทน' }).click();
    const app = await popupP;
    await app.waitForURL('http://localhost:4520/');
    // token ไม่ค้างใน URL
    expect(app.url()).not.toContain('token');

    const banner = app.getByRole('status', { name: 'กำลังใช้งานแทน' });
    await expect(banner).toContainText('กำลังใช้งานแทน ตัวอย่างขนส่ง (DEMO) ในนาม');
    await expect(banner).toContainText(/เหลือ (59|60) นาที/);
    await expect(banner).toHaveCSS('background-color', 'rgb(143, 85, 0)');

    // เขียนไม่ได้: ระบบตอบ 403 impersonation_read_only และหน้าจอแจ้งเหตุ
    // นำทางในแอป (token อยู่ในหน่วยความจำของแท็บ — reload = ออกจากการใช้งานแทน)
    await app.getByRole('button', { name: 'ตั้งค่า', exact: true }).click();
    await app.getByRole('button', { name: 'ตั้งค่าระบบ' }).click();
    await expect(app).toHaveURL(/\/settings/);
    await expect(banner).toBeVisible();
    // รอค่าจาก API โหลดเข้าฟอร์มก่อน (ไม่งั้นค่าที่พิมพ์ถูกทับตอนโหลดเสร็จ — flaky)
    await expect(app.getByLabel('ชื่อองค์กร')).not.toHaveValue('');
    await app.getByLabel('ชื่อองค์กร').fill('เปลี่ยนชื่อระหว่างใช้งานแทน');
    await app.getByRole('button', { name: 'บันทึก' }).click();
    await expect(app.getByRole('status').filter({ hasText: 'อ่านอย่างเดียว' })).toHaveText(
      'โหมดใช้งานแทนเป็นแบบอ่านอย่างเดียว แก้ไขข้อมูลไม่ได้',
    );

    // "ออก" → ปิด session ฝั่ง server แล้วปิดแท็บ (หรือกลับหน้าเข้าสู่ระบบ)
    const ended = app.waitForResponse('**/v1/me/impersonation/end');
    const closed = app.waitForEvent('close');
    await banner.getByRole('button', { name: 'ออก' }).click();
    expect((await ended).status()).toBe(204);
    await closed;
  });

  test('ลิงก์เข้าใช้งานแทนที่ผิดหรือหมดอายุ → แจ้งว่าใช้ไม่ได้', async ({ page }) => {
    await page.goto('/impersonate#token=not-a-token');
    await expect(page.getByRole('heading', { name: 'ลิงก์เข้าใช้งานแทนใช้ไม่ได้' })).toBeVisible();
    expect(page.url()).not.toContain('token');
  });
});
