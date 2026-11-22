import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { store } from '../src/modules/documents/documents.controller';
import {
  FINANCE_DOCUMENT_RETENTION,
  FINANCE_PDF_ENTITY_TYPES,
} from '../src/modules/retention/retention-policy';
import { RetentionService } from '../src/modules/retention/retention.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { PdfRenderer } from '../src/pdf/pdf-renderer';
import {
  api,
  bootApp,
  issuedTestFields,
  platform,
  tokenFor,
  truncateAll,
  validTaxId,
} from './helpers';

/** "แก้แม่แบบ" = เพิ่มรุ่นแม่แบบ (ค่าที่บวกเพิ่มจากรุ่นจริง) — โค้ดอ่านค่าผ่าน getter ทุกครั้ง */
const bump = vi.hoisted(() => ({ invoice: 0, billingNote: 0 }));
vi.mock('../src/modules/invoices/invoice.template', async (orig) => {
  const real = await orig<typeof import('../src/modules/invoices/invoice.template')>();
  return {
    ...real,
    get INVOICE_TEMPLATE_VERSION() {
      return real.INVOICE_TEMPLATE_VERSION + bump.invoice;
    },
  };
});
vi.mock('../src/modules/billing-notes/billing-note.template', async (orig) => {
  const real = await orig<typeof import('../src/modules/billing-notes/billing-note.template')>();
  return {
    ...real,
    get BILLING_NOTE_TEMPLATE_VERSION() {
      return real.BILLING_NOTE_TEMPLATE_VERSION + bump.billingNote;
    },
  };
});

/**
 * ST9-T15 (D-54; docs/04 J "เอกสารภาษี ≥ 5 ปี") — เอกสารที่ออกเลขแล้วของ TMS (ใบแจ้งหนี้ ใบวางบิล ใบสำคัญจ่าย รับชำระ)
 * เกณฑ์ตรวจรับ: คำสั่ง DELETE บนตารางเอกสารถูก DB ปฏิเสธ · hash ของ PDF ไม่เปลี่ยนหลังแก้ template
 * + retention default 7 ปี (ต่ำกว่า 5 ปีไม่ได้) · retention job ไม่แตะเอกสาร/PDF ที่ออกแล้ว
 * (PDF ใบสำคัญจ่าย: `settlements.test.ts` "ST9-T15" — ใช้ fixture เที่ยว/รถร่วมของไฟล์นั้น)
 */
