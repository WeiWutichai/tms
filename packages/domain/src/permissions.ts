/**
 * สิทธิ์และ role มาตรฐาน (docs/04 A3 + D-12 "ชุด docs + manager"; ค่าของ manager จาก spec/01 §12)
 *
 * รูปแบบสิทธิ์ = scope แบบ `resource:verb` ของ docs/01 §5.1 (ตัวเดียวกับที่ API key/OAuth client ใช้)
 * — `{module}.{view|manage}` ของ docs/04 แปลงเป็น `:read` / `:write` + verb พิเศษของแถวที่แยกการกระทำ
 * สิทธิ์ระดับฟิลด์ (ราคาขาย/ราคาซื้อ) เป็น scope `prices.sell:*` / `prices.buy:read` — ตัด field ที่ serializer ใน ST1-T13
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
  'orders:read',
  'orders:write',
  'orders:cancel',
  'trips:read',
  'trips:assign',
  'trips:dispatch',
  'trips:close',
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
        'orders:read',
        'orders:write',
        'orders:cancel',
        'trips:read',
        'trips:assign',
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
