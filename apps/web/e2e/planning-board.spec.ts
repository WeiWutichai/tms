import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST3-T12 กระดานวางแผน (docs/04 D2; spec/03 §5) — เกณฑ์ตรวจรับ:
 * (1) ลาก SO จาก "SO รอจัด" ลงแถวรถ → เกิดเที่ยว PLANNING (2) ลากซ้อนเวลาบนรถเดียว → แถบแดง + บันทึกสำเร็จ
 * (3) ลากขอบเที่ยวเพื่อปรับเวลา → /schedule บันทึกเวลาใหม่ · ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 */
const RUN = String(Date.now()).slice(-6);
const CUST = `ลูกค้ากระดานอีทูอี ${RUN}`;
const PLATE = `8${RUN.slice(-1)}-${RUN.slice(-4)}`;
const SUB = `9${RUN.slice(-1)}-${RUN.slice(-4)}`;
const jur = (n: number) => {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
};
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

/** ลากด้วยเมาส์ (HTML5 drag ของ Chromium ผ่าน Playwright) จากกลาง `src` ไปยังตำแหน่ง x/y */
async function dragTo(page: Page, src: Locator, x: number, y: number) {
  await src.scrollIntoViewIfNeeded();
  const a = (await src.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}
/** ตำแหน่ง x ของชั่วโมง `h` บนแถบเวลา 06:00–20:00 */
const xAt = (box: { x: number; width: number }, h: number) => box.x + ((h - 6) / 14) * box.width;

test.describe.serial('กระดานวางแผน (ST3-T12)', () => {
  let H: Record<string, string>;
  const so: { id: string; soNo: string }[] = [];

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (so.length) return;
    const get = async (path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as {
        data: { id: string; code?: string }[];
      };
    const post = async (path: string, data: object) => {
      const r = await page.request.post(path, {
        headers: { ...H, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as { id: string; soNo: string };
    };
    const company = (await get('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post('/v1/customers', { legalName: CUST, billingCompanyId: company });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post('/v1/customer-sites', {
      name: `คลังกระดาน ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post('/v1/customer-sites', {
      name: `ปลายทางกระดาน ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W')!.id;
    await post('/v1/vehicles', {
      plate: PLATE,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    // รถร่วมที่ยังไม่มีเอกสารบังคับ (ประกัน/พ.ร.บ.) = ติดกฎห้ามจ่ายงาน (ST2-T20)
    const carrier = await post('/v1/carriers', {
      legalName: `หจก. รถร่วมกระดาน ${RUN}`,
      entityType: 'JURISTIC',
      taxId: jur(Number(RUN)),
    });
    await post('/v1/vehicles', {
      plate: SUB,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'SUBCONTRACT',
      carrierId: carrier.id,
      payloadKg: 6000,
    });
    for (const w of ['5400', '4200', '3000'])
      so.push(
        await post('/v1/orders', {
          customer: { id: cust.id },
          requestedDate: today,
          vehicleTypeId: vt6,
          stops: [
            { type: 'PICKUP', siteId: a.id },
            { type: 'DELIVERY', siteId: b.id },
          ],
          lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: w }],
        }),
      );
  });

  /** เปิดกระดาน "วันนี้" · `filter` = กรอง "SO รอจัด" ด้วยลูกค้าของรอบนี้ (ตัวเลือกมีเฉพาะลูกค้าที่ยังมีงานรอจัด) */
  const open = async (page: Page, filter = true) => {
    await page.goto('/plan');
    await page.getByRole('tab', { name: /^วันนี้/ }).click();
    if (filter) await page.getByLabel('ลูกค้า', { exact: true }).selectOption({ label: CUST });
    const track = page.getByTestId(`plan-track-${PLATE}`);
    await expect(track).toBeVisible();
    await track.scrollIntoViewIfNeeded();
    return track;
  };
  const boardTrip = async (page: Page, soNo: string) => {
    const b = (await (
      await page.request.get(`/v1/planning/board?date=${today}&days=1`, { headers: H })
    ).json()) as {
      trips: {
        id: string;
        tripNo: string;
        status: string;
        vehiclePlate: string | null;
        plannedStartAt: string | null;
        plannedEndAt: string | null;
        overlapsWith: string[];
        orders: { orderNo: string }[];
      }[];
    };
    return b.trips.find((x) => x.orders.some((o) => o.orderNo === soNo));
  };

  test('ลาก SO ลงแถวรถ → เกิดเที่ยว PLANNING บนรถนั้น ออกจาก "SO รอจัด"', async ({ page }) => {
    const track = await open(page);
    const box = (await track.boundingBox())!;
    await dragTo(page, page.getByTestId(`plan-pool-${so[0]!.soNo}`), xAt(box, 9.05), box.y + 40);
    await expect(page.getByRole('status')).toContainText(`จัด ${so[0]!.soNo} ให้ ${PLATE} แล้ว`);
    const card = track.getByTestId(/^plan-trip-/).filter({ hasText: so[0]!.soNo });
    await expect(card).toBeVisible();
    await expect(card).toContainText('09:00–12:00');
    await expect(card).toHaveAttribute('data-clash', 'false');
    await expect(page.getByTestId(`plan-pool-${so[0]!.soNo}`)).toHaveCount(0);
    const t = await boardTrip(page, so[0]!.soNo);
    expect(t).toMatchObject({ status: 'PLANNING', vehiclePlate: PLATE, overlapsWith: [] });
  });

  test('ลากซ้อนเวลาบนรถเดียว → บันทึกสำเร็จ แถบแดง "เวลาชนกัน" ทั้งสองเที่ยว', async ({ page }) => {
    const track = await open(page);
    const box = (await track.boundingBox())!;
    await dragTo(page, page.getByTestId(`plan-pool-${so[1]!.soNo}`), xAt(box, 11.05), box.y + 40);
    await expect(page.getByRole('status')).toContainText(
      `จัด ${so[1]!.soNo} ให้ ${PLATE} แล้ว · พบปัญหา: เวลาชนกัน`,
    );
    const cards = track.getByTestId(/^plan-trip-/);
    await expect(cards).toHaveCount(2);
    for (const n of [0, 1]) {
      const c = cards.nth(n);
      await expect(c).toHaveAttribute('data-clash', 'true');
      await expect(c).toContainText('เวลาชนกัน');
      await expect(c.locator('.tms-plan-card')).toHaveCSS('border-left-color', 'rgb(179, 50, 42)');
    }
    const a = await boardTrip(page, so[0]!.soNo);
    const b = await boardTrip(page, so[1]!.soNo);
    expect(b).toMatchObject({ status: 'PLANNING', overlapsWith: [a!.tripNo] });
    expect(a!.overlapsWith).toEqual([b!.tripNo]);
  });

  test('ลากขอบขวาปรับเวลาจบ + ลากเที่ยวไปช่วงว่าง → หายแดง', async ({ page }) => {
    const track = await open(page, false);
    // แถบเวลากว้างกว่ากล่อง (ต้นแบบ min-width 1180) → เลื่อนไปขวาสุดให้เห็น 09:00–20:00
    await page
      .getByRole('region', { name: 'กระดานวางแผน' })
      .evaluate((el) => (el.scrollLeft = el.scrollWidth));
    const box = (await track.boundingBox())!;
    const b = (await boardTrip(page, so[1]!.soNo))!;
    // ขอบขวา 14:00 → 15:00
    const edge = page.getByTestId(`plan-resize-e-${b.tripNo}`);
    const eb = (await edge.boundingBox())!;
    await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
    await page.mouse.down();
    await page.mouse.move(xAt(box, 15), eb.y + eb.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByRole('status')).toContainText(
      `ปรับเวลา ${so[1]!.soNo} เป็น 11:00–15:00 แล้ว`,
    );
    expect(Date.parse((await boardTrip(page, so[1]!.soNo))!.plannedEndAt!)).toBe(
      Date.parse(`${today}T15:00:00+07:00`),
    );
    // ลากทั้งเที่ยว (จับที่ 12:00 = 1 ชม. หลังเริ่ม) ไปปล่อยที่ 14:00 → 13:00–17:00 ไม่ซ้อนกับ 09:00–12:00
    const card = page.getByTestId(`plan-trip-${b.tripNo}`).locator('.tms-plan-card');
    const cb = (await card.boundingBox())!;
    await page.mouse.move(xAt(box, 12), cb.y + cb.height / 2);
    await page.mouse.down();
    await page.mouse.move(xAt(box, 12.3), cb.y + cb.height / 2, { steps: 3 });
    await page.mouse.move(xAt(box, 14), box.y + 40, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByRole('status')).toContainText(
      `ปรับเวลา ${so[1]!.soNo} เป็น 13:00–17:00 แล้ว`,
    );
    await expect(track.getByTestId(/^plan-trip-/).first()).toHaveAttribute('data-clash', 'false');
    const after = (await boardTrip(page, so[1]!.soNo))!;
    expect(after.overlapsWith).toEqual([]);
    expect(Date.parse(after.plannedStartAt!)).toBe(Date.parse(`${today}T13:00:00+07:00`));
    // ลากขอบขวาเลยแกน → หยุดที่ 20:00 (ไม่เปลี่ยนวัน/ไม่ข้ามคืน)
    const e2 = (await page.getByTestId(`plan-resize-e-${b.tripNo}`).boundingBox())!;
    await page.mouse.move(e2.x + e2.width / 2, e2.y + e2.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 300, e2.y + e2.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByRole('status')).toContainText(
      `ปรับเวลา ${so[1]!.soNo} เป็น 13:00–20:00 แล้ว`,
    );
    const end = (await boardTrip(page, so[1]!.soNo))!;
    expect(Date.parse(end.plannedEndAt!)).toBe(Date.parse(`${today}T20:00:00+07:00`));
    // ขอบที่ชนแกน 20:00 พอดียังจับได้ · เที่ยวที่ล้นแกนไม่มีที่จับ (unit test board.test.ts)
  });

  test('รถติดกฎห้ามจ่ายงาน: ลาย hatch + ป้ายเหตุผล · วางไม่ได้ (ขอบแดง + toast) ไม่เกิดเที่ยว', async ({
    page,
  }) => {
    await open(page);
    const row = page.getByTestId(`plan-row-${SUB}`);
    await row.scrollIntoViewIfNeeded();
    await expect(page.getByTestId(`plan-blocked-${SUB}`)).toContainText('ยังไม่มี');
    const track = page.getByTestId(`plan-track-${SUB}`);
    await expect(track).toHaveCSS('background-image', /repeating-linear-gradient/);
    const box = (await track.boundingBox())!;
    await dragTo(page, page.getByTestId(`plan-pool-${so[2]!.soNo}`), xAt(box, 9.05), box.y + 40);
    await expect(page.getByRole('status')).toContainText('วางไม่ได้: รถติดกฎห้ามจ่ายงาน');
    await expect(page.getByTestId(`plan-pool-${so[2]!.soNo}`)).toBeVisible();
    expect(await boardTrip(page, so[2]!.soNo)).toBeUndefined();
  });
});
