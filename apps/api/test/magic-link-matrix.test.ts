import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/db/prisma.service';
import { resetPublicRateLimit } from '../src/http/public-rate-limit.middleware';
import {
  LINK_PURPOSES,
  MagicLinkService,
  type LinkPurpose,
} from '../src/modules/links/magic-link.service';
import { bootApp, createTenant, platform, truncateAll } from './helpers';
import { collectRoutes, PURPOSE_ACTIONS, type RouteInfo } from './route-inventory';

/**
 * ST9-T13 magic link ทุกชนิด × ทุก route ลิงก์ (docs/04 J "HMAC + หมดอายุ + จำกัด action + revoke ได้")
 * - ลิงก์ของ purpose หนึ่งผ่าน `resolve` ได้เฉพาะ action ของ purpose นั้น (route ของ purpose อื่น = 404)
 * - ทุก route ลิงก์: ลายเซ็นปลอม / หมดอายุ / เพิกถอน / ลิงก์ของ purpose อื่น / tenant ระงับ → 404 problem+json เหมือนกัน
 *   (ไม่บอกใบ้ว่าเพราะอะไร) + Cache-Control: no-store + X-Robots-Tag noindex + Referrer-Policy no-referrer + ไม่สะท้อน id ของลิงก์กลับ
 * test เชิงธุรกิจของแต่ละชนิด (ข้อมูลที่เห็น/ราคา/เพิกถอนตามเหตุการณ์) อยู่ในไฟล์ของโมดูลนั้น — ดู docs/security/st9-t13-review.md §5
 */
const ISSUED = LINK_PURPOSES.filter((p) => PURPOSE_ACTIONS[p].length > 0);

