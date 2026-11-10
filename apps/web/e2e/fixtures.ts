import { test as base, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';

/** ผู้ใช้เดโมจาก apps/api/prisma/seed.ts (ข้อมูลสมมติ ใช้เฉพาะ dev/e2e) */
export const DEMO_EMAIL = 'owner@demo-a.test';
export const DEMO_PASSWORD = 'demo-password-2569';
/** secret TOTP ของผู้ใช้เดโมที่ role บังคับ 2FA + token อุปกรณ์ที่จำไว้ (seed.ts — dev/e2e เท่านั้น) */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const DEMO_TRUSTED_DEVICE = 'demo-trusted-device-e2e-only-0000000000000';
const DEMO_IDS: Record<string, string> = {
  'owner@demo-a.test': '00000000-0000-4000-8000-0000000e0a01',
  'admin@demo-a.test': '00000000-0000-4000-8000-0000000e0a02',
  'accounting@demo-a.test': '00000000-0000-4000-8000-0000000e0a07',
};

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
