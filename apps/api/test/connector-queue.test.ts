import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { withSyncHash } from '../src/modules/erp/canonical';
import { queueGuide } from '../src/modules/erp/connector-queue';
import type { CanonicalDocument } from '../src/modules/erp/erp-adapter';
import { ERP_SINK } from '../src/modules/erp/erp-adapter.sink';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../src/modules/integration/outbox.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST7-T19 คิวเชื่อมระบบบัญชีที่ลูกค้าดูเอง (docs/01 §6.4; docs/04 G3; spec/07 §2) — ผ่าน outbox → DemoProvider (ทางเดียวกับ worker)
 * เกณฑ์ตรวจรับ: error ที่ฉีดจาก DemoProvider ขึ้นในแท็บ "ล้มเหลว" พร้อมคำแนะนำ · กดส่งซ้ำแล้วสำเร็จย้ายไป "สำเร็จ"
 */
describe('Connector queue (ST7-T19)', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  let tenantId: string;
  let token: string;
  let customerId: string;
  let companyId: string;
  let branchId: string;
  let seq = 0;

  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };

  async function connector(o: { capabilities?: string[]; settings?: Record<string, string> } = {}) {
    const r = await api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'demo',
        credentials: { apiKey: 'demo-secret-key-7719' },
        capabilitiesEnabled: o.capabilities ?? [
          'pushInvoice',
          'fetchDocument',
          'listDocuments',
          'replaceDocument',
        ],
        ...(o.settings ? { settings: o.settings } : {}),
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await api(app, token).post(`/v1/connectors/${r.body.id}/resume`).send({}).expect(200);
    return { id: r.body.id as string, uuid: tryDecodeId('connector', r.body.id)! };
  }
  const settings = (conId: string, s: Record<string, string>) =>
    api(app, token).patch(`/v1/connectors/${conId}`).send({ settings: s }).expect(200);

  const invoiceDoc = () =>
    withSyncHash({
      kind: 'invoice',
      id: randomUUID(),
      number: `INV-00000-2611-${String(++seq).padStart(4, '0')}`,
      issueDate: '2026-11-20',
      dueDate: '2026-12-20',
      issuer: { companyId, branchId, branchCode: '00000' },
      customer: {
        id: customerId,
        code: 'C-T19',
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
    } as unknown as CanonicalDocument);

  async function enqueue(connectorId: string, document: CanonicalDocument) {
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
        payload: { document },
      }),
    );
    return id;
  }
  const queue = (conId: string, tab: string, extra = '') =>
    api(app, token).get(`/v1/connectors/${conId}/queue?tab=${tab}${extra}`).expect(200);
  const ids = (body: { data: { id: string }[] }) => body.data.map((r) => r.id);

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท คิว ERP' })).id;
    await plat.tenant.updateMany({ data: { planCode: 'ent' } });
    token = await tokenFor(tenantId);
    customerId = (
      await plat.customer.create({
        data: {
          tenantId,
          code: 'C-T19',
          legalName: 'บริษัท ลูกค้า จำกัด',
          taxId: validTaxId(7719),
        },
      })
    ).id;
    companyId = (
      await plat.company.create({
        data: { tenantId, legalName: 'บริษัท ผู้ออก จำกัด', taxId: validTaxId(7720) },
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
          address: { line1: '1', district: 'x', province: 'x', postcode: '10000' },
        },
      })
    ).id;
  });
  beforeEach(async () => {
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: PERIOD_CLOSED จาก DemoProvider ขึ้นแท็บ "ล้มเหลว" พร้อมคู่มือ → ส่งซ้ำแล้วสำเร็จย้ายไป "สำเร็จ"', async () => {
    const con = await connector({ settings: { failMode: 'PERIOD_CLOSED' } });
    const doc = invoiceDoc();
    const first = await enqueue(con.uuid, doc);
    await drain();
    const cmdId = encodeId('outboxCommand', first);

    const failed = (await queue(con.id, 'failed')).body;
    expect(ids(failed)).toEqual([cmdId]);
    expect(failed.data[0]).toMatchObject({
      tab: 'failed',
      status: 'FAILED_FINAL',
      errorClass: 'PERIOD_CLOSED',
      documentNo: doc.number,
      partyName: 'บริษัท ลูกค้า จำกัด',
      guide: { key: 'PERIOD_CLOSED' },
      actions: { retry: true, skip: true, externalId: true, approve: false },
      resolution: null,
    });
    expect(failed.data[0].guide.action).toContain('เปิดงวด');
    expect(failed.data[0].errorMessage).toContain('period');
    // ค่าเริ่มของแท็บ = ล้มเหลว
    expect(
      ids((await api(app, token).get(`/v1/connectors/${con.id}/queue`).expect(200)).body),
    ).toEqual([cmdId]);
    expect(
      (await api(app, token).get(`/v1/connectors/${con.id}/queue/summary`).expect(200)).body,
    ).toEqual({
      queued: 0,
      failed: 1,
      done: 0,
      succeeded24h: 0,
      finished24h: 1,
      failedByClass: { PERIOD_CLOSED: 1 },
    });
    // request/response ของคำสั่งนี้ (ตัด secret แล้ว) จาก sync log
    const log = (
      await api(app, token).get(`/v1/connectors/${con.id}/sync-log?commandId=${cmdId}`).expect(200)
    ).body.data;
    expect(log.length).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toContain('demo-secret-key-7719');

    // เปิดงวดแล้ว (ปลายทางรับ) → ส่งซ้ำ
    await settings(con.id, { failMode: 'none' });
    const r = await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${cmdId}/retry`)
      .expect(200);
    const newId = r.body.command.id as string;
    expect(newId).not.toBe(cmdId);
    expect(r.body.command).toMatchObject({
      tab: 'queued',
      status: 'PENDING',
      documentNo: doc.number,
    });
    expect(ids((await queue(con.id, 'failed')).body)).toEqual([]);
    expect(ids((await queue(con.id, 'queued')).body)).toEqual([newId]);
    await drain();
    const done = (await queue(con.id, 'done')).body;
    expect(ids(done)).toEqual([newId]);
    expect(done.data[0]).toMatchObject({ status: 'DONE', tab: 'done', guide: null });
    // การ์ด "สำเร็จ 24 ชม." (ต้นแบบ kpis('erp'); PO 24 พ.ย. 2569) — คำสั่งที่ส่งสำเร็จใน 24 ชม. ล่าสุด
    const s24 = (await api(app, token).get(`/v1/connectors/${con.id}/queue/summary`).expect(200))
      .body;
    expect(s24).toMatchObject({ failed: 0, done: 1, succeeded24h: 1, finished24h: 1 });
    // documents (ช่องกรอกต่อใบ) มีเฉพาะรายการที่กรอกเลขเองได้ของ adapter ที่แยกใบ — Demo = เอกสารเดียว
    expect(done.data[0].documents).toEqual([]);
    // คำสั่งเดิมไม่อยู่ในแท็บใด (ถูกแทนที่) — ส่งซ้ำอีกไม่ได้
    for (const tab of ['queued', 'failed', 'done'])
      expect(ids((await queue(con.id, tab)).body)).not.toContain(cmdId);
    const again = await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${cmdId}/retry`)
      .expect(409);
    expect(again.body).toMatchObject({ code: 'queue_action_not_allowed', why: 'already_resolved' });
    const audit = await plat.auditLog.findFirst({
      where: { tenantId, action: 'connector.queue_retried', entityId: con.uuid },
    });
    expect(audit?.after).toMatchObject({
      commandId: cmdId,
      newCommandId: newId,
      errorClass: 'PERIOD_CLOSED',
    });
  });

  it('TRANSIENT อยู่แท็บ "รอคิว" พร้อมเวลาครั้งถัดไป — ไม่ใช่งานของคน (ส่งซ้ำ/ข้ามไม่ได้)', async () => {
    const con = await connector({ settings: { failMode: 'TRANSIENT' } });
    const id = encodeId('outboxCommand', await enqueue(con.uuid, invoiceDoc()));
    await drain();
    const q = (await queue(con.id, 'queued')).body;
    expect(ids(q)).toEqual([id]);
    expect(q.data[0]).toMatchObject({
      status: 'FAILED_RETRYABLE',
      errorClass: 'TRANSIENT',
      guide: { key: 'TRANSIENT' },
    });
    expect(Date.parse(q.data[0].nextRunAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(q.data[0].actions).toEqual({
      retry: false,
      skip: false,
      externalId: false,
      approve: false,
    });
    await api(app, token).post(`/v1/connectors/${con.id}/queue/${id}/retry`).expect(409);
    await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${id}/skip`)
      .send({ reason: 'ทดสอบข้ามรายการที่ยังรอคิว' })
      .expect(409);
  });

  it('erp_mapping_incomplete: แสดง link + missing[] · แก้ mapping แล้วส่งซ้ำ (ส่งซ้ำทั้งหมด)', async () => {
    const con = await connector();
    const a = await enqueue(con.uuid, invoiceDoc());
    const b = await enqueue(con.uuid, invoiceDoc());
    // ประตู mapping ของ sink ให้ผลนี้ (ST7-T18) — จำลองผลที่ตัวส่งบันทึก
    const lastError = {
      code: 'erp_mapping_incomplete',
      message: 'ยังไม่ได้จับคู่รหัสสินค้าในระบบบัญชีของ ค่าขนส่ง',
      link: `/settings?sec=conn&connector=${con.id}`,
      missing: [
        {
          serviceItemId: 'svc_x',
          code: 'FRT',
          nameTh: 'ค่าขนส่ง',
          itemCode: null,
          status: 'UNMAPPED',
        },
      ],
    };
    await plat.integrationOutbox.updateMany({
      where: { id: { in: [a, b] } },
      data: { status: 'FAILED_FINAL', errorClass: 'VALIDATION', lastError, doneAt: new Date() },
    });
    const f = (await queue(con.id, 'failed')).body;
    expect(f.data).toHaveLength(2);
    expect(f.data[0]).toMatchObject({
      errorCode: 'erp_mapping_incomplete',
      link: lastError.link,
      missing: lastError.missing,
      guide: { key: 'erp_mapping_incomplete' },
    });
    // แบ่งหน้า (keyset)
    const p1 = (await queue(con.id, 'failed', '&limit=1')).body;
    expect(p1).toMatchObject({ hasMore: true });
    const p2 = (await queue(con.id, 'failed', `&limit=1&cursor=${p1.nextCursor}`)).body;
    expect([...ids(p1), ...ids(p2)].sort()).toEqual(ids(f).sort());
    expect(p2.hasMore).toBe(false);

    const all = await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/retry`)
      .send({})
      .expect(200);
    expect(all.body).toEqual({ retried: 2, notRetryable: 0, remaining: 0 });
    await drain();
    expect(ids((await queue(con.id, 'failed')).body)).toEqual([]);
    expect((await queue(con.id, 'done')).body.data).toHaveLength(2);
  });

  it('ข้ามพร้อมเหตุผล (override — audit) · รายการที่ต้องทำในระบบบัญชีเองส่งซ้ำไม่ได้', async () => {
    const con = await connector();
    const raw = await enqueue(con.uuid, invoiceDoc());
    await plat.integrationOutbox.update({
      where: { id: raw },
      data: {
        status: 'SKIPPED',
        errorClass: 'CAPABILITY',
        lastError: { code: 'regenerate_required' },
        doneAt: new Date(),
      },
    });
    const id = encodeId('outboxCommand', raw);
    const f = (await queue(con.id, 'failed')).body.data[0];
    expect(f).toMatchObject({
      id,
      guide: { key: 'regenerate_required' },
      actions: { retry: false, skip: true, externalId: true, approve: false },
    });
    const no = await api(app, token).post(`/v1/connectors/${con.id}/queue/${id}/retry`).expect(409);
    expect(no.body.why).toBe('not_retryable');
    await api(app, token).post(`/v1/connectors/${con.id}/queue/${id}/skip`).send({}).expect(422);
    await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${id}/skip`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const s = await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${id}/skip`)
      .send({ reason: 'ฝ่ายบัญชีออกเอกสารใหม่ในระบบบัญชีแล้ว' })
      .expect(200);
    expect(s.body).toMatchObject({
      tab: 'done',
      resolution: { kind: 'SKIPPED', reason: 'ฝ่ายบัญชีออกเอกสารใหม่ในระบบบัญชีแล้ว' },
      actions: { retry: false, skip: false, externalId: false, approve: false },
    });
    expect(ids((await queue(con.id, 'done')).body)).toContain(id);
    const audit = await plat.auditLog.findFirst({
      where: { tenantId, action: 'connector.queue_skipped' },
    });
    expect(audit).toMatchObject({
      reason: 'ฝ่ายบัญชีออกเอกสารใหม่ในระบบบัญชีแล้ว',
      entityId: con.uuid,
    });
    expect(audit?.after).toMatchObject({ commandId: id, errorCode: 'regenerate_required' });
    await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${id}/skip`)
      .send({ reason: 'ข้ามซ้ำอีกครั้งไม่ควรได้' })
      .expect(409);
  });

  it('DUPLICATE ที่หาเอกสารไม่เจอ → แท็บล้มเหลว · กรอกเลขฝั่งระบบบัญชีเอง (mapping MISMATCH รอ reconcile) · เลขซ้ำ 409', async () => {
    const con = await connector({
      capabilities: ['pushInvoice'],
      settings: { failMode: 'DUPLICATE' },
    });
    const doc = invoiceDoc();
    const id = encodeId('outboxCommand', await enqueue(con.uuid, doc));
    const doc2 = invoiceDoc();
    const id2 = encodeId('outboxCommand', await enqueue(con.uuid, doc2));
    await drain();
    const f = (await queue(con.id, 'failed')).body.data.find((r: { id: string }) => r.id === id);
    expect(f).toMatchObject({
      status: 'DONE',
      manualExternalIdRequired: true,
      guide: { key: 'duplicate_unresolved' },
      actions: { externalId: true },
    });
    // review L5: DONE ที่ต้องกรอกเลขเอง (DUPLICATE หาไม่เจอ) ไม่นับเป็นสำเร็จของการ์ด "สำเร็จ 24 ชม."
    const s24 = (await api(app, token).get(`/v1/connectors/${con.id}/queue/summary`).expect(200))
      .body;
    expect(s24).toMatchObject({ succeeded24h: 0, finished24h: 2 });
    await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${id}/external-id`)
      .send({ externalId: 'ERP-001' })
      .expect(422);
    await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${id}/external-id`)
      .send({ externalId: 'X'.repeat(101), reason: 'ค้นพบในระบบบัญชีแล้วเลข ERP-001' })
      .expect(422);
    const r = await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${id}/external-id`)
      .send({
        externalId: 'ERP-001',
        externalDocNo: 'IV-001',
        reason: 'ค้นพบในระบบบัญชีแล้วเลข ERP-001',
      })
      .expect(200);
    expect(r.body).toMatchObject({
      tab: 'done',
      resolution: { kind: 'MANUAL_EXTERNAL_ID', externalId: 'ERP-001' },
    });
    const m = await plat.externalMapping.findFirst({
      where: { tenantId, entityType: 'INVOICE', localId: doc.id },
    });
    expect(m).toMatchObject({ externalId: 'ERP-001', externalDocNo: 'IV-001', status: 'MISMATCH' });
    expect(m!.lastError).toMatchObject({ code: 'erp_content_unverified', source: 'manual' });
    expect(
      await plat.auditLog.count({ where: { tenantId, action: 'connector.queue_external_id' } }),
    ).toBe(1);
    // เลขเดียวกันกับเอกสารอื่น → 409
    const dup = await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${id2}/external-id`)
      .send({ externalId: 'ERP-001', reason: 'ลองใช้เลขเดียวกันกับอีกใบ' })
      .expect(409);
    expect(dup.body.code).toBe('external_id_conflict');
  });

  it('สิทธิ์: integrations:read ดูได้แต่ส่งซ้ำ/ข้ามไม่ได้ · คำสั่งของ connector อื่น = 404', async () => {
    const con = await connector({ settings: { failMode: 'PERIOD_CLOSED' } });
    const id = encodeId('outboxCommand', await enqueue(con.uuid, invoiceDoc()));
    await drain();
    const reader = await tokenFor(tenantId, 'integrations:read');
    await api(app, reader).get(`/v1/connectors/${con.id}/queue?tab=failed`).expect(200);
    await api(app, reader).get(`/v1/connectors/${con.id}/sync-log?commandId=${id}`).expect(200);
    await api(app, reader).post(`/v1/connectors/${con.id}/queue/${id}/retry`).expect(403);
    const retrier = await tokenFor(tenantId, 'integrations:read integrations:retry');
    // connector อื่นของ tenant เดียวกัน (ปิดอันเดิมก่อนเพราะขอบเขตเดียวกันมีได้ตัวเดียว)
    await plat.connector.update({
      where: { id: con.uuid },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
    const other = await connector();
    await api(app, retrier).post(`/v1/connectors/${other.id}/queue/${id}/retry`).expect(404);
    await api(app, retrier).post(`/v1/connectors/${other.id}/queue/obx_nope/retry`).expect(404);
    // connector ยกเลิกแล้ว → ส่งซ้ำไม่ได้ (resend ไม่สร้างคำสั่ง)
    const r = await api(app, retrier)
      .post(`/v1/connectors/${con.id}/queue/${id}/retry`)
      .expect(409);
    expect(r.body.why).toBe('resend_unavailable');
  });

  /** คำสั่ง FAILED_FINAL (VALIDATION) ของเอกสาร — จำลองผลที่ตัวส่งบันทึก */
  async function failed(conUuid: string, document = invoiceDoc(), key?: string) {
    const raw = key
      ? (
          await plat.integrationOutbox.create({
            data: {
              tenantId,
              kind: 'ADAPTER',
              sink: ERP_SINK,
              targetId: conUuid,
              operation: 'PUSH_INVOICE',
              entityType: 'invoice',
              localId: document.id,
              serializeKey: `erp:${conUuid}:cus:${customerId}`,
              idempotencyKey: key,
              payload: { document } as object,
            },
          })
        ).id
      : await enqueue(conUuid, document);
    await plat.integrationOutbox.update({
      where: { id: raw },
      data: {
        status: 'FAILED_FINAL',
        errorClass: 'VALIDATION',
        lastError: { code: 'customer_unmapped', message: 'x' },
        doneAt: new Date(),
      },
    });
    return { raw, id: encodeId('outboxCommand', raw), document };
  }

  it('review H1: ไม่มีสิทธิ์ดูราคาขาย → sync log ไม่มี body (bodiesHidden) · รายการคิวบอกให้ซ่อนปุ่ม', async () => {
    const con = await connector({ settings: { failMode: 'PERIOD_CLOSED' } });
    const id = encodeId('outboxCommand', await enqueue(con.uuid, invoiceDoc()));
    await drain();
    const owner = (
      await api(app, token).get(`/v1/connectors/${con.id}/sync-log?commandId=${id}`).expect(200)
    ).body.data;
    expect(owner[0]).toMatchObject({ bodiesHidden: false });
    expect(owner[0].requestBody).toContain('1000.00');
    const viewer = await tokenFor(tenantId, 'integrations:read');
    const v = (
      await api(app, viewer).get(`/v1/connectors/${con.id}/sync-log?commandId=${id}`).expect(200)
    ).body.data;
    expect(v[0]).toMatchObject({ bodiesHidden: true, requestBody: null, responseBody: null });
    expect(JSON.stringify(v)).not.toContain('1000.00');
    const q = (await api(app, viewer).get(`/v1/connectors/${con.id}/queue`).expect(200)).body;
    expect(q.data[0]).toMatchObject({ id, bodiesHidden: true });
    const sell = await tokenFor(tenantId, 'integrations:read prices.sell:read');
    const s = (
      await api(app, sell).get(`/v1/connectors/${con.id}/sync-log?commandId=${id}`).expect(200)
    ).body.data;
    expect(s[0].bodiesHidden).toBe(false);
  });

  it('review M1/L3: ส่งซ้ำทั้งหมด — แถวที่ล้มไม่ย้อนแถวอื่น · ก่อนวันเริ่มซิงก์ / ต้องกรอกเลขเอง = ส่งซ้ำไม่ได้', async () => {
    const con = await connector();
    const ok = await failed(con.uuid);
    // 2 คำสั่งล้มเหลวของเอกสารเดียวกัน: ตัวแรกส่งซ้ำแล้ว ตัวที่สองถูกแทน (SAVEPOINT — ไม่ย้อนตัวแรก)
    const twin = await failed(con.uuid, ok.document, `t19-twin-${randomUUID()}`);
    const old = await failed(con.uuid, {
      ...invoiceDoc(),
      issueDate: '2026-10-01',
    } as CanonicalDocument);
    const dup = await failed(con.uuid);
    await plat.integrationOutbox.update({
      where: { id: dup.raw },
      data: {
        status: 'DONE',
        errorClass: 'DUPLICATE',
        lastError: { code: 'duplicate_unresolved', manualExternalIdRequired: true },
      },
    });
    await api(app, token)
      .patch(`/v1/connectors/${con.id}`)
      .send({ syncFromDate: '2026-11-01' })
      .expect(200);
    const f = (await queue(con.id, 'failed')).body.data as {
      id: string;
      actions: { retry: boolean };
    }[];
    const act = (x: { id: string }) => f.find((r) => r.id === x.id)!.actions.retry;
    expect([act(ok), act(twin), act(old), act(dup)]).toEqual([true, true, false, false]);
    const r = await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/retry`)
      .send({})
      .expect(200);
    expect(r.body).toEqual({ retried: 1, notRetryable: 3, remaining: 0 });
    const left = ids((await queue(con.id, 'failed')).body);
    expect(left).not.toContain(ok.id);
    expect(left).not.toContain(twin.id); // ถูกแทนด้วยคำสั่งใหม่ที่ยังค้าง (M3)
    expect(left).toEqual(expect.arrayContaining([old.id, dup.id]));
    const one = await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${old.id}/retry`)
      .expect(409);
    expect(one.body.why).toBe('resend_unavailable');
  });

  it('review M2: เอกสารที่มี external_id แล้ว กรอกเลขเองไม่ได้ (409 mapping_exists)', async () => {
    const con = await connector();
    const x = await failed(con.uuid);
    await plat.externalMapping.create({
      data: {
        tenantId,
        connectorId: con.uuid,
        entityType: 'INVOICE',
        localId: x.document.id,
        externalId: 'ERP-EXIST',
        status: 'SYNCED',
      },
    });
    const f = (await queue(con.id, 'failed')).body.data.find((r: { id: string }) => r.id === x.id);
    expect(f.actions.externalId).toBe(false);
    const r = await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${x.id}/external-id`)
      .send({ externalId: 'ERP-NEW', reason: 'ลองทับเลขที่มีอยู่แล้ว' })
      .expect(409);
    expect(r.body.why).toBe('mapping_exists');
  });

  it('review M3: คำสั่งที่ล้มแต่มีคำสั่งหลังกว่าของเอกสารเดียวกันสำเร็จแล้ว ไม่อยู่ในแท็บล้มเหลว · badge ตรงกัน', async () => {
    const con = await connector();
    const x = await failed(con.uuid);
    expect(
      (await api(app, token).get(`/v1/connectors/${con.id}/queue/summary`).expect(200)).body.failed,
    ).toBe(1);
    await plat.integrationOutbox.create({
      data: {
        tenantId,
        kind: 'ADAPTER',
        sink: ERP_SINK,
        targetId: con.uuid,
        operation: 'PUSH_INVOICE',
        entityType: 'invoice',
        localId: x.document.id,
        serializeKey: `erp:${con.uuid}:cus:${customerId}`,
        idempotencyKey: `t19-later-${randomUUID()}`,
        payload: { document: x.document } as object,
        status: 'DONE',
        doneAt: new Date(),
      },
    });
    expect(ids((await queue(con.id, 'failed')).body)).toEqual([]);
    expect(
      (await api(app, token).get(`/v1/connectors/${con.id}/queue/summary`).expect(200)).body.failed,
    ).toBe(0);
    const r = await api(app, token)
      .post(`/v1/connectors/${con.id}/queue/${x.id}/skip`)
      .send({ reason: 'ข้ามรายการที่ถูกแทนแล้ว' })
      .expect(409);
    expect(r.body.why).toBe('superseded');
  });

  it('review L2: API key ส่งซ้ำได้ แต่ข้าม / กรอกเลขเอง ไม่ได้ (403 — ต้องเป็นคน)', async () => {
    const con = await connector();
    const x = await failed(con.uuid);
    const u = await plat.appUser.create({
      data: {
        tenantId,
        email: `key-${randomUUID()}@t19.test`,
        name: 'เจ้าของ key',
        status: 'ACTIVE',
      },
    });
    const k = await api(app, await tokenFor(tenantId, '*', u.id))
      .post('/v1/api-keys')
      .send({ name: 'ERP queue', scopes: ['integrations:read', 'integrations:retry'] });
    expect(k.status, JSON.stringify(k.body)).toBe(201);
    const key = k.body.secret as string;
    await api(app, key)
      .post(`/v1/connectors/${con.id}/queue/${x.id}/skip`)
      .send({ reason: 'ข้ามด้วย API key ไม่ควรได้' })
      .expect(403);
    await api(app, key)
      .post(`/v1/connectors/${con.id}/queue/${x.id}/external-id`)
      .send({ externalId: 'K-1', reason: 'กรอกด้วย API key ไม่ควรได้' })
      .expect(403);
    await api(app, key).post(`/v1/connectors/${con.id}/queue/${x.id}/retry`).expect(200);
  });

  it('queueGuide: รหัสเฉพาะก่อน แล้วตาม ErrorClass · ไม่รู้จัก = null', () => {
    expect(queueGuide('VALIDATION', 'erp_master_code_unknown')?.key).toBe(
      'erp_master_code_unknown',
    );
    expect(queueGuide('VALIDATION', 'something_else')?.key).toBe('VALIDATION');
    expect(queueGuide(null, null)).toBeNull();
  });
});
