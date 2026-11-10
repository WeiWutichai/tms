import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC, TENANT_RESOURCE } from '../src/common/decorators';
import { encodeId } from '../src/common/ids';
import { signStepUpToken } from '../src/auth/tokens';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * Harness แยก tenant (ST0-T05) — CI แดงเมื่อ:
 * (1) มีตารางที่มีคอลัมน์ tenant_id แต่ไม่เปิด RLS / ไม่ FORCE / ไม่มี policy
 * (2) มี route ที่มี `:id` แต่ไม่ประกาศ @TenantResource หรือไม่มี fixture ในไฟล์นี้
 * (3) เรียก resource ของ tenant A ด้วย token ของ tenant B แล้วไม่ได้ 404
 *
 * เพิ่ม resource ใหม่ = เพิ่ม fixture ใน FIXTURES (สร้างข้อมูลใน tenant A แล้วคืน id ที่ API ใช้)
 */
const FIXTURES: Record<string, (db: PrismaClient, tenantId: string, n: number) => Promise<string>> =
  {
    company: async (db, tenantId, n) =>
      encodeId(
        'company',
        (
          await db.company.create({
            data: { tenantId, legalName: `Co ${n}`, taxId: validTaxId(500 + n) },
          })
        ).id,
      ),
    branch: async (db, tenantId, n) => {
      const c = await db.company.create({
        data: { tenantId, legalName: `Co b${n}`, taxId: validTaxId(700 + n) },
      });
      const b = await db.branch.create({
        data: {
          tenantId,
          companyId: c.id,
          branchCode: '00000',
          branchLabel: 'HQ',
          address: {
            line1: 'x',
            subdistrict: 'x',
            district: 'x',
            province: 'x',
            postcode: '10000',
          },
        },
      });
      return encodeId('branch', b.id);
    },
    sequence: async (db, tenantId) => {
      const s = await db.documentSeries.upsert({
        where: { tenantId_docType: { tenantId, docType: 'SO' } },
        create: { tenantId, docType: 'SO', prefix: 'SO-' },
        update: {},
      });
      return encodeId('sequence', s.id);
    },
    user: async (db, tenantId, n) =>
      encodeId(
        'user',
        (
          await db.appUser.create({
            data: { tenantId, email: `iso${n}@iso.test`, name: `iso ${n}`, status: 'ACTIVE' },
          })
        ).id,
      ),
    document: async (db, tenantId) =>
      encodeId(
        'document',
        (
          await db.storedDocument.create({
            data: {
              tenantId,
              status: 'PENDING',
              kind: 'OTHER',
              mimeType: 'application/pdf',
              sizeBytes: 10,
            },
          })
        ).id,
      ),
    job: async (db, tenantId) =>
      encodeId('job', (await db.job.create({ data: { tenantId, type: 'noop' } })).id),
  };

/** body ขั้นต่ำที่ผ่าน validation ของ action แต่ละแบบ (ให้ไปถึง handler แล้วได้ 404 จริง) */
const BODY_FOR_SUFFIX: Record<string, object> = {
  deactivate: { reason: 'isolation test' },
  activate: { reason: 'isolation test' },
  roles: { roles: ['viewer'], reason: 'isolation test' },
  suspend: { reason: 'isolation test' },
  delete: { reason: 'isolation test' },
};

interface RouteInfo {
  method: string;
  path: string;
  resource?: string;
  isPublic: boolean;
}

function collectRoutes(app: NestExpressApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as any;
      if (!cls) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
      const proto = cls.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        const m = Reflect.getMetadata(METHOD_METADATA, handler);
        if (sub === undefined || m === undefined) continue;
        routes.push({
          method: RequestMethod[m as number]!,
          path: `/v1/${[base, String(sub)].filter((s) => s && s !== '/').join('/')}`.replace(
            /\/+/g,
            '/',
          ),
          resource:
            Reflect.getMetadata(TENANT_RESOURCE, handler) ??
            Reflect.getMetadata(TENANT_RESOURCE, cls),
          isPublic: Boolean(
            Reflect.getMetadata(IS_PUBLIC, handler) ?? Reflect.getMetadata(IS_PUBLIC, cls),
          ),
        });
      }
    }
  }
  return routes;
}

describe('tenant isolation harness', () => {
  let app: NestExpressApplication;
  const plat = platform();
  let tenantA: string;
  let tokenB: string;
  let stepUpB: string;
  let tokenA: string;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantA = (await createTenant(plat, 'A')).id;
    const tenantB = (await createTenant(plat, 'B')).id;
    tokenA = await tokenFor(tenantA);
    tokenB = await tokenFor(tenantB);
    stepUpB = await signStepUpToken('user-test', tenantB);
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  it('(1) ทุกตารางที่มี tenant_id เปิด RLS + FORCE + มี policy', async () => {
    const rows = await plat.$queryRaw<
      { table: string; rls: boolean; forced: boolean; policies: number }[]
    >`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND (EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id')
              OR c.relname = 'tenant')`;
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter((r) => !r.rls || !r.forced || r.policies === 0).map((r) => r.table);
    expect(bad, `ตารางที่ไม่มี RLS ครบ: ${bad.join(', ')}`).toEqual([]);
  });

  it('(2) ทุก route ที่มี :id ประกาศ @TenantResource และมี fixture', () => {
    const missing = collectRoutes(app)
      .filter((r) => r.path.includes(':id') && !r.isPublic)
      .filter((r) => !r.resource || !FIXTURES[r.resource])
      .map((r) => `${r.method} ${r.path} (resource=${r.resource ?? 'ไม่ประกาศ'})`);
    expect(missing, `route ที่ยังไม่ถูกทดสอบแยก tenant:\n${missing.join('\n')}`).toEqual([]);
  });

  it('(3) token ของ tenant B เรียก resource ของ tenant A → 404 problem+json ทุก route', async () => {
    const routes = collectRoutes(app).filter((r) => r.path.includes(':id') && !r.isPublic);
    expect(routes.length).toBeGreaterThan(0);
    let n = 0;
    for (const r of routes) {
      const id = await FIXTURES[r.resource!]!(plat, tenantA, n++);
      const url = r.path.replace(':id', id);
      const suffix = r.path.split('/').pop()!;
      // route ที่ต้อง step-up: ส่ง step-up ที่ถูกต้องของ tenant B ไปด้วย ให้ไปถึงการหา resource จริง
      const call = api(app, tokenB)
        [r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete'](url)
        .set('X-Step-Up', stepUpB);
      const res = await (['POST', 'PATCH', 'PUT'].includes(r.method)
        ? call.send(BODY_FOR_SUFFIX[suffix] ?? {})
        : call);
      expect(res.status, `${r.method} ${r.path}`).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('not_found');

      // sanity: เจ้าของเรียกได้ (GET) — กันกรณี route พังจนคืน 404 ให้ทุกคน
      if (r.method === 'GET')
        expect((await api(app, tokenA).get(url)).status, `owner ${r.path}`).toBe(200);
    }
  });

  it('list ของ tenant B ไม่มีข้อมูลของ A', async () => {
    const res = await api(app, tokenB).get('/v1/companies');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
