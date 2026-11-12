import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import {
  AssignabilityService,
  type AssignabilityCheckInput,
} from '../src/modules/assignability/assignability.service';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/** ST2-T20 รถร่วมแบบย่อ: เอกสารบังคับก่อนรับงาน — docs/04 B2.1 รถร่วม (SUBCONTRACT), B2.3 D, docs/01 §3.8 */
describe('เอกสารบังคับก่อนรับงาน (AssignabilityService.isAssignable)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherTenantId: string;
  let admin: string;
  let other: string;
  let svc: AssignabilityService;
  let dbs: DbService;
  let vt: string;
  let carrier: string;
  let seed = 0;
  /** คำนวณใหม่ทุก test + ส่งให้ service ตรง (กันข้ามเที่ยงคืนระหว่างรัน) */
  let today = bangkokToday();
  beforeEach(() => {
    today = bangkokToday();
  });

  beforeAll(async () => {
    process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-files-'));
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    otherTenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherTenantId);
    svc = app.get(AssignabilityService);
    dbs = app.get(DbService);
    vt = (
      await api(app, admin)
        .post('/v1/vehicle-types')
        .send({ name: '6 ล้อ รถร่วม', vehicleClass: '6W', payloadKg: 6000, minLicenceClass: 'T2' })
        .expect(201)
    ).body.id;
    carrier = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({
          legalName: 'นายรถร่วม ทดสอบเอกสาร',
          entityType: 'INDIVIDUAL',
          taxId: validTaxId(91),
        })
        .expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const uuid = (kind: 'vehicle' | 'driver', id: string) => tryDecodeId(kind, id)!;
  const vehicle = async (token = admin, extra: object = {}) =>
    (
      await api(app, token)
        .post('/v1/vehicles')
        .send({
          plate: `82-${String(++seed).padStart(4, '0')}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt,
          ownership: 'SUBCONTRACT',
          carrierId: carrier,
          ...extra,
        })
        .expect(201)
    ).body as { id: string; plate: string };
  const path = (url: string) => new URL(url).pathname + new URL(url).search;
  const upload = async () => {
    const r = await api(app, admin)
      .post('/v1/documents')
      .send({
        kind: 'VEHICLE_DOC',
        mime: 'application/pdf',
        bytes: PDF.length,
        filename: 'doc.pdf',
      })
      .expect(201);
    await request(app.getHttpServer())
      .put(path(r.body.uploadUrl))
      .set('Content-Type', 'application/octet-stream')
      .send(PDF)
      .expect(200);
    return r.body.id as string;
  };
  /** เพิ่มเอกสาร: หมดในอีก `expires` วัน (ติดลบ = หมดแล้ว) */
  const addDoc = async (vehicleId: string, docType: string, expires: number, extra: object = {}) =>
    (
      await api(app, admin)
        .post(`/v1/vehicles/${vehicleId}/documents`)
        .send({
          docType,
          docNo: `${docType}-${++seed}`,
          startsOn: addDays(today, Math.min(expires - 365, -30)),
          expiresOn: addDays(today, expires),
          fileDocumentIds: [await upload()],
          ...extra,
        })
        .expect(201)
    ).body as { id: string };
  const driver = async (licenceExpiresOn: string) =>
    (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: `คนขับรถร่วม ${++seed}`,
          phone: `089-${String(seed).padStart(3, '0')}-${String(seed).padStart(4, '0')}`,
          employmentType: 'CARRIER_DRIVER',
          carrierId: carrier,
          licenceClass: 'T2',
          licenceExpiresOn,
        })
        .expect(201)
    ).body as { id: string };
  const check = (input: AssignabilityCheckInput, tenant = tenantId) =>
    dbs.withTenant(tenant, (tx) =>
      svc.isAssignable(input.date || input.window ? input : { ...input, date: today }, tx),
    );
  const writes = async () => ({
    audit: await db.auditLog.count({ where: { tenantId } }),
    docs: await db.vehicleDocument.count({ where: { tenantId } }),
    events: await db.domainEvent.count({ where: { tenantId } }),
  });

  it('เกณฑ์ตรวจรับ: รถร่วมที่ พ.ร.บ. หมดอายุ → assignable = false พร้อมเหตุ (ไม่เขียนข้อมูล)', async () => {
    const v = await vehicle();
    await addDoc(v.id, 'INSURANCE', 200);
    const cmi = await addDoc(v.id, 'COMPULSORY_ACT', -3);
    const before = await writes();

    const r = await check({ vehicleId: uuid('vehicle', v.id) });
    expect(r).toMatchObject({
      vehicle: { id: v.id, plate: v.plate, ownership: 'SUBCONTRACT', carrierId: carrier },
      driver: null,
      window: { from: today, to: today },
      assignable: false,
      warnings: [],
      overridable: true,
      override: { permission: 'users:write', roles: ['owner', 'admin'], reasonMinLength: 10 },
    });
    expect(r.blocks).toEqual([
      {
        code: 'DOC_CMI_EXPIRED',
        severity: 'block',
        messageKey: 'assign.docExpired',
        params: { docType: 'COMPULSORY_ACT', expiredOn: addDays(today, -3) },
        docType: 'COMPULSORY_ACT',
        expiredOn: addDays(today, -3),
        documentId: cmi.id,
        message: expect.stringMatching(/^พ\.ร\.บ\. หมดอายุ \d{1,2} \S+ 25\d\d$/),
      },
    ]);
    expect(await writes()).toEqual(before);
  });

  it('ไม่มีประกันภัย → DOC_MISSING · ใบขับขี่คนขับหมด → DRIVER_LICENCE_EXPIRED · ไม่มีวันหมด → DRIVER_LICENCE_MISSING', async () => {
    const v = await vehicle();
    await addDoc(v.id, 'COMPULSORY_ACT', 100);
    const expired = await driver(addDays(today, -1));
    const r = await check({
      vehicleId: uuid('vehicle', v.id),
      driverId: uuid('driver', expired.id),
    });
    expect(r.assignable).toBe(false);
    expect(r.driver?.id).toBe(expired.id);
    expect(r.blocks.map((b) => [b.code, b.message])).toEqual([
      ['DOC_MISSING', 'ยังไม่มี ประกันภัย ในระบบ — รถร่วมต้องมีเอกสารนี้ก่อนรับงาน'],
      ['DRIVER_LICENCE_EXPIRED', expect.stringMatching(/^ใบขับขี่คนขับหมดอายุ /)],
    ]);

    // API บังคับวันหมดตอนสร้าง — ข้อมูลเก่า/นำเข้าอาจว่าง (คอลัมน์ null ได้) จึงตั้งตรงในฐาน
    const noExpiry = await driver(addDays(today, 100));
    await db.driver.update({
      where: { id: uuid('driver', noExpiry.id) },
      data: { licenceExpiresAt: null },
    });
    const r2 = await check({
      vehicleId: uuid('vehicle', v.id),
      driverId: uuid('driver', noExpiry.id),
    });
    expect(r2.blocks.map((b) => b.code)).toEqual(['DOC_MISSING', 'DRIVER_LICENCE_MISSING']);
  });

  it('ต่ออายุ พ.ร.บ. แล้ว → บล็อกหายไป; ตรวจวันวิ่งในอดีตใช้ฉบับเดิมได้ · วันวิ่งหลังวันหมด = บล็อก', async () => {
    const v = await vehicle();
    await addDoc(v.id, 'INSURANCE', 400);
    const old = await addDoc(v.id, 'COMPULSORY_ACT', -1);
    const ok = await driver(addDays(today, 900));
    const input = { vehicleId: uuid('vehicle', v.id), driverId: uuid('driver', ok.id) };
    expect((await check(input)).blocks.map((b) => b.code)).toEqual(['DOC_CMI_EXPIRED']);

    await api(app, admin)
      .post(`/v1/vehicle-documents/${old.id}/renew`)
      .send({
        docNo: 'CMI-RENEWED',
        startsOn: today,
        expiresOn: addDays(today, 364),
        fileDocumentIds: [await upload()],
      })
      .expect(201);
    const after = await check(input);
    expect(after).toMatchObject({ assignable: true, blocks: [], warnings: [] });
    // วันวิ่งย้อนหลัง (ฉบับเดิมยังคุ้มครอง) · วันวิ่งหลังฉบับใหม่หมด
    expect((await check({ ...input, date: addDays(today, -10) })).assignable).toBe(true);
    const late = await check({ ...input, date: addDays(today, 366) });
    expect(late.blocks.map((b) => b.code)).toEqual(['DOC_CMI_EXPIRED']);
    // Date → วันไทย (17:00Z = วันถัดไปตามเวลาไทย)
    const d = await check({ ...input, date: new Date(`${addDays(today, 364)}T17:00:00Z`) });
    expect(d.window).toEqual({ from: addDays(today, 365), to: addDays(today, 365) });
    expect(d.assignable).toBe(false);
  });

  it('ช่วงวิ่ง: ประกันหมดก่อนสิ้นช่วง → บล็อก · ช่วงกลับด้าน → 422', async () => {
    const v = await vehicle();
    await addDoc(v.id, 'INSURANCE', 3);
    await addDoc(v.id, 'COMPULSORY_ACT', 300);
    const id = uuid('vehicle', v.id);
    expect(
      (await check({ vehicleId: id, window: { from: today, to: addDays(today, 3) } })).assignable,
    ).toBe(true);
    const r = await check({ vehicleId: id, window: { from: today, to: addDays(today, 5) } });
    expect(r.window).toEqual({ from: today, to: addDays(today, 5) });
    expect(r.blocks.map((b) => [b.code, b.expiredOn])).toEqual([
      ['DOC_INSURANCE_EXPIRED', addDays(today, 3)],
    ]);
    await expect(
      check({ vehicleId: id, window: { from: addDays(today, 2), to: today } }),
    ).rejects.toMatchObject({ code: 'validation_failed', errors: [{ field: 'window' }] });
  });

  it('รถ/คนขับที่ลบแล้ว (soft delete) → 404', async () => {
    const v = await vehicle();
    const d = await driver(addDays(today, 500));
    const input = { vehicleId: uuid('vehicle', v.id), driverId: uuid('driver', d.id) };
    expect((await check(input)).driver?.id).toBe(d.id);
    await api(app, admin)
      .post(`/v1/drivers/${d.id}/delete`)
      .send({ reason: 'สร้างผิด ลบทิ้ง ทดสอบ' })
      .expect(204);
    await expect(check(input)).rejects.toMatchObject({ code: 'not_found' });
    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/delete`)
      .send({ reason: 'สร้างผิด ลบทิ้ง ทดสอบ' })
      .expect(204);
    await expect(check({ vehicleId: input.vehicleId })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('รถบริษัท: เอกสารบังคับหมด = คำเตือน ไม่บล็อก · ไม่มีเอกสาร = ไม่เตือน', async () => {
    const own = await vehicle(admin, { ownership: 'OWN', carrierId: undefined });
    const empty = await check({ vehicleId: uuid('vehicle', own.id) });
    expect(empty).toMatchObject({ assignable: true, blocks: [], warnings: [] });
    await addDoc(own.id, 'INSURANCE', -5);
    const r = await check({ vehicleId: uuid('vehicle', own.id) });
    expect(r.assignable).toBe(true);
    expect(r.warnings.map((w) => [w.code, w.severity])).toEqual([
      ['DOC_INSURANCE_EXPIRED', 'warning'],
    ]);
    // ตรอ. ที่ตั้งบังคับก่อนจ่ายงาน — ข้อความเว้นวรรคระหว่างชื่อเอกสารกับคำกริยา
    await addDoc(own.id, 'INSPECTION', -2, { isRequiredForDispatch: true });
    const r2 = await check({ vehicleId: uuid('vehicle', own.id) });
    expect(r2.warnings.map((w) => w.message)[1]).toMatch(/^ตรวจสภาพ ตรอ\. หมดอายุ /);
  });

  it('id ของ tenant อื่น / ไม่มีอยู่ / ผิดรูปแบบ → 404 · วันที่ผิด → 422', async () => {
    const mine = await vehicle();
    const theirVt = (
      await api(app, other)
        .post('/v1/vehicle-types')
        .send({ name: '6 ล้อ อื่น', vehicleClass: '6W', payloadKg: 6000, minLicenceClass: 'T2' })
        .expect(201)
    ).body.id as string;
    const theirs = await vehicle(other, {
      vehicleTypeId: theirVt,
      carrierId: undefined,
      ownership: 'OWN',
    });
    const theirDriver = (
      await api(app, other)
        .post('/v1/drivers')
        .send({
          name: 'คนขับอื่น',
          phone: '0891112222',
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: '2028-03-31',
        })
        .expect(201)
    ).body as { id: string };
    const status = (p: Promise<unknown>) =>
      p.then(
        () => 200,
        (e: { getStatus?: () => number }) => e.getStatus?.() ?? 500,
      );
    expect(await status(check({ vehicleId: uuid('vehicle', theirs.id) }))).toBe(404);
    expect(
      await status(
        check({ vehicleId: uuid('vehicle', mine.id), driverId: uuid('driver', theirDriver.id) }),
      ),
    ).toBe(404);
    expect(await status(check({ vehicleId: '00000000-0000-4000-8000-000000000000' }))).toBe(404);
    expect(await status(check({ vehicleId: 'veh_xyz' }))).toBe(404);
    expect(await status(check({ vehicleId: uuid('vehicle', mine.id), date: '2026-02-31' }))).toBe(
      422,
    );
    expect(
      await status(check({ vehicleId: uuid('vehicle', mine.id), date: new Date('not a date') })),
    ).toBe(422);
    // tenant เจ้าของเห็นปกติ
    expect((await check({ vehicleId: uuid('vehicle', theirs.id) }, otherTenantId)).vehicle.id).toBe(
      theirs.id,
    );
  });
});
