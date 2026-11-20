import { Body, Controller, Get, Param, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { expectedVersion, setEtag } from '../../common/etag';
import { LiveOnly, RequireFeature, RequireScope, TenantResource } from '../../common/decorators';
import { encodeId } from '../../common/ids';
import { ApiProblems } from '../../common/problem.dto';
import {
  CustomerErpCodeDto,
  CustomerErpCodeListDto,
  SetCustomerErpCodeDto,
} from './customer-erp-code.dto';
import { type CustomerErpCodeView, ExternalMappingService } from './external-mapping.service';

const prob = (
  code: string,
  status: number,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title,
  status,
  code,
  ...extra,
});
const E409_ERP = {
  status: 409,
  description:
    '`external_id_conflict` — รหัสนี้ผูกกับลูกค้าอื่นแล้วใน connector เดียวกัน · `invalid_state_transition` — connector ยกเลิกการเชื่อมแล้ว',
  examples: {
    external_id_conflict: prob('external_id_conflict', 409, 'รหัสนี้ผูกกับข้อมูลอื่นแล้ว', {
      errors: [{ field: 'externalId', code: 'duplicate', message: 'รหัสนี้ผูกกับลูกค้าอื่นแล้ว' }],
      mappedCustomerId: 'cus_3f2a…',
    }),
    invalid_state_transition: prob(
      'invalid_state_transition',
      409,
      'ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน',
    ),
  },
};
const E412_ERP = {
  status: 412,
  description: '`precondition_failed` — If-Match ไม่ตรง `version` ปัจจุบัน',
  examples: { precondition_failed: prob('precondition_failed', 412, 'ข้อมูลถูกแก้ไขโดยผู้อื่น') },
};
const E422_ERP = {
  status: 422,
  description:
    '`validation_failed` — รหัสผิดรูปแบบ (`externalId` invalid_format) หรือเปลี่ยน/ยกเลิกรหัสที่ตั้งไว้แล้วโดยไม่มีเหตุผล (`reason` required)',
  examples: {
    validation_failed: prob('validation_failed', 422, 'ข้อมูลไม่ถูกต้อง', {
      errors: [
        {
          field: 'reason',
          code: 'required',
          message: 'เปลี่ยนหรือยกเลิกรหัสที่ตั้งไว้แล้วต้องระบุเหตุผลอย่างน้อย 10 ตัวอักษร',
        },
      ],
    }),
  },
};

/**
 * รหัสลูกค้าในระบบบัญชีที่เชื่อมต่อ (ST8-T05; docs/01 §3.7 external_mapping CUSTOMER, A.4; ต้นแบบ TMS v4 drawer ลูกค้า แท็บ "รหัสระบบบัญชี")
 * อ่าน `master:read` · แก้ `settings:write` (ค่าตั้งระบบบัญชี — แบบเดียวกับ mapping ค่าบริการ ST7-T18) · ฟีเจอร์ `conn` · sandbox ใช้ไม่ได้ (ไม่มี connector — ST7-T09)
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
  // รหัสลูกค้าในระบบบัญชี = ค่าตั้งการเชื่อมต่อระบบบัญชี (สิทธิ์เดียวกับ mapping ค่าบริการ ST7-T18 — review M1)
  @RequireScope('settings:write')
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: '`version` จาก GET (ยังไม่เคยตั้ง = "0") — ไม่ตรง → 412 · ไม่ส่ง = เขียนทับ',
  })
  @ApiOkResponse({
    type: CustomerErpCodeDto,
    description:
      'ตั้ง/ยกเลิก (null) รหัสลูกค้าในระบบบัญชีของ connector 1 ตัว (คนกรอก — ระบบไม่เดา) · เปลี่ยน/ยกเลิกรหัสที่ตั้งไว้แล้วต้องมี `reason` (422) · ' +
      'รหัสผูกกับลูกค้าอื่น → 409 `external_id_conflict` · connector ยกเลิกแล้ว → 409 `invalid_state_transition` · audit `external_mapping.changed`',
  })
  @ApiProblems(E409_ERP, E412_ERP, E422_ERP)
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
