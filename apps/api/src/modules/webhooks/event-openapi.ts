import type { OpenAPIObject } from '@nestjs/swagger';
import { EVENT_REGISTRY, eventSchemaName } from '@tms/domain';

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
  for (const d of EVENT_REGISTRY) {
    const name = eventSchemaName(d.type);
    if (d.schema)
      schemas[name] = {
        ...d.schema,
        description: `\`data.object\` ของ ${d.type} — ${d.description}`,
      } as never;
    hooks[d.type] = {
      description: d.description,
      phase: d.phase,
      ...(d.pendingTask ? { pendingTask: d.pendingTask } : {}),
      ...(d.schema ? { schema: { $ref: `#/components/schemas/${name}` } } : {}),
    };
  }
  (doc as OpenAPIObject & { 'x-webhooks'?: unknown })['x-webhooks'] = hooks;
  return doc;
}
