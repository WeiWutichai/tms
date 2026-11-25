import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { trustedDeviceHeaders } from './fixtures';

/**
 * ST4-T15 เมทริกซ์มือถือแบบจำลอง — หน้า public 3 หน้า (ข้อเสนองาน, POD, tracking) × project ใน playwright.mobile.config.ts
 * (Chrome Android, Safari iOS, LINE in-app Android/iOS) — รัน: `pnpm e2e:mobile` (opt-in ไม่อยู่ใน `pnpm e2e`)
 * ต่อหน้า: จอ 390 px ไม่มี scroll แนวนอน (ตรวจซ้ำที่ 360 px) · ข้อความไทยครบ (ไม่มี key i18n หลุด) · ขนาดเป้ากด
 * · ปุ่มหลักทำงานด้วยการแตะ (tap) · POD แนบรูปผ่าน file input + เซ็นด้วยนิ้ว (touch)
 * ภาพหน้าจอ + รายงานเป้ากด → plan/sign-offs/st4-t15/ (ใช้ใน checklist)
 * หน้า public เปิดใน page ของ project (ไม่ login) · เตรียมข้อมูลผ่าน /v1 จริงด้วย `request` (context แยก) · ข้อมูลสมมติ
 * ปิดคำขอออกนอกเครื่อง (เช่น Google Fonts) — ไม่ส่งข้อมูลออกภายนอกระหว่างทดสอบ
 */
const OUT = new URL('../../../plan/sign-offs/st4-t15/', import.meta.url).pathname;
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
/** [DECISION — lead 25 พ.ย. 2569, ย้อนได้] เกณฑ์เป้ากดขั้นต่ำ 24 px (WCAG 2.2 SC 2.5.8 AA) เป็นเกณฑ์ตก;
 *  ต่ำกว่า 44 px (Apple HIG / WCAG 2.5.5 AAA) รายงานเป็นข้อสังเกตเพื่อเทียบต้นแบบ — docs/04 ≥ 48 px เป็นข้อของแอปคนขับ (P1) */
const MIN_TARGET = 24;
const GOOD_TARGET = 44;

function jurTax(n: number): string {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

async function token(request: APIRequestContext): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  // D-78: owner ต้องมี 2FA — ข้ามขั้น TOTP ด้วย cookie อุปกรณ์ที่จำไว้จาก seed
  const r1 = await request.post('/v1/auth/login', {
    headers: trustedDeviceHeaders('owner@demo-a.test'),
    data: {
      email: 'owner@demo-a.test',
      password: 'demo-password-2569',
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
  });
  const { code } = (await r1.json()) as { code: string };
  const r2 = await request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  });
  return ((await r2.json()) as { accessToken: string }).accessToken;
}

type Target = { tag: string; name: string; w: number; h: number };
type PageReport = {
  page: string;
  width390: { scrollWidth: number; clientWidth: number };
  width360: { scrollWidth: number; clientWidth: number };
  inputFontPx: number[];
  smallTargets: Target[];
  failTargets: Target[];
  rawKeys: string[];
};
const reports: Record<string, PageReport> = {};

