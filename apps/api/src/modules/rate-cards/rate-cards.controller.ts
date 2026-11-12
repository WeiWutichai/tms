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
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { scopeAllows } from '@tms/domain';
import type { Request, Response } from 'express';
import { AuditPageDto } from '../../audit/audit.controller';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { sendExport, type ExportColumn } from '../master/export';
import { entityHistory, HistoryQuery } from '../master/history';
import { MasterReasonDto } from '../master/master-kit';
import {
  CarrierRecentPricesDto,
  CarrierRecentPricesQuery,
  CreateRateCardDto,
  RateCardDto,
  RateCardExportQuery,
  RateCardListQuery,
  RateCardPageDto,
  RateCardSummaryDto,
  RateCardSummaryQuery,
  ReviseRateCardDto,
  UpdateRateCardDto,
  UpsertRateCardDto,
  type RateStatusKey,
} from './rate-card.dto';
import { RateCardsService, toRateCardDto } from './rate-cards.service';

const MODEL_TH: Record<string, string> = {
  PER_TRIP: 'เหมาเที่ยว',
  PER_KM: 'ต่อกม.',
  PER_TON: 'ต่อตัน',
  PER_CBM: 'ต่อ ลบ.ม.',
  PER_UNIT: 'ต่อหน่วย',
  PER_DAY: 'เหมาวัน',
};
const STATUS_TH: Record<RateStatusKey, string> = {
  draft: 'รออนุมัติ',
  pending_approval: 'รออนุมัติ',
  active: 'มีผล',
  expired: 'หมดอายุ',
  retired: 'ยกเลิก',
};

/**
 * คอลัมน์ไฟล์ส่งออก — ราคาใส่เฉพาะผู้มี `prices.sell:read` (ขาขาย) / `prices.buy:read` (ขาซื้อ)
 * (ไฟล์ไม่ผ่าน PriceFieldInterceptor — common/price-fields ข้อ 3)
 */
function exportColumns(side: 'SELL' | 'BUY', withPrices: boolean): ExportColumn<RateCardDto>[] {
  const buy = side === 'BUY';
  return [
    { header: 'รหัส', value: (r) => r.code },
    { header: 'ฉบับที่', value: (r) => r.revision },
    ...((buy
      ? [
          { header: 'รหัสผู้รับเหมา', value: (r) => r.carrier?.code },
          { header: 'ผู้รับเหมา', value: (r) => r.carrier?.name },
        ]
      : [
          { header: 'รหัสลูกค้า', value: (r) => r.customer?.code },
          { header: 'ลูกค้า', value: (r) => r.customer?.name },
        ]) satisfies ExportColumn<RateCardDto>[]),
    { header: 'รหัสต้นทาง', value: (r) => r.origin.code },
    { header: 'ต้นทาง', value: (r) => r.origin.name },
    { header: 'รหัสปลายทาง', value: (r) => r.destination.code },
    { header: 'ปลายทาง', value: (r) => r.destination.name },
    { header: 'ประเภทรถ', value: (r) => r.vehicleType.name },
    { header: 'สูตร', value: (r) => MODEL_TH[r.pricingModel] ?? r.pricingModel },
    { header: 'หน่วย', value: (r) => r.unit?.name },
    ...(withPrices
      ? ([
          { header: 'ราคา (บาท)', value: (r) => (buy ? r.buyRate : r.sellRate) },
          { header: 'ขั้นต่ำ (บาท)', value: (r) => (buy ? r.buyMinCharge : r.sellMinCharge) },
          {
            header: 'ค่าเพิ่มต่อจุด (บาท)',
            value: (r) => (buy ? r.buyExtraStopRate : r.sellExtraStopRate),
          },
        ] satisfies ExportColumn<RateCardDto>[])
      : []),
    { header: 'จุดที่รวมในราคา', value: (r) => r.includedStops },
    { header: 'มีผลตั้งแต่', value: (r) => r.validFrom },
    { header: 'ถึง', value: (r) => r.validTo },
    { header: 'สถานะ', value: (r) => STATUS_TH[r.status] },
    { header: 'รหัสในระบบต้นทาง', value: (r) => r.externalId },
  ];
}

