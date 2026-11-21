import { Controller, Get, HttpCode, Param, Post, Res, StreamableFile } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { LinkAction, NoTransaction, RequireScope, TenantResource } from '../../common/decorators';
import { refToId } from '../../common/external-id';
import { tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { linkPdfBucket } from '../../http/link-rate-limit';
import { RateLimitService } from '../../http/rate-limit/rate-limit.service';
import { T403, T404 } from '../trips/trip-problems';
import { CarrierPayLinkDto, CarrierPayLinkViewDto } from './carrier-pay-link.dto';
import {
  CarrierPayLinkService,
  PAY_LINK_ACTIONS,
  PAY_LINK_ENTITY,
  PAY_LINK_PURPOSE,
} from './carrier-pay-link.service';
import { SettlementPdfService } from './settlement-pdf.service';

/**
 * ออกลิงก์ "ค่าเที่ยวของฉัน" ให้รถร่วม (ST6-T11; docs/04 F7) — staff · สิทธิ์เดียวกับออกลิงก์ใบสำคัญจ่าย (`settlements:create`)
 */
@ApiTags('settlements')
@ApiBearerAuth()
@Controller('carriers')
export class CarrierPayLinkController {
  constructor(
    private readonly svc: CarrierPayLinkService,
    private readonly db: DbService,
  ) {}

  @Post(':id/pay-link')
  @HttpCode(201)
  @TenantResource('carrier')
  @RequireScope('settlements:create')
  @ApiOperation({
    summary: 'ออกลิงก์ "ค่าเที่ยวของฉัน" ให้รถร่วม (ดูอย่างเดียว — เที่ยวที่จบ / ยอด / สถานะจ่าย)',
    description:
      'ลิงก์ดูอย่างเดียว อายุ 30 วัน (ไม่ต้อง login) — รถร่วมเห็นเฉพาะงวด/เที่ยว/ราคาซื้อของตัวเอง (ไม่มีราคาขาย/ลูกค้า) · ' +
      'ออกใหม่ = เพิกถอนลิงก์เดิมที่ยังใช้ได้ของรถร่วมรายนี้ · ส่งทาง LINE/SMS ด้วย POST /v1/messages/send-link หรือคัดลอกไปส่งเอง · ' +
      'ไม่มีหนังสือ 50 ทวิ (D-54/D-58 — ออกที่ระบบบัญชี) · audit `carrier.pay_link_issued`',
  })
  @ApiProblems(T403('settlements:create'), {
    ...T404,
    description: 'ไม่พบผู้รับเหมา (รวมของบริษัทอื่น)',
  })
  @ApiCreatedResponse({ type: CarrierPayLinkDto })
  async issue(@Param('id') id: string): Promise<CarrierPayLinkDto> {
    return this.svc.issue(await refToId('carrier', id, this.db.tx.carrier));
  }
}

/**
 * หน้า "ค่าเที่ยวของฉัน" ของรถร่วม (ST6-T11 — ไม่ login, magic link `carrier_pay`; ต้นแบบ TMS Subcon แท็บ "การเงิน")
 * `/v1/public/*` rate limit ต่อ IP + no-store · ลิงก์ผิด/หมดอายุ/เพิกถอน/รถร่วมถูกลบ → 404 (ไม่บอกใบ้)
 */
@ApiTags('public')
@ApiParam({ name: 'token', type: String, description: 'token ของลิงก์ค่าเที่ยว (ml1.…)' })
@Controller('public/carrier-pay')
export class CarrierPayLinkPublicController {
  constructor(
    private readonly svc: CarrierPayLinkService,
    private readonly pdf: SettlementPdfService,
    private readonly limiter: RateLimitService,
  ) {}

  /** ผู้รับเหมาที่ลิงก์ (ยืนยันแล้วโดย AuthGuard) ชี้ */
  private carrierId(): string {
    const l = requestContext.require().link;
    if (!l || l.purpose !== PAY_LINK_PURPOSE || l.entityType !== PAY_LINK_ENTITY)
      throw new ProblemException('not_found');
    return l.entityId;
  }

  @Get(':token')
  @LinkAction(PAY_LINK_ACTIONS.view)
  @ApiOperation({
    summary: 'ค่าเที่ยวของฉัน — รอรับเงิน + งวด (สถานะจ่าย) + เที่ยวที่จบแต่ยังไม่เข้างวด',
  })
  @ApiOkResponse({ type: CarrierPayLinkViewDto })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป (ต่อ IP)' })
  view(): Promise<CarrierPayLinkViewDto> {
    return this.svc.view(this.carrierId(), requestContext.require().link!.id);
  }

  @Get(':token/settlements/:settlementId/pdf')
  @NoTransaction()
  @LinkAction(PAY_LINK_ACTIONS.view)
  @ApiOperation({
    summary: 'ใบจ่ายเงิน (PDF ใบสำคัญจ่าย — ST6-T04) ของงวดที่จ่ายแล้ว',
    description:
      'ต้นแบบ TMS Subcon การ์ดงวด "จ่ายแล้ว": ปุ่ม "ใบจ่ายเงิน" · แม่แบบ/ยอดเดียวกับ `GET /v1/settlements/{id}/pdf` · ' +
      'ใบของรถร่วมรายอื่น / ยังไม่จ่าย / ลิงก์ผิด/หมดอายุ/เพิกถอน → 404 · เกิน 10 ครั้ง/นาที ต่อลิงก์ → 429 `rate_limited`',
  })
  @ApiParam({ name: 'settlementId', type: String, description: 'ใบสำคัญจ่าย (stl_…)' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'application/pdf', schema: { type: 'string', format: 'binary' } })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป — ต่อ IP และ 10 ครั้ง/นาที ต่อลิงก์' })
  async voucherPdf(
    @Param('settlementId') ref: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const carrierId = this.carrierId();
    await this.limiter.assert([linkPdfBucket(requestContext.require().link!.id)], res);
    const sid = tryDecodeId('settlement', ref);
    if (!sid) throw new ProblemException('not_found');
    const id = await this.svc.paidSettlement(carrierId, sid);
    const { dto, pdf } = await this.pdf.render(id, true);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${(dto.settlementNo ?? 'payment-voucher').replace(/[^\w.-]/g, '_')}.pdf"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return new StreamableFile(pdf);
  }
}
