import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PodSubmission } from '@tms/domain';
import { tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import { PodChecklistService } from '../src/modules/pod/pod-checklist.service';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST4-T05 POD checklist (แกน): ค่าเริ่มต้นของ tenant + override ต่อลูกค้า + ตัวตรวจ POD
 * เกณฑ์ตรวจรับ: ลูกค้า A บังคับรูป + ลายเซ็น → ปิดงานโดยไม่มีรูปถูกปฏิเสธ; ลูกค้า B ใช้ค่า default
 */
describe('POD checklist', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherTenant: string;
  let admin: string;
  let reader: string;
  let other: string;
  let seed = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db, 'บริษัท POD')).id;
    otherTenant = (await createTenant(db, 'บริษัท อื่น')).id;
    admin = await tokenFor(tenantId, 'master:read master:write settings:read settings:write');
    reader = await tokenFor(tenantId, 'master:read');
    other = await tokenFor(otherTenant, 'master:read master:write');
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const newCustomer = async (body: Record<string, unknown> = {}) =>
    (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(7700 + seed), ...body })
        .expect(201)
    ).body as { id: string; version: number; podRequirements: unknown };

  const run = <T>(fn: () => Promise<T>, tid = tenantId) =>
    app
      .get(DbService)
      .withTenant(tid, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId: tid, actorId: 'user-test', locale: 'th', tx },
          fn,
        ),
      );
  const svc = () => app.get(PodChecklistService);
  const uuid = (id: string) => tryDecodeId('customer', id)!;
  const errOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as {
        code: string;
        errors: { field: string; code: string }[];
        extra: { missing: unknown[] };
      };
    }
    throw new Error('expected failure');
  };

  const photoSig = {
    success: {
      fields: [
        { type: 'PHOTO', level: 'REQUIRED', minCount: 1 },
        { type: 'SIGNATURE', level: 'REQUIRED' },
      ],
    },
  };

  it('ค่าเริ่มต้นของระบบ: รูป ≥ 1 บังคับ, ลายเซ็นบังคับ, หมายเหตุไม่บังคับ (spec/04 §13)', async () => {
    const s = (await api(app, admin).get('/v1/settings').expect(200)).body.data.find(
      (x: { key: string }) => x.key === 'pod.checklist',
    );
    expect(s).toMatchObject({ isDefault: true });
    expect(
      s.value.success.fields.map((f: { type: string; level: string }) => `${f.type}:${f.level}`),
    ).toEqual([
      'PHOTO:REQUIRED',
      'SIGNATURE:REQUIRED',
      'NOTE:ENABLED',
      'BARCODE:DISABLED',
      'PIN:DISABLED',
      'RATING:DISABLED',
    ]);
    // ST4-T06 ชุดไม่สำเร็จ: รูป ≥ 1 + หมายเหตุ บังคับ, ลายเซ็นไม่ใช้
    expect(
      s.value.failure.fields
        .slice(0, 3)
        .map((f: { type: string; level: string }) => `${f.type}:${f.level}`),
    ).toEqual(['PHOTO:REQUIRED', 'SIGNATURE:DISABLED', 'NOTE:REQUIRED']);
  });

  it('แก้ค่าเริ่มต้นขององค์กร: ทำให้เป็นรูปมาตรฐาน + ลง audit; ค่าผิดรูป → 422 พร้อม path', async () => {
    const bad = await api(app, admin)
      .patch('/v1/settings')
      .send({
        values: { 'pod.checklist': { success: { fields: [{ type: 'PHOTO', level: 'MUST' }] } } },
      });
    expect(bad.status).toBe(422);
    // field บอก path เต็มแบบเดียวกับ API ลูกค้า (QA L1)
    expect(bad.body.errors[0].field).toBe('values.pod.checklist.success.fields.0.level');
    const mc = await api(app, admin)
      .patch('/v1/settings')
      .send({
        values: {
          'pod.checklist': {
            success: { fields: [{ type: 'PHOTO', level: 'REQUIRED', minCount: 9 }] },
          },
        },
      });
    expect(mc.body.errors[0].field).toBe('values.pod.checklist.success.fields.0.minCount');

    const res = await api(app, admin)
      .patch('/v1/settings')
      .send({
        values: {
          'pod.checklist': {
            success: {
              fields: [
                { type: 'NOTE', level: 'REQUIRED' },
                { type: 'PHOTO', level: 'ENABLED', minCount: 1 },
                { type: 'BOOLEAN', key: 'goods_ok', level: 'ENABLED', label: ' สินค้าครบ ' },
              ],
            },
          },
        },
      })
      .expect(200);
    const v = res.body.data.find((x: { key: string }) => x.key === 'pod.checklist').value;
    expect(v.success.fields).toEqual([
      { key: 'photo', type: 'PHOTO', level: 'ENABLED', minCount: 1 },
      { key: 'signature', type: 'SIGNATURE', level: 'DISABLED' },
      { key: 'note', type: 'NOTE', level: 'REQUIRED' },
      { key: 'barcode', type: 'BARCODE', level: 'DISABLED' },
      { key: 'pin', type: 'PIN', level: 'DISABLED', length: 4 },
      { key: 'rating', type: 'RATING', level: 'DISABLED', max: 5 },
      { key: 'goods_ok', type: 'BOOLEAN', level: 'ENABLED', label: 'สินค้าครบ' },
    ]);
    const audit = await db.auditLog.findFirst({
      where: { tenantId, action: 'tenant_setting.updated', entityId: 'pod.checklist' },
    });
    expect(audit).not.toBeNull();

    // บันทึกค่าเดิม (ลำดับ key ต่างจากที่ jsonb คืน) → ไม่เพิ่ม version ไม่ลง audit (QA M)
    const before = res.body.data.find((x: { key: string }) => x.key === 'pod.checklist');
    const rev = (set: { fields: Record<string, unknown>[] }) => ({
      fields: set.fields.map((f) => Object.fromEntries(Object.entries(f).reverse())),
    });
    const shuffled = { failure: rev(v.failure), success: rev(v.success) };
    const again = await api(app, admin)
      .patch('/v1/settings')
      .send({
        values: { 'pod.checklist': shuffled },
        versions: { 'pod.checklist': before.version },
      })
      .expect(200);
    expect(again.body.data.find((x: { key: string }) => x.key === 'pod.checklist').version).toBe(
      before.version,
    );
    expect(
      await db.auditLog.count({
        where: { tenantId, action: 'tenant_setting.updated', entityId: 'pod.checklist' },
      }),
    ).toBe(1);
  });

  it('ชุดที่ไม่ส่ง: ค่าองค์กร {} = เติมค่าระบบ (เพิ่มชุดใหม่ใน T06 แล้วไม่ 422); override ลูกค้าผิดรูปในฐาน → ใช้ค่าองค์กร', async () => {
    const s = await (
      await api(app, admin).get('/v1/settings')
    ).body.data.find((x: { key: string }) => x.key === 'pod.checklist');
    const r = await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'pod.checklist': {} }, versions: { 'pod.checklist': s.version } })
      .expect(200);
    expect(
      r.body.data.find((x: { key: string }) => x.key === 'pod.checklist').value.success.fields[0],
    ).toMatchObject({ type: 'PHOTO', level: 'REQUIRED', minCount: 1 });
    // คืนค่าที่ test ถัดไปใช้ (หมายเหตุบังคับ รูป/ลายเซ็นไม่บังคับ)
    await api(app, admin)
      .patch('/v1/settings')
      .send({
        values: {
          'pod.checklist': {
            success: {
              fields: [
                { type: 'PHOTO', level: 'ENABLED' },
                { type: 'NOTE', level: 'REQUIRED' },
                { type: 'BOOLEAN', key: 'goods_ok', level: 'ENABLED', label: 'สินค้าครบ' },
              ],
            },
          },
        },
      })
      .expect(200);
    const c = await newCustomer();
    await db.customer.update({
      where: { id: uuid(c.id) },
      data: { podRequirements: { success: { fields: [{ type: 'PHOTO', level: 'BAD' }] } } },
    });
    const got = await run(() => svc().forCustomer(uuid(c.id)));
    expect(got.source).toBe('TENANT');
  });

  it('ลูกค้า A บังคับรูป + ลายเซ็น: ปิดงานโดยไม่มีรูปถูกปฏิเสธ; ลูกค้า B ใช้ค่า default', async () => {
    const a = await newCustomer({ podRequirements: photoSig });
    const b = await newCustomer();
    expect(b.podRequirements).toEqual({});
    expect((a.podRequirements as typeof photoSig).success.fields).toHaveLength(6);

    const noPhoto: PodSubmission = { photoCount: 0, hasSignature: true, note: 'วางไว้หน้าร้าน' };
    const e = await errOf(run(() => svc().assertComplete(uuid(a.id), 'SUCCESS', noPhoto)));
    expect(e.code).toBe('pod_incomplete');
    expect(e.errors).toEqual([
      { field: 'pod.photo', code: 'required', message: expect.any(String) },
    ]);
    expect(e.extra.missing).toEqual([
      { key: 'photo', type: 'PHOTO', code: 'required', expected: 1, actual: 0 },
    ]);
    // มีรูป + ลายเซ็น → ผ่าน (หมายเหตุของ A ปิดอยู่ แม้องค์กรบังคับ)
    const ok = await run(() =>
      svc().assertComplete(uuid(a.id), 'SUCCESS', { photoCount: 1, hasSignature: true }),
    );
    expect(ok.source).toBe('CUSTOMER');

    // B ใช้ค่าองค์กร (ตั้งไว้ข้อก่อน: หมายเหตุบังคับ รูป/ลายเซ็นไม่บังคับ)
    const eb = await errOf(
      run(() =>
        svc().assertComplete(uuid(b.id), 'SUCCESS', { photoCount: 0, hasSignature: false }),
      ),
    );
    expect(eb.errors.map((x) => x.field)).toEqual(['pod.note']);
    const okb = await run(() =>
      svc().check(uuid(b.id), 'SUCCESS', { photoCount: 0, hasSignature: false, note: 'ส่งแล้ว' }),
    );
    expect(okb).toMatchObject({ ok: true, missing: [], checklist: { source: 'TENANT' } });
  });

  it('GET /customers/{id}/pod-checklist คืนชุดที่ใช้จริง + ที่มา; อ่านได้ด้วย master:read', async () => {
    const a = await newCustomer({ podRequirements: photoSig });
    const b = await newCustomer();
    const ra = await api(app, reader).get(`/v1/customers/${a.id}/pod-checklist`).expect(200);
    expect(ra.body.data).toEqual([
      {
        outcome: 'SUCCESS',
        source: 'CUSTOMER',
        fields: [
          { key: 'photo', type: 'PHOTO', level: 'REQUIRED', minCount: 1 },
          { key: 'signature', type: 'SIGNATURE', level: 'REQUIRED' },
          { key: 'note', type: 'NOTE', level: 'DISABLED' },
          { key: 'barcode', type: 'BARCODE', level: 'DISABLED' },
          { key: 'pin', type: 'PIN', level: 'DISABLED', length: 4 },
          { key: 'rating', type: 'RATING', level: 'DISABLED', max: 5 },
        ],
        tenantFields: expect.arrayContaining([{ key: 'note', type: 'NOTE', level: 'REQUIRED' }]),
      },
      // ชุดไม่สำเร็จ: ลูกค้าไม่ได้ตั้ง + องค์กรไม่ได้ตั้ง → ค่าระบบ
      expect.objectContaining({ outcome: 'FAILURE', source: 'TENANT' }),
    ]);
    const rb = await api(app, reader).get(`/v1/customers/${b.id}/pod-checklist`).expect(200);
    expect(rb.body.data[0]).toMatchObject({ source: 'TENANT' });
    expect(rb.body.data[0].fields[2]).toMatchObject({ type: 'NOTE', level: 'REQUIRED' });
  });

  it('PATCH override: ค่าผิดรูป 422 พร้อม field; {} = กลับไปใช้ค่าองค์กร; ลง audit; If-Match เก่า 412', async () => {
    const c = await newCustomer();
    const bad = await api(app, admin)
      .patch(`/v1/customers/${c.id}`)
      .send({
        podRequirements: {
          success: { fields: [{ type: 'BOOLEAN', key: 'k', level: 'REQUIRED' }] },
        },
      });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({
      field: 'podRequirements.success.fields.0.label',
      code: 'invalid',
    });
    const unk = await api(app, admin)
      .patch(`/v1/customers/${c.id}`)
      .send({ podRequirements: { partial: { fields: [] } } });
    expect(unk.body.errors[0]).toMatchObject({
      field: 'podRequirements.partial',
      code: 'unknown_property',
    });
    expect(
      (await api(app, admin).patch(`/v1/customers/${c.id}`).send({ podRequirements: null })).status,
    ).toBe(422);

    const set = await api(app, admin)
      .patch(`/v1/customers/${c.id}`)
      .set('If-Match', `"${c.version}"`)
      .send({ podRequirements: photoSig })
      .expect(200);
    expect(set.body.version).toBe(c.version + 1);
    const stale = await api(app, admin)
      .patch(`/v1/customers/${c.id}`)
      .set('If-Match', `"${c.version}"`)
      .send({ podRequirements: {} });
    expect(stale.status).toBe(412);
    const back = await api(app, admin)
      .patch(`/v1/customers/${c.id}`)
      .send({ podRequirements: {} })
      .expect(200);
    expect(back.body.podRequirements).toEqual({});
    const setFull = set.body.podRequirements as { success: { fields: unknown[] } };
    expect(setFull.success.fields).toHaveLength(6);
    const hist = await api(app, admin).get(`/v1/customers/${c.id}/history`).expect(200);
    expect(
      hist.body.data.filter(
        (h: { action: string; after: Record<string, unknown> | null }) =>
          h.action === 'customer.updated' && h.after && 'podRequirements' in h.after,
      ),
    ).toHaveLength(2);
  });

  it('ข้าม tenant → 404 (ทั้ง endpoint และตัวตรวจ)', async () => {
    const a = await newCustomer({ podRequirements: photoSig });
    await api(app, other).get(`/v1/customers/${a.id}/pod-checklist`).expect(404);
    const e = await errOf(run(() => svc().forCustomer(uuid(a.id)), otherTenant));
    expect(e.code).toBe('not_found');
  });

  it('dispatcher ที่ไม่มี settings:write แก้ค่าองค์กรไม่ได้ (403)', async () => {
    await api(app, reader)
      .patch('/v1/settings')
      .send({ values: { 'pod.checklist': photoSig } })
      .expect(403);
  });

  describe('ST4-T06 ชนิดเพิ่ม + ชุดไม่สำเร็จ', () => {
    it('422 ราย path: ตัวเลือก SINGLE_CHOICE / PIN length / RATING max / ตัวเลือกบนชนิดอื่น', async () => {
      const c = await newCustomer();
      const bad = await api(app, admin)
        .patch(`/v1/customers/${c.id}`)
        .send({
          podRequirements: {
            failure: {
              fields: [
                {
                  type: 'SINGLE_CHOICE',
                  key: 'why',
                  level: 'REQUIRED',
                  label: 'สาเหตุ',
                  options: ['ก'],
                },
                { type: 'PIN', level: 'REQUIRED', length: 12 },
                { type: 'RATING', level: 'ENABLED', max: 2 },
                { type: 'BARCODE', level: 'REQUIRED', length: 4 },
              ],
            },
          },
        });
      expect(bad.status).toBe(422);
      expect(
        bad.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`),
      ).toEqual(
        expect.arrayContaining([
          'podRequirements.failure.fields.0.options:invalid',
          'podRequirements.failure.fields.1.length:invalid',
          'podRequirements.failure.fields.2.max:invalid',
          'podRequirements.failure.fields.3.length:not_allowed',
        ]),
      );
      const s = await api(app, admin)
        .patch('/v1/settings')
        .send({
          values: {
            'pod.checklist': {
              failure: {
                fields: [
                  {
                    type: 'SINGLE_CHOICE',
                    key: 'why',
                    level: 'REQUIRED',
                    label: 'x',
                    options: ['ก', 'ก'],
                  },
                ],
              },
            },
          },
        });
      expect(s.status).toBe(422);
      expect(s.body.errors[0]).toMatchObject({
        field: 'values.pod.checklist.failure.fields.0.options.1',
        code: 'duplicate',
      });
    });

    it('ข้อมูล T05 ในฐาน (มีแค่ success 3 แถว) → GET แสดงรูปมาตรฐานใหม่ + ชุด failure ตามองค์กร', async () => {
      const c = await newCustomer();
      await db.customer.update({
        where: { id: uuid(c.id) },
        data: {
          podRequirements: {
            success: {
              fields: [
                { key: 'photo', type: 'PHOTO', level: 'REQUIRED', minCount: 2 },
                { key: 'signature', type: 'SIGNATURE', level: 'REQUIRED' },
                { key: 'note', type: 'NOTE', level: 'DISABLED' },
              ],
            },
          },
        },
      });
      const got = await api(app, admin).get(`/v1/customers/${c.id}`).expect(200);
      expect(got.body.podRequirements.success.fields).toHaveLength(6);
      expect(got.body.podRequirements.failure).toBeUndefined();
      const eff = await api(app, admin).get(`/v1/customers/${c.id}/pod-checklist`).expect(200);
      expect(
        eff.body.data.map((x: { outcome: string; source: string }) => `${x.outcome}:${x.source}`),
      ).toEqual(['SUCCESS:CUSTOMER', 'FAILURE:TENANT']);
      // ค่าองค์กรแบบ T05 (ไม่มีชุด failure) → GET /settings เติมค่าระบบ
      await db.tenantSetting.update({
        where: { tenantId_key: { tenantId, key: 'pod.checklist' } },
        data: {
          value: {
            success: { fields: [{ key: 'photo', type: 'PHOTO', level: 'ENABLED', minCount: 1 }] },
          },
        },
      });
      const st = (await api(app, admin).get('/v1/settings').expect(200)).body.data.find(
        (x: { key: string }) => x.key === 'pod.checklist',
      );
      expect(st.value.success.fields).toHaveLength(6);
      expect(st.value.failure.fields[0]).toMatchObject({ type: 'PHOTO', level: 'REQUIRED' });
    });

    it('เกณฑ์ตรวจรับ: ตั้งชุด "ไม่สำเร็จ" บังคับรูป → ปิดงานแบบ failed ต้องมีรูป (ชุดสำเร็จไม่กระทบ)', async () => {
      const c = await newCustomer({
        podRequirements: {
          success: { fields: [{ type: 'NOTE', level: 'ENABLED' }] },
          failure: {
            fields: [
              { type: 'PHOTO', level: 'REQUIRED', minCount: 1 },
              {
                type: 'SINGLE_CHOICE',
                key: 'why',
                level: 'ENABLED',
                label: 'ผู้รับแจ้งว่า',
                options: ['นัดใหม่', 'ปฏิเสธรับ'],
              },
            ],
          },
        },
      });
      const id = uuid(c.id);
      const none: PodSubmission = { photoCount: 0, hasSignature: false };
      for (const outcome of ['FAILED', 'UNDELIVERED_RETAIN', 'FAILURE'] as const) {
        const e = await errOf(run(() => svc().assertComplete(id, outcome, none)));
        expect(e.code).toBe('pod_incomplete');
        expect(e.errors.map((x) => x.field)).toEqual(['pod.photo']);
      }
      const ok = await run(() => svc().assertComplete(id, 'FAILED', { ...none, photoCount: 1 }));
      expect(ok).toMatchObject({ outcome: 'FAILURE', source: 'CUSTOMER' });
      // สำเร็จไม่ต้องมีรูป
      await run(() => svc().assertComplete(id, 'DELIVERED', none));
      // ค่าตัวเลือกที่ไม่อยู่ในรายการ (ไม่บังคับ) → invalid
      const inv = await errOf(
        run(() =>
          svc().assertComplete(id, 'FAILED', {
            ...none,
            photoCount: 1,
            choices: { why: 'อื่น ๆ' },
          }),
        ),
      );
      expect(inv.errors).toEqual([
        { field: 'pod.why', code: 'invalid', message: expect.any(String) },
      ]);
    });

    it('ชนิดใหม่บังคับ: BARCODE / PIN / RATING / SINGLE_CHOICE ขาด → missing ครบทุกข้อ', async () => {
      const c = await newCustomer({
        podRequirements: {
          success: {
            fields: [
              { type: 'BARCODE', level: 'REQUIRED' },
              { type: 'PIN', level: 'REQUIRED', length: 6 },
              { type: 'RATING', level: 'REQUIRED', max: 5 },
              {
                type: 'SINGLE_CHOICE',
                key: 'box',
                level: 'REQUIRED',
                label: 'กล่อง',
                options: ['ดี', 'บุบ'],
              },
            ],
          },
        },
      });
      const id = uuid(c.id);
      const e = await errOf(
        run(() =>
          svc().assertComplete(id, 'DELIVERED', { photoCount: 0, hasSignature: false, pin: '123' }),
        ),
      );
      expect(e.errors.map((x) => `${x.field}:${x.code}`)).toEqual([
        'pod.barcode:required',
        'pod.pin:invalid',
        'pod.rating:required',
        'pod.box:required',
      ]);
      await run(() =>
        svc().assertComplete(id, 'DELIVERED', {
          photoCount: 0,
          hasSignature: false,
          scanCodes: ['SO-001'],
          pin: '123456',
          rating: 5,
          choices: { box: 'ดี' },
        }),
      );
    });
  });
});
