import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import { DEFAULT_REASONS } from '../src/modules/reason-codes/defaults';
import { REASON_CATEGORIES } from '../src/modules/reason-codes/reason-code.dto';
import { ReasonCodesService } from '../src/modules/reason-codes/reason-codes.service';
import { snapshotReason } from '../src/modules/reason-codes/snapshot';
import { bootstrapTenant, createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

type Reason = {
  id: string;
  category: string;
  code: string;
  label: string;
  version: number;
  system: boolean;
  [k: string]: unknown;
};

/** ST2-T12 เหตุผลมาตรฐาน (reason_code) — docs/04 B Reason master, docs/01 §3.2, spec/02 §9 */
describe('เหตุผลมาตรฐาน (reason-codes)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let seed = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const http = (token = admin) => api(app, token);
  const create = (body: object, token = admin) => http(token).post('/v1/reason-codes').send(body);
  const newReason = async (extra: object = {}): Promise<Reason> =>
    (
      await create({
        category: 'DELIVERY_FAILED',
        label: `เหตุผลทดสอบ ${++seed}`,
        ...extra,
      }).expect(201)
    ).body;
  const patch = (r: Reason, body: object, token = admin) =>
    http(token).patch(`/v1/reason-codes/${r.id}`).set('If-Match', `"${r.version}"`).send(body);
  const inTenant = <T>(t: string, fn: (svc: ReasonCodesService) => Promise<T>) => {
    const dbs = app.get(DbService);
    const svc = app.get(ReasonCodesService);
    return dbs.withTenant(t, (tx) =>
      requestContext.run({ requestId: randomUUID(), tenantId: t, locale: 'th', tx }, () => fn(svc)),
    );
  };
  const errField = (body: { errors?: { field: string; code: string }[] }) =>
    body.errors?.map((e) => `${e.field}:${e.code}`);
  const listAll = async (tok: string, q = ''): Promise<Reason[]> =>
    (await http(tok).get(`/v1/reason-codes?limit=200${q}`).expect(200)).body.data;

  it('เกณฑ์ตรวจรับ: tenant ใหม่มีชุดเหตุผลไทยครบทุกหมวด; ลบรหัสระบบ → 409', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท เหตุผล' });
    const tok = await tokenFor(t.id);
    const rows = await listAll(tok);
    expect(rows).toHaveLength(DEFAULT_REASONS.length);
    // ทุกหมวด (6 หมวดของ docs/04 B + ยกเลิก + ยกเว้นกฎ) มีอย่างน้อย 2 รายการ และมี "อื่น ๆ" ที่บังคับโน้ต (MD-221)
    for (const c of REASON_CATEGORIES) {
      const inCat = rows.filter((r) => r.category === c);
      expect(inCat.length, c).toBeGreaterThanOrEqual(2);
      expect(
        inCat.every((r) => /[ก-๙]/.test(r.label)),
        c,
      ).toBe(true);
      expect(
        inCat.find((r) => r.code === 'OTHER'),
        c,
      ).toMatchObject({
        system: true,
        requiresNote: true,
        label: 'อื่น ๆ',
      });
    }
    // รหัสใบค้าง 12 รหัสของ docs/04 C เป็นรหัสระบบ (plan/11 ข้อ 4)
    const hold = rows.filter((r) => r.category === 'ORDER_HOLD' && r.code !== 'OTHER');
    expect(hold.map((r) => r.code).sort()).toEqual(
      [
        'CUSTOMER_UNMAPPED',
        'LOCATION_UNMAPPED',
        'GEOCODING_ERROR',
        'RATE_MISSING',
        'UNALLOCATED_NO_VEHICLE',
        'CAPACITY_EXCEEDED',
        'VEHICLE_TYPE_INCOMPATIBLE',
        'CARRIER_REJECTED',
        'DELIVERY_WINDOW_EXHAUSTED',
        'RESCHEDULES_EXHAUSTED',
        'SOURCE_CHANGED_AFTER_PLAN',
        'SOURCE_ERROR',
      ].sort(),
    );
    expect(hold.every((r) => r.system)).toBe(true);
    // ธงตามต้นแบบ: "ไม่พบผู้รับ" บังคับรูป+โน้ต+นัดส่งใหม่
    expect(rows.find((r) => r.code === 'NO_RECEIVER')).toMatchObject({
      category: 'DELIVERY_FAILED',
      label: 'ไม่พบผู้รับ',
      requiresPhoto: true,
      requiresNote: true,
      autoReschedule: true,
    });
    // audit + event ผู้ทำ = ระบบ
    expect(
      await db.auditLog.count({
        where: { tenantId: t.id, action: 'reason_code.created', actorId: null },
      }),
    ).toBe(DEFAULT_REASONS.length);
    expect(
      await db.domainEvent.count({ where: { tenantId: t.id, type: 'reason_code.created' } }),
    ).toBe(DEFAULT_REASONS.length);

    // ลบรหัสระบบ → 409 (ทั้งรหัสใบค้างและ "อื่น ๆ"); ปิดใช้ → 409
    const cu = rows.find((r) => r.code === 'CUSTOMER_UNMAPPED')!;
    const del = await http(tok)
      .post(`/v1/reason-codes/${cu.id}/delete`)
      .send({ reason: 'ทดสอบลบรหัสของระบบ' })
      .expect(409);
    expect(errField(del.body)).toEqual(['id:system_reason']);
    const oth = rows.find((r) => r.code === 'OTHER' && r.category === 'DELAY')!;
    await http(tok)
      .post(`/v1/reason-codes/${oth.id}/delete`)
      .send({ reason: 'ทดสอบลบรหัสของระบบ' })
      .expect(409);
    await http(tok)
      .post(`/v1/reason-codes/${cu.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้รหัสระบบ' })
      .expect(409);
    // แก้ข้อความ/ธงได้ · เปลี่ยนรหัสไม่ได้ · "อื่น ๆ" ปิดบังคับโน้ตไม่ได้
    await patch(cu, { label: 'ลูกค้ายังไม่ผูกรหัส', requiresNote: true }, tok).expect(200);
    const code = await patch({ ...cu, version: 2 }, { code: 'CUS_X' }, tok).expect(422);
    expect(errField(code.body)).toEqual(['code:system_code']);
    const on = await patch(oth, { requiresNote: false }, tok).expect(422);
    expect(errField(on.body)).toEqual(['requiresNote:other_requires_note']);
    // แถวเริ่มต้นที่ไม่ใช่รหัสระบบ ลบได้ (ยังไม่ถูกอ้างอิง)
    const wa = rows.find((r) => r.code === 'WRONG_ADDRESS')!;
    expect(wa.system).toBe(false);
    await http(tok)
      .post(`/v1/reason-codes/${wa.id}/delete`)
      .send({ reason: 'บริษัทไม่ใช้เหตุผลนี้' })
      .expect(204);
  });

  it('bootstrap รันซ้ำได้: ไม่สร้างซ้ำ ไม่ทับที่แก้ ไม่คืนชีพที่ลบ; รหัสระบบที่มีอยู่แล้ว → รับเป็นของระบบ; ชน → ข้าม', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท รันซ้ำ' });
    const rows = await db.reasonCode.findMany({ where: { tenantId: t.id } });
    const closed = rows.find((r) => r.code === 'SHOP_CLOSED')!;
    const dup = rows.find((r) => r.code === 'DUPLICATE')!;
    await db.reasonCode.update({ where: { id: closed.id }, data: { labelTh: 'ร้านปิด' } });
    await db.reasonCode.update({ where: { id: dup.id }, data: { deletedAt: new Date() } });
    await bootstrapTenant(db, t.id);
    await bootstrapTenant(db, t.id);
    const after = await db.reasonCode.findMany({ where: { tenantId: t.id } });
    expect(after).toHaveLength(DEFAULT_REASONS.length);
    expect(after.find((r) => r.id === closed.id)!.labelTh).toBe('ร้านปิด');
    expect(after.find((r) => r.id === dup.id)!.deletedAt).not.toBeNull();

    // tenant เก่า: มี OTHER (ไม่บังคับโน้ต) + ข้อความชน "ไม่พบผู้รับ" ด้วยรหัสอื่น
    const old = (await createTenant(db)).id;
    const own = await db.reasonCode.create({
      data: { tenantId: old, category: 'DELIVERY_FAILED', code: 'OTHER', labelTh: 'อื่นๆ ของเรา' },
    });
    await db.reasonCode.create({
      data: { tenantId: old, category: 'DELIVERY_FAILED', code: 'NR', labelTh: 'ไม่พบผู้รับ' },
    });
    await bootstrapTenant(db, old);
    const mine = await db.reasonCode.findMany({ where: { tenantId: old } });
    expect(mine).toHaveLength(DEFAULT_REASONS.length); // OTHER ใช้แถวเดิม, NO_RECEIVER ถูกข้าม (+ NR ของเรา)
    expect(mine.find((r) => r.id === own.id)).toMatchObject({
      isSystem: true,
      systemKey: 'DELIVERY_FAILED:OTHER',
      requiresNote: true,
      labelTh: 'อื่นๆ ของเรา',
    });
    expect(
      await db.tenantDefault.findUnique({
        where: { tenantId_key: { tenantId: old, key: 'reason_code:DELIVERY_FAILED:NO_RECEIVER' } },
      }),
    ).toMatchObject({ outcome: 'SKIPPED', detail: 'code_or_label_taken' });
    expect(
      await db.auditLog.count({
        where: { tenantId: old, action: 'reason_code.adopted', entityId: own.id },
      }),
    ).toBe(1);
  });

  it('สร้าง: รหัส RSN-0001, รหัสซ้ำในหมวด/ข้อความซ้ำ 409 (ต่างหมวดได้), OTHER สงวน, หมวดที่ยังไม่เปิด 422', async () => {
    const a = await newReason({ label: 'ฝนตกหนัก' });
    expect(a.code).toMatch(/^RSN-\d{4}$/);
    expect(a).toMatchObject({ category: 'DELIVERY_FAILED', system: false, status: 'active' });
    const d1 = await create({ category: 'DELIVERY_FAILED', label: 'ฝนตกหนัก' }).expect(409);
    expect(errField(d1.body)).toEqual(['label:duplicate']);
    await create({ category: 'DELAY', label: 'ฝนตกหนัก', code: a.code }).expect(201); // ต่างหมวด
    const d2 = await create({ category: 'DELIVERY_FAILED', label: 'อื่น', code: a.code }).expect(
      409,
    );
    expect(errField(d2.body)).toEqual(['code:duplicate']);
    const c = await create({ category: 'DELAY', label: 'โค้ดตัวเล็ก', code: ' late_x ' }).expect(
      201,
    );
    expect(c.body.code).toBe('LATE_X');
    const o = await create({ category: 'DELAY', label: 'อื่น ๆ 2', code: 'OTHER' }).expect(422);
    expect(errField(o.body)).toEqual(['code:reserved_code']);
    const cn = await create({ category: 'CREDIT_NOTE', label: 'ลดหนี้' }).expect(422);
    expect(errField(cn.body)).toEqual(['category:isIn']);
    await create({ category: 'DELAY', label: '' }).expect(422);
    await create({ category: 'DELAY', label: 'x', requiresNote: null }).expect(422);
    // Idempotency-Key: ส่งซ้ำได้แถวเดียว
    const key = randomUUID();
    const i1 = await http()
      .post('/v1/reason-codes')
      .set('Idempotency-Key', key)
      .send({ category: 'CANCEL', label: 'ส่งซ้ำ' })
      .expect(201);
    const i2 = await http()
      .post('/v1/reason-codes')
      .set('Idempotency-Key', key)
      .send({ category: 'CANCEL', label: 'ส่งซ้ำ' })
      .expect(201);
    expect(i2.body.id).toBe(i1.body.id);
  });

  it('ธงตามหมวด: นัดส่งใหม่เฉพาะส่งไม่สำเร็จ, แสดงบน tracking เฉพาะเหตุผลหน้างาน; หมวดเปลี่ยนไม่ได้', async () => {
    const r = await create({
      category: 'DELAY',
      label: 'ด่านตรวจ',
      autoReschedule: true,
    }).expect(422);
    expect(errField(r.body)).toEqual(['autoReschedule:not_applicable']);
    const t1 = await create({
      category: 'ORDER_HOLD',
      label: 'รอเอกสาร',
      showOnTracking: true,
    }).expect(422);
    expect(errField(t1.body)).toEqual(['showOnTracking:not_applicable']);
    const ok = await newReason({
      label: 'ลูกค้าขอเลื่อน',
      autoReschedule: true,
      showOnTracking: true,
      requiresPhoto: true,
    });
    expect(ok).toMatchObject({ autoReschedule: true, showOnTracking: true, requiresPhoto: true });
    const dly = await create({ category: 'DELAY', label: 'ทางปิด', showOnTracking: true }).expect(
      201,
    );
    const p = await patch(dly.body, { autoReschedule: true }).expect(422);
    expect(errField(p.body)).toEqual(['autoReschedule:not_applicable']);
    await patch(dly.body, { category: 'DELIVERY_FAILED' }).expect(422); // ไม่มีช่อง category ใน PATCH
    const g = await patch(dly.body, { requiresNote: true, autoReschedule: false }).expect(200);
    expect(g.body.version).toBe(2);
    // ค่าไม่ใช่ boolean → 422
    await patch(g.body, { requiresPhoto: 'yes' }).expect(422);
  });

  it('snapshot: แก้ข้อความ/ธงใน master แล้ว snapshot ที่คัดลอกลงงานไม่เปลี่ยน; หมวดไม่ตรง/ปิดใช้/tenant อื่น → 422', async () => {
    const r = await newReason({ label: 'ประตูโรงงานปิด', requiresPhoto: true });
    const uuid = tryDecodeId('reasonCode', r.id)!;
    const snap = await inTenant(tenantId, (svc) => svc.snapshotFor(uuid, 'DELIVERY_FAILED'));
    expect(snap).toEqual({
      sourceId: uuid,
      sourceVersion: 1,
      category: 'DELIVERY_FAILED',
      code: r.code,
      label: 'ประตูโรงงานปิด',
      labelEn: null,
      flags: {
        requiresPhoto: true,
        requiresNote: false,
        autoReschedule: false,
        showOnTracking: false,
      },
    });
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.flags)).toBe(true);
    // คัดลอกลงงาน (doc_status_history: reason_code_id + ข้อความ) เหมือนที่ ST3/ST4 จะทำ
    const hist = await db.docStatusHistory.create({
      data: {
        tenantId,
        docType: 'trip_stop',
        docId: randomUUID(),
        fromStatus: 'ARRIVED',
        toStatus: 'FAILED',
        event: 'fail',
        reasonCodeId: snap.sourceId,
        note: `${snap.code} ${snap.label}`,
      },
    });
    const e = await patch(r, { label: 'ประตูโรงงานปิดล็อก', requiresPhoto: false }).expect(200);
    expect(e.body.version).toBe(2);
    expect(snap.label).toBe('ประตูโรงงานปิด');
    expect(snap.flags.requiresPhoto).toBe(true);
    expect((await db.docStatusHistory.findUniqueOrThrow({ where: { id: hist.id } })).note).toBe(
      `${r.code} ประตูโรงงานปิด`,
    );
    const snap2 = await inTenant(tenantId, (svc) =>
      svc.snapshotFor(uuid, ['DELIVERY_FAILED', 'DELAY']),
    );
    expect(snap2).toMatchObject({ sourceVersion: 2, label: 'ประตูโรงงานปิดล็อก' });
    const row = await db.reasonCode.findUniqueOrThrow({ where: { id: uuid } });
    expect(snapshotReason(row)).toEqual(snap2);

    const wrong = await inTenant(tenantId, (svc) => svc.snapshotFor(uuid, 'DELAY')).catch((x) => x);
    expect(wrong.errors[0].code).toBe('reason_category');
    const other = (await createTenant(db)).id;
    const nf = await inTenant(other, (svc) => svc.snapshotFor(uuid, 'DELIVERY_FAILED')).catch(
      (x) => x,
    );
    expect(nf.errors[0].code).toBe('reason_not_found');
    await http()
      .post(`/v1/reason-codes/${r.id}/deactivate`)
      .set('If-Match', '"2"')
      .send({ reason: 'ไม่ใช้เหตุผลนี้แล้ว' })
      .expect(200);
    const ina = await inTenant(tenantId, (svc) => svc.snapshotFor(uuid, 'DELIVERY_FAILED')).catch(
      (x) => x,
    );
    expect(ina.errors[0].code).toBe('reason_inactive');

    // ถูกอ้างอิงแล้ว → ลบไม่ได้ (409 in_use) แต่ปิดใช้ได้ (ทำไปแล้วด้านบน)
    const del = await http()
      .post(`/v1/reason-codes/${r.id}/delete`)
      .send({ reason: 'ทดสอบลบที่ถูกอ้างอิง' })
      .expect(409);
    expect(del.body.code).toBe('in_use');
    expect(del.body.references).toEqual({ statusHistory: 1 });
  });

  it('PATCH 412/no-op, ลบแล้วใช้ข้อความซ้ำได้, PUT external idempotent, history, กรองหมวด, export, สิทธิ์', async () => {
    const r1 = await newReason({ label: 'รายการ A' });
    await patch({ ...r1, version: 99 }, { label: 'x' }).expect(412);
    const same = await patch(r1, { label: 'รายการ A', requiresNote: false }).expect(200);
    expect(same.body.version).toBe(1);

    await http()
      .post(`/v1/reason-codes/${r1.id}/delete`)
      .send({ reason: 'สร้างผิด ไม่ได้ใช้งาน' })
      .expect(204);
    await http().get(`/v1/reason-codes/${r1.id}`).expect(404);
    await newReason({ label: 'รายการ A' });
    const tomb = await http()
      .get(`/v1/reason-codes?includeDeleted=true&label=${encodeURIComponent('รายการ A')}`)
      .expect(200);
    expect(tomb.body.data.some((x: Reason) => x.deletedAt)).toBe(true);

    const put = (body: object) => http().put('/v1/reason-codes/external/ERP-RSN-1').send(body);
    const c1 = await put({ category: 'CANCEL', label: 'ยกเลิกจาก ERP' }).expect(201);
    const c2 = await put({ category: 'CANCEL', label: 'ยกเลิกจาก ERP', requiresNote: true }).expect(
      200,
    );
    expect(c2.body.id).toBe(c1.body.id);
    expect(c2.body.requiresNote).toBe(true);
    const c3 = await put({ category: 'DELAY', label: 'ยกเลิกจาก ERP' }).expect(422);
    expect(errField(c3.body)).toEqual(['category:immutable']);
    await http().get('/v1/reason-codes/ext:ERP-RSN-1').expect(200);
    const h = await http().get(`/v1/reason-codes/${c1.body.id}/history`).expect(200);
    expect(h.body.data.map((x: { action: string }) => x.action)).toEqual([
      'reason_code.updated',
      'reason_code.created',
    ]);

    const f = await http().get('/v1/reason-codes?category=CANCEL,DELAY').expect(200);
    expect(f.body.data.length).toBeGreaterThan(0);
    expect(f.body.data.every((x: Reason) => ['CANCEL', 'DELAY'].includes(x.category))).toBe(true);
    await http().get('/v1/reason-codes?category=CREDIT_NOTE').expect(422);

    const csv = await http().get('/v1/reason-codes/export?format=csv').expect(200);
    expect(csv.text.split('\n')[0]).toContain('หมวด');
    expect(csv.text).toContain('ยกเลิกจาก ERP');
    const viewer = await tokenFor(tenantId, 'master:read');
    await http(viewer).get('/v1/reason-codes').expect(200);
    await http(viewer).get('/v1/reason-codes/export?format=csv').expect(403);
    await create({ category: 'DELAY', label: 'ไม่มีสิทธิ์' }, viewer).expect(403);
  });
});
