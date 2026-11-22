import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuditPageDto } from '../../audit/audit.controller';
import {
  NoTransaction,
  RequireFeature,
  RequireScope,
  RequireStepUp,
  StepUpWhen,
  TenantResource,
  RateLimitClass,
  SandboxAware,
} from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { EVENT_REGISTRY } from '@tms/domain';
import { entityHistory, HistoryQuery } from '../master/history';
import {
  CreateWebhookDto,
  UpdateWebhookDto,
  WebhookActionDto,
  WebhookReasonDto,
  WebhookEndpointDto,
  WebhookEndpointSecretDto,
  WebhookEventTypeListDto,
  WebhookListQuery,
  WebhookPageDto,
  WebhookSummaryDto,
  WebhookTestDto,
  WebhookTestResultDto,
} from './webhook.dto';
import { sampleObject, WebhooksService } from './webhooks.service';
import { publishedEventSchema } from './event-openapi';

/** ผลมี secret ที่แสดงครั้งเดียว — ห้ามเก็บลงตาราง idempotency (เหมือน API key ST7-T01) */
function noIdempotencyKey(req: Request) {
  if (req.header('idempotency-key'))
    throw new ProblemException(
      'bad_request',
      'Idempotency-Key is not supported here — the response contains a one-time secret',
    );
}

