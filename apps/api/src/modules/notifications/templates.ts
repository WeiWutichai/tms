import { safeName } from '../../common/safe-text';
import { docDate } from '../../pdf/thai-date';

/**
 * ข้อความแจ้งเตือน (ST1-T23) — ไทย/อังกฤษ (D-11: จีนไม่บังคับ → ใช้อังกฤษ)
 * เหตุการณ์ใหม่เพิ่มที่นี่ที่เดียว แล้วโมดูลเจ้าของเรียก `NotificationService.notify()`
 * (ใบค้างใหม่, งานรถร่วมหมดเวลา, เอกสารใกล้หมด ฯลฯ เพิ่มใน stage ของงานนั้น — docs/04 I)
 */
export type NotificationLocale = 'th' | 'en';

export interface NotificationVars {
  /** งานเบื้องหลังเสร็จ (docs/04 I "งานใหญ่ background + แจ้งเมื่อเสร็จ") — label = ชื่องานภาษาไทยจากผู้สร้างงาน */
  'job.succeeded': { label: string };
  'job.failed': { label: string };
  /** ฟีเจอร์ถูกปิด (แพ็กเกจ) หลังสั่งงาน → งานไม่ได้ทำ */
  'job.skipped': { label: string };
  /** ST1-T19 งานนำเข้าไฟล์ใหญ่ (job) — label = ชนิดข้อมูล (ชื่อไฟล์) */
  'import.validated': ImportVars;
  'import.file_failed': ImportVars;
  'import.completed': ImportVars;
  'import.not_imported': ImportVars;
  'import.failed': ImportVars;
  /**
   * ST2-T18 สรุปเตือนวันหมดอายุรายวัน — 1 ฉบับต่อผู้รับต่อวัน (docs/04 I "สรุปรายวัน 08:00")
   * items = รายการที่ถึงระดับเตือนวันนี้ (สูงสุด DIGEST_MAX_ITEMS) · more = ที่เหลือที่ไม่แสดง
   */
  'expiry.digest': { total: number; more: number; items: ExpiryDigestItem[] };
  /**
   * ST5-T22 สรุปเตือนครบกำหนดชำระรายวัน (spec/05 BIL-121; docs/04 I "ครบกำหนดชำระ") — 1 ฉบับต่อผู้รับต่อวัน (ผู้ดูแลลูกค้า / บัญชี)
   * ไม่ใส่ยอดเงิน (สิทธิ์ดูราคาขายแยก — เหมือน field_charge.pending) · items สูงสุด DIGEST_MAX_ITEMS
   */
  'invoice.payment_due': { total: number; more: number; items: PaymentDueItem[] };
  /**
   * ST9-T06 DO ส่งถึงแล้วยังไม่วางบิลเกิน N วัน (docs/04 H "ส่งให้ Invoicer อัตโนมัติ", I "DO ยังไม่วางบิล") — 1 ฉบับต่อผู้รับต่อวัน
   * D-71: ทุกเช้าที่ยังมีใบค้าง · fresh = เพิ่งเกินเกณฑ์วันนี้ · outstanding = ค้างเกินเกณฑ์ทั้งหมด ณ วันนี้ ·
   * staleDrafts = อยู่ในร่างใบแจ้งหนี้ค้างเกิน N วัน · items = DO ที่เพิ่งเกินวันนี้สูงสุด DIGEST_MAX_ITEMS · ไม่ใส่ยอดเงิน
   */
  'delivery_order.unbilled': {
    /** หน้าที่ลิงก์ไป: `report` = รายงาน DO ยังไม่วางบิล · `bill` = หน้าวางบิล (แพ็กเกจไม่มีโมดูลรายงาน — review M1) */
    target: 'report' | 'bill';
    minDays: number;
    fresh: number;
    outstanding: number;
    staleDrafts: number;
    more: number;
    items: UnbilledDoItem[];
  };
  /** ST3-T24 รถร่วมไม่ตอบข้อเสนองานใน N ชม. (docs/04 D3/I "งานรถร่วมหมดเวลา") — ครั้งเดียวต่อข้อเสนอ */
  'subcon_offer.no_response': { tripNo: string; carrier: string; hours: number };
  /** ST3-T24 ลิงก์ข้อเสนองานหมดอายุ (48 ชม.) → เที่ยวกลับไปรอจัดรถ ใบสั่งค้าง "รถร่วมปฏิเสธ" */
  'subcon_offer.expired': { tripNo: string; carrier: string };
  /** ST7-T04 webhook endpoint ถูกปิดอัตโนมัติ (event ล้มเหลวติดกัน 50 รายการ — docs/04 G1) · label = คำอธิบาย/รหัส endpoint (ไม่ใส่ URL — safeName) */
  'webhook.auto_disabled': { label: string; failures: number };
  /** ST9-T08 ใบสั่งงานเข้าใบค้าง (docs/04 I "ใบค้างใหม่") · reason = ข้อความเหตุค้าง (reason code ภาษาไทย) */
  'order.held': { orderNo: string; customer: string; reasonCode: string; reason: string };
  /** ST9-T08 ใบค้างจากงานทีละมาก (นำเข้าไฟล์ / ดึงจาก connector) รวมฉบับเดียว · orderNos = ตัวอย่างไม่เกิน 5 · reasons = "รหัส จำนวน, …" */
  'order.held_batch': { count: number; orderNos: string[]; reasons: string };
  /**
   * ST8-T05 ต้นทาง (ERP connector) ยกเลิกใบสั่งที่มีใบส่งของ (DO) แล้ว — TMS ไม่ยกเลิกเอง (docs/01 A.4 "มี DO แล้ว → แจ้งเตือนแทน")
   * source = ป้ายที่มา (เช่น `ERP:krs`)
   */
  'order.source_cancelled': { orderNo: string; customer: string; source: string };
  /** ST9-T08 รถร่วมปฏิเสธงาน → ใบค้าง CARRIER_REJECTED (event รถร่วมปฏิเสธหรือหมดเวลา) · note = เหตุผลที่รถร่วมให้ */
  'subcon_offer.rejected': { orderNo: string; customer: string; note: string };
  /** ST9-T08 ค่าใช้จ่ายหน้างานรอยืนยัน (docs/04 I "ขออนุมัติ"; ST4-T13) — ไม่ใส่ยอดเงิน (สิทธิ์เห็นราคาแยกฝั่ง) */
  'field_charge.pending': { tripNo: string; item: string; side: 'SELL' | 'BUY' | 'BOTH' };
  /** ST6-T06 ใบสำคัญจ่ายรถร่วมมีรายการโต้แย้ง (docs/04 I "dispute") · ref = เลขใบ/งวด · count = รายการโต้แย้งค้าง — ไม่ใส่ยอดเงิน */
  'settlement.disputed': { carrier: string; ref: string; count: number };
  /** ST9-T08 connector หยุดทำงาน (status ERROR — docs/04 I "connector ล่ม") · label = รหัส adapter · code = รหัสปัญหา */
  'connector.error': { label: string; code: string };
  /**
   * D-81 · D68-61 รอบกระทบยอดกับระบบบัญชีพบส่วนต่างใหม่ (docs/01 §6.5 MISMATCH severity MONEY → หัวหน้าบัญชีทันที)
   * label = รหัส adapter · count = ส่วนต่างใหม่ในรอบ · invoiceNos = ตัวอย่างเลขใบไม่เกิน 5 · ไม่ใส่ยอดเงิน (สิทธิ์ดูราคาขายแยก)
   */
  'reconcile.mismatch_found': { label: string; count: number; invoiceNos: string[] };
  /** ST8-T03 connector กลับมาทำงานเอง (ปลายทางตอบอีกครั้ง — ERROR → ACTIVE โดยระบบ) */
  'connector.recovered': { label: string };
  /**
   * D-81 · D68-57 เอกสารไม่ถูกส่งเข้าระบบบัญชี (docs/01 §6.3 "แจ้งบัญชี") · label = ชื่อระบบบัญชี · รวมกลุ่มต่อ (connector, รหัส) ใน 1 ชม. ·
   * outcome = FAILED_FINAL (ส่งไม่สำเร็จ ระบบไม่ลองเองอีก) / SKIPPED (ไม่ส่ง — ต้องทำในระบบบัญชีเอง) · code = รหัสปัญหา · ไม่ใส่ยอดเงิน
   */
  'connector.document_not_sent': {
    label: string;
    /** connector id (public) — ใช้จัดกลุ่ม (review M1) */
    connectorId: string;
    /** ตัวอย่างเลขเอกสาร ไม่เกิน 5 (ใบล่าสุดท้ายสุด) */
    documentNos: string[];
    /** จำนวนเอกสารในกลุ่ม (รวมที่ไม่อยู่ในตัวอย่าง) */
    count: number;
    outcome: 'FAILED_FINAL' | 'SKIPPED';
    code: string;
    /** ErrorClass ของคำสั่ง — AMBIGUOUS = อาจถึงระบบบัญชีแล้ว (review M2) */
    errorClass: string | null;
  };
  /**
   * ST7-T20 ทีม Innovera เปลี่ยน connector จาก Platform Console (แบบเดียวกับแจ้ง owner ตอนเข้าใช้งานแทน — docs/04 A6)
   * action = created / credentials / resumed / paused / error / recovered · reason = เหตุผลของทีมงาน (safeName)
   */
  'connector.platform_changed': {
    label: string;
    action: 'created' | 'credentials' | 'resumed' | 'paused' | 'error' | 'recovered';
    reason: string;
  };
  /**
   * ST9-T08 สรุปรายวัน 08:00 (docs/04 I) — อีเมลฉบับเดียวต่อผู้ใช้ต่อวัน: แจ้งเตือนในกระดิ่งช่วง 24 ชม. ก่อนหน้า แยกตาม event
   * groups[].titles = หัวข้อล่าสุดไม่เกิน DIGEST_TITLES ต่อกลุ่ม · unread = ที่ยังไม่อ่านในช่วงนี้
   */
  'daily.digest': { day: string; total: number; unread: number; groups: DailyDigestGroup[] };
  /** ST9-T10 ไฟล์ส่งออกตามตัวกรองพร้อมดาวน์โหลด (job) — label = ชื่อรายการ, days = อายุลิงก์ไฟล์ */
  'export.ready': { label: string; rows: number; days: number };
  /** ST9-T10 ส่งออกไม่สำเร็จ — reason = too_many_rows / permission_denied / failed */
  'export.failed': { label: string; reason: string; max: number };
}
export interface DailyDigestGroup {
  /** NotificationEvent หรือ 'other' */
  event: string;
  count: number;
  titles: string[];
}
/** D68-57 คำแนะนำต่อรหัสปัญหาของเอกสารที่ไม่ถูกส่งเข้าระบบบัญชี (ไม่มี = ข้อความตามผล) */
const DOC_NOT_SENT_HINT_TH: Readonly<Record<string, string>> = {
  erp_mapping_incomplete: 'จับคู่รหัสค่าบริการกับระบบบัญชีให้ครบแล้วส่งใหม่',
  erp_master_code_unknown: 'ซิงก์/แก้รหัสในผังรหัสระบบบัญชีแล้วส่งใหม่',
  void_manual_required: 'เอกสารถูกยกเลิกใน TMS — ยกเลิกในระบบบัญชีเอง',
  connector_disconnected: 'ยกเลิกการเชื่อมต่อแล้ว — บันทึกเอกสารนี้ในระบบบัญชีเอง',
  capability_not_supported: 'ระบบบัญชีนี้ไม่รองรับเอกสารชนิดนี้ — บันทึกในระบบบัญชีเอง',
};
const DOC_NOT_SENT_HINT_EN: Readonly<Record<string, string>> = {
  erp_mapping_incomplete: 'map the service items to accounting codes, then resend.',
  erp_master_code_unknown: 'sync or fix the accounting master codes, then resend.',
  void_manual_required: 'it was cancelled in TMS — cancel it in the accounting system manually.',
  connector_disconnected:
    'the connection was removed — record it in the accounting system manually.',
  capability_not_supported:
    'this accounting system does not accept this document type — record it manually.',
};
/** review M2: AMBIGUOUS (timeout หลังส่ง / lease หมดครั้งสุดท้าย) — เอกสารอาจถึงระบบบัญชีแล้ว */
const DOC_NOT_SENT_AMBIGUOUS_TH = 'อาจถึงระบบบัญชีแล้ว — ตรวจในระบบบัญชีก่อนส่งใหม่หรือบันทึกเอง';
const DOC_NOT_SENT_AMBIGUOUS_EN =
  'it may have reached the accounting system — check there before resending or recording it manually.';
