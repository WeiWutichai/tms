import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
