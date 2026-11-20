import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RateLimitClass, RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404, tryDecodeId } from '../../common/ids';
import { PROBLEMS, ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { DeliveryOrderDto } from '../delivery-orders/delivery-order.dto';
import { toDeliveryOrderDto } from '../delivery-orders/do-dto';
import { T403, T422 } from '../trips/trip-problems';
import { isRealDate } from '../vehicle-documents/expiry';
import {
  BillingQueuePageDto,
  BillingQueueQuery,
  BulkReleaseDeliveryOrdersDto,
  BulkReleaseResultsDto,
  ReleaseDeliveryOrderDto,
  UnreleaseDeliveryOrderDto,
} from './billing-queue.dto';
import { BillingQueueService } from './billing-queue.service';
import { BillingReleaseService } from './billing-release.service';

const NOT_READY = {
  status: 409,
  description:
    '`not_ready_to_bill` — DO ยังไม่พร้อมวางบิล: `reasons[]` (NOT_DELIVERED · BILLING_HOLD · PRICING_UNAVAILABLE · NO_REVENUE · ' +
    'REVENUE_PROVISIONAL · REVENUE_LOCKED · SURCHARGE_PENDING · STOP_TIMES_MISSING · POD_INCOMPLETE · IN_INVOICE) + `missing[]` เมื่อหลักฐานไม่ครบ',
  examples: {
    not_ready_to_bill: {
      type: 'https://docs.tms.example/problems/not_ready_to_bill',
      title: PROBLEMS.not_ready_to_bill.th,
      status: 409,
      code: 'not_ready_to_bill',
      instance: '/v1/delivery-orders/do_3f2a…/release',
      requestId: 'b6a1c2d3-…',
      reasons: ['POD_INCOMPLETE'],
      missing: [{ key: 'photo', type: 'PHOTO', code: 'min_count', expected: 1, actual: 0 }],
    },
  },
};

/** ST5-T06 ใบส่งของอยู่ในใบแจ้งหนี้ (ร่าง/ออกเลขแล้ว) — ย้อนการส่งบัญชีไม่ได้ */
const IN_INVOICE_409 = {
  status: 409,
  description:
    '`invalid_state_transition` + `errors[].code = do_in_invoice` + `billingStatus` (IN_DRAFT ถอดออกจากร่างก่อน · INVOICED ย้อนไม่ได้)',
  examples: {
    do_in_invoice: {
      type: 'https://docs.tms.example/problems/invalid_state_transition',
      title: PROBLEMS.invalid_state_transition.th,
      status: 409,
      code: 'invalid_state_transition',
      instance: '/v1/delivery-orders/do_3f2a…/unrelease',
      requestId: 'b6a1c2d3-…',
      errors: [
        { field: 'deliveryOrderId', code: 'do_in_invoice', message: 'delivery order is INVOICED' },
      ],
      billingStatus: 'INVOICED',
      doStatus: 'BILLED',
    },
  },
};

/**
 * วางบิล (AR — docs/04 F3, docs/01 §5.2 #8 `invoices`)
 * ST5-T04: คิวพร้อมวางบิล — ร่าง/ออกใบ = ST5-T07/T09
 */
@ApiTags('invoices')
@ApiBearerAuth()
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly queue: BillingQueueService) {}

  // ST5-T07 ต้องประกาศ queue ก่อน :id และเพิ่ม test ตรวจลำดับ route
  @Get('queue')
  @RequireScope('invoices:read')
  @ApiOperation({
    summary: 'คิวพร้อมวางบิล (DO ที่ส่งแล้ว หลักฐานครบ และราคาพร้อม)',
    description:
      'DO ที่ส่งถึงแล้ว (DELIVERED/POD_PENDING/UNBILLED) ที่ใบสั่ง `pricingStatus = AVAILABLE` และมีบรรทัดรายได้ที่ยืนยันแล้ว ' +
      '(ไม่มีบรรทัดยอดชั่วคราว/ล็อก ไม่มีค่าใช้จ่ายหน้างานฝั่งขายรอยืนยัน) และไม่ถูกระงับวางบิล · ' +
      'ลูกค้าที่เปิด "ไม่มี POD ไม่วางบิล" (`requirePodToBill`, ค่าเริ่มต้นเปิด) → DO ที่หลักฐานส่งยังไม่ครบตาม checklist ไม่ขึ้นคิว · ' +
      'กรองลูกค้า (`customerId` รับ `ext:`) / ช่วงวันที่ส่ง (`doDate`) / หลักฐานครบ / ส่งบัญชีแล้ว · ' +
      '`customers` = ยอดรวมต่อลูกค้าของทุกแถวที่ตรงตัวกรอง · ยอดเงิน (`sell*`) เห็นเมื่อมี `prices.sell:read`',
  })
  @ApiProblems(T403('invoices:read'), T422)
  @ApiOkResponse({ type: BillingQueuePageDto })
  async list(@Query() q: BillingQueueQuery): Promise<BillingQueuePageDto> {
    const bad = (['dateFrom', 'dateTo'] as const).flatMap((f) =>
      q[f] !== undefined && !isRealDate(q[f]!)
        ? [{ field: f, code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' }]
        : [],
    );
    if (q.dateFrom && q.dateTo && !bad.length && q.dateFrom > q.dateTo)
      bad.push({ field: 'dateTo', code: 'before_date_from', message: 'dateTo must be ≥ dateFrom' });
    if (bad.length) throw new ProblemException('validation_failed', undefined, bad);
    return this.queue.list(q);
  }
}

/**
 * ขั้นส่งบัญชี (RELEASED — ST5-T04; docs/04 F3/F4) ของใบส่งของ — สิทธิ์ `invoices:draft` (A3: owner/admin/invoicer/accounting)
 */
@ApiTags('delivery-orders')
@ApiBearerAuth()
@Controller('delivery-orders')
export class DeliveryOrderReleaseController {
  constructor(private readonly release: BillingReleaseService) {}

  @Post(':id/release')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ส่งบัญชี (RELEASED) — ใบส่งของพร้อมวางบิล',
    description:
      'ตรวจเงื่อนไขชุดเดียวกับคิวพร้อมวางบิล + จุดส่งมีเวลาถึง/ออกครบ + (ลูกค้าเปิด "ไม่มี POD ไม่วางบิล") หลักฐานล่าสุดผ่าน checklist **ปัจจุบัน** ' +
      'ของลูกค้า → บันทึกเวลา/ผู้ส่งบัญชี + audit `delivery_order.released` · สถานะ DO ไม่เปลี่ยน · ส่งแล้ว = ตอบ DO เดิม (ไม่ทำซ้ำ)',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiProblems(T403('invoices:draft'), T422, NOT_READY)
  @ApiOkResponse({ type: DeliveryOrderDto })
  async releaseOne(
    @Param('id') id: string,
    @Body() body: ReleaseDeliveryOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const r = await this.release.release(decodeIdOr404('deliveryOrder', id), {
      version: expectedVersion(req),
      note: body.note ?? null,
    });
    setEtag(res, r.d.version);
    return toDeliveryOrderDto(r.d);
  }

  @Post(':id/unrelease')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ย้อนการส่งบัญชี (RELEASED → DELIVERED)',
    description:
      'docs/04 F4 "RELEASED ย้อนได้โดย Invoicer": ล้างเวลา/ผู้ส่งบัญชี + audit `delivery_order.unreleased` (เหตุผลบังคับ) · ' +
      'หลังย้อนแก้จุดแวะ/ยอดส่งจริงได้อีก (ล็อกหลังส่งบัญชี — 409 `do_released`) · ใบส่งของในร่างใบแจ้งหนี้ → 409 `do_in_invoice` ' +
      '(ถอดออกจากร่างก่อน) · ออกใบแล้ว (INVOICED) ย้อนไม่ได้ — ใช้ใบลดหนี้ · ยังไม่ส่งบัญชี = ตอบใบเดิม (ไม่ทำซ้ำ)',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiProblems(T403('invoices:draft'), T422, IN_INVOICE_409)
  @ApiOkResponse({ type: DeliveryOrderDto })
  async unrelease(
    @Param('id') id: string,
    @Body() body: UnreleaseDeliveryOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const d = await this.release.unrelease(decodeIdOr404('deliveryOrder', id), {
      version: expectedVersion(req),
      reason: body.reason,
    });
    setEtag(res, d.version);
    return toDeliveryOrderDto(d);
  }

  @Post('bulk-release')
  @RateLimitClass('heavy')
  @HttpCode(207)
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ส่งบัญชีหลายใบส่งของ',
    description:
      '≤ 100 รายการ ทำทีละรายการแยกกัน (สำเร็จบางรายการได้) · เงื่อนไขเหมือน `POST /delivery-orders/{id}/release` · ' +
      'ตอบ 207 เสมอเมื่อคำขอถูกต้อง — ดู `results[].outcome` / `problem`',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiProblems(T403('invoices:draft'), T422)
  @ApiResponse({ status: 207, type: BulkReleaseResultsDto, description: 'ผลต่อรายการ' })
  async bulkRelease(@Body() body: BulkReleaseDeliveryOrdersDto): Promise<BulkReleaseResultsDto> {
    const ids = body.items.map((i) => i.deliveryOrderId);
    const dup = ids.flatMap((x, i) =>
      ids.indexOf(x) !== i
        ? [{ field: `items[${i}].deliveryOrderId`, code: 'duplicate', message: 'listed twice' }]
        : [],
    );
    if (dup.length) throw new ProblemException('validation_failed', undefined, dup);
    const out = await this.release.bulkRelease(
      body.items.map((i) => ({
        id: tryDecodeId('deliveryOrder', i.deliveryOrderId),
        version: i.version,
      })),
      body.note ?? null,
    );
    const results = out.map((r, i) => {
      const deliveryOrderId = body.items[i]!.deliveryOrderId;
      if ('ok' in r)
        return {
          deliveryOrderId,
          doNo: r.ok.d.doNo,
          status: 200,
          outcome: r.ok.outcome,
          deliveryOrder: toDeliveryOrderDto(r.ok.d),
          problem: null,
        };
      const problem = problemOf(r.error);
      return {
        deliveryOrderId,
        doNo: null,
        status: problem.status,
        outcome: 'FAILED' as const,
        deliveryOrder: null,
        problem,
      };
    });
    const n = (o: string) => results.filter((r) => r.outcome === o).length;
    return { results, succeeded: n('RELEASED'), unchanged: n('UNCHANGED'), failed: n('FAILED') };
  }
}

/** problem body ของรายการใน bulk (รูปเดียวกับ ProblemFilter — ไม่มี instance/requestId ต่อรายการ) */
function problemOf(p: ProblemException) {
  const locale = requestContext.get()?.locale ?? 'th';
  const def = PROBLEMS[p.code];
  return {
    type: `https://docs.tms.example/problems/${p.code}`,
    title: def[locale],
    status: def.status as number,
    code: p.code as string,
    ...(p.detail ? { detail: p.detail } : {}),
    ...(p.errors?.length ? { errors: p.errors } : {}),
    ...((p.extra ?? {}) as Record<string, unknown>),
  };
}
