import { Injectable } from '@nestjs/common';
import type { Company, CompanyStatus } from '@prisma/client';
import type { TransitionTable } from '@tms/domain';
import { encodeId } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import type {
  CompanyDto,
  CompanyListQuery,
  CreateCompanyDto,
  UpdateCompanyDto,
} from './company.dto';

type CompanyEvent = 'activate' | 'deactivate';
export const COMPANY_TRANSITIONS: TransitionTable<CompanyStatus, CompanyEvent> = {
  ACTIVE: { deactivate: 'INACTIVE' },
  INACTIVE: { activate: 'ACTIVE' },
};

export function toCompanyDto(c: Company): CompanyDto {
  return {
    id: encodeId('company', c.id),
    legalName: c.legalName,
    legalNameEn: c.legalNameEn,
    taxId: c.taxId,
    vatRegistered: c.vatRegistered,
    status: c.status.toLowerCase() as CompanyDto['status'],
    externalId: c.externalId,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

@Injectable()
export class CompaniesService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
  ) {}

  async create(input: CreateCompanyDto): Promise<Company> {
    const tx = this.db.tx;
    const dup = await tx.company.findFirst({ where: { taxId: input.taxId }, select: { id: true } });
    if (dup) {
      throw new ProblemException('duplicate', undefined, [
        { field: 'taxId', code: 'duplicate', message: 'taxId already exists in this tenant' },
      ]);
    }
    return tx.company.create({ data: { ...input } as any });
  }

  async list(q: CompanyListQuery) {
    const k = keysetArgs(q);
    const status = q.status?.split(',').map((s) => s.toUpperCase() as CompanyStatus);
    const rows = await this.db.tx.company.findMany({
      where: { ...k.where, ...(status ? { status: { in: status } } : {}) },
      orderBy: k.orderBy as any,
      take: k.take,
    });
    return toPage(rows, k.limit, toCompanyDto, q.fields);
  }

  async get(id: string): Promise<Company> {
    const c = await this.db.tx.company.findUnique({ where: { id } });
    if (!c) throw new ProblemException('not_found');
    return c;
  }

  async getByExternalId(externalId: string): Promise<Company> {
    const c = await this.db.tx.company.findFirst({ where: { externalId } });
    if (!c) throw new ProblemException('not_found');
    return c;
  }

  async update(id: string, input: UpdateCompanyDto, expected?: number): Promise<Company> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    return this.bumpVersion(current, { ...input });
  }

  async changeStatus(id: string, event: CompanyEvent, reason: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    let updated!: Company;
    await this.state.transition(tx, {
      docType: 'company',
      docId: id,
      table: COMPANY_TRANSITIONS,
      from: current.status,
      event,
      note: reason,
      eventType: event === 'deactivate' ? 'company.deactivated' : 'company.activated',
      apply: async (to) => {
        updated = await this.bumpVersion(current, { status: to });
        return toCompanyDto(updated) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(current: Company, data: Record<string, unknown>): Promise<Company> {
    const tx = this.db.tx;
    const r = await tx.company.updateMany({
      where: { id: current.id, version: current.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.company.findUnique({ where: { id: current.id } }))!;
  }
}
