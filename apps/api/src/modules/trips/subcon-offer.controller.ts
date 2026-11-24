import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { LinkAction, RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { OFFER_LINK_ACTIONS, OFFER_LINK_ENTITY, OFFER_LINK_PURPOSE } from './offer-links';
import {
  AcceptOfferDto,
  OfferLinkDto,
  OfferLinkStateDto,
  OfferLinkViewDto,
  RejectOfferDto,
  SubconOfferListDto,
} from './offer.dto';
import {
  SubconOfferListQuery,
  SubconOfferPageDto,
  SubconOfferSummaryDto,
} from './subcon-offer-list.dto';
import { SubconOfferListService } from './subcon-offer-list.service';
import { SubconOfferService } from './subcon-offer.service';
import { T403, T404, T409, T422 } from './trip-problems';
import { TripService } from './trip.service';

/**
 * ลิงก์ข้อเสนองานของรถร่วม — ฝั่งผู้จัดรถ (ST3-T23; docs/04 D3): ลิงก์ที่ใช้ได้ (คัดลอก/ส่งทาง LINE-SMS ด้วย
 * `POST /v1/messages/send-link`), ออกลิงก์ใหม่ (ลิงก์เดิมถูกเพิกถอน), ประวัติการจ้าง (แท็บกิจกรรมของ drawer "จ่ายงานรถร่วม")
 */
@ApiTags('trips')
@ApiBearerAuth()
@Controller('trips')
export class TripOffersController {
  constructor(
    private readonly trips: TripService,
    private readonly offers: SubconOfferService,
  ) {}

  @Get(':id/offer-link')
  @ApiProblems(T403('trips:assign'), T404)
  @TenantResource('trip')
  @RequireScope('trips:assign')
  @ApiOkResponse({
    type: OfferLinkStateDto,
    description:
      'ลิงก์ข้อเสนองานที่ใช้ได้ของการจ้างปัจจุบัน (รอตอบ/รับแล้ว) — `link: null` เมื่อไม่มี · ห้าม cache (มี token)',
  })
  async link(@Param('id') id: string): Promise<OfferLinkStateDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    return this.offers.currentLink(trip.id);
  }

  @Post(':id/offer-link')
  @HttpCode(201)
  @ApiProblems(T403('trips:assign'), T404, T409('offer_closed'))
  @TenantResource('trip')
  @RequireScope('trips:assign')
  @ApiCreatedResponse({
    type: OfferLinkDto,
    description:
      'ออกลิงก์ใหม่ให้ข้อเสนอที่รอตอบ (ลิงก์เดิมถูกเพิกถอน + audit) — อายุเท่าเดิม ไม่ต่อเวลาตอบ · ST4-T08: รับงานแล้ว (เที่ยวยังไม่จบ) = ออกลิงก์งาน (`/link/pod/…`) ใหม่ · อื่น → 409 `offer_closed`',
  })
  async reissue(@Param('id') id: string): Promise<OfferLinkDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    return this.offers.reissue(trip.id);
  }

  @Get(':id/offers')
  @ApiProblems(T403('trips:read'), T404)
  @TenantResource('trip')
  @RequireScope('trips:read')
  @ApiOkResponse({
    type: SubconOfferListDto,
    description:
      'ประวัติการจ้างรถร่วมของเที่ยว (ใหม่สุดก่อน: รอตอบ/รับ/ปฏิเสธ+เหตุผล/หมดเวลา/ถอน + การส่งลิงก์) — ราคาซื้อเห็นเมื่อมี `prices.buy:read`',
  })
  async history(@Param('id') id: string): Promise<SubconOfferListDto> {
    const trip = await this.trips.get(decodeIdOr404('trip', id));
    return { data: await this.offers.history(trip.id) };
  }
}

/**
 * หน้าลิงก์ข้อเสนองานของรถร่วม (ไม่ login — magic link ST1-T06, docs/01 §5.5 `/public/offers/{token}`)
 * `/v1/public/*` rate limit ต่อ IP + `Cache-Control: no-store` · ลิงก์หมดอายุ/เพิกถอน/ผิด → 404 (ไม่บอกใบ้)
 * เห็นเฉพาะข้อเสนอที่ลิงก์ชี้ — ไม่มีราคาขาย/กำไร/ที่อยู่ลูกค้า/ข้อเสนอของรายอื่น (spec/04 EXE-080)
 */
@ApiTags('public')
@ApiParam({ name: 'token', type: String, description: 'token ของลิงก์ (ml1.…)' })
@Controller('public/offers')
export class SubconOfferPublicController {
  constructor(private readonly offers: SubconOfferService) {}

