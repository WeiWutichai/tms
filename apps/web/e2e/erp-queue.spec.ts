import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEMO_EMAIL, DEMO_IDS, expect, test } from './fixtures';

/**
 * E2E PO #86 + #94 (24 พ.ย. 2569) หน้า "คิวเชื่อมระบบบัญชี" ผ่าน /v1 จริง (ฐาน e2e) · ข้อมูลสมมติ
 * - แท็บตาม docs/04 G3 + docs/01 §6.4: รอคิว / ล้มเหลว (ค่าเริ่ม) / สำเร็จ + แท็บ MISMATCH ของต้นแบบ ไม่ตรง / รออนุมัติ
 * - แท็บล้มเหลว: คำสั่งส่งไม่สำเร็จขึ้นตาราง (เลข + ลูกค้าจาก payload) → drawer คู่มือ → "ข้ามพร้อมเหตุผล" → ย้ายไปแท็บสำเร็จ (ป้าย "ข้าม")
 *   · "กรอกเลขเอง" → external_mapping ได้เลขที่กรอก (รอตรวจเทียบ) · audit มีเหตุผล
 * - รออนุมัติ: ผู้อนุมัติ (ไม่ใช่ผู้ขอ) กด "ไม่อนุมัติ" + เหตุผล → คำขอถูกปฏิเสธ (กลับเป็นไม่ตรง)
 * คำสั่ง/ผลเทียบตั้งตรงในฐาน (ส่งจริงต้องมีระบบบัญชีปลายทาง — ทดสอบครบใน apps/api/test/connector-queue.test.ts)
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

test.describe('คิวเชื่อมระบบบัญชี — แท็บคิว (PO #86) + ไม่อนุมัติ (PO #94)', () => {
  test.afterAll(async () => db.$disconnect());

  test('ล้มเหลว → ข้ามพร้อมเหตุผล (ไปแท็บสำเร็จ) · กรอกเลขเอง · รออนุมัติ → ไม่อนุมัติ', async ({
    page,
  }) => {
    const owner = await db.appUser.findUniqueOrThrow({ where: { id: DEMO_IDS[DEMO_EMAIL]! } });
    const tenantId = owner.tenantId as string;
    // ใช้ connector ที่ spec อื่นเปิดไว้ถ้ามี (มีได้ 1 ตัวต่อขอบเขต) — ไม่มีก็สร้างแล้วยกเลิกตอนจบ
    const existing = await db.connector.findFirst({
      where: { tenantId, status: { not: 'DISCONNECTED' } },
    });
    const con =
      existing ??
      (await db.connector.create({
        data: { tenantId, adapterKey: 'demo', status: 'ACTIVE', taxDocumentOwner: 'TMS' },
      }));
    const before = { status: con.status };
    const cust = `ลูกค้าคิว ${RUN}`;
    const a = `INV-E2E-Q-${RUN}-A`;
    const b = `INV-E2E-Q-${RUN}-B`;
    const cmd = (no: string, errorClass: string, code: string) => {
      const localId = randomUUID();
      return db.integrationOutbox.create({
        data: {
          tenantId,
          kind: 'ADAPTER',
          sink: 'erp',
          targetId: con.id,
          operation: 'PUSH_INVOICE',
          entityType: 'invoice',
          localId,
          serializeKey: `erp:${con.id}:e2e-q:${localId}`,
          idempotencyKey: `e2e-q86-${localId}`,
          status: 'FAILED_FINAL',
          attempt: 1,
          errorClass,
          lastError: { code, message: `${code} (e2e)` },
          payload: { document: { kind: 'invoice', number: no, customer: { legalName: cust } } },
        },
      });
    };
    const ca = await cmd(a, 'PERIOD_CLOSED', 'period_closed');
    const cb = await cmd(b, 'VALIDATION', 'invalid_payload');
    // ผลเทียบที่มีคำขออนุมัติแก้ของผู้อื่น (ผู้อนุมัติ = owner ไม่ใช่ผู้ขอ)
    const branch = await db.branch.findFirstOrThrow({ where: { tenantId } });
    const customer = await db.customer.create({
      data: { tenantId, code: `C-Q-${RUN}`, legalName: cust },
    });
    const noR = `INV-E2E-Q-${RUN}-R`;
    const inv = await db.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        issuingCompanyId: branch.companyId,
        issuingBranchId: branch.id,
        status: 'ISSUED',
        invoiceNo: noR,
        issuedAt: new Date(),
        issuedBy: 'e2e',
        issueDate: new Date('2026-11-20T00:00:00.000Z'),
        dueDate: new Date('2026-12-20T00:00:00.000Z'),
        customerSnapshot: { name: cust, taxId: null, branchCode: null, address: '' },
        issuerSnapshot: { name: 'ผู้ออกทดสอบ', taxId: null, branchCode: '00000', address: '' },
        printOptions: { yearStyle: 'BE', whtMinimumAmount: 0, templateVersion: 1 },
      },
    });
    const rec = await db.reconcileResult.create({
      data: {
        tenantId,
        connectorId: con.id,
        entityType: 'INVOICE',
        localId: inv.id,
        localNumber: noR,
        runAt: new Date(),
        source: 'NIGHTLY',
        localSnapshot: {},
        remoteSnapshot: {},
        diff: {
          check: 'DOCUMENT',
          code: 'content_mismatch',
          levels: ['HEADER'],
          header: [{ field: 'dueDate', local: '2026-12-20', remote: '2026-12-31' }],
          lineCount: null,
          missingLines: [],
          extraLines: [],
          lineFields: [],
          total: [],
          totalSkipped: null,
        },
        diffHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        result: 'MISMATCH',
        severity: 'FIELD',
        lastSeenAt: new Date(),
        overwriteStatus: 'REQUESTED',
        overwriteRequestedBy: randomUUID(),
        overwriteRequestedAt: new Date(),
        overwriteReason: 'ค่าใน TMS ถูกต้องตามใบส่งของ',
      },
    });
    try {
      if (con.status !== 'ACTIVE')
        await db.connector.update({ where: { id: con.id }, data: { status: 'ACTIVE' } });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/erp');
      await expect(page.getByRole('heading', { name: 'คิวเชื่อมระบบบัญชี' })).toBeVisible();
      // แท็บตาม docs + แท็บ MISMATCH · ค่าเริ่ม = ล้มเหลว
      for (const name of ['รอคิว', 'ล้มเหลว', 'สำเร็จ', 'ไม่ตรง', 'รออนุมัติ'])
        await expect(page.getByRole('tab', { name: new RegExp(`^${name}`) })).toBeVisible();
      await expect(page.getByRole('tab', { name: /^ล้มเหลว/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      const rowA = page.locator('tbody tr').filter({ hasText: a });
      await expect(rowA).toContainText(cust);
      await expect(rowA).toContainText('ส่งไม่สำเร็จ');
      await expect(page.locator('tbody tr').filter({ hasText: b })).toContainText('ถูกปฏิเสธ');

      // ข้ามพร้อมเหตุผล → toast → แท็บสำเร็จ ป้าย "ข้าม"
      await rowA.click();
      const drawer = page.getByRole('dialog').filter({ hasText: a });
      await expect(drawer.getByText('วิธีแก้')).toBeVisible();
      await drawer.getByRole('button', { name: 'ข้ามพร้อมเหตุผล' }).click();
      const skip = page.getByRole('dialog').filter({ hasText: `ข้าม ${a}` });
      await skip.getByRole('textbox').fill('บัญชีบันทึกในระบบบัญชีเองแล้ว');
      await skip.getByRole('button', { name: 'ข้ามรายการ' }).click();
      await expect(page.getByText(`ข้าม ${a} แล้ว`)).toBeVisible();
      await expect(page.locator('tbody tr').filter({ hasText: a })).toHaveCount(0);
      await page.getByRole('tab', { name: /^สำเร็จ/ }).click();
      await expect(page.locator('tbody tr').filter({ hasText: a })).toContainText('ข้าม');
      await page.getByRole('tab', { name: /^ล้มเหลว/ }).click();

      // กรอกเลขเอง → external_mapping ได้เลขที่กรอก (MISMATCH รอตรวจเทียบ)
      await page.locator('tbody tr').filter({ hasText: b }).click();
      await page
        .getByRole('dialog')
        .filter({ hasText: b })
        .getByRole('button', { name: 'กรอกเลขเอง' })
        .click();
      const ext = page.getByRole('dialog').filter({ hasText: 'กรอกเลขเอกสารใน' });
      await ext.getByLabel(/^เลขเอกสารใน/).fill(`EXT-${RUN}`);
      await ext.getByRole('textbox').first().fill('เอกสารอยู่ในระบบบัญชีแล้ว ตรวจแล้ว');
      await ext.getByRole('button', { name: 'บันทึกเลข' }).click();
      await expect(page.getByText(`บันทึกเลข EXT-${RUN} ของ ${b} แล้ว`)).toBeVisible();
      const mapping = await db.externalMapping.findFirst({
        where: { tenantId, connectorId: con.id, localId: cb.localId },
      });
      expect(mapping?.externalId).toBe(`EXT-${RUN}`);
      const skipAudit = await db.auditLog.findFirst({
        where: { tenantId, action: 'connector.queue_skipped' },
        orderBy: { seq: 'desc' },
      });
      expect(skipAudit?.reason).toBe('บัญชีบันทึกในระบบบัญชีเองแล้ว');

      // #94 รออนุมัติ → ไม่อนุมัติ + เหตุผล
      await page.getByRole('tab', { name: /^รออนุมัติ/ }).click();
      await page.locator('tbody tr').filter({ hasText: noR }).click();
      await page
        .getByRole('dialog')
        .filter({ hasText: noR })
        .getByRole('button', { name: 'ไม่อนุมัติ' })
        .click();
      const rej = page.getByRole('dialog').filter({ hasText: `ไม่อนุมัติแก้ ${noR}` });
      await rej.getByRole('textbox').fill('วันครบกำหนดใน KRS ถูกต้องแล้ว');
      await rej.getByRole('button', { name: 'ไม่อนุมัติ' }).click();
      await expect(page.getByText(`ไม่อนุมัติคำขอแก้ ${noR} แล้ว`)).toBeVisible();
      const after = await db.reconcileResult.findUniqueOrThrow({ where: { id: rec.id } });
      expect(after.overwriteStatus).toBe('REJECTED');
      expect(after.overwriteDecidedBy).toBe(owner.id);
    } finally {
      await db.integrationOutbox.updateMany({
        where: { id: { in: [ca.id, cb.id] } },
        data: { status: 'SKIPPED' },
      });
      if (existing) await db.connector.update({ where: { id: con.id }, data: before });
      else
        await db.connector.update({
          where: { id: con.id },
          data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
        });
    }
  });
});
