import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { LinkAction, Public, RequireScope, TenantResource } from '../../common/decorators';
import { refToId } from '../../common/external-id';
import { decodeIdOr404 } from '../../common/ids';
import { DbService } from '../../db/db.service';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { RateLimitService } from '../../http/rate-limit/rate-limit.service';
import { assertTrackingRate, reserveLookup } from '../../http/tracking-rate-limit';
import { apiOrigin } from '../documents/documents.controller';
import { MasterReasonDto } from '../master/master-kit';
import { T403, T404, T409, T422 } from '../trips/trip-problems';
import {
  IssueTrackingLinkDto,
  TrackingLinkDto,
  TrackingLinkStateDto,
  TrackingLookupDto,
  TrackingShipmentDto,
  TrackingViewDto,
} from './tracking.dto';
import { TRACKING_ACTION, TrackingService } from './tracking.service';

const LINK_DESC =
  'URL มี token — ต้องมีสิทธิ์ออกลิงก์ · ลิงก์หน้าติดตามของผู้รับ (`/t/{token}` — magic link `tracking`, อายุ token 90 วัน; งานจบเกิน `tracking.linkDays` วัน = ใช้ไม่ได้) · ห้าม cache (มี token)';

/**
 * หน้าติดตามสาธารณะของผู้รับ (ST4-T14; docs/04 E2 "Tracking link สาธารณะ", docs/01 §5.2 #4, spec/04 §4 EXE-D)
 * ไม่ login — `/v1/public/*` (rate limit ต่อ IP + no-store) + 60 req/นาที/IP · ลิงก์ผิด/หมดอายุ/เพิกถอน/ไม่พบ = 404 เดียวกัน
 */
@ApiTags('public')
@ApiParam({ name: 'token', type: String, description: 'token ของลิงก์ติดตาม (ml1.…)' })
@Controller('public/tracking')
export class TrackingPublicController {
  constructor(
    private readonly tracking: TrackingService,
    private readonly limiter: RateLimitService,
  ) {}

  @Get(':token')
  @LinkAction(TRACKING_ACTION)
  @ApiOperation({
    summary:
      'เปิดลิงก์ติดตาม — ลิงก์ต่อ DO: สถานะ (stepper) ETA รายการสินค้า POD (ถ้าบริษัทเปิด) · ลิงก์ของลูกค้า: แบรนด์ + โหมดค้นหา',
    description:
      'ไม่มีราคา/ค่าขนส่ง ที่อยู่ ชื่อ/เบอร์คนขับ ทะเบียนเต็ม DO อื่นในเที่ยว (EXE-061) · แบรนด์ = ชื่อบริษัท + เบอร์บริษัท',
  })
  @ApiOkResponse({ type: TrackingViewDto })
  @ApiNotFoundResponse({ description: 'ลิงก์ใช้ไม่ได้ (ผิด/หมดอายุ/เพิกถอน/งานจบนานแล้ว)' })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป (ต่อ IP)' })
  async view(@Req() req: Request): Promise<TrackingViewDto> {
    await assertTrackingRate(this.limiter, requestContext.get()?.ip ?? req.ip);
    return this.tracking.view(apiOrigin(req));
  }

