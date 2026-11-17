import { Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { buildOpenApi, createApp } from '../src/bootstrap';
import { Public } from '../src/common/decorators';
import { tryDecodeId } from '../src/common/ids';
import { DeprecatedRoute, VersionGate } from '../src/http/api-version/api-version.decorators';
import {
  bangkokDate,
  FIRST_API_VERSION,
  LATEST_API_VERSION,
} from '../src/http/api-version/versions';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, platform, tokenFor, truncateAll } from './helpers';

/** route ชั่วคราวเฉพาะ test — ยังไม่มี route จริงที่ถูกประกาศเลิกใช้ในเฟส 0 */
@Controller('__test/versioning')
class DeprecatedTestController {
  @Get('old')
  @Public()
  @DeprecatedRoute({
    deprecatedAt: '2026-11-18',
    sunset: '2027-11-18',
    link: 'https://developers.example/changelog#old',
  })
  @VersionGate('api_key.status_rotating')
  old() {
    return { status: 'rotating', prefix: 'tk_live_x', scopes: [] };
  }
}
@Module({ imports: [AppModule], controllers: [DeprecatedTestController] })
class TestModule {}

const OLD = '2026-11-17';

/**
 * ST7-T07 Versioning (docs/04 G1; docs/01 §5.1) — เกณฑ์ตรวจรับ: คำขอที่ pin วันที่เก่าได้พฤติกรรมเดิม (ตัวอย่าง 1 กรณี)
 * ตัวอย่าง = gate `api_key.status_rotating` (2026-11-18): ก่อนหน้านี้ key ที่กำลังหมุนแสดงเป็น `active`
 */
