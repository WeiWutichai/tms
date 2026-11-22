import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { expect, test, trustedDeviceHeaders } from './fixtures';

/**
 * E2E ST5-T11 ใบวางบิล (D-54: ไม่ใช่เอกสารภาษี) — เกณฑ์ตรวจรับ:
 * (1) รวม 3 ใบแจ้งหนี้เป็นใบวางบิล 1 ใบ ยอดรวมตรง (หน้า "วางบิลและใบแจ้งหนี้": ติ๊กใบที่ออกแล้ว → "สร้างใบวางบิล" → วันนัดรับเช็ค → ร่าง → ออกเอกสาร)
 * (2) ใบแจ้งหนี้เดียวอยู่ 2 ใบวางบิลที่ active ไม่ได้ (API 409 `invoice_already_billed`)
 * เตรียมข้อมูลผ่าน /v1 จริง (ฐาน e2e): 3 DO ส่งแล้ว → ผู้ออกบิลสร้างร่าง 3 ใบ → เจ้าของออกเอกสาร (แบ่งหน้าที่ A3) · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const plus = (n: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function taxId(seed: number): string {
  const base = String(3_100_000_000_00 + seed).slice(-12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

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

test.describe.serial('ใบวางบิล (ST5-T11)', () => {
  test.describe.configure({ timeout: 600_000 });
  const custName = `ลูกค้าวางบิล ${RUN}`;
  let custId = '';
  let H: Record<string, string> = {};
  const invoices: { id: string; invoiceNo: string; sellTotal: string }[] = [];

  let ready = false;

  test.beforeEach(async ({ page, request }) => {
    if (ready) return;
    // เจ้าของ: request ของหน้า (cookie อุปกรณ์ที่จำไว้ข้าม 2FA) · ผู้ออกบิล: request context แยก (ไม่ทับ session ของเบราว์เซอร์)
    const rq = page.request;
    H = { Authorization: `Bearer ${await token(rq, 'owner@demo-a.test')}` };
    // ผู้สร้างร่างใบแจ้งหนี้ = ผู้ออกบิล (เจ้าของออกเอกสาร — แบ่งหน้าที่ A3)
    const INV = { Authorization: `Bearer ${await token(request, 'invoicer@demo-a.test')}` };
    const get = async <X>(path: string) => (await (await rq.get(path, { headers: H })).json()) as X;
    const post = async <X>(path: string, data: object, ok = true, h = H) => {
      const r = await rq.post(path, { headers: { ...h, 'Idempotency-Key': randomUUID() }, data });
      if (ok) expect(r.status(), await r.text()).toBeLessThan(300);
      return { status: r.status(), body: (await r.json()) as X };
    };
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: custName,
      taxId: taxId(Number(RUN)),
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
    custId = cust.body.id;
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังวางบิล ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทางวางบิล ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const rc = await post<{ id: string }>('/v1/rate-cards', {
      customerId: custId,
      originId: a.body.id,
      destinationId: b.body.id,
      vehicleTypeId: vt6,
      validFrom: today,
      pricingModel: 'PER_TON',
      sellRate: '350',
    });
    await post(`/v1/rate-cards/${rc.body.id}/approve`, { reason: 'อนุมัติตามใบเสนอราคา' });
    for (let i = 0; i < 3; i++) {
      const veh = await post<{ id: string }>('/v1/vehicles', {
        plate: `8${i}-${RUN.slice(2)}`,
        plateProvince: 'TH-10',
        vehicleTypeId: vt6,
        ownership: 'OWN',
        payloadKg: 6000,
      });
      await post('/v1/drivers', {
        name: `คนขับวางบิล ${RUN}-${i}`,
        phone: `08${i}-${RUN.slice(0, 3)}-${RUN.slice(3)}${i}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: veh.body.id,
      });
      const so = await post<{ id: string }>('/v1/orders', {
        customer: { id: custId },
        requestedDate: today,
        vehicleTypeId: vt6,
        stops: [
          { type: 'PICKUP', siteId: a.body.id },
          { type: 'DELIVERY', siteId: b.body.id },
        ],
        lines: [{ description: 'ปูนซีเมนต์', qty: String(4 + i), unitId: ton, weightKg: '5000' }],
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
      const draft = await post<{ id: string; version: number }>(
        '/v1/invoices',
        { customerId: custId, deliveryOrderIds: [d0.id], releaseDeliveryOrders: true },
        true,
        INV,
      );
      const r = await rq.post(`/v1/invoices/${draft.body.id}/finalize`, {
        headers: { ...H, 'If-Match': `"${draft.body.version}"` },
      });
      expect(r.status(), await r.text()).toBe(200);
      invoices.push((await r.json()) as (typeof invoices)[number]);
    }
    ready = true;
  });

  test('ติ๊ก 3 ใบแจ้งหนี้ → สร้างใบวางบิล → ยอดรวมตรง → ออกเอกสาร (เลข BN + ล็อก) · ใบเดียวกันใส่ใบวางบิลที่ 2 ไม่ได้', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/bill');
    for (const inv of invoices)
      await page.getByRole('row').filter({ hasText: inv.invoiceNo }).getByRole('checkbox').check();
    await page.locator('.tms-bulk').getByRole('button', { name: 'สร้างใบวางบิล' }).click();
    const form = page.getByRole('dialog', { name: 'สร้างใบวางบิล' });
    for (const inv of invoices)
      await expect(form.getByRole('checkbox', { name: inv.invoiceNo })).toBeChecked();
    const sum = invoices.reduce((a, x) => a + Math.round(Number(x.sellTotal) * 100), 0) / 100;
    const baht = sum.toLocaleString('en-US', { minimumFractionDigits: 2 });
    await expect(form.getByText(`เลือก 3 ใบ`)).toBeVisible();
    await form.getByLabel('วันนัดรับเช็ค / โอน').fill(plus(7));
    await page.screenshot({ path: 'test-results/st5-t11-form-actual-1440.png' });
    await form.getByRole('button', { name: 'บันทึกร่าง' }).click();
    await expect(page.getByText('สร้างร่างใบวางบิลจาก 3 ใบแจ้งหนี้แล้ว')).toBeVisible();
    const d = page.getByRole('dialog');
    await expect(d.getByText('ร่าง (ยังไม่มีเลข)').first()).toBeVisible();
    await expect(d.getByTestId('bn-items').getByText(/^INV-/)).toHaveCount(3);
    await expect(d.getByText(`฿${baht}`).first()).toBeVisible();
    await expect(d.getByText('ใบกำกับภาษี')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/st5-t11-drawer-actual-1440.png' });
    await d.getByRole('button', { name: 'ออกเอกสาร' }).click();
    const toast = page.getByText(/^ออก BN-\d{4}-\d{4} แล้ว · เอกสารถูกล็อก$/);
    await expect(toast).toBeVisible();
    const no = (await toast.textContent())!.match(/BN-\d{4}-\d{4}/)![0];
    await expect(d.getByText('ออกแล้ว · แก้ไขไม่ได้')).toBeVisible();
    await expect(d.getByRole('button', { name: 'รับเช็ค / โอนแล้ว' })).toBeVisible();
    await page.screenshot({ path: 'test-results/st5-t11-issued-actual-1440.png' });
    // ยอดรวมจาก API = Σ ใบแจ้งหนี้ 3 ใบ
    const list = (await (
      await page.request.get(`/v1/billing-notes?customerId=${custId}&limit=10`, { headers: H })
    ).json()) as { data: { billingNoteNo: string; sellTotal: string; invoiceCount: number }[] };
    expect(list.data[0]).toMatchObject({
      billingNoteNo: no,
      sellTotal: sum.toFixed(2),
      invoiceCount: 3,
    });
    // ใบแจ้งหนี้เดียวอยู่ 2 ใบวางบิลที่ active ไม่ได้
    const dup = await page.request.post('/v1/billing-notes', {
      headers: H,
      data: { customerId: custId, invoiceIds: [invoices[1]!.id] },
    });
    expect(dup.status()).toBe(409);
    expect(((await dup.json()) as { code: string }).code).toBe('invoice_already_billed');
    // ตาราง: ประเภท "ใบวางบิล" → แถวใบวางบิลสถานะ "ออกแล้ว"
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: 'ประเภท' }).selectOption('BN');
    const row = page.locator('tbody tr').filter({ hasText: no });
    await expect(row).toContainText('ออกแล้ว');
    await expect(row).toContainText('3 ใบแจ้งหนี้');
    await page.screenshot({ path: 'test-results/st5-t11-list-actual-1440.png' });
  });
});
