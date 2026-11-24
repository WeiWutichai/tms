import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiProblems } from '../../common/problem.dto';
import { T403, T422 } from '../trips/trip-problems';
import type { DoLineRequest, DoStatus } from '@tms/domain';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404, encodeId, tryDecodeId } from '../../common/ids';
import { toPage } from '../../common/pagination';
import { PROBLEMS, ProblemException } from '../../common/problem';
import { Clock } from '../../common/clock';
import { DbService } from '../../db/db.service';
import { bangkokToday, isRealDate } from '../vehicle-documents/expiry';
import {
  CancelDeliveryOrderDto,
  CreateDeliveryOrderDto,
  DeliveryOrderDto,
  DeliveryOrderListQuery,
  DeliveryOrderPageDto,
  DeliveryOrderSummaryDto,
  DeliveryOrderSplitResultDto,
  MergeDeliveryOrdersDto,
  RedeliverDeliveryOrderDto,
  RedeliverResultDto,
  ReturnDeliveryOrderDto,
  RevertDeliveryDto,
  SplitDeliveryOrderDto,
  type DeliveryOrderLineQtyDto,
} from './delivery-order.dto';
import { OrderStateService } from '../orders/order-state.service';
import { DeliveryOrderReturnService } from './delivery-order-return.service';
import { DeliveryOrderRevertService } from './delivery-order-revert.service';
import {
  DeliveryOrderService,
  type DeliveryOrderRecord,
  type RejectionLine,
} from './delivery-order.service';
import { toDeliveryOrderDto } from './do-dto';

export { toDeliveryOrderDto };

/**
 * ใบส่งของ (ST3-T09; docs/01 §5.2 #4 `delivery-orders`, D-26) — list/get + สร้างจาก SO + แยก/รวม/ยกเลิก
 * (`/split`, `/merge` ไม่อยู่ในรายการ docs §5.2 — บันทึก spec/12 §3) · PATCH/redeliver/tracking = งานถัดไป
 * สิทธิ์ (docs/04 A3): อ่าน `orders:read` · สร้าง/แยก/รวม `orders:write` (spec/03 §3.2 dispatcher) · ยกเลิก `orders:cancel`
 * ไม่มีราคา/รายได้ใน payload (ST5) · บรรทัดอ้างบรรทัด SO ด้วยลำดับ `soLineNo`
 */
@ApiTags('delivery-orders')
@ApiBearerAuth()
@Controller('delivery-orders')
export class DeliveryOrdersController {
  constructor(
    private readonly dos: DeliveryOrderService,
    private readonly db: DbService,
    private readonly returns: DeliveryOrderReturnService,
    private readonly orderState: OrderStateService,
    private readonly clock: Clock,
  ) {}

  /** DTO พร้อมยอดปฏิเสธรับ (ST4-T11) */
  private async dtos(rows: DeliveryOrderRecord[]): Promise<DeliveryOrderDto[]> {
    const bal = await this.dos.rejectionBalance(this.db.tx, rows);
    return rows.map((d) => toDeliveryOrderDto(d, bal.get(d.id)));
  }

  /** ST9-T01 ตัวนับของ dashboard ปฏิบัติการ (งานวันนี้ / ส่งแล้ว / ส่งไม่สำเร็จ) — ตัวกรองเดียวกับรายการ */
  @Get('summary')
  @RequireScope('orders:read')
  @ApiOperation({
    summary: 'ตัวนับ DO ของวันนี้ (เวลาไทย)',
    description:
      'นับด้วยตัวกรองชุดเดียวกับ `GET /delivery-orders` ของวัน `date` (dateFrom = dateTo = date) — ตัวเลขเท่ากับจำนวนแถวของรายการเมื่อใช้ตัวกรองตามคำอธิบายของแต่ละช่อง · ช่องที่เหลือ (`draft` / `inTransit` / `unbilled` / …) นับทุกวันที่',
  })
  @ApiOkResponse({ type: DeliveryOrderSummaryDto })
  summary(): Promise<DeliveryOrderSummaryDto> {
    return this.dos.summary(bangkokToday(this.clock.now()));
  }

