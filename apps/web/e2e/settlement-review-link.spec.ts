import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Browser, Page } from '@playwright/test';
import { E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST6-T05 รถร่วมตรวจใบสำคัญจ่ายผ่านลิงก์ (docs/04 F6 "รถร่วมตรวจผ่านลิงก์") — เกณฑ์ตรวจรับ:
 * รถร่วมเปิดลิงก์เห็นเฉพาะเที่ยวและราคาซื้อของตัวเอง · กดโต้แย้งแล้วรายการติดธง (บริษัทเห็นธง + อนุมัติไม่ได้)
 * ST6-T06 (Dispute): ใบมีรายการโต้แย้ง → หัวใบ DISPUTED อนุมัติไม่ได้ (409) → บริษัทยืนยันยอดเดิมพร้อมเหตุผล → รถร่วมเห็นเหตุผล ตอบซ้ำไม่ได้ → อนุมัติได้
 * เตรียมข้อมูลผ่าน /v1 จริง (ฐาน e2e) — จำลองเที่ยววิ่งจบในฐาน (flow วิ่งงานทดสอบใน ST3/ST4) แล้วปิดต้นทุนผ่าน API · ข้อมูลสมมติ
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

async function token(page: Page, email = 'owner@demo-a.test'): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await page.request.post('/v1/auth/login', {
    data: {
      email,
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

type Settlement = {
  id: string;
  version: number;
  carrierReview: { round: number; accepted: number; disputed: number; pending: number };
  lines: { id: string; lineType: string; carrierReview: { response: string } | null }[];
};

test.describe.serial('รถร่วมตรวจใบสำคัญจ่ายผ่านลิงก์ (ST6-T05)', () => {
  test.describe.configure({ timeout: 90_000 });
  let H: Record<string, string> = {};
  const S: { url?: string; id?: string; other?: string; otherUrl?: string } = {};

  const get = async <X>(page: Page, path: string) =>
    (await (await page.request.get(path, { headers: H })).json()) as X;

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (S.url) return;
    const post = async <X>(path: string, data: object, headers: Record<string, string> = {}) => {
      const r = await page.request.post(path, {
        headers: { ...H, ...headers, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), await r.text()).toBeLessThan(300);
      return (await r.json()) as X;
    };
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>(page, '/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `บจก. เอ็นเอสเอฟ อินดัสทรีตรวจบิล ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังบางปูตรวจบิล ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ท่าเรือแหลมฉบังตรวจบิล ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<Page1>(page, '/v1/units?limit=50')).data.find(
      (u) => u.code === 'TON',
    )!.id;
    const vt6 = (await get<Page1>(page, '/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;

    /** รถร่วม + เที่ยวที่วิ่งจบ (จำลองในฐาน) + ปิดต้นทุน → ใบร่าง → ส่งให้รถร่วมตรวจ */
    const make = async (n: number, cost: string) => {
      const c = await post<{ id: string }>('/v1/carriers', {
        legalName: `หจก. ศรีราชาโลจิสติกส์ตรวจบิล${n} ${RUN}`,
        entityType: 'JURISTIC',
        taxId: jurTax(Number(RUN) * 10 + 500 + n),
      });
      const v = await post<{ id: string }>('/v1/vehicles', {
        plate: `7${n}-${RUN.slice(-4)}`,
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
      const d = (await get<Page1>(page, `/v1/delivery-orders?orderId=${so.id}`)).data[0]!;
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
          vehicleId: uuidOf(v.id),
          vehiclePlateSnapshot: `7${n}-${RUN.slice(-4)}`,
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
      const s = await post<Settlement>('/v1/settlements', {
        carrierId: c.id,
        tripIds: [t.id],
        carrierInvoiceNo: `INV-${RUN}-${n}`,
        deductions: [
          {
            deductionType: 'CASH_ADVANCE',
            description: 'เบิกค่าน้ำมันล่วงหน้า',
            amount: '-1000.00',
            reference: `ADV-${RUN}`,
          },
        ],
      });
      const sent = await post<{ link: { url: string } }>(
        `/v1/settlements/${s.id}/send-to-carrier`,
        {},
        { 'If-Match': `"${s.version}"` },
      );
      return { id: s.id, url: sent.link.url };
    };
    const mine = await make(1, '5600');
    const other = await make(2, '9100');
    S.url = mine.url;
    S.id = mine.id;
    S.other = other.id;
    S.otherUrl = other.url;
  });

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

  test('เกณฑ์ตรวจรับ: เห็นเฉพาะเที่ยว/ราคาซื้อของตัวเอง → ยอมรับรายการหัก → โต้แย้งค่าจ้างพร้อมเหตุผล + รูป → ติดธง · บริษัทเห็นธง', async ({
    page,
    browser,
  }) => {
    const { ctx, p } = await mobile(browser, S.url!);
    await expect(p.getByTestId('stl-status')).toHaveText('รอตรวจ');
    await expect(p.getByRole('tab', { name: 'การเงิน' })).toBeVisible();
    await expect(p.getByTestId('stl-net')).toHaveText('4,600.00');
    const l1 = p.getByTestId('stl-line-1');
    await expect(l1).toContainText('5,600.00');
    await expect(l1).toContainText(`คลังบางปูตรวจบิล ${RUN} → ท่าเรือแหลมฉบังตรวจบิล ${RUN}`);
    await expect(p.getByTestId('stl-line-2')).toContainText('เงินเบิกล่วงหน้า');
    // ไม่มีราคาซื้อของรถร่วมรายอื่น / ไม่มีชื่อลูกค้า
    await expect(p.locator('body')).not.toContainText('9,100.00');
    await expect(p.locator('body')).not.toContainText('เอ็นเอสเอฟ');

    await p.getByTestId('stl-accept-2').click();
    await expect(p.getByTestId('stl-line-2')).toContainText('ยอมรับแล้ว');
    await expect(p.getByRole('status')).toContainText('ยอมรับรายการ 2 แล้ว');

    await p.getByTestId('stl-dispute-1').click();
    await p.getByTestId('stl-dispute-ok').click();
    await expect(p.getByRole('alert')).toHaveText('กรอกเหตุผลหรือแนบรูปอย่างน้อย 1 รูป');
    await p.getByTestId('stl-why').fill('ค่ารอไม่ตรง รอ 3 ชม.');
    await p.getByTestId('stl-photo-input').setInputFiles({
      name: 'waiting.png',
      mimeType: 'image/png',
      buffer: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(`photo-${RUN}`),
      ]),
    });
    await expect(p.getByRole('button', { name: 'ลบรูปที่ 1' })).toBeVisible();
    await p.getByTestId('stl-dispute-ok').click();
    await expect(l1).toContainText('โต้แย้ง');
    await expect(l1).toContainText('ค่ารอไม่ตรง รอ 3 ชม. · แนบรูป 1 รูป');
    // เปิดใหม่ — ธงยังอยู่ (บันทึกที่ server)
    await p.reload();
    await expect(p.getByTestId('stl-line-1')).toContainText('โต้แย้ง');
    await ctx.close();

    // บริษัทเห็นรายการติดธง (API เดียวกับ UI)
    const s = await get<Settlement>(page, `/v1/settlements/${S.id}`);
    expect(s.carrierReview).toEqual({ round: 1, accepted: 1, disputed: 1, pending: 0 });
    expect(s.lines.find((l) => l.lineType === 'FREIGHT')!.carrierReview!.response).toBe('DISPUTED');
    // ใบของรถร่วมอีกรายไม่ถูกแตะ
    const o = await get<Settlement>(page, `/v1/settlements/${S.other}`);
    expect(o.carrierReview).toMatchObject({ accepted: 0, disputed: 0 });
  });

  test('ลิงก์ที่ถูกเรียกกลับ/ปลอม → "ลิงก์นี้ใช้ไม่ได้"', async ({ page, browser }) => {
    const s = await get<Settlement>(page, `/v1/settlements/${S.id}`);
    const r = await page.request.post(`/v1/settlements/${S.id}/recall`, {
      headers: { ...H, 'If-Match': `"${s.version}"` },
      data: { reason: 'รถร่วมโต้แย้งค่ารอ ต้องแก้รายการ' },
    });
    expect(r.status(), await r.text()).toBe(200);
    const { ctx, p } = await mobile(browser, S.url!);
    await expect(p.getByText('ลิงก์นี้ใช้ไม่ได้')).toBeVisible();
    await ctx.close();
  });

  test('ST6-T06 เกณฑ์ตรวจรับ: รายการโต้แย้ง → หัวใบ "มีรายการโต้แย้ง" + อนุมัติ 409 → บริษัทยืนยันยอดเดิม → รถร่วมเห็นเหตุผล ตอบซ้ำไม่ได้ → อนุมัติได้', async ({
    page,
    browser,
  }) => {
    const { ctx, p } = await mobile(browser, S.otherUrl!);
    await expect(p.getByTestId('stl-status')).toHaveText('รอตรวจ');
    await p.getByTestId('stl-dispute-1').click();
    await p.getByTestId('stl-why').fill('เที่ยวนี้รอขึ้นของ 4 ชม. ยังไม่รวมค่ารอ');
    await p.getByTestId('stl-dispute-ok').click();
    await expect(p.getByTestId('stl-line-1')).toContainText('โต้แย้ง');
    await expect(p.getByTestId('stl-status')).toHaveText('มีรายการโต้แย้ง');

    // ผู้อนุมัติ (ไม่ใช่ผู้เตรียมใบ) กดอนุมัติไม่ได้ — 409 settlement_disputed
    const A = { Authorization: `Bearer ${await token(page, 'approver@demo-a.test')}` };
    const approve = async () => {
      const s = await get<Settlement & { status: string }>(page, `/v1/settlements/${S.other}`);
      return page.request.post(`/v1/settlements/${S.other}/approve`, {
        headers: { ...A, 'If-Match': `"${s.version}"` },
        data: { reason: 'ตรวจยอดตรงใบแจ้งหนี้รถร่วมแล้ว' },
      });
    };
    const blocked = await approve();
    expect(blocked.status(), await blocked.text()).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: 'settlement_disputed', disputedCount: 1 });

    // บริษัทยืนยันยอดเดิมพร้อมเหตุผล (ผู้เตรียมใบ)
    const s = await get<Settlement & { status: string }>(page, `/v1/settlements/${S.other}`);
    expect(s.status).toBe('DISPUTED');
    const line = s.lines.find((l) => l.lineType === 'FREIGHT')!;
    const r = await page.request.post(`/v1/settlements/${S.other}/lines/${line.id}/resolve`, {
      headers: { ...H, 'If-Match': `"${s.version}"` },
      data: { reason: 'ตรวจเวลาเข้าออกคลังแล้ว ค่ารอรวมในราคาเหมาตามสัญญา' },
    });
    expect(r.status(), await r.text()).toBe(200);
    expect((await r.json()).status).toBe('SENT_TO_CARRIER');

    await p.reload();
    await expect(p.getByTestId('stl-status')).toHaveText('รอตรวจ');
    await expect(p.getByTestId('stl-line-1')).toContainText('ยืนยันยอดเดิม');
    await expect(p.getByTestId('stl-resolved-1')).toHaveText(
      'บริษัทยืนยันยอดเดิม: ตรวจเวลาเข้าออกคลังแล้ว ค่ารอรวมในราคาเหมาตามสัญญา',
    );
    await expect(p.getByTestId('stl-dispute-1')).toHaveCount(0);
    await expect(p.getByTestId('stl-accept-2')).toBeVisible();
    await ctx.close();

    const ok = await approve();
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await ok.json()).status).toBe('APPROVED');

    // ST6-T09 เกณฑ์ตรวจรับ: บันทึกจ่าย (เจ้าของ — settlements:pay) → PAID · เที่ยว SETTLED ไม่กลับเข้าคิว · ลิงก์รถร่วมขึ้น "จ่ายแล้ว"
    const approved = await get<Settlement & { status: string; carrier: { id: string } }>(
      page,
      `/v1/settlements/${S.other}`,
    );
    const paid = await page.request.post(`/v1/settlements/${S.other}/mark-paid`, {
      headers: { ...H, 'If-Match': `"${approved.version}"` },
      data: { paidDate: today, method: 'TRANSFER', reference: 'KBANK-2611-0091' },
    });
    expect(paid.status(), await paid.text()).toBe(200);
    expect(await paid.json()).toMatchObject({ status: 'PAID', paymentMethod: 'TRANSFER' });
    const again = await page.request.post(`/v1/settlements/${S.other}/mark-paid`, {
      headers: { ...H, 'If-Match': `"${approved.version + 1}"` },
      data: { paidDate: today, method: 'CASH' },
    });
    expect(again.status()).toBe(409);
    const tripIds = [
      ...new Set(
        approved.lines.map((l) => (l as { tripId?: string | null }).tripId).filter(Boolean),
      ),
    ] as string[];
    for (const id of tripIds)
      expect((await get<{ status: string }>(page, `/v1/trips/${id}`)).status).toBe('SETTLED');
    expect(tripIds.length).toBeGreaterThan(0);
    const q = await get<{ data: { id: string }[] }>(
      page,
      `/v1/settlements/queue?carrierId=${approved.carrier.id}`,
    );
    expect(q.data).toEqual([]);
    const { ctx: c2, p: p2 } = await mobile(browser, S.otherUrl!);
    await expect(p2.getByTestId('stl-status')).toHaveText('จ่ายแล้ว');
    await expect(p2.getByText('จ่ายแล้ว · ตอบรายการไม่ได้แล้ว')).toBeVisible();
    await c2.close();
  });
});
