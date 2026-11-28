import type { NestExpressApplication } from '@nestjs/platform-express';
import { expect } from 'vitest';
import { tryDecodeId } from '../../src/common/ids';
import { DbService } from '../../src/db/db.service';
import type { CanonicalDocument } from '../../src/modules/erp/erp-adapter';
import { ERP_SINK } from '../../src/modules/erp/erp-adapter.sink';
import { OutboxDispatcher } from '../../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../../src/modules/integration/outbox.service';
import { api, platform } from '../helpers';

/**
 * P1-ST5-T01 ชุด conformance ระดับ pipeline (ใช้ฐานข้อมูล) — adapter ตัวจริงผ่าน API + outbox + sink ทางเดียวกับ worker:
 * (1) สร้าง connector ผ่าน `/v1/connectors` (R-01: adapter ที่กำหนดเจ้าของเอกสารภาษีตายตัว — ส่งค่าอื่น = 422 `sor_fixed`)
 * (2) push สำเร็จ → คำสั่ง DONE + `external_mapping` ของเอกสาร (connector นี้, SYNCED, externalId ตามผล adapter) — แถวเดียวแม้ส่งซ้ำ
 * (3) แยก tenant: tenant อื่นไม่เห็น mapping (RLS) และเปิด connector/คิวไม่ได้ (404)
 * (4) ปลายทางปฏิเสธ payload (VALIDATION) → FAILED_FINAL + ขึ้นแท็บ "ล้มเหลว" ของคิวที่ลูกค้าดูเอง (docs/01 §6.4)
 * (5) key ผิด (AUTH) → คำสั่งคง PENDING (ไม่นับครั้ง) + connector ERROR ทันที (docs/01 §6.3 · D68-47)
 *
 * ผู้ใช้: `test/connector-conformance-pipeline.test.ts` — connector ใหม่เพิ่ม 1 ชุดที่นั่น
 */
/** JSON ที่ทน BigInt (คอลัมน์ seq ของ outbox) */
const stringify = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

export interface PipelineConformanceSpec {
  adapterKey: string;
  /** body ของ `POST /v1/connectors` (ไม่รวม adapterKey) */
  create: () => Record<string, unknown>;
  /** R-01 เจ้าของเอกสารภาษีตายตัว (ไม่มี = ผู้ดูแลเลือกเอง) */
  fixedTaxDocumentOwner?: 'ERP' | 'TMS';
  /** canonical ใบแจ้งหนี้ (id ต้องเป็น uuid · เลขไม่ซ้ำ) */
  invoice: () => CanonicalDocument;
  /** ทำให้คำขอถัดไปของ connector นี้ล้มแบบ VALIDATION / AUTH (เช่น mock.failNext(422) หรือเปลี่ยนค่าตั้ง) */
  failNext: (cls: 'VALIDATION' | 'AUTH', h: PipelineHandles) => Promise<void>;
  /** ล้าง fault (ถ้าต้อง) */
  reset?: (h: PipelineHandles) => Promise<void>;
}

export interface PipelineHandles {
  app: NestExpressApplication;
  token: string;
  connectorId: string;
}

