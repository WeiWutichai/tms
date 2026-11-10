import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_CODES, SYSTEM_ROLES, scopeAllows, type RoleCode } from './permissions';

/**
 * ตาราง A3 (docs/04) — แต่ละแถว: scope ตัวแทน → role ที่ต้องได้ (ที่เหลือต้องไม่ได้)
 * manager ตาม spec/01 §12 (D-12) · "เลือกได้" = ค่าเริ่มต้นไม่ได้
 */
const A3: Array<[string, string, RoleCode[]]> = [
  ['user / role / 2FA policy', 'users:write', ['owner', 'admin']],
  ['ตั้งค่าองค์กร / สาขา / connector / API key', 'settings:write', ['owner', 'admin']],
  ['Master data — แก้', 'master:write', ['owner', 'admin', 'manager', 'planner']],
  [
    'Master data — อ่าน',
    'master:read',
    [
      'owner',
      'admin',
      'manager',
      'planner',
      'dispatcher',
      'invoicer',
      'accounting',
      'approver',
      'viewer',
    ],
  ],
  [
    'ดูราคาขาย',
    'prices.sell:read',
    ['owner', 'admin', 'manager', 'invoicer', 'accounting', 'approver'],
  ],
  ['แก้ราคาขาย', 'prices.sell:write', ['owner', 'admin', 'invoicer', 'accounting']],
  [
    'ดูราคาซื้อรถร่วม',
    'prices.buy:read',
    ['owner', 'admin', 'manager', 'planner', 'dispatcher', 'invoicer', 'accounting', 'approver'],
  ],
  ['Order: จัด', 'orders:write', ['owner', 'admin', 'manager', 'planner']],
  ['Order: ยกเลิก', 'orders:cancel', ['owner', 'admin', 'manager', 'planner']],
  [
    'Order: ดู',
    'orders:read',
    [
      'owner',
      'admin',
      'manager',
      'planner',
      'dispatcher',
      'invoicer',
      'accounting',
      'approver',
      'viewer',
    ],
  ],
  ['Trip: assign', 'trips:assign', ['owner', 'admin', 'manager', 'planner', 'dispatcher']],
  ['Trip: dispatch', 'trips:dispatch', ['owner', 'admin', 'manager', 'dispatcher']],
  ['Trip: ปิด', 'trips:close', ['owner', 'admin', 'manager', 'dispatcher']],
  ['Invoice: draft', 'invoices:draft', ['owner', 'admin', 'invoicer', 'accounting']],
  [
    'Invoice: finalize',
    'invoices:finalize',
    ['owner', 'admin', 'manager', 'invoicer', 'accounting', 'approver'],
  ],
  [
    'Invoice: อ่าน',
    'invoices:read',
    ['owner', 'admin', 'manager', 'invoicer', 'accounting', 'approver', 'viewer'],
  ],
  ['ใบลด/เพิ่มหนี้: ขอ', 'credit-notes:request', ['owner', 'admin', 'invoicer', 'accounting']],
  ['ใบลด/เพิ่มหนี้: อนุมัติ', 'credit-notes:approve', ['owner', 'manager', 'approver']],
  [
    'Settlement: สร้าง',
    'settlements:create',
    ['owner', 'admin', 'dispatcher', 'invoicer', 'accounting'],
  ],
  [
    'Settlement: อนุมัติ',
    'settlements:approve',
    ['owner', 'admin', 'manager', 'accounting', 'approver'],
  ],
  ['Settlement: จ่าย', 'settlements:pay', ['owner', 'admin', 'accounting']],
  [
    'Integration retry',
    'integrations:retry',
    ['owner', 'admin', 'invoicer', 'accounting', 'approver'],
  ],
  [
    'Integration log อ่าน',
    'integrations:read',
    ['owner', 'admin', 'manager', 'invoicer', 'accounting', 'approver', 'viewer'],
  ],
  [
    'รายงานการเงิน',
    'reports.finance:read',
    ['owner', 'admin', 'manager', 'invoicer', 'accounting', 'approver'],
  ],
  [
    'รายงานปฏิบัติการ',
    'reports.ops:read',
    [
      'owner',
      'admin',
      'manager',
      'planner',
      'dispatcher',
      'invoicer',
      'accounting',
      'approver',
      'viewer',
    ],
  ],
  [
    'Export ข้อมูล',
    'export:run',
    ['owner', 'admin', 'manager', 'planner', 'invoicer', 'accounting'],
  ],
  ['Audit log', 'audit:read', ['owner', 'admin', 'manager']],
  ['Audit log ของบัญชี', 'audit.accounting:read', ['owner', 'admin', 'accounting']],
];

describe('A3 role × permission', () => {
  it.each(A3)('%s (%s)', (_row, scope, allowed) => {
    for (const code of ROLE_CODES) {
      const got = scopeAllows(SYSTEM_ROLES[code].permissions, scope);
      expect([code, got]).toEqual([code, allowed.includes(code)]);
    }
  });

  it('ทุก role ใช้เฉพาะสิทธิ์ที่อยู่ในรายการ และไม่ซ้ำ', () => {
    for (const code of ROLE_CODES) {
      const ps = SYSTEM_ROLES[code].permissions;
      expect(new Set(ps).size).toBe(ps.length);
      for (const p of ps) expect(PERMISSIONS).toContain(p);
    }
  });

  it('scopeAllows: * และ resource:*', () => {
    expect(scopeAllows(['*'], 'x:y')).toBe(true);
    expect(scopeAllows(['orders:*'], 'orders:cancel')).toBe(true);
    expect(scopeAllows(['orders:write'], 'orders:read')).toBe(false);
  });
});
