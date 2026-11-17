import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST4-T06 POD checklist ชนิดเพิ่ม + ชุด "ไม่สำเร็จ" — ฐาน tms_e2e
 * - ตั้งค่า → หลักฐานส่ง (POD) แท็บ ส่งไม่สำเร็จ: PIN บังคับ 6 หลัก + คำถามเลือกตอบ + คะแนน → บันทึก → คงอยู่หลังโหลดใหม่
 *   (ชุดส่งสำเร็จไม่เปลี่ยน)
 * - ลูกค้ากำหนดชุด "ไม่สำเร็จ" เอง: รูปบังคับ ≥ 2 → checklist FAILURE ของลูกค้า = CUSTOMER, SUCCESS ยังใช้ค่าองค์กร
 *   (ตัวตรวจปฏิเสธการปิดงาน failed ที่ไม่มีรูป — integration test apps/api/test/pod-checklist.test.ts;
 *   การผูกกับการปิดงานจริง = ST4-T09 ลิงก์รถร่วม / แอปคนขับ)
 */
const RUN = String(Date.now()).slice(-6);
const C = `บจก. ลูกค้า POD ไม่สำเร็จ ${RUN}`;
function taxIdFor(seed: string): string {
  const base = `0778${seed}`.padEnd(12, '0').slice(0, 12);
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

type Eff = { outcome: string; source: string; fields: Record<string, unknown>[] };

test.describe.serial('POD checklist ชนิดเพิ่ม + ชุดไม่สำเร็จ (ST4-T06)', () => {
  test('ตั้งค่า แท็บ ส่งไม่สำเร็จ: PIN + คำถามเลือกตอบ + คะแนน → บันทึก → คงอยู่', async ({
    page,
  }) => {
    await page.goto('/settings?sec=pod');
    await expect(page.getByRole('heading', { name: 'หลักฐานส่ง (POD) ค่าเริ่มต้น' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'ส่งสำเร็จ' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('tab', { name: 'ส่งไม่สำเร็จ' }).click();
    await expect(page.getByText('ใช้เมื่อปิดงานแบบส่งไม่สำเร็จหรือของยังอยู่บนรถ')).toBeVisible();
    // ค่าระบบของชุดไม่สำเร็จ: รูป + หมายเหตุบังคับ ลายเซ็นไม่ใช้ (spec/04 §13)
    await expect(
      page.getByRole('radio', { name: 'ไม่ใช้ — ลายเซ็นผู้รับ', exact: true }),
    ).toBeChecked();
    await expect(page.getByRole('radio', { name: 'บังคับ — หมายเหตุ', exact: true })).toBeChecked();

    await page.getByRole('radio', { name: 'บังคับ — รหัส PIN จากผู้รับ', exact: true }).check();
    await page.getByLabel('จำนวนหลักของรหัส PIN').selectOption('6');
    await page
      .getByRole('radio', { name: 'ไม่บังคับ — คะแนนความพึงพอใจของผู้รับ', exact: true })
      .check();
    await page.getByLabel('คะแนนเต็ม').selectOption('10');
    await page.getByRole('button', { name: 'เพิ่มคำถามเลือกตอบ' }).click();
    await page.getByLabel('ข้อความคำถาม').fill('ผู้รับแจ้งว่า');
    await page.getByLabel('ตัวเลือกที่ 1', { exact: true }).fill('นัดส่งใหม่');
    await page.getByLabel('ตัวเลือกที่ 2', { exact: true }).fill('ปฏิเสธรับ');
    await page.getByRole('button', { name: 'ตัวเลือก', exact: true }).click();
    await page.getByLabel('ตัวเลือกที่ 3', { exact: true }).fill('ร้านปิด');

    const patched = page.waitForResponse(
      (r) => r.url().endsWith('/v1/settings') && r.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'บันทึก' }).click();
    expect((await patched).status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('บันทึกการตั้งค่าหลักฐานส่ง (POD)แล้ว');

    await page.reload();
    await page.getByRole('tab', { name: 'ส่งไม่สำเร็จ' }).click();
    await expect(
      page.getByRole('radio', { name: 'บังคับ — รหัส PIN จากผู้รับ', exact: true }),
    ).toBeChecked({ timeout: 20_000 });
    await expect(page.getByLabel('จำนวนหลักของรหัส PIN')).toHaveValue('6');
    await expect(page.getByLabel('คะแนนเต็ม')).toHaveValue('10');
    await expect(page.getByLabel('ข้อความคำถาม')).toHaveValue('ผู้รับแจ้งว่า');
    await expect(page.getByLabel('ตัวเลือกที่ 3', { exact: true })).toHaveValue('ร้านปิด');
    // ชุดส่งสำเร็จไม่เปลี่ยน
    await page.getByRole('tab', { name: 'ส่งสำเร็จ' }).click();
    await expect(
      page.getByRole('radio', { name: 'ไม่ใช้ — รหัส PIN จากผู้รับ', exact: true }),
    ).toBeChecked();
    await expect(page.getByLabel('ข้อความคำถาม')).toHaveCount(0);
  });

  test('ลูกค้ากำหนดชุด "ไม่สำเร็จ" เอง: รูปบังคับ ≥ 2; ชุดสำเร็จยังใช้ค่าองค์กร', async ({
    page,
  }) => {
    const H = { Authorization: `Bearer ${await token(page)}` };
    const r = await page.request.post('/v1/customers', {
      headers: H,
      data: { legalName: C, taxId: taxIdFor(`${RUN}3`) },
    });
    expect(r.status(), await r.text()).toBe(201);
    const id = ((await r.json()) as { id: string }).id;

    await page.goto('/master/customers');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').nth(1).fill(C);
    await expect(page.getByText('1–1 จาก 1')).toBeVisible();
    await page.locator('tbody tr', { hasText: C }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('tab', { name: 'เงื่อนไข' }).click();
    await d.getByRole('tab', { name: 'ส่งไม่สำเร็จ' }).click();
    const pod = d.getByRole('radiogroup', {
      name: 'ใช้เมื่อปิดงานแบบส่งไม่สำเร็จหรือของยังอยู่บนรถ',
    });
    await expect(pod.getByRole('radio', { name: 'ใช้ค่าเริ่มต้นขององค์กร' })).toBeChecked();
    // ค่าองค์กรของชุดไม่สำเร็จ (ตั้งใน test ก่อน) แสดงแบบอ่านอย่างเดียว
    await expect(
      d.getByRole('radio', { name: 'บังคับ — รหัส PIN จากผู้รับ', exact: true }),
    ).toBeDisabled();
    await expect(d.getByText('ตัวเลือก: นัดส่งใหม่ / ปฏิเสธรับ / ร้านปิด')).toBeVisible();
    await pod.getByRole('radio', { name: 'กำหนดเองสำหรับลูกค้านี้' }).click();
    await d.getByRole('radio', { name: 'บังคับ — รูปหลักฐาน', exact: true }).check();
    await d.getByLabel('จำนวนรูปขั้นต่ำ').selectOption('2');
    await d.getByRole('radio', { name: 'ไม่ใช้ — รหัส PIN จากผู้รับ', exact: true }).check();
    await d.getByRole('radio', { name: 'บังคับ — สแกนบาร์โค้ด / QR', exact: true }).check();
    await d.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('status')).toContainText(`บันทึกข้อมูล ${C} แล้ว`);

    const eff = await page.request.get(`/v1/customers/${id}/pod-checklist`, { headers: H });
    const data = ((await eff.json()) as { data: Eff[] }).data;
    const fail = data.find((x) => x.outcome === 'FAILURE')!;
    expect(fail.source).toBe('CUSTOMER');
    expect(fail.fields.find((f) => f.key === 'photo')).toEqual({
      key: 'photo',
      type: 'PHOTO',
      level: 'REQUIRED',
      minCount: 2,
    });
    expect(fail.fields.find((f) => f.key === 'barcode')).toMatchObject({ level: 'REQUIRED' });
    expect(fail.fields.find((f) => f.key === 'pin')).toMatchObject({ level: 'DISABLED' });
    expect(data.find((x) => x.outcome === 'SUCCESS')!.source).toBe('TENANT');

    // แท็บ ส่งสำเร็จ ของ drawer ยังเป็นค่าองค์กร
    await d.getByRole('tab', { name: 'ส่งสำเร็จ' }).click();
    await expect(
      d
        .getByRole('radiogroup', { name: 'ใช้เมื่อปิดงานแบบส่งสำเร็จหรือส่งบางส่วน' })
        .getByRole('radio', { name: 'ใช้ค่าเริ่มต้นขององค์กร' }),
    ).toBeChecked();

    // คืนค่าองค์กรให้ test อื่น (ชุดที่ไม่ส่ง = ค่าระบบ)
    const s = await page.request.get('/v1/settings', { headers: H });
    const row = ((await s.json()) as { data: { key: string; version: number }[] }).data.find(
      (x) => x.key === 'pod.checklist',
    )!;
    const back = await page.request.patch('/v1/settings', {
      headers: H,
      data: { values: { 'pod.checklist': {} }, versions: { 'pod.checklist': row.version } },
    });
    expect(back.status()).toBe(200);
  });
});
