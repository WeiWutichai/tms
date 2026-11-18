import type { OpenAPIObject } from '@nestjs/swagger';
import {
  EVENT_REGISTRY,
  eventSchemaName,
  pendingExample,
  type EventDefinition,
  type EventSchema,
} from '@tms/domain';
import { priceFieldNames } from '../../common/price-fields';

type Schemas = Record<string, EventSchema>;
/** schema ที่เผยแพร่ต่อ event + components (สำหรับ `$ref`) — ตั้งตอนสร้าง OpenAPI (bootstrap) */
let published = new Map<string, EventSchema>();
let components: Schemas = {};

/** schema ของ `data.object` ที่เผยแพร่ (เปิด — `$ref` ชี้ `#/components/schemas/*` ของ openapi.json) · null = pending */
export function publishedEventSchema(type: string): EventSchema | null {
  return published.get(type) ?? null;
}

/** components.schemas ของ OpenAPI ที่ schema ของ event อ้าง (ใช้ใน test ตรวจด้วย ajv) */
export function eventSchemaComponents(): Schemas {
  return components;
}

/**
 * schema ของ `data.object` = component DTO ของ REST − field ราคา (`@PriceField`) − `omit` + `extra` (ST7-T06 QA)
 * ไม่ใส่ additionalProperties:false (เพิ่ม field = non-breaking — docs/04 G1)
 */
function objectSchema(d: EventDefinition, all: Schemas): EventSchema | null {
  const o = d.object;
  if (!o) return null;
  const base = all[o.dto];
  if (!base?.properties) throw new Error(`event ${d.type}: OpenAPI component ${o.dto} not found`);
  const price = priceFieldNames();
  const props = Object.fromEntries(
    Object.entries(base.properties).filter(([k]) => !o.omit.includes(k) && !price.has(k)),
  );
  return {
    type: 'object',
    description: `\`data.object\` ของ ${d.type} — ${d.description} · รูปเดียวกับ ${o.dto} (ไม่มี field ราคา${o.omit.length ? `, ${o.omit.join(', ')}` : ''})`,
    properties: { ...props, ...o.extra },
    required: [...new Set([...(base.required ?? []).filter((k) => k in props), ...o.require])],
  };
}

/** ตัวอย่าง `data.object` (ข้อมูลสมมติ) สร้างจาก schema — เฉพาะ field ที่บังคับ · pending = โครงทั่วไป */
export function eventSample(type: string): Record<string, unknown> {
  const s = published.get(type);
  if (!s) return pendingExample(type);
  return sampleOf(s, 0) as Record<string, unknown>;
}

function sampleOf(s: EventSchema, depth: number): unknown {
  if (depth > 8) return null;
  if (s.$ref) return sampleOf(components[s.$ref.split('/').pop()!] ?? {}, depth + 1);
  if (s.allOf?.length) return sampleOf(s.allOf[0]!, depth + 1);
  if (s.enum?.length) return s.enum.find((v) => v !== null) ?? null;
  if (s.example !== undefined && s.type !== 'object' && s.type !== 'array') return s.example;
  switch (s.type) {
    case 'object': {
      const req = new Set(s.required ?? []);
      return Object.fromEntries(
        Object.entries(s.properties ?? {})
          .filter(([k]) => req.has(k))
          .map(([k, v]) => [k, sampleOf(v, depth + 1)]),
      );
    }
    case 'array':
      return [];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string':
      return s.format === 'date-time'
        ? '2026-11-18T02:30:00.000Z'
        : s.format === 'date'
          ? '2026-11-18'
          : 'string';
    default:
      return s.properties ? sampleOf({ ...s, type: 'object' }, depth) : null;
  }
}

/**
 * ST7-T06: เผยแพร่ schema ของ event สาธารณะใน OpenAPI (ทะเบียน `EVENT_REGISTRY` ใน @tms/domain เป็นต้นฉบับ)
 * - `components.schemas.WebhookEvent_<resource>_<action>` = schema ของ `data.object` (เฉพาะ event ที่กำหนดแล้ว)
 * - `components.schemas.WebhookEnvelope` = envelope (docs/04 G1)
 * - `x-webhooks` (OpenAPI 3.0 ยังไม่มี `webhooks` — 3.1 มี) = รายการ event ทั้งหมด + ระยะ + `$ref` ของ schema
 */
export function describeWebhookEvents(doc: OpenAPIObject): OpenAPIObject {
  const schemas = (doc.components ??= {}).schemas ?? (doc.components.schemas = {});
  schemas.WebhookEnvelope = {
    type: 'object',
    description:
      'envelope ของ webhook (docs/04 G1) — `data.object` ตาม schema `WebhookEvent_*` ของ `type` · header `X-TMS-Event`, `X-TMS-Event-Id`, `X-TMS-Timestamp`, `X-TMS-Signature: t=,v1=`, `X-TMS-Attempt`',
    required: ['id', 'type', 'version', 'occurredAt', 'tenantId', 'mode', 'data', 'request'],
    properties: {
      id: {
        type: 'string',
        example: 'evt_…',
        description: 'เดิมทุกครั้งที่ส่งซ้ำ — ผู้รับกันซ้ำด้วย id',
      },
      type: { type: 'string', example: 'order.created' },
      version: { type: 'string', example: '1' },
      occurredAt: { type: 'string', format: 'date-time' },
      tenantId: { type: 'string', example: 'ten_…' },
      mode: { type: 'string', enum: ['live', 'test'] },
      test: { type: 'boolean', description: 'มีเฉพาะ event ทดสอบ (`webhook.test`)' },
      sampleEventType: {
        type: 'string',
        description: 'เฉพาะ `webhook.test`: event ที่ใช้ตัวอย่าง `data.object`',
      },
      data: {
        type: 'object',
        required: ['object', 'previousAttributes'],
        properties: {
          object: { type: 'object', additionalProperties: true },
          previousAttributes: {
            type: 'object',
            nullable: true,
            additionalProperties: true,
            description: 'ค่าเดิมของ field ที่เปลี่ยน (ชื่อเดียวกับ `data.object`)',
          },
        },
      },
      request: {
        type: 'object',
        required: ['id', 'idempotencyKey'],
        properties: {
          id: { type: 'string', nullable: true },
          idempotencyKey: { type: 'string', nullable: true },
        },
      },
    },
  };
  const hooks: Record<string, unknown> = {};
  const next = new Map<string, EventSchema>();
  for (const d of EVENT_REGISTRY) {
    const name = eventSchemaName(d.type);
    const schema = objectSchema(d, schemas as Schemas);
    if (schema) {
      schemas[name] = schema as never;
      next.set(d.type, schema);
    }
    hooks[d.type] = {
      description: d.description,
      phase: d.phase,
      ...(d.pendingTask ? { pendingTask: d.pendingTask } : {}),
      ...(schema ? { dto: d.object!.dto, schema: { $ref: `#/components/schemas/${name}` } } : {}),
    };
  }
  published = next;
  components = schemas as Schemas;
  (doc as OpenAPIObject & { 'x-webhooks'?: unknown })['x-webhooks'] = hooks;
  return doc;
}
