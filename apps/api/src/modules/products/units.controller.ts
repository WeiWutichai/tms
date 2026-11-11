import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuditPageDto } from '../../audit/audit.controller';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { DbService } from '../../db/db.service';
import { entityHistory, HistoryQuery } from '../master/history';
import { MasterOptionalReasonDto, MasterReasonDto } from '../master/master-kit';
import { CreateUnitDto, UnitDto, UnitListQuery, UnitPageDto, UpdateUnitDto } from './unit.dto';
import { UnitsService } from './units.service';

/**
 * หน่วยนับ (ST2-T10; spec/02 §3 Unit) — รายการ/สร้าง/แก้/ปิดใช้/ลบ + ประวัติ
 * ชุดเริ่มต้น 9 หน่วยสร้างให้ทุก tenant (bootstrap ขั้น `units`) · สิทธิ์เดียวกับสินค้า
 */
@ApiTags('units')
@ApiBearerAuth()
@Controller('units')
export class UnitsController {
  constructor(
    private readonly units: UnitsService,
    private readonly db: DbService,
  ) {}

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: UnitPageDto })
  list(@Query() q: UnitListQuery) {
    return this.units.list(q);
  }

  /** สร้าง — รหัส/ชื่อซ้ำ → 409 `duplicate` */
  @Post()
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: UnitDto })
  async create(
    @Body() body: CreateUnitDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnitDto> {
    const u = await this.units.create(body);
    setEtag(res, u.version);
    return this.units.dto(u);
  }

  @Get(':id')
  @TenantResource('unit')
  @RequireScope('master:read')
  @ApiOkResponse({ type: UnitDto })
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<UnitDto> {
    const u = await this.units.get(decodeIdOr404('unit', id));
    setEtag(res, u.version);
    return this.units.dto(u);
  }

  @Get(':id/history')
  @TenantResource('unit')
  @RequireScope('master:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติการแก้จาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const u = await this.units.get(decodeIdOr404('unit', id));
    return entityHistory(this.db.tx, 'unit', u.id, q);
  }

  /** แก้ — หน่วยของระบบแก้ได้เฉพาะชื่อ; หน่วยที่สินค้าใช้อยู่เปลี่ยนรหัส/ชนิด/ตัวแปลงไม่ได้ (422) */
  @Patch(':id')
  @TenantResource('unit')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: UnitDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateUnitDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnitDto> {
    const u = await this.units.update(decodeIdOr404('unit', id), body, expectedVersion(req));
    setEtag(res, u.version);
    return this.units.dto(u);
  }

  @Post(':id/deactivate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('unit')
  @RequireScope('master:write')
  @ApiOkResponse({
    type: UnitDto,
    description: 'สินค้าเดิมใช้หน่วยต่อได้ แต่เลือกในสินค้าใหม่ไม่ได้',
  })
  async deactivate(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnitDto> {
    const u = await this.units.changeStatus(
      decodeIdOr404('unit', id),
      'deactivate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, u.version);
    return this.units.dto(u);
  }

  @Post(':id/activate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('unit')
  @RequireScope('master:write')
  @ApiOkResponse({ type: UnitDto })
  async activate(
    @Param('id') id: string,
    @Body() body: MasterOptionalReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnitDto> {
    const u = await this.units.changeStatus(
      decodeIdOr404('unit', id),
      'activate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, u.version);
    return this.units.dto(u);
  }

  /** "ลบ" — หน่วยของระบบ → 409 `conflict` · มีสินค้าใช้ → 409 `in_use` (ให้ปิดใช้แทน) */
  @Post(':id/delete')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(204)
  @TenantResource('unit')
  @RequireScope('master:write')
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.units.remove(decodeIdOr404('unit', id), body.reason, expectedVersion(req));
  }
}
