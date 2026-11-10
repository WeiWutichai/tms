import { Injectable } from '@nestjs/common';
import type { DocType, DocumentSeries, PrismaClient, ResetPolicy } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import type { SequenceDto, UpdateSequenceDto } from './sequence.dto';

/**
 * ชุดเลขค่าเริ่มต้นภาษาไทย (ST1-T15; ใช้ตอนสร้าง tenant ใน T20) — เฉพาะประเภทเอกสารในเฟส 0
 * เอกสารภาษี (perBranch) นับแยกต่อสาขาผู้ออก และ prefix ต้องมี {BR} กันเลขซ้ำข้ามสาขาของนิติบุคคลเดียวกัน
 */
export const DEFAULT_SERIES: Array<{
  docType: DocType;
  prefix: string;
  resetPolicy: ResetPolicy;
  perBranch: boolean;
}> = [
  { docType: 'SO', prefix: 'SO-', resetPolicy: 'MONTHLY', perBranch: false },
  { docType: 'TRIP', prefix: 'TRP-', resetPolicy: 'MONTHLY', perBranch: false },
  { docType: 'DO', prefix: 'DO-', resetPolicy: 'MONTHLY', perBranch: false },
  { docType: 'BN', prefix: 'BN-', resetPolicy: 'MONTHLY', perBranch: false },
  { docType: 'INV', prefix: 'INV-{BR}-', resetPolicy: 'MONTHLY', perBranch: true },
  { docType: 'TXINV', prefix: 'TX-{BR}-', resetPolicy: 'MONTHLY', perBranch: true },
  { docType: 'RCP', prefix: 'RCT-{BR}-', resetPolicy: 'MONTHLY', perBranch: true },
  { docType: 'CN', prefix: 'CN-{BR}-', resetPolicy: 'YEARLY', perBranch: true },
  { docType: 'DN', prefix: 'DN-{BR}-', resetPolicy: 'YEARLY', perBranch: true },
  { docType: 'STL', prefix: 'SA-', resetPolicy: 'MONTHLY', perBranch: false },
  { docType: 'WHT', prefix: 'WHT-{BR}-', resetPolicy: 'YEARLY', perBranch: true },
];
const ORDER = DEFAULT_SERIES.map((s) => s.docType as string);

/** สร้างชุดเลขที่ยังไม่มี (ไม่ทับค่าที่ tenant ตั้งเอง) */
export async function ensureDefaultSeries(
  db: Pick<PrismaClient, 'documentSeries'> | Tx,
  tenantId: string,
) {
  for (const s of DEFAULT_SERIES) {
    await db.documentSeries.upsert({
      where: { tenantId_docType: { tenantId, docType: s.docType } },
      create: { tenantId, ...s },
      update: {},
    });
  }
}

/** ปี/เดือนตามเวลาไทย (Asia/Bangkok, UTC+7 ไม่มี DST) */
function bangkokParts(at: Date, yearStyle: string) {
  const d = new Date(at.getTime() + 7 * 3600 * 1000);
  const year = d.getUTCFullYear() + (yearStyle === 'CE' ? 0 : 543);
  return {
    yyyy: String(year),
    yy: String(year).slice(-2),
    mm: String(d.getUTCMonth() + 1).padStart(2, '0'),
  };
}

export function periodKey(policy: ResetPolicy, at: Date, yearStyle: string): string {
  const p = bangkokParts(at, yearStyle);
  return policy === 'MONTHLY' ? p.yy + p.mm : policy === 'YEARLY' ? p.yyyy : 'ALL';
}

/** INV-{BR}- + MONTHLY → INV-00000-2611-0042 */
export function formatNumber(
  s: Pick<DocumentSeries, 'prefix' | 'resetPolicy' | 'padding'>,
  n: bigint | number,
  at: Date,
  yearStyle: string,
  branchCode?: string,
): string {
  const p = bangkokParts(at, yearStyle);
  const period =
    s.resetPolicy === 'MONTHLY' ? `${p.yy}${p.mm}-` : s.resetPolicy === 'YEARLY' ? `${p.yy}-` : '';
  return (
    s.prefix.replace(/\{BR\}/g, branchCode ?? '') + period + String(n).padStart(s.padding, '0')
  );
}

export function formatPattern(policy: ResetPolicy, padding: number): string {
  const n = `{${'N'.repeat(padding)}}`;
  return policy === 'MONTHLY' ? `{YYMM}-${n}` : policy === 'YEARLY' ? `{YY}-${n}` : n;
}

export interface IssueInput {
  docType: DocType;
  /** บังคับสำหรับเอกสารภาษี (สาขาผู้ออก) */
  branchId?: string;
  at?: Date;
}

/**
 * ออกเลขเอกสาร (docs/01 §3.5) — เรียกใน transaction เดียวกับการเปลี่ยนสถานะเป็น ISSUED
 * UPDATE … RETURNING ล็อกแถวตัวนับจน transaction จบ: พร้อมกันได้เลขเรียงไม่ซ้ำ; rollback แล้วเลขไม่ถูกใช้
 */
