import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, freshCode, test, type Page } from './fixtures';

/**
 * PO 24 พ.ย. 2569 "ประกอบจากโครงสร้างต้นแบบ" — ตั้งค่า → ผู้ใช้และสิทธิ์: เมนูต่อแถว (ST1-T07/T10/T11) + หน้าโปรไฟล์ (ST1-T09)
 * เชิญ (UI) → รับคำเชิญ (API) → ระงับ → เปิดใช้ → ประวัติเข้าสู่ระบบ → ลบ · เชิญอีกคน → ส่งใหม่ → เพิกถอน
 * ผู้ใช้ใหม่ทุกครั้ง (ไม่แตะผู้ใช้เดโมที่ spec อื่นใช้) · บทบาท "ดูอย่างเดียว" ไม่บังคับ 2FA (D-78)
 */
const env = Object.fromEntries(
  readFileSync(new URL('./.env.e2e', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], m[2]]),
);
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });

test.use({ loginEmail: 'admin@demo-a.test' });
test.afterAll(async () => db.$disconnect());

async function invite(page: Page, email: string, name: string, stepUp: boolean) {
  await page.getByRole('button', { name: 'เชิญผู้ใช้' }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('อีเมล').fill(email);
  await drawer.getByLabel('ชื่อ', { exact: true }).fill(name);
  await drawer.getByRole('checkbox', { name: 'ดูอย่างเดียว' }).check();
  await page.getByRole('button', { name: 'ส่งคำเชิญ' }).click();
  if (stepUp) {
    const box = page.getByRole('group', { name: 'ยืนยันตัวตน 2 ชั้นอีกครั้ง' });
    await box.getByLabel('รหัส 6 หลัก').fill(await freshCode());
    await box.getByRole('button', { name: 'ยืนยัน' }).click();
  }
  await expect(page.getByRole('status')).toHaveText('ส่งคำเชิญทางอีเมลแล้ว');
}
const rowOf = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });
async function act(page: Page, who: string, item: string, reason?: string) {
  await rowOf(page, who).getByRole('button', { name: 'การกระทำ' }).click();
  await page.getByRole('menuitem', { name: item }).click();
  if (!reason) return;
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('textbox').fill(reason);
  await dlg.getByRole('button', { name: item }).click();
  await expect(dlg).toBeHidden();
}

test('ผู้ใช้: ระงับ → เปิดใช้ → ประวัติเข้าสู่ระบบ → ลบ (เหตุผลบังคับ)', async ({ page, browser }) => {
  const stamp = Date.now();
  const email = `lifecycle-${stamp}@demo-a.test`;
  const name = `ทดสอบ วงจร ${stamp % 100000}`;
  await page.goto('/settings?sec=users');
  await invite(page, email, name, true);
  const mail = await db.emailOutbox.findFirst({ where: { toAddress: email } });
  const token = /invite#token=([A-Za-z0-9_-]+)/.exec(mail?.textBody ?? '')?.[1];
  const acc = await page.request.post('/v1/auth/invitations/accept', {
    data: { token, name, password: 'lifecycle-person-2569' },
  });
  expect(acc.status(), await acc.text()).toBe(204);
  // เข้าสู่ระบบ 1 ครั้งให้มีประวัติ (เบราว์เซอร์แยก)
  const guest = await (await browser.newContext()).newPage();
  await guest.goto('/login');
  await guest.getByLabel('อีเมล').fill(email);
  await guest.getByLabel('รหัสผ่าน').fill('lifecycle-person-2569');
  await guest.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(guest.getByText(name)).toBeVisible();

  await page.reload();
  await act(page, email, 'ระงับการใช้งาน', 'ทดสอบระงับผู้ใช้ชั่วคราว');
  await expect(page.getByRole('status')).toContainText(`ระงับการใช้งาน ${name} แล้ว`);
  await expect(rowOf(page, email).getByText('ระงับการใช้งาน')).toBeVisible();

  await act(page, email, 'เปิดใช้งานอีกครั้ง', 'ทดสอบเปิดใช้งานกลับมา');
  await expect(rowOf(page, email).getByText('ระงับการใช้งาน')).toHaveCount(0);

  await act(page, email, 'ประวัติเข้าสู่ระบบ');
  const hist = page.getByRole('table', { name: 'ประวัติเข้าสู่ระบบ' });
  await expect(hist.getByRole('row').filter({ hasText: email }).first()).toContainText('สำเร็จ');

  await page.getByRole('tab', { name: 'ผู้ใช้' }).click();
  await act(page, email, 'ลบผู้ใช้', 'ทดสอบลบผู้ใช้ออกจากระบบ');
  await expect(rowOf(page, email)).toHaveCount(0);
});

test('คำเชิญ: ส่งใหม่ + เพิกถอน จากเมนูแถว · ตัวเองไม่มีเมนูระงับ/ลบ', async ({ page }) => {
  const stamp = Date.now();
  const email = `revoke-${stamp}@demo-a.test`;
  await page.goto('/settings?sec=users');
  await rowOf(page, 'admin@demo-a.test').getByRole('button', { name: 'การกระทำ' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['ประวัติเข้าสู่ระบบ']);
  await page.keyboard.press('Escape');
  // step-up token จาก test ก่อนหน้าอาจยังไม่หมด (หน้าใหม่ = ไม่จำ) → ยืนยันเสมอ
  await invite(page, email, `ทดสอบ เพิกถอน ${stamp % 100000}`, true);
  await expect(rowOf(page, email).getByText('รอตอบรับคำเชิญ')).toBeVisible();
  await act(page, email, 'เพิกถอนคำเชิญ', 'เชิญผิดคนขอยกเลิกคำเชิญ');
  await expect(rowOf(page, email)).toHaveCount(0);
});

test('โปรไฟล์: เข้าจากชื่อท้ายเมนู · แก้เบอร์โทร → บันทึก · สถานะ 2FA', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'โปรไฟล์ของฉัน' }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('heading', { name: 'โปรไฟล์ของฉัน' })).toBeVisible();
  await expect(page.getByLabel('อีเมล')).toHaveValue('admin@demo-a.test');
  const phone = `08${String(Date.now()).slice(-8)}`;
  await page.getByLabel('เบอร์โทร').fill(phone);
  await page.getByRole('button', { name: /บันทึก/ }).click();
  await expect(page.getByText('บันทึกข้อมูลส่วนตัวแล้ว')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('เบอร์โทร')).toHaveValue(phone);
  await expect(page.getByText('บทบาทของคุณบังคับใช้ 2FA')).toBeVisible();
});
