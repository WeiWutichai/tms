import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from './fixtures';

/** E2E ST1-T21: การ์ด "เริ่มต้นใช้งาน TMS" บนหน้าภาพรวม — สถานะจากข้อมูลจริง, กดขั้นไปหน้าตั้งค่า, ซ่อนต่อผู้ใช้ */
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
test.afterAll(async () => db.$disconnect());

test('การ์ด setup checklist: เห็นความคืบหน้า กดไปหน้าตั้งค่า และซ่อนได้', async ({ page }) => {
  const u = await db.appUser.findFirstOrThrow({ where: { email: 'admin@demo-a.test' } });
  await db.setupChecklistState.updateMany({
    where: { tenantId: u.tenantId },
    data: { hiddenFor: [], completedAt: null },
  });
  await page.goto('/');
  const card = page.getByRole('region', { name: 'เริ่มต้นใช้งาน TMS' });
  await expect(card).toBeVisible();
  await expect(card.getByText(/^ทำครบแล้ว \d\/7 ขั้น · รายการนี้หายไปเองเมื่อครบ$/)).toBeVisible();
  await expect(card.locator('[data-step]')).toHaveCount(7);
  await card.getByRole('button', { name: /เลขที่เอกสาร/ }).click();
  await expect(page).toHaveURL(/\/settings\?sec=num/);
  await page.goto('/');
  await card.getByRole('button', { name: 'ซ่อน' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('ซ่อนรายการตั้งค่าแล้ว');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'ภาพรวม' })).toBeVisible();
  await expect(card).toHaveCount(0);
  await db.setupChecklistState.updateMany({
    where: { tenantId: u.tenantId },
    data: { hiddenFor: [] },
  });
});
