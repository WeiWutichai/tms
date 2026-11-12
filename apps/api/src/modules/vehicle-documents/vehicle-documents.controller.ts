import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import { sendExport, type ExportColumn } from '../master/export';
import { provinceAbbr } from '../vehicles/provinces';
import { VehiclesService, type VehicleFull } from '../vehicles/vehicles.service';
import {
  CancelVehicleDocumentDto,
  CreateVehicleDocumentDto,
  RenewVehicleDocumentDto,
  VehicleDocumentDto,
  VehicleDocumentExportQuery,
  VehicleDocumentListDto,
  VehicleDocumentListQuery,
  VehicleDocumentPageDto,
  VehicleDocumentRenewResultDto,
  VehicleDocumentSummaryDto,
  type VehicleDocTypeKey,
} from './vehicle-document.dto';
import { VehicleDocumentsService } from './vehicle-documents.service';

const TYPE_TH: Record<VehicleDocTypeKey, string> = {
  INSURANCE: 'ประกันภัย',
  COMPULSORY_ACT: 'พ.ร.บ.',
  ANNUAL_TAX: 'ภาษี',
  INSPECTION: 'ตรวจสภาพ ตรอ.',
  TRANSPORT_LICENSE: 'ใบอนุญาตขนส่ง',
  GPS_DLT_CERT: 'GPS DLT',
  OTHER: 'อื่น ๆ',
};
/** สถานะในไฟล์ = ป้ายของหน้าเอกสารรถรวม (ต้นแบบ specFDoc: หมดอายุ / ใกล้หมดอายุ ≤ 30 วัน / ปกติ) */
function statusTh(d: VehicleDocumentDto): string {
  if (d.status === 'superseded') return 'ต่ออายุแล้ว';
  if (d.status === 'cancelled') return 'ยกเลิก';
  if (d.daysToExpiry < 0) return 'หมดอายุ';
  return d.daysToExpiry <= 30 ? 'ใกล้หมดอายุ' : 'ปกติ';
}

/** คอลัมน์ไฟล์ส่งออก — ลำดับตามตารางหน้าเอกสารรถรวม (ต้นแบบ specFDoc) */
const EXPORT_COLUMNS: ExportColumn<VehicleDocumentDto>[] = [
  { header: 'ทะเบียน', value: (r) => r.vehicle.plate },
  { header: 'จังหวัด', value: (r) => provinceAbbr(r.vehicle.plateProvince) },
  { header: 'เจ้าของ', value: (r) => (r.vehicle.ownership === 'OWN' ? 'บริษัท' : 'รถร่วม') },
  { header: 'ประเภทเอกสาร', value: (r) => TYPE_TH[r.docType] },
  { header: 'ชื่อเอกสาร', value: (r) => r.title },
  { header: 'เลขที่', value: (r) => r.docNo },
  { header: 'บริษัท / หน่วยงาน', value: (r) => r.issuer },
  { header: 'เริ่ม', value: (r) => r.startsOn },
  { header: 'หมดอายุ', value: (r) => r.expiresOn },
  { header: 'เบี้ย / ค่าใช้จ่าย (฿)', value: (r) => r.costAmount ?? r.premiumAmount },
  { header: 'ไฟล์แนบ', value: (r) => r.files.map((f) => f.filename ?? f.id).join(', ') || null },
  { header: 'วันคงเหลือ', value: (r) => r.daysToExpiry },
  { header: 'สถานะ', value: statusTh },
];

/**
 * เอกสารรถ (ST2-T17; docs/04 B2.1 ส่วน 2, docs/01 §3.8, spec/06 FLT-C)
 * สิทธิ์: อ่าน `master:read` · เพิ่ม/ต่ออายุ/ยกเลิก `master:write` (docs/04 A3 "Master data") — แนบไฟล์ผ่าน /v1/documents (`documents:write`)
 * เบี้ย/ค่าใช้จ่ายของเอกสารเห็นได้ด้วย master:read (ไม่ใช่ `vehicle.finance.view` ของ spec/06 FLT-A ซึ่งครอบราคาซื้อ/ค่าเสื่อม/กำไร)
 */
@ApiTags('vehicle-documents')
@ApiBearerAuth()
@Controller()
export class VehicleDocumentsController {
  constructor(
    private readonly docs: VehicleDocumentsService,
    private readonly vehicles: VehiclesService,
  ) {}

  private vehicle(id: string): Promise<VehicleFull> {
    if (id.startsWith('ext:')) return this.vehicles.getByExternalId(id.slice(4));
    return this.vehicles.get(decodeIdOr404('vehicle', id));
  }

  private async one(id: string): Promise<VehicleDocumentDto> {
    const [dto] = await this.docs.toDtos([await this.docs.get(id)]);
    return dto!;
  }

