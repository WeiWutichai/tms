import { Injectable } from '@nestjs/common';
import type { Branch } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { decodeIdOr404, encodeId, tryDecodeId } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import type {
  AddressDto,
  BranchDto,
  BranchListQuery,
  CreateBranchDto,
  UpdateBranchDto,
} from './branch.dto';

export const HQ_CODE = '00000';

export function defaultBranchLabel(code: string): string {
  return code === HQ_CODE ? 'สำนักงานใหญ่' : `สาขาที่ ${code}`;
}

export function toBranchDto(b: Branch): BranchDto {
  return {
    id: encodeId('branch', b.id),
    companyId: encodeId('company', b.companyId),
    branchCode: b.branchCode,
    branchLabel: b.branchLabel,
    address: b.address as unknown as AddressDto,
    // hq_prints_for_all ต่อสาขา (คำตอบ PO 10 พ.ย. 2569): true = สำนักงานใหญ่ออกใบกำกับแทนสาขานี้
    issuesTaxInvoice: b.branchCode === HQ_CODE || !b.hqPrintsForAll,
    isDefaultIssuer: b.isDefaultIssuer,
    version: b.version,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/** สาขาตาม ภ.พ.20 (ST1-T14; docs/01 §3.1, docs/04 A4) */
@Injectable()
export class BranchesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateBranchDto): Promise<Branch> {
    const tx = this.db.tx;
    const companyId = tryDecodeId('company', input.companyId);
    const company = companyId ? await tx.company.findUnique({ where: { id: companyId } }) : null;
    if (!company) throw field422('companyId', 'not_found', 'company not found');
    if (input.branchCode === HQ_CODE && input.issuesTaxInvoice === false)
      throw field422('issuesTaxInvoice', 'hq_always_issues', 'head office always issues');
    const dup = await tx.branch.findFirst({
      where: { companyId: company.id, branchCode: input.branchCode },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        {
          field: 'branchCode',
          code: 'duplicate',
          message: 'branchCode already exists in this company',
        },
      ]);
    // สาขาแรกของนิติบุคคลเป็นสาขาออกเอกสาร default อัตโนมัติ
    const first = (await tx.branch.count({ where: { companyId: company.id } })) === 0;
    const isDefault = input.isDefaultIssuer ?? first;
    if (isDefault) await this.clearDefault(company.id);
    const b = await tx.branch.create({
      data: {
        tenantId: company.tenantId,
        companyId: company.id,
        branchCode: input.branchCode,
        branchLabel: input.branchLabel ?? defaultBranchLabel(input.branchCode),
        address: { ...input.address },
        hqPrintsForAll: input.issuesTaxInvoice === false,
        isDefaultIssuer: isDefault,
      },
    });
    await this.audit.record({
      action: 'branch.created',
      entityType: 'branch',
      entityId: b.id,
      after: toBranchDto(b),
    });
    return b;
  }

  async list(q: BranchListQuery) {
    const k = keysetArgs(q);
    const companyId = q.companyId ? decodeIdOr404('company', q.companyId) : undefined;
    const rows = await this.db.tx.branch.findMany({
      where: { ...k.where, ...(companyId ? { companyId } : {}) },
      orderBy: k.orderBy as never,
      take: k.take,
    });
    return toPage(rows, k.limit, toBranchDto, q.fields);
  }

  async get(id: string): Promise<Branch> {
    const b = await this.db.tx.branch.findUnique({ where: { id } });
    if (!b) throw new ProblemException('not_found');
    return b;
  }

  async update(id: string, input: UpdateBranchDto, expected?: number): Promise<Branch> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.branchCode === HQ_CODE && input.issuesTaxInvoice === false)
      throw field422('issuesTaxInvoice', 'hq_always_issues', 'head office always issues');
    if (current.isDefaultIssuer && input.isDefaultIssuer === false)
      throw field422(
        'isDefaultIssuer',
        'default_required',
        'set another branch as default instead',
      );
    if (input.isDefaultIssuer) await this.clearDefault(current.companyId, current.id);
    const data: Record<string, unknown> = {};
    if (input.branchLabel !== undefined) data.branchLabel = input.branchLabel;
    if (input.address !== undefined) data.address = { ...input.address };
    if (input.issuesTaxInvoice !== undefined) data.hqPrintsForAll = !input.issuesTaxInvoice;
    if (input.isDefaultIssuer !== undefined) data.isDefaultIssuer = input.isDefaultIssuer;
    const r = await tx.branch.updateMany({
      where: { id, version: current.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    const b = (await tx.branch.findUnique({ where: { id } }))!;
    await this.audit.changed(
      'branch.updated',
      'branch',
      id,
      { ...toBranchDto(current) },
      { ...toBranchDto(b) },
    );
    return b;
  }

  private async clearDefault(companyId: string, except?: string) {
    const tx = this.db.tx;
    const prev = await tx.branch.findMany({
      where: { companyId, isDefaultIssuer: true, ...(except ? { id: { not: except } } : {}) },
    });
    for (const p of prev) {
      await tx.branch.update({
        where: { id: p.id },
        data: { isDefaultIssuer: false, version: { increment: 1 } },
      });
      await this.audit.record({
        action: 'branch.updated',
        entityType: 'branch',
        entityId: p.id,
        before: { isDefaultIssuer: true },
        after: { isDefaultIssuer: false },
      });
    }
  }
}
