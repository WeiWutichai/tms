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
  /** scope ที่ต้องมีอย่างน้อย 1 ตัว (ตาราง A3) — ไม่มี = ทุกคนเห็น */
  perm?: string[];
  /** ฟีเจอร์ของแพ็กเกจที่ต้องเปิด (ST1-T18 — /v1/me features) */
  feature?: string;
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
  perm?: string[];
  feature?: string;
}

export const NAV: NavGroup[] = [
  {
    key: 'fav',
    label: 'nav.fav',
    icon: 'star',
    kids: [
      {
        key: 'fav-so',
        perm: ['orders:read'],
        page: 'so',
        label: 'nav.fav.soRoute',
        path: '/so?tab=route',
        stage: 'ST3',
      },
      {
        key: 'fav-inv',
        perm: ['invoices:read'],
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
      {
        key: 'plan',
        perm: ['trips:read'],
        page: 'plan',
        label: 'nav.ops.plan',
        path: '/plan',
        stage: 'ST3',
      },
      {
        key: 'trips',
        perm: ['trips:read'],
        page: 'trips',
        label: 'nav.ops.trips',
        path: '/trips',
        stage: 'ST3',
      },
      {
        key: 'so',
        perm: ['orders:read'],
        page: 'so',
        label: 'nav.ops.so',
        path: '/so',
        stage: 'ST3',
      },
      {
        key: 'do',
        perm: ['orders:read'],
        page: 'do',
        label: 'nav.ops.do',
        path: '/do',
        stage: 'ST3',
      },
      {
        key: 'sub',
        feature: 'sub',
        perm: ['trips:read'],
        page: 'sub',
        label: 'nav.ops.sub',
        path: '/sub',
        stage: 'ST3',
      },
    ],
  },
  {
    key: 'acc',
    label: 'nav.acc',
    icon: 'receipt',
    sepBefore: true,
    kids: [
      {
        key: 'bill',
        perm: ['invoices:read'],
        page: 'bill',
        label: 'nav.acc.bill',
        path: '/bill',
        stage: 'ST5',
      },
      {
        key: 'pay',
        perm: ['invoices:read'],
        page: 'pay',
        label: 'nav.acc.pay',
        path: '/pay',
        stage: 'ST5',
      },
      {
        key: 'settle',
        feature: 'settle',
        perm: ['settlements:read'],
        page: 'settle',
        label: 'nav.acc.settle',
        path: '/settle',
        stage: 'ST6',
      },
    ],
  },
  {
    key: 'fleet',
    label: 'nav.fleet',
    icon: 'car-front',
    sepBefore: true,
    kids: [
      {
        key: 'fveh',
        feature: 'fleet',
        perm: ['master:read'],
        page: 'fveh',
        label: 'nav.fleet.fveh',
        path: '/fleet/vehicles',
        stage: 'ST2',
      },
      {
        key: 'fdoc',
        feature: 'fleet',
        perm: ['master:read'],
        page: 'fdoc',
        label: 'nav.fleet.fdoc',
        path: '/fleet/documents',
        stage: 'ST2',
      },
      {
        key: 'veh',
        perm: ['master:read'],
        page: 'veh',
        label: 'nav.fleet.veh',
        path: '/fleet/drivers',
        stage: 'ST2',
      },
    ],
  },
  {
    key: 'report',
    feature: 'report',
    perm: ['reports.ops:read', 'reports.finance:read'],
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
        perm: ['master:read'],
        page: 'cust',
        label: 'nav.master.cust',
        path: '/master/customers',
        stage: 'ST2',
      },
      {
        key: 'loc',
        perm: ['master:read'],
        page: 'loc',
        label: 'nav.master.loc',
        path: '/master/locations',
        stage: 'ST2',
      },
      // ST2-T09: ต้นแบบไม่มีหน้าเส้นทาง (docs/03 รวม "จุดส่ง+เส้นทาง") → หน้าแยกต่อจากสถานที่ [OPEN spec/12 §3]
      {
        key: 'route',
        perm: ['master:read'],
        page: 'route',
        label: 'nav.master.route',
        path: '/master/routes',
        stage: 'ST2',
      },
      {
        key: 'prod',
        perm: ['master:read'],
        page: 'prod',
        label: 'nav.master.prod',
        path: '/master/products',
        stage: 'ST2',
      },
      {
        key: 'vtype',
        perm: ['master:read'],
        page: 'vtype',
        label: 'nav.master.vtype',
        path: '/master/vehicle-types',
        stage: 'ST2',
      },
      {
        key: 'accsr',
        perm: ['master:read'],
        page: 'accsr',
        label: 'nav.master.accsr',
        path: '/master/accessorials',
        stage: 'ST2',
      },
      {
        key: 'rate',
        perm: ['master:read'],
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
        // ST2-T12: master:read เห็น "ตั้งค่า" เพื่อเข้าหัวข้อ "เหตุผล" (ข้อมูลหลัก) — หัวข้ออื่นกรองสิทธิ์ต่อหัวข้อใน Settings.tsx
        perm: ['settings:read', 'settings:write', 'users:read', 'master:read'],
        page: 'settings',
        label: 'nav.setg.settings',
        path: '/settings',
        stage: 'ST1',
      },
    ],
  },
  { key: 'ds', page: 'ds', label: 'nav.ds', icon: 'palette', path: '/design-system', stage: 'ST0' },
];

