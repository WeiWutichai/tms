import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signDocumentUrl } from '../src/modules/documents/signed-url';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

/** ST1-T08: อัปโหลดไฟล์ปลอมนามสกุลถูกปฏิเสธ; URL ดาวน์โหลดหมดอายุตามเวลา */
describe('documents (presigned upload/download)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-files-'));
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    token = await tokenFor(tenantId, 'documents:read documents:write');
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const path = (url: string) => new URL(url).pathname + new URL(url).search;
  const reserve = (body: object) => api(app, token).post('/v1/documents').send(body);
  const put = (url: string, data: Buffer) =>
    request(app.getHttpServer())
      .put(path(url))
      .set('Content-Type', 'application/octet-stream')
      .send(data);

  it('จอง → อัปโหลด → ready → ดาวน์โหลดได้เนื้อเดิม พร้อม header ปลอดภัย', async () => {
    const r = await reserve({
      kind: 'PDF',
      mime: 'application/pdf',
      bytes: PDF.length,
      filename: 'ใบเสร็จ.pdf',
    }).expect(201);
    expect(r.body).toMatchObject({ status: 'pending', mime: 'application/pdf' });
    expect(r.body.id).toMatch(/^doc_[0-9a-f]{32}$/);
    const up = await put(r.body.uploadUrl, PDF).expect(200);
    expect(up.body.status).toBe('ready');
    expect(up.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    const meta = await api(app, token).get(`/v1/documents/${r.body.id}`).expect(200);
    expect(meta.body.downloadUrl).toBeTruthy();
    const dl = await request(app.getHttpServer())
      .get(path(meta.body.downloadUrl))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    // อัปโหลดซ้ำหลัง ready ไม่ได้ (ไฟล์เขียนครั้งเดียว)
    expect((await put(r.body.uploadUrl, PDF)).status).toBe(409);
  });

  it('ไฟล์ปลอมนามสกุล: ประกาศเป็น PNG แต่เนื้อเป็นข้อความ/PDF → 422 mime_mismatch และยังไม่ ready', async () => {
    const r = await reserve({ kind: 'POD_PHOTO', mime: 'image/png', bytes: 200 }).expect(201);
    const fake = await put(r.body.uploadUrl, Buffer.from('<script>alert(1)</script>'));
    expect(fake.status).toBe(422);
    expect(fake.body.errors[0].code).toBe('mime_mismatch');
    expect((await put(r.body.uploadUrl, PDF)).body.errors[0].code).toBe('mime_mismatch');
    const meta = await api(app, token).get(`/v1/documents/${r.body.id}`).expect(200);
    expect(meta.body.status).toBe('pending');
    await put(r.body.uploadUrl, PNG).expect(200);
  });

  it('ขนาด: เกินที่ประกาศ → 422; ประกาศเกิน 10 MB → 422; ชนิดที่ไม่รองรับ → 422', async () => {
    const r = await reserve({ kind: 'OTHER', mime: 'application/pdf', bytes: 10 }).expect(201);
    expect((await put(r.body.uploadUrl, PDF)).body.errors[0].code).toBe('file_too_large');
    expect(
      (await reserve({ kind: 'OTHER', mime: 'application/pdf', bytes: 10 * 1024 * 1024 + 1 }))
        .status,
    ).toBe(422);
    expect((await reserve({ kind: 'OTHER', mime: 'text/html', bytes: 10 })).status).toBe(422);
    // body เกิน 10 MB ถูกตัดตั้งแต่ตัวอ่าน body → 413 problem+json (ไม่ใช่ 500)
    const big = await reserve({
      kind: 'OTHER',
      mime: 'application/pdf',
      bytes: 10 * 1024 * 1024,
    }).expect(201);
    const huge = await put(big.body.uploadUrl, Buffer.alloc(10 * 1024 * 1024 + 10, 0x25));
    expect(huge.status).toBe(413);
    expect(huge.headers['content-type']).toContain('application/problem+json');
  });

  it('URL หมดอายุ / ลายเซ็นถูกแก้ / ใช้ URL อัปโหลดเป็นดาวน์โหลด → 404', async () => {
    const r = await reserve({ kind: 'PDF', mime: 'application/pdf', bytes: PDF.length }).expect(
      201,
    );
    await put(r.body.uploadUrl, PDF).expect(200);
    const id = r.body.id as string;
    const uuid = id.slice(4).replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
    const expired = signDocumentUrl('download', tenantId, uuid, -1);
    expect(
      (await request(app.getHttpServer()).get(`/v1/documents/${id}/content?${expired.query}`))
        .status,
    ).toBe(404);
    const ok = signDocumentUrl('download', tenantId, uuid, 60);
    const tampered = ok.query.replace(/sig=./, (m) => (m.endsWith('A') ? 'sig=B' : 'sig=A'));
    expect(
      (await request(app.getHttpServer()).get(`/v1/documents/${id}/content?${tampered}`)).status,
    ).toBe(404);
    const upAsDown = new URL(r.body.uploadUrl).search;
    expect(
      (await request(app.getHttpServer()).get(`/v1/documents/${id}/content${upAsDown}`)).status,
    ).toBe(404);
    await request(app.getHttpServer()).get(`/v1/documents/${id}/content?${ok.query}`).expect(200);
  });

  it('clientDocumentId ส่งซ้ำได้แถวเดิม; Viewer แนบไฟล์ไม่ได้; tenant อื่นอ่านไม่ได้', async () => {
    const a = await reserve({
      kind: 'POD_PHOTO',
      mime: 'image/png',
      bytes: 100,
      clientDocumentId: 'device-1:pod-0001',
    }).expect(201);
    const b = await reserve({
      kind: 'POD_PHOTO',
      mime: 'image/png',
      bytes: 100,
      clientDocumentId: 'device-1:pod-0001',
    }).expect(201);
    expect(b.body.id).toBe(a.body.id);
    const viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '));
    expect(
      (
        await api(app, viewer)
          .post('/v1/documents')
          .send({ kind: 'OTHER', mime: 'application/pdf', bytes: 10 })
      ).status,
    ).toBe(403);
    expect((await api(app, viewer).get(`/v1/documents/${a.body.id}`)).status).toBe(200);
    const other = await tokenFor((await createTenant(db)).id, 'documents:read');
    expect((await api(app, other).get(`/v1/documents/${a.body.id}`)).status).toBe(404);
  });
});
