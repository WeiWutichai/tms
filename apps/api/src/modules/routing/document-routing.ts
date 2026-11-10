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

const fail = (code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field: 'companyId', code, message }]);

export async function resolveDocumentEntity(
  tx: Tx,
  tenantId: string,
  input: RoutingInput,
): Promise<RoutingResult> {
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
  if (!branch) throw fail('branch_unavailable', 'branch not found for this legal entity');
  const taxBranch =
    branch.branchCode === HQ_CODE || !branch.hqPrintsForAll
      ? branch
      : await tx.branch.findFirst({ where: { companyId: company.id, branchCode: HQ_CODE } });
  if (!taxBranch) throw fail('branch_unavailable', 'head office branch missing');
  return { company, branch, taxBranch, source };
}
