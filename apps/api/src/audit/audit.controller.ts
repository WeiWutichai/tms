import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { AuditLog } from '@prisma/client';
import { scopeAllows } from '@tms/domain';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { RequireScope } from '../common/decorators';
import { encodeId, tryDecodeId, type IdKind } from '../common/ids';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { DbService } from '../db/db.service';

/** entity ฝั่งบัญชีที่ role Accounting อ่าน audit ได้ (A3 "อ่านของบัญชี") — stage การเงินเพิ่มชนิดของตัวเอง */
export const ACCOUNTING_ENTITIES = [
  'company',
  'branch',
  'document_series',
  'invoice',
  'billing_note',
  'receipt',
  'credit_note',
  'debit_note',
  'settlement',
  'wht_certificate',
];

/** entity_type → prefix ของ id ใน API (ตารางที่ไม่มี prefix คืน uuid ตามเดิม) */
const KIND: Record<string, IdKind> = {
  company: 'company',
  branch: 'branch',
  document_series: 'sequence',
  user: 'user',
  role: 'role',
};

export class AuditQuery {
  @ApiPropertyOptional({ example: 'company' })
  @IsOptional()
  @Matches(/^[a-z_]{1,40}$/)
  entityType?: string;

  @ApiPropertyOptional({ example: 'cmp_…', description: 'id ของ entity (ใช้คู่กับ entityType)' })
  @IsOptional()
  @IsString()
  entityId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class AuditActorDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
}
export class AuditEntryDto {
  @ApiProperty({ example: 'aud_…' }) id!: string;
  @ApiProperty({ format: 'date-time' }) at!: string;
  @ApiProperty({ type: AuditActorDto, nullable: true }) actor!: AuditActorDto | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ผู้ใช้ Innovera ที่ impersonate (claim act)',
  })
  actAs!: string | null;
  @ApiProperty({ example: 'company.updated' }) action!: string;
  @ApiProperty() entityType!: string;
  @ApiProperty({ nullable: true, type: String }) entityId!: string | null;
  @ApiProperty({ nullable: true, type: Object, description: 'ค่าก่อนแก้ (เฉพาะ field ที่เปลี่ยน)' })
  before!: unknown;
  @ApiProperty({ nullable: true, type: Object }) after!: unknown;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ nullable: true, type: String }) ip!: string | null;
  @ApiProperty({ nullable: true, type: String }) requestId!: string | null;
}
export class AuditPageDto {
  @ApiProperty({ type: [AuditEntryDto] }) data!: AuditEntryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

function decodeCursor(c: string): bigint {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { s: string };
    if (typeof v.s !== 'string' || !/^\d{1,18}$/.test(v.s)) throw new Error();
    return BigInt(v.s);
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}

/** Audit log (ST1-T22; docs/04 A7) — อ่านอย่างเดียว ใหม่สุดก่อน; ไม่มี API แก้/ลบ (PLT-126) */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireScope('audit:read', 'audit.accounting:read')
  @ApiOkResponse({ type: AuditPageDto })
  async list(@Query() q: AuditQuery): Promise<AuditPageDto> {
    const scopes = requestContext.require().scopes ?? [];
    const accountingOnly = !scopeAllows(scopes, 'audit:read');
    if (accountingOnly && q.entityType && !ACCOUNTING_ENTITIES.includes(q.entityType))
      throw new ProblemException('forbidden');
    const limit = q.limit ?? 50;
    let entityId: string | undefined;
    if (q.entityId) {
      const kind = q.entityType ? KIND[q.entityType] : undefined;
      entityId = (kind ? tryDecodeId(kind, q.entityId) : q.entityId) ?? '__none__';
    }
    const and: object[] = [];
    if (q.entityType) and.push({ entityType: q.entityType });
    else if (accountingOnly) and.push({ entityType: { in: ACCOUNTING_ENTITIES } });
    if (entityId) and.push({ entityId });
    // เรียงด้วย seq (ลำดับเขียน) — at ของแถวใน transaction เดียวเท่ากันจึงใช้แบ่งหน้าไม่ได้ (review 10 พ.ย. 2569 ข้อ 6)
    if (q.cursor) and.push({ seq: { lt: decodeCursor(q.cursor) } });
    const rows = await this.db.tx.auditLog.findMany({
      where: and.length ? { AND: and } : {},
      orderBy: { seq: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const actorIds = [...new Set(page.map((r) => r.actorId).filter((x): x is string => !!x))];
    const uuid = /^[0-9a-f-]{36}$/i;
    const users = await this.db.tx.appUser.findMany({
      where: { id: { in: actorIds.filter((a) => uuid.test(a)) } },
      select: { id: true, name: true },
    });
    const names = new Map(users.map((u) => [u.id, u.name]));
    const last = page[page.length - 1];
    return {
      data: page.map((r: AuditLog) => ({
        id: encodeId('audit', r.id),
        at: r.at.toISOString(),
        actor: r.actorId
          ? {
              id: uuid.test(r.actorId) ? encodeId('user', r.actorId) : r.actorId,
              name: names.get(r.actorId) ?? null,
            }
          : null,
        actAs: r.actAs,
        action: r.action,
        entityType: r.entityType,
        entityId:
          r.entityId && KIND[r.entityType] && uuid.test(r.entityId)
            ? encodeId(KIND[r.entityType]!, r.entityId)
            : r.entityId,
        before: r.before ?? null,
        after: r.after ?? null,
        reason: r.reason,
        ip: r.ip,
        requestId: r.requestId,
      })),
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ s: String(last.seq) })).toString('base64url')
          : null,
      hasMore,
    };
  }
}
