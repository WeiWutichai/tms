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
