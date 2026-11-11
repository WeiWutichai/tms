import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { pickFields } from '../../common/pagination';
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

/**
 * ตัดอักขระที่มองไม่เห็น/ควบคุม (zero-width, bidi override, BOM, control รวม tab/ขึ้นบรรทัด) → ช่องว่าง แล้วยุบช่องว่างซ้อน
 * ใช้กับข้อความบรรทัดเดียวของข้อมูลหลักทุกตัว (ชื่อ ที่อยู่ ผู้ติดต่อ คำค้น) — กันชื่อ "ดูเหมือนกัน" แต่ไม่ซ้ำ และกันพิมพ์เพี้ยนบนเอกสาร
 */
export function cleanLine(v: string): string {
  return v
    .replace(
      /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** class-transformer: ข้อความบรรทัดเดียว (ค่าที่ไม่ใช่ string ส่งต่อให้ validator ตัดสิน) */
export const CleanText = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? cleanLine(value) : value,
  );

/**
 * ช่องไม่บังคับแต่ห้ามเป็น null (เช่น ชื่อ, รอบวางบิล, boolean) — `@IsOptional()` ปล่อย null ผ่านไปถึง DB → 500
 * ใช้ตัวนี้แทน: ไม่ส่ง = ข้าม, ส่ง null = 422 จาก validator ตัวถัดไป
 */
export const IsOptionalNotNull = () => ValidateIf((_, v) => v !== undefined);

/** ช่องที่ล้างค่าได้ด้วย null (เช่น taxId, billingCompanyId) — ไม่ส่ง/null = ข้าม validator */
export const IsNullable = () => ValidateIf((_, v) => v !== undefined && v !== null);

export { iEquals, likeEscape } from '../../common/ilike';

export const MASTER_SORTS = ['code', 'updatedAt', '-updatedAt'] as const;

/**
 * query มาตรฐานของรายการข้อมูลหลัก — cursor แบบ keyset (ST0-T08) เรียงตามรหัสได้ (ตามต้นแบบ)
 * แยกจาก `ListQuery` เพราะต้องเพิ่ม `sort=code` (class-validator รวม decorator ของคลาสแม่ จึง override ไม่ได้)
 */
export class MasterListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({
    description:
      'คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull — ใช้คู่ includeDeleted=true เพื่อรับรายการที่ถูกลบ)',
  })
  @IsOptional()
  @IsISO8601()
  updatedAfter?: string;

  @ApiPropertyOptional({
    enum: MASTER_SORTS,
    default: 'code',
    description: 'code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync',
  })
  @IsOptional()
  @IsIn(MASTER_SORTS)
  sort?: (typeof MASTER_SORTS)[number];

  @ApiPropertyOptional({ description: 'รายชื่อ field คั่นด้วย , เช่น id,legalName' })
  @IsOptional()
  @Matches(/^[a-zA-Z]+(,[a-zA-Z]+)*$/)
  fields?: string;

  @ApiPropertyOptional({
    description: 'ค้นหา — รหัส ชื่อ เลขผู้เสียภาษี หรือ externalId (ไม่สนตัวพิมพ์)',
    maxLength: 100,
  })
  @IsOptional()
  @CleanText()
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

  @ApiPropertyOptional({
    description:
      'true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) — ให้ระบบที่ดึงแบบ incremental รู้ว่ารายการถูกลบ',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  includeDeleted?: 'true' | 'false';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MasterCursor {
  s: string; // sort
  k: string; // ค่า key (code หรือ updatedAt ISO)
  i: string; // id
}

function decodeMasterCursor(cursor: string, sort: string): MasterCursor {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as MasterCursor;
    // review ST2-T17: cursor ที่แต่งขึ้น (id ไม่ใช่ uuid / เวลาไม่ใช่วันที่) เคยหลุดถึง DB → 500
    if (v.s !== sort || typeof v.k !== 'string' || typeof v.i !== 'string' || !UUID_RE.test(v.i))
      throw new Error();
    if (sort !== 'code' && Number.isNaN(Date.parse(v.k))) throw new Error();
    return v;
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}

/**
 * keyset pagination ของข้อมูลหลัก: (code, id) หรือ (updatedAt, id) — เสถียรแม้ค่าซ้ำ
 * คืน where/orderBy/take สำหรับ findMany และ `page()` สร้าง response + nextCursor
 */
export function masterKeyset(
  q: Pick<MasterListQuery, 'limit' | 'cursor' | 'updatedAfter' | 'fields'> & { sort?: string },
  /** คอลัมน์ "รหัส" ที่ใช้เรียงเมื่อ sort=code (รถใช้ `plateKey`) */
  codeField = 'code',
) {
  const limit = q.limit ?? 50;
  const sort = q.sort ?? 'code';
  const desc = sort === '-updatedAt';
  const op = desc ? 'lt' : 'gt';
  const dir = desc ? 'desc' : 'asc';
  const key = sort === 'code' ? codeField : 'updatedAt';
  const and: Record<string, unknown>[] = [];
  if (q.updatedAfter) and.push({ updatedAt: { gt: new Date(q.updatedAfter) } });
  if (q.cursor) {
    const c = decodeMasterCursor(q.cursor, sort);
    const k = key === codeField ? c.k : new Date(c.k);
    and.push({ OR: [{ [key]: { [op]: k } }, { [key]: k, id: { [op]: c.i } }] });
  }
  return {
    where: and.length ? { AND: and } : {},
    orderBy: [{ [key]: dir }, { id: dir }] as never,
    take: limit + 1,
    page<R extends { id: string; updatedAt: Date }, T>(
      rows: R[],
      map: (r: R) => T,
    ): { data: Partial<T>[]; nextCursor: string | null; hasMore: boolean } {
      const hasMore = rows.length > limit;
      const slice = hasMore ? rows.slice(0, limit) : rows;
      const last = slice[slice.length - 1];
      const cur = (r: R): MasterCursor => ({
        s: sort,
        k:
          key === codeField
            ? String((r as Record<string, unknown>)[codeField])
            : r.updatedAt.toISOString(),
        i: r.id,
      });
      return {
        data: slice.map((r) => pickFields(map(r), q.fields)),
        nextCursor:
          hasMore && last ? Buffer.from(JSON.stringify(cur(last))).toString('base64url') : null,
        hasMore,
      };
    },
  };
}

/** `includeDeleted` ไม่ส่ง/false → ซ่อนรายการที่ลบ */
export function deletedFilter(q: { includeDeleted?: string }) {
  return q.includeDeleted === 'true' ? {} : { deletedAt: null };
}

/** แปลง `?status=active,inactive` → enum ของ Prisma (ACTIVE/INACTIVE) */
export function statusFilter(status?: string): { in: ('ACTIVE' | 'INACTIVE')[] } | undefined {
  if (!status) return undefined;
  return { in: status.split(',').map((s) => s.toUpperCase() as 'ACTIVE' | 'INACTIVE') };
}

/** JSON แบบเรียง key (jsonb ใน Postgres เรียง key ใหม่ — เทียบค่าด้วย key ที่เรียงแล้ว) */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/**
 * ค่าที่จะเขียน (data ของ Prisma update) เท่ากับแถวเดิมทุกช่องหรือไม่ — ใช้ข้ามการเพิ่ม version เมื่อส่งซ้ำค่าเดิม
 * Decimal เทียบเป็นตัวเลข (`500000` = `500000.00`), jsonb เทียบแบบ key เรียง, DbNull = null
 */
export function isNoopUpdate(
  current: Record<string, unknown>,
  data: Record<string, unknown>,
  decimalFields: readonly string[] = [],
): boolean {
  const norm = (k: string, v: unknown): unknown => {
    if (v === Prisma.DbNull || v === Prisma.JsonNull) return null;
    if (decimalFields.includes(k) && v !== null && v !== undefined)
      return new Prisma.Decimal(v as Prisma.Decimal.Value).toFixed(6);
    return v;
  };
  return Object.entries(data).every(
    ([k, v]) => stableStringify(norm(k, current[k])) === stableStringify(norm(k, v)),
  );
}

/** เหตุผลบังคับ ≥ 10 ตัวอักษร (spec/02 §1.6 ปิดใช้, MD-004 ลบ) */
export class MasterReasonDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'เลิกใช้บริการตั้งแต่ ธ.ค. 2569' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

/** เหตุผลไม่บังคับ (เช่น เปิดใช้อีกครั้ง) */
export class MasterOptionalReasonDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}

/**
 * advisory lock ภายใน transaction ของ request (ปล่อยเองเมื่อ commit/rollback)
 * key ผูกกับ tenant ของ request เสมอ — tenant ต่างกันไม่รอกัน (เช่น `customer.code` ของแต่ละบริษัท)
 */
export async function lockKey(tx: Tx, key: string): Promise<void> {
  const tenantId = requestContext.get()?.tenantId ?? '-';
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7, hashtext(${`${tenantId}:${key}`}))`;
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
 * (รวมที่ลบแล้ว เพราะ unique ครอบทุกแถว) ไม่สนตัวพิมพ์ (รหัสเก็บเป็นตัวใหญ่ — `normalizeCode`)
 * ตัวเลขเกิน 9 หลักไม่นับ (กัน overflow ทำทั้ง tenant พัง) · เรียกหลัง `lockKey(tx, '<table>.code')` เมื่อจะสร้างจริง
 */
export async function nextCode(
  tx: Tx,
  table: CodeTable,
  prefix: string,
  width = 4,
): Promise<string> {
  if (!CODE_TABLES.includes(table)) throw new Error(`nextCode: table ${table} not allowed`);
  const p = prefix.replace(/[^A-Z]/g, '');
  const rows = await tx.$queryRawUnsafe<{ n: bigint | number | null }[]>(
    `SELECT max((substring(upper(code) from $1))::bigint) AS n FROM "${table}"`,
    `^${p}-([0-9]{1,9})$`,
  );
  const n = Number(rows[0]?.n ?? 0) + 1;
  return `${p}-${String(n).padStart(width, '0')}`;
}

/** รหัสที่ผู้ใช้กรอก: ตัดช่องว่าง + ตัวใหญ่ (unique ไม่สนตัวพิมพ์ตาม MD-002) */
export const NormalizeCode = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? cleanLine(value).toUpperCase() : value,
  );

export interface ReferenceCheck {
  /** ชื่อที่ส่งกลับใน problem (เช่น `salesOrders`) */
  name: string;
  count: () => Promise<number>;
}

/**
 * MD-004: ลบได้เฉพาะรายการที่ไม่เคยถูกอ้างอิง — มีการอ้างอิง → 409 `in_use` + จำนวนต่อชนิด
 * `instead` = การกระทำที่ให้ใช้แทนการลบของ master นั้น (ค่าเริ่มต้น "ปิดใช้"; รถร่วม = "ระงับชั่วคราว") → หัวข้อความ + `instead` ใน problem
 */
export async function assertNotReferenced(
  checks: ReferenceCheck[],
  instead?: { action: string; th: string; en: string },
): Promise<void> {
  const refs: Record<string, number> = {};
  for (const c of checks) {
    const n = await c.count();
    if (n > 0) refs[c.name] = n;
  }
  if (Object.keys(refs).length)
    throw new ProblemException('in_use', undefined, undefined, {
      references: refs,
      ...(instead
        ? {
            instead: instead.action,
            title: {
              th: `ลบไม่ได้ เพราะมีเอกสารหรือข้อมูลอื่นอ้างถึงแล้ว — ใช้ "${instead.th}" แทน`,
              en: `Referenced by other records — ${instead.en} it instead`,
            },
          }
        : {}),
    });
}

/**
 * ปิดใช้ได้เฉพาะเมื่อไม่มีข้อมูลที่ใช้งานอยู่อ้างถึง (เช่น MD-094 ประเภทรถที่ยังมีรถในทะเบียน)
 * → 409 `in_use_active` (คนละ code/ข้อความกับ `in_use` ของการลบ) + จำนวนต่อชนิดใน `references`
 */
export async function assertNotActivelyUsed(checks: ReferenceCheck[]): Promise<void> {
  const refs: Record<string, number> = {};
  for (const c of checks) {
    const n = await c.count();
    if (n > 0) refs[c.name] = n;
  }
  if (Object.keys(refs).length)
    throw new ProblemException('in_use_active', undefined, undefined, { references: refs });
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
