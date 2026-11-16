import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { DEMO_EMAIL, DEMO_PASSWORD, expect, test } from './fixtures';

/**
 * E2E ST3-T07 หน้าใบค้าง (/so/hold) — ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 * เกณฑ์ตรวจรับ: ใบ CUSTOMER_UNMAPPED เคลียร์จากหน้านี้แล้วกลับ "รับคำสั่งแล้ว" (หายจากตาราง)
 * + "กำหนดราคาเอง" (ORD-043) เคลียร์ RATE_MISSING · สถานะว่าง (ไม่มีใบค้าง)
 */
const RUN = String(Date.now()).slice(-6);
const CUST = `ลูกค้าใบค้างอีทูอี ${RUN}`;

/** access token ของผู้ใช้เดโม (เรียก /v1 ตรงเพื่อเตรียมข้อมูล) */
async function token(page: Page): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await page.request.post('/v1/auth/login', {
    data: {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
  });
  const { code } = (await r1.json()) as { code: string };
  const r2 = await page.request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  });
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

test.describe.serial('หน้าใบค้าง (ST3-T07)', () => {
  let ids:
    | { cust: string; a: string; b: string; c: string; vt: string; unit: string; company: string }
    | undefined;
  let H: Record<string, string> = {};

  const call = async (page: Page, method: 'get' | 'post', path: string, data?: object) => {
    if (!H.Authorization) H = { Authorization: `Bearer ${await token(page)}` };
    const r = await page.request[method](path, { headers: H, ...(data ? { data } : {}) });
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
    return r.json();
  };

  /** ลูกค้า + สถานที่ 3 แห่ง + rate card A→B (อนุมัติแล้ว) — B→C ไม่มี rate */
  const setup = async (page: Page) => {
    H = {}; // token ใหม่ทุก test (ผู้ใช้ login ใหม่ใน fixture)
    if (ids) return ids;
    const company = (await call(page, 'get', '/v1/companies?status=active&limit=1')).data[0].id;
    const cust = (
      await call(page, 'post', '/v1/customers', { legalName: CUST, billingCompanyId: company })
    ).id as string;
    const site = async (name: string) =>
      (
        await call(page, 'post', '/v1/customer-sites', {
          name,
          kind: 'DROPOFF',
          address: { line1: name },
          customerId: cust,
        })
      ).id as string;
    const a = await site(`คลังใบค้าง ก ${RUN}`);
    const b = await site(`ร้านใบค้าง ข ${RUN}`);
    const c = await site(`ร้านใบค้าง ค ${RUN}`);
    const vt = (
      (await call(page, 'get', '/v1/vehicle-types?limit=50')).data as { id: string; code: string }[]
    ).find((v) => v.code === '6W')!.id;
    const unit = (
      (await call(page, 'get', '/v1/units?limit=50')).data as { id: string; code: string }[]
    ).find((u) => u.code === 'TON')!.id;
    const day = new Date(Date.now() + 7 * 3600_000 - 30 * 86400_000).toISOString().slice(0, 10);
    const rc = await call(page, 'post', '/v1/rate-cards', {
      customerId: cust,
      originId: a,
      destinationId: b,
      vehicleTypeId: vt,
      validFrom: day,
      pricingModel: 'PER_TRIP',
      sellRate: '3800',
    });
    await call(page, 'post', `/v1/rate-cards/${rc.id}/approve`, { reason: 'อนุมัติตามใบเสนอราคา' });
    ids = { cust, a, b, c, vt, unit, company };
    return ids;
  };

  const newOrder = async (page: Page, customer: object, from: string, to: string) => {
    const s = await setup(page);
    const o = await call(page, 'post', '/v1/orders', {
      customer,
      billingCompanyId: s.company,
      requestedDate: new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10),
      vehicleTypeId: s.vt,
      stops: [
        { type: 'PICKUP', siteId: from },
        { type: 'DELIVERY', siteId: to },
      ],
      lines: [{ description: 'น้ำดื่มขวด', qty: '10', unitId: s.unit, weightKg: '10000' }],
    });
    expect(o.status).toBe('on_hold');
    return o as { id: string; soNo: string };
  };

  test('ยังไม่จับคู่ลูกค้า: อยู่ในตารางใบค้าง → จับคู่ลูกค้าใน drawer → กลับ "รับคำสั่งแล้ว" และหายจากตาราง', async ({
    page,
  }) => {
    const s = await setup(page);
    const o = await newOrder(
      page,
      { externalId: `NSF-${RUN}`, name: 'ลูกค้าจากระบบต้นทาง' },
      s.a,
      s.b,
    );
    await page.goto('/so/hold');
    await expect(page.getByRole('heading', { name: 'ใบค้าง' })).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(o.soNo) });
    await expect(row).toContainText('ยังไม่จับคู่ลูกค้า');
    await row.getByRole('button', { name: 'จับคู่ลูกค้า' }).click();
    const drawer = page.locator('aside.tms-drawer');
    await expect(drawer.getByText(o.soNo, { exact: true })).toBeVisible();
    await expect(drawer.getByText(/ไม่พบลูกค้า "ลูกค้าจากระบบต้นทาง"/)).toBeVisible();
    await drawer.getByRole('combobox').click();
    await drawer.getByRole('combobox').fill(CUST);
    await drawer.getByRole('option', { name: new RegExp(CUST) }).click();
    await drawer.getByRole('button', { name: 'จับคู่ลูกค้า' }).click();
    await expect(page.getByText(`${o.soNo} กลับไปรอจัดรถแล้ว`)).toBeVisible();
    const after = await call(page, 'get', `/v1/orders/${o.id}`);
    expect(after).toMatchObject({ status: 'received', holdReason: null });
    await page.getByRole('button', { name: 'ปิด' }).first().click();
    await expect(page.getByRole('row', { name: new RegExp(o.soNo) })).toHaveCount(0);
  });

  test('ไม่มี rate card: "กำหนดราคาเอง" ในส่วนราคา → ช่องราคา → เหตุผล → กลับ "รับคำสั่งแล้ว" ป้าย "ค่าขนส่ง (กำหนดเอง)"', async ({
    page,
  }) => {
    const s = await setup(page);
    const o = await newOrder(page, { id: s.cust }, s.b, s.c);
    await page.goto('/so/hold');
    const row = page.getByRole('row', { name: new RegExp(o.soNo) });
    await expect(row).toContainText('ยังไม่มีราคาขาย');
    await row.getByRole('button', { name: 'กำหนดราคาเอง' }).click();
    const drawer = page.locator('aside.tms-drawer');
    await expect(drawer.getByText(o.soNo, { exact: true })).toBeVisible();
    await expect(drawer.getByText('ไม่พบ rate card ของลูกค้านี้สำหรับเส้นทางนี้')).toBeVisible();
    await expect(drawer.getByText(/เปิดหน้า Rate card/)).toHaveCount(0);
    await drawer.getByRole('button', { name: 'กำหนดราคาเอง' }).click();
    await drawer.getByRole('textbox', { name: 'ค่าขนส่ง (บาท)' }).fill('4,250');
    await drawer.getByRole('button', { name: 'บันทึกราคา' }).click();
    const dlg = page.getByRole('dialog', { name: `กำหนดราคาเอง ${o.soNo}` });
    await expect(dlg.getByRole('cell', { name: '4,250.00' })).toBeVisible();
    await dlg.getByRole('textbox').fill('ลูกค้ารายใหม่ ตกลงราคาทางโทรศัพท์');
    await dlg.getByRole('button', { name: 'บันทึกราคา' }).click();
    await expect(page.getByText(`กำหนดราคา ${o.soNo} แล้ว`)).toBeVisible();
    await expect(drawer.getByText('ค่าขนส่ง (กำหนดเอง)')).toBeVisible();
    const after = await call(page, 'get', `/v1/orders/${o.id}`);
    expect(after).toMatchObject({ status: 'received', holdReason: null, sellTotal: '4250.00' });
    expect(after.sellCharges).toEqual([expect.objectContaining({ origin: 'MANUAL' })]);
  });

  test('ไม่มีใบค้าง → สถานะว่าง "ไม่มีใบค้าง"', async ({ page }) => {
    // ฐาน e2e ใช้ร่วมกับ spec อื่น (อาจมีใบค้างค้างอยู่) → จำลองผลรายการว่างของ held=true เฉพาะหน้านี้
    await page.route(/\/v1\/orders\?.*held=true/, (route) =>
      route.fulfill({ json: { data: [], nextCursor: null, hasMore: false } }),
    );
    await page.goto('/so/hold');
    await expect(page.getByText('ไม่มีใบค้าง')).toBeVisible();
    await expect(page.getByText('ใบสั่งขนส่งทุกใบพร้อมจัดรถแล้ว')).toBeVisible();
  });
});
