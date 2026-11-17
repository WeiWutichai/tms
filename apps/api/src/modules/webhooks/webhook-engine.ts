import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, WebhookEndpoint } from '@prisma/client';
import {
  WEBHOOK_AUTO_DISABLE_AFTER,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_SCHEDULE_MIN,
} from '@tms/domain';
import { randomBytes } from 'node:crypto';
import { FieldCipher } from '../../common/crypto';
import { encodeId } from '../../common/ids';
import type { Tx } from '../../db/db.service';
import { retryDelayMin } from '../integration/outbox.dispatcher';
import type { OutboxEvent } from '../integration/outbox.types';
import { NotificationService } from '../notifications/notification.service';
import { signatureHeader } from './signature';
import {
  postWebhook,
  WEBHOOK_STORED_RESPONSE_BYTES,
  type SendOptions,
  type SendResult,
} from './webhook-http';

/** header ที่ผู้ใช้ตั้งเพิ่มไม่ได้ (spec/07 §10: ห้ามทับ X-TMS-* / Content-Type) + header ระดับการเชื่อมต่อ */
export const RESERVED_HEADER =
  /^(x-tms-.*|content-type|content-length|host|user-agent|connection|transfer-encoding|te|trailer|upgrade|keep-alive|proxy-.*|expect)$/i;

export interface ExtraHeader {
  name: string;
  value: string;
}

/** envelope ของ webhook (INT-100; benchmark 9.4) */
export interface WebhookEnvelope {
  id: string;
  type: string;
  version: string;
  occurredAt: string;
  tenantId: string;
  mode: 'live' | 'test';
  /** event ทดสอบ (INT-107) */
  test?: true;
  data: { object: unknown; previousAttributes: unknown };
  request: { id: string | null; idempotencyKey: string | null };
}

/** ABORTED = ถูกยกเลิกกลางส่ง (lease หาย/ปิด worker) — ไม่บันทึก delivery ไม่นับล้มเหลว */
export type Outcome = 'DELIVERED' | 'FAILED' | 'EXHAUSTED' | 'ABORTED';

export interface AttemptResult {
  outcome: Outcome;
  retryable: boolean;
  send: SendResult;
  /** สรุปข้อผิดพลาดแบบคงที่ (http_status / redirect / timeout / network / ssrf_blocked / invalid_url) */
  errorCode: string | null;
  nextRetryAt: Date | null;
  deliveryId: string;
}

/** 2xx = สำเร็จ · 408/429/5xx/timeout/network = ลองใหม่ · อื่น (3xx, 4xx, SSRF, URL เสีย) = ไม่ลองใหม่ (INT-103) */
export function classifySend(r: SendResult): {
  ok: boolean;
  retryable: boolean;
  errorCode: string | null;
} {
  if (r.status !== null) {
    if (r.status >= 200 && r.status < 300) return { ok: true, retryable: false, errorCode: null };
    if (r.status >= 300 && r.status < 400)
      return { ok: false, retryable: false, errorCode: 'redirect' };
    return {
      ok: false,
      retryable: r.status === 408 || r.status === 429 || r.status >= 500,
      errorCode: 'http_status',
    };
  }
  const code = r.errorCode ?? 'network';
  return { ok: false, retryable: code === 'timeout' || code === 'network', errorCode: code };
}

/** เวลารอก่อนครั้งถัดไป (ms) หลังครั้งที่ `attempt` ล้ม — ตาราง G1 + jitter ±10% (ตัวเดียวกับ outbox) */
export function webhookRetryDelayMs(attempt: number): number {
  return Math.round(retryDelayMin(attempt, WEBHOOK_RETRY_SCHEDULE_MIN) * 60_000);
}

/**
 * แกนการส่ง webhook (ST7-T04) — ใช้ทั้ง sink ของ outbox (event จริง + verification) และ "ส่ง event ทดสอบ" (sync)
 * ประกอบ envelope → เซ็น (2 ลายเซ็นช่วงหมุน secret) → POST แบบกัน SSRF → บันทึก webhook_delivery 1 แถว/ครั้ง
 * → ปรับตัวนับล้มเหลวติดกัน / ปิดอัตโนมัติ + แจ้งผู้ดูแล (event จริงเท่านั้น — ทดสอบไม่นับ INT-107)
 */
@Injectable()
export class WebhookEngine {
  private readonly logger = new Logger('WebhookEngine');
  private cipherInstance?: FieldCipher;
  /** test: ฉีด resolver/timeout/allowPrivate */
  sendOptions: SendOptions = {};

  constructor(private readonly notifications: NotificationService) {}

  get cipher(): FieldCipher {
    return (this.cipherInstance ??= new FieldCipher());
  }

