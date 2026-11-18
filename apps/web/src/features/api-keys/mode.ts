/**
 * โหมดของหน้า นักพัฒนา / Open API (ST7-T09 — ต้นแบบ TMS v4 vApi `apiMode` + สวิตช์ Production / Sandbox)
 * ค่าเดียวของทั้งแอป (หน้านี้เป็นที่เดียวที่สลับได้ — ออกจากหน้าแล้วกลับเป็น live)
 * คำขอไปยัง path ของหน้านี้ส่ง `X-Tms-Mode: test` อัตโนมัติ (middleware ใน api.ts) → API ใช้ข้อมูลของ sandbox
 * (key `tk_test_`, webhook/ประวัติการส่ง/กิจกรรมของ sandbox) — path อื่นไม่ได้รับ header นี้เลย
 */
export type ApiMode = 'live' | 'test';

let current: ApiMode = 'live';

export const getApiMode = (): ApiMode => current;
export function setApiMode(m: ApiMode) {
  current = m;
}

/** route ที่ API ติด @SandboxAware (api-keys, webhooks, webhook-deliveries, events/{id}/redeliver, test/events) */
const SANDBOX_PATHS = [
  /^\/v1\/api-keys(\/|$)/,
  /^\/v1\/webhooks(\/|$)/,
  /^\/v1\/webhook-deliveries(\/|$)/,
  /^\/v1\/events\//,
  /^\/v1\/test\//,
];

export const isSandboxPath = (path: string) => SANDBOX_PATHS.some((r) => r.test(path));

/** react-query key ที่ต้องล้างเมื่อสลับโหมด (ข้อมูลของอีกโหมด) */
export const MODE_QUERY_KEYS = [['api-keys'], ['webhooks'], ['history']] as const;

/** ตัวเลือกช่อง "โหมด" ในฟอร์มสร้าง key/endpoint — โหมดของหน้าก่อน (ต้นแบบ cfKey/cfHook) */
export const modeOrder = (page: ApiMode): ApiMode[] =>
  page === 'live' ? ['live', 'test'] : ['test', 'live'];
