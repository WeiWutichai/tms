import type { NestExpressApplication } from '@nestjs/platform-express';
import { type MockAccountSystem, startMockAccountSystem } from '@tms/mock-accountsystem';
import { SYSTEM_ROLES } from '@tms/domain';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { AccountSystemAdapter } from '../src/erp-adapters/accountsystem/accountsystem.adapter';
import type { DemoAdapter } from '../src/erp-adapters/demo/demo.adapter';
import { JobQueue } from '../src/jobs/job-queue.service';
import { withSyncHash } from '../src/modules/erp/canonical';
import type { CanonicalDocument } from '../src/modules/erp/erp-adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import {
  type IssuedInvoice,
  type PipelineHandles,
  runPipelineConformance,
  runReadbackConformance,
} from './connector-kit/pipeline';
import { sampleInvoice } from './connector-kit/samples';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * P1-ST5-T01 ชุด conformance ระดับ pipeline (ฐานข้อมูล + outbox + sink) กับ adapter ตัวจริง — ดู `connector-kit/pipeline.ts`
 * KRS = ข้อยกเว้นที่อธิบายได้: การส่งใบเข้า KRS ต้องมีผังรหัส (erp_master_code) + รหัสลูกค้า PP ก่อน (ประตู ST8-T06) ซึ่ง
 * `krs-push-invoice.test.ts` / `krs-a5-errors.test.ts` ทดสอบทางเดียวกันครบแล้ว (mapping, A.5 ทุก class, AUTH หยุด connector)
 */
