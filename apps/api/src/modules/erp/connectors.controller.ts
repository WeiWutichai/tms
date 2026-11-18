import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuditPageDto } from '../../audit/audit.controller';
import {
  NoTransaction,
  RequireFeature,
  RequireScope,
  TenantResource,
  LiveOnly,
} from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { entityHistory, HistoryQuery } from '../master/history';
import {
  ConnectorActionDto,
  ConnectorCredentialsDto,
  ConnectorDto,
  ConnectorHealthDto,
  ConnectorListDto,
  ConnectorListQuery,
  ConnectorReasonDto,
  CreateConnectorDto,
  EffectiveConnectorDto,
  EffectiveConnectorQuery,
  ErpAdapterListDto,
  InboundTokenDto,
  UpdateConnectorDto,
} from './connector.dto';
import { apiOrigin } from '../documents/documents.controller';
import { ConnectorsService } from './connectors.service';

/**
 * ผลออก/หมุน token มีค่าที่แสดงครั้งเดียว — ห้ามเก็บลงตาราง idempotency (เก็บ response 24 ชม. เป็นข้อความธรรมดา)
 * (แบบเดียวกับ api-keys.controller / webhooks.controller)
 */
function noIdempotencyKey(req: Request) {
  if (req.header('idempotency-key'))
    throw new ProblemException(
      'bad_request',
      'Idempotency-Key is not supported here — the response contains a one-time token',
    );
}

