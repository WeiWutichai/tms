import { Controller, Get, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { createApp } from '../src/bootstrap';
import { LinkAction, Public } from '../src/common/decorators';
import { PriceField } from '../src/common/price-fields';
import { requestContext } from '../src/common/request-context';
import { PrismaService } from '../src/db/prisma.service';
import {
  PUBLIC_LIMIT_PER_MIN,
  resetPublicRateLimit,
} from '../src/http/public-rate-limit.middleware';
import { encodeLinkToken, MagicLinkService } from '../src/modules/links/magic-link.service';
import { createTenant, platform, truncateAll } from './helpers';

class OfferDto {
  @PriceField('sell') sellAmount!: string;
  @PriceField('buy') buyAmount!: string;
}
void OfferDto;

/** controller ชั่วคราวเฉพาะ test — ข้อเสนองานจริงมาใน ST3-T23 */
@Controller('public/__test')
class LinkTestController {
  @Get(':token')
  @LinkAction('view')
  async view() {
    const ctx = requestContext.require();
    const t = await ctx.tx!.tenant.findFirst(); // ใต้ RLS ของ tenant ที่ลิงก์ชี้
    return {
      entityId: ctx.link!.entityId,
      tenant: t?.name,
      sellAmount: '1000.00',
      buyAmount: '800.00',
    };
  }
  @Post(':token/accept')
  @LinkAction('accept')
  accept() {
    return { ok: true };
  }
}
/** @Public ระดับ class + @LinkAction ระดับ method ต้องยังตรวจลิงก์ (review T06) */
@Public()
@Controller('public/__test2')
class PublicLinkController {
  @Get(':token')
  @LinkAction('view')
  view() {
    return { link: requestContext.require().link?.id ?? null };
  }
}
@Module({ imports: [AppModule], controllers: [LinkTestController, PublicLinkController] })
class TestModule {}

/** ST1-T06: ลิงก์หมดอายุ/ถูกเพิกถอน/ทำ action นอกรายการ → 404; payload ไม่มี field ราคาขาย */
describe('magic link', () => {
  let app: NestExpressApplication;
  const db = platform();
  const prisma = new PrismaService();
  let svc: MagicLinkService;
  let tenantId: string;
  const trip = randomUUID();

  const issue = (input: Partial<Parameters<MagicLinkService['issue']>[2]> = {}) =>
    prisma.app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return svc.issue(tx as never, tenantId, {
        purpose: 'trip_offer',
        entityType: 'trip',
        entityId: trip,
        actions: ['view'],
        scopes: ['prices.buy:read'],
        ttlSeconds: 3600,
        ...input,
      });
    });
  const get = (token: string) => request(app.getHttpServer()).get(`/v1/public/__test/${token}`);

  beforeAll(async () => {
    await truncateAll();
    app = await createApp(TestModule);
    svc = app.get(MagicLinkService);
    tenantId = (await createTenant(db, 'บริษัท ลิงก์')).id;
    await createTenant(db, 'บริษัท อื่น');
  });
  afterAll(async () => {
    await app.close();
    await prisma.onModuleDestroy();
    await db.$disconnect();
  });

  it('ลิงก์ถูกต้อง: เปิดได้โดยไม่ login, อยู่ใต้ RLS ของ tenant นั้น, ไม่มีราคาขาย (เห็นราคาซื้อตาม scope ของลิงก์)', async () => {
    const l = await issue();
    const res = await get(l.token).expect(200);
    expect(res.body).toEqual({ entityId: trip, tenant: 'บริษัท ลิงก์', buyAmount: '800.00' });
    expect(JSON.stringify(res.body)).not.toMatch(/sell/);
  });

  it('action นอกรายการ / หมดอายุ / ถูกเพิกถอน / ลายเซ็นผิด / อายุใน token ไม่ตรง → 404', async () => {
    const l = await issue();
    expect(
      (await request(app.getHttpServer()).post(`/v1/public/__test/${l.token}/accept`)).status,
    ).toBe(404);
    const both = await issue({ actions: ['view', 'accept'] });
    await request(app.getHttpServer()).post(`/v1/public/__test/${both.token}/accept`).expect(201);

    const old = await issue({ ttlSeconds: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    expect((await get(old.token)).status).toBe(404);
    const past = Math.floor((Date.now() - 1000) / 1000);
    expect((await get(encodeLinkToken(old.id, past))).status).toBe(404);

    const rev = await issue();
    await prisma.app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await svc.revoke(tx as never, rev.id, 'รถร่วมยกเลิก');
    });
    expect((await get(rev.token)).status).toBe(404);

    const good = await issue();
    const tampered = good.token.slice(0, -2) + (good.token.endsWith('AA') ? 'BB' : 'AA');
    expect((await get(tampered)).status).toBe(404);
    const otherExp = encodeLinkToken(good.id, Math.floor(Date.now() / 1000) + 99999);
    expect((await get(otherExp)).status).toBe(404);
    expect((await get('nonsense')).status).toBe(404);
    expect((await get(good.token)).headers['content-type']).toContain('application/json');
  });

  it('ออกลิงก์ที่มี scope ราคาขายไม่ได้; ไม่มี action ไม่ได้; ลบแถวลิงก์ไม่ได้ (เก็บเป็นหลักฐาน)', async () => {
    await expect(issue({ scopes: ['prices.sell:read'] })).rejects.toThrow(/selling-price/);
    await expect(issue({ actions: [] })).rejects.toThrow(/action/);
    const l = await issue();
    await expect(
      prisma.app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`DELETE FROM magic_link WHERE id = ${l.id}::uuid`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('review: tenant ถูกระงับ → ลิงก์ใช้ไม่ได้; ออก/เพิกถอนลงทะเบียน audit; เพิกถอนแล้วคืนไม่ได้; scope `*` ไม่ได้', async () => {
    const t2 = await createTenant(db, 'บริษัท ระงับ');
    const l = await prisma.app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t2.id}, true)`;
      return svc.issue(tx as never, t2.id, {
        purpose: 'pod',
        entityType: 'trip',
        entityId: trip,
        actions: ['view'],
        ttlSeconds: 600,
      });
    });
    await get(l.token).expect(200);
    await db.tenant.update({ where: { id: t2.id }, data: { status: 'SUSPENDED' } });
    expect((await get(l.token)).status).toBe(404);

    const r = await issue();
    await prisma.app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      expect(await svc.revoke(tx as never, r.id, 'ยกเลิกงาน')).toBe(true);
      expect(await svc.revoke(tx as never, r.id, 'ซ้ำ')).toBe(false);
    });
    const audit = await db.auditLog.findMany({
      where: { tenantId, action: { startsWith: 'magic_link.' } },
    });
    expect(audit.some((a) => a.action === 'magic_link.revoked' && a.reason === 'ยกเลิกงาน')).toBe(
      true,
    );
    expect(audit.some((a) => a.action === 'magic_link.issued')).toBe(true);
    await expect(
      db.magicLink.update({ where: { id: r.id }, data: { revokedAt: null } }),
    ).rejects.toThrow(/permanent/);
    await expect(
      db.magicLink.update({ where: { id: r.id }, data: { actions: ['view', 'accept'] } }),
    ).rejects.toThrow(/immutable/);
    await expect(issue({ scopes: ['*'] })).rejects.toThrow(/not allowed/);
    expect((await request(app.getHttpServer()).get('/v1/public/__test2/garbage')).status).toBe(404);
    const ok = await issue();
    const res = await request(app.getHttpServer())
      .get(`/v1/public/__test2/${ok.token}`)
      .expect(200);
    expect(res.body.link).toBe(ok.id);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('route /public/* จำกัดอัตราต่อ IP → 429 + Retry-After', async () => {
    resetPublicRateLimit();
    const l = await issue();
    let last = 0;
    for (let i = 0; i <= PUBLIC_LIMIT_PER_MIN; i++)
      last = (await get(l.token).set('X-Forwarded-For', '10.70.0.1')).status;
    expect(last).toBe(429);
    expect((await get(l.token).set('X-Forwarded-For', '10.70.0.2')).status).toBe(200);
    resetPublicRateLimit();
  }, 60_000);
});
