import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { DEMO_IDS, DEMO_TRUSTED_DEVICE, E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST4-T04 อัปเดตสถานะผ่านเว็บ (docs/04 E2) — เกณฑ์ตรวจรับ: บันทึกย้อนเวลาได้ (ใส่ `occurredAt`) และเห็นชื่อผู้บันทึกใน timeline
 * ผู้จ่ายงาน (หน้าคลัง/แอดมิน) เปิด drawer เที่ยวรถ → แท็บไทม์ไลน์ → ปิดงานจุดรับย้อนเวลา (ส่ง ARRIVE ก่อน COMPLETE)
 * → "ออกจากจุด" (= DEPART ของจุดถัดไป) → "ส่งไม่สำเร็จจุดที่เหลือ" (เหตุผลบังคับ) → เที่ยวจบ · ผ่าน /v1 จริง · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const BKK = 7 * 3600_000;
const today = new Date(Date.now() + BKK).toISOString().slice(0, 10);
const DISPATCHER = 'dispatcher@demo-a.test';
const DISPATCHER_NAME = 'จ่ายงาน ตัวอย่าง';

/** เวลาไทย `min` นาทีก่อนตอนนี้ → { date, time } สำหรับช่องกรอก + ISO สำหรับเทียบ */
const ago = (min: number) => {
  const d = new Date(Date.now() - min * 60_000 + BKK).toISOString();
  const date = d.slice(0, 10);
  const time = d.slice(11, 16);
  return { date, time, iso: new Date(`${date}T${time}:00+07:00`).toISOString() };
};

async function login(page: Page, email: string): Promise<string> {
  // role ที่บังคับ 2FA (เจ้าของ): cookie อุปกรณ์ที่จำไว้จาก seed (เหมือน fixtures)
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

type Trip = {
  id: string;
  tripNo: string;
  status: string;
  stops: { id: string; status: string; arrivedAt: string | null; departedAt: string | null }[];
};
type Ev = { stopId: string; type: string; occurredAt: string; recordedByName: string | null };

test.describe.serial('บันทึกสถานะแทนคนขับผ่านเว็บ + stepper (ST4-T04)', () => {
  test.use({ loginEmail: DISPATCHER });
  let H: Record<string, string>;
  let trip: Trip | undefined;
  let soNo = '';
  const name = { a: `คลังสเต็ป ${RUN}`, b: `ร้านสเต็ป ${RUN}` };

  test.beforeEach(async ({ page }) => {
    // สร้างข้อมูลด้วยเจ้าของ (มีสิทธิ์ข้อมูลหลัก/SO) แล้ว login หน้าเว็บกลับเป็นผู้จ่ายงาน
    const owner = { Authorization: `Bearer ${await login(page, 'owner@demo-a.test')}` };
    H = { Authorization: `Bearer ${await login(page, DISPATCHER)}` };
    if (trip) return;
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
      legalName: `ลูกค้าสเต็ป ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: name.a,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: name.b,
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
      name: `คนขับสเต็ป ${RUN}`,
      phone: `084-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
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
  });

  const fresh = async (page: Page) =>
    (await (await page.request.get(`/v1/trips/${trip!.id}`, { headers: H })).json()) as Trip;
  const timeline = async (page: Page) =>
    (
      (await (await page.request.get(`/v1/trips/${trip!.id}/events`, { headers: H })).json()) as {
        data: Ev[];
      }
    ).data;

  const openTimeline = async (page: Page) => {
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: trip!.tripNo }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('เที่ยวรถ / ใบคุมรถ')).toBeVisible();
    await d.getByRole('tab', { name: 'ไทม์ไลน์' }).click();
    await expect(d.getByText('ความคืบหน้าเที่ยว')).toBeVisible();
    return d;
  };

  test('เกณฑ์ตรวจรับ: ปิดงานจุดรับย้อนเวลา (ถึงจุด + ปิดงาน) → เห็นชื่อผู้บันทึกในไทม์ไลน์ · เวลาที่เก็บ = เวลาที่กรอก', async ({
    page,
  }) => {
    const d = await openTimeline(page);
    const steps = d.getByTestId('trip-step');
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toContainText(`รับสินค้า · ${name.a}`);
    await expect(steps.nth(0)).toContainText('รอดำเนินการ');
    await expect(steps.nth(1)).toContainText(`ส่งสินค้า · ${name.b}`);
    await page.screenshot({ path: 'test-results/st4-stepper-pending.png' });

    const arr = ago(150);
    const done = ago(120);
    await steps.nth(0).getByRole('button', { name: 'ปิดงาน' }).click();
    const dlg = page.getByRole('dialog', { name: 'บันทึกปิดงาน' });
    await expect(dlg).toContainText('บันทึกแทนคนขับ');
    const dates = dlg.getByLabel(/วันที่/);
    await dates.nth(0).fill(arr.date);
    await dlg.getByLabel(/เวลาถึงจุด/).fill(arr.time);
    await dates.nth(1).fill(done.date);
    await dlg.getByLabel(/เวลาปิดงาน/).fill(done.time);
    await page.screenshot({ path: 'test-results/st4-stepper-dialog.png' });
    await dlg.getByRole('button', { name: 'บันทึก' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `บันทึกปิดงาน ${name.a} แล้ว` }),
    ).toBeVisible();

    await expect(steps.nth(0).getByRole('img', { name: 'สำเร็จ' })).toBeVisible();
    await expect(steps.nth(0)).toContainText(`ถึง ${arr.time}`);
    const lines = steps.nth(0).getByTestId('trip-event');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText(
      `ถึงจุด ${arr.time} · บันทึกโดย ${DISPATCHER_NAME} · บันทึกผ่านเว็บ`,
    );
    await expect(lines.nth(1)).toContainText(
      `ปิดงาน (ส่งสำเร็จ) ${done.time} · บันทึกโดย ${DISPATCHER_NAME}`,
    );

    const tl = await timeline(page);
    expect(tl.map((e) => [e.type, e.occurredAt, e.recordedByName])).toEqual([
      ['ARRIVE', arr.iso, DISPATCHER_NAME],
      ['COMPLETE', done.iso, DISPATCHER_NAME],
    ]);
    const t1 = await fresh(page);
    expect(t1.status).toBe('IN_PROGRESS');
    expect(t1.stops[0]).toMatchObject({ status: 'COMPLETED', arrivedAt: arr.iso });
  });

  test('ออกจากจุด = DEPART ของจุดถัดไป · ส่งไม่สำเร็จจุดที่เหลือ (เหตุผลบังคับ) → เที่ยวจบ', async ({
    page,
  }) => {
    const d = await openTimeline(page);
    const steps = d.getByTestId('trip-step');
    const left = ago(100);
    await steps.nth(0).getByRole('button', { name: 'ออกจากจุด' }).click();
    const dep = page.getByRole('dialog', { name: 'บันทึกออกจากจุด' });
    await expect(dep).toContainText(`ออกจาก ${name.a} มุ่งหน้าไป ${name.b}`);
    await dep.getByLabel(/วันที่/).fill(left.date);
    await dep.getByLabel(/เวลาที่เกิดจริง/).fill(left.time);
    await dep.getByRole('button', { name: 'บันทึก' }).click();
    await expect(steps.nth(0)).toContainText(`ออก ${left.time}`);
    await expect(steps.nth(0).getByRole('button', { name: 'ออกจากจุด' })).toHaveCount(0);
    await expect(steps.nth(1).getByTestId('trip-event')).toContainText(
      `ออกจากจุดก่อนหน้า ${left.time} · บันทึกโดย ${DISPATCHER_NAME}`,
    );
    let tl = await timeline(page);
    expect(tl.map((e) => [e.stopId, e.type])).toContainEqual([trip!.stops[1]!.id, 'DEPART']);

    await d.getByRole('button', { name: 'ส่งไม่สำเร็จจุดที่เหลือ' }).click();
    const rest = page.getByRole('dialog', { name: 'ส่งไม่สำเร็จจุดที่เหลือ 1 จุด' });
    await rest.getByRole('button', { name: 'บันทึก' }).click();
    await expect(rest.getByRole('alert')).toHaveText('เลือกเหตุผล');
    await rest.getByRole('combobox').selectOption({ label: 'ลูกค้าปิดทำการ' });
    await rest.getByLabel(/หมายเหตุ/).fill('ร้านปิด โทรไม่รับสาย');
    await page.screenshot({ path: 'test-results/st4-stepper-failrest.png' });
    await rest.getByRole('button', { name: 'บันทึก' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'บันทึกส่งไม่สำเร็จ 1 จุดแล้ว' }),
    ).toBeVisible();
    await expect(steps.nth(1)).toContainText('ล้มเหลว');
    await expect(steps.nth(1)).toContainText('เหตุผล: ลูกค้าปิดทำการ');
    await expect(d.getByText('จบเที่ยว')).toBeVisible();
    await expect(d.getByRole('button', { name: 'ส่งไม่สำเร็จจุดที่เหลือ' })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/st4-stepper-done.png' });

    tl = await timeline(page);
    expect(tl.at(-1)).toMatchObject({ type: 'FAIL', recordedByName: DISPATCHER_NAME });
    expect((await fresh(page)).status).toBe('COMPLETED');
  });
});
