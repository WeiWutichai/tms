import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { APIRequestContext, Browser } from '@playwright/test';
import { DEMO_IDS, DEMO_TRUSTED_DEVICE, E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST6-T11 ลิงก์ "ค่าเที่ยวของฉัน" ของรถร่วม (docs/04 F7; ต้นแบบ TMS Subcon แท็บ "การเงิน") — เกณฑ์ตรวจรับ:
 * carrier เปิดลิงก์เห็นเฉพาะของตัวเอง (เที่ยวที่จบ ยอด สถานะจ่าย) · ออกลิงก์จากหน้า settle (เมนูแถว — แบบ D-63) · PDF ใบจ่ายเงินของงวดที่จ่ายแล้ว
 * เตรียมข้อมูลแบบ settle-page.spec.ts (จำลองเที่ยววิ่งจบในฐาน e2e แล้วปิดต้นทุนผ่าน API) · ข้อมูลสมมติ
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
const CARRIER = `หจก. ศรีราชาค่าเที่ยว ${RUN}`;
const OTHER = `หจก. รายอื่นค่าเที่ยว ${RUN}`;
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

/** token ผ่าน request context แยก · owner บังคับ 2FA → ส่ง cookie อุปกรณ์ที่จำไว้ของ seed */
async function tokenOf(req: APIRequestContext, email: string): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await req.post('/v1/auth/login', {
    data: {
      email,
      password: 'demo-password-2569',
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
    headers:
      email === 'owner@demo-a.test'
        ? { Cookie: `tms_td=${DEMO_TRUSTED_DEVICE}:${DEMO_IDS[email]}` }
        : {},
  });
  expect(r1.status(), await r1.text()).toBe(200);
  const { code } = (await r1.json()) as { code: string };
  const r2 = await req.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  });
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

const S: { ready?: boolean; paidId?: string; url?: string } = {};

/**
 * รถร่วม A: เที่ยว 1 (5,600) งวดจ่ายแล้ว · เที่ยว 2 (3,000) งวดรอตรวจ · เที่ยว 3 (4,200) จบแล้วยังไม่เข้างวด
 * รถร่วม B (บริษัทเดียวกัน): เที่ยว (9,100) งวดรอตรวจ — ต้องไม่โผล่ในลิงก์ของ A
 */
