import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { WebhookEndpoint } from '@prisma/client';
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_SCHEDULE_MIN } from '@tms/domain';
import { EntitlementService } from '../entitlements/entitlement.service';
import { OutboxSinkRegistry } from '../integration/outbox-sink.registry';
import { OutboxSinkError, type OutboxDelivery, type OutboxSink } from '../integration/outbox.types';
import { WebhookEngine } from './webhook-engine';

export const WEBHOOK_SINK = 'webhook';
/** คำสั่งยืนยันปลายทาง (สร้างตอนเพิ่ม endpoint) — operation ของ outbox */
export const VERIFICATION_OP = 'webhook.verification';

/**
 * Sink `webhook` ของ integration outbox (ST7-T04) — subscription ของแต่ละ endpoint (target = id) สร้างคำสั่งต่อ event
 * - ครั้งแรก + retry 8 ครั้งตามตาราง G1 (1m,5m,30m,2h,6h,12h,24h,24h) → ครบแล้วล้ม = FAILED_FINAL (delivery EXHAUSTED)
 * - 4xx (ยกเว้น 408/429) / redirect / SSRF / URL เสีย → ไม่ลองใหม่ (VALIDATION → FAILED_FINAL) — รวม 401/403 ของผู้รับ
 *   (นับเป็น event ล้มเหลวเหมือนกัน ไม่หยุด endpoint ทันที; ครบ 50 event ติดกัน → ปิดอัตโนมัติ) [DECISION spec/12 §3]
 * - endpoint ปิด/ลบ/ไม่มีในแพ็กเกจ → SKIPPED (ไม่ส่ง) · tenant ถูกระงับ → คงคำสั่งไว้ (AUTH = PENDING ลองทุก 15 นาที ไม่นับครั้ง — INT-109)
 * - at-least-once: envelope id = `evt_<domain_event>` เดิมทุกครั้ง ผู้รับกันซ้ำด้วย id
 */
@Injectable()
export class WebhookSink implements OutboxSink, OnModuleInit {
  readonly key = WEBHOOK_SINK;
  /** timeout 10 วิ — lease 1 นาทีพอ (worker ตายแล้วหยิบใหม่เร็ว) */
  readonly leaseMs = 60_000;
  readonly retry = { maxAttempts: WEBHOOK_MAX_ATTEMPTS, scheduleMin: WEBHOOK_RETRY_SCHEDULE_MIN };

  constructor(
    private readonly registry: OutboxSinkRegistry,
    private readonly engine: WebhookEngine,
    private readonly entitlements: EntitlementService,
  ) {}

  onModuleInit() {
    if (!this.registry.get(this.key)) this.registry.register(this);
  }

  async deliver(d: OutboxDelivery): Promise<{ result: Record<string, unknown> }> {
    const id = d.targetId;
    const ctx = await d.withTx(async (tx) => ({
      endpoint: id ? await tx.webhookEndpoint.findFirst({ where: { id, deletedAt: null } }) : null,
      tenant: await tx.tenant.findUnique({ where: { id: d.tenantId }, select: { status: true } }),
    }));
    if (ctx.tenant && (ctx.tenant.status === 'SUSPENDED' || ctx.tenant.status === 'CANCELLED'))
      throw new OutboxSinkError('tenant is not active — paused', 'AUTH', { code: 'tenant_paused' });
    const e = ctx.endpoint;
    if (!e || e.status !== 'ACTIVE')
      throw new OutboxSinkError('endpoint disabled or deleted', 'CAPABILITY', {
        code: 'endpoint_inactive',
        status: e?.status ?? 'DELETED',
      });
    if (!(await this.entitlements.enabled(d.tenantId, 'webhook')))
      throw new OutboxSinkError('webhook not in plan', 'CAPABILITY', { code: 'feature_off' });

    if (d.operation === VERIFICATION_OP) return this.verify(d, e);

    if (!d.event) throw new OutboxSinkError('event not found', 'VALIDATION', { code: 'no_event' });
    const r = await this.engine.attempt({
      tenantId: d.tenantId,
      endpoint: e,
      envelope: this.engine.envelopeOf(d.tenantId, d.event),
      attempt: d.attempt,
      test: false,
      outboxId: d.id,
      eventId: d.event.id,
      signal: d.signal,
      withTx: d.withTx,
    });
    const detail = {
      code: r.errorCode,
      status: r.send.status,
      deliveryId: r.deliveryId,
      ms: r.send.durationMs,
    };
    if (r.outcome === 'DELIVERED') return { result: detail };
    if (r.outcome === 'ABORTED') throw new Error('aborted'); // ไม่ได้บันทึก/ไม่นับ — lease หาย/ปิด worker
    if (d.signal.aborted) throw new Error('aborted'); // lease หาย/ปิด worker — dispatcher ไม่เขียนทับ
    const msg = r.send.status ? `endpoint responded ${r.send.status}` : (r.errorCode ?? 'failed');
    if (r.retryable)
      throw new OutboxSinkError(
        msg,
        'TRANSIENT',
        detail,
        r.nextRetryAt ? r.nextRetryAt.getTime() - Date.now() : undefined,
      );
    throw new OutboxSinkError(msg, 'VALIDATION', detail);
  }

  /** `webhook.verification`: ส่ง challenge ครั้งเดียว — ผู้รับ echo กลับ (ทั้ง body หรือ JSON `{challenge}`) → verified_at (ผลไม่บล็อก) */
  private async verify(
    d: OutboxDelivery,
    e: WebhookEndpoint,
  ): Promise<{ result: Record<string, unknown> }> {
    const challenge = String((d.payload as { challenge?: string } | null)?.challenge ?? '');
    let verified = false;
    const r = await this.engine.attempt({
      tenantId: d.tenantId,
      endpoint: e,
      envelope: this.engine.systemEnvelope(d.tenantId, VERIFICATION_OP, { challenge }),
      attempt: 1,
      test: true,
      outboxId: d.id,
      signal: d.signal,
      withTx: d.withTx,
      onDelivered: async (tx, s) => {
        verified = !!challenge && echoes(s.body, challenge);
        if (verified)
          await tx.webhookEndpoint.update({
            where: { id: e.id },
            data: { verifiedAt: new Date() },
          });
      },
    });
    if (r.outcome === 'ABORTED') throw new Error('aborted');
    return {
      result: { verified, status: r.send.status, code: r.errorCode, deliveryId: r.deliveryId },
    };
  }
}

/** ผู้รับตอบ challenge กลับมาไหม — body ตรงตัว หรือ JSON ที่มี `challenge` ตรงกัน */
export function echoes(body: string, challenge: string): boolean {
  const b = body.trim();
  if (b === challenge) return true;
  try {
    const j = JSON.parse(b) as { challenge?: unknown };
    return j?.challenge === challenge;
  } catch {
    return false;
  }
}
