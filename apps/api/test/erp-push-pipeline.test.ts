import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { DemoAdapter } from '../src/erp-adapters/demo/demo.adapter';
import { changedSyncParts, syncParts, withSyncHash } from '../src/modules/erp/canonical';
import type { CanonicalDocument } from '../src/modules/erp/erp-adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { ERP_SINK } from '../src/modules/erp/erp-adapter.sink';
import { ErpSyncService } from '../src/modules/erp/erp-sync.service';
import { scrubBody, scrubUrl } from '../src/modules/erp/erp-sync-log';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../src/modules/integration/outbox.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import {
  api,
  bootApp,
  issuedTestFields,
  platform,
  tokenFor,
  truncateAll,
  validTaxId,
} from './helpers';

/**
 * ST7-T16 Push pipeline (docs/01 §6.1–6.4; docs/04 G3) ผ่าน outbox → DemoProvider (ทางเดียวกับ worker)
 * เกณฑ์ตรวจรับ: ฉีด error ทีละ class → สถานะ outbox/mapping ตรงตาราง 01§6.3 · เอกสารก่อน `syncFromDate` ไม่ถูก push ·
 * (ST7-T17) เอกสารที่ส่งแล้วถูกเปลี่ยน → `fieldChangePolicy` (documentInErp จาก external_mapping): AUTO_SYNC / REGENERATE / BLOCKED
 * + sync log 1 แถวต่อ 1 HTTP call (ตัด secret)
 */
