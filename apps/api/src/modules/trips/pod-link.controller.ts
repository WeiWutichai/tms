import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { apiOrigin } from '../documents/documents.controller';
import { LinkAction, AllowReadOnlyTenant } from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { OFFER_LINK_ENTITY, POD_LINK_ACTIONS, POD_LINK_PURPOSE } from './offer-links';
import {
  POD_LINK_FILE_MAX_BYTES,
  POD_LINK_PHOTOS_MAX,
  PodLinkCaptureDto,
  PodLinkCaptureResultDto,
  PodLinkEventDto,
  PodLinkEventResultDto,
  PodLinkFileDto,
  PodLinkFileReserveDto,
  PodLinkQueryDto,
  PodLinkViewDto,
} from './pod-link.dto';
import { PodLinkService } from './pod-link.service';
import { T409, T422 } from './trip-problems';

/**
 * หน้าลิงก์งานของรถร่วม — ส่วนสถานะ (ST4-T08; ไม่ login — magic link `pod`, docs/01 §5.5 `/public/pod/{token}`)
 * `/v1/public/*` rate limit ต่อ IP + `Cache-Control: no-store` · ลิงก์ผิด/หมดอายุ/เพิกถอน/จุดนอกเที่ยว → 404 (ไม่บอกใบ้)
 * ไม่มีราคาขาย/ที่อยู่ลูกค้า (EXE-080) · เห็นเฉพาะเที่ยวของการจ้างที่ลิงก์ชี้
 */
@ApiTags('public')
@ApiParam({ name: 'token', type: String, description: 'token ของลิงก์งาน (ml1.…)' })
@Controller('public/pod')
export class PodLinkPublicController {
  constructor(private readonly pod: PodLinkService) {}

  /** การจ้างที่ลิงก์ (ยืนยันแล้วโดย AuthGuard) ชี้ */
  private offerId(): string {
    const l = requestContext.require().link;
    if (!l || l.purpose !== POD_LINK_PURPOSE || l.entityType !== OFFER_LINK_ENTITY)
      throw new ProblemException('not_found');
    return l.entityId;
  }

  @Get(':token')
  @LinkAction(POD_LINK_ACTIONS.view)
  @ApiOperation({ summary: 'ข้อมูลงาน + ค้นเลข DO (เฉพาะในเที่ยวนี้) พร้อมสถานะจุดรับ/ส่ง' })
  @ApiOkResponse({ type: PodLinkViewDto })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป (ต่อ IP)' })
  view(@Query() q: PodLinkQueryDto): Promise<PodLinkViewDto> {
    return this.pod.view(this.offerId(), requestContext.require().link!.id, q.doNo);
  }

  @AllowReadOnlyTenant() // P1-ST1-T03 ตาราง 1.6
  @Post(':token/stops/:stopId/events')
  @HttpCode(201)
  @LinkAction(POD_LINK_ACTIONS.event)
  @ApiOperation({
    summary:
      'กดถึง/ออก/ปิดงานผ่านลิงก์ — event model เดียวกับเว็บ (source LINK) · ปิดงานจุดส่ง = COMPLETE + `pod` (ST4-T09)',
  })
  @ApiParam({ name: 'stopId', type: String, description: 'จุดในเที่ยวของลิงก์ (stp_…)' })
  @ApiProblems(
    T409(
      'trip_not_in_progress',
      'stop_event_duplicate',
      'stop_not_arrived',
      'stop_not_ready',
      'stop_already_closed',
      'pod_exists',
    ),
    T422,
  )
  @ApiTooManyRequestsResponse({
    description: 'เรียกถี่เกินไป — ต่อ IP (`/v1/public/*`) และ 30 คำขอ/นาที ต่อลิงก์ (NFR-1106)',
  })
  @ApiCreatedResponse({ type: PodLinkEventResultDto, description: 'สร้าง event ใหม่' })
  @ApiOkResponse({
    type: PodLinkEventResultDto,
    description: 'ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) → event เดิม ไม่สร้างใหม่',
  })
  async record(
    @Param('stopId') stopId: string,
    @Body() body: PodLinkEventDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PodLinkEventResultDto> {
    const { result, replayed } = await this.pod.record(
      this.offerId(),
      requestContext.require().link!.id,
      decodeIdOr404('tripStop', stopId),
      body,
    );
    res.status(replayed ? 200 : 201);
    return result;
  }

  @AllowReadOnlyTenant() // P1-ST1-T03 ตาราง 1.6
  @Post(':token/files')
  @LinkAction(POD_LINK_ACTIONS.capture)
  @ApiOperation({
    summary: `จองไฟล์ POD (รูป/ลายเซ็น/ไฟล์ ≤ ${POD_LINK_FILE_MAX_BYTES / 1024 / 1024} MB) ของ DO ในเที่ยว → PUT เนื้อไฟล์ที่ uploadUrl`,
    description:
      'ไฟล์ผูกกับ DO + ลิงก์นี้ตั้งแต่จอง ใช้ได้เฉพาะ POD ของ DO นี้ผ่านลิงก์นี้ · DO มี POD แล้ว → 409 `pod_exists` · เกินเพดานต่อ DO/ชั่วโมง/นาที → 429',
  })
  @ApiCreatedResponse({ type: PodLinkFileDto })
  @ApiProblems(T409('pod_exists'), T422)
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป หรือเกินเพดานไฟล์ต่อ DO/ลิงก์' })
  files(@Body() body: PodLinkFileReserveDto, @Req() req: Request): Promise<PodLinkFileDto> {
    return this.pod.reserveFile(
      this.offerId(),
      requestContext.require().link!.id,
      body,
      apiOrigin(req),
    );
  }

  @AllowReadOnlyTenant() // P1-ST1-T03 ตาราง 1.6
  @Post(':token/pod')
  @HttpCode(201)
  @LinkAction(POD_LINK_ACTIONS.capture)
  @ApiOperation({
    summary: 'ส่ง POD ของ DO ที่จุดส่งปิดแล้ว (ไม่ปิดงาน) — PodService เดียวกับเว็บ (source LINK)',
    description: `รูป ≤ ${POD_LINK_PHOTOS_MAX} · ไฟล์ต้องจองผ่านลิงก์นี้สำหรับ DO นี้ · ต้องครบ checklist (422 \`pod_incomplete\`) · ส่งได้ครั้งเดียวต่อ DO (มีแล้ว → 409 \`pod_exists\`) · จุดส่งยังไม่ปิด → 409 \`pod_not_allowed\` (ใช้ COMPLETE + pod ที่ events)`,
  })
  @ApiProblems(T409('pod_exists', 'pod_not_allowed'), T422)
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป — ต่อ IP และ 30 คำขอ/นาที ต่อลิงก์' })
  @ApiCreatedResponse({ type: PodLinkCaptureResultDto, description: 'บันทึกแล้ว' })
  @ApiOkResponse({
    type: PodLinkCaptureResultDto,
    description: 'ส่งซ้ำ (ชุดไฟล์เดิมจากลิงก์เดิม) → ผลเดิม ไม่สร้างฉบับใหม่',
  })
  async capture(
    @Body() body: PodLinkCaptureDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PodLinkCaptureResultDto> {
    const { result, replayed } = await this.pod.capture(
      this.offerId(),
      requestContext.require().link!.id,
      body,
    );
    res.status(replayed ? 200 : 201);
    return result;
  }
}