  @Get('vehicles/:id/documents')
  @TenantResource('vehicle')
  @RequireScope('master:read')
  @ApiOkResponse({
    type: VehicleDocumentListDto,
    description: 'เอกสารทั้งหมดของรถคันนี้ — ฉบับปัจจุบันและประวัติ (superseded/cancelled)',
  })
  async listForVehicle(@Param('id') id: string): Promise<VehicleDocumentListDto> {
    const v = await this.vehicle(id);
    return { data: await this.docs.listForVehicle(v.id) };
  }

  @Post('vehicles/:id/documents')
  @TenantResource('vehicle')
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({
    type: VehicleDocumentDto,
    description:
      'เพิ่มเอกสาร — มีฉบับปัจจุบันประเภทเดียวกันอยู่แล้ว → 409 `current_exists` (ใช้ต่ออายุ) · รถปลดระวาง → 409',
  })
  async create(
    @Param('id') id: string,
    @Body() body: CreateVehicleDocumentDto,
  ): Promise<VehicleDocumentDto> {
    const v = await this.vehicle(id);
    const row = await this.docs.create(v, body);
    return (await this.docs.toDtos([row]))[0]!;
  }

  /** ตัวนับหน้าเอกสารรถรวม (ST2-T19) — ประกาศก่อน `vehicle-documents/:id` */
  @Get('vehicle-documents/summary')
  @RequireScope('master:read')
  @ApiOkResponse({ type: VehicleDocumentSummaryDto })
  summary(): Promise<VehicleDocumentSummaryDto> {
    return this.docs.summary();
  }

  /** ส่งออก (ST2-T19 "ส่งออกให้ฝ่ายธุรการ") — `export:run` เหมือน master อื่น */
  @Get('vehicle-documents/export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description:
      'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ หรือเฉพาะ `ids` (≤ 200; สูงสุด 10,000 แถว) — CSV กันสูตร · header `X-Export-Rows` = จำนวนแถวในไฟล์',
  })
  async export(
    @Query() q: VehicleDocumentExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.docs.exportRows(q);
    // จำนวนแถวจริงในไฟล์ (แถวที่เลือกแต่ถูกต่ออายุ/ยกเลิกไปแล้วจะไม่อยู่) — หน้าเว็บใช้แสดงข้อความ
    res.setHeader('X-Export-Rows', String(rows.length));
    return sendExport(res, q.format ?? 'xlsx', 'vehicle-documents', EXPORT_COLUMNS, rows);
  }

  @Get('vehicle-documents')
  @RequireScope('master:read')
  @ApiOkResponse({
    type: VehicleDocumentPageDto,
    description:
      'เอกสารรถทั้งหมด (หน้าเอกสารรถรวม ST2-T19) เรียงวันหมดใกล้สุดก่อน — กรองประเภท/สถานะ/หมดภายใน N วัน/หลัง N วัน/ทะเบียน/รถ · ไม่รวมรถปลดระวาง (เว้นแต่ includeRetired=true)',
  })
  list(@Query() q: VehicleDocumentListQuery): Promise<VehicleDocumentPageDto> {
    return this.docs.list(q);
  }

  @Get('vehicle-documents/:id')
  @TenantResource('vehicleDocument')
  @RequireScope('master:read')
  @ApiOkResponse({ type: VehicleDocumentDto })
  get(@Param('id') id: string): Promise<VehicleDocumentDto> {
    return this.one(decodeIdOr404('vehicleDocument', id));
  }

  /** ต่ออายุ (FLT-043) — ฉบับใหม่อ้างฉบับเดิม; ฉบับเดิมยังอยู่ในประวัติเป็น superseded */
  @Post('vehicle-documents/:id/renew')
  @TenantResource('vehicleDocument')
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: VehicleDocumentRenewResultDto })
  async renew(
    @Param('id') id: string,
    @Body() body: RenewVehicleDocumentDto,
  ): Promise<VehicleDocumentRenewResultDto> {
    const r = await this.docs.renew(decodeIdOr404('vehicleDocument', id), body);
    const [document, previous] = await this.docs.toDtos([r.document, r.previous]);
    return { document: document!, previous: previous! };
  }

  /** ยกเลิกเอกสารที่บันทึกผิด — เหตุผล ≥ 10 ตัวอักษร ลง audit; ไม่ลบแถว */
  @Post('vehicle-documents/:id/cancel')
  @HttpCode(200)
  @TenantResource('vehicleDocument')
  @RequireScope('master:write')
  @ApiOkResponse({ type: VehicleDocumentDto })
  async cancel(
    @Param('id') id: string,
    @Body() body: CancelVehicleDocumentDto,
  ): Promise<VehicleDocumentDto> {
    const row = await this.docs.cancel(decodeIdOr404('vehicleDocument', id), body.reason);
    return (await this.docs.toDtos([row]))[0]!;
  }
}
