import { Injectable } from '@nestjs/common';
import { Prisma, type DomainEvent, type WebhookDelivery } from '@prisma/client';
import { scopeAllows, WEBHOOK_DELIVERY_RETENTION_DAYS, WEBHOOK_EVENT_TYPES } from '@tms/domain';
import { randomUUID } from 'node:crypto';
import { encodeId, tryDecodeId } from '../../common/ids';
import { redactPrices } from '../../common/price-fields';
import { RateLimitService, slidingWindow } from '../../http/rate-limit/rate-limit.service';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { OutboxDispatcher } from '../integration/outbox.dispatcher';
import { eventMatches } from '../integration/outbox.service';
import type {
  DeliveryStatus,
  EventDto,
  EventListQuery,
  EventPageDto,
  WebhookDeliveryDetailDto,
  WebhookDeliveryDto,
  WebhookDeliveryListQuery,
  WebhookResendResultDto,
} from './webhook-ops.dto';
import { MANUAL_OP, WEBHOOK_SINK } from './webhook.sink';
import { WebhookEngine } from './webhook-engine';
import { WebhooksService } from './webhooks.service';
import { assertKeyEventScope, eventReadScope } from './event-read-scope';

export { eventReadScope } from './event-read-scope';

const DAY = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** จำกัดการส่งซ้ำ: event เดิมที่ endpoint เดิม 1 ครั้ง / 2 วิ (กันกดรัว) · ต่อบริษัท 20 ครั้ง / นาที (นับใน process เหมือน "ส่ง event ทดสอบ") */
const PAIR_WINDOW_MS = 2_000;
const TENANT_WINDOW_MS = 60_000;
const TENANT_MAX = 20;

/** ลายเซ็นแสดงบางส่วน (ต้นแบบ `v1=5f3c…`) — ไม่ใช่ secret แต่ไม่จำเป็นต้องเปิดเต็ม */
export function maskSignature(v: string): string {
  return v.replace(/(v1=[0-9a-f]{4})[0-9a-f]+/g, '$1…');
}

/**
 * body ที่ส่ง (envelope) ตามสิทธิ์ราคาของผู้ดู (price-fields.ts กติกาข้อ 3 — ช่องทางที่ไม่ผ่าน JSON response ต้องตัดเอง)
 * JSON → ตัด field ราคาที่ไม่มีสิทธิ์อ่านแล้ว stringify · ไม่ใช่ JSON (ตรวจไม่ได้) → ต้องมีสิทธิ์อ่านราคาทั้งขายและซื้อ ไม่งั้น null
 */
