import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { DEMO_EMAIL, DEMO_IDS, DEMO_PASSWORD, expect, test } from './fixtures';

/**
 * E2E ST5-T22 อายุลูกหนี้ (การ์ด "อายุลูกหนี้" หน้ารับชำระ — ต้นแบบ TMS v4 vPay) ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 * เกณฑ์ตรวจรับ: ยอดรวมทุกช่วงอายุ = ยอดค้างรับรวม (KPI "ยอดค้างรับ" / `GET /payments/summary`) · กดช่วง = กรองตาราง + ชิป
 * ใบที่ออกแล้วตั้งตรงในฐาน (วันครบกำหนดย้อนหลัง — ออกผ่าน API ได้แค่วันนี้ขึ้นไป)
 */
const env = Object.fromEntries(
  readFileSync(new URL('./.env.e2e', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], m[2]]),
);
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });
const RUN = String(Date.now()).slice(-6);
const bkk = (offsetDays = 0) =>
  new Date(Date.now() + 7 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
const num = (s: string) => Math.round(Number(s.replace(/[^\d.]/g, '')) * 100);

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

test.describe('อายุลูกหนี้ (ST5-T22)', () => {
  test.afterAll(async () => db.$disconnect());

  test('การ์ดอายุลูกหนี้: Σ ช่วง = ยอดค้างรับ · กดช่วง 31–60 วัน → ตารางเหลือใบในช่วง + ชิป · ลบชิป = กลับทั้งหมด', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const owner = await db.appUser.findUniqueOrThrow({ where: { id: DEMO_IDS[DEMO_EMAIL]! } });
    const tenantId = owner.tenantId as string;
    const branch = await db.branch.findFirstOrThrow({ where: { tenantId } });
    const customer = await db.customer.create({
      data: { tenantId, code: `C-AG-${RUN}`, legalName: `ลูกค้าอายุหนี้ ${RUN}` },
    });
    const mk = async (suffix: string, total: string, dueOffset: number) =>
      db.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          issuingCompanyId: branch.companyId,
          issuingBranchId: branch.id,
          status: 'ISSUED',
          totalAmount: total,
          subtotalExempt: total,
          netExpectedAmount: total,
          invoiceNo: `INV-E2E-AG-${RUN}-${suffix}`,
          issuedAt: new Date(),
          issuedBy: 'e2e',
          issueDate: new Date(`${bkk(dueOffset - 30)}T00:00:00.000Z`),
          dueDate: new Date(`${bkk(dueOffset)}T00:00:00.000Z`),
          customerSnapshot: {
            name: customer.legalName,
            taxId: null,
            branchCode: null,
            address: '',
          },
          issuerSnapshot: { name: 'ผู้ออกทดสอบ', taxId: null, branchCode: '00000', address: '' },
          printOptions: { yearStyle: 'BE', whtMinimumAmount: 0, templateVersion: 1 },
        },
      });
    await mk('N', '4200.00', 5); // ยังไม่ครบกำหนด
    await mk('A', '1100.00', -10); // 1–30
    await mk('B', '2300.00', -40); // 31–60
    await mk('C', '900.00', -100); // เกิน 90

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/pay');
    const card = page.getByTestId('aging-card');
    await expect(card).toContainText('อายุลูกหนี้');
    await expect(card).toContainText('กดช่วงอายุเพื่อกรองตาราง');
    await expect(card.locator('h2 + span')).not.toContainText('—');

    // เกณฑ์ตรวจรับ: Σ ทุกช่วงบนการ์ด = ยอดรวมบนการ์ด = KPI ยอดค้างรับ = API summary
    const H = { Authorization: `Bearer ${await token(page)}` };
    const sum = (await (await page.request.get('/v1/payments/summary', { headers: H })).json()) as {
      sellOutstanding: string;
    };
    const total = num((await card.locator('> div').first().locator('> span').innerText()) ?? '');
    const buckets = card.locator('button');
    await expect(buckets).toHaveCount(5);
    let s = 0;
    for (let i = 0; i < 5; i++) s += num(await buckets.nth(i).locator('span').nth(2).innerText());
    expect(s).toBe(total);
    expect(total).toBe(num(sum.sellOutstanding));
    await expect(page.getByRole('button', { name: /ยอดค้างรับ/ })).toContainText(
      (await card.locator('> div').first().locator('> span').innerText()).replace('฿', ''),
    );

    await page.screenshot({ path: 'test-results/st5-t22-pay-aging-actual-1440.png' });

    // กดช่วง 31–60 วัน → ชิป "อายุหนี้ 31–60 วัน" · ตารางมีใบ B ไม่มีใบ A/N/C ของรอบนี้
    await buckets.filter({ hasText: '31–60 วัน' }).click();
    await expect(buckets.filter({ hasText: '31–60 วัน' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('อายุหนี้ 31–60 วัน')).toBeVisible();
    const rows = page.locator('tbody tr').filter({ hasText: `INV-E2E-AG-${RUN}` });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`INV-E2E-AG-${RUN}-B`);
    await expect(rows.first()).toContainText('เกิน 40 วัน');
    await page.screenshot({ path: 'test-results/st5-t22-pay-aging-filter-actual-1440.png' });

    // ลบชิป → กลับรายการทั้งหมด (4 ใบของรอบนี้)
    await page.getByRole('button', { name: 'ล้างตัวกรองอายุหนี้' }).click();
    await expect(page.getByText('อายุหนี้ 31–60 วัน')).toHaveCount(0);
    await expect(rows).toHaveCount(4);
    // กดช่วงเดิมซ้ำ = เลิกกรอง · เลือกแท็บ = ล้างตัวกรองช่วง
    await buckets.filter({ hasText: 'เกิน 90 วัน' }).click();
    await expect(rows).toHaveCount(1);
    await page.getByRole('tab', { name: /ค้างรับ/ }).click();
    await expect(page.getByText('อายุหนี้ เกิน 90 วัน')).toHaveCount(0);
  });
});
