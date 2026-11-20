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
    return r.body as { id: string; version: number; systemOfRecord: Record<string, unknown> };
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
    await app.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: taxDocumentOwner = ERP → TMS ไม่ออกเลขใบกำกับภาษี (409 tax_document_owned_by_erp) · TMS → ออกได้ · Standalone → ออกได้', async () => {
    const a = await company();
    // ไม่มี connector = Standalone → TMS เป็นเจ้าของ
    expect(await canIssue(a.id)).toBe(true);
    expect(await canIssue(null)).toBe(true);

    const c = await connector({ companyId: a.cmp });
    expect(c.systemOfRecord).toEqual({
      customerOwner: 'ERP',
      taxDocumentOwner: 'ERP',
      fieldSync: {
        PRICE: 'AUTO_SYNC',
        DATES: 'AUTO_SYNC',
        ACCESSORIAL: 'AUTO_SYNC',
        CUSTOMER: 'REGENERATE',
      },
      editableUntilPaid: true,
    });
    // connector PAUSED (ยังไม่เปิดใช้) ก็ยังเป็นเจ้าของเอกสารภาษี — กันใบกำกับภาษีซ้ำสองชุด
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

    const r = await put(
      c.id,
      { taxDocumentOwner: 'TMS', reason: 'ตกลงกับลูกค้าให้ TMS ออกใบกำกับ' },
      c.version,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.systemOfRecord.taxDocumentOwner).toBe('TMS');
    expect(r.body.version).toBe(c.version + 1);
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

  it('connector ทุกนิติบุคคลใช้กับนิติบุคคลที่ไม่มีของตัวเอง · แพ็กเกจปิดการเชื่อมต่อยังใช้กฎของ connector (effective)', async () => {
    const a = await company();
    const b = await company();
    await connector(); // ทุกนิติบุคคล — ERP
    const own = await connector({ companyId: b.cmp });
    await put(own.id, { taxDocumentOwner: 'TMS', reason: 'บริษัท B ออกใบกำกับจาก TMS' }).expect(
      200,
    );
    expect(await canIssue(a.id)).toBe(false);
    expect(await canIssue(b.id)).toBe(true);
    expect(await canIssue(null)).toBe(false);

    // tenant แพ็กเกจไม่มี conn แต่ยังมี connector ค้าง → effective standalone แต่ไม่ออกใบกำกับภาษีเอง
    const t2 = (await createTenant(plat, 'บริษัท ลดแพ็กเกจ')).id;
    const tok2 = await tokenFor(t2, '*', randomUUID());
    await connector({}, tok2);
    await plat.tenant.update({ where: { id: t2 }, data: { planCode: 'start' } });
    app.get(EntitlementService).invalidate(t2);
    const eff = await api(app, tok2).get('/v1/connectors/effective').expect(200);
    expect(eff.body).toMatchObject({
      standalone: true,
      systemOfRecord: { taxDocumentOwner: 'ERP', canIssueTaxDocumentNumber: false },
    });
    expect(await canIssue(null, t2)).toBe(false);
  });

  it('PUT system-of-record: เหตุผลบังคับ · CUSTOMER auto-sync ไม่ได้ · กลุ่มไม่รู้จัก 422 · If-Match 412 · settings:read 403 · audit + เหตุผล · ข้าม tenant 404', async () => {
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
    await bad({ fieldSync: { CUSTOMER: 'AUTO_SYNC' } }, 'fieldSync.CUSTOMER');
    await bad({ fieldSync: { TAX: 'AUTO_SYNC' } }, 'fieldSync.TAX');
    await bad({ fieldSync: { PRICE: 'SOMETIMES' } }, 'fieldSync.PRICE');
    await bad({ editableUntilPaid: 'yes' }, 'editableUntilPaid');
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
        fieldSync: { PRICE: 'REGENERATE' },
        editableUntilPaid: false,
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
      editableUntilPaid: false,
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
    expect(audits[0]!.before).toMatchObject({ customerOwner: 'ERP', editableUntilPaid: true });
    expect(audits[0]!.after).toMatchObject({ customerOwner: 'TMS', editableUntilPaid: false });

    // ข้าม tenant = 404
    const t2 = (await createTenant(plat, 'บริษัท อื่น SoR')).id;
    await plat.tenant.update({ where: { id: t2 }, data: { planCode: 'ent' } });
    const tok2 = await tokenFor(t2, '*', randomUUID());
    expect(
      (await put(id, { customerOwner: 'ERP', reason: 'ข้าม tenant ห้ามเห็น' }, undefined, tok2))
        .status,
    ).toBe(404);
  });

  it('ส่งเอกสารเข้า ERP สำเร็จแล้ว → เปลี่ยนเจ้าของไม่ได้ (409 sor_locked) แต่กลุ่ม field/แก้ได้จนรับชำระยังเปลี่ยนได้', async () => {
    const c = await connector();
    const cid = tryDecodeId('connector', c.id)!;
    await plat.integrationOutbox.create({
      data: {
        tenantId,
        kind: 'ADAPTER',
        sink: 'erp',
        targetId: cid,
        operation: 'PUSH_INVOICE',
        entityType: 'invoice',
        localId: randomUUID(),
        serializeKey: `erp:${cid}:x`,
        idempotencyKey: `sor-test:${randomUUID()}`,
        status: 'DONE',
        doneAt: new Date(),
      },
    });
    const r = await put(c.id, { taxDocumentOwner: 'TMS', reason: 'เปลี่ยนหลังส่งเอกสารแล้ว' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('sor_locked');
    expect(
      (await put(c.id, { customerOwner: 'TMS', reason: 'เปลี่ยนหลังส่งเอกสารแล้ว' })).status,
    ).toBe(409);
    await put(c.id, { editableUntilPaid: false, reason: 'ปิดการแก้หลังรับชำระ' }).expect(200);
  });

  it('fieldChangePolicy ผ่าน connector: Standalone = LOCAL · ส่งใบแจ้งหนี้ = ตามกลุ่ม · รับชำระแล้ว = BLOCKED', async () => {
    const a = await company();
    const f = (group: 'PRICE' | 'CUSTOMER', status: string | null) =>
      db.withTenant(tenantId, (tx) => policy.fieldChangePolicy(tx, a.id, group, status));
    expect(await f('PRICE', 'ISSUED')).toEqual({ mode: 'LOCAL' });
    await connector({ companyId: a.cmp, capabilitiesEnabled: ['pushInvoice'] });
    expect(await f('PRICE', 'ISSUED')).toEqual({ mode: 'AUTO_SYNC' });
    expect(await f('CUSTOMER', 'ISSUED')).toEqual({ mode: 'REGENERATE' });
    expect(await f('PRICE', 'PARTIALLY_PAID')).toEqual({ mode: 'BLOCKED', code: 'paid_locked' });
  });
});
