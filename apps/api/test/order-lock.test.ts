import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST3-T08 Edit lock (docs/04 C): ป้าย "กำลังแก้ไขโดย …" คนอื่น read-only, หมดอายุ 10 นาทีไม่มีกิจกรรม, `orders:unlock` ปลดของคนอื่น
 * เกณฑ์ตรวจรับ: ผู้ใช้ B เปิดใบที่ A แก้อยู่ → อ่านอย่างเดียว (409 เมื่อขอล็อก/แก้); ครบ 10 นาที ล็อกหลุด
 */
describe('order edit lock (ST3-T08)', () => {
  let app: NestExpressApplication;
  let clock: Clock;
  const db = platform();
  let tenantId: string;
  let otherTenant: string;
  let userA: string;
  let userB: string;
  let userM: string;
  let tokA: string;
  let tokB: string;
  let tokM: string;
  let tokApi: string;
  let tokOther: string;
  let seed = 0;
  const today = bangkokToday();
  const T0 = new Date('2026-11-13T02:00:00.000Z');
  const MIN = 60_000;

  const user = async (tid: string, name: string) =>
    (
      await db.appUser.create({
        data: { tenantId: tid, email: `u${++seed}@example.test`, name, status: 'ACTIVE' },
      })
    ).id;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    clock = app.get(Clock);
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง ล็อก' })).id;
    otherTenant = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง อื่น' })).id;
    for (const tid of [tenantId, otherTenant]) {
      const c = await db.company.create({
        data: {
          tenantId: tid,
          legalName: `บริษัท ออกบิล ${++seed}`,
          taxId: validTaxId(800 + seed),
        },
      });
      await db.branch.create({
        data: {
          tenantId: tid,
          companyId: c.id,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
          isDefaultIssuer: true,
        },
      });
    }
    userA = await user(tenantId, 'สมชาย ใจดี');
    userB = await user(tenantId, 'สมหญิง รักงาน');
    userM = await user(tenantId, 'ผู้จัดการ ทดสอบ');
    const planner = SYSTEM_ROLES.planner.permissions.join(' ');
    tokA = await tokenFor(tenantId, planner, userA);
    tokB = await tokenFor(tenantId, planner, userB);
    tokM = await tokenFor(tenantId, SYSTEM_ROLES.manager.permissions.join(' '), userM);
    // token ที่ไม่ใช่ผู้ใช้ (เช่น API client / connector)
    tokApi = await tokenFor(tenantId, '*', 'api-client-1');
    tokOther = await tokenFor(otherTenant, '*', await user(otherTenant, 'คนบริษัทอื่น'));
  });
  afterEach(() => clock.set(null));
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const newOrder = async (token = tokA) =>
    (
      await api(app, token)
        .post('/v1/orders')
        .send({
          draft: true,
          requestedDate: today,
          customerRef: `PO-${++seed}`,
          stops: [{ type: 'PICKUP', siteText: 'คลังทดสอบ' }],
        })
        .expect(201)
    ).body as { id: string; version: number };
  const lock = (id: string, token: string) => api(app, token).post(`/v1/orders/${id}/lock`).send();
  const unlock = (id: string, token: string, reason?: string) =>
    api(app, token)
      .post(`/v1/orders/${id}/unlock`)
      .send(reason === undefined ? {} : { reason });
  const patch = (id: string, token: string, body: object) =>
    api(app, token).patch(`/v1/orders/${id}`).send(body);

  it('A ขอล็อก → 200 ผู้ถือ + หมดอายุ 10 นาที; GET แสดง editLock (mine ตามผู้เรียก)', async () => {
    clock.set(T0);
    const o = await newOrder();
    const r = await lock(o.id, tokA).expect(200);
    expect(r.body).toMatchObject({
      userId: encodeId('user', userA),
      userName: 'สมชาย ใจดี',
      acquiredAt: T0.toISOString(),
      lastSeenAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + 10 * MIN).toISOString(),
      mine: true,
    });
    const asA = await api(app, tokA).get(`/v1/orders/${o.id}`).expect(200);
    expect(asA.body.editLock).toMatchObject({ userName: 'สมชาย ใจดี', mine: true });
    // ป้ายล็อกเปลี่ยนโดย version ไม่เปลี่ยน → browser ห้ามเก็บ (ไม่งั้นได้ 304 จาก ETag + ข้อมูลล็อกเก่า)
    expect(asA.headers['cache-control']).toBe('no-store');
    // conditional GET ด้วย ETag เดิม (version ไม่เปลี่ยน) → ยังได้ 200 + สถานะล็อกล่าสุด ไม่ใช่ 304
    await unlock(o.id, tokA).expect(204);
    const again = await api(app, tokA)
      .get(`/v1/orders/${o.id}`)
      .set('If-None-Match', asA.headers.etag as string)
      .expect(200);
    expect(again.headers.etag).toBe(asA.headers.etag);
    expect(again.body.editLock).toBeNull();
    await lock(o.id, tokA).expect(200);
    const asB = await api(app, tokB).get(`/v1/orders/${o.id}`).expect(200);
    expect(asB.body.editLock).toMatchObject({ userName: 'สมชาย ใจดี', mine: false });
    // ไม่มีล็อก = null
    const free = await newOrder();
    expect(
      (await api(app, tokB).get(`/v1/orders/${free.id}`).expect(200)).body.editLock,
    ).toBeNull();
  });

  it('B เปิดใบที่ A แก้อยู่ → ขอล็อก 409 order_locked_by_user (บอกชื่อ A) และ PATCH 409 — A แก้ได้และต่ออายุ', async () => {
    clock.set(T0);
    const o = await newOrder();
    await lock(o.id, tokA).expect(200);
    const b = await lock(o.id, tokB).expect(409);
    expect(b.body.code).toBe('order_locked_by_user');
    expect(b.body.editLock).toMatchObject({ userName: 'สมชาย ใจดี', mine: false });
    const p = await patch(o.id, tokB, { customerRef: 'PO-B' }).expect(409);
    expect(p.body.code).toBe('order_locked_by_user');
    expect(
      (await db.salesOrder.findUnique({ where: { id: tryDecodeId('salesOrder', o.id)! } }))!
        .customerRef,
    ).not.toBe('PO-B');
    // A แก้ได้ — นับเป็นกิจกรรม (ต่ออายุจากเวลาที่แก้)
    clock.set(new Date(T0.getTime() + 7 * MIN));
    const a = await patch(o.id, tokA, { customerRef: 'PO-A' }).expect(200);
    expect(a.body.customerRef).toBe('PO-A');
    expect(a.body.editLock.expiresAt).toBe(new Date(T0.getTime() + 17 * MIN).toISOString());
  });

  it('heartbeat ของผู้ถือต่ออายุ (acquiredAt เดิม) — ครบ 10 นาทีไม่มีกิจกรรม ล็อกหลุด: B ได้ล็อก, A ถูกปฏิเสธ', async () => {
    clock.set(T0);
    const o = await newOrder();
    await lock(o.id, tokA).expect(200);
    clock.set(new Date(T0.getTime() + 6 * MIN));
    const hb = await lock(o.id, tokA).expect(200);
    expect(hb.body.acquiredAt).toBe(T0.toISOString());
    expect(hb.body.expiresAt).toBe(new Date(T0.getTime() + 16 * MIN).toISOString());
    // 9 นาทีหลัง heartbeat — ยังล็อก
    clock.set(new Date(T0.getTime() + 15 * MIN));
    await lock(o.id, tokB).expect(409);
    // ครบ 10 นาทีหลังกิจกรรมล่าสุด → หลุด
    clock.set(new Date(T0.getTime() + 16 * MIN));
    expect((await api(app, tokB).get(`/v1/orders/${o.id}`).expect(200)).body.editLock).toBeNull();
    await patch(o.id, tokB, { customerRef: 'PO-B-หลังหมดอายุ' }).expect(200);
    const b = await lock(o.id, tokB).expect(200);
    expect(b.body).toMatchObject({ userName: 'สมหญิง รักงาน', mine: true });
    expect(b.body.acquiredAt).toBe(new Date(T0.getTime() + 16 * MIN).toISOString());
    await lock(o.id, tokA).expect(409);
  });

  it('ขอล็อกพร้อมกัน → ได้คนเดียว อีกคน 409', async () => {
    const o = await newOrder();
    const rs = await Promise.all([lock(o.id, tokA), lock(o.id, tokB), lock(o.id, tokA)]);
    const owners = new Set(rs.filter((r) => r.status === 200).map((r) => r.body.userId));
    expect(owners.size).toBe(1);
    expect(rs.every((r) => r.status === 200 || r.body.code === 'order_locked_by_user')).toBe(true);
    expect(
      await db.orderEditLock.count({ where: { salesOrderId: tryDecodeId('salesOrder', o.id)! } }),
    ).toBe(1);
  });

  it('ปลดของตัวเอง 204 (ส่งซ้ำได้) → คนอื่นขอได้ทันที', async () => {
    const o = await newOrder();
    await lock(o.id, tokA).expect(200);
    await unlock(o.id, tokA).expect(204);
    await unlock(o.id, tokA).expect(204);
    await lock(o.id, tokB).expect(200);
  });

  it('ปลดของคนอื่น: ไม่มีสิทธิ์ → 403; manager (`orders:unlock`) ต้องมีเหตุผล ≥ 10 ตัว + ลง audit', async () => {
    const o = await newOrder();
    const soId = tryDecodeId('salesOrder', o.id)!;
    await lock(o.id, tokA).expect(200);
    const denied = await unlock(o.id, tokB, 'ขอแก้ด่วนมากครับ').expect(403);
    expect(denied.body).toMatchObject({ code: 'permission_denied', required: ['orders:unlock'] });
    const short = await unlock(o.id, tokM, 'สั้น').expect(422);
    expect(short.body.errors[0]).toMatchObject({ field: 'reason', code: 'minLength' });
    await unlock(o.id, tokM).expect(422);
    expect(
      (await api(app, tokB).get(`/v1/orders/${o.id}`).expect(200)).body.editLock,
    ).not.toBeNull();
    await unlock(o.id, tokM, 'ผู้แก้ลาป่วย ต้องแก้วันรับของด่วน').expect(204);
    expect((await api(app, tokB).get(`/v1/orders/${o.id}`).expect(200)).body.editLock).toBeNull();
    const audit = await db.auditLog.findMany({
      where: { tenantId, entityId: soId, action: 'order.edit_lock_released' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: userM, reason: 'ผู้แก้ลาป่วย ต้องแก้วันรับของด่วน' });
    expect(audit[0]!.before).toMatchObject({
      userId: encodeId('user', userA),
      userName: 'สมชาย ใจดี',
    });
    // ปลดแล้วไม่นับเป็นล็อก — B เปิดแก้ได้ทันที แล้ว A ขอไม่ได้ (B ถืออยู่)
    await lock(o.id, tokB).expect(200);
    await lock(o.id, tokA).expect(409);
  });

  it('QA: ผู้จัดการปลดล็อก → ผู้ถือเดิม heartbeat/PATCH ได้ 409 order_lock_released (ไม่ได้ล็อกคืนเงียบ ๆ) จนกว่าจะเปิดแก้ใหม่', async () => {
    clock.set(T0);
    const o = await newOrder();
    await lock(o.id, tokA).expect(200);
    await unlock(o.id, tokM, 'ผู้แก้ไม่อยู่ ต้องแก้วันรับของด่วน').expect(204);
    // ไม่นับเป็นล็อก — คนอื่นเห็นว่าว่าง
    expect((await api(app, tokB).get(`/v1/orders/${o.id}`).expect(200)).body.editLock).toBeNull();
    // A ต่ออายุ (heartbeat) → 409 พร้อมชื่อผู้ปลด + เหตุผล ไม่ได้ล็อกคืน
    clock.set(new Date(T0.getTime() + MIN));
    const hb = await api(app, tokA)
      .post(`/v1/orders/${o.id}/lock`)
      .send({ heartbeat: true })
      .expect(409);
    expect(hb.body).toMatchObject({
      code: 'order_lock_released',
      releasedBy: { userId: encodeId('user', userM), userName: 'ผู้จัดการ ทดสอบ' },
      reason: 'ผู้แก้ไม่อยู่ ต้องแก้วันรับของด่วน',
    });
    expect((await api(app, tokB).get(`/v1/orders/${o.id}`).expect(200)).body.editLock).toBeNull();
    // A บันทึก (PATCH) → 409 เช่นกัน · ข้อมูลไม่เปลี่ยน
    const p = await patch(o.id, tokA, { customerRef: 'PO-A-หลังถูกปลด' }).expect(409);
    expect(p.body.code).toBe('order_lock_released');
    // คนอื่น (ไม่ได้ถูกปลด) แก้ได้ตามปกติ — ไม่มีล็อก
    await patch(o.id, tokB, { customerRef: 'PO-B-หลังปลด' }).expect(200);
    // คนอื่นเรียกปลด (ไม่มีล็อก) ไม่ลบการแจ้งของ A
    await unlock(o.id, tokB).expect(204);
    await api(app, tokA).post(`/v1/orders/${o.id}/lock`).send({ heartbeat: true }).expect(409);
    // A เปิดแก้ใหม่ (โหลดใหม่) → ได้ล็อก แล้วบันทึกได้
    const re = await lock(o.id, tokA).expect(200);
    expect(re.body).toMatchObject({ mine: true });
    await patch(o.id, tokA, { customerRef: 'PO-A-เปิดใหม่' }).expect(200);
  });

  it('QA: ผู้จัดการปลดแล้วเปิดแก้เอง แล้วปิด (ล็อกถูกลบ) → A ยังได้ 409 order_lock_released ไม่ได้ล็อกคืนเงียบ ๆ', async () => {
    const o = await newOrder();
    await lock(o.id, tokA).expect(200);
    await unlock(o.id, tokM, 'ผู้แก้ไม่อยู่ ต้องแก้วันรับของด่วน').expect(204);
    await lock(o.id, tokM).expect(200);
    const hb = (heartbeatTok: string) =>
      api(app, heartbeatTok).post(`/v1/orders/${o.id}/lock`).send({ heartbeat: true });
    expect((await hb(tokA).expect(409)).body).toMatchObject({
      code: 'order_lock_released',
      releasedBy: { userName: 'ผู้จัดการ ทดสอบ' },
    });
    expect((await patch(o.id, tokA, { customerRef: 'x' }).expect(409)).body.code).toBe(
      'order_lock_released',
    );
    // ผู้จัดการปิดฟอร์ม (ปลดของตัวเอง — ไม่มีล็อกเหลือ) → A heartbeat/PATCH ยังไม่ได้
    await unlock(o.id, tokM).expect(204);
    await hb(tokA).expect(409);
    await patch(o.id, tokA, { customerRef: 'x' }).expect(409);
    // A เปิดแก้ใหม่ระหว่างผู้จัดการถืออยู่ → 409 order_locked_by_user (ชื่อผู้ถือ)
    await lock(o.id, tokM).expect(200);
    expect((await lock(o.id, tokA).expect(409)).body).toMatchObject({
      code: 'order_locked_by_user',
      editLock: { userName: 'ผู้จัดการ ทดสอบ' },
    });
    // ผู้จัดการปิด → A เปิดแก้ (โหลดใหม่) ได้ล็อก และบันทึกได้
    await unlock(o.id, tokM).expect(204);
    await lock(o.id, tokA).expect(200);
    await hb(tokA).expect(200);
    await patch(o.id, tokA, { customerRef: 'PO-A-หลังเปิดใหม่' }).expect(200);
  });

  it('QA: การแจ้งถูกปลดหมดอายุ 10 นาทีหลังปลด → ผู้ถือเดิมกลับมาเป็นปกติ (PATCH ได้)', async () => {
    clock.set(T0);
    const o = await newOrder();
    await lock(o.id, tokA).expect(200);
    await unlock(o.id, tokM, 'ผู้แก้ไม่อยู่ ต้องแก้วันรับของด่วน').expect(204);
    clock.set(new Date(T0.getTime() + 9 * MIN));
    await patch(o.id, tokA, { customerRef: 'PO-ยังถูกปลด' }).expect(409);
    clock.set(new Date(T0.getTime() + 10 * MIN));
    await patch(o.id, tokA, { customerRef: 'PO-พ้นแล้ว' }).expect(200);
  });

  it('ปลดล็อกที่หมดอายุแล้วของคนอื่น = 204 ไม่ต้องมีสิทธิ์/เหตุผล (ไม่ลง audit)', async () => {
    clock.set(T0);
    const o = await newOrder();
    await lock(o.id, tokA).expect(200);
    clock.set(new Date(T0.getTime() + 11 * MIN));
    await unlock(o.id, tokB).expect(204);
    expect(
      await db.auditLog.count({
        where: { entityId: tryDecodeId('salesOrder', o.id)!, action: 'order.edit_lock_released' },
      }),
    ).toBe(0);
  });

  it('ทางเข้า API/connector (PUT external, POST externalId) ไม่ติดล็อกของหน้าจอ', async () => {
    const ext = `EXT-LOCK-${++seed}`;
    const put = (customerRef: string) =>
      api(app, tokApi)
        .put(`/v1/orders/external/${ext}`)
        .send({
          requestedDate: today,
          customer: { name: 'ลูกค้าภายนอก' },
          customerRef,
          stops: [{ type: 'PICKUP', siteText: 'คลังลูกค้า' }],
        });
    const created = (await put('PO-1').expect(201)).body;
    await lock(created.id, tokA).expect(200);
    const r = await put('PO-2').expect(200);
    expect(r.body.customerRef).toBe('PO-2');
    expect(r.body.editLock).toMatchObject({ userName: 'สมชาย ใจดี', mine: false });
  });

  it('token ที่ไม่ใช่ผู้ใช้ขอล็อกไม่ได้ (403 edit_lock_user_required); ไม่มีสิทธิ์เขียน → 403', async () => {
    const o = await newOrder();
    const r = await lock(o.id, tokApi).expect(403);
    expect(r.body.code).toBe('edit_lock_user_required');
    const viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), userB);
    await lock(o.id, viewer).expect(403);
    await unlock(o.id, viewer).expect(403);
  });

  it('ใบของบริษัทอื่น → 404 (lock / unlock) และไม่สร้างแถว', async () => {
    const o = await newOrder();
    await lock(o.id, tokOther).expect(404);
    await unlock(o.id, tokOther, 'ปลดล็อกข้ามบริษัทเพื่อทดสอบ').expect(404);
    expect(
      await db.orderEditLock.count({ where: { salesOrderId: tryDecodeId('salesOrder', o.id)! } }),
    ).toBe(0);
  });

  it('RLS: แถวล็อกของบริษัทอื่นมองไม่เห็นจาก tenant อื่น', async () => {
    const o = await newOrder();
    await lock(o.id, tokA).expect(200);
    const { DbService } = await import('../src/db/db.service');
    const seen = await app.get(DbService).withTenant(otherTenant, (tx) => tx.orderEditLock.count());
    expect(seen).toBe(0);
  });
});
