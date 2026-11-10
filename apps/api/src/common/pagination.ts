import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ProblemException } from './problem';

/** query มาตรฐานของทุก list (docs/01 §5.1 Pagination / Filter / fields) */
export class ListQuery {
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

  @ApiPropertyOptional({ description: 'คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull)' })
  @IsOptional()
  @IsISO8601()
  updatedAfter?: string;

  @ApiPropertyOptional({ enum: ['updatedAt', '-updatedAt'], default: 'updatedAt' })
  @IsOptional()
  @IsIn(['updatedAt', '-updatedAt'])
  sort?: 'updatedAt' | '-updatedAt';

  @ApiPropertyOptional({ description: 'รายชื่อ field คั่นด้วย , เช่น id,legalName' })
  @IsOptional()
  @Matches(/^[a-zA-Z]+(,[a-zA-Z]+)*$/)
  fields?: string;
}

interface CursorKey {
  u: string; // updatedAt ISO
  i: string; // id uuid
}

export function encodeCursor(row: { updatedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ u: row.updatedAt.toISOString(), i: row.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): CursorKey {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorKey;
    if (typeof v.u !== 'string' || typeof v.i !== 'string' || Number.isNaN(Date.parse(v.u)))
      throw new Error();
    return v;
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}

/**
 * keyset pagination บน (updatedAt, id) — เสถียรแม้มีแถว updatedAt เท่ากัน (ST0-T08)
 * คืน args สำหรับ prisma findMany (take = limit + 1 เพื่อรู้ hasMore)
 */
export function keysetArgs(q: ListQuery) {
  const limit = q.limit ?? 50;
  const desc = q.sort === '-updatedAt';
  const dir = desc ? 'desc' : 'asc';
  const op = desc ? 'lt' : 'gt';
  const and: Record<string, unknown>[] = [];
  if (q.updatedAfter) and.push({ updatedAt: { gt: new Date(q.updatedAfter) } });
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    const u = new Date(c.u);
    and.push({ OR: [{ updatedAt: { [op]: u } }, { updatedAt: u, id: { [op]: c.i } }] });
  }
  return {
    where: and.length ? { AND: and } : {},
    orderBy: [{ updatedAt: dir }, { id: dir }] as const,
    take: limit + 1,
    limit,
  };
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function toPage<R extends { updatedAt: Date; id: string }, T>(
  rows: R[],
  limit: number,
  map: (r: R) => T,
  fields?: string,
): Page<Partial<T>> {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    data: slice.map((r) => pickFields(map(r), fields)),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    hasMore,
  };
}

/** `?fields=` — คืนเฉพาะ field ที่ขอ (id คืนเสมอ) */
export function pickFields<T>(obj: T, fields?: string): Partial<T> {
  if (!fields) return obj;
  const keep = new Set(['id', ...fields.split(',')]);
  return Object.fromEntries(
    Object.entries(obj as object).filter(([k]) => keep.has(k)),
  ) as Partial<T>;
}
