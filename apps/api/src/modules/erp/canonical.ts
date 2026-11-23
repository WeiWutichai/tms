import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../integration/outbox.service';
import type { SettlementDto } from '../settlements/settlement.dto';
import type { CanonicalDocument, CanonicalPersonalField } from './erp-adapter';

/**
 * Canonical payload ของเอกสารที่ส่งเข้า ERP (ST8-T16 — ส่วนย่อยของ ST7-T15; docs/01 §7.1–7.3)
 * core สร้างชุดเดียวต่อเอกสาร (ไม่ผูก ERP ใด) แล้ว adapter map ไปฟิลด์ของตัวเองแบบ whitelist
 * - เงินเป็นสตริงทศนิยม 2 ตำแหน่ง (ห้าม float) · วันที่ `YYYY-MM-DD` (วันตามปฏิทินไทย) · id = uuid ภายใน (ไม่ใช่ id สาธารณะ)
 * - ภาษีเป็น **ประมาณการ** (D-54: เอกสารภาษีออกที่ระบบบัญชี) — `taxEstimated: true` เสมอ
 * - `lines[].serviceItem.id` → ประตู mapping ค่าบริการ ↔ รหัสสินค้า ERP (ST7-T18) ใส่ `externalId` ให้ก่อนถึง adapter
 * - ST8-T07 เพิ่มช่องของ docs/01 §7.1–7.2 ที่ adapter ตัวแรก (KRS — docs/01 A.3) ต้องใช้: `issuer` ชื่อ/เลขภาษี/ที่อยู่,
 *   `customer.billingAddress` / `paymentTermDays`, `references.customerRef[]`, บรรทัด: DO id/วันที่, `salesOrder`, `trip`, `route`,
 *   `serviceItem.code`, `accountCode` — ทั่วไป ไม่ผูก ERP ใด · **เพิ่มช่อง = `sync.hash` ของใบแจ้งหนี้ทุกใบเปลี่ยน** (spec/12 §3 แถว ST8-T07)
 *   **ไม่ใช่ทุกช่องที่คงที่หลังออกใบ:** `route` (ชื่อสถานที่), `references.customerRef`, `salesOrder` อ่าน**ค่าปัจจุบัน**ของแถว (ไม่มี snapshot ณ วันออก)
 *   → สร้าง canonical ใหม่จากแถวปัจจุบันหลังออกใบอาจได้ hash ต่างจากที่ส่งไป · **เงื่อนไขบังคับของ ST7-T16:** ส่งซ้ำ/แทนที่/reconcile
 *   ต้องใช้ canonical ณ วันออก (เก็บตอน finalize หรือใช้ payload ของคำสั่งล่าสุด) ห้ามสร้างใหม่จากแถวปัจจุบัน
 * - ST8-T07 (PDPA): `trip.driverName` ใส่เฉพาะเมื่อ adapter ของ connector ประกาศ `personalDataNeeds` — ไม่ประกาศ = null
 *   ยังไม่มี: `references.billingNoteNumber` (ใบวางบิลเกิดหลังออกใบ → hash จะเปลี่ยนเองทั้งที่ใบไม่เปลี่ยน) · `taxInvoiceNumber` / `taxPointAt` (D-54)
 * - `sync.hash` = sha256 ของ payload (ไม่รวม sync) — ST7-T15: ก่อนส่ง sink ใส่รหัสฝั่ง ERP ล่าสุด (ลูกค้า/รถร่วม/ค่าบริการ)
 *   แล้วคำนวณใหม่ = hash ของสิ่งที่ส่งจริง → เก็บใน `external_mapping.last_synced_hash` · hash เท่าเดิม = ไม่ส่งซ้ำ (SKIPPED)
 */

