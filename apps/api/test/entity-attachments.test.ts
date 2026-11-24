import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signStepUpToken } from '../src/auth/tokens';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

/**
 * ไฟล์แนบของคนขับ / ผู้รับเหมา (PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ — docs/04 B "รูปใบขับขี่/บัตร", "ภ.พ.20 / สัญญาจ้าง")
 * อัปโหลดผ่าน /v1/documents → ผูก · รายการ · เอาออก (เหตุผล + audit ไม่ลบไฟล์) · สิทธิ์ · แยก tenant
 */
describe('entity attachments (driver / carrier)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let viewer: string;
  let otherAdmin: string;
  let driverId: string;
  let carrierId: string;
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

  const jurTax = (n: number) => {
    const base = `0105${String(n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId);
    viewer = await tokenFor(tenantId, 'master:read', 'user-viewer');
    otherAdmin = await tokenFor((await createTenant(db)).id);
    carrierId = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({ legalName: 'หจก. ไฟล์แนบทดสอบ', entityType: 'JURISTIC', taxId: jurTax(77) })
        .expect(201)
    ).body.id;
    driverId = (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: 'สมชาย ไฟล์แนบ',
          phone: '0812223333',
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: '2028-03-31',
        })
        .expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  /** จอง + อัปโหลดเนื้อไฟล์ → id */
  const upload = async (entityType?: string, token = admin) => {
    const r = await api(app, token)
      .post('/v1/documents')
      .send({
        kind: 'OTHER',
        mime: 'application/pdf',
        bytes: PDF.length,
        filename: 'vat-reg.pdf',
        ...(entityType ? { entityType } : {}),
      })
      .expect(201);
    const u = new URL(r.body.uploadUrl);
    await request(app.getHttpServer())
      .put(u.pathname + u.search)
      .set('Content-Type', 'application/octet-stream')
      .send(PDF)
      .expect(200);
    return r.body.id as string;
  };

  it('ผู้รับเหมา: แนบ ภ.พ.20 → รายการ · ไฟล์ผูกแล้วแนบที่อื่นไม่ได้ · เอาออกต้องมีเหตุผล → ไม่ลบไฟล์ + audit', async () => {
    const doc = await upload('carrier');
    const r = await api(app, admin)
      .post(`/v1/carriers/${carrierId}/attachments`)
      .send({ documentId: doc, attachType: 'VAT_REG' })
      .expect(200);
    expect(r.body.data).toEqual([
      expect.objectContaining({ id: doc, attachType: 'VAT_REG', filename: 'vat-reg.pdf' }),
    ]);
    // ผูกกับคนขับไม่ได้ (ไฟล์ของผู้รับเหมา)
    expect(
      (
        await api(app, admin)
          .post(`/v1/drivers/${driverId}/attachments`)
          .send({ documentId: doc, attachType: 'LICENCE' })
          .expect(422)
      ).body.errors[0],
    ).toMatchObject({ field: 'documentId', code: 'already_linked' });
    // ยังไม่อัปโหลด → not_ready
    const pending = (
      await api(app, admin)
        .post('/v1/documents')
        .send({ kind: 'OTHER', mime: 'application/pdf', bytes: 10 })
        .expect(201)
    ).body.id;
    expect(
      (
        await api(app, admin)
          .post(`/v1/carriers/${carrierId}/attachments`)
          .send({ documentId: pending, attachType: 'CONTRACT' })
          .expect(422)
      ).body.errors[0],
    ).toMatchObject({ code: 'not_ready' });
    await api(app, admin)
      .post(`/v1/carriers/${carrierId}/attachments/remove`)
      .send({ documentId: doc, reason: 'สั้น' })
      .expect(422);
    const out = await api(app, admin)
      .post(`/v1/carriers/${carrierId}/attachments/remove`)
      .send({ documentId: doc, reason: 'แนบผิดไฟล์ ใช้ฉบับใหม่แทน' })
      .expect(200);
    expect(out.body.data).toEqual([]);
    const row = await db.storedDocument.findFirstOrThrow({
      where: { id: tryDecodeId('document', doc)! },
    });
    expect(row.status).toBe('READY');
    expect(row.metadata).toMatchObject({
      attachType: 'VAT_REG',
      removed: { reason: 'แนบผิดไฟล์ ใช้ฉบับใหม่แทน' },
    });
    const audit = await db.auditLog.findMany({
      where: { tenantId, entityType: 'carrier', action: { startsWith: 'carrier.attachment_' } },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'carrier.attachment_added',
      'carrier.attachment_removed',
    ]);
    // เอาออกซ้ำ → 422
    await api(app, admin)
      .post(`/v1/carriers/${carrierId}/attachments/remove`)
      .send({ documentId: doc, reason: 'แนบผิดไฟล์ ใช้ฉบับใหม่แทน' })
      .expect(422);
  });

  it('คนขับ: แนบรูปใบขับขี่ (ไฟล์ไม่ระบุ entityType) · ผู้ดูอ่านได้แก้ไม่ได้ · ประเภทนอกชุด → 422', async () => {
    const doc = await upload();
    await api(app, admin)
      .post(`/v1/drivers/${driverId}/attachments`)
      .send({ documentId: doc, attachType: 'VAT_REG' })
      .expect(422);
    await api(app, admin)
      .post(`/v1/drivers/${driverId}/attachments`)
      .send({ documentId: doc, attachType: 'LICENCE' })
      .expect(200);
    const list = await api(app, viewer).get(`/v1/drivers/${driverId}/attachments`).expect(200);
    expect(list.body.data.map((x: { attachType: string }) => x.attachType)).toEqual(['LICENCE']);
    await api(app, viewer)
      .post(`/v1/drivers/${driverId}/attachments`)
      .send({ documentId: doc, attachType: 'LICENCE' })
      .expect(403);
  });

  it('แยก tenant: บริษัทอื่นดู/แนบ/เอาออก → 404 · ไฟล์ของบริษัทอื่นแนบไม่ได้', async () => {
    await api(app, otherAdmin).get(`/v1/drivers/${driverId}/attachments`).expect(404);
    await api(app, otherAdmin).get(`/v1/carriers/${carrierId}/attachments`).expect(404);
    const foreign = await upload(undefined, otherAdmin);
    expect(
      (
        await api(app, admin)
          .post(`/v1/drivers/${driverId}/attachments`)
          .send({ documentId: foreign, attachType: 'OTHER' })
          .expect(422)
      ).body.errors[0],
    ).toMatchObject({ code: 'not_found' });
    await api(app, admin)
      .get(`/v1/drivers/${encodeId('driver', '00000000-0000-4000-8000-000000000000')}/attachments`)
      .expect(404);
  });

  it('review round 2 #5/#6: แนบไฟล์ที่เอาออกกลับมา = ล้างธง + audit restored · ผูกพร้อมกันสองที่ได้ที่เดียว · ไฟล์ระบบ/ชนิดอื่นผูกไม่ได้', async () => {
    const doc = await upload('carrier');
    await api(app, admin)
      .post(`/v1/carriers/${carrierId}/attachments`)
      .send({ documentId: doc, attachType: 'CONTRACT' })
      .expect(200);
    await api(app, admin)
      .post(`/v1/carriers/${carrierId}/attachments/remove`)
      .send({ documentId: doc, reason: 'เอาออกชั่วคราวเพื่อทดสอบ' })
      .expect(200);
    const back = await api(app, admin)
      .post(`/v1/carriers/${carrierId}/attachments`)
      .send({ documentId: doc, attachType: 'CONTRACT' })
      .expect(200);
    expect(back.body.data.map((x: { id: string }) => x.id)).toContain(doc);
    const row = await db.storedDocument.findFirstOrThrow({
      where: { id: tryDecodeId('document', doc)! },
    });
    expect((row.metadata as Record<string, unknown>).removed).toBeUndefined();
    expect(
      await db.auditLog.count({ where: { tenantId, action: 'carrier.attachment_restored' } }),
    ).toBe(1);

    // ผูกพร้อมกัน: ไฟล์เดียว → คนขับ + ผู้รับเหมา → สำเร็จที่เดียว
    const free = await upload();
    const rs = await Promise.all([
      api(app, admin)
        .post(`/v1/drivers/${driverId}/attachments`)
        .send({ documentId: free, attachType: 'OTHER' }),
      api(app, admin)
        .post(`/v1/carriers/${carrierId}/attachments`)
        .send({ documentId: free, attachType: 'OTHER' }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 422]);

    // ไฟล์ชนิดอื่น (หลักฐานส่ง) ผูกไม่ได้
    const pod = await db.storedDocument.create({
      data: {
        tenantId,
        status: 'READY',
        kind: 'POD_PHOTO',
        mimeType: 'image/png',
        sizeBytes: 10,
        fileKey: 'k/pod-att',
        sha256: 'x'.repeat(64),
      },
    });
    expect(
      (
        await api(app, admin)
          .post(`/v1/drivers/${driverId}/attachments`)
          .send({ documentId: encodeId('document', pod.id), attachType: 'OTHER' })
          .expect(422)
      ).body.errors[0],
    ).toMatchObject({ code: 'not_allowed' });
    // ไฟล์ที่ผูกเป็นไฟล์แนบแล้วใช้เป็นรูปรถไม่ได้
    const img = await db.storedDocument.create({
      data: {
        tenantId,
        status: 'READY',
        kind: 'OTHER',
        mimeType: 'image/png',
        sizeBytes: 10,
        fileKey: 'k/att-img',
        sha256: 'y'.repeat(64),
        entityType: 'driver',
        entityId: tryDecodeId('driver', driverId)!,
      },
    });
    const vt = (
      await api(app, admin)
        .post('/v1/vehicle-types')
        .send({ name: '6 ล้อ ไฟล์แนบ', vehicleClass: '6W', payloadKg: 6000, minLicenceClass: 'T2' })
        .expect(201)
    ).body.id as string;
    expect(
      (
        await api(app, admin)
          .post('/v1/vehicles')
          .send({
            plate: '70-9911',
            plateProvince: 'TH-10',
            vehicleTypeId: vt,
            ownership: 'OWN',
            photoDocumentIds: [encodeId('document', img.id)],
          })
          .expect(422)
      ).body.errors[0],
    ).toMatchObject({ field: 'photoDocumentIds', code: 'already_linked' });
  });

  it('review round 2 #1 (D-67(4)/D-79/D-73): เปิดไฟล์หน้าสมุดบัญชีต้อง settlements:pay + step-up · API key ไม่ได้ · บัตรประชาชนต้อง pii.national_id:read', async () => {
    const bank = await upload('carrier');
    await api(app, admin)
      .post(`/v1/carriers/${carrierId}/attachments`)
      .send({ documentId: bank, attachType: 'BANK_BOOK' })
      .expect(200);
    const idc = await upload('driver');
    await api(app, admin)
      .post(`/v1/drivers/${driverId}/attachments`)
      .send({ documentId: idc, attachType: 'ID_CARD' })
      .expect(200);
    // รายการเห็นได้ (ไม่มี URL) แม้ไม่มีสิทธิ์ดูค่าเต็ม
    const list = await api(app, viewer).get(`/v1/carriers/${carrierId}/attachments`).expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/downloadUrl|content\?/);
    const docReader = await tokenFor(tenantId, 'documents:read master:read', 'user-reader');
    // หน้าสมุดบัญชี: ไม่มี settlements:pay → 404 · มีแต่ไม่ step-up → 403 · step-up → ได้ URL
    await api(app, docReader).get(`/v1/documents/${bank}`).expect(404);
    const payer = await tokenFor(tenantId, 'documents:read settlements:pay', 'user-payer');
    expect((await api(app, payer).get(`/v1/documents/${bank}`).expect(403)).body.code).toBe(
      'step_up_required',
    );
    const ok = await api(app, payer)
      .get(`/v1/documents/${bank}`)
      .set('X-Step-Up', await signStepUpToken('user-payer', tenantId))
      .expect(200);
    expect(ok.body.downloadUrl).toBeTruthy();
    // บัตรประชาชน: ไม่มี pii.national_id:read → 404 · มี → ได้
    await api(app, docReader).get(`/v1/documents/${idc}`).expect(404);
    const pii = await tokenFor(tenantId, 'documents:read pii.national_id:read', 'user-pii');
    expect(
      (await api(app, pii).get(`/v1/documents/${idc}`).expect(200)).body.downloadUrl,
    ).toBeTruthy();
    // API key: หน้าสมุดบัญชี → 403 bank_change_requires_user (D-79) · บัตร → 404 (D-73 — key มี scope pii ไม่ได้อยู่แล้ว)
    const userId = (
      await db.appUser.create({
        data: { tenantId, email: 'key-owner@att.test', name: 'เจ้าของ key', status: 'ACTIVE' },
      })
    ).id;
    const owner = await tokenFor(tenantId, '*', userId);
    const key = await api(app, owner)
      .post('/v1/api-keys')
      .set('X-Step-Up', await signStepUpToken(userId, tenantId))
      .send({
        name: 'k-att',
        scopes: ['documents:read', 'settlements:pay'],
      });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    const asKey = (url: string) =>
      request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${key.body.secret}`);
    expect((await asKey(`/v1/documents/${bank}`)).body.code).toBe('bank_change_requires_user');
    expect((await asKey(`/v1/documents/${idc}`)).status).toBe(404);
  });
});
