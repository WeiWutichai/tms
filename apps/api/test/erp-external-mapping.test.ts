import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ErpOperation } from '@tms/domain';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { withSyncHash } from '../src/modules/erp/canonical';
import { canonicalProblems } from '../src/modules/erp/canonical-validation';
import type {
  CanonicalDocument,
  ErpContext,
  MasterCodeRef,
  PushResult,
} from '../src/modules/erp/erp-adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { ERP_SINK, sentIdempotencyKey } from '../src/modules/erp/erp-adapter.sink';
import { ExternalMappingService } from '../src/modules/erp/external-mapping.service';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../src/modules/integration/outbox.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { FakeErpAdapter, GOOD_KEY } from './fake-erp-adapter';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ERP จำลองของ test: รับใบแจ้งหนี้ + ใบสำคัญจ่าย · ประกาศว่าต้องมีรหัสคู่ค้าฝั่ง ERP หรือไม่ (`strictParties`) ·
 * คืน `externalVersion` (revision ฝั่ง ERP)
 */
class MappingErpAdapter extends FakeErpAdapter {
  strictParties = false;
  /** ERP ที่กันซ้ำด้วยเลขเอกสาร TMS: เลขเดิม = คืนเอกสารเดิม **ไม่แก้เนื้อหา** (`applied: false`) */
  dedupeByNumber = false;
  /** เนื้อหาที่ ERP ถืออยู่ ต่อเลขเอกสาร TMS */
  readonly held = new Map<string, { externalId: string; doc: CanonicalDocument }>();
  constructor() {
    super('map-erp', ['pushInvoice', 'pushSettlement', 'fetchDocument']);
  }
  private rev = 0;
  private stamp(r: PushResult): PushResult {
    return r.ok ? { ...r, externalVersion: `rev-${++this.rev}` } : r;
  }
  override async pushInvoice(ctx: ErpContext, inv: CanonicalDocument): Promise<PushResult> {
    const prior = this.held.get(inv.number);
    if (this.dedupeByNumber && prior) {
      this.calls.push({ op: 'pushInvoice', ctx, doc: inv });
      return { ok: true, externalId: prior.externalId, applied: false };
    }
    const r = this.stamp(await super.pushInvoice(ctx, inv));
    if (r.ok && r.applied) this.held.set(inv.number, { externalId: r.externalId, doc: inv });
    return r;
  }
  async pushSettlement(ctx: ErpContext, s: CanonicalDocument): Promise<PushResult> {
    // ใช้ทางเดียวกับใบแจ้งหนี้ (กันซ้ำด้วย idempotency key) — บันทึกชื่อ method ที่ถูกเรียก
    const r = this.stamp(await super.pushInvoice(ctx, s));
    this.calls[this.calls.length - 1]!.op = 'pushSettlement';
    return r;
  }
  masterCodeRefs(_ctx: ErpContext, _op: ErpOperation, doc: CanonicalDocument): MasterCodeRef[] {
    if (!this.strictParties) return [];
    const d = doc as {
      customer?: { externalId?: string | null };
      carrier?: { externalId?: string | null };
    };
    const refs: MasterCodeRef[] = [];
    if (d.customer)
      refs.push({
        kind: 'CUSTOMER',
        value: d.customer.externalId ?? null,
        field: 'customer.externalId',
        strict: true,
      });
    if (d.carrier)
      refs.push({
        kind: 'CARRIER',
        value: d.carrier.externalId ?? null,
        field: 'carrier.externalId',
        strict: true,
      });
    return refs;
  }
  override reset() {
    super.reset();
    this.strictParties = false;
    this.dedupeByNumber = false;
    this.held.clear();
  }
}

/**
 * ST7-T15 `external_mapping` + canonical + validation ก่อนถึง adapter (docs/01 §3.7, §7; docs/04 G3) — ผ่าน outbox (ทางเดียวกับ worker)
 * เกณฑ์ตรวจรับ: payload เดิม hash เท่าเดิม → ไม่ push ซ้ำ (SKIPPED) · push สำเร็จแล้วเก็บ `externalDocNo`
 */
