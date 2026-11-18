import AxeBuilder from '@axe-core/playwright';
import { test as base, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEMO_EMAIL, DEMO_PASSWORD, expect, test } from './fixtures';

/**
 * E2E ST9-T20 Accessibility (NFR — WCAG 2.1 AA) — รายงาน: design/a11y/st9-t20-report.md
 * axe-core (wcag2a/aa + wcag21a/aa) บนหน้าหลัก 10 หน้า + drawer/dialog ที่เปิดจากหน้านั้น
 * ล้มเมื่อมี violation ระดับ serious/critical ใหม่ — ยกเว้นรายการใน ALLOW (จุดที่ต้องแก้ที่ต้นแบบ — สี/contrast
 * ส่ง Claude Design ตาม spec/12 §3; ห้ามแก้สีเองเพราะเปลี่ยนหน้าตาต้นแบบ)
 * + ตรวจคีย์บอร์ด: แถวตารางกด Enter เปิด drawer, focus เข้า drawer/กลับที่เดิมเมื่อปิด, Tab วนใน dialog, Esc ปิด
 * ตั้ง A11Y_DUMP=<โฟลเดอร์> เพื่อเขียนผล axe ทั้งหมด (รวม moderate/minor) เป็น JSON ไว้ทำรายงาน
 */
const RUN = String(Date.now()).slice(-6);
const CUST = `ลูกค้าเข้าถึงอีทูอี ${RUN}`;
const PLATE = `7${RUN.slice(-1)}-${RUN.slice(-4)}`;
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const at = (h: string) => `${today}T${h}:00:00+07:00`;

/**
 * รายการที่ยอมรับไว้ก่อน (มีแถวใน spec/12 §3 แล้ว) — `rule` ของ axe + selector ของ node ที่ยอม
 * เพิ่มรายการใหม่ได้เฉพาะเมื่อบันทึกในรายงาน + spec/12 §3 แล้วเท่านั้น
 */
const ALLOW: { rule: string; target: RegExp; why: string }[] = [];

async function token(page: Page): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await page.request.post('/v1/auth/login', {
    data: {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
  });
  const { code } = (await r1.json()) as { code: string };
  const r2 = await page.request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  });
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

/** รัน axe แล้วคืน violation serious/critical ที่ไม่อยู่ใน ALLOW (A11Y_DUMP = เขียนผลทั้งหมดลงไฟล์) */
async function audit(page: Page, name: string, browserName: string): Promise<string[]> {
  // รอ font โหลดครบ + animation (drawer เลื่อนเข้า/scrim) จบ ให้ contrast คำนวณจากสีจริง — ไม่ใช้เวลาคงที่
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const dir = process.env.A11Y_DUMP;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    const slim = (xs: typeof r.violations) =>
      xs.map((x) => ({
        id: x.id,
        impact: x.impact,
        help: x.help,
        nodes: x.nodes.map((n) => ({
          target: n.target.join(' '),
          html: n.html.slice(0, 200),
          summary: n.failureSummary?.slice(0, 300),
        })),
      }));
    writeFileSync(
      `${dir}/${base.info().project.name}-${name}.json`,
      JSON.stringify({ violations: slim(r.violations), incomplete: slim(r.incomplete) }, null, 1),
    );
  }
  const bad: string[] = [];
  for (const v of r.violations) {
    if (v.impact !== 'serious' && v.impact !== 'critical') continue;
    for (const n of v.nodes) {
      const target = n.target.join(' ');
      if (ALLOW.some((a) => a.rule === v.id && a.target.test(target))) continue;
      bad.push(`${v.id} (${v.impact}) ${target} — ${n.html.slice(0, 120)}`);
    }
  }
  return bad;
}

const expectClean = async (page: Page, name: string, browserName: string) =>
  expect.soft(await audit(page, name, browserName), `${name}: axe serious/critical`).toEqual([]);

base.describe('ST9-T20 a11y — หน้า login (ยังไม่เข้าระบบ)', () => {
  base('login: axe + error ประกาศด้วย role=alert', async ({ page, browserName }) => {
    await page.goto('/login');
    await expect(page.getByLabel('อีเมล')).toBeVisible();
    await expectClean(page, 'login', browserName);
    // error ของฟอร์มต้องถูกประกาศ (role=alert) · ส่งด้วย Enter (ไม่ส่งรหัสผิด — กันบัญชีเดโมถูกล็อก)
    await page.getByLabel('อีเมล').press('Enter');
    await expect(page.getByRole('alert')).toHaveText('กรอกอีเมลและรหัสผ่าน');
  });
});

