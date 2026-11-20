import type { Tx } from '../../db/db.service';

/**
 * Dispute ใบสำคัญจ่ายรถร่วม (ST6-T06; docs/04 F6 "Dispute", docs/01 §4.5, spec/05 BIL-136)
 *
 * สถานะรายการ (บรรทัดที่ยังใช้ ในรอบตรวจปัจจุบัน):
 * - **DISPUTED** = โต้แย้งค้าง: คำตอบล่าสุดของรถร่วมเป็นโต้แย้งและยังไม่ถูกเคลียร์ หรือบริษัท (บัญชี) ติด dispute หลังการเคลียร์ล่าสุด
 * - **APPROVED** = รถร่วมยอมรับ หรือบริษัทเคลียร์ (ยืนยันยอดเดิมพร้อมเหตุผล) แล้ว
 * - **OPEN** = ยังไม่มีคำตอบ/ยังไม่ส่งตรวจ
 *
 * นิยาม "โต้แย้งค้าง" ที่บล็อกอนุมัติอยู่ใน DB ที่เดียว (`tms_settlement_line_disputed` / `tms_settlement_disputed_count`, migration 0130)
 * — service เรียกฟังก์ชันเดียวกับ trigger เพื่อไม่ให้สองที่คิดต่างกัน
 */
export const LINE_STATUSES = ['OPEN', 'DISPUTED', 'APPROVED'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];
/** การตัดสินฝั่งบริษัท (`settlement_line_dispute.action`) */
export const COMPANY_DISPUTE_ACTIONS = ['DISPUTED', 'RESOLVED'] as const;
export type CompanyDisputeAction = (typeof COMPANY_DISPUTE_ACTIONS)[number];
/** สถานะที่ยังรอรถร่วมตรวจ (ตอบ/ติด dispute ได้) */
export const UNDER_REVIEW = ['SENT_TO_CARRIER', 'DISPUTED'] as const;

/** จำนวนบรรทัดที่ยังใช้ซึ่งโต้แย้งค้างในรอบ (docs/01 §4.5 `disputed_count`) */
export async function disputedCount(tx: Tx, settlementId: string, round: number): Promise<number> {
  if (round < 1) return 0;
  const [r] = await tx.$queryRaw<{ n: number }[]>`
    SELECT tms_settlement_disputed_count(${settlementId}::uuid, ${round}::int) AS n`;
  return Number(r?.n ?? 0);
}

/** บรรทัดที่ยังใช้ซึ่งโต้แย้งค้างในรอบ (id ภายใน) */
export async function disputedLines(
  tx: Tx,
  settlementId: string,
  round: number,
): Promise<Set<string>> {
  if (round < 1) return new Set();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT l.id::text AS id FROM settlement_line l
     WHERE l.settlement_id = ${settlementId}::uuid AND l.voided_at IS NULL
       AND tms_settlement_line_disputed(l.id, ${round}::int)`;
  return new Set(rows.map((r) => r.id));
}

/**
 * สถานะรายการจาก (โต้แย้งค้างตาม DB) + คำตอบล่าสุดของรถร่วม + การเคลียร์ของบริษัท
 * — ไม่โต้แย้งค้าง + (รถร่วมยอมรับ หรือ บริษัทเคลียร์) = APPROVED · ไม่งั้น OPEN
 */
export function lineStatus(
  disputed: boolean,
  carrierResponse: string | null | undefined,
  resolved: boolean,
): LineStatus {
  if (disputed) return 'DISPUTED';
  if (carrierResponse === 'ACCEPTED' || resolved) return 'APPROVED';
  return 'OPEN';
}

type Ev = { id: string; lineId: string; round: number; createdAt: Date };

/** เหตุการณ์ล่าสุดต่อบรรทัดของรอบ — (createdAt, id) มากสุดชนะ (ลำดับเดียวกับ DB `ORDER BY created_at, id`) */
export function latestBy<T extends Ev>(
  rows: T[],
  round: number,
  pick: (r: T) => boolean = () => true,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    if (r.round !== round || !pick(r)) continue;
    const cur = out.get(r.lineId);
    const later =
      !cur ||
      r.createdAt.getTime() > cur.createdAt.getTime() ||
      (r.createdAt.getTime() === cur.createdAt.getTime() && r.id > cur.id);
    if (later) out.set(r.lineId, r);
  }
  return out;
}
