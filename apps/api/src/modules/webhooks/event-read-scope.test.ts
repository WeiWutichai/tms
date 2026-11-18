import { PERMISSIONS, WEBHOOK_EVENT_TYPES } from '@tms/domain';
import { describe, expect, it } from 'vitest';
import { eventReadScope } from './webhook-ops.service';

/** ST7-T11 (re-review M): ทุกชนิด event สาธารณะต้องผูก scope อ่านของ resource จริง — ชนิดใหม่ที่ลืมผูก = CI แดง */
describe('eventReadScope', () => {
  it('ทุกชนิดใน WEBHOOK_EVENT_TYPES ผูกกับ scope ที่มีใน PERMISSIONS', () => {
    const missing = WEBHOOK_EVENT_TYPES.filter(
      (t) => !(PERMISSIONS as readonly string[]).includes(eventReadScope(t)),
    );
    expect(missing).toEqual([]);
  });
  it('ชนิดที่ไม่รู้จัก → ไม่มีใครอ่านได้', () => {
    expect(eventReadScope('unknown.thing')).toBe('events:none');
  });
});
