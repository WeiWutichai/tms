import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST4-T02 Server idempotent (docs/04 E1) — เกณฑ์ตรวจรับ:
 * ส่ง event เดิม 2 ครั้ง = 1 แถว · ส่งสลับลำดับ (เวลาเครื่องถูก) → สถานะสุดท้ายถูก · กรณีขัดแย้งขึ้นธง
 * → ผู้จัดรถเห็นในหน้า ศูนย์ข้อยกเว้น แล้ว "ปิดเหตุ" พร้อมเหตุผล · ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const REASON = 'คนขับลืมกดถึงจุด ลูกค้ายืนยันรับของแล้ว';

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

type Trip = { id: string; tripNo: string; stops: { id: string }[] };

test.describe.serial('ศูนย์ข้อยกเว้น: event ส่งซ้ำ / สลับลำดับ / ขัดแย้ง (ST4-T02)', () => {
  let H: Record<string, string>;
  let trip: Trip | undefined;
  let conflictId = '';

  const ev = (hhmm: string, extra: object = {}) => ({
    clientEventId: randomUUID(),
    occurredAt: `${today}T${hhmm}:00+07:00`,
    ...extra,
  });

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (trip) return;
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
      legalName: `ลูกค้าธงหน้างาน ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังธง ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทางธง ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const veh = await post<{ id: string }>('/v1/vehicles', {
      plate: `7${RUN.slice(0, 1)}-${RUN.slice(2)}`,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    await post('/v1/drivers', {
      name: `คนขับธง ${RUN}`,
      phone: `083-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
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
      lines: [{ description: 'ปูนซีเมนต์', qty: '1', unitId: ton, weightKg: '1500' }],
    });
    const doId = (await get<Page1>(`/v1/delivery-orders?orderId=${so.body.id}`)).data[0]!.id;
    const t0 = await post<Trip>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [doId],
      vehicleId: veh.body.id,
    });
    // จัดรถ + ปล่อยเที่ยว (คำเตือนของรถใหม่ — ยืนยันพร้อมเหตุผล)
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
  });

  test('API: ส่ง event เดิม 2 ครั้ง = 1 แถว (201 แล้ว 200 ผลเดิม) · ส่งสลับลำดับ → สถานะสุดท้ายถูก', async ({
    page,
  }) => {
    const pickup = trip!.stops[0]!.id;
    const body = ev('09:10');
    const r1 = await page.request.post(`/v1/stops/${pickup}/arrive`, { headers: H, data: body });
    expect(r1.status()).toBe(201);
    const r2 = await page.request.post(`/v1/stops/${pickup}/arrive`, { headers: H, data: body });
    expect(r2.status()).toBe(200);
    expect((await r2.json()).id).toBe((await r1.json()).id);
    // ออกเดินทางมุ่งหน้าไปจุดนี้ (เวลาก่อนถึง) มาทีหลัง แล้วปิดงาน
    for (const [action, data] of [
      ['depart', ev('08:30')],
      ['complete', ev('09:40', { outcome: 'DELIVERED' })],
    ] as const)
      expect(
        (await page.request.post(`/v1/stops/${pickup}/${action}`, { headers: H, data })).status(),
      ).toBe(201);
    const seq = await (await page.request.get(`/v1/stops/${pickup}/events`, { headers: H })).json();
    expect(seq.data.map((e: { type: string }) => e.type)).toEqual(['DEPART', 'ARRIVE', 'COMPLETE']);
    expect(seq.data).toHaveLength(3);
    expect(seq.effective).toMatchObject({ state: 'COMPLETED', outcome: 'DELIVERED' });
    expect(seq.data.every((e: { flags: string[] }) => e.flags.length === 0)).toBe(true);
  });

  test('ขัดแย้ง (ปิดงานก่อนถึงจุด) → ขึ้นธงในศูนย์ข้อยกเว้น → ผู้จัดรถ "ปิดเหตุ" พร้อมเหตุผล', async ({
    page,
  }) => {
    const drop = trip!.stops[1]!.id;
    const r = await page.request.post(`/v1/stops/${drop}/complete`, {
      headers: H,
      data: ev('11:00', { outcome: 'DELIVERED' }),
    });
    expect(r.status()).toBe(201);
    const e = await r.json();
    expect(e.flags).toEqual(['SEQUENCE_CONFLICT']);
    conflictId = e.id;

    await page.goto('/exceptions');
    await expect(page.getByRole('heading', { name: 'ศูนย์ข้อยกเว้น' })).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(`${trip!.tripNo}.*จุดที่ 2`) });
    await expect(row).toContainText('ลำดับเหตุการณ์ขัดกัน');
    await expect(row).toContainText('ปิดงาน (ส่งสำเร็จ)');
    await expect(row).toContainText('ใหม่');
    await row.click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('ศูนย์ข้อยกเว้น · ลำดับเหตุการณ์ขัดกัน')).toBeVisible();
    await d.getByRole('tab', { name: 'กิจกรรม' }).click();
    await expect(d.getByText('ลำดับเหตุการณ์ของจุดนี้')).toBeVisible();
    await expect(d.getByText('ขัดลำดับ')).toBeVisible();
    await d.getByRole('tab', { name: 'รายละเอียด' }).click();

    await d.getByRole('button', { name: 'ปิดเหตุ' }).click();
    const dlg = page.getByRole('dialog', { name: `ปิดเหตุ ${trip!.tripNo}` });
    await expect(dlg.getByText('ใช้เหตุการณ์นี้')).toBeVisible();
    await dlg.getByRole('textbox').fill(REASON);
    await dlg.getByRole('button', { name: 'ปิดเหตุ' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `ปิดเหตุ ${trip!.tripNo} แล้ว` }),
    ).toBeVisible();
    await expect(page.getByRole('dialog').getByText('การตัดสิน')).toBeVisible();
    await expect(page.getByRole('dialog').getByText(REASON)).toBeVisible();

    // การตัดสินเป็นแถวใหม่ — event นับในลำดับ (ยอมรับ) · ธงอยู่ในแท็บ "ปิดแล้ว"
    const seq = await (await page.request.get(`/v1/stops/${drop}/events`, { headers: H })).json();
    expect(seq.effective.state).toBe('COMPLETED');
    const resolved = await (
      await page.request.get('/v1/stop-event-flags?status=resolved', { headers: H })
    ).json();
    const f = resolved.data.find((x: { id: string }) => x.id === conflictId);
    expect(f.resolution).toMatchObject({ decision: 'ACCEPT', reason: REASON });
  });
});
