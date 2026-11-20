import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { LinkAction } from '../../common/decorators';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { apiOrigin } from '../documents/documents.controller';
import { T409, T422 } from '../trips/trip-problems';
import {
  REVIEW_FILE_MAX_BYTES,
  REVIEW_PHOTOS_MAX,
  ReviewLinkFileDto,
  ReviewLinkFileReserveDto,
  ReviewLinkRespondDto,
  ReviewLinkRespondResultDto,
  ReviewLinkViewDto,
} from './settlement-review.dto';
import {
  REVIEW_LINK_ACTIONS,
  REVIEW_LINK_ENTITY,
  REVIEW_LINK_PURPOSE,
  SettlementReviewService,
} from './settlement-review.service';

const TOO_MANY = 'เรียกถี่เกินไป — ต่อ IP (`/v1/public/*`) และ 30 คำขอ/นาที ต่อลิงก์';

/**
 * หน้ารถร่วมตรวจใบสำคัญจ่าย (ST6-T05; ไม่ login — magic link `settlement_review`, docs/04 F6 "รถร่วมตรวจผ่านลิงก์", spec/05 §11.3)
 * `/v1/public/*` rate limit ต่อ IP + `Cache-Control: no-store` · ลิงก์ผิด/หมดอายุ/เพิกถอน/ใบถูกเรียกกลับ → 404 (ไม่บอกใบ้)
 * เห็นเฉพาะบรรทัดของใบที่ลิงก์ชี้ (เที่ยว + ราคาซื้อของรถร่วมรายนี้เท่านั้น — ไม่มีราคาขาย/ข้อมูลลูกค้า)
 */
@ApiTags('public')
@ApiParam({ name: 'token', type: String, description: 'token ของลิงก์ตรวจ (ml1.…)' })
@Controller('public/settlements')
export class SettlementReviewPublicController {
  constructor(private readonly svc: SettlementReviewService) {}

  /** ใบที่ลิงก์ (ยืนยันแล้วโดย AuthGuard) ชี้ */
  private settlementId(): string {
    const l = requestContext.require().link;
    if (!l || l.purpose !== REVIEW_LINK_PURPOSE || l.entityType !== REVIEW_LINK_ENTITY)
      throw new ProblemException('not_found');
    return l.entityId;
  }

  @Get(':token')
  @LinkAction(REVIEW_LINK_ACTIONS.view)
  @ApiOperation({
    summary: 'ใบสำคัญจ่ายที่ส่งให้รถร่วมตรวจ — รายการเที่ยว/ยอด/หัก + คำตอบล่าสุดต่อบรรทัด',
  })
  @ApiOkResponse({ type: ReviewLinkViewDto })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป (ต่อ IP)' })
  view(): Promise<ReviewLinkViewDto> {
    return this.svc.view(this.settlementId(), requestContext.require().link!.id);
  }

  @Post(':token/files')
  @LinkAction(REVIEW_LINK_ACTIONS.respond)
  @ApiOperation({
    summary: `จองรูปประกอบการโต้แย้ง (JPEG/PNG/WebP ≤ ${REVIEW_FILE_MAX_BYTES / 1024 / 1024} MB) ของบรรทัด → PUT เนื้อไฟล์ที่ uploadUrl`,
    description:
      'รูปผูกกับบรรทัด + ลิงก์นี้ตั้งแต่จอง · ใบไม่อยู่ในสถานะรอตรวจ → 409 `invalid_state_transition` · เกินเพดานต่อบรรทัด/ชั่วโมง → 429',
  })
  @ApiCreatedResponse({ type: ReviewLinkFileDto })
  @ApiProblems(T409(), T422)
  @ApiTooManyRequestsResponse({ description: TOO_MANY })
  files(@Body() body: ReviewLinkFileReserveDto, @Req() req: Request): Promise<ReviewLinkFileDto> {
    return this.svc.reserveFile(
      this.settlementId(),
      requestContext.require().link!.id,
      body,
      apiOrigin(req),
    );
  }

  @Post(':token/lines/:lineId/review')
  @HttpCode(201)
  @LinkAction(REVIEW_LINK_ACTIONS.respond)
  @ApiOperation({
    summary: 'ยอมรับ / โต้แย้ง บรรทัด (เหตุผล/รูป) — โต้แย้ง = ติดธง อนุมัติใบไม่ได้',
    description: `ตอบใหม่ได้จนกว่าใบจะถูกอนุมัติ/เรียกกลับ (คำตอบล่าสุดใช้ · ทุกคำตอบเก็บเป็นประวัติ) · โต้แย้งต้องมีเหตุผลหรือรูป (422) · รูป ≤ ${REVIEW_PHOTOS_MAX} ต้องจองผ่านลิงก์นี้สำหรับบรรทัดนี้และอัปโหลดแล้ว · ใบไม่อยู่ในสถานะรอตรวจ → 409`,
  })
  @ApiParam({ name: 'lineId', type: String, description: 'บรรทัดของใบ (stln_…)' })
  @ApiCreatedResponse({ type: ReviewLinkRespondResultDto })
  @ApiProblems(T409(), T422)
  @ApiTooManyRequestsResponse({ description: TOO_MANY })
  respond(
    @Param('lineId') lineId: string,
    @Body() body: ReviewLinkRespondDto,
  ): Promise<ReviewLinkRespondResultDto> {
    return this.svc.respond(this.settlementId(), requestContext.require().link!.id, lineId, body);
  }
}