  @Get()
  @RequireScope('orders:read')
  @ApiOkResponse({ type: DeliveryOrderPageDto })
  async list(@Query() q: DeliveryOrderListQuery) {
    // รูปแบบผ่าน DTO แล้ว — วันที่ต้องมีจริง (2026-02-31 / 2026-13-45 → 422 ไม่ปัดเป็นเดือนถัดไป)
    const badDates = (['dateFrom', 'dateTo'] as const).flatMap((f) =>
      q[f] !== undefined && !isRealDate(q[f]!)
        ? [{ field: f, code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' }]
        : [],
    );
    if (badDates.length) throw new ProblemException('validation_failed', undefined, badDates);
    const decode = (kind: 'salesOrder' | 'customer', v?: string) =>
      v === undefined
        ? undefined
        : (tryDecodeId(kind, v) ?? '00000000-0000-0000-0000-000000000000');
    const { rows, limit, sort } = await this.dos.list({
      ...q,
      salesOrderId: decode('salesOrder', q.orderId),
      customerId: decode('customer', q.customerId),
      statuses: q.status ? (q.status.split(',') as DoStatus[]) : undefined,
    });
    const bal = await this.dos.rejectionBalance(this.db.tx, rows);
    return toPage(rows, { limit, sort }, (d) => toDeliveryOrderDto(d, bal.get(d.id)), q.fields);
  }

  @Get(':id')
  @TenantResource('deliveryOrder')
  @RequireScope('orders:read')
  @ApiOkResponse({ type: DeliveryOrderDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const d = await this.dos.get(decodeIdOr404('deliveryOrder', id));
    setEtag(res, d.version);
    return (await this.dtos([d]))[0]!;
  }

  /** สร้าง DO จาก SO (ปริมาณคงเหลือทั้งหมด หรือบางส่วน/ต่อจุดส่ง) — ห้ามเกินที่สั่ง (422 `over_allocated`) */
  @Post()
  @RequireScope('orders:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: DeliveryOrderDto })
  async create(
    @Body() body: CreateDeliveryOrderDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const soId = tryDecodeId('salesOrder', body.orderId);
    const lines = soId
      ? await this.db.tx.salesOrderLine.findMany({
          where: { salesOrderId: soId },
          select: { id: true, lineNo: true },
        })
      : [];
    const so = soId
      ? await this.db.tx.salesOrder.findUnique({ where: { id: soId }, select: { id: true } })
      : null;
    if (!so)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'orderId', code: 'invalid_reference', message: 'order not found' },
      ]);
    const d = await this.dos.createFromOrder(so.id, {
      destStopSeq: body.destStopSeq,
      originStopSeq: body.originStopSeq,
      lines: body.lines ? mapLines(body.lines, lines, 'lines') : undefined,
    });
    setEtag(res, d.version);
    return toDeliveryOrderDto(d);
  }

  /** แยก DO (ORD-084): ใบนี้ CANCELLED → ใบลูก `{เลข}-{n}` ปริมาณรวมต่อบรรทัดเท่าเดิม */
  @Post(':id/split')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: DeliveryOrderSplitResultDto })
  async split(
    @Param('id') id: string,
    @Body() body: SplitDeliveryOrderDto,
    @Req() req: Request,
  ): Promise<DeliveryOrderSplitResultDto> {
    const d = await this.dos.get(decodeIdOr404('deliveryOrder', id));
    const known = d.lines.flatMap((l) =>
      l.salesOrderLineId ? [{ id: l.salesOrderLineId, lineNo: l.soLineNo }] : [],
    );
    const parts = body.parts.map((p, i) => mapLines(p.lines, known, `parts[${i}].lines`));
    const kids = await this.dos.split(d.id, parts, undefined, expectedVersion(req));
    return { data: kids.map((k) => toDeliveryOrderDto(k)) };
  }

  /** รวม DO อื่นของ SO + จุดส่งเดียวกันเข้าใบนี้ (ORD-086) — ใบที่ถูกรวม CANCELLED */
  @Post(':id/merge')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag ของใบนี้ — ไม่ตรง → 412' })
  @ApiOkResponse({ type: DeliveryOrderDto })
  async merge(
    @Param('id') id: string,
    @Body() body: MergeDeliveryOrdersDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const target = await this.dos.get(decodeIdOr404('deliveryOrder', id));
    const others = body.deliveryOrderIds.map((x) => decodeIdOr404('deliveryOrder', x));
    const d = await this.dos.merge([target.id, ...others], undefined, expectedVersion(req));
    setEtag(res, d.version);
    return toDeliveryOrderDto(d);
  }

  /** ยกเลิก DO (DRAFT ที่ไม่อยู่ในเที่ยว) — เหตุผล ≥ 10 ตัวอักษร + audit */
  @Post(':id/cancel')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:cancel')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: DeliveryOrderDto })
  async cancel(
    @Param('id') id: string,
    @Body() body: CancelDeliveryOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const current = await this.dos.get(decodeIdOr404('deliveryOrder', id));
    let reasonCodeId: string | null = null;
    if (body.reasonCodeId) {
      reasonCodeId = tryDecodeId('reasonCode', body.reasonCodeId);
      if (!reasonCodeId)
        throw new ProblemException('validation_failed', undefined, [
          { field: 'reasonCodeId', code: 'invalid_reference', message: 'reason code not found' },
        ]);
    }
    const d = await this.dos.cancel(
      current.id,
      { note: body.reason, reasonCodeId },
      undefined,
      expectedVersion(req),
    );
    // ST4-T11: ยกเลิกใบส่งซ้ำของที่ถูกปฏิเสธรับ → ใบสั่งที่เหลือแต่ใบส่งแล้วกลับเป็นส่งครบ (ไล่สถานะตาม DO — ไม่มีผลกับ SO รอจัด)
    await this.orderState.syncFromDeliveryOrders(this.db.tx, [d.salesOrderId]);
    setEtag(res, d.version);
    return toDeliveryOrderDto(d);
  }

  /**
   * ST4-T11 ส่งซ้ำ (docs/01 §5.2 `/redeliver`; docs/04 E2 ตีกลับบางส่วน/ทั้งหมด) [DECISION spec/12 §3]:
   * DO ส่งแล้วที่มีปฏิเสธรับ → ใบเดิมคงสถานะ + DO ใหม่เฉพาะปริมาณที่ปฏิเสธ (ไม่เกินคงเหลือ) ·
   * DO ส่งไม่สำเร็จ → ใบเดิม CANCELLED + DO ใหม่ทั้งใบ · DO ใหม่ DRAFT นอกเที่ยว (รอจัดรถ) · เหตุผล + audit
   */
  @Post(':id/redeliver')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag ของใบเดิม — ไม่ตรง → 412' })
  @ApiOkResponse({ type: RedeliverResultDto })
  async redeliver(
    @Param('id') id: string,
    @Body() body: RedeliverDeliveryOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RedeliverResultDto> {
    const r = await this.returns.redeliver(
      decodeIdOr404('deliveryOrder', id),
      body,
      guardedVersion(req, body),
    );
    setEtag(res, r.source.version);
    const [source, redelivery] = await this.dtos([r.source, r.redelivery]);
    return { source: source!, redelivery: redelivery! };
  }

  /**
   * ST4-T11 คืนคลัง: DO ส่งแล้วที่มีปฏิเสธรับ → บันทึกปริมาณคืนคลังต่อบรรทัด (ใบเดิมคงสถานะ) ·
   * DO ส่งไม่สำเร็จ → RETURNED (docs/01 §4.3) · เหตุผล + audit
   */
  @Post(':id/return')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: DeliveryOrderDto })
  async return(
    @Param('id') id: string,
    @Body() body: ReturnDeliveryOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const d = await this.returns.return(
      decodeIdOr404('deliveryOrder', id),
      body,
      guardedVersion(req, body),
    );
    setEtag(res, d.version);
    return (await this.dtos([d]))[0]!;
  }
}

