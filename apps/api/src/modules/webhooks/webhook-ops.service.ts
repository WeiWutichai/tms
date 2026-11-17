import { Injectable } from '@nestjs/common';
import { Prisma, type WebhookDelivery } from '@prisma/client';
import { WEBHOOK_DELIVERY_RETENTION_DAYS, WEBHOOK_EVENT_TYPES } from '@tms/domain';
import { randomUUID } from 'node:crypto';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { OutboxDispatcher } from '../integration/outbox.dispatcher';
import { eventMatches } from '../integration/outbox.service';
import type {
  DeliveryStatus,
  WebhookDeliveryDetailDto,
  WebhookDeliveryDto,
  WebhookDeliveryListQuery,
  WebhookResendResultDto,
} from './webhook-ops.dto';
import { MANUAL_OP, WEBHOOK_SINK } from './webhook.sink';
import { WebhooksService } from './webhooks.service';

const DAY = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** จำกัดการส่งซ้ำ: event เดิมที่ endpoint เดิม 1 ครั้ง / 5 วิ · ต่อบริษัท 20 ครั้ง / นาที (นับใน process เหมือน "ส่ง event ทดสอบ") */
const PAIR_WINDOW_MS = 5_000;
const TENANT_WINDOW_MS = 60_000;
const TENANT_MAX = 20;

/** ลายเซ็นแสดงบางส่วน (ต้นแบบ `v1=5f3c…`) — ไม่ใช่ secret แต่ไม่จำเป็นต้องเปิดเต็ม */
export function maskSignature(v: string): string {
  return v.replace(/(v1=[0-9a-f]{4})[0-9a-f]+/g, '$1…');
}

function cursorOf(r: { sentAt: Date; id: string }, sort: string): string {
  return Buffer.from(JSON.stringify({ u: r.sentAt.toISOString(), i: r.id, s: sort })).toString(
    'base64url',
  );
}

function decodeCursor(c: string, sort: string): { u: Date; i: string } {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as {
      u: string;
      i: string;
      s: string;
    };
    if (v.s !== sort || Number.isNaN(Date.parse(v.u)) || !UUID_RE.test(v.i)) throw new Error();
    return { u: new Date(v.u), i: v.i };
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}

interface Prepared {
  outboxId: string;
  endpointId: string;
  eventId: string;
  attempt: number;
  /** มีคำสั่งส่งซ้ำของคู่นี้รออยู่แล้ว — ไม่สร้างใหม่ */
  existing: boolean;
}

/**
 * Webhook ops (ST7-T05; docs/04 G1 "Webhook ops", G2 #2; spec/07 INT-105/106/109)
 * - ประวัติการส่ง `GET /webhook-deliveries` (1 แถว/ครั้ง) + รายละเอียด (payload/response — ไม่มี secret)
 * - ส่งซ้ำด้วยมือ `POST /webhook-deliveries/{id}/retry` / `POST /events/{id}/redeliver?endpointId=`
 *   ผ่าน outbox เสมอ: คำสั่ง `webhook.redeliver` (envelope id = `evt_` เดิม, X-TMS-Attempt ต่อจากครั้งล่าสุด,
 *   ส่งผ่าน sink/SSRF guard เดียวกัน) แล้วหยิบมาส่งทันทีในคำขอ (รอผล ≤ 10 วิ เหมือน "ส่ง event ทดสอบ")
 *   หยิบไม่ได้ = เข้าคิวให้ worker (state `queued`) · ส่งซ้ำ 1 ครั้ง ไม่ retry อัตโนมัติ · สำเร็จ = ยกเลิกรอบอัตโนมัติที่ค้างของคู่นั้น
 * - ภายใน 30 วันหลัง event เกิด (INT-106) · endpoint ต้องเปิดอยู่ · ลง audit ที่ endpoint
 */
@Injectable()
export class WebhookOpsService {
  constructor(
    private readonly db: DbService,
    private readonly hooks: WebhooksService,
    private readonly dispatcher: OutboxDispatcher,
  ) {}

  // ---------- read ----------

