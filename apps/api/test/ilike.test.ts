import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iEquals } from '../src/common/ilike';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * review ST2-T04: Prisma `{ equals, mode: 'insensitive' }` = ILIKE ไม่ escape → `_`/`%` เป็น wildcard
 * ตรวจว่าการเทียบรหัส/ชื่อ/อีเมลแบบไม่สนตัวพิมพ์ใช้ `iEquals` (ตรงทุกตัวอักษร) ไม่ใช่ pattern
 */
describe('เทียบไม่สนตัวพิมพ์ไม่ใช้ wildcard (iEquals)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
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

  it('อีเมล: a_b@… ไม่ตรงกับ axb@… แต่ตัวพิมพ์ต่างกันยังตรง', async () => {
    await db.appUser.create({
      data: { tenantId, email: 'Axb@ilike.test', name: 'x', status: 'ACTIVE' },
    });
    const n = (e: string) => db.appUser.count({ where: { email: iEquals(e) } });
    expect(await n('a_b@ilike.test')).toBe(0);
    expect(await n('a%@ilike.test')).toBe(0);
    expect(await n('axb@ILIKE.test')).toBe(1);
  });

  it('ประเภทรถ: ชื่อ "6_ล้อ" ไม่ชน "6 ล้อ" · รหัส 10W_DRY ไม่ชน 10W-DRY', async () => {
    const base = { vehicleClass: '6W', payloadKg: 6000, minLicenceClass: 'T2' };
    const post = (b: object) =>
      api(app, admin)
        .post('/v1/vehicle-types')
        .send({ ...base, ...b });
    await post({ name: '6 ล้อ', code: '10W-DRY' }).expect(201);
    await post({ name: '6_ล้อ', code: '10W_DRY' }).expect(201);
    await post({ name: '6 ล้อ%', code: 'X1' }).expect(201);
    await post({ name: '6 ล้อ', code: 'X2' }).expect(409);
  });

  it('ลูกค้า/สถานที่: รหัสที่มี _ ไม่ชนรหัสที่ต่างตัวเดียว', async () => {
    const c = (code: string, n: number) =>
      api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ${code}`, code, taxId: validTaxId(7700 + n) });
    await c('C-1A', 1).expect(201);
    await c('C_1A', 2).expect(201);
    await c('c_1a', 3).expect(409);
    const s = (code: string) =>
      api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุด ${code}`, code, address: { line1: 'x' } });
    await s('L-1').expect(201);
    await s('L_1').expect(201);
  });
});
