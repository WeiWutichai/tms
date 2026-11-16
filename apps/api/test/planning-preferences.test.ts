import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service';
import { normalize } from '../src/modules/planning/board-preferences.service';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

const URL = '/v1/planning/board/preferences';
const ALL = ['ORDER_NO', 'CUSTOMER', 'TIME', 'ROUTE', 'WEIGHT'];

/**
 * ST3-T13 มุมมองกระดาน + field บนการ์ด จำต่อผู้ใช้ฝั่ง server (docs/04 D2 "View")
 * GET/PUT /v1/planning/board/preferences — ตาราง user_preference (RLS ต่อ tenant)
 */
describe('planning board preferences (ST3-T13)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherTenant: string;
  let userA: string;
  let userB: string;
  let userOther: string;
  const planner = SYSTEM_ROLES.planner.permissions.join(' ');
  const tok = (tid: string, sub: string, scope = planner) => tokenFor(tid, scope, sub);

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
    userA = await user(tenantId, 'a@pref.test');
    userB = await user(tenantId, 'b@pref.test');
    userOther = await user(otherTenant, 'x@pref.test');
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('ยังไม่เคยบันทึก → ค่าเริ่มต้น "รถบริษัท + รถร่วม" + ทุก field (version 0)', async () => {
    const r = await api(app, await tok(tenantId, userA))
      .get(URL)
      .expect(200);
    expect(r.body).toEqual({ view: 'FLEET', cardFields: ALL, version: 0 });
    expect(r.headers.etag).toBe('"0"');
  });

  it('บันทึกแล้วอ่านกลับได้ด้วย token ใหม่ (login ใหม่) — field เรียงตามลำดับมาตรฐาน', async () => {
    const put = await api(app, await tok(tenantId, userA))
      .put(URL)
      .send({ view: 'DRIVER', cardFields: ['WEIGHT', 'ORDER_NO'] })
      .expect(200);
    expect(put.body).toEqual({ view: 'DRIVER', cardFields: ['ORDER_NO', 'WEIGHT'], version: 1 });
    expect(put.headers.etag).toBe('"1"');
    const again = await api(app, await tok(tenantId, userA, `${planner} `))
      .get(URL)
      .expect(200);
    expect(again.body).toEqual({ view: 'DRIVER', cardFields: ['ORDER_NO', 'WEIGHT'], version: 1 });
    // แทนทั้งชุด — version เพิ่ม
    const p2 = await api(app, await tok(tenantId, userA))
      .put(URL)
      .set('If-Match', '"1"')
      .send({ view: 'CARRIER', cardFields: ALL })
      .expect(200);
    expect(p2.body.version).toBe(2);
  });

  it('ค่าของผู้ใช้แต่ละคนแยกกัน', async () => {
    const r = await api(app, await tok(tenantId, userB))
      .get(URL)
      .expect(200);
    expect(r.body.view).toBe('FLEET');
    await api(app, await tok(tenantId, userB))
      .put(URL)
      .send({ view: 'VEHICLE', cardFields: ['ROUTE'] })
      .expect(200);
    const a = await api(app, await tok(tenantId, userA))
      .get(URL)
      .expect(200);
    expect(a.body.view).toBe('CARRIER');
  });

  it('If-Match ไม่ตรง → 412 (บันทึกจากอีกแท็บ)', async () => {
    await api(app, await tok(tenantId, userA))
      .put(URL)
      .set('If-Match', '"1"')
      .send({ view: 'FLEET', cardFields: ALL })
      .expect(412);
  });

  it('ค่าไม่ถูกต้อง → 422', async () => {
    const t = await tok(tenantId, userA);
    for (const body of [
      { view: 'CUSTOMER', cardFields: ALL },
      { view: 'FLEET', cardFields: [] },
      { view: 'FLEET', cardFields: ['ORDER_NO', 'ORDER_NO'] },
      { view: 'FLEET', cardFields: ['PRICE'] },
      { view: 'FLEET' },
    ])
      await api(app, t).put(URL).send(body).expect(422);
  });

  it('ต้องมี trips:read · API key (ไม่ใช่ผู้ใช้) → 404', async () => {
    await api(app, await tok(tenantId, userA, 'orders:read'))
      .get(URL)
      .expect(403);
    await api(app, await tok(tenantId, 'key-not-a-user'))
      .get(URL)
      .expect(404);
    await api(app, await tok(tenantId, 'key-not-a-user'))
      .put(URL)
      .send({ view: 'FLEET', cardFields: ALL })
      .expect(404);
  });

  it('แยก tenant: ผู้ใช้ tenant อื่นอ่าน/เขียนค่าของตัวเองเท่านั้น · token ปลอม tenant → 404', async () => {
    await api(app, await tok(otherTenant, userOther))
      .put(URL)
      .send({ view: 'VEHICLE', cardFields: ['TIME'] })
      .expect(200);
    // sub ของผู้ใช้ tenant อื่นกับ tenant นี้ → ไม่พบผู้ใช้ (RLS) = 404
    await api(app, await tok(tenantId, userOther))
      .get(URL)
      .expect(404);
    const dbs = app.get(DbService);
    const mine = await dbs.withTenant(tenantId, (tx) => tx.userPreference.findMany());
    expect(mine.map((r) => r.userId).sort()).toEqual([userA, userB].sort());
    const theirs = await dbs.withTenant(otherTenant, (tx) => tx.userPreference.findMany());
    expect(theirs.map((r) => r.userId)).toEqual([userOther]);
  });

  it('ค่าที่เก็บเสีย/view ที่ไม่รู้จัก → ค่าเริ่มต้น (อ่านได้เสมอ)', () => {
    expect(normalize({ view: 'X', cardFields: ['NOPE'] })).toEqual({
      view: 'FLEET',
      cardFields: ALL,
    });
    expect(normalize(null)).toEqual({ view: 'FLEET', cardFields: ALL });
    expect(normalize({ view: 'CARRIER', cardFields: ['TIME', 'TIME', 'CUSTOMER'] })).toEqual({
      view: 'CARRIER',
      cardFields: ['CUSTOMER', 'TIME'],
    });
  });
});
