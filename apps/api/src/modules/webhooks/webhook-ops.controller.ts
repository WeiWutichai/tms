import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  NoTransaction,
  RequireFeature,
  RequireScope,
  TenantResource,
  RateLimitClass,
  SandboxAware,
} from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import {
  EventDto,
  EventListQuery,
  EventPageDto,
  RedeliverQuery,
  WebhookDeliveryDetailDto,
  WebhookDeliveryListQuery,
  WebhookDeliveryPageDto,
  WebhookRedeliverResultDto,
  WebhookResendResultDto,
} from './webhook-ops.dto';
import { WebhookOpsService } from './webhook-ops.service';

/**
 * ประวัติการส่ง webhook + ส่งซ้ำ (ST7-T05; docs/04 G1 Webhook ops, G2 #2 `webhook-deliveries`; spec/07 INT-106)
 * อ่าน `settings:read` · ส่งซ้ำ `settings:write` + ผู้ใช้ (เหมือนจัดการ endpoint — ST7-T04) · ฟีเจอร์ `webhook` · เก็บ 30 วัน
 */
@ApiTags('webhooks')
@ApiBearerAuth()
@RequireFeature('webhook')
@SandboxAware()
@Controller('webhook-deliveries')
export class WebhookDeliveriesController {
  constructor(private readonly ops: WebhookOpsService) {}

  @Get()
  @RequireScope('settings:read', 'webhooks:manage')
  @ApiOkResponse({
    type: WebhookDeliveryPageDto,
    description:
      'การส่งทีละครั้ง (1 แถว/attempt) ใหม่สุดก่อน · กรอง `eventId`, `endpointId`, `status`, `eventType`, `test`, ช่วงเวลา · เก็บ 30 วัน',
  })
  list(@Query() q: WebhookDeliveryListQuery) {
    return this.ops.list(q);
  }

  @Get(':id')
  @TenantResource('webhookDelivery')
  @RequireScope('settings:read', 'webhooks:manage')
  @ApiOkResponse({
    type: WebhookDeliveryDetailDto,
    description:
      'รายละเอียด + payload ที่ส่ง/response ที่ได้ · ค่า header เพิ่มเติมเป็น `***` · ลายเซ็นแสดงบางส่วน',
  })
  async get(@Param('id') id: string): Promise<WebhookDeliveryDetailDto> {
    return this.ops.detailDto(await this.ops.get(decodeIdOr404('webhookDelivery', id)));
  }

  @Post(':id/retry')
  @RateLimitClass('heavy')
  @HttpCode(200)
  @NoTransaction()
  @TenantResource('webhookDelivery')
  @RequireScope('settings:write', 'webhooks:manage')
  @ApiOkResponse({
    type: WebhookResendResultDto,
    description:
      'ส่ง event ของรายการนี้ไป endpoint เดิมอีกครั้งผ่าน outbox (id เดิม, X-TMS-Attempt +1) รอผล ≤ 10 วิ · ' +
      'event ทดสอบ → 422 `webhook_not_retryable` · endpoint ปิด → 409 · เกิน 30 วัน → 422 `webhook_event_expired` · ถี่เกิน → 429',
  })
  retry(@Param('id') id: string): Promise<WebhookResendResultDto> {
    return this.ops.retry(decodeIdOr404('webhookDelivery', id));
  }
}

/** event สาธารณะ (G2 #2 `events`) — อ่าน (ST7-T11) + ส่ง event เดิมซ้ำ (ST7-T05) */
@ApiTags('webhooks')
@ApiBearerAuth()
@RequireFeature('webhook')
@SandboxAware()
@Controller('events')
export class EventsController {
  constructor(private readonly ops: WebhookOpsService) {}

  @Get()
  @RequireScope('events:read')
  @ApiOkResponse({
    type: EventPageDto,
    description:
      'ST7-T11: event สาธารณะของบริษัท (envelope เดียวกับ webhook — ดึงเองแทน/เสริม webhook) ใหม่สุดก่อน · กรอง `type`, ช่วงเวลา · ' +
      'ไม่ขึ้นกับการสมัคร endpoint · scope `events:read` (docs/01 §5.4) **และ** scope อ่านของ resource ของ event (order.*/delivery_order.* → `orders:read`, trip.*/stop.*/pod.* → `trips:read`, connector.* → `settings:read`, job.* → `jobs:read`) — ชนิดที่อ่านไม่ได้ไม่อยู่ในรายการ · `type` ที่ไม่อยู่ในทะเบียน → 422 · field ราคาถูกตัดตามสิทธิ์ · `mode` = `test` ใน sandbox · ⚠ `evt_` ของ envelope เป็นคนละชุดกับ id ของ event หน้างาน (`GET /v1/stops/{id}/events`)',
  })
  listEvents(@Query() q: EventListQuery): Promise<EventPageDto> {
    return this.ops.listEvents(q);
  }

  @Get(':id')
  @TenantResource('event')
  @RequireScope('events:read')
  @ApiOkResponse({
    type: EventDto,
    description:
      'ST7-T11: envelope ของ event (id เดียวกับ X-TMS-Event-Id) · อ่าน resource ของ event ไม่ได้ / ไม่ใช่ event สาธารณะ = 404',
  })
  getEvent(@Param('id') id: string): Promise<EventDto> {
    return this.ops.getEvent(decodeIdOr404('event', id));
  }

  @Post(':id/redeliver')
  @RateLimitClass('heavy')
  @HttpCode(200)
  @NoTransaction()
  @TenantResource('event')
  @RequireScope('settings:write', 'webhooks:manage')
  @ApiOkResponse({
    type: WebhookRedeliverResultDto,
    description:
      'ส่ง event ซ้ำไป `endpointId` หรือทุก endpoint ที่เปิดอยู่และสมัคร event นี้ (เช่น event ที่เกิดระหว่างปิด endpoint — INT-105) · ' +
      'ผ่าน outbox รอผล ≤ 10 วิ ต่อ endpoint · ภายใน 30 วัน · ไม่ได้สมัคร → 422 `webhook_event_not_subscribed`',
  })
  async redeliver(
    @Param('id') id: string,
    @Query() q: RedeliverQuery,
  ): Promise<WebhookRedeliverResultDto> {
    const ep = q.endpointId ? decodeIdOr404('webhookEndpoint', q.endpointId) : undefined;
    return { data: await this.ops.redeliver(decodeIdOr404('event', id), ep) };
  }
}
