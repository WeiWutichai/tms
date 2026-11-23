import type {
  CanonicalInvoicePayload,
  CanonicalSettlementPayload,
} from '../../modules/erp/canonical';
import type { ErpContext } from '../../modules/erp/erp-adapter';

/**
 * canonical (docs/01 §7) → `DocumentDraftCreate` ของ AccountSystem (packages/contracts/accountsystem) — **whitelist** ฟิลด์ตาม contract
 * - หัวเอกสาร strict ฝั่ง AccountSystem (ฟิลด์เกิน = 400) → สร้าง object ใหม่ทีละฟิลด์เท่านั้น
 * - `external_source` แยกชนิดเอกสาร (`tms.invoice` / `tms.settlement`) + `external_ref` = เลขเอกสาร TMS → กันซ้ำฝั่ง AccountSystem
 * - ส่ง `amount` หลังส่วนลดเสมอ (AccountSystem ไม่คำนวณจาก qty × ราคา และไม่เก็บ discount — README ข้อ 9)
 * - `vat_rate` ส่งตามประเภทของบรรทัด: VAT_7 = "7" · ZERO_RATED = "0" · EXEMPT_TRANSPORT = ไม่ส่ง (contract แยก "ยกเว้น" กับ 0% ไม่ได้)
 *   **[OPEN — ทีม AccountSystem]** ตอนนี้ AccountSystem ทิ้ง vat_rate รายบรรทัด (`ledger-service.ts:174`) — ภาษีจริงออกที่ AccountSystem (D-55)
 * - ไม่มีมิติ DO/เที่ยว ต่อบรรทัด [OPEN — ทีม AccountSystem] → ใส่เลข DO/เที่ยวท้ายคำอธิบาย
 * - AP: ไม่มี WHT รายบรรทัด [OPEN — ทีม AccountSystem] → WHT ประมาณการ (D-58) + แบบ ภ.ง.ด. ส่งเป็นบรรทัดหมายเหตุ (`line_type: note`)
 */

export const AS_SOURCE = { invoice: 'tms.invoice', settlement: 'tms.settlement' } as const;
export const AS_CONTACT_SOURCE = { customer: 'tms.customer', carrier: 'tms.carrier' } as const;

export interface AsDraftLine {
  line_type: 'item' | 'note';
  product_code?: string;
  description: string;
  qty?: string;
  unit_price?: string;
  amount?: string;
  vat_rate?: string;
}

export interface AsDraftDocument {
  doc_type: 'IV' | 'AP';
  issue_date: string;
  due_date?: string;
  contact_code: string;
  price_incl_vat: false;
  branch_code: string;
  lines: AsDraftLine[];
  external_source: string;
  external_ref: string;
}

const BRANCH_RE = /^\d{5}$/;
const MONEY_RE = /^-?\d{1,16}\.\d{2}$/;
const DESC_MAX = 500;

/** สาขาผู้ออก (5 หลัก): branch_map ของ connector → สาขาผู้ออกของเอกสาร → สำนักงานใหญ่ */
export function asBranchCode(ctx: Pick<ErpContext, 'erpCompanyCode'>, fallback?: string | null) {
  if (ctx.erpCompanyCode && BRANCH_RE.test(ctx.erpCompanyCode)) return ctx.erpCompanyCode;
  if (fallback && BRANCH_RE.test(fallback)) return fallback;
  return '00000';
}

export function asVatRate(vatType: string | null | undefined): string | undefined {
  if (vatType === 'VAT_7') return '7';
  if (vatType === 'ZERO_RATED') return '0';
  return undefined;
}

/** จำนวน/ราคา ≤ 4 ตำแหน่ง (Qty ของ contract) — เกิน = ไม่ส่ง (ยอดอยู่ที่ `amount` แล้ว ไม่ปัดเอง) */
export function asQty(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
  return /^-?\d{1,14}(\.\d{1,4})?$/.test(s) ? s : undefined;
}

function money(v: string | null | undefined): string {
  if (!v || !MONEY_RE.test(v)) throw new Error(`invalid money '${String(v)}'`);
  return v;
}

function desc(text: string, ref: string | null): string {
  const t = (text || '-').trim();
  const out = ref && !t.includes(ref) ? `${t} (${ref})` : t;
  return out.slice(0, DESC_MAX);
}

