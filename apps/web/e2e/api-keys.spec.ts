import { expect, test } from './fixtures';

/**
 * E2E ST7-T01 ตั้งค่า → นักพัฒนา / Open API → API keys (ผ่าน API จริง ฐาน e2e)
 * เกณฑ์ตรวจรับ: key ไม่มี orders:write เรียก POST /orders ได้ 403 · หมุนแล้ว key เดิมใช้ได้ถึง revokeAt (เพิกถอน = หยุดทันที)
 */
const RUN = String(Date.now()).slice(-6);
const NAME = `ERP อีทูอี ${RUN}`;

test.describe.serial('นักพัฒนา / Open API → API keys', () => {
  let secret = '';

  test('สร้าง key → secret แสดงครั้งเดียว → ใช้เรียก API ได้ตาม scope', async ({ page }) => {
    await page.goto('/settings');
    await page
      .getByRole('navigation', { name: 'ตั้งค่า' })
      .getByRole('button', { name: 'นักพัฒนา / Open API' })
      .click();
    await expect(page).toHaveURL(/\/settings\/api$/);
    await expect(
      page.getByRole('heading', { name: 'นักพัฒนา / Open API', level: 1 }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'สร้าง API key' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'สร้าง key' }).click();
    await expect(d.getByText('กรอกชื่อ key')).toBeVisible();
    await expect(d.getByText('เลือกอย่างน้อย 1 scope')).toBeVisible();
    await d.getByLabel('ชื่อ key').fill(NAME);
    await d.getByText('orders:read', { exact: true }).click();
    await d.getByLabel('IP ที่อนุญาต').fill('300.1.1.1');
    await d.getByRole('button', { name: 'สร้าง key' }).click();
    await expect(d.getByText('รูปแบบ IP ไม่ถูกต้อง เช่น 203.150.12.0/24')).toBeVisible();
    await d.getByLabel('IP ที่อนุญาต').fill('');
    await d.getByRole('button', { name: 'สร้าง key' }).click();

    const sec = page.getByRole('dialog', { name: 'สร้าง API key แล้ว' });
    await expect(sec.getByText(`${NAME} · Production · orders:read`)).toBeVisible();
    secret = await sec.getByLabel('Secret key').inputValue();
    expect(secret).toMatch(/^tk_live_[0-9a-f]{48}$/);
    await sec.getByRole('button', { name: 'คัดลอกแล้ว · ปิดหน้าต่าง' }).click();
    await expect(page.getByRole('status')).toContainText('ระบบจะไม่แสดง secret นี้อีก');
    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await expect(row).toContainText(`${secret.slice(0, 12)}…`);
    await expect(row).toContainText('ใช้งาน');

    const auth = { Authorization: `Bearer ${secret}` };
    expect((await page.request.get('/v1/orders', { headers: auth })).status()).toBe(200);
    const denied = await page.request.post('/v1/orders', { headers: auth, data: {} });
    expect(denied.status()).toBe(403);
    expect((await denied.json()).code).toBe('permission_denied');
  });

  test('แก้ scope เพิ่ม orders:write → POST /orders ผ่านด่านสิทธิ์', async ({ page }) => {
    await page.goto('/settings/api');
    const row = page.getByRole('row', { name: new RegExp(NAME) });
    await row.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: 'แก้ scope' }).click();
    const d = page.getByRole('dialog');
    await d.getByText('orders:write', { exact: true }).click();
    await d.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`บันทึก scope ของ ${NAME} แล้ว`);
    const r = await page.request.post('/v1/orders', {
      headers: { Authorization: `Bearer ${secret}` },
      data: {},
    });
    expect(r.status()).toBe(422);
  });

  test('หมุนเวียน key (เหตุผล) → key เดิมยังใช้ได้ (ถึง revokeAt) + key ใหม่ใช้ได้ → เพิกถอนเดิม → 401', async ({
    page,
  }) => {
    await page.goto('/settings/api');
    await page.getByRole('row', { name: new RegExp(NAME) }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('API key · Production')).toBeVisible();
    await drawer.getByRole('button', { name: 'หมุนเวียน key' }).click();
    const dlg = page.getByRole('dialog', { name: `หมุนเวียน key "${NAME}"` });
    await dlg.getByRole('textbox').fill('หมุนตามรอบความปลอดภัยประจำไตรมาส');
    await dlg.getByRole('button', { name: 'หมุนเวียน key' }).click();
    const sec = page.getByRole('dialog', { name: 'Key ใหม่จากการหมุนเวียน' });
    await expect(sec.getByText('key เดิมใช้ได้อีก 24 ชั่วโมง')).toBeVisible();
    const fresh = await sec.getByLabel('Secret key').inputValue();
    expect(fresh).not.toBe(secret);
    await sec.getByRole('button', { name: 'คัดลอกแล้ว · ปิดหน้าต่าง' }).click();

    for (const k of [secret, fresh])
      expect(
        (
          await page.request.get('/v1/orders', { headers: { Authorization: `Bearer ${k}` } })
        ).status(),
      ).toBe(200);

    await page.getByRole('tab', { name: /หมุนเวียน/ }).click();
    const old = page.getByRole('row', { name: new RegExp(`${secret.slice(0, 12)}`) });
    await expect(old).toContainText('หมุนเวียน');
    await old.getByRole('button').last().click();
    await expect(page.getByRole('menuitem', { name: 'หมุนเวียน key' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'เพิกถอน' }).click();
    const rv = page.getByRole('dialog', { name: `เพิกถอน key "${NAME}"` });
    await rv.getByRole('textbox').fill('ย้ายไปใช้ key ใหม่ครบแล้ว');
    await rv.getByRole('button', { name: 'เพิกถอน key' }).click();
    await expect(page.getByRole('status')).toContainText(`เพิกถอน ${NAME} แล้ว`);
    const dead = await page.request.get('/v1/orders', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(dead.status()).toBe(401);
    expect((await dead.json()).code).toBe('key_revoked');
    expect(
      (
        await page.request.get('/v1/orders', { headers: { Authorization: `Bearer ${fresh}` } })
      ).status(),
    ).toBe(200);
  });
});
