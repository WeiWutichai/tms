import type { T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { money } from '../rate-cards/rateFormat';
import type { ReconcileResult } from './useReconcile';

/**
 * หน้า "คิวเชื่อมระบบบัญชี" ส่วนรายการไม่ตรง (ST8-T12; ต้นแบบ TMS v4 `specErp` + vPanel kind `erp`) — ฟังก์ชันล้วน
 * สถานะของต้นแบบ ← ข้อมูลจริง: ไม่ตรง (เปิด ไม่มีคำขอ/ถูกปฏิเสธ) · รออนุมัติ (ขอส่งทับ) · รอส่งซ้ำ (อนุมัติส่งทับแล้ว รอส่ง/รอรอบเทียบ — รวมที่พักไว้)
 * · ปิดแล้ว (ยอมรับความต่าง / แก้ที่ TMS / รอบถัดไปตรง)
 */
export type RowStatus = 'mm' | 'appr' | 'resend' | 'closed';

export const TABS = ['all', 'mm', 'appr'] as const;
export type Tab = (typeof TABS)[number];
/** ตัวกรองของ API ต่อแท็บ (แท็บ รอส่งซ้ำ / ถูกปฏิเสธ ของต้นแบบ = คิวส่งไม่สำเร็จ ST7-T19 — รอ PO #86) */
export const TAB_QUERY: Record<Tab, Record<string, string>> = {
  all: {},
  mm: { status: 'OPEN', overwriteStatus: 'NONE' },
  appr: { status: 'OPEN', overwriteStatus: 'REQUESTED' },
};

export function rowStatus(x: Pick<ReconcileResult, 'status' | 'overwrite'>): RowStatus {
  if (x.status !== 'OPEN') return 'closed';
  if (x.overwrite?.status === 'REQUESTED') return 'appr';
  if (x.overwrite?.status === 'APPROVED') return 'resend';
  return 'mm';
}
/** ป้ายสถานะ (ข้อความเดียวกับ STATUS_BADGES ของต้นแบบ) */
export const statusKey = (s: RowStatus): MessageKey => `erpq.st.${s}` as MessageKey;

/** เรียง: MONEY ก่อน FIELD (docs/01 §6.5 severity) แล้วใหม่สุดก่อน — ภายในหน้าที่โหลด */
export function bySeverity(a: ReconcileResult, b: ReconcileResult): number {
  const w = (x: ReconcileResult) => (x.severity === 'MONEY' ? 0 : x.severity === 'FIELD' ? 1 : 2);
  return w(a) - w(b) || b.lastSeenAt.localeCompare(a.lastSeenAt);
}

/** ชื่อช่องของ canonical ที่รู้จัก → ป้ายไทย · ไม่รู้จัก = path เดิม */
const FIELD_KEYS: Record<string, MessageKey> = {
  number: 'erpq.f.number',
  issueDate: 'erpq.f.issueDate',
  dueDate: 'erpq.f.dueDate',
  customerPoNo: 'erpq.f.customerPoNo',
  'customer.externalId': 'erpq.f.customerCode',
  'customer.code': 'erpq.f.customerCode',
  'customer.legalName': 'erpq.f.customerName',
  'customer.taxId': 'erpq.f.taxId',
  'customer.branchCode': 'erpq.f.branch',
  'totals.total': 'erpq.f.total',
  'totals.vatAmount': 'erpq.f.vat',
  'totals.subtotalVatable': 'erpq.f.vatBase',
  'totals.subtotalExempt': 'erpq.f.exempt',
  quantity: 'erpq.f.qty',
  unitLabel: 'erpq.f.unit',
  unitPrice: 'erpq.f.unitPrice',
  amount: 'erpq.f.amount',
  description: 'erpq.f.desc',
  vatType: 'erpq.f.vatType',
  accountCode: 'erpq.f.account',
  'deliveryOrder.date': 'erpq.f.doDate',
  'deliveryOrder.number': 'erpq.f.doNo',
  'trip.vehiclePlate': 'erpq.f.plate',
  'trip.driverName': 'erpq.f.driver',
  'trip.carrierName': 'erpq.f.carrier',
  'route.originName': 'erpq.f.origin',
  'route.destinationName': 'erpq.f.dest',
  'serviceItem.externalId': 'erpq.f.item',
  'serviceItem.code': 'erpq.f.item',
};
export function fieldLabel(t: T, path: string, erp: string): string {
  const k = FIELD_KEYS[path];
  return k ? t(k, { erp }) : path;
}

export interface CmpRow {
  key: string;
  f: string;
  tms: string;
  erp: string;
  diff: boolean;
}

/** ค่าที่แสดง: ช่องเงิน = ค่า `sell*` (สิทธิ์ราคาขาย — ไม่มีสิทธิ์ = "—") · ว่าง = "—" */
function shown(
  d: {
    local: string | null;
    remote: string | null;
    sellLocalValue?: string | null;
    sellRemoteValue?: string | null;
  },
  side: 'local' | 'remote',
): string {
  const sell = side === 'local' ? d.sellLocalValue : d.sellRemoteValue;
  if (sell !== undefined && sell !== null) return money(sell);
  const v = d[side];
  return v === null || v === undefined || v === '' ? '—' : v;
}

/**
 * แถวตาราง "เทียบข้อมูล TMS กับ {ERP}" (ต้นแบบ `cmp`: ฟิลด์ | TMS | ERP | ต่าง/ตรง) จากส่วนต่างที่ API เก็บ
 * จำนวนรายการแสดงเสมอ (ตรง = เครื่องหมาย "ตรง") · รายการที่หาย/เกินระบุเลขรายการ + เลข DO (docs/01 §6.5 "ชี้ได้ว่ารายการไหนต่าง")
 */
export function compareRows(t: T, x: ReconcileResult, erp: string): CmpRow[] {
  const out: CmpRow[] = [];
  const d = x.documentDiff;
  if (x.code === 'remote_missing')
    out.push({
      key: 'missing',
      f: t('erpq.f.document', { erp }),
      tms: x.localNumber ?? '—',
      erp: t('erpq.v.notFound'),
      diff: true,
    });
  for (const r of x.refMismatches ?? [])
    out.push({
      key: `ref:${r.externalId}`,
      f: t('erpq.f.ref', { id: r.externalId }),
      tms: r.expectedRef,
      erp: r.actualRef ?? '—',
      diff: true,
    });
  if (!d) return out;
  if (d.lineCount)
    out.push({
      key: 'count',
      f: t('erpq.f.lineCount'),
      tms: String(d.lineCount.local),
      erp: String(d.lineCount.remote),
      diff: d.lineCount.local !== d.lineCount.remote,
    });
  for (const h of d.header)
    out.push({
      key: `h:${h.field}`,
      f: fieldLabel(t, h.field, erp),
      tms: shown(h, 'local'),
      erp: shown(h, 'remote'),
      diff: true,
    });
  for (const s of d.total)
    out.push({
      key: `t:${s.field}`,
      f: fieldLabel(t, s.field, erp),
      tms: shown(s, 'local'),
      erp: shown(s, 'remote'),
      diff: true,
    });
  const line = (n: number | null, no: string | null) =>
    t('erpq.f.line', { n: n ?? '—', do: no ?? '—' });
  for (const m of d.missingLines)
    out.push({
      key: `m:${m.lineNo}:${m.deliveryOrderNumber}`,
      f: line(m.lineNo, m.deliveryOrderNumber),
      tms: t('erpq.v.has'),
      erp: t('erpq.v.none'),
      diff: true,
    });
  for (const e of d.extraLines)
    out.push({
      key: `e:${e.lineNo}:${e.deliveryOrderNumber}`,
      f: t('erpq.f.extra', { erp, do: e.deliveryOrderNumber ?? '—' }),
      tms: t('erpq.v.none'),
      erp: t('erpq.v.has'),
      diff: true,
    });
  for (const l of d.lineFields)
    out.push({
      key: `l:${l.lineNo}:${l.deliveryOrderNumber}:${l.field}`,
      f: `${line(l.lineNo, l.deliveryOrderNumber)} · ${fieldLabel(t, l.field, erp)}`,
      tms: shown(l, 'local'),
      erp: shown(l, 'remote'),
      diff: true,
    });
  return out;
}

/** คอลัมน์ "ฟิลด์ที่ต่าง" (ต้นแบบ `diffs.map(d => d[0]).join(', ')`) — ชื่อช่องไม่ซ้ำ */
export function diffFields(t: T, x: ReconcileResult, erp: string): string {
  const names = new Set<string>();
  const d = x.documentDiff;
  if (x.code === 'remote_missing') names.add(t('erpq.f.document', { erp }));
  if (x.refMismatches?.length) names.add(t('erpq.f.refShort'));
  if (d) {
    if (d.lineCount && (d.lineCount.local !== d.lineCount.remote || d.missingLines.length))
      names.add(t('erpq.f.lineCount'));
    if (d.extraLines.length) names.add(t('erpq.f.lineCount'));
    for (const h of [...d.header, ...d.total, ...d.lineFields])
      names.add(fieldLabel(t, h.field, erp));
  }
  return [...names].join(', ') || '—';
}

/** ข้อความแถบแดงของ drawer (ต้นแบบ `x.msg`) */
export function messageOf(t: T, x: ReconcileResult, erp: string): string | null {
  if (x.status !== 'OPEN') return null;
  const st = rowStatus(x);
  if (st === 'appr') return t('erpq.msg.appr');
  if (st === 'resend')
    return t(
      x.overwrite?.commandErrorCode === 'capability_not_implemented'
        ? 'erpq.msg.parked'
        : 'erpq.msg.resend',
      { erp },
    );
  const base =
    x.code === 'remote_missing'
      ? t('erpq.msg.missing', { erp })
      : x.code === 'remote_ref_mismatch'
        ? t('erpq.msg.ref', { erp })
        : x.severity === 'MONEY'
          ? t('erpq.msg.money', { erp })
          : t('erpq.msg.field', { erp });
  return x.documentDiff?.totalSkipped ? `${base} · ${t('erpq.msg.noAmounts', { erp })}` : base;
}