  /** การจ้างที่ลิงก์ (ยืนยันแล้วโดย AuthGuard) ชี้ */
  private offerId(): string {
    const l = requestContext.require().link;
    if (!l || l.purpose !== OFFER_LINK_PURPOSE || l.entityType !== OFFER_LINK_ENTITY)
      throw new ProblemException('not_found');
    return l.entityId;
  }

  @Get(':token')
  @LinkAction(OFFER_LINK_ACTIONS.view)
  @ApiOkResponse({ type: OfferLinkViewDto })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป (ต่อ IP)' })
  view(): Promise<OfferLinkViewDto> {
    return this.offers.view(this.offerId());
  }

  @Post(':token/accept')
  @HttpCode(200)
  @LinkAction(OFFER_LINK_ACTIONS.respond)
  @ApiProblems(T409('offer_closed', 'assignment_blocked'), T422)
  @ApiOkResponse({
    type: OfferLinkViewDto,
    description:
      'รับงาน → เที่ยว ASSIGNED พร้อมทะเบียน/คนขับ (snapshot) · รถ/คนขับต้องลงทะเบียนกับรถร่วมรายนี้ (422) · ติดกฎเอกสาร/ใบขับขี่ → 409 `assignment_blocked` (detail ไทย) · กดซ้ำค่าเดิม = ผลเดิม',
  })
  accept(@Body() body: AcceptOfferDto): Promise<OfferLinkViewDto> {
    return this.offers.accept(this.offerId(), body);
  }

  @Post(':token/reject')
  @HttpCode(200)
  @LinkAction(OFFER_LINK_ACTIONS.respond)
  @ApiProblems(T409('offer_closed'), T422)
  @ApiOkResponse({
    type: OfferLinkViewDto,
    description:
      'ปฏิเสธ + เหตุผล → เที่ยวกลับ PLANNING, SO ค้าง `CARRIER_REJECTED`, ค่าจ้างที่ยังไม่จ่ายกลับรายการ · กดซ้ำเหตุผลเดิม = ผลเดิม',
  })
  reject(@Body() body: RejectOfferDto): Promise<OfferLinkViewDto> {
    return this.offers.reject(this.offerId(), body);
  }
}

/**
 * หน้า "จ่ายงานรถร่วม" (`/sub` — ต้นแบบ TMS v4 `specSub` + `kpisX('sub')`): การจ้างรถร่วมล่าสุดของแต่ละเที่ยว (รอตอบ/รับงาน/ปฏิเสธ/หมดเวลา)
 * [DECISION — lead 24 พ.ย. 2569 เพื่อ UAT, ย้อนได้ — spec/12 §3 แถว "หน้า /sub"]
 */
@ApiTags('trips')
@ApiBearerAuth()
@Controller('subcon-offers')
export class SubconOffersController {
  constructor(private readonly list: SubconOfferListService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'ตัวนับหน้า "จ่ายงานรถร่วม" (รอตอบ/รับงาน/ปฏิเสธ/หมดเวลา + ต้นทุนรถร่วมเดือนนี้)',
    description:
      'นับด้วยนิยามเดียวกับ `GET /subcon-offers?status=` · `buyAcceptedThisMonth` เห็นเมื่อมี `prices.buy:read`',
  })
  @ApiProblems(T403('trips:read'))
  @RequireScope('trips:read')
  @ApiOkResponse({ type: SubconOfferSummaryDto })
  summary(): Promise<SubconOfferSummaryDto> {
    return this.list.summary();
  }

  @Get()
  @ApiOperation({
    summary: 'รายการจ่ายงานรถร่วม — การจ้างล่าสุดของแต่ละเที่ยว',
    description:
      'หนึ่งแถวต่อเที่ยว (การจ้างล่าสุดที่ไม่ถูกถอน — การจ้างก่อนหน้าดูที่ `GET /trips/{id}/offers`) · กรองสถานะ (คั่นด้วย ,) / ผู้รับเหมา · ' +
      'EXPIRED รวมข้อเสนอรอตอบที่ลิงก์หมดอายุแล้ว · cursor มาตรฐาน (updatedAt, id) · ราคาซื้อเห็นเมื่อมี `prices.buy:read`, รายได้เมื่อมี `prices.sell:read`',
  })
  @ApiProblems(T403('trips:read'), T422)
  @RequireScope('trips:read')
  @ApiOkResponse({ type: SubconOfferPageDto })
  index(@Query() q: SubconOfferListQuery): Promise<SubconOfferPageDto> {
    return this.list.list(q);
  }
}
