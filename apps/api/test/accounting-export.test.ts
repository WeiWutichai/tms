import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { ISSUED_INVOICE_STATUSES, SYSTEM_ROLES } from '@tms/domain';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import { FILE_EXPORT_ADAPTER_FACTORIES } from '../src/erp-adapters';
import { JobQueue } from '../src/jobs/job-queue.service';
import { accountingPeriodTag } from '../src/modules/accounting-export/accounting-export.specs';
import { AccountingExportService } from '../src/modules/accounting-export/accounting-export.service';
import {
  ACCOUNTING_DATASETS,
  ACCOUNTING_WHT_ESTIMATE_NOTE as WHT_ESTIMATE_NOTE,
  fileExportAdapterProblems,
  FileExportAdapterRegistry,
} from '../src/modules/accounting-export/file-export-adapter';
import { CANONICAL_INVOICE_INCLUDE, canonicalInvoice } from '../src/modules/erp/canonical';
import { ExportRegistry } from '../src/modules/exports/export-spec';
import { dropUnpricedColumns } from '../src/modules/master/export';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import {
  api,
  bootApp,
  platform,
  settleTripCostsForTest,
  tokenFor,
  truncateAll,
  validTaxId,
} from './helpers';

type Row = Record<string, any>;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

/** CSV (RFC 4180) → แถวของเซลล์ */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

/** ตาราง CSV → object ต่อแถวตามหัวคอลัมน์ */
const table = (rows: string[][]) =>
  rows.slice(1).map((r) => Object.fromEntries(rows[0]!.map((h, i) => [h, r[i] ?? ''])));
const sumCol = (rs: Record<string, string>[], col: string) =>
  rs.reduce((a, r) => a.add(D(r[col] || 0)), D(0)).toFixed(2);

/**
 * ST7-T23 ส่งออกให้นักบัญชี — CSV generic (layout กลาง ผ่าน FileExportAdapter)
 * เกณฑ์ตรวจรับ (plan/01): export ใบแจ้งหนี้ของเดือนเป็น CSV ยอดรวมตรงกับรายงาน · เปิดใน Excel อ่านไทยได้ (UTF-8 BOM)
 */