/** ใบแจ้งหนี้ → IV ร่าง */
export function invoiceDraft(
  ctx: Pick<ErpContext, 'erpCompanyCode'>,
  inv: CanonicalInvoicePayload,
  contactCode: string,
): AsDraftDocument {
  return {
    doc_type: 'IV',
    issue_date: inv.issueDate,
    ...(inv.dueDate ? { due_date: inv.dueDate } : {}),
    contact_code: contactCode,
    price_incl_vat: false,
    branch_code: asBranchCode(ctx, inv.issuer?.branchCode),
    lines: inv.lines.map((l) => {
      const qty = asQty(l.quantity);
      const price = asQty(l.unitPrice);
      const vat = asVatRate(l.vatType);
      const code = l.serviceItem?.externalId ?? undefined;
      return {
        line_type: 'item' as const,
        ...(code ? { product_code: code } : {}),
        description: desc(l.description, l.deliveryOrder?.number ?? null),
        ...(qty && price ? { qty, unit_price: price } : {}),
        amount: money(l.amount),
        ...(vat !== undefined ? { vat_rate: vat } : {}),
      };
    }),
    external_source: AS_SOURCE.invoice,
    external_ref: inv.number,
  };
}

const PND_LABEL: Record<string, string> = { PND3: 'ภ.ง.ด.3', PND53: 'ภ.ง.ด.53' };

/** ใบสำคัญจ่ายที่จ่ายแล้ว → AP ร่าง + บรรทัดหมายเหตุ WHT ประมาณการ (D-58) */
export function settlementDraft(
  ctx: Pick<ErpContext, 'erpCompanyCode'>,
  s: CanonicalSettlementPayload,
  contactCode: string,
): AsDraftDocument {
  const items: AsDraftLine[] = s.lines.map((l) => {
    const vat = asVatRate(l.vatType);
    const amount = money(l.amount);
    return {
      line_type: 'item',
      // D68-81 อ้างอิงเที่ยว + เลข DO ของบรรทัด (กระทบยอดรายบรรทัดกับ DO ฝั่ง AP) — AccountSystem ไม่มีช่องอ้างอิงแยก
      description: desc(
        l.description,
        [l.trip?.number, (l.deliveryOrders ?? []).map((d) => d.number).join(', ')]
          .filter(Boolean)
          .join(' · ') || null,
      ),
      // บรรทัดหักเป็นยอดติดลบอยู่แล้ว (CHECK settlement_line_ref_check) — ส่งตามจริง
      amount,
      ...(vat !== undefined ? { vat_rate: vat } : {}),
    };
  });
  const form = PND_LABEL[s.whtEstimate.pndForm] ?? s.whtEstimate.pndForm;
  const notes: AsDraftLine[] = s.whtEstimate.byRate
    .filter((b) => b.amount !== '0.00')
    .map((b) => ({
      line_type: 'note',
      description:
        `หัก ณ ที่จ่ายประมาณการ ${b.whtRate}% ฐาน ${b.base} บาท = ${b.amount} บาท (${form}) — ` +
        'ยอดจาก TMS ยังไม่ผ่านนักบัญชี · ออก 50 ทวิ ที่ระบบบัญชี',
    }));
  const paid = [s.payment.method, s.payment.bank, s.payment.reference].filter(Boolean).join(' ');
  notes.push({
    line_type: 'note',
    description: desc(
      `จ่ายแล้วใน TMS วันที่ ${s.paidDate}${paid ? ` (${paid})` : ''} · ยอดจ่ายหลังหัก ณ ที่จ่าย ${s.totals.netAfterWht} บาท${
        s.carrierInvoiceNumber ? ` · ใบแจ้งหนี้รถร่วม ${s.carrierInvoiceNumber}` : ''
      }`,
      null,
    ),
  });
  return {
    doc_type: 'AP',
    issue_date: s.paidDate,
    due_date: s.paidDate,
    contact_code: contactCode,
    price_incl_vat: false,
    branch_code: asBranchCode(ctx, null),
    lines: [...items, ...notes],
    external_source: AS_SOURCE.settlement,
    external_ref: s.number,
  };
}
