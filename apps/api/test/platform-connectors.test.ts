import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { signPlatformToken } from '../src/auth/tokens';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

/**
 * ST7-T20 Connectors ใน Platform Console (docs/02 §5) + บันทึกการซิงก์ของ tenant
 * เกณฑ์ตรวจรับ: Innovera เปิด connector demo ให้ tenant จาก admin portal; tenant เห็นสถานะและกด healthCheck ได้; credential ไม่แสดงเต็ม
 */
describe('platform connectors (ST7-T20)', () => {
  let app: NestExpressApplication;
  const db: PrismaClient = platform();
  const staff: Record<string, { id: string; token: string }> = {};
  let tenantId: string;
  let tenantPub: string;
  let ownerToken: string;
  const SECRET = 'demo-secret-key-0042';

  async function mkStaff(role: 'SUPER_ADMIN' | 'SUPPORT' | 'BILLING') {
    const u = await db.platformUser.create({
      data: {
        email: `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@innovera.test`,
        name: `ทีม ${role}`,
        role,
        passwordHash: 'x',
        totpSecret: 'x',
      },
    });
    staff[role] = {
      id: u.id,
      token: await signPlatformToken({ sub: u.id, role, tv: u.tokenVersion }),
    };
  }
  const as = (role: string) => api(app, staff[role]!.token);

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    await Promise.all([mkStaff('SUPER_ADMIN'), mkStaff('SUPPORT'), mkStaff('BILLING')]);
    tenantId = (await createTenant(db, 'บริษัท นำร่องเชื่อมบัญชี')).id;
    tenantPub = encodeId('tenant', tenantId);
    await db.tenant.update({ where: { id: tenantId }, data: { planCode: 'ent' } });
    const owner = await db.appUser.create({
      data: { tenantId, email: 'owner@pilot.test', name: 'เจ้าของ นำร่อง', status: 'ACTIVE' },
    });
    const roles = await ensureSystemRoles(db as never, tenantId);
    await db.userRole.create({ data: { tenantId, userId: owner.id, roleId: roles.owner! } });
    ownerToken = await tokenFor(tenantId, '*', owner.id);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('สิทธิ์: SUPPORT/BILLING ดูได้แต่เปิด/หมุน/ทดสอบไม่ได้ · token ลูกค้าเรียก /platform ไม่ได้', async () => {
    await as('SUPPORT').get('/v1/platform/connectors').expect(200);
    await as('BILLING').get('/v1/platform/connectors/adapters').expect(200);
    for (const r of ['SUPPORT', 'BILLING'])
      await as(r)
        .post(`/v1/platform/tenants/${tenantPub}/connectors`)
        .send({ adapterKey: 'demo', credentials: { apiKey: SECRET }, reason: 'ทดลองเปิดให้ลูกค้า' })
        .expect(403);
    await api(app, ownerToken).get('/v1/platform/connectors').expect(401);
  });

  it('เปิด connector demo ให้ tenant (activate) → tenant เห็น ACTIVE + กด healthCheck ได้ · credential ไม่ส่งกลับ · audit ผู้กระทำ platform', async () => {
    // เหตุผลสั้นเกิน = 422
    await as('SUPER_ADMIN')
      .post(`/v1/platform/tenants/${tenantPub}/connectors`)
      .send({ adapterKey: 'demo', credentials: { apiKey: SECRET }, reason: 'สั้น' })
      .expect(422);
    const r = await as('SUPER_ADMIN')
      .post(`/v1/platform/tenants/${tenantPub}/connectors`)
      .send({
        adapterKey: 'demo',
        credentials: { apiKey: SECRET },
        reason: 'เปิด connector ให้ลูกค้านำร่องตามสัญญา',
        activate: true,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      adapterKey: 'demo',
      status: 'ACTIVE',
      tenantId: tenantPub,
      tenantName: 'บริษัท นำร่องเชื่อมบัญชี',
      credentialKeys: ['apiKey'],
      activation: { ok: true, code: null },
      queue: { open: 0, failed: 0 },
    });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    const conId = r.body.id as string;

    // tenant เห็นสถานะ + ทดสอบได้ · ไม่มีค่า credential ในคำตอบใด
    const list = await api(app, ownerToken).get('/v1/connectors').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: conId, status: 'ACTIVE' });
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    const h = await api(app, ownerToken).post(`/v1/connectors/${conId}/health`).send({});
    expect(h.status).toBe(200);
    expect(h.body.ok).toBe(true);

    // ประวัติที่ owner เห็น: สร้าง + เปิดใช้ โดยทีม Innovera พร้อมเหตุผล
    const audit = await db.auditLog.findMany({
      where: { tenantId, entityType: 'connector', entityId: tryDecodeId('connector', conId)! },
      orderBy: { seq: 'asc' },
    });
    const created = audit.find((a) => a.action === 'connector.created')!;
    expect(created.actorId).toBe(`platform:${staff.SUPER_ADMIN!.id}`);
    expect(created.reason).toBe('เปิด connector ให้ลูกค้านำร่องตามสัญญา');
    expect(audit.find((a) => a.action === 'connector.resumed')?.actorId).toBe(
      `platform:${staff.SUPER_ADMIN!.id}`,
    );
    expect(JSON.stringify(audit.map((a) => [a.before, a.after, a.reason]))).not.toContain(SECRET);
    const hist = await api(app, ownerToken).get(`/v1/connectors/${conId}/history`).expect(200);
    expect(JSON.stringify(hist.body)).not.toContain(SECRET);

    // ซ้ำขอบเขตเดิม = 409
    await as('SUPER_ADMIN')
      .post(`/v1/platform/tenants/${tenantPub}/connectors`)
      .send({ adapterKey: 'demo', credentials: { apiKey: SECRET }, reason: 'เปิดซ้ำเพื่อทดสอบ' })
      .expect(409);

    // รายการข้าม tenant
    const all = await as('SUPPORT').get('/v1/platform/connectors').expect(200);
    expect(all.body.data.map((c: { id: string }) => c.id)).toContain(conId);
  });

  it('หมุน key (เหตุผลบังคับ) → credential ใช้ไม่ได้ → ทดสอบล้ม AUTH → ERROR · หยุด/เปิดใหม่', async () => {
    const conId = (await api(app, ownerToken).get('/v1/connectors').expect(200)).body.data[0]
      .id as string;
    await as('SUPER_ADMIN')
      .put(`/v1/platform/connectors/${conId}/credentials`)
      .send({ credentials: { apiKey: 'invalid' } })
      .expect(422);
    const rot = await as('SUPER_ADMIN')
      .put(`/v1/platform/connectors/${conId}/credentials`)
      .send({ credentials: { apiKey: 'invalid' }, reason: 'ลูกค้าแจ้งหมุน key ใน ERP' })
      .expect(200);
    expect(rot.body.credentialsUpdatedAt).toBeTruthy();
    const h = await as('SUPER_ADMIN').post(`/v1/platform/connectors/${conId}/health`).expect(200);
    expect(h.body).toMatchObject({ ok: false, errorClass: 'AUTH' });
    expect(h.body.connector.status).toBe('ERROR');
    // เปิดใหม่ไม่ได้จนกว่าจะทดสอบผ่าน
    await as('SUPER_ADMIN')
      .post(`/v1/platform/connectors/${conId}/resume`)
      .send({ reason: 'ลองเปิดใหม่หลังหมุน key' })
      .expect(409);
    await as('SUPER_ADMIN')
      .put(`/v1/platform/connectors/${conId}/credentials`)
      .send({ credentials: { apiKey: SECRET }, reason: 'ใส่ key ที่ถูกต้องคืน' })
      .expect(200);
    await as('SUPER_ADMIN')
      .post(`/v1/platform/connectors/${conId}/resume`)
      .send({ reason: 'ทดสอบผ่านแล้ว เปิดใช้ต่อ' })
      .expect(200);
    const p = await as('SUPER_ADMIN')
      .post(`/v1/platform/connectors/${conId}/pause`)
      .send({ reason: 'หยุดชั่วคราวระหว่างปิดงวด' })
      .expect(200);
    expect(p.body.status).toBe('PAUSED');
    const rows = await db.auditLog.findMany({
      where: { tenantId, action: 'connector.credentials_changed' },
    });
    expect(rows.every((a) => a.actorId === `platform:${staff.SUPER_ADMIN!.id}` && a.reason)).toBe(
      true,
    );
    expect(JSON.stringify(rows.map((a) => [a.before, a.after]))).not.toContain(SECRET);
    // If-Match เก่า = 412
    await as('SUPER_ADMIN')
      .post(`/v1/platform/connectors/${conId}/resume`)
      .set('If-Match', '"1"')
      .send({ reason: 'เปิดใช้ด้วย version เก่า' })
      .expect(412);
    // owner ได้แจ้งเตือน (ในระบบ + อีเมล) ทุกครั้งที่ทีมงานเปลี่ยน credential/สถานะ
    const ntf = await db.notification.findMany({
      where: { tenantId, templateCode: 'connector.platform_changed' },
    });
    expect(ntf.length).toBeGreaterThanOrEqual(4);
    // ประวัติที่ลูกค้าเห็นมีชื่อทีมงาน
    const hist = await api(app, ownerToken).get(`/v1/connectors/${conId}/history`).expect(200);
    expect(
      hist.body.data.find((r: { actor: { id: string } }) => r.actor?.id.startsWith('platform:'))
        ?.actor.name,
    ).toBe('ทีม SUPER_ADMIN');
  });

  it('บริษัทที่ปิดบัญชีแล้ว (CANCELLED) เปลี่ยน connector จาก Console ไม่ได้', async () => {
    const conId = (await api(app, ownerToken).get('/v1/connectors').expect(200)).body.data[0]
      .id as string;
    await db.tenant.update({ where: { id: tenantId }, data: { status: 'CANCELLED' } });
    try {
      for (const [p, b] of [
        ['health', {}],
        ['resume', { reason: 'เปิดใช้หลังปิดบัญชี' }],
        ['pause', { reason: 'หยุดหลังปิดบัญชีแล้ว' }],
      ] as const)
        await as('SUPER_ADMIN').post(`/v1/platform/connectors/${conId}/${p}`).send(b).expect(409);
      await as('SUPER_ADMIN')
        .put(`/v1/platform/connectors/${conId}/credentials`)
        .send({ credentials: { apiKey: SECRET }, reason: 'หมุน key หลังปิดบัญชี' })
        .expect(409);
    } finally {
      await db.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } });
    }
  });

  it('คิวคำสั่ง: tenant เห็นของตัวเอง · Console เห็นข้าม tenant พร้อมชื่อบริษัท', async () => {
    const conId = (await api(app, ownerToken).get('/v1/connectors').expect(200)).body.data[0]
      .id as string;
    const cid = tryDecodeId('connector', conId)!;
    const localId = randomUUID();
    await db.integrationOutbox.create({
      data: {
        tenantId,
        kind: 'ADAPTER',
        sink: 'erp',
        targetId: cid,
        operation: 'PUSH_INVOICE',
        entityType: 'invoice',
        localId,
        serializeKey: `erp:${cid}:invoice:${localId}`,
        idempotencyKey: `t20-${localId}`,
        status: 'FAILED_FINAL',
        errorClass: 'VALIDATION',
        lastError: { code: 'AMOUNT_MISMATCH', message: `secret ${SECRET}` },
      },
    });
    const mine = await api(app, ownerToken).get(`/v1/connectors/${conId}/commands`).expect(200);
    expect(mine.body.data[0]).toMatchObject({
      operation: 'PUSH_INVOICE',
      status: 'FAILED_FINAL',
      errorCode: 'AMOUNT_MISMATCH',
    });
    expect(JSON.stringify(mine.body)).not.toContain(SECRET);
    const all = await as('SUPPORT').get('/v1/platform/connectors/commands').expect(200);
    expect(all.body.data[0]).toMatchObject({
      tenantName: 'บริษัท นำร่องเชื่อมบัญชี',
      connectorId: conId,
      adapterKey: 'demo',
    });
    const list = await as('SUPPORT')
      .get(`/v1/platform/connectors?tenantId=${tenantPub}`)
      .expect(200);
    expect(list.body.data[0].queue).toEqual({ open: 0, failed: 1 });
  });

  it('แพ็กเกจไม่มี conn → 403 · sandbox/ไม่มีบริษัท → 404', async () => {
    const t2 = await createTenant(db, 'บริษัท แพ็กเกจเริ่มต้น');
    await db.tenant.update({ where: { id: t2.id }, data: { planCode: 'start' } });
    const r = await as('SUPER_ADMIN')
      .post(`/v1/platform/tenants/${encodeId('tenant', t2.id)}/connectors`)
      .send({ adapterKey: 'demo', credentials: { apiKey: SECRET }, reason: 'เปิดให้ทดลองใช้งาน' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('feature_not_in_plan');
    const sb = await db.tenant.create({
      data: { name: 'sandbox', mode: 'test', liveTenantId: tenantId, planCode: 'ent' },
    });
    await as('SUPER_ADMIN')
      .post(`/v1/platform/tenants/${encodeId('tenant', sb.id)}/connectors`)
      .send({ adapterKey: 'demo', credentials: { apiKey: SECRET }, reason: 'เปิดให้ sandbox ลอง' })
      .expect(404);
    await as('SUPER_ADMIN')
      .post(`/v1/platform/connectors/${encodeId('connector', randomUUID())}/health`)
      .expect(404);
  });
});
