import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

/** E2E ST1-T03: ลืมรหัสผ่าน (TMS Signup au.forgot) → ลิงก์จากอีเมล → ตั้งรหัสใหม่ → เข้าระบบด้วยรหัสใหม่ */
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
const DEMO_A = '00000000-0000-4000-8000-00000000000a';

test.afterAll(async () => db.$disconnect());

test('ลืมรหัสผ่าน → ส่งลิงก์ → ตั้งรหัสใหม่ → login ได้; ลิงก์ใช้ซ้ำไม่ได้', async ({ page }) => {
  // ผู้ใช้ใหม่ทุกรอบ — ไม่กระทบรหัสของผู้ใช้เดโมที่ spec อื่นใช้
  const email = `reset-${Date.now()}@demo-a.test`;
  const role = await db.role.findFirst({ where: { tenantId: DEMO_A, code: 'planner' } });
  const u = await db.appUser.create({
    data: { tenantId: DEMO_A, email, name: 'ลืมรหัส ทดสอบ', status: 'ACTIVE', passwordHash: 'x' },
  });
  await db.userRole.create({ data: { tenantId: DEMO_A, userId: u.id, roleId: role.id } });

  await page.goto('/login');
  await page.getByRole('link', { name: 'ลืมรหัสผ่าน' }).click();
  await expect(page).toHaveURL(/\/forgot$/);
  await expect(page.getByRole('heading', { level: 1, name: 'ลืมรหัสผ่าน' })).toBeVisible();
  await expect(
    page.getByText('เราจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมล ลิงก์ใช้ได้ 30 นาที'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'ส่งลิงก์' }).click();
  await expect(page.getByRole('alert')).toHaveText('กรอกอีเมล');
  await page.getByLabel('อีเมล').fill(email);
  await page.getByRole('button', { name: 'ส่งลิงก์' }).click();
  await expect(page.getByRole('status')).toHaveText(
    `ส่งลิงก์ไปที่ ${email} แล้ว ตรวจกล่องจดหมายและโฟลเดอร์ขยะ`,
  );

  // อีเมลรอใน outbox (E2E ไม่รัน worker) — ดึงลิงก์จากเนื้อหา
  const mail = await db.emailOutbox.findFirst({ where: { toAddress: email } });
  const token = /reset-password#token=([A-Za-z0-9_-]+)/.exec(mail?.textBody ?? '')?.[1];
  expect(token).toBeTruthy();

  await page.goto(`/reset-password#token=${token}`);
  await expect(page.getByRole('heading', { level: 1, name: 'ตั้งรหัสผ่านใหม่' })).toBeVisible();
  await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('short');
  await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill('short');
  await page.getByRole('button', { name: 'ตั้งรหัสผ่านใหม่' }).click();
  await expect(page.getByRole('alert')).toHaveText('รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษร');
  await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('e2e-reset-password-2569');
  await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill('e2e-reset-password-2569');
  await page.getByRole('button', { name: 'ตั้งรหัสผ่านใหม่' }).click();
  await expect(page.getByRole('status')).toContainText('ตั้งรหัสผ่านใหม่แล้ว');
  await expect(page).toHaveURL(/\/reset-password$/); // token ถูกล้างออกจาก URL

  await page.getByRole('link', { name: 'กลับไปเข้าสู่ระบบ' }).click();
  await page.getByLabel('อีเมล').fill(email);
  await page.getByLabel('รหัสผ่าน').fill('e2e-reset-password-2569');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByText('ลืมรหัส ทดสอบ')).toBeVisible();

  // ลิงก์เดิมใช้ซ้ำไม่ได้
  await page.goto(`/reset-password#token=${token}`);
  await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('another-reset-pass-2569');
  await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill('another-reset-pass-2569');
  await page.getByRole('button', { name: 'ตั้งรหัสผ่านใหม่' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'ลิงก์ตั้งรหัสผ่านไม่ถูกต้อง หมดอายุ หรือใช้ไปแล้ว ขอลิงก์ใหม่อีกครั้ง',
  );
  await expect(page.getByRole('link', { name: 'ขอลิงก์ใหม่' })).toHaveAttribute('href', '/forgot');
});
