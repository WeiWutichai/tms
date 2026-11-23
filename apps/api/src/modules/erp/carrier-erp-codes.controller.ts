import { Body, Controller, Get, Param, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { expectedVersion, setEtag } from '../../common/etag';
import {
  RequireFeature,
  RequireScope,
  SandboxAware,
  TenantResource,
} from '../../common/decorators';
import { encodeId } from '../../common/ids';
import { ApiProblems } from '../../common/problem.dto';
import {
  CarrierErpCodeDto,
  CarrierErpCodeListDto,
  SetCarrierErpCodeDto,
} from './carrier-erp-code.dto';
import { ExternalMappingService, type PartyErpCodeView } from './external-mapping.service';

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
    '`external_id_conflict` — รหัสนี้ผูกกับรถร่วมอื่นแล้วใน connector เดียวกัน · `invalid_state_transition` — connector ยกเลิกการเชื่อมแล้ว',
  examples: {
    external_id_conflict: prob('external_id_conflict', 409, 'รหัสนี้ผูกกับข้อมูลอื่นแล้ว', {
      errors: [{ field: 'externalId', code: 'duplicate', message: 'รหัสนี้ผูกกับรถร่วมอื่นแล้ว' }],
      mappedCarrierId: 'car_3f2a…',
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
 * รหัสรถร่วม (ผู้ขาย/เจ้าหนี้) ในระบบบัญชีที่เชื่อมต่อ (ST7-T15; docs/01 §3.7 external_mapping CARRIER, §7.3–7.4) — ไม่ผูก ERP ใด
 * อ่าน `master:read` · แก้ `settings:write` (ค่าตั้งระบบบัญชี — แบบเดียวกับรหัสลูกค้า ST8-T05) · ฟีเจอร์ `conn` · sandbox ใช้ได้กับ DemoProvider เท่านั้น (D-81 · D68-58)
 * ต้นแบบยังไม่มีหน้าจอของส่วนนี้ (drawer รถร่วมไม่มีแท็บ "รหัสระบบบัญชี") — API อย่างเดียว (spec/12 §3 [OPEN])
 */
@ApiTags('carriers')
@ApiBearerAuth()
@SandboxAware()
@RequireFeature('conn')
@Controller('carriers')
export class CarrierErpCodesController {
  constructor(private readonly svc: ExternalMappingService) {}

  @Get(':id/erp-codes')
  @TenantResource('carrier')
  @RequireScope('master:read')
  @ApiOkResponse({
    type: CarrierErpCodeListDto,
    description:
      'รหัสรถร่วมนี้ในระบบบัญชีแต่ละตัวที่เชื่อมต่อ (connector ที่ยังไม่ยกเลิก) — ใช้เป็น `carrier.externalId` ตอนส่งใบสำคัญจ่าย',
  })
  async list(@Param('id') id: string): Promise<CarrierErpCodeListDto> {
    return { data: (await this.svc.listForCarrier(id)).map(dto) };
  }

  @Put(':id/erp-codes/:connectorId')
  @TenantResource('carrier')
  @RequireScope('settings:write')
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: '`version` จาก GET (ยังไม่เคยตั้ง = "0") — ไม่ตรง → 412 · ไม่ส่ง = เขียนทับ',
  })
  @ApiOkResponse({
    type: CarrierErpCodeDto,
    description:
      'ตั้ง/ยกเลิก (null) รหัสรถร่วมในระบบบัญชีของ connector 1 ตัว (คนกรอก — ระบบไม่เดา) · เปลี่ยน/ยกเลิกรหัสที่ตั้งไว้แล้วต้องมี `reason` (422) · ' +
      'รหัสผูกกับรถร่วมอื่น → 409 `external_id_conflict` · connector ยกเลิกแล้ว → 409 `invalid_state_transition` · audit `external_mapping.changed` · ' +
      'คำสั่งส่งใบสำคัญจ่ายที่ยังไม่ส่ง/ส่งใหม่ ใช้รหัสล่าสุด ณ ตอนส่ง',
  })
  @ApiProblems(E409_ERP, E412_ERP, E422_ERP)
  async set(
    @Param('id') id: string,
    @Param('connectorId') connectorId: string,
    @Body() body: SetCarrierErpCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CarrierErpCodeDto> {
    const r = dto(await this.svc.setForCarrier(id, connectorId, body, expectedVersion(req)));
    setEtag(res, r.version);
    return r;
  }
}

function dto(v: PartyErpCodeView): CarrierErpCodeDto {
  return {
    connector: {
      id: encodeId('connector', v.connector.id),
      adapterKey: v.connector.adapterKey,
      displayName: v.displayName,
      status: v.connector.status,
    },
    externalId: v.row?.externalId ?? null,
    status: v.row?.status ?? 'UNMAPPED',
    updatedAt: v.row?.updatedAt.toISOString() ?? null,
    version: v.row?.version ?? 0,
  };
}
