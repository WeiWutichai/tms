import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEMO_EMAIL, DEMO_IDS, expect, test } from './fixtures';

/**
 * E2E ST8-T12 หน้า MISMATCH (บัญชี → คิวเชื่อมระบบบัญชี — ต้นแบบ TMS v4 `erp`) ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 * ผลเทียบเอกสาร (ST8-T11) ตั้งตรงในฐาน — สร้าง MISMATCH จริงต้องมี ERP ปลายทาง (ทดสอบครบวงจรใน apps/api/test/reconcile-close.test.ts)
 * เกณฑ์: รายการไม่ตรงขึ้นตาราง + แถบสรุป · drawer เทียบ TMS กับระบบบัญชีระบุรายการที่หาย · "รับค่า" → ยอมรับความต่างพร้อมเหตุผล → ปิดแล้ว
 * · "ขออนุมัติแก้" ของ connector ที่ยกเลิกการเชื่อมแล้ว = ข้อความผิดพลาดไทย (ไม่ปิดรายการ)
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
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test.describe('หน้า MISMATCH (ST8-T12)', () => {
  test.afterAll(async () => db.$disconnect());

  test('รายการไม่ตรง → drawer เทียบข้อมูล → รับค่า (ยอมรับความต่าง) ปิดรายการ · ขออนุมัติแก้ของ connector ที่ยกเลิกแล้ว = แจ้งเหตุ', async ({
    page,
  }) => {
    const owner = await db.appUser.findUniqueOrThrow({ where: { id: DEMO_IDS[DEMO_EMAIL]! } });
    const tenantId = owner.tenantId as string;
    const branch = await db.branch.findFirstOrThrow({ where: { tenantId } });
    const customer = await db.customer.create({
      data: { tenantId, code: `C-MM-${RUN}`, legalName: `ลูกค้ากระทบยอด ${RUN}` },
    });
    // connector ที่ยกเลิกการเชื่อมแล้ว (ไม่ชนกับ connector ที่ spec อื่นเปิดไว้ — มีได้ 1 ตัวต่อขอบเขต)
    const con = await db.connector.create({
      data: {
        tenantId,
        adapterKey: 'krs',
        status: 'DISCONNECTED',
        disconnectedAt: new Date(),
        taxDocumentOwner: 'TMS',
      },
    });
    const mk = async (no: string) => {
      const inv = await db.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          issuingCompanyId: branch.companyId,
          issuingBranchId: branch.id,
          status: 'ISSUED',
          invoiceNo: no,
          issuedAt: new Date(),
          issuedBy: 'e2e',
          issueDate: new Date('2026-11-20T00:00:00.000Z'),
          dueDate: new Date('2026-12-20T00:00:00.000Z'),
          customerSnapshot: {
            name: customer.legalName,
            taxId: null,
            branchCode: null,
            address: '',
          },
          issuerSnapshot: { name: 'ผู้ออกทดสอบ', taxId: null, branchCode: '00000', address: '' },
          printOptions: { yearStyle: 'BE', whtMinimumAmount: 0, templateVersion: 1 },
        },
      });
      await db.reconcileResult.create({
        data: {
          tenantId,
          connectorId: con.id,
          entityType: 'INVOICE',
          localId: inv.id,
          localNumber: no,
          runAt: new Date(),
          source: 'NIGHTLY',
          localSnapshot: {},
          remoteSnapshot: {},
          diff: {
            check: 'DOCUMENT',
            code: 'content_mismatch',
            levels: ['LINE_COUNT'],
            header: [],
            lineCount: { local: 3, remote: 2 },
            missingLines: [{ lineNo: 3, deliveryOrderNumber: `DO-MM-${RUN}` }],
            extraLines: [],
            lineFields: [],
            total: [],
            totalSkipped: 'remote_has_no_amounts',
          },
          diffHash: sha(randomUUID()),
          result: 'MISMATCH',
          severity: 'MONEY',
          lastSeenAt: new Date(),
        },
      });
    };
    const a = `INV-E2E-MM-${RUN}-A`;
    const b = `INV-E2E-MM-${RUN}-B`;
    await mk(a);
    await mk(b);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/erp?tab=mm');
    await expect(page.getByRole('heading', { name: 'คิวเชื่อมระบบบัญชี' })).toBeVisible();
    const rowA = page.locator('tbody tr').filter({ hasText: a });
    await expect(rowA).toContainText('ไม่ตรง');
    await expect(rowA).toContainText('จำนวนรายการ');
    await rowA.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('เทียบข้อมูล TMS กับ')).toBeVisible();
    await expect(drawer.getByText(`รายการที่ 3 (DO-MM-${RUN})`)).toBeVisible();

    // รับค่า → ยอมรับความต่าง (ค่าเริ่ม) + เหตุผล → ปิดรายการ
    await drawer.getByRole('button', { name: /^รับค่า/ }).click();
    const dlg = page.getByRole('dialog').filter({ hasText: 'วิธีปิดรายการ' });
    await dlg.getByRole('textbox').fill('ยืนยันกับฝ่ายบัญชีแล้ว ยอมรับความต่าง');
    await dlg.getByRole('button', { name: 'ปิดรายการ' }).click();
    await expect(page.getByText(`ปิดรายการ ${a} แล้ว (ยอมรับความต่าง)`)).toBeVisible();
    await expect(drawer.getByText(/ปิดแล้ว · ยอมรับความต่าง/)).toBeVisible();
    await page.keyboard.press('Escape');

    // ขออนุมัติแก้ — connector ยกเลิกการเชื่อมแล้ว → ข้อความไทย ไม่ปิดรายการ
    await page.locator('tbody tr').filter({ hasText: b }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'ขออนุมัติแก้' }).click();
    const ask = page.getByRole('dialog').filter({ hasText: `ขออนุมัติแก้ ${b}` });
    await ask.getByRole('textbox').fill('ค่าใน TMS ถูกต้องตามใบส่งของ');
    await ask.getByRole('button', { name: 'ส่งขออนุมัติ' }).click();
    await expect(ask.getByText('ยกเลิกการเชื่อมระบบบัญชีแล้ว')).toBeVisible();

    // audit มีผู้ทำ + เหตุผลของการยอมรับ
    const audit = await db.auditLog.findFirst({
      where: { tenantId, action: 'reconcile.mismatch_acknowledged' },
      orderBy: { seq: 'desc' },
    });
    expect(audit?.reason).toBe('ยืนยันกับฝ่ายบัญชีแล้ว ยอมรับความต่าง');
    expect(audit?.actorId).toBe(owner.id);
  });
});
