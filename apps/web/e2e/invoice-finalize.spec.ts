import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { expect, test, trustedDeviceHeaders } from './fixtures';

/**
 * E2E ST5-T09 ออกเอกสารใบแจ้งหนี้ (D-54: ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี) — ต้นแบบ TMS v4 drawer `inv` ปุ่ม "ออกเอกสาร" (issueInv):
 * ร่างที่ผู้ออกบิล (invoicer) สร้าง → เจ้าของเปิด drawer → ออกเอกสาร → ได้เลข + ล็อก (kv ออกเมื่อ/ครบกำหนด, footer คงค้าง, PDF ที่เก็บ)
 * แบ่งหน้าที่ (A3): ผู้สร้างร่างออกเองไม่ได้ จึงให้อีกคนสร้างร่าง · เตรียมข้อมูลผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
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

test.describe.serial('ออกเอกสารใบแจ้งหนี้ (ST5-T09)', () => {
  test.describe.configure({ timeout: 420_000 });
  const custName = `ลูกค้าออกใบ ${RUN}`;
  let ready = false;

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
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังออกใบ ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทางออกใบ ${RUN}`,
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
      plate: `9${RUN.slice(0, 1)}-${RUN.slice(2)}`,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    await post('/v1/drivers', {
      name: `คนขับออกใบ ${RUN}`,
      phone: `083-${RUN.slice(0, 3)}-${RUN.slice(3)}0`,
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
    ready = true;
  });

  test('drawer ร่าง → ออกเอกสาร → ได้เลข INV + ล็อก · ออกเมื่อ/ครบกำหนด · คงค้าง · PDF ที่เก็บ', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/bill');
    const row = page.locator('tbody tr').filter({ hasText: custName }).last();
    await row.click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('ร่าง (ยังไม่มีเลข)').first()).toBeVisible();
    const btn = d.getByRole('button', { name: 'ออกเอกสาร' });
    await expect(btn).toBeEnabled();
    await btn.click();
    const toast = page.getByText(/^ออก INV-00000-\d{4}-\d{4} แล้ว · เอกสารถูกล็อก$/);
    await expect(toast).toBeVisible();
    const no = (await toast.textContent())!.match(/INV-00000-\d{4}-\d{4}/)![0];
    await expect(d.getByText(no).first()).toBeVisible();
    await expect(d.getByText('ออกแล้ว · แก้ไขไม่ได้')).toBeVisible();
    await expect(d.getByText('ครบกำหนดชำระ')).toBeVisible();
    await expect(d.getByText('ออกเมื่อ')).toBeVisible();
    await expect(d.getByText('คงค้าง').first()).toBeVisible();
    await expect(d.getByText('ใบกำกับภาษี')).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'ออกเอกสาร' })).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'ยกเลิกร่าง' })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/st5-t09-drawer-actual-1440.png' });
    // ท้ายแท็บสรุป: ยอดเงิน + รับแล้ว/คงค้าง + แถบล็อก (ตำแหน่งตามต้นแบบ)
    await page.mouse.move(1140, 500);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/st5-t09-drawer-bottom-actual-1440.png' });
    // แท็บเอกสารแนบ = PDF ต้นฉบับที่เก็บ ณ วันออก (เปิดแท็บใหม่)
    await d.getByRole('tab', { name: 'เอกสารแนบ' }).click();
    const pdf = d.getByRole('button', { name: new RegExp(`${no}\\.pdf`) });
    await expect(pdf).toBeVisible();
    const popup = page.waitForEvent('popup');
    await pdf.click();
    await (await popup).close();
    // กิจกรรม: ขั้น "ออกเอกสารและล็อก" สำเร็จ
    await d.getByRole('tab', { name: 'กิจกรรม' }).click();
    await expect(d.getByText('ออกเอกสารและล็อก').first()).toBeVisible();
    // ตาราง: สถานะ "ออกแล้ว" + ครบกำหนด
    await page.keyboard.press('Escape');
    await expect(page.locator('tbody tr').filter({ hasText: no })).toContainText('ออกแล้ว');
  });
});
