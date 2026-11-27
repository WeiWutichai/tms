import type { TenantStatus } from '@prisma/client';

/**
 * P1-ST1-T03 สถานะ tenant 7 ค่า (R-10 · spec/01 PLT-010) + ความสามารถตามสถานะ (spec/01 ตาราง 1.6)
 * ทุกโค้ดที่ตัดสินจากสถานะ tenant ใช้ชุดค่าจากไฟล์นี้ — ห้ามเขียนรายการสถานะเองในโมดูลอื่น
 */
export const TENANT_STATUSES = [
  'PENDING_VERIFICATION',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'READ_ONLY',
  'SUSPENDED',
  'CANCELLED',
] as const satisfies readonly TenantStatus[];

/**
 * login เข้าแอป + token/session เดิมยังใช้ได้ (ตาราง 1.6 แถว "login")
 * `suspended`/`cancelled` = L (เฉพาะหน้าแพ็กเกจ/ชำระเงิน/ขอ export) — หน้าเหล่านั้นยังไม่มี (P1-ST3/ST4) จึงยังเข้าไม่ได้เลย
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (เหมือนก่อน T03 — เปิดเมื่อมีหน้าชำระเงิน)
 */
export const LOGIN_TENANT_STATUSES = [
  'PENDING_VERIFICATION',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'READ_ONLY',
] as const satisfies readonly TenantStatus[];

/** สร้าง/แก้ข้อมูลได้ (ตาราง 1.6 "สร้าง/แก้ SO, DO, เที่ยว, เอกสาร") — นอกชุดนี้ guard ตอบ 403 `tenant_read_only` */
export const WRITE_TENANT_STATUSES = [
  'PENDING_VERIFICATION',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
] as const satisfies readonly TenantStatus[];

/** Open API / API key (ตาราง 1.6 "Open API/MCP": pending ✗ · read_only อ่านอย่างเดียว · suspended/cancelled ✗) */
export const API_TENANT_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'READ_ONLY',
] as const satisfies readonly TenantStatus[];

/**
 * งานประจำที่เขียนข้อมูลของ tenant (เตือน/สรุป/ค่าเสื่อม/หมดเวลาข้อเสนอ) — สถานะที่เขียนได้เท่านั้น
 * read_only/suspended/cancelled ไม่รันงานเบื้องหลัง [DECISION — lead 27 พ.ย. 2569, ย้อนได้]
 */
export const JOB_TENANT_STATUSES = WRITE_TENANT_STATUSES;

/** webhook ขาออก / connector sync (ตาราง 1.6: pending ✗ · read_only ✗ คิวพักส่งต่อเมื่อ active · suspended/cancelled ✗) */
export const SYNC_TENANT_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
] as const satisfies readonly TenantStatus[];

const has = (list: readonly string[], s: string | null | undefined) => !!s && list.includes(s);
export const canLogin = (s: string | null | undefined) => has(LOGIN_TENANT_STATUSES, s);
export const canWrite = (s: string | null | undefined) => has(WRITE_TENANT_STATUSES, s);
export const canUseApi = (s: string | null | undefined) => has(API_TENANT_STATUSES, s);
export const canRunJobs = (s: string | null | undefined) => has(JOB_TENANT_STATUSES, s);
export const canSync = (s: string | null | undefined) => has(SYNC_TENANT_STATUSES, s);

/** ค่าที่ API/UI ใช้ (`trialing`, `read_only`, …) — spec/01 PLT-010 */
export const tenantStatusOut = (s: TenantStatus) => s.toLowerCase();

/**
 * enum ใน OpenAPI ของ field สถานะ tenant: 7 ค่า + `trial` (ค่าเดิมก่อน T03 — ไม่ส่งแล้ว คงไว้ในเอกสารเพื่อไม่ให้ OpenAPI diff gate นับเป็น
 * breaking; client ต้องรับค่า enum ใหม่ได้ตาม ST7-T07) [DECISION — lead 27 พ.ย. 2569, ย้อนได้ · ยังไม่มี production (D-76) จึงไม่ทำ version gate]
 */
export const TENANT_STATUS_ENUM_DOC = [...TENANT_STATUSES.map((x) => x.toLowerCase()), 'trial'];
export const TENANT_STATUS_DOC =
  'สถานะบัญชีบริษัท 7 ค่า (P1-ST1-T03 · spec/01 PLT-010) — `trial` = ค่าเดิมก่อน 27 พ.ย. 2569 ไม่ส่งแล้ว (ใช้ `trialing`)';

export type DunningKind = 'invoice' | 'trial';
export type DunningStage = 'PAST_DUE' | 'READ_ONLY' | 'SUSPENDED' | 'CANCELLED';

/** ค่าตั้ง dunning (PlatformSetting — D-45) */
export interface DunningSettings {
  /** `dunning.pastDueDays` (7) */
  pastDueDays: number;
  /** `dunning.readOnlyUntilDay` (21) */
  readOnlyUntilDay: number;
  /** `dunning.suspendUntilDay` (60) */
  suspendUntilDay: number;
  /** `trialExpiry.readOnlyDays` (14) */
  trialReadOnlyDays: number;
}

