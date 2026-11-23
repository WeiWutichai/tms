import { scopeAllows } from '@tms/domain';
import { ProblemException } from '../../common/problem';
import type { ExportSpec } from '../exports/export-spec';
import { dropUnpricedColumns, type ExportColumn } from '../master/export';
import { AccountingExportQuery } from './accounting-export.dto';
import {
  ACCOUNTING_DATASET_SCOPE,
  type AccountingExportService,
} from './accounting-export.service';
import type {
  AccountingDataset,
  AccountingRowOf,
  FileExportAdapterRegistry,
} from './file-export-adapter';

/** resource ของ `POST /v1/exports` ต่อชุดข้อมูล */
export const ACCOUNTING_EXPORT_RESOURCE: Record<AccountingDataset, string> = {
  sales: 'accounting-sales',
  receipts: 'accounting-receipts',
  settlements: 'accounting-settlements',
  wht: 'accounting-wht-summary',
};

/**
 * ชื่อชุด (ต้นแบบ TMS v4 `vXp` SETS) — ใช้ในชื่อไฟล์และแจ้งเตือน (เว็บ `xp.file.*` ต้องตรงกัน)
 * `wht` ติด "ประมาณการ" ในชื่อไฟล์ (D-73: ไม่ใช่แบบ ภ.ง.ด. / หนังสือรับรอง 50 ทวิ)
 */
export const ACCOUNTING_FILE_LABEL: Record<AccountingDataset, string> = {
  sales: 'รายการขาย',
  receipts: 'รับชำระ',
  settlements: 'จ่ายรถร่วม',
  wht: 'หัก ณ ที่จ่าย-ประมาณการ',
};
const LABEL = ACCOUNTING_FILE_LABEL;

const TH_MONTHS_ABBR = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * ป้ายงวดในชื่อไฟล์ (ต้นแบบ `x.per.replace(/\s|\(|\)/g, '')`): เต็มเดือน "ต.ค.2569" · เต็มไตรมาส "ไตรมาส4-2569"
 * · ช่วงอื่น "2026-11-01_2026-11-22" — เว็บใช้กติกาเดียวกัน (`accountingFileName` ของหน้า dialog)
 */
export function accountingPeriodTag(dateFrom: string, dateTo: string): string {
  const [y1, m1, d1] = dateFrom.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = dateTo.split('-').map(Number) as [number, number, number];
  if (d1 === 1 && y1 === y2 && d2 === lastDay(y2, m2)) {
    if (m1 === m2) return `${TH_MONTHS_ABBR[m1 - 1]}${y1 + 543}`;
    if (m1 % 3 === 1 && m2 === m1 + 2) return `ไตรมาส${(m1 + 2) / 3}-${y1 + 543}`;
  }
  return `${dateFrom}_${dateTo}`;
}

/**
 * ส่งออกให้นักบัญชี 4 ชุด (ST7-T23 + สรุป WHT ประมาณการ D-73) เป็น resource ของงานส่งออก ST9-T10 — ได้ job / ไฟล์ .csv (UTF-8 BOM + CRLF + กันสูตร)
 * หรือ .xlsx / ลิงก์ดาวน์โหลด 7 วัน / แจ้งเตือน / audit `export.requested` ชุดเดียวกับทุกการส่งออก
 * คอลัมน์มาจาก `FileExportAdapter` (รูปแบบไฟล์) · คอลัมน์เงินเฉพาะผู้มี `prices.sell:read` (ขาย/รับชำระ) / `prices.buy:read` (จ่ายรถร่วม)
 * · เลขบัตรประชาชนเต็มของรถร่วมบุคคล (D-73) ตัดสินที่ core (`nationalIdAllowed`) + audit `export.pii_included` ต่อไฟล์ (`pii`)
 */
export function accountingExportSpecs(
  svc: AccountingExportService,
  adapters: FileExportAdapterRegistry,
): ExportSpec[] {
  const make = <D extends AccountingDataset>(
    dataset: D,
    idKind: ExportSpec['idKind'],
    fetch: ExportSpec<AccountingExportQuery, AccountingRowOf[D]>['fetch'],
    extra: Partial<ExportSpec<AccountingExportQuery, AccountingRowOf[D]>> = {},
  ): ExportSpec<AccountingExportQuery, AccountingRowOf[D]> => ({
    ...extra,
    resource: ACCOUNTING_EXPORT_RESOURCE[dataset],
    label: `${LABEL[dataset]} (ส่งออกให้นักบัญชี)`,
    fileBase: ACCOUNTING_EXPORT_RESOURCE[dataset],
    fileName: (q) => {
      const a = adapters.resolve(q.template, dataset);
      const tag = a && !a.isDefault ? `_${a.displayName}` : '';
      return `${LABEL[dataset]}_${accountingPeriodTag(q.dateFrom, q.dateTo)}${tag}`;
    },
    scope: ACCOUNTING_DATASET_SCOPE[dataset],
    idKind,
    query: AccountingExportQuery,
    fetch,
    columns: (scopes, q): ExportColumn<AccountingRowOf[D]>[] => {
      const a = adapters.resolve(q.template, dataset);
      if (!a) throw new ProblemException('validation_failed');
      const money = {
        sell: scopeAllows(scopes, 'prices.sell:read'),
        buy: scopeAllows(scopes, 'prices.buy:read'),
      };
      // core บังคับซ้ำ: คอลัมน์ที่ติดป้าย price ออกเฉพาะผู้มีสิทธิ์ (adapter กรองผิดก็ไม่รั่ว)
      return dropUnpricedColumns(a.columns(dataset, money), money);
    },
  });
  const pii = { fields: ['carrier.nationalId'] };
  return [
    make('sales', 'invoice', (q, page) => svc.salesRows(q, page)),
    make('receipts', 'payment', (q, page) => svc.receiptRows(q, page)),
    make('settlements', 'settlement', (q, page) => svc.settlementRows(q, page), {
      pii: {
        ...pii,
        count: (rows) => rows.filter((r) => r.level === 'document' && r.piiIncluded).length,
      },
    }),
    // สรุปต่อคู่ค้า: อ่านครั้งเดียวทั้งชุด (แถว = คู่ค้า ไม่ใช่เอกสาร — ไม่ถอด id เป็น cursor)
    make('wht', 'carrier', (q, page) => svc.whtRows(q, page), {
      single: true,
      pii: { ...pii, count: (rows) => rows.filter((r) => r.piiIncluded).length },
    }),
  ];
}