describe('ส่งออกให้นักบัญชี (ST7-T23)', { timeout: 600_000 }, () => {
  let app: NestExpressApplication;
  const plat = platform();
  let queue: JobQueue;
  let tenantId: string;
  let otherTenantId: string;
  let companyId: string;
  let branchId: string;
  let customerId: string;
  let svcExempt: string;
  let svcVat: string;
  let admin: string;
  let accounting: string;
  let approver: string;
  let noPrice: string;
  let planner: string;
  let other: string;
  let adminRole: string;
  let accountingNoPii: string;
  let individualId = '';
  const nid = validTaxId(5199);
  let seq = 0;
  const today = bangkokToday();
  const [yy, mm] = today.split('-').map(Number) as [number, number];
  const monthFrom = `${today.slice(0, 7)}-01`;
  const monthTo = `${today.slice(0, 7)}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, '0')}`;
  const month = { dateFrom: monthFrom, dateTo: monthTo };
  const issued: { id: string; uuid: string; invoiceNo: string }[] = [];
  let voidedNo = '';
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const juristicTaxId = (seed: number) => {
    const base = `0105${String(seed).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };
  const path = (url: string) => new URL(url).pathname + new URL(url).search;

  const line = (
    no: number,
    serviceItemId: string,
    amount: string,
    vatType: 'EXEMPT_TRANSPORT' | 'VAT_7',
    description = `ค่าขนส่ง รายการที่ ${no}`,
  ) => ({
    tenantId,
    lineNo: no,
    serviceItemId,
    description,
    quantity: '1',
    unitLabel: 'เที่ยว',
    unitPrice: amount,
    amount,
    vatType,
    vatAmount: '0',
    whtRate: '1.00',
    isUserAdded: true,
  });
  /** ร่าง + finalize ผ่าน API (ยอดภาษี/รวมคำนวณโดย finalize จริง) */
  const issueInvoice = async (lines: ReturnType<typeof line>[]) => {
    const inv = await plat.invoice.create({
      data: {
        tenantId,
        customerId,
        issuingCompanyId: companyId,
        issuingBranchId: branchId,
        status: 'DRAFT',
        creditTermDays: 30,
        createdBy: 'u-prep',
        customerPoNo: `PO-${++seq}`,
        lines: { create: lines },
      },
    });
    const id = encodeId('invoice', inv.id);
    const r = await api(app, accounting)
      .post(`/v1/invoices/${id}/finalize`)
      .set('If-Match', `"${inv.version}"`)
      .send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { id, uuid: inv.id, invoiceNo: r.body.invoiceNo as string, version: r.body.version };
  };

  const paidSettlement = async (carrierId: string, amount: string) => {
    const trip = await plat.trip.create({
      data: { tenantId, tripNo: `TRP-AX-${++seq}`, tripDate: new Date(`${today}T00:00:00Z`) },
    });
    await plat.tripCost.create({
      data: {
        tenantId,
        tripId: trip.id,
        costType: 'CARRIER_FEE',
        amount,
        source: 'MANUAL',
        carrierId,
        description: 'ค่าจ้างรถร่วม, รอบ "ทดสอบ"',
      },
    });
    await settleTripCostsForTest(plat, { tripId: trip.id }, 'u-acc');
    const s = await plat.carrierSettlement.findFirstOrThrow({
      where: { tenantId, carrierId, status: 'DRAFT' },
      orderBy: { createdAt: 'desc' },
    });
    const car = await plat.carrier.findUniqueOrThrow({ where: { id: carrierId } });
    await plat.carrierSettlement.update({
      where: { id: s.id },
      data: {
        payingCompanyId: companyId,
        carrierSnapshot: {
          code: car.code,
          legalName: car.legalName,
          entityType: car.entityType,
          taxId: car.taxId,
          // เหมือน snapshot จริง (settlements.service): บุคคลธรรมดาเก็บเลขท้าย 4 หลัก
          taxIdLast4: car.entityType === 'JURISTIC' ? null : car.taxIdLast4,
          branchCode: car.branchCode,
          address: null,
        },
      },
    });
    const id = encodeId('settlement', s.id);
    const etag = async () =>
      `"${(await plat.carrierSettlement.findUniqueOrThrow({ where: { id: s.id } })).version}"`;
    const a = await api(app, approver)
      .post(`/v1/settlements/${id}/approve`)
      .set('If-Match', await etag())
      .send({ reason: 'ตรวจยอดตรงใบแจ้งหนี้รถร่วมแล้ว' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const p = await api(app, accounting)
      .post(`/v1/settlements/${id}/mark-paid`)
      .set('If-Match', await etag())
      .send({ paidDate: today, method: 'TRANSFER', reference: 'KBANK-0001', bank: 'กสิกรไทย' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    return { id, uuid: s.id };
  };

  /** สั่งงานส่งออก → รัน job → ไฟล์ (Buffer) + สถานะงาน */
  const runExport = async (
    resource: string,
    filter: Record<string, string>,
    token = accounting,
    format: 'csv' | 'xlsx' = 'csv',
  ) => {
    const j = await api(app, token).post('/v1/exports').send({ resource, format, filter });
    expect(j.status, JSON.stringify(j.body)).toBe(202);
    for (let i = 0; i < 20 && (await queue.runOnce()); i++);
    const s = (await api(app, token).get(`/v1/exports/${j.body.id}`).expect(200)).body as Row;
    expect(s.status, JSON.stringify(s)).toBe('succeeded');
    const dl = await request(app.getHttpServer())
      .get(path(s.downloadUrl))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    return { job: s, file: dl.body as Buffer, headers: dl.headers };
  };
  const csvRows = (file: Buffer) => table(parseCsv(file.subarray(3).toString('utf8')));

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    queue = app.get(JobQueue);
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท ส่งออกบัญชี จำกัด' })).id;
    otherTenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น จำกัด' })).id;
    companyId = (
      await plat.company.create({
        data: { tenantId, legalName: 'บริษัท ผู้ออกบิล จำกัด', taxId: validTaxId(5101) },
      })
    ).id;
    branchId = (
      await plat.branch.create({
        data: {
          tenantId,
          companyId,
          branchCode: '00000',
          branchLabel: 'สำนักงานใหญ่',
          isDefaultIssuer: true,
          address: { line1: '1', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
        },
      })
    ).id;
    customerId = (
      await plat.customer.create({
        data: {
          tenantId,
          code: 'C-AX1',
          legalName: 'บริษัท ลูกค้า, "ทดสอบ" จำกัด',
          taxId: validTaxId(5102),
          branchCode: '00001',
        },
      })
    ).id;
    const si = (vatType: 'EXEMPT_TRANSPORT' | 'VAT_7') =>
      plat.serviceItem.findFirstOrThrow({
        where: { tenantId, vatType, status: 'ACTIVE', deletedAt: null },
      });
    svcExempt = (await si('EXEMPT_TRANSPORT')).id;
    svcVat = (await si('VAT_7')).id;
    admin = await tokenFor(tenantId);
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    approver = await tokenFor(tenantId, SYSTEM_ROLES.approver.permissions.join(' '), 'u-appr');
    noPrice = await tokenFor(tenantId, 'invoices:read settlements:read export:run', 'u-np');
    planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-plan');
    other = await tokenFor(otherTenantId);
    adminRole = await tokenFor(tenantId, SYSTEM_ROLES.admin.permissions.join(' '), 'u-adm');
    accountingNoPii = await tokenFor(
      tenantId,
      SYSTEM_ROLES.accounting.permissions.filter((p) => p !== 'pii.national_id:read').join(' '),
      'u-acc2',
    );

    // ใบแจ้งหนี้ที่ออกในเดือนนี้ 3 ใบ (ยกเว้น VAT / VAT 7% / ผสม + ข้อความที่ต้อง escape และขึ้นต้นด้วย =)
    issued.push(await issueInvoice([line(1, svcExempt, '12500.00', 'EXEMPT_TRANSPORT')]));
    issued.push(await issueInvoice([line(1, svcVat, '1000.00', 'VAT_7')]));
    issued.push(
      await issueInvoice([
        line(1, svcExempt, '8000.50', 'EXEMPT_TRANSPORT', '=SUM(A1) ค่าขนส่ง, "ชลบุรี"'),
        line(2, svcVat, '350.25', 'VAT_7', 'ค่ารอคิว'),
      ]),
    );
    // ยกเลิก 1 ใบ (ไม่นับ) + ร่าง 1 ใบ (ไม่นับ)
    const v = await issueInvoice([line(1, svcExempt, '777.00', 'EXEMPT_TRANSPORT')]);
    voidedNo = v.invoiceNo;
    const vr = await api(app, admin)
      .post(`/v1/invoices/${v.id}/void`)
      .set('If-Match', `"${v.version}"`)
      .send({ reason: 'ทดสอบยกเลิกใบแจ้งหนี้ก่อนส่งลูกค้า' });
    expect(vr.status, JSON.stringify(vr.body)).toBe(200);
    await plat.invoice.create({
      data: {
        tenantId,
        customerId,
        issuingCompanyId: companyId,
        issuingBranchId: branchId,
        status: 'DRAFT',
        createdBy: 'u-prep',
        lines: { create: [line(1, svcExempt, '999.00', 'EXEMPT_TRANSPORT')] },
      },
    });
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  it('รูปแบบไฟล์ลงทะเบียนผ่าน composition root · รูปของ adapter ผ่าน · ทั่วไป = ค่าเริ่มต้น รองรับทุกชุด', () => {
    const reg = app.get(FileExportAdapterRegistry);
    for (const f of FILE_EXPORT_ADAPTER_FACTORIES)
      expect(fileExportAdapterProblems(f())).toEqual([]);
    const def = reg.default()!;
    expect(def.key).toBe('generic');
    expect([...def.datasets]).toEqual([...ACCOUNTING_DATASETS]);
    // ไม่มีสิทธิ์เงิน = ไม่มีคอลัมน์เงิน
    for (const d of ACCOUNTING_DATASETS) {
      const all = def.columns(d, { sell: true, buy: true }).length;
      expect(def.columns(d, { sell: false, buy: false }).length).toBeLessThan(all);
    }
  });

  it('contract: render fixture ด้วยสิทธิ์ {sell:false,buy:false} ไม่มีค่าเงินหลุด · ทุกคอลัมน์ที่ออกเงินติดป้าย price · core ตัดคอลัมน์ติดป้ายแม้ adapter ไม่กรอง', () => {
    // ค่าเงินในชุดทดสอบเป็นเลขเฉพาะ (มี .37) — คอลัมน์ไม่ใช่เงิน (อัตรา %, จำนวน, ลำดับ) ใช้เลขอื่น
    const M = (n: number) => `${n}.37`;
    const isMoney = (v: unknown) => typeof v === 'number' && /\.37$/.test(String(v));
    const doc = {
      kind: 'invoice',
      id: 'i',
      number: 'INV-1',
      issueDate: '2026-10-01',
      dueDate: null,
      issuer: { companyId: 'c', branchId: 'b', branchCode: '00000' },
      customer: {
        id: 'x',
        code: 'C',
        legalName: 'L',
        taxId: null,
        branchCode: null,
        externalId: null,
      },
      customerPoNo: null,
      taxEstimated: true,
      totals: {
        subtotalVatable: M(1),
        subtotalExempt: M(2),
        subtotalZeroRated: M(3),
        vatAmount: M(4),
        total: M(5),
        whtExpected: M(6),
      },
      lines: [],
    } as any;
    const iline = {
      lineNo: 1,
      deliveryOrder: null,
      serviceItem: { id: 's' },
      description: 'd',
      quantity: '2',
      unitLabel: 'u',
      unitPrice: M(7),
      discount: M(8),
      amount: M(9),
      vatType: 'VAT_7',
      vatAmount: M(10),
      whtRate: '1.00',
    } as any;
    const payment = {
      id: 'p',
      number: 'PAY',
      receivedDate: '2026-10-01',
      customer: { code: 'C', legalName: 'L' },
      method: 'TRANSFER',
      reference: null,
      cheque: { number: null, bank: null, date: null, status: null },
      whtCertificateNo: null,
      amountReceived: M(11),
      whtAmount: M(12),
      feeAmount: M(13),
      differenceAmount: M(14),
      differenceReason: null,
      allocatedTotal: M(15),
    };
    const stl = {
      kind: 'settlement',
      id: 's',
      number: 'STL',
      paidDate: '2026-10-01',
      payingCompanyId: null,
      period: { from: '2026-10-01', to: '2026-10-31' },
      carrierInvoiceNumber: null,
      carrier: {
        id: 'c',
        code: 'R',
        legalName: 'L',
        taxId: null,
        branchCode: null,
        entityType: 'JURISTIC',
      },
      payment: { method: 'TRANSFER', reference: null, bank: null },
      totals: { gross: M(16), deduction: M(17), net: M(18), wht: M(19), netAfterWht: M(20) },
      whtEstimate: { pndForm: 'PND53', byRate: [], reviewedByAccountant: false },
      taxEstimated: true,
      lines: [],
    } as any;
    const sline = {
      lineNo: 1,
      lineType: 'FREIGHT',
      trip: null,
      description: 'd',
      amount: M(21),
      vatType: null,
      whtRate: '1.00',
      whtAmount: M(22),
    } as any;
    const fixture: Record<string, any[]> = {
      sales: [
        {
          id: 'i',
          level: 'document',
          doc,
          line: null,
          status: 'ISSUED',
          cancelled: null,
          issuerName: 'I',
          replacesNumber: null,
        },
        {
          id: 'i',
          level: 'line',
          doc,
          line: iline,
          status: 'ISSUED',
          cancelled: null,
          issuerName: 'I',
          replacesNumber: null,
        },
        // D-73 ใบที่ยกเลิก — ยอดตามที่ออกอยู่ในคอลัมน์ยกเลิก (ติดป้าย price ด้วย)
        {
          id: 'i2',
          level: 'document',
          doc,
          line: null,
          status: 'CANCELLED',
          cancelled: { date: '2026-10-02', reason: 'r' },
          issuerName: 'I',
          replacesNumber: null,
        },
      ],
      receipts: [
        {
          id: 'p',
          level: 'document',
          payment,
          allocation: null,
          status: 'RECORDED',
          reversed: null,
        },
        {
          id: 'p',
          level: 'line',
          payment,
          allocation: { lineNo: 1, invoiceNumber: 'INV-1', amount: M(23), whtAmount: M(24) },
          status: 'RECORDED',
          reversed: null,
        },
        {
          id: 'p2',
          level: 'document',
          payment,
          allocation: null,
          status: 'REVERSED',
          reversed: { date: '2026-10-02', reason: 'r' },
        },
      ],
      settlements: [
        {
          id: 's',
          level: 'document',
          doc: stl,
          line: null,
          payerName: 'P',
          carrierTaxId: null,
          piiIncluded: false,
        },
        {
          id: 's',
          level: 'line',
          doc: stl,
          line: sline,
          payerName: 'P',
          carrierTaxId: null,
          piiIncluded: false,
        },
      ],
      wht: [
        {
          id: 'carrier:c',
          side: 'carrier',
          code: 'R',
          name: 'L',
          entityType: 'INDIVIDUAL',
          taxId: '•••• 1234',
          branchCode: null,
          forms: ['PND3'],
          documents: 2,
          baseAmount: M(25),
          whtAmount: M(26),
          piiIncluded: false,
        },
        {
          id: 'customer:x',
          side: 'customer',
          code: 'C',
          name: 'L',
          entityType: null,
          taxId: null,
          branchCode: null,
          forms: [],
          documents: 1,
          baseAmount: null,
          whtAmount: M(27),
          piiIncluded: false,
        },
      ],
    };
    const cells = (cols: { value: (r: any) => unknown }[], rows: any[]) =>
      rows.flatMap((r) => cols.map((c) => c.value(r)));
    for (const f of FILE_EXPORT_ADAPTER_FACTORIES) {
      const a = f();
      for (const d of a.datasets) {
        const rows = fixture[d]!;
        // ไม่มีสิทธิ์ = ไม่มีค่าเงินในไฟล์ (ทั้งจาก adapter เอง และหลัง core ตัด)
        const none = a.columns(d, { sell: false, buy: false });
        expect(cells(none, rows).filter(isMoney), `${a.key}/${d}`).toEqual([]);
        // สิทธิ์เต็ม: คอลัมน์ใดออกค่าเงิน → ต้องติดป้าย price (core จึงตัดได้)
        const full = a.columns(d, { sell: true, buy: true });
        expect(cells(full, rows).filter(isMoney).length).toBeGreaterThan(0);
        for (const c of full)
          if (rows.some((r) => isMoney(c.value(r))))
            expect(c.price, `${a.key}/${d} '${c.header}' ไม่ติดป้าย price`).toBeDefined();
        // adapter ที่ "ลืมกรอง" (คืนคอลัมน์เต็มเสมอ) — core ตัดทิ้งตามสิทธิ์
        const safe = dropUnpricedColumns(full, { sell: false, buy: false });
        expect(cells(safe, rows).filter(isMoney)).toEqual([]);
      }
    }
    const spec = app.get(ExportRegistry).get('accounting-sales')!;
    const reg = app.get(FileExportAdapterRegistry);
    const real = reg.default()!;
    const leaky = Object.create(real) as typeof real;
    leaky.columns = ((d: any) => real.columns(d, { sell: true, buy: true })) as typeof real.columns;
    const orig = reg.default.bind(reg);
    reg.default = () => leaky;
    try {
      const cols = spec.columns(['invoices:read', 'export:run'], month);
      expect(cells(cols, fixture.sales!).filter(isMoney)).toEqual([]);
      expect(cols.some((c: { price?: string }) => c.price)).toBe(false);
    } finally {
      reg.default = orig;
    }
  });

  it('ป้ายงวดในชื่อไฟล์: เต็มเดือน / เต็มไตรมาส / ช่วงอื่น', () => {
    expect(accountingPeriodTag('2026-10-01', '2026-10-31')).toBe('ต.ค.2569');
    expect(accountingPeriodTag('2026-10-01', '2026-12-31')).toBe('ไตรมาส4-2569');
    expect(accountingPeriodTag('2026-11-01', '2026-11-22')).toBe('2026-11-01_2026-11-22');
    expect(accountingPeriodTag('2024-02-01', '2024-02-29')).toBe('ก.พ.2567');
  });

  it('เกณฑ์ตรวจรับ: ใบแจ้งหนี้ของเดือนเป็น CSV — ยอดรวมตรงกับรายงาน (ใบแจ้งหนี้ออกเดือนนี้) · UTF-8 BOM + CRLF · ไทยอ่านได้', async () => {
    const { job, file, headers } = await runExport('accounting-sales', month);
    // Excel อ่านไทยได้: BOM + CRLF + หัวคอลัมน์ภาษาไทย
    expect([...file.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = file.subarray(3).toString('utf8');
    expect(text.split('\r\n').length).toBeGreaterThan(2);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);
    const rows = csvRows(file);
    expect(parseCsv(text)[0]!.slice(0, 3)).toEqual(['ระดับ', 'เลขที่ใบแจ้งหนี้', 'วันที่']);
    expect(job.fileName).toBe(`รายการขาย_${accountingPeriodTag(monthFrom, monthTo)}.csv`);
    expect(headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('รายการขาย_')}`,
    );
    expect(job.rows).toBe(rows.length);

    // รายงาน: "ออกใบแจ้งหนี้เดือนนี้" ของ GET /v1/invoices/summary (Dashboard บิล ST9-T02 — ชุดสถานะเดียวกับรายงานรายได้)
    const s = (await api(app, accounting).get('/v1/invoices/summary').expect(200)).body as Row;
    // D-73: ใบที่ยกเลิกอยู่ในไฟล์เป็นแถวเอกสารแยก (ยอดในคอลัมน์ยกเลิก) — "เอกสารที่ยังใช้" = สถานะไม่ใช่ยกเลิก
    const cancelledRows = rows.filter((r) => r['สถานะ'] === 'ยกเลิกแล้ว');
    const docs = rows.filter((r) => r['ระดับ'] === 'เอกสาร' && r['สถานะ'] !== 'ยกเลิกแล้ว');
    const lines = rows.filter((r) => r['ระดับ'] === 'รายการ');
    expect(docs.length).toBe(s.issuedThisMonth.count);
    expect(docs.length).toBe(3);
    expect(sumCol(rows, 'รวมทั้งสิ้น')).toBe(s.issuedThisMonth.sellTotal);
    // ทุกคอลัมน์ยอดของหัวเอกสาร = ผลรวมจากฐาน · Σ รายการ = Σ มูลค่าก่อน VAT ของหัว
    const agg = await plat.invoice.aggregate({
      where: {
        tenantId,
        status: { in: [...ISSUED_INVOICE_STATUSES] },
        issueDate: {
          gte: new Date(`${monthFrom}T00:00:00Z`),
          lte: new Date(`${monthTo}T00:00:00Z`),
        },
      },
      _sum: {
        totalAmount: true,
        vatAmount: true,
        subtotalExempt: true,
        subtotalVatable: true,
        subtotalZeroRated: true,
        whtExpectedAmount: true,
      },
    });
    expect(sumCol(rows, 'รวมทั้งสิ้น')).toBe(D(agg._sum.totalAmount!).toFixed(2));
    expect(sumCol(rows, 'VAT')).toBe(D(agg._sum.vatAmount!).toFixed(2));
    expect(sumCol(rows, 'มูลค่ายกเว้น VAT')).toBe(D(agg._sum.subtotalExempt!).toFixed(2));
    expect(sumCol(rows, 'มูลค่า VAT 7%')).toBe(D(agg._sum.subtotalVatable!).toFixed(2));
    expect(sumCol(rows, 'หัก ณ ที่จ่ายที่คาดว่าจะถูกหัก')).toBe(
      D(agg._sum.whtExpectedAmount!).toFixed(2),
    );
    expect(sumCol(lines, 'มูลค่ารายการ (ก่อน VAT)')).toBe(
      D(agg._sum.subtotalExempt!)
        .add(agg._sum.subtotalVatable!)
        .add(agg._sum.subtotalZeroRated!)
        .toFixed(2),
    );
    expect(sumCol(lines, 'มูลค่ารายการ (ก่อน VAT)')).toBe('21850.75');
    expect(lines).toHaveLength(4);
    // แถวรายการไม่มียอดหัว (ผลรวมคอลัมน์ไม่ซ้ำ) · แถวเอกสารไม่มียอดรายการ
    expect(lines.every((r) => r['รวมทั้งสิ้น'] === '')).toBe(true);
    expect(docs.every((r) => r['มูลค่ารายการ (ก่อน VAT)'] === '')).toBe(true);
    // ร่างไม่อยู่ในไฟล์ · ใบที่ยกเลิก (D-73) = แถวเอกสาร 1 แถว สถานะ/วันที่/เหตุผล ยอดอยู่ในคอลัมน์ยกเลิกเท่านั้น
    const nos = new Set(rows.map((r) => r['เลขที่ใบแจ้งหนี้']));
    expect([...nos].sort()).toEqual([...issued.map((i) => i.invoiceNo), voidedNo].sort());
    expect(cancelledRows).toHaveLength(1);
    const vrow = cancelledRows[0]!;
    expect(vrow).toMatchObject({
      ระดับ: 'เอกสาร',
      เลขที่ใบแจ้งหนี้: voidedNo,
      วันที่ยกเลิก: today,
      เหตุผลยกเลิก: 'ทดสอบยกเลิกใบแจ้งหนี้ก่อนส่งลูกค้า',
      รวมทั้งสิ้น: '',
      VAT: '',
      'หัก ณ ที่จ่ายที่คาดว่าจะถูกหัก': '',
      'รวมทั้งสิ้นของใบที่ยกเลิก (ไม่นับรวม)': '777',
    });
    const cagg = await plat.invoice.aggregate({
      where: { tenantId, status: { in: ['CANCELLED', 'VOIDED'] }, invoiceNo: { not: null } },
      _sum: { totalAmount: true, vatAmount: true },
    });
    expect(sumCol(rows, 'รวมทั้งสิ้นของใบที่ยกเลิก (ไม่นับรวม)')).toBe(
      D(cagg._sum.totalAmount!).toFixed(2),
    );
    expect(sumCol(rows, 'VAT ของใบที่ยกเลิก (ไม่นับรวม)')).toBe(D(cagg._sum.vatAmount!).toFixed(2));
    expect(docs.every((r) => r['รวมทั้งสิ้นของใบที่ยกเลิก (ไม่นับรวม)'] === '')).toBe(true);
    // ไทย + escape + กันสูตร (ค่า = นำหน้าด้วย ')
    expect(docs[0]!['ลูกค้า']).toBe('บริษัท ลูกค้า, "ทดสอบ" จำกัด');
    expect(lines.some((r) => r['รายการ'] === `'=SUM(A1) ค่าขนส่ง, "ชลบุรี"`)).toBe(true);
    expect(docs.every((r) => r['สถานะ'] === 'ออกแล้ว')).toBe(true);
    expect(docs[0]!['สาขาลูกค้า']).toBe('00001');
    expect(docs[0]!['นิติบุคคลผู้ออก']).toBe('บริษัท ผู้ออกบิล จำกัด');
    // เรียงตามวันที่ออก + เลขที่ (แถวเอกสารนำหน้ารายการของใบเดียวกัน)
    const allDocs = rows.filter((r) => r['ระดับ'] === 'เอกสาร');
    expect(allDocs.map((r) => r['เลขที่ใบแจ้งหนี้'])).toEqual(
      [...allDocs.map((r) => r['เลขที่ใบแจ้งหนี้'])].sort(),
    );
    expect(rows[0]!['ระดับ']).toBe('เอกสาร');

    // layout กลาง = canonical ชุดเดียวกับทางส่ง ERP
    const inv = await plat.invoice.findUniqueOrThrow({
      where: { id: issued[2]!.uuid },
      include: CANONICAL_INVOICE_INCLUDE,
    });
    const c = canonicalInvoice(inv, null);
    const mine = rows.filter((r) => r['เลขที่ใบแจ้งหนี้'] === c.number);
    expect(mine[0]!['รวมทั้งสิ้น']).toBe(String(Number(c.totals.total)));
    expect(mine.slice(1).map((r) => r['ลำดับ'])).toEqual(c.lines.map((l) => String(l.lineNo)));

    // ไฟล์เดิมเมื่อข้อมูลเดิม (deterministic)
    const again = await runExport('accounting-sales', month);
    expect(Buffer.compare(again.file, file)).toBe(0);
    // .xlsx ได้จำนวนแถวเท่ากัน
    expect((await runExport('accounting-sales', month, accounting, 'xlsx')).job.rows).toBe(
      job.rows,
    );
  });

  it('อ่านทีละหน้า (keyset ตามวันที่ + เลขที่) ไม่ซ้ำไม่ตกหล่น', async () => {
    const svc = app.get(AccountingExportService);
    const seen: string[] = [];
    await app.get(DbService).withTenant(tenantId, (tx) =>
      requestContext.run(
        { requestId: randomUUID(), tenantId, actorId: 'u-acc', locale: 'th', tx },
        async () => {
          let after: string | null = null;
          for (let i = 0; i < 10; i++) {
            const page = await svc.salesRows(month, { after, take: 1 });
            if (!page.length) break;
            expect(new Set(page.map((r) => r.id)).size).toBe(1);
            seen.push(page[0]!.doc.number);
            after = uuid('invoice', page[0]!.id);
          }
        },
      ),
    );
    expect(seen).toEqual([...seen].sort());
    expect([...seen].sort()).toEqual([...issued.map((i) => i.invoiceNo), voidedNo].sort());
  });

  it('รับชำระ + จ่ายรถร่วม: ยอดในไฟล์ = เอกสาร · กลับรายการไม่นับ', async () => {
    const pay = async (inv: { id: string }, amount: string, wht = '0.00') =>
      (
        await api(app, accounting)
          .post('/v1/payments')
          .send({
            receivedDate: today,
            method: 'TRANSFER',
            reference: 'SCB-001',
            amountReceived: D(amount).minus(wht).toFixed(2),
            whtAmount: wht,
            allocations: [{ invoiceId: inv.id, amount, whtAmount: wht }],
          })
          .expect(201)
      ).body as Row;
    await pay(issued[0]!, '12500.00', '125.00');
    await pay(issued[1]!, '500.00');
    const rev = await pay(issued[1]!, '100.00');
    const rr = await api(app, admin)
      .post(`/v1/payments/${rev.id}/reverse`)
      .set('If-Match', `"${rev.version}"`)
      .send({ reason: 'บันทึกซ้ำโดยไม่ได้ตั้งใจ ทดสอบ' });
    expect(rr.status, JSON.stringify(rr.body)).toBe(200);

    const r = csvRows((await runExport('accounting-receipts', month)).file);
    const docs = r.filter((x) => x['ระดับ'] === 'เอกสาร' && x['สถานะ'] === 'บันทึกแล้ว');
    expect(docs).toHaveLength(2);
    // D-73: กลับรายการ = แถวเอกสาร 1 แถว (ไม่มีแถวตัดหนี้) ยอดอยู่ในคอลัมน์กลับรายการ — ผลรวมคอลัมน์ปกติไม่เปลี่ยน
    const revRows = r.filter((x) => x['เลขที่รับชำระ'] === rev.paymentNo);
    expect(revRows).toHaveLength(1);
    expect(revRows[0]).toMatchObject({
      ระดับ: 'เอกสาร',
      สถานะ: 'กลับรายการแล้ว',
      วันที่กลับรายการ: today,
      เหตุผลกลับรายการ: 'บันทึกซ้ำโดยไม่ได้ตั้งใจ ทดสอบ',
      เงินรับ: '',
      ยอดตัดหนี้รวม: '',
      'เงินรับที่กลับรายการ (ไม่นับรวม)': '100',
      'หัก ณ ที่จ่ายที่กลับรายการ (ไม่นับรวม)': '0',
    });
    expect(sumCol(r, 'เงินรับที่กลับรายการ (ไม่นับรวม)')).toBe('100.00');
    expect(sumCol(r, 'เงินรับ')).toBe('12875.00');
    expect(sumCol(r, 'หัก ณ ที่จ่ายที่ถูกหัก')).toBe('125.00');
    expect(sumCol(r, 'ยอดตัดหนี้รวม')).toBe('13000.00');
    expect(sumCol(r, 'ยอดตัดหนี้ของใบ')).toBe('13000.00');
    expect(r.filter((x) => x['ระดับ'] === 'รายการ').map((x) => x['ใบแจ้งหนี้ที่ตัด'])).toEqual([
      issued[0]!.invoiceNo,
      issued[1]!.invoiceNo,
    ]);
    expect(docs[0]!['วิธีรับ']).toBe('โอนเงิน');
    expect(docs.some((x) => x['เลขที่รับชำระ'] === rev.paymentNo)).toBe(false);
    expect(docs.every((x) => x['วันที่กลับรายการ'] === '')).toBe(true);

    const car = await api(app, admin)
      .post('/v1/carriers')
      .send({
        legalName: 'บริษัท รถร่วมส่งออก จำกัด',
        entityType: 'JURISTIC',
        taxId: juristicTaxId(5103),
        branchCode: '00000',
        phone: '081-234-5670',
      });
    expect(car.status, JSON.stringify(car.body)).toBe(201);
    const s1 = await paidSettlement(uuid('carrier', car.body.id), '9000.00');
    await paidSettlement(uuid('carrier', car.body.id), '4500.50');
    const st = csvRows((await runExport('accounting-settlements', month)).file);
    const sd = st.filter((x) => x['ระดับ'] === 'เอกสาร');
    expect(sd).toHaveLength(2);
    const rows = await plat.carrierSettlement.findMany({ where: { tenantId, status: 'PAID' } });
    const net = rows.reduce((a, x) => a.add(x.netPayable).minus(x.whtAmount ?? 0), D(0));
    const wht = rows.reduce((a, x) => a.add(x.whtAmount ?? 0), D(0));
    expect(sumCol(st, 'ค่าขนส่งรวม')).toBe('13500.50');
    expect(sumCol(st, 'จ่ายสุทธิ')).toBe(net.toFixed(2));
    expect(sumCol(st, 'หัก ณ ที่จ่าย (ประมาณการ)')).toBe(wht.toFixed(2));
    expect(sumCol(st, 'ยอดรายการ')).toBe('13500.50');
    expect(sd[0]!['เลขผู้เสียภาษีผู้รับเหมา']).toBe(juristicTaxId(5103));
    expect(sd[0]!['แบบยื่นหัก ณ ที่จ่าย (ประมาณการ)']).toBe('ภ.ง.ด.53');
    expect(st.some((x) => x['รายการ'] === 'ค่าจ้างรถร่วม, รอบ "ทดสอบ"')).toBe(true);
    expect(s1.id).toMatch(/^stl_/);

    // summary ตรงกับไฟล์
    const sum = (
      await api(app, accounting)
        .get(`/v1/accounting-exports/summary?dateFrom=${monthFrom}&dateTo=${monthTo}`)
        .expect(200)
    ).body as Row;
    const by = Object.fromEntries((sum.datasets as Row[]).map((d) => [d.dataset, d]));
    expect(by.sales).toMatchObject({
      resource: 'accounting-sales',
      documents: 3,
      cancelledDocuments: 1,
      rows: 8,
    });
    expect(by.receipts).toMatchObject({ documents: 2, cancelledDocuments: 1, rows: r.length });
    expect(by.settlements).toMatchObject({ documents: 2, cancelledDocuments: 0, rows: st.length });
    expect(sum.templates).toEqual([
      {
        key: 'generic',
        displayName: 'ทั่วไป',
        isDefault: true,
        datasets: [...ACCOUNTING_DATASETS],
      },
    ]);
  });

  it('สิทธิ์: ไม่มีสิทธิ์ราคา = ไม่มีคอลัมน์เงิน · ไม่มีสิทธิ์อ่านชุด = 403 / ไม่อยู่ใน summary · tenant อื่นไม่เห็น', async () => {
    const np = parseCsv(
      (await runExport('accounting-sales', month, noPrice)).file.subarray(3).toString('utf8'),
    );
    expect(np[0]).not.toContain('รวมทั้งสิ้น');
    expect(np[0]).not.toContain('ราคาต่อหน่วย');
    expect(np[0]).toContain('อัตราหัก ณ ที่จ่าย (%)');
    expect(np.length - 1).toBe(8);
    expect(np[0]).not.toContain('รวมทั้งสิ้นของใบที่ยกเลิก (ไม่นับรวม)');
    const ns = parseCsv(
      (await runExport('accounting-settlements', month, noPrice)).file.subarray(3).toString('utf8'),
    );
    expect(ns[0]).not.toContain('จ่ายสุทธิ');

    await api(app, planner)
      .post('/v1/exports')
      .send({ resource: 'accounting-sales', format: 'csv', filter: month })
      .expect(403);
    const ps = (
      await api(app, planner)
        .get(`/v1/accounting-exports/summary?dateFrom=${monthFrom}&dateTo=${monthTo}`)
        .expect(200)
    ).body as Row;
    expect((ps.datasets as Row[]).some((d) => d.dataset === 'sales')).toBe(false);

    const o = await runExport('accounting-sales', month, other);
    expect(o.job.rows).toBe(0);
    expect(parseCsv(o.file.subarray(3).toString('utf8'))).toHaveLength(1);
    const os = (
      await api(app, other)
        .get(`/v1/accounting-exports/summary?dateFrom=${monthFrom}&dateTo=${monthTo}`)
        .expect(200)
    ).body as Row;
    expect((os.datasets as Row[]).every((d) => d.documents === 0)).toBe(true);
  });

  it('D-73 เลขบัตรประชาชนรถร่วมบุคคล: เต็มเฉพาะผู้มี pii.national_id:read + audit export.pii_included · ไม่มีสิทธิ์/admin = •••• 4 หลัก · API key ไม่ได้เสมอ', async () => {
    const car = await api(app, admin).post('/v1/carriers').send({
      legalName: 'นาย รถร่วม บุคคล',
      entityType: 'INDIVIDUAL',
      taxId: nid,
      phone: '081-234-5671',
    });
    expect(car.status, JSON.stringify(car.body)).toBe(201);
    individualId = uuid('carrier', car.body.id);
    await paidSettlement(individualId, '30000.00');
    const docOf = (file: Buffer) =>
      csvRows(file).find((x) => x['ระดับ'] === 'เอกสาร' && x['ผู้รับเหมา'] === 'นาย รถร่วม บุคคล')!;
    const piiAudits = () =>
      plat.auditLog.findMany({
        where: { tenantId, action: 'export.pii_included' },
        orderBy: { seq: 'asc' },
      });

    // ไม่มีสิทธิ์ (บัญชีที่ถูกถอด pii) → เลขท้าย 4 หลัก · ไม่มี audit
    const masked = await runExport('accounting-settlements', month, accountingNoPii);
    expect(masked.file.toString('utf8')).not.toContain(nid);
    const md = docOf(masked.file);
    expect(md['ประเภทผู้รับเหมา']).toBe('บุคคลธรรมดา');
    expect(md['เลขผู้เสียภาษีผู้รับเหมา']).toBe(`•••• ${nid.slice(-4)}`);
    expect(md['แบบยื่นหัก ณ ที่จ่าย (ประมาณการ)']).toBe('ภ.ง.ด.3');
    // admin (role ระบบ) ไม่ได้สิทธิ์นี้โดยค่าเริ่มต้น
    const adm = await runExport('accounting-settlements', month, adminRole);
    expect(adm.file.toString('utf8')).not.toContain(nid);
    expect(await piiAudits()).toHaveLength(0);

    // บัญชี (role ระบบ — มี pii.national_id:read) → เลขเต็ม + audit 1 แถวต่อไฟล์
    const full = await runExport('accounting-settlements', month);
    expect(docOf(full.file)['เลขผู้เสียภาษีผู้รับเหมา']).toBe(nid);
    // แถวนิติบุคคลยังเป็นเลขผู้เสียภาษีเต็มตามเดิม
    expect(
      csvRows(full.file).some((x) => x['เลขผู้เสียภาษีผู้รับเหมา'] === juristicTaxId(5103)),
    ).toBe(true);
    const a1 = await piiAudits();
    expect(a1).toHaveLength(1);
    expect(a1[0]).toMatchObject({ actorId: 'u-acc', entityType: 'job' });
    expect(a1[0]!.entityId).toBe(uuid('job', full.job.id));
    expect(a1[0]!.after).toMatchObject({
      resource: 'accounting-settlements',
      fields: ['carrier.nationalId'],
      count: 1,
    });
    expect(JSON.stringify(a1[0]!.after)).not.toContain(nid);

    // API key: ขอ scope นี้ไม่ได้ (422) และส่งออกด้วย key = เลขท้าย 4 หลักเสมอ ไม่มี audit pii
    const bad = await api(app, admin)
      .post('/v1/api-keys')
      .send({ name: 'k-pii', scopes: ['pii.national_id:read'] });
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    const k = await api(app, admin)
      .post('/v1/api-keys')
      .send({
        name: 'k-acct',
        scopes: ['settlements:read', 'invoices:read', 'export:run', 'prices.buy:read'],
      });
    expect(k.status, JSON.stringify(k.body)).toBe(201);
    const byKey = await runExport('accounting-settlements', month, k.body.secret as string);
    expect(byKey.file.toString('utf8')).not.toContain(nid);
    expect(docOf(byKey.file)['เลขผู้เสียภาษีผู้รับเหมา']).toBe(`•••• ${nid.slice(-4)}`);
    const kw = await runExport('accounting-wht-summary', month, k.body.secret as string);
    expect(kw.file.toString('utf8')).not.toContain(nid);
    expect(await piiAudits()).toHaveLength(1);
    // แม้ principal เป็น key ที่ (ผิดปกติ) ถือ scope นี้ — core ไม่ให้เลขเต็ม (เฉพาะคนที่ login)
    const { nationalIdAllowed } =
      await import('../src/modules/accounting-export/accounting-export.service');
    expect(nationalIdAllowed(['pii.national_id:read'], 'client')).toBe(false);
    expect(nationalIdAllowed(['*'], 'client')).toBe(false);
    expect(nationalIdAllowed(['pii.national_id:read'], 'imp')).toBe(false);
    expect(nationalIdAllowed(['pii.national_id:read'], 'user')).toBe(true);
    expect(nationalIdAllowed(['invoices:read'], 'user')).toBe(false);
  });

  it('D-73 สรุปหัก ณ ที่จ่าย (ประมาณการ): ยอด = Σ ค่าที่บันทึกไว้ · แบบ ภ.ง.ด. จาก ST6-T08 · ป้าย "ประมาณการ" · ตามสิทธิ์ · tenant อื่นไม่เห็น', async () => {
    const { job, file } = await runExport('accounting-wht-summary', month);
    expect(job.fileName).toBe(
      `หัก ณ ที่จ่าย-ประมาณการ_${accountingPeriodTag(monthFrom, monthTo)}.csv`,
    );
    const rows = csvRows(file);
    expect(job.rows).toBe(rows.length);
    expect(rows.every((r) => r['ประเภทข้อมูล'] === WHT_ESTIMATE_NOTE)).toBe(true);
    expect(WHT_ESTIMATE_NOTE).toContain('ประมาณการ');

    // ฝั่งผู้รับเหมา: Σ wht_amount ที่ตรึงของใบ PAID (> 0) ต่อรถร่วม · ฐาน = Σ ฐานอัตรา > 0 ของผลประมาณการ ST6-T08
    const stls = await plat.carrierSettlement.findMany({
      where: { tenantId, status: 'PAID', whtAmount: { gt: 0 } },
      include: { carrier: true },
    });
    expect(stls.length).toBeGreaterThanOrEqual(3);
    const carrierRows = rows.filter((r) => r['ฝั่ง'] === 'เราหัก ณ ที่จ่ายผู้รับเหมา');
    const carriers = [...new Set(stls.map((x) => x.carrierId))];
    expect(carrierRows).toHaveLength(carriers.length);
    for (const cid of carriers) {
      const mine = stls.filter((x) => x.carrierId === cid);
      const row = carrierRows.find((r) => r['รหัสคู่ค้า'] === mine[0]!.carrier.code)!;
      expect(row, mine[0]!.carrier.code).toBeDefined();
      const wht = mine.reduce((a, x) => a.add(x.whtAmount!), D(0));
      expect(D(row['หัก ณ ที่จ่าย — ผู้รับเหมา (ประมาณการ)']!).toFixed(2)).toBe(wht.toFixed(2));
      expect(row['จำนวนเอกสาร']).toBe(String(mine.length));
      let base = D(0);
      for (const x of mine) {
        const dto = (
          await api(app, accounting).get(`/v1/settlements/${encodeId('settlement', x.id)}`)
        ).body as Row;
        for (const b of dto.whtEstimate.byRate as Row[])
          if (D(b.whtRate).gt(0)) base = base.add(b.buyBaseAmount);
      }
      expect(D(row['ฐานที่หัก — ผู้รับเหมา (ประมาณการ)']!).toFixed(2)).toBe(base.toFixed(2));
      expect(row['หัก ณ ที่จ่าย — ลูกค้าหักเรา']).toBe('');
      const individual = mine[0]!.carrier.entityType === 'INDIVIDUAL';
      expect(row['แบบยื่น (ประมาณการ)']).toBe(individual ? 'ภ.ง.ด.3' : 'ภ.ง.ด.53');
      expect(row['เลขผู้เสียภาษี / เลขบัตรประชาชน']).toBe(
        individual ? nid : mine[0]!.carrier.taxId,
      );
    }
    expect(sumCol(rows, 'หัก ณ ที่จ่าย — ผู้รับเหมา (ประมาณการ)')).toBe(
      stls.reduce((a, x) => a.add(x.whtAmount!), D(0)).toFixed(2),
    );

    // ฝั่งลูกค้า: Σ payment.wht_amount ของรับชำระ RECORDED (> 0) — กลับรายการไม่นับ · ฐาน/แบบยื่นไม่ได้เก็บ = ว่าง
    const pays = await plat.payment.findMany({
      where: { tenantId, status: 'RECORDED', whtAmount: { gt: 0 } },
    });
    const customerRows = rows.filter((r) => r['ฝั่ง'] === 'ลูกค้าหัก ณ ที่จ่ายเรา');
    expect(customerRows).toHaveLength(1);
    expect(customerRows[0]).toMatchObject({
      รหัสคู่ค้า: 'C-AX1',
      จำนวนเอกสาร: String(pays.length),
      'แบบยื่น (ประมาณการ)': '',
      'ฐานที่หัก — ผู้รับเหมา (ประมาณการ)': '',
      'หัก ณ ที่จ่าย — ผู้รับเหมา (ประมาณการ)': '',
    });
    expect(sumCol(rows, 'หัก ณ ที่จ่าย — ลูกค้าหักเรา')).toBe(
      pays.reduce((a, x) => a.add(x.whtAmount), D(0)).toFixed(2),
    );
    expect(sumCol(rows, 'หัก ณ ที่จ่าย — ลูกค้าหักเรา')).toBe('125.00');
    // ไฟล์มีเลขบัตรเต็ม (บัญชี) → audit
    const audits = await plat.auditLog.findMany({
      where: { tenantId, action: 'export.pii_included', entityId: uuid('job', job.id) },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ resource: 'accounting-wht-summary', count: 1 });

    // summary ตรงกับไฟล์
    const sum = (
      await api(app, accounting)
        .get(`/v1/accounting-exports/summary?dateFrom=${monthFrom}&dateTo=${monthTo}`)
        .expect(200)
    ).body as Row;
    const w = (sum.datasets as Row[]).find((d) => d.dataset === 'wht')!;
    expect(w).toMatchObject({
      resource: 'accounting-wht-summary',
      documents: stls.length + pays.length,
      rows: rows.length,
    });

    // สิทธิ์: อ่านได้เฉพาะใบสำคัญจ่าย = เฉพาะฝั่งผู้รับเหมา · ไม่มีสิทธิ์ราคา = ไม่มีคอลัมน์เงิน
    const so = await tokenFor(tenantId, 'settlements:read export:run prices.buy:read', 'u-so');
    const sr = csvRows((await runExport('accounting-wht-summary', month, so)).file);
    expect(sr.every((r) => r['ฝั่ง'] === 'เราหัก ณ ที่จ่ายผู้รับเหมา')).toBe(true);
    expect(Object.keys(sr[0]!)).not.toContain('หัก ณ ที่จ่าย — ลูกค้าหักเรา');
    const np = parseCsv(
      (await runExport('accounting-wht-summary', month, noPrice)).file.subarray(3).toString('utf8'),
    );
    expect(np[0]!.some((h) => h.startsWith('หัก ณ ที่จ่าย —') || h.startsWith('ฐานที่หัก'))).toBe(
      false,
    );
    await api(app, planner)
      .post('/v1/exports')
      .send({ resource: 'accounting-wht-summary', format: 'csv', filter: month })
      .expect(403);
    // tenant อื่น: ไม่มีแถว
    const o = await runExport('accounting-wht-summary', month, other);
    expect(o.job.rows).toBe(0);
  });

  it('ตัวกรองผิด = 422 ตอนสั่ง (วันที่ / ช่วงกลับด้าน / เกิน 366 วัน / รูปแบบไม่รู้จัก / field แปลก) · audit export.requested', async () => {
    const bad = async (filter: Record<string, string>) => {
      const r = await api(app, accounting)
        .post('/v1/exports')
        .send({ resource: 'accounting-sales', format: 'csv', filter });
      expect(r.status, JSON.stringify(filter)).toBe(422);
    };
    await bad({ dateFrom: '2026-13-01', dateTo: '2026-12-31' });
    await bad({ dateFrom: '2026-11-30', dateTo: '2026-11-01' });
    await bad({ dateFrom: '2025-01-01', dateTo: '2026-12-31' });
    await bad({ ...month, template: 'peak' });
    await bad({ ...month, customerId: 'x' });
    await bad({ dateFrom: monthFrom });
    await api(app, accounting)
      .get(`/v1/accounting-exports/summary?dateFrom=${monthTo}&dateTo=${monthFrom}`)
      .expect(422);
    const audits = await plat.auditLog.findMany({
      where: { tenantId, action: 'export.requested' },
    });
    expect(audits.some((a) => JSON.stringify(a.after).includes('accounting-sales'))).toBe(true);
  });
});
