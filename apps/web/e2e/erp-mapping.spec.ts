import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { DEMO_EMAIL, expect, test } from './fixtures';

/**
 * E2E ST7-T18 Sync master ลงมา: connector demo → ซิงก์ผังรหัสสินค้าจาก DemoProvider → หน้า ตั้งค่า → การเชื่อมต่อ
 * (ลิงก์ `?connector=` แบบเดียวกับที่คำสั่งที่ถูกกันชี้มา) → กรอกรหัสสินค้าให้ค่าบริการ → บันทึก → คงอยู่หลังโหลดใหม่
 * รหัสที่ไม่อยู่ในผัง → กรอบแดง + ข้อความ · การกันคำสั่ง push (FAILED_FINAL VALIDATION + ลิงก์) ทดสอบใน apps/api/test/erp-master-codes.test.ts
 */
const RUN = String(Date.now()).slice(-6);

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

test('mapping ค่าบริการ ↔ รหัสสินค้า ERP: ซิงก์ผังรหัส → กรอกรหัส → บันทึก · รหัสไม่รู้จัก = แจ้งผิด', async ({
  page,
}) => {
  const auth = { Authorization: `Bearer ${await token(page)}` };
  const c = await page.request.post('/v1/connectors', {
    headers: auth,
    data: { adapterKey: 'demo', credentials: { apiKey: `demo-${RUN}` } },
  });
  expect(c.status(), await c.text()).toBe(201);
  const conId = ((await c.json()) as { id: string }).id;
  try {
    const s = await page.request.post(`/v1/connectors/${conId}/master-codes/sync`, {
      headers: auth,
      data: { kinds: ['ITEM'] },
    });
    expect(s.status(), await s.text()).toBe(200);
    const m = await page.request.get(`/v1/connectors/${conId}/mappings`, { headers: auth });
    const rows = ((await m.json()) as { data: { serviceItem: { id: string; nameTh: string } }[] })
      .data;
    expect(rows.length).toBeGreaterThan(1);
    const [first, second] = [rows[0]!.serviceItem, rows[1]!.serviceItem];

    await page.goto(`/settings?sec=conn&connector=${conId}`);
    await expect(page.getByRole('heading', { name: 'ระบบบัญชี (ERP)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ตั้งค่า ERP จำลอง (Demo)' })).toBeVisible();
    // สร้างแล้วยังไม่เปิดใช้ (PAUSED) = ตั้งค่าล่วงหน้าได้
    await expect(page.getByText('ยังไม่ได้เชื่อมต่อ · ตั้งค่าล่วงหน้าได้')).toBeVisible();
    await expect(
      page.getByText('จับคู่ประเภทค่าใช้จ่าย ↔ รหัสสินค้าใน ERP จำลอง (Demo)'),
    ).toBeVisible();

    const label = (n: string) => `รหัสสินค้าใน ERP จำลอง (Demo) ${n}`;
    const a = page.getByLabel(label(first.nameTh), { exact: true });
    await expect(a).toHaveValue('');
    await a.fill('SV-FRT-01');
    await a.press('Enter');
    await expect
      .poll(async () => {
        const r = await page.request.get(`/v1/connectors/${conId}/mappings`, { headers: auth });
        const d = (await r.json()) as {
          data: { serviceItem: { id: string }; itemCode: string | null; status: string }[];
        };
        return d.data.find((x) => x.serviceItem.id === first.id);
      })
      .toMatchObject({ itemCode: 'SV-FRT-01', status: 'MAPPED' });

    const b = page.getByLabel(label(second.nameTh), { exact: true });
    await b.fill('NOT-IN-ERP');
    await b.press('Enter');
    await expect(b).toHaveAttribute('title', 'ไม่พบรหัสนี้ในผังรหัสสินค้าของ ERP จำลอง (Demo)');

    await page.reload();
    await expect(page.getByLabel(label(first.nameTh), { exact: true })).toHaveValue('SV-FRT-01');
    await expect(page.getByLabel(label(second.nameTh), { exact: true })).toHaveValue('');
  } finally {
    await page.request.post(`/v1/connectors/${conId}/disconnect`, {
      headers: auth,
      data: { reason: 'จบการทดสอบ E2E mapping' },
    });
  }
});
