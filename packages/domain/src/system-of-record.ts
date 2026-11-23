/**
 * System-of-record rules ต่อ connector (ST7-T17; docs/04 G3 "System-of-record rules", docs/01 §1 ข้อ 4, §8.1; plan/05 D-27)
 *
 * กฎกลางที่ไม่ผูก ERP ใด — ค่าตั้งเก็บที่แถว `connector` (ตกลงกับลูกค้าก่อน go-live ตามแม่แบบ `plan/templates/sor-agreement.md`)
 * - `taxDocumentOwner` ใครเป็นเจ้าของเอกสารภาษี: `ERP` → TMS ออกแค่ใบแจ้งหนี้/ใบวางบิล **ไม่ออกเลขใบกำกับภาษี** (docs/01 §8.1)
 *   TMS ออกเลขเอกสารของตัวเองเสมอ (D-27 / RA-9) — ค่านี้ตัดสินเฉพาะว่า TMS ออกเลขใบกำกับภาษีหรือไม่
 * - `customerOwner` ใครเป็นเจ้าของข้อมูลลูกค้า (หลัก) — docs/04 G3 "ERP = เจ้าของลูกค้า(หลัก)"
 * - ทั้งสองค่าเริ่มเป็น null = ยังไม่เลือก (docs/01 §8.1 "ต้องเลือก") — ค่าเริ่มต้นเป็นของ PO/นักบัญชี (คำถามค้างใน PROGRESS)
 * - `fieldSync` กลุ่ม field ที่แก้แล้ว sync อัตโนมัติ vs ต้อง regenerate (docs/04 G3: ราคา วันที่ accessorial = auto-sync; เปลี่ยนลูกค้า = ต้อง regenerate)
 * - แก้ (แล้ว sync ออก) ได้จนรับชำระ — **กฎ** ของ docs/04 G3 (ไม่ใช่ค่าตั้ง) บังคับใน `fieldChangePolicy`
 *
 * กฎนี้ **ไม่เปลี่ยนกฎเอกสารภาษีของ TMS**: ใบที่ออกเลขแล้วแก้ไม่ได้ — การแก้หลังออกเลขยังเป็นใบลดหนี้/เพิ่มหนี้ใน TMS เสมอ
 * (`fieldChangePolicy` ตัดสินแค่ว่าการเปลี่ยนนั้นไปถึงเอกสารฝั่ง ERP แบบไหน)
 * Standalone-first: ไม่มี connector = TMS เป็นเจ้าของทุกอย่าง (`STANDALONE_SOR`)
 */

export const SOR_OWNERS = ['TMS', 'ERP'] as const;
export type SorOwner = (typeof SOR_OWNERS)[number];

export function isSorOwner(v: unknown): v is SorOwner {
  return typeof v === 'string' && (SOR_OWNERS as readonly string[]).includes(v);
}

/** กลุ่ม field ของเอกสารที่ส่งไป ERP (docs/04 G3) */
export const SOR_FIELD_GROUPS = ['PRICE', 'DATES', 'ACCESSORIAL', 'CUSTOMER'] as const;
export type SorFieldGroup = (typeof SOR_FIELD_GROUPS)[number];

export function isSorFieldGroup(v: unknown): v is SorFieldGroup {
  return typeof v === 'string' && (SOR_FIELD_GROUPS as readonly string[]).includes(v);
}

/** AUTO_SYNC = แก้ใน TMS แล้วส่งการเปลี่ยนไป ERP เอง · REGENERATE = ต้องสร้างเอกสารฝั่ง ERP ใหม่ (ยกเลิกใบเดิม + ส่งใหม่) */
export const SOR_CHANGE_MODES = ['AUTO_SYNC', 'REGENERATE'] as const;
export type SorChangeMode = (typeof SOR_CHANGE_MODES)[number];

/** กลุ่มที่ตั้งเป็น AUTO_SYNC ไม่ได้ — docs/04 G3 "ต้อง regenerate (เปลี่ยนลูกค้า)" */
export const SOR_REGENERATE_ONLY: readonly SorFieldGroup[] = ['CUSTOMER'];

export const DEFAULT_SOR_FIELD_SYNC: Readonly<Record<SorFieldGroup, SorChangeMode>> = {
  PRICE: 'AUTO_SYNC',
  DATES: 'AUTO_SYNC',
  ACCESSORIAL: 'AUTO_SYNC',
  CUSTOMER: 'REGENERATE',
};

