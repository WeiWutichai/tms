import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page, Response } from '@playwright/test';
import { DEMO_IDS, DEMO_TRUSTED_DEVICE, E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST3-T18 Send all (docs/04 D2 "checkbox ส่งงานทั้งวันของทุกรถทีเดียว; ปฏิทินขึ้นเขียวเมื่อส่งครบ"; spec/03 §9) — เกณฑ์ตรวจรับ:
 * กด Send all แล้วทุก trip ของวันนั้นเป็น DISPATCHED และวันนั้นเป็นสีเขียว
 * (1) ปุ่ม "ส่งแผนให้คนขับ" (ต้นแบบ) → dialog เลือกวัน + checkbox "ส่งงานทั้งวันของทุกรถ" → เที่ยวที่ส่งไม่ได้ (รถไม่มีคนขับประจำ)
 *     ขึ้น dialog "ทำไม่สำเร็จ" ไม่ข้ามเงียบ — วันยังไม่เขียว
 * (2) แก้ (ใส่คนขับประจำ) แล้ว Send all อีกครั้ง → ทุกเที่ยว DISPATCHED (DO ทุกใบ) และหัววันในมุมมอง 7 วันเป็นสีเขียว
 * ใช้วัน +5 (วันที่ spec อื่นไม่สร้างเที่ยว) ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 *
 * กัน flaky ตอนเครื่องโหลดสูง (ci:local):
 * - dialog ยิง `dryRun` (ตรวจล่วงหน้า) ของวันที่เลือก — dryRun ทำจริงทุกขั้นใน transaction แล้วย้อน จึงถือ row lock ของเที่ยวชุดเดียวกัน
 *   ถ้ากดส่งระหว่าง dryRun ยังไม่จบ คำขอส่งจริงต้องรอ lock (เวลา dryRun + เวลาส่ง > 5 วินาทีของ expect) → รอผลตรวจล่วงหน้าก่อนกดส่ง
 *   และรอ response ของการส่งจริง (207) ก่อนตรวจ dialog/toast
 * - สร้างข้อมูลตั้งต้นใน beforeAll (งบเวลาของตัวเอง) ไม่กินงบ 30 วินาทีของ test แรก
 */
const RUN = String(Date.now()).slice(-6);
const CUST = `ลูกค้าส่งแผนอีทูอี ${RUN}`;
const plate = (p: string) => `${p}${RUN.slice(-1)}-${RUN.slice(-4)}`;
const VA = plate('6');
const VB = plate('5');
const VC = plate('4');
const REASON = 'ลูกค้ายืนยันให้ส่งตามแผนวันนั้น';
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const DAY = new Date(Date.parse(`${today}T00:00:00Z`) + 5 * 86_400_000).toISOString().slice(0, 10);
const at = (hh: string) => `${DAY}T${hh}:00:00+07:00`;

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
  deliveryOrders: { id: string; status: string }[];
  warnings: { key: string; severity: string; confirmed: boolean }[];
};

