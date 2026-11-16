import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST3-T22 จ้างรถร่วม (docs/04 D3) — เกณฑ์ตรวจรับ: จ้าง carrier ที่ไม่ใช่ราคาถูกสุดต้องใส่เหตุผล;
 * ทุกการจ้างมี `selectionReason` ไม่ว่าง · drawer เที่ยวรถ → "ส่งต่อรถร่วม" → drawer "จ่ายงานรถร่วม"
 * (ผู้รับเหมา + ราคา rate card ขาซื้อ + ราคาและกำไร + ใบสั่งงาน) → "ส่งข้อเสนอ" → เที่ยว OFFERED + ค่าจ้างรถร่วม
 * ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const CHEAP = `หจก. รถร่วมถูกอีทูอี ${RUN}`;
const DEAR = `หจก. รถร่วมแพงอีทูอี ${RUN}`;
const REASON = 'รายที่ถูกกว่ารถไม่ว่างช่วงเช้า';
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/** เลขนิติบุคคล (checksum ถูก) — ข้อมูลสมมติ */
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
  carrier: { id: string; name: string } | null;
  hire: {
    carrierId: string;
    buyAmount?: string;
    priceSource: string;
    selectionKind: string;
    selectionReason: string;
  } | null;
};

test.describe.serial('จ้างรถร่วม (ST3-T22)', () => {
  let H: Record<string, string> = {};
  const S: { so1?: string; so2?: string; t1?: Trip; t2?: Trip; cheap?: string; dear?: string } = {};

  const tripNow = async (page: Page, id: string) =>
    (await (await page.request.get(`/v1/trips/${id}`, { headers: H })).json()) as Trip;

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (S.t1) return;
    const get = async <X>(path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as X;
    const post = async <X>(path: string, data: object) => {
      const r = await page.request.post(path, {
        headers: { ...H, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), await r.text()).toBeLessThan(300);
      return (await r.json()) as X;
    };
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `ลูกค้าจ้างรถร่วมอีทูอี ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังจ้างรถร่วม ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ปลายทางจ้างรถร่วม ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get<Page1>('/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const carrier = async (name: string, n: number, rate: string) => {
      const c = await post<{ id: string }>('/v1/carriers', {
        legalName: name,
        entityType: 'JURISTIC',
        taxId: jurTax(Number(RUN) + n),
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
      return c.id;
    };
    S.cheap = await carrier(CHEAP, 501, '4500');
    S.dear = await carrier(DEAR, 502, '5200');
    const so = () =>
      post<{ id: string; soNo: string }>('/v1/orders', {
        customer: { id: cust.id },
        requestedDate: today,
        vehicleTypeId: vt6,
        stops: [
          { type: 'PICKUP', siteId: a.id },
          { type: 'DELIVERY', siteId: b.id },
        ],
        lines: [{ description: 'ปูนซีเมนต์', qty: '1', unitId: ton, weightKg: '1500' }],
      });
    const doOf = async (id: string) =>
      (await get<Page1>(`/v1/delivery-orders?orderId=${id}`)).data[0]!.id;
    const s1 = await so();
    const s2 = await so();
    S.so1 = s1.soNo;
    S.so2 = s2.soNo;
    S.t1 = await post<Trip>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [await doOf(s1.id)],
    });
    S.t2 = await post<Trip>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [await doOf(s2.id)],
    });
  });

  const openHire = async (page: Page, soNo: string, tripNo: string) => {
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: tripNo }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByText('เที่ยวรถ / ใบคุมรถ')).toBeVisible();
    await d.getByRole('button', { name: 'ส่งต่อรถร่วม' }).click();
    await expect(d.getByText('จ่ายงานรถร่วม')).toBeVisible();
    return d;
  };

  test('เลือกรายที่ไม่ใช่ถูกสุด → ต้องใส่เหตุผลก่อนส่ง · ส่งแล้วเที่ยว OFFERED + ค่าจ้าง + selectionReason', async ({
    page,
  }) => {
    const d = await openHire(page, S.so1!, S.t1!.tripNo);
    const sel = d.getByRole('combobox', { name: 'ผู้รับเหมา' });
    // ค่าเริ่มต้น = รายที่ถูกสุด ราคาตาม rate card
    await expect(sel).toHaveValue(S.cheap!);
    await expect(d.getByRole('textbox', { name: 'ราคาซื้อ (฿ ต่อเที่ยว)' })).toHaveValue('4,500');
    await expect(d.getByText(`ราคาตั้งต้นจาก rate card ขาซื้อของ ${CHEAP}`)).toBeVisible();
    await expect(d.getByText('เหตุผลที่เลือกรายนี้')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/st3-subcon-hire-sum.png' });

    await sel.selectOption(S.dear!);
    await expect(d.getByRole('textbox', { name: 'ราคาซื้อ (฿ ต่อเที่ยว)' })).toHaveValue('5,200');
    await expect(d.getByTestId('sub-reason-hint')).toHaveText(
      `ไม่ใช่ราคาถูกสุด (ถูกสุด ฿4,500 · ${CHEAP}) — ระบุเหตุผลอย่างน้อย 10 ตัวอักษร`,
    );
    await d.getByRole('button', { name: 'ส่งข้อเสนอ' }).click();
    await expect(d.getByText('ระบุเหตุผลอย่างน้อย 10 ตัวอักษร', { exact: true })).toBeVisible();
    expect((await tripNow(page, S.t1!.id)).status).toBe('PLANNING');

    await d.getByRole('textbox', { name: 'เหตุผลที่เลือกรายนี้' }).fill(REASON);
    await page.screenshot({ path: 'test-results/st3-subcon-hire-reason.png' });
    await d.getByRole('tab', { name: 'ใบสั่งงาน' }).click();
    const wo = d.getByTestId('sub-wo');
    await expect(wo).toContainText(S.t1!.tripNo);
    await expect(wo).toContainText('฿5,200.00 (ไม่รวม VAT)');
    await expect(wo).toContainText('หัก ณ ที่จ่าย 1%');
    await page.screenshot({ path: 'test-results/st3-subcon-hire-wo.png' });
    await d.getByRole('tab', { name: 'ส่งข้อเสนอ' }).click();
    await d.getByRole('button', { name: 'ส่งข้อเสนอ' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `เสนองานให้ ${DEAR} แล้ว` }),
    ).toBeVisible();

    const t = await tripNow(page, S.t1!.id);
    expect(t.status).toBe('OFFERED');
    expect(t.carrier?.id).toBe(S.dear);
    expect(t.hire).toMatchObject({
      carrierId: S.dear,
      buyAmount: '5200.00',
      priceSource: 'RATE_CARD',
      selectionKind: 'OVERRIDE',
      selectionReason: REASON,
    });
  });

  test('เลือกรายที่ถูกสุด → ส่งได้ทันที · selectionReason ไม่ว่าง (ระบบเขียนให้)', async ({
    page,
  }) => {
    const d = await openHire(page, S.so2!, S.t2!.tripNo);
    await d.getByRole('button', { name: 'ส่งข้อเสนอ' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `เสนองานให้ ${CHEAP} แล้ว` }),
    ).toBeVisible();
    const t = await tripNow(page, S.t2!.id);
    expect(t.status).toBe('OFFERED');
    expect(t.hire).toMatchObject({
      carrierId: S.cheap,
      buyAmount: '4500.00',
      selectionKind: 'CHEAPEST',
    });
    expect(t.hire!.selectionReason.trim().length).toBeGreaterThan(0);
  });
});
