import { afterEach, describe, expect, it } from 'vitest';
import { getApiMode, isSandboxPath, modeOrder, setApiMode } from './mode';

describe('โหมด Production / Sandbox (ST7-T09)', () => {
  afterEach(() => setApiMode('live'));

  it('ส่ง X-Tms-Mode เฉพาะ path ของหน้า นักพัฒนา / Open API', () => {
    for (const p of [
      '/v1/api-keys',
      '/v1/api-keys/key_1/rotate',
      '/v1/webhooks',
      '/v1/webhooks/whe_1/history',
      '/v1/webhook-deliveries',
      '/v1/events/evt_1/redeliver',
      '/v1/test/events/trigger',
    ])
      expect(isSandboxPath(p), p).toBe(true);
    for (const p of ['/v1/orders', '/v1/stops/stp_1/events', '/v1/api-keysx', '/v1/me'])
      expect(isSandboxPath(p), p).toBe(false);
  });

  it('ค่าเริ่ม live · ตัวเลือกในฟอร์มเรียงโหมดของหน้าก่อน (ต้นแบบ cfKey)', () => {
    expect(getApiMode()).toBe('live');
    setApiMode('test');
    expect(getApiMode()).toBe('test');
    expect(modeOrder('live')).toEqual(['live', 'test']);
    expect(modeOrder('test')).toEqual(['test', 'live']);
  });
});
