import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';

/**
 * D-67 (PO 22 พ.ย. 2569; spec/11 NFR-107; ST9-T13 M-02) — step-up 2FA แบบมีเงื่อนไข เรียกจาก controller/service
 * เมื่อรายการเสี่ยงขึ้นกับข้อมูลในคำขอ (เช่น ส่ง credential มาตอนสร้าง connector, แก้บัญชีธนาคารจริง, ส่งออกทั้งบริษัท,
 * ยกเลิกใบวางบิลที่ออกแล้ว) — กลไกเดียวกับ `@RequireStepUp()`: header `X-Step-Up` จาก `POST /v1/auth/step-up` (อายุ 5 นาที)
 * ที่ AuthGuard ตรวจแล้ว (`ctx.steppedUp`) · ไม่ผ่าน → 403 `step_up_required`
 *
 * - API key / OAuth client (`pt=client`) ทำ step-up ไม่ได้ → ผ่าน (คุมด้วย scope ของ key ตามเดิม — D-67 นโยบาย key)
 * - งานนำเข้า (`ctx.importRun` — ตั้งโดย ImportService.inContext เท่านั้น) → ผ่าน: ด่าน step-up อยู่ที่ `POST /v1/imports/{id}/commit` แทน (คนกดยืนยัน)
 */
export function assertHumanStepUp(): void {
  const ctx = requestContext.require();
  if (ctx.principalType === 'client') return;
  if (ctx.importRun === true) return;
  if (!ctx.steppedUp) throw new ProblemException('step_up_required');
}

/**
 * D-67: step-up ทุก principal (route จัดการ credential — API key/webhook/connector) — ตรวจใน handler
 * **หลัง validation** (ข้อมูลผิด = 422 ก่อนถามยืนยัน 2FA; ข้าม tenant = 404) · API key ไม่ได้รับยกเว้น
 */
export function assertStepUp(): void {
  if (!requestContext.require().steppedUp) throw new ProblemException('step_up_required');
}

/** ส่งออกที่เป็นรายงาน/สมุดเอกสารของทั้งบริษัท — step-up ทุกครั้ง (แม้มีตัวกรอง) */
const ALWAYS_STEP_UP_EXPORTS = new Set([
  'revenue',
  'receivables-aging',
  'unbilled-delivery-orders',
]);

/**
 * D-67 "export ข้อมูลทั้งบริษัท" — กติกาแบบเข้ม (review H2: ตัวกรองเลี่ยงได้ เช่น includeDeleted / หลายสถานะ / ช่วงวันกว้าง)
 * [DECISION ตาม D-67 + review, PO ทบทวนได้ spec/12 §3]:
 * - ผู้ใช้ส่งออก**ทุกครั้งต้อง step-up** ยกเว้นเลือกแถวเอง (`ids` ไม่ว่าง — แถวที่ติ๊กในตาราง)
 * - รายงาน (`revenue`, `receivables-aging`, `unbilled-delivery-orders`) และส่งออกให้นักบัญชี (`accounting-*`) ทุกครั้ง
 * (API key ไม่ถาม — `assertHumanStepUp`)
 */
export function exportNeedsStepUp(resource: string, filter: Record<string, unknown>): boolean {
  if (resource.startsWith('accounting-') || ALWAYS_STEP_UP_EXPORTS.has(resource)) return true;
  const ids = filter.ids;
  return !(typeof ids === 'string' && ids.split(',').some((x) => x.trim() !== ''));
}

export const EXPORT_STEP_UP_WHEN =
  'ส่งออก (D-67): ผู้ใช้ทุกครั้ง ยกเว้นเลือกแถวเอง (`ids`) · รายงานและ `accounting-*` ทุกครั้ง';
