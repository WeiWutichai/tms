import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST4-T09 ลิงก์รถร่วม ส่วน POD (docs/04 E2 "ePOD ผ่านลิงก์", E2.1 M10) — เกณฑ์ตรวจรับ:
 * ปิดงานจากมือถือพร้อมรูป 2 ใบ + ลายเซ็น แล้ว DO เป็น UNBILLED; รูปที่ 6 ถูกปฏิเสธ
 * เตรียมข้อมูลผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ · หน้า public เปิดใน context ใหม่ (ไม่ login) จอ 390 px
 */
const RUN = String(Date.now()).slice(-6);
const CARRIER = `หจก. ศรีราชาโลจิสติกส์ลิงก์POD ${RUN}`;
const PLATE = `76-${RUN.slice(-4)}`;
const PHONE = `06${RUN.slice(-1)}${RUN.slice(-4)}${RUN.slice(-3)}`.slice(0, 10);
const DRIVER = `สมชาย ใจดีลิงก์POD ${RUN}`;
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

test.describe.serial('ลิงก์รถร่วม ส่วน POD (ST4-T09)', () => {
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
      legalName: `บจก. เอ็นเอสเอฟ อินดัสทรีลิงก์POD ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังบางปูลิงก์POD ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ท่าเรือแหลมฉบังลิงก์POD ${RUN}`,
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
      taxId: jurTax(Number(RUN) + 977),
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
        overrideReason: 'ทดสอบลิงก์รถร่วม ส่วน POD',
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
    });
    const p = await ctx.newPage();
    await p.goto(`${E2E_WEB}${new URL(url).pathname}`);
    return { ctx, p };
  };
  const png = (n: number) => ({
    name: `pod-${n}.png`,
    mimeType: 'image/png',
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`photo-${n}-${RUN}`),
    ]),
  });

  test('เกณฑ์ตรวจรับ: ถึงจุดส่ง → รูปที่ 6 ถูกปฏิเสธ → รูป 2 ใบ + ลายเซ็น → ส่ง POD (ปิดงาน) → DO UNBILLED · ผู้จัดรถเห็น "ลิงก์รถร่วม"', async ({
    page,
    browser,
  }) => {
    const { ctx, p } = await mobile(browser, S.podUrl!);
    await p.getByTestId('pdl-q').fill(S.doNo!);
    // ถึงจุดรับ → ออกจากจุดรับ → ถึงจุดส่ง (ส่วนสถานะ T08)
    await p.getByRole('button', { name: 'ถึงจุดรับ' }).click();
    await p.getByRole('button', { name: 'ออกจากจุดรับ' }).click();
    await p.getByRole('button', { name: 'ถึงจุดส่ง' }).click();
    await expect(p.getByTestId('pdl-act')).toHaveCount(0);
    await expect(p.getByTestId('pdl-stop-DELIVERY')).toContainText(/ถึงแล้ว/);
    const submit = p.getByTestId('pdl-pod-submit');
    await expect(submit).toHaveText('ส่ง POD');
    // ไม่มีรูป → toast ตามต้นแบบ
    await submit.click();
    await expect(p.getByRole('status')).toHaveText('แนบรูปอย่างน้อย 1 รูป');
    // เลือก 6 รูป → อัปโหลด 5 · รูปที่ 6 ถูกปฏิเสธ
    await p.getByTestId('pdl-photo-input').setInputFiles([1, 2, 3, 4, 5, 6].map(png));
    await expect(p.getByRole('button', { name: 'ลบรูปที่ 5' })).toBeVisible();
    await expect(p.getByRole('button', { name: 'ลบรูปที่ 6' })).toHaveCount(0);
    await expect(p.getByTestId('pdl-pod-err')).toHaveText('แนบรูปได้ไม่เกิน 5 รูป');
    await expect(p.getByTestId('pdl-add-photo')).toHaveCount(0);
    for (const n of [5, 4, 3]) await p.getByRole('button', { name: `ลบรูปที่ ${n}` }).click();
    await expect(p.getByRole('button', { name: /^ลบรูปที่/ })).toHaveCount(2);
    // ลายเซ็นบนจอ
    const pad = p.getByTestId('pdl-sig');
    await pad.scrollIntoViewIfNeeded();
    const box = (await pad.boundingBox())!;
    await p.mouse.move(box.x + 30, box.y + 80);
    await p.mouse.down();
    for (let i = 1; i <= 10; i++)
      await p.mouse.move(box.x + 30 + i * 25, box.y + 80 - (i % 3) * 20);
    await p.mouse.up();
    await expect(p.getByRole('button', { name: 'ล้าง' })).toBeVisible();
    await submit.click();
    await expect(p.getByRole('status')).toHaveText(`ส่ง POD ${S.doNo} แล้ว`);
    await expect(p.getByTestId('pdl-sent')).toContainText(S.doNo!);
    await expect(p.getByTestId('pdl-sent')).toContainText('2 รูป · รอตรวจ');
    // ค้นอีกครั้ง → ส่งแล้ว ไม่มีฟอร์ม
    await p.getByTestId('pdl-q').fill(S.doNo!);
    await expect(p.getByTestId('pdl-pod-sent')).toContainText('ส่ง POD ของ DO นี้แล้ว');
    await expect(p.getByTestId('pdl-pod-submit')).toHaveCount(0);
    await ctx.close();

    // ผู้จัดรถ: DO รอวางบิล · หลักฐาน source LINK · เที่ยวจบ
    type DoRow = { id: string; status: string; podStatus?: string };
    const d = (await get<{ data: DoRow[] }>(page, `/v1/delivery-orders?orderId=${S.so!.id}`))
      .data[0]!;
    expect(d.status).toBe('UNBILLED');
    const pod = await get<{ current: { source: string; photos: unknown[]; signature: unknown } }>(
      page,
      `/v1/delivery-orders/${d.id}/pod`,
    );
    expect(pod.current.source).toBe('LINK');
    expect(pod.current.photos).toHaveLength(2);
    expect(pod.current.signature).toBeTruthy();
    const ev = (await get<{ data: Ev[] }>(page, `/v1/trips/${S.t!.id}/events`)).data;
    expect(ev.filter((e) => e.type === 'COMPLETE').every((e) => e.source === 'LINK')).toBe(true);
    // drawer เที่ยว แท็บเอกสาร: "บันทึกโดย {รถร่วม} · ลิงก์รถร่วม"
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(S.so!.soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: S.t!.tripNo }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('tab', { name: 'เอกสารแนบ' }).click();
    await expect(dlg.getByTestId('do-pod').getByText('POD ครบ')).toBeVisible();
    const line = dlg.getByText(new RegExp(`บันทึกโดย ${CARRIER} · ลิงก์รถร่วม`));
    // DO ที่หลักฐานครบไม่กางอัตโนมัติ — กดหัวบล็อกเพื่อกาง
    if (!(await line.isVisible()))
      await dlg.getByTestId('do-pod').getByText(S.doNo!).first().click();
    await expect(line).toBeVisible();
  });
});