  @Post(':token/lookup')
  @HttpCode(200)
  @LinkAction(TRACKING_ACTION)
  @ApiOperation({
    summary:
      'ค้นด้วยเลขใบส่งของ (DO) หรือเลข PO ลูกค้า + เบอร์ผู้รับ 4 ตัวท้าย (ลิงก์ของลูกค้าเท่านั้น)',
    description:
      'เฉพาะ DO ของลูกค้าที่ลิงก์ชี้ · PO ซ้ำหลายใบ = ใบล่าสุดที่ยังไม่ยกเลิก · ไม่พบ/เบอร์ไม่ตรง = 404 เดียวกัน · นับทุกครั้งที่ไม่พบ: 5 ครั้ง/ชม./IP (EXE-062), 10 ครั้ง/ชม. ต่อเลขที่ค้นในลิงก์, 200 ครั้ง/ชม. ต่อลิงก์ → 429 · 30 คำขอ/นาที ต่อลิงก์',
  })
  @ApiOkResponse({ type: TrackingShipmentDto })
  @ApiProblems(T422)
  @ApiNotFoundResponse({ description: 'ไม่พบ (หรือเบอร์ไม่ตรง / ลิงก์ใช้ไม่ได้)' })
  @ApiTooManyRequestsResponse({
    description: 'เรียกถี่เกินไป หรือค้นไม่พบเกินเพดาน (ต่อ IP / ต่อเลข / ต่อลิงก์)',
  })
  async lookup(@Body() body: TrackingLookupDto, @Req() req: Request): Promise<TrackingShipmentDto> {
    const ip = requestContext.get()?.ip ?? req.ip;
    const linkId = requestContext.require().link!.id;
    // จอง (ต่อ IP + ต่อลิงก์ + ครั้งที่ลอง) แบบ atomic ในที่เก็บกลาง — คำขอพร้อมกัน/หลาย instance นับครบทุกครั้ง
    const r = await reserveLookup(this.limiter, ip, linkId, body.ref);
    const shipment = await this.tracking.lookup(body.ref, body.phoneLast4, apiOrigin(req));
    await r.refund();
    return shipment;
  }

