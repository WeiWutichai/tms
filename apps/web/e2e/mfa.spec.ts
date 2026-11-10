import { createHmac } from 'node:crypto';
import { DEMO_PASSWORD, DEMO_TOTP_SECRET, expect, test } from './fixtures';

/** RFC 6238 ในฝั่ง test (ไม่พึ่งโค้ดของแอป) */
function totp(secret: string, offset = 0): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let val = 0;
  const key: number[] = [];
  for (const c of secret) {
    val = (val << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      key.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = createHmac('sha1', Buffer.from(key)).update(msg).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

/** ST1-T05: role ที่บังคับ 2FA ต้องกรอกรหัสจากแอปหลังรหัสผ่าน */
test.describe('ยืนยันตัวตน 2 ชั้น', () => {
  test.use({ loginEmail: 'planner@demo-a.test' });

  test('admin: รหัสผ่าน → หน้า 2FA → รหัสผิดเตือน → รหัสถูกเข้าระบบ', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('อีเมล').fill('admin@demo-a.test');
    await page.getByLabel('รหัสผ่าน').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByRole('heading', { name: 'ยืนยันตัวตน 2 ชั้น' })).toBeVisible();
    await page.getByLabel('รหัส 6 หลัก').fill('000000');
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByRole('alert')).toHaveText('รหัสยืนยันไม่ถูกต้องหรือหมดอายุ');
    await page.getByLabel('รหัส 6 หลัก').fill(totp(DEMO_TOTP_SECRET, 1));
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByText('ผู้ดูแล ตัวอย่าง')).toBeVisible();
  });
});