test.describe.serial('ส่งแผนทั้งวัน (ST3-T18)', () => {
  let H: Record<string, string> = {};
  const T: { a?: Trip; b?: Trip; c?: Trip } = {};
  let vcId = '';

  const tripNow = async (page: Page, id: string) =>
    (await (await page.request.get(`/v1/trips/${id}`, { headers: H })).json()) as Trip;
  const post = async <X>(page: Page, path: string, data: object) => {
    const r = await page.request.post(path, {
      headers: { ...H, 'Idempotency-Key': randomUUID() },
      data,
    });
    expect(r.status(), await r.text()).toBeLessThan(300);
    return (await r.json()) as X;
  };
  const driver = (page: Page, n: string, vehicleId: string, i: number) =>
    post<{ id: string }>(page, '/v1/drivers', {
      name: `${n} ${RUN}`,
      phone: `08${i}-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
      employmentType: 'EMPLOYEE_SALARIED',
      licenceClass: 'T2',
      licenceExpiresOn: '2030-03-31',
      defaultVehicleId: vehicleId,
    });
  /** response ของ POST /v1/trips/send-all ของวัน DAY — dryRun (ตรวจล่วงหน้าของ dialog) หรือส่งจริง */
  const sendAllOf =
    (dryRun: boolean) =>
    (r: Response): boolean => {
      const q = r.request();
      if (q.method() !== 'POST' || !r.url().endsWith('/v1/trips/send-all')) return false;
      const b = q.postDataJSON() as { date?: string; dryRun?: boolean } | null;
      return b?.date === DAY && (b.dryRun === true) === dryRun;
    };

  test.beforeAll(async ({ browser }) => {
    // งบเวลาของ beforeAll แยกจาก test — ข้อมูลตั้งต้น ~25 คำขอ API ต่อกัน: วัดตอนเครื่องโหลด ~80 ได้ 0.1–5.5 วินาที/คำขอ
    // (login 5.5 s, POST /orders 4.1 s, POST /trips 4.5 s) รวมเกิน 30 วินาทีได้จริง → ให้ 90 วินาทีเฉพาะ hook นี้
    test.setTimeout(90_000);
    const page = await browser.newPage();
    // เจ้าของบริษัทบังคับ 2FA — cookie อุปกรณ์ที่จำไว้จาก seed (แบบเดียวกับ fixtures.ts)
    await page.context().addCookies([
      {
        name: 'tms_td',
        value: `${DEMO_TRUSTED_DEVICE}:${DEMO_IDS['owner@demo-a.test']}`,
        url: `${E2E_WEB}/v1/auth`,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    H = { Authorization: `Bearer ${await token(page)}` };
    const get = async <X>(path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as X;
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>(page, '/v1/customers', {
      legalName: CUST,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>(page, '/v1/customer-sites', {
      name: `คลังส่งแผน ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>(page, '/v1/customer-sites', {
      name: `ปลายทางส่งแผน ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const vehicle = (p: string) =>
      post<{ id: string }>(page, '/v1/vehicles', {
        plate: p,
        plateProvince: 'TH-10',
        vehicleTypeId: vt6,
        ownership: 'OWN',
        payloadKg: 6000,
      });
    const va = await vehicle(VA);
    const vb = await vehicle(VB);
    const vc = await vehicle(VC); // ไม่มีคนขับประจำ → ส่งไม่ได้ (422 driverId) จนกว่าจะใส่คนขับ
    vcId = vc.id;
    await driver(page, 'คนขับส่งแผน ก', va.id, 3);
    await driver(page, 'คนขับส่งแผน ข', vb.id, 4);
    const so = () =>
      post<{ id: string }>(page, '/v1/orders', {
        customer: { id: cust.id },
        requestedDate: DAY,
        vehicleTypeId: vt6,
        stops: [
          { type: 'PICKUP', siteId: a.id },
          { type: 'DELIVERY', siteId: b.id },
        ],
        lines: [{ description: 'ปูนซีเมนต์', qty: '1', unitId: ton, weightKg: '1500' }],
      });
    const doOf = async (id: string) =>
      (await get<Page1>(`/v1/delivery-orders?orderId=${id}`)).data[0]!.id;
    const trip = async (dos: string[], vehicleId: string, s: string, e: string) => {
      let t = await post<Trip>(page, '/v1/trips', {
        tripDate: DAY,
        deliveryOrderIds: dos,
        vehicleId,
        plannedStartAt: at(s),
        plannedEndAt: at(e),
      });
      // คำเตือนของรถที่มีอยู่ก่อน (เอกสารรถบริษัทยังไม่ครบ ฯลฯ) ยืนยันไว้ก่อน — ให้ผลขึ้นกับคนขับเท่านั้น
      const pend = t.warnings.filter((w) => !w.confirmed && w.severity !== 'info');
      if (pend.length)
        t = await post<Trip>(page, `/v1/trips/${t.id}/confirm-rules`, {
          ruleKeys: pend.map((w) => w.key),
          overrideReason: REASON,
        });
      return t;
    };
    T.a = await trip([await doOf((await so()).id), await doOf((await so()).id)], va.id, '08', '10');
    T.b = await trip([await doOf((await so()).id)], vb.id, '09', '11');
    T.c = await trip([await doOf((await so()).id)], vc.id, '09', '11');
    // B จัดรถไว้แล้ว (ASSIGNED) — Send all ปล่อยอย่างเดียว
    T.b = await post<Trip>(page, `/v1/trips/${T.b.id}/assign`, { vehicleId: vb.id });
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
  });

  test('ปุ่ม "ส่งแผนให้คนขับ" → checkbox ส่งงานทั้งวัน → เที่ยวที่ส่งไม่ได้ขึ้นพร้อมเหตุผล (ไม่ข้ามเงียบ) · วันยังไม่เขียว', async ({
    page,
  }) => {
    await page.goto('/plan');
    await page.getByRole('tab', { name: /^7 วัน/ }).click();
    const head = page.getByTestId(`week-day-${DAY}`);
    await expect(head).toBeVisible();
    await expect(head).not.toHaveAttribute('data-done', 'true');

    // ฟังก่อนเปิด dialog — วันเริ่มต้นของ dialog อาจเป็น DAY อยู่แล้ว (dryRun ยิงตอนเปิด)
    const checked = page.waitForResponse(sendAllOf(true));
    await page.getByRole('button', { name: 'ส่งแผนให้คนขับ' }).click();
    const dlg = page.getByRole('dialog', { name: 'ส่งแผนให้คนขับ' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('combobox', { name: 'วันที่' }).selectOption(DAY);
    // ผลตรวจล่วงหน้า (dryRun) ของวันนั้นกลับมาก่อน — ไม่งั้นการส่งจริงต้องรอ row lock ของ dryRun
    expect((await checked).status()).toBe(207);
    const master = dlg.getByTestId('send-all-master');
    await expect(master).toBeChecked();
    await expect(dlg).toContainText('ส่งงานทั้งวันของทุกรถ (3 เที่ยว · 3 คัน)');
    for (const t of [T.a!, T.b!, T.c!]) await expect(dlg).toContainText(t.tripNo);
    // เที่ยวบนรถที่ไม่มีคนขับประจำ — แสดงเหตุผลล่วงหน้า แต่ยังติ๊กไว้ (server ตอบผลต่อเที่ยว)
    await expect(dlg.getByTestId('send-all-row').filter({ hasText: T.c!.tripNo })).toContainText(
      'ยังไม่กำหนดคนขับ',
    );
    await page.screenshot({ path: 'test-results/st3-send-all-dialog.png' });
    const sent = page.waitForResponse(sendAllOf(false));
    await dlg.getByRole('button', { name: 'ส่งแผน 3 เที่ยว' }).click();
    // ส่งจริง 3 เที่ยว (ปล่อยรถ + DO + audit/event) ใช้หลายวินาทีเมื่อเครื่องโหลดสูง — รอ response ก่อนตรวจ dialog ผล
    expect((await sent).status()).toBe(207);

    const fail = page.getByRole('dialog', { name: 'ทำไม่สำเร็จ 1 เที่ยว' });
    await expect(fail).toBeVisible();
    await expect(fail).toContainText('2 เที่ยวสำเร็จ');
    await expect(fail.getByTestId('bulk-fail')).toContainText(T.c!.tripNo);
    await expect(fail.getByTestId('bulk-fail')).toContainText('ยังไม่กำหนดคนขับ');
    expect((await tripNow(page, T.a!.id)).status).toBe('DISPATCHED');
    expect((await tripNow(page, T.b!.id)).status).toBe('DISPATCHED');
    expect((await tripNow(page, T.c!.id)).status).toBe('PLANNING');
    await fail.getByRole('button', { name: 'ปิด', exact: true }).last().click();
    await expect(head).not.toHaveAttribute('data-done', 'true');
  });

  test('เกณฑ์ตรวจรับ: ใส่คนขับแล้ว Send all อีกครั้ง → ทุกเที่ยวของวันเป็น DISPATCHED (DO ทุกใบ) และหัววันเป็นสีเขียว', async ({
    page,
  }) => {
    await driver(page, 'คนขับส่งแผน ค', vcId, 5);
    await page.goto('/plan');
    await page.getByRole('tab', { name: /^7 วัน/ }).click();
    const checked = page.waitForResponse(sendAllOf(true));
    await page.getByRole('button', { name: 'ส่งแผนให้คนขับ' }).click();
    const dlg = page.getByRole('dialog', { name: 'ส่งแผนให้คนขับ' });
    await dlg.getByRole('combobox', { name: 'วันที่' }).selectOption(DAY);
    await expect(dlg).toContainText('ส่งแล้ว 2 / 3 เที่ยว');
    expect((await checked).status()).toBe(207);
    await expect(dlg.getByTestId('send-all-row')).toHaveCount(1);
    // QA M1: ดับเบิลคลิก = ส่งครั้งเดียว (audit trip.sent_all ของวันนั้นเพิ่ม 1 แถว)
    const sentAudits = async () =>
      (
        (await (
          await page.request.get('/v1/audit-logs?entityType=trip&limit=100', { headers: H })
        ).json()) as { data: { action: string; after: { date?: string } | null }[] }
      ).data.filter((x) => x.action === 'trip.sent_all' && x.after?.date === DAY).length;
    const before = await sentAudits();
    const sent = page.waitForResponse(sendAllOf(false));
    await dlg.getByRole('button', { name: 'ส่งแผน 1 เที่ยว' }).dblclick();
    expect((await sent).status()).toBe(207);
    await expect(page.getByRole('status').filter({ hasText: 'ส่งแผน 1 เที่ยวแล้ว' })).toContainText(
      'ส่งครบแล้ว',
    );
    await expect.poll(sentAudits).toBe(before + 1);
    for (const t of [T.a!, T.b!, T.c!]) {
      const x = await tripNow(page, t.id);
      expect(x.status).toBe('DISPATCHED');
      expect(x.deliveryOrders.every((d) => d.status === 'DISPATCHED')).toBe(true);
    }
    // ปฏิทิน (หัววันในมุมมอง 7 วัน) ขึ้นเขียว
    const head = page.getByTestId(`week-day-${DAY}`);
    await expect(head).toHaveAttribute('data-done', 'true');
    await expect(head).toHaveCSS('background-color', 'rgb(231, 243, 236)');
    await expect(head).toHaveCSS('color', 'rgb(23, 115, 63)');
    await page.screenshot({ path: 'test-results/st3-send-all-week.png' });
    // เปิด dialog อีกครั้ง: วันนั้นไม่มีเที่ยวค้าง → แถบเขียว "ส่งแผนครบทุกเที่ยวแล้ว"
    await page.getByRole('button', { name: 'ส่งแผนให้คนขับ' }).click();
    await dlg.getByRole('combobox', { name: 'วันที่' }).selectOption(DAY);
    await expect(dlg.getByTestId('send-all-empty')).toContainText('ส่งแผนครบทุกเที่ยวแล้ว');
  });
});
