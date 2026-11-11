import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import {
  addDays,
  bangkokToday,
  daysBetween,
  expiryStatus,
  isRealDate,
} from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/** สถานะวันหมด — นาฬิกาคงที่ (ฟังก์ชันบริสุทธิ์รับ "วันนี้") */
describe('เอกสารรถ: คำนวณสถานะวันหมด (fixed clock)', () => {
  const today = '2026-11-11';
  it('active > 60 วัน · expiring 0–60 · expired < 0 · วันหมดใช้ได้ทั้งวัน (FLT-042)', () => {
    expect(expiryStatus('ACTIVE', '2027-01-11', today)).toEqual({
      status: 'active',
      daysToExpiry: 61,
    });
    expect(expiryStatus('ACTIVE', '2027-01-10', today)).toEqual({
      status: 'expiring',
      daysToExpiry: 60,
    });
    expect(expiryStatus('ACTIVE', today, today)).toEqual({ status: 'expiring', daysToExpiry: 0 });
    expect(expiryStatus('EXPIRING', '2026-11-10', today)).toEqual({
      status: 'expired',
      daysToExpiry: -1,
    });
    // job (ST2-T18) ยังไม่ได้ตั้ง EXPIRED ก็คำนวณถูก · ต่ออายุแล้ว/ยกเลิก ไม่ขึ้นกับวัน
    expect(expiryStatus('ACTIVE', '2026-01-01', today).status).toBe('expired');
    expect(expiryStatus('SUPERSEDED', '2026-01-01', today).status).toBe('superseded');
    expect(expiryStatus('CANCELLED', '2030-01-01', today).status).toBe('cancelled');
  });
  it('วันนี้ตามเวลาไทย (UTC+7) — 17:00Z = วันถัดไปแล้ว', () => {
    expect(bangkokToday(new Date('2026-11-11T16:59:59Z'))).toBe('2026-11-11');
    expect(bangkokToday(new Date('2026-11-11T17:00:00Z'))).toBe('2026-11-12');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(isRealDate('2026-02-31')).toBe(false);
    expect(isRealDate('2028-02-29')).toBe(true);
  });
});

