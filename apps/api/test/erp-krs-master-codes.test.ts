import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import type { ErpCapability } from '@tms/domain';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { ConnectorsService } from '../src/modules/erp/connectors.service';
import {
  KRS_REQUIRED_UNITS,
  KRS_SAMPLE_MASTER_CODES,
  krsMasterCodeRefs,
  krsPushReadiness,
} from '../src/erp-adapters/krs/krs-master-codes';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import {
  type CanonicalDocument,
  type CanonicalInvoice,
  type ErpContext,
  type ExternalRef,
  type HealthResult,
  type PushResult,
  resolvedMasterCode,
  resolvedMasterCodeName,
} from '../src/modules/erp/erp-adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { ERP_SINK } from '../src/modules/erp/erp-adapter.sink';
import { ErpMasterCodesService } from '../src/modules/erp/erp-master-codes.service';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { OutboxService } from '../src/modules/integration/outbox.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * ST8-T06 รหัส master ของ KRS → `erp_master_code` (docs/01 A.3; docs/04 B ผังรหัส ERP ส่วน KRS)
 * เกณฑ์ตรวจรับ: หน่วย "เที่ยว/ตัน/กม." map ครบ · ค่าที่ไม่มีใน master ถูกกันก่อนส่งเข้า KRS
 */

const SAMPLE_CSV = join(__dirname, '../src/erp-adapters/krs/krs-master-codes.sample.csv');

const line = (unitLabel: string | null, extra: Record<string, unknown> = {}) => ({
  unitLabel,
  ...extra,
});

describe('krsMasterCodeRefs (ST8-T06) — ไม่แตะฐานข้อมูล', () => {
  const ctx = { config: { salePerson: 'S01' } };
  const doc = {
    id: 'i1',
    number: 'INV-1',
    customer: { externalId: 'C-001' },
    lines: [
      line('เที่ยว', { serviceItem: { id: 'x', externalId: 'IT-1' }, accountCode: '4100' }),
      line(null),
    ],
  };

  it('ใบแจ้งหนี้: รหัสลูกค้า + พนักงานขาย + หน่วยทุกรายการ (บังคับ; หน่วยหาด้วยชื่อได้) · itemCode/accountCode (ไม่บังคับ)', () => {
    const refs = krsMasterCodeRefs(ctx, 'PUSH_INVOICE', doc);
    expect(refs).toEqual([
      { kind: 'CUSTOMER', value: 'C-001', field: 'custOrSuppCode', strict: true },
      { kind: 'SALESPERSON', value: 'S01', field: 'salePerson', strict: true },
      {
        kind: 'UNIT',
        value: 'เที่ยว',
        field: 'lines[0].unitLabel',
        strict: true,
        matchByName: true,
      },
      { kind: 'ITEM', value: 'IT-1', field: 'lines[0].serviceItem.externalId', strict: false },
      { kind: 'ACCOUNT', value: '4100', field: 'lines[0].accountCode', strict: false },
      { kind: 'UNIT', value: null, field: 'lines[1].unitLabel', strict: true, matchByName: true },
      { kind: 'ITEM', value: null, field: 'lines[1].serviceItem.externalId', strict: false },
      { kind: 'ACCOUNT', value: null, field: 'lines[1].accountCode', strict: false },
    ]);
    // REPLACE_DOCUMENT (PUT /invoice) ตรวจเหมือนกัน · พนักงานขายในเอกสารมาก่อนค่าตั้ง
    expect(
      krsMasterCodeRefs(ctx, 'REPLACE_DOCUMENT', { ...doc, salePerson: 'S09' })[1],
    ).toMatchObject({ kind: 'SALESPERSON', value: 'S09' });
  });

  it('คำสั่งที่ไม่ส่งใบ (FETCH_*) = ไม่มีค่าให้ตรวจ · ไม่มีลูกค้า/ค่าตั้งพนักงานขาย = null', () => {
    expect(krsMasterCodeRefs(ctx, 'FETCH_DOCUMENT', doc)).toEqual([]);
    expect(krsMasterCodeRefs({ config: {} }, 'PUSH_INVOICE', { id: 'i', number: 'n' })).toEqual([
      { kind: 'CUSTOMER', value: null, field: 'custOrSuppCode', strict: true },
      { kind: 'SALESPERSON', value: null, field: 'salePerson', strict: true },
    ]);
  });

  it('ความพร้อมก่อนเปิดส่งใบ: พนักงานขายจากค่าตั้ง + ผังหน่วย', () => {
    expect(krsPushReadiness({ config: { salePerson: ' S01 ' } })).toEqual({
      refs: [{ kind: 'SALESPERSON', value: 'S01', field: 'salePerson', strict: true }],
      catalogues: ['UNIT'],
    });
  });

  it('ไฟล์ตัวอย่าง CSV ตรงกับ KRS_SAMPLE_MASTER_CODES · หน่วยตาม docs/01 A.3 ครบ · รหัสอื่นติดป้าย SAMPLE-', () => {
    const KIND: Record<string, string> = {
      หน่วย: 'UNIT',
      พนักงานขาย: 'SALESPERSON',
      'รหัสสินค้า/บริการ': 'ITEM',
      ผังบัญชี: 'ACCOUNT',
    };
    const rows = readFileSync(SAMPLE_CSV, 'utf8').trim().split('\n').slice(1);
    const fromCsv = rows.map((r) => {
      const [con, kind, code, name] = r.split(',');
      expect(con).toBe('krs');
      return `${KIND[kind!]}:${code}:${name}`;
    });
    const fromTs = Object.entries(KRS_SAMPLE_MASTER_CODES).flatMap(([k, list]) =>
      list!.map((e) => `${k}:${e.code}:${e.name}`),
    );
    expect(fromCsv.sort()).toEqual(fromTs.sort());
    expect(KRS_SAMPLE_MASTER_CODES.UNIT!.map((u) => u.code)).toEqual([...KRS_REQUIRED_UNITS]);
    for (const [k, list] of Object.entries(KRS_SAMPLE_MASTER_CODES))
      if (k !== 'UNIT') for (const e of list!) expect(e.code).toMatch(/^SAMPLE-/);
  });
});

