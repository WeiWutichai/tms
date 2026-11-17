import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ApiProblems } from '../../common/problem.dto';
import { apiOrigin } from '../documents/documents.controller';
import { T403, T404, T409, T412, T422 } from '../trips/trip-problems';
import {
  CreateFieldChargeDto,
  FieldChargeDto,
  FieldChargeListDto,
  FieldChargeReasonDto,
} from './field-charge.dto';
import { FieldChargesService } from './field-charges.service';

/**
 * ค่าใช้จ่ายหน้างานของเที่ยว (ST4-T13; docs/04 E2, docs/01 §3.3 `do_surcharge` / `trip_cost`)
 * อ่าน `trips:read` (ยอดตัดตามสิทธิ์ราคา `prices.sell:read` / `prices.buy:read`)
 * บันทึก `trips:read` + สิทธิ์แก้ราคาฝั่งนั้น (`prices.sell:write` / `prices.buy:write` — interceptor ราคาตรวจจาก field ใน body)
 */
@ApiTags('trips')
@ApiBearerAuth()
@Controller('trips')
export class TripFieldChargesController {
  constructor(private readonly svc: FieldChargesService) {}

  @Get(':id/field-charges')
  @TenantResource('trip')
  @RequireScope('trips:read')
  @ApiProblems(T403('trips:read'), T404)
  @ApiOkResponse({ type: FieldChargeListDto })
  async list(@Param('id') id: string, @Req() req: Request): Promise<FieldChargeListDto> {
    return { data: await this.svc.list(decodeIdOr404('trip', id), apiOrigin(req)) };
  }

  @Post(':id/field-charges')
  @TenantResource('trip')
  @RequireScope('trips:read')
  @ApiOperation({
    summary: 'บันทึกค่าใช้จ่ายหน้างาน (ฝั่งขาย/ซื้อ/ทั้งคู่) — รอผู้วางบิลยืนยัน',
    description:
      'เที่ยวต้องปล่อยรถแล้ว (DISPATCHED / IN_PROGRESS / COMPLETED) · ฝั่งขายต้องระบุ DO ในเที่ยว · ' +
      'ธงภาษี (vatType, whtRate) คัดลอกจากรายการบริการ ณ เวลาบันทึก · ฝั่งซื้อไม่คำนวณ VAT (รอนักบัญชี)',
  })
  @ApiProblems(T403('prices.sell:write'), T404, T409('invalid_state_transition'), T422)
  @ApiCreatedResponse({ type: FieldChargeListDto, description: 'บรรทัดที่สร้าง (1–2 บรรทัด)' })
  async create(
    @Param('id') id: string,
    @Body() body: CreateFieldChargeDto,
    @Req() req: Request,
  ): Promise<FieldChargeListDto> {
    return { data: await this.svc.create(decodeIdOr404('trip', id), body, apiOrigin(req)) };
  }
}

/** ฝั่งขาย — `do_surcharge` */
@ApiTags('trips')
@ApiBearerAuth()
@Controller('do-surcharges')
export class DoSurchargesController {
  constructor(private readonly svc: FieldChargesService) {}

