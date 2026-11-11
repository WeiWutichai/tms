import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

/** E2E (plan/03 §3) — API 4510 + web 4520 + ฐาน tms_e2e (เตรียมโดย e2e/prepare.mjs) */
const env: Record<string, string> = {};
try {
  for (const line of readFileSync(new URL('./e2e/.env.e2e', import.meta.url), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
} catch {
  /* ยังไม่ได้ prepare */
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4520',
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: 'SWC_NODE_PROJECT=tsconfig.json node -r @swc-node/register src/main.ts',
      cwd: '../api',
      url: 'http://localhost:4510/v1/health',
      // ลิงก์ในอีเมล/เข้าใช้งานแทน (ST1-T24) ต้องชี้ web ของ E2E (4520) ไม่ใช่ web dev (4420)
      env: {
        ...env,
        API_PORT: '4510',
        NODE_ENV: 'test',
        PUBLIC_WEB_BASE_URL: 'http://localhost:4520',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx vite --port 4520 --strictPort',
      url: 'http://localhost:4520',
      env: { VITE_API_TARGET: 'http://localhost:4510' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
