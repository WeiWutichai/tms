import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * ST9-T20 เมทริกซ์เบราว์เซอร์ของ a11y.spec (NFR Browser: Chrome/Edge/Safari จอ ≥ 1280) — `pnpm --filter @tms/web e2e:a11y`
 * Chrome = chromium · Safari = webkit (ติดตั้ง: npx playwright install webkit) · Edge = channel msedge ถ้าเครื่องมี
 * (A11Y_EDGE=1) — Edge ใช้ Blink เดียวกับ Chrome · CI ปกติรัน a11y.spec ใน chromium 1440 ของ playwright.config
 */
const sizes = [1280, 1440] as const;
const browsers = [
  { name: 'chromium', use: devices['Desktop Chrome'] },
  { name: 'webkit', use: devices['Desktop Safari'] },
  ...(process.env.A11Y_EDGE
    ? [{ name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' } }]
    : []),
];

export default defineConfig({
  ...base,
  testMatch: /a11y\.spec\.ts$/,
  projects: browsers.flatMap((b) =>
    sizes.map((w) => ({
      name: `${b.name}-${w}`,
      use: { ...b.use, viewport: { width: w, height: 900 } },
    })),
  ),
});