/** หน้าย่อยที่ไม่อยู่ในเมนู → key ของหน้า (META) + path ของเมนูแม่ (สิทธิ์/แพ็กเกจเดียวกัน) */
const SUBPAGES: { re: RegExp; page: string; parent: string }[] = [
  { re: /^\/fleet\/vehicles\/[^/]+$/, page: 'fprof', parent: '/fleet/vehicles' },
];
export const parentOf = (pathname: string) =>
  SUBPAGES.find((x) => x.re.test(pathname))?.parent ?? pathname;

/** หา key ของหน้า (META) จาก path */
export function pageOf(pathname: string): string | undefined {
  const subpage = SUBPAGES.find((x) => x.re.test(pathname));
  if (subpage) return subpage.page;
  for (const g of NAV) {
    if (g.path && g.path === pathname) return g.page;
    for (const k of g.kids ?? [])
      if (k.path.split('?')[0] === pathname && g.key !== 'fav') return k.page;
  }
  return undefined;
}

/** scope ที่ได้รับครอบ scope ที่ต้องการไหม — ตรรกะเดียวกับ scopeAllows ใน packages/domain/src/permissions.ts */
export function can(scopes: readonly string[], required: string): boolean {
  if (scopes.includes('*') || scopes.includes(required)) return true;
  return scopes.includes(`${required.split(':')[0]}:*`);
}
export const canAny = (scopes: readonly string[], perm?: string[]) =>
  !perm || perm.some((p) => can(scopes, p));

/** เมนูที่ผู้ใช้เห็นตามสิทธิ์ (PLT-132: ซ่อนที่ UI + API ตอบ 403 — UI ไม่ใช่ด่านเดียว) */
export function navFor(scopes: readonly string[]): NavGroup[] {
  return NAV.filter((g) => canAny(scopes, g.perm))
    .map((g) => (g.kids ? { ...g, kids: g.kids.filter((k) => canAny(scopes, k.perm)) } : g))
    .filter((g) => !g.kids || g.kids.length > 0);
}

/** สิทธิ์ที่ต้องใช้ของ path (ใช้กันเข้าทาง URL ตรง) */
export function permOf(path: string): string[] | undefined {
  const pathname = parentOf(path);
  for (const g of NAV) {
    if (g.path && g.path === pathname) return g.perm;
    for (const k of g.kids ?? []) if (k.path.split('?')[0] === pathname) return k.perm;
  }
  return undefined;
}

/** ฟีเจอร์ของแพ็กเกจที่ path นี้ต้องใช้ (ST1-T18) */
export function featureOf(path: string): string | undefined {
  const pathname = parentOf(path);
  for (const g of NAV) {
    if (g.path && g.path === pathname) return g.feature;
    for (const k of g.kids ?? []) if (k.path.split('?')[0] === pathname) return k.feature;
  }
  return undefined;
}

/** ฟีเจอร์ที่ยังไม่อยู่ในแพ็กเกจ → แสดงเมนูพร้อมไอคอน 🔒 (ไม่ซ่อน — spec/01 PLT-076, ต้นแบบ lockOf) */
export const isLocked = (feature: string | undefined, features?: readonly string[]) =>
  !!feature && !!features && !features.includes(feature);
