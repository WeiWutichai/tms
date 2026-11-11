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
import { sendExport, type ExportColumn } from '../master/export';
import { entityHistory, HistoryQuery } from '../master/history';
import { MasterReasonDto } from '../master/master-kit';
import { provinceAbbr } from './provinces';
import {
  CreateVehicleDto,
  OdometerCorrectionInput,
  OdometerListQuery,
  OdometerPageDto,
  OdometerResultDto,
  OdometerReadingInput,
  UpdateVehicleDto,
  UpsertVehicleDto,
  VehicleDto,
  VehicleExportQuery,
  VehicleListQuery,
  VehiclePageDto,
  VehicleStatusDto,
  VehicleSummaryDto,
  type FuelType,
  type VehicleStatusKey,
} from './vehicle.dto';
import {
  canSeeFinance,
  FINANCE_AUDIT_KEYS,
  toVehicleDto,
  VehiclesService,
  type VehicleFull,
} from './vehicles.service';

const STATUS_TH: Record<VehicleStatusKey, string> = {
  ready: 'พร้อมใช้',
  maintenance: 'ซ่อม',
  parked: 'จอด',
  retired: 'ปลดระวาง',
};
const ROLE_TH = { SINGLE: 'รถเดี่ยว', TRACTOR: 'หัวลาก', TRAILER: 'หาง' } as const;
const FUEL_TH: Record<FuelType, string> = {
  DIESEL: 'ดีเซล',
  GASOLINE: 'เบนซิน',
  NGV: 'NGV',
  LPG: 'LPG',
  EV: 'ไฟฟ้า',
  HYBRID: 'ไฮบริด',
};
const plateText = (p: string, prov: string) => `${p} ${provinceAbbr(prov)}`;

/** คอลัมน์ไฟล์ส่งออก — หัวคอลัมน์ไทยตรงกับ template นำเข้า (ST2-T23) · ข้อมูลการเงินเฉพาะผู้มีสิทธิ์ */
function exportColumns(finance: boolean): ExportColumn<VehicleDto>[] {
  return [
    { header: 'ทะเบียน', value: (r) => r.plate },
    { header: 'จังหวัด', value: (r) => provinceAbbr(r.plateProvince) },
    { header: 'ประเภทรถ', value: (r) => r.vehicleType.name },
    { header: 'บทบาท', value: (r) => ROLE_TH[r.unitRole] },
    {
      header: 'จับคู่กับ',
      value: (r) => (r.paired ? plateText(r.paired.plate, r.paired.plateProvince) : null),
    },
    { header: 'เจ้าของ', value: (r) => (r.ownership === 'OWN' ? 'บริษัท' : 'รถร่วม') },
    { header: 'ผู้รับเหมา', value: (r) => r.carrier?.name ?? null },
    { header: 'ยี่ห้อ', value: (r) => r.brand },
    { header: 'รุ่น', value: (r) => r.model },
    { header: 'ปีผลิต', value: (r) => r.year },
    { header: 'สี', value: (r) => r.color },
    { header: 'เลขตัวถัง', value: (r) => r.chassisNo },
    { header: 'เลขเครื่องยนต์', value: (r) => r.engineNo },
    { header: 'น้ำหนักบรรทุก (กก.)', value: (r) => r.payloadKg },
    { header: 'ปริมาตร (ลบ.ม.)', value: (r) => r.volumeCbm },
    { header: 'น้ำหนักรถเปล่า (กก.)', value: (r) => r.tareWeightKg },
    { header: 'น้ำหนักรวม (กก.)', value: (r) => r.grossWeightKg },
    { header: 'เชื้อเพลิง', value: (r) => (r.fuelType ? FUEL_TH[r.fuelType] : null) },
    { header: 'ความจุถัง (ลิตร)', value: (r) => r.tankCapacityL },
    { header: 'เลขไมล์ (กม.)', value: (r) => r.odometerKm },
    { header: 'GPS', value: (r) => r.gpsProvider },
    { header: 'เลขอุปกรณ์ GPS', value: (r) => r.gpsDeviceId },
    ...(finance
      ? ([
          { header: 'วันที่ซื้อ', value: (r) => r.purchasedOn ?? null },
          { header: 'ราคาซื้อ', value: (r) => r.purchaseCost ?? null },
          { header: 'ค่าเสื่อม (ปี)', value: (r) => r.depreciationYears ?? null },
          { header: 'มูลค่าซาก', value: (r) => r.salvageValue ?? null },
        ] as ExportColumn<VehicleDto>[])
      : []),
    { header: 'รหัสในระบบต้นทาง', value: (r) => r.externalId },
    { header: 'สถานะ', value: (r) => STATUS_TH[r.status] },
  ];
}

