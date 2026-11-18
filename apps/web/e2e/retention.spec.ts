import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { DEMO_EMAIL, DEMO_PASSWORD, expect, test } from './fixtures';

/**
 * E2E ST9-T14 Retention (ผ่าน API จริง ฐาน e2e — ไม่มีหน้าจอ: ต้นแบบไม่มีหน้าตั้งระยะเก็บ, spec/12 §3)
 * เกณฑ์ตรวจรับ: ตั้งค่าต่ำกว่าขั้นต่ำถูกปฏิเสธ (การลบตามอายุ/เอกสารภาษีไม่ถูกแตะ ทดสอบใน apps/api/test/retention.test.ts)
 */
async function token(page: Page): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await page.request.post('/v1/auth/login', {
    data: {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
  });
  const { code } = (await r1.json()) as { code: string };
  const r2 = await page.request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  });
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

test('ระยะเก็บ: ค่าเริ่ม = ขั้นต่ำ · ต่ำกว่าขั้นต่ำ → 422 below_minimum', async ({ page }) => {
  const auth = { Authorization: `Bearer ${await token(page)}` };
  const list = await page.request.get('/v1/settings', { headers: auth });
  expect(list.status()).toBe(200);
  const values = Object.fromEntries(
    ((await list.json()) as { data: { key: string; value: unknown }[] }).data.map((s) => [
      s.key,
      s.value,
    ]),
  );
  const minimum = {
    'retention.auditLogYears': 5,
    'retention.integrationLogMonths': 24,
    'retention.loginLogMonths': 12,
    'retention.podFileYears': 2,
    'retention.gpsLogDays': 90,
  };
  expect(values).toMatchObject(minimum);
  for (const [key, min] of Object.entries(minimum)) {
    const res = await page.request.patch('/v1/settings', {
      headers: auth,
      data: { values: { [key]: min - 1 } },
    });
    expect(res.status(), key).toBe(422);
    expect(
      ((await res.json()) as { errors: { field: string; code: string }[] }).errors,
    ).toContainEqual(expect.objectContaining({ field: `values.${key}`, code: 'below_minimum' }));
  }
  // ค่าเท่าขั้นต่ำ = ผ่าน (ไม่เปลี่ยนอะไร)
  const ok = await page.request.patch('/v1/settings', { headers: auth, data: { values: minimum } });
  expect(ok.status(), await ok.text()).toBe(200);
});