async function prepare(req: APIRequestContext) {
  if (S.ready) return;
  const H = { Authorization: `Bearer ${await tokenOf(req, 'owner@demo-a.test')}` };
  const A = { Authorization: `Bearer ${await tokenOf(req, 'approver@demo-a.test')}` };
  const get = async <X>(path: string) => (await (await req.get(path, { headers: H })).json()) as X;
  const post = async <X>(path: string, data: object, headers: Record<string, string> = H) => {
    const r = await req.post(path, {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data,
    });
    expect(r.status(), await r.text()).toBeLessThan(300);
    return (await r.json()) as X;
  };
  type Page1 = { data: { id: string; code?: string }[] };
  const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
  const cust = await post<{ id: string }>('/v1/customers', {
    legalName: `บจก. ลูกค้าลับค่าเที่ยว ${RUN}`,
    billingCompanyId: company,
  });
  const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
  const a = await post<{ id: string }>('/v1/customer-sites', {
    name: `บางปูค่าเที่ยว ${RUN}`,
    kind: 'PICKUP',
    address: addr('สมุทรปราการ'),
  });
  const b = await post<{ id: string }>('/v1/customer-sites', {
    name: `แหลมฉบังค่าเที่ยว ${RUN}`,
    kind: 'DROPOFF',
    address: addr('ชลบุรี'),
  });
  const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
  const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
    (x) => x.code === '6W',
  )!.id;
  const carrier = async (name: string, n: number) => {
    const c = await post<{ id: string }>('/v1/carriers', {
      legalName: name,
      entityType: 'JURISTIC',
      taxId: jurTax(Number(RUN) * 10 + 800 + n),
    });
    const v = await post<{ id: string }>('/v1/vehicles', {
      plate: `7${n}-${RUN.slice(-4)}`,
      plateProvince: 'TH-20',
      vehicleTypeId: vt6,
      ownership: 'SUBCONTRACT',
      carrierId: c.id,
    });
    return { id: c.id, vehicle: v.id };
  };
  /** เที่ยววิ่งจบ (จำลองในฐาน) + ปิดต้นทุน */
  const trip = async (c: { id: string; vehicle: string }, cost: string) => {
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
    await post(`/v1/trips/${t.id}/offer`, {
      carrierId: c.id,
      cost,
      selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว',
    });
    const tid = uuidOf(t.id);
    await db.subconOffer.updateMany({
      where: { tripId: tid, status: 'OFFERED' },
      data: { status: 'ACCEPTED', respondedAt: new Date(), respondedVia: 'USER' },
    });
    await db.trip.update({
      where: { id: tid },
      data: {
        status: 'COMPLETED',
        vehicleId: uuidOf(c.vehicle),
        vehiclePlateSnapshot: 'ทดสอบ',
        vehicleTypeId: uuidOf(vt6),
        assignmentStatus: 'ACCEPTED',
        completedAt: new Date(),
        version: { increment: 1 },
      },
    });
    await db.deliveryOrder.update({
      where: { id: uuidOf(d.id) },
      data: { status: 'UNBILLED', podStatus: 'COMPLETE' },
    });
    await post(`/v1/trips/${t.id}/cost`, {});
    return t.id;
  };
  type Stl = { id: string; version: number };
  const sent = async (carrierId: string, tripId: string) => {
    const s = await post<Stl>('/v1/settlements', { carrierId, tripIds: [tripId] });
    await post(
      `/v1/settlements/${s.id}/send-to-carrier`,
      {},
      { ...H, 'If-Match': `"${s.version}"` },
    );
    return s.id;
  };
  const version = async (id: string) => (await get<Stl>(`/v1/settlements/${id}`)).version;

  const ca = await carrier(CARRIER, 1);
  const paid = await sent(ca.id, await trip(ca, '5600'));
  await post(
    `/v1/settlements/${paid}/approve`,
    { reason: 'ตรวจยอดตรงใบแจ้งหนี้รถร่วมแล้ว' },
    { ...A, 'If-Match': `"${await version(paid)}"` },
  );
  await post(
    `/v1/settlements/${paid}/mark-paid`,
    { paidDate: today, method: 'TRANSFER', reference: `KBANK-${RUN}` },
    { ...H, 'If-Match': `"${await version(paid)}"` },
  );
  await sent(ca.id, await trip(ca, '3000'));
  await trip(ca, '4200');
  const cb = await carrier(OTHER, 2);
  await sent(cb.id, await trip(cb, '9100'));
  S.paidId = paid;
  S.ready = true;
}

const mobile = async (browser: Browser, url: string) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
  });
  const p = await ctx.newPage();
  await p.goto(`${E2E_WEB}${new URL(url).pathname}`);
  return { ctx, p };
};

