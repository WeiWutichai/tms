import {
  revenueExportColumns,
  revenuePdfSubtitle,
  revenuePdfTitle,
  revenuePeriodText,
} from '../reports/revenue-export';
import type { RevenueRowDto } from '../reports/revenue-report.dto';
import {
  type AgingExportRow,
  agingExportColumns,
  agingPdfSubtitle,
  agingPdfTitle,
  unbilledExportColumns,
  unbilledPdfSubtitle,
  unbilledPdfTitle,
} from '../reports/receivable-export';
import type { UnbilledDeliveryOrderDto } from '../reports/unbilled-report.dto';
import {
  periodCloseExportColumns,
  periodCloseExportRows,
  periodClosePdfSubtitle,
  periodClosePdfTitle,
} from '../erp/period-close-export';
import type { PeriodCloseReportDto } from '../erp/period-close-report.dto';
import { exportTableDocument } from './export-pdf';

const row = (id: string, label: string | null, n: number, amount: string): RevenueRowDto => ({
  id,
  label,
  detail: null,
  invoiceCount: n,
  deliveryOrderCount: n,
  lineCount: n,
  sellAmount: amount,
});

/** ตัวอย่าง PDF ส่งออก "รายงานรายได้ต่อเส้นทาง" (ST9-T05) — test/pdf-thai.test.ts (KINDS) */
export function sampleRevenueRoutePdf() {
  const rows = [
    row('a', 'คลังสินค้าบางนา – ร้านค้าปลีกชลบุรี', 3, '125000.5'),
    row('b', 'โรงงานปูนสระบุรี – ไซต์ก่อสร้างศรีราชา', 2, '48250.00'),
    row('c', 'ท่าเรือแหลมฉบัง – คลังเย็นลาดกระบัง', 1, '1750'),
    row('none', null, 1, '1234.66'),
    row('total', null, 7, '176235.16'),
  ];
  return exportTableDocument(revenueExportColumns('route', true), rows, {
    title: revenuePdfTitle('route'),
    subtitle: revenuePdfSubtitle(revenuePeriodText('2026-10', '2026-11')),
    printedAt: new Date('2026-11-22T02:30:00Z'),
  });
}

/** ตัวอย่าง PDF ส่งออก "DO ยังไม่วางบิล" (D-81 · D68-99) — test/pdf-thai.test.ts (KINDS) */
export function sampleUnbilledPdf() {
  const r = (n: number, days: number, amount: string): UnbilledDeliveryOrderDto =>
    ({
      id: `do_${n}`,
      doNo: `DO-2611-000${n}`,
      doDate: '2026-11-03',
      status: n === 1 ? 'POD_PENDING' : 'UNBILLED',
      podStatus: 'RECEIVED',
      billingStatus: 'UNBILLED',
      customer: { id: 'cus_1', code: 'C-0001', legalName: 'บริษัท ค้าปลีกชลบุรี จำกัด' },
      salesOrder: { id: 'ord_1', soNo: `SO-2611-000${n}` },
      deliveredAt: '2026-11-05T03:00:00.000Z',
      deliveredOn: '2026-11-05',
      daysSinceDelivery: days,
      releasedAt: null,
      sellAmount: amount,
      draftInvoice:
        n === 2
          ? { id: 'inv_1', createdOn: '2026-11-10', addedOn: '2026-11-10', ageDays: 12 }
          : null,
    }) as unknown as UnbilledDeliveryOrderDto;
  return exportTableDocument(
    unbilledExportColumns(true, true),
    [r(1, 17, '125000.5'), r(2, 9, '1750')],
    {
      title: unbilledPdfTitle(),
      subtitle: unbilledPdfSubtitle('7'),
      printedAt: new Date('2026-11-22T02:30:00Z'),
    },
  );
}

