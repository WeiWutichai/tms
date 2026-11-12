import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import {
  ChannelStatusListDto,
  MessageDeliveryDto,
  MessageDeliveryListQuery,
  MessageDeliveryPageDto,
  MessagingSettingsDto,
  SendLinkDto,
  UpdateMessagingSettingsDto,
} from './messaging.dto';
import { MessagingService } from './messaging.service';

/**
 * ส่งลิงก์ทาง LINE / SMS + บันทึกการส่ง (ST3-T21; docs/04 G4, I)
 * สิทธิ์ตามชนิดลิงก์ (docs/04 A3): ลิงก์เอกสารรถร่วม = ข้อมูลหลัก (`master:write` ส่ง / `master:read` ดู) ·
 * ลิงก์ข้อเสนองาน (ST3-T23) = จ่ายงาน (`trips:assign` ส่ง / `trips:read` ดู)
 */
@ApiTags('messaging')
@ApiBearerAuth()
@Controller('messages')
export class MessagesController {
  constructor(private readonly svc: MessagingService) {}

  @Post('send-link')
  @HttpCode(202)
  @RequireScope('master:write', 'trips:assign')
  @ApiAcceptedResponse({
    type: MessageDeliveryDto,
    description:
      'เข้าคิวส่งแล้ว (status `queued`) — worker ส่งจริงพร้อม retry; ติดตามผลที่ GET /v1/messages/{id} · ' +
      'ส่งไม่ได้/ล้ม ผู้ใช้ยังคัดลอก url ไปส่งเองได้เสมอ',
  })
  @ApiConflictResponse({ description: '`channel_unavailable` — ช่องทางปิดหรือยังไม่ตั้งค่า' })
  @ApiTooManyRequestsResponse({ description: 'เกินเพดานต่อบริษัท/ชั่วโมง หรือต่อผู้รับ/ชั่วโมง' })
  send(@Body() body: SendLinkDto): Promise<MessageDeliveryDto> {
    return this.svc.sendLink(body);
  }

  @Get()
  @RequireScope('master:read', 'trips:read')
  @ApiOkResponse({
    type: MessageDeliveryPageDto,
    description:
      'บันทึกการส่ง ใหม่ → เก่า (เฉพาะชนิดลิงก์ที่มีสิทธิ์ดู) — ผู้รับแสดงแบบปิดบังเสมอ ไม่มีเนื้อความ',
  })
  list(@Query() q: MessageDeliveryListQuery): Promise<MessageDeliveryPageDto> {
    return this.svc.list(q);
  }

  @Get('channels')
  @RequireScope('master:read', 'trips:read')
  @ApiOkResponse({
    type: ChannelStatusListDto,
    description: 'ช่องทางที่ส่งได้ตอนนี้ — UI ซ่อนปุ่มส่งของช่องที่ใช้ไม่ได้ (เหลือคัดลอกลิงก์)',
  })
  async channels(): Promise<ChannelStatusListDto> {
    return { data: await this.svc.channels() };
  }

  @Get(':id')
  @TenantResource('messageDelivery')
  @RequireScope('master:read', 'trips:read')
  @ApiOkResponse({ type: MessageDeliveryDto })
  get(@Param('id') id: string): Promise<MessageDeliveryDto> {
    return this.svc.get(decodeIdOr404('messageDelivery', id));
  }
}

/** ตั้งค่า LINE OA / SMS ต่อบริษัท — token เขียนได้อย่างเดียว (ไม่คืนค่า) */
@ApiTags('messaging')
@ApiBearerAuth()
@Controller('settings/messaging')
export class MessagingSettingsController {
  constructor(private readonly svc: MessagingService) {}

  @Get()
  @RequireScope('settings:read')
  @ApiOkResponse({ type: MessagingSettingsDto })
  get(): Promise<MessagingSettingsDto> {
    return this.svc.getSettings();
  }

  @Patch()
  @RequireScope('settings:write')
  @ApiOkResponse({ type: MessagingSettingsDto })
  update(@Body() body: UpdateMessagingSettingsDto): Promise<MessagingSettingsDto> {
    return this.svc.updateSettings(body);
  }
}
