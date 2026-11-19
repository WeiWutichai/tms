/**
 * สิทธิ์และ role มาตรฐาน (docs/04 A3 + D-12 "ชุด docs + manager"; ค่าของ manager จาก spec/01 §12)
 *
 * รูปแบบสิทธิ์ = scope แบบ `resource:verb` ของ docs/01 §5.1 (ตัวเดียวกับที่ API key/OAuth client ใช้)
 * — `{module}.{view|manage}` ของ docs/04 แปลงเป็น `:read` / `:write` + verb พิเศษของแถวที่แยกการกระทำ
 * สิทธิ์ระดับฟิลด์ (ราคาขาย/ราคาซื้อ) เป็น scope `prices.sell:*` / `prices.buy:*` — ตัด field ที่ serializer ใน ST1-T13
 * `prices.buy:write` (ST2-T14 — แก้/อนุมัติ rate card ขาซื้อ): A3 มีแค่แถว "ดูราคาซื้อรถร่วม" → [DECISION — ย้อนได้ spec/12 §3]
 *   ให้ role ที่แก้ข้อมูลหลักได้ (`master:write`) และเห็นราคาซื้อ = owner, admin, manager, planner
 *
 * `orders:unlock` (ST3-T08 — docs/04 C Edit lock เขียน `orders.unlock`; A3 ไม่มีแถวนี้ ตั้งชื่อตามรูปแบบ `resource:verb`)
 *   → owner, admin, manager (spec/03 ORD-031 "manager ปลดล็อกได้") [DECISION — ย้อนได้ spec/12 §3]
 *
 * `trips:override` (ST3-T14 — D-07 PO 16 พ.ย. 2569: กฎเอกสารบล็อก ยกเว้นได้โดยผู้จัดการ/ผู้ดูแลพร้อมเหตุผล; A3 ไม่มีแถวนี้)
 *   → owner, admin, manager
 *
 * `deliveries:revert_late` (ST5-T06 — docs/04 F4 "DELIVERED ย้อนได้โดย Dispatcher (ภายใน 24 ชม.) / Admin"; A3 ไม่มีแถวนี้)
 *   → owner, admin เท่านั้น (ตาม F4 เคร่งครัด — manager ไม่ได้) — `BILLING_REVERT_RULES`
 *
 * "เลือกได้" ในตาราง A3 = ค่าเริ่มต้นไม่ให้ (owner เปิดเพิ่มได้เมื่อมี custom role — P1)
 */
