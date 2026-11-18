import { Body, Controller, Get, Injectable, Patch, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import type { Request, Response } from 'express';
import { expectedVersion, setEtag } from '../../common/etag';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import {
  EVENT_CATALOGUE,
  NOTIFICATION_EVENTS,
  NOTIFICATION_PREF_KEY,
  PREF_CHANNELS,
  channelEnabled,
  digestEnabled,
  parsePrefs,
  type NotificationEvent,
  type StoredPrefs,
} from './catalogue';

export class NotificationEventPrefDto {
  @ApiProperty({ enum: NOTIFICATION_EVENTS }) event!: NotificationEvent;
  @ApiProperty({ description: 'ในระบบ (กระดิ่ง)' }) inApp!: boolean;
  @ApiProperty() email!: boolean;
  @ApiProperty({ description: 'LINE ของทีมภายใน = P1 — ยังตั้งไม่ได้ (false เสมอ)' })
  line!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'งานที่จะเริ่มส่ง event นี้ (ยังไม่เปิด) — null = ส่งแล้ว',
    example: null,
  })
  pendingTask!: string | null;
}

export class NotificationPreferencesDto {
  @ApiProperty({ type: [NotificationEventPrefDto] }) events!: NotificationEventPrefDto[];
  @ApiProperty({ description: 'สรุปรายวัน 08:00 ทางอีเมล' }) dailyDigest!: boolean;
  @ApiProperty({ description: '0 = ยังไม่เคยบันทึก (ค่าเริ่มต้นทั้งหมด)' }) version!: number;
}

export class NotificationEventPrefInput {
  @ApiProperty({ enum: NOTIFICATION_EVENTS })
  @IsIn(NOTIFICATION_EVENTS)
  event!: NotificationEvent;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  inApp?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  email?: boolean;
}