/** ตรวจ layout มือถือของหน้าปัจจุบัน + ภาพหน้าจอ → คืนรายงาน (assert ข้อที่เป็นเกณฑ์ตก) */
async function checkPage(p: Page, info: TestInfo, key: string): Promise<void> {
  await p.waitForLoadState('networkidle');
  const vp = p.viewportSize()!;
  const widths = async () =>
    p.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
  const w390 = await widths();
  const shot = `${info.project.name}-${key}.jpg`;
  mkdirSync(OUT, { recursive: true });
  await p.screenshot({ path: OUT + shot, type: 'jpeg', quality: 60, fullPage: true, scale: 'css' });
  const scan = await p.evaluate(() => {
    const vis = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const targets = [
      ...document.querySelectorAll(
        'button, input:not([type=hidden]):not([type=file]), select, textarea, [role=button], a[href]',
      ),
    ]
      .filter(vis)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          name: (
            el.getAttribute('aria-label') ||
            (el as HTMLInputElement).placeholder ||
            el.textContent ||
            ''
          )
            .trim()
            .slice(0, 40),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      });
    const inputFontPx = [...document.querySelectorAll('input, textarea, select')]
      .filter(vis)
      .map((el) => parseFloat(getComputedStyle(el).fontSize));
    // key i18n ที่หลุด (เช่น "pdl.pod.add") แปลว่าข้อความไทยไม่ครบ
    const rawKeys = (
      document.body.innerText.match(/\b[a-z]{2,6}\.[a-z]+\.[A-Za-z.]+\b/g) ?? []
    ).filter((s) => !/\.(com|co|th|test|net)\b/.test(s));
    return { targets, inputFontPx, rawKeys, thai: /[฀-๿]/.test(document.body.innerText) };
  });
  // ตรวจซ้ำที่ 360 px แล้วคืนขนาดเดิม
  await p.setViewportSize({ width: 360, height: vp.height });
  await p.waitForTimeout(150);
  const w360 = await widths();
  await p.setViewportSize(vp);
  const r: PageReport = {
    page: key,
    width390: w390,
    width360: w360,
    inputFontPx: [...new Set(scan.inputFontPx)],
    smallTargets: scan.targets.filter((t) => Math.min(t.w, t.h) < GOOD_TARGET),
    // ลิงก์ในบรรทัดข้อความ (เช่น tel:) ได้ยกเว้นตาม 2.5.8 — ตกเฉพาะปุ่ม/ช่องกรอก
    failTargets: scan.targets.filter((t) => t.tag !== 'a' && Math.min(t.w, t.h) < MIN_TARGET),
    rawKeys: scan.rawKeys,
  };
  reports[key] = r;
  writeFileSync(
    `${OUT}${info.project.name}.json`,
    JSON.stringify({ project: info.project.name, viewport: vp, pages: reports }, null, 2) + '\n',
  );
  expect(scan.thai, 'มีข้อความไทยบนหน้า').toBe(true);
  expect(r.rawKeys, 'ไม่มี key i18n หลุดบนหน้า').toEqual([]);
  expect(w390.scrollWidth, `ไม่มี scroll แนวนอนที่ ${vp.width} px`).toBeLessThanOrEqual(
    w390.clientWidth,
  );
  expect(w360.scrollWidth, 'ไม่มี scroll แนวนอนที่ 360 px').toBeLessThanOrEqual(w360.clientWidth);
  expect(r.failTargets, `เป้ากด ≥ ${MIN_TARGET} px`).toEqual([]);
}

/** เซ็นด้วยนิ้ว: chromium ใช้ touch จริงของ CDP (เบราว์เซอร์สร้าง pointer event ชนิด touch เอง)
 *  webkit ไม่มี API ลาก touch → ยิง PointerEvent pointerType "touch" ลง canvas (ลำดับเดียวกับเครื่องจริง) */
async function touchSign(p: Page, browserName: string, pad: Locator): Promise<void> {
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  const pts = Array.from({ length: 11 }, (_, i) => ({
    x: Math.round(box.x + 30 + i * 25),
    y: Math.round(box.y + 80 - (i % 3) * 20),
  }));
  if (browserName === 'chromium') {
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pts[0]!] });
    for (const pt of pts.slice(1))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await pad.evaluate((el, pts) => {
      // pointer สังเคราะห์ไม่มี pointer จริงให้ capture — กัน NotFoundError ของ setPointerCapture เฉพาะ element นี้
      (el as HTMLCanvasElement).setPointerCapture = () => undefined;
      const fire = (type: string, pt: { x: number; y: number }) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            clientX: pt.x,
            clientY: pt.y,
          }),
        );
      fire('pointerdown', pts[0]!);
      for (const pt of pts.slice(1)) fire('pointermove', pt);
      fire('pointerup', pts[pts.length - 1]!);
    }, pts);
  }
}

