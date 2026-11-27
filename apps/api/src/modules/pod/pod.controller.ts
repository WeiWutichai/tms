import { Body, Controller, Get, Param, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PodSource } from '@tms/domain';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource, AllowReadOnlyTenant } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { PROBLEMS, type ProblemCode } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { stopEventSourceOf } from '../stops/stop-events.service';
import { DeliveryOrderPodDto, SubmitPodDto } from './pod.dto';
import { PodService } from './pod.service';

const P = (code: ProblemCode, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  instance: '/v1/delivery-orders/do_3f2a…/pod',
  requestId: 'b6a1c2d3-…',
  ...extra,
});
const R403 = {
  status: 403,
  description: 'ไม่มีสิทธิ์ (`trips:read`)',
  examples: {
    permission_denied: P('permission_denied', {
      module: 'trips',
      action: 'read',
      required: ['trips:read'],
    }),
  },
};
const W403 = {
  status: 403,
  description: 'ไม่มีสิทธิ์ (`trips:dispatch`)',
  examples: {
    permission_denied: P('permission_denied', {
      module: 'trips',
      action: 'dispatch',
      required: ['trips:dispatch'],
    }),
  },
};
const N404 = {
  status: 404,
  description: 'ไม่พบใบส่งของ (รวมของบริษัทอื่น)',
  examples: { not_found: P('not_found') },
};
const W409 = {
  status: 409,
  description: 'DO ยังไม่ส่ง / วางบิลแล้ว / ยกเลิก (`doStatus`) — หรือชนกับการแก้ไขพร้อมกัน',
  examples: {
    pod_not_allowed: P('pod_not_allowed', { doStatus: 'BILLED' }),
    concurrent_update: P('concurrent_update'),
  },
};
const W412 = {
  status: 412,
  description: 'If-Match ไม่ตรงกับเลขฉบับปัจจุบัน (`currentVersion`) — โหลดใหม่แล้วบันทึกอีกครั้ง',
  examples: { precondition_failed: P('precondition_failed', { currentVersion: 2 }) },
};
const W422 = {
  status: 422,
  description:
    'ข้อมูลไม่ถูกต้อง — ไฟล์ไม่ใช่ของหลักฐานส่ง/ยังอัปโหลดไม่เสร็จ/ผูกกับเอกสารหรือ DO อื่นแล้ว (`document_in_use`), ค่าผิดรูปแบบ (PIN ไม่ครบหลัก ตัวเลือกไม่อยู่ในรายการ คะแนนเกิน), key ไม่อยู่ใน checklist, แก้ฉบับเดิมโดยไม่มีเหตุผล · **หลักฐานที่ยังไม่ครบไม่ถูกปฏิเสธ** (บันทึกเป็น PARTIAL) ยกเว้น DO ที่รอวางบิลแล้ว (UNBILLED) → `pod_incomplete` + `missing[]`',
  examples: {
    validation_failed: P('validation_failed', {
      errors: [
        {
          field: 'photoDocumentIds.0',
          code: 'not_ready',
          message: 'document upload is not complete',
        },
        { field: 'pin', code: 'invalid', message: 'PIN value is not valid' },
        {
          field: 'photoDocumentIds.1',
          code: 'document_in_use',
          message: 'document belongs to another record',
        },
        {
          field: 'reason',
          code: 'required',
          message: 'reason (≥ 10 chars) is required to amend an existing proof of delivery',
        },
      ],
    }),
    pod_incomplete: P('pod_incomplete', {
      doStatus: 'UNBILLED',
      errors: [
        { field: 'signatureDocumentId', code: 'required', message: 'SIGNATURE is required' },
      ],
      missing: [{ key: 'signature', type: 'SIGNATURE', code: 'required' }],
    }),
  },
};

/**
 * หลักฐานส่ง (ePOD) ต่อใบส่งของ (ST4-T07; docs/04 E2 "ePOD ผ่านเว็บ", docs/01 §4.3 DELIVERED → POD_PENDING / UNBILLED)
 * สิทธิ์: อ่าน `trips:read` · บันทึก `trips:dispatch` (บันทึกแทนคนขับเหมือนสถานะจุด ST4-T04)
 * ลิงก์รถร่วม (ST4-T09) / แอปคนขับ ใช้ `PodService.submit` เดียวกัน (source LINK / APP)
 */
@ApiTags('delivery-orders')
@ApiBearerAuth()
@Controller('delivery-orders')
export class PodController {
  constructor(private readonly pods: PodService) {}

  @Get(':id/pod')
  @ApiOperation({
    summary: 'หลักฐานส่งของ DO (ฉบับปัจจุบัน + ประวัติ + checklist + สิ่งที่ขาด)',
    description:
      'ETag = เลขฉบับปัจจุบัน (ยังไม่มี = "0") ใช้เป็น If-Match ตอน PUT · `missing[]` เทียบกับ checklist ของลูกค้า **ตอนนี้** (`podStatus` ของ DO คำนวณตอนบันทึก/ตอนส่งถึง)',
  })
  @ApiProblems(R403, N404)
  @TenantResource('deliveryOrder')
  @RequireScope('trips:read')
  @ApiOkResponse({ type: DeliveryOrderPodDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderPodDto> {
    const v = await this.pods.view(decodeIdOr404('deliveryOrder', id));
    setEtag(res, v.versions[0]?.version ?? 0);
    return v;
  }

  @AllowReadOnlyTenant() // P1-ST1-T03 ตาราง 1.6
  @Put(':id/pod')
  @ApiOperation({
    summary: 'บันทึก/แก้หลักฐานส่ง (ฉบับใหม่ทุกครั้ง)',
    description:
      'ส่งทั้งฉบับ (ชื่อช่องตาม docs/01 §5.3) → ฉบับใหม่ (version + 1) · แก้ฉบับเดิมต้องมี `reason` ≥ 10 ตัวอักษร (audit `pod.amended`) · ' +
      'คำนวณ `pod_status` กับ checklist ของลูกค้า (DO ส่งไม่สำเร็จใช้ชุดไม่สำเร็จ): ครบ = COMPLETE, ไม่ครบ = PARTIAL (ไม่ปฏิเสธ) · ' +
      'DO DELIVERED → UNBILLED (ครบ) / POD_PENDING (ไม่ครบ), POD_PENDING → UNBILLED เมื่อครบ — DO ที่ UNBILLED แล้วแก้จนไม่ครบ → 422 `pod_incomplete` (ด่านวางบิล) · ไฟล์ที่ใช้ถูกผูกกับ DO นี้ (`stored_document.entity_type/entity_id`) ใช้กับ DO อื่นไม่ได้ · ' +
      'domain_event `pod.captured` · บันทึกได้เมื่อ DO ส่งแล้ว/ส่งไม่สำเร็จ ยังไม่วางบิล',
  })
  @ApiProblems(W403, N404, W409, W412, W422)
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: 'ETag จาก GET (เลขฉบับ — ยังไม่มี = "0") · ไม่ตรง → 412',
  })
  @TenantResource('deliveryOrder')
  @RequireScope('trips:dispatch')
  @ApiOkResponse({ type: DeliveryOrderPodDto })
  async put(
    @Param('id') id: string,
    @Body() body: SubmitPodDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderPodDto> {
    const v = await this.pods.submit(decodeIdOr404('deliveryOrder', id), body, {
      source: stopEventSourceOf(requestContext.require().principalType) as PodSource,
      expectedVersion: expectedVersion(req),
    });
    setEtag(res, v.versions[0]?.version ?? 0);
    return v;
  }
}
