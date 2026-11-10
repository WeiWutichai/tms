import { test as base, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';

/** ผู้ใช้เดโมจาก apps/api/prisma/seed.ts (ข้อมูลสมมติ ใช้เฉพาะ dev/e2e) */
export const DEMO_EMAIL = 'owner@demo-a.test';
export const DEMO_PASSWORD = 'demo-password-2569';

/**
 * login ผ่าน API จริง (Auth Code + PKCE) ด้วย request ของ context เดียวกับหน้า → ได้ refresh cookie httpOnly
 * ทำใหม่ทุก test เพราะ refresh token หมุนทุกครั้ง (ใช้ซ้ำข้าม test ไม่ได้ — ตรงกับกติกา ST1-T04)
 */
export const test = base.extend<{ loggedIn: void }>({
  loggedIn: [
    async ({ page }, use) => {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const r1 = await page.request.post('/v1/auth/login', {
        data: { email: DEMO_EMAIL, password: DEMO_PASSWORD, codeChallenge: challenge },
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
