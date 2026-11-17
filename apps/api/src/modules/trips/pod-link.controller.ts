import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { LinkAction } from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { OFFER_LINK_ENTITY, POD_LINK_ACTIONS, POD_LINK_PURPOSE } from './offer-links';
import {
  PodLinkEventDto,
  PodLinkEventResultDto,
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
    return this.pod.view(this.offerId(), q.doNo);
  }

  @Post(':token/stops/:stopId/events')
  @HttpCode(201)
  @LinkAction(POD_LINK_ACTIONS.event)
  @ApiOperation({
    summary: 'กดถึง/ออก (+ ปิดงานจุดรับ) ผ่านลิงก์ — event model เดียวกับเว็บ (source LINK)',
  })
  @ApiParam({ name: 'stopId', type: String, description: 'จุดในเที่ยวของลิงก์ (stp_…)' })
  @ApiProblems(T409('trip_not_in_progress', 'stop_event_duplicate'), T422)
  @ApiCreatedResponse({ type: PodLinkEventResultDto, description: 'สร้าง event ใหม่' })
  @ApiOkResponse({
    type: PodLinkEventResultDto,
    description: 'ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) → event เดิม ไม่สร้างใหม่',
  })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป (ต่อ IP)' })
  async record(
    @Param('stopId') stopId: string,
    @Body() body: PodLinkEventDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PodLinkEventResultDto> {
    const { result, replayed } = await this.pod.record(
      this.offerId(),
      decodeIdOr404('tripStop', stopId),
      body,
    );
    res.status(replayed ? 200 : 201);
    return result;
  }
}
