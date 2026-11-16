import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { scopeAllows } from '@tms/domain';
import { IsOptional, IsString, Matches } from 'class-validator';
import type { Request, Response } from 'express';
import { LinkAction, NoTransaction, RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { isRealDate } from '../vehicle-documents/expiry';
import { T403, T404, T409, T422 } from '../trips/trip-problems';
import { DocumentDto, apiOrigin, readyDocumentDto } from '../documents/documents.controller';
import {
  SHEET_LINK_ACTION,
  SHEET_LINK_PURPOSE,
  TripSheetsService,
  type SheetResult,
} from './trip-sheets.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class TripSheetDto {
  @ApiProperty({ type: DocumentDto, description: 'ไฟล์ PDF ที่สร้าง (`downloadUrl` อายุ 5 นาที)' })
  document!: DocumentDto;
  @ApiProperty({ type: [String], example: ['trp_…'], description: 'เที่ยวในไฟล์ (ตามลำดับหน้า)' })
  tripIds!: string[];
  @ApiProperty({ type: [String], example: ['TRP-2611-0041'] }) tripNos!: string[];
}

export class TripSheetLinkDto extends TripSheetDto {
  @ApiProperty({
    example: 'https://api.example/v1/public/trip-sheets/ml1.…',
    description:
      'ลิงก์เปิด PDF โดยไม่ต้อง login — คัดลอกส่งให้คนขับ (LINE/SMS ของคนขับโดยตรง = ST4)',
  })
  url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class DailyTripSheetDto {
  @ApiProperty({ example: '2026-11-18', description: 'วันเที่ยว (เวลาไทย)' })
  @Matches(DATE_RE)
  date!: string;
  @ApiPropertyOptional({ example: 'veh_…', description: 'เฉพาะรถคันนี้ — ไม่ส่ง = ทุกคัน' })
  @IsOptional()
  @IsString()
  vehicleId?: string;
}

/** พิมพ์ = ดูเที่ยวได้ + เขียนไฟล์เอกสารได้ (ผู้ใช้ "ดูอย่างเดียว" ไม่สร้างไฟล์ — spec/12 §3 ST3-T20) */
function requireDocWrite() {
  if (!scopeAllows(requestContext.require().scopes ?? [], 'documents:write'))
    throw new ProblemException('permission_denied');
}

function toDto(r: SheetResult, req: Request): TripSheetDto {
  return {
    document: readyDocumentDto(r.doc, apiOrigin(req)),
    tripIds: r.trips.map((t) => encodeId('trip', t.id)),
    tripNos: r.trips.map((t) => t.tripNo ?? ''),
  };
}

/**
 * ใบงานประจำวัน / ใบคุมรถ PDF (ST3-T20; docs/04 D2, spec/03 §4 "พิมพ์ A4 ใบคุมรถ", spec/05 ใบคุมรถ)
 * เอกสารปฏิบัติการ (ไม่ใช่เอกสารภาษี — ไม่ออกเลข) · ทุกครั้งที่สร้าง = ไฟล์ใหม่ตามข้อมูล ณ ตอนนั้น + audit
 */
@ApiTags('trips')
@ApiBearerAuth()
@Controller()
export class TripSheetsController {
  constructor(private readonly svc: TripSheetsService) {}

  @Post('trips/:id/sheet')
  @HttpCode(201)
  @NoTransaction()
  @TenantResource('trip')
  @RequireScope('trips:read')
  @ApiOperation({
    summary: 'สร้าง PDF ใบคุมรถของเที่ยว (A4) — ต้องมี `trips:read` + `documents:write`',
  })
  @ApiProblems(T403('trips:read'), T404, T409('invalid_state_transition', 'trip_empty'))
  @ApiCreatedResponse({ type: TripSheetDto })
  async trip(@Param('id') id: string, @Req() req: Request): Promise<TripSheetDto> {
    const tripId = decodeIdOr404('trip', id);
    requireDocWrite();
    return toDto(await this.svc.forTrip(tripId), req);
  }

  @Post('trips/:id/sheet/driver-link')
  @HttpCode(201)
  @NoTransaction()
  @TenantResource('trip')
  @RequireScope('trips:dispatch')
  @ApiOperation({
    summary:
      'ส่งให้คนขับ: สร้างใบคุมรถใหม่ + ลิงก์เปิด PDF ไม่ต้อง login (72 ชม.) สำหรับคัดลอกส่ง — `trips:dispatch`',
  })
  @ApiProblems(T403('trips:dispatch'), T404, T409('invalid_state_transition', 'trip_empty'))
  @ApiCreatedResponse({ type: TripSheetLinkDto })
  async driverLink(@Param('id') id: string, @Req() req: Request): Promise<TripSheetLinkDto> {
    const tripId = decodeIdOr404('trip', id);
    requireDocWrite();
    const r = await this.svc.driverLink(tripId);
    return {
      ...toDto(r, req),
      url: `${apiOrigin(req).replace(/\/+$/, '')}/v1/public/trip-sheets/${r.token}`,
      expiresAt: r.expiresAt.toISOString(),
    };
  }

  @Post('trip-sheets')
  @HttpCode(201)
  @NoTransaction()
  @RequireScope('trips:read')
  @ApiOperation({
    summary:
      'ใบงานประจำวัน: PDF ใบคุมรถทุกเที่ยวของวัน (หรือของรถคันเดียว) 1 เที่ยว/หน้า — ไม่มีเที่ยว → 422 `no_trips`',
  })
  @ApiProblems(T403('trips:read'), T422)
  @ApiCreatedResponse({ type: TripSheetDto })
  async day(@Body() body: DailyTripSheetDto, @Req() req: Request): Promise<TripSheetDto> {
    if (!isRealDate(body.date))
      throw new ProblemException('validation_failed', undefined, [
        { field: 'date', code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' },
      ]);
    const vehicleId = body.vehicleId === undefined ? null : tryDecodeId('vehicle', body.vehicleId);
    if (body.vehicleId !== undefined && !vehicleId)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'vehicleId', code: 'invalid_reference', message: 'not found' },
      ]);
    requireDocWrite();
    return toDto(await this.svc.forDay(body.date, vehicleId), req);
  }
}

/**
 * ลิงก์ใบคุมรถของคนขับ (ไม่ login — magic link `trip_sheet`): เปิด PDF ที่สร้างไว้ตอนส่ง (snapshot) แบบ inline
 * `/v1/public/*` มี rate limit ต่อ IP · ลิงก์หมดอายุ/เพิกถอน/ผิด → 404
 */
@ApiTags('public')
@ApiParam({ name: 'token', type: String, description: 'token ของลิงก์ (ml1.…)' })
@Controller('public/trip-sheets')
export class TripSheetsPublicController {
  constructor(private readonly svc: TripSheetsService) {}

  @Get(':token')
  @LinkAction(SHEET_LINK_ACTION)
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'ไฟล์ PDF ใบคุมรถ', schema: { type: 'string', format: 'binary' } })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป (ต่อ IP)' })
  async view(@Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const l = requestContext.require().link;
    if (!l || l.purpose !== SHEET_LINK_PURPOSE || l.entityType !== 'stored_document')
      throw new ProblemException('not_found');
    const { doc, data } = await this.svc.linkedFile(l.entityId);
    const name = (doc.filename ?? 'trip-sheet.pdf').replace(/[^\w.\-]/g, '_');
    const utf8 = encodeURIComponent(doc.filename ?? name).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${name}"; filename*=UTF-8''${utf8}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return new StreamableFile(data);
  }
}
