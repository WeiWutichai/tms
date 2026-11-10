import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, platform, truncateAll, validTaxId } from './helpers';

/**
 * ST0-T04 เกณฑ์ตรวจรับ: query ที่ไม่ตั้ง session var ได้ 0 แถว; RLS กันได้แม้ข้าม Prisma extension
 * ใช้ PrismaClient ดิบ (ไม่มี tenant extension) ด้วย role tms_app
 */
describe('RLS (ฐานข้อมูล)', () => {
  const plat = platform();
  const raw = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  let a: string;
  let b: string;

  beforeAll(async () => {
    await truncateAll();
    a = (await createTenant(plat, 'A')).id;
    b = (await createTenant(plat, 'B')).id;
    await plat.company.create({ data: { tenantId: a, legalName: 'A Co', taxId: validTaxId(1) } });
  });
  afterAll(async () => {
    await plat.$disconnect();
    await raw.$disconnect();
  });

  it('ไม่ตั้ง app.tenant_id → เห็น 0 แถว (ทั้ง company และ tenant)', async () => {
    expect(await raw.$queryRaw`SELECT * FROM company`).toHaveLength(0);
    expect(await raw.$queryRaw`SELECT * FROM tenant`).toHaveLength(0);
  });

  it('ตั้งเป็น tenant B ด้วย raw SQL (ข้าม extension) → ไม่เห็นข้อมูลของ A', async () => {
    const rows = await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${b}, true)`;
      return tx.$queryRaw<unknown[]>`SELECT * FROM company`;
    });
    expect(rows).toHaveLength(0);
  });

  it('ตั้งเป็น tenant A → เห็นของตัวเอง', async () => {
    const rows = await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a}, true)`;
      return tx.$queryRaw<unknown[]>`SELECT * FROM company`;
    });
    expect(rows).toHaveLength(1);
  });

  it('เขียนแถวที่ tenant_id ไม่ตรงกับ session → ถูกปฏิเสธ (WITH CHECK)', async () => {
    await expect(
      raw.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${b}, true)`;
        await tx.$executeRaw`INSERT INTO company (id, tenant_id, legal_name, tax_id, updated_at)
                             VALUES (gen_random_uuid(), ${a}::uuid, 'X', ${validTaxId(2)}, now())`;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('ไม่ตั้ง session แล้ว UPDATE/DELETE → ไม่กระทบแถวใด', async () => {
    const n = await raw.$executeRaw`UPDATE company SET legal_name = 'hacked'`;
    expect(n).toBe(0);
    const after = await plat.company.findFirstOrThrow({ where: { tenantId: a } });
    expect(after.legalName).toBe('A Co');
  });

  it('role แอปแก้/ลบ history และ domain_event ไม่ได้ (append-only)', async () => {
    await expect(
      raw.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a}, true)`;
        await tx.$executeRaw`DELETE FROM domain_event`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
