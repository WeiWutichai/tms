import type { Tone } from '@tms/ui';
import type { T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import type { StopEventFlag } from './useStopEventFlags';

type Ev = StopEventFlag['event'];

/** ชื่อชนิด event (+ ผล) เช่น "ปิดงาน (ส่งสำเร็จ)" */
export function eventLabel(t: T, e: Pick<Ev, 'type' | 'outcome'>): string {
  const base = t(`exc.ev.${e.type}` as MessageKey);
  return e.outcome ? `${base} (${t(`exc.out.${e.outcome}` as MessageKey)})` : base;
}

/** ประเภทของแถว = ธงสำคัญที่สุด (API เรียง LATE → SEQUENCE_CONFLICT → CLOCK_SKEW) */
export function flagTypeLabel(t: T, f: Pick<StopEventFlag, 'flags'>): string {
  const k = f.flags[0];
  return k ? t(`exc.flag.${k}` as MessageKey) : '—';
}

/**
 * รายละเอียดสั้น (บรรทัดที่ 2 ของคอลัมน์ประเภท — ต้นแบบ "AI: จำนวน…"): event + เหตุของแต่ละธง
 * เช่น "ปิดงาน (ส่งสำเร็จ) · ขณะยังไม่ถึงจุด" · "ถึงจุด · เที่ยวถูกยกเลิกแล้ว"
 */
export function flagDetail(
  t: T,
  f: Pick<StopEventFlag, 'flags' | 'event' | 'stateBefore'>,
  dt: (iso: string) => string,
): string {
  const parts = [eventLabel(t, f.event)];
  for (const k of f.flags) {
    if (k === 'LATE' && f.event.lateReason)
      parts.push(t(`exc.late.${f.event.lateReason}` as MessageKey));
    if (k === 'SEQUENCE_CONFLICT' && f.stateBefore)
      parts.push(t(`exc.state.${f.stateBefore}` as MessageKey));
    if (k === 'CLOCK_SKEW')
      parts.push(t('exc.skew', { o: dt(f.event.occurredAt), r: dt(f.event.receivedAt) }));
  }
  return parts.join(' · ');
}

/** ป้ายสถานะ (ต้นแบบ badge: ใหม่ = err/bell · ปิดแล้ว = ok/circle-check) */
export const STATUS_BADGE: Record<string, { tone: Tone; icon: string }> = {
  OPEN: { tone: 'err', icon: 'bell' },
  RESOLVED: { tone: 'ok', icon: 'circle-check' },
};

/** ป้ายผลของ event ในลำดับ (แท็บกิจกรรม) */
export const SEQ_BADGE: Record<string, { tone: Tone; icon: string }> = {
  APPLIED: { tone: 'ok', icon: 'check' },
  REDUNDANT: { tone: 'off', icon: 'copy' },
  CONFLICT: { tone: 'err', icon: 'triangle-alert' },
  ACCEPTED: { tone: 'info', icon: 'circle-check' },
  IGNORED: { tone: 'off', icon: 'circle-slash' },
  LATE: { tone: 'warn', icon: 'clock' },
  SKEWED: { tone: 'warn', icon: 'alarm-clock' },
};
