import type { NestExpressApplication } from '@nestjs/platform-express';
import { type MockAccountSystem, startMockAccountSystem } from '@tms/mock-accountsystem';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { AccountSystemAdapter } from '../src/erp-adapters/accountsystem/accountsystem.adapter';
import type { DemoAdapter } from '../src/erp-adapters/demo/demo.adapter';
import { withSyncHash } from '../src/modules/erp/canonical';
import type { CanonicalDocument } from '../src/modules/erp/erp-adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { runPipelineConformance } from './connector-kit/pipeline';
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
  const CUST_TAX = '0105555000001';
  let seq = 100;

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
        },
      })
    ).id;
    mock = await startMockAccountSystem({
      apiKey: AS_KEY,
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
        invoice: () =>
          withSyncHash({
            ...sampleInvoice(++seq),
            id: randomUUID(),
            customer: { ...sampleInvoice().customer, id: customerId },
          } as CanonicalDocument),
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
        invoice: () =>
          withSyncHash({
            ...sampleInvoice(++seq),
            id: randomUUID(),
            customer: { ...sampleInvoice().customer, id: customerId, taxId: CUST_TAX },
          } as CanonicalDocument),
        failNext: async (cls) => {
          mock.failNext(cls === 'AUTH' ? 401 : 422);
        },
      },
      env(),
    );
  });
});
