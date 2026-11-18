import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from './fixtures';

/**
 * E2E ST9-T08: ผู้ใช้ (ผู้วางแผน — ไม่มีสิทธิ์ settings) ปิดอีเมลของ event หนึ่งที่ ตั้งค่า → การแจ้งเตือน → บันทึก → ค่าคงอยู่หลังโหลดใหม่
 * ผลต่อการส่ง (ไม่ได้อีเมลแต่ยังเห็นในกระดิ่ง) ตรวจใน apps/api/test/notification-center.test.ts
 */
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

test('ตั้งค่า → การแจ้งเตือน: ปิดอีเมล "รถร่วมปฏิเสธหรือหมดเวลา" + สรุปรายวัน → บันทึก → คงอยู่', async ({
  page,
}) => {
  const u = await db.appUser.findFirstOrThrow({ where: { email: 'planner@demo-a.test' } });
  await db.userPreference.deleteMany({ where: { userId: u.id, key: 'notifications' } });
  await page.goto('/settings?sec=noti');
  await expect(page.getByRole('heading', { name: 'การแจ้งเตือน' })).toBeVisible();
  const email = page.getByLabel('อีเมล — รถร่วมปฏิเสธหรือหมดเวลา');
  await expect(email).toBeChecked();
  await expect(page.getByLabel('อีเมล — ใบค้างใหม่')).not.toBeChecked();
  await expect(page.getByLabel('LINE — ใบค้างใหม่')).toBeDisabled();
  await email.uncheck();
  await page.getByLabel('อีเมล — สรุปรายวัน 08:00 น.').uncheck();
  await page.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.getByRole('status')).toHaveText(/บันทึกการตั้งค่าการแจ้งเตือนแล้ว/);

  await page.reload();
  await expect(page.getByLabel('อีเมล — รถร่วมปฏิเสธหรือหมดเวลา')).not.toBeChecked();
  await expect(page.getByLabel('ในระบบ — รถร่วมปฏิเสธหรือหมดเวลา')).toBeChecked();
  await expect(page.getByLabel('อีเมล — สรุปรายวัน 08:00 น.')).not.toBeChecked();
  const row = await db.userPreference.findFirstOrThrow({
    where: { userId: u.id, key: 'notifications' },
  });
  expect(row.value).toEqual({
    events: { 'subcon.no_response': { email: false } },
    dailyDigest: false,
  });

  await page.getByRole('tab', { name: 'แจ้งลูกค้าปลายทาง' }).click();
  await expect(page.getByText('หน้านี้ยังไม่เปิดใช้')).toBeVisible();
  await db.userPreference.deleteMany({ where: { userId: u.id, key: 'notifications' } });
});
