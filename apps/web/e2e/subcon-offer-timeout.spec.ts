import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { DEMO_IDS, E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST3-T24 หมดเวลาข้อเสนองานรถร่วม (docs/04 D3 "ไม่ตอบใน N ชม. → แจ้งเตือน + ปุ่มส่งรายถัดไป"; ลิงก์หมดอายุ → EXPIRED)
 * เกณฑ์ตรวจรับ: เลื่อนเวลา — ครบ N ชม. ผู้จัดรถได้แจ้งเตือน 1 ครั้ง
 * E2E ไม่มีตัวตั้ง Clock ของ API → "เลื่อนเวลา" ด้วยการถอยเวลาเสนอ/หมดอายุของข้อเสนอในฐาน e2e แล้วรัน worker จริง
 * (`src/worker.ts` — ตัวตั้งเวลา `scheduleDue` + JobQueue) จนงานเสร็จ · ข้อมูลสมมติ
 */
const env = Object.fromEntries(
  readFileSync(new URL('./.env.e2e', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], m[2]]),
);
const apiDir = new URL('../../api/', import.meta.url).pathname;
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });
const OWNER = DEMO_IDS['owner@demo-a.test']!;

const RUN = String(Date.now()).slice(-6);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const H = 3600_000;

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

/** รัน worker จริงจนเงื่อนไขเป็นจริง (สูงสุด 90 วิ) แล้วหยุด */
async function runWorker(done: () => Promise<boolean>) {
  const p = spawn('node', ['-r', '@swc-node/register', 'src/worker.ts'], {
    cwd: apiDir,
    env: {
      ...process.env,
      ...env,
      NODE_ENV: 'test',
      SWC_NODE_PROJECT: 'tsconfig.json',
      PUBLIC_WEB_BASE_URL: E2E_WEB,
    },
    stdio: 'ignore',
  });
  try {
    await expect.poll(done, { timeout: 90_000, intervals: [1000] }).toBe(true);
  } finally {
    const exited = new Promise((r) => p.once('exit', r));
    p.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (p.exitCode === null) p.kill('SIGKILL');
  }
}

type Trip = { id: string; tripNo: string; status: string; version: number };