/** 409 ของ lifecycle วางบิล (ST5-T06) */
const REVERT_409 = {
  status: 409,
  description:
    '`invalid_state_transition` — `errors[].code`: not_delivered · do_released (ส่งบัญชีแล้ว — ย้อนการส่งบัญชีก่อน) · ' +
    'do_in_invoice (อยู่ในร่าง/ใบที่ออกแล้ว) · do_credited · has_followups (ส่งซ้ำ/คืนคลังของที่ปฏิเสธรับแล้ว) · order_closed · ' +
    'trip_costed (เที่ยวปิดต้นทุนแล้ว)',
  examples: {
    do_released: {
      type: 'https://docs.tms.example/problems/invalid_state_transition',
      title: PROBLEMS.invalid_state_transition.th,
      status: 409,
      code: 'invalid_state_transition',
      instance: '/v1/delivery-orders/do_3f2a…/revert-delivery',
      requestId: 'b6a1c2d3-…',
      errors: [
        {
          field: 'deliveryOrderId',
          code: 'do_released',
          message: 'delivery order was released to billing',
        },
      ],
      billingStatus: 'UNBILLED',
      releasedAt: '2026-11-20T03:15:00.000Z',
    },
  },
};

/**
 * ST5-T06 ย้อนผลส่งถึง (docs/04 F4) — แยก controller เพื่อเอกสาร problem ของ lifecycle วางบิล
 */
