import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST3-T02 ใบสั่งขนส่ง: สร้างจากฟอร์ม → คัดลอกเป็นใบใหม่ภายใน 3 คลิก (เกณฑ์ตรวจรับ: ข้อมูลครบเท่าต้นฉบับ)
 * → บันทึกเป็นเทมเพลต → สร้างใบจากเทมเพลต — ผ่าน /v1/orders + /v1/order-templates จริง (ฐาน tms_e2e)
 */
const RUN = String(Date.now()).slice(-6);
const CUST = `ลูกค้าใบสั่งอีทูอี ${RUN}`;
const A = `คลังต้นทาง ${RUN}`;
const B = `ปลายทางส่ง ${RUN}`;
const TPL = `งานประจำ ${RUN}`;

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

async function pick(scope: ReturnType<Page['getByRole']>, label: string, text: string, nth = 0) {
  const f = scope.getByRole('combobox', { name: new RegExp(`^${label}( \\*)?$`) }).nth(nth);
  await f.click();
  await f.fill(text);
  await scope
    .getByRole('option', { name: new RegExp(text) })
    .first()
    .click();
}

interface Snap {
  customer: unknown;
  vehicleTypeId: unknown;
  stops: {
    type: string;
    siteId: string;
    siteText: string;
    windowStart: string | null;
    windowEnd: string | null;
  }[];
  lines: { description: string; qty: string; unitId: string; weightKg: string | null }[];
}
/** ข้อมูลงานที่ต้องเท่ากันระหว่างต้นฉบับกับใบคัดลอก (เวลาเทียบแบบเวลาในวัน — ORD-022 เลื่อนวันที่) */
const essence = (o: Snap) => ({
  customer: o.customer,
  vehicleTypeId: o.vehicleTypeId,
  stops: o.stops.map((s) => ({
    type: s.type,
    siteId: s.siteId,
    siteText: s.siteText,
    from: s.windowStart?.slice(11, 16) ?? null,
    to: s.windowEnd?.slice(11, 16) ?? null,
  })),
  lines: o.lines.map((l) => ({ d: l.description, q: l.qty, u: l.unitId, w: l.weightKg })),
});

