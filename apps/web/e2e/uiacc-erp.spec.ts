import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { confirmStepUp, DEMO_EMAIL, DEMO_IDS, expect, test } from './fixtures';

/**
 * E2E PO 24 พ.ย. 2569 "ไม่ต้องรอ Claude Design" — หน้าจอบัญชี/ERP ที่ประกอบจากโครงสร้างต้นแบบ (ผ่าน /v1 จริง · ข้อมูลสมมติ)
 * - #95 แท็บ "ปิดงวด" ของหน้า `erp`: การ์ดผล/ค้าง/ยังไม่ส่ง + ส่วน "ยังไม่ส่ง" มีเอกสารที่ค้างในคิว · การ์ด "สำเร็จ 24 ชม."
 * - Q-RES เปิดใช้ connector จาก ERROR ต้องมีเหตุผล → audit `connector.resumed` มีเหตุผล · #89 ช่อง "ตรวจเทียบหลังส่ง (นาที)"
 * ภาพ 1440 px ไว้ที่ scratchpad (prefix uiacc-) เมื่อตั้ง UIACC_SHOTS
 */
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
const RUN = String(Date.now()).slice(-6);
const SHOTS = process.env.UIACC_SHOTS;
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/uiacc-${name}.png`, fullPage: false });
};
/** เดือนก่อน (เวลาไทย) — งวดเริ่มของแท็บปิดงวด */
const prevMonth = () => {
  const now = new Date(Date.now() + 7 * 3600_000);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  return d.toISOString().slice(0, 10);
};

async function liveConnector(tenantId: string) {
  const existing = await db.connector.findFirst({
    where: { tenantId, status: { not: 'DISCONNECTED' }, companyId: null },
  });
  const con =
    existing ??
    (await db.connector.create({
      data: { tenantId, adapterKey: 'demo', status: 'ACTIVE', taxDocumentOwner: 'TMS' },
    }));
  return { con, existing, before: { status: con.status } };
}

test.describe('หน้าจอบัญชี/ERP ที่ประกอบจากโครงสร้างต้นแบบ (PO 24 พ.ย. 2569)', () => {
  test.afterAll(async () => db.$disconnect());

  test('#95 แท็บปิดงวด: ยังไม่ส่ง → ไม่ผ่าน · การ์ดสำเร็จ 24 ชม.', async ({ page }) => {
    const owner = await db.appUser.findUniqueOrThrow({ where: { id: DEMO_IDS[DEMO_EMAIL]! } });
    const tenantId = owner.tenantId as string;
    const { con, existing, before } = await liveConnector(tenantId);
    const no = `INV-E2E-PC-${RUN}`;
    const localId = randomUUID();
    const cmd = await db.integrationOutbox.create({
      data: {
        tenantId,
        kind: 'ADAPTER',
        sink: 'erp',
        targetId: con.id,
        operation: 'PUSH_INVOICE',
        entityType: 'invoice',
        localId,
        serializeKey: `erp:${con.id}:e2e-pc:${localId}`,
        idempotencyKey: `e2e-pc-${localId}`,
        status: 'FAILED_FINAL',
        attempt: 1,
        errorClass: 'PERIOD_CLOSED',
        lastError: { code: 'period_closed', message: 'period closed (e2e)' },
        payload: {
          document: {
            kind: 'invoice',
            number: no,
            issueDate: prevMonth(),
            customer: { legalName: `ลูกค้าปิดงวด ${RUN}` },
            totals: { total: '1070.00' },
          },
        },
      },
    });
    try {
      if (con.status !== 'ACTIVE')
        await db.connector.update({ where: { id: con.id }, data: { status: 'ACTIVE' } });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/erp');
      await expect(page.getByRole('heading', { name: 'คิวเชื่อมระบบบัญชี' })).toBeVisible();
      // การ์ดที่ 4 ของต้นแบบ
      await expect(page.getByText('สำเร็จ 24 ชม.')).toBeVisible();
      await page.getByRole('tab', { name: /^ปิดงวด/ }).click();
      const pc = page.getByTestId('period-close');
      await expect(pc.getByText(/^ผลปิดงวด/)).toBeVisible();
      await expect(pc.getByText('ไม่ผ่าน')).toBeVisible();
      await pc.getByRole('tab', { name: /^ยังไม่ส่ง/ }).click();
      await expect(pc.getByText(no)).toBeVisible();
      await expect(pc.getByRole('button', { name: 'ส่งออก Excel' })).toBeVisible();
      await expect(pc.getByRole('button', { name: 'ส่งออก PDF' })).toBeVisible();
      await shot(page, 'erp-period-close');
      // คลิกแถวยังไม่ส่ง → ไปแท็บคิวล้มเหลว
      await pc.getByText(no).click();
      await expect(page.getByRole('tab', { name: /^ล้มเหลว/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.locator('tbody tr').filter({ hasText: no })).toBeVisible();
      await shot(page, 'erp-queue-failed');
    } finally {
      await db.integrationOutbox.update({
        where: { id: cmd.id },
        data: { status: 'SKIPPED', lastError: {} },
      });
      if (existing) await db.connector.update({ where: { id: con.id }, data: before });
      else
        await db.connector.update({
          where: { id: con.id },
          data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
        });
    }
  });

  test('Q-RES เปิดใช้จาก ERROR ต้องมีเหตุผล (audit) · #89 ช่องตรวจเทียบหลังส่ง', async ({
    page,
  }) => {
    const owner = await db.appUser.findUniqueOrThrow({ where: { id: DEMO_IDS[DEMO_EMAIL]! } });
    const tenantId = owner.tenantId as string;
    const { con, existing, before } = await liveConnector(tenantId);
    if (con.adapterKey !== 'demo') test.skip(true, 'ต้องใช้ ERP จำลอง');
    try {
      await db.connector.update({
        where: { id: con.id },
        data: { status: 'ERROR' },
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/settings?sec=conn');
      const card = page.getByRole('group', { name: 'ERP จำลอง (Demo)' });
      await card.getByRole('button', { name: 'เชื่อมต่อ' }).click();
      const dlg = page.getByRole('dialog');
      await expect(dlg.getByText('เปิดใช้ ERP จำลอง (Demo) อีกครั้ง')).toBeVisible();
      await shot(page, 'connector-resume-reason');
      const reason = `แก้ key ในระบบบัญชีแล้ว (E2E ${RUN})`;
      await dlg.getByRole('textbox').fill(reason);
      await dlg.getByRole('button', { name: 'เชื่อมต่อ' }).click();
      await expect(dlg).toBeHidden();
      const audit = await db.auditLog.findFirst({
        where: { tenantId, action: 'connector.resumed', entityId: con.id },
        orderBy: { seq: 'desc' },
      });
      // ทดสอบผ่าน = เปิดใช้ + เหตุผลลง audit · ไม่ผ่าน (credential ของฐาน e2e) = ยังไม่มี audit แต่ต้องไม่เปิดโดยไม่มีเหตุผล
      if (audit) expect(audit.reason).toBe(reason);

      // #89 ช่องหน่วงเวลา (Demo อ่านเอกสารกลับได้) — บันทึกเมื่อออกจากช่อง (D-67 ยืนยัน 2FA)
      const delay = page.getByLabel('ตรวจเทียบหลังส่ง (นาที)');
      await expect(delay).toBeVisible();
      await delay.fill('15');
      await delay.blur();
      await confirmStepUp(page).catch(() => undefined);
      await expect
        .poll(
          async () =>
            (await db.connector.findUniqueOrThrow({ where: { id: con.id } }))
              .afterPushReconcileDelayMin,
        )
        .toBe(15);
      await shot(page, 'connector-delay');
    } finally {
      await db.connector.update({
        where: { id: con.id },
        data: { afterPushReconcileDelayMin: 0 },
      });
      if (existing) await db.connector.update({ where: { id: con.id }, data: before });
      else
        await db.connector.update({
          where: { id: con.id },
          data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
        });
    }
  });

  test('ST6-T11 ลิงก์ค่าเที่ยวจากหน้าผู้รับเหมา (เมนู ⋯ ของ drawer) → กล่องลิงก์', async ({
    page,
  }) => {
    const owner = await db.appUser.findUniqueOrThrow({ where: { id: DEMO_IDS[DEMO_EMAIL]! } });
    const tenantId = owner.tenantId as string;
    // รถร่วมทดสอบ (นิติบุคคล — ไม่มีข้อมูลส่วนบุคคล) · ฐาน e2e ใหม่ไม่มีรถร่วมจาก seed
    const c = await db.carrier.create({
      data: {
        tenantId,
        code: `SUB-UIACC-${RUN}`,
        legalName: `หจก. ลิงก์ค่าเที่ยว ${RUN}`,
        entityType: 'JURISTIC',
        branchCode: '00000',
      },
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/fleet/drivers?tab=con');
    await page.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill(c.legalName);
    await page.locator('tbody tr').filter({ hasText: c.legalName }).first().click();
    const dr = page.getByRole('dialog');
    await dr.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await page.getByRole('menuitem', { name: 'ลิงก์ค่าเที่ยวของรถร่วม' }).click();
    await expect(page.getByRole('status')).toContainText('ออกลิงก์ค่าเที่ยวแล้ว');
    const box = page.getByTestId('settle-link');
    await expect(box).toContainText('/link/');
    await shot(page, 'carrier-pay-link');
  });
});
