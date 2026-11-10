import type { Branch, Company } from '@prisma/client';
import { tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import type { Tx } from '../../db/db.service';
import { readSettings } from '../settings/settings.service';
import { HQ_CODE } from '../branches/branches.service';

/**
 * Routing เอกสารตามนิติบุคคล (ST1-T16; docs/04 A4 "ออกบิลในนาม" / "จ้างในนาม")
 * ลำดับ: override ของเอกสาร → ค่าของลูกค้า/รถร่วม (ST2-T01, T05) → ค่าเริ่มต้นของ tenant (ตั้งค่า `routing.*`)
 *        → นิติบุคคลเดียวที่ใช้งานอยู่ (tenant ที่มีนิติบุคคลเดียวไม่ต้องตั้ง)
 * สาขา: ระบุมา (ต้องเป็นของนิติบุคคลนั้น) → สาขาออกเอกสาร default ของนิติบุคคล
 * สาขาที่ให้สำนักงานใหญ่ออกใบกำกับแทน (`hq_prints_for_all`) → `taxBranch` = สำนักงานใหญ่
 */
export type RoutingKind = 'invoice' | 'tender';

export interface RoutingInput {
  kind: RoutingKind;
  /** override ระดับเอกสาร (เช่น ผู้ใช้เลือกในฟอร์ม) — uuid */
  companyId?: string | null;
  branchId?: string | null;
  /** ค่าของลูกค้า (invoice) หรือรถร่วม (tender) — uuid */
  partyCompanyId?: string | null;
}

export interface RoutingResult {
  company: Company;
  /** สาขาที่ทำรายการ */
  branch: Branch;
  /** สาขาที่ระบุบนใบกำกับภาษี (สำนักงานใหญ่ถ้าสาขานี้ไม่ออกเอง) */
  taxBranch: Branch;
  source: 'override' | 'party' | 'tenant' | 'only';
}

const fail = (code: string, message: string, field = 'companyId') =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ⚠ taxBranch บอกแค่ "สาขาที่จะพิมพ์บนใบกำกับ" — ไม่ได้รับรองว่าออกใบกำกับภาษีได้:
 * ขั้นออกเอกสาร (ST5) ต้องตรวจ `company.vatRegistered` ก่อนพิมพ์ "ใบกำกับภาษี" (docs/01 §3.1)
 */
export async function resolveDocumentEntity(
  tx: Tx,
  tenantId: string,
  input: RoutingInput,
): Promise<RoutingResult> {
  for (const [field, v] of Object.entries({
    companyId: input.companyId,
    partyCompanyId: input.partyCompanyId,
    branchId: input.branchId,
  }))
    if (v && !UUID.test(v)) throw fail('invalid_id', 'must be a uuid', field);
  let companyId: string | null = null;
  let source: RoutingResult['source'] = 'only';
  if (input.companyId) {
    companyId = input.companyId;
    source = 'override';
  } else if (input.partyCompanyId) {
    companyId = input.partyCompanyId;
    source = 'party';
  } else {
    const key =
      input.kind === 'invoice' ? 'routing.invoiceAsCompanyId' : 'routing.tenderAsCompanyId';
    const v = (await readSettings(tx, tenantId, [key]))[key];
    const id = typeof v === 'string' ? tryDecodeId('company', v) : null;
    if (id) {
      companyId = id;
      source = 'tenant';
    }
  }
  let company: Company | null;
  if (companyId) {
    company = await tx.company.findUnique({ where: { id: companyId } });
  } else {
    const active = await tx.company.findMany({ where: { status: 'ACTIVE' }, take: 2 });
    if (active.length > 1)
      throw fail(
        'routing_not_configured',
        'several legal entities: set routing default or choose one',
      );
    company = active[0] ?? null;
  }
  if (!company || company.status !== 'ACTIVE')
    throw fail('company_unavailable', 'legal entity not found or inactive');

  const branch = input.branchId
    ? await tx.branch.findFirst({ where: { id: input.branchId, companyId: company.id } })
    : await tx.branch.findFirst({ where: { companyId: company.id, isDefaultIssuer: true } });
  if (!branch)
    throw fail('branch_unavailable', 'branch not found for this legal entity', 'branchId');
  const taxBranch =
    branch.branchCode === HQ_CODE || !branch.hqPrintsForAll
      ? branch
      : await tx.branch.findFirst({ where: { companyId: company.id, branchCode: HQ_CODE } });
  if (!taxBranch) throw fail('branch_unavailable', 'head office branch missing', 'branchId');
  return { company, branch, taxBranch, source };
}
