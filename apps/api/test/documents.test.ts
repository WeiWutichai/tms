import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { signAccessToken } from '../src/auth/tokens';
import { tryDecodeId } from '../src/common/ids';
import { signDocumentUrl } from '../src/modules/documents/signed-url';
import { ImportRegistry } from '../src/modules/imports/import-spec';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
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
    const viewer = await tokenFor(
      tenantId,
      SYSTEM_ROLES.viewer.permissions.join(' '),
      'viewer-user',
    );
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

  it('review B1: คนอื่น/Viewer อ่านเอกสารที่ยัง pending ได้ แต่ไม่ได้ URL อัปโหลด', async () => {
    const r = await reserve({
      kind: 'WHT_CERT',
      mime: 'application/pdf',
      bytes: PDF.length,
    }).expect(201);
    const viewer = await tokenFor(
      tenantId,
      SYSTEM_ROLES.viewer.permissions.join(' '),
      'viewer-user',
    );
    const v = await api(app, viewer).get(`/v1/documents/${r.body.id}`).expect(200);
    expect(v.body.uploadUrl).toBeUndefined();
    const otherWriter = await tokenFor(tenantId, 'documents:read documents:write', 'someone-else');
    expect(
      (await api(app, otherWriter).get(`/v1/documents/${r.body.id}`)).body.uploadUrl,
    ).toBeUndefined();
    expect((await api(app, token).get(`/v1/documents/${r.body.id}`)).body.uploadUrl).toBeTruthy();
  });

  it('review S2: ใช้ clientDocumentId ของคนอื่น หรือข้อมูลไม่ตรงของเดิม → 409', async () => {
    await reserve({
      kind: 'POD_PHOTO',
      mime: 'image/png',
      bytes: 100,
      clientDocumentId: 'device-9:pod-0009',
    }).expect(201);
    const other = await tokenFor(tenantId, 'documents:read documents:write', 'someone-else');
    const stolen = await api(app, other).post('/v1/documents').send({
      kind: 'POD_PHOTO',
      mime: 'image/png',
      bytes: 100,
      clientDocumentId: 'device-9:pod-0009',
    });
    expect(stolen.status).toBe(409);
    const diff = await reserve({
      kind: 'CONTRACT',
      mime: 'application/pdf',
      bytes: 50,
      clientDocumentId: 'device-9:pod-0009',
    });
    expect(diff.status).toBe(409);
  });

  it('review S1: ลายเซ็นผิด → 404 โดยไม่อ่าน body (ไม่รอรับไฟล์ใหญ่)', async () => {
    const r = await reserve({ kind: 'PDF', mime: 'application/pdf', bytes: PDF.length }).expect(
      201,
    );
    const bad = path(r.body.uploadUrl).replace(/sig=[^&]+/, 'sig=x');
    // server ตอบ 404 และปิดก่อน client ส่ง body ครบ = ไม่ได้อ่าน body (EPIPE ฝั่ง client คือผลที่ต้องการ)
    const res = await request(app.getHttpServer())
      .put(bad)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(2 * 1024 * 1024, 1))
      .then(
        (r) => r.status,
        (e: NodeJS.ErrnoException) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? 404 : -1),
      );
    expect(res).toBe(404);
    const small = await request(app.getHttpServer())
      .put(bad)
      .set('Content-Type', 'application/octet-stream')
      .send(PDF);
    expect(small.status).toBe(404);
  });
});

/**
 * ST9-T16 R-1: ไฟล์ต้นฉบับที่นำเข้า (kind IMPORT — อาจมีเลขบัตร/เบอร์โทรเต็ม) ต้องไม่เปิดให้ทุก role ที่มี documents:read
 * เห็นได้เฉพาะผู้อัปโหลด หรือผู้ใช้ที่มีสิทธิ์จัดการการนำเข้าชนิดนั้น · API key/การเข้าใช้งานแทน/role อื่น/tenant อื่น → 404
 */
