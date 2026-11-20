import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST5-T07 ร่างใบแจ้งหนี้ (D-54: ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี) — หน้า "วางบิลและใบแจ้งหนี้" ตามต้นแบบ TMS v4 `bill`:
 * เลือกลูกค้า → ติ๊ก DO จากคิวพร้อมวางบิล → ออกเอกสาร (= ส่งบัญชี + สร้างร่าง ไม่มีเลข) → drawer ร่าง → ยกเลิกร่างพร้อมเหตุผล
 * เตรียม DO ที่ส่งสำเร็จผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

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

test.describe.serial('ร่างใบแจ้งหนี้จากคิวพร้อมวางบิล (ST5-T07)', () => {
  test.describe.configure({ timeout: 420_000 });
  const custName = `ลูกค้าวางบิล ${RUN}`;
  let ready = false;

  test.beforeEach(async ({ page }) => {
    if (ready) return;
    const H = { Authorization: `Bearer ${await token(page)}` };
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
      billingCompanyId: company,
      requirePodToBill: false,
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    for (let i = 0; i < 2; i++) {
      const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
      const a = await post<{ id: string }>('/v1/customer-sites', {
        name: `คลังวางบิล ${RUN}-${i}`,
        kind: 'PICKUP',
        address: addr('สมุทรปราการ'),
      });
      const b = await post<{ id: string }>('/v1/customer-sites', {
        name: `ปลายทางวางบิล ${RUN}-${i}`,
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
        plate: `8${i}-${RUN.slice(2)}`,
        plateProvince: 'TH-10',
        vehicleTypeId: vt6,
        ownership: 'OWN',
        payloadKg: 6000,
      });
      await post('/v1/drivers', {
        name: `คนขับวางบิล ${RUN}-${i}`,
        phone: `084-${RUN.slice(0, 3)}-${String(2000 + i)}`,
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
    }
    ready = true;
  });

  test('ติ๊ก DO → ออกเอกสาร = ร่างไม่มีเลข · ยอดประมาณการ · ยกเลิกร่างพร้อมเหตุผล', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/bill');
    const card = page.getByTestId('bill-create');
    await card.getByLabel('ลูกค้า').selectOption({ label: custName });
    const rows = card.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(
      card.getByText('ค่าขนส่งยกเว้น VAT · บริการประกอบ VAT 7% · เครดิต 30 วัน'),
    ).toBeVisible();
    await card.getByLabel('เลือกทั้งหมด').check();
    await expect(card.getByText('3,500.00').first()).toBeVisible();
    await page.screenshot({
      path: 'test-results/st5-t07-bill-actual-1440.png',
      fullPage: true,
    });
    // พิมพ์ตัวอย่าง = PDF จาก DO ที่ติ๊ก ไม่บันทึกอะไร (review M2) — แท็บใหม่ · DO ยังอยู่ในคิว
    const popup = page.waitForEvent('popup');
    await card.getByRole('button', { name: 'พิมพ์ตัวอย่าง' }).click();
    await (await popup).close();
    await expect(rows).toHaveCount(2);
    await card.getByRole('button', { name: 'ออกเอกสาร' }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('ร่าง (ยังไม่มีเลข)').first()).toBeVisible();
    await expect(d.getByText('ใบกำกับภาษี')).toHaveCount(0);
    await expect(d.getByText('2 รายการ')).toBeVisible();
    // ST5-T09: ปุ่มออกเอกสารเปิดแล้ว (ผู้มีสิทธิ์ invoices:finalize) — การออกเลขทดสอบใน invoice-finalize.spec.ts
    await expect(d.getByRole('button', { name: 'ออกเอกสาร' })).toBeEnabled();
    await page.screenshot({ path: 'test-results/st5-t07-drawer-actual-1440.png' });
    // ออกจากคิวแล้ว
    await expect(rows).toHaveCount(0);
    await d.getByRole('button', { name: 'ยกเลิกร่าง' }).click();
    const dlg = page.getByRole('dialog', { name: 'ยกเลิกร่างใบแจ้งหนี้' });
    await dlg.getByRole('textbox').fill('ลูกค้าขอรวมวางบิลงวดหน้า');
    await dlg.getByRole('button', { name: 'ยกเลิกร่าง' }).click();
    await expect(page.getByText('ยกเลิกร่างแล้ว · DO กลับไปรอวางบิล')).toBeVisible();
    await expect(rows).toHaveCount(2);
  });
});