export function viewBody(body: string, rc = requestContext.require()): string | null {
  const scopes = rc.scopes ?? [];
  try {
    return JSON.stringify(redactPrices(JSON.parse(body), scopes, rc.principalType));
  } catch {
    return scopeAllows(scopes, 'prices.sell:read') && scopeAllows(scopes, 'prices.buy:read')
      ? body
      : null;
  }
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

/** รอผลจาก worker เมื่อหยิบคำสั่งเองไม่ได้ (งบเดียวกับ timeout ของการส่ง) */
const RESULT_WAIT_MS = 10_500;
const POLL_MS = 250;

interface Checked {
  endpointId: string;
  eventId: string;
  ev: { type: string; entityType: string; localId: string };
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
    private readonly limiter: RateLimitService,
    private readonly engine: WebhookEngine,
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
      requestBody: viewBody(d.requestBody),
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

  /**
   * ST7-T11 `GET /v1/events`: event สาธารณะของ resource ที่ผู้เรียกอ่านได้เท่านั้น (`events:read` + scope อ่านของ resource —
   * `eventReadScope`) · envelope + mode เดียวกับ webhook (WebhookEngine) · ตัดราคาตามสิทธิ์ (เหมือน payload ใน delivery)
   */
  private readableTypes(): string[] {
    const scopes = requestContext.require().scopes ?? [];
    return WEBHOOK_EVENT_TYPES.filter((t) => scopeAllows(scopes, eventReadScope(t)));
  }

  private async eventDto(ev: DomainEvent): Promise<EventDto> {
    const rc = requestContext.require();
    const env = this.engine.envelopeOf(ev.tenantId, ev, await this.engine.modeOf(ev.tenantId));
    return redactPrices(env, rc.scopes ?? [], rc.principalType) as EventDto;
  }

  async listEvents(q: EventListQuery): Promise<EventPageDto> {
    const limit = q.limit ?? 50;
    const sort = q.sort ?? '-occurredAt';
    const desc = sort === '-occurredAt';
    const op = desc ? 'lt' : 'gt';
    const readable = this.readableTypes();
    const asked = q.type ? q.type.split(',') : null;
    const unknown = asked?.filter((t) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(t));
    if (unknown?.length)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'type', code: 'unknown_event_type', message: `unknown event type ${unknown[0]}` },
      ]);
    // ชนิดที่ขอแต่ไม่มีสิทธิ์อ่าน = ไม่มีรายการ (ไม่ใช่ 403 — เหมือนรายการที่กรองตามสิทธิ์)
    const types = asked ? asked.filter((t) => readable.includes(t)) : readable;
    const and: Prisma.DomainEventWhereInput[] = [{ type: { in: types } }];
    if (q.cursor) {
      const c = decodeCursor(q.cursor, sort);
      and.push({ OR: [{ occurredAt: { [op]: c.u } }, { occurredAt: c.u, id: { [op]: c.i } }] });
    }
    if (q.occurredFrom) and.push({ occurredAt: { gte: new Date(q.occurredFrom) } });
    if (q.occurredTo) and.push({ occurredAt: { lt: new Date(q.occurredTo) } });
    const dir = desc ? 'desc' : 'asc';
    const rows = await this.db.tx.domainEvent.findMany({
      where: { AND: and },
      orderBy: [{ occurredAt: dir }, { id: dir }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1];
    return {
      data: await Promise.all(slice.map((r) => this.eventDto(r))),
      nextCursor: hasMore && last ? cursorOf({ sentAt: last.occurredAt, id: last.id }, sort) : null,
      hasMore,
    };
  }

  /** ST7-T11 `GET /v1/events/{id}` — ไม่ใช่ event สาธารณะ / อ่าน resource ไม่ได้ / บริษัทอื่น = 404 */
  async getEvent(id: string): Promise<EventDto> {
    const ev = await this.db.tx.domainEvent.findFirst({ where: { id } });
    if (!ev || !this.readableTypes().includes(ev.type)) throw new ProblemException('not_found');
    return this.eventDto(ev);
  }

  async get(id: string, tx: Tx = this.db.tx): Promise<WebhookDelivery> {
    const d = await tx.webhookDelivery.findFirst({ where: { id } });
    if (!d) throw new ProblemException('not_found');
    return d;
  }

  // ---------- resend ----------

  /** งบรอผลจาก worker (test ปรับได้) */
  resultWaitMs = RESULT_WAIT_MS;

  /**
   * 429 เมื่อส่งซ้ำถี่เกิน — เรียกหลังตรวจผ่านแล้วเท่านั้น (คำขอที่ถูกปฏิเสธ 4xx ไม่กินโควตา)
   * นับต่อบริษัท 1 ครั้งต่อ endpoint (redeliver ทุก endpoint = หลายครั้ง) + คู่ endpoint/event 1 ครั้ง / 2 วิ
   * ST7-T08: ตัวจำกัดกลาง (ใช้ร่วมทุก instance; หน้าต่างเลื่อนเหมือนเดิม; ฐานใช้ไม่ได้ = 503) [DECISION spec/12 §3]
   */
  private takeSlot(tenantId: string, all: string[]) {
    const pairs = [...new Set(all)]; // review L4: คู่ซ้ำ (endpoint ซ้ำในรายการ) นับครั้งเดียว
    return this.limiter.assert([
      {
        ...slidingWindow(`whr:t:${tenantId}`, TENANT_MAX, TENANT_WINDOW_MS, 'tenant'),
        cost: pairs.length,
      },
      ...pairs.map((p) => slidingWindow(`whr:p:${p}`, 1, PAIR_WINDOW_MS, 'endpoint')),
    ]);
  }

  private withTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>) {
    return this.db.withTenant(tenantId, fn);
  }

  /** `POST /webhook-deliveries/{id}/retry` — ส่ง event ของรายการนี้ไปยัง endpoint เดิมอีกครั้ง */
  async retry(id: string): Promise<WebhookResendResultDto> {
    this.hooks.assertCanManage();
    const tenantId = requestContext.require().tenantId!;
    const started = Date.now();
    const d = await this.withTx(tenantId, (tx) => this.get(id, tx));
    if (d.test || !d.eventId) throw new ProblemException('webhook_not_retryable');
    const p = await this.withTx(tenantId, async (tx) => {
      const c = await this.check(tx, d.endpointId, d.eventId!);
      await this.takeSlot(tenantId, [`${d.endpointId}:${d.eventId}`]);
      return this.insert(tx, tenantId, c, { source: 'retry', deliveryId: d.id });
    });
    return this.run(tenantId, p, started);
  }

  /** `POST /events/{id}/redeliver?endpointId=` — ส่ง event ไปยัง endpoint ที่ระบุ หรือทุก endpoint ที่เปิดอยู่และสมัคร event นี้ */
  async redeliver(eventId: string, endpointId?: string): Promise<WebhookResendResultDto[]> {
    this.hooks.assertCanManage();
    const tenantId = requestContext.require().tenantId!;
    const started = Date.now();
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
      const checked: Checked[] = [];
      for (const t of targets) checked.push(await this.check(tx, t, eventId));
      await this.takeSlot(
        tenantId,
        targets.map((t) => `${t}:${eventId}`),
      );
      const out: Prepared[] = [];
      for (const c of checked)
        out.push(await this.insert(tx, tenantId, c, { source: 'redeliver' }));
      return out;
    });
    return Promise.all(prepared.map((p) => this.run(tenantId, p, started)));
  }

  /**
   * ตรวจก่อนส่งซ้ำ: endpoint ยังอยู่และเปิด · event ภายใน 30 วัน · endpoint ยังสมัคร event ชนิดนี้ (ทั้ง retry และ redeliver)
   */
  private async check(tx: Tx, endpointId: string, eventId: string): Promise<Checked> {
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
      !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(ev.type) ||
      !eventMatches(ev.type, e.events)
    )
      throw new ProblemException('webhook_event_not_subscribed');
    // review G-1: API key ส่งซ้ำได้เฉพาะ event ของ resource ที่ key อ่านได้ (retry + redeliver)
    assertKeyEventScope([ev.type]);
    return { endpointId, eventId, ev };
  }

  /**
   * สร้างคำสั่ง outbox `webhook.redeliver` (transaction ของ tenant — commit ก่อนส่ง)
   * ครั้งที่คาด = มากสุดของ (ครั้งที่บันทึกแล้ว, ครั้งที่กำลังส่ง IN_FLIGHT) + 1 — ค่าจริงจัดสรรตอนส่งใน WebhookSink.allocateAttempt
   * (ล็อกคู่ endpoint/event เดียวกัน) จึงไม่ซ้ำและเพิ่มขึ้นแม้รอบอัตโนมัติส่งพร้อมกัน (INT-106)
   */
  private async insert(
    tx: Tx,
    tenantId: string,
    c: Checked,
    o: { source: 'retry' | 'redeliver'; deliveryId?: string },
  ): Promise<Prepared> {
    const { endpointId, eventId, ev } = c;
    // คู่เดียวกันทีละคำขอ (กันกดพร้อมกันสร้างคำสั่งซ้ำ/ได้ครั้งที่ซ้ำกัน)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${`${endpointId}:${eventId}`}))`;
    const open = await tx.integrationOutbox.findFirst({
      where: {
        sink: WEBHOOK_SINK,
        targetId: endpointId,
        eventId,
        operation: MANUAL_OP,
        status: { in: ['PENDING', 'IN_FLIGHT'] },
      },
      select: { id: true, attempt: true, status: true },
    });
    if (open)
      return {
        outboxId: open.id,
        endpointId,
        eventId,
        attempt: open.status === 'IN_FLIGHT' ? open.attempt : open.attempt + 1,
        existing: true,
      };
    const [m] = await tx.$queryRaw<{ n: number }[]>`
      SELECT greatest(
        (SELECT coalesce(max(attempt), 0) FROM webhook_delivery
          WHERE endpoint_id = ${endpointId}::uuid AND event_id = ${eventId}::uuid),
        (SELECT coalesce(max(attempt), 0) FROM integration_outbox
          WHERE sink = ${WEBHOOK_SINK} AND target_id = ${endpointId} AND event_id = ${eventId}::uuid
            AND status = 'IN_FLIGHT')
      )::int AS n`;
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

  /**
   * หยิบคำสั่งมาส่งทันที แล้วคืนผลจาก webhook_delivery ของคำสั่งนั้น
   * worker หยิบไปก่อน/ปลายทางส่งพร้อมกันครบเพดาน → รอผลจาก worker ภายในงบเวลาเดียวกัน (≤ 10 วิ นับจากรับคำขอ) แล้วจึงตอบ `queued`
   */
  private async run(
    tenantId: string,
    p: Prepared,
    started: number,
  ): Promise<WebhookResendResultDto> {
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
    const read = () =>
      this.withTx(tenantId, async (tx) => ({
        d: await tx.webhookDelivery.findFirst({
          where: { eventId: p.eventId, endpointId: p.endpointId, outboxId: p.outboxId },
          orderBy: { sentAt: 'desc' },
        }),
        cmd: await tx.integrationOutbox.findFirst({
          where: { id: p.outboxId },
          select: { status: true },
        }),
      }));
    let r = await read();
    if (!ran)
      while (
        !r.d &&
        r.cmd &&
        (r.cmd.status === 'PENDING' || r.cmd.status === 'IN_FLIGHT') &&
        Date.now() - started < this.resultWaitMs
      ) {
        await new Promise((ok) => setTimeout(ok, POLL_MS));
        r = await read();
      }
    const { d, cmd } = r;
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
