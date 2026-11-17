import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST4-T11 ตีกลับบางส่วน/ทั้งหมด (docs/04 E2) — เกณฑ์ตรวจรับ:
 * ของถูกปฏิเสธ 10 ชิ้น → เลือก "ส่งซ้ำ" ได้ DO ใหม่ 10 ชิ้นอ้างใบเดิม
 * ผ่าน drawer เที่ยว แท็บ "เอกสารแนบ" (หลักฐานส่ง + ปุ่ม/dialog "ตีกลับบางส่วน") + กระดานจัดรถ (ป้าย "ส่งซ้ำ") · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const PNG = {
  name: 'pod-return.png',
  mimeType: 'image/png',
  buffer: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 9),
  ]),
};
const CUST = `ลูกค้า ตีกลับ ${RUN}`;

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

test.describe.serial('ตีกลับบางส่วน → ส่งซ้ำ (ST4-T11)', () => {
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
      name: `คลัง ตีกลับ ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทาง ตีกลับ ${RUN}`,
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
      name: `คนขับ ตีกลับ ${RUN}`,
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

  const doRow = async (page: Page, id = doId) =>
    (await (await page.request.get(`/v1/delivery-orders/${id}`, { headers: H })).json()) as {
      id: string;
      doNo: string;
      status: string;
      redeliveryOfId: string | null;
      rejectedFromId: string | null;
      lines: {
        qtyPlanned: string;
        qtyActual: string | null;
        rejectQty: string | null;
        redeliveredQty: string;
        openRejectQty: string;
      }[];
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

  test('เกณฑ์ตรวจรับ: ปฏิเสธ 10 ตัน → "ตีกลับบางส่วน" → ส่งซ้ำ → DO ใหม่ 10 ตัน อ้างใบเดิม · ใบเดิมคงส่งแล้ว', async ({
    page,
  }) => {
    const d = await openDocs(page);
    const sec = d.getByTestId('actual-qty');
    // หลักฐานส่ง: ส่งได้ 10 จาก 20 + เหตุผล "จำนวนไม่ครบ" (บังคับรูป)
    await d.getByLabel('อัปโหลดรูป').setInputFiles(PNG);
    await expect(d.getByText(/รูปที่ 1 · /)).toBeVisible();
    await sec.getByLabel('จำนวนที่ส่งจริง ปูนซีเมนต์').fill('10');
    await sec.getByRole('combobox').selectOption({ label: 'จำนวนไม่ครบ' });
    await d.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }).click();
    await expect(d.getByTestId('do-pod').getByText('POD ครบ')).toBeVisible();
    await expect(d.getByTestId('do-pod').getByText('ตีกลับบางส่วน').first()).toBeVisible();

    // ปุ่ม "ตีกลับบางส่วน" → dialog ตามต้นแบบ
    await d.getByTestId('do-return').getByRole('button', { name: 'ตีกลับบางส่วน' }).click();
    const dlg = page.getByTestId('return-dialog');
    await expect(dlg.getByRole('heading')).toHaveText(/ตีกลับบางส่วน DO-/);
    await expect(
      dlg.getByText('เลือกรายการที่ลูกค้าไม่รับ ระบุเหตุผลจาก reason master และแนบหลักฐาน'),
    ).toBeVisible();
    await expect(dlg.getByText('10 ตัน')).toBeVisible();
    await expect(dlg.getByText('รูปหลักฐานส่ง 1 รูป')).toBeVisible();
    await expect(dlg.getByTestId('rt-hint')).toHaveText('เลือกรายการอย่างน้อย 1 รายการ · แนบรูป');
    await dlg.getByRole('checkbox').check();
    await expect(dlg.getByTestId('rt-hint')).toContainText('จะสร้างใบส่งของใหม่ 1 รายการ');
    await page.screenshot({ path: '../../design/compare/st4-return-dialog-real-1440.png' });
    await dlg.getByRole('button', { name: 'บันทึกตีกลับ' }).click();
    await expect(page.getByRole('status')).toContainText(/สร้างใบส่งของ DO-.+ \(ส่งซ้ำของ DO-/);
    await expect(dlg).toHaveCount(0);

    // API: ใบเดิมคงรอวางบิล ยอดส่งซ้ำ 10 · DO ใหม่ 10 ตันอ้างใบเดิม รอจัดรถ
    const src = await doRow(page);
    expect(src).toMatchObject({ status: 'UNBILLED' });
    expect(src.lines[0]).toMatchObject({
      qtyActual: '10',
      rejectQty: '10',
      redeliveredQty: '10',
      openRejectQty: '0',
    });
    const list = (await (
      await page.request.get(`/v1/delivery-orders?orderId=${soId}`, { headers: H })
    ).json()) as { data: { id: string; redeliveryOfId: string | null }[] };
    const nd = list.data.find((x) => x.redeliveryOfId === doId)!;
    expect(await doRow(page, nd.id)).toMatchObject({
      status: 'DRAFT',
      redeliveryOfId: doId,
      rejectedFromId: doId,
      lines: [expect.objectContaining({ qtyPlanned: '10', qtyActual: null })],
    });
    // ไม่มีอะไรเหลือให้จัดการ → ปุ่มหาย เหลือสรุป
    await expect(d.getByText('ปูนซีเมนต์: ส่งซ้ำแล้ว 10 · คืนคลังแล้ว 0 ตัน')).toBeVisible();
    await expect(d.getByTestId('do-return').getByRole('button')).toHaveCount(0);
    // ใบสั่ง: ส่งครบแล้ว → ส่งบางส่วน (รอส่งซ้ำ)
    const so = (await (await page.request.get(`/v1/orders/${soId}`, { headers: H })).json()) as {
      status: string;
    };
    expect(so.status).toBe('partially_delivered');
  });

  test('ใบส่งซ้ำลงกล่อง "SO รอจัด" บนกระดานพร้อมป้าย "ส่งซ้ำ"', async ({ page }) => {
    await page.goto('/plan');
    const card = page.getByTestId(`plan-pool-${soNo}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText('ส่งซ้ำ');
    await expect(card.getByTestId('plan-pool-retained')).toHaveCount(0);
  });
});
