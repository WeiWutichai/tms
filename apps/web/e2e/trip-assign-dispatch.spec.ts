import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST3-T17 ปุ่ม Assign แยกจาก Assign & dispatch + bulk (docs/04 D2; spec/03 PLN-047/048) — เกณฑ์ตรวจรับ:
 * (1) drawer เที่ยวรถ: "จัดรถ" → ASSIGNED ยังไม่ส่งงาน (DO PLANNED) · "ปล่อยเที่ยว" → DO ทุกใบในเที่ยว DISPATCHED
 * (2) กระดาน: Shift + คลิกการ์ดหลายเที่ยว → แถบ "เลือก N รายการ" → "ปล่อยเที่ยว" — ผลต่อรายการ (สำเร็จบางเที่ยว ไม่ใช่
 *     all-or-nothing): เที่ยวที่รถมีคนขับประจำปล่อยแล้ว DO ทุกใบ DISPATCHED · เที่ยวที่รถไม่มีคนขับขึ้นใน dialog "ทำไม่สำเร็จ"
 * ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const CUST = `ลูกค้าปล่อยเที่ยวอีทูอี ${RUN}`;
const plate = (p: string) => `${p}${RUN.slice(-1)}-${RUN.slice(-4)}`;
const VA = plate('3');
const VB = plate('2');
const VC = plate('1');
const REASON = 'ลูกค้ายืนยันให้ส่งตามแผนวันนี้';
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const at = (hh: string) => `${today}T${hh}:00:00+07:00`;

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

type Trip = {
  id: string;
  tripNo: string;
  status: string;
  version: number;
  dispatchedAt: string | null;
  deliveryOrders: { id: string; doNo: string; status: string }[];
  warnings: { key: string; severity: string; confirmed: boolean }[];
};

