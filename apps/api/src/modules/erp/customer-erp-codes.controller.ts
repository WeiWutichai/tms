import { Body, Controller, Get, Param, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { expectedVersion, setEtag } from '../../common/etag';
import { LiveOnly, RequireFeature, RequireScope, TenantResource } from '../../common/decorators';
import { encodeId } from '../../common/ids';
import {
  CustomerErpCodeDto,
  CustomerErpCodeListDto,
  SetCustomerErpCodeDto,
} from './customer-erp-code.dto';
import { type CustomerErpCodeView, ExternalMappingService } from './external-mapping.service';

/**
 * รหัสลูกค้าในระบบบัญชีที่เชื่อมต่อ (ST8-T05; docs/01 §3.7 external_mapping CUSTOMER, A.4; ต้นแบบ TMS v4 drawer ลูกค้า แท็บ "รหัสระบบบัญชี")
 * อ่าน `master:read` · แก้ `master:write` · ฟีเจอร์ `conn` · sandbox ใช้ไม่ได้ (ไม่มี connector — ST7-T09)
 */
@ApiTags('customers')
@ApiBearerAuth()
@RequireFeature('conn')
@LiveOnly()
@Controller('customers')
export class CustomerErpCodesController {
  constructor(private readonly svc: ExternalMappingService) {}

  @Get(':id/erp-codes')
  @TenantResource('customer')
  @RequireScope('master:read')
  @ApiOkResponse({
    type: CustomerErpCodeListDto,
    description:
      'รหัสลูกค้านี้ในระบบบัญชีแต่ละตัวที่เชื่อมต่อ (connector ที่ยังไม่ยกเลิก) — ยังไม่ map = ใบแจ้งหนี้ของลูกค้านี้ส่งเข้าระบบบัญชีนั้นไม่ได้',
  })
  async list(@Param('id') id: string): Promise<CustomerErpCodeListDto> {
    return { data: (await this.svc.listForCustomer(id)).map(dto) };
  }

  @Put(':id/erp-codes/:connectorId')
  @TenantResource('customer')
  @RequireScope('master:write')
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: '`version` จาก GET (ยังไม่เคยตั้ง = "0") — ไม่ตรง → 412 · ไม่ส่ง = เขียนทับ',
  })
  @ApiOkResponse({
    type: CustomerErpCodeDto,
    description:
      'ตั้ง/ยกเลิก (null) รหัสลูกค้าในระบบบัญชีของ connector 1 ตัว · ยังไม่มีรหัสต้นทาง → adapter เดาให้ (เช่น KRS ใช้รหัสเดียวกัน) · ' +
      'รหัสผูกกับลูกค้าอื่น → 409 `external_id_conflict` · connector ยกเลิกแล้ว → 409 `invalid_state_transition` · audit `external_mapping.changed`',
  })
  async set(
    @Param('id') id: string,
    @Param('connectorId') connectorId: string,
    @Body() body: SetCustomerErpCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerErpCodeDto> {
    const r = dto(await this.svc.setForCustomer(id, connectorId, body, expectedVersion(req)));
    setEtag(res, r.version);
    return r;
  }
}

function dto(v: CustomerErpCodeView): CustomerErpCodeDto {
  return {
    connector: {
      id: encodeId('connector', v.connector.id),
      adapterKey: v.connector.adapterKey,
      displayName: v.displayName,
      status: v.connector.status,
    },
    externalId: v.row?.externalId ?? null,
    sourceCode: v.row?.sourceCode ?? null,
    status: v.row?.status ?? 'UNMAPPED',
    updatedAt: v.row?.updatedAt.toISOString() ?? null,
    version: v.row?.version ?? 0,
  };
}
