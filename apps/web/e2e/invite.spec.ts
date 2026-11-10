import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEMO_TOTP_SECRET, expect, test, totp } from './fixtures';

/** E2E ST1-T07: เชิญผู้ใช้จากตั้งค่า (step-up) → ลิงก์ในอีเมล → ตั้งรหัส → เข้าระบบด้วย role ที่กำหนด */
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

// admin (ไม่ใช่ owner) — แยก time-step TOTP จาก spec อื่นที่ใช้ owner
test.use({ loginEmail: 'admin@demo-a.test' });
test.afterAll(async () => db.$disconnect());

test('เชิญผู้ใช้ → รับคำเชิญ → login ด้วย role ที่กำหนด', async ({ page, browser }) => {
  const email = `invite-${Date.now()}@demo-a.test`;
  await page.goto('/settings?sec=users');
  await page.getByRole('button', { name: 'เชิญผู้ใช้' }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('อีเมล').fill(email);
  await drawer.getByLabel('ชื่อ', { exact: true }).fill('ผู้ถูกเชิญ ทดสอบ');
  await drawer.getByRole('checkbox', { name: 'ผู้วางแผน' }).check();
  await page.getByRole('button', { name: 'ส่งคำเชิญ' }).click();
  const box = page.getByRole('group', { name: 'ยืนยันตัวตน 2 ชั้นอีกครั้ง' });
  await box.getByLabel('รหัส 6 หลัก').fill(totp(DEMO_TOTP_SECRET));
  await box.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(page.getByRole('status')).toHaveText('ส่งคำเชิญทางอีเมลแล้ว');
  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row.getByText('รอตอบรับคำเชิญ')).toBeVisible();

  const mail = await db.emailOutbox.findFirst({ where: { toAddress: email } });
  const token = /invite#token=([A-Za-z0-9_-]+)/.exec(mail?.textBody ?? '')?.[1];
  expect(token).toBeTruthy();

  // ผู้รับเปิดลิงก์ในเบราว์เซอร์ใหม่ (ไม่มี session)
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/invite#token=${token}`);
  await expect(guest.getByRole('heading', { level: 1, name: 'รับคำเชิญ' })).toBeVisible();
  await expect(guest.getByText('ในบทบาท ผู้วางแผน')).toBeVisible();
  await expect(guest.getByLabel('อีเมล')).toHaveValue(email);
  await guest.getByLabel('ตั้งรหัสผ่าน').fill('invited-person-2569');
  await guest.getByLabel('ยืนยันรหัสผ่าน').fill('invited-person-2569');
  await guest.getByRole('button', { name: 'รับคำเชิญ' }).click();
  await expect(guest.getByRole('status')).toContainText('เข้าร่วม');
  await guest.getByRole('link', { name: 'กลับไปเข้าสู่ระบบ' }).click();
  await guest.getByLabel('อีเมล').fill(email);
  await guest.getByLabel('รหัสผ่าน').fill('invited-person-2569');
  await guest.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(guest.getByText('ผู้ถูกเชิญ ทดสอบ')).toBeVisible();

  // ลิงก์ใช้ซ้ำไม่ได้
  await guest.goto(`/invite#token=${token}`);
  await expect(guest.getByRole('alert')).toHaveText(
    'ลิงก์คำเชิญไม่ถูกต้อง หมดอายุ หรือใช้ไปแล้ว ขอให้ผู้ดูแลส่งคำเชิญใหม่',
  );
});
