import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from './fixtures';

/** E2E ST1-T23: มีแจ้งเตือน → จุดบนกระดิ่ง → กด → toast ตามต้นแบบ → อ่านแล้วจุดหาย */
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

test.use({ loginEmail: 'planner@demo-a.test' });
test.afterAll(async () => db.$disconnect());

test('กระดิ่ง: จุดเมื่อมีที่ยังไม่อ่าน → กดแล้วเห็นสรุปและจุดหาย', async ({ page }) => {
  const u = await db.appUser.findFirstOrThrow({ where: { email: 'planner@demo-a.test' } });
  await db.notification.updateMany({
    where: { recipientId: u.id, readAt: null },
    data: { readAt: new Date(), status: 'READ' },
  });
  await page.goto('/');
  const bell = page.getByRole('banner').getByRole('button', { name: 'การแจ้งเตือน' });
  await expect(bell).toBeVisible();
  await expect(page.getByTestId('bell-dot')).toHaveCount(0);
  await bell.click();
  await expect(page.getByRole('status')).toHaveText('ไม่มีแจ้งเตือนใหม่');

  for (const label of ['นำเข้ารถ', 'นำเข้าลูกค้า'])
    await db.notification.create({
      data: {
        tenantId: u.tenantId,
        recipientId: u.id,
        channel: 'in_app',
        templateCode: 'job.succeeded',
        locale: 'th',
        title: 'งานเสร็จแล้ว',
        body: `${label} เสร็จเรียบร้อย`,
        status: 'SENT',
        sentAt: new Date(),
      },
    });
  await page.reload();
  const unread = page.getByRole('button', { name: 'การแจ้งเตือน (มีรายการที่ยังไม่อ่าน)' });
  await expect(page.getByTestId('bell-dot')).toBeVisible();
  await unread.click();
  await expect(page.getByRole('status')).toHaveText(
    /^แจ้งเตือนใหม่ 2 รายการ: นำเข้า(ลูกค้า|รถ) เสร็จเรียบร้อย, นำเข้า(ลูกค้า|รถ) เสร็จเรียบร้อย$/,
  );
  await expect(page.getByTestId('bell-dot')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('bell-dot')).toHaveCount(0);
});
