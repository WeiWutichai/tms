import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST3-T25 เปลี่ยนผู้รับเหมา (docs/04 D3 "เปลี่ยน carrier — ยกเลิกการจ้างเดิมแล้วจ้างใหม่ (ประวัติคงอยู่)")
 * เกณฑ์ตรวจรับ: เปลี่ยน carrier แล้ว history มีทั้งรายเดิม (ยกเลิก) และรายใหม่; `trip_cost` เดิมถูกกลับรายการ
 * ทางเข้า UI: drawer เที่ยว → "จ่ายงานรถร่วม" → ⋯ "เปลี่ยนผู้รับเหมา" → เหตุผล → เลือกรายใหม่ → "ส่งข้อเสนอ" · ข้อมูลสมมติ
 */
const env = Object.fromEntries(
  readFileSync(new URL('./.env.e2e', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], m[2]]),
);
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });

const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const PLATE = `71-${RUN.slice(-4)}`;
const PHONE = `08${String(30_000_000 + Number(RUN)).slice(-8)}`;
const REASON = 'รถของผู้รับเหมาเดิมเสียก่อนเข้ารับสินค้า';

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
  version: number;
  carrier: { name: string } | null;
  vehicle: { plate: string } | null;
  driver: { name: string } | null;
};

test.describe.serial('เปลี่ยนผู้รับเหมา (ST3-T25)', () => {
  let HDR: Record<string, string> = {};
  const S: {
    A?: { id: string; name: string };
    B?: { id: string; name: string };
    t1?: Trip;
    t2?: Trip;
    url2?: string;
  } = {};

  test.afterAll(async () => db.$disconnect());

  const get = async <X>(page: Page, path: string) =>
    (await (await page.request.get(path, { headers: HDR })).json()) as X;

  test.beforeEach(async ({ page }) => {
    HDR = { Authorization: `Bearer ${await token(page)}` };
    if (S.t1) return;
    const post = async <X>(path: string, data: object) => {
      const r = await page.request.post(path, {
        headers: { ...HDR, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), await r.text()).toBeLessThan(300);
      return (await r.json()) as X;
    };
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>(page, '/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `บจก. ลูกค้าเปลี่ยนรายอีทูอี ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังบางนาเปลี่ยนราย ${RUN}`,
      kind: 'PICKUP',
      address: addr('กรุงเทพมหานคร'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ร้านชลบุรีเปลี่ยนราย ${RUN}`,
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
    /** รถร่วม + รถ 6 ล้อ (ประกัน/พ.ร.บ. ครบ) + คนขับ + rate card ขาซื้อ a → b */
    const carrier = async (i: number, rate: string) => {
      const name = `หจก. เปลี่ยนราย${i === 1 ? 'เอ' : 'บี'}อีทูอี ${RUN}`;
      const c = await post<{ id: string }>('/v1/carriers', {
        legalName: name,
        entityType: 'JURISTIC',
        taxId: jurTax(Number(RUN) + 900 + i),
      });
      const v = await post<{ id: string }>('/v1/vehicles', {
        plate: i === 1 ? PLATE : `72-${RUN.slice(-4)}`,
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
          headers: { ...HDR, 'Content-Type': 'application/octet-stream' },
          data: PDF,
        });
        expect(put.status(), await put.text()).toBe(200);
        await post(`/v1/vehicles/${v.id}/documents`, {
          docType,
          docNo: `${docType.slice(0, 3)}-${RUN}${i}`,
          ...(docType === 'INSURANCE'
            ? { issuer: 'บริษัท ประกันสมมติ จำกัด', insuranceClass: '1' }
            : {}),
          startsOn: day(-100),
          expiresOn: day(200),
          fileDocumentIds: [f.id],
        });
      }
      if (i === 1)
        await post('/v1/drivers', {
          name: `สมชาย เปลี่ยนราย ${RUN}`,
          phone: PHONE,
          employmentType: 'CARRIER_DRIVER',
          carrierId: c.id,
          licenceClass: 'T2',
          licenceExpiresOn: day(300),
        });
      const rc = await post<{ id: string }>('/v1/rate-cards', {
        side: 'BUY',
        carrierId: c.id,
        originId: a.id,
        destinationId: b.id,
        vehicleTypeId: vt6,
        pricingModel: 'PER_TRIP',
        buyRate: rate,
        validFrom: today,
      });
      await post(`/v1/rate-cards/${rc.id}/approve`, { reason: 'อนุมัติตามราคาที่ตกลง' });
      return { id: c.id, name };
    };
    S.A = await carrier(1, '5000');
    S.B = await carrier(2, '5400');
    const offered = async () => {
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
      const d = (await get<Page1>(page, `/v1/delivery-orders?orderId=${so.id}`)).data[0]!.id;
      const t = await post<Trip>('/v1/trips', { tripDate: today, deliveryOrderIds: [d] });
      // จ้างรายถูกสุด (A) ตาม rate card → OFFERED
      return post<Trip>(`/v1/trips/${t.id}/offer`, { carrierId: S.A!.id });
    };
    S.t1 = await offered();
    S.t2 = await offered();
    // เที่ยว 2: A รับงานผ่านลิงก์ (ไม่ login) → ASSIGNED พร้อมรถ/คนขับของ A
    const l = await get<{ link: { url: string } }>(page, `/v1/trips/${S.t2.id}/offer-link`);
    S.url2 = l.link.url;
    const tk = new URL(S.url2).pathname.split('/').pop()!;
    const acc = await page.request.post(`/v1/public/offers/${tk}/accept`, {
      data: { vehiclePlate: PLATE, driverName: 'สมชาย', driverPhone: PHONE },
    });
    expect(acc.status(), await acc.text()).toBe(200);
  });

  const costs = async (tripNo: string) =>
    (
      (await db.tripCost.findMany({
        where: {
          tripId: ((await db.trip.findFirstOrThrow({ where: { tripNo } })) as { id: string }).id,
        },
        orderBy: [{ createdAt: 'asc' }, { amount: 'desc' }],
      })) as { amount: { toFixed: (n: number) => string } }[]
    ).map((c) => c.amount.toFixed(2));

  /** drawer เที่ยว → "จ่ายงานรถร่วม" → ⋯ "เปลี่ยนผู้รับเหมา" → เหตุผล → drawer จ้างแบบเปลี่ยนราย */
  const openChange = async (page: Page, t: Trip) => {
    await page.goto(`/plan?trip=${t.id}`);
    const d = page.getByRole('dialog');
    await expect(d.getByText(t.tripNo, { exact: true }).first()).toBeVisible();
    await d.getByRole('button', { name: 'จ่ายงานรถร่วม' }).click();
    await d.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await page.getByRole('menuitem', { name: 'เปลี่ยนผู้รับเหมา' }).click();
    const dlg = page.getByRole('dialog', { name: 'เปลี่ยนผู้รับเหมา' });
    await expect(dlg).toBeVisible();
    return { d, dlg };
  };

  test('รอตอบ: เปลี่ยนเป็นรายใหม่ทันที (ไม่ต้องรอครบ N ชม.) → ประวัติมีรายเดิม (ถอน) + รายใหม่ · ค่าจ้างเดิมกลับรายการ', async ({
    page,
  }) => {
    const { d, dlg } = await openChange(page, S.t1!);
    await expect(dlg).toContainText(`ยกเลิกการจ้าง ${S.A!.name} แล้วเลือกผู้รับเหมารายใหม่`);
    const ok = dlg.getByRole('button', { name: 'เลือกผู้รับเหมารายใหม่' });
    await dlg.getByPlaceholder('เช่น รถของผู้รับเหมาเดิมเสียก่อนเข้ารับสินค้า').fill('สั้นไป');
    await expect(ok).toBeDisabled();
    await dlg.getByPlaceholder('เช่น รถของผู้รับเหมาเดิมเสียก่อนเข้ารับสินค้า').fill(REASON);
    await ok.click();
    // ตัวเลือกไม่มีรายเดิม · ค่าเริ่มต้น = ถูกสุดของรายที่เหลือ
    const sel = d.getByRole('combobox', { name: 'ผู้รับเหมา' });
    await expect(sel.locator('option', { hasText: S.A!.name })).toHaveCount(0);
    await expect(sel.locator('option:checked')).toHaveText(`${S.B!.name} · ฿5,400.00 · ถูกสุด`);
    await expect(d.getByTestId('sub-replace')).toHaveText(
      `เมื่อส่งข้อเสนอ การจ้าง ${S.A!.name} จะถูกยกเลิก (ลิงก์เดิมใช้ไม่ได้ · ค่าจ้างเดิมกลับรายการ)`,
    );
    await d.getByRole('button', { name: 'ส่งข้อเสนอ' }).click();
    await expect(page.getByRole('status')).toContainText(
      `เปลี่ยนผู้รับเหมาเป็น ${S.B!.name} แล้ว · รอรถร่วมตอบรับ`,
    );
    const t = await get<Trip>(page, `/v1/trips/${S.t1!.id}`);
    expect(t).toMatchObject({ status: 'OFFERED', carrier: { name: S.B!.name } });
    const hist = await get<{
      data: { status: string; carrierName: string; closedReason: string }[];
    }>(page, `/v1/trips/${S.t1!.id}/offers`);
    expect(hist.data.map((h) => `${h.status}:${h.carrierName}`)).toEqual([
      `OFFERED:${S.B!.name}`,
      `WITHDRAWN:${S.A!.name}`,
    ]);
    expect(hist.data[1]!.closedReason).toBe(`เปลี่ยนผู้รับเหมา (${S.A!.name}): ${REASON}`);
    expect(await costs(S.t1!.tripNo)).toEqual(['5000.00', '-5000.00', '5400.00']);

    // เปลี่ยนอีกครั้ง (QA M1): รายที่ถูกเปลี่ยนออก (A) ไม่เป็นค่าเริ่มต้น · ป้าย "ถูกเปลี่ยนออก" · เลือกซ้ำต้องมีเหตุผล
    const again = await openChange(page, S.t1!);
    await again.dlg.getByPlaceholder('เช่น รถของผู้รับเหมาเดิมเสียก่อนเข้ารับสินค้า').fill(REASON);
    await again.dlg.getByRole('button', { name: 'เลือกผู้รับเหมารายใหม่' }).click();
    const sel2 = again.d.getByRole('combobox', { name: 'ผู้รับเหมา' });
    await expect(sel2.locator('option:checked')).not.toContainText(S.A!.name);
    await expect(sel2.locator('option', { hasText: S.A!.name })).toHaveText(
      `${S.A!.name} · ฿5,000.00 · ถูกเปลี่ยนออก`,
    );
    await sel2.selectOption({ label: `${S.A!.name} · ฿5,000.00 · ถูกเปลี่ยนออก` });
    await expect(again.d.getByTestId('sub-reason-hint')).toHaveText(
      'รายนี้ถูกเปลี่ยนออกจากเที่ยวนี้แล้ว — ระบุเหตุผลอย่างน้อย 10 ตัวอักษร',
    );
  });

  test('รับงานแล้ว: ยกเลิกการจ้าง (ถอดรถ/คนขับรายเดิม) → จ้างรายใหม่ · กิจกรรมแสดงรับงาน + ยกเลิกการจ้าง · ลิงก์เดิมใช้ไม่ได้', async ({
    page,
    browser,
  }) => {
    const before = await get<Trip>(page, `/v1/trips/${S.t2!.id}`);
    expect(before).toMatchObject({ status: 'ASSIGNED', vehicle: { plate: PLATE } });
    const { d, dlg } = await openChange(page, S.t2!);
    await expect(dlg).toContainText(`ที่รับงานแล้ว (รถ ${PLATE})`);
    await dlg.getByPlaceholder('เช่น รถของผู้รับเหมาเดิมเสียก่อนเข้ารับสินค้า').fill(REASON);
    await dlg.getByRole('button', { name: 'เลือกผู้รับเหมารายใหม่' }).click();
    await expect(d.getByText('รับงาน', { exact: true }).first()).toBeVisible();
    await d.getByRole('button', { name: 'ส่งข้อเสนอ' }).click();
    await expect(page.getByRole('status')).toContainText(`เปลี่ยนผู้รับเหมาเป็น ${S.B!.name} แล้ว`);
    const t = await get<Trip>(page, `/v1/trips/${S.t2!.id}`);
    expect(t).toMatchObject({
      status: 'OFFERED',
      carrier: { name: S.B!.name },
      vehicle: null,
      driver: null,
    });
    expect(await costs(S.t2!.tripNo)).toEqual(['5000.00', '-5000.00', '5400.00']);

    // กิจกรรม: รายเดิมรับงาน → ยกเลิกการจ้าง (เหตุผล) → ส่งข้อเสนอรายใหม่
    await page.goto(`/plan?trip=${S.t2!.id}`);
    const d2 = page.getByRole('dialog');
    await d2.getByRole('button', { name: 'จ่ายงานรถร่วม' }).click();
    await d2.getByRole('tab', { name: 'กิจกรรม' }).click();
    await expect(d2.getByText(`ผู้รับเหมารับงาน · กรอกรถ ${PLATE}`)).toBeVisible();
    await expect(d2.getByText('ยกเลิกการจ้าง', { exact: true })).toBeVisible();
    await expect(d2.getByText(`ส่งข้อเสนอให้ ${S.B!.name}`, { exact: true })).toBeVisible();

    // ลิงก์ของรายเดิมใช้ไม่ได้แล้ว (หน้าไม่ login)
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    await p.goto(`http://localhost:4520${new URL(S.url2!).pathname}`);
    await expect(p.getByText('ลิงก์นี้ใช้ไม่ได้')).toBeVisible();
    await ctx.close();
  });
});
