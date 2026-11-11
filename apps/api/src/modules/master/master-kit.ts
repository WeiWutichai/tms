import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ListQuery } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import type { Tx } from '../../db/db.service';

/**
 * ชุดเครื่องมือร่วมของข้อมูลหลักทุกตัว (ST2-T01 = slice ต้นแบบ; docs/04 B "กฎร่วมทุก master", spec/02 §0)
 * master ถัดไป (สถานที่, รถร่วม, รถ, คนขับ, เส้นทาง, สินค้า, ค่าบริการ, rate card) import จากที่นี่:
 * - `MasterListQuery` ค้นหา `q` + กรองสถานะ บน cursor ของ ST0-T08
 * - `MasterReasonDto` / `MasterOptionalReasonDto` เหตุผลของการปิดใช้/ลบ (ลง audit)
 * - `lockKey` advisory lock ใน transaction (กันสร้างซ้ำพร้อมกัน)
 * - `nextCode` รหัสถัดไปตามรูปแบบ `PREFIX-0001` (MD-002)
 * - `assertNotReferenced` ลบได้เฉพาะรายการที่ไม่เคยถูกอ้างอิง (MD-004) ไม่งั้น 409 `in_use`
 * - `upsertByExternalId` สำหรับ `PUT /{master}/external/{externalId}` (idempotent)
 * - `emitMasterEvent` เขียน domain_event `{entity}.created/updated/deleted` (spec/02 §12.1)
 * ประวัติ (audit) อยู่ที่ `history.ts`, ส่งออก Excel/CSV อยู่ที่ `export.ts`
 */

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class MasterListQuery extends ListQuery {
  @ApiPropertyOptional({
    description: 'ค้นหา — รหัส ชื่อ เลขผู้เสียภาษี หรือ externalId (ไม่สนตัวพิมพ์)',
    maxLength: 100,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: 'คั่นด้วย , เช่น active,inactive' })
  @IsOptional()
  @Matches(/^(active|inactive)(,(active|inactive))*$/)
  status?: string;

  @ApiPropertyOptional({ description: 'externalId ตรงตัว (ใช้ตรวจว่ามีในระบบแล้วหรือยัง)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalId?: string;
}

/** แปลง `?status=active,inactive` → enum ของ Prisma (ACTIVE/INACTIVE) */
export function statusFilter(status?: string): { in: ('ACTIVE' | 'INACTIVE')[] } | undefined {
  if (!status) return undefined;
  return { in: status.split(',').map((s) => s.toUpperCase() as 'ACTIVE' | 'INACTIVE') };
}

/** เหตุผลบังคับ ≥ 10 ตัวอักษร (spec/02 §1.6 ปิดใช้, MD-004 ลบ) */
export class MasterReasonDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'เลิกใช้บริการตั้งแต่ ธ.ค. 2569' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

/** เหตุผลไม่บังคับ (เช่น เปิดใช้อีกครั้ง) */
export class MasterOptionalReasonDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}

/** advisory lock ภายใน transaction ของ request (ปล่อยเองเมื่อ commit/rollback) */
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7, hashtext(${key}))`;
}

/** ตารางข้อมูลหลักที่มีคอลัมน์ `code` — whitelist กัน SQL injection ใน nextCode */
const CODE_TABLES = [
  'customer',
  'customer_site',
  'carrier',
  'vehicle_type',
  'service_item',
] as const;
export type CodeTable = (typeof CODE_TABLES)[number];

/**
 * รหัสถัดไป `PREFIX-0001` (MD-002 ค่าเสนอ เช่น `CUS-0001`) — นับจากรหัสรูปแบบเดียวกันที่มีใน tenant
 * (รวมที่ลบแล้ว เพราะ unique ครอบทุกแถว) · ต้องเรียกหลัง `lockKey(tx, '<table>.code')` เมื่อจะใช้สร้างจริง
 */
export async function nextCode(
  tx: Tx,
  table: CodeTable,
  prefix: string,
  width = 4,
): Promise<string> {
  if (!CODE_TABLES.includes(table)) throw new Error(`nextCode: table ${table} not allowed`);
  const pattern = `^${prefix.replace(/[^A-Z]/g, '')}-([0-9]+)$`;
  const rows = await tx.$queryRawUnsafe<{ n: number | null }[]>(
    `SELECT max((substring(code from $1))::int) AS n FROM "${table}"`,
    pattern,
  );
  const n = (rows[0]?.n ?? 0) + 1;
  return `${prefix}-${String(n).padStart(width, '0')}`;
}

export interface ReferenceCheck {
  /** ชื่อที่ส่งกลับใน problem (เช่น `salesOrders`) */
  name: string;
  count: () => Promise<number>;
}

/** MD-004: ลบได้เฉพาะรายการที่ไม่เคยถูกอ้างอิง — มีการอ้างอิง → 409 `in_use` + จำนวนต่อชนิด */
export async function assertNotReferenced(checks: ReferenceCheck[]): Promise<void> {
  const refs: Record<string, number> = {};
  for (const c of checks) {
    const n = await c.count();
    if (n > 0) refs[c.name] = n;
  }
  if (Object.keys(refs).length)
    throw new ProblemException('in_use', undefined, undefined, { references: refs });
}

/**
 * upsert ด้วย externalId (docs/01 §5.2 `PUT /{master}/external/{id}`) — idempotent:
 * ส่งซ้ำ = อัปเดตแถวเดิม (200) ไม่เกิดแถวใหม่; ยังไม่มี = สร้าง (201)
 * lock ต่อ externalId กันคำขอพร้อมกันสร้างซ้ำ
 */
export async function upsertByExternalId<T>(
  tx: Tx,
  entity: string,
  externalId: string,
  ops: {
    find: () => Promise<T | null>;
    create: () => Promise<T>;
    update: (current: T) => Promise<T>;
  },
): Promise<{ row: T; created: boolean }> {
  await lockKey(tx, `${entity}.ext:${externalId}`);
  const current = await ops.find();
  if (current) return { row: await ops.update(current), created: false };
  return { row: await ops.create(), created: true };
}

/** domain_event ของข้อมูลหลัก (spec/02 §12.1) — เขียนใน transaction เดียวกับการแก้ข้อมูล */
export async function emitMasterEvent(
  tx: Tx,
  type: string,
  entityType: string,
  localId: string,
  snapshot: unknown,
  previousAttributes?: Record<string, unknown>,
): Promise<void> {
  const ctx = requestContext.require();
  await tx.domainEvent.create({
    data: {
      tenantId: ctx.tenantId!,
      type,
      entityType,
      localId,
      snapshot: JSON.parse(JSON.stringify(snapshot)),
      previousAttributes: (previousAttributes ?? {}) as object,
      requestId: ctx.requestId ?? null,
      actorId: ctx.actorId ?? null,
    },
  });
}
