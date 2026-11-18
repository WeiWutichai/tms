import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { DEMO_EMAIL, DEMO_IDS, DEMO_PASSWORD, E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST9-T10 ส่งออกตามตัวกรองเป็นงานเบื้องหลัง — ผ่าน /v1 จริง (ฐาน e2e) + worker จริง (`src/worker.ts`) · ข้อมูลสมมติ
 * เกณฑ์ตรวจรับ: export เป็น job แล้วได้ลิงก์ดาวน์โหลดทางแจ้งเตือน; ไฟล์ตรงกับ filter
 * (50,000 แถวทดสอบใน apps/api/test/exports.test.ts — E2E ใช้ชุดเล็กเพื่อความเร็ว)
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
const OWNER = DEMO_IDS[DEMO_EMAIL]!;
const RUN = String(Date.now()).slice(-6);

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

test.describe('ส่งออกตามตัวกรอง (ST9-T10)', () => {
  test.afterAll(async () => db.$disconnect());

  test('หน้าใบค้าง: ค้นหา → ตัวเลือก → ส่งออก CSV → งานเบื้องหลัง → แจ้งเตือนพร้อมลิงก์ → ดาวน์โหลดไฟล์ตรงตัวกรอง', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const H = { Authorization: `Bearer ${await token(page)}` };
    const call = async (method: 'get' | 'post', path: string, data?: object) => {
      const r = await page.request[method](path, { headers: H, ...(data ? { data } : {}) });
      expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
      return r.json();
    };
    // ข้อมูล: ใบค้าง 2 ใบ (ลูกค้ายังไม่จับคู่) + ใบมีราคา 1 ใบ ที่ค้นหาด้วย RUN เจอเหมือนกัน (อยู่ในไฟล์เมื่อค้างเท่านั้น)
    const company = (await call('get', '/v1/companies?status=active&limit=1')).data[0].id;
    const cust = (
      await call('post', '/v1/customers', {
        legalName: `ลูกค้าส่งออกอีทูอี ${RUN}`,
        billingCompanyId: company,
      })
    ).id as string;
    const site = async (name: string) =>
      (
        await call('post', '/v1/customer-sites', {
          name,
          kind: 'DROPOFF',
          address: { line1: name },
          customerId: cust,
        })
      ).id as string;
    const a = await site(`คลังส่งออก ก ${RUN}`);
    const b = await site(`ร้านส่งออก ข ${RUN}`);
    const vt = (
      (await call('get', '/v1/vehicle-types?limit=50')).data as { id: string; code: string }[]
    ).find((v) => v.code === '6W')!.id;
    const unit = (
      (await call('get', '/v1/units?limit=50')).data as { id: string; code: string }[]
    ).find((u) => u.code === 'TON')!.id;
    const rc = await call('post', '/v1/rate-cards', {
      customerId: cust,
      originId: a,
      destinationId: b,
      vehicleTypeId: vt,
      validFrom: new Date(Date.now() + 7 * 3600_000 - 30 * 86400_000).toISOString().slice(0, 10),
      pricingModel: 'PER_TRIP',
      sellRate: '3800',
    });
    await call('post', `/v1/rate-cards/${rc.id}/approve`, { reason: 'อนุมัติตามใบเสนอราคา' });
    const order = async (customer: object, ref: string) =>
      (await call('post', '/v1/orders', {
        customer,
        customerRef: ref,
        billingCompanyId: company,
        requestedDate: new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10),
        vehicleTypeId: vt,
        stops: [
          { type: 'PICKUP', siteId: a },
          { type: 'DELIVERY', siteId: b },
        ],
        lines: [{ description: 'น้ำดื่มขวด', qty: '10', unitId: unit, weightKg: '10000' }],
      })) as { id: string; soNo: string; status: string };
    const h1 = await order({ externalId: `EXP1-${RUN}`, name: 'ลูกค้าต้นทาง' }, `HOLD-${RUN}-1`);
    const h2 = await order({ externalId: `EXP2-${RUN}`, name: 'ลูกค้าต้นทาง' }, `HOLD-${RUN}-2`);
    await order({ id: cust }, `OK-${RUN}`);
    expect([h1.status, h2.status]).toEqual(['on_hold', 'on_hold']);
    const before = new Date();

    await page.goto('/so/hold');
    await expect(page.getByRole('heading', { name: 'ใบค้าง' })).toBeVisible();
    await page.getByPlaceholder('ค้นหา').first().fill(RUN);
    await expect(page.getByRole('row', { name: new RegExp(h1.soNo) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(h2.soNo) })).toBeVisible();

    await page.getByRole('button', { name: 'ตัวเลือก', exact: true }).click();
    await page.getByRole('button', { name: 'ส่งออก CSV' }).click();
    // ไม่มี worker → ยังไม่เสร็จใน ~8 วินาที → แจ้งว่าจะส่งลิงก์ทางแจ้งเตือน
    await expect(
      page.getByText('กำลังส่งออก — ระบบจะแจ้งเตือนพร้อมลิงก์ดาวน์โหลดเมื่อไฟล์พร้อม'),
    ).toBeVisible({
      timeout: 15_000,
    });

    // worker จริงทำงานจนงานส่งออกของผู้ใช้นี้เสร็จ
    await runWorker(async () => {
      const n = await db.job.count({
        where: { type: 'export.file', status: 'SUCCEEDED', createdAt: { gte: before } },
      });
      return n >= 1;
    });
    const job = await db.job.findFirst({
      where: { type: 'export.file', createdAt: { gte: before } },
      orderBy: { createdAt: 'desc' },
    });
    expect((job!.payload as { actorId: string; filter: object }).actorId).toBe(OWNER);
    expect((job!.payload as { filter: object }).filter).toEqual({ held: 'true', q: RUN });

    // แจ้งเตือน (กระดิ่ง) → ลิงก์ /exports/{jobId}
    const inbox = await call('get', '/v1/me/notifications?unread=true&limit=20');
    const note = (inbox.data as { body: string; link: string | null; type: string }[]).find((x) =>
      x.link?.includes('/exports/job_'),
    )!;
    // ไฟล์ต้องตรงกับรายการของตัวกรองเดียวกัน ณ ตอนส่งออก (worker อาจตั้งเหตุค้างเพิ่ม เช่น หาพิกัดไม่ได้)
    const listed = (
      (await call('get', `/v1/orders?held=true&q=${RUN}&limit=200`)).data as { soNo: string }[]
    ).map((o) => o.soNo);
    expect(listed).toEqual(expect.arrayContaining([h1.soNo, h2.soNo]));
    const n = listed.length;
    expect(note.body).toContain(`ส่งออกใบสั่งขนส่ง ${n} รายการเสร็จแล้ว`);
    await page.reload();
    await page.getByRole('button', { name: /การแจ้งเตือน/ }).click();
    await expect(
      page.getByText(`ส่งออกใบสั่งขนส่ง ${n} รายการเสร็จแล้ว`, { exact: false }),
    ).toBeVisible();

    // เปิดลิงก์จากแจ้งเตือน → ดาวน์โหลดอัตโนมัติ
    const download = page.waitForEvent('download');
    await page.goto(new URL(note.link, E2E_WEB).pathname);
    await expect(page.getByText('ไฟล์ส่งออกพร้อมแล้ว')).toBeVisible();
    await expect(page.getByText(`· ${n} รายการ · ดาวน์โหลดได้ถึง`, { exact: false })).toBeVisible();
    const d = await download;
    expect(d.suggestedFilename()).toMatch(/^orders-\d{8}-\d{4}\.csv$/);
    const text = readFileSync((await d.path())!, 'utf8');
    const lines = text.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lines[0]).toMatch(/^เลข SO,รหัสลูกค้า,ลูกค้า,เส้นทาง,น้ำหนัก \(กก\.\)/);
    expect(
      lines
        .slice(1)
        .map((l) => l.split(',')[0])
        .sort(),
    ).toEqual([...listed].sort());
    await page.screenshot({ path: 'test-results/st9-t10-export-ready.png' });
  });
});
