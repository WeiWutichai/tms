import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { PlatformAuth, RateLimitClass } from '../common/decorators';
import { encodeId, tryDecodeId } from '../common/ids';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../db/prisma.service';
import { csvCell } from '../modules/master/export';
import { platformAudit } from './platform-audit';

/** ส่งออกได้สูงสุดต่อครั้ง (เท่าการส่งออกทันทีของรายการอื่น — EXPORT_MAX_ROWS) */
export const PLATFORM_AUDIT_EXPORT_MAX = 10_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class PlatformAuditQuery {
  @ApiPropertyOptional({ example: '2026-11-01', description: 'ตั้งแต่วันที่ (เวลาไทย)' })
  @IsOptional()
  @Matches(DATE)
  from?: string;
  @ApiPropertyOptional({ example: '2026-11-30', description: 'ถึงวันที่ (รวมวันนั้น — เวลาไทย)' })
  @IsOptional()
  @Matches(DATE)
  to?: string;
  @ApiPropertyOptional({ example: 'ten_…', description: 'เฉพาะลูกค้ารายนี้' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  tenantId?: string;
  @ApiPropertyOptional({
    example: 'stf_…',
    description: 'เฉพาะทีมงานคนนี้ (ผู้ทำ หรือผู้เข้าใช้งานแทน)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  staffId?: string;
  @ApiPropertyOptional({
    example: 'impersonation.',
    description: 'รหัสการกระทำ — ขึ้นต้นด้วยค่านี้ (เช่น `impersonation.` / `platform.staff_`)',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(/^[a-z0-9_.]{1,60}$/)
  action?: string;
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
  @MaxLength(200)
  cursor?: string;
}

export class PlatformAuditStaffDto {
  @ApiProperty({ example: 'stf_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ nullable: true, type: String, enum: ['SUPER_ADMIN', 'SUPPORT', 'BILLING'] })
  role!: string | null;
}
export class PlatformAuditUserDto {
  @ApiProperty({ example: 'usr_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
}
export class PlatformAuditTenantDto {
  @ApiProperty({ example: 'ten_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
}
export class PlatformAuditEntryDto {
  @ApiProperty({
    example: 'aud_…',
    description: '`aud_` = audit ของลูกค้า · `pal_` = audit ระดับแพลตฟอร์ม',
  })
  id!: string;
  @ApiProperty({ format: 'date-time' }) at!: string;
  @ApiProperty({
    type: PlatformAuditStaffDto,
    nullable: true,
    description: 'ทีมงาน Innovera ที่ทำ — เข้าใช้งานแทน = claim `act` ของ token',
  })
  staff!: PlatformAuditStaffDto | null;
  @ApiProperty({
    type: PlatformAuditUserDto,
    nullable: true,
    description: 'เข้าใช้งานแทน: ผู้ใช้ของลูกค้าที่สวม (sub) · null = ทีมงานทำเองจาก Console',
  })
  onBehalfOf!: PlatformAuditUserDto | null;
  @ApiProperty({ example: 'impersonation.started' }) action!: string;
  @ApiProperty({ type: PlatformAuditTenantDto, nullable: true, description: 'null = ไม่ผูกลูกค้า' })
  tenant!: PlatformAuditTenantDto | null;
  @ApiProperty() entityType!: string;
  @ApiProperty({ nullable: true, type: String }) entityId!: string | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true }) before!: unknown;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true }) after!: unknown;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ nullable: true, type: String }) ip!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'การเข้าใช้งานแทนที่เกี่ยวข้อง' })
  impersonationSessionId!: string | null;
}
export class PlatformAuditPageDto {
  @ApiProperty({ type: [PlatformAuditEntryDto] }) data!: PlatformAuditEntryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

interface Row {
  src: 'a' | 'p';
  id: string;
  at: Date;
  /** เวลาเป็นไมโครวินาทีจาก epoch (ความละเอียดเต็มของ timestamptz — ใช้ทำ cursor; Date ของ JS ละเอียดแค่มิลลิวินาที) */
  at_us: bigint;
  seq: bigint;
  tenant_id: string | null;
  actor_id: string | null;
  act_as: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const staffOf = (v: string | null) =>
  v?.startsWith('platform:') && UUID.test(v.slice(9)) ? v.slice(9) : null;

/** cursor = ตำแหน่งแถวสุดท้าย (at เป็นไมโครวินาที, แหล่ง, seq) — เรียงใหม่ก่อน */
function decodeCursor(c: string): { us: bigint; src: string; seq: bigint } {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof v.t !== 'string' ||
      !/^\d{1,18}$/.test(v.t) ||
      (v.r !== 'a' && v.r !== 'p') ||
      typeof v.s !== 'string' ||
      !/^\d{1,18}$/.test(v.s)
    )
      throw new Error();
    return { us: BigInt(v.t), src: v.r, seq: BigInt(v.s) };
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}

/** วันที่แบบไทย (UTC+7) → ขอบเวลา */
const bkk = (d: string, endOfDay = false) =>
  new Date(`${d}T00:00:00+07:00`).getTime() + (endOfDay ? 86400_000 : 0);

/**
 * Audit log ของ Platform Console (P1-ST4-T06; spec/01 §11.5, docs/02 §5 "ทุก action ของทีม Innovera บนข้อมูลลูกค้า")
 * รวมสองแหล่ง: audit_log ของทุก tenant เฉพาะแถวที่ทีมงานทำ (actor หรือ act = `platform:<id>` — รวมการเข้าใช้งานแทน)
 * + platform_audit_log (เชิญ/ปิดทีมงาน, ส่งออก) · อ่านอย่างเดียว ไม่มี API แก้/ลบ (PLT-126) · ทีมงานทุกบทบาทดูได้ (§11.4)
 */
@ApiTags('platform-console')
@ApiBearerAuth()
@Controller('platform/audit-logs')
export class PlatformAuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @PlatformAuth()
  @ApiOkResponse({ type: PlatformAuditPageDto })
  async list(@Query() q: PlatformAuditQuery): Promise<PlatformAuditPageDto> {
    const limit = q.limit ?? 50;
    const rows = await this.query(q, limit + 1, q.cursor ? decodeCursor(q.cursor) : null);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: await this.toDtos(page),
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ t: String(last.at_us), r: last.src, s: String(last.seq) }),
            ).toString('base64url')
          : null,
      hasMore,
    };
  }

  /** ส่งออก CSV (UTF-8 + BOM) ตามตัวกรองเดียวกับรายการ สูงสุด 10,000 แถว · การส่งออกลง audit เอง */
  @Get('export')
  @PlatformAuth()
  @RateLimitClass('heavy')
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'ไฟล์ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว ใหม่ก่อน)' })
  async export(
    @Query() q: PlatformAuditQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.query(q, PLATFORM_AUDIT_EXPORT_MAX, null);
    const data = await this.toDtos(rows);
    await platformAudit(this.prisma.platform, {
      action: 'platform.audit_exported',
      entityType: 'platform_audit_log',
      after: {
        rows: data.length,
        filters: {
          from: q.from ?? null,
          to: q.to ?? null,
          tenantId: q.tenantId ?? null,
          staffId: q.staffId ?? null,
          action: q.action ?? null,
        },
      },
    });
    const header = [
      'เวลา',
      'ทีมงาน',
      'บทบาท',
      'ในนาม',
      'การกระทำ',
      'ลูกค้า',
      'ชนิดข้อมูล',
      'รหัสข้อมูล',
      'ก่อน',
      'หลัง',
      'เหตุผล',
      'IP',
      'การเข้าใช้งานแทน',
    ];
    const json = (v: unknown) => (v === null || v === undefined ? '' : JSON.stringify(v));
    const lines = [header.map(csvCell).join(',')];
    for (const e of data)
      lines.push(
        [
          e.at,
          e.staff?.name ?? e.staff?.id ?? '',
          e.staff?.role ?? '',
          e.onBehalfOf?.name ?? e.onBehalfOf?.id ?? '',
          e.action,
          e.tenant?.name ?? e.tenant?.id ?? '',
          e.entityType,
          e.entityId,
          json(e.before),
          json(e.after),
          e.reason,
          e.ip,
          e.impersonationSessionId,
        ]
          .map((v) => csvCell(v))
          .join(','),
      );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="platform-audit-log.csv"');
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8'));
  }

  private async query(
    q: PlatformAuditQuery,
    take: number,
    cursor: { us: bigint; src: string; seq: bigint } | null,
  ): Promise<Row[]> {
    if (q.from && q.to && q.from > q.to)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'to', code: 'date_range', message: 'to must be on or after from' },
      ]);
    // ตัวกรองที่ไม่ตรงรูป id → ไม่มีผล (ไม่ใช่ 422 — เหมือน /audit-logs entityId)
    const tenant: string | false | null = q.tenantId
      ? (tryDecodeId('tenant', q.tenantId) ?? false)
      : null;
    const staff = q.staffId ? (tryDecodeId('platformUser', q.staffId) ?? '__none__') : null;
    const a: Prisma.Sql[] = [
      Prisma.sql`(a.actor_id LIKE 'platform:%' OR a.act_as LIKE 'platform:%')`,
    ];
    const p: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (q.from) {
      const t = new Date(bkk(q.from));
      a.push(Prisma.sql`a.at >= ${t}`);
      p.push(Prisma.sql`p.at >= ${t}`);
    }
    if (q.to) {
      const t = new Date(bkk(q.to, true));
      a.push(Prisma.sql`a.at < ${t}`);
      p.push(Prisma.sql`p.at < ${t}`);
    }
    if (tenant !== null) {
      // id ผิดรูป = ไม่มีแถวตรง (ไม่ cast ค่าที่ไม่ใช่ uuid)
      a.push(tenant === false ? Prisma.sql`FALSE` : Prisma.sql`a.tenant_id = ${tenant}::uuid`);
      p.push(Prisma.sql`FALSE`); // แถวระดับแพลตฟอร์มไม่ผูกลูกค้า
    }
    if (staff) {
      const k = `platform:${staff}`;
      a.push(Prisma.sql`(a.actor_id = ${k} OR a.act_as = ${k})`);
      p.push(Prisma.sql`p.actor_id::text = ${staff}`);
    }
    if (q.action) {
      const like = `${q.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      a.push(Prisma.sql`a.action LIKE ${like}`);
      p.push(Prisma.sql`p.action LIKE ${like}`);
    }
    const after = cursor
      ? Prisma.sql`WHERE (x.at, x.src, x.seq) < ('epoch'::timestamptz + ${cursor.us}::bigint * interval '1 microsecond', ${cursor.src}, ${cursor.seq})`
      : Prisma.empty;
    return this.prisma.platform.$queryRaw<Row[]>`
      SELECT * FROM (SELECT x0.*, (EXTRACT(EPOCH FROM x0.at) * 1000000)::bigint AS at_us FROM (
        SELECT 'a'::text AS src, a.id::text AS id, a.at, a.seq, a.tenant_id::text AS tenant_id,
               a.actor_id, a.act_as, a.action, a.entity_type, a.entity_id, a.before, a.after, a.reason, a.ip
          FROM audit_log a WHERE ${Prisma.join(a, ' AND ')}
        UNION ALL
        SELECT 'p'::text, p.id::text, p.at, p.seq, NULL::text,
               CASE WHEN p.actor_id IS NULL THEN NULL ELSE 'platform:' || p.actor_id::text END, NULL::text,
               p.action, p.entity_type, p.entity_id, p.before, p.after, p.reason, p.ip
          FROM platform_audit_log p WHERE ${Prisma.join(p, ' AND ')}
      ) x0) x ${after}
      ORDER BY x.at DESC, x.src DESC, x.seq DESC
      LIMIT ${take}`;
  }

  private async toDtos(rows: Row[]): Promise<PlatformAuditEntryDto[]> {
    const db = this.prisma.platform;
    // ผู้ทำ: act ก่อน (เข้าใช้งานแทน — sub = ผู้ใช้ของลูกค้า) ไม่งั้น actor
    const who = rows.map((r) => {
      const act = staffOf(r.act_as);
      return act
        ? { staff: act, asUser: r.actor_id && UUID.test(r.actor_id) ? r.actor_id : null }
        : { staff: staffOf(r.actor_id), asUser: null };
    });
    const staffIds = [...new Set(who.map((w) => w.staff).filter((x): x is string => !!x))];
    const userIds = [...new Set(who.map((w) => w.asUser).filter((x): x is string => !!x))];
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter((x): x is string => !!x))];
    const [staff, users, tenants] = await Promise.all([
      staffIds.length
        ? db.platformUser.findMany({
            where: { id: { in: staffIds } },
            select: { id: true, name: true, role: true },
          })
        : [],
      userIds.length
        ? db.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
        : [],
      tenantIds.length
        ? db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
        : [],
    ]);
    const S = new Map(staff.map((s) => [s.id, s]));
    const U = new Map(users.map((u) => [u.id, u.name]));
    const T = new Map(tenants.map((t) => [t.id, t.name]));
    return rows.map((r, i) => {
      const w = who[i]!;
      const s = w.staff ? S.get(w.staff) : undefined;
      const after = (r.after ?? null) as Record<string, unknown> | null;
      const sid =
        r.entity_type === 'impersonation_session'
          ? r.entity_id
          : r.action.startsWith('impersonation.') && typeof after?.sessionId === 'string'
            ? after.sessionId
            : null;
      return {
        id: encodeId(r.src === 'a' ? 'audit' : 'platformAudit', r.id),
        at: r.at.toISOString(),
        staff: w.staff
          ? {
              id: encodeId('platformUser', w.staff),
              name: s?.name ?? null,
              role: s?.role ?? null,
            }
          : null,
        onBehalfOf: w.asUser
          ? { id: encodeId('user', w.asUser), name: U.get(w.asUser) ?? null }
          : null,
        action: r.action,
        tenant: r.tenant_id
          ? { id: encodeId('tenant', r.tenant_id), name: T.get(r.tenant_id) ?? null }
          : null,
        entityType: r.entity_type,
        entityId:
          r.entity_type === 'platform_user' && r.entity_id && UUID.test(r.entity_id)
            ? encodeId('platformUser', r.entity_id)
            : r.entity_type === 'tenant' && r.entity_id && UUID.test(r.entity_id)
              ? encodeId('tenant', r.entity_id)
              : r.entity_type === 'user' && r.entity_id && UUID.test(r.entity_id)
                ? encodeId('user', r.entity_id)
                : r.entity_id,
        before: r.before ?? null,
        after: r.after ?? null,
        reason: r.reason,
        ip: r.ip,
        impersonationSessionId: sid,
      };
    });
  }
}
