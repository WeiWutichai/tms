import { Body, Controller, Get, Header, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { LinkAction, RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import {
  assertLookupAllowed,
  assertTrackingRate,
  recordLookupFailure,
} from '../../http/tracking-rate-limit';
import { apiOrigin } from '../documents/documents.controller';
import { MasterReasonDto } from '../master/master-kit';
import { T403, T404, T409, T422 } from '../trips/trip-problems';
import {
  TrackingLinkDto,
  TrackingLinkStateDto,
  TrackingLookupDto,
  TrackingShipmentDto,
  TrackingViewDto,
} from './tracking.dto';
import { TRACKING_ACTION, TrackingService } from './tracking.service';

const LINK_DESC =
  'ลิงก์หน้าติดตามของผู้รับ (`/t/{token}` — magic link `tracking`, อายุ token 90 วัน; งานจบเกิน `tracking.linkDays` วัน = ใช้ไม่ได้) · ห้าม cache (มี token)';

/**
 * หน้าติดตามสาธารณะของผู้รับ (ST4-T14; docs/04 E2 "Tracking link สาธารณะ", docs/01 §5.2 #4, spec/04 §4 EXE-D)
 * ไม่ login — `/v1/public/*` (rate limit ต่อ IP + no-store) + 60 req/นาที/IP · ลิงก์ผิด/หมดอายุ/เพิกถอน/ไม่พบ = 404 เดียวกัน
 */
@ApiTags('public')
@ApiParam({ name: 'token', type: String, description: 'token ของลิงก์ติดตาม (ml1.…)' })
@Controller('public/tracking')
export class TrackingPublicController {
  constructor(private readonly tracking: TrackingService) {}

  @Get(':token')
  @LinkAction(TRACKING_ACTION)
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Referrer-Policy', 'no-referrer')
  @ApiOperation({
    summary:
      'เปิดลิงก์ติดตาม — ลิงก์ต่อ DO: สถานะ (stepper) ETA รายการสินค้า POD (ถ้าบริษัทเปิด) · ลิงก์ของลูกค้า: แบรนด์ + โหมดค้นหา',
    description:
      'ไม่มีราคา/ค่าขนส่ง ที่อยู่ ชื่อ/เบอร์คนขับ ทะเบียนเต็ม DO อื่นในเที่ยว (EXE-061) · แบรนด์ = ชื่อบริษัท + เบอร์บริษัท',
  })
  @ApiOkResponse({ type: TrackingViewDto })
  @ApiNotFoundResponse({ description: 'ลิงก์ใช้ไม่ได้ (ผิด/หมดอายุ/เพิกถอน/งานจบนานแล้ว)' })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป (ต่อ IP)' })
  view(@Req() req: Request): Promise<TrackingViewDto> {
    assertTrackingRate(requestContext.get()?.ip ?? req.ip);
    return this.tracking.view(apiOrigin(req));
  }

  @Post(':token/lookup')
  @HttpCode(200)
  @LinkAction(TRACKING_ACTION)
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Referrer-Policy', 'no-referrer')
  @ApiOperation({
    summary: 'ค้นด้วยเลขใบส่งของ (DO) หรือเลข PO ลูกค้า + เบอร์ผู้รับ 4 ตัวท้าย (ลิงก์ของลูกค้าเท่านั้น)',
    description:
      'เฉพาะ DO ของลูกค้าที่ลิงก์ชี้ · PO ซ้ำหลายใบ = ใบล่าสุดที่ยังไม่ยกเลิก · ไม่พบ/เบอร์ไม่ตรง = 404 เดียวกัน · ค้นผิด 5 ครั้ง/ชม./IP → 429 ล็อก 1 ชม. (EXE-062)',
  })
  @ApiOkResponse({ type: TrackingShipmentDto })
  @ApiProblems(T422)
  @ApiNotFoundResponse({ description: 'ไม่พบ (หรือเบอร์ไม่ตรง / ลิงก์ใช้ไม่ได้)' })
  @ApiTooManyRequestsResponse({
    description: 'เรียกถี่เกินไป หรือค้นผิดเกินเพดาน (5 ครั้ง/ชม. ต่อ IP, 30 ครั้ง/ชม. ต่อลิงก์)',
  })
  async lookup(@Body() body: TrackingLookupDto, @Req() req: Request): Promise<TrackingShipmentDto> {
    const ip = requestContext.get()?.ip ?? req.ip;
    assertTrackingRate(ip);
    const linkId = requestContext.require().link!.id;
    assertLookupAllowed(ip, linkId);
    try {
      return await this.tracking.lookup(body.ref, body.phoneLast4, apiOrigin(req));
    } catch (e) {
      if (e instanceof ProblemException && e.code === 'not_found') recordLookupFailure(ip, linkId);
      throw e;
    }
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
  @RequireScope('orders:read')
  @ApiProblems(T403('orders:read'), T404)
  @ApiOkResponse({ type: TrackingLinkStateDto, description: LINK_DESC })
  get(@Param('id') id: string): Promise<TrackingLinkStateDto> {
    return this.tracking.current('do', decodeIdOr404('deliveryOrder', id));
  }

  @Post(':id/tracking-link')
  @HttpCode(201)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:write')
  @ApiProblems(T403('orders:write'), T404, T409('invalid_state_transition'))
  @ApiCreatedResponse({
    type: TrackingLinkDto,
    description: `ออกลิงก์ใหม่ — ลิงก์เดิมถูกเพิกถอน (1 ลิงก์ต่อ DO) · DO ยกเลิกแล้ว → 409 · ${LINK_DESC}`,
  })
  issue(@Param('id') id: string): Promise<TrackingLinkDto> {
    return this.tracking.issue('do', decodeIdOr404('deliveryOrder', id));
  }

  @Post(':id/tracking-link/revoke')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:write')
  @ApiProblems(T403('orders:write'), T404, T422)
  @ApiOkResponse({ type: TrackingLinkStateDto, description: 'เพิกถอนลิงก์ที่ใช้ได้ (เหตุผล + audit)' })
  revoke(@Param('id') id: string, @Body() body: MasterReasonDto): Promise<TrackingLinkStateDto> {
    return this.tracking.revoke('do', decodeIdOr404('deliveryOrder', id), body.reason);
  }
}

/** ลิงก์ติดตามของลูกค้า (ผู้รับค้นเลข DO/PO เอง — docs/04 E2) — ลูกค้าแชร์ให้ผู้รับปลายทาง */
@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomerTrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Get(':id/tracking-link')
  @TenantResource('customer')
  @RequireScope('master:read')
  @ApiProblems(T403('master:read'), T404)
  @ApiOkResponse({ type: TrackingLinkStateDto, description: LINK_DESC })
  get(@Param('id') id: string): Promise<TrackingLinkStateDto> {
    return this.tracking.current('customer', decodeIdOr404('customer', id));
  }

  @Post(':id/tracking-link')
  @HttpCode(201)
  @TenantResource('customer')
  @RequireScope('master:write')
  @ApiProblems(T403('master:write'), T404)
  @ApiCreatedResponse({
    type: TrackingLinkDto,
    description: `ออกลิงก์ใหม่ของลูกค้า — ลิงก์เดิมถูกเพิกถอน · ${LINK_DESC}`,
  })
  issue(@Param('id') id: string): Promise<TrackingLinkDto> {
    return this.tracking.issue('customer', decodeIdOr404('customer', id));
  }

  @Post(':id/tracking-link/revoke')
  @HttpCode(200)
  @TenantResource('customer')
  @RequireScope('master:write')
  @ApiProblems(T403('master:write'), T404, T422)
  @ApiOkResponse({ type: TrackingLinkStateDto, description: 'เพิกถอนลิงก์ที่ใช้ได้ (เหตุผล + audit)' })
  revoke(@Param('id') id: string, @Body() body: MasterReasonDto): Promise<TrackingLinkStateDto> {
    return this.tracking.revoke('customer', decodeIdOr404('customer', id), body.reason);
  }
}
