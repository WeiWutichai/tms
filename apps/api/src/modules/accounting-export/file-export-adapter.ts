import { Injectable } from '@nestjs/common';
import type {
  CanonicalInvoiceLine,
  CanonicalInvoicePayload,
  CanonicalSettlementLine,
  CanonicalSettlementPayload,
} from '../erp/canonical';
import type { ExportColumn } from '../master/export';

/**
 * ส่งออกไฟล์ให้นักบัญชี (ST7-T23; docs/01 §6.1 `FileExportAdapter`, docs/04 G4 "CSV generic", spec/07 §4)
 *
 * "layout กลาง" = canonical payload ชุดเดียวกับที่ส่งเข้า ERP (`canonicalInvoice` / `canonicalSettlement` — ST7-T15/ST8-T16)
 * แตกเป็นแถว: แถว **เอกสาร** 1 แถว (หัว + ยอดรวม) ตามด้วยแถว **รายการ** ต่อบรรทัด (ยอดรวมอยู่เฉพาะแถวเอกสาร →
 * ผลรวมคอลัมน์ในไฟล์ = ผลรวมเอกสาร) · core อ่านข้อมูล + สร้างแถว · adapter กำหนด "รูปแบบไฟล์" (คอลัมน์/หัวคอลัมน์/ค่า)
 *
 * - adapter อยู่ใต้ `src/erp-adapters/<key>/` ลงทะเบียนผ่าน composition root (`src/erp-adapters/index.ts`) — core
 *   หา adapter ผ่าน `FileExportAdapterRegistry` เท่านั้น (lint-adapters)
 * - phase 0 มีรูปแบบ "ทั่วไป" ตัวเดียว (ค่าเริ่มต้น) · รูปแบบนำเข้าของโปรแกรมบัญชีเฉพาะ (Express / PEAK / FlowAccount)
 *   = adapter ใหม่เมื่อได้ template นำเข้าจริง (spec/07 INT-043, O-INT-4)
 * - adapter เป็นฟังก์ชันบริสุทธิ์: ห้ามอ่าน/เขียนฐาน ห้ามเรียกภายนอก · คอลัมน์เงิน **ต้อง**ติด `price: 'sell' | 'buy'`
 *   — core ตัดคอลัมน์ที่ติดป้ายเมื่อผู้สั่งไม่มี `prices.sell:read` / `prices.buy:read` (`dropUnpricedColumns`) ·
 *   contract test render ด้วยสิทธิ์ {sell:false,buy:false} แล้วตรวจว่าไม่มีค่าเงินหลุด
 */

/**
 * ชุดข้อมูล (ต้นแบบ TMS v4 `vXp` SETS) — `wht` = สรุปหัก ณ ที่จ่าย**ประมาณการ**ต่อคู่ค้า (D-73 PO 22 พ.ย. 2569 —
 * ไม่ใช่แบบ ภ.ง.ด. / หนังสือรับรอง 50 ทวิ ซึ่งออกที่ระบบบัญชี D-54/D-58)
 */
export const ACCOUNTING_DATASETS = ['sales', 'receipts', 'settlements', 'wht'] as const;
export type AccountingDataset = (typeof ACCOUNTING_DATASETS)[number];

export type AccountingRowLevel = 'document' | 'line';

/**
 * D-73 เอกสารที่ยกเลิก/กลับรายการ — แถวเอกสาร 1 แถว (ไม่มีแถวรายการ) ยอดตามที่ออกอยู่ในคอลัมน์ "…ที่ยกเลิก/กลับรายการ (ไม่นับรวม)"
 * แยกจากคอลัมน์ยอดปกติ → ผลรวมคอลัมน์ยอดปกติ = ยอดเอกสารที่ยังใช้ (ตรงรายงาน) · ผลรวมคอลัมน์ยกเลิก = ยอดที่ยกเลิก
 */
export interface AccountingCancellation {
  /** วันที่ยกเลิก/กลับรายการ (เวลาไทย YYYY-MM-DD) */
  date: string | null;
  reason: string | null;
}

