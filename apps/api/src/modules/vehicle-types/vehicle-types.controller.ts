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
import type { Request, Response } from 'express';
import { AuditPageDto } from '../../audit/audit.controller';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { NextCodeDto } from '../customers/customer.dto';
import { sendExport, type ExportColumn } from '../master/export';
import { entityHistory, HistoryQuery } from '../master/history';
import { MasterOptionalReasonDto, MasterReasonDto } from '../master/master-kit';
import {
  CreateVehicleTypeDto,
  UpdateVehicleTypeDto,
  UpsertVehicleTypeDto,
  VehicleTypeDto,
  VehicleTypeExportQuery,
  VehicleTypeListQuery,
  VehicleTypePageDto,
  VehicleTypeSummaryDto,
  type LicenceClass,
  type VehicleCapability,
  type VehicleClass,
} from './vehicle-type.dto';
import { VehicleTypesService } from './vehicle-types.service';

const CLASS_TH: Record<VehicleClass, string> = {
  '4W': '4 ล้อ',
  '6W': '6 ล้อ',
  '10W': '10 ล้อ',
  TRAILER: 'พ่วง',
  SEMI_TRAILER: 'เทรลเลอร์',
};
const LICENCE_TH: Record<LicenceClass, string> = {
  PERSONAL: 'ส่วนบุคคล',
  T1: 'ท.1',
  T2: 'ท.2',
  T3: 'ท.3',
  T4: 'ท.4',
};
const TAG_TH: Record<VehicleCapability, string> = {
  REFRIGERATED: 'ห้องเย็น',
  CRANE: 'ติดเครน',
  CONTAINER: 'ลากตู้',
  HAZMAT: 'สินค้าอันตราย',
};

/** คอลัมน์ไฟล์ส่งออก — หัวคอลัมน์ไทยตรงกับ template นำเข้า (ST2-T23) */
const EXPORT_COLUMNS: ExportColumn<VehicleTypeDto>[] = [
  { header: 'รหัส', value: (r) => r.code },
  { header: 'ประเภทรถ', value: (r) => r.name },
  { header: 'ชั้นรถ', value: (r) => CLASS_TH[r.vehicleClass] },
  { header: 'น้ำหนักบรรทุก (กก.)', value: (r) => r.payloadKg },
  { header: 'ปริมาตร (ลบ.ม.)', value: (r) => r.volumeCbm },
  {
    header: 'ใบขับขี่ขั้นต่ำ',
    value: (r) => (r.minLicenceClass ? LICENCE_TH[r.minLicenceClass] : null),
  },
  { header: 'ความสามารถพิเศษ', value: (r) => r.capabilityTags.map((x) => TAG_TH[x]).join(', ') },
  { header: 'อุณหภูมิต่ำสุด (°C)', value: (r) => r.tempMinC },
  { header: 'อุณหภูมิสูงสุด (°C)', value: (r) => r.tempMaxC },
  { header: 'รถในระบบ', value: (r) => r.usage.vehicles },
  { header: 'ใช้ใน rate card', value: (r) => r.usage.rateCards },
  { header: 'รหัสในระบบต้นทาง', value: (r) => r.externalId },
  { header: 'สถานะ', value: (r) => (r.status === 'active' ? 'ใช้งาน' : 'ปิดใช้') },
];

/**
 * ประเภทรถ (ST2-T04; spec/02 §4, docs/04 B รถ) — CRUD + `PUT /external/{id}` + export + ประวัติ (กฎร่วมทุก master)
 * สิทธิ์: อ่าน `master:read` · แก้/ปิดใช้/ลบ `master:write` · ส่งออก `export:run`
 * tenant ใหม่ได้ชุดภาษาไทยจาก bootstrap (ขั้น `vehicle-types`)
 */