export interface CanonicalParty {
  /** uuid ภายใน */
  id: string;
  code: string;
  legalName: string;
  /** null = ไม่มีเลขผู้เสียภาษีในเอกสาร (บุคคลธรรมดา — ไม่ส่งเลขบัตรประชาชน เว้นแต่ adapter ประกาศ `carrier.taxId` → D-80 ใส่ ณ ตอนส่ง) */
  taxId: string | null;
  branchCode: string | null;
}

export interface CanonicalInvoiceLine {
  lineNo: number;
  /** DO ของบรรทัด (null = บรรทัดที่ไม่ผูก DO) — `id` = uuid ภายใน · `date` = วันที่ DO `YYYY-MM-DD` */
  deliveryOrder: { id: string; number: string; date: string } | null;
  /** SO ของ DO — `externalId` = เลขอ้างอิงของต้นทาง (เช่น ERP ที่เป็นต้นทาง SO) */
  salesOrder: { number: string | null; externalId: string | null } | null;
  /** เที่ยวของ DO (ค่าที่ตรึงตอนมอบงาน) — ฟิลด์รถ/คนขับอยู่ที่เที่ยวที่เดียว (docs/01 §7.2) · `driverName` = null เว้นแต่ adapter ประกาศว่าต้องใช้ (PDPA) */
  trip: {
    number: string | null;
    vehiclePlate: string | null;
    driverName: string | null;
    carrierName: string | null;
  } | null;
  /** ชื่อสถานที่ต้นทาง/ปลายทางของ DO — ชื่อปัจจุบันของสถานที่ (ไม่มี snapshot ณ วันออก: เปลี่ยนชื่อสถานที่ภายหลัง = hash เปลี่ยน) */
  route: { originName: string; destinationName: string } | null;
  /** `code` = รหัสค่าบริการของ TMS · `externalId` = รหัสสินค้า/บริการฝั่ง ERP (ประตู mapping ST7-T18 ใส่ก่อนถึง adapter) */
  serviceItem: { id: string; code: string; externalId?: string | null };
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
  /** รหัสบัญชีของบรรทัด (`invoice_line.account_code`) — null = ให้ ERP ใช้ค่าตั้งต้น */
  accountCode: string | null;
}

