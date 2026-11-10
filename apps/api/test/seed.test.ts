import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { platform } from './helpers';

describe('seed (ST0-T16)', () => {
  it('รัน 2 ครั้ง ข้อมูลเท่าเดิม', async () => {
    const run = () => execSync('pnpm -s db:seed', { env: process.env, encoding: 'utf8' });
    run();
    const db = platform();
    const snap = async () => ({
      tenants: await db.tenant.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, name: true },
      }),
      companies: await db.company.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, legalName: true, taxId: true },
      }),
    });
    const first = await snap();
    run();
    expect(await snap()).toEqual(first);
    expect(
      first.companies.filter((c) => c.taxId.startsWith('0000000000')).length,
    ).toBeGreaterThanOrEqual(3);
    await db.$disconnect();
  }, 60_000);
});
