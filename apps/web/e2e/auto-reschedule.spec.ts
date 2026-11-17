import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { DEMO_IDS, DEMO_TRUSTED_DEVICE, E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST4-T12 Undelivered-retain + auto-reschedule (docs/04 E2) — เกณฑ์ตรวจรับ:
 * ปิดจุดด้วยเหตุผลแบบ auto-reschedule → มีงานใหม่วันถัดไป (DO ส่งซ้ำรอจัดบนกระดาน — ไม่จัดรถให้เอง)
 * · เกินจำนวนครั้ง (ค่าตั้ง `dispatch.maxAutoReschedules`) → ขึ้นใบค้าง "นัดส่งใหม่ครบแล้ว"
 * ผู้จ่ายงานปิดจุดส่งแทนคนขับในแท็บไทม์ไลน์ของ drawer เที่ยว ("ของยังอยู่บนรถ" + "ลูกค้าปิดทำการ") · ผ่าน /v1 จริง · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const BKK = 7 * 3600_000;
const today = new Date(Date.now() + BKK).toISOString().slice(0, 10);
const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const DISPATCHER = 'dispatcher@demo-a.test';
const KEY = 'dispatch.maxAutoReschedules';

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

type Trip = { id: string; tripNo: string; status: string; stops: { id: string; type: string }[] };
type Do = {
  id: string;
  doNo: string;
  status: string;
  doDate: string;
  redeliveryOfId: string | null;
  rescheduleCount: number;
};

test.describe.serial('นัดส่งใหม่อัตโนมัติ (ST4-T12)', () => {
  test.use({ loginEmail: DISPATCHER });
  let owner: Record<string, string>;
  let seq = 0;

  const bkk = (min: number) => {
    const d = new Date(Date.now() - min * 60_000 + BKK).toISOString();
    return `${d.slice(0, 16)}:00+07:00`;
  };

  /** SO 1 ใบ → DO → เที่ยวปล่อยรถแล้ว · จุดรับปิดสำเร็จ + ถึงจุดส่ง (ผ่าน API ของเจ้าของ) */
  const dispatchedTrip = async (page: Page) => {
    const n = `${RUN}-${++seq}`;
    const get = async <X>(path: string) =>
      (await (await page.request.get(path, { headers: owner })).json()) as X;
    const post = async <X>(path: string, data: object, ok = true) => {
      const r = await page.request.post(path, {
        headers: { ...owner, 'Idempotency-Key': randomUUID() },
        data,
      });
      if (ok) expect(r.status(), await r.text()).toBeLessThan(300);
      return { status: r.status(), body: (await r.json()) as X };
    };
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `ลูกค้านัดส่งใหม่ ${n}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังนัดใหม่ ${n}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ร้านนัดใหม่ ${n}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const veh = await post<{ id: string }>('/v1/vehicles', {
      plate: `9${String(seq)}-${RUN.slice(2)}`,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    await post('/v1/drivers', {
      name: `คนขับนัดใหม่ ${n}`,
      phone: `085-${RUN.slice(0, 3)}-${String(1000 + seq).slice(-4)}`,
      employmentType: 'EMPLOYEE_SALARIED',
      licenceClass: 'T2',
      licenceExpiresOn: '2030-03-31',
      defaultVehicleId: veh.body.id,
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
    const d0 = (await get<{ data: Do[] }>(`/v1/delivery-orders?orderId=${so.body.id}`)).data[0]!;
    const t0 = await post<Trip>('/v1/trips', {
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
    const trip = await get<Trip>(`/v1/trips/${t0.body.id}`);
    const pk = trip.stops.find((s) => s.type === 'PICKUP')!;
    const dr = trip.stops.find((s) => s.type === 'DELIVERY')!;
    await post(`/v1/stops/${pk.id}/arrive`, { clientEventId: randomUUID(), occurredAt: bkk(90) });
    await post(`/v1/stops/${pk.id}/complete`, {
      clientEventId: randomUUID(),
      occurredAt: bkk(80),
      outcome: 'DELIVERED',
    });
    await post(`/v1/stops/${dr.id}/arrive`, { clientEventId: randomUUID(), occurredAt: bkk(40) });
    return { so: so.body, d0, trip, site: `ร้านนัดใหม่ ${n}` };
  };

  const dosOf = async (page: Page, orderId: string) =>
    (
      (await (
        await page.request.get(`/v1/delivery-orders?orderId=${orderId}&status=DRAFT,CANCELLED`, {
          headers: owner,
        })
      ).json()) as { data: Do[] }
    ).data;

  /** drawer SO → ปุ่มเลขเที่ยว → แท็บไทม์ไลน์ → ปิดงานจุดส่ง "ของยังอยู่บนรถ" + ลูกค้าปิดทำการ */
  const failDropInUi = async (page: Page, x: Awaited<ReturnType<typeof dispatchedTrip>>) => {
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(x.so.soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: x.trip.tripNo }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('tab', { name: 'ไทม์ไลน์' }).click();
    const steps = d.getByTestId('trip-step');
    await expect(steps).toHaveCount(2);
    await steps.nth(1).getByRole('button', { name: 'ปิดงาน' }).click();
    const dlg = page.getByRole('dialog', { name: 'บันทึกปิดงาน' });
    await dlg.getByText('ของยังอยู่บนรถ', { exact: true }).click();
    await dlg.getByRole('combobox').selectOption({ label: 'ลูกค้าปิดทำการ' });
    await dlg.getByLabel(/หมายเหตุ/).fill('ร้านปิด โทรไม่รับสาย ของยังอยู่บนรถ');
    await dlg.getByRole('button', { name: 'บันทึก' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `บันทึกปิดงาน ${x.site} แล้ว` }),
    ).toBeVisible();
    return steps;
  };

  test.beforeEach(async ({ page }) => {
    owner = { Authorization: `Bearer ${await login(page, 'owner@demo-a.test')}` };
    await login(page, DISPATCHER);
  });

  test('เกณฑ์ตรวจรับ: ปิดจุด "ของยังอยู่บนรถ" + เหตุผลแบบ auto-reschedule → DO ใหม่วันถัดไป · ไทม์ไลน์บอกเลข DO/วันที่นัด · กระดานมีการ์ดป้าย "ส่งซ้ำ" (ไม่จัดรถให้เอง)', async ({
    page,
  }) => {
    const x = await dispatchedTrip(page);
    const steps = await failDropInUi(page, x);
    await expect(steps.nth(1)).toContainText('ล้มเหลว');
    await expect(steps.nth(1)).toContainText('ผล: ของยังอยู่บนรถ');

    const dos = await dosOf(page, x.so.id);
    const old = dos.find((d) => d.id === x.d0.id)!;
    const nd = dos.find((d) => d.redeliveryOfId === x.d0.id)!;
    expect(old.status).toBe('CANCELLED');
    expect(nd).toMatchObject({ status: 'DRAFT', doDate: tomorrow, rescheduleCount: 1 });
    const line = steps.nth(1).getByTestId('trip-reschedule');
    await expect(line).toContainText(`นัดส่งใหม่อัตโนมัติ ครั้งที่ 1: ${x.d0.doNo} → ${nd.doNo}`);
    await expect(line).toContainText('(รอจัดรถ)');
    await page.screenshot({ path: 'test-results/st4-reschedule-timeline.png' });

    // กระดานวางแผน: SO กลับมาใน "SO รอจัด" ป้าย "ส่งซ้ำ" — ยังไม่มีเที่ยว/รถ
    await page.goto('/plan');
    const card = page.getByTestId(`plan-pool-${x.so.soNo}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText('ส่งซ้ำ');
    await expect(card).not.toContainText('เกินกำหนด');
    await page.screenshot({ path: 'test-results/st4-reschedule-pool.png' });
    const tripsOfNew = (await (
      await page.request.get(`/v1/delivery-orders/${nd.id}`, { headers: owner })
    ).json()) as { tripId: string | null };
    expect(tripsOfNew.tripId).toBeNull();
  });

  test('เกณฑ์ตรวจรับ: เกินจำนวนครั้ง (ตั้ง 0) → ใบสั่งขึ้นใบค้าง "นัดส่งใหม่ครบแล้ว" · DO ส่งซ้ำยังรอจัด', async ({
    page,
  }) => {
    const set = async (n: number) => {
      const r = await page.request.patch('/v1/settings', {
        headers: owner,
        data: { values: { [KEY]: n } },
      });
      expect(r.status(), await r.text()).toBe(200);
    };
    await set(0);
    try {
      const x = await dispatchedTrip(page);
      await failDropInUi(page, x);
      const dos = await dosOf(page, x.so.id);
      expect(dos.find((d) => d.redeliveryOfId === x.d0.id)).toMatchObject({
        status: 'DRAFT',
        rescheduleCount: 1,
      });
      await page.goto('/so/hold');
      await expect(page.getByRole('heading', { name: 'ใบค้าง' })).toBeVisible();
      const row = page.getByRole('row', { name: new RegExp(x.so.soNo) });
      await expect(row).toContainText('นัดส่งใหม่ครบแล้ว');
      await page.screenshot({ path: 'test-results/st4-reschedule-hold.png' });
    } finally {
      await set(2);
    }
  });
});
