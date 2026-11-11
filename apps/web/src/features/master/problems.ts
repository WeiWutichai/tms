import { ApiError } from '../../api';
import type { T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';

/** ข้อความไทยของ error ระดับช่อง (`field.{code}` ใน catalog; ไม่มี = ข้อความจาก API) */
export function fieldErrors(err: unknown, t: T): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const e of err.problem.errors ?? []) {
    const key = `field.${e.code}` as MessageKey;
    out[e.field] ??= t(key) === key ? e.message : t(key);
  }
  return out;
}

/** ข้อความไทยของ problem ทั้งก้อน (`problem.{code}`) */
export function problemText(err: unknown, t: T): string | null {
  if (!err) return null;
  if (!(err instanceof ApiError)) return t('problem.internal_error');
  const key = `problem.${err.problem.code}` as MessageKey;
  return t(key) === key ? err.problem.title || err.problem.code : t(key);
}

/** 412 (ข้อมูลเปลี่ยนแล้ว — คนอื่นหรือระบบแก้) */
export const isStale = (err: unknown) =>
  err instanceof ApiError && err.problem.code === 'precondition_failed';

/**
 * onError ร่วมของ mutation ที่ส่ง If-Match: 412 → โหลดรายการ/drawer ใหม่ ให้กดครั้งถัดไปใช้ version ล่าสุด
 * (ST2-T03 review — ใช้กับลูกค้า/สถานที่ และ master ถัดไป)
 */
export function refetchOnStale(
  qc: { invalidateQueries: (f: { queryKey: unknown[] }) => unknown },
  key: string,
) {
  return (err: unknown) => {
    if (!isStale(err)) return;
    qc.invalidateQueries({ queryKey: [key] });
    qc.invalidateQueries({ queryKey: ['history'] });
  };
}