test.describe.serial('ลิงก์ค่าเที่ยวของฉัน (ST6-T11)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('หน้า settle: เมนูแถว "ลิงก์ค่าเที่ยวของรถร่วม" → กล่องลิงก์ (ดูอย่างเดียว) → รถร่วมเปิดบนมือถือเห็นเฉพาะของตัวเอง', async ({
    page,
    request,
    browser,
  }) => {
    await prepare(request);
    await page.goto('/settle');
    await page.getByRole('tab', { name: /จ่ายแล้ว/ }).click();
    const row = page.getByRole('row').filter({ hasText: CARRIER });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'การกระทำ' }).click();
    await page.getByRole('menuitem', { name: 'ลิงก์ค่าเที่ยวของรถร่วม' }).click();
    await expect(page.getByRole('status')).toContainText('ออกลิงก์ค่าเที่ยวแล้ว');
    const box = page.getByTestId('settle-link');
    await expect(box).toContainText('/link/carrier-pay/');
    await expect(box).toContainText('ลิงก์ค่าเที่ยวของฉัน (ดูอย่างเดียว)');
    await page.screenshot({ path: test.info().outputPath('t611-real-1440-settle.png') });
    S.url = (await box.locator('[title]').first().getAttribute('title'))!;
    expect(S.url).toContain('/link/carrier-pay/');

    const { ctx, p } = await mobile(browser, S.url);
    await expect(p.getByText(`${CARRIER} · เปิดจากลิงก์ LINE ไม่ต้องเข้าสู่ระบบ`)).toBeVisible();
    await expect(p.getByRole('tab', { name: 'การเงิน' })).toBeVisible();
    // รอรับเงิน = งวดรอตรวจ 3,000 − หัก ณ ที่จ่าย 1% (ประมาณการ) = 2,970.00
    const due = p.getByTestId('cpl-due');
    await expect(due).toContainText('2,970.00');
    await expect(due).toContainText('1 งวด · จ่ายภายใน 30 วันหลังอนุมัติ');
    const paid = p.getByTestId(`cpl-stl-${S.paidId}`);
    await expect(paid).toContainText('จ่ายแล้ว');
    await expect(paid).toContainText('5,544.00');
    await expect(paid).toContainText('1 เที่ยว');
    await expect(p.getByText('รอตรวจ', { exact: true })).toBeVisible();
    await expect(p.getByText('เที่ยวที่จบ · ยังไม่เข้างวด')).toBeVisible();
    const tr = p.getByTestId('cpl-trip');
    await expect(tr).toHaveCount(1);
    await expect(tr).toContainText('4,200.00');
    await expect(tr).toContainText(`บางปูค่าเที่ยว ${RUN} → แหลมฉบังค่าเที่ยว ${RUN}`);
    // ไม่มีของรถร่วมรายอื่น / ชื่อลูกค้า / 50 ทวิ
    await expect(p.locator('body')).not.toContainText('9,100.00');
    await expect(p.locator('body')).not.toContainText('ลูกค้าลับ');
    await expect(p.locator('body')).not.toContainText('50 ทวิ');
    await p.screenshot({ path: test.info().outputPath('t611-real-390.png'), fullPage: true });
    // ใบจ่ายเงิน (PDF) ของงวดที่จ่ายแล้ว
    const href = (await paid.getByTestId('cpl-pdf').getAttribute('href'))!;
    const r = await p.request.get(`${E2E_WEB}${href}`);
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('application/pdf');
    await ctx.close();
  });

  test('ออกลิงก์ใหม่ → ลิงก์เดิม "ลิงก์นี้ใช้ไม่ได้" · token ปลอมก็เช่นกัน', async ({
    page,
    request,
    browser,
  }) => {
    await prepare(request);
    expect(S.url).toBeTruthy();
    await page.goto('/settle');
    await page.getByRole('tab', { name: /จ่ายแล้ว/ }).click();
    const row = page.getByRole('row').filter({ hasText: CARRIER });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'การกระทำ' }).click();
    await page.getByRole('menuitem', { name: 'ลิงก์ค่าเที่ยวของรถร่วม' }).click();
    await expect(page.getByTestId('settle-link')).toContainText('/link/carrier-pay/');
    const { ctx, p } = await mobile(browser, S.url!);
    await expect(p.getByText('ลิงก์นี้ใช้ไม่ได้')).toBeVisible();
    await p.goto(`${E2E_WEB}/link/carrier-pay/ml1.bogus`);
    await expect(p.getByText('ลิงก์นี้ใช้ไม่ได้')).toBeVisible();
    await ctx.close();
  });
});
