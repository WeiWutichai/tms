import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST2-T21 รถร่วมอัปโหลดเอกสารผ่านลิงก์ — เกณฑ์ตรวจรับ: เปิดลิงก์บนมือถือ อัปโหลดไฟล์แล้วขึ้นรอ admin ยืนยัน
 * เตรียมผู้รับเหมา + รถร่วม (API) → drawer ผู้รับเหมา แท็บ "เอกสารแนบ" → "สร้างลิงก์" → เปิดลิงก์ในหน้าจอมือถือ (390 px,
 * ไม่ login) → ส่ง พ.ร.บ. + ไฟล์ → "รอตรวจ" → admin อนุมัติ (เหตุผล ≥ 10) → หน้าลิงก์แสดง "อนุมัติแล้ว" — ฐาน tms_e2e
 */
const RUN = String(Date.now()).slice(-6);
const CAR = `หจก. รถร่วมลิงก์อีทูอี ${RUN}`;
const PLATE = `76-${RUN.slice(-4)}`;
const PDF = {
  name: 'พรบ.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),
};
const day = (n: number) =>
  new Date(Date.now() + 7 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);

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

test.describe.serial('รถร่วมอัปโหลดเอกสารผ่านลิงก์ (ST2-T21)', () => {
  test('สร้างลิงก์ → มือถือส่ง พ.ร.บ. → รอตรวจ → admin อนุมัติ', async ({ page, browser }) => {
    const H = { Authorization: `Bearer ${await token(page)}` };
    const post = async (path: string, data: object) => {
      const r = await page.request.post(path, { headers: H, data });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as { id: string; data?: unknown };
    };
    const car = await post('/v1/carriers', {
      legalName: CAR,
      entityType: 'JURISTIC',
      taxId: jurTax(Number(RUN) + 7),
    });
    const vts = await page.request.get('/v1/vehicle-types?limit=1', { headers: H });
    const vt = ((await vts.json()) as { data: { id: string }[] }).data[0]!.id;
    await post('/v1/vehicles', {
      plate: PLATE,
      plateProvince: 'TH-20',
      vehicleTypeId: vt,
      ownership: 'SUBCONTRACT',
      carrierId: car.id,
    });

    // admin: drawer ผู้รับเหมา → เอกสารแนบ → สร้างลิงก์
    await page.goto('/fleet/drivers?tab=con');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(CAR);
    await page.locator('tbody tr').filter({ hasText: CAR }).first().click();
    await page.getByRole('tab', { name: 'เอกสารแนบ' }).click();
    await page.getByRole('button', { name: 'สร้างลิงก์' }).click();
    const url = (await page
      .getByTestId('cdoc-issued')
      .locator('span[title]')
      .getAttribute('title'))!;
    expect(url).toMatch(/\/link\/carrier-docs\/ml1\./);
    await expect(page.getByTestId('cdoc-link')).toHaveCount(1);

    // รถร่วม: มือถือ ไม่ login
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'th-TH',
    });
    const m = await mobile.newPage();
    await m.goto(new URL(url).pathname);
    await expect(m.getByText(CAR, { exact: false })).toBeVisible();
    const veh = m.getByTestId('cdl-vehicle').filter({ hasText: PLATE });
    await expect(veh.locator('[data-doc-type=COMPULSORY_ACT]')).toContainText('ยังไม่มีในระบบ');
    await veh.locator('[data-doc-type=COMPULSORY_ACT]').click();
    const form = m.getByTestId('cdl-form');
    await form.getByLabel('เลขที่เอกสาร').fill(`CMI-${RUN}`);
    await form.getByLabel('วันเริ่มคุ้มครอง').fill(day(0));
    await form.getByLabel('วันหมดอายุ').fill(day(365));
    await form.getByTestId('cdl-file').setInputFiles(PDF);
    await expect(form.getByText('ไฟล์ที่ 1')).toBeVisible();
    await form.getByRole('button', { name: 'ส่งเอกสาร' }).click();
    await expect(m.getByRole('status')).toContainText(`ส่งพ.ร.บ. ${PLATE} แล้ว`);
    await expect(veh.locator('[data-doc-type=COMPULSORY_ACT]')).toContainText('รอตรวจ');
    await expect(m.getByTestId('cdl-sent')).toContainText('1 ไฟล์ · รอตรวจ');

    // admin อนุมัติ (เหตุผล ≥ 10)
    await page.reload();
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(CAR);
    await page.locator('tbody tr').filter({ hasText: CAR }).first().click();
    await page.getByRole('tab', { name: 'เอกสารแนบ' }).click();
    const row = page.getByTestId('cdoc-subs').locator('[data-status=pending_review]');
    await expect(row).toContainText(`${PLATE} · พ.ร.บ. · CMI-${RUN}`);
    await row.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: /^อนุมัติ / });
    await dlg.getByRole('textbox').fill('ตรวจ พ.ร.บ. แล้วถูกต้อง');
    await dlg.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
    await expect(page.getByTestId('cdoc-subs').locator('[data-status=approved]')).toBeVisible();

    await m.reload();
    await expect(m.getByTestId('cdl-sent')).toContainText('อนุมัติแล้ว');
    await expect(veh.locator('[data-doc-type=COMPULSORY_ACT]')).toContainText('ใช้ได้ถึง');
    await mobile.close();
  });

  test('admin ไม่อนุมัติ (เหตุผล) → มือถือเห็นเหตุผล · ยกเลิกลิงก์ → หน้า "ลิงก์นี้ใช้ไม่ได้"', async ({
    page,
    browser,
  }) => {
    await page.goto('/fleet/drivers?tab=con');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(CAR);
    await page.locator('tbody tr').filter({ hasText: CAR }).first().click();
    await page.getByRole('tab', { name: 'เอกสารแนบ' }).click();
    await page.getByRole('button', { name: 'สร้างลิงก์' }).click();
    const url = (await page
      .getByTestId('cdoc-issued')
      .locator('span[title]')
      .getAttribute('title'))!;

    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'th-TH',
    });
    const m = await mobile.newPage();
    await m.goto(new URL(url).pathname);
    const veh = m.getByTestId('cdl-vehicle').filter({ hasText: PLATE });
    await veh.locator('[data-doc-type=INSURANCE]').click();
    const form = m.getByTestId('cdl-form');
    await form.getByLabel('เลขที่เอกสาร').fill(`POL-${RUN}`);
    await form.getByLabel('วันเริ่มคุ้มครอง').fill(day(0));
    await form.getByLabel('วันหมดอายุ').fill(day(365));
    await form.getByTestId('cdl-file').setInputFiles({ ...PDF, name: 'กรมธรรม์.pdf' });
    await expect(form.getByText('ไฟล์ที่ 1')).toBeVisible();
    await form.getByRole('button', { name: 'ส่งเอกสาร' }).click();
    await expect(veh.locator('[data-doc-type=INSURANCE]')).toContainText('รอตรวจ');

    await page.reload();
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(CAR);
    await page.locator('tbody tr').filter({ hasText: CAR }).first().click();
    await page.getByRole('tab', { name: 'เอกสารแนบ' }).click();
    const row = page.getByTestId('cdoc-subs').locator('[data-status=pending_review]');
    await row.getByRole('button', { name: 'ไม่อนุมัติ' }).click();
    const dlg = page.getByRole('dialog', { name: /^ไม่อนุมัติ / });
    await dlg.getByRole('textbox').fill('รูปไม่ชัด ถ่ายใหม่ให้เห็นวันหมด');
    await dlg.getByRole('button', { name: 'ไม่อนุมัติ', exact: true }).click();
    await expect(page.getByTestId('cdoc-subs').locator('[data-status=rejected]')).toContainText(
      'รูปไม่ชัด ถ่ายใหม่ให้เห็นวันหมด',
    );

    await m.reload();
    await expect(m.getByTestId('cdl-sent')).toContainText(
      'เหตุผล: รูปไม่ชัด ถ่ายใหม่ให้เห็นวันหมด',
    );

    // ยกเลิกลิงก์ทั้งหมด → มือถือเปิดไม่ได้
    for (;;) {
      const link = page.getByTestId('cdoc-link').first();
      if (!(await link.count())) break;
      await link.getByRole('button', { name: 'ยกเลิกลิงก์' }).click();
      const rd = page.getByRole('dialog', { name: 'ยกเลิกลิงก์อัปโหลดเอกสาร' });
      // เปิดลิงก์ที่ 2 ต้องไม่มีเหตุผลของรอบก่อนค้าง (เดิมล้างทีหลังจนสิ่งที่พิมพ์หาย)
      await expect(rd.getByRole('textbox')).toHaveValue('');
      await rd.getByRole('textbox').fill('ทดสอบยกเลิกลิงก์ E2E');
      const ok = rd.getByRole('button', { name: 'ยกเลิกลิงก์', exact: true });
      await expect(ok).toBeEnabled();
      await ok.click();
      await expect(rd).toBeHidden();
    }
    await m.reload();
    await expect(m.getByRole('alert')).toContainText('ลิงก์นี้ใช้ไม่ได้');
    await mobile.close();
  });
});