export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional({
    type: [NotificationEventPrefInput],
    description: 'เฉพาะ event/ช่องที่ต้องการเปลี่ยน (ที่ไม่ส่ง = คงเดิม)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(NOTIFICATION_EVENTS.length)
  @ValidateNested({ each: true })
  @Type(() => NotificationEventPrefInput)
  events?: NotificationEventPrefInput[];

  @ApiPropertyOptional({ description: 'สรุปรายวัน 08:00 ทางอีเมล' })
  @IsOptional()
  @IsBoolean()
  dailyDigest?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDto(p: StoredPrefs, version: number): NotificationPreferencesDto {
  return {
    events: NOTIFICATION_EVENTS.map((e) => ({
      event: e,
      inApp: channelEnabled(p, e, 'in_app'),
      email: channelEnabled(p, e, 'email'),
      line: false,
      pendingTask: EVENT_CATALOGUE[e].pending,
    })),
    dailyDigest: digestEnabled(p),
    version,
  };
}

/**
 * การตั้งค่ารับแจ้งเตือนของผู้ใช้ (ST9-T08; docs/04 I "ผู้ใช้ตั้งว่ารับอะไรทางไหน", spec/01 §13.5 "ผู้ใช้แต่ละคนปิดช่องทางของตัวเองได้")
 * เก็บใน `user_preference` key `notifications` (RLS ต่อ tenant + แถวของผู้ใช้เอง) — ค่าส่วนตัว ไม่ลง audit (เหมือนกระดานวางแผน/saved view)
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly db: DbService) {}

  async get(): Promise<NotificationPreferencesDto> {
    const userId = await this.userId();
    const row = await this.db.tx.userPreference.findUnique({
      where: { userId_key: { userId, key: NOTIFICATION_PREF_KEY } },
    });
    return toDto(parsePrefs(row?.value), row?.version ?? 0);
  }

  /** เปลี่ยนเฉพาะที่ส่งมา · `expected` (If-Match) ไม่ตรง → 412 */
  async patch(
    body: UpdateNotificationPreferencesDto,
    expected?: number,
  ): Promise<NotificationPreferencesDto> {
    const ctx = requestContext.require();
    const userId = await this.userId();
    const tx = this.db.tx;
    const cur = await tx.userPreference.findUnique({
      where: { userId_key: { userId, key: NOTIFICATION_PREF_KEY } },
    });
    if (expected !== undefined && expected !== (cur?.version ?? 0))
      throw new ProblemException('precondition_failed');
    const next = parsePrefs(cur?.value);
    for (const x of body.events ?? []) {
      const ch = { ...(next.events[x.event] ?? {}) };
      if (x.inApp !== undefined) ch.in_app = x.inApp;
      if (x.email !== undefined) ch.email = x.email;
      next.events[x.event] = ch;
    }
    if (body.dailyDigest !== undefined) next.dailyDigest = body.dailyDigest;
    // เก็บเฉพาะค่าที่ต่างจากค่าเริ่มต้น — ค่าเริ่มต้นเปลี่ยนภายหลังแล้วผู้ที่ไม่เคยแตะได้ค่าใหม่
    const value: StoredPrefs = { events: {} };
    for (const e of NOTIFICATION_EVENTS)
      for (const c of PREF_CHANNELS) {
        const v = next.events[e]?.[c];
        if (v !== undefined && v !== EVENT_CATALOGUE[e].defaults[c])
          value.events[e] = { ...(value.events[e] ?? {}), [c]: v };
      }
    if (next.dailyDigest !== undefined && next.dailyDigest !== digestEnabled({ events: {} }))
      value.dailyDigest = next.dailyDigest;
    const json = value as unknown as Prisma.InputJsonObject;
    if (!cur) {
      try {
        const row = await tx.userPreference.create({
          data: { tenantId: ctx.tenantId!, userId, key: NOTIFICATION_PREF_KEY, value: json },
        });
        return toDto(value, row.version);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw new ProblemException('precondition_failed');
        throw e;
      }
    }
    const r = await tx.userPreference.updateMany({
      where: { id: cur.id, version: cur.version },
      data: { value: json, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return toDto(value, cur.version + 1);
  }

  /** ผู้ใช้จริงที่ ACTIVE เท่านั้น (API key/client credentials/link ไม่มีค่าส่วนตัว → 404) */
  private async userId(): Promise<string> {
    const ctx = requestContext.require();
    if (ctx.principalType !== 'user' && ctx.principalType !== 'dev')
      throw new ProblemException('not_found');
    const u =
      ctx.actorId && UUID.test(ctx.actorId)
        ? await this.db.tx.appUser.findFirst({
            where: { id: ctx.actorId, status: 'ACTIVE' },
            select: { id: true },
          })
        : null;
    if (!u) throw new ProblemException('not_found');
    return u.id;
  }
}

/**
 * ตั้งค่า → การแจ้งเตือน แท็บ "ทีมภายใน" (ต้นแบบ TMS v4 vSet `noti`) — ทุก role ตั้งของตัวเองได้ (ไม่ต้องมีสิทธิ์ settings)
 * ช่อง: ในระบบ / อีเมล · LINE ทีมภายใน = P1 · สรุปรายวัน 08:00 (อีเมล)
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('me/notification-preferences')
export class NotificationPreferencesController {
  constructor(private readonly prefs: NotificationPreferencesService) {}

  @Get()
  @ApiOperation({ summary: 'การตั้งค่ารับแจ้งเตือนของฉัน (event × ช่องทาง + สรุปรายวัน 08:00)' })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  async get(@Res({ passthrough: true }) res: Response): Promise<NotificationPreferencesDto> {
    const p = await this.prefs.get();
    setEtag(res, p.version);
    return p;
  }

  @Patch()
  @ApiOperation({ summary: 'เปลี่ยนการตั้งค่ารับแจ้งเตือนของฉัน (เฉพาะที่ส่งมา)' })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  async patch(
    @Body() body: UpdateNotificationPreferencesDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NotificationPreferencesDto> {
    const p = await this.prefs.patch(body, expectedVersion(req));
    setEtag(res, p.version);
    return p;
  }
}
