import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { checkState, VIEW_LIMIT } from '../src/modules/saved-views/saved-views.service';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

const URL = '/v1/saved-views';

/**
 * ST9-T11 มุมมองที่บันทึกไว้ (`/v1/saved-views`) — เกณฑ์ตรวจรับ: บันทึก view แล้วเปิดใหม่ได้ filter/คอลัมน์เดิม
 * ต่อผู้ใช้: ผู้ใช้อื่นใน tenant เดียวกัน/บริษัทอื่น/API key มองไม่เห็น (404)
 */
describe('saved views (ST9-T11)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherTenant: string;
  let userA: string;
  let userB: string;
  let userX: string;
  // ผู้ใช้ทุก role ใช้ได้ (ไม่ต้องมี scope เฉพาะ) — ใช้ scope แคบ ๆ ทดสอบ
  const tok = (tid: string, sub: string) => tokenFor(tid, 'orders:read', sub);
  const asA = async () => api(app, await tok(tenantId, userA));

  async function user(tid: string, email: string) {
    return (
      await db.appUser.create({ data: { tenantId: tid, email, name: email, status: 'ACTIVE' } })
    ).id;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    otherTenant = (await createTenant(db)).id;
    userA = await user(tenantId, 'a@view.test');
    userB = await user(tenantId, 'b@view.test');
    userX = await user(otherTenant, 'x@view.test');
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('บันทึกแล้วเปิดใหม่ (token ใหม่) ได้ตัวกรอง + คอลัมน์เดิม', async () => {
    const state = { tab: 'all', q: 'SO-2569', st: 'hold:CUSTOMER_UNMAPPED', overdue: false };
    const c = await (
      await asA()
    )
      .post(URL)
      .send({ page: 'orders', name: '  ของฉันวันนี้ ', state, hiddenColumns: ['source', 'source'] })
      .expect(201);
    expect(c.body).toMatchObject({
      page: 'orders',
      name: 'ของฉันวันนี้',
      state,
      hiddenColumns: ['source'],
      isDefault: false,
      version: 1,
    });
    expect(c.body.id).toMatch(/^svw_[0-9a-f]{32}$/);
    expect(c.headers.etag).toBe('"1"');
    const l = await (await asA()).get(`${URL}?page=orders`).expect(200);
    expect(l.body.data).toHaveLength(1);
    expect(l.body.data[0]).toEqual(c.body);
    const g = await (await asA()).get(`${URL}/${c.body.id}`).expect(200);
    expect(g.body).toEqual(c.body);
    // หน้าอื่นไม่ปน
    expect((await (await asA()).get(`${URL}?page=vehicles`).expect(200)).body.data).toEqual([]);
  });

  it('ผู้ใช้อื่นใน tenant เดียวกัน / บริษัทอื่น / API key (ไม่ใช่ผู้ใช้) → ไม่เห็น 404', async () => {
    const c = await (
      await asA()
    )
      .post(URL)
      .send({ page: 'vehicles', name: 'รถว่าง', state: { tab: 'ready' } })
      .expect(201);
    const b = api(app, await tok(tenantId, userB));
    expect((await b.get(`${URL}?page=vehicles`).expect(200)).body.data).toEqual([]);
    await b.get(`${URL}/${c.body.id}`).expect(404);
    await b.patch(`${URL}/${c.body.id}`).send({ name: 'ขโมย' }).expect(404);
    await b.delete(`${URL}/${c.body.id}`).expect(404);
    const x = api(app, await tok(otherTenant, userX));
    await x.get(`${URL}/${c.body.id}`).expect(404);
    // token ที่ sub ไม่ใช่ผู้ใช้ (เช่น API key / dev) → 404
    const k = api(app, await tokenFor(tenantId, '*', 'svc-key'));
    await k.get(`${URL}?page=vehicles`).expect(404);
    await k.post(URL).send({ page: 'vehicles', name: 'k', state: {} }).expect(404);
    // ยังอยู่ครบ
    expect((await (await asA()).get(`${URL}/${c.body.id}`).expect(200)).body.name).toBe('รถว่าง');
  });

  it('ชื่อซ้ำในหน้าเดียวกัน (ไม่สนตัวพิมพ์) → 409 duplicate · คนละหน้า/คนละผู้ใช้ได้', async () => {
    const a = await asA();
    await a.post(URL).send({ page: 'orders.hold', name: 'Today', state: {} }).expect(201);
    const d = await a.post(URL).send({ page: 'orders.hold', name: 'TODAY', state: {} }).expect(409);
    expect(d.body.code).toBe('duplicate');
    expect(d.body.errors[0].field).toBe('name');
    await a.post(URL).send({ page: 'vehicles', name: 'Today', state: {} }).expect(201);
    await api(app, await tok(tenantId, userB))
      .post(URL)
      .send({ page: 'orders.hold', name: 'today', state: {} })
      .expect(201);
  });

  it('ค่าเริ่มต้นได้ 1 มุมมองต่อหน้า — ตั้งใหม่ยกเลิกอันเดิม', async () => {
    const a = await asA();
    const v1 = (
      await a
        .post(URL)
        .send({ page: 'p.def', name: 'หนึ่ง', state: {}, isDefault: true })
        .expect(201)
    ).body;
    const v2 = (
      await a.post(URL).send({ page: 'p.def', name: 'สอง', state: {}, isDefault: true }).expect(201)
    ).body;
    let l = (await a.get(`${URL}?page=p.def`).expect(200)).body.data;
    expect(l.find((x: { id: string }) => x.id === v1.id).isDefault).toBe(false);
    expect(l.find((x: { id: string }) => x.id === v2.id).isDefault).toBe(true);
    await a.patch(`${URL}/${v1.id}`).send({ isDefault: true }).expect(200);
    l = (await a.get(`${URL}?page=p.def`).expect(200)).body.data;
    expect(
      l.filter((x: { isDefault: boolean }) => x.isDefault).map((x: { id: string }) => x.id),
    ).toEqual([v1.id]);
  });

  it('แก้ด้วย If-Match: ตรง → version+1 · เก่า → 412 · hiddenColumns null = ค่าเริ่มต้น', async () => {
    const a = await asA();
    const v = (
      await a
        .post(URL)
        .send({ page: 'p.edit', name: 'แก้', state: { q: 'a' }, hiddenColumns: ['x'] })
        .expect(201)
    ).body;
    const u = await a
      .patch(`${URL}/${v.id}`)
      .set('If-Match', '"1"')
      .send({ state: { q: 'b', overdue: true }, hiddenColumns: null, name: 'แก้แล้ว' })
      .expect(200);
    expect(u.body).toMatchObject({
      name: 'แก้แล้ว',
      state: { q: 'b', overdue: true },
      hiddenColumns: null,
      version: 2,
    });
    expect(u.headers.etag).toBe('"2"');
    const s = await a
      .patch(`${URL}/${v.id}`)
      .set('If-Match', '"1"')
      .send({ name: 'x' })
      .expect(412);
    expect(s.body.code).toBe('precondition_failed');
    await a.delete(`${URL}/${v.id}`).set('If-Match', '"1"').expect(412);
  });

  it('ลบ = soft (แถวยังอยู่ deleted_at) · หายจากรายการ · ชื่อเดิมใช้ใหม่ได้', async () => {
    const a = await asA();
    const v = (
      await a.post(URL).send({ page: 'p.del', name: 'ลบ', state: {}, isDefault: true }).expect(201)
    ).body;
    await a.delete(`${URL}/${v.id}`).set('If-Match', '"1"').expect(204);
    await a.get(`${URL}/${v.id}`).expect(404);
    expect((await a.get(`${URL}?page=p.del`).expect(200)).body.data).toEqual([]);
    const row = await db.savedView.findUnique({ where: { id: tryDecodeId('savedView', v.id)! } });
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.isDefault).toBe(false);
    await a.post(URL).send({ page: 'p.del', name: 'ลบ', state: {}, isDefault: true }).expect(201);
  });

  it('ตรวจรูปแบบ → 422 รายช่อง', async () => {
    const a = await asA();
    const bad = async (body: object) =>
      (await a.post(URL).send(body).expect(422)).body.errors.map((e: { field: string }) => e.field);
    expect(await bad({ page: 'Orders!', name: 'x', state: {} })).toContain('page');
    expect(await bad({ page: 'orders', name: '', state: {} })).toContain('name');
    expect(await bad({ page: 'orders', name: 'x'.repeat(61), state: {} })).toContain('name');
    expect(await bad({ page: 'orders', name: 'x', state: [] })).toContain('state');
    expect(await bad({ page: 'orders', name: 'x', state: { q: 'x'.repeat(201) } })).toEqual([
      'state.q',
    ]);
    expect(await bad({ page: 'orders', name: 'x', state: { q: { a: 1 } } })).toEqual(['state.q']);
    expect(await bad({ page: 'orders', name: 'x', state: { 'bad key': 1 } })).toEqual([
      'state.bad key',
    ]);
    expect(
      await bad({ page: 'orders', name: 'x', state: {}, hiddenColumns: ['ok', 'no space'] }),
    ).toContain('hiddenColumns');
    expect(await bad({ page: 'orders', name: 'x', state: {}, isDefault: null })).toContain(
      'isDefault',
    );
    await a.get(`${URL}`).expect(422);
  });

  it('checkState: ขนาดรวม/จำนวน key', () => {
    const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, 1]));
    expect(() => checkState(many)).toThrow();
    const big = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`k${i}`, 'x'.repeat(190)]),
    );
    expect(() => checkState(big)).toThrow();
    expect(checkState({ a: null, b: 1, c: true, d: 'x' })).toEqual({
      a: null,
      b: 1,
      c: true,
      d: 'x',
    });
  });

  it(`เกิน ${VIEW_LIMIT} มุมมองต่อหน้า → 409 saved_view_limit`, async () => {
    await db.savedView.createMany({
      data: Array.from({ length: VIEW_LIMIT }, (_, i) => ({
        tenantId,
        userId: userA,
        page: 'p.limit',
        name: `v${i}`,
        state: {},
      })),
    });
    const r = await (
      await asA()
    )
      .post(URL)
      .send({ page: 'p.limit', name: 'เกิน', state: {} })
      .expect(409);
    expect(r.body.code).toBe('saved_view_limit');
    expect(r.body.limit).toBe(VIEW_LIMIT);
    expect(r.body.title).toBe('บันทึกได้สูงสุด 50 มุมมองต่อหน้า');
  });
});
