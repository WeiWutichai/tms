/**
 * เพดานขนาดเอกสารวางบิล (ค่าคงที่ที่ DTO / service / รอบวางบิลใช้ร่วมกัน)
 *
 * `MAX_DOS_PER_INVOICE` — ใบส่งของต่อใบแจ้งหนี้ 1 ใบ (ร่างมือ `POST /invoices`, `POST /invoices/{id}/delivery-orders` ต่อคำขอ และ
 * รอบวางบิล `POST /invoice-runs`) [DECISION — PO 22 พ.ย. 2569 คำถาม #71: ลูกค้าหนึ่งราย = ใบแจ้งหนี้ใบเดียวต่อรอบ]:
 * - docs/04 NFR "finalize invoice 500 DO < 5 วิ" → ร่างต้องถือได้ ≥ 500 DO · ตั้ง 1,000 = เผื่อ 2 เท่าของเป้า NFR
 *   (ลูกค้ารายเดือนรายใหญ่ของกลุ่มเป้าหมาย 10–200 คัน ≈ 446 DO/งวด) โดยการดึง DO เข้าร่างใช้ query คงที่ (ไม่ขึ้นกับจำนวน DO)
 * - เกินเพดาน: รอบวางบิลแบ่งเป็นหลายร่างและรายงาน (`splitByCap`) · สร้างมือ = 422
 */
export const MAX_DOS_PER_INVOICE = 1000;

/** ใบแจ้งหนี้ต่อใบวางบิล 1 ใบ (เท่าเดิม — เพดานของ `POST /billing-notes`) */
export const MAX_INVOICES_PER_BILLING_NOTE = 200;
