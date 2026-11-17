import type { DoPod, PodBody } from './usePod';

/**
 * ST4-T10 ยอดส่งจริงต่อรายการในฟอร์มหลักฐานส่ง (เว็บ) — ฟังก์ชันล้วน
 * - ค่าเริ่มต้น "ส่งจริง" = ค่าที่บันทึกไว้ หรือแผน (docs/04 M4 "default = แผน")
 * - หน้าจอเลือกเหตุผล/โน้ต **ชุดเดียวต่อ DO** ใช้กับทุกบรรทัดที่ส่งน้อยกว่าแผน (ต้นแบบ "ตีกลับบางส่วน" มีเหตุผลเดียว)
 * - ส่ง `lines` ใน body เฉพาะเมื่อแก้จากค่าปัจจุบัน (ไม่แก้ = คงค่าเดิม — ฟอร์มไม่ "dirty" เอง)
 * - จำนวนเป็นทศนิยม ≤ 3 ตำแหน่ง คิดด้วย bigint (ไม่มี float)
 */
export type PodLine = DoPod['lines'][number];

export interface LinesDraft {
  /** lineNo → ข้อความในช่อง "ส่งจริง" */
  qty: Record<number, string>;
  /** เหตุผลปฏิเสธรับ (rsn_…) */
  reason: string;
  note: string;
}

const QTY = /^\d{1,11}(\.\d{1,3})?$/;

/** "12.5" → 12500n · ไม่ใช่ตัวเลข = null */
export function milli(v: string): bigint | null {
  const s = v.replace(/,/g, '').trim();
  if (!QTY.test(s)) return null;
  const [w, f = ''] = s.split('.') as [string, string?];
  return BigInt(w) * 1000n + BigInt((f + '000').slice(0, 3));
}

export function qtyStr(m: bigint): string {
  const whole = m / 1000n;
  const frac = (m % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function linesDraftOf(pod: DoPod): LinesDraft {
  const ls = pod.lines ?? [];
  const short = ls.find((l) => l.rejectReason);
  return {
    qty: Object.fromEntries(ls.map((l) => [l.lineNo, l.qtyActual ?? l.qtyPlanned])),
    reason: short?.rejectReason?.id ?? '',
    note: short?.note ?? '',
  };
}

/** จำนวนที่ปฏิเสธของบรรทัด (แผน − ส่งจริง) — ช่องผิดรูป/เกินแผน = null */
export function rejectOf(l: PodLine, text: string | undefined): bigint | null {
  const p = milli(l.qtyPlanned);
  const a = milli(text ?? l.qtyPlanned);
  if (p === null || a === null || a > p) return null;
  return p - a;
}

export const anyShort = (pod: DoPod, d: LinesDraft) =>
  (pod.lines ?? []).some((l) => (rejectOf(l, d.qty[l.lineNo]) ?? 0n) > 0n);

/** body.lines — undefined = ไม่แก้ (คงค่าเดิม) */
export function linesBody(pod: DoPod, d: LinesDraft): PodBody['lines'] | undefined {
  const ls = pod.lines ?? [];
  if (!ls.length) return undefined;
  const base = linesDraftOf(pod);
  const short = anyShort(pod, d);
  const changed =
    ls.some((l) => (d.qty[l.lineNo] ?? '').trim() !== (base.qty[l.lineNo] ?? '')) ||
    (short && (d.reason !== base.reason || d.note.trim() !== base.note));
  if (!changed) return undefined;
  return ls.map((l) => {
    const raw = (d.qty[l.lineNo] ?? '').replace(/,/g, '').trim();
    const rej = rejectOf(l, raw);
    const isShort = rej !== null && rej > 0n;
    return {
      lineNo: l.lineNo,
      qtyActual: raw,
      ...(isShort ? { rejectReasonCodeId: d.reason || null, note: d.note.trim() || null } : {}),
    };
  });
}