describe('magic link matrix (ST9-T13)', () => {
  let app: NestExpressApplication;
  let svc: MagicLinkService;
  const prisma = new PrismaService();
  const db = platform();
  let tenantId: string;
  let linkRoutes: RouteInfo[];

  const issue = (purpose: LinkPurpose, ttlSeconds = 3600, tenant = tenantId) =>
    prisma.app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return svc.issue(tx as never, tenant, {
        purpose,
        entityType: 'matrix_entity',
        entityId: randomUUID(),
        actions: [...PURPOSE_ACTIONS[purpose]],
        ttlSeconds,
      });
    });
  const revoke = (id: string) =>
    prisma.app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return svc.revoke(tx as never, id, 'matrix test revoke');
    });
  const urlOf = (r: RouteInfo, token: string) =>
    r.path.replace(':token', token).replace(/(?<!\\):([A-Za-z0-9_]+)/g, 'x');
  const call = (r: RouteInfo, token: string) =>
    (request(app.getHttpServer()) as any)
      [r.method.toLowerCase()](urlOf(r, token))
      .send({}) as request.Test;
  const purposeOfRoute = (r: RouteInfo) =>
    ISSUED.find((p) => PURPOSE_ACTIONS[p].includes(r.linkAction!))!;

  beforeAll(async () => {
    await truncateAll();
    await resetPublicRateLimit();
    app = await bootApp();
    svc = app.get(MagicLinkService);
    tenantId = (await createTenant(db, 'matrix')).id;
    linkRoutes = collectRoutes(app).filter((r) => r.linkAction);
  });
  afterAll(async () => {
    await app.close();
    await prisma.onModuleDestroy();
    await db.$disconnect();
  });

  it('จำกัด action: ลิงก์ของแต่ละ purpose ผ่านได้เฉพาะ action ของตัวเอง ทุกคู่ (purpose × action ของทุก route)', async () => {
    const actions = [...new Set(linkRoutes.map((r) => r.linkAction!))];
    expect(actions.length).toBeGreaterThanOrEqual(10);
    const wrong: string[] = [];
    for (const p of ISSUED) {
      const l = await issue(p);
      for (const a of actions) {
        const ok = (await svc.resolve(l.token, a)) !== null;
        if (ok !== PURPOSE_ACTIONS[p].includes(a)) wrong.push(`${p} × ${a} → ${ok}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('ทุก route ลิงก์: ปลอม / หมดอายุ / เพิกถอน / purpose อื่น / tenant ระงับ → 404 เดียวกัน + no-store + ไม่สะท้อน id', async () => {
    await resetPublicRateLimit();
    // เตรียม token ต่อ purpose: หมดอายุ, เพิกถอน, ลายเซ็นปลอม (แก้ตัวท้าย), ของ tenant ที่ถูกระงับ
    const variants = new Map<LinkPurpose, { name: string; token: string; ids: string[] }[]>();
    const suspended = (await createTenant(db, 'matrix-suspended')).id;
    for (const p of ISSUED) {
      const expired = await issue(p, -60);
      const revoked = await issue(p);
      expect(await revoke(revoked.id)).toBe(true);
      const live = await issue(p);
      const sig = live.token.slice(-1) === 'A' ? 'B' : 'A';
      const ofSuspended = await issue(p, 3600, suspended);
      variants.set(p, [
        { name: 'expired', token: expired.token, ids: [expired.id] },
        { name: 'revoked', token: revoked.token, ids: [revoked.id] },
        { name: 'forged', token: live.token.slice(0, -1) + sig, ids: [live.id] },
        { name: 'suspended', token: ofSuspended.token, ids: [ofSuspended.id] },
      ]);
    }
    await db.tenant.update({ where: { id: suspended }, data: { status: 'SUSPENDED' } });
    // ลิงก์ที่ยังใช้ได้ของ purpose อื่น (ทุก purpose ที่ไม่ได้เป็นเจ้าของ action ของ route)
    const liveOf = new Map<LinkPurpose, { token: string; id: string }>();
    for (const p of ISSUED) liveOf.set(p, await issue(p));

    const wrong: string[] = [];
    for (const r of linkRoutes) {
      const owner = purposeOfRoute(r);
      const cases = [
        ...variants.get(owner)!,
        ...ISSUED.filter((p) => p !== owner).map((p) => ({
          name: `purpose ${p}`,
          token: liveOf.get(p)!.token,
          ids: [liveOf.get(p)!.id],
        })),
      ];
      for (const c of cases) {
        await resetPublicRateLimit();
        const res = await call(r, c.token);
        const tag = `${r.method} ${r.path} [${c.name}]`;
        if (res.status !== 404 || res.body?.code !== 'not_found') {
          wrong.push(`${tag} → ${res.status} ${res.body?.code}`);
          continue;
        }
        if (!String(res.headers['content-type']).includes('application/problem+json'))
          wrong.push(`${tag} content-type ${res.headers['content-type']}`);
        if (!String(res.headers['cache-control']).includes('no-store'))
          wrong.push(`${tag} ไม่มี no-store`);
        if (
          res.headers['x-robots-tag'] !== 'noindex, nofollow' ||
          res.headers['referrer-policy'] !== 'no-referrer'
        )
          wrong.push(`${tag} ไม่มี X-Robots-Tag noindex / Referrer-Policy no-referrer (NFR-135)`);
        // ไม่บอกเหตุผล (หมดอายุ/เพิกถอน) และไม่เผย id ของลิงก์ — ยกเว้น `instance` ที่สะท้อน URL ของผู้เรียกเอง
        const { instance: _i, requestId: _r, ...rest } = res.body as Record<string, unknown>;
        const text = JSON.stringify(rest).toLowerCase();
        if (/expire|revok|หมดอายุ|เพิกถอน|suspend/.test(text))
          wrong.push(`${tag} บอกเหตุผล: ${text}`);
        for (const id of c.ids)
          if (text.includes(id) || text.includes(id.replace(/-/g, '')))
            wrong.push(`${tag} เผย id ลิงก์`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('ลิงก์ที่ยังใช้ได้ resolve ได้จริง (ตัวควบคุม) · ลิงก์ purpose ที่สงวนไว้ (ไม่มี action) ออกไม่ได้', async () => {
    for (const p of ISSUED) {
      const l = await issue(p);
      expect(await svc.resolve(l.token, PURPOSE_ACTIONS[p][0]!), p).not.toBeNull();
    }
    await expect(
      prisma.app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return svc.issue(tx as never, tenantId, {
          purpose: 'settlement_view',
          entityType: 'x',
          entityId: randomUUID(),
          actions: [],
          ttlSeconds: 60,
        });
      }),
    ).rejects.toThrow(/at least one action/);
  });
});
