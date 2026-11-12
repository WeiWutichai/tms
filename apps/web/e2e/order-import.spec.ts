import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';

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
test.afterAll(() => db.$disconnect());

/**
 * E2E ST3-T04: นำเข้าใบสั่งขนส่งจาก Excel — template → dry-run แถวผิดมีเหตุผลไทย → นำเข้าเฉพาะใบที่ผ่าน
 * หน้ารายการ SO (ST3-T02) ยังไม่อยู่บน main → เปิด wizard จาก /dev/import?kind=order (ปุ่มจริงย้ายไปหน้ารายการ SO ใน T02)
 * ข้อมูลสมมติเท่านั้น · รหัสต่อรอบ (RUN) กันชนกับรอบก่อนบนฐาน tms_e2e
 */
const RUN = String(Date.now()).slice(-6);

function taxIdFor(seed: string): string {
  const base = `0778${seed}`.padEnd(12, '0').slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

function csvFile(name: string, body: string): string {
  const p = join(tmpdir(), `${name}-${RUN}.csv`);
  writeFileSync(p, body);
  return p;
}

async function importVia(
  page: import('@playwright/test').Page,
  url: string,
  title: string,
  file: string,
  n: number,
) {
  await page.goto(url);
  await page.getByRole('button', { name: 'นำเข้า Excel' }).click();
  const dlg = page.getByRole('dialog', { name: title });
  await dlg.getByTestId('imp-file').setInputFiles(file);
  await dlg.getByRole('button', { name: 'ถัดไป' }).click();
  await dlg.getByRole('button', { name: `นำเข้า ${n} แถว` }).click();
  await expect(dlg.getByText('นำเข้าสำเร็จ')).toBeVisible();
  await dlg.getByRole('button', { name: 'เสร็จสิ้น' }).click();
}

test('นำเข้าใบสั่งขนส่ง: ใบหลายแถว + แถวผิด → ใบที่ผิดไม่ถูกนำเข้าทั้งใบ, ใบที่ผ่านนำเข้า', async ({
  page,
}) => {
  test.setTimeout(120_000); // นำเข้า 3 ไฟล์ (ลูกค้า สถานที่ ใบสั่ง) — ใบสั่งคิดราคา + DO ต่อใบ
  // ข้อมูลหลักที่ใบสั่งอ้างถึง (นำเข้าด้วย wizard เดียวกัน)
  await importVia(
    page,
    '/master/customers',
    'นำเข้าลูกค้าจาก Excel',
    csvFile(
      'ord-customers',
      [
        'รหัส,ชื่อ,เลขผู้เสียภาษี,สาขา,เครดิต',
        `OC${RUN},บจก. ใบสั่งอีทูอี ${RUN},${taxIdFor(RUN)},00000,30`,
      ].join('\n'),
    ),
    1,
  );
  // บริษัทเดโมมีหลายนิติบุคคลและยังไม่ตั้งค่านิติบุคคลออกบิลตั้งต้น → กำหนดที่ลูกค้า (ทางเดียวกับหน้าลูกค้า)
  const cus = await db.customer.findFirst({ where: { code: `OC${RUN}` } });
  const issuer = await db.branch.findFirst({
    where: { tenantId: cus.tenantId, isDefaultIssuer: true },
    orderBy: { createdAt: 'asc' },
  });
  await db.customer.update({
    where: { id: cus.id },
    data: { defaultBillingCompanyId: issuer.companyId },
  });
  await importVia(
    page,
    '/master/locations',
    'นำเข้าสถานที่จาก Excel',
    csvFile(
      'ord-sites',
      [
        'รหัส,ชื่อสถานที่,ประเภท,ลูกค้า,ที่อยู่,ตำบล/แขวง,อำเภอ/เขต,จังหวัด,รหัสไปรษณีย์',
        `OL${RUN}-1,คลังต้นทาง ${RUN},ต้นทาง,,7 ถ.ทดสอบ,,เมืองระยอง,ระยอง,21000`,
        `OL${RUN}-2,ปลายทางหนึ่ง ${RUN},ปลายทาง,OC${RUN},8 ถ.ทดสอบ,,เมืองชลบุรี,ชลบุรี,20000`,
        `OL${RUN}-3,ปลายทางสอง ${RUN},ปลายทาง,OC${RUN},9 ถ.ทดสอบ,,เมืองชลบุรี,ชลบุรี,20000`,
      ].join('\n'),
    ),
    3,
  );

  const orders = csvFile(
    'orders',
    [
      'เลขอ้างอิงใบสั่ง,ลูกค้า,วันรับสินค้า,ประเภทรถ,จุดรับ,เวลารับ ตั้งแต่,จุดส่ง,รายละเอียดสินค้า,จำนวน,หน่วย',
      `E${RUN}-1,OC${RUN},15/11/2569,6W,OL${RUN}-1,08:00,OL${RUN}-2,ปูนซีเมนต์,400,BAG`,
      `E${RUN}-1,,,,,,OL${RUN}-3,,,`,
      `E${RUN}-2,OC${RUN},15/11/2569,6W,OL${RUN}-1,08:00,ไม่มีจุดนี้,ทราย,5,TON`,
    ].join('\n'),
  );
  await page.goto('/dev/import?kind=order');
  await page.getByRole('button', { name: 'นำเข้าใบสั่งขนส่งจาก Excel' }).click();
  const dlg = page.getByRole('dialog', { name: 'นำเข้าใบสั่งขนส่งจาก Excel' });
  const tpl = page.waitForEvent('download');
  await dlg.getByText('ดาวน์โหลดไฟล์ตัวอย่าง').click();
  expect((await tpl).suggestedFilename()).toMatch(/\.xlsx$/);
  await dlg.getByTestId('imp-file').setInputFiles(orders);
  await expect(dlg.getByText(/^3 แถว/)).toBeVisible();
  await dlg.getByRole('button', { name: 'ถัดไป' }).click();
  await expect(dlg.getByRole('combobox', { name: 'เลขอ้างอิงใบสั่ง' })).toHaveValue(
    'เลขอ้างอิงใบสั่ง',
  );
  await expect(dlg.locator('tbody tr[data-error]')).toHaveCount(1);
  await dlg.getByRole('button', { name: 'นำเข้า 2 แถว' }).click();
  await expect(dlg.getByText('นำเข้าสำเร็จ')).toBeVisible();
  await expect(dlg.getByText('แถว 4', { exact: true })).toBeVisible();
  await expect(dlg.getByText(/จุดส่ง: ไม่พบสถานที่ "ไม่มีจุดนี้" ในข้อมูลหลัก/)).toBeVisible();
  await dlg.getByRole('button', { name: 'เสร็จสิ้น' }).click();
  await expect(page.getByRole('status')).toHaveText('นำเข้าใบสั่งขนส่ง สำเร็จ 1 ใบ (2 แถว)');

  // ใบที่นำเข้า: ที่มา EXCEL (IMPORT), 3 จุด (รับ 1 ส่ง 2) · ใบที่มีแถวผิดไม่ถูกนำเข้า
  const o = await db.salesOrder.findFirst({
    where: { externalId: `E${RUN}-1` },
    include: { stops: { orderBy: { sequence: 'asc' } } },
  });
  expect(o?.source).toBe('IMPORT');
  expect(o?.stops.map((s: { type: string }) => s.type)).toEqual(['PICKUP', 'DELIVERY', 'DELIVERY']);
  expect(await db.salesOrder.count({ where: { externalId: `E${RUN}-2` } })).toBe(0);
});