/** เลขเอกสารในข้อความ: 1 ใบ = เลข · หลายใบ = "N ใบ (ตัวอย่าง …)" */
function docList(
  v: { documentNos: string[]; count: number },
  lang: NotificationLocale = 'th',
): string {
  const sample = v.documentNos.map((x) => safeName(x, 60)).join(', ');
  if (v.count <= 1) return sample || '-';
  const more = v.count > v.documentNos.length ? ' …' : '';
  const head = lang === 'th' ? `เอกสาร ${n(v.count)} ใบ` : `${n(v.count)} document(s)`;
  return sample ? `${head} (${sample}${more})` : head;
}
/** ชื่อ event ในสรุปรายวัน (ไทยตรงกับหน้าตั้งค่า — apps/web i18n `noti.ev.*`) */
const EVENT_NAME: Record<string, Record<NotificationLocale, string>> = {
  'order.on_hold': { th: 'ใบค้างใหม่', en: 'New on-hold orders' },
  'subcon.no_response': { th: 'รถร่วมไม่ตอบรับหรือหมดเวลา', en: 'Carrier offers not answered' },
  dispute: { th: 'รถร่วมโต้แย้งยอด (dispute)', en: 'Disputes' },
  'approval.requested': { th: 'รายการรออนุมัติ', en: 'Approval requests' },
  'document.expiring': {
    th: 'เอกสารรถ / ใบขับขี่ / rate card ใกล้หมดอายุ',
    en: 'Expiring documents / licences / rate cards',
  },
  'connector.down': { th: 'การเชื่อมต่อขัดข้อง', en: 'Connector / webhook down' },
  'reconcile.mismatch': {
    th: 'ข้อมูลไม่ตรงกับระบบบัญชี',
    en: 'Mismatches with the accounting system',
  },
  'delivery_order.unbilled': { th: 'DO ยังไม่วางบิล', en: 'Unbilled delivery orders' },
  'payment.due': { th: 'ครบกำหนดชำระ', en: 'Payments due' },
  other: { th: 'อื่น ๆ', en: 'Other' },
};
function renderDaily(v: NotificationVars['daily.digest'], lang: NotificationLocale) {
  const lines: string[] = [];
  for (const g of v.groups) {
    const name = (EVENT_NAME[g.event] ?? EVENT_NAME.other!)[lang];
    lines.push(`${name} (${n(g.count)}):`);
    for (const t of g.titles) lines.push(`• ${safeName(t, 200)}`);
    if (g.count > g.titles.length)
      lines.push(
        lang === 'th'
          ? `และอีก ${n(g.count - g.titles.length)} รายการ`
          : `and ${n(g.count - g.titles.length)} more`,
      );
  }
  const head = v.groups
    .map((g) => `${(EVENT_NAME[g.event] ?? EVENT_NAME.other!)[lang]} ${n(g.count)}`)
    .join(' · ');
  return lang === 'th'
    ? {
        title: `สรุปแจ้งเตือนประจำวัน ${thDay(v.day)}`,
        body: `แจ้งเตือน ${n(v.total)} รายการใน 24 ชม. ที่ผ่านมา${v.unread ? ` (ยังไม่อ่าน ${n(v.unread)})` : ''} — ${head}`,
        detail: lines.join('\n'),
      }
    : {
        title: `Daily notification summary ${v.day}`,
        body: `${n(v.total)} notifications in the last 24 hours${v.unread ? ` (${n(v.unread)} unread)` : ''} — ${head}`,
        detail: lines.join('\n'),
      };
}
const SIDE_TH = { SELL: 'ฝั่งขาย', BUY: 'ฝั่งซื้อ', BOTH: 'ฝั่งขายและฝั่งซื้อ' } as const;
const SIDE_EN = { SELL: 'sell side', BUY: 'buy side', BOTH: 'sell and buy side' } as const;
export type ExpiryLevel = 'D60' | 'D30' | 'D7' | 'EXPIRED';
export interface ExpiryDigestItem {
  kind: 'VEHICLE_DOCUMENT' | 'DRIVER_LICENCE' | 'RATE_CARD';
  level: ExpiryLevel;
  /** YYYY-MM-DD */
  expiresOn: string;
  /** วันหมด − วันนี้ (ติดลบ = หมดไปแล้ว) */
  days: number;
  /** ทะเบียนรถ / ชื่อคนขับ (รหัส) / รหัส rate (ลูกค้าหรือผู้รับเหมา · ต้นทาง → ปลายทาง) */
  label: string;
  docType?: string;
  title?: string | null;
  side?: 'SELL' | 'BUY';
}
export type PaymentDueLevelName = 'DUE_IN_3' | 'DUE_TODAY' | 'OVERDUE_7' | 'OVERDUE_30';
export interface PaymentDueItem {
  level: PaymentDueLevelName;
  invoiceNo: string;
  customer: string;
  /** YYYY-MM-DD */
  dueDate: string;
  /** วันนี้ − วันครบกำหนด (ติดลบ = ยังไม่ถึง) */
  days: number;
}
export interface UnbilledDoItem {
  doNo: string;
  customer: string;
  /** วันที่ส่งถึง YYYY-MM-DD (เวลาไทย) */
  deliveredOn: string;
  /** วันนี้ − วันที่ส่งถึง */
  days: number;
}
interface ImportVars {
  label: string;
  ok: number;
  bad: number;
  imported: number;
  reason: string;
}
const n = (x: number) => x.toLocaleString('en-US');