/** ตัวอย่าง PDF ส่งออก "ลูกหนี้คงค้าง" (D-81 · D68-99) — test/pdf-thai.test.ts (KINDS) */
export function sampleAgingPdf() {
  const r = (code: string, name: string, b: string[], total: string): AgingExportRow =>
    ({
      id: `cus_${code}`,
      customer: { id: `cus_${code}`, code, legalName: name, taxId: null, branchCode: null },
      count: b.filter((x) => x !== '0.00').length,
      sellOutstanding: total,
      buckets: b.map((v) => ({ count: v === '0.00' ? 0 : 1, sellOutstanding: v })),
    }) as unknown as AgingExportRow;
  return exportTableDocument(
    agingExportColumns(true),
    [
      r(
        'C-0001',
        'บริษัท ค้าปลีกชลบุรี จำกัด',
        ['1000.00', '0.00', '250.50', '0.00', '99.99'],
        '1350.49',
      ),
      r(
        'C-0002',
        'ห้างหุ้นส่วน วัสดุก่อสร้างศรีราชา',
        ['0.00', '48250.00', '0.00', '0.00', '0.00'],
        '48250.00',
      ),
    ],
    {
      title: agingPdfTitle(),
      subtitle: agingPdfSubtitle(),
      printedAt: new Date('2026-11-22T02:30:00Z'),
    },
  );
}

/** ตัวอย่าง PDF ส่งออก "รายงานปิดงวดเชื่อมระบบบัญชี" (ST8-T14) — test/pdf-thai.test.ts (KINDS) */
export function samplePeriodClosePdf() {
  const base = {
    invoiceId: 'ivc_1',
    result: 'MISMATCH',
    lastSeenAt: '2026-11-20T02:00:00.000Z',
  };
  const report: PeriodCloseReportDto = {
    connector: { id: 'con_1', adapterKey: 'krs', displayName: 'KRS' },
    month: '2026-11',
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    asOf: '2026-11-30T17:00:00.000Z',
    monthEnded: true,
    // มีเอกสารยังไม่ส่ง 2 ใบ → ไม่ผ่าน (PO 24 พ.ย. 2569 — #95-b)
    passed: false,
    generatedAt: '2026-12-01T02:30:00.000Z',
    summary: {
      outstanding: 0,
      outstandingMoney: 0,
      outstandingField: 0,
      unverified: 0,
      acknowledged: 1,
      notSent: 2,
      notSentQueued: 1,
      notSentFailed: 1,
    },
    outstanding: [],
    acknowledged: [
      {
        ...base,
        id: 'rcr_1',
        localNumber: 'INV-2611-0001',
        check: 'DOCUMENT',
        code: 'content_mismatch',
        severity: 'MONEY',
        foundAt: '2026-11-10T19:00:00.000Z',
        currentStatus: 'ACKNOWLEDGED',
        closedAt: null,
        sellDifferenceAmount: '-1250.5',
        acknowledgedAt: '2026-11-12T03:15:00.000Z',
        acknowledgedBy: 'u-1',
        acknowledgedByName: 'สมหญิง บัญชีดี',
        ackReason: 'ฝ่ายบัญชีปรับส่วนลดในระบบบัญชีแล้ว ยอมรับส่วนต่าง',
      },
    ],
    notSent: [
      {
        commandId: 'obx_1',
        entityType: 'invoice',
        documentId: 'ivc_2',
        documentNo: 'INV-2611-0007',
        documentDate: '2026-11-28',
        counterpartyName: 'บริษัท ค้าปลีกชลบุรี จำกัด',
        operation: 'PUSH_INVOICE',
        queueTab: 'failed',
        status: 'FAILED_FINAL',
        errorClass: 'PERIOD_CLOSED',
        errorCode: null,
        nextRunAt: null,
        updatedAt: '2026-11-29T03:00:00.000Z',
        sellTotalAmount: '48250.00',
      },
      {
        commandId: 'obx_2',
        entityType: 'settlement',
        documentId: 'stl_1',
        documentNo: 'STL-2611-0003',
        documentDate: '2026-11-30',
        counterpartyName: 'ห้างหุ้นส่วน รถร่วมศรีราชา',
        operation: 'PUSH_SETTLEMENT',
        queueTab: 'queued',
        status: 'PENDING',
        errorClass: null,
        errorCode: null,
        nextRunAt: '2026-12-01T03:00:00.000Z',
        updatedAt: '2026-11-30T09:00:00.000Z',
        buyNetAmount: '1750',
      },
    ],
    truncated: false,
  };
  return exportTableDocument(periodCloseExportColumns(true, true), periodCloseExportRows(report), {
    title: periodClosePdfTitle(),
    subtitle: periodClosePdfSubtitle('2026-11'),
    printedAt: new Date('2026-12-01T02:30:00Z'),
  });
}
