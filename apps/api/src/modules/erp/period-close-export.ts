import type { ExportColumn } from '../master/export';
import type { PeriodCloseReportDto } from './period-close-report.dto';

/**
 * ST8-T14 คอลัมน์/หัวเอกสารของไฟล์ส่งออก "รายงานปิดงวด" (xlsx / csv / pdf) — ไม่มี import ของ Nest (ใช้ใน test PDF ภาษาไทยได้ตรง)
 * รายงานมี 3 ส่วน → ไฟล์เป็นตารางเดียว คอลัมน์แรก "ส่วน" · แถวแรก = สรุป (id `total` ตัวหนาใน PDF ไม่นับเป็นแถวข้อมูล)
 * ข้อความต้องอยู่ในชุดอักขระ Sarabun (ไม่มี "→" / "≥")
 */
export interface PeriodCloseExportRow {
  id: string;
  section: string;
  documentNo: string | null;
  kind: string | null;
  detail: string | null;
  state: string | null;
  at: string | null;
  closedAt: string | null;
  actor: string | null;
  reason: string | null;
  /** ราคาขาย — ส่วนต่างยอด / ยอดรวมใบแจ้งหนี้ (`prices.sell:read`) */
  sellAmount?: string;
  /** ราคาซื้อ — ยอดสุทธิใบสำคัญจ่าย (`prices.buy:read`) */
  buyNetAmount?: string;
}

const TH_MONTH = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];
const thMonth = (m: string) =>
  `${TH_MONTH[Number(m.slice(5, 7)) - 1]} ${Number(m.slice(0, 4)) + 543}`;

export const periodClosePdfTitle = () => 'รายงานปิดงวดเชื่อมระบบบัญชี';
export const periodClosePdfSubtitle = (month: string) =>
  `งวด ${thMonth(month)} · MISMATCH ค้าง ณ สิ้นเดือน (เวลาไทย) ต้องเป็น 0`;
export const periodCloseFileName = (month: string) => `รายงานปิดงวด_${month}`;

const SEVERITY_TH: Record<string, string> = {
  MONEY: 'ยอดเงิน',
  FIELD: 'ข้อมูลเอกสาร',
  INFO: 'ข้อมูลประกอบ',
};
const CODE_TH: Record<string, string> = {
  content_mismatch: 'เนื้อหาเอกสารไม่ตรงกับระบบบัญชี',
  remote_missing: 'ไม่พบเอกสารในระบบบัญชี',
  remote_ref_mismatch: 'เลขอ้างอิงในระบบบัญชีไม่ตรง',
  erp_unreachable: 'อ่านเอกสารจากระบบบัญชีไม่ได้',
  not_comparable: 'เทียบเอกสารไม่ได้',
};
const STATUS_TH: Record<string, string> = {
  OPEN: 'ยังเปิด',
  ACKNOWLEDGED: 'ยอมรับแล้ว',
  RESOLVED: 'ปิดแล้ว',
};
const TAB_TH: Record<string, string> = { queued: 'รอคิว', failed: 'ล้มเหลว ต้องมีคนทำ' };
const ENTITY_TH: Record<string, string> = { invoice: 'ใบแจ้งหนี้', settlement: 'ใบสำคัญจ่าย' };

const detailOf = (check: string | null, code: string | null) =>
  check === 'PAYMENT_STATUS'
    ? 'ยอดรับชำระไม่ตรงกับระบบบัญชี'
    : ((code && CODE_TH[code]) ?? code ?? null);

/** ISO instant → เวลาไทย "2026-11-30 23:00" (ค.ศ. แบบเดียวกับวันที่ในไฟล์ส่งออกอื่น) */
const bkk = (iso: string | null) =>
  iso
    ? new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
    : null;