/** แถวของชุด "รายการขาย" — ใบแจ้งหนี้ที่ออกแล้ว (ISSUED_INVOICE_STATUSES) + ใบที่ออกในงวดแล้วยกเลิก (D-73) */
export interface AccountingSalesRow {
  /** id สาธารณะของใบแจ้งหนี้ (ทุกแถวของใบเดียวกันใช้ค่าเดียวกัน — cursor ของงานส่งออก) */
  id: string;
  level: AccountingRowLevel;
  doc: CanonicalInvoicePayload;
  /** null = แถวเอกสาร */
  line: CanonicalInvoiceLine | null;
  /** สถานะใบ ณ ตอนส่งออก (ISSUED / PARTIALLY_PAID / PAID / ADJUSTED · ยกเลิก = CANCELLED / VOIDED) */
  status: string;
  /** D-73: ใบที่ยกเลิกแล้ว (null = ใบที่ยังใช้ — นับในยอดรวม) */
  cancelled: AccountingCancellation | null;
  /** ชื่อนิติบุคคลผู้ออก */
  issuerName: string | null;
  /** ใบนี้ออกแทนใบเลขที่ (ยกเลิกแล้วออกใหม่ — ST5-T10) */
  replacesNumber: string | null;
}

/** การรับชำระ 1 ครั้ง (บัญชีเบา: บันทึกเงิน/เช็คใน TMS ไม่ออกใบเสร็จ — D-56) — เงินเป็นสตริงทศนิยม 2 ตำแหน่ง */
export interface AccountingPayment {
  id: string;
  number: string;
  receivedDate: string;
  customer: { code: string; legalName: string };
  method: string;
  reference: string | null;
  cheque: {
    number: string | null;
    bank: string | null;
    date: string | null;
    status: string | null;
  };
  whtCertificateNo: string | null;
  amountReceived: string;
  whtAmount: string;
  feeAmount: string;
  differenceAmount: string;
  differenceReason: string | null;
  /** ยอดตัดหนี้รวม (= Σ allocations.amount) */
  allocatedTotal: string;
}

export interface AccountingPaymentAllocation {
  lineNo: number;
  invoiceNumber: string | null;
  amount: string;
  whtAmount: string;
}

/** แถวของชุด "รับชำระ" — การรับชำระที่ยังไม่กลับรายการ + ที่กลับรายการแล้ว (D-73 — แถวเอกสารอย่างเดียว) */
export interface AccountingReceiptRow {
  id: string;
  level: AccountingRowLevel;
  payment: AccountingPayment;
  allocation: AccountingPaymentAllocation | null;
  /** RECORDED / REVERSED */
  status: string;
  /** D-73: กลับรายการแล้ว (null = ยังใช้ — นับในยอดรวม) */
  reversed: AccountingCancellation | null;
}

/** แถวของชุด "จ่ายรถร่วม" — ใบสำคัญจ่ายที่บันทึกจ่ายแล้ว (PAID) */
export interface AccountingSettlementRow {
  id: string;
  level: AccountingRowLevel;
  doc: CanonicalSettlementPayload;
  line: CanonicalSettlementLine | null;
  /** ชื่อนิติบุคคลผู้จ่าย */
  payerName: string | null;
  /**
   * เลขผู้เสียภาษีที่แสดง: นิติบุคคล = เลขเต็ม · บุคคลธรรมดา = เลขบัตรประชาชน**เต็มเฉพาะผู้มีสิทธิ์** `pii.national_id:read`
   * (ไม่ใช่ API key — D-73) ไม่งั้น `•••• 1234` · core เป็นผู้ตัดสิน (adapter ไม่เห็นเลขเต็มถ้าไม่มีสิทธิ์)
   */
  carrierTaxId: string | null;
  /** แถวนี้มีเลขบัตรประชาชนเต็ม (นับลง audit `export.pii_included`) */
  piiIncluded: boolean;
}

/** D-73 ป้ายในไฟล์สรุป WHT (ทุกรูปแบบไฟล์ต้องแสดง — ชื่อไฟล์ติด "ประมาณการ" ด้วย) */
export const ACCOUNTING_WHT_ESTIMATE_NOTE = 'ประมาณการ — ไม่ใช่แบบ ภ.ง.ด. / หนังสือรับรอง 50 ทวิ';

/** ฝั่งของสรุปหัก ณ ที่จ่าย: เราหักผู้รับเหมา (ใบสำคัญจ่าย PAID) / ลูกค้าหักเรา (รับชำระ RECORDED) */
export type AccountingWhtSide = 'carrier' | 'customer';

