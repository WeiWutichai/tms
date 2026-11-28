import type { TenantStatus } from '@prisma/client';

/**
 * ชั้นของ entitlement ตาม spec/01 PLT-062 (P1-ST1-T02) — ฟังก์ชันบริสุทธิ์ ไม่แตะฐาน ทดสอบเป็นตารางได้
 *
 *   PlanEntitlement (เวอร์ชันของ subscription) → SubscriptionAddOn (เปิด/เพิ่ม limit) → TenantEntitlementOverride ที่ยังไม่หมดอายุ
 *   (grant / revoke / set_limit) → ตัดตามสถานะ tenant (ตาราง 1.6)
 *
 * ผลก่อนชั้นสถานะ (`beforeStatus`) ใช้ตัดสินว่าเมนูขึ้น 🔒 หรือไม่ (PLT-076) — ฟีเจอร์ที่แพ็กเกจมีแต่ถูกตัดเพราะสถานะ
 * ไม่ใช่ "ไม่รวมในแพ็กเกจ" (banner สถานะ/หน้าชำระเงินเป็นคนบอก — P1-ST1-T05) · ฟีเจอร์พื้นฐาน (isBasic) ไม่ขึ้น 🔒 ทุกกรณี (PLT-077)
 */
export interface Entitlement {
  enabled: boolean;
  /** null = ไม่จำกัด (หรือฟีเจอร์แบบเปิด/ปิด) */
  limit: number | null;
}
export type Entitlements = Record<string, Entitlement>;

export interface PlanRow {
  featureKey: string;
  mode: string; // included | addon | not_available
  limit: number | null;
}

/**
 * add-on ที่ tenant ซื้อและยังมีผล (spec/01 §6 `SubscriptionAddOn`) — ตาราง add-on เป็นของ P1-ST4-T04
 * quantity ของฟีเจอร์แบบ limit = จำนวนที่เพิ่ม (เช่น connector บัญชี +1 — เกณฑ์ตรวจรับ P1-ST4-T04) · ฟีเจอร์เปิด/ปิด = เปิด
 */
export interface AddOnGrant {
  featureKey: string;
  quantity: number;
  endAt: Date | null;
}

export interface OverrideRow {
  featureKey: string;
  mode: string; // grant | revoke | set_limit
  limit: number | null;
  expiresAt: Date | null;
}

/** ชั้น 1: แพ็กเกจ — `addon` / `not_available` = ปิด (add-on เปิดในชั้น 2) */
export function planLayer(rows: PlanRow[]): Entitlements {
  const out: Entitlements = {};
  for (const r of rows) out[r.featureKey] = { enabled: r.mode === 'included', limit: r.limit };
  return out;
}

/**
 * ชั้น 2: add-on (PLT-062 "เพิ่ม limit/เปิด") — ฟีเจอร์ที่ปิดอยู่: เปิด และ limit = quantity (ฟีเจอร์ limit) ·
 * ฟีเจอร์ที่เปิดแล้วและมี limit: limit + quantity · ไม่จำกัดอยู่แล้ว: คงเดิม · `limitTyped` = ฟีเจอร์ชนิด limit/metered ในแคตตาล็อก
 */
export function addOnLayer(
  base: Entitlements,
  addOns: AddOnGrant[],
  limitTyped: ReadonlySet<string>,
  now: Date,
): Entitlements {
  const out: Entitlements = { ...base };
  for (const a of addOns) {
    if (a.endAt && a.endAt <= now) continue;
    const cur = out[a.featureKey] ?? { enabled: false, limit: null };
    const typed = limitTyped.has(a.featureKey);
    if (!cur.enabled) out[a.featureKey] = { enabled: true, limit: typed ? a.quantity : null };
    else if (typed && cur.limit !== null)
      out[a.featureKey] = { enabled: true, limit: cur.limit + a.quantity };
  }
  return out;
}

