#!/usr/bin/env node
/**
 * รัน mock KRS เป็น server แยก: `pnpm --filter @tms/mock-krs dev`
 * env: MOCK_KRS_PORT (ค่าเริ่ม 4784) · MOCK_KRS_HOST (127.0.0.1) · MOCK_KRS_API_KEY (mock-krs-key)
 * ไม่ต่อเครือข่ายภายนอก — ห้ามใช้แทน KRS จริงใน production
 */
import { MockKrs } from './mock-krs';

async function main(): Promise<void> {
  const port = Number(process.env.MOCK_KRS_PORT ?? 4784);
  const host = process.env.MOCK_KRS_HOST ?? '127.0.0.1';
  const mock = new MockKrs(
    process.env.MOCK_KRS_API_KEY ? { apiKey: process.env.MOCK_KRS_API_KEY } : {},
  );
  await mock.start(port, host);
  console.log(
    `mock KRS: ${mock.apiBaseUrl} (X-API-Key: ${mock.apiKey}) · control: ${mock.url}/__mock`,
  );
  const shutdown = () => {
    void mock.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
