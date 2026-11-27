import type { ConnectorDefinition } from '../../modules/erp/connector-definition';

/**
 * PEAK (P1-ST5-T01b) — ประกาศใน catalog ล่วงหน้า **ยังเชื่อมต่อไม่ได้** (adapter = P1-ST5-T07–T10 รอ X-03 sandbox)
 *
 * - credential schema ตาม research/thai-tax-docs-research.md §4.2 [FACT]: header บังคับ `Client-Token`, `User-Token` และ
 *   `Time-Signature` = HMAC ของ Time-Stamp โดยใช้ connectId เป็น key → ช่องลับ `clientToken`, `userToken`, `connectId`
 *   (ไม่มีช่องที่ไม่ลับ — base URL / sandbox ตัดสินตอนทำ adapter หลังได้ X-03) [DECISION — lead 27 พ.ย. 2569, ย้อนได้]
 * - capabilities ตาม R-01 / D-55: ใบแจ้งหนี้ → Invoices **ร่าง** (`pushInvoice` — e-Tax เป็น action ใน PEAK ไม่เรียกจาก TMS, R-13) ·
 *   ใบสำคัญจ่าย → Expenses **ร่าง** (`pushSettlement`) · ดึงเลข/สถานะกลับ (`fetchDocument`) · สถานะรับชำระ (`fetchPaymentStatus`)
 * - `taxDocumentOwner = ERP` ตายตัว (R-01) · gating `conn` + แพ็กเกจ Growth (docs/02 §3.1)
 * - ชนิดเอกสารปลายทาง / การส่งยอด VAT = [OPEN — นักบัญชี X-07] **ไม่เดา**
 */
export const PEAK_DEFINITION: ConnectorDefinition = Object.freeze({
  key: 'peak',
  displayName: 'PEAK',
  configFields: Object.freeze([
    { key: 'clientToken', secret: true, required: true, kind: 'string', maxLength: 300 },
    { key: 'userToken', secret: true, required: true, kind: 'string', maxLength: 300 },
    { key: 'connectId', secret: true, required: true, kind: 'string', maxLength: 300 },
  ] as const),
  capabilities: Object.freeze([
    'pushInvoice',
    'pushSettlement',
    'fetchDocument',
    'fetchPaymentStatus',
  ] as const),
  fixedSystemOfRecord: Object.freeze({ taxDocumentOwner: 'ERP' as const }),
  entitlement: Object.freeze({ feature: 'conn' as const, minTier: 'growth' as const }),
  availability: 'COMING_SOON' as const,
  blockedBy: Object.freeze(['X-03', 'X-07']),
});
