import type { ConnectorDefinition } from '../../modules/erp/connector-definition';

/**
 * FlowAccount (P1-ST5-T01b) — ประกาศใน catalog ล่วงหน้า **ยังเชื่อมต่อไม่ได้** (adapter = P1-ST5-T02–T06 รอ X-02 sandbox)
 *
 * - credential schema ตาม research/thai-tax-docs-research.md §4.1 [FACT]: Open API ใช้ OAuth2 `client_credentials`
 *   (client_id / client_secret แยก sandbox / production) → ช่อง `environment` (ไม่ลับ) + `clientId`, `clientSecret` (ลับ)
 *   [DECISION — lead 27 พ.ย. 2569, ย้อนได้] ถือ client_id เป็นค่าลับด้วย (ไม่แสดงกลับ) · ยังไม่มี connector ใดใช้ schema นี้ =
 *   แก้ได้โดยไม่ต้องย้ายข้อมูลจนกว่า adapter ตัวจริงจะเปิด
 * - capabilities ตาม R-01 / D-55 (plan/13): ใบแจ้งหนี้ → เอกสารขาย**ร่าง** (`pushInvoice`) · ใบสำคัญจ่ายที่จ่ายแล้ว → ค่าใช้จ่าย**ร่าง**
 *   (`pushSettlement`) · ดึงเลขเอกสาร/สถานะกลับ (`fetchDocument`) · สถานะรับชำระ (`fetchPaymentStatus` — D-70)
 *   **ไม่มี** pushCreditNote (TMS ไม่ส่งใบลดหนี้/ใบเสร็จในเฟสนี้)
 * - `taxDocumentOwner = ERP` ตายตัว (R-01) · gating `conn` + แพ็กเกจ Growth (docs/02 §3.1 — ดู `CONNECTOR_TIERS`)
 * - ชนิดเอกสารปลายทาง / การส่งยอด VAT = [OPEN — นักบัญชี X-07] **ไม่เดา** — ไม่มี payload builder ในไฟล์นี้
 */
export const FLOWACCOUNT_DEFINITION: ConnectorDefinition = Object.freeze({
  key: 'flowaccount',
  displayName: 'FlowAccount',
  configFields: Object.freeze([
    {
      key: 'environment',
      secret: false,
      required: true,
      kind: 'string',
      maxLength: 20,
      options: ['sandbox', 'production'],
    },
    { key: 'clientId', secret: true, required: true, kind: 'string', maxLength: 200 },
    { key: 'clientSecret', secret: true, required: true, kind: 'string', maxLength: 200 },
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
  blockedBy: Object.freeze(['X-02', 'X-07']),
});
