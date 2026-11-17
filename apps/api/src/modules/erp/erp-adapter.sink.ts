import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ERP_OPERATION_CAPABILITY, isErpOperation } from '@tms/domain';
import { EntitlementService } from '../entitlements/entitlement.service';
import { OutboxSinkRegistry } from '../integration/outbox-sink.registry';
import { OutboxSinkError, type OutboxDelivery, type OutboxSink } from '../integration/outbox.types';
import { ConnectorResolver } from './connector-resolver';
import { ConnectorsService, redactSecrets } from './connectors.service';
import type { CanonicalDocument, ExternalRef, PushResult } from './erp-adapter';

export const ERP_SINK = 'erp';

/**
 * ErpAdapter เสียบเป็น sink `erp` ของ integration outbox (ST7-T13; docs/01 §3.7 kind ADAPTER, §6.2–6.3) — **คิวเดียว** กับ webhook
 * คำสั่ง: target_id = connector id · operation ∈ ERP_OPERATION_CAPABILITY (PUSH_INVOICE ฯลฯ) · payload = canonical (ST7-T15)
 * - ยกเลิกการเชื่อม / ไม่มี connector → SKIPPED (CAPABILITY — INT-016 หยุดส่งทันที)
 * - PAUSED / ERROR / tenant ถูกระงับ / แพ็กเกจไม่มี `conn` / adapter ไม่ได้ติดตั้ง → คงคำสั่งไว้ (AUTH = PENDING ไม่นับครั้ง)
 * - capability ไม่ได้เปิด/ไม่รองรับ → SKIPPED (CAPABILITY — docs/01 §6.3)
 * - adapter ตอบ AUTH → connector = ERROR (หยุดทั้งตัว) แล้วคำสั่งรอ · class อื่นตาม retry policy ของ dispatcher
 * การสร้างคำสั่งหลัง finalize + ประตู syncFromDate + external_mapping = ST7-T15/T16
 */
@Injectable()
export class ErpAdapterSink implements OutboxSink, OnModuleInit {
  readonly key = ERP_SINK;

  constructor(
    private readonly registry: OutboxSinkRegistry,
    private readonly connectors: ConnectorsService,
    private readonly resolver: ConnectorResolver,
    private readonly entitlements: EntitlementService,
  ) {}

  onModuleInit() {
    if (!this.registry.get(this.key)) this.registry.register(this);
  }

  async deliver(d: OutboxDelivery): Promise<{ result: Record<string, unknown> }> {
    const id = d.targetId;
    const { connector, tenant } = await d.withTx(async (tx) => ({
      connector: id ? await tx.connector.findUnique({ where: { id } }) : null,
      tenant: await tx.tenant.findUnique({ where: { id: d.tenantId }, select: { status: true } }),
    }));
    if (!connector || connector.status === 'DISCONNECTED')
      throw new OutboxSinkError('connector disconnected', 'CAPABILITY', {
        code: 'connector_disconnected',
      });
    if (tenant && (tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED'))
      throw new OutboxSinkError('tenant is not active — paused', 'AUTH', { code: 'tenant_paused' });
    if (connector.status !== 'ACTIVE')
      throw new OutboxSinkError(`connector ${connector.status.toLowerCase()}`, 'AUTH', {
        code: 'connector_not_active',
        status: connector.status,
      });
    if (!(await this.entitlements.enabled(d.tenantId, 'conn')))
      throw new OutboxSinkError('connectors not in plan — paused', 'AUTH', { code: 'feature_off' });
    const resolved = this.resolver.describe(connector);
    const adapter = resolved.adapter;
    if (!adapter)
      throw new OutboxSinkError('adapter not installed — paused', 'AUTH', {
        code: 'adapter_unavailable',
        adapterKey: connector.adapterKey,
      });
    if (!isErpOperation(d.operation))
      throw new OutboxSinkError(`unknown operation ${d.operation}`, 'VALIDATION', {
        code: 'unknown_operation',
      });
    const cap = ERP_OPERATION_CAPABILITY[d.operation];
    if (!resolved.capabilities.includes(cap))
      throw new OutboxSinkError(`capability ${cap} not enabled`, 'CAPABILITY', {
        code: 'capability_off',
        capability: cap,
      });

    const ctx = this.connectors.contextOf(connector, {
      idempotencyKey: d.idempotencyKey,
      signal: d.signal,
    });
    const secrets = connector.credentialKeys.map((k) => ctx.config[k] ?? '');
    const payload = (d.payload ?? {}) as { document?: CanonicalDocument; ref?: ExternalRef };
    let r: PushResult;
    switch (d.operation) {
      case 'PUSH_INVOICE':
        r = await adapter.pushInvoice!(ctx, payload.document ?? (payload as CanonicalDocument));
        break;
      case 'PUSH_CREDIT_NOTE':
        r = await adapter.pushCreditNote!(ctx, payload.document ?? (payload as CanonicalDocument));
        break;
      case 'PUSH_SETTLEMENT':
        r = await adapter.pushSettlement!(ctx, payload.document ?? (payload as CanonicalDocument));
        break;
      case 'REPLACE_DOCUMENT':
        if (!payload.ref || !payload.document)
          throw new OutboxSinkError('ref and document required', 'VALIDATION', {
            code: 'invalid_payload',
          });
        r = await adapter.replaceDocument!(ctx, payload.ref, payload.document);
        break;
      case 'FETCH_DOCUMENT': {
        if (!payload.ref)
          throw new OutboxSinkError('ref required', 'VALIDATION', { code: 'invalid_payload' });
        const doc = await adapter.fetchDocument!(ctx, payload.ref);
        return { result: { found: !!doc, document: doc } };
      }
      case 'FETCH_PAYMENT_STATUS': {
        if (!payload.ref)
          throw new OutboxSinkError('ref required', 'VALIDATION', { code: 'invalid_payload' });
        const st = await adapter.fetchPaymentStatus!(ctx, payload.ref);
        return { result: { found: !!st, paymentStatus: st } };
      }
    }
    if (r.ok)
      return {
        result: {
          externalId: r.externalId,
          externalDocNo: r.externalDocNo ?? null,
          externalVersion: r.externalVersion ?? null,
        },
      };
    const problem = {
      code: redactSecrets(String(r.problem?.code ?? 'error'), secrets).slice(0, 60),
      message: redactSecrets(String(r.problem?.message ?? ''), secrets).slice(0, 500),
    };
    if (r.errorClass === 'AUTH')
      await d.withTx((tx) => this.connectors.markError(tx, connector, problem));
    throw new OutboxSinkError(problem.message || problem.code, r.errorClass, {
      ...problem,
      ...(Array.isArray(r.problem?.fields)
        ? {
            fields: r.problem.fields.slice(0, 50).map((f) => ({
              field: String(f.field).slice(0, 120),
              code: String(f.code).slice(0, 60),
              message: redactSecrets(String(f.message), secrets).slice(0, 300),
            })),
          }
        : {}),
    });
  }
}
