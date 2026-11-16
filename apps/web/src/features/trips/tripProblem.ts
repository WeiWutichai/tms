import { ApiError } from '../../api';
import type { T } from '../../i18n';
import { fieldErrors, problemText } from '../master/problems';

/** problem+json (รูปเดียวกันทั้ง ApiError ของคำขอเดี่ยว และ `results[].problem` ของ bulk) */
type ProblemLike = {
  code: string;
  title?: string;
  detail?: string;
  errors?: unknown[];
  blocks?: unknown[];
  warnings?: unknown[];
};

/**
 * ข้อความไทยของการปฏิเสธการจัดรถ/ย้าย/ปล่อยเที่ยว (ST3-T17 — ใช้ร่วม toast กระดาน + dialog ผล bulk):
 * หัวข้อ problem (ไทย) + กฎที่ค้าง (409 — ข้อความไทยจาก API) หรือช่องที่ผิด (422): ไม่มีคนขับ (`driverId`) /
 * ยังไม่วางลงรถ (`vehicleId`) · ข้อความ `detail` ภาษาไทยจาก API (เช่น จัดรถใหม่แล้วคนขับเดิมใช้ไม่ได้) แสดงตามนั้น
 */
export function tripProblemText(src: unknown, t: T): string {
  const p: ProblemLike | null =
    src instanceof ApiError
      ? (src.problem as unknown as ProblemLike)
      : src && typeof src === 'object' && 'code' in src
        ? (src as ProblemLike)
        : null;
  if (!p) return problemText(src, t) ?? '';
  const err = src instanceof ApiError ? src : new ApiError(p as never);
  const title = problemText(err, t) ?? p.title ?? p.code;
  const rules = [...(p.blocks ?? []), ...(p.warnings ?? [])]
    .map((x) => String((x as { message?: unknown }).message ?? ''))
    .filter(Boolean);
  const fe = fieldErrors(err, t);
  const thaiDetail = p.detail && /[\u0E00-\u0E7F]/.test(p.detail) ? [p.detail] : [];
  const errs = (p.errors ?? []) as { field: string; code: string }[];
  const fields = thaiDetail.length
    ? []
    : errs.map((e) =>
        e.field === 'driverId' && e.code === 'required'
          ? t('plan.noDriver')
          : e.field === 'vehicleId' && e.code === 'required'
            ? t('plan.bulk.noVehicle')
            : (fe[e.field] ?? ''),
      );
  const detail = [...new Set([...rules, ...thaiDetail, ...fields])].filter(Boolean).join(' · ');
  return detail ? `${title} — ${detail}` : title;
}