export async function runPipelineConformance(
  spec: PipelineConformanceSpec,
  env: {
    app: NestExpressApplication;
    tenantId: string;
    token: string;
    otherTenantId: string;
    otherToken: string;
    customerId: string;
  },
) {
  const { app, tenantId, token } = env;
  const plat = platform();
  const db = app.get(DbService);
  const dispatcher = app.get(OutboxDispatcher);
  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };

  // (1) สร้าง connector + R-01
  const body = { adapterKey: spec.adapterKey, ...spec.create() };
  if (spec.fixedTaxDocumentOwner) {
    const other = spec.fixedTaxDocumentOwner === 'ERP' ? 'TMS' : 'ERP';
    const bad = await api(app, token)
      .post('/v1/connectors')
      .send({ ...body, taxDocumentOwner: other });
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    expect(bad.body.code).toBe('sor_fixed');
  }
  const r = await api(app, token).post('/v1/connectors').send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (spec.fixedTaxDocumentOwner)
    expect(r.body.systemOfRecord.taxDocumentOwner).toBe(spec.fixedTaxDocumentOwner);
  const conId = r.body.id as string;
  const conUuid = tryDecodeId('connector', conId)!;
  await api(app, token).post(`/v1/connectors/${conId}/resume`).send({}).expect(200);
  const h: PipelineHandles = { app, token, connectorId: conId };

  const enqueue = async (document: CanonicalDocument) =>
    (
      await db.withTenant(tenantId, (tx) =>
        app.get(OutboxService).enqueueCommand(tx, {
          tenantId,
          kind: 'ADAPTER',
          sink: ERP_SINK,
          targetId: conUuid,
          operation: 'PUSH_INVOICE',
          entityType: 'invoice',
          localId: document.id,
          customerId: env.customerId,
          payload: { document },
        }),
      )
    ).id;
  const cmd = (id: string) => plat.integrationOutbox.findUniqueOrThrow({ where: { id } });

  // (2) push สำเร็จ → mapping
  const doc = spec.invoice();
  const ok = await enqueue(doc);
  await drain();
  const done = await cmd(ok);
  expect(
    done,
    stringify({ status: done.status, errorClass: done.errorClass, lastError: done.lastError }),
  ).toMatchObject({ status: 'DONE' });
  const maps = await plat.externalMapping.findMany({
    where: { tenantId, entityType: 'INVOICE', localId: doc.id },
  });
  expect(maps).toHaveLength(1);
  expect(maps[0]).toMatchObject({ connectorId: conUuid, status: 'SYNCED', matchKind: null });
  expect(maps[0]!.externalId).toBeTruthy();
  expect(maps[0]!.lastSyncedHash).toBeTruthy();
  // ส่งซ้ำเนื้อหาเดิม = ไม่มีแถว/เอกสารเพิ่ม
  await enqueue(doc);
  await drain();
  expect(
    await plat.externalMapping.count({
      where: { tenantId, entityType: 'INVOICE', localId: doc.id },
    }),
  ).toBe(1);

  // (3) แยก tenant
  expect(
    await db.withTenant(env.otherTenantId, (tx) =>
      tx.externalMapping.count({ where: { localId: doc.id } }),
    ),
  ).toBe(0);
  await api(app, env.otherToken).get(`/v1/connectors/${conId}`).expect(404);
  await api(app, env.otherToken).get(`/v1/connectors/${conId}/queue?tab=failed`).expect(404);

  // (4) VALIDATION → FAILED_FINAL + แท็บล้มเหลวของคิว
  await spec.failNext('VALIDATION', h);
  const v = await enqueue(spec.invoice());
  await drain();
  expect(await cmd(v)).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
  await spec.reset?.(h);
  const failed = await api(app, token).get(`/v1/connectors/${conId}/queue?tab=failed`).expect(200);
  const item = (failed.body.data as { id: string; errorClass: string; guide: unknown }[]).find(
    (i) => i.errorClass === 'VALIDATION',
  );
  expect(item, JSON.stringify(failed.body)).toBeDefined();
  expect(item).toHaveProperty('guide');

  // (5) AUTH → PENDING + connector ERROR (D68-47)
  await spec.failNext('AUTH', h);
  const a = await enqueue(spec.invoice());
  await drain();
  expect(await cmd(a)).toMatchObject({ status: 'PENDING', errorClass: 'AUTH' });
  expect((await plat.connector.findUniqueOrThrow({ where: { id: conUuid } })).status).toBe('ERROR');
  await spec.reset?.(h);
  return { conId, conUuid };
}

/**
 * P1-ST5-T01b ชุด pipeline ขาอ่านกลับ: **fetch → reconcile → payment pull** กับใบแจ้งหนี้จริง (finalize ผ่าน API → outbox → adapter)
 * adapter บอกช่องทางที่ระบบบัญชีส่งข้อมูลกลับ (`channel`):
 * - `pull` (มี `fetchDocument` + `fetchPaymentStatus` — docs/01 §6.1/§6.5): TMS อ่านเองผ่าน `POST /v1/reconcile-runs`
 *   (DOCUMENT → คำสั่ง FETCH_DOCUMENT ในคิว · PAYMENT_STATUS → job ดึงสถานะรับชำระ)
 * - `inbound` (webhook ขาเข้า — ST7-T22): ระบบบัญชีส่ง event "ลงบัญชีแล้ว" / "รับชำระ" มาที่ URL ของ connector
 * ข้อที่ตรวจ (ทั้งสองช่องทาง ผลต้องเท่ากันในมุมผู้ใช้):
 * (6) fetch: เอกสารฝั่งระบบบัญชีถูกอ่านกลับ → `sync` ของใบมีเลข/สถานะฝั่งระบบบัญชี (pull: `reconcileState` ACCEPTED)
 * (7) reconcile: ยอดฝั่งระบบบัญชี ≠ TMS → ไม่เงียบ (pull: MISMATCH ใน `/v1/reconcile-results` + `sync.reconcileState` ·
 *     inbound: event เข้าคิวตรวจ `external_total_mismatch`) · ใบ TMS ไม่ถูกแก้ยอด
 * (8) payment pull: ระบบบัญชีรับชำระครบ (ตัดหนี้ = รับ + WHT) → payment `source CONNECTOR` 1 รายการ ใบเป็น PAID ·
 *     ระบบบัญชีรายงานซ้ำ → ไม่สร้างซ้ำ · tenant อื่นไม่เห็น payment
 */
