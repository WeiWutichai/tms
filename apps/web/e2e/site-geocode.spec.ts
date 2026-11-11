import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from './fixtures';

/**
 * E2E ST2-T03 geocode: ปุ่ม "ประมาณจากที่อยู่" (provider จำลอง) → ตรวจ → บันทึก = ปักหมุดแล้ว
 * + กล่อง "รอยืนยันพิกัด" ใน drawer: ยืนยัน / ไม่ใช่ตำแหน่งนี้ (เหตุผล) → ตัวกรอง "หาพิกัดไม่พบ"
 * E2E ไม่รัน worker — จำลองผลงาน geocode อัตโนมัติด้วยการเขียนพิกัดเสนอลงฐาน (ตัวงานทดสอบใน API test)
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
test.afterAll(async () => db.$disconnect());

const RUN = String(Date.now()).slice(-6);
const ADDR = '99 ถ.สุขุมวิท ต.ศรีราชา อ.ศรีราชา จ.ชลบุรี 20110';

/** สร้างสถานที่ไม่มีพิกัดผ่านฟอร์ม แล้วเขียนผลที่งาน geocode อัตโนมัติจะเขียน (พิกัดเสนอรอยืนยัน) */
async function siteWithProposal(
  page: import('@playwright/test').Page,
  name: string,
): Promise<string> {
  await page.goto('/master/locations');
  await page.getByRole('button', { name: 'เพิ่มสถานที่' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('ชื่อสถานที่').fill(name);
  await d.getByLabel('ที่อยู่').fill(ADDR);
  await d.getByRole('button', { name: 'เพิ่มสถานที่' }).click();
  await expect(page.getByRole('status')).toContainText(`เพิ่ม ${name} แล้ว`);
  const r = await db.customerSite.updateMany({
    where: { name, lat: null },
    data: {
      geocodeLat: '13.171230',
      geocodeLng: '100.931450',
      geocodeConfidence: '0.90',
      geocodeProvider: 'mock',
      geocodedAt: new Date(),
    },
  });
  expect(r.count).toBe(1);
  return name;
}

test.describe.serial('สถานที่ → geocode (ST2-T03)', () => {
  test('ปุ่ม "ประมาณจากที่อยู่" เติมพิกัดให้ตรวจ → บันทึก = ปักหมุดแล้ว · ที่อยู่มั่ว = แจ้งให้กรอกเอง', async ({
    page,
  }) => {
    const name = `คลังประมาณพิกัด ${RUN}`;
    await page.goto('/master/locations');
    await page.getByRole('button', { name: 'เพิ่มสถานที่' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('ชื่อสถานที่').fill(name);
    // ที่อยู่มั่ว → toast ไม่พบ ช่องพิกัดว่างเหมือนเดิม
    await d.getByLabel('ที่อยู่').fill('zzz ไม่มีที่นี่ 123');
    await d.getByRole('button', { name: 'ประมาณจากที่อยู่' }).click();
    await expect(page.getByRole('status')).toContainText('ไม่พบตำแหน่งจากที่อยู่');
    await expect(d.getByLabel('พิกัด')).toHaveValue('');
    // ที่อยู่จริง → พิกัดในช่อง + คำใบ้ให้ตรวจ
    await d.getByLabel('ที่อยู่').fill(ADDR);
    await d.getByRole('button', { name: 'ประมาณจากที่อยู่' }).click();
    await expect(d.getByLabel('พิกัด')).toHaveValue(/^13\.1\d{4}, 100\.9\d{4}$/);
    await expect(d.getByText('ประมาณจากที่อยู่ (ศรีราชา)')).toBeVisible();
    const ll = await d.getByLabel('พิกัด').inputValue();
    await d.getByRole('button', { name: 'เพิ่มสถานที่' }).click();
    await expect(page.getByRole('status')).toContainText(`เพิ่ม ${name} แล้ว`);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(ll)).toBeVisible();
    await expect(drawer.getByText('ใช้งาน', { exact: true })).toBeVisible();
    await expect(drawer.getByTestId('geo-review')).toHaveCount(0);
  });

  test('drawer "รอยืนยันพิกัด" → ยืนยันพิกัด → ปักหมุดแล้ว', async ({ page }) => {
    const name = await siteWithProposal(page, `จุดรอยืนยัน ${RUN}`);
    await page.goto('/master/locations');
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toContainText('รอยืนยันพิกัด');
    await row.click();
    const drawer = page.getByRole('dialog');
    const box = drawer.getByTestId('geo-review');
    await expect(box).toContainText('ความมั่นใจ 90%');
    await expect(
      drawer.getByText('13.17123, 100.93145 (ประมาณจากที่อยู่ · รอยืนยัน)'),
    ).toBeVisible();
    await box.getByRole('button', { name: 'ยืนยันพิกัด' }).click();
    await expect(page.getByRole('status')).toContainText(`ยืนยันพิกัด ${name} แล้ว`);
    await expect(drawer.getByTestId('geo-review')).toHaveCount(0);
    await expect(drawer.getByText('13.17123, 100.93145', { exact: true })).toBeVisible();
    await expect(row).toContainText('13.1712, 100.931');
  });

  test('ไม่ใช่ตำแหน่งนี้ (เหตุผล ≥ 10) → หาพิกัดไม่พบ + ตัวกรองคอลัมน์พิกัด', async ({ page }) => {
    const name = await siteWithProposal(page, `จุดพิกัดผิด ${RUN}`);
    await page.goto('/master/locations');
    await page.getByRole('row', { name: new RegExp(name) }).click();
    const drawer = page.getByRole('dialog');
    await drawer
      .getByTestId('geo-review')
      .getByRole('button', { name: 'ไม่ใช่ตำแหน่งนี้' })
      .click();
    const dlg = page.getByRole('dialog', { name: /พิกัดที่ประมาณไม่ถูกต้อง/ });
    const ok = dlg.getByRole('button', { name: 'ไม่ใช่ตำแหน่งนี้' });
    await dlg.getByLabel('เหตุผล').fill('สั้น');
    await expect(ok).toBeDisabled();
    await dlg.getByLabel('เหตุผล').fill('หมุดอยู่คนละฝั่งถนนกับประตูโรงงาน');
    await ok.click();
    await expect(page.getByRole('status')).toContainText(`ปักหมุด ${name} เอง`);
    const d2 = page.getByRole('dialog');
    await expect(d2.getByTestId('geo-review')).toContainText('หาพิกัดจากที่อยู่ไม่พบ');
    await expect(
      d2.getByTestId('geo-review').getByRole('button', { name: 'ปักหมุดเอง' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('columnheader').getByLabel('พิกัด').selectOption('FAILED');
    await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('หาพิกัดไม่พบ');
    await expect(page.getByRole('row', { name: new RegExp(`จุดรอยืนยัน ${RUN}`) })).toHaveCount(0);
  });
});