@ApiTags('vehicle-types')
@ApiBearerAuth()
@Controller('vehicle-types')
export class VehicleTypesController {
  constructor(
    private readonly types: VehicleTypesService,
    private readonly db: DbService,
  ) {}

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.types.getByExternalId(id.slice(4));
    return this.types.get(decodeIdOr404('vehicleType', id));
  }

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: VehicleTypePageDto })
  list(@Query() q: VehicleTypeListQuery) {
    return this.types.list(q);
  }

  @Get('summary')
  @RequireScope('master:read')
  @ApiOkResponse({ type: VehicleTypeSummaryDto })
  summary(): Promise<VehicleTypeSummaryDto> {
    return this.types.summary();
  }

  @Get('next-code')
  @RequireScope('master:write')
  @ApiOkResponse({ type: NextCodeDto, description: 'รหัสที่ระบบจะออกให้ประเภทรถใหม่ (`VT-0001`)' })
  async nextCode(): Promise<NextCodeDto> {
    return { code: await this.types.nextCode() };
  }

  @Get('export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description: 'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว)',
  })
  async export(
    @Query() q: VehicleTypeExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.types.exportRows(q);
    return sendExport(res, q.format ?? 'xlsx', 'vehicle-types', EXPORT_COLUMNS, rows);
  }

  @Post()
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: VehicleTypeDto })
  async create(
    @Body() body: CreateVehicleTypeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleTypeDto> {
    const v = await this.types.create(body);
    setEtag(res, v.version);
    return this.types.dto(v);
  }

  @Put('external/:externalId')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว' })
  @ApiOkResponse({
    type: VehicleTypeDto,
    description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่)',
  })
  @ApiCreatedResponse({ type: VehicleTypeDto, description: 'ยังไม่มี → สร้าง' })
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertVehicleTypeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleTypeDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const { row, created } = await this.types.upsertExternal(
      externalId,
      body,
      expectedVersion(req),
    );
    res.status(created ? 201 : 200);
    setEtag(res, row.version);
    return this.types.dto(row);
  }

  @Get(':id')
  @TenantResource('vehicleType')
  @RequireScope('master:read')
  @ApiOkResponse({ type: VehicleTypeDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleTypeDto> {
    const v = await this.resolve(id);
    setEtag(res, v.version);
    return this.types.dto(v);
  }

  @Get(':id/history')
  @TenantResource('vehicleType')
  @RequireScope('master:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติการแก้จาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const v = await this.resolve(id);
    return entityHistory(this.db.tx, 'vehicle_type', v.id, q);
  }

  @Patch(':id')
  @TenantResource('vehicleType')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: VehicleTypeDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateVehicleTypeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleTypeDto> {
    const current = await this.resolve(id);
    const v = await this.types.update(current.id, body, expectedVersion(req));
    setEtag(res, v.version);
    return this.types.dto(v);
  }

  /** ปิดใช้ (เหตุผล ≥ 10) — ยังมีรถในทะเบียนที่ใช้ประเภทนี้ → 409 `in_use` (MD-094) */
  @Post(':id/deactivate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('vehicleType')
  @RequireScope('master:write')
  @ApiOkResponse({ type: VehicleTypeDto })
  async deactivate(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleTypeDto> {
    const current = await this.resolve(id);
    const v = await this.types.changeStatus(
      current.id,
      'deactivate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, v.version);
    return this.types.dto(v);
  }

  @Post(':id/activate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('vehicleType')
  @RequireScope('master:write')
  @ApiOkResponse({ type: VehicleTypeDto })
  async activate(
    @Param('id') id: string,
    @Body() body: MasterOptionalReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleTypeDto> {
    const current = await this.resolve(id);
    const v = await this.types.changeStatus(
      current.id,
      'activate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, v.version);
    return this.types.dto(v);
  }

  /** "ลบ" (MD-004) — เฉพาะที่ไม่เคยถูกอ้างอิง (รถ/rate card/SO) → soft delete; ถูกอ้างอิง → 409 `in_use` */
  @Post(':id/delete')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(204)
  @TenantResource('vehicleType')
  @RequireScope('master:write')
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    const current = await this.resolve(id);
    await this.types.remove(current.id, body.reason, expectedVersion(req));
  }
}
