import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ErpSyncLog } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { encodeId, ID_PREFIX, type IdKind } from '../../common/ids';
import type { Tx } from '../../db/db.service';
import { redactSecrets } from './connectors.service';
import type { ErpHttpCall } from './erp-adapter';
import { redactNationalIds } from './personal-data';

/** ขนาด body สูงสุดที่เก็บต่อแถว (ตัวอักษร) — เกินแล้วตัดท้ายพร้อมเครื่องหมาย */
export const SYNC_LOG_BODY_MAX = 16_000;
const TRUNCATED = '…[truncated]';

/**
 * review (PDPA): ช่องข้อมูลส่วนบุคคล/เลขผู้เสียภาษีใน body ถูกแทนด้วย `***` ตอนเขียน (ชื่อช่องรูปต่าง ๆ ของ adapter) —
 * sync log ใช้ดูว่าเรียกอะไร ไม่ใช่คลังข้อมูลส่วนบุคคล (เลขบัตรที่ใส่ ณ ตอนส่งถูกตัดซ้ำอีกชั้นด้วย `redactNationalIds`)
 */
const PII_KEYS: ReadonlySet<string> = new Set([
  'drivername',
  'driver_name',
  'taxid',
  'tax_id',
  'nationalid',
  'national_id',
  'idcard',
  'id_card',
]);

function maskPii(v: unknown, depth = 0): unknown {
  if (depth > 20 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => maskPii(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [
      k,
      PII_KEYS.has(k.toLowerCase()) && x !== null && x !== undefined && x !== ''
        ? '***'
        : maskPii(x, depth + 1),
    ]),
  );
}

/** ข้อความ/ค่า → สตริงที่ตัด credential + ช่องข้อมูลส่วนบุคคล + เลขบัตรประชาชน (D-80) + ตัดขนาดแล้ว · ไม่มีค่า = null */
export function scrubBody(v: unknown, secrets: readonly string[]): string | null {
  if (v === undefined || v === null || v === '') return null;
  let obj: unknown = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      obj = v;
    }
  }
  let text: string;
  try {
    text = typeof obj === 'string' ? obj : JSON.stringify(maskPii(obj));
  } catch {
    text = String(v);
  }
  const clean = redactNationalIds(redactSecrets(text, secrets), secrets);
  return clean.length > SYNC_LOG_BODY_MAX
    ? clean.slice(0, SYNC_LOG_BODY_MAX - TRUNCATED.length) + TRUNCATED
    : clean;
}