export const PERMISSIONS = [
  'users:read',
  'users:write',
  'settings:read',
  'settings:write',
  'companies:read',
  'documents:read',
  'documents:write',
  'master:read',
  'master:write',
  'prices.sell:read',
  'prices.sell:write',
  'prices.buy:read',
  'prices.buy:write',
  'orders:read',
  'orders:write',
  'orders:cancel',
  'orders:unlock',
  'trips:read',
  'trips:assign',
  'trips:override',
  'trips:dispatch',
  'trips:close',
  /** ST5-T06 ย้อนผลส่งถึงของ DO เกิน 24 ชม. (docs/04 F4 "DELIVERED ย้อนได้โดย … Admin") */
  'deliveries:revert_late',
  'invoices:read',
  'invoices:draft',
  'invoices:finalize',
  'credit-notes:request',
  'credit-notes:approve',
  'settlements:read',
  'settlements:create',
  'settlements:approve',
  'settlements:pay',
  'integrations:read',
  'integrations:retry',
  /** ST7-T11: อ่าน event สาธารณะ `GET /v1/events` (docs/01 §5.4 `events:read`) — เห็นเฉพาะ event ของ resource ที่อ่านได้ */
  'events:read',
  'jobs:read',
  'reports.finance:read',
  'reports.ops:read',
  'export:run',
  'audit:read',
  'audit.accounting:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_CODES = [
  'owner',
  'admin',
  'manager',
  'planner',
  'dispatcher',
  'invoicer',
  'accounting',
  'approver',
  'viewer',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

/**
 * ทุก role ภายใน: อ่านนิติบุคคล/สาขา (หัวเอกสาร) และดูไฟล์แนบ; แนบไฟล์ได้ทุก role ยกเว้น Viewer (ST1-T08)
 * ไฟล์แนบเป็นส่วนประกอบของโมดูลอื่น (POD, เอกสารรถ, 50 ทวิ) — สิทธิ์ของ entity นั้นตรวจซ้ำที่โมดูลเจ้าของ
 */
const READ_BASE: Permission[] = ['companies:read', 'documents:read'];
const BASE: Permission[] = [...READ_BASE, 'documents:write'];
const ALL = [...PERMISSIONS] as Permission[];

export const SYSTEM_ROLES: Record<RoleCode, { th: string; en: string; permissions: Permission[] }> =
  {
    owner: { th: 'เจ้าของ', en: 'Owner', permissions: ALL },
    // A3: ใบลดหนี้/เพิ่มหนี้ ของ Admin = "✔ / (ว่าง)" → ขอได้ อนุมัติไม่ได้
    admin: {
      th: 'ผู้ดูแลระบบ',
      en: 'Admin',
      permissions: ALL.filter((p) => p !== 'credit-notes:approve'),
    },
    // spec/01 §12 คอลัมน์ manager (D-12)
    manager: {
      th: 'ผู้จัดการ',
      en: 'Manager',
      permissions: [
        ...BASE,
        'users:read',
        'settings:read',
        'master:read',
        'master:write',
        'prices.sell:read',
        'prices.buy:read',
        'prices.buy:write',
        'orders:read',
        'orders:write',
        'orders:cancel',
        // ST3-T08: ปลดล็อกการแก้ของคนอื่น — spec/03 ORD-031 "manager ปลดล็อกได้"
        'orders:unlock',
        'trips:read',
        'trips:assign',
        // ST3-T14 D-07: ยกเว้นกฎเอกสาร (บล็อก) ตอนจัดรถ — ผู้จัดการ/ผู้ดูแล
        'trips:override',
        'trips:dispatch',
        'trips:close',
        'invoices:read',
        'invoices:finalize',
        'credit-notes:approve',
        'settlements:read',
        'settlements:approve',
        'integrations:read',
        'reports.finance:read',
        'reports.ops:read',
        'export:run',
        'audit:read',
      ],
    },
    planner: {
      th: 'ผู้วางแผน',
      en: 'Planner',
      permissions: [
        ...BASE,
        'master:read',
        'master:write',
        'prices.buy:read',
        'prices.buy:write',
        'orders:read',
        'orders:write',
        'orders:cancel',
        'trips:read',
        'trips:assign',
        'reports.ops:read',
        'export:run',
      ],
    },
    dispatcher: {
      th: 'ผู้จ่ายงาน',
      en: 'Dispatcher',
      permissions: [
        ...BASE,
        'master:read',
        'prices.buy:read',
        'orders:read',
        'trips:read',
        'trips:assign',
        'trips:dispatch',
        'trips:close',
        'settlements:read',
        'settlements:create',
        'reports.ops:read',
      ],
    },
    invoicer: {
      th: 'ผู้วางบิล',
      en: 'Invoicer',
      permissions: [
        ...BASE,
        'master:read',
        'prices.sell:read',
        'prices.sell:write',
        'prices.buy:read',
        'orders:read',
        'trips:read',
        'invoices:read',
        'invoices:draft',
        'invoices:finalize',
        'credit-notes:request',
        'settlements:read',
        'settlements:create',
        'integrations:read',
        'integrations:retry',
        'reports.finance:read',
        'reports.ops:read',
        'export:run',
      ],
    },
    accounting: {
      th: 'บัญชี',
      en: 'Accounting',
      permissions: [
        ...BASE,
        'master:read',
        'prices.sell:read',
        'prices.sell:write',
        'prices.buy:read',
        'orders:read',
        'trips:read',
        'invoices:read',
        'invoices:draft',
        'invoices:finalize',
        'credit-notes:request',
        'settlements:read',
        'settlements:create',
        'settlements:approve',
        'settlements:pay',
        'integrations:read',
        'integrations:retry',
        'reports.finance:read',
        'reports.ops:read',
        'export:run',
        'audit.accounting:read',
      ],
    },
    approver: {
      th: 'ผู้อนุมัติ',
      en: 'Approver',
      permissions: [
        ...BASE,
        'master:read',
        'prices.sell:read',
        'prices.buy:read',
        'orders:read',
        'trips:read',
        'invoices:read',
        'invoices:finalize',
        'credit-notes:approve',
        'settlements:read',
        'settlements:approve',
        'integrations:read',
        'integrations:retry',
        'reports.finance:read',
        'reports.ops:read',
      ],
    },
    viewer: {
      th: 'ดูอย่างเดียว',
      en: 'Viewer',
      permissions: [
        ...READ_BASE,
        'master:read',
        'orders:read',
        'trips:read',
        'invoices:read',
        'settlements:read',
        'integrations:read',
        'reports.ops:read',
      ],
    },
  };

/**
 * scope ที่ได้รับครอบ scope ที่ต้องการไหม — `*` = ทุกอย่าง, `resource:*` = ทุก verb ของ resource
 * (`resource:write` ไม่ครอบ `resource:read` โดยอัตโนมัติ — role ต้องให้ทั้งคู่ชัด ๆ)
 */
export function scopeAllows(granted: readonly string[], required: string): boolean {
  if (granted.includes('*') || granted.includes(required)) return true;
  const [resource] = required.split(':');
  return granted.includes(`${resource}:*`);
}

/**
 * scope ที่ห้ามให้ API key / OAuth client (ST7-T01 review M1) — งานบริหารผู้ใช้/บทบาท/ความปลอดภัย/การตั้งค่า
 * (รวมการจัดการ API key ซึ่งใช้ `settings:write`) ต้องทำโดยคนที่ login + 2FA เท่านั้น
 * [DECISION — ตามคำแนะนำ, PO อนุมัติล่วงหน้า 17 พ.ย. 2569 — ย้อนได้ spec/12 §3]
 */
export const API_KEY_DENIED_SCOPES: readonly Permission[] = [
  'users:read',
  'users:write',
  'settings:write',
];

/** scope ที่ให้ API key ได้ = PERMISSIONS − API_KEY_DENIED_SCOPES */
export const API_KEY_SCOPES: readonly Permission[] = PERMISSIONS.filter(
  (p) => !API_KEY_DENIED_SCOPES.includes(p),
);
