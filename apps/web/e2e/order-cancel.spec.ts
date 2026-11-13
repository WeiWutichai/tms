import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST3-T10: ยกเลิกใบสั่งขนส่งพร้อมเหตุผล (เมนู ⋯ → dialog ตามต้นแบบ askCancelDoc) และหน้าจอรับ/ไม่รับการเปลี่ยนแปลง
 * จากต้นทางหลังวางแผน (ตารางเทียบ TMS กับ ERP) — ผ่าน /v1 จริง (ฐาน e2e)
 * ทางเข้า connector ยังไม่มี endpoint HTTP (ST3-T05/ST8) → จำลองชุดที่ connector เก็บไว้ด้วยการเขียนฐานตรง
 * (ตรรกะเก็บ diff ทดสอบใน apps/api/test/order-cancel-source-change.test.ts) · ข้อมูลสมมติ
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
test.afterAll(() => db.$disconnect());

const RUN = String(Date.now()).slice(-6);
const CUST = `ลูกค้ายกเลิกอีทูอี ${RUN}`;
const A = `คลังต้นทาง ซี ${RUN}`;
const B = `คลังปลายทางเดิม ${RUN}`;
const hex = (pub: string) => {
  const h = pub.split('_')[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

async function token(page: Page): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await page.request.post('/v1/auth/login', {
    data: {
      email: 'owner@demo-a.test',
      password: 'demo-password-2569',
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
  });
  const { code } = (await r1.json()) as { code: string };
  const r2 = await page.request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  });
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

test.describe.serial('ใบสั่งขนส่ง: ยกเลิก + ต้นทางแก้หลังวางแผน (ST3-T10)', () => {
  let H: Record<string, string>;
  let body: object | undefined;

  /** ลูกค้า/สถานที่ของรอบนี้ (ครั้งแรก) — ใช้ request ของหน้า (baseURL ของ config) */
  const setup = async (page: Page) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (body) return;
    const get = async (path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as {
        data: { id: string; code?: string; name?: string }[];
      };
    const post = async (path: string, data: object) => {
      const r = await page.request.post(path, { headers: H, data });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as { id: string };
    };
    const company = (await get('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post('/v1/customers', { legalName: CUST, billingCompanyId: company });
    const a = await post('/v1/customer-sites', { name: A, kind: 'PICKUP', address: { line1: A } });
    const b = await post('/v1/customer-sites', { name: B, kind: 'DROPOFF', address: { line1: B } });
    const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    body = {
      customer: { id: cust.id },
      requestedDate: new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10),
      stops: [
        { type: 'PICKUP', siteId: a.id },
        { type: 'DELIVERY', siteId: b.id },
      ],
      lines: [{ description: 'น้ำดื่มขวด', qty: '10', unitId: ton, weightKg: '10000' }],
    };
  };

  const newOrder = async (page: Page) => {
    await setup(page);
    const r = await page.request.post('/v1/orders', { headers: H, data: body });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()) as { id: string; soNo: string };
  };

  test('ยกเลิกเอกสารจากเมนู ⋯: dialog สถานะ เดิม → ยกเลิก, เหตุผล ≥ 10 ตัวอักษร → ใบเป็น "ยกเลิก" + DO ยกเลิกตาม', async ({
    page,
  }) => {
    const o = await newOrder(page);
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(o.soNo) }).click();
    const drawer = page.getByRole('dialog').first();
    await expect(drawer.getByText(o.soNo, { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await page.getByRole('menuitem', { name: 'ยกเลิกเอกสาร' }).click();
    const dlg = page.getByRole('dialog', { name: `ยกเลิก ${o.soNo}` });
    await expect(dlg.getByText('เอกสารจะยังอยู่ในระบบพร้อมเหตุผล และย้อนกลับไม่ได้')).toBeVisible();
    await expect(dlg.getByRole('cell', { name: 'ยกเลิก', exact: true })).toBeVisible();
    const ok = dlg.getByRole('button', { name: 'ยืนยันยกเลิก' });
    await dlg.getByRole('textbox').fill('สั้นไป');
    await expect(ok).toBeDisabled();
    await dlg.getByRole('textbox').fill('ลูกค้ายกเลิกคำสั่งทางอีเมล');
    await ok.click();
    await expect(page.getByRole('status')).toContainText(`ยกเลิก ${o.soNo} แล้ว`);
    const after = await (await page.request.get(`/v1/orders/${o.id}`, { headers: H })).json();
    expect(after.status).toBe('cancelled');
    const dos = await (
      await page.request.get(`/v1/delivery-orders?orderId=${o.id}`, { headers: H })
    ).json();
    expect(dos.data.every((d: { status: string }) => d.status === 'CANCELLED')).toBe(true);
    // ยกเลิกแล้วไม่มีเมนูยกเลิกอีก
    await drawer.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await expect(page.getByRole('menuitem', { name: 'ยกเลิกเอกสาร' })).toHaveCount(0);
  });

  test('ต้นทางแก้หลังวางแผน: ตารางเทียบ TMS กับ KRS · รับค่าต้นทางขณะอยู่ในเที่ยว → แจ้งให้ถอดก่อน · ใช้ค่า TMS → ปลดธง', async ({
    page,
  }) => {
    const o = await newOrder(page);
    const dos = await (
      await page.request.get(`/v1/delivery-orders?orderId=${o.id}`, { headers: H })
    ).json();
    const t = await page.request.post('/v1/trips', {
      headers: H,
      data: {
        tripDate: new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10),
        deliveryOrderIds: [dos.data[0].id],
      },
    });
    expect(t.status(), await t.text()).toBe(201);
    // จำลองใบจาก connector KRS ที่ต้นทางเปลี่ยนปลายทางหลังวางแผน (สิ่งที่ upsertOrder เก็บไว้)
    const id = hex(o.id);
    const cur = await db.salesOrder.findUniqueOrThrow({ where: { id } });
    const changes = [
      {
        group: 'stops',
        field: 'stops[1].siteId',
        before: B,
        after: `คลังปลายทางใหม่ ลาดกระบัง ${RUN}`,
        kind: 'text',
      },
    ];
    await db.salesOrder.update({
      where: { id },
      data: {
        source: 'CONNECTOR',
        sourceConnector: 'krs',
        externalId: `KRS-E2E-${RUN}`,
        sourceChangedAfterPlan: true,
        sourceDiff: changes,
        version: { increment: 1 },
      },
    });
    await db.orderSourceChange.create({
      data: {
        tenantId: cur.tenantId,
        salesOrderId: id,
        source: 'CONNECTOR',
        sourceConnector: 'krs',
        orderStatus: 'PLANNED',
        baseVersion: cur.version,
        input: {},
        inputHash: `e2e-${RUN}`,
        changes,
      },
    });

    await page.goto('/so');
    const row = page.getByRole('row', { name: new RegExp(o.soNo) });
    await expect(row.getByText('ต้นทางแก้หลังวางแผน')).toBeVisible();
    await row.click();
    const drawer = page.getByRole('dialog').first();
    await expect(drawer.getByRole('alert')).toContainText('ระบบยังไม่เขียนทับ');
    await expect(drawer.getByText('เทียบข้อมูล TMS กับ KRS')).toBeVisible();
    await expect(drawer.getByText('ต่าง 1 ฟิลด์')).toBeVisible();
    await expect(drawer.getByText('จุดที่ 2 · สถานที่')).toBeVisible();
    await expect(drawer.getByText(`คลังปลายทางใหม่ ลาดกระบัง ${RUN}`)).toBeVisible();

    // รับค่าต้นทาง ขณะ DO อยู่ในเที่ยว → 409 order_on_trip แสดงใน dialog
    await drawer.getByRole('button', { name: 'รับค่า KRS' }).click();
    let dlg = page.getByRole('dialog', { name: `รับค่า KRS · ${o.soNo}` });
    await dlg.getByRole('textbox').fill('ลูกค้ายืนยันเปลี่ยนจุดส่งทางโทรศัพท์');
    await dlg.getByRole('button', { name: 'รับค่า KRS' }).click();
    await expect(dlg.getByText('ถอดออกจากเที่ยวก่อน', { exact: false })).toBeVisible();
    await dlg.getByRole('button', { name: 'ยกเลิก', exact: true }).click();

    // ใช้ค่า TMS
    await drawer.getByRole('button', { name: 'ใช้ค่า TMS' }).click();
    dlg = page.getByRole('dialog', { name: `ใช้ค่า TMS · ${o.soNo}` });
    await expect(dlg.getByText(`คลังปลายทางใหม่ ลาดกระบัง ${RUN}`)).toBeVisible();
    await dlg.getByRole('textbox').fill('ลูกค้าแจ้งว่าใช้ปลายทางเดิม');
    await dlg.getByRole('button', { name: 'ใช้ค่า TMS' }).click();
    await expect(page.getByRole('status')).toContainText(`ใช้ค่า TMS ${o.soNo} แล้ว`);
    await expect(drawer.getByText('เทียบข้อมูล TMS กับ KRS')).toHaveCount(0);
    const after = await (await page.request.get(`/v1/orders/${o.id}`, { headers: H })).json();
    expect(after).toMatchObject({
      status: 'planned',
      sourceChangedAfterPlan: false,
      sourceChange: null,
    });
  });
});
