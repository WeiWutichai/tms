import type { NestExpressApplication } from '@nestjs/platform-express';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trustProxy } from '../src/bootstrap';
import { tryDecodeId } from '../src/common/ids';
import { ipAllowed, normalizeIpEntry } from '../src/modules/api-keys/key-material';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * ST7-T01 OAuth2 client credentials + API key `tk_live_` (docs/04 G1 Auth; spec/07 §6)
 * เกณฑ์ตรวจรับ: key ที่ไม่มี scope `orders:write` เรียก POST /orders ได้ 403 · key ที่หมุนแล้วใช้ได้ถึง `revokeAt` เท่านั้น
 */
describe('API keys + client credentials (ST7-T01)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let userId: string;
  const srv = () => app.getHttpServer();
  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });

  async function createKey(body: Record<string, unknown>, token = admin) {
    const r = await api(app, token).post('/v1/api-keys').send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string; secret: string; clientId: string; version: number };
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง เอ' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง บี' })).id;
    const u = await db.appUser.create({
      data: { tenantId, email: 'admin@a.test', name: 'ผู้ดูแล เอ', status: 'ACTIVE' },
    });
    userId = u.id;
    admin = await tokenFor(tenantId, '*', userId);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });

  it('สร้าง key: secret แสดงครั้งเดียว · ฐานเก็บแค่ hash · audit ไม่มี secret', async () => {
    const k = await createKey({ name: 'ERP sync', scopes: ['orders:read'], expiresInDays: 90 });
    expect(k.secret).toMatch(/^tk_live_[0-9a-f]{48}$/);
    expect(k.clientId).toBe(k.id);
    const row = await db.apiKey.findUniqueOrThrow({ where: { id: tryDecodeId('apiKey', k.id)! } });
    expect(row.secretHash).not.toContain(k.secret);
    expect(row.prefix).toBe(k.secret.slice(0, 12));
    expect(row.createdBy).toBe(userId);
    const got = await api(app, admin).get(`/v1/api-keys/${k.id}`).expect(200);
    expect(got.body.secret).toBeUndefined();
    expect(got.body.status).toBe('active');
    expect(got.body.createdByName).toBe('ผู้ดูแล เอ');
    expect(JSON.stringify(got.body)).not.toContain(k.secret.slice(12));
    const audit = await db.auditLog.findMany({ where: { entityId: row.id } });
    expect(audit.map((a) => a.action)).toEqual(['api_key.created']);
    const auditText = JSON.stringify(audit.map((a) => ({ before: a.before, after: a.after })));
    expect(auditText).not.toContain(k.secret.slice(12));
    expect(auditText).not.toContain(row.secretHash);
    // ชื่อซ้ำ (ไม่สนตัวพิมพ์) → 409
    const dup = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'erp SYNC', scopes: ['orders:read'] });
    expect(dup.status).toBe(409);
  });

  it('เกณฑ์ตรวจรับ: key ไม่มี orders:write → POST /orders 403 · มี → ผ่านด่านสิทธิ์', async () => {
    const ro = await createKey({ name: 'อ่านอย่างเดียว', scopes: ['orders:read'] });
    await request(srv()).get('/v1/orders').set(bearer(ro.secret)).expect(200);
    const denied = await request(srv()).post('/v1/orders').set(bearer(ro.secret)).send({});
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('permission_denied');
    const rw = await createKey({ name: 'เขียน', scopes: ['orders:read', 'orders:write'] });
    const ok = await request(srv()).post('/v1/orders').set(bearer(rw.secret)).send({});
    expect(ok.status).toBe(422); // ผ่าน auth + scope แล้วตกที่ validation
    // key ผิด/รูปแบบผิด → 401
    await request(srv())
      .get('/v1/orders')
      .set(bearer(`tk_live_${'0'.repeat(48)}`))
      .expect(401);
    await request(srv()).get('/v1/orders').set(bearer('tk_live_short')).expect(401);
    // lastUsedAt / lastUsedIp
    const row = await api(app, admin).get(`/v1/api-keys/${ro.id}`).expect(200);
    expect(row.body.lastUsedAt).not.toBeNull();
    expect(row.body.lastUsedIp).toBeTruthy();
  });

  it('เกณฑ์ตรวจรับ: key ที่หมุนแล้วใช้ได้ถึง revokeAt เท่านั้น · key ใหม่ใช้ได้ · เหตุผลลง audit', async () => {
    const k = await createKey({ name: 'หมุน', scopes: ['orders:read'], expiresInDays: 30 });
    const noReason = await api(app, admin).post(`/v1/api-keys/${k.id}/rotate`).send({});
    expect(noReason.status).toBe(422);
    const tooLong = await api(app, admin)
      .post(`/v1/api-keys/${k.id}/rotate`)
      .send({ reason: 'หมุนตามรอบความปลอดภัย', graceHours: 169 });
    expect(tooLong.status).toBe(422);
    const r = await api(app, admin)
      .post(`/v1/api-keys/${k.id}/rotate`)
      .set('If-Match', `"${k.version}"`)
      .send({ reason: 'หมุนตามรอบความปลอดภัย', graceHours: 24 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const nk = r.body as { id: string; secret: string; rotatedFromId: string; expiresAt: string };
    expect(nk.secret).not.toBe(k.secret);
    expect(nk.rotatedFromId).toBe(k.id);
    const old = (await api(app, admin).get(`/v1/api-keys/${k.id}`).expect(200)).body;
    expect(old.status).toBe('rotating');
    expect(old.rotatedToId).toBe(nk.id);
    const revokeAt = Date.parse(old.revokeAt);
    expect(revokeAt - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(revokeAt - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    // ก่อนถึง revokeAt ใช้ได้ทั้งคู่
    await request(srv()).get('/v1/orders').set(bearer(k.secret)).expect(200);
    await request(srv()).get('/v1/orders').set(bearer(nk.secret)).expect(200);
    // หมุนซ้ำ key ที่กำลังหมุน → 409
    await api(app, admin)
      .post(`/v1/api-keys/${k.id}/rotate`)
      .send({ reason: 'หมุนอีกรอบหนึ่งครับ' })
      .expect(409);
    // เลยเวลา revokeAt (จำลองนาฬิกาด้วยการเลื่อนค่าในฐาน) → key เดิม 401 key_revoked · key ใหม่ยังใช้ได้
    await db.apiKey.update({
      where: { id: tryDecodeId('apiKey', k.id)! },
      data: { revokeAt: new Date(Date.now() - 1000) },
    });
    const after = await request(srv()).get('/v1/orders').set(bearer(k.secret));
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('key_revoked');
    await request(srv()).get('/v1/orders').set(bearer(nk.secret)).expect(200);
    const audit = await db.auditLog.findMany({
      where: { entityId: tryDecodeId('apiKey', k.id)!, action: 'api_key.rotated' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toBe('หมุนตามรอบความปลอดภัย');
    // หมุนแบบ grace 0 = key เดิมหยุดทันที
    const k0 = await createKey({ name: 'หมุนทันที', scopes: ['orders:read'] });
    await api(app, admin)
      .post(`/v1/api-keys/${k0.id}/rotate`)
      .send({ reason: 'secret รั่วต้องหยุดทันที', graceHours: 0 })
      .expect(201);
    expect((await request(srv()).get('/v1/orders').set(bearer(k0.secret))).body.code).toBe(
      'key_revoked',
    );
  });

  it('เพิกถอน: มีผลทันที · เหตุผล ≥ 10 · If-Match เก่า 412 · ซ้ำ 409', async () => {
    const k = await createKey({ name: 'เพิกถอน', scopes: ['orders:read'] });
    await api(app, admin).post(`/v1/api-keys/${k.id}/revoke`).send({ reason: 'สั้น' }).expect(422);
    await api(app, admin)
      .patch(`/v1/api-keys/${k.id}`)
      .send({ ipAllowlist: ['10.0.0.0/8'] })
      .expect(200);
    await api(app, admin)
      .post(`/v1/api-keys/${k.id}/revoke`)
      .set('If-Match', `"${k.version}"`)
      .send({ reason: 'เลิกใช้ระบบเก่าแล้ว' })
      .expect(412);
    const r = await api(app, admin)
      .post(`/v1/api-keys/${k.id}/revoke`)
      .send({ reason: 'เลิกใช้ระบบเก่าแล้ว' })
      .expect(200);
    expect(r.body.status).toBe('revoked');
    expect(r.body.revokeReason).toBe('เลิกใช้ระบบเก่าแล้ว');
    const use = await request(srv()).get('/v1/orders').set(bearer(k.secret));
    expect(use.status).toBe(401);
    expect(use.body.code).toBe('key_revoked');
    await api(app, admin)
      .post(`/v1/api-keys/${k.id}/revoke`)
      .send({ reason: 'เลิกใช้ระบบเก่าแล้ว' })
      .expect(409);
    await api(app, admin).patch(`/v1/api-keys/${k.id}`).send({ name: 'ชื่อใหม่' }).expect(409);
    const a = await db.auditLog.findFirstOrThrow({
      where: { entityId: tryDecodeId('apiKey', k.id)!, action: 'api_key.revoked' },
    });
    expect(a.reason).toBe('เลิกใช้ระบบเก่าแล้ว');
  });

  it('หมดอายุ → 401 key_expired · ไม่หมดอายุได้ · อายุเลือกได้ 30/90/365', async () => {
    const k = await createKey({ name: 'หมดอายุ', scopes: ['orders:read'], expiresInDays: 30 });
    const g = (await api(app, admin).get(`/v1/api-keys/${k.id}`).expect(200)).body;
    expect(g.status).toBe('expiring'); // ≤ 30 วัน = ใกล้หมดอายุ
    await db.apiKey.update({
      where: { id: tryDecodeId('apiKey', k.id)! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const r = await request(srv()).get('/v1/orders').set(bearer(k.secret));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('key_expired');
    const forever = await createKey({
      name: 'ไม่หมด',
      scopes: ['orders:read'],
      expiresInDays: null,
    });
    expect(
      (await api(app, admin).get(`/v1/api-keys/${forever.id}`).expect(200)).body.expiresAt,
    ).toBeNull();
    await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'อายุแปลก', scopes: ['orders:read'], expiresInDays: 7 })
      .expect(422);
  });

  it('IP allowlist: ตรวจ IP จริงตาม trust proxy · นอกรายการ → 403 ip_not_allowed', async () => {
    const k = await createKey({
      name: 'IP',
      scopes: ['orders:read'],
      ipAllowlist: ['203.0.113.0/24', '2001:db8::/32'],
    });
    await request(srv())
      .get('/v1/orders')
      .set(bearer(k.secret))
      .set('X-Forwarded-For', '203.0.113.9')
      .expect(200);
    await request(srv())
      .get('/v1/orders')
      .set(bearer(k.secret))
      .set('X-Forwarded-For', '2001:db8::5')
      .expect(200);
    // proxy ไว้ใจ 1 ชั้น: ค่าซ้ายสุดที่ผู้เรียกปลอมมาไม่ถูกใช้
    const spoof = await request(srv())
      .get('/v1/orders')
      .set(bearer(k.secret))
      .set('X-Forwarded-For', '203.0.113.9, 198.51.100.7');
    expect(spoof.status).toBe(403);
    expect(spoof.body.code).toBe('ip_not_allowed');
    await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'IP ผิด', scopes: ['orders:read'], ipAllowlist: ['300.1.1.1'] })
      .expect(422);
  });

  it('OAuth2 client credentials → JWT RS256 1 ชม. (JWKS ตรวจได้) · scope ⊆ key · Basic auth', async () => {
    const k = await createKey({ name: 'OAuth', scopes: ['orders:read', 'orders:write'] });
    const t = await request(srv())
      .post('/v1/oauth/token')
      .send({
        grantType: 'client_credentials',
        clientId: k.clientId,
        clientSecret: k.secret,
        scope: 'orders:read',
      })
      .expect(200);
    expect(t.body.tokenType).toBe('Bearer');
    expect(t.body.expiresIn).toBeGreaterThan(3590);
    expect(t.body.expiresIn).toBeLessThanOrEqual(3600);
    expect(t.body.scope).toBe('orders:read');
    expect(t.headers['set-cookie']).toBeUndefined();
    expect(decodeProtectedHeader(t.body.accessToken).alg).toBe('RS256');
    const jwks = await request(srv()).get('/v1/.well-known/jwks.json').expect(200);
    const { payload } = await jwtVerify(t.body.accessToken, createLocalJWKSet(jwks.body));
    expect(payload).toMatchObject({ sub: k.clientId, tid: tenantId, pt: 'client' });
    const jwt = t.body.accessToken as string;
    await request(srv()).get('/v1/orders').set(bearer(jwt)).expect(200);
    // token ขอแค่ orders:read → เขียนไม่ได้แม้ key มี orders:write
    expect((await request(srv()).post('/v1/orders').set(bearer(jwt)).send({})).status).toBe(403);
    // Basic auth + ไม่ระบุ scope = ทุก scope ของ key
    const basic = Buffer.from(`${k.clientId}:${k.secret}`).toString('base64');
    const t2 = await request(srv())
      .post('/v1/oauth/token')
      .set('Authorization', `Basic ${basic}`)
      .send({ grantType: 'client_credentials' })
      .expect(200);
    expect(t2.body.scope).toBe('orders:read orders:write');
    // client_id = prefix ที่แสดงในหน้าจอก็ได้
    await request(srv())
      .post('/v1/oauth/token')
      .send({
        grantType: 'client_credentials',
        clientId: k.secret.slice(0, 12),
        clientSecret: k.secret,
      })
      .expect(200);
    // scope เกิน key → 400 invalid_scope · secret ผิด / client_id ไม่ตรง → 401 invalid_client
    const bad = await request(srv()).post('/v1/oauth/token').send({
      grantType: 'client_credentials',
      clientId: k.clientId,
      clientSecret: k.secret,
      scope: 'invoices:read',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_scope');
    const wrong = await request(srv())
      .post('/v1/oauth/token')
      .send({ grantType: 'client_credentials', clientId: k.clientId, clientSecret: 'tk_live_x' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('invalid_client');
    const mismatch = await request(srv())
      .post('/v1/oauth/token')
      .send({
        grantType: 'client_credentials',
        clientId: `key_${'0'.repeat(32)}`,
        clientSecret: k.secret,
      });
    expect(mismatch.body.code).toBe('invalid_client');
    // เพิกถอน key → JWT ที่ออกไปแล้วหยุดทันที (ตรวจ key ทุก request)
    await api(app, admin)
      .post(`/v1/api-keys/${k.id}/revoke`)
      .send({ reason: 'ทดสอบเพิกถอนทันที' })
      .expect(200);
    const dead = await request(srv()).get('/v1/orders').set(bearer(jwt));
    expect(dead.status).toBe(401);
    expect(dead.body.code).toBe('key_revoked');
    // ลด scope ของ key → token ที่ออกไปแล้วได้สิทธิ์เท่าที่ key เหลือ
    const k2 = await createKey({ name: 'ลด scope', scopes: ['orders:read', 'orders:write'] });
    const t3 = await request(srv())
      .post('/v1/oauth/token')
      .send({ grantType: 'client_credentials', clientId: k2.clientId, clientSecret: k2.secret })
      .expect(200);
    await api(app, admin)
      .patch(`/v1/api-keys/${k2.id}`)
      .send({ scopes: ['orders:write'] })
      .expect(200);
    await request(srv()).get('/v1/orders').set(bearer(t3.body.accessToken)).expect(403);
  });

  it('สิทธิ์: scope ที่ผู้สร้างไม่มี → 422 · API key จัดการ key ไม่ได้ · ไม่มี settings:write → 403', async () => {
    const limited = await tokenFor(tenantId, 'settings:read settings:write orders:read', userId);
    const r = await api(app, limited)
      .post('/v1/api-keys')
      .send({ name: 'เกินสิทธิ์', scopes: ['orders:write'] });
    expect(r.status).toBe(422);
    expect(r.body.errors[0].code).toBe('scope_not_grantable');
    const opts = (await api(app, limited).get('/v1/api-keys/scopes').expect(200)).body.data as {
      scope: string;
      grantable: boolean;
    }[];
    expect(opts.find((o) => o.scope === 'orders:read')?.grantable).toBe(true);
    expect(opts.find((o) => o.scope === 'orders:write')?.grantable).toBe(false);
    await api(app, limited)
      .post('/v1/api-keys')
      .send({ name: 'ไม่รู้จัก', scopes: ['nope:read'] })
      .expect(422);
    // งานบริหารผู้ใช้/ตั้งค่าให้ key ไม่ได้ (review M1) — แม้ผู้สร้างมี `*`
    for (const sc of ['users:read', 'users:write', 'settings:write']) {
      const r2 = await api(app, admin)
        .post('/v1/api-keys')
        .send({ name: `ห้าม ${sc}`, scopes: [sc] });
      expect(r2.status).toBe(422);
      expect(r2.body.errors[0].code).toBe('unknown_scope');
    }
    const all = (await api(app, admin).get('/v1/api-keys/scopes').expect(200)).body.data as {
      scope: string;
    }[];
    expect(all.map((o) => o.scope)).not.toContain('users:write');
    expect(all.map((o) => o.scope)).not.toContain('settings:write');
    // key จัดการ/ดูรายการ key ไม่ได้ (ต้องเป็นผู้ใช้)
    const k = await createKey({ name: 'ตั้งค่า', scopes: ['settings:read'] });
    const byKey = await request(srv())
      .post('/v1/api-keys')
      .set(bearer(k.secret))
      .send({ name: 'โดย key', scopes: ['settings:read'] });
    expect(byKey.status).toBe(403);
    await request(srv()).get('/v1/api-keys').set(bearer(k.secret)).expect(403);
    // แถวที่มี scope ต้องห้ามค้างอยู่ (ข้อมูลเก่า/แก้ตรงในฐาน) → guard ตัดทิ้ง
    await db.apiKey.update({
      where: { id: tryDecodeId('apiKey', k.id)! },
      data: { scopes: ['settings:read', 'users:read'] },
    });
    await request(srv()).get('/v1/roles').set(bearer(k.secret)).expect(403);
    const viewer = await tokenFor(tenantId, 'settings:read', userId);
    await api(app, viewer).get('/v1/api-keys').expect(200);
    await api(app, viewer)
      .post('/v1/api-keys')
      .send({ name: 'viewer', scopes: ['orders:read'] })
      .expect(403);
    // endpoint เฉพาะผู้ใช้จริง (เปลี่ยนรหัสผ่าน) ตอบ 401 ไม่ใช่ 500
    const ro = await createKey({ name: 'ผู้ใช้เท่านั้น', scopes: ['orders:read'] });
    await request(srv())
      .post('/v1/me/password')
      .set(bearer(ro.secret))
      .send({ currentPassword: 'x'.repeat(12), newPassword: 'y'.repeat(14) })
      .expect(401);
  });

  it('key test ยังออกไม่ได้ (sandbox ST7-T09) · Idempotency-Key ไม่รับ (secret ห้ามเก็บ)', async () => {
    const t = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'sandbox', mode: 'test', scopes: ['orders:read'] });
    expect(t.status).toBe(422);
    expect(t.body.errors[0].code).toBe('sandbox_not_available');
    await api(app, admin)
      .post('/v1/api-keys')
      .set('Idempotency-Key', 'k-1')
      .send({ name: 'idem', scopes: ['orders:read'] })
      .expect(400);
    expect(await db.idempotencyKey.count({ where: { key: 'k-1' } })).toBe(0);
  });

  it('แพ็กเกจไม่มี Open API → key ใช้ไม่ได้ 403 feature_not_in_plan · tenant อื่นมองไม่เห็น key', async () => {
    const k = await createKey({ name: 'แพ็กเกจ', scopes: ['orders:read'] });
    const otherAdmin = await tokenFor(otherId);
    await api(app, otherAdmin).get(`/v1/api-keys/${k.id}`).expect(404);
    expect((await api(app, otherAdmin).get('/v1/api-keys').expect(200)).body.data).toEqual([]);
    await db.tenant.update({ where: { id: tenantId }, data: { planCode: 'start' } });
    try {
      // cache ของ entitlement ถูกล้างเมื่อเปลี่ยนแพ็กเกจผ่าน Console — test เปลี่ยนตรงในฐานจึงล้างเอง
      app
        .get((await import('../src/modules/entitlements/entitlement.service')).EntitlementService)
        .invalidate(tenantId);
      const r = await request(srv()).get('/v1/orders').set(bearer(k.secret));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('feature_not_in_plan');
    } finally {
      await db.tenant.update({ where: { id: tenantId }, data: { planCode: 'std' } });
      app
        .get((await import('../src/modules/entitlements/entitlement.service')).EntitlementService)
        .invalidate(tenantId);
    }
  });

  it('เพิกถอน key ใหม่ที่มาจากการหมุน → key เดิมหยุดทันทีด้วย', async () => {
    const k = await createKey({ name: 'ต่อทอด', scopes: ['orders:read'] });
    const nk = (
      await api(app, admin)
        .post(`/v1/api-keys/${k.id}/rotate`)
        .send({ reason: 'หมุนตามรอบความปลอดภัย' })
        .expect(201)
    ).body as { id: string; secret: string };
    await request(srv()).get('/v1/orders').set(bearer(k.secret)).expect(200);
    await api(app, admin)
      .post(`/v1/api-keys/${nk.id}/revoke`)
      .send({ reason: 'secret ใหม่รั่วต้องหยุดทั้งคู่' })
      .expect(200);
    for (const sec of [k.secret, nk.secret])
      expect((await request(srv()).get('/v1/orders').set(bearer(sec))).body.code).toBe(
        'key_revoked',
      );
    const old = (await api(app, admin).get(`/v1/api-keys/${k.id}`).expect(200)).body;
    expect(old.status).toBe('revoked');
  });

  it('IP ที่ถูกปฏิเสธบันทึกบน key (INT-075) · ผู้สร้างถูกระงับ → ป้าย creatorInactive แต่ key ยังทำงาน (INT-076)', async () => {
    const k = await createKey({
      name: 'บันทึก IP',
      scopes: ['orders:read'],
      ipAllowlist: ['10.0.0.0/8'],
    });
    await request(srv())
      .get('/v1/orders')
      .set(bearer(k.secret))
      .set('X-Forwarded-For', '198.51.100.23')
      .expect(403);
    const g = (await api(app, admin).get(`/v1/api-keys/${k.id}`).expect(200)).body;
    expect(g.lastRejectedIp).toBe('198.51.100.23');
    expect(g.lastRejectedAt).not.toBeNull();
    expect(g.creatorInactive).toBe(false);
    const u2 = await db.appUser.create({
      data: { tenantId, email: 'gone@a.test', name: 'ผู้ใช้ที่ออกแล้ว', status: 'ACTIVE' },
    });
    const t2 = await tokenFor(tenantId, '*', u2.id);
    const k2 = await createKey({ name: 'ของคนที่ออก', scopes: ['orders:read'] }, t2);
    await db.appUser.update({ where: { id: u2.id }, data: { status: 'DISABLED' } });
    const g2 = (await api(app, admin).get(`/v1/api-keys/${k2.id}`).expect(200)).body;
    expect(g2.creatorInactive).toBe(true);
    await request(srv()).get('/v1/orders').set(bearer(k2.secret)).expect(200);
  });

  it('JWT ปลอม: alg none / HS256 อ้าง pt=client / RS256 กุญแจอื่น / aud ผิด → 401', async () => {
    const { SignJWT, UnsecuredJWT, generateKeyPair } = await import('jose');
    const k = await createKey({ name: 'ปลอม', scopes: ['orders:read'] });
    const claims = { tid: tenantId, scope: 'orders:read', pt: 'client' };
    const none = new UnsecuredJWT(claims).setSubject(k.id).setExpirationTime('1h').encode();
    await request(srv()).get('/v1/orders').set(bearer(none)).expect(401);
    const hs = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(k.id)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.AUTH_DEV_SECRET!));
    await request(srv()).get('/v1/orders').set(bearer(hs)).expect(401);
    const other = await generateKeyPair('RS256');
    const jwks = (await request(srv()).get('/v1/.well-known/jwks.json')).body.keys as {
      kid: string;
    }[];
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: jwks[0]!.kid, typ: 'at+jwt' })
      .setIssuer('tms')
      .setAudience('tms-api')
      .setSubject(k.id)
      .setExpirationTime('1h')
      .sign(other.privateKey);
    await request(srv()).get('/v1/orders').set(bearer(forged)).expect(401);
    // token จริงแต่ตรวจ aud/typ — ของจริงผ่าน
    const real = (
      await request(srv())
        .post('/v1/oauth/token')
        .send({ grantType: 'client_credentials', clientId: k.clientId, clientSecret: k.secret })
        .expect(200)
    ).body.accessToken as string;
    const [h, p] = real
      .split('.')
      .slice(0, 2)
      .map((x) => JSON.parse(Buffer.from(x, 'base64url').toString()));
    expect(h.typ).toBe('at+jwt');
    expect(p.aud).toBe('tms-api');
  });

  it('รายการ: กรองสถานะ + สรุปต่อแท็บ', async () => {
    const s = (await api(app, admin).get('/v1/api-keys/summary').expect(200)).body;
    expect(s.all).toBeGreaterThan(0);
    expect(s.revoked).toBeGreaterThan(0);
    expect(s.rotating).toBeGreaterThanOrEqual(0);
    const rev = (await api(app, admin).get('/v1/api-keys?status=revoked&limit=200').expect(200))
      .body.data as { status: string }[];
    expect(rev.length).toBe(s.revoked);
    expect(rev.every((x) => x.status === 'revoked')).toBe(true);
    const byName = (await api(app, admin).get('/v1/api-keys?name=oauth').expect(200)).body.data;
    expect(byName.map((x: { name: string }) => x.name)).toEqual(['OAuth']);
    const byScope = (await api(app, admin).get('/v1/api-keys?scope=settings&limit=200').expect(200))
      .body.data as { name: string }[];
    expect(byScope.map((x) => x.name)).toEqual(['ตั้งค่า']);
    const byUser = (
      await api(app, admin).get('/v1/api-keys?createdBy=ผู้ดูแล&limit=200').expect(200)
    ).body.data as unknown[];
    expect(byUser.length).toBe(s.all - 1); // 1 key สร้างโดยผู้ใช้อื่น (test INT-076)
    expect(
      (await api(app, admin).get('/v1/api-keys?createdBy=ไม่มีคนนี้').expect(200)).body.data,
    ).toEqual([]);
  });
});

describe('key-material / trust proxy (unit)', () => {
  it('normalizeIpEntry', () => {
    expect(normalizeIpEntry(' 203.150.12.0/24 ')).toBe('203.150.12.0/24');
    expect(normalizeIpEntry('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIpEntry('2001:DB8::/32')).toBe('2001:db8::/32');
    expect(normalizeIpEntry('1.2.3.4/33')).toBeNull();
    expect(normalizeIpEntry('1.2.3')).toBeNull();
    expect(normalizeIpEntry('a/b/c')).toBeNull();
  });
  it('ipAllowed', () => {
    expect(ipAllowed([], undefined)).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '10.2.3.4')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '::ffff:10.2.3.4')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '11.0.0.1')).toBe(false);
    expect(ipAllowed(['1.2.3.4'], '1.2.3.4')).toBe(true);
    expect(ipAllowed(['1.2.3.4'], undefined)).toBe(false);
  });
  it('trustProxy', () => {
    expect(trustProxy(undefined, true)).toBe(1);
    // นอก dev/test ไม่ตั้ง = ไม่เชื่อ X-Forwarded-For (QA M)
    expect(trustProxy(undefined, false)).toBe(0);
    expect(trustProxy('', false)).toBe(0);
    expect(trustProxy('2')).toBe(2);
    expect(trustProxy('10.0.0.0/8, loopback')).toEqual(['10.0.0.0/8', 'loopback']);
  });
});

describe('TRUST_PROXY=0: ปลอม X-Forwarded-For ผ่าน IP allowlist ไม่ได้', () => {
  it('XFF ที่อยู่ใน allowlist ถูกเมิน (ใช้ IP ของ socket) → 403', async () => {
    const db = platform();
    const prev = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '0';
    const app = await bootApp();
    try {
      const tid = (await createTenantWithDefaults(db, { name: 'บริษัท proxy' })).id;
      const admin = await tokenFor(tid);
      const k = (
        await api(app, admin)
          .post('/v1/api-keys')
          .send({ name: 'XFF', scopes: ['orders:read'], ipAllowlist: ['203.0.113.0/24'] })
          .expect(201)
      ).body as { secret: string };
      const r = await request(app.getHttpServer())
        .get('/v1/orders')
        .set('Authorization', `Bearer ${k.secret}`)
        .set('X-Forwarded-For', '203.0.113.9');
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('ip_not_allowed');
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = prev;
      await app.close();
      await db.$disconnect();
    }
  });
});
