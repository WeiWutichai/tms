import { randomBytes } from 'node:crypto';
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

/**
 * ตัวอย่าง `data.object` (ข้อมูลสมมติ) สร้างจาก schema — ทุก field ที่ประกาศ (ST7-T09 QA L1: ให้ใกล้ของจริง)
 * id รูปจริง (prefix + 32 hex ใหม่ทุกครั้ง) · enum = ค่าแรก · array มี 1 รายการ · วันเวลา = ตอนนี้ · nullable ที่ไม่มีตัวอย่าง = null
 * pending (ยังไม่มีรูป) = โครงทั่วไป
 */
export function eventSample(type: string): Record<string, unknown> {
  const s = published.get(type);
  if (!s) return pendingExample(type);
  return sampleOf(s, 0) as Record<string, unknown>;
}

const ID_EXAMPLE = /^([a-z]{2,4})_(…|\.\.\.|[0-9a-f]{0,32}…?)$/;
const hex32 = () => randomBytes(16).toString('hex');

function sampleOf(s: EventSchema, depth: number): unknown {
  if (depth > 12) return null;
  if (s.$ref) return sampleOf(components[s.$ref.split('/').pop()!] ?? {}, depth + 1);
  if (s.allOf?.length) return sampleOf(s.allOf[0]!, depth + 1);
  if (s.oneOf?.length) return sampleOf(s.oneOf[0]!, depth + 1);
  if (s.enum?.length) return s.enum.find((v) => v !== null) ?? null;
  if (typeof s.example === 'string') {
    const id = ID_EXAMPLE.exec(s.example);
    if (id) return `${id[1]}_${hex32()}`;
  }
  if (s.example !== undefined && s.type !== 'object' && s.type !== 'array') return s.example;
  switch (s.type) {
    case 'object': {
      if (!s.properties) return {};
      return Object.fromEntries(
        Object.entries(s.properties).map(([k, v]) => [k, sampleOf(v, depth + 1)]),
      );
    }
    case 'array': {
      // ลึกเกิน (array ซ้อนใน array) = ว่าง — ไม่ให้ถึงขีดจำกัดความลึกแล้วได้ null ใน field ที่ไม่ nullable
      if (depth > 4 && !s.minItems) return [];
      const n = Math.max(1, typeof s.minItems === 'number' ? s.minItems : 1);
      const items = Array.from({ length: n }, () =>
        s.items ? sampleOf(s.items, depth + 1) : null,
      );
      return items[0] === null && !s.minItems ? [] : items;
    }
    case 'integer':
    case 'number':
      return s.nullable ? null : typeof s.minimum === 'number' ? Math.max(s.minimum, 1) : 1;
    case 'boolean':
      return s.nullable ? null : false;
    case 'string':
      if (s.format === 'date-time') return new Date().toISOString();
      if (s.format === 'date') return new Date().toISOString().slice(0, 10);
      if (s.nullable) return null;
      return s.pattern ? null : 'ตัวอย่าง';
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