  /** secret ที่ใช้เซ็นตอนนี้ (ปัจจุบัน + เดิมถ้ายังอยู่ในช่วง 24 ชม. หลังหมุน) */
  secrets(e: WebhookEndpoint, now = new Date()): string[] {
    const out = [this.cipher.decrypt(e.secretEnc)];
    if (e.secretPrevEnc && e.secretPrevExpiresAt && e.secretPrevExpiresAt > now)
      out.push(this.cipher.decrypt(e.secretPrevEnc));
    return out;
  }

  extraHeaders(e: WebhookEndpoint): ExtraHeader[] {
    if (!e.extraHeadersEnc) return [];
    return JSON.parse(this.cipher.decrypt(e.extraHeadersEnc)) as ExtraHeader[];
  }

  envelopeOf(tenantId: string, ev: OutboxEvent): WebhookEnvelope {
    return {
      id: encodeId('event', ev.id),
      type: ev.type,
      version: String(ev.version),
      occurredAt: ev.occurredAt.toISOString(),
      tenantId: encodeId('tenant', tenantId),
      mode: 'live',
      data: { object: ev.snapshot ?? null, previousAttributes: ev.previousAttributes ?? null },
      request: { id: ev.requestId, idempotencyKey: null },
    };
  }

  /** envelope ระบบ (webhook.test / webhook.verification) — id ใหม่ทุกครั้ง */
  systemEnvelope(tenantId: string, type: string, object: unknown, id?: string): WebhookEnvelope {
    return {
      id: id ?? `evt_${randomBytes(16).toString('hex')}`,
      type,
      version: '1',
      occurredAt: new Date().toISOString(),
      tenantId: encodeId('tenant', tenantId),
      mode: 'live',
      test: true,
      data: { object, previousAttributes: null },
      request: { id: null, idempotencyKey: null },
    };
  }

