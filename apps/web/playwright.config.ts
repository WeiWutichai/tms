import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * E2E (plan/03 §3) — API E2E_API_PORT (4510) + web E2E_WEB_PORT (4520) + ฐาน `<ฐาน dev>_e2e` (เตรียมโดย e2e/prepare.mjs)
 * พอร์ตอ่านจาก env หรือ .env ที่ราก worktree — หลาย worktree รันขนานได้ (HANDOFF §ทำงานขนาน)
 */
function readEnvFile(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(url, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
  } catch {
    /* ไม่มีไฟล์ (ยังไม่ได้ prepare / CI ตั้ง env เอง) */
  }
  return out;
}
const env = readEnvFile(new URL('./e2e/.env.e2e', import.meta.url));
const rootEnv = readEnvFile(new URL('../../.env', import.meta.url));
// ตั้งลง process.env ให้ worker ของ Playwright (spec/fixtures) เห็นพอร์ตเดียวกัน
process.env.E2E_API_PORT ??= rootEnv.E2E_API_PORT ?? '4510';
process.env.E2E_WEB_PORT ??= rootEnv.E2E_WEB_PORT ?? '4520';
const API = `http://localhost:${process.env.E2E_API_PORT}`;
const WEB = `http://localhost:${process.env.E2E_WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB,
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
      url: `${API}/v1/health`,
      // ลิงก์ในอีเมล/เข้าใช้งานแทน (ST1-T24) ต้องชี้ web ของ E2E ไม่ใช่ web dev
      env: {
        ...env,
        API_PORT: process.env.E2E_API_PORT,
        NODE_ENV: 'test',
        PUBLIC_WEB_BASE_URL: WEB,
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite --port ${process.env.E2E_WEB_PORT} --strictPort`,
      url: WEB,
      env: { VITE_API_TARGET: API },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