/**
 * ชั้น 3: override ที่ยังไม่หมดอายุ (`expiresAt > now`) — grant ไม่ระบุ limit บนฟีเจอร์ที่ปิดอยู่ใช้ `grantLimit(key)`
 * (limit สูงสุดในแพ็กเกจที่มีผล — ไม่กลายเป็นไม่จำกัด; ST1-T18)
 */
export function overrideLayer(
  base: Entitlements,
  overrides: OverrideRow[],
  grantLimit: (key: string) => number | null,
  now: Date,
): Entitlements {
  const out: Entitlements = { ...base };
  for (const o of overrides) {
    if (o.expiresAt && o.expiresAt <= now) continue;
    const cur = out[o.featureKey] ?? { enabled: false, limit: null };
    if (o.mode === 'grant')
      out[o.featureKey] = {
        enabled: true,
        limit: o.limit ?? (cur.enabled ? cur.limit : grantLimit(o.featureKey)),
      };
    else if (o.mode === 'revoke') out[o.featureKey] = { enabled: false, limit: cur.limit };
    else if (o.mode === 'set_limit') out[o.featureKey] = { ...cur, limit: o.limit };
  }
  return out;
}

/**
 * ชั้น 4: ตัดตามสถานะ tenant (spec/01 ตาราง 1.6) — enum 7 ค่าของ P1-ST1-T03 (`TenantStatus`, `tenants/tenant-status.ts`)
 * - `suspended` / `cancelled`: ไม่มีฟีเจอร์ใดทำงาน (API/webhook/sync/job ข้ามหมด) — รวมฟีเจอร์พื้นฐาน (PLT-077: ข้อจำกัดเดียวของพื้นฐาน = สถานะ)
 * - `pending_verification`: Open API/MCP, webhook ขาออก, connector ปิด · รถ active ≤ 5 (PLT-014 [PROPOSED])
 * - `read_only`: **ไม่ตัดที่ entitlement** — webhook/connector ต้อง "พักคิว ส่งต่อเมื่อ active" (ตาราง 1.6) ถ้าปิด entitlement
 *   job จะถูกข้ามทิ้ง · guard เขียนไม่ได้ (`tenant_read_only`) = AuthGuard ของ P1-ST1-T03 · พักคิว = แถว P1-ST1-T03 ใน plan/13
 * - `trialing` / `active` / `past_due`: ตามแพ็กเกจ
 */
export const PENDING_VERIFICATION_OFF = ['api', 'webhook', 'conn'] as const;
export const PENDING_VERIFICATION_VEHICLES = 5;

export function statusLayer(base: Entitlements, status: TenantStatus): Entitlements {
  if (status === 'SUSPENDED' || status === 'CANCELLED') return {};
  if (status === 'PENDING_VERIFICATION') {
    const out: Entitlements = { ...base };
    for (const k of PENDING_VERIFICATION_OFF)
      if (out[k]) out[k] = { enabled: false, limit: out[k].limit };
    const veh = out.veh;
    if (veh)
      out.veh = {
        enabled: veh.enabled,
        limit:
          veh.limit === null
            ? PENDING_VERIFICATION_VEHICLES
            : Math.min(veh.limit, PENDING_VERIFICATION_VEHICLES),
      };
    return out;
  }
  return base;
}

/** เวลาที่ผลลัพธ์จะเปลี่ยนเองครั้งถัดไป (override/add-on หมดอายุ) — ใช้ตัดอายุ cache ให้หมดตรงเวลา (null = ไม่มี) */
export function nextExpiry(
  overrides: { expiresAt: Date | null }[],
  addOns: { endAt: Date | null }[],
  now: Date,
): Date | null {
  let min: number | null = null;
  for (const t of [...overrides.map((o) => o.expiresAt), ...addOns.map((a) => a.endAt)])
    if (t && t > now && (min === null || t.getTime() < min)) min = t.getTime();
  return min === null ? null : new Date(min);
}
