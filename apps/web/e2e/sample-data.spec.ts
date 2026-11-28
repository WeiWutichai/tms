import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from './fixtures';

/** E2E P1-ST2-T09: การ์ดเริ่มต้นใช้งาน → "ใส่ข้อมูลตัวอย่าง" (บริษัทช่วงทดลองใช้) → เห็นในรายการลูกค้า → "ล้างข้อมูลตัวอย่าง" */
const env = Object.fromEntries(
  readFileSync(new URL('./.env.e2e', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], m[2]]),
);
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });

test.use({ loginEmail: 'admin@demo-a.test' });
let tenantId = '';
test.afterAll(async () => {
  // คืนสถานะเดิมของบริษัทเดโม (ข้อมูลตัวอย่างล้างในเทสต์แล้ว)
  if (tenantId) await db.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } });
  await db.$disconnect();
});

test('ข้อมูลตัวอย่าง: ใส่ → เห็นในรายการ → ล้าง → กลับเท่าเดิม', async ({ page }) => {
  const u = await db.appUser.findFirstOrThrow({ where: { email: 'admin@demo-a.test' } });
  tenantId = u.tenantId;
  await db.tenant.update({ where: { id: tenantId }, data: { status: 'TRIALING' } });
  await db.setupChecklistState.updateMany({
    where: { tenantId },
    data: { hiddenFor: [], completedAt: null },
  });
  const before = await db.customer.count({ where: { tenantId } });

  await page.goto('/');
  const card = page.getByRole('region', { name: 'เริ่มต้นใช้งาน TMS' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  const strip = card.getByTestId('sample-data');
  await expect(strip).toContainText('ลองใช้ด้วยข้อมูลตัวอย่าง');
  await strip.getByRole('button', { name: 'ใส่ข้อมูลตัวอย่าง' }).click();
  await expect(page.getByRole('status')).toHaveText('ใส่ข้อมูลตัวอย่างแล้ว');
  await expect(strip).toHaveAttribute('data-loaded', 'true');
  await expect(strip).toContainText('ลูกค้า 3 · สถานที่ 7 · รถ 5 · รถร่วม 2');
  expect(await db.customer.count({ where: { tenantId } })).toBe(before + 3);

  await strip.getByRole('button', { name: 'ล้างข้อมูลตัวอย่าง' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ล้างข้อมูล' }).click();
  await expect(page.getByRole('status')).toHaveText('ล้างข้อมูลตัวอย่างแล้ว');
  await expect(strip).toHaveAttribute('data-loaded', 'false');
  expect(await db.customer.count({ where: { tenantId } })).toBe(before);
  expect(await db.sampleRecord.count({ where: { tenantId } })).toBe(0);
});
