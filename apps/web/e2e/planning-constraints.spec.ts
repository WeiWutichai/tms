import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, openIdleSubcon, test, trustDevice } from './fixtures';

/**
 * E2E ST3-T14 กฎตอนจัดรถ — D-07 (PO 16 พ.ย. 2569 "ผสม"):
 * (1) คำเตือน: ผู้วางแผนลาก SO เกินน้ำหนักลงรถ → บันทึกได้ การ์ด "ติดเงื่อนไข · รออนุมัติ" (ส้ม) + "น้ำหนักเกิน · ขออนุมัติ"
 *     → ยืนยันพร้อมเหตุผล → "อนุมัติยกเว้นแล้ว" (เทา) + บันทึกใน rule_overrides/audit
 * (2) บล็อก: รถร่วมไม่มีเอกสารบังคับ → วางไม่ได้ · "ห้ามจ่ายงาน" ผู้วางแผนยกเว้นไม่ได้
 * (3) ผู้จัดการยกเว้นพร้อมเหตุผล → วางได้ เที่ยวมีบันทึกการยกเว้น · ข้อมูลสมมติ ผ่าน /v1 จริง (ฐาน e2e)
 */
const RUN = String(Date.now()).slice(-6);
const CUST = `ลูกค้ากฎจัดรถอีทูอี ${RUN}`;
const PLATE = `5${RUN.slice(-1)}-${RUN.slice(-4)}`;
const SUB = `4${RUN.slice(-1)}-${RUN.slice(-4)}`;
const REASON = 'ลูกค้ายืนยันรับของเกินพิกัด แยกส่งไม่ได้';
const jur = (n: number) => {
  const base = `0105${String(500_000 + n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
};
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

async function token(page: Page, email: string): Promise<string> {
  await trustDevice(page, email); // D-78: ผู้ใช้ที่ต้องตั้ง 2FA
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

async function dragTo(page: Page, src: Locator, x: number, y: number) {
  await src.scrollIntoViewIfNeeded();
  const a = (await src.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}
const xAt = (box: { x: number; width: number }, h: number) => box.x + ((h - 6) / 14) * box.width;

const so: { id: string; soNo: string }[] = [];
let H: Record<string, string> = {};

/** ข้อมูลของรอบนี้ (สร้างครั้งเดียวด้วยสิทธิ์ผู้ใช้ที่ login อยู่ — ผู้วางแผนมี master/orders write) */
async function seed(page: Page, email: string) {
  H = { Authorization: `Bearer ${await token(page, email)}` };
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
    name: `คลังกฎจัดรถ ${RUN}`,
    kind: 'PICKUP',
    address: addr('สมุทรปราการ'),
  });
  const b = await post('/v1/customer-sites', {
    name: `ปลายทางกฎจัดรถ ${RUN}`,
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
  // รถร่วมที่ยังไม่มีประกัน/พ.ร.บ. = บล็อก DOC_MISSING (D-07 กฎเอกสาร)
  const carrier = await post('/v1/carriers', {
    legalName: `หจก. รถร่วมกฎจัดรถ ${RUN}`,
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
  for (const w of ['6800', '2000', '1500'])
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
}

const open = async (page: Page) => {
  await page.goto('/plan');
  await page.getByRole('tab', { name: /^วันนี้/ }).click();
  await page.getByLabel('ลูกค้า', { exact: true }).selectOption({ label: CUST });
  const track = page.getByTestId(`plan-track-${PLATE}`);
  await expect(track).toBeVisible();
  await track.scrollIntoViewIfNeeded();
  return track;
};
const tripOf = async (page: Page, soNo: string) => {
  const b = (await (
    await page.request.get(`/v1/planning/board?date=${today}&days=1`, { headers: H })
  ).json()) as {
    trips: {
      id: string;
      tripNo: string;
      vehiclePlate: string | null;
      pendingRules: { code: string }[];
      confirmedRules: number;
      orders: { orderNo: string }[];
    }[];
  };
  return b.trips.find((x) => x.orders.some((o) => o.orderNo === soNo));
};
const ruleOverrides = async (page: Page, id: string) =>
  (
    (await (await page.request.get(`/v1/trips/${id}`, { headers: H })).json()) as {
      ruleOverrides: { code: string; kind: string; reason: string }[];
    }
  ).ruleOverrides;

test.describe.serial('กฎตอนจัดรถ (ST3-T14)', () => {
  test.describe('ผู้วางแผน', () => {
    test.use({ loginEmail: 'planner@demo-a.test' });
    test.beforeEach(async ({ page }) => seed(page, 'planner@demo-a.test'));

    test('คำเตือน: เกินน้ำหนัก → บันทึกได้ "· ขออนุมัติ" → ยืนยันพร้อมเหตุผล → "อนุมัติยกเว้นแล้ว"', async ({
      page,
    }) => {
      const track = await open(page);
      const box = (await track.boundingBox())!;
      await dragTo(page, page.getByTestId(`plan-pool-${so[0]!.soNo}`), xAt(box, 9.05), box.y + 40);
      await expect(page.getByRole('status')).toContainText(
        `จัด ${so[0]!.soNo} ให้ ${PLATE} แล้ว · พบปัญหา: น้ำหนักเกิน 800 กก.`,
      );
      const t = (await tripOf(page, so[0]!.soNo))!;
      expect(t.pendingRules.map((r) => r.code)).toEqual(['OVERWEIGHT']);
      const card = page.getByTestId(`plan-trip-${t.tripNo}`).locator('.tms-plan-card');
      // เมาส์ค้างบนการ์ดหลังลาก = :hover ทาขอบทุกด้าน #9DB6E3 (ต้นแบบ style-hover) — ย้ายเมาส์ออกก่อนตรวจสีขอบซ้าย
      await page.mouse.move(0, 0);
      await expect(card).toHaveCSS('border-left-color', 'rgb(143, 85, 0)');
      await page.getByTestId(`plan-ask-${t.tripNo}`).click();
      const dlg = page.getByRole('dialog');
      await expect(dlg.getByRole('heading')).toHaveText('ยืนยันจัดรถทั้งที่ติดเงื่อนไข');
      await expect(dlg).toContainText('ผิดกฎหมายการบรรทุก');
      const ok = dlg.getByRole('button', { name: 'ยืนยันและบันทึก log' });
      await dlg.getByRole('textbox').fill('สั้น');
      await expect(ok).toBeDisabled();
      await dlg.getByRole('textbox').fill(REASON);
      await ok.click();
      await expect(page.getByRole('status')).toContainText(
        `อนุมัติยกเว้น ${so[0]!.soNo} แล้ว · บันทึก log แล้ว`,
      );
      await expect(page.getByTestId(`plan-overridden-${t.tripNo}`)).toHaveText('อนุมัติยกเว้นแล้ว');
      await page.mouse.move(0, 0);
      await expect(card).toHaveCSS('border-left-color', 'rgb(89, 96, 107)');
      expect(await ruleOverrides(page, t.id)).toEqual([
        expect.objectContaining({ code: 'OVERWEIGHT', kind: 'ACKNOWLEDGE', reason: REASON }),
      ]);
    });

    test('บล็อก: รถร่วมไม่มีเอกสารบังคับ → วางไม่ได้ · "ห้ามจ่ายงาน" ผู้วางแผนยกเว้นไม่ได้', async ({
      page,
    }) => {
      await open(page);
      await openIdleSubcon(page);
      const row = page.getByTestId(`plan-row-${SUB}`);
      await row.scrollIntoViewIfNeeded();
      const track = page.getByTestId(`plan-track-${SUB}`);
      const box = (await track.boundingBox())!;
      await dragTo(page, page.getByTestId(`plan-pool-${so[1]!.soNo}`), xAt(box, 9.05), box.y + 40);
      await expect(page.getByRole('status')).toContainText('วางไม่ได้: รถติดกฎห้ามจ่ายงาน');
      expect(await tripOf(page, so[1]!.soNo)).toBeUndefined();
      await row.getByRole('button', { name: 'ดูสาเหตุ' }).click();
      const dlg = page.getByTestId('plan-blocked-dialog');
      await expect(dlg.getByRole('heading')).toContainText(`ห้ามจ่ายงาน · ${SUB}`);
      await expect(dlg).toContainText('ไม่มีเอกสารรถบังคับ');
      await expect(dlg).toContainText('สิทธิ์ผู้วางแผนยกเว้นไม่ได้ ต้องให้ผู้จัดการอนุมัติ');
      await expect(dlg.getByRole('textbox')).toBeDisabled();
      await expect(dlg.getByRole('button', { name: /ยกเว้นและบันทึก log/ })).toBeDisabled();
      await dlg.getByRole('button', { name: 'ปิด' }).click();
      await expect(dlg).toHaveCount(0);
    });
  });

  test.describe('ผู้จัดการ', () => {
    test.use({ loginEmail: 'manager@demo-a.test' });
    test.beforeEach(async ({ page }) => seed(page, 'manager@demo-a.test'));

    test('ยกเว้นทีละเที่ยว: วางลงรถร่วมติดกฎ → "ห้ามจ่ายงาน" → ยกเว้นพร้อมเหตุผล → เกิดเที่ยว · เที่ยวถัดไปต้องยืนยันเอง (เติมเหตุผลให้)', async ({
      page,
    }) => {
      await open(page);
      const why = 'รถร่วมส่งกรมธรรม์ใหม่แล้ว รอบันทึกในระบบ';
      // (i) ของแถวรถที่ยังไม่มีเที่ยวติดกฎ → ยกเว้นล่วงหน้าทั้งคันไม่ได้
      await openIdleSubcon(page);
      const row = page.getByTestId(`plan-row-${SUB}`);
      await row.scrollIntoViewIfNeeded();
      await row.getByRole('button', { name: 'ดูสาเหตุ' }).click();
      const dlg = page.getByTestId('plan-blocked-dialog');
      await expect(dlg).toContainText('ยังไม่มีเที่ยวที่ติดกฎบนรถคันนี้');
      await expect(dlg.getByRole('textbox')).toBeDisabled();
      await dlg.getByRole('button', { name: 'ปิด' }).click();
      // วางลงรถ → server 409 → dialog ยกเว้นเฉพาะเที่ยวนี้
      const track = page.getByTestId(`plan-track-${SUB}`);
      let box = (await track.boundingBox())!;
      await dragTo(page, page.getByTestId(`plan-pool-${so[1]!.soNo}`), xAt(box, 13.05), box.y + 40);
      await expect(page.getByRole('status')).toContainText('วางไม่ได้: รถติดกฎห้ามจ่ายงาน');
      await expect(dlg).toContainText('การยกเว้นจะบันทึกลง log กิจกรรมของเที่ยวรถ');
      await dlg.getByRole('textbox').fill(why);
      await dlg.getByRole('button', { name: /ยกเว้นและบันทึก log/ }).click();
      await expect(page.getByRole('status')).toContainText(`จัด ${so[1]!.soNo} ให้ ${SUB} แล้ว`);
      const t = (await tripOf(page, so[1]!.soNo))!;
      expect(t.vehiclePlate).toBe(SUB);
      const ov = await ruleOverrides(page, t.id);
      expect(ov.length).toBeGreaterThan(0);
      expect(ov.every((o) => o.kind === 'OVERRIDE' && o.code.startsWith('DOC_'))).toBe(true);
      expect(ov[0]!.reason).toBe(why);
      await expect(page.getByTestId(`plan-overridden-${t.tripNo}`)).toBeVisible();
      // เที่ยวถัดไปบนรถคันเดิม: ต้องยืนยันอีกครั้ง (เหตุผลเดิมเติมให้)
      box = (await track.boundingBox())!;
      await dragTo(page, page.getByTestId(`plan-pool-${so[2]!.soNo}`), xAt(box, 6.55), box.y + 40);
      await expect(dlg).toBeVisible();
      await expect(dlg.getByRole('textbox')).toHaveValue(why);
      expect(await tripOf(page, so[2]!.soNo)).toBeUndefined();
      await dlg.getByRole('button', { name: /ยกเว้นและบันทึก log/ }).click();
      await expect(page.getByRole('status')).toContainText(`จัด ${so[2]!.soNo} ให้ ${SUB} แล้ว`);
      expect((await tripOf(page, so[2]!.soNo))!.vehiclePlate).toBe(SUB);
    });
  });
});