describe('document retention (ST9-T15)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  let tenantId: string;
  let companyId: string;
  let branchId: string;
  let customerId: string;
  let admin: string;
  let invoiceId: string; // ใบแจ้งหนี้ที่ออกแล้ว + 1 บรรทัด
  let invoice2Id: string; // ออกแล้ว — ยังไม่เคยขอ PDF สำเนา
  let noteId: string; // ใบวางบิลที่ออกแล้ว (encoded)
  let settlementId: string;
  let seq = 0;
  const today = bangkokToday();
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  /** role แอป (tms_app + RLS ของ tenant) */
  const asApp = (sql: string) =>
    app.get(DbService).withTenant(tenantId, (tx) => tx.$executeRawUnsafe(sql));
  const ROLES: [string, (sql: string) => Promise<unknown>][] = [
    ['tms_app', asApp],
    ['tms_platform', (sql) => db.$executeRawUnsafe(sql)],
    ['owner', (sql) => owner.$executeRawUnsafe(sql)],
  ];
  const count = async (table: string) =>
    Number(
      (
        await owner.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "${table}" WHERE tenant_id = '${tenantId}'`,
        )
      )[0]!.n,
    );

  async function issuedInvoice(total: string) {
    const n = ++seq;
    const si = await db.serviceItem.findFirstOrThrow({
      where: { tenantId, vatType: 'EXEMPT_TRANSPORT', status: 'ACTIVE', deletedAt: null },
    });
    const inv = await db.invoice.create({
      data: { tenantId, customerId, issuingCompanyId: companyId, issuingBranchId: branchId },
    });
    await db.invoiceLine.create({
      data: {
        tenantId,
        invoiceId: inv.id,
        lineNo: 1,
        serviceItemId: si.id,
        description: 'ค่าขนส่ง',
        quantity: 1,
        unitLabel: 'เที่ยว',
        unitPrice: total,
        amount: total,
        vatType: 'EXEMPT_TRANSPORT',
        whtRate: 1,
        isUserAdded: true,
        doAnchor: false,
      } as never,
    });
    await db.invoice.update({
      where: { id: inv.id },
      data: {
        status: 'ISSUED',
        totalAmount: new Prisma.Decimal(total),
        subtotalExempt: new Prisma.Decimal(total),
        netExpectedAmount: new Prisma.Decimal(total),
        ...issuedTestFields(`INV-T15-${String(n).padStart(4, '0')}`),
      },
    });
    return inv.id;
  }

  beforeAll(async () => {
    process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-docret-'));
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท เก็บเอกสาร' })).id;
    companyId = (
      await db.company.create({
        data: { tenantId, legalName: 'บริษัท ผู้ออกเอกสาร จำกัด', taxId: validTaxId(1501) },
      })
    ).id;
    branchId = (
      await db.branch.create({
        data: {
          tenantId,
          companyId,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          address: ADDR,
          isDefaultIssuer: true,
        },
      })
    ).id;
    customerId = (
      await db.customer.create({
        data: {
          tenantId,
          code: 'C-T15',
          legalName: 'บริษัท ลูกค้าเก็บเอกสาร จำกัด',
          taxId: validTaxId(1502),
          branchCode: '00000',
          billingAddress: ADDR,
        },
      })
    ).id;
    admin = await tokenFor(tenantId);

    invoiceId = await issuedInvoice('7000.00');
    invoice2Id = await issuedInvoice('1200.00');
    // ใบวางบิล: สร้าง + ออกเลขผ่าน API (ได้ document_sequence + PDF ที่เก็บ)
    const bn = await api(app, admin)
      .post('/v1/billing-notes')
      .send({
        customerId: encodeId('customer', customerId),
        invoiceIds: [encodeId('invoice', invoiceId)],
        collectionDate: new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000)
          .toISOString()
          .slice(0, 10),
      })
      .expect(201);
    const iss = await api(app, admin)
      .post(`/v1/billing-notes/${bn.body.id}/finalize`)
      .set('If-Match', `"${bn.body.version}"`);
    expect(iss.status, JSON.stringify(iss.body)).toBe(200);
    expect(iss.body.pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    noteId = bn.body.id;
    // รับชำระบางส่วน (payment + payment_allocation)
    await api(app, admin)
      .post('/v1/payments')
      .send({
        receivedDate: today,
        method: 'TRANSFER',
        amountReceived: '1000.00',
        whtAmount: '0.00',
        allocations: [{ invoiceId: encodeId('invoice', invoiceId), amount: '1000.00' }],
      })
      .expect(201);
    // ใบสำคัญจ่าย (ร่าง) + บรรทัดหัก — ตารางเดียวกับใบที่อนุมัติแล้ว (ตัวกัน DELETE ไม่แยกสถานะ)
    const carrier = await db.carrier.create({
      data: {
        tenantId,
        code: 'SUB-T15',
        legalName: 'หจก. รถร่วมเก็บเอกสาร',
        entityType: 'JURISTIC',
        taxId: validTaxId(1503),
      } as never,
    });
    settlementId = randomUUID();
    await db.$transaction(async (tx) => {
      await tx.carrierSettlement.create({
        data: {
          id: settlementId,
          tenantId,
          carrierId: carrier.id,
          carrierSnapshot: {},
          periodFrom: new Date('2026-11-01T00:00:00Z'),
          periodTo: new Date('2026-11-30T00:00:00Z'),
          grossAmount: 0,
          deductionAmount: 500,
          netPayable: -500,
          createdBy: 'u-prep',
        },
      });
      await tx.settlementLine.create({
        data: {
          tenantId,
          settlementId,
          lineNo: 1,
          lineType: 'DEDUCTION',
          deductionType: 'CASH_ADVANCE',
          description: 'เงินเบิกล่วงหน้า',
          amount: -500,
          reference: 'ADV-T15-1',
          createdBy: 'u-prep',
        } as never,
      });
    });
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await owner.$disconnect();
  });

  // ---------- ไม่มี hard delete ----------
  const NO_DELETE_TABLES = [
    'invoice',
    'invoice_line',
    'billing_note',
    'billing_note_invoice',
    'carrier_settlement',
    'settlement_line',
    'payment',
    'payment_allocation',
    'stored_document',
    'document_sequence',
    'audit_log',
  ];

  it('เกณฑ์ตรวจรับ: DELETE บนตารางเอกสารถูกฐานข้อมูลปฏิเสธ — role แอป, role platform และเจ้าของตาราง', async () => {
    for (const table of NO_DELETE_TABLES) {
      const before = await count(table);
      expect(before, `${table} ต้องมีแถวให้ลอง`).toBeGreaterThan(0);
      for (const [role, exec] of ROLES) {
        await expect(
          exec(`DELETE FROM "${table}" WHERE tenant_id = '${tenantId}'`),
          `${role} DELETE ${table}`,
        ).rejects.toThrow(
          /permission denied|_no_delete|cannot be deleted|cannot change or delete|append-only/,
        );
      }
      // เจ้าของตาราง: ถูกปฏิเสธโดย trigger (ไม่ได้อาศัยสิทธิ์ของ role)
      await expect(
        owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id = '${tenantId}'`),
      ).rejects.not.toThrow(/permission denied/);
      expect(await count(table), table).toBe(before);
    }
  });

  it('สิทธิ์ DELETE ถูกถอนจาก role แอป/platform บนตารางเอกสาร + มี trigger กัน DELETE ทุกตาราง (catalog)', async () => {
    const rows = await owner.$queryRaw<{ t: string; app: boolean; plat: boolean; trg: boolean }[]>`
      SELECT c.relname AS t,
             has_table_privilege('tms_app', c.oid, 'DELETE') AS app,
             has_table_privilege('tms_platform', c.oid, 'DELETE') AS plat,
             EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = c.oid AND NOT g.tgisinternal AND g.tgenabled = 'O'
                        AND (g.tgtype & 2) = 2 AND (g.tgtype & 8) = 8) AS trg
        FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${NO_DELETE_TABLES})`;
    expect(rows.map((r) => r.t).sort()).toEqual([...NO_DELETE_TABLES].sort());
    // trigger BEFORE (bit 2) + DELETE (bit 8) ที่เปิดอยู่ — ทุกตาราง
    expect(rows.filter((r) => !r.trg).map((r) => r.t)).toEqual([]);
    // payment / payment_allocation: สิทธิ์ยังอยู่ (trigger 0143 กันทุก role) — ตารางอื่นไม่มีสิทธิ์ DELETE
    const granted = rows.filter((r) => r.app || r.plat).map((r) => r.t);
    expect(granted.sort()).toEqual(['payment', 'payment_allocation']);
    // role แอป/platform TRUNCATE ไม่ได้
    for (const exec of [asApp, (sql: string) => db.$executeRawUnsafe(sql)])
      await expect(exec('TRUNCATE invoice CASCADE')).rejects.toThrow(/permission denied/);
  });

  it('เอกสารที่ออกแล้วแก้เนื้อหาไม่ได้ (เจ้าของตารางก็ไม่ได้): ใบแจ้งหนี้ + บรรทัด · ใบวางบิล + แถวผูก · รับชำระ · ตัวนับเลขไม่ถอยหลัง', async () => {
    const o = (sql: string) => owner.$executeRawUnsafe(sql);
    const bn = tryDecodeId('billingNote', noteId)!;
    await expect(
      o(`UPDATE invoice SET total_amount = 1, net_expected_amount = 1 WHERE id = '${invoiceId}'`),
    ).rejects.toThrow(/invoice_issued_immutable|content cannot change/);
    await expect(
      o(`UPDATE invoice SET invoice_no = 'INV-X' WHERE id = '${invoiceId}'`),
    ).rejects.toThrow(/invoice_number_once|assigned only/);
    await expect(
      o(`UPDATE invoice_line SET amount = 1, unit_price = 1 WHERE invoice_id = '${invoiceId}'`),
    ).rejects.toThrow(/content can only change/);
    await expect(o(`UPDATE billing_note SET total_amount = 1 WHERE id = '${bn}'`)).rejects.toThrow(
      /billing_note/,
    );
    await expect(
      o(`UPDATE billing_note_invoice SET amount = 1 WHERE billing_note_id = '${bn}'`),
    ).rejects.toThrow(/billing_note/);
    await expect(
      o(`UPDATE payment SET amount_received = 1 WHERE tenant_id = '${tenantId}'`),
    ).rejects.toThrow(/payment_immutable|content cannot change/);
    await expect(
      o(`UPDATE payment_allocation SET amount = 1 WHERE tenant_id = '${tenantId}'`),
    ).rejects.toThrow(/payment_allocation_immutable|cannot change/);
    // ตัวนับเลข: ถอยหลัง = ออกเลขซ้ำ · ย้ายตัวนับไปงวด/ประเภทอื่นไม่ได้ · เดินหน้าได้
    await expect(
      o(`UPDATE document_sequence SET next_value = next_value - 1 WHERE tenant_id = '${tenantId}'`),
    ).rejects.toThrow(/document_sequence_monotonic|cannot go backwards/);
    await expect(
      o(`UPDATE document_sequence SET period_key = 'X' WHERE tenant_id = '${tenantId}'`),
    ).rejects.toThrow(/document_sequence_immutable_key|cannot change/);
    const before = await db.documentSequence.findFirstOrThrow({ where: { tenantId } });
    await db.documentSequence.update({
      where: { id: before.id },
      data: { nextValue: before.nextValue + 1n },
    });
  });

  // ---------- PDF ที่เก็บ ----------
  const pdf = (path: string) =>
    api(app, admin)
      .get(path)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const financePdfs = () =>
    db.storedDocument.findMany({
      where: { tenantId, kind: 'PDF', entityType: { in: [...FINANCE_PDF_ENTITY_TYPES] } },
      orderBy: { createdAt: 'asc' },
    });

  it('เกณฑ์ตรวจรับ: hash ของ PDF ไม่เปลี่ยนหลังแก้ template — ใบแจ้งหนี้ ต้นฉบับ + สำเนา · ใบวางบิล ต้นฉบับ + สำเนา (ไม่ render ใหม่)', async () => {
    const inv = encodeId('invoice', invoiceId);
    const paths = [
      `/v1/invoices/${inv}/pdf`,
      `/v1/invoices/${inv}/pdf?copy=COPY`,
      `/v1/billing-notes/${noteId}/pdf`,
      `/v1/billing-notes/${noteId}/pdf?copy=COPY`,
    ];
    // ก่อนแก้แม่แบบ: ขอครั้งแรก = เก็บไฟล์ (ต้นฉบับใบวางบิลเก็บตั้งแต่ออกเลข)
    const before: string[] = [];
    for (const p of paths) {
      const r = await pdf(p).expect(200);
      expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(r.headers['x-content-sha256']).toBe(sha(r.body as Buffer));
      before.push(sha(r.body as Buffer));
    }
    expect(new Set(before).size).toBe(4);
    const stored = await financePdfs();
    expect(stored.map((d) => d.sha256).sort()).toEqual([...before].sort());
    const rowsBefore = JSON.stringify(stored);

    // แก้แม่แบบ: รุ่นแม่แบบเพิ่ม + ผลลัพธ์ของตัว render เปลี่ยน (ถ้ามีใคร render ใหม่ hash จะเปลี่ยน)
    bump.invoice = 1;
    bump.billingNote = 1;
    const spy = vi
      .spyOn(app.get(PdfRenderer), 'pdf')
      .mockResolvedValue(Buffer.from('%PDF-1.7 new template output'));
    try {
      for (let round = 0; round < 2; round++)
        for (const [i, p] of paths.entries()) {
          const r = await pdf(p).expect(200);
          expect(sha(r.body as Buffer), p).toBe(before[i]);
          expect(r.headers['x-content-sha256'], p).toBe(before[i]);
        }
      expect(spy).not.toHaveBeenCalled();
      // ไฟล์ในที่เก็บ = เนื้อเดิม (hash ของไฟล์จริงตรงกับที่บันทึก) · แถวไฟล์ไม่เปลี่ยน ไม่เพิ่ม
      for (const d of stored) {
        const file = join(process.env.FILES_ROOT!, d.fileKey!);
        expect(sha(readFileSync(file))).toBe(d.sha256);
        expect(d.fileKey).toBe(`${tenantId}/${d.sha256}.pdf`);
      }
      expect(JSON.stringify(await financePdfs())).toBe(rowsBefore);
      // ใบที่ออกก่อนแก้แม่แบบแต่ยังไม่เคยมีไฟล์สำเนา → ไม่ render ด้วยแม่แบบใหม่เงียบ ๆ (409) — ไม่มีไฟล์ใหม่
      const late = await pdf(`/v1/invoices/${encodeId('invoice', invoice2Id)}/pdf?copy=COPY`);
      expect(late.status).toBe(409);
      expect(JSON.parse((late.body as Buffer).toString()).code).toBe(
        'invoice_pdf_template_changed',
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      bump.invoice = 0;
      bump.billingNote = 0;
    }
  });

  it('แถวไฟล์ PDF ของเอกสารการเงิน: แก้ hash / ชี้ไฟล์อื่น / เปลี่ยนเป็น PURGED / ย้ายไปผูกเอกสารอื่น ไม่ได้ (ทุก role)', async () => {
    const [d] = await financePdfs();
    const fake = 'f'.repeat(64);
    const attempts = [
      `UPDATE stored_document SET sha256 = '${fake}' WHERE id = '${d!.id}'`,
      `UPDATE stored_document SET file_key = '${tenantId}/${fake}.pdf' WHERE id = '${d!.id}'`,
      `UPDATE stored_document SET status = 'PURGED', purged_at = now() WHERE id = '${d!.id}'`,
      `UPDATE stored_document SET entity_id = gen_random_uuid() WHERE id = '${d!.id}'`,
      `UPDATE stored_document SET metadata = '{}'::jsonb WHERE id = '${d!.id}'`,
      `UPDATE stored_document SET created_at = now() - interval '10 years' WHERE id = '${d!.id}'`,
    ];
    for (const sql of attempts)
      for (const [role, exec] of ROLES)
        await expect(exec(sql), `${role}: ${sql}`).rejects.toThrow(
          /stored_document_(content|financial)_immutable|write-once|immutable/,
        );
    // ไฟล์ชนิดอื่นที่เก็บแล้ว: ผูกกับเอกสารได้ (flow POD/เอกสารรถ) แต่เปลี่ยนเนื้อไฟล์ไม่ได้
    const f = await store().put(tenantId, Buffer.from('pod-photo'), 'png');
    const other = await db.storedDocument.create({
      data: {
        tenantId,
        kind: 'POD_PHOTO',
        status: 'READY',
        mimeType: 'image/png',
        sizeBytes: f.size,
        fileKey: f.key,
        sha256: f.sha256,
      },
    });
    await db.storedDocument.update({
      where: { id: other.id },
      data: { entityType: 'delivery_order', entityId: randomUUID() },
    });
    await expect(
      db.storedDocument.update({ where: { id: other.id }, data: { sha256: fake } }),
    ).rejects.toThrow(/stored_document_content_immutable|write-once/);
    expect((await financePdfs())[0]).toEqual(d);
  });

  // ---------- retention ----------
  it('retention job (เลื่อนเวลาไป 10 ปี): ไม่แตะเอกสารที่ออกแล้ว / ไฟล์ PDF / เหตุการณ์ใน audit ของเอกสาร — ไฟล์ส่งออกถูกลบตามปกติ', async () => {
    const tables = NO_DELETE_TABLES.filter((t) => t !== 'audit_log');
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (t) => [t, await count(t)])),
    );
    const pdfsBefore = await financePdfs();
    expect(pdfsBefore.length).toBeGreaterThanOrEqual(4);
    // ตัวเทียบ: ไฟล์ส่งออกเก่า (ต้องถูกลบ) + audit เก่าของเอกสาร (ต้องอยู่) / ของ entity ทั่วไป (ต้องถูกลบ)
    const ex = await store().put(tenantId, Buffer.from('old export'), 'csv');
    const exportDoc = await db.storedDocument.create({
      data: {
        tenantId,
        kind: 'EXPORT',
        status: 'READY',
        mimeType: 'text/csv',
        sizeBytes: ex.size,
        fileKey: ex.key,
        sha256: ex.sha256,
      },
    });
    const old = new Date(Date.now() - 9 * 366 * 86_400_000);
    const audit = (entityType: string) =>
      db.auditLog.create({
        data: { tenantId, action: 'x.old', entityType, entityId: randomUUID(), at: old },
      });
    const kept = await Promise.all(
      [
        'invoice',
        'billing_note',
        'payment',
        'carrier_settlement',
        'stored_document',
        'document_sequence',
      ].map(audit),
    );
    const gone = await audit('driver');

    const tenYears = new Date(Date.now() + 10 * 366 * 86_400_000);
    const out = await app.get(RetentionService).run(tenYears);
    expect(out?.failed).toEqual([]);
    expect(out?.exportFiles).toBeGreaterThanOrEqual(1);
    expect(out?.auditLog).toBeGreaterThanOrEqual(1);

    expect(
      (await db.storedDocument.findUniqueOrThrow({ where: { id: exportDoc.id } })).status,
    ).toBe('PURGED');
    expect(existsSync(join(process.env.FILES_ROOT!, ex.key))).toBe(false);
    expect(await db.auditLog.findUnique({ where: { id: gone.id } })).toBeNull();
    for (const k of kept)
      expect(await db.auditLog.findUnique({ where: { id: k.id } })).not.toBeNull();
    // เอกสาร + ไฟล์ PDF: จำนวนแถวเท่าเดิม (ไฟล์ส่งออกเป็นแถว stored_document เพิ่ม 1 — คงอยู่ในสถานะ PURGED) · ไฟล์ยังอยู่ hash เดิม
    for (const t of tables)
      expect(await count(t), t).toBe(before[t] + (t === 'stored_document' ? 1 : 0));
    const pdfsAfter = await financePdfs();
    expect(pdfsAfter).toEqual(pdfsBefore);
    for (const d of pdfsAfter) {
      expect(d.status).toBe('READY');
      expect(sha(readFileSync(join(process.env.FILES_ROOT!, d.fileKey!)))).toBe(d.sha256);
    }
    // ดาวน์โหลดได้ตามเดิมหลัง "10 ปี"
    await pdf(`/v1/invoices/${encodeId('invoice', invoiceId)}/pdf`).expect(200);
  });

  it('ระยะเก็บเอกสารที่ออกเลขแล้ว: ค่าเริ่ม 7 ปี · ต่ำกว่า 5 ปี → 422 below_minimum · ยืดได้', async () => {
    expect(FINANCE_DOCUMENT_RETENTION).toMatchObject({ minYears: 5, defaultYears: 7 });
    const get = async () =>
      (
        (await api(app, admin).get('/v1/settings').expect(200)).body.data as {
          key: string;
          value: unknown;
        }[]
      ).find((x) => x.key === 'retention.financeDocumentYears')?.value;
    expect(await get()).toBe(7);
    for (const v of [4, 0, 1]) {
      const res = await api(app, admin)
        .patch('/v1/settings')
        .send({ values: { 'retention.financeDocumentYears': v } });
      expect(res.status).toBe(422);
      expect(res.body.errors).toContainEqual(
        expect.objectContaining({
          field: 'values.retention.financeDocumentYears',
          code: 'below_minimum',
        }),
      );
    }
    expect(await get()).toBe(7);
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'retention.financeDocumentYears': 10 } })
      .expect(200);
    expect(await get()).toBe(10);
  });
});
