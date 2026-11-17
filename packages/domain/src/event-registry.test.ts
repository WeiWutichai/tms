import { describe, expect, it } from 'vitest';
import {
  ACTIVE_EVENT_TYPES,
  EVENT_REGISTRY,
  PENDING_EVENT_TYPES,
  WEBHOOK_EVENT_DESCRIPTIONS,
  eventSchemaName,
} from './event-registry';
import { WEBHOOK_EVENT_TYPES } from './webhook';

describe('ทะเบียน event สาธารณะ (ST7-T06)', () => {
  it('ครบทุกชื่อที่สมัครได้ เรียงเดียวกัน · active + pending = ทั้งหมด', () => {
    expect(EVENT_REGISTRY.map((d) => d.type)).toEqual([...WEBHOOK_EVENT_TYPES]);
    expect([...ACTIVE_EVENT_TYPES, ...PENDING_EVENT_TYPES].sort()).toEqual(
      [...WEBHOOK_EVENT_TYPES].sort(),
    );
    expect(Object.keys(WEBHOOK_EVENT_DESCRIPTIONS)).toEqual([...WEBHOOK_EVENT_TYPES]);
  });

  it('schema เป็น object ปิด · required อยู่ใน properties · field ทุกตัวมีชนิด', () => {
    for (const d of EVENT_REGISTRY.filter((x) => x.schema)) {
      const s = d.schema!;
      expect(s.type).toBe('object');
      expect(s.additionalProperties).toBe(false);
      for (const r of s.required ?? []) expect(Object.keys(s.properties!)).toContain(r);
      for (const [k, p] of Object.entries(s.properties!))
        expect(p.type, `${d.type}.${k}`).toBeTruthy();
    }
  });

  it('ชื่อ component OpenAPI', () => {
    expect(eventSchemaName('delivery_order.status_changed')).toBe(
      'WebhookEvent_delivery_order_status_changed',
    );
  });
});
