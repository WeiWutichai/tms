import { tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';

/** การอ้างบรรทัด DO ในคำขอ — `lineNo` (ลำดับบรรทัด) หรือ `doLineId` (public id `dol_…`) อย่างใดอย่างหนึ่งหรือทั้งคู่ */
export interface DoLineRefInput {
  lineNo?: number | null;
  doLineId?: string | null;
}

/**
 * D-81 · D68-52 (docs/01 §3.9/§5.5 `lines:[{doLineId, …}]`): แปลงการอ้างบรรทัดเป็น `lineNo` ของบรรทัดจริงใน DO ใบนี้
 * - ส่ง `doLineId` = ต้องเป็นบรรทัดของ DO ใบนี้ (ใบอื่น/tenant อื่น/รูปแบบผิด = 422 `unknown_line` — ไม่บอกใบ้ว่ามีอยู่)
 * - ส่งทั้งคู่ = ต้องตรงกัน ไม่งั้น 422 `line_ref_mismatch` · ไม่ส่งเลย = 422 `line_ref_required`
 * - ส่งแค่ `lineNo` = คงเดิม (ผู้เรียกตรวจ lineNo ที่ไม่มีอยู่ตามกติกาเดิมของตน)
 * `known` ต้องอ่านภายใต้ RLS ของ tenant (บรรทัดของ DO ที่ผ่านการตรวจสิทธิ์แล้ว)
 */
export function resolveDoLineRefs<T extends DoLineRefInput>(
  input: readonly T[],
  known: readonly { id: string; lineNo: number }[],
  field = 'lines',
): (T & { lineNo: number })[] {
  const byId = new Map(known.map((l) => [l.id, l.lineNo]));
  const errors: { field: string; code: string; message: string }[] = [];
  const out = input.map((l, i) => {
    const hasNo = typeof l.lineNo === 'number';
    const ref = typeof l.doLineId === 'string' && l.doLineId !== '' ? l.doLineId : null;
    if (ref === null) {
      if (!hasNo)
        errors.push({
          field: `${field}.${i}.lineNo`,
          code: 'line_ref_required',
          message: 'lineNo or doLineId is required',
        });
      return l as T & { lineNo: number };
    }
    const uuid = tryDecodeId('deliveryOrderLine', ref);
    const no = uuid ? byId.get(uuid) : undefined;
    if (no === undefined) {
      errors.push({
        field: `${field}.${i}.doLineId`,
        code: 'unknown_line',
        message: 'line not found on this delivery order',
      });
      return l as T & { lineNo: number };
    }
    if (hasNo && l.lineNo !== no)
      errors.push({
        field: `${field}.${i}.lineNo`,
        code: 'line_ref_mismatch',
        message: 'lineNo does not match doLineId',
      });
    return { ...l, lineNo: no };
  });
  if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
  return out;
}