/** ST2-T17 เอกสารรถ — docs/04 B2.1 ส่วน 2, docs/01 §3.8, spec/06 FLT-C */
describe('เอกสารรถ (vehicle documents)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let viewer: string;
  let otherTenantToken: string;
  let vt: string;
  let carrier: string;
  let seed = 0;
  const today = bangkokToday();

  beforeAll(async () => {
    process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-files-'));
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId);
    viewer = await tokenFor(tenantId, 'master:read documents:read', 'user-viewer');
    otherTenantToken = await tokenFor((await createTenant(db)).id);
    vt = (
      await api(app, admin)
        .post('/v1/vehicle-types')
        .send({ name: '6 ล้อ เอกสาร', vehicleClass: '6W', payloadKg: 6000, minLicenceClass: 'T2' })
        .expect(201)
    ).body.id;
    carrier = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({ legalName: 'นายรถร่วม ทดสอบ', entityType: 'INDIVIDUAL', taxId: validTaxId(77) })
        .expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const vehicle = async (extra: object = {}) =>
    (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `81-${String(++seed).padStart(4, '0')}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt,
          ownership: 'OWN',
          ...extra,
        })
        .expect(201)
    ).body as { id: string };

  const path = (url: string) => new URL(url).pathname + new URL(url).search;
  const upload = async (token = admin, kind = 'VEHICLE_DOC', finish = true) => {
    const r = await api(app, token)
      .post('/v1/documents')
      .send({ kind, mime: 'application/pdf', bytes: PDF.length, filename: 'กรมธรรม์.pdf' })
      .expect(201);
    if (finish)
      await request(app.getHttpServer())
        .put(path(r.body.uploadUrl))
        .set('Content-Type', 'application/octet-stream')
        .send(PDF)
        .expect(200);
    return r.body.id as string;
  };

  const insurance = async (extra: object = {}) => ({
    docType: 'INSURANCE',
    docNo: 'POL-26-00001',
    issuer: 'บริษัท ประกันสมมติ จำกัด',
    insuranceClass: '1',
    sumInsured: '800000.00',
    premiumAmount: '28500.00',
    costAmount: '28500.00',
    startsOn: addDays(today, -300),
    expiresOn: addDays(today, 65),
    fileDocumentIds: [await upload()],
    ...extra,
  });
  const costs = (vehicleId: string) =>
    db.vehicleCost.findMany({
      where: { vehicleId: tryDecodeId('vehicle', vehicleId)! },
      orderBy: { createdAt: 'asc' },
    });

  it('เพิ่มประกันภัย: เก็บช่องประกัน + ไฟล์ · สถานะคำนวณจากวันหมด · ค่าใช้จ่ายเกิดแถว vehicle_cost หมวด DOCUMENT', async () => {
    const v = await vehicle();
    const r = await api(app, admin)
      .post(`/v1/vehicles/${v.id}/documents`)
      .send(await insurance())
      .expect(201);
    expect(r.body.id).toMatch(/^vdoc_[0-9a-f]{32}$/);
    expect(r.body).toMatchObject({
      docType: 'INSURANCE',
      docNo: 'POL-26-00001',
      insuranceClass: '1',
      sumInsured: '800000.00',
      premiumAmount: '28500.00',
      costAmount: '28500.00',
      status: 'active',
      daysToExpiry: 65,
      isRequiredForDispatch: true,
      renewsDocumentId: null,
      vehicle: { id: v.id, ownership: 'OWN' },
    });
    expect(r.body.files).toHaveLength(1);
    expect(r.body.files[0]).toMatchObject({ filename: 'กรมธรรม์.pdf', mime: 'application/pdf' });
    const c = await costs(v.id);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ category: 'DOCUMENT', sourceType: 'vehicle_document' });
    expect(c[0]!.amount.toFixed(2)).toBe('28500.00');
    expect(c[0]!.sourceId).toBe(tryDecodeId('vehicleDocument', r.body.id));
    // ไฟล์ผูกกับเอกสาร
    const f = await db.storedDocument.findUnique({
      where: { id: tryDecodeId('document', r.body.files[0].id)! },
    });
    expect(f).toMatchObject({ entityType: 'vehicle_document' });
    // ฉบับปัจจุบันประเภทเดียวกันซ้ำ → 409 current_exists
    const dup = await api(app, admin)
      .post(`/v1/vehicles/${v.id}/documents`)
      .send(await insurance({ docNo: 'POL-X' }))
      .expect(409);
    expect(dup.body.errors[0].code).toBe('current_exists');
    expect(dup.body.currentDocumentId).toBe(r.body.id);
  });

  it('ตรวจวันที่: หมด ≤ เริ่ม → 422 · วันที่ไม่มีจริง → 422 · ช่องประกันในประเภทอื่น → 422 · เลขที่บังคับ', async () => {
    const v = await vehicle();
    const post = async (body: object) =>
      api(app, admin).post(`/v1/vehicles/${v.id}/documents`).send(body).expect(422);
    const tax = async (extra: object = {}) => ({
      docType: 'ANNUAL_TAX',
      docNo: 'TAX-1',
      startsOn: '2026-12-01',
      expiresOn: '2027-12-01',
      fileDocumentIds: [await upload()],
      ...extra,
    });
    expect((await post(await tax({ expiresOn: '2026-12-01' }))).body.errors[0].code).toBe(
      'expires_before_start',
    );
    expect((await post(await tax({ expiresOn: '2026-11-30' }))).body.errors[0].code).toBe(
      'expires_before_start',
    );
    expect((await post(await tax({ startsOn: '2026-02-31' }))).body.errors[0].code).toBe(
      'invalid_date',
    );
    expect((await post(await tax({ premiumAmount: '1.00' }))).body.errors[0]).toMatchObject({
      field: 'premiumAmount',
      code: 'not_allowed',
    });
    expect((await post(await tax({ docNo: undefined }))).body.errors[0]).toMatchObject({
      field: 'docNo',
      code: 'required',
    });
    expect((await post(await tax({ costAmount: 12.5 }))).body.errors[0].field).toBe('costAmount');
    expect((await post(await tax({ fileDocumentIds: [] }))).body.errors[0].field).toBe(
      'fileDocumentIds',
    );
    // OTHER: ต้องมีชื่อ, เลขที่ไม่บังคับ, หลายฉบับได้
    expect(
      (await post(await tax({ docType: 'OTHER', docNo: undefined }))).body.errors[0].field,
    ).toBe('title');
    for (const title of ['สัญญาเช่าที่จอด', 'ใบรับรองห้องเย็น'])
      await api(app, admin)
        .post(`/v1/vehicles/${v.id}/documents`)
        .send(await tax({ docType: 'OTHER', docNo: undefined, title }))
        .expect(201);
  });

  it('ไฟล์แนบแยก tenant: ไฟล์ของ tenant อื่น / ยังไม่อัปโหลด / kind อื่น → 422', async () => {
    const v = await vehicle();
    const send = (fileId: string) =>
      api(app, admin)
        .post(`/v1/vehicles/${v.id}/documents`)
        .send({
          docType: 'INSPECTION',
          docNo: 'INS-1',
          startsOn: '2026-01-01',
          expiresOn: '2027-01-01',
          fileDocumentIds: [fileId],
        })
        .expect(422);
    expect((await send(await upload(otherTenantToken))).body.errors[0].code).toBe('not_found');
    expect((await send(await upload(admin, 'VEHICLE_DOC', false))).body.errors[0].code).toBe(
      'invalid_file',
    );
    expect((await send(await upload(admin, 'RECEIPT'))).body.errors[0].code).toBe('invalid_file');
    // รถของ tenant อื่น → 404
    await api(app, otherTenantToken).get(`/v1/vehicles/${v.id}/documents`).expect(404);
  });

  it('เกณฑ์ตรวจรับ: ต่ออายุแล้วฉบับเก่ายังอยู่ในประวัติ; ค่าใช้จ่ายเกิดแถว vehicle_cost', async () => {
    const v = await vehicle();
    const first = (
      await api(app, admin)
        .post(`/v1/vehicles/${v.id}/documents`)
        .send(await insurance({ expiresOn: addDays(today, 10) }))
        .expect(201)
    ).body;
    expect(first.status).toBe('expiring');
    // หมดก่อน/เท่าฉบับเดิม → 422
    const bad = await api(app, admin)
      .post(`/v1/vehicle-documents/${first.id}/renew`)
      .send({
        docNo: 'POL-27-00001',
        startsOn: addDays(today, 5),
        expiresOn: addDays(today, 10),
        fileDocumentIds: [await upload()],
      })
      .expect(422);
    expect(bad.body.errors[0].code).toBe('not_after_previous');
    const r = await api(app, admin)
      .post(`/v1/vehicle-documents/${first.id}/renew`)
      .set('Idempotency-Key', `renew-${first.id}`)
      .send({
        docNo: 'POL-27-00001',
        startsOn: addDays(today, 10),
        expiresOn: addDays(today, 375),
        premiumAmount: '29900.00',
        costAmount: '29900.00',
        fileDocumentIds: [await upload()],
      })
      .expect(201);
    expect(r.body.document).toMatchObject({
      docNo: 'POL-27-00001',
      renewsDocumentId: first.id,
      status: 'active',
      issuer: 'บริษัท ประกันสมมติ จำกัด', // คัดลอกจากฉบับเดิม
      insuranceClass: '1',
      sumInsured: '800000.00',
      isRequiredForDispatch: true,
    });
    expect(r.body.previous).toMatchObject({
      id: first.id,
      status: 'superseded',
      docNo: 'POL-26-00001',
      renewedByDocumentId: r.body.document.id,
    });
    const list = (await api(app, viewer).get(`/v1/vehicles/${v.id}/documents`).expect(200)).body
      .data;
    expect(list.map((d: { id: string }) => d.id)).toEqual([r.body.document.id, first.id]);
    const c = await costs(v.id);
    expect(c.map((x) => x.amount.toFixed(2))).toEqual(['28500.00', '29900.00']);
    expect(c[1]!.sourceId).toBe(tryDecodeId('vehicleDocument', r.body.document.id));
    // ต่ออายุฉบับเดิมซ้ำ → 409
    const again = await api(app, admin)
      .post(`/v1/vehicle-documents/${first.id}/renew`)
      .send({
        docNo: 'POL-27-00002',
        startsOn: addDays(today, 10),
        expiresOn: addDays(today, 400),
        fileDocumentIds: [await upload()],
      })
      .expect(409);
    expect(again.body.errors[0].code).toBe('already_renewed');
    // audit ทั้งสองฉบับ
    const audits = await db.auditLog.findMany({
      where: { tenantId, entityType: 'vehicle_document' },
      select: { action: true },
    });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['vehicle_document.renewed', 'vehicle_document.superseded']),
    );
    const ev = await db.domainEvent.findFirst({
      where: { tenantId, type: 'vehicle.document_renewed' },
    });
    expect(ev).not.toBeNull();
  });

  it('ยกเลิกฉบับต่ออายุที่บันทึกผิด: เหตุผล ≥ 10 · ฉบับเดิมกลับเป็นปัจจุบัน · ค่าใช้จ่ายกลับรายการ (ไม่ลบ ledger)', async () => {
    const v = await vehicle();
    const first = (
      await api(app, admin)
        .post(`/v1/vehicles/${v.id}/documents`)
        .send(await insurance({ costAmount: '1000.00' }))
        .expect(201)
    ).body;
    const renewed = (
      await api(app, admin)
        .post(`/v1/vehicle-documents/${first.id}/renew`)
        .send({
          docNo: 'POL-WRONG',
          startsOn: addDays(today, 65),
          expiresOn: addDays(today, 430),
          costAmount: '2000.00',
          fileDocumentIds: [await upload()],
        })
        .expect(201)
    ).body.document;
    await api(app, admin)
      .post(`/v1/vehicle-documents/${renewed.id}/cancel`)
      .send({ reason: 'สั้น' })
      .expect(422);
    await api(app, viewer)
      .post(`/v1/vehicle-documents/${renewed.id}/cancel`)
      .send({ reason: 'บันทึกเลขกรมธรรม์ผิดฉบับ' })
      .expect(403);
    const x = await api(app, admin)
      .post(`/v1/vehicle-documents/${renewed.id}/cancel`)
      .send({ reason: 'บันทึกเลขกรมธรรม์ผิดฉบับ' })
      .expect(200);
    expect(x.body).toMatchObject({ status: 'cancelled', cancelReason: 'บันทึกเลขกรมธรรม์ผิดฉบับ' });
    const prev = (await api(app, admin).get(`/v1/vehicle-documents/${first.id}`).expect(200)).body;
    expect(prev).toMatchObject({ status: 'active', renewedByDocumentId: null });
    expect((await costs(v.id)).map((c) => c.amount.toFixed(2))).toEqual([
      '1000.00',
      '2000.00',
      '-2000.00',
    ]);
    const a = await db.auditLog.findFirst({
      where: { tenantId, action: 'vehicle_document.cancelled' },
    });
    expect(a?.reason).toBe('บันทึกเลขกรมธรรม์ผิดฉบับ');
    // ฉบับเดิมที่กลับมา: audit ของตัวเอง (เหตุผลเดียวกัน) + event อ้างถึง
    const restored = await db.auditLog.findFirst({
      where: {
        tenantId,
        action: 'vehicle_document.restored',
        entityId: tryDecodeId('vehicleDocument', first.id)!,
      },
    });
    expect(restored).toMatchObject({ reason: 'บันทึกเลขกรมธรรม์ผิดฉบับ' });
    expect((restored!.before as { status: string }).status).toBe('SUPERSEDED');
    expect((restored!.after as { status: string }).status).toBe('ACTIVE');
    const ev = await db.domainEvent.findFirst({
      where: { tenantId, type: 'vehicle.document_cancelled' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(ev?.previousAttributes).toMatchObject({ restoredDocumentId: first.id });
    // หมายเหตุใน ledger เป็นภาษาไทย (ไม่ใช่รหัส enum)
    expect((await costs(v.id)).map((c) => c.note)).toEqual([
      'เพิ่มประกันภัย POL-26-00001',
      'ต่ออายุประกันภัย POL-WRONG',
      'ยกเลิกประกันภัย POL-WRONG',
    ]);
    // ยกเลิกซ้ำ → 409 · ต่ออายุฉบับเดิมใหม่ได้
    await api(app, admin)
      .post(`/v1/vehicle-documents/${renewed.id}/cancel`)
      .send({ reason: 'บันทึกเลขกรมธรรม์ผิดฉบับ' })
      .expect(409);
    await api(app, admin)
      .post(`/v1/vehicle-documents/${first.id}/renew`)
      .send({
        docNo: 'POL-RIGHT',
        startsOn: addDays(today, 65),
        expiresOn: addDays(today, 430),
        fileDocumentIds: [await upload()],
      })
      .expect(201);
  });

  it('review: ต่ออายุเอกสาร OTHER (ชื่อเดิมติดไป / เปลี่ยนชื่อได้) · ยกเลิกฉบับที่ต่อจากฉบับใกล้หมด → สถานะในฐานตามวันหมด', async () => {
    const v = await vehicle();
    const other = (
      await api(app, admin)
        .post(`/v1/vehicles/${v.id}/documents`)
        .send({
          docType: 'OTHER',
          title: 'สัญญาเช่าที่จอด',
          startsOn: addDays(today, -340),
          expiresOn: addDays(today, 25),
          fileDocumentIds: [await upload()],
        })
        .expect(201)
    ).body;
    expect(other.status).toBe('expiring');
    const row = (id: string) =>
      db.vehicleDocument.findUnique({ where: { id: tryDecodeId('vehicleDocument', id)! } });
    expect((await row(other.id))?.status).toBe('EXPIRING');
    const r = await api(app, admin)
      .post(`/v1/vehicle-documents/${other.id}/renew`)
      .send({
        startsOn: addDays(today, 25),
        expiresOn: addDays(today, 390),
        fileDocumentIds: [await upload()],
      })
      .expect(201);
    expect(r.body.document).toMatchObject({ docType: 'OTHER', title: 'สัญญาเช่าที่จอด' });
    const r2 = await api(app, admin)
      .post(`/v1/vehicle-documents/${r.body.document.id}/renew`)
      .send({
        title: 'สัญญาเช่าที่จอด (ฉบับแก้ไข)',
        startsOn: addDays(today, 390),
        expiresOn: addDays(today, 755),
        fileDocumentIds: [await upload()],
      })
      .expect(201);
    expect(r2.body.document.title).toBe('สัญญาเช่าที่จอด (ฉบับแก้ไข)');
    // title ในประเภทอื่น → 422
    const tax = (
      await api(app, admin)
        .post(`/v1/vehicles/${v.id}/documents`)
        .send({
          docType: 'ANNUAL_TAX',
          docNo: 'TAX-R',
          startsOn: addDays(today, -350),
          expiresOn: addDays(today, 15),
          fileDocumentIds: [await upload()],
        })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/vehicle-documents/${tax.id}/renew`)
      .send({
        title: 'x',
        docNo: 'TAX-R2',
        startsOn: addDays(today, 15),
        expiresOn: addDays(today, 380),
        fileDocumentIds: [await upload()],
      })
      .expect(422);
    // ยกเลิกฉบับต่ออายุ → ฉบับเดิม (เหลือ 15 วัน) กลับเป็น EXPIRING ไม่ใช่ ACTIVE
    const rt = (
      await api(app, admin)
        .post(`/v1/vehicle-documents/${tax.id}/renew`)
        .send({
          docNo: 'TAX-R2',
          startsOn: addDays(today, 15),
          expiresOn: addDays(today, 380),
          fileDocumentIds: [await upload()],
        })
        .expect(201)
    ).body.document;
    await api(app, admin)
      .post(`/v1/vehicle-documents/${rt.id}/cancel`)
      .send({ reason: 'ต่ออายุผิดคัน ทดสอบ' })
      .expect(200);
    expect((await row(tax.id))?.status).toBe('EXPIRING');
  });

  it('review: ไฟล์เดียวแนบได้เอกสารเดียว (ข้ามรถ/ต่ออายุใช้ไฟล์เดิมไม่ได้) · วันที่นอกช่วง 1980–2100 → 422', async () => {
    const v1 = await vehicle();
    const v2 = await vehicle();
    const f = await upload();
    const d1 = (
      await api(app, admin)
        .post(`/v1/vehicles/${v1.id}/documents`)
        .send(await insurance({ fileDocumentIds: [f] }))
        .expect(201)
    ).body;
    const dup = await api(app, admin)
      .post(`/v1/vehicles/${v2.id}/documents`)
      .send(await insurance({ fileDocumentIds: [f] }))
      .expect(422);
    expect(dup.body.errors[0]).toMatchObject({ field: 'fileDocumentIds', code: 'file_in_use' });
    const re = await api(app, admin)
      .post(`/v1/vehicle-documents/${d1.id}/renew`)
      .send({
        docNo: 'POL-R',
        startsOn: addDays(today, 65),
        expiresOn: addDays(today, 430),
        fileDocumentIds: [f],
      })
      .expect(422);
    expect(re.body.errors[0].code).toBe('file_in_use');
    // ไฟล์ที่ระบุ entity อื่นตอนอัปโหลด (เช่น trip_stop) ใช้ไม่ได้
    const foreign = (
      await api(app, admin)
        .post('/v1/documents')
        .send({
          kind: 'VEHICLE_DOC',
          mime: 'application/pdf',
          bytes: PDF.length,
          entityType: 'trip_stop',
        })
        .expect(201)
    ).body;
    await request(app.getHttpServer())
      .put(path(foreign.uploadUrl))
      .set('Content-Type', 'application/octet-stream')
      .send(PDF)
      .expect(200);
    expect(
      (
        await api(app, admin)
          .post(`/v1/vehicles/${v2.id}/documents`)
          .send(await insurance({ fileDocumentIds: [foreign.id] }))
          .expect(422)
      ).body.errors[0].code,
    ).toBe('file_in_use');
    for (const [startsOn, expiresOn] of [
      ['1979-12-31', '2027-01-01'],
      ['2026-01-01', '2101-01-01'],
    ])
      expect(
        (
          await api(app, admin)
            .post(`/v1/vehicles/${v2.id}/documents`)
            .send(await insurance({ startsOn, expiresOn }))
            .expect(422)
        ).body.errors[0].code,
      ).toBe('out_of_range');
  });

  it('review: กิจกรรมของรถรวมประวัติเอกสาร (เพิ่ม/ต่ออายุ)', async () => {
    const v = await vehicle();
    const d = (
      await api(app, admin)
        .post(`/v1/vehicles/${v.id}/documents`)
        .send(await insurance())
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/vehicle-documents/${d.id}/renew`)
      .send({
        docNo: 'POL-H2',
        startsOn: addDays(today, 65),
        expiresOn: addDays(today, 430),
        fileDocumentIds: [await upload()],
      })
      .expect(201);
    const h = (await api(app, viewer).get(`/v1/vehicles/${v.id}/history`).expect(200)).body.data;
    const acts = h.map((r: { action: string }) => r.action);
    expect(acts).toEqual(
      expect.arrayContaining([
        'vehicle.created',
        'vehicle_document.created',
        'vehicle_document.renewed',
        'vehicle_document.superseded',
      ]),
    );
    expect(
      h.find((r: { action: string }) => r.action === 'vehicle_document.created').entityId,
    ).toBe(d.id);
  });

  it('รถร่วม: เก็บค่าใช้จ่ายในเอกสารแต่ไม่ลง vehicle_cost · รถปลดระวาง → 409 · ไม่มีสิทธิ์เขียน → 403', async () => {
    const sub = await vehicle({ ownership: 'SUBCONTRACT', carrierId: carrier });
    const d = await api(app, admin)
      .post(`/v1/vehicles/${sub.id}/documents`)
      .send(await insurance())
      .expect(201);
    expect(d.body.costAmount).toBe('28500.00');
    expect(await costs(sub.id)).toHaveLength(0);

    const v = await vehicle();
    await api(app, viewer)
      .post(`/v1/vehicles/${v.id}/documents`)
      .send(await insurance())
      .expect(403);
    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/status`)
      .send({ status: 'retired', reason: 'ขายรถออกไปแล้ว ทดสอบ' })
      .expect(200);
    const r = await api(app, admin)
      .post(`/v1/vehicles/${v.id}/documents`)
      .send(await insurance())
      .expect(409);
    expect(r.body.errors[0].code).toBe('vehicle_retired');
  });

  it('รายการทั้ง tenant: เรียงวันหมด · กรองหมดภายใน 30 วัน / หมดแล้ว / ประเภท / ทะเบียน · แบ่งหน้า', async () => {
    await truncateAll();
    tenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId);
    otherTenantToken = await tokenFor((await createTenant(db)).id);
    vt = (
      await api(app, admin)
        .post('/v1/vehicle-types')
        .send({ name: '6 ล้อ รายการ', vehicleClass: '6W', payloadKg: 6000, minLicenceClass: 'T2' })
        .expect(201)
    ).body.id;
    const v1 = await vehicle();
    const v2 = await vehicle();
    const add = async (v: string, docType: string, expires: number) =>
      (
        await api(app, admin)
          .post(`/v1/vehicles/${v}/documents`)
          .send({
            docType,
            docNo: `${docType}-${expires}`,
            startsOn: addDays(today, expires - 365),
            expiresOn: addDays(today, expires),
            fileDocumentIds: [await upload()],
          })
          .expect(201)
      ).body;
    const expired = await add(v1.id, 'ANNUAL_TAX', -2);
    const d7 = await add(v1.id, 'COMPULSORY_ACT', 7);
    const d30 = await add(v2.id, 'ANNUAL_TAX', 30);
    const d45 = await add(v2.id, 'INSPECTION', 45);
    const d200 = await add(v2.id, 'GPS_DLT_CERT', 200);
    const ids = (r: { body: { data: { id: string }[] } }) => r.body.data.map((d) => d.id);

    const all = await api(app, admin).get('/v1/vehicle-documents').expect(200);
    expect(ids(all)).toEqual([expired.id, d7.id, d30.id, d45.id, d200.id]);
    expect(all.body.data.map((d: { status: string }) => d.status)).toEqual([
      'expired',
      'expiring',
      'expiring',
      'expiring',
      'active',
    ]);
    // เกณฑ์ตรวจรับ T19: filter 30 วันแสดงเฉพาะเอกสารที่หมดใน 30 วัน
    expect(
      ids(await api(app, admin).get('/v1/vehicle-documents?expiresWithinDays=30').expect(200)),
    ).toEqual([d7.id, d30.id]);
    expect(
      ids(await api(app, admin).get('/v1/vehicle-documents?status=expired').expect(200)),
    ).toEqual([expired.id]);
    expect(
      ids(await api(app, admin).get('/v1/vehicle-documents?docType=ANNUAL_TAX').expect(200)),
    ).toEqual([expired.id, d30.id]);
    const plate = all.body.data.find((d: { id: string }) => d.id === d45.id).vehicle.plate;
    expect(
      ids(
        await api(app, admin)
          .get(`/v1/vehicle-documents?plate=${encodeURIComponent(plate.replace('-', ' '))}`)
          .expect(200),
      ),
    ).toEqual([d30.id, d45.id, d200.id]);
    // แบ่งหน้า
    const p1 = await api(app, admin).get('/v1/vehicle-documents?limit=2').expect(200);
    expect(ids(p1)).toEqual([expired.id, d7.id]);
    const p2 = await api(app, admin)
      .get(`/v1/vehicle-documents?limit=2&cursor=${p1.body.nextCursor}`)
      .expect(200);
    expect(ids(p2)).toEqual([d30.id, d45.id]);
    await api(app, admin).get('/v1/vehicle-documents?cursor=xyz').expect(422);
    // cursor ที่แต่งขึ้น (id ไม่ใช่ uuid / วันที่ไม่มีจริง) → 422 ไม่ใช่ 500
    const forge = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    for (const c of [
      { k: '2026-01-01', i: 'not-a-uuid' },
      { k: '2026-02-31', i: '00000000-0000-4000-8000-000000000000' },
    ])
      await api(app, admin)
        .get(`/v1/vehicle-documents?cursor=${forge(c)}`)
        .expect(422);
    // kit ร่วมของ master ทุกตัว (รถ = sort ทะเบียน, ลูกค้า = updatedAt)
    await api(app, admin)
      .get(`/v1/vehicles?cursor=${forge({ s: 'code', k: 'x', i: '---' })}`)
      .expect(422);
    await api(app, admin)
      .get(
        `/v1/customers?sort=updatedAt&cursor=${forge({ s: 'updatedAt', k: 'nope', i: '00000000-0000-4000-8000-000000000000' })}`,
      )
      .expect(422);
    // ประวัติ (superseded) ไม่อยู่ในค่าเริ่มต้น แต่ขอได้
    await api(app, admin)
      .post(`/v1/vehicle-documents/${expired.id}/renew`)
      .send({
        docNo: 'TAX-NEW',
        startsOn: today,
        expiresOn: addDays(today, 365),
        fileDocumentIds: [await upload()],
      })
      .expect(201);
    expect(
      ids(await api(app, admin).get('/v1/vehicle-documents?status=superseded').expect(200)),
    ).toEqual([expired.id]);
    expect(ids(await api(app, admin).get('/v1/vehicle-documents').expect(200))).not.toContain(
      expired.id,
    );
    // tenant อื่นไม่เห็น
    expect(
      (await api(app, otherTenantToken).get('/v1/vehicle-documents').expect(200)).body.data,
    ).toEqual([]);
  });
});
