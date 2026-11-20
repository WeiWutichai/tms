#!/usr/bin/env node
/**
 * รัน mock AccountSystem เป็น server แยก: `pnpm --filter @tms/mock-accountsystem dev`
 * env: MOCK_ACCOUNTSYSTEM_PORT (ค่าเริ่ม 4785) · MOCK_ACCOUNTSYSTEM_HOST (127.0.0.1) · MOCK_ACCOUNTSYSTEM_API_KEY (inn_…)
 * ไม่ต่อเครือข่ายภายนอก — ห้ามใช้แทน AccountSystem จริงใน production
 */
import { MockAccountSystem } from './mock-accountsystem';

async function main(): Promise<void> {
  const port = Number(process.env.MOCK_ACCOUNTSYSTEM_PORT ?? 4785);
  const host = process.env.MOCK_ACCOUNTSYSTEM_HOST ?? '127.0.0.1';
  const apiKey = process.env.MOCK_ACCOUNTSYSTEM_API_KEY;
  if (apiKey && !apiKey.startsWith('inn_'))
    throw new Error('MOCK_ACCOUNTSYSTEM_API_KEY must start with inn_');
  const mock = new MockAccountSystem({
    ...(apiKey ? { apiKey } : {}),
    contacts: [{ code: 'C-0001', name: 'ลูกค้าตัวอย่าง', kind: 'customer' }],
  });
  await mock.start(port, host);
  console.log(`mock AccountSystem: ${mock.url} (Bearer ${mock.apiKey.slice(0, 8)}…)`);
  const shutdown = () => void mock.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
