import { Body, Controller, Get, Param, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDefined, IsString, MaxLength, MinLength } from 'class-validator';
import { PlatformAuth } from '../common/decorators';
import { expectedVersion, setEtag } from '../common/etag';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { PrismaService } from '../db/prisma.service';
import { platformAudit } from './platform-audit';
import { PlatformSettingsService } from './platform-settings.service';
import {
  crossSettingError,
  parsePlatformSetting,
  PLATFORM_SETTING_KEYS,
  PLATFORM_SETTINGS,
  type PlatformSettingDef,
  type PlatformSettingKey,
} from './platform-settings.registry';

export class PlatformSettingDto {
  @ApiProperty({ example: 'trial.days', enum: PLATFORM_SETTING_KEYS }) key!: string;
  @ApiProperty({ enum: ['trial', 'dunning', 'retention', 'usage', 'billing', 'ops'] })
  group!: string;
  @ApiProperty({
    enum: ['int', 'bool', 'enum', 'decimal', 'set', 'dayLists'],
    description: 'ชนิดค่า (ตรวจที่ server — ผิด type → 422)',
  })
  type!: string;
  @ApiProperty({ description: 'ค่าที่มีผล (number · boolean · string · string[] · object)' })
  value!: unknown;
  @ApiProperty({ description: 'ค่าเริ่มต้น' }) default!: unknown;
  @ApiProperty({ description: 'ยังใช้ค่าเริ่มต้น (ไม่เคยตั้ง)' }) isDefault!: boolean;
  @ApiPropertyOptional({ type: [String], description: 'ค่าที่เลือกได้ (enum / set)' })
  options?: string[];
  @ApiPropertyOptional({ description: 'ต่ำสุด (int / decimal / dayLists)' }) min?: number | string;
  @ApiPropertyOptional({ description: 'สูงสุด (int / decimal / dayLists)' }) max?: number | string;
  @ApiPropertyOptional({ type: [String], description: 'ชื่อกลุ่มวัน (dayLists)' }) keys?: string[];
  @ApiProperty({ example: 'docs/02 §2 · D-43' }) source!: string;
  @ApiProperty() description!: string;
  @ApiProperty({
    description:
      'เลขเวอร์ชันของค่า (0 = ไม่เคยตั้ง) = ETag — ส่งกลับใน If-Match กันทับกัน (docs/01 §5.1)',
  })
  version!: number;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) updatedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อทีมงานที่แก้ล่าสุด' })
  updatedBy!: string | null;
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export class UpdatePlatformSettingDto {
  @ApiProperty({
    description: 'ค่าใหม่ตามชนิดของ key',
    oneOf: [
      { type: 'integer' },
      { type: 'boolean' },
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
      { type: 'object', additionalProperties: { type: 'array', items: { type: 'integer' } } },
    ],
  })
  @IsDefined()
  value!: unknown;
  @ApiProperty({ example: 'PO เคาะ D-43 trial 30 วัน', minLength: 10 })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

/**
 * ค่าตั้งแพลตฟอร์ม (P1-ST1-T04; spec/01 §9 PLT-099 · §11.4 "แก้…ค่าตั้งแพลตฟอร์ม" = owner)
 * ดู: ทีมทุกบทบาท · แก้: SUPER_ADMIN + เหตุผล ≥ 10 + platform_audit_log (before/after)
 */
@ApiTags('platform-console')
@ApiBearerAuth()
@Controller('platform/settings')
export class PlatformSettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  @Get()
  @PlatformAuth()
  @ApiOkResponse({ type: [PlatformSettingDto] })
  async list(): Promise<PlatformSettingDto[]> {
    const db = this.prisma.platform;
    const rows = await db.platformSetting.findMany();
    const by = new Map(rows.map((r) => [r.key, r]));
    const staffIds = [...new Set(rows.map((r) => r.updatedBy).filter((x): x is string => !!x))];
    const staff = await db.platformUser.findMany({
      where: { id: { in: staffIds } },
      select: { id: true, name: true },
    });
    const name = new Map(staff.map((s) => [s.id, s.name]));
    const values = await this.settings.all(db);
    return PLATFORM_SETTING_KEYS.map((k) => {
      const def: PlatformSettingDef = PLATFORM_SETTINGS[k];
      const row = by.get(k);
      const t = def.type;
      return {
        key: k,
        group: def.group,
        type: t.kind,
        value: values[k],
        default: def.default,
        isDefault: !row,
        ...('values' in t ? { options: [...t.values] } : {}),
        ...('min' in t ? { min: t.min, max: t.max } : {}),
        ...(t.kind === 'dayLists' ? { keys: [...t.keys] } : {}),
        source: def.source,
        description: def.description,
        version: row?.version ?? 0,
        updatedAt: row?.updatedAt.toISOString() ?? null,
        updatedBy: row?.updatedBy ? (name.get(row.updatedBy) ?? null) : null,
      };
    });
  }

  /** ค่าตั้ง 1 ตัว + header ETag = version (0 = ยังเป็นค่าเริ่มต้น) */
  @Get(':key')
  @PlatformAuth()
  @ApiOkResponse({ type: PlatformSettingDto })
  async one(
    @Param('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlatformSettingDto> {
    const s = (await this.list()).find((x) => x.key === key);
    if (!s) throw new ProblemException('not_found');
    setEtag(res, s.version);
    return s;
  }

  /** ตั้งค่า (upsert) — key ไม่มีใน registry → 404 · ค่าผิด type/ช่วง → 422 · If-Match ไม่ตรง → 412 */
  @Put(':key')
  @PlatformAuth('SUPER_ADMIN')
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: 'ETag/version ของค่าตั้ง ("0" = ยังไม่เคยตั้ง) — ไม่ตรง → 412',
  })
  @ApiOkResponse({ type: PlatformSettingDto })
  async update(
    @Param('key') key: string,
    @Body() body: UpdatePlatformSettingDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlatformSettingDto> {
    if (!(PLATFORM_SETTING_KEYS as string[]).includes(key)) throw new ProblemException('not_found');
    const k = key as PlatformSettingKey;
    const def: PlatformSettingDef = PLATFORM_SETTINGS[k];
    const parsed = parsePlatformSetting(def, body.value);
    if (!parsed.ok)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'value', code: parsed.code, message: `${key}: ${parsed.code}` },
      ]);
    const ctx = requestContext.require();
    const want = expectedVersion(req);
    await this.prisma.platform.$transaction(async (tx) => {
      // ล็อกแถวทั้งชุดตามลำดับ key กันสองคนแก้กฎข้ามช่อง (dunning) พร้อมกัน
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform_setting'))`;
      const cur = await tx.platformSetting.findUnique({ where: { key: k } });
      if (want !== undefined && want !== (cur?.version ?? 0))
        throw new ProblemException('precondition_failed');
      const all = await this.settings.all(tx);
      const before = all[k];
      const cross = crossSettingError({ ...all, [k]: parsed.value });
      if (cross)
        throw new ProblemException('validation_failed', undefined, [
          { field: 'value', code: cross.code, message: cross.code },
        ]);
      const value = parsed.value as Prisma.InputJsonValue;
      await tx.platformSetting.upsert({
        where: { key: k },
        create: { key: k, value, updatedBy: ctx.platformUser!.id },
        update: { value, version: { increment: 1 }, updatedBy: ctx.platformUser!.id },
      });
      await platformAudit(tx, {
        action: 'platform.setting_changed',
        entityType: 'platform_setting',
        entityId: k,
        reason: body.reason,
        before: { value: before },
        after: { value: parsed.value },
      });
    });
    return this.one(k, res);
  }
}