test.describe.serial('หมดเวลาข้อเสนองานรถร่วม (ST3-T24)', () => {
  let HDR: Record<string, string> = {};
  const S: {
    A?: { id: string; name: string };
    B?: { id: string; name: string };
    t1?: Trip;
    t2?: Trip;
    so1?: { id: string; soNo: string };
    so2?: { id: string; soNo: string };
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
      legalName: `บจก. ลูกค้าหมดเวลาอีทูอี ${RUN}`,
      billingCompanyId: company,
    });
    const addr = (p: string) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
    const a = await post<{ id: string }>('/v1/customer-sites', {
      name: `คลังบางนาอีทูอี ${RUN}`,
      kind: 'PICKUP',
      address: addr('กรุงเทพมหานคร'),
    });
    const b = await post<{ id: string }>('/v1/customer-sites', {
      name: `ร้านชลบุรีอีทูอี ${RUN}`,
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
    /** รถร่วม + รถ 6 ล้อ (ประกัน/พ.ร.บ. ครบ) + rate card ขาซื้อ a → b */
    const carrier = async (i: number, rate: string) => {
      const name = `หจก. รถร่วมหมดเวลา${i === 1 ? 'เอ' : 'บี'}อีทูอี ${RUN}`;
      const c = await post<{ id: string }>('/v1/carriers', {
        legalName: name,
        entityType: 'JURISTIC',
        taxId: jurTax(Number(RUN) + 800 + i),
      });
      const v = await post<{ id: string }>('/v1/vehicles', {
        plate: `7${i}-${RUN.slice(-4)}`,
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
    const so = () =>
      post<{ id: string; soNo: string }>('/v1/orders', {
        customer: { id: cust.id },
        requestedDate: today,
        vehicleTypeId: vt6,
        stops: [
          { type: 'PICKUP', siteId: a.id },
          { type: 'DELIVERY', siteId: b.id },
        ],
        lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: '8600' }],
      });
    const doOf = async (id: string) =>
      (await get<Page1>(page, `/v1/delivery-orders?orderId=${id}`)).data[0]!.id;
    const offered = async (s: { id: string }) => {
      const t = await post<Trip>('/v1/trips', {
        tripDate: today,
        deliveryOrderIds: [await doOf(s.id)],
      });
      // จ้างรายถูกสุด (A) ตาม rate card → OFFERED (ผู้จ้าง = owner)
      return post<Trip>(`/v1/trips/${t.id}/offer`, { carrierId: S.A!.id });
    };
    S.so1 = await so();
    S.so2 = await so();
    S.t1 = await offered(S.so1);
    S.t2 = await offered(S.so2);
  });

  const offerOf = (tripNo: string) =>
    db.subconOffer.findFirstOrThrow({
      where: { trip: { tripNo } },
      orderBy: { createdAt: 'desc' },
    }) as Promise<{ id: string; tripId: string; offeredAt: Date; status: string }>;
  /** แจ้งเตือน in-app ของ owner (ผู้จ้าง) ตามแม่แบบ + เลขเที่ยว */
  const notes = (template: string, tripNo: string) =>
    db.notification.count({
      where: {
        recipientId: OWNER,
        channel: 'in_app',
        templateCode: template,
        payload: { path: ['tripNo'], equals: tripNo },
      },
    }) as Promise<number>;

  test('เกณฑ์ตรวจรับ: ครบ N ชม. (2) ยังไม่ตอบ → worker แจ้งผู้จ้าง 1 ครั้ง → กระดิ่ง → drawer "ส่งรายถัดไป" → จ้างรายถัดไปที่ถูกสุด', async ({
    page,
  }) => {
    await db.notification.updateMany({
      where: { recipientId: OWNER, readAt: null },
      data: { readAt: new Date(), status: 'READ' },
    });
    // เลื่อนเวลา: ข้อเสนอของเที่ยว 1 ส่งไปแล้ว 3 ชม. (ครบเวลาตอบ 2 ชม. ไป 1 ชม. — ลิงก์ยังไม่หมดอายุ)
    const o = await offerOf(S.t1!.tripNo);
    const back = new Date(Date.now() - 3 * H);
    await db.subconOffer.update({
      where: { id: o.id },
      data: { offeredAt: back, responseDueAt: new Date(back.getTime() + 2 * H) },
    });
    await runWorker(async () => (await notes('subcon_offer.no_response', S.t1!.tripNo)) >= 1);
    // รอบตรวจถัดไปไม่แจ้งซ้ำ
    await runWorker(
      async () =>
        (await db.job.count({
          where: { type: 'subcon_offer.timeouts', status: { in: ['PENDING', 'RUNNING'] } },
        })) === 0,
    );
    expect(await notes('subcon_offer.no_response', S.t1!.tripNo)).toBe(1);
    expect((await offerOf(S.t1!.tripNo)).status).toBe('OFFERED');

    await page.goto('/');
    await expect(page.getByTestId('bell-dot')).toBeVisible();
    await page.getByRole('button', { name: 'การแจ้งเตือน (มีรายการที่ยังไม่อ่าน)' }).click();
    await expect(page.getByRole('status')).toContainText(
      `${S.t1!.tripNo} · ${S.A!.name} ไม่ตอบรับใน 2 ชม. — ส่งรายถัดไปได้ที่เที่ยวรถ`,
    );

    // ลิงก์ในแจ้งเตือน → กระดานวางแผนเปิด drawer เที่ยวนั้น (QA M1 — route จริง /plan?trip=…)
    const n = (await db.notification.findFirstOrThrow({
      where: {
        recipientId: OWNER,
        channel: 'in_app',
        templateCode: 'subcon_offer.no_response',
        payload: { path: ['tripNo'], equals: S.t1!.tripNo },
      },
    })) as { link: string };
    expect(n.link).toBe(`/plan?trip=${S.t1!.id}`);
    await page.goto(n.link);
    const d = page.getByRole('dialog');
    await expect(d.getByText(S.t1!.tripNo, { exact: true }).first()).toBeVisible();
    // drawer เที่ยว → "จ่ายงานรถร่วม" → ข้อความหมดเวลา + ปุ่ม "ส่งรายถัดไป"
    await d.getByRole('button', { name: 'จ่ายงานรถร่วม' }).click();
    await expect(d.getByTestId('sub-timeout')).toHaveText(
      `${S.A!.name} ยังไม่ตอบรับใน 2 ชม. — ส่งข้อเสนอให้รายถัดไปได้`,
    );
    await d.getByRole('button', { name: 'ส่งรายถัดไป' }).click();
    // รายเริ่มต้น = รายถัดไปที่ถูกสุด (B) · รายเดิมป้าย "ไม่ตอบรับ" · คำเตือนยกเลิกข้อเสนอเดิม
    const sel = d.getByRole('combobox', { name: 'ผู้รับเหมา' });
    await expect(sel.locator('option:checked')).toHaveText(`${S.B!.name} · ฿5,400.00 · ถูกสุด`);
    await expect(sel.locator('option', { hasText: S.A!.name })).toHaveText(
      `${S.A!.name} · ฿5,000.00 · ไม่ตอบรับ`,
    );
    await expect(d.getByTestId('sub-replace')).toHaveText(
      `เมื่อส่งข้อเสนอ ข้อเสนอที่ส่งให้ ${S.A!.name} จะถูกยกเลิก (ลิงก์เดิมใช้ไม่ได้)`,
    );
    await expect(d.getByRole('textbox', { name: 'เหตุผลที่เลือกรายนี้' })).toHaveCount(0);
    await d.getByRole('button', { name: 'ส่งข้อเสนอ' }).click();
    await expect(page.getByRole('status')).toContainText(`เสนองานให้ ${S.B!.name} แล้ว`);
    const t = await get<{ status: string; carrier: { name: string } }>(
      page,
      `/v1/trips/${S.t1!.id}`,
    );
    expect(t).toMatchObject({ status: 'OFFERED', carrier: { name: S.B!.name } });
    const hist = await get<{ data: { status: string; carrierName: string }[] }>(
      page,
      `/v1/trips/${S.t1!.id}/offers`,
    );
    expect(hist.data.map((h) => `${h.status}:${h.carrierName}`)).toEqual([
      `OFFERED:${S.B!.name}`,
      `WITHDRAWN:${S.A!.name}`,
    ]);
  });

  test('ลิงก์หมดอายุ (48 ชม.) → worker ปิดเป็น EXPIRED: เที่ยวกลับรอจัด, ใบสั่งค้าง "รถร่วมปฏิเสธ", ปุ่ม "ส่งรายถัดไป"', async ({
    page,
  }) => {
    const o = await offerOf(S.t2!.tripNo);
    const back = new Date(Date.now() - 49 * H);
    await db.subconOffer.update({
      where: { id: o.id },
      data: {
        offeredAt: back,
        responseDueAt: new Date(back.getTime() + 2 * H),
        expiresAt: new Date(back.getTime() + 48 * H),
      },
    });
    await runWorker(async () => (await offerOf(S.t2!.tripNo)).status === 'EXPIRED');
    const t = await get<{ status: string; assignmentStatus: string; hire: unknown }>(
      page,
      `/v1/trips/${S.t2!.id}`,
    );
    expect(t).toMatchObject({ status: 'PLANNING', assignmentStatus: 'EXPIRED', hire: null });
    expect(await notes('subcon_offer.expired', S.t2!.tripNo)).toBe(1);
    // ใบสั่งค้างด้วยเหตุ CARRIER_REJECTED (docs/01 §4.1 "รถร่วมกดปฏิเสธหรือลิงก์หมดอายุ")
    const held = await get<{ data: { id: string; holdReason: { code: string } | null }[] }>(
      page,
      '/v1/orders?held=true&limit=100',
    );
    expect(held.data.find((x) => x.id === S.so2!.id)?.holdReason?.code).toBe('CARRIER_REJECTED');
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(S.so2!.soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: S.t2!.tripNo }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByRole('button', { name: 'ส่งต่อรถร่วม' })).toHaveCount(0);
    await d.getByRole('button', { name: 'ส่งรายถัดไป' }).click();
    await expect(
      d.getByRole('combobox', { name: 'ผู้รับเหมา' }).locator('option:checked'),
    ).toHaveText(`${S.B!.name} · ฿5,400.00 · ถูกสุด`);
  });
});
