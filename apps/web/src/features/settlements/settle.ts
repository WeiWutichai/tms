import type { T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { ApiError } from '../../api';
import { fieldErrors, problemText } from '../master/problems';
import { money } from '../rate-cards/rateFormat';
import type { Settlement, SettlementKpi } from './useSettlements';

export type SettleStatus =
  'DRAFT' | 'SENT_TO_CARRIER' | 'DISPUTED' | 'APPROVED' | 'PAID' | 'CANCELLED';

/**
 * แท็บของต้นแบบ (ทั้งหมด · รอตรวจ · รออนุมัติ · อนุมัติแล้ว · จ่ายแล้ว) → สถานะตาม docs/01 §4.5 [DECISION spec/12 §3 แถว D-63/หน้า settle]
 * - รอตรวจ = ร่าง (บัญชีตรวจ/เตรียม) + มีรายการโต้แย้ง (บัญชีต้องเคลียร์ก่อน)
 * - รออนุมัติ = ส่งให้รถร่วมตรวจแล้ว (อนุมัติได้เมื่อไม่มีรายการโต้แย้ง)
 * - ยกเลิก = แสดงเฉพาะแท็บ "ทั้งหมด"
 */
export const TABS = ['all', 'chk', 'appr', 'ok', 'paid'] as const;
export type Tab = (typeof TABS)[number];
export const TAB_STATUS: Record<Tab, string> = {
  all: '',
  chk: 'DRAFT,DISPUTED',
  appr: 'SENT_TO_CARRIER',
  ok: 'APPROVED',
  paid: 'PAID',
};

/** จำนวนใบของสถานะหนึ่งจาก `GET /settlements/summary` (ตัวนับเดียวกับแท็บ/การ์ด — หน้า settle และ Dashboard AP ST9-T03) */
export function statusCount(kpi: SettlementKpi, status: string): number {
  switch (status) {
    case 'DRAFT':
      return kpi.draft;
    case 'SENT_TO_CARRIER':
      return kpi.sentToCarrier;
    case 'DISPUTED':
      return kpi.disputed;
    case 'APPROVED':
      return kpi.approved;
    case 'PAID':
      return kpi.paid;
    case 'CANCELLED':
      return kpi.cancelled;
    default:
      return 0;
  }
}
/** จำนวนใบของชุดสถานะคั่นด้วย , (ค่าของ `TAB_STATUS`) — '' = ทุกใบ */
export const countOf = (kpi: SettlementKpi, statuses: string): number =>
  statuses ? statuses.split(',').reduce((n, s) => n + statusCount(kpi, s), 0) : kpi.total;

/**
 * ST9-T03 ตัวกรอง `status` ที่ส่งให้ `GET /settlements` = แท็บ ∩ ตัวกรองคอลัมน์ "สถานะ" (กรองที่ server — ยอดรวม/หน้าถูกต้อง
 * เดิมกรองเฉพาะแถวในหน้าปัจจุบัน) · ไม่มีส่วนร่วม (เช่น แท็บรอตรวจ + จ่ายแล้ว) = null → ไม่ยิง API รายการว่าง
 */
export function listStatus(tab: Tab, st: string): string | null {
  const base = TAB_STATUS[tab];
  if (!st) return base;
  if (!base) return st;
  return base.split(',').includes(st) ? st : null;
}

export const statusLabel = (t: T, s: string) => t(`settle.st.${s}` as MessageKey);

/** โทนป้าย: ใช้แผนที่ป้ายของต้นแบบ (status-map) · "มีรายการโต้แย้ง" ไม่อยู่ในแผนที่ → แดงแบบ "ไม่ตรง" */
export const statusTone = (s: string): 'err' | undefined => (s === 'DISPUTED' ? 'err' : undefined);

/** อนุมัติได้ตาม docs/01 §4.5 (DRAFT ตรง / SENT_TO_CARRIER) — กติกาอื่น (SoD, โต้แย้ง, ค่าตั้งบริษัท) server ตัดสินและตอบข้อความไทย */
export const canApproveStatus = (s: string) => s === 'DRAFT' || s === 'SENT_TO_CARRIER';
export const canPayStatus = (s: string) => s === 'APPROVED';
/** D-59/D-63: ออกลิงก์ใหม่ได้เมื่อใบออกไปถึงรถร่วมแล้ว — SENT_TO_CARRIER/DISPUTED = ลิงก์ตรวจ · APPROVED/PAID = ดูอย่างเดียว */
export const canRelinkStatus = (s: string) =>
  s === 'SENT_TO_CARRIER' || s === 'DISPUTED' || s === 'APPROVED' || s === 'PAID';
export const viewOnlyLink = (s: string) => s === 'APPROVED' || s === 'PAID';
export const canPrintStatus = (s: string) => s !== 'CANCELLED';

const cents = (v: string | null | undefined) => Math.round(Number(v ?? '0') * 100);
/** คอลัมน์ "หัก" ของต้นแบบ (saTot.ded) = หัก ณ ที่จ่าย + รายการหัก */
export function deductTotal(x: {
  buyWhtAmount?: string | null;
  buyDeductionAmount?: string | null;
}): string | undefined {
  // ไม่มีสิทธิ์ราคา / ใบที่จัดแบบยื่นไม่ได้ (ไม่มียอด WHT ประมาณการ) → ไม่แสดงยอด (ไม่แสดงแค่รายการหักให้เข้าใจผิด)
  if (x.buyWhtAmount === undefined || x.buyDeductionAmount === undefined) return undefined;
  return ((cents(x.buyWhtAmount) + cents(x.buyDeductionAmount)) / 100).toFixed(2);
}

/** ข้อความไทยของ error การอนุมัติ/บันทึกจ่าย — problem → `problem.{code}` + ข้อความระดับช่อง (`field.{code}`) */
export function actionErrorText(err: unknown, t: T): string | null {
  const base = problemText(err, t);
  if (!base) return null;
  if (!(err instanceof ApiError) || err.problem.code !== 'validation_failed') return base;
  const f = Object.values(fieldErrors(err, t));
  return f.length ? f.join(' · ') : base;
}

export const isStepUp = (err: unknown) =>
  err instanceof ApiError && err.problem.code === 'step_up_required';

/**
 * แถวยอดเงินของ drawer / dialog บันทึกจ่าย (ต้นแบบ kv "ยอดซื้อรวม" · "หัก ณ ที่จ่าย 1%" · "หักเงินเบิกล่วงหน้า")
 * อัตรา WHT ตามกลุ่มอัตราของใบ (ST6-T08 — 1% / 3% ปนได้) · รายการหักแยกตามชนิด ("หัก" + ชื่อชนิดของลิงก์รถร่วม)
 */
export function amountRows(
  t: T,
  s: Settlement,
): { k: string; v: string; amount: string; strong: boolean }[] {
  // whtEstimate null = ไม่รู้ประเภทรถร่วม (API ไม่ประมาณการ) → ป้ายไม่มีอัตรา ยอด "—" (ยกเว้นยอดที่ตรึง)
  const rates = (s.whtEstimate?.byRate ?? []).map((r) => String(Number(r.whtRate)));
  const ded = new Map<string, number>();
  for (const l of s.lines)
    if (l.active && l.lineType === 'DEDUCTION' && l.deductionType)
      ded.set(l.deductionType, (ded.get(l.deductionType) ?? 0) + Math.abs(cents(l.buyAmount)));
  return [
    {
      k: t('settle.amt.buy'),
      v: money(s.buyGrossAmount),
      amount: money(s.buyGrossAmount),
      strong: true,
    },
    {
      k: rates.length ? t('settle.amt.wht', { r: rates.join(' / ') }) : t('settle.amt.whtNone'),
      v: `−${money(s.buyWhtAmount)}`,
      amount: money(s.buyWhtAmount),
      strong: true,
    },
    ...[...ded].map(([k, c]) => ({
      k: t('settle.amt.ded', { t: t(`stl.ln.deduct.${k}` as MessageKey) }),
      v: `−${money((c / 100).toFixed(2))}`,
      amount: money((c / 100).toFixed(2)),
      strong: false,
    })),
  ];
}