  /**
   * ส่ง 1 ครั้ง + บันทึก delivery (+ ตัวนับ/ปิดอัตโนมัติ) — ไม่โยน error ของปลายทาง (คืนผล)
   * `withTx` เปิด transaction ของ tenant (RLS) — ห้ามถือ transaction ระหว่างรอปลายทาง
   */
  async attempt(input: {
    tenantId: string;
    endpoint: WebhookEndpoint;
    envelope: WebhookEnvelope;
    attempt: number;
    test: boolean;
    outboxId?: string | null;
    eventId?: string | null;
    signal?: AbortSignal;
    withTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
    /** ผลสำเร็จต้องมีเงื่อนไขเพิ่ม (verification: ต้อง echo challenge) */
    onDelivered?: (tx: Tx, r: SendResult) => Promise<void>;
  }): Promise<AttemptResult> {
    const e = input.endpoint;
    const raw = JSON.stringify(input.envelope);
    const t = Math.floor(Date.now() / 1000);
    const extra = this.extraHeaders(e).filter((h) => !RESERVED_HEADER.test(h.name));
    const sys: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'TMS-Webhooks/1.0',
      'X-TMS-Event': input.envelope.type,
      'X-TMS-Event-Id': input.envelope.id,
      'X-TMS-Timestamp': String(t),
      'X-TMS-Signature': signatureHeader(t, raw, this.secrets(e)),
      'X-TMS-Attempt': String(input.attempt),
    };
    const headers = { ...Object.fromEntries(extra.map((h) => [h.name, h.value])), ...sys };
    const sentAt = new Date();
    const send = await postWebhook(e.url, headers, raw, {
      ...this.sendOptions,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (send.errorCode === 'aborted')
      return {
        outcome: 'ABORTED',
        retryable: false,
        send,
        errorCode: 'aborted',
        nextRetryAt: null,
        deliveryId: '',
      };
    const cls = classifySend(send);
    const last = input.test || !cls.retryable || input.attempt >= WEBHOOK_MAX_ATTEMPTS;
    const outcome: Outcome = cls.ok ? 'DELIVERED' : last ? 'EXHAUSTED' : 'FAILED';
    const nextRetryAt =
      outcome === 'FAILED' ? new Date(Date.now() + webhookRetryDelayMs(input.attempt)) : null;
    const stored = {
      ...sys,
      ...Object.fromEntries(extra.map((h) => [h.name, '***'])),
    };
    const deliveryId = await input.withTx(async (tx) => {
      const d = await tx.webhookDelivery.create({
        data: {
          tenantId: input.tenantId,
          endpointId: e.id,
          outboxId: input.outboxId ?? null,
          eventId: input.eventId ?? null,
          envelopeId: input.envelope.id,
          eventType: input.envelope.type,
          attempt: input.attempt,
          test: input.test,
          status: outcome,
          requestUrl: e.url,
          requestHeaders: stored as Prisma.InputJsonValue,
          requestBody: raw,
          responseStatus: send.status,
          responseBody: send.status === null ? null : truncate(send.body),
          durationMs: send.durationMs,
          errorCode: cls.errorCode,
          errorClass: cls.ok ? null : cls.retryable ? 'TRANSIENT' : 'VALIDATION',
          errorMessage: send.errorMessage ?? null,
          sentAt,
          nextRetryAt,
        },
        select: { id: true },
      });
      // invalid_request = ประกอบคำขอไม่ได้ (ฝั่งเรา) — ไม่ใช่ความล้มเหลวของผู้รับ จึงไม่นับเข้าการปิดอัตโนมัติ
      await this.afterAttempt(
        tx,
        input.tenantId,
        e,
        outcome,
        input.test || cls.errorCode === 'invalid_request',
      );
      if (cls.ok && input.onDelivered) await input.onDelivered(tx, send);
      return d.id;
    });
    return {
      outcome,
      retryable: cls.retryable,
      send,
      errorCode: cls.errorCode,
      nextRetryAt,
      deliveryId,
    };
  }

  /** ส่งล่าสุด / สำเร็จล่าสุด / ล้มเหลวติดกัน → ปิดอัตโนมัติเมื่อครบ 50 event (ทดสอบไม่นับ) */
  private async afterAttempt(
    tx: Tx,
    tenantId: string,
    e: WebhookEndpoint,
    outcome: Outcome,
    test: boolean,
  ): Promise<void> {
    const now = new Date();
    // ทดสอบ/verification ไม่นับเป็นการส่ง event (INT-107) — ไม่แตะส่งล่าสุด/อัตราสำเร็จ/ตัวนับ
    if (test) return;
    if (outcome === 'DELIVERED') {
      await tx.webhookEndpoint.update({
        where: { id: e.id },
        data: { lastDeliveryAt: now, lastSuccessAt: now, consecutiveFailures: 0 },
      });
      return;
    }
    if (outcome === 'FAILED') {
      await tx.webhookEndpoint.update({
        where: { id: e.id },
        data: { lastDeliveryAt: now, lastFailureAt: now },
      });
      return;
    }
    // EXHAUSTED: event นี้ล้มขั้นสุดท้าย → นับต่อ (atomic) แล้วปิดเมื่อครบ
    const [row] = await tx.$queryRaw<
      { n: number; status: string; created_by: string | null; description: string | null }[]
    >`
      UPDATE webhook_endpoint
         SET consecutive_failures = consecutive_failures + 1, last_delivery_at = ${now},
             last_failure_at = ${now}, updated_at = now()
       WHERE id = ${e.id}::uuid
      RETURNING consecutive_failures AS n, status::text AS status, created_by, description`;
    if (!row || row.n < WEBHOOK_AUTO_DISABLE_AFTER || row.status !== 'ACTIVE') return;
    await this.autoDisable(tx, tenantId, e.id, row.n, row.created_by, row.description);
  }

  private async autoDisable(
    tx: Tx,
    tenantId: string,
    id: string,
    failures: number,
    createdBy: string | null,
    description: string | null,
  ) {
    const reason = `auto-disabled after ${failures} consecutive failed events`;
    const n = await tx.webhookEndpoint.updateMany({
      where: { id, status: 'ACTIVE' },
      data: {
        status: 'AUTO_DISABLED',
        disabledAt: new Date(),
        disabledReason: reason,
        disabledBy: null,
        version: { increment: 1 },
      },
    });
    if (n.count !== 1) return;
    await tx.integrationSubscription.updateMany({
      where: { sink: 'webhook', targetId: id },
      data: { active: false },
    });
    await tx.auditLog.create({
      data: {
        tenantId,
        actorId: null,
        action: 'webhook_endpoint.auto_disabled',
        entityType: 'webhook_endpoint',
        entityId: id,
        before: { status: 'ACTIVE' },
        after: { status: 'AUTO_DISABLED', consecutiveFailures: failures },
        reason,
      },
    });
    const uuid = /^[0-9a-f-]{36}$/i;
    await this.notifications.notify(tx, {
      tenantId,
      to: {
        roles: ['owner', 'admin'],
        ...(createdBy && uuid.test(createdBy) ? { userIds: [createdBy] } : {}),
      },
      template: 'webhook.auto_disabled',
      vars: {
        label: description?.trim() || encodeId('webhookEndpoint', id),
        failures,
      },
      link: '/settings/api?tab=hooks',
      entity: { type: 'webhook_endpoint', id },
    });
    this.logger.warn(
      JSON.stringify({ msg: 'webhook auto-disabled', tenantId, endpointId: id, failures }),
    );
  }
}

/** ตัดที่ 4 KB ตามจำนวน byte (UTF-8) ไม่ตัดกลางอักขระ */
export function truncate(s: string): string {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= WEBHOOK_STORED_RESPONSE_BYTES) return s;
  return new TextDecoder('utf-8', { fatal: false })
    .decode(b.subarray(0, WEBHOOK_STORED_RESPONSE_BYTES))
    .replace(/\uFFFD+$/, '');
}
