import react from '@vitejs/plugin-react';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Connect, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// ค่าจาก .env ที่ราก worktree (env ของ shell มาก่อน) — ใช้แค่พอร์ต dev ไม่ส่งเข้า bundle
const rootEnv = loadEnv('development', fileURLToPath(new URL('../..', import.meta.url)), '');

/**
 * P1-ST6-T02 — เสิร์ฟ help center (`packages/help-center/site`) ที่ `/help/` ตอน dev/preview (production: web.Dockerfile คัดลอกไป /srv/help)
 * ลิงก์ "คู่มือ" ในแอปใช้ค่าเริ่ม `/help/` (VITE_HELP_CENTER_URL) จึงเปิดได้ทันทีในเครื่อง — ไฟล์ static เท่านั้น อ่านอย่างเดียว
 */
const HELP_DIR = fileURLToPath(new URL('../../packages/help-center/site', import.meta.url));
const HELP_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
};
const helpStatic: Connect.NextHandleFunction = (req, res, next) => {
  const url = (req.url ?? '').split(/[?#]/)[0]!;
  if (url !== '/help' && !url.startsWith('/help/')) return next();
  if (url === '/help') {
    res.statusCode = 301;
    res.setHeader('Location', '/help/');
    return res.end();
  }
  const rel = normalize(decodeURIComponent(url.slice('/help/'.length)) || 'index.html');
  const file = join(HELP_DIR, rel);
  if (rel.startsWith('..') || !file.startsWith(HELP_DIR)) return next();
  const type = HELP_TYPES[extname(file)];
  if (!type || !existsSync(file) || !statSync(file).isFile()) return next();
  res.setHeader('Content-Type', type);
  res.end(readFileSync(file));
};
const helpCenter = (): Plugin => ({
  name: 'tms-help-center',
  configureServer: (s) => void s.middlewares.use(helpStatic),
  configurePreviewServer: (s) => void s.middlewares.use(helpStatic),
});

export default defineConfig({
  plugins: [react(), helpCenter()],
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
