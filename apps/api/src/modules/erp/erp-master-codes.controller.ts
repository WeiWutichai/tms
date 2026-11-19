import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { expectedVersion, setEtag } from '../../common/etag';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  LiveOnly,
  NoTransaction,
  RequireFeature,
  RequireScope,
  TenantResource,
} from '../../common/decorators';
import { decodeIdOr404 } from '../../common/ids';
import {
  ErpItemMappingDto,
  ErpItemMappingListDto,
  ErpMasterCodeListDto,
  ErpMasterCodeListQuery,
  ErpMasterSyncDto,
  ErpMasterSyncResultDto,
  SetErpItemMappingDto,
} from './erp-master-code.dto';
import { ErpMasterCodesService } from './erp-master-codes.service';

/**
 * ผังรหัส ERP + หน้า mapping "ค่าบริการ TMS ↔ รหัสสินค้า ERP" ต่อ connector (ST7-T18; docs/04 G3 "Sync master ลงมา", B; docs/01 §7.4)
 * อ่าน `settings:read` · ซิงก์/แก้ `settings:write` · ฟีเจอร์ `conn` · sandbox ใช้ไม่ได้ (ST7-T09 — ไม่แตะ connector จริง)
 * นำเข้าผังรหัสจากไฟล์ = `POST /v1/imports` kind `erp_master_code`
 */
@ApiTags('connectors')
@ApiBearerAuth()
@RequireFeature('conn')
@LiveOnly()
@Controller('connectors')
export class ErpMasterCodesController {
  constructor(private readonly svc: ErpMasterCodesService) {}

  @Get(':id/master-codes')
  @TenantResource('connector')
  @RequireScope('settings:read')
  @ApiOkResponse({
    type: ErpMasterCodeListDto,
    description:
      'ผังรหัสที่ระบบบัญชียอมรับ (หน่วย พนักงานขาย ผังบัญชี รหัสสินค้า/บริการ อัตรา VAT)',
  })
  async list(
    @Param('id') id: string,
    @Query() q: ErpMasterCodeListQuery,
  ): Promise<ErpMasterCodeListDto> {
    return { data: await this.svc.list(decodeIdOr404('connector', id), q) };
  }

  @Post(':id/master-codes/sync')
  @HttpCode(200)
  @NoTransaction()
  @TenantResource('connector')
  @RequireScope('settings:write')
  @ApiOkResponse({
    type: ErpMasterSyncResultDto,
    description:
      'ดึงผังรหัสจากระบบบัญชีผ่าน adapter (ทั้งชุดต่อชนิด — รหัสที่ไม่อยู่ในชุดถูกปิดใช้ ไม่ลบ) · ' +
      'adapter ดึงไม่ได้ → 409 `master_sync_not_supported` (นำเข้าไฟล์แทน) · ล้ม → 409 `master_sync_failed` ไม่เปลี่ยนอะไร · ' +
      'ยกเลิกการเชื่อมแล้ว → 409 `invalid_state_transition`',
  })
  sync(@Param('id') id: string, @Body() body: ErpMasterSyncDto): Promise<ErpMasterSyncResultDto> {
    return this.svc.sync(decodeIdOr404('connector', id), body);
  }

  @Get(':id/mappings')
  @TenantResource('connector')
  @RequireScope('settings:read')
  @ApiOkResponse({
    type: ErpItemMappingListDto,
    description:
      'ค่าบริการฝั่งขายทุกตัว + รหัสสินค้า ERP ที่จับคู่ · รายการที่ไม่ครบ (UNMAPPED/CODE_UNKNOWN) ทำให้เอกสารที่ใช้ส่งเข้า ERP ไม่ได้ ' +
      '(คำสั่ง push = FAILED_FINAL `VALIDATION` `erp_mapping_incomplete` — เอกสารยังออกได้)',
  })
  mappings(@Param('id') id: string): Promise<ErpItemMappingListDto> {
    return this.svc.mappings(decodeIdOr404('connector', id));
  }

  @Put(':id/mappings/:serviceItemId')
  @TenantResource('connector')
  @RequireScope('settings:write')
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description:
      'ETag/`version` จาก GET mappings (ยังไม่เคยตั้ง = "0") — ไม่ตรง → 412 · ไม่ส่ง = เขียนทับ',
  })
  @ApiOkResponse({
    type: ErpItemMappingDto,
    description:
      'ตั้ง/ยกเลิก (null) รหัสสินค้า ERP ของค่าบริการ 1 รายการ · มีผังรหัสสินค้าแล้วต้องเป็นรหัสที่ใช้งาน (422 `erp_code_unknown`) · audit `connector.mapping_changed`',
  })
  async setMapping(
    @Param('id') id: string,
    @Param('serviceItemId') serviceItemId: string,
    @Body() body: SetErpItemMappingDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ErpItemMappingDto> {
    const r = await this.svc.setMapping(
      decodeIdOr404('connector', id),
      serviceItemId,
      body,
      expectedVersion(req),
    );
    setEtag(res, r.version);
    return r;
  }
}