describe('Connector pipeline conformance (P1-ST5-T01)', { timeout: 300_000 }, () => {
  let app: NestExpressApplication;
  const plat = platform();
  let tenantId: string;
  let otherTenantId: string;
  let token: string;
  let otherToken: string;
  let customerId: string;
  let mock: MockAccountSystem;
  const prevPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  const AS_KEY = 'inn_tms_pipeline_7a1d';
  const AS_SECRET = 'whsec_pipeline_4c2e';
  let accounting: string;
  let companyId: string;
  let branchId: string;
  let serviceItemId: string;
  const CUST_TAX = '0105555000001';
  let seq = 100;
  /**
   * ใบตัวอย่างของชุด pipeline — ลูกค้าจริงของ tenant · บรรทัดไม่ผูกค่าบริการ (ประตู mapping ค่าบริการ ST7-T18 `erp_mapping_incomplete`
   * ทดสอบแยกใน erp-master-codes / erp-accountsystem-flow — ชุดนี้ตรวจทางเดินของ adapter)
   */
  const pipelineInvoice = (taxId: string | null) => {
    const base = sampleInvoice(++seq);
    return withSyncHash({
      ...base,
      id: randomUUID(),
      customer: { ...base.customer, id: customerId, ...(taxId ? { taxId } : {}) },
      lines: base.lines.map((l) => ({ ...l, serviceItem: null })),
    } as CanonicalDocument);
  };

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    await truncateAll();
    app = await bootApp();
    app.get(ErpAdapterRegistry).replace(new AccountSystemAdapter({ allowPrivate: true }));
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ตรวจ connector' })).id;
    otherTenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น' })).id;
    await plat.tenant.updateMany({ data: { planCode: 'ent' } });
    token = await tokenFor(tenantId);
    otherToken = await tokenFor(otherTenantId);
    customerId = (
      await plat.customer.create({
        data: {
          tenantId,
          code: 'C-0001',
          legalName: 'บริษัท ลูกค้า จำกัด',
          taxId: validTaxId(5101),
          branchCode: '00000',
        },
      })
    ).id;
    companyId = (
      await plat.company.create({
        data: { tenantId, legalName: 'บริษัท ผู้ออกบิล จำกัด', taxId: validTaxId(5102) },
      })
    ).id;
    branchId = (
      await plat.branch.create({
        data: {
          tenantId,
          companyId,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          isDefaultIssuer: true,
          address: { line1: '1', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
        },
      })
    ).id;
    serviceItemId = (
      await plat.serviceItem.findFirstOrThrow({
        where: { tenantId, vatType: 'EXEMPT_TRANSPORT', status: 'ACTIVE', deletedAt: null },
      })
    ).id;
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    mock = await startMockAccountSystem({
      apiKey: AS_KEY,
      webhookSecret: AS_SECRET,
      contacts: [{ code: 'C-0001', tax_id: CUST_TAX, branch_code: '00000', kind: 'customer' }],
    });
  });
  beforeEach(async () => {
    // คำสั่งที่ค้างจากชุดก่อนไม่ให้ถูกหยิบ
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
  });
  afterAll(async () => {
    if (prevPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = prevPrivate;
    await mock?.stop();
    await app.close();
    await plat.$disconnect();
  });
  const env = () => ({ app, tenantId, token, otherTenantId, otherToken, customerId });

  /** P1-ST5-T01b ใบแจ้งหนี้จริง 1 บรรทัด (ผู้เตรียม ≠ ผู้ออก) → finalize ผ่าน API (คำสั่งส่งเข้าคิวของ connector ที่ใช้อยู่) */
  const issueInvoice = async (amount: string): Promise<IssuedInvoice> => {
    const n = ++seq;
    const inv = await plat.invoice.create({
      data: {
        tenantId,
        customerId,
        issuingCompanyId: companyId,
        issuingBranchId: branchId,
        status: 'DRAFT',
        creditTermDays: 30,
        createdBy: 'u-prep',
        lines: {
          create: {
            tenantId,
            lineNo: 1,
            serviceItemId,
            description: `ค่าขนส่ง เที่ยวที่ ${n}`,
            quantity: '1',
            unitLabel: 'เที่ยว',
            unitPrice: amount,
            amount,
            vatType: 'EXEMPT_TRANSPORT',
            vatAmount: '0',
            whtRate: '1.00',
            isUserAdded: true,
          },
        },
      },
    });
    const id = encodeId('invoice', inv.id);
    const r = await api(app, accounting)
      .post(`/v1/invoices/${id}/finalize`)
      .set('If-Match', `"${inv.version}"`)
      .send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { id, uuid: inv.id, invoiceNo: r.body.invoiceNo as string };
  };
  const drainJobs = async () => {
    const queue = app.get(JobQueue);
    await plat.$executeRaw`UPDATE job SET run_at = now() - interval '1 second' WHERE status = 'PENDING'`;
    for (let i = 0; i < 30 && (await queue.runOnce()); i++);
  };
  const readbackEnv = () => ({
    app,
    tenantId,
    token,
    otherTenantId,
    otherToken,
    issueInvoice,
    drainJobs,
  });
  /** จับคู่รหัสสินค้า (ST7-T18) ของ connector ก่อนส่งใบจริง */
  const mapItem = async (h: PipelineHandles) => {
    await plat.erpCodeMapping.create({
      data: {
        tenantId,
        connectorId: tryDecodeId('connector', h.connectorId)!,
        serviceItemId,
        itemCode: 'FREIGHT',
      },
    });
  };

  it('demo (DemoProvider): mapping · แยก tenant · VALIDATION → คิวล้มเหลว · AUTH → connector ERROR', async () => {
    (app.get(ErpAdapterRegistry).get('demo') as DemoAdapter).reset();
    const settings = (conId: string, failMode: string) =>
      api(app, token).patch(`/v1/connectors/${conId}`).send({ settings: { failMode } }).expect(200);
    await runPipelineConformance(
      {
        adapterKey: 'demo',
        create: () => ({
          taxDocumentOwner: 'TMS',
          credentials: { apiKey: 'demo-pipeline-key' },
          capabilitiesEnabled: ['pushInvoice', 'fetchDocument', 'listDocuments'],
        }),
        invoice: () => pipelineInvoice(null),
        failNext: async (cls, h) => {
          await settings(h.connectorId, cls);
        },
        reset: async (h) => {
          await settings(h.connectorId, 'none');
        },
      },
      env(),
    );
  });

  it('accountsystem (AccountSystemAdapter): R-01 เจ้าของเอกสารภาษี ERP ตายตัว · mapping · แยก tenant · VALIDATION · AUTH', async () => {
    mock.reset();
    await runPipelineConformance(
      {
        adapterKey: 'accountsystem',
        fixedTaxDocumentOwner: 'ERP',
        create: () => ({
          settings: { baseUrl: mock.url },
          credentials: { apiKey: AS_KEY },
          capabilitiesEnabled: ['pushInvoice', 'pushSettlement'],
        }),
        invoice: () => pipelineInvoice(CUST_TAX),
        failNext: async (cls) => {
          mock.failNext(cls === 'AUTH' ? 401 : 422);
        },
      },
      env(),
    );
  });

  it('P1-ST5-T01b demo (pull): fetch → reconcile (ACCEPTED / MISMATCH) → payment pull (PAID ไม่ซ้ำ) · แยก tenant', async () => {
    const demo = app.get(ErpAdapterRegistry).get('demo') as DemoAdapter;
    demo.reset();
    let spy: { mockRestore: () => void } | null = null;
    await runReadbackConformance(
      {
        adapterKey: 'demo',
        channel: 'pull',
        create: () => ({
          taxDocumentOwner: 'TMS',
          credentials: { apiKey: 'demo-readback-key' },
          capabilitiesEnabled: ['pushInvoice', 'fetchDocument'],
        }),
        prepare: async (h) => {
          await mapItem(h);
          // ST7-T21 ดึงสถานะรับชำระ = opt-in ต้องมีเหตุผล
          const on = await api(app, token)
            .patch(`/v1/connectors/${h.connectorId}`)
            .send({
              capabilitiesEnabled: ['pushInvoice', 'fetchDocument', 'fetchPaymentStatus'],
              reason: 'ชุด conformance เปิดดึงสถานะรับชำระ',
            });
          expect(on.status, JSON.stringify(on.body)).toBe(200);
        },
        erpConfirms: async (_h, inv, total) => {
          spy?.mockRestore();
          spy = null;
          if (!total) return;
          // ERP จำลอง "ถือยอดอื่น" ของใบนี้ (เหมือนบัญชีแก้ใบในโปรแกรมบัญชี)
          const orig = demo.fetchDocument.bind(demo);
          spy = vi.spyOn(demo, 'fetchDocument').mockImplementation(async (ctx, ref) => {
            const d = (await orig(ctx, ref)) as Record<string, any> | null;
            if (!d || d.number !== inv.invoiceNo) return d as never;
            return {
              ...d,
              totals: { ...d.totals, subtotal: total, total },
              lines: d.lines.map((l: Record<string, unknown>, i: number) =>
                i === 0 ? { ...l, amount: total, unitPrice: total } : l,
              ),
            } as never;
          });
        },
        erpPaid: async (h, inv, p) => {
          demo.setPaymentStatus(tenantId, tryDecodeId('connector', h.connectorId)!, inv.invoiceNo, {
            status: 'PAID',
            paidAmount: p.settled,
            whtAmount: p.wht,
            paidAt: new Date(Date.now() - 60_000).toISOString(),
          });
        },
        reset: async () => {
          spy?.mockRestore();
          spy = null;
        },
      },
      readbackEnv(),
    );
  });

  it('P1-ST5-T01b accountsystem (inbound webhook): fetch (document.posted) → reconcile (ยอดไม่ตรง = คิวตรวจ) → payment (payment.received → PAID ไม่ซ้ำ) · แยก tenant', async () => {
    mock.reset();
    let inbound = '';
    const send = (w: { headers: Record<string, string>; body: string }) =>
      request(app.getHttpServer()).post(inbound).set(w.headers).send(w.body).expect(200);
    const docOf = (inv: IssuedInvoice) => {
      const [d] = mock.byRef(inv.invoiceNo, 'tms.invoice');
      expect(d, `IV ร่างของ ${inv.invoiceNo}`).toBeDefined();
      return d!;
    };
    let lastRv: ReturnType<MockAccountSystem['receive']> | null = null;
    await runReadbackConformance(
      {
        adapterKey: 'accountsystem',
        channel: 'inbound',
        create: () => ({
          settings: { baseUrl: mock.url },
          credentials: { apiKey: AS_KEY, webhookSecret: AS_SECRET },
          capabilitiesEnabled: ['pushInvoice', 'pushSettlement'],
        }),
        prepare: async (h) => {
          await mapItem(h);
          const t = await api(app, token)
            .post(`/v1/connectors/${h.connectorId}/inbound-token/rotate`)
            .send({ reason: 'ออก token รับ webhook จากระบบบัญชี (conformance)' });
          expect(t.status, JSON.stringify(t.body)).toBe(200);
          inbound = new URL(t.body.url).pathname;
        },
        erpConfirms: async (_h, inv, total) => {
          const ok = mock.post(docOf(inv).id);
          await send(
            total ? mock.webhook('document.posted', { ...ok.event.data, grand_total: total }) : ok,
          );
        },
        erpPaid: async (_h, inv, p) => {
          if (p.seq > 1 && lastRv) {
            // ระบบบัญชีส่ง event ใหม่ของใบรับเงินเดิม
            await send(mock.webhook('payment.received', lastRv.event.data));
            return;
          }
          lastRv = mock.receive([{ documentId: docOf(inv).id, applied: p.received, wht: p.wht }]);
          await send(lastRv);
        },
      },
      readbackEnv(),
    );
  });
});