/**
 * แถวของชุด "สรุปหัก ณ ที่จ่าย (ประมาณการ)" (D-73) — 1 แถวต่อ (ฝั่ง, คู่ค้า) · **รวมเฉพาะค่าที่บันทึกไว้** (ไม่คำนวณภาษีใหม่)
 * - ผู้รับเหมา: `whtAmount` = Σ `carrier_settlement.wht_amount` (ตรึงตอนอนุมัติ) ของใบ PAID ที่จ่ายในงวดและ > 0 ·
 *   `baseAmount` = Σ ฐานของอัตรา > 0 จากผลประมาณการ ST6-T08 ชุดเดียวกับ canonical/ERP (`whtEstimate.byRate`) ·
 *   `forms` = แบบที่ ST6-T08 จัดไว้ (PND3/PND53)
 * - ลูกค้า: `whtAmount` = Σ `payment.wht_amount` ของรับชำระ RECORDED ในงวดและ > 0 · ฐาน/แบบยื่นของฝั่งลูกค้าไม่ได้เก็บในระบบ = null
 *   ([OPEN] spec/12 §3 แถว ST7-T23)
 */
export interface AccountingWhtRow {
  id: string;
  side: AccountingWhtSide;
  code: string | null;
  name: string;
  entityType: 'INDIVIDUAL' | 'JURISTIC' | null;
  /** กติกาเดียวกับ `AccountingSettlementRow.carrierTaxId` (ลูกค้า = เลขผู้เสียภาษีของลูกค้า) */
  taxId: string | null;
  branchCode: string | null;
  /** PND3 / PND53 (ไม่ซ้ำ เรียงตามตัวอักษร) — ลูกค้า = [] */
  forms: string[];
  documents: number;
  baseAmount: string | null;
  whtAmount: string;
  piiIncluded: boolean;
}

export interface AccountingRowOf {
  sales: AccountingSalesRow;
  receipts: AccountingReceiptRow;
  settlements: AccountingSettlementRow;
  wht: AccountingWhtRow;
}

/** สิทธิ์เห็นเงินของผู้สั่ง — ขาย (`prices.sell:read`) ใช้กับรายการขาย/รับชำระ · ซื้อ (`prices.buy:read`) ใช้กับจ่ายรถร่วม */
export interface FileExportMoneyAccess {
  sell: boolean;
  buy: boolean;
}

export interface FileExportAdapter {
  /** a-z0-9- (1–40) — ค่าของ `filter.template` */
  readonly key: string;
  readonly displayName: string;
  /** รูปแบบที่ใช้เมื่อไม่ระบุ template (มีได้ตัวเดียว) */
  readonly isDefault?: boolean;
  readonly datasets: readonly AccountingDataset[];
  columns<D extends AccountingDataset>(
    dataset: D,
    money: FileExportMoneyAccess,
  ): ExportColumn<AccountingRowOf[D]>[];
}

const KEY_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** ตรวจรูปของ adapter (ตอนลงทะเบียน + contract test) — ว่าง = ผ่าน */
export function fileExportAdapterProblems(a: FileExportAdapter): string[] {
  const out: string[] = [];
  if (!KEY_RE.test(a.key)) out.push(`key '${a.key}' must match ${KEY_RE}`);
  if (!a.displayName?.trim()) out.push('displayName required');
  if (!a.datasets?.length) out.push('datasets required');
  for (const d of a.datasets ?? [])
    if (!(ACCOUNTING_DATASETS as readonly string[]).includes(d))
      out.push(`unknown dataset '${String(d)}'`);
  if (typeof a.columns !== 'function') out.push('columns() required');
  return out;
}

@Injectable()
export class FileExportAdapterRegistry {
  private readonly adapters = new Map<string, FileExportAdapter>();

  register(a: FileExportAdapter): void {
    const problems = fileExportAdapterProblems(a);
    if (problems.length) throw new Error(`file export adapter '${a.key}': ${problems.join('; ')}`);
    if (this.adapters.has(a.key))
      throw new Error(`file export adapter '${a.key}' already registered`);
    if (a.isDefault && this.default())
      throw new Error(`file export adapter '${a.key}': default already registered`);
    this.adapters.set(a.key, a);
  }

  get(key: string): FileExportAdapter | undefined {
    return this.adapters.get(key);
  }

  default(): FileExportAdapter | undefined {
    return [...this.adapters.values()].find((a) => a.isDefault);
  }

  /** ตาม key ที่ระบุ (ไม่ระบุ = ค่าเริ่มต้น) · ไม่รู้จัก/ไม่รองรับชุดนี้ = undefined */
  resolve(key: string | undefined, dataset: AccountingDataset): FileExportAdapter | undefined {
    const a = key ? this.get(key) : this.default();
    return a && a.datasets.includes(dataset) ? a : undefined;
  }

  list(): FileExportAdapter[] {
    return [...this.adapters.values()];
  }
}
