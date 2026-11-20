import { createHash } from 'node:crypto';
import { canonicalJson } from '../integration/outbox.service';
import type { CanonicalDocument } from './erp-adapter';

/**
 * Canonical payload ของเอกสารที่ส่งเข้า ERP (ST8-T16 — ส่วนย่อยของ ST7-T15; docs/01 §7.1–7.3)
 * core สร้างชุดเดียวต่อเอกสาร (ไม่ผูก ERP ใด) แล้ว adapter map ไปฟิลด์ของตัวเองแบบ whitelist
 * - เงินเป็นสตริงทศนิยม 2 ตำแหน่ง (ห้าม float) · วันที่ `YYYY-MM-DD` (วันตามปฏิทินไทย) · id = uuid ภายใน (ไม่ใช่ id สาธารณะ)
 * - ภาษีเป็น **ประมาณการ** (D-54: เอกสารภาษีออกที่ระบบบัญชี) — `taxEstimated: true` เสมอ
 * - `lines[].serviceItem.id` → ประตู mapping ค่าบริการ ↔ รหัสสินค้า ERP (ST7-T18) ใส่ `externalId` ให้ก่อนถึง adapter
 * - `sync.hash` = sha256 ของ payload (ไม่รวม sync) — เก็บใน `external_mapping.payload_hash`
 */

export interface CanonicalParty {
  /** uuid ภายใน */
  id: string;
  code: string;
  legalName: string;
  /** null = ไม่มีเลขผู้เสียภาษีในเอกสาร (บุคคลธรรมดา — ไม่ส่งเลขบัตรประชาชนออกนอก TMS) */
  taxId: string | null;
  branchCode: string | null;
}

export interface CanonicalInvoiceLine {
  lineNo: number;
  deliveryOrder: { number: string } | null;
  serviceItem: { id: string; externalId?: string | null };
  description: string;
  quantity: string;
  unitLabel: string;
  unitPrice: string;
  discount: string;
  /** หลังส่วนลด ก่อน VAT */
  amount: string;
  vatType: string;
  vatAmount: string;
  /** อัตรา % เช่น "1.00" */
  whtRate: string;
}

export interface CanonicalInvoicePayload extends CanonicalDocument {
  kind: 'invoice';
  /** uuid ภายในของใบแจ้งหนี้ */
  id: string;
  /** invoice_no */
  number: string;
  issueDate: string;
  dueDate: string | null;
  issuer: { companyId: string; branchId: string; branchCode: string | null };
  /** `externalId` = รหัสลูกค้าฝั่ง ERP จาก external_mapping CUSTOMER (ST8-T05 `customerErpCode`) — null = ยังไม่ map */
  customer: CanonicalParty & { externalId: string | null };
  customerPoNo: string | null;
  totals: {
    subtotalVatable: string;
    subtotalExempt: string;
    subtotalZeroRated: string;
    vatAmount: string;
    total: string;
    whtExpected: string;
  };
  taxEstimated: true;
  lines: CanonicalInvoiceLine[];
}

export interface CanonicalSettlementLine {
  lineNo: number;
  lineType: string;
  trip: { number: string } | null;
  description: string;
  /** ยอดของบรรทัด (บรรทัดหัก = ยอดบวกของรายการหัก) */
  amount: string;
  vatType: string | null;
  /** อัตรา % ที่ใช้ประมาณการ (null = บรรทัดหัก) */
  whtRate: string | null;
  whtAmount: string | null;
}

export interface CanonicalSettlementPayload extends CanonicalDocument {
  kind: 'settlement';
  id: string;
  /** settlement_no */
  number: string;
  /** วันที่จ่ายจริง (ST6-T09) */
  paidDate: string;
  payingCompanyId: string | null;
  period: { from: string; to: string };
  carrierInvoiceNumber: string | null;
  carrier: CanonicalParty & { entityType: 'INDIVIDUAL' | 'JURISTIC' };
  payment: { method: string | null; reference: string | null; bank: string | null };
  totals: { gross: string; deduction: string; net: string; wht: string; netAfterWht: string };
  /** WHT ประมาณการ (ST6-T08) — 50 ทวิ ออกที่ระบบบัญชี (D-58) · `pndForm` = PND3 (บุคคล) / PND53 (นิติบุคคล) */
  whtEstimate: {
    pndForm: string;
    byRate: { whtRate: string; base: string; amount: string }[];
    reviewedByAccountant: false;
  };
  taxEstimated: true;
  lines: CanonicalSettlementLine[];
}

/** sha256 ของ payload (ไม่รวม `sync`) แล้วใส่ `sync.hash` */
export function withSyncHash<T extends CanonicalDocument>(doc: T): T {
  const { sync: _drop, ...rest } = doc;
  const hash = createHash('sha256').update(canonicalJson(rest)).digest('hex');
  return { ...rest, sync: { hash } } as T;
}

export function isCanonicalInvoice(d: unknown): d is CanonicalInvoicePayload {
  return !!d && typeof d === 'object' && (d as { kind?: unknown }).kind === 'invoice';
}

export function isCanonicalSettlement(d: unknown): d is CanonicalSettlementPayload {
  return !!d && typeof d === 'object' && (d as { kind?: unknown }).kind === 'settlement';
}
