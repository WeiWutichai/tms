import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { WebhookEndpoint } from '@prisma/client';
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_SCHEDULE_MIN } from '@tms/domain';
import { PrismaService } from '../../db/prisma.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { OutboxSinkRegistry } from '../integration/outbox-sink.registry';
import { OutboxSinkError, type OutboxDelivery, type OutboxSink } from '../integration/outbox.types';
import { WebhookEngine } from './webhook-engine';

export const WEBHOOK_SINK = 'webhook';
/** คำสั่งยืนยันปลายทาง (สร้างตอนเพิ่ม endpoint) — operation ของ outbox */
export const VERIFICATION_OP = 'webhook.verification';
/** คำสั่งส่งซ้ำด้วยมือ (ST7-T05 retry/redeliver) — ส่ง 1 ครั้ง ไม่ retry อัตโนมัติ (operation ของ outbox) */
export const MANUAL_OP = 'webhook.redeliver';

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
  private readonly logger = new Logger('WebhookSink');
  /** timeout 10 วิ — lease 1 นาทีพอ (worker ตายแล้วหยิบใหม่เร็ว) */
  readonly leaseMs = 60_000;
  readonly retry = { maxAttempts: WEBHOOK_MAX_ATTEMPTS, scheduleMin: WEBHOOK_RETRY_SCHEDULE_MIN };

  constructor(
    private readonly registry: OutboxSinkRegistry,
    private readonly engine: WebhookEngine,
    private readonly entitlements: EntitlementService,
    private readonly prisma: PrismaService,
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
    const manual = d.operation === MANUAL_OP;
    const attempt = await this.allocateAttempt(d, d.event.id);
    const r = await this.engine.attempt({
      tenantId: d.tenantId,
      endpoint: e,
      envelope: this.engine.envelopeOf(d.tenantId, d.event, await this.engine.modeOf(d.tenantId)),
      attempt,
      test: false,
      manual,
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
    if (r.outcome === 'DELIVERED') {
      // ส่งถึงแล้ว — ยกเลิกรอบอัตโนมัติไม่สำเร็จต้องไม่ทำให้คำสั่งนี้กลายเป็นล้ม (ผู้รับกันซ้ำด้วย id อยู่แล้ว)
      if (manual)
        await this.supersede(d, d.event.id).catch((e: unknown) =>
          this.logger.error(`supersede after manual redelivery ${d.id} failed: ${String(e)}`),
        );
      return { result: detail };
    }
    if (r.outcome === 'ABORTED') throw new Error('aborted'); // ไม่ได้บันทึก/ไม่นับ — lease หาย/ปิด worker
    if (d.signal.aborted) throw new Error('aborted'); // lease หาย/ปิด worker — dispatcher ไม่เขียนทับ
    const msg = r.send.status ? `endpoint responded ${r.send.status}` : (r.errorCode ?? 'failed');
    if (r.retryable && !manual)
      throw new OutboxSinkError(
        msg,
        'TRANSIENT',
        detail,
        r.nextRetryAt ? r.nextRetryAt.getTime() - Date.now() : undefined,
      );
    throw new OutboxSinkError(msg, 'VALIDATION', detail);
  }

  /**
   * ครั้งที่ของการส่งนี้ (X-TMS-Attempt / webhook_delivery.attempt) ไม่ซ้ำและเพิ่มขึ้นต่อคู่ (endpoint, event)
   * แม้รอบอัตโนมัติกับการส่งซ้ำด้วยมือส่งพร้อมกัน: ใต้ advisory lock คู่เดียวกับ WebhookOpsService
   * = max(ครั้งของคำสั่งนี้, ครั้งที่บันทึกแล้ว + 1, ครั้งของคำสั่งอื่นที่กำลังส่ง + 1) แล้วเขียนกลับที่คำสั่ง (คำสั่งอื่นเห็น)
   */
  private async allocateAttempt(d: OutboxDelivery, eventId: string): Promise<number> {
    const target = d.targetId ?? '';
    return this.prisma.platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${`${target}:${eventId}`}))`;
      const [row] = await tx.$queryRaw<{ n: number }[]>`
        SELECT greatest(
          ${d.attempt}::int,
          (SELECT coalesce(max(attempt), 0) + 1 FROM webhook_delivery
            WHERE tenant_id = ${d.tenantId}::uuid AND endpoint_id = ${target}::uuid AND event_id = ${eventId}::uuid),
          (SELECT coalesce(max(attempt), 0) + 1 FROM integration_outbox
            WHERE tenant_id = ${d.tenantId}::uuid AND sink = ${WEBHOOK_SINK} AND target_id = ${target}
              AND event_id = ${eventId}::uuid AND status = 'IN_FLIGHT' AND id <> ${d.id}::uuid)
        )::int AS n`;
      const n = row?.n ?? d.attempt;
      if (n !== d.attempt)
        await tx.$executeRaw`UPDATE integration_outbox SET attempt = ${n}, updated_at = now()
                              WHERE id = ${d.id}::uuid AND status = 'IN_FLIGHT'`;
      return n;
    });
  }

  /**
   * ส่งซ้ำด้วยมือสำเร็จ → คำสั่งรอบอัตโนมัติของ event เดียวกันที่ endpoint นี้ที่ยังรอ retry ไม่ต้องส่งอีก (SKIPPED)
   * เขียนด้วย role platform (role แอปแก้คิวไม่ได้ — migration 0090) · คำสั่งที่กำลังส่งอยู่ (IN_FLIGHT) ปล่อยไว้ — ผู้รับกันซ้ำด้วย id
   */
  private async supersede(d: OutboxDelivery, eventId: string): Promise<void> {
    await this.prisma.platform.$executeRaw`
      UPDATE integration_outbox
         SET status = 'SKIPPED', done_at = now(), updated_at = now(),
             last_error = jsonb_build_object('code', 'superseded_by_manual', 'by', ${d.id}::text)
       WHERE tenant_id = ${d.tenantId}::uuid AND sink = ${WEBHOOK_SINK} AND target_id = ${d.targetId}
         AND event_id = ${eventId}::uuid AND id <> ${d.id}::uuid
         AND status IN ('PENDING', 'FAILED_RETRYABLE')`;
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
      envelope: this.engine.systemEnvelope(
        d.tenantId,
        VERIFICATION_OP,
        { challenge },
        undefined,
        await this.engine.modeOf(d.tenantId),
      ),
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
