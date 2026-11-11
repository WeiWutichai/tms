import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const ADDR = {
  line1: '1/1 ถนนตัวอย่าง',
  subdistrict: 'ตัวอย่าง',
  district: 'เมืองตัวอย่าง',
  province: 'กรุงเทพมหานคร',
  postcode: '10000',
};

/** ST1-T21: tenant ใหม่เห็น 0%; ทำครบแต่ละขั้นแล้ว % เพิ่มเองโดยไม่ต้องติ๊ก */
describe('setup checklist (ST1-T21)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tA: string;
  let owner: string;
  let a: ReturnType<typeof api>;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    // สร้างแบบเดียวกับสมัครจริง (ค่าเริ่มต้น settings/ชุดเลขเอกสาร) — ยังต้องเห็น 0%
    tA = (await createTenantWithDefaults(db, { name: 'บริษัท เริ่มใหม่ จำกัด' })).id;
    const roles = await ensureSystemRoles(db, tA);
    const u = await db.appUser.create({
      data: { tenantId: tA, email: 'owner@setup.test', name: 'owner', status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId: tA, userId: u.id, roleId: roles.owner! } });
    owner = u.id;
    a = api(app, await tokenFor(tA, '*', owner));
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const status = async () => {
    const r = (await a.get('/v1/setup-checklist').expect(200)).body;
    return {
      ...r,
      map: Object.fromEntries(
        r.steps.map((s: { key: string; status: string }) => [s.key, s.status]),
      ),
    };
  };

  it('tenant ใหม่ 0/7 → ทำทีละขั้นแล้วเพิ่มเอง → ครบขั้นบังคับ = completed + audit', async () => {
    const s0 = await status();
    expect(s0).toMatchObject({ done: 0, total: 7, completed: false, hidden: false });
    expect(s0.steps.map((s: { key: string }) => s.key)).toEqual([
      'org',
      'branch',
      'numbering',
      'tax',
      'import',
      'team',
      'connector',
    ]);
    expect(s0.steps.find((s: { key: string }) => s.key === 'connector').required).toBe(false);

    await a
      .patch('/v1/settings')
      .send({ values: { 'org.name': 'เริ่มใหม่' } })
      .expect(200);
    expect((await status()).map.org).toBe('done');

    const co = (
      await a
        .post('/v1/companies')
        .send({ legalName: 'บริษัท เริ่มใหม่ จำกัด', taxId: validTaxId(7) })
        .expect(201)
    ).body;
    await a
      .post('/v1/branches')
      .send({ companyId: co.id, branchCode: '00000', address: ADDR })
      .expect(201);
    expect((await status()).map.branch).toBe('done');

    const seq = (await a.get('/v1/document-sequences').expect(200)).body.data[0];
    await a.patch(`/v1/document-sequences/${seq.id}`).send({ prefix: 'NEW-SO-' }).expect(200);
    expect((await status()).map.numbering).toBe('done');

    // บันทึกค่าเดิม (ค่าเริ่มต้น) ไม่เปลี่ยนอะไร → ยังไม่นับ; หน้าตั้งค่ายืนยันผ่าน /reviewed แทน
    await a
      .patch('/v1/settings')
      .send({ values: { 'tax.vatDefault': 'VAT_7' } })
      .expect(200);
    expect((await status()).map.tax).toBe('todo');
    await a.post('/v1/setup-checklist/reviewed').send({ step: 'branch' }).expect(422);
    await a.post('/v1/setup-checklist/reviewed').send({ step: 'tax' }).expect(200);
    await a.post('/v1/setup-checklist/reviewed').send({ step: 'tax' }).expect(200);
    expect((await status()).map.tax).toBe('done');
    expect(
      await db.auditLog.count({ where: { tenantId: tA, action: 'setup.step_reviewed' } }),
    ).toBe(1);

    await db.customer.create({
      data: { tenantId: tA, code: 'C1', legalName: 'ลูกค้า', billingAddress: ADDR },
    });
    expect((await status()).map.import).toBe('done');

    await db.appUser.create({
      data: { tenantId: tA, email: 'b@setup.test', name: 'b', status: 'ACTIVE' },
    });
    // หลายคนเปิดหน้าภาพรวมพร้อมกันตอนครบ → audit setup.completed ครั้งเดียว
    const all = await Promise.all(Array.from({ length: 6 }, () => status()));
    expect(all.every((x) => x.completed)).toBe(true);
    const s6 = await status();
    expect(s6.map.team).toBe('done');
    expect(s6).toMatchObject({ done: 6, completed: true });
    expect(await db.auditLog.count({ where: { tenantId: tA, action: 'setup.completed' } })).toBe(1);

    // ครบแล้วการ์ดหายถาวร: ลบข้อมูลภายหลังไม่ย้อนกลับเป็นไม่ครบ (PLT-041)
    await db.appUser.updateMany({ where: { email: 'b@setup.test' }, data: { status: 'DISABLED' } });
    expect((await status()).completed).toBe(true);
    await status();
    expect(await db.auditLog.count({ where: { tenantId: tA, action: 'setup.completed' } })).toBe(1);
  });

  it('ข้ามขั้นเชื่อมระบบบัญชี (เหตุผลบังคับ + audit), ซ่อน/แสดงต่อผู้ใช้', async () => {
    await a.post('/v1/setup-checklist/connector-skip').send({}).expect(422);
    const s = (
      await a
        .post('/v1/setup-checklist/connector-skip')
        .send({ reason: 'ใช้ TMS ออกเอกสารเอง' })
        .expect(200)
    ).body;
    expect(s.steps.find((x: { key: string }) => x.key === 'connector').status).toBe('skipped');
    expect((await a.post('/v1/setup-checklist/hide').expect(200)).body.hidden).toBe(true);
    expect((await a.post('/v1/setup-checklist/show').expect(200)).body.hidden).toBe(false);
  });

  it('ไม่มีสิทธิ์ตั้งค่า → 403; tenant อื่นนับเฉพาะของตัวเอง', async () => {
    await api(app, await tokenFor(tA, 'orders:read', owner))
      .get('/v1/setup-checklist')
      .expect(403);
    const tB = (await createTenant(db, 'บี')).id;
    // tenant ใหม่เปิดพร้อมกันหลายแท็บ (ยังไม่มีแถวสถานะ) → ทุก request ได้ 200
    const tok = await tokenFor(tB, '*');
    const par = await Promise.all(
      Array.from({ length: 12 }, () => api(app, tok).get('/v1/setup-checklist')),
    );
    expect(par.map((r) => r.status)).toEqual(Array(12).fill(200));
    const b = (
      await api(app, await tokenFor(tB, '*'))
        .get('/v1/setup-checklist')
        .expect(200)
    ).body;
    expect(b).toMatchObject({ done: 0, completed: false });
  });
});
