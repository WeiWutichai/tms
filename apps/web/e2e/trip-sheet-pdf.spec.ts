import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST3-T20 ใบงานประจำวัน (docs/04 D2; spec/03 §4 "พิมพ์ A4 ใบคุมรถ") — เกณฑ์ตรวจรับ:
 * PDF ใบคุมรถต่อเที่ยว (drawer เที่ยวรถ → "พิมพ์ใบคุมรถ" ตามต้นแบบ) และต่อวัน (กระดานวางแผน) ดาวน์โหลดได้
 * + "ส่งให้คนขับ" = ลิงก์เปิด PDF ไม่ต้อง login (คัดลอกลิงก์ — LINE/SMS ถึงคนขับ = ST4)
 * เนื้อหาไทยในไฟล์ตรวจด้วย golden (apps/api/test/trip-sheet-pdf.test.ts) + test ข้อมูลหน้า (trip-sheets.test.ts)
 */
const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

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

const pdfPages = (b: Buffer) => (b.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

test.describe.serial('ใบคุมรถ PDF ต่อเที่ยว/ต่อวัน + ส่งให้คนขับ (ST3-T20)', () => {
  let H: Record<string, string>;
  let soNo = '';
  let trip: { id: string; tripNo: string } | undefined;
  const driverName = `สมชาย ใจดี ${RUN}`;

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (trip) return;
    const get = async <T>(path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as T;
    const post = async <T>(path: string, data: object, status = 201) => {
      const r = await page.request.post(path, {
        headers: { ...H, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), await r.text()).toBe(status);
      return (await r.json()) as T;
    };
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `บจก. สยามพลาสติกอีทูอี ${RUN}`,
      billingCompanyId: company,
    });
    const site = (n: string, contact?: object) =>
      post<{ id: string }>('/v1/customer-sites', {
        name: `${n} ${RUN}`,
        kind: 'DROPOFF',
        address: { line1: '1 ถนนทดสอบ', district: 'เมือง', province: 'ชลบุรี' },
        contact,
      });
    const p = await site('คลังต้นทาง บางนา');
    const q = await site('ร้านปลายทาง ชลบุรี', { name: 'คุณสมศักดิ์', phone: '081-234-5678' });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W')!;
    const so = await post<{ id: string; soNo: string }>('/v1/orders', {
      customer: { id: cust.id },
      requestedDate: today,
      vehicleTypeId: vt.id,
      stops: [
        { type: 'PICKUP', siteId: p.id },
        { type: 'DELIVERY', siteId: q.id },
      ],
      lines: [{ description: 'เม็ดพลาสติก', qty: '2', unitId: ton, weightKg: '2000' }],
    });
    soNo = so.soNo;
    const veh = await post<{ id: string }>('/v1/vehicles', {
      plate: `7${RUN.slice(-1)}-${RUN.slice(-4)}`,
      plateProvince: 'TH-10',
      vehicleTypeId: vt.id,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    const drv = await post<{ id: string }>('/v1/drivers', {
      name: driverName,
      phone: `089-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
      employmentType: 'EMPLOYEE_SALARIED',
      licenceClass: 'T2',
      licenceExpiresOn: '2030-03-31',
      defaultVehicleId: veh.id,
    });
    const doId = (await get<Page1>(`/v1/delivery-orders?orderId=${so.id}`)).data[0]!.id;
    trip = await post<{ id: string; tripNo: string }>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [doId],
      vehicleId: veh.id,
    });
    const t = await get<{
      version: number;
      warnings: { key: string; confirmed: boolean; severity: string }[];
    }>(`/v1/trips/${trip.id}`);
    const pend = t.warnings.filter((w) => !w.confirmed && w.severity !== 'info');
    await post(
      `/v1/trips/${trip.id}/assign`,
      {
        vehicleId: veh.id,
        driverId: drv.id,
        ...(pend.length
          ? { ruleKeys: pend.map((w) => w.key), overrideReason: 'ลูกค้ายืนยันให้ส่งตามแผน' }
          : {}),
      },
      200,
    );
  });

  test('drawer เที่ยวรถ → "พิมพ์ใบคุมรถ" ดาวน์โหลด PDF A4 · "ส่งให้คนขับ" → ลิงก์เปิด PDF ได้โดยไม่ login', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: trip!.tripNo }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('เที่ยวรถ / ใบคุมรถ')).toBeVisible();

    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      d.getByRole('button', { name: 'พิมพ์ใบคุมรถ' }).click(),
    ]);
    expect(dl.suggestedFilename()).toBe(`ใบคุมรถ-${trip!.tripNo}.pdf`);
    const pdf = readFileSync((await dl.path())!);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/FontName\s*\/[A-Z]{6}\+Sarabun/);
    expect(pdfPages(pdf)).toBe(1);
    await expect(page.getByText(`สร้าง PDF ใบคุมรถ ${trip!.tripNo} แล้ว`)).toBeVisible();

    await d.getByRole('button', { name: 'ส่งให้คนขับ' }).click();
    const share = page.getByRole('dialog', { name: 'ส่งใบคุมรถให้คนขับ' });
    await expect(share).toContainText(driverName);
    await expect(share).toContainText('ใช้ได้ถึง');
    const url = (await share.getByTestId('trip-share-link').locator('span').first().textContent())!;
    expect(url).toMatch(/\/v1\/public\/trip-sheets\/ml1\./);
    await share.getByRole('button', { name: 'คัดลอกลิงก์' }).click();
    await expect(page.getByText('คัดลอกลิงก์แล้ว · ส่งให้คนขับทาง LINE หรือ SMS')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);

    // คนขับเปิดลิงก์ (ไม่มี token) → PDF inline
    const u = new URL(url);
    const open = await page.request.get(u.pathname + u.search);
    expect(open.status()).toBe(200);
    expect(open.headers()['content-type']).toBe('application/pdf');
    expect(open.headers()['content-disposition']).toMatch(/^inline;/);
    expect((await open.body()).subarray(0, 5).toString()).toBe('%PDF-');
    await share.getByText('ปิด', { exact: true }).click();
    await expect(share).toBeHidden();
  });

  test('กระดานวางแผน → "พิมพ์ใบคุมรถ" = ใบงานประจำวันของวันที่แสดง (1 เที่ยว/หน้า)', async ({
    page,
  }) => {
    await page.goto('/plan');
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'พิมพ์ใบคุมรถ' }).click(),
    ]);
    expect(dl.suggestedFilename()).toBe(`ใบคุมรถ-${today}.pdf`);
    const toast = page.getByText(/^สร้าง PDF ใบคุมรถ \d+ เที่ยว · .+ แล้ว$/);
    await expect(toast).toBeVisible();
    const n = Number(/(\d+) เที่ยว/.exec((await toast.textContent())!)![1]);
    expect(n).toBeGreaterThanOrEqual(1);
    const pdf = readFileSync((await dl.path())!);
    expect(pdfPages(pdf)).toBeGreaterThanOrEqual(n);
    // API ตรง: เที่ยวของเราอยู่ในใบรายวัน
    const r = await page.request.post('/v1/trip-sheets', { headers: H, data: { date: today } });
    expect(r.status()).toBe(201);
    expect(((await r.json()) as { tripIds: string[] }).tripIds).toContain(trip!.id);
  });
});