test.describe('ST9-T20 a11y — หน้าหลัก', () => {
  let soNo = '';
  let holdNo = '';
  let tripNo = '';
  let poolNo = '';
  let tripId = '';
  let H: Record<string, string> = {};

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (soNo) return;
    const get = async (path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as {
        data: { id: string; code?: string }[];
      };
    const post = async <T = { id: string; soNo: string }>(path: string, data: object) => {
      const r = await page.request.post(path, {
        headers: { ...H, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), `${path}: ${await r.text()}`).toBe(201);
      return (await r.json()) as T;
    };
    const company = (await get('/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post('/v1/customers', { legalName: CUST, billingCompanyId: company });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post('/v1/customer-sites', {
      name: `คลังเข้าถึง ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post('/v1/customer-sites', {
      name: `ปลายทางเข้าถึง ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    });
    const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON')!.id;
    const vt6 = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W')!.id;
    const v = await post('/v1/vehicles', {
      plate: PLATE,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    });
    await post('/v1/drivers', {
      name: `คนขับเข้าถึง ${RUN}`,
      phone: `081-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
      employmentType: 'EMPLOYEE_SALARIED',
      licenceClass: 'T2',
      licenceExpiresOn: '2030-03-31',
      defaultVehicleId: v.id,
    });
    const order = (customer: object) =>
      post('/v1/orders', {
        customer,
        billingCompanyId: company,
        requestedDate: today,
        vehicleTypeId: vt6,
        stops: [
          { type: 'PICKUP', siteId: a.id },
          { type: 'DELIVERY', siteId: b.id },
        ],
        lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: '3000' }],
      });
    const s1 = await order({ id: cust.id });
    soNo = s1.soNo;
    poolNo = (await order({ id: cust.id })).soNo;
    holdNo = (await order({ externalId: `A11Y-${RUN}`, name: 'ลูกค้าจากระบบต้นทาง' })).soNo;
    const dos = (await get(`/v1/delivery-orders?orderId=${s1.id}`)).data;
    ({ tripNo, id: tripId } = await post<{ tripNo: string; id: string }>('/v1/trips', {
      tripDate: today,
      deliveryOrderIds: [dos[0]!.id],
      vehicleId: v.id,
      plannedStartAt: at('08'),
      plannedEndAt: at('10'),
    }));
  });

  test('ภาพรวม (dashboard)', async ({ page, browserName }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'ภาพรวม' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectClean(page, 'dashboard', browserName);
  });

  test('ใบสั่งขนส่ง (SO) + drawer SO + drawer เที่ยวรถ — แถวตารางใช้คีย์บอร์ดได้', async ({
    page,
    browserName,
  }) => {
    await page.goto('/so');
    const row = page.getByRole('row', { name: new RegExp(soNo) });
    await expect(row).toBeVisible();
    await expectClean(page, 'so-list', browserName);
    // คีย์บอร์ด: focus แถว → Enter เปิด drawer · focus ย้ายเข้า drawer · Esc ปิดแล้ว focus กลับแถวเดิม
    await row.focus();
    await page.keyboard.press('Enter');
    const d = page.getByRole('dialog', { name: soNo });
    await expect(d).toBeVisible();
    await expect.poll(() => d.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await expectClean(page, 'so-drawer', browserName);
    // Tab วนอยู่ใน drawer (modal) — กด Tab 40 ครั้งยังอยู่ข้างใน
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
    expect(await d.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(row).toBeFocused();
    // drawer เที่ยวรถ (เที่ยว/ใบคุมรถ — หน้า /trips ยังเป็นหน้ารอ stage) เปิดจาก drawer SO
    await row.click();
    await page.getByRole('dialog').getByRole('button', { name: tripNo }).click();
    await expect(page.getByRole('dialog').getByText('เที่ยวรถ / ใบคุมรถ')).toBeVisible();
    await expectClean(page, 'trip-drawer', browserName);
  });

  test('ใบค้าง + drawer จับคู่ลูกค้า', async ({ page, browserName }) => {
    await page.goto('/so/hold');
    const row = page.getByRole('row', { name: new RegExp(holdNo) });
    await expect(row).toBeVisible();
    await expectClean(page, 'hold-list', browserName);
    await row.getByRole('button', { name: 'จับคู่ลูกค้า' }).click();
    await expect(page.locator('aside.tms-drawer')).toBeVisible();
    await expectClean(page, 'hold-drawer', browserName);
  });

  test('กระดานวางแผน — จัด SO ลงรถด้วยคีย์บอร์ด (ทางเลือกของการลากวาง)', async ({
    page,
    browserName,
  }) => {
    await page.goto('/plan');
    await page.getByRole('tab', { name: /^วันนี้/ }).click();
    await page.getByLabel('ลูกค้า', { exact: true }).selectOption({ label: CUST });
    const track = page.getByTestId(`plan-track-${PLATE}`);
    await expect(track).toBeVisible();
    const card = page.getByTestId(`plan-pool-${poolNo}`);
    await expect(card).toBeVisible();
    await expectClean(page, 'planning', browserName);
    // Space บนการ์ด SO = เลือก · Enter บนแถวรถ = วางลงรถ → เกิดเที่ยว (toast)
    await card.focus();
    await page.keyboard.press(' ');
    await expect(card).toHaveAttribute('aria-current', 'true');
    await track.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: `จัด ${poolNo} ให้` })).toBeVisible();
    await expect(card).toHaveCount(0);
    // การ์ดเที่ยว: → เลื่อนเวลา 15 นาที (ทางเลือกของการลาก) · Enter เปิด drawer SO
    const trip = page.getByTestId(`plan-trip-${tripNo}`).getByRole('group').first();
    await trip.focus();
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => {
        const r = await page.request.get(`/v1/trips/${tripId}`, { headers: H });
        return Date.parse(((await r.json()) as { plannedStartAt: string }).plannedStartAt);
      })
      .toBe(Date.parse(at('08')) + 15 * 60_000);
    await trip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: soNo })).toBeVisible();
  });

  test('ศูนย์ข้อยกเว้น', async ({ page, browserName }) => {
    await page.goto('/exceptions');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectClean(page, 'exceptions', browserName);
  });

  test('ทะเบียนรถ + ฟอร์มเพิ่มรถ — error ของฟอร์มผูกกับช่อง (aria-describedby)', async ({
    page,
    browserName,
  }) => {
    await page.goto('/fleet/vehicles');
    await page.getByRole('textbox', { name: 'ทะเบียน', exact: true }).fill(PLATE);
    await expect(page.getByRole('row', { name: new RegExp(PLATE) })).toBeVisible();
    await expectClean(page, 'vehicles', browserName);
    // ช่องเลือกแถวอ่านเป็นทะเบียนรถ (ไม่ใช่ id ภายใน veh_…)
    await expect(
      page.getByRole('row', { name: new RegExp(PLATE) }).getByRole('checkbox'),
    ).toHaveAccessibleName(new RegExp(PLATE));
    // เปิดด้วยคีย์บอร์ด (Safari ไม่ focus ปุ่มเมื่อคลิกเมาส์ — คืน focus ได้เฉพาะเมื่อเปิดจากปุ่มที่ focus อยู่)
    const add = page.getByRole('button', { name: 'เพิ่มรถ' });
    await add.focus();
    await page.keyboard.press('Enter');
    const d = page.getByRole('dialog');
    await expect.poll(() => d.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await d.getByRole('button', { name: 'เพิ่มรถ' }).click();
    const plate = d.getByLabel('ทะเบียน');
    await expect(plate).toHaveAttribute('aria-invalid', 'true');
    await expect(plate).toHaveAccessibleDescription('กรุณากรอก ทะเบียน');
    await expectClean(page, 'vehicle-form', browserName);
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(add).toBeFocused();
  });

  test('คนขับและรถร่วม', async ({ page, browserName }) => {
    await page.goto('/fleet/drivers');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectClean(page, 'drivers', browserName);
  });

  test('ลูกค้า + ฟอร์มเพิ่มลูกค้า', async ({ page, browserName }) => {
    await page.goto('/master/customers');
    await page.getByRole('textbox', { name: 'ชื่อ', exact: true }).fill(CUST);
    await expect(page.getByRole('row', { name: new RegExp(CUST) })).toBeVisible();
    await expectClean(page, 'customers', browserName);
    await page.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectClean(page, 'customer-form', browserName);
  });

  test('ตั้งค่า', async ({ page, browserName }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectClean(page, 'settings', browserName);
  });
});
