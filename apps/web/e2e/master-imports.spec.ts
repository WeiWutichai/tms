import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
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

/**
 * E2E ST2-T23: ปุ่ม "นำเข้า Excel" ของหน้ารายการข้อมูลหลัก → wizard (ST1-T19) → ตรวจด้วยกฎเดียวกับ API → นำเข้า → แถวขึ้นในรายการ
 * ข้อมูลสมมติเท่านั้น · รหัสต่อรอบ (RUN) กันชนกับรอบก่อนบนฐาน tms_e2e
 */
const RUN = String(Date.now()).slice(-6);

function taxIdFor(seed: string): string {
  const base = `0777${seed}`.padEnd(12, '0').slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

function csvFile(name: string, body: string): string {
  const p = join(tmpdir(), `${name}-${RUN}.csv`);
  writeFileSync(p, body);
  return p;
}

test.describe.serial('นำเข้า Excel ข้อมูลหลัก', () => {
  test('ลูกค้า: แถวผิดมีเหตุผลไทย → นำเข้าเฉพาะแถวที่ผ่าน → toast + อยู่ในรายการ', async ({
    page,
  }) => {
    const file = csvFile(
      'customers',
      [
        'รหัส,ชื่อ,เลขผู้เสียภาษี,สาขา,เครดิต',
        `AIMP${RUN}-1,บจก. นำเข้าอีทูอี ${RUN},${taxIdFor(RUN)},00000,30`,
        `AIMP${RUN}-2,บจก. เลขผิด ${RUN},1234567890123,00000,30`,
        `AIMP${RUN}-3,บจก. นำเข้าสาม ${RUN},,,45`,
      ].join('\n'),
    );
    await page.goto('/master/customers');
    await page.getByRole('button', { name: 'นำเข้า Excel' }).click();
    const dlg = page.getByRole('dialog', { name: 'นำเข้าลูกค้าจาก Excel' });
    const tpl = page.waitForEvent('download');
    await dlg.getByText('ดาวน์โหลดไฟล์ตัวอย่าง').click();
    expect((await tpl).suggestedFilename()).toMatch(/\.xlsx$/);
    await dlg.getByTestId('imp-file').setInputFiles(file);
    await expect(dlg.getByText(/^3 แถว/)).toBeVisible();
    await dlg.getByRole('button', { name: 'ถัดไป' }).click();
    await expect(dlg.getByRole('combobox', { name: 'เลขผู้เสียภาษี' })).toHaveValue(
      'เลขผู้เสียภาษี',
    );
    await expect(dlg.locator('tbody tr[data-error]')).toHaveCount(1);
    await dlg.getByRole('button', { name: 'นำเข้า 2 แถว' }).click();
    await expect(dlg.getByText('นำเข้าสำเร็จ')).toBeVisible();
    await expect(
      dlg.getByText(/เลขผู้เสียภาษี: เลขผู้เสียภาษี\/เลขบัตรประชาชนไม่ถูกต้อง/),
    ).toBeVisible();
    await dlg.getByRole('button', { name: 'เสร็จสิ้น' }).click();
    await expect(page.getByRole('status')).toHaveText('นำเข้าลูกค้า สำเร็จ 2 แถว');
    // รหัส AIMP… เรียงก่อน CUS-… → อยู่หน้าแรกของรายการ (โหลดใหม่หลังนำเข้า)
    await expect(
      page.getByRole('row', { name: new RegExp(`บจก. นำเข้าอีทูอี ${RUN}`) }),
    ).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(`บจก. เลขผิด ${RUN}`) })).toHaveCount(0);
  });

  test('สถานที่ / คนขับ / ผู้รับเหมา / รถ / rate card: ปุ่มเปิด wizard ของชนิดที่ถูกต้อง', async ({
    page,
  }) => {
    for (const [url, title] of [
      ['/master/locations', 'นำเข้าสถานที่จาก Excel'],
      ['/fleet/drivers', 'นำเข้าคนขับจาก Excel'],
      ['/fleet/drivers?tab=con', 'นำเข้าผู้รับเหมาจาก Excel'],
      ['/fleet/vehicles', 'นำเข้ารถจาก Excel'],
      ['/master/rate-cards', 'นำเข้าRate card ขาขายจาก Excel'],
    ] as const) {
      await page.goto(url);
      await page.getByRole('button', { name: 'นำเข้า Excel' }).click();
      const dlg = page.getByRole('dialog', { name: title });
      await expect(dlg).toBeVisible();
      await dlg.getByRole('button', { name: 'ยกเลิก' }).click();
      await expect(dlg).toHaveCount(0);
    }
  });

  test('รถ: ไฟล์ตัวอย่างแบบต้นแบบ (ทะเบียน + จังหวัดช่องเดียว) นำเข้าได้', async ({ page }) => {
    const plate = `7${RUN.slice(-1)}-${RUN.slice(-4)}`;
    const file = csvFile(
      'vehicles',
      ['ทะเบียน,ประเภทรถ,เจ้าของ,น้ำหนักบรรทุก', `${plate} กทม.,6W,บริษัท,"6,000"`].join('\n'),
    );
    await page.goto('/fleet/vehicles');
    await page.getByRole('button', { name: 'นำเข้า Excel' }).click();
    const dlg = page.getByRole('dialog', { name: 'นำเข้ารถจาก Excel' });
    await dlg.getByTestId('imp-file').setInputFiles(file);
    await dlg.getByRole('button', { name: 'ถัดไป' }).click();
    await dlg.getByRole('button', { name: 'นำเข้า 1 แถว' }).click();
    await expect(dlg.getByText('นำเข้าสำเร็จ')).toBeVisible();
    await dlg.getByRole('button', { name: 'เสร็จสิ้น' }).click();
    await expect(page.getByRole('status')).toHaveText('นำเข้ารถ สำเร็จ 1 แถว');
  });

  // ไม่ให้รถในฐาน tms_e2e เพิ่มขึ้นทุกรอบ (โควตารถของ tenant เดโม) — ลบแบบ soft รถที่รอบนี้นำเข้า
  test.afterAll(async () => {
    await db.vehicle.updateMany({
      where: { plate: { startsWith: `7${RUN.slice(-1)}-${RUN.slice(-4)}` }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await db.$disconnect();
  });
});