export interface CanonicalInvoicePayload extends CanonicalDocument {
  kind: 'invoice';
  /** uuid ภายในของใบแจ้งหนี้ */
  id: string;
  /** invoice_no */
  number: string;
  issueDate: string;
  dueDate: string | null;
  /** ผู้ออก ณ วันออก (`issuer_snapshot`) — `address` = ข้อความที่อยู่สาขาผู้ออก (null = ไม่มี snapshot) */
  issuer: {
    companyId: string;
    branchId: string;
    branchCode: string | null;
    legalName: string;
    taxId: string | null;
    address: string | null;
  };
  /**
   * `externalId` = รหัสลูกค้าฝั่ง ERP จาก external_mapping CUSTOMER (ST8-T05 `customerErpCode`) — null = ยังไม่ map
   * `billingAddress` = ที่อยู่วางบิล ณ วันออก (`customer_snapshot.address`) · `paymentTermDays` = เครดิตเทอมของใบ (`credit_term_days`)
   */
  customer: CanonicalParty & {
    externalId: string | null;
    billingAddress: string | null;
    paymentTermDays: number;
  };
  customerPoNo: string | null;
  /** เลขอ้างอิงของลูกค้าจาก DO ในใบ (ไม่ซ้ำ เรียงตามบรรทัด) — docs/01 §7.1 `references` */
  references: { customerRef: string[] };
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
  /**
   * D-81 · D68-81 เลข DO ของบรรทัด (docs/01 §7.3 `lines[].deliveryOrder.number`) — บรรทัดใบสำคัญจ่ายผูกกับเที่ยว (1 เที่ยวมีหลาย DO)
   * จึงเป็นรายการ: ค่าใช้จ่ายหน้างานที่บันทึกคู่กับ DO (DO_SURCHARGE) = DO นั้น · บรรทัดอื่นที่มีเที่ยว = DO ทุกใบของเที่ยวที่ไม่ถูกยกเลิก
   * (เรียงตามเลข) · บรรทัดที่ไม่มีเที่ยว = [] · ใช้กระทบยอดรายบรรทัดกับ DO ฝั่ง AP
   */
  deliveryOrders: { number: string }[];
  description: string;
  /** ยอดของบรรทัด (บรรทัดหัก = ยอดติดลบตามที่เก็บ — CHECK `settlement_line_ref_check`) */
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
  /** `externalId` = รหัสรถร่วมฝั่ง ERP จาก external_mapping CARRIER (ST7-T15 — core ใส่ ณ ตอนส่ง) · ไม่มี/null = ยังไม่ map */
  carrier: CanonicalParty & {
    entityType: 'INDIVIDUAL' | 'JURISTIC';
    externalId?: string | null;
  };
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

/**
 * ST7-T16 กลุ่ม field ของเอกสารที่ส่งแล้ว (docs/04 G3 System-of-record: ราคา / วันที่ / accessorial = auto-sync · ลูกค้า = regenerate)
 * ใช้ตัดสินว่าการเปลี่ยนไปถึงเอกสารฝั่ง ERP แบบไหน (`fieldChangePolicy`) — `OTHER` = ช่องที่ไม่อยู่ในกลุ่มใด (ตัดสินแบบระมัดระวัง = regenerate)
 */
export const SYNC_PARTS = ['CUSTOMER', 'DATES', 'PRICE', 'ACCESSORIAL', 'OTHER'] as const;
export type SyncPart = (typeof SYNC_PARTS)[number];

/** ช่องหัวเอกสารต่อกลุ่ม (ช่องที่ไม่อยู่ในรายการ = OTHER) — `sync` ไม่นับ */
const PART_OF_FIELD: Readonly<Record<string, SyncPart>> = {
  customer: 'CUSTOMER',
  carrier: 'CUSTOMER',
  issueDate: 'DATES',
  dueDate: 'DATES',
  paidDate: 'DATES',
  period: 'DATES',
  totals: 'PRICE',
};
/** ช่องเงิน/ปริมาณของบรรทัด → PRICE · ช่องอื่นของบรรทัด (รายการ/คำอธิบาย/รหัสบริการ/DO) และจำนวนบรรทัด → ACCESSORIAL */
const LINE_PRICE_FIELDS: ReadonlySet<string> = new Set([
  'lineNo',
  'quantity',
  'unitPrice',
  'discount',
  'amount',
  'vatType',
  'vatAmount',
  'whtRate',
  'whtAmount',
]);

/**
 * ST7-T16 hash ต่อกลุ่ม field ของ canonical (ฟังก์ชันบริสุทธิ์) — เก็บใน `external_mapping.last_synced_parts` ตอนส่งสำเร็จ
 * แล้วเทียบตอนส่งใหม่ว่ากลุ่มไหนเปลี่ยน (`changedSyncParts`)
 */
export function syncParts(doc: CanonicalDocument): Record<SyncPart, string> {
  const buckets: Record<SyncPart, Record<string, unknown>> = {
    CUSTOMER: {},
    DATES: {},
    PRICE: {},
    ACCESSORIAL: {},
    OTHER: {},
  };
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'sync' || v === undefined) continue;
    if (k === 'lines' && Array.isArray(v)) {
      buckets.PRICE.lines = v.map((l) =>
        l && typeof l === 'object'
          ? Object.fromEntries(Object.entries(l).filter(([f]) => LINE_PRICE_FIELDS.has(f)))
          : l,
      );
      buckets.ACCESSORIAL.lines = v.map((l) =>
        l && typeof l === 'object'
          ? Object.fromEntries(Object.entries(l).filter(([f]) => !LINE_PRICE_FIELDS.has(f)))
          : l,
      );
      continue;
    }
    buckets[PART_OF_FIELD[k] ?? 'OTHER'][k] = v;
  }
  const out = {} as Record<SyncPart, string>;
  for (const p of SYNC_PARTS)
    out[p] = createHash('sha256').update(canonicalJson(buckets[p])).digest('hex');
  return out;
}