  toDto(d: WebhookDelivery): WebhookDeliveryDto {
    return {
      id: encodeId('webhookDelivery', d.id),
      endpointId: encodeId('webhookEndpoint', d.endpointId),
      eventId: d.envelopeId,
      eventType: d.eventType,
      attempt: d.attempt,
      test: d.test,
      status: d.status.toLowerCase() as DeliveryStatus,
      requestUrl: d.requestUrl,
      responseStatus: d.responseStatus,
      durationMs: d.durationMs,
      errorCode: d.errorCode,
      sentAt: d.sentAt.toISOString(),
      nextRetryAt: d.nextRetryAt?.toISOString() ?? null,
    };
  }

  detailDto(d: WebhookDelivery): WebhookDeliveryDetailDto {
    const raw = (d.requestHeaders ?? {}) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const s = String(v);
      headers[k] = /^x-tms-signature$/i.test(k) ? maskSignature(s) : s;
    }
    return {
      ...this.toDto(d),
      requestHeaders: headers,
      requestBody: d.requestBody,
      responseBody: d.responseBody,
      errorMessage: d.errorMessage,
    };
  }

  async list(q: WebhookDeliveryListQuery) {
    const tx = this.db.tx;
    const limit = q.limit ?? 50;
    const sort = q.sort ?? '-sentAt';
    const desc = sort === '-sentAt';
    const op = desc ? 'lt' : 'gt';
    const and: Prisma.WebhookDeliveryWhereInput[] = [];
    if (q.cursor) {
      const c = decodeCursor(q.cursor, sort);
      and.push({ OR: [{ sentAt: { [op]: c.u } }, { sentAt: c.u, id: { [op]: c.i } }] });
    }
    if (q.eventId) and.push({ envelopeId: q.eventId });
    if (q.endpointId) {
      const ep = tryDecodeId('webhookEndpoint', q.endpointId);
      // รหัสผิด/ของบริษัทอื่น = ไม่พบรายการ (RLS กรองอยู่แล้ว)
      and.push({ endpointId: ep ?? '00000000-0000-0000-0000-000000000000' });
    }
    if (q.status)
      and.push({
        status: {
          in: q.status.split(',').map((s) => s.toUpperCase()) as WebhookDelivery['status'][],
        },
      });
    if (q.eventType) and.push({ eventType: q.eventType });
    if (q.test !== undefined) and.push({ test: q.test });
    if (q.sentFrom) and.push({ sentAt: { gte: new Date(q.sentFrom) } });
    if (q.sentTo) and.push({ sentAt: { lt: new Date(q.sentTo) } });
    const dir = desc ? 'desc' : 'asc';
    const rows = await tx.webhookDelivery.findMany({
      where: { AND: and },
      orderBy: [{ sentAt: dir }, { id: dir }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1];
    return {
      data: slice.map((r) => this.toDto(r)),
      nextCursor: hasMore && last ? cursorOf(last, sort) : null,
      hasMore,
    };
  }

  async get(id: string, tx: Tx = this.db.tx): Promise<WebhookDelivery> {
    const d = await tx.webhookDelivery.findFirst({ where: { id } });
    if (!d) throw new ProblemException('not_found');
    return d;
  }

  // ---------- resend ----------

  private readonly hits = new Map<string, number[]>();

  /** 429 เมื่อส่งซ้ำถี่เกิน — คืนเฉพาะเมื่อผ่าน (บันทึกครั้ง) */
  private takeSlot(tenantId: string, pairs: string[], now = Date.now()) {
    const wait = (key: string, windowMs: number, max: number) => {
      const xs = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
      return xs.length >= max ? Math.ceil((windowMs - (now - xs[0]!)) / 1000) : 0;
    };
    const w = Math.max(
      wait(`t:${tenantId}`, TENANT_WINDOW_MS, TENANT_MAX),
      ...pairs.map((p) => wait(`p:${p}`, PAIR_WINDOW_MS, 1)),
    );
    if (w) throw new ProblemException('rate_limited', undefined, undefined, { retryAfter: w });
    for (const k of [`t:${tenantId}`, ...pairs.map((p) => `p:${p}`)])
      this.hits.set(k, [...(this.hits.get(k) ?? []).filter((t) => now - t < TENANT_WINDOW_MS), now]);
    if (this.hits.size > 10_000) this.hits.clear();
  }

  private withTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>) {
    return this.db.withTenant(tenantId, fn);
  }

  /** `POST /webhook-deliveries/{id}/retry` — ส่ง event ของรายการนี้ไปยัง endpoint เดิมอีกครั้ง */
  async retry(id: string): Promise<WebhookResendResultDto> {
    this.hooks.assertHuman();
    const tenantId = requestContext.require().tenantId!;
    const d = await this.withTx(tenantId, (tx) => this.get(id, tx));
    if (d.test || !d.eventId) throw new ProblemException('webhook_not_retryable');
    const p = await this.withTx(tenantId, async (tx) => {
      this.takeSlot(tenantId, [`${d.endpointId}:${d.eventId}`]);
      return this.prepare(tx, tenantId, d.endpointId, d.eventId!, {
        source: 'retry',
        deliveryId: d.id,
        checkSubscribed: false,
      });
    });
    return this.run(tenantId, p);
  }

  /** `POST /events/{id}/redeliver?endpointId=` — ส่ง event ไปยัง endpoint ที่ระบุ หรือทุก endpoint ที่เปิดอยู่และสมัคร event นี้ */
  async redeliver(eventId: string, endpointId?: string): Promise<WebhookResendResultDto[]> {
    this.hooks.assertHuman();
    const tenantId = requestContext.require().tenantId!;
    const prepared = await this.withTx(tenantId, async (tx) => {
      const ev = await tx.domainEvent.findFirst({ where: { id: eventId }, select: { type: true } });
      if (!ev) throw new ProblemException('not_found');
      let targets: string[];
      if (endpointId) targets = [endpointId];
      else {
        const eps = await tx.webhookEndpoint.findMany({
          where: { deletedAt: null, status: 'ACTIVE' },
          select: { id: true, events: true },
          orderBy: { createdAt: 'asc' },
        });
        targets = eps.filter((e) => eventMatches(ev.type, e.events)).map((e) => e.id);
        if (!targets.length) throw new ProblemException('webhook_event_not_subscribed');
      }
      this.takeSlot(
        tenantId,
        targets.map((t) => `${t}:${eventId}`),
      );
      const out: Prepared[] = [];
      for (const t of targets)
        out.push(
          await this.prepare(tx, tenantId, t, eventId, {
            source: 'redeliver',
            checkSubscribed: true,
          }),
        );
      return out;
    });
    return Promise.all(prepared.map((p) => this.run(tenantId, p)));
  }

  /**
   * สร้างคำสั่ง outbox `webhook.redeliver` (transaction ของ tenant — commit ก่อนส่ง)
   * attempt เริ่ม = ครั้งล่าสุดของคู่ (endpoint, event) → worker/runNow +1 = X-TMS-Attempt ถัดไป (INT-106)
   */
  private async prepare(
    tx: Tx,
    tenantId: string,
    endpointId: string,
    eventId: string,
    o: { source: 'retry' | 'redeliver'; deliveryId?: string; checkSubscribed: boolean },
  ): Promise<Prepared> {
    const e = await tx.webhookEndpoint.findFirst({ where: { id: endpointId, deletedAt: null } });
    if (!e) throw new ProblemException('not_found');
    // endpoint ปิดอยู่ → sink จะข้าม (SKIPPED) — แจ้งให้เปิดก่อน (เปิดแล้วส่ง event ที่ค้างระหว่างปิดได้ — INT-105)
    if (e.status !== 'ACTIVE')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        endpointStatus: e.status.toLowerCase(),
      });
    const ev = await tx.domainEvent.findFirst({ where: { id: eventId } });
    if (!ev) throw new ProblemException('not_found');
    if (ev.occurredAt.getTime() < Date.now() - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY)
      throw new ProblemException('webhook_event_expired');
    if (
      o.checkSubscribed &&
      (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(ev.type) ||
        !eventMatches(ev.type, e.events))
    )
      throw new ProblemException('webhook_event_not_subscribed');
    // คู่เดียวกันทีละคำขอ (กันกดพร้อมกันสร้างคำสั่งซ้ำ)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${`${endpointId}:${eventId}`}))`;
    const open = await tx.integrationOutbox.findFirst({
      where: {
        sink: WEBHOOK_SINK,
        targetId: endpointId,
        eventId,
        operation: MANUAL_OP,
        status: { in: ['PENDING', 'IN_FLIGHT'] },
      },
      select: { id: true, attempt: true },
    });
    if (open)
      return { outboxId: open.id, endpointId, eventId, attempt: open.attempt + 1, existing: true };
    const [m] = await tx.$queryRaw<{ n: number }[]>`
      SELECT coalesce(max(attempt), 0)::int AS n FROM webhook_delivery
       WHERE endpoint_id = ${endpointId}::uuid AND event_id = ${eventId}::uuid`;
    const base = m?.n ?? 0;
    const id = randomUUID();
    const ctx = requestContext.require();
    const payload = {
      source: o.source,
      ...(o.deliveryId ? { deliveryId: encodeId('webhookDelivery', o.deliveryId) } : {}),
      requestedBy: ctx.actorId ?? null,
    };
    await tx.$executeRaw`
      INSERT INTO integration_outbox (id, tenant_id, kind, sink, target_id, operation, entity_type, local_id, event_id,
                                      event_type, serialize_key, idempotency_key, payload, attempt, max_attempt, updated_at)
      VALUES (${id}::uuid, ${tenantId}::uuid, 'WEBHOOK'::"OutboxKind", ${WEBHOOK_SINK}, ${endpointId}, ${MANUAL_OP},
              ${ev.entityType}, ${ev.localId}::uuid, ${eventId}::uuid, ${ev.type},
              ${`${WEBHOOK_SINK}:${endpointId}:manual:${id}`}, ${`${WEBHOOK_SINK}:${endpointId}:${MANUAL_OP}:${id}`},
              ${JSON.stringify(payload)}::jsonb, ${base}, ${base + 1}, now())`;
    await tx.auditLog.create({
      data: {
        tenantId,
        actorId: ctx.actorId ?? null,
        actAs: ctx.actAs ?? null,
        action:
          o.source === 'retry'
            ? 'webhook_endpoint.delivery_retried'
            : 'webhook_endpoint.event_redelivered',
        entityType: 'webhook_endpoint',
        entityId: endpointId,
        after: {
          eventId: encodeId('event', eventId),
          eventType: ev.type,
          attempt: base + 1,
          ...(o.deliveryId ? { deliveryId: encodeId('webhookDelivery', o.deliveryId) } : {}),
        },
        requestId: ctx.requestId,
        ip: ctx.ip ?? null,
      },
    });
    return { outboxId: id, endpointId, eventId, attempt: base + 1, existing: false };
  }

  /** หยิบคำสั่งมาส่งทันที แล้วคืนผลจาก webhook_delivery ของคำสั่งนั้น */
  private async run(tenantId: string, p: Prepared): Promise<WebhookResendResultDto> {
    const ran = p.existing ? false : await this.dispatcher.runNow(p.outboxId);
    const base: WebhookResendResultDto = {
      endpointId: encodeId('webhookEndpoint', p.endpointId),
      eventId: encodeId('event', p.eventId),
      attempt: p.attempt,
      state: 'queued',
      deliveryId: null,
      status: null,
      durationMs: null,
      errorCode: null,
    };
    if (!ran) return base;
    const { d, cmd } = await this.withTx(tenantId, async (tx) => ({
      d: await tx.webhookDelivery.findFirst({
        where: { eventId: p.eventId, endpointId: p.endpointId, outboxId: p.outboxId },
        orderBy: { sentAt: 'desc' },
      }),
      cmd: await tx.integrationOutbox.findFirst({
        where: { id: p.outboxId },
        select: { status: true },
      }),
    }));
    if (!d) return { ...base, state: cmd?.status === 'SKIPPED' ? 'skipped' : 'queued' };
    return {
      ...base,
      attempt: d.attempt,
      state: d.status === 'DELIVERED' ? 'delivered' : 'failed',
      deliveryId: encodeId('webhookDelivery', d.id),
      status: d.responseStatus,
      durationMs: d.durationMs,
      errorCode: d.errorCode,
    };
  }
}