/** URL → origin + path (ไม่เก็บ query string / user:pass) แล้วตัด credential ซ้ำ */
export function scrubUrl(url: string, secrets: readonly string[]): string {
  let out: string;
  try {
    const u = new URL(url);
    out = `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    out = url.split('?')[0] ?? '';
  }
  return redactNationalIds(redactSecrets(out, secrets), secrets).slice(0, 500);
}

/** บริบทของคำสั่งที่ทำให้เกิดการเรียก */
export interface SyncLogContext {
  tenantId: string;
  connectorId: string;
  outboxId: string | null;
  attempt: number | null;
  operation: string;
  entityType: string | null;
  localId: string | null;
  localNumber: string | null;
}

/**
 * ST7-T16 เขียน sync log (docs/01 §6.4 "1 แถวต่อ 1 HTTP call ทั้ง outbound … ตัด credential ก่อนเก็บ") — ใน transaction ของ tenant (RLS)
 * ไม่เก็บ header · `secrets` = ค่าลับของ connector + ข้อมูลส่วนบุคคลที่ใส่ ณ ตอนส่ง (D-80)
 */
export async function recordSyncLog(
  tx: Tx,
  c: SyncLogContext,
  calls: readonly ErpHttpCall[],
  secrets: readonly string[],
  now: Date,
): Promise<number> {
  if (!calls.length) return 0;
  const rows = calls.slice(0, 50).map((call) => ({
    tenantId: c.tenantId,
    connectorId: c.connectorId,
    outboxId: c.outboxId,
    attempt: c.attempt,
    operation: c.operation.slice(0, 60),
    entityType: c.entityType?.slice(0, 40) ?? null,
    localId: c.localId,
    localNumber: c.localNumber?.slice(0, 60) ?? null,
    direction: 'OUT',
    method: String(call.method ?? 'GET')
      .toUpperCase()
      .slice(0, 10),
    url: scrubUrl(String(call.url ?? ''), secrets),
    statusCode:
      typeof call.status === 'number' && Number.isInteger(call.status) ? call.status : null,
    errorCode: call.errorCode ? redactSecrets(String(call.errorCode), secrets).slice(0, 60) : null,
    durationMs: Math.max(0, Math.round(Number(call.durationMs) || 0)),
    requestBody: scrubBody(call.requestBody, secrets),
    responseBody: scrubBody(call.responseBody, secrets),
    occurredAt: call.at instanceof Date && !isNaN(call.at.getTime()) ? call.at : now,
  }));
  await tx.erpSyncLog.createMany({ data: rows });
  return rows.length;
}

// ---------- API ----------

export class ErpSyncLogQuery {
  @ApiPropertyOptional({
    example: 'obx_…',
    description: 'เฉพาะการเรียกของคำสั่งนี้ (บันทึกการซิงก์)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  commandId?: string;

  @ApiPropertyOptional({ example: 'INV-00000-2611-0001', description: 'เลขเอกสาร TMS' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  documentNo?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน (เรียงใหม่สุดก่อน)' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  cursor?: string;
}

/** การเรียกระบบบัญชี 1 ครั้ง (docs/01 §6.4) — ตัด credential / เลขบัตรประชาชนแล้ว · ไม่มี header */
export class ErpSyncLogDto {
  @ApiProperty({ example: 'slg_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String, example: 'obx_…' }) commandId!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'ครั้งที่ของคำสั่ง' })
  attempt!: number | null;
  @ApiProperty({ example: 'PUSH_INVOICE' }) operation!: string;
  @ApiProperty({ nullable: true, type: String, example: 'invoice' }) entityType!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'ivc_…' }) localId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'INV-00000-2611-0001' })
  documentNo!: string | null;
  @ApiProperty({ enum: ['OUT', 'IN'] }) direction!: string;
  @ApiProperty({ example: 'POST' }) method!: string;
  @ApiProperty({
    example: 'https://erp.example.com/api/invoices',
    description: 'origin + path (ไม่มี query string)',
  })
  url!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'null = ไม่ได้ response (timeout / เครือข่าย)',
  })
  statusCode!: number | null;
  @ApiProperty({ nullable: true, type: String, example: 'timeout' }) errorCode!: string | null;
  @ApiProperty() durationMs!: number;
  @ApiProperty({ nullable: true, type: String, description: 'body ที่ส่ง (ตัดแล้ว ≤ 16 KB)' })
  requestBody!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'body ที่ได้กลับ (ตัดแล้ว ≤ 16 KB)' })
  responseBody!: string | null;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
}

export class ErpSyncLogListDto {
  @ApiProperty({ type: [ErpSyncLogDto] }) data!: ErpSyncLogDto[];
  @ApiProperty({ nullable: true, type: String, description: 'ส่งเป็น `cursor` เพื่อดูหน้าถัดไป' })
  nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

/** keyset (occurred_at, id) เรียงใหม่สุดก่อน — cursor รูปเดียวกับ list มาตรฐาน (docs/01 §5.1) */
export const SYNC_LOG_SORT = '-occurredAt';

function publicId(entityType: string | null, id: string | null): string | null {
  if (!id) return null;
  const kind = (entityType ?? '').replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());
  return kind in ID_PREFIX ? encodeId(kind as IdKind, id) : id;
}

export function syncLogDto(r: ErpSyncLog): ErpSyncLogDto {
  return {
    id: encodeId('syncLog', r.id),
    commandId: r.outboxId ? encodeId('outboxCommand', r.outboxId) : null,
    attempt: r.attempt,
    operation: r.operation,
    entityType: r.entityType,
    localId: publicId(r.entityType, r.localId),
    documentNo: r.localNumber,
    direction: r.direction,
    method: r.method,
    url: r.url,
    statusCode: r.statusCode,
    errorCode: r.errorCode,
    durationMs: r.durationMs,
    requestBody: r.requestBody,
    responseBody: r.responseBody,
    occurredAt: r.occurredAt.toISOString(),
  };
}
