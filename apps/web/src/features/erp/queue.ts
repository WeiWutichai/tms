import type { Schemas } from '@tms/contracts';
import type { T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { ApiError } from '../../api';
import { actionErrorText } from '../settlements/settle';

/**
 * แท็บคิวของหน้า "คิวเชื่อมระบบบัญชี" (PO #86 ตัดสิน 24 พ.ย. 2569 — ทางเลือก (ก); docs/04 G3 + docs/01 §6.4) — ฟังก์ชันล้วน
 * รายการ = คำสั่งส่งเข้าระบบบัญชี (ST7-T19 `GET /connectors/{id}/queue?tab=queued|failed|done`) แสดงในตารางเดียวกับต้นแบบ `erp`
 */
export type QueueItem = Schemas['ConnectorQueueItemDto'];

/** ErrorClass ที่ API กรองได้ (`errorClass`) — จัดกลุ่มแท็บล้มเหลว (docs/01 §6.4 "จัดกลุ่มตาม ErrorClass") */
export const ERROR_CLASSES = [
  'VALIDATION',
  'PERIOD_CLOSED',
  'DUPLICATE',
  'NOT_FOUND',
  'AUTH',
  'CAPABILITY',
  'AMBIGUOUS',
  'TRANSIENT',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];
export const isErrorClass = (v: string): v is ErrorClass => ERROR_CLASSES.includes(v as ErrorClass);
export const classKey = (c: string): MessageKey => `erpq.cls.${c}` as MessageKey;

/**
 * ป้ายสถานะของต้นแบบ (STATUS_BADGES) ← ข้อมูลคิว:
 * รอคิว: PENDING/IN_FLIGHT = "รอส่ง" · FAILED_RETRYABLE = "รอส่งซ้ำ" (ระบบลองใหม่เอง)
 * ล้มเหลว: ต้องอนุมัติแทนที่ = "รออนุมัติ" · VALIDATION = "ถูกปฏิเสธ" · อื่น ๆ = "ส่งไม่สำเร็จ"
 * สำเร็จ: ข้าม (คนข้าม / ระบบไม่ส่ง) = "ข้าม" · อื่น ๆ = "ซิงก์แล้ว"
 */
export function queueStatusKey(x: QueueItem): MessageKey {
  if (x.tab === 'queued')
    return x.status === 'FAILED_RETRYABLE' ? 'erpq.st.resend' : 'erpq.st.wait';
  if (x.tab === 'failed') {
    if (x.errorCode === 'replace_requires_approval') return 'erpq.st.appr';
    return x.errorClass === 'VALIDATION' ? 'erpq.st.rejected' : 'erpq.st.failed';
  }
  if (x.resolution?.kind === 'SKIPPED' || (x.status === 'SKIPPED' && !x.resolution))
    return 'erpq.st.skipped';
  return 'erpq.st.synced';
}

/** ประเภทเอกสาร (ชิปคอลัมน์ "ประเภท") — invoice → ใบแจ้งหนี้ · settlement → Settlement · อื่น ๆ = ชื่อ entity */
export function queueType(t: T, x: Pick<QueueItem, 'entityType'>): string {
  const k = `erpq.type.${x.entityType.toUpperCase()}` as MessageKey;
  const v = t(k);
  return v === k ? x.entityType : v;
}

/** คอลัมน์ "ฟิลด์ที่ต่าง" ของรายการคิว = ช่องที่ระบบบัญชีแจ้งว่าผิด + รหัสที่ยังไม่จับคู่ (ไม่มี = "—" แบบต้นแบบ) */
export function queueFields(x: QueueItem): string {
  const names = new Set<string>();
  for (const f of x.fields) names.add(f.field);
  for (const m of x.missing) names.add(m.nameTh ?? m.code ?? m.value ?? m.kind ?? m.status);
  return [...names].join(', ') || '—';
}

/** ข้อความแถบแดงของ drawer (ต้นแบบ `x.msg`): คู่มือ (หัวข้อ) → ชื่อรหัสผิดพลาด → ข้อความจากระบบบัญชี · รอคิว = เวลาลองครั้งถัดไป */
export function queueMessage(t: T, x: QueueItem, at: (iso: string) => string): string | null {
  if (x.tab === 'done') return null;
  const code = x.errorCode ? t(`cnx.ec.${x.errorCode}` as MessageKey) : null;
  const named = code && code !== `cnx.ec.${x.errorCode}` ? code : null;
  const head = x.guide?.title ?? named ?? x.errorMessage;
  if (x.tab === 'queued') {
    const next = x.nextRunAt ? t('erpq.q.next', { t: at(x.nextRunAt) }) : null;
    return [head, next].filter(Boolean).join(' · ') || null;
  }
  return head ?? t('erpq.st.failed');
}

/** ข้อความผิดพลาดของการทำรายการในคิว: 409 `queue_action_not_allowed` ตาม `why` · เลขซ้ำ = ข้อความของหน้านี้ */
export function queueErrorText(err: unknown, t: T): string | null {
  if (err instanceof ApiError) {
    const p = err.problem as { code?: string; why?: unknown };
    if (p.code === 'queue_action_not_allowed' && typeof p.why === 'string') {
      const k = `erpq.qerr.${p.why}` as MessageKey;
      if (t(k) !== k) return t(k);
    }
    if (p.code === 'external_id_conflict') return t('erpq.qerr.external_id_conflict');
  }
  return actionErrorText(err, t);
}