  @Post(':id/confirm')
  @HttpCode(200)
  @TenantResource('doSurcharge')
  @RequireScope('invoices:draft')
  @ApiOperation({ summary: 'ยืนยันค่าใช้จ่ายหน้างานฝั่งขาย (ผู้วางบิล) — เหตุผล ≥ 10 ตัวอักษร' })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag (version) — ไม่ตรง → 412' })
  @ApiProblems(T403('invoices:draft'), T404, T409('invalid_state_transition'), T412, T422)
  @ApiOkResponse({ type: FieldChargeDto })
  confirm(
    @Param('id') id: string,
    @Body() body: FieldChargeReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run('confirm', id, body, req, res);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @TenantResource('doSurcharge')
  @RequireScope('invoices:draft')
  @ApiOperation({ summary: 'ปฏิเสธค่าใช้จ่ายหน้างานฝั่งขาย (ผู้วางบิล) — เหตุผล ≥ 10 ตัวอักษร' })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag (version) — ไม่ตรง → 412' })
  @ApiProblems(T403('invoices:draft'), T404, T409('invalid_state_transition'), T412, T422)
  @ApiOkResponse({ type: FieldChargeDto })
  reject(
    @Param('id') id: string,
    @Body() body: FieldChargeReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run('reject', id, body, req, res);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @TenantResource('doSurcharge')
  @RequireScope('prices.sell:write')
  @ApiOperation({
    summary: 'ยกเลิกค่าใช้จ่ายหน้างานฝั่งขายที่ยังรอยืนยัน — เหตุผล ≥ 10 ตัวอักษร',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag (version) — ไม่ตรง → 412' })
  @ApiProblems(T403('prices.sell:write'), T404, T409('invalid_state_transition'), T412, T422)
  @ApiOkResponse({ type: FieldChargeDto })
  cancel(
    @Param('id') id: string,
    @Body() body: FieldChargeReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run('cancel', id, body, req, res);
  }

  private async run(
    action: 'confirm' | 'reject' | 'cancel',
    id: string,
    body: FieldChargeReasonDto,
    req: Request,
    res: Response,
  ): Promise<FieldChargeDto> {
    const out = await this.svc.decide(
      'doSurcharge',
      decodeIdOr404('doSurcharge', id),
      action,
      body.reason,
      expectedVersion(req),
      apiOrigin(req),
    );
    setEtag(res, out.version);
    return out;
  }
}

/** ฝั่งซื้อ — `trip_cost` ที่บันทึกจากหน้างาน (บรรทัดระบบ เช่น CARRIER_FEE = 404) */
@ApiTags('trips')
@ApiBearerAuth()
@Controller('trip-costs')
export class TripCostsController {
  constructor(private readonly svc: FieldChargesService) {}

  @Post(':id/confirm')
  @HttpCode(200)
  @TenantResource('tripCost')
  @RequireScope('invoices:draft')
  @ApiOperation({ summary: 'ยืนยันค่าใช้จ่ายหน้างานฝั่งซื้อ (ผู้วางบิล) — เหตุผล ≥ 10 ตัวอักษร' })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag (version) — ไม่ตรง → 412' })
  @ApiProblems(T403('invoices:draft'), T404, T409('invalid_state_transition'), T412, T422)
  @ApiOkResponse({ type: FieldChargeDto })
  confirm(
    @Param('id') id: string,
    @Body() body: FieldChargeReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run('confirm', id, body, req, res);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @TenantResource('tripCost')
  @RequireScope('invoices:draft')
  @ApiOperation({ summary: 'ปฏิเสธค่าใช้จ่ายหน้างานฝั่งซื้อ (ผู้วางบิล) — เหตุผล ≥ 10 ตัวอักษร' })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag (version) — ไม่ตรง → 412' })
  @ApiProblems(T403('invoices:draft'), T404, T409('invalid_state_transition'), T412, T422)
  @ApiOkResponse({ type: FieldChargeDto })
  reject(
    @Param('id') id: string,
    @Body() body: FieldChargeReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run('reject', id, body, req, res);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @TenantResource('tripCost')
  @RequireScope('prices.buy:write')
  @ApiOperation({
    summary: 'ยกเลิกค่าใช้จ่ายหน้างานฝั่งซื้อที่ยังรอยืนยัน — เหตุผล ≥ 10 ตัวอักษร',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag (version) — ไม่ตรง → 412' })
  @ApiProblems(T403('prices.buy:write'), T404, T409('invalid_state_transition'), T412, T422)
  @ApiOkResponse({ type: FieldChargeDto })
  cancel(
    @Param('id') id: string,
    @Body() body: FieldChargeReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run('cancel', id, body, req, res);
  }

  private async run(
    action: 'confirm' | 'reject' | 'cancel',
    id: string,
    body: FieldChargeReasonDto,
    req: Request,
    res: Response,
  ): Promise<FieldChargeDto> {
    const out = await this.svc.decide(
      'tripCost',
      decodeIdOr404('tripCost', id),
      action,
      body.reason,
      expectedVersion(req),
      apiOrigin(req),
    );
    setEtag(res, out.version);
    return out;
  }
}
