import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST3-T16 Multi-drop (docs/04 D2; spec/03 PLN-003/004) — เกณฑ์ตรวจรับ:
 * ย้ายจุดส่งไปก่อนจุดรับของ DO เดียวกัน → ถูกปฏิเสธพร้อมข้อความ (ทั้งในหน้าจอ และ API 422 `stop_order_invalid`)
 * + เรียงจุดเองสำเร็จ (เลื่อนขึ้น) แล้วระยะ/เวลารวมแสดงใน drawer เที่ยวรถ · ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
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

type Trip = {
  id: string;
  tripNo: string;
  version: number;
  stops: { id: string; siteName: string }[];
  deliveryOrders: { doNo: string }[];
};

test.describe.serial('เที่ยวหลายจุด: เรียงจุดเอง + กันส่งก่อนรับ (ST3-T16)', () => {
  let H: Record<string, string>;
  let soA = '';
  let trip: Trip | undefined;
  const name = {
    pA: `คลังบางนา ${RUN}`,
    qA: `ร้านชลบุรี ${RUN}`,
    pB: `คลังอยุธยา ${RUN}`,
    qB: `ร้านระยอง ${RUN}`,
  };

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (trip) return;
    const get = async <T>(path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as T;
    const post = async <T>(path: string, data: object) => {
      const r = await page.request.post(path, {
        headers: { ...H, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as T;
    };
    type Page1 = { data: { id: string; code?: string }[] };
    const company = (await get<Page1>('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `ลูกค้าหลายจุดอีทูอี ${RUN}`,
      billingCompanyId: company,
    });
    const site = (n: string, lat: number, lng: number) =>
      post<{ id: string }>('/v1/customer-sites', {
        name: n,
        kind: 'DROPOFF',
        address: { line1: '1 ถนนทดสอบ', district: 'เมือง', province: 'ชลบุรี' },
        lat,
        lng,
      });
    const pA = await site(name.pA, 13.6683, 100.6045);
    const qA = await site(name.qA, 13.3611, 100.9847);
    const pB = await site(name.pB, 14.3532, 100.5689);
    const qB = await site(name.qB, 12.6814, 101.2816);
    const ton = (await get<Page1>('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const so = async (p: string, q: string, hh: string) =>
      post<{ id: string; soNo: string }>('/v1/orders', {
        customer: { id: cust.id },
        requestedDate: today,
        stops: [
          { type: 'PICKUP', siteId: p },
          {
            type: 'DELIVERY',
            siteId: q,
            windowStart: `${today}T${hh}:00:00+07:00`,
            windowEnd: `${today}T${hh}:59:00+07:00`,
          },
        ],
        lines: [{ description: 'ปูนซีเมนต์', qty: '2', unitId: ton, weightKg: '2000' }],
      });
    const a = await so(pA.id, qA.id, '10');
    const b = await so(pB.id, qB.id, '14');
    soA = a.soNo;
    const doOf = async (id: string) =>
      (await get<Page1>(`/v1/delivery-orders?orderId=${id}`)).data[0]!.id;
    trip = await post<Trip>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [await doOf(a.id), await doOf(b.id)],
    });
    // จุดเริ่มต้น: รับ A → รับ B → ส่ง A → ส่ง B
    expect(trip.stops.map((s) => s.siteName)).toEqual([name.pA, name.pB, name.qA, name.qB]);
  });

  const stopNames = async (page: Page) =>
    (
      (await (await page.request.get(`/v1/trips/${trip!.id}`, { headers: H })).json()) as Trip
    ).stops.map((s) => s.siteName);

  test('เปิด drawer เที่ยวรถจาก SO → เลื่อนจุดส่งขึ้น (ถูกลำดับ) สำเร็จ · เลื่อนไปก่อนจุดรับของ DO เดียวกัน → ข้อความปฏิเสธ', async ({
    page,
  }) => {
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(soA) }).click();
    const so = page.getByRole('dialog');
    await expect(so.getByText('รถ / คนขับ')).toBeVisible();
    await so.getByRole('button', { name: trip!.tripNo }).click();

    const d = page.getByRole('dialog');
    await expect(d.getByText('เที่ยวรถ / ใบคุมรถ')).toBeVisible();
    await expect(d.getByText(trip!.tripNo)).toBeVisible();
    await expect(d.getByText('จุดรับ / ส่ง ตามลำดับ')).toBeVisible();
    const rows = d.getByTestId('trip-stop');
    await expect(rows).toHaveCount(4);
    // ระยะ/เวลารวม (ค่าประมาณจากพิกัด — ไม่มีเส้นทางใน route master)
    await expect(d.getByText(/กม\. \(ประมาณจากพิกัด\)/)).toBeVisible();
    await expect(d.getByText('เวลาเดินทางรวม')).toBeVisible();

    // ส่ง A (แถว 3) ขึ้นเหนือ รับ B → รับ A → ส่ง A → รับ B → ส่ง B (รับก่อนส่งยังถูก)
    await rows.nth(2).getByRole('button', { name: 'เลื่อนขึ้น' }).click();
    await expect(rows.nth(1)).toContainText(name.qA);
    await expect.poll(() => stopNames(page)).toEqual([name.pA, name.qA, name.pB, name.qB]);

    // ส่ง A ขึ้นอีก = ไปก่อน รับ A ของ DO เดียวกัน → ปฏิเสธพร้อมข้อความ ลำดับไม่เปลี่ยน
    await rows.nth(1).getByRole('button', { name: 'เลื่อนขึ้น' }).click();
    await expect(d.getByRole('alert')).toHaveText(
      `ย้ายไม่ได้ — ใบส่งของ ${trip!.deliveryOrders[0]!.doNo}: จุดส่งต้องอยู่หลังจุดรับ (ต้องรับของก่อนส่ง)`,
    );
    await expect(rows.nth(0)).toContainText(name.pA);
    expect(await stopNames(page)).toEqual([name.pA, name.qA, name.pB, name.qB]);
  });

  test('API: ส่งลำดับที่จุดส่งอยู่ก่อนจุดรับ → 422 stop_order_invalid พร้อมข้อความ (server เป็นแหล่งความจริง)', async ({
    page,
  }) => {
    const cur = (await (
      await page.request.get(`/v1/trips/${trip!.id}`, { headers: H })
    ).json()) as Trip;
    const [pA, qA, pB, qB] = cur.stops.map((s) => s.id);
    const r = await page.request.post(`/v1/trips/${trip!.id}/reorder-stops`, {
      headers: { ...H, 'If-Match': `"${cur.version}"` },
      data: { stopIds: [qA, pA, pB, qB] },
    });
    expect(r.status()).toBe(422);
    const body = (await r.json()) as { code: string; detail: string };
    expect(body.code).toBe('stop_order_invalid');
    expect(body.detail).toContain(cur.deliveryOrders[0]!.doNo);
    expect(body.detail).toContain('ต้องรับของก่อนส่ง');
    expect(await stopNames(page)).toEqual([name.pA, name.qA, name.pB, name.qB]);
  });
});