describe('Push pipeline (ST7-T16)', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  let demo: DemoAdapter;
  let tenantId: string;
  let otherTenantId: string;
  let token: string;
  let other: string;
  let customerId: string;
  let companyId: string;
  let branchId: string;
  let seq = 0;
  const API_KEY = 'demo-secret-key-7716';
  const ALL_CAPS = [
    'pushInvoice',
    'pushSettlement',
    'fetchDocument',
    'listDocuments',
    'replaceDocument',
  ];

  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };
  const cmd = (id: string) => plat.integrationOutbox.findUniqueOrThrow({ where: { id } });
  const mapping = (localId: string) =>
    plat.externalMapping.findFirst({ where: { tenantId, entityType: 'INVOICE', localId } });

  async function connector(o: { capabilities?: string[]; settings?: Record<string, string> } = {}) {
    const r = await api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'demo',
        credentials: { apiKey: API_KEY },
        capabilitiesEnabled: o.capabilities ?? ALL_CAPS,
        ...(o.settings ? { settings: o.settings } : {}),
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await api(app, token).post(`/v1/connectors/${r.body.id}/resume`).send({}).expect(200);
    return { id: r.body.id as string, uuid: tryDecodeId('connector', r.body.id)! };
  }
  /** ค่าตั้งที่ไม่ลับ (แทนทั้งชุด) */
  const settings = (conId: string, s: Record<string, string>) =>
    api(app, token).patch(`/v1/connectors/${conId}`).send({ settings: s }).expect(200);

  async function enqueue(
    connectorId: string,
    document: CanonicalDocument,
    extra: Record<string, unknown> = {},
  ) {
    const { id } = await db.withTenant(tenantId, (tx) =>
      app.get(OutboxService).enqueueCommand(tx, {
        tenantId,
        kind: 'ADAPTER',
        sink: ERP_SINK,
        targetId: connectorId,
        operation: 'PUSH_INVOICE',
        entityType: 'invoice',
        localId: document.id,
        customerId,
        payload: { document, ...extra },
      }),
    );
    return id;
  }

  /** canonical ใบแจ้งหนี้ (รูปเดียวกับ ErpSyncService) */
  const invoiceDoc = (over: Record<string, unknown> = {}, id: string = randomUUID()) =>
    withSyncHash({
      kind: 'invoice',
      id,
      number: `INV-00000-2611-${String(++seq).padStart(4, '0')}`,
      issueDate: '2026-11-20',
      dueDate: '2026-12-20',
      issuer: { companyId, branchId, branchCode: '00000' },
      customer: {
        id: customerId,
        code: 'C-T16',
        legalName: 'บริษัท ลูกค้า จำกัด',
        taxId: null,
        branchCode: '00000',
        externalId: null,
      },
      customerPoNo: null,
      totals: {
        subtotalVatable: '0.00',
        subtotalExempt: '1000.00',
        subtotalZeroRated: '0.00',
        vatAmount: '0.00',
        total: '1000.00',
        whtExpected: '10.00',
      },
      taxEstimated: true,
      lines: [
        {
          lineNo: 1,
          deliveryOrder: null,
          description: 'ค่าขนส่ง',
          quantity: '1',
          unitLabel: 'เที่ยว',
          unitPrice: '1000',
          discount: '0.00',
          amount: '1000.00',
          vatType: 'EXEMPT_TRANSPORT',
          vatAmount: '0.00',
          whtRate: '1.00',
        },
      ],
      ...over,
    } as CanonicalDocument);
  /** เนื้อหาใหม่ของใบเดิม (id + เลขเดิม) */
  const changed = (doc: CanonicalDocument, over: Record<string, unknown>) =>
    invoiceDoc({ number: doc.number, ...over }, doc.id);

  /** แถว invoice จริง (สถานะใบใช้ตัดสิน "แก้ได้จนรับชำระ") — id เดียวกับ canonical */
  async function invoiceRow(doc: CanonicalDocument, status: 'ISSUED' | 'PAID' = 'ISSUED') {
    await plat.invoice.create({
      data: {
        id: doc.id,
        tenantId,
        customerId,
        issuingCompanyId: companyId,
        issuingBranchId: branchId,
        status: 'ISSUED',
        totalAmount: '1000.00',
        subtotalExempt: '1000.00',
        ...issuedTestFields(doc.number),
      },
    });
    if (status === 'PAID')
      await plat.$executeRaw`UPDATE invoice SET status = 'PAID' WHERE id = ${doc.id}::uuid`;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    demo = app.get(ErpAdapterRegistry).get('demo') as DemoAdapter;
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ท่อส่ง ERP' })).id;
    otherTenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น' })).id;
    await plat.tenant.updateMany({ data: { planCode: 'ent' } });
    token = await tokenFor(tenantId);
    other = await tokenFor(otherTenantId);
    // ST8-T13 ระบบบัญชีจำลองไม่บอกสถานะลงบัญชี (ไม่มี postedStatus) → กฎอายุ N วันบังคับอนุมัติก่อนแทนที่ (ค่าเริ่ม N = 0) ·
    // ชุดนี้ทดสอบเรื่องอื่นของการแทนที่ → ตั้ง N กว้าง (ประตูอนุมัติทดสอบใน krs-replace.test)
    await plat.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: 'billing.erpReplaceApprovalDays' } },
      create: { tenantId, key: 'billing.erpReplaceApprovalDays', value: 3650 },
      update: { value: 3650 },
    });
    customerId = (
      await plat.customer.create({
        data: {
          tenantId,
          code: 'C-T16',
          legalName: 'บริษัท ลูกค้า จำกัด',
          taxId: validTaxId(7716),
        },
      })
    ).id;
    const co = await plat.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออก จำกัด', taxId: validTaxId(7717) },
    });
    companyId = co.id;
    branchId = (
      await plat.branch.create({
        data: {
          tenantId,
          companyId,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          isDefaultIssuer: true,
          address: { line1: '1', district: 'x', province: 'x', postcode: '10000' },
        },
      })
    ).id;
  });
  beforeEach(async () => {
    demo.reset();
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: ฉีด error ทีละ class ผ่าน DemoProvider → สถานะ outbox / mapping ตรงตาราง docs/01 §6.3', async () => {
    const con = await connector();
    const run = async (failMode: string, doc = invoiceDoc(), failTimes?: string) => {
      await settings(con.id, { failMode, ...(failTimes ? { failTimes } : {}) });
      const id = await enqueue(con.uuid, doc);
      await drain();
      return { id, doc, c: await cmd(id), m: await mapping(doc.id) };
    };

    // TRANSIENT → FAILED_RETRYABLE (retry ตามตาราง) · ไม่มี mapping
    const t = await run('TRANSIENT');
    expect(t.c).toMatchObject({ status: 'FAILED_RETRYABLE', errorClass: 'TRANSIENT' });
    expect(t.m).toBeNull();
    await plat.integrationOutbox.update({ where: { id: t.id }, data: { status: 'SKIPPED' } });

    // VALIDATION → FAILED_FINAL · mapping FAILED (เอกสารยังไม่อยู่ใน ERP)
    const v = await run('VALIDATION');
    expect(v.c).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    expect(v.m).toMatchObject({ status: 'FAILED', externalId: null, localNumber: v.doc.number });
    expect(v.m!.lastError).toMatchObject({ code: 'customer_unmapped', errorClass: 'VALIDATION' });

    // PERIOD_CLOSED → FAILED_FINAL (ไม่ retry) · mapping ไม่เปลี่ยน
    const pc = await run('PERIOD_CLOSED');
    expect(pc.c).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'PERIOD_CLOSED' });
    expect(pc.m).toBeNull();

    // CAPABILITY → SKIPPED
    const cap = await run('CAPABILITY');
    expect(cap.c).toMatchObject({ status: 'SKIPPED', errorClass: 'CAPABILITY' });
    expect(cap.m).toBeNull();

    // DUPLICATE → ERP มีเลขนี้แล้ว: sink หาเอกสาร (list + fetch) เนื้อหาตรง → DONE + mapping SYNCED
    const dup = await run('DUPLICATE');
    expect(dup.c).toMatchObject({
      status: 'DONE',
      result: { recoveredAfter: 'DUPLICATE', applied: true },
    });
    expect(dup.m).toMatchObject({ status: 'SYNCED' });
    expect(dup.m!.externalId).toMatch(/^DEMO-INV-/);

    // AMBIGUOUS → FAILED_RETRYABLE (ไม่ส่งซ้ำทันที) → รอบถัดไปหาเจอ = DONE ไม่ส่งซ้ำ (ERP มีใบเดียว)
    const amb = await run('AMBIGUOUS', invoiceDoc(), '1');
    expect(amb.c).toMatchObject({ status: 'FAILED_RETRYABLE', errorClass: 'AMBIGUOUS' });
    expect(amb.m).toBeNull();
    const posts = () => plat.erpSyncLog.count({ where: { outboxId: amb.id, method: 'POST' } });
    expect(await posts()).toBe(1);
    await drain();
    expect(await cmd(amb.id)).toMatchObject({
      status: 'DONE',
      result: { recoveredAfter: 'AMBIGUOUS', applied: true },
    });
    expect(await posts()).toBe(1); // ไม่ POST ซ้ำ — ใช้ GET ค้นแทน
    expect(await mapping(amb.doc.id)).toMatchObject({ status: 'SYNCED' });
    expect(
      demo.documents(tenantId, con.uuid).filter((d) => d.number === amb.doc.number),
    ).toHaveLength(1);

    // NOT_FOUND (ตอนแทนที่เอกสารที่ mapping บอกว่าอยู่ใน ERP) → FAILED_FINAL · mapping MISMATCH + reconcile REMOTE_MISSING
    const base = await run('none');
    expect(base.c.status).toBe('DONE');
    const nf = await run('NOT_FOUND', changed(base.doc, { dueDate: '2026-12-31' }));
    expect(nf.c).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'NOT_FOUND' });
    expect(nf.m).toMatchObject({ status: 'MISMATCH', externalId: base.m!.externalId });
    expect(nf.m!.lastError).toMatchObject({ code: 'remote_missing' });
    const rec = await plat.reconcileResult.findFirst({
      where: { tenantId, localId: base.doc.id, result: 'REMOTE_MISSING' },
    });
    expect(rec).toMatchObject({ severity: 'MONEY', resolvedAt: null, source: 'AFTER_PUSH' });
    const recs = (
      await api(app, token).get(`/v1/reconcile-results?connectorId=${con.id}`).expect(200)
    ).body.data;
    expect(recs.some((r: { result: string }) => r.result === 'REMOTE_MISSING')).toBe(true);

    // AUTH → คำสั่งคง PENDING (ไม่นับครั้ง) · connector ERROR ทั้งตัว
    const a = await run('AUTH');
    expect(a.c).toMatchObject({ status: 'PENDING', errorClass: 'AUTH' });
    expect(a.m).toBeNull();
    expect((await plat.connector.findUniqueOrThrow({ where: { id: con.uuid } })).status).toBe(
      'ERROR',
    );
  });

  it('DUPLICATE ที่หาเอกสารฝั่ง ERP ไม่ได้ (ไม่มี fetch/list) → DONE ตาม docs + duplicate_unresolved (ต้องกรอกเลขเอง) · mapping MISMATCH', async () => {
    const con = await connector({
      capabilities: ['pushInvoice'],
      settings: { failMode: 'DUPLICATE' },
    });
    const doc = invoiceDoc();
    const id = await enqueue(con.uuid, doc);
    await drain();
    const c = await cmd(id);
    expect(c).toMatchObject({ status: 'DONE', errorClass: 'DUPLICATE' });
    expect(c.lastError).toMatchObject({
      code: 'duplicate_unresolved',
      manualExternalIdRequired: true,
    });
    expect(await mapping(doc.id)).toMatchObject({ status: 'MISMATCH', externalId: null });
    // แจ้งฝ่ายบัญชีผ่าน onSettled (FAILED_FINAL ของคำสั่งส่งเอกสาร — ทางเดียวกับ D68-57: test ใน d68-connector-queue)
  });

  it('เกณฑ์ตรวจรับ: เอกสารก่อน syncFromDate ไม่ถูก push — ไม่สร้างคำสั่ง (docs/01 §6.4) · คำสั่งที่ค้างก่อนเลื่อนวัน = SKIPPED ตอนส่ง', async () => {
    const con = await connector();
    await api(app, token)
      .patch(`/v1/connectors/${con.id}`)
      .send({ syncFromDate: '2026-11-21' })
      .expect(200);
    // ตอนสร้างคำสั่ง (ErpSyncService หลัง finalize): ใบลงวันที่ 20 พ.ย. < 21 พ.ย. → ไม่มีคำสั่งใน outbox เลย
    const old = invoiceDoc({ issueDate: '2026-11-20' });
    await invoiceRow(old);
    expect(
      await db.withTenant(tenantId, (tx) => app.get(ErpSyncService).invoiceFinalized(tx, old.id)),
    ).toEqual([]);
    expect(
      await plat.integrationOutbox.count({ where: { tenantId, localId: old.id, sink: ERP_SINK } }),
    ).toBe(0);
    // ส่งใหม่ก็ไม่สร้างคำสั่ง (ไม่เคยมีคำสั่งของใบนี้)
    expect(
      await db.withTenant(tenantId, (tx) =>
        app.get(ErpSyncService).resend(tx, 'invoice', old.id, con.uuid),
      ),
    ).toBeNull();
    await drain();
    expect(demo.documents(tenantId, con.uuid)).toHaveLength(0);

    // ตอนส่ง: คำสั่งที่ค้างอยู่ก่อนผู้ดูแลเลื่อนวันเริ่มซิงก์ → SKIPPED ไม่เรียก ERP · ไม่แจ้งบัญชี
    await api(app, token)
      .patch(`/v1/connectors/${con.id}`)
      .send({ syncFromDate: null })
      .expect(200);
    const pending = invoiceDoc({ issueDate: '2026-11-19' });
    const id = await enqueue(con.uuid, pending);
    await api(app, token)
      .patch(`/v1/connectors/${con.id}`)
      .send({ syncFromDate: '2026-11-21' })
      .expect(200);
    await drain();
    expect(await cmd(id)).toMatchObject({ status: 'SKIPPED', errorClass: 'CAPABILITY' });
    expect((await cmd(id)).lastError).toMatchObject({ code: 'before_sync_from_date' });
    expect(await plat.erpSyncLog.count({ where: { outboxId: id } })).toBe(0);

    // เอกสารตั้งแต่วันเริ่มซิงก์ = ส่งตามปกติ
    const fresh = invoiceDoc({ issueDate: '2026-11-21' });
    const ok = await enqueue(con.uuid, fresh);
    await drain();
    expect((await cmd(ok)).status).toBe('DONE');
  });

  it('(ST7-T17) เอกสารที่ส่งแล้วเปลี่ยน → fieldChangePolicy: ราคา/วันที่ = AUTO_SYNC แทนที่ทั้งใบ (replaceDocument) · ลูกค้า = REGENERATE · รับชำระแล้ว = BLOCKED', async () => {
    const con = await connector();
    const doc = invoiceDoc();
    await invoiceRow(doc);
    await enqueue(con.uuid, doc);
    await drain();
    const m1 = (await mapping(doc.id))!;
    expect(m1).toMatchObject({ status: 'SYNCED' });
    expect(m1.lastSyncedParts).toMatchObject({ PRICE: expect.stringMatching(/^[0-9a-f]{64}$/) });

    // ราคาเปลี่ยน (PRICE = AUTO_SYNC) → REPLACE ใบเดิมใน ERP (ไม่สร้างใบที่สอง) · mapping hash ใหม่ · เลขฝั่ง ERP เดิม
    const price = changed(doc, {
      totals: { ...(doc.totals as object), whtExpected: '30.00' },
    });
    const r1 = await enqueue(con.uuid, price);
    await drain();
    expect(await cmd(r1)).toMatchObject({ status: 'DONE', result: { applied: true } });
    const held = demo.documents(tenantId, con.uuid).filter((d) => d.number === doc.number);
    expect(held).toHaveLength(1);
    expect(held[0]!.version).toBe(2);
    expect((held[0]!.document.totals as { whtExpected: string }).whtExpected).toBe('30.00');
    const m2 = (await mapping(doc.id))!;
    expect(m2).toMatchObject({ status: 'SYNCED', externalId: m1.externalId });
    expect(m2.lastSyncedHash).not.toBe(m1.lastSyncedHash);
    expect(await plat.erpSyncLog.findFirst({ where: { outboxId: r1 } })).toMatchObject({
      method: 'PUT',
      statusCode: 200,
    });

    // ลูกค้าเปลี่ยน (CUSTOMER = REGENERATE เสมอ) → SKIPPED regenerate_required ไม่เรียก ERP · แจ้งบัญชี (audit command_skipped)
    const cust = changed(price, {
      totals: price.totals,
      customer: { ...(doc.customer as object), legalName: 'บริษัท ลูกค้าใหม่ จำกัด' },
    });
    const r2 = await enqueue(con.uuid, cust);
    await drain();
    expect(await cmd(r2)).toMatchObject({ status: 'SKIPPED', errorClass: 'CAPABILITY' });
    expect((await cmd(r2)).lastError).toMatchObject({
      code: 'regenerate_required',
      changed: ['CUSTOMER'],
    });
    expect(await plat.erpSyncLog.count({ where: { outboxId: r2 } })).toBe(0);
    expect(
      await plat.auditLog.count({
        where: { tenantId, action: 'connector.command_skipped', reason: 'regenerate_required' },
      }),
    ).toBe(1);

    // ERP แจ้งว่าลงบัญชีแล้ว (POSTED) → แทนที่ต้องอนุมัติ → SKIPPED replace_requires_approval
    await plat.externalMapping.update({ where: { id: m2.id }, data: { externalStatus: 'POSTED' } });
    const dates = changed(price, { totals: price.totals, dueDate: '2027-01-05' });
    const r3 = await enqueue(con.uuid, dates);
    await drain();
    expect((await cmd(r3)).lastError).toMatchObject({
      code: 'replace_requires_approval',
      changed: ['DATES'],
    });
    // ST8-T12 คำสั่งส่งทับที่อนุมัติแล้วจากหน้า MISMATCH (`payload.approval` รูปเดียวกับ ST8-T13 + reconcileResultId) ผ่านประตูนี้ → แทนที่จริง
    const r3a = await enqueue(con.uuid, dates, {
      requestedBy: ['u-acc'],
      approval: {
        approvedBy: 'u-appr',
        approvedAt: new Date().toISOString(),
        reason: 'ตรวจแล้ว อนุมัติส่งทับ',
        reconcileResultId: 'rec_x',
      },
    });
    await drain();
    expect(await cmd(r3a)).toMatchObject({ status: 'DONE', result: { applied: true } });
    expect(demo.documents(tenantId, con.uuid)[0]!.version).toBe(3);
    await plat.externalMapping.update({ where: { id: m2.id }, data: { externalStatus: 'DRAFT' } });

    // รับชำระแล้ว → BLOCKED paid_locked (กฎ "แก้ได้จนรับชำระ")
    await plat.$executeRaw`UPDATE invoice SET status = 'PAID' WHERE id = ${doc.id}::uuid`;
    const late = changed(price, { totals: price.totals, dueDate: '2027-01-06' });
    const r4 = await enqueue(con.uuid, late);
    await drain();
    expect((await cmd(r4)).lastError).toMatchObject({ code: 'paid_locked' });
    expect(demo.documents(tenantId, con.uuid)[0]!.version).toBe(3);
  });

  it('เปลี่ยนแบบ AUTO_SYNC แต่ระบบบัญชีไม่มี/ไม่เปิด replaceDocument → SKIPPED replace_not_supported (แจ้งบัญชีแก้เอง — TMS ไม่ออกใบลด/เพิ่มหนี้ D-54)', async () => {
    const con = await connector({
      capabilities: ['pushInvoice', 'fetchDocument', 'listDocuments'],
    });
    const doc = invoiceDoc();
    await enqueue(con.uuid, doc);
    await drain();
    const id = await enqueue(con.uuid, changed(doc, { dueDate: '2026-12-29' }));
    await drain();
    expect(await cmd(id)).toMatchObject({ status: 'SKIPPED' });
    expect((await cmd(id)).lastError).toMatchObject({ code: 'replace_not_supported' });
    expect(demo.documents(tenantId, con.uuid)).toHaveLength(1);
    expect(demo.documents(tenantId, con.uuid)[0]!.version).toBe(1);
  });

  it('resend: คำสั่งใหม่ใน transaction ของ tenant (canonical ฉบับที่ออก) · ยังไม่อยู่ใน ERP = PUSH · อยู่ใน ERP แล้ว = REPLACE_DOCUMENT · รหัสลูกค้าเปลี่ยน = REGENERATE', async () => {
    const con = await connector({ settings: { failMode: 'VALIDATION' } });
    const doc = invoiceDoc();
    await invoiceRow(doc);
    const first = await enqueue(con.uuid, doc);
    await drain();
    expect((await cmd(first)).status).toBe('FAILED_FINAL');
    expect((await mapping(doc.id))!.status).toBe('FAILED');

    // แก้ที่ระบบบัญชีแล้ว → ส่งใหม่: คำสั่งใหม่ (payload ฉบับที่ออก, ช่องผล/lease ว่าง) · คำสั่งเดิมคงผลไว้
    await settings(con.id, {});
    const again = (await db.withTenant(tenantId, (tx) =>
      app.get(ErpSyncService).resend(tx, 'invoice', doc.id, con.uuid),
    ))!;
    expect(again).not.toBe(first);
    const fresh = await cmd(again);
    expect(fresh).toMatchObject({
      status: 'PENDING',
      attempt: 0,
      errorClass: null,
      lastError: null,
      result: null,
      leaseId: null,
      operation: 'PUSH_INVOICE',
      payload: { document: { id: doc.id, sync: doc.sync } },
    });
    expect(fresh.idempotencyKey).toMatch(/:resend-[0-9a-f-]{36}$/);
    // มีคำสั่งค้างอยู่ = คืนคำสั่งนั้น (ไม่สร้างซ้ำ)
    expect(
      await db.withTenant(tenantId, (tx) =>
        app.get(ErpSyncService).resend(tx, 'invoice', doc.id, con.uuid),
      ),
    ).toBe(again);
    await drain();
    expect(await cmd(again)).toMatchObject({ status: 'DONE' });
    expect((await cmd(first)).status).toBe('FAILED_FINAL');
    expect((await mapping(doc.id))!.status).toBe('SYNCED');
    expect(demo.documents(tenantId, con.uuid)).toHaveLength(1);

    // อยู่ใน ERP แล้ว + map รหัสลูกค้าฝั่ง ERP ทีหลัง → resend = REPLACE_DOCUMENT ของฉบับที่ออก · ลูกค้าเปลี่ยน = REGENERATE (ไม่ส่ง)
    await api(app, token)
      .put(`/v1/customers/${encodeId('customer', customerId)}/erp-codes/${con.id}`)
      .send({ externalId: 'AR-7716' })
      .expect(200);
    const rid = await db.withTenant(tenantId, (tx) =>
      app.get(ErpSyncService).resend(tx, 'invoice', doc.id, con.uuid),
    );
    const rc = await cmd(rid!);
    expect(rc.operation).toBe('REPLACE_DOCUMENT');
    expect(rc.payload).toMatchObject({
      document: { id: doc.id, number: doc.number, sync: doc.sync },
      ref: { number: doc.number, externalId: (await mapping(doc.id))!.externalId },
    });
    await drain();
    expect(await cmd(rid!)).toMatchObject({ status: 'SKIPPED' });
    expect((await cmd(rid!)).lastError).toMatchObject({
      code: 'regenerate_required',
      changed: ['CUSTOMER'],
    });
    // ไม่เคยส่งเอกสารนี้ไป connector นี้ → null
    expect(
      await db.withTenant(tenantId, (tx) =>
        app.get(ErpSyncService).resend(tx, 'invoice', randomUUID(), con.uuid),
      ),
    ).toBeNull();
  });

  it('sync log: 1 แถวต่อ 1 HTTP call · ตัด credential + query string · ไม่มี header · ข้าม tenant 404 / RLS', async () => {
    const con = await connector();
    // ค่า credential หลุดเข้า body (เช่น ERP สะท้อนกลับ) → ต้องถูกตัดก่อนเก็บ
    const doc = invoiceDoc({ customerPoNo: `PO-${API_KEY}` });
    const id = await enqueue(con.uuid, doc);
    await drain();
    expect((await cmd(id)).status).toBe('DONE');
    const r = await api(app, token).get(`/v1/connectors/${con.id}/sync-log`).expect(200);
    expect(r.body.data).toHaveLength(1);
    const row = r.body.data[0];
    expect(row).toMatchObject({
      commandId: encodeId('outboxCommand', id),
      attempt: 1,
      operation: 'PUSH_INVOICE',
      entityType: 'invoice',
      localId: encodeId('invoice', doc.id),
      documentNo: doc.number,
      direction: 'OUT',
      method: 'POST',
      url: 'https://demo-erp.invalid/api/invoices',
      statusCode: 201,
      errorCode: null,
    });
    expect(row.id).toMatch(/^slg_/);
    expect(JSON.stringify(r.body)).not.toContain(API_KEY);
    expect(row.requestBody).toContain('PO-***');
    expect(row.responseBody).toContain('DEMO-INV-');
    // กรองตามคำสั่ง / เลขเอกสาร
    expect(
      (
        await api(app, token)
          .get(
            `/v1/connectors/${con.id}/sync-log?commandId=${encodeId('outboxCommand', randomUUID())}`,
          )
          .expect(200)
      ).body.data,
    ).toHaveLength(0);
    expect(
      (
        await api(app, token)
          .get(`/v1/connectors/${con.id}/sync-log?documentNo=${doc.number}`)
          .expect(200)
      ).body.data,
    ).toHaveLength(1);
    // keyset cursor (docs/01 §5.1): limit 1 + ส่งอีกใบ → 2 หน้า ไม่ซ้ำ
    await enqueue(con.uuid, invoiceDoc());
    await drain();
    const p1 = (await api(app, token).get(`/v1/connectors/${con.id}/sync-log?limit=1`).expect(200))
      .body;
    expect(p1).toMatchObject({ hasMore: true });
    expect(p1.data).toHaveLength(1);
    const p2 = (
      await api(app, token)
        .get(`/v1/connectors/${con.id}/sync-log?limit=1&cursor=${p1.nextCursor}`)
        .expect(200)
    ).body;
    expect(p2).toMatchObject({ hasMore: false, nextCursor: null });
    expect(p2.data[0].id).not.toBe(p1.data[0].id);
    await api(app, token).get(`/v1/connectors/${con.id}/sync-log?cursor=bad`).expect(422);
    // ข้าม tenant: connector ของอีก tenant = 404 · RLS: อีก tenant มองไม่เห็นแถว
    await api(app, other).get(`/v1/connectors/${con.id}/sync-log`).expect(404);
    expect(await db.withTenant(otherTenantId, (tx) => tx.erpSyncLog.count())).toBe(0);
    expect(await db.withTenant(tenantId, (tx) => tx.erpSyncLog.count())).toBeGreaterThan(0);
    // แอปแก้/ลบบันทึกไม่ได้
    await expect(db.withTenant(tenantId, (tx) => tx.erpSyncLog.deleteMany({}))).rejects.toThrow();
  });

  it('review: กันส่งซ้ำ — lease หลุดหลังส่ง / dead-letter ที่ถูกส่งใหม่ → ค้นฝั่ง ERP ก่อน ไม่ POST ซ้ำ · AMBIGUOUS + ค้นแล้วล่ม = TRANSIENT', async () => {
    const con = await connector({ settings: { failMode: 'AMBIGUOUS', failTimes: '1' } });
    const posts = (localId: string) =>
      plat.erpSyncLog.count({ where: { localId, method: 'POST' } });

    // (1) lease หลุด: ครั้งแรกถึง ERP แล้ว แต่ worker ตายก่อนบันทึกผล (ไม่มี error_class) → หยิบใหม่ = ค้นก่อน
    const a = invoiceDoc();
    const ia = await enqueue(con.uuid, a);
    await drain();
    expect(await posts(a.id)).toBe(1);
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'IN_FLIGHT', error_class = NULL, last_error = NULL,
                                  lease_id = gen_random_uuid(), lease_until = now() - interval '1 second'
                            WHERE id = ${ia}::uuid`;
    await dispatcher.drain();
    expect(await cmd(ia)).toMatchObject({
      status: 'DONE',
      result: { recoveredAfter: 'EARLIER_SEND', applied: true },
    });
    expect(await posts(a.id)).toBe(1);

    // (2) AMBIGUOUS แล้วค้นไม่ได้ (ปลายทางล่ม) → TRANSIENT `erp_lookup_failed` ไม่ POST ซ้ำแบบไม่รู้ผล
    const b = invoiceDoc();
    const ib = await enqueue(con.uuid, b);
    await drain();
    expect((await cmd(ib)).errorClass).toBe('AMBIGUOUS');
    const list = demo.listDocuments.bind(demo);
    demo.listDocuments = async () => {
      throw new Error('demo ERP list unavailable (test)');
    };
    try {
      await drain();
    } finally {
      demo.listDocuments = list;
    }
    expect(await cmd(ib)).toMatchObject({ status: 'FAILED_RETRYABLE', errorClass: 'TRANSIENT' });
    expect((await cmd(ib)).lastError).toMatchObject({ code: 'erp_lookup_failed' });
    expect(await posts(b.id)).toBe(1);

    // (3) dead-letter (lease หมดครั้งสุดท้าย) แล้วผู้ใช้กดส่งใหม่ → คำสั่งใหม่ค้นก่อน (หลักฐานจากคำสั่งเดิม/sync log)
    const c = invoiceDoc();
    const ic = await enqueue(con.uuid, c);
    await drain();
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'FAILED_FINAL', error_class = 'AMBIGUOUS',
                                  last_error = '{"code":"lease_expired"}'::jsonb, done_at = now()
                            WHERE id = ${ic}::uuid`;
    const r = (await db.withTenant(tenantId, (tx) =>
      app.get(ErpSyncService).resend(tx, 'invoice', c.id, con.uuid),
    ))!;
    expect(r).not.toBe(ic);
    await drain();
    expect(await cmd(r)).toMatchObject({
      status: 'DONE',
      result: { recoveredAfter: 'EARLIER_SEND' },
    });
    expect(await posts(c.id)).toBe(1);
    expect(demo.documents(tenantId, con.uuid).filter((d) => d.number === c.number)).toHaveLength(1);
  });

  it('review: capability ที่ adapter ประกาศแต่ยังไม่ได้ทำ (replaceDocument pending) = พักคำสั่ง ไม่ SKIPPED · paid_locked ใช้แม้ไม่มีกลุ่มที่เปลี่ยน', async () => {
    const con = await connector();
    const doc = invoiceDoc();
    await invoiceRow(doc);
    await enqueue(con.uuid, doc);
    await drain();
    const m = (await mapping(doc.id))!;
    const d = demo as unknown as { pendingCapabilities?: readonly string[] };
    d.pendingCapabilities = ['replaceDocument'];
    try {
      const id = await enqueue(con.uuid, changed(doc, { dueDate: '2026-12-28' }));
      await drain();
      expect(await cmd(id)).toMatchObject({ status: 'PENDING', errorClass: 'AUTH' });
      expect((await cmd(id)).lastError).toMatchObject({
        code: 'capability_not_implemented',
        capability: 'replaceDocument',
      });
      await plat.integrationOutbox.update({ where: { id }, data: { status: 'SKIPPED' } });
    } finally {
      delete d.pendingCapabilities;
    }
    // MISMATCH (เนื้อหาเท่าเดิม — ไม่มีกลุ่มที่เปลี่ยน) + รับชำระแล้ว → ส่งใหม่ = paid_locked (ไม่แทนที่)
    await plat.externalMapping.update({ where: { id: m.id }, data: { status: 'MISMATCH' } });
    await plat.$executeRaw`UPDATE invoice SET status = 'PAID' WHERE id = ${doc.id}::uuid`;
    const rid = (await db.withTenant(tenantId, (tx) =>
      app.get(ErpSyncService).resend(tx, 'invoice', doc.id, con.uuid),
    ))!;
    await drain();
    expect((await cmd(rid)).lastError).toMatchObject({ code: 'paid_locked', changed: [] });
    expect(demo.documents(tenantId, con.uuid)[0]!.version).toBe(1);
  });

  it('unit: scrub ตัด secret / query string / ขนาด · hash ต่อกลุ่ม field แยกการเปลี่ยนได้', () => {
    expect(scrubUrl('https://u:p@erp.example.com/api/x?key=abcd1234&b=1', ['abcd1234'])).toBe(
      'https://erp.example.com/api/x',
    );
    expect(scrubBody({ token: 'abcd1234' }, ['abcd1234'])).toBe('{"token":"***"}');
    expect(scrubBody('x'.repeat(20_000), [])!.length).toBe(16_000);
    expect(scrubBody(undefined, [])).toBeNull();
    // ช่องข้อมูลส่วนบุคคล/เลขผู้เสียภาษี = *** ตอนเขียน (object และสตริง JSON)
    expect(
      scrubBody(
        { carrier: { taxId: '3101234567890', name: 'นาย ก' }, trip: { driverName: 'สมชาย' } },
        [],
      ),
    ).toBe('{"carrier":{"taxId":"***","name":"นาย ก"},"trip":{"driverName":"***"}}');
    expect(scrubBody('{"tax_id":"0105555000001","x":null}', [])).toBe('{"tax_id":"***","x":null}');
    const a = invoiceDoc();
    const p = syncParts(a);
    expect(changedSyncParts(p, syncParts(a))).toEqual([]);
    expect(changedSyncParts(p, syncParts({ ...a, dueDate: '2027-01-01' }))).toEqual(['DATES']);
    expect(
      changedSyncParts(
        p,
        syncParts({ ...a, lines: [{ ...(a.lines as object[])[0], description: 'ค่ารอ' }] }),
      ),
    ).toEqual(['ACCESSORIAL']);
    expect(changedSyncParts(p, syncParts({ ...a, references: { customerRef: ['X'] } }))).toEqual([
      'OTHER',
    ]);
    expect(changedSyncParts(null, p)).toEqual([
      'CUSTOMER',
      'DATES',
      'PRICE',
      'ACCESSORIAL',
      'OTHER',
    ]);
  });
});
