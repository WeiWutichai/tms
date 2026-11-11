import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { decodeAuditCursor, toAuditPage } from '../../audit/audit-page';
import type { Tx } from '../../db/db.service';

/** query ของ `GET /{master}/{id}/history` (ใช้ร่วมทุก master) */
export class HistoryQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

/**
 * ประวัติการแก้ของ entity เดียว จาก audit_log (docs/04 B "ประวัติการแก้", A7 "อ่านได้จากหน้า entity")
 * ใหม่สุดก่อน · สิทธิ์ = สิทธิ์อ่าน master นั้น (ไม่ต้องมี audit:read ซึ่งเป็นของหน้ารวม)
 * response ใช้ `AuditPageDto` ชุดเดียวกับ `GET /v1/audit-logs`
 */
export async function entityHistory(
  tx: Tx,
  entityType: string,
  entityUuid: string,
  q: HistoryQuery,
) {
  const limit = q.limit ?? 50;
  const rows = await tx.auditLog.findMany({
    where: {
      entityType,
      entityId: entityUuid,
      ...(q.cursor ? { seq: { lt: decodeAuditCursor(q.cursor) } } : {}),
    },
    orderBy: { seq: 'desc' },
    take: limit + 1,
  });
  return toAuditPage(tx, rows, limit);
}
