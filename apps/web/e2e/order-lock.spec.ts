import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Browser, Page } from '@playwright/test';
import { DEMO_PASSWORD, expect, test } from './fixtures';

/**
 * E2E ST3-T08 ล็อกการแก้ใบสั่งขนส่ง (2 browser context):
 * A (ผู้วางแผน) เปิดฟอร์มแก้ → B (ผู้จัดการ) เปิดใบเดียวกันเห็น "กำลังแก้ไขโดย …" และแก้ไม่ได้ →
 * ล็อกหมดอายุ (เลื่อนเวลาหมดอายุในฐาน = ครบ 10 นาทีไม่มีกิจกรรม) ป้ายหาย →
 * A เปิดแก้ใหม่ → B ปลดล็อกด้วยเหตุผล (`orders:unlock`) แล้วเปิดแก้เอง → A บันทึกไม่ได้ เห็นป้ายชื่อ B
 */
const env = Object.fromEntries(
  readFileSync(new URL('./.env.e2e', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1]!, m[2]!]),
);
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });

const RUN = String(Date.now()).slice(-6);
const A_NAME = 'วางแผน ตัวอย่าง';
const B_NAME = 'ผู้จัดการ ตัวอย่าง';

test.use({ loginEmail: 'planner@demo-a.test' });
test.afterAll(async () => db.$disconnect());

/** login ผ่าน API จริงใน context ของหน้า (refresh cookie) + คืน access token */
async function login(page: Page, email: string): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await page.request.post('/v1/auth/login', {
    data: {
      email,
      password: DEMO_PASSWORD,
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
  });
  expect(r1.status(), await r1.text()).toBe(200);
  const { code } = (await r1.json()) as { code: string };
  const r2 = await page.request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  });
  expect(r2.status(), await r2.text()).toBe(200);
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

