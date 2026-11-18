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

  it('active ทุกตัวอ้าง DTO ของ REST · pending ไม่มีรูป + มี task', () => {
    for (const d of EVENT_REGISTRY) {
      if (d.phase === 'active') expect(d.object?.dto, d.type).toMatch(/Dto$/);
      else {
        expect(d.object).toBeNull();
        expect(d.pendingTask).toMatch(/^ST\d-T\d+$/);
      }
    }
    expect(eventDefinition('order.created')!.object!.dto).toBe('OrderDto');
    expect(eventDefinition('stop.arrived')!.object!.require).toContain('tripId');
    expect(eventDefinition('trip.started')!.object!.require).toContain('startedAt');
    expect(eventDefinition('trip.completed')!.object!.require).toContain('completedAt');
  });

  it('strictEventSchema ปิดทุกชั้น (ไม่ทับ additionalProperties ที่ตั้งไว้)', () => {
    const s = strictEventSchema({
      type: 'object',
      properties: {
        a: { type: 'array', items: { type: 'object', properties: { b: { type: 'string' } } } },
        m: { type: 'object', additionalProperties: true },
      },
    });
    expect(s.additionalProperties).toBe(false);
    expect(s.properties!.a!.items!.additionalProperties).toBe(false);
    expect(s.properties!.m!.additionalProperties).toBe(true);
  });

  it('ชื่อ component OpenAPI', () => {
    expect(eventSchemaName('delivery_order.status_changed')).toBe(
      'WebhookEvent_delivery_order_status_changed',
    );
  });
});