/** ชื่อประเภทเอกสารรถ (ไทยตรงกับต้นแบบ/T17) */
const VEHICLE_DOC_NAME: Record<string, { th: string; en: string }> = {
  INSURANCE: { th: 'ประกันภัย', en: 'Insurance' },
  COMPULSORY_ACT: { th: 'พ.ร.บ.', en: 'Compulsory insurance (CMI)' },
  ANNUAL_TAX: { th: 'ภาษี', en: 'Annual road tax' },
  INSPECTION: { th: 'ตรวจสภาพ ตรอ.', en: 'Vehicle inspection' },
  TRANSPORT_LICENSE: { th: 'ใบอนุญาตขนส่ง', en: 'Transport licence' },
  GPS_DLT_CERT: { th: 'GPS DLT', en: 'GPS DLT certificate' },
  OTHER: { th: 'เอกสารอื่น', en: 'Other document' },
};
const thDay = (d: string) => docDate(new Date(`${d}T00:00:00+07:00`), 'BE');
/** ลำดับกลุ่มในสรุป: หมดแล้วก่อน แล้วใกล้สุด */
const LEVEL_ORDER: ExpiryLevel[] = ['EXPIRED', 'D7', 'D30', 'D60'];
const LEVEL_HEAD: Record<ExpiryLevel, Record<NotificationLocale, string>> = {
  EXPIRED: { th: 'หมดอายุแล้ว', en: 'Expired' },
  D7: { th: 'เหลือไม่เกิน 7 วัน', en: 'Within 7 days' },
  D30: { th: 'เหลือไม่เกิน 30 วัน', en: 'Within 30 days' },
  D60: { th: 'เหลือไม่เกิน 60 วัน', en: 'Within 60 days' },
};
const KIND_NAME: Record<ExpiryDigestItem['kind'], Record<NotificationLocale, string>> = {
  VEHICLE_DOCUMENT: { th: 'เอกสารรถ', en: 'vehicle documents' },
  DRIVER_LICENCE: { th: 'ใบขับขี่', en: 'driving licences' },
  RATE_CARD: { th: 'rate card', en: 'rate cards' },
};
function itemLine(i: ExpiryDigestItem, lang: NotificationLocale): string {
  const label = safeName(i.label, 160);
  const what =
    i.kind === 'VEHICLE_DOCUMENT'
      ? lang === 'th'
        ? `${i.docType === 'OTHER' && i.title ? safeName(i.title, 80) : (VEHICLE_DOC_NAME[i.docType ?? '']?.th ?? i.docType)} ของรถ ${label}`
        : `${i.docType === 'OTHER' && i.title ? safeName(i.title, 80) : (VEHICLE_DOC_NAME[i.docType ?? '']?.en ?? i.docType)} — vehicle ${label}`
      : i.kind === 'DRIVER_LICENCE'
        ? lang === 'th'
          ? `ใบขับขี่ ${label}`
          : `Driving licence — ${label}`
        : lang === 'th'
          ? `Rate card ${i.side === 'BUY' ? 'ขาซื้อ' : 'ขาขาย'} ${label}`
          : `${i.side === 'BUY' ? 'Buy' : 'Sell'} rate card ${label}`;
  const when =
    lang === 'th'
      ? i.days < 0
        ? `หมดเมื่อ ${thDay(i.expiresOn)}`
        : i.days === 0
          ? `หมดวันนี้ ${thDay(i.expiresOn)}`
          : `หมด ${thDay(i.expiresOn)} (อีก ${n(i.days)} วัน)`
      : i.days < 0
        ? `expired ${i.expiresOn}`
        : i.days === 0
          ? `expires today ${i.expiresOn}`
          : `expires ${i.expiresOn} (in ${n(i.days)} days)`;
  return `• ${what} — ${when}`;
}
/** สรุปสั้น (กระดิ่ง) + รายการเต็มเป็นกลุ่มตามระดับ (อีเมล) */
function renderDigest(v: NotificationVars['expiry.digest'], lang: NotificationLocale) {
  const kinds = [...new Set(v.items.map((i) => i.kind))].map((k) => KIND_NAME[k][lang]);
  const counts = LEVEL_ORDER.map((l) => [l, v.items.filter((i) => i.level === l).length] as const)
    .filter(([, c]) => c > 0)
    .map(([l, c]) => `${LEVEL_HEAD[l][lang]} ${n(c)}`);
  const lines: string[] = [];
  for (const l of LEVEL_ORDER) {
    const g = v.items.filter((i) => i.level === l);
    if (!g.length) continue;
    lines.push(`${LEVEL_HEAD[l][lang]}:`, ...g.map((i) => itemLine(i, lang)));
  }
  if (v.more > 0)
    lines.push(lang === 'th' ? `และอีก ${n(v.more)} รายการ` : `and ${n(v.more)} more`);
  return lang === 'th'
    ? {
        title: `${kinds.join(' / ')} ใกล้หมดอายุ ${n(v.total)} รายการ`,
        body: `${counts.join(' · ')}${v.more > 0 ? ` (แสดง ${n(v.items.length)} จาก ${n(v.total)})` : ''} — เปิดดูรายการและต่ออายุในระบบ`,
        detail: lines.join('\n'),
      }
    : {
        title: `${n(v.total)} expiring ${kinds.join(' / ')}`,
        body: `${counts.join(' · ')} — open TMS to review and renew.`,
        detail: lines.join('\n'),
      };
}
/** ลำดับกลุ่มในสรุปเตือนครบกำหนด: เกินนานสุดก่อน */
const DUE_ORDER: PaymentDueLevelName[] = ['OVERDUE_30', 'OVERDUE_7', 'DUE_TODAY', 'DUE_IN_3'];
const DUE_HEAD: Record<PaymentDueLevelName, Record<NotificationLocale, string>> = {
  OVERDUE_30: { th: 'เกินกำหนด 30 วันขึ้นไป', en: '30+ days overdue' },
  OVERDUE_7: { th: 'เกินกำหนด 7 วันขึ้นไป', en: '7+ days overdue' },
  DUE_TODAY: { th: 'ถึงวันครบกำหนด', en: 'Due' },
  DUE_IN_3: { th: 'ครบกำหนดภายใน 3 วัน', en: 'Due within 3 days' },
};
function dueLine(i: PaymentDueItem, lang: NotificationLocale): string {
  const what = `${safeName(i.invoiceNo, 60)} · ${safeName(i.customer, 120)}`;
  const when =
    lang === 'th'
      ? i.days < 0
        ? `ครบกำหนด ${thDay(i.dueDate)} (อีก ${n(-i.days)} วัน)`
        : i.days === 0
          ? `ครบกำหนดวันนี้ ${thDay(i.dueDate)}`
          : `ครบกำหนด ${thDay(i.dueDate)} (เกิน ${n(i.days)} วัน)`
      : i.days < 0
        ? `due ${i.dueDate} (in ${n(-i.days)} days)`
        : i.days === 0
          ? `due today ${i.dueDate}`
          : `due ${i.dueDate} (${n(i.days)} days overdue)`;
  return `• ${what} — ${when}`;
}
function renderPaymentDue(v: NotificationVars['invoice.payment_due'], lang: NotificationLocale) {
  const counts = DUE_ORDER.map((l) => [l, v.items.filter((i) => i.level === l).length] as const)
    .filter(([, c]) => c > 0)
    .map(([l, c]) => `${DUE_HEAD[l][lang]} ${n(c)}`);
  const lines: string[] = [];
  for (const l of DUE_ORDER) {
    const g = v.items.filter((i) => i.level === l);
    if (!g.length) continue;
    lines.push(`${DUE_HEAD[l][lang]}:`, ...g.map((i) => dueLine(i, lang)));
  }
  if (v.more > 0) lines.push(lang === 'th' ? `และอีก ${n(v.more)} ใบ` : `and ${n(v.more)} more`);
  return lang === 'th'
    ? {
        title: `ใบแจ้งหนี้ครบกำหนดชำระ ${n(v.total)} ใบ`,
        body: `${counts.join(' · ')}${v.more > 0 ? ` (แสดง ${n(v.items.length)} จาก ${n(v.total)})` : ''} — ติดตามและบันทึกรับชำระที่หน้ารับชำระ`,
        detail: lines.join('\n'),
      }
    : {
        title: `${n(v.total)} invoice(s) due for payment`,
        body: `${counts.join(' · ')} — follow up on the Payments page.`,
        detail: lines.join('\n'),
      };
}
function renderUnbilled(v: NotificationVars['delivery_order.unbilled'], lang: NotificationLocale) {
  const lines = v.items.map((i) =>
    lang === 'th'
      ? `• ${safeName(i.doNo, 60)} · ${safeName(i.customer, 120)} — ส่งถึง ${thDay(i.deliveredOn)} (${n(i.days)} วัน)`
      : `• ${safeName(i.doNo, 60)} · ${safeName(i.customer, 120)} — delivered ${i.deliveredOn} (${n(i.days)} days)`,
  );
  if (lines.length) lines.unshift(lang === 'th' ? 'เพิ่งเกินเกณฑ์วันนี้:' : 'Crossed today:');
  if (v.more > 0) lines.push(lang === 'th' ? `และอีก ${n(v.more)} ใบ` : `and ${n(v.more)} more`);
  const drafts = v.staleDrafts > 0;
  const onlyDrafts = drafts && v.outstanding === 0;
  // review L5: มีร่างค้าง → ชวนตรวจ/ออกเอกสารร่าง (ไม่ใช่แค่ดึง DO) · แพ็กเกจไม่มีรายงาน (/bill) ก็บอกเรื่องร่าง
  const where = onlyDrafts
    ? {
        th: 'ตรวจและออกเอกสารใบแจ้งหนี้ร่างที่หน้า วางบิลและใบแจ้งหนี้',
        en: 'review and issue the draft invoices on the Billing page.',
      }
    : v.target === 'report'
      ? drafts
        ? {
            th: 'ดูที่ รายงาน → DO ยังไม่วางบิล แล้วดึงเข้าใบแจ้งหนี้และออกเอกสารร่างที่ค้างที่หน้าวางบิล',
            en: 'see Reports → Unbilled DOs, then bill them and issue the pending drafts.',
          }
        : {
            th: 'ดูที่ รายงาน → DO ยังไม่วางบิล แล้วดึงเข้าใบแจ้งหนี้ที่หน้าวางบิล',
            en: 'see Reports → Unbilled DOs.',
          }
      : drafts
        ? {
            th: 'ดึงเข้าใบแจ้งหนี้และออกเอกสารร่างที่ค้างที่หน้า วางบิลและใบแจ้งหนี้',
            en: 'add them to an invoice and issue the pending drafts on the Billing page.',
          }
        : {
            th: 'ดึงเข้าใบแจ้งหนี้ที่หน้า วางบิลและใบแจ้งหนี้',
            en: 'add them to an invoice on the Billing page.',
          };
  const draftTh = `อยู่ในร่างใบแจ้งหนี้ค้างเกิน ${n(v.minDays)} วัน ${n(v.staleDrafts)} ใบ`;
  const draftEn = `${n(v.staleDrafts)} sitting in draft invoices over ${n(v.minDays)} days`;
  if (onlyDrafts)
    return lang === 'th'
      ? {
          title: `ร่างใบแจ้งหนี้ค้างเกิน ${n(v.minDays)} วัน ${n(v.staleDrafts)} ใบ`,
          body: `${draftTh} — ${where.th}`,
          detail: lines.join('\n'),
        }
      : {
          title: `${n(v.staleDrafts)} delivery order(s) in drafts over ${n(v.minDays)} days`,
          body: `${draftEn} — ${where.en}`,
          detail: lines.join('\n'),
        };
  // D-71: แยก "เพิ่งเกินวันนี้" / "ค้างทั้งหมด" (+ "อยู่ในร่าง…ค้างเกิน N วัน" เมื่อมี)
  const th = [`เพิ่งเกินวันนี้ ${n(v.fresh)} ใบ`, `ค้างทั้งหมด ${n(v.outstanding)} ใบ`];
  const en = [`${n(v.fresh)} crossed today`, `${n(v.outstanding)} outstanding`];
  if (drafts) {
    th.push(draftTh);
    en.push(draftEn);
  }
  return lang === 'th'
    ? {
        title: `DO ยังไม่วางบิลเกิน ${n(v.minDays)} วัน`,
        body: `${th.join(' · ')} — ${where.th}`,
        detail: lines.join('\n'),
      }
    : {
        title: `Delivery orders not billed after ${n(v.minDays)} days`,
        body: `${en.join(' · ')} — ${where.en}`,
        detail: lines.join('\n'),
      };
}
export type NotificationTemplate = keyof NotificationVars;

