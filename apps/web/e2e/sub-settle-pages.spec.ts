import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { APIRequestContext, Page } from '@playwright/test';
import { DEMO_IDS, DEMO_TRUSTED_DEVICE, expect, test } from './fixtures';

/**
 * E2E หน้า "จ่ายงานรถร่วม" (`/sub`) + "สร้างงวดใหม่" ของหน้า `settle` (UAT 24 พ.ย. 2569)
 * - /sub: owner จ้างรถร่วม 2 เที่ยวผ่าน /v1 (รายหนึ่งปฏิเสธผ่านลิงก์) → KPI/แท็บ/แถว/drawer "จ่ายงานรถร่วม"
 * - settle: เที่ยวรถร่วมวิ่งจบ + ปิดต้นทุน (จำลองในฐาน e2e แบบ settle-page.spec.ts) → ผู้ดูแลกด "สร้างงวดใหม่" ติ๊กเที่ยว
 *   + รายการหักเงินเบิก → ร่างใบสำคัญจ่าย (drawer เปิด) → แถว "รอตรวจ" ยอดตรง · ข้อมูลสมมติ
 */
const env = Object.fromEntries(
  readFileSync(new URL('./.env.e2e', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1]!, m[2]!]),
);
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });
test.afterAll(async () => db.$disconnect());

const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const CARRIER = `หจก. บางนาขนส่งจ่ายงาน ${RUN}`;
const CARRIER2 = `หจก. ปฏิเสธงานขนส่ง ${RUN}`;
const uuidOf = (id: string) => {
  const h = id.split('_')[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
function jurTax(n: number): string {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

/**
 * token ของ owner (ผู้สร้างใบ) ผ่าน request context แยก (ไม่ใช่ของหน้า — ไม่ทับ refresh cookie ของผู้ใช้ที่ login หน้าเว็บ)
 * owner บังคับ 2FA → ส่ง cookie อุปกรณ์ที่จำไว้ของ seed
 */
async function ownerToken(req: APIRequestContext): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await req.post('/v1/auth/login', {
    data: {
      email: 'owner@demo-a.test',
      password: 'demo-password-2569',
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
    headers: { Cookie: `tms_td=${DEMO_TRUSTED_DEVICE}:${DEMO_IDS['owner@demo-a.test']}` },
  });
  expect(r1.status(), await r1.text()).toBe(200);
  const { code } = (await r1.json()) as { code: string };
  const r2 = await req.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  });
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

const S: { trip?: string; c?: string } = {};

/** owner: รถร่วม 2 ราย · เที่ยว 1 จ้าง CARRIER (รอตอบ → จำลองวิ่งจบ + ปิดต้นทุน หลังทดสอบ /sub) · เที่ยว 2 จ้าง CARRIER2 แล้วปฏิเสธผ่านลิงก์ */
async function prepare(req: APIRequestContext) {
  if (S.trip) return;
  const H = { Authorization: `Bearer ${await ownerToken(req)}` };
  const get = async <X>(path: string) => (await (await req.get(path, { headers: H })).json()) as X;
  const post = async <X>(path: string, data: object, headers: Record<string, string> = {}) => {
    const r = await req.post(path, {
      headers: { ...H, ...headers, 'Idempotency-Key': randomUUID() },
      data,
    });
    expect(r.status(), await r.text()).toBeLessThan(300);
    return (await r.json()) as X;
  };
  type Page1 = { data: { id: string; code?: string }[] };
  const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
  const cust = await post<{ id: string }>('/v1/customers', {
    legalName: `บจก. ลูกค้าจ่ายงาน ${RUN}`,
    billingCompanyId: company,
  });
  const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
  const a = await post<{ id: string }>('/v1/customer-sites', {
    name: `คลังบางนาจ่ายงาน ${RUN}`,
    kind: 'PICKUP',
    address: addr('สมุทรปราการ'),
  });
  const b = await post<{ id: string }>('/v1/customer-sites', {
    name: `ท่าเรือจ่ายงาน ${RUN}`,
    kind: 'DROPOFF',
    address: addr('ชลบุรี'),
  });
  const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
  const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
    (x) => x.code === '6W',
  )!.id;
  const c = await post<{ id: string }>('/v1/carriers', {
    legalName: CARRIER,
    entityType: 'JURISTIC',
    taxId: jurTax(Number(RUN) * 10 + 710),
  });
  const c2 = await post<{ id: string }>('/v1/carriers', {
    legalName: CARRIER2,
    entityType: 'JURISTIC',
    taxId: jurTax(Number(RUN) * 10 + 720),
  });
  const v = await post<{ id: string }>('/v1/vehicles', {
    plate: `76-${RUN.slice(-4)}`,
    plateProvince: 'TH-20',
    vehicleTypeId: vt6,
    ownership: 'SUBCONTRACT',
    carrierId: c.id,
  });
  const trip = async () => {
    const so = await post<{ id: string }>('/v1/orders', {
      customer: { id: cust.id },
      requestedDate: today,
      vehicleTypeId: vt6,
      stops: [
        { type: 'PICKUP', siteId: a.id },
        { type: 'DELIVERY', siteId: b.id },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: '8600' }],
    });
    const d = (await get<Page1>(`/v1/delivery-orders?orderId=${so.id}`)).data[0]!;
    const t = await post<{ id: string }>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [d.id],
    });
    return { t, d };
  };
  const one = await trip();
  await post(`/v1/trips/${one.t.id}/offer`, {
    carrierId: c.id,
    cost: '8000',
    selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว',
  });
  const two = await trip();
  await post(`/v1/trips/${two.t.id}/offer`, {
    carrierId: c2.id,
    cost: '7500',
    selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว',
  });
  const l = await get<{ link: { url: string } }>(`/v1/trips/${two.t.id}/offer-link`);
  const tok = new URL(l.link.url).pathname.split('/').pop()!;
  const r = await req.post(`/v1/public/offers/${tok}/reject`, {
    data: { reason: 'PRICE_TOO_LOW' },
  });
  expect(r.status(), await r.text()).toBe(200);
  S.trip = one.t.id;
  S.c = c.id;
  // ใช้ตอนเตรียมเที่ยววิ่งจบ (ส่วน settle)
  Object.assign(S, { v: v.id, vt6, d: one.d.id, H });
}

