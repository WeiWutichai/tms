import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ช่องว่างดีไซน์ส่วนปฏิบัติการ/ข้อมูลหลัก (PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ):
 * (1) ผู้รับเหมา แท็บเอกสารแนบ → แนบ ภ.พ.20 → เอาออกพร้อมเหตุผล
 * (2) ตั้งค่า → แจ้งเตือนเอกสารรถ → ปิด 60 วันของภาษี → บันทึก → API เก็บค่า (คืนค่าเดิมท้ายข้อ)
 */
const RUN = String(Date.now()).slice(-6);
const CAR = `หจก. ไฟล์แนบอีทูอี ${RUN}`;
const PDF = {
  name: 'pp20.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),
};
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

test.describe.serial('ช่องว่างดีไซน์ ส่วนปฏิบัติการ/ข้อมูลหลัก (PO 24 พ.ย. 2569)', () => {
  test('ผู้รับเหมา: แนบ ภ.พ.20 → เห็นในรายการ → เอาออก (เหตุผล ≥ 10)', async ({ page }) => {
    const H = { Authorization: `Bearer ${await token(page)}` };
    const r = await page.request.post('/v1/carriers', {
      headers: H,
      data: { legalName: CAR, entityType: 'JURISTIC', taxId: jurTax(Number(RUN) + 11) },
    });
    expect(r.status(), await r.text()).toBe(201);
    await page.goto('/fleet/drivers?tab=con');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(CAR);
    await page.locator('tbody tr').filter({ hasText: CAR }).first().click();
    await page.getByRole('tab', { name: 'เอกสารแนบ' }).click();
    const att = page.getByTestId('att-carrier');
    await expect(att).toContainText('ยังไม่มี ภ.พ.20 / สัญญาจ้าง');
    await att.getByLabel('ประเภทไฟล์').selectOption('VAT_REG');
    await att.getByTestId('att-file-carrier').setInputFiles(PDF);
    await expect(att.getByTestId('att-row')).toContainText('ภ.พ.20 · pp20.pdf');
    await att.getByRole('button', { name: 'เอาไฟล์ออก ภ.พ.20' }).click();
    const dlg = page.getByRole('dialog', { name: /เอาภ.พ.20ออก/ });
    await dlg.getByRole('textbox').fill('แนบผิดไฟล์ ใช้ฉบับใหม่แทน');
    await dlg.getByRole('button', { name: 'เอาไฟล์ออก' }).click();
    await expect(att.getByTestId('att-row')).toHaveCount(0);
  });

  test('ตั้งค่า → แจ้งเตือนเอกสารรถ: ปิด 60 วันของภาษี → บันทึก → ค่าใน API', async ({ page }) => {
    const H = { Authorization: `Bearer ${await token(page)}` };
    await page.goto('/settings?sec=docalert');
    const box = page.getByRole('checkbox', { name: '60 วัน — ภาษี' });
    await expect(box).toBeChecked();
    await box.uncheck();
    await page.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText('บันทึก');
    const s = (await (await page.request.get('/v1/settings', { headers: H })).json()) as {
      data: { key: string; value: Record<string, { levels: number[] }>; version: number }[];
    };
    const row = s.data.find((x) => x.key === 'reminders.expiryAlerts')!;
    expect(row.value.ANNUAL_TAX!.levels).toEqual([30, 7]);
    // คืนค่า (ข้อมูลเดโมใช้ร่วมกับ spec อื่น)
    await box.check();
    await expect(page.getByRole('button', { name: 'บันทึก' })).toBeVisible({ timeout: 8000 });
    await page.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText('บันทึก');
  });
});
