import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test, trustedDeviceHeaders } from './fixtures';

/**
 * E2E ST5-T13 รับชำระ + เช็ค (บัญชีเบา D-54 · ไม่ออกใบเสร็จ D-56 · D-57) — ต้นแบบ TMS v4 หน้า `pay` + drawer 'pay':
 * ใบแจ้งหนี้ค่าขนส่ง 1,750.00 (ยกเว้น VAT · WHT 1% ประมาณการ 17.50) → รับบางส่วน → ชำระบางส่วน → รับเต็มที่เหลือ + WHT 1% → ชำระแล้ว →
 * กลับรายการ (เหตุผล) → ยอดค้างกลับมา → รับด้วยเช็ค (เลข/ธนาคาร/วันที่) → เช็คคืน → ยอดค้างกลับมา · เตรียมข้อมูลผ่าน /v1 จริง · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** เลขผู้เสียภาษี 13 หลักที่ checksum ถูก */
function taxId(seed: number): string {
  const base = String(3_000_000_000_00 + seed).slice(-12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

/** login ผ่าน API ด้วย request context ที่ให้มา (ใช้ context แยกจากหน้า — ไม่ทับ session ของเบราว์เซอร์) */
async function token(rq: APIRequestContext, email: string): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await rq.post('/v1/auth/login', {
    headers: trustedDeviceHeaders(email), // D-78
    data: {
      email,
      password: 'demo-password-2569',
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
  });
  const { code } = (await r1.json()) as { code: string };
  const r2 = await rq.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  });
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

test.describe.serial('รับชำระ + เช็ค (ST5-T13)', () => {
  test.describe.configure({ timeout: 420_000 });
  const custName = `ลูกค้ารับชำระ ${RUN}`;
  let ready = false;
  let invNo = '';

  test.beforeEach(async ({ page, request }) => {
    if (ready) return;
    // เจ้าของ: request ของหน้า (cookie อุปกรณ์ที่จำไว้ข้าม 2FA) · ผู้ออกบิล: request context แยก (ไม่ทับ session ของเบราว์เซอร์)
    const H = { Authorization: `Bearer ${await token(page.request, 'owner@demo-a.test')}` };
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
      legalName: custName,
      taxId: taxId(Number(RUN) + 7),
      branchCode: '00000',
      billingAddress: {
        line1: '9 ถนนทดสอบ',
        district: 'เมือง',
        province: 'ชลบุรี',
        postcode: '20000',
      },
      billingCompanyId: company,
      requirePodToBill: false,
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังรับชำระ ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทางรับชำระ ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const rc = await post<{ id: string }>('/v1/rate-cards', {
      customerId: cust.body.id,
      originId: a.body.id,
      destinationId: b.body.id,
      vehicleTypeId: vt6,
      validFrom: today,
      pricingModel: 'PER_TON',
      sellRate: '350',
    });
    await post(`/v1/rate-cards/${rc.body.id}/approve`, { reason: 'อนุมัติตามใบเสนอราคา' });
    const veh = await post<{ id: string }>('/v1/vehicles', {
      plate: `8${RUN.slice(0, 1)}-${RUN.slice(2)}`,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    await post('/v1/drivers', {
      name: `คนขับรับชำระ ${RUN}`,
      phone: `084-${RUN.slice(0, 3)}-${RUN.slice(3)}0`,
      employmentType: 'EMPLOYEE_SALARIED',
      licenceClass: 'T2',
      licenceExpiresOn: '2030-03-31',
      defaultVehicleId: veh.body.id,
    });
    const so = await post<{ id: string }>('/v1/orders', {
      customer: { id: cust.body.id },
      requestedDate: today,
      vehicleTypeId: vt6,
      stops: [
        { type: 'PICKUP', siteId: a.body.id },
        { type: 'DELIVERY', siteId: b.body.id },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: '5000' }],
    });
    const d0 = (await get<Page1>(`/v1/delivery-orders?orderId=${so.body.id}`)).data[0]!;
    const t0 = await post<{ id: string }>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [d0.id],
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
    const trip = await get<{ stops: { id: string; type: string }[] }>(`/v1/trips/${t0.body.id}`);
    const pk = trip.stops.find((s) => s.type === 'PICKUP')!;
    const dr = trip.stops.find((s) => s.type === 'DELIVERY')!;
    const ev = (min: number, extra = {}) => ({
      clientEventId: randomUUID(),
      occurredAt: ago(min),
      ...extra,
    });
    await post(`/v1/stops/${pk.id}/arrive`, ev(90));
    await post(`/v1/stops/${pk.id}/complete`, ev(80, { outcome: 'DELIVERED' }));
    await post(`/v1/stops/${dr.id}/arrive`, ev(40));
    await post(`/v1/stops/${dr.id}/complete`, ev(30, { outcome: 'DELIVERED' }));
    // ร่างโดยผู้ออกบิล (invoicer) — ส่งบัญชี + สร้างร่างในคำขอเดียว
    const inv = { Authorization: `Bearer ${await token(request, 'invoicer@demo-a.test')}` };
    const r = await request.post('/v1/invoices', {
      headers: inv,
      data: { customerId: cust.body.id, deliveryOrderIds: [d0.id], releaseDeliveryOrders: true },
    });
    expect(r.status(), await r.text()).toBe(201);
    // เจ้าของออกเอกสาร (แบ่งหน้าที่ A3 — ผู้สร้างร่างคือผู้ออกบิล)
    const draft = (await r.json()) as { id: string; version: number };
    const fin = await page.request.post(`/v1/invoices/${draft.id}/finalize`, {
      headers: { ...H, 'If-Match': `"${draft.version}"` },
    });
    expect(fin.status(), await fin.text()).toBe(200);
    invNo = ((await fin.json()) as { invoiceNo: string }).invoiceNo;
    ready = true;
  });

  /** เปิด drawer รับชำระของใบนี้จากหน้า "รับชำระ" */
  async function openPay(page: Page) {
    await page.goto('/pay');
    const row = page.locator('tbody tr').filter({ hasText: invNo });
    await row.click();
    const d = page.getByRole('dialog');
    await expect(d.getByText(invNo).first()).toBeVisible();
    return d;
  }
  const status = (page: Page) => page.locator('tbody tr').filter({ hasText: invNo });

  test('รับบางส่วน → ชำระบางส่วน · รับที่เหลือ + WHT 1% → ชำระแล้ว · กลับรายการ → ยอดค้างกลับมา', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/pay');
    await expect(status(page)).toContainText('ออกแล้ว');
    await expect(page.getByRole('button', { name: /ยอดค้างรับ/ })).not.toContainText('—');
    await page.screenshot({ path: 'test-results/st5-t13-pay-page-actual-1440.png' });
    const d = await openPay(page);
    await expect(d.getByText('ไม่ออกใบเสร็จ')).toHaveCount(0);
    await expect(d.getByText(/ออกใบเสร็จ/)).toHaveCount(0);
    await page.screenshot({ path: 'test-results/st5-t13-pay-drawer-actual-1440.png' });
    // บางส่วน: 1,000.00 ไม่หัก WHT
    await d.getByRole('radio', { name: 'บางส่วน' }).click();
    await d.getByLabel('จำนวนเงินที่รับ (฿)').fill('1000');
    await d.getByLabel(/ลูกค้าหักภาษี ณ ที่จ่าย/).uncheck();
    await d.getByRole('button', { name: 'บันทึกรับชำระ' }).click();
    await expect(page.getByText(`บันทึกรับชำระ ${invNo} แล้ว · คงเหลือ ฿750.00`)).toBeVisible();
    await expect(d.getByText('ชำระบางส่วน').first()).toBeVisible();
    await expect(d.getByTestId('pay-history')).toContainText('1,000.00');
    // เต็มจำนวนที่เหลือ: WHT 1% ประมาณการ 17.50 → รับเงิน 732.50
    await d.getByRole('radio', { name: 'เต็มจำนวน' }).click();
    await expect(d.getByLabel('ยอดที่ลูกค้าหัก (฿)')).toHaveValue('17.50');
    await expect(d.getByLabel('จำนวนเงินที่รับ (฿)')).toHaveValue('732.50');
    await d.getByLabel('เลขที่หนังสือรับรอง 50 ทวิ').fill('2569/0412');
    await d.getByRole('button', { name: 'บันทึกรับชำระ' }).click();
    await expect(page.getByText(`บันทึกรับชำระ ${invNo} แล้ว`, { exact: true })).toBeVisible();
    await expect(d.getByText('ชำระแล้ว').first()).toBeVisible();
    await expect(d.getByRole('button', { name: 'บันทึกรับชำระ' })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/st5-t13-pay-paid-actual-1440.png' });
    // กลับรายการรายการล่าสุด (เหตุผล) → ยอดค้าง 750.00 กลับมา
    await d.getByRole('button', { name: 'กลับรายการ' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'กลับรายการรับชำระ' });
    await dlg.getByRole('textbox').fill('บันทึกยอดผิด ลูกค้ายังไม่ได้โอน');
    await dlg.getByRole('button', { name: 'กลับรายการ' }).click();
    await expect(page.getByText(/^กลับรายการ PAY-\d{4}-\d{4} แล้ว/)).toBeVisible();
    await expect(d.getByText('ชำระบางส่วน').first()).toBeVisible();
    await expect(d.getByRole('button', { name: 'บันทึกรับชำระ' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(status(page)).toContainText('ชำระบางส่วน');
    await expect(status(page)).toContainText('750.00');
  });

  test('รับด้วยเช็ค (เลขที่/ธนาคาร/วันที่หน้าเช็ค) → เช็คคืน = กลับรายการ ยอดค้างกลับมา', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const d = await openPay(page);
    await d.getByLabel('วิธีรับ').selectOption({ label: 'เช็ค' });
    await d.getByRole('button', { name: 'บันทึกรับชำระ' }).click();
    await expect(page.getByText('กรอกเลขที่เช็ค ธนาคาร และวันที่หน้าเช็ค')).toBeVisible();
    await d.getByLabel('เลขอ้างอิง / เลขที่เช็ค').fill('0012345');
    await d.getByLabel('ธนาคารของเช็ค').fill('กสิกรไทย สาขาบางนา');
    await page.screenshot({ path: 'test-results/st5-t13-pay-cheque-actual-1440.png' });
    await d.getByRole('button', { name: 'บันทึกรับชำระ' }).click();
    await expect(page.getByText(`บันทึกรับชำระ ${invNo} แล้ว`, { exact: true })).toBeVisible();
    await expect(d.getByText('ชำระแล้ว').first()).toBeVisible();
    const hist = d.getByTestId('pay-history');
    await expect(hist).toContainText('0012345 · กสิกรไทย สาขาบางนา');
    await expect(hist).toContainText('รอเคลียร์');
    await hist.getByRole('button', { name: 'เช็คคืน' }).click();
    const dlg = page.getByRole('dialog', { name: 'บันทึกเช็คคืน' });
    await dlg.getByRole('textbox').fill('เช็คคืน เงินในบัญชีไม่พอจ่าย');
    await dlg.getByRole('button', { name: 'เช็คคืน' }).click();
    await expect(page.getByText(/^บันทึกเช็คคืน PAY-\d{4}-\d{4} แล้ว/)).toBeVisible();
    await expect(hist).toContainText('เช็คคืน');
    await expect(d.getByText('ชำระบางส่วน').first()).toBeVisible();
    // drawer ใบแจ้งหนี้: รับแล้ว 1,000.00 · คงค้าง 750.00 · "รับชำระแล้ว" เฉพาะที่ยังไม่กลับรายการ · ปุ่มบันทึกรับชำระ (ต้นแบบ)
    await d.getByRole('button', { name: 'ดูใบแจ้งหนี้' }).click();
    const inv = page.getByRole('dialog');
    await expect(inv.getByText('รับชำระแล้ว')).toBeVisible();
    await expect(inv.getByRole('button', { name: 'บันทึกรับชำระ' })).toBeVisible();
    await expect(inv.getByText('ฐาน VAT 7%')).toBeVisible();
    await page.screenshot({ path: 'test-results/st5-t13-inv-drawer-actual-1440.png' });
  });
});