describe('external_mapping + canonical (ST7-T15)', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  const erp = new MappingErpAdapter();
  let tenantId: string;
  let otherTenantId: string;
  let token: string;
  let reader: string;
  let other: string;
  let customerId: string;
  let carrierId: string;
  let carrier2Id: string;
  let seq = 0;

  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };
  const cmd = (id: string) => plat.integrationOutbox.findUniqueOrThrow({ where: { id } });
  /** ส่งคำสั่งเดิมใหม่ (ปุ่ม "ส่งซ้ำ" ของคิว / หยิบซ้ำหลัง worker ตาย) */
  const resend = async (id: string) => {
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'PENDING', attempt = 0, done_at = NULL
                            WHERE id = ${id}::uuid`;
    await drain();
  };
  const mapping = (entityType: 'INVOICE' | 'SETTLEMENT', localId: string) =>
    plat.externalMapping.findFirst({ where: { tenantId, entityType, localId } });

  async function connector(capabilities = ['pushInvoice', 'pushSettlement']) {
    const r = await api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'map-erp',
        settings: { baseUrl: 'https://erp.example.com/api' },
        credentials: { apiKey: GOOD_KEY },
        capabilitiesEnabled: capabilities,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await api(app, token).post(`/v1/connectors/${r.body.id}/resume`).send({}).expect(200);
    return { id: r.body.id as string, uuid: tryDecodeId('connector', r.body.id)! };
  }

  async function enqueue(
    connectorId: string,
    operation: 'PUSH_INVOICE' | 'PUSH_SETTLEMENT',
    document: Record<string, unknown>,
  ) {
    const { id } = await db.withTenant(tenantId, (tx) =>
      app.get(OutboxService).enqueueCommand(tx, {
        tenantId,
        kind: 'ADAPTER',
        sink: ERP_SINK,
        targetId: connectorId,
        operation,
        entityType: operation === 'PUSH_INVOICE' ? 'invoice' : 'settlement',
        localId: document.id as string,
        payload: { document },
      }),
    );
    return id;
  }

  /** canonical ใบแจ้งหนี้ (รูปเดียวกับ `ErpSyncService`) — ไม่มีค่าบริการที่ต้อง map (ประตู ST7-T18 มี test ของตัวเอง) */
  const invoiceDoc = (over: Record<string, unknown> = {}, id: string = randomUUID()) =>
    withSyncHash({
      kind: 'invoice',
      id,
      number: `INV-00000-2611-${String(++seq).padStart(4, '0')}`,
      issueDate: '2026-11-20',
      dueDate: '2026-12-20',
      issuer: { companyId: randomUUID(), branchId: randomUUID(), branchCode: '00000' },
      customer: {
        id: customerId,
        code: 'C-T15',
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

  const settlementDoc = (over: Record<string, unknown> = {}, id: string = randomUUID()) =>
    withSyncHash({
      kind: 'settlement',
      id,
      number: `STL-2611-${String(++seq).padStart(4, '0')}`,
      paidDate: '2026-11-21',
      payingCompanyId: null,
      period: { from: '2026-11-01', to: '2026-11-15' },
      carrierInvoiceNumber: 'CI-88',
      carrier: {
        id: carrierId,
        code: 'SUB-T15',
        legalName: 'หจก. รถร่วมทดสอบ',
        taxId: null,
        branchCode: '00000',
        entityType: 'JURISTIC',
      },
      payment: { method: 'TRANSFER', reference: null, bank: null },
      totals: {
        gross: '9000.00',
        deduction: '0.00',
        net: '9000.00',
        wht: '90.00',
        netAfterWht: '8910.00',
      },
      whtEstimate: { pndForm: 'PND53', byRate: [], reviewedByAccountant: false },
      taxEstimated: true,
      lines: [
        {
          lineNo: 1,
          lineType: 'TRIP_COST',
          trip: { number: 'TRP-1' },
          description: 'ค่าจ้างรถร่วม',
          amount: '9000.00',
          vatType: null,
          whtRate: '1.00',
          whtAmount: '90.00',
        },
      ],
      ...over,
    } as CanonicalDocument);

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    app.get(ErpAdapterRegistry).register(erp);
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ทดสอบ mapping' })).id;
    otherTenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น' })).id;
    await plat.tenant.updateMany({ data: { planCode: 'ent' } });
    token = await tokenFor(tenantId);
    reader = await tokenFor(tenantId, 'master:read');
    other = await tokenFor(otherTenantId);
    customerId = (
      await plat.customer.create({
        data: {
          tenantId,
          code: 'C-T15',
          legalName: 'บริษัท ลูกค้า จำกัด',
          taxId: validTaxId(7151),
        },
      })
    ).id;
    const carrier = (code: string, n: number) =>
      plat.carrier.create({
        data: {
          tenantId,
          code,
          legalName: `หจก. รถร่วมทดสอบ ${n}`,
          entityType: 'JURISTIC',
          taxId: validTaxId(7160 + n),
          branchCode: '00000',
        },
      });
    carrierId = (await carrier('SUB-T15', 1)).id;
    carrier2Id = (await carrier('SUB-T15B', 2)).id;
  });
  beforeEach(async () => {
    erp.reset();
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
  });
  afterAll(async () => {
    app.get(ErpAdapterRegistry).unregister(erp.key);
    await app.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: push สำเร็จเก็บ externalId / externalDocNo / externalVersion + hash · payload เดิม → SKIPPED payload_unchanged (ไม่เรียก ERP) · payload เปลี่ยน → ส่งใหม่', async () => {
    const con = await connector();
    const doc = invoiceDoc();
    const id = await enqueue(con.uuid, 'PUSH_INVOICE', doc);
    await drain();
    expect(erp.calls).toHaveLength(1);
    // เลข TMS ไปถึง adapter (adapter ใส่ช่อง ref ของ ERP) + hash ของสิ่งที่ส่งจริง
    const sent = erp.calls[0]!.doc as CanonicalDocument;
    expect(sent.number).toBe(doc.number);
    // ผลของคำสั่งบอกว่าส่งอะไรไป: hash ของเอกสารที่ส่งจริง + รหัสลูกค้าฝั่ง ERP ที่ใส่ ณ ตอนส่ง (ไม่มี = null)
    const done = await cmd(id);
    expect(done).toMatchObject({
      status: 'DONE',
      result: {
        externalId: 'ext-1',
        externalDocNo: 'ERP-ext-1',
        applied: true,
        sentHash: sent.sync!.hash,
        customerExternalId: null,
      },
    });
    expect(done.result).not.toHaveProperty('carrierExternalId');
    // key กันซ้ำฝั่ง ERP ผูกกับ hash ของเอกสารที่ส่งจริง (ไม่ใช่ hash ของคำสั่ง)
    expect(erp.calls[0]!.ctx.idempotencyKey).toBe(
      sentIdempotencyKey(done.idempotencyKey, sent.sync!.hash),
    );
    expect(erp.calls[0]!.ctx.idempotencyKey).not.toBe(done.idempotencyKey);
    const m = await mapping('INVOICE', doc.id);
    expect(m).toMatchObject({
      connectorId: con.uuid,
      localNumber: doc.number,
      externalId: 'ext-1',
      externalDocNo: 'ERP-ext-1',
      externalVersion: 'rev-1',
      status: 'SYNCED',
      lastSyncedHash: sent.sync!.hash,
    });
    expect(m!.lastSyncedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(m!.lastSyncedAt).not.toBeNull();

    // ส่งคำสั่งเดิมซ้ำ → hash เท่าเดิม = SKIPPED ไม่เรียก ERP · mapping ไม่เปลี่ยน
    await resend(id);
    const again = await cmd(id);
    expect(again.status).toBe('SKIPPED');
    expect(again.lastError).toMatchObject({
      code: 'payload_unchanged',
      externalId: 'ext-1',
      externalDocNo: 'ERP-ext-1',
    });
    expect(erp.calls).toHaveLength(1);
    expect((await mapping('INVOICE', doc.id))!.version).toBe(m!.version);
    // enqueue ซ้ำด้วย payload เดิม = คำสั่งเดิม (ไม่มีแถวใหม่)
    expect(await enqueue(con.uuid, 'PUSH_INVOICE', doc)).toBe(id);

    // เอกสารฝั่ง ERP ถูกยกเลิก (webhook → external_status VOIDED) → ส่งคำสั่งเดิมซ้ำไม่ถูกข้าม (ส่งใหม่ได้)
    await plat.externalMapping.update({ where: { id: m!.id }, data: { externalStatus: 'VOIDED' } });
    await resend(id);
    expect((await cmd(id)).status).toBe('DONE');
    expect(erp.calls).toHaveLength(2);
    await plat.externalMapping.update({ where: { id: m!.id }, data: { externalStatus: 'DRAFT' } });

    // เอกสารเดิม payload เปลี่ยน (ยอดต่าง) → คำสั่งใหม่ → ส่งจริง + hash ใหม่ · เลขเอกสารฝั่ง ERP เดิมไม่ถูกทับ
    const changed = invoiceDoc(
      { number: doc.number, totals: { ...(doc.totals as object), whtExpected: '30.00' } },
      doc.id,
    );
    const id2 = await enqueue(con.uuid, 'PUSH_INVOICE', changed);
    expect(id2).not.toBe(id);
    await drain();
    expect((await cmd(id2)).status).toBe('DONE');
    expect(erp.calls).toHaveLength(3);
    const m2 = await mapping('INVOICE', doc.id);
    expect(m2!.lastSyncedHash).not.toBe(m!.lastSyncedHash);
    expect(m2).toMatchObject({ externalDocNo: 'ERP-ext-1', status: 'SYNCED' });
    // ERP ได้เนื้อหาใหม่จริง
    expect((erp.calls[2]!.doc as { totals: { whtExpected: string } }).totals.whtExpected).toBe(
      '30.00',
    );
  });

  it('review M1: worker เสีย lease หลังบันทึก mapping (คำสั่งยังไม่เคยจบ) → รอบถัดไป DONE แบบ idempotent {unchanged: true} ไม่เรียก ERP ซ้ำ · system-of-record ล็อกจาก external_mapping', async () => {
    const con = await connector();
    const doc = invoiceDoc();
    const id = await enqueue(con.uuid, 'PUSH_INVOICE', doc);
    await drain();
    expect((await cmd(id)).status).toBe('DONE');
    const m = await mapping('INVOICE', doc.id);
    // จำลอง: adapter ตอบสำเร็จ + mapping ถูกบันทึกแล้ว แต่ผล DONE ของคำสั่งไม่ถูกเขียน (lease หลุด) → คำสั่งถูกหยิบใหม่
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'PENDING', result = NULL, done_at = NULL,
                                  lease_id = NULL, lease_until = NULL WHERE id = ${id}::uuid`;
    await drain();
    const again = await cmd(id);
    expect(again).toMatchObject({
      status: 'DONE',
      errorClass: null,
      result: {
        externalId: 'ext-1',
        externalDocNo: 'ERP-ext-1',
        unchanged: true,
        sentHash: m!.lastSyncedHash,
      },
    });
    expect(erp.calls).toHaveLength(1);
    expect((await mapping('INVOICE', doc.id))!.version).toBe(m!.version);

    // ล็อก system-of-record อ่านจาก external_mapping ด้วย: แม้คำสั่งทั้งหมดจบเป็น SKIPPED/ล้ม เอกสารที่ถึง ERP แล้วยังล็อก
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED' WHERE target_id = ${con.uuid}`;
    const sor = await api(app, token)
      .put(`/v1/connectors/${con.id}/system-of-record`)
      .send({ taxDocumentOwner: 'ERP', reason: 'เปลี่ยนเจ้าของเอกสารหลังส่งเอกสารไปแล้ว' });
    expect(sor.status, JSON.stringify(sor.body)).toBe(409);
    expect(sor.body.code).toBe('sor_locked');
  });

  it('review M2: ERP ที่คืนเอกสารเดิมโดยไม่รับเนื้อหาใหม่ (`applied: false`) → ไม่เลื่อน last_synced_hash · mapping = MISMATCH (erp_not_applied / erp_content_unverified)', async () => {
    const con = await connector();
    const cus = encodeId('customer', customerId);
    await api(app, token)
      .put(`/v1/customers/${cus}/erp-codes/${con.id}`)
      .send({ externalId: 'AR-100' })
      .expect(200);
    erp.dedupeByNumber = true;
    const doc = invoiceDoc();
    const id = await enqueue(con.uuid, 'PUSH_INVOICE', doc);
    await drain();
    expect(await cmd(id)).toMatchObject({
      status: 'DONE',
      result: { applied: true, customerExternalId: 'AR-100' },
    });
    const m1 = await mapping('INVOICE', doc.id);
    expect(m1).toMatchObject({ status: 'SYNCED' });
    // เปลี่ยนรหัสลูกค้า → เอกสารที่ส่งเปลี่ยน → ส่งคำสั่งเดิมใหม่: ERP ตอบ "มีอยู่แล้ว" (ไม่แก้เนื้อหา)
    await api(app, token)
      .put(`/v1/customers/${cus}/erp-codes/${con.id}`)
      .send({ externalId: 'AR-200', reason: 'บัญชีแจ้งรหัสลูกค้าใหม่ในระบบบัญชี' })
      .expect(200);
    await resend(id);
    const c2 = await cmd(id);
    expect(c2).toMatchObject({
      status: 'DONE',
      result: { applied: false, customerExternalId: 'AR-200', externalId: m1!.externalId },
    });
    expect((c2.result as { sentHash: string }).sentHash).not.toBe(m1!.lastSyncedHash);
    // ERP ยังถือเนื้อหาเก่า → TMS ไม่ถือว่าซิงก์แล้ว
    expect(
      (erp.held.get(doc.number)!.doc as unknown as { customer: { externalId: string } }).customer
        .externalId,
    ).toBe('AR-100');
    const m2 = await mapping('INVOICE', doc.id);
    expect(m2).toMatchObject({
      status: 'MISMATCH',
      lastSyncedHash: m1!.lastSyncedHash,
      externalId: m1!.externalId,
    });
    expect(m2!.lastError).toMatchObject({
      code: 'erp_not_applied',
      sentHash: (c2.result as { sentHash: string }).sentHash,
    });
    // MISMATCH ไม่ถูกข้ามตอนส่งซ้ำ (ยังไม่ตรง) และ `sync` ของเอกสารบอก MISMATCH
    await resend(id);
    expect((await cmd(id)).status).toBe('DONE');
    expect(erp.calls).toHaveLength(3);
    expect(
      await db.withTenant(tenantId, (tx) =>
        app.get(ExternalMappingService).documentSync('INVOICE', doc.id, tx),
      ),
    ).toMatchObject({ state: 'MISMATCH' });

    // ERP มีเอกสารของเลขนี้อยู่แล้วโดย TMS ไม่มี mapping (ผลรอบก่อนไม่ถูกบันทึก) → รู้ id แต่ไม่ยืนยันเนื้อหา
    const other = invoiceDoc();
    erp.held.set(other.number, { externalId: 'ext-old', doc: other });
    const id3 = await enqueue(con.uuid, 'PUSH_INVOICE', other);
    await drain();
    expect(await cmd(id3)).toMatchObject({ status: 'DONE', result: { applied: false } });
    const m3 = await mapping('INVOICE', other.id);
    expect(m3).toMatchObject({ externalId: 'ext-old', status: 'MISMATCH', lastSyncedHash: null });
    expect(m3!.lastError).toMatchObject({ code: 'erp_content_unverified' });
  });

  it('รหัสลูกค้าฝั่ง ERP มาจาก external_mapping ณ ตอนส่ง: ยังไม่ map → FAILED_FINAL + ลิงก์ · map แล้วส่งคำสั่งเดิมใหม่ผ่าน · เปลี่ยนรหัส = payload เปลี่ยน ส่งใหม่', async () => {
    const con = await connector();
    erp.strictParties = true;
    // payload ตรึงรหัสเก่าไว้ตอนสร้างคำสั่ง — ตารางเป็นตัวตัดสิน (ไม่มี mapping = ไม่มีรหัส)
    const doc = invoiceDoc({
      customer: { id: customerId, code: 'C-T15', legalName: 'ลูกค้า', externalId: 'STALE' },
    });
    const id = await enqueue(con.uuid, 'PUSH_INVOICE', doc);
    await drain();
    const failed = await cmd(id);
    expect(failed).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    expect(failed.lastError).toMatchObject({
      code: 'erp_master_code_unknown',
      link: `/settings?sec=conn&connector=${con.id}`,
      missing: [{ kind: 'CUSTOMER', status: 'MISSING', fields: ['customer.externalId'] }],
    });
    expect(erp.calls).toHaveLength(0);
    expect(await mapping('INVOICE', doc.id)).toBeNull();

    const cus = encodeId('customer', customerId);
    await api(app, token)
      .put(`/v1/customers/${cus}/erp-codes/${con.id}`)
      .send({ externalId: 'AR-001' })
      .expect(200);
    await resend(id);
    expect((await cmd(id)).status).toBe('DONE');
    expect((erp.calls[0]!.doc as { customer: { externalId: string } }).customer.externalId).toBe(
      'AR-001',
    );
    const h1 = (await mapping('INVOICE', doc.id))!.lastSyncedHash;
    // hash = ของที่ส่งจริง (มีรหัสลูกค้า) ≠ hash ตอนสร้างคำสั่ง
    expect(h1).not.toBe(doc.sync!.hash);

    await resend(id);
    expect((await cmd(id)).status).toBe('SKIPPED');
    await api(app, token)
      .put(`/v1/customers/${cus}/erp-codes/${con.id}`)
      .send({ externalId: 'AR-002', reason: 'บัญชีแจ้งรหัสลูกค้าใหม่ในระบบบัญชี' })
      .expect(200);
    await resend(id);
    const c2 = await cmd(id);
    expect(c2).toMatchObject({
      status: 'DONE',
      result: { applied: true, customerExternalId: 'AR-002' },
    });
    expect(erp.calls).toHaveLength(2);
    // เนื้อหาเปลี่ยน = key กันซ้ำฝั่ง ERP เปลี่ยน → ERP ได้เนื้อหาใหม่จริง (ไม่คืนของเก่าด้วย key เดิม)
    expect(erp.calls[1]!.ctx.idempotencyKey).not.toBe(erp.calls[0]!.ctx.idempotencyKey);
    expect(erp.received.get(erp.calls[1]!.ctx.idempotencyKey!)!.body).toContain('"AR-002"');
    expect((await mapping('INVOICE', doc.id))!.lastSyncedHash).toBe(
      (c2.result as { sentHash: string }).sentHash,
    );
    expect((await mapping('INVOICE', doc.id))!.lastSyncedHash).not.toBe(h1);

    // review L2: ใช้เฉพาะ mapping คู่ค้าสถานะ SYNCED — สถานะอื่น (เช่น MISMATCH จาก reconcile ในอนาคต) = ถือว่าไม่มีรหัส
    await plat.externalMapping.updateMany({
      where: { tenantId, entityType: 'CUSTOMER', localId: customerId, connectorId: con.uuid },
      data: { status: 'MISMATCH' },
    });
    expect(
      await db.withTenant(tenantId, (tx) =>
        app.get(ExternalMappingService).customerErpCode(tx, con.uuid, customerId),
      ),
    ).toBeNull();
    const id2 = await enqueue(con.uuid, 'PUSH_INVOICE', invoiceDoc());
    await drain();
    expect(await cmd(id2)).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    expect((await cmd(id2)).lastError).toMatchObject({ code: 'erp_master_code_unknown' });
  });

  it('CARRIER: ตั้งรหัสรถร่วมในระบบบัญชี (API) → ใบสำคัญจ่ายส่งด้วย carrier.externalId · ERP ที่บังคับรหัส + ยังไม่ map → FAILED_FINAL + ลิงก์', async () => {
    const con = await connector();
    const car = encodeId('carrier', carrierId);
    const list0 = await api(app, reader).get(`/v1/carriers/${car}/erp-codes`).expect(200);
    expect(list0.body.data).toEqual([
      expect.objectContaining({
        connector: expect.objectContaining({ id: con.id, adapterKey: 'map-erp' }),
        externalId: null,
        status: 'UNMAPPED',
        version: 0,
      }),
    ]);
    // อ่านได้ด้วย master:read · แก้ต้องมี settings:write
    await api(app, reader)
      .put(`/v1/carriers/${car}/erp-codes/${con.id}`)
      .send({ externalId: 'V-001' })
      .expect(403);

    erp.strictParties = true;
    const doc = settlementDoc();
    const id = await enqueue(con.uuid, 'PUSH_SETTLEMENT', doc);
    await drain();
    const failed = await cmd(id);
    expect(failed).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    expect(failed.lastError).toMatchObject({
      code: 'erp_master_code_unknown',
      link: `/settings?sec=conn&connector=${con.id}`,
      missing: [{ kind: 'CARRIER', status: 'MISSING', fields: ['carrier.externalId'] }],
    });
    expect((failed.lastError as { message: string }).message).toContain('รหัสรถร่วมในระบบบัญชี');
    expect(erp.calls).toHaveLength(0);

    const set = await api(app, token)
      .put(`/v1/carriers/${car}/erp-codes/${con.id}`)
      .set('If-Match', '"0"')
      .send({ externalId: ' V-001 ' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ externalId: 'V-001', status: 'SYNCED', version: 1 });
    expect(set.headers.etag).toBe('"1"');
    expect(
      await plat.externalMapping.findFirst({
        where: { tenantId, entityType: 'CARRIER', localId: carrierId },
      }),
    ).toMatchObject({ connectorId: con.uuid, externalId: 'V-001', status: 'SYNCED' });

    await resend(id);
    expect((await cmd(id)).status).toBe('DONE');
    expect(erp.calls[0]).toMatchObject({ op: 'pushSettlement' });
    expect((erp.calls[0]!.doc as { carrier: { externalId: string } }).carrier.externalId).toBe(
      'V-001',
    );
    expect(await mapping('SETTLEMENT', doc.id)).toMatchObject({
      localNumber: doc.number,
      externalId: 'ext-1',
      externalDocNo: 'ERP-ext-1',
      status: 'SYNCED',
    });
    await resend(id);
    expect((await cmd(id)).status).toBe('SKIPPED');
    expect((await cmd(id)).lastError).toMatchObject({ code: 'payload_unchanged' });

    // กติกาเดียวกับรหัสลูกค้า: รหัสซ้ำกับรถร่วมอื่น 409 · เปลี่ยน/ล้างต้องมีเหตุผล · If-Match · รูปแบบ · audit
    const dup = await api(app, token)
      .put(`/v1/carriers/${encodeId('carrier', carrier2Id)}/erp-codes/${con.id}`)
      .send({ externalId: 'V-001' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'external_id_conflict', mappedCarrierId: car });
    await api(app, token)
      .put(`/v1/carriers/${car}/erp-codes/${con.id}`)
      .send({ externalId: 'V-002' })
      .expect(422);
    await api(app, token)
      .put(`/v1/carriers/${car}/erp-codes/${con.id}`)
      .set('If-Match', '"7"')
      .send({ externalId: 'V-002', reason: 'บัญชีแจ้งรหัสผู้ขายใหม่ในระบบบัญชี' })
      .expect(412);
    await api(app, token)
      .put(`/v1/carriers/${car}/erp-codes/${con.id}`)
      .send({ externalId: 'bad\u0007code' })
      .expect(422);
    const cleared = await api(app, token)
      .put(`/v1/carriers/${car}/erp-codes/${con.id}`)
      .send({ externalId: null, reason: 'ยกเลิกรหัสผู้ขายเพื่อทดสอบ' })
      .expect(200);
    expect(cleared.body).toMatchObject({ externalId: null, status: 'PENDING', version: 2 });
    const audits = await plat.auditLog.findMany({
      where: { tenantId, action: 'external_mapping.changed', entityType: 'carrier' },
      orderBy: { seq: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      entityId: carrierId,
      reason: 'ยกเลิกรหัสผู้ขายเพื่อทดสอบ',
    });
    // ล้างรหัสแล้ว = ไม่มีรหัส ณ ตอนส่ง → ใบใหม่ของรถร่วมนี้ถูกกันอีก (ไม่ใช้รหัสที่ยกเลิกแล้ว)
    const id2 = await enqueue(con.uuid, 'PUSH_SETTLEMENT', settlementDoc());
    await drain();
    expect((await cmd(id2)).status).toBe('FAILED_FINAL');

    // ERP ที่ไม่บังคับรหัส (จับคู่เองได้) → ส่งได้โดยไม่มี mapping (Standalone-first: mapping ไม่กันการทำงาน)
    erp.strictParties = false;
    await resend(id2);
    expect((await cmd(id2)).status).toBe('DONE');
    expect(
      (erp.calls.at(-1)!.doc as { carrier: { externalId?: string | null } }).carrier.externalId ??
        null,
    ).toBeNull();
  });

  it('รหัสรถร่วม: connector ยกเลิกแล้ว 409 · ข้าม tenant 404 (RLS) · sandbox ใช้ไม่ได้', async () => {
    const con = await connector();
    const car = encodeId('carrier', carrierId);
    // tenant อื่น: ไม่เห็นรถร่วม/connector ของเรา
    await api(app, other).get(`/v1/carriers/${car}/erp-codes`).expect(404);
    await api(app, other)
      .put(`/v1/carriers/${car}/erp-codes/${con.id}`)
      .send({ externalId: 'X-1' })
      .expect(404);
    const theirs = await plat.carrier.create({
      data: {
        tenantId: otherTenantId,
        code: 'SUB-OTH',
        legalName: 'รถร่วมของบริษัทอื่น',
        entityType: 'JURISTIC',
        taxId: validTaxId(7199),
        branchCode: '00000',
      },
    });
    // รถร่วมของ tenant อื่น + connector ของเรา → 404 · connector ของเรา + token อื่น → 404
    await api(app, token)
      .put(`/v1/carriers/${encodeId('carrier', theirs.id)}/erp-codes/${con.id}`)
      .send({ externalId: 'X-1' })
      .expect(404);
    await api(app, other)
      .put(`/v1/carriers/${encodeId('carrier', theirs.id)}/erp-codes/${con.id}`)
      .send({ externalId: 'X-1' })
      .expect(404);
    expect(await plat.externalMapping.count({ where: { entityType: 'CARRIER' } })).toBe(
      await plat.externalMapping.count({ where: { entityType: 'CARRIER', tenantId } }),
    );
    // tenant อื่นอ่านตารางผ่าน RLS ไม่เห็นแถวของเรา
    await api(app, token)
      .put(`/v1/carriers/${car}/erp-codes/${con.id}`)
      .send({ externalId: 'V-RLS' })
      .expect(200);
    expect(
      await db.withTenant(otherTenantId, (tx) =>
        tx.externalMapping.count({ where: { entityType: 'CARRIER' } }),
      ),
    ).toBe(0);
    // review L4: `sync` ของเอกสารไม่นับ connector ที่ยกเลิกการเชื่อมแล้ว
    const doc = invoiceDoc();
    await enqueue(con.uuid, 'PUSH_INVOICE', doc);
    await drain();
    const syncOf = () =>
      db.withTenant(tenantId, (tx) =>
        app.get(ExternalMappingService).documentSync('INVOICE', doc.id, tx),
      );
    expect(await syncOf()).toMatchObject({ connectorId: con.uuid, state: 'SYNCED' });
    await api(app, token)
      .post(`/v1/connectors/${con.id}/disconnect`)
      .send({ reason: 'ยกเลิกการเชื่อมเพื่อทดสอบ' })
      .expect(200);
    expect(await syncOf()).toBeNull();
    await api(app, token)
      .put(`/v1/carriers/${car}/erp-codes/${con.id}`)
      .send({ externalId: 'V-9' })
      .expect(409);
    expect(
      (await api(app, token).get(`/v1/carriers/${car}/erp-codes`).expect(200)).body.data,
    ).toEqual([]);
  });

  it('validation ก่อนถึง adapter: canonical ผิดรูป (ไม่มีเลข TMS / ยอดเงินไม่ใช่ทศนิยม 2 ตำแหน่ง / วันที่ผิด) → FAILED_FINAL invalid_payload ไม่เรียก ERP', async () => {
    const con = await connector();
    const bad = invoiceDoc({
      number: ' ',
      issueDate: '20/11/2569',
      totals: { total: 1000 },
      lines: [{ lineNo: 1, amount: '1000.5', vatAmount: '0.00', discount: '0.00' }],
    });
    const id = await enqueue(con.uuid, 'PUSH_INVOICE', bad);
    await drain();
    const c = await cmd(id);
    expect(c).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    const err = c.lastError as { code: string; fields: { field: string; code: string }[] };
    expect(err.code).toBe('invalid_payload');
    expect(err.fields.map((f) => `${f.field}:${f.code}`)).toEqual(
      expect.arrayContaining([
        'number:required',
        'issueDate:invalid_format',
        'totals.total:invalid_format',
        'totals.vatAmount:required',
        'lines[0].amount:invalid_format',
      ]),
    );
    expect(erp.calls).toHaveLength(0);
    expect(await mapping('INVOICE', bad.id)).toBeNull();
  });

  it('canonicalProblems (unit): เอกสารถูกรูปผ่าน · ไม่มีบรรทัด / เลขบรรทัดซ้ำ / ช่วงวันที่ขาด ถูกจับ · เอกสารไม่มี kind ตรวจแค่ id + เลข', () => {
    expect(canonicalProblems(invoiceDoc())).toEqual([]);
    expect(canonicalProblems(settlementDoc())).toEqual([]);
    expect(canonicalProblems({ id: 'x', number: 'INV-1', totals: { total: 5 } })).toEqual([]);
    expect(canonicalProblems(null).map((p) => p.field)).toEqual(['document']);
    expect(canonicalProblems({ id: 'x', number: 'N'.repeat(61) })).toEqual([
      expect.objectContaining({ field: 'number', code: 'too_long' }),
    ]);
    expect(canonicalProblems(invoiceDoc({ lines: [] })).map((p) => p.field)).toEqual(['lines']);
    const l = { lineNo: 1, amount: '1.00', vatAmount: '0.00', discount: '0.00' };
    expect(
      canonicalProblems(invoiceDoc({ lines: [l, l, { ...l, lineNo: 0 }] })).map(
        (p) => `${p.field}:${p.code}`,
      ),
    ).toEqual(['lines[1].lineNo:duplicate', 'lines[2].lineNo:invalid_format']);
    expect(
      canonicalProblems(settlementDoc({ period: { from: '2026-13-01' }, paidDate: null })).map(
        (p) => `${p.field}:${p.code}`,
      ),
    ).toEqual(['paidDate:required', 'period.from:invalid_format', 'period.to:required']);
    // บรรทัดหักของใบสำคัญจ่าย = ยอดติดลบได้ · whtAmount ไม่บังคับ
    expect(
      canonicalProblems(
        settlementDoc({ lines: [{ lineNo: 1, amount: '-500.00', whtAmount: null }] }),
      ),
    ).toEqual([]);
    // ปัญหาไม่เกิน 20 รายการ (ใบใหญ่ไม่ทำให้ last_error บวม)
    const many = Array.from({ length: 60 }, (_, i) => ({ lineNo: i + 1, amount: 1 }));
    expect(canonicalProblems(invoiceDoc({ lines: many }))).toHaveLength(20);
  });
});
