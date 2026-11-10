import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { api, bootApp, createTenant, loginFull, platform, truncateAll } from './helpers';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 7),
]);

/** ST1-T09: เปลี่ยนภาษาแล้ว UI เปลี่ยน; ลายเซ็นที่อัปโหลดอ่านกลับได้ */
describe('profile', () => {
  let app: NestExpressApplication;
  const db = platform();
  let access: string;
  let other: string;
  const PW = 'profile-test-password-2569';

  beforeAll(async () => {
    process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-files-'));
    await truncateAll();
    app = await bootApp();
    const t = (await createTenant(db)).id;
    const roles = await ensureSystemRoles(db, t);
    for (const email of ['me@profile.test', 'other@profile.test']) {
      const u = await db.appUser.create({
        data: {
          tenantId: t,
          email,
          name: 'ทดสอบ',
          status: 'ACTIVE',
          passwordHash: await hashPassword(PW),
        },
      });
      await db.userRole.create({ data: { tenantId: t, userId: u.id, roleId: roles.planner! } });
    }
    access = (await loginFull(app, 'me@profile.test', PW, '10.60.0.1')).access;
    other = (await loginFull(app, 'other@profile.test', PW, '10.60.0.2')).access;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const path = (u: string) => new URL(u).pathname + new URL(u).search;
  async function upload(token: string, kind: string) {
    const r = await api(app, token)
      .post('/v1/documents')
      .send({ kind, mime: 'image/png', bytes: PNG.length })
      .expect(201);
    await request(app.getHttpServer())
      .put(path(r.body.uploadUrl))
      .set('Content-Type', 'application/octet-stream')
      .send(PNG)
      .expect(200);
    return r.body.id as string;
  }

  it('อ่าน/แก้ชื่อ เบอร์ ภาษา timezone; /me บอกภาษา; ค่าผิด → 422; ลง audit', async () => {
    const p = await api(app, access).get('/v1/me/profile').expect(200);
    expect(p.body).toMatchObject({
      email: 'me@profile.test',
      locale: 'th',
      timezone: 'Asia/Bangkok',
      signature: null,
    });
    const u = await api(app, access)
      .patch('/v1/me/profile')
      .send({ name: '  สมชาย ใจดี ', phone: '0812345678', locale: 'en' })
      .expect(200);
    expect(u.body).toMatchObject({ name: 'สมชาย ใจดี', phone: '0812345678', locale: 'en' });
    expect((await api(app, access).get('/v1/me').expect(200)).body.user.locale).toBe('en');
    for (const bad of [
      { locale: 'fr' },
      { phone: '12345' },
      { timezone: 'Europe/Paris' },
      { name: '  ' },
      { email: 'x@y.z' },
    ])
      expect(
        (await api(app, access).patch('/v1/me/profile').send(bad)).status,
        JSON.stringify(bad),
      ).toBe(422);
    // ETag / If-Match (docs/01): ค่าเก่า → 412
    const g = await api(app, access).get('/v1/me/profile').expect(200);
    const etag = g.headers.etag as string;
    await api(app, access)
      .patch('/v1/me/profile')
      .set('If-Match', etag)
      .send({ timezone: 'Asia/Bangkok' })
      .expect(200);
    expect(
      (await api(app, access).patch('/v1/me/profile').set('If-Match', etag).send({ name: 'ชนกัน' }))
        .status,
    ).toBe(412);
    const audit = await db.auditLog.findFirst({ where: { action: 'user.profile_updated' } });
    expect(audit?.after).toMatchObject({ locale: 'en', name: 'สมชาย ใจดี' });
  });

  it('ลายเซ็น: อัปโหลด kind SIGNATURE → ตั้งในโปรไฟล์ → อ่านกลับได้เนื้อเดิม; ของคนอื่น/ชนิดอื่นใช้ไม่ได้', async () => {
    const sig = await upload(access, 'SIGNATURE');
    const p = await api(app, access)
      .patch('/v1/me/profile')
      .send({ signatureDocumentId: sig })
      .expect(200);
    expect(p.body.signature.id).toBe(sig);
    const dl = await request(app.getHttpServer())
      .get(path(p.body.signature.downloadUrl))
      .buffer(true)
      .parse((res, cb) => {
        const c: Buffer[] = [];
        res.on('data', (x: Buffer) => c.push(x));
        res.on('end', () => cb(null, Buffer.concat(c)));
      });
    expect(Buffer.compare(dl.body as Buffer, PNG)).toBe(0);
    const notSig = await upload(access, 'POD_PHOTO');
    expect(
      (await api(app, access).patch('/v1/me/profile').send({ signatureDocumentId: notSig })).body
        .errors[0].code,
    ).toBe('invalid_signature');
    const theirs = await upload(other, 'SIGNATURE');
    expect(
      (await api(app, access).patch('/v1/me/profile').send({ signatureDocumentId: theirs })).status,
    ).toBe(422);
    await api(app, access).patch('/v1/me/profile').send({ signatureDocumentId: null }).expect(200);
    expect((await api(app, access).get('/v1/me/profile')).body.signature).toBeNull();
  });
});