export interface IssuedInvoice {
  /** id สาธารณะ (`ivc_…`) */
  id: string;
  uuid: string;
  invoiceNo: string;
}

export interface ReadbackConformanceSpec {
  adapterKey: string;
  channel: 'pull' | 'inbound';
  /** body ของ `POST /v1/connectors` (ไม่รวม adapterKey) — pull ต้องเปิด `fetchDocument` (`fetchPaymentStatus` = opt-in เปิดใน `prepare` พร้อมเหตุผล) */
  create: () => Record<string, unknown>;
  /** หลังเปิดใช้ connector: mapping รหัสสินค้า / ออก token รับ webhook ฯลฯ */
  prepare?: (h: PipelineHandles) => Promise<void>;
  /**
   * ระบบบัญชียืนยันเอกสารของใบนี้ — `total` = ยอดที่ระบบบัญชีถือ (ไม่ระบุ = ยอดเดียวกับที่ส่ง)
   * pull: ทำให้การอ่านกลับครั้งถัดไปได้ยอดนี้ · inbound: ส่ง event "ลงบัญชีแล้ว" ด้วยยอดนี้
   */
  erpConfirms: (h: PipelineHandles, inv: IssuedInvoice, total?: string) => Promise<void>;
  /** ระบบบัญชีบันทึกรับชำระของใบนี้: ตัดหนี้รวม `settled` = รับจริง `received` + WHT `wht` — pull: สถานะให้ fetchPaymentStatus · inbound: event รับชำระ */
  erpPaid: (
    h: PipelineHandles,
    inv: IssuedInvoice,
    p: { settled: string; received: string; wht: string; seq: number },
  ) => Promise<void>;
  /** คืนค่าที่ฉีด (เช่น spy) */
  reset?: (h: PipelineHandles) => Promise<void>;
}

