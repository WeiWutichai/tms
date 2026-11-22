import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';

/**
 * D-67 (PO 22 พ.ย. 2569; spec/11 NFR-107; ST9-T13 M-02) — step-up 2FA แบบมีเงื่อนไข เรียกจาก controller/service
 * เมื่อรายการเสี่ยงขึ้นกับข้อมูลในคำขอ (เช่น ส่ง credential มาตอนสร้าง connector, แก้บัญชีธนาคารจริง, ส่งออกทั้งบริษัท,
 * ยกเลิกใบวางบิลที่ออกแล้ว) — กลไกเดียวกับ `@RequireStepUp()`: header `X-Step-Up` จาก `POST /v1/auth/step-up` (อายุ 5 นาที)
 * ที่ AuthGuard ตรวจแล้ว (`ctx.steppedUp`) · ไม่ผ่าน → 403 `step_up_required`
 *
 * - API key / OAuth client (`pt=client`) ทำ step-up ไม่ได้ → ผ่าน (คุมด้วย scope ของ key ตามเดิม — D-67 นโยบาย key)
 * - งานนำเข้า (context `import:*`) → ผ่าน: ด่าน step-up อยู่ที่ `POST /v1/imports/{id}/commit` แทน (คนกดยืนยัน)
 */
export function assertHumanStepUp(): void {
  const ctx = requestContext.require();
  if (ctx.principalType === 'client') return;
  if (ctx.requestId.startsWith('import:')) return;
  if (!ctx.steppedUp) throw new ProblemException('step_up_required');
}

/** key ของ query/filter ที่ไม่จำกัดแถว (รูปแบบไฟล์ / การเรียง / แบ่งหน้า — ไฟล์ส่งออกไม่ใช้) */
const NON_NARROWING_KEYS = new Set(['format', 'sort', 'limit', 'cursor', 'fields', 'updatedAfter']);

/**
 * D-67 "export ข้อมูลทั้งบริษัท" (นิยาม — [DECISION ตาม D-67, PO ทบทวนได้ spec/12 §3]):
 * 1) ส่งออกให้นักบัญชี (`accounting-*`) = สมุดเอกสารการเงินทั้งบริษัทของช่วงวันที่ → ทุกครั้ง
 * 2) ส่งออกรายการ/รายงานโดย**ไม่มีตัวกรองที่จำกัดแถว** (ไม่มี filter/ids หรือมีแต่ค่าว่าง / `all`) = ทั้งตาราง
 * ส่งออกที่กรองแล้ว (เช่น เลือกแถว `ids`, สถานะ, ช่วงวันที่, ค้นหา) ไม่ต้อง step-up
 */
export function isWholeCompanyExport(resource: string, filter: Record<string, unknown>): boolean {
  if (resource.startsWith('accounting-')) return true;
  return !Object.entries(filter).some(([k, v]) => {
    if (NON_NARROWING_KEYS.has(k) || v === undefined || v === null) return false;
    const s = String(v).trim();
    return s !== '' && s !== 'all';
  });
}

export const WHOLE_EXPORT_WHEN =
  'ส่งออกทั้งบริษัท (D-67): ไม่มีตัวกรองที่จำกัดแถว (ไม่มี filter/`ids` หรือค่าว่าง/`all`) หรือ resource `accounting-*`';
