import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { LinkAction, RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import { requestContext } from '../../common/request-context';
import { MasterReasonDto } from '../master/master-kit';
import {
  CarrierDocSubmissionDto,
  CarrierDocSubmissionListDto,
  CarrierDocsLinkViewDto,
  CreateSubmissionDto,
  CreateUploadLinkDto,
  IssuedUploadLinkDto,
  LinkFileDto,
  LinkFileReserveDto,
  LinkSubmissionResultDto,
  SubmissionListQuery,
  UploadLinkDto,
  UploadLinkListDto,
} from './carrier-docs.dto';
import {
  CarrierDocsService,
  LINK_ACTIONS,
  LINK_PURPOSE,
  type LinkRef,
} from './carrier-docs.service';
import { ProblemException } from '../../common/problem';

/**
 * รถร่วมอัปโหลดเอกสารผ่านลิงก์ — ฝั่ง admin (ST2-T21)
 * สิทธิ์: ออก/เพิกถอนลิงก์ + อนุมัติ/ไม่อนุมัติ `master:write` · ดูรายการ `master:read` (เหมือนเอกสารรถ ST2-T17)
 * ไฟล์ที่ส่งมาเปิดดูผ่าน GET /v1/documents/{id} (`documents:read`) ตามเดิม
 */
@ApiTags('carrier-docs')
@ApiBearerAuth()
@Controller()
export class CarrierDocsController {
  constructor(private readonly svc: CarrierDocsService) {}

  @Post('carriers/:id/upload-links')
  @TenantResource('carrier')
  @RequireScope('master:write')
  @ApiCreatedResponse({
    type: IssuedUploadLinkDto,
    description:
      'ออกลิงก์อัปโหลดเอกสารให้ผู้รับเหมา — ส่งทาง LINE/SMS ด้วย POST /v1/messages/send-link (ST3-T21) หรือคัดลอก url ไปส่งเอง',
  })
  issue(@Param('id') id: string, @Body() body: CreateUploadLinkDto): Promise<IssuedUploadLinkDto> {
    return this.svc.issueLink(decodeIdOr404('carrier', id), body.ttlDays);
  }

  @Get('carriers/:id/upload-links')
  @TenantResource('carrier')
  @RequireScope('master:read')
  @ApiOkResponse({
    type: UploadLinkListDto,
    description: 'ลิงก์ที่เคยออก (ไม่มี token) ใหม่สุดก่อน',
  })
  async links(@Param('id') id: string): Promise<UploadLinkListDto> {
    return { data: await this.svc.listLinks(decodeIdOr404('carrier', id)) };
  }

  @Post('carrier-upload-links/:id/revoke')
  @HttpCode(200)
  @TenantResource('magicLink')
  @RequireScope('master:write')
  @ApiOkResponse({ type: UploadLinkDto, description: 'เพิกถอน (เหตุผล ≥ 10 + audit) — คืนไม่ได้' })
  revoke(@Param('id') id: string, @Body() body: MasterReasonDto): Promise<UploadLinkDto> {
    return this.svc.revokeLink(decodeIdOr404('magicLink', id), body.reason);
  }

  @Get('carrier-doc-submissions')
  @RequireScope('master:read')
  @ApiOkResponse({
    type: CarrierDocSubmissionListDto,
    description: 'เอกสารที่รถร่วมส่งผ่านลิงก์ — รอตรวจขึ้นก่อน แล้วใหม่สุดก่อน',
  })
  async list(@Query() q: SubmissionListQuery): Promise<CarrierDocSubmissionListDto> {
    return { data: await this.svc.list(q) };
  }

  @Post('carrier-doc-submissions/:id/approve')
  @HttpCode(200)
  @TenantResource('carrierDocSubmission')
  @RequireScope('master:write')
  @ApiOkResponse({
    type: CarrierDocSubmissionDto,
    description:
      'อนุมัติ (เหตุผล ≥ 10 + audit) → เอกสารรถฉบับใหม่/ต่ออายุ หรืออัปเดตใบขับขี่ · ตรวจแล้ว → 409 · รถ/คนขับไม่อยู่กับผู้รับเหมาแล้ว → 409 `target_changed`',
  })
  async approve(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
  ): Promise<CarrierDocSubmissionDto> {
    const s = await this.svc.approve(decodeIdOr404('carrierDocSubmission', id), body.reason);
    return (await this.svc.toDtos([s]))[0]!;
  }

  @Post('carrier-doc-submissions/:id/reject')
  @HttpCode(200)
  @TenantResource('carrierDocSubmission')
  @RequireScope('master:write')
  @ApiOkResponse({
    type: CarrierDocSubmissionDto,
    description: 'ไม่อนุมัติ (เหตุผล ≥ 10 บังคับ + audit)',
  })
  async reject(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
  ): Promise<CarrierDocSubmissionDto> {
    const s = await this.svc.reject(decodeIdOr404('carrierDocSubmission', id), body.reason);
    return (await this.svc.toDtos([s]))[0]!;
  }
}

/**
 * หน้าลิงก์ของรถร่วม (ไม่ login — magic link ST1-T06): `/v1/public/*` มี rate limit ต่อ IP + no-store
 * ลิงก์หมดอายุ/เพิกถอน/ผิด → 404 (ตามกรอบ ST1-T06 ไม่บอกใบ้) · เห็นเฉพาะรถ/คนขับของผู้รับเหมาที่ลิงก์ชี้ ไม่มีราคา
 */
@ApiTags('public')
@ApiParam({ name: 'token', type: String, description: 'token ของลิงก์ (ml1.…)' })
@Controller('public/carrier-docs')
export class CarrierDocsPublicController {
  constructor(private readonly svc: CarrierDocsService) {}

  /** ลิงก์ที่ AuthGuard ยืนยันแล้ว (@LinkAction) */
  private link(): LinkRef {
    const ctx = requestContext.require();
    const l = ctx.link;
    // action เฉพาะของลิงก์นี้อยู่แล้ว — กันอีกชั้นว่าเป็นลิงก์ของผู้รับเหมา (review ST2-T21)
    if (!l || l.purpose !== LINK_PURPOSE || l.entityType !== 'carrier')
      throw new ProblemException('not_found');
    return { id: l.id, tenantId: ctx.tenantId!, entityId: l.entityId };
  }

  @Get(':token')
  @LinkAction(LINK_ACTIONS.view)
  @ApiOkResponse({ type: CarrierDocsLinkViewDto })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป (ต่อ IP)' })
  view(): Promise<CarrierDocsLinkViewDto> {
    return this.svc.view(this.link());
  }

  @Post(':token/files')
  @LinkAction(LINK_ACTIONS.upload)
  @ApiCreatedResponse({
    type: LinkFileDto,
    description: `จองไฟล์ (PDF/รูป ≤ 10 MB) → PUT เนื้อไฟล์ที่ uploadUrl · เกินเพดานต่อลิงก์ → 429`,
  })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป' })
  files(@Body() body: LinkFileReserveDto, @Req() req: Request): Promise<LinkFileDto> {
    // ฐาน URL จากค่าตั้ง (ไม่เชื่อ Host / X-Forwarded-*) — dev ใช้ค่าจาก request (เหมือน POST /v1/documents)
    const origin = process.env.PUBLIC_API_BASE_URL ?? `${req.protocol}://${req.get('host')}`;
    return this.svc.reserveFile(this.link(), body, origin);
  }

  @Post(':token/submissions')
  @LinkAction(LINK_ACTIONS.upload)
  @ApiCreatedResponse({
    type: LinkSubmissionResultDto,
    description:
      'ส่งเอกสาร → รอ admin ตรวจ (pending_review) · รถ/คนขับไม่ใช่ของผู้รับเหมานี้ → 404 · รอตรวจอยู่แล้ว → 409 `pending_exists`',
  })
  submit(@Body() body: CreateSubmissionDto): Promise<LinkSubmissionResultDto> {
    return this.svc.submit(this.link(), body);
  }
}
