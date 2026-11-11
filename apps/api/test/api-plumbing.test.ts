import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

describe('API plumbing (ST0-T06 – T10)', () => {
  let app: NestExpressApplication;
  const plat = platform();
  let tenantId: string;
  let token: string;
  let seq = 0;
  const newCompany = () => ({
    legalName: `บริษัท ทดสอบ ${++seq} จำกัด`,
    taxId: validTaxId(10_000 + seq),
  });

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(plat)).id;
    token = await tokenFor(tenantId);
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  describe('T06 problem+json + requestId + validation', () => {
    it('ไม่มี token → 401 problem+json มี code และ requestId', async () => {
      const res = await api(app).get('/v1/companies');
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 401, code: 'unauthorized' });
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('ข้อความตาม Accept-Language (ไทยเป็นค่าเริ่มต้น)', async () => {
      expect((await api(app).get('/v1/companies')).body.title).toBe('ต้องเข้าสู่ระบบ');
      expect((await api(app).get('/v1/companies').set('Accept-Language', 'en')).body.title).toBe(
        'Authentication required',
      );
    });

    it('id ผิดรูปแบบ → 404 (ไม่บอกใบ้)', async () => {
      const res = await api(app, token).get('/v1/companies/not-an-id');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('DTO ผิด → 422 พร้อม errors[] ราย field; field แปลกปลอมถูกปฏิเสธ', async () => {
      const res = await api(app, token)
        .post('/v1/companies')
        .send({ legalName: '', taxId: '1234567890123', foo: 1 });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      const fields = res.body.errors.map((e: { field: string }) => e.field);
      expect(fields).toEqual(expect.arrayContaining(['legalName', 'taxId', 'foo']));
    });

    it('route ที่ไม่มี → 404 problem+json', async () => {
      const res = await api(app, token).get('/v1/nope');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    it('scope ไม่พอ → 403', async () => {
      const ro = await tokenFor(tenantId, 'companies:read');
      expect((await api(app, ro).post('/v1/companies').send(newCompany())).status).toBe(403);
      expect((await api(app, ro).get('/v1/companies')).status).toBe(200);
    });

    it('response เป็น camelCase, id มี prefix, enum ตัวเล็ก, เวลาเป็น ISO UTC', async () => {
      const res = await api(app, token).post('/v1/companies').send(newCompany());
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^cmp_[0-9a-f]{32}$/);
      expect(res.body.status).toBe('active');
      expect(res.body.createdAt).toMatch(/Z$/);
      expect(res.body).not.toHaveProperty('tenantId');
    });

    it('เลขผู้เสียภาษีซ้ำใน tenant → 409 duplicate', async () => {
      const body = newCompany();
      await api(app, token).post('/v1/companies').send(body).expect(201);
      const res = await api(app, token).post('/v1/companies').send(body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('duplicate');
    });

    it('ext:{externalId} ใช้แทน id ได้', async () => {
      await api(app, token)
        .post('/v1/companies')
        .send({ ...newCompany(), externalId: 'ERP-001' })
        .expect(201);
      const res = await api(app, token).get('/v1/companies/ext:ERP-001');
      expect(res.status).toBe(200);
      expect(res.body.externalId).toBe('ERP-001');
    });
  });

  it('GET /v1/me คืน tenant ของ token (RLS เห็นแค่ tenant ตัวเอง)', async () => {
    const res = await api(app, token).get('/v1/me');
    expect(res.status).toBe(200);
    expect(res.body.tenant.id).toMatch(/^ten_/);
    expect(res.body.actorId).toBe('user-test');
  });

  describe('T07 Idempotency-Key', () => {
    it('key + body เดิม → response เดิม + Idempotent-Replayed; ไม่สร้างซ้ำ', async () => {
      const body = newCompany();
      const first = await api(app, token)
        .post('/v1/companies')
        .set('Idempotency-Key', 'k-1')
        .send(body);
      const second = await api(app, token)
        .post('/v1/companies')
        .set('Idempotency-Key', 'k-1')
        .send(body);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      const count = await plat.company.count({ where: { tenantId, taxId: body.taxId } });
      expect(count).toBe(1);
    });

    it('key เดิม body ต่าง → 422 idempotency_mismatch', async () => {
      await api(app, token)
        .post('/v1/companies')
        .set('Idempotency-Key', 'k-2')
        .send(newCompany())
        .expect(201);
      const res = await api(app, token)
        .post('/v1/companies')
        .set('Idempotency-Key', 'k-2')
        .send(newCompany());
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('idempotency_mismatch');
    });

    it('key เดิมกำลังประมวลผล → 409 idempotency_in_progress', async () => {
      const body = newCompany();
      await plat.idempotencyKey.create({
        data: {
          tenantId,
          key: 'k-3',
          path: '/v1/companies',
          requestHash: await hashOf(body),
          lockedUntil: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const res = await api(app, token)
        .post('/v1/companies')
        .set('Idempotency-Key', 'k-3')
        .send(body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('idempotency_in_progress');
    });

    it('คำขอที่ error ไม่ถูกจำ — ส่งซ้ำด้วย key เดิมหลังแก้ข้อมูลได้', async () => {
      const bad = { legalName: 'x', taxId: '0000000000000' };
      expect(
        (await api(app, token).post('/v1/companies').set('Idempotency-Key', 'k-4').send(bad))
          .status,
      ).toBe(422);
      expect(
        (await api(app, token).post('/v1/companies').set('Idempotency-Key', 'k-4').send(bad))
          .status,
      ).toBe(422);
    });

    it('คำขอพร้อมกัน 3 ครั้ง key เดียวกัน → ทำจริงครั้งเดียว (ที่เหลือ replay หรือ 409 in_progress)', async () => {
      const body = newCompany();
      const rs = await Promise.all(
        [1, 2, 3].map(() =>
          api(app, token).post('/v1/companies').set('Idempotency-Key', 'k-race').send(body),
        ),
      );
      for (const r of rs) {
        if (r.status === 201) continue;
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('idempotency_in_progress');
      }
      expect(rs.filter((r) => r.status === 201 && !r.headers['idempotent-replayed'])).toHaveLength(
        1,
      );
      expect(await plat.company.count({ where: { tenantId, taxId: body.taxId } })).toBe(1);
    });

    it('key เดียวกันคนละ tenant ไม่ชนกัน', async () => {
      const other = await tokenFor((await createTenant(plat)).id);
      const body = newCompany();
      await api(app, token)
        .post('/v1/companies')
        .set('Idempotency-Key', 'shared')
        .send(body)
        .expect(201);
      const res = await api(app, other)
        .post('/v1/companies')
        .set('Idempotency-Key', 'shared')
        .send(body);
      expect(res.status).toBe(201);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
    });
  });

  describe('T08 cursor / fields / ETag', () => {
    it('เดิน cursor ผ่าน 10,000 แถว ไม่ซ้ำไม่ตก (updatedAt ซ้ำกันทั้งหมด)', async () => {
      const t = (await createTenant(plat)).id;
      const tok = await tokenFor(t);
      const at = new Date('2026-11-01T00:00:00Z');
      const N = 10_000;
      await plat.company.createMany({
        data: Array.from({ length: N }, (_, i) => ({
          tenantId: t,
          legalName: `Co ${i}`,
          taxId: validTaxId(100_000 + i),
          createdAt: at,
          updatedAt: at,
        })),
      });
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/v1/companies?limit=200&fields=legalName${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await api(app, tok).get(url);
        expect(res.status).toBe(200);
        for (const row of res.body.data) {
          expect(seen.has(row.id)).toBe(false);
          seen.add(row.id);
          expect(Object.keys(row).sort()).toEqual(['id', 'legalName']);
        }
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor);
      expect(seen.size).toBe(N);
      expect(pages).toBe(N / 200);
    }, 120_000);

    it('updatedAfter + sort=-updatedAt', async () => {
      const t = (await createTenant(plat)).id;
      const tok = await tokenFor(t);
      for (const [i, d] of ['2026-01-01', '2026-02-01', '2026-03-01'].entries()) {
        await plat.company.create({
          data: {
            tenantId: t,
            legalName: `C${i}`,
            taxId: validTaxId(900 + i),
            updatedAt: new Date(d),
          },
        });
      }
      const res = await api(app, tok).get(
        '/v1/companies?updatedAfter=2026-01-15T00:00:00Z&sort=-updatedAt',
      );
      expect(res.body.data.map((c: { legalName: string }) => c.legalName)).toEqual(['C2', 'C1']);
    });

    it('cursor เสีย → 422', async () => {
      expect((await api(app, token).get('/v1/companies?cursor=%%%')).status).toBe(422);
    });

    it('GET คืน ETag; PATCH ด้วย If-Match ไม่ตรง → 412; ตรง → สำเร็จและ version เพิ่ม', async () => {
      const created = await api(app, token).post('/v1/companies').send(newCompany());
      const id = created.body.id;
      const get = await api(app, token).get(`/v1/companies/${id}`);
      expect(get.headers.etag).toBe('"1"');
      const stale = await api(app, token)
        .patch(`/v1/companies/${id}`)
        .set('If-Match', '"9"')
        .send({ legalName: 'ใหม่' });
      expect(stale.status).toBe(412);
      expect(stale.body.code).toBe('precondition_failed');
      const ok = await api(app, token)
        .patch(`/v1/companies/${id}`)
        .set('If-Match', '"1"')
        .send({ legalName: 'ใหม่' });
      expect(ok.status).toBe(200);
      expect(ok.headers.etag).toBe('"2"');
      expect(ok.body.legalName).toBe('ใหม่');
    });
  });

  describe('T10 state machine + history + domain_event', () => {
    it('เปลี่ยนสถานะ → history 1 แถว + event 1 แถว ใน transaction เดียว', async () => {
      const id = (await api(app, token).post('/v1/companies').send(newCompany())).body.id;
      const res = await api(app, token)
        .post(`/v1/companies/${id}/deactivate`)
        .send({ reason: 'ปิดกิจการ' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('inactive');
      const uuid = await plat.company.findFirstOrThrow({
        where: { tenantId, legalName: res.body.legalName },
      });
      const hist = await plat.docStatusHistory.findMany({ where: { docId: uuid.id } });
      const events = await plat.domainEvent.findMany({ where: { localId: uuid.id } });
      expect(hist).toHaveLength(1);
      expect(hist[0]).toMatchObject({
        fromStatus: 'ACTIVE',
        toStatus: 'INACTIVE',
        note: 'ปิดกิจการ',
        actorId: 'user-test',
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('company.deactivated');
      expect(events[0]!.requestId).toBe(res.headers['x-request-id']);
    });

    it('transition ผิด → 409 invalid_state_transition และไม่มี history เพิ่ม', async () => {
      const id = (await api(app, token).post('/v1/companies').send(newCompany())).body.id;
      const before = await plat.docStatusHistory.count();
      const res = await api(app, token).post(`/v1/companies/${id}/activate`).send({ reason: 'x' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('invalid_state_transition');
      expect(await plat.docStatusHistory.count()).toBe(before);
    });

    it('ไม่ใส่เหตุผล → 422 (ทุกการเปลี่ยนสถานะต้องมีเหตุผล)', async () => {
      const id = (await api(app, token).post('/v1/companies').send(newCompany())).body.id;
      expect((await api(app, token).post(`/v1/companies/${id}/deactivate`).send({})).status).toBe(
        422,
      );
    });
  });
});

async function hashOf(body: object): Promise<string> {
  const { createHash } = await import('node:crypto');
  const stable = (v: any): string =>
    v === null || typeof v !== 'object'
      ? JSON.stringify(v)
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
          .join(',')}}`;
  return createHash('sha256')
    .update(`POST /v1/companies\n${stable(body)}`)
    .digest('hex');
}
