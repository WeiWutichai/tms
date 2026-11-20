import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { DEMO_EMAIL, DEMO_IDS, DEMO_PASSWORD, E2E_WEB, expect, test } from './fixtures';

/**
 * E2E ST5-T18 เกินกำหนด (ธงที่ job รายวันตั้ง) — ผ่าน /v1 จริง (ฐาน e2e) + worker จริง (`src/worker.ts`) · ข้อมูลสมมติ
 * เกณฑ์ตรวจรับ: ใบเลย due date ที่ยังไม่จ่ายเป็น "เกินกำหนด" หลัง job รัน (หน้า วางบิล KPI/แท็บ/คอลัมน์ครบกำหนดสีแดง + หน้า รับชำระ แท็บ
 * เกินกำหนด) · จ่ายครบเป็น "ชำระแล้ว" · ใบที่ออกแล้วตั้งตรงในฐาน (วันครบกำหนดย้อนหลัง — ออกผ่าน API ได้แค่วันนี้ขึ้นไป)
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
const RUN = String(Date.now()).slice(-6);
const bkk = (offsetDays = 0) =>
  new Date(Date.now() + 7 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

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

test.describe('ใบแจ้งหนี้เกินกำหนด (ST5-T18)', () => {
  test.afterAll(async () => db.$disconnect());

  test('job รายวัน → เกินกำหนด (วางบิล + รับชำระ) · จ่ายครบ → ชำระแล้ว', async ({ page }) => {
    test.setTimeout(240_000);
    // job เริ่ม 00:05 เวลาไทย — ช่วง 00:00–00:05 ยังไม่สร้าง job
    const hm = new Date(Date.now() + 7 * 3600_000).toISOString().slice(11, 16);
    test.skip(hm < '00:06', 'ช่วงก่อนเวลาเริ่ม job เกินกำหนด');
    const owner = await db.appUser.findUniqueOrThrow({ where: { id: DEMO_IDS[DEMO_EMAIL]! } });
    const tenantId = owner.tenantId as string;
    const branch = await db.branch.findFirstOrThrow({ where: { tenantId } });
    const customer = await db.customer.create({
      data: { tenantId, code: `C-OD-${RUN}`, legalName: `ลูกค้าเกินกำหนด ${RUN}` },
    });
    const invNo = `INV-E2E-OD-${RUN}`;
    const due = bkk(-5);
    const inv = await db.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        issuingCompanyId: branch.companyId,
        issuingBranchId: branch.id,
        status: 'ISSUED',
        totalAmount: '1500.00',
        subtotalExempt: '1500.00',
        netExpectedAmount: '1500.00',
        invoiceNo: invNo,
        issuedAt: new Date(),
        issuedBy: 'e2e',
        issueDate: new Date(`${bkk(-35)}T00:00:00.000Z`),
        dueDate: new Date(`${due}T00:00:00.000Z`),
        customerSnapshot: { name: customer.legalName, taxId: null, branchCode: null, address: '' },
        issuerSnapshot: { name: 'ผู้ออกทดสอบ', taxId: null, branchCode: '00000', address: '' },
        printOptions: { yearStyle: 'BE', whtMinimumAmount: 0, templateVersion: 1 },
      },
    });
    // job ของวันนี้อาจถูกสร้างไปแล้วโดย spec อื่นที่รัน worker — ลบเพื่อให้ worker สร้างรอบใหม่ (งานเดิม idempotent)
    await db.job.deleteMany({ where: { tenantId, type: 'invoice.overdue' } });

    await page.setViewportSize({ width: 1440, height: 900 });
    // ก่อน job: ไม่คำนวณตอนอ่าน — ยังเป็น "ออกแล้ว"
    await page.goto('/pay');
    const payRow = page.locator('tbody tr').filter({ hasText: invNo });
    await expect(payRow).toContainText('ออกแล้ว');

    await runWorker(
      async () => !!(await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).overdueAt,
    );

    // หน้า วางบิล: KPI "เกินกำหนดชำระ" → แท็บเกินกำหนด · ครบกำหนดสีแดง "เกิน 5 วัน" · สถานะ "เกินกำหนด"
    await page.goto('/bill');
    const kpi = page.getByRole('button', { name: /เกินกำหนดชำระ/ });
    await expect(kpi).not.toContainText('—');
    await kpi.click();
    const billRow = page.locator('tbody tr').filter({ hasText: invNo });
    await expect(billRow).toContainText('เกินกำหนด');
    await expect(billRow).toContainText('เกิน 5 วัน');
    await billRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/st5-t18-bill-overdue-actual-1440.png' });

    // หน้า รับชำระ: แท็บ เกินกำหนด
    await page.goto('/pay');
    await page.getByRole('tab', { name: /เกินกำหนด/ }).click();
    await expect(payRow).toContainText('เกินกำหนด');
    await expect(payRow).toContainText('เกิน 5 วัน');
    await page.screenshot({ path: 'test-results/st5-t18-pay-overdue-actual-1440.png' });

    // จ่ายครบ (ผ่าน /v1) → ชำระแล้ว · หลุดจากเกินกำหนด
    const H = { Authorization: `Bearer ${await token(page)}` };
    const r = await page.request.post('/v1/payments', {
      headers: { ...H, 'Idempotency-Key': randomUUID() },
      data: {
        receivedDate: bkk(),
        method: 'TRANSFER',
        amountReceived: '1500.00',
        allocations: [{ invoiceId: `ivc_${inv.id.replace(/-/g, '')}`, amount: '1500.00' }],
      },
    });
    expect(r.status(), await r.text()).toBe(201);
    await page.goto('/pay');
    await page.getByRole('tab', { name: /เกินกำหนด/ }).click();
    await expect(payRow).toHaveCount(0);
    await page.getByRole('tab', { name: /ชำระแล้ว/ }).click();
    await expect(payRow).toContainText('ชำระแล้ว');
  });
});