async function contextB(browser: Browser, baseURL: string) {
  const ctx = await browser.newContext({
    baseURL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  const token = await login(page, 'manager@demo-a.test');
  return { ctx, page, token };
}

async function openOrder(page: Page, soNo: string) {
  await page.goto('/so');
  await page.getByRole('row', { name: new RegExp(soNo) }).click();
  const d = page.getByRole('dialog');
  await expect(d.getByText(soNo, { exact: true })).toBeVisible();
  return d;
}

async function openEdit(page: Page, soNo: string) {
  const d = await openOrder(page, soNo);
  const locked = page.waitForResponse(
    (r) => /\/v1\/orders\/[^/]+\/lock$/.test(r.url()) && r.request().method() === 'POST',
  );
  await d.getByRole('button', { name: 'เพิ่มเติม' }).click();
  await page.getByRole('menuitem', { name: 'แก้ไข', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(`แก้ไข ${soNo}`)).toBeVisible();
  return locked;
}

test('ผู้ใช้ B เปิดใบที่ A แก้อยู่ → อ่านอย่างเดียว; ครบ 10 นาทีล็อกหลุด; ผู้จัดการปลดล็อกพร้อมเหตุผล', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  // ใบสั่งที่พร้อมแก้ (สร้างผ่าน API ด้วยสิทธิ์ของ A)
  const H = { Authorization: `Bearer ${await login(page, 'planner@demo-a.test')}` };
  const g = async (path: string) =>
    (
      (await (await page.request.get(path, { headers: H })).json()) as {
        data: { id: string; code?: string }[];
      }
    ).data;
  const post = async (path: string, data: object) => {
    const r = await page.request.post(path, { headers: H, data });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()) as { id: string; soNo: string };
  };
  const company = (await g('/v1/companies?status=active&limit=1'))[0]!.id;
  const cust = await post('/v1/customers', {
    legalName: `ลูกค้าล็อก ${RUN}`,
    billingCompanyId: company,
  });
  const sa = await post('/v1/customer-sites', {
    name: `ต้นทางล็อก ${RUN}`,
    kind: 'PICKUP',
    address: { line1: 'ต้นทาง' },
  });
  const sb = await post('/v1/customer-sites', {
    name: `ปลายทางล็อก ${RUN}`,
    kind: 'DROPOFF',
    address: { line1: 'ปลายทาง' },
  });
  const vt = (await g('/v1/vehicle-types?limit=50')).find((v) => v.code === '6W')!.id;
  const day = new Date(Date.now() + 7 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
  const so = await post('/v1/orders', {
    customer: { id: cust.id },
    customerRef: `PO-LOCK-${RUN}`,
    requestedDate: day,
    vehicleTypeId: vt,
    stops: [
      { type: 'PICKUP', siteId: sa.id },
      { type: 'DELIVERY', siteId: sb.id },
    ],
  });

  // 1) A เปิดฟอร์มแก้ → ได้ล็อก
  const a1 = await openEdit(page, so.soNo);
  expect((await a1).status()).toBe(200);

  // 2) B เปิดใบเดียวกัน → ป้าย "กำลังแก้ไขโดย A" + ไม่มีเมนูแก้ไข
  const { ctx, page: pb, token: tokB } = await contextB(browser, baseURL!);
  const db1 = await openOrder(pb, so.soNo);
  await expect(db1.getByTestId('edit-lock-banner')).toContainText(`กำลังแก้ไขโดย ${A_NAME}`);
  await db1.getByRole('button', { name: 'เพิ่มเติม' }).click();
  await expect(pb.getByRole('menuitem', { name: 'คัดลอกเป็นใบใหม่' })).toBeVisible();
  await expect(pb.getByRole('menuitem', { name: 'แก้ไข', exact: true })).toHaveCount(0);
  await pb.keyboard.press('Escape');
  // API ชุดเดียวกัน: B แก้ตรง ๆ ก็ไม่ได้
  const patchB = await pb.request.patch(`/v1/orders/${so.id}`, {
    headers: { Authorization: `Bearer ${tokB}` },
    data: { customerRef: 'PO-B' },
  });
  expect(patchB.status()).toBe(409);
  expect(((await patchB.json()) as { code: string }).code).toBe('order_locked_by_user');

  // 3) ครบ 10 นาทีไม่มีกิจกรรม → ล็อกหลุด (เลื่อนเวลาหมดอายุในฐานแทนการรอจริง)
  const releasedA = page.waitForResponse(
    (r) => /\/v1\/orders\/[^/]+\/unlock$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'ยกเลิก' }).click();
  expect((await releasedA).status()).toBe(204);
  // A ปิดฟอร์มแล้ว — ใส่ล็อกค้างของ A กลับเหมือนปิดแท็บไม่ทันปลด แล้วให้หมดอายุ
  const soId = (
    (await db.salesOrder.findFirst({ where: { soNo: so.soNo }, select: { id: true } })) as {
      id: string;
    }
  ).id;
  const aId = '00000000-0000-4000-8000-0000000e0a04';
  const past = new Date(Date.now() - 11 * 60_000);
  await db.orderEditLock.upsert({
    where: { salesOrderId: soId },
    create: {
      tenantId: '00000000-0000-4000-8000-00000000000a',
      salesOrderId: soId,
      userId: aId,
      acquiredAt: past,
      lastSeenAt: past,
      expiresAt: new Date(past.getTime() + 10 * 60_000),
    },
    update: {
      userId: aId,
      acquiredAt: past,
      lastSeenAt: past,
      expiresAt: new Date(past.getTime() + 10 * 60_000),
    },
  });
  const db2 = await openOrder(pb, so.soNo);
  await expect(db2.getByTestId('edit-lock-banner')).toHaveCount(0);
  await pb.keyboard.press('Escape');

  // 4) A เปิดแก้อีกครั้ง → B (ผู้จัดการ, orders:unlock) ปลดล็อกด้วยเหตุผล → เปิดแก้เอง
  expect(await (await openEdit(page, so.soNo)).status()).toBe(200);
  const db3 = await openOrder(pb, so.soNo);
  const banner = db3.getByTestId('edit-lock-banner');
  await expect(banner).toContainText(A_NAME);
  await banner.getByRole('button', { name: 'ปลดล็อก' }).click();
  const dlg = pb.getByRole('dialog', { name: `ปลดล็อกการแก้ไขของ ${A_NAME}` });
  await dlg.getByLabel(/เหตุผลที่ปลดล็อก/).fill('ผู้แก้ไม่อยู่ ต้องแก้วันรับของด่วน');
  await dlg.getByRole('button', { name: 'ปลดล็อก' }).click();
  await expect(pb.getByRole('status')).toContainText(`ปลดล็อก ${so.soNo} แล้ว`);
  await expect(db3.getByTestId('edit-lock-banner')).toHaveCount(0);
  const audit = await db.auditLog.findFirst({
    where: { entityId: soId, action: 'order.edit_lock_released' },
  });
  expect(audit).toMatchObject({ reason: 'ผู้แก้ไม่อยู่ ต้องแก้วันรับของด่วน' });
  const b1 = pb.waitForResponse(
    (r) => /\/v1\/orders\/[^/]+\/lock$/.test(r.url()) && r.request().method() === 'POST',
  );
  await db3.getByRole('button', { name: 'เพิ่มเติม' }).click();
  await pb.getByRole('menuitem', { name: 'แก้ไข', exact: true }).click();
  expect((await b1).status()).toBe(200);

  // 5) A กดบันทึก → 409 → ฟอร์ม A อ่านอย่างเดียว พร้อมป้ายชื่อ B
  const fa = page.getByRole('dialog');
  await fa.getByLabel('เลข PO ลูกค้า').fill(`PO-A-${RUN}`);
  await fa.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await expect(fa.getByTestId('edit-lock-banner')).toContainText(`กำลังแก้ไขโดย ${B_NAME}`);
  await expect(fa.getByLabel('เลข PO ลูกค้า')).toBeDisabled();
  await expect(fa.getByRole('button', { name: 'บันทึกการแก้ไข' })).toBeDisabled();

  // 6) B ปิดฟอร์ม → ปลดล็อก (A ลองใหม่แล้วได้ล็อก)
  const released = pb.waitForResponse(
    (r) => /\/v1\/orders\/[^/]+\/unlock$/.test(r.url()) && r.request().method() === 'POST',
  );
  await pb.getByRole('dialog').getByRole('button', { name: 'ยกเลิก' }).click();
  expect((await released).status()).toBe(204);
  await ctx.close();
});