/**
 * Rate card (ST2-T13 ขาขาย · ST2-T14 ขาซื้อ `side=BUY`; docs/01 §5.2 #6 `rate-cards`) — list/get/create/PATCH ร่าง/revise/approve/cancel/delete
 * + `PUT /external/{id}` + export + ประวัติ
 * สิทธิ์: อ่าน `master:read` (ราคาขายเห็นเมื่อมี `prices.sell:read`, ราคาซื้อ `prices.buy:read`)
 * · เขียน/อนุมัติ: ขาขาย `prices.sell:write` / ขาซื้อ `prices.buy:write` (ตรวจตามฝั่งของ rate ใน service → 403) · ส่งออก `export:run`
 */
@ApiTags('rate-cards')
@ApiBearerAuth()
@Controller('rate-cards')
export class RateCardsController {
  constructor(
    private readonly rates: RateCardsService,
    private readonly db: DbService,
  ) {}

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.rates.getByExternalId(id.slice(4));
    return this.rates.get(decodeIdOr404('rateCard', id));
  }

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: RateCardPageDto })
  list(@Query() q: RateCardListQuery) {
    return this.rates.list(q);
  }

  @Get('summary')
  @RequireScope('master:read')
  @ApiOkResponse({ type: RateCardSummaryDto })
  summary(@Query() q: RateCardSummaryQuery): Promise<RateCardSummaryDto> {
    return this.rates.summary(q.side ?? 'SELL', q.customerId, q.carrierId);
  }

  @Get('export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description:
      'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว) — คอลัมน์ราคาเฉพาะผู้มี `prices.sell:read` (ขาขาย) / `prices.buy:read` (ขาซื้อ)',
  })
  async export(
    @Query() q: RateCardExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.rates.exportRows(q);
    const side = q.side ?? 'SELL';
    const withPrices = scopeAllows(
      requestContext.require().scopes ?? [],
      side === 'BUY' ? 'prices.buy:read' : 'prices.sell:read',
    );
    return sendExport(
      res,
      q.format ?? 'xlsx',
      side === 'BUY' ? 'rate-cards-buy' : 'rate-cards',
      exportColumns(side, withPrices),
      rows,
    );
  }

  /** สร้างร่าง — ช่วงวันทับ rate อื่นใน key เดียวกัน → 422 `overlap` (+ `conflicts`) */
  @Post()
  @RequireScope('prices.sell:write', 'prices.buy:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: RateCardDto })
  async create(
    @Body() body: CreateRateCardDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RateCardDto> {
    const r = await this.rates.create(body);
    setEtag(res, r.version);
    return toRateCardDto(r);
  }

  @Put('external/:externalId')
  @RequireScope('prices.sell:write', 'prices.buy:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว' })
  @ApiOkResponse({
    type: RateCardDto,
    description: 'มีอยู่แล้ว (ร่าง) → แก้ (ส่งซ้ำได้ ไม่เกิดแถวใหม่)',
  })
  @ApiCreatedResponse({ type: RateCardDto, description: 'ยังไม่มี → สร้างร่าง' })
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertRateCardDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RateCardDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const { row, created } = await this.rates.upsertExternal(
      externalId,
      body,
      expectedVersion(req),
    );
    res.status(created ? 201 : 200);
    setEtag(res, row.version);
    return toRateCardDto(row);
  }

  @Get(':id')
  @TenantResource('rateCard')
  @RequireScope('master:read')
  @ApiOkResponse({ type: RateCardDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RateCardDto> {
    const r = await this.resolve(id);
    setEtag(res, r.version);
    return toRateCardDto(r);
  }

  @Get(':id/history')
  @TenantResource('rateCard')
  @RequireScope('master:read')
  @ApiOkResponse({
    type: AuditPageDto,
    description:
      'ประวัติการแก้จาก audit log ใหม่สุดก่อน (ราคาถูกตัดตามสิทธิ์ `prices.sell:read` / `prices.buy:read`)',
  })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const r = await this.resolve(id);
    return entityHistory(this.db.tx, 'rate_card', r.id, q);
  }

  /** แก้ร่าง — อนุมัติแล้ว → 409 `not_editable` (ใช้ `POST /{id}/revise`) */
  @Patch(':id')
  @TenantResource('rateCard')
  @RequireScope('prices.sell:write', 'prices.buy:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: RateCardDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateRateCardDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RateCardDto> {
    const current = await this.resolve(id);
    const r = await this.rates.update(current.id, body, expectedVersion(req));
    setEtag(res, r.version);
    return toRateCardDto(r);
  }

  /** ออกฉบับแก้ไข (ร่าง ฉบับที่ +1) ของ rate ที่อนุมัติแล้ว — MD-118 */
  @Post(':id/revise')
  @TenantResource('rateCard')
  @RequireScope('prices.sell:write', 'prices.buy:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag ของฉบับเดิม — ไม่ตรง → 412' })
  @ApiCreatedResponse({ type: RateCardDto, description: 'ร่างฉบับใหม่' })
  async revise(
    @Param('id') id: string,
    @Body() body: ReviseRateCardDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RateCardDto> {
    const current = await this.resolve(id);
    const r = await this.rates.revise(current.id, body, expectedVersion(req));
    setEtag(res, r.version);
    return toRateCardDto(r);
  }

  /** อนุมัติ (เหตุผล ≥ 10 + audit) → ใช้งาน · ฉบับแก้ไขปิดฉบับเดิมให้อัตโนมัติ */
  @Post(':id/approve')
  @HttpCode(200)
  @TenantResource('rateCard')
  @RequireScope('prices.sell:write', 'prices.buy:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: RateCardDto })
  async approve(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RateCardDto> {
    const current = await this.resolve(id);
    const r = await this.rates.approve(current.id, body.reason, expectedVersion(req));
    setEtag(res, r.version);
    return toRateCardDto(r);
  }

  /** ยกเลิก rate ที่อนุมัติแล้วแต่ยังไม่ถึงวันเริ่ม (เหตุผล ≥ 10) — มีผลแล้ว → 409 `in_effect` */
  @Post(':id/cancel')
  @HttpCode(200)
  @TenantResource('rateCard')
  @RequireScope('prices.sell:write', 'prices.buy:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: RateCardDto })
  async cancel(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RateCardDto> {
    const current = await this.resolve(id);
    const r = await this.rates.cancel(current.id, body.reason, expectedVersion(req));
    setEtag(res, r.version);
    return toRateCardDto(r);
  }

  /** ลบร่าง (soft delete + เหตุผล ≥ 10) — อนุมัติแล้ว → 409 */
  @Post(':id/delete')
  @HttpCode(204)
  @TenantResource('rateCard')
  @RequireScope('prices.sell:write', 'prices.buy:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    const current = await this.resolve(id);
    await this.rates.remove(current.id, body.reason, expectedVersion(req));
  }
}

/**
 * ราคา 5 ครั้งล่าสุดที่จ้างรถร่วมรายนี้ (ST2-T14; docs/04 B "Rate card ขาซื้อ") — ใช้ใน drawer ผู้รับเหมา และหน้าจ่ายงาน (ST3)
 * สิทธิ์ `prices.buy:read` (ไม่มี → 403 — ทั้ง endpoint เป็นราคาซื้อ) · รถร่วมของ tenant อื่น/ลบแล้ว → 404 · ยังไม่เคยจ้าง → `data: []`
 */
@ApiTags('carriers')
@ApiBearerAuth()
@Controller('carriers')
export class CarrierRecentPricesController {
  constructor(private readonly rates: RateCardsService) {}

  @Get(':id/recent-prices')
  @TenantResource('carrier')
  @RequireScope('prices.buy:read')
  @ApiOkResponse({ type: CarrierRecentPricesDto })
  async recentPrices(
    @Param('id') id: string,
    @Query() q: CarrierRecentPricesQuery,
  ): Promise<CarrierRecentPricesDto> {
    return { data: await this.rates.recentCarrierPrices(decodeIdOr404('carrier', id), q) };
  }
}