  @Get('logo/:doc')
  @Public()
  @ApiParam({ name: 'doc', type: String, description: 'id ไฟล์โลโก้ (doc_…)' })
  @ApiOperation({
    summary:
      'P1-ST6-T04 (D68-93) โลโก้บริษัทบนหน้าติดตาม — URL มีลายเซ็นอายุ 15 นาที (จาก company.logoUrl) · แสดงในหน้า (inline) · SVG ล้างแล้วและส่งพร้อม CSP sandbox',
  })
  @ApiOkResponse({ description: 'รูป (image/png | image/svg+xml)' })
  @ApiNotFoundResponse({ description: 'ลายเซ็นผิด/หมดอายุ/ไม่ใช่โลโก้' })
  async logo(
    @Param('doc') doc: string,
    @Query() q: { t?: string; exp?: string; sig?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const img = await this.tracking.logoImage(doc, q);
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    return new StreamableFile(img.data);
  }

  @Get('pod-image/:doc')
  @Public()
  @ApiParam({ name: 'doc', type: String, description: 'id รูปหลักฐาน (doc_…)' })
  @ApiOperation({
    summary:
      'รูปหลักฐานส่งบนหน้าติดตาม — URL มีลายเซ็นอายุ 15 นาที (จาก shipment.pod) · ตัด EXIF/GPS/ข้อความแฝงออก · แสดงในหน้า (inline)',
  })
  @ApiOkResponse({ description: 'รูป (image/jpeg | image/png | image/webp)' })
  @ApiNotFoundResponse({ description: 'ลายเซ็นผิด/หมดอายุ/ไม่ใช่รูป' })
  async podImage(
    @Param('doc') doc: string,
    @Query() q: { t?: string; exp?: string; sig?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const img = await this.tracking.podImage(doc, q);
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(img.data);
  }
}

/** ผู้จัดรถ: ลิงก์ติดตามต่อใบส่งของ (spec/04 §4 — "dispatcher สร้างใหม่/เพิกถอนลิงก์ (`do.edit`)") */
@ApiTags('delivery-orders')
@ApiBearerAuth()
@Controller('delivery-orders')
export class DeliveryOrderTrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Get(':id/tracking-link')
  @TenantResource('deliveryOrder')
  @RequireScope('orders:write', 'trips:dispatch')
  @ApiProblems(T403('orders:write', 'trips:dispatch'), T404)
  @ApiOkResponse({ type: TrackingLinkStateDto, description: LINK_DESC })
  get(@Param('id') id: string): Promise<TrackingLinkStateDto> {
    return this.tracking.current('do', decodeIdOr404('deliveryOrder', id));
  }

  @Post(':id/tracking-link')
  @HttpCode(201)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:write', 'trips:dispatch')
  @ApiProblems(T403('orders:write', 'trips:dispatch'), T404, T409('invalid_state_transition'))
  @ApiBody({ type: IssueTrackingLinkDto, required: false })
  @ApiCreatedResponse({
    type: TrackingLinkDto,
    description: `ออกลิงก์ใหม่ — ลิงก์เดิมถูกเพิกถอน (1 ลิงก์ต่อ DO) · **มีลิงก์ที่ใช้ได้อยู่ต้องส่ง \`reason\` ≥ 10 ตัวอักษร** (ไม่ส่ง → 422 \`reason\` required) · DO ยกเลิกแล้ว → 409 · ${LINK_DESC}`,
  })
  issue(@Param('id') id: string, @Body() body: IssueTrackingLinkDto): Promise<TrackingLinkDto> {
    return this.tracking.issue('do', decodeIdOr404('deliveryOrder', id), body?.reason);
  }

  @Post(':id/tracking-link/revoke')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:write', 'trips:dispatch')
  @ApiProblems(T403('orders:write', 'trips:dispatch'), T404, T422)
  @ApiOkResponse({
    type: TrackingLinkStateDto,
    description: 'เพิกถอนลิงก์ที่ใช้ได้ (เหตุผล + audit)',
  })
  revoke(@Param('id') id: string, @Body() body: MasterReasonDto): Promise<TrackingLinkStateDto> {
    return this.tracking.revoke('do', decodeIdOr404('deliveryOrder', id), body.reason);
  }
}

/** ลิงก์ติดตามของลูกค้า (ผู้รับค้นเลข DO/PO เอง — docs/04 E2) — ลูกค้าแชร์ให้ผู้รับปลายทาง */
@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomerTrackingController {
  constructor(
    private readonly tracking: TrackingService,
    private readonly db: DbService,
  ) {}

  /** `cus_…` หรือ `ext:{externalId}` (ST7-T02) */
  private ref(id: string) {
    return refToId('customer', id, this.db.tx.customer);
  }

  @Get(':id/tracking-link')
  @TenantResource('customer')
  @RequireScope('master:write')
  @ApiProblems(T403('master:write'), T404)
  @ApiOkResponse({ type: TrackingLinkStateDto, description: LINK_DESC })
  async get(@Param('id') id: string): Promise<TrackingLinkStateDto> {
    return this.tracking.current('customer', await this.ref(id));
  }

  @Post(':id/tracking-link')
  @HttpCode(201)
  @TenantResource('customer')
  @RequireScope('master:write')
  @ApiProblems(T403('master:write'), T404)
  @ApiBody({ type: IssueTrackingLinkDto, required: false })
  @ApiCreatedResponse({
    type: TrackingLinkDto,
    description: `ออกลิงก์ใหม่ของลูกค้า — ลิงก์เดิมถูกเพิกถอน · **มีลิงก์ที่ใช้ได้อยู่ต้องส่ง \`reason\` ≥ 10 ตัวอักษร** (ไม่ส่ง → 422) · ${LINK_DESC}`,
  })
  async issue(
    @Param('id') id: string,
    @Body() body: IssueTrackingLinkDto,
  ): Promise<TrackingLinkDto> {
    return this.tracking.issue('customer', await this.ref(id), body?.reason);
  }

  @Post(':id/tracking-link/revoke')
  @HttpCode(200)
  @TenantResource('customer')
  @RequireScope('master:write')
  @ApiProblems(T403('master:write'), T404, T422)
  @ApiOkResponse({
    type: TrackingLinkStateDto,
    description: 'เพิกถอนลิงก์ที่ใช้ได้ (เหตุผล + audit)',
  })
  async revoke(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
  ): Promise<TrackingLinkStateDto> {
    return this.tracking.revoke('customer', await this.ref(id), body.reason);
  }
}
