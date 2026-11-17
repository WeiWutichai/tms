import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST4-T05 POD checklist (แกน) — ฐาน tms_e2e
 * - ตั้งค่า → หลักฐานส่ง (POD): แก้ค่าเริ่มต้นขององค์กร → บันทึก → คงอยู่หลังโหลดใหม่
 * - ลูกค้า A กำหนดเอง "บังคับรูป + ลายเซ็น" ผ่าน drawer (แท็บ เงื่อนไข) → checklist ที่ใช้จริง = ของลูกค้า;
 *   ลูกค้า B ใช้ค่าเริ่มต้นขององค์กร (ตัวตรวจปฏิเสธการปิดงานไม่มีรูป — integration test apps/api/test/pod-checklist.test.ts)
 */
const RUN = String(Date.now()).slice(-6);
const A = `บจก. ลูกค้า POD เอ ${RUN}`;
const B = `บจก. ลูกค้า POD บี ${RUN}`;
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

test.describe.serial('POD checklist (ST4-T05)', () => {
  test('ตั้งค่า → หลักฐานส่ง (POD): หมายเหตุบังคับ → บันทึก → คงอยู่หลังโหลดใหม่', async ({
    page,
  }) => {
    await page.goto('/settings?sec=pod');
    await expect(page.getByRole('heading', { name: 'หลักฐานส่ง (POD) ค่าเริ่มต้น' })).toBeVisible();
    await expect(
      page.getByRole('radio', { name: 'บังคับ — รูปหลักฐาน', exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole('radio', { name: 'ไม่บังคับ — หมายเหตุ', exact: true }),
    ).toBeChecked();
    await page.getByRole('radio', { name: 'บังคับ — หมายเหตุ', exact: true }).check();
    const patched = page.waitForResponse(
      (r) => r.url().endsWith('/v1/settings') && r.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'บันทึก' }).click();
    expect((await patched).status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('บันทึกการตั้งค่าหลักฐานส่ง (POD)แล้ว');
    await page.reload();
    await expect(page.getByRole('radio', { name: 'บังคับ — หมายเหตุ', exact: true })).toBeChecked({
      timeout: 20_000,
    });
  });

  test('ลูกค้า A บังคับรูป + ลายเซ็น (กำหนดเอง); ลูกค้า B ใช้ค่าเริ่มต้น', async ({ page }) => {
    const H = { Authorization: `Bearer ${await token(page)}` };
    const ids: Record<string, string> = {};
    for (const [n, name] of [
      ['a', A],
      ['b', B],
    ] as const) {
      const r = await page.request.post('/v1/customers', {
        headers: H,
        data: { legalName: name, taxId: taxIdFor(`${RUN}${n === 'a' ? 1 : 2}`) },
      });
      expect(r.status(), await r.text()).toBe(201);
      ids[n] = ((await r.json()) as { id: string }).id;
    }

    await page.goto('/master/customers');
    await page.getByRole('row', { name: new RegExp(A) }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('tab', { name: 'เงื่อนไข' }).click();
    const pod = d.getByRole('radiogroup', { name: 'หลักฐานส่ง (POD)' });
    await expect(pod.getByRole('radio', { name: 'ใช้ค่าเริ่มต้นขององค์กร' })).toBeChecked();
    // ค่าองค์กรแสดงแบบอ่านอย่างเดียว (หมายเหตุบังคับจาก test ก่อนหน้า)
    await expect(d.getByRole('radio', { name: 'บังคับ — หมายเหตุ', exact: true })).toBeChecked();
    await expect(d.getByRole('radio', { name: 'บังคับ — หมายเหตุ', exact: true })).toBeDisabled();
    await pod.getByRole('radio', { name: 'กำหนดเองสำหรับลูกค้านี้' }).click();
    await d.getByRole('radio', { name: 'บังคับ — รูปหลักฐาน', exact: true }).check();
    await d.getByRole('radio', { name: 'บังคับ — ลายเซ็นผู้รับ', exact: true }).check();
    await d.getByRole('radio', { name: 'ไม่ใช้ — หมายเหตุ', exact: true }).check();
    await d.getByLabel('จำนวนรูปขั้นต่ำ').selectOption('2');
    await d.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`บันทึกข้อมูล ${A} แล้ว`);

    const ra = await page.request.get(`/v1/customers/${ids.a}/pod-checklist`, { headers: H });
    const a = ((await ra.json()) as { data: { source: string; fields: unknown[] }[] }).data[0]!;
    expect(a.source).toBe('CUSTOMER');
    expect(a.fields).toEqual([
      { key: 'photo', type: 'PHOTO', level: 'REQUIRED', minCount: 2 },
      { key: 'signature', type: 'SIGNATURE', level: 'REQUIRED' },
      { key: 'note', type: 'NOTE', level: 'DISABLED' },
    ]);
    const rb = await page.request.get(`/v1/customers/${ids.b}/pod-checklist`, { headers: H });
    expect(((await rb.json()) as { data: { source: string }[] }).data[0]!.source).toBe('TENANT');

    // กิจกรรมบันทึกการแก้ POD
    await d.getByRole('tab', { name: 'กิจกรรม' }).click();
    await expect(d.getByText('แก้ไขข้อมูล')).toBeVisible();

    // คืนค่าองค์กรให้ test อื่น
    const s = await page.request.get('/v1/settings', { headers: H });
    const row = ((await s.json()) as { data: { key: string; version: number }[] }).data.find(
      (x) => x.key === 'pod.checklist',
    )!;
    const back = await page.request.patch('/v1/settings', {
      headers: H,
      data: {
        values: {
          'pod.checklist': {
            success: {
              fields: [
                { type: 'PHOTO', level: 'REQUIRED', minCount: 1 },
                { type: 'SIGNATURE', level: 'REQUIRED' },
                { type: 'NOTE', level: 'ENABLED' },
              ],
            },
          },
        },
        versions: { 'pod.checklist': row.version },
      },
    });
    expect(back.status()).toBe(200);
  });
});