/** KrsAdapter ที่ "ส่งได้แล้ว" สำหรับ test เส้นทางคิว (pushInvoice จริงทำใน ST8-T08) — จด ctx ที่ core ส่งมา */
class ReadyKrs extends KrsAdapter {
  override readonly pendingCapabilities: readonly ErpCapability[] = [];
  pushed: { doc: CanonicalInvoice; ctx: ErpContext }[] = [];
  override async healthCheck(): Promise<HealthResult> {
    return { ok: true };
  }
  override async pushInvoice(ctx: ErpContext, doc: CanonicalInvoice): Promise<PushResult> {
    this.pushed.push({ doc, ctx });
    return { ok: true, externalId: `T-${this.pushed.length}`, externalDocNo: 'SA-S6911-0001' };
  }
  override async replaceDocument(
    ctx: ErpContext,
    _ref: ExternalRef,
    doc: CanonicalInvoice,
  ): Promise<PushResult> {
    this.pushed.push({ doc, ctx });
    return { ok: true, externalId: `T-${this.pushed.length}` };
  }
  override async fetchDocument(): Promise<CanonicalDocument | null> {
    this.fetched++;
    return null;
  }
  fetched = 0;
}

describe('ผังรหัส KRS + ประตูก่อนส่ง (ST8-T06)', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let db: DbService;
  let dispatcher: OutboxDispatcher;
  let reg: ErpAdapterRegistry;
  let original: KrsAdapter;
  let ready: ReadyKrs;
  let tenantId: string;
  let token: string;
  let freight: string;

  const uuid = (id: string) => tryDecodeId('connector', id)!;
  const drain = async () => {
    await plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                      WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    await dispatcher.drain();
  };
  const cmd = (id: string) => plat.integrationOutbox.findUniqueOrThrow({ where: { id } });

  async function krsConnector(settings: Record<string, string> = {}) {
    const r = await api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'krs',
        settings: { baseUrl: 'https://krs.example.com/api', ...settings },
        credentials: { apiKey: 'krs-key-0123456789' },
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }

  async function importCsv(csv: string) {
    const buf = Buffer.from(csv, 'utf8');
    const a = api(app, token);
    const doc = await a
      .post('/v1/documents')
      .send({ kind: 'IMPORT', mime: 'text/csv', bytes: buf.length, filename: 'krs-codes.csv' })
      .expect(201);
    const u = new URL(doc.body.uploadUrl);
    await request(app.getHttpServer())
      .put(u.pathname + u.search)
      .set('Content-Type', 'application/octet-stream')
      .send(buf)
      .expect(200);
    const imp = await a
      .post('/v1/imports')
      .send({ kind: 'erp_master_code', documentId: doc.body.id });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    expect(imp.body.issues, JSON.stringify(imp.body.issues)).toEqual([]);
    const c = await a.post(`/v1/imports/${imp.body.id}/commit`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
  }

  async function enqueue(
    connectorId: string,
    payload: Record<string, unknown>,
    operation = 'PUSH_INVOICE',
  ) {
    const id = randomUUID();
    const { id: cmdId } = await db.withTenant(tenantId, (tx) =>
      app.get(OutboxService).enqueueCommand(tx, {
        tenantId,
        kind: 'ADAPTER',
        sink: ERP_SINK,
        targetId: uuid(connectorId),
        operation,
        entityType: 'invoice',
        localId: id,
        payload,
      }),
    );
    return cmdId;
  }
  const invoice = (lines: Record<string, unknown>[], customer: string | null = 'C-001') => {
    const id = randomUUID();
    return {
      id,
      number: `INV-T06-${id.slice(0, 6)}`,
      ...(customer ? { customer: { externalId: customer } } : {}),
      lines,
    };
  };
  const enqueueInvoice = (connectorId: string, lines: Record<string, unknown>[]) =>
    enqueue(connectorId, { document: invoice(lines) });
  const readyConnector = async (salePerson = 'S01') => {
    ready = new ReadyKrs();
    reg.replace(ready);
    const con = await krsConnector({ salePerson });
    await api(app, token).post(`/v1/connectors/${con}/resume`).send({}).expect(200);
    // connector ใหม่ไม่เปิดส่งเอกสารจนกว่าผังรหัสพร้อม — test ประตูก่อนส่งจึงเปิดตรงในฐาน (เทียบเท่าเปิดไว้ก่อนผังเปลี่ยน)
    await plat.connector.update({
      where: { id: uuid(con) },
      data: {
        capabilitiesEnabled: [
          'pullOrders',
          'pushInvoice',
          'fetchDocument',
          'replaceDocument',
          'ownsDocumentNumber',
        ],
      },
    });
    return con;
  };
  const header = 'ระบบบัญชี,ชนิดรหัส,รหัส,ชื่อ,อัตรา (%),ใช้งาน';
  type Missing = { kind: string; value: string | null; status: string; fields: string[] }[];

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    dispatcher = app.get(OutboxDispatcher);
    reg = app.get(ErpAdapterRegistry);
    original = reg.get('krs') as KrsAdapter;
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ผังรหัส KRS จำกัด' })).id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    token = await tokenFor(tenantId);
    const s = await plat.serviceItem.create({
      data: {
        tenantId,
        code: 'T06-FRT',
        nameTh: 'ค่าขนส่งทดสอบ KRS',
        vatType: 'EXEMPT_TRANSPORT',
        whtRate: '1.00',
        calcUnit: 'PER_TRIP',
        unitLabel: 'เที่ยว',
        side: 'SELL',
      },
    });
    freight = encodeId('serviceItem', s.id);
  });
  beforeEach(async () => {
    reg.replace(original);
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
  });
  afterAll(async () => {
    reg.replace(original);
    await app.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: นำเข้าไฟล์ตัวอย่างของ KRS → หน่วย เที่ยว/ตัน/กม. หาเจอครบ · ก่อนนำเข้า = ยังไม่มีผัง (ถูกกัน)', async () => {
    const con = await krsConnector({ salePerson: 'SAMPLE-S01' });
    const svc = app.get(ErpMasterCodesService);
    const doc = invoice(KRS_REQUIRED_UNITS.map((u) => line(u)));
    const prep = () =>
      db.withTenant(tenantId, async (tx) => {
        const c = await tx.connector.findUniqueOrThrow({ where: { id: uuid(con) } });
        const ctx = app.get(ConnectorsService).contextOf(c);
        return svc.prepareForPush(tx, c.id, original, ctx, 'PUSH_INVOICE', doc);
      });

    const before = await prep();
    expect(before.ok).toBe(false);
    if (!before.ok)
      expect(before.problem).toMatchObject({
        code: 'erp_master_code_unknown',
        link: `/settings?sec=conn&connector=${con}`,
        missing: expect.arrayContaining([
          expect.objectContaining({ kind: 'SALESPERSON', status: 'NO_CATALOGUE' }),
          expect.objectContaining({ kind: 'UNIT', value: 'เที่ยว', status: 'NO_CATALOGUE' }),
        ]),
      });

    await importCsv(readFileSync(SAMPLE_CSV, 'utf8'));
    const rows = (await api(app, token).get(`/v1/connectors/${con}/master-codes`).expect(200)).body
      .data as { kind: string; code: string; source: string }[];
    expect(
      rows
        .filter((r) => r.kind === 'UNIT')
        .map((r) => r.code)
        .sort(),
    ).toEqual([...KRS_REQUIRED_UNITS].sort());
    expect(rows.every((r) => r.source === 'IMPORT')).toBe(true);

    const after = await prep();
    expect(after.ok, JSON.stringify(after)).toBe(true);
    if (after.ok) {
      for (const u of KRS_REQUIRED_UNITS)
        expect(resolvedMasterCode({ masterCodes: after.masterCodes }, 'UNIT', u)).toBe(u);
      const m = { masterCodes: after.masterCodes };
      expect(resolvedMasterCode(m, 'SALESPERSON', 'SAMPLE-S01')).toBe('SAMPLE-S01');
      // saleName ของ KRS = ชื่อของรหัสพนักงานขายในผัง
      expect(resolvedMasterCodeName(m, 'SALESPERSON', 'SAMPLE-S01')).toBe(
        'ตัวอย่าง — รอรายการจริงจาก KRS',
      );
      expect(resolvedMasterCode(m, 'CUSTOMER', 'C-001')).toBe('C-001');
    }
  });

  it('เกณฑ์ตรวจรับ: ค่าที่ไม่มีใน master → คำสั่งส่งใบ FAILED_FINAL (VALIDATION) ไม่ถึง KRS · ครบ → ส่งพร้อมรหัสที่หาได้', async () => {
    const con = await readyConnector('S-NOPE');
    // KRS ใช้รหัสหน่วยของตัวเอง (ชื่อ = ข้อความหน่วยของ TMS) — หาได้ด้วยชื่อ
    await importCsv(
      [
        header,
        `${con},หน่วย,U-TRIP,เที่ยว,,`,
        `${con},หน่วย,U-TON,ตัน,,`,
        `${con},หน่วย,U-KM,กม.,,`,
        `${con},พนักงานขาย,S01,พนักงานขาย ทดสอบ,,`,
        `${con},รหัสสินค้า/บริการ,IT-FRT,ค่าขนส่ง,,`,
        `${con},ผังบัญชี,4100,รายได้ค่าขนส่ง,,ไม่`,
      ].join('\n'),
    );
    await api(app, token)
      .put(`/v1/connectors/${con}/mappings/${freight}`)
      .send({ itemCode: 'IT-FRT' })
      .expect(200);

    // พนักงานขายไม่อยู่ในผัง + หน่วย "ชั่วโมง" ไม่อยู่ในผัง + บัญชีที่ปิดใช้แล้ว
    const blocked = await enqueueInvoice(con, [
      line('เที่ยว', { serviceItem: { id: freight } }),
      line('ชั่วโมง', { serviceItem: { id: freight } }),
      line('ชั่วโมง', { serviceItem: { id: freight }, accountCode: '4100' }),
    ]);
    await drain();
    const b = await cmd(blocked);
    expect(b).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    expect(b.lastError).toMatchObject({
      code: 'erp_master_code_unknown',
      link: `/settings?sec=conn&connector=${con}`,
    });
    expect((b.lastError as { missing: Missing }).missing).toEqual([
      { kind: 'SALESPERSON', value: 'S-NOPE', fields: ['salePerson'], status: 'UNKNOWN' },
      {
        kind: 'UNIT',
        value: 'ชั่วโมง',
        fields: ['lines[1].unitLabel', 'lines[2].unitLabel'],
        status: 'UNKNOWN',
      },
      { kind: 'ACCOUNT', value: '4100', fields: ['lines[2].accountCode'], status: 'UNKNOWN' },
    ]);
    const msg = String((b.lastError as { message: string }).message);
    expect(msg).toContain('หน่วย "ชั่วโมง"');
    expect(msg).not.toContain('undefined');
    expect(ready.pushed).toHaveLength(0); // ไม่ถึง KRS

    await api(app, token)
      .patch(`/v1/connectors/${con}`)
      .send({ settings: { baseUrl: 'https://krs.example.com/api', salePerson: 'S01' } })
      .expect(200);
    const ok = await enqueueInvoice(con, [
      line('เที่ยว', { serviceItem: { id: freight } }),
      line('ตัน', { serviceItem: { id: freight } }),
      line('กม.', { serviceItem: { id: freight } }),
    ]);
    await drain();
    const o = await cmd(ok);
    expect(o.status, JSON.stringify(o.lastError)).toBe('DONE');
    expect(ready.pushed).toHaveLength(1);
    const sent = ready.pushed[0]!;
    const units = (sent.doc as unknown as { lines: { unitLabel: string }[] }).lines.map((l) =>
      resolvedMasterCode(sent.ctx, 'UNIT', l.unitLabel),
    );
    expect(units).toEqual(['U-TRIP', 'U-TON', 'U-KM']);
    expect(resolvedMasterCode(sent.ctx, 'SALESPERSON', sent.ctx.config.salePerson)).toBe('S01');
    expect(resolvedMasterCodeName(sent.ctx, 'SALESPERSON', 'S01')).toBe('พนักงานขาย ทดสอบ');
    expect(
      (sent.doc as unknown as { lines: { serviceItem: { externalId: string } }[] }).lines[0]!
        .serviceItem.externalId,
    ).toBe('IT-FRT');
  });

  it('M1 ไม่มีรหัสลูกค้าฝั่ง ERP → กัน (CUSTOMER MISSING) · พนักงานขาย "ชื่อ" ไม่ใช่รหัส → ไม่รับ (ตรงรหัสเท่านั้น) · ชื่อหน่วยซ้ำ → AMBIGUOUS', async () => {
    const con = await readyConnector('พนักงานขาย ทดสอบ');
    await importCsv(
      [
        header,
        `${con},หน่วย,U-TRIP,เที่ยว,,`,
        `${con},หน่วย,U-TRIP2,เที่ยว,,`,
        `${con},พนักงานขาย,S01,พนักงานขาย ทดสอบ,,`,
      ].join('\n'),
    );
    const id = await enqueue(con, { document: invoice([line('เที่ยว')], null) });
    await drain();
    const c = await cmd(id);
    expect(c).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'VALIDATION' });
    expect((c.lastError as { missing: Missing }).missing).toEqual([
      { kind: 'CUSTOMER', value: null, fields: ['custOrSuppCode'], status: 'MISSING' },
      {
        kind: 'SALESPERSON',
        value: 'พนักงานขาย ทดสอบ',
        fields: ['salePerson'],
        status: 'UNKNOWN',
      },
      { kind: 'UNIT', value: 'เที่ยว', fields: ['lines[0].unitLabel'], status: 'AMBIGUOUS' },
    ]);
    expect(String((c.lastError as { message: string }).message)).toContain(
      'ไม่ได้ระบุรหัสลูกค้าในระบบบัญชี',
    );
    expect(ready.pushed).toHaveLength(0);
  });

  it('ช่องไม่บังคับที่ยังไม่มีผัง = ใช้ค่าดิบ · ผังรหัสแยกต่อ connector (A ไม่ปนกับ B) · FETCH ไม่ถูกตรวจ', async () => {
    const a = await readyConnector();
    await importCsv([header, `${a},หน่วย,เที่ยว,,,`, `${a},พนักงานขาย,S01,,,`].join('\n'));
    const ok = await enqueueInvoice(a, [line('เที่ยว', { accountCode: 'ACC-RAW' })]);
    await drain();
    expect((await cmd(ok)).status).toBe('DONE');
    const ctx = ready.pushed[0]!.ctx;
    expect(resolvedMasterCode(ctx, 'ACCOUNT', 'ACC-RAW')).toBe('ACC-RAW');
    expect(resolvedMasterCodeName(ctx, 'ACCOUNT', 'ACC-RAW')).toBeNull();

    // FETCH_DOCUMENT ไม่มีเอกสารให้ตรวจ — ไม่ถูกกัน
    const f = await enqueue(
      a,
      { ref: { entityType: 'invoice', localId: 'x', number: 'INV-X', externalId: 'T-1' } },
      'FETCH_DOCUMENT',
    );
    await drain();
    expect((await cmd(f)).status).toBe('DONE');
    expect(ready.fetched).toBe(1);

    // connector B ในบริษัทเดียวกัน (หลังยกเลิก A) ไม่เห็นผังรหัสของ A
    await plat.connector.update({
      where: { id: uuid(a) },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
    const bCon = await readyConnector();
    const blocked = await enqueueInvoice(bCon, [line('เที่ยว')]);
    await drain();
    expect((await cmd(blocked)).lastError).toMatchObject({
      code: 'erp_master_code_unknown',
      missing: expect.arrayContaining([
        expect.objectContaining({ kind: 'UNIT', status: 'NO_CATALOGUE' }),
      ]),
    });
  });

  it('REPLACE_DOCUMENT ผ่านคิว: ไม่มี ref → invalid_payload · ค่านอกผัง → กัน · ครบ → ส่ง PUT', async () => {
    const con = await readyConnector();
    await importCsv([header, `${con},หน่วย,ตัน,,,`, `${con},พนักงานขาย,S01,,,`].join('\n'));
    const ref = { entityType: 'invoice', localId: 'x', number: 'INV-X', externalId: 'T-9' };
    const noRef = await enqueue(con, { document: invoice([line('ตัน')]) }, 'REPLACE_DOCUMENT');
    const bad = await enqueue(con, { ref, document: invoice([line('กม.')]) }, 'REPLACE_DOCUMENT');
    const good = await enqueue(con, { ref, document: invoice([line('ตัน')]) }, 'REPLACE_DOCUMENT');
    await drain();
    expect((await cmd(noRef)).lastError).toMatchObject({ code: 'invalid_payload' });
    expect((await cmd(bad)).lastError).toMatchObject({
      code: 'erp_master_code_unknown',
      missing: [{ kind: 'UNIT', value: 'กม.', status: 'UNKNOWN' }],
    });
    expect((await cmd(good)).status).toBe('DONE');
    expect(ready.pushed).toHaveLength(1);
  });

  it('M3 เปิดส่งใบเพิ่มต้องพร้อมผังรหัส (422) · บันทึกค่าตั้งอื่นได้เสมอ · ผลทดสอบการเชื่อมต่อแสดงสิ่งที่ยังไม่พร้อม', async () => {
    const con = await readyConnector('S01');
    const h0 = await api(app, token).post(`/v1/connectors/${con}/health`).send({}).expect(200);
    expect(h0.body.ok).toBe(true);
    expect(h0.body.masterCodeGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'SALESPERSON', value: 'S01', status: 'NO_CATALOGUE' }),
        expect.objectContaining({ kind: 'UNIT', value: null, status: 'NO_CATALOGUE' }),
      ]),
    );
    // ปิด แล้วขอเปิดใหม่ตอนยังไม่มีผัง → 422
    await api(app, token)
      .patch(`/v1/connectors/${con}`)
      .send({ capabilitiesEnabled: [] })
      .expect(200);
    const no = await api(app, token)
      .patch(`/v1/connectors/${con}`)
      .send({ capabilitiesEnabled: ['pushInvoice'] });
    expect(no.status).toBe(422);
    expect(no.body.errors[0]).toMatchObject({
      field: 'capabilitiesEnabled',
      code: 'erp_master_codes_not_ready',
    });
    // ค่าตั้งอื่นยังบันทึกได้
    await api(app, token)
      .patch(`/v1/connectors/${con}`)
      .send({ settings: { baseUrl: 'https://krs.example.com/api', salePerson: 'S01' } })
      .expect(200);
    await importCsv([header, `${con},หน่วย,เที่ยว,,,`, `${con},พนักงานขาย,S01,,,`].join('\n'));
    await api(app, token)
      .patch(`/v1/connectors/${con}`)
      .send({ capabilitiesEnabled: ['pushInvoice'] })
      .expect(200);
    const h1 = await api(app, token).post(`/v1/connectors/${con}/health`).send({}).expect(200);
    expect(h1.body.masterCodeGaps).toEqual([]);
  });

  it('Low-1 สร้าง connector: ค่าเริ่มต้นไม่เปิด capability ส่งเอกสารที่ผังรหัสยังไม่พร้อม (ที่เหลือเปิดตามเดิม)', async () => {
    ready = new ReadyKrs();
    reg.replace(ready);
    const r = await api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'krs',
        settings: { baseUrl: 'https://krs.example.com/api', salePerson: 'S01' },
        credentials: { apiKey: 'krs-key-0123456789' },
      })
      .expect(201);
    expect(r.body.capabilitiesEnabled).toEqual([
      'pullOrders',
      'fetchDocument',
      'ownsDocumentNumber',
    ]);
    expect(r.body.capabilitiesEnabled).not.toContain('pushInvoice');
  });

  it('Low-1 สร้าง connector โดยขอเปิดส่งใบชัด ๆ ตอนผังรหัสยังไม่พร้อม → 422 erp_master_codes_not_ready (ไม่สร้าง)', async () => {
    ready = new ReadyKrs();
    reg.replace(ready);
    const before = await plat.connector.count({ where: { tenantId } });
    const r = await api(app, token)
      .post('/v1/connectors')
      .send({
        taxDocumentOwner: 'TMS',
        adapterKey: 'krs',
        settings: { baseUrl: 'https://krs.example.com/api', salePerson: 'S01' },
        credentials: { apiKey: 'krs-key-0123456789' },
        capabilitiesEnabled: ['pushInvoice'],
      });
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toMatchObject({
      field: 'capabilitiesEnabled',
      code: 'erp_master_codes_not_ready',
    });
    expect(await plat.connector.count({ where: { tenantId } })).toBe(before);
  });
});
