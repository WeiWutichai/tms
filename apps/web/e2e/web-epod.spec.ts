import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST4-T07 ePOD ผ่านเว็บ (docs/04 E2, docs/01 §4.3) — เกณฑ์ตรวจรับ:
 * อัปโหลด POD ครบตาม checklist → DO เป็น UNBILLED; ไม่ครบ → POD_PENDING
 * ผ่าน drawer เที่ยว แท็บ "เอกสารแนบ" (อัปโหลดรูปจริง + ลายเซ็นบนจอ + แก้ฉบับพร้อมเหตุผล) · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const PNG = {
  name: 'pod-1.png',
  mimeType: 'image/png',
  buffer: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]),
};

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

test.describe.serial('ePOD ผ่านเว็บ: หลักฐานส่งต่อ DO → POD_PENDING / UNBILLED (ST4-T07)', () => {
  let H: Record<string, string>;
  let soNo = '';
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
    // checklist ของลูกค้าเอง (ไม่ขึ้นกับค่าองค์กรที่ spec อื่นแก้): รูป ≥ 1 + ลายเซ็น บังคับ
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `ลูกค้า ePOD ${RUN}`,
      billingCompanyId: company,
      podRequirements: {
        success: {
          fields: [
            { type: 'PHOTO', level: 'REQUIRED', minCount: 1 },
            { type: 'SIGNATURE', level: 'REQUIRED' },
          ],
        },
      },
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลัง ePOD ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทาง ePOD ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const veh = await post<{ id: string }>('/v1/vehicles', {
      plate: `6${RUN.slice(0, 1)}-${RUN.slice(2)}`,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    await post('/v1/drivers', {
      name: `คนขับ ePOD ${RUN}`,
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

  const doStatus = async (page: Page) =>
    (await (await page.request.get(`/v1/delivery-orders/${doId}`, { headers: H })).json()) as {
      status: string;
      podStatus: string;
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

  test('ส่งถึงแล้วยังไม่มีหลักฐาน → POD_PENDING · อัปโหลดรูปอย่างเดียว (ไม่ครบ) → คง POD_PENDING', async ({
    page,
  }) => {
    expect(await doStatus(page)).toMatchObject({ status: 'POD_PENDING', podStatus: 'NONE' });
    const d = await openDocs(page);
    const block = d.getByTestId('do-pod');
    await expect(block.getByText('ยังไม่มี POD')).toBeVisible();
    await expect(d.getByTestId('pod-missing')).toHaveText('ยังขาด: รูปหลักฐาน, ลายเซ็นผู้รับ');
    await d.getByLabel('อัปโหลดรูป').setInputFiles(PNG);
    await expect(d.getByText(/รูปที่ 1 · /)).toBeVisible();
    await d.getByLabel('น้ำหนักชั่ง (กก.)').fill('1480');
    await expect(d.getByText('ต่างจากใบสั่ง -20 กก.')).toBeVisible();
    await d.getByLabel('ชื่อผู้รับ').fill('สมศรี ใจงาม');
    await d.getByLabel('ความสัมพันธ์').selectOption('SECURITY');
    await d.getByLabel('เลขอ้างอิงลูกค้า').fill(`GR-${RUN}`);
    await d.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }).click();
    await expect(block.getByText('POD ไม่ครบ')).toBeVisible();
    await expect(d.getByTestId('pod-missing')).toHaveText('ยังขาด: ลายเซ็นผู้รับ');
    await expect(d.getByText(/ฉบับที่ 1 · บันทึกโดย/)).toBeVisible();
    expect(await doStatus(page)).toMatchObject({ status: 'POD_PENDING', podStatus: 'PARTIAL' });
  });

  test('เกณฑ์ตรวจรับ: เพิ่มลายเซ็นบนจอ (แก้ฉบับ + เหตุผล) จนครบ checklist → DO UNBILLED', async ({
    page,
  }) => {
    const d = await openDocs(page);
    await d.getByRole('button', { name: 'เก็บลายเซ็นผู้รับ' }).click();
    const sig = page.getByRole('dialog', { name: 'เก็บลายเซ็นผู้รับ' });
    const pad = (await sig.getByTestId('sig-pad').boundingBox())!;
    await page.mouse.move(pad.x + 40, pad.y + 80);
    await page.mouse.down();
    for (let i = 0; i <= 20; i++)
      await page.mouse.move(pad.x + 40 + i * 12, pad.y + 60 + (i % 5) * 8);
    await page.mouse.up();
    await sig.getByRole('button', { name: 'ใช้ลายเซ็นนี้' }).click();
    await expect(sig).toBeHidden();
    await expect(d.getByText('เซ็นรับแล้ว')).toBeVisible();
    await d.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }).click();
    const why = page.getByRole('dialog', { name: 'แก้หลักฐานส่ง' });
    await why.getByRole('textbox').fill('ได้ลายเซ็นผู้รับภายหลังที่หน้าคลัง');
    await why.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }).click();
    await expect(d.getByTestId('do-pod').getByText('POD ครบ')).toBeVisible();
    await expect(d.getByTestId('pod-missing')).toHaveText('หลักฐานครบตามที่ลูกค้ากำหนด');
    expect(await doStatus(page)).toMatchObject({ status: 'UNBILLED', podStatus: 'COMPLETE' });
    const pod = await (
      await page.request.get(`/v1/delivery-orders/${doId}/pod`, { headers: H })
    ).json();
    expect(pod.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(pod.current).toMatchObject({
      receiverName: 'สมศรี ใจงาม',
      receiverRelation: 'SECURITY',
      weighedKg: '1480',
      customerRef: `GR-${RUN}`,
      reason: 'ได้ลายเซ็นผู้รับภายหลังที่หน้าคลัง',
    });
    expect(pod.current.signature.kind).toBe('POD_SIGNATURE');
  });
});