export async function runReadbackConformance(
  spec: ReadbackConformanceSpec,
  env: {
    app: NestExpressApplication;
    tenantId: string;
    /** ผู้ดูแล (settings:write) */
    token: string;
    otherTenantId: string;
    otherToken: string;
    /** ร่าง + finalize ใบแจ้งหนี้ 1 บรรทัดของ tenant (คำสั่งส่งเข้าคิวเอง) */
    issueInvoice: (amount: string) => Promise<IssuedInvoice>;
    /** run job ที่ถึงเวลา (inbound / รอบดึง) */
    drainJobs: () => Promise<void>;
  },
) {
  const { app, tenantId, token } = env;
  const plat = platform();
  const db = app.get(DbService);
  const dispatcher = app.get(OutboxDispatcher);
  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                            WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };
  const settle = async () => {
    await drain();
    await env.drainJobs();
    await drain();
  };
  const r = await api(app, token)
    .post('/v1/connectors')
    .send({ adapterKey: spec.adapterKey, ...spec.create() });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const conId = r.body.id as string;
  const conUuid = tryDecodeId('connector', conId)!;
  const res = await api(app, token).post(`/v1/connectors/${conId}/resume`).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const h: PipelineHandles = { app, token, connectorId: conId };
  await spec.prepare?.(h);
  const sync = async (inv: IssuedInvoice) =>
    (await api(app, token).get(`/v1/invoices/${inv.id}`).expect(200)).body.sync as Record<
      string,
      unknown
    > | null;
  const issued = async (amount: string) => {
    const inv = await env.issueInvoice(amount);
    await drain();
    const s = await sync(inv);
    expect(s, `ใบ ${inv.invoiceNo} ต้องถึงระบบบัญชี`).toMatchObject({
      connectorId: conId,
      state: 'SYNCED',
    });
    return inv;
  };
  const readBack = async (inv: IssuedInvoice) => {
    if (spec.channel !== 'pull') return settle();
    const run = await api(app, token)
      .post('/v1/reconcile-runs')
      .send({
        check: 'DOCUMENT',
        connectorId: conId,
        invoiceIds: [inv.id],
        reason: 'ชุด conformance ตรวจการอ่านเอกสารกลับ',
      });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    await settle();
  };
  const openMismatch = async (inv: IssuedInvoice) =>
    (
      (
        await api(app, token)
          .get(`/v1/reconcile-results?invoiceId=${inv.id}&status=OPEN`)
          .expect(200)
      ).body.data as { result: string }[]
    ).filter((x) => x.result === 'MISMATCH');
  const inboundEvents = () =>
    plat.processedWebhookEvent.findMany({
      where: { tenantId, connectorId: conUuid },
      orderBy: { receivedAt: 'asc' },
    });

  // (6) fetch: ยอดตรง
  const a = await issued('1000.00');
  const seen = (await inboundEvents()).length;
  await spec.erpConfirms(h, a);
  await readBack(a);
  const s6 = await sync(a);
  expect(s6, JSON.stringify(s6)).toMatchObject({ state: 'SYNCED' });
  if (spec.channel === 'pull') {
    expect(s6!.reconcileState).toBe('ACCEPTED');
  } else {
    expect(s6!.externalDocNo).toBeTruthy();
    const evs = (await inboundEvents()).slice(seen);
    expect(evs.length).toBeGreaterThan(0);
    expect(
      evs.every((e) => e.status === 'PROCESSED'),
      JSON.stringify(evs),
    ).toBe(true);
  }
  expect(await openMismatch(a)).toHaveLength(0);

  // (7) reconcile: ยอดฝั่งระบบบัญชีไม่ตรง → ไม่เงียบ
  const b = await issued('440.00');
  const seenB = (await inboundEvents()).length;
  await spec.erpConfirms(h, b, '470.80');
  await readBack(b);
  if (spec.channel === 'pull') {
    expect((await sync(b))!.reconcileState).toBe('MISMATCH');
    expect(await openMismatch(b)).toHaveLength(1);
  } else {
    const evs = (await inboundEvents()).slice(seenB);
    expect(
      evs.some(
        (e) =>
          e.status === 'FAILED' &&
          (e.lastError as { code?: string } | null)?.code === 'external_total_mismatch',
      ),
      JSON.stringify(evs.map((e) => [e.status, e.lastError])),
    ).toBe(true);
  }
  const bInv = await api(app, token).get(`/v1/invoices/${b.id}`).expect(200);
  expect(bInv.body.sellTotal).toBe('440.00');
  await spec.reset?.(h);

  // (8) payment pull: ตัดหนี้ครบ → PAID · ซ้ำไม่สร้าง
  const pullPayments = async () => {
    if (spec.channel === 'pull') {
      const run = await api(app, token)
        .post('/v1/reconcile-runs')
        .send({ check: 'PAYMENT_STATUS', connectorId: conId });
      expect(run.status, JSON.stringify(run.body)).toBe(202);
    }
    await settle();
  };
  const payments = () =>
    plat.payment.findMany({
      where: { tenantId, source: 'CONNECTOR', allocations: { some: { invoiceId: a.uuid } } },
    });
  await spec.erpPaid(h, a, { settled: '1000.00', received: '990.00', wht: '10.00', seq: 1 });
  await pullPayments();
  const inv = await api(app, token).get(`/v1/invoices/${a.id}`).expect(200);
  expect(inv.body.status, JSON.stringify(inv.body)).toBe('PAID');
  let pays = await payments();
  expect(pays).toHaveLength(1);
  expect(pays[0]!.amountReceived.toFixed(2)).toBe('990.00');
  expect(pays[0]!.whtAmount.toFixed(2)).toBe('10.00');
  await spec.erpPaid(h, a, { settled: '1000.00', received: '990.00', wht: '10.00', seq: 2 });
  await pullPayments();
  pays = await payments();
  expect(pays).toHaveLength(1);
  // แยก tenant
  expect(
    await db.withTenant(env.otherTenantId, (tx) =>
      tx.payment.count({ where: { id: pays[0]!.id } }),
    ),
  ).toBe(0);
  await api(app, env.otherToken).get(`/v1/invoices/${a.id}`).expect(404);
  return { conId, conUuid };
}
