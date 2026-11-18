import { describe, expect, it } from 'vitest';
import {
  ACTIVE_EVENT_TYPES,
  EVENT_REGISTRY,
  PENDING_EVENT_TYPES,
  WEBHOOK_EVENT_DESCRIPTIONS,
  eventDefinition,
  eventSchemaName,
  strictEventSchema,
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

  it('schema ที่เผยแพร่เปิด (เพิ่ม field = non-breaking) · strict ปิดทุกชั้น · required อยู่ใน properties · field ทุกตัวมีชนิด', () => {
    for (const d of EVENT_REGISTRY.filter((x) => x.schema)) {
      const s = d.schema!;
      expect(s.type).toBe('object');
      expect(JSON.stringify(s)).not.toContain('"additionalProperties":false');
      const st = strictEventSchema(s);
      expect(st.additionalProperties).toBe(false);
      for (const p of Object.values(st.properties!))
        if (p.items?.properties) expect(p.items.additionalProperties).toBe(false);
      for (const r of s.required ?? []) expect(Object.keys(s.properties!)).toContain(r);
      for (const [k, p] of Object.entries(s.properties!))
        expect(p.type, `${d.type}.${k}`).toBeTruthy();
    }
  });

  it('trip.started/completed บังคับเวลา · order ต้องมีจุดอย่างน้อย 1', () => {
    expect(eventDefinition('trip.started')!.schema!.required).toContain('startedAt');
    expect(eventDefinition('trip.completed')!.schema!.required).toContain('completedAt');
    expect(eventDefinition('trip.assigned')!.schema!.required).not.toContain('startedAt');
    expect(eventDefinition('order.created')!.schema!.properties!.stops!.minItems).toBe(1);
  });

  it('ชื่อ component OpenAPI', () => {
    expect(eventSchemaName('delivery_order.status_changed')).toBe(
      'WebhookEvent_delivery_order_status_changed',
    );
  });
});
