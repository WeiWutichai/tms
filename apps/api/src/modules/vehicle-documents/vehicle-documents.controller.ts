import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import { VehiclesService, type VehicleFull } from '../vehicles/vehicles.service';
import {
  CancelVehicleDocumentDto,
  CreateVehicleDocumentDto,
  RenewVehicleDocumentDto,
  VehicleDocumentDto,
  VehicleDocumentListDto,
  VehicleDocumentListQuery,
  VehicleDocumentPageDto,
  VehicleDocumentRenewResultDto,
} from './vehicle-document.dto';
import { VehicleDocumentsService } from './vehicle-documents.service';

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

  @Get('vehicle-documents')
  @RequireScope('master:read')
  @ApiOkResponse({
    type: VehicleDocumentPageDto,
    description: 'เอกสารรถทั้งหมด เรียงวันหมดใกล้สุดก่อน — กรองประเภท/สถานะ/หมดภายใน N วัน/ทะเบียน',
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