test.describe.serial('ST4-T15 หน้า public บนมือถือ (จำลอง)', () => {
  test.describe.configure({ timeout: 120_000 });
  let H: Record<string, string> = {};
  const S: {
    RUN?: string;
    tAccept?: { id: string; tripNo: string };
    tDecline?: { id: string; tripNo: string };
    urlAccept?: string;
    urlDecline?: string;
    soAccept?: string;
    doId?: string;
    doNo?: string;
    po?: string;
    plate?: string;
    driver?: string;
    phone?: string;
    custId?: string;
  } = {};

  const get = async <X>(request: APIRequestContext, path: string) =>
    (await (await request.get(path, { headers: H })).json()) as X;
  const post = async <X>(
    request: APIRequestContext,
    path: string,
    data: object,
    headers: Record<string, string> = H,
  ) => {
    const r = await request.post(path, {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data,
    });
    expect(r.status(), await r.text()).toBeLessThan(300);
    return (await r.json()) as X;
  };

  test.beforeEach(async ({ request, page }, info) => {
    // ไม่ส่งคำขอออกนอกเครื่อง (ฟอนต์ Google ฯลฯ) — ฟอนต์บนเครื่องจริงตรวจในรอบมือ
    await page.context().route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
    H = { Authorization: `Bearer ${await token(request)}` };
    if (S.RUN) return;
    const RUN = `${String(Date.now()).slice(-5)}${info.project.name.length % 10}`;
    S.RUN = RUN;
    S.plate = `7${RUN.slice(0, 1)}-${RUN.slice(-4)}`;
    S.driver = `สมชาย มือถือ ${RUN}`;
    S.phone = `09${RUN.slice(-4)}${RUN.slice(0, 4)}`.slice(0, 10);
    S.po = `PO-MOB-${RUN}`;
    // หน้าติดตาม: ปุ่มโทรบริษัท + การ์ดหลักฐานการส่ง (ค่าเริ่มปิด)
    const st = await request.patch('/v1/settings', {
      headers: H,
      data: { values: { 'tracking.contactPhone': '02-118-4400', 'tracking.showPod': true } },
    });
    expect(st.status(), await st.text()).toBe(200);
    type Page1 = { data: { id: string; code?: string; doNo?: string }[] };
    const company = (await get<Page1>(request, '/v1/companies?status=active&limit=1')).data[0]!.id;
    const cust = await post<{ id: string }>(request, '/v1/customers', {
      legalName: `บจก. สยามมือถือ ${RUN}`,
      billingCompanyId: company,
    });
    S.custId = cust.id;
    const addr = (pv: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: pv });
    const a = await post<{ id: string }>(request, '/v1/customer-sites', {
      name: `คลังบางปู มือถือ ${RUN}`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    });
    const b = await post<{ id: string }>(request, '/v1/customer-sites', {
      name: `ท่าเรือแหลมฉบัง มือถือ ${RUN}`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
      contact: { name: 'คุณวิไล', phone: '081-234-4507' },
    });
    const ton = (await get<Page1>(request, '/v1/units?limit=50')).data.find(
      (u) => u.code === 'TON',
    )!.id;
    const vt6 = (await get<Page1>(request, '/v1/vehicle-types?limit=50')).data.find(
      (x) => x.code === '6W',
    )!.id;
    const day = (n: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const c = await post<{ id: string }>(request, '/v1/carriers', {
      legalName: `หจก. ขนส่งมือถือ ${RUN}`,
      entityType: 'JURISTIC',
      taxId: jurTax(Number(RUN) + 313),
    });
    const v = await post<{ id: string }>(request, '/v1/vehicles', {
      plate: S.plate,
      plateProvince: 'TH-20',
      vehicleTypeId: vt6,
      ownership: 'SUBCONTRACT',
      carrierId: c.id,
    });
    for (const docType of ['INSURANCE', 'COMPULSORY_ACT']) {
      const f = await post<{ id: string; uploadUrl: string }>(request, '/v1/documents', {
        kind: 'VEHICLE_DOC',
        mime: 'application/pdf',
        bytes: PDF.length,
        filename: `${docType}.pdf`,
      });
      const u = new URL(f.uploadUrl);
      const put = await request.put(u.pathname + u.search, {
        headers: { ...H, 'Content-Type': 'application/octet-stream' },
        data: PDF,
      });
      expect(put.status(), await put.text()).toBe(200);
      await post(request, `/v1/vehicles/${v.id}/documents`, {
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
    await post(request, '/v1/drivers', {
      name: S.driver,
      phone: S.phone,
      employmentType: 'CARRIER_DRIVER',
      carrierId: c.id,
      licenceClass: 'T2',
      licenceExpiresOn: day(300),
    });
    const order = (ref?: string) =>
      post<{ id: string; soNo: string }>(request, '/v1/orders', {
        customer: { id: cust.id },
        ...(ref ? { customerRef: ref } : {}),
        requestedDate: today,
        vehicleTypeId: vt6,
        stops: [
          { type: 'PICKUP', siteId: a.id },
          { type: 'DELIVERY', siteId: b.id },
        ],
        lines: [{ description: 'ปูนซีเมนต์ถุง', qty: '5', unitId: ton, weightKg: '8600' }],
      });
    const offer = async (soId: string) => {
      const d = (await get<Page1>(request, `/v1/delivery-orders?orderId=${soId}`)).data[0]!;
      const t = await post<{ id: string; tripNo: string }>(request, '/v1/trips', {
        tripDate: today,
        deliveryOrderIds: [d.id],
      });
      await post(request, `/v1/trips/${t.id}/offer`, {
        carrierId: c.id,
        cost: '5600',
        selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว',
      });
      const l = await get<{ link: { url: string } }>(request, `/v1/trips/${t.id}/offer-link`);
      return { t, url: l.link.url, d };
    };
    const so1 = await order(S.po);
    const so2 = await order();
    const o1 = await offer(so1.id);
    const o2 = await offer(so2.id);
    S.soAccept = so1.id;
    S.tAccept = o1.t;
    S.urlAccept = o1.url;
    S.doId = o1.d.id;
    S.doNo = o1.d.doNo;
    S.tDecline = o2.t;
    S.urlDecline = o2.url;
  });

  test('ข้อเสนองาน — ปฏิเสธด้วยการแตะ', async ({ page, request }, info) => {
    await page.goto(new URL(S.urlDecline!).pathname);
    await expect(page.getByTestId('ofl-status')).toHaveText('รอตอบ');
    await expect(page.getByText(S.tDecline!.tripNo)).toBeVisible();
    await checkPage(page, info, 'offer');
    await page.getByRole('button', { name: 'ปฏิเสธ' }).tap();
    await page.getByRole('button', { name: 'รถไม่ว่างวันที่รับงาน' }).tap();
    await page.getByRole('button', { name: 'ยืนยันปฏิเสธ' }).tap();
    await expect(page.getByTestId('ofl-status')).toHaveText('ปฏิเสธ');
    await expect(page.getByTestId('ofl-rejected')).toContainText('รถไม่ว่างวันที่รับงาน');
    const tr = await get<{ status: string }>(request, `/v1/trips/${S.tDecline!.id}`);
    expect(tr.status).toBe('PLANNING');
  });

  test('ข้อเสนองาน — รับงาน + กรอกทะเบียน/คนขับด้วยแป้นมือถือ', async ({ page, request }, info) => {
    await page.goto(new URL(S.urlAccept!).pathname);
    await expect(page.getByTestId('ofl-status')).toHaveText('รอตอบ');
    await page.getByRole('button', { name: 'รับงาน' }).tap();
    await checkPage(page, info, 'offer-accept-form');
    const plate = page.getByPlaceholder('เช่น 74-5521 ชบ.');
    await plate.tap();
    await plate.fill(`${S.plate} ชบ.`);
    await page.getByPlaceholder('ชื่อ-นามสกุล').fill(S.driver!);
    await page.getByPlaceholder('08x-xxx-xxxx').fill(S.phone!);
    await page.getByRole('button', { name: 'ยืนยันรับงาน' }).tap();
    await expect(page.getByTestId('ofl-status')).toHaveText('รับงาน');
    await expect(page.getByTestId('ofl-accepted')).toContainText(`รถ ${S.plate}`);
    await checkPage(page, info, 'offer-accepted');
    const tr = await get<{ status: string }>(request, `/v1/trips/${S.tAccept!.id}`);
    expect(tr.status).toBe('ASSIGNED');
  });

  test('POD — ถึง/ออก/ถึง · แนบรูป 2 ใบ · เซ็นด้วยนิ้ว · ส่ง POD → DO UNBILLED', async ({
    page,
    request,
    browserName,
  }, info) => {
    const id = S.tAccept!.id;
    const podUrl = (await get<{ podLink: { url: string } }>(request, `/v1/trips/${id}/offer-link`))
      .podLink.url;
    const r = await request.post(`/v1/trips/${id}/dispatch`, { headers: H, data: {} });
    if (r.status() !== 200) {
      const w = (await r.json()) as { warnings?: { key: string }[] };
      await post(request, `/v1/trips/${id}/dispatch`, {
        ruleKeys: (w.warnings ?? []).map((x) => x.key),
        overrideReason: 'ทดสอบมือถือจำลอง ST4-T15',
      });
    }
    await page.goto(new URL(podUrl).pathname);
    await checkPage(page, info, 'pod');
    const q = page.getByTestId('pdl-q');
    await q.tap();
    await q.fill(S.doNo!);
    await page.getByRole('button', { name: 'ถึงจุดรับ' }).tap();
    await page.getByRole('button', { name: 'ออกจากจุดรับ' }).tap();
    await page.getByRole('button', { name: 'ถึงจุดส่ง' }).tap();
    await expect(page.getByTestId('pdl-stop-DELIVERY')).toContainText(/ถึงแล้ว/);
    // รูปถ่าย: file input (บนเครื่องจริงปุ่มเดียวกันเปิดกล้อง/คลังรูป — ตรวจในรอบมือ)
    const png = (n: number) => ({
      name: `pod-${n}.png`,
      mimeType: 'image/png',
      buffer: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(`photo-${n}-${S.RUN}`),
      ]),
    });
    await expect(page.getByTestId('pdl-add-photo')).toBeVisible();
    await page.getByTestId('pdl-photo-input').setInputFiles([png(1), png(2)]);
    await expect(page.getByRole('button', { name: /^ลบรูปที่/ })).toHaveCount(2);
    const pad = page.getByTestId('pdl-sig');
    await touchSign(page, browserName, pad);
    await expect(page.getByRole('button', { name: 'ล้าง' })).toBeVisible();
    // มีเส้นจริงบน canvas (ไม่ใช่แค่สถานะ)
    const inked = await pad.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
      return n;
    });
    expect(inked).toBeGreaterThan(50);
    // หน้าจอไม่เลื่อนตามนิ้วระหว่างเซ็น (touch-action: none)
    expect(await pad.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
    await checkPage(page, info, 'pod-filled');
    await page.getByTestId('pdl-pod-submit').tap();
    await expect(page.getByRole('status')).toHaveText(`ส่ง POD ${S.doNo} แล้ว`);
    await expect(page.getByTestId('pdl-sent')).toContainText('2 รูป · รอตรวจ');
    const d = await get<{ status: string }>(request, `/v1/delivery-orders/${S.doId}`);
    expect(d.status).toBe('UNBILLED');
  });

  test('tracking — ลิงก์ลูกค้า ค้นเลข PO + เบอร์ 4 ตัว · ลิงก์ต่อ DO เห็นสถานะ + POD', async ({
    page,
    request,
  }, info) => {
    const custUrl = (
      await post<{ url: string }>(request, `/v1/customers/${S.custId}/tracking-link`, {})
    ).url;
    const doUrl = (
      await post<{ url: string }>(request, `/v1/delivery-orders/${S.doId}/tracking-link`, {})
    ).url;
    await page.goto(new URL(custUrl).pathname);
    await expect(page.getByRole('button', { name: 'ติดตาม' })).toBeVisible();
    await checkPage(page, info, 'tracking-search');
    const ref = page.getByLabel('เลขใบส่งของ หรือเลข PO');
    await ref.tap();
    await ref.fill(S.po!);
    await page.getByLabel('เบอร์โทรผู้รับ 4 ตัวท้าย').fill('4507');
    await page.getByRole('button', { name: 'ติดตาม' }).tap();
    await expect(page.getByTestId('trk-badge')).toHaveText('ส่งแล้ว');
    await expect(page.getByTestId('trk-refs')).toContainText(S.po!);
    await expect(page.locator('body')).not.toContainText('5,600');
    await checkPage(page, info, 'tracking-result');

    await page.goto(new URL(doUrl).pathname);
    await expect(page.getByTestId('trk-badge')).toHaveText('ส่งแล้ว');
    await expect(page.getByTestId('trk-pod')).toBeVisible();
    await checkPage(page, info, 'tracking-do');
  });
});
