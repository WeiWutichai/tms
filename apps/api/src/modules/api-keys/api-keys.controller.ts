import {
  Body,
  Controller,
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
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuditPageDto } from '../../audit/audit.controller';
import {
  RequireFeature,
  RequireScope,
  RequireStepUp,
  TenantResource,
  SandboxAware,
} from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { VersionGate } from '../../http/api-version/api-version.decorators';
import { entityHistory, HistoryQuery } from '../master/history';
import {
  ApiKeyDto,
  ApiKeyListQuery,
  ApiKeyPageDto,
  ApiKeySecretDto,
  ApiKeySummaryDto,
  CreateApiKeyDto,
  RevokeApiKeyDto,
  RotateApiKeyDto,
  ScopeListDto,
  UpdateApiKeyDto,
} from './api-key.dto';
import { ApiKeysService } from './api-keys.service';

/**
 * ผลสร้าง/หมุนมี secret ที่แสดงครั้งเดียว — ห้ามเก็บลงตาราง idempotency (เก็บ response 24 ชม. เป็นข้อความธรรมดา)
 * จึงไม่รับ Idempotency-Key (ส่งซ้ำ = ชื่อ key ซ้ำ → 409 ไม่เกิด key ซ้ำ)
 */
function noIdempotencyKey(req: Request) {
  if (req.header('idempotency-key'))
    throw new ProblemException(
      'bad_request',
      'Idempotency-Key is not supported here — the response contains a one-time secret',
    );
}

/**
 * API keys ของ tenant (ST7-T01; docs/04 G2 #10 `api-keys`; spec/07 §6) — หน้า ตั้งค่า → นักพัฒนา / Open API
 * อ่าน `settings:read` · จัดการ `settings:write` (owner/admin ตาม A3) · ต้องมีฟีเจอร์ `api` ในแพ็กเกจ
 */
@ApiTags('api-keys')
@ApiBearerAuth()
@RequireFeature('api')
@SandboxAware()
@Controller('api-keys')
export class ApiKeysController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly db: DbService,
  ) {}

  @Get()
  @RequireScope('settings:read')
  @VersionGate('api_key.status_rotating')
  @ApiOkResponse({ type: ApiKeyPageDto })
  list(@Query() q: ApiKeyListQuery) {
    return this.keys.list(q);
  }

  @Get('summary')
  @RequireScope('settings:read')
  @VersionGate('api_key.status_rotating')
  @ApiOkResponse({ type: ApiKeySummaryDto, description: 'จำนวน key ต่อสถานะ (แท็บ)' })
  summary(): Promise<ApiKeySummaryDto> {
    return this.keys.summary();
  }

  @Get('scopes')
  @RequireScope('settings:read')
  @ApiOkResponse({
    type: ScopeListDto,
    description: 'scope ที่ให้ key ได้ (`resource:verb`) + ผู้เรียกให้ได้ไหม (INT-073)',
  })
  scopes(): ScopeListDto {
    return this.keys.scopeOptions();
  }

  @Post()
  @RequireScope('settings:write')
  @RequireStepUp() // D-67: สร้าง key = credential ถาวร — ต้องยืนยัน 2FA ซ้ำ (key จัดการ key ไม่ได้อยู่แล้ว)
  @VersionGate('api_key.status_rotating')
  @ApiCreatedResponse({
    type: ApiKeySecretDto,
    description: '`secret` แสดงครั้งเดียว — ไม่รับ Idempotency-Key',
  })
  async create(
    @Body() body: CreateApiKeyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiKeySecretDto> {
    noIdempotencyKey(req);
    const k = await this.keys.create(body);
    setEtag(res, k.version);
    res.setHeader('Cache-Control', 'no-store');
    return k;
  }

  @Get(':id')
  @TenantResource('apiKey')
  @RequireScope('settings:read')
  @VersionGate('api_key.status_rotating')
  @ApiOkResponse({ type: ApiKeyDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiKeyDto> {
    const k = await this.keys.get(decodeIdOr404('apiKey', id));
    setEtag(res, k.version);
    return this.keys.dto(k);
  }

  @Get(':id/history')
  @TenantResource('apiKey')
  @RequireScope('settings:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติจาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const k = await this.keys.get(decodeIdOr404('apiKey', id));
    return entityHistory(this.db.tx, 'api_key', k.id, q);
  }

  @Patch(':id')
  @TenantResource('apiKey')
  @RequireScope('settings:write')
  @VersionGate('api_key.status_rotating')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: ApiKeyDto, description: 'แก้ชื่อ / scope / IP allowlist — มีผลทันที' })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateApiKeyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiKeyDto> {
    const k = await this.keys.update(decodeIdOr404('apiKey', id), body, expectedVersion(req));
    setEtag(res, k.version);
    return this.keys.dto(k);
  }

  @Post(':id/rotate')
  @HttpCode(201)
  @TenantResource('apiKey')
  @RequireScope('settings:write')
  @RequireStepUp() // D-67
  @VersionGate('api_key.status_rotating')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiCreatedResponse({
    type: ApiKeySecretDto,
    description:
      'key ใหม่ (scope/IP เดิม) + secret แสดงครั้งเดียว · key เดิมใช้ได้ถึง `revokeAt` (graceHours ≤ 168) · ไม่รับ Idempotency-Key',
  })
  async rotate(
    @Param('id') id: string,
    @Body() body: RotateApiKeyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiKeySecretDto> {
    noIdempotencyKey(req);
    const k = await this.keys.rotate(decodeIdOr404('apiKey', id), body, expectedVersion(req));
    setEtag(res, k.version);
    res.setHeader('Cache-Control', 'no-store');
    return k;
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @TenantResource('apiKey')
  @RequireScope('settings:write')
  @VersionGate('api_key.status_rotating')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({
    type: ApiKeyDto,
    description: 'เพิกถอนทันที (เหตุผล ≥ 10 ตัว) — ย้อนกลับไม่ได้',
  })
  async revoke(
    @Param('id') id: string,
    @Body() body: RevokeApiKeyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiKeyDto> {
    const k = await this.keys.revoke(decodeIdOr404('apiKey', id), body, expectedVersion(req));
    setEtag(res, k.version);
    return this.keys.dto(k);
  }
}