/** จำลองเที่ยว 1 รับงาน + วิ่งจบ + หลักฐานครบ → ปิดต้นทุน (COSTED = ขึ้นคิวจ่าย) */
async function complete(req: APIRequestContext) {
  const x = S as unknown as {
    trip: string;
    v: string;
    vt6: string;
    d: string;
    H: Record<string, string>;
  };
  const tid = uuidOf(x.trip);
  await db.subconOffer.updateMany({
    where: { tripId: tid, status: 'OFFERED' },
    data: { status: 'ACCEPTED', respondedAt: new Date(), respondedVia: 'USER' },
  });
  await db.trip.update({
    where: { id: tid },
    data: {
      status: 'COMPLETED',
      vehicleId: uuidOf(x.v),
      vehiclePlateSnapshot: `76-${RUN.slice(-4)}`,
      vehicleTypeId: uuidOf(x.vt6),
      assignmentStatus: 'ACCEPTED',
      completedAt: new Date(),
      version: { increment: 1 },
    },
  });
  await db.deliveryOrder.update({
    where: { id: uuidOf(x.d) },
    data: { status: 'UNBILLED', podStatus: 'COMPLETE' },
  });
  const r = await req.post(`/v1/trips/${x.trip}/cost`, {
    headers: { ...x.H, 'Idempotency-Key': randomUUID() },
    data: {},
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
}

/** แถวข้อมูล (ไม่รวมแถวตัวกรองที่มีชื่อผู้รับเหมาในตัวเลือก) */
const row = (page: Page, name: string) =>
  page.locator('tr[aria-selected]').filter({ hasText: name });

test.describe.serial('หน้าจ่ายงานรถร่วม + สร้างงวดใหม่ (UAT 24 พ.ย.)', () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ loginEmail: 'admin@demo-a.test' });

  test('/sub: เมนูเปิดหน้าได้ (ไม่ใช่ "ยังไม่เปิดใช้") · KPI/แท็บ/คอลัมน์ต้นแบบ · ปฏิเสธ/หมดเวลา · drawer จ่ายงานรถร่วม', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await page.goto('/sub');
    await expect(page.getByRole('heading', { name: 'จ่ายงานรถร่วม' })).toBeVisible();
    await expect(page.getByText('ยังไม่เปิดใช้')).toHaveCount(0);
    for (const h of [
      'เลข SO / DO',
      'เส้นทาง',
      'วันที่ส่ง',
      'ผู้รับเหมา',
      'ราคาซื้อ (฿)',
      'Margin',
      'ส่งข้อเสนอเมื่อ',
      'หมดเวลาใน',
      'สถานะ',
    ])
      await expect(page.getByRole('columnheader', { name: h })).toBeVisible();
    await expect(row(page, CARRIER)).toContainText('รอตอบ');
    await expect(row(page, CARRIER)).toContainText('8,000.00');
    await expect(row(page, CARRIER)).toContainText(/เหลือ \d+ ชม\./);
    await expect(row(page, CARRIER2)).toContainText('ปฏิเสธ');

    await page.getByRole('button', { name: /ปฏิเสธ \/ หมดเวลา/ }).click();
    await expect(row(page, CARRIER2)).toBeVisible();
    await expect(row(page, CARRIER)).toHaveCount(0);
    await page.getByRole('tab', { name: /รอตอบ/ }).click();
    await expect(row(page, CARRIER)).toBeVisible();
    await expect(row(page, CARRIER2)).toHaveCount(0);

    await row(page, CARRIER).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('จ่ายงานรถร่วม');
    await expect(drawer).toContainText(CARRIER);
    await drawer.getByRole('button', { name: 'ปิด' }).first().click();
    await page.getByRole('tab', { name: 'ทั้งหมด' }).click();
  });

  test('settle: "สร้างงวดใหม่" → ติ๊กเที่ยว + หักเงินเบิก → ร่างใบสำคัญจ่าย (drawer + แถวรอตรวจ ยอดตรง)', async ({
    page,
    request,
  }) => {
    await prepare(request);
    await complete(request);
    await page.goto('/settle');
    await page.getByRole('button', { name: 'สร้างงวดใหม่' }).click();
    const form = page.getByRole('dialog', { name: 'สร้างงวดใหม่' });
    const pick = form.getByRole('combobox', { name: /^ผู้รับเหมา/ });
    const val = await pick.locator('option', { hasText: CARRIER }).getAttribute('value');
    await pick.selectOption(val!);
    const trips = form.getByTestId('settle-new-trips');
    await expect(trips.getByRole('row')).toHaveCount(2);
    // กดสร้างโดยไม่เลือกเที่ยว → แจ้งให้เลือก
    await form.getByRole('button', { name: 'สร้างร่าง' }).click();
    await expect(form).toContainText('เลือกอย่างน้อย 1 เที่ยว');
    await trips.getByRole('row').nth(1).click();
    await expect(form.getByTestId('settle-new-sum')).toContainText(
      'เลือก 1 เที่ยว · ยอดซื้อ ฿8,000.00',
    );
    await form.getByRole('button', { name: 'เพิ่มรายการหัก' }).click();
    await form.getByRole('textbox', { name: /^ยอดหัก/ }).fill('1000');
    await form.getByRole('textbox', { name: /^รายละเอียด/ }).fill('เบิกค่าน้ำมันล่วงหน้า');
    await form.getByRole('textbox', { name: /^เอกสารอ้างอิง/ }).fill(`ADV-${RUN}`);
    await expect(form.getByTestId('settle-new-sum')).toContainText(
      'หัก ฿1,000.00 · สุทธิก่อนหัก ณ ที่จ่าย ฿7,000.00',
    );
    await form.getByRole('button', { name: 'สร้างร่าง' }).click();
    await expect(page.getByRole('status')).toContainText('สร้างร่างใบสำคัญจ่ายแล้ว');
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('Settlement รถร่วม');
    await expect(drawer).toContainText('หักเงินเบิกล่วงหน้า');
    await drawer.getByRole('button', { name: 'ปิด' }).first().click();
    await page.getByRole('tab', { name: /รอตรวจ/ }).click();
    // ยอดซื้อ 8,000 · หัก = WHT 1% 80 + เงินเบิก 1,000 · สุทธิหลัง WHT 6,920 (กฎเดียวกับ settle-page.spec.ts)
    await expect(row(page, CARRIER)).toContainText('8,000.00');
    await expect(row(page, CARRIER)).toContainText('1,080.00');
    await expect(row(page, CARRIER)).toContainText('6,920.00');
    // เที่ยวอยู่ในใบแล้ว → ไม่ขึ้นคิวอีก (กันจ่ายซ้ำ)
    await page.getByRole('button', { name: 'สร้างงวดใหม่' }).click();
    const again = page.getByRole('dialog', { name: 'สร้างงวดใหม่' });
    await expect(again.getByRole('combobox', { name: /^ผู้รับเหมา/ })).not.toContainText(CARRIER);
  });
});
