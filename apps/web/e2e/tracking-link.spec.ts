import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST4-T14 Tracking link สาธารณะ (docs/04 E2, spec/04 §4) — เกณฑ์ตรวจรับ:
 * ค้นด้วยเลข PO ของลูกค้าเห็นสถานะล่าสุด; response ไม่มี field ราคา
 * + ลิงก์ต่อ DO เปิดแล้วเห็นงาน, เพิกถอนแล้ว "ลิงก์นี้ใช้ไม่ได้" · หน้า public เปิดใน context ใหม่ (ไม่ login) จอ 390 px
 * เตรียมข้อมูลผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const PO = `PO-TRK-${RUN}`;
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const PRICE_KEY = /price|amount|rate|cost|revenue|sell|buy|vat|wht|fee|total|margin/i;

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

/** key ทุกระดับของ JSON */
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysOf(x, out);
    }
  return out;
}

test.describe.serial('หน้าติดตามของผู้รับ (ST4-T14)', () => {
  test.describe.configure({ timeout: 90_000 });
  let H: Record<string, string> = {};
  const S: { custId?: string; doId?: string; doNo?: string; custUrl?: string; doUrl?: string } = {};

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (S.doId) return;
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
    const patch = await page.request.patch('/v1/settings', {
      headers: H,
      data: { values: { 'tracking.contactPhone': '02-118-4400' } },
    });
    expect(patch.status(), await patch.text()).toBe(200);
    type Page1 = { data: { id: string; code?: string; doNo?: string }[] };
    const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `บจก. สยามพลาสติก ติดตาม ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังบางปู ติดตาม ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทาง ติดตาม ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
      contact: { name: 'คุณวิไล', phone: '081-234-4507' },
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    // ราคาขาย (rate card) มีอยู่ — ต้องไม่ออกทางหน้าติดตาม
    const rc = await post<{ id: string }>('/v1/rate-cards', {
      customerId: cust.body.id,
      originId: a.body.id,
      destinationId: b.body.id,
      vehicleTypeId: vt6,
      validFrom: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
      pricingModel: 'PER_TRIP',
      sellRate: '7800',
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
      name: `สมชาย ติดตาม ${RUN}`,
      phone: `086-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
      employmentType: 'EMPLOYEE_SALARIED',
      licenceClass: 'T2',
      licenceExpiresOn: '2030-03-31',
      defaultVehicleId: veh.body.id,
    });
    const so = await post<{ id: string }>('/v1/orders', {
      customer: { id: cust.body.id },
      customerRef: PO,
      requestedDate: today,
      vehicleTypeId: vt6,
      stops: [
        { type: 'PICKUP', siteId: a.body.id },
        {
          type: 'DELIVERY',
          siteId: b.body.id,
          windowStart: `${today}T10:30:00+07:00`,
          windowEnd: `${today}T11:00:00+07:00`,
        },
      ],
      lines: [{ description: 'เม็ดพลาสติก PP', qty: '2', unitId: ton, weightKg: '2000' }],
    });
    const d = (await get<Page1>(`/v1/delivery-orders?orderId=${so.body.id}`)).data[0]!;
    const t0 = await post<{ id: string }>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [d.id],
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
    const trip = await get<{ stops: { id: string; sequence: number }[] }>(
      `/v1/trips/${t0.body.id}`,
    );
    const pickup = [...trip.stops].sort((x, y) => x.sequence - y.sequence)[0]!;
    // รับของที่จุดรับแล้ว → "กำลังส่ง"
    for (const [action, min, extra] of [
      ['arrive', 60, {}],
      ['complete', 50, { outcome: 'DELIVERED' }],
    ] as const)
      await post(`/v1/stops/${pickup.id}/${action}`, {
        clientEventId: randomUUID(),
        occurredAt: new Date(Date.now() - min * 60_000).toISOString(),
        ...extra,
      });
    S.custId = cust.body.id;
    S.doId = d.id;
    S.doNo = (await get<{ doNo: string }>(`/v1/delivery-orders/${d.id}`)).doNo;
    S.custUrl = (
      await post<{ url: string }>(`/v1/customers/${cust.body.id}/tracking-link`, {})
    ).body.url;
    S.doUrl = (
      await post<{ url: string }>(`/v1/delivery-orders/${d.id}/tracking-link`, {})
    ).body.url;
  });

  /** หน้า public บนมือถือ (context ใหม่ — ไม่มี cookie/ไม่ login) */
  const mobile = async (browser: Browser, url: string) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'th-TH',
      timezoneId: 'Asia/Bangkok',
      isMobile: true,
      hasTouch: true,
    });
    const p = await ctx.newPage();
    await p.goto(`${E2E_WEB}${new URL(url).pathname}`);
    return { ctx, p };
  };

  test('เกณฑ์ตรวจรับ: ลิงก์ของลูกค้า ค้นด้วยเลข PO + เบอร์ 4 ตัวท้าย → สถานะล่าสุด · response ไม่มี field ราคา', async ({
    browser,
  }) => {
    const { ctx, p } = await mobile(browser, S.custUrl!);
    await expect(p.getByRole('button', { name: 'ติดตาม' })).toBeVisible();
    await expect(p.getByText('มีคำถามเกี่ยวกับการจัดส่ง ติดต่อ 02-118-4400')).toBeVisible();
    await p.getByLabel('เลขใบส่งของ หรือเลข PO').fill(PO);
    await p.getByLabel('เบอร์โทรผู้รับ 4 ตัวท้าย').fill('0000');
    await p.getByRole('button', { name: 'ติดตาม' }).click();
    await expect(p.getByText('ไม่พบข้อมูล ตรวจเลขและเบอร์โทรอีกครั้ง')).toBeVisible();

    await p.getByLabel('เบอร์โทรผู้รับ 4 ตัวท้าย').fill('4507');
    const resP = p.waitForResponse((r) => r.url().includes('/lookup') && r.status() === 200);
    await p.getByRole('button', { name: 'ติดตาม' }).click();
    const body = (await (await resP).json()) as Record<string, unknown>;
    expect(keysOf(body).filter((k) => PRICE_KEY.test(k))).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('7800');
    await expect(p.getByTestId('trk-badge')).toHaveText('กำลังส่ง');
    await expect(p.getByText(S.doNo!).first()).toBeVisible();
    await expect(p.getByTestId('trk-eta')).toContainText('10:30–11:00 น.');
    await expect(p.getByTestId('trk-refs')).toContainText(PO);
    await expect(p.getByTestId('trk-vehicle')).toContainText('xx');
    await expect(p.getByTestId('trk-items')).toContainText('เม็ดพลาสติก PP');
    await expect(p.locator('body')).not.toContainText('7,800');
    await p.getByRole('button', { name: 'ค้นหาเลขอื่น' }).click();
    await expect(p.getByRole('button', { name: 'ติดตาม' })).toBeVisible();
    await ctx.close();
  });

  test('ลิงก์ต่อ DO: เปิดแล้วเห็นงาน · เพิกถอนแล้ว → "ลิงก์นี้ใช้ไม่ได้"', async ({
    browser,
    page,
  }) => {
    const { ctx, p } = await mobile(browser, S.doUrl!);
    await expect(p.getByTestId('trk-badge')).toHaveText('กำลังส่ง');
    await expect(p.getByRole('link', { name: /02-118-4400/ })).toHaveAttribute(
      'href',
      'tel:021184400',
    );
    await expect(p.getByRole('button', { name: 'ติดตาม' })).toHaveCount(0);
    const r = await page.request.post(`/v1/delivery-orders/${S.doId}/tracking-link/revoke`, {
      headers: { ...H, 'Idempotency-Key': randomUUID() },
      data: { reason: 'ส่งลิงก์ผิดคน ขอเพิกถอน' },
    });
    expect(r.status(), await r.text()).toBe(200);
    await p.reload();
    await expect(p.getByText('ลิงก์นี้ใช้ไม่ได้')).toBeVisible();
    await ctx.close();
  });
});
