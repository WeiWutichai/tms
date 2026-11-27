import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// ค่าจาก .env ที่ราก worktree (env ของ shell มาก่อน) — ใช้แค่พอร์ต dev ไม่ส่งเข้า bundle
const rootEnv = loadEnv('development', fileURLToPath(new URL('../..', import.meta.url)), '');

export default defineConfig({
  plugins: [react()],
  // @tms/domain (workspace, dist เป็น CommonJS) — ให้ vite แปลงเป็น ESM ทั้งตอน dev (pre-bundle) และ build (ST5-T07: computeDocumentTax ในหน้าวางบิล)
  optimizeDeps: { include: ['@tms/domain'] },
  build: { commonjsOptions: { include: [/packages\/domain/, /node_modules/] } },
  // dev: WEB_PORT (4420) + proxy /v1 → VITE_API_TARGET หรือ API_PORT (4410) — ตั้งต่อ worktree ได้ (HANDOFF §ทำงานขนาน)
  // E2E ส่ง --port และ VITE_API_TARGET เอง (playwright.config.ts)
  server: {
    port: Number(rootEnv.WEB_PORT ?? 4420),
    strictPort: true,
    // แปลงโค้ดแอปไว้ตั้งแต่ server ขึ้น — หลังแยก entry landing/app (P1-ST2-T01) หน้าแรกของ E2E (/login) ต้องรอ vite
    // แปลงทั้งแอปตอนเปิดครั้งแรก เกิน timeout 5 วิของ expect (a11y login ล้มเฉพาะ test แรกของรอบ)
    warmup: { clientFiles: ['./src/main.tsx', './src/AppRoot.tsx', './src/App.tsx'] },
    proxy: {
      '/v1': rootEnv.VITE_API_TARGET ?? `http://localhost:${rootEnv.API_PORT ?? 4410}`,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
