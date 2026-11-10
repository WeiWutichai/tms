import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/v1': process.env.VITE_API_TARGET ?? 'http://localhost:4410' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'], css: false, include: ['src/**/*.test.{ts,tsx}'] },
});
