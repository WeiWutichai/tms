import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST4-T10 Actual quantity + reject reason ต่อรายการ (docs/04 E2) — เกณฑ์ตรวจรับ:
 * ส่งจริงน้อยกว่าแผนโดยไม่เลือกเหตุผล → ถูกปฏิเสธ · ลูกค้าที่ตั้ง "ตามยอดจริง" ได้ยอดเงินตามปริมาณส่งจริง
 * ผ่าน drawer เที่ยว แท็บ "เอกสารแนบ" (จำนวนที่ส่งจริง) + drawer ลูกค้า แท็บ "เงื่อนไข" + drawer ใบสั่ง (ยอดวางบิล) · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const PNG = {
  name: 'pod-qty.png',
  mimeType: 'image/png',
  buffer: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 9),
  ]),
};
const CUST = `ลูกค้า ยอดจริง ${RUN}`;

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

test.describe.serial('ยอดส่งจริง + เหตุผลปฏิเสธรับ + วางบิลตามยอดจริง (ST4-T10)', () => {
  let H: Record<string, string>;
  let soNo = '';
  let soId = '';
  let doId = '';
  let tripNo = '';

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (doId) return;
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
    // ลูกค้าเริ่มที่ "ตามใบสั่ง" (เปลี่ยนในหน้าจอ) · checklist เอง: รูป ≥ 1 บังคับ
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: CUST,
      billingCompanyId: company,
      podRequirements: {
        success: { fields: [{ type: 'PHOTO', level: 'REQUIRED', minCount: 1 }] },
      },
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลัง ยอดจริง ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทาง ยอดจริง ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    // rate card ขาขายต่อตัน 350 บาท
    const rc = await post<{ id: string }>('/v1/rate-cards', {
      customerId: cust.body.id,
      originId: a.body.id,
      destinationId: b.body.id,
      vehicleTypeId: vt6,
      validFrom: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
      pricingModel: 'PER_TON',
      sellRate: '350',
      includedStops: 2,
    });
    await post(`/v1/rate-cards/${rc.body.id}/approve`, { reason: 'อนุมัติตามใบเสนอราคา' });
    const veh = await post<{ id: string }>('/v1/vehicles', {
      plate: `7${RUN.slice(0, 1)}-${RUN.slice(2)}`,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    await post('/v1/drivers', {
      name: `คนขับ ยอดจริง ${RUN}`,
      phone: `085-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
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
      lines: [{ description: 'ปูนซีเมนต์', qty: '20', unitId: ton, weightKg: '5000' }],
    });
    soNo = so.body.soNo;
    soId = so.body.id;
    const dId = (await get<Page1>(`/v1/delivery-orders?orderId=${so.body.id}`)).data[0]!.id;
    const t0 = await post<{ id: string }>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [dId],
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
    const trip = await get<{ tripNo: string; stops: { id: string }[] }>(`/v1/trips/${t0.body.id}`);
    tripNo = trip.tripNo;
    let m = 120;
    for (const s of trip.stops) {
      for (const [action, extra] of [
        ['arrive', {}],
        ['complete', { outcome: 'DELIVERED' }],
      ] as const)
        await post(`/v1/stops/${s.id}/${action}`, {
          clientEventId: randomUUID(),
          occurredAt: new Date(Date.now() - (m -= 10) * 60_000).toISOString(),
          ...extra,
        });
    }
    doId = dId;
  });

  const doRow = async (page: Page) =>
    (await (await page.request.get(`/v1/delivery-orders/${doId}`, { headers: H })).json()) as {
      status: string;
      lines: { qtyActual: string | null; rejectQty: string | null }[];
    };

  const openDocs = async (page: Page) => {
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: tripNo }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('เที่ยวรถ / ใบคุมรถ')).toBeVisible();
    await d.getByRole('tab', { name: 'เอกสารแนบ' }).click();
    return d;
  };

  test('เกณฑ์ตรวจรับ: ส่งจริงน้อยกว่าแผนโดยไม่เลือกเหตุผล → ถูกปฏิเสธ · เลือกเหตุผลแล้วบันทึกได้ → UNBILLED', async ({
    page,
  }) => {
    const d = await openDocs(page);
    const sec = d.getByTestId('actual-qty');
    await expect(sec.getByText('จำนวนที่ส่งจริง')).toBeVisible();
    await expect(sec.getByText('แผน 20 ตัน')).toBeVisible();
    await d.getByLabel('อัปโหลดรูป').setInputFiles(PNG);
    await expect(d.getByText(/รูปที่ 1 · /)).toBeVisible();
    await sec.getByLabel('จำนวนที่ส่งจริง ปูนซีเมนต์').fill('18');
    await expect(sec.getByText(/ปฏิเสธ 2 ตัน/)).toBeVisible();
    await expect(
      sec.getByText('ส่งน้อยกว่าแผน ระบุเหตุผลจาก reason master และแนบหลักฐาน'),
    ).toBeVisible();
    // ไม่เลือกเหตุผล → API 422 reason_required
    await d.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }).click();
    await expect(sec.getByText('ส่งน้อยกว่าแผน ต้องเลือกเหตุผล')).toBeVisible();
    expect(await doRow(page)).toMatchObject({ status: 'POD_PENDING' });
    expect((await doRow(page)).lines[0]!.qtyActual).toBeNull();

    await sec.getByRole('combobox').selectOption({ label: 'จำนวนไม่ครบ' });
    await expect(sec.getByText(/รูปถ่าย \(บังคับตามเหตุผลนี้\)/)).toBeVisible();
    await sec.getByPlaceholder(/กล่องบุบ/).fill('ของขาด 2 ตัน ผู้รับเซ็นรับไว้');
    await d.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }).click();
    await expect(d.getByTestId('do-pod').getByText('POD ครบ')).toBeVisible();
    expect(await doRow(page)).toMatchObject({
      status: 'UNBILLED',
      lines: [expect.objectContaining({ qtyActual: '18', rejectQty: '2' })],
    });
  });

  test('เกณฑ์ตรวจรับ: ตั้งลูกค้า "ตามยอดส่งจริง" ในหน้าจอ → ใบสั่งแสดงยอดวางบิลตามปริมาณส่งจริง (18 × 350)', async ({
    page,
  }) => {
    // ก่อนตั้ง: ลูกค้าตามใบสั่ง → ไม่มีส่วนยอดตามส่งจริง
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(soNo) }).click();
    let so = page.getByRole('dialog');
    await expect(so.getByText('7,000.00').first()).toBeVisible();
    await expect(so.getByTestId('bill-actual')).toHaveCount(0);

    await page.goto('/master/customers');
    await page.getByRole('row', { name: new RegExp(CUST) }).click();
    const c = page.getByRole('dialog');
    await c.getByRole('tab', { name: 'เงื่อนไข' }).click();
    await expect(c.getByText('วางบิลตามปริมาณ')).toBeVisible();
    await c.getByRole('radio', { name: 'ตามยอดส่งจริง' }).click();
    await c.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`บันทึกข้อมูล ${CUST} แล้ว`);

    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(soNo) }).click();
    so = page.getByRole('dialog');
    const box = so.getByTestId('bill-actual');
    await expect(box.getByText('ยอดประมาณตามยอดส่งจริง (ยังไม่ใช้ออกใบแจ้งหนี้)')).toBeVisible();
    await expect(box.getByText('ตามส่งจริง 18 ตัน (ใบสั่ง 20 ตัน)')).toBeVisible();
    await expect(box.getByText('6,300.00').first()).toBeVisible();
    const api = await (await page.request.get(`/v1/orders/${soId}`, { headers: H })).json();
    expect(api.sellBilling).toMatchObject({
      preview: true,
      basis: 'ACTUAL',
      status: 'ACTUAL',
      sellPlannedTotal: '7000.00',
      sellBillableTotal: '6300.00',
    });
  });
});
