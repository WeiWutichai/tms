import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

/**
 * E2E P1-ST2-T02 หน้าราคาสาธารณะ `/pricing` — ไม่ต้อง login · bundle แยกเหมือน landing
 * เปิด/ปิดด้วยค่าตั้งแพลตฟอร์ม `pricing.publicVisible` (ตั้งตรงในฐาน e2e ด้วย role เจ้าของตาราง — Console แก้ได้ใน platform-settings)
 * ราคาตั้งต้น docs/02 §2 จาก seed migration 0175 · ปิดคำขอออกนอกเครื่อง
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
const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
const KEY = 'pricing.publicVisible';
const setVisible = (v: boolean) =>
  db.platformSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: v },
    update: { value: v },
  });

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page }) => {
  await page.context().route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
});
test.afterAll(async () => {
  await db.platformSetting.deleteMany({ where: { key: KEY } });
  await db.$disconnect();
});

test('ค่าเริ่ม (pricing.publicVisible = false): /pricing กลับ /home · landing ไม่มีเมนู/ลิงก์ราคา', async ({
  page,
}) => {
  await db.platformSetting.deleteMany({ where: { key: KEY } });
  await page.goto('/pricing');
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('จัดรถ ตามงาน');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'ราคา' })).toHaveCount(0);
  await expect(page.locator('a[href="/pricing"]')).toHaveCount(0);
});

test('เปิดราคา: landing "เริ่ม ฿350" → หน้าราคา · คำนวณ 30 คัน = ฿8,400 / รายปี ฿7,140 · ตารางเปรียบเทียบ', async ({
  page,
}) => {
  await setVisible(true);
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(r.url());
  });
  await page.goto('/home');
  await expect(page.getByText('เริ่ม ฿350 ต่อรถต่อเดือน')).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'ราคา' }).click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'จ่ายตามจำนวนรถที่วิ่งจริงในเดือน',
  );
  await expect(page).toHaveTitle(/ราคา TMS/);
  expect(scripts.some((u) => /AppRoot/.test(u))).toBe(false);
  await expect(page.getByText('ราคาตั้งต้น — ยังไม่ประกาศ')).toBeVisible();
  await expect(page.getByTestId('plan-std')).toContainText('฿280');

  const box = page.getByRole('textbox', { name: 'จำนวนรถ active ต่อเดือน (รวมรถร่วม)' });
  await box.fill('30');
  await expect(page.getByTestId('calc-month')).toHaveText('฿8,400.00 / เดือน');
  await expect(page.getByRole('button', { name: 'Growth', pressed: true })).toBeVisible();
  await expect(page.getByTestId('calc-result')).toContainText(
    'ราคายังไม่รวม VAT · รวม VAT ≈ ฿8,988.00 / เดือน',
  );
  await page.getByRole('button', { name: /รายปี/ }).click();
  await expect(page.getByTestId('calc-month')).toHaveText('฿7,140.00 / เดือน');
  await expect(page.getByTestId('plan-std')).toContainText('฿238');
  // ขั้นต่ำ: 5 คัน → Starter ฿2,500 − 15%
  await box.fill('5');
  await expect(page.getByTestId('calc-month')).toHaveText('฿2,125.00 / เดือน');

  const row = page.getByTestId('row-multi');
  await expect(row.getByRole('cell')).toHaveText(['หลายนิติบุคคล', '—', '—', '', '']);
  // B1: ฟีเจอร์นอกเฟส 1 ไม่อยู่ในตาราง · ไม่มี MCP
  await expect(page.getByTestId('row-track')).toHaveCount(0);
  await expect(page.getByTestId('row-veh')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('MCP');
  await expect(page.getByTestId('calc-result')).toContainText('VAT 7% ของยอดต่อปี (ประมาณการ)');
  await expect(page.getByTestId('row-api').getByRole('cell').nth(2)).toHaveText('300');
});

test('มือถือ 390: ไม่มี scroll แนวนอน · ปิดราคาอีกครั้ง → กลับ /home', async ({ page }) => {
  await setVisible(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/pricing');
  await expect(page.getByRole('heading', { name: 'คำนวณค่าใช้จ่าย' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await setVisible(false);
  await page.goto('/pricing');
  await expect(page).toHaveURL(/\/home$/);
});