export interface SystemOfRecord {
  /** null = ยังไม่เลือก (docs/01 §8.1 "ต้องเลือก") — ค่าเริ่มต้นเป็นของ PO/นักบัญชี ไม่ใช่ของระบบ */
  customerOwner: SorOwner | null;
  /** null = ยังไม่เลือก → TMS ออกเลขตามปกติ แต่เปิด/ส่งเอกสารภาษีไป ERP ไม่ได้จนกว่าจะเลือก (`SOR_TAX_PUSH_CAPABILITIES`) */
  taxDocumentOwner: SorOwner | null;
  fieldSync: Record<SorFieldGroup, SorChangeMode>;
}

/** ไม่มี connector (หรือยกเลิกการเชื่อมแล้ว) — TMS เป็นเจ้าของทุกอย่าง */
export const STANDALONE_SOR: Readonly<SystemOfRecord> = Object.freeze({
  customerOwner: 'TMS',
  taxDocumentOwner: 'TMS',
  fieldSync: { ...DEFAULT_SOR_FIELD_SYNC },
});

/**
 * capability ที่ส่งเอกสารภาษี/เอกสารที่ปรับเอกสารภาษีไป ERP — เปิดไม่ได้ (และคำสั่งถูกพัก) จนกว่าจะเลือก `taxDocumentOwner`
 * (กันเอกสารภาษีซ้ำสองชุดก่อนตกลงกับลูกค้า — docs/01 §8.1)
 */
export const SOR_TAX_PUSH_CAPABILITIES = [
  'pushInvoice',
  'pushCreditNote',
  'replaceDocument',
] as const;

/** ค่าที่เก็บ (jsonb — เก็บเฉพาะที่ต่างจากค่าเริ่มต้นหรือทั้งชุด) → ชุดเต็ม · ค่าที่ไม่รู้จักใช้ค่าเริ่มต้น · กลุ่ม regenerate-only บังคับเสมอ */
export function normalizeFieldSync(stored: unknown): Record<SorFieldGroup, SorChangeMode> {
  const src =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const out = { ...DEFAULT_SOR_FIELD_SYNC };
  for (const g of SOR_FIELD_GROUPS) {
    const v = src[g];
    if (typeof v === 'string' && (SOR_CHANGE_MODES as readonly string[]).includes(v))
      out[g] = v as SorChangeMode;
    if (SOR_REGENERATE_ONLY.includes(g)) out[g] = 'REGENERATE';
  }
  return out;
}

/** ตรวจค่าที่ส่งมา — คืนรายการผิด (ว่าง = ผ่าน) */
export function fieldSyncErrors(
  input: Record<string, unknown>,
): Array<{ field: string; code: string; message: string }> {
  const errs: Array<{ field: string; code: string; message: string }> = [];
  for (const [k, v] of Object.entries(input)) {
    const field = `fieldSync.${k}`;
    if (!isSorFieldGroup(k)) {
      errs.push({
        field,
        code: 'unknown_field_group',
        message: `must be one of: ${SOR_FIELD_GROUPS.join(', ')}`,
      });
      continue;
    }
    if (typeof v !== 'string' || !(SOR_CHANGE_MODES as readonly string[]).includes(v)) {
      errs.push({
        field,
        code: 'invalid_option',
        message: `must be one of: ${SOR_CHANGE_MODES.join(', ')}`,
      });
      continue;
    }
    if (v === 'AUTO_SYNC' && SOR_REGENERATE_ONLY.includes(k))
      errs.push({
        field,
        code: 'regenerate_required',
        message: `${k} changes always require regenerating the ERP document (docs/04 G3)`,
      });
  }
  return errs;
}