export async function issueNumber(tx: Tx, tenantId: string, input: IssueInput): Promise<string> {
  const at = input.at ?? new Date();
  const series = await tx.documentSeries.findUnique({
    where: { tenantId_docType: { tenantId, docType: input.docType } },
  });
  if (!series) throw new Error(`no document series for ${input.docType}`);
  // FOR SHARE กันหน้าตั้งค่าเปลี่ยนรูปแบบระหว่างออกเลข (update ถือ FOR UPDATE)
  await tx.$queryRaw`SELECT id FROM document_series WHERE id = ${series.id}::uuid FOR SHARE`;
  if (series.perBranch && !input.branchId) throw new Error(`${input.docType} requires branchId`);
  const branch = series.perBranch
    ? await tx.branch.findUnique({ where: { id: input.branchId! } })
    : null;
  if (series.perBranch && !branch) throw new ProblemException('not_found');
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
  const yearStyle = tenant?.yearStyle ?? 'BE';
  const key = periodKey(series.resetPolicy, at, yearStyle);
  const branchId = branch?.id ?? null;
  const template = series.prefix;
  await tx.$executeRaw`
    INSERT INTO document_sequence (id, tenant_id, doc_type, branch_id, period_key, reset_policy, prefix_template, padding, next_value, updated_at)
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${input.docType}::doc_type, ${branchId}::uuid, ${key}, ${series.resetPolicy}::reset_policy, ${template}, ${series.padding}, 1, now())
    ON CONFLICT DO NOTHING`;
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    UPDATE document_sequence SET next_value = next_value + 1, updated_at = now()
    WHERE tenant_id = ${tenantId}::uuid AND doc_type = ${input.docType}::doc_type
      AND branch_id IS NOT DISTINCT FROM ${branchId}::uuid AND period_key = ${key}
    RETURNING next_value - 1 AS n`;
  return formatNumber(series, rows[0]!.n, at, yearStyle, branch?.branchCode);
}

@Injectable()
export class SequencesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private tenantId() {
    return requestContext.require().tenantId!;
  }

  /** เลขถัดไป (ดูอย่างเดียว ไม่จอง) ของงวดปัจจุบัน — เอกสารภาษีแสดงของสาขาออกเอกสาร default */
  private async preview(s: DocumentSeries, yearStyle: string, at: Date) {
    const tx = this.db.tx;
    const branch = s.perBranch
      ? await tx.branch.findFirst({
          where: { isDefaultIssuer: true },
          orderBy: { createdAt: 'asc' },
        })
      : null;
    if (s.perBranch && !branch) return null;
    const row = await tx.documentSequence.findFirst({
      where: {
        docType: s.docType,
        branchId: branch?.id ?? null,
        periodKey: periodKey(s.resetPolicy, at, yearStyle),
      },
    });
    return formatNumber(s, row?.nextValue ?? 1n, at, yearStyle, branch?.branchCode);
  }

  async toDto(s: DocumentSeries, yearStyle: string, at = new Date()): Promise<SequenceDto> {
    return {
      id: encodeId('sequence', s.id),
      docType: s.docType,
      prefix: s.prefix,
      resetPolicy: s.resetPolicy.toLowerCase() as SequenceDto['resetPolicy'],
      padding: s.padding,
      perBranch: s.perBranch,
      pattern: formatPattern(s.resetPolicy, s.padding),
      nextNumber: await this.preview(s, yearStyle, at),
      version: s.version,
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  async yearStyle() {
    return (
      (await this.db.tx.tenant.findUnique({ where: { id: this.tenantId() } }))?.yearStyle ?? 'BE'
    );
  }

  async list(): Promise<SequenceDto[]> {
    const rows = await this.db.tx.documentSeries.findMany();
    rows.sort((a, b) => ORDER.indexOf(a.docType) - ORDER.indexOf(b.docType));
    const ys = await this.yearStyle();
    return Promise.all(rows.map((r) => this.toDto(r, ys)));
  }

  async get(id: string): Promise<DocumentSeries> {
    const s = await this.db.tx.documentSeries.findUnique({ where: { id } });
    if (!s) throw new ProblemException('not_found');
    return s;
  }

  async update(id: string, input: UpdateSequenceDto, expected?: number): Promise<DocumentSeries> {
    const tx = this.db.tx;
    await tx.$queryRaw`SELECT id FROM document_series WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const prefix = input.prefix ?? current.prefix;
    const nextPolicy = input.resetPolicy
      ? (input.resetPolicy.toUpperCase() as ResetPolicy)
      : current.resetPolicy;
    // เอกสารภาษี: เลขต้องเรียงต่อเนื่องในงวด — งวดนี้ออกเลขไปแล้วห้ามเปลี่ยนรูปแบบ (review 10 พ.ย. 2569 ข้อ 8)
    if (current.perBranch && (prefix !== current.prefix || nextPolicy !== current.resetPolicy)) {
      const ys = await this.yearStyle();
      const used = await tx.documentSequence.findFirst({
        where: {
          docType: current.docType,
          periodKey: periodKey(current.resetPolicy, new Date(), ys),
          nextValue: { gt: 1 },
        },
        select: { id: true },
      });
      if (used)
        throw new ProblemException('validation_failed', undefined, [
          {
            field: input.resetPolicy ? 'resetPolicy' : 'prefix',
            code: 'series_in_use',
            message: 'numbers already issued in the current period; change after the period ends',
          },
        ]);
    }
    if (current.perBranch && !prefix.includes('{BR}'))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'prefix',
          code: 'branch_token_required',
          message: 'tax document prefix must contain {BR}',
        },
      ]);
    const r = await tx.documentSeries.updateMany({
      where: { id, version: current.version },
      data: {
        prefix,
        ...(input.resetPolicy
          ? { resetPolicy: input.resetPolicy.toUpperCase() as ResetPolicy }
          : {}),
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    const s = (await tx.documentSeries.findUnique({ where: { id } }))!;
    await this.audit.changed(
      'document_series.updated',
      'document_series',
      id,
      { prefix: current.prefix, resetPolicy: current.resetPolicy },
      { prefix: s.prefix, resetPolicy: s.resetPolicy },
    );
    return s;
  }
}
