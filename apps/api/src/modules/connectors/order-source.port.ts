/**
 * Port ขาเข้าของ connector (ST3-T05; docs/01 §6.1 `ErpAdapter.pullOrders`) — **ไม่ผูกกับ ERP ใด**
 * adapter แต่ละตัว (KRS = ST8-T04, DemoProvider = ST7-T14, `mock` = test/dev) แปลงข้อมูลของตัวเองเป็น `ExternalOrder`
 * แล้ว core (`ConnectorIntakeService`) แปลงต่อเป็น `UpsertOrderInput` และเรียก `OrderIntakeService.upsertOrder`
 * ทางเดียวกับ API — ไม่มีทางลัด (docs/04 C "รับจาก ERP connector")
 *
 * ค่าในทุกช่อง **ไม่เชื่อ** — ข้อมูลต้นทางอาจผิดรูป/ขาด (core ตรวจเองแล้วรับเข้าเป็นใบค้าง SOURCE_ERROR ไม่ทิ้ง)
 * จึงประกาศเป็น `unknown` ในช่องที่ต้นทางมักส่งผิดชนิด
 */
export interface ExternalOrder {
  /** เลขอ้างอิงของต้นทาง (key idempotent ต่อ tenant) — adapter ใส่ namespace เอง เช่น `KRS-{company}-{soNo}` */
  externalId: unknown;
  customer?: {
    /** รหัสลูกค้าฝั่งต้นทาง → จับคู่ customer.external_id (ไม่พบ = CUSTOMER_UNMAPPED) */
    code?: unknown;
    name?: unknown;
  } | null;
  /** เลข PO ของลูกค้า */
  customerRef?: unknown;
  /** YYYY-MM-DD วันรับของ — ไม่มี/ผิดรูป → ใช้วันที่รับเข้า + ใบค้าง SOURCE_ERROR */
  requestedDate?: unknown;
  /** รหัสประเภทรถ (external_id หรือ code ของ vehicle_type) */
  vehicleTypeCode?: unknown;
  stops?: unknown;
  lines?: unknown;
  /** ปัญหาที่ adapter พบเอง (เช่น view/คอลัมน์หาย — ST8-T04) → ใบค้าง SOURCE_ERROR */
  issues?: unknown;
  /** แถวดิบจากต้นทาง (docs/01 §3.3 raw_payload) */
  raw?: unknown;
}

/** จุดรับ/ส่งตามต้นทาง (ใน `ExternalOrder.stops[]`) */
export interface ExternalOrderStop {
  /** PICKUP / DELIVERY / RETURN */
  type?: unknown;
  /** รหัสสถานที่ฝั่งต้นทาง → จับคู่ customer_site.external_id */
  siteCode?: unknown;
  /** ชื่อ/ที่อยู่ตามต้นทาง */
  text?: unknown;
  /** ISO 8601 พร้อม timezone */
  windowStart?: unknown;
  windowEnd?: unknown;
}

/** บรรทัดสินค้า (ใน `ExternalOrder.lines[]`) */
export interface ExternalOrderLine {
  itemCode?: unknown;
  description?: unknown;
  /** สตริงทศนิยม (ตัวเลข JS แปลงเป็นสตริงให้ — ไม่คำนวณด้วย float) */
  qty?: unknown;
  unit?: unknown;
  weightKg?: unknown;
  cbm?: unknown;
  isDangerous?: unknown;
  tempMin?: unknown;
  tempMax?: unknown;
}

export interface PullContext {
  tenantId: string;
}

export interface PullPage {
  orders: ExternalOrder[];
  /** ตำแหน่งถัดไป (ทึบ) — เก็บใน connector_cursor เมื่อรับทุกใบของหน้านี้แล้ว */
  nextCursor: string | null;
  /** ยังมีหน้าถัดไปทันที */
  hasMore: boolean;
}

/** สัญญาฝั่งขาเข้าของ adapter (subset ของ `ErpAdapter` — ST7-T13 รวมเป็น interface เต็ม) */
export interface OrderSourcePort {
  /** รหัส connector (CONNECTOR_KEY_RE) — ใบที่รับเข้ามี source `ERP:{key}` */
  readonly key: string;
  /** ห้ามเขียนฐานข้อมูล TMS — คืนเฉพาะข้อมูลต้นทาง (core ถือ transaction เอง) */
  pullOrders(ctx: PullContext, since: string | null, limit: number): Promise<PullPage>;
}