/**
 * รถ (ST2-T06; docs/04 B รถ + B2.1 ส่วน 1, docs/01 §3.2/§3.8, spec/06 FLT-A/FLT-O)
 * CRUD + `PUT /external/{id}` + export + ประวัติ (กฎร่วมทุก master) + สถานะ + เลขไมล์
 * สิทธิ์: อ่าน `master:read` · แก้/เปลี่ยนสถานะ/ลบ/เลขไมล์ `master:write` · ส่งออก `export:run`
 * ข้อมูลการเงินรถ (ราคาซื้อ/ค่าเสื่อม) เห็น/แก้เฉพาะ `reports.finance:read`
 */
@ApiTags('vehicles')
@ApiBearerAuth()
@Controller('vehicles')
export class VehiclesController {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly db: DbService,
  ) {}

  private async resolve(id: string): Promise<VehicleFull> {
    if (id.startsWith('ext:')) return this.vehicles.getByExternalId(id.slice(4));
    return this.vehicles.get(decodeIdOr404('vehicle', id));
  }

  private send(res: Response, v: VehicleFull): VehicleDto {
    setEtag(res, v.version);
    return toVehicleDto(v);
  }

  /** ผลการสร้าง + สัญญาณโควตา (soft limit PLT-080): `quotaExceeded` + header `Warning: 299` */
  private async created(res: Response, v: VehicleFull): Promise<VehicleDto> {
    const over = await this.vehicles.quotaExceeded();
    if (over) res.setHeader('Warning', '299 tms "vehicle quota exceeded"');
    return { ...this.send(res, v), quotaExceeded: over };
  }

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: VehiclePageDto })
  list(@Query() q: VehicleListQuery) {
    return this.vehicles.list(q);
  }

  @Get('summary')
  @RequireScope('master:read')
  @ApiOkResponse({ type: VehicleSummaryDto })
  summary(): Promise<VehicleSummaryDto> {
    return this.vehicles.summary();
  }

  @Get('export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description: 'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว)',
  })
  async export(
    @Query() q: VehicleExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.vehicles.exportRows(q);
    return sendExport(res, q.format ?? 'xlsx', 'vehicles', exportColumns(canSeeFinance()), rows);
  }

  @Post()
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({
    type: VehicleDto,
    description:
      'สร้างแล้ว — เกินโควตารถ: `quotaExceeded: true` + header `Warning: 299` (ยังสร้างได้)',
  })
  async create(
    @Body() body: CreateVehicleDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleDto> {
    return this.created(res, await this.vehicles.create(body));
  }

  @Put('external/:externalId')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว' })
  @ApiOkResponse({
    type: VehicleDto,
    description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่)',
  })
  @ApiCreatedResponse({ type: VehicleDto, description: 'ยังไม่มี → สร้าง' })
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertVehicleDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const { row, created } = await this.vehicles.upsertExternal(
      externalId,
      body,
      expectedVersion(req),
    );
    res.status(created ? 201 : 200);
    return created ? this.created(res, row) : this.send(res, row);
  }

  @Get(':id')
  @TenantResource('vehicle')
  @RequireScope('master:read')
  @ApiOkResponse({ type: VehicleDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleDto> {
    return this.send(res, await this.resolve(id));
  }

  /** ประวัติการแก้ (audit) รวมเอกสารรถของคัน — ราคาซื้อ/ค่าเสื่อมถูกตัดออกถ้าไม่มี reports.finance:read */
  @Get(':id/history')
  @TenantResource('vehicle')
  @RequireScope('master:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติการแก้จาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const v = await this.resolve(id);
    // รวมประวัติเอกสารรถของคันนี้ (เพิ่ม/ต่ออายุ/ยกเลิก — ST2-T17)
    const docs = await this.db.tx.vehicleDocument.findMany({
      where: { vehicleId: v.id },
      select: { id: true },
    });
    const page = (await entityHistory(this.db.tx, 'vehicle', v.id, q, {
      entityType: 'vehicle_document',
      ids: docs.map((d) => d.id),
    })) as AuditPageDto;
    if (canSeeFinance()) return page;
    const strip = (o: unknown) => {
      if (!o || typeof o !== 'object') return o;
      const c = { ...(o as Record<string, unknown>) };
      for (const k of FINANCE_AUDIT_KEYS) delete c[k];
      return c;
    };
    return {
      ...page,
      // แก้เฉพาะข้อมูลการเงิน → ผู้ไม่มีสิทธิ์ไม่เห็นแถวนั้นเลย
      data: page.data
        .map((r) => ({ ...r, before: strip(r.before), after: strip(r.after) }) as typeof r)
        .filter(
          (r) =>
            r.action !== 'vehicle.updated' ||
            Object.keys((r.after as object | null) ?? {}).length > 0 ||
            Object.keys((r.before as object | null) ?? {}).length > 0,
        ),
    };
  }

  @Patch(':id')
  @TenantResource('vehicle')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: VehicleDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateVehicleDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleDto> {
    const current = await this.resolve(id);
    return this.send(res, await this.vehicles.update(current.id, body, expectedVersion(req)));
  }

  /** เปลี่ยนสถานะ พร้อมใช้ / ซ่อม / จอด / ปลดระวาง (เหตุผล ≥ 10) — transition ที่ไม่อนุญาต → 409 */
  @Post(':id/status')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('vehicle')
  @RequireScope('master:write')
  @ApiOkResponse({ type: VehicleDto })
  async status(
    @Param('id') id: string,
    @Body() body: VehicleStatusDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleDto> {
    const current = await this.resolve(id);
    return this.send(
      res,
      await this.vehicles.changeStatus(current.id, body.status, body.reason, expectedVersion(req)),
    );
  }

  /** "ลบ" (FLT-008) — เฉพาะรถที่ไม่เคยถูกอ้างอิง → soft delete; ถูกอ้างอิง → 409 `in_use` (ปลดระวางแทน) */
  @Post(':id/delete')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(204)
  @TenantResource('vehicle')
  @RequireScope('master:write')
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    const current = await this.resolve(id);
    await this.vehicles.remove(current.id, body.reason, expectedVersion(req));
  }

  @Get(':id/odometer')
  @TenantResource('vehicle')
  @RequireScope('master:read')
  @ApiOkResponse({
    type: OdometerPageDto,
    description: 'ประวัติเลขไมล์ ใหม่สุดก่อน (spec/06 FLT-O)',
  })
  async readings(@Param('id') id: string, @Query() q: OdometerListQuery): Promise<OdometerPageDto> {
    const v = await this.resolve(id);
    return { data: await this.vehicles.readings(v.id, q.limit ?? 50) };
  }

  /** บันทึกเลขไมล์ — น้อยกว่าค่าก่อนหน้า → 422 `odometer_backwards` */
  @Post(':id/odometer')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag ของรถ — ไม่ตรง → 412' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @TenantResource('vehicle')
  @RequireScope('master:write')
  @ApiCreatedResponse({ type: OdometerResultDto })
  async record(
    @Param('id') id: string,
    @Body() body: OdometerReadingInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OdometerResultDto> {
    const current = await this.resolve(id);
    const r = await this.vehicles.record(current.id, body, expectedVersion(req));
    return { reading: r.reading, vehicle: this.send(res, r.vehicle) };
  }

  /** แก้เลขไมล์ที่ผิด (ค่าน้อยกว่าได้) — ชนิดเหตุผล + คำอธิบาย ≥ 10 ตัวอักษร ลง audit (FLT-285) */
  @Post(':id/odometer/correct')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag ของรถ — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('vehicle')
  @RequireScope('master:write')
  @ApiOkResponse({ type: OdometerResultDto })
  async correct(
    @Param('id') id: string,
    @Body() body: OdometerCorrectionInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OdometerResultDto> {
    const current = await this.resolve(id);
    const r = await this.vehicles.correct(current.id, body, expectedVersion(req));
    return { reading: r.reading, vehicle: this.send(res, r.vehicle) };
  }
}
