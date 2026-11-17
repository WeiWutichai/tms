import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { DEMO_IDS, DEMO_TRUSTED_DEVICE, E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST4-T13 ค่าใช้จ่ายหน้างาน (docs/04 E2) — เกณฑ์ตรวจรับ:
 * เพิ่ม "ค่ารอ" 500 บาท → มีบรรทัดฝั่งขาย VAT_7 พร้อมรูป รอ Invoicer ยืนยัน → ผู้วางบิลยืนยันพร้อมเหตุผล
 * ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ · ค่ารอ VAT 7% = ค่าที่บริษัทตั้งในรายการ (ค่าเริ่มต้นของระบบยังรอนักบัญชี)
 */
const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const OWNER = 'owner@demo-a.test';
const INVOICER = 'invoicer@demo-a.test';
const ITEM = `ค่ารอคิว ${RUN}`;
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

async function login(page: Page, email: string): Promise<string> {
  if (DEMO_IDS[email])
    await page.context().addCookies([
      {
        name: 'tms_td',
        value: `${DEMO_TRUSTED_DEVICE}:${DEMO_IDS[email]}`,
        url: `${E2E_WEB}/v1/auth`,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
  const v = randomBytes(32).toString('base64url');
  const r1 = await page.request.post('/v1/auth/login', {
    data: {
      email,
      password: 'demo-password-2569',
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
  });
  expect(r1.status(), await r1.text()).toBe(200);
  const { code } = (await r1.json()) as { code: string };
  const r2 = await page.request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  });
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

type Trip = { id: string; tripNo: string; status: string; deliveryOrders: { doNo: string }[] };
type Line = {
  id: string;
  side: string;
  status: string;
  vatType: string;
  whtRate: string;
  description: string;
  sellAmount?: string;
  evidence: { id: string } | null;
  decidedByName: string | null;
};

test.describe.serial('ค่าใช้จ่ายหน้างาน: บันทึกค่ารอพร้อมรูป → ผู้วางบิลยืนยัน (ST4-T13)', () => {
  let H: Record<string, string>;
  let trip: Trip | undefined;
  let soNo = '';

  const lines = async (page: Page) =>
    (
      (await (
        await page.request.get(`/v1/trips/${trip!.id}/field-charges`, { headers: H })
      ).json()) as { data: Line[] }
    ).data;

  const openTab = async (page: Page) => {
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: trip!.tripNo }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('เที่ยวรถ / ใบคุมรถ')).toBeVisible();
    await d.getByRole('tab', { name: 'ค่าใช้จ่ายหน้างาน' }).click();
    await expect(d.getByRole('heading', { name: 'ค่าใช้จ่ายหน้างาน' })).toBeVisible();
    return d;
  };

  test.beforeEach(async ({ page, loginEmail }) => {
    H = { Authorization: `Bearer ${await login(page, OWNER)}` };
    if (!trip) {
      const get = async <X>(path: string) =>
        (await (await page.request.get(path, { headers: H })).json()) as X;
      const post = async <X>(path: string, data: object, ok = true) => {
        const r = await page.request.post(path, {
          headers: { ...H, 'Idempotency-Key': randomUUID() },
          data,
        });
        if (ok) expect(r.status(), await r.text()).toBeLessThan(300);
        return { status: r.status(), body: (await r.json()) as X };
      };
      type Page1 = { data: { id: string; code?: string }[] };
      const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
      const cust = await post<{ id: string }>('/v1/customers', {
        legalName: `ลูกค้าค่ารอ ${RUN}`,
        billingCompanyId: company,
      });
      const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
      const a = await post<{ id: string }>('/v1/customer-sites', {
        name: `คลังค่ารอ ${RUN}`,
        kind: 'PICKUP',
        address: addr('สมุทรปราการ'),
      });
      const b = await post<{ id: string }>('/v1/customer-sites', {
        name: `ปลายทางค่ารอ ${RUN}`,
        kind: 'DROPOFF',
        address: addr('ชลบุรี'),
      });
      const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
      const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
        (x) => x.code === '6W',
      )!.id;
      const veh = await post<{ id: string }>('/v1/vehicles', {
        plate: `8${RUN.slice(0, 1)}-${RUN.slice(2)}`,
        plateProvince: 'TH-10',
        vehicleTypeId: vt6,
        ownership: 'OWN',
        payloadKg: 6000,
      });
      await post('/v1/drivers', {
        name: `คนขับค่ารอ ${RUN}`,
        phone: `084-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: veh.body.id,
      });
      // ค่าบริการเสริมที่บริษัทตั้งเป็น VAT 7% / หัก 3% (ธงภาษีของบรรทัด = snapshot จากรายการนี้)
      await post('/v1/service-items', {
        name: ITEM,
        calcUnit: 'PER_HOUR',
        defaultPrice: '200.00',
        vatType: 'VAT_7',
        whtRate: '3.00',
        side: 'BOTH',
        isSurcharge: true,
      });
      const so = await post<{ id: string; soNo: string }>('/v1/orders', {
        customer: { id: cust.body.id },
        requestedDate: today,
        vehicleTypeId: vt6,
        stops: [
          { type: 'PICKUP', siteId: a.body.id },
          { type: 'DELIVERY', siteId: b.body.id },
        ],
        lines: [{ description: 'ปูนซีเมนต์', qty: '1', unitId: ton, weightKg: '1500' }],
      });
      soNo = so.body.soNo;
      const doId = (await get<Page1>(`/v1/delivery-orders?orderId=${so.body.id}`)).data[0]!.id;
      const t0 = await post<Trip>('/v1/trips', {
        tripDate: today,
        deliveryOrderIds: [doId],
        vehicleId: veh.body.id,
      });
      type Warn = { warnings?: { key: string }[] };
      let asg = await post<Warn>(
        `/v1/trips/${t0.body.id}/assign`,
        { vehicleId: veh.body.id, dispatch: true },
        false,
      );
      if (asg.status === 409 && asg.body.warnings)
        asg = await post<Warn>(`/v1/trips/${t0.body.id}/assign`, {
          vehicleId: veh.body.id,
          dispatch: true,
          ruleKeys: asg.body.warnings.map((w) => w.key),
          overrideReason: 'ข้อมูลทดสอบ ยืนยันคำเตือนก่อนปล่อยรถ',
        });
      expect(asg.status).toBeLessThan(300);
      trip = await get<Trip>(`/v1/trips/${t0.body.id}`);
      expect(trip.status).toBe('DISPATCHED');
    }
    // หน้าเว็บใช้ผู้ใช้ของ test นี้ (fixture login ไว้แล้ว — login เจ้าของด้านบนเปลี่ยน cookie จึง login กลับ)
    if (loginEmail !== OWNER) await login(page, loginEmail);
  });

  test('เกณฑ์ตรวจรับ: เพิ่ม "ค่ารอ" 500 บาท พร้อมรูป → บรรทัดฝั่งขาย VAT_7 รอยืนยัน', async ({
    page,
  }) => {
    const d = await openTab(page);
    await expect(
      d.getByText('ยังไม่มีค่าใช้จ่ายหน้างาน เช่น ค่ารอคิว ค่าค้างคืน ค่าทางด่วน'),
    ).toBeVisible();
    await page.screenshot({ path: 'test-results/st4-surcharge-empty.png' });
    await d.getByRole('button', { name: 'เพิ่มรายการ' }).click();
    const draft = d.getByTestId('fc-draft');
    await expect(draft.getByRole('button', { name: 'เก็บเงินลูกค้า' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await draft.getByLabel('รายการ', { exact: true }).selectOption({ label: ITEM });
    await draft.getByLabel('จำนวนเงิน (บาท)').fill('500');
    await draft
      .getByLabel('อัปโหลดรูปใบเสร็จ')
      .setInputFiles({ name: 'receipt-wait.png', mimeType: 'image/png', buffer: PNG });
    await expect(draft.getByText('receipt-wait.png')).toBeVisible();
    await page.screenshot({ path: 'test-results/st4-surcharge-add.png' });
    await draft.getByRole('button', { name: 'บันทึกรายการ' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'บันทึกค่าใช้จ่ายหน้างานแล้ว' }),
    ).toBeVisible();

    const row = d.getByTestId('fc-line');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('รอยืนยัน');
    await expect(row).toContainText(`เก็บเงินลูกค้า · ${trip!.deliveryOrders[0]!.doNo}`);
    await expect(row.getByRole('link', { name: 'ดูใบเสร็จ' })).toBeVisible();
    await expect(row.getByLabel('จำนวนเงิน (บาท)')).toHaveValue('500.00');
    await expect(d.getByText('฿500.00')).toBeVisible();

    const [l] = await lines(page);
    expect(l).toMatchObject({
      side: 'SELL',
      status: 'PENDING_CONFIRM',
      vatType: 'VAT_7',
      whtRate: '3.00',
      description: ITEM,
      sellAmount: '500.00',
    });
    expect(l!.evidence).not.toBeNull();
  });

  test.describe('ผู้วางบิล', () => {
    test.use({ loginEmail: INVOICER });

    test('ยืนยันพร้อมเหตุผล → ยืนยันแล้ว (ชื่อผู้ยืนยันอยู่ในบรรทัด)', async ({ page }) => {
      const d = await openTab(page);
      const row = d.getByTestId('fc-line');
      await expect(row).toContainText('รอยืนยัน');
      // ผู้วางบิลไม่มีสิทธิ์แก้ราคาซื้อ แต่บันทึกฝั่งขายได้ → ปุ่มเพิ่มรายการยังอยู่
      await row.getByRole('button', { name: 'ยืนยัน' }).click();
      const dlg = page.getByRole('dialog', { name: 'ยืนยันค่าใช้จ่ายหน้างาน' });
      await dlg.getByRole('textbox').fill('ตรวจรูปแล้ว ลูกค้ายอมรับค่ารอคิว');
      await page.screenshot({ path: 'test-results/st4-surcharge-confirm.png' });
      await dlg.getByRole('button', { name: 'ยืนยัน' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'ยืนยันค่าใช้จ่ายหน้างานแล้ว' }),
      ).toBeVisible();
      await expect(row).toContainText('ยืนยันแล้ว');
      await expect(row).toContainText('ตรวจรูปแล้ว ลูกค้ายอมรับค่ารอคิว');
      await expect(row.getByRole('button', { name: 'ยืนยัน' })).toHaveCount(0);
      const [l] = await lines(page);
      expect(l).toMatchObject({ status: 'CONFIRMED', decidedByName: 'วางบิล ตัวอย่าง' });
    });
  });
});
