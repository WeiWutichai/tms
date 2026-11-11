import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { Notification } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';

export class NotificationListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
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

  @ApiPropertyOptional({ description: 'true = เฉพาะที่ยังไม่อ่าน' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  unread?: boolean;
}

export class NotificationDto {
  @ApiProperty({ example: 'ntf_…' }) id!: string;
  @ApiProperty({ example: 'job.succeeded' }) type!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ nullable: true, type: String, description: 'path ภายในเว็บ' }) link!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) entityType!: string | null;
  @ApiProperty({ nullable: true, type: String }) entityId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) readAt!: string | null;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationDto] }) data!: NotificationDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class UnreadCountDto {
  @ApiProperty() unread!: number;
}

export class ReadAllDto {
  @ApiProperty({ description: 'จำนวนที่ทำเครื่องหมายว่าอ่านแล้ว' }) updated!: number;
}

/**
 * กระดิ่งแจ้งเตือนของผู้ใช้ที่ login (ST1-T23) — เห็นเฉพาะของตัวเอง ช่อง in_app เท่านั้น
 * (แถวช่องอีเมลเป็นประวัติการส่ง ไม่แสดงในกระดิ่ง)
 * ข้อยกเว้นมาตรฐาน list (docs/01 §5.1): เรียงใหม่ → เก่าด้วย (createdAt, id) และไม่มี updatedAfter/sort
 * เพราะเป็นกล่องข้อความส่วนตัว ไม่ใช่ข้อมูลที่ระบบอื่น sync — limit ค่าเริ่มต้น 20 สูงสุด 100
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @ApiOkResponse({ type: NotificationPageDto })
  async list(@Query() q: NotificationListQuery): Promise<NotificationPageDto> {
    const me = this.me();
    const limit = q.limit ?? 20;
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await this.db.tx.notification.findMany({
      where: {
        recipientId: me,
        channel: 'in_app',
        ...(q.unread ? { readAt: null } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.at } },
                { createdAt: cursor.at, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      data: page.map(toDto),
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ a: last.createdAt.toISOString(), i: last.id })).toString(
              'base64url',
            )
          : null,
      hasMore,
    };
  }

  @Get('unread-count')
  @ApiOkResponse({ type: UnreadCountDto })
  async unreadCount(): Promise<UnreadCountDto> {
    const unread = await this.db.tx.notification.count({
      where: { recipientId: this.me(), channel: 'in_app', readAt: null },
    });
    return { unread };
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOkResponse({ type: ReadAllDto })
  async readAll(): Promise<ReadAllDto> {
    const r = await this.db.tx.notification.updateMany({
      where: { recipientId: this.me(), channel: 'in_app', readAt: null },
      data: { readAt: new Date(), status: 'READ' },
    });
    return { updated: r.count };
  }

  /** ของคนอื่น/บริษัทอื่น → 404 เหมือนไม่มี */
  @Post(':id/read')
  @HttpCode(204)
  @TenantResource('notification')
  @ApiNoContentResponse()
  async read(@Param('id') id: string): Promise<void> {
    const uuid = decodeIdOr404('notification', id);
    const n = await this.db.tx.notification.findFirst({
      where: { id: uuid, recipientId: this.me(), channel: 'in_app' },
      select: { id: true, readAt: true },
    });
    if (!n) throw new ProblemException('not_found');
    if (!n.readAt)
      await this.db.tx.notification.updateMany({
        where: { id: uuid, readAt: null },
        data: { readAt: new Date(), status: 'READ' },
      });
  }

  /** ผู้ใช้จริงเท่านั้น (API key/client credentials ไม่มีกล่องแจ้งเตือน) */
  private me(): string {
    const ctx = requestContext.require();
    const actor = ctx.actorId;
    // principal ที่ไม่ใช่ผู้ใช้ (client credentials/link/driver ในอนาคต) ไม่มีกล่องแจ้งเตือน — dev token ใช้ใน test
    if (ctx.principalType !== 'user' && ctx.principalType !== 'dev')
      throw new ProblemException('not_found');
    if (!actor || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor))
      throw new ProblemException('not_found');
    return actor;
  }
}

function toDto(n: Notification): NotificationDto {
  return {
    id: encodeId('notification', n.id),
    type: n.templateCode,
    title: n.title,
    body: n.body,
    link: n.link,
    entityType: n.relatedEntityType,
    entityId: n.relatedEntityId,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt?.toISOString() ?? null,
  };
}

function decodeCursor(c: string): { at: Date; id: string } {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { a: string; i: string };
    const at = new Date(v.a);
    if (
      Number.isNaN(at.getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v.i))
    )
      throw new Error();
    return { at, id: v.i };
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}