/**
 * **จุดตัดสินเดียว** ว่า TMS ออกเลขใบกำกับภาษี (`tax_invoice_no`) ได้ไหม — ST5-T09 (finalize/ออกเลข) ต้องเรียกผ่าน
 * `SystemOfRecordPolicy.assertCanIssueTaxDocumentNumber` ก่อนออกเลขใบกำกับภาษีทุกครั้ง
 * **`taxDocumentOwner = ERP` → false เสมอ ไม่ว่า connector พร้อมส่งหรือไม่** (D-81 · D68-04 · 23 พ.ย. 2569 — docs/01 §8.1:
 * เลขที่ออกแล้วย้อนไม่ได้ เสี่ยงเอกสารซ้ำสองระบบ) · connector ยังส่งไม่ถึง ERP → ผู้เรียกแสดงคำเตือน (`taxDocumentOwnerWarning`)
 * และผู้ใช้ต้องสลับเจ้าของเป็น TMS เองอย่างชัดเจน (`PUT /connectors/{id}/system-of-record` + เหตุผล + audit) — ระบบไม่สลับให้
 * TMS / ยังไม่เลือก (null) / Standalone (ไม่มี connector หรือยกเลิกการเชื่อมแล้ว) → TMS ออกเลข
 */
export function canIssueTaxDocumentNumber(sor: Pick<SystemOfRecord, 'taxDocumentOwner'>): boolean {
  return sor.taxDocumentOwner !== 'ERP';
}

/**
 * คำเตือนเจ้าของเอกสารภาษี (D68-04): `ERP_NOT_CONNECTED` = ตั้งให้ ERP ออกใบกำกับภาษี แต่ใบแจ้งหนี้ยังไปไม่ถึง ERP
 * (connector ยังไม่เคยเปิดใช้ / ไม่มี pushInvoice / แพ็กเกจไม่มี conn) → **ไม่มีใครออกใบกำกับภาษี** จนกว่าจะเชื่อมสำเร็จ
 * หรือผู้ใช้สลับเจ้าของเป็น TMS เอง · null = ไม่มีอะไรต้องเตือน
 */
export const SOR_TAX_OWNER_WARNINGS = ['ERP_NOT_CONNECTED'] as const;
export type SorTaxOwnerWarning = (typeof SOR_TAX_OWNER_WARNINGS)[number];

export function taxDocumentOwnerWarning(
  sor: Pick<SystemOfRecord, 'taxDocumentOwner'>,
  invoiceReachesErp: boolean,
): SorTaxOwnerWarning | null {
  return sor.taxDocumentOwner === 'ERP' && !invoiceReachesErp ? 'ERP_NOT_CONNECTED' : null;
}

/** สถานะใบแจ้งหนี้ที่นับว่า "รับชำระแล้ว" — รับบางส่วนก็นับ (แบบระมัดระวัง: ERP อาจตัดชำระกับใบนั้นแล้ว) */
export const SOR_PAYMENT_RECEIVED_STATUSES = ['PARTIALLY_PAID', 'PAID'] as const;

export type SorChangeDecision =
  /** ไม่มีสำเนาใน ERP (Standalone / connector ไม่ส่งใบแจ้งหนี้) — ใช้กฎของ TMS อย่างเดียว */
  | { mode: 'LOCAL' }
  | { mode: 'AUTO_SYNC' }
  | { mode: 'REGENERATE' }
  /** รับชำระแล้ว — ห้ามส่งการเปลี่ยนไป ERP (docs/04 G3 "แก้ได้จนรับชำระ" เป็นกฎ ไม่ใช่ค่าตั้ง) */
  | { mode: 'BLOCKED'; code: 'paid_locked' };

/**
 * การเปลี่ยน field กลุ่ม `group` ของใบแจ้งหนี้สถานะ `invoiceStatus` ไปถึง ERP แบบไหน
 * `documentInErp` = เอกสาร**ใบนั้น**อยู่ใน ERP แล้ว — ST7-T16 ต้องตัดสินจาก `external_mapping` ของเอกสารนั้น
 * (ไม่ใช่แค่ capability ของ connector: ใบก่อน `syncFromDate` / ยังไม่ส่ง = LOCAL)
 */
export function fieldChangePolicy(
  sor: Pick<SystemOfRecord, 'fieldSync'>,
  group: SorFieldGroup,
  invoiceStatus: string | null,
  documentInErp: boolean,
): SorChangeDecision {
  if (!documentInErp) return { mode: 'LOCAL' };
  if (invoiceStatus && (SOR_PAYMENT_RECEIVED_STATUSES as readonly string[]).includes(invoiceStatus))
    return { mode: 'BLOCKED', code: 'paid_locked' };
  return { mode: normalizeFieldSync(sor.fieldSync)[group] };
}