/** กลุ่มที่ต่างจากที่ส่งสำเร็จล่าสุด — ไม่รู้ของเดิม (null / รูปผิด) = ทุกกลุ่ม */
export function changedSyncParts(prior: unknown, next: Record<SyncPart, string>): SyncPart[] {
  const p =
    prior && typeof prior === 'object' && !Array.isArray(prior)
      ? (prior as Record<string, unknown>)
      : null;
  return SYNC_PARTS.filter((k) => !p || p[k] !== next[k]);
}

/**
 * ST7-T16 วันที่ของเอกสารที่ใช้กับประตู `connector.sync_from_date` (docs/01 §6.4 "issue_date ก่อนวันนี้") —
 * ใบแจ้งหนี้ = `issueDate` · ใบสำคัญจ่าย = `paidDate` (ไม่มีวันออกใบ — วันที่ลงบัญชี AP) · ไม่มี = null (ไม่ตัดสิน)
 */
export function documentDate(doc: unknown): string | null {
  const d = doc as { issueDate?: unknown; paidDate?: unknown } | null;
  for (const v of [d?.issueDate, d?.paidDate])
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
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

// ---------- ตัวสร้าง canonical (ST7-T23 แยกจาก ErpSyncService — ชุดเดียวกันทั้งทางส่ง ERP และไฟล์ส่งออกให้นักบัญชี) ----------

const money = (d: Prisma.Decimal | number | string | null | undefined) =>
  new Prisma.Decimal(d ?? 0).toFixed(2);
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** include ที่ `canonicalInvoice` ต้องใช้ (บรรทัดที่ยังนับ เรียงตามลำดับ) */
export const CANONICAL_INVOICE_INCLUDE = {
  customer: { select: { code: true, legalName: true } },
  issuingBranch: { select: { branchCode: true } },
  issuingCompany: { select: { legalName: true, taxId: true } },
  lines: {
    where: { active: true },
    orderBy: { lineNo: 'asc' },
    include: {
      serviceItem: { select: { code: true } },
      deliveryOrder: {
        select: {
          id: true,
          doNo: true,
          doDate: true,
          customerRef: true,
          salesOrder: { select: { soNo: true, externalId: true } },
          trip: {
            select: {
              tripNo: true,
              vehiclePlateSnapshot: true,
              driverNameSnapshot: true,
              carrierNameSnapshot: true,
            },
          },
          originSite: { select: { name: true } },
          destSite: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.InvoiceInclude;

export type InvoiceForCanonical = Prisma.InvoiceGetPayload<{
  include: typeof CANONICAL_INVOICE_INCLUDE;
}>;

/**
 * ใบแจ้งหนี้ที่ออกเลขแล้ว → canonical (ไม่มี I/O) — ข้อมูลลูกค้าจาก snapshot ณ วันออก (BIL-196)
 * `customerExternalId` = รหัสลูกค้าฝั่ง ERP ของ connector (ไม่มี connector / ยังไม่ map = null)
 * `personalData` = ข้อมูลส่วนบุคคลแบบตัวเลือกที่ adapter ของ connector ประกาศว่าต้องใช้ (ไม่ระบุ = ไม่ใส่ — ชื่อคนขับ = null)
 */
export function canonicalInvoice(
  inv: InvoiceForCanonical,
  customerExternalId: string | null,
  personalData: readonly CanonicalPersonalField[] = [],
): CanonicalInvoicePayload {
  const withDriver = personalData.includes('trip.driverName');
  const snap = (inv.customerSnapshot ?? {}) as {
    code?: string;
    name?: string;
    taxId?: string | null;
    branchCode?: string | null;
    address?: string | null;
  };
  const iss = (inv.issuerSnapshot ?? {}) as {
    name?: string;
    taxId?: string | null;
    address?: string | null;
  };
  const customerRef: string[] = [];
  for (const l of inv.lines) {
    const ref = l.deliveryOrder?.customerRef?.trim();
    if (ref && !customerRef.includes(ref)) customerRef.push(ref);
  }
  return withSyncHash({
    kind: 'invoice',
    id: inv.id,
    number: inv.invoiceNo ?? '',
    issueDate: ymd(inv.issueDate)!,
    dueDate: ymd(inv.dueDate),
    issuer: {
      companyId: inv.issuingCompanyId,
      branchId: inv.issuingBranchId,
      branchCode: inv.issuingBranch?.branchCode ?? null,
      legalName: iss.name ?? inv.issuingCompany.legalName,
      taxId: iss.taxId ?? inv.issuingCompany.taxId ?? null,
      address: iss.address ?? null,
    },
    customer: {
      id: inv.customerId,
      code: snap.code ?? inv.customer.code,
      legalName: snap.name ?? inv.customer.legalName,
      taxId: snap.taxId ?? null,
      branchCode: snap.branchCode ?? null,
      externalId: customerExternalId,
      billingAddress: snap.address ?? null,
      paymentTermDays: inv.creditTermDays,
    },
    customerPoNo: inv.customerPoNo,
    references: { customerRef },
    totals: {
      subtotalVatable: money(inv.subtotalVatable),
      subtotalExempt: money(inv.subtotalExempt),
      subtotalZeroRated: money(inv.subtotalZeroRated),
      vatAmount: money(inv.vatAmount),
      total: money(inv.totalAmount),
      whtExpected: money(inv.whtExpectedAmount),
    },
    taxEstimated: true,
    lines: inv.lines.map((l) => {
      const d = l.deliveryOrder?.doNo ? l.deliveryOrder : null;
      return {
        lineNo: l.lineNo,
        deliveryOrder: d ? { id: d.id, number: d.doNo!, date: ymd(d.doDate)! } : null,
        salesOrder: d ? { number: d.salesOrder.soNo, externalId: d.salesOrder.externalId } : null,
        trip: d?.trip
          ? {
              number: d.trip.tripNo,
              vehiclePlate: d.trip.vehiclePlateSnapshot,
              driverName: withDriver ? d.trip.driverNameSnapshot : null,
              carrierName: d.trip.carrierNameSnapshot,
            }
          : null,
        route: d ? { originName: d.originSite.name, destinationName: d.destSite.name } : null,
        serviceItem: { id: l.serviceItemId, code: l.serviceItem.code },
        description: l.description,
        quantity: new Prisma.Decimal(l.quantity).toString(),
        unitLabel: l.unitLabel,
        unitPrice: new Prisma.Decimal(l.unitPrice).toString(),
        discount: money(l.discount),
        amount: money(l.amount),
        vatType: l.vatType,
        vatAmount: money(l.vatAmount),
        whtRate: money(l.whtRate),
        accountCode: l.accountCode,
      };
    }),
  });
}

/** คอลัมน์ของ `carrier_settlement` ที่ `canonicalSettlement` ใช้ (ยอดที่ตรึง ณ วันอนุมัติ) */
export const CANONICAL_SETTLEMENT_SELECT = {
  id: true,
  tenantId: true,
  payingCompanyId: true,
  carrierId: true,
  grossAmount: true,
  deductionAmount: true,
  netPayable: true,
  whtAmount: true,
  // D68-81 เลข DO ต่อบรรทัด (ทุกบรรทัดรวมที่ถูกนำออก — canonical กรองตาม DTO `active`)
  lines: {
    select: {
      lineNo: true,
      tripCost: {
        select: { doSurcharge: { select: { deliveryOrder: { select: { doNo: true } } } } },
      },
      trip: {
        select: {
          deliveryOrders: {
            where: { status: { not: 'CANCELLED' }, doNo: { not: null } },
            select: { doNo: true },
            orderBy: { doNo: 'asc' },
          },
        },
      },
    },
  },
} satisfies Prisma.CarrierSettlementSelect;

export type SettlementForCanonical = Prisma.CarrierSettlementGetPayload<{
  select: typeof CANONICAL_SETTLEMENT_SELECT;
}>;

/**
 * ใบสำคัญจ่ายที่บันทึกจ่ายแล้ว (DTO จาก SettlementsService + ยอดตรึงในแถว) → canonical (ไม่มี I/O)
 * `s.whtEstimate` null (ข้อมูลเขียนฐานตรง — ไม่รู้ประเภทรถร่วม) = แบบยื่นว่าง ไม่มียอดต่ออัตรา · ทางส่ง ERP กันกรณีนี้ก่อนเรียก
 */
export function canonicalSettlement(
  s: SettlementDto,
  row: SettlementForCanonical,
): CanonicalSettlementPayload {
  const est = s.whtEstimate;
  const wht = row.whtAmount ?? new Prisma.Decimal(0);
  const doNos = new Map<number, string[]>();
  for (const l of row.lines) {
    const own = l.tripCost?.doSurcharge?.deliveryOrder.doNo;
    doNos.set(
      l.lineNo,
      own ? [own] : (l.trip?.deliveryOrders ?? []).map((d) => d.doNo!).filter(Boolean),
    );
  }
  return withSyncHash({
    kind: 'settlement',
    id: row.id,
    number: s.settlementNo ?? '',
    paidDate: s.paidDate ?? '',
    payingCompanyId: row.payingCompanyId,
    period: { from: s.periodFrom, to: s.periodTo },
    carrierInvoiceNumber: s.carrierInvoiceNo,
    carrier: {
      id: row.carrierId,
      code: s.carrier.code,
      legalName: s.carrier.legalName,
      // บุคคลธรรมดา: payload ของคิวไม่มีเลขบัตรประชาชน (PDPA) — D-80: sink ใส่เลขเต็ม ณ ตอนส่ง เฉพาะ adapter ที่ประกาศ
      // `personalDataNeeds: ['carrier.taxId']` (ระบบบัญชีที่ออก 50 ทวิ) · adapter อื่นได้ null เหมือนเดิม
      taxId: s.carrier.entityType === 'JURISTIC' ? s.carrier.taxId : null,
      branchCode: s.carrier.branchCode,
      entityType: s.carrier.entityType === 'JURISTIC' ? 'JURISTIC' : 'INDIVIDUAL',
    },
    payment: {
      method: s.paymentMethod ?? null,
      reference: s.paymentReference ?? null,
      bank: s.paymentBank ?? null,
    },
    totals: {
      gross: money(row.grossAmount),
      deduction: money(row.deductionAmount),
      net: money(row.netPayable),
      wht: money(wht),
      netAfterWht: money(row.netPayable.minus(wht)),
    },
    whtEstimate: {
      pndForm: est?.form ?? '',
      byRate: (est?.byRate ?? []).map((b) => ({
        whtRate: b.whtRate,
        base: b.buyBaseAmount ?? '0.00',
        amount: b.buyWhtAmount ?? '0.00',
      })),
      reviewedByAccountant: false,
    },
    taxEstimated: true,
    lines: s.lines
      .filter((l) => l.active)
      .map((l) => ({
        lineNo: l.lineNo,
        lineType: l.lineType,
        trip: l.tripNo ? { number: l.tripNo } : null,
        deliveryOrders: (l.tripNo ? (doNos.get(l.lineNo) ?? []) : []).map((number) => ({ number })),
        description: l.description,
        amount: l.buyAmount ?? '0.00',
        vatType: l.vatType,
        whtRate: l.whtRateApplied,
        whtAmount: l.buyWhtAmount ?? null,
      })),
  });
}
