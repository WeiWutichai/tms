import type { MessageKey } from './i18n/th';

/**
 * เมนู — โครงและไอคอนตาม vNav() ของต้นแบบ (TMS v4) · แสดงเฉพาะหน้าที่อยู่ในเฟส 0 (PLAN.md §3)
 * หน้าที่ต้นแบบมีแต่อยู่นอกเฟส 0 (ติดตามรถ, ศูนย์ข้อยกเว้น, กล่องรับงาน, เงินเบิกคนขับ, ใบสั่งซ่อม, น้ำมัน, ยาง ฯลฯ,
 * Open API ฝั่งลูกค้า, ฟิลด์เพิ่มเติม, แพ็กเกจ) ไม่อยู่ในรายการนี้ — เพิ่มเมื่อเจ้าของอนุมัติเข้าเฟส
 * `stage` = stage ใน plan/01-phase0-backlog.md ที่ทำหน้านั้น (ใช้แสดงในหน้า "ยังไม่เปิดใช้")
 * รายการเมนูเฟส 0 นี้ต้องทบทวนใน ST0-T19 พร้อมตารางตัดสินขอบเขต
 */
export interface NavItem {
  key: string;
  /** key ของ META หน้า (ชื่อ/กลุ่ม/คำอธิบาย) */
  page: string;
  label: MessageKey;
  path: string;
  stage: string;
}
export interface NavGroup {
  key: string;
  page?: string;
  label: MessageKey;
  icon: string;
  path?: string;
  stage?: string;
  kids?: NavItem[];
  sepBefore?: boolean;
  devOnly?: boolean;
}

export const NAV: NavGroup[] = [
  {
    key: 'fav',
    label: 'nav.fav',
    icon: 'star',
    kids: [
      { key: 'fav-so', page: 'so', label: 'nav.fav.soRoute', path: '/so?tab=route', stage: 'ST3' },
      {
        key: 'fav-inv',
        page: 'pay',
        label: 'nav.fav.invOver',
        path: '/pay?tab=over',
        stage: 'ST5',
      },
    ],
  },
  {
    key: 'dash',
    page: 'dash',
    label: 'nav.dash',
    icon: 'layout-dashboard',
    path: '/',
    stage: 'ST9',
  },
  {
    key: 'ops',
    label: 'nav.ops',
    icon: 'truck',
    sepBefore: true,
    kids: [
      { key: 'plan', page: 'plan', label: 'nav.ops.plan', path: '/plan', stage: 'ST3' },
      { key: 'trips', page: 'trips', label: 'nav.ops.trips', path: '/trips', stage: 'ST3' },
      { key: 'so', page: 'so', label: 'nav.ops.so', path: '/so', stage: 'ST3' },
      { key: 'do', page: 'do', label: 'nav.ops.do', path: '/do', stage: 'ST3' },
      { key: 'sub', page: 'sub', label: 'nav.ops.sub', path: '/sub', stage: 'ST3' },
    ],
  },
  {
    key: 'acc',
    label: 'nav.acc',
    icon: 'receipt',
    sepBefore: true,
    kids: [
      { key: 'bill', page: 'bill', label: 'nav.acc.bill', path: '/bill', stage: 'ST5' },
      { key: 'pay', page: 'pay', label: 'nav.acc.pay', path: '/pay', stage: 'ST5' },
      { key: 'settle', page: 'settle', label: 'nav.acc.settle', path: '/settle', stage: 'ST6' },
    ],
  },
  {
    key: 'fleet',
    label: 'nav.fleet',
    icon: 'car-front',
    sepBefore: true,
    kids: [
      { key: 'fveh', page: 'fveh', label: 'nav.fleet.fveh', path: '/fleet/vehicles', stage: 'ST2' },
      {
        key: 'fdoc',
        page: 'fdoc',
        label: 'nav.fleet.fdoc',
        path: '/fleet/documents',
        stage: 'ST2',
      },
      { key: 'veh', page: 'veh', label: 'nav.fleet.veh', path: '/fleet/drivers', stage: 'ST2' },
    ],
  },
  {
    key: 'report',
    page: 'report',
    label: 'nav.report',
    icon: 'chart-column',
    path: '/reports',
    stage: 'ST9',
    sepBefore: true,
  },
  {
    key: 'master',
    label: 'nav.master',
    icon: 'database',
    kids: [
      {
        key: 'cust',
        page: 'cust',
        label: 'nav.master.cust',
        path: '/master/customers',
        stage: 'ST2',
      },
      { key: 'loc', page: 'loc', label: 'nav.master.loc', path: '/master/locations', stage: 'ST2' },
      {
        key: 'vtype',
        page: 'vtype',
        label: 'nav.master.vtype',
        path: '/master/vehicle-types',
        stage: 'ST2',
      },
      {
        key: 'accsr',
        page: 'accsr',
        label: 'nav.master.accsr',
        path: '/master/accessorials',
        stage: 'ST2',
      },
      {
        key: 'rate',
        page: 'rate',
        label: 'nav.master.rate',
        path: '/master/rate-cards',
        stage: 'ST2',
      },
    ],
  },
  {
    key: 'setg',
    label: 'nav.setg',
    icon: 'settings',
    kids: [
      {
        key: 'settings',
        page: 'settings',
        label: 'nav.setg.settings',
        path: '/settings',
        stage: 'ST1',
      },
    ],
  },
  { key: 'ds', page: 'ds', label: 'nav.ds', icon: 'palette', path: '/design-system', stage: 'ST0' },
];

/** หา key ของหน้า (META) จาก path */
export function pageOf(pathname: string): string | undefined {
  for (const g of NAV) {
    if (g.path && g.path === pathname) return g.page;
    for (const k of g.kids ?? [])
      if (k.path.split('?')[0] === pathname && g.key !== 'fav') return k.page;
  }
  return undefined;
}
