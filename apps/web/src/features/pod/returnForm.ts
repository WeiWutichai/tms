import type { Schemas } from '@tms/contracts';
import { milli, qtyStr } from './actualQty';

/**
 * ST4-T11 dialog "ตีกลับบางส่วน" (ต้นแบบ TMS v4 vRt) — ฟังก์ชันล้วน
 * - DO ส่งแล้ว: รายการ = บรรทัดที่ยังปฏิเสธรับคงเหลือ (`openRejectQty` > 0) ติ๊กแล้วส่งซ้ำ/คืนคลัง — จำนวนเริ่ม = คงเหลือ
 *   แก้เป็นบางส่วนได้ (ช่องจำนวนต่อบรรทัด — [DECISION — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ]; API ST4-T11 รับบางส่วน)
 * - DO ส่งไม่สำเร็จ: ทั้งใบ (ไม่ส่ง lines) · ส่งซ้ำ = ใบเดิมยกเลิก + ใบใหม่ทั้งใบ / คืนคลัง = RETURNED
 * - ผ่านเมื่อ: เลือก ≥ 1 รายการ · รูป (ธงบังคับรูป = รูปหลักฐานส่ง) · โน้ต (ธงบังคับโน้ต ≥ 5 ตัวอักษรตามต้นแบบ)
 *   · ชื่อเหตุผล + โน้ต ≥ 10 ตัวอักษร (MD-222 — ตรงกับ API)
 */
export type DeliveryOrder = Schemas['DeliveryOrderDto'];
export type ReturnAction = 'redeliver' | 'return';

export const RESOLVABLE_DELIVERED = ['DELIVERED', 'POD_PENDING', 'UNBILLED', 'BILLED'];
export const REASON_MIN = 10;
export const NOTE_MIN = 5;

export type ReturnMode = 'rejected' | 'failed';

export function modeOf(status: string): ReturnMode | null {
  if (status === 'FAILED') return 'failed';
  return RESOLVABLE_DELIVERED.includes(status) ? 'rejected' : null;
}

/** บรรทัดที่ยังปฏิเสธรับคงเหลือ */
export function openLines(d: Pick<DeliveryOrder, 'lines'>) {
  return d.lines.filter((l) => (milli(l.openRejectQty) ?? 0n) > 0n);
}

/** มีอะไรให้จัดการไหม (ปุ่ม "ตีกลับบางส่วน") */
export function canResolve(d: Pick<DeliveryOrder, 'status' | 'lines'>): boolean {
  const m = modeOf(d.status);
  return m === 'failed' || (m === 'rejected' && openLines(d).length > 0);
}

/** บรรทัดที่ส่งซ้ำ/คืนคลังไปแล้ว (แสดงสรุปใต้ฟอร์ม) */
export function resolvedLines(d: Pick<DeliveryOrder, 'lines'>) {
  return d.lines.filter(
    (l) => (milli(l.redeliveredQty) ?? 0n) > 0n || (milli(l.returnedQty) ?? 0n) > 0n,
  );
}

export interface ReturnDraft {
  /** lineNo ที่ติ๊ก */
  items: number[];
  /** จำนวนต่อบรรทัดที่ติ๊ก (ไม่กรอก = คงเหลือทั้งหมด) */
  qty?: Record<number, string>;
  action: ReturnAction;
  reasonId: string;
  note: string;
}

export interface ReasonFlags {
  label: string;
  requiresPhoto: boolean;
  requiresNote: boolean;
}

export type ReturnProblem = 'pick' | 'qty' | 'photo' | 'note' | 'short';

/** จำนวนของบรรทัดที่ติ๊กถูกต้อง: 0 < จำนวน ≤ คงเหลือ (ทศนิยม ≤ 3) */
export function qtyOk(open: string, v: string | undefined): boolean {
  if (v === undefined) return true;
  const a = milli(v);
  const o = milli(open);
  return a !== null && o !== null && a > 0n && a <= o;
}

/** สิ่งที่ยังขาด (ว่าง = บันทึกได้) */
export function problems(
  mode: ReturnMode,
  draft: ReturnDraft,
  reason: ReasonFlags | undefined,
  photoCount: number,
  lines: Pick<DeliveryOrder['lines'][number], 'lineNo' | 'openRejectQty'>[] = [],
): ReturnProblem[] {
  const out: ReturnProblem[] = [];
  if (mode === 'rejected' && draft.items.length === 0) out.push('pick');
  if (
    mode === 'rejected' &&
    lines.some(
      (l) => draft.items.includes(l.lineNo) && !qtyOk(l.openRejectQty, draft.qty?.[l.lineNo]),
    )
  )
    out.push('qty');
  if (!reason) {
    out.push('short');
    return out;
  }
  if (reason.requiresPhoto && photoCount === 0) out.push('photo');
  const note = draft.note.trim();
  if (reason.requiresNote && note.length < NOTE_MIN) out.push('note');
  else if ((note ? `${reason.label} — ${note}` : reason.label).length < REASON_MIN)
    out.push('short');
  return out;
}

export function bodyOf(mode: ReturnMode, d: DeliveryOrder, draft: ReturnDraft) {
  const note = draft.note.trim();
  return {
    reasonCodeId: draft.reasonId,
    note: note || null,
    ...(mode === 'rejected'
      ? {
          lines: openLines(d)
            .filter((l) => draft.items.includes(l.lineNo))
            .map((l) => ({
              lineNo: l.lineNo,
              qty: (() => {
                const m = milli(draft.qty?.[l.lineNo] ?? l.openRejectQty);
                return m === null ? l.openRejectQty : qtyStr(m);
              })(),
            })),
        }
      : {}),
  };
}

/** "1234.5" → "1,234.5" (ไม่ใช้ float) */
export function fmtQty(v: string): string {
  const m = milli(v);
  if (m === null) return v;
  const [w, f] = qtyStr(m).split('.') as [string, string?];
  return `${BigInt(w).toLocaleString('th-TH')}${f ? `.${f}` : ''}`;
}