const IF_MATCH = { name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' };

/**
 * Webhook endpoints (ST7-T04; docs/04 G1 Webhook, G2 #2 `webhooks`; docs/01 §5.3; spec/07 §10)
 * หน้า ตั้งค่า → นักพัฒนา / Open API → Webhooks · อ่าน `settings:read` · จัดการ `settings:write` · ฟีเจอร์ `webhook` ของแพ็กเกจ
 * ส่ง: envelope `{id,type,version,occurredAt,tenantId,mode,data{object,previousAttributes},request}` +
 * `X-TMS-Event/-Event-Id/-Timestamp/-Signature: t=,v1=/-Attempt` · HMAC-SHA256(secret, `t.rawBody`) · timeout 10 วิ ·
 * retry 8 ครั้ง (1m,5m,30m,2h,6h,12h,24h,24h) · at-least-once · ปิดอัตโนมัติหลัง 50 event ล้มติด + แจ้งอีเมล
 * ประวัติการส่ง/ส่งซ้ำ = webhook-ops.controller.ts (ST7-T05)
 */
@ApiTags('webhooks')
@ApiBearerAuth()
@RequireFeature('webhook')
@SandboxAware()
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly hooks: WebhooksService,
    private readonly db: DbService,
  ) {}

  @Get()
  @RequireScope('settings:read')
  @ApiOkResponse({ type: WebhookPageDto })
  list(@Query() q: WebhookListQuery) {
    return this.hooks.list(q);
  }

  @Get('summary')
  @RequireScope('settings:read')
  @ApiOkResponse({
    type: WebhookSummaryDto,
    description: 'จำนวนต่อสถานะ (แท็บ) + limit ของแพ็กเกจ',
  })
  summary(): Promise<WebhookSummaryDto> {
    return this.hooks.summary();
  }

  @Get('event-types')
  @RequireScope('settings:read')
  @ApiOkResponse({
    type: WebhookEventTypeListDto,
    description:
      'ทะเบียน event สาธารณะ (docs/01 §5.3 — ST7-T06): คำอธิบาย, ระยะ (`active` = ยิงแล้ว / `pending` = รอโมดูล — สมัครรอได้), JSON schema ของ `data.object` และตัวอย่าง (ข้อมูลสมมติ) — schema เดียวกับ `components.schemas.WebhookEvent_*` ใน openapi.json',
  })
  eventTypes(): WebhookEventTypeListDto {
    return {
      data: EVENT_REGISTRY.map((d) => ({
        type: d.type,
        resource: d.resource,
        description: d.description,
        phase: d.phase,
        pendingTask: d.pendingTask,
        schema: publishedEventSchema(d.type),
        sample: sampleObject(d.type),
      })),
    };
  }

  @Post()
  @RequireScope('settings:write')
  @RequireStepUp() // D-67: ผลมี signing secret
  @ApiCreatedResponse({
    type: WebhookEndpointSecretDto,
    description:
      '`secret` แสดงครั้งเดียว · ส่ง `webhook.verification` (challenge) หลังบันทึก 1 ครั้ง — ผลไม่บล็อก · ไม่รับ Idempotency-Key · เกิน limit ของแพ็กเกจ → 409 `webhook_limit_reached`',
  })
  async create(
    @Body() body: CreateWebhookDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebhookEndpointSecretDto> {
    noIdempotencyKey(req);
    const e = await this.hooks.create(body);
    setEtag(res, e.version);
    res.setHeader('Cache-Control', 'no-store');
    return e;
  }

  @Get(':id')
  @TenantResource('webhookEndpoint')
  @RequireScope('settings:read')
  @ApiOkResponse({ type: WebhookEndpointDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebhookEndpointDto> {
    const e = await this.hooks.get(decodeIdOr404('webhookEndpoint', id));
    setEtag(res, e.version);
    return this.hooks.dto(e);
  }

  @Get(':id/history')
  @TenantResource('webhookEndpoint')
  @RequireScope('settings:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติจาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const e = await this.hooks.get(decodeIdOr404('webhookEndpoint', id));
    return entityHistory(this.db.tx, 'webhook_endpoint', e.id, q);
  }

  @Patch(':id')
  @TenantResource('webhookEndpoint')
  @RequireScope('settings:write')
  @StepUpWhen('เปลี่ยน `url` หรือ `extraHeaders` (D-67 review M1)')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({
    type: WebhookEndpointDto,
    description: 'แก้ URL / event / คำอธิบาย / header เพิ่มเติม',
  })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateWebhookDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebhookEndpointDto> {
    const e = await this.hooks.update(
      decodeIdOr404('webhookEndpoint', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, e.version);
    return this.hooks.dto(e);
  }

  @Post(':id/rotate-secret')
  @HttpCode(201)
  @TenantResource('webhookEndpoint')
  @RequireScope('settings:write')
  @RequireStepUp() // D-67
  @ApiHeader(IF_MATCH)
  @ApiCreatedResponse({
    type: WebhookEndpointSecretDto,
    description:
      'secret ใหม่ (แสดงครั้งเดียว) · 24 ชม. ส่ง `v1` ของ secret ใหม่และเดิมคู่กัน · ไม่รับ Idempotency-Key',
  })
  async rotate(
    @Param('id') id: string,
    @Body() body: WebhookActionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebhookEndpointSecretDto> {
    noIdempotencyKey(req);
    const e = await this.hooks.rotate(
      decodeIdOr404('webhookEndpoint', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, e.version);
    res.setHeader('Cache-Control', 'no-store');
    return e;
  }

  @Post(':id/disable')
  @HttpCode(200)
  @TenantResource('webhookEndpoint')
  @RequireScope('settings:write')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({
    type: WebhookEndpointDto,
    description: 'ปิดใช้งาน — event ใหม่ไม่เข้าคิว · ที่ค้างอยู่ถูกข้าม',
  })
  async disable(
    @Param('id') id: string,
    @Body() body: WebhookReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebhookEndpointDto> {
    const e = await this.hooks.disable(
      decodeIdOr404('webhookEndpoint', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, e.version);
    return this.hooks.dto(e);
  }

  @Post(':id/enable')
  @HttpCode(200)
  @TenantResource('webhookEndpoint')
  @RequireScope('settings:write')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({
    type: WebhookEndpointDto,
    description: 'เปิดใช้อีกครั้ง (รวมที่ระบบปิดอัตโนมัติ) — ตัวนับล้มเหลวเริ่มใหม่',
  })
  async enable(
    @Param('id') id: string,
    @Body() body: WebhookActionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebhookEndpointDto> {
    const e = await this.hooks.enable(
      decodeIdOr404('webhookEndpoint', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, e.version);
    return this.hooks.dto(e);
  }

  @Post(':id/test')
  @RateLimitClass('heavy')
  @HttpCode(200)
  @NoTransaction()
  @TenantResource('webhookEndpoint')
  @RequireScope('settings:write')
  @ApiOkResponse({
    type: WebhookTestResultDto,
    description:
      'ส่ง `webhook.test` ทันที (รอผลไม่เกิน 10 วิ) — ไม่นับอัตราสำเร็จ · endpoint ปิดอยู่ → 409',
  })
  test(@Param('id') id: string, @Body() body: WebhookTestDto): Promise<WebhookTestResultDto> {
    return this.hooks.test(decodeIdOr404('webhookEndpoint', id), body);
  }

  @Delete(':id')
  @HttpCode(204)
  @TenantResource('webhookEndpoint')
  @RequireScope('settings:write')
  @ApiHeader(IF_MATCH)
  @ApiNoContentResponse({
    description: 'ลบ (เหตุผล ≥ 10 ตัว · เก็บประวัติการส่งตาม retention) — หยุดส่งทันที',
  })
  async remove(
    @Param('id') id: string,
    @Body() body: WebhookReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.hooks.remove(decodeIdOr404('webhookEndpoint', id), body, expectedVersion(req));
  }
}