test.describe.serial('จัดรถ / ปล่อยเที่ยว / bulk (ST3-T17)', () => {
  let H: Record<string, string> = {};
  const T: { a?: Trip; b?: Trip; c?: Trip } = {};
  let soA = '';

  const tripNow = async (page: Page, id: string) =>
    (await (await page.request.get(`/v1/trips/${id}`, { headers: H })).json()) as Trip;

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (T.a) return;
    const get = async <X>(path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as X;
    const post = async <X>(path: string, data: object) => {
      const r = await page.request.post(path, {
        headers: { ...H, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), await r.text()).toBeLessThan(300);
      return (await r.json()) as X;
    };
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: CUST,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังปล่อยเที่ยว ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทางปล่อยเที่ยว ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const vehicle = (p: string) =>
      post<{ id: string }>('/v1/vehicles', {
        plate: p,
        plateProvince: 'TH-10',
        vehicleTypeId: vt6,
        ownership: 'OWN',
        payloadKg: 6000,
      });
    const driver = (n: string, vehicleId: string, i: number) =>
      post<{ id: string }>('/v1/drivers', {
        name: `${n} ${RUN}`,
        phone: `08${i}-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: vehicleId,
      });
    const va = await vehicle(VA);
    const vb = await vehicle(VB);
    const vc = await vehicle(VC); // ไม่มีคนขับประจำ → จัดรถ/ปล่อยไม่ได้ (422 driverId)
    await driver('คนขับปล่อยเที่ยว ก', va.id, 1);
    await driver('คนขับปล่อยเที่ยว ข', vb.id, 2);
    const so = () =>
      post<{ id: string; soNo: string }>('/v1/orders', {
        customer: { id: cust.id },
        requestedDate: today,
        vehicleTypeId: vt6,
        stops: [
          { type: 'PICKUP', siteId: a.id },
          { type: 'DELIVERY', siteId: b.id },
        ],
        lines: [{ description: 'ปูนซีเมนต์', qty: '1', unitId: ton, weightKg: '1500' }],
      });
    const doOf = async (id: string) =>
      (await get<Page1>(`/v1/delivery-orders?orderId=${id}`)).data[0]!.id;
    const s1 = await so();
    const s2 = await so();
    soA = s1.soNo;
    const trip = (dos: string[], vehicleId: string, s: string, e: string) =>
      post<Trip>('/v1/trips', {
        tripDate: today,
        deliveryOrderIds: dos,
        vehicleId,
        plannedStartAt: at(s),
        plannedEndAt: at(e),
      });
    T.a = await trip([await doOf(s1.id), await doOf(s2.id)], va.id, '08', '10');
    T.b = await trip([await doOf((await so()).id)], vb.id, '09', '11');
    T.c = await trip([await doOf((await so()).id)], vc.id, '09', '11');
    // คำเตือนของรถที่มีอยู่ก่อน (เช่น เอกสารรถบริษัทยังไม่ครบ) ยืนยันไว้ก่อนสำหรับเที่ยว B — ให้ผลของ bulk ขึ้นกับคนขับเท่านั้น
    const pend = T.b.warnings.filter((w) => !w.confirmed && w.severity !== 'info');
    if (pend.length)
      T.b = await post<Trip>(`/v1/trips/${T.b.id}/confirm-rules`, {
        ruleKeys: pend.map((w) => w.key),
        overrideReason: REASON,
      });
  });

  test('drawer เที่ยวรถ: "จัดรถ" → ASSIGNED ยังไม่ส่งงาน · "ปล่อยเที่ยว" → DISPATCHED และ DO ทุกใบ DISPATCHED', async ({
    page,
  }) => {
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(soA) }).click();
    await page.getByRole('dialog').getByRole('button', { name: T.a!.tripNo }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('เที่ยวรถ / ใบคุมรถ')).toBeVisible();
    const sec = d.getByTestId('trip-assign');
    await expect(sec.getByText('ยังไม่จัดรถ')).toBeVisible();
    // ลิงก์ "จัดรถ" เปิดฟอร์มรถ/คนขับ (ต้นแบบ drawer SO) — รถที่วางไว้ + คนขับประจำ
    await sec.getByRole('button', { name: 'จัดรถ' }).click();
    await expect(d.getByLabel('รถ (เรียงตามความเหมาะสม)')).toHaveValue(/.+/);
    await expect(d.getByLabel('คนขับ', { exact: true })).not.toHaveValue('');
    await page.screenshot({ path: 'test-results/st3-assign-form.png' });

    // ปุ่ม footer "จัดรถ" → ASSIGNED ยังไม่ส่งงาน
    await d.getByRole('button', { name: 'จัดรถ' }).last().click();
    const done = page.getByRole('status').filter({ hasText: `จัดรถ ${T.a!.tripNo} แล้ว` });
    await expect(done).toContainText('ยังไม่ส่งงาน');
    await expect(sec.getByText('จัดรถแล้ว · ยังไม่ส่ง')).toBeVisible();
    const asg = await tripNow(page, T.a!.id);
    expect(asg.status).toBe('ASSIGNED');
    expect(asg.dispatchedAt).toBeNull();
    expect(asg.deliveryOrders.map((x) => x.status)).toEqual(['PLANNED', 'PLANNED']);

    // "ปล่อยเที่ยว" → คำเตือนที่ยังไม่ยืนยัน (ถ้ามี) ขึ้น dialog ยืนยันพร้อมเหตุผลก่อน (ST3-T14)
    await d.getByRole('button', { name: 'ปล่อยเที่ยว' }).click();
    const warn = page.getByRole('dialog', { name: 'ยืนยันคำเตือนก่อนปล่อยเที่ยว' });
    const toast = page.getByRole('status').filter({ hasText: 'ปล่อย 1 เที่ยวแล้ว' });
    await expect(warn.or(toast)).toBeVisible();
    if (await warn.isVisible()) {
      await warn.getByRole('textbox').fill(REASON);
      await warn.getByRole('button', { name: 'ยืนยันและบันทึก log' }).click();
    }
    await expect(toast).toBeVisible();
    const disp = await tripNow(page, T.a!.id);
    expect(disp.status).toBe('DISPATCHED');
    expect(disp.dispatchedAt).toBeTruthy();
    // เกณฑ์ตรวจรับ: DO ทุกใบในเที่ยวเป็น DISPATCHED
    expect(disp.deliveryOrders).toHaveLength(2);
    expect(disp.deliveryOrders.map((x) => x.status)).toEqual(['DISPATCHED', 'DISPATCHED']);
  });

  test('กระดาน: เลือกหลายเที่ยว (Shift + คลิก) → "ปล่อยเที่ยว" ผลต่อรายการ — สำเร็จ 1 ไม่สำเร็จ 1 (รถไม่มีคนขับ)', async ({
    page,
  }) => {
    await page.goto('/plan');
    await page.getByRole('tab', { name: /^วันนี้/ }).click();
    const cb = page.getByTestId(`plan-trip-${T.b!.tripNo}`).locator('.tms-plan-card');
    const cc = page.getByTestId(`plan-trip-${T.c!.tripNo}`).locator('.tms-plan-card');
    await cb.scrollIntoViewIfNeeded();
    await cb.click({ modifiers: ['Shift'] });
    await cc.scrollIntoViewIfNeeded();
    await cc.click({ modifiers: ['Shift'] });
    await expect(cb).toHaveAttribute('data-picked', 'true');
    const bar = page.getByTestId('plan-bulk');
    await expect(bar).toContainText('เลือก 2 รายการ');
    // คลิกปกติไม่เปิด drawer ระหว่างเลือก — Shift + คลิกซ้ำ = ยกเลิกเลือก
    await cc.click({ modifiers: ['Shift'] });
    await expect(bar).toContainText('เลือก 1 รายการ');
    await cc.click({ modifiers: ['Shift'] });
    await bar.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/st3-assign-bulk.png' });
    await bar.getByRole('button', { name: 'ปล่อยเที่ยว' }).click();

    const dlg = page.getByRole('dialog', { name: 'ทำไม่สำเร็จ 1 เที่ยว' });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('1 เที่ยวสำเร็จ');
    const row = dlg.getByTestId('bulk-fail');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(T.c!.tripNo);
    await expect(row).toContainText('ยังไม่กำหนดคนขับ');
    await page.screenshot({ path: 'test-results/st3-assign-bulkfail.png' });

    const b = await tripNow(page, T.b!.id);
    expect(b.status).toBe('DISPATCHED');
    expect(b.deliveryOrders.every((x) => x.status === 'DISPATCHED')).toBe(true);
    const c = await tripNow(page, T.c!.id);
    expect(c.status).toBe('PLANNING');
    expect(c.deliveryOrders.every((x) => x.status === 'DRAFT')).toBe(true);

    // "เปิดเที่ยว" → drawer เที่ยวที่ไม่สำเร็จ (แก้ทีละเที่ยว)
    await row.getByRole('button', { name: 'เปิดเที่ยว' }).click();
    await expect(page.getByRole('dialog').getByText(T.c!.tripNo)).toBeVisible();
    await expect(page.getByTestId('trip-assign').getByText('ยังไม่จัดรถ')).toBeVisible();
  });
});