/**
 * สถานะเป้าหมายของ tenant ในช่วง dunning — `day` = จำนวนวัน (ปฏิทินไทย) นับจากวัน 0
 * - invoice (PLT-011): วัน 0 = วันครบกำหนดชำระ · past_due ถึงวัน pastDueDays → read_only ถึง readOnlyUntilDay →
 *   suspended ถึง suspendUntilDay → cancelled (ค่าเริ่มต้น 0–7 / 8–21 / 22–60 / 61)
 * - trial (PLT-012): วัน 0 = วันหมด trial · ข้าม past_due · read_only วันที่ 1…trialReadOnlyDays → suspended ถึง suspendUntilDay →
 *   cancelled (ค่าเริ่มต้น read_only วัน 1–14 / suspended 15–60 / cancelled 61)
 *   "วัน trial+1 → read_only" (plan/13 P1-ST1-T03) [DECISION — lead 27 พ.ย. 2569, ย้อนได้]
 */
export function dunningStage(kind: DunningKind, day: number, s: DunningSettings): DunningStage {
  if (day > s.suspendUntilDay) return 'CANCELLED';
  if (kind === 'invoice') {
    if (day <= s.pastDueDays) return 'PAST_DUE';
    if (day <= s.readOnlyUntilDay) return 'READ_ONLY';
    return 'SUSPENDED';
  }
  return day <= s.trialReadOnlyDays ? 'READ_ONLY' : 'SUSPENDED';
}

/** ลำดับของช่วง dunning — cron เดินหน้าอย่างเดียว (ไม่ถอยสถานะที่ทีมงานระงับไว้) */
export const DUNNING_RANK: Record<string, number> = {
  TRIALING: 0,
  ACTIVE: 0,
  PAST_DUE: 1,
  READ_ONLY: 2,
  SUSPENDED: 3,
  CANCELLED: 4,
};
const ORDER: DunningStage[] = ['PAST_DUE', 'READ_ONLY', 'SUSPENDED', 'CANCELLED'];

/**
 * ขั้นที่ต้องเดินจากสถานะปัจจุบันถึงเป้าหมาย (ทีละขั้น — ประวัติมีครบทุกขั้นแม้ cron ไม่ได้รันหลายวัน: spec/01 §1.8 "รันย้อนตามวันจริง")
 * trial ข้าม past_due · เป้าหมายต่ำกว่าปัจจุบัน = ไม่มีขั้น
 */
export function dunningSteps(
  current: TenantStatus,
  kind: DunningKind,
  target: DunningStage,
): DunningStage[] {
  const from = DUNNING_RANK[current];
  if (from === undefined) return [];
  return ORDER.filter(
    (s) =>
      DUNNING_RANK[s]! > from &&
      DUNNING_RANK[s]! <= DUNNING_RANK[target]! &&
      !(kind === 'trial' && s === 'PAST_DUE'),
  );
}

/**
 * การเปลี่ยนที่อนุญาต (spec/01 §1 ข้อ 6) — ปลดระงับกลับ "สถานะก่อนหน้า" จึงเปิดจาก SUSPENDED ไปได้ทุกสถานะที่ยังใช้งาน
 */
export const TENANT_TRANSITIONS: Record<TenantStatus, readonly TenantStatus[]> = {
  PENDING_VERIFICATION: ['TRIALING', 'CANCELLED', 'SUSPENDED'],
  TRIALING: ['ACTIVE', 'READ_ONLY', 'SUSPENDED', 'CANCELLED'],
  ACTIVE: ['PAST_DUE', 'SUSPENDED', 'CANCELLED'],
  PAST_DUE: ['ACTIVE', 'READ_ONLY', 'SUSPENDED'],
  READ_ONLY: ['ACTIVE', 'SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'CANCELLED', 'PENDING_VERIFICATION', 'TRIALING', 'PAST_DUE', 'READ_ONLY'],
  CANCELLED: ['ACTIVE'],
};

export const transitionAllowed = (from: TenantStatus, to: TenantStatus) =>
  TENANT_TRANSITIONS[from].includes(to);

/**
 * `subscription.status` ตาม `tenant.status` (spec/10: tenant = สิทธิ์การใช้งาน, subscription = สถานะการเงิน)
 * read_only/suspended จาก dunning = ค้างชำระ (`past_due`) · ระงับด้วยมือ (ไม่มี dunning) = คงสถานะการเงินเดิม
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (CHECK ของ subscription มี 4 ค่า: trialing/active/past_due/cancelled)
 */
export function subscriptionStatusFor(
  status: TenantStatus,
  dunningKind: string | null,
  current: string | null,
): string {
  switch (status) {
    case 'PENDING_VERIFICATION':
    case 'TRIALING':
      return 'trialing';
    case 'ACTIVE':
      return 'active';
    case 'PAST_DUE':
      return 'past_due';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return dunningKind ? 'past_due' : (current ?? 'active');
  }
}