export interface RenderedNotification {
  title: string;
  /** ข้อความสั้น (กระดิ่ง + ย่อหน้าแรกของอีเมล) */
  body: string;
  /** รายละเอียดเพิ่มเฉพาะอีเมล (หลายบรรทัด) — เช่น รายการในสรุปเตือนวันหมดอายุ */
  detail?: string;
}

type Renderer<K extends NotificationTemplate> = (v: NotificationVars[K]) => RenderedNotification;

const TEMPLATES: {
  [K in NotificationTemplate]: Record<NotificationLocale, Renderer<K>>;
} = {
  'job.succeeded': {
    th: ({ label }) => ({ title: 'งานเสร็จแล้ว', body: `${label} เสร็จเรียบร้อย` }),
    en: ({ label }) => ({ title: 'Job finished', body: `${label} has finished.` }),
  },
  'job.failed': {
    th: ({ label }) => ({
      title: 'งานไม่สำเร็จ',
      body: `${label} ไม่สำเร็จ ลองใหม่ครบจำนวนครั้งแล้ว`,
    }),
    en: ({ label }) => ({
      title: 'Job failed',
      body: `${label} failed after all retries.`,
    }),
  },
  'job.skipped': {
    th: ({ label }) => ({
      title: 'งานไม่ได้ทำ',
      body: `${label} ไม่ได้ทำ เพราะแพ็กเกจปัจจุบันไม่รวมฟีเจอร์นี้`,
    }),
    en: ({ label }) => ({
      title: 'Job not run',
      body: `${label} was not run because the current plan does not include this feature.`,
    }),
  },
  'import.validated': {
    th: (v) => ({
      title: 'ตรวจไฟล์นำเข้าเสร็จแล้ว',
      body: `${v.label}: ผ่าน ${n(v.ok)} แถว ผิด ${n(v.bad)} แถว — เปิดเพื่อยืนยันนำเข้า`,
    }),
    en: (v) => ({
      title: 'Import file checked',
      body: `${v.label}: ${n(v.ok)} valid, ${n(v.bad)} invalid rows — open to confirm the import.`,
    }),
  },
  'import.file_failed': {
    th: (v) => ({ title: 'ไฟล์นำเข้าใช้ไม่ได้', body: `${v.label}: ${v.reason}` }),
    en: (v) => ({ title: 'Import file rejected', body: `${v.label}: ${v.reason}` }),
  },
  'import.completed': {
    th: (v) => ({
      title: 'นำเข้าเสร็จแล้ว',
      body: `${v.label}: นำเข้า ${n(v.imported)} แถว${v.bad ? ` ข้ามแถวที่ผิด ${n(v.bad)} แถว` : ''}`,
    }),
    en: (v) => ({
      title: 'Import finished',
      body: `${v.label}: ${n(v.imported)} rows imported${v.bad ? `, ${n(v.bad)} invalid rows skipped` : ''}.`,
    }),
  },
  'import.not_imported': {
    th: (v) => ({
      title: 'ยังไม่ได้นำเข้า',
      body: `${v.label}: ตรวจซ้ำพบแถวที่ผิด ${n(v.bad)} แถว ไม่มีข้อมูลถูกนำเข้า — แก้ไฟล์หรือเลือกนำเข้าเฉพาะแถวที่ผ่าน`,
    }),
    en: (v) => ({
      title: 'Nothing imported',
      body: `${v.label}: re-check found ${n(v.bad)} invalid rows, nothing was imported.`,
    }),
  },
  'import.failed': {
    th: (v) => ({
      title: 'นำเข้าไม่สำเร็จ',
      body: `${v.label}: ระบบขัดข้อง ไม่มีข้อมูลถูกนำเข้า — ลองอัปโหลดใหม่`,
    }),
    en: (v) => ({
      title: 'Import failed',
      body: `${v.label}: system error, nothing was imported.`,
    }),
  },
  'expiry.digest': {
    th: (v) => renderDigest(v, 'th'),
    en: (v) => renderDigest(v, 'en'),
  },
  'invoice.payment_due': {
    th: (v) => renderPaymentDue(v, 'th'),
    en: (v) => renderPaymentDue(v, 'en'),
  },
  'delivery_order.unbilled': {
    th: (v) => renderUnbilled(v, 'th'),
    en: (v) => renderUnbilled(v, 'en'),
  },
  'subcon_offer.no_response': {
    th: (v) => ({
      title: 'รถร่วมยังไม่ตอบรับงาน',
      body: `${v.tripNo} · ${v.carrier} ไม่ตอบรับใน ${n(v.hours)} ชม. — ส่งรายถัดไปได้ที่เที่ยวรถ`,
    }),
    en: (v) => ({
      title: 'Carrier has not responded',
      body: `${v.tripNo} · ${v.carrier} has not responded within ${n(v.hours)} h — send to the next carrier from the trip.`,
    }),
  },
  'export.ready': {
    th: (v) => ({
      title: 'ไฟล์ส่งออกพร้อมแล้ว',
      body: `ส่งออก${v.label} ${n(v.rows)} รายการเสร็จแล้ว — กดลิงก์เพื่อดาวน์โหลด (ใช้ได้ ${v.days} วัน)`,
    }),
    en: (v) => ({
      title: 'Your export is ready',
      body: `${v.label}: ${n(v.rows)} rows exported — open the link to download (valid for ${v.days} days).`,
    }),
  },
  'export.failed': {
    th: (v) => ({
      title: 'ส่งออกไม่สำเร็จ',
      body:
        v.reason === 'too_many_rows'
          ? `ส่งออก${v.label}ไม่สำเร็จ เพราะเกิน ${n(v.max)} รายการ — กรองให้แคบลงแล้วส่งออกใหม่`
          : v.reason === 'permission_denied'
            ? `ส่งออก${v.label}ไม่สำเร็จ เพราะไม่มีสิทธิ์แล้ว`
            : `ส่งออก${v.label}ไม่สำเร็จ — ลองส่งออกใหม่อีกครั้ง`,
    }),
    en: (v) => ({
      title: 'Export failed',
      body:
        v.reason === 'too_many_rows'
          ? `${v.label} export failed: more than ${n(v.max)} rows — narrow the filter and try again.`
          : v.reason === 'permission_denied'
            ? `${v.label} export failed: you no longer have permission.`
            : `${v.label} export failed — please try again.`,
    }),
  },
  'webhook.auto_disabled': {
    th: (v) => ({
      title: 'Webhook ถูกปิดอัตโนมัติ',
      body: `${v.label} ส่ง event ไม่สำเร็จติดกัน ${n(v.failures)} รายการ — ระบบหยุดส่งแล้ว ตรวจปลายทางแล้วเปิดใช้อีกครั้งที่ ตั้งค่า → นักพัฒนา / Open API → Webhooks`,
    }),
    en: (v) => ({
      title: 'Webhook endpoint auto-disabled',
      body: `${v.label} failed ${n(v.failures)} events in a row — delivery has stopped. Fix the receiver, then re-enable it in Settings → Developer / Open API → Webhooks.`,
    }),
  },
  'order.held': {
    th: (v) => ({
      title: 'ใบค้างใหม่',
      body: `${v.orderNo} · ${v.customer} — ${v.reason} · เคลียร์ได้ที่หน้าใบค้าง`,
    }),
    en: (v) => ({
      title: 'New on-hold order',
      body: `${v.orderNo} · ${v.customer} — on hold (${v.reasonCode}). Resolve it on the on-hold page.`,
    }),
  },
  'order.held_batch': {
    th: (v) => ({
      title: `ใบค้างใหม่ ${n(v.count)} ใบ`,
      body: `${v.orderNos.map((x) => safeName(x, 40)).join(', ')}${v.count > v.orderNos.length ? ` และอีก ${n(v.count - v.orderNos.length)} ใบ` : ''} (${v.reasons}) — เคลียร์ได้ที่หน้าใบค้าง`,
    }),
    en: (v) => ({
      title: `${n(v.count)} new on-hold orders`,
      body: `${v.orderNos.map((x) => safeName(x, 40)).join(', ')}${v.count > v.orderNos.length ? ` and ${n(v.count - v.orderNos.length)} more` : ''} (${v.reasons}). Resolve them on the on-hold page.`,
    }),
  },
  'order.source_cancelled': {
    th: (v) => ({
      title: 'ต้นทางยกเลิกใบสั่งที่มี DO แล้ว',
      body: `${v.orderNo} · ${v.customer} — ${safeName(v.source, 40)} ยกเลิกใบสั่งนี้ แต่มีใบส่งของ (DO) แล้ว ระบบจึงไม่ยกเลิกให้ · ตรวจสอบแล้วถอดออกจากเที่ยวหรือยกเลิกเอง`,
    }),
    en: (v) => ({
      title: 'Source cancelled an order that already has DOs',
      body: `${v.orderNo} · ${v.customer} — ${safeName(v.source, 40)} cancelled this order, but it already has delivery orders so it was not cancelled automatically. Review it and unassign or cancel it yourself.`,
    }),
  },
  'subcon_offer.rejected': {
    th: (v) => ({
      title: 'รถร่วมปฏิเสธงาน',
      body: `${v.orderNo} · ${v.customer} — ${v.note} · ใบสั่งกลับเข้าใบค้าง จัดรถหรือเสนอรายใหม่ได้`,
    }),
    en: (v) => ({
      title: 'Carrier rejected the job',
      body: `${v.orderNo} · ${v.customer} — ${v.note}. The order is back on hold; assign or offer it again.`,
    }),
  },
  'field_charge.pending': {
    th: (v) => ({
      title: 'ค่าใช้จ่ายหน้างานรออนุมัติ',
      body: `${v.tripNo} · ${v.item} (${SIDE_TH[v.side]}) — รอยืนยันที่เที่ยวรถ`,
    }),
    en: (v) => ({
      title: 'Field charge awaiting approval',
      body: `${v.tripNo} · ${v.item} (${SIDE_EN[v.side]}) — confirm or reject it on the trip.`,
    }),
  },
  'settlement.disputed': {
    th: (v) => ({
      title: 'ใบสำคัญจ่ายรถร่วมมีรายการโต้แย้ง',
      body: `${safeName(v.carrier, 80)} · ${safeName(v.ref, 60)} — โต้แย้ง ${n(v.count)} รายการ · อนุมัติไม่ได้จนกว่าจะยืนยันยอดเดิมหรือแก้รายการ`,
    }),
    en: (v) => ({
      title: 'Carrier settlement disputed',
      body: `${safeName(v.carrier, 80)} · ${safeName(v.ref, 60)} — ${n(v.count)} disputed line(s). It cannot be approved until they are resolved or corrected.`,
    }),
  },
  'connector.error': {
    th: (v) => ({
      title: 'การเชื่อมต่อขัดข้อง',
      body: `Connector ${v.label} หยุดทำงาน (${v.code}) — งานที่ต้องส่งพักไว้ ตรวจการเชื่อมต่อแล้วเปิดใช้อีกครั้งที่ ตั้งค่า → การเชื่อมต่อ`,
    }),
    en: (v) => ({
      title: 'Connector down',
      body: `Connector ${v.label} stopped (${v.code}) — outgoing work is parked. Check the connection and resume it in Settings → Connections.`,
    }),
  },
  'connector.recovered': {
    th: (v) => ({
      title: 'การเชื่อมต่อกลับมาทำงานแล้ว',
      body: `Connector ${v.label} ติดต่อปลายทางได้อีกครั้ง — ระบบเปิดใช้และส่งงานที่พักไว้ต่อแล้ว`,
    }),
    en: (v) => ({
      title: 'Connector back online',
      body: `Connector ${v.label} can reach the destination again — it was resumed and parked work is being sent.`,
    }),
  },
  'connector.document_not_sent': {
    th: (v) => ({
      title: 'เอกสารไม่ถูกส่งเข้าระบบบัญชี',
      body: `${docList(v)} ${
        v.outcome === 'SKIPPED' ? 'ไม่ถูกส่งเข้า' : 'ส่งเข้าไม่สำเร็จ —'
      } ${safeName(v.label, 80)} (${safeName(v.code, 60)}) — ${
        (v.errorClass === 'AMBIGUOUS' ? DOC_NOT_SENT_AMBIGUOUS_TH : undefined) ??
        DOC_NOT_SENT_HINT_TH[v.code] ??
        (v.outcome === 'SKIPPED'
          ? 'บันทึกเอกสารนี้ในระบบบัญชีเอง'
          : 'ระบบไม่ลองส่งเองอีก ตรวจสาเหตุแล้วส่งใหม่ หรือบันทึกในระบบบัญชีเอง')
      }`,
    }),
    en: (v) => ({
      title: 'Document not sent to the accounting system',
      body: `${docList(v, 'en')} ${
        v.outcome === 'SKIPPED' ? 'was not sent to' : 'could not be sent to'
      } ${safeName(v.label, 80)} (${safeName(v.code, 60)}) — ${
        (v.errorClass === 'AMBIGUOUS' ? DOC_NOT_SENT_AMBIGUOUS_EN : undefined) ??
        DOC_NOT_SENT_HINT_EN[v.code] ??
        (v.outcome === 'SKIPPED'
          ? 'record it in the accounting system manually.'
          : 'it will not be retried automatically; fix the cause and resend, or record it manually.')
      }`,
    }),
  },
  'reconcile.mismatch_found': {
    th: (v) => ({
      title: 'ข้อมูลไม่ตรงกับระบบบัญชี',
      body: `Connector ${v.label} พบยอดรับชำระไม่ตรงกับระบบบัญชี ${n(v.count)} ใบ${
        v.invoiceNos.length
          ? ` (${v.invoiceNos.map((x) => safeName(x, 40)).join(', ')}${v.count > v.invoiceNos.length ? ' …' : ''})`
          : ''
      } — ระบบไม่ปรับยอดใน TMS เอง ตรวจแล้วแก้ที่ต้นเหตุ`,
    }),
    en: (v) => ({
      title: 'Mismatch with the accounting system',
      body: `Connector ${v.label} found ${n(v.count)} invoice(s) whose payments differ from the accounting system${
        v.invoiceNos.length
          ? ` (${v.invoiceNos.map((x) => safeName(x, 40)).join(', ')}${v.count > v.invoiceNos.length ? ' …' : ''})`
          : ''
      } — TMS does not adjust them automatically; fix the cause.`,
    }),
  },
  'connector.platform_changed': {
    th: (v) => ({
      title: 'ทีม Innovera เปลี่ยนการเชื่อมต่อระบบบัญชี',
      body: `${
        {
          created: 'เปิด connector',
          credentials: 'เปลี่ยน key ของ',
          resumed: 'เปิดใช้',
          paused: 'หยุดชั่วคราว',
          error: 'ทดสอบไม่ผ่าน — หยุด',
          recovered: 'ทดสอบผ่าน — เปิดใช้ต่อ',
        }[v.action]
      } ${v.label} · เหตุผล: ${v.reason} — ดูประวัติที่ ตั้งค่า → การเชื่อมต่อ`,
    }),
    en: (v) => ({
      title: 'Innovera changed your accounting connector',
      body: `${
        {
          created: 'Enabled connector',
          credentials: 'Rotated the key of',
          resumed: 'Resumed',
          paused: 'Paused',
          error: 'Health check failed — stopped',
          recovered: 'Health check passed — resumed',
        }[v.action]
      } ${v.label} · reason: ${v.reason} — see the history in Settings → Connections.`,
    }),
  },
  'daily.digest': {
    th: (v) => renderDaily(v, 'th'),
    en: (v) => renderDaily(v, 'en'),
  },
  'subcon_offer.expired': {
    th: (v) => ({
      title: 'ข้อเสนองานรถร่วมหมดเวลา',
      body: `${v.tripNo} · ${v.carrier} ไม่ตอบรับภายใน 48 ชม. — เที่ยวกลับไปรอจัดรถ`,
    }),
    en: (v) => ({
      title: 'Carrier offer expired',
      body: `${v.tripNo} · ${v.carrier} did not respond within 48 h — the trip is back in planning.`,
    }),
  },
};

export function isNotificationTemplate(t: string): t is NotificationTemplate {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, t);
}

export function renderNotification<K extends NotificationTemplate>(
  template: K,
  locale: string,
  vars: NotificationVars[K],
): RenderedNotification {
  const lang: NotificationLocale = locale === 'th' ? 'th' : 'en';
  // ค่าจากผู้ใช้ (เช่น ชื่อไฟล์ใน label) ลงในอีเมลด้วย — ตัด URL/โดเมนและจำกัดความยาว (เหมือนคำเชิญ T07)
  const clean = Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [k, typeof v === 'string' ? safeName(v, 200) : v]),
  ) as NotificationVars[K];
  return (TEMPLATES[template][lang] as Renderer<K>)(clean);
}