const IF_MATCH = { name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' };

/**
 * Connector บัญชี/ERP ของ tenant (ST7-T13; docs/01 §3.7, §5.2 #14, §6.1; docs/04 G3; spec/07 §1)
 * ไม่มี connector = Standalone (ทุก flow ทำใน TMS) · หน้าจอจัดการ = ST7-T20 · admin portal = ST7-T20
 * อ่าน `settings:read` · จัดการ `settings:write` (owner/admin) · ฟีเจอร์ `conn` ของแพ็กเกจ (จำนวนตาม limit)
 * credential ไม่ส่งกลับทุก endpoint (มีแค่ `credentialKeys`)
 */
@ApiTags('connectors')
@ApiBearerAuth()
@RequireFeature('conn')
@LiveOnly()
@Controller('connectors')
export class ConnectorsController {
  constructor(
    private readonly connectors: ConnectorsService,
    private readonly db: DbService,
  ) {}

  @Get()
  @RequireScope('settings:read')
  @ApiOkResponse({ type: ConnectorListDto })
  async list(@Query() q: ConnectorListQuery): Promise<ConnectorListDto> {
    return { data: await this.connectors.list(q) };
  }

  @Get('adapters')
  @RequireScope('settings:read')
  @ApiOkResponse({
    type: ErpAdapterListDto,
    description:
      'adapter ที่เปิดเป็น connector ได้ + capabilities + ช่องตั้งค่า (เรียงตามรหัส ไม่มีตัวใดเป็นค่าเริ่มต้น)',
  })
  adapters(): ErpAdapterListDto {
    return { data: this.connectors.adapterCatalog() };
  }

  @Post()
  @RequireScope('settings:write')
  @ApiCreatedResponse({
    type: ConnectorDto,
    description:
      'สร้างเป็น PAUSED (ยังไม่ส่ง) — เปิดด้วย /resume หลังทดสอบผ่าน · นิติบุคคลเดียวกันมีได้ 1 ตัว → 409 `connector_scope_taken` · เกิน limit → 409 `connector_limit_reached`',
  })
  async create(
    @Body() body: CreateConnectorDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConnectorDto> {
    const c = await this.connectors.create(body);
    setEtag(res, c.version);
    return this.connectors.toDto(c);
  }

  @Get(':id')
  @TenantResource('connector')
  @RequireScope('settings:read')
  @ApiOkResponse({ type: ConnectorDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConnectorDto> {
    const c = await this.connectors.get(decodeIdOr404('connector', id));
    setEtag(res, c.version);
    return this.connectors.toDto(c);
  }

  @Get(':id/history')
  @TenantResource('connector')
  @RequireScope('settings:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติจาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const c = await this.connectors.get(decodeIdOr404('connector', id));
    return entityHistory(this.db.tx, 'connector', c.id, q);
  }

  @Patch(':id')
  @NoTransaction()
  @TenantResource('connector')
  @RequireScope('settings:write')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({
    type: ConnectorDto,
    description:
      'แก้ capability ที่เปิด / syncFromDate / รหัสบริษัท ERP / branchMap / ค่าตั้งที่ไม่ลับ',
  })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateConnectorDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConnectorDto> {
    const c = await this.connectors.update(
      decodeIdOr404('connector', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, c.version);
    return this.connectors.toDto(c);
  }

  @Put(':id/credentials')
  @TenantResource('connector')
  @RequireScope('settings:write')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({
    type: ConnectorDto,
    description:
      'แทน credential ทั้งชุด (หมุน key) — เก็บเข้ารหัส ไม่ส่งกลับ · audit บันทึกเฉพาะชื่อช่อง',
  })
  async credentials(
    @Param('id') id: string,
    @Body() body: ConnectorCredentialsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConnectorDto> {
    const c = await this.connectors.setCredentials(
      decodeIdOr404('connector', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, c.version);
    res.setHeader('Cache-Control', 'no-store');
    return this.connectors.toDto(c);
  }

  @Post(':id/health')
  @HttpCode(200)
  @NoTransaction()
  @TenantResource('connector')
  @RequireScope('settings:write')
  @ApiOkResponse({
    type: ConnectorHealthDto,
    description:
      'ทดสอบการเชื่อมต่อ (healthCheck ≤ 15 วิ) — ACTIVE + AUTH ล้ม → ERROR · ERROR + ผ่าน → ACTIVE',
  })
  health(@Param('id') id: string): Promise<ConnectorHealthDto> {
    return this.connectors.health(decodeIdOr404('connector', id));
  }

  @Post(':id/resume')
  @HttpCode(200)
  @NoTransaction()
  @TenantResource('connector')
  @RequireScope('settings:write')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({
    type: ConnectorDto,
    description:
      'เปิดใช้ (PAUSED/ERROR → ACTIVE) หลัง healthCheck ผ่าน · ไม่ผ่าน → 409 `connector_health_failed`',
  })
  async resume(
    @Param('id') id: string,
    @Body() body: ConnectorActionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConnectorDto> {
    const c = await this.connectors.resume(
      decodeIdOr404('connector', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, c.version);
    return this.connectors.toDto(c);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @TenantResource('connector')
  @RequireScope('settings:write')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({
    type: ConnectorDto,
    description: 'หยุดชั่วคราว — เอกสารใหม่เข้าคิวรอ (ไม่ส่ง) จนกว่าจะเปิดใหม่',
  })
  async pause(
    @Param('id') id: string,
    @Body() body: ConnectorActionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConnectorDto> {
    const c = await this.connectors.pause(
      decodeIdOr404('connector', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, c.version);
    return this.connectors.toDto(c);
  }

  @Post(':id/inbound-token/rotate')
  @HttpCode(200)
  @TenantResource('connector')
  @RequireScope('settings:write')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({
    type: InboundTokenDto,
    description:
      'ST7-T22 ออก/หมุน token ของ URL รับ webhook ขาเข้า (เหตุผล ≥ 10 ตัว) — token/URL แสดงครั้งเดียว · token เดิมใช้ไม่ได้ทันที (401) · ' +
      'ไม่รับ Idempotency-Key (400 — คำตอบมี token) · ' +
      'adapter ไม่รองรับ → 409 `inbound_not_supported` · audit บันทึกเฉพาะ prefix',
  })
  async rotateInboundToken(
    @Param('id') id: string,
    @Body() body: ConnectorReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InboundTokenDto> {
    noIdempotencyKey(req);
    const { connector, token } = await this.connectors.rotateInboundToken(
      decodeIdOr404('connector', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, connector.version);
    res.setHeader('Cache-Control', 'no-store');
    return {
      token,
      url: `${apiOrigin(req)}/v1/inbound/${connector.adapterKey}/${token}`,
      tokenPrefix: connector.inboundTokenPrefix!,
      tokenRotatedAt: connector.inboundTokenRotatedAt!.toISOString(),
      connector: this.connectors.toDto(connector),
    };
  }

  @Post(':id/inbound-token/revoke')
  @HttpCode(200)
  @TenantResource('connector')
  @RequireScope('settings:write')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({
    type: ConnectorDto,
    description: 'ST7-T22 เลิกรับ webhook ขาเข้า (เหตุผล ≥ 10 ตัว) — URL เดิมตอบ 401',
  })
  async revokeInboundToken(
    @Param('id') id: string,
    @Body() body: ConnectorReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConnectorDto> {
    const c = await this.connectors.revokeInboundToken(
      decodeIdOr404('connector', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, c.version);
    return this.connectors.toDto(c);
  }

  @Post(':id/disconnect')
  @HttpCode(200)
  @TenantResource('connector')
  @RequireScope('settings:write')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({
    type: ConnectorDto,
    description:
      'ยกเลิกการเชื่อม (เหตุผล ≥ 10 ตัว) — หยุดส่ง/ดึงทันที กลับเป็น Standalone · เก็บ mapping/log ไว้ (INT-016)',
  })
  async disconnect(
    @Param('id') id: string,
    @Body() body: ConnectorReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConnectorDto> {
    const c = await this.connectors.disconnect(
      decodeIdOr404('connector', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, c.version);
    return this.connectors.toDto(c);
  }
}

/**
 * connector ที่เอกสารใช้ (ST7-T13) — แยก controller เพราะต้องตอบได้ทุกแพ็กเกจ (ไม่มีฟีเจอร์ `conn` = Standalone ไม่ใช่ 403)
 * ลงทะเบียนก่อน ConnectorsController ใน app.module (ไม่ให้ `GET /connectors/:id` จับ path `effective`)
 */
@ApiTags('connectors')
@ApiBearerAuth()
@LiveOnly()
@Controller('connectors')
export class ConnectorsEffectiveController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get('effective')
  @RequireScope('settings:read')
  @ApiOkResponse({
    type: EffectiveConnectorDto,
    description:
      'connector ที่เอกสารของนิติบุคคล/สาขานี้ใช้ (routing: นิติบุคคล → ทุกนิติบุคคล → Standalone) + capability ที่ใช้ได้',
  })
  effective(@Query() q: EffectiveConnectorQuery): Promise<EffectiveConnectorDto> {
    return this.connectors.effective(q);
  }
}