test.describe.serial('ปฏิบัติการ → ใบสั่งขนส่ง (SO)', () => {
  let H: Record<string, string>;

  test('สร้าง SO จากฟอร์ม: ลูกค้า + จุดรับ/ส่งจากสถานที่ + สินค้า + ประเภทรถ', async ({ page }) => {
    H = { Authorization: `Bearer ${await token(page)}` };
    const get = async (path: string) =>
      (await (await page.request.get(path, { headers: H })).json()) as {
        data: { id: string }[];
      };
    const company = (await get('/v1/companies?status=active&limit=1')).data[0]!.id;
    const post = async (path: string, data: object) => {
      const r = await page.request.post(path, { headers: H, data });
      expect(r.status(), await r.text()).toBe(201);
    };
    // demo-a มีหลายนิติบุคคล → กำหนด "ออกบิลในนาม" ให้ลูกค้า (routing ST1-T16)
    await post('/v1/customers', { legalName: CUST, billingCompanyId: company });
    await post('/v1/customer-sites', { name: A, kind: 'PICKUP', address: { line1: A } });
    await post('/v1/customer-sites', { name: B, kind: 'DROPOFF', address: { line1: B } });

    await page.goto('/so');
    await expect(page.getByRole('heading', { name: 'ใบสั่งขนส่ง (SO)', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'สร้าง SO' }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByRole('heading', { name: 'สร้างใบสั่งขนส่ง' })).toBeVisible();
    await d.getByRole('button', { name: 'สร้าง SO' }).click();
    await expect(d.getByText(/กรอกข้อมูลให้ครบ \d+ ช่อง/)).toBeVisible();

    await pick(d, 'ลูกค้า', CUST);
    await d.getByLabel('ประเภทรถที่ต้องการ').selectOption({ label: '6 ล้อ' });
    await pick(d, 'สถานที่', A, 0);
    await pick(d, 'สถานที่', B, 1);
    await d.getByLabel('เวลาตั้งแต่').nth(0).fill('07:00');
    await d.getByLabel('ถึง', { exact: true }).nth(0).fill('09:00');
    await d.getByLabel('เวลาตั้งแต่').nth(1).fill('13:00');
    await d.getByLabel('ถึง', { exact: true }).nth(1).fill('16:00');
    await d.getByLabel('รายละเอียดสินค้า').fill('น้ำดื่มขวด');
    await d.getByLabel(/^จำนวน( \*)?$/).fill('12.5');
    await pick(d, 'หน่วย', 'ตัน');
    await d.getByLabel('น้ำหนัก (กก.)').fill('12500');
    await d.getByLabel('เลข PO ลูกค้า').fill(`PO-${RUN}`);
    await d.getByRole('button', { name: 'สร้าง SO' }).click();
    await expect(page.getByRole('status')).toContainText(/สร้าง SO-\d{4}-\d{4} แล้ว/);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(`${CUST} · PO-${RUN}`)).toBeVisible();
    await expect(drawer.getByText(A)).toBeVisible();
    await expect(drawer.getByText('มือ').or(drawer.getByText('สร้างเอง')).first()).toBeVisible();
  });

  test('คัดลอกเป็นใบใหม่ภายใน 3 คลิก → ร่างใหม่ ข้อมูลเท่าต้นฉบับ (ไม่คัดลอก PO)', async ({
    page,
  }) => {
    const list = (await (
      await page.request.get(`/v1/orders?q=${encodeURIComponent(`PO-${RUN}`)}&limit=5`, {
        headers: H,
      })
    ).json()) as { data: (Snap & { id: string; soNo: string })[] };
    const src = list.data[0]!;

    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(src.soNo) }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(src.soNo, { exact: true })).toBeVisible();
    // คลิก 1: ⋯ · คลิก 2: คัดลอกเป็นใบใหม่ · คลิก 3: สร้างใบใหม่
    await drawer.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await page.getByRole('menuitem', { name: 'คัดลอกเป็นใบใหม่' }).click();
    const f = page.getByRole('dialog');
    await expect(f.getByText(`สร้างร่างใหม่จาก ${src.soNo}`)).toBeVisible();
    await expect(f.getByLabel('เลข PO ลูกค้า')).toHaveValue('');
    const created = page.waitForResponse(
      (r) => r.url().endsWith('/v1/orders') && r.request().method() === 'POST',
    );
    await f.getByRole('button', { name: 'สร้างใบใหม่' }).click();
    const copy = (await (await created).json()) as Snap & {
      id: string;
      status: string;
      externalId: string | null;
      customerRef: string | null;
      source: string;
    };
    await expect(page.getByRole('status')).toContainText('บันทึกร่างแล้ว');

    expect(copy.id).not.toBe(src.id);
    expect(copy.status).toBe('draft');
    expect(copy.externalId).toBeNull();
    expect(copy.customerRef).toBeNull();
    expect(copy.source).toBe('MANUAL');
    expect(essence(copy)).toEqual(essence(src));
  });

  test('บันทึกเป็นเทมเพลต → สร้างจากเทมเพลต ได้ใบใหม่ข้อมูลเดียวกัน · ลบเทมเพลตต้องมีเหตุผล', async ({
    page,
  }) => {
    const src = (
      (await (
        await page.request.get(`/v1/orders?q=${encodeURIComponent(`PO-${RUN}`)}&limit=5`, {
          headers: H,
        })
      ).json()) as { data: (Snap & { soNo: string })[] }
    ).data[0]!;
    await page.goto('/so');
    await page.getByRole('row', { name: new RegExp(src.soNo) }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'เพิ่มเติม' }).click();
    await page.getByRole('menuitem', { name: 'บันทึกเป็นเทมเพลต' }).click();
    const dlg = page.getByRole('dialog', { name: 'บันทึกเป็นเทมเพลต' });
    await dlg.getByLabel('ชื่อเทมเพลต').fill(TPL);
    await dlg.getByRole('button', { name: 'บันทึกเทมเพลต' }).click();
    await expect(page.getByRole('status')).toContainText(`บันทึกเทมเพลต "${TPL}" แล้ว`);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'สร้างจากเทมเพลต' }).click();
    const panel = page.getByRole('dialog');
    await panel.getByLabel('ค้นหาชื่อเทมเพลต').fill(TPL);
    const row = panel.getByTestId('tpl-row').filter({ hasText: TPL });
    await expect(row).toContainText(CUST);
    await row.getByRole('button', { name: 'ใช้เทมเพลต' }).click();
    const f = page.getByRole('dialog');
    await expect(f.getByText(`จากเทมเพลต "${TPL}"`)).toBeVisible();
    const created = page.waitForResponse(
      (r) => r.url().endsWith('/v1/orders') && r.request().method() === 'POST',
    );
    await f.getByRole('button', { name: 'สร้าง SO' }).click();
    const o = (await (await created).json()) as Snap & { customerRef: string | null };
    await expect(page.getByRole('status')).toContainText(/สร้าง SO-\d{4}-\d{4} แล้ว/);
    expect(essence(o)).toEqual(essence(src));
    expect(o.customerRef).toBeNull();

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'สร้างจากเทมเพลต' }).click();
    const p2 = page.getByRole('dialog');
    await p2.getByLabel('ค้นหาชื่อเทมเพลต').fill(TPL);
    await p2
      .getByTestId('tpl-row')
      .filter({ hasText: TPL })
      .getByRole('button', { name: 'ลบ' })
      .click();
    const rd = page.getByRole('dialog', { name: `ลบเทมเพลต "${TPL}"` });
    await expect(rd.getByRole('button', { name: 'ลบ' })).toBeDisabled();
    await rd.getByRole('textbox').fill('เลิกส่งงานประจำนี้แล้ว');
    await rd.getByRole('button', { name: 'ลบ' }).click();
    await expect(page.getByRole('status')).toContainText(`ลบเทมเพลต "${TPL}" แล้ว`);
  });
});
