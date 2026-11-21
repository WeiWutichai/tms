import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { APIRequestContext, Page } from '@playwright/test';
import { DEMO_IDS, DEMO_TRUSTED_DEVICE, expect, test } from './fixtures';

/**
 * E2E หน้า "Settlement รถร่วม" (`/settle` — ต้นแบบ TMS v4 `settle`; ST6-T07/T09 + D-60 + D-63)
 * ผู้สร้างใบ (owner) เตรียมใบผ่าน /v1 → ผู้ดูแล (admin) อนุมัติในหน้าเว็บ → ผู้ดูแลกดบันทึกจ่ายเอง = ข้อความไทย D-60 ในกล่อง →
 * "ออกลิงก์ใหม่" (D-63) ได้ลิงก์ดูอย่างเดียว → owner บันทึกจ่าย → แท็บ "จ่ายแล้ว"
 * เตรียมข้อมูลแบบเดียวกับ settlement-review-link.spec.ts (จำลองเที่ยววิ่งจบในฐาน e2e) · ข้อมูลสมมติ
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
const CARRIER = `หจก. บางนาขนส่งหน้าจ่าย ${RUN}`;
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

const S: { id?: string } = {};

/** owner: รถร่วม + เที่ยววิ่งจบ + ปิดต้นทุน → ใบร่าง (ค่าจ้าง 8,000 หักเงินเบิก 1,000) → ส่งรถร่วมตรวจ (SENT_TO_CARRIER = แท็บ "รออนุมัติ") */
async function prepare(req: APIRequestContext) {
  if (S.id) return;
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
    legalName: `บจก. ลูกค้าหน้าจ่าย ${RUN}`,
    billingCompanyId: company,
  });
  const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
  const a = await post<{ id: string }>('/v1/customer-sites', {
    name: `คลังบางนาหน้าจ่าย ${RUN}`,
    kind: 'PICKUP',
    address: addr('สมุทรปราการ'),
  });
  const b = await post<{ id: string }>('/v1/customer-sites', {
    name: `ท่าเรือหน้าจ่าย ${RUN}`,
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
    taxId: jurTax(Number(RUN) * 10 + 700),
  });
  const v = await post<{ id: string }>('/v1/vehicles', {
    plate: `75-${RUN.slice(-4)}`,
    plateProvince: 'TH-20',
    vehicleTypeId: vt6,
    ownership: 'SUBCONTRACT',
    carrierId: c.id,
  });
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
  const t = await post<{ id: string }>('/v1/trips', { tripDate: today, deliveryOrderIds: [d.id] });
  await post(`/v1/trips/${t.id}/offer`, {
    carrierId: c.id,
    cost: '8000',
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
      vehicleId: uuidOf(v.id),
      vehiclePlateSnapshot: `75-${RUN.slice(-4)}`,
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
  const s = await post<{ id: string; version: number }>('/v1/settlements', {
    carrierId: c.id,
    tripIds: [t.id],
    carrierInvoiceNo: `INV-${RUN}`,
    deductions: [
      {
        deductionType: 'CASH_ADVANCE',
        description: 'เบิกค่าน้ำมันล่วงหน้า',
        amount: '-1000.00',
        reference: `ADV-${RUN}`,
      },
    ],
  });
  await post(`/v1/settlements/${s.id}/send-to-carrier`, {}, { 'If-Match': `"${s.version}"` });
  S.id = s.id;
}

const row = (page: Page) => page.getByRole('row').filter({ hasText: CARRIER });

test.describe.serial('หน้า Settlement รถร่วม (settle)', () => {
  test.describe.configure({ timeout: 90_000 });

  test.describe('ผู้ดูแล (อนุมัติ + D-60 + D-63)', () => {
    test.use({ loginEmail: 'admin@demo-a.test' });

    test('อนุมัติในหน้าเว็บ → บันทึกจ่ายเองได้ข้อความไทย D-60 → ออกลิงก์ใหม่ (ดูอย่างเดียว)', async ({
      page,
      request,
    }) => {
      await prepare(request);
      await page.goto('/settle');
      await expect(page.getByRole('heading', { name: 'Settlement รถร่วม' })).toBeVisible();
      await page.getByRole('tab', { name: /รออนุมัติ/ }).click();
      await expect(row(page)).toContainText('ร่าง (ยังไม่มีเลข)');
      // ยอดซื้อ 8,000 · หัก = WHT 1% 80 + เงินเบิก 1,000 · สุทธิหลัง WHT 6,920
      await expect(row(page)).toContainText('8,000.00');
      await expect(row(page)).toContainText('1,080.00');
      await expect(row(page)).toContainText('6,920.00');
      await row(page).click();

      const drawer = page.getByRole('dialog');
      await expect(drawer).toContainText('Settlement รถร่วม');
      await expect(drawer).toContainText('หักเงินเบิกล่วงหน้า');
      await expect(drawer).toContainText('หัก ณ ที่จ่าย 1%');
      await drawer.getByRole('button', { name: 'อนุมัติ' }).click();

      const dlg = page.getByRole('dialog', { name: /อนุมัติ/ });
      await dlg.getByLabel(/เหตุผล/).fill('ตรวจยอดตรงใบแจ้งหนี้รถร่วมแล้ว');
      await dlg.getByRole('button', { name: 'อนุมัติ' }).click();
      await expect(page.getByRole('status')).toContainText(/อนุมัติ SA-\S+ แล้ว/);

      // D-60: ผู้อนุมัติบันทึกจ่ายใบนี้เองไม่ได้ → ข้อความไทยในกล่อง (ไม่ปิดกล่อง)
      const d2 = page.getByRole('dialog').filter({ hasText: CARRIER }).first();
      await expect(d2).toContainText('อนุมัติแล้ว');
      await d2.getByRole('button', { name: 'บันทึกจ่าย' }).click();
      const pay = page.getByRole('dialog', { name: /บันทึกจ่าย/ });
      await expect(pay).toContainText('จ่ายสุทธิ');
      await expect(pay).toContainText('6,920.00');
      await pay.getByPlaceholder('เช่น KBANK-2611-0091').fill(`KBANK-${RUN}`);
      await pay.getByRole('button', { name: 'บันทึกจ่าย' }).click();
      await expect(pay.getByRole('alert')).toHaveText(
        'ผู้อนุมัติใบสำคัญจ่าย บันทึกจ่ายใบนั้นเองไม่ได้ ต้องให้ผู้อื่นบันทึกจ่าย',
      );
      await pay.getByRole('button', { name: 'ยกเลิก' }).click();

      // D-63: เมนู ⋯ ของ drawer → ออกลิงก์ใหม่ → กล่องลิงก์ (ดูอย่างเดียว — D-59)
      await d2.getByRole('button', { name: 'เพิ่มเติม' }).click();
      await page.getByRole('menuitem', { name: 'ออกลิงก์ใหม่' }).click();
      await expect(page.getByRole('status')).toContainText('ออกลิงก์ใหม่แล้ว');
      const box = page.getByTestId('settle-link');
      await expect(box).toContainText('/link/settlement/');
      await expect(box).toContainText('ลิงก์ดูอย่างเดียว');
    });
  });

  test.describe('เจ้าของ (บันทึกจ่าย)', () => {
    test('บันทึกจ่ายจากเมนูแถว → แท็บ "จ่ายแล้ว"', async ({ page, request }) => {
      await prepare(request);
      await page.goto('/settle');
      await page.getByRole('tab', { name: /อนุมัติแล้ว/ }).click();
      await row(page).getByRole('button', { name: 'การกระทำ' }).click();
      await page.getByRole('menuitem', { name: 'บันทึกจ่าย' }).click();
      const pay = page.getByRole('dialog', { name: /บันทึกจ่าย/ });
      await pay.getByPlaceholder('เช่น KBANK-2611-0091').fill(`KBANK-${RUN}`);
      await pay.getByRole('button', { name: 'บันทึกจ่าย' }).click();
      await expect(page.getByRole('status')).toContainText(/บันทึกจ่าย SA-\S+ แล้ว/);
      await page.getByRole('tab', { name: /จ่ายแล้ว/ }).click();
      await expect(row(page)).toContainText('จ่ายแล้ว');
    });
  });
});
