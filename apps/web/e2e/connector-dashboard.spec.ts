import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEMO_EMAIL, DEMO_IDS, expect, test } from './fixtures';

/**
 * E2E ST9-T04 การ์ด "การเชื่อมต่อ {ระบบ}" บนหน้าภาพรวม (ต้นแบบ TMS v4 is.dash `dash.conn`) ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 * เกณฑ์: เชื่อมระบบบัญชีแล้ว การ์ดการเชื่อมต่อแทนการ์ดลูกหนี้ · คิวรอส่ง = คำสั่งค้าง · ปลายทางล่ม (healthCheck ล้ม) = สถานะแดง
 * (healthCheck ตามรอบ/หยุด mock KRS ทดสอบครบใน apps/api/test/connector-metrics.test.ts) · ไม่ทิ้ง connector ไว้ให้ spec อื่น
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

test.describe('การ์ดการเชื่อมต่อ (ST9-T04)', () => {
  test.afterAll(async () => db.$disconnect());

  test('เชื่อมแล้ว: การ์ดการเชื่อมต่อแทนลูกหนี้ · คิวรอส่ง · ปลายทางล่ม = ผิดพลาด (แดง) · ลิงก์คิวเชื่อมระบบบัญชี', async ({
    page,
  }) => {
    const owner = await db.appUser.findUniqueOrThrow({ where: { id: DEMO_IDS[DEMO_EMAIL]! } });
    const tenantId = owner.tenantId as string;
    // ใช้ connector ที่ spec อื่นเปิดไว้ถ้ามี (มีได้ 1 ตัวต่อขอบเขต) — ไม่มีก็สร้างแล้วยกเลิกตอนจบ
    const existing = await db.connector.findFirst({
      where: { tenantId, status: { not: 'DISCONNECTED' } },
    });
    const con =
      existing ??
      (await db.connector.create({
        data: {
          tenantId,
          adapterKey: 'demo',
          status: 'ACTIVE',
          taxDocumentOwner: 'TMS',
          lastHealthOk: true,
          lastHealthAt: new Date(),
        },
      }));
    const before = {
      status: con.status,
      lastHealthOk: con.lastHealthOk,
      healthFailingSince: con.healthFailingSince,
      lastHealthError: con.lastHealthError,
    };
    const localId = crypto.randomUUID();
    const cmd = await db.integrationOutbox.create({
      data: {
        tenantId,
        kind: 'ADAPTER',
        sink: 'erp',
        targetId: con.id,
        operation: 'PUSH_INVOICE',
        entityType: 'invoice',
        localId,
        serializeKey: `erp:${con.id}:e2e:${localId}`,
        idempotencyKey: `e2e-st9t04-${localId}`,
        status: 'PENDING',
        nextRunAt: new Date(Date.now() + 86_400_000),
      },
    });
    try {
      await db.connector.update({
        where: { id: con.id },
        data: { status: 'ACTIVE', lastHealthOk: true, healthFailingSince: null },
      });
      await page.goto('/');
      const card = page.getByTestId('dash-conn');
      await expect(
        card.getByRole('heading', { name: 'การเชื่อมต่อ ERP จำลอง (Demo)' }),
      ).toBeVisible();
      await expect(card.getByTestId('dash-conn-state')).toHaveText('เชื่อมต่อ');
      await expect(card.getByText('คิวรอส่ง (outbox)')).toBeVisible();
      expect(Number(await card.getByTestId('dash-conn-queued').textContent())).toBeGreaterThan(0);
      await expect(card.getByText('ส่งไม่สำเร็จ')).toBeVisible();
      await expect(card.getByText('ซิงก์ล่าสุด')).toBeVisible();
      await expect(page.getByTestId('dash-ar')).toHaveCount(0);

      // ปลายทางล่ม (healthCheck ล้มต่อเนื่อง) → แดง
      await db.connector.update({
        where: { id: con.id },
        data: {
          lastHealthOk: false,
          healthFailingSince: new Date(),
          lastHealthError: { errorClass: 'TRANSIENT', code: 'unreachable', message: 'down' },
        },
      });
      await page.reload();
      await expect(page.getByTestId('dash-conn-state')).toHaveText('ผิดพลาด');
      await expect(page.getByTestId('dash-conn-state')).toHaveCSS('color', 'rgb(179, 50, 42)');

      await card.getByRole('button', { name: 'ดูคิวเชื่อมระบบบัญชี' }).click();
      await expect(page).toHaveURL(/\/erp/);
    } finally {
      await db.integrationOutbox.update({
        where: { id: cmd.id },
        data: { status: 'SKIPPED' },
      });
      if (existing)
        await db.connector.update({
          where: { id: con.id },
          data: { ...before, lastHealthError: before.lastHealthError ?? undefined },
        });
      else
        await db.connector.update({
          where: { id: con.id },
          data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
        });
    }
  });
});
