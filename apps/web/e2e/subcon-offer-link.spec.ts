import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST3-T23 ลิงก์ข้อเสนองาน (docs/04 D3 "ส่งลิงก์ LINE/SMS ไม่ต้อง login") — เกณฑ์ตรวจรับ:
 * เปิดลิงก์บนมือถือโดยไม่ login กดรับ → trip ASSIGNED พร้อมทะเบียน/คนขับ; ปฏิเสธ → SO กลับใบค้าง `CARRIER_REJECTED`
 * เตรียมข้อมูลผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ · หน้า public เปิดใน context ใหม่ (ไม่มี cookie/token) จอ 390 px
 */
const RUN = String(Date.now()).slice(-6);
const CARRIER = `หจก. ศรีราชาโลจิสติกส์อีทูอี ${RUN}`;
const PLATE = `74-${RUN.slice(-4)}`;
const PHONE = `08${RUN.slice(-1)}${RUN.slice(-4)}${RUN.slice(-3)}`.slice(0, 10);
const DRIVER = `สมชาย ใจดีอีทูอี ${RUN}`;
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

function jurTax(n: number): string {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

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
  vehicle: { plate: string } | null;
  driver: { name: string } | null;
  hire: { status: string } | null;
};

test.describe.serial('ลิงก์ข้อเสนองานรถร่วม (ST3-T23)', () => {
  let H: Record<string, string> = {};
  const S: {
    t1?: Trip;
    t2?: Trip;
    so1?: { id: string; soNo: string };
    so2?: { id: string; soNo: string };
    url1?: string;
    url2?: string;
  } = {};

  const get = async <X>(page: Page, path: string) =>
    (await (await page.request.get(path, { headers: H })).json()) as X;

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (S.t1) return;
    const post = async <X>(path: string, data: object) => {
      const r = await page.request.post(path, {
        headers: { ...H, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), await r.text()).toBeLessThan(300);
      return (await r.json()) as X;
    };
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>(page, '/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `บจก. เอ็นเอสเอฟ อินดัสทรีอีทูอี ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังบางปูอีทูอี ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ท่าเรือแหลมฉบังอีทูอี ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<Page1>(page, '/v1/units?limit=50')).data.find(
      (u) => u.code === 'TON',
    )!.id;
    const vt6 = (await get<Page1>(page, '/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const day = (n: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const c = await post<{ id: string }>('/v1/carriers', {
      legalName: CARRIER,
      entityType: 'JURISTIC',
      taxId: jurTax(Number(RUN) + 701),
    });
    // รถร่วม 6 ล้อ + ประกัน/พ.ร.บ. ครบ + คนขับที่มีใบขับขี่ (กฎ ST3-T14 ผ่าน)
    const v = await post<{ id: string }>('/v1/vehicles', {
      plate: PLATE,
      plateProvince: 'TH-20',
      vehicleTypeId: vt6,
      ownership: 'SUBCONTRACT',
      carrierId: c.id,
    });
    for (const docType of ['INSURANCE', 'COMPULSORY_ACT']) {
      const f = await post<{ id: string; uploadUrl: string }>('/v1/documents', {
        kind: 'VEHICLE_DOC',
        mime: 'application/pdf',
        bytes: PDF.length,
        filename: `${docType}.pdf`,
      });
      const u = new URL(f.uploadUrl);
      const put = await page.request.put(u.pathname + u.search, {
        headers: { ...H, 'Content-Type': 'application/octet-stream' },
        data: PDF,
      });
      expect(put.status(), await put.text()).toBe(200);
      await post(`/v1/vehicles/${v.id}/documents`, {
        docType,
        docNo: `${docType.slice(0, 3)}-${RUN}`,
        ...(docType === 'INSURANCE'
          ? { issuer: 'บริษัท ประกันสมมติ จำกัด', insuranceClass: '1' }
          : {}),
        startsOn: day(-100),
        expiresOn: day(200),
        fileDocumentIds: [f.id],
      });
    }
    await post('/v1/drivers', {
      name: DRIVER,
      phone: PHONE,
      employmentType: 'CARRIER_DRIVER',
      carrierId: c.id,
      licenceClass: 'T2',
      licenceExpiresOn: day(300),
    });
    const so = () =>
      post<{ id: string; soNo: string }>('/v1/orders', {
        customer: { id: cust.id },
        requestedDate: today,
        vehicleTypeId: vt6,
        stops: [
          { type: 'PICKUP', siteId: a.id },
          { type: 'DELIVERY', siteId: b.id },
        ],
        lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: '8600' }],
      });
    const doOf = async (id: string) =>
      (await get<Page1>(page, `/v1/delivery-orders?orderId=${id}`)).data[0]!.id;
    const trip = async (s: { id: string }) => {
      const t = await post<Trip>('/v1/trips', {
        tripDate: today,
        deliveryOrderIds: [await doOf(s.id)],
      });
      // จ้างรถร่วม (ราคาตกลง + เหตุผล) → OFFERED + ลิงก์ 48 ชม.
      await post(`/v1/trips/${t.id}/offer`, {
        carrierId: c.id,
        cost: '5600',
        selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว',
      });
      const l = await get<{ link: { url: string } }>(page, `/v1/trips/${t.id}/offer-link`);
      return { t, url: l.link.url };
    };
    S.so1 = await so();
    S.so2 = await so();
    const r1 = await trip(S.so1);
    const r2 = await trip(S.so2);
    S.t1 = r1.t;
    S.url1 = r1.url;
    S.t2 = r2.t;
    S.url2 = r2.url;
  });

  /** หน้า public บนมือถือ (context ใหม่ — ไม่มี cookie/ไม่ login) */
  const mobile = async (browser: import('@playwright/test').Browser, url: string) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'th-TH',
      timezoneId: 'Asia/Bangkok',
      isMobile: true,
      hasTouch: true,
    });
    const p = await ctx.newPage();
    const u = new URL(url);
    await p.goto(`${E2E_WEB}${u.pathname}`);
    return { ctx, p };
  };

  test('มือถือไม่ login: เปิดลิงก์ → ใบสั่งงาน (ไม่มีราคาขาย) → รับงาน + ทะเบียน/คนขับ → เที่ยว ASSIGNED', async ({
    page,
    browser,
  }) => {
    const { ctx, p } = await mobile(browser, S.url1!);
    await expect(p.getByText(`${CARRIER} · เปิดจากลิงก์ LINE ไม่ต้องเข้าสู่ระบบ`)).toBeVisible();
    await expect(p.getByTestId('ofl-status')).toHaveText('รอตอบ');
    await expect(p.getByText(S.t1!.tripNo)).toBeVisible();
    await expect(p.getByTestId('ofl-price')).toHaveText('5,600.00');
    await expect(p.getByText(/ลิงก์หมดอายุใน 4[78] ชม\. · ตอบได้ถึง /)).toBeVisible();
    await expect(p.getByText('1 ถนนทดสอบ')).toHaveCount(0);
    await p.getByRole('button', { name: 'รับงาน' }).click();
    await p.getByPlaceholder('เช่น 74-5521 ชบ.').fill('99-9999');
    await p.getByPlaceholder('ชื่อ-นามสกุล').fill('สมชาย'); // ต่างจากชื่อที่ลงทะเบียน → หมายเหตุหลังรับงาน
    await p.getByPlaceholder('08x-xxx-xxxx').fill(PHONE);
    await p.getByRole('button', { name: 'ยืนยันรับงาน' }).click();
    // ทะเบียนที่ไม่ได้ลงทะเบียน → แจ้งบนจอ ยังไม่รับงาน
    await expect(p.getByRole('alert')).toHaveText(
      'ทะเบียนหรือเบอร์คนขับไม่ตรงกับข้อมูลที่ลงทะเบียนไว้กับบริษัท',
    );
    await p.getByPlaceholder('เช่น 74-5521 ชบ.').fill(`${PLATE} ชบ.`);
    await p.getByRole('button', { name: 'ยืนยันรับงาน' }).click();
    await expect(p.getByTestId('ofl-status')).toHaveText('รับงาน');
    await expect(p.getByTestId('ofl-accepted')).toContainText(`รถ ${PLATE} · ${DRIVER}`);
    await expect(p.getByRole('status')).toContainText(`รับงาน ${S.t1!.tripNo} แล้ว`);
    await expect(p.getByTestId('ofl-name-note')).toHaveText(
      `ระบบใช้ชื่อคนขับตามที่ลงทะเบียน: ${DRIVER}`,
    );
    await ctx.close();

    const tr = await get<Trip>(page, `/v1/trips/${S.t1!.id}`);
    expect(tr.status).toBe('ASSIGNED');
    expect(tr.vehicle?.plate).toBe(PLATE);
    expect(tr.driver?.name).toBe(DRIVER);
    expect(tr.hire?.status).toBe('ACCEPTED');

    // ผู้จัดรถเห็นใน drawer "จ่ายงานรถร่วม" — รับงานแล้ว + กิจกรรม
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(S.so1!.soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: S.t1!.tripNo }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'จ่ายงานรถร่วม' }).click();
    await expect(d.getByTestId('sub-accepted')).toContainText(`${CARRIER} รับงานแล้ว`);
    await d.getByRole('tab', { name: 'กิจกรรม' }).click();
    await expect(d.getByText(`ผู้รับเหมารับงาน · กรอกรถ ${PLATE}`)).toBeVisible();
  });

  test('มือถือไม่ login: ปฏิเสธ + เหตุผล → SO ค้าง CARRIER_REJECTED · เที่ยวกลับวางแผน', async ({
    page,
    browser,
  }) => {
    // ผู้จัดรถ: drawer รอตอบมีคัดลอกลิงก์ + ลิงก์ใบสั่งงาน
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(S.so2!.soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: S.t2!.tripNo }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'จ่ายงานรถร่วม' }).click();
    await expect(d.getByText('ส่งข้อเสนอล่าสุด')).toBeVisible();
    await expect(d.getByRole('button', { name: 'คัดลอกลิงก์' })).toBeVisible();
    // ผู้รับเหมาไม่มี LINE userId → ไม่มีปุ่ม "ส่งผ่าน LINE" (คัดลอกลิงก์ไปส่งเอง — #49)
    await expect(d.getByRole('button', { name: 'ส่งผ่าน LINE' })).toHaveCount(0);
    await d.getByRole('tab', { name: 'ใบสั่งงาน' }).click();
    await expect(d.getByTestId('sub-link')).toHaveText(S.url2!);

    const { ctx, p } = await mobile(browser, S.url2!);
    await p.getByRole('button', { name: 'ปฏิเสธ' }).click();
    await p.getByRole('button', { name: 'รถไม่ว่างวันที่รับงาน' }).click();
    await p.getByRole('button', { name: 'ยืนยันปฏิเสธ' }).click();
    await expect(p.getByTestId('ofl-status')).toHaveText('ปฏิเสธ');
    await expect(p.getByTestId('ofl-rejected')).toContainText(
      'เหตุผล: รถไม่ว่างวันที่รับงาน · ขอบคุณที่แจ้งกลับ',
    );
    // refresh แล้วยังเห็นผลเดิม ไม่มีปุ่มตอบ
    await p.reload();
    await expect(p.getByTestId('ofl-rejected')).toBeVisible();
    await expect(p.getByRole('button', { name: 'รับงาน' })).toHaveCount(0);
    await ctx.close();

    const tr = await get<Trip>(page, `/v1/trips/${S.t2!.id}`);
    expect(tr.status).toBe('PLANNING');
    expect(tr.hire).toBeNull();
    const so = await get<{ status: string; holdReason: { code: string } | null }>(
      page,
      `/v1/orders/${S.so2!.id}`,
    );
    expect(so.status).toBe('on_hold');
    expect(so.holdReason?.code).toBe('CARRIER_REJECTED');
  });
});
