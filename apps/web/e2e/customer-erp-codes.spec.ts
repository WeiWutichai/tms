import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { DEMO_EMAIL, expect, test } from './fixtures';

/**
 * E2E ST8-T05 รหัสลูกค้าในระบบบัญชีที่เชื่อมต่อ (ต้นแบบ TMS v4 drawer ลูกค้า แท็บ "รหัสระบบบัญชี" + กล่องเตือนในแท็บทั่วไป)
 * มี connector → แท็บแสดง · ยังไม่มีรหัส = เตือน "ยังไม่ได้ map …" + ป้าย "ยังไม่ map" · กรอก → บันทึก → "สำเร็จ" คงอยู่หลังโหลดใหม่
 * การจับคู่จาก SO ของ KRS (map ครั้งเดียวได้ทั้งรหัส NSF/PP) + ยกเลิก SO ทดสอบใน apps/api/test/krs-mapping-cancel.test.ts
 */
const RUN = String(Date.now()).slice(-6);
const NAME = `ลูกค้ารหัสบัญชี E2E ${RUN}`;

function taxIdFor(seed: string): string {
  const base = `0777${seed}`.padEnd(12, '0').slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

async function token(page: Page): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  const r1 = await page.request.post('/v1/auth/login', {
    data: {
      email: DEMO_EMAIL,
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

test('ลูกค้า: แท็บรหัสระบบบัญชี — เตือนเมื่อยังไม่ map · กรอกรหัส → บันทึก → สำเร็จ', async ({
  page,
}) => {
  const auth = { Authorization: `Bearer ${await token(page)}` };
  const cust = await page.request.post('/v1/customers', {
    headers: auth,
    data: { legalName: NAME, taxId: taxIdFor(RUN) },
  });
  expect(cust.status(), await cust.text()).toBe(201);
  const c = await page.request.post('/v1/connectors', {
    headers: auth,
    data: { adapterKey: 'demo', credentials: { apiKey: `demo-${RUN}` } },
  });
  expect(c.status(), await c.text()).toBe(201);
  const conId = ((await c.json()) as { id: string }).id;
  try {
    await page.goto('/master/customers');
    await page.getByRole('row', { name: new RegExp(NAME) }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByTestId('cust-erp-warn')).toHaveText(
      'ยังไม่ได้ map รหัสลูกค้าใน ERP จำลอง (Demo) · ใบแจ้งหนี้ของลูกค้านี้จะส่งเข้า ERP จำลอง (Demo) ไม่ได้',
    );
    await d.getByRole('tab', { name: 'รหัสระบบบัญชี' }).click();
    await expect(
      d.getByRole('heading', { name: 'รหัสลูกค้าในระบบบัญชีที่เชื่อมต่อ' }),
    ).toBeVisible();
    const row = d.getByTestId('cust-erp-row');
    await expect(row).toContainText('ERP จำลอง (Demo)');
    await expect(row).toContainText('ยังไม่ map');
    const input = d.getByLabel('รหัสลูกค้าใน ERP จำลอง (Demo)');
    await expect(input).toHaveAttribute('placeholder', 'ยังไม่ map');
    await input.fill(`C-${RUN}`);
    await d.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`บันทึกข้อมูล ${NAME} แล้ว`);
    await expect(row).toContainText('สำเร็จ');
    await page.reload();
    await page.getByRole('row', { name: new RegExp(NAME) }).click();
    await expect(page.getByRole('dialog').getByTestId('cust-erp-warn')).toHaveCount(0);
    await page.getByRole('dialog').getByRole('tab', { name: 'รหัสระบบบัญชี' }).click();
    await expect(page.getByRole('dialog').getByLabel('รหัสลูกค้าใน ERP จำลอง (Demo)')).toHaveValue(
      `C-${RUN}`,
    );
  } finally {
    await page.request.post(`/v1/connectors/${conId}/disconnect`, {
      headers: auth,
      data: { reason: 'จบการทดสอบ E2E รหัสลูกค้า' },
    });
  }
});
