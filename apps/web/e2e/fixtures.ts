import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, createHmac, randomBytes } from 'node:crypto';

/** URL ของ web ที่ E2E รัน (พอร์ตจาก E2E_WEB_PORT ที่ playwright.config ตั้งให้ — ค่าเริ่มต้น 4520) */
export const E2E_WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? '4520'}`;

/** ผู้ใช้เดโมจาก apps/api/prisma/seed.ts (ข้อมูลสมมติ ใช้เฉพาะ dev/e2e) */
export const DEMO_EMAIL = 'owner@demo-a.test';
export const DEMO_PASSWORD = 'demo-password-2569';
/** secret TOTP ของผู้ใช้เดโมที่ role บังคับ 2FA + token อุปกรณ์ที่จำไว้ (seed.ts — dev/e2e เท่านั้น) */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
export const DEMO_TRUSTED_DEVICE = 'demo-trusted-device-e2e-only-0000000000000';
export const DEMO_IDS: Record<string, string> = {
  'owner@demo-a.test': '00000000-0000-4000-8000-0000000e0a01',
  'admin@demo-a.test': '00000000-0000-4000-8000-0000000e0a02',
  // D-78: role ที่ถือสิทธิ์สำคัญต้องตั้ง 2FA — seed ตั้งให้ + cookie อุปกรณ์ที่จำไว้
  'manager@demo-a.test': '00000000-0000-4000-8000-0000000e0a03',
  'planner@demo-a.test': '00000000-0000-4000-8000-0000000e0a04',
  'invoicer@demo-a.test': '00000000-0000-4000-8000-0000000e0a06',
  'accounting@demo-a.test': '00000000-0000-4000-8000-0000000e0a07',
  'owner@demo-b.test': '00000000-0000-4000-8000-0000000e0b01',
};

/**
 * D-78: ผู้ใช้เดโมที่ต้องตั้ง 2FA — ข้ามขั้น TOTP ด้วย cookie อุปกรณ์ที่จำไว้จาก seed ใน helper login ของแต่ละ spec
 * - `trustDevice(page, email)` วาง cookie ใน context ของหน้า (แทน cookie เดิมชื่อเดียวกัน) ก่อน `page.request.post('/v1/auth/login')`
 * - `trustedDeviceHeaders(email)` header Cookie สำหรับ `request` fixture (context แยก ไม่มี cookie ของหน้า)
 * ผู้ใช้ที่ไม่ต้องตั้ง 2FA = ไม่ทำอะไร
 */
export async function trustDevice(page: Page, email: string): Promise<void> {
  const id = DEMO_IDS[email];
  if (!id) return;
  await page.context().addCookies([
    {
      name: 'tms_td',
      value: `${DEMO_TRUSTED_DEVICE}:${id}`,
      url: `${E2E_WEB}/v1/auth`,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}
export function trustedDeviceHeaders(email: string): Record<string, string> {
  const id = DEMO_IDS[email];
  return id ? { Cookie: `tms_td=${DEMO_TRUSTED_DEVICE}:${id}` } : {};
}

/**
 * login ผ่าน API จริง (Auth Code + PKCE) ด้วย request ของ context เดียวกับหน้า → ได้ refresh cookie httpOnly
 * ทำใหม่ทุก test เพราะ refresh token หมุนทุกครั้ง (ใช้ซ้ำข้าม test ไม่ได้ — ตรงกับกติกา ST1-T04)
 */
export const test = base.extend<{ loginEmail: string; loggedIn: void }>({
  /** เปลี่ยนผู้ใช้ด้วย test.use({ loginEmail: 'viewer@demo-a.test' }) — มี 1 คนต่อ role ใน seed */
  loginEmail: [DEMO_EMAIL, { option: true }],
  loggedIn: [
    async ({ page, loginEmail, baseURL }, use) => {
      // role ที่บังคับ 2FA: ใช้ cookie อุปกรณ์ที่จำไว้จาก seed ข้ามขั้น TOTP (หน้าจอ 2FA ทดสอบใน mfa.spec.ts)
      if (DEMO_IDS[loginEmail])
        await page.context().addCookies([
          {
            name: 'tms_td',
            value: `${DEMO_TRUSTED_DEVICE}:${DEMO_IDS[loginEmail]}`,
            url: `${baseURL}/v1/auth`,
            httpOnly: true,
            sameSite: 'Strict',
          },
        ]);
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const r1 = await page.request.post('/v1/auth/login', {
        data: { email: loginEmail, password: DEMO_PASSWORD, codeChallenge: challenge },
      });
      expect(r1.status(), await r1.text()).toBe(200);
      const { code } = (await r1.json()) as { code: string };
      const r2 = await page.request.post('/v1/oauth/token', {
        data: { grantType: 'authorization_code', code, codeVerifier: verifier },
      });
      expect(r2.status(), await r2.text()).toBe(200);
      await use();
    },
    { auto: true },
  ],
});
export { expect };

/**
 * time-step ล่าสุดที่ spec ใน process นี้ใช้กับ TOTP ของผู้ใช้เดโม (workers = 1 → ทุก spec ผ่าน fixtures เดียวกัน)
 * server ไม่รับ step ที่ ≤ ช่วงที่ใช้ไปแล้ว และรหัสผิดนับเป็นความพยายามล้มเหลว (ครบแล้วล็อกบัญชี) —
 * step-up (D-67) จึงเลือก step ที่ยังไม่ถูกใช้เอง แทนการลองผิดลองถูก
 */
let usedStep = 0;

/** RFC 6238 ในฝั่ง test (ไม่พึ่งโค้ดของแอป) */
export function totp(secret: string, offset = 0): string {
  const step = Math.floor(Date.now() / 30000) + offset;
  usedStep = Math.max(usedStep, step);
  return totpAt(secret, step);
}

function totpAt(secret: string, step: number): string {
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
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', Buffer.from(key)).update(msg).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

/**
 * D-67 กล่องยืนยัน 2FA (`StepUpBox` — "ยืนยันตัวตน 2 ชั้นอีกครั้ง") ก่อนรายการเสี่ยง: สร้าง/หมุน API key, secret webhook,
 * credential connector, บัญชีธนาคารรถร่วม, ส่งออกทั้งบริษัท, ยกเลิกใบแจ้งหนี้/ใบวางบิลที่ออกแล้ว
 * กรอก TOTP ของผู้ใช้เดโม — รหัสช่วงเวลาเดียวกันใช้ซ้ำไม่ได้ (spec อื่นอาจใช้ไปแล้ว) → ลองช่วงถัดไป
 * ยืนยันแล้ว token ใช้ต่อได้ 5 นาทีในหน้าเดิม (ไม่ถามซ้ำ) — เรียกเฉพาะครั้งแรกของแต่ละ test
 */
export async function confirmStepUp(page: Page): Promise<void> {
  const box = page.getByRole('group', { name: 'ยืนยันตัวตน 2 ชั้นอีกครั้ง' });
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.getByLabel('รหัส 6 หลัก').fill(await freshCode());
  await box.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(box).toBeHidden({ timeout: 10_000 });
}

/**
 * D-67 header `X-Step-Up` สำหรับเรียก API ตรง (page.request) ในขั้นเตรียมข้อมูล — `POST /v1/auth/step-up` ด้วย TOTP ของผู้ใช้เดโม
 * คืน header เดิม + `X-Step-Up` (token ใช้ได้ 5 นาที)
 */
export async function withStepUp(
  req: APIRequestContext,
  auth: Record<string, string>,
): Promise<Record<string, string>> {
  const r = await req.post('/v1/auth/step-up', { headers: auth, data: { otp: await freshCode() } });
  expect(r.status(), await r.text()).toBe(200);
  const { stepUpToken } = (await r.json()) as { stepUpToken: string };
  return { ...auth, 'X-Step-Up': stepUpToken };
}

/**
 * รหัส TOTP ของ step ที่ยังไม่ถูกใช้ (server รับ ±1 ช่วงจากปัจจุบัน) — ไม่มีให้ใช้ = รอข้ามช่วง (ยืดเวลาของ test)
 * ใช้ครั้งเดียวต่อรหัส ไม่ลองซ้ำด้วยรหัสที่อาจผิด (รหัสผิดนับเป็นความพยายามล้มเหลว — กันบัญชีเดโมถูกล็อก)
 */
export async function freshCode(): Promise<string> {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    // ช่วง 2 วินาทีสุดท้ายไม่ใช้ step ปัจจุบัน (อาจหลุดหน้าต่างระหว่างส่ง) — ใช้ step ถัดไปแทน
    const late = Date.now() % 30000 > 28_000;
    const step = [now, now + 1].find((x) => x > usedStep && !(late && x === now));
    if (step !== undefined) {
      usedStep = step;
      return totpAt(DEMO_TOTP_SECRET, step);
    }
    await nextTotpStep();
  }
}

/** รอจนข้ามช่วง 30 วินาทีถัดไปของ TOTP (รหัสที่ใช้แล้วใช้ซ้ำไม่ได้) — ยืดเวลาของ test ตามที่รอ */
async function nextTotpStep(): Promise<void> {
  test.info().setTimeout(test.info().timeout + 35_000);
  const ms = 30_000 - (Date.now() % 30_000) + 500;
  await new Promise((r) => setTimeout(r, ms));
}