/** แปลงรายงานเป็นแถวไฟล์: สรุป → (1) ค้าง → (2) ยอมรับ → (3) ยังไม่ส่ง · `truncated` = ต่อท้ายรายละเอียดสรุปด้วย "(แสดงไม่ครบ)" */
export function periodCloseExportRows(r: PeriodCloseReportDto): PeriodCloseExportRow[] {
  const s = r.summary;
  const name = r.connector.displayName ?? r.connector.adapterKey;
  const verdict = r.passed ? 'ผ่าน' : r.monthEnded ? 'ไม่ผ่าน' : 'เดือนยังไม่จบ';
  const rows: PeriodCloseExportRow[] = [
    {
      id: 'total',
      section: 'สรุป',
      documentNo: null,
      kind: name,
      detail:
        `MISMATCH ค้าง ณ สิ้นเดือน ${s.outstanding} รายการ (ยอดเงิน ${s.outstandingMoney} · ข้อมูลเอกสาร ${s.outstandingField}) · ` +
        `ยอมรับความต่าง ${s.acknowledged} · ยังไม่ถูกส่ง ${s.notSent} (รอคิว ${s.notSentQueued} · ล้มเหลว ${s.notSentFailed}) · ` +
        `ยังไม่ได้ยืนยัน ${s.unverified}` +
        // review: รายการถูกตัดที่เพดาน (ตัวนับครบ) — บอกในไฟล์ด้วย
        (r.truncated ? ' (แสดงไม่ครบ)' : ''),
      state: verdict,
      at: bkk(r.asOf),
      closedAt: null,
      actor: null,
      reason: null,
    },
  ];
  for (const m of r.outstanding)
    rows.push({
      id: m.id,
      section: 'MISMATCH ค้าง ณ สิ้นเดือน',
      documentNo: m.localNumber,
      kind: SEVERITY_TH[m.severity] ?? m.severity,
      detail: detailOf(m.check, m.code),
      state: STATUS_TH[m.currentStatus] ?? m.currentStatus,
      at: bkk(m.foundAt),
      closedAt: bkk(m.closedAt),
      actor: null,
      reason: null,
      ...(m.sellDifferenceAmount !== undefined ? { sellAmount: m.sellDifferenceAmount } : {}),
    });
  for (const a of r.acknowledged)
    rows.push({
      id: a.id,
      section: 'ยอมรับความต่าง',
      documentNo: a.localNumber,
      kind: SEVERITY_TH[a.severity] ?? a.severity,
      detail: detailOf(a.check, a.code),
      state: STATUS_TH[a.currentStatus] ?? a.currentStatus,
      at: bkk(a.foundAt),
      closedAt: bkk(a.acknowledgedAt),
      actor: a.acknowledgedByName ?? a.acknowledgedBy,
      reason: a.ackReason,
      ...(a.sellDifferenceAmount !== undefined ? { sellAmount: a.sellDifferenceAmount } : {}),
    });
  for (const u of r.notSent)
    rows.push({
      id: u.commandId,
      section: 'ยังไม่ถูกส่ง',
      documentNo: u.documentNo,
      kind: ENTITY_TH[u.entityType] ?? u.entityType,
      detail: [u.counterpartyName, u.errorCode ?? u.errorClass].filter(Boolean).join(' · ') || null,
      state: TAB_TH[u.queueTab] ?? u.queueTab,
      at: u.documentDate,
      closedAt: null,
      actor: null,
      reason: null,
      ...(u.sellTotalAmount !== undefined ? { sellAmount: u.sellTotalAmount } : {}),
      ...(u.buyNetAmount !== undefined ? { buyNetAmount: u.buyNetAmount } : {}),
    });
  return rows;
}

const num = (v: string | undefined) => (v === undefined ? null : Number(v));

/** คอลัมน์ไฟล์ — เงินขายเฉพาะผู้มี `prices.sell:read` · เงินซื้อเฉพาะผู้มี `prices.buy:read` */
export function periodCloseExportColumns(
  sell: boolean,
  buy: boolean,
): ExportColumn<PeriodCloseExportRow>[] {
  const cols: ExportColumn<PeriodCloseExportRow>[] = [
    { header: 'ส่วน', value: (r) => r.section },
    { header: 'เลขเอกสาร', value: (r) => r.documentNo },
    { header: 'ประเภท', value: (r) => r.kind },
    { header: 'รายละเอียด', value: (r) => r.detail },
    { header: 'สถานะ', value: (r) => r.state },
    { header: 'วันที่พบ / วันที่เอกสาร', value: (r) => r.at },
    { header: 'ปิด / ยอมรับเมื่อ', value: (r) => r.closedAt },
    { header: 'ผู้ยอมรับ', value: (r) => r.actor },
    { header: 'เหตุผล', value: (r) => r.reason },
  ];
  if (sell)
    cols.push({
      header: 'ส่วนต่าง / ยอดใบแจ้งหนี้',
      value: (r) => num(r.sellAmount),
      price: 'sell',
      money: true,
      raw: (r) => r.sellAmount,
    });
  if (buy)
    cols.push({
      header: 'ยอดใบสำคัญจ่าย',
      value: (r) => num(r.buyNetAmount),
      price: 'buy',
      money: true,
      raw: (r) => r.buyNetAmount,
    });
  return cols;
}
