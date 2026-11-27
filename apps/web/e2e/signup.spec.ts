import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

/**
 * E2E P1-ST2-T03 สมัครขั้น 1 "สร้างบัญชี" (/signup — chunk เดียวกับ landing)
 * ฟอร์ม → OTP ทางอีเมล (อ่านจาก outbox — E2E ไม่รัน worker) → ผิด 1 ครั้ง → ถูก → ขั้น 2 ·
 * ปิดเบราว์เซอร์กลางทาง → login ด้วยอีเมล/รหัสของการสมัคร → กลับขั้นที่ค้าง · อีเมลมีบัญชีแล้ว → ลิงก์เข้าสู่ระบบ
 * (เพดานสมัคร 5 ครั้ง/IP/ชม. — spec นี้เริ่มสมัคร 2 ครั้ง)
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
const PW = 'e2e-signup-password-2569';

test.beforeEach(async ({ page }) => {
  await page.context().route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
});
test.afterAll(async () => db.$disconnect());

async function lastCode(email: string): Promise<string> {
  const m = await db.emailOutbox.findFirst({
    where: { toAddress: email, template: 'signup_otp' },
    orderBy: { createdAt: 'desc' },
  });
  // หัวเรื่องไม่มีรหัส (คงอยู่หลังส่ง) — อ่านจากเนื้ออีเมล
  expect(m?.subject ?? '').not.toMatch(/\d{6}/);
  return /\b(\d{6})\b/.exec(m?.textBody ?? '')?.[1] ?? '';
}

test('สมัครขั้น 1: ฟอร์ม → OTP → ผิด → ถูก → ขั้น 2 · ปิดเบราว์เซอร์แล้ว login กลับมาขั้นที่ค้าง', async ({
  page,
  browser,
}) => {
  const email = `signup-${Date.now()}@e2e-company.test`;
  await page.goto('/signup');
  await expect(page.getByRole('heading', { level: 1, name: 'สร้างบัญชี' })).toBeVisible();
  await expect(page.getByText('ขั้น 1 จาก 3')).toBeVisible();
  await page.getByRole('button', { name: 'ขอรหัส OTP' }).click();
  await expect(page.getByText('กรอกชื่อ-นามสกุล')).toBeVisible();

  await page.getByPlaceholder('สมชาย ใจดี').fill('ทดสอบ สมัครเอง');
  await page.getByPlaceholder('name@company.co.th').fill(email);
  await page.getByPlaceholder('81 234 5678').fill('81 234 5678');
  await page.getByPlaceholder('อย่างน้อย 12 ตัวอักษร').fill(PW);
  await expect(page.getByText('รหัสผ่านใช้ได้')).toBeVisible();
  await page.getByRole('button', { name: 'ขอรหัส OTP' }).click();
  await expect(page.getByText(`กรอกรหัส 6 หลักที่ส่งไปที่ ${email}`)).toBeVisible();
  await expect(page.getByText(/ขอรหัสใหม่ได้ใน \d+ วินาที/)).toBeVisible();
  await expect(page.getByText('ขั้น 1 จาก 3 · ยืนยันอีเมล')).toBeVisible();

  const code = await lastCode(email);
  expect(code).toMatch(/^\d{6}$/);
  // เก็บแค่ hash — ไม่มีรหัสดิบในแถวการสมัคร
  const row = await db.signupSession.findFirst({ where: { email } });
  expect(JSON.stringify(row)).not.toContain(code);

  const otp = page.getByPlaceholder('••••••');
  await otp.fill(code === '000000' ? '000001' : '000000');
  await page.getByRole('button', { name: 'ยืนยันรหัส' }).click();
  await expect(page.getByText('รหัสไม่ถูกต้อง เหลือ 4 ครั้ง')).toBeVisible();
  await otp.fill(code);
  await page.getByRole('button', { name: 'ยืนยันรหัส' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ข้อมูลบริษัท' })).toBeVisible();
  await expect(page.getByText('ขั้น 2 จาก 3')).toBeVisible();

  // ปิดเบราว์เซอร์ (context ใหม่ = ไม่มี sessionStorage) → login ด้วยอีเมล/รหัสของการสมัคร → กลับขั้น 2
  const ctx = await browser.newContext({ locale: 'th-TH', viewport: { width: 1440, height: 900 } });
  await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
  const p2 = await ctx.newPage();
  await p2.goto('/login');
  await p2.getByLabel('อีเมล').fill(email);
  await p2.getByLabel('รหัสผ่าน').fill(PW);
  await p2.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(p2).toHaveURL(/\/signup$/);
  await expect(p2.getByRole('heading', { level: 1, name: 'ข้อมูลบริษัท' })).toBeVisible();
  await ctx.close();
});

test('อีเมลมีบัญชีแล้ว → "เข้าสู่ระบบเพื่อเพิ่มบริษัทใหม่" · จอ 390 ไม่มี scroll แนวนอน', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/signup');
  await page.getByPlaceholder('สมชาย ใจดี').fill('ผู้ใช้ เดิม');
  await page.getByPlaceholder('name@company.co.th').fill('owner@demo-a.test');
  await page.getByPlaceholder('81 234 5678').fill('812345678');
  await page.getByPlaceholder('อย่างน้อย 12 ตัวอักษร').fill(PW);
  await page.getByRole('button', { name: 'ขอรหัส OTP' }).click();
  await expect(page.getByText('อีเมลนี้มีบัญชีแล้ว')).toBeVisible();
  const link = page.getByRole('link', { name: 'เข้าสู่ระบบเพื่อเพิ่มบริษัทใหม่' });
  await expect(link).toHaveAttribute('href', '/login');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