describe('API versioning (ST7-T07)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let rotatingId: string;
  let newKeyId: string;
  const srv = () => app.getHttpServer();
  const today = bangkokDate(new Date());

  beforeAll(async () => {
    await truncateAll();
    app = await createApp(TestModule);
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง เวอร์ชัน' })).id;
    const u = await db.appUser.create({
      data: { tenantId, email: 'admin@v.test', name: 'ผู้ดูแล', status: 'ACTIVE' },
    });
    admin = await tokenFor(tenantId, '*', u.id);
    const k = (
      await api(app, admin)
        .post('/v1/api-keys')
        .set('X-Api-Version', LATEST_API_VERSION)
        .send({ name: 'ERP', scopes: ['orders:read'] })
        .expect(201)
    ).body;
    const r = await api(app, admin)
      .post(`/v1/api-keys/${k.id}/rotate`)
      .send({ reason: 'หมุนตามรอบความปลอดภัย', graceHours: 24 })
      .expect(201);
    rotatingId = k.id;
    newKeyId = r.body.id;
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: pin วันที่เก่า → พฤติกรรมเดิม (rotating แสดงเป็น active) · ล่าสุด → rotating', async () => {
    const old = await api(app, admin)
      .get(`/v1/api-keys/${rotatingId}`)
      .set('X-Api-Version', OLD)
      .expect(200);
    expect(old.headers['x-api-version']).toBe(OLD);
    expect(old.body.status).toBe('active');
    expect(old.body.revokeAt).not.toBeNull(); // ข้อมูลอื่นคงเดิม

    const cur = await api(app, admin)
      .get(`/v1/api-keys/${rotatingId}`)
      .set('X-Api-Version', LATEST_API_VERSION)
      .expect(200);
    expect(cur.headers['x-api-version']).toBe(LATEST_API_VERSION);
    expect(cur.body.status).toBe('rotating');
    // ค่าเริ่ม = วันที่สร้างบริษัท (วันนี้ ≥ เวอร์ชันล่าสุด) → พฤติกรรมใหม่
    const def = await api(app, admin).get(`/v1/api-keys/${rotatingId}`).expect(200);
    expect(def.headers['x-api-version']).toBe(today);
    expect(def.body.status).toBe('rotating');
  });

  it('รายการ + ตัวกรอง + summary ของ client เก่า (แปลง request ก่อน validation และ response)', async () => {
    const oldActive = await api(app, admin)
      .get('/v1/api-keys?status=active')
      .set('X-Api-Version', OLD)
      .expect(200);
    const ids = oldActive.body.data.map((k: { id: string }) => k.id).sort();
    expect(ids).toEqual([rotatingId, newKeyId].sort());
    expect(oldActive.body.data.every((k: { status: string }) => k.status === 'active')).toBe(true);
    const newActive = await api(app, admin)
      .get('/v1/api-keys?status=active')
      .set('X-Api-Version', LATEST_API_VERSION)
      .expect(200);
    expect(newActive.body.data.map((k: { id: string }) => k.id)).toEqual([newKeyId]);

    const sOld = await api(app, admin)
      .get('/v1/api-keys/summary')
      .set('X-Api-Version', OLD)
      .expect(200);
    expect(sOld.body).not.toHaveProperty('rotating');
    expect(sOld.body.active).toBe(2);
    const sNew = await api(app, admin)
      .get('/v1/api-keys/summary')
      .set('X-Api-Version', LATEST_API_VERSION)
      .expect(200);
    expect(sNew.body).toMatchObject({ active: 1, rotating: 1 });
  });

  it('header ผิด → 400 invalid_api_version (รูปแบบ / วันไม่มีจริง / ก่อนเวอร์ชันแรก / อนาคต)', async () => {
    const tomorrow = bangkokDate(new Date(Date.now() + 86_400_000));
    for (const [v, reason] of [
      ['latest', 'format'],
      ['2026-02-30', 'format'],
      ['2026-10-31', 'before_first'],
      [tomorrow, 'future'],
    ] as const) {
      const r = await api(app, admin).get('/v1/api-keys/summary').set('X-Api-Version', v);
      expect(r.status, v).toBe(400);
      expect(r.headers['content-type']).toContain('application/problem+json');
      expect(r.body).toMatchObject({ code: 'invalid_api_version', reason });
    }
    // ไม่ล็อกอิน: ตรวจสิทธิ์ก่อน (401) — header ไม่ทำให้รั่วว่า route มีจริง
    await request(srv()).get('/v1/api-keys').set('X-Api-Version', 'x').expect(401);
  });

  it('ค่าเริ่มตามวันสร้างบริษัท: บริษัทที่สร้างก่อนการเปลี่ยน → พฤติกรรมเดิม · ก่อนเวอร์ชันแรก → เวอร์ชันแรก', async () => {
    const mk = async (name: string, createdAt: Date) => {
      const t = await createTenantWithDefaults(db, { name });
      await db.tenant.update({ where: { id: t.id }, data: { createdAt } });
      const u = await db.appUser.create({
        data: { tenantId: t.id, email: `${name}@v.test`, name, status: 'ACTIVE' },
      });
      return tokenFor(t.id, '*', u.id);
    };
    // 10 พ.ย. 2569 03:00 เวลาไทย = 9 พ.ย. UTC → วันที่ไทย 2026-11-10
    const early = await mk('early', new Date('2026-11-09T20:00:00Z'));
    const k = (
      await api(app, early)
        .post('/v1/api-keys')
        .set('X-Api-Version', LATEST_API_VERSION)
        .send({ name: 'ERP', scopes: ['orders:read'] })
        .expect(201)
    ).body;
    await api(app, early)
      .post(`/v1/api-keys/${k.id}/rotate`)
      .set('X-Api-Version', LATEST_API_VERSION)
      .send({ reason: 'หมุนตามรอบความปลอดภัย' })
      .expect(201);
    const r = await api(app, early).get(`/v1/api-keys/${k.id}`).expect(200);
    expect(r.headers['x-api-version']).toBe('2026-11-10');
    expect(r.body.status).toBe('active');

    const ancient = await mk('ancient', new Date('2025-06-01T00:00:00Z'));
    const r2 = await api(app, ancient).get('/v1/api-keys/summary').expect(200);
    expect(r2.headers['x-api-version']).toBe(FIRST_API_VERSION);
  });

  it('pin บน API key: ใช้เมื่อไม่ส่ง header · header มาก่อน · ตรวจค่าเหมือน header · หมุนแล้วคงค่า · ล้างได้', async () => {
    const bad = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'pin-bad', scopes: ['orders:read'], apiVersion: '2026-10-01' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors?.[0]).toMatchObject({
      field: 'apiVersion',
      code: 'api_version_before_first',
    });
    const badFmt = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'pin-bad', scopes: ['orders:read'], apiVersion: '18/11/2026' });
    expect(badFmt.status).toBe(422);

    const k = (
      await api(app, admin)
        .post('/v1/api-keys')
        .send({ name: 'pinned', scopes: ['orders:read'], apiVersion: '2026-11-05' })
        .expect(201)
    ).body;
    expect(k.apiVersion).toBe('2026-11-05');
    const row = await db.apiKey.findUniqueOrThrow({ where: { id: tryDecodeId('apiKey', k.id)! } });
    expect(row.apiVersion?.toISOString().slice(0, 10)).toBe('2026-11-05');

    const viaKey = await request(srv())
      .get('/v1/orders')
      .set('Authorization', `Bearer ${k.secret}`);
    expect(viaKey.status).toBe(200);
    expect(viaKey.headers['x-api-version']).toBe('2026-11-05');
    const override = await request(srv())
      .get('/v1/orders')
      .set('Authorization', `Bearer ${k.secret}`)
      .set('X-Api-Version', LATEST_API_VERSION);
    expect(override.headers['x-api-version']).toBe(LATEST_API_VERSION);

    // client credentials (JWT) ใช้ pin ของ key เดียวกัน
    const tok = await request(srv())
      .post('/v1/oauth/token')
      .send({ grantType: 'client_credentials', clientId: k.clientId, clientSecret: k.secret })
      .expect(200);
    const viaJwt = await request(srv())
      .get('/v1/orders')
      .set('Authorization', `Bearer ${tok.body.accessToken}`);
    expect(viaJwt.headers['x-api-version']).toBe('2026-11-05');

    const rot = await api(app, admin)
      .post(`/v1/api-keys/${k.id}/rotate`)
      .send({ reason: 'หมุนตามรอบความปลอดภัย' })
      .expect(201);
    expect(rot.body.apiVersion).toBe('2026-11-05');

    const cleared = await api(app, admin)
      .patch(`/v1/api-keys/${rot.body.id}`)
      .send({ apiVersion: null })
      .expect(200);
    expect(cleared.body.apiVersion).toBeNull();
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: tryDecodeId('apiKey', rot.body.id)!, action: 'api_key.updated' },
    });
    expect(audit.before).toMatchObject({ apiVersion: '2026-11-05' });
    expect(audit.after).toMatchObject({ apiVersion: null });
    const now = await request(srv())
      .get('/v1/orders')
      .set('Authorization', `Bearer ${rot.body.secret}`)
      .expect(200);
    expect(now.headers['x-api-version']).toBe(today);
  });

  it('route ที่ประกาศเลิกใช้: Deprecation/Sunset/Link ทุก response · public ไม่มีบริษัท = ล่าสุด', async () => {
    const r = await request(srv()).get('/v1/__test/versioning/old').expect(200);
    expect(r.headers.deprecation).toBe(`@${Date.UTC(2026, 10, 18) / 1000}`);
    expect(r.headers.sunset).toBe('Thu, 18 Nov 2027 00:00:00 GMT');
    expect(r.headers.link).toBe(
      '<https://developers.example/changelog#old>; rel="deprecation"; type="text/html"',
    );
    expect(r.headers['x-api-version']).toBe(LATEST_API_VERSION);
    expect(r.body.status).toBe('rotating');
    const old = await request(srv())
      .get('/v1/__test/versioning/old')
      .set('X-Api-Version', OLD)
      .expect(200);
    expect(old.body.status).toBe('active');
    // route ปกติไม่มี header เลิกใช้
    const h = await request(srv()).get('/v1/health');
    expect(h.headers.deprecation).toBeUndefined();
    expect(h.headers['x-api-version']).toBe(LATEST_API_VERSION);
  });

  it('OpenAPI: parameter X-Api-Version ทุก operation · เวอร์ชันล่าสุด · หมายเหตุต่อเวอร์ชัน · deprecated', () => {
    const doc = buildOpenApi(app) as unknown as {
      info: Record<string, unknown>;
      components: { parameters: Record<string, { name: string; in: string }> };
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(doc.info['x-api-version-latest']).toBe(LATEST_API_VERSION);
    expect(doc.components.parameters.ApiVersion).toMatchObject({
      name: 'X-Api-Version',
      in: 'header',
    });
    const get = doc.paths['/v1/api-keys/{id}']!.get!;
    expect(get.parameters).toContainEqual({ $ref: '#/components/parameters/ApiVersion' });
    expect(String(get.description)).toContain('2026-11-18');
    const dep = doc.paths['/v1/__test/versioning/old']!.get!;
    expect(dep.deprecated).toBe(true);
    expect(JSON.stringify(dep.responses)).toContain('#/components/headers/Sunset');
  });
});
