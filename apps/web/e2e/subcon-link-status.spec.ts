import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST4-T08 ลิงก์รถร่วม ส่วนสถานะ (docs/04 E2 "ePOD ผ่านลิงก์", E2.1 M10) — เกณฑ์ตรวจรับ:
 * เปิดลิงก์บนมือถือ ค้นเลข DO กดถึง → เว็บฝั่ง dispatcher เห็นสถานะทันที; กดซ้ำไม่เกิด event ซ้ำ
 * เตรียมข้อมูลผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ · หน้า public เปิดใน context ใหม่ (ไม่ login) จอ 390 px
 */
const RUN = String(Date.now()).slice(-6);
const CARRIER = `หจก. ศรีราชาโลจิสติกส์ลิงก์งาน ${RUN}`;
const PLATE = `75-${RUN.slice(-4)}`;
const PHONE = `09${RUN.slice(-1)}${RUN.slice(-4)}${RUN.slice(-3)}`.slice(0, 10);
const DRIVER = `สมชาย ใจดีลิงก์งาน ${RUN}`;
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

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
  stops: { status: string; arrivedAt: string | null }[];
};
type Ev = { type: string; source: string; recordedByName: string | null; stopId: string };

test.describe.serial('ลิงก์รถร่วม ส่วนสถานะ (ST4-T08)', () => {
  // สองเครื่อง + drawer ผู้จัดรถในข้อเดียว — เผื่อเวลาเมื่อเครื่องโหลดสูง
  test.describe.configure({ timeout: 90_000 });
  let H: Record<string, string> = {};
  const S: {
    t?: Trip;
    so?: { id: string; soNo: string };
    offerUrl?: string;
    podUrl?: string;
    doNo?: string;
  } = {};

  const get = async <X>(page: Page, path: string) =>
    (await (await page.request.get(path, { headers: H })).json()) as X;

  test.beforeEach(async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    if (S.t) return;
    const post = async <X>(path: string, data: object, headers: Record<string, string> = H) => {
      const r = await page.request.post(path, {
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        data,
      });
      expect(r.status(), await r.text()).toBeLessThan(300);
      return (await r.json()) as X;
    };
    type Page1 = { data: { id: string; code?: string; doNo?: string }[] };
    const company = (await get<Page1>(page, '/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>('/v1/customers', {
      legalName: `บจก. เอ็นเอสเอฟ อินดัสทรีลิงก์งาน ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังบางปูลิงก์งาน ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ท่าเรือแหลมฉบังลิงก์งาน ${RUN}`,
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
    const c = await post<{ id: string }>('/v1/carriers', {
      legalName: CARRIER,
      entityType: 'JURISTIC',
      taxId: jurTax(Number(RUN) + 731),
    });
    const v = await post<{ id: string }>('/v1/vehicles', {
      plate: PLATE,
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
        headers: { ...H, 'Content-Type': 'application/octet-stream' },
        data: PDF,
      });
      expect(put.status(), await put.text()).toBe(200);
      await post(`/v1/vehicles/${v.id}/documents`, {
        docType,
        docNo: `${docType.slice(0, 3)}-${RUN}`,
        ...(docType === 'INSURANCE'
          ? { issuer: 'บริษัท ประกันสมมติ จำกัด', insuranceClass: '1' }
          : {}),
        startsOn: day(-100),
        expiresOn: day(200),
        fileDocumentIds: [f.id],
      });
    }
    await post('/v1/drivers', {
      name: DRIVER,
      phone: PHONE,
      employmentType: 'CARRIER_DRIVER',
      carrierId: c.id,
      licenceClass: 'T2',
      licenceExpiresOn: day(300),
    });
    S.so = await post<{ id: string; soNo: string }>('/v1/orders', {
      customer: { id: cust.id },
      requestedDate: today,
      vehicleTypeId: vt6,
      stops: [
        { type: 'PICKUP', siteId: a.id },
        { type: 'DELIVERY', siteId: b.id },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: '8600' }],
    });
    const d = (await get<Page1>(page, `/v1/delivery-orders?orderId=${S.so.id}`)).data[0]!;
    S.doNo = d.doNo!;
    const t = await post<Trip>('/v1/trips', { tripDate: today, deliveryOrderIds: [d.id] });
    await post(`/v1/trips/${t.id}/offer`, {
      carrierId: c.id,
      cost: '5600',
      selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว',
    });
    S.offerUrl = (
      await get<{ link: { url: string } }>(page, `/v1/trips/${t.id}/offer-link`)
    ).link.url;
    // รถร่วมรับงานผ่านลิงก์ข้อเสนอ (ST3-T23) → ลิงก์งาน
    const tok = new URL(S.offerUrl).pathname.split('/').pop()!;
    await post(
      `/v1/public/offers/${tok}/accept`,
      { vehiclePlate: `${PLATE} ชบ.`, driverName: DRIVER, driverPhone: PHONE },
      {},
    );
    S.podUrl = (
      await get<{ podLink: { url: string } }>(page, `/v1/trips/${t.id}/offer-link`)
    ).podLink.url;
    // ผู้จัดรถปล่อยรถ (ยืนยันคำเตือนถ้ามี)
    const r = await page.request.post(`/v1/trips/${t.id}/dispatch`, { headers: H, data: {} });
    if (r.status() !== 200) {
      const w = (await r.json()) as { warnings?: { key: string }[] };
      await post(`/v1/trips/${t.id}/dispatch`, {
        ruleKeys: (w.warnings ?? []).map((x) => x.key),
        overrideReason: 'ทดสอบลิงก์รถร่วม ส่วนสถานะ',
      });
    }
    S.t = await get<Trip>(page, `/v1/trips/${t.id}`);
    expect(S.t.status).toBe('DISPATCHED');
  });

  /** หน้า public บนมือถือ (context ใหม่ — ไม่มี cookie/ไม่ login) */
  const mobile = async (browser: Browser, url: string) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'th-TH',
      timezoneId: 'Asia/Bangkok',
      isMobile: true,
      hasTouch: true,
    });
    const p = await ctx.newPage();
    await p.goto(`${E2E_WEB}${new URL(url).pathname}`);
    return { ctx, p };
  };
  const events = async (page: Page) =>
    (await get<{ data: Ev[] }>(page, `/v1/trips/${S.t!.id}/events`)).data;

  test('เกณฑ์ตรวจรับ: มือถือ ค้นเลข DO กดถึง → ผู้จัดรถเห็นทันที · กดซ้ำ (อีกเครื่อง/หน้าค้าง) ไม่เกิด event ซ้ำ', async ({
    page,
    browser,
  }) => {
    // จากลิงก์ข้อเสนอ (รับงานแล้ว) แท็บ "ส่ง POD" → หน้าลิงก์งาน
    const { ctx, p } = await mobile(browser, S.offerUrl!);
    await expect(p.getByTestId('ofl-status')).toHaveText('รับงาน');
    await p.getByRole('tab', { name: 'ส่ง POD' }).click();
    await expect(p).toHaveURL(/\/link\/pod\//);
    await expect(p.getByText('อัปโหลดหลักฐานการส่ง')).toBeVisible();
    // ค้นไม่พบ
    await p.getByTestId('pdl-q').fill('DO-0000-99999');
    await expect(p.getByTestId('pdl-nf')).toContainText('ไม่พบเลข DO นี้');
    // ค้นพบ (ตัวเล็ก/ช่องว่าง)
    await p.getByTestId('pdl-q').fill(` ${S.doNo!.toLowerCase()} `);
    await expect(p.getByTestId('pdl-do')).toContainText(S.doNo!);
    await expect(p.getByTestId('pdl-stop-PICKUP')).toContainText('ยังไม่ถึง');

    // อีกเครื่อง (หน้าค้าง) เปิด DO เดียวกันไว้ก่อนกด
    const { ctx: ctx2, p: p2 } = await mobile(browser, S.podUrl!);
    await p2.getByTestId('pdl-q').fill(S.doNo!);
    await expect(p2.getByRole('button', { name: 'ถึงจุดรับ' })).toBeVisible();

    await p.getByRole('button', { name: 'ถึงจุดรับ' }).click();
    await expect(p.getByRole('status')).toContainText('บันทึกถึงจุดรับแล้ว');
    await expect(p.getByTestId('pdl-stop-PICKUP')).toContainText(/ถึงแล้ว \d\d:\d\d น\./);
    await expect(p.getByRole('button', { name: 'ออกจากจุดรับ' })).toBeVisible();

    // ผู้จัดรถเห็นทันที (API + drawer ไทม์ไลน์)
    const t1 = await get<Trip>(page, `/v1/trips/${S.t!.id}`);
    expect(t1.status).toBe('IN_PROGRESS');
    expect(t1.stops[0]!.status).toBe('ARRIVED');
    let ev = await events(page);
    expect(ev.map((e) => [e.type, e.source, e.recordedByName])).toEqual([
      ['ARRIVE', 'LINK', CARRIER],
    ]);
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(S.so!.soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: S.t!.tripNo }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('tab', { name: 'ไทม์ไลน์' }).click();
    await expect(d.getByTestId('trip-event').first()).toContainText(
      `บันทึกโดย ${CARRIER} · ลิงก์รถร่วม`,
    );

    // เครื่องที่ค้างหน้าเก่ากด "ถึงจุดรับ" ซ้ำ → clientEventId เดิม → event เดิม
    await p2.getByRole('button', { name: 'ถึงจุดรับ' }).click();
    await expect(p2.getByRole('status')).toContainText('บันทึกถึงจุดรับแล้ว');
    ev = await events(page);
    expect(ev.filter((e) => e.type === 'ARRIVE')).toHaveLength(1);
    // refresh แล้วเห็นสถานะล่าสุด
    await p2.reload();
    await p2.getByTestId('pdl-q').fill(S.doNo!);
    await expect(p2.getByRole('button', { name: 'ออกจากจุดรับ' })).toBeVisible();
    await ctx2.close();
    await ctx.close();
  });

  test('ออกจากจุดรับ (ปิดงานจุดรับ + ออกไปจุดส่ง) → ถึงจุดส่ง → รอ POD · DO รับของแล้ว · ไม่มีธง', async ({
    page,
    browser,
  }) => {
    const { ctx, p } = await mobile(browser, S.podUrl!);
    await p.getByTestId('pdl-q').fill(S.doNo!);
    await p.getByRole('button', { name: 'ออกจากจุดรับ' }).click();
    await expect(p.getByRole('status')).toContainText('บันทึกออกจากจุดรับแล้ว');
    await expect(p.getByTestId('pdl-stop-PICKUP')).toContainText(/ออกแล้ว \d\d:\d\d น\./);
    await p.getByRole('button', { name: 'ถึงจุดส่ง' }).click();
    await expect(p.getByRole('status')).toContainText('บันทึกถึงจุดส่งแล้ว');
    await expect(p.getByTestId('pdl-stop-DELIVERY')).toContainText(/ถึงแล้ว/);
    // ST4-T09: ถึงจุดส่งแล้ว → ฟอร์มส่ง POD (ปิดงานพร้อม POD) แทนข้อความให้แจ้งฝ่ายจัดรถ
    await expect(p.getByTestId('pdl-pod-submit')).toBeVisible();
    await expect(p.getByTestId('pdl-hint')).toHaveCount(0);
    await expect(p.getByTestId('pdl-act')).toHaveCount(0);
    // แท็บงาน = ใบสั่งงาน + รับงานแล้ว
    await p.getByRole('tab', { name: 'งาน' }).click();
    await expect(p.getByText(S.t!.tripNo)).toBeVisible();
    await expect(p.getByText(`รถ ${PLATE} · ${DRIVER}`)).toBeVisible();
    await ctx.close();

    const ev = await events(page);
    // D68-39: ออกจากจุดรับ = LOADED (ขึ้นของเสร็จ)
    expect(ev.map((e) => e.type)).toEqual(['ARRIVE', 'LOADED', 'DEPART', 'ARRIVE']);
    expect(ev.every((e) => e.source === 'LINK')).toBe(true);
    const tr = await get<Trip>(page, `/v1/trips/${S.t!.id}`);
    expect(tr.stops.map((s) => s.status)).toEqual(['COMPLETED', 'ARRIVED']);
    const dos = await get<{ data: { status: string }[] }>(
      page,
      `/v1/delivery-orders?orderId=${S.so!.id}`,
    );
    expect(dos.data[0]!.status).toBe('PICKED_UP');
    const flags = await get<{ data: unknown[] }>(
      page,
      `/v1/stop-event-flags?status=open&q=${encodeURIComponent(S.t!.tripNo)}`,
    );
    expect(flags.data).toHaveLength(0);
  });
});
