import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Tx } from '../../db/db.service';

/** ชนิด event ที่ subscription รับ: ชื่อเต็ม `entity.action`, `entity.*` หรือ `*` */
export const EVENT_PATTERN_RE = /^(\*|[a-z][a-z0-9_]*\.(\*|[a-z][a-z0-9_]*))$/;
export const SINK_KEY_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/** ตรงกับเงื่อนไขใน trigger `tms_domain_event_to_outbox` (ใช้ใน test/หน้าจอ) */
export function eventMatches(type: string, patterns: readonly string[]): boolean {
  return (
    patterns.includes(type) ||
    patterns.includes('*') ||
    patterns.includes(`${type.split('.')[0]}.*`)
  );
}

/** คีย์ลูกค้าแบบเดียวกับ `tms_outbox_customer_key` ใน SQL (รับทั้ง `cus_<hex32>` และ uuid) */
export function customerKey(customerId: string | null | undefined): string | null {
  if (!customerId) return null;
  return customerId.replace(/^cus_/, '').replace(/-/g, '').toLowerCase() || null;
}

/** JSON ที่เรียง key แล้ว — hash เดียวกันเมื่อข้อมูลเท่ากัน (docs/01 §6.2 payload_hash) */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export interface SubscribeInput {
  tenantId: string;
  kind: 'ADAPTER' | 'WEBHOOK';
  sink: string;
  targetId?: string | null;
  eventTypes: string[];
  operation?: string | null;
  createdBy?: string | null;
}

export interface CommandInput {
  tenantId: string;
  kind: 'ADAPTER' | 'WEBHOOK';
  sink: string;
  targetId?: string | null;
  operation: string;
  entityType: string;
  localId: string;
  eventId?: string | null;
  /** ลูกค้าของเอกสาร — คีย์ serialize (ปลายทาง, ลูกค้า) */
  customerId?: string | null;
  payload: Record<string, unknown>;
  maxAttempt?: number;
}

/**
 * ST7-T03 ฝั่งเขียนของ outbox (ใช้ใน transaction ของ request เสมอ)
 * - `subscribe` — ผู้รับ event (webhook endpoint ST7-T04 / connector ST7-T13) → trigger บน domain_event สร้างคำสั่งให้เอง
 * - `enqueueCommand` — คำสั่งที่มี canonical payload (เช่น PUSH_INVOICE ของ ST7-T16)
 *   idempotency_key = `{sink}:{target}:{entity_type}:{local_id}:{payload_hash}` (docs/01 §6.2 ชั้นคำสั่ง) — payload เดิมได้คำสั่งเดียว
 */
@Injectable()
export class OutboxService {
  async subscribe(tx: Tx, input: SubscribeInput) {
    if (!SINK_KEY_RE.test(input.sink)) throw new Error(`invalid sink key '${input.sink}'`);
    if (!input.eventTypes.length || !input.eventTypes.every((p) => EVENT_PATTERN_RE.test(p)))
      throw new Error(`invalid event type pattern: ${input.eventTypes.join(',')}`);
    return tx.integrationSubscription.create({
      data: {
        tenantId: input.tenantId,
        kind: input.kind,
        sink: input.sink,
        targetId: input.targetId ?? null,
        eventTypes: input.eventTypes,
        operation: input.operation ?? null,
        createdBy: input.createdBy ?? null,
      },
    });
  }

  /** คืน { id, created } — created=false เมื่อมีคำสั่ง payload เดิมอยู่แล้ว */
  async enqueueCommand(tx: Tx, c: CommandInput): Promise<{ id: string; created: boolean }> {
    if (!SINK_KEY_RE.test(c.sink)) throw new Error(`invalid sink key '${c.sink}'`);
    const target = c.targetId ?? '-';
    const hash = createHash('sha256').update(canonicalJson(c.payload)).digest('hex');
    const idempotencyKey = `${c.sink}:${target}:${c.entityType}:${c.localId}:${hash}`;
    const cust = c.entityType === 'customer' ? customerKey(c.localId) : customerKey(c.customerId);
    const serializeKey = `${c.sink}:${target}:${cust ? `cus:${cust}` : `${c.entityType}:${c.localId}`}`;
    const rows = await tx.$queryRaw<{ id: string; created: boolean }[]>`
      INSERT INTO integration_outbox (tenant_id, kind, sink, target_id, operation, entity_type, local_id, event_id,
                                      serialize_key, idempotency_key, payload, max_attempt, updated_at)
      VALUES (${c.tenantId}::uuid, ${c.kind}::"OutboxKind", ${c.sink}, ${c.targetId ?? null}, ${c.operation},
              ${c.entityType}, ${c.localId}::uuid, ${c.eventId ?? null}::uuid, ${serializeKey}, ${idempotencyKey},
              ${canonicalJson(c.payload)}::jsonb, ${c.maxAttempt ?? 7}, now())
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING id, true AS created`;
    if (rows[0]) return rows[0];
    const existing = await tx.integrationOutbox.findFirstOrThrow({
      where: { tenantId: c.tenantId, idempotencyKey },
      select: { id: true },
    });
    return { id: existing.id, created: false };
  }
}
