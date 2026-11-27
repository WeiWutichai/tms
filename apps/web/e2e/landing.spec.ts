import { expect, test } from '@playwright/test';

/**
 * E2E P1-ST2-T01 landing สาธารณะ `/home` — ไม่ต้อง login · โหลดเป็น bundle แยก (ไม่ดึงแอปหลัง login)
 * ปิดคำขอออกนอกเครื่อง (Google Fonts ฯลฯ) — ไม่ส่งข้อมูลไปบริการภายนอกระหว่าง test
 */
test.beforeEach(async ({ page }) => {
  await page.context().route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
});

test('เปิด /home โดยไม่ login: hero + CTA ไปหน้าสมัคร · ไม่โหลด bundle ของแอป · ไม่มี scroll แนวนอนที่ 390 px', async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(r.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('จัดรถ ตามงาน เก็บ POD');
  await expect(page).toHaveTitle(/TMS — จัดรถ ตามงาน/);
  expect(page.url()).toMatch(/\/home$/); // ไม่ถูกพาไปหน้า login
  expect(scripts.some((u) => /AppRoot/.test(u))).toBe(false);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // เมนูมือถือ → เข้าสู่ระบบ = หน้า login ของแอป
  await page.getByRole('button', { name: 'เมนู' }).click();
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).last().click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
});

test('เดสก์ท็อป 1440: header โปร่งบน hero แล้วเป็นพื้นขาวเมื่อเลื่อน · ฟีเจอร์ เลื่อนไปส่วน "เช้าวันหนึ่งของฝ่ายจัดรถ"', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/home');
  const hd = page.locator('header');
  await expect(hd).toHaveClass(/land-hd--dark/);
  await page.getByRole('navigation').getByRole('button', { name: 'ฟีเจอร์' }).click();
  await expect(hd).not.toHaveClass(/land-hd--dark/);
  await expect(page.getByRole('heading', { name: 'เช้าวันหนึ่งของฝ่ายจัดรถ' })).toBeInViewport();
});