describe('documents: ไฟล์นำเข้า (IMPORT) เห็นเฉพาะผู้มีสิทธิ์ — ST9-T16 R-1', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let uploaderId: string;
  let uploader: string;
  let docId: string;
  const CSV = Buffer.from('รหัส,ชื่อ,เลขบัตร\nD001,สมชาย,1101700203451\n');
  const path = (url: string) => new URL(url).pathname + new URL(url).search;

  async function user(email: string) {
    return (await db.appUser.create({ data: { tenantId, email, name: email, status: 'ACTIVE' } }))
      .id;
  }

  beforeAll(async () => {
    process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-files-'));
    await truncateAll();
    app = await bootApp();
    const spec = (kind: string, scope: string, feature?: string) =>
      ({
        kind,
        label: 'ทดสอบสิทธิ์ไฟล์นำเข้า',
        scope,
        ...(feature ? { feature } : {}),
        columns: [{ key: 'code', header: 'รหัส', required: true }],
        validate: async (_ctx: unknown, rows: unknown[]) => rows.map(() => ({ issues: [] })),
        commit: async () => ({ created: 0 }),
      }) as never;
    const reg = app.get(ImportRegistry);
    reg.register(spec('doc_access_test', 'settings:write'));
    reg.register(spec('doc_access_master', 'master:write'));
    // ฟีเจอร์ที่ไม่มีแพ็กเกจไหนเปิด = แพ็กเกจปิด
    reg.register(spec('doc_access_feature', 'settings:write', 'test.not_in_any_plan'));
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท นำเข้า' })).id;
    uploaderId = await user('uploader@a.test');
    uploader = await tokenFor(
      tenantId,
      'documents:read documents:write settings:write',
      uploaderId,
    );
    docId = await upload();
  });
  async function upload(): Promise<string> {
    const r = await api(app, uploader)
      .post('/v1/documents')
      .send({ kind: 'IMPORT', mime: 'text/csv', bytes: CSV.length, filename: 'คนขับ.csv' })
      .expect(201);
    await request(app.getHttpServer())
      .put(path(r.body.uploadUrl))
      .set('Content-Type', 'application/octet-stream')
      .send(CSV)
      .expect(200);
    return r.body.id;
  }
  const jobFor = (id: string, kind: string) =>
    db.importJob.create({
      data: {
        tenantId,
        kind,
        documentId: tryDecodeId('document', id)!,
        expiresAt: new Date(Date.now() + 3600_000),
        createdBy: uploaderId,
      },
    });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const get = (token: string) => api(app, token).get(`/v1/documents/${docId}`);

  it('ผู้อัปโหลด → 200 พร้อม downloadUrl ที่ดาวน์โหลดได้', async () => {
    const r = await get(uploader).expect(200);
    expect(r.body.kind).toBe('IMPORT');
    // ลิงก์ไฟล์นำเข้าอายุสั้น (60 วินาที — review L-b)
    const ttl = (new Date(r.body.urlExpiresAt).getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(61);
    await request(app.getHttpServer()).get(path(r.body.downloadUrl)).expect(200);
  });

  it('viewer / role อื่นที่มี documents:read แต่ไม่มีสิทธิ์จัดการการนำเข้า → 404', async () => {
    const viewer = await tokenFor(
      tenantId,
      SYSTEM_ROLES.viewer.permissions.join(' '),
      await user('viewer@a.test'),
    );
    expect((await get(viewer)).status).toBe(404);
    const dispatcher = await tokenFor(
      tenantId,
      'documents:read documents:write orders:read',
      await user('disp@a.test'),
    );
    const r = await get(dispatcher);
    expect(r.status).toBe(404);
    expect(r.body.downloadUrl).toBeUndefined();
  });

  it('ผู้มีสิทธิ์จัดการการนำเข้าชนิดที่ใช้ไฟล์นี้ → 200 (ยังไม่มีงานนำเข้าอ้างถึง → 404)', async () => {
    const manager = await tokenFor(
      tenantId,
      'documents:read settings:write',
      await user('manager@a.test'),
    );
    expect((await get(manager)).status).toBe(404);
    await jobFor(docId, 'doc_access_test');
    expect((await get(manager)).status).toBe(200);
    // ชนิดที่ไม่รู้จัก/ไม่มีสิทธิ์ของงานนำเข้า ไม่เปิดให้ role ที่ไม่มี scope ของชนิดนั้น
    const other = await tokenFor(tenantId, 'documents:read master:write', await user('m2@a.test'));
    expect((await get(other)).status).toBe(404);
  });

  it('ไฟล์เดียวถูกอ้างโดยหลายชนิดการนำเข้า → ต้องมีสิทธิ์ทุกชนิด (ผู้อัปโหลดเห็นเสมอ)', async () => {
    const id = await upload();
    await jobFor(id, 'doc_access_test');
    await jobFor(id, 'doc_access_master');
    const at = (t: string) => api(app, t).get(`/v1/documents/${id}`);
    const settingsOnly = await tokenFor(
      tenantId,
      'documents:read settings:write',
      await user('multi1@a.test'),
    );
    const masterOnly = await tokenFor(
      tenantId,
      'documents:read master:write',
      await user('multi2@a.test'),
    );
    const both = await tokenFor(
      tenantId,
      'documents:read settings:write master:write',
      await user('multi3@a.test'),
    );
    expect((await at(settingsOnly)).status).toBe(404);
    expect((await at(masterOnly)).status).toBe(404);
    expect((await at(both)).status).toBe(200);
    // ผู้อัปโหลดไม่มี master:write แต่ยังเห็นไฟล์ของตัวเอง
    expect((await at(uploader)).status).toBe(200);
  });

  it('ชนิดการนำเข้าที่ฟีเจอร์ไม่อยู่ในแพ็กเกจ → 404 แม้มี scope', async () => {
    const id = await upload();
    await jobFor(id, 'doc_access_feature');
    const manager = await tokenFor(
      tenantId,
      'documents:read settings:write',
      await user('feat@a.test'),
    );
    expect((await api(app, manager).get(`/v1/documents/${id}`)).status).toBe(404);
    expect((await api(app, uploader).get(`/v1/documents/${id}`)).status).toBe(200);
  });

  it('API key (มี documents:read) อ่านไฟล์นำเข้าของผู้ใช้ไม่ได้ → 404', async () => {
    const admin = await tokenFor(tenantId, '*', uploaderId);
    const k = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'ERP', scopes: ['documents:read', 'documents:write', 'master:write'] });
    expect(k.status, JSON.stringify(k.body)).toBe(201);
    const r = await request(app.getHttpServer())
      .get(`/v1/documents/${docId}`)
      .set('Authorization', `Bearer ${k.body.secret}`);
    expect(r.status).toBe(404);
  });

  it('การเข้าใช้งานแทน (ทีม Innovera) ในนามผู้อัปโหลด → 404', async () => {
    const staff = await db.platformUser.create({
      data: {
        email: `support-${Date.now()}@innovera.test`,
        name: 'ทีม SUPPORT',
        role: 'SUPPORT',
        passwordHash: 'x',
        totpSecret: 'x',
      },
    });
    const roles = await ensureSystemRoles(db, tenantId);
    await db.userRole.create({ data: { tenantId, userId: uploaderId, roleId: roles.admin! } });
    const s = await db.impersonationSession.create({
      data: {
        platformUserId: staff.id,
        tenantId,
        asUserId: uploaderId,
        reason: 'ลูกค้าแจ้งนำเข้า Excel ไม่ผ่าน',
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
    const imp = await signAccessToken({
      sub: uploaderId,
      tid: tenantId,
      scope: '',
      pt: 'imp',
      act: staff.id,
      sid: s.id,
    });
    // token ใช้งานได้จริง (อ่านเอกสารชนิดอื่นได้) แต่ไฟล์นำเข้า → 404
    const pdf = await api(app, uploader)
      .post('/v1/documents')
      .send({ kind: 'PDF', mime: 'application/pdf', bytes: 10 })
      .expect(201);
    expect((await api(app, imp).get(`/v1/documents/${pdf.body.id}`)).status).toBe(200);
    expect((await get(imp)).status).toBe(404);
  });

  it('tenant อื่น → 404', async () => {
    const other = await tokenFor((await createTenant(db)).id, '*', uploaderId);
    expect((await get(other)).status).toBe(404);
  });
});
