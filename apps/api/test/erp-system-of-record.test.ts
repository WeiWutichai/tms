import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { ProblemException } from '../src/common/problem';
import { DbService } from '../src/db/db.service';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { SystemOfRecordPolicy } from '../src/modules/erp/system-of-record.policy';
import { FakeErpAdapter, GOOD_KEY } from './fake-erp-adapter';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST7-T17 system-of-record rules ต่อ connector (docs/04 G3; docs/01 §1 ข้อ 4, §8.1; plan/05 D-27)
 * เกณฑ์ตรวจรับ: connector ที่ตั้ง `taxDocumentOwner = ERP` → TMS ไม่ออก `tax_invoice_no`
 * (ยังไม่มีการออกเลขใบกำกับภาษี — ST5-T09 ต้องเรียก SystemOfRecordPolicy.assertCanIssueTaxDocumentNumber; ตรวจที่จุดบังคับใช้นี้)
 */
describe('system-of-record (ST7-T17)', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let db: DbService;
  let policy: SystemOfRecordPolicy;
  const fake = new FakeErpAdapter('sor-erp', ['pushInvoice', 'fetchDocument']);
  /** ST8-T03 แบบ: adapter ประกาศ pushInvoice แต่ยังไม่ได้ทำ */
  const pend = Object.assign(new FakeErpAdapter('sor-pend', ['pushInvoice', 'fetchDocument']), {
    pendingCapabilities: ['pushInvoice'] as const,
  });
  let tenantId: string;
  let token: string;
  let readToken: string;
  let seq = 0;

  async function company(tid = tenantId) {
    const c = await plat.company.create({
      data: {
        tenantId: tid,
        legalName: `บริษัท SoR ${++seq} จำกัด`,
        taxId: validTaxId(9300 + seq),
      },
    });
    await plat.branch.create({
      data: {
        tenantId: tid,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        isDefaultIssuer: true,
        address: { line1: 'x', subdistrict: 'x', district: 'x', province: 'x', postcode: '10000' },
      },
    });
    return { id: c.id, cmp: encodeId('company', c.id) };
  }

  async function connector(body: Record<string, unknown> = {}, tok = token) {
    const r = await api(app, tok)
      .post('/v1/connectors')
      .send({
        adapterKey: fake.key,
        settings: { baseUrl: 'https://erp.example.com/api' },
        credentials: { apiKey: GOOD_KEY },
        ...body,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as {
      id: string;
      version: number;
      capabilitiesEnabled: string[];
      systemOfRecord: Record<string, unknown>;
    };
  }

  /** เปิดใช้ (healthCheck ผ่าน) → ACTIVE */
  const resume = (id: string, tok = token) =>
    api(app, tok).post(`/v1/connectors/${id}/resume`).send({}).expect(200);

  async function command(connectorId: string, status: string, operation = 'PUSH_INVOICE') {
    const cid = tryDecodeId('connector', connectorId)!;
    await plat.integrationOutbox.create({
      data: {
        tenantId,
        kind: 'ADAPTER',
        sink: 'erp',
        targetId: cid,
        operation,
        entityType: 'invoice',
        localId: randomUUID(),
        serializeKey: `erp:${cid}:x`,
        idempotencyKey: `sor-test:${randomUUID()}`,
        status: status as 'DONE',
        nextRunAt: new Date(Date.now() + 3600_000),
        ...(status === 'IN_FLIGHT'
          ? {
              leaseId: randomUUID(),
              leaseUntil: new Date(Date.now() + 300_000),
              claimedAt: new Date(),
            }
          : {}),
      },
    });
  }

  const put = (id: string, body: Record<string, unknown>, version?: number, tok = token) => {
    const req = api(app, tok).put(`/v1/connectors/${id}/system-of-record`);
    if (version !== undefined) req.set('If-Match', `"${version}"`);
    return req.send(body);
  };

  const canIssue = (companyId: string | null, tid = tenantId) =>
    db.withTenant(tid, (tx) => policy.canIssueTaxDocumentNumber(tx, companyId));

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    policy = app.get(SystemOfRecordPolicy);
    app.get(ErpAdapterRegistry).replace(fake);
    app.get(ErpAdapterRegistry).replace(pend);
    tenantId = (await createTenant(plat, 'บริษัท เจ้าของเอกสาร')).id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    const userId = (
      await plat.appUser.create({
        data: { tenantId, email: 'admin@sor.test', name: 'ผู้ดูแล SoR', status: 'ACTIVE' },
      })
    ).id;
    token = await tokenFor(tenantId, '*', userId);
    readToken = await tokenFor(tenantId, 'settings:read', userId);
  });
  beforeEach(async () => {
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
  });
  afterAll(async () => {
    app.get(ErpAdapterRegistry).unregister(fake.key);
    app.get(ErpAdapterRegistry).unregister(pend.key);
    await app.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: taxDocumentOwner = ERP + ใบแจ้งหนี้ไปถึง ERP → TMS ไม่ออกเลขใบกำกับภาษี (409) · TMS / ยกเลิกการเชื่อม → ออกได้', async () => {
    const a = await company();
    // ไม่มี connector = Standalone → TMS เป็นเจ้าของ
    expect(await canIssue(a.id)).toBe(true);
    expect(await canIssue(null)).toBe(true);

    const c = await connector({ companyId: a.cmp, taxDocumentOwner: 'ERP' });
    expect(c.systemOfRecord).toEqual({
      customerOwner: null,
      taxDocumentOwner: 'ERP',
      fieldSync: {
        PRICE: 'AUTO_SYNC',
        DATES: 'AUTO_SYNC',
        ACCESSORIAL: 'AUTO_SYNC',
        CUSTOMER: 'REGENERATE',
      },
    });
    expect(c.capabilitiesEnabled).toContain('pushInvoice');
    // H1 standalone-first: PAUSED ที่ยังไม่เคยเปิดใช้ = ใบแจ้งหนี้ยังไม่ไป ERP → TMS ออกเลขเอง
    expect(await canIssue(a.id)).toBe(true);
    await resume(c.id);
    expect(await canIssue(a.id)).toBe(false);
    const err = await db
      .withTenant(tenantId, (tx) => policy.assertCanIssueTaxDocumentNumber(tx, a.id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).getStatus()).toBe(409);
    expect(JSON.stringify((err as ProblemException).getResponse())).toContain(
      'tax_document_owned_by_erp',
    );
    // หยุดชั่วคราวหลังเคยเปิดใช้ = คิวส่งทีหลัง → ยังเป็น ERP
    await api(app, token).post(`/v1/connectors/${c.id}/pause`).send({}).expect(200);
    expect(await canIssue(a.id)).toBe(false);
    // นิติบุคคลอื่นที่ไม่มี connector (และไม่มี connector ทุกนิติบุคคล) ไม่ได้รับผล
    const b = await company();
    expect(await canIssue(b.id)).toBe(true);

    const eff = await api(app, readToken)
      .get('/v1/connectors/effective')
      .query({ companyId: a.cmp })
      .expect(200);
    expect(eff.body.systemOfRecord).toMatchObject({
      taxDocumentOwner: 'ERP',
      canIssueTaxDocumentNumber: false,
    });

    await put(c.id, { taxDocumentOwner: 'TMS', reason: 'ตกลงกับลูกค้าให้ TMS ออกใบกำกับ' }).expect(
      200,
    );
    expect(await canIssue(a.id)).toBe(true);
    await db.withTenant(tenantId, (tx) => policy.assertCanIssueTaxDocumentNumber(tx, a.id));

    // ยกเลิกการเชื่อม → กลับเป็น Standalone (TMS) แม้ตั้ง ERP ไว้
    await put(c.id, { taxDocumentOwner: 'ERP', reason: 'กลับไปให้ระบบบัญชีออกใบกำกับ' }).expect(
      200,
    );
    expect(await canIssue(a.id)).toBe(false);
    await api(app, token)
      .post(`/v1/connectors/${c.id}/disconnect`)
      .send({ reason: 'เลิกใช้ระบบบัญชีนี้แล้ว' })
      .expect(200);
    expect(await canIssue(a.id)).toBe(true);
  });

  it('H1: ERP แต่ไม่มี pushInvoice / pushInvoice ยังไม่ได้ทำ (pending) / แพ็กเกจไม่มี conn → TMS ออกเลขเอง', async () => {
    // ไม่เปิด pushInvoice
    const a = await company();
    const c1 = await connector({
      companyId: a.cmp,
      taxDocumentOwner: 'ERP',
      capabilitiesEnabled: ['fetchDocument'],
    });
    await resume(c1.id);
    expect(await canIssue(a.id)).toBe(true);

    // adapter ประกาศ pushInvoice แต่ยัง pending (แถวเปิดไว้ก่อน adapter ถูกถอยเป็น pending)
    const b = await company();
    const c2 = await connector({
      adapterKey: pend.key,
      companyId: b.cmp,
      taxDocumentOwner: 'ERP',
      capabilitiesEnabled: ['fetchDocument'],
    });
    await resume(c2.id);
    await plat.connector.update({
      where: { id: tryDecodeId('connector', c2.id)! },
      data: { capabilitiesEnabled: ['pushInvoice', 'fetchDocument'] },
    });
    expect(await canIssue(b.id)).toBe(true);

    // แพ็กเกจไม่มี conn แต่ยังมี connector ค้าง (เคยเปิดใช้ + ERP) → effective standalone (SoR แบบ Standalone TMS/TMS) และ TMS ออกเลขเอง
    const t2 = (await createTenant(plat, 'บริษัท ลดแพ็กเกจ')).id;
    const tok2 = await tokenFor(t2, '*', randomUUID());
    const c3 = await connector({ taxDocumentOwner: 'ERP' }, tok2);
    await resume(c3.id, tok2);
    expect(await canIssue(null, t2)).toBe(false);
    await plat.tenant.update({ where: { id: t2 }, data: { planCode: 'start' } });
    app.get(EntitlementService).invalidate(t2);
    const eff = await api(app, tok2).get('/v1/connectors/effective').expect(200);
    expect(eff.body).toMatchObject({
      standalone: true,
      systemOfRecord: {
        customerOwner: 'TMS',
        taxDocumentOwner: 'TMS',
        canIssueTaxDocumentNumber: true,
      },
    });
    expect(await canIssue(null, t2)).toBe(true);
  });

  it('M1: ยังไม่เลือกเจ้าของเอกสารภาษี (null) → TMS ออกเลข · ค่าเริ่มต้นไม่เปิดส่งเอกสารภาษี · ขอเปิด 422 sor_not_chosen · เลือกแล้วเปิดได้', async () => {
    const a = await company();
    const c = await connector({ companyId: a.cmp });
    expect(c.systemOfRecord).toMatchObject({ customerOwner: null, taxDocumentOwner: null });
    expect(c.capabilitiesEnabled).toEqual(['fetchDocument']);
    await resume(c.id);
    expect(await canIssue(a.id)).toBe(true);
    const r = await api(app, token)
      .patch(`/v1/connectors/${c.id}`)
      .send({ capabilitiesEnabled: ['pushInvoice', 'fetchDocument'] });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe('sor_not_chosen');
    const b = await company();
    const x = await api(app, token)
      .post('/v1/connectors')
      .send({
        adapterKey: fake.key,
        companyId: b.cmp,
        settings: { baseUrl: 'https://erp.example.com/api' },
        credentials: { apiKey: GOOD_KEY },
        capabilitiesEnabled: ['pushInvoice'],
      });
    expect(x.status).toBe(422);
    expect(x.body.code).toBe('sor_not_chosen');

    // เลือกครั้งแรก (มีคำสั่งรอส่งอยู่ก็ไม่ล็อก — ยังไม่มีเอกสารภาษีถูกส่ง) แล้วเปิดได้
    await command(c.id, 'PENDING');
    await put(c.id, { taxDocumentOwner: 'TMS', reason: 'เลือกให้ TMS ออกใบกำกับภาษี' }).expect(200);
    await api(app, token)
      .patch(`/v1/connectors/${c.id}`)
      .send({ capabilitiesEnabled: ['pushInvoice', 'fetchDocument'] })
      .expect(200);
  });

  it('PUT system-of-record: เหตุผลบังคับ · CUSTOMER auto-sync ไม่ได้ · editableUntilPaid ไม่ใช่ค่าตั้ง · If-Match 412 · settings:read 403 · audit · ข้าม tenant 404', async () => {
    const c = await connector();
    const id = c.id;
    const bad = async (body: Record<string, unknown>, field: string) => {
      const r = await put(id, { reason: 'ทดสอบค่าที่ไม่ถูกต้อง', ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.errors[0].field).toBe(field);
    };
    expect((await put(id, { taxDocumentOwner: 'TMS' })).status).toBe(422);
    expect((await put(id, { taxDocumentOwner: 'TMS', reason: 'สั้น' })).status).toBe(422);
    await bad({ taxDocumentOwner: 'KRS' }, 'taxDocumentOwner');
    await bad({ taxDocumentOwner: null }, 'taxDocumentOwner');
    await bad({ fieldSync: { CUSTOMER: 'AUTO_SYNC' } }, 'fieldSync.CUSTOMER');
    await bad({ fieldSync: { TAX: 'AUTO_SYNC' } }, 'fieldSync.TAX');
    await bad({ fieldSync: { PRICE: 'SOMETIMES' } }, 'fieldSync.PRICE');
    // "แก้ได้จนรับชำระ" เป็นกฎ (docs/04 G3) — ปิดไม่ได้
    expect((await put(id, { editableUntilPaid: false, reason: 'พยายามปิดกฎรับชำระ' })).status).toBe(
      422,
    );
    expect(
      (await put(id, { taxDocumentOwner: 'TMS', reason: 'เหตุผลยาวพอสมควร' }, 99)).status,
    ).toBe(412);
    expect(
      (await put(id, { taxDocumentOwner: 'TMS', reason: 'เหตุผลยาวพอสมควร' }, undefined, readToken))
        .status,
    ).toBe(403);

    const r = await put(
      id,
      {
        customerOwner: 'TMS',
        taxDocumentOwner: 'ERP',
        fieldSync: { PRICE: 'REGENERATE' },
        reason: 'ตามตารางตกลงกับลูกค้า ข้อ 3',
      },
      c.version,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.systemOfRecord).toEqual({
      customerOwner: 'TMS',
      taxDocumentOwner: 'ERP',
      fieldSync: {
        PRICE: 'REGENERATE',
        DATES: 'AUTO_SYNC',
        ACCESSORIAL: 'AUTO_SYNC',
        CUSTOMER: 'REGENERATE',
      },
    });
    // ส่งกลุ่มเดียวไม่ล้างกลุ่มอื่น
    const r2 = await put(id, { fieldSync: { DATES: 'REGENERATE' }, reason: 'วันที่ต้องออกใบใหม่' });
    expect(r2.body.systemOfRecord.fieldSync).toMatchObject({
      PRICE: 'REGENERATE',
      DATES: 'REGENERATE',
    });
    // ไม่เปลี่ยนอะไร = ไม่เพิ่ม version ไม่ลง audit
    const same = await put(id, { customerOwner: 'TMS', reason: 'ค่าเดิมไม่มีอะไรเปลี่ยน' });
    expect(same.body.version).toBe(r2.body.version);

    const audits = await plat.auditLog.findMany({
      where: {
        entityType: 'connector',
        action: 'connector.sor_changed',
        entityId: tryDecodeId('connector', id)!,
      },
      orderBy: { seq: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits[0]!.reason).toBe('ตามตารางตกลงกับลูกค้า ข้อ 3');
    expect(audits[0]!.before).toMatchObject({ customerOwner: null, taxDocumentOwner: null });
    expect(audits[0]!.after).toMatchObject({ customerOwner: 'TMS', taxDocumentOwner: 'ERP' });

    // ข้าม tenant = 404
    const t2 = (await createTenant(plat, 'บริษัท อื่น SoR')).id;
    await plat.tenant.update({ where: { id: t2 }, data: { planCode: 'ent' } });
    const tok2 = await tokenFor(t2, '*', randomUUID());
    expect(
      (await put(id, { customerOwner: 'ERP', reason: 'ข้าม tenant ห้ามเห็น' }, undefined, tok2))
        .status,
    ).toBe(404);
  });

  it('M3: มีคำสั่งส่งเอกสารที่ส่งแล้ว/รอส่ง/กำลังส่ง → เปลี่ยนเจ้าของไม่ได้ (409 sor_locked) · FAILED_FINAL/SKIPPED ไม่ล็อก · กลุ่ม field ยังเปลี่ยนได้', async () => {
    for (const st of ['DONE', 'PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE']) {
      await plat.connector.updateMany({
        where: { status: { not: 'DISCONNECTED' } },
        data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
      });
      const c = await connector({ taxDocumentOwner: 'ERP' });
      await command(c.id, st, st === 'PENDING' ? 'REPLACE_DOCUMENT' : 'PUSH_INVOICE');
      const r = await put(c.id, { taxDocumentOwner: 'TMS', reason: 'เปลี่ยนหลังส่งเอกสารแล้ว' });
      expect(r.status, st).toBe(409);
      expect(r.body.code).toBe('sor_locked');
      await put(c.id, { fieldSync: { PRICE: 'REGENERATE' }, reason: 'ราคาต้องออกใบใหม่' }).expect(
        200,
      );
    }
    await plat.connector.updateMany({
      where: { status: { not: 'DISCONNECTED' } },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
    });
    const c = await connector({ taxDocumentOwner: 'ERP', customerOwner: 'ERP' });
    await command(c.id, 'FAILED_FINAL');
    await command(c.id, 'SKIPPED');
    await command(c.id, 'DONE', 'FETCH_DOCUMENT');
    await put(c.id, { customerOwner: 'TMS', reason: 'ไม่มีเอกสารที่ส่งสำเร็จ' }).expect(200);
  });

  it('fieldChangePolicy ผ่าน connector: Standalone = LOCAL · ส่งใบแจ้งหนี้ = ตามกลุ่ม · รับชำระแล้ว = BLOCKED', async () => {
    const a = await company();
    const f = (group: 'PRICE' | 'CUSTOMER', status: string | null, inErp?: boolean) =>
      db.withTenant(tenantId, (tx) => policy.fieldChangePolicy(tx, a.id, group, status, inErp));
    expect(await f('PRICE', 'ISSUED')).toEqual({ mode: 'LOCAL' });
    const c = await connector({
      companyId: a.cmp,
      taxDocumentOwner: 'TMS',
      capabilitiesEnabled: ['pushInvoice'],
    });
    await resume(c.id);
    expect(await f('PRICE', 'ISSUED')).toEqual({ mode: 'AUTO_SYNC' });
    expect(await f('PRICE', 'ISSUED', false)).toEqual({ mode: 'LOCAL' }); // ใบนั้นยังไม่อยู่ใน ERP
    expect(await f('CUSTOMER', 'ISSUED')).toEqual({ mode: 'REGENERATE' });
    expect(await f('PRICE', 'PARTIALLY_PAID')).toEqual({ mode: 'BLOCKED', code: 'paid_locked' });
  });
});
