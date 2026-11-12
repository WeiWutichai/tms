import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import {
  PUBLIC_LIMIT_PER_MIN,
  resetPublicRateLimit,
} from '../src/http/public-rate-limit.middleware';
import { AssignabilityService } from '../src/modules/assignability/assignability.service';
import { LINK_FILES_PER_HOUR } from '../src/modules/carrier-docs/carrier-docs.service';
import { MagicLinkService } from '../src/modules/links/magic-link.service';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/**
 * ST2-T21 รถร่วมอัปโหลดเอกสารรถ/ใบขับขี่เองผ่านลิงก์ (docs/04 B2.1) — เกณฑ์ตรวจรับ:
 * เปิดลิงก์บนมือถือ อัปโหลดไฟล์แล้วขึ้น "รอ admin ยืนยัน"
 */
describe('ลิงก์อัปโหลดเอกสารรถร่วม (carrier docs link)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let dbs: DbService;
  let assign: AssignabilityService;
  let tenantId: string;
  let admin: string;
  let viewer: string;
  let otherAdmin: string;
  let vt: string;
  let carrierA: string;
  let carrierB: string;
  let vehA: string;
  let vehB: string;
  let drvA: string;
  let seed = 0;
  const today = bangkokToday();

  beforeAll(async () => {
    process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-files-'));
    await truncateAll();
    app = await bootApp();
    dbs = app.get(DbService);
    assign = app.get(AssignabilityService);
    tenantId = (await createTenant(db, 'ศรีสมมติขนส่ง')).id;
    admin = await tokenFor(tenantId);
    viewer = await tokenFor(tenantId, 'master:read documents:read', 'user-viewer');
    otherAdmin = await tokenFor((await createTenant(db)).id);
    vt = (
      await api(app, admin)
        .post('/v1/vehicle-types')
        .send({ name: '6 ล้อ ลิงก์', vehicleClass: '6W', payloadKg: 6000, minLicenceClass: 'T2' })
        .expect(201)
    ).body.id;
    const carrier = async (n: number) =>
      (
        await api(app, admin)
          .post('/v1/carriers')
          .send({
            legalName: `หจก. รถร่วมสมมติ ${n}`,
            entityType: 'INDIVIDUAL',
            taxId: validTaxId(300 + n),
          })
          .expect(201)
      ).body.id as string;
    carrierA = await carrier(1);
    carrierB = await carrier(2);
    const veh = async (plate: string, carrierId: string) =>
      (
        await api(app, admin)
          .post('/v1/vehicles')
          .send({
            plate,
            plateProvince: 'TH-20',
            vehicleTypeId: vt,
            ownership: 'SUBCONTRACT',
            carrierId,
          })
          .expect(201)
      ).body.id as string;
    vehA = await veh('74-5521', carrierA);
    vehB = await veh('74-5522', carrierB);
    drvA = (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: 'คนขับรถร่วม สมมติ',
          phone: '089-111-2233',
          employmentType: 'CARRIER_DRIVER',
          carrierId: carrierA,
          licenceClass: 'T2',
          licenceExpiresOn: addDays(today, 10),
        })
        .expect(201)
    ).body.id;
  });
  beforeEach(() => resetPublicRateLimit());
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const pub = () => request(app.getHttpServer());
  const issue = async (carrierId = carrierA, body: object = {}) =>
    (await api(app, admin).post(`/v1/carriers/${carrierId}/upload-links`).send(body).expect(201))
      .body as { id: string; token: string; url: string; expiresAt: string; status: string };
  const path = (url: string) => new URL(url).pathname + new URL(url).search;
  const upload = async (token: string, data = PDF, mime = 'application/pdf') => {
    const r = await pub()
      .post(`/v1/public/carrier-docs/${token}/files`)
      .send({ mime, bytes: data.length, filename: 'กรมธรรม์.pdf' })
      .expect(201);
    await pub()
      .put(path(r.body.uploadUrl))
      .set('Content-Type', 'application/octet-stream')
      .send(data)
      .expect(200);
    return r.body.id as string;
  };
  const insurance = async (token: string, extra: object = {}) => ({
    vehicleId: vehA,
    docType: 'INSURANCE',
    docNo: `POL-${++seed}`,
    issuer: 'บริษัท ประกันสมมติ จำกัด',
    startsOn: today,
    expiresOn: addDays(today, 365),
    fileDocumentIds: [await upload(token)],
    ...extra,
  });
  const submit = (token: string, body: object) =>
    pub().post(`/v1/public/carrier-docs/${token}/submissions`).send(body);
  const check = (vehicleId: string, driverId?: string) =>
    dbs.withTenant(tenantId, (tx) =>
      assign.isAssignable(
        {
          vehicleId: tryDecodeId('vehicle', vehicleId)!,
          ...(driverId ? { driverId: tryDecodeId('driver', driverId)! } : {}),
          date: today,
        },
        tx,
      ),
    );
  const pending = async (carrierId = carrierA) =>
    (
      await api(app, admin)
        .get(`/v1/carrier-doc-submissions?carrierId=${carrierId}&status=pending_review`)
        .expect(200)
    ).body.data as { id: string; docType: string; files: { id: string }[] }[];

  it('admin ออกลิงก์: url หน้าอัปโหลด + อายุ 7 วัน (ค่าเริ่มต้น) + audit · ไม่ส่งข้อความเอง · viewer ออกไม่ได้', async () => {
    const l = await issue();
    expect(l.url).toMatch(/\/link\/carrier-docs\/ml1\./);
    expect(l.url.endsWith(l.token)).toBe(true);
    expect(l.status).toBe('active');
    const days = (Date.parse(l.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    const a = await db.auditLog.findFirst({
      where: { tenantId, action: 'magic_link.issued', entityId: tryDecodeId('carrier', carrierA)! },
    });
    expect(a).not.toBeNull();
    // ระบบไม่ส่งอีเมล/ข้อความใด ๆ ตอนออกลิงก์
    expect(await db.emailOutbox.count({ where: { tenantId } })).toBe(0);
    await api(app, viewer).post(`/v1/carriers/${carrierA}/upload-links`).send({}).expect(403);
    const list = await api(app, viewer).get(`/v1/carriers/${carrierA}/upload-links`).expect(200);
    expect(list.body.data[0]).toMatchObject({ id: l.id, status: 'active' });
    expect(JSON.stringify(list.body)).not.toContain(l.token);
    await api(app, admin)
      .post(`/v1/carriers/${carrierA}/upload-links`)
      .send({ ttlDays: 31 })
      .expect(422);
    // tenant อื่นออกลิงก์ให้ผู้รับเหมาของเราไม่ได้
    await api(app, otherAdmin).post(`/v1/carriers/${carrierA}/upload-links`).send({}).expect(404);
  });

  it('เปิดลิงก์ (ไม่ login): เห็นเฉพาะรถ/คนขับของผู้รับเหมารายนี้ + ช่องประกันภัย/พ.ร.บ./ใบขับขี่ · ไม่มีราคา', async () => {
    const l = await issue();
    const r = await pub().get(`/v1/public/carrier-docs/${l.token}`).expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.company).toBe('ศรีสมมติขนส่ง');
    expect(r.body.carrierName).toBe('หจก. รถร่วมสมมติ 1');
    expect(r.body.vehicles.map((v: { id: string }) => v.id)).toEqual([vehA]);
    expect(r.body.vehicles[0].items.map((i: { docType: string }) => i.docType)).toEqual([
      'INSURANCE',
      'COMPULSORY_ACT',
    ]);
    expect(r.body.vehicles[0].items[0]).toMatchObject({ state: 'missing', currentExpiresOn: null });
    expect(r.body.drivers).toEqual([
      expect.objectContaining({
        id: drvA,
        licence: expect.objectContaining({ docType: 'DRIVER_LICENCE', state: 'expiring' }),
      }),
    ]);
    expect(JSON.stringify(r.body)).not.toMatch(/premium|amount|price|taxId|phone/i);
  });

  it('เกณฑ์ตรวจรับ: อัปโหลดไฟล์ + ส่ง → รอ admin ตรวจ (pending_review) · ยังไม่เป็นเอกสารรถ · isAssignable ยังบล็อก', async () => {
    const l = await issue();
    const before = await check(vehA);
    expect(before.assignable).toBe(false);
    const r = await submit(l.token, await insurance(l.token)).expect(201);
    expect(r.body).toEqual({ id: expect.stringMatching(/^cds_/), status: 'pending_review' });
    const v = await pub().get(`/v1/public/carrier-docs/${l.token}`).expect(200);
    expect(v.body.vehicles[0].items[0]).toMatchObject({
      docType: 'INSURANCE',
      state: 'pending_review',
    });
    expect(v.body.submissions[0]).toMatchObject({
      status: 'pending_review',
      subject: '74-5521',
      fileCount: 1,
    });
    expect(
      await db.vehicleDocument.count({ where: { vehicleId: tryDecodeId('vehicle', vehA)! } }),
    ).toBe(0);
    // รอตรวจไม่ปลดบล็อก
    const after = await check(vehA);
    expect(after.assignable).toBe(false);
    expect(after.blocks.map((b) => b.code)).toContain('DOC_MISSING');
    // ส่งซ้ำประเภทเดิมระหว่างรอตรวจ → 409
    const dup = await submit(l.token, await insurance(l.token)).expect(409);
    expect(dup.body.errors[0].code).toBe('pending_exists');
    // ไฟล์ผูกกับรายการที่ส่ง
    const [p] = await pending();
    const f = await db.storedDocument.findUnique({
      where: { id: tryDecodeId('document', p!.files[0]!.id)! },
    });
    expect(f).toMatchObject({
      entityType: 'carrier_doc_submission',
      entityId: tryDecodeId('carrierDocSubmission', p!.id),
    });
    const audit = await db.auditLog.findFirst({
      where: { tenantId, action: 'carrier_doc_submission.submitted' },
    });
    expect(audit?.actorId).toBe(`link:${tryDecodeId('magicLink', l.id)}`);
  });

  it('ขอบเขตลิงก์: รถ/คนขับของผู้รับเหมารายอื่น → 404 · tenant อื่นไม่เห็นรายการ · ไฟล์ของลิงก์อื่นใช้ไม่ได้', async () => {
    const l = await issue();
    const other = await issue(carrierB);
    await submit(
      l.token,
      await insurance(l.token, { vehicleId: vehB, docType: 'COMPULSORY_ACT' }),
    ).expect(404);
    // ไฟล์ที่จองด้วยลิงก์ของผู้รับเหมาอื่น
    const foreign = await upload(other.token);
    const r = await submit(
      l.token,
      await insurance(l.token, { docType: 'COMPULSORY_ACT', fileDocumentIds: [foreign] }),
    ).expect(422);
    expect(r.body.errors[0]).toMatchObject({ field: 'fileDocumentIds', code: 'not_found' });
    // คนขับที่ไม่ใช่ของรายนี้
    const ownDriver = (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: 'คนขับบริษัท',
          phone: '081-999-0001',
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: addDays(today, 100),
        })
        .expect(201)
    ).body.id;
    await submit(l.token, {
      driverId: ownDriver,
      docType: 'DRIVER_LICENCE',
      docNo: 'DL-1',
      expiresOn: addDays(today, 900),
      fileDocumentIds: [await upload(l.token)],
    }).expect(404);
    // ประเภทที่ไม่ได้ขอ (ภาษีไม่ได้ตั้งบังคับ) → 422
    const t = await submit(l.token, await insurance(l.token, { docType: 'ANNUAL_TAX' })).expect(
      422,
    );
    expect(t.body.errors[0].code).toBe('not_requested');
    // tenant อื่นไม่เห็นรายการที่ส่ง
    const list = await api(app, otherAdmin).get('/v1/carrier-doc-submissions').expect(200);
    expect(list.body.data).toEqual([]);
  });

  it('ลิงก์หมดอายุ / เพิกถอน / ลายเซ็นผิด → 404 (กรอบ ST1-T06) · เพิกถอนต้องมีเหตุผล + audit · ซ้ำไม่ได้', async () => {
    const l = await issue();
    const linkId = tryDecodeId('magicLink', l.id)!;
    await api(app, admin)
      .post(`/v1/carrier-upload-links/${l.id}/revoke`)
      .send({ reason: 'สั้น' })
      .expect(422);
    await api(app, otherAdmin)
      .post(`/v1/carrier-upload-links/${l.id}/revoke`)
      .send({ reason: 'ส่งลิงก์ผิดคน ขอยกเลิก' })
      .expect(404);
    const rv = await api(app, admin)
      .post(`/v1/carrier-upload-links/${l.id}/revoke`)
      .send({ reason: 'ส่งลิงก์ผิดคน ขอยกเลิก' })
      .expect(200);
    expect(rv.body.status).toBe('revoked');
    expect(
      await db.auditLog.count({
        where: { action: 'magic_link.revoked', reason: 'ส่งลิงก์ผิดคน ขอยกเลิก' },
      }),
    ).toBe(1);
    await api(app, admin)
      .post(`/v1/carrier-upload-links/${l.id}/revoke`)
      .send({ reason: 'ส่งลิงก์ผิดคน ขอยกเลิก' })
      .expect(409);
    await pub().get(`/v1/public/carrier-docs/${l.token}`).expect(404);
    await pub()
      .post(`/v1/public/carrier-docs/${l.token}/files`)
      .send({ mime: 'application/pdf', bytes: 10 })
      .expect(404);

    // หมดอายุ (ออกลิงก์อายุ 1 วินาทีผ่าน service เดียวกัน แล้วรอให้หมด)
    const e = await dbs.withTenant(tenantId, (tx) =>
      app.get(MagicLinkService).issue(tx, tenantId, {
        purpose: 'carrier_docs',
        entityType: 'carrier',
        entityId: tryDecodeId('carrier', carrierA)!,
        actions: ['docs.view', 'docs.upload'],
        ttlSeconds: 1,
      }),
    );
    await new Promise((r) => setTimeout(r, 1100));
    await pub().get(`/v1/public/carrier-docs/${e.token}`).expect(404);
    const eid = encodeId('magicLink', e.id);
    const listed = await api(app, admin).get(`/v1/carriers/${carrierA}/upload-links`).expect(200);
    expect(listed.body.data.find((x: { id: string }) => x.id === eid).status).toBe('expired');

    const good = await issue();
    await pub()
      .get(`/v1/public/carrier-docs/${good.token.slice(0, -2)}xx`)
      .expect(404);
    // ลิงก์ purpose อื่น (เช่น ข้อเสนองาน) ใช้หน้าเอกสารไม่ได้ (action ไม่ตรง)
    const offer = await dbs.withTenant(tenantId, (tx) =>
      app.get(MagicLinkService).issue(tx, tenantId, {
        purpose: 'trip_offer',
        entityType: 'trip',
        entityId: linkId,
        actions: ['view'],
        ttlSeconds: 3600,
      }),
    );
    await pub().get(`/v1/public/carrier-docs/${offer.token}`).expect(404);
  });

  it('admin อนุมัติ (เหตุผล ≥ 10) → เอกสารรถจริง → isAssignable ปลดบล็อก · ตรวจซ้ำไม่ได้', async () => {
    const l = await issue();
    // ประกันภัยส่งไว้แล้วจาก test ก่อน (รอตรวจ) — ส่ง พ.ร.บ. เพิ่ม
    await submit(
      l.token,
      await insurance(l.token, { docType: 'COMPULSORY_ACT', docNo: 'CMI-1', issuer: null }),
    ).expect(201);
    const subs = await pending();
    expect(subs.map((s) => s.docType).sort()).toEqual(['COMPULSORY_ACT', 'INSURANCE']);
    const ins = subs.find((s) => s.docType === 'INSURANCE')!;
    await api(app, admin)
      .post(`/v1/carrier-doc-submissions/${ins.id}/approve`)
      .send({})
      .expect(422);
    await api(app, viewer)
      .post(`/v1/carrier-doc-submissions/${ins.id}/approve`)
      .send({ reason: 'ตรวจกรมธรรม์แล้วถูกต้อง' })
      .expect(403);
    const ok = await api(app, admin)
      .post(`/v1/carrier-doc-submissions/${ins.id}/approve`)
      .send({ reason: 'ตรวจกรมธรรม์แล้วถูกต้อง' })
      .expect(200);
    expect(ok.body).toMatchObject({
      status: 'approved',
      reviewReason: 'ตรวจกรมธรรม์แล้วถูกต้อง',
      resultDocumentId: expect.stringMatching(/^vdoc_/),
    });
    const doc = await api(app, admin)
      .get(`/v1/vehicle-documents/${ok.body.resultDocumentId}`)
      .expect(200);
    expect(doc.body).toMatchObject({
      docType: 'INSURANCE',
      status: 'active',
      isRequiredForDispatch: true,
    });
    expect(doc.body.files).toHaveLength(1);
    // พ.ร.บ. ยังรอตรวจ → ยังบล็อก
    expect((await check(vehA)).blocks.map((b) => b.code)).toEqual(['DOC_MISSING']);
    const cmi = subs.find((s) => s.docType === 'COMPULSORY_ACT')!;
    await api(app, admin)
      .post(`/v1/carrier-doc-submissions/${cmi.id}/approve`)
      .send({ reason: 'ตรวจ พ.ร.บ. แล้วถูกต้อง' })
      .expect(200);
    expect((await check(vehA)).assignable).toBe(true);
    await api(app, admin)
      .post(`/v1/carrier-doc-submissions/${cmi.id}/approve`)
      .send({ reason: 'ตรวจ พ.ร.บ. แล้วถูกต้อง' })
      .expect(409);
    await api(app, admin)
      .post(`/v1/carrier-doc-submissions/${cmi.id}/reject`)
      .send({ reason: 'ตรวจ พ.ร.บ. แล้วไม่ถูก' })
      .expect(409);
    const a = await db.auditLog.findFirst({
      where: {
        action: 'carrier_doc_submission.approved',
        entityId: tryDecodeId('carrierDocSubmission', ins.id)!,
      },
    });
    expect(a?.reason).toBe('ตรวจกรมธรรม์แล้วถูกต้อง');
    // หน้าลิงก์เห็นผล
    const v = await pub().get(`/v1/public/carrier-docs/${l.token}`).expect(200);
    expect(v.body.vehicles[0].items.map((i: { state: string }) => i.state)).toEqual(['ok', 'ok']);
  });

  it('ต่ออายุ: ส่งฉบับใหม่ของประเภทที่มีอยู่ → อนุมัติ = ต่ออายุฉบับเดิม (SUPERSEDED) · หมดไม่หลังฉบับเดิม → 422', async () => {
    const l = await issue();
    const bad = await submit(
      l.token,
      await insurance(l.token, { startsOn: today, expiresOn: addDays(today, 300) }),
    ).expect(422);
    expect(bad.body.errors[0].code).toBe('not_after_previous');
    await submit(
      l.token,
      await insurance(l.token, { startsOn: addDays(today, 365), expiresOn: addDays(today, 730) }),
    ).expect(201);
    const [s] = await pending();
    const r = await api(app, admin)
      .post(`/v1/carrier-doc-submissions/${s!.id}/approve`)
      .send({ reason: 'ต่ออายุกรมธรรม์ปีหน้า' })
      .expect(200);
    const doc = await api(app, admin)
      .get(`/v1/vehicle-documents/${r.body.resultDocumentId}`)
      .expect(200);
    expect(doc.body.renewsDocumentId).toMatch(/^vdoc_/);
    const prev = await api(app, admin)
      .get(`/v1/vehicle-documents/${doc.body.renewsDocumentId}`)
      .expect(200);
    expect(prev.body.status).toBe('superseded');
  });

  it('ไม่อนุมัติต้องมีเหตุผล (≥ 10) + audit · รถร่วมเห็นเหตุผล · ส่งใหม่ได้', async () => {
    const l = await issue();
    await submit(l.token, {
      driverId: drvA,
      docType: 'DRIVER_LICENCE',
      docNo: 'DL-2569-0001',
      expiresOn: addDays(today, 1800),
      fileDocumentIds: [await upload(l.token)],
    }).expect(201);
    const [s] = await pending();
    expect(s!.docType).toBe('DRIVER_LICENCE');
    await api(app, admin).post(`/v1/carrier-doc-submissions/${s!.id}/reject`).send({}).expect(422);
    await api(app, admin)
      .post(`/v1/carrier-doc-submissions/${s!.id}/reject`)
      .send({ reason: 'ไม่ชัด' })
      .expect(422);
    const r = await api(app, admin)
      .post(`/v1/carrier-doc-submissions/${s!.id}/reject`)
      .send({ reason: 'รูปไม่ชัด ถ่ายใหม่ให้เห็นวันหมด' })
      .expect(200);
    expect(r.body.status).toBe('rejected');
    expect(
      await db.auditLog.count({
        where: {
          action: 'carrier_doc_submission.rejected',
          reason: 'รูปไม่ชัด ถ่ายใหม่ให้เห็นวันหมด',
        },
      }),
    ).toBe(1);
    const v = await pub().get(`/v1/public/carrier-docs/${l.token}`).expect(200);
    expect(v.body.submissions[0]).toMatchObject({
      status: 'rejected',
      rejectReason: 'รูปไม่ชัด ถ่ายใหม่ให้เห็นวันหมด',
    });
    // ใบขับขี่ไม่เปลี่ยน (ยังใกล้หมด) — ส่งใหม่แล้วอนุมัติ → อัปเดตคนขับ
    expect(v.body.drivers[0].licence.state).toBe('expiring');
    await submit(l.token, {
      driverId: drvA,
      docType: 'DRIVER_LICENCE',
      docNo: 'DL-2569-0002',
      expiresOn: addDays(today, 1800),
      fileDocumentIds: [await upload(l.token)],
    }).expect(201);
    const [s2] = await pending();
    await api(app, admin)
      .post(`/v1/carrier-doc-submissions/${s2!.id}/approve`)
      .send({ reason: 'ตรวจใบขับขี่แล้วถูกต้อง' })
      .expect(200);
    const d = await api(app, admin).get(`/v1/drivers/${drvA}`).expect(200);
    expect(d.body).toMatchObject({
      licenceNo: 'DL-2569-0002',
      licenceExpiresOn: addDays(today, 1800),
    });
    expect((await check(vehA, drvA)).assignable).toBe(true);
  });

  it('ไฟล์: ตรวจชนิดจริง (ปลอม PDF → 422) · ยังไม่อัปโหลดเนื้อไฟล์ส่งไม่ได้ · เพดานไฟล์ต่อลิงก์ → 429', async () => {
    const l = await issue();
    const r = await pub()
      .post(`/v1/public/carrier-docs/${l.token}/files`)
      .send({ mime: 'application/pdf', bytes: PNG_HEADER.length })
      .expect(201);
    await pub()
      .put(path(r.body.uploadUrl))
      .set('Content-Type', 'application/octet-stream')
      .send(PNG_HEADER)
      .expect(422);
    const s = await submit(
      l.token,
      await insurance(l.token, {
        docType: 'COMPULSORY_ACT',
        startsOn: addDays(today, 365),
        expiresOn: addDays(today, 800),
        fileDocumentIds: [r.body.id],
      }),
    ).expect(422);
    expect(s.body.errors[0].code).toBe('not_uploaded');
    await pub()
      .post(`/v1/public/carrier-docs/${l.token}/files`)
      .send({ mime: 'text/csv', bytes: 10 })
      .expect(422);
    await pub()
      .post(`/v1/public/carrier-docs/${l.token}/files`)
      .send({ mime: 'application/pdf', bytes: 11 * 1024 * 1024 })
      .expect(422);
    const l2 = await issue();
    for (let i = 0; i < LINK_FILES_PER_HOUR; i++)
      await pub()
        .post(`/v1/public/carrier-docs/${l2.token}/files`)
        .send({ mime: 'application/pdf', bytes: 10 })
        .expect(201);
    await pub()
      .post(`/v1/public/carrier-docs/${l2.token}/files`)
      .send({ mime: 'application/pdf', bytes: 10 })
      .expect(429);
  });

  it('rate limit ต่อ IP ของ /v1/public/* ครอบหน้าลิงก์นี้ (429 + Retry-After)', async () => {
    const l = await issue();
    for (let i = 0; i < PUBLIC_LIMIT_PER_MIN; i++)
      await pub().get(`/v1/public/carrier-docs/${l.token}`);
    const r = await pub().get(`/v1/public/carrier-docs/${l.token}`).expect(429);
    expect(r.headers['retry-after']).toBeDefined();
  });
});