@ApiTags('delivery-orders')
@ApiBearerAuth()
@Controller('delivery-orders')
export class DeliveryOrderRevertController {
  constructor(private readonly reverts: DeliveryOrderRevertService) {}

  @Post(':id/revert-delivery')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('trips:close')
  @ApiOperation({
    summary: 'ย้อนผลส่งถึง (DELIVERED → ส่งไม่สำเร็จ)',
    description:
      'docs/04 F4: ผู้จัดรถ (`trips:close`) ย้อนได้ภายใน 24 ชม. นับจากเวลาที่ใบส่งของเป็นส่งถึง — เกินต้องมี `deliveries:revert` (owner/admin) ' +
      '(ไม่งั้น 403 `permission_denied` + `reason: revert_window_expired`, `deliveredAt`, `revertDeadline`) · ' +
      'ใบส่งของต้องส่งถึง (DELIVERED/POD_PENDING/UNBILLED) ยังไม่ส่งบัญชี ไม่อยู่ในใบแจ้งหนี้ และยังไม่มีส่งซ้ำ/คืนคลังของที่ปฏิเสธรับ ' +
      '→ สถานะเป็น FAILED + เหตุผล + audit `delivery_order.delivery_reverted` แล้วจัดการต่อด้วย `/redeliver` หรือ `/return`',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiProblems(T403('trips:close'), T422, REVERT_409)
  @ApiOkResponse({ type: DeliveryOrderDto })
  async revertDelivery(
    @Param('id') id: string,
    @Body() body: RevertDeliveryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const d = await this.reverts.revertDelivery(
      decodeIdOr404('deliveryOrder', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, d.version);
    return toDeliveryOrderDto(d);
  }
}

/**
 * ST4-T11 (review M): ระบุปริมาณบางส่วน (`lines`) ต้องส่ง If-Match หรือ Idempotency-Key — ไม่งั้นคำขอที่ลองใหม่สร้างใบส่งซ้ำ/คืนคลังซ้ำได้
 * (ไม่ส่ง `lines` = ทั้งหมดที่คงเหลือ → ครั้งที่สองได้ 422 `nothing_open` อยู่แล้ว)
 */
function guardedVersion(req: Request, body: { lines?: unknown[] }): number | undefined {
  const v = expectedVersion(req);
  if (body.lines?.length && v === undefined && !req.header('idempotency-key'))
    throw new ProblemException('validation_failed', undefined, [
      {
        field: 'If-Match',
        code: 'if_match_required',
        message:
          'send If-Match (or Idempotency-Key) when redelivering/returning part of the quantity',
      },
    ]);
  return v;
}

/** soLineNo → id ของบรรทัด SO (ไม่รู้จัก → 422 รวมทุกช่อง) */
function mapLines(
  input: DeliveryOrderLineQtyDto[],
  known: { id: string; lineNo: number }[],
  field: string,
): DoLineRequest[] {
  const byNo = new Map(known.map((l) => [l.lineNo, l.id]));
  const bad = input.flatMap((l, i) =>
    byNo.has(l.soLineNo)
      ? []
      : [{ field: `${field}[${i}].soLineNo`, code: 'unknown_line', message: 'line not found' }],
  );
  if (bad.length) throw new ProblemException('validation_failed', undefined, bad);
  return input.map((l) => ({ salesOrderLineId: byNo.get(l.soLineNo)!, qty: l.qty, unit: l.unit }));
}
